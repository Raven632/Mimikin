import { test, expect, openLibrary, menu } from '../fixtures.js';

// «Место» на настоящем сервере с демо-библиотекой: размеры, статусы и что можно убрать
test('«Место»: полоса диска, что можно убрать — с причиной, все игры по размеру; строка открывает игру', async ({ page }) => {
  await openLibrary(page);
  await menu(page, 'Статистика');
  await page.locator('.library-tab', { hasText: 'Место' }).click();
  const panel = page.locator('.space-panel');
  await expect(panel.locator('.space-legend')).toContainText('Игры');
  await expect(panel.locator('.space-legend')).toContainText('Свободно');
  await expect(panel).toContainText('Удалённая игра 30 дней лежит в корзине и место не освобождает');
  const section = (title) => panel.locator('.stats-section', { hasText: title });
  await expect(section('Пройдены')).toContainText('2');
  await expect(section('Брошены')).toContainText('1');
  const all = section('Все игры по размеру');
  await expect(all).toBeVisible();
  // Самая большая игра демо-библиотеки — первой
  const first = panel.locator('.audit-list').last().locator('.audit-item').first();
  await expect(first).toContainText('Sky Knight Chronicles');
  await first.click();
  await expect(page.locator('#modal-title')).toHaveText('Sky Knight Chronicles');
});

test('«Место»: все прежние версии — одной кнопкой, с вопросом; и у игры, которой уже нет', async ({ page }) => {
  // В демо-библиотеке прежних версий нет — подставляем их в ответ сервера, удаление — ловим здесь
  const GB = 1073741824;
  await page.route('**/api/games/space*', async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    data.suggest.old = [{ id: 'Starfall_Inn', title: 'Starfall Inn', size: 2 * GB }, { id: 'Gone_Game', title: 'Gone Game', size: GB, gone: true }];
    await route.fulfill({ response: res, json: data });
  });
  const deleted = [];
  await page.route('**/api/games/*/old', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deleted.push(decodeURIComponent(route.request().url().split('/').at(-2)));
    return route.fulfill({ json: { success: true } });
  });
  await openLibrary(page);
  await menu(page, 'Статистика');
  await page.locator('.library-tab', { hasText: 'Место' }).click();
  const button = page.locator('.space-remove-all');
  await expect(button).toHaveText('Удалить все прежние версии (3.0 GB)');
  await button.click();
  await expect(page.locator('.confirm-title')).toHaveText('Удалить все прежние версии?');
  await expect(page.locator('.confirm-box')).toContainText('Игр с прежними версиями: 2');
  await page.locator('.confirm-cancel').click();
  expect(deleted).toEqual([]);
  await button.click();
  // После удаления «Место» пересчитывается — ждём и этот ответ: иначе тест кончался посреди него
  const recount = page.waitForResponse((r) => r.url().includes('/api/games/space?fresh=1'));
  await page.locator('.confirm-ok').click();
  await recount;
  expect(deleted).toEqual(['Starfall_Inn', 'Gone_Game']);
});
