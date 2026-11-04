import { test, expect, openLibrary } from '../fixtures.js';
import { mockScene, touch } from '../scene.js';

// Телефон: полоса реплик плеера сцены тянется пальцем (касания через CDP), касание полосы не листает сцену, панель
// остаётся в два ряда, и вся строка полосы влезает без прокрутки вбок
test.describe('телефон: полоса реплик сцены', () => {
  test('палец тянет полосу — строка и картинка меняются; касание полосы не листает; панель в два ряда', async ({ page }) => {
    const scene = () => ({ files: ['pic0.png', 'pic1.png'], steps: [{ k: 'pic', i: 0 },
      ...Array.from({ length: 12 }, (_, i) => [...(i === 8 ? [{ k: 'pic', i: 1 }] : []), { k: 'say', who: '', text: `Line ${i + 1}` }]).flat()] });
    await mockScene(page, { albums: [{ key: 'events/00001/Night scene', album: { sum: { l: 12, p: 2 } } }], scene });
    await openLibrary(page);
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).tap();
    await page.locator('.act-gallery').tap();
    await page.locator('.gallery-source', { hasText: 'Сцены' }).tap({ timeout: 20_000 });
    await page.locator('.gallery-tile.scene-tile').first().tap();
    const text = page.locator('.scene-text');
    await expect(text).toHaveText('Line 1');
    const bar = await page.locator('.scene-seek .seek-line').boundingBox();
    const y = bar.y + bar.height / 2;
    // Палец от начала к ~75 %: под ним 9-я строка (8 из 11), за ней — вторая картинка
    const t = await touch(page);
    await t.down(bar.x + 2, y);
    for (let i = 1; i <= 6; i++) await t.move(bar.x + 2 + ((bar.width * 0.73 - 2) * i) / 6, y);
    await expect(text).toHaveText('Line 9');
    await t.up();
    await expect(page.locator('.scene-pic:not(.scene-anim):not(.scene-dim)')).toHaveAttribute('src', /pic1\.png/);
    await expect(page.locator('.scene-seek .seek-time.cur')).toHaveText('9');
    // Короткое касание полосы у начала — переход на 1-ю, а не «дальше»
    await t.down(bar.x + 1, y);
    await t.up();
    await expect(text).toHaveText('Line 1');
    await page.waitForTimeout(500);
    await expect(text).toHaveText('Line 1');
    // Панель — два ряда (не выше 80 px), полоса над ней и шириной с рамку реплики; прокрутки вбок нет
    const panel = await page.locator('.scene-bar').boundingBox();
    expect(panel.height).toBeLessThanOrEqual(80);
    const row = await page.locator('.scene-seek').boundingBox();
    const box = await page.locator('.scene-box').boundingBox();
    expect(row.y + row.height).toBeLessThanOrEqual(panel.y);
    expect(row.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(Math.abs(row.width - box.width)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
