import { test, expect } from '../fixtures.js';
import { mockGallery, openTrio, watchLayers, layers } from '../galleryMock.js';
import { touch } from '../scene.js';
import { openGame, openLibrary } from '../fixtures.js';

// Телефон: картинка идёт за пальцем, у края втрое слабее; ось выбирается после 10 точек; отпустили — доезд или возврат.
// Касания — через CDP (настоящие pointer-события pointerType=touch)
const img = (page) => page.locator('.gallery-view > img:not(.gallery-layer)');
const shift = (page) => img(page).evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);

test.describe('телефон: галерея за пальцем', () => {
  test.beforeEach(async ({ page }) => { await mockGallery(page); });

  test('тянется за пальцем 1:1, у края втрое слабее, отпустили с места — вернулась', async ({ page }) => {
    await openTrio(page);
    await watchLayers(page);
    const t = await touch(page);
    // Первый кадр альбома: слева ничего нет — вправо тянет втрое слабее
    await t.down(200, 300);
    await t.move(215, 300);
    await t.move(290, 300);
    await expect.poll(() => shift(page)).toBeCloseTo(30, -1);
    await new Promise((r) => setTimeout(r, 150)); // палец стоял — скорость 0
    await t.up();
    await expect.poll(() => shift(page)).toBe(0);
    // Влево 1:1: рядом лежит следующий кадр
    await t.down(250, 300);
    await t.move(240, 300);
    await t.move(170, 300);
    await expect.poll(() => shift(page)).toBeCloseTo(-80, -1);
    expect((await layers(page)).max).toBe(1);
    await new Promise((r) => setTimeout(r, 150));
    await t.up();
    await expect.poll(() => shift(page)).toBe(0);
    await expect(img(page)).toHaveAttribute('src', /p1\.png/);
    await expect(page.locator('.gallery-layer')).toHaveCount(0);
  });

  test('протянули дальше четверти — следующий кадр на месте, копий нет; вертикально — ось не наша', async ({ page }) => {
    await openTrio(page);
    const t = await touch(page);
    await t.down(300, 300);
    await t.move(280, 300);
    await t.move(120, 300);
    await new Promise((r) => setTimeout(r, 150));
    await t.up();
    await expect(img(page)).toHaveAttribute('src', /p2\.png/);
    await expect(page.locator('.gallery-layer')).toHaveCount(0);
    expect(await shift(page)).toBe(0);
    await expect(page.locator('.gallery-where-pos')).toContainText('2');
    // Ось «вверх-вниз» выбрана после 10 точек: кадр за пальцем не едет
    await t.down(200, 500);
    await t.move(205, 480);
    await t.move(210, 400);
    expect(await shift(page)).toBe(0);
    await t.up();
  });

  test('без уменьшения движения: тот же конечный результат после доезда', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openTrio(page);
    const t = await touch(page);
    await t.down(300, 300);
    await t.move(280, 300);
    await t.move(120, 300);
    await new Promise((r) => setTimeout(r, 150));
    await t.up();
    await expect(img(page)).toHaveAttribute('src', /p2\.png/);
    await expect(page.locator('.gallery-layer')).toHaveCount(0);
    expect(await shift(page)).toBe(0);
  });

  test('полоса тегов листается пальцем и кадр не перелистывает; свайп вне панели листает', async ({ page }) => {
    await page.route(/\/api\/gallery\/[^/]+\/tags\?f=/, (route) => route.fulfill({ json: { tags: ['sword', 'glasses', 'cow_print', 'boots', 'gloves', 'long_hair', 'night', 'red_hair'].map((tag) => ({ tag, p: 0.9 })) } }));
    await openTrio(page);
    await page.locator('.gallery-bar .gallery-play', { hasText: 'Теги' }).click();
    const strip = page.locator('.gallery-tags');
    await expect(strip.locator('.chip')).toHaveCount(8);
    const box = await strip.boundingBox();
    const y = box.y + box.height / 2;
    const t = await touch(page);
    await t.down(box.x + box.width - 20, y);
    for (let x = box.x + box.width - 40; x > box.x + 40; x -= 30) await t.move(x, y);
    await t.up();
    // Кадр тот же, полоса уехала
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    await expect(img(page)).toHaveAttribute('src', /p1\.png/);
    // Вне панели — как раньше
    await t.down(300, 300);
    await t.move(280, 300);
    await t.move(120, 300);
    await new Promise((r) => setTimeout(r, 150));
    await t.up();
    await expect(img(page)).toHaveAttribute('src', /p2\.png/);
  });

  test('панель тегов в галерее — лист снизу на всю ширину; нажатие на затемнение закрывает, плитка не открывается', async ({ page }) => {
    await page.route(/\/api\/gallery\/[^/]+\/tags$/, (route) => route.fulfill({ json: { files: ['p1.png'], tags: [{ tag: 'sword', f: [0] }, { tag: 'maid', f: [0] }] } }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    await page.locator('.gallery-tools .gallery-play[aria-haspopup="dialog"]').click({ timeout: 20_000 });
    const panel = page.locator('.tag-panel');
    await expect(panel.locator('.tag-row')).toHaveCount(2);
    const box = await panel.boundingBox();
    const size = page.viewportSize();
    expect(box.x).toBe(0);
    expect(box.width).toBe(size.width);
    expect(Math.round(box.y + box.height)).toBe(size.height);
    await page.touchscreen.tap(size.width / 2, 40);
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.gallery-view')).toHaveCount(0);
  });

  test('игру ещё не разобрали: кнопка «Теги» с подписью на месте, панель объясняет почему тегов нет', async ({ page }) => {
    await page.route(/\/api\/gallery\/[^/]+\/tags$/, (route) => route.fulfill({ json: { files: [], tags: [] } }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    const btn = page.locator('.gallery-tools .tag-tool');
    await expect(btn).toBeVisible({ timeout: 20_000 });
    await expect(btn.locator('.tool-label')).toBeVisible();
    await expect(btn).toHaveText('Теги');
    await btn.click();
    await expect(page.locator('.tag-none')).toHaveText('Теги появятся, когда сервер разберёт картинки этой игры');
    await expect(page.locator('.tag-panel input')).toHaveCount(0);
  });

  test('свайп в окне игры и в галерее не двигает страницу сзади', async ({ page }) => {
    await openLibrary(page);
    await page.evaluate(() => { document.body.style.minHeight = '4000px'; window.scrollTo(0, 500); });
    const y = () => page.evaluate(() => Math.round(window.scrollY));
    await expect.poll(y).toBe(500);
    await openGame(page, 'Starfall Inn');
    const before = await y();
    const t = await touch(page);
    const swipe = async (from, to) => { await t.down(195, from); for (let k = 1; k <= 8; k++) await t.move(195, from + ((to - from) * k) / 8); await t.up(); await new Promise((r) => setTimeout(r, 300)); };
    await swipe(300, 600);
    await swipe(600, 300);
    expect(await y()).toBe(before);
    await page.locator('.act-gallery').click();
    await expect(page.locator('.gallery').first()).toBeVisible();
    await swipe(300, 600);
    await swipe(600, 300);
    await swipe(300, 600);
    expect(await y()).toBe(before);
  });

  test('сервер не ответил про теги: кнопки «Теги» нет, панель не врёт, что игру ещё не разобрали', async ({ page }) => {
    await page.route(/\/api\/gallery\/[^/]+\/tags$/, (route) => route.fulfill({ status: 500, json: { error: 'tags-failed' } }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    await expect(page.locator('.gallery-tile').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.gallery-tools .tag-tool')).toHaveCount(0);
  });
});
