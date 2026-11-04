import { test, expect, openHome, openLibrary } from '../fixtures.js';

test.describe('телефон', () => {
  test('нет прокрутки вбок; «Добавить игру» — в меню; «Играть» на сцене — с подписью, рядом значки; разделы в шапке', async ({ page }) => {
    await openHome(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('.nav-tab')).toHaveText([/^Главная/, /^Библиотека/, /^Найти/]);
    const play = page.locator('.continue-btn');
    await expect(play).toBeVisible();
    await expect(play.locator('.continue-btn-text')).toBeVisible();
    await expect(page.locator('.upload-btn')).toBeHidden();
    // Поиск — в своей строке под шапкой, как и было
    const header = await page.locator('header').boundingBox();
    expect((await page.locator('.search-box').boundingBox()).y).toBeGreaterThanOrEqual(header.y + header.height);
    await page.locator('.header-menu-btn').click();
    await expect(page.locator('.header-menu-item', { hasText: 'Добавить игру' })).toBeVisible();
  });

  test('«Недавно играли»: одна лента вбок, без заголовка и «Все игры»; порядок на экране; на 320 страница вбок не листается', async ({ page }) => {
    await openHome(page);
    const rows = page.locator('.recent-row');
    await expect(rows.first()).toBeVisible();
    await expect(page.locator('.home-recent .shelf-title')).toBeHidden();
    await expect(page.locator('.recent-all')).toBeHidden();
    const [a, b] = await Promise.all([rows.nth(0).boundingBox(), rows.nth(1).boundingBox()]);
    expect(a.y).toBe(b.y);
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);
    // Короткое название входит целиком: значка «Играть» здесь нет, место — тексту
    expect(a.width).toBeGreaterThanOrEqual(239);
    expect(await page.locator('.recent-rows').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // Сверху вниз: сцена, лента, «Что дальше»
    const tops = await Promise.all(['.continue-strip', '.home-recent', 'section.shelf[aria-label="Что дальше"]'].map(async (sel) => (await page.locator(sel).first().boundingBox()).y));
    expect(tops).toEqual([...tops].sort((x, y) => x - y));
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), { message: `${width}px` }).toBe(true);
    }
    await rows.first().tap();
    await expect(page.locator('.modal-content')).toBeVisible();
  });

  test('переключатель подборок — во всю ширину под названием; между ним и обложками ничего лишнего', async ({ page }) => {
    await openHome(page);
    const shelf = page.locator('section.shelf[aria-label="Что дальше"]');
    const title = await shelf.locator('.shelf-title').boundingBox();
    const tabs = await shelf.locator('.shelf-tabs').boundingBox();
    expect(tabs.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(tabs.width).toBeGreaterThan(250);
    await expect(shelf.locator('.shelf-tab.active .shelf-tab-label')).toBeVisible();
    expect(await shelf.locator('.shelf-tabs').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const [tabsNow, cover] = await Promise.all([shelf.locator('.shelf-tabs').boundingBox(), shelf.locator('.shelf-cover').first().boundingBox()]);
    expect(cover.y).toBeGreaterThanOrEqual(tabsNow.y + tabsNow.height);
    expect(cover.y - (tabsNow.y + tabsNow.height)).toBeLessThan(40);
  });

  test('раскрытые фильтры — по два в ряд, подписи читаются', async ({ page }) => {
    await openLibrary(page);
    await page.locator('.filters-toggle').tap();
    const pickers = page.locator('.toolbar-filters .picker');
    await expect(pickers.first()).toBeVisible();
    // Раньше правило планшета жало все три списка и «глаз» в один ряд: «Все… Все… Н…»
    for (const box of await pickers.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))) expect(box).toBeGreaterThan(150);
  });

  // «Вид» и «Выбрать» — одним рядом; ряд настроек — по группе на строку, цели не ниже 44, вбок страница не едет
  for (const width of [390, 320]) test(`ряд «Вид» на телефоне ${width}: группы на всю ширину, кнопки от 44, без бокового сдвига`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const json = (await res.json()).map((g, i) => ({ ...g, lists: i < 2 ? ['Моя'] : [] }));
      return route.fulfill({ response: res, json });
    });
    await openLibrary(page);
    const btn = page.locator('.look-btn[aria-expanded]');
    const select = page.getByRole('button', { name: 'Выбрать', exact: true });
    const [a, b] = await Promise.all([btn.boundingBox(), select.boundingBox()]);
    expect(Math.abs(a.y - b.y)).toBeLessThan(4);
    await btn.tap();
    const row = page.locator('.look-row');
    await expect(row).toBeVisible();
    await page.locator('.g-view').getByRole('button', { name: 'Стена', exact: true }).tap();
    const left = (q) => page.locator(q).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
    // Виды 2 на 2, размер 4 в ряд, названия — одна кнопка; способов группировки четыре (есть подборка) — два на два
    expect(new Set(await left('.g-view .look-opt')).size).toBe(2);
    expect(new Set(await left('.g-size .look-opt')).size).toBe(4);
    expect(new Set(await left('.g-group .look-opt')).size).toBe(2);
    for (const el of await row.locator('.look-opt').all()) expect((await el.boundingBox()).height).toBeGreaterThanOrEqual(44);
    for (const g of await row.locator('.look-grp').all()) {
      const r = await g.boundingBox();
      expect(r.x + r.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('окно игры: подборки и заметка влезают, список подборок не уходит за край', async ({ page }) => {
    await openLibrary(page);
    await page.locator('.library > .game-card .card-title').first().click();
    await page.locator('.mine-fold').click();
    await page.locator('.game-list-add').scrollIntoViewIfNeeded();
    await page.locator('.game-list-add').click();
    const panel = await page.locator('.game-list-panel').boundingBox();
    const width = page.viewportSize().width;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(page.locator('.game-list-panel')).toHaveCount(0);
    // Заметка у игры может остаться от теста людей — тогда поле уже открыто, кнопки «+ Заметка» нет
    const addNote = page.locator('.game-notes-add');
    if (await addNote.count()) await addNote.click();
    const note = await page.locator('#game-notes-text').boundingBox();
    expect(note.x + note.width).toBeLessThanOrEqual(width);
    // Заметка — ниже названия и обложки, а не над ними
    const title = await page.locator('.modal-title-block').boundingBox();
    const cover = await page.locator('.modal-cover-wrapper').boundingBox();
    expect(note.y).toBeGreaterThan(title.y + title.height - 1);
    expect(note.y).toBeGreaterThan(cover.y + cover.height - 1);
    // Статус на телефоне — два на два: длинные подписи не влезают в четверть экрана
    const columns = await page.locator('.modal-side .status-row').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(2);
  });

  test('окно игры на весь экран, крестик закрывает', async ({ page }) => {
    await openLibrary(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).tap();
    await expect(page.locator('.modal-content')).toBeVisible();
    await page.locator('.modal-close').tap();
    await expect(page.locator('.modal-content')).toHaveCount(0);
  });

  test('сцена столбиком: кадр на всю ширину, текст под ним, без скриншотов; «Играть», значки «Галереи» и «Сейвов», с чего продолжит', async ({ page }) => {
    // «Продолжить» — Starfall Inn: другие тесты запускали другие игры
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      games.find((g) => g.id === 'Starfall_Inn').lastPlayed = Date.now();
      await route.fulfill({ response: res, json: games });
    });
    // В демо нет сейвов и моментов — подставляем момент: «Играть» продолжит с него, и строка под кнопками это говорит
    await page.route(/\/api\/marks\/Starfall_Inn$/, (route) => route.fulfill({ json: [{ id: 'm1', kind: 'moment', label: 'Перед ужином в таверне', at: Date.now() - 3600e3 }] }));
    await openHome(page);
    const card = page.locator('.home-continue');
    await expect(card.locator('.continue-resume')).toBeVisible();
    await expect(card.locator('.continue-resume')).toContainText('Перед ужином в таверне');
    const box = await card.boundingBox();
    const cover = await card.locator('.continue-cover').boundingBox();
    const title = await card.locator('.continue-title').boundingBox();
    expect(Math.abs(cover.width - box.width)).toBeLessThanOrEqual(1);
    expect(cover.width / cover.height).toBeGreaterThan(1.55);
    expect(title.y).toBeGreaterThanOrEqual(cover.y + cover.height);
    await expect(card.locator('.continue-shots')).toBeHidden();
    const more = card.locator('.continue-more button');
    await expect(more).toHaveCount(2);
    for (const b of await more.all()) {
      await expect(b).toBeVisible();
      expect((await b.boundingBox()).width).toBeLessThanOrEqual(60);
    }
    await expect(more.first()).toHaveAccessibleName('Галерея');
    // «Играть» с подписью, значки справа в той же строке; всё внутри сцены и не наезжает
    const [play, first, last] = await Promise.all([card.locator('.continue-btn').boundingBox(), more.first().boundingBox(), more.last().boundingBox()]);
    await expect(card.locator('.continue-btn-text')).toBeVisible();
    expect(first.x).toBeGreaterThanOrEqual(play.x + play.width);
    expect(Math.abs((first.y + first.height / 2) - (play.y + play.height / 2))).toBeLessThanOrEqual(2);
    expect(last.x + last.width).toBeLessThanOrEqual(box.x + box.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await more.first().tap();
    await expect(page.locator('.gallery')).toBeVisible();
  });

  test('окно игры: ряд кнопок в одну строку, у значков — слова, шапка без полосы и теней', async ({ page }) => {
    await openLibrary(page);
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).tap();
    await expect(page.locator('.modal-content')).toBeVisible();
    const row = page.locator('.modal-actions');
    for (const name of ['Галерея', 'Изменить']) await expect(row.locator('.icon-btn-word', { hasText: name })).toBeVisible();
    // Одна строка, ничего не вылезает за окно
    const boxes = await row.locator('> :not(input)').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { y: Math.round(r.y), r: r.right }; }));
    expect(new Set(boxes.map((b) => b.y)).size).toBe(1);
    const win = await page.locator('.modal-content').boundingBox();
    expect(Math.max(...boxes.map((b) => b.r))).toBeLessThanOrEqual(win.x + win.width);
    // Обложка — на всю ширину окна, названием сразу под ней; полосы нет
    await expect(page.locator('.modal-strip')).toHaveCount(0);
    const cover = await page.locator('.modal-cover-wrapper').boundingBox();
    expect(cover.width).toBeGreaterThanOrEqual(win.width - 2);
    expect(await page.locator('.modal-close').evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
  });

  test('окно игры: прокрутили — крестик на своей полосе и не лежит на «Играть»; лента вкладок затухает у края', async ({ page }) => {
    await openLibrary(page);
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).tap();
    await expect(page.locator('.modal-content')).toBeVisible();
    // Лента вкладок шире экрана: справа затухание, пока есть что листать, потом слева
    const tabs = page.locator('.modal-content .modal-tabs');
    expect(await tabs.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(tabs).toHaveAttribute('data-fade', 'right');
    expect(await tabs.evaluate((el) => getComputedStyle(el).maskImage)).toContain('linear-gradient');
    await tabs.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(tabs).toHaveAttribute('data-fade', 'left');

    // Крестик против «Играть» на каждом шаге прокрутки: видимая часть кнопки (ниже полосы) его не задевает
    const overlaps = [];
    for (let top = 0; top <= 600; top += 30) {
      const hit = await page.evaluate((y) => {
        const header = document.querySelector('.modal-header');
        header.scrollTop = y;
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const rect = (s) => document.querySelector(s).getBoundingClientRect();
          const close = rect('.modal-close'), play = rect('#modal-play-btn'), bar = rect('.modal-actions-top');
          const scrolled = document.querySelector('.modal-actions-top').classList.contains('scrolled');
          const visibleTop = Math.max(play.top, scrolled ? bar.bottom : 0);
          const cross = close.left < play.right && close.right > play.left && close.top < play.bottom && close.bottom > visibleTop;
          resolve({ y, scrolled: header.scrollTop > 8, barOn: scrolled, cross });
        })));
      }, top);
      if (hit.scrolled !== hit.barOn || hit.cross) overlaps.push(hit);
    }
    expect(overlaps).toEqual([]);
  });

  test('галерея: подпись «Альбом N из M» в панели просмотра не лежит под кнопками', async ({ page }) => {
    await page.route(/\/api\/gallery\/Starfall_Inn$/, (route) => route.fulfill({ json: {
      state: 'ready', v: 4, screen: { w: 816, h: 624 }, counts: { cg: 1 },
      albums: [{ key: 'events/00001/sisuta-kattoinn 1#parts', kind: 'cg', w: 816, h: 624, files: ['a1.png', 'a2.png', 'a3.png'], cover: 'a1.png' }],
    } }));
    await page.route(/\/api\/gallery\/Starfall_Inn\/(thumb|image|video)\?/, (route) => route.fulfill({ status: 404, body: '' }));
    await openLibrary(page);
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).tap();
    await page.locator('.act-gallery').tap();
    await page.locator('.gallery-tile').first().tap({ timeout: 20_000 });
    const bar = page.locator('.gallery-bar');
    await expect(bar).toBeVisible();
    const where = await page.locator('.gallery-where').boundingBox();
    const btns = await bar.locator('button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    expect(btns.length).toBeGreaterThan(1);
    // Подпись и каждая кнопка не пересекаются по площади, всё внутри экрана
    for (const b of btns) {
      const apart = where.x + where.width <= b.x + 0.5 || b.x + b.w <= where.x + 0.5 || where.y + where.height <= b.y + 0.5 || b.y + b.h <= where.y + 0.5;
      expect(apart).toBe(true);
      expect(b.x + b.w).toBeLessThanOrEqual(390);
    }
    expect(where.x).toBeGreaterThanOrEqual(0);
    expect(where.x + where.width).toBeLessThanOrEqual(390);
    await expect(page.locator('.gallery-where-pos')).toContainText('Альбом 1 из 1, кадр 1 из 3');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('галерея: шапка на телефоне — разделы поровну, чипы переносятся, кнопки значками; сетка в две колонки; пилюля сцены влезает', async ({ page }) => {
    const { mockScene } = await import('../scene.js');
    await mockScene(page, {
      albums: [
        { key: 'events/00001/Night scene', album: { sum: { l: 118, p: 3, f: 'x', w: ['Анна', 'Борис'], c: 1, v: 1, m: 1, a: 1 } } },
        { key: 'events/00002/Night scene', album: { sum: { l: 7, p: 1 } } },
        { key: 'dialogue/00000/Talk', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 5, p: 2, f: 'Привет, мир', w: ['Анна'] } } },
      ],
      scene: () => ({ files: ['pic0.png'], steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: 'one' }] }),
    });
    await openLibrary(page);
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).tap();
    await page.locator('.act-gallery').tap();
    await expect(page.locator('.gallery-source')).toHaveCount(2, { timeout: 20_000 });
    // Кнопки раздела — значками: подписи нет на экране, но есть для чтения с экрана
    const show = page.getByRole('button', { name: 'Показ' });
    await expect(show).toBeVisible();
    await expect(show.locator('.tool-label')).toBeHidden();
    expect((await show.boundingBox()).width).toBeLessThan(60);
    // Шапка — не больше трети экрана (844): до первой плитки
    const tile = await page.locator('.gallery-tile').first().boundingBox();
    expect(tile.y).toBeLessThan(844 / 3);
    // Сцены: две колонки, плитки целиком в экране, пилюля «▶ 118 реплик» внутри плитки
    await page.locator('.gallery-source', { hasText: 'Сцены' }).tap();
    const tiles = page.locator('.gallery-tile.scene-tile');
    await expect(tiles).toHaveCount(2);
    const boxes = [await tiles.nth(0).boundingBox(), await tiles.nth(1).boundingBox()];
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(390);
    const pill = await tiles.nth(0).locator('.gallery-count').boundingBox();
    expect(pill.x).toBeGreaterThanOrEqual(boxes[0].x);
    expect(pill.x + pill.width).toBeLessThanOrEqual(boxes[0].x + boxes[0].width);
    // Все значки плитки видны и не заходят под пилюлю
    const badges = tiles.nth(0).locator('.gallery-badge');
    const nb = await badges.count();
    expect(nb).toBeGreaterThan(1);
    for (let i = 0; i < nb; i++) await expect(badges.nth(i)).toBeVisible();
    const lastB = await badges.nth(nb - 1).boundingBox();
    expect(lastB.x + lastB.width).toBeLessThanOrEqual(pill.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await tiles.nth(0).tap();
    await expect(page.locator('.scene')).toBeVisible();
  });

  test('галерея: «Кто в сцене» на телефоне — одной лентой с прокруткой и затуханием края; выбор работает', async ({ page }) => {
    const { mockScene } = await import('../scene.js');
    const names = Array.from({ length: 14 }, (_, i) => [`Персонаж ${i + 1}`, 14 - i]);
    await mockScene(page, {
      albums: ['events/00001/Night scene', 'events/00002/Other'],
      scene: () => ({ files: ['pic0.png'], steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: 'one' }] }),
      cast: { scenes: { names, rows: { 'events/00001/Night scene\n0': [0, 1], 'events/00002/Other\n0': [1] }, w: {} } },
    });
    await openLibrary(page);
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).tap();
    await page.locator('.act-gallery').tap();
    await page.locator('.gallery-source', { hasText: 'Сцены' }).tap({ timeout: 20_000 });
    const row = page.getByRole('group', { name: 'Кто в сцене' });
    // Все имена в ленте, без «Ещё»; лента одной строкой, листается, справа затухает
    await expect(row.locator('.chip:visible')).toHaveCount(15);
    await expect(row.locator('.cast-more')).toBeHidden();
    const first = await row.locator('.chip').first().boundingBox();
    const last = await row.locator('.chip:visible').last().boundingBox();
    expect(Math.abs(last.y - first.y)).toBeLessThan(2);
    await expect(row).toHaveAttribute('data-fade', 'right');
    await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(row).toHaveAttribute('data-fade', 'left');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await row.evaluate((el) => { el.scrollLeft = 0; });
    await row.locator('.chip', { hasText: 'Персонаж 1' }).first().tap();
    await expect(page.locator('.gallery-tile.scene-tile')).toHaveCount(1);
    await row.locator('.chip', { hasText: 'Персонаж 2' }).tap();
    await expect(page.locator('.gallery-tile.scene-tile')).toHaveCount(2);
  });

  test('окно игры на 320, 360 и 390: стрелка «Играть» не сжимается и не закрывает значки, шапка не уходит вбок', async ({ page }) => {
    const slot = { key: 'RPG File2', shot: false, versions: [], current: { at: 2000, summary: { map: 'Hall' } } };
    await page.route(/\/api\/saves\/history\/Ember_and_Frost$/, (route) => route.fulfill({ json: { slots: [slot] } }));
    await page.route(/\/api\/marks\/Ember_and_Frost$/, (route) => route.fulfill({ json: [] }));
    await openLibrary(page);
    await page.locator('.library > .game-card', { hasText: 'Ember & Frost' }).tap();
    await expect(page.locator('.play-split-more')).toBeVisible();
    for (const w of [390, 360, 320]) {
      await page.setViewportSize({ width: w, height: 844 });
      const arrow = await page.locator('.play-split-more').boundingBox();
      expect(Math.round(arrow.width), `стрелка на ${w}`).toBe(44);
      const play = await page.locator('#modal-play-btn').boundingBox();
      expect(play.x + play.width, `«Играть» на ${w} не заходит на стрелку`).toBeLessThanOrEqual(arrow.x + 1);
      // Значки — правее стрелки и целиком в экране
      let prev = arrow.x + arrow.width;
      for (const sel of ['.act-gallery', '.act-edit', '.modal-more-btn']) {
        const b = await page.locator(sel).boundingBox();
        expect(b.x, `${sel} на ${w}`).toBeGreaterThanOrEqual(prev - 1);
        expect(b.x + b.width).toBeLessThanOrEqual(w);
        prev = b.x + b.width;
      }
      expect(await page.locator('.modal-header').evaluate((el) => el.scrollWidth <= el.clientWidth), `шапка вбок на ${w}`).toBe(true);
    }
  });
});
