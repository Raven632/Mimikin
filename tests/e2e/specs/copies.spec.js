import { test, expect, openLibrary, openGame, menu } from '../fixtures.js';

// Новая версия вместо второй карточки и две копии в ревизии. Сравнение имени — настоящий сервер, а сама загрузка и склейка
// подменены: правила и сейвы проверяют тесты API (server.test.js, http.test.js)
const GAME = "Wanderer's Almanac";
const file = (name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(`${name} bytes`) });

// Загрузка «проходит» сразу; запоминаем, что и с какой целью начали
async function fakeUploads(page) {
  const started = [];
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const { name, size, target } = route.request().postDataJSON();
    started.push({ name, target: target || '' });
    return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ json: { id, state: 'done', folder: id, copy: true, received: 1, size: 1 } });
  });
  await page.route(/\/api\/games\/upload\/(list|trace)/, (route) => route.fulfill({ json: [] }));
  return started;
}

test.describe('новая версия при загрузке', () => {
  test('похожий архив спрашивает про свой файл: «Заменить» — с целью, «Добавить отдельной игрой» — без, отмена — не грузим; прочие идут сразу', async ({ page }) => {
    const started = await fakeUploads(page);
    await openLibrary(page);
    await page.locator('.controls-zone input[type=file]').setInputFiles([
      file('Wanderers_Almanac_v2.0.zip'), file('Fresh_Thing.zip'), file('Wanderers_Almanac_2.zip'), file('Wanderers_Almanac_v3.0.zip'), file('Wanderers_Almanac_v4.0.zip'),
    ]);

    // Другая часть серии и незнакомый архив не ждут ответа
    await expect.poll(() => started.map((s) => s.name)).toEqual(['Fresh_Thing.zip', 'Wanderers_Almanac_2.zip']);
    expect(started.every((s) => !s.target)).toBe(true);

    const box = page.locator('.confirm-box');
    await expect(box.locator('.confirm-title')).toHaveText(`Похоже, это новая версия «${GAME}». Заменить? Сейвы останутся.`);
    await expect(box.locator('.confirm-name')).toHaveText('Wanderers_Almanac_v2.0.zip');
    await expect(page.locator('.confirm-cancel')).toBeFocused();
    await box.locator('.confirm-ok', { hasText: 'Заменить' }).click();
    await expect.poll(() => started.at(-1)).toEqual({ name: 'Wanderers_Almanac_v2.0.zip', target: 'Wanderers_Almanac' });

    await expect(box.locator('.confirm-name')).toHaveText('Wanderers_Almanac_v3.0.zip');
    await box.locator('.confirm-other', { hasText: 'Добавить отдельной игрой' }).click();
    await expect.poll(() => started.at(-1)).toEqual({ name: 'Wanderers_Almanac_v3.0.zip', target: '' });

    await expect(box.locator('.confirm-name')).toHaveText('Wanderers_Almanac_v4.0.zip');
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(started.map((s) => s.name)).not.toContain('Wanderers_Almanac_v4.0.zip');
    // Сам сказал «отдельной» — «появилась вторая копия» ему не показываем
    await expect(page.locator('.toast.show', { hasText: 'Wanderers_Almanac_v3.0.zip' })).toHaveCount(0);
  });

  test('телефонная ширина: три ответа помещаются в окно', async ({ page }) => {
    await fakeUploads(page);
    await page.route('**/api/games/upload-match', (route) => route.fulfill({ json: { match: { id: 'X', title: GAME, cover: '', why: 'name' } } }));
    await openLibrary(page);
    await page.setViewportSize({ width: 360, height: 700 });
    await page.locator('.controls-zone input[type=file]').setInputFiles([file('Some.zip')]);
    const box = page.locator('.confirm-box');
    await expect(box.locator('.confirm-other')).toBeVisible();
    const inner = await box.boundingBox();
    for (const b of await box.locator('.confirm-actions button').all()) {
      const r = await b.boundingBox();
      expect(r.x).toBeGreaterThanOrEqual(inner.x);
      expect(r.x + r.width).toBeLessThanOrEqual(inner.x + inner.width);
    }
  });

  test('«Обновить игру» с целью не спрашивает: цель уже сказана', async ({ page }) => {
    const started = await fakeUploads(page);
    let asked = 0;
    await page.route('**/api/games/upload-match', (route) => { asked++; return route.continue(); });
    await openLibrary(page);
    await openGame(page, GAME);
    await page.locator('.modal-more-btn').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.modal-more-item', { hasText: 'Поставить новую версию' }).click();
    await (await chooser).setFiles([file('Wanderers_Almanac_v9.0.zip')]);
    await expect.poll(() => started).toEqual([{ name: 'Wanderers_Almanac_v9.0.zip', target: 'Wanderers_Almanac' }]);
    await expect(page.locator('.confirm-box')).toHaveCount(0);
    expect(asked).toBe(0);
  });
});

test.describe('две копии в ревизии', () => {
  const copy = (id, extra) => ({ id, title: 'Copper Bell', size: 0, playtime: 3600, shelved: false, saves: false, moments: false, ...extra });
  const planOf = (keep, drop, saves) => ({ keep, drop, playtime: 7200, carries: ['status', 'notes'], saves });

  // Ревизия с одной парой; она уходит, когда сервер ответил на склейку или «Не дубликат»
  async function audit(page, { saves = 'both', mergeStatus = () => 200 } = {}) {
    const calls = { merge: [], dismiss: [] };
    let pair = true;
    await page.route('**/api/games/audit', async (route) => {
      const json = await (await route.fetch()).json();
      const games = [{ id: 'Bell_v1', title: 'Copper Bell', size: 0 }, { id: 'Bell_v2', title: 'Copper Bell', size: 0 }];
      return route.fulfill({ json: { ...json, duplicates: pair ? [{ why: ['name'], games, pairs: [{ why: ['name'], games }] }] : [] } });
    });
    await page.route('**/api/games/duplicates/plan*', (route) => route.fulfill({ json: {
      copies: [copy('Bell_v1', { saves: true }), copy('Bell_v2', { saves: saves === 'both', moments: true })],
      plans: { Bell_v1: planOf('Bell_v1', 'Bell_v2', saves), Bell_v2: planOf('Bell_v2', 'Bell_v1', saves) },
    } }));
    await page.route('**/api/games/duplicates/merge', (route) => {
      const status = mergeStatus();
      calls.merge.push(route.request().postDataJSON());
      if (status === 200) pair = false;
      return route.fulfill({ status, json: status === 200 ? { success: true } : { error: 'x' } });
    });
    await page.route('**/api/games/duplicates/dismiss', (route) => {
      calls.dismiss.push(route.request().postDataJSON());
      pair = false;
      return route.fulfill({ json: { success: true } });
    });
    await openLibrary(page);
    await menu(page, 'Статистика');
    await page.locator('.library-tab', { hasText: 'Ревизия' }).click();
    await expect(page.locator('.audit-pair-actions')).toHaveCount(1);
    return calls;
  }

  test('сейвы у обеих: окно говорит это заранее, «Склеить» ждёт выбора; сбой оставляет окно и говорит, что ничего не изменилось', async ({ page }) => {
    const fails = [500];
    const calls = await audit(page, { mergeStatus: () => fails.shift() || 200 });
    await page.locator('.audit-pair-actions button', { hasText: 'Склеить' }).click();
    const box = page.locator('.merge-box');
    await expect(box.locator('.confirm-title')).toHaveText('Склеить две копии');
    await expect(box.locator('.confirm-ok')).toBeDisabled();
    await expect(box.locator('.merge-plan')).toHaveCount(0);

    await box.locator('[role=radio]', { hasText: 'Bell_v2' }).click();
    await expect(box.locator('[role=radio]', { hasText: 'Bell_v2' })).toHaveAttribute('aria-checked', 'true');
    await expect(box.locator('.merge-plan')).toContainText('Сейвы или моменты есть у обеих копий');
    await expect(box.locator('.merge-plan')).toContainText('Копия «Copper Bell» уйдёт в корзину вместе со своими сейвами, вернуть её можно в течение 30 дней.');
    await expect(box.locator('.merge-plan')).toContainText('Наигранное время сложится: 2 ч 0 мин.');
    await expect(box.locator('.merge-plan')).toContainText('статус, заметки');

    await box.locator('.confirm-ok').click();
    await expect(box.locator('[role=alert]')).toHaveText('Не получилось. Обе копии остались как были.');
    expect(calls.merge).toEqual([{ keep: 'Bell_v2', drop: 'Bell_v1' }]);

    await box.locator('.confirm-ok').click();
    await expect(box).toHaveCount(0);
    await expect(page.locator('.audit-retry-done')).toContainText('Склеено');
    await expect(page.locator('.audit-pair-actions')).toHaveCount(0);
  });

  test('сейвы только у другой: они переедут; Escape закрывает только окно склейки', async ({ page }) => {
    const calls = await audit(page, { saves: 'move' });
    await page.locator('.audit-pair-actions button', { hasText: 'Склеить' }).click();
    const box = page.locator('.merge-box');
    await box.locator('[role=radio]', { hasText: 'Bell_v2' }).click();
    await expect(box.locator('.merge-plan')).toContainText('Сейвы и моменты другой копии перейдут к оставшейся');
    await expect(box.locator('.merge-warn')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await expect(page.locator('.audit-pair-actions')).toHaveCount(1);
    expect(calls.merge).toEqual([]);
  });

  test('«Не дубликат»: пара уходит из списка', async ({ page }) => {
    const calls = await audit(page);
    await page.locator('.audit-pair-actions button', { hasText: 'Не дубликат' }).click();
    await expect(page.locator('.audit-pair-actions')).toHaveCount(0);
    expect(calls.dismiss).toEqual([{ a: 'Bell_v1', b: 'Bell_v2' }]);
  });
});
