import { test, expect, imagesLoaded, openHome, openLibrary, openGame, menu, DEMO_NOW } from '../fixtures.js';

// Снимки экранов до и после переделки стилей (запуск — playwright.config.js, VISUAL=1). Каждый снимок
// сравнивается с эталоном попиксельно: стили переложили — внешний вид не должен измениться.
// Допуск на цвет — 0,025 вместо 0,2 по умолчанию: с 0,2 Playwright не заметил бы, например, рамку чуть
// другой прозрачности. Совсем без допуска нельзя: скруглённые углы обложек и размытые тени браузер
// от раза к разу рисует на 1–5 единиц яркости по-разному. 0,025 пропускает такие 5 единиц, а 7 и больше
// уже ловит
const shot = (page, name) => expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0, threshold: 0.025 });
// Перед снимком — пока доиграют переходы и раскодируются все картинки: уменьшенную обложку браузер
// сначала рисует быстро и грубо, потом начисто, и скруглённые углы обложек выходили то так, то этак
// Ленивые картинки ниже экрана не грузятся вовсе — их не ждём
const settle = async (page) => {
  await imagesLoaded(page);
  await page.waitForTimeout(350);
  await page.evaluate(() => Promise.race([
    Promise.all([...document.images].filter((img) => img.complete && img.naturalWidth).map((img) => img.decode().catch(() => {}))),
    new Promise((done) => setTimeout(done, 2000)),
  ]));
  await page.waitForTimeout(150);
};

// Живые цифры сервера (место на диске) меняются от прогона к прогону — в снимках они постоянные
test.beforeEach(async ({ page }) => {
  await page.route('**/api/storage**', (route) => route.fulfill({ json: { used: 10307921510, free: 25769803776 } }));
  await page.clock.setFixedTime(DEMO_NOW);
});

test.describe.configure({ mode: 'serial' });

test.describe('компьютер', () => {
  test('главная, меню, библиотека, сетка, списки', async ({ page }) => {
    await openHome(page); await settle(page);
    await shot(page, 'd-home');
    await page.locator('.header-menu-btn').click(); await settle(page);
    await shot(page, 'd-menu');
    await page.keyboard.press('Escape');
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(page.locator('.library > .game-card').first()).toBeVisible(); await settle(page);
    await shot(page, 'd-library');
    await page.locator('.controls-zone .picker-btn').first().click(); await settle(page);
    await shot(page, 'd-genres');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.scrollTo(0, 600)); await settle(page);
    await shot(page, 'd-grid');
    await page.locator('.library > .game-card').first().hover(); await settle(page);
    await shot(page, 'd-card-hover');
  });

  test('окно игры, просмотрщик, меню «ещё», вопрос об удалении', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn'); await settle(page);
    await shot(page, 'd-game');
    await page.locator('.screen-thumb').first().click(); await settle(page);
    await shot(page, 'd-lightbox');
    await page.keyboard.press('Escape');
    await page.locator('.modal-more-btn').click(); await settle(page);
    await shot(page, 'd-game-more');
    await page.locator('.modal-more-item.danger', { hasText: 'Удалить' }).click(); await settle(page);
    await shot(page, 'd-confirm');
    await page.locator('.confirm-cancel').click();
  });

  test('правка сведений: форма, новая обложка, вопрос перед потерей правок', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Изменить' }).click(); await settle(page);
    await shot(page, 'd-edit');
    await page.locator('.edit-add input').fill('https://store.steampowered.com/app/100');
    await page.locator('.edit-add input').press('Enter');
    const png = await page.locator('.edit-cover-frame').screenshot();
    await page.locator('.edit-cover input[type=file]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    await page.locator('.edit-add input').fill('not a link');
    await page.locator('.edit-add-btn').click(); await settle(page);
    await shot(page, 'd-edit-changed');
    await page.keyboard.press('Escape'); await settle(page);
    await shot(page, 'd-edit-discard');
    await page.locator('.confirm-ok').click();
  });

  test('настройки: все вкладки', async ({ page }) => {
    await openLibrary(page);
    await menu(page, 'Настройки'); await settle(page);
    for (const tab of ['Общие', 'Аккаунт', 'Источники', 'Перевод', 'Загрузки', 'Уведомления', 'Копии', 'Корзина', 'О программе']) {
      await page.locator('.settings-tab', { hasText: tab }).click(); await settle(page);
      await shot(page, `d-settings-${tab}`);
    }
  });

  test('статистика, клавиши, новинки', async ({ page }) => {
    await openLibrary(page);
    await menu(page, 'Статистика'); await settle(page);
    await shot(page, 'd-stats');
    await page.keyboard.press('Escape'); await settle(page);
    await page.keyboard.press('Shift+Slash'); await settle(page);
    await shot(page, 'd-keys');
    await page.keyboard.press('Escape'); await settle(page);
    await page.locator('.nav-tab', { hasText: 'Новинки' }).click();
    await expect(page.locator('.catalog-content .state-error')).toBeVisible({ timeout: 20_000 }); await settle(page);
    await shot(page, 'd-news-offline');
    await page.locator('.catalog-sources .chip', { hasText: 'Хочу поиграть' }).click(); await settle(page);
    await shot(page, 'd-wishlist-empty');
  });

  test('вход и пустая библиотека', async ({ browser, page }) => {
    const guest = await browser.newPage({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await guest.goto('/'); await expect(guest.locator('#auth-title')).toBeVisible(); await settle(guest);
    await shot(guest, 'd-login');
    await guest.close();
    await page.route(/\/api\/games(\?.*)?$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
    await page.goto('/'); await expect(page.locator('.welcome')).toBeVisible(); await settle(page);
    await shot(page, 'd-welcome');
  });
});

test.describe('планшет', () => {
  test.use({ viewport: { width: 834, height: 1112 } });
  test('главная, библиотека и раскрытые фильтры, окно игры', async ({ page }) => {
    await openHome(page); await settle(page);
    await shot(page, 't-home');
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(page.locator('.library > .game-card').first()).toBeVisible(); await settle(page);
    await shot(page, 't-library');
    await page.locator('.filters-toggle').click(); await settle(page);
    await shot(page, 't-filters');
    await openGame(page, 'Starfall Inn'); await settle(page);
    await shot(page, 't-game');
    await page.locator('.grimoire-action-btn', { hasText: 'Изменить' }).click(); await settle(page);
    await shot(page, 't-edit');
  });
});

test.describe('телефон', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('главная, меню, библиотека, окно игры', async ({ page }) => {
    await openHome(page); await settle(page);
    await shot(page, 'm-home');
    await page.locator('.header-menu-btn').click(); await settle(page);
    await shot(page, 'm-menu');
    await page.keyboard.press('Escape');
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(page.locator('.library > .game-card').first()).toBeVisible(); await settle(page);
    await shot(page, 'm-library');
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).click();
    await expect(page.locator('.modal-content')).toBeVisible(); await settle(page);
    await shot(page, 'm-game');
    await page.locator('.grimoire-action-btn', { hasText: 'Изменить' }).click(); await settle(page);
    await shot(page, 'm-edit');
  });
});
