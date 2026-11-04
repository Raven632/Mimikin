import { test, expect, openLibrary, openGame, apiGames, emptyTrash } from '../fixtures.js';

// «На полку»: файлы игры — в корзину, карточка, сейвы и время — в библиотеке (services/trash.js). Вернуть — из окна игры
const TITLE = "Wanderer's Almanac";
const ID = 'Wanderers_Almanac';
const card = (page) => page.locator('.library > .game-card', { hasText: TITLE });
const shelfOf = async (page) => (await apiGames(page)).find((g) => g.id === ID).shelf;

async function shelve(page) {
  await openGame(page, TITLE);
  await page.locator('.modal-more-btn').click();
  await page.locator('.modal-more-item', { hasText: 'Убрать на полку' }).click();
  await expect(page.locator('.confirm-title')).toHaveText('Убрать игру на полку?');
  await expect(page.locator('.confirm-text')).toContainText('Карточка, сейвы, моменты и наигранное время останутся');
  await page.locator('.confirm-ok').click();
  await expect(page.locator('.toast.show')).toContainText('Игра на полке');
}

// Файлов в корзине уже нет (прошли 30 дней или стёрли руками): так их видит окно
async function filesGone(page) {
  await page.route(/\/api\/games$/, async (route) => {
    const list = await (await route.fetch()).json();
    return route.fulfill({ json: list.map((g) => (g.id === ID ? { ...g, shelf: { at: Date.now() - 40 * 864e5, key: '', until: 0 } } : g)) });
  });
}

// Страница заново — со своим списком игр (route): открывается там же, где была, — в библиотеке
async function reloadLibrary(page) {
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await expect(page.locator('.library > .game-card').first()).toBeVisible();
}

test.describe('на полке', () => {
  // Игра, оставшаяся на полке после сбоя, не давала повтору её убрать; начинаем с вернувшейся
  test.beforeEach(async ({ page }) => { await emptyTrash(page); });

  test('на полку из окна игры: окно показывает, как вернуть; карточка серая с пометкой и своим чипом; «Вернуть» — снова «Играть»', async ({ page }) => {
    await openLibrary(page);
    await shelve(page);
    const modal = page.locator('.modal-content');
    await expect(modal.locator('.shelf-note')).toContainText('Сейвы, моменты и наигранное время на месте');
    await expect(modal.locator('.shelf-note')).toContainText('Файлы ещё 30 дн. в корзине');
    await expect(modal.locator('#modal-play-btn')).toHaveText('Вернуть');
    // В «⋯» — только то, чему файлы не нужны: сейвы и удаление, одной чертой между ними
    await modal.locator('.modal-more-btn').click();
    await expect(modal.locator('.modal-more-list > *')).toHaveText(['Скачать сейвы', 'Загрузить сейвы из файла', '', 'Добавить в серию', 'Удалить игру']);
    await modal.locator('.modal-more-btn').click();
    // Без файлов нет ни галереи, ни перевода, ни «Играть с этого момента»
    await expect(modal.locator('.act-gallery')).toHaveCount(0);
    await expect(modal.locator('.modal-tab', { hasText: 'Перевод' })).toHaveCount(0);
    expect((await shelfOf(page)).key).toMatch(/^\d{13}-Wanderers_Almanac$/);

    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveClass(/shelved/);
    await expect(card(page).locator('.card-shelf')).toHaveText('На полке');
    await expect(card(page).locator('.card-play')).toHaveCount(0);
    await page.locator('.status-chips .chip-shelf').click();
    await expect(page.locator('.library > .game-card')).toHaveCount(1);
    await expect(page.locator('.status-chips .chip-shelf .chip-count')).toHaveText('1');

    await openGame(page, TITLE);
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.toast.show')).toContainText('Игра снова на месте');
    await expect(page.locator('#modal-play-btn')).toHaveText('Играть');
    await expect(page.locator('.modal-content .act-gallery')).toBeVisible();
    expect(await shelfOf(page)).toBeNull();
  });

  test('«Отменить» в тосте возвращает файлы сразу; на главной игры с полки нет', async ({ page }) => {
    await openLibrary(page);
    await shelve(page);
    await page.keyboard.press('Escape');
    await page.locator('.nav-tab', { hasText: 'Главная' }).click();
    await expect(page.locator('.shelf-card').first()).toBeVisible();
    await page.locator('.shelf-tab', { hasText: 'Добавленные' }).click();
    await expect(page.locator('.shelf-card', { hasText: TITLE })).toHaveCount(0);
    await page.locator('.toast.show .toast-action').click();
    await expect(page.locator('.toast.show')).toContainText('Игра снова на месте');
    await expect(page.locator('.shelf-card', { hasText: TITLE })).toBeVisible();
    expect(await shelfOf(page)).toBeNull();
  });

  test('файлов уже нет: остаётся свой архив — загрузка идёт этой игре, а не новой', async ({ page }) => {
    await openLibrary(page);
    await shelve(page);
    await page.keyboard.press('Escape');

    await filesGone(page);
    const starts = [];
    await page.route(/\/api\/games\/upload\/start$/, (route) => { starts.push(route.request().postDataJSON()); return route.fulfill({ status: 400, json: { error: 'стоп' } }); });
    await reloadLibrary(page);
    await openGame(page, TITLE);
    const modal = page.locator('.modal-content');
    await expect(modal.locator('.shelf-note')).toContainText('Файлов больше нет');
    await expect(modal.locator('#modal-play-btn')).toHaveText('Поставить новую версию');
    const chooser = page.waitForEvent('filechooser');
    await modal.locator('#modal-play-btn').click();
    await (await chooser).setFiles({ name: 'Wanderers_Almanac_v0.9.zip', mimeType: 'application/zip', buffer: Buffer.from('zip') });
    await expect.poll(() => starts.map((s) => s.target)).toEqual([ID]);

    // Вернуть файлы на место — следующий тест видит игру как была
    await page.unroute(/\/api\/games$/);
    const key = (await shelfOf(page)).key;
    expect((await page.request.post(`/api/games/trash/${key}/restore`)).ok()).toBeTruthy();
  });

  test('загрузили как новую, а это игра с полки: тост, вопрос в окне; «нет» — вопрос уходит, «это она» — окно на той игре', async ({ page }) => {
    // «Новая» — другая демо-игра: сервер видел бы совпадение по названию или теме (api/http.test.js), здесь — его ответ
    const NEW = 'Clockwork_Vale';
    let answered = null;
    await page.route(/\/api\/games$/, async (route) => {
      const list = await (await route.fetch()).json();
      return route.fulfill({ json: list.map((g) => (g.id === NEW && !answered ? { ...g, shelfMatch: { id: ID, title: TITLE, playtime: 5400, why: ['name'] } } : g)) });
    });
    const asked = [];
    await page.route(/\/api\/games\/Clockwork_Vale\/shelf-match$/, (route) => {
      answered = route.request().postDataJSON();
      asked.push(answered);
      return route.fulfill({ json: { success: true, ...(answered.accept ? { id: ID } : {}) } });
    });
    await openLibrary(page);
    await expect(page.locator('.toast.show')).toContainText(`Похоже, это «${TITLE}» с полки`);
    await page.locator('.toast.show .toast-action').click();
    const modal = page.locator('.modal-content');
    await expect(modal.locator('#modal-title')).toHaveText('Clockwork Vale');
    const block = modal.locator('.shelf-match');
    await expect(block).toContainText('Совпало: название');
    await expect(block).toContainText('(1 ч 30 мин)');
    await block.locator('button', { hasText: 'Нет, это другая' }).click();
    await expect(block).toHaveCount(0);
    expect(asked).toEqual([{ into: ID, accept: false }]);

    answered = null;
    await page.keyboard.press('Escape');
    await reloadLibrary(page);
    await openGame(page, 'Clockwork Vale');
    await modal.locator('.shelf-match button', { hasText: 'Это она' }).click();
    await expect(page.locator('.toast.show')).toContainText('Сейвы и время на месте');
    await expect(modal.locator('#modal-title')).toHaveText(TITLE);
    expect(asked.at(-1)).toEqual({ into: ID, accept: true });
  });
});
