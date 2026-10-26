import { test, expect, openHome, openLibrary, apiGames } from '../fixtures.js';

const cards = (page) => page.locator('.library > .game-card');
const titles = (page) => cards(page).locator('.card-title').allTextContents();

test.describe('главная', () => {

  test('«Продолжить» и одна полка «Ваши игры» с переключателем, по шесть; подборка запоминается; сетки всех игр нет', async ({ page }) => {
    const games = await apiGames(page);
    const name = (g) => g.displayTitle || g.title;
    await openHome(page);
    const last = [...games].sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
    await expect(page.locator('.continue-strip .continue-title')).toHaveText(name(last));
    // Своя полка — одна; подборки без игр (обновлений в демо нет) не показываются
    await expect(page.locator('.shelves:not(.home-hot) section.shelf')).toHaveCount(1);
    const yours = page.locator('section.shelf[aria-label="Ваши игры"]');
    const fresh = games.filter((g) => !g.status && !g.lastPlayed && !g.playtime);
    await expect(yours.locator('.shelf-tabs .chip')).toHaveText(['Недавно играли', 'Добавленные', `Не начаты${fresh.length}`]);
    await expect(yours.locator('.shelf-tabs .chip.active')).toHaveText('Недавно играли');
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
    await expect(page.locator('.nav-tab', { hasText: 'Библиотека' })).toContainText(String(games.length));
  });

  test('шапка полки раскладывается по месту: в строку, под названием, значками; подписи не переносятся, ничего не наезжает', async ({ page }) => {
    await openHome(page);
    const head = page.locator('section.shelf[aria-label="Ваши игры"] .shelf-head');
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

  test('«Все» у полки — подборка целиком в библиотеке; «назад» — снова главная', async ({ page }) => {
    const games = await apiGames(page);
    await openHome(page);
    await page.locator('section.shelf[aria-label="Ваши игры"] .shelf-all', { hasText: 'Все' }).click();
    await expect(page.locator('.nav-tab.active')).toContainText('Библиотека');
    await expect(page.locator('.picker.sort-order .picker-btn')).toContainText('Недавно запущенные');
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

  test('«Не начаты»: только не запускавшиеся, «Все» — библиотека с этим статусом, «Во что поиграть?» — выбор игры', async ({ page }) => {
    const games = await apiGames(page);
    const fresh = games.filter((g) => !g.status && !g.lastPlayed && !g.playtime);
    await openHome(page);
    const shelf = page.locator('section.shelf[aria-label="Ваши игры"]');
    // Кубик — только у не начатых: из них он и выбирает
    await expect(shelf.locator('.shelf-random')).toHaveCount(0);
    await shelf.locator('.shelf-tabs .chip', { hasText: 'Не начаты' }).click();
    await expect(shelf.locator('.shelf-tabs .chip.active .chip-count')).toHaveText(String(fresh.length));
    for (const name of await shelf.locator('.shelf-name').allTextContents()) {
      expect(fresh.map((g) => g.displayTitle || g.title)).toContain(name);
    }
    await shelf.locator('.shelf-random').click();
    await expect(page.locator('.picker-content')).toBeVisible();
    await page.keyboard.press('Escape');
    await shelf.locator('.shelf-all', { hasText: 'Все' }).click();
    await expect(page.locator('.status-chips .chip.active')).toContainText('Не начата');
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
    await openHome(page);
    // по подписи, а не по центру: центр низкой карточки приходится на кнопку «Играть»
    await page.locator('.shelf-card', { hasText: 'The Lantern Road' }).locator('.shelf-name').click();
    await expect(page.locator('#modal-title')).toHaveText('The Lantern Road');
    await page.locator('.tag-link', { hasText: 'mystery' }).click();
    await expect(page.locator('.modal-content')).toHaveCount(0);
    await expect(page.locator('.nav-tab.active')).toContainText('Библиотека');
    await expect(cards(page)).toHaveCount(games.filter((g) => g.tags.includes('mystery')).length);
    await page.goBack();
    await expect(page.locator('.nav-tab.active')).toContainText('Главная');
  });
});

test.describe('библиотека', () => {
  test('все игры сеткой с числом на вкладке, статусы — только здесь', async ({ page }) => {
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
    await page.locator('.controls-zone .picker-btn').first().click();
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
    await page.locator('.controls-zone .picker-btn').first().click();
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
    await page.locator('.controls-zone .picker-btn').first().click();
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
    const btn = page.locator('.picker-btn').first();
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
});
