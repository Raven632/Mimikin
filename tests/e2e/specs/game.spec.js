import { test, expect, openLibrary, openGame, openTab, apiGames, openFilters } from '../fixtures.js';
import { mockScene, openScene, openAlbum, watchAudio, audios } from '../scene.js';

const game = async (page, title) => (await apiGames(page)).find((g) => g.title === title);

// Пункты картинок в меню есть, когда за ними что-то есть: подставляем разбор и избранное
const pictureItems = (page) => page.route(/\/api\/pictures\/status\?peek=1&tagged=1$/, (route) => route.fulfill({ json: { state: 'ready', analysis: { on: true, state: 'done' }, tagged: true, faved: true } }));

test.describe('окно игры', () => {
  test('шапка окна: полосы сверху нет, обложка слева, название начинается вровень с ней; размытых подложек нет', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await expect(page.locator('.modal-strip')).toHaveCount(0);
    await expect(page.locator('.modal-hero-bg')).toHaveCount(0);
    const cover = await page.locator('#modal-cover').boundingBox();
    const title = await page.locator('#modal-title').boundingBox();
    expect(title.x).toBeGreaterThan(cover.x + cover.width);
    // Верх букв названия — у верха обложки (запас на воздух над заглавными)
    expect(Math.abs(title.y - cover.y)).toBeLessThanOrEqual(8);
    // Тени у обложки нет
    expect(await page.locator('.modal-cover-wrapper').evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
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

  test('«⋯»: скачать игру — ссылка с размером в одну строку; есть сейвы — с ними, «или без сейвов» тихой строкой под ней', async ({ page }) => {
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
    await expect(link).toContainText('Скачать игру');
    await expect(link.locator('.modal-more-size')).toHaveText('1,5 ГБ');
    const plainH = (await link.boundingBox()).height;
    expect(plainH).toBeLessThan(60);   // название и размер не переносятся на 3–5 строк

    // С сейвами — она же с ними, а «или без сейвов» — тихой строкой под ней, без значка и размера
    saves = 2;
    await page.locator('.modal-content .modal-more-btn').click();
    await page.locator('.modal-content .modal-more-btn').click();
    await expect(link).toHaveCount(2);
    await expect(link.nth(0)).toHaveAttribute('href', '/api/games/Hoshifuru_Yado/archive?saves=1');
    await expect(link.nth(0)).toContainText('Скачать игру');
    await expect(link.nth(1)).toHaveAttribute('href', '/api/games/Hoshifuru_Yado/archive');
    await expect(link.nth(1)).toHaveText('или без сейвов');
    await expect(link.nth(1)).toHaveClass(/modal-more-sub/);
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
    // Непривязанные источники не перечисляются
    await expect(modal.locator('.modal-src')).not.toContainText('VNDB');
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
    await page.locator('.act-gallery').click();
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
    await page.locator('.act-gallery').click();
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
    await page.locator('.act-gallery').click();
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
    await expect.poll(() => urls.at(-1)?.searchParams.get('key')).toBe('scenes/ce1/Loops#loop');
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
    // Кнопки плеера видны раньше, чем пришла сцена: нажатие до первой реплики ничего не листает
    await expect(page.locator('.scene-text')).toContainText('line');
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-end')).toBeVisible({ timeout: 8000 });
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

  // «Кто в сцене» для sceneTabs: Анна — в первой, второй и старой сцене, Борис — в первой и во втором госте; в диалогах одно имя
  const sceneCast = {
    scenes: {
      names: [['Анна', 3], ['Борис', 2]],
      rows: { 'events/00001/Night scene\n0': [0, 1], 'events/00002/Night scene\n0': [0], 'scenes/ce1/Loops#loop\n1': [1], 'events/00004/Old\n0': [0] },
      w: { 'events/00001/Night scene\n0': ['Анна', 'Борис'], 'events/00002/Night scene\n0': ['Вера'] },
    },
    dialogue: { names: [['Анна', 1]], rows: { 'dialogue/00000/Talk\n0': [0] }, w: { 'dialogue/00000/Talk\n0': ['Анна'] } },
  };

  test('галерея: «Кто в сцене» — «Все N» и имена; имя оставляет его сцены, и подряд, и случайная — по ним; второе нажатие — все; подпись плитки из таблицы', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { urls } = await mockScene(page, { albums: sceneTabs, scene: oneLine, cast: sceneCast });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    await page.locator('.gallery-source', { hasText: 'Сцены' }).click({ timeout: 20_000 });
    const row = page.getByRole('group', { name: 'Кто в сцене' });
    const names = row.locator('.chip');
    const tiles = page.locator('.gallery-tile.scene-tile');
    await expect(names).toHaveText(['Все5', 'Анна3', 'Борис2']);
    await expect(names.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(tiles).toHaveCount(5);
    // Кто под названием — из таблицы, а не из оглавления: у второй сцены в оглавлении никого, а таблица знает Веру
    await expect(tiles.nth(1).locator('.tile-sub')).toHaveText('Вера');
    await expect(tiles.nth(2).locator('.tile-sub')).toHaveCount(0);
    // Анна: три её сцены, по порядку игры
    await names.nth(1).click();
    await expect(names.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(names.first()).toHaveAttribute('aria-pressed', 'false');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.nth(2).locator('.gallery-name')).toHaveText('Old');
    // «Смотреть подряд» — только её сцены, после последней плеер закрывается
    urls.length = 0;
    await page.locator('.gallery-tools .gallery-play', { hasText: 'Смотреть подряд' }).click();
    const anna = ['events/00001/Night scene', 'events/00002/Night scene', 'events/00004/Old'];
    for (const key of anna) {
      await expect(page.locator('.scene-text')).toContainText(key);
      await page.keyboard.press('Space');
      await expect(page.locator('.scene-end')).toBeVisible({ timeout: 8000 });
      await page.keyboard.press('Space');
    }
    await expect(page.locator('.scene')).toHaveCount(0);
    expect(urls.map((u) => u.searchParams.get('key'))).toEqual(anna);
    // Второе нажатие на выбранное — снова все
    await names.nth(1).click();
    await expect(tiles).toHaveCount(5);
    await expect(names.first()).toHaveAttribute('aria-pressed', 'true');
    // Борис → «Случайная» — одна из его двух сцен; «Все» тоже возвращает все
    await names.nth(2).click();
    await expect(tiles).toHaveCount(2);
    urls.length = 0;
    await page.locator('.gallery-tools .gallery-play', { hasText: 'Случайная' }).click();
    await expect(page.locator('.scene')).toBeVisible();
    expect(['events/00001/Night scene', 'scenes/ce1/Loops#loop']).toContain(urls[0].searchParams.get('key'));
    await page.keyboard.press('Escape');
    await names.first().click();
    await expect(tiles).toHaveCount(5);
    // Подсказка вкладки говорит про ряд
    await page.locator('.gallery-tools .help-mark').click();
    await expect(page.locator('.gallery-hint')).toContainText('Нажмите имя');
    // Диалоги: одно имя — ряда нет; выбор Бориса туда не переходит
    await names.nth(2).click();
    await page.locator('.gallery-tabs .chip', { hasText: 'Диалоги' }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('.gallery-tile.talk')).toHaveCount(1);
    await page.locator('.gallery-tabs .chip', { hasText: 'Сцены' }).click();
    await expect(names.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(tiles).toHaveCount(5);
  });

  test('галерея: «Кто в сцене» — что не влезло в строку, за «Ещё N»; уже окно — меньше имён; выбранное видно и в свёрнутом', async ({ page }) => {
    const many = Array.from({ length: 15 }, (_, i) => [`Имя ${String.fromCharCode(1040 + i)}`, 20 - i]);
    many[14][0] = 'Upper District Resident Pipin';
    const rows = Object.fromEntries([['events/00001/Night scene\n0', many.map((_, i) => i)]]);
    await mockScene(page, { albums: sceneTabs, scene: oneLine, cast: { scenes: { names: many, rows, w: {} } } });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    await page.locator('.gallery-source', { hasText: 'Сцены' }).click({ timeout: 20_000 });
    const row = page.getByRole('group', { name: 'Кто в сцене' });
    const more = row.locator('.cast-more');
    // Свёрнутый ряд — одна строка: «Все», сколько влезло имён и «Ещё N», где N — те, что не влезли
    const collapsed = async () => {
      const tops = await row.locator('.chip:visible').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      await expect(more).toHaveText(`Ещё ${15 - (tops.length - 2)}`);
      return tops.length - 2;
    };
    const wide = await collapsed();
    expect(wide).toBeGreaterThan(5);
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => (await row.locator('.chip:visible').count()) - 2).toBeLessThan(wide);
    await collapsed();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await row.locator('.chip:visible').count()) - 2).toBe(wide);
    await more.click();
    await expect(row.locator('.chip:visible')).toHaveCount(17);
    await expect(more).toHaveText('Свернуть');
    // Длинное имя обрезано, полное — в подсказке
    const long = row.locator('.chip', { hasText: 'Upper District' });
    await expect(long).toHaveAttribute('data-tip', 'Upper District Resident Pipin');
    expect((await long.boundingBox()).width).toBeLessThan(260);
    await long.click();
    await expect(page.locator('.gallery-tile.scene-tile')).toHaveCount(1);
    await more.click();
    await expect(long).toBeVisible();
    await collapsed();
  });

  test('галерея: у игры без CG открывается «Сцены»; у игры без сцен раздела «Сцены» нет, а раздел из одного чипа без ряда чипов', async ({ page }) => {
    // Без CG: событие и диалог только со сценариями — картинок в альбомах нет, «Картинки» скрыты, открыты «Сцены»
    await mockScene(page, { albums: [{ key: 'dialogue/00000/Talk', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 5, p: 2 } } }, { key: 'dialogue/00001/Other', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 2, p: 1 } } }], scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    await expect(page.locator('.gallery-source')).toHaveText(['Сцены 2'], { timeout: 20_000 });
    await expect(page.locator('.gallery-source.active')).toHaveText('Сцены 2');
    // Один непустой чип («Диалоги») — ряда чипов нет, кнопки раздела на месте
    await expect(page.locator('.gallery-tabs')).toHaveCount(0);
    await expect(page.locator('.gallery-tools .gallery-play:not(.tag-tool)')).toHaveCount(2);
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
    await page.locator('.act-gallery').click();
    await expect(page.locator('.gallery-tabs .chip')).toHaveText(['CG 2', 'Всё 2'], { timeout: 20_000 });
    await expect(page.locator('.gallery-source')).toHaveText(['Картинки 2']);
    await expect(page.locator('.gallery-tile.scene-tile')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('галерея: у игры только с диалогами открывается раздел «Сцены», а не пустая «Всё»', async ({ page }) => {
    await mockScene(page, { albums: [{ key: 'dialogue/00000/Talk', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 5, p: 2 } } }], scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    await expect(page.locator('.gallery-source.active')).toHaveText('Сцены 1', { timeout: 20_000 });
    await expect(page.locator('.gallery-tile.talk')).toHaveCount(1);
    await page.keyboard.press('Escape');
  });

  test('галерея: плитка диалога под H (скрытые обложки) прячет и текст реплики', async ({ page }) => {
    await mockScene(page, { albums: [{ key: 'dialogue/00000/Talk', album: { kind: 'dialogue', files: [], cover: 'pic0.png', sum: { l: 5, p: 2, f: 'Секретная реплика', w: ['Анна'] } } }], scene: oneLine });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
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
    await pictureItems(page);
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
    await page.locator('.act-gallery').click();
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
    await pictureItems(page);
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

  test('лента картинок: игра главой, название держится сверху, кадр открывает галерею, «Сцена» — плеер; неразобранных нет — объяснение', async ({ page }) => {
    await mockScene(page, { albums: sceneTabs, scene: oneLine });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
    await page.route(/\/api\/gallery\/Starfall_Inn\/(thumb|image)\?/, (route) => route.fulfill({ contentType: 'image/png', body: png }));
    const frames = [{ file: 'pic1.png', w: 0, h: 0 }, { file: 'pic2.png', w: 800, h: 600, scene: { key: 'events/00001/Night scene', n: 0, title: 'Night scene' } }];
    let feed = { games: [] };
    await page.route(/\/api\/pictures\/feed$/, (route) => route.fulfill({ json: feed }));
    await openLibrary(page);
    const open = async () => {
      await pictureItems(page);
      await page.locator('.header-menu-btn').click();
      await page.locator('.header-menu-item', { hasText: 'Лента картинок' }).click();
    };
    await open();
    await expect(page.locator('.feed .state-title')).toHaveText('Пока нечего показать');
    await page.keyboard.press('Escape');
    await expect(page.locator('.feed')).toHaveCount(0);

    // Игра, которой нет в библиотеке, в ленте не показывается
    feed = { games: [{ id: 'Starfall_Inn', frames }, { id: 'Нет такой', frames }] };
    await open();
    const games = page.locator('.feed-game');
    await expect(games).toHaveCount(1);
    await expect(games.locator('.feed-title')).toHaveText(/\S/);
    await expect(games.locator('.feed-frame img')).toHaveCount(2);
    // Сначала миниатюра, за ней полная картинка
    await expect(games.locator('.feed-frame img').first()).toHaveAttribute('src', /\/image\?f=pic1\.png/);
    await expect(games.locator('.feed-frame').first().locator('.gallery-count')).toHaveCount(0);

    // Название держится сверху, пока идут кадры игры
    await page.setViewportSize({ width: 390, height: 300 });
    await page.locator('.feed').evaluate((el) => { el.scrollTop = 400; });
    await expect.poll(() => page.locator('.feed').evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    expect(await page.locator('.feed-title').evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(0);
    expect(await page.locator('.feed').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Кадр — галерея игры на нём; закрыли — снова лента
    await games.locator('.feed-open').first().click();
    await expect(page.locator('.gallery-view img')).toHaveAttribute('src', /pic1\.png/, { timeout: 20_000 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.gallery-view')).toHaveCount(0);
    await expect(page.locator('.feed-game')).toHaveCount(1);
    // «Сцена» — плеер
    await games.locator('.feed-frame .gallery-count').click();
    await expect(page.locator('.scene-text')).toContainText('Night scene', { timeout: 20_000 });
  });

  test('поиск по картинкам: модель слов ещё качается — видно, сколько скачано; готова — поиск идёт сам', async ({ page }) => {
    await mockScene(page, { albums: sceneTabs, scene: oneLine });
    let calls = 0;
    const status = [];
    await page.route(/\/api\/pictures\/status$/, (route) => { status.push(1); return route.fulfill({ json: { state: 'preparing' } }); });
    await page.route(/\/api\/pictures\/search\?/, (route) => (++calls < 3
      ? route.fulfill({ status: 503, json: { error: 'preparing', done: 50 * 1048576, total: 270 * 1048576 } })
      : route.fulfill({ json: { games: 1, results: [{ game: 'Starfall_Inn', file: 'pic1.png' }] } })));
    await openLibrary(page);
    await pictureItems(page);
    await page.locator('.header-menu-btn').click();
    await page.locator('.header-menu-item', { hasText: 'Поиск по картинкам' }).click();
    // Окно открылось — сервер уже начинает готовить модель
    await expect.poll(() => status.length).toBe(1);
    await page.locator('.favorites input').first().fill('ванная');
    await expect(page.locator('.favorites .state-title')).toHaveText('Готовлю поиск');
    await expect(page.locator('.favorites .state-hint')).toContainText('50 из 270 МБ');
    await expect(page.locator('.favorites .gallery-tile')).toHaveCount(1, { timeout: 10_000 });
    expect(calls).toBe(3);
  });

  test('поиск по картинкам: как понят запрос, «Ещё картинки», «Похожие» на кадр и «Сцена» с того места, где кадр', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockScene(page, { albums: sceneTabs, scene: () => ({ files: ['pic0.png', 'pic1.png'],
      steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: 'Первая' }, { k: 'say', who: '', text: 'Вторая' }, { k: 'pic', i: 1 }, { k: 'say', who: '', text: 'Третья' }] }) });
    await page.route(/\/api\/pictures\/status$/, (route) => route.fulfill({ json: { state: 'ready', pass: { embeds: { done: 50, total: 200 }, tags: { done: 10, total: 200 } } } }));
    const asked = [];
    const tile = (file, extra = {}) => ({ game: 'Starfall_Inn', file, score: 0.5, ...extra });
    await page.route(/\/api\/pictures\/(search|similar)\?/, (route) => {
      const url = new URL(route.request().url());
      asked.push(`${url.pathname.split('/').pop()} ${url.searchParams.get('from')} ${url.searchParams.get('f') || url.searchParams.get('q')}`);
      if (url.pathname.endsWith('/similar')) return route.fulfill({ json: { games: 1, results: [tile('pic0.png')], more: false } });
      return route.fulfill({ json: url.searchParams.get('from') === '0'
        ? { games: 1, results: [tile('pic1.png', { scene: { key: 'events/00001/Night scene', n: 0, title: 'Night scene' } }), tile('pic0.png')], more: true, understood: 'maid писюн', unknown: ['писюн'] }
        : { games: 1, results: [tile('pic2.png')], more: false } });
    });
    await openLibrary(page);
    await pictureItems(page);
    await page.locator('.header-menu-btn').click();
    await page.locator('.header-menu-item', { hasText: 'Поиск по картинкам' }).click();
    const win = page.locator('.favorites');
    await win.locator('input').first().fill('горничная писюн');
    await expect(win.locator('.pics-tile')).toHaveCount(2);
    await expect(win.locator('.pics-covered')).toHaveText('Искал: maid писюн. Слово «писюн» поиск не знает — напишите его по-английски. Игр в поиске: 1. Картинки ещё разбираются: кадры — 25 %, теги — 5 %. Поиск станет точнее, когда разбор закончится.');
    // «Ещё картинки» — со следующей картинки; дальше нет — кнопки нет
    await win.locator('.line-more', { hasText: 'Ещё картинки' }).click();
    await expect(win.locator('.pics-tile')).toHaveCount(3);
    await expect(win.locator('.line-more')).toHaveCount(0);
    expect(asked).toEqual(['search 0 горничная писюн', 'search 2 горничная писюн']);
    // «Сцена» есть только у кадра из сцены; плеер — с реплики, где кадр виден впервые
    await expect(win.locator('.pics-tile').nth(1).locator('.pics-acts .play')).toHaveCount(0);
    await win.locator('.pics-tile').first().locator('.pics-acts .play', { hasText: 'Сцена' }).click();
    await expect(page.locator('.scene-text')).toHaveText('Третья');
    await page.keyboard.press('Escape');
    await expect(page.locator('.scene')).toHaveCount(0);
    // «Похожие»: на кадр, сверху — он сам и «Назад к поиску»; вернулись — снова слова
    await win.locator('.pics-tile').first().locator('.pics-acts .gallery-count', { hasText: 'Похожие' }).click();
    await expect(win.locator('.pics-like')).toContainText('Похожие на кадр из «Starfall Inn»');
    await expect(win.locator('.pics-tile')).toHaveCount(1);
    expect(asked.at(-1)).toBe('similar 0 pic1.png');
    await win.locator('.pics-like button', { hasText: 'Назад к поиску' }).click();
    await expect(win.locator('.pics-like')).toHaveCount(0);
    // Вернулись туда, где были: с подгруженными «Ещё картинками»
    await expect(win.locator('.pics-tile')).toHaveCount(3);
  });

  test('поиск по своей картинке: файл и вставка дают похожие, «Ещё» шлёт тот же вектор; плохая картинка — понятный ответ', async ({ page }) => {
    await page.route(/\/api\/pictures\/status$/, (route) => route.fulfill({ json: { state: 'ready' } }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
    let answer = { status: 200, json: { v: 'VEC+/=' } };
    let sent = 0;
    await page.route(/\/api\/pictures\/by-image$/, (route) => { sent++; return route.fulfill(answer); });
    const asked = [];
    await page.route(/\/api\/pictures\/similar\?/, (route) => {
      const url = new URL(route.request().url());
      asked.push(url.searchParams);
      const from = Number(url.searchParams.get('from'));
      return route.fulfill({ json: { games: 1, more: from === 0, results: [{ game: 'Starfall_Inn', file: from ? 'b.png' : 'a.png', score: 0.5 }] } });
    });
    await openLibrary(page);
    await pictureItems(page);
    await page.locator('.header-menu-btn').click();
    await page.locator('.header-menu-item', { hasText: 'Поиск по картинкам' }).click();
    const win = page.getByRole('dialog', { name: 'Поиск по картинкам' });
    await win.locator('input[type="file"]').setInputFiles({ name: 'my.png', mimeType: 'image/png', buffer: png });
    await expect(win.locator('.pics-like')).toContainText('Похожие на вашу картинку');
    await expect(win.locator('.pics-tile')).toHaveCount(1);
    expect(asked[0].get('v')).toBe('VEC+/=');
    expect(asked[0].get('game')).toBe(null);
    await win.locator('.line-more').click();
    await expect(win.locator('.pics-tile')).toHaveCount(2);
    expect(asked.at(-1).get('v')).toBe('VEC+/=');
    expect(asked.at(-1).get('from')).toBe('1');
    // Слова — обратно к поиску, своя картинка уходит
    await win.locator('.pics-like .gallery-play').click();
    await expect(win.locator('.pics-like')).toHaveCount(0);
    // Вставка картинки из буфера; текст вставляется как обычно и картинкой не считается
    answer = { status: 422, json: { error: 'bad-image' } };
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const text = new DataTransfer();
      text.setData('text/plain', 'просто слова');
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: text, bubbles: true, cancelable: true }));
    }, png.toString('base64'));
    await expect(win.locator('.state-error')).toContainText('не прочитать');
    expect(sent).toBe(2);
    // Брошенный файл — только сюда: загрузчик игр его не видит, даже если это архив. Картинка идёт в поиск
    const drop = (name, type) => win.evaluate((el, { name, type }) => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], name, { type }));
      for (const kind of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true }));
    }, { name, type });
    await drop('game.zip', 'application/zip');
    await expect(page.locator('.drop-overlay, .upload-overlay')).toHaveCount(0);
    await expect(page.locator('.toast.show')).toHaveCount(0);
    expect(sent).toBe(2);
    answer = { status: 200, json: { v: 'DROP' } };
    await drop('pic.png', 'image/png');
    await expect(win.locator('.pics-like')).toContainText('Похожие на вашу картинку');
    // Полоса появляется раньше запроса похожих: ответ ждём, а не смотрим сразу
    await expect.poll(() => asked.at(-1).get('v')).toBe('DROP');
    // Медленный ответ на картинку не подменяет то, что выбрали после неё
    await win.locator('.pics-like .gallery-play').click();
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    await page.unroute(/\/api\/pictures\/by-image$/);
    await page.route(/\/api\/pictures\/by-image$/, async (route) => { await slow; return route.fulfill({ status: 200, json: { v: 'LATE' } }); });
    await drop('late.png', 'image/png');
    await win.locator('.favorites input, input').first().fill('ванная');
    release();
    await page.waitForTimeout(300);
    await expect(win.locator('.pics-like')).toHaveCount(0);
    expect(asked.some((x) => x.get('v') === 'LATE')).toBe(false);
  });

  test('живая плитка сцены: при наведении кадры сменяются, ушли — обложка; долгое нажатие показывает и не открывает сцену, короткое открывает', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const files = ['pic2.png', 'pic3.png', 'pic4.png'];
    await mockScene(page, { albums: [{ key: 'events/00001/Night scene', album: { files, cover: 'pic2.png' } }], scene: oneLine });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
    await page.route(/\/api\/gallery\/Starfall_Inn\/thumb\?/, (route) => route.fulfill({ contentType: 'image/png', body: png }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    await page.locator('.gallery-source', { hasText: 'Сцены' }).click({ timeout: 20_000 });
    const tile = page.locator('.gallery-grid .scene-tile').first();
    await expect(tile).toBeVisible();
    await tile.hover();
    await expect(tile.locator('img.tile-peek')).toBeVisible({ timeout: 3000 });
    const first = await tile.locator('img.tile-peek').getAttribute('src');
    await expect.poll(() => tile.locator('img.tile-peek').getAttribute('src'), { timeout: 3000 }).not.toBe(first);
    await page.mouse.move(0, 0);
    await expect(tile.locator('img.tile-peek')).toHaveCount(0);
    // Палец: долгое нажатие — смотрим, сцена не открылась; нажатие целиком тем же порядком событий, что у телефона
    await tile.dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true });
    await expect(tile.locator('img.tile-peek')).toBeVisible({ timeout: 3000 });
    await tile.dispatchEvent('pointerup', { pointerType: 'touch', bubbles: true });
    await tile.dispatchEvent('click');
    await expect(tile.locator('img.tile-peek')).toHaveCount(0);
    await expect(page.locator('.scene')).toHaveCount(0);
    await tile.dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true });
    await tile.dispatchEvent('pointerup', { pointerType: 'touch', bubbles: true });
    await tile.dispatchEvent('click');
    await expect(page.locator('.scene')).toBeVisible();
  });

  test('игры по содержимому: панель «Теги картинок» отбирает и исключает, сначала где кадров больше, число на карточке; сортировка скрыта; «Сбросить» возвращает всё', async ({ page }) => {
    const all = await apiGames(page);
    const [a, b] = all.map((g) => g.id).filter((id) => id !== 'Starfall_Inn');
    const games = { Starfall_Inn: [0, 5, 1, 3], [a]: [0, 40], [b]: [1, 9] };
    await page.route(/\/api\/pictures\/games$/, (route) => route.fulfill({ json: { covered: 3, tags: ['maid', 'sword'], games } }));
    await page.route(/\/api\/pictures\/status/, (route) => route.fulfill({ json: { state: 'off', analysis: { on: false, state: 'off' }, tagged: true } }));
    await openLibrary(page);
    const open = page.locator('.pic-tags-tool button');
    await expect(page.locator('.sort-order')).toBeVisible();
    // «Что на картинках» — среди списков под «Фильтры»
    await openFilters(page);
    await open.click();
    const panel = page.locator('.tag-panel');
    await expect(panel.locator('.tag-row-name')).toHaveText(['горничная', 'меч']);
    await panel.locator('.tag-row', { hasText: 'горничная' }).locator('.tag-row-main').click();
    await panel.locator('.tag-row', { hasText: 'горничная' }).locator('.tag-row-main').press('Escape');
    const cards = page.locator('.library .game-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first().locator('.card-frames')).toHaveText('40 кадров');
    await expect(cards.nth(1).locator('.card-frames')).toHaveText('5 кадров');
    await expect(page.locator('.sort-order')).toHaveCount(0);
    await expect(page.locator('.tag-picked-n')).toContainText('2 из 3');
    // Исключение: без меча остаётся одна игра
    await open.click();
    await panel.locator('.tag-row', { hasText: 'меч' }).locator('.tag-row-no').click();
    await expect(cards).toHaveCount(1);
    await panel.locator('.tag-apply').click();
    await page.locator('.tag-picked .tag-reset', { hasText: 'Сбросить' }).click();
    await expect(cards.first().locator('.card-frames')).toHaveCount(0);
    await expect(page.locator('.sort-order')).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(2);
  });

  test('«Что на картинках» в окне игры: теги с числом кадров; тег открывает галерею с этим отбором', async ({ page }) => {
    await mockScene(page, { albums: ['events/00001/Night scene', { key: 'events/00002/Bath', album: { files: ['pic2.png', 'pic3.png'], cover: 'pic2.png' } }], scene: oneLine });
    await page.route(/\/api\/gallery\/Starfall_Inn\/inside$/, (route) => route.fulfill({ json: { frames: 4, tags: [{ tag: 'maid', n: 3 }, { tag: 'cow_print', n: 2 }] } }));
    await page.route(/\/api\/gallery\/Starfall_Inn\/tags(\?|$)/, (route) => route.fulfill({ json: { files: ['pic0.png', 'pic1.png', 'pic2.png', 'pic3.png'], tags: [{ tag: 'maid', f: [2, 3] }], hidden: [] } }));
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    const inside = page.locator('.game-inside');
    await expect(inside.locator('.tag-link')).toHaveText(['горничная3', 'cow print2']);
    await inside.locator('.tag-link').first().click();
    await expect(page.locator('.tag-picked')).toContainText('горничная');
    await expect(page.locator('.gallery-grid .gallery-tile')).toHaveCount(1);
    // Закрыли и открыли кнопкой «Галерея» — отбора уже нет
    await page.locator('.gallery-close').first().click();
    await page.locator('.act-gallery').click();
    await expect(page.locator('.gallery-grid .gallery-tile')).toHaveCount(2);
    await expect(page.locator('.tag-picked')).toHaveCount(0);
  });

  test('теги картинок: панель в галерее — поиск, порядок, отбор кадров и сцен, числа сужаются; «Теги» в просмотре; тег — поиск по всем играм', async ({ page }) => {
    await mockScene(page, { albums: ['events/00001/Night scene', { key: 'events/00002/Bath', album: { files: ['pic2.png', 'pic3.png'], cover: 'pic2.png' } }], scene: oneLine });
    await page.route(/\/api\/gallery\/Starfall_Inn\/tags(\?|$)/, (route) => (new URL(route.request().url()).searchParams.get('f')
      ? route.fulfill({ json: { tags: [{ tag: 'sword', p: 0.9 }, { tag: 'glasses', p: 0.6 }, { tag: 'cow_print', p: 0.5 }] } })
      // pic2 и pic3 — один альбом и одна сцена, но разные кадры
      : route.fulfill({ json: { files: ['pic0.png', 'pic1.png', 'pic2.png', 'pic3.png'], tags: [{ tag: 'night', f: [0, 1, 2] }, { tag: 'sword', f: [1, 2] }, { tag: 'maid', f: [1] }, { tag: 'boots', f: [3] }, { tag: 'cow_print', f: [0, 1, 2, 3] }] } })));
    const searched = [];
    await page.route(/\/api\/pictures\/search\?/, (route) => { searched.push(new URL(route.request().url()).searchParams.get('q')); return route.fulfill({ json: { games: 1, results: [] } }); });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    await page.locator('.act-gallery').click();
    const tiles = page.locator('.gallery-grid .gallery-tile');
    await expect(tiles).toHaveCount(2);
    const open = page.locator('.gallery-tools .gallery-play[aria-haspopup="dialog"]');
    await open.click();
    const panel = page.locator('.tag-panel');
    const names = panel.locator('.tag-row-name');
    // Сначала теги со своим названием — по числу, с равным числом по алфавиту; без названия (cow print) — в конце
    await expect(names).toHaveText(['ночь', 'меч', 'горничная', 'сапоги', 'cow print']);
    await panel.locator('.tag-sort button', { hasText: 'А–Я' }).click();
    await expect(names).toHaveText(['горничная', 'меч', 'ночь', 'сапоги', 'cow print']);
    await panel.locator('.tag-sort button', { hasText: 'Чаще' }).click();
    // Поиск — и по названию, и по имени у модели
    await panel.locator('input').fill('сап');
    await expect(names).toHaveText(['сапоги']);
    await panel.locator('input').fill('swor');
    await expect(names).toHaveText(['меч']);
    // Выбор действует сразу, числа — среди отобранного: сапог на этих кадрах нет — такого тега в списке больше нет
    await panel.locator('.tag-row', { hasText: 'меч' }).click();
    await panel.locator('input').fill('');
    await expect(names).toHaveText(['меч', 'ночь', 'горничная', 'cow print']);
    await expect(panel.locator('.tag-row.on .tag-row-n')).toHaveText('2');
    await expect(panel.locator('.tag-apply')).toHaveText('Показать 2 кадра');
    await panel.locator('.tag-row', { hasText: 'горничная' }).click();
    await expect(panel.locator('.tag-apply')).toHaveText('Показать 1 кадр');
    await panel.locator('.tag-apply').click();
    await expect(panel).toHaveCount(0);
    await expect(tiles).toHaveCount(1);
    await expect(tiles.first().locator('img')).toHaveAttribute('src', /pic1\.png/);
    const row = page.locator('.tag-picked');
    await expect(row).toContainText('1 кадр');
    await expect(open).toContainText('2');
    // Крестик у тега
    await row.locator('.tag-picked-chip', { hasText: 'горничная' }).click();
    await expect(tiles).toHaveCount(2);
    await row.locator('.tag-reset').first().click();
    await expect(row).toHaveCount(0);
    // «Без тега»: кадров с «ночь» нет. Остался pic3 (только сапоги и cow print); тег из исключённых снимается и значком, и
    // строкой (тогда он становится выбранным)
    await open.click();
    await panel.locator('.tag-row', { hasText: 'ночь' }).locator('.tag-row-no').click();
    await expect(panel.locator('.tag-apply')).toHaveText('Показать 1 кадр');
    await expect(names).toHaveText(['ночь', 'сапоги', 'cow print']);
    await expect(panel.locator('.tag-row.no .tag-row-name')).toHaveText('ночь');
    await panel.locator('.tag-apply').click();
    await expect(tiles).toHaveCount(1);
    await expect(tiles.first().locator('img')).toHaveAttribute('src', /pic3\.png/);
    // «Скрывать всегда» — в список скрытых; второй раз кнопки нет
    const hidden = [];
    await page.route(/\/api\/pictures\/hidden$/, (route) => { hidden.push(route.request().postDataJSON()); return route.fulfill({ json: { tags: ['night'] } }); });
    await row.locator('.tag-reset', { hasText: 'Скрывать всегда' }).click();
    await expect.poll(() => hidden).toEqual([{ add: ['night'] }]);
    await expect(row.locator('.tag-reset', { hasText: 'Скрывать всегда' })).toHaveCount(0);
    await row.locator('.tag-reset', { hasText: 'Сбросить' }).click();
    await expect(row).toHaveCount(0);
    // «Сцены»: сцена подходит, если теги есть на разных её кадрах
    await page.locator('.gallery-source', { hasText: 'Сцены' }).click();
    await open.click();
    await panel.locator('.tag-row', { hasText: 'меч' }).click();
    await panel.locator('.tag-row', { hasText: 'сапоги' }).click();
    await expect(panel.locator('.tag-apply')).toHaveText('Показать 1 сцену');
    // Нажатие мимо закрывает панель и плитку не открывает
    await page.mouse.click(30, 500);
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.scene')).toHaveCount(0);
    await expect(page.locator('.gallery-tile')).toHaveCount(1);
    await expect(page.locator('.gallery-tile')).toContainText('Bath');
    // Те же теги в «Картинках»: на одном кадре их нет — так и пишем; сброс возвращает всё
    await page.locator('.gallery-source', { hasText: 'Картинки' }).click();
    await expect(page.locator('.state-title')).toHaveText('С такими тегами здесь ничего нет');
    await row.locator('.tag-reset').click();
    await expect(tiles).toHaveCount(2);
    // Просмотр: «Похожие» — окно поиска сразу с похожими на этот кадр; закрыли — тот же просмотр
    await tiles.first().click();
    const like = [];
    await page.route(/\/api\/pictures\/similar\?/, (route) => { like.push(new URL(route.request().url()).searchParams); return route.fulfill({ json: { games: 1, results: [], more: false } }); });
    await page.locator('.gallery-bar .gallery-play', { hasText: 'Похожие' }).click();
    await expect(page.locator('.pics-like')).toContainText('Похожие на кадр из «Starfall Inn»');
    await expect.poll(() => like.length).toBe(1);
    expect(like[0].get('f')).toBe('pic0.png');
    await page.keyboard.press('Escape');
    await expect(page.locator('.favorites')).toHaveCount(0);
    // «Теги» — теги кадра; нажатие — поиск по картинкам во всех играх
    const strip = page.locator('.gallery-tags');
    await expect(strip).toHaveCount(0);
    await page.locator('.gallery-bar .gallery-play', { hasText: 'Теги' }).click();
    await expect(strip.locator('.chip')).toHaveText(['меч', 'очки', 'cow print']);
    await strip.locator('.chip', { hasText: 'очки' }).click();
    await expect(page.locator('.favorites input').first()).toHaveValue('glasses');
    await expect.poll(() => searched.at(-1)).toBe('glasses');
    // Первый Escape в поле стирает слова, второй закрывает окно поиска — под ним тот же просмотр
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.favorites')).toHaveCount(0);
    await expect(strip.locator('.chip')).toHaveCount(3);
  });

  test('страница под окном не прокручивается: окно игры и галерея; закрыли — страница на том же месте и снова крутится', async ({ page }) => {
    await openLibrary(page);
    await page.evaluate(() => { document.body.style.minHeight = '4000px'; window.scrollTo(0, 500); });
    const y = () => page.evaluate(() => Math.round(window.scrollY));
    await expect.poll(y).toBe(500);
    const headerTop = () => page.locator('header').first().evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const stuck = await headerTop();
    await page.locator('.library > .game-card').filter({ hasText: 'Starfall Inn' }).first().locator('.card-title').click();
    await expect(page.locator('.modal-content')).toBeVisible();
    // Страница стоит, а липкая шапка под окном — на своём месте, а не уехала с прокруткой
    expect(await headerTop()).toBe(stuck);
    const before = await y();
    const wheel = async (dy) => { await page.mouse.move(640, 300); for (let i = 0; i < 5; i++) await page.mouse.wheel(0, dy); await page.waitForTimeout(200); };
    await wheel(-500);
    await wheel(500);
    expect(await y()).toBe(before);
    await page.locator('.act-gallery').click();
    await expect(page.locator('.gallery').first()).toBeVisible();
    await wheel(-500);
    await wheel(500);
    expect(await y()).toBe(before);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-content')).toHaveCount(0);
    expect(await y()).toBe(before);
    await wheel(300);
    expect(await y()).toBeGreaterThan(before);
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
    // Номер реплики — на левом краю полосы реплик, сколько их — на правом
    const pos = page.locator('.scene-seek .seek-time.cur');
    await expect(page.locator('.scene-seek .seek-time').last()).toHaveText('4');
    await expect(text).toContainText('English line 1');
    await page.keyboard.press('Space');
    await expect(text).toContainText('English line 2');
    await expect(pos).toHaveText('2');
    // Выбор языка меняет текст на месте: номер реплики тот же
    await pick.click();
    await page.locator('.scene-pick-opt', { hasText: '日本語' }).click();
    await expect(text).toContainText('日本語 2');
    await expect(pos).toHaveText('2');
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
    await expect(pos).toHaveText('1');
    await expect(text).toContainText('English line 1');
    await page.keyboard.press('Space');
    await expect(pos).toHaveText('2');
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

  // Полоса реплик (SeekLine над панелью): десять реплик; картинка pic0, перед 4-й — пауза события 6 с и pic1, перед 7-й —
  // pic2; музыка A сначала, B перед 5-й, стоп перед 8-й; тон перед 6-й; затемнение перед 9-й; голос перед 5-й и 8-й
  const seekScene = () => ({ files: ['pic0.png', 'pic1.png', 'pic2.png'], steps: [
    { k: 'pic', i: 0 }, { k: 'snd', kind: 'bgm', f: 'bgm/A' }, { k: 'say', who: 'Анна', text: 'Line 1' }, { k: 'say', who: '', text: 'Line 2' }, { k: 'say', who: '', text: 'Line 3' },
    { k: 'wait', n: 360 }, { k: 'pic', i: 1 }, { k: 'say', who: '', text: 'Line 4' },
    { k: 'snd', kind: 'bgm', f: 'bgm/B' }, { k: 'snd', kind: 'voice', f: 'voice/v5' }, { k: 'say', who: '', text: 'Line 5' },
    { k: 'fx', t: 'tint', c: [-68, -68, 0, 0], n: 30 }, { k: 'say', who: '', text: 'Line 6' },
    { k: 'pic', i: 2 }, { k: 'say', who: '', text: 'Line 7' },
    { k: 'stop', kind: 'bgm' }, { k: 'snd', kind: 'voice', f: 'voice/v8' }, { k: 'say', who: '', text: 'Line 8' },
    { k: 'fx', t: 'fade', o: 1, n: 24 }, { k: 'say', who: '', text: 'Line 9' }, { k: 'say', who: '', text: 'Line 10' }] });
  // Тянуть мышью от бегунка к строке k (с нуля) из total; up — отпустить
  const scrubTo = async (page, k, total, up = true) => {
    const bar = await page.locator('.scene-seek .seek-line').boundingBox();
    const gem = await page.locator('.scene-seek .seek-gem').boundingBox();
    await page.mouse.move(gem.x + gem.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + (bar.width * k) / (total - 1), bar.y + bar.height / 2, { steps: 4 });
    if (up) await page.mouse.up();
  };
  const scenePic = (page) => page.locator('.scene-pic:not(.scene-anim):not(.scene-dim)');
  const playing = async (page, f) => (await audios(page)).filter((a) => a.f === f && a.on).length;

  test('сцена: полоса реплик — тянуть мышью; картинка, тон, затемнение, музыка и голос — как к этой строке; касание полосы не листает', async ({ page }) => {
    await watchAudio(page);
    await mockScene(page, { scene: seekScene });
    await openScene(page);
    const text = page.locator('.scene-text');
    const slider = page.locator('.scene-seek .seek-line');
    await expect(text).toHaveText('Line 1');
    await expect(page.locator('.scene-seek .seek-time')).toHaveText(['1', '10']);
    await expect(slider).toHaveAttribute('aria-valuetext', 'Реплика 1 из 10');
    // Счётчика в панели больше нет: числа — по краям полосы
    await expect(page.locator('.scene-bar .scene-pos')).toHaveCount(0);
    expect(await playing(page, 'bgm/A')).toBe(1);
    // Пока тянут, строка под пальцем видна сразу целиком; паузу события перед 4-й не ждём
    await scrubTo(page, 3, 10, false);
    await expect(text).toHaveText('Line 4', { timeout: 700 });
    await expect(slider).toHaveAttribute('aria-valuenow', '3');
    await page.mouse.up();
    await expect(scenePic(page)).toHaveAttribute('src', /pic1\.png/);
    await expect(page.locator('.scene-seek .seek-time.cur')).toHaveText('4');
    await page.waitForTimeout(400);
    await expect(text).toHaveText('Line 4');
    // 6-я: тон стоит, играет музыка B, A на паузе; голос 5-й строки не звучал
    await scrubTo(page, 5, 10);
    await expect(text).toHaveText('Line 6');
    await expect(page.locator('.scene-tint-dim')).toHaveCSS('background-color', 'rgb(187, 187, 255)');
    await expect.poll(() => playing(page, 'bgm/B')).toBe(1);
    expect(await playing(page, 'bgm/A')).toBe(0);
    expect((await audios(page)).some((a) => a.f === 'voice/v5')).toBe(false);
    // 5-я: её голос звучит вместе с ней
    await scrubTo(page, 4, 10);
    await expect(text).toHaveText('Line 5');
    await expect.poll(async () => (await audios(page)).filter((a) => a.f === 'voice/v5').length).toBe(1);
    // 9-я: затемнение стоит, музыка остановлена
    await scrubTo(page, 8, 10);
    await expect(text).toHaveText('Line 9');
    await expect(page.locator('.scene-fade')).toHaveCSS('opacity', '1');
    expect(await playing(page, 'bgm/B')).toBe(0);
    // Назад ко 2-й: pic0, светло, тона нет, снова A; к 3-й — A играет дальше тем же плеером, а не новым
    await scrubTo(page, 1, 10);
    await expect(text).toHaveText('Line 2');
    await expect(scenePic(page)).toHaveAttribute('src', /pic0\.png/);
    await expect(page.locator('.scene-fade')).toHaveCSS('opacity', '0');
    await expect(page.locator('.scene-tint-dim')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect.poll(() => playing(page, 'bgm/A')).toBe(1);
    const made = (await audios(page)).filter((a) => a.f === 'bgm/A').length;
    await scrubTo(page, 2, 10);
    await expect(text).toHaveText('Line 3');
    expect((await audios(page)).filter((a) => a.f === 'bgm/A').length).toBe(made);
    expect(await playing(page, 'bgm/A')).toBe(1);
    // Короткое нажатие на полосу — переход на строку, а не «дальше»
    const bar = await slider.boundingBox();
    await page.mouse.click(bar.x + (bar.width * 6) / 9, bar.y + bar.height / 2);
    await expect(text).toHaveText('Line 7');
    await page.waitForTimeout(500);
    await expect(text).toHaveText('Line 7');
    await expect(scenePic(page)).toHaveAttribute('src', /pic2\.png/);
  });

  // Отпустили полосу и сразу нажали на экран, пока сервер склеивает картинку строки: дальше идём от неё, а строка полосы
  // не залипает в рамке (на телефоне это обычное «отпустил и нажал»)
  test('сцена: полосу отпустили и сразу листают, пока картинка строки грузится, — следующая реплика, «Авто» листает дальше', async ({ page }) => {
    const scene = () => ({ files: ['pic0.png', 'pic1.png', 'pic2.png', 'pic3.png'], steps: [
      { k: 'pic', i: 0 }, { k: 'say', who: '', text: 'Line 1' }, { k: 'pic', i: 1 }, { k: 'say', who: '', text: 'Line 2' }, { k: 'pic', i: 2 },
      ...Array.from({ length: 6 }, (_, i) => ({ k: 'say', who: '', text: `Line ${i + 3}` })),
      { k: 'pic', i: 3 }, { k: 'say', who: '', text: 'Line 9' }, { k: 'say', who: '', text: 'Line 10' }, { k: 'say', who: '', text: 'Line 11' }] });
    await mockScene(page, { scene, delay: (f) => (f === 'pic3.png' ? 1500 : 0) });
    await openScene(page);
    const text = page.locator('.scene-text');
    await expect(text).toHaveText('Line 1');
    await scrubTo(page, 8, 11);
    await expect(text).toHaveText('Line 9');
    await page.locator('.scene-box').click();
    await expect(text).toHaveText('Line 10', { timeout: 5000 });
    await expect(page.locator('.scene-seek .seek-time.cur')).toHaveText('10');
    await page.locator('.scene .gallery-play', { hasText: 'Авто' }).click();
    await expect(text).toHaveText('Line 11', { timeout: 8000 });
  });

  test('сцена: полоса реплик с клавиатуры — Home и End; ←/→ листают по одной; Backspace — назад', async ({ page }) => {
    await mockScene(page, { scene: seekScene });
    await openScene(page);
    const text = page.locator('.scene-text');
    await expect(text).toHaveText('Line 1');
    await page.locator('.scene-seek .seek-line').focus();
    await page.keyboard.press('End');
    await expect(text).toHaveText('Line 10');
    await expect(page.locator('.scene-fade')).toHaveCSS('opacity', '1');
    await page.keyboard.press('Home');
    await expect(text).toHaveText('Line 1');
    await expect(page.locator('.scene-fade')).toHaveCSS('opacity', '0');
    await page.keyboard.press('ArrowRight');
    await expect(text).toHaveText('Line 2');
    await page.keyboard.press('ArrowRight');
    await expect(text).toHaveText('Line 3');
    await page.keyboard.press('ArrowLeft');
    await expect(text).toHaveText('Line 2');
    await page.keyboard.press('Backspace');
    await expect(text).toHaveText('Line 1');
    await expect(page.locator('.scene')).toBeVisible();
  });

  test('сцена: «назад» — сразу на предыдущую реплику, пауза события перед ней не ждётся заново', async ({ page }) => {
    const scene = () => ({ files: ['pic0.png'], steps: [{ k: 'pic', i: 0 }, { k: 'say', who: '', text: 'One' }, { k: 'wait', n: 360 },
      { k: 'say', who: '', text: 'Two' }, { k: 'say', who: '', text: 'Three' }] });
    await mockScene(page, { scene });
    await openScene(page);
    const text = page.locator('.scene-text');
    await expect(text).toHaveText('One');
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await expect(text).toHaveText('Two');
    await page.keyboard.press('Space');
    await expect(text).toHaveText('Three');
    await page.keyboard.press('ArrowLeft');
    await expect(text).toHaveText('Two', { timeout: 700 });
    // Кнопка ‹ — то же
    await page.keyboard.press('Space');
    await expect(text).toHaveText('Three');
    await page.locator('.scene-bar .gallery-play[aria-label="Предыдущая реплика"]').click();
    await expect(text).toHaveText('Two', { timeout: 700 });
  });

  test('сцена: «Текст сразу» — реплика целиком, одно нажатие — одна реплика; выбор помнится', async ({ page }) => {
    // Печать по буквам есть только без «меньше движения»
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const long = (n) => `${n}: ${'Длинная реплика, которая печатается по буквам несколько секунд. '.repeat(3)}`;
    const scene = () => ({ files: ['pic0.png'], steps: [{ k: 'pic', i: 0 }, ...[1, 2, 3, 4, 5].map((n) => ({ k: 'say', who: '', text: long(n) }))] });
    await mockScene(page, { scene });
    await openScene(page);
    const text = page.locator('.scene-text');
    const rest = page.locator('.scene-rest');
    const btn = page.locator('.scene .gallery-play', { hasText: 'Текст сразу' });
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveAttribute('data-tip', /одно нажатие — одна реплика/);
    // Без режима: реплика печатается, первое нажатие только дописывает её
    await expect(text).toContainText('1:');
    await expect(rest).not.toHaveText('');
    await page.keyboard.press('Space');
    await expect(rest).toHaveText('');
    await expect(text).toContainText('1:');
    // Режим включён: каждая реплика сразу целиком, одно нажатие — следующая
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Space');
    await expect(text).toContainText('2:');
    await expect(rest).toHaveText('');
    await page.keyboard.press('Space');
    await expect(text).toContainText('3:');
    await expect(rest).toHaveText('');
    // Закрыли и открыли снова — режим помнится
    await page.keyboard.press('Escape');
    await page.locator('.gallery-play', { hasText: 'Смотреть сцену' }).click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(text).toContainText('1:');
    await expect(rest).toHaveText('');
    // Выключили — снова печать
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Space');
    await expect(text).toContainText('2:');
    await expect(rest).not.toHaveText('');
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
    // Ролик, что не открылся (404), ожидание конца не держит: следующая реплика — без нажатия на экран и сразу. Он подгружен
    // заранее и не открылся ещё до нажатия: ошибки, которую ждало бы ожидание, уже не будет — держать его 8 с нельзя
    await page.waitForTimeout(700);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Three', { timeout: 2500 });
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
    // Ролик с цепочкой: кончился — на его месте встаёт следующий (другой файл). Пока у нового нет кадра, прежний держится
    // под ним, без чёрного кадра: слоёв на миг два, и строгая проверка одного слоя в это мгновение падала. Ждём итог —
    // слой с новым файлом есть, прежнего нет
    await page.waitForTimeout(700);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Three');
    await expect(page.locator('.scene-screen > .scene-vid[src*="movies%2Fb.webm"]')).toHaveCount(1, { timeout: 9000 });
    await expect(layer).toHaveCount(1);
  });

  // Ролик на том же месте меняют на другой, а новый подгружен заранее (две реплики вперёд) и к нажатию уже готов или уже не
  // открылся: событий «loadeddata» и «error» у него больше не будет. Прежний слой всё равно уходит, а не играет под новым со
  // звуком; после «назад» — так же
  test('сцена: ролик на том же месте сменяет подгруженный заранее — прежний слой уходит (готов, 404, после «назад»)', async ({ page }) => {
    // Подгруженные ролики двигатель держит вне страницы: запоминаем все <video>, чтобы дождаться, когда новый готов
    await page.addInitScript(() => {
      const make = document.createElement.bind(document);
      window.__vids = [];
      document.createElement = (tag, ...rest) => {
        const el = make(tag, ...rest);
        if (String(tag).toLowerCase() === 'video') window.__vids.push(el);
        return el;
      };
    });
    const settledVid = (f) => expect.poll(() => page.evaluate((f) => window.__vids.some((v) => v.src.includes(f) && (v.readyState >= 2 || !!v.error)), f)).toBe(true);
    const A = { s: 'p3', f: 'movies/a.webm', loop: true, x: 0, y: 0, o: 0, zx: 100, zy: 100, op: 255 };
    const scene = () => ({ files: ['pic0.png', 'pic1.png'], screen: { w: 816, h: 624 }, steps: [
      { k: 'pic', i: 0 }, { k: 'say', who: '', text: 'One' },
      { k: 'vid', v: [A] }, { k: 'say', who: '', text: 'Two' },
      { k: 'vid', v: [{ ...A, f: 'movies/c.webm' }] }, { k: 'say', who: '', text: 'Three' },
      { k: 'vid', v: [{ ...A, f: 'movies/bad.webm' }] }, { k: 'say', who: '', text: 'Four' }] });
    await mockScene(page, { scene, video: (f) => f !== 'movies/bad.webm' });
    await openScene(page);
    const layer = page.locator('.scene-screen > .scene-vid');
    await expect(page.locator('.scene-text')).toContainText('One');
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Two');
    await expect(layer).toHaveAttribute('src', /movies%2Fa\.webm/);
    // Готовый: на месте один слой — новый
    await settledVid('movies%2Fc.webm');
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Three');
    await expect(layer).toHaveCount(1);
    await expect(layer).toHaveAttribute('src', /movies%2Fc\.webm/);
    // Не открылся (404): прежнего нет, а несостоявшийся скрыт — под ним картинка
    await settledVid('movies%2Fbad.webm');
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Four');
    await expect(layer).toHaveCount(1);
    await expect(layer).toBeHidden();
    // Назад и снова вперёд: ролик, что не открылся, уже известен — прежний слой уходит так же
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.scene-text')).toContainText('Three');
    await expect(layer).toHaveAttribute('src', /movies%2Fc\.webm/);
    await page.keyboard.press('Space');
    await expect(page.locator('.scene-text')).toContainText('Four');
    await expect(layer).toHaveCount(1);
    await expect(layer).toBeHidden();
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
    // Выбор забирает фокус на следующем кадре: иначе он отнял бы его у кнопки, и Enter запустил бы сцену
    await expect(pick.locator('.scene-pick-opt.active')).toBeFocused();
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
    await page.locator('.act-gallery').click();
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
    await page.locator('.act-gallery').click();
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
    // «С титула» в списке у стрелки — явно, без точки
    await page.locator('.play-split-more').click();
    await page.locator('.continue-from-title').click();
    const src = await page.locator('.game-frame iframe').getAttribute('src');
    expect(src).not.toMatch(/[?&](slot|mark)=/);
  });

  test('«Играть» со стрелкой: основная часть играет, стрелка открывает список, Escape закрывает его, не окно', async ({ page }) => {
    await resumeMocks(page, { slots: [slot] });
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    const arrow = page.locator('.play-split-more');
    await expect(page.locator('.continue-from-btn')).toHaveCount(0);
    await expect(arrow).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(arrow).toHaveAttribute('aria-expanded', 'false');
    await expect(arrow).toHaveAccessibleName('Продолжить с…');
    await arrow.click();
    await expect(arrow).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('.continue-from-panel');
    await expect(panel).toBeVisible();
    // Список — прямо под кнопкой, левым краем по ней
    const split = await page.locator('.play-split').boundingBox();
    const box = await panel.boundingBox();
    expect(Math.abs(box.x - split.x)).toBeLessThanOrEqual(2);
    expect(box.y).toBeGreaterThanOrEqual(split.y + split.height);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.modal-content')).toBeVisible();
    await expect(arrow).toHaveAttribute('aria-expanded', 'false');
    // Строка списка — игра сразу с этого сейва
    await arrow.click();
    await panel.locator('.continue-item-play').first().click();
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]slot=RPG%20File2(&|$)/);
    await page.goBack();
    await expect(page.locator('.game-frame')).toHaveCount(0, { timeout: 10_000 });
    // Основная часть с клавиатуры: Enter играет с последнего сейва, как и клик
    await page.locator('#modal-play-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]slot=RPG%20File2(&|$)/);
  });

  test('стрелка «Играть»: после Escape фокус возвращается на неё; фокус обводит всю кнопку; пустой вкладки «Моменты 0» нет', async ({ page }) => {
    await resumeMocks(page, { slots: [slot] });
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    const arrow = page.locator('.play-split-more');
    await arrow.focus();
    await page.keyboard.press('Enter');
    const panel = page.locator('.continue-from-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(arrow).toBeFocused();
    // Рамка фокуса — вокруг всей кнопки, а не одной её части
    const outline = await page.locator('.play-split').evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
    await expect(page.locator('#modal-play-btn')).toHaveCSS('outline-style', 'none');
  });

  test('пока сейвы не ответили, место под стрелку занято: значки не сдвигаются, когда она появляется', async ({ page }) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route(/\/api\/saves\/history\/Ember_and_Frost$/, async (route) => { await gate; await route.fulfill({ json: { slots: [slot] } }); });
    await page.route(/\/api\/marks\/Ember_and_Frost$/, (route) => route.fulfill({ json: [] }));
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    const before = await page.locator('.act-gallery').boundingBox();
    await expect(page.locator('.play-split-more.ghost')).toHaveCount(1);
    release();
    await expect(page.locator('.play-split-more:not(.ghost)')).toBeVisible();
    const after = await page.locator('.act-gallery').boundingBox();
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  });

  test('на планшете (800) окно игры — две колонки: обложка слева, название вровень с её верхом', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    const cover = await page.locator('.modal-cover-wrapper').boundingBox();
    const title = await page.locator('#modal-title').boundingBox();
    expect(title.x).toBeGreaterThan(cover.x + cover.width);
    expect(Math.abs(title.y - cover.y)).toBeLessThan(24);
  });

  test('в узком окне (701) «Играть» со стрелкой и три значка не вылезают за правую колонку', async ({ page }) => {
    await resumeMocks(page, { slots: [slot] });
    await page.setViewportSize({ width: 701, height: 900 });
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await expect(page.locator('.play-split-more')).toBeVisible();
    const col = await page.locator('.modal-actions').evaluate((row) => row.parentElement.getBoundingClientRect().right);
    const more = await page.locator('.modal-more').boundingBox();
    expect(more.x + more.width).toBeLessThanOrEqual(col + 0.5);
  });

  // «Где вышли» посреди сцены (iPhone выгрузил вкладку): свежее сейва — «Играть» с неё, в списке — реплика.
  // Из прежней версии игры (stale) сама не берётся: «Играть» — с сейва
  const midExit = { id: 'e1', kind: 'auto', why: 'exit', mid: true, label: 'Ты опять опоздал', map: 'Hall', at: 3000, save: true };

  test('«Где вышли» посреди сцены: «Играть» продолжает с неё, в «Продолжить с…» — реплика', async ({ page }) => {
    await resumeMocks(page, { slots: [slot], marks: [midExit] });
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]mark=e1(&|$)/);
    await page.goBack();
    await expect(page.locator('.game-frame')).toHaveCount(0, { timeout: 10_000 });
    await page.locator('.play-split-more').click();
    await expect(page.locator('.continue-from-panel .continue-item-name').first()).toHaveText('Где вы вышли: Ты опять опоздал');
    await expect(page.locator('.continue-from-panel .continue-item-sub').first()).toContainText('Hall');
  });

  test('«Где вышли» посреди сцены из прежней версии игры — «Играть» с сейва', async ({ page }) => {
    await resumeMocks(page, { slots: [slot], marks: [{ ...midExit, stale: true }] });
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]slot=RPG%20File2(&|$)/);
  });

  test('страница открыта заново с ?play= — игра с последней точки, как «Играть», а не с титула', async ({ page }) => {
    await resumeMocks(page, { slots: [slot], marks: [midExit] });
    await page.goto('/?play=Ember_and_Frost');
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]mark=e1(&|$)/, { timeout: 15_000 });
  });

  test('«Играть» без сейвов и моментов — одна кнопка, стрелки нет', async ({ page }) => {
    await resumeMocks(page, {});
    await openLibrary(page);
    await openGame(page, 'Ember & Frost');
    await expect(page.locator('#modal-play-btn')).toBeVisible();
    await expect(page.locator('.play-split-more')).toHaveCount(0);
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.game-frame iframe')).not.toHaveAttribute('src', /[?&](slot|mark)=/);
  });

  test('значки «Галерея», «Изменить», «⋯» на десктопе — без слов, с подписью и подсказкой', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    for (const [sel, name] of [['.act-gallery', 'Галерея'], ['.act-edit', 'Изменить']]) {
      const b = page.locator(sel);
      await expect(b).toHaveAccessibleName(name);
      await expect(b.locator('.icon-btn-word')).toBeHidden();
      expect((await b.boundingBox()).width).toBeLessThanOrEqual(52);
    }
    await expect(page.locator('.modal-more-btn')).toHaveAccessibleName(/Ещё/);
    // Подсказка — наша (Tip.jsx), не системная
    await page.locator('.act-edit').hover();
    await expect(page.locator('.tip')).toContainText('Изменить');
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
    await page.locator('.act-gallery').click();
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
