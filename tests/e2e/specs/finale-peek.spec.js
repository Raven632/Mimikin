import { test, expect, openHome } from '../fixtures.js';

// Финал загрузки: «В библиотеке» держится, плашка уходит, и только потом игра встаёт на полку с рамкой.
// Проверяем порядок и конечное состояние, а не время кадров. Сервер подменён: загрузка «распаковывается»,
// пока тест не отпустит её, а список игр после этого получает ещё одну игру

const NEW_ID = 'Finale_Test_Game';

// Игра, которой нет в демо-библиотеке: копия первой, но самая новая в «Добавленных»
async function mockUpload(page) {
  const state = { done: false };
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const { name, size } = route.request().postDataJSON();
    return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ json: state.done ? { id, state: 'done', folder: NEW_ID, received: 1, size: 1 } : { id, state: 'processing', step: 'extract', received: 1, size: 1 } });
  });
  await page.route(/\/api\/games\/upload\/(list|trace)/, (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/games(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const list = await res.json();
    if (state.done) list.push({ ...list[0], id: NEW_ID, title: 'Finale Test Game', displayTitle: 'Finale Test Game', addedAt: Date.now(), lastPlayed: 0 });
    return route.fulfill({ response: res, json: list });
  });
  return state;
}

const upload = (page) => page.locator('.controls-zone input[type=file]')
  .setInputFiles([{ name: 'Finale.zip', mimeType: 'application/octet-stream', buffer: Buffer.from('bytes') }]);

test.describe('финал загрузки', () => {
  test('уменьшить движение: захлопнутый мимик, плашка уходит, потом игра на полке с золотой рамкой', async ({ page }) => {
    // Рамка живёт 600 мс — опросом её на нагруженной машине можно пропустить, поэтому снимаем в момент появления
    await page.addInitScript(() => {
      window.__landed = null;
      new MutationObserver(() => {
        const cover = document.querySelector('.shelf-card.landed .shelf-cover');
        if (cover && !window.__landed) {
          const s = getComputedStyle(cover, '::after');
          window.__landed = { opacity: s.opacity, color: s.borderTopColor, bar: document.querySelectorAll('.tb').length };
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    const state = await mockUpload(page);
    await openHome(page);
    await page.locator('.shelf-tab', { hasText: 'Добавленные' }).click();
    const fresh = page.locator(`.shelf-card[data-id="${NEW_ID}"]`);
    await upload(page);
    const bar = page.locator('.tb');
    // Распаковка: глаза открыты, мимик жуёт только при движении — здесь стоит открытым
    await expect(bar.locator('.tb-mimic.chew')).toBeVisible();
    await expect(bar.locator('.tb-mimic .f-half')).toHaveCSS('opacity', '0');
    state.done = true;
    // «В библиотеке»: крышка сразу захлопнута, проценты приглушены; игра на полку ещё не встала
    await expect(bar.locator('.tb-mimic.done')).toBeVisible();
    await expect(bar.locator('.tb-mimic .f-shut')).toHaveCSS('opacity', '1');
    await expect(bar.locator('.tb-mimic .f-open')).toHaveCSS('opacity', '0');
    await expect(bar.locator('.tb-pct')).toHaveClass(/dim/);
    await expect(fresh).toHaveCount(0);
    // Потом плашка исчезает, и в тот же момент игра встаёт; рамка стоит золотой, не гаснет сразу
    await expect.poll(() => page.evaluate(() => window.__landed)).toEqual({ opacity: '1', color: 'rgb(201, 168, 76)', bar: 0 });
    await expect(bar).toHaveCount(0);
    // Рамка снимается сама
    await expect(fresh).not.toHaveClass(/landed/);
  });

  test('с движением: плашка гаснет сама, потом соседи едут по transform, потом рамка', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Журнал с метками времени: что двигалось (Element.animate) и когда меняется страница. 200 мс класса leaving
    // опросом не поймать, поэтому смотрим на изменения DOM
    await page.addInitScript(() => {
      window.__log = [];
      const log = (what, extra) => window.__log.push({ what, at: performance.now(), ...extra });
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (frames, opts) {
        if (/shelf-card/.test(this.className)) log('shift', { frames: JSON.parse(JSON.stringify(frames)), duration: opts?.duration, easing: opts?.easing });
        return orig.call(this, frames, opts);
      };
      let leaving = false;
      let gone = false;
      let landed = false;
      new MutationObserver(() => {
        const tb = document.querySelector('.tb');
        if (tb?.classList.contains('leaving') && !leaving) { leaving = true; log('leaving'); }
        if (leaving && !tb && !gone) { gone = true; log('gone'); }
        if (document.querySelector('.shelf-card.landed') && !landed) { landed = true; log('landed'); }
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    const state = await mockUpload(page);
    await openHome(page);
    await page.locator('.shelf-tab', { hasText: 'Добавленные' }).click();
    await upload(page);
    const bar = page.locator('.tb');
    await expect(bar.locator('.tb-mimic.chew')).toBeVisible();
    state.done = true;
    await expect(bar.locator('.tb-mimic.done')).toBeVisible();
    const fresh = page.locator(`.shelf-card[data-id="${NEW_ID}"]`);
    await expect(fresh).toHaveClass(/landed/);
    await expect(bar).toHaveCount(0);
    const log = await page.evaluate(() => window.__log);
    const at = (what) => log.find((e) => e.what === what)?.at;
    // Сначала плашка гаснет 200 мс и уходит, и только потом соседи едут и встаёт новая обложка
    expect(at('leaving')).toBeDefined();
    expect(at('gone') - at('leaving')).toBeGreaterThanOrEqual(150);
    // (снятие плашки и сдвиг идут в одном кадре: наблюдатель DOM видит их в одной пачке, поэтому меряем от leaving)
    expect(at('shift') - at('leaving')).toBeGreaterThanOrEqual(150);
    expect(at('landed') - at('leaving')).toBeGreaterThanOrEqual(150);
    const shifts = log.filter((e) => e.what === 'shift');
    expect(shifts.length).toBeGreaterThan(0);
    for (const m of shifts) {
      expect(m.duration).toBe(200);
      expect(m.easing).toBe('cubic-bezier(.2, 0, 0, 1)');
      // Двигается только transform
      expect(Object.keys(m.frames[0]).filter((k) => !['offset', 'easing', 'composite'].includes(k))).toEqual(['transform']);
    }
    // Рамка новой обложки — три ступени, потом пропадает: после 600 мс класса уже нет
    await expect(fresh).not.toHaveClass(/landed/);
  });

  test('игра открыта в другой подборке: полка не двигается, новая карточка не появляется', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(() => {
      window.__anims = [];
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (frames, opts) { window.__anims.push(this.className); return orig.call(this, frames, opts); };
    });
    const state = await mockUpload(page);
    await openHome(page);
    // «Недавно играли»: новой игры в ней не будет
    await page.locator('.shelf-tab', { hasText: 'Недавно играли' }).click();
    await upload(page);
    await expect(page.locator('.tb .tb-mimic.chew')).toBeVisible();
    state.done = true;
    await expect(page.locator('.tb')).toHaveCount(0, { timeout: 5000 });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__anims.filter((c) => /shelf-card/.test(c)).length)).toBe(0);
    await expect(page.locator(`.shelf-card[data-id="${NEW_ID}"]`)).toHaveCount(0);
  });
});

// Пустая полка: мимик выглядывает из плитки «Добавить игру». Время ведут часы страницы
test.describe('пустая полка', () => {
  const peek = (page) => page.locator('.welcome-peek:not([hidden])');
  const empty = (page) => page.route(/\/api\/games(\?.*)?$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  // Часы идут секундами, пока мимик не покажется (или не выйдет запас)
  async function until(page, seconds, step = 0.4) {
    for (let t = 0; t < seconds; t += step) {
      if (await peek(page).count()) return true;
      await page.clock.runFor(step * 1000);
    }
    return false;
  }

  test('при «уменьшить движение» не выглядывает, при обычном — выглядывает, нажатие на плитку — больше никогда', async ({ page }) => {
    await page.clock.install();
    await empty(page);
    await page.goto('/');
    await expect(page.locator('.welcome-drop')).toBeVisible();
    // Уменьшенное движение (по умолчанию в тестах): за пять минут ни разу
    expect(await until(page, 300, 5)).toBe(false);
    // Выключили «уменьшить движение» — расписание заводится само, первый раз примерно через 30 с (24–36)
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await until(page, 40)).toBe(true);
    // Мимик нарисован внутри плитки, окно обрезки стоит низом на её краю
    const geo = await page.evaluate(() => {
      const tile = document.querySelector('.welcome-drop').getBoundingClientRect();
      const box = document.querySelector('.welcome-peek').getBoundingClientRect();
      return { bottom: Math.round(box.bottom - tile.bottom), inside: box.left >= tile.left && box.right <= tile.right, side: box.width, svg: document.querySelector('.welcome-peek svg').getBoundingClientRect().width };
    });
    expect(geo.bottom).toBe(0);
    expect(geo.inside).toBe(true);
    // Сам рисунок во всё окно: его размер задаёт crispSize (целая клетка), правило значка загрузки не сужает
    expect(geo.svg).toBe(geo.side);
    // Сценарий 2,4 с: к концу мимика нет
    await page.clock.runFor(2600);
    await expect(peek(page)).toHaveCount(0);
    // Нажали на плитку — до конца визита больше не выглянет, и это помнит sessionStorage
    await page.locator('.welcome-drop').click({ noWaitAfter: true });
    expect(await page.evaluate(() => sessionStorage.getItem('mimikin_peek_never'))).toBe('1');
    expect(await until(page, 600, 5)).toBe(false);
  });

  test('пока нажимают клавиши — не выглядывает, затихло — выглядывает', async ({ page }) => {
    await page.clock.install();
    await empty(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await expect(page.locator('.welcome-drop')).toBeVisible();
    // Клавиша раз в 2 с: тишины в 3 с не бывает, за 80 с (дольше любого первого промежутка) мимика нет
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Shift');
      await page.clock.runFor(2000);
      await expect(peek(page)).toHaveCount(0);
    }
    expect(await until(page, 20)).toBe(true);
  });
});
