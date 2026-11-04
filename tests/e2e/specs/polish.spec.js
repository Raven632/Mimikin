import { test, expect, openHome, openLibrary, openViewRow, imagesLoaded } from '../fixtures.js';

// Разгрузка интерфейса: библиотека, Главная, шапка, карточки. Игры подменяем поверх настоящего ответа
const gamesAs = (page, change) => page.route(/\/api\/games(\?.*)?$/, async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const real = await res.json();
  return route.fulfill({ response: res, json: change(real) });
});
const fresh = (g) => ({ ...g, status: '', lastPlayed: 0, playtime: 0, shelf: null, rating: 0 });
const noGames = (page) => page.route(/\/api\/games(\?.*)?$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
const shot = async (page, name) => {
  await imagesLoaded(page).catch(() => {});
  await page.waitForTimeout(200);
  await page.screenshot({ path: `e2e/report/polish-${name}.png` });
};
// Выдача itch.io: сервер тестов без сети, одна карточка подставляется
const ITCH = { url: 'https://maker1.itch.io/lantern-harbor', title: 'Lantern Harbor', creator: 'maker1', genre: 'Role Playing', price: '', platforms: ['windows'], description: '', cover: '', createdAt: 0, updatedAt: 0 };
const feed = (page) => page.route(/\/api\/itch\/latest/, (route) => route.fulfill({ json: { page: 1, more: false, items: [ITCH] } }));
const tagged = (page, yes) => page.route(/\/api\/pictures\/status/, (route) => route.fulfill({ json: { state: 'off', analysis: { on: false, state: 'off' }, tagged: yes } }));

test.describe('чипы статуса', () => {
  test('пустых нет; ноль из-за поиска гаснет, а чип остаётся', async ({ page }) => {
    await gamesAs(page, (list) => list.map((g, i) => ({ ...fresh(g), status: i < 2 ? 'done' : '', tags: i < 2 ? ['only-done'] : g.tags })));
    await openLibrary(page);
    const chips = page.locator('.status-chips .chip');
    await expect(chips).toHaveCount(3);
    await expect(page.locator('.status-chips')).not.toContainText('Брошено');
    await page.locator('.search-box input').fill('Starfall');
    await expect(chips).toHaveCount(3);
    await expect(page.locator('.status-chips .chip.chip-empty')).not.toHaveCount(0);
  });

  test('один статус на всю библиотеку: чипов нет, ряд вида есть', async ({ page }) => {
    await gamesAs(page, (list) => list.map(fresh));
    await openLibrary(page);
    await expect(page.locator('.library > .game-card').first()).toBeVisible();
    await expect(page.locator('.status-chips')).toHaveCount(0);
    await expect(page.locator('.look-switches')).toBeVisible();
    await shot(page, 'library-one-status');
  });
});

test.describe('«Что на картинках»', () => {
  test('нет разобранных игр — кнопки нет, сортировка на месте; есть — кнопка с новым названием', async ({ page }) => {
    await tagged(page, false);
    await openLibrary(page);
    await expect(page.locator('.sort-order')).toBeVisible();
    await expect(page.locator('.pic-tags-tool')).toHaveCount(0);
    await page.unroute(/\/api\/pictures\/status/);
    await tagged(page, true);
    await page.reload();
    await expect(page.locator('.pic-tags-tool button')).toContainText('Что на картинках');
  });
});

test.describe('пустая библиотека', () => {
  test('нет поиска и второй «Добавить игру», глаз есть на Главной и в «Найти», плитка на месте', async ({ page }) => {
    await noGames(page);
    await feed(page);
    await page.goto('/');
    await expect(page.locator('.welcome-drop, .welcome').first()).toBeVisible();
    await expect(page.locator('.search-box')).toHaveCount(0);
    await expect(page.locator('.upload-btn')).toHaveCount(0);
    await expect(page.locator('.cover-toggle')).toBeVisible();
    await shot(page, 'empty-home');
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(page.locator('.search-box')).toHaveCount(0);
    await expect(page.locator('.controls-zone .picker')).toHaveCount(0);
    await expect(page.locator('.cover-toggle')).toHaveCount(0);
    await page.locator('.nav-tab', { hasText: 'Найти' }).click();
    await expect(page.locator('.cover-toggle')).toBeVisible();
  });
});

test.describe('глаз и «Добавить игру» в шапке', () => {
  test('от 1100 — в шапке на всех вкладках, в «Найти» глаз работает; ниже — глаз за «Фильтрами»', async ({ page }) => {
    await openHome(page);
    for (const tab of ['Главная', 'Библиотека', 'Найти']) {
      await page.locator('.nav-tab', { hasText: tab }).click();
      await expect(page.locator('.header-side .cover-toggle'), tab).toBeVisible();
      await expect(page.locator('.header-side .upload-btn'), tab).toBeVisible();
    }
    await page.locator('.header-side .cover-toggle').click();
    await expect(page.locator('.app-container')).toHaveClass(/covers-hidden/);
    await page.locator('.header-side .cover-toggle').click();
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    // Сортировка больше не обрезается кнопками: вся панель в одной строке и в экране
    const sort = await page.locator('.sort-order').boundingBox();
    expect(sort.x + sort.width).toBeLessThanOrEqual(1440);
    await shot(page, 'library-desktop');
    // Ровно 1100 — ещё шапка: «Добавить игру» не должна стоять и там, и в меню
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator('.header-side .upload-btn')).toBeVisible();
    await page.locator('.header-menu-btn').click();
    await expect(page.locator('.header-menu-item.mobile-only:visible')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1099, height: 800 });
    await expect(page.locator('.header-side .cover-toggle')).toHaveCount(0);
    await page.locator('.filters-toggle').click();
    await expect(page.locator('.toolbar-filters .cover-toggle')).toBeVisible();
  });
});

test.describe('повторы', () => {
  test('«Найти» только для читалок; на вкладке «Библиотека» нет числа', async ({ page }) => {
    await openHome(page);
    await expect(page.locator('.nav-tab', { hasText: 'Библиотека' })).toHaveText('Библиотека');
    await page.locator('.nav-tab', { hasText: 'Найти' }).click();
    const head = page.getByRole('heading', { name: 'Найти', exact: true });
    await expect(head).toHaveCount(1);
    expect((await head.boundingBox()).height).toBeLessThanOrEqual(1);
    await shot(page, 'find-desktop');
  });
});

test.describe('«Во что поиграть?» на полке', () => {
  const shelf = (page) => page.locator('section.shelf[aria-label="Что дальше"]');
  test('9 не начатых — кнопки нет, в меню пункт есть; 10 — есть', async ({ page }) => {
    let unstarted = 9;
    await gamesAs(page, (list) => list.map((g, i) => (i < unstarted ? fresh(g) : { ...g, status: 'done' })));
    await openHome(page);
    await expect(shelf(page).locator('.shelf-card').first()).toBeVisible();
    await expect(page.locator('.shelf-random')).toHaveCount(0);
    await page.locator('.header-menu-btn').click();
    await expect(page.locator('.header-menu-item', { hasText: 'Во что поиграть?' })).toBeVisible();
    await page.keyboard.press('Escape');
    unstarted = 10;
    await page.reload();
    await expect(page.locator('.shelf-random')).toBeVisible();
    await expect(page.locator('.shelf-random-text')).toBeVisible();
  });
});

test.describe('«Недавно играли»', () => {
  test('отметка видна под курсором', async ({ page }) => {
    await openHome(page);
    const row = page.locator('.recent-row').first();
    await page.mouse.move(0, 0);
    await expect(row.locator('.recent-play')).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(row.locator('.recent-play')).toHaveCSS('opacity', '1');
    await shot(page, 'home-desktop');
  });
});

test.describe('оценка и звезда на обложке', () => {
  test('метка внизу слева, звёзды при наведении; число кадров вытесняет метку; звезда «Отложить» — при наведении', async ({ page }) => {
    await gamesAs(page, (list) => list.map((g, i) => ({ ...g, rating: i === 0 ? 4 : 0 })));
    await openLibrary(page);
    const card = page.locator('.library > .game-card').first();
    const mark = card.locator('.card-my-rating');
    await expect(mark).toHaveText('4');
    await page.mouse.move(0, 0);
    await expect(card.locator('.card-rating')).toHaveCSS('opacity', '0');
    const [m, cover] = await Promise.all([mark.boundingBox(), card.locator('.card-cover').boundingBox()]);
    expect(m.x - cover.x).toBeLessThan(cover.width / 2);
    expect(m.y - cover.y).toBeGreaterThan(cover.height / 2);
    await card.hover();
    await expect(card.locator('.card-rating')).toHaveCSS('opacity', '1');
    await openViewRow(page);
    await page.locator('.g-view').getByRole('button', { name: 'Список', exact: true }).click();
    await expect(mark).toBeHidden();
    await page.locator('.g-view').getByRole('button', { name: 'Сетка', exact: true }).click();
  });

  test('звезда: не отложенная прячется, с фокусом видна', async ({ page }) => {
    await feed(page);
    await page.route(/\/api\/wishlist(\?.*)?$/, (route) => route.fulfill({ json: { items: [] } }));
    await openHome(page);
    await page.locator('.nav-tab', { hasText: 'Найти' }).click();
    const box = page.locator('.catalog-content .catalog-card-box').first();
    const star = box.locator('.catalog-wish');
    await page.mouse.move(0, 0);
    await expect(star).toHaveCSS('opacity', '0');
    await box.hover();
    await expect(star).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await star.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(star).toHaveCSS('opacity', '1');
  });
});

test.describe('окно игры', () => {
  test('не запускали: нет «Пути» и «Моментов», есть момент — появляются; без серии блока нет; «Не привязаны» нет', async ({ page }) => {
    await gamesAs(page, (list) => list.map((g) => ({ ...fresh(g), notes: '', series: '' })));
    await openLibrary(page);
    await page.locator('.library > .game-card').first().locator('.card-title').click();
    const tabs = page.locator('.modal-tabs .modal-tab');
    await expect(tabs).toHaveText(['Обзор', 'Сведения', 'Перевод']);
    await expect(page.locator('.game-notes-add')).toBeVisible();
    await expect(page.locator('.game-series')).toHaveCount(0);
    await expect(page.locator('.src-off')).toHaveCount(0);
    await shot(page, 'game-unstarted-desktop');
    await page.keyboard.press('Escape');
    await page.route(/\/api\/marks\/[^/]+$/, (route) => route.fulfill({ json: [{ id: 'm1', kind: 'own', label: 'x', at: Date.now() }] }));
    await page.locator('.library > .game-card').first().locator('.card-title').click();
    await expect(page.locator('#tab-shots')).toBeVisible();
    await expect(page.locator('#tab-path')).toBeVisible();
  });
  test('игру запускали: вкладки все', async ({ page }) => {
    await gamesAs(page, (list) => list.map((g) => ({ ...fresh(g), lastPlayed: Date.now() - 1000 })));
    await openLibrary(page);
    await page.locator('.library > .game-card').first().locator('.card-title').click();
    await expect(page.locator('.modal-tabs .modal-tab')).toHaveCount(5);
    await expect(page.locator('.mine-fold')).toBeHidden();
    await expect(page.locator('.modal-mine')).toBeVisible();
  });
});

test.describe('меню', () => {
  const status = (page, json) => page.route(/\/api\/pictures\/status/, (route) => route.fulfill({ json: { state: 'off', ...json } }));
  const items = async (page) => {
    await page.locator('.header-menu-btn').click();
    await page.waitForTimeout(150);
    return page.locator('.header-menu-item:visible .header-menu-text').allTextContents();
  };
  test('нет разбора и избранного: картинок в меню нет, три части через черту', async ({ page }) => {
    await status(page, { analysis: { on: false }, tagged: false, faved: false });
    await gamesAs(page, (list) => list.map(fresh));
    await openLibrary(page);
    const list = await items(page);
    expect(list).toEqual(expect.arrayContaining(['Во что поиграть?', 'Сцены', 'Статистика', 'Настройки']));
    for (const name of ['Избранное', 'Лента картинок', 'Поиск по картинкам']) expect(list).not.toContain(name);
    await expect(page.locator('.header-menu-sep:visible')).toHaveCount(2);
    await shot(page, 'menu-short');
  });
  test('разбор включён и есть избранное: пункты есть; все игры начаты — подбора нет', async ({ page }) => {
    await status(page, { analysis: { on: true }, tagged: false, faved: true });
    await gamesAs(page, (list) => list.map((g) => ({ ...fresh(g), status: 'done', lastPlayed: 1 })));
    await openLibrary(page);
    const list = await items(page);
    expect(list).toEqual(expect.arrayContaining(['Избранное', 'Лента картинок', 'Поиск по картинкам']));
    expect(list).not.toContain('Во что поиграть?');
    await shot(page, 'menu-full');
  });
  test('первое сердечко видно при следующем открытии меню', async ({ page }) => {
    let faved = false;
    await page.route(/\/api\/pictures\/status/, (route) => route.fulfill({ json: { state: 'off', analysis: { on: false }, tagged: false, faved } }));
    await openLibrary(page);
    expect(await items(page)).not.toContain('Избранное');
    await page.locator('.header-menu-btn').click();
    faved = true;
    expect(await items(page)).toContain('Избранное');
  });
});

test.describe('настройки', () => {
  const settings = (page, extra) => page.route(/\/api\/settings$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), ...extra } });
  });
  const open = async (page, tab) => {
    await page.locator('.header-menu-btn').click();
    await page.locator('.header-menu-item', { hasText: 'Настройки' }).click();
    if (tab) await page.locator('.settings-tab', { hasText: tab }).click();
  };
  const off = { telegram: { set: false }, myjd: { set: false } };
  test('три группы; необязательное появляется по делу', async ({ page }) => {
    await page.route(/\/api\/pictures\/hidden$/, (route) => route.fulfill({ json: { tags: [] } }));
    await settings(page, off);
    await openLibrary(page);
    await open(page);
    await expect(page.locator('.settings-group-title')).toHaveText(['Своё', 'Библиотека', 'Подключения, по желанию']);
    await expect(page.locator('[data-section="hidden-tags"]')).toHaveCount(0);
    await shot(page, 'settings-general');
    await page.locator('.settings-tab', { hasText: 'Уведомления' }).click();
    await expect(page.locator('[data-option="disk_warn_gb"]')).toHaveCount(0);
    await page.locator('.settings-tab', { hasText: 'Загрузки' }).click();
    await expect(page.locator('[data-section="jd-bookmark"]')).toHaveCount(0);
    await page.locator('.settings-tab', { hasText: 'Источники' }).click();
    await expect(page.locator('.svc-item-name')).toHaveText(['ScraperAPI', 'VNDB', 'Steam']);
    await shot(page, 'settings-sources');
  });
});

test.describe('отложенные', () => {
  test('своя закладка вместо звезды, подборка на полке — свой значок', async ({ page }) => {
    await openHome(page);
    await page.locator('.nav-tab', { hasText: 'Найти' }).click();
    const tab = page.locator('.catalog-wish-tab');
    await expect(tab).toContainText('Отложенные');
    await tab.click();
    await expect(page.locator('.catalog-content .state-empty')).toContainText('закладкой');
    await shot(page, 'find-saved');
  });
  test('на карточке сайта закладка, а не звезда; вкладка своей подборки со своим значком', async ({ page }) => {
    await feed(page);
    await gamesAs(page, (list) => list.map((g, i) => ({ ...g, lists: i < 3 ? ['Вечер'] : [] })));
    await openHome(page);
    await shot(page, 'home-list-tab');
    const tab = page.locator('.shelf-tab', { hasText: 'Вечер' });
    await expect(tab.locator('svg path')).toHaveAttribute('d', /M4\.5 15\.5/);
    await page.locator('.nav-tab', { hasText: 'Найти' }).click();
    await page.locator('.catalog-sources .chip', { hasText: 'itch.io' }).click();
    await page.locator('.catalog-card-box, .catalog-row-box').first().hover();
    await expect(page.locator('.catalog-wish svg path').first()).toHaveAttribute('d', /M6\.5 4h11/);
    await shot(page, 'find-bookmark');
  });
});
