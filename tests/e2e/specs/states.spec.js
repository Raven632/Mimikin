import { test, expect, openLibrary, menu } from '../fixtures.js';

test.describe('пусто, загрузка, ошибка', () => {
  test('пустая библиотека: экран приветствия, статистика без нулей', async ({ page }) => {
    await page.route(/\/api\/games(\?.*)?$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
    await page.goto('/');
    await expect(page.locator('.welcome')).toBeVisible();
    await expect(page.locator('.welcome-title')).toHaveText('Ваши игры');
    await expect(page.locator('.empty-state')).toHaveCount(0);
    await menu(page, 'Статистика');
    await expect(page.locator('.stats-content .state-empty')).toContainText('Статистики пока нет');
  });

  test('список игр не пришёл (500) — ошибка с «Ещё раз», а не «Библиотека пока пустая»; повтор показывает игры', async ({ page }) => {
    let fail = true;
    await page.route(/\/api\/games(\?.*)?$/, (route) => (fail && route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { error: 'x' } }) : route.continue()));
    await page.goto('/');
    await expect(page.locator('.library > .state-error')).toContainText('Не удалось загрузить библиотеку');
    await expect(page.locator('.welcome')).toHaveCount(0);
    fail = false;
    await page.locator('.library > .state-error .state-retry').click();
    await expect(page.locator('.home-continue')).toBeVisible();
    await expect(page.locator('.state-error')).toHaveCount(0);
  });

  test('ревизия не собралась — ошибка с «Ещё раз», повтор её собирает', async ({ page }) => {
    let fail = true;
    await page.route('**/api/games/audit', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'x' } }) : route.continue()));
    await openLibrary(page);
    await menu(page, 'Статистика');
    await page.locator('.library-tab', { hasText: 'Ревизия' }).click();
    await expect(page.locator('.state-error')).toContainText('Не удалось собрать ревизию');
    fail = false;
    await page.locator('.state-error .state-retry').click();
    await expect(page.locator('.state-error')).toHaveCount(0);
    await expect(page.locator('.audit-hint').first()).toBeVisible();
  });

  test('новинки без интернета — ошибка с «Ещё раз»; «Хочу поиграть» пуст и говорит, как туда попасть', async ({ page }) => {
    await openLibrary(page);
    await page.locator('.nav-tab', { hasText: 'Новинки' }).click();
    await expect(page.locator('.catalog-content .state-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.catalog-content .state-retry')).toBeVisible();
    await page.locator('.catalog-sources .chip', { hasText: 'Хочу поиграть' }).click();
    await expect(page.locator('.catalog-content .state-empty')).toContainText('Список «Хочу поиграть» пуст');
  });
});
