import { test, expect } from '@playwright/test';
import { USER } from '../fixtures.js';

// Свежая демо-библиотека без учётной записи: страница первого запуска проверяет поля, заводит запись
// и сразу входит — без повторного ввода. Этой записью входят все остальные тесты
test('первый запуск: требования к полям, учётная запись и сразу вход', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#auth-title')).toHaveText('Первый запуск');

  await page.locator('input[name=username]').fill(USER.username);
  await page.locator('input[name=password]').fill('12');
  await page.locator('input[name=password2]').fill('12');
  await page.locator('.auth-submit').click();
  await expect(page.locator('.auth-error')).toHaveText('Слишком короткий логин или пароль');

  await page.locator('input[name=password]').fill(USER.password);
  await page.locator('input[name=password2]').fill(`${USER.password}x`);
  await page.locator('.auth-submit').click();
  await expect(page.locator('.auth-error')).toHaveText('Пароли не совпадают');

  await page.locator('input[name=password2]').fill(USER.password);
  await page.locator('.auth-submit').click();
  // После входа — главная; в шапке число игр библиотеки
  await expect(page.locator('.shelf-card').first()).toBeVisible();
  await expect(page.locator('.nav-tab', { hasText: 'Библиотека' })).toContainText('16');
  await expect(page.locator('.brand-title')).toHaveText('Mimikin');
});
