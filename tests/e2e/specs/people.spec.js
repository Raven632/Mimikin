import { test, expect, openLibrary, menu, imagesLoaded, apiGames } from '../fixtures.js';

// Люди рядом с главным администратором: всё через настоящий интерфейс и настоящий сервер, без подмен нашего API.
// Главный администратор — демо-учётка из fixtures.js; людей он заводит сам в «Настройки → Пользователи»

async function openSettings(page, tab) {
  await menu(page, 'Настройки');
  await expect(page.locator('.settings-content')).toBeVisible();
  await page.locator('.settings-tab', { hasText: tab }).click();
}
const openPeople = (page) => openSettings(page, 'Пользователи');
const tile = (page, name) => page.locator('.people-tile[data-person]', { hasText: name });

async function addPerson(page, name, password) {
  await page.locator('.people-add').click();
  const form = page.locator('[data-section=people-add]');
  await form.locator('input[name=person-name]').fill(name);
  await form.locator('input[name=person-pass]').fill(password);
  await form.locator('.save-btn', { hasText: 'Добавить' }).click();
  await expect(page.locator('.toast')).toContainText(`${name} добавлен`);
  await expect(tile(page, name)).toContainText('ещё не выбрал свой пароль');
}

// Страница человека у главного администратора: плитка → вкладка
async function openPerson(page, name, tab = 'Профиль') {
  await tile(page, name).click();
  await page.locator('.person-tab', { hasText: tab }).click();
}

// Свой браузер человека: настройки проекта (адрес, язык, без анимаций) сами в новый контекст не попадают
const newBrowser = (browser, baseURL, extra = {}) => browser.newContext({ baseURL, locale: 'ru-RU', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 }, ...extra });

// Вход через форму. Запрос идёт настоящий: сервер решает, нужен ли новый пароль
async function signIn(page, name, password) {
  await page.goto('/');
  await expect(page.locator('#auth-title')).toHaveText('Вход в библиотеку');
  await page.locator('input[name=username]').fill(name);
  await page.locator('input[name=password]').fill(password);
  await page.locator('.auth-submit').click();
}

// Первый вход по временному паролю: форма выбора своего
async function chooseOwnPassword(page, temporary, own) {
  await expect(page.locator('#auth-title')).toHaveText('Выберите свой пароль');
  await expect(page.locator('input[name=username]')).toHaveCount(0);
  await page.locator('input[name=password]').fill(temporary);
  await page.locator('input[name=new-password]').fill(own);
  await page.locator('input[name=password2]').fill(own);
  await page.locator('.auth-submit').click();
  await expect(page.locator('.library > .game-card, .shelf-card').first()).toBeVisible();
}

// Игра, на которой тест оставил заметку владельца: чистим после теста, упал он или нет
let ownerNoteGame = null;

test.describe('люди', () => {
  test.afterEach(async ({ page }) => {
    if (!ownerNoteGame) return;
    await page.request.post(`/api/games/${encodeURIComponent(ownerNoteGame)}/meta`, { data: { notes: '' } }).catch(() => {});
    ownerNoteGame = null;
  });

  test('владелец заводит человека; тот выбирает пароль, видит библиотеку без владельческих кнопок, ведёт своё; владелец сбрасывает пароль — вход закрывается', async ({ page, browser, baseURL }, testInfo) => {
    // Повтор после сбоя идёт на той же базе, где Anna уже есть: имя другое, а проверки «людей ещё нет» пропускаются
    const ANNA = testInfo.retry ? `Anna${testInfo.retry}` : 'Anna';
    const first = testInfo.retry === 0;
    // Меню открывается с первой буквы имени: аватара ещё нет, и строка в меню говорит, кто вошёл
    await openLibrary(page);
    await expect(page.locator('.header-menu-btn .pmark-letter')).toHaveText('D');
    await expect(page.locator('.header-menu-btn .pmark-crown')).toHaveCount(0);
    await page.locator('.header-menu-btn').click();
    await expect(page.locator('.menu-person-name')).toHaveText('demo');
    await page.keyboard.press('Escape');
    await openPeople(page);
    const panel = page.locator('[data-section=people]');
    // Одна плитка — сам главный администратор, и пунктирная «Добавить»
    if (first) await expect(panel.locator('.people-tile')).toHaveCount(2);
    await panel.locator('.people-add').click();
    const form = page.locator('[data-section=people-add]');

    // Короткий пароль и пустое имя не проходят; имя главного администратора занято
    await form.locator('input[name=person-name]').fill(ANNA);
    await form.locator('input[name=person-pass]').fill('ab');
    await form.locator('.save-btn', { hasText: 'Добавить' }).click();
    await expect(form.locator('.auth-error')).toContainText('Не короче 4');
    await form.locator('input[name=person-name]').fill('DEMO');
    await form.locator('input[name=person-pass]').fill('temp-pass-1');
    await form.locator('.save-btn', { hasText: 'Добавить' }).click();
    await expect(form.locator('.auth-error')).toHaveText('Это имя занято');
    await form.locator('.people-back').click();
    await addPerson(page, ANNA, 'temp-pass-1');
    // Главный администратор — первой плиткой, с ролью
    await expect(panel.locator('.people-tile[data-person]').first()).toContainText('Главный администратор');
    // Второй человек в библиотеке: у главного администратора в меню появились знак, имя и роль
    await page.keyboard.press('Escape');
    await page.locator('.header-menu-btn').click();
    await expect(page.locator('.menu-person-name')).toHaveText('demo');
    await expect(page.locator('.menu-person-role')).toHaveText('Главный администратор');
    await page.keyboard.press('Escape');

    // Человек: свой браузер, вход по временному паролю
    const ctx = await newBrowser(browser, baseURL);
    const anna = await ctx.newPage();
    const refused = [];
    anna.on('response', (res) => { if (res.status() === 403 && res.url().includes('/api/')) refused.push(`${res.request().method()} ${new URL(res.url()).pathname}`); });
    await signIn(anna, ANNA, 'temp-pass-1');
    // Неверный временный пароль — ошибка, и форма остаётся
    await expect(anna.locator('#auth-title')).toHaveText('Выберите свой пароль');
    await anna.locator('input[name=password]').fill('wrong-temp');
    await anna.locator('input[name=new-password]').fill('anna-pass-2');
    await anna.locator('input[name=password2]').fill('anna-pass-2');
    await anna.locator('.auth-submit').click();
    await expect(anna.locator('.auth-error')).toHaveText('Прежний пароль неверный');
    await anna.locator('input[name=password]').fill('temp-pass-1');
    await anna.locator('input[name=password2]').fill('other');
    await anna.locator('.auth-submit').click();
    await expect(anna.locator('.auth-error')).toHaveText('Пароли не совпадают');
    await anna.locator('input[name=password2]').fill('anna-pass-2');
    await anna.locator('.auth-submit').click();
    await expect(anna.locator('.shelf-card').first()).toBeVisible();

    // Библиотека есть, кнопок владельца нет
    await expect(anna.locator('.upload-btn')).toHaveCount(0);
    await anna.locator('.header-menu-btn').click();
    await expect(anna.locator('.menu-person-name')).toHaveText(ANNA);
    await expect(anna.locator('.menu-person-role')).toHaveText('Пользователь');
    const items = await anna.locator('.header-menu-item').allTextContents();
    expect(items.join('|')).not.toMatch(/Добавить игру|Телефон/);
    expect(items.join('|')).toMatch(/Настройки/);
    await anna.keyboard.press('Escape');
    await anna.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(anna.locator('.library > .game-card').first()).toBeVisible();
    await imagesLoaded(anna);
    const card = anna.locator('.library > .game-card').first();
    const title = (await card.locator('.card-title').first().textContent()).trim();
    await card.locator('.card-title').first().click();
    await expect(anna.locator('#modal-title')).toHaveText(title);
    await expect(anna.locator('.act-edit')).toHaveCount(0);
    await anna.locator('.modal-more-btn').click();
    await expect(anna.locator('.modal-more-item').first()).toBeVisible();
    await expect(anna.locator('.modal-more-item.danger')).toHaveCount(0);
    expect((await anna.locator('.modal-more-item').allTextContents()).join('|')).not.toMatch(/Удалить|Скачать игру|Обновить|На полку/);
    await anna.keyboard.press('Escape');
    await expect(anna.locator('.modal-tab', { hasText: 'Перевод' })).toHaveCount(0);

    // Свои оценка и заметка: у человека — они, у владельца остаются прежние
    const id = (await apiGames(page)).find((g) => g.title === title || g.displayTitle === title)?.id;
    expect(id).toBeTruthy();
    const ownerBefore = (await apiGames(page)).find((g) => g.id === id);
    await anna.locator('.rating-star').nth(3).click();
    await anna.locator('.game-notes-add').click();
    await anna.locator('#game-notes-text').fill('заметка Анны');
    await anna.locator('#game-notes-text').blur();
    await expect.poll(async () => (await (await ctx.request.get('/api/games')).json()).find((g) => g.id === id)?.notes).toBe('заметка Анны');
    const annaGame = (await (await ctx.request.get('/api/games')).json()).find((g) => g.id === id);
    expect([annaGame.rating, annaGame.notes]).toEqual([4, 'заметка Анны']);
    const ownerAfter = (await apiGames(page)).find((g) => g.id === id);
    expect([ownerAfter.rating, ownerAfter.notes]).toEqual([ownerBefore.rating, ownerBefore.notes]);

    // И наоборот: владелец пишет своё, у человека своё остаётся. Заметка владельца могла остаться от упавшего
    // прогона — начинаем с чистой, а убирает её afterEach ниже (иначе она утекает в другие тесты и в повтор)
    ownerNoteGame = id;
    await page.request.post(`/api/games/${encodeURIComponent(id)}/meta`, { data: { notes: '' } });
    await page.reload();
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await page.locator('.library > .game-card').filter({ hasText: title }).first().locator('.card-title').click();
    await expect(page.locator('#game-notes-text')).toHaveCount(0);
    await page.locator('.game-notes-add').click();
    await page.locator('#game-notes-text').fill('заметка владельца');
    await page.locator('#game-notes-text').blur();
    await expect.poll(async () => (await apiGames(page)).find((g) => g.id === id)?.notes).toBe('заметка владельца');
    expect((await (await ctx.request.get('/api/games')).json()).find((g) => g.id === id).notes).toBe('заметка Анны');
    await page.keyboard.press('Escape');

    // Статистика у человека — без ревизии и места
    await anna.keyboard.press('Escape');
    await anna.locator('.header-menu-btn').click();
    await anna.locator('.header-menu-item', { hasText: 'Статистика' }).click();
    await expect(anna.locator('.stats-content')).toBeVisible();
    await expect(anna.locator('.library-tab')).toHaveCount(0);
    await anna.keyboard.press('Escape');

    // Настройки у человека: язык и пароль
    await menu(anna, 'Настройки');
    await expect(anna.locator('.settings-tab .settings-tab-name')).toHaveText(['Общие', 'Мой профиль']);
    await expect(anna.locator('.settings-panel .set-section')).toHaveCount(1);
    await expect(anna.locator('.set-choice-btn')).toHaveCount(3);
    await anna.locator('.set-choice-btn', { hasText: 'English' }).click();
    await expect(anna.locator('#settings-title')).toHaveText('Settings');
    await anna.locator('.set-choice-btn', { hasText: 'Русский' }).click();
    await anna.locator('.settings-tab', { hasText: 'Мой профиль' }).click();
    // Пароль для смены имени и три поля смены пароля
    await expect(anna.locator('.settings-panel input[type=password]')).toHaveCount(4);
    await expect(anna.locator('[data-section=people]')).toHaveCount(0);
    await anna.keyboard.press('Escape');

    // Вкладка «Найти» и галерея игры: то, что человеку открыто, не должно отвечать отказом
    await anna.locator('.nav-tab', { hasText: 'Найти' }).click();
    await expect(anna.locator('.nav-tab.active', { hasText: 'Найти' })).toBeVisible();
    await anna.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await anna.locator('.library > .game-card').filter({ hasText: title }).first().locator('.card-title').click();
    if (await anna.locator('.act-gallery').count()) {
      await anna.locator('.act-gallery').click();
      await expect(anna.locator('.gallery')).toBeVisible();
      await anna.keyboard.press('Escape');
    }
    await anna.keyboard.press('Escape');

    await anna.route(/\/api\/pictures\/status/, (route) => route.fulfill({ json: { state: 'off', analysis: { on: true, state: 'done' }, tagged: true, faved: true } }));
    // Остальное из меню: лента и поиск картинок, сцены, избранное, подбор. Отказы ловит общая проверка ниже
    for (const item of ['Во что поиграть?', 'Избранное', 'Лента картинок', 'Поиск по картинкам', 'Сцены']) {
      await anna.locator('.header-menu-btn').click();
      await anna.locator('.header-menu-item', { hasText: item }).click();
      await anna.waitForLoadState('networkidle').catch(() => {});
      await anna.waitForTimeout(500);
      await anna.keyboard.press('Escape');
    }
    // Перезагрузка возвращает на последний вид, здесь это библиотека
    await anna.goto('/');
    await expect(anna.locator('.library > .game-card').first()).toBeVisible();

    // Без привязанных источников раздела нет вовсе, строки «Не привязаны» у человека нет никогда
    await anna.locator('.library > .game-card').filter({ hasText: title }).first().locator('.card-title').click();
    await expect(anna.locator('.src-off')).toHaveCount(0);
    await anna.keyboard.press('Escape');

    // Ни одного отказа сервера за всё время: страница не стучится туда, куда человеку нельзя
    expect(refused).toEqual([]);

    // Владелец сбрасывает пароль: вкладка человека теряет вход сама
    await openPeople(page);
    await openPerson(page, ANNA, 'Вход');
    const row = page.locator('[data-section=reset]');
    await row.locator('input[type=password]').fill('ab');
    await row.locator('.save-btn').click();
    await expect(row.locator('.auth-error')).toContainText('Не короче 4');
    await row.locator('input[type=password]').fill('temp-pass-3');
    await row.locator('.save-btn').click();
    await expect(page.locator('.toast')).toContainText(`Пароль для ${ANNA} сброшен`);
    await page.locator('.people-back').click();
    await expect(tile(page, ANNA)).toContainText('ещё не выбрал свой пароль');
    await expect(anna.locator('#auth-title')).toHaveText('Вход в библиотеку');
    // Старый пароль не подходит, временный ведёт к выбору нового
    await anna.locator('input[name=username]').fill(ANNA);
    await anna.locator('input[name=password]').fill('anna-pass-2');
    await anna.locator('.auth-submit').click();
    await expect(anna.locator('.auth-error')).toHaveText('Неверный логин или пароль');
    await anna.locator('input[name=password]').fill('temp-pass-3');
    await anna.locator('.auth-submit').click();
    await chooseOwnPassword(anna, 'temp-pass-3', 'anna-pass-4');
    // Её оценка и заметка пережили сброс
    const back = (await (await ctx.request.get('/api/games')).json()).find((g) => g.id === id);
    expect([back.rating, back.notes]).toEqual([4, 'заметка Анны']);
    await ctx.close();
  });

  test('выход, когда в библиотеке есть другие люди: страница перезагружается, запомненный поиск не достаётся следующему', async ({ page }, testInfo) => {
    const CLARA = testInfo.retry ? `Clara${testInfo.retry}` : 'Clara';
    await page.request.post('/api/users', { data: { name: CLARA, password: 'temp-pass-1' } });
    await openLibrary(page);
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await page.locator('input[type=search], .search-box input').first().fill('zzz-ничего');
    await expect(page.locator('.library > .game-card')).toHaveCount(0);
    await page.locator('.header-menu-btn').click();
    await page.locator('.menu-logout').click();
    await page.locator('.confirm-ok').click();
    await expect(page.locator('#auth-title')).toHaveText('Вход в библиотеку');
    // Страница перезагружена: поиска нет, вид — главная (App записывает значения по умолчанию)
    expect(await page.evaluate(() => [sessionStorage.getItem('rpg_search'), sessionStorage.getItem('rpg_view')])).toEqual(['', 'home']);
    // Человек входит в том же браузере: поиск владельца ему не показывается
    await signIn(page, CLARA, 'temp-pass-1');
    await chooseOwnPassword(page, 'temp-pass-1', 'clara-pass-2');
    await expect(page.locator('.library > .game-card, .shelf-card').first()).toBeVisible();
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(page.locator('.library > .game-card').first()).toBeVisible();
  });
});

// Человек со своим паролем и открытым входом: создаём через API, чтобы тесту не нужен был экран первого входа
async function createPerson(page, browser, baseURL, name, password) {
  await page.request.post('/api/users', { data: { name, password: 'temp-pass-1' } });
  const ctx = await newBrowser(browser, baseURL);
  expect((await ctx.request.post('/api/login', { data: { username: name, password: 'temp-pass-1' } })).ok()).toBeTruthy();
  expect((await ctx.request.post('/api/account/password', { data: { current: 'temp-pass-1', next: password } })).ok()).toBeTruthy();
  return ctx;
}

// Настоящая картинка 1×1: страница вырежет из неё квадрат 256 на 256 и отправит JPEG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('профиль и пользователи', () => {
  test('человек меняет имя (с паролем) и ставит картинку: вторая вкладка и плитка главного администратора обновляются без перезагрузки', async ({ page, browser, baseURL }, testInfo) => {
    const VERA = testInfo.retry ? `Vera${testInfo.retry}` : 'Vera';
    const ctx = await createPerson(page, browser, baseURL, VERA, 'vera-pass-1');
    const one = await ctx.newPage();
    const two = await ctx.newPage();
    await one.goto('/');
    await expect(one.locator('.shelf-card').first()).toBeVisible();
    await two.goto('/');
    await expect(two.locator('.shelf-card').first()).toBeVisible();
    await openLibrary(page);
    await openPeople(page);
    await expect(tile(page, VERA)).toBeVisible();

    await openSettings(one, 'Мой профиль');
    const name = one.locator('[data-section=name]');
    // Без пароля и с чужим паролем имя не меняется
    await name.locator('input[name=profile-name]').fill(`${VERA} Q`);
    await name.locator('.save-btn').click();
    await expect(name.locator('.auth-error')).toHaveText('Введите пароль');
    await name.locator('input[name=profile-pass]').fill('wrong-pass');
    await name.locator('.save-btn').click();
    await expect(name.locator('.auth-error')).toHaveText('Пароль неверный');
    // Имя главного администратора занято, регистр не важен
    await name.locator('input[name=profile-name]').fill('DEMO');
    await name.locator('input[name=profile-pass]').fill('vera-pass-1');
    await name.locator('.save-btn').click();
    await expect(name.locator('.auth-error')).toHaveText('Это имя занято');
    await name.locator('input[name=profile-name]').fill(`${VERA} Q`);
    await name.locator('.save-btn').click();
    await expect(one.locator('.toast')).toContainText(`Имя теперь «${VERA} Q»`);
    // Другая вкладка человека и плитка у главного администратора — без перезагрузки
    await two.locator('.header-menu-btn').click();
    await expect(two.locator('.menu-person-name')).toHaveText(`${VERA} Q`);
    await two.keyboard.press('Escape');
    await expect(tile(page, `${VERA} Q`)).toBeVisible();
    // Прежнее имя не входит, новое входит
    const stranger = await newBrowser(browser, baseURL);
    expect((await stranger.request.post('/api/login', { data: { username: VERA, password: 'vera-pass-1' } })).status()).toBe(401);
    expect((await stranger.request.post('/api/login', { data: { username: 'vera q', password: 'vera-pass-1' } })).ok()).toBeTruthy();
    await stranger.close();

    // Картинка: не картинка — понятная ошибка; картинка — в профиле, в меню второй вкладки и на плитке
    const avatar = one.locator('[data-section=avatar]');
    await avatar.locator('input[type=file]').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('не картинка') });
    await expect(avatar.locator('.auth-error')).toContainText('Не удалось открыть эту картинку');
    await avatar.locator('input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await expect(one.locator('.toast')).toContainText('Аватар сохранён');
    await expect(avatar.locator('.pmark.pic img')).toBeVisible();
    expect(await avatar.locator('.pmark.pic img').evaluate((img) => img.complete && img.naturalWidth)).toBe(256);
    await two.locator('.header-menu-btn').click();
    await expect(two.locator('.menu-person .pmark.pic img')).toBeVisible();
    await two.keyboard.press('Escape');
    await expect(tile(page, `${VERA} Q`).locator('.pmark.pic img')).toBeVisible();
    const served = await page.request.get(await tile(page, `${VERA} Q`).locator('img').getAttribute('src'));
    expect(served.headers()['content-type']).toBe('image/jpeg');
    expect((await served.body()).subarray(0, 3).toString('hex')).toBe('ffd8ff');
    // Убрать — снова буква
    await avatar.locator('.meta-status-btn', { hasText: 'Убрать' }).click();
    await expect(one.locator('.toast')).toContainText('Аватар убран');
    await expect(avatar.locator('.pmark-letter')).toHaveText('V');
    await expect(tile(page, `${VERA} Q`).locator('.pmark-letter')).toHaveText('V');
    await ctx.close();
  });

  test('главный администратор переименовывает человека и закрывает ему вход: вкладка человека падает на вход, там причина на английском; открыл — вход работает', async ({ page, browser, baseURL }, testInfo) => {
    const GLEB = testInfo.retry ? `Gleb${testInfo.retry}` : 'Gleb';
    const ctx = await createPerson(page, browser, baseURL, GLEB, 'gleb-pass-1');
    const gleb = await ctx.newPage();
    await gleb.goto('/');
    await expect(gleb.locator('.shelf-card').first()).toBeVisible();
    await openLibrary(page);
    await page.locator('.header-menu-btn').click();
    await expect(page.locator('.menu-person-role.adm')).toHaveText('Главный администратор');
    await page.keyboard.press('Escape');

    await openPeople(page);
    await expect(page.locator('.people-tile[data-person]').first().locator('.pmark-crown')).toBeVisible();
    // Другому имя меняют без пароля; тост напоминает передать новое имя
    await openPerson(page, GLEB);
    const name = page.locator('[data-section=name]');
    await expect(name.locator('input[type=password]')).toHaveCount(0);
    await name.locator('input[name=profile-name]').fill(`${GLEB} Two`);
    await name.locator('.save-btn').click();
    await expect(page.locator('.toast')).toContainText('Передайте человеку новое имя');
    await expect(page.locator('.person-head .set-title')).toHaveText(`${GLEB} Two`);
    await gleb.locator('.header-menu-btn').click();
    await expect(gleb.locator('.menu-person-name')).toHaveText(`${GLEB} Two`);
    await gleb.keyboard.press('Escape');

    // Закрыть вход
    await page.locator('.person-tab', { hasText: 'Вход' }).click();
    await page.locator('[data-section=lock] .meta-status-btn').click();
    await expect(page.locator('.toast')).toContainText(`Вход для ${GLEB} Two закрыт`);
    await expect(gleb.locator('#auth-title')).toBeVisible();
    await page.locator('.people-back').click();
    await expect(tile(page, `${GLEB} Two`)).toHaveClass(/off/);
    await expect(tile(page, `${GLEB} Two`)).toContainText('вход закрыт');
    // В английском интерфейсе — причина по-английски; неверный пароль о закрытом входе не говорит
    await gleb.locator('.auth-lang', { hasText: 'EN' }).click();
    await gleb.locator('input[name=username]').fill(`${GLEB} Two`);
    await gleb.locator('input[name=password]').fill('wrong-pass');
    await gleb.locator('.auth-submit').click();
    await expect(gleb.locator('.auth-error')).toHaveText('Wrong username or password');
    await gleb.locator('input[name=password]').fill('gleb-pass-1');
    await gleb.locator('.auth-submit').click();
    await expect(gleb.locator('.auth-error')).toHaveText('Sign-in for this account is closed. Ask the main administrator');

    // Открыть вход: прежний пароль работает
    await tile(page, `${GLEB} Two`).click();
    await page.locator('.person-tab', { hasText: 'Вход' }).click();
    await page.locator('[data-section=lock] .meta-status-btn', { hasText: 'Открыть вход' }).click();
    await expect(page.locator('.toast')).toContainText(`Вход для ${GLEB} Two открыт`);
    await gleb.locator('.auth-submit').click();
    await expect(gleb.locator('.shelf-card').first()).toBeVisible();
    await ctx.close();
  });

  test('удалить человека и вернуть: из списка он уходит, имя занято, сейвы и заметки на месте', async ({ page, browser, baseURL }, testInfo) => {
    const HANA = testInfo.retry ? `Hana${testInfo.retry}` : 'Hana';
    const ctx = await createPerson(page, browser, baseURL, HANA, 'hana-pass-1');
    const id = (await apiGames(page))[0].id;
    expect((await ctx.request.post(`/api/games/${encodeURIComponent(id)}/meta`, { data: { notes: 'заметка Ханы' } })).ok()).toBeTruthy();
    await openLibrary(page);
    await openPeople(page);
    await openPerson(page, HANA, 'Вход');
    await page.locator('[data-section=remove] .meta-status-btn').click();
    // Вопрос с пояснением; отмена ничего не делает
    await expect(page.locator('.confirm-title')).toHaveText(`Удалить ${HANA}?`);
    await page.locator('.confirm-cancel').click();
    await expect(page.locator('.person-page')).toBeVisible();
    await page.locator('[data-section=remove] .meta-status-btn').click();
    await page.locator('.confirm-ok').click();
    await expect(page.locator('.toast')).toContainText(`${HANA} удалён из списка`);
    await expect(tile(page, HANA)).toHaveCount(0);
    const removed = page.locator('[data-section=removed]');
    await expect(removed).toContainText(HANA);
    // Войти она не может, имя за ней занято
    expect((await ctx.request.get('/api/games')).status()).toBe(401);
    await page.locator('.people-add').click();
    const form = page.locator('[data-section=people-add]');
    await form.locator('input[name=person-name]').fill('hana');
    await form.locator('input[name=person-pass]').fill('temp-pass-1');
    await form.locator('.save-btn').click();
    await expect(form.locator('.auth-error')).toContainText('за удалённым человеком');
    await form.locator('.people-back').click();
    // Вернуть: прежний пароль и заметка на месте
    await removed.locator('.meta-status-btn', { hasText: 'Вернуть' }).click();
    await expect(tile(page, HANA)).toBeVisible();
    await expect(page.locator('[data-section=removed]')).toHaveCount(0);
    const again = await newBrowser(browser, baseURL);
    expect((await again.request.post('/api/login', { data: { username: HANA, password: 'hana-pass-1' } })).ok()).toBeTruthy();
    expect((await (await again.request.get('/api/games')).json()).find((g) => g.id === id).notes).toBe('заметка Ханы');
    await again.close();
    await ctx.close();
  });

  test('главный администратор: его плитка ведёт в «Мой профиль»; имя меняется с паролем, логин после этого другой, вход остаётся', async ({ page, browser, baseURL }) => {
    await openLibrary(page);
    await openPeople(page);
    await page.locator('.people-tile[data-person]').first().click();
    await expect(page.locator('.settings-tab.active', { hasText: 'Мой профиль' })).toBeVisible();
    try {
      const name = page.locator('[data-section=name]');
      await name.locator('input[name=profile-name]').fill('Хозяин');
      await name.locator('input[name=profile-pass]').fill('demo-pass-123');
      await name.locator('.save-btn').click();
      await expect(page.locator('.toast')).toContainText('Имя теперь «Хозяин»');
      // Вход на этом устройстве остался; в меню — новое имя
      expect((await page.request.get('/api/games')).ok()).toBeTruthy();
      await page.keyboard.press('Escape');
      await page.locator('.header-menu-btn').click();
      await expect(page.locator('.menu-person-name')).toHaveText('Хозяин');
      await page.keyboard.press('Escape');
      // Новое имя входит (регистр не важен), старое — нет.
      const other = await newBrowser(browser, baseURL);
      expect((await other.request.post('/api/login', { data: { username: 'demo', password: 'demo-pass-123' } })).status()).toBe(401);
      expect((await other.request.post('/api/login', { data: { username: 'хозяин', password: 'demo-pass-123' } })).ok()).toBeTruthy();
      await other.close();
    } finally {
      // Имя возвращаем всегда: остальным тестам нужен USER
      await page.request.post('/api/account/name', { data: { name: 'demo', password: 'demo-pass-123' } });
    }
  });

  test('владелец оставляет человеку часть игр: он видит только их, закрытая по прямому адресу молчит, вернули — игра и заметка на месте', async ({ page, browser, baseURL }, testInfo) => {
    const BORIS = testInfo.retry ? `Boris${testInfo.retry}` : 'Boris';
    await openLibrary(page);
    await openPeople(page);
    await addPerson(page, BORIS, 'temp-pass-1');

    const ctx = await newBrowser(browser, baseURL);
    const boris = await ctx.newPage();
    await signIn(boris, BORIS, 'temp-pass-1');
    await chooseOwnPassword(boris, 'temp-pass-1', 'boris-pass-2');
    const all = await (await ctx.request.get('/api/games')).json();
    expect(all.length).toBeGreaterThan(2);
    const cards = boris.locator('.library > .game-card');
    const shelf = () => boris.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await shelf();
    await expect(cards).toHaveCount(all.length);

    // Своя заметка на игре, которую потом закроют: она должна пережить и закрытие, и возврат
    await cards.filter({ hasText: 'Ember & Frost' }).first().locator('.card-title').click();
    await boris.locator('.game-notes-add').click();
    await boris.locator('#game-notes-text').fill('заметка Бориса');
    await boris.locator('#game-notes-text').blur();
    await expect.poll(async () => (await (await ctx.request.get('/api/games')).json()).find((g) => g.id === 'Ember_and_Frost')?.notes).toBe('заметка Бориса');
    await boris.keyboard.press('Escape');

    // Страница человека → «Игры»: по умолчанию все, переключатель включён
    await openPerson(page, BORIS, 'Игры');
    const sect = page.locator('[data-section=games]');
    const toggle = sect.locator('.set-toggle input');
    await expect(toggle).toBeChecked();
    await expect(sect.locator('.games-covers')).toHaveCount(0);
    await toggle.click();
    await expect(sect.locator('.set-hint').first()).toContainText('Новые игры сами у него не появляются');
    await expect(sect.locator('.games-cover')).toHaveCount(all.length);
    await expect(sect.locator('.games-chip', { hasText: `Все ${all.length}` })).toBeVisible();
    // Отметка с клавиатуры: фокус на отметке и пробел
    await sect.locator('[data-game=Starfall_Inn]').focus();
    await page.keyboard.press('Space');
    await expect(sect.locator('.games-chip', { hasText: 'Выбрано 1' })).toBeVisible();
    await page.screenshot({ path: 'e2e/report/people-games-desktop.png' });
    await sect.locator('.save-btn').click();
    await expect(page.locator('.toast')).toContainText(`Список игр для ${BORIS} сохранён`);
    await expect(sect.locator('.save-btn')).toBeDisabled();

    // У человека — только отмеченная игра, закрытой нет ни в списке, ни по прямому адресу
    await boris.reload();
    await shelf();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Starfall Inn');
    expect((await (await ctx.request.get('/api/games')).json()).map((g) => g.id)).toEqual(['Starfall_Inn']);
    await boris.goto('/?play=Ember_and_Frost');
    await shelf();
    await expect(cards).toHaveCount(1);
    await boris.waitForTimeout(800);
    await expect(boris.locator('.game-frame')).toHaveCount(0);
    await expect(boris.locator('#modal-title')).toHaveCount(0);
    // Закрытая игра отвечает так же, как несуществующая
    const closed = await ctx.request.get('/api/marks/Ember_and_Frost');
    const missing = await ctx.request.get('/api/marks/No_Such_Game');
    expect(closed.status()).toBe(404);
    expect([closed.status(), await closed.text()]).toEqual([missing.status(), await missing.text()]);
    expect((await ctx.request.get('/api/games/Ember_and_Frost/saves')).status()).toBe((await ctx.request.get('/api/games/No_Such_Game/saves')).status());

    // Снять все отметки: человек видит пустую библиотеку, а не приглашение владельца добавить игру
    await sect.locator('[data-game=Starfall_Inn]').uncheck();
    await expect(sect.locator('.games-warn')).toContainText('пустую библиотеку');
    await sect.locator('.save-btn').click();
    await expect(page.locator('.toast').last()).toContainText('сохранён');
    await boris.goto('/');
    await expect(boris.locator('.state-title')).toHaveText('Для вас пока нет игр');
    await expect(boris.locator('.welcome-drop, .upload-btn')).toHaveCount(0);

    // Вернули обе: мышью по обложке. Игра на месте, и заметка Бориса на месте
    await sect.locator('.games-cover', { hasText: 'Starfall Inn' }).click();
    await sect.locator('.games-cover', { hasText: 'Ember & Frost' }).click();
    await sect.locator('.save-btn').click();
    await expect.poll(async () => (await (await ctx.request.get('/api/games')).json()).map((g) => g.id).sort()).toEqual(['Ember_and_Frost', 'Starfall_Inn']);
    await boris.reload();
    await shelf();
    await expect(cards).toHaveCount(2);
    await cards.filter({ hasText: 'Ember & Frost' }).first().locator('.card-title').click();
    await expect(boris.locator('#game-notes-text')).toHaveValue('заметка Бориса');

    // Телефон: две обложки в ряд, ничего не вылезает за экран
    await page.setViewportSize({ width: 390, height: 844 });
    await sect.locator('.games-cover').first().scrollIntoViewIfNeeded();
    expect(await page.locator('.settings-content').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const [c1, c2, c3] = await Promise.all([0, 1, 2].map((i) => sect.locator('.games-cover').nth(i).boundingBox()));
    expect(Math.abs(c1.y - c2.y)).toBeLessThan(2);
    expect(c3.y).toBeGreaterThan(c1.y + 40);
    expect(c2.x + c2.width).toBeLessThanOrEqual(390);
    await page.locator('.people-back').evaluate((el) => el.scrollIntoView());
    await page.screenshot({ path: 'e2e/report/people-games-phone.png' });
    await ctx.close();
  });
});

test.describe('люди на телефоне', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('«Пользователи», «Мой профиль» и форма выбора пароля умещаются в ширину экрана; плитки в два столбца; картинку можно выбрать', async ({ page, browser, baseURL }, testInfo) => {
    const DINA = testInfo.retry ? `Dina${testInfo.retry}` : 'Dina';
    await page.request.post('/api/users', { data: { name: DINA, password: 'temp-pass-1' } });
    await openLibrary(page);
    await openPeople(page);
    const panel = page.locator('[data-section=people]');
    await expect(tile(page, DINA)).toBeVisible();
    const fits = async (loc) => { const b = await loc.boundingBox(); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(390); };
    const noOverflow = async () => expect(await page.locator('.settings-content').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    // Два столбца: первые две плитки в одном ряду, третья ниже
    const [a, b, c] = await Promise.all([0, 1, 2].map((i) => panel.locator('.people-tile').nth(i).boundingBox()));
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(b.x).toBeGreaterThan(a.x + 100);
    expect(c.y).toBeGreaterThan(a.y + 100);
    await noOverflow();
    await openPerson(page, DINA, 'Вход');
    await expect(page.locator('[data-section=reset] input')).toBeVisible();
    await noOverflow();
    await fits(page.locator('[data-section=reset] input'));
    await fits(page.locator('[data-section=lock] .meta-status-btn'));
    await page.locator('.person-tab', { hasText: 'Профиль' }).click();
    await fits(page.locator('[data-section=name] input[name=profile-name]'));
    await noOverflow();
    await page.locator('.people-back').click();
    await panel.locator('.people-add').click();
    const add = page.locator('[data-section=people-add]');
    await fits(add.locator('input[name=person-name]'));
    await fits(add.locator('.save-btn', { hasText: 'Добавить' }));
    await add.locator('.people-back').click();
    // Свой профиль на телефоне: выбор файла работает
    await page.locator('.settings-tab', { hasText: 'Мой профиль' }).tap();
    const avatar = page.locator('[data-section=avatar]');
    await expect(avatar.locator('input[type=file]')).toHaveAttribute('accept', 'image/*');
    await avatar.locator('input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.locator('.toast')).toContainText('Аватар сохранён');
    await expect(avatar.locator('.pmark.pic img')).toBeVisible();
    await noOverflow();
    await avatar.locator('.meta-status-btn', { hasText: 'Убрать' }).tap();
    await expect(page.locator('.toast')).toContainText('Аватар убран');

    const ctx = await newBrowser(browser, baseURL, { viewport: { width: 390, height: 844 }, hasTouch: true });
    const dina = await ctx.newPage();
    await signIn(dina, DINA, 'temp-pass-1');
    await expect(dina.locator('#auth-title')).toHaveText('Выберите свой пароль');
    await fits(dina.locator('.auth-card'));
    await fits(dina.locator('.auth-submit'));
    expect(await dina.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await chooseOwnPassword(dina, 'temp-pass-1', 'dina-pass-2');
    // Меню человека на телефоне: знак, имя и роль первой строкой, кнопки добавления игр нет
    await dina.locator('.header-menu-btn').click();
    await expect(dina.locator('.menu-person-name')).toHaveText(DINA);
    await expect(dina.locator('.header-menu-item', { hasText: 'Добавить игру' })).toHaveCount(0);
    await fits(dina.locator('.menu-person'));
    await ctx.close();
  });
});
