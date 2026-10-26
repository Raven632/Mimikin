import { test as base, expect } from '@playwright/test';

// Учётная запись, которую тест first-run заводит на странице первого запуска
export const USER = { username: 'demo', password: 'demo-pass-123' };

// Каждый тест входит заново: выход и смена пароля в других тестах закрывают прежние сессии.
// Удачный вход ограничитель попыток не считает (api/src/routes/auth.js)
export const test = base.extend({
  page: async ({ page, context }, use) => {
    const res = await context.request.post('/api/login', { data: USER });
    expect(res.ok(), `вход ${USER.username}: ${res.status()}`).toBeTruthy();
    await use(page);
  },
});

export { expect };

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

// Окно игры по названию на карточке «Вся библиотека»
export async function openGame(page, title) {
  await page.locator('.library > .game-card').filter({ hasText: title }).first().click();
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

// Игры из API — проверить, что изменение дошло до сервера, а не только до экрана
export async function apiGames(page) {
  const res = await page.request.get('/api/games');
  expect(res.ok()).toBeTruthy();
  return res.json();
}
