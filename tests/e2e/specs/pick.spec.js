import { test, expect, openHome, menu, imagesLoaded } from '../fixtures.js';

// «Во что поиграть?» (PlayPicker.jsx): только свои игры. Подбор подставляем: сами правила подбора проверяют тесты API.
// Игры и обложки — настоящие из демо-библиотеки
const HOUR = 3600;
const LIBRARY = {
  cold: false, total: 7,
  items: [
    { id: 'Moonlit_Library', score: 1.4, reasons: [
      { code: 'same-dev', params: { dev: 'Moon Studio', game: 'Starfall Inn', gameId: 'Starfall_Inn', playtime: 5 * HOUR + 12 * 60 } },
      { code: 'favorite-tags', params: { tags: ['mystery', 'puzzle', 'cozy'] } },
    ] },
    { id: 'Seven_Keys', score: 1.1, reasons: [{ code: 'planned', params: { at: Date.now() - 40 * 86400000 } }] },
    { id: 'Dragon_Post_Office', score: 1, reasons: [{ code: 'translation', params: { lang: 'en' } }] },
    { id: 'Wanderers_Almanac', score: 0.9, reasons: [{ code: 'tags-like', params: { tags: ['exploration', 'crafting'], game: 'The Lantern Road', gameId: 'The_Lantern_Road' } }] },
    { id: 'Tidecaller', score: 0.8, reasons: [{ code: 'same-dev', params: { dev: 'Moon Studio', game: 'Starfall Inn', gameId: 'Starfall_Inn', playtime: 0 } }] },
    { id: 'Hoshifuru_Yado', score: 0.7, reasons: [{ code: 'known-lang', params: { lang: 'en' } }] },
    { id: 'Clockwork_Vale', score: 0.6, reasons: [{ code: 'translation', params: { lang: 'de' } }] },
  ],
  resume: [
    { id: 'Ashen_Crown', reasons: [{ code: 'left', params: { playtime: 40 * 60, at: Date.now() - 60 * 86400000 } }] },
    { id: 'Ember_and_Frost', reasons: [{ code: 'left', params: { playtime: 2 * HOUR, at: 0 } }] },
  ],
};

// Подставляет подбор; что спрашивали — в asked. over — другие ответы на отдельный адрес. Сайты окно не спрашивает вовсе: это проверяем
async function mock(page, over = {}) {
  const asked = { library: [], sites: 0, popular: [], dismiss: [] };
  await page.route(/\/api\/recommend\/library/, async (route) => {
    const url = new URL(route.request().url());
    asked.library.push(url.search);
    if (over.library) return over.library(route, asked);
    return route.fulfill({ json: LIBRARY });
  });
  await page.route(/\/api\/recommend\/sites/, (route) => {
    asked.sites += 1;
    return route.fulfill({ json: { offline: false, blocks: [] } });
  });
  await page.route(/\/api\/recommend\/dismiss/, (route) => {
    asked.dismiss.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, dismissed: 1 } });
  });
  return asked;
}

async function openPick(page) {
  await menu(page, 'Во что поиграть?');
  await expect(page.locator('.play-pick')).toBeVisible();
  await expect(page.locator('.pick-name')).toBeVisible();
}

const dialog = (page) => page.locator('.play-pick');
// Закрыть и дождаться, пока окно сняло свою запись в истории: иначе переход сразу после Escape спорит с её шагом назад
async function closePick(page) {
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await page.waitForFunction(() => !window.history.state?.rpgLayer);
}
const strip = (page) => page.locator('.pick-strip .pick-tile .pick-tile-name');

test.describe('во что поиграть', () => {
  test('первая игра сразу, причины каждого вида, плитки ленты, «Вернуться»; процентов нет', async ({ page }) => {
    await mock(page);
    await openHome(page);
    await openPick(page);
    await expect(page.locator('.pick-name')).toHaveText('Moonlit Library');
    const reasons = page.locator('.pick-reason');
    await expect(reasons).toHaveCount(2);
    await expect(reasons.nth(0)).toContainText('Тот же автор, что у Starfall Inn');
    await expect(reasons.nth(0).locator('b')).toHaveText(['Starfall Inn', '5 ч 12 мин']);
    await expect(reasons.nth(0).locator('.pick-proof')).toBeVisible();
    await expect(reasons.nth(1).locator('.pick-tags span')).toHaveText(['mystery', 'puzzle', 'cozy']);
    await expect(dialog(page)).not.toContainText('%');
    await expect(strip(page)).toHaveText(['Seven Keys', 'Dragon Post Office', "Wanderer's Almanac", 'Tidecaller', 'Hoshifuru Yado']);
    await expect(page.locator('.pick-tile', { hasText: 'Seven Keys' }).locator('.pick-why')).toHaveText('Вы отложили её «В планы»');
    await expect(page.locator('.pick-tile', { hasText: 'Tidecaller' }).locator('.pick-why')).toHaveText('Тот же автор, что у Starfall Inn');
    await expect(page.locator('.pick-tile', { hasText: 'Dragon Post Office' }).locator('.pick-why')).toHaveText('Здесь уже переведена: английский');
    await expect(page.locator('.pick-tile', { hasText: 'Wanderer' }).locator('.pick-why')).toHaveText('Как The Lantern Road: exploration, crafting');
    await expect(page.locator('.pick-tile', { hasText: 'Hoshifuru Yado' }).locator('.pick-why')).toContainText('На знакомом вам языке');

    // «Вернуться»: у запуска есть дата — пишем, нет даты — не пишем
    await expect(page.locator('.pick-back .pick-why')).toContainText('Играли 2 месяца назад, наиграно 40 мин');
    await page.locator('.pick-more-switch').click();
    await expect(strip(page)).toHaveText(['Ashen Crown', 'Ember & Frost']);
    await expect(page.locator('.pick-tile', { hasText: 'Ember' }).locator('.pick-why')).toHaveText('Начата, наиграно 2 ч 0 мин');
    await page.locator('.pick-tile', { hasText: 'Ember' }).click();
    await expect(page.locator('.pick-name')).toHaveText('Ember & Frost');
    await expect(page.locator('.pick-reason').first()).toContainText('Начата, наиграно');
    // На сцене гостья из «Вернуться»: очередь не сдвинулась, первая в ленте — первая по подбору
    await page.locator('.pick-more-switch', { hasText: 'К подбору' }).click();
    await expect(strip(page).first()).toHaveText('Moonlit Library');
  });

  test('«Другую» идёт по кругу, игра из ленты меняется местами со сценой, «Подробнее» открывает окно игры, Escape закрывает', async ({ page }) => {
    await mock(page);
    await openHome(page);
    await openPick(page);
    const next = page.locator('.pick-actions .meta-status-btn', { hasText: 'Другую' });
    await next.click();
    await expect(page.locator('.pick-name')).toHaveText('Seven Keys');
    await expect(strip(page).first()).toHaveText('Dragon Post Office');
    for (let i = 0; i < 6; i += 1) await next.click();
    await expect(page.locator('.pick-name')).toHaveText('Moonlit Library');

    await page.locator('.pick-tile', { hasText: 'Tidecaller' }).click();
    await expect(page.locator('.pick-name')).toHaveText('Tidecaller');
    await expect(strip(page).nth(3)).toHaveText('Moonlit Library');
    // Фокус остался на той же плитке, клавиатура не теряет место
    await expect(page.locator('.pick-strip .pick-tile').nth(3)).toBeFocused();
    await expect(page.locator('.pick-reason')).toContainText('Тот же автор, что у Starfall Inn');

    await page.locator('.pick-actions .meta-status-btn', { hasText: 'Подробнее' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('#modal-title')).toHaveText('Tidecaller');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-title')).toHaveCount(0);
    await openPick(page);
    await closePick(page);
  });

  test('«Не предлагать»: дальше, тост с отменой возвращает игру; сбой запроса — понятный текст и «Ещё раз»', async ({ page }) => {
    let fail = false;
    const asked = await mock(page, {
      library: (route) => (fail ? route.fulfill({ status: 500, json: { error: 'x', reason: 'recommend-failed' } }) : route.fulfill({ json: LIBRARY })),
    });
    await openHome(page);
    await openPick(page);
    await page.locator('.pick-skip').click();
    await expect(page.locator('.pick-name')).toHaveText('Seven Keys');
    await expect(page.locator('.toast')).toContainText('Moonlit Library: больше не предлагаем');
    expect(asked.dismiss).toEqual([{ key: 'Moonlit_Library' }]);
    await page.locator('.toast .toast-action').click();
    await expect(page.locator('.pick-name')).toHaveText('Moonlit Library');
    expect(asked.dismiss[1]).toEqual({ key: 'Moonlit_Library', undo: true });
    await expect(page.locator('.toast.show')).toHaveCount(0);

    fail = true;
    await closePick(page);
    await menu(page, 'Во что поиграть?');
    await expect(page.locator('.play-pick .state-error')).toContainText('Подбор не удался');
    fail = false;
    await page.locator('.play-pick .state-retry').click();
    await expect(page.locator('.pick-name')).toHaveText('Moonlit Library');
  });

  test('сайтов в окне нет: ни блока, ни запроса при открытии; карточек чужих игр нет', async ({ page }) => {
    const asked = await mock(page);
    await openHome(page);
    await openPick(page);
    await expect(page.locator('.pick-name')).toHaveText('Moonlit Library');
    await expect(dialog(page).locator('.pick-sites, .pick-site, .catalog-wish')).toHaveCount(0);
    await expect(dialog(page)).not.toContainText('С сайтов');
    await page.waitForTimeout(300);
    expect(asked.sites).toBe(0);
  });

  test('скрытые обложки (H): размыто всё, края обложки нет; обложки не тянутся и не обрезаются; край рисуется из самой обложки', async ({ page }) => {
    await mock(page);
    await openHome(page);
    await openPick(page);
    await expect(page.locator('.pick-cover img')).toBeVisible();
    await expect(page.locator('.pick-cover img')).toHaveCSS('object-fit', 'contain');
    await expect(page.locator('.pick-thumb img').first()).toHaveCSS('object-fit', 'contain');
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.pick-mosaic.across');
      return canvas && canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] > 0;
    });
    await expect(page.locator('.pick-mosaic.across')).toBeVisible();

    await page.keyboard.press('h');
    await expect(page.locator('.pick-cover img')).toHaveCSS('filter', /blur/);
    await expect(page.locator('.pick-reason .pick-proof')).toHaveCSS('filter', /blur/);
    for (const img of await page.locator('.pick-thumb img').all()) await expect(img).toHaveCSS('filter', /blur/);
    await expect(page.locator('.pick-mosaic.across')).toHaveCSS('visibility', 'hidden');
    await page.keyboard.press('h');
    await expect(page.locator('.pick-mosaic.across')).toHaveCSS('visibility', 'visible');
  });

  test('вкус ещё не известен — честная строка; у игры без причин — своя; игра без обложки — заглушка', async ({ page }) => {
    await mock(page, { library: (route) => route.fulfill({ json: { ...LIBRARY, cold: true, items: [{ id: 'Tidecaller', score: 0, reasons: [] }, LIBRARY.items[1]] } }) });
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      games.find((g) => g.id === 'Tidecaller').cover = '';
      await route.fulfill({ response: res, json: games });
    });
    await openHome(page);
    await openPick(page);
    await expect(page.locator('.pick-reason').first()).toContainText('почти ни во что не играли');
    await expect(page.locator('.pick-cover .pick-empty')).toHaveText('RPG');
    await expect(page.locator('.pick-mosaic.across')).toHaveCount(1);
  });

  test('игра мимика — первой, даже без причин', async ({ page }) => {
    await mock(page, { library: (route) => route.fulfill({ json: { ...LIBRARY, items: [LIBRARY.items[1], LIBRARY.items[2]], resume: [] } }) });
    await openHome(page);
    for (let i = 0; i < 5; i += 1) await page.locator('.brand').click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('.pick-name')).not.toHaveText('');
    const first = await page.locator('.pick-name').textContent();
    // Что выплюнет мимик — случайно; «Другую» с него уводит к началу подбора, если он сам не из подбора
    if (!['Seven Keys', 'Dragon Post Office'].includes(first)) {
      await expect(page.locator('.pick-reason').first()).toContainText('Особых причин нет');
      await page.locator('.pick-actions .meta-status-btn', { hasText: 'Другую' }).click();
      await expect(page.locator('.pick-name')).toHaveText('Seven Keys');
    }
  });

  test('клавиатура: все действия достижимы Tab, окно фокус не выпускает', async ({ page }) => {
    await mock(page);
    await openHome(page);
    await openPick(page);
    const seen = new Set();
    for (let i = 0; i < 45; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        return { inside: !!el.closest('.play-pick'), name: `${el.className} ${(el.getAttribute('aria-label') || el.textContent || '').slice(0, 20)}` };
      });
      expect(info.inside, info.name).toBe(true);
      seen.add(info.name);
    }
    const all = [...seen].join('\n');
    for (const needle of ['modal-close', 'pick-play', 'pick-skip', 'pick-tile']) expect(all).toContain(needle);
  });

  test.describe('вид', () => {
    const LONG = 'A Very Long Game Title That Keeps Going Well Past Any Reasonable Length For One Tile In The Row';
    // Обложки по адресам ниже: 404 и портретная
    const covers = async (page, change) => page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      change(games);
      await route.fulfill({ response: res, json: games });
    });
    const tall = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#a33"/></svg>';

    test('обложка и доказательство не отвечают: значка битой картинки нет, картинка прозрачна', async ({ page }) => {
      await mock(page);
      await page.route(/\/test-broken\//, (route) => route.fulfill({ status: 404, body: '' }));
      await covers(page, (games) => { for (const g of games) g.cover = `test-broken/${g.id}.png`; });
      await openHome(page);
      await openPick(page);
      await expect(page.locator('.pick-cover img')).toHaveCSS('opacity', '0');
      await expect(page.locator('.pick-thumb img').first()).toHaveCSS('opacity', '0');
      await expect(page.locator('.pick-proof')).toHaveCSS('opacity', '0');
    });

    test('портретная обложка: мозаики нет, широкая — есть', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await mock(page);
      await page.route(/\/test-tall\//, (route) => route.fulfill({ contentType: 'image/svg+xml', body: tall }));
      await covers(page, (games) => { games.find((g) => g.id === 'Moonlit_Library').cover = 'test-tall/cover.svg'; });
      await openHome(page);
      await openPick(page);
      await expect(page.locator('.pick-cover img.loaded')).toBeVisible();
      await page.waitForTimeout(150);
      const painted = () => page.locator('.pick-mosaic.across').evaluate((c) => c.getContext('2d').getImageData(0, 0, 1, 1).data[3] > 0);
      expect(await painted()).toBe(false);
      await page.locator('.pick-actions .meta-status-btn', { hasText: 'Другую' }).click();
      await expect(page.locator('.pick-cover img.loaded')).toBeVisible();
      await expect.poll(painted).toBe(true);
    });

    test('теги причины не ломаются посреди слова: немецкий, 320 и окно 1040', async ({ page }) => {
      const tagged = { ...LIBRARY, items: [{ ...LIBRARY.items[3], reasons: [{ code: 'tags-like', params: { tags: ['exploration', 'crafting', 'turn based combat'], game: LONG, gameId: 'The_Lantern_Road' } }] }, ...LIBRARY.items.slice(4)] };
      await mock(page, { library: (route) => route.fulfill({ json: tagged }) });
      await page.addInitScript(() => localStorage.setItem('rpg_lang', 'de'));
      for (const [width, height] of [[320, 568], [1280, 800]]) {
        await page.setViewportSize({ width, height });
        await page.goto('/');
        await expect(page.locator('.shelf-card').first()).toBeVisible();
        await page.locator('.header-menu-btn').click();
        await page.locator('.header-menu-item').filter({ hasText: /Was spielen/ }).click();
        await expect(page.locator('.pick-tags span').first()).toBeVisible();
        const heights = await page.locator('.pick-tags span').evaluateAll((list) => list.map((el) => el.getBoundingClientRect().height));
        const line = Math.min(...heights);
        for (const value of heights) expect(value, `${width}`).toBeLessThan(line * 1.5);
        await expect(page.locator('.pick-tags span').first()).toHaveCSS('white-space', 'nowrap');
        await closePick(page);
      }
    });

    test('длинная причина и автор в плитке: не больше двух строк и одной; полный текст в подсказке', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const longTile = { ...LIBRARY, items: [LIBRARY.items[0], { ...LIBRARY.items[3], reasons: [{ code: 'tags-like', params: { tags: ['exploration', 'crafting', 'turn based combat'], game: LONG, gameId: 'The_Lantern_Road' } }] }, ...LIBRARY.items.slice(4)] };
      await mock(page, { library: (route) => route.fulfill({ json: longTile }) });
      await covers(page, (games) => { games.find((g) => g.id === 'Wanderers_Almanac').developer = `${LONG} ${LONG}`; });
      await openHome(page);
      await openPick(page);
      const tile = page.locator('.pick-tile', { hasText: 'Wanderer' });
      const why = tile.locator('.pick-why');
      await expect(why).toHaveAttribute('data-tip', new RegExp(LONG));
      const height = await why.evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
      expect(height).toBeLessThanOrEqual(2.05);
      const meta = await tile.locator('.pick-tile-meta').evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
      expect(meta).toBeLessThanOrEqual(1.05);
    });

    test('окно прижато к верху: при переборе «Другую» его верх на месте, даже когда причины в плитках разной длины', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const long = (item) => ({ ...item, reasons: [{ code: 'tags-like', params: { tags: ['exploration', 'crafting'], game: LONG, gameId: 'The_Lantern_Road' } }] });
      await mock(page, { library: (route) => route.fulfill({ json: { ...LIBRARY, items: LIBRARY.items.map((x, i) => (i % 3 === 1 ? long(x) : x)) } }) });
      await openHome(page);
      await openPick(page);
      const next = page.locator('.pick-actions .meta-status-btn', { hasText: 'Другую' });
      const tops = new Set();
      for (let i = 0; i < 6; i += 1) {
        tops.add(Math.round((await dialog(page).boundingBox()).y));
        await next.click();
      }
      expect([...tops]).toHaveLength(1);
    });

    test('немецкий, окно 1040: четвёртая кнопка не падает на отдельную строку', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.addInitScript(() => localStorage.setItem('rpg_lang', 'de'));
      await mock(page);
      await page.goto('/');
      await expect(page.locator('.shelf-card').first()).toBeVisible();
      await page.locator('.header-menu-btn').click();
      await page.locator('.header-menu-item').filter({ hasText: /Was spielen/ }).click();
      await expect(page.locator('.pick-name')).toBeVisible();
      const play = await page.locator('.pick-play').boundingBox();
      const skip = await page.locator('.pick-skip').boundingBox();
      expect(Math.abs(skip.y - play.y)).toBeLessThanOrEqual(4);
    });

    test('пока идёт ответ: шесть плашек той же ширины и высоты, что настоящие плитки', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      await mock(page, { library: async (route) => { await hold; return route.fulfill({ json: { ...LIBRARY, resume: [] } }); } });
      await openHome(page);
      await menu(page, 'Во что поиграть?');
      const tiles = page.locator('.pick-strip .pick-tile');
      await expect(tiles).toHaveCount(6);
      const before = await tiles.first().boundingBox();
      const windowBefore = await dialog(page).boundingBox();
      release();
      await expect(page.locator('.pick-name')).toBeVisible();
      const after = await tiles.first().boundingBox();
      const windowAfter = await dialog(page).boundingBox();
      expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(16);
      expect(Math.abs(windowAfter.height - windowBefore.height)).toBeLessThanOrEqual(60);
    });

    test('телефон 320: после «Другую» и плитки новая игра видна сверху', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await mock(page);
      await openHome(page);
      await page.locator('.header-menu-btn').click();
      await page.locator('.header-menu-item').filter({ hasText: 'Во что поиграть' }).click();
      await expect(page.locator('.pick-name')).toBeVisible();
      const seen = async () => {
        await page.waitForTimeout(100);
        const stage = await page.locator('.pick-stage').boundingBox();
        expect(Math.round(stage.y)).toBeGreaterThanOrEqual(0);
        expect(stage.y).toBeLessThan(568 / 2);
      };
      const tile = page.locator('.pick-strip .pick-tile').last();
      await tile.scrollIntoViewIfNeeded();
      await tile.click();
      await seen();
      const next = page.locator('.pick-actions .meta-status-btn', { hasText: 'Другую' });
      await next.scrollIntoViewIfNeeded();
      await next.click();
      await seen();
      await page.locator('.pick-skip').scrollIntoViewIfNeeded();
      await page.locator('.pick-skip').click();
      await seen();
    });
  });

  test.describe('телефон 390', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('нет прокрутки вбок ни на русском, ни на немецком, ни с длинным названием; кнопки на месте', async ({ page }) => {
      const long = 'Очень длинное название игры, которое никак не помещается в одну строку и всё ещё не кончилось ReallyLongWordWithoutAnySpacesAtAllAndThenSomeMoreLettersUntilItBreaks';
      await mock(page, {
        library: (route) => route.fulfill({ json: { ...LIBRARY, items: [{ ...LIBRARY.items[0], reasons: [
          { code: 'same-dev', params: { dev: 'x', game: long, gameId: 'Starfall_Inn', playtime: 500 * HOUR } },
          { code: 'favorite-tags', params: { tags: [long, 'mystery', 'puzzle'] } },
        ] }, ...LIBRARY.items.slice(1)] } }),
      });
      await page.route(/\/api\/games(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const res = await route.fetch();
        const games = await res.json();
        const g = games.find((x) => x.id === 'Moonlit_Library');
        g.title = long;
        g.displayTitle = long;
        await route.fulfill({ response: res, json: games });
      });
      for (const lang of ['ru', 'de', 'en']) {
        await page.addInitScript((value) => localStorage.setItem('rpg_lang', value), lang);
        await page.goto('/');
        await expect(page.locator('.shelf-card').first()).toBeVisible();
        await page.locator('.header-menu-btn').click();
        await page.locator('.header-menu-item').filter({ hasText: /Во что поиграть|Was spielen|What to play/ }).click();
        await expect(page.locator('.pick-name')).toBeVisible();
        const box = await dialog(page).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, width: el.getBoundingClientRect().width }));
        expect(box.scroll, lang).toBeLessThanOrEqual(box.client);
        expect(box.width).toBe(390);
        await expect(page.locator('.pick-play')).toBeVisible();
        // Сцена не сжимается под высоту экрана: окно листается целиком
        const stage = await page.locator('.pick-stage').boundingBox();
        expect(stage.height, lang).toBeGreaterThan(400);
        await closePick(page);
      }
    });
  });

  // Снимки настоящего окна — для глаза, сравнить с макетом (report не в git)
  test.describe('снимки', () => {
    const shots = [
      ['ru-1440', 'ru', 1440, 900, {}],
      ['ru-1920', 'ru', 1920, 1080, {}],
      ['de-1440', 'de', 1440, 900, {}],
      ['ru-1440-hidden', 'ru', 1440, 900, { hidden: true }],
      ['ru-phone', 'ru', 390, 844, { full: true }],
      ['de-phone', 'de', 390, 844, { full: true }],
      ['ru-phone-hidden', 'ru', 390, 844, { full: true, hidden: true }],
    ];
    for (const [name, lang, width, height, opt] of shots) {
      test(`снимок ${name}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await mock(page);
        await page.addInitScript((value) => localStorage.setItem('rpg_lang', value), lang);
        if (opt.hidden) await page.addInitScript(() => localStorage.setItem('rpg_blur', '1'));
        await page.goto('/');
        await expect(page.locator('.shelf-card').first()).toBeVisible();
        await page.locator('.header-menu-btn').click();
        await page.locator('.header-menu-item').filter({ hasText: /Во что поиграть|Was spielen/ }).click();
        await expect(page.locator('.pick-name')).toBeVisible();
        await imagesLoaded(page);
        await page.waitForTimeout(200);
        if (opt.full) {
          // Окно во весь экран листается внутри себя: для снимка раскрываем его на всю высоту
          const h = await dialog(page).evaluate((el) => el.scrollHeight);
          await page.setViewportSize({ width, height: Math.min(h + 2, 3000) });
          await page.waitForTimeout(100);
        }
        await page.screenshot({ path: `e2e/report/pick-${name}.png` });
      });
    }
  });
});
