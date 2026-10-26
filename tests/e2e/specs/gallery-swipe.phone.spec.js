import { test, expect } from '../fixtures.js';
import { mockGallery, openTrio, watchLayers, layers } from '../galleryMock.js';

// Телефон: картинка идёт за пальцем, у края втрое слабее; ось выбирается после 10 точек; отпустили — доезд или возврат.
// Касания — через CDP (настоящие pointer-события pointerType=touch)
const img = (page) => page.locator('.gallery-view > img:not(.gallery-layer)');
const shift = (page) => img(page).evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);

async function touch(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  return {
    down: (x, y) => send('touchStart', x, y),
    move: (x, y) => send('touchMove', x, y),
    up: () => send('touchEnd'),
  };
}

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
});
