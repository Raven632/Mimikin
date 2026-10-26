import { test, expect, openLibrary, openGame, menu } from '../fixtures.js';

// Мимик-загрузчик (MimicLoader): появляется через 250 мс, в «уменьшить движение» стоит открытым, клетка — целое
// число точек экрана. Время кадров не меряем: проверяем конечное состояние и правило движения

const delayed = (ms) => async (route) => { await new Promise((r) => setTimeout(r, ms)); await route.continue(); };

test.describe('мимик-загрузчик', () => {
  test('библиотека грузится: мимик по центру места под сетку, пустых «томов» нет; пришли игры — мимик ушёл', async ({ page }) => {
    await page.route(/\/api\/games(\?.*)?$/, (route) => (route.request().method() === 'GET' ? delayed(1500)(route) : route.continue()));
    await page.goto('/');
    const wait = page.locator('.library-wait .mimic-wait.show');
    await expect(wait).toBeVisible();
    await expect(wait).toContainText('Загружаю библиотеку');
    await expect(page.locator('.card-skeleton')).toHaveCount(0);
    // Клетка — целое число точек экрана: сторона × DPR кратна 16
    const cell = await wait.locator('.mimic').evaluate((el) => (el.getBoundingClientRect().width * devicePixelRatio * parseFloat(getComputedStyle(document.documentElement).zoom || 1)) / 16);
    expect(Math.abs(cell - Math.round(cell))).toBeLessThan(1e-3);
    await expect(page.locator('.home-continue, .shelf-card').first()).toBeVisible();
    await expect(page.locator('.mimic-wait')).toHaveCount(0);
  });

  test('«уменьшить движение»: мимик стоит открытым; без этой настройки кадры идут', async ({ page }) => {
    await page.route(/\/api\/games(\?.*)?$/, (route) => (route.request().method() === 'GET' ? delayed(2500)(route) : route.continue()));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const mimic = page.locator('.mimic-wait.show .mimic');
    await expect(mimic).toBeVisible();
    expect(await mimic.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    expect(await mimic.evaluate((el) => getComputedStyle(el).backgroundPositionX)).toBe('0px');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => mimic.evaluate((el) => getComputedStyle(el).animationName)).toBe('mimic-wait');
  });

  test('ответ быстрее 250 мс: мимика не было', async ({ page }) => {
    await page.addInitScript(() => {
      window.__mimic = 0;
      new MutationObserver(() => { if (document.querySelector('.mimic-wait.show')) window.__mimic += 1; }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    await openLibrary(page);
    expect(await page.evaluate(() => window.__mimic)).toBe(0);
  });

  test('окно «Состояние» с загрузкой: мимик 32 вместо полосы', async ({ page }) => {
    await page.route('**/api/games/audit', delayed(2500));
    await openLibrary(page);
    await menu(page, 'Статистика');
    await page.locator('.library-tab', { hasText: 'Ревизия' }).click();
    await expect(page.locator('.state-loading .mimic-wait.show .mimic')).toBeVisible();
    await expect(page.locator('.state-line')).toHaveCount(0);
    await expect(page.locator('.audit-hint').first()).toBeVisible({ timeout: 10_000 });
  });

  test('галерея собирается: мимик 64 по центру, клетки горят по доле «N из M»', async ({ page }) => {
    await page.route(/\/api\/gallery\/[^/?]+(\?.*)?$/, (route) => route.fulfill({ json: { state: 'building', done: 7, total: 14, albums: [] } }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    const wait = page.locator('.gallery-wait .mimic-wait.show');
    await expect(wait).toBeVisible();
    await expect(wait).toContainText('7 из 14');
    // Половина: горят нижние ряды, верхние тусклые, глаза своим цветом
    await expect(wait.locator('.mimic-cells .on').first()).toBeVisible();
    await expect(wait.locator('.mimic-cells .off').first()).toBeAttached();
    await expect(wait.locator('.mimic-cells .eye')).toHaveCount(4);
  });

  test('запуск игры: мимик 64 на чёрном, пока рамка не загрузилась; потом ушёл сразу', async ({ page }) => {
    await page.route('**/*', (route) => (route.request().resourceType() === 'document' && route.request().frame() !== page.mainFrame() ? delayed(1800)(route) : route.continue()));
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.game-frame .game-frame-wait .mimic-wait.show')).toBeVisible();
    await expect(page.frameLocator('.game-frame iframe').locator('#demo-game')).toContainText('Ember & Frost', { timeout: 15_000 });
    await expect(page.locator('.game-frame-wait')).toHaveCount(0);
  });
});
