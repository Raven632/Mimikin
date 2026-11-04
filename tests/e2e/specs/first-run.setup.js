import { test, expect } from '@playwright/test';
import { USER } from '../fixtures.js';

// Свежая демо-библиотека без учётной записи: страница первого запуска проверяет поля, заводит запись
// и сразу входит — без повторного ввода. Этой записью входят все остальные тесты
test('первый запуск: требования к полям, учётная запись и сразу вход', async ({ page }, testInfo) => {
  await page.goto('/');
  // Повтор после сбоя идёт на той же базе: если запись уже заведена, экран первого запуска не покажется.
  // Тогда проверять нечего, кроме того, что остальным тестам есть чем входить
  if (testInfo.retry) {
    await expect(page.locator('#auth-title')).toBeVisible();
    if ((await page.locator('#auth-title').textContent()) !== 'Первый запуск') {
      expect((await page.request.post('/api/login', { data: USER })).ok(), `вход ${USER.username}`).toBeTruthy();
      return;
    }
  }
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
  // После входа — главная
  await expect(page.locator('.shelf-card').first()).toBeVisible();
  await expect(page.locator('.brand-title')).toHaveText('Mimikin');
  // Меток языков на первом экране нет: знакомым сохраняется язык страницы
  await expect.poll(() => page.evaluate(() => fetch('/api/settings/known-langs').then((r) => r.json()).then((d) => d.langs))).toEqual(['ru']);
});
