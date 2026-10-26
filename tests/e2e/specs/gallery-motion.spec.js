import { test, expect } from '../fixtures.js';
import { mockGallery, openTrio, watchLayers, layers } from '../galleryMock.js';

// Смена кадра в просмотре галереи: наплыв 140 мс после img.decode(), слоёв не больше двух. Проверяем конечное состояние и
// число слоёв, а не время кадров
const img = (page) => page.locator('.gallery-view > img:not(.gallery-layer)');

test.describe('галерея: смена кадра', () => {
  test.beforeEach(async ({ page }) => { await mockGallery(page); });

  test('наплыв: новый кадр на месте, копия прежнего убрана, слой не больше одного; клавиша вперёд и назад', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openTrio(page);
    await watchLayers(page);
    await page.keyboard.press('ArrowRight');
    await expect(img(page)).toHaveAttribute('src', /p2\.png/);
    await expect(page.locator('.gallery-layer')).toHaveCount(0);
    const seen = await layers(page);
    expect(seen.added).toBe(1);
    expect(seen.max).toBeLessThanOrEqual(1);
    expect(await img(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.keyboard.press('ArrowLeft');
    await expect(img(page)).toHaveAttribute('src', /p1\.png/);
    await expect(page.locator('.gallery-layer')).toHaveCount(0);
  });

  test('быстрые нажатия: слоёв не больше одной копии, в конце виден последний кадр целиком', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openTrio(page);
    await watchLayers(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await expect(img(page)).toHaveAttribute('src', /p3\.png/);
    await expect(page.locator('.gallery-layer')).toHaveCount(0);
    expect((await layers(page)).max).toBeLessThanOrEqual(1);
    expect(await img(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(page.locator('.gallery-view > img')).toHaveCount(1);
  });

  test('уменьшить движение: кадр меняется сразу, копий нет', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTrio(page);
    await watchLayers(page);
    await page.keyboard.press('ArrowRight');
    await expect(img(page)).toHaveAttribute('src', /p2\.png/);
    await page.keyboard.press('ArrowRight');
    await expect(img(page)).toHaveAttribute('src', /p3\.png/);
    expect((await layers(page)).added).toBe(0);
  });
});
