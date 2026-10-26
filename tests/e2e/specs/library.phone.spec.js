import { test, expect, openHome, openLibrary } from '../fixtures.js';

test.describe('телефон', () => {
  test('нет прокрутки вбок; «Добавить игру» — в меню; «Играть» в «Продолжить» — значком; разделы в шапке', async ({ page }) => {
    await openHome(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('.nav-tab')).toHaveText([/^Главная/, /^Библиотека/, /^Новинки/]);
    const play = page.locator('.continue-btn');
    await expect(play).toBeVisible();
    expect((await play.boundingBox()).width).toBeLessThanOrEqual(50);
    await page.locator('.header-menu-btn').click();
    await expect(page.locator('.header-menu-item', { hasText: 'Добавить игру' })).toBeVisible();
  });

  test('переключатель подборок — под названием, в один ряд; «Во что поиграть?» — строкой ниже, открывает выбор', async ({ page }) => {
    await openHome(page);
    const shelf = page.locator('section.shelf[aria-label="Ваши игры"]');
    const title = await shelf.locator('.shelf-title').boundingBox();
    const tabs = await shelf.locator('.shelf-tabs').boundingBox();
    expect(tabs.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(tabs.width).toBeGreaterThan(250);
    // У невыбранных вкладок — значок и число, подпись — только у выбранной; все в один ряд
    await expect(shelf.locator('.shelf-tab.active .shelf-tab-label')).toBeVisible();
    await expect(shelf.locator('.shelf-tab:not(.active) .shelf-tab-label').first()).toBeHidden();
    expect(await shelf.locator('.shelf-tabs').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await shelf.locator('.shelf-tabs .chip', { hasText: 'Не начаты' }).tap();
    await expect(shelf.locator('.shelf-tools .shelf-random')).toBeHidden();
    await shelf.locator('.shelf-random-line').tap();
    await expect(page.locator('.picker-content')).toBeVisible();
  });

  test('раскрытые фильтры — по два в ряд, подписи читаются', async ({ page }) => {
    await openLibrary(page);
    await page.locator('.filters-toggle').tap();
    const pickers = page.locator('.toolbar-filters .picker');
    await expect(pickers.first()).toBeVisible();
    // Раньше правило планшета жало все три списка и «глаз» в один ряд: «Все… Все… Н…»
    for (const box of await pickers.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))) expect(box).toBeGreaterThan(150);
  });

  test('окно игры на весь экран, крестик закрывает', async ({ page }) => {
    await openLibrary(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.library > .game-card', { hasText: 'Starfall Inn' }).tap();
    await expect(page.locator('.modal-content')).toBeVisible();
    await page.locator('.modal-close').tap();
    await expect(page.locator('.modal-content')).toHaveCount(0);
  });

  test('«Продолжить»: под карточкой — с чего продолжит и значки «Галереи» и «Сейвов», карточка невысокая', async ({ page }) => {
    // «Продолжить» — Starfall Inn: другие тесты запускали другие игры
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      games.find((g) => g.id === 'Starfall_Inn').lastPlayed = Date.now();
      await route.fulfill({ response: res, json: games });
    });
    // В демо нет сейвов и моментов — подставляем момент: «Играть» продолжит с него, и строка под карточкой это говорит
    await page.route(/\/api\/marks\/Starfall_Inn$/, (route) => route.fulfill({ json: [{ id: 'm1', kind: 'moment', label: 'Перед ужином в таверне', at: Date.now() - 3600e3 }] }));
    await openHome(page);
    const card = page.locator('.home-continue');
    await expect(card.locator('.continue-resume')).toBeVisible();
    await expect(card.locator('.continue-resume')).toContainText('Перед ужином в таверне');
    const more = card.locator('.continue-more button');
    await expect(more).toHaveCount(2);
    for (const b of await more.all()) {
      await expect(b).toBeVisible();
      expect((await b.boundingBox()).width).toBeLessThanOrEqual(60);
    }
    await expect(more.first()).toHaveAccessibleName('Галерея');
    const box = await card.boundingBox();
    expect(box.height).toBeLessThanOrEqual(200);
    // «Играть» остаётся справа от названия, а строка и кнопки не вылезают за карточку и не наезжают друг на друга
    const [play, resume, first, last] = await Promise.all([
      card.locator('.continue-btn').boundingBox(), card.locator('.continue-resume').boundingBox(),
      more.first().boundingBox(), more.last().boundingBox(),
    ]);
    expect(play.y).toBeLessThan(resume.y);
    expect(resume.x + resume.width).toBeLessThanOrEqual(first.x);
    expect(last.x + last.width).toBeLessThanOrEqual(box.x + box.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await more.first().tap();
    await expect(page.locator('.gallery')).toBeVisible();
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
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).tap();
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
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).tap();
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
});
