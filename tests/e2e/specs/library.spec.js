import { test, expect, openHome, openLibrary, openFilters, apiGames, noHot } from '../fixtures.js';

const cards = (page) => page.locator('.library > .game-card');
const titles = (page) => cards(page).locator('.card-title').allTextContents();
const titleOf = (g) => g.displayTitle || g.title;

// Кто во что играл: сцена и список зависят от времени запуска, а другие тесты запускают игры. ids — от последней запущенной,
// остальные не запускались. patch — поля отдельных игр (id → поля); читается на каждый запрос, его можно менять между загрузками
const playedOrder = (page, ids, patch = {}) => page.route(/\/api\/games(\?.*)?$/, async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const games = await res.json();
  const now = Date.now();
  await route.fulfill({ response: res, json: games.map((g) => {
    const at = ids.indexOf(g.id);
    return { ...g, ...(at < 0 ? { lastPlayed: 0, playtime: 0, status: '' } : { lastPlayed: now - at * 3600e3 }), ...patch[g.id] };
  }) });
});

test.describe('главная', () => {

  test('сцена и одна полка «Что дальше» с переключателем, по шесть; подборка запоминается; сетки всех игр нет', async ({ page }) => {
    const games = await apiGames(page);
    const name = titleOf;
    await openHome(page);
    const last = [...games].sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
    await expect(page.locator('.continue-strip .continue-title')).toHaveText(name(last));
    // Своя полка — одна; подборки без игр (обновлений в демо нет) не показываются
    await expect(page.locator('.shelves:not(.home-hot) section.shelf')).toHaveCount(1);
    const yours = page.locator('section.shelf[aria-label="Что дальше"]');
    const fresh = games.filter((g) => !g.status && !g.lastPlayed && !g.playtime);
    await expect(yours.locator('.shelf-tabs .chip')).toHaveText([`Не начато${fresh.length}`, 'Добавленные']);
    await expect(yours.locator('.shelf-tabs .chip.active')).toHaveText(`Не начато${fresh.length}`);
    const names = await yours.locator('.shelf-name').allTextContents();
    expect(names.length).toBeLessThanOrEqual(6);
    expect(names).not.toContain(name(last));
    // Другая подборка — и она же после перезагрузки
    await yours.locator('.shelf-tabs .chip', { hasText: 'Добавленные' }).click();
    const added = [...games].sort((a, b) => b.addedAt - a.addedAt).slice(0, 6).map(name);
    await expect(yours.locator('.shelf-name')).toHaveText(added);
    await page.reload();
    await expect(yours.locator('.shelf-tabs .chip.active')).toHaveText('Добавленные');
    await expect(cards(page)).toHaveCount(0);
  });

  test('«Недавно играли»: до четырёх строк без игры на сцене; строка — окно игры, «Все игры» — библиотека, отметка — запуск', async ({ page }) => {
    const games = await apiGames(page);
    const order = games.slice(0, 6);
    await playedOrder(page, order.map((g) => g.id));
    await openHome(page);
    await expect(page.locator('.continue-title')).toHaveText(titleOf(order[0]));
    const rows = page.locator('.recent-row');
    await expect(rows.locator('.recent-name')).toHaveText(order.slice(1, 5).map(titleOf));
    // Наиграно, а нет времени — когда запускали
    await expect(rows.first().locator('.recent-note')).not.toBeEmpty();
    // Список рядом со сценой и той же высоты
    const [stage, list] = await Promise.all(['.continue-strip', '.home-recent'].map((sel) => page.locator(sel).boundingBox()));
    expect(list.x).toBeGreaterThanOrEqual(stage.x + stage.width);
    expect(Math.abs(list.height - stage.height)).toBeLessThanOrEqual(1);
    expect(list.width).toBeLessThanOrEqual(330);
    // Обложки скрыты — и здесь
    await page.keyboard.press('h');
    await expect(rows.first().locator('.recent-thumb img')).toHaveCSS('filter', /blur/);
    await page.keyboard.press('h');
    // Строка — окно игры
    await rows.first().locator('.recent-name').click();
    await expect(page.locator('#modal-title')).toHaveText(titleOf(order[1]));
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-content')).toHaveCount(0);
    // С клавиатуры — так же
    await rows.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#modal-title')).toHaveText(titleOf(order[2]));
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-content')).toHaveCount(0);
    // «Все игры» — библиотека по времени запуска
    await page.locator('.recent-all').click();
    await expect(page.locator('.nav-tab.active')).toContainText('Библиотека');
    await expect(page.locator('.picker.sort-order .picker-btn')).toContainText('Недавно играли');
    await page.goBack();
    await expect(page.locator('.nav-tab.active')).toContainText('Главная');
    // Отметка — сразу в игру, окно игры не открывается
    const launch = page.waitForRequest((req) => req.method() === 'POST' && req.url().includes('/api/play/'));
    await rows.nth(1).locator('.recent-play').click();
    expect((await launch).url()).toContain(encodeURIComponent(order[2].id));
    await expect(page.locator('.game-frame iframe')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.modal-content')).toHaveCount(0);
  });

  test('сыграна одна игра: списка нет, сцена во всю ширину, кадр не разрастается', async ({ page }) => {
    const games = await apiGames(page);
    await playedOrder(page, [games[0].id]);
    await openHome(page);
    await expect(page.locator('.continue-title')).toHaveText(titleOf(games[0]));
    await expect(page.locator('.home-recent')).toHaveCount(0);
    const [stage, cover, shelf] = await Promise.all(['.continue-strip', '.continue-cover', 'section.shelf[aria-label="Что дальше"]'].map((sel) => page.locator(sel).boundingBox()));
    expect(Math.abs(stage.width - shelf.width)).toBeLessThanOrEqual(1);
    expect(cover.width).toBeLessThanOrEqual(513);
  });

  test('ни во что не играли: сцены нет, главная начинается с «Что дальше», первой открыта «Добавленные» (issue #17)', async ({ page }) => {
    await playedOrder(page, []);
    await openHome(page);
    await expect(page.locator('.home-top')).toHaveCount(0);
    await expect(page.locator('.continue-strip')).toHaveCount(0);
    const shelf = page.locator('section.shelf[aria-label="Что дальше"]');
    await expect(shelf.locator('.shelf-tabs .chip')).toHaveText(['Добавленные', /^Не начато/]);
    await expect(shelf.locator('.shelf-tabs .chip.active')).toHaveText('Добавленные');
    expect((await shelf.boundingBox()).y).toBeLessThan(120);
  });

  test('запомненная вкладка «Недавно играли», которой больше нет, — открывается первая', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('rpg_shelf', 'played'));
    await openHome(page);
    const shelf = page.locator('section.shelf[aria-label="Что дальше"]');
    await expect(shelf.locator('.shelf-tabs .chip.active')).toContainText('Не начато');
    await expect(shelf.locator('.shelf-tabs .chip', { hasText: 'Недавно играли' })).toHaveCount(0);
    await expect(shelf.locator('.shelf-card').first()).toBeVisible();
  });

  test('«Во что поиграть?» — на каждой вкладке', async ({ page }) => {
    const games = await apiGames(page);
    const patch = { [games[1].id]: { lists: ['Вечер'] } };
    await playedOrder(page, [games[0].id], patch);
    await openHome(page);
    const shelf = page.locator('section.shelf[aria-label="Что дальше"]');
    await expect(shelf.locator('.shelf-tabs .chip')).toHaveCount(3);
    for (const tab of ['Добавленные', 'Вечер', 'Не начато']) {
      await shelf.locator('.shelf-tabs .chip', { hasText: tab }).click();
      await expect(shelf.locator('.shelf-tools .shelf-random'), tab).toBeVisible();
    }
    await shelf.locator('.shelf-random').click();
    await expect(page.locator('.play-pick')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.play-pick')).toHaveCount(0);
  });


  test('сцена: под ней виден первый ряд обложек; на 1920 и 2560 она не растёт вслед за шириной', async ({ page }) => {
    // Сцена и список на месте при любом порядке тестов: другие запускают игры, и сыгранного может не оказаться
    await playedOrder(page, (await apiGames(page)).slice(0, 5).map((g) => g.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const shelf = page.locator('section.shelf[aria-label="Что дальше"]');
    await expect(page.locator('.continue-strip')).toBeVisible();
    expect((await page.locator('.continue-strip').boundingBox()).height).toBeLessThanOrEqual(400);
    const head = await shelf.locator('.shelf-head').boundingBox();
    const cover = await shelf.locator('.shelf-cover').first().boundingBox();
    expect(head.y).toBeGreaterThan(0);
    expect(cover.y + cover.height).toBeLessThanOrEqual(900);
    for (const [width, height] of [[1920, 1080], [2560, 1440]]) {
      await page.setViewportSize({ width, height });
      // Прямоугольники — в точках экрана, стили — в точках вёрстки: на широком экране делим на масштаб
      await expect.poll(() => page.evaluate(() => {
        const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
        return document.querySelector('.continue-strip').getBoundingClientRect().height / zoom;
      }), { message: `${width}px` }).toBeLessThanOrEqual(420);
      const bottom = await shelf.locator('.shelf-cover').first().evaluate((el) => el.getBoundingClientRect().bottom);
      expect(bottom, `${width}px`).toBeLessThanOrEqual(height);
    }
  });

  test('кадр сцены: вертикальная обложка целиком; нет обложки — первый скриншот и его нет в ряду; нет и скриншотов — заглушка', async ({ page }) => {
    const patch = {};
    await playedOrder(page, ['Starfall_Inn'], patch);
    await page.route(/tall-cover\.svg/, (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="#c9a84c"/></svg>' }));
    await openHome(page);
    const art = page.locator('.continue-cover');
    // Обычная обложка — на весь кадр, без пикселизации: это картинка игры, а не пиксель-арт
    await expect(art.locator('img')).toHaveCSS('object-fit', 'cover');
    await expect(art.locator('img')).toHaveCSS('image-rendering', 'auto');
    await expect(page.locator('.continue-shot')).toHaveCount(3);
    const box = await art.boundingBox();
    expect(box.width / box.height).toBeGreaterThan(1.5);

    patch.Starfall_Inn = { cover: 'tall-cover.svg' };
    await page.reload();
    await expect(art).toHaveClass(/whole/);
    await expect(art.locator('img')).toHaveCSS('object-fit', 'contain');

    patch.Starfall_Inn = { cover: '' };
    await page.reload();
    await expect(art.locator('img')).not.toHaveAttribute('src', /tall-cover/);
    await expect(page.locator('.continue-shot')).toHaveCount(2);
    // Номера — как в окне игры: первый из оставшихся скриншотов — второй
    await page.locator('.continue-shot').first().click();
    await expect(page.locator('.lightbox-counter')).toHaveText('2 / 3');
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-content')).toHaveCount(0);

    patch.Starfall_Inn = { cover: '', screens: [] };
    await page.reload();
    await expect(art.locator('.shelf-empty')).toBeVisible();
    await expect(art.locator('img')).toHaveCount(0);
    await expect(page.locator('.continue-shot')).toHaveCount(0);
  });

  test('заметка на сцене — одной строкой, сцена от неё не растёт; жанров на сцене нет', async ({ page }) => {
    const patch = {};
    await playedOrder(page, ['Starfall_Inn'], patch);
    await openHome(page);
    const stage = page.locator('.continue-strip');
    const before = (await stage.boundingBox()).height;
    patch.Starfall_Inn = { notes: 'застрял в пещере, нужен ключ\nи ещё одна строка '.repeat(20), tags: ['особый-жанр'] };
    await page.reload();
    const note = page.locator('.continue-note');
    await expect(note).toBeVisible();
    expect((await note.boundingBox()).height).toBeLessThanOrEqual(26);
    await expect(stage).not.toContainText('особый-жанр');
    expect((await stage.boundingBox()).height).toBeLessThanOrEqual(before + 26);
  });

  test('сцена с полными данными: кадр ровно 16:10, баннер целиком, длинное слово с многоточием, уровень виден, два скриншота — как три', async ({ page }) => {
    const banner = /wide-banner\.svg/;
    await page.route(banner, (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="256"><rect width="768" height="256" fill="#c9a84c"/></svg>' }));
    const patch = {};
    await playedOrder(page, ['Starfall_Inn'], patch);
    await page.setViewportSize({ width: 1100, height: 900 });
    await openHome(page);
    const shots = page.locator('.continue-shot');
    await expect(shots).toHaveCount(3);
    const three = (await shots.first().boundingBox()).width;
    const { screens } = (await apiGames(page)).find((g) => g.id === 'Starfall_Inn');
    patch.Starfall_Inn = {
      cover: 'wide-banner.svg',
      screens: screens.slice(0, 2),
      displayTitle: 'Очень_длинное_имя_файла_без_пробелов_'.repeat(6),
      notes: 'заметка',
      progress: { map: 'Крыша старого трактира, кухня и задний двор у самой реки', level: 12 },
    };
    await page.reload();
    const art = page.locator('.continue-cover');
    await expect(art.locator('img')).toHaveCSS('object-fit', 'contain');
    const box = await art.boundingBox();
    expect(Math.abs(box.width / box.height - 1.6)).toBeLessThanOrEqual(0.02);
    await expect(shots).toHaveCount(2);
    expect(Math.abs((await shots.first().boundingBox()).width - three)).toBeLessThanOrEqual(1);
    const fits = (el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
    expect(await page.locator('.continue-title').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const where = page.locator('.continue-where > span');
    await expect(where).toContainText('12');
    expect(await where.evaluate(fits)).toBe(true);
  });

  test('«Галерея» и «Сейвы» на немецком при 1100 стоят рядом с «Играть»; подпись остаётся в подсказке', async ({ page }) => {
    await playedOrder(page, ['Starfall_Inn']);
    await page.setViewportSize({ width: 1100, height: 900 });
    await openHome(page);
    await page.evaluate(() => localStorage.setItem('rpg_lang', 'de'));
    await page.reload();
    const more = page.locator('.continue-more button').first();
    await expect(more).toBeVisible();
    await expect(more).toHaveAccessibleName(/Galerie/);
    const [play, side] = await Promise.all([page.locator('.continue-btn').boundingBox(), more.boundingBox()]);
    expect(Math.abs((side.y + side.height / 2) - (play.y + play.height / 2))).toBeLessThanOrEqual(2);
    expect(side.x).toBeGreaterThanOrEqual(play.x + play.width);
  });

  test('шапка «Что дальше»: название в одну строку, вкладки не уходят под кнопки', async ({ page }) => {
    await playedOrder(page, ['Starfall_Inn']);
    await openHome(page);
    const head = page.locator('section.shelf[aria-label="Что дальше"] .shelf-head');
    for (const width of [768, 900, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => head.evaluate((el) => {
        const title = el.querySelector('.shelf-title');
        const tabs = el.querySelector('.shelf-tabs');
        const tools = el.querySelector('.shelf-tools').getBoundingClientRect();
        // Одна строка заголовка, и вкладки либо левее кнопок, либо своей строкой ниже
        const oneLine = title.getBoundingClientRect().height <= parseFloat(getComputedStyle(title).lineHeight) * 1.5;
        const box = tabs.getBoundingClientRect();
        return oneLine && (box.top >= tools.bottom - 1 || tabs.scrollWidth <= tabs.clientWidth + 1 && box.right <= tools.left + 1);
      }), { message: `${width}px` }).toBe(true);
    }
  });

  test('«Недавно играли»: строки заполняют высоту сцены, заголовок вровень с картинками', async ({ page }) => {
    await playedOrder(page, (await apiGames(page)).slice(0, 5).map((g) => g.id));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openHome(page);
    const rows = page.locator('.recent-row');
    await expect(rows).toHaveCount(4);
    const [last, all, title, thumb] = await Promise.all([rows.last().boundingBox(), page.locator('.recent-all').boundingBox(), page.locator('.home-recent .shelf-title').boundingBox(), rows.first().locator('.recent-thumb').boundingBox()]);
    expect(all.y - (last.y + last.height)).toBeLessThanOrEqual(16);
    const left = await page.locator('.home-recent .shelf-title').evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    expect(title.x).toBeLessThan(thumb.x);
    expect(Math.abs(left - thumb.x)).toBeLessThanOrEqual(1);
  });

  test('узкое окно: панель на своём месте, список под сценой в две колонки, страница вбок не листается', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await openHome(page);
    const header = await page.locator('header').boundingBox();
    expect((await page.locator('.search-box').boundingBox()).y).toBeGreaterThanOrEqual(header.y + header.height);
    const stage = await page.locator('.continue-strip').boundingBox();
    const rows = page.locator('.recent-row');
    const [a, b] = await Promise.all([rows.nth(0).boundingBox(), rows.nth(1).boundingBox()]);
    expect(a.y).toBeGreaterThanOrEqual(stage.y + stage.height);
    expect(a.y).toBe(b.y);
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);
    await expect(page.locator('.recent-all')).toBeVisible();
    const shelf = await page.locator('section.shelf[aria-label="Что дальше"]').boundingBox();
    expect(shelf.y).toBeGreaterThanOrEqual(a.y + a.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('шапка полки раскладывается по месту: в строку, под названием, значками; подписи не переносятся, ничего не наезжает', async ({ page }) => {
    await openHome(page);
    const head = page.locator('section.shelf[aria-label="Что дальше"] .shelf-head');
    for (const [width, allowed] of [[1200, ['row']], [800, ['row', 'stacked']], [600, ['row', 'stacked', 'compact']], [360, ['stacked', 'compact']]]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => allowed.includes(await head.getAttribute('data-layout')), { message: `${width}px` }).toBe(true);
      // Шапка перемеряется на следующем кадре после смены ширины (ResizeObserver), и каждая полка — своим:
      // ждём, пока раскладка устоится, а не проверяем сразу
      await expect.poll(() => page.evaluate(() => {
        const out = [];
        const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        for (const h of document.querySelectorAll('.shelf-head[data-layout]')) {
          const chips = [...h.querySelectorAll('.chip')];
          for (const c of chips) {
            const label = c.querySelector('.shelf-tab-label') || c;
            const line = parseFloat(getComputedStyle(label).lineHeight) || 20;
            if (label.getClientRects().length && label.getBoundingClientRect().height > line * 1.6) out.push(`перенос: ${c.textContent}`);
          }
          for (const tool of h.querySelectorAll('.shelf-arrow, .shelf-all')) {
            for (const c of chips) if (hit(tool.getBoundingClientRect(), c.getBoundingClientRect())) out.push(`наезжает: ${tool.textContent || tool.ariaLabel} на ${c.textContent}`);
          }
        }
        if (document.documentElement.scrollWidth > innerWidth) out.push('страница листается вбок');
        return out;
      }), { message: `${width}px` }).toEqual([]);
    }
  });

  test('«Все игры» — библиотека по времени запуска; «назад» — снова главная', async ({ page }) => {
    const games = await apiGames(page);
    await openHome(page);
    await page.locator('.recent-all').click();
    await expect(page.locator('.nav-tab.active')).toContainText('Библиотека');
    await expect(page.locator('.picker.sort-order .picker-btn')).toContainText('Недавно играли');
    const recent = [...games].sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
    await expect(cards(page).first()).toContainText(recent.displayTitle || recent.title);
    await expect(cards(page)).toHaveCount(games.length);

    await page.goBack();
    await expect(page.locator('.nav-tab.active')).toContainText('Главная');
    await expect(page.locator('.shelf-card').first()).toBeVisible();

    // Вся библиотека — вкладка в шапке; отдельной большой кнопки внизу главной нет
    await expect(page.locator('.home-all-btn')).toHaveCount(0);
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(cards(page)).toHaveCount(games.length);
  });

  test('«Не начато»: только не запускавшиеся, «Все» — библиотека с этим статусом', async ({ page }) => {
    const games = await apiGames(page);
    const fresh = games.filter((g) => !g.status && !g.lastPlayed && !g.playtime);
    await openHome(page);
    const shelf = page.locator('section.shelf[aria-label="Что дальше"]');
    await shelf.locator('.shelf-tabs .chip', { hasText: 'Не начато' }).click();
    await expect(shelf.locator('.shelf-tabs .chip.active .chip-count')).toHaveText(String(fresh.length));
    for (const name of await shelf.locator('.shelf-name').allTextContents()) {
      expect(fresh.map((g) => g.displayTitle || g.title)).toContain(name);
    }
    await shelf.locator('.shelf-all', { hasText: 'Все' }).click();
    await expect(page.locator('.status-chips .chip.active')).toContainText('Не начато');
    await expect(page.locator('.status-chips .chip.active .chip-count')).toHaveText(String(fresh.length));
    await expect(cards(page)).toHaveCount(fresh.length);
  });

  test('«Продолжить»: где остановился; скриншот — сразу просмотр, «Галерея» и «Сейвы» — окно игры прямо с ними', async ({ page }) => {
    // В «Продолжить» — Starfall Inn: тесты раньше запускали другие игры, а место в сейве есть у неё
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      games.find((g) => g.id === 'Starfall_Inn').lastPlayed = Date.now();
      await route.fulfill({ response: res, json: games });
    });
    await openHome(page);
    const card = page.locator('.home-continue');
    // Где остановился — место из последнего сейва и уровень
    await expect(card.locator('.continue-where')).toHaveText('Rooftop Kitchen ур. 12');
    await card.locator('.continue-shot').first().click();
    await expect(page.locator('.lightbox-counter')).toHaveText('1 / 3');
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-content')).toHaveCount(0);
    await card.locator('.continue-more button', { hasText: 'Галерея' }).click();
    await expect(page.locator('.gallery')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.gallery')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-content')).toHaveCount(0);
    // «Сейвы» — окно игры с раскрытым «Продолжить с…»; оттуда — история сейвов
    await card.locator('.continue-more button', { hasText: 'Сейвы' }).click();
    await expect(page.locator('.continue-from-panel')).toBeVisible();
    await page.locator('.continue-from-all:not(.continue-from-title)').click();
    await expect(page.locator('.save-history')).toBeVisible();
  });

  test('«Продолжить»: «Где вышли» посреди сцены — под «Играть» реплика, на которой вышли', async ({ page }) => {
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      games.find((g) => g.id === 'Starfall_Inn').lastPlayed = Date.now();
      await route.fulfill({ response: res, json: games });
    });
    await page.route(/\/api\/saves\/history\/Starfall_Inn$/, (route) => route.fulfill({ json: { slots: [{ key: 'RPG File1', shot: false, versions: [], current: { at: 2000, summary: { map: 'Hall' } } }] } }));
    await page.route(/\/api\/marks\/Starfall_Inn$/, (route) => route.fulfill({ json: [{ id: 'e1', kind: 'auto', why: 'exit', mid: true, label: 'Ты опять опоздал', map: 'Hall', at: Date.now(), save: true }] }));
    await openHome(page);
    await expect(page.locator('.home-continue .continue-resume')).toContainText('С места, где вышли: Ты опять опоздал');
  });

  test('знак Mimikin — на главную; «Продолжить» — окно игры', async ({ page }) => {
    const games = await apiGames(page);
    const last = [...games].sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
    await openLibrary(page);
    await page.locator('.brand').click();
    await expect(page.locator('.nav-tab.active')).toContainText('Главная');
    await page.locator('.continue-open').click();
    await expect(page.locator('#modal-title')).toHaveText(last.displayTitle || last.title);
  });

  test('H — быстро скрыть обложки и подпись вкладки, ещё раз — вернуть; в поле ввода H — просто буква', async ({ page }) => {
    await openHome(page);
    await page.keyboard.press('h');
    await expect(page.locator('.app-container')).toHaveClass(/covers-hidden/);
    await expect(page).toHaveTitle('Документы');
    await page.keyboard.press('h');
    await expect(page.locator('.app-container')).not.toHaveClass(/covers-hidden/);
    await expect(page).toHaveTitle('Mimikin');
    await page.locator('.search-box input').click();
    await page.keyboard.type('h');
    await expect(page.locator('.app-container')).not.toHaveClass(/covers-hidden/);
  });

  test('поиск с главной сразу показывает найденное в библиотеке', async ({ page }) => {
    await openHome(page);
    await page.locator('.search-box input').fill('lantern road');
    await expect(page.locator('.nav-tab.active')).toContainText('Библиотека');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('The Lantern Road');
  });

  test('тег в окне игры с главной открывает библиотеку с этим жанром; «назад» — снова главная', async ({ page }) => {
    const games = await apiGames(page);
    await playedOrder(page, [games.find((g) => g.title === 'The Lantern Road').id]);
    await openHome(page);
    await page.locator('.continue-open').click();
    await expect(page.locator('#modal-title')).toHaveText('The Lantern Road');
    await page.locator('.tag-link', { hasText: 'mystery' }).click();
    await expect(page.locator('.modal-content')).toHaveCount(0);
    await expect(page.locator('.nav-tab.active')).toContainText('Библиотека');
    await expect(cards(page)).toHaveCount(games.filter((g) => g.tags.includes('mystery')).length);
    await page.goBack();
    await expect(page.locator('.nav-tab.active')).toContainText('Главная');
  });
});

// Главная на компьютере: поиск, «глаз» и «Добавить игру» в строке шапки. Узел один и тот же и на главной, и в библиотеке
test.describe('панель в шапке главной', () => {
  test.beforeEach(async ({ page }) => { await noHot(page); });

  // Что не так с панелью в шапке: в строке, между разделами и «⋯», ничего не потеряно. Пусто — всё верно
  const headerTrouble = (page) => page.evaluate(() => {
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
    const header = rect('header'), nav = rect('.main-nav'), side = rect('.header-side');
    const box = rect('.search-box'), eye = rect('.header-tools .cover-toggle'), add = rect('.header-tools .upload-btn');
    const out = [];
    if (getComputedStyle(document.querySelector('.controls-zone')).position !== 'fixed') out.push('панель в потоке');
    for (const [name, r] of [['поиск', box], ['глаз', eye], ['добавить', add]]) {
      if (!r.width) out.push(`${name}: не виден`);
      if (r.top < header.top || r.bottom > header.bottom) out.push(`${name}: не в строке шапки`);
      if (r.left < nav.right) out.push(`${name}: на разделах`);
    }
    if (box.right > side.left) out.push('поиск: на кнопках шапки');
    if (box.right > eye.left || eye.right > add.left) out.push('наезжают друг на друга');
    if (box.width < 110) out.push(`поле ${box.width}`);
    if (document.documentElement.scrollWidth > innerWidth) out.push('страница листается вбок');
    return out;
  });

  test('в строке шапки на трёх языках и любой ширине от 1100; ниже 1100 и в библиотеке — как раньше', async ({ page }) => {
    await openHome(page);
    for (const lang of ['ru', 'en', 'de']) {
      await page.evaluate((code) => localStorage.setItem('rpg_lang', code), lang);
      await page.reload();
      await expect(page.locator('.shelf-card').first()).toBeVisible();
      for (const width of [1100, 1201, 1440, 2560]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(() => headerTrouble(page), { message: `${lang} ${width}px` }).toEqual([]);
      }
    }
    // Значок загрузок и прочее справа в шапке отнимают место: поле уступает, а не наезжает
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.addStyleTag({ content: ".header-side::before { content: ''; width: 180px; }" });
    await expect.poll(() => headerTrouble(page)).toEqual([]);
    // На ширине ноутбука кнопка значком
    await expect(page.locator('.upload-btn-text')).toBeHidden();
    await page.addStyleTag({ content: ".header-side::before { width: 0; }" });
    await page.setViewportSize({ width: 1300, height: 900 });
    await expect(page.locator('.upload-btn-text')).toBeVisible();

    await page.setViewportSize({ width: 1099, height: 900 });
    const zone = page.locator('.controls-zone');
    await expect(zone).toHaveCSS('position', 'sticky');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(zone).toHaveCSS('position', 'fixed');
    // Вторая вкладка — «Библиотека» на любом языке: здесь открыт последний из трёх
    await page.locator('.nav-tab').nth(1).click();
    await expect(zone).toHaveCSS('position', 'sticky');
    await expect(page.locator('.controls-zone .picker').first()).toBeVisible();
  });

  test('прокрутка учитывает, что панель не в потоке: --sticky-total без неё, тени прилипшей панели нет; в библиотеке — с панелью', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 500 });
    await openHome(page);
    const total = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-total')));
    const headerHeight = await page.locator('header').evaluate((el) => el.offsetHeight);
    await expect.poll(total).toBe(headerHeight + 12);
    await page.evaluate(() => window.scrollTo(0, 200));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    expect(await page.locator('.controls-zone').getAttribute('data-stuck')).toBe('');
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect.poll(total).toBeGreaterThan(headerHeight + 52);
    await page.locator('.nav-tab', { hasText: 'Главная' }).click();
    await expect.poll(total).toBe(headerHeight + 12);
  });

  test('поиск с главной: набор уводит в библиотеку, поле то же, фокус и текст на месте', async ({ page }) => {
    await openHome(page);
    const input = page.locator('.search-box input');
    await input.evaluate((el) => { window.__searchNode = el; });
    await input.click();
    await page.keyboard.type('lantern', { delay: 30 });
    await expect(page.locator('.nav-tab.active')).toContainText('Библиотека');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('lantern');
    await page.keyboard.type(' road');
    await expect(input).toHaveValue('lantern road');
    expect(await input.evaluate((el) => el === window.__searchNode)).toBe(true);
    await expect(cards(page)).toHaveCount(1);
    // Панель уже под шапкой, а не в ней
    const header = await page.locator('header').boundingBox();
    expect((await input.boundingBox()).y).toBeGreaterThanOrEqual(header.y + header.height);
    // «/» с главной — в то же поле
    await page.locator('.nav-tab', { hasText: 'Главная' }).click();
    await page.locator('.search-clear').click();
    await page.locator('body').click({ position: { x: 4, y: 500 } });
    await page.keyboard.press('/');
    await expect(input).toBeFocused();
  });

  test('окна закрывают панель в шапке; загрузка на главной показывается как раньше', async ({ page }) => {
    // Кнопка «Во что поиграть?» — от 10 не начатых
    const games = await apiGames(page);
    await playedOrder(page, [games[0].id]);
    await openHome(page);
    // Что лежит поверх середины поля поиска
    const onTop = () => page.locator('.search-box input').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.controls-zone');
    });
    expect(await onTop()).toBe(true);
    await page.locator('.continue-open').click();
    await expect(page.locator('.modal-content')).toBeVisible();
    await expect.poll(onTop).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-content')).toHaveCount(0);
    await expect.poll(onTop).toBe(true);
    await page.locator('.shelf-random').click();
    await expect(page.locator('.play-pick')).toBeVisible();
    await expect.poll(onTop).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('.play-pick')).toHaveCount(0);
    // Плашка загрузки и выбор файла живут в той же панели
    await page.route(/\/api\/games\/upload\/start$/, (route) => {
      const { name, size } = route.request().postDataJSON();
      return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
    });
    await page.route(/\/api\/games\/upload\/status\?/, (route) => {
      const id = new URL(route.request().url()).searchParams.get('id');
      return route.fulfill({ json: { id, state: 'processing', step: 'extract', received: 1, size: 1 } });
    });
    await page.locator('.controls-zone input[type=file]').setInputFiles([{ name: 'Shown.zip', mimeType: 'application/octet-stream', buffer: Buffer.from('x') }]);
    const bar = page.locator('.tb');
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box.y + box.height).toBeGreaterThan(890);
    expect(box.width).toBeGreaterThan(300);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.upload-btn').click();
    await chooser;
  });
});

test.describe('заметки и подборки', () => {
  test('заметка сохраняется сама, видна снова и находится поиском; закрыли сразу после набора — не пропала', async ({ page }) => {
    await openLibrary(page);
    await cards(page).first().locator('.card-title').click();
    // Пустая заметка свёрнута в кнопку; нажатие открывает поле с курсором
    await expect(page.locator('#game-notes-text')).toHaveCount(0);
    await page.locator('.game-notes-add').click();
    const box = page.locator('#game-notes-text');
    await expect(box).toBeFocused();
    await box.fill('застрял в пещере, нужен ключ');
    await page.keyboard.press('Escape');
    await expect(page.locator('#game-notes-text')).toHaveCount(0);
    await expect.poll(async () => (await apiGames(page)).filter((g) => g.notes === 'застрял в пещере, нужен ключ').length).toBe(1);
    await page.getByPlaceholder('Название или тег').fill('пещере');
    await expect(cards(page)).toHaveCount(1);
    await cards(page).first().locator('.card-title').click();
    await expect(page.locator('#game-notes-text')).toHaveValue('застрял в пещере, нужен ключ');
    await page.locator('#game-notes-text').fill('');
    await page.locator('.modal-side-title').first().click();
    await expect.poll(async () => (await apiGames(page)).filter((g) => g.notes).length).toBe(0);
  });

  test('подборка: создать в окне игры, фильтр и вкладка на главной, переименовать и удалить; игры остаются', async ({ page }) => {
    await openLibrary(page);
    const total = await cards(page).count();
    await expect(page.locator('.list-filter')).toHaveCount(0);
    for (const n of [0, 1]) {
      await cards(page).nth(n).locator('.card-title').click();
      await page.locator('.game-list-add').click();
      await page.locator('.game-list-new input').fill(n ? 'на вечер' : 'На вечер');
      await page.keyboard.press('Enter');
      await expect(page.locator('.game-list-name')).toHaveText('На вечер');
      await page.keyboard.press('Escape');
      await expect(page.locator('.game-list-panel')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.game-lists')).toHaveCount(0);
    }
    await expect.poll(async () => (await apiGames(page)).filter((g) => g.lists?.includes('На вечер')).length).toBe(2);
    // Имя в окне игры ведёт в библиотеку с этой подборкой
    await cards(page).first().locator('.card-title').click();
    await page.locator('.game-list-name').first().click();
    await expect(cards(page)).toHaveCount(2);
    await expect(page.locator('.list-bar strong')).toHaveText('На вечер');
    // Вкладка на главной, «Все» — та же подборка
    await page.locator('.nav-tab', { hasText: 'Главная' }).click();
    await page.locator('.shelf-tabs button', { hasText: 'На вечер' }).click();
    await expect(page.locator('.shelf-card')).toHaveCount(2);
    await page.locator('.shelf-all', { hasText: 'Все' }).first().click();
    await expect(page.locator('.list-bar strong')).toHaveText('На вечер');
    // Переименовать: фильтр идёт за новым именем, и после перезагрузки тоже
    await page.locator('.list-bar .tag-reset', { hasText: 'Переименовать' }).click();
    await page.locator('.list-bar input').fill('Выходные');
    // Экран меняется сразу, запись идёт следом: перезагрузка раньше неё оборвала бы переименование
    const renamed = page.waitForResponse(/\/api\/games\/lists\/change/);
    await page.keyboard.press('Enter');
    await expect(page.locator('.list-bar strong')).toHaveText('Выходные');
    await expect(cards(page)).toHaveCount(2);
    await renamed;
    await page.reload();
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(page.locator('.list-bar strong')).toHaveText('Выходные');
    // Убрать игру крестиком
    await cards(page).first().locator('.card-title').click();
    await page.locator('.game-list-off').click();
    await expect(page.locator('.game-list-chip')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(cards(page)).toHaveCount(1);
    // Удалить: с вопросом, игры на месте, фильтр снят
    await page.locator('.list-bar .tag-reset', { hasText: 'Удалить подборку' }).click();
    await page.locator('.confirm-box button', { hasText: 'Удалить подборку' }).click();
    await expect(page.locator('.list-bar')).toHaveCount(0);
    await expect(cards(page)).toHaveCount(total);
    await expect(page.locator('.list-filter')).toHaveCount(0);
    await expect.poll(async () => (await apiGames(page)).filter((g) => g.lists?.length).length).toBe(0);
  });
});

test.describe('подборки: края', () => {
  test('подборка «all» работает как обычная; выбранная и удалённая не оставляет пустой библиотеки; сервер отказал — откат и сообщение', async ({ page }) => {
    await openLibrary(page);
    const total = await cards(page).count();
    const id = (await apiGames(page))[0].id;
    await page.request.post(`/api/games/${encodeURIComponent(id)}/meta`, { data: { lists: ['all'] } });
    await page.evaluate(() => localStorage.setItem('rpg_shelf', 'list:all'));
    await page.reload();
    await page.locator('.nav-tab', { hasText: 'Главная' }).click();
    await expect(page.locator('.shelf-tab.active')).toContainText('all');
    await page.locator('.shelf-all', { hasText: 'Все' }).first().click();
    await expect(cards(page)).toHaveCount(1);
    await expect(page.locator('.list-bar strong')).toHaveText('all');
    // Сервер отказал: подборка на месте, сказано об этом
    await page.route('**/api/games/lists/change', (route) => route.fulfill({ status: 500, json: { error: 'x' } }));
    await page.locator('.list-bar .tag-reset', { hasText: 'Удалить подборку' }).click();
    await page.locator('.confirm-box button', { hasText: 'Удалить подборку' }).click();
    await expect(page.locator('.toast.show')).toContainText('Не удалось изменить подборку');
    await expect(page.locator('.list-bar strong')).toHaveText('all');
    await expect(cards(page)).toHaveCount(1);
    await page.unroute('**/api/games/lists/change');
    // Подборку убрали мимо этой вкладки: после перезагрузки — вся библиотека, на главной первая вкладка, без падения
    await page.request.post('/api/games/lists/change', { data: { from: 'all' } });
    await page.reload();
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(cards(page)).toHaveCount(total);
    await expect(page.locator('.list-bar')).toHaveCount(0);
    await page.locator('.nav-tab', { hasText: 'Главная' }).click();
    await expect(page.locator('.shelf-tab.active')).toBeVisible();
  });
});

test.describe('библиотека', () => {
  test('все игры сеткой, статусы — только здесь', async ({ page }) => {
    const games = await apiGames(page);
    await openLibrary(page);
    await expect(cards(page)).toHaveCount(games.length);
    await expect(page.locator('.status-chips')).toBeVisible();
    await expect(page.locator('.shelves')).toHaveCount(0);
    await page.locator('.nav-tab', { hasText: 'Главная' }).click();
    await expect(page.locator('.status-chips')).toHaveCount(0);
    await expect(page.locator('.controls-zone .picker')).toHaveCount(0);
  });

  test('поиск по названию и по тегу, крестик очищает', async ({ page }) => {
    const games = await apiGames(page);
    await openLibrary(page);
    const search = page.locator('.search-box input');
    // «lantern road», а не «lantern»: у студии трёх игр Little Lantern поиск теперь находит и её
    await search.fill('lantern road');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('The Lantern Road');
    // Счётчик — из найденного, а не из всей библиотеки: «1 из 16» выглядело так, будто догружается ещё 15
    await expect(page.locator('.library-info')).toHaveText('Показано 1 из 1');
    // Полок главной в библиотеке нет — только найденное на сайтах
    await expect(page.locator('.shelves:not(.web-search)')).toHaveCount(0);

    await search.fill('puzzle');
    await expect(cards(page)).toHaveCount(games.filter((g) => g.tags.includes('puzzle')).length);

    await page.locator('.search-clear').click();
    await expect(search).toHaveValue('');
    await expect(cards(page)).toHaveCount(games.length);
  });

  test('чипы статусов: на каждом — сколько игр он покажет, с учётом поиска', async ({ page }) => {
    const games = await apiGames(page);
    await openLibrary(page);
    for (const [label, status] of [['Пройдено', 'done'], ['В планах', 'wish'], ['Брошено', 'dropped']]) {
      const chip = page.locator('.status-chips .chip', { hasText: label });
      const count = games.filter((g) => g.status === status).length;
      await expect(chip.locator('.chip-count')).toHaveText(String(count));
      await chip.click();
      await expect(cards(page)).toHaveCount(count);
    }
    const all = page.locator('.status-chips .chip', { hasText: 'Все' });
    await expect(all.locator('.chip-count')).toHaveText(String(games.length));
    await all.click();
    await expect(cards(page)).toHaveCount(games.length);
    await page.locator('.search-box input').fill('puzzle');
    await expect(all.locator('.chip-count')).toHaveText(String(games.filter((g) => g.tags.includes('puzzle')).length));
  });

  test('жанры: частые первыми, теги формата — в конце группой «Формат»', async ({ page }) => {
    const games = await apiGames(page);
    await openLibrary(page);
    await openFilters(page);
    await page.locator('.toolbar-filters .picker-btn').first().click();
    await expect(page.locator('.picker-opt').first()).toBeVisible();
    const names = await page.locator('.picker-opt .picker-name').allTextContents();
    const group = page.locator('.picker-opt.group-start');
    await expect(group).toHaveAttribute('data-group', 'Формат');
    const first = names.indexOf(await group.locator('.picker-name').textContent());
    // Теги-одиночки в список не попадают (App.jsx), поэтому — те теги формата, что в нём есть
    const formats = ['2dcg', '2d game', 'japanese game', 'rpg', 'rpgm'].filter((tag) => names.includes(tag));
    expect(formats.length).toBeGreaterThan(0);
    for (const format of formats) expect(names.indexOf(format)).toBeGreaterThanOrEqual(first);
    expect(names.indexOf('fantasy')).toBeLessThan(first);

    await page.locator('.picker-opt', { hasText: /^puzzle/ }).click();
    await expect(cards(page)).toHaveCount(games.filter((g) => g.tags.includes('puzzle')).length);
    await page.locator('.toolbar-filters .picker-btn').first().click();
    await page.locator('.picker-opt', { hasText: 'Все жанры' }).click();
    await expect(cards(page)).toHaveCount(games.length);
  });

  test('сортировка по алфавиту и фильтр по языку', async ({ page }) => {
    const japanese = (await apiGames(page)).filter((g) => g.textLang?.langs?.includes('ja'));
    await openLibrary(page);
    await page.locator('.picker.sort-order .picker-btn').click();
    await page.locator('.picker-opt', { hasText: 'По алфавиту' }).click();
    // По алфавиту языка интерфейса: в русском кириллица идёт раньше латиницы
    await expect(cards(page).first()).toContainText('Кристальный прилив');
    const sorted = await titles(page);
    expect(sorted).toEqual([...sorted].sort(new Intl.Collator('ru').compare));

    await openFilters(page);
    await page.locator('.picker.lang-filter .picker-btn').click();
    await page.locator('.picker-opt', { hasText: /Япон/ }).click();
    await expect(cards(page)).toHaveCount(japanese.length);
    // Японское название библиотека показывает латиницей из имени папки, если оно есть
    await expect(cards(page).first()).toContainText(japanese[0].displayTitle);
  });

  test('поиск находит и студию: «Moon Studio» — её игры, а не «Ничего не найдено»', async ({ page }) => {
    const byStudio = (await apiGames(page)).filter((g) => g.developer === 'Moon Studio');
    expect(byStudio.length).toBeGreaterThan(0);
    await openLibrary(page);
    await page.locator('.search-box input').fill('moon studio');
    await expect(cards(page)).toHaveCount(byStudio.length);
    await expect(cards(page).filter({ hasText: 'Starfall Inn' })).toHaveCount(1);
  });

  test('сортировка и жанр переживают новую вкладку; поиск — нет', async ({ page }) => {
    const games = await apiGames(page);
    await openLibrary(page);
    await page.locator('.picker.sort-order .picker-btn').click();
    await page.locator('.picker-opt', { hasText: 'По алфавиту' }).click();
    await openFilters(page);
    await page.locator('.toolbar-filters .picker-btn').first().click();
    await page.locator('.picker-opt', { hasText: /^puzzle/ }).click();
    await page.locator('.search-box input').fill('inn');
    // Новая вкладка того же браузера: localStorage общий, sessionStorage — свой
    const second = await page.context().newPage();
    await openLibrary(second);
    await expect(second.locator('.picker.sort-order .picker-btn')).toContainText('По алфавиту');
    await expect(second.locator('.search-box input')).toHaveValue('');
    const puzzles = games.filter((g) => g.tags.includes('puzzle'));
    await expect(second.locator('.library > .game-card')).toHaveCount(puzzles.length);
    const sorted = await second.locator('.library > .game-card .card-title').allTextContents();
    expect(sorted).toEqual([...sorted].sort(new Intl.Collator('ru').compare));
    await second.close();
  });

  test('язык не как у большинства игр — значок на карточке', async ({ page }) => {
    await openLibrary(page);
    await expect(cards(page).filter({ hasText: 'Кристальный прилив' }).locator('.card-lang')).toHaveText('RU');
    await expect(cards(page).filter({ hasText: 'Starfall Inn' }).locator('.card-lang')).toHaveCount(0);
  });

  test.describe('планшет', () => {
    test.use({ viewport: { width: 834, height: 1112 } });

    test('панель — поиск и «Фильтры» в одну строку, «Добавить игру» — в меню', async ({ page }) => {
      await openLibrary(page);
      await expect(page.locator('.filters-toggle')).toBeVisible();
      await expect(page.locator('.upload-btn')).toBeHidden();
      await expect(page.locator('.toolbar-filters .picker').first()).toBeHidden();
      await page.locator('.filters-toggle').click();
      await expect(page.locator('.toolbar-filters .picker').first()).toBeVisible();
      await page.locator('.header-menu-btn').click();
      await expect(page.locator('.header-menu-item', { hasText: 'Добавить игру' })).toBeVisible();
    });
  });
});

test.describe('списки панели', () => {
  test('золотая черта у кнопки списка — пока он открыт; после клика мышью и закрытия её нет', async ({ page }) => {
    await openLibrary(page);
    await openFilters(page);
    const btn = page.locator('.toolbar-filters .picker-btn').first();
    const mark = () => btn.evaluate((el) => getComputedStyle(el).backgroundSize.split(',')[0].trim());
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(mark).toBe('28px 2px');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    // Кнопка в фокусе (мышь), но метка уже ушла: она только для открытого списка и для клавиатуры
    await expect(btn).toBeFocused();
    await expect.poll(mark).toBe('0px 2px');
  });

  test('«Фильтры» на 1440: списки закрыты, сортировка рядом; число считает и подборку; открытое помнится', async ({ page }) => {
    await noHot(page);
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const json = (await res.json()).map((g, i) => ({ ...g, lists: i < 2 ? ['Моя'] : [] }));
      return route.fulfill({ response: res, json });
    });
    await openLibrary(page);
    const toggle = page.locator('.controls-zone .filters-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).not.toHaveClass(/active/);
    // Закрыто: в панели поиск, «Фильтры» и сортировка, одним рядом; жанров, языков и подборок нет
    await expect(page.locator('.toolbar-filters')).toBeHidden();
    await expect(page.locator('.controls-zone > .sort-order')).toBeVisible();
    const tops = await page.evaluate(() => ['.search-box', '.filters-toggle', '.sort-order'].map((q) => document.querySelector(`.controls-zone ${q}`).getBoundingClientRect().top));
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(12);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.toolbar-filters .list-filter')).toBeVisible();
    // Ряд под панелью, а не в её строке; сортировка осталась снаружи, один экземпляр
    const [row, search] = await page.evaluate(() => ['.toolbar-filters', '.search-box'].map((q) => document.querySelector(`.controls-zone ${q}`).getBoundingClientRect().bottom));
    expect(row).toBeGreaterThan(search);
    await expect(page.locator('.sort-order')).toHaveCount(1);
    await expect(page.locator('.toolbar-filters .sort-order')).toHaveCount(0);
    await page.locator('.list-filter .picker-btn').click();
    await page.locator('.picker-opt', { hasText: 'Моя' }).click();
    await expect(toggle.locator('.filters-count')).toHaveText('1');
    await expect(toggle).toHaveClass(/active/);
    await page.reload();
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    // Открыто осталось, как и было
    await expect(page.locator('.toolbar-filters')).toBeVisible();
    await expect(page.locator('.controls-zone .filters-toggle .filters-count')).toHaveText('1');
    await page.locator('.controls-zone .filters-toggle').click();
    await expect(page.locator('.toolbar-filters')).toBeHidden();
    await page.reload();
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(page.locator('.toolbar-filters')).toBeHidden();
  });

  // Панель тегов большой библиотеки — тысячи строк: все сразу делали каждый выбор секундным
  for (const width of [1600, 2560]) test(`списки в ряду и панель тегов — ровно под кнопкой, ${width} точек`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const tags = Array.from({ length: 500 }, (_, i) => `tag_${i}`);
    const row = tags.flatMap((_, i) => [i, 500 - i]);
    const ids = (await (await page.request.get('/api/games')).json()).map((g) => g.id);
    await page.route(/\/api\/pictures\/status/, (route) => route.fulfill({ json: { state: 'off', analysis: { on: false, state: 'off' }, tagged: true } }));
    await page.route(/\/api\/pictures\/games$/, (route) => route.fulfill({ json: { covered: ids.length, tags, games: Object.fromEntries(ids.map((id) => [id, row])) } }));
    await openLibrary(page);
    const edges = async (l) => { const b = await l.boundingBox(); return [Math.round(b.x), Math.round(b.x + b.width)]; };
    const near = (a, b) => expect(Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1, `${a} и ${b}`).toBe(true);
    // Строку не режет низ списка: последняя видимая кончается вместе с ним
    const cut = (list) => list.evaluate((l) => {
      const end = l.getBoundingClientRect().bottom - parseFloat(getComputedStyle(l).paddingBottom) * (l.getBoundingClientRect().height / l.offsetHeight);
      return [...l.children].filter((c) => { const r = c.getBoundingClientRect(); return r.top < end - 1 && r.bottom > end + 1; }).length;
    });
    await openFilters(page);
    for (const p of await page.locator('.controls-zone .picker:not(.pic-tags-tool)').all()) {
      await p.locator('.picker-btn').click();
      near(await edges(p.locator('.picker-pop')), await edges(p.locator('.picker-btn')));
      expect(await cut(p.locator('.picker-list'))).toBe(0);
      await page.keyboard.press('Escape');
    }

    const button = page.locator('.pic-tags-tool button');
    await button.click();
    const panel = page.locator('.tag-panel');
    const rows = panel.locator('.tag-row');
    await expect(rows.first()).toBeVisible();
    const before = await edges(button);
    near(await edges(panel), before);
    await expect(rows).toHaveCount(120);
    await rows.first().locator('.tag-row-main').click();
    await expect(rows.first()).toHaveClass(/on/);
    // Выбор не двигает кнопки: сортировка на месте, пока панель открыта; панель всё там же, и низ снова целый
    await expect(page.locator('.sort-order button')).toBeDisabled();
    near(await edges(button), before);
    near(await edges(panel), before);
    expect(await cut(panel.locator('.tag-list'))).toBe(0);

    await panel.locator('.tag-list').evaluate((l) => { l.scrollTop = l.scrollHeight; });
    await expect(rows).toHaveCount(240);
    // Поиск находит и тег, которого ещё нет на экране
    await panel.locator('input').fill('tag 480');
    await expect(rows.filter({ hasText: /tag.480/ })).toHaveCount(1);
  });
});
