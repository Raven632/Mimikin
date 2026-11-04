import { test, expect } from '../fixtures.js';

// Код сканируют телефоном с экрана компьютера, поэтому на самом телефоне пункта нет
test('на телефоне в меню нет пункта «Открыть на телефоне»', async ({ page }) => {
  await page.goto('/');
  await page.locator('.header-menu-btn').click();
  await expect(page.locator('.header-menu-item', { hasText: 'Настройки' })).toBeVisible();
  await expect(page.locator('.header-menu-item', { hasText: 'Открыть на телефоне' })).toBeHidden();
});
