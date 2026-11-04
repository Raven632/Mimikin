import { test as base, expect } from '@playwright/test';

// Учётная запись, которую тест first-run заводит на странице первого запуска
export const USER = { username: 'demo', password: 'demo-pass-123' };

// Каждый тест входит заново: выход и смена пароля в других тестах закрывают прежние сессии.
// Удачный вход ограничитель попыток не считает (api/src/routes/auth.js)
export const test = base.extend({
  page: async ({ page, context }, use) => {
    const res = await context.request.post('/api/login', { data: USER });
    expect(res.ok(), `вход ${USER.username}: ${res.status()}`).toBeTruthy();
    // Сервер тестов без сети (OFFLINE): вкладка «Найти» честно сказала бы, что есть только «Отложенные». Выдача itch.io в тестах
    // подставляется, поэтому по умолчанию считаем, что сеть есть; тест про её отсутствие подставляет свой ответ
    await page.route(/\/api\/recommend\/modes/, (route) => route.fulfill({ json: ONLINE_MODES }));
    await use(page);
  },
});

export { expect };

// Ответ /api/recommend/modes, когда сеть есть, а вкус известен (services/recommend.js)
export const ONLINE_MODES = {
  offline: false, taste: { stage: 'known', games: 16 }, modes: ['sites', 'list'],
};

// Обложки на экране загружены (или упали). Первые обложки после запуска сервера делает ffmpeg по три за раз, и они
// занимают все 6 соединений браузера: выход (auth.spec) ждал дольше 7 с, а снимок выходил раньше обложек.
// Ленивые картинки ниже экрана не грузятся вовсе — их не ждём
export async function imagesLoaded(page, timeout = 10000) {
  await page.waitForFunction(() => [...document.images].every((img) => {
    const r = img.getBoundingClientRect();
    const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    return !onScreen || img.complete;
  }), null, { timeout }).catch(() => {});
}

// Главная: «Продолжить» и полки
export async function openHome(page) {
  await page.goto('/');
  await expect(page.locator('.shelf-card').first()).toBeVisible();
}

// Вкладка «Библиотека»: все игры сеткой, поиск и фильтры
export async function openLibrary(page) {
  await openHome(page);
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await expect(page.locator('.library > .game-card').first()).toBeVisible();
  await imagesLoaded(page);
}

// Ряд «Вид» и ряд «Фильтры» открываются кнопкой и помнятся на устройстве; тест не гадает, а доводит до нужного
export async function openViewRow(page) {
  const btn = page.locator('.look-btn[aria-expanded]');
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
  await expect(page.locator('.look-row')).toBeVisible();
}
export async function openFilters(page) {
  const btn = page.locator('.controls-zone .filters-toggle');
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
  await expect(page.locator('.toolbar-filters')).toBeVisible();
}

// «Найти → itch.io»: списки фильтров лежат под кнопкой «Фильтры» на любой ширине. Открыто — не нажимаем: состояние помнится
export async function openSiteFilters(scope) {
  const btn = scope.locator('.catalog-filters .filters-toggle');
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
  await expect(scope.locator('.catalog-filter-list.open')).toBeVisible();
}

// Окно игры по названию на карточке «Вся библиотека»
export async function openGame(page, title) {
  // По названию, а не в середину карточки: там, смотря по её высоте, может оказаться круглая «Играть»
  await page.locator('.library > .game-card').filter({ hasText: title }).first().locator('.card-title').click();
  await expect(page.locator('.modal-content')).toBeVisible();
  await expect(page.locator('#modal-title')).toHaveText(title);
}

// Вкладка окна игры («Обзор», «Сведения», «Прохождения», «Перевод»)
export async function openTab(page, label) {
  await page.locator('.modal-content .modal-tab', { hasText: label }).click();
  await expect(page.locator('.modal-content .modal-tab.active')).toContainText(label);
}

// Пункт меню «⋯»
export async function menu(page, item) {
  await page.locator('.header-menu-btn').click();
  await page.locator('.header-menu-item', { hasText: item }).click();
}

// «Сегодня» для снимков экрана: демо-библиотека с VISUAL=1 считает даты игр от него (run.sh), браузер —
// тоже. Иначе «добавлена 1 октября» назавтра становится «2 октября», и эталон не сходится
export const DEMO_NOW = new Date('2026-10-03T12:00:00Z');

// Главную не питает ничто из сети: в этой сборке подбор с сайтов не живёт, и ряд внизу главной от прогона к прогону не меняется.
// Функция осталась, чтобы спецификации звали её, как и раньше, и не знали об этом
export async function noHot() {}

// Вкладка «Найти», выдача itch.io
export async function openSites(page) {
  await page.locator('.nav-tab', { hasText: 'Найти' }).click();
  await page.locator('.catalog-sources .chip', { hasText: 'itch.io' }).click();
}

// Игры из API — проверить, что изменение дошло до сервера, а не только до экрана
export async function apiGames(page) {
  const res = await page.request.get('/api/games');
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// Всё, что лежит в корзине или на полке, возвращаем в библиотеку. Тесты корзины, полки и копий убирают игру и
// возвращают её в конце; упавший посреди теста оставлял её там, и повтор (и «Корзина пуста» дальше) падал.
// Вызываем в начале таких тестов, чтобы они шли с чистого места
export async function emptyTrash(page) {
  const res = await page.request.get('/api/games/trash');
  expect(res.ok()).toBeTruthy();
  for (const item of (await res.json()).items || []) {
    if (item.vanished) continue;
    await page.request.post(`/api/games/trash/${encodeURIComponent(item.key)}/restore`);
  }
}
