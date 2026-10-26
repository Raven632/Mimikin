import { test, expect, openLibrary, menu, apiGames } from '../fixtures.js';

test('резервная копия: скачать, поменять, восстановить из неё в «Настройки → Копии»', async ({ page }) => {
  const pick = async () => (await apiGames(page)).find((g) => g.title === 'The Lantern Road');
  const before = await pick();

  // Копия — та же, что по кнопке «Скачать резервную копию»
  const backup = await page.request.get('/api/backup');
  expect(backup.ok()).toBeTruthy();
  expect(backup.headers()['content-disposition']).toMatch(/mimikin-backup_[\d_-]+\.zip/);
  // Файл — содержимым, а не путём: в пути у Playwright — название теста с кириллицей,
  // и браузер такой файл не прочитал бы
  const archive = await backup.body();

  // После копии игру поменяли
  const changed = await page.request.post(`/api/games/${encodeURIComponent(before.id)}/meta`, { data: { rating: 1, status: 'dropped' } });
  expect(changed.ok()).toBeTruthy();
  expect((await pick()).rating).toBe(1);

  await openLibrary(page);
  await menu(page, 'Настройки');
  await page.locator('.settings-tab', { hasText: 'Копии' }).click();
  await expect(page.locator('a.set-link-btn[href="/api/backup"]')).toBeVisible();
  await page.locator('.set-file').setInputFiles({ name: 'mimikin-backup.zip', mimeType: 'application/zip', buffer: archive });
  await expect(page.locator('.confirm-title')).toHaveText('Восстановить из этой копии?');
  await page.locator('.confirm-ok').click();
  await expect(page.locator('.set-result')).toContainText('Готово');

  const after = await pick();
  expect([after.rating, after.status]).toEqual([before.rating, before.status]);
});
