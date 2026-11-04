import { test, expect, openLibrary, openGame } from '../fixtures.js';

// Порт игр опубликован не тот (docker run -p 9000:3001) или там другая установка: вместо белой страницы — окно с адресом
// и подсказкой, что поправить. Запрос /ready подменяем: адрес игр в этой сети один и настоящий
const FRAME = '.game-frame iframe';

test.describe('сервер игр не отвечает', () => {
  test('нет ответа: окно с адресом и GAME_PORT, рамки нет, слой запуска убран', async ({ page }) => {
    await page.route('**/ready/**', (route) => route.abort());
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    const box = page.locator('.confirm-box');
    await expect(box).toBeVisible();
    await expect(box.locator('.confirm-name')).toHaveText(/^http:\/\/[^/]+:3001$/);
    await expect(box.locator('.confirm-text')).toContainText('GAME_PORT');
    await expect(page.locator('.game-frame')).toHaveCount(0);
    await expect(page.locator('.frame-intro')).toHaveCount(0);
    await box.locator('.confirm-cancel').click();
    await expect(box).toHaveCount(0);
    await expect(page.locator('.game-frame')).toHaveCount(0);
    await expect(page.locator('#modal-play-btn')).toBeEnabled();
  });

  test('другая установка на этом порту (403): то же окно, «Открыть всё равно» открывает игру', async ({ page }) => {
    await page.route('**/ready/**', (route) => route.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*' }, body: 'Нет доступа' }));
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await page.locator('.confirm-ok').click();
    await expect(page.frameLocator(FRAME).locator('#demo-game')).toContainText('Ember & Frost', { timeout: 15_000 });
  });

  test('чужой ответ 200 — не наша библиотека: окно', async ({ page }) => {
    await page.route('**/ready/**', (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'text/html', body: '<html></html>' }));
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.confirm-box')).toBeVisible();
  });

  test('адрес из GAME_ORIGIN: подсказка про него, а не про порт', async ({ page }) => {
    await page.route('**/api/play/*', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), origin: 'https://games.invalid' } });
    });
    await page.route('https://games.invalid/**', (route) => route.abort());
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    const box = page.locator('.confirm-box');
    await expect(box.locator('.confirm-name')).toHaveText('https://games.invalid');
    await expect(box.locator('.confirm-text')).toContainText('GAME_ORIGIN');
  });

  test('сервер игр на месте: окна нет, игра открывается', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect(page.frameLocator(FRAME).locator('#demo-game')).toContainText('Ember & Frost', { timeout: 15_000 });
    await expect(page.locator('.confirm-box')).toHaveCount(0);
  });
});
