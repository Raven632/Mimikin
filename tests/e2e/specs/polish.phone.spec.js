import { test, expect, openHome, openLibrary, noHot, imagesLoaded } from '../fixtures.js';

const fresh = (g) => ({ ...g, status: '', lastPlayed: 0, playtime: 0, shelf: null });
const shot = async (page, name) => {
  await imagesLoaded(page).catch(() => {});
  await page.waitForTimeout(200);
  await page.screenshot({ path: `e2e/report/polish-${name}.png` });
};

test.describe('телефон: разгрузка', () => {
  test('кубик значком рядом со «Все», своей строки нет', async ({ page }) => {
    await noHot(page);
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const list = await res.json();
      return route.fulfill({ response: res, json: list.map((g, i) => (i ? fresh(g) : g)) });
    });
    await openHome(page);
    const shelf = page.locator('section.shelf[aria-label="Что дальше"]');
    const dice = shelf.locator('.shelf-random');
    await expect(dice).toBeVisible();
    await expect(dice).toHaveAttribute('aria-label', 'Во что поиграть?');
    await expect(dice.locator('.shelf-random-text')).toBeHidden();
    const [d, all] = await Promise.all([dice.boundingBox(), shelf.locator('.shelf-tools .shelf-all').last().boundingBox()]);
    expect(Math.abs(d.y - all.y)).toBeLessThanOrEqual(2);
    await expect(page.locator('.shelf-sub')).toHaveCount(0);
    await shot(page, 'home-phone');
    await dice.tap();
    await expect(page.locator('.play-pick')).toBeVisible();
  });

  test('«Библиотека» скрыта для глаз, сводка осталась; оценка — меткой', async ({ page }) => {
    await noHot(page);
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const list = await res.json();
      return route.fulfill({ response: res, json: list.map((g, i) => ({ ...g, rating: i === 0 ? 5 : 0 })) });
    });
    await openLibrary(page);
    const head = page.getByRole('heading', { name: 'Библиотека', exact: true });
    await expect(head).toHaveCount(1);
    expect((await head.boundingBox()).height).toBeLessThanOrEqual(1);
    await expect(page.locator('.lib-mast-stats')).toBeVisible();
    await expect(page.locator('.game-card .card-rating').first()).toBeHidden();
    await expect(page.locator('.game-card .card-my-rating').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'library-phone');
    await page.locator('.nav-tab', { hasText: 'Найти' }).tap();
    await expect(page.locator('.catalog-sources')).toBeVisible();
    await shot(page, 'find-phone');
  });
  test('окно игры: «Моя игра» одной строкой над вкладками, нажатие раскрывает со статусом и заметкой', async ({ page }) => {
    await noHot(page);
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      return route.fulfill({ response: res, json: (await res.json()).map((g) => ({ ...g, rating: 4, status: 'playing', playtime: 3600, lastPlayed: Date.now() })) });
    });
    await openLibrary(page);
    await page.locator('.library > .game-card').first().click();
    const fold = page.locator('.mine-fold');
    await expect(fold).toBeVisible();
    await expect(fold).toContainText('Моя игра');
    await expect(fold).toContainText('Играю');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.modal-mine')).toBeHidden();
    const [line, tabs, play] = await Promise.all([fold.boundingBox(), page.locator('.modal-tabs').boundingBox(), page.locator('#modal-play-btn').boundingBox()]);
    expect(line.y).toBeGreaterThan(play.y);
    expect(tabs.y).toBeGreaterThanOrEqual(line.y + line.height);
    expect(line.height).toBeLessThanOrEqual(60);
    await shot(page, 'game-phone');
    await fold.tap();
    await expect(page.locator('.modal-mine')).toBeVisible();
    await expect(page.locator('.game-notes')).toBeVisible();
    await shot(page, 'game-phone-open');
    await page.locator('.modal-close').tap();
  });

  test('«Моя игра» свёрнута: значок говорит, что заметка есть', async ({ page }) => {
    await noHot(page);
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      return route.fulfill({ response: res, json: (await res.json()).map((g, i) => ({ ...g, notes: i ? '' : 'застрял у моста' })) });
    });
    await openLibrary(page);
    await page.locator('.library > .game-card').first().click();
    await expect(page.locator('.mine-fold .mine-fold-note')).toBeVisible();
    await expect(page.locator('.game-notes')).toBeHidden();
    await page.locator('.modal-close').tap();
    await page.locator('.library > .game-card').nth(1).click();
    await expect(page.locator('.mine-fold')).toBeVisible();
    await expect(page.locator('.mine-fold .mine-fold-note')).toHaveCount(0);
    await page.locator('.modal-close').tap();
  });

  test('настройки: группы во всю ширину, оглавление в две колонки', async ({ page }) => {
    await noHot(page);
    await openLibrary(page);
    await page.locator('.header-menu-btn').tap();
    await page.locator('.header-menu-item', { hasText: 'Настройки' }).tap();
    await expect(page.locator('.settings-group-title').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'settings-phone');
  });
  test('длинная «Поставить новую версию» на 320 по-немецки: окно не вылезает за край', async ({ page }) => {
    await noHot(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(() => localStorage.setItem('rpg_lang', 'de'));
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      return route.fulfill({ response: res, json: (await res.json()).map((g) => ({ ...g, shelf: { at: Date.now(), files: false } })) });
    });
    // Все игры на полке — полок Главной нет, поэтому сразу на вкладку библиотеки
    await page.goto('/');
    await page.locator('.nav-tab').nth(1).click();
    await page.locator('.library > .game-card').first().click();
    const play = page.locator('#modal-play-btn');
    await expect(play).toBeVisible();
    await expect(play).toContainText('Neue Version');
    const box = await play.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await play.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await shot(page, 'shelf-de-320');
  });
});
