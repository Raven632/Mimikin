import { test, expect, openLibrary, openGame, menu } from '../fixtures.js';
import { mockGallery, openTrio } from '../galleryMock.js';

// Отклик на нажатие (pulse.js): сердечко и звёзды вспыхивают двумя кадрами цвета (атрибут data-f), только при добавлении;
// ручка переключателя идёт ступенями. Кадры живут по 80 мс — их записывает наблюдатель, а проверяем порядок и состав
async function record(page) {
  await page.evaluate(() => {
    window.__f = [];
    new MutationObserver((list) => {
      for (const m of list) {
        const v = m.target.getAttribute('data-f');
        if (v) window.__f.push({ cls: m.target.className, v, i: [...(m.target.parentElement?.children || [])].indexOf(m.target), spark: m.target.hasAttribute('data-spark') });
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-f'], subtree: true });
  });
}
const frames = (page) => page.evaluate(() => window.__f);

// Избранное подменяем: кадров p1.png на диске демо-игры нет, и сервер не принял бы такую отметку
async function mockFavorites(page) {
  await page.route(/\/api\/favorites/, (route) => route.fulfill({ json: route.request().method() === 'GET' ? [] : { ok: true } }));
}

test.describe('отклик на нажатие', () => {
  test('сердечко в просмотре галереи: при добавлении два кадра цвета, при снятии вспышки нет', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await mockGallery(page);
    await mockFavorites(page);
    await openTrio(page);
    await record(page);
    const heart = page.locator('.gallery-view .gallery-fav');
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await frames(page)).map((f) => f.v).join('')).toBe('12');
    await expect(heart).not.toHaveAttribute('data-f', /.*/);
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(400);
    expect((await frames(page)).length).toBe(2);
  });

  test('уменьшить движение: сердечко без кадров цвета', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockGallery(page);
    await mockFavorites(page);
    await openTrio(page);
    await record(page);
    const heart = page.locator('.gallery-view .gallery-fav');
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(400);
    expect(await frames(page)).toEqual([]);
    await heart.click();
  });

  test('звёзды: вспыхивают только новые горящие, при понижении — только нажатая; искры у нажатой', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openLibrary(page);
    const id = (await (await page.request.get('/api/games')).json()).find((g) => g.title === 'Tidecaller').id;
    await page.request.post(`/api/games/${encodeURIComponent(id)}/meta`, { data: { rating: 2 } });
    await page.reload();
    await expect(page.locator('.library > .game-card').first()).toBeVisible();
    await openGame(page, 'Tidecaller');
    await expect(page.locator('.rating-star.active')).toHaveCount(2);
    await record(page);
    const stars = page.locator('.rating-star');
    await stars.nth(4).click();
    await expect(page.locator('.rating-star.active')).toHaveCount(5);
    await expect.poll(async () => (await frames(page)).filter((f) => f.v === '1').length).toBe(3);
    // Были две горящие: вспыхнули третья, четвёртая и пятая; искры — только у нажатой (последняя в первом кадре)
    const first = (await frames(page)).filter((f) => f.v === '1');
    expect(first.map((f) => f.i)).toEqual([2, 3, 4]);
    expect(first.map((f) => f.spark)).toEqual([false, false, true]);
    await page.waitForTimeout(500);
    await record(page);
    await stars.nth(1).click();
    await expect(page.locator('.rating-star.active')).toHaveCount(2);
    await expect.poll(async () => (await frames(page)).length).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    expect([...new Set((await frames(page)).map((f) => f.i))]).toEqual([1]);
  });

  test('ручка переключателя идёт четырьмя ступенями; уменьшить движение — без перехода', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openLibrary(page);
    await menu(page, 'Настройки');
    const knob = (p) => p.locator('.set-toggle input').first().evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return { fn: s.transitionTimingFunction, dur: s.transitionDuration, prop: s.transitionProperty };
    });
    const on = await knob(page);
    expect(on.fn).toMatch(/steps\(4, (jump-)?start\)/); // jump-start браузер записывает как start
    expect(on.dur.split(',')[0].trim()).toBe('0.16s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const off = await knob(page);
    expect(off.dur.split(',').every((d) => d.trim() === '0s')).toBe(true);
  });
});
