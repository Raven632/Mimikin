import { test, expect, openLibrary, openGame } from '../fixtures.js';

test.describe('клавиатура', () => {
  test('«?» — окно клавиш, Escape закрывает; в поле поиска «?» — просто символ', async ({ page }) => {
    await openLibrary(page);
    await page.keyboard.press('Shift+Slash');
    await expect(page.locator('.keys-content')).toBeVisible();
    await expect(page.locator('.keys-row')).toHaveCount(10);
    await page.keyboard.press('Escape');
    await expect(page.locator('.keys-content')).toHaveCount(0);

    await page.locator('.search-box input').click();
    await page.keyboard.type('?');
    await expect(page.locator('.keys-content')).toHaveCount(0);
    await expect(page.locator('.search-box input')).toHaveValue('?');
  });

  test('«/» ставит курсор в поиск, Escape в поле его очищает', async ({ page }) => {
    await openLibrary(page);
    await page.keyboard.press('/');
    await expect(page.locator('.search-box input')).toBeFocused();
    await page.keyboard.type('frost');
    await expect(page.locator('.library > .game-card')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.search-box input')).toHaveValue('');
  });

  test('окно игры: фокус внутри, Tab не уходит к карточкам за окном', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement?.closest('.modal-content'));
    expect(inside).toBe(true);
  });
});
