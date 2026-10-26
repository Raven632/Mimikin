import { test, expect, openLibrary, USER } from '../fixtures.js';

test('выход и вход: вопрос перед выходом, неверный пароль — ошибка, верный — библиотека', async ({ page }) => {
  await openLibrary(page);
  await page.locator('.header-menu-btn').click();
  await page.locator('.menu-logout').click();
  await expect(page.locator('.confirm-title')).toHaveText('Выйти?');
  await page.locator('.confirm-ok').click();
  await expect(page.locator('#auth-title')).toHaveText('Вход в библиотеку');

  await page.locator('input[name=username]').fill(USER.username);
  await page.locator('input[name=password]').fill('wrong-password');
  await page.locator('.auth-submit').click();
  await expect(page.locator('.auth-error')).toHaveText('Неверный логин или пароль');

  await page.locator('input[name=password]').fill(USER.password);
  await page.locator('.auth-submit').click();
  await expect(page.locator('.library > .game-card').first()).toBeVisible();
});
