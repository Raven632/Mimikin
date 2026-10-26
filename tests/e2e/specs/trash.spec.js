import { test, expect, openLibrary, openGame, menu, apiGames } from '../fixtures.js';

const has = async (page, title) => (await apiGames(page)).some((g) => g.title === title);

async function deleteGame(page, title) {
  await openGame(page, title);
  await page.locator('.modal-more-btn').click();
  await page.locator('.modal-more-item.danger', { hasText: 'Удалить' }).click();
  await expect(page.locator('.confirm-text')).toContainText('30 дней');
  await page.locator('.confirm-ok').click();
  await expect(page.locator('.toast.show')).toContainText('Игра в корзине');
  await expect.poll(() => has(page, title)).toBe(false);
}

async function openTrash(page) {
  await menu(page, 'Настройки');
  await page.locator('.settings-tab', { hasText: 'Корзина' }).click();
}

test.describe('корзина', () => {
  test('удалённую игру возвращает «Отменить» в тосте', async ({ page }) => {
    await openLibrary(page);
    await deleteGame(page, 'Dragon Post Office');
    await page.locator('.toast.show .toast-action').click();
    await expect(page.locator('.toast.show')).toContainText('Игра вернулась в библиотеку');
    await expect.poll(() => has(page, 'Dragon Post Office')).toBe(true);
    await expect(page.locator('.library > .game-card', { hasText: 'Dragon Post Office' })).toBeVisible();
  });

  test('игра лежит в «Настройки → Корзина» и возвращается оттуда со своими данными', async ({ page }) => {
    const before = (await apiGames(page)).find((g) => g.title === 'Moonlit Library');
    await openLibrary(page);
    await deleteGame(page, 'Moonlit Library');
    await openTrash(page);
    const item = page.locator('.trash-item', { hasText: 'Moonlit Library' });
    await expect(item).toContainText('30 дн');
    await item.locator('button', { hasText: 'Вернуть' }).click();
    await expect(page.locator('.trash-item', { hasText: 'Moonlit Library' })).toHaveCount(0);
    await expect.poll(() => has(page, 'Moonlit Library')).toBe(true);
    const after = (await apiGames(page)).find((g) => g.title === 'Moonlit Library');
    expect([after.rating, after.developer, after.tags]).toEqual([before.rating, before.developer, before.tags]);
  });

  test('«Стереть» удаляет навсегда, корзина пустеет', async ({ page }) => {
    await openLibrary(page);
    await deleteGame(page, 'Seven Keys');
    await openTrash(page);
    await page.locator('.trash-item', { hasText: 'Seven Keys' }).locator('button', { hasText: 'Стереть' }).click();
    await expect(page.locator('.confirm-title')).toHaveText('Стереть навсегда?');
    await page.locator('.confirm-ok').click();
    await expect(page.locator('.settings-panel .state-empty')).toContainText('Корзина пуста');
    expect(await has(page, 'Seven Keys')).toBe(false);
  });

  test('папку убрали мимо приложения: запись с подсказкой вместо «Вернуть», «Стереть» — про данные, а не про папку', async ({ page }) => {
    const now = Date.now();
    await page.route(/\/api\/games\/trash$/, (route) => route.fulfill({ json: { items: [{
      key: `${now}-Gone_Game`, id: 'Gone_Game', title: 'Gone Game', cover: null, deletedAt: now - 3600e3,
      purgeAt: now + 29 * 864e5, daysLeft: 30, size: 0, playtime: 600, taken: false, vanished: true,
    }] } }));
    await openLibrary(page);
    await openTrash(page);
    const item = page.locator('.trash-item', { hasText: 'Gone Game' });
    await expect(item).toContainText('папка пропала');
    await expect(item).toContainText('Положите папку на место');
    await expect(item.locator('button', { hasText: 'Вернуть' })).toHaveCount(0);
    await item.locator('button', { hasText: 'Стереть' }).click();
    await expect(page.locator('.confirm-text')).toContainText('Сотрётся всё, что об игре известно');
  });
});
