import { test, expect, openHome } from '../fixtures.js';

test.use({ locale: 'en-US' });

// Сервер пишет отказ по-русски, а причину шлёт кодом: человек с английским браузером видит её своими словами.
// Сервер подменён, как в upload.spec.js: настоящая распаковка здесь ни при чём
test('English interface: an archive on another engine is refused in plain words, not as "Server error"', async ({ page }) => {
  const refusal = { state: 'error', error: "Это игра на Ren'Py — библиотека запускает только игры на RPG Maker MV и MZ", reason: 'other-engine', params: { engine: ["Ren'Py"] } };
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const { name, size } = route.request().postDataJSON();
    return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => route.fulfill({ json: { id: 'Visual.zip', received: 1, size: 1, ...refusal } }));
  await page.route(/\/api\/games\/upload\/(list|trace)/, (route) => route.fulfill({ json: [] }));
  await openHome(page);

  await page.locator('.controls-zone input[type=file]').setInputFiles([{ name: 'Visual.zip', mimeType: 'application/zip', buffer: Buffer.from('zip bytes') }]);

  const toast = page.locator('.toast.show');
  await expect(toast).toContainText("This game is made with Ren'Py");
  await expect(toast).toContainText('RPG Maker MV and MZ');
  await expect(toast).not.toContainText('Server error');
});

// Человек мог отойти на время большой загрузки: причина не должна пропасть по таймеру
test('English interface: a refused upload stays in the bar with its reason until it is closed', async ({ page }) => {
  const refusal = { state: 'error', error: "Это игра на Ren'Py", reason: 'other-engine', params: { engine: ["Ren'Py"] } };
  let list = [];
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const { name, size } = route.request().postDataJSON();
    list = [{ id: name, name, size, received: size, target: '', mode: '', busy: false, queued: false, updatedAt: 1, ...refusal }];
    return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => route.fulfill({ json: { id: 'Visual.zip', received: 1, size: 1, ...refusal } }));
  await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: list }));
  await page.route(/\/api\/games\/upload\/trace/, (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/games\/upload\/cancel/, (route) => { list = []; return route.fulfill({ json: { cancelled: true } }); });
  await openHome(page);

  await page.locator('.controls-zone input[type=file]').setInputFiles([{ name: 'Visual.zip', mimeType: 'application/zip', buffer: Buffer.from('zip bytes') }]);
  const bar = page.locator('.tb');
  await expect(bar.locator('.tb-sub')).toContainText("This game is made with Ren'Py");
  // Карточка загрузки закрывается через 8 с — на её месте строка из списка сервера
  await page.waitForTimeout(9000);
  await expect(bar.locator('.tb-name')).toContainText('Visual');
  await expect(bar.locator('.tb-sub')).toContainText("This game is made with Ren'Py");

  await bar.locator('.tb-row').click();
  await page.locator('.tb.open .tb-text-btn').click();
  await expect(page.locator('.tb')).toHaveCount(0);
});
