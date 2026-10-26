import { test, expect, openLibrary, openGame, openTab, apiGames } from '../fixtures.js';
import { mockScene, openScene, openAlbum } from '../scene.js';

const game = async (page, title) => (await apiGames(page)).find((g) => g.title === title);

test.describe('окно игры', () => {
  test('полоса сверху окна — настоящий кадр игры; размытых подложек нет', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    const g = await game(page, 'Starfall Inn');
    const strip = page.locator('.modal-header .modal-strip img');
    await expect(strip).toHaveAttribute('src', new RegExp(`${g.screens[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?w=720$`));
    await expect(page.locator('.modal-hero-bg')).toHaveCount(0);
  });

  test('игра без кадров: полоса пустой обложкой не заполняется — обложка в окне и так есть', async ({ page }) => {
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      games.find((x) => x.title === 'Starfall Inn').screens = [];
      await route.fulfill({ response: res, json: games });
    });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await expect(page.locator('.modal-strip')).toHaveCount(0);
  });

  test('языки в окне игры — чипами; у игры без языка строки нет', async ({ page }) => {
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      const hoshi = games.find((g) => g.id === 'Hoshifuru_Yado');
      hoshi.textLang = { main: 'ja', langs: ['ja', 'en'], original: 'ja' };
      const inn = games.find((g) => g.id === 'Starfall_Inn');
      inn.language = ''; inn.textLang = null;
      await route.fulfill({ response: res, json: games });
    });
    await openLibrary(page);
    await openGame(page, 'Hoshifuru Yado');
    const ids = page.locator('.modal-content .modal-ids');
    await expect(ids.locator('.modal-lang')).toHaveText(['JP', 'EN']);
    // У игры без языка строки нет
    await page.keyboard.press('Escape');
    await openGame(page, 'Starfall Inn');
    await expect(page.locator('.modal-content .modal-ids')).toHaveCount(0);
  });

  test('«⋯»: скачать игру архивом — ссылка с размером в одну строку; есть сейвы — выбор «с сейвами / без»', async ({ page }) => {
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      games.find((g) => g.id === 'Hoshifuru_Yado').size = 1.5 * 1024 ** 3;
      await route.fulfill({ response: res, json: games });
    });
    let saves = 0;
    await page.route(/\/api\/games\/Hoshifuru_Yado\/archive-info$/, (route) => route.fulfill({ json: { saves } }));
    await openLibrary(page);
    await openGame(page, 'Hoshifuru Yado');
    await page.locator('.modal-content .modal-more-btn').click();
    const link = page.locator('.modal-more-list a.modal-more-item');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '/api/games/Hoshifuru_Yado/archive');
    await expect(link).toHaveAttribute('download', '');
    await expect(link).toContainText('Скачать игру архивом');
    await expect(link.locator('.modal-more-size')).toHaveText('1.50 GB');
    const plainH = (await link.boundingBox()).height;
    expect(plainH).toBeLessThan(60);   // название и размер не переносятся на 3–5 строк

    // С сейвами — два пункта, «с сейвами» первым
    saves = 2;
    await page.locator('.modal-content .modal-more-btn').click();
    await page.locator('.modal-content .modal-more-btn').click();
    await expect(link).toHaveCount(2);
    await expect(link.nth(0)).toHaveAttribute('href', '/api/games/Hoshifuru_Yado/archive?saves=1');
    await expect(link.nth(0)).toContainText('Скачать с сейвами');
    await expect(link.nth(1)).toHaveAttribute('href', '/api/games/Hoshifuru_Yado/archive');
    await expect(link.nth(1)).toContainText('Скачать без сейвов');
    expect((await link.nth(0).boundingBox()).height).toBeLessThan(60);
  });

  test('игроку: где остановился; источники — в колонке под обложкой', async ({ page }) => {
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      const inn = games.find((g) => g.id === 'Starfall_Inn');
      inn.link = 'https://store.steampowered.com/app/100';
      await route.fulfill({ response: res, json: games });
    });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    const modal = page.locator('.modal-content');
    await expect(modal.locator('.modal-progress', { hasText: 'Место' })).toContainText('Rooftop Kitchen');
    // Источники — в колонке под обложкой, с любой вкладки: привязанный — ссылкой; непривязанные — строкой
    await expect(modal.locator('.modal-src a.src-row', { hasText: 'Steam' })).toHaveAttribute('href', 'https://store.steampowered.com/app/100');
    await expect(modal.locator('.modal-src .src-off')).toContainText('VNDB');
    // Подробные сведения — во вкладке «Сведения»
    await openTab(page, 'Сведения');
    await expect(modal.locator('.meta-item', { hasText: 'Размер' })).toBeVisible();
  });

  test('сведения, теги, кадры: просмотрщик листается и закрывается Escape по слоям', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await expect(page.locator('.modal-content')).toContainText('Moon Studio');
    await expect(page.locator('.modal-tags')).toContainText('cozy');
    await expect(page.locator('.screen-thumb')).toHaveCount(3);

    await page.locator('.screen-thumb').first().click();
    await expect(page.locator('.lightbox')).toBeVisible();
    await page.locator('.lightbox-nav.next').click();
    await expect(page.locator('.lightbox-counter')).toHaveText('2 / 3');
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox')).toHaveCount(0);
    await expect(page.locator('.modal-content')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-content')).toHaveCount(0);
  });

  test('оценка доходит до сервера, повторный клик по той же звезде снимает её', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Tidecaller');
    const stars = page.locator('.rating-star');
    await stars.nth(4).click();
    await expect.poll(async () => (await game(page, 'Tidecaller')).rating).toBe(5);
    await stars.nth(4).click();
    await expect.poll(async () => (await game(page, 'Tidecaller')).rating).toBe(0);
  });

  test('статус — одна сегментированная кнопка, повторный клик снимает', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Clockwork Vale');
    const done = page.locator('.status-row .chip', { hasText: 'Пройдено' });
    await done.click();
    await expect(done).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await game(page, 'Clockwork Vale')).status).toBe('done');
    await done.click();
    await expect.poll(async () => (await game(page, 'Clockwork Vale')).status).toBe('');
  });

  test('галерея: анимации и видео — свои вкладки и значки, ролик играет плеер', async ({ page }) => {
    // Оглавление подставляем: в демо-играх нет роликов
    await page.route(/\/api\/gallery\/Starfall_Inn$/, (route) => route.fulfill({ json: {
      state: 'ready', v: 4, screen: { w: 816, h: 624 }, counts: { cg: 1, animation: 1, video: 2 },
      albums: [
        { key: 'img/pictures/ev01', kind: 'cg', w: 816, h: 624, files: ['img/pictures/ev01.png'], cover: 'img/pictures/ev01.png' },
        { key: 'img/pictures/sparkle', kind: 'animation', w: 320, h: 240, files: ['img/pictures/sparkle.gif'], cover: 'img/pictures/sparkle.gif' },
        // Ролик-петля (короткий, без звука) — сервер отнёс его к анимациям
        { key: 'img/pictures/walk', kind: 'animation', w: 0, h: 0, files: ['img/pictures/walk1.webm', 'img/pictures/walk2.webm'], cover: 'img/pictures/walk1.webm' },
        { key: 'movies/scene', kind: 'video', w: 0, h: 0, files: ['movies/scene1.webm', 'movies/scene2.webm'], cover: 'movies/scene1.webm' },
        // Альбом события (кадр склеен из слоёв), покадровая анимация (кадры подряд) и стандартный ресурс движка
        { key: 'events/00001/Night scene', kind: 'cg', w: 816, h: 624, files: ['@cg/0123456789abcdef0123', 'img/pictures/ev02.png'], cover: '@cg/0123456789abcdef0123' },
        { key: 'img/pictures/kiss', kind: 'cg', anim: true, fps: 8, w: 816, h: 624, files: ['img/pictures/kiss_0.png', 'img/pictures/kiss_1.png', 'img/pictures/kiss_2.png', 'img/pictures/kiss_3.png'], cover: 'img/pictures/kiss_0.png' },
        { key: 'img/titles1/Castle', kind: 'engine', w: 816, h: 624, files: ['img/titles1/Castle.png'], cover: 'img/titles1/Castle.png' },
        // Картинки, которым не нашлось сцены, — одним альбомом в конце
        { key: 'loose', kind: 'cg', loose: true, w: 816, h: 624, files: ['img/pictures/a.png', 'img/pictures/b.png', 'img/pictures/c.png'], cover: 'img/pictures/a.png' },
      ],
    } }));
    await page.route(/\/api\/gallery\/Starfall_Inn\/(thumb|image|video)\?/, (route) => route.fulfill({ status: 404, body: '' }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    // Свежий сервер ещё ужимает обложки библиотеки — окно галереи может ждать своей очереди в браузере
    await expect(page.locator('.gallery-tabs .chip')).toHaveText(['CG 3', 'Анимации 3', 'Видео 1', 'Всё 7', 'Системные 1'], { timeout: 20_000 });
    await page.locator('.gallery-tabs .chip', { hasText: 'Видео' }).click();
    const tile = page.locator('.gallery-tile.video');
    // Ролик — плёнка (SVG), а не ▶: ▶ в галерее значит только «смотреть сцену»
    await expect(tile.locator('.gallery-badge svg')).toHaveCount(1);
    await expect(tile.locator('.gallery-badge')).toHaveAttribute('aria-label', 'Видео');
    await expect(tile.locator('.gallery-badge')).not.toContainText('▶');
    await expect(tile.locator('.gallery-count')).toHaveText('2 ролика');
    await tile.click();
    const video = page.locator('.gallery-view video');
    await expect(video).toHaveAttribute('src', /\/api\/gallery\/Starfall_Inn\/video\?f=movies%2Fscene1\.webm/);
    // Своё управление вместо системного: полоса перемотки над панелью, пауза и звук в панели; ←/→ на полосе не листают ролик
    await expect(video).not.toHaveAttribute('controls', /.*/);
    await expect(video).not.toHaveAttribute('loop', /.*/);
    await expect(page.locator('.gallery-view .vseek .seek-line')).toHaveCount(1);
    await expect(page.locator('.gallery-view .gallery-bar button[aria-label="Проиграть"], .gallery-view .gallery-bar button[aria-label="Пауза"]')).toHaveCount(1);
    await expect(page.locator('.gallery-view .gallery-bar button[aria-label*="звук ролика"]')).toHaveCount(1);
    await page.locator('.gallery-view .seek-line').focus();
    await page.keyboard.press('ArrowRight');
    await expect(video).toHaveAttribute('src', /scene1\.webm/);
    await page.locator('.gallery-view .seek-line').blur();
    await expect(page.locator('.gallery-view .gallery-play', { hasText: 'Проиграть' })).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(video).toHaveAttribute('src', /scene2\.webm/);
    await page.keyboard.press('Escape');
    // CG: в порядке сервера (как в игре), без сортировки «по интересу»
    await page.locator('.gallery-tabs .chip', { hasText: 'CG' }).click();
    await expect(page.locator('.gallery-order')).toHaveCount(0);
    await expect(page.locator('.gallery-tile.cg').first().locator('.gallery-name')).toHaveCount(0);
    await expect(page.locator('.gallery-tile.cg').last().locator('.gallery-name')).toHaveText('Без сцены');
    // Склейка листается, как файл, и её можно отметить сердечком
    await page.locator('.gallery-tile.cg').nth(1).click();
    await expect(page.locator('.gallery-view img')).toHaveAttribute('src', /image\?f=%40cg%2F0123456789abcdef0123/);
    await expect(page.locator('.gallery-view .gallery-fav')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.gallery-view img')).toHaveAttribute('src', /ev02\.png/);
    await page.keyboard.press('Escape');
    await page.locator('.gallery-tabs .chip', { hasText: 'Анимации' }).click();
    // Покадровая анимация — во вкладке «Анимации» со значком, открывается сразу играющей
    await expect(page.locator('.gallery-tile.cg .gallery-badge')).toHaveAttribute('aria-label', 'Анимации');
    await page.locator('.gallery-tile.cg').click();
    await expect(page.locator('.gallery-view .gallery-play', { hasText: 'Пауза' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.gallery-tile.animation .gallery-badge')).toHaveCount(2);
    await page.locator('.gallery-tile.animation').first().click();
    await expect(page.locator('.gallery-view img')).toHaveAttribute('src', /image\?f=img%2Fpictures%2Fsparkle\.gif/);
    await page.keyboard.press('Escape');
    // Петля — по кругу, без звука и без кнопок плеера; у ролика-сцены плеер с кнопками и без повтора
    const loopTile = page.locator('.gallery-tile.animation', { has: page.locator('.gallery-count', { hasText: '2 ролика' }) });
    await loopTile.click();
    const loop = page.locator('.gallery-view video');
    await expect(loop).toHaveAttribute('loop', '');
    await expect(loop).not.toHaveAttribute('controls', /.*/);
    expect(await loop.evaluate((v) => v.muted)).toBe(true);
  });

  test('галерея: плитка набора Spine берёт обложку с сервера (rigCover), без неё — пустая, и страница не падает', async ({ page }) => {
    await page.route(/\/api\/gallery\/Starfall_Inn$/, (route) => route.fulfill({ json: {
      state: 'ready', v: 4, screen: { w: 816, h: 624 }, counts: { animation: 2 },
      albums: [
        { key: 'img/spines/a/a', kind: 'animation', w: 0, h: 0, rigCover: true, spine: { atlas: 'img/spines/a/a.atlas', skeleton: 'img/spines/a/a.json', pages: ['img/spines/a/a.png'], version: '3.8.87' }, files: ['img/spines/a/a.json#idle'], cover: 'img/spines/a/a.png' },
        { key: 'img/spines/b/b', kind: 'animation', w: 0, h: 0, spine: { atlas: 'img/spines/b/b.atlas', skeleton: 'img/spines/b/b.json', pages: ['img/spines/b/b.png'], version: '3.8.87' }, files: ['img/spines/b/b.json#idle'], cover: 'img/spines/b/b.png' },
      ],
    } }));
    // Фон попробует снять вторую плитку: файлов набора нет (404) — плитка остаётся пустой
    await page.route(/\/api\/gallery\/Starfall_Inn\/(thumb|image|video|spine)\?/, (route) => route.fulfill({ status: 404, body: '' }));
    await page.route(/\/api\/gallery\/Starfall_Inn\/rig-cover\?/, (route) => route.fulfill({ contentType: 'image/jpeg', body: Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64') }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    const tiles = page.locator('.gallery-tile.animation');
    await expect(tiles).toHaveCount(2, { timeout: 20_000 });
    await expect(tiles.nth(0).locator('img')).toHaveAttribute('src', /\/api\/gallery\/Starfall_Inn\/rig-cover\?key=img%2Fspines%2Fa%2Fa$/);
    await expect(tiles.nth(1).locator('img')).toHaveCount(0);
    await expect(tiles.nth(1).locator('.gallery-tile-empty')).toHaveCount(1);
  });

  // Оглавление с тремя видами сцен: два альбома события с одним названием, сцены-гости на альбоме анимаций, диалог без картинок,
  // альбом без сценария и альбом со сценарием из старого оглавления (без сводки). Сводку и «выбор» задаём руками
  const sceneTabs = [
    { key: 'events/00001/Night scene', album: { sum: { l: 12, p: 3, w: ['Анна', 'Борис'], c: 1, v: 1 } } },
    { key: 'events/00002/Night scene', album: { sum: { l: 1, p: 1 } } },
    { key: 'scenes/ce1/Loops#loop', scenes: [{ t: 'Первая', f: [0], sum: { l: 3, p: 0, m: 1 } }, { t: 'Вторая', f: [1], sum: { l: 2, p: 0, m: 1, a: 1 } }], album: { kind: 'animation', files: ['loopa.webm', 'loopb.webm'], cover: 'loopa.webm' } },
    { key: 'events/00003/Silent', album: { script: false } },
    { key: 'dialogue/00000/Talk', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 5, p: 2, f: 'Привет, мир', w: ['Анна'] } } },
    { key: 'events/00004/Old', album: {} },
  ];
  const oneLine = (url) => ({ files: ['pic0.png', 'pic1.png'], steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: `line ${url.searchParams.get('key')}` }] });

  test('галерея: два уровня — разделы и чипы; «Картинки → CG» открыты сами; сцены и диалоги плитками в общей сетке; плитка открывает плеер; подряд, случайная; облачко в CG', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { urls } = await mockScene(page, { albums: sceneTabs, scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    // Заголовок — «Галерея» и серым название игры
    await expect(page.locator('.gallery-head h2')).toHaveText('ГалереяStarfall Inn');
    const sources = page.locator('.gallery-source');
    const chips = page.locator('.gallery-tabs .chip');
    // Картинки = число «Всё» (пять альбомов без диалога), Сцены = сцены и диалоги (пять и один); «Звуков» и «С сайтов» у демо-игры нет.
    // Открыто «Картинки → CG»; чипов «Сцены» среди них нет
    await expect(sources).toHaveText(['Картинки 5', 'Сцены 6'], { timeout: 20_000 });
    await expect(sources.first()).toHaveClass(/active/);
    await expect(chips).toHaveText(['CG 4', 'Анимации 1', 'Всё 5']);
    await expect(chips.first()).toHaveClass(/active/);
    await sources.nth(1).click();
    await expect(chips).toHaveText(['Сцены 5', 'Диалоги 1']);
    const tiles = page.locator('.gallery-tile.scene-tile');
    await expect(tiles).toHaveCount(5);
    // Одна сетка: ни списка, ни карточек
    await expect(page.locator('.gallery-grid .gallery-tile.scene-tile')).toHaveCount(5);
    await expect(page.locator('.scene-list, .scene-row')).toHaveCount(0);
    // Одинаковые названия — с номером; сверху название, под ним говорящие; пилюля «▶ N реплик»; значки внизу слева
    await expect(tiles.nth(0).locator('.gallery-name')).toContainText('Night scene 1');
    await expect(tiles.nth(1).locator('.gallery-name')).toContainText('Night scene 2');
    await expect(tiles.nth(0).locator('.tile-sub')).toHaveText('Анна, Борис');
    await expect(tiles.nth(0).locator('.gallery-count.play')).toHaveText('12 реплик');
    await expect(tiles.nth(0).locator('.gallery-count.play svg')).toHaveCount(1);
    await expect(tiles.nth(0).locator('.tile-badges .gallery-badge')).toHaveCount(2);
    await expect(tiles.nth(0).locator('.gallery-badge.voice')).toHaveAttribute('aria-label', 'голос');
    await expect(tiles.nth(0).locator('.gallery-badge.choice')).toHaveAttribute('aria-label', 'выбор');
    await expect(tiles.nth(1).locator('.gallery-count.play')).toHaveText('1 реплика');
    await expect(tiles.nth(1).locator('.gallery-badge')).toHaveCount(0);
    await expect(tiles.nth(3).locator('.gallery-name')).toContainText('Вторая');
    await expect(tiles.nth(3).locator('.gallery-count.play')).toHaveText('2 реплики');
    await expect(tiles.nth(3).locator('.gallery-badge.video')).toHaveAttribute('aria-label', 'ролик');
    await expect(tiles.nth(3).locator('.gallery-badge.anim')).toHaveAttribute('aria-label', 'анимация');
    // Старое оглавление без сводки: название и «▶» без числа, ни говорящих, ни значков
    await expect(tiles.nth(4).locator('.gallery-name')).toHaveText('Old');
    await expect(tiles.nth(4).locator('.gallery-count.play')).toHaveText('');
    await expect(tiles.nth(4).locator('.gallery-count.play svg')).toHaveCount(1);
    await expect(tiles.nth(4).locator('.tile-sub, .tile-badges')).toHaveCount(0);
    // Подсказка — одна строка; у сцен — значки, что есть среди плиток
    await page.locator('.gallery-tools .help-mark').click(); // пояснение вкладки открывается по «?»
    await expect(page.locator('.gallery-hint')).toContainText('сцена пойдёт как в игре');
    await expect(page.locator('.gallery-hint .hint-ic')).toHaveCount(4);
    // Картинки грузятся лениво
    await expect(tiles.nth(0).locator('img')).toHaveAttribute('loading', 'lazy');
    // Нажатие — сразу плеер, у гостя — с его номером
    await tiles.nth(3).click();
    await expect(page.locator('.scene')).toBeVisible();
    expect(urls.at(-1).searchParams.get('key')).toBe('scenes/ce1/Loops#loop');
    expect(urls.at(-1).searchParams.get('n')).toBe('1');
    await page.keyboard.press('Escape');
    await expect(page.locator('.scene')).toHaveCount(0);
    // «Смотреть подряд»: с первой плитки; после конца сцены — следующая, а не закрытие
    urls.length = 0;
    await page.locator('.gallery-tools .gallery-play', { hasText: 'Смотреть подряд' }).click();
    await expect(page.locator('.scene-text')).toContainText('Night scene');
    expect(urls[0].searchParams.get('key')).toBe('events/00001/Night scene');
    // «Авто» включаем на первой сцене: оно должно дойти до конца цепочки; сцена кончается сама, дальше — пробел
    await page.keyboard.press('KeyA');
    const autoBtn = page.locator('.scene .gallery-play', { hasText: 'Авто' });
    await expect(autoBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.scene-end')).toBeVisible({ timeout: 8000 });
    await page.keyboard.press('Space');
    await expect.poll(() => urls.length).toBe(2);
    expect(urls[1].searchParams.get('key')).toBe('events/00002/Night scene');
    await expect(autoBtn).toHaveAttribute('aria-pressed', 'true');
    // Дальше до последней плитки (гость 0, гость 1, старый альбом): на последней пробел плеер закрывает, а не открывает ещё одну
    for (const k of [3, 4, 5, 6]) {
      await expect(page.locator('.scene-end')).toBeVisible({ timeout: 8000 });
      await page.keyboard.press('Space');
      if (k < 6) await expect.poll(() => urls.length).toBe(k);
    }
    await expect(page.locator('.scene')).toHaveCount(0);
    expect(urls.length).toBe(5);
    expect(urls.at(-1).searchParams.get('key')).toBe('events/00004/Old');
    // Фокус вернулся на кнопку, что открыла цепочку
    await expect(page.locator('.gallery-tools .gallery-play', { hasText: 'Смотреть подряд' })).toBeFocused();
    // Обычное нажатие по плитке на следующую сцену не переходит: конец сцены её закрывает
    await tiles.nth(0).click();
    await expect(page.locator('.scene .gallery-play', { hasText: 'Авто' })).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await expect(page.locator('.scene')).toHaveCount(0);
    await expect(tiles.nth(0)).toBeFocused();
    // «Случайная» — какая-то из плиток
    urls.length = 0;
    await page.locator('.gallery-tools .gallery-play', { hasText: 'Случайная' }).click();
    await expect(page.locator('.scene')).toBeVisible();
    expect(urls.length).toBe(1);
    await page.keyboard.press('Escape');
    // Показа и перемешивания у сцен нет
    await expect(page.locator('.gallery-tools .gallery-play', { hasText: 'Показ' })).toHaveCount(0);
    // Диалоги — второй чип; плитка: затемнённый портрет, говорящий сверху, первая реплика поверх, пилюля с числом
    await chips.nth(1).click();
    const talk = page.locator('.gallery-tile.talk');
    await expect(talk).toHaveCount(1);
    await expect(talk.locator('.gallery-name')).toHaveText('Анна');
    await expect(talk.locator('.tile-quote')).toHaveText('Привет, мир');
    await expect(talk.locator('.gallery-count.play')).toHaveText('5 реплик');
    await talk.click();
    await expect(page.locator('.scene')).toBeVisible();
    expect(urls.at(-1).searchParams.get('key')).toBe('dialogue/00000/Talk');
    await page.keyboard.press('Escape');
    // Назад в «Картинки»: CG остаётся книгой картинок; у альбомов со сценой — облачко внизу слева, у альбома без сценария — нет
    await sources.first().click();
    await expect(chips.first()).toHaveClass(/active/);
    const cg = page.locator('.gallery-tile.cg');
    await expect(cg).toHaveCount(4);
    await expect(page.locator('.gallery-scene-mark')).toHaveCount(3);
    await expect(cg.filter({ hasText: 'Silent' }).locator('.gallery-scene-mark')).toHaveCount(0);
    await expect(cg.filter({ hasText: 'Night scene' }).first().locator('.gallery-scene-mark')).toHaveCount(1);
    // Подсказка «Картинок» — одна строка с облачком и отсылкой к «Сценам»; пояснение, открытое на «Сценах», так и остаётся открытым
    await expect(page.locator('.gallery-tools .help-mark')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.gallery-hint .hint-ic')).toHaveCount(1);
    await expect(page.locator('.gallery-hint')).toContainText('«Сцены»');
    // У анимации со сценами облачко рядом со значком анимации, не вместо него
    await chips.nth(1).click();
    const loop = page.locator('.gallery-tile.animation');
    await expect(loop.locator('.gallery-badge:not(.gallery-scene-mark)')).toHaveAttribute('aria-label', 'Анимации');
    await expect(loop.locator('.gallery-scene-mark')).toHaveCount(1);
    // Кнопка «Смотреть сцену» в просмотре осталась
    await loop.click();
    await expect(page.locator('.gallery-view .gallery-play', { hasText: 'Смотреть сцену' })).toHaveCount(1);
    // «Всё» — без диалога
    await page.keyboard.press('Escape');
    await chips.nth(2).click();
    await expect(page.locator('.gallery-tile')).toHaveCount(5);
  });

  test('галерея: у игры без CG открывается «Сцены»; у игры без сцен раздела «Сцены» нет, а раздел из одного чипа без ряда чипов', async ({ page }) => {
    // Без CG: событие и диалог только со сценариями — картинок в альбомах нет, «Картинки» скрыты, открыты «Сцены»
    await mockScene(page, { albums: [{ key: 'dialogue/00000/Talk', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 5, p: 2 } } }, { key: 'dialogue/00001/Other', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 2, p: 1 } } }], scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    await expect(page.locator('.gallery-source')).toHaveText(['Сцены 2'], { timeout: 20_000 });
    await expect(page.locator('.gallery-source.active')).toHaveText('Сцены 2');
    // Один непустой чип («Диалоги») — ряда чипов нет, кнопки раздела на месте
    await expect(page.locator('.gallery-tabs')).toHaveCount(0);
    await expect(page.locator('.gallery-tools .gallery-play')).toHaveCount(2);
    // Диалог без первой реплики: название по центру на затемнении, а сверху ничего
    const talk = page.locator('.gallery-tile.talk');
    await expect(talk).toHaveCount(2);
    await expect(talk.first().locator('.gallery-name')).toHaveCount(0);
    await expect(talk.first().locator('.tile-quote')).toHaveText('Talk');
    await page.keyboard.press('Escape');
  });

  test('галерея: у игры без сцен раздела «Сцены» нет', async ({ page }) => {
    // Те же альбомы, но сценариев нет: только CG
    await mockScene(page, { albums: [{ key: 'events/00001/Night scene', album: { script: false } }, { key: 'events/00002/Plain', album: { script: false } }], scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    await expect(page.locator('.gallery-tabs .chip')).toHaveText(['CG 2', 'Всё 2'], { timeout: 20_000 });
    await expect(page.locator('.gallery-source')).toHaveText(['Картинки 2']);
    await expect(page.locator('.gallery-tile.scene-tile')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('галерея: у игры только с диалогами открывается раздел «Сцены», а не пустая «Всё»', async ({ page }) => {
    await mockScene(page, { albums: [{ key: 'dialogue/00000/Talk', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 5, p: 2 } } }], scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    await expect(page.locator('.gallery-source.active')).toHaveText('Сцены 1', { timeout: 20_000 });
    await expect(page.locator('.gallery-tile.talk')).toHaveCount(1);
    await page.keyboard.press('Escape');
  });

  test('галерея: плитка диалога под H (скрытые обложки) прячет и текст реплики', async ({ page }) => {
    await mockScene(page, { albums: [{ key: 'dialogue/00000/Talk', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 5, p: 2, f: 'Секретная реплика', w: ['Анна'] } } }], scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    const quote = page.locator('.gallery-tile.talk .tile-quote');
    await expect(quote).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('h');
    await expect(page.locator('.gallery')).toHaveClass(/covers-hidden/);
    await expect(quote).toBeHidden();
    await page.keyboard.press('h');
    await expect(quote).toBeVisible();
  });

  // Пять реплик, между первой и второй — пауза события на 6 с (дольше MAX_WAIT не ждём): пропуск её не ждёт
  const skipScene = () => ({ files: ['pic0.png', 'pic1.png'], steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: 'one' }, { k: 'wait', n: 600 },
    { k: 'say', who: '', text: 'two' }, { k: 'say', who: '', text: 'three' }, { k: 'say', who: '', text: 'four' }, { k: 'pic', i: 1 }, { k: 'say', who: '', text: 'five' }] });

  test('сцена: пропуск — держать Ctrl или кнопка «Пропуск»: реплики и пауза события пролетают, на конце сцены встаёт; отпустили — листает человек', async ({ page }) => {
    await mockScene(page, { scene: skipScene });
    await openScene(page);
    const text = page.locator('.scene-text');
    const skipBtn = page.locator('.scene .gallery-play', { hasText: 'Пропуск' });
    await expect(text).toContainText('one');
    await expect(skipBtn).toHaveAttribute('aria-pressed', 'false');
    // Ctrl держим: паузу события после первой реплики пропуск не ждёт (даже ускоренной в 8 раз — это 750 мс), вторая
    // реплика — меньше чем через 700 мс; пять реплик — меньше чем за 3 с; на конце сцены пропуск встаёт (плеер открыт)
    await page.keyboard.down('Control');
    await expect(skipBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(text).toContainText('two', { timeout: 700 });
    await expect(page.locator('.scene-end')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.scene')).toBeVisible();
    await page.keyboard.up('Control');
    await expect(skipBtn).toHaveAttribute('aria-pressed', 'false');
    // Отпустили: назад — на последнюю реплику, и она стоит, пока не нажмут
    await page.keyboard.press('ArrowLeft');
    await expect(text).toContainText('five');
    await page.waitForTimeout(800);
    await expect(text).toContainText('five');
    // Кнопка (на телефоне Ctrl нет): та же сцена заново — до конца сама, повторное нажатие выключает
    await page.keyboard.press('Escape');
    await page.locator('.gallery-play', { hasText: 'Смотреть сцену' }).click();
    await expect(text).toContainText('one');
    await skipBtn.click();
    await expect(skipBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.scene-end')).toBeVisible({ timeout: 3000 });
    await skipBtn.click();
    await expect(skipBtn).toHaveAttribute('aria-pressed', 'false');
  });

  test('сцена: темп «Авто» — список рядом с «Авто», пока оно включено; медленно держит реплику дольше, быстро листает; выбор помнится', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockScene(page, { scene: skipScene });
    await openScene(page);
    const text = page.locator('.scene-text');
    const pace = page.locator('.scene-pace');
    await expect(text).toContainText('one');
    await expect(pace).toHaveCount(0);
    await page.keyboard.press('KeyA');
    await expect(pace).toBeVisible();
    await expect(pace).toContainText('Обычно');
    // «Очень медленно» — 3 с на короткую реплику: через 2 с она ещё на экране
    await pace.click();
    await page.locator('.scene-pick-opt', { hasText: 'Очень медленно' }).click();
    await page.waitForTimeout(2000);
    await expect(text).toContainText('one');
    // «Очень быстро» — меньше секунды; пауза события после первой реплики — своим чередом (6 с), дальше снова быстро
    await pace.click();
    await page.locator('.scene-pick-opt', { hasText: 'Очень быстро' }).click();
    await expect(text).toContainText('two', { timeout: 9000 });
    await expect(text).toContainText('three', { timeout: 1500 });
    // Выключили «Авто» — списка нет; в новой сцене включили — темп тот же
    await page.keyboard.press('KeyA');
    await expect(pace).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('.gallery-play', { hasText: 'Смотреть сцену' }).click();
    await page.keyboard.press('KeyA');
    await expect(pace).toContainText('Очень быстро');
  });

  test('«Избранное»: значок ролика и анимации стоит внизу слева плитки, плёнкой и петлёй; нет горизонтальной прокрутки', async ({ page }) => {
    await page.route(/\/api\/favorites$/, (route) => route.fulfill({ json: [
      { game: 'Starfall_Inn', file: 'clip.webm', kind: 'video' },
      { game: 'Starfall_Inn', file: 'loop.gif', kind: 'animation' },
      { game: 'Starfall_Inn', file: 'pic.png', kind: 'cg' },
    ] }));
    await openLibrary(page);
    await page.locator('.header-menu-btn').click();
    await page.locator('.header-menu-item', { hasText: 'Избранное' }).click();
    const tiles = page.locator('.favorites .gallery-tile');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.nth(2).locator('.gallery-badge')).toHaveCount(0);
    for (const i of [0, 1]) {
      const badge = tiles.nth(i).locator('.gallery-badge');
      await expect(badge.locator('svg')).toHaveCount(1);
      await expect(badge).not.toContainText(/[▶↻]/);
      const [tb, bb] = [await tiles.nth(i).boundingBox(), await badge.boundingBox()];
      // Значок прижат к левому нижнему углу плитки, а не лежит в потоке рядом с названием
      expect(bb.x - tb.x).toBeLessThan(12);
      const gap = tb.y + tb.height - (bb.y + bb.height);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(12);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('галерея: плитку сцены можно открыть с клавиатуры; после Escape фокус возвращается на ту же плитку', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockScene(page, { albums: sceneTabs, scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    await page.locator('.gallery-source', { hasText: 'Сцены' }).click();
    const tile = page.locator('.gallery-tile.scene-tile').nth(1);
    await tile.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.scene')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.scene')).toHaveCount(0);
    await expect(tile).toBeFocused();
    // Ещё один Escape закрывает уже галерею
    await page.keyboard.press('Escape');
    await expect(page.locator('.gallery')).toHaveCount(0);
  });

  test('галерея: поиск по картинкам открывает кадр в его альбоме CG, даже когда у игры есть вкладка «Сцены»', async ({ page }) => {
    await mockScene(page, { albums: sceneTabs, scene: oneLine });
    await page.route(/\/api\/pictures\/search\?/, (route) => route.fulfill({ json: { games: 1, results: [{ game: 'Starfall_Inn', file: 'pic1.png' }] } }));
    await openLibrary(page);
    await page.locator('.header-menu-btn').click();
    await page.locator('.header-menu-item', { hasText: 'Поиск по картинкам' }).click();
    await page.locator('.favorites input').first().fill('ванная');
    await page.locator('.favorites .gallery-tile').first().click();
    // Картинка «pic1.png» есть у альбомов со сценой; открылся просмотр в CG, список строк не показан
    await expect(page.locator('.gallery-view img')).toHaveAttribute('src', /pic1\.png/, { timeout: 20_000 });
    await expect(page.locator('.gallery-source.active')).toHaveText(/^Картинки/);
    await expect(page.locator('.gallery-tabs .chip.active')).toHaveText(/^CG/);
    await expect(page.locator('.gallery-tile.scene-tile')).toHaveCount(0);
  });

  // Ответ /scene по языку из запроса: четыре реплики, шаги те же на любом языке; в списке у японского покрыта половина.
  // lang/langs — как их отдаёт сервер
  const langScene = (url) => {
    const want = url.searchParams.get('lang');
    const lang = want === 'ja' ? 'ja' : want === 'orig' || want === 'zh' ? 'zh' : 'en';
    const say = { en: (i) => `English line ${i}`, ja: (i) => `日本語 ${i}`, zh: (i) => `中文 ${i}` }[lang];
    if (url.searchParams.get('key').includes('Plain')) return { files: ['pic0.png'], steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: 'No choice' }] };
    return { files: ['pic0.png', 'pic1.png'], lang, langs: [{ code: 'zh', orig: true }, { code: 'en', n: 4 }, { code: 'ja', n: 2 }],
      steps: [{ k: 'pic', i: 0 }, ...[1, 2, 3, 4].flatMap((i) => (i === 3 ? [{ k: 'pic', i: 1 }] : []).concat({ k: 'say', who: '', text: say(i) }))] };
  };

  test('сцена: язык текста — список, запоминание, клавиша L, клавиатура в списке; без вариантов списка нет', async ({ page }) => {
    // Без «печати» реплики: одно нажатие — одна реплика
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { urls } = await mockScene(page, { albums: ['events/00001/Night scene', 'events/00002/Plain'], scene: langScene });
    await openScene(page, 'Night scene');
    const pick = page.locator('.scene-lang');
    // Список вариантов — чёрный список над кнопкой (BarChoose); прочли строки и закрыли Escape'ом (плеер остаётся)
    const label = async () => {
      await pick.click();
      const rows = (await page.locator('.scene-pick-opt').allTextContents()).map((x) => x.replace(/\s/g, ' '));
      await page.keyboard.press('Escape');
      await expect(page.locator('.scene-pick')).toHaveCount(0);
      return rows;
    };
    // Запрос: язык интерфейса, запомненного нет
    expect(urls[0].searchParams.get('ui')).toBe('ru');
    expect(urls[0].searchParams.has('lang')).toBe(false);
    expect(await label()).toEqual(['中文, оригинал', 'English', '日本語, 50 %']);
    await expect(pick).toContainText('English');
    const text = page.locator('.scene-text');
    const pos = page.locator('.scene-pos');
    await expect(text).toContainText('English line 1');
    await page.keyboard.press('Space');
    await expect(text).toContainText('English line 2');
    await expect(pos).toHaveText('2 / 4');
    // Выбор языка меняет текст на месте: номер реплики тот же
    await pick.click();
    await page.locator('.scene-pick-opt', { hasText: '日本語' }).click();
    await expect(text).toContainText('日本語 2');
    await expect(pos).toHaveText('2 / 4');
    expect(urls.at(-1).searchParams.get('lang')).toBe('ja');
    // Закрыли и открыли снова: язык помнится для игры
    await page.keyboard.press('Escape');
    await page.locator('.gallery-play', { hasText: 'Смотреть сцену' }).click();
    await expect(pick).toContainText('日本語');
    expect(urls.at(-1).searchParams.get('lang')).toBe('ja');
    // L — по кругу: после японского — оригинал; в оригинале у языка тот же код, что и в запросе — «orig»
    await page.keyboard.press('KeyL');
    await expect(pick).toContainText('中文');
    await expect(text).toContainText('中文 1');
    expect(urls.at(-1).searchParams.get('lang')).toBe('orig');
    // Кнопка в фокусе: Enter открывает список, стрелка ходит по строкам (а не листает реплику), Enter берёт; после выбора пробел листает
    await pick.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.scene-pick')).toBeVisible();
    // L при открытом списке язык не меняет: строка в списке осталась бы старой
    await page.keyboard.press('KeyL');
    await expect(pick).toContainText('中文');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(pick).toContainText('English');
    await expect(pos).toHaveText('1 / 4');
    await expect(text).toContainText('English line 1');
    await page.keyboard.press('Space');
    await expect(pos).toHaveText('2 / 4');
    // Escape по-прежнему закрывает плеер
    await page.keyboard.press('Escape');
    await expect(page.locator('.scene')).toHaveCount(0);
    // Ответ без вариантов — списка нет, и L ничего не делает
    await page.keyboard.press('Escape');
    await page.locator('.gallery-tile', { hasText: 'Plain' }).click();
    await page.locator('.gallery-play', { hasText: 'Смотреть сцену' }).click();
    await expect(page.locator('.scene-text')).toContainText('No choice');
    await expect(page.locator('.scene-lang')).toHaveCount(0);
    await page.keyboard.press('KeyL');
    await expect(page.locator('.scene-text')).toContainText('No choice');
  });

  test('сцена: язык меняют, пока картинка реплики грузится — старый текст не возвращается; телефон 390 px', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { urls } = await mockScene(page, { scene: langScene, delay: (f) => (f === 'pic1.png' ? 3000 : 0) });
    await openScene(page);
    const text = page.locator('.scene-text');
    await expect(text).toContainText('English line 1');
    // Следите за текстом сцены всё время: вторая картинка стоит перед третьей репликой
    await page.evaluate(() => {
      window.__seen = [];
      new MutationObserver(() => { const t = document.querySelector('.scene-text'); if (t) window.__seen.push(t.textContent); }).observe(document.querySelector('.scene'), { subtree: true, childList: true, characterData: true });
    });
    await page.keyboard.press('Space');
    await expect(text).toContainText('English line 2');
    await page.keyboard.press('Space');
    // Третья реплика ждёт картинку (3 с): язык меняем сейчас
    await page.keyboard.press('KeyL');
    await expect(page.locator('.scene-lang')).toContainText('日本語');
    await expect(text).toContainText('日本語 3', { timeout: 10_000 });
    const seen = await page.evaluate(() => window.__seen);
    expect(seen.some((x) => x.includes('English line 3')), 'прежний язык на этой реплике не мелькнул').toBeFalsy();
    expect(urls.at(-1).searchParams.get('lang')).toBe('ja');
    // Телефон: панель переносится, список влезает, прокрутки вбок нет
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.scene-lang')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const box = await page.locator('.scene-lang').boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });

  // Сцена с анимацией: цикл из трёх кадров идёт под репликами, затемнение парой (экран чёрный, пока идёт пауза), потом картинка
  const animScene = () => ({ files: ['pic0.png', 'pic1.png', 'pic2.png', 'pic3.png', 'pic4.png'], steps: [
    { k: 'pic', i: 0 }, { k: 'anim', f: [0, 1, 2], d: [6, 6, 6], loop: true, x: [0, 0, 0], s: [] },
    { k: 'say', who: '', text: 'One' }, { k: 'say', who: '', text: 'Two' },
    { k: 'fx', t: 'fade', o: 1, n: 24 }, { k: 'wait', n: 90 }, { k: 'pic', i: 3 }, { k: 'fx', t: 'fade', o: 0, n: 24 }, { k: 'say', who: '', text: 'Three' }] });

  test('сцена: анимация идёт под репликами, пока кадры не пришли — картинка; затемнение, назад возвращает анимацию, картинка её останавливает', async ({ page }) => {
    // В тестах по умолчанию «меньше движения»; здесь нужно движение. Реплика печатается, пока не допечатана, нажатие её
    // только дописывает — поэтому перед каждым нажатием ждём конца печати
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const typed = () => page.waitForTimeout(700);
    // Кадр pic2 приходит с задержкой: реплика читается раньше, анимация стартует, когда загружены все кадры
    await mockScene(page, { scene: animScene, delay: (f) => (f === 'pic2.png' ? 1200 : 0) });
    await openScene(page);
    const stage = page.locator('.scene-stage');
    const layer = page.locator('.scene-anim').first();
    await expect(page.locator('.scene-text')).toContainText('One');
    await expect(stage).not.toHaveClass(/animating/);
    await expect(stage).toHaveClass(/animating/, { timeout: 8000 });
    // Кадры сменяются сами: за секунду видим не меньше двух разных
    const seen = new Set();
    for (let i = 0; i < 20; i++) { seen.add(await layer.getAttribute('src')); await page.waitForTimeout(60); }
    expect(seen.size, JSON.stringify([...seen])).toBeGreaterThanOrEqual(2);
    // Реплика листается, анимация не прерывается
    await typed();
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Two');
    await expect(stage).toHaveClass(/animating/);
    // Затемнение: слой над картинкой чернеет, держится на паузе и светлеет с появлением новой картинки; она останавливает анимацию
    const fade = page.locator('.scene-fade');
    await expect(fade).toHaveCSS('opacity', '0');
    await typed();
    await page.keyboard.press('Space');
    await expect(fade).toHaveCSS('opacity', '1');
    await expect(page.locator('.scene-text')).toContainText('Three', { timeout: 8000 });
    await expect(fade).toHaveCSS('opacity', '0', { timeout: 3000 });
    await expect(stage).not.toHaveClass(/animating/);
    // Назад: к реплике «Two» — и анимация идёт снова, экран светлый
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.scene-text')).toContainText('Two');
    await expect(stage).toHaveClass(/animating/, { timeout: 8000 });
    await expect(fade).toHaveCSS('opacity', '0');
  });

  test('сцена: повторы цикла пропускаются одним нажатием; «меньше движения» — один кадр; кадры не загрузились — остаётся картинка; телефон', async ({ page }) => {
    const rep = () => ({ files: ['pic0.png', 'pic1.png', 'pic2.png'], steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: 'A' },
      { k: 'pic', i: 1 }, { k: 'wait', n: 300 }, { k: 'pic', i: 2 }, { k: 'wait', n: 300 },
      { k: 'rep', o: 1 }, { k: 'pic', i: 1 }, { k: 'wait', n: 300 }, { k: 'pic', i: 2 }, { k: 'wait', n: 300 }, { k: 'pic', i: 1 }, { k: 'wait', n: 300 }, { k: 'pic', i: 2 }, { k: 'wait', n: 300 }, { k: 'rep', o: 0 },
      { k: 'say', who: '', text: 'B' }] });
    await mockScene(page, { scene: rep });
    await openScene(page);
    const text = page.locator('.scene-text');
    await expect(text).toContainText('A');
    // Пауза первого прохода — своя, её пропускает одно нажатие; внутри повторов нажатие уводит сразу к реплике после них
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await expect(text).toContainText('B', { timeout: 2000 });
  });

  test('сцена: анимация при «меньше движения» стоит на одном кадре; нет ни одного кадра — картинка; на телефоне затемнение не закрывает текст', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockScene(page, { scene: animScene });
    await openScene(page);
    const layer = page.locator('.scene-anim').first();
    await expect(page.locator('.scene-text')).toContainText('One');
    await expect(page.locator('.scene-stage')).toHaveClass(/animating/, { timeout: 8000 });
    const first = await layer.getAttribute('src');
    await page.waitForTimeout(700);
    expect(await layer.getAttribute('src')).toBe(first);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // Затемнение лежит под рамкой: текст виден и под чёрным
    const order = await page.evaluate(() => { const nodes = [...document.querySelector('.scene').children]; return [nodes.findIndex((n) => n.classList.contains('scene-fade')), nodes.findIndex((n) => n.classList.contains('scene-ui'))]; });
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[0]).toBeLessThan(order[1]);
  });

  test('сцена: кадры анимации не загрузились — остаётся неподвижная картинка, реплики идут', async ({ page }) => {
    const bad = () => ({ files: ['pic0.png', 'bad1.png', 'bad2.png'], steps: [{ k: 'pic', i: 0 }, { k: 'anim', f: [1, 2], d: [6, 6], loop: true }, { k: 'say', who: '', text: 'One' }, { k: 'say', who: '', text: 'Two' }] });
    await mockScene(page, { scene: bad });
    await page.route(/\/api\/gallery\/Starfall_Inn\/image\?f=bad/, (route) => route.fulfill({ status: 404, body: '' }));
    await openScene(page);
    await expect(page.locator('.scene-text')).toContainText('One');
    await page.waitForTimeout(1200);
    await expect(page.locator('.scene-stage')).not.toHaveClass(/animating/);
    await expect(page.locator('.scene-pic:not(.scene-anim)')).toHaveCount(1);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Two');
  });

  // Врезки Spine (шаг spine): набор не открылся (404) или файл врезок заблокирован — реплики идут до конца, без ожидания по
  // шесть секунд на каждой. У игры без Spine ни файл врезок, ни pixi не грузятся вовсе
  const spineSet = { atlas: 'sp/a.atlas', skeleton: 'sp/a.json', pages: ['sp/a.png'], version: '3.8.87' };
  const spined = () => ({ files: ['pic0.png', 'pic1.png'], screen: { w: 816, h: 624 }, spines: [spineSet], steps: [
    { k: 'pic', i: 0, box: [0, 0, 816, 624] }, { k: 'spine', id: 'p64', s: 0, a: ['go'], loop: true, t: 1, at: [400, 100, 1, 1] }, { k: 'say', who: '', text: 'One' },
    { k: 'say', who: '', text: 'Two' }, { k: 'spine', id: 'p64', off: true }, { k: 'say', who: '', text: 'Three' }] });
  const readThrough = async (page) => {
    for (const text of ['One', 'Two', 'Three']) {
      await expect(page.locator('.scene-text')).toContainText(text, { timeout: 4000 });
      await page.keyboard.press('Space');
    }
    await expect(page.locator('.scene-end')).toBeVisible({ timeout: 4000 });
  };
  test('сцена: врезка Spine — набор не открылся (404): реплики идут до конца, холста нет; закрытие и новая сцена целы', async ({ page }) => {
    await mockScene(page, { scene: spined });
    await page.route(/\/api\/gallery\/Starfall_Inn\/spine\?/, (route) => route.fulfill({ status: 404, body: '' }));
    await openScene(page);
    const t0 = Date.now();
    await readThrough(page);
    expect(Date.now() - t0, 'ни одна реплика не ждала по шесть секунд').toBeLessThan(9000);
    await expect(page.locator('.scene-stage .scene-spine')).toHaveCount(1);
    await expect(page.locator('.scene-spine canvas')).toHaveCount(0);
  });

  test('сцена: врезка Spine — файл врезок заблокирован: реплики идут до конца без ожидания', async ({ page }) => {
    await mockScene(page, { scene: spined });
    await page.route(/SceneSpine/, (route) => route.abort());
    await openScene(page);
    const t0 = Date.now();
    await readThrough(page);
    expect(Date.now() - t0).toBeLessThan(9000);
    await expect(page.locator('.scene-spine')).toHaveCount(0);
  });

  // Модели Live2D (шаг l2d) — тем же порядком: ядро Cubism берётся из игры, в тестах его нет, поэтому проверяем отказы и ленивую загрузку
  const l2dSet = { model: 'm/m.model3.json', moc: 5, core: 'js/core.js', coreMoc: 5, motions: [['go', 'Idle', 0]], exps: [] };
  const l2ded = () => ({ files: ['pic0.png', 'pic1.png'], screen: { w: 816, h: 624 }, l2ds: [l2dSet], steps: [
    { k: 'pic', i: 0, box: [0, 0, 816, 624] }, { k: 'l2d', id: 'i:x', s: 0, a: ['go'], loop: true, t: 1, at: [400, 300, 0.2, 0.2], c: 1 }, { k: 'say', who: '', text: 'One' },
    { k: 'say', who: '', text: 'Two' }, { k: 'l2d', id: 'i:x', off: true }, { k: 'say', who: '', text: 'Three' }] });
  test('сцена: модель Live2D — ядро и модель не открылись (404): реплики идут до конца без ожидания; закрытие и новая сцена целы', async ({ page }) => {
    await mockScene(page, { scene: l2ded });
    await page.route(/\/api\/gallery\/Starfall_Inn\/live2d\?/, (route) => route.fulfill({ status: 404, body: '' }));
    await openScene(page);
    const t0 = Date.now();
    await readThrough(page);
    expect(Date.now() - t0, 'ни одна реплика не ждала по шесть секунд').toBeLessThan(9000);
    await expect(page.locator('.scene-stage .scene-spine')).toHaveCount(1);
    // Закрыли и открыли снова: окно целое
    await page.keyboard.press('Escape');
    await expect(page.locator('.scene')).toHaveCount(0);
  });

  test('сцена: модель Live2D — файл моделей заблокирован: реплики идут до конца без ожидания', async ({ page }) => {
    await mockScene(page, { scene: l2ded });
    await page.route(/SceneLive2D/, (route) => route.abort());
    await openScene(page);
    const t0 = Date.now();
    await readThrough(page);
    expect(Date.now() - t0).toBeLessThan(9000);
    await expect(page.locator('.scene-spine')).toHaveCount(0);
  });

  test('сцена: у игры без Spine и Live2D файлы врезок и pixi не грузятся', async ({ page }) => {
    const loaded = [];
    page.on('request', (r) => { if (/SceneSpine|SceneLive2D|spineLoad|live2dLoad|pixi/i.test(r.url())) loaded.push(r.url()); });
    await mockScene(page, { scene: () => ({ files: ['pic0.png'], steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: 'Solo' }] }) });
    await openScene(page);
    await expect(page.locator('.scene-text')).toContainText('Solo');
    await page.waitForTimeout(500);
    expect(loaded).toEqual([]);
    await expect(page.locator('.scene-spine')).toHaveCount(0);
  });

  // Ролики в сцене: слой <video> в рамке экрана игры, скрытие (H) его размывает, «картинки нет» (i = −1) убирает картинку без
  // тусклого кадра, ролик, что не открылся, ожидание не держит. Первый ролик отдаём, второй (полноэкранный, с ожиданием) — 404
  test('сцена: ролик — слой в рамке экрана, H размывает, pic −1 убирает картинку без тусклого кадра, недоступный ролик не держит ожидание', async ({ page }) => {
    const vid = { s: 'p3', f: 'movies/a.webm', loop: true, x: 100, y: 50, o: 0, zx: 100, zy: 100, op: 255 };
    const scene = () => ({ files: ['pic0.png', 'pic1.png'], screen: { w: 816, h: 624 }, steps: [
      { k: 'pic', i: 0 }, { k: 'vid', v: [vid] }, { k: 'say', who: '', text: 'One' },
      { k: 'pic', i: -1 }, { k: 'say', who: '', text: 'Two' },
      { k: 'vid', v: [{ s: 'm', f: 'movies/bad.webm', loop: false, fit: true, top: true }] }, { k: 'vwait', s: 'm' }, { k: 'vid', v: [] }, { k: 'say', who: '', text: 'Three' }] });
    await mockScene(page, { scene, video: (f) => f === 'movies/a.webm' });
    await openScene(page);
    await expect(page.locator('.scene-text')).toContainText('One');
    const layer = page.locator('.scene-screen > .scene-vid');
    await expect(layer).toHaveCount(1);
    await expect(layer).toHaveAttribute('src', /\/api\/gallery\/Starfall_Inn\/video\?f=movies%2Fa\.webm/);
    // Звук сцены (M) глушит и ролик
    await page.keyboard.press('m');
    await expect(layer).toHaveJSProperty('muted', true);
    await page.keyboard.press('m');
    // Положение — в долях рамки экрана игры: x = 100 из 816
    await expect.poll(() => layer.evaluate((v) => v.style.left)).toMatch(/^12\.2/);
    // Скрытие (H): ролик размыт, как и картинка
    await page.keyboard.press('h');
    await expect(layer).toHaveCSS('filter', /blur/);
    await page.keyboard.press('h');
    await expect(layer).not.toHaveCSS('filter', /blur/);
    // pic −1: картинки нет, тусклого первого кадра тоже; ролик остаётся
    await page.waitForTimeout(700);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Two');
    await expect(page.locator('.scene-pic:not(.scene-anim)')).toHaveCount(0);
    await expect(page.locator('.scene-dim')).toHaveCount(0);
    await expect(layer).toHaveCount(1);
    // Ролик, что не открылся (404), ожидание конца не держит: следующая реплика — без нажатия на экран и меньше чем за 9 с
    await page.waitForTimeout(700);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Three', { timeout: 9000 });
    await expect(page.locator('.scene-screen > .scene-vid')).toHaveCount(0);
  });

  // Назад через реплику после ролика пересобирает его заново (не остаётся старый слой), конец ролика с цепочкой (nx)
  // сменяет слой на следующий ролик
  test('сцена: ролик — перемотка назад пересоздаёт слой, цепочка nx меняет ролик', async ({ page }) => {
    const L = { s: 'p3', f: 'movies/a.webm', loop: true, x: 0, y: 0, o: 0, zx: 100, zy: 100, op: 255 };
    const C = { s: 'v1', f: 'movies/a.webm', loop: false, keep: true, x: 0, y: 0, nx: { f: 'movies/b.webm', loop: true, x: 0, y: 0 } };
    const scene = () => ({ files: ['pic0.png', 'pic1.png'], screen: { w: 816, h: 624 }, steps: [
      { k: 'pic', i: 0 }, { k: 'say', who: '', text: 'One' },
      { k: 'vid', v: [L] }, { k: 'say', who: '', text: 'Two' },
      { k: 'vid', v: [C] }, { k: 'say', who: '', text: 'Three' }] });
    await mockScene(page, { scene, video: () => true });
    await openScene(page);
    await expect(page.locator('.scene-text')).toContainText('One');
    const layer = page.locator('.scene-screen > .scene-vid');
    await expect(layer).toHaveCount(0);
    await page.waitForTimeout(700);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Two');
    await expect(layer).toHaveCount(1);
    await layer.evaluate((v) => { v.dataset.old = '1'; });
    // Назад к реплике до ролика: слоя нет; снова вперёд: слой новый, а не прежний
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.scene-text')).toContainText('One');
    await expect(layer).toHaveCount(0);
    await page.waitForTimeout(700);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Two');
    await expect(layer).toHaveCount(1);
    await expect(layer).not.toHaveAttribute('data-old', '1');
    // Ролик с цепочкой: кончился — на его месте встаёт следующий (один слой, другой файл)
    await page.waitForTimeout(700);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Three');
    await expect(layer).toHaveAttribute('src', /movies%2Fb\.webm/, { timeout: 9000 });
    await expect(layer).toHaveCount(1);
  });

  // Сцены-гости альбома (album.scenes): на кадре, где играют ролики двух сцен, «Смотреть сцену» открывает выбор; на кадре
  // одной сцены — сразу её, с её номером n в запросе. Выбор закрывают Esc и нажатие мимо, просмотр остаётся
  test('галерея: сцены-гости — выбор сцены над кнопкой (↑↓, Enter, Esc, нажатие мимо), на кадре одной сцены — сразу, телефон 390 px', async ({ page }) => {
    const scene = (url) => ({ files: ['pic0.png', 'pic1.png'], screen: { w: 816, h: 624 }, steps: [
      { k: 'pic', i: 0 }, { k: 'say', who: '', text: url.searchParams.get('n') === '1' ? 'Scene B' : 'Scene A' }] });
    const { urls } = await mockScene(page, { scene, albums: [{ key: 'scenes/ce1/Bunny#loop', scenes: [{ t: 'Scene A', f: [0] }, { t: 'Scene B', f: [0, 1] }] }, 'events/00002/Plain'] });
    await openAlbum(page);
    const watch = page.locator('.gallery-play', { hasText: 'Смотреть сцену' });
    const pick = page.locator('.scene-pick');
    // Кадр 0 — играют ролики обеих сцен: выбор над кнопкой, первая строка выделена
    await watch.click();
    await expect(pick).toBeVisible();
    await expect(pick.locator('.scene-pick-head')).toContainText('Выберите сцену');
    await expect(pick.locator('.scene-pick-n')).toHaveText('2');
    await expect(pick.locator('.scene-pick-opt')).toHaveText(['Scene A', 'Scene B']);
    await expect(pick.locator('.scene-pick-opt.active')).toHaveText('Scene A');
    const box = await pick.boundingBox();
    const btn = await watch.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(btn.y);
    // Стрелки ходят по строкам, а не листают кадры и альбомы позади
    await page.keyboard.press('ArrowDown');
    await expect(pick.locator('.scene-pick-opt.active')).toHaveText('Scene B');
    await page.keyboard.press('ArrowDown');
    await expect(pick.locator('.scene-pick-opt.active')).toHaveText('Scene A');
    await expect(page.locator('.gallery-where-pos')).toContainText('кадр 1');
    // Esc закрывает только выбор; просмотр на месте
    await page.keyboard.press('Escape');
    await expect(pick).toHaveCount(0);
    await expect(page.locator('.gallery-view')).toBeVisible();
    await expect(watch).toBeFocused();
    // Кадр сменился при открытом выборе (не нажатием — оно закрыло бы выбор само): выбор закрыт и при возврате не оживает
    await watch.click();
    await expect(pick).toBeVisible();
    await page.evaluate(() => document.querySelector('.lightbox-nav.next').click());
    await expect(page.locator('.gallery-where-pos')).toContainText('кадр 2');
    await expect(pick).toHaveCount(0);
    await page.evaluate(() => document.querySelector('.lightbox-nav.prev').click());
    await expect(page.locator('.gallery-where-pos')).toContainText('кадр 1');
    await expect(pick).toHaveCount(0);
    // Enter на другой кнопке нажимает её, а не запускает выделенную сцену
    await watch.click();
    await expect(pick).toBeVisible();
    const before = urls.length;
    await page.locator('.gallery-fav').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.locator('.scene')).toHaveCount(0);
    expect(urls.length).toBe(before);
    await page.keyboard.press('Escape');
    await expect(pick).toHaveCount(0);
    // Нажатие мимо — тоже только выбор
    await watch.click();
    await expect(pick).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(pick).toHaveCount(0);
    await expect(page.locator('.gallery-view')).toBeVisible();
    // Enter на второй строке — её сцена с n=1
    await watch.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('.scene-text')).toContainText('Scene B');
    expect(urls.at(-1).searchParams.get('n')).toBe('1');
    await page.keyboard.press('Escape');
    await expect(page.locator('.scene')).toHaveCount(0);
    // Кадр 1 — играет ролик одной сцены: она открывается сразу
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.gallery-where-pos')).toContainText('кадр 2');
    await watch.click();
    await expect(pick).toHaveCount(0);
    await expect(page.locator('.scene-text')).toContainText('Scene B');
    expect(urls.at(-1).searchParams.get('n')).toBe('1');
    await page.keyboard.press('Escape');
    // Альбом без scenes (старый сервер или без гостей): без выбора, сцена n=0
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.gallery-where-pos')).toContainText('кадр 1');
    await watch.click();
    await expect(pick).toHaveCount(0);
    await expect(page.locator('.scene-text')).toContainText('Scene A');
    expect(urls.at(-1).searchParams.get('n')).toBe('0');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowUp');
    // Телефон: выбор целиком в окне и над кнопкой
    await page.setViewportSize({ width: 390, height: 844 });
    await watch.click();
    await expect(pick).toBeVisible();
    const ph = await pick.boundingBox();
    const phBtn = await watch.boundingBox();
    expect(ph.x).toBeGreaterThanOrEqual(0);
    expect(ph.x + ph.width).toBeLessThanOrEqual(390);
    expect(ph.y + ph.height).toBeLessThanOrEqual(phBtn.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.scene-pick-opt', { hasText: 'Scene A' }).click();
    await expect(page.locator('.scene-text')).toContainText('Scene A');
    expect(urls.at(-1).searchParams.get('n')).toBe('0');
  });

  test('галерея: звук петли — кнопка только у ролика со звуком и помнится; ↑/↓ — между альбомами; «#parts» не в названии', async ({ page }) => {
    await page.route(/\/api\/gallery\/Starfall_Inn$/, (route) => route.fulfill({ json: {
      state: 'ready', v: 4, screen: { w: 816, h: 624 }, counts: { cg: 2, animation: 2 },
      albums: [
        { key: 'events/00001/sisuta-kattoinn 1#parts', kind: 'cg', w: 816, h: 624, files: ['a1.png', 'a2.png', 'a3.png'], cover: 'a1.png' },
        { key: 'img/pictures/talk', kind: 'animation', audio: true, w: 0, h: 0, files: ['talk1.webm'], cover: 'talk1.webm' },
        { key: 'img/pictures/mute', kind: 'animation', w: 0, h: 0, files: ['mute1.webm'], cover: 'mute1.webm' },
        { key: 'events/00002/Last', kind: 'cg', w: 816, h: 624, files: ['b1.png'], cover: 'b1.png' },
      ],
    } }));
    await page.route(/\/api\/gallery\/Starfall_Inn\/(thumb|image|video)\?/, (route) => route.fulfill({ status: 404, body: '' }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    await page.locator('.gallery-tabs .chip', { hasText: 'Всё' }).click({ timeout: 20_000 });
    const tiles = page.locator('.gallery-tile');
    await expect(tiles).toHaveCount(4);
    // Название сцены — без служебного «#parts» (и на плитке, и в панели)
    await expect(tiles.first().locator('.gallery-name')).toHaveText('sisuta-kattoinn 1');
    await tiles.first().click();
    await expect(page.locator('.gallery-where-name')).toHaveText('sisuta-kattoinn 1');
    // ↓ — первый кадр следующего альбома, ↑ — обратно; на краю остаёмся на месте
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.gallery-where-pos')).toContainText('кадр 2 из 3');
    await page.keyboard.press('ArrowDown');
    const video = page.locator('.gallery-view video');
    await expect(video).toHaveAttribute('src', /talk1\.webm/);
    await expect(page.locator('.gallery-where-pos')).toContainText('Альбом 2 из 4');
    const sound = page.locator('.gallery-view button[aria-label="Включить звук ролика"]');
    await expect(sound).toBeVisible();
    expect(await video.evaluate((v) => v.muted)).toBe(true);
    await sound.click();
    await expect(page.locator('.gallery-view button[aria-label="Выключить звук ролика"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await video.evaluate((v) => v.muted)).toBe(false);
    // У ролика без звука кнопки нет, а выбор действует на следующий ролик со звуком
    await page.keyboard.press('ArrowDown');
    await expect(video).toHaveAttribute('src', /mute1\.webm/);
    await expect(page.locator('.gallery-view button[aria-label*="звук ролика"]')).toHaveCount(0);
    expect(await video.evaluate((v) => v.muted)).toBe(true);
    await page.keyboard.press('ArrowUp');
    await expect(video).toHaveAttribute('src', /talk1\.webm/);
    expect(await video.evaluate((v) => v.muted)).toBe(false);
    // Выбор помнится после закрытия и нового открытия; скрытие (H) звук глушит
    await page.keyboard.press('Escape');
    await tiles.nth(1).click();
    await expect(page.locator('.gallery-view button[aria-label="Выключить звук ролика"]')).toBeVisible();
    expect(await page.locator('.gallery-view video').evaluate((v) => v.muted)).toBe(false);
    await page.keyboard.press('h');
    await expect.poll(() => page.locator('.gallery-view video').evaluate((v) => v.muted)).toBe(true);
    await page.keyboard.press('h');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.gallery-where-pos')).toContainText('Альбом 4 из 4');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.gallery-where-pos')).toContainText('Альбом 4 из 4');
  });

  test('галерея из файлов игры: альбом открывается, Escape закрывает картинку, потом галерею', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    await expect(page.locator('.gallery')).toBeVisible();
    const tile = page.locator('.gallery-tile').first();
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await tile.click();
    await expect(page.locator('.gallery-view')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.gallery-view')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.gallery')).toHaveCount(0);
    await expect(page.locator('.modal-content')).toBeVisible();
  });

  test('«Играть» открывает игру в рамке, «назад» возвращает к окну игры', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    const frame = page.frameLocator('.game-frame iframe');
    await expect(frame.locator('#demo-game')).toContainText('Ember & Frost');
    await expect(page).toHaveURL(/\?play=Ember_and_Frost/);
    await page.goBack();
    await expect(page.locator('.game-frame')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.modal-content')).toBeVisible();
    await expect.poll(async () => (await game(page, 'Ember & Frost')).lastPlayed).toBeGreaterThan(0);
  });
  // Что у игры есть для «Продолжить»: сейв в слоте и (или) момент; пусто — игра с титула
  const resumeMocks = async (page, { slots = [], marks = [] }) => {
    await page.route(/\/api\/saves\/history\/Ember_and_Frost$/, (route) => route.fulfill({ json: { slots } }));
    await page.route(/\/api\/marks\/Ember_and_Frost$/, (route) => route.fulfill({ json: marks }));
  };
  const slot = { key: 'RPG File2', shot: false, versions: [], current: { at: 2000, summary: { map: 'Hall' } } };

  test('«Играть» в окне игры и на карточке продолжает с последнего сейва или момента, а нечего — с титула', async ({ page }) => {
    // Сейв — слот; момент свежее сейва — mark
    await resumeMocks(page, { slots: [slot] });
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]slot=RPG%20File2(&|$)/);
    await page.goBack();
    await expect(page.locator('.game-frame')).toHaveCount(0, { timeout: 10_000 });
    await page.unroute(/\/api\/marks\/Ember_and_Frost$/);
    await page.route(/\/api\/marks\/Ember_and_Frost$/, (route) => route.fulfill({ json: [{ id: 'm1', kind: 'own', label: 'Перед боссом', map: 'Hall', at: 3000 }] }));
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]mark=m1(&|$)/);
    await page.goBack();
    await expect(page.locator('.game-frame')).toHaveCount(0, { timeout: 10_000 });
    // «С титула» в «Продолжить с…» — явно, без точки
    await page.locator('.continue-from-btn').click();
    await page.locator('.continue-from-title').click();
    const src = await page.locator('.game-frame iframe').getAttribute('src');
    expect(src).not.toMatch(/[?&](slot|mark)=/);
  });

  test('«Играть» на карточке (без окна игры) тоже продолжает с сейва; нет сейвов — с титула', async ({ page }) => {
    await resumeMocks(page, { slots: [slot] });
    await openLibrary(page);
    await page.locator('.library > .game-card').filter({ hasText: 'Ember & Frost' }).first().hover();
    await page.locator('.library > .game-card').filter({ hasText: 'Ember & Frost' }).first().locator('.card-play').click();
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]slot=RPG%20File2(&|$)/);
    await page.goBack();
    await expect(page.locator('.game-frame')).toHaveCount(0, { timeout: 10_000 });
    await page.unroute(/\/api\/saves\/history\/Ember_and_Frost$/);
    await page.route(/\/api\/saves\/history\/Ember_and_Frost$/, (route) => route.fulfill({ json: { slots: [] } }));
    await page.locator('.library > .game-card').filter({ hasText: 'Ember & Frost' }).first().locator('.card-play').click();
    const src = await page.locator('.game-frame iframe').getAttribute('src');
    expect(src).not.toMatch(/[?&](slot|mark)=/);
  });

  test('под H моменты, путь и просмотрщики кадров размыты', async ({ page }) => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    await page.route(/\/api\/marks\/Ember_and_Frost$/, (route) => route.fulfill({ json: [{ id: 'm1', kind: 'own', label: 'Перед боссом', map: 'Hall', at: Date.now(), thumb: true }] }));
    await page.route(/\/api\/marks\/Ember_and_Frost\/m1\/thumb/, (route) => route.fulfill({ body: png, contentType: 'image/png' }));
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await openTab(page, 'Моменты');
    const blurred = (loc) => loc.evaluate((el) => getComputedStyle(el).filter);
    const card = page.locator('.shots-card img');
    await expect(card).toBeVisible();
    expect(await blurred(card)).toBe('none');
    await card.click();
    const view = page.locator('.shots-view img');
    await expect(view).toBeVisible();
    expect(await blurred(view)).toBe('none');
    await page.keyboard.press('h');
    await expect.poll(() => blurred(view)).toMatch(/blur\(18px\)/);
    await page.keyboard.press('Escape');
    expect(await blurred(card)).toMatch(/blur\(18px\)/);
    await openTab(page, 'Путь');
    // Скриншот из «Обзора» (lightbox) — тоже
    await openTab(page, 'Обзор');
    await page.locator('.game-screens img, .screen-thumb img').first().click();
    await expect(page.locator('.lightbox')).toHaveClass(/covers-hidden/);
    expect(await blurred(page.locator('.lightbox img'))).toMatch(/blur\(18px\)/);
  });

  test('просмотр в галерее заполняет экран: картинка шире своего размера; есть кнопка «На весь экран»', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/gallery\/Starfall_Inn$/, (route) => route.fulfill({ json: {
      state: 'ready', v: 4, screen: { w: 816, h: 624 }, counts: { cg: 1 },
      albums: [{ key: 'img/pictures/ev01', kind: 'cg', w: 816, h: 624, files: ['img/pictures/ev01.png'], cover: 'img/pictures/ev01.png' }],
    } }));
    // Картинка 816×624 настоящая, не заглушка: иначе нечего сравнивать с её размером
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="816" height="624"><rect width="816" height="624" fill="#444"/></svg>';
    await page.route(/\/api\/gallery\/Starfall_Inn\/(thumb|image)\?/, (route) => route.fulfill({ body: svg, contentType: 'image/svg+xml' }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
    await page.locator('.gallery-tile').first().click({ timeout: 20_000 });
    const img = page.locator('.gallery-view img');
    await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(816);
    const box = await img.boundingBox();
    // Сам элемент занимает весь просмотр (contain вписывает картинку внутри него), а не её натуральные 816×624
    expect(box.width).toBeGreaterThan(816);
    expect(box.height).toBeGreaterThan(624);
    await expect(page.locator('.gallery-view .gallery-play[aria-label="На весь экран"]')).toBeVisible();
  });
});
