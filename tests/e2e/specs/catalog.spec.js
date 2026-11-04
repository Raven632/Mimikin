import { test, expect, openHome, openSiteFilters, ONLINE_MODES } from '../fixtures.js';

// Вкладка «Найти»: выдача itch.io и «Отложенные». Выдачу подставляем (сервер тестов без сети), правила разбора ленты проверяют
// тесты API. Обложки — настоящие из демо-библиотеки: на них видно то же, что в макете
const DAY = 86400000;
const itch = (n, title, extra = {}) => {
  const url = `https://maker${n}.itch.io/game-${n}`;
  return { url, title, creator: `maker${n}`, genre: 'Role Playing', price: n % 3 ? '' : '$4.99', platforms: ['windows', 'html'], description: 'A short tale about a lantern keeper.', cover: '', createdAt: Date.now() - 9 * DAY, updatedAt: Date.now() - DAY, ...extra };
};
const FEED = [itch(1, 'Lantern Harbor'), itch(2, 'Salt and Ember'), itch(3, 'The Quiet Orchard')];
const COVERS = ['Seven_Keys', 'Clockwork_Vale', 'Tidecaller', 'Hollow_Spire', 'The_Lantern_Road', 'Ashen_Crown'];

// Отложенные: запись — то же, что вернул бы сервер (services/wishlist.js)
const wishEntry = (n, title) => {
  const { url, ...info } = itch(n, title);
  return { key: `itch:${url}`, source: 'itch', ref: url, url, addedAt: Date.now() - n * DAY, info: { ...info } };
};
const WISH = [wishEntry(11, 'Hollow Lamp'), wishEntry(12, 'Tide Letters'), wishEntry(13, 'Clock Garden'), wishEntry(14, 'Paper Moon')];

// Выдача и «Отложенные» подставлены. feed — какие страницы выдачи у нас просили. Обложки: настоящие, из демо-игр
async function mock(page, { feed = FEED, wish = [] } = {}) {
  const asked = { feed: [] };
  const list = await (await page.request.get('/api/games')).json();
  const coverOf = (i) => {
    const game = list.find((g) => g.id === COVERS[i % COVERS.length]);
    return game?.cover ? `/${game.cover}?w=360` : '';
  };
  await page.route(/\/api\/itch\/meta/, (route) => route.fulfill({ json: { tags: ['fantasy', 'adventure', 'puzzle'], details: false } }));
  await page.route(/\/api\/itch\/latest/, (route) => {
    asked.feed.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { page: 1, more: false, items: feed.map((x, i) => ({ ...x, cover: coverOf(i) })) } });
  });
  await page.route(/\/api\/wishlist(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') { const body = req.postDataJSON(); return route.fulfill({ json: { key: `itch:${body.url}`, source: 'itch', ref: body.url, url: body.url, info: body, addedAt: Date.now() } }); }
    if (req.method() === 'DELETE') return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: { items: wish.map((e, i) => ({ ...e, info: { ...e.info, cover: coverOf(i) } })) } });
  });
  return asked;
}

const titles = (page) => page.locator('.catalog-card-title');
const openFind = (page) => page.locator('.nav-tab', { hasText: 'Найти' }).click();
const modeChip = (page, name) => page.locator('.catalog-sources .chip', { hasText: name });
const empty = (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
const offline = (route) => route.fulfill({ json: { ...ONLINE_MODES, offline: true } });

test.describe('«Найти»: itch.io и «Отложенные»', () => {
  test('режимов два: itch.io и «Отложенные»; открывается выдача, «Для вас» на Главной нет', async ({ page }) => {
    await mock(page, { wish: WISH });
    await openHome(page);
    await expect(page.locator('.shelf-title', { hasText: 'Для вас' })).toHaveCount(0);
    await openFind(page);
    await expect(page.locator('.catalog-sources .chip')).toHaveText(['itch.io', /Отложенные/]);
    await expect(modeChip(page, 'itch.io')).toHaveClass(/active/);
    await expect(titles(page)).toHaveText(FEED.map((x) => x.title));
  });

  test('смена режима не сбрасывает фильтры; ленту второй раз не просят; последний режим помнится', async ({ page }) => {
    const asked = await mock(page, { wish: WISH });
    await openHome(page);
    await openFind(page);
    await expect(titles(page).first()).toBeVisible();
    await openSiteFilters(page);
    const price = page.locator('.catalog-filter-list .picker-btn', { hasText: 'Любая цена' });
    await price.click();
    await page.locator('.picker-opt', { hasText: 'Бесплатные' }).click();
    await expect.poll(() => asked.feed.at(-1) || '').toContain('price=free');
    await expect(titles(page).first()).toBeVisible();
    const count = asked.feed.length;
    await modeChip(page, 'Отложенные').click();
    await expect(titles(page)).toHaveCount(WISH.length);
    await modeChip(page, 'itch.io').click();
    await expect(page.locator('.catalog-filter-list .picker-btn', { hasText: 'Бесплатные' })).toBeVisible();
    await expect(titles(page).first()).toBeVisible();
    expect(asked.feed.length).toBe(count);
    await modeChip(page, 'Отложенные').click();
    await page.reload();
    await openFind(page);
    await expect(modeChip(page, 'Отложенные')).toHaveClass(/active/);
  });

  test('«Фильтры» на любой ширине помнятся; в пустой библиотеке «Скрыть мои» нет; в «Отложенных» она остаётся строкой', async ({ page }) => {
    await mock(page, { wish: WISH });
    await page.goto('/');
    await openFind(page);
    const list = page.locator('.catalog-filter-list');
    await expect(list).toBeHidden();
    await openSiteFilters(page);
    await expect(list.locator('.picker')).not.toHaveCount(0);
    await expect(list.locator('.catalog-check')).toBeVisible();
    await page.reload();
    await openFind(page);
    await expect(page.locator('.catalog-filters .filters-toggle')).toHaveAttribute('aria-expanded', 'true');
    await modeChip(page, 'Отложенные').click();
    await expect(page.locator('.catalog-actions .catalog-check')).toHaveCount(1);
  });

  test('без игр в библиотеке: в «Фильтры» нет «Скрыть мои»', async ({ page }) => {
    await mock(page);
    await page.route(/\/api\/games(\?.*)?$/, empty);
    await page.goto('/');
    await openFind(page);
    await openSiteFilters(page);
    await expect(page.locator('.catalog-filter-list .picker').first()).toBeVisible();
    await expect(page.locator('.catalog-filter-list .catalog-check')).toHaveCount(0);
  });

  test('клавиатура: окно игры ставит фокус на «Назад», «Назад» возвращает его на ту же карточку и то же место', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await mock(page, { feed: Array.from({ length: 18 }, (_, i) => itch(20 + i, `Lantern Row ${i + 1}`)) });
    await openHome(page);
    await openFind(page);
    await expect(titles(page)).toHaveCount(18);
    const card = page.locator('.catalog-card-box .catalog-card').nth(14);
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.catalog-back')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('закладка на карточке откладывает игру и зажигается; окно игры открывается из выдачи', async ({ page }) => {
    await mock(page);
    await openHome(page);
    await openFind(page);
    const box = page.locator('.catalog-card-box').first();
    const mark = box.locator('.catalog-wish');
    await expect(mark).toHaveAttribute('aria-pressed', 'false');
    await mark.click();
    await expect(mark).toHaveAttribute('aria-pressed', 'true');
    await expect(modeChip(page, 'Отложенные')).toContainText('1');
    await box.locator('.catalog-card').click();
    await expect(page.locator('.catalog-detail-title')).toHaveText(FEED[0].title);
    await page.locator('.catalog-back').click();
    await expect(modeChip(page, 'itch.io')).toHaveClass(/active/);
    await expect(titles(page)).toHaveText(FEED.map((x) => x.title));
  });
});

test.describe('«Найти»: без сети', () => {
  test('без интернета: только «Отложенные», itch.io видно, нажать нельзя; память не меняется; своё на месте', async ({ page }) => {
    await mock(page, { wish: WISH });
    await page.route(/\/api\/recommend\/modes/, offline);
    await openHome(page);
    await openFind(page);
    await expect(modeChip(page, 'Отложенные')).toHaveClass(/active/);
    await expect(modeChip(page, 'itch.io')).toBeDisabled();
    await expect(page.locator('.find-offline-line')).toContainText('работает без интернета');
    await expect(page.locator('.catalog-card-box')).toHaveCount(WISH.length);
    await expect(page.locator('.catalog-hint')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('rpg_find'))).toBeNull();
  });

  test('без интернета и список пуст: совета про закладку нет', async ({ page }) => {
    await mock(page);
    await page.route(/\/api\/recommend\/modes/, offline);
    await openHome(page);
    await openFind(page);
    await expect(page.locator('.catalog-content .state-empty')).toContainText('Список «Отложенные» пуст');
    await expect(page.locator('.catalog-content .state-empty')).toContainText('itch.io недоступен');
    await expect(page.locator('.catalog-content .state-empty')).not.toContainText('закладкой');
    await expect(page.locator('.catalog-view')).toHaveCount(0);
  });
});
