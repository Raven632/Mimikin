import { test, expect, openLibrary, menu, apiGames, emptyTrash } from '../fixtures.js';

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

test('переезд: игра без папки после восстановления — карточка на полке с пустой обложкой; итог говорит, сколько где', async ({ page }) => {
  // Игра, оставшаяся в корзине или на полке от упавшего прогона, мешала бы и этой, и соседним проверкам
  await emptyTrash(page);
  const game = (await apiGames(page)).find((g) => g.title === "Wanderer's Almanac");
  const archive = await (await page.request.get('/api/backup')).body();
  // Папки игры больше нет — как на новой установке. Файлы и запись — в корзине, в конце вернём
  const key = (await (await page.request.delete(`/api/games/${encodeURIComponent(game.id)}`)).json()).trashKey;

  await openLibrary(page);
  await menu(page, 'Настройки');
  await page.locator('.settings-tab', { hasText: 'Копии' }).click();
  await page.locator('.set-file').setInputFiles({ name: 'mimikin-backup.zip', mimeType: 'application/zip', buffer: archive });
  await page.locator('.confirm-ok').click();
  const result = page.locator('.set-result');
  await expect(result).toContainText(/Готово\. Игр с файлами: \d+, на полке: \d+, файлов сейвов: \d+\./);
  await expect(result.locator('summary')).toContainText('загрузите архив игры или положите её папку в библиотеку');
  await result.locator('summary').click();
  await expect(result.locator('details')).toContainText(game.id);

  // Файл обложки этой игры остался в _media (на настоящем переезде его нет, и сервер отдаёт пустую — http.test.js)
  await page.route(/\/api\/games$/, async (route) => {
    const list = await (await route.fetch()).json();
    return route.fulfill({ json: list.map((g) => (g.id === game.id ? { ...g, cover: null } : g)) });
  });
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  const card = page.locator('.library > .game-card', { has: page.locator('.folder-name', { hasText: game.id }) });
  await expect(card).toHaveClass(/shelved/);
  await expect(card.locator('.cover-placeholder')).toBeVisible();
  await expect(card.locator('.card-cover img')).toHaveCount(0);
  await expect(card.locator('.card-shelf')).toHaveText('На полке');
  await expect(card.locator('.card-play')).toHaveCount(0);

  // Файлы из корзины встают к этой карточке: удалённая игра не застревает за вернувшейся карточкой
  expect((await page.request.post(`/api/games/trash/${key}/restore`)).ok()).toBeTruthy();
  await page.unroute(/\/api\/games$/);
  expect((await apiGames(page)).find((g) => g.id === game.id).shelved_at || 0).toBe(0);
});
