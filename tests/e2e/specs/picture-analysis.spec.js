import { test, expect, openLibrary, menu } from '../fixtures.js';

// Разбор картинок: сервер отвечает подменой — настоящий в тестах выключен (compose.yml), модели не качаются
const mockStatus = async (page, status) => {
  // tagged — пункты картинок в меню: при выключенном разборе они есть, только если что-то уже разобрано
  await page.route(/\/api\/pictures\/status(\?peek=1(&tagged=1)?)?$/, (route) => route.fulfill({ json: { state: 'off', analysis: status.now, tagged: true } }));
};

test.describe('разбор картинок', () => {
  test('строка в «Настройках»: что делает, сколько качает, состояние и переключатель без перезапуска', async ({ page }) => {
    const status = { now: { on: true, state: 'analysing', frames: { done: 12, total: 40 } } };
    await mockStatus(page, status);
    const asked = [];
    await page.route(/\/api\/settings\/options$/, async (route) => {
      asked.push(route.request().postDataJSON());
      await route.fulfill({ json: { options: {} } });
    });
    await openLibrary(page);
    await menu(page, 'Настройки');
    const row = page.locator('[data-section="picture-analysis"]');
    await expect(row).toContainText('Разбор картинок');
    await expect(row).toContainText('около 740 МБ');
    await expect(row.getByRole('switch')).toBeChecked();
    await expect(row.locator('.set-status')).toHaveText('Разбираю кадры: 12 из 40.');

    // Выключить: сервер остановил очереди, строка говорит, что теперь
    status.now = { on: false, state: 'off' };
    await row.locator('.set-toggle').click();
    await expect(row.getByRole('switch')).not.toBeChecked();
    await expect(row.locator('.set-status')).toContainText('Выключено');
    expect(asked).toEqual([{ name: 'picture_analysis', value: false }]);

    // Включить: скачивание с ходом, потом разбор — сами, пока окно открыто
    status.now = { on: true, state: 'downloading', download: { done: 120000000, total: 740000000 } };
    await row.locator('.set-toggle').click();
    await expect(row.getByRole('switch')).toBeChecked();
    await expect(row.locator('.set-status')).toHaveText('Скачиваю модели: 120 из 740 МБ.');
    expect(asked.at(-1)).toEqual({ name: 'picture_analysis', value: true });
    status.now = { on: true, state: 'analysing', frames: { done: 0, total: 0 } };
    await expect(row.locator('.set-status')).toHaveText('Начинаю разбор.', { timeout: 10000 });
    status.now = { on: true, state: 'done' };
    await expect(row.locator('.set-status')).toHaveText('Готово: всё разобрано.', { timeout: 20000 });
    await expect(row.locator('.set-status')).toHaveClass(/ok/);
  });

  test('строка в «Настройках»: мало памяти, ошибка моделей, нет модуля', async ({ page }) => {
    const status = { now: { on: false, state: 'off', small: true } };
    await mockStatus(page, status);
    await openLibrary(page);
    await menu(page, 'Настройки');
    const row = page.locator('[data-section="picture-analysis"]');
    await expect(row.locator('.set-status')).toContainText('меньше 2 ГБ');
    await expect(row.getByRole('switch')).not.toBeChecked();
    await page.keyboard.press('Escape');

    status.now = { on: true, state: 'failed' };
    await menu(page, 'Настройки');
    await expect(row.locator('.set-status')).toContainText('не скачались');
    await page.keyboard.press('Escape');

    // Без модуля включать нечего — переключателя нет
    status.now = { on: false, state: 'unavailable' };
    await menu(page, 'Настройки');
    await expect(row.locator('.set-status')).toContainText('недоступен');
    await expect(row.getByRole('switch')).toHaveCount(0);
  });

  test('разбор выключен: лента и поиск говорят об этом и куда идти, а не «идёт сам»', async ({ page }) => {
    await mockStatus(page, { now: { on: false, state: 'off' } });
    let search = { status: 503, json: { error: 'unavailable', off: true } };
    await page.route(/\/api\/pictures\/search\?/, (route) => route.fulfill(search));
    await page.route(/\/api\/pictures\/feed$/, (route) => route.fulfill({ json: { games: [], off: true } }));
    await openLibrary(page);

    await menu(page, 'Лента картинок');
    await expect(page.locator('.feed .state-title')).toHaveText('Разбор картинок выключен');
    await expect(page.locator('.feed')).toContainText('«Разбор картинок»');
    await page.keyboard.press('Escape');

    // Модели слов нет и не будет: сразу говорим почему
    await menu(page, 'Поиск по картинкам');
    await page.locator('.pics-search input:not([type="file"])').first().fill('горничная');
    await expect(page.locator('.gallery .state-title')).toHaveText('Разбор картинок выключен');
    await expect(page.locator('.gallery')).toContainText('Настройки');

    // Модель есть, разобранных игр нет
    search = { json: { games: 0, results: [], more: false, off: true } };
    await page.locator('.pics-search input:not([type="file"])').first().fill('ванная');
    await expect(page.locator('.gallery .state-title')).toHaveText('Разбор картинок выключен');

    // Разобранные есть: ищем по ним и добавляем, что новых не будет
    search = { json: { games: 3, results: [], more: false, off: true } };
    await page.locator('.pics-search input:not([type="file"])').first().fill('лес');
    await expect(page.locator('.pics-covered')).toContainText('новые картинки в поиск не попадают');
  });

  test('разбор включён: подсказка без «откройте галерею»', async ({ page }) => {
    await mockStatus(page, { now: { on: true, state: 'done' } });
    await page.route(/\/api\/pictures\/search\?/, (route) => route.fulfill({ json: { games: 0, results: [], more: false } }));
    await openLibrary(page);
    await menu(page, 'Поиск по картинкам');
    await page.locator('.pics-search input:not([type="file"])').first().fill('горничная');
    await expect(page.locator('.gallery .state-title')).toHaveText('Галереи ещё не разобраны');
    await expect(page.locator('.gallery')).toContainText('когда сервер их разберёт');
  });
});
