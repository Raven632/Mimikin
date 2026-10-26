const test = require('node:test');
const assert = require('node:assert');
// Настоящий fetch — до всех подмен в тестах (MyJDownloader ходит на свой поддельный сервер)
const nativeFetch = globalThis.fetch;

// 1. Правильный импорт мидлвары (она обычная функция)
const { requireAuth } = require('./src/routes/auth.js');
const dbService = require('./src/db/database.js');
const { isSafeSegment } = require('./src/utils/validate.js');

// 2. Правильный импорт скрапера (это ЭКЗЕМПЛЯР КЛАССА, импортируем целиком)
const scraperService = require('./src/services/scraper.js');
// Имя куки задаётся через .env (в dev оно своё — auth_token_dev),
// поэтому тест обязан спрашивать его там же, где код, а не писать строку руками
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'auth_token';

// Тесты не тратят кредиты ScraperAPI и не трогают его дневной счётчик: ключ из окружения
// (в контейнере dev он настоящий) убираем. Тесты, которым он нужен, ставят свой и подменяют fetch
delete process.env.SCRAPER_API_KEY;
// И не качают модель распознавания картинок галереи (85 МБ): тест распознавания подменяет её сам
process.env.GALLERY_VISION = '0';

// ============================================================================
// requireAuth tests (Проверка авторизации)
// ============================================================================

test('requireAuth: GET/POST без куки возвращает 401', () => {
  const req = { method: 'GET', cookies: {} };
  let statusCode;
  let payload;
  let nextCalled = false;

  const res = {
    status(code) {
      statusCode = code;
      return { json(body) { payload = body; } };
    }
  };

  requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'next() не должен вызываться');
  assert.strictEqual(statusCode, 401, 'Ожидается HTTP 401');
  assert.ok(payload && payload.error, 'Должен быть текст ошибки');
});

test('requireAuth: запрос с неверным токеном возвращает 401', () => {
  const req = { method: 'POST', cookies: { [COOKIE_NAME]: 'WRONG_TOKEN_123' } };
  let statusCode;
  let nextCalled = false;

  const res = {
    status(code) {
      statusCode = code;
      return { json() {} };
    }
  };

  requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'next() не должен вызываться при неверном токене');
  assert.strictEqual(statusCode, 401, 'Ожидается HTTP 401');
});

test('requireAuth: запрос с правильным токеном пропускается', (t) => {
  const originalToken = dbService.sessionToken;
  dbService.sessionToken = 'test_token_123';
  t.after(() => { dbService.sessionToken = originalToken; });

  const req = { method: 'POST', cookies: { [COOKIE_NAME]: 'test_token_123' } };
  const res = {};
  let nextCalled = false;

  requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true, 'Запрос с валидным токеном должен проходить');
});

test('requireAuth: пустой токен сервера (до init) не пропускает пустую куку', (t) => {
  const originalToken = dbService.sessionToken;
  dbService.sessionToken = '';
  t.after(() => { dbService.sessionToken = originalToken; });

  const req = { method: 'GET', cookies: { [COOKIE_NAME]: '' } };
  let statusCode;
  let nextCalled = false;
  const res = { status(code) { statusCode = code; return { json() {} }; } };

  requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'next() не должен вызываться');
  assert.strictEqual(statusCode, 401, 'Ожидается HTTP 401');
});

test('requireAuth: старый захардкоженный fallback-токен больше не работает', () => {
  const req = { method: 'GET', cookies: { [COOKIE_NAME]: 'fallback_secret_key_for_dev' } };
  let statusCode;
  let nextCalled = false;
  const res = { status(code) { statusCode = code; return { json() {} }; } };

  requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'next() не должен вызываться');
  assert.strictEqual(statusCode, 401, 'Ожидается HTTP 401');
});

// ============================================================================
// isSafeSegment tests (Защита id игры от "." / ".." / слэшей)
// ============================================================================

test('isSafeSegment: отбивает опасные значения', () => {
  for (const bad of ['', '.', '..', '../x', 'a/b', '/etc', 'x/..', undefined, null, 42]) {
    assert.strictEqual(isSafeSegment(bad), false, `Должен отбить: ${JSON.stringify(bad)}`);
  }
});

test('isSafeSegment: пропускает реальные имена папок игр', () => {
  for (const good of ['Game01364780', 'Lantern\'s Rest 255342', 'Marlow_ Town of Bakers', 'Moonlit-1.08', '...json']) {
    assert.strictEqual(isSafeSegment(good), true, `Должен пропустить: ${good}`);
  }
});

// ============================================================================
// findRJCode tests (Поиск RJ-кода в файлах)
// ============================================================================

const fsp = require('fs').promises;

test('titleFromFolder: всё после номера версии — служебный хвост', () => {
  const t = (f) => scraperService.titleFromFolder(f);
  assert.strictEqual(t('Echoes_of_the_Old_Lighthouse_1.4-Moon_Studio'), 'Echoes of the Old Lighthouse');
  assert.strictEqual(t('starfall-inn-2.01-rus__example.site'), 'starfall inn');
  assert.strictEqual(t('celestia-ver-1.07-cn-mod-55.6-fixed2-rus__example.site'), 'celestia');
  // Число без точки — часть названия, а не версия
  assert.strictEqual(t('Tiny_Quest_2-v1.0'), 'Tiny Quest 2');
  // Точки между словами — пробелы, точка в версии — нет
  assert.strictEqual(t('Lantern.Keeper.Northern.Isles.KG'), 'Lantern Keeper Northern Isles KG');
  assert.strictEqual(t('Game.Name.v1.03'), 'Game Name', 'точка в версии — не пробел, версия срезана');
});

// ============================================================================
// translateText tests (Проверка переводчика)
// ============================================================================

test('translateText: корректно обрабатывает пустой текст', async () => {
  // Вызываем через объект скрапера
  const result = await scraperService.translateText('');
  assert.strictEqual(result, '');
});

test('translateText: возвращает оригинальный текст при ошибке API', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network error'); };

  t.after(() => { global.fetch = originalFetch; });

  // Вызываем через объект скрапера
  const result = await scraperService.translateText('Original text');
  assert.strictEqual(result, 'Original text', 'При сбое сети должен вернуться оригинал');
});

// ============================================================================
// Политика поиска метаданных (итог попытки и срок следующей)
// ============================================================================

const plan = require('./src/utils/scrapeplan.js');

test('scrapeplan: итог считается по тому, что у игры осталось после попытки', () => {
    const full = { tags: '["rpg"]', link: 'https://store.steampowered.com/app/1', screens: '["a.jpg"]' };
    assert.strictEqual(plan.statusOfRow(full), 'ok');
    assert.strictEqual(plan.statusOfRow({ ...full, screens: '[]' }), 'partial', 'теги есть, картинок нет');
    // Поиск упал, но теги остались с прошлого раза — игра не становится «не найденной»
    assert.strictEqual(plan.statusOfRow({ ...full, screens: '[]' }, ['store.steampowered.com']), 'partial');
    assert.strictEqual(plan.statusOfRow({ tags: '[]' }), 'not_found', 'все ответили «нет»');
    assert.strictEqual(plan.statusOfRow({ tags: '[]' }, ['store.steampowered.com']), 'error', 'кто-то не ответил');
});

test('scrapeplan: паузы растут, а после последней автопоиск останавливается', () => {
    const now = 1_000_000;
    assert.deepStrictEqual(plan.planNext('ok', 3, now), { attempts: 0, retryAt: null }, 'успех обнуляет счётчик');

    let attempts = 0;
    const delays = [];
    for (;;) {
        const next = plan.planNext('not_found', attempts, now);
        attempts = next.attempts;
        if (next.retryAt === null) break;
        delays.push(next.retryAt - now);
    }
    assert.deepStrictEqual(delays, plan.DELAYS.not_found);
    for (let i = 1; i < delays.length; i++) assert.ok(delays[i] > delays[i - 1], 'каждая пауза длиннее предыдущей');

    // Сбой источника — временная беда: первая повторная попытка через час, а не через сутки
    assert.strictEqual(plan.planNext('error', 0, now).retryAt - now, plan.HOUR);
});

test('lookupMetadata: «нигде нет» и «не смогли спросить» — разные итоги', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });

    // Все источники ответили, но пусто
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    const none = await scraperService.lookupMetadata('Totally Unknown Game', '');
    assert.strictEqual(none.data, null);
    assert.deepStrictEqual(none.failed, [], 'никто не упал — значит честное «не найдено»');

    // Сеть лежит
    global.fetch = async () => { throw new Error('ECONNRESET'); };
    const down = await scraperService.lookupMetadata('Totally Unknown Game', '');
    assert.strictEqual(down.data, null);
    assert.ok(down.failed.length > 0, 'упавшие источники попали в отчёт');
    assert.ok(down.failed.includes('store.steampowered.com'), `ожидали Steam в ${JSON.stringify(down.failed)}`);
    assert.ok(down.failed.includes('api.vndb.org'), `ожидали VNDB в ${JSON.stringify(down.failed)}`);

    // Лимит 429 — тоже «не смогли спросить», хотя сеть в порядке
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' });
    const limited = await scraperService.lookupMetadata('Totally Unknown Game', '');
    assert.ok(limited.failed.length > 0);
});

// ============================================================================
// gamelang: язык по тексту самой игры
// ============================================================================

const os = require('os');
const path = require('path');
const { detectGameLanguages } = require('./src/utils/gamelang.js');

// Настоящая папка игры во временном каталоге: детектор читает файлы сам
async function makeGame(t, files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpg-lang-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}
const say = (lines) => ({ events: [null, { pages: [{ list: lines.map(s => ({ code: 401, parameters: [s] })) }] }] });

test('gamelang: русский перевод японской игры', async (t) => {
  const phrase = 'Ты правда думаешь, что мы успеем дойти до города до заката? Нам ещё идти через лес.';
  const dir = await makeGame(t, {
    'data/System.json': { locale: 'ja_JP' },
    // Имена карт видит только автор — по ним и узнаём язык оригинала
    'data/MapInfos.json': [null, { name: 'はじまりの村' }, { name: 'まおうのしろ' }],
    'data/Map001.json': say(Array(20).fill(phrase)),
  });
  assert.deepStrictEqual(await detectGameLanguages(dir), { main: 'ru', langs: ['ru'], original: 'ja' });
});

test('gamelang: таблица переводов даёт все языки, коды \\REM_MAP[...] — не текст', async (t) => {
  const ja = 'はぁ……いい天気だな。今日はどこへ行こうか。';
  const en = 'Hah… the weather feels great. Where should we go today, and what do you want to do?';
  const csv = ['Original,jp,en', ...Array(40).fill(`"${ja}","${ja}","${en}"`)].join('\n');
  const dir = await makeGame(t, {
    'data/System.json': { locale: 'en_US' },
    'data/MapInfos.json': [null, { name: 'Town' }],
    // Карты Ironhold Keep: вместо реплик ссылки на файлы перевода
    'data/Map001.json': say(Array(50).fill('\\REM_MAP[map17_ev63_p2_elena_15]')),
    'game_messages.csv': csv,
  });
  const found = await detectGameLanguages(dir);
  assert.deepStrictEqual([...found.langs].sort(), ['en', 'ja']);
});

// ============================================================================
// Название для показа и версия
// ============================================================================

const { presentTitle, extractVersion } = require('./src/utils/title.js');

test('presentTitle: срезает версии и подписи переводчиков, подзаголовок оставляет', () => {
  const show = (raw, folder = '') => presentTitle(raw, { folder }).title;
  assert.strictEqual(show('Silver Bell v1.0.9 | TL: Marlow & Co'), 'Silver Bell');
  assert.strictEqual(show("Moonlit Harbor: The Keeper's Daughter 1.3.0 Steam 04/17/2342"), "Moonlit Harbor: The Keeper's Daughter");
  assert.strictEqual(show('Звёздный трактир 2.01 (Перевод:Marlow)'), 'Звёздный трактир');
  assert.strictEqual(show('Echoes of the Old Lighthouse Production Version 1.4'), 'Echoes of the Old Lighthouse');
  assert.strictEqual(show('Mira s Potion Shop ver1.03'), "Mira's Potion Shop");
  assert.strictEqual(show('Tale of Stars ~Even Stars Fall, Captain Mira Sails On~ 1.04'), 'Tale of Stars ~Even Stars Fall, Captain Mira Sails On~');
  assert.strictEqual(show('Nebel Sternenjäger ~ The First Lamp Steam EN1.12 | Перевод: Marlow'), 'Nebel Sternenjäger ~ The First Lamp');
  // Число без точки — часть названия
  assert.strictEqual(show('Tiny Quest 2'), 'Tiny Quest 2');
});

test('presentTitle: японское название заменяет английское из имени папки', () => {
  const starfall = presentTitle('スターフォール［メッセージ非表示：右クリック | 文章スキップ：Control］', { folder: 'Starfall_v26.08.02' });
  assert.deepStrictEqual(starfall, { title: 'Starfall', original: 'スターフォール' });
  // Английского взять неоткуда — остаётся как есть
  assert.strictEqual(presentTitle('竜の郵便局最新', { folder: '竜の郵便' }).title, '竜の郵便局最新');
  // Сокращённое имя игры уступает полному из папки
  assert.strictEqual(presentTitle('Lantern 1.2', { folder: 'The_Lantern_Keeper_of_the_Northern_Isles_v1.2_Windows' }).title,
    'The Lantern Keeper of the Northern Isles');
});

test('extractVersion: из названия, иначе из папки; версия перевода после «|» не считается', () => {
  assert.strictEqual(extractVersion('A Knight Who Never Yields to the Storm_v1.0.4', ''), '1.0.4');
  assert.strictEqual(extractVersion('Star Lantern （ver1.19）', ''), '1.19');
  assert.strictEqual(extractVersion('Adventurer Karen', 'Adventurer_Karen'), '');
  assert.strictEqual(extractVersion('Walking to the harbor', 'Walking to the harbor 2.0.0v'), '2.0.0');
  assert.strictEqual(extractVersion('Лисички никогда не сдаются v1', 'fox-girls-never-give-up-ver1.03-rus__example.site'), '1.03');
  assert.strictEqual(extractVersion('Nebel | Версия перевода: 1.0', ''), '');
});


test('compareVersions: цепочка чисел, буква в конце, слова вокруг; без чисел — не сравнить', () => {
  const { compareVersions } = require('./src/utils/version.js');
  assert.strictEqual(compareVersions('v1.3.1.69 FULL + DLCs', '1.3.1.41'), 1);
  assert.strictEqual(compareVersions('v1.3', '1.3.0'), 0);
  assert.strictEqual(compareVersions('1.10', '1.9'), 1);
  assert.strictEqual(compareVersions('v0.99a', '0.99'), 1);
  assert.strictEqual(compareVersions('Ver.1.02', 'v1.02 Steam'), 0);
  assert.strictEqual(compareVersions('v2.0', '2.1'), -1);
  assert.strictEqual(compareVersions('Final', '1.0'), null);
  assert.strictEqual(compareVersions('v1.0', ''), null);
  // Одна версия, записанная по-разному
  assert.strictEqual(compareVersions('v1.09', '1.0.9'), 0);
  assert.strictEqual(compareVersions('v1.01', '1.0.1'), 0);
  // Дата вместо номера с номером не сравнивается, дата с датой — да
  assert.strictEqual(compareVersions('2026-08-27', '1.0.0'), null);
  assert.strictEqual(compareVersions('v.260926 Hotfix 2', 'v.250101'), 1);
  assert.strictEqual(compareVersions('v24.07.23', 'ver24.07.23'), 0);
});

test('Сейвы: где остановился — название карты из сейва; «MAP001» и «OP» — не место; папку игры только читаем', async (t) => {
  const { placeName, mapName } = require('./src/utils/saveprogress.js');
  assert.strictEqual(placeName('AbandonedShrine'), 'Abandoned Shrine');
  assert.strictEqual(placeName('Caves_action_stage'), 'Caves action stage');
  assert.strictEqual(placeName('\\C[2]Village\\C[0]'), 'Village');
  assert.deepStrictEqual([placeName('MAP001'), placeName('OP'), placeName(''), placeName('12')], [null, null, null, null]);
  assert.strictEqual(placeName('宿屋'), '宿屋');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'maps-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'Game', 'www', 'data');
  await fsp.mkdir(data, { recursive: true });
  await fsp.writeFile(path.join(data, 'System.json'), '{}');
  await fsp.writeFile(path.join(data, 'MapInfos.json'), JSON.stringify([null, { id: 1, name: 'MAP001' }, { id: 2, name: 'Old_Mine' }, { id: 3, name: 'Town' }]));
  await fsp.writeFile(path.join(data, 'Map003.json'), JSON.stringify({ displayName: 'Port Town Lisbel', data: [] }));
  await fsp.writeFile(path.join(data, 'Map002.json'), JSON.stringify({ displayName: '', data: [] }));
  const before = (await fsp.readdir(data)).sort();
  assert.strictEqual(await mapName('Game', 3, root), 'Port Town Lisbel', 'то, что игра пишет при входе на карту');
  assert.strictEqual(await mapName('Game', 2, root), 'Old Mine', 'без него — имя карты в редакторе');
  assert.strictEqual(await mapName('Game', 1, root), null);
  assert.strictEqual(await mapName('No_Such_Game', 3, root), null);
  assert.deepStrictEqual((await fsp.readdir(data)).sort(), before, 'в папке игры ничего не появилось');
});

// ============================================================================
// itch.io
// ============================================================================

test('itch.io: ссылка на игру — из строки ссылок; страница автора и сам itch.io — не игра', () => {
  const { itchGameUrl } = require('./src/utils/itch.js');
  assert.strictEqual(itchGameUrl('https://store.steampowered.com/app/1,https://Moon-Dev.itch.io/Seven-Keys/devlog/1'), 'https://moon-dev.itch.io/seven-keys');
  assert.strictEqual(itchGameUrl('https://moon-dev.itch.io/'), '');
  assert.strictEqual(itchGameUrl('https://itch.io/games/made-with-rpg-maker'), '');
  assert.strictEqual(itchGameUrl('https://www.itch.io/game'), '');
});

test('itch.io: лента каталога — название, жанр, цена, платформы, даты', () => {
  const { parseItchRss } = require('./src/utils/itch.js');
  const xml = `<rss><channel><title>Latest games made with RPG Maker - itch.io</title>
    <item><guid>https://xiaonur.itch.io/amoris</guid><title>Amoris [Free] [Role Playing] [Windows]</title><plainTitle>Amoris</plainTitle>
      <price>$0.00</price><currency>USD</currency><platforms><windows>yes</windows></platforms>
      <description><![CDATA[A horror game about a sister.
<img alt="Amoris" src="https://img.itch.zone/a/315x250/x.png"/>]]></description>
      <imageurl>https://img.itch.zone/a/315x250/x.png</imageurl><link>https://xiaonur.itch.io/amoris</link>
      <createDate>Tue, 01 Sep 2026 11:40:09 GMT</createDate><updateDate>Thu, 24 Sep 2026 18:31:23 GMT</updateDate></item>
    <item><guid>https://ophanimkei.itch.io/meat-girl</guid><title>meat girl [$5.00] [Adventure] [Windows]</title><plainTitle>meat girl &amp; co</plainTitle>
      <price>$5.00</price><platforms><windows>yes</windows><html>yes</html></platforms><link>https://ophanimkei.itch.io/meat-girl</link></item>
  </channel></rss>`;
  const [a, b] = parseItchRss(xml);
  assert.deepStrictEqual([a.title, a.creator, a.genre, a.price, a.platforms, a.description], ['Amoris', 'xiaonur', 'Role Playing', '', ['windows'], 'A horror game about a sister.']);
  assert.strictEqual(a.updatedAt, Date.parse('Thu, 24 Sep 2026 18:31:23 GMT'));
  assert.deepStrictEqual([b.title, b.price, b.platforms], ['meat girl & co', '$5.00', ['windows', 'html']]);
});

test('itch.io: страница игры — описание до «More information», теги, автор, оценка, кадры', () => {
  const { parseItchPage } = require('./src/utils/itch.js');
  const html = `<html><head><meta content="https://img.itch.zone/c/original/cover.png" property="og:image"/></head><body>
    <h1 itemprop="name" class="game_title">Seven Keys</h1>
    <div class="formatted_description user_formatted"><p>An RPG made with RPG Maker MZ.</p><h1>Summary</h1><p>Follow Mira&#x27;s adventure.</p></div>
    <div class="more_information_toggle"></div><div class="game_info_panel_widget"><table>
    <tr><td>Updated</td><td><abbr title="26 September 2026 @ 17:43 UTC">12 hours ago</abbr></td></tr>
    <tr><td>Rating</td><td><div data-tooltip="4.39 average rating from 802 total ratings"></div></td></tr>
    <tr><td>Author</td><td><a href="https://moon-dev.itch.io">moon-dev</a></td></tr>
    <tr><td>Made with</td><td><a href="https://itch.io/games/made-with-rpg-maker">RPG Maker</a></td></tr>
    <tr><td>Tags</td><td><a href="https://itch.io/games/tag-fantasy">Fantasy</a>, <a href="https://itch.io/games/tag-exploration">exploration</a></td></tr>
    </table></div>
    <div class="screenshot_list"><a href="https://img.itch.zone/s1/original/1.png"><img/></a><a href="https://img.itch.zone/s2/original/2.png"><img/></a></div>
    <a href="https://img.itch.zone/other/original/not-a-screenshot.png"></a></body></html>`;
  const p = parseItchPage(html, 'https://moon-dev.itch.io/seven-keys/');
  assert.strictEqual(p.title, 'Seven Keys');
  assert.strictEqual(p.description, "An RPG made with RPG Maker MZ.\nSummary\nFollow Mira's adventure.");
  assert.deepStrictEqual([p.developer, p.madeWith, p.tags, p.updated], ['moon-dev', 'RPG Maker', ['Fantasy', 'exploration'], '2026-09-26']);
  assert.deepStrictEqual(p.rating, { value: 4.39, count: 802 });
  assert.strictEqual(p.coverUrl, 'https://img.itch.zone/c/original/cover.png');
  assert.deepStrictEqual(p.screens, ['https://img.itch.zone/s1/original/1.png', 'https://img.itch.zone/s2/original/2.png']);
  assert.strictEqual(parseItchPage('<html>Just a moment...</html>', 'x'), null);
});

test('itch.io: каталог — адрес ленты по фильтрам, «в библиотеке», пауза после отказа', async (t) => {
  const itch = require('./src/services/itch.js');
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec('CREATE TABLE games (id TEXT PRIMARY KEY, link TEXT, ready INTEGER DEFAULT 1)');
  await db.run("INSERT INTO games (id, link) VALUES ('Starfall_Inn', 'https://store.steampowered.com/app/1,https://moon-studio.itch.io/starfall-inn')");
  const prev = { db: itch.dbService, paused: itch.pausedUntil };
  itch.setDependencies({ get: () => db });
  const { redisClient } = require('./src/utils/cache.js');
  t.mock.method(redisClient, 'get', async () => null);
  t.mock.method(redisClient, 'set', async () => 'OK');
  t.after(async () => { itch.setDependencies(prev.db); itch.pausedUntil = prev.paused; await db.close(); });

  assert.strictEqual(itch.feedUrl({ sort: 'newest', days: 7, price: 'free', web: true, tags: ['horror', 'fantasy'], page: 2 }),
    'https://itch.io/games/newest/last-7-days/free/made-with-rpg-maker/platform-web/tag-horror/tag-fantasy.xml?page=2');
  assert.strictEqual(itch.feedUrl({}), 'https://itch.io/games/made-with-rpg-maker.xml');

  let asked = '', status = 200;
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked = String(url);
    return { status, ok: status === 200, text: async () => '<rss><item><plainTitle>Starfall Inn</plainTitle><link>https://moon-studio.itch.io/starfall-inn</link><price>$0.00</price></item></rss>' };
  });
  // Неизвестные сортировка, период, цена и теги отбрасываются
  const res = await itch.latest({ sort: 'weird', days: '5', price: 'cheap', tags: 'fantasy,../../x,horror,unknown' });
  assert.strictEqual(asked, 'https://itch.io/games/made-with-rpg-maker/tag-fantasy/tag-horror.xml');
  assert.deepStrictEqual([res.page, res.more, res.items[0].game], [1, false, { id: 'Starfall_Inn' }]);

  // «Слишком часто»: минуту itch.io не спрашиваем вовсе
  status = 429;
  await assert.rejects(() => itch.latest({ sort: 'newest' }), (e) => e.limited === true);
  asked = '';
  await assert.rejects(() => itch.latest({ sort: 'top-rated' }), (e) => e.limited === true);
  assert.strictEqual(asked, '', 'во время паузы запросов нет');
});

test('itch.io: ссылка у игры даёт описание, автора и кадры в поиске метаданных', async (t) => {
  const scraper = require('./src/services/scraper.js');
  const page = `<meta content="https://img.itch.zone/c/original/cover.png" property="og:image"/><h1 class="game_title">Some Game</h1>
    <div class="formatted_description user_formatted"><p>A story about a witch.</p></div><div class="more_information_toggle"></div>
    <table><tr><td>Author</td><td><a href="https://dev.itch.io">dev</a></td></tr>
    <tr><td>Tags</td><td><a href="https://itch.io/games/tag-fantasy">Fantasy</a></td></tr></table>
    <div class="screenshot_list"><a href="https://img.itch.zone/s1/original/1.png"></a></div>`;
  const prevKey = process.env.SCRAPER_API_KEY;
  process.env.SCRAPER_API_KEY = 'test';
  t.after(() => { if (prevKey === undefined) delete process.env.SCRAPER_API_KEY; else process.env.SCRAPER_API_KEY = prevKey; });
  // Кэш страниц itch.io — в Redis; в тесте его нет, иначе второй прогон брал бы из кэша
  const { redisClient } = require('./src/utils/cache.js');
  t.mock.method(redisClient, 'get', async () => null);
  t.mock.method(redisClient, 'set', async () => 'OK');
  const asked = [];
  t.mock.method(scraper, 'fetchViaScraper', async (url) => { asked.push(url); return url.includes('dev.itch.io/some-game') ? page : null; });
  // Остальные источники по названию ничего не находят
  for (const name of ['fetchVNDBMetadata', 'fetchSteamMetadata']) t.mock.method(scraper, name, async () => null);

  const { data } = await scraper.lookupMetadata('Some Game', 'https://dev.itch.io/some-game');
  assert.ok(asked.includes('https://dev.itch.io/some-game'));
  assert.deepStrictEqual([data.description, data.developer, data.tags, data.coverUrl, data.screens],
    ['A story about a witch.', 'dev', ['Fantasy'], 'https://img.itch.zone/c/original/cover.png', ['https://img.itch.zone/s1/original/1.png']]);
  assert.ok(data.link.includes('https://dev.itch.io/some-game'));
});

test('ScraperAPI: дневной запас — в кредитах по цене из ответа; дороже остатка ScraperAPI не выполнит', async (t) => {
  const scraper = require('./src/services/scraper.js');
  const { redisClient } = require('./src/utils/cache.js');
  const prev = { key: process.env.SCRAPER_API_KEY, limit: process.env.SCRAPER_DAILY_LIMIT };
  process.env.SCRAPER_API_KEY = 'test';
  process.env.SCRAPER_DAILY_LIMIT = '12';
  t.after(() => {
    for (const [name, value] of [['SCRAPER_API_KEY', prev.key], ['SCRAPER_DAILY_LIMIT', prev.limit]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  let used = 0;
  t.mock.method(redisClient, 'get', async () => String(used));
  t.mock.method(redisClient, 'incrBy', async (key, n) => (used += n));
  t.mock.method(redisClient, 'expire', async () => true);
  t.mock.method(console, 'warn', () => {});
  // Как ScraperAPI: страница itch.io — 10 кредитов, простая страница — 1; цена — в заголовке,
  // дороже max_cost — отказ без списания
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    asked.push(url);
    const cost = decodeURIComponent(url).includes('itch.io') ? 10 : 1;
    const headers = new Headers({ 'sa-credit-cost': String(cost) });
    if (cost > Number(new URL(url).searchParams.get('max_cost'))) return { ok: false, status: 403, headers, text: async () => 'This request exceeds your max_cost.' };
    return { ok: true, status: 200, headers, text: async () => 'page' };
  });

  assert.strictEqual(await scraper.fetchViaScraper('https://dev.itch.io/a'), 'page');
  assert.ok(asked[0].includes('max_cost=12'), asked[0]);
  assert.strictEqual(used, 10, 'списано по цене из ответа, а не «кредит за запрос»');
  // Осталось 2: вторая страница itch.io дороже — ScraperAPI отказал и не списал
  assert.strictEqual(await scraper.fetchViaScraper('https://dev.itch.io/b'), null);
  assert.strictEqual(used, 10);
  // Страница за кредит проходит, пока запас есть
  assert.strictEqual(await scraper.fetchViaScraper('https://example.com/page'), 'page');
  assert.strictEqual(await scraper.fetchViaScraper('https://example.com/page'), 'page');
  assert.strictEqual(used, 12);
  // Запас кончился — запросов нет вовсе
  const sent = asked.length;
  assert.strictEqual(await scraper.fetchViaScraper('https://example.com/page'), null);
  assert.strictEqual(asked.length, sent);

  // Окно «Новинки»: страница itch.io не открылась, а запаса меньше её цены — окно скажет, что до завтра
  const itch = require('./src/services/itch.js');
  assert.strictEqual(await itch.budgetSpent(), true);
  used = 0;
  assert.strictEqual(await itch.budgetSpent(), false);
});

// ============================================================================
// «Хочу поиграть»
// ============================================================================

const WISHLIST_TABLE = `CREATE TABLE wishlist (
  key TEXT PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL, url TEXT NOT NULL,
  info TEXT NOT NULL DEFAULT '{}', news TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL DEFAULT 1,
  notified TEXT NOT NULL DEFAULT '', checkedAt INTEGER NOT NULL DEFAULT 0, addedAt INTEGER NOT NULL DEFAULT 0)`;

// Список на базе в памяти; чьи игры в библиотеке — подставные источники
async function wishlistTestDb(t, { library = new Map() } = {}) {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(WISHLIST_TABLE);
  const wishlist = require('./src/services/wishlist.js');
  const prev = { db: wishlist.dbService, sources: wishlist.sources };
  wishlist.setDependencies({ get: () => db }, { itch: { libraryGames: async () => library } });
  t.after(async () => { wishlist.setDependencies(prev.db, prev.sources); await db.close(); });
  return { db, wishlist };
}

test('«Хочу поиграть»: что сохраняем — только известные поля, картинки своего сайта, адрес собираем сами', () => {
  const { normalize } = require('./src/services/wishlist.js');
  const itch = normalize({ source: 'itch', url: 'https://Moon-Studio.itch.io/Starfall-Inn', title: 'Starfall Inn', evil: '<script>',
    cover: 'https://img.itch.zone/a.png', screens: ['javascript:alert(1)', 'https://evil.example/x.png', 'https://img.itch.zone/2.png'],
    platforms: ['windows', 'dos'] });
  assert.deepStrictEqual([itch.key, itch.url, itch.info.cover, itch.info.screens, itch.info.platforms, itch.info.evil],
    ['itch:https://moon-studio.itch.io/starfall-inn', 'https://moon-studio.itch.io/starfall-inn', 'https://img.itch.zone/a.png',
      ['https://img.itch.zone/2.png'], ['windows'], undefined]);
  assert.strictEqual(normalize({ source: 'itch', url: 'https://moon-studio.itch.io/x', cover: 'http://img.itch.zone/a.png' }).info.cover, '',
    'картинка не по https — не берём');
  for (const bad of [{ source: 'steam', id: 1 }, { source: 'itch', url: 'https://itch.io/games' }, { source: 'itch', url: 'javascript:alert(1)' }, {}]) {
    assert.strictEqual(normalize(bad), null, JSON.stringify(bad));
  }
});

test('«Хочу поиграть»: добавить, убрать, «в библиотеке»', async (t) => {
  const { db, wishlist } = await wishlistTestDb(t, { library: new Map([['https://moon-studio.itch.io/starfall-inn', 'Starfall_Inn']]) });
  const { setIo } = require('./src/utils/cache.js');
  const events = [];
  setIo({ emit: (name) => events.push(name) });
  t.after(() => setIo(null));

  await wishlist.add({ source: 'itch', url: 'https://moon-studio.itch.io/starfall-inn', title: 'Starfall Inn' });
  await wishlist.add({ source: 'itch', url: 'https://dev.itch.io/some-game', title: 'Some' });
  await assert.rejects(() => wishlist.add({ source: 'itch', url: 'https://itch.io/' }), (e) => e.bad === true);
  const { items } = await wishlist.list();
  assert.deepStrictEqual(items.map(x => x.key).sort(), ['itch:https://dev.itch.io/some-game', 'itch:https://moon-studio.itch.io/starfall-inn']);
  const by = Object.fromEntries(items.map(x => [x.key, x]));
  assert.deepStrictEqual(by['itch:https://moon-studio.itch.io/starfall-inn'].game, { id: 'Starfall_Inn' }, 'уже в библиотеке');
  assert.strictEqual(by['itch:https://dev.itch.io/some-game'].game, undefined);

  // Добавили ещё раз — снимок обновляется, запись одна
  await wishlist.add({ source: 'itch', url: 'https://dev.itch.io/some-game', title: 'Some (новое название)' });
  const again = await db.all("SELECT * FROM wishlist WHERE key = 'itch:https://dev.itch.io/some-game'");
  assert.deepStrictEqual([again.length, JSON.parse(again[0].info).title], [1, 'Some (новое название)']);

  assert.strictEqual(await wishlist.remove('itch:https://dev.itch.io/some-game'), true);
  assert.strictEqual(await wishlist.remove('itch:https://dev.itch.io/some-game'), false);
  assert.strictEqual((await wishlist.list()).items.length, 1);
  assert.ok(events.includes('wishlist-changed'), 'другие устройства узнают об изменении');
});

// ============================================================================
// Поиск по названию: полные названия, слитные слова, readme, сверка (SkyKnight, SevenKeys3)
// ============================================================================

test('названия: слитные слова, хвост релиза, порядок поиска и сверка по полному', () => {
  const { splitWords, stripRelease, searchNames, bestSimilarity, titleSimilarity, presentTitle } = require('./src/utils/title.js');
  assert.strictEqual(splitWords('SkyKnight TheCrystalLabyrinth'), 'Sky Knight The Crystal Labyrinth');
  assert.strictEqual(splitWords('TinyQuest3'), 'Tiny Quest 3');
  assert.strictEqual(splitWords('RPGMaker'), 'RPG Maker');
  assert.strictEqual(splitWords("Mira's Potion Shop"), "Mira's Potion Shop");
  assert.strictEqual(splitWords('星の迷宮 第3章'), '星の迷宮 第3章');
  assert.strictEqual(stripRelease('TinyQuest3 - English Release by Marlow'), 'TinyQuest3');
  assert.strictEqual(stripRelease('Some Game TL by Marlow'), 'Some Game');
  assert.strictEqual(stripRelease('Stand by Me'), 'Stand by Me');

  // Игра зовёт себя коротко, архив — полно: сверка только по полному
  const sk = searchNames(['SkyKnight ov1.0.0', 'SkyKnight TheCrystalLabyrinth', '']);
  assert.deepStrictEqual(sk.verify, ['SkyKnight TheCrystalLabyrinth']);
  assert.deepStrictEqual(sk.search, ['Sky Knight The Crystal Labyrinth', 'SkyKnight TheCrystalLabyrinth', 'Sky Knight', 'SkyKnight']);
  assert.ok(bestSimilarity('Sky Knight Quest', sk.verify) < 0.75, 'чужая игра с тем же началом не подходит');
  assert.strictEqual(bestSimilarity('Sky Knight: The Crystal Labyrinth', sk.verify), 1);

  // readme полнее всех — и японский подзаголовок сравнивается
  const tq = searchNames(['TinyQuest3', 'TinyQuest3 English Release by Marlow', 'Tiny Quest3 ～星の迷宮～']);
  assert.deepStrictEqual(tq.verify, ['Tiny Quest3 ～星の迷宮～']);
  assert.ok(tq.search.includes('Tiny Quest 3'));
  assert.ok(bestSimilarity('Tiny Quest 3', tq.verify) >= 0.9, 'название в магазине без подзаголовка подходит');
  assert.strictEqual(titleSimilarity('Tiny Quest 3 ～星の迷宮～', 'Tiny Quest3 ～星の迷宮～'), 1);
  assert.strictEqual(titleSimilarity('Pokémon Quest', 'Pokemon Quest'), 1);
  assert.ok(titleSimilarity('星の迷宮', '雪音の旅物語') < 0.3);

  // Карточка: полное имя из архива вместо слитного сокращения
  assert.strictEqual(presentTitle('SkyKnight ov1.0.0', { folder: 'SkyKnight_TheCrystalLabyrinth_1.0_EN072p' }).title, 'Sky Knight The Crystal Labyrinth');
  assert.strictEqual(presentTitle('TinyQuest3', { folder: 'TinyQuest3_-_English_Release_by_Marlow' }).title, 'Tiny Quest 3');
  assert.strictEqual(presentTitle('WhichSwitch', { folder: 'WhichSwitch_v1.0' }).title, 'WhichSwitch', 'два слова — не повод менять название');
});

test('название из readme: 『…』 в первой строке, UTF-8 и Shift_JIS', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const scraper = require('./src/services/scraper.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'); fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'Credit.txt'), '『не то』');
  fs.writeFileSync(path.join(a, 'Readme.txt'), '﻿『Seven Keys3 ～戦国ジゴン～』説明書\r\n\r\nこの度は…');
  assert.strictEqual(await scraper.readmeTitle(a), 'Seven Keys3 ～戦国ジゴン～');
  // Shift_JIS: «『テスト』» — байты 81 77 83 65 83 58 83 67 81 78
  const b = path.join(root, 'b'); fs.mkdirSync(path.join(b, 'www'), { recursive: true });
  fs.writeFileSync(path.join(b, 'www', '説明書.txt'), Buffer.from([0x81, 0x77, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x81, 0x78, 0x0d, 0x0a]));
  assert.strictEqual(await scraper.readmeTitle(b), 'テスト');
  assert.strictEqual(await scraper.readmeTitle(path.join(root, 'нет такой')), '');
});

test('поиск по названию: игра зовёт себя коротко — ищем по полному имени архива, чужую «Sky Knight Quest» не берём', async (t) => {
  const scraper = require('./src/services/scraper.js');
  const asked = [];
  let steamKnowsIt = true;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = decodeURIComponent(String(input));
    asked.push(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('api.vndb.org')) return json({ results: [] });
    if (url.includes('storesearch')) {
      return json(steamKnowsIt && url.includes('Crystal')
        ? { items: [{ id: 77, name: 'Sky Knight: The Crystal Labyrinth' }] }
        : { items: [{ id: 66, name: 'Sky Knight Quest' }] });
    }
    const id = (url.match(/appids=(\d+)/) || [])[1];
    if (id) return json({ [id]: { success: true, data: { name: 'x', short_description: `Game ${id}`, genres: [{ description: 'RPG' }], developers: ['Moon Studio'] } } });
    return { ok: false, status: 404 };
  });

  const { data } = await scraper.lookupMetadata('SkyKnight ov1.0.0', '', { altTitle: 'SkyKnight TheCrystalLabyrinth' });
  assert.strictEqual(data.link, 'https://store.steampowered.com/app/77');
  assert.deepStrictEqual([data.description, data.tags], ['Game 77', ['RPG']]);
  assert.ok(asked.some((u) => u.includes('storesearch/?term=Sky Knight The Crystal Labyrinth')), 'первым — полное название, слова раздельно');

  // В Steam только чужая «Sky Knight Quest»: с полным названием она не сходится — данных нет
  steamKnowsIt = false;
  const foreign = await scraper.lookupMetadata('SkyKnight ov1.0.0', '', { altTitle: 'SkyKnight TheCrystalLabyrinth' });
  assert.strictEqual(foreign.data, null);
});

test('картинки игры: имена по содержимому, прежние — на удаление после записи базы, своя обложка не трогается', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const scraper = require('./src/services/scraper.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  const prevDir = scraper.GAMES_DIR;
  scraper.GAMES_DIR = root;
  t.after(() => { scraper.GAMES_DIR = prevDir; fs.rmSync(root, { recursive: true, force: true }); });
  // Без ffmpeg: картинка — это просто её байты, размер — как у кадра
  t.mock.method(scraper, 'toJpeg', async (raw) => raw);
  t.mock.method(scraper, 'jpegSize', () => ({ width: 1280, height: 720 }));
  t.mock.method(scraper, 'imageFingerprint', async () => null);
  const image = (name) => Buffer.alloc(4096, name);
  t.mock.method(globalThis, 'fetch', async (url) => ({ ok: true, arrayBuffer: async () => image(String(url).slice(-1)) }));
  const dir = path.join(root, '_media', 'Game');
  fs.mkdirSync(dir, { recursive: true });
  // С прошлых версий: обложка и кадры под постоянными именами
  for (const f of ['cover.jpg', '1.jpg', '2.jpg', '3.jpg']) fs.writeFileSync(path.join(dir, f), 'old');

  const first = await scraper.saveGameMedia('Game', { coverUrl: 'https://x/a', screens: ['https://x/b', 'https://x/c'] },
    '_media/Game/cover.jpg', ['_media/Game/1.jpg', '_media/Game/2.jpg']);
  assert.match(first.cover, /^_media\/Game\/cover-[0-9a-f]{10}\.jpg$/);
  assert.deepStrictEqual(first.screens.map((p) => path.basename(p).replace(/-[0-9a-f]{10}/, '')), ['1.jpg', '2.jpg']);
  // На cover.jpg, 1.jpg и 2.jpg ещё смотрит база — их удалят потом; 3.jpg не нужен никому — удалён сразу
  assert.deepStrictEqual(first.stale.map((p) => path.basename(p)).sort(), ['1.jpg', '2.jpg', 'cover.jpg']);
  assert.ok(!fs.existsSync(path.join(dir, '3.jpg')));

  // Те же картинки ещё раз — те же адреса, удалять нечего
  for (const f of first.stale) fs.unlinkSync(f);
  const same = await scraper.saveGameMedia('Game', { coverUrl: 'https://x/a', screens: ['https://x/b', 'https://x/c'] }, first.cover, first.screens);
  assert.deepStrictEqual([same.cover, same.screens, same.stale], [first.cover, first.screens, []]);

  // Своя обложка: найденную обложку не пишем, картинка со страницы игры уходит в кадры
  const custom = await scraper.saveGameMedia('Game', { coverUrl: 'https://x/d', screens: [] }, '_media/Game/cover_custom_1.jpg', first.screens);
  assert.strictEqual(custom.cover, null);
  assert.strictEqual(custom.screens.length, 1);
  assert.ok(fs.existsSync(path.join(root, first.cover)), 'прежняя найденная обложка на месте');
  // Ничего не нашлось — всё прежнее остаётся
  for (const f of custom.stale) fs.unlinkSync(f);
  const none = await scraper.saveGameMedia('Game', { coverUrl: '', screens: [] }, first.cover, custom.screens);
  assert.deepStrictEqual([none.cover, none.screens, none.stale], [null, [], []]);
  assert.ok([first.cover, ...custom.screens].every((p) => fs.existsSync(path.join(root, p))));
});

// Игра в базе в памяти: все поля, которые пишет applyLookup
async function lookupTestDb(t, row) {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, cover TEXT DEFAULT '', tags TEXT DEFAULT '[]', description TEXT DEFAULT '',
    developer TEXT DEFAULT '', releaseDate TEXT DEFAULT '', link TEXT DEFAULT '', screens TEXT DEFAULT '', scraped INTEGER DEFAULT 0, ready INTEGER DEFAULT 1,
    meta_status TEXT DEFAULT 'new', meta_attempts INTEGER DEFAULT 0, meta_retry_at INTEGER, meta_checked_at INTEGER DEFAULT 0, meta_error TEXT DEFAULT '', meta_locked TEXT DEFAULT '[]', links_removed TEXT DEFAULT '[]', meta_rebuild INTEGER DEFAULT 0, meta_log TEXT DEFAULT '')`);
  const keys = Object.keys(row);
  await db.run(`INSERT INTO games (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
  const scraper = require('./src/services/scraper.js');
  const prev = { db: scraper.dbService, dir: scraper.GAMES_DIR };
  scraper.dbService = { get: () => db };
  const { redisClient } = require('./src/utils/cache.js');
  t.mock.method(redisClient, 'del', async () => 1);
  t.mock.method(scraper, 'saveGameMedia', async () => ({ cover: null, screens: [], stale: [] }));
  t.after(async () => { scraper.dbService = prev.db; scraper.GAMES_DIR = prev.dir; await db.close(); });
  return { db, scraper };
}

test('повторный поиск: чужая ссылка Steam уходит, если Steam ответил; вписанные руками ссылки не трогаем', async (t) => {
  const steam = 'https://store.steampowered.com/app/3451330';
  const itch = 'https://moon-studio.itch.io/sky-knight';
  const { db, scraper } = await lookupTestDb(t, { id: 'SkyKnight', title: 'SkyKnight ov1.0.0', link: steam, developer: 'Someone Else' });
  const found = { tags: ['rpg'], description: 'Edith…', developer: 'Moon Studio', releaseDate: '2026-09-09', link: itch };
  await scraper.applyLookup('SkyKnight', { data: found, failed: [] });
  let row = await db.get('SELECT * FROM games');
  assert.deepStrictEqual([row.link, row.developer], [itch, 'Moon Studio'], 'Steam ответил и игру не подтвердил — ссылки нет');

  // Steam не ответил — прежнюю ссылку держим: знание не теряем из-за сбоя
  await db.run('UPDATE games SET link = ?', [`${itch},${steam}`]);
  await scraper.applyLookup('SkyKnight', { data: found, failed: ['store.steampowered.com'] });
  row = await db.get('SELECT * FROM games');
  assert.strictEqual(row.link, `${itch},${steam}`);

  // Ссылку вписали руками — остаётся, что бы ни ответил Steam
  await db.run(`UPDATE games SET link = ?, meta_locked = '["link"]'`, [steam]);
  await scraper.applyLookup('SkyKnight', { data: found, failed: [] });
  assert.strictEqual((await db.get('SELECT link FROM games')).link, `${steam},${itch}`);
});

test('что подаём в поиск: ссылки Steam и VNDB, найденные по названию, — не как точные; вписанные руками — все', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { db, scraper } = await lookupTestDb(t, {
    id: 'SkyKnight_TheCrystalLabyrinth_1.0_EN072p', title: 'SkyKnight ov1.0.0',
    link: 'https://moon-studio.itch.io/sky-knight,https://store.steampowered.com/app/3451330,https://vndb.org/v123',
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'SkyKnight_TheCrystalLabyrinth_1.0_EN072p');
  fs.mkdirSync(path.join(game, 'data'), { recursive: true });
  fs.writeFileSync(path.join(game, 'data', 'System.json'), JSON.stringify({ gameTitle: 'SkyKnight ov1.0.0' }));
  scraper.GAMES_DIR = root;

  let inputs = await scraper.lookupInputs('SkyKnight_TheCrystalLabyrinth_1.0_EN072p');
  assert.deepStrictEqual([inputs.title, inputs.altTitle, inputs.query, inputs.readmeTitle],
    ['SkyKnight ov1.0.0', 'SkyKnight TheCrystalLabyrinth', 'https://moon-studio.itch.io/sky-knight', '']);
  await db.run(`UPDATE games SET meta_locked = '["link"]'`);
  inputs = await scraper.lookupInputs('SkyKnight_TheCrystalLabyrinth_1.0_EN072p');
  assert.ok(inputs.query.includes('app/3451330') && inputs.query.includes('vndb.org/v123'));
});

test('«Изменить → Сохранить» без правки ссылок ищет как повторный поиск: Steam и VNDB — заново', () => {
  const scraper = require('./src/services/scraper.js');
  const links = 'https://moon-studio.itch.io/sky-knight, https://store.steampowered.com/app/3451330,https://vndb.org/v1,https://example.com/sky-knight';
  assert.deepStrictEqual(scraper.searchableLinks(links, false),
    ['https://moon-studio.itch.io/sky-knight', 'https://example.com/sky-knight']);
  assert.strictEqual(scraper.searchableLinks(links, true).length, 4, 'ссылки вписаны или поправлены руками — все как есть');
  assert.deepStrictEqual(scraper.searchableLinks('', false), []);
});

test('ScraperAPI: POST уходит с телом и заголовками (форма запроса)', async (t) => {
  const scraper = require('./src/services/scraper.js');
  const { redisClient } = require('./src/utils/cache.js');
  process.env.SCRAPER_API_KEY = 'test';
  t.after(() => { delete process.env.SCRAPER_API_KEY; });
  t.mock.method(redisClient, 'get', async () => '0');
  t.mock.method(redisClient, 'incrBy', async (key, n) => n);
  t.mock.method(redisClient, 'expire', async () => true);
  let call = null;
  t.mock.method(globalThis, 'fetch', async (url, opts) => { call = { url: String(url), ...opts }; return { ok: true, status: 200, text: async () => 'ok' }; });
  await scraper.fetchViaScraper('https://example.com/form.php', { country: 'jp', method: 'POST', body: 'sql=SELECT+1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.deepStrictEqual([call.method, call.body, call.headers['Content-Type']], ['POST', 'sql=SELECT+1', 'application/x-www-form-urlencoded']);
  assert.ok(call.url.includes('country_code=jp') && call.url.includes(encodeURIComponent('https://example.com/form.php')));
});

test('Steam: из одноимённых игр — та, чей автор известен от других источников; не совпал ни один — первая', async (t) => {
  const scraper = require('./src/services/scraper.js');
  const asked = [];
  const devs = { 1713550: ['Someone Else'], 3959930: ['Moon Studio', 'Marlow Localize'], 5001490: ['月の工房'] };
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    asked.push(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('storesearch')) {
      return json(url.includes('SKYLANTERN')
        ? { total: 1, items: [{ id: 5001490, name: 'SKYLANTERN: The Last Light' }] }
        : { total: 3, items: [{ id: 1713550, name: 'Star Lantern' }, { id: 3959930, name: 'Star Lantern' }, { id: 3936730, name: 'STARDUST: Lantern of Wishes' }] });
    }
    const id = (url.match(/appids=(\d+)/) || [])[1];
    if (id) return json({ [id]: { success: true, data: { name: 'x', developers: devs[id], publishers: [] } } });
    return { ok: false, status: 404 };
  });
  const found = await scraper.fetchSteamMetadata('Star Lantern', ['Star Lantern'], ['Moon Studio']);
  assert.deepStrictEqual([found.link, found.developer], ['https://store.steampowered.com/app/3959930', 'Moon Studio, Marlow Localize']);
  // Автор записан иначе (или неизвестен) — первая по выдаче
  const first = await scraper.fetchSteamMetadata('Star Lantern', ['Star Lantern'], ['Other Author']);
  assert.strictEqual(first.link, 'https://store.steampowered.com/app/1713550');
  // Похожая одна — одна же страница игры, автора не сверяем: Steam пишет его по-японски, itch.io — латиницей
  asked.length = 0;
  const one = await scraper.fetchSteamMetadata('SKYLANTERN', ['SKYLANTERN'], ['Moon Workshop']);
  assert.strictEqual(one.link, 'https://store.steampowered.com/app/5001490');
  assert.strictEqual(asked.filter((u) => u.includes('appdetails')).length, 1);
});

// ============================================================================
// Полная проверка библиотеки (кнопка «Проверить всё» в ревизии)
// ============================================================================

test('полная проверка: ход с игрой «сейчас», итог в базе; вторая поверх идущей не начинается; после перезапуска — «прервалась»', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT DEFAULT '', link TEXT DEFAULT '', ready INTEGER DEFAULT 1, meta_locked TEXT DEFAULT '[]',
    description TEXT DEFAULT '', tags TEXT DEFAULT '[]', screens TEXT DEFAULT '[]', cover TEXT DEFAULT '', developer TEXT DEFAULT '',
    releaseDate TEXT DEFAULT '', meta_status TEXT DEFAULT 'ok', meta_checked_at INTEGER DEFAULT 0, meta_retry_at INTEGER, meta_attempts INTEGER DEFAULT 0)`);
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.run(`INSERT INTO games (id, title, link, tags) VALUES ('Alpha', 'Alpha Game', 'https://store.steampowered.com/app/1', '["rpg","fantasy"]')`);
  await db.run("INSERT INTO games (id, title) VALUES ('Beta', 'Beta Game')");
  const VNDB = 'https://vndb.org/v17';

  const { FullCheck } = require('./src/services/fullcheck.js');
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    db: { get: () => db },
    // Очередь поиска: у Alpha нашлась страница VNDB и описание, теги те же, в другом порядке; Beta не нашлась
    scraper: {
      currentId: null,
      async requestScrape(ids) {
        order.push('sources');
        this.currentId = 'Alpha';
        await gate;
        const at = Date.now();
        await db.run("UPDATE games SET link = link || ?, description = 'New', tags = '[\"fantasy\",\"rpg\"]', meta_checked_at = ? WHERE id = 'Alpha'", [`,${VNDB}`, at]);
        await db.run("UPDATE games SET meta_status = 'not_found', meta_checked_at = ? WHERE id = 'Beta'", [at]);
        return ids.length;
      },
    },
  };
  const events = [];
  const check = new FullCheck();
  check.pollMs = 5;
  check.emitGapMs = 0;
  check.setDependencies({ ...deps, emit: (s) => events.push(JSON.parse(JSON.stringify(s))) });
  assert.deepStrictEqual(await check.status(), { running: false, steps: [] }, 'проверок ещё не было');

  const started = await check.start();
  assert.deepStrictEqual([started.running, started.steps.map((s) => s.key)], [true, ['sources']]);
  assert.strictEqual(await check.start(), started, 'вторая поверх идущей — та же');

  // Поиск ещё идёт. Перезапусти сервер сейчас — новый процесс по базе увидит: прервалась, на поиске данных
  for (let i = 0; i < 200 && !order.includes('sources'); i++) await new Promise((r) => setTimeout(r, 5));
  const restarted = new FullCheck();
  restarted.setDependencies({ ...deps, emit: () => {} });
  const cut = await restarted.status();
  assert.deepStrictEqual([cut.running, cut.interrupted, cut.steps.map((s) => s.status)], [false, true, ['running']]);

  release();
  await check.running;
  assert.deepStrictEqual(order, ['sources']);
  const result = await check.status();
  assert.strictEqual(result.running, false);
  assert.ok(result.finishedAt >= result.startedAt);
  assert.deepStrictEqual(result.steps.map((s) => s.status), ['done']);
  assert.ok(result.steps.every((s) => s.current === ''), 'игра «сейчас» после шага не остаётся');
  const [sources] = result.steps;
  assert.deepStrictEqual(sources.result.changed, [
    { id: 'Alpha', title: 'Alpha Game', linksAdded: [VNDB], fields: ['description'] },
    { id: 'Beta', title: 'Beta Game', fields: ['status'], status: 'not_found' },
  ], 'теги в другом порядке — не перемена');
  assert.deepStrictEqual([sources.result.checked, sources.result.total, sources.result.byStatus], [2, 2, { ok: 1, not_found: 1 }]);
  // Итог — в базе: окно закрыли, сервер перезапустили — последняя проверка видна
  const saved = await restarted.status();
  assert.deepStrictEqual([saved.running, saved.interrupted, saved.steps.map((s) => s.status)], [false, undefined, ['done']]);
  assert.strictEqual(events.at(-1).running, false);
});

test('полная проверка: «Отменить» — шаг останавливается, сделанное остаётся', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT DEFAULT '', link TEXT DEFAULT '', ready INTEGER DEFAULT 1, meta_locked TEXT DEFAULT '[]',
    description TEXT DEFAULT '', tags TEXT DEFAULT '[]', screens TEXT DEFAULT '[]', cover TEXT DEFAULT '', developer TEXT DEFAULT '',
    releaseDate TEXT DEFAULT '', meta_status TEXT DEFAULT 'ok', meta_checked_at INTEGER DEFAULT 0, meta_retry_at INTEGER, meta_attempts INTEGER DEFAULT 0)`);
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.run("INSERT INTO games (id, title) VALUES ('Alpha', 'Alpha Game')");
  const { FullCheck } = require('./src/services/fullcheck.js');
  const order = [];
  const check = new FullCheck();
  const events = [];
  check.emitGapMs = 0;
  check.pollMs = 5;
  check.setDependencies({
    db: { get: () => db },
    scraper: { currentId: null, requestScrape: async () => { order.push('sources'); return 1; } },
    emit: (state) => events.push(JSON.parse(JSON.stringify(state))),
  });
  assert.strictEqual((await check.cancel()).running, false, 'нечего отменять — просто итог');

  await check.start();
  for (let i = 0; i < 200 && !order.includes('sources'); i++) await new Promise((r) => setTimeout(r, 5));
  const cancelling = await check.cancel();
  assert.deepStrictEqual([cancelling.running, cancelling.cancelling], [true, true], 'ответ — сразу, проверка ещё идёт');
  assert.strictEqual(await check.cancel(), cancelling, 'второе нажатие — то же');
  await check.running;

  const result = await check.status();
  assert.deepStrictEqual(result.steps.map((s) => s.status), ['cancelled']);
  assert.deepStrictEqual([result.running, result.cancelling, result.cancelled], [false, false, true]);
  assert.ok(events.some((e) => e.running && e.cancelling), 'по сокету — «останавливаю»');
});

test('полная проверка: отменили на поиске данных — игры, до которых очередь не дошла, возвращаются к своему сроку', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT DEFAULT '', link TEXT DEFAULT '', ready INTEGER DEFAULT 1, meta_locked TEXT DEFAULT '[]',
    description TEXT DEFAULT '', tags TEXT DEFAULT '[]', screens TEXT DEFAULT '[]', cover TEXT DEFAULT '', developer TEXT DEFAULT '',
    releaseDate TEXT DEFAULT '', meta_status TEXT DEFAULT 'ok', meta_checked_at INTEGER, meta_retry_at INTEGER, meta_attempts INTEGER DEFAULT 0)`);
  // Beta ждала своей попытки (не нашлась дважды), Alpha и Gamma — в порядке, их не ищут
  await db.run("INSERT INTO games (id, title) VALUES ('Alpha', 'Alpha Game'), ('Gamma', 'Gamma Game')");
  await db.run("INSERT INTO games (id, title, meta_status, meta_retry_at, meta_attempts) VALUES ('Beta', 'Beta Game', 'not_found', 12345, 2)");
  const { FullCheck } = require('./src/services/fullcheck.js');
  const check = new FullCheck();
  check.pollMs = 5;
  check.setDependencies({
    db: { get: () => db },
    // Как настоящая очередь: срок «сейчас» всем, Alpha уже нашлась, до остальных не дошла
    scraper: {
      currentId: 'Beta',
      async requestScrape(ids) {
        const now = Date.now();
        await db.run(`UPDATE games SET meta_retry_at = ?, meta_attempts = 0 WHERE id IN (${ids.map(() => '?').join(',')})`, [now, ...ids]);
        await db.run("UPDATE games SET meta_checked_at = ?, meta_retry_at = NULL WHERE id = 'Alpha'", [now]);
        return ids.length;
      },
    },
  });
  const step = { done: 0, total: 0, current: '' };
  const stop = new AbortController();
  const running = check.check_sources(step, stop.signal);
  for (let i = 0; i < 200 && step.done < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual([step.done, step.total, step.current], [1, 3, 'Beta Game']);
  stop.abort();
  const result = await running;
  assert.deepStrictEqual([result.stopped, result.checked, result.total], [true, 1, 3]);
  const rows = Object.fromEntries((await db.all('SELECT id, meta_retry_at, meta_attempts FROM games')).map((r) => [r.id, [r.meta_retry_at, r.meta_attempts]]));
  assert.deepStrictEqual(rows, { Alpha: [null, 0], Beta: [12345, 2], Gamma: [null, 0] }, 'Beta — к своему сроку, Gamma — снова без поиска');
});

test('полная проверка: ход по сокету — не чаще раза в emitGapMs, последний не теряется, смена шага — сразу; сколько осталось', async (t) => {
  const { FullCheck } = require('./src/services/fullcheck.js');
  const check = new FullCheck();
  const sent = [];
  check.setDependencies({ emit: (s) => sent.push(s.n) });
  check.emitGapMs = 40;
  check.state = { n: 0 };
  for (let n = 1; n <= 5; n++) { check.state.n = n; check.emit(); }
  assert.deepStrictEqual(sent, [1]);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(sent, [1, 5]);
  check.state.n = 6;
  check.emit(true);
  assert.deepStrictEqual(sent, [1, 5, 6]);

  // Сколько осталось — по скорости от первого отчёта шага: 10 игр «проверены» сразу
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const step = {};
  const report = check.progress(step);
  report({ done: 10, total: 30, current: 'A' });
  assert.strictEqual(step.eta, 0, 'пока позади меньше двух — не гадаем');
  t.mock.timers.tick(20000);
  report({ done: 12, total: 30, current: 'B' });
  assert.deepStrictEqual(step, { done: 12, total: 30, current: 'B', eta: 180000 }, 'две игры за 20 с — 18 оставшихся за 3 мин');
  t.mock.timers.reset();
});

// ============================================================================
// Ревизия библиотеки
// ============================================================================

test('ревизия: одна игра в двух папках — по названию или странице магазина, по цепочке; японские названия тоже', () => {
  const { duplicateGroups, pagesOf } = require('./src/utils/audit.js');
  const steam = (id) => `https://store.steampowered.com/app/${id}`;
  const rows = [
    { id: 'Starfall-Inn-1.08', title: 'Starfall Inn', link: '', size: 1 },
    { id: 'Starfall Inn v1.1', title: 'Starfall Inn v1.1', link: '', size: 2 },
    // Английская папка и японская — названия разные, страница одна
    { id: 'Lantern.Keeper.KG', title: 'Lantern Keeper', link: steam(248754), size: 3 },
    { id: 'ランタン守り', title: 'ランタン守り', link: `${steam(248754)}/Lantern_Keeper/`, size: 4 },
    // A и B — одна страница itch.io, B и C — один номер VNDB: все трое вместе
    { id: 'A', title: 'Some Game', link: 'https://moon-studio.itch.io/some-game' },
    { id: 'B', title: 'Other Name', link: 'https://Moon-Studio.itch.io/Some-Game/devlog/2,https://vndb.org/v123' },
    { id: 'C', title: 'Third', link: 'https://vndb.org/v123' },
    { id: '星降る宿', title: '星降る宿', link: '' },
    { id: '星降る宿 v1.1', title: '星降る宿', link: '' },
    // Короткое название — не повод; одна страница дважды в ссылках одной игры — тоже
    { id: 'TOD', title: 'TOD', link: '' },
    { id: 'TOD2', title: 'TOD', link: '' },
    { id: 'Solo', title: 'Solo Game', link: `${steam(2222222)},${steam(2222222)}` },
  ];
  const groups = duplicateGroups(rows).map((g) => [g.games.map((x) => x.id).sort().join('+'), g.why.sort().join(',')]).sort();
  assert.deepStrictEqual(groups, [
    ['A+B+C', 'page'],
    ['Lantern.Keeper.KG+ランタン守り', 'page'],
    ['Starfall Inn v1.1+Starfall-Inn-1.08', 'name'],
    ['星降る宿+星降る宿 v1.1', 'name'],
  ]);
  assert.deepStrictEqual(pagesOf({ link: 'https://moon-studio.itch.io/x, https://store.steampowered.com/app/7/Name/,https://vndb.org/V9,https://example.com/' }),
    ['itch:https://moon-studio.itch.io/x', 'steam:7', 'vndb:v9']);
});

test('ревизия: «Можно дополнить» — найденные, с пробелами, искавшиеся до улучшения поиска; сводка покрытия', () => {
  const { improvable, coverage, gapsOf, LOOKUP_IMPROVED_AT } = require('./src/utils/audit.js');
  const before = LOOKUP_IMPROVED_AT - 1000;
  const after = LOOKUP_IMPROVED_AT + 1000;
  const full = { description: 'd', developer: 'x', releaseDate: '2026', screens: '["a"]', link: 'https://moon-studio.itch.io/full,https://store.steampowered.com/app/1' };
  const rows = [
    { id: 'Full', meta_status: 'ok', meta_checked_at: before, ...full },
    { id: 'NoPage', meta_status: 'ok', meta_checked_at: before, ...full, link: 'https://example.com/no-store', size: 5 },
    { id: 'Many', meta_status: 'ok', meta_checked_at: 0, title: 'Many', link: '', description: '', developer: '', releaseDate: '', screens: '[]' },
    { id: 'Fresh', meta_status: 'ok', meta_checked_at: after, link: '' },
    { id: 'Partial', meta_status: 'partial', meta_checked_at: before, link: '' },
    { id: 'Novel', meta_status: 'ok', meta_checked_at: before, ...full, link: 'https://vndb.org/v5' },
  ];
  assert.deepStrictEqual(improvable(rows).map((g) => [g.id, g.gaps]), [
    ['Many', ['link', 'description', 'devdate', 'screens']],
    ['NoPage', ['link']],
  ], 'больше пробелов — выше; искавшиеся после улучшения и неполные — не здесь');
  assert.deepStrictEqual(gapsOf(rows[5]), [], 'страница VNDB — тоже страница');
  assert.deepStrictEqual(coverage(rows), { itch: 1, steam: 1, vndb: 1 });
});

// ============================================================================
// Загрузка архивов: кусками, с продолжением после обрыва (services/uploads.js)
// ============================================================================

// Сервер загрузки на временной папке: настоящие маршруты и сервис, вместо 7-Zip — подделка,
// которая «распаковывает» игру и запоминает, какой архив ей дали. restart() — как перезапуск
// сервера: новый сервис на тех же папках
async function uploadRig(t) {
  const http = require('http');
  const express = require('express');
  const { UploadService } = require('./src/services/uploads.js');
  const createUploadsRouter = require('./src/routes/uploads.js');
  const { findGameFolder } = require('./src/utils/archive.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'uploads-'));
  const rig = { dir: path.join(root, '_tmp_uploads'), gamesDir: path.join(root, 'games'), added: [], refreshed: [], archives: [], free: 1e15, entries: null, extract: null };
  await fsp.mkdir(rig.gamesDir);
  rig.restart = () => {
    rig.svc = new UploadService();
    rig.svc.setDependencies({
      dir: rig.dir, gamesDir: rig.gamesDir, inboxDir: path.join(root, '_inbox'), findGameFolder,
      addGameToDB: async (folder) => { rig.added.push(folder); },
      refreshGame: async (folder, dest, { archiveName, version }) => { rig.refreshed.push([folder, archiveName, ...(version ? [version] : [])]); return { version: '' }; },
      tools: {
        list: async (archive, password) => (rig.list ? rig.list(password, archive) : rig.entries || [{ path: 'Game/www/index.html', size: 10, encrypted: false }]),
        extract: async (archive, out, password) => {
          rig.archives.push(await fsp.readFile(archive));
          if (rig.extract) return rig.extract(out, password, archive);
          await fsp.mkdir(path.join(out, 'Game', 'www'), { recursive: true });
          await fsp.writeFile(path.join(out, 'Game', 'www', 'index.html'), 'game');
        },
        freeSpace: async () => rig.free,
      },
    });
    rig.router = createUploadsRouter(rig.svc);
  };
  rig.restart();
  const app = express();
  app.use(express.json());
  app.use('/u', (req, res, next) => rig.router(req, res, next));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections?.();
    server.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/u`;

  rig.call = (method, url, { json, body, type } = {}) => new Promise((resolve, reject) => {
    const data = json ? Buffer.from(JSON.stringify(json)) : body;
    const headers = { 'Content-Length': data ? data.length : 0, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(type ? { 'Content-Type': type } : {}) };
    const req = http.request(`${base}${url}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || 'null'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(data);
  });
  rig.start = (json) => rig.call('POST', '/start', { json });
  rig.chunk = (id, offset, buf) => rig.call('POST', `/chunk?id=${id}&offset=${offset}`, { body: buf });
  rig.status = async (id) => (await rig.call('GET', `/status?id=${id}`)).body;
  // Кусок, у которого ушла только часть, а дальше — тишина: телефон уснул или сменил сеть
  rig.hang = (id, offset, buf, sent) => {
    const req = http.request(`${base}/chunk?id=${id}&offset=${offset}`, { method: 'POST', headers: { 'Content-Length': buf.length } });
    req.on('error', () => {});
    req.write(buf.subarray(0, sent));
    return req;
  };
  rig.size = async (id) => (await fsp.stat(path.join(rig.dir, `${id}.archive`)).catch(() => ({ size: 0 }))).size;
  rig.until = async (cond, what) => {
    for (let i = 0; i < 250; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`не дождались: ${what}`);
  };
  return rig;
}

test('MyJDownloader: вход по подписи, ссылка — в «Захват ссылок» без автостарта; сборки не для ПК убраны, остальное — на скачивание', async (t) => {
  const http = require('http');
  const crypto = require('crypto');
  const { MyJdService, cipher } = require('./src/services/myjd.js');
  const { setSavedSecret } = require('./src/utils/secrets.js');
  const { secretOf, sign, encrypt, decrypt, sha256 } = cipher;
  const acc = { email: 'Me@Example.org', password: 'p;a=ss word', device: 'server', folder: '/mnt/mimikin/_inbox' };
  const loginSecret = secretOf(acc.email, acc.password, 'server');
  const deviceSecret = secretOf(acc.email, acc.password, 'device');
  const token = crypto.randomBytes(16).toString('hex');
  const serverToken = sha256(loginSecret, Buffer.from(token, 'hex'));
  const deviceToken = sha256(deviceSecret, Buffer.from(token, 'hex'));
  const calls = [];
  // Капча висит первые until опросов списка капч, потом её «решили» — и сбор кончается
  const jd = { collecting: false, captchas: [], accounts: [], calls: 0, until: Infinity };
  const links = [
    { uuid: 1, name: 'Game-1.0-pc.zip', availability: 'ONLINE' }, { uuid: 2, name: 'Game-1.0-mac.zip', availability: 'ONLINE' },
    { uuid: 3, name: 'Game-1.0.apk', availability: 'ONLINE' }, { uuid: 4, name: 'Game-1.0-pc.zip', availability: 'OFFLINE' },
  ];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      const query = req.url.slice(0, req.url.indexOf('&signature='));
      const key = u.pathname === '/my/connect' ? loginSecret : serverToken;
      if (sign(key, query) !== u.searchParams.get('signature')) { res.statusCode = 403; return res.end('{"type":"AUTH_FAILED"}'); }
      const body = u.pathname === '/my/connect' ? { sessiontoken: token } : { list: [{ name: 'SERVER', id: 'dev1' }] };
      return res.end(encrypt(key, JSON.stringify(body)));
    }
    let data = '';
    req.on('data', (d) => { data += d; });
    req.on('end', () => {
      const msg = JSON.parse(decrypt(deviceToken, data));
      assert.strictEqual(req.url, `/t_${token}_dev1${msg.url}`);
      calls.push([msg.url, msg.params.map((p) => (typeof p === 'string' ? JSON.parse(p) : p))]);
      const answer = { '/linkgrabberv2/addLinks': { id: 77 }, '/linkgrabberv2/queryLinks': links,
        '/linkgrabberv2/queryPackages': [{ name: 'Game', uuid: 9, saveTo: `${acc.folder}/` }, { name: 'Game', uuid: 8, saveTo: '/output' }, { name: 'Other', uuid: 7, saveTo: acc.folder }], '/linkgrabberv2/isCollecting': jd.collecting && jd.calls < jd.until,
        '/captcha/list': msg.url === '/captcha/list' && jd.calls++ < jd.until ? jd.captchas : [], '/accountsV2/listAccounts': jd.accounts }[msg.url] ?? null;
      res.end(encrypt(deviceToken, JSON.stringify({ data: answer, rid: msg.rid })));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const svc = new MyJdService();
  svc.api = `http://127.0.0.1:${server.address().port}`;
  svc.sleep = async () => {};
  // Настоящий fetch: в полном прогоне глобальный бывает ещё подменён другим тестом
  svc.fetch = nativeFetch;
  setSavedSecret('myjd', '');
  await assert.rejects(svc.send('https://mega.nz/file/abc#key', 'Game'), { reason: 'off' });
  assert.deepStrictEqual(await svc.check(JSON.stringify({ ...acc, password: 'wrong' })), { ok: false, message: 'MyJDownloader не пустил: неверный пароль', why: 'AUTH_FAILED' });
  // Неверная почта — MyJDownloader отвечает 500 с типом: это «не пустил», а не «не ответил»
  const realFetch = svc.fetch;
  svc.fetch = async () => new Response('{ "src" : "MYJD", "type" : "EMAIL_INVALID" }', { status: 500 });
  assert.deepStrictEqual(await svc.check(JSON.stringify(acc)), { ok: false, message: 'MyJDownloader не знает такую почту — проверьте адрес', why: 'EMAIL_INVALID' });
  svc.fetch = realFetch;
  assert.deepStrictEqual(await svc.check(JSON.stringify({ ...acc, device: 'laptop' })).then((r) => r.ok), false, 'нет такого устройства');
  assert.deepStrictEqual(await svc.check(JSON.stringify(acc)), { ok: true });
  setSavedSecret('myjd', JSON.stringify(acc));
  t.after(() => setSavedSecret('myjd', ''));
  assert.deepStrictEqual(await svc.send('https://mega.nz/file/abc#key', 'Game'), { found: 4, sent: 1, names: ['Game-1.0-pc.zip'], partial: false });
  assert.deepStrictEqual(calls.find((c) => c[0] === '/linkgrabberv2/addLinks'), ['/linkgrabberv2/addLinks', [{ links: 'https://mega.nz/file/abc#key', packageName: 'Game', autostart: false, autoExtract: false, overwritePackagizerRules: true, destinationFolder: '/mnt/mimikin/_inbox' }]]);
  assert.deepStrictEqual(calls.find((c) => c[0] === '/linkgrabberv2/queryLinks')[1][0].packageUUIDs, [9], 'ссылки — из пакета с нашим именем в папке «Входящие»');
  assert.deepStrictEqual(calls.find((c) => c[0] === '/linkgrabberv2/removeLinks')[1], [[2, 3, 4], []], 'Mac, Android и недоступный — убраны');
  assert.deepStrictEqual(calls.find((c) => c[0] === '/linkgrabberv2/moveToDownloadlist')[1], [[1], []]);
  assert.ok(calls.some((c) => c[0] === '/downloadcontroller/start'));
  // Пароль архива — и JDownloader вместе со ссылками: иначе он спрашивает его окном при распаковке
  calls.length = 0;
  await svc.send('https://mega.nz/file/x#k', 'Game', '', { passwords: ['secret'] });
  assert.strictEqual(calls.find((c) => c[0] === '/linkgrabberv2/addLinks')[1][0].extractPassword, 'secret');
  // С ключом загрузки — в фоне: ответ сразу, ход — в записи загрузки. Капча: этап «ждёт капчу», ничего не отправлено и не
  // убрано; не решили за отведённое время — ошибка «капча»
  svc.captchaWaitMs = 30;
  Object.assign(jd, { collecting: true, captchas: [{ id: 5, hoster: 'mega.nz' }], calls: 0, until: Infinity });
  calls.length = 0;
  const stages = [];
  const realSave = svc.saveJob.bind(svc);
  svc.saveJob = async (job) => { if (job.stage) stages.push(job.stage); return realSave(job); };
  // Начали из Telegram — туда и скажем: ждём капчу, потом не дождались
  const staged = [];
  svc.onStage = async (job) => { staged.push([job.stage, job.error || '', job.via, job.title]); };
  assert.deepStrictEqual(await svc.send('https://mega.nz/file/abc#key', 'Game', '1', { target: 'Game_Folder', via: 'tg' }), { started: true });
  await svc.runs.get('1');
  assert.deepStrictEqual(stages, ['collect', 'captcha', 'error']);
  assert.deepStrictEqual(staged, [['captcha', '', 'tg', 'Game'], ['error', 'captcha', 'tg', 'Game']]);
  assert.deepStrictEqual((await svc.downloads()).map((j) => [j.key, j.stage, j.error, j.captcha, j.target]), [['1', 'error', 'captcha', 'mega.nz', 'Game_Folder']]);
  assert.ok(!calls.some((c) => /removeLinks|moveToDownloadlist|start/.test(c[0])));
  // Капчу решили, пока ждали, — сбор пошёл дальше сам, без второго нажатия, и архив ушёл на скачивание
  stages.length = 0;
  Object.assign(jd, { calls: 0, until: 4 });
  svc.captchaWaitMs = 60 * 1000;
  await svc.send('https://mega.nz/file/abc#key', 'Game', '1', { target: 'Game_Folder', version: '1.0' });
  await svc.runs.get('1');
  assert.deepStrictEqual(stages, ['collect', 'captcha', 'collect', 'download']);
  assert.strictEqual(staged.length, 2, 'не из Telegram — туда ничего');
  assert.deepStrictEqual(await svc.targetFor('Game-1.0-pc.zip'), { target: 'Game_Folder', version: '1.0', passwords: [] }, 'скачанный архив — обновление этой игры, версия — из окна');
  assert.strictEqual(await svc.targetFor('Other.zip'), null);
  assert.strictEqual((await svc.downloads()).find((j) => j.key === '1').retry, true, 'адрес помнит — можно повторить');
  // Уже качается — та же ссылка ещё раз (Telegram, вторая вкладка) ничего не начинает заново и ход не теряет
  calls.length = 0;
  assert.deepStrictEqual(await svc.send('https://mega.nz/file/abc#key', 'Game', '1', { target: 'Game_Folder' }), { started: true, already: true });
  assert.ok(!svc.runs.has('1') && !calls.some((c) => c[0] === '/linkgrabberv2/addLinks'));
  assert.strictEqual((await svc.loadJobs()).get('1').stage, 'download');
  await assert.rejects(svc.retry('1'), (e) => e.status === 409, 'повторить можно только вставшую');
  // Убрали крестиком посреди сбора — запись не возвращается; второе нажатие, пока собирает, второго сбора не заводит
  Object.assign(jd, { calls: 0, until: Infinity });
  svc.captchaWaitMs = 30;
  await svc.send('https://mega.nz/file/abc#key', 'Game', '1');
  const busy = svc.runs.get('1');
  assert.deepStrictEqual(await svc.send('https://mega.nz/file/abc#key', 'Game', '1'), { started: true, already: true });
  assert.strictEqual(svc.runs.get('1'), busy, 'тот же сбор');
  await svc.forgetJob('1');
  await busy;
  assert.ok(!(await svc.downloads()).some((j) => j.key === '1'), 'убранная не воскресла');
  // Готовая — уже в библиотеке: тот же архив, положенный потом руками, — новая игра, а не её обновление
  await realSave({ key: '2', stage: 'done', names: ['Done.zip'], target: 'Game_Folder' });
  assert.strictEqual(await svc.targetFor('Done.zip'), null);
  // Новая игра с паролем — не обновление, но пароль доходит до распаковки
  await realSave({ key: 'link:3', stage: 'download', names: ['Locked.rar'], target: '', passwords: ['Esan'] });
  assert.deepStrictEqual(await svc.targetFor('Locked.rar'), { target: '', version: '', passwords: ['Esan'] });
  await svc.forgetJob('link:3');
  await svc.forgetJob('2');
  // «Повторить» — то же, что в первый раз; запись без адреса — не повторить
  await realSave({ key: '3', title: 'R', stage: 'error', error: 'none', url: 'https://mega.nz/file/three#key', version: '2.0', target: 'R_Game', via: 'tg' });
  await realSave({ key: '4', title: 'Old', stage: 'error', error: 'none' });
  const resent = [];
  const realSend = svc.send;
  svc.send = async (...args) => { resent.push(args); return { started: true }; };
  assert.deepStrictEqual(await svc.retry('3'), { started: true });
  assert.deepStrictEqual(resent, [['https://mega.nz/file/three#key', 'R', '3', { version: '2.0', target: 'R_Game', via: 'tg', passwords: [] }]]);
  await assert.rejects(svc.retry('4'), (e) => e.status === 404);
  svc.send = realSend;
  await svc.forgetJob('3');
  await svc.forgetJob('4');
  svc.saveJob = realSave;
  Object.assign(jd, { collecting: false, captchas: [], until: Infinity });
  // Хранится без пароля — только суммы для входа; по ним вход тот же
  const { myjdWithoutPassword } = require('./src/utils/secrets.js');
  const stored = JSON.parse(myjdWithoutPassword(JSON.stringify(acc)));
  assert.ok(!('password' in stored) && /^[0-9a-f]{64}$/.test(stored.loginSecret) && /^[0-9a-f]{64}$/.test(stored.deviceSecret));
  assert.deepStrictEqual(await svc.check(JSON.stringify(stored)), { ok: true });
  assert.deepStrictEqual(await svc.check(JSON.stringify({ ...stored, loginSecret: '0'.repeat(64) })).then((r) => r.ok), false, 'не те суммы — не пустил');
  // Нет устройства при проверке — рабочая сессия не ломается; фильтр сборок не для ПК
  await svc.check(JSON.stringify({ ...acc, device: 'laptop' }));
  assert.strictEqual(svc.session.deviceId, 'dev1');
  const { NOT_PC } = require('./src/services/myjd.js');
  assert.deepStrictEqual(['Game_mac.zip', 'Game-osx.zip', 'Game.apk', 'Machine Girl-pc.zip', 'Game-linux.zip'].map((n) => NOT_PC.test(n)), [true, true, true, false, false]);
});

test('MyJDownloader: ход загрузки — скачивание с байтами, перенос, архив во «Входящих», распаковка, игра в библиотеке', async (t) => {
  const { MyJdService } = require('./src/services/myjd.js');
  const { setSavedSecret } = require('./src/utils/secrets.js');
  setSavedSecret('myjd', JSON.stringify({ email: 'me@example.org', password: 'p', device: 'server', folder: '/in' }));
  t.after(() => setSavedSecret('myjd', ''));
  const svc = new MyJdService();
  let pkgs = [];
  let meta = null;
  let inbox = [];
  svc.call = async (acc, action) => (action === '/downloadsV2/queryPackages' ? pkgs : null);
  svc.setDependencies({ file: '', uploads: { inboxStatus: async () => meta }, inbox: { files: async () => inbox } });
  await svc.saveJob({ key: '5', title: 'Game', packageName: 'Game', folder: '/in', stage: 'download', names: ['Game-1.0.7z'], started: 1 });
  const now = async () => { svc.jdCache = null; const [j] = await svc.downloads(); return j; };
  pkgs = [{ name: 'Game', saveTo: '/other', bytesLoaded: 1, bytesTotal: 2 }, { name: 'Game', saveTo: '/in/', bytesLoaded: 50, bytesTotal: 200, speed: 10, eta: 15 }];
  assert.deepStrictEqual(await now().then((j) => [j.stage, j.loaded, j.total, j.speed, j.eta, j.file]), ['download', 50, 200, 10, 15, 'Game-1.0.7z'], 'пакет — из нашей папки');
  pkgs = [];
  assert.strictEqual((await now()).stage, 'download', 'JDownloader не нашёл пакет — этап не меняем');
  pkgs = [{ name: 'Game', saveTo: '/in', bytesLoaded: 200, bytesTotal: 200, finished: true }];
  assert.strictEqual((await now()).stage, 'transfer');
  // Во «Входящих» — настоящий файл: старый неудачный с тем же именем (время до «Загрузить») не в счёт
  const fs = require('fs');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jd-in-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  inbox = [path.join(tmp, 'Game-1.0.7z')];
  fs.writeFileSync(inbox[0], 'x');
  await svc.saveJob({ key: '5', started: Date.now() + 10 * 60 * 1000 });
  assert.strictEqual((await now()).stage, 'transfer', 'архив старше нажатия — не наш');
  // Скачано, а во «Входящие» не приходит 15 минут — подсказка (где искать архив); на диск она не пишется
  assert.ok((await svc.loadJobs()).get('5').transferAt > 0 && !(await now()).stuck);
  await svc.saveJob({ key: '5', transferAt: undefined });
  await now();
  assert.ok((await svc.loadJobs()).get('5').transferAt > 0, 'запись до этой версии — отсчёт с первого опроса');
  await svc.saveJob({ key: '5', transferAt: Date.now() - 16 * 60 * 1000 });
  assert.strictEqual((await now()).stuck, true);
  assert.strictEqual((await svc.loadJobs()).get('5').stuck, undefined);
  await svc.saveJob({ key: '5', started: 1 });
  assert.deepStrictEqual(await now().then((j) => [j.stage, j.step]), ['import', 'settle']);
  meta = { state: 'processing', step: 'check' };
  assert.deepStrictEqual(await now().then((j) => [j.stage, j.step]), ['import', 'check']);
  meta = { state: 'done', game: 'Game-1.0' };
  assert.deepStrictEqual(await now().then((j) => [j.stage, j.game]), ['done', 'Game-1.0']);
  meta = { state: 'password' };
  assert.strictEqual((await now()).stage, 'done', 'готовую больше не пересчитываем');
  await svc.forgetJob('5');
  assert.deepStrictEqual(await svc.downloads(), []);
  // Записи — на диске: переживают перезапуск; сбор ссылок и ожидание капчи, прерванные перезапуском, — ошибка,
  // а не вечное ожидание (даже свежие: сбор шёл в прежнем процессе)
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const disk = new MyJdService();
  disk.setDependencies({ file: path.join(dir, 'jd.json') });
  await Promise.all([disk.saveJob({ key: '7', title: 'A', stage: 'collect', started: 1 }), disk.saveJob({ key: '8', title: 'B', stage: 'done', started: 2 }),
    disk.saveJob({ key: '9', title: 'C', stage: 'captcha', started: 3 })]);
  const again = new MyJdService();
  again.setDependencies({ file: path.join(dir, 'jd.json') });
  const [b, a, c] = await Promise.all([again.loadJobs(), again.loadJobs()]).then(([m]) => [m.get('8'), m.get('7'), m.get('9')]);
  assert.deepStrictEqual([a.stage, a.error, b.stage, c.stage, c.error], ['error', 'stale', 'done', 'error', 'stale']);
});

test('две установки: «Связать» на одной, «Разрешить» на другой — дальше каждая сама находит свои архивы, где бы JDownloader их ни скачал', async (t) => {
  const express = require('express');
  const { RelayService } = require('./src/services/relay.js');
  const createRelayRouter = require('./src/routes/relay.js');
  const mk = async (name, saved = {}) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pair-${name}-`));
    const r = new RelayService();
    // У каждой установки — своё хранилище и своя сеть: другие тесты подменяют глобальный fetch
    const store = new Map(Object.entries(saved));
    r.load = (n) => store.get(n) || '';
    r.store = async (n, v) => { if (v) store.set(n, v); else store.delete(n); };
    r.fetch = nativeFetch;
    r.setDependencies({ dir });
    const app = express();
    app.use(express.json());
    app.use('/api/relay', createRelayRouter(r));
    const srv = app.listen(0);
    await new Promise((ok) => srv.once('listening', ok));
    return { r, dir, store, srv, url: `http://127.0.0.1:${srv.address().port}` };
  };
  const login = { email: 'me@x.org', loginSecret: 'a'.repeat(64), deviceSecret: 'b'.repeat(64), device: 'server', folder: '/output/Games/Mimikin' };
  const A = await mk('server', { myjd: JSON.stringify(login) }); // JDownloader пишет в его «Входящие»
  const B = await mk('laptop');                                    // ноутбук: MyJDownloader здесь не настроен
  t.after(async () => { for (const x of [A, B]) { x.srv.close(); await fsp.rm(x.dir, { recursive: true, force: true }); } });
  const ask = (body) => nativeFetch(`${A.url}/api/relay/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // «Связать» на ноутбуке — ролей он не выбирает; просьба ждёт «Разрешить» на сервере
  await assert.rejects(B.r.pair('ftp://x', B.url), /Нужен адрес/);
  assert.strictEqual((await ask({ id: '0123abcd', key: 'k'.repeat(40), nonce: 'n'.repeat(40) })).status, 400, 'без своего адреса — не просят');
  await B.r.pair(A.url, B.url);
  await B.r.cancel();
  assert.strictEqual(A.r.asks.size, 0, '«Отменить» — и там просьбы нет');
  await B.r.pair(A.url, B.url);
  await B.r.pair(A.url, B.url);
  const asked = (await A.r.status()).asks;
  assert.deepStrictEqual(asked.map((a) => [a.url, a.ip, a.code]), [[B.url, '127.0.0.1', (await B.r.status()).outgoing.code]], 'повтор заменил прежнюю; код — тот же, что на ноутбуке');
  assert.strictEqual((await nativeFetch(`${A.url}/api/relay/pair/${asked[0].request}`, { headers: { 'X-Relay-Nonce': 'x' } })).status, 404, 'ответ — только той, что просила');
  const twice = await Promise.allSettled([A.r.approve(asked[0].request), A.r.approve(asked[0].request)]);
  assert.deepStrictEqual(twice.map((x) => x.status).sort(), ['fulfilled', 'rejected'], 'двойной щелчок — одна связь');
  // Ответ не теряется: спросить можно ещё раз. Ноутбук забирает его и без открытой страницы — сам, раз в 30 с
  const again = (await A.r.answer(asked[0].request, B.r.outgoing.nonce)).key;
  assert.strictEqual(again, A.r.link().keyIn);
  B.r.outgoing.checked = 0;
  await B.r.tick();
  const sb = await B.r.status();
  const a = A.r.link();
  const b = B.r.link();
  assert.ok(a && b && sb.linked.url === A.url, 'связаны обе');
  assert.ok(a.keyIn === b.keyOut && a.keyOut === b.keyIn && a.self === b.peer && a.peer === b.self, 'ключи и номера — накрест');
  assert.strictEqual(JSON.parse(B.store.get('myjd')).email, 'me@x.org', 'вход MyJDownloader — с сервера: на ноутбуке его не было');
  assert.strictEqual(sb.linked.folder, '/output/Games/Mimikin');
  assert.strictEqual((await ask({ id: '0123abcd', url: 'http://10.0.0.9', key: 'k'.repeat(40), nonce: 'n'.repeat(40) })).status, 409, 'связанную больше не просят');
  // «Загрузить» на каждой — в свою подпапку той же папки JDownloader
  const myjd = require('./src/services/myjd.js');
  const { setSavedSecret } = require('./src/utils/secrets.js');
  const env = ['MYJD_LOGIN', 'MIMIKIN_PAIR'].map((k) => [k, process.env[k]]);
  env.forEach(([k]) => delete process.env[k]);
  t.after(() => { setSavedSecret('myjd', ''); setSavedSecret('pair', ''); for (const [k, v] of env) if (v !== undefined) process.env[k] = v; });
  setSavedSecret('pair', JSON.stringify(b));
  setSavedSecret('myjd', JSON.stringify({ ...login, folder: '' }));
  assert.strictEqual(myjd.account().folder, `/output/Games/Mimikin/.${b.self}`, 'своей папки нет — та, что у сервера');
  assert.strictEqual(myjd.login, myjd.constructor.prototype.login, 'вход в MyJDownloader у самой службы — свой, не затёрт');

  // JDownloader положил во «Входящие» сервера игру сервера и игру ноутбука — каждой в её папку
  const old = new Date(Date.now() - 5 * 60 * 1000);
  const put = async (dir, rel, body) => {
    const p = path.join(dir, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body);
    await fsp.utimes(p, old, old);
  };
  await put(A.dir, `.${a.self}/Pkg1/Server.zip`, 's'.repeat(100));
  await put(A.dir, `.${b.self}/Pkg2/Laptop.zip`, 'l'.repeat(4000));
  await put(A.dir, 'Mine.zip', 'm');
  await A.r.pass();
  assert.ok(fs.existsSync(path.join(A.dir, 'Server.zip')) && !fs.existsSync(path.join(A.dir, `.${a.self}`, 'Pkg1')), 'своя — во «Входящие» сервера');
  assert.ok(fs.existsSync(path.join(A.dir, `.${b.self}`, 'Pkg2', 'Laptop.zip')), 'игру ноутбука сервер не берёт');
  await B.r.pass();
  assert.strictEqual(B.r.state.error, '');
  assert.strictEqual(await fsp.readFile(path.join(B.dir, 'Laptop.zip'), 'utf8'), 'l'.repeat(4000), 'игра ноутбука — у ноутбука, целиком');
  assert.ok(!fs.existsSync(path.join(A.dir, `.${b.self}`, 'Pkg2')), 'на сервере — долой, с папкой пакета');
  assert.deepStrictEqual((await fsp.readdir(B.dir)).filter((n) => !n.startsWith('.')), ['Laptop.zip'], 'временного не осталось');

  // Ключ — только свой; выход из папки и ссылка наружу — нет
  const get = (q, key = b.keyOut) => nativeFetch(`${A.url}/api/relay/${q}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  assert.strictEqual((await get('files', '')).status, 401);
  assert.strictEqual((await get('files', b.keyIn)).status, 401, 'ключ к ноутбуку — не ключ к серверу');
  await put(A.dir, `.${b.self}/Next.zip`, 'n'.repeat(50));
  await fsp.symlink(path.join(A.dir, 'Mine.zip'), path.join(A.dir, `.${b.self}`, 'Link.zip'));
  assert.deepStrictEqual((await (await get('files')).json()).map((f) => f.name), ['Next.zip']);
  for (const q of ['file?path=..%2FMine.zip', 'file?path=%2Fetc%2Fpasswd', 'file?path=Link.zip']) assert.strictEqual((await get(q)).status, 404, q);
  // Пришло не столько, сколько в списке, — у ноутбука не кладём, на сервере не удаляем
  B.r.fetch = (u, o) => (/\/file\?/.test(u) && o.method === 'GET' ? Promise.resolve(new Response('x')) : nativeFetch(u, o));
  await B.r.pass();
  assert.match(B.r.state.error, /Next\.zip: пришло 1 байт из 50/);
  assert.ok(fs.existsSync(path.join(A.dir, `.${b.self}`, 'Next.zip')) && !fs.existsSync(path.join(B.dir, 'Next.zip')));
  B.r.fetch = nativeFetch;
  // Ноутбук выключен — для сервера это не ошибка: его архивы подождут
  A.r.fetch = () => Promise.reject(new Error('down'));
  await A.r.pass();
  assert.ok(A.r.state.error === '' && /не ответила/.test(A.r.state.peer));
  A.r.fetch = nativeFetch;
  // Отвязали на ноутбуке — и на сервере; ключ больше не пускает
  await B.r.unlink();
  assert.ok(!B.r.link() && !A.r.link());
  assert.strictEqual((await get('files')).status, 401);
  // Просьбы без входа не копятся
  for (let i = 0; i < 7; i++) await ask({ id: `0000000${i}`, url: `http://10.0.0.${i}`, key: 'k'.repeat(40), nonce: 'n'.repeat(40) });
  assert.strictEqual(A.r.asks.size, 5);
});

test('Seedbox: пароль — один раз, на сервере свой ключ вместо прежнего; готовые архивы — во «Входящие» и с сервера долой, свежие и тома — нет', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const { EventEmitter } = require('events');
  const { Readable, Writable } = require('stream');
  const { SeedboxService } = require('./src/services/seedbox.js');
  const { setSavedSecret } = require('./src/utils/secrets.js');
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'seedbox-'));
  t.after(() => { fs.rmSync(inbox, { recursive: true, force: true }); setSavedSecret('seedbox', ''); });
  const old = Date.now() / 1000 - 600;
  // Сервер в памяти: путь от домашней папки → содержимое; папки — отдельно
  const files = new Map([['.ssh/authorized_keys', { data: Buffer.from('ssh-rsa AAA me@pc\nssh-ed25519 OLD mimikin\n') }],
    ['dl/Game-1.0.7z', { data: Buffer.from('seven'), mtime: old }], ['dl/sub/Other.zip', { data: Buffer.from('zip!'), mtime: old }],
    ['dl/Fresh.7z', { data: Buffer.from('new'), mtime: Date.now() / 1000 }], ['dl/Big.part1.rar', { data: Buffer.from('v'), mtime: old }],
    ['dl/Game-1.0/www/a.png', { data: Buffer.from('png'), mtime: old }], ['dl/Game-1.0/Game.exe', { data: Buffer.from('exe'), mtime: old }],
    ['dl/Game-1.0/www/data.zip', { data: Buffer.from('data'), mtime: old }], ['dl/..', { data: Buffer.from('x'), mtime: old }],
    ['dl/.mac/Pkg/Lap.zip', { data: Buffer.from('lap'), mtime: old }], ['dl/.cache/Gone.zip', { data: Buffer.from('t'), mtime: old }]]);
  const dirs = new Set(['dl', 'dl/sub', 'dl/Game-1.0', 'dl/Game-1.0/www', 'dl/.mac', 'dl/.mac/Pkg', 'dl/.cache']);
  const logins = [];
  const sftp = {
    mkdir: (p, ...a) => { const cb = a.pop(); dirs.add(p); cb(null); },
    stat: (p, cb) => cb(dirs.has(p) || files.has(p) ? null : Object.assign(new Error('no such file'), { code: 2 })),
    rename: (a, b, cb) => { files.set(b, files.get(a)); files.delete(a); cb(null); },
    ext_openssh_rename: (a, b, cb) => cb(new Error('not supported')),
    chmod: (p, m, cb) => cb(null),
    unlink: (p, cb) => { files.delete(p); cb(null); },
    readdir: (dir, cb) => {
      const kids = new Set([...files.keys(), ...dirs].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split('/')[0]));
      cb(null, [...kids].map((name) => {
        const full = `${dir}/${name}`;
        const f = files.get(full);
        return { filename: name, attrs: { size: f?.data.length ?? 0, mtime: f?.mtime ?? old, isDirectory: () => dirs.has(full) } };
      }));
    },
    createReadStream: (p) => (files.has(p) ? Readable.from([files.get(p).data.toString('utf8')]) : Object.assign(new Readable({ read() { this.destroy(new Error('no such file')); } }))),
    createWriteStream: (p) => {
      const chunks = [];
      const w = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
      w.on('finish', () => { files.set(p, { data: Buffer.concat(chunks) }); w.emit('close'); });
      return w;
    },
    fastGet: (remote, local, opts, cb) => { fs.writeFileSync(local, files.get(remote).data); opts.step(files.get(remote).data.length); cb(null); },
  };
  class FakeClient extends EventEmitter {
    connect(o) {
      setImmediate(() => {
        if (!o.hostVerifier(Buffer.from(o.host === 'evil' ? 'other-key' : 'host-key'))) return this.emit('error', new Error('host key mismatch'));
        const keys = (files.get('.ssh/authorized_keys')?.data.toString() || '');
        const ok = o.password ? o.password === 'secret' : keys.includes(require('ssh2').utils.parseKey(o.privateKey).getPublicSSH().toString('base64'));
        logins.push(o.password ? 'password' : 'key');
        this.emit(ok ? 'ready' : 'error', new Error('All configured authentication methods failed'));
      });
      return this;
    }
    sftp(cb) { cb(null, sftp); }
    end() {}
  }
  const box = new SeedboxService();
  box.Client = FakeClient;
  box.setDependencies({ dir: inbox });
  const cfg = { host: 'box.example', port: 22, user: 'me', folder: 'dl' };
  assert.deepStrictEqual(await box.setup(JSON.stringify({ ...cfg, password: 'wrong' })), { ok: false, message: 'Сервер не пустил: неверный логин или пароль' });
  const r = await box.setup(JSON.stringify({ ...cfg, password: 'secret', folder: 'dl/new/' }));
  assert.strictEqual(r.ok, true);
  const saved = JSON.parse(r.value);
  assert.ok(!('password' in saved) && saved.key && saved.hostKey && saved.folder === 'dl/new', 'хранится ключ, не пароль');
  assert.ok(dirs.has('dl/new'), 'папку создали');
  const keys = files.get('.ssh/authorized_keys').data.toString().trim().split('\n');
  assert.deepStrictEqual([keys.length, keys[0], keys[1], keys[2].endsWith(` mimikin-${saved.id}`)], [3, 'ssh-rsa AAA me@pc', 'ssh-ed25519 OLD mimikin', true], 'чужие ключи (и соседней установки) целы');
  // Перенастройка — свой прежний ключ заменён, а не добавлен второй
  setSavedSecret('seedbox', r.value);
  const again = JSON.parse((await box.setup(JSON.stringify({ ...cfg, password: 'secret' }))).value);
  assert.strictEqual(again.id, saved.id);
  assert.strictEqual(files.get('.ssh/authorized_keys').data.toString().trim().split('\n').length, 3);
  assert.deepStrictEqual((await box.setup(JSON.stringify({ ...cfg, password: 'secret', folder: '' }))).message, 'Укажите папку на сервере');
  assert.deepStrictEqual(logins.slice(0, 3), ['password', 'password', 'key'], 'ключ проверен сразу');
  setSavedSecret('seedbox', JSON.stringify({ ...again, folder: 'dl' }));
  fs.mkdirSync(path.join(inbox, '.mac')); // вторая установка «mac» связана (services/relay.js, hello)
  await box.pull();
  assert.deepStrictEqual(fs.readdirSync(inbox).sort(), ['.mac', 'Big.part1.rar', 'Game-1.0.7z', 'Other.zip'], 'тома — тоже: соберут «Входящие»');
  assert.deepStrictEqual(fs.readdirSync(path.join(inbox, '.mac')), ['Lap.zip'], 'архив второй установки — в её папку у себя: оттуда она заберёт сама');
  assert.ok(!files.has('dl/.mac/Pkg/Lap.zip') && files.has('dl/.cache/Gone.zip'), 'скрытая папка без связанной установки — не наша, на сервере цела');
  assert.ok(!files.has('dl/Game-1.0.7z') && !files.has('dl/sub/Other.zip'), 'забранные — с сервера долой');
  assert.ok(files.has('dl/Fresh.7z') && files.has('dl/Game-1.0/www/data.zip'), 'свежий и архив внутри распакованной игры — на месте');
  assert.deepStrictEqual([box.status().pulled, box.status().error], [4, '']);
  // Подменённый сервер: отпечаток другой — не подключаемся
  setSavedSecret('seedbox', JSON.stringify({ ...again, folder: 'dl', host: 'evil' }));
  await box.pull();
  assert.match(box.status().error, /host key/);
});

test('Ключи в базе: при старте старые открытые шифруются (MyJDownloader — ещё и без пароля); с чужим ключом — как будто не заданы, строка цела', async (t) => {
  const os = require('os');
  const fs = require('fs');
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { loadSecrets, secret, setSavedSecret, unseal } = require('./src/utils/secrets.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
  const db = await open({ filename: path.join(dir, 'x.db'), driver: sqlite3.Database });
  t.after(async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); setSavedSecret('deepl', ''); setSavedSecret('myjd', ''); });
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.run("INSERT INTO settings VALUES ('deepl_api_key', '11111111-2222-3333-4444-555555555555:fx'), ('myjd_login', ?)", [JSON.stringify({ email: 'Me@x.org', password: 'pw', device: 'server', folder: '' })]);
  await loadSecrets(db);
  assert.strictEqual(secret('deepl'), '11111111-2222-3333-4444-555555555555:fx');
  const rows = Object.fromEntries((await db.all('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
  assert.ok(rows.deepl_api_key.startsWith('enc1:') && !rows.deepl_api_key.includes('1111'), 'зашифрован на месте');
  const myjd = JSON.parse(unseal(rows.myjd_login, 'myjd_login'));
  assert.ok(!('password' in myjd) && myjd.email === 'Me@x.org' && /^[0-9a-f]{64}$/.test(myjd.loginSecret), 'пароль MyJDownloader не хранится');
  // Испорченный шифр (как с чужим ключом) — секрета нет, строку не стираем
  await db.run("UPDATE settings SET value = 'enc1:AAAA' WHERE key = 'deepl_api_key'");
  await loadSecrets(db);
  assert.strictEqual(secret('deepl'), '');
  assert.ok((await db.get("SELECT value FROM settings WHERE key = 'deepl_api_key'")).value.startsWith('enc1:AAAA'));
  // Файл ключа: заводится целиком (второй процесс читает готовый), испорченный — понятная ошибка, а не «ключ» нулевой длины
  const keyFile = path.join(dir, 'k', '.secrets.key');
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  const fresh = () => { delete require.cache[require.resolve('./src/utils/secrets.js')]; return require('./src/utils/secrets.js'); };
  // Потом — прежний модуль: остальные модули держат его, и ключи из «Настроек» тесты кладут в него же
  const original = require.cache[require.resolve('./src/utils/secrets.js')];
  t.after(() => { require.cache[require.resolve('./src/utils/secrets.js')] = original; });
  process.env.SECRETS_KEY_FILE = keyFile;
  delete process.env.SECRETS_KEY;
  const a = fresh();
  const sealed = a.seal('v', 'x');
  assert.match(fs.readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}$/);
  assert.strictEqual((fs.statSync(keyFile).mode & 0o777).toString(8), '600');
  assert.strictEqual(fresh().unseal(sealed, 'x'), 'v', 'другой процесс — тот же ключ');
  fs.writeFileSync(keyFile, '');
  assert.throws(() => fresh().seal('v', 'x'), /испорчен/);
  // SECRETS_KEY из .env — главнее файла
  process.env.SECRETS_KEY = 'a long passphrase from env';
  assert.strictEqual(fresh().unseal(fresh().seal('v', 'x'), 'x'), 'v');
  fresh();
});

test('Параметры из «Настроек»: .env главнее сохранённого, сохранённое — значения по умолчанию; негодное не принимается', () => {
  const { option, setOption, describeOptions } = require('./src/utils/options.js');
  const env = process.env.SCRAPER_DAILY_LIMIT;
  delete process.env.SCRAPER_DAILY_LIMIT;
  try {
    assert.strictEqual(option('scraper_daily_limit'), 30);
    assert.strictEqual(setOption('scraper_daily_limit', '45'), 45);
    assert.strictEqual(option('scraper_daily_limit'), 45);
    assert.strictEqual(setOption('scraper_daily_limit', '0'), undefined);
    assert.strictEqual(setOption('scraper_daily_limit', '4.5'), undefined);
    assert.strictEqual(option('scraper_daily_limit'), 45, 'негодное не затирает сохранённое');
    process.env.SCRAPER_DAILY_LIMIT = '12';
    assert.deepStrictEqual([option('scraper_daily_limit'), describeOptions().scraper_daily_limit.fromEnv], [12, true]);
    assert.strictEqual(setOption('update_check', false), false);
    assert.strictEqual(option('update_check'), false);
    assert.strictEqual(setOption('scraper_daily_limit', [5]), undefined, 'не строка и не число — нет');
  } finally {
    setOption('scraper_daily_limit', null);
    setOption('update_check', null);
    if (env === undefined) delete process.env.SCRAPER_DAILY_LIMIT; else process.env.SCRAPER_DAILY_LIMIT = env;
  }
});

test('Обновления: новая метка на GitHub — «вышла версия» с заголовками из CHANGELOG; закрытый репозиторий — ошибка словами; «Обновить» — через помощника', async () => {
  const { UpdateService, notesOf } = require('./src/services/updates.js');
  const changelog = '## [Unreleased]\n\n- **Not yet.**\n\n## [6.1] — 2026-10-20\n\n### Added\n\n- **Seedbox in Settings.** text\n- **Download progress you can see.** text\n\n## [6.0] — 2026-09-29\n\n- **Old.**\n';
  assert.deepStrictEqual(notesOf(changelog, [6, 1, 0]), ['Seedbox in Settings', 'Download progress you can see']);
  const up = new UpdateService();
  up.current = '6.0.0';
  up.env = { MIMIKIN_IMAGE: 'ghcr.io/me/rpg-library' };
  const asked = [];
  up.fetch = async (url, opts = {}) => {
    asked.push([url, opts.method || 'GET', opts.headers?.Authorization]);
    if (url.includes('/tags')) return new Response(JSON.stringify([{ name: 'v5.0.1' }, { name: 'v6.1' }, { name: 'nightly' }, { name: 'v6.0' }]));
    if (url.endsWith('/v6.1/CHANGELOG.md')) return new Response(changelog);
    if (url.includes('watchtower')) return new Response('{}');
    return new Response('', { status: 404 });
  };
  const r = await up.status();
  assert.deepStrictEqual([r.latest, r.newer, r.notes, r.how, r.error], ['6.1', true, ['Seedbox in Settings', 'Download progress you can see'], 'image', '']);
  asked.length = 0;
  await up.status();
  assert.strictEqual(asked.length, 0, 'второй раз — из запомненного');
  up.current = '6.1.0';
  assert.strictEqual((await up.status(true)).newer, false, 'та же версия — не новая');
  // Закрытый или удалённый репозиторий GitHub отдаёт чужим как «нет такого»
  up.fetch = async () => new Response('', { status: 404 });
  assert.match((await up.status(true)).error, /не найден или закрыт/);
  // Кнопка — только с помощником; ключ уходит ему в заголовке
  await assert.rejects(up.update(), { status: 409 });
  up.env = { UPDATE_URL: 'http://watchtower:8080/v1/update', UPDATE_TOKEN: 'tok' };
  up.fetch = async (url, opts = {}) => { asked.push([url, opts.method, opts.headers?.Authorization]); return new Response('{}'); };
  assert.deepStrictEqual(await up.update(), { started: true });
  assert.deepStrictEqual(asked.at(-1), ['http://watchtower:8080/v1/update', 'POST', 'Bearer tok']);
  assert.strictEqual((await up.status()).how, 'button');
  // Помощник качает образ дольше 15 с — ответа нет, но обновление идёт; недоступен — так и сказано
  up.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  assert.deepStrictEqual(await up.update(), { started: true });
  up.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(up.update(), /недоступен \(watchtower:8080\)/);
  // Неудачная проверка помнится 10 минут, а не 6 часов
  up.cache = { error: 'GitHub ответил 403', checkedAt: Date.now() - 11 * 60 * 1000 };
  up.fetch = async (url) => new Response(url.includes('/tags') ? JSON.stringify([{ name: 'v6.2' }]) : '');
  assert.strictEqual((await up.status()).latest, '6.2');
  // Помощник из «Настроек» (зашифрованный секрет), если в .env его нет
  up.env = {};
  up.secret = (name) => (name === 'updater' ? JSON.stringify({ url: 'http://helper:8080/v1/update', token: 'saved' }) : '');
  up.fetch = async (url, opts = {}) => { asked.push([url, opts.method, opts.headers?.Authorization]); return new Response('{}'); };
  assert.strictEqual(up.how(), 'button');
  await up.update();
  assert.deepStrictEqual(asked.at(-1), ['http://helper:8080/v1/update', 'POST', 'Bearer saved']);
  up.option = () => false;
  assert.strictEqual((await up.status(true)).off, true, 'проверка выключена в «Настройках»');
});

test('MyJDownloader: из собранного по ссылке — только архив самой игры: без других игр автора, модов, соцсетей и безымянных ссылок', () => {
  const { pick } = require('./src/services/myjd.js');
  // Как в настоящей папке файлообменника: игра на четырёх зеркалах (одно с угаданным размером), две другие игры, мод, мусор
  const game = 'Marlows_Bakery_Quest-1.0.9.7z';
  const links = [
    { uuid: 1, name: '6136d69474018181e078a3aba50eea4e', availability: 'ONLINE', bytesTotal: 18 },
    { uuid: 2, name: game, availability: 'ONLINE', bytesTotal: 736429038 },
    { uuid: 3, name: game, availability: 'ONLINE', bytesTotal: 736414925 },
    { uuid: 4, name: game, availability: 'ONLINE', bytesTotal: 736429038 },
    { uuid: 5, name: game, availability: 'UNKNOWN' },
    { uuid: 6, name: 'moon-studio-demo-main.zip', availability: 'ONLINE', bytesTotal: 7107009 },
    { uuid: 7, name: 'Sky_Knight_Chronicles-v1.000.7z', availability: 'ONLINE', bytesTotal: 752067678 },
    { uuid: 8, name: 'No valid account found!example', availability: 'UNKNOWN' },
    { uuid: 9, name: 'Tidewater-Quest_Collectors_Edition.7z', availability: 'ONLINE', bytesTotal: 766080104 },
    { uuid: 10, name: game, availability: 'OFFLINE', bytesTotal: 736429038 },
  ];
  assert.deepStrictEqual(pick(links, "Marlow's Bakery Quest").map((l) => l.uuid), [2, 4, 5]);
  // Название не совпало ни словом — все архивы; Linux — только когда для Windows нет; тома и Mac — нет
  const other = [{ uuid: 1, name: 'Game-pc.zip' }, { uuid: 2, name: 'Game-linux.zip' }, { uuid: 3, name: 'Game.part1.rar' }, { uuid: 4, name: 'Game-mac.zip' }];
  assert.deepStrictEqual(pick(other, 'ゲーム').map((l) => l.uuid), [1]);
  assert.deepStrictEqual(pick(other.slice(1), 'Game').map((l) => l.uuid), [2]);
  assert.deepStrictEqual(pick([{ uuid: 1, name: 'Game.exe' }], 'Game'), [], 'архива нет — send ничего не убирает');
  // Архив только томами: все тома одного набора со всех зеркал; одним файлом есть — он
  const parts = ['katfile', 'rapidgator'].flatMap((host, i) => [1, 2].map((n) => ({ uuid: i * 10 + n, name: `G-v26.10.15.part${n}.rar`, host })));
  assert.deepStrictEqual(pick([...parts, { uuid: 30, name: 'Other.part1.rar' }], '星降る宿', '26.10.15').map((l) => l.uuid), [1, 2, 11, 12]);
  assert.deepStrictEqual(pick([...parts, { uuid: 40, name: 'G.7z' }], 'G').map((l) => l.uuid), [40]);
  // Рядом и прежняя версия — берём ту, что просили (по номеру в имени), даже если старую выложили на больше зеркал
  const versions = [{ uuid: 1, name: 'Game-1.0.8.7z' }, { uuid: 2, name: 'Game-1.0.8.7z' }, { uuid: 3, name: 'Game-1.0.9.7z' }];
  assert.deepStrictEqual(pick(versions, 'Game', 'v1.0.9').map((l) => l.uuid), [3]);
  assert.deepStrictEqual(pick(versions, 'Game', '').map((l) => l.uuid), [1, 2], 'версии нет — по числу зеркал');
  assert.deepStrictEqual(pick([{ uuid: 1, name: 'Game_1_0_9.zip' }, { uuid: 2, name: 'Game_1_0_19.zip' }], 'Game', '1.0.9').map((l) => l.uuid), [1], '«1_0_9» — та же версия, «1_0_19» — нет');
  // Одна игра — один архив: тот же архив, выложенный ещё раз как «….7z.7z», не качаем вторым
  const twice = ['Clockwork_Vale-1.2.0.7z', 'Clockwork_Vale-1.2.0.7z.7z'].flatMap((name, i) => [1, 2, 3].map((n) => ({ uuid: i * 10 + n, name, bytesTotal: 641863000 - i })));
  assert.deepStrictEqual(pick(twice, 'Clockwork Vale').map((l) => l.uuid), [1, 2, 3]);
  assert.deepStrictEqual(pick(twice.slice(0, 1).concat(twice.slice(3)), 'Clockwork Vale').map((l) => l.uuid), [1], '«.7z.7z» проигрывает и на большем числе зеркал');
  // Названия нет в именах — главный тот, что на большем числе зеркал
  assert.deepStrictEqual(pick([{ uuid: 1, name: 'Mod.zip' }, { uuid: 2, name: 'RJ01.7z' }, { uuid: 3, name: 'RJ01.7z' }], 'ゲーム').map((l) => l.uuid), [2, 3]);
});

test('«Входящие»: архив томами — тома в свою папку под своими именами, распаковка с первого; не вышло — папкой в _failed', async (t) => {
  const rig = await uploadRig(t);
  const inboxDir = path.join(path.dirname(rig.dir), '_inbox');
  await fsp.mkdir(inboxDir, { recursive: true });
  const put = async (name, body) => { const p = path.join(inboxDir, name); await fsp.writeFile(p, body); return p; };
  const parts = [await put('Big_Game.part1.rar', 'vol1'), await put('Big_Game.part2.rar', 'volume2')];
  const opened = [];
  rig.list = (pw, archive) => { opened.push(archive); return [{ path: 'Game/www/index.html', size: 10, encrypted: false }]; };
  const id = await rig.svc.importFile(parts);
  await rig.until(async () => rig.added.length === 1, 'игра добавлена');
  assert.deepStrictEqual(rig.added, ['Big_Game'], 'имя папки — без «.part1»');
  assert.ok(opened.length && opened.every((a) => a === path.join(rig.dir, `${id}.parts`, 'Big_Game.part1.rar')), 'с первого тома, остальные — рядом под своими именами');
  assert.strictEqual(rig.archives[0].toString(), 'vol1');
  assert.ok(!fs.existsSync(path.join(rig.dir, `${id}.parts`)) && !parts.some((p) => fs.existsSync(p)), 'тома убраны');
  // Битый — тома не стираются, а папкой с именем архива уходят в _inbox/_failed
  rig.extract = async () => { throw new Error('битый архив'); };
  const bad = await rig.svc.importFile([await put('Bad.part1.rar', 'b1'), await put('Bad.part2.rar', 'b2')]);
  await rig.until(async () => (await rig.svc.status(bad))?.state === 'error', 'ошибка');
  const kept = fs.readdirSync(path.join(inboxDir, '_failed'));
  assert.match(kept[0], /^\d+-Bad$/);
  assert.deepStrictEqual(fs.readdirSync(path.join(inboxDir, '_failed', kept[0])).sort(), ['Bad.part1.rar', 'Bad.part2.rar']);
  // Второй том не перенёсся — первый вернулся во «Входящие», метки нет: следующий проход попробует снова
  const half = [await put('Half.part1.rar', 'h1'), await put('Half.part2.rar', 'h2')];
  const { UploadService } = require('./src/services/uploads.js');
  const hid = UploadService.idFor('Half.part1.rar', 4, `inbox${Math.floor(fs.statSync(half[0]).mtimeMs)}`);
  fs.mkdirSync(path.join(rig.dir, `${hid}.parts`, 'Half.part2.rar', 'busy'), { recursive: true }); // второй том не переименовать
  await assert.rejects(rig.svc.importFile(half));
  assert.ok(half.every((p) => fs.existsSync(p)), 'оба тома — во «Входящих»');
  assert.ok(!fs.existsSync(rig.svc.metaPath(hid)), 'метки нет');
});

test('«Входящие»: докачанный архив — в библиотеку как загруженный; недокачанный, многотомный и неудачный — нет; неудачный не стирается', async (t) => {
  const { InboxService } = require('./src/services/inbox.js');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inbox-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const put = async (name, body = 'x', old = true) => {
    const p = path.join(dir, name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body);
    if (old) await fsp.utimes(p, new Date(Date.now() - 120e3), new Date(Date.now() - 120e3));
    return p;
  };
  await put('a.zip');
  await put('Package/c.7z');
  await put('b.zip.part');
  await put('big.part1.rar');
  await put('big.part2.rar.part');
  await put('_failed/d.zip');
  const growing = await put('grow.rar');
  await put('fresh.zip', 'x', false);
  const taken = [];
  const inbox = new InboxService();
  inbox.setDependencies({ dir, uploads: { importFile: async (f) => { taken.push([].concat(f).map((x) => path.relative(dir, x)).join(' + ')); } } });
  await inbox.scan();
  assert.deepStrictEqual(taken, [], 'первый проход — только запоминаем');
  await fsp.appendFile(growing, 'more');
  await fsp.utimes(growing, new Date(Date.now() - 120e3), new Date(Date.now() - 100e3));
  await inbox.scan();
  assert.deepStrictEqual(taken.sort(), ['Package/c.7z', 'a.zip'], 'растущий, свежий, .part, том, пока качается следующий, и _failed — нет');
  await inbox.scan();
  assert.ok(taken.includes('grow.rar'), 'перестал расти — берём');
  // Тома: второй докачался — архив одной загрузкой, первый том первым; загрузка ждёт третий — ждём и мы
  await fsp.rm(path.join(dir, 'big.part2.rar.part'));
  await put('big.part2.rar');
  inbox.volumesOf = async (name) => (name === 'big.part1.rar' ? ['big.part1.rar', 'big.part2.rar', 'big.part3.rar'] : []);
  await inbox.scan();
  await inbox.scan();
  assert.ok(!taken.some((x) => x.includes('big')), 'JDownloader ещё качает третий том');
  inbox.volumesOf = async () => ['big.part1.rar', 'big.part2.rar'];
  await inbox.scan();
  assert.ok(taken.includes('big.part1.rar + big.part2.rar'));
  await fsp.rm(path.join(dir, 'big.part1.rar'));
  await fsp.rm(path.join(dir, 'big.part2.rar'));
  // Тома без загрузки (скопировали руками): пропуск номера — ждём; все на месте — ждём 10 минут тишины, потом берём
  inbox.volumesOf = async () => [];
  const solo = [await put('solo.part1.rar'), await put('solo.part3.rar')];
  await inbox.scan();
  await inbox.scan();
  assert.ok(!taken.some((x) => x.includes('solo')), 'нет второго тома');
  await fsp.rm(solo[1]);
  await inbox.scan();
  assert.ok(!taken.some((x) => x.includes('solo')), 'один том — может, следующий ещё в пути');
  await fsp.utimes(solo[0], new Date(Date.now() - 20 * 60e3), new Date(Date.now() - 20 * 60e3));
  await inbox.scan();
  await inbox.scan();
  assert.ok(taken.includes('solo.part1.rar'));
  await fsp.rm(solo[0]);

  // Настоящий сервис загрузки: архив переезжает из «Входящих» и становится игрой; не вышло — в _inbox/_failed
  const rig = await uploadRig(t);
  const inboxDir = path.join(path.dirname(rig.dir), '_inbox');
  await fsp.mkdir(path.join(inboxDir, 'Pkg'), { recursive: true });
  const archive = path.join(inboxDir, 'Pkg', 'Cool_Game_v1.0.zip');
  await fsp.writeFile(archive, 'zip bytes');
  await rig.svc.importFile(archive);
  await rig.until(async () => rig.added.length === 1, 'игра добавлена');
  assert.deepStrictEqual(rig.added, ['Cool_Game_v1.0']);
  assert.strictEqual(fs.existsSync(archive), false, 'из «Входящих» архив ушёл');
  // Архив «Загрузить» у своей игры — её обновлением (прежняя версия — в _old), а не второй копией;
  // игры уже нет — встаёт новой, а не пропадает
  const upd = path.join(inboxDir, 'Cool_Game_v1.1.zip');
  await fsp.writeFile(upd, 'zip bytes 2');
  await rig.svc.importFile(upd, { target: 'Cool_Game_v1.0', version: '1.1' });
  await rig.until(async () => rig.refreshed.length === 1, 'игра обновлена');
  assert.deepStrictEqual([rig.refreshed[0], rig.added.length], [['Cool_Game_v1.0', 'Cool_Game_v1.1.zip', '1.1'], 1], 'версия из темы — до библиотеки');
  const orphan = path.join(inboxDir, 'Gone_Game.zip');
  await fsp.writeFile(orphan, 'zip bytes 3');
  await rig.svc.importFile(orphan, { target: 'No_Such_Game' });
  await rig.until(async () => rig.added.length === 2, 'новой игрой');
  rig.extract = async () => { throw new Error('битый архив'); };
  const bad = path.join(inboxDir, 'Broken.zip');
  await fsp.writeFile(bad, 'broken');
  const id = await rig.svc.importFile(bad);
  await rig.until(async () => (await rig.svc.status(id))?.state === 'error', 'ошибка');
  const failedFiles = () => fs.readdirSync(path.join(inboxDir, '_failed'));
  assert.match(failedFiles()[0], /^\d+-Broken\.zip$/);
  assert.strictEqual(fs.readFileSync(path.join(inboxDir, '_failed', failedFiles()[0]), 'utf8'), 'broken', 'неудачный — в _failed, не стёрт');
  // Вернули из _failed (с тем же временем) — принимается заново; второй неудачный с тем же именем не затирает первый
  const back = path.join(inboxDir, 'Broken.zip');
  await fsp.rename(path.join(inboxDir, '_failed', failedFiles()[0]), back);
  const again = await rig.svc.importFile(back);
  assert.strictEqual(again, id);
  await rig.until(async () => failedFiles().length === 1 && (await rig.svc.status(id))?.state === 'error', 'снова ошибка');
  await fsp.writeFile(bad, 'broken2');
  const id2 = await rig.svc.importFile(bad);
  await rig.until(async () => (await rig.svc.status(id2))?.state === 'error' && failedFiles().length === 2, 'вторая ошибка');
  // Ждёт пароля, и его отменили — архив не пропадает, а уходит в _failed
  rig.extract = null;
  rig.list = () => { throw Object.assign(new Error('Архив под паролем'), { needPassword: true }); };
  await fsp.writeFile(path.join(inboxDir, 'Locked.zip'), 'locked');
  const locked = await rig.svc.importFile(path.join(inboxDir, 'Locked.zip'));
  await rig.until(async () => (await rig.svc.status(locked))?.state === 'password', 'ждёт пароля');
  await rig.svc.cancel(locked);
  assert.ok(failedFiles().some((f) => f.endsWith('-Locked.zip')), 'отменённый — в _failed');
  // «Загрузить» у своей игры: архив с её именем — её обновлением
  const asked = [];
  const box2 = new InboxService();
  box2.setDependencies({ dir, uploads: { importFile: async (f, opts) => { asked.push([path.basename([].concat(f)[0]), opts]); } }, targetOf: async (name) => (name === 'upd.zip' ? { target: 'My_Game', version: '1.1' } : name === 'locked.zip' ? { passwords: ['Esan'] } : null) });
  await put('upd.zip');
  await put('plain.zip');
  await put('locked.zip');
  await box2.scan();
  await box2.scan();
  assert.deepStrictEqual(asked.filter(([n]) => ['upd.zip', 'plain.zip', 'locked.zip'].includes(n)).sort(),
    [['locked.zip', { target: '', version: '', passwords: ['Esan'] }], ['plain.zip', {}], ['upd.zip', { target: 'My_Game', version: '1.1', passwords: [] }]], 'пароль со страницы — до распаковки');
});

test('загрузка: куски строго подряд; повтор куска — 409 и сколько получено; целиком — игра в библиотеке', async (t) => {
  const crypto = require('crypto');
  const rig = await uploadRig(t);
  const MB = 1024 * 1024;
  const file = crypto.randomBytes(3 * MB + 123);
  const start = { name: 'Моя Игра: v1.2.zip', size: file.length, fingerprint: 'abc123' };
  const s = await rig.start(start);
  assert.deepStrictEqual([s.status, s.body.state, s.body.received], [200, 'uploading', 0]);
  const { id } = s.body;

  let r = await rig.chunk(id, 0, file.subarray(0, MB));
  assert.deepStrictEqual(r.body, { received: MB, state: 'uploading' });
  r = await rig.chunk(id, 0, file.subarray(0, MB));
  assert.deepStrictEqual([r.status, r.body.received], [409, MB], 'ответ потерялся, кусок пришёл снова — второй раз не пишем');
  r = await rig.chunk(id, 2 * MB, file.subarray(2 * MB, 3 * MB));
  assert.deepStrictEqual([r.status, r.body.received], [409, MB], 'дыр в архиве не бывает');
  r = await rig.chunk(id, MB, Buffer.alloc(file.length));
  assert.strictEqual(r.status, 413, 'за размер файла не пишем');

  const again = await rig.start(start);
  assert.deepStrictEqual([again.body.id, again.body.received], [id, MB], 'тот же файл выбран снова — та же загрузка, с того же места');
  r = await rig.chunk(id, MB, file.subarray(MB));
  assert.deepStrictEqual(r.body, { received: file.length, state: 'processing' }, 'последний кусок отвечает сразу, распаковка — в фоне');
  await rig.svc.jobs.get(id);
  const st = await rig.status(id);
  assert.deepStrictEqual([st.state, st.folder], ['done', 'Моя Игра_ v1.2']);
  assert.ok(rig.archives[0].equals(file), 'архив собран байт в байт');
  assert.deepStrictEqual(rig.added, ['Моя Игра_ v1.2']);
  assert.strictEqual(await fsp.readFile(path.join(rig.gamesDir, 'Моя Игра_ v1.2', 'index.html'), 'utf8'), 'game');
  assert.deepStrictEqual(await fsp.readdir(rig.dir), [`${id}.json`], 'архив и распакованное убраны');

  const fresh = await rig.start(start);
  assert.deepStrictEqual([fresh.body.id, fresh.body.received, fresh.body.state], [id, 0, 'uploading'], 'после готовой тот же файл — новая загрузка с нуля');
});

test('загрузка: оборванный кусок — записанное остаётся, с него и продолжаем, в том числе после перезапуска сервера', async (t) => {
  const crypto = require('crypto');
  const rig = await uploadRig(t);
  const file = crypto.randomBytes(2 * 1024 * 1024);
  const start = { name: 'Game.7z', size: file.length, fingerprint: 'f1' };
  const { id } = (await rig.start(start)).body;
  const sent = 700 * 1024;
  const req = rig.hang(id, 0, file, sent);
  await rig.until(async () => (await rig.size(id)) === sent, 'первые 700 КБ на диске');
  req.destroy();
  await rig.until(() => rig.svc.writing.size === 0, 'сервер закрыл оборванный кусок');
  assert.strictEqual((await rig.status(id)).received, sent);

  rig.restart();
  const resumed = await rig.start(start);
  assert.deepStrictEqual([resumed.body.id, resumed.body.received], [id, sent], 'после перезапуска — с 700 КБ');
  assert.strictEqual((await rig.chunk(id, sent, file.subarray(sent))).body.state, 'processing');
  await rig.svc.jobs.get(id);
  assert.ok(rig.archives[0].equals(file), 'архив собран байт в байт');
  assert.deepStrictEqual(rig.added, ['Game']);
});

test('загрузка: зависшее соединение — живое держит файл (409), молчащее уступает место новому запросу, брошенное закрывается само', async (t) => {
  const crypto = require('crypto');
  const rig = await uploadRig(t);
  rig.svc.takeoverMs = 400;
  const KB = 1024;
  const file = crypto.randomBytes(1024 * KB);
  const { id } = (await rig.start({ name: 'G.zip', size: file.length, fingerprint: 'f2' })).body;
  const hung = rig.hang(id, 0, file, 100 * KB);
  let hungClosed = false;
  hung.on('close', () => { hungClosed = true; });
  await rig.until(async () => (await rig.size(id)) === 100 * KB, '100 КБ на диске');
  let r = await rig.chunk(id, 100 * KB, file.subarray(100 * KB));
  assert.deepStrictEqual([r.status, r.body.busy], [409, true], 'только что писавший запрос не перебиваем');
  await new Promise((res) => setTimeout(res, 500));
  r = await rig.chunk(id, 100 * KB, file.subarray(100 * KB));
  assert.deepStrictEqual(r.body, { received: file.length, state: 'processing' }, 'молчавший уступил место');
  await rig.until(() => hungClosed, 'зависшее соединение закрыто');
  await rig.svc.jobs.get(id);
  assert.ok(rig.archives[0].equals(file));

  rig.svc.stallMs = 300;
  const { id: id2 } = (await rig.start({ name: 'H.zip', size: file.length, fingerprint: 'f3' })).body;
  rig.hang(id2, 0, file, 64 * KB);
  await rig.until(async () => (await rig.size(id2)) === 64 * KB, '64 КБ на диске');
  await rig.until(() => rig.svc.writing.size === 0, 'сторож закрыл брошенный кусок');
  assert.strictEqual((await rig.status(id2)).received, 64 * KB, 'записанное до обрыва осталось');
});

test('загрузка: сервер перезапустился во время распаковки — доделываем; игра уже переехала — второй раз не распаковываем', async (t) => {
  const crypto = require('crypto');
  const { UploadService } = require('./src/services/uploads.js');
  const rig = await uploadRig(t);
  const file = crypto.randomBytes(4096);
  await fsp.mkdir(rig.dir, { recursive: true });
  const put = async (name, extra = {}) => {
    const id = UploadService.idFor(name, file.length, 'f4');
    await fsp.writeFile(path.join(rig.dir, `${id}.archive`), file);
    await fsp.writeFile(path.join(rig.dir, `${id}.json`), JSON.stringify({ id, name, size: file.length, state: 'processing', ...extra }));
    return id;
  };
  const a = await put('A.zip');
  const b = await put('B.zip', { folder: 'B' });
  await fsp.mkdir(path.join(rig.gamesDir, 'B'));
  rig.restart();
  await rig.svc.recover();
  await Promise.all([...rig.svc.jobs.values()]);
  const [sa, sb] = [await rig.status(a), await rig.status(b)];
  assert.deepStrictEqual([sa.state, sa.folder, sb.state, sb.folder], ['done', 'A', 'done', 'B']);
  assert.deepStrictEqual(rig.added, ['A'], 'B уже в библиотеке — её добавила сверка при старте');
  assert.strictEqual(rig.archives.length, 1, 'распакован только A');
  assert.deepStrictEqual((await fsp.readdir(rig.dir)).sort(), [`${a}.json`, `${b}.json`].sort());
});

test('загрузка: отказы — нет места, путь наружу, не игра, архив повреждён; неудачную можно убрать из списка', async (t) => {
  const crypto = require('crypto');
  const { explain7z } = require('./src/services/uploads.js');
  const rig = await uploadRig(t);
  const file = crypto.randomBytes(2048);
  let n = 0;
  const upload = async () => {
    const { id } = (await rig.start({ name: `E${++n}.rar`, size: file.length, fingerprint: 'f5' })).body;
    await rig.chunk(id, 0, file);
    await rig.svc.jobs.get(id);
    return rig.status(id);
  };
  rig.free = 1024 ** 3;
  const full = await rig.start({ name: 'Big.zip', size: file.length, fingerprint: 'f5' });
  assert.deepStrictEqual([full.status, /места на диске/.test(full.body.error)], [507, true], 'гигабайт запаса не трогаем');
  rig.free = 1e15;

  rig.entries = [{ path: 'G/../../etc/cron.d/x', size: 5, encrypted: false }];
  assert.match((await upload()).error, /путь наружу/);
  rig.entries = [{ path: 'G/www/index.html', size: 1e15, encrypted: false }];
  assert.match((await upload()).error, /места для распаковки/);
  rig.entries = null;
  rig.extract = async (out) => { await fsp.writeFile(path.join(out, 'readme.txt'), 'x'); };
  assert.match((await upload()).error, /нет игры/);
  rig.extract = async () => { throw new Error(explain7z('ERROR: CRC Failed : a.bin', 2)); };
  const broken = await upload();
  assert.match(broken.error, /Архив повреждён/);

  assert.deepStrictEqual(await fsp.readdir(rig.gamesDir), [], 'в библиотеку ничего не попало');
  assert.ok((await fsp.readdir(rig.dir)).every((f) => f.endsWith('.json')), 'ни архивов, ни распакованного');
  const list = (await rig.call('GET', '/list')).body;
  assert.deepStrictEqual(list.map((x) => x.state), ['error', 'error', 'error', 'error']);
  assert.deepStrictEqual((await rig.call('POST', `/cancel?id=${broken.id}`)).body, { cancelled: true });
  assert.strictEqual((await rig.call('GET', '/list')).body.length, 3, 'убранная из списка пропала');
});

test('загрузка: архив с паролем ждёт пароля; не тот — спрашиваем снова, верный — распаковываем; пароль нигде не остаётся', async (t) => {
  const crypto = require('crypto');
  const rig = await uploadRig(t);
  const logged = [];
  t.mock.method(console, 'log', (...args) => { logged.push(args.join(' ')); });
  const file = crypto.randomBytes(4096);
  const tried = [];
  const refuse = () => Object.assign(new Error('Архив под паролем'), { password: true });
  const unpack = async (out) => {
    await fsp.mkdir(path.join(out, 'G', 'www'), { recursive: true });
    await fsp.writeFile(path.join(out, 'G', 'www', 'index.html'), 'game');
  };
  // Зашифрованы файлы: список виден, распаковка — только с верным паролем
  rig.entries = [{ path: 'G/www/index.html', size: 5, encrypted: true }];
  rig.extract = async (out, password) => {
    tried.push(password);
    await fsp.writeFile(path.join(out, 'garbage'), '');
    if (password !== 'секрет-123') throw refuse();
    await unpack(out);
  };
  const start = { name: 'Locked.7z', size: file.length, fingerprint: 'pw1' };
  const { id } = (await rig.start(start)).body;
  await rig.chunk(id, 0, file);
  await rig.svc.jobs.get(id);
  let st = await rig.status(id);
  assert.deepStrictEqual([st.state, st.error], ['password', '']);
  assert.strictEqual(await rig.size(id), file.length, 'архив ждёт пароля на сервере');
  assert.deepStrictEqual(tried, [], 'без пароля даже не распаковываем');
  assert.strictEqual((await rig.start(start)).body.state, 'password', 'тот же файл снова — тот же архив, ждущий пароля');
  assert.deepStrictEqual((await rig.call('GET', '/list')).body.map((u) => u.state), ['password'], 'видно и после перезагрузки страницы');

  assert.strictEqual((await rig.call('POST', `/password?id=${id}`, { json: { password: '' } })).status, 400);
  assert.strictEqual((await rig.call('POST', `/password?id=${id}`, { json: { password: 'не тот' } })).status, 200);
  await rig.svc.jobs.get(id);
  st = await rig.status(id);
  assert.deepStrictEqual([st.state, st.error], ['password', 'Неверный пароль']);
  assert.ok(!(await fsp.readdir(rig.dir)).some((f) => f.startsWith('ext_')), 'пустые файлы от неверного пароля убраны');
  assert.strictEqual((await rig.call('POST', `/password?id=${id}`, { json: { password: 'секрет-123' } })).status, 200);
  await rig.svc.jobs.get(id);
  st = await rig.status(id);
  assert.deepStrictEqual([st.state, st.folder], ['done', 'Locked']);
  assert.deepStrictEqual(tried, ['не тот', 'секрет-123']);
  assert.strictEqual((await rig.call('POST', `/password?id=${id}`, { json: { password: 'x' } })).status, 409, 'готовый архив пароля не ждёт');

  // Зашифрован и список файлов: без верного пароля архив не открывается вовсе
  rig.extract = async (out) => unpack(out);
  rig.list = (password) => {
    if (password !== 'k') throw refuse();
    return [{ path: 'H/www/index.html', size: 5, encrypted: true }];
  };
  const hidden = { name: 'Hidden.7z', size: file.length, fingerprint: 'pw2' };
  const { id: id2 } = (await rig.start(hidden)).body;
  await rig.chunk(id2, 0, file);
  await rig.svc.jobs.get(id2);
  assert.strictEqual((await rig.status(id2)).state, 'password');
  await rig.call('POST', `/password?id=${id2}`, { json: { password: 'k' } });
  await rig.svc.jobs.get(id2);
  assert.strictEqual((await rig.status(id2)).state, 'done');

  assert.strictEqual(rig.svc.passwords.size, 0, 'после распаковки пароль не держим');
  const metas = await Promise.all((await fsp.readdir(rig.dir)).map((f) => fsp.readFile(path.join(rig.dir, f), 'utf8')));
  assert.ok(![...metas, ...logged].some((x) => /секрет|не тот/.test(x)), 'пароль — ни в файлах состояния, ни в журнале');
});

test('загрузка: игра во вложенном архиве — самый большой первым, многотомный с первого тома, с тем же паролем, не глубже трёх уровней', async (t) => {
  const crypto = require('crypto');
  const rig = await uploadRig(t);
  const file = crypto.randomBytes(2048);
  const opened = [];
  const name = (archive) => (archive.endsWith('.archive') ? 'загрузка' : path.basename(archive));
  // Внешний архив: readme, саундтрек поменьше и игра в многотомном rar под паролем
  rig.extract = async (out, password, archive) => {
    opened.push(name(archive));
    if (archive.endsWith('.archive')) {
      await fsp.writeFile(path.join(out, 'readme.txt'), 'x');
      await fsp.writeFile(path.join(out, 'OST.zip'), Buffer.alloc(100));
      await fsp.mkdir(path.join(out, 'Game'));
      await fsp.writeFile(path.join(out, 'Game', 'Game.part1.rar'), Buffer.alloc(1000));
      await fsp.writeFile(path.join(out, 'Game', 'Game.part2.rar'), Buffer.alloc(1000));
      return;
    }
    if (password !== 'pw') throw Object.assign(new Error('Архив под паролем'), { password: true });
    await fsp.mkdir(path.join(out, 'Game', 'www'), { recursive: true });
    await fsp.writeFile(path.join(out, 'Game', 'www', 'index.html'), 'game');
  };
  const { id } = (await rig.start({ name: 'Double.zip', size: file.length, fingerprint: 'n1' })).body;
  await rig.chunk(id, 0, file);
  await rig.svc.jobs.get(id);
  assert.strictEqual((await rig.status(id)).state, 'password', 'вложенный архив под паролем — спрашиваем пароль');
  await rig.call('POST', `/password?id=${id}`, { json: { password: 'pw' } });
  await rig.svc.jobs.get(id);
  const st = await rig.status(id);
  assert.deepStrictEqual([st.state, st.folder], ['done', 'Double']);
  assert.deepStrictEqual(opened, ['загрузка', 'Game.part1.rar', 'загрузка', 'Game.part1.rar'], 'самый большой первым, со второго тома не начинаем, саундтрек не трогаем');
  assert.strictEqual(await fsp.readFile(path.join(rig.gamesDir, 'Double', 'index.html'), 'utf8'), 'game');
  assert.deepStrictEqual(await fsp.readdir(rig.dir), [`${id}.json`], 'распакованное и вложенные архивы убраны');

  // Архив в архиве в архиве… — дальше третьего уровня не идём
  opened.length = 0;
  rig.extract = async (out, password, archive) => {
    opened.push(name(archive));
    await fsp.writeFile(path.join(out, 'deeper.zip'), Buffer.alloc(10));
  };
  const { id: id2 } = (await rig.start({ name: 'Matryoshka.zip', size: file.length, fingerprint: 'n2' })).body;
  await rig.chunk(id2, 0, file);
  await rig.svc.jobs.get(id2);
  assert.match((await rig.status(id2)).error, /во вложенных архивах тоже/);
  assert.deepStrictEqual(opened, ['загрузка', 'deeper.zip', 'deeper.zip', 'deeper.zip']);
});

test('загрузка: новая версия игры из библиотеки — та же папка, прежняя уезжает в _old, новой игры не появляется', async (t) => {
  const crypto = require('crypto');
  const rig = await uploadRig(t);
  const game = path.join(rig.gamesDir, 'Ironhold_Keep_ver1.3');
  await fsp.mkdir(game);
  await fsp.writeFile(path.join(game, 'index.html'), 'v1.3');
  await fsp.symlink(game, path.join(rig.gamesDir, 'Linked'));
  // Игру, которую не обновить, видно сразу — до гигабайтов загрузки
  const refused = async (target) => (await rig.start({ name: 'x.zip', size: 10, fingerprint: 'a', target })).status;
  assert.deepStrictEqual([await refused('Nope'), await refused('Linked'), await refused('../etc'), await refused('_saves')], [404, 403, 400, 400]);

  const file = crypto.randomBytes(4096);
  const start = { name: 'Ironhold_Keep_ver1.3.1.69.zip', size: file.length, fingerprint: 'u1', target: 'Ironhold_Keep_ver1.3' };
  const { id } = (await rig.start(start)).body;
  const { target, ...asNew } = start;
  assert.notStrictEqual(id, (await rig.start(asNew)).body.id, `тот же архив новой игрой — другая загрузка (${target})`);
  await rig.chunk(id, 0, file);
  await rig.svc.jobs.get(id);
  const st = await rig.status(id);
  assert.deepStrictEqual([st.state, st.folder, st.target], ['done', 'Ironhold_Keep_ver1.3', 'Ironhold_Keep_ver1.3']);
  assert.strictEqual(await fsp.readFile(path.join(game, 'index.html'), 'utf8'), 'game', 'в папке игры — новая версия');
  const old = path.join(rig.gamesDir, '_old', 'Ironhold_Keep_ver1.3');
  const stamps = await fsp.readdir(old);
  assert.strictEqual(stamps.length, 1);
  assert.strictEqual(await fsp.readFile(path.join(old, stamps[0], 'index.html'), 'utf8'), 'v1.3', 'прежняя — в _old, не в корзине');
  assert.deepStrictEqual(rig.added, [], 'новой игры не появилось');
  assert.deepStrictEqual(rig.refreshed, [['Ironhold_Keep_ver1.3', 'Ironhold_Keep_ver1.3.1.69.zip']], 'версию и прочее из файлов — запросили');
});

test('загрузка: сервер перезапустился посреди замены папок — доделываем по тому, где что лежит', async (t) => {
  const crypto = require('crypto');
  const { UploadService } = require('./src/services/uploads.js');
  const rig = await uploadRig(t);
  const file = crypto.randomBytes(4096);
  await fsp.mkdir(rig.dir, { recursive: true });
  const put = async (target, stamp) => {
    const id = UploadService.idFor('New.zip', file.length, 'u2', target);
    await fsp.mkdir(path.join(rig.gamesDir, '_old', target, stamp), { recursive: true });
    await fsp.writeFile(path.join(rig.gamesDir, '_old', target, stamp, 'index.html'), 'old');
    await fsp.writeFile(path.join(rig.dir, `${id}.archive`), file);
    await fsp.writeFile(path.join(rig.dir, `${id}.json`), JSON.stringify({ id, name: 'New.zip', size: file.length, state: 'processing', target, backup: path.join(target, stamp) }));
    return id;
  };
  // G: прежняя версия уже в _old, а новой в папке игры ещё нет
  const g = await put('G', '2026-09-28-10-00-00');
  // H: новая уже на месте, а записать это не успели — второй раз не меняем
  const h = await put('H', '2026-09-28-10-00-01');
  await fsp.mkdir(path.join(rig.gamesDir, 'H'));
  await fsp.writeFile(path.join(rig.gamesDir, 'H', 'index.html'), 'already new');
  rig.restart();
  await rig.svc.recover();
  await Promise.all([...rig.svc.jobs.values()]);
  assert.deepStrictEqual([(await rig.status(g)).state, (await rig.status(h)).state], ['done', 'done']);
  assert.strictEqual(await fsp.readFile(path.join(rig.gamesDir, 'G', 'index.html'), 'utf8'), 'game');
  assert.strictEqual(await fsp.readFile(path.join(rig.gamesDir, 'H', 'index.html'), 'utf8'), 'already new');
  assert.strictEqual(await fsp.readFile(path.join(rig.gamesDir, '_old', 'G', '2026-09-28-10-00-00', 'index.html'), 'utf8'), 'old');
  assert.deepStrictEqual(rig.added, []);
});

test('загрузка: имя папки — буквы любого алфавита, не длиннее 200 байт, без букв — game_…', async (t) => {
  const crypto = require('crypto');
  const rig = await uploadRig(t);
  const file = crypto.randomBytes(1024);
  const folderOf = async (name) => {
    const { id } = (await rig.start({ name, size: file.length, fingerprint: crypto.randomBytes(4).toString('hex') })).body;
    await rig.chunk(id, 0, file);
    await rig.svc.jobs.get(id);
    return (await rig.status(id)).folder;
  };
  assert.strictEqual(await folderOf('星降る宿.zip'), '星降る宿');
  assert.strictEqual(await folderOf('Ведьма: v1.2.7z'), 'Ведьма_ v1.2');
  const long = await folderOf(`${'呪い'.repeat(60)}.rar`);
  assert.ok(Buffer.byteLength(long) <= 200 && long.startsWith('呪い呪い'), `${Buffer.byteLength(long)} байт`);
  assert.match(await folderOf('!!!.zip'), /^game_\d+$/);
});

test('время игры — и из моментов: только вперёд и не чаще раза в минуту игры', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec('CREATE TABLE games (id TEXT PRIMARY KEY, playtime INTEGER, progress TEXT)');
  await db.run("INSERT INTO games (id, playtime) VALUES ('G', 0)");
  const prev = dbService.db;
  dbService.db = db;
  const { redisClient } = require('./src/utils/cache.js');
  const del = t.mock.method(redisClient, 'del', async () => 1);
  t.after(async () => { dbService.db = prev; await db.close(); });
  const { notePlaytime } = require('./src/utils/saveprogress.js');
  const playtime = async () => (await db.get("SELECT playtime FROM games WHERE id = 'G'")).playtime;
  await notePlaytime('G', 3600.7);
  assert.strictEqual(await playtime(), 3600);
  const calls = del.mock.callCount();
  await notePlaytime('G', 3630);
  assert.strictEqual(await playtime(), 3600, 'меньше минуты — не пишем');
  assert.strictEqual(del.mock.callCount(), calls, 'и список игр не сбрасываем');
  await notePlaytime('G', 1200);
  assert.strictEqual(await playtime(), 3600, 'назад — нет');
  await notePlaytime('G', 'x');
  await notePlaytime('G', -5);
  await notePlaytime('G', 7200);
  assert.strictEqual(await playtime(), 7200);
  // Испорченное время (1e999 в JSON — Infinity) не остаётся навсегда: выше 10 000 ч не верим
  await notePlaytime('G', JSON.parse('1e999'));
  assert.strictEqual(await playtime(), 7200);
  await notePlaytime('G', 1e12);
  assert.strictEqual(await playtime(), 10000 * 3600);
});

test('новая версия в базе: название и своя версия — из новой версии (название, вписанное руками, не трогаем); пропавшая обложка — заново; остальное как было', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, cover TEXT, my_version TEXT, text_lang TEXT, playtime INTEGER, description TEXT, meta_locked TEXT DEFAULT '[]')`);
  const add = (...values) => db.run('INSERT INTO games (id, title, cover, my_version, text_lang, playtime, description) VALUES (?, ?, ?, ?, ?, ?, ?)', values);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'refresh-'));
  const prev = { db: dbService.db, dir: dbService.GAMES_DIR };
  dbService.db = db;
  dbService.GAMES_DIR = root;
  const { redisClient } = require('./src/utils/cache.js');
  t.mock.method(redisClient, 'del', async () => 1);
  t.mock.method(dbService, 'fillTextLang', async () => {});
  t.after(async () => {
    dbService.db = prev.db;
    dbService.GAMES_DIR = prev.dir;
    await db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  // A: версия в имени архива; обложкой был титульный экран, которого в новой версии нет
  await fsp.mkdir(path.join(root, 'A', 'img', 'titles1'), { recursive: true });
  await fsp.writeFile(path.join(root, 'A', 'img', 'titles1', 'New.png'), 'png');
  await add('A', 'Game A', 'A/img/titles1/Old.png', '1.3', '{"main":"en"}', 500, 'desc');
  assert.deepStrictEqual(await dbService.refreshGame('A', path.join(root, 'A'), { archiveName: 'Game_A_v2.03.zip' }), { version: '2.03' });
  assert.deepStrictEqual(await db.get('SELECT * FROM games WHERE id = ?', 'A'),
    { id: 'A', title: 'Game A', cover: 'A/img/titles1/New.png', my_version: '2.03', text_lang: null, playtime: 500, description: 'desc', meta_locked: '[]' },
    'названия в новой версии нет — прежнее остаётся');

  // B: в имени архива версии нет — берём из названия в System.json; обложка из _media остаётся
  await fsp.mkdir(path.join(root, 'B', 'data'), { recursive: true });
  await fsp.writeFile(path.join(root, 'B', 'data', 'System.json'), JSON.stringify({ gameTitle: 'Game B Ver1.10' }));
  await add('B', 'Game B Ver1.0', '_media/B/cover-1.jpg', '', null, 0, '');
  await dbService.refreshGame('B', path.join(root, 'B'), { archiveName: 'GameB.zip' });
  assert.deepStrictEqual(await db.get('SELECT title, cover, my_version FROM games WHERE id = ?', 'B'), { title: 'Game B Ver1.10', cover: '_media/B/cover-1.jpg', my_version: '1.10' });
  // Архив скачан «Загрузить», в имени версии нет — заданная версия главнее названия в System.json (его забывают обновить)
  await dbService.refreshGame('B', path.join(root, 'B'), { archiveName: 'GameB.zip', version: '1.2' });
  assert.strictEqual((await db.get('SELECT my_version FROM games WHERE id = ?', 'B')).my_version, '1.2');

  // D: название вписано руками — новая версия его не меняет
  await fsp.mkdir(path.join(root, 'D', 'data'), { recursive: true });
  await fsp.writeFile(path.join(root, 'D', 'data', 'System.json'), JSON.stringify({ gameTitle: 'Game D v2' }));
  await add('D', 'Моё название', '', '', null, 0, '');
  await db.run(`UPDATE games SET meta_locked = '["title"]' WHERE id = 'D'`);
  await dbService.refreshGame('D', path.join(root, 'D'), { archiveName: 'GameD_v2.zip' });
  assert.strictEqual((await db.get('SELECT title FROM games WHERE id = ?', 'D')).title, 'Моё название');

  // C: версии нигде нет — своя версия прежняя (версию можно вписать руками)
  await fsp.mkdir(path.join(root, 'C'));
  await add('C', 'Game C', 'C/icon/icon.png', '1.0', null, 0, '');
  const backup = path.join(root, '_old', 'C', '2026-09-28-10-00-00');
  await fsp.mkdir(backup, { recursive: true });
  await dbService.refreshGame('C', path.join(root, 'C'), { archiveName: 'GameC.zip', backupDir: backup });
  assert.deepStrictEqual(await db.get('SELECT my_version, cover FROM games WHERE id = ?', 'C'), { my_version: '1.0', cover: null });

  // Рядом с прежней версией — какими были своя версия и обложка; повторный заход их не перезаписывает
  const saved = JSON.parse(await fsp.readFile(`${backup}.json`, 'utf8'));
  assert.deepStrictEqual(saved, { title: 'Game C', my_version: '1.0', cover: 'C/icon/icon.png' });
  await dbService.refreshGame('C', path.join(root, 'C'), { archiveName: 'GameC_v9.zip', backupDir: backup });
  assert.deepStrictEqual(JSON.parse(await fsp.readFile(`${backup}.json`, 'utf8')), saved);
  // «Вернуть прежнюю версию» возвращает и их — название тоже
  await db.run(`UPDATE games SET title = 'Game C 2.0' WHERE id = 'C'`);
  await dbService.restoreGame('C', saved);
  assert.deepStrictEqual(await db.get('SELECT title, my_version, cover, text_lang FROM games WHERE id = ?', 'C'), { title: 'Game C', my_version: '1.0', cover: 'C/icon/icon.png', text_lang: null });
});

test('загрузка: отмена обрывает идущий кусок и убирает архив; во время распаковки отменить нельзя', async (t) => {
  const crypto = require('crypto');
  const rig = await uploadRig(t);
  const file = crypto.randomBytes(512 * 1024);
  const { id } = (await rig.start({ name: 'C.zip', size: file.length, fingerprint: 'f6' })).body;
  rig.hang(id, 0, file, 64 * 1024);
  await rig.until(async () => (await rig.size(id)) === 64 * 1024, '64 КБ на диске');
  assert.deepStrictEqual((await rig.call('POST', `/cancel?id=${id}`)).body, { cancelled: true });
  assert.strictEqual(rig.svc.writing.size, 0);
  assert.deepStrictEqual(await fsp.readdir(rig.dir), [], 'недогруженное убрано сразу');
  assert.strictEqual((await rig.call('GET', `/status?id=${id}`)).status, 404);

  let unblock;
  rig.extract = () => new Promise((resolve) => { unblock = resolve; });
  const { id: id2 } = (await rig.start({ name: 'D.zip', size: file.length, fingerprint: 'f6' })).body;
  await rig.chunk(id2, 0, file);
  await rig.until(() => unblock, 'распаковка началась');
  assert.strictEqual((await rig.status(id2)).step, 'extract', 'что делает распаковка — видно в состоянии');
  const refused = await rig.call('POST', `/cancel?id=${id2}`);
  assert.deepStrictEqual([refused.status, refused.body.state], [409, 'processing']);
  unblock();
  await rig.svc.jobs.get(id2);
  assert.match((await rig.status(id2)).error, /нет игры/, 'распаковка шла своим чередом');
});

test('загрузка: непонятные запросы — отказ, на диск ничего', async (t) => {
  const rig = await uploadRig(t);
  const statuses = [];
  for (const json of [
    { name: 'game.exe', size: 10, fingerprint: 'a' },
    { name: '../x.zip', size: 10, fingerprint: 'a' },
    { name: 'x.zip', size: -1, fingerprint: 'a' },
    { name: 'x.zip', size: 1.5, fingerprint: 'a' },
    { name: 'x.zip', size: 10, fingerprint: '' },
    { name: 'x.zip', size: 10, fingerprint: 'A/B' },
  ]) statuses.push((await rig.start(json)).status);
  assert.deepStrictEqual(statuses, [400, 400, 400, 400, 400, 400]);
  assert.strictEqual((await rig.chunk('../../etc', 0, Buffer.from('x'))).status, 400);
  assert.strictEqual((await rig.chunk('0'.repeat(32), 0, Buffer.from('x'))).status, 404);
  const { id } = (await rig.start({ name: 'x.zip', size: 10, fingerprint: 'a' })).body;
  assert.strictEqual((await rig.call('POST', `/chunk?id=${id}`, { body: Buffer.from('x') })).status, 400, 'без места в файле');
  assert.strictEqual((await rig.call('POST', `/chunk?id=${id}&offset=-5`, { body: Buffer.from('x') })).status, 400);
  assert.strictEqual((await rig.call('GET', '/status?id=nope')).status, 400);
  assert.strictEqual(await rig.size(id), 0);
});

test('загрузка: журнал страницы — одной строкой в журнал сервера, без переводов строк', async (t) => {
  const rig = await uploadRig(t);
  const logged = [];
  t.mock.method(console, 'log', (...args) => { logged.push(args.join(' ')); });
  const beacon = JSON.stringify({ name: 'G.zip', why: 'кусок молчит', ua: 'iPhone OS 26', standalone: true, lines: ['0.1 начало', '0.4 → кусок 0.0–16.0 МБ (xhr)\nлишнее'] });
  const r = await rig.call('POST', '/trace', { body: Buffer.from(beacon), type: 'text/plain;charset=UTF-8' });
  t.mock.restoreAll();
  assert.strictEqual(r.status, 204);
  assert.deepStrictEqual(logged, ['[Upload] журнал «G.zip» (кусок молчит) с 127.0.0.1, iPhone OS 26, веб-приложение: 0.1 начало | 0.4 → кусок 0.0–16.0 МБ (xhr) лишнее']);
});

test('7-Zip: разбор списка и понятные причины отказа', () => {
  const { parseListing, explain7z } = require('./src/services/uploads.js');
  const listing = 'Path = g\nFolder = +\nSize = 0\nAttributes = D drwxr-xr-x\nEncrypted = -\n\n'
    + 'Path = g/www/index.html\nFolder = -\nSize = 3\nAttributes =  -rw-r--r--\nEncrypted = +\n';
  assert.deepStrictEqual(parseListing(listing), [
    { path: 'g', size: 0, encrypted: false },
    { path: 'g/www/index.html', size: 3, encrypted: true },
  ]);
  assert.match(explain7z('ERROR: e.7z Cannot open encrypted archive. Wrong password?', 2), /под паролем/);
  assert.match(explain7z('Open ERROR: Cannot open the file as [zip] archive\nERRORS: Is not archive', 2), /не открывается как архив/);
  assert.match(explain7z('ERROR: CRC Failed : g/www/a.bin', 2), /повреждён/);
  assert.match(explain7z('ERROR: Dangerous link path was ignored : g/www/up : ../../tmp', 2), /ссылка/);
  assert.match(explain7z('ERROR: something odd', 7), /7-Zip не справился: ERROR: something odd/);
});

test('резервная копия: в базе копии нет ключа входа и учётной записи — даже в свободных страницах файла', async (t) => {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { stripSecrets } = require('./src/routes/backup.js');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'library.db');
  const secret = 'f00d'.repeat(32);
  const db = await open({ filename: file, driver: sqlite3.Database });
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE games (id TEXT PRIMARY KEY, playtime INTEGER)');
  for (const [key, value] of [['session_secret', secret], ['admin_user', 'owner'], ['admin_pass', '$2b$10$hashhashhash'], ['scraper_api_key', 'scraperkey0123456789'], ['known_langs', '["en","ru"]']]) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }
  await db.run("INSERT INTO games (id, playtime) VALUES ('G', 600)");
  await db.close();

  await stripSecrets(file);

  const bytes = await fsp.readFile(file);
  assert.strictEqual(bytes.includes(secret), false);
  assert.strictEqual(bytes.includes('$2b$10$hashhashhash'), false);
  assert.strictEqual(bytes.includes('scraperkey0123456789'), false);
  const copy = await open({ filename: file, driver: sqlite3.Database });
  t.after(() => copy.close());
  assert.deepStrictEqual(await copy.all('SELECT key, value FROM settings'), [{ key: 'known_langs', value: '["en","ru"]' }]);
  assert.deepStrictEqual(await copy.all('SELECT id, playtime FROM games'), [{ id: 'G', playtime: 600 }]);
});

// --- История сейвов (utils/savestore.js) ---
const savesTmp = async (t) => {
  const { createSaveStore } = require('./src/utils/savestore.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'saves-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = createSaveStore(root);
  const hist = async (id, key) => (await fsp.readdir(path.join(root, '.history', id, encodeURIComponent(key))).catch(() => [])).sort();
  const cur = (id, key) => fsp.readFile(path.join(root, id, `${encodeURIComponent(key)}.json`), 'utf8');
  return { root, store, hist, cur };
};

test('сейвы: перезапись слота кладёт прежний в историю, время файла — время сейва', async (t) => {
  const { root, store, hist, cur } = await savesTmp(t);
  const t0 = Date.now() - 3600e3;
  assert.strictEqual(await store.write('Game', 'RPG File1', 'A', t0), 'saved');
  assert.strictEqual(Math.round((await fsp.stat(path.join(root, 'Game', 'RPG%20File1.json'))).mtimeMs), t0);
  assert.strictEqual(await store.write('Game', 'RPG File1', 'B', t0 + 1000), 'saved');
  assert.strictEqual(await cur('Game', 'RPG File1'), 'B');
  assert.deepStrictEqual(await hist('Game', 'RPG File1'), [`${t0}-saved.json`]);
  // Тот же сейв ещё раз — ни записи, ни версии
  assert.strictEqual(await store.write('Game', 'RPG File1', 'B', t0 + 2000), 'same');
  assert.strictEqual((await hist('Game', 'RPG File1')).length, 1);
  // Не слот (настройки, копия слота перед записью) — без истории
  await store.write('Game', 'RPG Config', 'c1', t0);
  await store.write('Game', 'RPG Config', 'c2', t0 + 1);
  await store.write('Game', 'RPG File1bak', 'b1', t0);
  await store.write('Game', 'RPG File1bak', 'b2', t0 + 1);
  assert.deepStrictEqual(await fsp.readdir(path.join(root, '.history', 'Game')), ['RPG%20File1']);
});

test('сейвы: сейв старше того, что на сервере, не затирает новый — ложится в историю', async (t) => {
  const { store, hist, cur } = await savesTmp(t);
  const t0 = Date.now() - 3600e3;
  await store.write('Game', 'MZ_file1', 'PC, 11:00', t0 + 60e3);
  // Телефон играл без сети и сохранился раньше, чем компьютер
  assert.strictEqual(await store.write('Game', 'MZ_file1', 'phone, 10:00', t0), 'older');
  assert.strictEqual(await cur('Game', 'MZ_file1'), 'PC, 11:00');
  assert.deepStrictEqual(await hist('Game', 'MZ_file1'), [`${t0}-conflict.json`]);
  // Время из будущего (часы устройства спешат) считается нынешним: следующий сейв с верными часами не проигрывает
  await store.write('Game', 'MZ_file2', 'fast clock', Date.now() + 3600e3);
  assert.strictEqual(await store.write('Game', 'MZ_file2', 'right clock', Date.now() + 5), 'saved');
});

test('сейвы: удалённый в игре слот уходит в историю, возврат версии меняет местами', async (t) => {
  const { root, store, hist, cur } = await savesTmp(t);
  const t0 = Date.now() - 3600e3;
  await store.write('Game', 'RPG File2', 'old', t0);
  await store.write('Game', 'RPG File2', 'new', t0 + 1000);
  const [version] = await hist('Game', 'RPG File2');
  await store.restore('Game', 'RPG File2', version);
  assert.strictEqual(await cur('Game', 'RPG File2'), 'old');
  assert.deepStrictEqual(await hist('Game', 'RPG File2'), [`${t0 + 1000}-restore.json`]);
  await assert.rejects(store.restore('Game', 'RPG File2', '../../etc/passwd'), /Такой версии нет/);
  await assert.rejects(store.restore('Game', 'RPG File2', '123-saved.json'), /Такой версии нет/);

  await store.remove('Game', 'RPG File2');
  await assert.rejects(fsp.access(path.join(root, 'Game', 'RPG%20File2.json')));
  assert.strictEqual((await hist('Game', 'RPG File2')).filter((n) => n.endsWith('-deleted.json')).length, 1);
  await store.write('Game', 'RPG Global', 'g', t0);
  await store.remove('Game', 'RPG Global');
  await assert.rejects(fsp.access(path.join(root, 'Game', 'RPG%20Global.json')));

  const slots = await store.history('Game');
  assert.deepStrictEqual(slots.map((s) => [s.key, !!s.current, s.versions.map((v) => v.reason)]), [['RPG File2', false, ['deleted', 'restore']]]);
});

test('сейвы: частые сохранения прореживаются — пять последних, дальше одна на 10 минут, всего не больше 30', async (t) => {
  const { store, hist } = await savesTmp(t);
  // Сейв каждые 2 минуты, три часа подряд
  const start = Math.floor((Date.now() - 4 * 3600e3) / 600e3) * 600e3;
  for (let i = 0; i <= 90; i++) await store.write('Game', 'RPG File1', `v${i}`, start + i * 120e3);
  const names = await hist('Game', 'RPG File1');
  const times = names.map((n) => Number(n.split('-')[0])).sort((a, b) => a - b);
  // v0…v84 — 17 отрезков по 10 минут, v85…v89 — все пять
  assert.strictEqual(names.length, 5 + 17);
  // Пять последних подряд: v85…v89
  assert.deepStrictEqual(times.slice(-5), [85, 86, 87, 88, 89].map((i) => start + i * 120e3));
  // Старше — не больше одной на 10 минут
  const buckets = times.slice(0, -5).map((x) => Math.floor(x / 600e3));
  assert.strictEqual(new Set(buckets).size, buckets.length);
  // Версии не saved не прореживаются, но общий предел — 30
  for (let i = 0; i < 40; i++) await store.write('Game', 'RPG File3', `c${i}`, Date.now() - 1e6 + i);
  for (let i = 0; i < 40; i++) await store.write('Game', 'RPG File3', `old${i}`, Date.now() - 2e6 + i);
  assert.strictEqual((await hist('Game', 'RPG File3')).length, 30);
});

test('сейвы: папки под прежними именами переезжают к своим играм, спорные остаются', async (t) => {
  const { root, store, hist, cur } = await savesTmp(t);
  const put = async (dir, key, value, at) => {
    await fsp.mkdir(path.join(root, dir), { recursive: true });
    const f = path.join(root, dir, `${encodeURIComponent(key)}.json`);
    await fsp.writeFile(f, value);
    await fsp.utimes(f, new Date(at), new Date(at));
  };
  const t0 = Date.now() - 3600e3;
  // Японское имя — одни подчёркивания; пробелы — «_»; имя в %-кодировке
  await put('____', 'MZ_file1', 'jp', t0);
  await put('Moonlit_Library', 'MZ_file1', 'older', t0);
  await put('Moonlit Library', 'MZ_file1', 'newer', t0 + 1000);
  await put("Lantern's%20Rest", 'RPG Config', 'cfg', t0);
  // Подходит двум играм — не трогаем
  await put('___', 'MZ_file1', 'two', t0);
  // Своё имя другой игры — не трогаем
  await put('Solo_Game', 'MZ_file1', 'solo', t0);

  const moved = await store.migrate(['星降る宿', 'Moonlit Library', "Lantern's Rest", 'リナ', 'りな', 'Solo_Game', 'Solo Game']);
  assert.strictEqual(moved.length, 3);
  assert.strictEqual(await cur('星降る宿', 'MZ_file1'), 'jp');
  assert.strictEqual(await cur('Moonlit Library', 'MZ_file1'), 'newer');
  assert.deepStrictEqual(await hist('Moonlit Library', 'MZ_file1'), [`${t0}-merge.json`]);
  assert.strictEqual(await cur("Lantern's Rest", 'RPG Config'), 'cfg');
  assert.deepStrictEqual((await fsp.readdir(root)).sort(), ['.history', 'Moonlit Library', "Lantern's Rest", 'Solo_Game', '___', '星降る宿'].sort());
  assert.deepStrictEqual(await store.migrate(['星降る宿', 'Moonlit Library']), []);
});

test('сейвы: импорт из архива заменяет слоты, прежние — в историю', async (t) => {
  const { store, hist, cur } = await savesTmp(t);
  await store.write('Game', 'RPG File1', 'mine', Date.now() - 5000);
  await store.importSaves('Game', [{ key: 'RPG File1', value: 'imported' }, { key: 'RPG File2', value: 'new slot' }]);
  assert.strictEqual(await cur('Game', 'RPG File1'), 'imported');
  assert.strictEqual(await cur('Game', 'RPG File2'), 'new slot');
  assert.strictEqual((await hist('Game', 'RPG File1'))[0].endsWith('-import.json'), true);
});

// --- Патчи и моды поверх игры (services/uploads.js) ---
test('патч: место для файлов — по совпадениям с игрой, без учёта регистра; программа-патчер — понятный отказ', () => {
  const { planPatch } = require('./src/services/uploads.js');
  const game = ['www/index.html', 'www/data/Map001.json', 'www/data/System.json', 'www/img/pictures/Title.png', 'www/js/plugins.js', 'Game.exe'];
  const r = planPatch(['English Patch/www/data/map001.json', 'English Patch/www/js/plugins/Walk.js', 'English Patch/Readme.txt'], game);
  assert.deepStrictEqual(r.plan, [
    { from: 'English Patch/www/data/map001.json', to: 'www/data/Map001.json', replace: true },
    { from: 'English Patch/www/js/plugins/Walk.js', to: 'www/js/plugins/Walk.js', replace: false },
  ]);
  assert.deepStrictEqual([r.replaced, r.added, r.skipped], [1, 1, 1]);
  // Патч без www — к www игры
  assert.strictEqual(planPatch(['img/pictures/Title.png'], game).plan[0].to, 'www/img/pictures/Title.png');
  // Мод только добавляет файлы — туда, где папки движка
  assert.strictEqual(planPatch(['Mod/js/plugins/Cheat.js'], game).plan[0].to, 'www/js/plugins/Cheat.js');
  assert.throws(() => planPatch(['patcher/Patch.exe', 'patcher/diff.xdelta'], game), /программа-патчер/);
  assert.throws(() => planPatch(['something/else.bin'], game), /Не понял, куда класть/);
});

test('патч: ложится поверх копии игры, прежний вид — в _old, общие файлы не занимают места дважды', async (t) => {
  const rig = await uploadRig(t);
  const g = path.join(rig.gamesDir, 'G', 'www');
  await fsp.mkdir(path.join(g, 'data'), { recursive: true });
  await fsp.mkdir(path.join(g, 'img'), { recursive: true });
  await fsp.writeFile(path.join(g, 'index.html'), 'game');
  await fsp.writeFile(path.join(g, 'data', 'Map001.json'), 'jp');
  await fsp.writeFile(path.join(g, 'img', 'a.png'), 'picture');
  const opts = [];
  rig.svc.refreshGame = async (folder, dest, o) => { opts.push([folder, o.patch, o.archiveName]); return {}; };
  const finished = [];
  rig.svc.onFinished = (info) => { finished.push(info); };
  rig.svc.unattendedMs = 0;
  rig.entries = [{ path: 'Patch/www/data/Map001.json', size: 2, encrypted: false }];
  rig.extract = async (out) => {
    await fsp.mkdir(path.join(out, 'Patch', 'www', 'data'), { recursive: true });
    await fsp.mkdir(path.join(out, 'Patch', 'www', 'js', 'plugins'), { recursive: true });
    await fsp.writeFile(path.join(out, 'Patch', 'www', 'data', 'Map001.json'), 'en');
    await fsp.writeFile(path.join(out, 'Patch', 'www', 'js', 'plugins', 'Walk.js'), 'walk');
    await fsp.writeFile(path.join(out, 'Patch', 'README.txt'), 'read me');
  };
  const file = Buffer.from('patch-archive');
  // Без игры патч не начинается
  assert.strictEqual((await rig.start({ name: 'EnglishPatch.zip', size: file.length, fingerprint: 'p1', mode: 'patch' })).status, 400);
  const { body } = await rig.start({ name: 'EnglishPatch.zip', size: file.length, fingerprint: 'p1', target: 'G', mode: 'patch' });
  await rig.chunk(body.id, 0, file);
  await rig.until(async () => (await rig.status(body.id)).state === 'done', 'патч установлен');
  const st = await rig.status(body.id);
  assert.deepStrictEqual(st.patch, { replaced: 1, added: 1, skipped: 1 });
  assert.strictEqual(await fsp.readFile(path.join(g, 'data', 'Map001.json'), 'utf8'), 'en');
  assert.strictEqual(await fsp.readFile(path.join(g, 'js', 'plugins', 'Walk.js'), 'utf8'), 'walk');
  await assert.rejects(fsp.access(path.join(rig.gamesDir, 'G', 'README.txt')));
  const [stamp] = (await fsp.readdir(path.join(rig.gamesDir, '_old', 'G'))).filter((n) => !n.endsWith('.json'));
  const old = path.join(rig.gamesDir, '_old', 'G', stamp, 'www');
  assert.strictEqual(await fsp.readFile(path.join(old, 'data', 'Map001.json'), 'utf8'), 'jp');
  await assert.rejects(fsp.access(path.join(old, 'js')));
  // Неизменённый файл — один на обе версии
  assert.strictEqual((await fsp.stat(path.join(g, 'img', 'a.png'))).nlink, 2);
  assert.deepStrictEqual(opts, [['G', true, 'EnglishPatch.zip']]);
  await rig.until(async () => finished.length === 1, 'сообщение о загрузке');
  assert.deepStrictEqual([finished[0].state, finished[0].mode, finished[0].target, finished[0].unattended], ['done', 'patch', 'G', true]);
});

// --- Telegram (services/telegram.js) ---
async function telegramRig(t, { chat = { id: 42, name: 'Me' } } = {}) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { TelegramService } = require('./src/services/telegram.js');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, status TEXT, rating INTEGER, link TEXT, my_version TEXT, meta_locked TEXT, lastPlayed INTEGER, playtime INTEGER, size INTEGER); CREATE TABLE wishlist (key TEXT PRIMARY KEY)");
  const tg = new TelegramService();
  tg.token = 'TEST-TOKEN';
  tg.envChat = '';
  tg.gapMs = 0;
  const calls = [];
  tg.fetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.name}>`])) : JSON.parse(init.body);
    calls.push({ method, body });
    const result = tg.reply?.(method, body) ?? (method === 'getMe' ? { username: 'my_rpg_bot' } : true);
    return { status: 200, json: async () => ({ ok: true, result }) };
  };
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tg-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  tg.setDependencies({ db: { get: () => db }, tmpDir: root, gamesDir: root, savesDir: path.join(root, '_saves'), buildBackup: async (dir) => {
    const file = path.join(dir, 'b.zip'); await fsp.writeFile(file, 'zip'); return { file, name: 'b.zip', size: 3, games: 2, saves: 1 };
  } });
  if (chat) await tg.setJson('telegram_chat', chat);
  return { tg, db, calls, sent: () => calls.filter((c) => c.method.startsWith('send')) };
}

test('telegram: не больше 10 сообщений в час, проблемы — всегда и со звуком, одна и та же — раз в сутки', async (t) => {
  const { tg, sent } = await telegramRig(t);
  for (let i = 0; i < 12; i++) await tg.deliver('uploads', `G${i}`);
  assert.strictEqual(sent().length, 10);
  assert.strictEqual(await tg.problemOnce('disk', 'мало места'), true);
  assert.strictEqual(await tg.problemOnce('disk', 'мало места'), false);
  assert.strictEqual(sent().length, 11);
  assert.strictEqual(sent()[10].body.disable_notification, false);
});

test('telegram: загрузка — только если за ней никто не следил', async (t) => {
  const { tg, db, sent } = await telegramRig(t);
  await db.run("INSERT INTO games (id, title, link, meta_locked) VALUES ('G', 'Great Game', '', '[]')");
  await tg.uploadFinished({ name: 'g.zip', state: 'done', folder: 'G', unattended: false });
  assert.strictEqual(sent().length, 0);
  await tg.uploadFinished({ name: 'g.zip', state: 'done', folder: 'G', unattended: true });
  await tg.uploadFinished({ name: 'x.rar', state: 'password', unattended: true });
  assert.match(sent()[0].body.text, /Игра добавлена: <b>Great Game<\/b>/);
  assert.strictEqual(sent()[1].body.disable_notification, false);
});

test('telegram: копия — раз в сутки и только если что-то изменилось; кнопка шлёт сразу', async (t) => {
  const { tg, db, sent } = await telegramRig(t);
  await db.run("INSERT INTO games (id, title, playtime) VALUES ('G', 'G', 10)");
  assert.deepStrictEqual(await tg.checkBackup(), { sent: true });
  assert.strictEqual(sent()[0].method, 'sendDocument');
  assert.strictEqual(sent()[0].body.document, '<file b.zip>');
  assert.deepStrictEqual(await tg.checkBackup(), { sent: false });
  await db.run("UPDATE games SET playtime = 20");
  // Изменилось, но суток не прошло
  assert.deepStrictEqual(await tg.checkBackup(), { sent: false });
  await tg.setJson('telegram_backup', { ...(await tg.getJson('telegram_backup')), at: Date.now() - 21 * 3600e3 });
  assert.deepStrictEqual(await tg.checkBackup(), { sent: true });
  assert.deepStrictEqual(await tg.checkBackup({ force: true }), { sent: true });
  assert.strictEqual(sent().length, 3);
});

test('telegram: привязка — по коду из ссылки, чужие сообщения не считаются', async (t) => {
  const { tg, calls, sent } = await telegramRig(t, { chat: null });
  const status = await tg.startLink({ lang: 'ru', library: 'http://192.168.1.10/' });
  assert.match(status.pending.url, /^https:\/\/t\.me\/my_rpg_bot\?start=\d{6}$/);
  const code = status.pending.code;
  let round = 0;
  tg.reply = (method) => {
    if (method !== 'getUpdates') return undefined;
    round++;
    if (round === 1) return [{ update_id: 1, message: { chat: { id: 7, type: 'private', first_name: 'Stranger' }, text: '/start 000000' } }];
    return [{ update_id: 2, message: { chat: { id: 9, type: 'private', first_name: 'Owner', username: 'own' }, text: `/start ${code}` } }];
  };
  await tg.poll();
  assert.deepStrictEqual(await tg.chat(), { id: 9, name: 'Owner (@own)' });
  // Второй опрос — уже после первого сообщения: оно подтверждено и больше не придёт
  assert.strictEqual(calls.filter((c) => c.method === 'getUpdates').at(-1).body.offset, 2);
  assert.match(sent()[0].body.text, /Библиотека подключена/);
  assert.strictEqual((await tg.status()).pending, null);
});

test('telegram: пульт — ссылка на файл из своего чата качается, чужой чат не слушаем; встало — сказать', async (t) => {
  const { tg, calls, sent } = await telegramRig(t);
  const asked = [];
  tg.download = async (what) => {
    asked.push(what);
    if (what.url?.includes('example.com')) throw Object.assign(new Error('не тот сайт'), { reason: 'site' });
    return { title: 'Game' };
  };
  let round = 0;
  tg.reply = (method) => {
    if (method !== 'getUpdates') return undefined;
    round++;
    if (round > 1) { tg.download = null; return []; }
    return [
      { update_id: 10, message: { chat: { id: 7, type: 'private' }, text: 'https://mega.nz/file/x#k' } },
      { update_id: 11, message: { chat: { id: 42, type: 'private' }, text: 'глянь https://mega.nz/file/x#k и https://example.com/post/1' } },
      { update_id: 12, message: { chat: { id: 42, type: 'private' }, text: 'привет' } },
    ];
  };
  await tg.poll();
  assert.deepStrictEqual(asked, [{ url: 'https://mega.nz/file/x#k' }, { url: 'https://example.com/post/1' }], 'чужой чат не слушаем');
  const texts = sent().map((c) => c.body.text);
  assert.match(texts[0], /Качаю: <b>Game<\/b>/);
  assert.match(texts[1], /Качаю по ссылке на файл .* mega, gofile, pixeldrain/);
  assert.match(texts[2], /Пришлите ссылку на файл с игрой/);
  assert.strictEqual(await tg.getJson('telegram_offset'), 13, 'после перезапуска те же сообщения не придут');
  // Другой бот — его номера сообщений свои: прежний номер забываем
  tg.tokenChanged();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(await tg.getJson('telegram_offset', 'gone'), 'gone');
  assert.strictEqual(tg.offset, 0);
  // Сбор встал — бот так и говорит; капча — со звуком: её ждут 10 минут
  await tg.downloadStage({ stage: 'captcha', title: 'G', captcha: 'mega.nz' });
  await tg.downloadStage({ stage: 'error', title: 'G', error: 'volumes' });
  assert.match(sent().at(-2).body.text, /mega\.nz просит капчу/);
  assert.strictEqual(sent().at(-2).body.disable_notification, false);
  assert.match(sent().at(-1).body.text, /выложена частями/);
  for (const [error, text] of [['captcha', /капчу не решили/], ['stale', /сервер перезапускался/], ['empty', /не нашёл по ссылке/]]) {
    await tg.downloadStage({ stage: 'error', title: 'G', error });
    assert.match(sent().at(-1).body.text, text, error);
  }
  assert.ok(calls.every((c) => c.method !== 'answerCallbackQuery'), 'кнопок под сообщениями нет');
});

test('«Загрузить» по ссылке: файлообменник из списка, название и версия — из окна; чужие сайты и подделки адреса — нет', async (t) => {
  const downloads = require('./src/services/downloads.js');
  const myjd = require('./src/services/myjd.js');
  const sent = [];
  t.mock.method(myjd, 'send', async (...args) => { sent.push(args); return { started: true }; });
  // Страницы сайтов и подделки адреса — не ссылка на файл
  for (const url of ['https://store.steampowered.com/app/1', 'https://mega.nz.evil.test/file/x', 'https://evil.test/?u=https://mega.nz/file/x', 'javascript:alert(1)']) {
    await assert.rejects(downloads.startFrom({ url }, 'tg'), (e) => e.reason === 'site', url);
  }
  assert.strictEqual(sent.length, 0, 'в JDownloader ничего не ушло');
  // Ссылка на файл: только https, известный файлообменник, без логина и пароля в адресе; ключ — по хешу адреса
  // (у mega ключ шифрования после #), название — из окна игры, иначе из имени файла
  const mega = 'https://mega.nz/file/AbCd1234#KeyKeyKey';
  const started = await downloads.startUrl(mega, { title: 'Lantern Witch', version: 'V1.2', game: 'Own_Game' }, 'web');
  assert.deepStrictEqual([started.started, started.title, started.update, started.key.replace(/[0-9a-f]{12}$/, 'H')], [true, 'Lantern Witch', true, 'link:H']);
  assert.deepStrictEqual(sent.at(-1), [mega, 'Lantern Witch', started.key, { version: 'V1.2', target: 'Own_Game', via: 'web', passwords: [] }]);
  assert.strictEqual((await downloads.fromLink(mega)).key, started.key, 'та же ссылка — тот же ключ');
  assert.notStrictEqual((await downloads.fromLink('https://mega.nz/file/AbCd1234#Other')).key, started.key, 'ключ шифрования — часть ссылки');
  assert.strictEqual((await downloads.fromLink('https://pixeldrain.com/u/Lantern_Witch-v1.2.7z')).title, 'Lantern Witch v1.2', 'без названия — имя файла, без расширения');
  assert.strictEqual((await downloads.fromLink('https://gofile.io/')).title, 'gofile.io', 'нет и имени файла — хост');
  for (const url of ['https://gofile.io/d/abc123', 'https://pixeldrain.com/u/abc', 'https://drive.google.com/file/d/1/view', 'https://download.mediafire.com/x/y.zip',
    'https://workupload.com/file/a', 'https://datanodes.to/a/b', 'https://buzzheavier.com/a', 'https://bzzhr.to/a', 'https://mixdrop.ag/f/a', 'https://krakenfiles.com/view/a/file.html', 'https://files.fm/u/a']) {
    assert.ok((await downloads.fromLink(url)).key.startsWith('link:'), url);
  }
  for (const url of ['http://mega.nz/file/a#b', 'https://evil.test/file.zip', 'https://mega.nz.evil.test/file/a', 'https://evilmega.nz/file/a', 'https://user:pass@mega.nz/file/a',
    'https://mega.nz:8443/file/a', 'https://127.0.0.1/file.zip', 'https://evil.test/?u=https://mega.nz/file/a', 'ftp://mega.nz/a', 'mega.nz/file/a', '']) {
    await assert.rejects(downloads.startUrl(url, {}, 'tg'), (e) => e.reason === 'site', url);
  }
  // Название с угловыми скобками и версия с мусором — как у остальных загрузок
  assert.deepStrictEqual(await downloads.fromLink('https://gofile.io/d/abc', { title: '<b>Game</b>\n', version: 'v1.0 <x>' }).then((x) => [x.title, x.version, x.target]), ['bGame/b', 'v1.0 x', '']);
});

// --- Сервер игр (routes/play.js) ---
test('сервер игр: ключ подходит только к своей игре, сейвы — через ключ, запрет на чужие сайты — в заголовке', async (t) => {
  const http = require('http');
  const { createGameApp, gameKey, keyMatches } = require('./src/routes/play.js');
  const saved = [];
  const store = {
    list: async (id) => ({ 'RPG File1': { value: `save of ${id}`, updatedAt: 1 } }),
    write: async (id, key, value) => { saved.push([id, key, value]); return key === 'RPG File2' ? 'older' : 'saved'; },
    remove: async () => {},
    writeShot: async (id, key, jpg) => { shots.push([id, key, jpg[0]]); return key !== 'RPG Config'; },
  };
  const shots = [];
  let secret = 's1';
  const { createMarkStore } = require('./src/utils/marks.js');
  const marksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-'));
  t.after(() => fs.rmSync(marksDir, { recursive: true, force: true }));
  const marks = createMarkStore(marksDir);
  const journal = require('./src/utils/journal.js').createJournal(marksDir);
  const app = createGameApp({ secret: () => secret, store, marks, journal, publicDir: __dirname });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  // Не глобальный fetch: его подменяют другие тесты
  const fetch = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: (h) => res.headers[h] }, json: async () => JSON.parse(text), text: async () => text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const key = gameKey('s1', 'Game A');
  assert.strictEqual(keyMatches('s1', 'Game A', key), true);
  assert.strictEqual(keyMatches('s1', 'Game B', key), false);
  assert.strictEqual(keyMatches('s2', 'Game A', key), false);

  let r = await fetch(`${base}/saves/${key}/${encodeURIComponent('Game A')}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.deepStrictEqual(await r.json(), { 'RPG File1': { value: 'save of Game A', updatedAt: 1 } });
  assert.strictEqual((await fetch(`${base}/saves/${key}/${encodeURIComponent('Game B')}`)).status, 403);
  assert.strictEqual((await fetch(`${base}/saves/${key}/_saves`)).status, 403);
  r = await fetch(`${base}/saves/${key}/${encodeURIComponent('Game A')}/${encodeURIComponent('RPG File2')}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x', updatedAt: 5 }),
  });
  assert.deepStrictEqual(await r.json(), { success: true, kept: 'server' });
  assert.deepStrictEqual(saved, [['Game A', 'RPG File2', 'x']]);
  // Голый «%» в имени картинки (MV 1.6 раскодирует путь сам: «$Hero%(8).png») — не 400 до проверки ключа
  assert.strictEqual((await fetch(`${base}/g/${'0'.repeat(32)}/Game%20A/img/characters/$Hero%(8).png`)).status, 403);
  const { fixBarePercent } = require('./src/routes/play.js');
  const fixed = (url) => { const req = { url }; fixBarePercent(req, null, () => {}); return req.url; };
  assert.strictEqual(fixed('/g/k/G/img/$Hero%(8).png'), '/g/k/G/img/$Hero%25(8).png');
  assert.strictEqual(fixed('/g/k/G/img/%24Hero%25(8).png'), '/g/k/G/img/%24Hero%25(8).png', 'закодированное не трогаем');
  assert.strictEqual(fixed('/g/k/G/100%'), '/g/k/G/100%25');
  // Снимок экрана к слоту: только JPEG, только по ключу своей игры
  const shotUrl = (game, slot) => `${base}/saves/${key}/${encodeURIComponent(game)}/${encodeURIComponent(slot)}/shot`;
  const jpgShot = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  const postShot = (game, slot, thumb) => fetch(shotUrl(game, slot), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thumb }) });
  assert.strictEqual((await postShot('Game A', 'RPG File1', jpgShot)).status, 200);
  assert.deepStrictEqual(shots, [['Game A', 'RPG File1', 0xff]]);
  assert.strictEqual((await postShot('Game A', 'RPG File1', 'data:image/png;base64,iVBORw0KGgo=')).status, 400);
  assert.strictEqual((await postShot('Game B', 'RPG File1', jpgShot)).status, 403);
  // Моменты: новый — по ключу игры, список без самих сейвов, сейв момента, снимок; чужая игра — 403
  const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  const markUrl = (rest = '') => `${base}/marks/${key}/${encodeURIComponent('Game A')}${rest}`;
  r = await fetch(markUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Ванная', map: 'Дом', value: '{"s":1}', thumb: jpg }) });
  const { id: markId } = await r.json();
  assert.strictEqual(r.status, 200);
  r = await fetch(markUrl());
  assert.deepStrictEqual((await r.json()).map((m) => [m.id, m.label, m.thumb]), [[markId, 'Ванная', true]]);
  assert.deepStrictEqual(await (await fetch(markUrl(`/${markId}`))).json(), { value: '{"s":1}' });
  assert.strictEqual((await fetch(markUrl(`/${markId}/thumb`))).status, 200);
  assert.strictEqual((await fetch(markUrl('/nope00'))).status, 404);
  // Точка перемотки из игры и «Оставить» прямо там — она становится моментом
  r = await fetch(markUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'auto', why: 'battle', label: 'Гоблин', value: '{"s":2}', thumb: jpg }) });
  const { id: autoId } = await r.json();
  assert.strictEqual((await fetch(markUrl(`/${autoId}/keep`), { method: 'POST' })).status, 200);
  assert.strictEqual((await (await fetch(markUrl())).json()).find((m) => m.id === autoId).kind, 'mark');
  assert.strictEqual((await fetch(markUrl('/nope00/keep'), { method: 'POST' })).status, 404);
  // Ответ на выбор — к точке «перед выбором»
  r = await fetch(markUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'auto', why: 'choice', label: 'Пойдём?', value: '{"s":3}', thumb: jpg }) });
  const { id: choiceId } = await r.json();
  assert.strictEqual((await fetch(markUrl(`/${choiceId}/answer`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'Да' }) })).status, 200);
  assert.strictEqual((await (await fetch(markUrl())).json()).find((m) => m.id === choiceId).answer, 'Да');
  assert.strictEqual((await fetch(markUrl(`/${autoId}/answer`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"answer":"x"}' })).status, 404, 'у точки не «перед выбором» ответа нет');
  assert.strictEqual((await fetch(markUrl(`/${choiceId}/answer`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"cancel":true}' })).status, 200);
  const cancelled = (await (await fetch(markUrl())).json()).find((m) => m.id === choiceId);
  assert.deepStrictEqual([cancelled.cancel, cancelled.answer], [true, undefined], 'отказ — отметкой, прежний ответ снят');
  // «Путь»: запись по ключу своей игры, чужая — 403
  const journalUrl = (game, rest = '') => `${base}/journal/${key}/${encodeURIComponent(game)}${rest}`;
  r = await fetch(journalUrl('Game A'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'map', label: 'Дом', mapId: 2 }) });
  assert.strictEqual(r.status, 200);
  const { id: entryId } = await r.json();
  assert.strictEqual((await fetch(journalUrl('Game A', `/${entryId}/thumb`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thumb: jpg }) })).status, 200);
  assert.strictEqual((await fetch(journalUrl('Game B'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kind":"map","mapId":1}' })).status, 403);
  assert.strictEqual((await fetch(journalUrl('Game A'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kind":"nope"}' })).status, 400);
  assert.strictEqual((await fetch(journalUrl('Game A', '/room'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"total":10,"open":4,"rooms":["Room"]}' })).status, 200);
  assert.strictEqual((await fetch(journalUrl('Game A', '/room'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"total":1,"open":4}' })).status, 400);
  assert.strictEqual((await fetch(journalUrl('Game B', '/room'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"total":1,"open":0}' })).status, 403);
  assert.strictEqual((await fetch(markUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  assert.strictEqual((await fetch(`${base}/marks/${key}/${encodeURIComponent('Game B')}`)).status, 403);
  assert.strictEqual((await fetch(`${base}/marks/${key}/${encodeURIComponent('Game B')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x' }) })).status, 403);
  assert.strictEqual((await fetch(`${base}/marks/${key}/..%2F..%2Fx`)).status, 403);
  // Нет API библиотеки
  assert.strictEqual((await fetch(`${base}/api/games`)).status, 404);
  // Выход из библиотеки меняет ключ сессии — старый ключ игры больше не подходит
  secret = 's2';
  assert.strictEqual((await fetch(`${base}/saves/${key}/${encodeURIComponent('Game A')}`)).status, 403);
  // Отчёт о заблокированном — в журнал
  const logged = [];
  t.mock.method(console, 'log', (...a) => { logged.push(a.join(' ')); });
  r = await fetch(`${base}/csp-report`, { method: 'POST', headers: { 'content-type': 'application/csp-report' },
    body: JSON.stringify({ 'csp-report': { 'document-uri': `${base}/g/${key}/Game%20A/www/`, 'violated-directive': 'connect-src', 'blocked-uri': 'https://tracker.test' } }) });
  t.mock.restoreAll();
  assert.strictEqual(r.status, 204);
  assert.deepStrictEqual(logged, ['[CSP] Game A: заблокировано connect-src https://tracker.test']);
});

test('снимок экрана к сейву: только к слоту и только JPEG; к вернутой из истории версии и к сейву из архива — уже нет', async (t) => {
  const { createSaveStore } = require('./src/utils/savestore.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createSaveStore(root);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  // Часы устройства отстают на час: время и у слота, и у снимка — с устройства, снимок свой
  const behind = Date.now() - 3600e3;
  await store.write('G', 'RPG File1', '{"a":0}', behind);
  assert.ok(await store.writeShot('G', 'RPG File1', jpg, behind));
  assert.ok(await store.shotOf('G', 'RPG File1'), 'отстающие часы — не помеха');
  // Слот перезаписан без снимка (из очереди без сети) — прежний снимок уже не его
  await store.write('G', 'RPG File1', '{"a":1}', Date.now());
  assert.strictEqual(await store.shotOf('G', 'RPG File1'), null, 'чужой кадр не показываем');
  assert.ok(await store.writeShot('G', 'RPG File1', jpg));
  assert.ok((await store.shotOf('G', 'RPG File1')).file.endsWith('.jpg'));
  assert.strictEqual(await store.writeShot('G', 'RPG Config', jpg), false, 'не слот');
  assert.strictEqual(await store.writeShot('G', 'RPG File1', Buffer.from('PNG')), false, 'не JPEG');
  assert.strictEqual(await store.shotOf('G', 'RPG File2'), null, 'слота нет — и снимка нет');
  // Снимок намного старше нынешнего сейва слота — уже не про него
  const old = new Date(Date.now() - 3600e3);
  const shotPath = (await store.shotOf('G', 'RPG File1')).file;
  fs.utimesSync(shotPath, old, old);
  assert.strictEqual(await store.shotOf('G', 'RPG File1'), null);
  // Вернули версию из истории — снимок убран
  await store.writeShot('G', 'RPG File1', jpg);
  await store.write('G', 'RPG File1', '{"a":2}', Date.now() + 1);
  const version = (await store.history('G'))[0].versions[0].id;
  await store.restore('G', 'RPG File1', version);
  assert.ok(!fs.existsSync(shotPath));
  // Сейвы из архива — тоже
  await store.writeShot('G', 'RPG File1', jpg);
  await store.importSaves('G', [{ key: 'RPG File1', value: '{"a":3}' }]);
  assert.ok(!fs.existsSync(shotPath));
  // Слот удалили в игре — и снимок
  await store.writeShot('G', 'RPG File1', jpg);
  await store.remove('G', 'RPG File1');
  assert.ok(!fs.existsSync(shotPath));
});

test('моменты: хранилище — подпись в одну строку, снимок только JPEG, удалённый лежит 30 дней', async (t) => {
  const { createMarkStore } = require('./src/utils/marks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createMarkStore(dir);
  const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64')}`;
  const wait = () => new Promise((r) => setTimeout(r, 3));
  const a = await store.create('G', { label: ' Первая\nсцена ', map: 'Город', value: '{"x":1}', thumb: jpg });
  await wait();
  const b = await store.create('G', { label: 'x'.repeat(300), value: '{"x":2}', thumb: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepStrictEqual((await store.list('G')).map((m) => [m.id, m.label.length, m.map, m.thumb]), [[b.id, 120, '', false], [a.id, 12, 'Город', true]], 'новые первыми, PNG вместо снимка — без снимка');
  assert.strictEqual((await store.list('G'))[1].label, 'Первая сцена');
  assert.strictEqual(await store.value('G', a.id), '{"x":1}');
  assert.ok(await store.thumb('G', a.id));
  assert.strictEqual(await store.thumb('G', b.id), null);
  assert.deepStrictEqual(await store.create('G', { value: '' }), { error: 'bad-value' });
  assert.strictEqual(await store.value('G', '../x'), null);
  assert.deepStrictEqual(await store.list('../G'), [], 'имя игры — только папкой внутри .marks');
  assert.ok(await store.rename('G', a.id, 'Ванная'));
  assert.ok(await store.remove('G', b.id));
  assert.deepStrictEqual((await store.list('G')).map((m) => m.label), ['Ванная']);
  const trash = path.join(dir, '.marks', 'G', '.deleted');
  assert.strictEqual(require('zlib').gunzipSync(fs.readFileSync(path.join(trash, `${b.id}.save.gz`))).toString(), '{"x":2}', 'удалённая — не стёрта');
  assert.strictEqual(await store.remove('G', b.id), false);
  // Через 30 дней удалённая стирается — при следующем удалении
  const old = new Date(Date.now() - 31 * 24 * 3600e3);
  fs.utimesSync(path.join(trash, `${b.id}.json`), old, old);
  await store.remove('G', a.id);
  assert.deepStrictEqual(fs.readdirSync(trash).sort(), [`${a.id}.jpg`, `${a.id}.json`, `${a.id}.save.gz`]);
});

test('моменты: снимок без сейва, кадр целиком; перемотка — по времени, по прохождениям, слитые точки, путь к нынешнему; «Оставить»; моменты до сжатия читаются', async (t) => {
  const { createMarkStore, MAX_AUTO, SMALL_KEEP } = require('./src/utils/marks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createMarkStore(dir);
  const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64')}`;
  const big = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]).toString('base64')}`;
  const wait = () => new Promise((r) => setTimeout(r, 2));
  // Снимок в бою — только кадр; без кадра снимок не нужен
  const shot = await store.create('G', { kind: 'shot', label: 'Бой', thumb: jpg, shot: big, playtime: 3600.7 });
  assert.deepStrictEqual(await store.create('G', { kind: 'shot' }), { error: 'bad-value' });
  assert.deepStrictEqual(await store.create('G', { kind: 'weird', value: 'x' }), { error: 'bad-value' });
  await wait();
  // Снимок на карте — момент: сейв, кадр целиком и маленький
  const mark = await store.create('G', { kind: 'mark', label: 'Ванная', value: '{"m":1}', thumb: jpg, shot: big });
  const [m, s0] = await store.list('G');
  assert.deepStrictEqual([m.id, m.kind, m.save, m.full, m.thumb], [mark.id, 'mark', true, true, true]);
  assert.deepStrictEqual([s0.kind, s0.save, s0.full, s0.playtime], ['shot', false, true, 3600]);
  assert.strictEqual(await store.value('G', shot.id), null);
  assert.ok((await store.shot('G', mark.id)).endsWith('.full.jpg'));
  assert.strictEqual(await store.value('G', mark.id), '{"m":1}', 'сейв сжат, а читается как был');
  // Перемотка: кадр целиком не хранит. Последние полчаса — все точки; старше — по одной на окно, самая важная
  const clock = { t: Date.now() };
  const timed = createMarkStore(dir, { now: () => clock.t });
  const at = (min) => { clock.t = start + min * 60e3; };
  // Начало — у границы пятиминутного окна: первые точки — в одном окне
  const start = Math.floor(clock.t / 300e3) * 300e3 + 10e3;
  const auto = (why, line = 'line0001', extra = {}) => timed.create('G', { kind: 'auto', why, line, value: `{"w":"${why}"}`, thumb: jpg, shot: big, ...extra });
  at(0);
  const first = await auto('timer');
  at(1);
  const scene = await auto('scene', 'line0001', { label: 'Сцена в лесу' });
  at(2);
  const timerSame = await auto('timer');
  at(2.5);
  const otherLine = await auto('battle', 'line0002');
  at(20);
  let list = await timed.list('G');
  assert.strictEqual(list.filter((x) => x.kind === 'auto').length, 4, 'полчаса — все');
  assert.strictEqual(list.find((x) => x.id === scene.id).full, false);
  // Час спустя: окно в 5 минут — одна точка, сцена важнее таймеров; у другого прохождения — своя
  at(60);
  await auto('timer');
  list = await timed.list('G');
  assert.ok(list.some((x) => x.id === scene.id) && !list.some((x) => x.id === first.id) && !list.some((x) => x.id === timerSame.id), 'в окне осталась сцена');
  assert.ok(list.some((x) => x.id === otherLine.id), 'другое прохождение не вытесняет это');
  assert.strictEqual(fs.readdirSync(path.join(dir, '.marks', 'G')).filter((f) => f.startsWith(first.id)).length, 0, 'вытесненная стёрта целиком');
  // Две точки за 3 секунды — одна: остаётся прежняя, подпись — у важной, причины — обе
  at(70);
  const map = await auto('map', 'line0001', { label: 'Лес' });
  clock.t += 1500;
  const merged = await auto('choice', 'line0001', { label: 'Пойдём?', id: 'choice0001', parent: map.id });
  assert.deepStrictEqual(merged, { id: map.id, merged: true });
  const m1 = (await timed.list('G')).find((x) => x.id === map.id);
  assert.deepStrictEqual([m1.why, m1.label, m1.also], ['choice', 'Пойдём?', ['map', 'choice']]);
  assert.ok(await timed.setAnswer('G', map.id, 'Да'), 'ответ — к слитой точке с выбором');
  // Путь к нынешнему: от id из сейва — к живым предкам, слитая и прореженные — насквозь; ветка, от которой перемотали, — нет
  clock.t += 60e3;
  const a1 = await auto('scene', 'line0001', { id: 'path00001', parent: 'choice0001' });
  clock.t += 60e3;
  const branch = await auto('battle', 'line0001', { id: 'branch0001', parent: a1.id });
  clock.t += 60e3;
  const b1 = await auto('timer', 'line0001', { id: 'path00002', parent: a1.id });
  assert.deepStrictEqual(await timed.trail('G', b1.id), [b1.id, a1.id, map.id, ...(await timed.trail('G', map.id)).slice(1)]);
  assert.ok(!(await timed.trail('G', b1.id)).includes(branch.id), 'брошенная ветка — не на пути');
  assert.deepStrictEqual(await timed.trail('G', 'nothing01'), []);
  // id из игры занят — свой; «До перемотки» и «Где вышли» — свои небольшие запасы
  assert.notStrictEqual((await auto('timer', 'line0003', { id: b1.id })).id, b1.id);
  for (let i = 0; i < SMALL_KEEP.back + 2; i++) { clock.t += 10e3; await auto('back'); }
  for (let i = 0; i < SMALL_KEEP.exit + 2; i++) { clock.t += 10e3; await auto('exit'); }
  list = await timed.list('G');
  assert.deepStrictEqual([list.filter((x) => x.why === 'back').length, list.filter((x) => x.why === 'exit').length], [SMALL_KEEP.back, SMALL_KEEP.exit]);
  // Свои моменты прореживание не трогает
  assert.ok(list.some((x) => x.id === mark.id) && list.some((x) => x.id === shot.id));
  // «Оставить» — точка становится моментом и больше не вытесняется
  const keepIt = (await timed.list('G')).find((x) => x.kind === 'auto' && x.why === 'back').id;
  assert.deepStrictEqual(await timed.keep('G', keepIt), { id: keepIt });
  for (let i = 0; i < SMALL_KEEP.back + 1; i++) { clock.t += 10e3; await auto('back'); }
  assert.strictEqual((await timed.list('G')).find((x) => x.id === keepIt).kind, 'mark');
  assert.deepStrictEqual(await timed.keep('G', 'nope000'), { error: 'not-found' });
  // «Оставить» в тот миг, когда новая точка вытеснила эту (сейв уже стёрт), — момента без сейва не остаётся
  const gone = (await timed.list('G')).find((x) => x.kind === 'auto').id;
  fs.rmSync(path.join(dir, '.marks', 'G', `${gone}.save.gz`));
  assert.deepStrictEqual(await timed.keep('G', gone), { error: 'not-found' });
  assert.ok(!(await timed.list('G')).some((x) => x.id === gone));
  // «Оставить» в ту же миллисекунду, что новая точка с прореживанием, — момент цел
  clock.t = start + 600 * 60e3;
  const raced = await auto('map', 'line0007');
  clock.t += 6 * 3600e3;
  const [kept] = await Promise.all([timed.keep('G', raced.id), auto('timer', 'line0007'), auto('battle', 'line0007')]);
  assert.deepStrictEqual(kept, { id: raced.id });
  assert.strictEqual((await timed.list('G')).find((x) => x.id === raced.id)?.kind, 'mark', '★ не стёрта прореживанием');
  // Предок, которого нет (не записался), — путь не падает; битый _tree — в сторону, точки целы
  const orphan = await auto('scene', 'line0008', { id: 'orphan001', parent: 'neverwas1' });
  assert.deepStrictEqual(await timed.trail('G', orphan.id), [orphan.id]);
  fs.writeFileSync(path.join(dir, '.marks', 'G', '_tree.json'), '{oops');
  assert.deepStrictEqual(await timed.trail('G', orphan.id), [orphan.id], 'чтение пути битый не трогает');
  assert.ok(!fs.readdirSync(path.join(dir, '.marks', 'G')).some((f) => f.startsWith('_tree.broken-')));
  await auto('timer', 'line0008');
  assert.ok(fs.readdirSync(path.join(dir, '.marks', 'G')).some((f) => f.startsWith('_tree.broken-')), 'запись — откладывает битый и пишет с чистого');
  assert.ok((await timed.list('G')).some((x) => x.id === orphan.id));
  // Ответ на выбор и слияние разом — ни ответ, ни причины не теряются
  clock.t += 3600e3;
  const q = await auto('scene', 'line0010', { label: 'Сцена' });
  clock.t += 1000;
  // Как в игре: выбор (сольётся со сценой), следом ответ к нему — разом, оба в очереди
  await Promise.all([auto('choice', 'line0010', { label: 'Вопрос' }), timed.setAnswer('G', q.id, 'Нет')]);
  const qm = (await timed.list('G')).find((x) => x.id === q.id);
  assert.deepStrictEqual([qm.answer, qm.also], ['Нет', ['scene', 'choice']]);
  // Предки не читаются — точка не пишется (ошибка), а очередь живёт: следующие и список работают
  fs.rmSync(path.join(dir, '.marks', 'G', '_tree.json'), { force: true });
  fs.mkdirSync(path.join(dir, '.marks', 'G', '_tree.json'));
  await assert.rejects(auto('timer', 'line0011'));
  fs.rmdirSync(path.join(dir, '.marks', 'G', '_tree.json'));
  assert.ok((await auto('timer', 'line0011')).id);
  // Точек больше MAX_AUTO за полчаса — уходят старые
  for (let i = 0; i < MAX_AUTO + 5; i++) { clock.t += 5e3; await auto(i % 2 ? 'scene' : 'battle', 'line0009'); }
  assert.strictEqual((await timed.list('G')).filter((x) => x.kind === 'auto' && !SMALL_KEEP[x.why]).length, MAX_AUTO);
  // Момент, записанный до сжатия и видов: .save рядом, без kind — момент с сейвом
  fs.writeFileSync(path.join(dir, '.marks', 'G', 'legacy01.save'), '{"old":1}');
  fs.writeFileSync(path.join(dir, '.marks', 'G', 'legacy01.json'), JSON.stringify({ label: 'Старый', map: '', at: 1, thumb: false }));
  const legacy = (await store.list('G')).find((x) => x.id === 'legacy01');
  assert.deepStrictEqual([legacy.kind, legacy.save, legacy.full], ['mark', true, false]);
  assert.strictEqual(await store.value('G', 'legacy01'), '{"old":1}');
});

test('«Путь»: локация и сцена — в первый раз, бои подряд — одной записью с числом, выбор — с ответом, кадр сцены; лишнее старое уходит', async (t) => {
  const { createJournal } = require('./src/utils/journal.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const j = createJournal(dir, { max: 6 });
  const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]).toString('base64')}`;
  assert.ok((await j.add('G', { kind: 'map', label: 'Город', map: 'Город', mapId: 3, playtime: 61.9 })).id);
  assert.deepStrictEqual(await j.add('G', { kind: 'map', label: 'Город', mapId: 3 }), { skipped: true }, 'та же локация — только в первый раз');
  const scene = await j.add('G', { kind: 'scene', label: ' «Ты меня\nпомнишь?» ', key: '3:5:40', map: 'Город', point: 'abc123def' });
  assert.deepStrictEqual(await j.add('G', { kind: 'scene', label: 'снова', key: '3:5:40' }), { skipped: true });
  const b1 = await j.add('G', { kind: 'battle', label: 'Летучая мышь' });
  assert.deepStrictEqual(await j.add('G', { kind: 'battle', label: 'Летучая мышь' }), { id: b1.id, merged: true });
  await j.add('G', { kind: 'choice', label: 'Пойдём?', answer: 'Да' });
  assert.deepStrictEqual(await j.add('G', { kind: 'choice', label: 'Пойдём?', answer: 'Да' }), { skipped: true }, 'тот же ответ подряд — одна запись');
  assert.ok((await j.add('G', { kind: 'choice', label: 'Пойдём?', answer: 'Нет' })).id, 'другой ответ — новая запись');
  assert.deepStrictEqual(await j.add('G', { kind: 'weird' }), { error: 'bad-entry' });
  assert.deepStrictEqual(await j.add('../G', { kind: 'map', mapId: 1 }), { error: 'bad-entry' });
  assert.ok(await j.setThumb('G', scene.id, jpg));
  assert.strictEqual(await j.setThumb('G', scene.id, 'data:image/png;base64,iVBORw0KGgo='), false, 'не JPEG — без кадра');
  let list = await j.list('G');
  assert.deepStrictEqual(list.map((e) => [e.kind, e.label, e.count || 1, e.answer ?? null]),
    [['map', 'Город', 1, null], ['scene', '«Ты меня помнишь?»', 1, null], ['battle', 'Летучая мышь', 2, null], ['choice', 'Пойдём?', 1, 'Да'], ['choice', 'Пойдём?', 1, 'Нет']]);
  assert.deepStrictEqual([list[0].playtime, list[0].mapId, list[1].point, list[1].thumb], [61, 3, 'abc123def', true]);
  assert.ok(await j.thumb('G', scene.id));
  // Больше предела — сначала уходят старые бои, потом самое старое
  await j.add('G', { kind: 'map', label: 'Лес', mapId: 4 });
  await j.add('G', { kind: 'map', label: 'Руины', mapId: 5 });
  list = await j.list('G');
  assert.strictEqual(list.length, 6);
  assert.ok(!list.some((e) => e.kind === 'battle'), 'бой ушёл первым');
  assert.strictEqual(list[0].kind, 'map');
  // Одновременные записи не затирают друг друга
  const big = createJournal(dir);
  await Promise.all(Array.from({ length: 20 }, (_, n) => big.add('H', { kind: 'map', label: `M${n}`, mapId: n + 1 })));
  assert.strictEqual((await big.list('H')).length, 20);
  // Пришла позже (сцена ждала свою точку) — встаёт по времени события; отказ — отметкой, без слова
  const k = createJournal(dir);
  await k.add('K', { kind: 'choice', label: 'Второе', answer: 'Да' });
  await k.add('K', { kind: 'scene', label: 'Первое', key: 'a', ago: 60e3 });
  await k.add('K', { kind: 'choice', label: 'Третье', cancel: true, answer: 'отказ' });
  const kl = await k.list('K');
  assert.deepStrictEqual(kl.map((e) => e.label), ['Первое', 'Второе', 'Третье']);
  assert.deepStrictEqual([kl[2].cancel, kl[2].answer], [true, undefined]);
  // Испорченный файл пути не затирается новой записью: откладывается рядом
  const kdir = path.join(dir, '.journal', 'K');
  fs.writeFileSync(path.join(kdir, 'log.json'), '{oops');
  assert.ok((await k.add('K', { kind: 'map', label: 'Новая', mapId: 9 })).id);
  assert.ok(fs.readdirSync(kdir).some((f) => /^log\.bad-\d+\.json$/.test(f)), 'испорченный — отложен, а не стёрт');
  // Не читается (каталог вместо файла) — ошибка, а не пустой путь поверх
  fs.rmSync(path.join(kdir, 'log.json'));
  fs.mkdirSync(path.join(kdir, 'log.json'));
  assert.deepStrictEqual(await k.add('K', { kind: 'map', label: 'X', mapId: 10 }), { error: 'unreadable' });
  // «Ещё не видели»: последний счёт комнаты; открыто не больше, чем всего
  assert.strictEqual(await k.room('R'), null);
  assert.ok(await k.setRoom('R', { total: 30, open: 12, rooms: ['回想部屋', ''] }));
  assert.deepStrictEqual((({ at, ...rest }) => rest)(await k.room('R')), { total: 30, open: 12, rooms: ['回想部屋'] });
  assert.strictEqual(await k.setRoom('R', { total: 3, open: 5 }), false);
  assert.ok(await k.setRoom('R', { total: 90, open: null, rooms: ['Room'] }), 'сколько открыто — не понять: только число');
  assert.strictEqual((await k.room('R')).open, null);
  assert.strictEqual(await k.setRoom('../R', { total: 1, open: 0 }), false);
});

test('службы рядом: LibreTranslate из docker-compose находится сам; вписанный адрес главнее; пропала — перестаём', async (t) => {
  const { secret, setSavedSecret, describeSecret } = require('./src/utils/secrets.js');
  const { findNearby } = require('./src/utils/nearby.js');
  const realFetch = global.fetch;
  const env = { LIBRETRANSLATE_URL: process.env.LIBRETRANSLATE_URL };
  delete process.env.LIBRETRANSLATE_URL;
  let up = true;
  global.fetch = async (url) => {
    if (!up) throw new Error('getaddrinfo ENOTFOUND');
    if (url === 'http://libretranslate:5000/languages') return new Response(JSON.stringify([{ code: 'en' }]));
    return new Response('{}', { status: 404 });
  };
  t.after(async () => {
    global.fetch = realFetch; setSavedSecret('libre', '');
    up = false; global.fetch = async () => { throw new Error('нет'); }; await findNearby(); global.fetch = realFetch;
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  });
  await findNearby();
  assert.strictEqual(secret('libre'), 'http://libretranslate:5000');
  assert.strictEqual(describeSecret('libre').auto, true, 'в «Настройках» — «найден рядом»');
  setSavedSecret('libre', 'http://192.168.1.5:5000');
  assert.strictEqual(secret('libre'), 'http://192.168.1.5:5000', 'вписанный — главнее');
  assert.strictEqual(describeSecret('libre').auto, undefined);
  setSavedSecret('libre', '');
  up = false;
  await findNearby();
  assert.strictEqual(secret('libre'), '', 'службу выключили — не пользуемся');
});

test('распаковка: игра не на MV/MZ — ошибка называет её движок, а не «нет папки www»', async (t) => {
  const { otherEngine } = require('./src/utils/archive.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'engine-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const put = async (rel) => { await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fsp.writeFile(path.join(root, rel), 'x'); };
  await put('vx/Moonlit Paradox/Game.exe');
  await put('vx/Moonlit Paradox/Game.rgss3a');
  await put('wolf/Game/Data.wolf');
  await put('renpy/Game/renpy/__init__.py');
  await put('unity/Game/UnityPlayer.dll');
  await put('mv/Game/www/index.html');
  await put('vxopen/Game/Data/Actors.rvdata2');
  await put('r2k/Game/RPG_RT.exe');
  assert.strictEqual(await otherEngine(path.join(root, 'vx')), 'RPG Maker VX Ace, VX или XP');
  assert.strictEqual(await otherEngine(path.join(root, 'wolf')), 'WOLF RPG Editor');
  assert.strictEqual(await otherEngine(path.join(root, 'renpy')), "Ren'Py");
  assert.strictEqual(await otherEngine(path.join(root, 'unity')), 'Unity');
  assert.strictEqual(await otherEngine(path.join(root, 'mv')), '');
  assert.strictEqual(await otherEngine(path.join(root, 'vxopen')), 'RPG Maker VX Ace, VX или XP', 'незашифрованный VX Ace (переводы)');
  assert.strictEqual(await otherEngine(path.join(root, 'r2k')), 'RPG Maker 2000 или 2003');
  // Настоящий сервис загрузки: архив с игрой на VX Ace — ошибка с движком, архив из «Входящих» не стёрт
  const rig = await uploadRig(t);
  rig.entries = [{ path: 'Moonlit Paradox/Game.rgss3a', size: 10, encrypted: false }];
  rig.extract = async (out) => {
    await fsp.mkdir(path.join(out, 'Moonlit Paradox'), { recursive: true });
    await fsp.writeFile(path.join(out, 'Moonlit Paradox', 'Game.rgss3a'), 'x');
  };
  const inboxDir = path.join(path.dirname(rig.dir), '_inbox');
  await fsp.mkdir(inboxDir, { recursive: true });
  const file = path.join(inboxDir, 'Moonlit_Paradox_20190629_TheTrain.zip');
  await fsp.writeFile(file, 'zip');
  const id = await rig.svc.importFile(file);
  await rig.until(async () => (await rig.svc.status(id))?.state === 'error', 'ошибка');
  assert.match((await rig.svc.status(id)).error, /RPG Maker VX Ace, VX или XP — библиотека запускает только игры на RPG Maker MV и MZ/);
  assert.ok(!fs.existsSync(file), 'из «Входящих» ушёл');
  assert.ok(fs.readdirSync(path.join(inboxDir, '_failed')).some((f) => f.endsWith('-Moonlit_Paradox_20190629_TheTrain.zip')), 'и не стёрт — в _inbox/_failed');
});

test('распаковка: архив под паролем — сначала пароли, заданные при загрузке по ссылке; не подошёл ни один — спросить человека', async () => {
  const { UploadService } = require('./src/services/uploads.js');
  const u = Object.create(UploadService.prototype);
  const tried = [];
  u.tools = {
    list: async () => [{ path: 'game/Game.exe', size: 1, encrypted: true }],
    test: async (file, pw) => { tried.push(pw); if (pw !== 'Esan') throw new Error('Wrong password'); },
  };
  assert.strictEqual(await u.knownPassword('/x/a.rar', ['nope', 'Esan']), 'Esan');
  assert.deepStrictEqual(tried, ['nope', 'Esan'], 'по очереди, пока не подойдёт');
  // Проверяем один самый маленький зашифрованный файл, а не весь архив
  const only = [];
  u.tools.list = async () => [{ path: 'g/big.bin', size: 9e9, encrypted: true }, { path: 'g/a.json', size: 10, encrypted: true }, { path: 'g/z', size: 1, encrypted: false }];
  u.tools.test = async (file, pw, one) => { only.push(one); if (pw !== 'secret') throw new Error('Wrong password'); };
  assert.strictEqual(await u.knownPassword('/x/a.zip', ['secret']), 'secret');
  assert.deepStrictEqual([...new Set(only)], ['g/a.json']);
  // Список зашифрован — 7-Zip без пароля не открывает архив вовсе: пароль проверяет чтение списка
  u.tools.list = async (file, pw) => { if (pw !== 'secret') throw Object.assign(new Error('Wrong password'), { password: true }); return []; };
  u.tools.test = async () => { throw new Error('не должен: хватает списка'); };
  assert.strictEqual(await u.knownPassword('/x/a.7z', ['nope', 'secret']), 'secret', 'неподошедший пропускаем');
  u.tools.list = async () => { throw Object.assign(new Error('Wrong password'), { password: true }); };
  assert.strictEqual(await u.knownPassword('/x/a.7z', ['nope']), '', 'ни один не подошёл — спросить человека');
  assert.strictEqual(await u.knownPassword('/x/a.7z', []), '', 'пробовать нечего — спросить человека');
  // Не под паролем — ничего не пробуем
  u.tools.list = async () => [{ path: 'a', size: 1, encrypted: false }];
  u.tools.test = async () => { throw new Error('не должен'); };
  assert.strictEqual(await u.knownPassword('/x/a.zip', ['Esan']), '');
});

test('«Скрыть» в игре (H): экран закрыт, игра и звук стоят, клавиши до игры не доходят; ещё раз — как было; плёнка держит игру и после', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'rpg-fixes.js'), 'utf8');
  // Вместе с общей паузой игры (holdGame) — она прямо перед setupPanic
  const from = src.indexOf('const holds = new Set();');
  const start = src.indexOf('function setupPanic()');
  let depth = 0; let end = src.indexOf('{', start);
  for (let i = end; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i + 1; break; } }
  const listeners = {};
  const posted = [];
  let relatched = 0;
  const win = { addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }, parent: { postMessage: (m) => posted.push(m) }, __rpgRelatch: () => { relatched++; } };
  const el = () => ({ style: {}, appendChild() {}, addEventListener() {} });
  const document = { createElement: el, body: { appendChild() {} }, querySelectorAll: () => [] };
  class Scene_Name {}
  let updates = 0;
  const SceneManager = { _scene: {}, updateScene() { updates++; } };
  const ctx = { state: 'running', suspend() { this.state = 'suspended'; return Promise.resolve(); }, resume() { this.state = 'running'; return Promise.resolve(); } };
  let cleared = 0;
  const items = [];
  const holdGame = new Function('window', 'document', 'T', 'FRAMED', 'addMenuItem', 'SceneManager', 'WebAudio', 'Input', 'TouchInput', 'Scene_Name', 'setClean', `${src.slice(from, end)}; setupPanic(); return holdGame;`)(
    win, document, { hide: 'Скрыть (H)', hide_back: 'H' }, true, (it) => items.push(it), SceneManager, { _context: ctx }, { clear: () => { cleared++; } }, { clear() {} }, Scene_Name, () => {});
  const key = (code, k = code, type = 'keydown', extra = {}) => ({ code, key: k, type, target: { closest: () => null }, stopped: false,
    preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  const press = (e) => { for (const fn of listeners[e.type] || []) fn(e); return e; };
  // Экран ввода имени — H там буква, её не забираем
  SceneManager._scene = new Scene_Name();
  assert.strictEqual(press(key('KeyH', 'h')).stopped, false);
  SceneManager._scene = {};
  assert.strictEqual(press(key('KeyH', 'h')).stopped, true);
  assert.ok(win.__rpgPanic.isOn());
  assert.strictEqual(ctx.state, 'suspended');
  assert.deepStrictEqual(posted, [{ type: 'rpg:quiet', on: true }]);
  SceneManager.updateScene();
  assert.strictEqual(updates, 0, 'игра стоит');
  // Пока скрыто: игровые клавиши — не игре, браузерные (F5, Ctrl+…) — браузеру
  assert.strictEqual(press(key('ArrowLeft')).stopped, true);
  assert.strictEqual(press(key('F5')).stopped, false);
  assert.strictEqual(press(key('KeyR', 'r', 'keydown', { ctrlKey: true })).stopped, false);
  // H из библиотеки (фокус мимо рамки) — сообщением
  for (const fn of listeners.message) fn({ source: win.parent, data: { type: 'rpg:quiet-toggle' } });
  assert.ok(!win.__rpgPanic.isOn());
  assert.strictEqual(ctx.state, 'running');
  assert.strictEqual(cleared, 1, 'зажатая в миг скрытия клавиша не залипает');
  assert.strictEqual(relatched, 1, 'включённый «Пропуск» — снова в игре');
  SceneManager.updateScene();
  assert.strictEqual(updates, 1);
  // Плёнка открыта, поверх скрыли и вернули — игра всё ещё стоит, пока плёнку не закрыли
  holdGame('rewind', true);
  press(key('KeyH', 'h'));
  press(key('KeyH', 'h'));
  SceneManager.updateScene();
  assert.strictEqual(updates, 1, 'под плёнкой игра стоит');
  holdGame('rewind', false);
  SceneManager.updateScene();
  assert.strictEqual(updates, 2);
  assert.deepStrictEqual(posted.at(-1), { type: 'rpg:quiet', on: false });
  assert.strictEqual(press(key('ArrowLeft')).stopped, false);
  assert.deepStrictEqual(items.map((i) => [i.id, i.section]), [['_sys_hide', 'nav']]);
});

test('момент, загруженный посреди реплики, показывает эту реплику снова (rewindMessage)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'rpg-fixes.js'), 'utf8');
  const start = src.indexOf('function rewindMessage(interpreter)');
  let depth = 0; let end = src.indexOf('{', start);
  for (let i = end; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i + 1; break; } }
  const rewind = new Function(`${src.slice(start, end)}; return rewindMessage;`)();
  const cmd = (code) => ({ code, parameters: [] });
  // Текст на два ряда — движок встал после него
  let it = { _list: [cmd(121), cmd(101), cmd(401), cmd(401), cmd(230), cmd(0)], _index: 4, _waitMode: 'message' };
  assert.ok(rewind(it));
  assert.deepStrictEqual([it._index, it._waitMode], [1, '']);
  // Текст и выбор сразу за ним — к тексту; выбор сам по себе — к выбору
  it = { _list: [cmd(101), cmd(401), cmd(102), cmd(402)], _index: 3, _waitMode: 'message' };
  rewind(it);
  assert.strictEqual(it._index, 0);
  it = { _list: [cmd(230), cmd(102), cmd(402)], _index: 2, _waitMode: 'message' };
  rewind(it);
  assert.strictEqual(it._index, 1);
  // Реплика в общем событии — отматывается оно, не карта
  const child = { _list: [cmd(101), cmd(401), cmd(0)], _index: 2, _waitMode: 'message' };
  const parent = { _list: [cmd(117)], _index: 1, _waitMode: '', _childInterpreter: child };
  assert.ok(rewind(parent));
  assert.deepStrictEqual([child._index, parent._index], [0, 1]);
  // Ждёт не реплику (переход, пауза) — не трогаем
  it = { _list: [cmd(101), cmd(401), cmd(230)], _index: 3, _waitMode: 'transfer' };
  assert.strictEqual(rewind(it), false);
  assert.strictEqual(it._index, 3);
});

// --- Журнал ошибок игр (services/gameErrors.js) ---
test('ошибки игр: одна и та же — одна строка со счётчиком, устройство по User-Agent, ключ из адреса не хранится', async (t) => {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { GameErrors, deviceOf } = require('./src/services/gameErrors.js');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  const errs = new GameErrors();
  errs.setDependencies({ get: () => db });
  await errs.init();
  t.mock.method(console, 'log', () => {});
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
  const key = 'a'.repeat(32);
  for (const n of [1, 2, 3]) {
    await errs.record('Game', { kind: 'engine', message: `Cannot read properties of undefined (reading 'x${n}')`, source: `http://h:8081/g/${key}/Game/www/js/plugins/Foo.js`, line: 10, stack: `at http://h:8081/g/${key}/Game/www/js/plugins/Foo.js:10:5` }, iphone);
  }
  await errs.record('Game', { kind: 'error', message: 'Other' }, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36');
  assert.strictEqual(await errs.record('Game', { message: '' }, iphone), false);
  t.mock.restoreAll();
  const [game] = await errs.list();
  assert.strictEqual(game.game, 'Game');
  const engine = game.errors.find((e) => e.kind === 'engine');
  assert.deepStrictEqual([engine.count, engine.device, engine.source], [3, 'iPhone · Safari', '/Game/www/js/plugins/Foo.js']);
  assert.strictEqual(engine.stack.includes(key), false);
  assert.strictEqual(game.errors.find((e) => e.kind === 'error').device, 'Windows · Chrome');
  assert.strictEqual(deviceOf(iphone, true), 'iPhone · веб-приложение');
  await errs.clear('Game');
  assert.deepStrictEqual(await errs.list(), []);
});

// --- Сцены из событий (services/galleryScenes.js): кадры из слоёв, которых нет файлами ---
test('галерея: сцена-панель — реплики плагином (лог боя), стопка деталей на одном месте без CG; интерфейс и чужое место — не в ней', () => {
  const { runList, analyze } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, x = 0) => c(231, [n, name, 0, 0, x, 0, 100, 100, 255, 0]);
  // Бой Magical Girl Runa and Nanami: реплики — только командой BattleLogOutput, окна сообщения нет
  const log = (t) => c(357, ['BattleLogOutput', 'OUTPUT_LOG', 'バトルログ出力', { message: t, pushBaseLine: 'false', waitCount: '0' }]);
  const list = [show(99, 'HUD_battle/battle_h01'), show(21, 'battle/base', 648), show(22, 'battle/phair', 640), log('Ora!'),
    show(28, 'battle/samen', 640), show(29, 'battle/face_05', 648), log('Nooo!'), show(29, 'battle/face_06', 648), log('…'), c(0)];
  const r = runList(list, []);
  assert.deepStrictEqual(r.frames.filter((f) => f.msg).map((f) => f.pics.map((p) => p.name).join('+')), [
    'battle/base+battle/phair+HUD_battle/battle_h01',
    'battle/base+battle/phair+battle/samen+battle/face_05+HUD_battle/battle_h01',
    'battle/base+battle/phair+battle/samen+battle/face_06+HUD_battle/battle_h01',
  ]);
  // CG нет: детали — «персонажи» и слои, интерфейс — «прочее». Сцена — стопка с основы, интерфейс боя (x=0) — не её часть
  const kinds = { 'battle/base': 'portrait', 'battle/phair': 'layer', 'battle/samen': 'layer', 'battle/face_05': 'portrait', 'battle/face_06': 'portrait', 'HUD_battle/battle_h01': 'other' };
  const { groups } = analyze([{ id: 'ce1', name: 'チンピラ挿入', where: '', list }], [], (n) => kinds[n] || null);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].panel, true);
  assert.deepStrictEqual(groups[0].finished.map((x) => x.layers.map((l) => l.name.split('/')[1]).join('+')), ['base+phair', 'base+phair+samen+face_05', 'base+phair+samen+face_06']);
  // Портрет разговора на одном месте с лицом — тоже кандидат: сцена ли это, решает распознавание, а не правила
  const talk = [show(1, 'stand/body', 100), show(2, 'stand/face_smile', 100), ...[c(101), c(401, ['Привет'])], show(2, 'stand/face_sad', 100), c(101), c(401, ['Пока']), c(0)];
  const t2 = analyze([{ id: 'ce2', name: 'Разговор', where: '', list: talk }], [], () => 'portrait');
  assert.deepStrictEqual(t2.groups.map((g) => [g.panel, g.finished.length]), [[true, 2]]);
  // Одна картинка без деталей поверх — не панель
  assert.deepStrictEqual(analyze([{ id: 'ce3', name: 'Один', where: '', list: [show(1, 'a'), c(101), c(401, ['…']), show(1, 'b'), c(101), c(401, ['…']), show(1, 'c'), c(101), c(401, ['…']), c(0)] }], [], () => 'portrait').groups, []);
});

test('галерея: реплики плагинов — DialogFromCSVwithPic (текст из CSV) и окно выбора LL_GalgeChoiceWindow; альбомы те же', () => {
  const { runList, analyze, dialogCsv, csvDialog, galgeChoice } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const short = (x) => (x.k === 'pics' ? `pics:${x.pics.map((p) => p.name).join('+')}` : x.k === 'say' ? `say:${x.n || ''}|${x.l.join('/')}` : x.k === 'choice' ? `choice:${x.o.join(',')}:${x.i}` : `${x.k}`);
  // Таблица, как её читает плагин: блоки по 4 строки, без кавычек, BOM и CRLF, повтор id — побеждает последний
  const t = dialogCsv('﻿1,\\px[114]Bob,Hello.\r\n,,Second line.\r\n,,\r\n,,\r\n' + '\n,,\n,,\n,,\n' + '2,Ann,"a, b",x\n,,c\n,,\n,,\n' + '21.8,Cid,first\n,,\n,,\n,,\n' + '21.8,Dan,last\n,,\n,,\n,,\n' + ',Nobody,skipped\n,,\n,,\n,,\n' + '9, Eve , end ');
  assert.deepStrictEqual(t.get('1'), { name: '\\px[114]Bob', lines: ['Hello.', 'Second line.', '', ''] });
  assert.deepStrictEqual(t.get('2'), { name: 'Ann', lines: ['"a', 'c', '', ''] }, 'кавычки не разбираем, лишние столбцы — мимо');
  assert.strictEqual(t.get('21.8').name, 'Dan');
  assert.ok(!t.has(''), 'пустой id пропущен');
  assert.deepStrictEqual(t.get('9'), { name: 'Eve', lines: ['end', '', '', ''] }, 'строк в конце файла нет — пустые');
  assert.strictEqual(t.size, 4);
  assert.deepStrictEqual([...dialogCsv('\n,,x\n,,y\n,,z\n5,A,ok\n').keys()], ['5'], 'пустая первая строка пропускает блок целиком');
  const csvCmd = (id, file = 'Talk.csv', extra = {}) => c(357, ['DialogFromCSVwithPic', 'showDialogById', '', { dialogId: id, csvFile: file, position: 'Bottom', pictureName: '!Dialog', pictureId: '95', ...extra }]);
  assert.ok(csvDialog(csvCmd('1')));
  assert.ok(csvDialog(c(357, ['sub/DialogFromCSVwithPic', 'showDialogById', '', { dialogId: '1', csvFile: 'a.csv' }])), 'плагин в подпапке');
  assert.strictEqual(csvDialog(csvCmd('')), null);
  assert.strictEqual(csvDialog(c(357, ['DialogFromCSVwithPic', 'showDialogById', '', { dialogId: 1, csvFile: 'a.csv' }])), null, 'число вместо строки: плагин такой id не находит');
  assert.strictEqual(csvDialog(c(356, ['DialogFromCSVwithPic showDialogById 1'])), null);
  const names = ['cg/body', 'cg/over', '!dialog', 'cg/x'];
  const table = new Map([['talk.csv', dialogCsv('1,\\px[114]Bob,Hello.\n,,Second line.\n,,\n,,\n3,,\n,,\n,,\n,,\n')]]);
  const dialog = (f, id) => table.get(f.toLowerCase())?.get(id) || null;
  const ctxOf = (d) => ({ names, has: (n) => names.includes(n), texts: d ? { dialog: d } : {} });
  const list = [show(1, 'cg/body'), csvCmd('1'), c(657, ['dialogId = 1']), show(2, 'cg/over'), csvCmd('2'), csvCmd('3'), c(0)];
  const r = runList(list, [], ctxOf(dialog));
  assert.deepStrictEqual(r.scenario.map(short), ['pics:cg/body', 'say:\\px[114]Bob|Hello./Second line.', 'pics:cg/body+cg/over'], 'нет id и пустая реплика — без шага');
  // Альбомы не зависят от таблицы: кадров под репликами плагина нет, рамка окна — упоминание, не картинка
  const r0 = runList(list, [], ctxOf(null));
  assert.deepStrictEqual(r.frames, r0.frames);
  assert.deepStrictEqual(r.mentions, r0.mentions);
  assert.ok(r.mentions.includes('!dialog'));
  assert.ok(!r.frames.some((f) => f.pics.some((p) => p.name === '!dialog')));
  // Рамка стоит на pictureId ещё до реплики: прежняя картинка этого номера на экране уже не видна
  const sl = runList([show(95, 'cg/x'), show(1, 'cg/body'), csvCmd('1'), c(0)], [], ctxOf(dialog));
  assert.deepStrictEqual(sl.scenario.map(short), ['pics:cg/body', 'say:\\px[114]Bob|Hello./Second line.']);
  const keep = runList([show(95, 'cg/x'), show(1, 'cg/body'), csvCmd('1', 'Talk.csv', { pictureName: '' }), c(0)], [], ctxOf(dialog));
  assert.deepStrictEqual(keep.scenario.map(short), ['pics:cg/body+cg/x', 'say:\\px[114]Bob|Hello./Second line.'], 'без pictureName рамки нет, номер не трогаем');
  // Окно выбора Galge: вопрос и варианты, скрытые выключенным переключателем, не показываются; взятого варианта нет
  const galge = (text, choices) => c(357, ['LL_GalgeChoiceWindow', 'showChoice', '選択肢の表示', { messageText: text, choices: JSON.stringify(choices.map((x) => JSON.stringify(x))), variableNumber: '7' }]);
  const g1 = runList([show(1, 'cg/body'), c(121, [10, 10, 1]), galge('Runa is...\nWhat now?', [{ label: 'Stand', switchId: '' }, { label: 'Fall', switchId: '10' }, { label: 'Wait', switchId: '11' }]), c(0)], [], ctxOf(null));
  assert.deepStrictEqual(g1.scenario.map(short), ['pics:cg/body', 'say:|Runa is.../What now?', 'choice:Stand,Wait:-1']);
  assert.deepStrictEqual(runList([show(1, 'cg/body'), galge('', [{ label: 'Yes', switchId: '' }]), c(0)], [], ctxOf(null)).scenario.map(short), ['pics:cg/body', 'choice:Yes:-1'], 'без вопроса — только варианты');
  assert.deepStrictEqual(runList([show(1, 'cg/body'), c(121, [10, 10, 1]), galge('Q', [{ label: 'Hidden', switchId: '10' }]), c(0)], [], ctxOf(null)).scenario.map(short), ['pics:cg/body'], 'все варианты скрыты — плагин команду пропускает');
  assert.strictEqual(galgeChoice(c(357, ['LL_GalgeChoiceWindow', 'showChoice', '', { messageText: 'Q', choices: 'oops' }])), null);
  assert.ok(galgeChoice(c(357, ['plugins/LL_GalgeChoiceWindow', 'showChoice', '', { messageText: 'Q', choices: '[]' }])));
  // Кадров альбома окно выбора не даёт: те же кадры, что и без него
  const gl = [show(1, 'cg/body'), galge('Q', [{ label: 'A', switchId: '' }]), show(2, 'cg/over'), c(0)];
  assert.deepStrictEqual(runList(gl, [], ctxOf(null)).frames, runList([show(1, 'cg/body'), show(2, 'cg/over'), c(0)], [], ctxOf(null)).frames);
  // analyze: таблица приходит через opts.texts; без неё сцены те же, только без реплик и сценария
  const kinds = { 'cg/body': 'cg', 'cg/over': 'layer', '!dialog': 'other', 'cg/x': 'cg' };
  const src = [{ id: 'ce1', name: 'Scene', where: '', list }];
  const A = analyze(src, [], (n) => kinds[n] || null, () => false, names, [], () => false, null, { texts: { dialog } });
  const B = analyze(src, [], (n) => kinds[n] || null, () => false, names, [], () => false, null, {});
  const strip = (x) => JSON.stringify({ g: x.groups.map(({ script, ...g }) => g), clips: x.clips, uses: [...x.uses], shown: [...x.shown], stills: [...x.stills] });
  assert.strictEqual(strip(A), strip(B));
  assert.ok(A.groups[0].script.some((x) => x.k === 'say'));
  assert.ok(!B.groups[0].script, 'без таблицы говорить нечему — сценария нет');
});

test('галерея: сборка читает CSV реплик (регистр имени как на Windows), альбомы те же с таблицей и без, рамка окна — своя картинка', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-csv-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const pics = path.join(root, 'G', 'img', 'pictures');
  await fsp.mkdir(pics, { recursive: true });
  await fsp.mkdir(path.join(root, 'G', 'data'), { recursive: true });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=816x624', '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(pics, 'base.png')]);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue@0.0:s=816x624,format=rgba', '-frames:v', '1', path.join(pics, 'layer.png')]);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black@0.5:s=816x180,format=rgba', '-frames:v', '1', path.join(pics, '!Dialog.png')]);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const csv = (id) => c(357, ['DialogFromCSVwithPic', 'showDialogById', '', { dialogId: id, csvFile: 'Talk.csv', position: 'Bottom', pictureName: '!Dialog', pictureId: '95' }]);
  const galge = c(357, ['LL_GalgeChoiceWindow', 'showChoice', '', { messageText: 'Which one?', choices: JSON.stringify([JSON.stringify({ label: 'Left', switchId: '' }), JSON.stringify({ label: 'Right', switchId: '' })]), variableNumber: '3' }]);
  const events = [c(231, [1, 'base', 0, 0, 0, 0, 100, 100, 255, 0]), csv('1'), c(657, ['x']), c(231, [2, 'layer', 0, 0, 0, 0, 100, 100, 255, 0]), csv('2'), galge, c(0)];
  await fsp.writeFile(path.join(root, 'G', 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Scene', list: events }]));
  await fsp.writeFile(path.join(root, 'G', 'data', 'MapInfos.json'), '[null]');
  const table = path.join(root, 'G', 'data', 'talk.csv');
  await fsp.writeFile(table, '﻿1,\\px[114]Bob,Hello.\r\n,,Second line.\r\n,,\r\n,,\r\n2,,Narration.\r\n,,\r\n,,\r\n,,\r\n');
  const build = async (tag) => {
    const svc = new GalleryService();
    svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, `_media_${tag}`) });
    const index = await svc.runBuild('G', { done: 0, total: 0 });
    const album = index.albums.find((a) => a.key.startsWith('events/'));
    const scene = album && album.script ? await svc.scene('G', album.key) : null;
    const comps = JSON.parse(await fsp.readFile(path.join(root, `_media_${tag}`, 'G', 'gallery-scenes.json'), 'utf8').catch(() => '{}'));
    return { index, album, scene, comps };
  };
  const A = await build('with');
  await fsp.rename(table, `${table}.off`);
  const B = await build('without');
  const short = (x) => (x.k === 'pic' ? `pic:${x.i}` : x.k === 'say' ? `say:${x.who}|${x.text}` : x.k === 'choice' ? `choice:${x.o.join(',')}:${x.i}` : x.k);
  // Сводка сцены (sum) — по сценарию, а с таблицей реплик у сцены текст есть: альбомы сравниваем без неё
  const strip = (idx) => JSON.stringify(idx.albums.map(({ script, sum, ...a }) => a));
  assert.strictEqual(strip(A.index), strip(B.index), 'альбомы с таблицей и без неё одни и те же');
  for (const f of A.index.albums.flatMap((a) => a.files).filter((f) => f.startsWith('@cg/'))) assert.deepStrictEqual(A.comps[f.slice(4)], B.comps[f.slice(4)], 'склейки альбомов (слои, обрезка) те же');
  assert.ok(A.index.albums.some((a) => a.key.endsWith('!Dialog')), 'рамка окна остаётся картинкой в своём альбоме');
  assert.ok(A.album.script);
  assert.deepStrictEqual(A.scene.steps.map(short), ['pic:1', 'say:Bob|Hello.\nSecond line.', 'pic:0', 'say:|Narration.', 'say:|Which one?', 'choice:Left,Right:-1']);
  // Без таблицы остаётся окно выбора: вопрос и варианты
  assert.deepStrictEqual(B.scene.steps.map(short).filter((x) => x.startsWith('say') || x.startsWith('choice')), ['say:|Which one?', 'choice:Left,Right:-1']);
});

test('галерея: таблицы реплик — только файлы из data/, пределы и мусор не роняют сборку', async () => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-csvlim-'));
  const data = path.join(root, 'data');
  await fsp.mkdir(path.join(data, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(data, 'ok.csv'), '1,Bob,Hello.\n,,\n,,\n,,\n');
  await fsp.writeFile(path.join(data, 'sub', 'a.csv'), '1,Bob,Hidden.\n,,\n,,\n,,\n');
  await fsp.writeFile(path.join(root, 'x.csv'), '1,Bob,Outside.\n,,\n,,\n,,\n');
  await fsp.writeFile(path.join(data, 'empty.csv'), '');
  await fsp.writeFile(path.join(data, 'junk.csv'), '\u0000\u0001\n"x\n,,,,\n');
  const cmd = (file) => ({ code: 357, indent: 0, parameters: ['DialogFromCSVwithPic', 'showDialogById', '', { dialogId: '1', csvFile: file }] });
  const svc = new GalleryService();
  try {
    const lists = [['ok.csv', 'OK.CSV', '../x.csv', 'sub/a.csv', 'sub\\a.csv', 'empty.csv', 'junk.csv', 'missing.csv'].map(cmd)];
    const look = await svc.dialogTables(root, lists);
    assert.strictEqual(look('ok.csv', '1').lines[0], 'Hello.', 'файл из data/ читается');
    assert.ok(look('OK.CSV', '1'), 'регистр имени не важен');
    for (const f of ['../x.csv', 'sub/a.csv', 'sub\\a.csv', 'empty.csv', 'missing.csv']) assert.strictEqual(look(f, '1'), null, `${f}: реплик нет`);
    assert.strictEqual(look('junk.csv', '1'), null, 'битый CSV: реплик нет');
    // Ни одного допустимого файла — таблиц нет, и это не ошибка
    assert.strictEqual(await svc.dialogTables(root, [['../x.csv', 'sub/a.csv', 'nope.csv'].map(cmd)]), null);
    assert.strictEqual(await svc.dialogTables(path.join(root, 'нет-игры'), lists), null, 'нет data/ — null');
    // Файл больше предела пропускается
    await fsp.writeFile(path.join(data, 'big.csv'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x41));
    assert.strictEqual((await svc.dialogTables(root, [['big.csv', 'ok.csv'].map(cmd)]))('big.csv', '1'), null, 'больше предела — пропущен');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('галерея: события «прокручиваются» на бумаге — слои, перемещение, стирание, общие события, все ветки, кадры по репликам', () => {
  const { runList, analyze, clipsOf } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, x = 0, y = 0, o = 0, op = 255, indent = 0) => c(231, [n, name, o, 0, x, y, 100, 100, op, 0], indent);
  const msg = (t) => [c(101), c(401, [t])];
  const ces = [null, { id: 1, list: [show(3, 'overlay'), ...msg('Из общего'), c(0)] }];
  const list = [show(1, 'base'), show(2, 'body', 10, 20, 1), ...msg('Привет'), c(117, [1]), c(235, [2]), c(230, [20]),
    // «Если» с переключателем, которого событие не ставит: обе ветки — варианты сцены, каждая от того, что было до развилки;
    // выбор — тоже все варианты
    c(111, [0, 5, 0]), show(4, 'then', 0, 0, 0, 255, 1), c(0, [], 1), c(411), show(4, 'else', 0, 0, 0, 255, 1), c(0, [], 1), c(412),
    c(102, [['A', 'B']]), c(402, [0, 'A']), show(5, 'choiceA', 0, 0, 0, 255, 1), c(0, [], 1), c(402, [1, 'B']), show(5, 'choiceB', 0, 0, 0, 255, 1), c(0, [], 1), c(404),
    ...msg('конец'), c(0)];
  const r = runList(list, ces);
  assert.deepStrictEqual(r.frames.map((f) => [f.pics.map((p) => p.name).join('+'), !!f.alt]), [
    ['base+body', false],
    ['base+body+overlay', false],          // общее событие внутри — в тот же кадр
    ['base+overlay', false],               // тело стёрто, потом пауза
    ['base+overlay+then', false],
    ['base+overlay+else', true],           // вариант из другой ветки
    ['base+overlay+then+choiceA', false],  // дальше — от своей ветки; реплика «конец» этот кадр не повторяет
    ['base+overlay+then+choiceB', true],
  ]);
  assert.deepStrictEqual([r.frames[0].pics[1].x, r.frames[0].pics[1].y, r.frames[0].pics[1].o], [10, 20, 1]);
  assert.strictEqual(r.frames[2].wait, 20);

  // Анимация — кадры без реплик с короткими паузами: три разных и больше, или два в цикле; реплика рвёт клип
  const talk = (who) => [show(1, `${who}_normal`), ...msg('…'), show(1, `${who}_smile`), ...msg('…'), c(0)];
  const sources = [
    { id: 'ce1', name: 'Сцена', where: '', list: [show(1, 'cg_a1'), ...msg('x'), show(2, 'cg_a2'), ...msg('y'), c(0)] },
    { id: 'ce2', name: 'Кадры', where: '', list: [show(1, 'fr_1'), c(230, [4]), show(1, 'fr_2'), c(230, [4]), show(1, 'fr_3'), c(230, [4]), c(0)] },
    ...[3, 4, 5, 6, 7].map((i) => ({ id: `ce${i}`, name: 'EV', where: '', list: talk('Freya') })),
  ];
  const kinds = { cg_a1: 'cg', cg_a2: 'layer', fr_1: 'cg', fr_2: 'cg', fr_3: 'cg', freya_normal: 'cg', freya_smile: 'cg' };
  const found = analyze(sources, [], (n) => kinds[n] || null);
  assert.deepStrictEqual(found.clips.map((x) => [x.id, x.title, x.finished.map((f) => f.name), x.wait]), [['ce2', 'Кадры', ['fr_1', 'fr_2', 'fr_3'], 4]]);
  // Кадры анимации — не в альбом события; портрет разговора — не CG
  assert.deepStrictEqual(found.groups.map((g) => [g.id, g.finished.length]), [['ce1', 2]]);
  assert.ok(found.shown.has('Freya_smile'), 'показанные событиями картинки — для правила раскадровки по именам');
  const frames = (l) => runList(l, []).frames;
  const loop = [show(1, 'p_1'), ...msg('Начали'), c(112), show(1, 'p_1'), c(230, [6]), show(1, 'p_2'), c(230, [6]), c(413), ...msg('Ах'), c(0)];
  assert.deepStrictEqual(clipsOf(frames(loop)).map((cl) => cl.map((f) => f.pics[0].name)), [['p_1', 'p_2']], 'два кадра в цикле — анимация');
  // Две разные анимации на одной основе — обе; повтор первой в комнате (поверх рамка «REC», она во многих событиях) — один раз
  const anim = (layers, extra = []) => [show(1, 'b'), ...msg('…'), ...layers.flatMap((l) => [show(2, l), ...extra.map((x, i) => show(3 + i, x)), c(230, [5])]), ...msg('…'), c(0)];
  const dup = analyze([
    { id: 'ce10', name: 'A', where: '', list: anim(['x1', 'x2', 'x3']) },
    { id: 'ce11', name: 'B', where: '', list: anim(['y1', 'y2', 'y3']) },
    { id: 'm9e1p0', name: 'Повтор A', where: 'Комната', list: anim(['x1', 'x2', 'x3'], ['rec']) },
    ...[12, 13, 14].map((id) => ({ id: `ce${id}`, name: 'R', where: '', list: [show(1, 'rec'), ...msg('…'), c(0)] })),
  ], [], (n) => (n === 'b' ? 'cg' : 'layer'));
  assert.deepStrictEqual(dup.clips.map((x) => [x.id, x.finished.length]), [['ce10', 3], ['ce11', 3]]);
  const pages = [show(1, 'v_1'), c(230, [10]), show(1, 'v_2'), ...msg('…'), show(1, 'v_3'), c(230, [60]), show(1, 'v_4'), c(230, [10]), c(0)];
  assert.deepStrictEqual(clipsOf(frames(pages)), [], 'страницы с репликами и долгими паузами — не анимация');
});

test('галерея: на бумаге — переменные и счётчик в цикле, скрипт showPicture, PictureAnimation, имя с переменной, ролики-петли', () => {
  const { runList, clipsOf, evaluate, tokenize } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const msg = (t) => [c(101), c(401, [t])];
  const names = ['fr_1', 'fr_2', 'fr_3', 'fr_4', 'fr_5', 'sheet', 'pa_00', 'pa_01', 'pa_02', 'pa_03', 'cg/bath/ani_1', 'cg/bath/ani_2', 'cg/bath/ani_3', 'scene_body', 'ev_mika'];
  const ctx = { names, has: (n) => names.includes(n), movies: ['loop_a', 'loop_b', 'intro'] };
  const pics = (r) => r.frames.map((f) => f.pics.map((p) => p.name + (p.cell ? `#${p.cell.i}/${p.cell.n}${p.cell.dir}` : '')).join('+'));
  // Счётчик кадров: переменная 5 от 1, «Если 5 > 4 — выйти из цикла»: условие знаем — цикл крутится до конца
  const counter = [c(122, [5, 5, 0, 0, 1]), c(112),
    c(355, ['$gameScreen.showPicture(1, "fr_" + $gameVariables.value(5),'], 1), c(655, ['0, 0, 0, 100, 100, 255, 0);'], 1), c(230, [4], 1),
    c(122, [5, 5, 1, 0, 1], 1), c(111, [1, 5, 0, 4, 3], 1), c(113, [], 2), c(0, [], 2), c(412, [], 1), c(0, [], 1), c(413), ...msg('Всё'), c(0)];
  const r1 = runList(counter, [], ctx);
  assert.deepStrictEqual(pics(r1), ['fr_1', 'fr_2', 'fr_3', 'fr_4']);
  assert.deepStrictEqual(clipsOf(r1.frames).map((cl) => cl.length), [4]);
  // Свои переменные скрипта: «name = …», потом «showPicture(num, name, …)»; номер по неизвестной переменной + 23 — 23
  const vars = [c(355, ['name = "scene_body"; num = 3']), c(655, ['$gameScreen.showPicture(num,name,0,0,0,100,100,255,0)']),
    c(355, ['$gameScreen.showPicture($gameVariables.value(106)+23,"ev_mika",0,$gameVariables.value(105),0,100,100,255,0)']), ...msg('…'),
    c(355, ['for(var i = 0; i <= 100; i++){$gameScreen.erasePicture(i)}']), c(355, ['$gameScreen.showPicture(1,"fr_5",0,0,0,100,100,255,0)']), ...msg('…'), c(0)];
  assert.deepStrictEqual(runList(vars, [], ctx).frames.map((f) => f.pics.map((p) => `${p.n}:${p.name}`)), [['3:scene_body', '23:ev_mika'], ['1:fr_5']]);
  // PictureAnimation: лист из 4 кадров по горизонтали — кадры склейкой с обрезкой; кадры-файлы «pa_00…pa_03» туда и обратно
  const pa = [c(356, ['PA_INIT 4 6 横']), c(231, [1, 'sheet', 0, 0, 0, 0, 100, 100, 255, 0]), c(356, ['PA_START_LOOP 1 1']), ...msg('a'),
    c(235, [1]), c(357, ['PictureAnimation', 'INIT', '', { cellNumber: '4', frameNumber: '3', direction: 'number', fade: '0' }]),
    c(231, [2, 'pa_00', 0, 0, 0, 0, 100, 100, 255, 0]), c(357, ['PictureAnimation', 'START', '', { pictureNumber: '2', loop: 'false', animationType: '2' }]), ...msg('b'), c(0)];
  const r3 = runList(pa, [], ctx);
  assert.deepStrictEqual(pics(r3), ['sheet#0/4h', 'sheet#1/4h', 'sheet#2/4h', 'sheet#3/4h', 'sheet#0/4h', 'pa_00', 'pa_01', 'pa_02', 'pa_03', 'pa_02', 'pa_01', 'pa_00']);
  assert.deepStrictEqual(clipsOf(r3.frames).map((cl) => [cl.length, cl[0].wait]), [[4, 6], [6, 3]], 'кадры плагина — анимация и под репликами');
  // Имя с переменной, которой событие не ставит: кадр на каждый подходящий файл (в цикле с паузами — анимация)
  const wild = [c(112), c(355, ['$gameScreen.showPicture(1, "CG/Bath/ani_" + $gameVariables.value(149), 0, 0, 0, 100, 100, 255, 0);'], 1), c(230, [5], 1), c(0, [], 1), c(413), ...msg('!'), c(0)];
  // (под репликой после цикла — первый из них)
  assert.deepStrictEqual(pics(runList(wild, [], ctx)), ['cg/bath/ani_1', 'cg/bath/ani_2', 'cg/bath/ani_3', 'cg/bath/ani_1']);
  // Слишком общее имя («tachie/» + кто) — не гадаем
  assert.deepStrictEqual(runList([c(231, [1, '\\V[3]', 0, 0, 0, 0, 100, 100, 255, 0]), ...msg('?'), c(0)], [], ctx).frames, []);
  // Ролики: «loop: true» — петля сцены; имена в аргументах плагинов — картинки сцены; предзагрузка — не сцена
  const mv = [c(357, ['MoviePicture', 'PREPARE', '', { fileName: 'loop_a', loop: 'true' }]), c(356, ['MP_SET_MOVIE loop_b on']), c(231, [9, '', 0, 0, 0, 0, 100, 100, 255, 0]),
    c(356, ['MP_SET_LOOP 9 on']), c(357, ['MoviePicture', 'PREPARE', '', { fileName: 'intro', loop: 'false' }]), c(356, ['ShowCg ev_mika']),
    c(355, ['ImageManager.loadPicture("fr_1")']), c(0)];
  const r5 = runList(mv, [], ctx);
  assert.deepStrictEqual([...r5.movies], [['loop_a', true], ['loop_b', true], ['intro', false]]);
  assert.deepStrictEqual(r5.mentions, ['ev_mika']);
  // Выражения: неизвестное — дыра в имени, числа и строки — как в JS
  const env = { vars: new Map([[3, 7]]), sw: new Map(), js: new Map() };
  assert.strictEqual(evaluate(tokenize('"CG/a/" + $gameVariables.value(3).padZero(2)'), env), 'CG/a/07');
  assert.strictEqual(evaluate(tokenize('"x_" + $gameVariables.value(4)'), env), 'x_\u0001');
  assert.strictEqual(evaluate(tokenize('($gameVariables.value(3) + 1) * 2'), env), 16);
  // «и»/«или» слабее сравнений: 7 == 1 && 3 == 0 — ложь, 7 == 7 || … — истина; неизвестное с ложью через «и» — ложь
  const two = { vars: new Map([[1, 7], [2, 3]]), sw: new Map(), js: new Map() };
  assert.strictEqual(evaluate(tokenize('$gameVariables.value(1) == 1 && $gameVariables.value(2) == 0'), two), false);
  assert.strictEqual(evaluate(tokenize('$gameVariables.value(1) == 2 || $gameVariables.value(2) == 3'), two), true);
  assert.strictEqual(evaluate(tokenize('$gameVariables.value(9) == 1 && $gameVariables.value(2) == 0'), two), false);
  assert.strictEqual(evaluate(tokenize('$gameVariables.value(9) == 1 || $gameVariables.value(2) == 0'), two).toString(), 'Symbol(unknown)');
  // «variable = …» — переменная «variable», а не «var iable»
  const word = [c(355, ['variable = "scene_body"']), c(355, ['$gameScreen.showPicture(1, variable, 0, 0, 0, 100, 100, 255, 0)']), ...msg('…'), c(0)];
  assert.deepStrictEqual(pics(runList(word, [], ctx)), ['scene_body']);
  // Стереть по номеру, которого не знаем (не переменная цикла), — ничего не стирает
  const keep = [c(231, [1, 'fr_1', 0, 0, 0, 0, 100, 100, 255, 0]), c(355, ['$gameScreen.erasePicture($gameVariables.value(106) + 3)']), ...msg('…'), c(0)];
  assert.deepStrictEqual(pics(runList(keep, [], ctx)), ['fr_1']);
  // Кадр главной ветки, совпавший с последним вариантом, остаётся кадром главной ветки
  const fork = [c(111, [0, 9, 0]), c(231, [1, 'fr_1', 0, 0, 0, 0, 100, 100, 255, 0], 1), c(0, [], 1), c(411), c(231, [1, 'fr_2', 0, 0, 0, 0, 100, 100, 255, 0], 1), c(0, [], 1), c(412),
    c(231, [1, 'fr_2', 0, 0, 0, 0, 100, 100, 255, 0]), ...msg('…'), c(0)];
  assert.deepStrictEqual(runList(fork, [], ctx).frames.map((f) => `${f.pics[0].name}${f.alt ? ' alt' : ''}${f.msg ? ' m' : ''}`), ['fr_1', 'fr_2 alt', 'fr_2 m']);
  // Кадр конца ветки снят без реплики; реплика сразу после развилки — его пометка, а не новый кадр
  const fork2 = [...fork.slice(0, 7), ...msg('…'), c(0)];
  assert.deepStrictEqual(runList(fork2, [], ctx).frames.map((f) => `${f.pics[0].name}${f.alt ? ' alt' : ''}${f.msg ? ' m' : ''}`), ['fr_1 m', 'fr_2 alt']);
  // «Стереть все» скриптом; смена старой картинки на новую, «разбить» и привязанные к родителю (advanced_pictures,
  // NGT_Shatter у Seven Keys) — прошлая сцена не остаётся под новой
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const clear = [show(1, 'fr_1'), show(2, 'fr_2'), ...msg('…'), c(355, ['$gameScreen.clearPictures();']), show(3, 'fr_3'), ...msg('…'),
    show(4, 'fr_4'), c(357, ['auramz/advanced_pictures', 'attachChildren', '', { parentId: '3', childrenIds: '["4"]' }]), ...msg('…'),
    c(357, ['auramz/advanced_pictures', 'transition', '', { oldPictureId: '3', newPictureId: '5' }]), show(5, 'fr_5'), show(6, 'fr_1'), ...msg('…'),
    c(357, ['thirdparty/NGT_Shatter', 'shatterPicture', '', { method: 'simple_crash', pictureId: '6' }]), ...msg('…'), c(0)];
  assert.deepStrictEqual(pics(runList(clear, [], ctx)), ['fr_1+fr_2', 'fr_3', 'fr_3+fr_4', 'fr_5+fr_1', 'fr_5']);
  const keep2 = [show(1, 'fr_1'), show(2, 'fr_2'), c(357, ['auramz/advanced_pictures', 'attachChildren', '', { parentId: '1', childrenIds: '["2"]' }]),
    show(2, 'fr_3'), c(357, ['FilterControllerMZ', 'clearEffect', '', { pictureId: '2' }]), c(235, [1]), ...msg('…'), c(0)];
  assert.deepStrictEqual(pics(runList(keep2, [], ctx)), ['fr_3'], 'clearEffect — не стирание; новая картинка под номером 2 к первой не привязана');
  // Несколько неизвестных частей подряд — шаблон всё равно быстрый
  const many = { names: Array.from({ length: 20000 }, (_, i) => `pic_${i}_x`), has: () => true };
  const t0 = Date.now();
  runList([c(231, [1, 'zzz\\V[1]\\V[2]\\V[3]\\V[4]\\V[5]q', 0, 0, 0, 0, 100, 100, 255, 0]), ...msg('…'), c(0)], [], many);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} мс`);
});

test('галерея: общее событие, которое не открыли из-за глубины, забывает только то, что пишет; JS «if … else» — одна ветка', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const msg = (t) => [c(101), c(401, [t])];
  const js = (src) => c(355, [src]);
  const show = (n, expr) => js(`$gameScreen.showPicture(${n}, ${expr}, 0, 0, 0, 100, 100, 255, 0);`);
  const names = ['pose/7/body_1', 'pose/8/body_1', 'pose/7/eyes_3', 'pose/7/eyes_3_r', 'pic_a', 'pic_b', 'pic_c', 'pic_x'];
  const ctx = { names, has: (n) => names.includes(n), movies: [] };
  const pics = (r) => r.frames.map((f) => f.pics.map((p) => p.name).join('+'));
  // Сцена ставит позу (переменная 1) и номер 2, зовёт цепочку в три яруса, а четвёртое событие (его не открывают) — из третьего;
  // картинки показывает сцена после возврата. Раньше четвёртое событие стирало все переменные, и имя «pose/…/body_1»
  // подходило всем позам. tail — что пишет это неоткрытое событие
  const chain = (tail) => [null, { list: [c(117, [2]), c(0)] }, { list: [c(117, [3]), c(0)] }, { list: [c(117, [4]), c(0)] }, { list: [...tail, c(0)] }, { list: [c(122, [2, 2, 0, 0, 0]), c(0)] }];
  const scene = [c(122, [1, 1, 0, 0, 7]), c(122, [2, 2, 0, 0, 8]), c(117, [1]), show(1, '"pose/" + $gameVariables.value(1) + "/body_1"'), show(2, '"zz/" + $gameVariables.value(2)'), ...msg('…'), c(0)];
  assert.deepStrictEqual(pics(runList(scene, chain([]), ctx)), ['pose/7/body_1+zz/8'], 'неоткрытое событие ничего не пишет — известно всё');
  assert.deepStrictEqual(pics(runList(scene, chain([c(122, [2, 2, 0, 0, 0])]), ctx)), ['pose/7/body_1'], 'переменная 1 цела, 2 забыта (её картинка без имени не показана)');
  assert.deepStrictEqual(pics(runList(scene, chain([js('$gameVariables.setValue(2, 1);')]), ctx)), ['pose/7/body_1'], 'запись скриптом — тоже запись');
  assert.deepStrictEqual(pics(runList(scene, chain([c(117, [5])]), ctx)), ['pose/7/body_1'], 'то, что пишет вложенное событие, — тоже');
  assert.ok(!pics(runList(scene, chain([js('$gameVariables.setValue($gameVariables.value(9), 1);')]), ctx)).some((x) => x.includes('zz/8')), 'номер из выражения — что записано, не знаем: забываем всё');
  // Ввод числа, выбор предмета, данные места: переменную ставит игра — тоже запись
  for (const code of [103, 104, 285]) assert.deepStrictEqual(pics(runList(scene, chain([c(code, [2, 1])]), ctx)), ['pose/7/body_1'], `команда ${code} пишет переменную`);
  // Диапазон переключателей (121): сцена знает «выключен» (else), неоткрытое событие мог включить — условие неизвестно, первая ветка
  const swScene = [c(121, [5, 5, 1]), c(117, [1]), c(355, ['if ($gameSwitches.value(5)) {']), c(655, ['$gameVariables.setValue(3, "pic_a");']), c(655, ['} else {']), c(655, ['$gameVariables.setValue(3, "pic_b");']), c(655, ['}']), show(1, '$gameVariables.value(3)'), ...msg('…'), c(0)];
  assert.deepStrictEqual(pics(runList(swScene, chain([]), ctx)), ['pic_b'], 'неоткрытое событие переключатель не трогает — выключен');
  assert.deepStrictEqual(pics(runList(swScene, chain([c(121, [4, 6, 0])]), ctx)), ['pic_a'], 'диапазон переключателей забыт');
  // JS «if … else»: условие знаем — одна ветка; не знаем — первая; цепочка else-if; без скобок — как прежде
  const jsl = (...lines) => lines.map((l, i) => c(i ? 655 : 355, [l]));
  const branch = (cond, extra = []) => runList([...extra, ...jsl(`if (${cond}) {`, '$gameVariables.setValue(3, "pic_a");', '} else if ($gameVariables.value(9) == 2) {', '$gameVariables.setValue(3, "pic_b");',
    '} else {', '$gameVariables.setValue(3, "pic_c");', '}'), show(1, '$gameVariables.value(3)'), ...msg('…'), c(0)], [], ctx);
  assert.deepStrictEqual(pics(branch('$gameSwitches.value(4)', [c(121, [4, 4, 0])])), ['pic_a'], 'условие истинно — первая ветка');
  assert.deepStrictEqual(pics(branch('$gameSwitches.value(4)', [c(121, [4, 4, 1]), c(122, [9, 9, 0, 0, 2])])), ['pic_b'], 'ложно, else-if истинно — вторая');
  assert.deepStrictEqual(pics(branch('$gameSwitches.value(4)', [c(121, [4, 4, 1]), c(122, [9, 9, 0, 0, 5])])), ['pic_c'], 'всё ложно — else');
  assert.deepStrictEqual(pics(branch('$gameSwitches.value(4)')), ['pic_a'], 'условие неизвестно — первая ветка, а не последняя');
  // Имя из самой переменной («setValue(94, "pose/" + … + value(94))») в двух ветках: приставка одна, а не обе подряд
  const eyes = (sw) => runList([c(122, [1, 1, 0, 0, 7]), c(122, [94, 94, 0, 0, 3]), ...(sw === undefined ? [] : [c(121, [8, 8, sw])]),
    ...jsl('if(!$gameSwitches.value(8)){', ' $gameVariables.setValue(94, "pose/" + $gameVariables.value(1).toString() + "/eyes_" + $gameVariables.value(94).toString());',
      '}else{', ' $gameVariables.setValue(94, "pose/" + $gameVariables.value(1).toString() + "/eyes_" + $gameVariables.value(94).toString() + "_r");', '}'),
    show(1, '$gameVariables.value(94)'), ...msg('…'), c(0)], [], ctx);
  assert.deepStrictEqual(pics(eyes(1)), ['pose/7/eyes_3'], 'переключатель выключен');
  assert.deepStrictEqual(pics(eyes(0)), ['pose/7/eyes_3_r'], 'включён — вторая ветка');
  assert.deepStrictEqual(pics(eyes()), ['pose/7/eyes_3'], 'неизвестен — первая');
  // Вложенное «if» в теле цикла и «if» с действием без скобок идут как прежде
  assert.deepStrictEqual(pics(runList([c(121, [4, 4, 1]), js('if ($gameSwitches.value(4)) $gameVariables.setValue(3, "pic_x");'), show(1, '$gameVariables.value(3)'), ...msg('…'), c(0)], [], ctx)), ['pic_x']);
  // Известное ложное значение не-булева типа (0, пустая строка) — тоже ложь: идём во вторую ветку
  const falsy = (init) => runList([c(122, [5, 5, 0, 0, init]), ...jsl('if ($gameVariables.value(5)) {', '$gameVariables.setValue(3, "pic_a");', '} else {', '$gameVariables.setValue(3, "pic_b");', '}'), show(1, '$gameVariables.value(3)'), ...msg('…'), c(0)], [], ctx);
  assert.deepStrictEqual(pics(falsy(0)), ['pic_b'], 'переменная равна 0 — else');
  assert.deepStrictEqual(pics(falsy(2)), ['pic_a'], 'не ноль — первая ветка');
  // Блочный комментарий: апостроф и скобки в нём не открывают строку и блок; «else if» без скобок не ломает разбор
  const cmt = (sw) => runList([c(121, [4, 4, sw]), ...jsl("/* it's { a trap */ if ($gameSwitches.value(4)) { // {", '$gameVariables.setValue(3, "pic_a"); /* } else { */', '} else {', '$gameVariables.setValue(3, "pic_b");', '}'), show(1, '$gameVariables.value(3)'), ...msg('…'), c(0)], [], ctx);
  assert.deepStrictEqual(pics(cmt(0)), ['pic_a'], 'комментарии со скобками не сдвигают блок: истинно — первая ветка');
  assert.deepStrictEqual(pics(cmt(1)), ['pic_b'], 'ложно — вторая');
  assert.deepStrictEqual(pics(runList([c(121, [4, 4, 0]), ...jsl('if ($gameSwitches.value(4)) {', '$gameVariables.setValue(3, "pic_a");', '} else if ($gameVariables.value(9) == 2) $gameVariables.setValue(3, "pic_b");'), show(1, '$gameVariables.value(3)'), ...msg('…'), c(0)], [], ctx)), ['pic_a'], 'else if без скобок — не ломает, истинная первая ветка идёт');
  // Общие события зовут друг друга по кругу (4 зовёт 6, 6 зовёт 4): не зацикливается; повторный вызов даёт то же самое. Вложенный
  // подсчёт не отравляет кэш: 6 посчитали внутри 4 (там 4 уже в обходе), а потом зовут 6 сами — запись переменной 2 из 4 должна быть
  const loop = [null, { list: [c(117, [2]), c(0)] }, { list: [c(117, [3]), c(0)] }, { list: [c(117, [4]), c(122, [2, 2, 0, 0, 8]), c(117, [6]), c(0)] },
    { list: [c(117, [6]), c(122, [2, 2, 0, 0, 0]), c(0)] }, null, { list: [c(117, [4]), c(0)] }];
  assert.deepStrictEqual(pics(runList(scene, loop, ctx)), ['pose/7/body_1'], 'цикл событий: запись переменной 2 забыта и после второго вызова');
  assert.deepStrictEqual(pics(runList(scene, loop, ctx)), ['pose/7/body_1'], 'повторный прогон — тот же набор записей');
  // Ветка без скобок идёт, только если условия до неё ложны
  assert.deepStrictEqual(pics(runList([c(121, [4, 4, 1]), c(122, [9, 9, 0, 0, 2]), ...jsl('if ($gameSwitches.value(4)) {', '$gameVariables.setValue(3, "pic_a");', '} else if ($gameVariables.value(9) == 2) $gameVariables.setValue(3, "pic_b");'), show(1, '$gameVariables.value(3)'), ...msg('…'), c(0)], [], ctx)), ['pic_b'], 'else if без скобок: условие ложно, else-if истинно');
});

test('галерея: лёгкая копия для просмотра — анимация держит повтор и задержку последнего кадра, мало места — оригинал, forget стирает view/', async (t) => {
  const { GalleryService, apngInfo } = require('./src/services/gallery.js');
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-view-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const pics = path.join(root, 'G', 'img', 'pictures');
  await fsp.mkdir(pics, { recursive: true });
  // Три шумных кадра покрупнее порога в 256 КБ; задержки разные, последняя — своя
  const work = path.join(root, 'work');
  await fsp.mkdir(work);
  for (let i = 1; i <= 3; i++) spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=320x240:seed=${i}:d=1`, '-vf', 'noise=alls=25:allf=t', '-frames:v', '1', path.join(work, `f${i}.png`)]);
  await fsp.writeFile(path.join(work, 'l.txt'), 'file f1.png\nduration 0.1\nfile f2.png\nduration 0.1\nfile f3.png\nduration 0.5\nfile f3.png\n');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-i', path.join(work, 'l.txt'), '-plays', '3', '-f', 'apng', path.join(pics, 'anim.png')]);
  await fsp.copyFile(path.join(work, 'f1.png'), path.join(pics, 'still.png'));
  await fsp.writeFile(path.join(pics, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  await svc.runBuild('G', { done: 0, total: 0 });

  const orig = await fsp.readFile(path.join(pics, 'anim.png'));
  const info = apngInfo(orig);
  assert.deepStrictEqual(info && info.plays, 3, 'число проигрываний прочитано из acTL');
  const copy = await svc.view('G', 'img/pictures/anim.png');
  assert.ok(copy && copy.startsWith(path.join(root, '_media', 'G', 'view')), 'копия лежит в _media/<игра>/view/');
  const webp = await fsp.readFile(copy);
  assert.ok(webp.length <= orig.length * 0.8, 'копия не больше 80 % оригинала');
  const chunks = [];
  for (let at = 12; at + 8 <= webp.length;) {
    const len = webp.readUInt32LE(at + 4);
    chunks.push([webp.toString('latin1', at, at + 4), webp.subarray(at + 8, at + 8 + len)]);
    at += 8 + len + (len & 1);
  }
  assert.strictEqual(chunks.find(([n]) => n === 'ANIM')[1].readUInt16LE(4), 3, 'повтор из оригинала, а не один раз');
  const frames = chunks.filter(([n]) => n === 'ANMF');
  assert.ok(frames.length >= 3, 'кадры на месте');
  assert.strictEqual(frames[frames.length - 1][1].readUIntLE(12, 3), info.delay, 'задержка последнего кадра — из fcTL');
  assert.strictEqual(await svc.view('G', 'img/pictures/anim.png'), copy, 'второй раз — та же копия, без ffmpeg');

  // Неподвижная картинка — один кадр без ANMF; крошечная — оригинал; GIF, JPEG и склейки не трогаем
  const still = await svc.view('G', 'img/pictures/still.png');
  assert.ok(still && (await fsp.readFile(still)).subarray(8, 12).toString() === 'WEBP');
  assert.strictEqual(await svc.view('G', 'img/pictures/tiny.png'), null);
  assert.strictEqual(await svc.view('G', 'img/pictures/none.png'), null);
  assert.strictEqual(await svc.view('G', '@cg/0123456789abcdef0123'), null);

  // Крупный оригинал: сейчас отдаём его, копия делается фоном и к следующему разу готова
  await fsp.rm(path.join(root, '_media', 'G', 'view'), { recursive: true, force: true });
  svc.viewWaitMax = 0;
  assert.strictEqual(await svc.view('G', 'img/pictures/still.png'), null, 'человек копию не ждёт');
  for (let i = 0; i < 100 && svc.viewJobs.size; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await svc.view('G', 'img/pictures/still.png'), 'фон сделал копию');
  svc.viewWaitMax = 3 * 1024 * 1024;

  // Мало места: копию не пишем, отдаём оригинал; освободилось — получится
  await fsp.rm(path.join(root, '_media', 'G', 'view'), { recursive: true, force: true });
  svc.viewMinFree = Infinity;
  assert.strictEqual(await svc.view('G', 'img/pictures/still.png'), null);
  assert.deepStrictEqual((await fsp.readdir(path.join(root, '_media', 'G', 'view')).catch(() => [])), [], 'ни копии, ни пустого маркера');
  svc.viewMinFree = 0;
  assert.ok(await svc.view('G', 'img/pictures/still.png'));

  await svc.forget('G');
  assert.strictEqual(fs.existsSync(path.join(root, '_media', 'G', 'view')), false, 'forget стирает копии');
});

test('галерея: лёгкая копия — временный сбой ffmpeg маркером не отмечается, замена файла того же размера даёт новую копию, потолок view/, обход вперёд только для больших', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-view2-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const pics = path.join(root, 'G', 'img', 'pictures');
  await fsp.mkdir(pics, { recursive: true });
  for (const n of ['a', 'b']) spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=320x240:seed=3:d=1', '-vf', 'noise=alls=25:allf=t', '-frames:v', '1', path.join(pics, `${n}.png`)]);
  await fsp.writeFile(path.join(pics, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  await svc.runBuild('G', { done: 0, total: 0 });
  const viewDir = path.join(root, '_media', 'G', 'view');

  // ffmpeg не запустился (как таймаут или kill под нагрузкой): ни копии, ни пустого маркера; позже — получится
  const oldPath = process.env.PATH;
  process.env.PATH = path.join(root, 'nothing');
  try { assert.strictEqual(await svc.view('G', 'img/pictures/a.png'), null); } finally { process.env.PATH = oldPath; }
  assert.deepStrictEqual(await fsp.readdir(viewDir).catch(() => []), [], 'маркера нет');
  svc.viewFail.clear();
  const first = await svc.view('G', 'img/pictures/a.png');
  assert.ok(first, 'после сбоя копия получилась');

  // Файл заменили на такой же по размеру, но другой по времени: копия не старая
  const file = path.join(pics, 'a.png');
  const when = new Date(Date.now() + 60000);
  await fsp.utimes(file, when, when);
  const second = await svc.view('G', 'img/pictures/a.png');
  assert.ok(second && second !== first, 'ключ копии зависит от mtime');

  // Маленький файл обход вперёд не запускает; большой — один раз
  await svc.view('G', 'img/pictures/tiny.png');
  assert.ok(![...svc.aheaded].some((k) => k.includes('tiny.png')));
  assert.ok([...svc.aheaded].some((k) => k.endsWith('a.png')));
  const n = svc.aheaded.size;
  await svc.view('G', 'img/pictures/a.png');
  assert.strictEqual(svc.aheaded.size, n, 'повторный запрос обход не множит');

  // Потолок view/ на игру: сверх него оригинал
  for (let i = 0; i < 100 && svc.viewJobs.size; i++) await new Promise((r) => setTimeout(r, 50));
  svc.viewDirMax = 1;
  await fsp.utimes(path.join(pics, 'b.png'), when, when);
  assert.strictEqual(await svc.view('G', 'img/pictures/b.png'), null);
});

test('галерея: размер экрана — у последнего из включённых плагинов, выключенный не считается', async () => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-'));
  fs.mkdirSync(path.join(root, 'js'));
  const plugin = (name, status, w, h) => `{"name":"${name}","status":${status},"description":"","parameters":{"Screen Width":"${w}","Screen Height":"${h}"}}`;
  const screen = async (...list) => {
    fs.writeFileSync(path.join(root, 'js', 'plugins.js'), `var $plugins = [${list.join(',')}];`);
    return new GalleryService().screenFor(root, new Map());
  };
  try {
    // Плагины грузятся по порядку, каждый перезаписывает размер: побеждает последний
    assert.deepStrictEqual(await screen(plugin('YEP_CoreEngine', true, 816, 624), plugin('Community_Basic', true, 1280, 720)), { w: 1280, h: 720 });
    assert.deepStrictEqual(await screen(plugin('Community_Basic', true, 1280, 720), plugin('YEP_CoreEngine', true, 816, 624)), { w: 816, h: 624 });
    // Выключенный плагин размер не меняет, где бы он ни стоял
    assert.deepStrictEqual(await screen(plugin('YEP_CoreEngine', true, 1280, 720), plugin('Other', false, 816, 624)), { w: 1280, h: 720 });
    assert.deepStrictEqual(await screen(plugin('Other', false, 1280, 720), plugin('YEP_CoreEngine', true, 960, 540)), { w: 960, h: 540 });
    // Три и больше плагинов: последний включённый, выключенные в конце и в середине не мешают
    assert.deepStrictEqual(await screen(plugin('A', true, 816, 624), plugin('B', true, 1280, 720), plugin('C', true, 960, 540)), { w: 960, h: 540 });
    assert.deepStrictEqual(await screen(plugin('A', true, 816, 624), plugin('B', true, 1280, 720), plugin('C', false, 960, 540)), { w: 1280, h: 720 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('галерея: стандартные ресурсы движка и папки плагинов — «Системные»; сцена из событий: кадр склеивается ffmpeg', async (t) => {
  const { GalleryService, classify, isRtp } = require('./src/services/gallery.js');
  const screen = { w: 816, h: 624 };
  assert.strictEqual(isRtp('img/titles1/Castle.png', 1049553), true);
  assert.strictEqual(isRtp('img/titles1/Castle.rpgmvp', 1049553 + 16), true);
  assert.strictEqual(isRtp('img/titles1/Castle.png', 1000), false, 'тот же имя, но свой файл');
  assert.strictEqual(isRtp('img/pictures/Castle.png', 1049553), false);
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000 }, screen, 'img/Map__ui/fog.png'), 'engine');
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000 }, screen, 'img/CG_Layer/a.png'), 'cg', 'папка CG со словом layer — не интерфейс');
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000 }, screen, 'img/Menu_bg/a.png') === 'engine', false);
  // «actionSeq» — не интерфейс: Drill_up держит там покадровые анимации сцен (Ashen Crown — 285 серий H-кадров)
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000 }, screen, 'img/Special__actionSeq/1.png'), 'cg');
  // Фон по имени — только плотный: прозрачная «battle_…» (героиня в рост) и дымка «Effect_…» — слои; без замера — как раньше
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000 }, screen, 'img/pictures/battle_hero.png'), 'backdrop');
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000, opaque: 0.2, cols: 0.5 }, screen, 'img/pictures/battle_hero.png'), 'layer');
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000, opaque: 0.02, cols: 0.9 }, screen, 'img/pictures/hcg/1/Effect_haze.png'), 'layer');
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000, opaque: 1, cols: 1 }, screen, 'img/pictures/Back_street.png'), 'backdrop');
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000 }, screen, 'img/pictures/cg1.png'), 'cg');
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000 }, screen, 'img/CG/scene1.png'), 'cg');
  // Почти пустой холст во весь экран (персонаж в рост) — слой; H-CG без фона (непрозрачно 75 %) — CG
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000, opaque: 0.15, cols: 0.28 }, screen, 'img/pictures/Reiri_Base.png'), 'layer');
  // Поза во всю ширину без фона (нижний слой сцены Seven Keys) — CG
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000, opaque: 0.2, cols: 0.55 }, screen, 'img/pictures/hcg/1/Pose.png'), 'cg');
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000, opaque: 0.75, cols: 1 }, screen, 'img/pictures/eva_c004.png'), 'cg');
  // Основа склейки — верхняя CG, закрывающая весь экран (под ней ничего не видно); плотная по байтам, но прозрачная деталь
  // сверху (тоже «CG») — слой, а не основа; сдвинутая или полупрозрачная CG экран не закрывает
  const { composeFrames } = require('./src/services/galleryScenes.js');
  // ghost — показана с прозрачностью 0 (игра потом проявит её плавно): в склейку не идёт
  const p = (name) => ({ name, x: name === 'moved' ? 40 : 0, y: 0, o: 0, zx: 100, zy: 100, op: name === 'ghost' ? 0 : 255 });
  const kinds = { ev: { kind: 'cg' }, ev2: { kind: 'cg' }, moved: { kind: 'cg' }, ghost: { kind: 'cg' }, skin: { kind: 'cg', partial: true }, diff: { kind: 'cg', partial: true }, mouth: { kind: 'layer' }, alice: { kind: 'portrait' } };
  const names = (frames) => composeFrames(frames.map((pics) => ({ pics: pics.map(p) })), (n) => kinds[n] || null)
    .map((x) => (x.layers ? x.layers.map((l) => l.name) : x.name));
  assert.deepStrictEqual(names([['alice', 'ev', 'diff', 'mouth'], ['skin', 'ev', 'mouth'], ['skin', 'mouth'], ['ev'], ['ev', 'ev2', 'mouth'], ['ev', 'moved'], ['ev2', 'ghost']]),
    [['ev', 'diff', 'mouth'], ['ev', 'mouth'], ['skin', 'mouth'], 'ev', ['ev2', 'mouth'], ['ev', 'moved'], 'ev2']);
  // Кадры подряд — покадровая анимация; варианты позы и неровные номера — нет
  const { isFrameSequence } = require('./src/services/gallery.js');
  const seq = (n, base = 'img/pictures/ci_kiss_') => Array.from({ length: n }, (_, i) => `${base}${String(i).padStart(4, '0')}.png_`);
  assert.deepStrictEqual([isFrameSequence(seq(8), () => '1x1'), isFrameSequence(seq(3), () => '1x1'),
    isFrameSequence(['img/a_1.png', 'img/a_2.png', 'img/a_9.png', 'img/a_20.png'], () => '1x1'),
    isFrameSequence(seq(7), (f) => (f.includes('0001') ? '2x2' : '1x1'))], [true, false, false, false]);
  // Страницы одной сцены «CG12_1…CG12_5» и короткая серия — не анимация; двенадцать и больше без нулей — она
  const pages = (n) => Array.from({ length: n }, (_, i) => `img/pictures/CG12_${i + 1}.png`);
  assert.deepStrictEqual([isFrameSequence(pages(5), () => '1x1'), isFrameSequence(pages(8), () => '1x1'), isFrameSequence(pages(12), () => '1x1'), isFrameSequence(seq(5), () => '1x1')], [false, false, true, false]);

  // Кадр: два слоя на чёрном экране — ffmpeg есть не везде, без него пропускаем
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-scene-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const pics = path.join(root, 'G', 'img', 'pictures');
  await fsp.mkdir(pics, { recursive: true });
  await fsp.mkdir(path.join(root, 'G', 'data'), { recursive: true });
  // Шум: плотная картинка — основа сцены (раздел CG), а не прозрачный слой
  const png = (file, color, size) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', file]);
  png(path.join(pics, 'base.png'), 'red', '816x624');
  // Слой — во весь экран и почти пустой (прозрачный): сцена собрана из двух картинок
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue@0.0:s=816x624,format=rgba', '-frames:v', '1', path.join(pics, 'layer.png')]);
  // Доля непрозрачного: левая половина закрашена — половина
  const half = path.join(root, 'half.png');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=408x624', '-vf', 'format=rgba,pad=816:624:0:0:color=black@0', '-frames:v', '1', half]);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const list = [c(231, [1, 'base', 0, 0, 0, 0, 100, 100, 255, 0]), c(101), c(401, ['one']),
    c(231, [2, 'layer', 0, 0, 0, 0, 100, 100, 255, 0]), c(101), c(401, ['two']), c(0)];
  await fsp.writeFile(path.join(root, 'G', 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Сцена', list }]));
  await fsp.writeFile(path.join(root, 'G', 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  // Размеры для разделов берём из заголовка: base — на весь экран и плотная (красный PNG сжимается сильно — слой), поэтому
  // подставим разделы вручную через оглавление
  const halfShare = await svc.opaqueShare(half, path.join(root, 'G'));
  assert.ok(Math.abs(halfShare.share - 0.5) < 0.05 && Math.abs(halfShare.cols - 0.5) < 0.05, JSON.stringify(halfShare));
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  // Кадр из слоёв — склейкой «@cg/…» в альбоме события (CG); первый кадр — одна основа, она и так файл
  const scene = index.albums.find((a) => a.key.startsWith('events/'));
  assert.ok(scene, 'альбом события найден');
  assert.strictEqual(scene.kind, 'cg');
  const cg = scene.files.filter((f) => f.startsWith('@cg/'));
  assert.strictEqual(cg.length, 1);
  assert.match(cg[0], /^@cg\/[0-9a-f]{20}$/);
  assert.strictEqual(index.albums.find((a) => a.key === 'img/pictures/layer').kind, 'layer', 'деталь склейки — в «Слои»');
  {
    const f1 = await svc.image('G', cg[0]);
    assert.strictEqual(f1.type, 'image/webp');
    // Тот же кадр второй раз берётся из кэша, без ffmpeg
    const again = await svc.image('G', cg[0]);
    assert.ok(again.data.equals(f1.data));
  }
  // Адрес склейки — по составу: пересборка даёт тот же (избранное не теряется)
  svc.sceneMemo = new Map();
  assert.deepStrictEqual((await svc.runBuild('G', { done: 0, total: 0 })).albums.find((a) => a.key.startsWith('events/')).files, scene.files);
  // Чужие кадры закрыты
  assert.strictEqual(await svc.image('G', '@cg/0123456789abcdef0123'), null);
  assert.strictEqual(await svc.image('G', '@cg/../../etc'), null);
  // Числа из данных игры: не число, огромный масштаб, минус, слой без файла — кадр всё равно собирается; два запроса сразу — одна склейка
  const frames = JSON.parse(await fsp.readFile(svc.scenesPath('G'), 'utf8'));
  frames[cg[0].slice(4)] = [{ name: 'base', rel: 'img/pictures/base.png', x: 'abc', y: null, o: 0, zx: 'big', zy: -50, op: 'x' },
    { name: 'layer', rel: 'img/pictures/layer.png', x: 1e9, y: 0, o: 1, zx: 100000, zy: 1, op: 999 }, { name: 'gone', rel: '' }];
  await fsp.writeFile(svc.scenesPath('G'), JSON.stringify(frames));
  await fsp.rm(path.join(root, '_media', 'G', 'scenes'), { recursive: true, force: true });
  svc.sceneMemo = new Map();
  const [a1, a2] = await Promise.all([svc.image('G', cg[0]), svc.image('G', cg[0])]);
  assert.ok(a1.data.length > 20 && a1.data.equals(a2.data));
  assert.deepStrictEqual((await fsp.readdir(path.join(root, '_media', 'G', 'scenes'))).filter((f) => !f.endsWith('.webp')), [], 'без временных файлов');
  // Пересборка забывает кадры
  await svc.forget('G');
  assert.strictEqual(svc.sceneMemo.has('G'), false);
  await assert.rejects(fsp.access(svc.scenesPath('G')));
});

test('галерея: картинки с номерами вместо имён — альбомами событий; размер экрана по картинкам; названия без «测试» и номеров', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const { sceneTitle, cleanLine } = require('./src/services/galleryScenes.js');
  // Названия: имя события, если человеческое; иначе реплика без окна имени; тестовая карта — не название
  assert.strictEqual(sceneTitle({ name: '测试2', where: '测试', list: [{ code: 401, parameters: ['\\n<正彦>你好'] }] }, 0), '你好');
  assert.strictEqual(sceneTitle({ name: 'EV012', where: 'Mom room', list: [] }, 0), 'Mom room');
  assert.strictEqual(sceneTitle({ name: '1212', where: 'test map', list: [] }, 4), '#5');
  assert.strictEqual(cleanLine('「\\C[2]はい」'), 'はい');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-events-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  // PNG-заголовок нужного размера и «плотный» файл (CG)
  // Каждый файл — со своим «содержимым»: одинаковые по байтам галерея показывает один раз
  let uniq = 0;
  const png = (w, h, size) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.write('IDAT', 37, 'latin1'); b.writeUInt32BE(++uniq, size - 4); return b; };
  // Игра пишет экран 816×624, а все CG — 1020×778 и показываются в 100 %: экран — 1020×778
  for (let i = 1; i <= 12; i++) await fsp.writeFile(path.join(game, 'img', 'pictures', `${String(i).padStart(2, '0')}.png`), png(1020, 778, 200000));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (name, line = '…') => [c(231, [1, name, 0, 0, 0, 0, 100, 100, 255, 0]), c(101), c(401, [line])];
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 816, screenHeight: 624 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Ночь в номере', list: [...show('03', 'Ах♥'), ...show('01', '♥♥'), ...show('02'), c(0)] },
    { id: 2, name: 'EV002', list: [c(101), c(401, ['\\n<Мама>Ты вернулся?']), ...show('04'), ...show('05'), c(0)] },
    { id: 3, name: 'ステータス表示', list: [...show('09'), ...show('10'), c(0)] },
  ]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), JSON.stringify([null, { id: 1, name: '测试' }]));
  // Копия той же сцены на тестовой карте — картинки не забирает
  await fsp.writeFile(path.join(game, 'data', 'Map001.json'), JSON.stringify({ events: [null, { id: 1, name: 'EV001', pages: [{ trigger: 0, conditions: {}, list: [...show('01'), ...show('02'), ...show('06'), c(0)] }] }] }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  assert.deepStrictEqual(index.screen, { w: 1020, h: 778 });
  const ev = index.albums.filter((a) => a.key.startsWith('events/'));
  assert.deepStrictEqual(ev.map((a) => [a.key.split('/').pop(), a.files.map((f) => path.basename(f, '.png')), a.kind]), [
    ['Ночь в номере', ['03', '01', '02'], 'cg'],     // в порядке показа в игре
    ['Ты вернулся?', ['04', '05'], 'cg'],
    // 08, 11, 12 не показывает ни одно событие (вырезанные варианты) — рядом с соседними номерами
    ['ステータス表示', ['08', '09', '10', '11', '12'], 'cg'],
  ]);
  // Что не сложилось — по-прежнему по одной; картинки не дублируются
  const all = index.albums.flatMap((a) => a.files);
  assert.strictEqual(new Set(all).size, all.length);
  assert.strictEqual(all.length, 12);
  // Целые картинки по одной на кадр — не «сцена» (она и так альбомом в CG)
  assert.deepStrictEqual(index.albums.filter((a) => a.key.startsWith('scenes/')), []);

  // Общий фон, который показывают многие события, остаётся своим альбомом, а не уходит в первое событие
  const many = [null, ...[1, 2, 3, 4].map((id) => ({ id, name: `Сцена ${id}`, list: [...show('07', id === 1 ? '♥'.repeat(10) : '…'), ...show(String(7 + id).padStart(2, '0')), c(0)] }))];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify(many));
  await fsp.writeFile(path.join(game, 'data', 'Map001.json'), '{"events": {"not": "an array"}}');
  // Выключенный плагин с размером экрана не действует; масштаб 30 % — экран не подменяем картинками
  await fsp.mkdir(path.join(game, 'js'), { recursive: true });
  await fsp.writeFile(path.join(game, 'js', 'plugins.js'), 'var $plugins = [{"name":"Old","status":false,"description":"","parameters":{"screenWidth":"1920","screenHeight":"1080"}}];');
  const again = await svc.runBuild('G', { done: 0, total: 0 });
  assert.deepStrictEqual(again.screen, { w: 1020, h: 778 });
  // Общий фон 07 — не в первое событие: он среди картинок «Без сцены» (их три и больше — одним альбомом в конце)
  assert.ok(!again.albums.some((a) => a.key.startsWith('events/') && a.files.some((f) => f.endsWith('/07.png'))));
  const loose = again.albums.find((a) => a.loose);
  assert.ok(loose && loose.files.includes('img/pictures/07.png') && again.albums[again.albums.length - 1] === loose, 'фон 07 — в «Без сцены», в конце');
  const zoomed = [null, { id: 1, name: 'Мелко', list: [c(231, [1, '01', 0, 0, 0, 0, 30, 30, 255, 0]), c(101), c(0)] }];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify(zoomed));
  assert.deepStrictEqual((await svc.runBuild('G', { done: 0, total: 0 })).screen, { w: 816, h: 624 });
  // Битый JSON событий — оглавление всё равно собирается
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), '{oops');
  assert.strictEqual((await svc.runBuild('G', { done: 0, total: 0 })).albums.length > 0, true);
});

test('галерея: распознавание — ответы без векторов дополняются векторами, прежние ответы остаются, оглавление не пересобирается', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-embeds-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  const png = (n) => { const b = Buffer.alloc(200000); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(816, 16); b.write('IDAT', 37, 'latin1'); b.writeUInt32BE(624, 20); b.writeUInt32BE(n, 200000 - 4); return b; };
  await fsp.writeFile(path.join(game, 'img', 'pictures', 'love1.png'), png(1));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 816, screenHeight: 624 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Ночь', list: [c(231, [1, 'love1', 0, 0, 0, 0, 100, 100, 255, 0]), c(101), c(401, ['…']), c(0)] }]));
  let asked = 0;
  const make = (score, embed) => {
    const svc = new GalleryService();
    svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
    svc.thumb = async (id, rel) => rel;
    svc.vision = { available: true, version: 'v', score: async (file, seen = {}) => { asked++; if (embed) seen.embed = embed; return score; } };
    return svc;
  };
  const read = async (svc) => JSON.parse(await fsp.readFile(svc.visionPath('G'), 'utf8'));
  // Ответ, записанный до поиска по картинкам: есть оценка, векторов нет
  const old = make(0.9, null);
  await old.runBuild('G', { done: 0, total: 0 });
  await old.visionPass('G');
  const before = await read(old);
  assert.ok(Object.keys(before.scores).length > 0 && !Object.keys(before.embeds || {}).length);
  // Новая модель отвечает иначе (0.1): оценку не меняем, вектор дописываем, оглавление не пересобираем
  const fresh = make(0.1, new Array(512).fill(0.044));
  let rebuilt = 0;
  const build = fresh.build.bind(fresh);
  fresh.build = (id) => { rebuilt++; return build(id); };
  asked = 0;
  await fresh.visionPass('G');
  const after = await read(fresh);
  assert.deepStrictEqual(after.scores, before.scores, 'прежние оценки на месте');
  assert.deepStrictEqual(Object.keys(after.embeds), Object.keys(before.scores));
  assert.deepStrictEqual([asked > 0, rebuilt], [true, 0]);
  await assert.rejects(fsp.access(`${fresh.visionPath('G')}.tmp`), 'временного файла не осталось');
  // Вектор есть — повторный проход ничего не спрашивает
  asked = 0;
  await fresh.visionPass('G');
  assert.strictEqual(asked, 0);
});

test('поиск по картинкам: лучшие из всех игр, повтор рисунка одним, кэш не больше 40 игр, недописанный файл не запоминается', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-search-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.vision = { available: true, version: 'v' };
  svc.knows = async () => true;
  const pack = (head) => Buffer.from(Int8Array.from({ length: 512 }, (_, i) => head[i] || 0)).toString('base64');
  const save = async (id, embeds, raw) => {
    await fsp.mkdir(path.join(root, '_media', id), { recursive: true });
    await fsp.writeFile(svc.visionPath(id), raw || JSON.stringify({ version: 'v', scores: {}, embeds }));
  };
  const query = Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
  await save('A', { 'a1.png\n1': pack([120, 120, 107]), 'a1_copy.png\n2': pack([118, 122, 107]), 'a2.png\n3': pack([80, -127, -106]), 'a3.png\n4': pack([0, 127, 106]) });
  await save('B', { 'b1.png\n1': pack([100, 100, -127]), 'b2.png\n2': pack([30, 120, 120]) });
  const found = await svc.searchPictures(query, ['A', 'B', 'Нет'], 3);
  assert.deepStrictEqual(found.rows.map((r) => `${r.game}:${r.file}`), ['A:a1.png', 'B:b1.png', 'A:a2.png'], 'копия a1 (косинус > 0,97) не в счёт');
  assert.strictEqual(found.games, 2);
  // Недописанный файл: игра пока не участвует, и пустой ответ не запомнен — дописали, и она видна
  await save('C', null, '{"version":"v","scores":{},"emb');
  assert.strictEqual((await svc.searchPictures(query, ['C'], 3)).games, 0);
  assert.ok(!svc.searchMemo.has('C'));
  await save('C', { 'c1.png\n1': pack([110]) });
  assert.deepStrictEqual((await svc.searchPictures(query, ['C'], 3)).rows.map((r) => r.file), ['c1.png']);
  // Игр в памяти не больше сорока
  const ids = [];
  for (let i = 0; i < 45; i++) { ids.push(`G${i}`); await save(`G${i}`, { 'x.png\n1': pack([i + 1]) }); }
  await svc.searchPictures(query, ids, 5);
  assert.strictEqual(svc.searchMemo.size, 40);
});

test('поиск по картинкам: подсказка английским словом — по основе, короткие ключи только целым словом или с окончанием', () => {
  const { GalleryText } = require('./src/services/galleryText.js');
  const hint = (q) => GalleryText.prototype.withEnglish.call({}, q);
  // Ложные срабатывания по началу слова
  for (const q of ['садистка', 'лесбиянка', 'банк', 'бандит', 'оркестр', 'картина', 'hundred', 'grasp', 'mannequin']) assert.strictEqual(hint(q), q, q);
  // Целое слово и падежи
  assert.strictEqual(hint('сад'), 'сад, garden');
  assert.strictEqual(hint('в саду'), 'в саду, garden');
  assert.strictEqual(hint('лесом'), 'лесом, forest');
  assert.strictEqual(hint('Hund'), 'Hund, dog');
  assert.strictEqual(hint('Hunde'), 'Hunde, dog');
  // Длинный ключ — по началу слова
  assert.strictEqual(hint('драконами'), 'драконами, dragon');
  assert.strictEqual(hint('горничные'), 'горничные, maid');
});

test('галерея: распознавание — альбом, где ни один кадр не похож на сцену, уходит из CG; ответы запоминаются; без модели — как было', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-vision-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  let uniq = 0;
  const png = (w, h, size) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.write('IDAT', 37, 'latin1'); b.writeUInt32BE(h, 20); b.writeUInt32BE(++uniq, size - 4); return b; };
  const names = ['love1', 'love2', 'status1', 'status2', 'status3', 'dark1', 'dark2', 'dark3', 'card1', 'card2'];
  for (const n of names) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png(816, 624, 200000));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (name) => [c(231, [1, name, 0, 0, 0, 0, 100, 100, 255, 0]), c(101), c(401, ['…'])];
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 816, screenHeight: 624 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Ночь', list: [...show('love1'), ...show('love2'), c(0)] },
    { id: 2, name: 'Статус', list: [...show('status1'), ...show('status2'), ...show('status3'), c(0)] },
    // Тёмное начало сцены похоже на экран, но середина — сцена: альбом остаётся в CG
    { id: 3, name: 'Подвал', list: [...show('dark1'), ...show('dark2'), ...show('dark3'), c(0)] },
    { id: 4, name: 'Меню', list: [...show('card1'), ...show('card2'), c(0)] },
  ]));
  const scores = { love1: 0.9, love2: 0.9, status1: 0.1, status2: 0.2, status3: 0.05, dark1: 0.2, dark2: 0.8, dark3: 0.1, card1: 0.1 };
  const asked = [];
  const make = (available) => {
    const svc = new GalleryService();
    svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
    // Миниатюра — сам путь; «модель» отвечает по имени файла
    svc.thumb = async (id, rel) => rel;
    // card2 не читается (ffmpeg упал) — проход идёт дальше, альбом остаётся в CG
    svc.vision = { available, score: async (file, seen = {}) => { const n = path.basename(file, '.png'); asked.push(n); if (!(n in scores)) throw new Error('ffmpeg: 1'); seen.embed = new Array(512).fill(0.044); return scores[n]; } };
    return svc;
  };
  const kinds = (index) => Object.fromEntries(index.albums.map((a) => [a.key.split('/').pop(), a.kind]));

  // Без модели: всё в CG, распознавание не зовётся
  const off = make(false);
  assert.deepStrictEqual(kinds(await off.runBuild('G', { done: 0, total: 0 })), { love: 'cg', status: 'cg', dark: 'cg', card: 'cg' });
  await off.visionPass('G');
  assert.deepStrictEqual(asked, []);

  // С моделью: первая сборка показывает всё сразу, распознавание — следом, и оглавление пересобирается
  const svc = make(true);
  assert.deepStrictEqual(kinds(await svc.runBuild('G', { done: 0, total: 0 })), { love: 'cg', status: 'cg', dark: 'cg', card: 'cg' });
  await svc.visionPass('G');
  const index = await svc.cached('G');
  assert.deepStrictEqual(kinds(index), { love: 'cg', status: 'other', dark: 'cg', card: 'cg' });
  assert.strictEqual(index.albums.find((a) => a.key.endsWith('/status')).screen, true);
  // Обложка-сцена — остальные кадры не смотрим; у тёмного альбома хватает середины
  assert.deepStrictEqual(asked.sort(), ['card1', 'card2', 'dark1', 'dark2', 'love1', 'status1', 'status2', 'status3']);
  // Нечитаемый кадр запомнен: следующий проход ничего не спрашивает и не пересобирает
  asked.length = 0;
  let rebuilt = 0;
  const build = svc.build.bind(svc);
  svc.build = (id) => { rebuilt++; return build(id); };
  await svc.visionPass('G');
  assert.deepStrictEqual([asked, rebuilt], [[], 0]);

  // Пересборка берёт ответы из файла — модель больше не спрашивают
  asked.length = 0;
  assert.deepStrictEqual(kinds(await make(true).runBuild('G', { done: 0, total: 0 })), { love: 'cg', status: 'other', dark: 'cg', card: 'cg' });
  assert.deepStrictEqual(asked, []);

  // Сменились подписи — прежние ответы не в счёт, модель спрашивают заново
  const relabeled = make(true);
  relabeled.vision.version = 'другие';
  assert.deepStrictEqual(kinds(await relabeled.runBuild('G', { done: 0, total: 0 })), { love: 'cg', status: 'cg', dark: 'cg', card: 'cg' });
  await relabeled.visionPass('G');
  assert.strictEqual(asked.length, 8);
  assert.deepStrictEqual(kinds(await relabeled.cached('G')), { love: 'cg', status: 'other', dark: 'cg', card: 'cg' });

  // Игру обновили — ответы забываются вместе с оглавлением
  await svc.forget('G');
  await assert.rejects(fsp.access(svc.visionPath('G')));

  // Модель с неверной суммой не сохраняется, временный файл не остаётся
  const { GalleryVision } = require('./src/services/galleryVision.js');
  const v = new GalleryVision();
  const fetchWas = global.fetch;
  t.after(() => { global.fetch = fetchWas; });
  global.fetch = async () => new Response('не модель');
  const file = path.join(root, '_models', 'm.onnx');
  await assert.rejects(v.download(file), /контрольная сумма/);
  assert.deepStrictEqual(await fsp.readdir(path.dirname(file)), []);
});

test('галерея: сцена-панель становится альбомом CG только после распознавания; папка позы — один альбом «Слои»', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-panel-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures/battle', 'img/pictures/stand', 'img/pictures/doll', 'img/elena/pose1', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (w, h, size) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.write('IDAT', 37, 'latin1'); b.writeUInt32BE(++uniq, size - 4); return b; };
  // Детали боя: тело и лица — «персонажи» (408×600), «сперма» — лёгкий слой во весь экран; портрет разговора — так же
  for (const n of ['battle/base', 'battle/face1', 'battle/face2', 'stand/body', 'stand/smile', 'stand/sad']) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png(408, 600, 60000));
  await fsp.writeFile(path.join(game, 'img', 'pictures', 'battle', 'samen.png'), png(816, 624, 20000));
  // Такая же стопка, но событие называет её стоячим портретом («立绘»): сцена-панель, которую распознавание признало бы, — нет
  for (const n of ['doll/base', 'doll/face1', 'doll/face2']) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png(408, 600, 60000));
  await fsp.writeFile(path.join(game, 'img', 'pictures', 'doll', 'samen.png'), png(816, 624, 20000));
  // Поза Elena: полсотни прозрачных деталей на весь экран и плотное тело среди них
  for (let i = 0; i < 45; i++) await fsp.writeFile(path.join(game, 'img', 'elena', 'pose1', `part_${['arm', 'leg', 'hair'][i % 3]}${i}.png`), png(816, 624, 20000));
  await fsp.writeFile(path.join(game, 'img', 'elena', 'pose1', 'body_1.png'), png(816, 624, 300000));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, x) => c(231, [n, name, 0, 0, x, 0, 100, 100, 255, 0]);
  const log = (text) => c(357, ['BattleLogOutput', 'OUTPUT_LOG', '', { message: text }]);
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 816, screenHeight: 624 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Бой', list: [show(21, 'battle/base', 408), show(22, 'battle/face1', 408), log('Ah'), show(28, 'battle/samen', 400), show(22, 'battle/face2', 408), log('Ahh'), c(0)] },
    { id: 3, name: '托莉娜立绘+表情', list: [show(21, 'doll/base', 408), show(22, 'doll/face1', 408), log('Ah'), show(28, 'doll/samen', 400), show(22, 'doll/face2', 408), log('Ahh'), c(0)] },
    { id: 2, name: 'Разговор', list: [show(1, 'stand/body', 0), show(2, 'stand/smile', 0), c(101), c(401, ['Привет']), show(2, 'stand/sad', 0), c(101), c(401, ['Пока']), c(0)] },
  ]));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  // Миниатюра склейки — имена её слоёв; «модель» видит сцену там, где есть «сперма»
  svc.thumb = async (id, rel) => (rel.startsWith('@cg/') ? (await svc.scenesOf(id))[rel.slice(4)].map((l) => l.name).join('+') : rel);
  const asked = [];
  svc.vision = { available: true, version: 'v', score: async (what) => { asked.push(what); return /samen/.test(what) ? 0.9 : 0.2; } };
  const first = await svc.runBuild('G', { done: 0, total: 0 });
  // До ответа галерея как без панелей: событий-альбомов нет, пробы отложены
  assert.deepStrictEqual(first.albums.filter((a) => a.key.startsWith('events/')), []);
  assert.strictEqual(first.visionProbe.length, 2);
  // Поза — одним альбомом «Слои», плотное тело — тоже деталь, не CG
  const pose = first.albums.filter((a) => a.key.startsWith('img/elena/'));
  assert.deepStrictEqual(pose.map((a) => [a.key, a.kind, a.files.length]), [['img/elena/pose1', 'layer', 46]]);
  await svc.visionPass('G');
  const index = await svc.cached('G');
  const ev = index.albums.filter((a) => a.key.startsWith('events/'));
  assert.deepStrictEqual(ev.map((a) => [a.key.split('/').pop(), a.kind, a.files.length]), [['Бой', 'cg', 2]]);
  assert.ok(!index.visionProbe, 'ответы есть на все пробы');
  // Склейка панели обрезана по основе (408×600 справа), иначе — полоска на чёрном экране
  const scenesNow = await svc.scenesOf('G');
  assert.deepStrictEqual(scenesNow[ev[0].files[0].slice(4)][0].crop, [408, 0, 408, 600]);
  // Портрет разговора так и остался персонажем
  assert.ok(index.albums.some((a) => a.kind === 'portrait' && a.files.includes('img/pictures/stand/body.png')));
  // Второй проход ничего не спрашивает
  asked.length = 0;
  await svc.visionPass('G');
  assert.deepStrictEqual(asked, []);

  // Распознавать нечем — пробы не откладываются, галерея как без панелей
  const off = new GalleryService();
  off.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media_off') });
  off.vision = { available: false, version: 'v' };
  const plain = await off.runBuild('G', { done: 0, total: 0 });
  assert.strictEqual(plain.visionProbe, undefined);
  assert.deepStrictEqual(plain.albums.filter((a) => a.key.startsWith('events/')), []);
});

test('галерея: сцена-панель, у которой первые три пробы ответили «нет», решается по остальным кадрам', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-panel-rest-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures/battle', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (w, h, size) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.write('IDAT', 37, 'latin1'); b.writeUInt32BE(++uniq, 41); return b; };
  for (const n of ['base', 'f1', 'f2', 'f3', 'f4']) await fsp.writeFile(path.join(game, 'img', 'pictures', 'battle', `${n}.png`), png(408, 600, 60000));
  await fsp.writeFile(path.join(game, 'img', 'pictures', 'battle', 'samen.png'), png(816, 624, 20000));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, x) => c(231, [n, name, 0, 0, x, 0, 100, 100, 255, 0]);
  const log = (text) => c(357, ['BattleLogOutput', 'OUTPUT_LOG', '', { message: text }]);
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 816, screenHeight: 624 } }));
  // Пять кадров; «сперму» видит модель только во втором — а пробы берут первый, средний и последний
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Бой', list: [show(21, 'battle/base', 408), show(22, 'battle/f1', 408), log('1'), show(28, 'battle/samen', 400), log('2'), c(235, [28]), show(22, 'battle/f2', 408), log('3'),
      show(22, 'battle/f3', 408), log('4'), show(22, 'battle/f4', 408), log('5'), c(0)] },
  ]));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.thumb = async (id, rel) => (rel.startsWith('@cg/') ? (await svc.scenesOf(id))[rel.slice(4)].map((l) => l.name).join('+') : rel);
  svc.vision = { available: true, version: 'v', score: async (what) => (/samen/.test(what) ? 0.9 : 0.2) };
  const first = await svc.runBuild('G', { done: 0, total: 0 });
  assert.deepStrictEqual(first.albums.filter((a) => a.key.startsWith('events/')), []);
  // Первый проход отвечает на первые три кадра и пересобирает; вторая сборка ставит остальные, второй проход отвечает на них
  await svc.visionPass('G');
  assert.strictEqual((await svc.cached('G')).visionProbe.length, 1, 'остальные кадры поставлены в пробы');
  await svc.visionPass('G');
  const index = await svc.cached('G');
  assert.deepStrictEqual(index.albums.filter((a) => a.key.startsWith('events/')).map((a) => [a.key.split('/').pop(), a.kind]), [['Бой', 'cg']], 'кадр с «спермой» — не из первых проб, но группа сцена');
});

test('данные игры: System.json и события в AES (пароль — в коде игры), ключ картинок — из System.json или из самой картинки', async (t) => {
  const { readGameJson, mediaKey, forgetGame } = require('./src/utils/gameData.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gamedata-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  for (const d of ['js', 'data', 'img/pictures']) await fsp.mkdir(path.join(root, d), { recursive: true });
  // Как CryptoJS.AES.encrypt(text, "пароль"): OpenSSL «Salted__», ключ и IV — EVP_BytesToKey на MD5
  const nodeCrypto = require('crypto');
  const encrypt = (text, pass) => {
    const salt = nodeCrypto.randomBytes(8);
    let d = Buffer.alloc(0), prev = Buffer.alloc(0);
    while (d.length < 48) { prev = nodeCrypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(pass), salt])).digest(); d = Buffer.concat([d, prev]); }
    const c = nodeCrypto.createCipheriv('aes-256-cbc', d.subarray(0, 32), d.subarray(32, 48));
    return Buffer.concat([Buffer.from('Salted__'), salt, c.update(text, 'utf8'), c.final()]).toString('base64');
  };
  const pass = '%8nG3()-=b%4/?#@!c5zA';
  await fsp.writeFile(path.join(root, 'js', 'rmmz_managers.js'), `DataManager.decrypt = function(file) {\n  const b = CryptoJS.AES.decrypt(file, "${pass}");\n};`);
  const key = '00112233445566778899aabbccddeeff';
  await fsp.writeFile(path.join(root, 'data', 'System.json'), encrypt(JSON.stringify({ gameTitle: 'Шпионка', encryptionKey: key }), pass));
  await fsp.writeFile(path.join(root, 'data', 'CommonEvents.json'), encrypt('[null,{"id":1,"list":[]}]', pass));
  assert.strictEqual((await readGameJson(root, path.join(root, 'data', 'System.json'))).gameTitle, 'Шпионка');
  assert.strictEqual((await readGameJson(root, path.join(root, 'data', 'CommonEvents.json'))).length, 2);
  assert.strictEqual(await mediaKey(root), key);
  // Ключа в System.json нет — он в самой картинке: первые 16 байт PNG у всех одинаковые
  await fsp.writeFile(path.join(root, 'data', 'System.json'), JSON.stringify({ gameTitle: 'Без ключа' }));
  const head = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const other = 'fedcba98765432100123456789abcdef';
  const enc = Buffer.from(head.map((b, i) => b ^ Buffer.from(other, 'hex')[i]));
  await fsp.writeFile(path.join(root, 'img', 'pictures', 'a.png_'), Buffer.concat([Buffer.from('RPGMV\0\0\0\0\x03\x01\0\0\0\0\0', 'latin1'), enc, Buffer.alloc(32)]));
  forgetGame(root);
  assert.strictEqual(await mediaKey(root), other);
  // Обычная игра — как раньше; неверный пароль — текст как есть, без падения
  await fsp.writeFile(path.join(root, 'data', 'Plain.json'), '﻿{"a":1}');
  assert.deepStrictEqual(await readGameJson(root, path.join(root, 'data', 'Plain.json')), { a: 1 });
  await fsp.writeFile(path.join(root, 'data', 'Bad.json'), encrypt('{"a":2}', 'другой пароль'));
  assert.strictEqual(await readGameJson(root, path.join(root, 'data', 'Bad.json')), null);
});

test('галерея: общие правила — номер «сцена+кадр», вспышка не кадр, лицо с эмоцией на холсте — часть сцены, прозрачные детали не в CG, повтор сцены из меню — в её альбоме', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-rules-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (w, h, size) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.write('IDAT', 37, 'latin1'); b.writeUInt32BE(++uniq, size - 4); return b; };
  const pic = (n, size = 200000) => fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png(816, 624, size));
  // Сцены 01 и 02 по 13 кадров (r0101…r0213): разные сцены, не один альбом «r»
  for (const sc of ['01', '02']) for (let k = 1; k <= 13; k++) await pic(`r${sc}${String(k * 3).padStart(2, '0')}`);
  await pic('ev_01'); await pic('ev_02'); await pic('ev_03');
  await pic('white', 3000);                    // вспышка: почти пустой файл на весь экран
  await pic('black', 3000);
  await pic('ev_04'); await pic('ev_04_b', 20000);
  await pic('ev_02_face_angry', 20000);        // лицо — прозрачный слой во весь экран
  await pic('ev_03_cum', 20000);
  await pic('mix_01'); await pic('mix_02', 20000);   // в одном имени CG и прозрачная деталь
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const line = [c(101), c(401, ['…'])];
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 816, screenHeight: 624 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Вспышка', list: [show(1, 'ev_01'), show(2, 'white'), ...line, c(235, [2]), show(3, 'ev_02'), ...line, c(0)] },
    { id: 2, name: 'Злится', list: [show(1, 'ev_02'), show(2, 'ev_02_face_angry'), ...line, show(1, 'ev_01'), ...line, c(0)] },
    { id: 3, name: 'Сцена', list: [show(1, 'ev_03'), ...line, show(2, 'ev_03_cum'), ...line, c(0)] },
    { id: 4, name: '---Watch', list: [show(1, 'ev_03'), show(2, 'ev_03_cum'), ...line, c(0)] },
    // Чёрная подложка под CG — не вспышка: кадры остаются
    { id: 5, name: 'Подложка', list: [show(1, 'black'), show(2, 'ev_04'), ...line, show(3, 'ev_04_b'), ...line, c(0)] },
  ]));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.vision = { available: false, version: 'off' };
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  const scenesNow = await svc.scenesOf('G');
  const names = (f) => (f.startsWith('@cg/') ? scenesNow[f.slice(4)].map((l) => path.basename(l.rel, '.png')).join('+') : path.basename(f, '.png'));
  const byKey = (re) => index.albums.filter((a) => re.test(a.key));
  assert.deepStrictEqual(byKey(/\/r0\d$/).map((a) => [path.basename(a.key), a.files.length]), [['r01', 13], ['r02', 13]]);
  const ev = Object.fromEntries(byKey(/^events\//).map((a) => [a.key.split('/').pop(), a.files.map(names)]));
  // Кадр под вспышкой — не кадр; лицо с эмоцией — в склейке; меню повтора — не отдельный альбом
  assert.ok(!Object.values(ev).flat().some((n) => n.includes('white')), JSON.stringify(ev));
  assert.ok(Object.values(ev).flat().includes('ev_02+ev_02_face_angry'), JSON.stringify(ev));
  assert.strictEqual(ev['---Watch'], undefined);
  assert.deepStrictEqual(ev['Подложка'], ['ev_04', 'ev_04+ev_04_b']);
  // Прозрачная деталь из альбома CG по имени — в «Слоях»
  const mix = byKey(/\/mix/).map((a) => [a.key.split('/').pop(), a.kind, a.files.map(names)]);
  assert.deepStrictEqual(mix, [['mix', 'cg', ['mix_01']], ['mix#parts', 'layer', ['mix_02']]]);
});

test('галерея: анимации — по циклам событий, страницы события одним альбомом; каждая картинка — в одном месте', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-anim-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  let uniq = 0;
  const png = (w, h, size) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.writeUInt32BE(++uniq, size - 4); return b; };
  const names = ['anim_1', 'anim_2', 'anim_3', 'anim_4', ...Array.from({ length: 12 }, (_, i) => `LH${i}`), 'ev_base'];
  for (const n of names) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png(816, 624, 200000));
  // Одежда поверх основы — прозрачный слой (по байтам редкий)
  await fsp.writeFile(path.join(game, 'img', 'pictures', 'ev_cloth.png'), png(816, 624, 1000));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (name, n = 1) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const msg = (text) => [c(101), c(401, [text])];
  // Две страницы события — медленно и быстро, каждая крутит свои кадры в цикле
  const loop = (a, b) => [show(a), ...msg('…'), c(112), show(a), c(230, [6]), show(b), c(230, [6]), c(413), ...msg('Ах'), c(0)];
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), JSON.stringify([null, { id: 1, name: 'Дом' }]));
  await fsp.writeFile(path.join(game, 'data', 'Map001.json'), JSON.stringify({ events: [null, { id: 1, name: 'Ночь', pages: [{ list: loop('anim_1', 'anim_2') }, { list: loop('anim_3', 'anim_4') }] }] }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    // Варианты одежды с репликами между ними — не анимация, хотя номера подряд
    { id: 1, name: 'Гардероб', list: [...Array.from({ length: 12 }, (_, i) => [show(`LH${i}`), ...msg('Так?')]).flat(), c(0)] },
    { id: 2, name: 'Сцена', list: [show('ev_base'), ...msg('…'), show('ev_cloth', 2), ...msg('!'), c(0)] },
  ]));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  const anims = index.albums.filter((a) => a.kind === 'animation');
  assert.deepStrictEqual(anims.map((a) => [a.key, a.files.map((f) => path.basename(f, '.png')), a.fps]), [['scenes/m1e1/Ночь', ['anim_1', 'anim_2', 'anim_3', 'anim_4'], 10]]);
  const where = (n) => index.albums.filter((a) => a.files.includes(`img/pictures/${n}.png`)).map((a) => a.kind);
  assert.deepStrictEqual(where('anim_2'), ['animation'], 'кадр анимации — не ещё раз в CG');
  const lh = index.albums.find((a) => a.files.includes('img/pictures/LH0.png'));
  assert.ok(lh && !lh.anim && lh.kind === 'cg', 'смена одежды с репликами — не анимация');
  // Основа склейки — только в альбоме события (там она и сама по себе, и с одеждой)
  const ev = index.albums.find((a) => a.key.startsWith('events/'));
  assert.deepStrictEqual(ev.files.map((f) => (f.startsWith('@cg/') ? '@cg' : path.basename(f, '.png'))), ['ev_base', '@cg']);
  assert.deepStrictEqual(where('ev_base'), ['cg']);
  assert.deepStrictEqual(where('ev_cloth'), ['layer']);
});

test('галерея: сцены из боёв и скриптов, меню сцен не отнимает картинки; одиночки — к соседям, папке, общему имени; дубли — один раз', async (t) => {
  const { GalleryService, albumKey, classify } = require('./src/services/gallery.js');
  // Имена: сцена и страница в начале, «@» — разделитель, номер, слитый с иероглифами, — порядковый
  assert.strictEqual(albumKey('img/pictures/2_10_SidePos_Arousal_Normal_Front_Climax.png'), 'img/pictures/2');
  assert.strictEqual(albumKey('img/pictures/2_1側位_抵抗.png'), 'img/pictures/2');
  assert.strictEqual(albumKey('img/pictures/cutin01@00.rpgmvp'), 'img/pictures/cutin01');
  assert.strictEqual(albumKey('img/pictures/3引导.rpgmvp'), 'img/pictures/引导');
  // Папка фонов внутри pictures — «Фоны»
  assert.strictEqual(classify({ w: 816, h: 624, size: 700000 }, { w: 816, h: 624 }, 'img/pictures/Background/Night_room1.png_'), 'backdrop');
  // PNG с палитрой сжимается втрое сильнее: 0,11 байта на пиксель — уже плотная CG, а полноцветный такой — прозрачный слой
  assert.strictEqual(classify({ w: 1280, h: 720, size: 101376, palette: true }, { w: 1280, h: 720 }, 'img/pictures/fr_000.rpgmvp'), 'cg');
  assert.strictEqual(classify({ w: 1280, h: 720, size: 101376 }, { w: 1280, h: 720 }, 'img/pictures/fr_000.rpgmvp'), 'layer');
  // Палитра с прозрачностью (блок tRNS до данных) — прозрачная картинка: её меряют, как PNG с альфа-каналом
  const { pngSize } = require('./src/services/gallery.js');
  const pal = (trns) => { const b = Buffer.alloc(200); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(1280, 16); b.writeUInt32BE(720, 20); b[24] = 8; b[25] = 3; b.writeUInt32BE(6, 33); b.write('PLTE', 37, 'latin1'); b.writeUInt32BE(2, 51); b.write(trns ? 'tRNS' : 'IDAT', 55, 'latin1'); return b; };
  assert.deepStrictEqual([pngSize(pal(true)), pngSize(pal(false))], [{ w: 1280, h: 720, alpha: true, palette: true }, { w: 1280, h: 720, palette: true }]);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-gather-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  const pics = path.join(game, 'img', 'pictures');
  for (const d of ['img/pictures/14 dance', 'img/spines/oral01', 'data', 'movies']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (w = 816, h = 624, size = 200000) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.writeUInt32BE(++uniq, size - 4); return b; };
  const names = ['beach_1', 'beach_2', 'beach_3', 'lose_a', 'lose_b', 'scr_1', 'scr_2', 'Aldos_bebado', 'Aldos_Feliz', 'Aldos_triste',
    '14 dance/arina_dance4', '14 dance/arina_dance5_hyp', 'hall_1', 'hall_2'];
  for (const n of names) await fsp.writeFile(path.join(pics, `${n}.png`), png());
  // Брызги поверх — прозрачный слой (по байтам редкий)
  await fsp.writeFile(path.join(pics, 'beach_fx.png'), png(816, 624, 2000));
  // Та же картинка под другим именем (английская копия японской) — один раз
  await fsp.writeFile(path.join(pics, 'beach_copy.png'), await fsp.readFile(path.join(pics, 'beach_3.png')));
  // А у этих совпадают начало и конец, разная только середина — разные картинки
  const twin = (k) => { const b = png(816, 624, 300000); b.writeUInt32BE(0, 300000 - 4); b[150000] = k; return b; };
  await fsp.writeFile(path.join(pics, 'mid_a.png'), twin(1));
  await fsp.writeFile(path.join(pics, 'mid_b.png'), twin(2));
  // Кадр, повторённый в своей анимации (loop_3 = loop_1), — не повтор; врезка другой героини целиком (dupB = dupA) — один
  // раз; совпал один кадр из чужого альбома (cutB_1 = cutA_1) — в анимации cutB дыры нет
  const same = async (to, from) => fsp.writeFile(path.join(pics, `${to}.png`), await fsp.readFile(path.join(pics, `${from}.png`)));
  for (const n of ['loop_1', 'loop_2', 'dupA_1', 'dupA_2', 'cutA_1', 'cutA_2', 'cutB_2']) await fsp.writeFile(path.join(pics, `${n}.png`), png());
  await same('loop_3', 'loop_1'); await same('dupB_1', 'dupA_1'); await same('dupB_2', 'dupA_2'); await same('cutB_1', 'cutA_1');
  // Текстура модели Spine — «Системные», не CG
  await fsp.writeFile(path.join(game, 'img', 'spines', 'oral01', 'oral01.png'), png());
  await fsp.writeFile(path.join(game, 'img', 'spines', 'oral01', 'oral01.atlas'), 'oral01.png');
  await fsp.writeFile(path.join(game, 'movies', 'piston.webm'), Buffer.alloc(5000, 1));
  // Ролик под чужим расширением — WebM по заголовку; прочее непонятное в movies/ — не ролик
  await fsp.writeFile(path.join(game, 'movies', 'scene0.pprn'), Buffer.concat([Buffer.from('1a45dfa39f4286810142f7810142f28104', 'hex'), Buffer.alloc(5000, 2)]));
  await fsp.writeFile(path.join(game, 'movies', 'notes.dat'), Buffer.alloc(5000, 3));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (name, n = 1, indent = 0) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0], indent);
  const msg = (text, indent = 0) => [c(101, [], indent), c(401, [text], indent)];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    // Меню сцен: в ветках перебирает чужие картинки — у своей сцены они и остаются
    { id: 1, name: 'Выбор сцены', list: [c(102, [['1', '2']]), c(402, [0, '1']), show('hall_1', 1, 1), ...msg('…', 1), c(0, [], 1),
      c(402, [1, '2']), show('beach_1', 1, 1), show('beach_fx', 2, 1), ...msg('…', 1), c(0, [], 1), c(404), c(0)] },
    // Сцена из слоёв; beach_3 игра не показывает (запасной вариант)
    { id: 2, name: 'Пляж', list: [show('beach_1'), show('beach_fx', 2), ...msg('Море'), show('beach_2'), ...msg('…'), c(0)] },
    // Картинки показывает скрипт
    { id: 3, name: 'Ночь', list: [c(355, ['$gameScreen.showPicture(1,"scr_1",0,0,0,100,100,255,0)']), ...msg('…'), c(355, ['$gameScreen.showPicture(1,"scr_2",0,0,0,100,100,255,0)']), ...msg('…'), c(0)] },
    // Ролик по кругу — анимация этой сцены
    { id: 4, name: 'Поршень', list: [c(357, ['MoviePicture', 'PREPARE', '', { fileName: 'piston', loop: 'true' }]), c(231, [5, '', 0, 0, 0, 0, 100, 100, 255, 0]), ...msg('…'), c(0)] },
  ]));
  // Сцена поражения — в бою (отряд врагов)
  await fsp.writeFile(path.join(game, 'data', 'Troops.json'), JSON.stringify([null, { id: 1, name: 'Гоблины', pages: [{ list: [show('lose_a'), ...msg('Нет!'), show('lose_b'), ...msg('…'), c(0)] }] }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.probe = async () => ({ duration: 6, audio: true });
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  const base = (f) => path.basename(f).replace(/\.[^.]+$/, '');
  const albumOf = (n) => index.albums.find((a) => a.files.some((f) => base(f) === n));
  // Картинка, которой нет ни в одном событии (beach_3), — к вариантам той же CG в альбоме события; меню выбора сцен его
  // не отнимает, хоть и раньше по порядку
  const beach = index.albums.find((a) => a.key.startsWith('events/') && a.files.some((f) => base(f) === 'beach_3'));
  assert.deepStrictEqual([beach.key, beach.files.map((f) => (f.startsWith('@cg/') ? '@cg' : base(f)))], ['events/00001/Пляж', ['@cg', '@cg', 'beach_3']]);
  assert.strictEqual(albumOf('beach_copy'), undefined, 'одинаковая по байтам копия — один раз');
  assert.ok(await svc.image('G', 'img/pictures/beach_copy.png'), 'а открыть её можно — сердечко на ней в «Избранном» не ломается');
  assert.ok(albumOf('mid_a') && albumOf('mid_b'), 'одинаковые края при разной середине — не повтор');
  assert.deepStrictEqual(albumOf('loop_1').files.map(base), ['loop_1', 'loop_2', 'loop_3']);
  assert.deepStrictEqual([albumOf('dupA_1')?.files.length, albumOf('dupB_1')], [2, undefined]);
  assert.deepStrictEqual(albumOf('cutB_2').files.map(base), ['cutB_1', 'cutB_2']);
  assert.ok(albumOf('hall_1').key.startsWith('img/pictures/hall'), 'меню выбора сцен — не сцена');
  assert.deepStrictEqual(albumOf('lose_a').files.map(base), ['lose_a', 'lose_b']);
  assert.match(albumOf('lose_a').key, /^events\/\d+\/Нет!$/);
  assert.deepStrictEqual(albumOf('scr_1').files.map(base), ['scr_1', 'scr_2']);
  // Эмоции одного персонажа — одним альбомом; одиночки папки сцены — вместе
  assert.deepStrictEqual(albumOf('Aldos_Feliz').files.map(base), ['Aldos_bebado', 'Aldos_Feliz', 'Aldos_triste']);
  assert.deepStrictEqual(albumOf('arina_dance4').files.map(base), ['arina_dance4', 'arina_dance5_hyp']);
  assert.strictEqual(albumOf('oral01').kind, 'engine');
  const loop = albumOf('piston');
  assert.deepStrictEqual([loop.kind, loop.key], ['animation', 'scenes/ce4/Поршень#loop']);
  const files = index.albums.flatMap((a) => a.files);
  assert.ok(files.includes('movies/scene0.pprn#.webm') && !files.some((f) => f.includes('notes.dat')), files.filter((f) => f.startsWith('movies/')).join(', '));
  const movie = await svc.video('G', 'movies/scene0.pprn#.webm');
  assert.deepStrictEqual([path.basename(movie.file), movie.type], ['scene0.pprn', 'video/webm'], 'отдаётся сам файл, как WebM');
});

test('галерея: лист кадров PictureAnimation — анимация из кадров листа, каждый вырезан из своего места', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-sheet-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  // Лист из двух кадров по горизонтали: левый красный, правый синий
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=816x624', '-f', 'lavfi', '-i', 'color=c=blue:s=816x624',
    '-filter_complex', 'hstack', '-frames:v', '1', path.join(game, 'img', 'pictures', 'sheet.png')]);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Волны', list: [
    c(356, ['PA_INIT 2 6 横']), c(231, [1, 'sheet', 0, 0, 0, 0, 100, 100, 255, 0]), c(356, ['PA_START_LOOP 1 1']), c(101), c(401, ['…']), c(0)] }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  const anim = index.albums.find((a) => a.kind === 'animation');
  assert.ok(anim && anim.anim && anim.files.length === 2 && anim.fps === 10, JSON.stringify(index.albums));
  // Цвет кадра: первый кадр — из левой половины листа, второй — из правой
  const color = async (rel) => {
    const img = await svc.image('G', rel);
    const file = path.join(root, 'frame.webp');
    await fsp.writeFile(file, img.data);
    // Средний цвет кадра (обрезку по пикселю декодер WebP в ffmpeg не любит)
    const px = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', 'pipe:1']).stdout;
    assert.strictEqual(px.length, 3);
    // Кадр — весь цвет своей половины листа, а не точка на чёрном
    return px[2] > 150 && px[0] < 100 ? 'blue' : px[0] > 150 && px[2] < 100 ? 'red' : `?${[...px]}`;
  };
  // Кадр смотрят (ahead) — следующий кадр альбома склеивается тем же ffmpeg, заодно
  await svc.image('G', anim.files[0], true);
  assert.strictEqual((await fsp.readdir(path.join(root, '_media', 'G', 'scenes'))).filter((f) => f.endsWith('.webp')).length, 2);
  // Миниатюры склеек — тем же ffmpeg, что и кадры; лист нарезан на кадры один раз
  assert.strictEqual((await fsp.readdir(path.join(root, '_media', 'G', 'gallery'))).filter((f) => f.endsWith('.webp')).length, 2);
  assert.ok(await svc.thumb('G', anim.files[1]));
  assert.deepStrictEqual((await fsp.readdir(path.join(root, '_media', 'G', 'cells'))).length, 2);
  // Плеер просит кадры разом: сосед из той же пачки не заводит второй ffmpeg, очередь потом пуста
  await fsp.rm(path.join(root, '_media', 'G', 'scenes'), { recursive: true, force: true });
  let runs = 0;
  const render = svc.renderFrames.bind(svc);
  svc.renderFrames = (...args) => { runs++; return render(...args); };
  await Promise.all([svc.image('G', anim.files[0], true), svc.image('G', anim.files[1], true)]);
  assert.deepStrictEqual([runs, svc.frameJobs.size], [1, 0]);
  assert.deepStrictEqual([await color(anim.files[0]), await color(anim.files[1])], ['red', 'blue']);
});

test('галерея: сцены на общей основе — в порядке событий; огромный альбом по имени делится; сцена «набор_сцена_страница»', async (t) => {
  const { GalleryService, albumKey } = require('./src/services/gallery.js');
  assert.strictEqual(albumKey('img/pictures/e01_001_004.png_'), 'img/pictures/e01_001');
  assert.strictEqual(albumKey('img/pictures/x01 (1) (2).png'), 'img/pictures/x01');
  assert.strictEqual(albumKey('img/pictures/eva_c132_0_1_0211013_100000_0010_0.png_'), 'img/pictures/eva_c132');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-order-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  const pics = path.join(game, 'img', 'pictures');
  await fsp.mkdir(pics, { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  let uniq = 0;
  const png = (size = 200000) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(816, 16); b.writeUInt32BE(624, 20); b.writeUInt32BE(++uniq, size - 4); return b; };
  // Основа врезки и прозрачные части — общие для всех сцен; имена частей идут против порядка сцен
  await fsp.writeFile(path.join(pics, 'cut_base.png'), png());
  for (const n of ['common', 'z1', 'z2', 'y1', 'y2', 'x1', 'x2', 'w1', 'w2', 'v1', 'v2']) await fsp.writeFile(path.join(pics, `part_${n}.png`), png(2000));
  // Набор из 130 картинок одного имени с разными позами — делится по позе
  for (let i = 0; i < 130; i++) await fsp.writeFile(path.join(pics, `ac_01_pose${i % 5}_${String(i).padStart(3, '0')}.png`), png());
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (name, n) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const msg = (text) => [c(101), c(401, [text])];
  const scene = (id, a, b) => ({ id, name: `Сцена ${id}`, list: [show('cut_base', 1), show('part_common', 2), show(`part_${a}`, 3), ...msg('…'), show(`part_${b}`, 3), ...msg('…'), c(0)] });
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, scene(1, 'z1', 'z2'), scene(2, 'y1', 'y2'), scene(3, 'x1', 'x2'), scene(4, 'w1', 'w2'), scene(5, 'v1', 'v2')]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  assert.deepStrictEqual(index.albums.filter((a) => a.key.startsWith('events/')).map((a) => a.key.split('/').pop()), ['Сцена 1', 'Сцена 2', 'Сцена 3', 'Сцена 4', 'Сцена 5']);
  const sets = index.albums.filter((a) => a.key.includes('ac_01')).map((a) => [a.key.split('/').pop(), a.files.length]);
  assert.deepStrictEqual(sets, [0, 1, 2, 3, 4].map((k) => [`ac_01_pose${k}`, 26]));

  // Врезка: окно на пустом холсте (рамка рисунка — из замера) — кадр обрезается по окну; если слой поверх увеличен (где он
  // окажется, не знаем) — не обрезается
  const alpha = (size = 200000) => { const b = png(size); b[24] = 8; b[25] = 6; return b; };
  await fsp.writeFile(path.join(pics, 'win_base.png'), alpha());
  await fsp.writeFile(path.join(pics, 'win_part.png'), alpha(2000));
  await fsp.writeFile(path.join(pics, 'win_big.png'), png(2000));
  // Слои на холсте во весь экран без рамки (кадры анимации поверх окна): рамку им меряем, и обрезка их не срезает; нет рамки
  // (замер не вышел) или слой во весь экран — обрезки нет. Сплошной холст без рамки (win_solid) её тоже не даёт
  for (const n of ['cut_anim', 'cut_fail', 'cut_full']) await fsp.writeFile(path.join(pics, `${n}.png`), alpha(2000));
  await fsp.writeFile(path.join(pics, 'win_solid.png'), png(2000));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Окно', list: [show('win_base', 1), show('win_part', 2), ...msg('…'), c(0)] },
    { id: 2, name: 'Крупно', list: [show('win_base', 1), c(231, [2, 'win_big', 0, 0, 0, 0, 150, 150, 255, 0]), ...msg('…'), c(0)] },
    { id: 3, name: 'Анимация', list: [show('win_base', 1), show('cut_anim', 2), ...msg('…'), c(0)] },
    { id: 4, name: 'Сбой замера', list: [show('win_base', 1), show('cut_fail', 2), ...msg('…'), c(0)] },
    { id: 5, name: 'Полный слой', list: [show('win_base', 1), show('cut_full', 2), ...msg('…'), c(0)] },
    { id: 6, name: 'Сплошной', list: [show('win_base', 1), show('win_solid', 2), ...msg('…'), c(0)] }]));
  const boxes = { 'cut_anim.png': [0, 0, 0.2, 0.3], 'cut_full.png': [0, 0, 1, 1] };
  svc.opaqueShare = async (file) => {
    if (path.basename(file) === 'cut_fail.png') throw new Error('ffmpeg не ответил');
    return { share: 0.3, cols: 0.5, box: boxes[path.basename(file)] || [0.25, 0.125, 0.75, 0.625] };
  };
  await svc.runBuild('G', { done: 0, total: 0 });
  const frames = Object.values(JSON.parse(await fsp.readFile(svc.scenesPath('G'), 'utf8')));
  const cropOf = (top) => frames.find((ls) => ls.some((l) => l.name === top))[0].crop;
  assert.deepStrictEqual([cropOf('win_part'), cropOf('win_big')], [[204, 78, 408, 312], undefined]);
  // Окно и слой в углу — вместе: [0, 0, 612, 390]; слой не вышел за обрезку
  assert.deepStrictEqual(cropOf('cut_anim'), [0, 0, 612, 390]);
  assert.deepStrictEqual([cropOf('cut_fail'), cropOf('cut_full'), cropOf('win_solid')], [undefined, undefined, undefined]);
});

test('галерея: прозрачность меряется по краям альбома и запоминается; экран без явного размера — по картинкам', async (t) => {
  const { GalleryService, classify } = require('./src/services/gallery.js');
  // Вертикальный экран (мобильная игра): CG выше, чем шире, — всё равно CG, а не персонаж
  assert.strictEqual(classify({ w: 624, h: 816, size: 700000 }, { w: 624, h: 816 }, 'img/pictures/ev1.png'), 'cg');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-opaque-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const pics = path.join(root, 'G', 'img', 'pictures');
  await fsp.mkdir(pics, { recursive: true });
  await fsp.mkdir(path.join(root, 'G', 'data'), { recursive: true });
  // PNG с прозрачностью (тип цвета 6), плотный по байтам; 1440×900, а экран нигде не записан (816×624 по умолчанию)
  let uniq = 0;
  const png = (w, h, size, type = 6) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = type; b.writeUInt32BE(++uniq, size - 4); return b; };
  // Доля непрозрачного и ширина рисунка: reiri1 и st_b1 — фигура узкой полосой (персонаж в рост)
  const opaque = { ev_a1: [0.95, 1], ev_a2: [0.1, 0.3], ev_a3: [0.97, 1], st_b1: [0.2, 0.28], st_b2: [0.5, 0.9], st_b3: [0.95, 1], reiri1: [0.15, 0.28] };
  for (const name of Object.keys(opaque)) await fsp.writeFile(path.join(pics, `${name}.png`), png(1440, 900, 300000));
  // Ещё картинки того же размера без прозрачности (тип 2) — их не меряем; размер экрана — по десятку картинок
  for (let i = 0; i < 6; i++) await fsp.writeFile(path.join(pics, `bg${i}.png`), png(1440, 900, 300000, 2));
  await fsp.writeFile(path.join(root, 'G', 'data', 'System.json'), '{}');
  await fsp.writeFile(path.join(root, 'G', 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Ночь', list: [c(231, [1, 'ev_a1', 0, 0, 0, 0, 100, 100, 255, 0]), c(101), c(401, ['…']), c(0)] }]));
  await fsp.writeFile(path.join(root, 'G', 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const asked = [];
  svc.opaqueShare = async (file) => { const n = path.basename(file, '.png'); asked.push(n); return { share: opaque[n][0], cols: opaque[n][1] }; };
  const job = { done: 0, total: 0 };
  const index = await svc.runBuild('G', job);
  assert.deepStrictEqual(index.screen, { w: 1440, h: 900 });
  // ev_a: края по одну сторону — середину не меряем (остаётся CG); st_b: края разошлись — меряем каждую
  assert.deepStrictEqual(asked.sort(), ['ev_a1', 'ev_a3', 'reiri1', 'st_b1', 'st_b2', 'st_b3']);
  assert.strictEqual(job.done, job.total, 'замеры — в счётчике сборки');
  const kind = (n) => index.albums.find((a) => a.files.includes(`img/pictures/${n}.png`))?.kind;
  assert.strictEqual(kind('ev_a2'), 'cg');
  assert.strictEqual(kind('reiri1'), 'layer', 'почти пустой холст — слой');
  assert.strictEqual(kind('st_b3'), 'cg');
  // Пересборка берёт прежние замеры; файл другого размера меряется заново
  asked.length = 0;
  await fsp.writeFile(path.join(pics, 'st_b2.png'), png(1440, 900, 300001));
  await svc.runBuild('G', { done: 0, total: 0 });
  assert.deepStrictEqual(asked, ['st_b2']);
  // ffmpeg не справился — картинка непрозрачная, сборка не падает
  svc.opaqueShare = async () => { throw new Error('нет ffmpeg'); };
  await fsp.rm(path.join(root, '_media', 'G', 'gallery-opaque.json'));
  assert.ok((await svc.runBuild('G', { done: 0, total: 0 })).albums.every((a) => a.kind !== 'layer'));
});

test('галерея: прозрачный «фон по имени» — слой; копии на разных языках — одна; mp4 и webm — один ролик; звук ролика — в оглавлении', async (t) => {
  const { GalleryService, albumKey } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-rules-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures', 'movies', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (size, type = 2) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(1440, 16); b.writeUInt32BE(900, 20); b[24] = 8; b[25] = type; b.writeUInt32BE(++uniq, size - 4); return b; };
  const put = (name, data) => fsp.writeFile(path.join(game, 'img', 'pictures', name), data);
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 1440, screenHeight: 900 } }));
  // Фон по имени с прозрачностью: героиня в рост («battle_…»), дымка («Effect_…») — слои; настоящий фон («Back_…») — фон
  const share = { Back_street: [1, 1], battle_hero: [0.2, 0.5], Effect_haze: [0.01, 0.05] };
  for (const n of Object.keys(share)) await put(`${n}.png`, png(300000, 6));
  // Одна карточка на трёх языках: распознавание судило бы каждую отдельно — остаётся английская
  for (const l of ['ja-JP', 'zh-CN', 'en-US']) await put(`card_1-${l}.png`, png(300000));
  // Одиночное «_es» — не наверняка язык: «photo» и «photo_es» одного размера остаются обе
  await put('photo.png', png(300000));
  await put('photo_es.png', png(300000));
  // Копия с языком в имени — и другого размера (корейская выше); без языка и другого размера — другая картинка
  const tall = (b, h) => { b.writeUInt32BE(h, 20); return b; };
  for (const l of ['', '_cn', '_en', '_tc']) await put(`scene_1${l}.png`, png(300000));
  await put('scene_1_ko.png', tall(png(300000), 840));
  await put('title.png', tall(png(300000), 600));
  for (const l of ['_en', '_jp']) await put(`title${l}.png`, png(300000));
  // Два коротких языка и другой размер — скорее позы: остаётся
  await put('face.png', png(300000));
  await put('face_it.png', tall(png(300000), 840));
  await put('face_de.png', png(300000));
  // «1406» и «1406_zh-CN» одинаковы по байтам, обе в событии; две картинки с разными именами и тем же содержимым — тоже
  const same = png(300000);
  await put('1406.png', same);
  await put('1406_zh-CN.png', same);
  const twin = png(300000);
  await put('kiss_a.png', twin);
  await put('hug_b.png', twin);
  await put('third_c.png', png(300000));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => [c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]), c(101), c(401, ['…'])];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Карточка', list: [...show(1, '1406'), ...show(2, '1406_zh-CN'), ...show(3, 'third_c'), c(0)] },
    { id: 2, name: 'Двойник', list: [...show(1, 'kiss_a'), ...show(2, 'hug_b'), ...show(3, 'third_c'), c(0)] }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  // Ролики: каждый в двух форматах; «fog» длинный и со звуком, «green» короткий и без звука (петля)
  for (const n of ['fog.mp4', 'fog.webm', 'green.mp4', 'green.webm']) await fsp.writeFile(path.join(game, 'movies', n), 'x');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.opaqueShare = async (file) => { const [s, cols] = share[path.basename(file, '.png')] || [1, 1]; return { share: s, cols }; };
  svc.probe = async (file) => (/green/.test(file) ? { duration: 1, audio: false } : { duration: 30, audio: true });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const kindOf = (rel) => index.albums.find((a) => a.files.includes(rel))?.kind;
  assert.deepStrictEqual(['Back_street', 'battle_hero', 'Effect_haze'].map((n) => kindOf(`img/pictures/${n}.png`)), ['backdrop', 'layer', 'layer']);
  const listed = index.albums.flatMap((a) => a.files);
  assert.deepStrictEqual(listed.filter((f) => /card_1/.test(f)), ['img/pictures/card_1-en-US.png']);
  assert.ok(index.parts.includes('img/pictures/card_1-ja-JP.png') && index.parts.includes('img/pictures/card_1-zh-CN.png'), 'убранные копии открываются (избранное)');
  assert.deepStrictEqual(listed.filter((f) => /photo/.test(f)).sort(), ['img/pictures/photo.png', 'img/pictures/photo_es.png']);
  assert.deepStrictEqual(listed.filter((f) => /scene_1/.test(f)), ['img/pictures/scene_1_en.png']);
  assert.deepStrictEqual(listed.filter((f) => /title/.test(f)).sort(), ['img/pictures/title.png', 'img/pictures/title_en.png']);
  assert.deepStrictEqual(listed.filter((f) => /face/.test(f)).sort(), ['img/pictures/face.png', 'img/pictures/face_it.png']);
  const event = (title) => index.albums.find((a) => a.key.startsWith('events/') && a.key.endsWith(title));
  assert.deepStrictEqual(event('Карточка').files, ['img/pictures/1406.png', 'img/pictures/third_c.png']);
  assert.strictEqual(event('Двойник').files.filter((f) => /kiss_a|hug_b/.test(f)).length, 1, 'копия по байтам в альбоме события — одна');
  assert.deepStrictEqual(listed.filter((f) => f.startsWith('movies/')).sort(), ['movies/fog.mp4', 'movies/green.mp4']);
  assert.ok(index.parts.includes('movies/fog.webm') && index.parts.includes('movies/green.webm'));
  const fog = index.albums.find((a) => a.files.includes('movies/fog.mp4'));
  const green = index.albums.find((a) => a.files.includes('movies/green.mp4'));
  assert.deepStrictEqual([fog.kind, fog.audio, green.kind, green.audio], ['video', true, 'animation', undefined]);

  // Номер кадра и одна буква через пробел («Daisy Boob job 8 D») — кадры одной сцены; «8D» и номер в конце — как были
  assert.strictEqual(albumKey('img/pictures/Daisy Boob job 8 D.png'), 'img/pictures/Daisy Boob job');
  assert.strictEqual(albumKey('img/pictures/Daisy Boob job 17 S.png'), 'img/pictures/Daisy Boob job');
  assert.strictEqual(albumKey('img/pictures/ct_02b.png'), 'img/pictures/ct');
  assert.strictEqual(albumKey('img/pictures/Scene 3 12.png'), 'img/pictures/Scene 3');
  assert.strictEqual(albumKey('img/pictures/2 D.png'), 'img/pictures/D');
});


test('галерея: набор Spine — один альбом-анимация, кадр на каждую анимацию, листы текстур не в других альбомах', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-spine-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  const dir = path.join(game, 'img', 'spines', 'hero');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  await fsp.writeFile(path.join(game, 'data', 'System.json'), '{}');
  const png = Buffer.alloc(300000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(1024, 16); png.writeUInt32BE(1024, 20); png[24] = 8; png[25] = 6;
  await fsp.writeFile(path.join(dir, 'hero.png'), png);
  await fsp.writeFile(path.join(dir, 'hero2.png'), png);
  await fsp.writeFile(path.join(dir, 'hero.atlas'), '\nhero.png\nsize: 1024,1024\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\narm\n  rotate: false\n  xy: 0, 0\n  size: 8, 8\n\nhero2.png\nsize: 1024,1024\nformat: RGBA8888\n');
  await fsp.writeFile(path.join(dir, 'hero.json'), JSON.stringify({ skeleton: { spine: '3.8.87' }, bones: [{ name: 'root' }], slots: [{ name: 'arm', bone: 'root', attachment: 'arm' }], skins: [{ name: 'default', attachments: { arm: { arm: {} } } }], animations: { idle: {}, 'dance loop': {} } }));
  // Рядом чужой атлас без скелета нужной версии (Spine 4.2 плеер не читает) — остаётся как было
  await fsp.writeFile(path.join(dir, 'new.atlas'), 'new.png\nsize: 8,8\n');
  await fsp.writeFile(path.join(dir, 'new.json'), JSON.stringify({ skeleton: { spine: '4.2.1' }, animations: { a: {} } }));
  // Кукла (портрет): картинки слотов — в скинах, а скин по умолчанию пуст — как набор не годится
  await fsp.writeFile(path.join(dir, 'doll.png'), png);
  await fsp.writeFile(path.join(dir, 'doll.atlas'), '\ndoll.png\nsize: 1024,1024\n');
  await fsp.writeFile(path.join(dir, 'doll.json'), JSON.stringify({ skeleton: { spine: '3.8.75' }, slots: [{ name: 'a', bone: 'root', attachment: 'face' }], skins: [{ name: 'default', attachments: {} }, { name: 'face/1', attachments: { a: { face: {} } } }], animations: { idle: {} } }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const spine = index.albums.filter((a) => a.spine);
  assert.equal(spine.length, 1);
  assert.equal(spine[0].kind, 'animation');
  assert.equal(spine[0].key, 'img/spines/hero/hero');
  assert.deepEqual(spine[0].files, ['img/spines/hero/hero.json#idle', 'img/spines/hero/hero.json#dance loop']);
  assert.deepEqual(spine[0].spine.pages, ['img/spines/hero/hero.png', 'img/spines/hero/hero2.png']);
  assert.equal(spine[0].cover, 'img/spines/hero/hero.png');
  // Листы текстур — не отдельные картинки в других альбомах
  assert.deepEqual(index.albums.filter((a) => !a.spine).flatMap((a) => a.files).filter((f) => /\/hero2?\.png$/.test(f)), []);
  // Кукла как набор не взята: её лист остаётся картинкой, как был
  assert.equal(spine.length, 1);
  // Плеер получает только файлы набора
  assert.equal((await svc.spineFile('G', 'img/spines/hero/hero.atlas')).type, 'text/plain; charset=utf-8');
  assert.equal((await svc.spineFile('G', 'img/spines/hero/hero2.png')).type, 'image/png');
  assert.equal(await svc.spineFile('G', 'data/System.json'), null);
  assert.equal(await svc.spineFile('G', 'img/spines/hero/../../../data/System.json'), null);
});

test('галерея: модели Live2D — альбом на модель из списка плагина, движения и выражения, ядро с новейшим moc, листы текстур не в других альбомах', async (t) => {
  const { GalleryService, mocVersion, live2dCore } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-live2d-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  const put = async (rel, data) => { await fsp.mkdir(path.dirname(path.join(game, rel)), { recursive: true }); await fsp.writeFile(path.join(game, rel), data); };
  const png = Buffer.alloc(300000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(2048, 16); png.writeUInt32BE(2048, 20); png[24] = 8; png[25] = 6;
  const moc = (v) => Buffer.concat([Buffer.from('MOC3', 'latin1'), Buffer.from([v]), Buffer.alloc(64)]);
  await put('data/System.json', '{}');
  // Плагины: PictureLive2D (список «папка/имя») и Live2DInterfaceMZ (Modelname + folderpath, строка в строке, ключи без кавычек).
  // В списке чужого плагина «stray/stray» не считается
  await put('js/plugins.js', `var $plugins = [
  { name: "PictureLive2D", status: true, parameters: { "json file": '["hero/hero","none/none","broken/broken","bad/bad"]' } },
  { name: "Live2DInterfaceMZ", status: true, parameters: { Modelcondition: '["{\\\\"Modelname\\\\":\\\\"ドロシー\\\\",\\\\"folderpath\\\\":\\\\"./assets/Dorothy/\\\\",\\\\"motiongroupnames\\\\":\\\\"\\\\"}"]' } },
  { name: "SomethingElse", status: true, parameters: { "json file": '["stray/stray"]' } },
];`);
  const model = (extra = {}) => JSON.stringify({ Version: 3, FileReferences: { Moc: 'm.moc3', Textures: ['m.2048/texture_00.png'], Physics: 'm.physics3.json', ...extra } });
  // Герой: две группы движений с одинаковым именем файла, третье движение — файла нет, два выражения
  await put('img/live2d/hero/hero.model3.json', JSON.stringify({ Version: 3, FileReferences: {
    Moc: 'hero.moc3', Textures: ['hero.2048/texture_00.png'], Physics: 'hero.physics3.json',
    Expressions: [{ Name: 'smile', File: 'exp/smile.exp3.json' }, { Name: 'sad', File: 'exp/sad.exp3.json' }, { Name: 'gone', File: 'exp/gone.exp3.json' }],
    Motions: { Idle: [{ File: 'm/idle.motion3.json' }, { File: 'm/absent.motion3.json' }], Tap: [{ File: 'm2/idle.motion3.json' }] },
  } }));
  await put('img/live2d/hero/hero.moc3', moc(3));
  await put('img/live2d/hero/hero.2048/texture_00.png', png);
  await put('img/live2d/hero/hero.physics3.json', '{}');
  for (const f of ['m/idle', 'm2/idle']) await put(`img/live2d/hero/${f}.motion3.json`, '{}');
  for (const f of ['smile', 'sad']) await put(`img/live2d/hero/exp/${f}.exp3.json`, '{}');
  // Interface-стиль: файл — «папка/последняя часть папки.model3.json», движений нет — одна поза с выражением
  await put('assets/Dorothy/Dorothy.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'Dorothy.moc3', Textures: ['Dorothy.2048/texture_00.png'], Expressions: [{ Name: 'wink', File: 'wink.exp3.json' }] } }));
  await put('assets/Dorothy/Dorothy.moc3', moc(5));
  await put('assets/Dorothy/Dorothy.2048/texture_00.png', png);
  await put('assets/Dorothy/wink.exp3.json', '{}');
  // Не берём: нет текстуры; не moc3; нет в списке плагина Live2D
  await put('img/live2d/broken/broken.model3.json', model());
  await put('img/live2d/broken/m.moc3', moc(3));
  await put('img/live2d/bad/bad.model3.json', model());
  await put('img/live2d/bad/m.moc3', 'not a moc');
  await put('img/live2d/bad/m.2048/texture_00.png', png);
  await put('img/live2d/bad/m.physics3.json', '{}');
  await put('img/live2d/stray/stray.model3.json', model({ Motions: { Idle: [{ File: 's.motion3.json' }] } }));
  await put('img/live2d/stray/m.moc3', moc(3));
  await put('img/live2d/stray/m.2048/texture_00.png', png);
  await put('img/live2d/stray/m.physics3.json', '{}');
  await put('img/live2d/stray/s.motion3.json', '{}');
  // Два ядра: старое в js/libs (до 4.2), новее — в js/plugins (до 5.0)
  await put('js/libs/live2dcubismcore.min.js', '/* MocVersion_30 MocVersion_33 MocVersion_40 MocVersion_42 */');
  await put('js/plugins/live2dcubismcore.min.js', '/* MocVersion_30 MocVersion_33 MocVersion_40 MocVersion_42 MocVersion_50 */');
  // Версия moc: «MOC3» и номер; всё остальное — не moc
  assert.equal(mocVersion(moc(3)), 3);
  assert.equal(mocVersion(Buffer.from('MOC2\u0001')), 0);
  assert.equal(mocVersion(Buffer.from('MOC3')), 0);
  assert.deepEqual(await live2dCore(game), { rel: 'js/plugins/live2dcubismcore.min.js', moc: 5 });
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const rigs = index.albums.filter((a) => a.live2d).sort((a, b) => (a.key < b.key ? -1 : 1));
  assert.deepEqual(rigs.map((a) => a.key), ['assets/Dorothy/Dorothy', 'img/live2d/hero/hero']);
  const [dorothy, hero] = rigs;
  assert.equal(hero.kind, 'animation');
  assert.deepEqual(hero.files, ['img/live2d/hero/hero.model3.json#idle', 'img/live2d/hero/hero.model3.json#Tap/idle']);
  assert.deepEqual(hero.live2d, { model: 'img/live2d/hero/hero.model3.json', moc: 3, core: 'js/plugins/live2dcubismcore.min.js', coreMoc: 5, motions: [['idle', 'Idle', 0], ['Tap/idle', 'Tap', 0]], exps: ['smile', 'sad'] });
  assert.equal(hero.cover, 'img/live2d/hero/hero.2048/texture_00.png');
  // Модель без движений — один кадр-поза (номер -1), название — из плагина
  assert.deepEqual(dorothy.files, ['assets/Dorothy/Dorothy.model3.json#Dorothy']);
  assert.deepEqual(dorothy.live2d.motions, [['Dorothy', '', -1]]);
  assert.equal(dorothy.live2d.name, 'ドロシー');
  assert.deepEqual(dorothy.live2d.exps, ['wink']);
  // Листы текстур отданных моделей — не картинки в других альбомах; чужая модель остаётся как была
  const others = index.albums.filter((a) => !a.live2d).flatMap((a) => a.files);
  assert.deepEqual(others.filter((f) => /hero\.2048|Dorothy\.2048/.test(f)), []);
  assert.ok(others.includes('img/live2d/stray/m.2048/texture_00.png'), 'модель вне списка плагина — текстура на месте');
  // Перечень для плеера: файлы моделей и ядро, больше ничего
  assert.ok(index.live2dFiles.includes('img/live2d/hero/hero.moc3') && index.live2dFiles.includes('js/plugins/live2dcubismcore.min.js'));
  assert.ok(!index.live2dFiles.some((f) => /stray|broken|bad|System|libs/.test(f)));
  assert.equal((await svc.live2dFile('G', 'img/live2d/hero/hero.moc3')).type, 'application/octet-stream');
  assert.equal((await svc.live2dFile('G', 'IMG/live2d/Hero/HERO.model3.JSON')).type, 'application/json', 'регистр букв не важен');
  assert.equal((await svc.live2dFile('G', 'js/plugins/live2dcubismcore.min.js')).type, 'text/javascript; charset=utf-8');
  for (const bad of ['data/System.json', 'img/live2d/stray/stray.model3.json', 'js/libs/live2dcubismcore.min.js', 'img/live2d/hero/../../../data/System.json', 'img/live2d/hero/m/absent.motion3.json', '', null]) {
    assert.equal(await svc.live2dFile('G', bad), null, String(bad));
  }
});

test('галерея: кадры PictureAnimation по номерам — анимация, а не портреты; «X#parts» после облака — в альбом «X»', async (t) => {
  const { analyze } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  // «連番»: кадры — отдельные файлы «портретного» размера, листа нет
  const names = ['pa_00', 'pa_01', 'pa_02', 'pa_03'];
  const list = [c(356, ['PA_INIT 4 2 連番']), c(231, [1, 'pa_00', 0, 0, 0, 0, 100, 100, 255, 0]), c(356, ['PA_START_LOOP 1 1']), c(101), c(401, ['…']), c(0)];
  const { clips } = analyze([{ id: 'ce1', name: 'Анимация', where: '', list }], [], () => 'portrait', () => false, names, [], () => false);
  assert.deepStrictEqual(clips.map((cl) => cl.finished.map((f) => f.name)), [names]);
  assert.strictEqual(clips[0].wait, 2, 'темп — как в игре');

  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-parts-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'G', 'img', 'pictures'), { recursive: true });
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const built = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  // Облако признало детали сцены CG: они — часть альбома «sc» (и «sc 4#parts» — тоже «sc», номер не в счёт), а не вторая плитка «sc#parts»
  const albums = [{ key: 'img/pictures/sc', kind: 'cg', w: 1, h: 1, files: ['img/pictures/sc_1.png', 'img/pictures/sc_10.png'] },
    { key: 'img/pictures/sc#parts', kind: 'layer', w: 1, h: 1, files: ['img/pictures/sc_2.png'] },
    { key: 'img/pictures/solo#parts', kind: 'layer', w: 1, h: 1, files: ['img/pictures/solo_1.png'] },
    { key: 'img/pictures/sc 4#parts', kind: 'layer', w: 1, h: 1, files: ['img/pictures/sc_11.png'] },
    // «ev10#parts» — к «ev10», хотя «ev» (тот же ключ без номера) стоит в списке раньше
    { key: 'img/pictures/ev', kind: 'cg', w: 1, h: 1, files: ['img/pictures/ev_1.png'] },
    { key: 'img/pictures/ev10', kind: 'cg', w: 1, h: 1, files: ['img/pictures/ev10_1.png'] },
    { key: 'img/pictures/ev10#parts', kind: 'layer', w: 1, h: 1, files: ['img/pictures/ev10_2.png'] }];
  await fsp.writeFile(svc.indexPath('G'), JSON.stringify({ ...built, albums, counts: { cg: 4, layer: 4 } }));
  await fsp.writeFile(svc.cloudPath('G'), JSON.stringify({ built: built.builtAt, promote: ['img/pictures/sc#parts', 'img/pictures/solo#parts', 'img/pictures/sc 4#parts', 'img/pictures/ev10#parts'] }));
  svc.memo.clear();
  const index = await svc.cached('G');
  assert.deepStrictEqual(index.albums.map((a) => [a.key, a.kind, a.files.length]),
    [['img/pictures/sc', 'cg', 4], ['img/pictures/solo#parts', 'cg', 1], ['img/pictures/ev', 'cg', 1], ['img/pictures/ev10', 'cg', 2]]);
  // Детали — в конец альбома: его порядок (у альбома события — порядок события) не переставляется
  assert.deepStrictEqual(index.albums[0].files, ['img/pictures/sc_1.png', 'img/pictures/sc_10.png', 'img/pictures/sc_2.png', 'img/pictures/sc_11.png']);
  assert.deepStrictEqual(index.counts, { cg: 8 });
  assert.ok(await svc.knows('G', 'img/pictures/sc_2.png'));
});

test('галерея: панель на холсте во весь экран с окном посередине — склейка обрезана по рамке основы и деталей', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-window-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  // Прозрачный PNG (тип 6) на весь экран 1440×900, лёгкий по байтам: «слой» — основа и детали панели
  const png = () => { const b = Buffer.alloc(20000); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(1440, 16); b.writeUInt32BE(900, 20); b[24] = 8; b[25] = 6; b.writeUInt32BE(++uniq, 19996); return b; };
  for (const n of ['SW-1', 'SW-face1', 'SW-face2', 'SW-fx']) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png());
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const log = (text) => c(357, ['BattleLogOutput', 'OUTPUT_LOG', '', { message: text }]);
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 1440, screenHeight: 900 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Окно', list: [show(1, 'SW-1'), show(2, 'SW-face1'), show(3, 'SW-fx'), log('a'), show(2, 'SW-face2'), log('b'), c(0)] }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.thumb = async (id, rel) => rel;
  svc.vision = { available: true, version: 'v', score: async () => 0.9 };
  // Замера прозрачности у этих файлов не было (слои не меряют): рамку основы и деталей меряет сама сборка панели
  const box = { 'SW-1': [0.3, 0.2, 0.7, 0.8], 'SW-face1': [0.35, 0.3, 0.6, 0.7], 'SW-face2': [0.35, 0.3, 0.6, 0.7], 'SW-fx': [0, 0, 1, 1] };
  svc.opaqueShare = async (file) => ({ share: 0.1, cols: 0.2, box: box[path.basename(file, '.png')] });
  const quiet = t.mock.method(console, 'log', () => {});
  await svc.runBuild('G', { done: 0, total: 0 });
  await svc.visionPass('G');
  quiet.mock.restore();
  const index = await svc.cached('G');
  const ev = index.albums.find((a) => a.key.startsWith('events/'));
  assert.ok(ev && ev.panel, JSON.stringify(index.albums.map((a) => a.key)));
  const frames = await svc.scenesOf('G');
  assert.deepStrictEqual(frames[ev.files[0].slice(4)][0].crop, [432, 180, 576, 540], 'окно, а не плитка 1440×900 с чёрным вокруг; эффект на весь экран окна не задаёт');
});

test('галерея: короткая покадровая анимация — если игра сама перечисляет кадры в параметрах плагина', async (t) => {
  const { GalleryService, isFrameSequence } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-listed-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'G', 'js'), { recursive: true });
  // Параметры плагина — JSON внутри JSON (так у Drill_up): список кадров лежит на два уровня глубже
  const param = (names) => JSON.stringify({ 动作元: JSON.stringify({ 资源: JSON.stringify(names), 帧间隔: 4 }) });
  const long = Array.from({ length: 70 }, (_, i) => `Seq-${String(i).padStart(3, '0')}`);
  const plugins = [
    { name: 'Gif', status: true, parameters: { a: param(['Boat-001', 'Boat-002', 'Boat-003']), b: param(['Page_1', 'Face_1']), c: param(long) } },
    { name: 'Off', status: false, parameters: { a: param(['Lean_1', 'Lean_2']) } }];
  await fsp.writeFile(path.join(root, 'G', 'js', 'plugins.js'), `// Generated\nvar $plugins =\n${JSON.stringify(plugins)};\n`);
  const dir = 'img/Special__actionSeq/';
  const rels = ['Boat-001', 'Boat-002', 'Boat-003', 'Lean_1', 'Lean_2', ...long].map((n) => `${dir}${n}.rpgmvp`);
  const entries = new Map([...rels, 'img/pictures/Page_1.rpgmvp', 'img/faces/Face_1.rpgmvp'].map((r) => [r, {}]));
  const svc = new GalleryService();
  const listed = await svc.listedFrames(path.join(root, 'G'), entries);
  // Только включённый плагин, только кадры одной папки, и не список на сотни имён (предзагрузка)
  assert.deepStrictEqual(listed.map((set) => [...set]), [rels.slice(0, 3)]);
  const boat = rels.slice(0, 3);
  assert.deepStrictEqual([isFrameSequence(boat, () => '1x1'), isFrameSequence(boat, () => '1x1', true)], [false, true], 'три кадра без нулей — страницы, пока игра не назвала их списком');
  // Список не лечит неровные номера, разные размеры и одиночку
  assert.deepStrictEqual([isFrameSequence([boat[0], boat[1], `${dir}Boat-009.rpgmvp`], () => '1x1', true), isFrameSequence(boat, (f) => (f === boat[2] ? '2x2' : '1x1'), true), isFrameSequence([boat[0]], () => '1x1', true)], [false, false, false]);
});

test('галерея: портреты разговора (узкая фигура в рост у нижнего края, основа в десятках событий) не становятся CG-панелями', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-talk-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = () => { const b = Buffer.alloc(20000); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(1440, 16); b.writeUInt32BE(900, 20); b[24] = 8; b[25] = 6; b.writeUInt32BE(++uniq, 19996); return b; };
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const log = (text) => c(357, ['BattleLogOutput', 'OUTPUT_LOG', '', { message: text }]);
  // talk — говорящая: фигура 405×600 справа внизу, её показывают десять событий; hero — такая же узкая, но в двух
  // событиях (сцена); wide — широкая сцена посередине
  const names = ['talk-base', 'hero-base', 'wide-base', 'hero2-base'];
  const events = [];
  for (let i = 0; i < 10; i++) { names.push(`talk-f${i}a`, `talk-f${i}b`); events.push({ id: events.length + 1, name: `Talk${i}`, list: [show(1, 'talk-base'), show(2, `talk-f${i}a`), log('a'), show(2, `talk-f${i}b`), log('b'), c(0)] }); }
  for (let i = 0; i < 2; i++) {
    names.push(`hero-f${i}a`, `hero-f${i}b`, `wide-f${i}a`, `wide-f${i}b`);
    events.push({ id: events.length + 1, name: `Hero${i}`, list: [show(1, 'hero-base'), show(2, `hero-f${i}a`), log('a'), show(2, `hero-f${i}b`), log('b'), c(0)] });
    events.push({ id: events.length + 1, name: `Wide${i}`, list: [show(1, 'wide-base'), show(2, `wide-f${i}a`), log('a'), show(2, `wide-f${i}b`), log('b'), c(0)] });
  }
  // side — спрайт шире TALK_W (576 из 1440), но вместе с лицами 576×810 (0,71 — уже TALK_RATIO): портрет по фигуре, у основы с
  // номером («side-base0…9») одна семья в десяти событиях. hero2 — тот же спрайт в двух событиях: сцена. solo — цифра перед
  // основой («solo0-base»): у каждого события своя семья, тоже сцена
  for (let i = 0; i < 10; i++) {
    names.push(`side-base${i}`, `side-f${i}a`, `side-f${i}b`, `solo${i}-base`, `sf${i}a`, `sf${i}b`);
    events.push({ id: events.length + 1, name: `Side${i}`, list: [show(1, `side-base${i}`), show(2, `side-f${i}a`), log('a'), show(2, `side-f${i}b`), log('b'), c(0)] });
    events.push({ id: events.length + 1, name: `Solo${i}`, list: [show(1, `solo${i}-base`), show(2, `sf${i}a`), log('a'), show(2, `sf${i}b`), log('b'), c(0)] });
  }
  for (let i = 0; i < 2; i++) {
    names.push(`h2-f${i}a`, `h2-f${i}b`);
    events.push({ id: events.length + 1, name: `Hero2-${i}`, list: [show(1, 'hero2-base'), show(2, `h2-f${i}a`), log('a'), show(2, `h2-f${i}b`), log('b'), c(0)] });
  }
  for (const n of [...new Set(names)]) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png());
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 1440, screenHeight: 900 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, ...events]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.thumb = async (id, rel) => rel;
  svc.vision = { available: true, version: 'v', score: async () => 0.9 };
  const box = (n) => (/^(side-base|hero2-base|solo\d+-base)/.test(n) ? [0.55, 0.33, 0.95, 1] : /^(side-f|h2-f|sf\d)/.test(n) ? [0.65, 0.1, 0.85, 0.4]
    : /^wide/.test(n) ? [0.3, 0.2, 0.7, 0.8] : /f\d/.test(n) ? [0.75, 0.4, 0.95, 0.6] : [0.72, 0.33, 1, 1]);
  svc.opaqueShare = async (file) => ({ share: 0.1, cols: 0.2, box: box(path.basename(file, '.png')) });
  const quiet = t.mock.method(console, 'log', () => {});
  await svc.runBuild('G', { done: 0, total: 0 });
  await svc.visionPass('G');
  quiet.mock.restore();
  const index = await svc.cached('G');
  const frames = await svc.scenesOf('G');
  const bases = index.albums.filter((a) => a.panel).flatMap((a) => a.files.map((f) => frames[f.slice(4)][0].name));
  // Распознавание признало бы все кадры сценой (0.9): отсеивает портреты именно рамка и число событий
  // Узкая «side» по фигуре (с лицами) — портрет и без этого, как и «talk»; «hero2» и «solo*» — сцены
  assert.deepStrictEqual([...new Set(bases)].sort(), ['hero-base', 'hero2-base', ...Array.from({ length: 10 }, (_, i) => `solo${i}-base`), 'wide-base']);
  assert.strictEqual(bases.length, 32);
});


test('галерея: диалоги — разговоры с портретами, убранные из CG, становятся альбомами «dialogue» со сценарием; остальные альбомы, ключи и счёт те же; сводка сцены; старое оглавление без сводки', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-dialogue-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (w = 1440, h = 900) => { const b = Buffer.alloc(20000); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6; b.writeUInt32BE(++uniq, 19996); return b; };
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, x = 0, y = 0) => c(231, [n, name, 0, 0, x, y, 100, 100, 255, 0]);
  const say = (text) => [c(101), c(401, [text])];
  // talk — говорящая: основа и лица 405×900 справа, в десяти событиях (портрет; у склейки с основой такого размера есть обрезка по основе); wide — широкая сцена посередине в двух событиях
  const names = ['talk-base', 'wide-base'];
  const events = [];
  for (let i = 0; i < 10; i++) { names.push(`talk-f${i}a`, `talk-f${i}b`); events.push({ id: events.length + 1, name: `Talk${i}`, list: [show(1, 'talk-base', 1035), show(2, `talk-f${i}a`, 1035), ...say('a'), show(2, `talk-f${i}b`, 1035), ...say('b'), c(0)] }); }
  // Стоячий портрет по имени события — не CG, что бы ни ответило распознавание: тоже диалог. Немое окно (одни коды без текста) — нет
  names.push('wide-fs', 'wide-ft');
  events.push({ id: events.length + 1, name: 'Standing 1', list: [show(1, 'wide-base'), show(2, 'wide-fs'), ...say('s1'), show(2, 'wide-ft'), c(0)] });
  names.push('talk-s0a', 'talk-s0b');
  events.push({ id: events.length + 1, name: 'Silent', list: [show(1, 'talk-base', 1035), show(2, 'talk-s0a', 1035), ...say('\\.'), show(2, 'talk-s0b', 1035), ...say('\\.'), c(0)] });
  for (let i = 0; i < 2; i++) { names.push(`wide-f${i}a`, `wide-f${i}b`); events.push({ id: events.length + 1, name: `Wide${i}`, list: [show(1, 'wide-base'), show(2, `wide-f${i}a`), ...say('a'), show(2, `wide-f${i}b`), ...say('b'), c(0)] }); }
  // Смесь: два кадра-портрета и один широкий, что уже показан событием выше (кадр достался ему): своего альбома у смеси нет, но портреты ушли новым правилом — это диалог
  events.push({ id: events.length + 1, name: 'Mixed', list: [show(1, 'talk-base', 1035), show(2, 'talk-f1a', 1035), ...say('m1'), show(2, 'talk-f1b', 1035), ...say('m2'), show(1, 'wide-base'), show(2, 'wide-f0a'), ...say('m3'), c(0)] });
  // Копия разговора «Talk0» (то же событие на другой карте) — тот же сценарий: диалог один
  events.push({ id: events.length + 1, name: 'Talk0', list: events[0].list });
  for (const n of [...new Set(names)]) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), /^talk/.test(n) ? png(405, 900) : png());
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 1440, screenHeight: 900 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, ...events]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.thumb = async (id, rel) => rel;
  svc.vision = { available: true, version: 'v', score: async () => 0.9 };
  svc.opaqueShare = async (file) => { const n = path.basename(file, '.png'); return { share: 0.1, cols: 0.2, box: /^wide/.test(n) ? [0.3, 0.2, 0.7, 0.8] : /f\d/.test(n) ? [0.75, 0.4, 0.95, 0.6] : [0.72, 0.33, 1, 1] }; };
  const quiet = t.mock.method(console, 'log', () => {});
  t.after(() => quiet.mock.restore());
  await svc.runBuild('G', { done: 0, total: 0 });
  // Распознавание признало «Wide» сценой (0,9): альбомы событий появляются после его прохода; диалоги были и до него
  await svc.visionPass('G');
  const index = await svc.cached('G');
  const dialogues = index.albums.filter((a) => a.kind === 'dialogue');
  const others = index.albums.filter((a) => a.kind !== 'dialogue');
  // Десять разговоров (копия «Talk0» — тот же), стоячий портрет и смесь — двенадцать альбомов в конце оглавления, без своих файлов; обложка — первая картинка сценария, не обрезанная
  assert.strictEqual(dialogues.length, 12, JSON.stringify(index.albums.map((a) => [a.key, a.kind])));
  assert.deepStrictEqual(index.albums.slice(-12).map((a) => a.kind), Array(12).fill('dialogue'));
  assert.ok(dialogues.every((a) => a.script === true && a.files.length === 0 && /^dialogue\/\d{5}\/(Talk\d|Standing 1|Mixed)$/.test(a.key) && a.cover));
  assert.ok(dialogues.every((a) => a.sum.l === (/Standing/.test(a.key) ? 1 : /Mixed/.test(a.key) ? 3 : 2) && a.sum.p >= 1), JSON.stringify(dialogues.map((a) => a.sum)));
  assert.ok(!dialogues.some((a) => /Silent/.test(a.key)), 'без единой реплики с текстом диалога нет');
  const frames = await svc.scenesOf('G');
  for (const a of dialogues) {
    const h = a.cover.startsWith('@cg/') && frames[a.cover.slice(4)];
    assert.ok(h && !h[0].crop, 'обложка диалога без обрезки');
    // …а тот же портрет в сценарии обрезан по основе (двойник без обрезки — только обложка)
    assert.ok(Object.values(frames).some((ls) => ls[0].name === 'talk-base' && Array.isArray(ls[0].crop)), 'у портрета в сценарии обрезка по основе');
    assert.ok(await svc.knows('G', a.cover), 'обложку можно читать');
  }
  // Обложка без обрезки у отфильтрованного («Silent») в parts не остаётся: двойники там только у живых диалогов
  const twinOf = (h) => `@cg/${require('crypto').createHash('sha1').update(`${h}:full`).digest('hex').slice(0, 20)}`;
  const twins = new Set(Object.keys(frames).map(twinOf));
  assert.deepStrictEqual((index.parts || []).filter((f) => twins.has(f)).sort(), [...new Set(dialogues.map((a) => a.cover))].filter((f) => twins.has(f)).sort());
  // Не в «Всё» и не в счёте картинок; остальные альбомы — по-прежнему «events/00000/…» подряд, как без диалогов
  assert.ok(!('dialogue' in index.counts));
  assert.deepStrictEqual(others.filter((a) => a.key.startsWith('events/')).map((a) => a.key), ['events/00000/Wide0', 'events/00001/Wide1']);
  assert.ok(others.every((a) => !a.cover || svc.memo.get('G').files.has(a.cover)));
  // scene() играет диалог: картинки сценария, обе реплики
  const sc = await svc.scene('G', dialogues[0].key, null, { n: 0 });
  assert.deepStrictEqual(sc.steps.filter((x) => x.k === 'say').map((x) => x.text), ['a', 'b']);
  assert.ok(sc.files.length >= 1 && sc.steps.some((x) => x.k === 'pic'));
  // Сводка у обычной сцены
  const wide = others.find((a) => a.key === 'events/00000/Wide0');
  assert.strictEqual(wide.script, true);
  assert.strictEqual(wide.sum.l, 2);
  // Старое оглавление (без sum, title и диалогов) читается и играет, как раньше
  const file = svc.indexPath('G');
  const old = JSON.parse(await fsp.readFile(file, 'utf8'));
  old.albums = old.albums.filter((a) => a.kind !== 'dialogue').map(({ sum, title, ...a }) => a);
  await fsp.writeFile(file, JSON.stringify(old));
  svc.memo.delete('G');
  const back = await svc.cached('G');
  assert.ok(back.albums.every((a) => a.kind !== 'dialogue' && !('sum' in a)));
  assert.deepStrictEqual((await svc.scene('G', 'events/00000/Wide0', null, { n: 0 })).steps.filter((x) => x.k === 'say').map((x) => x.text), ['a', 'b']);
});

test('галерея: фигуры кадра панели — группа, рука, зеркало, сплошной слой (talkFigures, talkFigure)', () => {
  const { talkFigures, talkFigure } = require('./src/services/gallery.js');
  const screen = { w: 1440, h: 900 };
  const E = (box, extra = {}) => ({ w: 1440, h: 900, alpha: true, opaque: 0.1, box, ...extra });
  const L = (rel, extra = {}) => ({ rel, x: 0, y: 0, o: 0, zx: 100, zy: 100, ...extra });
  const entries = new Map(Object.entries({
    a: E([0.2, 0.1, 0.45, 1]), b: E([0.42, 0.12, 0.7, 1]), wide: E([0.1, 0.5, 0.9, 1]), arm: E([0.28, 0.38, 0.38, 0.83]), body: E([0, 0.04, 0.44, 1]),
    face: E([0, 0, 1, 1]), solid: E([0, 0, 1, 1], { alpha: false }), mir: E([0.05, 0.1, 0.45, 1]), mirTop: E([0.05, 0, 0.45, 1]),
  }));
  const round = (figs) => figs.map((f) => f.box.map(Math.round));
  // Двое в разговоре: рамки спрайтов на холстах во весь экран накладываются по x (288–648 и 605–1008), но центр каждого вне
  // другого — две фигуры, обе портреты
  const two = talkFigures([L('a'), L('b')], entries, screen);
  assert.deepStrictEqual([round(two), two.every((f) => talkFigure(f, screen))], [[[288, 90, 648, 900], [605, 108, 1008, 900]], true]);
  // Широкое тело в рост не вдвое — третья фигура, не портрет: сцена, а не пара собеседников
  const three = talkFigures([L('a'), L('b'), L('wide')], entries, screen);
  assert.deepStrictEqual([three.length, three.map((f) => talkFigure(f, screen))], [3, [true, true, false]]);
  // Рука, стоящая в списке раньше тела, — часть тела (порядок по высоте); прозрачная дымка с рамкой на всё изображение — не фигура
  const withArm = talkFigures([L('arm'), L('body'), L('face')], entries, screen);
  assert.deepStrictEqual([withArm.length, round(withArm)], [1, [[0, 36, 634, 900]]]);
  // Плотный слой на весь холст поверх — сам фигура во весь экран: не портрет
  const full = talkFigures([L('body'), L('solid')], entries, screen);
  assert.deepStrictEqual([full.length, talkFigure(full[0], screen)], [1, false]);
  // Зеркало (минус у масштаба): рамка отражена — 792..1368 по x; верх рамки у края экрана — фигура вплотную, не портрет
  const mirror = talkFigures([L('mir', { zx: -100, x: 1440 })], entries, screen);
  assert.deepStrictEqual([round(mirror), talkFigure(mirror[0], screen)], [[[792, 90, 1368, 900]], true]);
  assert.strictEqual(talkFigure(talkFigures([L('mirTop', { zx: -100, x: 1440 })], entries, screen)[0], screen), false);
  // Масштаб ноль, кадр листа, неизмеренный прозрачный слой — не знаем: null
  assert.strictEqual(talkFigures([L('mir', { zx: 0 })], entries, screen), null);
  assert.strictEqual(talkFigures([L('mir', { cell: { i: 0, n: 2, dir: 'h' } })], entries, screen), null);
  assert.strictEqual(talkFigures([L('mir'), L('nobox')], new Map([...entries, ['nobox', E(null)]]), screen), null);
});

test('галерея: обрезка по плану — большинство и меньшинство, два плана, окно и целая CG, общий кадр, кадры из сценариев (cropShots)', () => {
  const { cropShots } = require('./src/services/gallery.js');
  const screen = { w: 1440, h: 900 };
  const entries = new Map();
  const base = (rel, box) => { entries.set(rel, { w: 1440, h: 900, alpha: true, opaque: 0.1, box }); return rel; };
  const frames = {};
  const frame = (h, rel, crop) => { frames[h] = [{ name: rel, rel, x: 0, y: 0, o: 0, zx: 100, zy: 100, ...(crop ? { crop } : {}) }, { name: 'd', rel: 'd', x: 0, y: 0, o: 0, zx: 100, zy: 100 }]; return `@cg/${h}`; };
  const album = (key, ...files) => ({ key, kind: 'cg', files });
  const cropsOf = (...hs) => hs.map((h) => frames[h][0].crop);
  // План: одна основа, окна двух кадров разные — оба получают объединение; широкий кадр без обрезки остаётся без неё
  base('b1', [0.2, 0.2, 0.4, 0.4]);
  const A = album('events/1', frame('p1', 'b1', [144, 180, 432, 180]), frame('p2', 'b1', [288, 180, 432, 270]), frame('p3', 'b1'));
  // Один с обрезкой из трёх — обрезка не у большинства: ни у кого
  base('b2', [0.2, 0.2, 0.4, 0.4]);
  const B = album('events/2', frame('q1', 'b2', [144, 180, 432, 180]), frame('q2', 'b2'), frame('q3', 'b2'));
  // Рамки основ слева и справа не пересекаются — два плана, у каждого своё окно
  base('left', [0, 0.3, 0.3, 0.7]); base('right', [0.7, 0.3, 1, 0.7]);
  const C = album('events/3', frame('l1', 'left', [0, 270, 432, 360]), frame('l2', 'left', [100, 270, 400, 360]), frame('r1', 'right', [1000, 270, 440, 360]), frame('r2', 'right', [1008, 270, 432, 360]));
  // Малое окно рядом с целой CG: рамки почти не пересекаются (IoU < 0,5) — разные планы, окно остаётся
  base('small', [0.05, 0.05, 0.35, 0.45]); base('whole', [0, 0, 1, 1]);
  const D = album('events/4', frame('w1', 'small', [72, 45, 432, 360]), frame('w2', 'small', [72, 45, 432, 360]), frame('f1', 'whole'), frame('f2', 'whole'));
  // Кадр, что стоит в двух альбомах: решение одно на все три кадра (объединение трёх окон)
  base('sh', [0.3, 0.3, 0.5, 0.5]);
  const E1 = album('events/5', frame('x1', 'sh', [432, 270, 100, 100]), frame('x2', 'sh', [440, 270, 100, 100]));
  const E2 = album('events/6', frame('x2', 'sh', [440, 270, 100, 100]), frame('x3', 'sh', [450, 280, 100, 100]));
  const before = JSON.parse(JSON.stringify(frames));
  const panelSet = new Set();
  const scripts = new Map();
  cropShots({ frames, entries, albums: [A, B, C, D, E1, E2], scripts, panelSet, screen });
  assert.deepStrictEqual(cropsOf('p1', 'p2', 'p3'), [[144, 180, 576, 270], [144, 180, 576, 270], undefined]);
  assert.deepStrictEqual(cropsOf('q1', 'q2', 'q3'), [undefined, undefined, undefined]);
  assert.deepStrictEqual(cropsOf('l1', 'l2', 'r1', 'r2'), [[0, 270, 500, 360], [0, 270, 500, 360], [1000, 270, 440, 360], [1000, 270, 440, 360]]);
  assert.deepStrictEqual(cropsOf('w1', 'w2', 'f1', 'f2'), [[72, 45, 432, 360], [72, 45, 432, 360], undefined, undefined]);
  assert.deepStrictEqual(cropsOf('x1', 'x2', 'x3'), [[432, 270, 118, 110], [432, 270, 118, 110], [432, 270, 118, 110]]);
  // Обрезка не добавляется, а оставленная содержит прежнюю
  for (const [h, ls] of Object.entries(frames)) {
    const was = before[h][0].crop, now = ls[0].crop;
    if (!was) assert.strictEqual(now, undefined, `обрезка добавлена: ${h}`);
    else if (now) assert.ok(now[0] <= was[0] && now[1] <= was[1] && now[0] + now[2] >= was[0] + was[2] && now[1] + now[3] >= was[1] + was[3], `обрезка сузилась: ${h}`);
  }

  // Кадры, что есть только в сценариях: идут за кадрами альбома своего плана
  base('sc', [0.2, 0.2, 0.4, 0.4]);
  const S = album('events/7', frame('a1', 'sc', [144, 180, 432, 180]), frame('a2', 'sc', [144, 180, 432, 180]));
  frame('s_in', 'sc', [200, 200, 300, 100]);       // внутри окна альбома — берёт его
  frame('s_out', 'sc', [100, 100, 600, 600]);      // выходит за окно — теряет обрезку
  frame('s_none', 'sc');                           // своей обрезки нет — остаётся без неё
  const pics = (...hs) => hs.map((h) => ({ k: 'pic', f: `@cg/${h}` }));
  cropShots({ frames, entries, albums: [S], scripts: new Map([['events/7', pics('a1', 's_in', 's_out', 's_none')]]), panelSet, screen });
  assert.deepStrictEqual(cropsOf('s_in', 's_out', 's_none'), [[144, 180, 432, 180], undefined, undefined]);
  // Кадры альбома без обрезки: кадр сценария тоже теряет свою
  base('sd', [0.6, 0.6, 0.8, 0.8]);
  const S2 = album('events/8', frame('d1', 'sd'), frame('d2', 'sd'));
  frame('d_s', 'sd', [864, 540, 288, 180]);
  cropShots({ frames, entries, albums: [S2], scripts: new Map([['events/8', pics('d1', 'd_s')]]), panelSet, screen });
  assert.strictEqual(frames.d_s[0].crop, undefined);
  // Кадры сценариев без кадров альбома: решает большинство среди них
  base('so', [0.1, 0.6, 0.3, 0.9]);
  frame('o1', 'so', [144, 540, 288, 270]); frame('o2', 'so', [150, 540, 300, 270]); frame('o3', 'so');
  cropShots({ frames, entries, albums: [], scripts: new Map([['events/9', pics('o1', 'o2', 'o3')]]), panelSet, screen });
  assert.deepStrictEqual(cropsOf('o1', 'o2', 'o3'), [[144, 540, 306, 270], [144, 540, 306, 270], undefined]);
});

test('галерея: бледная картинка шага сценария — кадр с тем, что под ней (A2/A3); альбом получает прежний файл; composeFrames без флага как раньше', async (t) => {
  const { analyze, composeFrames } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, op = 255, zoom = 100) => c(231, [n, name, 0, 0, 0, 0, zoom, zoom, op, 0]);
  const msg = (text) => [c(101), c(401, [text])];
  const kinds = { bg: 'cg', cg1: 'cg', cg2: 'cg', part: 'cg' };
  const run = (list, partial = []) => analyze([{ id: 'ce1', name: 'Сцена', where: '', list }], [], (n) => kinds[n] || null, (n) => partial.includes(n)).groups[0];
  const faintOf = (g) => g.script.filter((x) => x.k === 'pic').map((x) => x.item.faint && x.item.faint.map((l) => `${l.name}@${l.op}`));
  // Бледная картинка одна на месте прежней: сама над чёрным; целый файл альбома не меняется
  const g1 = run([show(1, 'cg2'), ...msg('a'), show(1, 'cg1', 175), ...msg('b'), c(0)]);
  assert.deepStrictEqual(faintOf(g1), [undefined, ['cg1@175']]);
  assert.deepStrictEqual(g1.finished.map((x) => x.name), ['cg2', 'cg1']);
  // Над неполной CG (прозрачные края) — склейка из двух: так альбом сложил бы, что под ней
  const g2 = run([show(1, 'part'), ...msg('a'), show(2, 'cg1', 175), ...msg('b'), c(0)], ['part']);
  assert.deepStrictEqual(faintOf(g2).slice(-1), [['part@255', 'cg1@175']]);
  // 251 и выше — не бледная; 255 — обычная; не картинка из CG под ней — на вид не влияет
  assert.deepStrictEqual(faintOf(run([show(1, 'cg2'), ...msg('a'), show(1, 'cg1', 251), ...msg('b'), c(0)])), [undefined, undefined]);
  assert.deepStrictEqual(faintOf(run([show(1, 'cg2'), ...msg('a'), show(1, 'cg1', 240), ...msg('b'), c(0)])), [undefined, ['cg1@240']]);
  // Портрет под бледной картинкой в склейку не идёт
  kinds.alice = 'portrait';
  assert.deepStrictEqual(faintOf(run([show(1, 'cg2'), ...msg('a'), show(2, 'alice'), show(1, 'cg1', 175), ...msg('b'), c(0)]))[1], ['cg1@175']);
  // Без флага (альбом) — прежний ответ: целая картинка
  const pic = (name, op) => ({ name, x: 0, y: 0, o: 0, zx: 100, zy: 100, op });
  const info = (n) => ({ kind: 'cg', uses: 0, partial: false, flat: false });
  assert.deepStrictEqual(composeFrames([{ pics: [pic('cg1', 175)] }], info), [{ name: 'cg1' }]);
  assert.deepStrictEqual(composeFrames([{ pics: [pic('cg1', 175)] }], info, false, true)[0].faint.map((l) => l.op), [175]);
  // Кадр анимации (клетки листа) бледным не бывает
  assert.strictEqual(composeFrames([{ pics: [{ ...pic('cg1', 175), cell: { i: 0, n: 2, dir: 'h' } }] }], info, false, true)[0].faint, undefined);
});

test('галерея: бледная картинка в сборке — склейка в сценарии только если ложится на экран; файл альбома прежний; обрезки у неё нет', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-faint-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (alpha = false) => { const b = Buffer.alloc(200000); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(1440, 16); b.writeUInt32BE(900, 20); b[24] = 8; b[25] = alpha ? 6 : 2; b.writeUInt32BE(++uniq, 199996); return b; };
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (name, op = 255, zoom = 100) => c(231, [1, name, 0, 0, 0, 0, zoom, zoom, op, 0]);
  const msg = (text) => [c(101), c(401, [text])];
  for (const n of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'f1', 'f2', 'f3', 'f4']) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png(n === 'f1'));
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 1440, screenHeight: 900 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null,
    { id: 1, name: 'Затемнение', list: [show('a1'), ...msg('a'), show('f1', 175), ...msg('b'), c(0)] },
    { id: 2, name: 'Крупно', list: [show('a2'), ...msg('a'), show('f2', 175, 300), ...msg('b'), c(0)] },
    { id: 3, name: 'Почти целая', list: [show('a3'), ...msg('a'), show('f3', 251), ...msg('b'), c(0)] },
    { id: 4, name: 'Переход', list: [show('a4'), ...msg('a'), show('f4', 200), ...msg('b'), c(0)] }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.vision = { available: false };
  // f1 — картинка с прозрачными краями и рамкой: склейка из одного слоя её рамкой не обрезается
  svc.opaqueShare = async () => ({ share: 0.5, cols: 0.5, box: [0.25, 0.125, 0.75, 0.625] });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const frames = JSON.parse(await fsp.readFile(svc.scenesPath('G'), 'utf8'));
  const stepsOf = async (title) => {
    const a = index.albums.find((x) => x.key.endsWith(`/${title}`));
    assert.ok(a && a.script, `нет сценария: ${title}`);
    const data = JSON.parse(await fsp.readFile(svc.scriptPath('G', index.scripts, a.key), 'utf8'));
    return { a, files: data.steps.filter((x) => x.k === 'pic').map((x) => data.files[x.i]) };
  };
  // Бледная картинка на экран — склейка из одного слоя с прозрачностью, без обрезки; в альбоме — целый файл, как раньше
  const fade = await stepsOf('Затемнение');
  assert.deepStrictEqual(fade.a.files, ['img/pictures/a1.png', 'img/pictures/f1.png']);
  assert.strictEqual(fade.files[0], 'img/pictures/a1.png');
  assert.match(fade.files[1], /^@cg\//);
  const layers = frames[fade.files[1].slice(4)];
  assert.deepStrictEqual(layers.map((l) => [l.name, l.op, l.crop]), [['f1', 175, undefined]]);
  // Слой увеличен втрое — на экран не ложится, остаётся целый файл (затемнение не прыгает между рамками); 251 — обычная
  assert.deepStrictEqual((await stepsOf('Крупно')).files, ['img/pictures/a2.png', 'img/pictures/f2.png']);
  assert.deepStrictEqual((await stepsOf('Почти целая')).files, ['img/pictures/a3.png', 'img/pictures/f3.png']);
  assert.match((await stepsOf('Переход')).files[1], /^@cg\//);
});

test('галерея: бледная картинка под роликом — по правилам бледной картинки (A4 раньше V11): на экран — склейка с прозрачностью, увеличенная — целый файл', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-faintvid-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures', 'data', 'movies']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = () => { const b = Buffer.alloc(200000); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(1440, 16); b.writeUInt32BE(900, 20); b[24] = 8; b[25] = 2; b.writeUInt32BE(++uniq, 199996); return b; };
  for (const n of ['a1', 'a2', 'f1', 'f2']) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), png());
  assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x64:d=1:r=10', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', path.join(game, 'movies', 'clipa.webm')]).status, 0);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (name, op = 255, zoom = 100) => c(231, [1, name, 0, 0, 0, 0, zoom, zoom, op, 0]);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const prep = c(357, ['MoviePicture', 'PREPARE', '', { fileName: 'clipa', loop: 'true', volume: '100', autoplay: 'true' }]);
  // Бледная картинка (затемнение), потом ролик: ролик (V11) не должен отнять у неё склейку с прозрачностью.
  // Без правила картинка под роликом шла бы склейкой даже увеличенная — вопреки «увеличенную оставляем целым файлом»
  const scene = (id, name, base, fade, zoom) => ({ id, name, list: [show(base), ...line('a'), show(fade, 175, zoom), prep, c(231, [4, '', 0, 0, 0, 0, 100, 100, 255, 0]), ...line('b'), c(235, [4]), ...line('c'), c(0)] });
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 1440, screenHeight: 900 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, scene(1, 'Затемнение', 'a1', 'f1', 100), scene(2, 'Крупно', 'a2', 'f2', 300)]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.vision = { available: false };
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const frames = JSON.parse(await fsp.readFile(svc.scenesPath('G'), 'utf8'));
  const filesOf = async (title) => {
    const a = index.albums.find((x) => x.script && x.key.endsWith(`/${title}`));
    assert.ok(a, `нет сценария: ${title}`);
    const sc = await svc.scene('G', a.key);
    assert.ok(sc.steps.some((x) => x.k === 'vid' && x.v.length), 'ролик в сценарии');
    return sc.steps.filter((x) => x.k === 'pic' && sc.files[x.i]).map((x) => sc.files[x.i]);
  };
  const fade = await filesOf('Затемнение');
  assert.strictEqual(fade[0], 'img/pictures/a1.png');
  assert.match(fade[1], /^@cg\//);
  assert.deepStrictEqual(frames[fade[1].slice(4)].map((l) => [l.name, l.op]), [['f1', 175]]);
  assert.deepStrictEqual(await filesOf('Крупно'), ['img/pictures/a2.png', 'img/pictures/f2.png']);
});

test('галерея: портрет по фигурам — поручительство за группу, основа «tachie» у новых портретов, тела портретов — в «#parts»', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const crypto = require('crypto');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-vouch-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  for (const d of ['img/pictures', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (w = 1440, h = 900, size = 20000) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6; b.writeUInt32BE(++uniq, size - 4); return b; };
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, x = 0, y = 0) => c(231, [n, name, 0, 0, x, y, 100, 100, 255, 0]);
  const log = (text) => c(357, ['BattleLogOutput', 'OUTPUT_LOG', '', { message: text }]);
  const names = [];
  const events = [];
  const ev = (name, ...list) => events.push({ id: events.length + 1, name, list: [...list, c(0)] });
  // Три семьи портретов в десяти событиях: «side» (по фигуре), «tachie» (с «tachie» в имени основы), «talk» (по прежнему правилу)
  for (let i = 0; i < 10; i++) {
    names.push(`side-base${i}`, `side-f${i}a`, `side-f${i}b`, `tachie-base${i}`, `tachie-f${i}a`, `tachie-f${i}b`, 'talk-base0', `talk-f${i}a`, `talk-f${i}b`);
    ev(`Side${i}`, show(1, `side-base${i}`), show(2, `side-f${i}a`), log('a'), show(2, `side-f${i}b`), log('b'));
    ev(`Tach${i}`, show(1, `tachie-base${i}`), show(2, `tachie-f${i}a`), log('a'), show(2, `tachie-f${i}b`), log('b'));
    ev(`Talk${i}`, show(1, 'talk-base0'), show(2, `talk-f${i}a`), log('a'), show(2, `talk-f${i}b`), log('b'));
  }
  // Группы, где портрет стоит рядом с кадрами сцены. Vouch: за группу ручается кадр, который теперь портрет (оценка 0,9 у него
  // уже есть), кадры сцены ещё не оценены. OldVouch — то же, но ручается кадр, что был портретом и раньше. TachVouch: портрет с
  // «tachie» в основе и кадр сцены с оценкой 0,9 — группу закрывает имя, как закрывало сегодня
  names.push('nv-base', 'nv-fa', 'nv-fb', 'ov-base', 'ov-fa', 'ov-fb', 'n3-base', 'n3-fa', 'n3-fb');
  const say = (text) => [c(101), c(401, [text])];
  ev('Vouch', show(1, 'side-base0'), show(2, 'side-f0a'), ...say('t'), show(1, 'nv-base'), show(2, 'nv-fa'), ...say('a'), show(2, 'nv-fb'), ...say('b'),
    show(1, 'bt-base001', 360, 90), show(2, 'bt-f1a', 360, 90), ...say('t2'));
  ev('OldVouch', show(1, 'talk-base0'), show(2, 'talk-f0a'), log('t'), show(1, 'ov-base'), show(2, 'ov-fa'), log('a'), show(2, 'ov-fb'), log('b'));
  ev('TachVouch', show(1, 'tachie-base0'), show(2, 'tachie-f0a'), log('t'), show(1, 'n3-base'), show(2, 'n3-fa'), log('a'), show(2, 'n3-fb'), log('b'));
  // TachCover: та же кукла «tachie», но поверх неё — вставка во весь холст из другой папки («cov/…»): имя основы группу не закрывает,
  // её судит распознавание. TachSmall: поверх куклы лишь мелкая деталь из другой папки — группу по-прежнему закрывает имя
  names.push('cov/c4-fa', 'cov/c4-fb', 'cov/c5-fa', 'cov/c5-fb');
  ev('TachCover', show(1, 'tachie-base0'), show(2, 'tachie-f0a'), log('t'), show(2, 'cov/c4-fa'), log('a'), show(2, 'cov/c4-fb'), log('b'));
  ev('TachSmall', show(1, 'tachie-base0'), show(2, 'tachie-f0a'), log('t'), show(2, 'cov/c5-fa'), log('a'), show(2, 'cov/c5-fb'), log('b'));
  // TachNo: то же, но распознавание ответило «не сцена»: основа «tachie» называла бы группу портретом, значит, это разговор — сценарий
  // остаётся диалогом, а не пропадает вместе с группой
  names.push('cov/c6-fa', 'cov/c6-fb');
  ev('TachNo', show(1, 'tachie-base0'), show(2, 'cov/c6-fa'), ...say('a'), show(2, 'cov/c6-fb'), ...say('b'));
  // Тела портрета — «портретные» картинки 720×810 одного имени с номерами, и CG с тем же именем: альбом по имени — CG, а тела
  // в нём — не сцена. «bt-base100» — настоящая CG
  for (let i = 0; i < 10; i++) {
    names.push(`bt-base${String(i).padStart(3, '0')}`, `bt-f${i}a`, `bt-f${i}b`);
    ev(`Bt${i}`, show(1, `bt-base${String(i).padStart(3, '0')}`, 360, 90), show(2, `bt-f${i}a`, 360, 90), log('a'), show(2, `bt-f${i}b`, 360, 90), log('b'));
  }
  const small = (n) => /^bt-(base\d\d\d|f)/.test(n) && n !== 'bt-base100';
  await fsp.mkdir(path.join(game, 'img', 'pictures', 'cov'), { recursive: true });
  // c5 — мелкая деталь (меньше четверти экрана), c4 — холст во весь экран
  for (const n of [...new Set(names)]) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), small(n) ? png(720, 810) : /^cov\/c5/.test(n) ? png(300, 200) : png());
  await fsp.writeFile(path.join(game, 'img', 'pictures', 'bt-base100.png'), png(1440, 900, 200000));
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ advanced: { screenWidth: 1440, screenHeight: 900 } }));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, ...events]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  svc.thumb = async (id, rel) => rel;
  let current = {};
  svc.vision = { available: true, version: 'v', score: async (thumb) => ((current[thumb.slice(4)] || []).some((l) => /^(nv|ov)-base$|^cov\/c6-/.test(l.name)) ? 0.2 : 0.9) };
  const box = (n) => (/^(side-base|tachie-base)/.test(n) ? [0.55, 0.33, 0.95, 1] : /^(side-f|tachie-f)/.test(n) ? [0.65, 0.1, 0.85, 0.4] : /^bt-base1/.test(n) ? [0, 0, 1, 1]
    : /^bt-base/.test(n) ? [0.2, 0, 0.8, 1] : /^bt-f/.test(n) ? [0.35, 0.1, 0.65, 0.3] : /^(nv|ov|n3)-base/.test(n) ? [0.3, 0.2, 0.7, 0.8] : /^(nv|ov|n3)-f/.test(n) ? [0.4, 0.3, 0.6, 0.5]
    : /^talk-f/.test(n) ? [0.75, 0.4, 0.95, 0.6] : [0.72, 0.33, 1, 1]);
  svc.opaqueShare = async (file) => { const n = path.basename(file, '.png'); return { share: n === 'bt-base100' ? 0.95 : 0.1, cols: n === 'bt-base100' ? 1 : 0.2, box: box(n) }; };
  const quiet = t.mock.method(console, 'log', () => {});
  t.after(() => quiet.mock.restore());
  // Проход распознавания сам не стартует после сборки: ответы кладём руками
  svc.visionPass = async () => {};
  await svc.runBuild('G', { done: 0, total: 0 });
  current = await svc.scenesOf('G');
  const layersOf = (...ns) => { const sample = Object.values(current).find((ls) => ls[0].name === 'nv-base'); assert.ok(sample, 'нет пробного кадра Vouch'); return ns.map((n) => ({ ...sample[0], name: n, rel: `img/pictures/${n}.png`, crop: undefined })).map(({ crop, ...l }) => l); };
  const cgHash = (ls) => crypto.createHash('sha1').update(JSON.stringify(ls.map((l) => [l.rel, l.x, l.y, l.o, l.zx, l.zy, l.op]))).digest('hex').slice(0, 20);
  // Оценки 0,9 заранее: у портрета Vouch, у портрета OldVouch (был портретом и раньше) и у кадра сцены в TachVouch
  const seed = {};
  for (const ls of [layersOf('side-base0', 'side-f0a'), layersOf('talk-base0', 'talk-f0a'), layersOf('n3-base', 'n3-fa'),
    layersOf('tachie-base0', 'cov/c4-fa'), layersOf('tachie-base0', 'cov/c4-fb'), layersOf('tachie-base0', 'cov/c5-fa'), layersOf('tachie-base0', 'cov/c5-fb')]) seed[svc.visionKey(`@cg/${cgHash(ls)}`, 0, ls)] = 0.9;
  await fsp.writeFile(svc.visionPath('G'), JSON.stringify({ version: svc.vision.version, scores: seed, embeds: {} }));
  const build = async () => { const index = await svc.runBuild('G', { done: 0, total: 0 }); current = await svc.scenesOf('G'); return index; };
  const panelOf = (index, base) => index.albums.filter((a) => a.panel && a.files.some((f) => current[f.slice(4)]?.[0].name === base));
  let index = await build();
  // Vouch: остаются кадры сцены (портрет ушёл), пока распознавание не ответит про них; пробы стоят в очереди
  const vouch = panelOf(index, 'nv-base');
  assert.deepStrictEqual(vouch.map((a) => a.files.length), [2]);
  assert.ok(vouch[0].files.every((f) => !current[f.slice(4)].some((l) => l.name.startsWith('side-'))));
  assert.ok((index.visionProbe || []).some((files) => files.some((f) => current[f.slice(4)]?.[0].name === 'nv-base')));
  // Портрет уцелевшей группы, ушедший из альбома, остался в сценарии с прежней обрезкой по основе (иначе кадр прыгал бы)
  const left = Object.values(current).find((ls) => ls[0].name === 'bt-base001' && ls[1]?.name === 'bt-f1a');
  assert.deepStrictEqual(left && left[0].crop, [360, 90, 720, 810]);
  // Ручается кадр, что и раньше был портретом, — не в счёт; «tachie» у нового портрета закрывает группу, как закрывала
  assert.deepStrictEqual([panelOf(index, 'ov-base').length, panelOf(index, 'n3-base').length], [0, 0]);
  // Вставка во весь холст поверх куклы «tachie» — альбом (оценка 0,9), мелкая деталь поверх куклы — группу закрывает имя
  const cover = panelOf(index, 'tachie-base0');
  assert.deepStrictEqual(cover.map((a) => a.files.length), [2]);
  assert.ok(cover[0].files.every((f) => current[f.slice(4)].some((l) => /^cov\/c4-/.test(l.name))));
  // Распознавать нечем: группа остаётся
  svc.vision.available = false;
  index = await build();
  assert.deepStrictEqual(panelOf(index, 'nv-base').length, 1);
  // Распознавание ответило «не сцена» (0,2) — группы нет
  svc.vision.available = true;
  await build();
  delete svc.visionPass;
  await svc.visionPass('G');
  index = await svc.cached('G');
  current = await svc.scenesOf('G');
  assert.deepStrictEqual([panelOf(index, 'nv-base').length, (index.visionProbe || []).length], [0, 0]);
  assert.deepStrictEqual(index.albums.filter((x) => x.script && x.key.endsWith('/TachNo')).map((x) => x.kind), ['dialogue'], 'вставка над куклой «tachie», признанная «не сценой», — диалог, а не потеря сценария');

  // Тела портретов («bt-base000…009») в альбоме CG по имени не остаются: они в «#parts»; в CG — настоящая картинка
  const cgAlbum = index.albums.find((a) => a.key === 'img/pictures/bt-base');
  const partsAlbum = index.albums.find((a) => a.key === 'img/pictures/bt-base#parts');
  assert.deepStrictEqual([cgAlbum && cgAlbum.files, partsAlbum && [partsAlbum.kind, partsAlbum.files.length]], [['img/pictures/bt-base100.png'], ['layer', 10]]);
});

// --- Галерея из файлов игры (services/gallery.js) ---
test('галерея: размеры из заголовка PNG и у зашифрованных, разделы по размеру, альбомы по имени, чужие пути закрыты', async (t) => {
  const { GalleryService, classify, albumKey, pngSize, decrypt } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // PNG нужного размера: подпись, IHDR с шириной и высотой, «тело» заданной длины
  // Каждый файл — со своим «содержимым»: одинаковые по байтам галерея показывает один раз
  let uniq = 0;
  const png = (w, h, body = 0) => {
    const b = Buffer.alloc(33 + body);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    if (b.length >= 64) b.writeUInt32BE(++uniq, b.length - 4);
    return b;
  };
  const key = '0123456789abcdef0123456789abcdef';
  const encrypt = (data) => {
    const out = Buffer.concat([Buffer.from('RPGMV\0\0\0\0\x03\x01\0\0\0\0\0', 'latin1'), data]);
    const k = key.match(/../g).map((x) => parseInt(x, 16));
    for (let i = 0; i < 16; i++) out[16 + i] ^= k[i];
    return out;
  };
  const game = path.join(root, 'G', 'www');
  for (const d of ['data', 'img/pictures', 'img/faces', 'img/parallaxes', 'img/cg_custom']) await fsp.mkdir(path.join(game, d), { recursive: true });
  await fsp.writeFile(path.join(game, 'data', 'System.json'), '﻿' + JSON.stringify({ encryptionKey: key, advanced: { screenWidth: 1280, screenHeight: 720 } }));
  const cg = png(1280, 720, 400000);
  await fsp.writeFile(path.join(game, 'img/pictures/ev01_1.rpgmvp'), encrypt(cg));
  await fsp.writeFile(path.join(game, 'img/pictures/ev01_2.rpgmvp'), encrypt(png(1280, 720, 400000)));
  await fsp.writeFile(path.join(game, 'img/pictures/layer_face.png'), png(1280, 720, 1000));
  await fsp.writeFile(path.join(game, 'img/pictures/stand_alice.png'), png(500, 720, 100000));
  await fsp.writeFile(path.join(game, 'img/pictures/icon.png'), png(64, 64, 10));
  await fsp.writeFile(path.join(game, 'img/cg_custom/074 (1).png'), png(1280, 720, 400000));
  await fsp.writeFile(path.join(game, 'img/faces/Actor1.png'), png(576, 288, 10));
  await fsp.writeFile(path.join(game, 'img/parallaxes/Sky.png'), png(1280, 1440, 900000));

  assert.deepStrictEqual(pngSize(encrypt(png(816, 624)).subarray(0, 40)), { w: 816, h: 624 });
  assert.strictEqual(albumKey('img/pictures/074 (3).png_'), 'img/pictures/074');
  assert.strictEqual(albumKey('img/pictures/SceneB_05-11.rpgmvp'), 'img/pictures/SceneB_05');
  // Номер CG — первая часть с цифрой; номер кадра в конце — не в имени альбома; порядковый номер в начале пропускаем
  assert.strictEqual(albumKey('img/pictures/eva_c132_0_1_0211013_100000_0010_0.png_'), 'img/pictures/eva_c132');
  assert.strictEqual(albumKey('img/pictures/CG_badend_14.rpgmvp'), 'img/pictures/CG_badend');
  assert.strictEqual(albumKey('img/pictures/1_受付嬢_普.png_'), 'img/pictures/受付嬢_普');
  assert.strictEqual(classify({ w: 1280, h: 720, size: 900000 }, { w: 1280, h: 720 }, 'img/pictures/Bg_Alleyway.png_'), 'backdrop');
  assert.strictEqual(classify({ w: 1280, h: 720, size: 1000 }, { w: 1280, h: 720 }), 'layer');
  assert.deepStrictEqual(decrypt(encrypt(cg), key), cg);

  const g = new GalleryService();
  g.setDependencies({ gamesDir: root });
  const t0 = t.mock.method(console, 'log', () => {});
  const index = await g.build('G').promise;
  t0.mock.restore();
  const byKey = Object.fromEntries(index.albums.map((a) => [a.key, [a.kind, a.files.length]]));
  assert.deepStrictEqual(byKey, {
    'img/pictures/ev01': ['cg', 2],
    'img/pictures/layer_face': ['layer', 1],
    'img/pictures/stand_alice': ['portrait', 1],
    'img/pictures/icon': ['other', 1],
    'img/cg_custom/074': ['cg', 1],
    'img/parallaxes/Sky': ['backdrop', 1],
  });
  assert.strictEqual(index.albums[0].key.startsWith('img/pictures/'), true);
  // Картинка целиком — расшифрованная; путь не из оглавления — нет
  const img = await g.image('G', 'img/pictures/ev01_1.rpgmvp');
  assert.deepStrictEqual([img.type, img.data.equals(cg)], ['image/png', true]);
  assert.strictEqual(await g.image('G', 'data/System.json'), null);
  assert.strictEqual(await g.image('G', '../../etc/passwd'), null);
  // Оглавление — в _media, не в папке игры
  await fsp.access(path.join(root, '_media', 'G', 'gallery.json'));
  assert.deepStrictEqual((await fsp.readdir(path.join(root, 'G', 'www'))).sort(), ['data', 'img']);
});

test('сервер игр: регистр букв подбирается у каждой папки пути — игры собирают под Windows', async (t) => {
  const { fixCase } = require('./src/routes/play.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'case-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'Game', 'Fonts'), { recursive: true });
  await fsp.mkdir(path.join(root, 'Game', 'Audio', 'SE'), { recursive: true });
  await fsp.writeFile(path.join(root, 'Game', 'Fonts', 'mplus-1m-regular.ttf'), 'f');
  await fsp.writeFile(path.join(root, 'Game', 'Audio', 'SE', 'Cursor2.ogg'), 'a');
  assert.strictEqual(await fixCase(root, 'Game/fonts/mplus-1m-regular.ttf'), path.join(root, 'Game', 'Fonts', 'mplus-1m-regular.ttf'));
  assert.strictEqual(await fixCase(root, 'Game/audio/se/cursor2.OGG'), path.join(root, 'Game', 'Audio', 'SE', 'Cursor2.ogg'));
  // Нет такого файла — папки подобраны, имя как есть: ответит 404, а звук поищет .m4a рядом
  assert.strictEqual(await fixCase(root, 'Game/audio/se/Decision1.ogg'), path.join(root, 'Game', 'Audio', 'SE', 'Decision1.ogg'));
});

test('галерея: WebP под именем .png (репаки «Compressed») — размеры из заголовка WebP', () => {
  const { pngSize } = require('./src/services/gallery.js');
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(1279, 24, 3); b.writeUIntLE(719, 27, 3);
  assert.deepStrictEqual(pngSize(b), { w: 1280, h: 720, webp: true });
  const { albumKey } = require('./src/services/gallery.js');
  // Сцена — папка, кадры в ней — номера
  assert.strictEqual(albumKey('img/pictures/CG/Cam x Alice Bath/1.png'), 'img/pictures/CG/Cam x Alice Bath');
});

// --- Кэш без Redis (utils/cache.js, REDIS_URL=memory) ---
test('кэш в памяти: те же команды, что у Redis, и срок жизни ключей', async () => {
  const { memoryRedis } = require('./src/utils/cache.js');
  const r = memoryRedis();
  assert.strictEqual(await r.get('a'), null);
  await r.set('a', 'x', { EX: 60 });
  assert.strictEqual(await r.get('a'), 'x');
  await r.set('gone', 'y', { EX: -1 });
  assert.strictEqual(await r.get('gone'), null, 'просроченный ключ');
  assert.strictEqual(await r.incrBy('n', 3), 3);
  assert.strictEqual(await r.incrBy('n', 2), 5);
  await r.expire('n', 100);
  assert.strictEqual(await r.get('n'), '5');
  await r.hSet('h', { 'タイトル': 'Title', b: 'B' });
  assert.deepStrictEqual(await r.hmGet('h', ['タイトル', 'nope']), ['Title', null]);
  await r.set('scrape:miss:1', '1');
  await r.set('scrape:miss:2', '1');
  await r.set('scrape:queue', '1');
  const found = [];
  for await (const key of r.scanIterator({ MATCH: 'scrape:miss:*', COUNT: 200 })) found.push(key);
  assert.deepStrictEqual(found.sort(), ['scrape:miss:1', 'scrape:miss:2']);
  assert.strictEqual(await r.del(['scrape:queue', 'nothing']), 1);
  assert.strictEqual(await r.del('a'), 1);
  await r.flushDb();
  assert.strictEqual(await r.get('scrape:miss:1'), null);
});

// ============================================================================
// Сценарии: что поиск данных добавляет в игру и что убирает
// ============================================================================
// Сайты подменены целиком: что каждый «знает» про игру и не лежит ли он. Проверяется путь от поиска
// до записи в базу так, как его проходят очередь и «Искать сейчас». Главное: ни один сайт не
// пропускается из-за того, что другие уже что-то нашли (так VNDB не спрашивался у игры, у которой уже была страница itch.io),
// и повторный поиск не теряет известное

const SCENE_ID = 'Moon_Flower_v1.0';
const SITE = {
  itch: { link: 'https://moon-studio.itch.io/moon-flower', tags: ['fantasy', 'cozy'], description: 'Description from itch.io', developer: 'Moon Studio', releaseDate: '2026-01-02', coverUrl: 'https://itch.test/cover.jpg', screens: ['https://itch.test/1.jpg'] },
  vndb: { link: 'https://vndb.org/v100', tags: ['visual novel'], description: 'Description from VNDB', coverUrl: 'https://vndb.test/cover.jpg' },
  steam: { link: 'https://store.steampowered.com/app/100', tags: ['steam tag'], description: 'Description from Steam', screens: ['https://steam.test/1.jpg'] },
};
const linksOf = (row) => String(row.link || '').split(',').filter(Boolean);

async function scenario(t, row = {}) {
  const fs = require('fs');
  const os = require('os');
  const { db, scraper } = await lookupTestDb(t, { id: SCENE_ID, title: 'Moon Flower', ...row });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Папки игры нет: названия — из имени папки
  scraper.GAMES_DIR = root;
  const sites = { know: new Set(Object.keys(SITE)), down: new Set(), asked: [] };
  const ask = (name, host) => {
    sites.asked.push(name);
    if (sites.down.has(name)) {
      if (host) scraper.noteFailed(host);
      return null;
    }
    return sites.know.has(name) ? structuredClone(SITE[name]) : null;
  };
  t.mock.method(scraper, 'fetchItchMetadata', async () => ask('itch', 'itch.io'));
  t.mock.method(scraper, 'fetchVNDBMetadata', async () => ask('vndb', 'api.vndb.org'));
  t.mock.method(scraper, 'fetchSteamMetadata', async () => ask('steam', 'store.steampowered.com'));
  // Картинки не качаем: «сохранённая» обложка — по сайту, с которого она, кадры — сами адреса
  t.mock.method(scraper, 'saveGameMedia', async (folder, data) => ({
    cover: data.coverUrl ? `_media/${folder}/cover-${new URL(data.coverUrl).hostname}.jpg` : null,
    screens: [...(data.screens || []), ...(data.spareScreens || [])].slice(0, 6),
    stale: [],
  }));
  // Поиск, как его делает очередь: что искать — из базы, итог — в базу
  const search = async (options = {}) => {
    sites.asked.length = 0;
    const inputs = await scraper.lookupInputs(SCENE_ID);
    const lookup = await scraper.lookupMetadata(inputs.title, inputs.query, inputs);
    await scraper.applyLookup(SCENE_ID, lookup, options);
    return { lookup, row: await db.get('SELECT * FROM games WHERE id = ?', [SCENE_ID]) };
  };
  return { db, scraper, sites, search };
}

test('ссылки игры: одна страница в разных написаниях — один ключ; убранные руками запоминаются, вписанные обратно — нет', () => {
  const { linkKey, removedAfterEdit } = require('./src/utils/links.js');
  assert.strictEqual(linkKey('https://store.steampowered.com/app/100/Moon_Flower/'), 'steam:100');
  assert.strictEqual(linkKey('http://store.steampowered.com/app/100'), 'steam:100');
  assert.strictEqual(linkKey('https://vndb.org/V100'), 'vndb:v100');
  assert.strictEqual(linkKey('https://www.Moon-Studio.itch.io/moon-flower/'), 'moon-studio.itch.io/moon-flower', 'без «www», хвостового «/» и регистра');
  assert.strictEqual(linkKey('https://moon-studio.itch.io/moon-flower?ref=x#top'), 'moon-studio.itch.io/moon-flower', 'без запроса и якоря');

  const all = `${SITE.itch.link},${SITE.steam.link},${SITE.vndb.link}`;
  const removed = removedAfterEdit(all, SITE.itch.link);
  assert.deepStrictEqual(removed, ['steam:100', 'vndb:v100']);
  assert.deepStrictEqual(removedAfterEdit(SITE.itch.link, `${SITE.itch.link},https://store.steampowered.com/app/100`, removed), ['vndb:v100'], 'Steam вписали обратно');
});

test('сценарий «новая игра»: VNDB и Steam спрашиваются по названию (itch.io — только по ссылке); ссылки нашедших — в карточке, теги и описание — с VNDB, кадры — со Steam', async (t) => {
  const { sites, search } = await scenario(t);
  const { row } = await search();
  assert.deepStrictEqual(sites.asked, ['vndb', 'steam']);
  assert.deepStrictEqual(linksOf(row), [SITE.vndb.link, SITE.steam.link]);
  assert.deepStrictEqual(JSON.parse(row.tags), SITE.vndb.tags);
  assert.strictEqual(row.description, SITE.vndb.description);
  assert.strictEqual(row.cover, `_media/${SCENE_ID}/cover-vndb.test.jpg`);
  assert.deepStrictEqual(JSON.parse(row.screens), SITE.steam.screens, 'кадры Steam — когда других нет');
  assert.strictEqual(row.meta_status, 'ok');
});

test('сценарий «у игры уже всё есть» (страница itch.io и VNDB): сайты дальше по списку всё равно спрашиваются и дописывают свои ссылки, не заменяя лучшее', async (t) => {
  const { sites, search } = await scenario(t, {
    link: `${SITE.itch.link},${SITE.vndb.link}`, tags: JSON.stringify(SITE.itch.tags), description: SITE.itch.description,
    screens: JSON.stringify(SITE.itch.screens), meta_status: 'partial',
  });
  const { row } = await search();
  assert.ok(['itch', 'vndb', 'steam'].every((s) => sites.asked.includes(s)), sites.asked.join(' '));
  assert.ok(linksOf(row).includes(SITE.steam.link), 'ссылка Steam дописана');
  assert.strictEqual(row.description, SITE.itch.description, 'описание itch.io не заменено описанием VNDB');
  assert.deepStrictEqual(JSON.parse(row.tags), SITE.itch.tags);
});

test('сценарий «нашлась только ссылка»: записываем её, а не выбрасываем весь найденный результат', async (t) => {
  const { sites, search } = await scenario(t);
  sites.know = new Set(['steam']);
  SITE.steam.tags.length = 0;
  t.after(() => SITE.steam.tags.push('steam tag'));
  const steam = SITE.steam.description;
  SITE.steam.description = '';
  t.after(() => { SITE.steam.description = steam; });
  const { row } = await search();
  assert.deepStrictEqual(linksOf(row), [SITE.steam.link]);
  assert.strictEqual(row.meta_status, 'not_found', 'теги и описание не нашлись — поиск ещё вернётся к игре');
});

test('сценарий «сайты не ответили»: ничего не теряется — ни ссылки, ни теги itch.io, ни описание, ни обложка', async (t) => {
  const { sites, search } = await scenario(t, { link: SITE.itch.link });
  const first = (await search()).row;
  sites.down = new Set(['itch', 'steam']);
  const { lookup, row } = await search();
  assert.ok(lookup.failed.includes('itch.io') && lookup.failed.includes('store.steampowered.com'), lookup.failed.join(' '));
  assert.deepStrictEqual(linksOf(row).sort(), linksOf(first).sort(), 'ссылки itch.io и Steam остались: их сайты молчали, а не ответили «нет»');
  // Ответил один VNDB: его теги, описание и обложка слабее прежних — прежние остаются
  for (const key of ['tags', 'description', 'developer', 'releaseDate', 'cover', 'screens']) assert.strictEqual(row[key], first[key], key);
  assert.strictEqual(row.meta_status, 'ok');
});

test('сценарий «сайт ответил: такой игры нет»: найденная по названию ссылка уходит, точные остаются', async (t) => {
  const { sites, search } = await scenario(t, { link: SITE.itch.link });
  await search();
  sites.know.delete('steam');
  sites.know.delete('vndb');
  const { row } = await search();
  assert.ok(!linksOf(row).includes(SITE.steam.link), 'чужая игра Steam ушла');
  assert.ok(!linksOf(row).includes(SITE.vndb.link), 'и VNDB');
  assert.ok(linksOf(row).includes(SITE.itch.link), 'страница itch.io — точная ссылка: остаётся, даже если страница пропала');
});

test('сценарий «ничего не нашлось»: ничего и не стирается, игра не становится «не найденной»', async (t) => {
  const { sites, search } = await scenario(t, { link: SITE.itch.link });
  const first = (await search()).row;
  sites.know = new Set();
  const { lookup, row } = await search();
  assert.strictEqual(lookup.data, null);
  for (const key of ['link', 'tags', 'description', 'developer', 'cover', 'screens']) assert.strictEqual(row[key], first[key], key);
  assert.strictEqual(row.meta_status, 'ok');
});

test('сценарий «ссылку убрали руками»: не возвращается, данные с её страницы стираются; вписали обратно — снова в карточке', async (t) => {
  const { removedAfterEdit } = require('./src/utils/links.js');
  const { db, sites, search } = await scenario(t);
  // Нашли VNDB и Steam — и это чужая игра
  sites.know = new Set(['vndb', 'steam']);
  let { row } = await search();
  assert.strictEqual(row.description, SITE.vndb.description);
  // «Изменить»: убрали обе ссылки, вписали страницу itch.io (так делает routes/games.js)
  sites.know = new Set(['vndb', 'steam', 'itch']);
  const typed = SITE.itch.link;
  await db.run(`UPDATE games SET link = ?, links_removed = ?, meta_locked = '["link"]', meta_rebuild = 1`, [typed, JSON.stringify(removedAfterEdit(row.link, typed))]);
  ({ row } = await search({ manual: { link: typed }, replace: true }));
  assert.ok(sites.asked.includes('vndb') && sites.asked.includes('steam'), 'спрашиваются как всегда');
  assert.deepStrictEqual(linksOf(row), [SITE.itch.link], 'убранные ссылки не вернулись');
  assert.strictEqual(row.description, SITE.itch.description, 'описание — со страницы itch.io, не с VNDB');
  assert.deepStrictEqual(JSON.parse(row.screens), SITE.itch.screens, 'кадров Steam не осталось');
  // Следующий фоновый поиск — то же самое
  ({ row } = await search());
  assert.deepStrictEqual(linksOf(row), [SITE.itch.link]);

  // Убрали и страницу: остальные молчат о других страницах — данные чужих игр стираются
  sites.know = new Set();
  await db.run(`UPDATE games SET link = '', links_removed = ?, meta_rebuild = 1`, [JSON.stringify(removedAfterEdit(row.link, '', JSON.parse(row.links_removed)))]);
  ({ row } = await search({ manual: { link: '' } }));
  assert.deepStrictEqual([row.link, row.description, row.tags, row.screens], ['', '', '[]', '[]']);
  assert.strictEqual(row.meta_status, 'not_found');

  // Вписали Steam обратно — он снова свой
  sites.know = new Set(['vndb', 'steam']);
  await db.run(`UPDATE games SET link = ?, links_removed = ?`, [SITE.steam.link, JSON.stringify(removedAfterEdit('', SITE.steam.link, JSON.parse(row.links_removed)))]);
  ({ row } = await search());
  assert.ok(linksOf(row).includes(SITE.steam.link));
  assert.strictEqual(row.description, SITE.steam.description, 'VNDB убран руками, его данные не берём — описание со Steam');
});

test('сценарий «убрали ссылку, а какой-то сайт молчит»: ничего не стирается, данные соберутся заново, когда ответят все', async (t) => {
  const { removedAfterEdit } = require('./src/utils/links.js');
  const { db, sites, search } = await scenario(t, { link: SITE.itch.link });
  // Описание и кадры — со Steam (чужая игра), остальное — со страницы itch.io
  sites.know.delete('vndb');
  const first = (await search()).row;
  await db.run(`UPDATE games SET description = ?, screens = ? WHERE id = ?`, [SITE.steam.description, JSON.stringify(SITE.steam.screens), SCENE_ID]);
  const left = linksOf(first).filter((l) => l !== SITE.steam.link).join(',');
  await db.run(`UPDATE games SET link = ?, links_removed = ?, meta_locked = '["link"]', meta_rebuild = 1`, [left, JSON.stringify(removedAfterEdit(first.link, left))]);
  sites.down = new Set(['itch']);
  const before = Date.now();
  let { row } = await search({ manual: { link: left } });
  assert.ok(!linksOf(row).includes(SITE.steam.link));
  assert.strictEqual(row.description, SITE.steam.description, 'itch.io молчал — ничего не стёрто и не заменено');
  assert.strictEqual(row.meta_rebuild, 1, 'отметка «собрать заново» держится');
  assert.ok(row.meta_retry_at > before && row.meta_retry_at <= before + 2 * 3600e3, 'следующая попытка — скоро, как после сбоя');

  sites.down = new Set();
  ({ row } = await search());
  assert.strictEqual(row.description, SITE.itch.description, 'ответили все — описание с оставшихся страниц');
  assert.ok(!JSON.parse(row.screens).includes(SITE.steam.screens[0]), 'кадров Steam не осталось');
  assert.deepStrictEqual([row.meta_rebuild, row.meta_retry_at], [0, null]);
});

test('сценарий «ручные поля главнее»: автора, вписанного руками, найденный не заменяет', async (t) => {
  const { search } = await scenario(t, { developer: 'Мой автор', meta_locked: '["developer"]', link: SITE.itch.link });
  const { row } = await search();
  assert.strictEqual(row.developer, 'Мой автор');
  assert.strictEqual(row.description, SITE.itch.description, 'остальное найдено как обычно');
});

// Библиотека на диске: папки игр, база и корзина — во временной папке, поиск данных подменён
async function libraryRig(t) {
  const fs = require('fs');
  const os = require('os');
  const { createTrash } = require('./src/services/trash.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-'));
  const lib = new (dbService.constructor)();
  await lib.init(root);
  const asked = [];
  const scraper = { requestScrape: async (ids) => { asked.push(...ids); return ids.length; } };
  const trash = createTrash({ db: () => lib.get(), trashDir: path.join(root, '_trash'), gamesDir: root });
  lib.setDependencies(null, scraper, root, trash);
  const { redisClient } = require('./src/utils/cache.js');
  t.mock.method(redisClient, 'del', async () => 1);
  t.mock.method(require('./src/services/gallery.js'), 'forget', async () => {});
  t.after(async () => { await lib.get().close(); fs.rmSync(root, { recursive: true, force: true }); });
  const folder = (id, title) => {
    fs.mkdirSync(path.join(root, id, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'data', 'System.json'), JSON.stringify({ gameTitle: title }));
  };
  const row = (id) => lib.get().get('SELECT * FROM games WHERE id = ?', [id]);
  return { lib, root, trash, asked, folder, row, fs };
}

test('сценарий «новая папка»: запись и поиск данных; вотчер и загрузка добавляют её разом — найденное не стирается', async (t) => {
  const { lib, root, asked, folder, row } = await libraryRig(t);
  folder('Moon', 'Moon Flower');
  await lib.syncDatabase();
  assert.strictEqual((await row('Moon')).title, 'Moon Flower');
  assert.deepStrictEqual(asked, ['Moon'], 'поиск данных — сразу');
  // Поиск успел найти данные, и тут второй вызов для той же папки (загрузка после вотчера)
  await lib.get().run(`UPDATE games SET tags = '["rpg"]', description = 'found', playtime = 60 WHERE id = 'Moon'`);
  await lib.addGameToDB('Moon', path.join(root, 'Moon'));
  const after = await row('Moon');
  assert.deepStrictEqual([after.tags, after.description, after.playtime], ['["rpg"]', 'found', 60]);
  assert.deepStrictEqual(asked, ['Moon'], 'второй раз не ищем');
});

test('сценарий «папку убрали мимо приложения»: запись — в корзину на 30 дней; вернули папку — игра вернулась со всем', async (t) => {
  const { lib, root, trash, asked, folder, row, fs } = await libraryRig(t);
  folder('Moon', 'Moon Flower');
  await lib.syncDatabase();
  await lib.get().run(`UPDATE games SET rating = 5, playtime = 3600, status = 'playing', tags = '["rpg"]', link = ? WHERE id = 'Moon'`, [SITE.itch.link]);

  fs.renameSync(path.join(root, 'Moon'), path.join(root, '..', `${path.basename(root)}-Moon`));
  t.after(() => fs.rmSync(path.join(root, '..', `${path.basename(root)}-Moon`), { recursive: true, force: true }));
  await lib.syncDatabase();
  assert.strictEqual(await row('Moon'), undefined, 'из библиотеки ушла');
  const [item] = await trash.list();
  assert.deepStrictEqual([item.id, item.vanished, item.taken, item.playtime], ['Moon', true, false, 3600]);
  assert.strictEqual(await trash.count(), 1, 'число игр в корзине — по записям, без подсчёта размеров');
  await assert.rejects(trash.restore(item.key), /Папки игры нет/, 'без папки вернуть нечего');

  fs.renameSync(path.join(root, '..', `${path.basename(root)}-Moon`), path.join(root, 'Moon'));
  await lib.syncDatabase();
  const back = await row('Moon');
  assert.deepStrictEqual([back.rating, back.playtime, back.status, back.tags, back.link], [5, 3600, 'playing', '["rpg"]', SITE.itch.link]);
  assert.deepStrictEqual(await trash.list(), [], 'из корзины запись ушла');
  assert.strictEqual(await trash.count(), 0);
  assert.deepStrictEqual(asked, ['Moon'], 'данные вернулись с записью — искать заново незачем');
});

test('сценарий «удалили через приложение и вернули»: всё на месте; та же папка, загруженная заново, — новая игра', async (t) => {
  const { lib, root, trash, asked, folder, row, fs } = await libraryRig(t);
  folder('Moon', 'Moon Flower');
  await lib.syncDatabase();
  await lib.get().run(`UPDATE games SET rating = 4, playtime = 600 WHERE id = 'Moon'`);
  const { key } = await trash.trashGame('Moon');
  await lib.syncDatabase();
  assert.strictEqual((await trash.list()).length, 1, 'вотчер не кладёт в корзину вторую запись');
  await trash.restore(key);
  const back = await row('Moon');
  assert.deepStrictEqual([back.rating, back.playtime], [4, 600]);

  // Удалили и загрузили ту же игру заново: удалённая остаётся в корзине, новая — с чистого листа
  await trash.trashGame('Moon');
  folder('Moon', 'Moon Flower');
  await lib.syncDatabase();
  const fresh = await row('Moon');
  assert.deepStrictEqual([fresh.rating, fresh.playtime], [0, 0]);
  assert.strictEqual((await trash.list()).filter((i) => !i.vanished).length, 1);
  assert.deepStrictEqual(asked, ['Moon', 'Moon']);
  fs.rmSync(path.join(root, '_trash'), { recursive: true, force: true });
});

test('сценарий «новая версия поверх старой»: найденные данные, время и ссылки остаются, название и версия — из новой', async (t) => {
  const { lib, root, folder, row, fs } = await libraryRig(t);
  folder('Moon', 'Moon Flower v1.0');
  await lib.syncDatabase();
  await lib.get().run(`UPDATE games SET playtime = 900, tags = '["rpg"]', description = 'found', link = ? WHERE id = 'Moon'`, [SITE.itch.link]);
  fs.writeFileSync(path.join(root, 'Moon', 'data', 'System.json'), JSON.stringify({ gameTitle: 'Moon Flower v1.2' }));
  await lib.refreshGame('Moon', path.join(root, 'Moon'), { archiveName: 'Moon_Flower_v1.2.zip' });
  const after = await row('Moon');
  assert.deepStrictEqual([after.playtime, after.tags, after.description, after.link], [900, '["rpg"]', 'found', SITE.itch.link]);
  assert.deepStrictEqual([after.title, after.my_version], ['Moon Flower v1.2', '1.2']);
});

test('поиск Moonlit Priestess: игра зовёт себя «… Alpha Ver0.80», в магазине — без «Alpha»', async (t) => {
  const { cleanTitle } = require('./src/utils/title.js');
  assert.strictEqual(cleanTitle('Moonlit Priestess Alpha Ver0.80'), 'Moonlit Priestess');
  assert.strictEqual(cleanTitle('Tidewater Rhapsody Beta Demo'), 'Tidewater Rhapsody');
  assert.strictEqual(cleanTitle('Witch Hunt - Early Access v0.3'), 'Witch Hunt');
  assert.strictEqual(cleanTitle('Project Alpha'), 'Project Alpha', 'одно слово без пометки — это не название');
  assert.strictEqual(cleanTitle('Alpha Squad Heroes'), 'Alpha Squad Heroes', 'в начале и в середине — часть названия');

  const scraper = require('./src/services/scraper.js');
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = decodeURIComponent(String(input));
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('api.vndb.org')) return json({ results: [] });
    // Как поиск Steam: все слова запроса должны быть в названии
    if (url.includes('storesearch')) {
      const words = url.split('term=')[1].split('&')[0].toLowerCase().split(/\s+/);
      const all = [{ id: 44110, name: 'Moonlit Priestess' }, { id: 1, name: 'Priestess of the Dark Moon' }];
      return json({ items: all.filter((x) => words.every((w) => x.name.toLowerCase().split(' ').includes(w))) });
    }
    const id = (url.match(/appids=(\d+)/) || [])[1];
    if (id) return json({ [id]: { success: true, data: { name: 'x', short_description: `Game ${id}`, genres: [{ description: 'RPG' }], developers: ['Moon Studio'] } } });
    return { ok: false, status: 404 };
  });
  const { data } = await scraper.lookupMetadata('Moonlit Priestess Alpha Ver0.80', '', { altTitle: scraper.titleFromFolder('MoonPri_Alpha_080Z'), readmeTitle: '' });
  assert.ok(data?.link.includes('store.steampowered.com/app/44110'), data?.link);
});

// ============================================================================
// Журнал поиска («Как искали») и «Возможно, это она»
// ============================================================================

test('журнал поиска: по каждому сайту — что спросили и что он ответил; журнал пишется в игру', async (t) => {
  const { removedAfterEdit } = require('./src/utils/links.js');
  const { db, sites, search } = await scenario(t);
  sites.know = new Set(['vndb']);
  sites.down = new Set(['steam']);
  let { lookup, row } = await search();
  const result = (site) => lookup.journal.steps.filter((s) => s.site === site).map((s) => s.result);
  assert.deepStrictEqual(result('vndb'), ['found']);
  assert.ok(lookup.journal.steps.find((s) => s.site === 'vndb').link === SITE.vndb.link);
  assert.ok(result('steam').includes('down'), 'Steam не ответил');
  assert.deepStrictEqual(JSON.parse(row.meta_log).steps, lookup.journal.steps, 'журнал — в базе');

  // Ссылку Steam убрали руками: поиск её находит, но не берёт — в журнале так и сказано
  sites.know = new Set(['vndb', 'steam']);
  sites.down = new Set();
  await db.run(`UPDATE games SET link = ?, links_removed = ?, meta_locked = '["link"]'`, [SITE.vndb.link, JSON.stringify(removedAfterEdit(`${SITE.vndb.link},${SITE.steam.link}`, SITE.vndb.link))]);
  ({ lookup } = await search());
  assert.ok(lookup.journal.steps.some((s) => s.site === 'steam' && s.result === 'refused' && s.link === SITE.steam.link));
});

test('журнал поиска: похожее, но не подошедшее — с названием, ссылкой и сходством', async (t) => {
  const scraper = require('./src/services/scraper.js');
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = decodeURIComponent(String(input));
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('api.vndb.org')) return json({ results: [{ id: 'v252', title: 'Sky Knight Quest', description: '', image: null, tags: [] }] });
    if (url.includes('storesearch')) return json({ items: [{ id: 3451330, name: 'Sky Knight Quest' }] });
    return { ok: false, status: 404 };
  });
  const { data, journal } = await scraper.lookupMetadata('SkyKnight ov1.0.0', '', { altTitle: 'SkyKnight TheCrystalLabyrinth', readmeTitle: '' });
  assert.strictEqual(data, null);
  const vndb = journal.near.find((n) => n.site === 'vndb');
  assert.deepStrictEqual([vndb.title, vndb.link], ['Sky Knight Quest', 'https://vndb.org/v252']);
  assert.ok(vndb.score >= 0.4 && vndb.score < 0.75, String(vndb.score));
  assert.ok(journal.near.some((n) => n.site === 'steam' && n.link === 'https://store.steampowered.com/app/3451330'));
  assert.ok(journal.steps.some((s) => s.site === 'steam' && s.by === 'title' && s.result === 'none'));
});

test('загрузка: архивы распаковываются строго по одному; ждущий очереди виден и его можно отменить', async (t) => {
  const rig = await uploadRig(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const order = [];
  rig.extract = async (out, password, archive) => {
    const name = path.basename(archive);
    order.push(`start ${name}`);
    if (order.length === 1) await gate;
    await fsp.mkdir(path.join(out, 'Game', 'www'), { recursive: true });
    await fsp.writeFile(path.join(out, 'Game', 'www', 'index.html'), 'game');
    order.push(`end ${name}`);
  };
  const send = async (name, fingerprint) => {
    const file = Buffer.from(`${name}-bytes`);
    const { body } = await rig.start({ name, size: file.length, fingerprint });
    await rig.chunk(body.id, 0, file);
    return body.id;
  };
  const a = await send('First.zip', 'a1');
  await rig.until(() => order.length === 1, 'первая распаковка началась');
  const b = await send('Second.zip', 'b2');
  const c = await send('Third.zip', 'c3');
  assert.deepStrictEqual([(await rig.status(b)).step, (await rig.status(c)).step], ['queued', 'queued'], 'ждут своей очереди');
  assert.ok((await rig.call('GET', '/list')).body.find((x) => x.id === b).queued);
  // Идущую не отменить, ждущую — можно
  assert.strictEqual((await rig.call('POST', `/cancel?id=${a}`)).status, 409);
  assert.strictEqual((await rig.call('POST', `/cancel?id=${c}`)).status, 200);
  assert.strictEqual(order.length, 1, 'вторая не начинается, пока идёт первая');
  release();
  await rig.svc.jobs.get(b);
  await rig.until(() => !rig.svc.jobs.size, 'очередь пуста');
  assert.deepStrictEqual(order, [`start ${a}.archive`, `end ${a}.archive`, `start ${b}.archive`, `end ${b}.archive`], 'по одной, по порядку; отменённая не распаковывалась');
  assert.deepStrictEqual([(await rig.status(a)).state, (await rig.status(b)).state], ['done', 'done']);
  assert.strictEqual((await rig.call('GET', `/status?id=${c}`)).status, 404);
  assert.strictEqual(rig.added.length, 2);
  assert.ok(!rig.svc.queued(a) && !rig.svc.queued(b), 'законченные — не «ждут очереди»: их не отменить как ждущие');
  assert.strictEqual((await rig.call('POST', `/cancel?id=${b}`)).status, 200, 'готовую — только убрать из списка');

  // Отменённую в очереди загрузили снова — распакуется как новая, старое задание не мешает
  const again = await send('Third.zip', 'c3');
  assert.strictEqual(again, c);
  await rig.svc.jobs.get(c);
  assert.strictEqual((await rig.status(c)).state, 'done');
  assert.strictEqual(rig.added.length, 3);
});

test('«Место»: что сколько занимает и что можно убрать — прежние версии своими байтами, корзина со сроком, кандидаты с причиной', async (t) => {
  const fs = require('fs');
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { SpaceService } = require('./src/services/space.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'space-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, link TEXT DEFAULT '', size INTEGER DEFAULT 0, status TEXT DEFAULT '',
    playtime INTEGER DEFAULT 0, lastPlayed INTEGER DEFAULT 0, addedAt INTEGER DEFAULT 0, ready INTEGER DEFAULT 1, meta_locked TEXT DEFAULT '[]')`);
  const now = Date.UTC(2026, 9, 8);
  const day = 864e5;
  const add = (id, title, size, more = {}) => db.run('INSERT INTO games (id, title, size, status, playtime, lastPlayed, addedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, title, size, more.status || '', more.playtime || 0, more.lastPlayed || 0, more.addedAt ?? now - 90 * day]);
  await add('Done_Game', 'Done Game', 3000, { status: 'done', playtime: 3600, lastPlayed: now - day });
  await add('Dropped_Game', 'Dropped Game', 2000, { status: 'dropped', playtime: 60, lastPlayed: now - 5 * day });
  await add('Never_Old', 'Never Old', 5000);
  await add('Never_Fresh', 'Never Fresh', 4000, { addedAt: now - 2 * day });
  await add('Wish_Game', 'Wish Game', 1000, { status: 'wish' });
  await add('Unsized', 'Unsized', 0, { playtime: 10, lastPlayed: now });
  await add('Moon_v1', 'Moon Flower', 700, { playtime: 10, lastPlayed: now });
  await add('Moon_v2', 'Moon Flower', 900);
  // Прежние версии: у Done_Game — свой файл и общий с нынешней (жёсткая ссылка после патча)
  const old = path.join(root, '_old');
  fs.mkdirSync(path.join(old, 'Done_Game', '2026-10-01'), { recursive: true });
  fs.writeFileSync(path.join(old, 'Done_Game', '2026-10-01', 'own.bin'), Buffer.alloc(1500));
  fs.mkdirSync(path.join(root, 'Done_Game'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Done_Game', 'shared.bin'), Buffer.alloc(800));
  fs.linkSync(path.join(root, 'Done_Game', 'shared.bin'), path.join(old, 'Done_Game', '2026-10-01', 'shared.bin'));
  const svc = new SpaceService();
  svc.setDependencies({
    db: { get: () => db }, gamesDir: root, oldDir: old, savesDir: path.join(root, '_saves'),
    trash: { list: async () => [{ key: 'k', id: 'Gone', size: 6000, purgeAt: now + 20 * day }] },
    uploads: { list: async () => [{ id: 'u1', name: 'Half.zip', received: 400, size: 1000, state: 'uploading' }, { id: 'u2', name: 'Busy.zip', received: 1000, size: 1000, state: 'processing' }] },
  });
  const r = await svc.report({ now });
  assert.deepStrictEqual(r.suggest.old, [{ id: 'Done_Game', title: 'Done Game', size: 1500, gone: false }], 'общий с игрой файл удаление не освободит — не считаем');
  assert.deepStrictEqual(r.trash, { count: 1, size: 6000, nextPurgeAt: now + 20 * day });
  assert.deepStrictEqual(r.suggest.uploads.map((u) => [u.name, u.size]), [['Half.zip', 400]], 'распаковывающийся архив — не лишний');
  assert.deepStrictEqual(r.suggest.done.map((g) => g.id), ['Done_Game']);
  assert.deepStrictEqual(r.suggest.dropped.map((g) => g.id), ['Dropped_Game']);
  assert.deepStrictEqual(r.suggest.never.map((g) => g.id), ['Never_Old', 'Moon_v2'], 'недавно добавленную и «в планах» не предлагаем');
  assert.deepStrictEqual(r.suggest.dupes.map((group) => group.map((g) => g.id)), [['Moon_v2', 'Moon_v1']]);
  assert.deepStrictEqual([r.parts.games, r.parts.old, r.parts.trash, r.parts.uploads, r.unsized], [16600, 1500, 6000, 400, 1]);
  assert.strictEqual(r.games[0].id, 'Never_Old', 'все игры — самые большие первыми');
  assert.strictEqual(r.games.find((g) => g.id === 'Done_Game').old, 1500);
  assert.ok(r.disk.total > 0 && r.disk.free > 0);
  // Второй раз — из кэша; fresh — заново
  await db.run("UPDATE games SET status = 'done' WHERE id = 'Never_Old'");
  assert.strictEqual((await svc.report({ now: now + 1000 })).suggest.done.length, 1);
  assert.strictEqual((await svc.report({ now: now + 2000, fresh: true })).suggest.done.length, 2);
});

test('галерея: анимации (GIF, APNG — и зашифрованный, анимированный WebP) и видео из movies/ и img/', async (t) => {
  const { GalleryService, isAnimated, pngSize } = require('./src/services/gallery.js');
  const { execFileSync } = require('child_process');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-anim-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // PNG: подпись, IHDR, при желании — блоки перед данными (профиль цвета, acTL), потом IDAT
  const chunk = (type, len) => { const b = Buffer.alloc(12 + len); b.writeUInt32BE(len, 0); b.write(type, 4, 'latin1'); return b; };
  const png = (w, h, before = []) => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = chunk('IHDR', 13); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
    return Buffer.concat([sig, ihdr, ...before, chunk('IDAT', 50000)]);
  };
  const apng = png(400, 300, [chunk('iCCP', 2000), chunk('acTL', 8)]);
  const key = '0123456789abcdef0123456789abcdef';
  const encrypt = (data) => {
    const out = Buffer.concat([Buffer.from('RPGMV\0\0\0\0\x03\x01\0\0\0\0\0', 'latin1'), data]);
    const k = key.match(/../g).map((x) => parseInt(x, 16));
    for (let i = 0; i < 16; i++) out[16 + i] ^= k[i];
    return out;
  };
  const gif = Buffer.alloc(800); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8);
  const webp = (animated) => { const b = Buffer.alloc(800); b.write('RIFF', 0, 'latin1'); b.write('WEBPVP8X', 8, 'latin1'); b[20] = animated ? 0x12 : 0x10; b.writeUIntLE(199, 24, 3); b.writeUIntLE(99, 27, 3); return b; };

  assert.ok(isAnimated(apng), 'acTL после профиля цвета');
  assert.ok(isAnimated(encrypt(apng)), 'у зашифрованного блоки после первых 16 байт видны');
  assert.ok(!isAnimated(png(400, 300)), 'обычный PNG');
  assert.ok(isAnimated(gif) && isAnimated(webp(true)) && !isAnimated(webp(false)));
  assert.deepStrictEqual(pngSize(gif), { w: 320, h: 240 });

  const game = path.join(root, 'G', 'www');
  for (const d of ['data', 'img/pictures', 'movies']) await fsp.mkdir(path.join(game, d), { recursive: true });
  await fsp.writeFile(path.join(game, 'data', 'System.json'), JSON.stringify({ encryptionKey: key }));
  await fsp.writeFile(path.join(game, 'img/pictures/h_anim_1.rpgmvp'), encrypt(apng));
  await fsp.writeFile(path.join(game, 'img/pictures/sparkle.gif'), gif);
  await fsp.writeFile(path.join(game, 'img/pictures/wave.webp'), webp(true));
  // Настоящие ролики — ffmpeg их и нарежет на обложки. Длиннее и короче секунды
  // Короткий и без звука — петля (анимация), длинный или со звуком — ролик
  const clip = (file, seconds, sound = false) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:s=64x48:d=${seconds}`,
    ...(sound ? ['-f', 'lavfi', '-i', `sine=d=${seconds}`, '-c:a', 'libvorbis'] : []), '-c:v', 'libvpx', '-shortest', file]);
  clip(path.join(game, 'movies', 'opening.webm'), 3);
  clip(path.join(game, 'img/pictures', 'scene_short.webm'), 0.4);
  // Ровно секунда: «кадр на первой секунде» уже за концом (так у Loretta — r_cg04.webm)
  clip(path.join(game, 'movies', 'exact.webm'), 1);
  clip(path.join(game, 'movies', 'voice.webm'), 1.5, true);
  // Ролики с номерами вместо имён — один альбом по имени папки; петли из него — отдельным альбомом
  await fsp.mkdir(path.join(game, 'movies', 'h'), { recursive: true });
  clip(path.join(game, 'movies', 'h', '1.webm'), 0.5);
  clip(path.join(game, 'movies', 'h', '2.webm'), 3);

  const g = new GalleryService();
  g.setDependencies({ gamesDir: root });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await g.build('G').promise;
  quiet.mock.restore();
  const byKey = Object.fromEntries(index.albums.map((a) => [a.key, a.kind]));
  assert.deepStrictEqual(byKey, {
    'img/pictures/h_anim': 'animation', 'img/pictures/sparkle': 'animation', 'img/pictures/wave': 'other', // 200×100 движется, но мелкая — значок, не анимация сцены
    'img/pictures/scene_short#loop': 'animation', 'movies/opening': 'video', 'movies/exact#loop': 'animation', 'movies/voice': 'video',
    'movies/h#loop': 'animation', 'movies/h': 'video',
  });
  assert.deepStrictEqual([index.counts.animation, index.counts.video], [5, 3], 'петли — к анимациям; длинный и со звуком — ролики');
  // Ролик — файлом и с типом; картинкой его не отдать; GIF — с типом GIF
  const v = await g.video('G', 'movies/opening.webm');
  assert.deepStrictEqual([v.type, v.file.endsWith(path.join('movies', 'opening.webm'))], ['video/webm', true]);
  assert.strictEqual(await g.image('G', 'movies/opening.webm'), null);
  assert.strictEqual(await g.video('G', 'img/pictures/sparkle.gif'), null);
  assert.strictEqual(await g.video('G', 'movies/../data/System.json'), null);
  assert.strictEqual((await g.image('G', 'img/pictures/sparkle.gif')).type, 'image/gif');
  // Обложки роликов: и с первой секунды, и у ролика короче секунды
  for (const rel of ['movies/opening.webm', 'img/pictures/scene_short.webm', 'movies/exact.webm']) {
    const thumb = await g.thumb('G', rel);
    assert.ok((await fsp.stat(thumb)).size > 20, rel);
  }

  // Настоящие анимации — и миниатюры к ним: APNG ffmpeg читает только из файла, анимированный WebP
  // не читает вовсе — тогда миниатюра он сам. APNG ещё и зашифрован, как в игре
  const real = (args, file) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=400x300:d=1:r=5', ...args, file]);
  real(['-plays', '0', '-f', 'apng'], path.join(root, 'a.png'));
  await fsp.writeFile(path.join(game, 'img/pictures/real_apng.rpgmvp'), encrypt(await fsp.readFile(path.join(root, 'a.png'))));
  real([], path.join(game, 'img/pictures/real_gif.gif'));
  real(['-c:v', 'libwebp_anim', '-loop', '0'], path.join(game, 'img/pictures/real_webp.webp'));
  await g.forget('G');
  const quiet2 = t.mock.method(console, 'log', () => {});
  const again = await g.build('G').promise;
  quiet2.mock.restore();
  for (const key of ['img/pictures/real_apng', 'img/pictures/real_gif', 'img/pictures/real_webp']) {
    const album = again.albums.find((a) => a.key === key);
    assert.strictEqual(album?.kind, 'animation', key);
    const thumb = await g.thumb('G', album.files[0]);
    assert.ok(thumb && (await fsp.stat(thumb)).size > 20, `миниатюра ${key}`);
  }
  // Не картинка вовсе — миниатюры нет, и очередь миниатюр не встала
  await fsp.writeFile(path.join(game, 'img/pictures/broken.png'), Buffer.from('not a picture at all, but long enough to be read'));
  await g.forget('G');
  const quiet3 = t.mock.method(console, 'log', () => {});
  await g.build('G').promise;
  quiet3.mock.restore();
  await assert.rejects(g.thumb('G', 'img/pictures/broken.png'));
  assert.strictEqual(g.thumbLane.jobs, 0, 'слот освободился');
});

test('галерея: APNG рядом с неподвижными картинками — свой альбом «#loop», а не «Анимации» на весь альбом', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-mix-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const chunk = (type, len) => { const b = Buffer.alloc(12 + len); b.writeUInt32BE(len, 0); b.write(type, 4, 'latin1'); return b; };
  const png = (w, h, moving) => {
    const ihdr = chunk('IHDR', 13); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, ...(moving ? [chunk('acTL', 8)] : []), chunk('IDAT', 50000)]);
  };
  const dir = path.join(root, 'G', 'www', 'img', 'pictures');
  await fsp.mkdir(dir, { recursive: true });
  // mix: две неподвижные и одна APNG; pure: только APNG
  for (const n of ['mix_1', 'mix_2']) await fsp.writeFile(path.join(dir, `${n}.png`), png(816, 624, false));
  await fsp.writeFile(path.join(dir, 'mix_3.png'), png(816, 624, true));
  for (const n of ['pure_1', 'pure_2']) await fsp.writeFile(path.join(dir, `${n}.png`), png(816, 624, true));
  const g = new GalleryService();
  g.setDependencies({ gamesDir: root });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await g.build('G').promise;
  quiet.mock.restore();
  const by = Object.fromEntries(index.albums.map((a) => [a.key, a]));
  assert.notStrictEqual(by['img/pictures/mix']?.kind, 'animation', 'неподвижные остались своим альбомом');
  assert.deepStrictEqual(by['img/pictures/mix'].files.map((f) => path.basename(f)).sort(), ['mix_1.png', 'mix_2.png']);
  assert.strictEqual(by['img/pictures/mix#loop']?.kind, 'animation');
  assert.deepStrictEqual(by['img/pictures/mix#loop'].files.map((f) => path.basename(f)), ['mix_3.png']);
  assert.strictEqual(by['img/pictures/pure']?.kind, 'animation', 'альбом из одних APNG не делится');
  assert.ok(!by['img/pictures/pure#loop']);
});

test('галерея: видеопетля и APNG с одним именем — разные альбомы, плеер не получает видео вместе с картинкой', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const { execFileSync, spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-vmix-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const chunk = (type, len) => { const b = Buffer.alloc(12 + len); b.writeUInt32BE(len, 0); b.write(type, 4, 'latin1'); return b; };
  const png = (moving) => {
    const ihdr = chunk('IHDR', 13); ihdr.writeUInt32BE(816, 8); ihdr.writeUInt32BE(624, 12);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, ...(moving ? [chunk('acTL', 8)] : []), chunk('IDAT', 50000)]);
  };
  const dir = path.join(root, 'G', 'www', 'img', 'pictures');
  await fsp.mkdir(dir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=0.4', '-c:v', 'libvpx', path.join(dir, 'ending_1.webm')]);
  for (const n of ['ending_2', 'ending_3']) await fsp.writeFile(path.join(dir, `${n}.png`), png(false));
  await fsp.writeFile(path.join(dir, 'ending_4.png'), png(true));
  const g = new GalleryService();
  g.setDependencies({ gamesDir: root });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await g.build('G').promise;
  quiet.mock.restore();
  const by = Object.fromEntries(index.albums.map((a) => [a.key, a.files.map((f) => path.basename(f))]));
  assert.deepStrictEqual(by['img/pictures/ending#loop'], ['ending_1.webm'], 'петля-ролик одна в своём ключе');
  assert.deepStrictEqual(by['img/pictures/ending#img#loop'], ['ending_4.png'], 'APNG — под другим ключом, тоже в конце «#loop»');
  assert.deepStrictEqual(by['img/pictures/ending'].sort(), ['ending_2.png', 'ending_3.png']);
});

test('галерея: очередь ffmpeg — сначала то, что смотрит человек; фон (обложки заранее, распознавание) — одно место и после', async () => {
  const { GalleryService, inBackground } = require('./src/services/gallery.js');
  const g = new GalleryService();
  g.thumbLane.size = 2;
  const order = [];
  // Фон занял одно место; второй фоновый ждёт, хотя место есть: фону — не больше одного
  const bg1 = await inBackground(() => g.slot());
  let bg2Got = false;
  const bg2 = inBackground(() => g.slot()).then((x) => { bg2Got = true; order.push('фон'); return x; });
  const user1 = await g.slot();
  assert.strictEqual(bg2Got, false);
  // Место кончилось: человек встаёт в очередь раньше фона и получает место первым
  const user2 = g.slot().then((x) => { order.push('человек'); return x; });
  g.release(bg1);
  await user2;
  g.release(user1);
  await bg2;
  assert.deepStrictEqual(order, ['человек', 'фон']);
  g.release(await user2);
  g.release(await bg2);
  assert.deepStrictEqual([g.thumbLane.jobs, g.thumbLane.bgJobs], [0, 0]);
});

test('галерея: петля — не длиннее двух секунд и без звука; ffprobe не ответил — оглавление временное', async (t) => {
  const { GalleryService, isLoop } = require('./src/services/gallery.js');
  assert.ok(isLoop({ duration: 2, audio: false }) && isLoop({ duration: 2.05, audio: false }));
  assert.ok(!isLoop({ duration: 2.06, audio: false }), 'длиннее — ролик');
  assert.ok(!isLoop({ duration: 1, audio: true }), 'со звуком (хоть и тихим) — ролик');
  assert.ok(!isLoop({ duration: 0, audio: false }) && !isLoop(null), 'длина не узнана — ролик');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-probe-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'G', 'www', 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(root, 'G', 'www', 'movies'), { recursive: true });
  await fsp.writeFile(path.join(root, 'G', 'www', 'movies', 'loop.webm'), 'x');
  const g = new GalleryService();
  g.setDependencies({ gamesDir: root });
  let answer = null;
  t.mock.method(g, 'probe', async () => answer);
  const quiet = [t.mock.method(console, 'log', () => {}), t.mock.method(console, 'warn', () => {})];
  const first = await g.build('G').promise;
  assert.deepStrictEqual([first.albums[0].kind, first.retryAt > Date.now()], ['video', true], 'не узнали — пока ролик, и оглавление временное');
  assert.ok(await g.cached('G'), 'в течение часа — то же');
  g.memo.clear();
  const json = JSON.parse(await fsp.readFile(g.indexPath('G'), 'utf8'));
  await fsp.writeFile(g.indexPath('G'), JSON.stringify({ ...json, retryAt: Date.now() - 1 }));
  assert.strictEqual(await g.cached('G'), null, 'час прошёл — собрать заново');
  answer = { duration: 1, audio: false };
  const second = await g.build('G').promise;
  assert.deepStrictEqual([second.albums[0].kind, second.retryAt], ['animation', undefined]);
  // Ответ ffprobe запомнен: пересборка его не спрашивает; ролик заменили (другой размер) — спрашивает снова
  const asked = g.probe.mock.callCount();
  await g.runBuild('G', { done: 0, total: 0 });
  assert.strictEqual(g.probe.mock.callCount(), asked);
  await fsp.writeFile(path.join(root, 'G', 'www', 'movies', 'loop.webm'), 'xy');
  answer = { duration: 30, audio: true };
  assert.strictEqual((await g.runBuild('G', { done: 0, total: 0 })).albums[0].kind, 'video');
  assert.strictEqual(g.probe.mock.callCount(), asked + 1);
  quiet.forEach((m) => m.mock.restore());
});

// ============================================================================
// Перевод игр (utils/gametext.js, services/translate.js): ничего в игре не ломается
// ============================================================================

const fs = require('fs');

// Маленькая игра MV: всё, что бывает в data/*.json, — и видимый текст, и то, что трогать нельзя
function tlGame(root) {
  const data = path.join(root, 'G', 'www', 'data');
  const js = path.join(root, 'G', 'www', 'js');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(js, 'plugins'), { recursive: true });
  const w = (name, v) => fs.writeFileSync(path.join(data, `${name}.json`), JSON.stringify(v));
  w('System', { gameTitle: 'ゲーム', currencyUnit: 'G', elements: ['', '炎'], skillTypes: ['', '魔法'], weaponTypes: [''], armorTypes: [''], equipTypes: ['', '武器'],
    terms: { basic: ['レベル', 'Lv'], commands: ['戦う', '逃げる'], params: ['最大HP'], messages: { actionFailure: '%1には効かなかった！', victory: '%1の勝利！' } },
    switches: ['', 'イベント済み'], variables: ['', '好感度'] });
  w('Actors', [null, { id: 1, name: 'アリス', nickname: '剣士', profile: '村の剣士。\nよろしく。', note: '<Friend:ボブ>', characterName: 'Actor1', faceName: 'Actor1' },
    { id: 2, name: 'ボブ', nickname: '', profile: '', note: '', characterName: 'Actor2', faceName: '' }]);
  w('Items', [null, { id: 1, name: 'ポーション', description: 'HPを\\C[2]50\\C[0]回復する。', note: '<Upgrade:ハイポーション>' },
    { id: 2, name: 'ハイポーション', description: 'HPを回復する。', note: '' }]);
  w('Map001', { displayName: '森の入口', note: '', events: [null, { id: 1, name: 'EV001', note: '', pages: [{ list: [
    { code: 101, indent: 0, parameters: ['Actor1', 0, 0, 2, 'アリス'] },
    { code: 401, indent: 0, parameters: ['\\N[1]、こんにちは！\\!元気？'] },
    { code: 102, indent: 0, parameters: [['はい', 'いいえ'], 1, 0, 2, 0] },
    { code: 402, indent: 0, parameters: [0, 'はい'] },
    { code: 401, indent: 1, parameters: ['よかった。'] },
    { code: 355, indent: 0, parameters: ["if ($gameActors.actor(2).name() === 'ボブ') $gameSwitches.setValue(1, true);"] },
    { code: 356, indent: 0, parameters: ['ShowPicture 森の入口'] },
    { code: 111, indent: 0, parameters: [12, '$gameParty.leader().name() == "アリス"'] },
    { code: 0, indent: 0, parameters: [] },
  ] }] }] });
  w('CommonEvents', [null, { id: 1, name: '共通', list: [{ code: 405, indent: 0, parameters: ['昔々、ある村に…'] }, { code: 0, indent: 0, parameters: [] }] }]);
  fs.writeFileSync(path.join(js, 'plugins.js'), 'var $plugins = [{"name":"Quest","status":true,"parameters":{"Title":"冒険"}}];');
  return { data };
}

test('перевод: видимый текст — да; скрипты, заметки, команды плагинов, переключатели — нет; строки из кода защищены', () => {
  const { eachShown, codeStrings, makeGuard } = require('./src/utils/gametext.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const { data } = tlGame(root);
    const shown = [];
    const code = [];
    for (const f of fs.readdirSync(data)) {
      const v = JSON.parse(fs.readFileSync(path.join(data, f), 'utf8'));
      eachShown(f.slice(0, -5), v, (s) => shown.push(s));
      codeStrings(f.slice(0, -5), v, code);
    }
    for (const s of ['\\N[1]、こんにちは！\\!元気？', 'はい', 'いいえ', 'よかった。', '昔々、ある村に…', '森の入口', 'ポーション', '剣士', '戦う', '%1の勝利！', '炎', 'アリス']) {
      assert.ok(shown.includes(s), `видимое: ${s}`);
    }
    for (const s of ['イベント済み', '好感度', 'EV001', '共通', 'Actor1', 'ゲーム']) assert.ok(!shown.includes(s), `не видимое: ${s}`);
    const guard = makeGuard({ scripts: code, plugins: fs.readFileSync(path.join(root, 'G', 'www', 'js', 'plugins.js'), 'utf8') });
    assert.ok(guard('ボブ'), 'имя из скрипта (355) и заметки — защищено');
    assert.ok(guard('アリス'), 'имя из условия (111) — защищено');
    assert.ok(guard('ハイポーション'), 'предмет из заметки другого предмета — защищён');
    assert.ok(guard('森の入口'), 'строка из команды плагина — защищена');
    assert.ok(!guard('冒険'), 'подпись из параметра плагина («Title») — видимый текст, переводится');
    assert.ok(!guard('ポーション'), 'часть чужого значения («ハイポーション») — не повод не переводить');
    assert.ok(!guard('よかった。') && !guard('はい'), 'обычная реплика и вариант ответа — не защищены');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('перевод: коды игры переводчик не видит; потерял или повторил код — строка остаётся оригинальной', () => {
  const { protect, restore } = require('./src/utils/gametext.js');
  const p = protect('\\N[1]、こんにちは！\\!元気？\\C[2]50\\C[0]G <WordWrap> %1');
  assert.strictEqual(p.codes.join(' '), '\\N[1] \\! \\C[2] \\C[0] <WordWrap> %1');
  assert.ok(!/\\|%1|WordWrap/.test(p.text), p.text);
  // Служба вернула метки с пробелами вокруг — коды на месте, лишних пробелов у кодов нет
  const back = restore('<x i="0"/>, hello! <x i="1"/> How are you? <x i="2"/>50<x i="3"/>G <x i="4"/> <x i="5"/>', p.codes);
  assert.strictEqual(back, '\\N[1], hello! \\! How are you? \\C[2]50\\C[0]G <WordWrap> %1');
  // В японском пробелов нет, и служба оставляет метку вплотную к словам: «единственная\\C[5]дочь» на экране
  // слиплось бы — перед кодом между буквами ставится пробел, у перевода строки — нет
  const glued = protect('一人娘\\C[5]マーベル\\C[0]よ\nはい');
  assert.strictEqual(restore('единственная<x i="0"/>дочь<x i="1"/>Мэйбл<x i="2"/>да', glued.codes), 'единственная \\C[5]дочь \\C[0]Мэйбл\nда');
  const one = (src, out) => restore(out, protect(src).codes);
  assert.strictEqual(one('あ\\C[2]\\I[5]い', 'а<x i="0"/><x i="1"/>б'), 'а \\C[2]\\I[5]б', 'серия кодов — один пробел перед ней');
  assert.strictEqual(one('あ\\C[2]い', 'а <x i="0"/>б'), 'а \\C[2]б', 'пробел уже есть — второй не ставим');
  assert.strictEqual(one('あ\\.\\.い', 'Н<x i="0"/><x i="1"/>ет'), 'Н\\.\\.ет', 'паузу внутри слова не разрываем');
  assert.strictEqual(one('アリス\\C[2]は', 'アリス<x i="0"/>は'), 'アリス\\C[2]は', 'между японскими буквами пробелов нет');
  assert.strictEqual(restore('hello <x i="0"/> <x i="1"/>', p.codes), null, 'потеряны коды');
  assert.strictEqual(restore('<x i="0"/><x i="0"/><x i="1"/><x i="2"/><x i="3"/><x i="4"/><x i="5"/>', p.codes), null, 'код повторён');
  assert.strictEqual(restore('<x i="9"/>', protect('\\C[1]').codes), null, 'чужой код');
  // Перевод строки внутри описания — тоже код: остаётся на своём месте
  const d = protect('村の剣士。\nよろしく。');
  assert.strictEqual(restore('Village swordswoman.<x i="0"/>Nice to meet you.', d.codes), 'Village swordswoman.\nNice to meet you.');
  // Google и Microsoft закрывают метку отдельным тегом
  assert.strictEqual(restore('A <x i="0"></x>B', protect('A\\!B').codes), 'A \\!B');  // Строка из одних кодов — не текст: переводить нечего
  const { isText } = require('./src/utils/gametext.js');
  assert.ok(!isText('\\V[7]') && !isText('\\I[64]\\C[2]') && isText('\\C[2]Alice'));
});

test('перевод игры: пачками через первую службу, лимит кончился — следующая; плохой перевод — оригинал; данные игры меняются только в тексте', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService, QuotaError } = require('./src/services/translate.js');
  const secrets = require('./src/utils/secrets.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-job-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { data } = tlGame(root);
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  secrets.setSavedSecret('deepl', 'k:fx');
  secrets.setSavedSecret('microsoft', 'key|westeurope');
  t.after(() => { secrets.setSavedSecret('deepl', ''); secrets.setSavedSecret('microsoft', ''); });

  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  svc.retryMs = 0;
  const asked = [];
  // «Перевод»: [EN] перед текстом, метки кодов — как есть. DeepL после первой пачки упирается в лимит;
  // строку «よかった。» Microsoft портит — теряет метку не может (в ней нет кодов), а вот у реплики с кодами — теряет
  const fake = (name) => async (texts) => {
    asked.push([name, texts.length]);
    return texts.map((s) => (s.includes('こんにちは') && name === 'microsoft' ? 'Hello!' : `[EN] ${s}`));
  };
  let deeplCalls = 0;
  svc.engines = {
    deepl: async (texts, lang, key) => { if (++deeplCalls > 1) throw new QuotaError('limit'); return fake('deepl')(texts, lang, key); },
    microsoft: fake('microsoft'),
  };
  // Пачки по 3 строки — видно смену службы
  const { BATCH } = require('./src/services/translate.js');
  const prevBatch = JSON.parse(JSON.stringify(BATCH));
  BATCH.deepl.lines = 3;
  BATCH.microsoft.lines = 3;
  t.after(() => Object.assign(BATCH, prevBatch));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  await svc.setLang('G', 'en');
  await svc.running;
  const st = await svc.status('G');
  assert.strictEqual(st.state, 'done');
  assert.ok(st.done === st.total && st.total > 10, JSON.stringify(st));
  assert.deepStrictEqual(asked[0], ['deepl', 3], 'первая пачка — DeepL');
  assert.ok(asked.slice(1).every(([n]) => n === 'microsoft'), 'DeepL упёрся в лимит — дальше Microsoft: ' + JSON.stringify(asked));
  assert.strictEqual(st.failed, 1, 'реплику, у которой Microsoft потерял коды, не записали');
  assert.strictEqual((await db.get("SELECT value FROM settings WHERE key LIKE 'tl_exhausted_deepl'")).value, new Date().toISOString().slice(0, 7), 'DeepL до конца месяца не спрашиваем');

  // Подстановка: тот же JSON, только видимый текст переведён; защищённое и код — байт в байт
  const before = JSON.parse(fs.readFileSync(path.join(data, 'Map001.json'), 'utf8'));
  const out = JSON.parse(await svc.overlay('G', 'Map001', fs.readFileSync(path.join(data, 'Map001.json'))));
  const list = out.events[1].pages[0].list;
  const was = before.events[1].pages[0].list;
  assert.strictEqual(list[0].parameters[4], 'アリス', 'имя говорящего — защищено (с ним сравнивает условие)');
  assert.deepStrictEqual(list[2].parameters[0], ['[EN] はい', '[EN] いいえ']);
  assert.strictEqual(list[4].parameters[0], '[EN] よかった。');
  assert.deepStrictEqual([list[5], list[6], list[7]], [was[5], was[6], was[7]], 'скрипт, команда плагина, условие — как были');
  assert.strictEqual(out.displayName, '森の入口', 'имя карты из команды плагина — защищено');
  // Всё, кроме строк, — то же: числа, коды команд, отступы
  const shape = (v) => (Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v === 'string' ? 's' : v);
  assert.deepStrictEqual(shape(out), shape(before));
  // Реплика с кодами: служба потеряла коды — в игре оригинал, а не сломанная строка
  assert.strictEqual(list[1].parameters[0], was[1].parameters[0]);
  // Остальные файлы: заметки и настройки системы не тронуты
  const sys = JSON.parse(await svc.overlay('G', 'System', fs.readFileSync(path.join(data, 'System.json'))));
  assert.deepStrictEqual([sys.switches, sys.variables, sys.gameTitle], [['', 'イベント済み'], ['', '好感度'], 'ゲーム']);
  assert.strictEqual(sys.terms.messages.victory, '[EN] %1の勝利！');
  const items = JSON.parse(await svc.overlay('G', 'Items', fs.readFileSync(path.join(data, 'Items.json'))));
  assert.deepStrictEqual([items[1].note, items[2].name], ['<Upgrade:ハイポーション>', 'ハイポーション'], 'предмет, на который ссылается заметка, — защищён');
  assert.strictEqual(items[1].description, '[EN] HPを\\C[2]50\\C[0]回復する。');
  // Выключили — подстановки нет: игра получает оригинал
  await svc.setLang('G', '');
  assert.strictEqual(await svc.overlay('G', 'Map001', fs.readFileSync(path.join(data, 'Map001.json'))), null);
});

test('импорт готового перевода: JSON «оригинал → перевод» (MTool), массив пар, CSV; строки с другими кодами — нет', () => {
  const { parseImport } = require('./src/services/translate.js');
  assert.deepStrictEqual(parseImport('{"はい":"Yes","いいえ":"","\\\\C[2]赤":"\\\\C[2]Red"}'), [['はい', 'Yes'], ['\\C[2]赤', '\\C[2]Red']], 'пустой перевод — не перевод');
  assert.deepStrictEqual(parseImport('[["はい","Yes"],["x"]]'), [['はい', 'Yes']]);
  assert.deepStrictEqual(parseImport('﻿はい,Yes\r\n"こんにちは、世界","Hello, ""world"""\n'), [['はい', 'Yes'], ['こんにちは、世界', 'Hello, "world"']]);
});

test('проверка перевода: слипание находится и исправляется, ложных находок нет; размеры экрана — из данных игры', () => {
  const { glued, layoutOf, checkGame, textWidth } = require('./src/utils/tlcheck.js');
  assert.deepStrictEqual(glued('единственная\\C[5]дочь'), { kind: 'code', fix: 'единственная \\C[5]дочь' });
  assert.deepStrictEqual(glued('дело.Её зовут'), { kind: 'punct', fix: 'дело. Её зовут' });
  assert.deepStrictEqual(glued('единственнаяФон'), { kind: 'case', fix: 'единственная Фон' });
  assert.deepStrictEqual(glued('Mabelфон', 'マーベル'), { kind: 'script' });
  // Не слипание: сокращение, код в начале, латинское имя, пауза внутри слова, смесь из оригинала
  for (const ok of ['т.е. Иван', '\\C[2]Алиса', 'iPhone ок', 'Hello. World', 'Н\\.\\.\\.ет', 'Всё хорошо']) assert.strictEqual(glued(ok), null, ok);
  assert.strictEqual(glued('Нет \\I[1]адоаｄ', 'いやです\\I[1]あどあｄ'), null, 'смесь букв была в оригинале');

  // MV: ширина экрана — из плагина, шрифт и поля — только из плагина ядра; MZ — из System.json
  const mv = layoutOf({}, 'var $plugins = [{"name":"YEP_CoreEngine","status":true,"parameters":{"Screen Width":"1100","Font Size":"30","Window Padding":"18"}},{"name":"Other","status":true,"parameters":{"Font Size":"12"}}];');
  assert.deepStrictEqual([mv.mz, mv.width, mv.font, mv.padding], [false, 1100, 30, 18]);
  assert.deepStrictEqual([layoutOf({}, '').width, layoutOf({}, '').font], [816, 28], 'без плагинов — стандартные MV');
  const mz = layoutOf({ advanced: { uiAreaWidth: 1280, fontSize: 36 } }, '');
  assert.deepStrictEqual([mz.mz, mz.width, mz.font], [true, 1280, 36]);
  assert.ok(textWidth('Привет', 28) > textWidth('Пр', 28) && textWidth('あ', 20) === 20, 'японские — во всю клетку');

  // Не влезает: только то, что игра не ужмёт сама. Длинное слово реплики — переносится по буквам
  const long = 'Очень длинное описание предмета, которое никак не помещается в две строки окна подсказки даже мелким шрифтом, потому что в нём слишком много слов и подробностей про то, что он делает и откуда взялся в этом мире';
  const files = [
    ['System', { currencyUnit: 'G' }],
    ['Actors', [null, { name: 'アリス', profile: '剣士' }]],
    ['Items', [null, { name: '薬', description: '回復する。' }, { name: '剣', description: '長い説明' }]],
    ['Map001', { events: [null, { pages: [{ list: [
      { code: 101, parameters: ['', 0, 0, 2] },
      { code: 401, parameters: ['うわぁああ'] },
      { code: 102, parameters: [['はい', 'いいえ']] },
    ] }] }] }],
  ];
  const dict = new Map([
    ['うわぁああ', 'У' + 'а'.repeat(120)],
    ['はい', 'Да'],
    ['いいえ', 'Нет, я не буду ни с кем сотрудничать и не пойду ни в одну из сторон этого огромного мира, пока не узнаю всю правду о том, что здесь произошло'],
    ['回復する。', 'Восстанавливает здоровье на пятьдесят единиц, если выпить сразу после боя.'],
    ['長い説明', long],
    ['剣士', 'Мечница'],
  ]);
  const issues = checkGame(files, dict, () => false, layoutOf({}, ''));
  assert.deepStrictEqual(issues.map((x) => [x.kind, x.src]).sort(), [['choice', 'いいえ'], ['description', '長い説明']]);
});

test('проверка перевода в сервисе: оценка перед включением, проверка игры, исправление слипания в словаре', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tlGame(root);
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  const svc = new TranslateService();
  const changed = [];
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root, onChange: (id) => changed.push(id) });

  // Ключей служб нет — тратить нечего: оценка без службы и лимита
  const est = await svc.estimate('G', 'ru');
  // Стандартные слова (戦う, 炎, 魔法…) — из словаря терминов, в службу не уходят
  assert.ok(est.todo > 10 && est.todo < est.total && est.chars > est.todo, JSON.stringify(est));
  assert.deepStrictEqual([est.engine, est.left], ['', null]);
  await assert.rejects(svc.estimate('G', 'xx'), /Такого языка нет/);
  await assert.rejects(svc.check('G'), /Перевод не включён/);

  await db.run("INSERT INTO game_translation (id, lang, state) VALUES ('G', 'ru', 'done')");
  await db.run("INSERT INTO translations (src, lang, text) VALUES ('HPを\\C[2]50\\C[0]回復する。', 'ru', 'Восстанавливает\\C[2]50\\C[0]HP.'), ('よかった。', 'ru', 'Хорошо.Пошли'), ('はい', 'ru', 'Да')");
  // Свой перевод (загружен файлом) тоже слипся — но его делал человек: показываем, сами не правим
  await db.run("INSERT INTO translations (src, lang, text, origin) VALUES ('いいえ', 'ru', 'Нет.Никогда', 'import')");
  svc.version++;                                    // запись мимо сервиса — словарь перечитать
  const before = await svc.check('G');
  assert.deepStrictEqual(before.counts, { code: 1, punct: 2 }, JSON.stringify(before.issues));
  assert.strictEqual(before.fixable, 2);
  assert.ok(!before.issues.find((x) => x.src === 'いいえ').fix);
  assert.strictEqual((await svc.estimate('G', 'ru')).todo, est.todo - 4, 'переведённое уже не считается');

  assert.deepStrictEqual(await svc.fix('G'), { fixed: 2 });
  assert.deepStrictEqual(changed, ['G'], 'игра получит исправленный текст со следующего запуска');
  const rows = await db.all("SELECT src, text FROM translations WHERE lang = 'ru' ORDER BY src");
  assert.deepStrictEqual(Object.fromEntries(rows.map((r) => [r.src, r.text])), {
    'HPを\\C[2]50\\C[0]回復する。': 'Восстанавливает \\C[2]50\\C[0]HP.', 'いいえ': 'Нет.Никогда', 'はい': 'Да', 'よかった。': 'Хорошо. Пошли',
  });
  assert.deepStrictEqual((await svc.check('G')).counts, { punct: 1 });
  assert.deepStrictEqual(await svc.fix('G'), { fixed: 0 }, 'второй раз исправлять нечего');
});

test('перевод интерфейса: подписи и подсказки из параметров плагинов, цель задания в переменной; файлы, звуки, ключи — нет', () => {
  const { pluginTexts, overlayPlugins, makeGuard, eachShown, codeStrings, displayText } = require('./src/utils/gametext.js');
  const { termOf } = require('./src/utils/glossary.js');
  // Меню как у LL_MenuScreenCustomMV: список структур в строке JSON; рядом — картинка, звук, переключатель
  const help = JSON.stringify([JSON.stringify({ symbol: 'アイテム', helpText: '入手したアイテムを使用します。' })]);
  const src = `// шапка
var $plugins =
${JSON.stringify([
    { name: 'Menu', status: true, parameters: { menuHelpTexts: help, leftBlockLabel: '現在地：', 'ピクチャ1': 'わく', fileName: 'あみ', 'Switch': '開始', 'Command Name': 'Load', 'テキスト1': '堕落度', 'Name': '画像名' } },
    { name: 'Off', status: false, parameters: { 'Help Text': '使わない' } },
  ])};
`;
  assert.deepStrictEqual(pluginTexts(src).sort(), ['アイテム', '入手したアイテムを使用します。', '現在地：', '堕落度', '画像名'].sort());
  // Картинки, файлы, переключатели — защищены (имя файла игры в подписи — это решает сервис: tl-terms ниже)
  const guard = makeGuard({ plugins: src });
  assert.ok(guard('わく') && guard('あみ') && guard('開始'), 'картинки, файлы, переключатели — защищены');
  const dict = new Map([['アイテム', 'Предметы'], ['入手したアイテムを使用します。', 'Использовать предмет…'], ['現在地：', 'Где я:'], ['わく', 'Рамка']]);
  const out = overlayPlugins(src, (s) => (guard(s) ? undefined : dict.get(s)));
  assert.ok(out.startsWith('// шапка\nvar $plugins =\n'), 'остальной файл — как был');
  const list = JSON.parse(out.match(/\$plugins =\n(\[[\s\S]*\]);/)[1]);
  const menu = list[0].parameters;
  assert.deepStrictEqual(JSON.parse(JSON.parse(menu.menuHelpTexts)[0]), { symbol: 'Предметы', helpText: 'Использовать предмет…' }, 'вложенный JSON — снова строкой, как ждёт плагин');
  assert.deepStrictEqual([menu.leftBlockLabel, menu['ピクチャ1'], menu.fileName], ['Где я:', 'わく', 'あみ']);
  assert.strictEqual(list[1].parameters['Help Text'], '使わない', 'выключенный плагин не трогаем');
  assert.strictEqual(overlayPlugins(src, () => undefined), null, 'нечего переводить — оригинал');

  // Комментарии плагина (справка) не защищают; строка = имя параметра — чтение параметра; стандартное слово
  // меню кодом плагина не защищается, если так сказано (exempt)
  const plugin = "/*:\n * @param 常時ダッシュ\n * @default ゲーム終了\n */\nvar p = getParam(['AlwaysDash', '常時ダッシュ']); if (type === 'アイテム') {}\n";
  const params = 'var $plugins = [{"name":"Cfg","status":true,"parameters":{"常時ダッシュ":"true"}}];';
  const g2 = makeGuard({ plugins: params, pluginFiles: [plugin], exempt: (s) => !!termOf(s, 'en') });
  assert.ok(!g2('ゲーム終了') && !g2('常時ダッシュ') && !g2('アイテム'));
  assert.ok(makeGuard({ pluginFiles: [plugin] })('アイテム'), 'без exempt — защищено, как раньше');
  assert.ok(makeGuard({ scripts: ["if (x === 'アイテム') {}"], exempt: () => true })('アイテム'), 'скрипт события защищает и стандартное слово');

  // Цель задания: «переменная = 'текст'» — видимый текст; в кавычках перевод экранируется
  const map = { events: [null, { pages: [{ list: [
    { code: 122, parameters: [4, 4, 0, 4, "'北部防衛隊詰所へ'"] },
    { code: 122, parameters: [5, 5, 0, 4, '$gameVariables.value(4) + 1'] },
    { code: 0, parameters: [] },
  ] }] }] };
  const shown = [];
  eachShown('Map001', map, (v, set) => { shown.push(v); set("К посту 'Север'"); });
  assert.deepStrictEqual(shown, ['北部防衛隊詰所へ']);
  assert.strictEqual(map.events[1].pages[0].list[0].parameters[4], "'К посту \\'Север\\''");
  assert.strictEqual(map.events[1].pages[0].list[1].parameters[4], '$gameVariables.value(4) + 1', 'скрипт — как был');
  // Перевод строки в переводе — экранирован: иначе скрипт события не разберётся и игра упадёт
  const m2 = { events: [null, { pages: [{ list: [{ code: 122, parameters: [4, 4, 0, 4, '"北へ"'] }, { code: 122, parameters: [5, 5, 0, 4, "'door_open'"] }] }] }] };
  const seen2 = [];
  eachShown('Map001', m2, (v, set) => { seen2.push(v); set('На\nсевер "сейчас"\u2028'); });
  assert.deepStrictEqual(seen2, ['北へ'], 'латиница в кавычках — ключ, не текст');
  const lit = m2.events[1].pages[0].list[0].parameters[4];
  assert.strictEqual(eval(lit), 'На\nсевер "сейчас"\u2028');
  assert.ok(!/[\n\u2028]/.test(lit));
  // Имя события и общего события плагин ищет как есть — не переводим
  assert.deepStrictEqual(pluginTexts('var $plugins = [{"name":"P","status":true,"parameters":{"Event Name":"宝箱","Common Event Name":"回復","Map Name":"森"}}];'), []);
  const code = [];
  codeStrings('Map001', { events: [null, { pages: [{ list: [{ code: 122, parameters: [4, 4, 0, 4, "'北へ'"] }, { code: 108, parameters: ['<選択肢ヘルプ>'] }] }] }] }, code);
  assert.deepStrictEqual(code, ['<選択肢ヘルプ>'], 'текст в кавычках — не код; комментарий события — код');

  // Стандартные слова — по одному образцу, «ＨＰ» и «HP» — одно; троеточие — обычными точками
  assert.deepStrictEqual([termOf('最大ＨＰ', 'ru'), termOf('最大HP', 'en'), termOf('攻撃力', 'de'), termOf('BGM音量', 'ru'), termOf('勇者', 'ru')], ['Макс. HP', 'Max HP', 'Angriff', 'Громкость музыки', undefined]);
  assert.strictEqual(displayText('То есть… Ну・・・ да‥'), 'То есть... Ну... да..');
});

test('перевод: стандартные слова — из словаря терминов поверх машинного, свой перевод главнее; новые строки игры — «на паузе»', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-terms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { data } = tlGame(root);
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  t.mock.method(console, 'log', () => {});
  await db.run("INSERT INTO translations (src, lang, text) VALUES ('戦う', 'ru', 'Бороться')");
  await db.run("INSERT INTO translations (src, lang, text, origin) VALUES ('逃げる', 'ru', 'Удрать', 'import')");
  const text = await svc.gameText('G');
  await svc.applyTerms(text.strings, 'ru');
  const rows = Object.fromEntries((await db.all("SELECT src, text, origin FROM translations WHERE lang = 'ru'")).map((r) => [r.src, [r.text, r.origin]]));
  assert.deepStrictEqual(rows['戦う'], ['Сражаться', 'glossary'], 'машинный перевод термина — заменён образцом');
  assert.deepStrictEqual(rows['逃げる'], ['Удрать', 'import'], 'свой перевод — не трогаем');
  assert.deepStrictEqual(rows['炎'], ['Огонь', 'glossary']);
  assert.strictEqual(await svc.applyTerms(text.strings, 'ru'), 0, 'второй раз менять нечего');

  // Подписи плагинов попадают в текст игры; plugins.js отдаётся с переводом
  assert.ok(text.strings.includes('冒険'), 'Title из параметров плагина');
  // Картинка с именем, как у реплики: реплика переводится, параметр-ссылка на картинку — нет
  fs.mkdirSync(path.join(root, 'G', 'www', 'img', 'pictures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'G', 'www', 'img', 'pictures', 'よかった。.png'), '');
  fs.writeFileSync(path.join(root, 'G', 'www', 'js', 'plugins.js'), 'var $plugins = [{"name":"Quest","status":true,"parameters":{"Title":"冒険","Help Text":"よかった。"}}];');
  svc.cache.clear();
  const text2 = await svc.gameText('G');
  assert.ok(text2.strings.includes('よかった。'), 'реплика с текстом, как имя картинки, — переводится');
  await db.run("INSERT INTO translations (src, lang, text) VALUES ('よかった。', 'ru', 'Хорошо.')");
  await db.run("INSERT INTO game_translation (id, lang, state, done, total) VALUES ('G', 'ru', 'done', ?, ?)", [text.all.length, text.all.length]);
  await db.run("INSERT INTO translations (src, lang, text) VALUES ('冒険', 'ru', 'Приключение…')");
  svc.version++;
  const js = await svc.overlayPlugins('G', fs.readFileSync(path.join(root, 'G', 'www', 'js', 'plugins.js'), 'utf8'));
  assert.match(js, /"Title":"Приключение\.\.\."/);
  assert.match(js, /"Help Text":"よかった。"/, 'параметр, равный имени картинки, — как был');
  assert.strictEqual((await svc.status('G')).state, 'done');
  // Игру обновили — строк стало больше: «на паузе», «Продолжить» переведёт новое
  const map = JSON.parse(fs.readFileSync(path.join(data, 'Map001.json'), 'utf8'));
  map.events[1].pages[0].list.splice(1, 0, { code: 401, indent: 0, parameters: ['新しい台詞'] });
  fs.writeFileSync(path.join(data, 'Map001.json'), JSON.stringify(map));
  svc.cache.clear();
  const st = await svc.status('G');
  assert.deepStrictEqual([st.state, st.total], ['paused', text.all.length + 1]);
});

test('словарь терминов из переведённых игр: голоса по местам в System.json, явное большинство — главнее встроенного', async (t) => {
  const { TermLibrary, languageOf } = require('./src/services/termlib.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termlib-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const JA = ['戦う', '逃げる', '攻撃', '防御', 'アイテム', 'スキル', '装備', 'ステータス', '並び替え', 'セーブ', 'ゲーム終了', 'オプション'];
  const game = (name, commands, params = [], messages = {}, www = false) => {
    const dir = path.join(root, name, ...(www ? ['www'] : []), 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'System.json'), '﻿' + JSON.stringify({ terms: { commands, params, basic: [], messages } }));
  };
  const ru = (flee, opt) => ['Бой', flee, 'Атака', 'Защита', 'Предметы', 'Навыки', 'Экипировка', 'Статус', 'Порядок', 'Сохранить', 'Выйти', opt];
  game('R1', ru('Побег', 'Параметры'), ['Макс. HP', 'Макс. MP', '\\I[5]Атака'], { alwaysDash: 'Всегда бежать' });
  game('R2', ru('Побег', 'Параметры'), ['Макс. HP', 'MaxMP', 'Сила атаки'], { alwaysDash: 'Всегда бежать' }, true);
  game('R3', ru('побег', 'Настройки'), ['Макс. HP', '', 'Атака'], { alwaysDash: 'всегда бежать' });
  game('R4', ru('Бежать', 'Параметры'), ['Макс. HP', '', 'Атака'], { alwaysDash: '{dash}' });
  game('J1', JA);                                            // японская — не считается
  game('E1', ['Fight', 'Escape', 'Attack', 'Guard', 'Item', 'Skill', 'Equip', 'Status', 'Formation', 'Save', 'Game End', 'Options']);
  // Необычные System.json: команды строкой, пустой файл — не ломают подсчёт; французская — не английская
  fs.mkdirSync(path.join(root, 'Odd', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Odd', 'data', 'System.json'), JSON.stringify({ terms: { commands: 'Fight', params: {} } }));
  fs.mkdirSync(path.join(root, 'Empty', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Empty', 'data', 'System.json'), '');
  game('F1', ['Combattre', 'Fuir', 'Attaquer', 'Défendre', 'Objets', 'Compétences', 'Équiper', 'Statut', 'Formation', 'Sauver', 'Quitter', 'Options']);
  fs.mkdirSync(path.join(root, '_old', 'X', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, '_old', 'X', 'data', 'System.json'), JSON.stringify({ terms: { commands: ru('Удрать', 'Опции') } }));
  assert.deepStrictEqual([languageOf(ru('Побег', 'Опции')), languageOf(JA), languageOf(['Kämpfen', 'Fliehen', 'Angriff', 'Abwehr', 'Gegenstände', 'Fähigkeiten', 'Ausrüstung', 'Status'])], ['ru', null, 'de']);

  const lib = new TermLibrary();
  lib.setDir(root);
  const l = await lib.load();
  assert.deepStrictEqual([l.langs.ru.games, l.langs.en.games, l.langs.de.games], [4, 1, 0]);
  const ruTerms = Object.fromEntries([...l.langs.ru.terms.values()].map((x) => [x.ja, [x.text, x.votes, x.total]]));
  // «побег» и «Побег» — один голос, пишется частый вариант; код значка \I[5] — не часть слова
  assert.deepStrictEqual(ruTerms['逃げる'], ['Побег', 3, 4]);
  assert.deepStrictEqual(ruTerms['攻撃力'], ['Атака', 3, 4]);
  assert.deepStrictEqual(ruTerms['最大HP'], ['Макс. HP', 4, 4]);
  assert.deepStrictEqual(ruTerms['常時ダッシュ'], ['Всегда бежать', 3, 3], 'заготовка {dash} не голосует');
  assert.deepStrictEqual(ruTerms['オプション'], ['Параметры', 3, 4]);
  assert.ok(!ruTerms['最大MP'], 'одна игра (латиница в русской не считается) — мало голосов');
  assert.ok(!l.langs.en.terms.size, 'одна английская игра — меньше 3 голосов');

  // Сервис: термин из библиотеки — поверх встроенного («Бежать» → «Побег»), встроенный — где голосов мало
  const { TranslateService } = require('./src/services/translate.js');
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  await svc.applyTerms(['逃げる', '最大MP', '勇者'], 'ru');
  const rows = Object.fromEntries((await db.all('SELECT src, text FROM translations')).map((r) => [r.src, r.text]));
  assert.deepStrictEqual(rows, { '逃げる': 'Побег', '最大MP': 'Макс. MP' });
  const report = await svc.termsReport();
  assert.deepStrictEqual(report.games, { en: 1, ru: 4, de: 0 });
  const flee = report.terms.find((r) => r.ja === '逃げる');
  assert.deepStrictEqual([flee.ru, flee.en], [{ text: 'Побег', votes: 3, total: 4 }, { text: 'Escape' }]);
});

test('глоссарий DeepL: имена героев — первой пачкой, потом глоссарий из имён и характеристик; английские вставки — без него', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService, BATCH, sourceOf } = require('./src/services/translate.js');
  const secrets = require('./src/utils/secrets.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-gloss-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { data } = tlGame(root);
  // Героиня, имя которой нигде в коде нет (переводится), и английская строка в японской игре
  const actors = JSON.parse(fs.readFileSync(path.join(data, 'Actors.json'), 'utf8'));
  actors.push({ id: 3, name: 'クレア', nickname: '', profile: '', note: '', characterName: '', faceName: '' });
  fs.writeFileSync(path.join(data, 'Actors.json'), JSON.stringify(actors));
  const map = JSON.parse(fs.readFileSync(path.join(data, 'Map001.json'), 'utf8'));
  map.events[1].pages[0].list.splice(1, 0, { code: 401, indent: 0, parameters: ['Game Over'] });
  fs.writeFileSync(path.join(data, 'Map001.json'), JSON.stringify(map));
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  secrets.setSavedSecret('deepl', 'k:fx');
  t.after(() => secrets.setSavedSecret('deepl', ''));
  const prev = JSON.parse(JSON.stringify(BATCH));
  BATCH.deepl.lines = 4;
  t.after(() => Object.assign(BATCH, prev));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  const run = async (createFails) => {
    await db.exec('DELETE FROM translations; DELETE FROM game_translation');
    const svc = new TranslateService();
    svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
    svc.retryMs = 0;
    const calls = [];
    const made = [];
    const removed = [];
    svc.engines = { deepl: async (texts, lang, key, opts) => { calls.push([texts.slice(), opts || null]); return texts.map((x) => (x === 'クレア' ? 'Клэр' : `[RU] ${x}`)); } };
    svc.glossaries = {
      create: async (key, source, target, entries) => { if (createFails) throw new Error('DeepL: глоссарий не создан (400)'); made.push([source, target, entries]); return 'g1'; },
      remove: async (key, id) => { removed.push(id); },
    };
    await svc.setLang('G', 'ru');
    await svc.running;
    return { svc, calls, made, removed };
  };

  assert.strictEqual(sourceOf(['こんにちは', 'Game Over']), 'ja');
  const { svc, calls, made, removed } = await run(false);
  assert.strictEqual((await svc.status('G')).state, 'done');
  // Первая пачка — только имя героини и без глоссария (его ещё не из чего делать); アリス и ボブ стоят в
  // скриптах — защищены и не переводятся
  assert.deepStrictEqual(calls[0], [['クレア'], null]);
  assert.deepStrictEqual(made.map(([s, l]) => [s, l]), [['ja', 'ru']]);
  const entries = Object.fromEntries(made[0][2]);
  assert.strictEqual(entries['クレア'], 'Клэр', 'имя — как его перевели');
  assert.strictEqual(entries['最大HP'], 'Макс. HP', 'характеристика — в глоссарии');
  assert.ok(!('炎' in entries) && !('攻撃' in entries), 'короткие общие слова — нет');
  // Строки с японским — с глоссарием, «Game Over» — отдельным запросом без него
  const withG = calls.slice(1).filter(([, o]) => o);
  const without = calls.slice(1).filter(([, o]) => !o);
  assert.ok(withG.length && withG.every(([, o]) => o.glossary === 'g1' && o.source === 'ja'));
  const plain = without.flatMap(([x]) => x);
  assert.ok(plain.includes('Game Over') && plain.every((x) => !/[\u3040-\u30ff\u4e00-\u9fff]/.test(x)), JSON.stringify(plain));
  assert.ok(withG.flatMap(([x]) => x).every((x) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(x)));
  assert.deepStrictEqual(removed, ['g1'], 'после перевода глоссарий удалён');

  // Глоссарий не создался — переводим без него, перевод не останавливается
  const r2 = await run(true);
  // DeepL отказал в переводе с глоссарием (не лимит) — пачка повторяется без глоссария, перевод доходит до конца
  {
    await db.exec('DELETE FROM translations; DELETE FROM game_translation');
    const svc3 = new TranslateService();
    svc3.setDependencies({ dbService: { get: () => db }, gamesDir: root });
    svc3.retryMs = 0;
    const calls3 = [];
    const removed3 = [];
    svc3.engines = { deepl: async (texts, lang, key, opts) => {
      calls3.push(!!opts);
      if (opts) throw new Error('DeepL ответил 400');
      return texts.map((x) => `[RU] ${x}`);
    } };
    svc3.glossaries = { create: async () => 'g3', remove: async (k, id) => { removed3.push(id); } };
    await svc3.setLang('G', 'ru');
    await svc3.running;
    const st3 = await svc3.status('G');
    assert.deepStrictEqual([st3.state, st3.done === st3.total], ['done', true]);
    assert.deepStrictEqual(calls3.filter(Boolean).length, 1, 'с глоссарием — одна попытка');
    assert.deepStrictEqual(removed3, ['g3']);
  }
  assert.strictEqual((await r2.svc.status('G')).state, 'done');
  assert.ok(r2.calls.every(([, o]) => !o));
  assert.deepStrictEqual(r2.removed, []);
});

test('поиск данных: шаги — сразу, как сделаны; кредиты ScraperAPI — в журнал по сайтам', async (t) => {
  const { lookupRun, newRun, noteStep, noteCredits, journalOf } = require('./src/utils/lookuprun.js');
  const scraper = require('./src/services/scraper.js');
  const { redisClient } = require('./src/utils/cache.js');
  const seen = [];
  const run = newRun((step) => { seen.push(step.site); if (step.site === 'bad') throw new Error('показ упал'); });
  const prev = process.env.SCRAPER_API_KEY;
  process.env.SCRAPER_API_KEY = 'test';
  t.after(() => { if (prev === undefined) delete process.env.SCRAPER_API_KEY; else process.env.SCRAPER_API_KEY = prev; });
  t.mock.method(redisClient, 'get', async () => '0');
  t.mock.method(redisClient, 'incrBy', async (key, n) => n);
  t.mock.method(redisClient, 'expire', async () => true);
  t.mock.method(globalThis, 'fetch', async (input) => ({ ok: true, status: 200, headers: new Headers({ 'sa-credit-cost': decodeURIComponent(String(input)).includes('itch.io') ? '10' : '1' }), text: async () => 'page' }));
  await lookupRun.run(run, async () => {
    noteStep({ site: 'itch', by: 'link', q: 'Game', result: 'found', link: 'https://moon-studio.itch.io/game' });
    noteStep({ site: 'bad', by: 'title', q: 'x', result: 'none' });   // показ вживую упал — поиск идёт дальше
    noteStep({ site: 'steam', by: 'title', q: 'Game', result: 'none' });
    await scraper.fetchViaScraper('https://moon-studio.itch.io/game');
    await scraper.fetchViaScraper('https://tidewater.itch.io/other');
    noteCredits('https://store.steampowered.com/app/100', 1);
  });
  assert.deepStrictEqual(seen, ['itch', 'bad', 'steam']);
  const journal = journalOf(run);
  assert.strictEqual(journal.steps.length, 3);
  assert.deepStrictEqual(journal.credits, { itch: 20, steam: 1 });
  assert.ok(!('credits' in journalOf(newRun())), 'кредитов не тратили — строки о них нет');
});

test('поиск данных: запрос к сайту — с тайм-аутом; тело не дочиталось или не JSON — «сайт не ответил», а не «игры нет»', async (t) => {
  const { lookupRun, newRun } = require('./src/utils/lookuprun.js');
  const { sourceFetch } = require('./src/services/scraper.js');
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (input, opts) => {
    signals.push(opts?.signal);
    const url = String(input);
    return { ok: true, status: 200, text: async () => 'ok', json: async () => (url.includes('steam') ? JSON.parse('<html>') : { results: [] }) };
  });
  const run = newRun();
  await lookupRun.run(run, async () => {
    assert.deepStrictEqual(await (await sourceFetch('https://api.vndb.org/kana/vn', { method: 'POST' })).json(), { results: [] });
    await assert.rejects((await sourceFetch('https://store.steampowered.com/api/storesearch/?term=x')).json());
    const own = AbortSignal.timeout(5000);
    await sourceFetch('https://store.steampowered.com/api/appdetails', { signal: own });
    assert.strictEqual(signals[2], own, 'свой тайм-аут вызова — главнее');
  });
  assert.ok(signals[0] && signals[1], 'без своего — общий');
  assert.deepStrictEqual([...run.failed], ['store.steampowered.com']);
});

test('очередь поиска: попросили сами — первыми и даже на паузе; пауза переживает перезапуск; что ищется и что дальше', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const scraper = require('./src/services/scraper.js');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.exec('CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, ready INTEGER, meta_retry_at INTEGER, meta_attempts INTEGER DEFAULT 0)');
  const far = Date.now() + 86400000;
  await db.run("INSERT INTO games (id, title, ready, meta_retry_at) VALUES ('A', 'Alpha', 1, 100), ('B', 'Beta', 1, 200), ('C', 'Gamma', 1, 300), ('D', 'Delta', 1, ?), ('E', 'Eps', 0, 50)", [far]);
  const prev = { db: scraper.dbService, io: scraper.io, paused: scraper.paused, live: scraper.live };
  const events = [];
  scraper.dbService = { get: () => db };
  scraper.io = { emit: (name, data) => events.push([name, data]) };
  t.after(() => { Object.assign(scraper, { dbService: prev.db, io: prev.io, paused: prev.paused, live: prev.live }); scraper.priority.clear(); });
  t.mock.method(scraper, 'processBackgroundScrape', async () => {});
  scraper.priority.clear();
  scraper.paused = false;
  scraper.live = null;

  assert.strictEqual((await scraper.nextDue()).id, 'A', 'по сроку');
  await scraper.requestScrape(['C'], { priority: true });
  assert.strictEqual((await scraper.nextDue()).id, 'C', 'попросили сами — первой');
  await scraper.setPaused(true);
  assert.deepStrictEqual(events.at(-1), ['scrape-progress', { left: 3, paused: true }]);
  assert.strictEqual((await scraper.nextDue()).id, 'C', 'на паузе — только то, что попросили');
  scraper.priority.delete('C');
  assert.strictEqual(await scraper.nextDue(), null, 'на паузе остальные ждут');
  scraper.paused = false;
  await scraper.loadPaused();
  assert.strictEqual(scraper.paused, true, 'пауза — из базы, после перезапуска тоже');

  await scraper.requestScrape(['B'], { priority: true });
  scraper.live = { id: 'A', title: 'Alpha', startedAt: 1, steps: [{ site: 'steam', by: 'title', q: 'Alpha', result: 'none' }] };
  const q = await scraper.queueState();
  assert.deepStrictEqual([q.paused, q.left, q.current.id], [true, 2, 'A'], 'та, что ищется, уже не ждёт');
  assert.deepStrictEqual(q.next.map((g) => [g.id, g.first]), [['B', true], ['C', false]], 'сейчас ищется — не в «дальше»; попрошенные — первыми');
  await scraper.setPaused(false);
  assert.strictEqual(scraper.paused, false);
  assert.strictEqual((await db.get("SELECT value FROM settings WHERE key = 'lookup_paused'")).value, '0');
});

test('службы: остаток — у DeepL и ScraperAPI самих, у Microsoft и Google — счётчик библиотеки; ответ — из памяти 5 минут', async (t) => {
  const { QuotaService, nextRenewal } = require('./src/services/quota.js');
  const secrets = require('./src/utils/secrets.js');
  for (const [k, v] of [['deepl', 'k:fx'], ['scraper', 'abcdefghijklmnop1234'], ['microsoft', 'key|westeurope'], ['google', 'AIzaTest']]) secrets.setSavedSecret(k, v);
  const prevEnv = process.env.SCRAPER_API_KEY;
  delete process.env.SCRAPER_API_KEY;
  t.after(() => {
    for (const k of ['deepl', 'scraper', 'microsoft', 'google']) secrets.setSavedSecret(k, '');
    if (prevEnv !== undefined) process.env.SCRAPER_API_KEY = prevEnv;
  });
  const svc = new QuotaService();
  svc.setDependencies({
    translate: { FREE: { microsoft: 2000000, google: 500000 }, usage: async () => 1500, exhausted: async (e) => e === 'google' },
    scraper: { scraperDayState: async () => ({ used: 3, limit: 30 }) },
  });
  let calls = 0;
  let deeplStatus = 200;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    const u = String(url);
    if (u.includes('deepl')) return { ok: deeplStatus === 200, status: deeplStatus, json: async () => ({ character_count: 212948, character_limit: 1000000 }) };
    if (u.includes('scraperapi')) return { ok: true, status: 200, json: async () => ({ requestCount: 37, requestLimit: 1000, subscriptionDate: '2026-09-03T10:00:00Z' }) };
    throw new Error('не ждали ' + u);
  });
  const now = Date.UTC(2026, 9, 8, 12);
  const r = await svc.report({ now });
  const s = r.services;
  assert.deepStrictEqual([s.deepl.ok, s.deepl.left, s.deepl.limit, s.deepl.from], [true, 787052, 1000000, 'service']);
  assert.deepStrictEqual([s.scraper.left, s.scraper.resetAt, s.scraper.today], [963, Date.UTC(2026, 10, 3), { used: 3, limit: 30 }]);
  assert.deepStrictEqual([s.microsoft.left, s.microsoft.from, s.microsoft.resetAt], [1998500, 'local', Date.UTC(2026, 10, 1)]);
  assert.deepStrictEqual([s.google.left, s.google.exhausted], [0, true], 'лимит месяца кончился — служба об этом сказала');
  assert.strictEqual(s.libre.key, false);
  // Telegram без своей проверки в тесте — «отвечает ли» неизвестно, но не «не принял»
  assert.ok(s.telegram.ok !== false);
  const made = calls;
  await svc.report({ now: now + 60000 });
  assert.strictEqual(calls, made, 'через минуту — из памяти');
  deeplStatus = 403;
  assert.strictEqual((await svc.report({ fresh: true, now })).services.deepl.ok, false, 'не принял ключ');
  assert.strictEqual(nextRenewal('2026-01-31T00:00:00Z', Date.UTC(2026, 1, 10)), Date.UTC(2026, 1, 28), 'день подписки — не позже 28-го');
  // Ключ сменили, пока шёл запрос: его ответ (по старому ключу) в память не идёт
  deeplStatus = 200;
  let release;
  const gate = new Promise((r) => { release = r; });
  const prevFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...a) => { await gate; return prevFetch(...a); });
  const slow = svc.report({ fresh: true, now });
  svc.invalidate();
  release();
  await slow;
  assert.strictEqual(svc.cache, null);
});

test('перевести заново: машинный перевод — ещё раз, свой из файла и стандартные слова — нет; поиск строк; перевод файлом', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  const secrets = require('./src/utils/secrets.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-redo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tlGame(root);
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  secrets.setSavedSecret('deepl', 'k:fx');
  t.after(() => secrets.setSavedSecret('deepl', ''));
  t.mock.method(console, 'log', () => {});
  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  svc.retryMs = 0;
  const sent = [];
  svc.engines = { deepl: async (texts) => { sent.push(...texts); return texts.map((x) => `[NEW] ${x}`); } };
  svc.glossaries = { create: async () => 'g', remove: async () => {} };
  await db.run("INSERT INTO game_translation (id, lang, state) VALUES ('G', 'ru', 'done')");
  await db.run(`INSERT INTO translations (src, lang, text, origin) VALUES ('よかった。', 'ru', 'Хорошо.', 'machine'), ('はい', 'ru', 'Да', 'import'),
    ('戦う', 'ru', 'Сражаться', 'glossary'), ('いいえ', 'ru', '', 'failed')`);

  const all = await svc.redoSet((await svc.gameText('G')).strings, 'ru', 'all');
  assert.ok(all.has('よかった。') && all.has('いいえ') && !all.has('はい') && !all.has('戦う'));
  assert.strictEqual((await svc.redoSet(['よかった。'], 'ru', ['よかった。', 'не из игры'])).size, 1, 'чужие строки — нет');

  // Поиск строк: по переводу и по оригиналу, с отметкой, чей перевод
  const found = await svc.lines('G', 'хорош');
  assert.deepStrictEqual(found.items, [{ src: 'よかった。', text: 'Хорошо.', origin: 'machine' }]);
  assert.deepStrictEqual((await svc.lines('G', 'はい')).items.map((x) => x.origin), ['import']);

  // Заново — выбранные: машинная и не вышедшая — в службу, своя — нет
  const est = await svc.estimate('G', 'ru', ['よかった。', 'はい', 'いいえ']);
  assert.strictEqual(est.todo >= 2, true);
  await svc.redo('G', ['よかった。', 'はい', 'いいえ']);
  await svc.running;
  assert.ok(sent.includes('よかった。') && sent.includes('いいえ') && !sent.includes('はい'), JSON.stringify(sent));
  const rows = Object.fromEntries((await db.all("SELECT src, text, origin FROM translations WHERE lang = 'ru'")).map((r) => [r.src, [r.text, r.origin]]));
  assert.deepStrictEqual(rows['よかった。'], ['[NEW] よかった。', 'machine']);
  assert.deepStrictEqual(rows['いいえ'], ['[NEW] いいえ', 'machine'], 'не вышедшая раньше — теперь переведена');
  assert.deepStrictEqual(rows['はい'], ['Да', 'import']);
  await assert.rejects(svc.redo('G', 'не список'), /Нужен список строк/);

  // Шаблон: служба потеряла число — та же строка ещё раз, с метками; переведённые раньше шаблоны — один раз заново
  const map2 = JSON.parse(fs.readFileSync(path.join(root, 'G', 'www', 'data', 'Map001.json'), 'utf8'));
  map2.events[1].pages[0].list.splice(1, 0, { code: 401, indent: 0, parameters: ['%1日目の朝'] });
  fs.writeFileSync(path.join(root, 'G', 'www', 'data', 'Map001.json'), JSON.stringify(map2));
  svc.cache.clear();
  const asked = [];
  svc.engines = { deepl: async (texts) => { asked.push(...texts); return texts.map((x) => (/71/.test(x) ? 'Morning of the day' : x.replace('<x i="0"/>日目の朝', 'Morning of day <x i="0"/>'))); } };
  await svc.redo('G', ['%1日目の朝']);
  await svc.running;
  assert.deepStrictEqual(asked.filter((x) => x.includes('日目の朝')), ['71日目の朝', '<x i="0"/>日目の朝']);
  assert.strictEqual((await db.get("SELECT text FROM translations WHERE src = '%1日目の朝' AND lang = 'ru'")).text, 'Morning of day %1');
  assert.ok((await db.get("SELECT value FROM settings WHERE key = 'tl_numbers_v1_ru_G'"))?.value, 'шаблоны этой игры переведены числами — второй раз не переводим (у каждой игры — своя отметка)');

  // Файлом: все строки игры с переводом — как у MTool, и его же можно загрузить обратно
  const file = await svc.exportFile('G');
  assert.deepStrictEqual([file.lang, file.data['はい'], file.data['よかった。']], ['ru', 'Да', '[NEW] よかった。']);
  assert.ok(!('いいえX' in file.data));
  // «Перевести заново» ждёт в очереди — обычный запуск поверх него его не теряет, «всю игру» — поглощает строки
  const q = new TranslateService();
  q.running = new Promise(() => {});                 // очередь не разбирается — смотрим только, что в ней
  q.enqueue('G', 'ru', ['a']);
  q.enqueue('G', 'ru');
  assert.deepStrictEqual(q.queue, [{ id: 'G', lang: 'ru', redo: ['a'] }]);
  q.enqueue('G', 'ru', ['b']);
  assert.deepStrictEqual(q.queue[0].redo, ['a', 'b']);
  q.enqueue('G', 'ru', 'all');
  assert.strictEqual(q.queue[0].redo, 'all');
  q.enqueue('G', 'en');
  assert.deepStrictEqual(q.queue, [{ id: 'G', lang: 'en', redo: null }], 'другой язык — прежний «заново» не нужен');

  await db.run("UPDATE game_translation SET lang = '' WHERE id = 'G'");
  await assert.rejects(svc.redo('G'), /Перевод не включён/);
  await assert.rejects(svc.exportFile('G'), /Перевод не включён/);
});

test('перевод с любой игрой: тип параметра — из шапки плагина, файлы на любой глубине, строки из кода плагинов — только на экране', async (t) => {
  const { pluginParamTypes, pluginTexts, pluginLiterals, pluginDisplayTexts, makeGuard, overlayPlugins } = require('./src/utils/gametext.js');
  // Как UXPolish у 星降る宿: «…SeName» — файл (@type file), «…Label» — строка; «戦闘の難しさ» — строка без «говорящего» имени
  const header = `/*:
 * @param msgAdvanceSeName
 * @type file
 * @dir audio/se
 * @default arina/other/クリック音１
 *
 * @param msgButtonSaveLabel
 * @type string
 * @default セーブ
 *
 * @param 難易度
 * @type string
 *
 * @param Rows
 * @type struct<Row>[]
 *
 * @command show
 * @arg picture
 * @type file
 */
/*~struct~Row:
 * @param icon
 * @type number
 * @param caption
 * @type string
 */
var x = 1;`;
  const types = pluginParamTypes(header);
  assert.deepStrictEqual([...types.not].sort(), ['icon', 'msgAdvanceSeName']);
  assert.deepStrictEqual([...types.text].sort(), ['caption', 'msgButtonSaveLabel', '難易度']);
  const rows = JSON.stringify([JSON.stringify({ icon: '12', caption: '回復' })]);
  const plugins = `var $plugins = [${JSON.stringify({ name: 'UX/Polish', status: true, parameters: {
    msgAdvanceSeName: 'arina/other/クリック音１', msgButtonSaveLabel: 'セーブ', '難易度': 'やさしい', Rows: rows,
    soundName: 'クリック音', scriptName: '$gameVariables.value(4)', helpText: '\\C[2]完了', otherPath: 'img/pictures/タイトル.png',
  } })}];`;
  const map = new Map([['UX/Polish', types]]);
  assert.deepStrictEqual(pluginTexts(plugins, map).sort(), ['\\C[2]完了', 'セーブ', '回復'].sort());
  // «Строка» только по шапке, имя ничего не говорит — может быть ключом: в файле не меняем, на экране — да
  assert.deepStrictEqual(pluginDisplayTexts(plugins, map), ['やさしい']);
  const g = makeGuard({ plugins, types: map });
  assert.ok(g('arina/other/クリック音１') && g('$gameVariables.value(4)') && g('やさしい'), 'файл, код и возможный ключ — в защиту');
  const out = overlayPlugins(plugins, (x) => ({ 'arina/other/クリック音１': 'Click Sound 1', 'セーブ': 'Save' }[x]), map);
  assert.match(out, /"msgAdvanceSeName":"arina\/other\/クリック音１"/, 'имя файла звука — как было: игра его загружает');
  assert.match(out, /"msgButtonSaveLabel":"Save"/);

  // Строки из кода плагина: подписи настроек — да; справка в комментариях, пути и код — нет
  const code = `/*: @help 「ヘルプの説明」 */
const LEVELS = [{ label: 'ゲーム標準' }, { label: "瞬間" }];
this._list.push({ name: "全体 音量", symbol: "masterVolume" }); // 'コメント'
ImageManager.loadPicture('タイトル/背景.png');
this.drawPageTitle('操作説明（1/3）操作');
const se = 'arina/other/クリック音１';
console.log('デバッグ：読み込み完了');
throw new Error('データが壊れています');
const msg = \`\${name}が仲間になった\`;`;
  assert.deepStrictEqual(pluginLiterals(code), ['ゲーム標準', '瞬間', '全体 音量', '操作説明（1/3）操作', 'arina/other/クリック音１'],
    'без справки, файлов с расширением, отладки и шаблонов; косая черта — не повод (имя файла игры отсекает сервис)');
  // Шаблоны: \`所持SP：\${sp()}\` → «所持SP：%1»; без японского или без подстановок — нет
  const tpl = "this.drawText(\`所持SP：\${sp()}\`); const a = \`\${day}日目／30日\`; const b = \`plain \${x}\`; const c = \`固定\`; console.log(\`読込\${n}件\`);";
  assert.deepStrictEqual(require('./src/utils/gametext.js').pluginTemplates(tpl), ['所持SP：%1', '%1日目／30日']);
  // Параметр без @type — строка (так в RPG Maker); многострочный (@type note) с «текстовым» именем — на экран
  const t2 = pluginParamTypes(`/*:\n * @param 確認文\n * @default 使う\n *\n * @param 详细说明JP\n * @type note\n *\n * @param Script\n * @type note\n */`);
  assert.ok(t2.text.has('確認文') && t2.note.has('详细说明JP'));
  const p2 = `var $plugins = [${JSON.stringify({ name: 'P2', status: true, parameters: { '確認文': '使う', '详细说明JP': '"効果不明の状態"', Script: '"攻撃する"' } })}];`;
  assert.deepStrictEqual(pluginDisplayTexts(p2, new Map([['P2', t2]])).sort(), ['使う', '効果不明の状態'].sort());

  // Сервис: строки только для экрана — защищённые и из кода плагинов; файлы и плагины в подпапках находятся
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-any-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { data } = tlGame(root);
  const www = path.join(root, 'G', 'www');
  fs.mkdirSync(path.join(www, 'audio', 'se', 'arina', 'other'), { recursive: true });
  fs.writeFileSync(path.join(www, 'audio', 'se', 'arina', 'other', 'クリック音２.ogg'), '');
  fs.mkdirSync(path.join(www, 'js', 'plugins', 'Author'), { recursive: true });
  fs.writeFileSync(path.join(www, 'js', 'plugins', 'Author', 'Opt.js'), "/*:\n * @param seName\n * @type string\n */\nthis._list.push({ name: 'メッセージ速度' });");
  fs.writeFileSync(path.join(www, 'js', 'plugins.js'), `var $plugins = [{"name":"Author/Opt","status":true,"parameters":{"seName":"arina/other/クリック音２","Title":"冒険"}}];`);
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  const text = await svc.gameText('G');
  assert.ok(text.files.has('arina/other/クリック音２') && text.files.has('クリック音２'), 'имя файла — и с подпапками');
  assert.ok(!text.all.includes('arina/other/クリック音２'), 'строковый параметр, равный имени файла, — не переводится');
  assert.ok(text.display.includes('メッセージ速度'), 'строка из кода плагина в подпапке — для экрана');
  assert.ok(text.display.includes('アリス') && !text.strings.includes('アリス'), 'защищённое имя — только на экране');
  await db.run("INSERT INTO game_translation (id, lang, state) VALUES ('G', 'en', 'done')");
  await db.run("INSERT INTO translations (src, lang, text) VALUES ('メッセージ速度', 'en', 'Text Speed…'), ('アリス', 'en', 'Alice'), ('はい', 'en', 'Yes')");
  svc.version++;
  assert.deepStrictEqual((await svc.displayDict('G')).words, { 'メッセージ速度': 'Text Speed...', 'アリス': 'Alice', 'はい': 'Yes' },
    'строки для экрана и короткие строки данных (плагины рисуют их сами), точки — обычные');
  // В файлах защищённое — как было: условие «name() == "アリス"» продолжает работать
  const map1 = JSON.parse(await svc.overlay('G', 'Map001', fs.readFileSync(path.join(data, 'Map001.json'))));
  assert.strictEqual(map1.events[1].pages[0].list[0].parameters[4], 'アリス');
  await db.run("UPDATE game_translation SET lang = '' WHERE id = 'G'");
  assert.strictEqual(await svc.displayDict('G'), null);
});

test('перевод не ломает игру: запасной файл по переведённому имени, итог проверки в игре, ошибки после включения перевода', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-safe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tlGame(root);
  const se = path.join(root, 'G', 'www', 'audio', 'se', 'arina', 'other');
  fs.mkdirSync(se, { recursive: true });
  fs.writeFileSync(path.join(se, 'クリック音１.ogg'), 'ogg');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  await db.exec(`CREATE TABLE game_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT, sig TEXT, device TEXT, kind TEXT, message TEXT, source TEXT,
    line INTEGER, stack TEXT, scene TEXT, count INTEGER, first_at INTEGER, last_at INTEGER)`);
  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  await db.run("INSERT INTO game_translation (id, lang, state, at) VALUES ('G', 'en', 'done', 1000)");
  await db.run("INSERT INTO translations (src, lang, text) VALUES ('arina/other/クリック音１', 'en', 'arina/other/Click Sound 1'), ('クリック音１', 'en', 'Click Sound…')");
  svc.version++;

  // Игра попросила файл по переведённому имени — отдаём настоящий; чужое, выход из папки, без перевода — нет
  const real = path.join(se, 'クリック音１.ogg');
  assert.strictEqual(await svc.originalFile('G', 'G/www/audio/se/arina/other/Click Sound 1.ogg'), real);
  assert.strictEqual(await svc.originalFile('G', 'G/www/audio/se/arina/other/Click Sound....ogg'), real, 'перевели только имя, с обычными точками');
  assert.strictEqual(await svc.originalFile('G', 'G/www/audio/se/arina/other/Nothing.ogg'), null);
  assert.strictEqual(await svc.originalFile('G', 'G/www/audio/se/../../../../etc/passwd.ogg'), null);
  assert.strictEqual(await svc.originalFile('G', 'G/www/data/Click Sound 1.ogg'), null, 'не папка картинок и звуков');
  // Два файла перевелись одинаково — какой из них, не угадать: не подменяем
  fs.writeFileSync(path.join(se, 'クリック音２.ogg'), 'ogg2');
  svc.cache.clear();
  await db.run("INSERT INTO translations (src, lang, text) VALUES ('クリック音２', 'en', 'Click Sound…')");
  svc.version++;
  assert.strictEqual(await svc.originalFile('G', 'G/www/audio/se/arina/other/Click Sound....ogg'), null);
  assert.strictEqual(await svc.originalFile('G', 'G/www/audio/se/arina/other/Click Sound 1.ogg'), real, 'путь целиком — по-прежнему однозначен');
  // Плеер сцен галереи спрашивает переводы строк реплик: переведённое показывает, защищённое («アリス» есть и в коде игры) и
  // непереведённое — нет; у игры без перевода — пусто
  const line = '\\N[1]、こんにちは！\\!元気？';
  await db.run('INSERT INTO translations (src, lang, text) VALUES (?, ?, ?), (?, ?, ?)', [line, 'en', '\\N[1], hello!\\! How are you?', 'アリス', 'en', 'Alice']);
  svc.version++;
  assert.deepStrictEqual([...await svc.lookup('G', [line, 'アリス', 'нет такой'])], [[line, '\\N[1], hello!\\! How are you?']]);
  assert.deepStrictEqual([...await svc.lookup('Other', [line])], [], 'перевод этой игре не включён');

  // Ошибки игры после включения перевода — в состоянии; итог проверки в игре — тоже, и ошибки до проверки уже не тревожат
  await db.run(`INSERT INTO game_errors (game, sig, kind, message, source, count, first_at, last_at) VALUES ('G', 'a', 'load', 'Failed to load', 'audio/se/x.ogg', 1, 500, 500),
    ('G', 'b', 'load', 'Failed to load', 'audio/se/Click Sound 1.ogg', 2, 2000, 2000), ('G', 'c', 'error', 'old bug', '', 5, 100, 3000)`);
  let st = await svc.status('G');
  assert.deepStrictEqual(st.gameErrors.map((x) => x.source), ['audio/se/Click Sound 1.ogg'], 'только появившиеся после включения перевода: старая ошибка игры — не его');
  assert.strictEqual(st.check, null);
  st = await svc.saveCheck('G', { ok: false, steps: [{ name: 'title', ok: true }, { name: 'play', ok: false, extra: 'x' }], errors: [{ kind: 'load', message: 'Failed to load', source: 'audio/se/y.ogg', junk: 1 }] });
  assert.deepStrictEqual([st.check.ok, st.check.lang, st.check.steps, st.check.errors], [false, 'en', [{ name: 'title', ok: true }, { name: 'play', ok: false }], [{ kind: 'load', message: 'Failed to load', source: 'audio/se/y.ogg' }]]);
  assert.ok(st.check.at > 0);
  assert.deepStrictEqual(st.gameErrors, [], 'ошибки до проверки — уже в её итоге');
  // Перевод включили заново (другой язык, новый перевод) — прежний итог проверки к нему не относится
  await svc.setLang('G', 'ru');
  await svc.setLang('G', 'en');
  await svc.pause('G');
  assert.strictEqual((await svc.status('G')).check, null);
  await db.run("UPDATE game_translation SET lang = '' WHERE id = 'G'");
  assert.strictEqual(await svc.originalFile('G', 'G/www/audio/se/arina/other/Click Sound 1.ogg'), null, 'перевод выключен — подмены нет');
  await assert.rejects(svc.saveCheck('G', { ok: true }), /Перевод не включён/);
});

test('перевод на экране (rpg-fixes): точное совпадение, шаблоны с подстановками, слово в рамке; без зависаний и ложных срабатываний', () => {
  // Функцию берём прямо из rpg-fixes.js и запускаем с заглушками браузера и движка
  const src = fs.readFileSync(path.join(__dirname, 'public', 'rpg-fixes.js'), 'utf8');
  const start = src.indexOf('function setupTranslationDisplay()');
  let depth = 0; let end = src.indexOf('{', start);
  for (let i = end; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i + 1; break; } }
  const dict = {
    '装備': 'Equip', '服': 'Clothes', '武器': 'Weapon', 'constructor': undefined,
    '所持SP：%1': 'SP: %1', '%2を%1に変更': 'Change %2 to %1', '%2の%1': 'тесно', '先に「%1」を覚える必要がある。': 'Learn "%1" first.',
    '%1': 'X', '%1%2日': 'bad', '解放数：%1 / %2（%3%）': 'Unlocked: %1 / %2 (%3%)', 'Power Slash': 'Power Slash',
    '%1／30日目・%2': 'Day %1/30 · %2', '%1時%2分': '%1:%2', '%1年%2月': '%2/%1', '%1は%2に': '%1 goes to %2', '昼': 'Noon', 'ユーキと時間を過ごす': 'Spending Time with Yuki', 'ユーキの家': "Yuki's House", '攻撃力': 'Attack',
  };
  delete dict.constructor;
  const window = { __RPG: { tl: 'en' } };
  class XMLHttpRequest { open() {} send() { this.status = 200; this.responseText = JSON.stringify(dict); } }
  // Движок — заглушки: рисование и замер ширины возвращают то, что им передали
  class Bitmap { drawText(t) { return t; } measureTextWidth(t) { return t; } }
  class Window_Base { drawTextEx(t) { return t; } textSizeEx(t) { return t; } textWidth(t, extra) { return [t, extra, this.tag]; } }
  const fn = new Function('window', 'XMLHttpRequest', 'setInterval', 'setTimeout', 'Bitmap', 'Window_Base',
    `${src.slice(start, end)}; setupTranslationDisplay(); return window.__RPG.translateText;`);
  const tr = fn(window, XMLHttpRequest, () => 0, () => 0, Bitmap, Window_Base);
  // Замер ширины — по переводу (плагин ставит число за подписью по её ширине); прочее — как было
  const w = new Window_Base();
  w.tag = 'self';
  assert.deepStrictEqual(w.textWidth('装備', 'x'), ['Equip', 'x', 'self']);
  assert.deepStrictEqual(w.textWidth(5), [5, undefined, 'self']);
  assert.strictEqual(new Bitmap().measureTextWidth('装備'), 'Equip');
  assert.ok(Window_Base.prototype.textWidth.__rpgTl && Bitmap.prototype.measureTextWidth.__rpgTl);
  // Картинка с разметкой: при загрузке подписи стираются и пишутся переводом; без перевода — как была
  {
    const calls = [];
    let failDraw = false;
    class Bmp {
      constructor() { this.context = { getImageData: (...a) => ({ piece: a }), putImageData: (p, x, y) => calls.push(['restore', x, y]) }; }
      addLoadListener(f) { f(this); }
      clearRect(...a) { calls.push(['clear', ...a]); }
      drawText(t, x, y, w, h, al) { if (failDraw) throw new Error('шрифт'); calls.push(['draw', t, x, y, w, h, al, this.fontSize]); }
      measureTextWidth(t) { return t; }
      _setDirty() { calls.push(['dirty']); }
    }
    const ImageManager = { loadBitmap(folder, name) { return new Bmp(); } };
    const win = { __RPG: { tl: 'en' } };
    const data = { words: { '装備': 'Equip', '中出し': 'Creampie' }, images: [{ path: 'img/pictures/sub/labels', style: { color: '#fff' }, labels: [
      { text: '装備', x: 10, y: 20, w: 40, h: 20 }, { text: '中出し', x: 50, y: 60, w: 30, h: 18, maxW: 80, align: 'center' }, { text: '未訳', x: 0, y: 0, w: 5, h: 5 },
    ] }] };
    class XHR { open() {} send() { this.status = 200; this.responseText = JSON.stringify(data); } }
    const run = new Function('window', 'XMLHttpRequest', 'setInterval', 'setTimeout', 'ImageManager', 'Bitmap',
      `${src.slice(start, end)}; setupTranslationDisplay(); return ImageManager;`);
    const im = run(win, XHR, () => 0, () => 0, ImageManager, Bmp);
    im.loadBitmap('img/pictures/', 'sub/labels');
    assert.deepStrictEqual(calls, [
      ['clear', 7, 17, 46, 26], ['draw', 'Equip', 10, 20, 40, 20, 'left', 19],
      ['clear', 47, 57, 36, 24], ['draw', 'Creampie', 25, 60, 80, 18, 'center', 17],
    ]);
    calls.length = 0;
    im.loadBitmap('img/pictures/', 'other');
    assert.deepStrictEqual(calls, [], 'картинка без разметки — не трогаем');
    // Нарисовать не вышло — стёртый кусок возвращается как был; закодированное имя и «./» — тот же путь
    failDraw = true;
    im.loadBitmap('./img/pictures/', encodeURIComponent('sub/labels'));
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'restore'), [['restore', 7, 17], ['restore', 47, 57]]);
    assert.ok(calls.some((c) => c[0] === 'dirty'));
  }
  assert.strictEqual(tr('装備'), 'Equip');
  assert.strictEqual(tr('所持SP：6'), 'SP: 6');
  assert.strictEqual(tr('先に「Power Slash」を覚える必要がある。'), 'Learn "Power Slash" first.');
  assert.strictEqual(tr('音量を50に変更'), 'Change 音量 to 50', 'порядок подстановок — как в переводе');
  assert.strictEqual(tr('剣の村'), '剣の村', 'один японский знак в постоянной части — шаблон подходил бы к чему угодно');
  assert.strictEqual(tr('解放数：3 / 10（30%）'), 'Unlocked: 3 / 10 (30%)', 'знак % в шаблоне — просто знак');
  assert.strictEqual(tr('― 武器 ―'), '― Weapon ―');
  assert.strictEqual(tr('【装備】'), '【Equip】');
  assert.strictEqual(tr('― 服 ―'), '― Clothes ―', 'один знак в рамке — целое слово');
  assert.strictEqual(tr('3／30日目・昼'), 'Day 3/30 · Noon', 'значение шаблона из одного знака — тоже слово');
  assert.strictEqual(tr('ユーキと時間を過ごす（ユーキの家）'), "Spending Time with Yuki（Yuki's House）", 'склейка из переводимых кусков');
  assert.strictEqual(tr('攻撃力：28'), 'Attack：28');
  assert.strictEqual(tr('7時00分'), '7:00', 'шаблон из однознаковых кусков — тоже, целиком от начала до конца');
  assert.strictEqual(tr('7時00分ごろ'), '7時00分ごろ', 'лишнее в конце — уже не этот шаблон');
  assert.strictEqual(tr('2026年10月'), '10/2026');
  assert.strictEqual(tr('昨年の十二月'), '昨年の十二月', 'однознаковые куски — подстановки только числа');
  assert.strictEqual(tr('俺は今日、学校に'), '俺は今日、学校に', '«%1は%2に» не цепляется к обычной реплике');
  assert.strictEqual(tr('ユーキと時間を過ごす（村の外）'), 'ユーキと時間を過ごす（村の外）', 'кусок без перевода — всё как было, без смеси языков');
  // Не трогаем: одиночный знак (MV рисует по букве), «服。» (знак препинания — не рамка), чужое, числа,
  // свойства объекта, шаблон «%1» без постоянной части и шаблон с подстановками вплотную
  for (const x of ['服', '服。', 'こんにちは', '123/456', 'constructor', 'toString', '8日']) assert.strictEqual(tr(x), x, x);
  // Длинная строка без совпадений — быстро (шаблоны отсекаются дешёвой проверкой)
  const t0 = Date.now();
  for (let i = 0; i < 2000; i++) tr(`所持SP：${i}${'あ'.repeat(250)}x`);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} мс`);
});

test('перевод шаблонов числами; строки с кодами и переводами строк в переменных', () => {
  const { numberTemplate, numbersBack, eachShown } = require('./src/utils/gametext.js');
  const nt = numberTemplate('%1／30日目・%2');
  assert.deepStrictEqual([nt.text, nt.map], ['71／30日目・83', { 1: '71', 2: '83' }]);
  assert.strictEqual(numbersBack('Day 71/30 · 83', nt), 'Day %1/30 · %2');
  assert.strictEqual(numbersBack('Day 71/30', nt), null, 'число потерялось — прежним способом');
  assert.strictEqual(numbersBack('Day 71/30 · 83 (83)', nt), null, 'число повторилось — тоже');
  const nt2 = numberTemplate('解放数：%1 / %2（%3%） 71回');
  assert.ok(!Object.values(nt2.map).includes('71'), 'числа из самой строки не берём');
  assert.strictEqual(numbersBack(nt2.text.replace('解放数：', 'Unlocked: '), nt2), 'Unlocked: %1 / %2（%3%） 71回');
  const twice = numberTemplate('%1と%1');
  assert.strictEqual(numbersBack('71 and 71', twice), '%1 and %1');
  assert.strictEqual(numberTemplate('ただの文'), null);

  // «переменная = "\\FS[18]…\n…"» — код игры и перевод строки внутри; назад — экранированной JS-строкой
  const map = { events: [null, { pages: [{ list: [
    { code: 122, parameters: [32, 32, 0, 4, '"\\\\FS[18]いつも一緒にいたい。\\nとっても大好き！"'] },
    { code: 0, parameters: [] },
  ] }] }] };
  const seen = [];
  eachShown('Map001', map, (v, set) => { seen.push(v); set('\\FS[18]I always want to be with him.\nI love him!'); });
  assert.deepStrictEqual(seen, ['\\FS[18]いつも一緒にいたい。\nとっても大好き！']);
  const lit = map.events[1].pages[0].list[0].parameters[4];
  assert.strictEqual(eval(lit), '\\FS[18]I always want to be with him.\nI love him!');
  // Перевод с кавычками обоих видов и \u — назад валидной JS-строкой
  const m2 = { events: [null, { pages: [{ list: [{ code: 122, parameters: [1, 1, 0, 4, "'今日\\u3002'"] }] }] }] };
  eachShown('Map001', m2, (v, set) => { assert.strictEqual(v, '今日。'); set(`He said "it's" ok`); });
  assert.strictEqual(eval(m2.events[1].pages[0].list[0].parameters[4]), `He said "it's" ok`);
  // Редкие экранирования — не трогаем (строка остаётся кодом)
  for (const raw of ['"\\x41あ"', '"\\u{1F600}あ"', '"\\101あ"', '"あ\\\nい"']) {
    const m3 = { events: [null, { pages: [{ list: [{ code: 122, parameters: [1, 1, 0, 4, raw] }] }] }] };
    const got = [];
    eachShown('Map001', m3, (v) => got.push(v));
    assert.deepStrictEqual(got, [], raw);
  }
  // Сравнение с той же строкой в другом скрипте (в нём — экранированной) защищает её
  const { makeGuard } = require('./src/utils/gametext.js');
  const guard = makeGuard({ scripts: ['if ($gameVariables.value(5) === "\\\\C[2]赤\\n札") {}'] });
  assert.ok(guard('\\C[2]赤\n札'));
});

test('подписи на картинках: разметка по хэшу файла, тексты — в перевод, перерисовка в памяти при загрузке', async (t) => {
  const crypto = require('crypto');
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  // Разметки из api/src/data/image-labels: у каждой — путь, хэш и подписи с местами. Своей разметки в поставке нет —
  // в тесте своя: экран статуса, где подписи нарисованы прямо на картинке
  const dir = path.join(__dirname, 'src', 'data', 'image-labels');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    const own = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(/^[0-9a-f]{40}$/.test(own.sha1) && own.file && own.labels.length, f);
    for (const l of own.labels) assert.ok(l.text && [l.x, l.y, l.w, l.h].every(Number.isFinite), `${f}: ${l.text}`);
  }
  const set = {
    file: 'img/pictures/ステータス_素材/ステータス_固定テキスト.png', sha1: '0'.repeat(40), size: 1000,
    style: { color: '#ffffff', outline: 'rgba(0, 0, 0, 0.85)', outlineWidth: 4, bold: true },
    labels: [{ text: '星降る宿', x: 61, y: 60, w: 100, h: 33 }, { text: '攻撃力レベル：', x: 180, y: 70, w: 116, h: 22 }, { text: 'ユーキに対する気持ち', x: 61, y: 120, w: 200, h: 22 }],
  };
  // Игра с этой картинкой по тому же пути: совпал хэш — разметка есть; другой файл — нет
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-img-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tlGame(root);
  const file = path.join(root, 'G', 'www', ...set.file.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'другая картинка');
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  await db.run("INSERT INTO game_translation (id, lang, state) VALUES ('G', 'en', 'done')");
  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  let text = await svc.gameText('G');
  assert.deepStrictEqual(text.images, [], 'хэш другой (автор обновил картинку) — разметка не применяется');
  // Разметка с хэшем нашего файла (подставляем сервису, файлов в исходниках не пишем); размер тоже должен совпасть
  const sha1 = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  const svc2 = new TranslateService();
  svc2.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  svc2.labelSets = [{ ...set, sha1, size: 999 }];
  assert.deepStrictEqual((await svc2.gameText('G')).images, [], 'размер другой — хэш даже не считаем');
  svc2.cache.clear();
  svc2.labelSets = [{ ...set, sha1, size: fs.statSync(file).size }, { ...set, file: '../../outside.png', sha1 }];
  text = await svc2.gameText('G');
  assert.strictEqual(text.images.length, 1, 'разметка с путём за пределы игры — мимо');
  assert.strictEqual(text.images[0].path, set.file.replace(/\.png$/, ''));
  assert.ok(text.display.includes('攻撃力レベル：') && text.display.includes('ユーキに対する気持ち'), 'подписи — в перевод для экрана');
  await db.run("INSERT INTO translations (src, lang, text) VALUES ('攻撃力レベル：', 'en', 'Attack Level:')");
  svc2.version++;
  const dd = await svc2.displayDict('G');
  assert.strictEqual(dd.words['攻撃力レベル：'], 'Attack Level:');
  assert.strictEqual(dd.images[0].labels.length, set.labels.length);
});

test('сохранение до перевода: строки переменных и герои — переводом при загрузке; плагин с переносом по буквам — по словам', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-saved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tlGame(root);
  // Описание — строка в переменной (скрипт в «変数の操作»); титул с ней же сравнивает код — защищён
  fs.writeFileSync(path.join(root, 'G', 'www', 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: '共通', list: [
    { code: 122, indent: 0, parameters: [30, 30, 0, 4, '"口でするとか考えられない！\\n汚いし…"'] },
    { code: 122, indent: 0, parameters: [24, 24, 0, 4, '"村で一番強い女の子"'] },
    { code: 111, indent: 0, parameters: [12, '$gameVariables.value(24) === "村で一番強い女の子"'] },
    { code: 0, indent: 0, parameters: [] },
  ] }]));
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  await db.run("INSERT INTO game_translation (id, lang, state) VALUES ('G', 'en', 'done')");
  for (const [src, text] of [['口でするとか考えられない！\n汚いし…', "Can't imagine it!\nGross…"], ['村で一番強い女の子', 'Strongest Girl'],
    ['剣士', 'Swordsman'], ['村の剣士。\nよろしく。', 'Village swordsman.\nHi.'], ['アリス', 'Alice']]) {
    await db.run("INSERT INTO translations (src, lang, text) VALUES (?, 'en', ?)", [src, text]);
  }
  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  const dd = await svc.displayDict('G');
  // Тот же перевод, что в файлах (displayText: «…» → «...»); защищённое (титул, «アリス» из скрипта) — нет
  assert.deepStrictEqual(dd.saved, {
    vars: { '口でするとか考えられない！\n汚いし…': "Can't imagine it!\nGross..." },
    actors: { '剣士': 'Swordsman', '村の剣士。\nよろしく。': 'Village swordsman.\nHi.' },
  });
  const ce = JSON.parse(await svc.overlay('G', 'CommonEvents', fs.readFileSync(path.join(root, 'G', 'www', 'data', 'CommonEvents.json'), 'utf8')));
  assert.strictEqual(eval(ce[1].list[0].parameters[4]), dd.saved.vars['口でするとか考えられない！\n汚いし…'], 'события теперь пишут то же самое');
  const actorsTl = JSON.parse(await svc.overlay('G', 'Actors', fs.readFileSync(path.join(root, 'G', 'www', 'data', 'Actors.json'), 'utf8')));
  assert.deepStrictEqual([actorsTl[1].nickname, actorsTl[1].profile], [dd.saved.actors['剣士'], dd.saved.actors['村の剣士。\nよろしく。']], 'и база героев — тоже');

  // rpg-fixes: загрузка сохранения подменяет только точные совпадения; файл сохранения — как был
  const src = fs.readFileSync(path.join(__dirname, 'public', 'rpg-fixes.js'), 'utf8');
  const fnBody = (name) => {
    const start = src.indexOf(`function ${name}()`);
    let depth = 0; let end = src.indexOf('{', start);
    for (let i = end; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i + 1; break; } }
    return src.slice(start, end);
  };
  {
    class XHR { open() {} send() { this.status = 200; this.responseText = JSON.stringify(dd); } }
    const vars = { _data: [] };
    const actors = { _data: [] };
    const saveFile = { vars: [0, 'x', '口でするとか考えられない！\n汚いし…', '村で一番強い女の子', 7, undefined, null], actors: [null, { _name: 'アリス', _nickname: '剣士', _profile: '村の剣士。\nよろしく。' }] };
    const DataManager = { extractSaveContents(c) { vars._data = c.vars.slice(); actors._data = c.actors.map((a) => (a ? { ...a } : a)); return 'ok'; } };
    const run = new Function('window', 'XMLHttpRequest', 'setInterval', 'setTimeout', 'DataManager', '$gameVariables', '$gameActors',
      `${fnBody('setupTranslationDisplay')}; setupTranslationDisplay(); return DataManager;`);
    const dm = run({ __RPG: { tl: 'en' } }, XHR, () => 0, () => 0, DataManager, vars, actors);
    assert.strictEqual(dm.extractSaveContents(saveFile), 'ok');
    assert.deepStrictEqual(vars._data, [0, 'x', "Can't imagine it!\nGross...", '村で一番強い女の子', 7, undefined, null]);
    assert.deepStrictEqual(actors._data[1], { _name: 'アリス', _nickname: 'Swordsman', _profile: 'Village swordsman.\nHi.' });
    assert.strictEqual(saveFile.vars[2], '口でするとか考えられない！\n汚いし…');
    // Словарь прежнего вида (без saved) — загрузку сохранения не трогаем
    const plain = { extractSaveContents() { return 'plain'; } };
    class OldXHR { open() {} send() { this.status = 200; this.responseText = JSON.stringify({ words: { '装備': 'Equip' }, images: [] }); } }
    run({ __RPG: { tl: 'en' } }, OldXHR, () => 0, () => 0, plain, vars, actors);
    assert.ok(!plain.extractSaveContents.__rpgTl);
  }

  // Окно плагина режет строку на буквы и переносит по ним — с переводом буквы слова идут одним куском
  {
    class Window_Base { initialize() {} }
    function Win() { this.initialize(); }
    Win.prototype = Object.create(Window_Base.prototype);
    Win.prototype.constructor = Win;
    Win.prototype.initialize = function() { Window_Base.prototype.initialize.call(this); };
    Win.prototype.tokenizeLine = function(line) { return line.match(/[\x1b\\][A-Z]+\[\d+\]|[\s\S]/g) || []; };
    Win.prototype.wrapLineToWidth = function(line, max) {
      const out = [];
      let cur = '';
      for (const tk of this.tokenizeLine(line)) {
        const w = (cur + tk).replace(/\x1b[A-Z]+\[\d+\]/g, '').length;
        if (w <= max || cur === '') cur += tk; else { out.push(cur); cur = tk; }
      }
      if (cur) out.push(cur);
      return out;
    };
    function Other() { this.initialize(); }
    Other.prototype = Object.create(Window_Base.prototype);
    Other.prototype.tokenizeLine = (line) => [...line];
    const run = new Function('window', 'setInterval', 'setTimeout', 'Window_Base', `${fnBody('setupTranslationWrap')}; setupTranslationWrap();`);
    run({ __RPG: { tl: 'en' } }, () => 0, () => 0, Window_Base);
    const w = new Win();
    assert.deepStrictEqual(w.wrapLineToWidth('I want to be with you all the time.', 18), ['I want to be with ', 'you all the time.']);
    assert.deepStrictEqual(w.tokenizeLine('\x1bFS[18]Hi there…'), ['\x1bFS[18]', 'Hi ', 'there…']);
    assert.deepStrictEqual(w.tokenizeLine('a\\C[2]bc d'), ['a', '\\C[2]', 'bc ', 'd'], 'код игры — отдельно, и с «\\», и с ESC');
    assert.deepStrictEqual(w.tokenizeLine('x'.repeat(25)), ['x'.repeat(20), 'x'.repeat(5)], 'слово длиннее 20 букв режется, а не вылезает за рамку');
    assert.deepStrictEqual(w.wrapLineToWidth('いつも一緒にいたい。', 4), ['いつも一', '緒にいた', 'い。'], 'японское — по буквам, как было');
    new Other();
    assert.deepStrictEqual(Other.prototype.tokenizeLine('ab c'), ['a', 'b', ' ', 'c'], 'без своего переноса (wrapLineToWidth) окно не трогаем');
  }
});

// Маленький PNG без библиотек: RGBA, одна заливка (для тестов картинок игры)
function pngOf(w, h, rgba = [0, 0, 0, 0]) {
  const zlib = require('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = rgba[3] === 255 ? 2 : 6;
  const bpp = rgba[3] === 255 ? 3 : 4;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgba.slice(0, bpp)).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from('89504E470D0A1A0A', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('картинки игры: расшифровка, размер и прозрачность из заголовка; сверка распознанного со строками игры', () => {
  const P = require('./src/utils/picturetext.js');
  const png = pngOf(40, 20);
  // Зашифрованная картинка RPG Maker: заголовок «RPGMV» и 16 байт, сложенных с ключом, — ключ не нужен
  const enc = Buffer.concat([Buffer.from('5250474D56000000000301000000000000', 'hex').subarray(0, 16), Buffer.alloc(16, 0xaa), png.subarray(16)]);
  assert.ok(P.decrypt(enc, 'a.rpgmvp').equals(png));
  assert.ok(P.decrypt(enc, 'a.png_').equals(png));
  assert.strictEqual(P.decrypt(png, 'a.png'), png);
  assert.strictEqual(P.decrypt(Buffer.alloc(10), 'a.png_'), null);
  assert.deepStrictEqual(P.pngInfo(enc.subarray(0, 64), 'x.rpgmvp'), { w: 40, h: 20, alpha: true });
  assert.deepStrictEqual(P.pngInfo(pngOf(816, 624, [10, 20, 30, 255]), 'x.png'), { w: 816, h: 624, alpha: false });
  assert.strictEqual(P.pngInfo(Buffer.from('not a png at all, really not'), 'x.png'), null);

  const lex = P.lexiconOf(['攻撃力：28', 'きっぷ', 'バルティス領', 'バルカス領', 'それは、違う', 'ポーション']);
  // Маленькая кана, китайское начертание, двоеточие — строка игры, и «проверь» снимается
  assert.deepStrictEqual(P.snap({ text: 'きつぷ', paddle: 'きつぷ', unsure: true }, lex), { text: 'きっぷ', paddle: 'きつぷ', unsure: false, known: true });
  assert.strictEqual(P.snap({ text: '攻擊力:', paddle: '攻擊力:' }, lex).text, '攻撃力:');
  // На знак от строки игры — она, но без снятия «проверь»; два похожих варианта — ничего
  assert.deepStrictEqual(P.snap({ text: 'リバルテイス領', paddle: 'リバルテイス領', unsure: true }, lex), { text: 'バルティス領', paddle: 'リバルテイス領', unsure: true, known: true });
  assert.strictEqual(P.snap({ text: 'バルテス領', paddle: 'バルテス領' }, lex).known, false);
  // manga-ocr «дочитал» к пятну рисунка частое слово из реплик — без согласия Paddle строкой игры не считается
  assert.strictEqual(P.snap({ text: 'それは', paddle: '足', manga: 'それは、', unsure: true }, lex).known, false);
  assert.ok(P.agreement('オミシュ領', 'アミシュ領') >= 0.75 && P.agreement('足', 'それは') === 0);
  const { plausibleDate } = require('./src/services/pictures.js');
  assert.deepStrictEqual(['1987年10月12日', '1日87年10月12日', '2028年10月72日', '20127年4月10日', '男性', '3日'].map(plausibleDate), [true, false, false, false, true, true]);
});

test('перевести картинки: очередь, кэш по хэшу, сверка, разметка в перевод; правки с экрана «Картинки»; обновлённый файл не трогаем', async (t) => {
  const http = require('http');
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  const { PictureService } = require('./src/services/pictures.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-pics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tlGame(root);
  // В игре есть «攻撃力» — по нему сверка поправит китайское начертание с картинки
  const sysFile = path.join(root, 'G', 'www', 'data', 'System.json');
  const sys = JSON.parse(fs.readFileSync(sysFile, 'utf8'));
  sys.terms.params = ['最大HP', '最大MP', '攻撃力'];
  fs.writeFileSync(sysFile, JSON.stringify(sys));
  const pics = path.join(root, 'G', 'www', 'img', 'pictures');
  fs.mkdirSync(path.join(pics, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(pics, 'ui', 'status.png'), pngOf(120, 40));
  const enc = pngOf(60, 30);
  fs.writeFileSync(path.join(pics, 'button.rpgmvp'), Buffer.concat([Buffer.alloc(16, 1), Buffer.alloc(16, 0xaa), enc.subarray(16)]));
  fs.writeFileSync(path.join(pics, 'scene.png'), pngOf(816, 624, [5, 5, 5, 255]));
  // Испорченная (служба: 422), со сбоем службы (500) и с ручной разметкой — в службу не идёт вовсе
  fs.writeFileSync(path.join(pics, 'broken.png'), pngOf(70, 20));
  fs.writeFileSync(path.join(pics, 'flaky.png'), pngOf(71, 20));
  const marked = pngOf(72, 20);
  fs.writeFileSync(path.join(pics, 'marked.png'), marked);

  // Служба распознавания понарошку: по размеру картинки — что на ней «написано»
  const seen = [];
  let ocrVersion = 4;
  const PATCH = pngOf(10, 20).toString('base64');
  const label = (text, extra = {}) => ({ text, paddle: text, manga: text, score: 0.98, agree: 1, unsure: false, vertical: false, box: [2, 2, 30, 12],
    x: 4, y: 3, w: 28, h: 10, maxW: 60, align: 'left', size: 12, color: '#ffffff', outline: null, outlineWidth: 0, bold: true, patchBox: [1, 1, 10, 10], patch: PATCH, ...extra });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ ok: true, version: ocrVersion }));
      if (req.url === '/boxes') return res.end(JSON.stringify({ version: ocrVersion, labels: [label('手書き', { manual: true })] }));
      const w = body.readUInt32BE(16);
      seen.push(w);
      if (w === 70) { res.statusCode = 422; return res.end(JSON.stringify({ error: 'bad-image' })); }
      if (w === 71) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'MemoryError' })); }
      const labels = w === 120 ? [label('ポーション'), label('攻擊力:', { paddle: '攻擊力:', unsure: true }), label('1日87年10月12日')]
        : w === 60 ? [label('剣士')] : [];
      res.end(JSON.stringify({ version: ocrVersion, w, h: body.readUInt32BE(20), bilingual: false, labels }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  // Таблицы картинок — те же, что в db/database.js
  const schema = fs.readFileSync(path.join(__dirname, 'src', 'db', 'database.js'), 'utf8');
  for (const m of schema.matchAll(/CREATE TABLE IF NOT EXISTS (?:picture_text|picture_patches|game_pictures|picture_jobs)[\s\S]*?\)(?=`|')/g)) await db.exec(m[0]);
  await db.run("INSERT INTO game_translation (id, lang, state) VALUES ('G', 'en', 'done')");
  await db.exec('CREATE TABLE games (id TEXT PRIMARY KEY)');
  await db.run("INSERT INTO games (id) VALUES ('G')");
  for (const [src, text] of [['ポーション', 'Potion'], ['攻撃力:', 'Attack:'], ['剣士', 'Swordsman']]) await db.run("INSERT INTO translations (src, lang, text) VALUES (?, 'en', ?)", [src, text]);

  const tr = new TranslateService();
  tr.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  const enqueued = [];
  tr.enqueue = (id, lang) => enqueued.push([id, lang]);
  // Свой клиент вместо глобального fetch: соседние тесты подменяют его на заглушки
  const httpFetch = (url, opts = {}) => new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end(opts.body);
  });
  const svc = new PictureService();
  svc.fetch = httpFetch;
  svc.url = `http://127.0.0.1:${server.address().port}`;
  svc.setDependencies({ dbService: { get: () => db }, translate: tr });
  svc.markupSets = [{ sha1: require('crypto').createHash('sha1').update(marked).digest('hex') }];
  tr.pictures = svc;

  const before = await svc.status('G');
  assert.deepStrictEqual([before.configured, before.available, before.estimate.ui.count, before.estimate.scene.count], [true, true, 5, 1]);
  svc.start('G', 'ui');
  await svc.running;
  assert.deepStrictEqual(seen.sort((a, b) => a - b), [60, 70, 71, 120], 'картинка сцены — только по желанию; зашифрованная — расшифрована; с ручной разметкой — нет');
  assert.deepStrictEqual(enqueued, [['G', 'en']], 'новые подписи — в перевод');
  const st = await svc.status('G');
  assert.deepStrictEqual([st.state, st.done, st.total, st.found, st.on, st.review, st.pictures], ['done', 5, 5, 4, 3, 1, 2]);
  // Испорченная и с ручной разметкой — разобраны (без подписей); со сбоем службы — ещё нет
  assert.strictEqual(st.estimate.ui.todo, 1);

  // Сверка: «攻擊力:» — строка игры «攻撃力», дата «1日87年» — «проверь» и выключена
  const review = await svc.review('G');
  const status = review.find((p) => p.key === 'img/pictures/ui/status');
  assert.deepStrictEqual(status.labels.map((l) => [l.text, l.on, l.unsure, l.translation]), [
    ['ポーション', true, false, 'Potion'], ['攻撃力:', true, false, 'Attack:'], ['1日87年10月12日', false, true, ''],
  ]);
  // Для игры — включённые подписи со стилем и заплаткой рядом со страницей; тексты — в перевод для экрана
  const text = await tr.gameText('G');
  assert.ok(text.pictureTexts.includes('ポーション') && !text.pictureTexts.includes('1日87年10月12日'));
  const dd = await tr.displayDict('G');
  const im = dd.images.find((x) => x.path === 'img/pictures/ui/status');
  assert.strictEqual(im.labels.length, 2);
  assert.match(im.labels[0].patch, /^mimikin-tl\/patch\/[0-9a-f]{40}\.png$/);
  assert.deepStrictEqual([im.labels[0].outline, im.labels[0].bold, im.labels[0].size], [null, true, 12], '«обводки нет» доходит до игры');
  assert.strictEqual(dd.words['剣士'], 'Swordsman');
  const hash = im.labels[0].patch.match(/([0-9a-f]{40})/)[1];
  assert.ok((await svc.patch(hash)).equals(Buffer.from(PATCH, 'base64')));
  assert.strictEqual(await svc.patch('../x'), null);
  // Картинка для экрана «Картинки» — расшифрованная; чужой ключ — нет
  assert.ok((await svc.image('G', 'img/pictures/button')).equals(enc));
  assert.strictEqual(await svc.image('G', '../../etc/passwd'), null);

  // Правки: включить сомнительную, поправить текст; обведённая рукой; убрать
  const date = status.labels[2];
  await svc.setLabel('G', status.sha1, date.id, { text: '1987年10月12日', on: true });
  const added = await svc.addBox('G', 'img/pictures/ui/status', [10, 10, 40, 16]);
  assert.deepStrictEqual([added.text, added.source, added.on, added.checked], ['手書き', 'manual', true, true]);
  assert.strictEqual(await svc.setLabel('G', 'f'.repeat(40), 1, { on: false }), null, 'чужая картинка — нет');
  let labels = (await svc.review('G')).find((p) => p.key === 'img/pictures/ui/status').labels;
  assert.deepStrictEqual(labels.map((l) => [l.text, l.on, l.checked]), [
    ['ポーション', true, false], ['攻撃力:', true, false], ['1987年10月12日', true, true], ['手書き', true, true],
  ]);
  assert.ok(await svc.removeLabel('G', status.sha1, added.id));
  assert.ok(await svc.removeLabel('G', status.sha1, labels[0].id));
  labels = (await svc.review('G')).find((p) => p.key === 'img/pictures/ui/status').labels;
  assert.deepStrictEqual(labels.map((l) => [l.text, l.on]), [['ポーション', false], ['攻撃力:', true], ['1987年10月12日', true]], 'найденная — выключена, обведённая — убрана');

  // Повторный запуск: та же картинка той же версией — служба не спрашивается; не вышедшая из-за сбоя — снова
  seen.length = 0;
  svc.start('G', 'ui');
  await svc.running;
  assert.deepStrictEqual(seen, [71]);
  // Ручную разметку добавили, когда картинку уже разобрало распознавание, — найденное (не правленное) убирается
  const buttonSha = (await db.get("SELECT sha1 FROM game_pictures WHERE key = 'img/pictures/button'")).sha1;
  svc.markupSets.push({ sha1: buttonSha });
  await db.run('UPDATE picture_text SET version = 3 WHERE sha1 = ?', [buttonSha]);
  svc.start('G', 'ui');
  await svc.running;
  assert.strictEqual((await db.get('SELECT labels FROM picture_text WHERE sha1 = ?', [buttonSha])).labels, '[]');
  svc.markupSets.pop();
  // Служба стала лучше (новая версия) — разобранная игра пересчитывается сама; картинка с правками — нет
  seen.length = 0;
  ocrVersion = 9;
  const better = new PictureService();
  better.fetch = httpFetch;
  better.url = svc.url;
  better.markupSets = [];
  better.setDependencies({ dbService: { get: () => db }, translate: tr });
  await better.upgrade();
  await better.running;
  assert.ok(seen.includes(60) && !seen.includes(121), `пересчитаны: ${seen}`);
  // Второй раз пересчитывать нечего: картинка с правками и картинки чужого охвата пересчёт по кругу не гоняют
  seen.length = 0;
  await better.upgrade();
  assert.ok(!better.running && !seen.length, `второй пересчёт: ${seen}`);
  ocrVersion = 4;
  // Службу обновили без перезапуска сервера — пересчёт запускается сам, один раз
  const bump = new PictureService();
  let ver = 5;
  let ups = 0;
  bump.url = 'http://ocr.invalid';
  bump.fetch = async () => ({ ok: true, json: async () => ({ ok: true, version: ver }) });
  bump.upgrade = async () => { ups++; };
  await bump.available({ fresh: true });
  ver = 6;
  await bump.available({ fresh: true });
  await bump.available({ fresh: true });
  assert.strictEqual(ups, 1);
  // Служба поднялась, когда recover её уже не дождался, — тоже пересчёт
  const late = new PictureService();
  late.url = 'http://ocr.invalid';
  late.fetch = bump.fetch;
  late.upgrade = async () => { ups++; };
  late.recovered = true;
  await late.available({ fresh: true });
  assert.strictEqual(ups, 2);
  // «Продолжить» сразу после паузы, пока дочитывается текущая картинка, — встаёт в очередь следом
  const queued = new PictureService();
  queued.current = { id: 'G', stop: true };
  queued.running = Promise.resolve();
  queued.start('G', 'ui');
  assert.deepStrictEqual(queued.queue, [{ id: 'G', scope: 'ui' }]);
  // Запущенное рукой — раньше фонового пересчёта; идущий пересчёт уступает и встаёт первым из фоновых
  const order = new PictureService();
  order.running = Promise.resolve();
  order.start('A', 'ui', { auto: true });
  order.start('B', 'all', { auto: true });
  order.start('C', 'ui');
  assert.deepStrictEqual(order.queue.map((q) => q.id), ['C', 'A', 'B']);
  order.current = { id: 'X', scope: 'ui', auto: true, stop: false };
  order.start('D', 'all');
  assert.ok(order.current.yield);
  assert.deepStrictEqual(order.queue.map((q) => [q.id, !!q.auto]), [['C', false], ['D', false], ['X', true], ['A', true], ['B', true]]);
  order.start('X', 'ui');
  assert.deepStrictEqual(order.queue.map((q) => q.id), ['C', 'D', 'X', 'A', 'B'], 'уступившую игру запустили рукой — она среди запущенных рукой');
  assert.ok(!order.queue[2].auto);
  // Файл картинки поменялся (обновление игры) — его разметку игре не отдаём, пока не разберут снова
  fs.writeFileSync(path.join(pics, 'ui', 'status.png'), pngOf(121, 40));
  tr.cache.clear();
  assert.ok(!(await tr.displayDict('G')).images.some((x) => x.path === 'img/pictures/ui/status'));

  // Служба не отвечает — разбор не начинается, ошибка понятна
  const down = new PictureService();
  down.fetch = httpFetch;
  down.url = 'http://127.0.0.1:9';
  down.setDependencies({ dbService: { get: () => db }, translate: tr });
  assert.strictEqual(await down.available(), null);
  // После перезапуска сервера разбор продолжается, но службу сначала ждут (она грузит модели дольше сервера)
  await db.run("UPDATE picture_jobs SET state = 'running' WHERE game_id = 'G'");
  const t0 = Date.now();
  await down.recover({ waitMs: 60, stepMs: 20 });
  assert.ok(Date.now() - t0 >= 60);
  await down.running;
  assert.strictEqual((await down.status('G')).error, 'ocr-down');
  // Службы нет совсем — не ждём, задача остаётся на паузе
  const none = new PictureService();
  none.url = '';
  none.setDependencies({ dbService: { get: () => db }, translate: tr });
  await db.run("UPDATE picture_jobs SET state = 'running' WHERE game_id = 'G'");
  await none.recover({ waitMs: 5000, stepMs: 1000 });
  assert.deepStrictEqual([none.running, (await db.get("SELECT state FROM picture_jobs WHERE game_id = 'G'")).state], [null, 'paused']);
  // Служба отвечает сбоем на каждую картинку — после пяти подряд разбор останавливается с ошибкой
  const flaky = new PictureService();
  flaky.fetch = async (u) => (u.endsWith('/health') ? { ok: true, status: 200, json: async () => ({ ok: true, version: 9 }) } : { ok: false, status: 500, json: async () => ({}) });
  flaky.url = 'http://ocr';
  flaky.setDependencies({ dbService: { get: () => db }, translate: tr });
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(pics, `extra${i}.png`), pngOf(80 + i, 20));
  flaky.start('G', 'ui');
  await flaky.running;
  const fst = await flaky.status('G');
  assert.deepStrictEqual([fst.state, fst.error], ['error', 'ocr-down']);
});

test('подписи, найденные на картинках: свой стиль, заплатка по маске, холст — сразу при загрузке, картинка по адресу', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'rpg-fixes.js'), 'utf8');
  const start = src.indexOf('function setupTranslationDisplay()');
  let depth = 0; let end = src.indexOf('{', start);
  for (let i = end; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i + 1; break; } }
  const order = [];
  // Заплатка 2×1: сверху новые пиксели (1,2,3,4) и (5,6,7,8), снизу маска — менять только первый
  const patchData = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 255, 255, 255, 255, 0, 0, 0, 0]);
  class Image { set src(v) { this._src = v; setTimeout(() => { this.width = 2; this.height = 2; this.onload(); }, 0); } }
  const document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: patchData }) }) }) };
  let put = null;
  const drawn = [];
  class Bmp {
    constructor() {
      this._ctx = { getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(9) }), putImageData: (d, x, y) => { put = [Array.from(d.data), x, y]; },
        save: () => drawn.push('save'), restore: () => drawn.push('restore'), translate: (x, y) => drawn.push(['translate', x, y]), rotate: (a) => drawn.push(['rotate', a]) };
    }
    get context() { order.push('context'); return this._ctx; }
    addLoadListener(f) { f(this); order.push('listener-done'); }
    clearRect() { drawn.push('clear'); }
    measureTextWidth(t) { return t.length * this.fontSize; }
    drawText(t, x, y, w, h, al) { drawn.push([t, x, y, w, h, al, this.fontSize, this.textColor, this.outlineColor, this.outlineWidth, this.fontBold]); }
  }
  const ImageManager = { loadNormalBitmap() { return new Bmp(); } };
  const data = { words: { 'ラベル': 'A long label', 'トイレ': 'Toilet' }, images: [{ path: 'img/pictures/sign', labels: [
    { text: 'トイレ', x: 10, y: 20, w: 20, h: 80, align: 'center', size: 12, color: '#ffffff', outline: null, outlineWidth: 0, bold: false, vertical: true },
  ] }, { path: 'img/pictures/Sub/ラベル', labels: [
    { text: 'ラベル', x: 4, y: 6, w: 20, h: 10, maxW: 40, align: 'left', size: 10, color: '#123456', outline: null, outlineWidth: 0, bold: true,
      patch: 'mimikin-tl/patch/aa.png', patchBox: [0, 0, 2, 1] },
  ] }] };
  class XHR { open() {} send() { this.status = 200; this.responseText = JSON.stringify(data); } }
  const run = new Function('window', 'XMLHttpRequest', 'setInterval', 'setTimeout', 'ImageManager', 'Bitmap', 'Image', 'document',
    `${src.slice(start, end)}; setupTranslationDisplay(); return ImageManager;`);
  const im = run({ __RPG: { tl: 'en' } }, XHR, () => 0, setTimeout, ImageManager, Bmp, Image, document);
  await new Promise((r) => setTimeout(r, 10));        // заплатки грузятся вместе со словарём
  im.loadNormalBitmap('img/pictures/sub/%E3%83%A9%E3%83%99%E3%83%AB.png', 0);
  // Холст — до конца слушателя загрузки (спрайт возьмёт текстуру уже с него); заплатка готова — рисуем сразу
  assert.deepStrictEqual(order, ['context', 'context', 'listener-done']);
  assert.deepStrictEqual(put, [[1, 2, 3, 4, 9, 9, 9, 9], 0, 0], 'заменён только пиксель под маской');
  assert.ok(!drawn.includes('clear'), 'с заплаткой прямоугольник не стирается');
  // Перевод длиннее места — шрифт меньше, но не меньше 60% и 8 px; «обводки нет» — прозрачная и нулевая
  assert.deepStrictEqual(drawn, [['A long label', 4, 6, 40, 10, 'left', 8, '#123456', 'rgba(0, 0, 0, 0)', 0, true]]);
  // Вертикальная надпись: перевод повёрнут и идёт вдоль столбца (место — его высота), по центру
  drawn.length = 0;
  im.loadNormalBitmap('img/pictures/sign.png', 0);
  assert.deepStrictEqual(drawn, ['clear', 'save', ['translate', 20, 60], ['rotate', Math.PI / 2], ['Toilet', -40, -10, 80, 20, 'center', 12, '#ffffff', 'rgba(0, 0, 0, 0)', 0, false], 'restore']);
});

test('чит-меню: сцены — решатель комнаты воспоминаний открывает входы (переключатели, счётчики, общие события, личные переключатели, предметы), состояние не трогает', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'cheats.js'), 'utf8');
  const sw = {}; const vars = {}; const selfs = {}; const bag = []; const reserved = [];
  const win = { addEventListener() {} };
  const $dataItems = [null, null, null, null, null, null, null, null, null, { id: 9, name: 'Ключ' }];
  new Function('window', 'location', 'localStorage', '$gameSwitches', '$gameVariables', '$gameSelfSwitches', '$gameParty', '$gameTemp', '$dataItems', src)(
    win, { search: '' }, { getItem: () => null },
    { setValue: (id, v) => { sw[id] = v; }, value: (id) => !!sw[id] },
    { setValue: (id, v) => { vars[id] = v; }, value: (id) => vars[id] || 0 },
    { setValue: (key, v) => { selfs[key.join(',')] = v; }, value: (key) => !!selfs[key.join(',')] },
    { hasItem: (it) => bag.includes(it.id), gainItem: (it) => bag.push(it.id) },
    { reserveCommonEvent: (id) => reserved.push(id) },
    $dataItems);
  const { findScenes, pluginScenes, actions } = win.__rpgCheats;
  const cmd = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const scene = [cmd(231, [1, 'cg']), cmd(0)];
  const ces = [null,
    { id: 1, name: 'シーン1', list: scene },
    // Проверка открытости — внутри общего события: «если переключатель 6 — сцена»
    { id: 2, name: '鍵チェック', list: [cmd(111, [0, 6, 0]), cmd(117, [1], 1), cmd(0, [], 1), cmd(412), cmd(0)] },
    { id: 3, name: '●回想全解放', list: [cmd(121, [3, 6, 0]), cmd(0)] },
    { id: 4, name: '回想未解放', list: [cmd(101, ['', 0, 0, 2]), cmd(0)] },
    // Комната под чужим именем — туда переносит общее событие «回想部屋»
    { id: 5, name: '回想部屋', list: [cmd(201, [0, 3, 5, 5, 2, 0]), cmd(0)] },
  ];
  const page = (conditions, list) => ({ conditions, list });
  const ev = (id, ...pages) => ({ id, pages });
  const room = { events: [null,
    ev(1, page({}, []), page({ switch1Valid: true, switch1Id: 3 }, [cmd(117, [1]), cmd(0)])),
    ev(2, page({}, [cmd(117, [2]), cmd(0)])),
    ev(3, page({}, []), page({ switch1Valid: true, switch1Id: 2 }, [cmd(201, [0, 9, 1, 1]), cmd(0)])),
    ev(4, page({}, []), page({ variableValid: true, variableId: 1, variableValue: 5 }, [cmd(201, [0, 9, 1, 1]), cmd(0)])),
    ev(5, page({}, []), page({ selfSwitchValid: true, selfSwitchCh: 'A' }, [cmd(201, [0, 9, 1, 1]), cmd(0)])),
    ev(6, page({}, [cmd(111, [1, 2, 0, 3, 0]), cmd(201, [0, 9, 1, 1], 1), cmd(412), cmd(0)])),
    ev(7, page({}, [cmd(111, [8, 9]), cmd(201, [0, 9, 1, 1], 1), cmd(412), cmd(0)])),
    ev(8, page({}, [cmd(101, ['', 0, 0, 2]), cmd(401, ['Привет']), cmd(0)])),
  ] };
  const hidden = { events: [null, ev(1, page({}, []), page({ switch1Valid: true, switch1Id: 5 }, [cmd(201, [0, 9, 1, 1]), cmd(0)]))] };
  const infos = [null, { id: 1, name: '回想部屋' }, { id: 2, name: '回想用MAP' }, { id: 3, name: '●True Debug Room' }];
  const names = ['', '回想全開放', '回想中', '【回想】ミレン', 'ストーリー①－１終了', '浴場', 'Scene Bath'];
  const vnames = ['', 'シナリオ進行度', '回想x'];
  let r = findScenes({ names, vnames, infos, maps: { 1: room, 2: room, 3: hidden }, ces });
  assert.deepStrictEqual(r.all.map((x) => x.id), [1], '«открыть всё» автора');
  assert.deepStrictEqual(r.rooms, ['回想部屋', '●True Debug Room'], 'карта самой сцены — не комната; комната под чужим именем — по общему событию');
  assert.deepStrictEqual(r.scenes.map((x) => x.id).sort(), [3, 5, 6], 'переключатели входов, в том числе из общего события; «回想中» — нет');
  assert.deepStrictEqual(r.vars, [{ id: 1, name: 'シナリオ進行度', value: 5 }, { id: 2, name: '回想x', value: 3 }],
    'счётчик «не меньше»; «= числу», если в комнате переменную сравнивают только с ним, — флаг сцены');
  assert.deepStrictEqual([r.selfs, r.items], [['1,5,A'], [{ kind: 8, id: 9 }]]);
  assert.deepStrictEqual(r.events, [{ id: 3, name: '●回想全解放' }], '«回想未解放» — не «открыть всё»');
  assert.deepStrictEqual(r.count, { before: 0, after: 7, total: 8 }, 'реплика без сцены — не вход; «回想中» — закрыт');
  // Выбор сцены — переменную сравнивают с разными числами: не подгоняем
  const picker = { events: [null, ev(1, page({}, [cmd(111, [1, 2, 0, 3, 0]), cmd(201, [0, 9, 1, 1], 1), cmd(412), cmd(0)])),
    ev(2, page({}, [cmd(111, [1, 2, 0, 4, 0]), cmd(201, [0, 9, 1, 1], 1), cmd(412), cmd(0)]))] };
  const picked = findScenes({ names, vnames, infos, maps: { 1: picker }, ces });
  assert.deepStrictEqual([picked.vars, picked.count], [[], { before: 0, after: 0, total: 2 }]);
  // Что уже открыто в игре — решатель не трогает
  r = findScenes({ names, vnames, infos, maps: { 1: room, 3: hidden }, ces,
    state: { sw: (id) => id === 3, vr: () => 0, self: () => false, item: () => false } });
  assert.ok(!r.scenes.some((x) => x.id === 3));
  assert.strictEqual(r.count.before, 1);
  // «Открыть всё» сцен, а не района; коды имени («\C[2]») убраны
  r = findScenes({ names: ['', '东区已完全开放', 'H-全CG解锁', '全開放スイッチ', 'Unlock Defeated Scenes', '全開放後', '\\C[2]全回想'] });
  assert.deepStrictEqual(r.all.map((x) => [x.id, x.name]), [[2, 'H-全CG解锁'], [3, '全開放スイッチ'], [4, 'Unlock Defeated Scenes'], [5, '全開放後'], [6, '全回想']]);

  // Плагины комнаты: RecollectionMode (MV), RecollectionModeMZ (файл из параметра), RecollectionMode2 (в параметре)
  const w = {
    rngd_recollection_mode_settings: { rec_cg_set: { 1: { title: 'Snoozing', switch_id: 301 } } },
    'RecollectionModeMZData.json': [{ title: 'キス１', switch_id: 302 }],
    $plugins: [
      { name: 'RecollectionModeMZ', status: true, parameters: { recoCgSettingList: 'RecollectionModeMZData.json' } },
      { name: 'RecollectionMode2', status: true, parameters: { Recollections: JSON.stringify([JSON.stringify({ title: 'Anal Beads', switch_id: '303' })]) } },
      { name: 'GE_RecollectionPersist', status: true, parameters: { allUnlockSwitchId: '310' } },
      { name: 'TitleRecollectionCommand', status: true, parameters: { recollectionSwitchId: '311' } },
      // «Идёт回想» — состояние, не «открыть»
      { name: 'SerenaRecollection', status: true, parameters: { recollectionModeSwitch: '312' } },
      { name: 'Off', status: false, parameters: { allUnlockSwitchId: '313' } },
    ],
  };
  const fromPlugins = pluginScenes(w);
  assert.deepStrictEqual(fromPlugins, { lists: [{ title: 'Snoozing', switchId: 301 }, { title: 'キス１', switchId: 302 }, { title: 'Anal Beads', switchId: 303 }], params: [310, 311] });
  const many = Array.from({ length: 320 }, (_, i) => `S${i}`);
  r = findScenes({ names: many, ...fromPlugins });
  assert.deepStrictEqual([r.all.map((x) => x.id), r.scenes.map((x) => x.id)], [[310, 311], [301, 302, 303]]);

  // Ветвления: сцена в «Иначе» (нужно ВЫКЛ — не выставляем), вложенные «Если», общее событие зовёт само себя
  const loopCes = [null, { id: 1, name: 'loop', list: [cmd(117, [1]), cmd(0)] }, { id: 2, name: 'сцена', list: scene }];
  const tricky = { events: [null,
    // «Если sw4 … Иначе — сцена»: открыто, пока sw4 выключен; решатель его не включает
    ev(1, page({}, [cmd(111, [0, 4, 0]), cmd(101, [], 1), cmd(0, [], 1), cmd(411), cmd(201, [0, 9, 1, 1], 1), cmd(0, [], 1), cmd(412), cmd(0)])),
    // Вложенные: «Если sw5» → «Если var1 ≥ 3» → сцена
    ev(2, page({}, [cmd(111, [0, 5, 0]), cmd(111, [1, 1, 0, 3, 1], 1), cmd(117, [2], 2), cmd(0, [], 2), cmd(412, [], 1), cmd(0, [], 1), cmd(412), cmd(0)])),
    // Два пути (выбор): через «= числу» (нельзя) или через sw6 — выставляем только sw6
    ev(3, page({}, [cmd(102, [['A', 'B']]), cmd(402, [0, 'A']), cmd(111, [1, 2, 0, 7, 0], 1), cmd(201, [0, 9, 1, 1], 2), cmd(412, [], 1),
      cmd(402, [1, 'B']), cmd(111, [0, 6, 0], 1), cmd(201, [0, 9, 1, 1], 2), cmd(412, [], 1), cmd(404), cmd(0)])),
    // Путь, который держит состояние («回想中») и счётчик: невыполним целиком — счётчик не трогаем
    ev(4, page({ switch1Valid: true, switch1Id: 2 }, [cmd(111, [1, 1, 0, 9, 1]), cmd(201, [0, 9, 1, 1], 1), cmd(412), cmd(0)])),
    // Зовёт само себя — не зависает, сцены там нет
    ev(5, page({}, [cmd(117, [1]), cmd(0)])),
    // Табличка: та же переменная 2 = 8 — значит, 2 — выбор сцены, а не флаг
    ev(6, page({}, [cmd(111, [1, 2, 0, 8, 0]), cmd(101, [], 1), cmd(0, [], 1), cmd(412), cmd(0)])),
  ] };
  r = findScenes({ names, vnames, infos: [null, { id: 1, name: '回想部屋' }], maps: { 1: tricky }, ces: loopCes });
  assert.deepStrictEqual([r.scenes.map((x) => x.id).sort(), r.vars], [[5, 6], [{ id: 1, name: 'シナリオ進行度', value: 3 }]]);
  assert.deepStrictEqual(r.count, { before: 1, after: 3, total: 4 }, 'зовущее само себя — не вход');

  // Цикл общих событий A → B → A, сцена только в B: вход через A и вход через B открываются при любом порядке
  // обхода; «герой в отряде» вход не закрывает
  const cycle = [null, { id: 1, name: 'A', list: [cmd(117, [2]), cmd(0)] }, { id: 2, name: 'B', list: [cmd(117, [1]), cmd(231, [1, 'cg']), cmd(0)] }];
  for (const order of [[1, 2], [2, 1]]) {
    const cyc = { events: [null, ...order.map((ce, i) => ev(i + 1, page({}, [cmd(117, [ce]), cmd(0)])))] };
    r = findScenes({ names, infos: [null, { id: 1, name: '回想部屋' }], maps: { 1: cyc }, ces: JSON.parse(JSON.stringify(cycle)) });
    assert.deepStrictEqual(r.count, { before: 2, after: 2, total: 2 }, `порядок ${order}`);
  }
  r = findScenes({ names, infos: [null, { id: 1, name: '回想部屋' }], maps: { 1: { events: [null, ev(1, page({ actorValid: true, actorId: 3 }, [cmd(201, [0, 9, 1, 1]), cmd(0)]))] } }, ces: [] });
  assert.deepStrictEqual(r.count, { before: 1, after: 1, total: 1 });

  // Меню на полсотни сцен: открытая сцена в самом конце всё равно находится (закрытых путей — не больше 40)
  const menu = [];
  for (let i = 0; i < 50; i++) menu.push(cmd(111, [1, 2, 0, i, 0]), cmd(201, [0, 9, 1, 1], 1), cmd(412));
  menu.push(cmd(201, [0, 9, 1, 1]), cmd(0));
  r = findScenes({ names, vnames, infos: [null, { id: 1, name: '回想部屋' }], maps: { 1: { events: [null, ev(1, page({ switch1Valid: true, switch1Id: 5 }, menu))] } }, ces: [] });
  assert.deepStrictEqual([r.count, r.scenes.map((x) => x.id)], [{ before: 0, after: 1, total: 1 }, [5]]);

  // «Открыть всё» галерей плагинов: есть — зовём, нет или бросает — не мешает
  const { pluginUnlock } = win.__rpgCheats;
  const called = [];
  const kns = { maxProgress: 99, setProgress: (c, sc, v) => called.push(['kns', c, sc, v]) };
  assert.deepStrictEqual(pluginUnlock({ ReplayAllOpen: () => called.push('rp'), CGAllOpen: () => { throw new Error('x'); }, KNS_Gallery: kns, $csvGalleryList: { 1: { 2: {} } } }),
    ['ReplayAllOpen', 'KNS_Gallery']);
  assert.deepStrictEqual(called, ['rp', ['kns', '1', '2', 99]]);
  assert.deepStrictEqual(pluginUnlock({}), []);

  // Применить: переключатели, счётчик (только вверх), личный переключатель, предмет, общее событие «открыть всё»
  vars[1] = 2;
  actions.openScenes({ all: [{ id: 1 }], scenes: [{ id: 3 }], vars: [{ id: 1, value: 5 }, { id: 2, value: 1 }], selfs: ['1,5,A'], items: [{ kind: 8, id: 9 }], events: [{ id: 3 }, { id: 4 }] });
  vars[2] = 7;
  actions.openScenes({ vars: [{ id: 2, value: 1 }] });
  assert.deepStrictEqual([sw, vars, selfs, bag, reserved], [{ 1: true, 3: true }, { 1: 5, 2: 7 }, { '1,5,A': true }, [9], [3]]);
});

test('чит-меню: сцены — не включаем то, что запускает игру саму (автозапуск, параллельные, общие события)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'cheats.js'), 'utf8');
  const win = { addEventListener() {} };
  new Function('window', 'location', 'localStorage', src)(win, { search: '' }, { getItem: () => null });
  const { safeScenes, findScenes, riskyConds } = win.__rpgCheats;
  const cmd = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const page = (conditions, list, trigger = 0) => ({ conditions, list: [...list, cmd(0)], trigger });
  const sc = [cmd(231, [1, 'cg'])];
  // Комната: вход 1 держит сюжетный переключатель 1 (он же — автозапуск в городе), вход 2 — переключатель 2 (запуск
  // общего события), вход 3 — счётчик 1 ≥ 5 (параллельное событие в городе с 5), вход 5 — переключатель 3 (условие
  // только обычной страницы в городе) — его открываем. Событие 4 — сцена на автозапуске за личным A: не вход (его не
  // запускает игрок), и A не трогаем
  const room = { events: [null,
    { id: 1, pages: [page({}, []), page({ switch1Valid: true, switch1Id: 1 }, sc)] },
    { id: 2, pages: [page({}, []), page({ switch1Valid: true, switch1Id: 2 }, sc)] },
    { id: 3, pages: [page({}, []), page({ variableValid: true, variableId: 1, variableValue: 5 }, sc)] },
    { id: 4, pages: [page({}, []), page({ selfSwitchValid: true, selfSwitchCh: 'A' }, sc, 3)] },
    { id: 5, pages: [page({}, []), page({ switch1Valid: true, switch1Id: 3 }, sc)] },
  ] };
  const town = { events: [null,
    { id: 1, pages: [page({}, []), page({ switch1Valid: true, switch1Id: 1 }, [cmd(101)], 3)] },
    { id: 2, pages: [page({}, []), page({ variableValid: true, variableId: 1, variableValue: 3 }, [cmd(101)], 4)] },
    { id: 3, pages: [page({}, []), page({ switch1Valid: true, switch1Id: 3 }, [cmd(101)], 0)] },
    // Автозапуск, который переключатель 3 не включит: старшая страница с ним обычная
    { id: 4, pages: [page({ switch1Valid: true, switch1Id: 3 }, [cmd(101)], 3), page({ switch1Valid: true, switch1Id: 3 }, [cmd(101)], 0)] },
  ] };
  const ces = [null, { id: 1, name: 'イベント', trigger: 2, switchId: 2, list: [cmd(0)] }];
  const args = { names: ['', '物語進行', 'イベントON', 'シーン5'], vnames: ['', '進行度'], infos: [null, { id: 1, name: '回想部屋' }, { id: 2, name: '町' }],
    maps: { 1: room }, ces };
  const raw = findScenes(args);
  assert.deepStrictEqual(raw.count, { before: 0, after: 4, total: 4 });
  const safe = safeScenes(args, { 1: room, 2: town });
  assert.deepStrictEqual([safe.scenes.map((x) => x.id), safe.vars, safe.selfs, safe.count], [[3], [], [], { before: 0, after: 1, total: 4 }]);
  // Уже включённое игрой — не «наше»: открываем дальше
  const state = { sw: (id) => id === 1, vr: () => 0, self: () => false, item: () => false };
  assert.deepStrictEqual(safeScenes({ ...args, state }, { 1: room, 2: town }).count, { before: 1, after: 2, total: 4 });
  // Осторожное правило (когда пересчёт не сходится): всё из условий автозапуска и параллельных страниц
  const r = riskyConds({ 1: room, 2: town }, ces);
  assert.deepStrictEqual([[...r.sw].sort(), [...r.vr], [...r.self]], [[1, 2, 3], [1], ['1,4,A']]);
});

test('чит-меню: комнаты под другими именами и комната по устройству (события, которые включают воспоминание)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'cheats.js'), 'utf8');
  const win = { addEventListener() {} };
  new Function('window', 'location', 'localStorage', src)(win, { search: '' }, { getItem: () => null });
  const { roomMaps, hubRooms } = win.__rpgCheats;
  const names = ['回憶室', '90-回忆空间', 'MAP255回想の部屋製品版', 'CG ROOM', 'Reminiscence room', 'Flashback Room', 'recall theater★★',
    'Старая комната восспоминаний', '回想用MAP', '17-雪拉回忆', 'Memory of the Boss\'s Room', 'Recollection Test'];
  const infos = [null, ...names.map((name, i) => ({ id: i + 1, name }))];
  assert.deepStrictEqual(roomMaps(infos, []).map((m) => m.name), names.slice(0, 8));
  // По устройству: на «Chamber of Fate» 10 событий включают «…回想» или зовут «回想開始», на городе — 9
  const cmd = (code, parameters = []) => ({ code, parameters, indent: 0 });
  const evs = (n, list, trigger = 0) => [null, ...Array.from({ length: n }, (_, i) => ({ id: i + 1, pages: [{ trigger, conditions: {}, list: [...list, cmd(0)] }] }))];
  const maps = {
    1: { events: evs(6, [cmd(121, [3, 3, 0])]).concat(evs(4, [cmd(117, [1])]).slice(1)) },
    2: { events: evs(9, [cmd(121, [3, 3, 0])]) },
    3: { events: evs(12, [cmd(121, [3, 3, 1])]) },
    4: { events: evs(12, [cmd(121, [3, 3, 0])], 4) },
  };
  const hub = hubRooms({ infos: [null, { id: 1, name: 'Chamber of Fate' }, { id: 2, name: '町' }, { id: 3, name: '城' }, { id: 4, name: '森' }], maps,
    names: ['', '', '', 'OPフェラ奉仕回想'], ces: [null, { id: 1, name: '回想開始', list: [] }] });
  assert.deepStrictEqual(hub.map((m) => m.name), ['Chamber of Fate']);
});

test('чит-меню: устройства комнат — вход в два шага, меню из картинок, сцена по номеру, двери и автозапуски не входы, имена флагов', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'cheats.js'), 'utf8');
  const win = { addEventListener() {} };
  new Function('window', 'location', 'localStorage', src)(win, { search: '' }, { getItem: () => null });
  const { findScenes, hubRooms, pickRooms, findRoomEntry } = win.__rpgCheats;
  const cmd = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const page = (conditions, list, trigger = 0) => ({ conditions, trigger, list: [...list, cmd(0)] });
  const ev = (id, name, ...pages) => ({ id, name, pages });
  const pic = (n) => cmd(231, [1, n, 0, 0, 0, 0, 100, 100, 255, 0]);
  const scene = [pic('cg1'), pic('cg2')];
  const ces = [null,
    { id: 1, name: '回想代表', list: [cmd(201, [0, 1, 5, 5, 2, 0]), cmd(111, [0, 7, 0]), cmd(356, ['P_CALL_CE 10 11 1 ON'], 1), cmd(0, [], 1), cmd(412),
      cmd(356, ['P_CALL_CE 11 12 1 ON']), cmd(356, ['P_CALL_CE 12 13 1 ON']), cmd(0)] },
    ...[11, 12, 13].map((id) => null),
  ];
  for (const id of [11, 12, 13]) ces[id] = { id, name: `Сцена ${id}`, list: [...scene, cmd(0)] };
  const names = ['', '', '', '', '', 'unlockedModelingJob2', 'Demon Lord defeated', 'イベント開放', '【回想】宿舎の管理兵２', '管理フラグ', 'Debug mode'];
  const vnames = ['', '', '', '', '回想で呼ぶコモンイベント番号'];
  const room = { width: 10, height: 10, events: [null,
    // В два шага: «по кнопке» включает A, сцена — на автозапуске за A. Вход — первая страница, открывает её sw5 (не «mode»)
    ev(1, 'job', page({}, [cmd(101)]), page({ switch1Valid: true, switch1Id: 5 }, [cmd(102), cmd(123, ['A', 0])]), page({ selfSwitchValid: true, selfSwitchCh: 'A' }, scene, 3)),
    // «Demon» — не «demo»
    ev(2, 'boss', page({ switch1Valid: true, switch1Id: 6 }, scene)),
    // Сцена по номеру общего события в переменной; флаг сцены «【回想】…管理…» — не состояние, «管理フラグ» и «Debug mode» — состояние
    ev(3, '回想', page({}, [cmd(111, [0, 8, 0]), cmd(122, [4, 4, 0, 0, 11], 1), cmd(412)])),
    ev(4, 'state', page({ switch1Valid: true, switch1Id: 9 }, scene)),
    ev(5, 'debug', page({ switch1Valid: true, switch1Id: 10 }, scene)),
    // Не входы: дверь, переход внутри комнаты, сцена на автозапуске сама по себе
    ev(6, '出口', page({}, [cmd(201, [0, 9, 1, 1, 2, 0])])),
    ev(7, 'EV007', page({}, [cmd(201, [0, 1, 2, 2, 2, 0])])),
    ev(8, 'EV008', page({ switch1Valid: true, switch1Id: 3 }, scene, 4)),
  ] };
  const infos = [null, { id: 1, name: '回想部屋' }, { id: 2, name: 'Warehouse' }, { id: 3, name: 'Debug Room' }];
  const r = findScenes({ names, vnames, infos, maps: { 1: room }, ces });
  // 5 событий + 3 сцены меню (одна — за sw7)
  assert.deepStrictEqual(r.count, { before: 2, after: 6, total: 8 });
  assert.deepStrictEqual(r.scenes.map((x) => x.id).sort((a, b) => a - b), [5, 6, 7, 8]);
  assert.deepStrictEqual(r.selfs, [], 'A не включаем: сцена началась бы сама');
  // Вход в комнату — меню, которое туда переносит (без него комната — пустая карта)
  assert.deepStrictEqual(findRoomEntry({ infos, ces, rooms: [infos[1]], maps: { 1: room } }), { kind: 'event', ce: 1, name: '回想代表', to: [1, 5, 5, 2], menu: true, saves: false });

  // Зал сцен: 12 событий по кнопке со сценой, без автозапуска сцен; «Debug Room» — не зал; пустая комната по имени — ищем дальше
  const hall = { events: [null, ...Array.from({ length: 12 }, (_, i) => ev(i + 1, `S${i}`, page({}, scene))), ev(13, 'door', page({}, [cmd(201, [0, 1, 1, 1])]))] };
  const maps = { 1: { events: [] }, 2: hall, 3: hall };
  assert.deepStrictEqual(hubRooms({ infos, maps, names, ces: [] }).map((m) => m.name), ['Warehouse']);
  assert.deepStrictEqual(pickRooms({ infos, maps, names, ces: [] }).map((m) => m.name), ['Warehouse']);
  const story = { events: [null, ...Array.from({ length: 12 }, (_, i) => ev(i + 1, `S${i}`, page({}, scene))), ev(13, 'auto', page({}, scene, 3)), ev(14, 'auto', page({}, scene, 3))] };
  assert.deepStrictEqual(hubRooms({ infos, maps: { 2: story }, names, ces: [] }), [], 'сцены, которые начинаются сами, — сюжетная карта');

  // Состояние или флаг сцены — по словам: сильные слова — состояние всегда, формы слов тоже; «Flashback» — не «back»
  const flagNames = ['', 'Recollection Mode', '回想：禁止', 'Skipping', 'BGMOff', 'Test switch', '【回想】管理兵', 'Flashback seen', 'u_testsAreOut'];
  const flagRoom = { events: [null, ...flagNames.slice(1).map((n, i) => ev(i + 1, `E${i}`, page({ switch1Valid: true, switch1Id: i + 1 }, scene))),
    ev(20, 'Flashback 3', page({}, [cmd(201, [0, 9, 1, 1, 2, 0])])), ev(21, 'Back door', page({}, [cmd(201, [0, 9, 1, 1, 2, 0])]))] };
  const fr = findScenes({ names: flagNames, infos: [null, { id: 1, name: '回想部屋' }], maps: { 1: flagRoom } });
  assert.deepStrictEqual([fr.scenes.map((x) => x.id), fr.count], [[6, 7, 8], { before: 1, after: 4, total: 9 }], '«u_testsAreOut» — счётчик сюжета, не «test»');
});

test('чит-меню: «В комнату воспоминаний» — своё окно плагина, общее событие-вход, событие-вход на карте, иначе перенос', () => {
  const cmd0 = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const src = fs.readFileSync(path.join(__dirname, 'public', 'cheats.js'), 'utf8');
  const did = [];
  let running = false;
  const win = { addEventListener() {} };
  const sw = {};
  class Scene_Map {}
  const sm = { _scene: new Scene_Map(), push: (cls) => did.push(['scene', cls.name]) };
  let moving = false;
  new Function('window', 'location', 'localStorage', 'SceneManager', 'Scene_Map', '$gameMap', '$gameTemp', '$gamePlayer', '$gameSwitches', '$dataCommonEvents', src)(
    win, { search: '' }, { getItem: () => null }, sm, Scene_Map,
    { isEventRunning: () => running, mapId: () => 1, _interpreter: { setup: (list, ev) => did.push(['run', list.length, ev]) } },
    { reserveCommonEvent: (id) => did.push(['ce', id]) },
    { reserveTransfer: (...a) => did.push(['go', ...a]), isTransferring: () => moving },
    { value: (id) => !!sw[id] },
    [null, null, null, { id: 3, list: [cmd0(201, [0, 2, 9, 16, 8, 0]), cmd0(0)] }]);
  const { findRoomEntry, roomScene, goRoom } = win.__rpgCheats;
  const cmd = cmd0;
  const to = (map, x, y, d = 2) => cmd(201, [0, map, x, y, d, 0]);
  const ev = (id, name, list) => ({ id, name, pages: [{ conditions: {}, list: [...list, cmd(0)] }] });
  const infos = [null, { id: 1, name: '町' }, { id: 2, name: '回想部屋' }, { id: 3, name: '回想用MAP' }];
  const rooms = [infos[2]];
  const room = { width: 20, height: 10, events: [] };

  // Общее событие-вход: имя про переход, переносит в комнату. Сцены с «回想» в имени — не вход
  const ces = [null,
    { id: 1, name: 'おもらし回想', list: [cmd(231, [1, 'cg']), to(2, 5, 5), cmd(0)] },
    { id: 2, name: '回想部屋から戻る', list: [to(2, 1, 1), cmd(0)] },
    { id: 3, name: '回想部屋に飛ぶ', list: [to(2, 9, 16, 8), cmd(0)] }];
  assert.deepStrictEqual(findRoomEntry({ infos, ces, rooms, maps: {} }), { kind: 'event', ce: 3, name: '回想部屋に飛ぶ', to: [2, 9, 16, 8], saves: false });

  // Событие-вход на обычной карте важнее такого же на карте сцены; событие, показывающее картинку, — сцена
  const town = { events: [null,
    ev(1, 'Recollection Crystal', [cmd(102, [['Yes', 'No']]), to(2, 8, 6)]),
    ev(2, '回想', [cmd(231, [1, 'cg']), to(2, 3, 3)]),
    ev(3, 'EV003', [to(2, 4, 4)])] };
  const back = { events: [null, ev(1, '回想部屋へ', [to(2, 7, 7)])] };
  const found = findRoomEntry({ infos, ces: ces.slice(0, 3), rooms, maps: { 1: town, 2: room, 3: back } });
  assert.deepStrictEqual([found.kind, found.name, found.map, found.to, found.list.length, found.saves], ['event', 'Recollection Crystal', '町', [2, 8, 6, 2], 3, false]);
  // Сцена через общее событие — тоже не вход; вход, который сам сохраняет игру (в том числе через общее событие), помечен
  const viaCe = { events: [null, ev(1, 'Recollection Crystal', [cmd(117, [1]), to(2, 8, 6)]), ev(2, '回想部屋へ', [cmd(117, [4]), to(2, 7, 7)])] };
  const saving = findRoomEntry({ infos, ces: [null, ces[1], ces[2], null, { id: 4, name: 'オートセーブ', list: [cmd(356, ['SaveCommand save 1 notime']), cmd(0)] }], rooms, maps: { 1: viaCe, 2: room } });
  assert.deepStrictEqual([saving.name, saving.saves], ['回想部屋へ', true]);

  // Входа нет — туда, куда чаще всего переносят (0,0 — «с переменных», не считаем); переносов нет — середина комнаты
  const plain2 = { events: [null, ev(1, 'EV001', [to(2, 4, 4)]), ev(2, 'EV002', [to(2, 4, 4)]), ev(3, 'EV003', [to(2, 0, 0)]), ev(4, 'EV004', [to(2, 0, 0)]), ev(5, 'EV005', [to(2, 0, 0)])] };
  assert.deepStrictEqual(findRoomEntry({ infos, ces: [], rooms, maps: { 1: plain2, 2: room } }), { kind: 'teleport', to: [2, 4, 4, 2] });
  assert.deepStrictEqual(findRoomEntry({ infos, ces: [], rooms, maps: { 2: room } }), { kind: 'teleport', to: [2, 10, 5, 2] });
  assert.strictEqual(findRoomEntry({ infos, ces: [], rooms, maps: {} }), null);
  assert.strictEqual(findRoomEntry({ infos, ces, rooms: [], maps: {} }), null);

  // Окно плагина
  function Scene_Recollection() {}
  assert.strictEqual(roomScene({}), '');
  assert.strictEqual(roomScene({ Scene_Recollection }), 'Scene_Recollection');
  win.Scene_Recollection = Scene_Recollection;

  // Переход: окно — всегда; остальное — только когда событие не идёт
  assert.strictEqual(goRoom({ kind: 'scene', scene: 'Scene_Recollection' }), true);
  assert.strictEqual(goRoom({ kind: 'event', ce: 3, to: [2, 9, 16, 8] }), true);
  assert.strictEqual(goRoom(found), true);
  assert.strictEqual(goRoom({ kind: 'teleport', to: [2, 4, 4, 0] }), true);
  // Вход закрыт по сюжету («если комната открыта — пойти?, иначе „ещё закрыто“») — переносим сами; открыт — идём им
  const gate = { kind: 'event', to: [2, 9, 3, 2], list: [cmd(111, [0, 84, 0]), cmd(102, [['Да', 'Нет']], 1), cmd(402, [0], 1), to(2, 9, 3), cmd(0, [], 2), cmd(411), cmd(101, [], 1), cmd(412), cmd(0)] };
  gate.list[3].indent = 2;
  goRoom(gate);
  sw[84] = true;
  goRoom(gate);
  // Сам сохраняет игру — не запускаем, переносим
  goRoom({ ...gate, saves: true });
  goRoom({ kind: 'event', ce: 3, to: [2, 9, 16, 8], saves: true });
  // Не на карте, в переносе, в событии — никуда, и окно плагина тоже
  sm._scene = {};
  assert.strictEqual(goRoom({ kind: 'scene', scene: 'Scene_Recollection' }), false);
  sm._scene = new Scene_Map();
  moving = true;
  assert.strictEqual(goRoom({ kind: 'teleport', to: [2, 4, 4, 2] }), false);
  moving = false;
  running = true;
  assert.strictEqual(goRoom({ kind: 'teleport', to: [2, 4, 4, 2] }), false);
  assert.deepStrictEqual(did, [['scene', 'Scene_Recollection'], ['ce', 3], ['run', 3, 0], ['go', 2, 4, 4, 2, 0], ['go', 2, 9, 3, 2, 0], ['run', 9, 0],
    ['go', 2, 9, 3, 2, 0], ['go', 2, 9, 16, 8, 0]]);
});

test('чит-меню (cheats.js): бессмертие только у выбранного героя, скорость держится, сквозь стены, без боёв, переменные, бой', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'cheats.js'), 'utf8');
  class Game_BattlerBase {
    constructor() { this.hp = 10; this.mhp = 100; this.mp = 5; this.mmp = 50; this.tp = 0; this.states = []; }
    setHp(v) { this.hp = v; } setMp(v) { this.mp = v; } setTp(v) { this.tp = v; } maxTp() { return 100; }
  }
  class Game_Battler extends Game_BattlerBase { addState(id) { this.states.push(id); } deathStateId() { return 1; } }
  class Game_Actor extends Game_Battler {
    constructor(id) { super(); this.id = id; this.level = 5; this.exp = 100; this.params = []; }
    actorId() { return this.id; } recoverAll() { this.hp = this.mhp; this.mp = this.mmp; } refresh() {}
    maxLevel() { return 99; } changeLevel(l) { this.level = l; } currentExp() { return this.exp; } changeExp(e) { this.exp = e; }
    addParam(id, v) { this.params[id] = (this.params[id] || 0) + v; }
  }
  // Как в движке: HP 0 при refresh — состояние смерти
  class Game_Enemy extends Game_Battler { performCollapse() { this.collapsed = true; } isDead() { return this.hp === 0; } refresh() { if (this.hp === 0) this.addState(this.deathStateId()); } }
  class Game_Player { setMoveSpeed(v) { this.speed = v; } isThrough() { return false; } canEncounter() { return true; }
    reserveTransfer(...a) { this.transfer = a; } direction() { return 2; } }
  const hero = new Game_Actor(1);
  const friend = new Game_Actor(2);
  const enemies = [new Game_Enemy(), new Game_Enemy()];
  const vars = {};
  let gold = 1000;
  const bag = [];
  const $gameParty = { members: () => [hero, friend], gainGold: (n) => { gold += n; }, loseGold: (n) => { gold -= n; }, gainItem: (it, n) => bag.push([it.id, n]), inBattle: () => true };
  const $gameVariables = { setValue: (id, v) => { vars[id] = v; }, value: (id) => vars[id] };
  const switches = {};
  const $gameSwitches = { setValue: (id, v) => { switches[id] = v; }, value: (id) => !!switches[id] };
  const $gameTroop = { aliveMembers: () => enemies.filter((e) => !e.isDead()) };
  const $gamePlayer = new Game_Player();
  // Плагин игры переопределил setHp героя и зовёт запомненную базовую функцию (так в 星降る宿) —
  // бессмертие всё равно держит
  const baseSetHp = Game_BattlerBase.prototype.setHp;
  Game_Actor.prototype.setHp = function(v) { baseSetHp.call(this, v); };
  const win = { addEventListener() {} };
  new Function('window', 'location', 'localStorage', 'Game_BattlerBase', 'Game_Battler', 'Game_Actor', 'Game_Player',
    '$gameParty', '$gameVariables', '$gameSwitches', '$gameTroop', '$gamePlayer', src)(win, { search: '' }, { getItem: () => null },
    Game_BattlerBase, Game_Battler, Game_Actor, Game_Player, $gameParty, $gameVariables, $gameSwitches, $gameTroop, $gamePlayer);
  const a = win.__rpgCheats.actions;

  a.setGod(hero, true);
  hero.setHp(3); hero.setMp(0); hero.addState(1); hero.addState(5);
  friend.setHp(3); friend.addState(1);
  assert.deepStrictEqual([hero.hp, hero.mp, hero.states, friend.hp, friend.states], [100, 50, [5], 3, [1]], 'смерти и потерь нет только у бессмертного');
  a.setGod(hero, false);
  hero.setHp(7);
  assert.strictEqual(hero.hp, 7);

  a.speed(6); a.lockSpeed(true);
  $gamePlayer.setMoveSpeed(3);
  assert.strictEqual($gamePlayer.speed, 6, 'событие скорость не сбросило');
  a.lockSpeed(false);
  $gamePlayer.setMoveSpeed(3);
  assert.strictEqual($gamePlayer.speed, 3);
  a.noclip(true); a.noEncounters(true);
  assert.deepStrictEqual([$gamePlayer.isThrough(), $gamePlayer.canEncounter()], [true, false]);
  a.noclip(false); a.noEncounters(false);
  assert.deepStrictEqual([$gamePlayer.isThrough(), $gamePlayer.canEncounter()], [false, true]);

  a.setVariable(4, '12'); a.setVariable(5, 'Алиса'); a.setVariable(6, '');
  assert.deepStrictEqual([vars[4], vars[5], vars[6]], [12, 'Алиса', '']);
  a.gold(-300); a.gold(50);
  assert.strictEqual(gold, 750);
  a.level(hero, -10); a.level(friend, 200); a.exp(hero, 1000); a.param(hero, 2, 10); a.param(hero, 2, -3);
  assert.deepStrictEqual([hero.level, friend.level, hero.exp, hero.params[2]], [1, 99, 1100, 7], 'уровень — от 1 до предела');
  a.give({ id: 7 }, 10); a.toggleSwitch(3); a.toggleSwitch(3); a.toggleSwitch(4);
  assert.deepStrictEqual([bag, switches[3], switches[4]], [[[7, 10]], false, true]);
  enemies.push(new Game_Enemy());
  a.enemiesToOne();
  assert.strictEqual(enemies[2].hp, 1);
  a.win();
  assert.ok(enemies.every((e) => e.hp === 0 && e.collapsed && e.states.includes(1)));
  a.teleport(3, 10, 12);
  assert.deepStrictEqual($gamePlayer.transfer, [3, 10, 12, 2, 0]);
});

test('лицензия: AGPL-3.0 везде одинаково — LICENSE, package.json, метка образа', (t) => {
  const repo = path.join(__dirname, '..');
  if (!fs.existsSync(path.join(repo, 'LICENSE'))) return t.skip('нет корня репозитория (тесты в контейнере)');
  assert.match(fs.readFileSync(path.join(repo, 'LICENSE'), 'utf8'), /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
  for (const p of ['api/package.json', 'frontend/package.json']) assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, p), 'utf8')).license, 'AGPL-3.0-only', p);
  assert.match(fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8'), /org\.opencontainers\.image\.licenses="AGPL-3\.0-only"/);
  assert.ok(fs.existsSync(path.join(repo, 'THIRD_PARTY_NOTICES.md')));
});

test('перевод: защита — части тегов заметок и параметры плагинов, в том числе с экранированием', () => {
  const { makeGuard } = require('./src/utils/gametext.js');
  const guard = makeGuard({
    scripts: ['<Drop: 薬草 3>\n<Steal:毒消し,2>', "if (v === '\\\\C[2]鍵') {}"],
    plugins: 'var $plugins = [{"name":"Shop","parameters":{"Items":"[\\"{\\\\\\"name\\\\\\":\\\\\\"黄金の剣\\\\\\"}\\"]","Msg":"\\\\C[2]完了"}}];',
    pluginFiles: ["const NAME = 'ゴブリン'; const t = \"\\\\C[3]注意\";"],
  });
  for (const s of ['薬草', '毒消し', 'ゴブリン', '\\C[3]注意']) assert.ok(guard(s), s);
  // Имя товара и сообщение в параметрах — видимый текст: переводится тем же словарём, что и предмет
  for (const s of ['黄金の剣', '\\C[2]完了', '冒険の始まり']) assert.ok(!guard(s), s);
});

test('перевод: одна игра разбирается один раз на все запросы; не вышедшие строки не шлются снова; выключили — перевод встаёт', async (t) => {
  const { open } = require('sqlite');
  const sqlite3 = require('sqlite3');
  const { TranslateService } = require('./src/services/translate.js');
  const secrets = require('./src/utils/secrets.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-once-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tlGame(root);
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  await db.exec(`CREATE TABLE translations (src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
  await db.exec(`CREATE TABLE game_translation (id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
    check_at INTEGER NOT NULL DEFAULT 0, check_result TEXT NOT NULL DEFAULT '')`);
  secrets.setSavedSecret('deepl', 'k:fx');
  t.after(() => secrets.setSavedSecret('deepl', ''));
  const svc = new TranslateService();
  svc.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  t.mock.method(console, 'log', () => {});
  const read = t.mock.method(svc, 'readGameText');
  await Promise.all(Array.from({ length: 20 }, () => svc.gameText('G')));
  assert.strictEqual(read.mock.callCount(), 1, 'двадцать запросов разом — один разбор');

  // Служба портит все строки с кодами — их отмечаем и второй раз не шлём
  const sent = [];
  svc.engines = { deepl: async (texts) => { sent.push(...texts); return texts.map((s) => (s.includes('<x') ? 'broken' : `[EN] ${s}`)); } };
  await svc.setLang('G', 'en');
  await svc.running;
  const firstFailed = (await svc.status('G')).failed;
  assert.ok(firstFailed > 0);
  sent.length = 0;
  svc.enqueue('G', 'en');
  await svc.running;
  assert.deepStrictEqual(sent, [], 'второй раз нечего слать: переведённое — в словаре, испорченное — отмечено');
  assert.strictEqual(await svc.overlay('G', 'Map001', fs.readFileSync(path.join(root, 'G', 'www', 'data', 'Map001.json'))) !== null, true);

  // Перевод на другой язык идёт, а его выключили — следующую пачку уже не шлём
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  svc.engines = { deepl: async (texts) => { calls++; await gate; return texts.map((s) => `[RU] ${s}`); } };
  const { BATCH } = require('./src/services/translate.js');
  const prev = BATCH.deepl.lines;
  BATCH.deepl.lines = 2;
  t.after(() => { BATCH.deepl.lines = prev; });
  await svc.setLang('G', 'ru');
  for (let i = 0; i < 100 && !calls; i++) await new Promise((r) => setTimeout(r, 5));
  await svc.setLang('G', '');
  release();
  await svc.running;
  assert.strictEqual(calls, 1, 'после выключения служба больше не спрашивается');

  // Лимит, отмеченный у службы, снимается новым ключом; после перезапуска «идёт» не висит
  await db.run("INSERT INTO settings (key, value) VALUES ('tl_exhausted_deepl', '2026-10')");
  await svc.clearExhausted('deepl');
  assert.strictEqual(await db.get("SELECT value FROM settings WHERE key = 'tl_exhausted_deepl'"), undefined);
  await db.run("UPDATE game_translation SET lang = 'ru', state = 'running' WHERE id = 'G'");
  const fresh = new TranslateService();
  fresh.setDependencies({ dbService: { get: () => db }, gamesDir: root });
  fresh.engines = { deepl: async (texts) => texts.map((s) => `[RU] ${s}`) };
  await fresh.recover();
  await fresh.running;
  assert.strictEqual((await fresh.status('G')).state, 'done', 'прерванный перезапуском — доделан');
});

test('перевод: лимит месяца отличаем от сбоя — по ответу службы', async (t) => {
  const { TranslateService, QuotaError } = require('./src/services/translate.js');
  const svc = new TranslateService();
  const reply = (status, body) => t.mock.method(globalThis, 'fetch', async () => ({ ok: status < 300, status, json: async () => body }));
  const kind = async (engine) => svc.engines[engine](['x'], 'en', 'k|r').then(() => 'ok', (e) => (e instanceof QuotaError ? 'quota' : 'error'));
  reply(403, { error: { code: 403001, message: 'quota' } });
  assert.strictEqual(await kind('microsoft'), 'quota');
  reply(429, { error: { code: 429001 } });
  assert.strictEqual(await kind('microsoft'), 'error', '«слишком часто» — повтор, а не лимит месяца');
  reply(403, { error: { code: 401000 } });
  assert.strictEqual(await kind('microsoft'), 'error');
  reply(403, { error: { status: 'RESOURCE_EXHAUSTED', errors: [{ reason: 'rateLimitExceeded' }] } });
  assert.strictEqual(await kind('google'), 'quota');
  reply(403, { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured' }] } });
  assert.strictEqual(await kind('google'), 'error', 'API выключен — не лимит');
  reply(456, {});
  assert.strictEqual(await kind('deepl'), 'quota');
});

test('галерея: сценарий сцены — картинки, реплики с именем, звук и паузы по порядку; другие ветки и повторы цикла не пишутся', async (t) => {
  const { runList, analyze, speech } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, indent = 0) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0], indent);
  const snd = (code, name, volume = 90, pitch = 100) => c(code, [{ name, volume, pitch, pan: 0 }]);
  const files = { bgm: { theme: 'audio/bgm/Theme.ogg' }, se: { door: 'audio/se/Door.ogg', hey: 'audio/se/voice_hey.ogg' } };
  const audioOf = (kind, name) => { const rel = files[kind]?.[name.toLowerCase()]; return rel ? { rel, voice: /voice_/.test(rel) } : null; };
  const names = ['cg/body', 'cg/over', 'cg/yes'];
  const ctx = { names, has: (n) => names.includes(n), audio: audioOf };
  const list = [
    snd(241, 'Theme', 80), show(1, 'cg/body'),
    c(101, ['', 0, 0, 2, 'Anna']), c(401, ['\\C[2]Hello,']), c(401, ['second line.']),
    snd(250, 'Door'), snd(250, 'Hey', 70, 120), snd(250, 'Нет такого'),
    c(230, [60]),
    c(122, [5, 5, 0, 0, 7]),
    show(2, 'cg/over'), c(101, ['', 0, 0, 2]), c(401, ['\\n<Bob>Hi \\V[5]!']),
    c(242, [2]),
    // Выбор: идём по первой ветке с картинками; вторая — вариант, в сценарий не попадает
    c(102, [['Yes', 'No'], 1, 0, 2, 0]),
    c(402, [0, 'Yes']), show(3, 'cg/yes', 1), c(101, ['', 0, 0, 2], 1), c(401, ['You said yes'], 1), c(0, [], 1),
    c(402, [1, 'No'], 0), c(101, ['', 0, 0, 2], 1), c(401, ['You said no'], 1), c(0, [], 1),
    c(404, []),
    // Цикл идёт три раза, а реплика в сценарии одна
    c(122, [9, 9, 0, 0, 0]), c(112),
    c(122, [9, 9, 1, 0, 1], 1), c(101, ['', 0, 0, 2], 1), c(401, ['tick'], 1), c(111, [1, 9, 0, 3, 0], 1), c(113, [], 2), c(412, [], 1), c(413),
    c(0)];
  const r = runList(list, [], ctx);
  const short = (x) => (x.k === 'pics' ? `pics:${x.pics.map((p) => p.name).join('+')}` : x.k === 'say' ? `say:${x.n || ''}|${x.l.join('/')}` : x.k === 'snd' ? `snd:${x.kind}:${x.f}:${x.vol}:${x.pitch}`
    : x.k === 'choice' ? `choice:${x.o.join(',')}:${x.i}` : x.k === 'stop' ? `stop:${x.kind}:${x.fade}` : `${x.k}:${x.n}`);
  assert.deepStrictEqual(r.scenario.map(short), [
    'snd:bgm:audio/bgm/Theme.ogg:80:100', 'pics:cg/body', 'say:Anna|\\C[2]Hello,/second line.',
    'snd:se:audio/se/Door.ogg:90:100', 'snd:voice:audio/se/voice_hey.ogg:70:120', 'wait:60',
    'pics:cg/body+cg/over', 'say:|\\n<Bob>Hi \\V[5]!', 'stop:bgm:2',
    'choice:Yes,No:0', 'pics:cg/body+cg/over+cg/yes', 'say:|You said yes', 'say:|tick']);
  assert.deepStrictEqual(r.scenario.find((x) => x.k === 'say' && x.l[0].includes('Bob')).v, { 5: 7 }, 'значение переменной, пока событие её не сменило');

  // Группа сцены: шаг-картинка — готовая картинка альбома; без реплик и звука сценария нет
  const kinds = { 'cg/body': 'cg', 'cg/over': 'layer', 'cg/yes': 'layer' };
  const { groups } = analyze([{ id: 'ce1', name: 'Сцена', where: '', list }], [], (n) => kinds[n] || null, () => false, names, [], () => false, audioOf);
  assert.strictEqual(groups.length, 1);
  const pics = groups[0].script.filter((x) => x.k === 'pic');
  assert.deepStrictEqual(pics.map((x) => x.item.name || x.item.layers.map((l) => l.name)), ['cg/body', ['cg/body', 'cg/over'], ['cg/body', 'cg/over', 'cg/yes']]);
  const quiet = analyze([{ id: 'ce2', name: 'Тихо', where: '', list: [show(1, 'cg/body'), c(231, [2, 'cg/over', 0, 0, 0, 0, 100, 100, 255, 0]), c(230, [30]), c(0)] }], [], (n) => kinds[n] || null, () => false, names, [], () => false, audioOf);
  assert.ok(quiet.groups.every((g) => !g.script), 'ни реплик, ни звука — смотреть нечего');

  // Строки окна сообщения → говорящий и текст: окно имени, «\n<Имя>», «【Имя】», «Имя:» над текстом; коды убираются, слова остаются
  assert.deepStrictEqual(speech(['\\C[4]【Freya】\\C[0]', '"Hey \\V[3] there"'], '', { 3: 5 }), { who: 'Freya', text: '"Hey 5 there"' });
  assert.deepStrictEqual(speech(['\\n<\\N[1]>Hello \\N[2]!'], '', {}, [null, 'Ann', 'Bob']), { who: 'Ann', text: 'Hello Bob!' });
  assert.deepStrictEqual(speech(['Rikill:', '　Sea of the End'], ''), { who: 'Rikill', text: 'Sea of the End' });
  assert.deepStrictEqual(speech(['\\C[17]【King】', '\\C[0]Hm?'], ''), { who: 'King', text: 'Hm?' });
  assert.deepStrictEqual(speech(['hi \\{big\\} \\! \\.'], '\\C[2]Bob\\C[0]'), { who: 'Bob', text: 'hi big' });
  assert.deepStrictEqual(speech(['Time: 5'], ''), { who: '', text: 'Time: 5' }, 'не имя, если в строке есть что-то после двоеточия');
  assert.strictEqual(speech(['the pleasure potion, but', 'she got hooked.', 'Next.'], '').text, 'the pleasure potion, but she got hooked.\nNext.', 'строки окна одной фразы склеиваются');
  assert.strictEqual(speech(['こんにちは', '元気ですか'], '').text, 'こんにちは\n元気ですか');
  assert.strictEqual(speech(['Value \\V[9]'], '').text, 'Value ?', 'переменной не знаем — вопрос, а не пусто');
  // Коды из чужих плагинов («\-» в «\-finish.\-») и любые односимвольные не показываем
  assert.deepStrictEqual(speech(['\\-finish.\\-'], ''), { who: '', text: 'finish.' });
  assert.strictEqual(speech(['a\\~b\\_c'], '').text, 'abc');
  // Переменная сама несёт код («\x1bN[14]» с ESC вместо косой — её кладёт скрипт события): разбираем вложенно, как игра
  assert.deepStrictEqual(speech(['\\N<\\V[631]>Wow'], '', { 631: '\x1bN[14]' }, Object.assign([], { 14: 'Rain' })), { who: 'Rain', text: 'Wow' });
  assert.strictEqual(speech(['\\V[1]!'], '', { 1: '\\V[2]', 2: 'deep' }).text, 'deep!', 'переменная в переменной');
  assert.strictEqual(speech(['\\V[5]'], '', { 5: '\\V[5]' }).text, '', 'самоссылка не вешает разбор');
  // Перед окном имени — любые коды с номером («\OC[31]», «\CE[83]»), не только «\C»
  assert.deepStrictEqual(speech(['\\CE[83]\\C[13]\\OC[31]\\N<\\N[1]>Ah'], '', {}, [null, 'Ann']), { who: 'Ann', text: 'Ah' });
  // Строка в скрипте события: «\x1b» — настоящий знак, а не «x1b»
  assert.strictEqual(require('./src/services/galleryScenes.js').tokenize("'\\x1bN[14]'")[0].v, '\x1bN[14]');

  // Сборка альбома: сценарий пишется рядом с оглавлением, плеер получает файлы альбома и готовый текст (с переводом, если он есть)
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-script-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  for (const d of ['bgm', 'se']) await fsp.mkdir(path.join(game, 'audio', d), { recursive: true });
  await fsp.writeFile(path.join(game, 'audio', 'bgm', 'Theme.ogg'), 'OggS....');
  await fsp.writeFile(path.join(game, 'audio', 'se', 'Door.ogg'), 'OggS....');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=816x624', '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', 'base.png')]);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue@0.0:s=816x624,format=rgba', '-frames:v', '1', path.join(game, 'img', 'pictures', 'layer.png')]);
  const events = [snd(241, 'Theme'), c(231, [1, 'base', 0, 0, 0, 0, 100, 100, 255, 0]), c(101, ['', 0, 0, 2, 'Anna']), c(401, ['one']),
    snd(250, 'Door'), c(231, [2, 'layer', 0, 0, 0, 0, 100, 100, 255, 0]), c(101, ['', 0, 0, 2]), c(401, ['two']), c(320, [1, 'Boris']), c(101, ['', 0, 0, 2]), c(401, ['\\n<\\N[1]>three']), c(0)];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Сцена', list: events }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  const album = index.albums.find((a) => a.key.startsWith('events/'));
  assert.ok(album && album.script === true, 'альбом со сценарием помечен');
  const scene = await svc.scene('G', album.key);
  assert.deepStrictEqual(scene.files, album.files);
  assert.deepStrictEqual(scene.steps.map((x) => (x.k === 'pic' ? `pic:${x.i}` : x.k === 'say' ? `say:${x.who}|${x.text}` : `${x.k}:${x.kind}:${x.f}`)),
    ['snd:bgm:audio/bgm/Theme.ogg', 'pic:0', 'say:Anna|one', 'snd:se:audio/se/Door.ogg', 'pic:1', 'say:|two', 'say:Boris|three']);
  // Выше (без Actors.json и без переводчика) имя от сцены (a) уже дошло до реплики: «Boris»
  // Перевод: строки идут в переводчик как в игре (по одной строке окна), показывается ответ; имя, которое сцена задала сама, — тоже
  const tr = await svc.scene('G', album.key, async (strings) => new Map(strings.filter((s) => s === 'one' || s === 'Boris').map((s) => [s, s === 'one' ? 'раз' : 'Борис'])));
  assert.deepStrictEqual(tr.steps.filter((x) => x.k === 'say').map((x) => `${x.who}|${x.text}`), ['Anna|раз', '|two', 'Борис|three']);
  assert.strictEqual(await svc.scene('G', 'img/pictures/base'), null, 'не альбом со сценарием');
  assert.strictEqual(await svc.scene('G', 'events/nope'), null);
  assert.strictEqual(await svc.scene('G', ['events']), null);
  assert.match(index.scripts, /^scripts-\d+$/, 'сценарии — в папке своей сборки');
});

test('галерея: сцена, чьи картинки — свой альбом по имени, смотрится из этого альбома', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (name, n = 1) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const say = (text) => [c(101, ['', 0, 0, 2]), c(401, [text])];
  const sw = (on, off) => [c(111, [0, 1, 0]), { ...on, indent: 1 }, c(0, [], 1), c(411), { ...off, indent: 1 }, c(0, [], 1), c(412)];
  const thumb = (name) => c(231, [1, name, 1, 0, 408, 312, 50, 50, 255, 0]);
  const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'white', 'orange', 'pink', 'cyan', 'gray'];
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-byname-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // Одна игра на случай: картинки — шум 816x624, «face…» — прозрачные (слои); события — только общие
  const build = async (label, pics, ces) => {
    const game = path.join(root, label);
    await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
    await fsp.mkdir(path.join(game, 'data'), { recursive: true });
    pics.forEach((n, i) => {
      const [name, ext] = n.includes('.') ? n.split('.') : [n, 'png'];
      const alpha = name.startsWith('face');
      // «win…» — холст во весь экран, прозрачный, с непрозрачным окном (у каждой картинки своё): основа врезки
      const win = name.startsWith('win');
      const out = path.join(game, 'img', 'pictures', `${name}.${ext}`);
      if (win) spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue@0.0:s=816x624,format=rgba', '-f', 'lavfi', '-i', 'color=c=red:s=500x380,noise=alls=100:allf=t,format=rgba',
        '-filter_complex', `overlay=x=${100 * Number(name.replace(/\D/g, ''))}:y=30:format=auto`, '-frames:v', '1', out]);
      else spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', alpha ? 'color=c=blue@0.0:s=816x624,format=rgba' : `color=c=${colors[i % colors.length]}:s=816x624`,
        ...(alpha ? [] : ['-vf', 'noise=alls=100:allf=t']), '-frames:v', '1', out]);
    });
    await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, ...ces.map((list, i) => ({ id: i + 1, name: `Сцена ${i + 1}`, list: [...list, c(0)] }))]));
    await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
    const svc = new GalleryService();
    svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
    svc.vision = { available: false, version: 'test' };
    svc.visionPass = async () => {};
    const index = await svc.runBuild(label, { done: 0, total: 0 });
    const albums = index.albums.map((a) => [a.key.replace(/^events\/\d+\//, 'ev:'), a.kind, a.files.length, !!a.script]);
    const steps = async (key) => {
      const s = await svc.scene(label, key);
      return s && s.steps.map((x) => (x.k === 'pic' ? `pic:${s.files[x.i].startsWith('@cg/') ? '@cg' : s.files[x.i].split('/').pop()}` : x.k === 'say' ? `say:${x.text}` : x.k)).join(' ');
    };
    return { index, albums, steps, svc };
  };
  const two = [show('base'), ...say('one'), show('base2'), ...say('two')];
  const alone = (name) => [show(name), c(230, [60])];

  // Сцена показывает весь альбом по имени и больше никто — «Смотреть сцену» у альбома; сам альбом не меняется
  let r = await build('own', ['base', 'base2'], [two]);
  assert.deepStrictEqual(r.albums, [['img/pictures/base', 'cg', 2, true]]);
  assert.strictEqual(await r.steps('img/pictures/base'), 'pic:base.png say:one pic:base2.png say:two');
  const own = await r.svc.scene('own', 'img/pictures/base');
  assert.deepStrictEqual(own.files, r.index.albums[0].files, 'плеер получает файлы альбома');

  // Одна сцена — два альбома по имени: оба получают сцену целиком
  r = await build('two', ['base', 'base2', 'extra1', 'extra2'], [[...two, show('extra1'), ...say('three'), show('extra2'), ...say('four')]]);
  assert.deepStrictEqual(r.albums.map((a) => a[3]), [true, true]);
  assert.strictEqual(await r.steps('img/pictures/base'), await r.steps('img/pictures/extra'));

  // Её картинок больше, чем чужих: большинство — хозяйка. Поровну или меньше — альбом общий, кнопки нет
  r = await build('majority', ['base', 'base2', 'base3'], [two, alone('base3')]);
  assert.strictEqual(r.albums.find((a) => a[0] === 'img/pictures/base')[3], true, 'две из трёх — сцене');
  r = await build('tie', ['base', 'base2', 'base3', 'base4'], [two, alone('base3'), alone('base4')]);
  assert.strictEqual(r.albums.find((a) => a[0] === 'img/pictures/base')[3], false, 'поровну — ничья');
  assert.strictEqual(await r.svc.scene('tie', 'img/pictures/base'), null);
  r = await build('minority', ['base', 'base2', 'base3', 'base4', 'base5'], [two, alone('base3'), alone('base4'), alone('base5')]);
  assert.strictEqual(r.albums.find((a) => a[0] === 'img/pictures/base')[3], false, 'меньше — не её альбом');

  // Варианты из ветки самой сцены — её; но если их на главной ветке показывает другое событие, оно главнее
  const v = (a, b) => sw(show(a), show(b));
  r = await build('variants', ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'], [[...v('v1', 'v2'), ...say('one'), ...v('v1', 'v3'), ...v('v1', 'v4'), ...v('v1', 'v5'), ...say('two')], alone('v6')]);
  assert.strictEqual(r.albums.find((a) => a[0] === 'img/pictures/v')[3], true);
  assert.strictEqual(await r.steps('img/pictures/v'), 'pic:v1.png say:one say:two');
  r = await build('variantTaken', ['v1', 'v2'], [[...v('v1', 'v2'), ...say('one'), show('v1'), ...say('two')], alone('v2')]);
  assert.strictEqual(r.albums.find((a) => a[0] === 'img/pictures/v')[3], false, 'v2 на главной ветке другого события');

  // «x.png» и «x.jpg» — одна картинка для команды показа
  r = await build('twin', ['base', 'base2', 'base2.jpg', 'base3', 'base4'], [two, alone('base3'), alone('base4')]);
  assert.strictEqual(r.albums.find((a) => a[0] === 'img/pictures/base')[3], true);

  // Плееру нечего показать — без кнопки: ни реплик, или одни пустые окна
  r = await build('quiet', ['base', 'base2'], [[show('base'), c(230, [60]), show('base2'), c(230, [60])]]);
  assert.ok(r.albums.every((a) => !a[3]));
  r = await build('emptyLines', ['page1', 'page2', 'page3'], [[show('page1'), ...say(''), show('page2'), ...say(''), show('page3'), ...say('')]]);
  assert.ok(r.albums.every((a) => !a[3]));

  // Комната воспоминаний показывает миниатюру альбома на главной ветке, а настоящая сцена — только в ветках: альбом общий
  r = await build('replay', ['barA1', 'barA2', 'barB1', 'barB2'], [
    [...v('barB1', 'barA1'), ...say('one'), ...v('barB2', 'barA2'), ...say('two')],
    [thumb('barA1'), ...say('I should not remember this'), c(117, [1])]]);
  assert.strictEqual(r.albums.find((a) => a[0] === 'img/pictures/barA')[3], false);
  assert.strictEqual(await r.steps(r.index.albums.find((a) => a.key.startsWith('events/')).key), 'pic:barB1.png say:one pic:barB2.png say:two');

  // События со склейкой остаются как были, рядом — сцена по имени
  r = await build('combined', ['room', 'face1', 'face2', 'extra1', 'extra2'], [
    [show('room'), show('face1', 2), ...say('hello'), show('face2', 2), ...say('bye')],
    [show('extra1'), ...say('three'), show('extra2'), ...say('four')]]);
  assert.deepStrictEqual(r.albums.map((a) => [a[0], a[1], a[2], a[3]]).sort(),
    [['ev:Сцена 1', 'cg', 2, true], ['img/pictures/extra', 'cg', 2, true], ['img/pictures/face', 'layer', 2, false]].sort());
  assert.strictEqual(await r.steps(r.index.albums.find((a) => a.key.startsWith('events/')).key), 'pic:@cg say:hello pic:@cg say:bye');

  // Склейка сценария по имени (основа — окно на холсте во весь экран) не меняет обрезку склейки альбома события,
  // у которой та же картинка — слой. Рамки у картинки нет в замерах прошлой сборки (как у игр до рамок): её домеривают
  // только основе. Сравниваем с игрой без этой сцены. Шаг сцены «окно + лицо» не попадает в кадры альбомов (за ним ждут
  // вспышку), поэтому склейка для него — новая, от блока раздачи
  const crops = async (x) => Object.values(JSON.parse(await fsp.readFile(x.svc.scenesPath(x.label), 'utf8'))).map((l) => JSON.stringify(l[0].crop || null)).sort();
  const noBox = async (x) => {
    const file = path.join(path.dirname(x.svc.indexPath(x.label)), 'gallery-opaque.json');
    const known = JSON.parse(await fsp.readFile(file, 'utf8'));
    for (const rel of Object.keys(known)) if (/win2\./.test(rel)) known[rel] = known[rel].slice(0, 3);
    await fsp.writeFile(file, JSON.stringify(known));
    x.index = await x.svc.runBuild(x.label, { done: 0, total: 0 });
  };
  const event1 = [show('win1'), show('win2', 2), ...say('hello'), show('win2', 3), ...say('bye')];
  const scene2 = [show('extra1'), ...say('three'), show('extra2'), ...say('four'), show('win2'), show('face1', 2), c(224, [[255, 255, 255, 255], 10, true]), c(235, [2])];
  const withLabel = (x, label) => Object.assign(x, { label });
  const control = withLabel(await build('cropControl', ['win1', 'win2', 'extra1', 'extra2', 'face1'], [event1]), 'cropControl');
  r = withLabel(await build('cropHosted', ['win1', 'win2', 'extra1', 'extra2', 'face1'], [event1, scene2]), 'cropHosted');
  await noBox(control);
  await noBox(r);
  const base = await crops(control);
  assert.ok(base.some((x) => x !== 'null'), 'у склейки события есть обрезка по окну');
  assert.ok(r.index.albums.some((a) => a.key === 'img/pictures/extra' && a.script), 'сцена по имени получила сценарий');
  assert.ok(Object.values(JSON.parse(await fsp.readFile(r.svc.scenesPath('cropHosted'), 'utf8'))).some((l) => l[0].rel.endsWith('win2.png') && l[1]?.rel.endsWith('face1.png')), 'склейка блока раздачи есть');
  const got = await crops(r);
  for (const x of base) assert.ok(got.includes(x), `обрезка склейки события та же: ${x} (${got})`);

  // Блок раздачи с ошибкой: сборка как без него — альбомы те же, сценария по имени нет
  const speech = require('./src/services/galleryScenes.js').speech;
  require('./src/services/galleryScenes.js').speech = () => { throw new Error('сбой раздачи'); };
  try { r = await build('boom', ['base', 'base2'], [two]); } finally { require('./src/services/galleryScenes.js').speech = speech; }
  assert.deepStrictEqual(r.albums, [['img/pictures/base', 'cg', 2, false]]);
  assert.strictEqual(await r.svc.scene('boom', 'img/pictures/base'), null);
});

test('галерея: сценарий сцены — эффекты экрана, паузы «ждать завершения», голоса SimpleVoice и звук из скриптов', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const files = { se: { door: 'audio/se/Door.ogg' }, bgm: { theme: 'audio/bgm/Theme.ogg' }, voice: { moan: 'audio/voice/moan.ogg', breath: 'audio/voice/breath.ogg', 'ミカ　んぁっ': 'audio/voice/mika.ogg' } };
  const names = ['cg/body'];
  const ctx = { names, has: (n) => names.includes(n), audio: (kind, name) => { const rel = files[kind]?.[name.toLowerCase()]; return rel ? { rel, voice: false } : null; } };
  const r = runList([
    // Вспышка сразу после показа картинки — уже по ней
    c(231, [1, 'cg/body', 0, 0, 0, 0, 100, 100, 255, 0]), c(224, [[255, 0, 0, 255], 5, false]),
    c(231, [1, 'cg/body', 0, 0, 0, 0, 100, 100, 0, 0]),
    // Проявление за 30 кадров с ожиданием: плеер показывает конечный вид и ждёт
    c(232, [1, 0, 0, 0, 0, 0, 100, 100, 255, 0, 30, true]),
    c(224, [[255, 255, 255, 170], 20, true]), c(225, [5, 9, 40, false]), c(223, [[-68, -68, -68, 0], 60, false]),
    c(356, ['SV_PLAY_VOICE moan 80']), c(356, ['SV_ボイスのループ演奏 breath 90 100 0 2']),
    c(357, ['SimpleVoice', 'PLAY_VOICE', 'ボイスの演奏', { name: 'moan', volume: '50', pitch: '100', pan: '0', channel: '1', loop: 'false' }]),
    c(356, ['SV_STOP_VOICE']),
    c(355, ['AudioManager.playSe({name: "Door", volume: 60, pitch: 100});']),
    c(355, ['AudioManager.playBgm({"name":bgmName,"volume":90});']), c(655, ['AudioManager.fadeOutBgm(2);']),
    c(355, ["if ($gameSwitches.value(3)) AudioManager.playBgm({name: 'Theme', volume: 70});"]), c(655, ['AudioManager.stopBgm();']),
    c(355, ['AudioManager.playVoice({"name":"breath","volume":40})']),
    // Имя файла с «　» внутри: SimpleVoice в MV делит команду только по ASCII-пробелу
    c(356, ['SV_ボイスの演奏 ミカ　んぁっ 90 100 0 1']),
    c(101, ['', 0, 0, 2]), c(401, ['hi']), c(0)], [], ctx);
  const short = (x) => (x.k === 'pics' ? `pics:${x.pics.map((p) => `${p.name}@${p.op}`).join('+')}` : x.k === 'snd' ? `snd:${x.kind}:${x.f}:${x.vol}${x.ch ? `:ch${x.ch}` : ''}`
    : x.k === 'fx' ? `fx:${x.t}:${x.n}` : x.k === 'stop' ? `stop:${x.kind}:${x.fade}` : x.k === 'say' ? `say:${x.l.join('/')}` : `${x.k}:${x.n}`);
  assert.deepStrictEqual(r.scenario.map(short), [
    'pics:cg/body@255', 'fx:flash:5', 'wait:30', 'fx:flash:20', 'wait:20', 'fx:shake:40', 'fx:tint:60',
    'snd:voice:audio/voice/moan.ogg:80', 'snd:vloop:audio/voice/breath.ogg:90:ch2', 'snd:voice:audio/voice/moan.ogg:50', 'stop:voice:0',
    'snd:se:audio/se/Door.ogg:60', 'stop:bgm:2', 'snd:bgm:audio/bgm/Theme.ogg:70', 'stop:bgm:0', 'snd:voice:audio/voice/breath.ogg:40', 'snd:voice:audio/voice/mika.ogg:90', 'say:hi']);
  assert.ok(!r.frames.some((f) => f.wait >= 20), 'паузы эффектов — только в сценарии: кадры альбома от них не меняются');
});

test('галерея: сценарий сцены — реплики ExternMessage (\\M[id] из CSV): разбор файла, разворот строк и обход события', () => {
  const { parseExternCsv, decodeCsv, expandLine, expandList } = require('./src/services/galleryExtern.js');
  const { runList, analyze } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });

  // Разбор CSV: кавычки с переносом строки и запятой, CRLF, «""» → «"», «\"» кавычку не закрывает, ключ без значения
  assert.deepStrictEqual(parseExternCsv('a,"x,\ny",c\r\nb,"q""r",d\r\ne,"p\\"q",f\nk'),
    [['a', 'x,\ny', 'c'], ['b', 'q"r', 'd'], ['e', 'p\\"q', 'f'], ['k']]);
  // Кодировка: BOM главнее параметра (у Mira's Potion Shop BOM UTF-8, а в плагине стоит shift_jis)
  assert.strictEqual(decodeCsv(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), 'shift_jis'), 'a');
  assert.strictEqual(decodeCsv(Buffer.from([0x82, 0xa0]), 'Shift_JIS'), 'あ');
  assert.strictEqual(decodeCsv(Buffer.from([0xff, 0xfe, 0x41, 0x00]), 'utf-8'), 'A');
  assert.strictEqual(decodeCsv(Buffer.from('é'), 'нет такой кодировки'), 'é', 'неизвестная метка — UTF-8');

  const table = new Map();
  const em = (over = {}) => ({ get: (k) => table.get(k), lineMax: 4, nameTag: true, mv: true, ...over });
  const dump = (r) => r.dest.map((x) => `${x.code}:${JSON.stringify(x.parameters)}`);
  const line = (text, e = em()) => expandLine(c(401, [text], 2), e, { left: 20000 });

  // MV: имя — тег «\n<имя>» в начале окна, новая страница каждые четыре строки (и тег повторяется), «:page» — по требованию
  table.set('a', ':name[Anna,Actor1]\nhello\nworld\n:page\nagain');
  assert.deepStrictEqual(dump(line('\\M[a]')), ['101:["Actor1",0,0,2]', '401:["\\\\n<Anna>hello"]', '401:["world"]', '101:["Actor1",0,0,2]', '401:["\\\\n<Anna>again"]']);
  assert.ok(line('\\M[a]').dest.every((x) => x.ext && x.indent === 2), 'созданные команды помечены, отступ как у строки');
  table.set('five', ':name[Anna,Actor1]\n1\n2\n3\n4\n5');
  assert.deepStrictEqual(dump(line('\\M[five]')).filter((x) => x.startsWith('101')).length, 2, 'пятая строка — на новой странице');
  assert.deepStrictEqual(dump(line('\\M[five]')).slice(-2), ['101:["Actor1",0,0,2]', '401:["\\\\n<Anna>5"]']);
  // Рассказчик: «:name[\,…]» — имя без букв, тега нет (на MZ — пустое имя)
  table.set('narr', ':name[\\,Actor1]Text');
  assert.deepStrictEqual(dump(line('\\M[narr]')), ['101:["Actor1",0,0,2]', '401:["Text"]']);
  assert.deepStrictEqual(dump(line('\\M[a]', em({ mv: false }))), ['101:["Actor1",0,0,2,"Anna"]', '401:["hello"]', '401:["world"]', '101:["Actor1",0,0,2,"Anna"]', '401:["again"]']);
  assert.deepStrictEqual(dump(line('\\M[narr]', em({ mv: false }))), ['101:["Actor1",0,0,2,""]', '401:["Text"]']);

  // \V, \C — по таблице, \M — цепочкой; ключ из переменной, неизвестный простой ключ — пусто; опечатка — текстом, как у плагина
  table.set('K', '12'); table.set('CK', '2');
  table.set('v', 'x\\V[K]y\\C[CK]z');
  assert.deepStrictEqual(dump(line('\\M[v]')), ['401:["x\\\\V[12]y\\\\C[2]z"]']);
  table.set('chain', '\\M[v]');
  assert.deepStrictEqual(dump(line('\\M[chain]')), ['401:["x\\\\V[12]y\\\\C[2]z"]']);
  assert.deepStrictEqual(line('\\M[\\V[3]]').dest, []);
  assert.strictEqual(line('\\M[\\V[3]]').dynamic, true);
  assert.deepStrictEqual(line('\\M[nope]').dest, []);
  table.set('b', 'B');
  assert.deepStrictEqual(line('\\M[a\\M[b]').dest.map((x) => x.parameters[0]), ['aB'], 'опечатка: остаток строки разобран');
  table.set('loop', '\\M[loop]');
  assert.deepStrictEqual(line('\\M[loop]').dest, [], 'ссылка на себя кончается');
  // :script … :end (только внутри значения), :script[immediate] в сцене не нужен
  table.set('s', 'hi\n:script\n$gameVariables.setValue(1,2)\n:end\nthere\n:script[immediate]\nx=1\n:end');
  assert.deepStrictEqual(dump(line('\\M[s]')), ['401:["hi"]', '355:["$gameVariables.setValue(1,2)\\n"]', '401:["there"]']);
  // :event, :fadeout, :fadein — команды, не текст
  table.set('ev', ':event[7]\n:fadeout\nbye');
  assert.deepStrictEqual(dump(line('\\M[ev]')).map((x) => x.split(':')[0]), ['117', '101', '221', '101', '401'], 'пустые окна перед командами игра тоже строит');

  // Список: без «\M[» — тот же массив; пустой разворот оставляет строку; строка не после 101/401 не трогается; голова — ext:'head'
  const plain = [c(101), c(401, ['hi']), c(0)];
  assert.strictEqual(expandList(plain, em()), plain);
  const mixed = [c(401, ['\\M[a]']), c(101), c(401, ['\\M[nope]']), c(401, ['\\M[a]']), c(0)];
  const done = expandList(mixed, em());
  assert.strictEqual(done[0], mixed[0], '401 без 101 перед ней — как есть');
  assert.strictEqual(done[2], mixed[2], 'пустой разворот — строка остаётся');
  assert.deepStrictEqual(done.slice(3).map((x) => x.ext), ['head', true, true, true, true, undefined]);

  // Обход. ctx: картинки и голос с «　» в имени
  const names = ['scene_cg1', 'scene_cg2', 'scene_cg3', 'cg2', 'base', 'late', 'p70', 'x'];
  const voiceRel = 'audio/voice/miku.ogg';
  const ctx = { names, has: (n) => names.includes(n), audio: (kind, name) => (kind === 'voice' && name === 'ミカ　んぁっ' ? { rel: voiceRel, voice: true } : kind === 'se' && name === 'soto1' ? { rel: 'audio/se/soto1.ogg', voice: false } : null) };
  const show = (n, name, indent = 0) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0], indent);
  const frames = (r) => JSON.stringify(r.frames);
  const same = (raw, all = []) => {
    // Набор общих событий, какими они стали к этой проверке: свежий массив, так как список «говорящих» событий помнится по нему
    const ces = [...all];
    const e = expandList(raw, em());
    const a = runList(raw, ces, ctx);
    const b = runList(e, ces, ctx);
    assert.strictEqual(frames(b), frames(a), 'кадры альбомов те же, что у исходного списка');
    assert.deepStrictEqual([...b.mentions], [...a.mentions]);
    return b;
  };
  // Имя картинки с неизвестной переменной: варианты, а реплика из CSV кадра не снимает
  table.set('talk', ':name[Mika,Actor1]\nhi');
  const alts = same([show(1, 'scene_cg\\V[5]'), c(101, ['', 0, 0, 2]), c(401, [' \\M[talk]']), c(230, [60]), show(1, 'cg2'), c(101, ['', 0, 0, 2]), c(401, ['x']), c(0)]);
  assert.ok(alts.frames.length >= 4, 'варианты имени дали кадры');
  assert.ok(alts.scenario.some((x) => x.k === 'say' && x.l.join('\n') === '\\n<Mika> \nhi'), 'реплика CSV в сценарии, имя — в теге');

  // Голос из общего события, имя файла с «　»: SV_ делится по ASCII-пробелу
  const ces = [];
  ces[233] = { id: 233, list: [c(356, ['SV_ボイスの演奏 ミカ　んぁっ 90 100 0 1'])] };
  table.set('voiced', ':name[Mika,Actor1]\n:event[233]\nAhh');
  const voiced = same([show(1, 'base'), c(101, ['', 0, 0, 2]), c(401, ['\\M[voiced]']), c(0)], ces);
  assert.deepStrictEqual(voiced.scenario.filter((x) => x.k === 'snd').map((x) => `${x.kind}:${x.f}`), [`voice:${voiceRel}`]);
  assert.strictEqual(runList([c(356, ['SV_ボイスの演奏 ミカ　んぁっ 90 100 0 1']), c(0)], [], ctx).scenario.length, 1, 'то же в самой сцене');

  // Песочница: звуки, вспышки и паузы события — в сценарий; картинка события — нет; переменные событие не меняет
  ces[413] = { id: 413, list: [c(250, [{ name: 'soto1', volume: 90, pitch: 100, pan: 0 }]), c(224, [[255, 255, 255, 170], 8, false]), c(230, [20]), show(60, 'p70'), c(230, [10]),
    c(122, [4, 4, 0, 0, 9]), c(250, [{ name: 'soto1', volume: 90, pitch: 100, pan: 0 }])] };
  table.set('out', ':event[413]\nOut!');
  const sb = same([show(1, 'base'), c(122, [4, 4, 0, 0, 1]), c(101, ['', 0, 0, 2]), c(401, ['\\M[out]']), c(230, [30]), c(0)], ces);
  assert.deepStrictEqual(sb.scenario.map((x) => (x.k === 'pics' ? 'pics' : x.k === 'snd' ? 'snd' : x.k === 'say' ? 'say' : x.k === 'fx' ? 'fx' : `${x.k}${x.n}`)),
    ['pics', 'snd', 'fx', 'wait20', 'wait10', 'snd', 'say', 'wait30']);
  const probe = runList(expandList([show(1, 'base'), c(122, [4, 4, 0, 0, 1]), c(101, ['', 0, 0, 2]), c(401, ['\\M[out]']), c(111, [1, 4, 0, 1, 0]), show(2, 'x'), c(412), c(0)], em()), [...ces], ctx);
  assert.ok(probe.frames.some((f) => f.pics.some((p) => p.name === 'x')), 'переменная 4 осталась 1: условие «= 1» сработало');

  // Общее событие, где только картинки (портрет), не открываем; цепочка до звука — с циклом — открываем
  ces[10] = { id: 10, list: [c(117, [11])] };
  ces[11] = { id: 11, list: [c(117, [12]), c(117, [10])] };
  ces[12] = { id: 12, list: [c(117, [13])] };
  ces[13] = { id: 13, list: [c(117, [14])] };
  ces[14] = { id: 14, list: [c(356, ['SV_PLAY_VOICE ミカ　んぁっ'])] };
  ces[20] = { id: 20, list: [show(70, 'p70'), c(230, [90])] };
  table.set('chain2', ':event[13]\n:event[20]\nhi');
  const ch = same([show(1, 'base'), c(101, ['', 0, 0, 2]), c(401, ['\\M[chain2]']), c(0)], ces);
  assert.strictEqual(ch.scenario.filter((x) => x.k === 'snd').length, 1, 'голос в конце цепочки событий найден');
  assert.ok(!ch.scenario.some((x) => x.k === 'wait' && x.n === 90), 'событие без звука и слов пропущено вместе с паузами');

  // Свой счёт шагов сценария: длинный разговор из CSV не вытесняет картинку сцены после него
  table.set('long', `:name[A,Actor1]\n${Array.from({ length: 800 }, (_, i) => `ln${i}`).join('\n')}`);
  const own = [];
  for (let i = 0; i < 1400; i++) own.push(c(101, ['', 0, 0, 2]), c(401, [`l${i}`]));
  const bud = runList(expandList([...own, c(101, ['', 0, 0, 2]), c(401, ['\\M[long]']), show(1, 'scene_cg1'), c(230, [60]), c(0)], em()), [], ctx);
  assert.strictEqual(bud.scenario.filter((x) => x.k === 'say').length, 1400 + 200, 'свои реплики и 200 страниц разговора: вместе больше лимита сценария (1500), но счёт у них раздельный');
  assert.strictEqual(bud.scenario.filter((x) => x.k === 'pics').pop().pics[0].name, 'scene_cg1', 'последняя картинка сцены не потеряна');
  // Счёт обхода: голова считается как строка, которую заменила; остальное — отдельно
  const filler = Array.from({ length: 5000 }, () => c(121, [1, 1, 0]));
  table.set('big', `:name[A,Actor1]\n${Array.from({ length: 3000 }, (_, i) => `ln${i}`).join('\n')}`);
  const tail = same([...filler, c(101, ['', 0, 0, 2]), c(401, ['\\M[big]']), show(1, 'late'), c(0)]);
  assert.ok(tail.frames.some((f) => f.pics.some((p) => p.name === 'late')), 'три тысячи реплик из CSV не съедают лимит обхода');
  const cut = same([...Array.from({ length: 7999 }, () => c(121, [1, 1, 0])), c(101, ['', 0, 0, 2]), c(401, ['\\M[big]']), show(1, 'late'), c(0)]);
  assert.ok(!cut.frames.some((f) => f.pics.some((p) => p.name === 'late')), 'лимит на своём месте, как у исходной строки');
  // Развилка: ветка с ext-117 не «про картинки» — идём по той же ветке, что и без разворота
  table.set('ev2', ':event[413]\nOut');
  same([c(111, [0, 9, 0]), c(101, ['', 0, 0, 2], 1), c(401, ['\\M[ev2]'], 1), c(411), show(1, 'x', 1), c(412), c(0)], ces);

  // Группы и клипы анализа те же; название сцены — по исходной строке
  const kinds = { base: 'cg', x: 'layer' };
  const raw = [show(1, 'base'), c(101, ['', 0, 0, 2]), c(401, ['\\M[talk]']), show(2, 'x'), c(101, ['', 0, 0, 2]), c(401, ['\\M[voiced]']), c(0)];
  const ex = expandList(raw, em());
  const pic = (n) => kinds[n] || null;
  const strip = (r) => JSON.stringify({ groups: r.groups.map(({ script, ...g }) => g), clips: r.clips, shown: [...r.shown].sort(), stills: [...r.stills].sort(), uses: [...r.uses].sort(), loops: r.loops });
  const a1 = analyze([{ id: 'ce1', name: '', where: '', list: raw }], ces, pic, () => false, names, [], () => false, ctx.audio);
  const a2 = analyze([{ id: 'ce1', name: '', where: '', list: ex, raw }], ces, pic, () => false, names, [], () => false, ctx.audio);
  assert.strictEqual(strip(a2), strip(a1));
  assert.ok(a1.groups.length === 1 && !a1.groups[0].script.some((x) => x.k === 'snd'), 'без разворота в сценарии только «\\M[…]» и ни одного голоса');
  assert.ok(a2.groups[0].script.some((x) => x.k === 'snd' && x.kind === 'voice') && !a2.groups[0].script.some((x) => x.k === 'say' && x.l.join('').includes('\\M[')), 'с разворотом — голос и настоящий текст');
});

test('галерея: реплики ExternMessage — плагин, файл и охрана в readSources; сцена из CSV в сборке', async (t) => {
  const { spawnSync } = require('child_process');
  const { loadExternMessage } = require('./src/services/galleryExtern.js');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-extern-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const plugins = (list) => `// Generated\nvar $plugins =\n${JSON.stringify(list)};\n`;
  const csv = '"talk",":name[Anna,Actor1]\n:event[2]\nHello there\nsecond"\nend,Bye\n';
  // Игра на случай: plugins — записи js/plugins.js, files — data/<имя> → содержимое
  const make = async (label, list, files = {}) => {
    const game = path.join(root, label);
    await fsp.mkdir(path.join(game, 'js'), { recursive: true });
    await fsp.mkdir(path.join(game, 'data'), { recursive: true });
    await fsp.writeFile(path.join(game, 'js', 'plugins.js'), plugins(list));
    for (const [n, body] of Object.entries(files)) await fsp.writeFile(path.join(game, 'data', n), body);
    return game;
  };
  const on = [{ name: 'ExternMessage', status: true, parameters: {} }];
  // Плагин выключен, файла нет, путь уходит из data/, ключей меньше двух — разворота нет
  assert.strictEqual(await loadExternMessage(await make('off', [{ ...on[0], status: false }], { 'ExternMessage.csv': csv })), null);
  assert.strictEqual(await loadExternMessage(await make('nofile', on)), null);
  // Путь наружу: файл за пределами data/ существует и годится — без охраны он бы прочитался
  const escGame = await make('escape', [{ ...on[0], parameters: { 'Csv File Path': '../x.csv' } }], { 'ExternMessage.csv': csv });
  await fsp.writeFile(path.join(escGame, 'x.csv'), csv);
  assert.strictEqual(await loadExternMessage(escGame), null);
  assert.strictEqual(await loadExternMessage(await make('one', on, { 'ExternMessage.csv': 'a,b\n' })), null);
  assert.strictEqual(await loadExternMessage(await make('empty', on, { 'ExternMessage.csv': '' })), null);
  // Повтор ключа: последняя строка, как у плагина
  assert.strictEqual((await loadExternMessage(await make('dup', on, { 'ExternMessage.csv': 'k,first\nk,last\nz,c\n' }))).get('k'), 'last');
  // Работает; значение берётся как у плагина: два столбца значений и номер 2 — первый, три и номер 2 — второй
  let em = await loadExternMessage(await make('ok', on, { 'ExternMessage.csv': Buffer.concat([bom, Buffer.from(csv)]) }));
  assert.strictEqual(em.get('end'), 'Bye');
  assert.strictEqual(em.mv, true);
  assert.strictEqual(em.lineMax, 4);
  const two = [{ ...on[0], parameters: { 'Default Reference Column Index': '2', 'Line Max': '3' } }];
  em = await loadExternMessage(await make('cols2', two, { 'ExternMessage.csv': 'k,a,b\nz,c,d\n' }));
  assert.deepStrictEqual([em.get('k'), em.get('z'), em.lineMax], ['a', 'c', 3]);
  em = await loadExternMessage(await make('cols3', two, { 'ExternMessage.csv': 'k,a,b,e\nz,c,d,f\n' }));
  assert.deepStrictEqual([em.get('k'), em.get('z')], ['b', 'd']);
  // Копия плагина под другим именем читает умолчания, не свои параметры
  // Другой плагин с тем же началом имени — не ExternMessage; пустой ключ (пустая строка в файле) записью не считается
  assert.strictEqual(await loadExternMessage(await make('other', [{ name: 'ExternMessageEx', status: true, parameters: {} }], { 'ExternMessage.csv': 'k,a\nz,c\n' })), null);
  em = await loadExternMessage(await make('blank', on, { 'ExternMessage.csv': 'k,a\n,lost\nz,c\n' }));
  assert.deepStrictEqual([em.get(''), em.get('k'), em.get('z')], [undefined, 'a', 'c']);
  em = await loadExternMessage(await make('copy', [{ name: 'ExternMessage_Copy', status: true, parameters: { 'Csv File Path': 'other.csv' } }], { 'ExternMessage.csv': 'k,a\nz,c\n', 'other.csv': 'q,1\nw,2\n' }));
  assert.strictEqual(em.get('k'), 'a');

  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  // Сборка: события те же, что с выключенным плагином; плеер получает реплики из CSV, имя и голос
  const build = async (label, list, table, unknown = 0) => {
    const game = await make(label, list, table ? { 'ExternMessage.csv': Buffer.concat([bom, Buffer.from(table)]) } : {});
    await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
    await fsp.mkdir(path.join(game, 'audio', 'voice'), { recursive: true });
    await fsp.writeFile(path.join(game, 'audio', 'voice', 'ミカ　んぁっ.ogg'), 'OggS....');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=816x624', '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', 'base.png')]);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue@0.0:s=816x624,format=rgba', '-frames:v', '1', path.join(game, 'img', 'pictures', 'layer.png')]);
    const events = [c(231, [1, 'base', 0, 0, 0, 0, 100, 100, 255, 0]), c(101, ['', 0, 0, 2]), c(401, ['\\M[talk]']),
      c(231, [2, 'layer', 0, 0, 0, 0, 100, 100, 255, 0]), c(101, ['', 0, 0, 2]), c(401, ['\\M[end]']),
      ...Array.from({ length: unknown }, (_, i) => c(401, [`\\M[nokey${i}]`])), c(0)];
    await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Сцена', list: events }, { id: 2, name: 'Голос', list: [c(356, ['SV_ボイスの演奏 ミカ　んぁっ 90 100 0 1']), c(0)] }]));
    await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
    const svc = new GalleryService();
    svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
    svc.vision = { available: false, version: 'test' };
    svc.visionPass = async () => {};
    const index = await svc.runBuild(label, { done: 0, total: 0 });
    const album = index.albums.find((a) => a.key.startsWith('events/'));
    const scene = album && album.script ? await svc.scene(label, album.key) : null;
    return { index, album, scene };
  };
  const text = (s) => s.steps.map((x) => (x.k === 'say' ? `say:${x.who}|${x.text}` : x.k === 'snd' ? `${x.k}:${x.kind}` : x.k === 'pic' ? 'pic' : x.k)).join(' ');
  const withIt = await build('with', on, csv);
  const without = await build('without', [{ ...on[0], status: false }], csv);
  assert.ok(withIt.album && without.album);
  assert.deepStrictEqual(withIt.index.albums.map((a) => [a.key, a.kind, a.files]), without.index.albums.map((a) => [a.key, a.kind, a.files]), 'альбомы те же, что без разворота');
  assert.strictEqual(text(withIt.scene), 'pic snd:voice say:Anna|Hello there second pic say:|Bye');
  assert.ok(!/Hello|snd:voice/.test(text(without.scene)), 'плагин выключен — реплик из CSV нет');
  // Больше половины «\M» верхнего уровня с неизвестным ключом (не тот файл или столбец): события остаются как в данных,
  // хотя известные ключи (talk, end) есть и без охраны дали бы реплики
  const wrong = await build('wrong', on, csv, 3);
  assert.ok(wrong.scene, 'сцена есть');
  assert.ok(!/Anna|Hello|snd:voice/.test(text(wrong.scene)), 'охрана: разворот выключен');
  // Те же ключи, неизвестных не больше половины — разворот работает
  const fine = await build('fine', on, csv, 1);
  assert.ok(/say:Anna\|Hello there second/.test(text(fine.scene)), 'ниже порога охраны разворот работает');
});

test('галерея: сценарий сцены — выбор по имени и броску: игра играет одну ветку, остальные из сценария уходят; имена героев от сцены', () => {
  const { runList, speech } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const se = (name, indent = 0) => c(250, [{ name, volume: 90, pitch: 100, pan: 0 }], indent);
  const bgm = (name, indent = 0) => c(241, [{ name, volume: 90, pitch: 100, pan: 0 }], indent);
  const say = (text, indent = 0) => [c(101, ['', 0, 0, 2], indent), c(401, [text], indent)];
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  // «Если» с телом на отступе глубже; внутри команды тела уже на нужном отступе
  const iff = (cond, body, indent = 0) => [c(111, cond, indent), ...body, c(0, [], indent + 1), c(412, [], indent)];
  const named = (v) => [4, 155, 1, v];
  const roll = (v, lo, hi) => c(122, [v, v, 0, 2, lo, hi]);
  const nm = (rel) => rel.replace(/^audio\/\w+\//, '').replace(/\.ogg$/, '');
  const names = ['a', 'b'];
  const ctx = { names, has: (n) => names.includes(n), audio: (kind, name) => ({ rel: `audio/${kind}/${name}.ogg`, voice: false }) };
  const run = (list, ces = []) => runList(list, ces, ctx);
  const snds = (r, kind) => r.scenario.filter((x) => x.k === 'snd' && (!kind || x.kind === kind)).map((x) => nm(x.f));
  const says = (r) => r.scenario.filter((x) => x.k === 'say').map((x) => x.l.join('/'));
  const ce = (list) => [null, { id: 1, list }];
  const dogs = ['Dog', 'Cat', 'Cow'];
  const members = (body) => dogs.flatMap((v) => iff(named(v), body(v), 0));

  // 1–3: имя известно — играет ветка с этим именем; не знаем — ни одной, если звуки разные, и один, если во всех один
  const chain = (v) => [c(117, [1]), ...say('end')];
  const pre = [show(1, 'a'), c(320, [155, 'Cat'])];
  const withName = run([...pre, ...chain()], ce(members((v) => [se(v, 1)])));
  assert.deepStrictEqual(snds(withName), ['Cat'], 'играет ветка «Cat»');
  const noName = run([show(1, 'a'), ...chain()], ce(members((v) => [se(v, 1)])));
  assert.deepStrictEqual(snds(noName), [], 'имени не знаем, звуки разные — ни одного');
  assert.deepStrictEqual(withName.frames, noName.frames, 'кадры альбома от имени не зависят');
  assert.deepStrictEqual(snds(run([show(1, 'a'), ...chain()], ce(members(() => [se('Door', 1)])))), ['Door'], 'во всех ветках один звук — он и играет');

  // 4–5: бросок — одно значение на бросок; следующий вызов — следующее; два выбора по одному броску сходятся; после
  // записи в переменную значение уже не знаем
  const byRoll = (v, tag, indent = 0) => [0, 1, 2].flatMap((k) => iff([1, v, 0, k, 0], [se(`${tag}${k}`, indent + 1)], indent));
  const thrice = [c(117, [1]), ...say('1'), c(117, [1]), ...say('2'), c(117, [1]), ...say('3')];
  assert.deepStrictEqual(snds(run(thrice, ce([roll(7, 0, 2), ...byRoll(7, 'r')]))), ['r0', 'r1', 'r2']);
  assert.deepStrictEqual(snds(run(thrice, ce([roll(7, 0, 2), c(122, [7, 7, 1, 0, 1]), ...byRoll(7, 'r')]))), [], 'переменную сдвинули — значение неизвестно');
  const two = [roll(7, 1, 3), ...[1, 2, 3].flatMap((k) => iff([1, 7, 0, k, 0], [se(`x${k}`, 1)])), ...[1, 2, 3].flatMap((k) => iff([1, 7, 0, k, 0], [se(`y${k}`, 1)]))];
  assert.deepStrictEqual(snds(run(thrice, ce(two))), ['x1', 'y1', 'x2', 'y2', 'x3', 'y3'], 'один бросок читают два выбора');

  // 5а: повтор цикла (тихий проход) счётчик броска не двигает: после цикла значение — как от первого броска
  const looped = [c(122, [8, 8, 0, 0, 0]), c(112), roll(7, 0, 1), c(122, [8, 8, 1, 0, 1]), c(0, [], 1), c(413), ...byRoll(7, 'z')];
  assert.deepStrictEqual(snds(run(looped)), ['z0'], 'повтор цикла бросок не съедает');

  // 5б: бросок в ветке-варианте («иначе» при неизвестном условии) счётчик не двигает: одна и та же команда на главном пути
  // получает второе значение при втором показе, а не третье
  const R = { ...roll(7, 0, 2), indent: 1 };
  const fork = () => [c(111, [12, 'Math.random() < 0.5']), { ...show(1, 'a'), indent: 1 }, R, c(0, [], 1), c(411), { ...show(1, 'b'), indent: 1 }, R, c(0, [], 1), c(412)];
  assert.deepStrictEqual(snds(run([...fork(), ...fork(), ...byRoll(7, 'w')])), ['w1'], 'бросок в ветке-варианте бросок главного пути не съедает');

  // 6–7: музыка не режется (в плеере играет одна); общее событие, которое не открыли, — выбор «слепой» и остаётся как был
  assert.deepStrictEqual(snds(run([show(1, 'a'), ...chain()], ce(members((v) => [bgm(v, 1)]))), 'bgm'), dogs);
  const deep = [null, { id: 1, list: members((v) => [se(v, 1), c(117, [2], 1)]) }, { id: 2, list: [c(117, [3])] }, { id: 3, list: [c(117, [4])] }, { id: 4, list: [c(0)] }];
  assert.deepStrictEqual(snds(run([show(1, 'a'), ...chain()], deep)), dogs, 'в ветках неоткрытое общее событие — ничего не режем');

  // 8: ветки с репликами — остаётся ветка с этим именем; обрыв (113) в подходящей ветке — сценарий как был; одиночное «Если»
  // с другим именем теряет и реплику; бросок с репликами в ветках не режем
  const talking = members((v) => [se(v, 1), ...say(`${v} line`, 1)]);
  const talk = run([...pre, ...chain()], ce(talking));
  assert.deepStrictEqual([snds(talk), says(talk).filter((x) => x !== 'end')], [['Cat'], ['Cat line']]);
  const broken = run([...pre, ...chain()], ce(members((v) => [se(v, 1), ...say(`${v} line`, 1), ...(v === 'Cat' ? [c(113, [], 1)] : [])])));
  assert.deepStrictEqual([snds(broken), says(broken)], [['Dog', 'Cat'], ['Dog line', 'Cat line', 'end']], 'обход оборвался до конца выбора — ничего не режем');
  assert.deepStrictEqual(says(run([...pre, ...iff(named('Dog'), say('dog line', 1)), ...say('end')])), ['end']);
  const byRollTalk = run([roll(7, 0, 2), ...[0, 1, 2].flatMap((k) => iff([1, 7, 0, k, 0], say(`l${k}`, 1)))]);
  assert.deepStrictEqual(says(byRollTalk), ['l0', 'l1', 'l2'], 'бросок с репликами — как прежде');

  // 9–10: не выбор — не трогаем (одно значение трижды, пороги, два значения, ряд разорван); ветка с «иначе» тоже
  const sameVal = [1, 2, 3].flatMap((k) => iff(named('Dog'), [se(`s${k}`, 1)]));
  assert.deepStrictEqual(snds(run(sameVal)), ['s1', 's2', 's3']);
  const gte = [1, 2, 3].flatMap((k) => iff([1, 7, 0, k, 1], [se(`g${k}`, 1)]));
  assert.deepStrictEqual(snds(run(gte)), ['g1', 'g2', 'g3']);
  const pair = ['Dog', 'Cat'].flatMap((v) => iff(named(v), [se(v, 1)]));
  assert.deepStrictEqual(snds(run(pair)), ['Dog', 'Cat']);
  const split = [...iff(named('Dog'), [se('Dog', 1)]), ...iff(named('Cat'), [se('Cat', 1)]), c(121, [1, 1, 0]), ...iff(named('Cow'), [se('Cow', 1)])];
  assert.deepStrictEqual(snds(run(split)), ['Dog', 'Cat', 'Cow']);
  const withElse = dogs.flatMap((v) => [c(111, named(v)), se(`${v}1`, 1), c(0, [], 1), c(411), se(`${v}2`, 1), c(0, [], 1), c(412)]);
  assert.deepStrictEqual(snds(run([...pre, ...withElse])), ['Dog1', 'Cat1', 'Cow1']);

  // 11: выбор в выборе — по броску на каждом уровне
  const inner = (o) => [0, 1, 2].flatMap((k) => iff([1, 17, 0, k, 0], [se(`m${o}${k}`, 2)], 1));
  const nested = [roll(16, 0, 2), roll(17, 0, 2), ...[0, 1, 2].flatMap((o) => iff([1, 16, 0, o, 0], inner(o)))];
  assert.deepStrictEqual(snds(run([c(117, [1]), ...say('1'), c(117, [1]), ...say('2'), c(117, [1]), ...say('3')], ce(nested))), ['m00', 'm11', 'm22']);

  // 12: сцена с картинкой, но без реплик: «Смотреть сцену» нужен звук — первый из вырезанных возвращается
  assert.deepStrictEqual(snds(run([show(1, 'a'), c(117, [1])], ce(members((v) => [se(v, 1)])))), ['Dog']);

  // 13: имя скриптом; номер героя из переменной, 303 («ввод имени») и любое другое прикосновение к имени — имя забыто
  const setName = (code) => [show(1, 'a'), c(355, [code]), ...chain()];
  assert.deepStrictEqual(snds(run(setName('$gameActors.actor(155).setName("Cow");'), ce(members((v) => [se(v, 1)])))), ['Cow']);
  assert.deepStrictEqual(snds(run([c(320, [155, 'Dog']), ...setName('$gameActors.actor($gameVariables.value(3)).setName("Cow")')], ce(members((v) => [se(v, 1)])))), []);
  assert.deepStrictEqual(snds(run([c(320, [155, 'Dog']), ...setName('$gameActors.actor(155)._name = "x"')], ce(members((v) => [se(v, 1)])))), []);
  assert.deepStrictEqual(snds(run([c(320, [155, 'Dog']), c(303, [155, 8]), show(1, 'a'), ...chain()], ce(members((v) => [se(v, 1)])))), []);
  assert.deepStrictEqual(run(setName('$gameActors.actor(155).setName("b")'), ce(members((v) => [se(v, 1)]))).mentions, ['b'], 'строка идёт дальше обычным путём: картинка названа');

  // 14: имя, которое сцена задала сама, — в реплике и варианте выбора; speech() с ним даёт говорящего
  const spoken = run([c(320, [50, 'Прихожанин']), ...say('\\n<\\N[50]>Хм…'), c(102, [['\\N[50] да', 'нет'], 1, 0, 2, 0]), c(402, [0, 'да']), c(0, [], 1), c(402, [1, 'нет']), c(0, [], 1), c(404)]);
  const first = spoken.scenario.find((x) => x.k === 'say');
  assert.deepStrictEqual(first.a, { 50: 'Прихожанин' });
  assert.deepStrictEqual(spoken.scenario.find((x) => x.k === 'choice').a, { 50: 'Прихожанин' });
  assert.strictEqual(speech(first.l, '', {}, Object.assign([null], first.a)).who, 'Прихожанин');
  assert.ok(!('a' in run([...say('\\n<\\N[50]>Хм…')]).scenario[0]), 'имени сцена не задавала — поля нет');

  // 15: 320 внутри пропущенной ветки имя не меняет
  const rename = dogs.flatMap((v) => iff(named(v), [...(v === 'Dog' ? [c(320, [155, 'Cow'], 1)] : []), se(v, 1)]));
  assert.deepStrictEqual(snds(run([...pre, c(117, [1]), ...say('end')], ce(rename))), ['Cat']);

  // 16: экран, который записала пропущенная ветка, остаётся: вспышка уходит, картинка нет
  const flashes = [...iff(named('bikun'), [c(224, [[255, 255, 255, 170], 5, false], 1)]), ...iff(named('pusha'), [se('splash', 1)]), ...iff(named('kuchu'), [c(224, [[255, 255, 255, 170], 5, false], 1)])];
  const screen = run([show(1, 'a'), c(320, [155, 'pusha']), c(117, [1]), show(1, 'b'), ...say('end')], ce(flashes));
  assert.deepStrictEqual(screen.scenario.map((x) => (x.k === 'pics' ? `pics:${x.pics.map((p) => p.name)}` : x.k === 'snd' ? `snd:${nm(x.f)}` : x.k)), ['pics:a', 'snd:splash', 'pics:b', 'say']);
});

// ---- i04: языки сцен. Игра-образец: оригинал по-китайски, N реплик; ja/en/ru — переводы той же длины
const langFix = () => {
  const N = 14;
  const zh = Array.from({ length: N }, (_, i) => `这是第${i}号测试句子，今天天气非常好`);
  const ja = Array.from({ length: N }, (_, i) => `これは${i}番目のテスト文章です、今日は天気がいい`);
  const en = Array.from({ length: N }, (_, i) => `This is test sentence number ${i} and the weather is fine today`);
  const ru = Array.from({ length: N }, (_, i) => `Это тестовое предложение номер ${i}, сегодня хорошая погода`);
  const wanted = (extra = {}) => ({ msgs: new Map(zh.map((l) => [l, [l]])), optSets: new Set(), opts: new Set(), names: new Set(), ...extra });
  return { N, zh, ja, en, ru, wanted };
};
// Игра во временной папке: files — путь → содержимое (строка или объект в JSON), plugins — имена включённых плагинов или их записи
const langGame = async (t, files, plugins = []) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scene-langs-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'js'), { recursive: true });
  await fsp.mkdir(path.join(root, 'data'), { recursive: true });
  await fsp.writeFile(path.join(root, 'js', 'plugins.js'), `var $plugins =\n${JSON.stringify(plugins.map((p) => (typeof p === 'string' ? { name: p, status: true, parameters: {} } : p)))};\n`);
  for (const [n, body] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, n)), { recursive: true });
    await fsp.writeFile(path.join(root, n), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
};

test('галерея: языки сцен — таблицы игры: Hendrix, ROC, Hakubox, DKTools; язык по тексту, а не по названию', async (t) => {
  const SL = require('./src/services/sceneLangs.js');
  const { zh, ja, en, ru, N, wanted } = langFix();
  const q = (s) => `"${s.replace(/"/g, '""')}"`;
  // Hendrix: BOM, заголовок с пустым столбцом zh (язык оригинала), jp (это японский), en; ячейка в две строки; запасной файл с чужим текстом
  const two = `${zh[0]}\n${zh[1]}`;
  const rows = zh.map((l, i) => `,,${q(l)},,${q(ja[i])},${q(en[i])},`);
  rows[0] = `,,${q(two)},,${q(`${ja[0]}\n${ja[1]}`)},${q(`${en[0]}\n${en[1]}`)},`;
  const csv = `﻿Change,Excluded,Original,zh,jp,en,\n${rows.join('\n')}\n`;
  const hendrix = await langGame(t, { 'game_messages.csv': csv, 'game_messages_backup_x.csv': csv.replace(/This is/g, 'BACKUP') }, ['Hendrix_Localization']);
  let asked = 0;
  const hw = async () => { asked++; return wanted({ msgs: new Map([[two, [zh[0], zh[1]]], ...zh.slice(2).map((l) => [l, [l]])]) }); };
  const T = await SL.build(hendrix, hw);
  assert.strictEqual(asked, 1);
  assert.strictEqual(T.orig, 'zh');
  assert.deepStrictEqual(T.langs.map((l) => l.code).sort(), ['en', 'ja'], 'jp — японский по тексту; пустой zh пропал');
  assert.strictEqual(T.text.en[zh[5]], en[5]);
  assert.strictEqual(T.text.en[two], `${en[0]}\n${en[1]}`, 'ячейка в две строки целиком');
  assert.ok(!JSON.stringify(T).includes('BACKUP'), '*_backup_*.csv не читается');
  assert.ok(T.langs.every((l) => l.n > 0 && l.n <= l.of));
  // Те же столбцы с «;» вместо запятой — та же таблица
  const semi = await langGame(t, { 'game_messages.csv': csv.replace(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g, ';') }, ['Hendrix_Localization']);
  assert.strictEqual((await SL.build(semi, hw)).text.en[zh[5]], en[5]);

  // ROC: «<br>» вместо перевода строки, выбор — из othertexts, имя файла с «..» пропускается
  const talk = (tr) => ({ talks: Object.fromEntries(zh.map((l, i) => [i === 0 ? `${zh[0]}<br>${zh[1]}` : l, i === 0 ? `${tr[0]}<br>${tr[1]}` : tr[i]])), othertexts: { 选择: 'Choice' } });
  const roc = await langGame(t, {
    'languages/languages.list': [{ name: 'English', filename: 'en.json' }, { name: 'Japanese', filename: 'ja.json' }, { name: 'Evil', filename: '../x.json' }],
    'languages/en.json': talk(en), 'languages/ja.json': talk(ja), 'x.json': talk(en),
  }, ['ROC_MultiLanguage']);
  const R = await SL.build(roc, async () => wanted({ msgs: new Map([[two, [zh[0], zh[1]]], ...zh.slice(2).map((l) => [l, [l]])]), opts: new Set(['选择']) }));
  assert.deepStrictEqual(R.langs.map((l) => l.code).sort(), ['en', 'ja']);
  assert.strictEqual(R.text.en[two], `${en[0]}\n${en[1]}`);
  assert.strictEqual(R.text.en['选择'], 'Choice');

  // Hakubox: имя внутри «\n<…>» берётся из таблицы, пробел после «>» остаётся в ключе; «Basic» и файл из одной записи не в счёт
  const nm = '\\n<\\C[27]名>';
  const hk = Object.fromEntries(zh.map((l, i) => [i === 0 ? ` ${l}` : l, en[i]]));
  Object.assign(hk, { 名: 'Name', 阿乌拉: 'Aura' });
  const hakubox = await langGame(t, {
    'data/Hakubox-Translate-en-US.json': hk, 'data/Hakubox-Translate-zh-CN.json': { 单: 'x' }, 'data/Hakubox-Translate-Basic-en-US.json': { 名: 'Wrong' },
  }, ['Hakubox_Translate']);
  const key0 = `${nm} ${zh[0]}`;
  const H = await SL.build(hakubox, async () => wanted({ msgs: new Map([[key0, [key0]], ...zh.slice(1).map((l) => [l, [l]])]), names: new Set(['阿乌拉', '<???>']) }));
  assert.deepStrictEqual(H.langs.map((l) => l.code), ['en'], 'zh-CN из одной записи отброшен, Basic не читается');
  assert.strictEqual(H.text.en[key0], `\\n<\\C[27]Name>${en[0]}`, 'имя заменено внутри префикса');
  assert.strictEqual(H.text.en['阿乌拉'], 'Aura');
  assert.ok(!('<???>' in H.text.en), 'имя без перевода остаётся как есть');
  assert.strictEqual(SL.stripTags('阿乌拉<e19>'), '阿乌拉');
  assert.strictEqual(SL.stripTags('<???>'), '<???>', 'если от имени ничего не осталось — оно само');

  // DKTools: «{a}» → «{b}» → текст (Parse Depth 2); оригинал — как игра показывает без перевода, ключ без скобок;
  // xx.json с русским текстом — русский
  const keys = zh.map((l) => `{${l}}`);
  const loc = { a: '{b}', b: 'Hello world, this is the final text of the key', ...Object.fromEntries(zh.map((l, i) => [l, en[i]])) };
  const files = { 'locales/en.json': loc, 'locales/xx.json': Object.fromEntries(zh.map((l, i) => [l, ru[i]])) };
  const dkw = async () => wanted({ msgs: new Map([...keys.map((k) => [k, [k]]), ['{a}', ['{a}']]]) });
  const D = await SL.build(await langGame(t, files, [{ name: 'DKTools_Localization', status: true, parameters: { 'Parse Depth': '2' } }]), dkw);
  assert.deepStrictEqual(D.langs.map((l) => l.code).sort(), ['en', 'ru']);
  assert.strictEqual(D.text.en['{a}'], loc.b, '{a} → {b} → текст за два шага');
  assert.strictEqual(D.text.en[keys[3]], en[3]);
  assert.strictEqual(D.base[keys[3]], zh[3], 'оригинал без перевода — ключ без скобок');
  assert.strictEqual(D.orig, 'zh');
  const deep1 = await SL.build(await langGame(t, files, [{ name: 'DKTools_Localization', status: true, parameters: { 'Parse Depth': '1' } }]), dkw);
  assert.strictEqual(deep1.text.en['{a}'], '{b}', 'Parse Depth 1: один шаг');
  assert.deepStrictEqual(await SL.build(await langGame(t, files, []), async () => { throw new Error('не должен читать'); }), { v: SL.VERSION, orig: '', langs: [], text: {} }, 'плагин выключен — ничего, сценарии не читаются');
  assert.ok(N > 0 && ru.length === N && ja.length === N);
});

test('галерея: языки сцен — папки data_xx и охрана: списки сверяются по 101 и лицу, испорченное чужой письменностью — не перевод', async (t) => {
  const SL = require('./src/services/sceneLangs.js');
  const { zh, ja, en, ru, wanted } = langFix();
  const c = (code, parameters = []) => ({ code, parameters, indent: 0 });
  // Окно сообщения: лицо, имя, строки
  const msg = (face, name, ...lines) => [c(101, [face, 0, 0, 2, name]), ...lines.map((l) => c(401, [l]))];
  const map = (...lists) => ({ events: [null, ...lists.map((list, i) => ({ id: i + 1, pages: [{ list }] }))] });
  const lists = (l, o = { all: true }) => [
    [...msg('a', o.name || '阿乌拉', l[0]), ...msg('', '', l[1]), ...msg('', '', l[2]), c(102, [o.opts || ['是', '否']]), ...msg('b', '', l[3])],
    o.insert ? [...msg('', '', l[4]), ...msg('', '', 'вставлено'), ...msg('', '', l[5])] : [...msg('', '', l[4]), ...msg('', '', l[5])],
    [...msg(o.face || 'a', '', l[6])],
    l.slice(7).flatMap((x) => msg('', '', x)),
  ];
  const orig = map(...lists(zh));
  const tr = (l, o) => map(...lists(l, { name: 'Aura', opts: ['Yes', 'No'], insert: true, face: 'c', ...o }));
  const game = await langGame(t, {
    'data/MapInfos.json': [null, { id: 1 }], 'data/Map001.json': orig,
    'data/Map001_en.json': tr(en), 'data/Map002_en.json': { events: 'не карта' },
    'data_ru/Map001.json': tr(ru), 'data_bak/Map001.json': tr(zh.map((x) => `${x}！`)),
  });
  const stats = {};
  const w = () => wanted({ optSets: new Set(['是\u0000否']), opts: new Set(['是', '否']), names: new Set(['阿乌拉']) });
  const T = await SL.build(game, async () => w(), stats);
  assert.deepStrictEqual(T.langs.map((l) => l.code).sort(), ['en', 'ru'], 'data_bak — тот же язык, что оригинал, отброшен');
  assert.strictEqual(T.text.en[zh[0]], en[0]);
  assert.strictEqual(T.text.en[zh[2]], en[2]);
  assert.strictEqual(T.text.en['阿乌拉'], 'Aura', 'имя — по 101 и лицу');
  assert.strictEqual(T.text.en['是'], 'Yes', 'выбор — когда число вариантов то же');
  assert.ok(!(zh[4] in T.text.en) && !(zh[5] in T.text.en), 'вставленное окно: список не сопоставляется вовсе');
  assert.ok(!(zh[6] in T.text.en), 'лицо другое: список пропущен');
  assert.strictEqual(T.text.en[zh[7]], en[7], 'остальные списки целы');
  assert.ok(stats.skipped >= 2 && !stats.errors);
  // Выбор другой длины не сопоставляется, а сообщения того же списка остаются
  const odd = await langGame(t, { 'data/MapInfos.json': [null, { id: 1 }], 'data/Map001.json': orig, 'data_en/Map001.json': tr(en, { opts: ['Yes', 'No', 'Maybe'], insert: false, face: 'a' }) });
  const O = await SL.build(odd, async () => w());
  assert.ok(!('是' in O.text.en) && O.text.en[zh[1]] === en[1]);

  // Испорченное data_ru: японский в китайской игре и строка, совпавшая с оригиналом, не показываются как перевод
  const bad = tr(ru, { insert: false, face: 'a' });
  bad.events[1].pages[0].list[1].parameters = ['これはテストです、今日はいい天気'];
  bad.events[4].pages[0].list[1].parameters = [zh[7]];
  const T2 = await SL.build(await langGame(t, { 'data/MapInfos.json': [null, { id: 1 }], 'data/Map001.json': orig, 'data_ru/Map001.json': bad }), async () => w());
  assert.deepStrictEqual(T2.langs.map((l) => l.code), ['ru']);
  assert.ok(!(zh[0] in T2.text.ru) && !(zh[7] in T2.text.ru), 'подмена не стала переводом');
  assert.strictEqual(T2.text.ru[zh[1]], ru[1]);

  // Одна метка — одна таблица, с большим n; доля меньше 10 % — не язык; без механизма сценарии не читаются
  const more = { 'data/MapInfos.json': [null, { id: 1 }], 'data/Map001.json': orig, 'data_en/Map001.json': tr(en, { insert: false, face: 'a' }), 'data_us/Map001.json': tr(en.map((x, i) => (i > 6 ? zh[i] : x)), { insert: false, face: 'a' }) };
  const T3 = await SL.build(await langGame(t, more), async () => w());
  assert.deepStrictEqual(T3.langs.map((l) => [l.code, l.n]), [['en', 14]]);
  const extra = Array.from({ length: 200 }, (_, i) => `这是别的句子编号${i}号`);
  assert.deepStrictEqual((await SL.build(await langGame(t, more), async () => wanted({ msgs: new Map([...zh, ...extra].map((l) => [l, [l]])) }))).langs, [], 'доля меньше 10 %');
  let called = 0;
  assert.deepStrictEqual((await SL.build(await langGame(t, {}), async () => { called++; return wanted(); })).langs, []);
  assert.strictEqual(called, 0);

  // plugins.js не JSON: лишняя запятая, ключи без кавычек — плагин находится по имени
  const sloppy = await langGame(t, { 'game_messages.csv': 'Original,en\n' });
  await fsp.writeFile(path.join(sloppy, 'js', 'plugins.js'), 'var $plugins = [\n{name:"Hendrix_Localization", status:true, description:"x", parameters:{}},\n{"name":"Off","status":false,"parameters":{}},\n];\n');
  assert.deepStrictEqual([...(await SL.enabledPlugins(sloppy)).keys()], ['Hendrix_Localization']);
  await fsp.writeFile(path.join(sloppy, 'js', 'plugins.js'), 'var $plugins = [{"name":"Hendrix_Localization","status":true,"parameters":{},},];');
  assert.deepStrictEqual((await SL.detect(sloppy)).map((x) => x[0]), ['hendrix']);
  // Кавычка в CSV не закрыта, файл локали не JSON — сборка не падает
  const broken = await langGame(t, { 'game_messages.csv': 'Original,en\n"unterminated,x', 'locales/bad.json': 'не json' }, ['Hendrix_Localization', 'DKTools_Localization']);
  assert.deepStrictEqual((await SL.build(broken, async () => wanted())).langs, []);
  assert.ok(ja.length);
});

test('галерея: языки сцен — выбор при показе: цепочка, по строке, говорящий, одни и те же шаги на любом языке', () => {
  const SL = require('./src/services/sceneLangs.js');
  const { speech } = require('./src/services/galleryScenes.js');
  const data = { files: ['a.png'], actors: [null, 'Ann'], steps: [
    { k: 'pic', i: 0 },
    { k: 'say', l: ['原一', '原二'], n: '阿乌拉<e19>' },
    { k: 'say', l: ['\\.\\|'] },                              // один код, текста нет: шага нет ни на каком языке
    { k: 'say', l: ['Mimikin-only'] },
    { k: 'say', l: ['原三'] },
    { k: 'say', l: ['原四'] },
    { k: 'choice', o: ['是', '否'], i: 1 },
    { k: 'say', l: ['只有机翻'] },
    { k: 'say', l: ['\\N[1]'], a: { 1: '阿乌拉' } },
    { k: 'say', l: ['Time: 5'] }] };
  const T = { v: 1, orig: 'zh', langs: [{ code: 'en', n: 4, of: 6 }, { code: 'ja', n: 2, of: 6 }, { code: 'ru', n: 1, of: 6 }],
    text: { en: { '原一\n原二': 'One\nTwo', 原三: 'Three', 阿乌拉: 'Aura', 是: 'Yes', 否: 'No', 原四: 'Meiber: Four' }, ja: { '原一\n原二': '一\n二', 原三: '三' }, ru: { 原三: 'Три' } } };
  const run = (opts, tr = null, TT = T, d = data) => SL.serve(d, TT, { client: true, ...opts, tr }, speech);
  const says = (r) => r.steps.filter((x) => x.k === 'say');
  const texts = (r) => says(r).map((x) => x.text);

  // Цепочка: выбранный → Mimikin → язык интерфейса → знакомые → английский; «orig» и код оригинала — оригинал
  assert.strictEqual(run({ want: ['ja'], mt: 'ru', ui: 'en' }).lang, 'ja');
  assert.strictEqual(run({ mt: 'ru', ui: 'ja' }).lang, 'ru', 'Mimikin раньше языка интерфейса');
  assert.strictEqual(run({ ui: 'ja', known: ['en'] }).lang, 'ja');
  assert.strictEqual(run({ ui: 'de', known: ['ru', 'ja'] }).lang, 'ru', 'знакомые — по порядку');
  assert.strictEqual(run({ ui: 'de' }).lang, 'en', 'английский — последний');
  assert.strictEqual(run({ want: ['orig'], ui: 'en' }).lang, 'zh');
  assert.strictEqual(run({ want: ['zh'], ui: 'en' }).lang, 'zh');
  assert.strictEqual(run({ want: ['fr'], ui: 'en' }).lang, 'en', 'такого языка нет — дальше по цепочке');
  const langs = run({ ui: 'en' }).langs;
  assert.deepStrictEqual(langs.map((o) => [o.code, !!o.orig, o.n]), [['zh', true, undefined], ['en', false, 4], ['ja', false, 2], ['ru', false, 1]], 'n — реплики и выборы этой сцены, где язык есть');
  // Старый клиент (ни ui, ни lang): как раньше, без перевода Mimikin — оригинал
  assert.deepStrictEqual(run({ client: false }).steps, run({ want: ['orig'] }).steps);

  // Строка за строкой: чего нет на выбранном языке — дальше по цепочке, но не дальше оригинала
  const ja = run({ want: ['ja'], mt: 'en', ui: 'ru' }, new Map([['只有机翻', 'Only Mimikin']]));
  assert.deepStrictEqual(texts(ja), ['一\n二', 'Mimikin-only', '三', 'Meiber: Four', 'Only Mimikin', 'Aura', 'Time: 5']);
  assert.strictEqual(ja.steps.length, run({ want: ['orig'] }).steps.length);
  // Mimikin en + частичная таблица ru: по умолчанию en; явный ru — пробелы заполняет Mimikin
  const part = { ...T, langs: [{ code: 'ru', n: 1, of: 6 }], text: { ru: { 原三: 'Три' } } };
  const mtMap = new Map([['原一', 'Mt one'], ['原二', 'Mt two'], ['原四', 'Mt four']]);
  assert.strictEqual(run({ mt: 'en', ui: 'ru' }, mtMap, part).lang, 'en');
  const ru = run({ want: ['ru'], mt: 'en', ui: 'ru' }, mtMap, part);
  assert.strictEqual(ru.lang, 'ru');
  assert.deepStrictEqual(texts(ru).slice(0, 4), ['Mt one Mt two', 'Mimikin-only', 'Три', 'Mt four']);
  // Язык, которого в этой сцене нет совсем, не предлагается; один вариант — ни lang, ни langs
  assert.deepStrictEqual(run({ ui: 'en' }, null, T, { ...data, steps: [{ k: 'say', l: ['原三'] }] }).langs.map((o) => o.code), ['zh', 'en', 'ja', 'ru']);
  assert.deepStrictEqual(run({ ui: 'en' }, null, T, { ...data, steps: [{ k: 'say', l: ['原一', '原二'] }] }).langs.map((o) => o.code), ['zh', 'en', 'ja']);
  const none = run({ want: ['ja'], ui: 'en' }, null, T, { ...data, steps: [{ k: 'pic', i: 0 }, { k: 'say', l: ['没有'] }] });
  assert.ok(!('lang' in none) && !('langs' in none));

  // Шаги: число и виды одни и те же на каждом языке
  const kinds = (o) => run(o).steps.map((x) => x.k).join();
  assert.strictEqual(kinds({ want: ['en'] }), kinds({ want: ['ja'] }));
  assert.strictEqual(kinds({ want: ['orig'] }), kinds({ want: ['ru'] }));
  assert.ok(!kinds({ want: ['orig'] }).includes('say,say,say,say,say,say,say,say'), 'пустая реплика пропадает');
  // Имя: теги плагина не показываются, перевод берётся из таблицы; имя героя от сцены (a) — по той же цепочке
  assert.strictEqual(says(run({ want: ['en'] }))[0].who, 'Aura');
  assert.strictEqual(says(run({ want: ['orig'] }))[0].who, '阿乌拉', 'без <e19>');
  assert.ok(texts(run({ want: ['en'] })).includes('Aura') && texts(run({ want: ['orig'] })).includes('阿乌拉'));

  // Имя, склеенное с репликой в переводе («Meiber: Four»): в рамку, если у оригинала говорящий был; иначе — не режем
  const e2 = { ...T, text: { ...T.text, en: { ...T.text.en, '【阿乌拉】原四': 'Meiber: Four' } } };
  const one = (l, n) => run({ want: ['en'] }, null, e2, { ...data, steps: [{ k: 'say', l, ...(n ? { n } : {}) }] }).steps[0];
  assert.deepStrictEqual([one(['【阿乌拉】原四']).who, one(['【阿乌拉】原四']).text], ['Meiber', 'Four'], 'у оригинала говорящий был, у перевода нет');
  assert.deepStrictEqual([one(['原四']).who, one(['原四']).text], ['', 'Meiber: Four'], 'у оригинала не было — не режем');
  assert.deepStrictEqual([one(['原四'], '阿乌拉').who, one(['原四'], '阿乌拉').text], ['Aura', 'Meiber: Four'], 'имя в рамке уже есть');
  assert.deepStrictEqual([one(['Time: 5']).who, one(['Time: 5']).text], ['', 'Time: 5']);
  // Выбор: варианты в переводе, взятый номер остаётся
  const ch = run({ want: ['en'] }).steps.find((x) => x.k === 'choice');
  assert.deepStrictEqual([ch.o, ch.i], [['Yes', 'No'], 1]);
  // Коды из запроса: только по шаблону, до восьми
  assert.deepStrictEqual(SL.codes('EN, zh-TW,../../x,ZZZZZZZZZ,orig'), ['en', 'zh-tw', 'orig']);
  assert.deepStrictEqual(SL.codes(['en', 'ja']), ['en', 'ja']);
  assert.deepStrictEqual(SL.codes({ x: 1 }), []);
  assert.deepStrictEqual(SL.codes(undefined), []);
  assert.strictEqual(SL.codes('aa,bb,cc,dd,ee,ff,gg,hh,ii,jj').length, 8);
});

test('галерея: сцена с выбором языка — таблица рядом со сценариями, кэш, охрана от сбоя и зависания; старый вызов как был', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const SL = require('./src/services/sceneLangs.js');
  const { zh, ja, en } = langFix();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-langs-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const make = async (id, files, plugins) => {
    const game = path.join(root, id);
    for (const d of ['img', 'js', 'data']) await fsp.mkdir(path.join(game, d), { recursive: true });
    await fsp.writeFile(path.join(game, 'js', 'plugins.js'), `var $plugins = ${JSON.stringify(plugins)};`);
    for (const [n, body] of Object.entries(files)) { await fsp.mkdir(path.dirname(path.join(game, n)), { recursive: true }); await fsp.writeFile(path.join(game, n), JSON.stringify(body)); }
  };
  const keys = zh.map((l) => `{${l}}`);
  await make('D', { 'locales/en.json': Object.fromEntries(zh.map((l, i) => [l, en[i]])), 'locales/ja.json': Object.fromEntries(zh.map((l, i) => [l, ja[i]])) }, [{ name: 'DKTools_Localization', status: true, parameters: {} }]);
  await make('P', {}, []);
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const KEY = 'events/00001/Сцена';
  const put = async (id, dir, steps) => {
    await fsp.mkdir(path.join(root, '_media', id, dir), { recursive: true });
    await fsp.writeFile(svc.indexPath(id), JSON.stringify({ v: Number(fs.readFileSync(path.join(__dirname, 'src/services/gallery.js'), 'utf8').match(/const INDEX_VERSION = (\d+)/)[1]), builtAt: 1, scripts: dir, screen: { w: 816, h: 624 }, counts: { cg: 1 }, albums: [{ key: KEY, kind: 'cg', w: 1, h: 1, files: ['img/pictures/cg.png'], script: true }] }));
    await fsp.writeFile(svc.scriptPath(id, dir, KEY), JSON.stringify({ steps, sounds: [] }));
    svc.memo.delete(id);
  };
  const dSteps = [{ k: 'pic', i: 0 }, ...keys.slice(0, 4).map((k) => ({ k: 'say', l: [k] })), { k: 'choice', o: ['{是}', '{否}'], i: 0 }];
  await put('D', 'scripts-1', dSteps);
  await put('P', 'scripts-1', [{ k: 'pic', i: 0 }, { k: 'say', l: ['你好'], n: 'Bob<e1>' }]);
  const text = (r) => r.steps.filter((x) => x.k === 'say').map((x) => x.text);
  const ask = (opts, id = 'D', translate = null) => svc.scene(id, KEY, translate, opts);

  // Старый вызов, три аргумента: скобки DKTools не трогаются, ни lang, ни langs
  const legacy = await svc.scene('D', KEY, null);
  assert.deepStrictEqual(text(legacy), keys.slice(0, 4));
  assert.ok(!('lang' in legacy) && !('langs' in legacy));
  // Новый вызов: язык интерфейса; оригинал — без скобок; таблица записана рядом со сценариями
  const en1 = await ask({ ui: 'en', client: true });
  assert.strictEqual(en1.lang, 'en');
  assert.deepStrictEqual(text(en1), en.slice(0, 4));
  assert.deepStrictEqual(en1.langs.map((o) => o.code), ['zh', 'en', 'ja']);
  const file = path.join(root, '_media', 'D', 'scripts-1', 'langs.json');
  assert.strictEqual(JSON.parse(await fsp.readFile(file, 'utf8')).v, SL.VERSION);
  assert.deepStrictEqual(text(await ask({ want: ['orig'], ui: 'en', client: true })), zh.slice(0, 4), 'оригинал DKTools — ключ без скобок');
  assert.strictEqual(text(await ask({ want: ['ja'], ui: 'en', client: true }))[0], ja[0]);
  // Игра без таблиц: тело одно и то же с ui и без; теги в имени не показываются
  const P0 = await ask({ client: false }, 'P');
  assert.deepStrictEqual(await ask({ ui: 'ru', client: true }, 'P'), P0);
  assert.strictEqual(P0.steps[1].who, 'Bob');
  assert.ok(!('lang' in P0));

  // Кэш: файл читается, а не строится; другая версия — строится заново; новая папка сценариев — тоже; forget сбрасывает память
  let builds = 0;
  const build = SL.build;
  t.after(() => { SL.build = build; });
  SL.build = async (...a) => { builds++; return build(...a); };
  svc.langMemo.clear();
  await ask({ ui: 'en', client: true });
  assert.strictEqual(builds, 0, 'langs.json прочитан с диска');
  await fsp.writeFile(file, JSON.stringify({ v: 0, orig: '', langs: [], text: {} }));
  svc.langMemo.clear();
  assert.strictEqual((await ask({ ui: 'en', client: true })).lang, 'en');
  assert.strictEqual(builds, 1, 'другая версия — таблица строится заново');
  await fsp.writeFile(file, JSON.stringify({ v: 0, orig: '', langs: [], text: {} }));
  await ask({ ui: 'en', client: true });
  assert.strictEqual(builds, 1, 'второй раз — из памяти, файл не читается');
  await put('D', 'scripts-2', dSteps);
  await ask({ ui: 'en', client: true });
  assert.strictEqual(builds, 2, 'новая папка сценариев — новая таблица');
  assert.ok(svc.langMemo.has('D'));
  await svc.forget('D');
  assert.ok(!svc.langMemo.has('D'), 'forget сбрасывает память');
  // В памяти не больше восьми игр: новая вытесняет самую давнюю
  svc.langMemo.clear();
  for (let i = 0; i < 8; i++) svc.langMemo.set(`G${i}`, { dir: 'x', table: null });
  await put('D', 'scripts-3', dSteps);
  await svc.sceneLangs('D');
  assert.deepStrictEqual([svc.langMemo.size, svc.langMemo.has('G0'), svc.langMemo.has('D')], [8, false, true]);
  await fsp.rm(path.join(root, '_media', 'D', 'scripts-3', 'langs.json'));
  // Три запроса разом — одна сборка; папку сценариев тем временем удалили — langs.json её не воскрешает
  svc.langMemo.clear();
  builds = 0;
  SL.build = async (...a) => {
    builds++;
    await new Promise((done) => setTimeout(done, 30));
    const table = await build(...a);
    await fsp.rm(path.join(root, '_media', 'D', 'scripts-3'), { recursive: true, force: true });
    return table;
  };
  const three = await Promise.all([1, 2, 3].map(() => svc.sceneLangs('D')));
  assert.strictEqual(builds, 1);
  assert.ok(three.every((x) => x === three[0]) && three[0].langs.length === 2);
  assert.ok(!fs.existsSync(path.join(root, '_media', 'D', 'scripts-3')));
  SL.build = build;

  // Сбой таблицы и зависание: сцена всё равно открывается
  await put('D', 'scripts-4', dSteps);
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  svc.sceneLangs = async () => { throw new Error('boom'); };
  const failed = await ask({ ui: 'en', client: true });
  assert.ok(failed.steps.length && !('lang' in failed));
  svc.langWait = 40;
  svc.sceneLangs = () => new Promise(() => {});
  const t0 = Date.now();
  const hung = await ask({ ui: 'en', client: true });
  assert.ok(Date.now() - t0 >= 35 && Date.now() - t0 < 2000 && hung.steps.length && !('lang' in hung), 'зависло — ответ через срок, без языков');
  delete svc.sceneLangs;
  // Новый путь упал на показе — запасной путь отдаёт то же, что старый вызов
  const serve = SL.serve;
  SL.serve = () => { throw new Error('serve'); };
  const back = await ask({ ui: 'en', client: true });
  SL.serve = serve;
  assert.deepStrictEqual(back, await svc.scene('D', KEY, null));
  // Перевод Mimikin без таблицы игры: вариант «Mimikin» рядом с оригиналом, по умолчанию он
  const hello = async () => new Map([['你好', 'Hello']]);
  const mt = await ask({ ui: 'ru', client: true, mt: 'en' }, 'P', hello);
  assert.strictEqual(mt.lang, 'en');
  assert.deepStrictEqual(mt.langs, [{ code: 'orig', orig: true }, { code: 'en', mt: true, n: 1 }]);
  assert.strictEqual(mt.steps[1].text, 'Hello');
  assert.strictEqual((await ask({ want: ['orig'], ui: 'ru', client: true, mt: 'en' }, 'P', hello)).steps[1].text, '你好');
  // Перевод Mimikin упал — сцена открывается с оригиналом
  const broke = await ask({ ui: 'ru', client: true, mt: 'en' }, 'P', async () => { throw new Error('mt'); });
  assert.strictEqual(broke.steps[1].text, '你好');
});

test('галерея: в сценарии сцены — и кадры анимации, которых нет в альбоме сцены', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-anim-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  const pic = (name, color) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=816x624`, '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', `${name}.png`)]);
  pic('alpha', 'red');
  pic('omega', 'purple');
  for (const [n, color] of [['a1', 'green'], ['a2', 'blue'], ['a3', 'yellow'], ['a4', 'white']]) pic(n, color);
  const c = (code, parameters = []) => ({ code, parameters, indent: 0 });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  // CG под репликой, потом кадры анимации с короткими паузами — они уходят в «Анимации», а сцена в плеере их показывает
  const events = [show(1, 'alpha'), c(101, ['', 0, 0, 2]), c(401, ['one']),
    show(1, 'a1'), c(230, [4]), show(1, 'a2'), c(230, [4]), show(1, 'a3'), c(230, [4]), show(1, 'a4'), c(230, [4]),
    show(1, 'omega'), c(101, ['', 0, 0, 2]), c(401, ['two']), c(0)];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Сцена', list: events }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  // Сценарии прежней сборки — уходят, когда новое оглавление записано
  await fsp.mkdir(path.join(root, '_media', 'G', 'scripts'), { recursive: true });
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  assert.ok(!fs.existsSync(path.join(root, '_media', 'G', 'scripts')), 'старая папка сценариев удалена');
  const album = index.albums.find((a) => a.script);
  assert.ok(album, 'сцена со сценарием');
  const scene = await svc.scene('G', album.key);
  const shown = scene.steps.filter((x) => x.k === 'pic').map((x) => scene.files[x.i]);
  for (const n of ['a1', 'a2', 'a3', 'a4']) assert.ok(shown.includes(`img/pictures/${n}.png`), `кадр ${n} в сценарии: ${JSON.stringify(shown)}`);
  assert.deepStrictEqual(scene.steps.filter((x) => x.k === 'wait').map((x) => x.n), [4, 4, 4, 4]);
  // Кадр не из альбома сцены можно открыть
  assert.ok(await svc.image('G', 'img/pictures/a2.png'), 'кадр читается');
  // Пересборка: сценарии — в новой папке, прежняя убрана, кадры в index.parts не задваиваются
  await new Promise((r) => setTimeout(r, 5));
  const again = await svc.runBuild('G', { done: 0, total: 0 });
  assert.notStrictEqual(again.scripts, index.scripts);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '_media', 'G')).filter((n) => n.startsWith('scripts')), [again.scripts]);
  assert.strictEqual(new Set(again.parts || []).size, (again.parts || []).length);
  assert.ok((await svc.scene('G', album.key)).steps.length, 'сцена открывается после пересборки');
});

test('галерея: сценарий сцены — анимации PictureAnimation: цикл под репликами, остановка, звуки кадров, плавная смена, доигрывание', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const names = ['pa_00', 'pa_01', 'pa_02', 'pa_03', 'zz_00', 'zz_02', 'a_00', 'b_00'];
  for (let i = 1; i < 9; i++) names.push(`a_0${i}`, `b_0${i}`);
  const ctx = (extra = {}) => ({ names, has: (n) => names.includes(n), audio: (kind, name) => ({ rel: `audio/${kind}/${name}.ogg`, voice: false }), ...extra });
  const short = (x) => (x.k === 'pics' ? `pics:${x.pics.map((p) => p.name).join('+')}` : x.k === 'anim' ? `anim:${x.loop ? 'loop' : 'once'}:${x.cells.length}:${x.d.join(',')}${x.r ? `:r${x.r}` : ''}${x.x ? `:x${x.x.join(',')}` : ''}${x.s ? `:s${x.s.map(([t, se]) => `${t}@${se.f}`).join(',')}` : ''}`
    : x.k === 'say' ? `say:${x.l.join('/')}` : x.k === 'snd' ? `snd:${x.f}` : `${x.k}:${x.n}`);
  const run = (list, extra) => runList(list, [], ctx(extra)).scenario.map(short);

  // Цикл под двумя репликами одним шагом; «остановить» доигрывает круг (с кадра 0 и на него же при «вернуться к первому»),
  // «остановить сразу» — картинка. Кадры альбома от анимации не меняются
  const pa = [c(356, ['PA_INIT 4 6 連番']), show(1, 'pa_00'), c(356, ['PA_START_LOOP 1 1']), ...line('one'), ...line('two'), c(356, ['PA_STOP 1']), ...line('three'), ...line('four'), c(0)];
  assert.deepStrictEqual(run(pa, { paFirst: true }), ['anim:loop:4:6,6,6,6', 'say:one', 'say:two', 'anim:once:5:6,6,6,6,6', 'say:three', 'say:four']);
  assert.deepStrictEqual(run(pa)[3], 'anim:once:4:6,6,6,6', 'без «вернуться к первому» — на последнем кадре');
  assert.deepStrictEqual(run(pa.map((x) => (x.parameters[0] === 'PA_STOP 1' ? c(356, ['PA_STOP_FORCE 1']) : x)), { paFirst: true }),
    ['anim:loop:4:6,6,6,6', 'say:one', 'say:two', 'pics:pa_00', 'say:three', 'say:four']);

  // Звук кадра, заказанный до «подготовить»: уходит анимации, отдельным звуком не играет; следующий — обычный
  assert.deepStrictEqual(run([c(356, ['PA_SOUND 3']), c(250, [{ name: 'hit', volume: 80, pitch: 100, pan: 0 }]), c(356, ['PA_INIT 4 6 連番']), show(1, 'pa_00'), c(356, ['PA_START_LOOP 1 1']),
    ...line('x'), c(250, [{ name: 'slap', volume: 80, pitch: 100, pan: 0 }]), ...line('y'), c(0)]),
  ['anim:loop:4:6,6,6,6:s12@audio/se/hit.ogg', 'say:x', 'snd:audio/se/slap.ogg', 'say:y']);

  // MZ: плавная смена (fade) входит в длину кадра и в «x»; «ждать» — пауза на всю анимацию; звук ячейки — LINK_SOUND
  const mz = [c(357, ['PictureAnimation', 'INIT', '', { cellNumber: '4', frameNumber: '5', direction: '連番', fade: '10' }]),
    c(357, ['PictureAnimation', 'LINK_SOUND', '', { cellNumber: '2', se: JSON.stringify({ name: 'hit', volume: 90, pitch: 100, pan: 0 }) }]), show(2, 'pa_00'),
    c(357, ['PictureAnimation', 'START', '', { pictureNumber: '2', loop: 'false', animationType: '1', wait: 'true' }]), ...line('z'), c(0)];
  assert.deepStrictEqual(run(mz, { paFirst: true }), ['anim:once:5:15,15,15,15,15:x0,10,10,10,10:s15@audio/se/hit.ogg', 'wait:75', 'say:z']);
  assert.deepStrictEqual(run(mz), ['anim:once:4:15,15,15,15:x0,10,10,10:s15@audio/se/hit.ogg', 'wait:60', 'say:z']);

  // Два цикла разного темпа — один круг (по длинному), оба двигаются; нет файла основы — картинка не в анимации
  const two = [c(356, ['PA_INIT 9 5 連番 20']), show(50, 'a_00'), c(356, ['PA_START_LOOP 50 3 [4,4,4,4,4,5,4,4,4,4,4]']),
    c(356, ['PA_INIT 6 10 連番 1']), show(51, 'b_00'), c(356, ['PA_START_LOOP 51 3 [6,5,4,3,2,1,1,2,3,4,5]']), ...line('1'), ...line('2'), c(0)];
  const r2 = runList(two, [], ctx());
  const an = r2.scenario.filter((x) => x.k === 'anim');
  assert.strictEqual(an.length, 1, 'одна анимация на две картинки и две реплики');
  assert.strictEqual(an[0].d.reduce((a, b) => a + b, 0), 275, 'круг — длинный цикл: 9 кадров × 25');
  assert.ok(an[0].cells.some((cell) => cell.find((p) => p.n === 51).name !== cell.find((p) => p.n === 51).name.slice(0, 2) + '00'), 'короткий цикл тоже двигается');
  // Нет файла кадра — картинка стоит на последнем существующем: zz_01 и zz_03 нет, кадры 0 0 2 2 сливаются в два
  const gap = [c(356, ['PA_INIT 4 6 連番']), show(1, 'zz_00'), c(356, ['PA_START_LOOP 1 1']), ...line('a'), c(0)];
  assert.deepStrictEqual(run(gap), ['anim:loop:2:12,12', 'say:a']);
  assert.deepStrictEqual(run(gap, { has: (n) => n === 'zz_00' }), ['pics:zz_00', 'say:a'], 'остальных кадров в игре нет — двигаться нечему');
});

test('галерея: сценарий сцены — повторы цикла «показать, подождать» между rep, затемнения парами в цвете игры; реплики из-за них не пропадают', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, indent = 0) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0], indent);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const names = ['a', 'b'];
  const ctx = { names, has: (n) => names.includes(n), audio: (kind, name) => ({ rel: `audio/${kind}/${name}.ogg`, voice: false }) };
  const short = (x) => (x.k === 'pics' ? `pics:${x.pics.map((p) => p.name).join('+')}` : x.k === 'say' ? `say:${x.l.join('/')}` : x.k === 'snd' ? `snd:${x.f}` : x.k === 'fx' ? `fx:${x.t}:${x.o}${x.c ? `:${x.c}` : ''}` : `${x.k}:${x.n ?? x.o}`);
  const run = (list) => { const r = runList(list, [], ctx); return { steps: r.scenario.map(short), frames: r.frames }; };
  const counter = (body) => [c(122, [1, 1, 0, 0, 0]), c(112), ...body, c(122, [1, 1, 1, 0, 1], 1), c(111, [1, 1, 0, 3, 0], 1), c(113, [], 2), c(0, [], 2), c(412, [], 1), c(0, [], 1), c(413), ...line('done'), c(0)];

  // Три прохода: первый — как обычно, два следующих — между метками, одним нажатием пропускаются
  const loop = run(counter([show(1, 'a', 1), c(230, [10], 1), show(1, 'b', 1), c(230, [10], 1)]));
  assert.deepStrictEqual(loop.steps, ['pics:a', 'wait:10', 'pics:b', 'wait:10', 'rep:1', 'pics:a', 'wait:10', 'pics:b', 'wait:10', 'pics:a', 'wait:10', 'pics:b', 'wait:10', 'rep:0', 'say:done']);
  // Проходы, где картинки не меняются (только звук и пауза), откатываются: остаётся один, как раньше
  const quiet = run([c(122, [1, 1, 0, 0, 0]), c(112), c(111, [1, 1, 0, 0, 0], 1), show(1, 'a', 2), c(230, [10], 2), show(1, 'b', 2), c(230, [10], 2), c(0, [], 2), c(412, [], 1),
    c(250, [{ name: 'hit', volume: 90, pitch: 100, pan: 0 }], 1), c(230, [30], 1), c(122, [1, 1, 1, 0, 1], 1), c(111, [1, 1, 0, 3, 0], 1), c(113, [], 2), c(0, [], 2), c(412, [], 1), c(0, [], 1), c(413), ...line('done'), c(0)]);
  assert.deepStrictEqual(quiet.steps, ['pics:a', 'wait:10', 'pics:b', 'wait:10', 'snd:audio/se/hit.ogg', 'wait:30', 'say:done']);
  // Реплика в проходе — это не анимация: повторов нет
  assert.ok(!run(counter([show(1, 'a', 1), c(230, [10], 1), ...line('talk').map((x) => ({ ...x, indent: 1 })), show(1, 'b', 1), c(230, [10], 1)])).steps.includes('rep:1'));

  // Затемнение: шаг и пауза в 24 кадра, цвет — из «_fadeSprite.setColor», новая карта (201) цвет сбрасывает; скриптом — без паузы
  const fades = run([show(1, 'a'), ...line('one'), c(221), show(1, 'b'), c(222), ...line('two'), c(355, ['_fadeSprite.setColor(162,218,246)']), c(221), show(1, 'a'), c(222), ...line('three'),
    c(201, [0, 1, 1, 1, 0, 0]), c(221), show(1, 'b'), c(222), ...line('four'), c(355, ['$gameScreen.startFadeOut(30)']), c(0)]);
  assert.deepStrictEqual(fades.steps, ['pics:a', 'say:one', 'fx:fade:1', 'wait:24', 'pics:b', 'fx:fade:0', 'wait:24', 'say:two', 'fx:fade:1:162,218,246', 'wait:24', 'pics:a', 'fx:fade:0:162,218,246', 'wait:24', 'say:three',
    'fx:fade:1', 'wait:24', 'pics:b', 'fx:fade:0', 'wait:24', 'say:four', 'fx:fade:1']);
  assert.deepStrictEqual(fades.frames.map((f) => f.pics[0].name), ['a', 'b', 'a', 'b'], 'кадры альбома от затемнений не меняются');

  // Бюджет: затемнения считаются отдельно (600), реплики — до 1500 и затемнениями не вытесняются
  const talk = [];
  for (let i = 0; i < 1400; i++) talk.push(...line(`l${i}`));
  const heavy = [show(1, 'a')];
  for (let i = 0; i < 140; i++) heavy.push(c(221), c(222));
  const full = runList([...heavy, ...talk, c(0)], [], ctx).scenario;
  assert.strictEqual(full.filter((x) => x.k === 'say').length, 1400, 'все реплики на месте');
  assert.ok(full.filter((x) => x.k === 'fx').length <= 600);
});

test('галерея: сценарий сцены — fades() оставляет только пары с переменой под чёрным, squash() сводит кадры, paFirstCell читает plugins.js', async (t) => {
  const { fades, squash, analyze } = require('./src/services/galleryScenes.js');
  const { paFirstCell } = require('./src/services/gallery.js');
  const P = (i) => ({ k: 'pic', i });
  const SAY = { k: 'say', l: ['x'] };
  const OUT = { k: 'fx', t: 'fade', o: 1, n: 24 };
  const IN = { k: 'fx', t: 'fade', o: 0, n: 24 };
  const W = { k: 'wait', n: 24 };
  const word = (steps) => steps.map((x) => (x.k === 'pic' ? `p${x.i}` : x.k === 'fx' ? (x.o ? 'out' : 'in') : x.k === 'say' ? 's' : x.k === 'anim' ? 'a' : `w${x.n}`)).join(' ');
  assert.strictEqual(word(fades([P(0), SAY, OUT, W, P(1), IN, W, SAY])), 'p0 s out w24 p1 in w24 s', 'пара с новой картинкой остаётся');
  assert.strictEqual(word(fades([P(0), SAY, OUT, W, IN, W, SAY])), 'p0 s s', 'моргание без перемен — убрано вместе с паузами');
  assert.strictEqual(word(fades([P(0), OUT, W, SAY, SAY, SAY, SAY, SAY, SAY, IN, W, SAY])), 'p0 s s s s s s s', 'шесть реплик под чёрным — не затемнение');
  assert.strictEqual(word(fades([P(0), SAY, OUT, W])), 'p0 s', 'незакрытое в конце — убрано: сцена кончается картинкой');
  assert.strictEqual(word(fades([P(0), IN, W, SAY])), 'p0 s', 'появление без затемнения — убрано');
  assert.strictEqual(word(fades([P(0), OUT, W, OUT, W, P(1), IN, W, SAY])), 'p0 out w24 p1 in w24 s', 'второе затемнение подряд — убрано');
  assert.strictEqual(word(fades([P(0), OUT, W, P(1), { k: 'anim', f: [1, 2], d: [3, 3], loop: true }, IN, W, SAY])), 'p0 out w24 p1 a in w24 s', 'картинка и сразу её анимация — одна смена');
  const keep = [P(0), SAY];
  assert.strictEqual(fades(keep), keep, 'убирать нечего — тот же массив');

  // squash: пустой кадр отдаёт время соседу той же части (разгон — до r, круг — после), одинаковые подряд сливаются
  const q = squash([1, null, 1, 2, null, 3], [5, 5, 5, 5, 5, 5], 3);
  assert.deepStrictEqual([q.items, q.d, q.r, q.ring], [[1, 2, 3], [15, 10, 5], 1, true]);
  assert.strictEqual(squash([1, 1, null], [5, 5, 5], 0), null, 'один кадр — анимации нет');
  const gone = squash([null, null, 1, 2], [5, 5, 5, 5], 2, null, [[0, 'a'], [12, 'c']]);
  assert.deepStrictEqual([gone.r, gone.s], [0, [[0, 'a'], [2, 'c']]], 'разгон исчез целиком — звуки круга сдвинулись на его длину');

  // Сценарий группы: анимация — готовые кадры (4 разных), цикл; «finished» (кадры альбома) от неё не растут
  const c = (code, parameters = []) => ({ code, parameters, indent: 0 });
  const names = ['bg', 'sc_00', 'sc_01', 'sc_02', 'sc_03'];
  const list = [c(231, [2, 'bg', 0, 0, 0, 0, 100, 100, 255, 0]), c(101, ['', 0, 0, 2]), c(401, ['one']), c(356, ['PA_INIT 4 6 連番']), c(231, [1, 'sc_00', 0, 0, 0, 0, 100, 100, 255, 0]),
    c(356, ['PA_START_LOOP 1 1']), c(101, ['', 0, 0, 2]), c(401, ['two']), c(0)];
  const out = analyze([{ id: 'ce1', name: 'S', where: '', list }], [], () => 'cg', () => false, names, [], () => false, null, {});
  assert.strictEqual(out.groups.length, 1);
  const anim = out.groups[0].script.find((x) => x.k === 'anim');
  assert.ok(anim && anim.loop && anim.items.length === 4 && anim.d.join() === '6,6,6,6', JSON.stringify(anim));

  // plugins.js: ключи без кавычек, «вернуться к первому» включено только значением true/on; выключенный плагин и чужой параметр не в счёт
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-plug-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.mkdir(path.join(dir, 'js'));
  const plug = async (text) => { await fsp.writeFile(path.join(dir, 'js', 'plugins.js'), text); return paFirstCell(dir); };
  assert.strictEqual(await plug('var $plugins = [\n  {\n    name: "PictureAnimation",\n    status: true,\n    description: "",\n    parameters: { 最初のセルに戻る: "true" },\n  },\n];\n'), true);
  assert.strictEqual(await plug('var $plugins = [{"name":"folder/PictureAnimation","status":true,"description":"","parameters":{"ReturnToFirstCell":"on"}}];'), true);
  assert.strictEqual(await plug('var $plugins = [{"name":"PictureAnimation","status":true,"description":"","parameters":{"ReturnToFirstCell":"false"}}];'), false);
  assert.strictEqual(await plug('var $plugins = [{"name":"PictureAnimation","status":true,"description":"","parameters":{}}];'), false, 'параметра нет');
  assert.strictEqual(await plug('var $plugins = [{"name":"PictureAnimation","status":false,"description":"","parameters":{"ReturnToFirstCell":"true"}}];'), false, 'плагин выключен');
  assert.strictEqual(await paFirstCell(path.join(dir, 'нет такой папки')), false);
});

test('галерея: сценарий сцены — анимация PictureAnimation под репликами, затемнение парой, повторы цикла', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-pa-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  await fsp.mkdir(path.join(game, 'js'), { recursive: true });
  await fsp.mkdir(path.join(game, 'audio', 'se'), { recursive: true });
  await fsp.writeFile(path.join(game, 'audio', 'se', 'hit.ogg'), 'x');
  // plugins.js «красиво»: ключи без кавычек — «вернуться к первому кадру» всё равно читается
  await fsp.writeFile(path.join(game, 'js', 'plugins.js'), 'var $plugins = [\n  {\n    name: "PictureAnimation",\n    status: true,\n    description: "",\n    parameters: { 最初のセルに戻る: "true" },\n  },\n];\n');
  const pic = (name, color) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=816x624`, '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', `${name}.png`)]);
  pic('cg1', 'red'); pic('cg2', 'purple'); pic('ga', 'gray'); pic('gb', 'olive');
  for (const [n, color] of [['pa_00', 'green'], ['pa_01', 'blue'], ['pa_02', 'yellow'], ['pa_03', 'white']]) pic(n, color);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, ind = 0) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0], ind);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const events = [show(1, 'cg1'), ...line('one'),
    c(221), show(1, 'cg2'), c(222), ...line('two'),
    c(356, ['PA_SOUND 2']), c(250, [{ name: 'hit', volume: 80, pitch: 100, pan: 0 }]),
    c(356, ['PA_INIT 4 6 連番 2']), show(2, 'pa_00'), c(356, ['PA_START_LOOP 2 1']), ...line('three'), ...line('four'),
    c(235, [2]),
    c(122, [1, 1, 0, 0, 0]), c(112), show(1, 'ga', 1), c(230, [10], 1), show(1, 'gb', 1), c(230, [10], 1), c(122, [1, 1, 1, 0, 1], 1), c(111, [1, 1, 0, 3, 0], 1), c(113, [], 2), c(0, [], 2), c(412, [], 1), c(0, [], 1), c(413),
    ...line('five'), c(221), c(0)];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Сцена', list: events }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const album = index.albums.find((a) => a.script);
  assert.ok(album, JSON.stringify(index.albums.map((a) => [a.key, a.files])));
  const scene = await svc.scene('G', album.key);
  const name = (i) => scene.files[i].replace(/^img\/pictures\//, '').replace(/\.png$/, '');
  const sh = (x) => (x.k === 'pic' ? `pic:${scene.files[x.i].startsWith('@cg/') ? 'cg+' : name(x.i)}` : x.k === 'anim' ? `anim:${x.loop}:${x.f.length}:${x.d.join(',')}:${(x.s || []).map((y) => `${y.t}@${y.f}`).join(',')}:${(x.x || []).join(',')}` : x.k === 'fx' ? `fx:${x.t}:${x.o}` : x.k === 'say' ? `say:${x.text}` : x.k === 'wait' ? `w${x.n}` : x.k === 'rep' ? `rep${x.o}` : x.k);
  assert.strictEqual(scene.steps.map(sh).join(' | '), [
    'pic:cg1', 'say:one', 'fx:fade:1', 'w24', 'pic:cg2', 'fx:fade:0', 'w24', 'say:two', 'pic:pa_00', 'anim:true:4:8,8,8,8:8@audio/se/hit.ogg:2,2,2,2', 'say:three', 'say:four',
    'pic:ga', 'w10', 'pic:gb', 'w10', 'rep1', 'pic:ga', 'w10', 'pic:gb', 'w10', 'pic:ga', 'w10', 'pic:gb', 'w10', 'rep0', 'say:five'].join(' | '));
  const anim = scene.steps.find((x) => x.k === 'anim');
  assert.ok(anim && anim.loop && anim.f.length === 4, 'анимация 4 кадра по кругу');
  for (const i of anim.f) assert.ok(await svc.image('G', scene.files[i]), `кадр ${scene.files[i]} читается`);
  assert.deepStrictEqual(anim.d, [8, 8, 8, 8], 'кадр = frameNumber + плавная смена');
  assert.deepStrictEqual(anim.s.map((y) => [y.t, y.f]), [[8, 'audio/se/hit.ogg']], 'звук кадра 2 — на его смене, «Звук SE» сам не играет');
  assert.ok(!scene.steps.some((x) => x.k === 'snd'), 'заказанный звук — не отдельный шаг');
  assert.deepStrictEqual(scene.steps.filter((x) => x.k === 'fx' && x.t === 'fade').map((x) => x.o), [1, 0], 'пара затемнения; в конце — нет');
  assert.strictEqual(scene.steps.filter((x) => x.k === 'anim').length, 1, 'одна анимация на две реплики');
  assert.deepStrictEqual(scene.steps.filter((x) => x.k === 'rep').map((x) => x.o), [1, 0], 'повторы цикла отмечены');
});

test('галерея: сценарий сцены — картинка альбома по имени, под которой крутится анимация с чужими кадрами, не теряет сценарий', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-pacover-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  await fsp.mkdir(path.join(game, 'js'), { recursive: true });
  await fsp.writeFile(path.join(game, 'js', 'plugins.js'), 'var $plugins = [{"name":"PictureAnimation","status":true,"description":"","parameters":{}}];\n');
  const pic = (name, color) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=816x624`, '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', `${name}.png`)]);
  // Картинка «evh01» — основа PictureAnimation с кадрами из файлов «evh05» и «evh07» (список кадров в команде): сама основа
  // в шаге сценария не показана. «evh05» и «evh07» уходят в «Анимации»; в альбоме по имени остальные
  for (const [i, color] of ['red', 'purple', 'gray', 'green', 'blue', 'yellow', 'white', 'olive'].entries()) pic(`evh0${i + 1}`, color);
  const c = (code, parameters = []) => ({ code, parameters, indent: 0 });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const events = [c(356, ['PA_INIT 8 6 連番 0']), show(1, 'evh01'), c(356, ['PA_START_LOOP 1 3 [6,8]']), ...line('one'), ...line('two'), c(0)];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Сцена', list: events }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  // Основу «evh01» шаг сценария не называет — показ это анимация; кнопка «Смотреть сцену» у альбома остаётся
  const album = index.albums.find((a) => a.key === 'img/pictures/evh');
  assert.ok(album && album.script, JSON.stringify(index.albums.map((a) => [a.key, a.script, a.files])));
  // Альбом по имени файла зовётся по сцене из игры — вкладка «Сцены» показывает это название
  assert.strictEqual(album.title, 'Сцена');
  assert.ok(!album.files.includes('img/pictures/evh05.png'), 'кадры анимации — в «Анимациях», не в альбоме по имени');
  const scene = await svc.scene('G', album.key);
  assert.deepStrictEqual(scene.steps.filter((x) => x.k !== 'say').map((x) => x.k), ['pic', 'anim']);
  assert.strictEqual(scene.steps.filter((x) => x.k === 'say').length, 2);
});

test('галерея: сценарий сцены — правило «анимация закрывает основу» узкое: закрывает только картинки главной ветки сцены, чужие показы альбома остаются чужими', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-pacover2-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  await fsp.mkdir(path.join(game, 'js'), { recursive: true });
  await fsp.writeFile(path.join(game, 'js', 'plugins.js'), 'var $plugins = [{"name":"PictureAnimation","status":true,"description":"","parameters":{}}];\n');
  const pic = (name, color) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=816x624`, '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', `${name}.png`)]);
  for (const [i, color] of ['red', 'purple', 'gray', 'green', 'blue', 'yellow', 'white', 'olive'].entries()) pic(`evh0${i + 1}`, color);
  const c = (code, parameters = []) => ({ code, parameters, indent: 0 });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  // Первая сцена — как в соседнем тесте: основа «evh01» под анимацией с чужими кадрами (закрыта правилом). Остальные три картинки
  // альбома показывают по одной три другие сцены (одна картинка — своего альбома у события нет, она остаётся в альбоме по
  // имени): картинок, что показывают другие, больше, чем у первой, и сценарий у альбома не появляется
  const first = [c(356, ['PA_INIT 8 6 連番 0']), show(1, 'evh01'), c(356, ['PA_START_LOOP 1 3 [6,8]']), ...line('one'), ...line('two'), c(0)];
  const other = (k) => [show(1, `evh0${k}`), ...line(`x${k}`), ...line(`y${k}`), c(0)];
  const events = [null, { id: 1, name: 'Первая', list: first }, ...[2, 3, 4].map((k) => ({ id: k, name: `Сцена${k}`, list: other(k) }))];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify(events));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const album = index.albums.find((a) => a.key === 'img/pictures/evh');
  assert.ok(album && !album.script, JSON.stringify(index.albums.map((a) => [a.key, a.script, a.files])));
});

test('галерея: сценарий сцены — запись анимации: кадры с разной обрезкой — картинкой, пустые кадры сливаются, звуки — номерами; пустые повторы и лишние затемнения убираются', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-write-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  await fsp.mkdir(path.join(root, 'G', 'data'), { recursive: true });
  const write = async (raw, cropOf = null) => {
    const index = { builtAt: 7, albums: [{ key: 'events/0/Сцена', kind: 'cg', files: ['a.png', 'b.png'] }], parts: [] };
    await svc.writeScripts('G', path.join(root, 'G'), index, new Map([['events/0/Сцена', raw]]), { cropOf });
    if (!index.scripts) return null;
    return JSON.parse(await fsp.readFile(svc.scriptPath('G', index.scripts, 'events/0/Сцена'), 'utf8'));
  };
  const say = { k: 'say', l: ['hi'] };
  const frames = ['a.png', 'b.png', '@cg/0123456789abcdef0123'];
  const anim = { k: 'anim', f: frames, d: [5, 5, 5], loop: true, s: [[5, { f: 'audio/se/hit.ogg', vol: 80, pitch: 100, pan: 0 }]] };
  // Обычная анимация: сначала её первый кадр картинкой, кадры вне альбома дописаны в files, звук — номер в sounds
  const plain = await write([{ k: 'pic', f: 'a.png' }, anim, say]);
  assert.deepStrictEqual(plain.steps.map((x) => x.k), ['pic', 'anim', 'say']);
  assert.deepStrictEqual(plain.steps[1], { k: 'anim', f: [0, 1, 2], d: [5, 5, 5], loop: true, s: [[5, 0, 80, 100, 0]] });
  assert.deepStrictEqual(plain.files, ['a.png', 'b.png', '@cg/0123456789abcdef0123']);
  assert.deepStrictEqual(plain.sounds, ['audio/se/hit.ogg']);
  // У кадров разная обрезка: окно плеера одно на все кадры — остаётся последний кадр картинкой
  const mixed = await write([{ k: 'pic', f: 'a.png' }, anim, say], (f) => (f.startsWith('@cg/') ? '[1,2,3,4]' : ''));
  assert.deepStrictEqual(mixed.steps.map((x) => x.k), ['pic', 'pic', 'say']);
  assert.strictEqual(mixed.files[mixed.steps[1].i], '@cg/0123456789abcdef0123');
  // Кадры без файла (null) отдают время соседу; тот же цикл подряд не перезапускается; чужой вид шага не роняет запись
  const gappy = await write([{ k: 'pic', f: 'a.png' }, { k: 'anim', f: ['a.png', undefined, 'b.png'], d: [5, 5, 5], loop: true }, { k: 'anim', f: ['a.png', undefined, 'b.png'], d: [5, 5, 5], loop: true },
    { k: 'anim', frames: [1, 2] }, say]);
  assert.deepStrictEqual(gappy.steps.map((x) => x.k), ['pic', 'anim', 'say']);
  assert.deepStrictEqual([gappy.steps[1].f, gappy.steps[1].d], [[0, 1], [10, 5]]);
  // Пустые границы повторов и затемнение, под которым ничего не менялось, убираются вместе с его паузой
  const tidy = await write([{ k: 'pic', f: 'a.png' }, { k: 'rep', o: 1 }, { k: 'rep', o: 0 }, say, { k: 'fx', t: 'fade', o: 1, n: 24 }, { k: 'wait', n: 24 }, { k: 'fx', t: 'fade', o: 0, n: 24 }, { k: 'wait', n: 24 }, say]);
  assert.deepStrictEqual(tidy.steps.map((x) => x.k), ['pic', 'say', 'say']);
});

test('галерея: сценарий сцены — ролики: MoviePicture MZ и MV, «Показать видео», PKD_VPlayer, ожидание конца, подгрузка; альбомы и группы как раньше', () => {
  const S = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, x = 0, y = 0, op = 255, blend = 0) => c(231, [n, name, 0, 0, x, y, 100, 100, op, blend]);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const names = ['cg', 'cg2', 'ui_gauge', 'bg'];
  const movies = ['loop_a', 'mov_b', 'v1', 'v2'];
  const ctx = (extra = {}) => ({ names, has: (n) => names.includes(n), movies, movieSet: new Set(movies), audio: null, videoRel: (n) => `movies/${n}.webm`,
    outerRel: (p) => (p === 'img/pictures/o.webm' ? 'img/pictures/o.webm' : null), ...extra });
  const vids = (sc) => sc.filter((x) => x.k === 'vid').map((x) => x.v.map((v) => `${v.s}:${v.f.split('/').pop()}${v.loop ? 'L' : ''}`).join(','));

  // MZ: «подготовить» + картинка без имени — ролик, а не картинка; кадров с пустым именем нет, петля в альбомы идёт как раньше
  const mz = S.runList([c(357, ['MoviePicture', 'PREPARE', '', { fileName: 'loop_a', loop: 'true', volume: '60' }]), show(5, ''), ...line('a')], [], ctx());
  assert.deepStrictEqual(vids(mz.scenario), ['p5:loop_a.webmL']);
  assert.strictEqual(mz.scenario.find((x) => x.k === 'vid').v[0].vol, 60);
  assert.ok(mz.frames.every((f) => f.pics.every((p) => p.name !== '')), 'пустого имени в кадрах нет');
  assert.deepStrictEqual([...mz.movies], [['loop_a', true]]);
  // Без файла (имени нет в movies/) слоя нет
  assert.deepStrictEqual(vids(S.runList([c(357, ['MoviePicture', 'PREPARE', '', { fileName: 'nope', loop: 'false' }]), show(5, ''), ...line('a')], [], ctx()).scenario), []);

  // MV: картинка с именем ролик не берёт (он ждёт картинку без имени); петля, ожидание, стереть. Имя для альбомов-петель
  // берёт картинка «cg», как раньше; такая картинка «» по-прежнему делает событие группой
  const mv = S.runList([c(356, ['MP_SET_MOVIE loop_a on']), show(9, 'cg'), show(3, ''), c(356, ['MP_SET_LOOP 3 on']), ...line('a'), c(356, ['MP_SET_WAIT 3']), c(235, [3]), ...line('b')], [], ctx());
  assert.deepStrictEqual(vids(mv.scenario), ['p3:loop_a.webmL', '']);
  assert.ok(mv.scenario.some((x) => x.k === 'vwait' && x.s === 'p3'));
  assert.deepStrictEqual([...mv.movies], [['loop_a', false]]);
  // Картинка «» под ролик, на которую встало имя из MP_SET_MOVIE, — blank: событие остаётся группой, как с картинкой «»
  const blank = S.runList([show(1, 'cg'), c(356, ['MP_SET_MOVIE loop_a']), show(3, ''), ...line('y')], [], ctx());
  assert.strictEqual(blank.blank, true);
  assert.ok(blank.frames.every((f) => f.pics.every((p) => p.name !== '')));
  const src = [{ id: 'ce1', name: 'A', where: '', list: [show(1, 'cg'), ...line('x'), c(356, ['MP_SET_MOVIE loop_a']), show(3, ''), ...line('y')] }];
  const g = S.analyze(src, [], (n) => (n === 'cg' ? 'cg' : null), () => false, names, movies, () => false, null, { video: { videoRel: (m) => `movies/${m}.webm` } });
  assert.strictEqual(g.groups.length, 1, 'группа — как с картинкой «»');

  // «Показать видео» (261): на весь экран и ждём; с MovieManager (свой command261) ничего не пишем
  const p261 = S.runList([...line('a'), c(261, ['mov_b']), ...line('b')], [], ctx());
  assert.deepStrictEqual(vids(p261.scenario), ['m:mov_b.webm', '']);
  assert.ok(p261.scenario.some((x) => x.k === 'vwait' && x.s === 'm'));
  assert.deepStrictEqual(p261.scenario.find((x) => x.k === 'vid').v[0], { s: 'm', f: 'movies/mov_b.webm', loop: false, fit: true, top: true, own: true });
  assert.ok(!S.runList([...line('a'), c(261, ['mov_b']), ...line('b')], [], ctx({ movieManager: true })).scenario.some((x) => x.k === 'vid' || x.k === 'vwait'));

  // PKD_VPlayer: скрипт и команда MZ, на карте — нет, цепочка конца, удаление в обеих формах
  const pkd = S.runList([c(355, ['ShowVAnimOnSpriteset(5,"v1",60,90,false)']), c(355, ['SetEndScriptToVAnim(5, "ShowVAnimOnSpriteset(5, \'v2\', 60, 90, true)", false)']), ...line('a'),
    c(357, ['PKD_VPlayer', 'ShowVAnim', '', { id: 'loop_a', order: 'Screen, below windows', x: '0', y: '0', isLoop: 'true' }]),
    c(357, ['PKD_VPlayer', 'ShowVAnim', '', { id: 'mov_b', order: 'Map, below Events', x: '3', y: '4', isLoop: 'true' }]), ...line('b'),
    c(355, ['DeleteVAnim(5)']), c(357, ['PKD_VPlayer', 'DeleteVAnim', '', { id: 'loop_a' }]), ...line('c')], [], ctx());
  assert.deepStrictEqual(vids(pkd.scenario), ['v5:v1.webm', 'v5:v1.webm,vloop_a:loop_a.webmL', '']);
  const v5 = pkd.scenario.find((x) => x.k === 'vid').v[0];
  assert.deepStrictEqual([v5.x, v5.y, v5.keep, v5.nx && v5.nx.f], [60, 90, true, 'movies/v2.webm']);

  // Петля, заданная непонятным значением, — петля (как без аргумента); только явное false — один раз
  const lp = (arg) => S.runList([c(355, [`ShowVAnimOnSpriteset(5,"v1",0,0${arg})`]), ...line('a')], [], ctx()).scenario.find((x) => x.k === 'vid').v[0];
  assert.deepStrictEqual([lp(',$gameVariables.value(9)').loop, lp(',false').loop, lp('').loop], [true, false, true]);
  // Подгрузка (MP_SET_LIMIT ≤ 10) — не показ и не ожидание; без неё — ролик и ожидание его конца
  const pre = S.runList([c(356, ['MP_SET_OUTER_MOVIE img/pictures/o.webm']), show(11, ''), c(356, ['MP_SET_LIMIT 11 3']), c(111, [12, '$gameScreen.picture(11).isVideoEnd();']), c(235, [11], 1), c(0, [], 1), c(412),
    c(356, ['MP_SET_OUTER_MOVIE img/pictures/o.webm']), show(21, ''), ...line('a'), c(111, [12, '$gameScreen.picture(21).isVideoEnd();']), c(0, [], 1), c(412), ...line('b')], [], ctx());
  assert.deepStrictEqual(vids(pre.scenario), ['p21:o.webm']);
  assert.deepStrictEqual(pre.scenario.filter((x) => x.k === 'vwait').map((x) => x.s), ['p21']);
  // Прозрачность ноль — не рисуется; смешивание берётся из 231 (p[9])
  const blend = S.runList([c(357, ['MoviePicture', 'PREPARE', '', { fileName: 'loop_a', loop: 'true' }]), show(5, '', 0, 0, 0), c(230, [5]), ...line('a')], [], ctx());
  assert.deepStrictEqual(vids(blend.scenario), []);
  const add = S.runList([c(357, ['MoviePicture', 'PREPARE', '', { fileName: 'loop_a', loop: 'true' }]), show(5, '', 0, 0, 255, 1), ...line('a')], [], ctx());
  assert.strictEqual(add.scenario.find((x) => x.k === 'vid').v[0].b, 1);

  // Шаги роликов на своём счёте: реплики не вытесняются
  const many = [];
  for (let i = 0; i < 500; i++) many.push(c(355, [`ShowVAnim(${i % 3},"${i % 2 ? 'v1' : 'v2'}",0,0,true)`]), ...line(`l${i}`));
  const heavy = S.runList(many, [], ctx());
  assert.strictEqual(heavy.scenario.filter((x) => x.k === 'say').length, 500, 'все реплики на месте');
  assert.ok(heavy.scenario.filter((x) => x.k === 'vid').length <= 400);
});

test('галерея: сценарий сцены — видимость роликов (scriptOf): CG выше прячет, интерфейс не прячет, картинку под роликом убирают и возвращают; без роликов — как раньше', () => {
  const { scriptOf, fades, blinks } = require('./src/services/galleryScenes.js');
  const info = (nm) => (nm === 'cg' || nm === 'cg2' ? { kind: 'cg', uses: 1 } : nm === 'ui_gauge' ? { kind: 'other', uses: 9 } : nm === 'eff' ? { kind: 'layer', uses: 1 } : null);
  const P = (n, name, x = 0) => ({ n, name, x, y: 0, o: 0, zx: 100, zy: 100, op: 255 });
  const V = (s) => ({ s, f: 'movies/loop_a.webm', loop: true });
  const sh = (out) => out.script.map((x) => (x.k === 'pic' ? (x.item ? `P(${x.item.name || x.item.layers.map((l) => l.name).join('+')})${x.at ? '@' : ''}` : 'P-') : x.k === 'vid' ? `V[${x.v.map((v) => v.s).join(',')}]` : x.k[0])).join(' ');
  // Ролик 3 над CG 2: виден; CG 4 поверх прячет его; интерфейс 9 (не в склейке) не прячет; CG стёрли — убрать картинку; ролик ушёл — прежняя CG
  const steps = [{ k: 'pics', pics: [P(2, 'cg')] }, { k: 'vid', v: [V('p3')] }, { k: 'say', l: ['a'] },
    { k: 'pics', pics: [P(2, 'cg'), P(4, 'cg2')] }, { k: 'say', l: ['b'] },
    { k: 'pics', pics: [P(2, 'cg'), P(9, 'ui_gauge')] }, { k: 'say', l: ['c'] },
    { k: 'pics', pics: [] }, { k: 'say', l: ['d'] }, { k: 'vid', v: [] }, { k: 'say', l: ['e'] }];
  assert.strictEqual(sh(scriptOf(steps, info, false)), 'P(cg)@ V[p3] s P(cg2) V[] s P(cg)@ V[p3] s P- s V[] P(cg) s');
  // Слой эффекта 5 над роликом 3 — часть склейки: ролик в игре под ним, не виден
  const eff = scriptOf([{ k: 'pics', pics: [P(2, 'cg'), P(5, 'eff')] }, { k: 'vid', v: [V('p3')] }, { k: 'say', l: ['a'] }], info, false);
  assert.ok(!eff.script.some((x) => x.k === 'vid' && x.v.length));
  // Картинка показана раньше (реплика между), ролик включился позже: целая картинка получает место вторым шагом
  assert.strictEqual(sh(scriptOf([{ k: 'pics', pics: [P(2, 'cg')] }, { k: 'say', l: ['a'] }, { k: 'vid', v: [V('p3')] }, { k: 'say', l: ['b'] }], info, false)), 'P(cg) s P(cg)@ V[p3] s');
  // Ролик появился и ушёл без реплики, звука и ожидания между — мелькания нет; с ожиданием — остаётся
  const kinds = (st) => st.map((x) => x.k + (x.k === 'vid' ? x.v.length : '')).join(' ');
  assert.strictEqual(kinds(blinks([{ k: 'pic', i: -1 }, { k: 'vid', v: [{ s: 'p3' }] }, { k: 'vid', v: [] }, { k: 'pic', i: 0 }, { k: 'say' }])), 'pic vid0 pic say');
  assert.strictEqual(kinds(blinks([{ k: 'vid', v: [{ s: 'p3' }] }, { k: 'vwait', s: 'p3' }, { k: 'vid', v: [] }, { k: 'say' }])), 'vid1 vwait vid0 say');
  // Только ролик и реплики: сценарий есть, пустой экран — «убрать картинку» не нужна, пока ничего не было показано
  assert.strictEqual(sh(scriptOf([{ k: 'vid', v: [V('v1')] }, { k: 'say', l: ['a'] }], info, false)), 'V[v1] s');
  assert.deepStrictEqual(scriptOf([{ k: 'say', l: ['a'] }], info, false), {});
  // Без шагов vid — слово в слово как раньше
  const plain = [{ k: 'pics', pics: [P(2, 'cg')] }, { k: 'say', l: ['a'] }, { k: 'pics', pics: [P(2, 'cg'), P(4, 'cg2')] }, { k: 'say', l: ['b'] }];
  assert.deepStrictEqual(scriptOf(plain, info, false), { script: [{ k: 'pic', item: { name: 'cg' } }, { k: 'say', l: ['a'] }, { k: 'pic', item: { name: 'cg2' } }, { k: 'say', l: ['b'] }] });
  // Смена роликов под чёрным — смена картинки: пара затемнения с репликами и сменой ролика остаётся
  const under = fades([{ k: 'pic', i: 0 }, { k: 'fx', t: 'fade', o: 1, n: 24 }, { k: 'vid', v: [{ s: 'p3', i: 0 }] }, { k: 'say' }, { k: 'fx', t: 'fade', o: 0, n: 24 }, { k: 'say' }]);
  assert.strictEqual(under.filter((x) => x.k === 'fx').length, 2);
});

test('галерея: ролики — плагины игры читаются по коду (имя в списке не важно), прозрачность WebM по заголовку, тип по первым байтам', async (t) => {
  const { spawnSync } = require('child_process');
  const { videoFlags, videoAlpha, videoType } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-vflags-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'js', 'plugins'), { recursive: true });
  // plugins.js «красиво» (ключи без кавычек): MoviePicture под чужим именем, «удалять по окончании» выключено; MovieManager без command261; чужой плагин с command261
  await fsp.writeFile(path.join(root, 'js', 'plugins.js'), 'var $plugins = [\n  { name: "MovieManager", status: true, description: "", parameters: { 終了時自動削除: "false" } },\n'
    + '  { name: "MyVideo", status: true, description: "動画", parameters: {} },\n  { name: "Off", status: false, description: "movie", parameters: {} },\n];\n');
  await fsp.writeFile(path.join(root, 'js', 'plugins', 'MovieManager.js'), 'Game_Interpreter.prototype.pluginCommand = function () { /* MP_SET_MOVIE */ };');
  assert.deepStrictEqual(await videoFlags(root), { movieManager: false, keepEnd: true }, 'MoviePicture под именем MovieManager: ролик остаётся, 261 ждёт');
  await fsp.writeFile(path.join(root, 'js', 'plugins', 'MyVideo.js'), 'Game_Interpreter.prototype.command261 = function () { return true; };');
  assert.strictEqual((await videoFlags(root)).movieManager, true);
  assert.deepStrictEqual(await videoFlags(path.join(root, 'нет')), { movieManager: false, keepEnd: false });
  // Заголовок: EBML + AlphaMode 1 — прозрачный; без — нет; MP4 под именем .webm — «video/mp4»
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0];
  await fsp.writeFile(path.join(root, 'a.webm'), Buffer.from([...ebml, 0x53, 0xc0, 0x81, 0x01, 0, 0]));
  await fsp.writeFile(path.join(root, 'b.webm'), Buffer.from([...ebml, 0x53, 0xc0, 0x81, 0x00, 0, 0]));
  await fsp.writeFile(path.join(root, 'c.webm'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]));
  await fsp.writeFile(path.join(root, 'd.webm'), Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)]));
  assert.deepStrictEqual([await videoAlpha(path.join(root, 'a.webm')), await videoAlpha(path.join(root, 'b.webm')), await videoAlpha(path.join(root, 'c.webm')), await videoAlpha(path.join(root, 'нет'))], [true, false, false, false]);
  assert.deepStrictEqual([await videoType(path.join(root, 'a.webm')), await videoType(path.join(root, 'c.webm')), await videoType(path.join(root, 'd.webm')), await videoType(path.join(root, 'нет'))], ['video/webm', 'video/mp4', 'video/ogg', null]);
  // Настоящий ffmpeg: прозрачный VP9 — true, обычный — false
  if (spawnSync('ffmpeg', ['-version']).status === 0) {
    const mk = (name, pix) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red@0.5:s=32x32:d=0.2,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', pix, '-auto-alt-ref', '0', path.join(root, name)]);
    if (mk('alpha.webm', 'yuva420p').status === 0 && mk('solid.webm', 'yuv420p').status === 0) {
      assert.strictEqual(await videoAlpha(path.join(root, 'alpha.webm')), true);
      assert.strictEqual(await videoAlpha(path.join(root, 'solid.webm')), false);
    }
  }
});

test('галерея: сценарий сцены — ролик в сборке: слой в сценарии, картинка не по размеру экрана — склейкой, запись пишет videos и parts; тип MP4 под именем .webm', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-video-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  await fsp.mkdir(path.join(game, 'movies'), { recursive: true });
  // Три картинки в трёх папках — три альбома по имени, а сцену из событий собирает событие
  const pic = (name, color, size = '816x624') => {
    fs.mkdirSync(path.dirname(path.join(game, 'img', 'pictures', `${name}.png`)), { recursive: true });
    return spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', `${name}.png`)]);
  };
  pic('s1/cg1', 'red'); pic('s2/cg2', 'purple'); pic('s3/wide', 'gray', '1500x900');
  // Ролик: 2-секундный WebM (петля не короче 2 секунд — «Видео», не анимация сцены не важно), второй — MP4 под именем .webm
  const clip = (name, args) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x64:d=1:r=10', ...args, path.join(game, 'movies', name)]);
  assert.strictEqual(clip('clipa.webm', ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p']).status, 0);
  assert.strictEqual(clip('clipb.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']).status, 0);
  await fsp.copyFile(path.join(game, 'movies', 'clipb.mp4'), path.join(game, 'movies', 'clipc.webm'));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const prep = (f) => c(357, ['MoviePicture', 'PREPARE', '', { fileName: f, loop: 'true', volume: '100', autoplay: 'true' }]);
  // Две CG; на второй играет ролик (картинка 1500×900 — не по размеру экрана: склейка из одного слоя); потом ролик ушёл
  const events = [show(1, 's1/cg1'), ...line('one'), show(1, 's3/wide'), ...line('two'), prep('clipa'), show(4, ''), ...line('three'), c(235, [4]), ...line('four'), show(1, 's2/cg2'), ...line('five'), c(0)];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Сцена', list: events }]));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const album = index.albums.find((a) => a.script && a.key.startsWith('events/'));
  assert.ok(album, JSON.stringify(index.albums.map((a) => [a.key, a.script, a.files])));
  const scene = await svc.scene('G', album.key);
  assert.deepStrictEqual(scene.screen, index.screen);
  const kinds = scene.steps.map((x) => (x.k === 'vid' ? `vid:${x.v.map((v) => v.f).join(',')}` : x.k === 'pic' ? `pic:${scene.files[x.i]?.startsWith('@cg/') ? 'cg+' : scene.files[x.i]}` : x.k));
  assert.deepStrictEqual(kinds, ['pic:img/pictures/s1/cg1.png', 'say', 'pic:img/pictures/s3/wide.png', 'say', 'pic:cg+', 'vid:movies/clipa.webm', 'say', 'vid:', 'say', 'pic:img/pictures/s2/cg2.png', 'say']);
  const vid = scene.steps.find((x) => x.k === 'vid' && x.v.length).v[0];
  assert.deepStrictEqual([vid.s, vid.loop, vid.x, vid.y], ['p4', true, 0, 0]);
  assert.ok(!vid.a, 'без прозрачности');
  // Ролик читается из оглавления, тип — по содержимому
  assert.strictEqual((await svc.video('G', 'movies/clipa.webm')).type, 'video/webm');
  const mp4 = index.albums.flatMap((a) => a.files).find((f) => f.startsWith('movies/clipc'));
  if (mp4) assert.strictEqual((await svc.video('G', mp4)).type, 'video/mp4');
  // Альбомы те же, что без ролика: тот же набор ключей и файлов
  const plain = events.filter((x) => !(x.code === 357 || (x.code === 231 && x.parameters[1] === '') || x.code === 235));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, { id: 1, name: 'Сцена', list: plain }]));
  svc.forget('G');
  const quiet2 = t.mock.method(console, 'log', () => {});
  const again = await svc.runBuild('G', { done: 0, total: 0 });
  quiet2.mock.restore();
  const shape = (ix) => ix.albums.filter((a) => a.kind === 'cg').map((a) => [a.key, a.files.filter((f) => !f.startsWith('@cg/'))]);
  assert.deepStrictEqual(shape(index), shape(again), 'ролик в сценарии альбомов не меняет');
});

test('галерея: сценарий сцены — запись: убрать картинку (−1), ролики номерами с вложенным следующим, прозрачный a, файлы вне альбомов — в parts; сцена из одного ролика и реплик пишется', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-wvid-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  await fsp.mkdir(path.join(root, 'G', 'movies'), { recursive: true });
  await fsp.writeFile(path.join(root, 'G', 'movies', 'al.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0x53, 0xc0, 0x81, 0x01, 0, 0]));
  await fsp.writeFile(path.join(root, 'G', 'movies', 'plain.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0]));
  const write = async (raw) => {
    const index = { builtAt: 9, albums: [{ key: 'events/0/Сцена', kind: 'cg', files: ['a.png', 'b.png'] }], parts: [] };
    await svc.writeScripts('G', path.join(root, 'G'), index, new Map([['events/0/Сцена', raw]]));
    if (!index.scripts) return { index, out: null };
    return { index, out: JSON.parse(await fsp.readFile(svc.scriptPath('G', index.scripts, 'events/0/Сцена'), 'utf8')) };
  };
  const say = { k: 'say', l: ['hi'] };
  const { index, out } = await write([{ k: 'pic', f: 'a.png' }, { k: 'pic', none: true }, { k: 'pic', none: true }, { k: 'vid', v: [{ s: 'p3', f: 'movies/al.webm', loop: true, x: 0, y: 0 }, { s: 'v1', f: 'movies/plain.webm', loop: false, x: 5, y: 6, keep: true, nx: { f: 'movies/al.webm', loop: true, x: 5, y: 6 } }] }, say, { k: 'vwait', s: 'p3' }, { k: 'vid', v: [] }, say]);
  assert.deepStrictEqual(out.videos, ['movies/al.webm', 'movies/plain.webm']);
  assert.deepStrictEqual(out.steps.map((x) => x.k === 'pic' ? `pic${x.i}` : x.k), ['pic0', 'pic-1', 'vid', 'say', 'vwait', 'vid', 'say'], 'убрать картинку — один раз подряд');
  assert.deepStrictEqual(out.steps[2].v, [{ s: 'p3', loop: true, x: 0, y: 0, i: 0, a: true }, { s: 'v1', loop: false, x: 5, y: 6, keep: true, i: 1, nx: { loop: true, x: 5, y: 6, i: 0 } }]);
  assert.deepStrictEqual(index.parts.sort(), ['movies/al.webm', 'movies/plain.webm'], 'ролики вне альбомов читаются через parts');
  assert.strictEqual(index.albums[0].script, true);
  // Только ролик и реплики (картинки нет совсем) — сценарий пишется; без ролика и картинки — нет
  assert.ok((await write([{ k: 'vid', v: [{ s: 'v1', f: 'movies/plain.webm', loop: true, x: 0, y: 0 }] }, say])).out);
  assert.strictEqual((await write([{ k: 'pic', none: true }, say])).out, null);
});

test('галерея: сцены из одних роликов (analyze.vscenes) — три реплики под своим роликом; «стоит персонаж», тестовая карта, чужой ролик и две реплики — не сцены; источники только с роликами групп не меняют', () => {
  const S = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const prep = (f) => c(357, ['MoviePicture', 'PREPARE', '', { fileName: f, loop: 'true' }]);
  const names = ['cg'];
  const movies = ['loop_a', 'loop_b', 'npc_idle'];
  const opts = { video: { videoRel: (m) => `movies/${m}.webm` } };
  const run = (sources, ces = []) => S.analyze(sources, ces, (n) => (n === 'cg' ? 'cg' : null), () => false, names, movies, () => false, null, opts);
  const ev = (id, f, lines, extra = {}) => ({ id, name: `Сцена ${id}`, where: 'Город', list: [prep(f), c(231, [5, '', 0, 0, 0, 0, 100, 100, 255, 0]), ...lines.flatMap(line)], ...extra });
  const three = ['а', 'б', 'в'];

  // Свой ролик и три реплики под ним — сцена; название — из имени события, первая страница событий карты
  const ok = run([ev('m1e5p0', 'loop_a', three)]);
  assert.strictEqual(ok.vscenes.length, 1);
  assert.deepStrictEqual([ok.vscenes[0].id, ok.vscenes[0].title, ok.vscenes[0].own, ok.vscenes[0].lines, ok.vscenes[0].core.length, ok.vscenes[0].named], ['m1e5p0', 'Сцена m1e5p0', ['movies/loop_a.webm'], 3, 3, true]);
  assert.ok(ok.vscenes[0].script.some((x) => x.k === 'vid' && x.v[0].own), 'в сценарии ролик помечен «свой»');
  // Две реплики — мало; «стоит персонаж» (имя) — не сцена; тестовая карта — не сцена
  assert.strictEqual(run([ev('m1e5p0', 'loop_a', ['а', 'б'])]).vscenes.length, 0);
  assert.strictEqual(run([ev('m1e5p0', 'npc_idle', three)]).vscenes.length, 0);
  assert.strictEqual(run([ev('m1e5p0', 'loop_a', three, { where: 'テスト' })]).vscenes.length, 0);
  // Тот же ролик на трёх страницах одного события карты — персонаж стоит; на двух — ещё сцена
  assert.strictEqual(run([0, 1, 2].map((i) => ev(`m1e5p${i}`, 'loop_a', three))).vscenes.length, 0);
  assert.strictEqual(run([0, 1].map((i) => ev(`m1e5p${i}`, 'loop_a', three))).vscenes.length, 2);
  // Ролик, который включило общее событие, — не «свой»: сцены нет; само общее событие — сцена
  const ces = [null, { id: 1, name: 'Ролик', list: [prep('loop_b'), c(231, [5, '', 0, 0, 0, 0, 100, 100, 255, 0]), ...three.flatMap(line)] }];
  assert.strictEqual(run([{ id: 'm1e6p0', name: 'Вызов', where: 'Город', list: [c(117, [1]), ...three.flatMap(line)] }], ces).vscenes.length, 0);
  assert.deepStrictEqual(run([{ id: 'ce1', name: 'Ролик', where: '', list: ces[1].list }], ces).vscenes.map((x) => x.id), ['ce1']);

  // Источник только с роликами (PKD, без картинок и 231) — гость, но группы, клипы, «общие» картинки и петли те же, что без него
  const pkd = { id: 'ce9', name: 'Только ролик', where: '', vonly: true, list: [c(355, ['ShowVAnim(5,"loop_a",0,0,true)']), ...three.flatMap(line)] };
  const base = [{ id: 'ce2', name: 'Картинки', where: '', list: [c(231, [1, 'cg', 0, 0, 0, 0, 100, 100, 255, 0]), ...line('x'), c(231, [2, 'cg', 0, 0, 0, 0, 100, 100, 255, 0]), ...line('y')] }];
  const without = run(base);
  const withPkd = run([...base, pkd]);
  assert.deepStrictEqual(withPkd.vscenes.map((x) => [x.id, x.own]), [['ce9', ['movies/loop_a.webm']]]);
  const same = (r) => JSON.stringify([r.groups.map((g) => [g.id, g.title, g.names]), r.clips, [...r.uses], r.loops, [...r.shown], [...r.stills]]);
  assert.strictEqual(same(withPkd), same(without), 'группы, клипы и счёт картинок как без источника с одними роликами');
  assert.deepStrictEqual(without.vscenes, []);

  // videoScene сама: три реплики под своими роликами, чужой ролик и «не сцена» не считаются
  const vs = S.videoScene([{ k: 'vid', v: [{ f: 'movies/x.webm', own: true }, { f: 'movies/npc_idle.webm', own: true }] }, { k: 'say', l: ['1'] }, { k: 'say', l: ['2'] }, { k: 'vid', v: [{ f: 'movies/x.webm' }] }, { k: 'say', l: ['3'] }], (f) => !/npc/.test(f));
  assert.strictEqual(vs, null, 'после ухода «своего» ролика реплики не считаются: две');
  assert.deepStrictEqual(S.videoScene([{ k: 'vid', v: [{ f: 'movies/x.webm', own: true }] }, { k: 'say', l: ['1'] }, { k: 'say', l: ['2'] }, { k: 'say', l: ['3'] }], () => true).own, ['movies/x.webm']);
  // Игра со Spine: видео-сцена не проходит фильтр общих наборов и не получает box, поэтому шагов spine в ней нет
  const hero = 'img/spines/hero/hero.json';
  const spiny = { ...ev('m1e5p0', 'loop_a', three) };
  spiny.list = [c(355, ["CreateSAnim('h','hero',0,0)"]), c(355, ["SAnim('h').setAnimation('go', true)"]), ...spiny.list];
  const sa = S.analyze([spiny], [], (n) => (n === 'cg' ? 'cg' : null), () => false, names, movies, () => false, null, { ...opts, spine: { sets: [hero], sources: [] } });
  assert.strictEqual(sa.vscenes.length, 1);
  assert.ok(!sa.vscenes[0].script.some((x) => x.k === 'spine'), 'шагов spine в видео-сцене нет');
  assert.ok(sa.vscenes[0].script.some((x) => x.k === 'vid'), 'ролики на месте');
});

test('галерея: сцены-гости — одни ролики и реплики: гость альбома своего ролика, scene(n), копия из комнаты воспоминаний, сбой прохода и сборки сцен — альбомы те же', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-guests-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  await fsp.mkdir(path.join(game, 'movies'), { recursive: true });
  // Картинок в игре нет — только ролики-петли (у игры с роликами и без картинок сцены строятся тоже); папка img нужна, чтобы игру нашли
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  const clip = (name) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x64:d=1:r=10', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', path.join(game, 'movies', name)]);
  assert.strictEqual(clip('loopa.webm').status, 0);
  assert.strictEqual(clip('loopb.webm').status, 0);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const prep = (f, n) => [c(357, ['MoviePicture', 'PREPARE', '', { fileName: f, loop: 'true', volume: '100', autoplay: 'true' }]), c(231, [n, '', 0, 0, 0, 0, 100, 100, 255, 0])];
  const mk = (withLines) => {
    const L = (...xs) => (withLines ? xs.flatMap(line) : []);
    return [null,
      // Сцена А показывает оба ролика (альбом петель — по первому событию, где они встретились)
      { id: 1, name: 'Сцена А', list: [...prep('loopa', 4), ...L('a1', 'a2', 'a3'), c(235, [4]), ...prep('loopb', 5), ...L('a4', 'a5', 'a6'), c(0)] },
      // Сцена Б — только второй ролик
      { id: 2, name: 'Сцена Б', list: [...prep('loopb', 4), ...L('b1', 'b2', 'b3'), c(0)] },
      // Копия Б в комнате воспоминаний: вопрос перед теми же репликами, имя событие «EV003» — название у оригинала
      { id: 3, name: 'EV003', list: [...L('Посмотреть сцену?'), ...prep('loopb', 4), ...L('b1', 'b2', 'b3'), c(0)] }];
  };
  const write = async (withLines) => fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify(mk(withLines)));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const build = async () => {
    svc.forget('G');
    const q = t.mock.method(console, 'log', () => {});
    try { return await svc.runBuild('G', { done: 0, total: 0 }); } finally { q.mock.restore(); }
  };
  const shape = (ix) => JSON.stringify([ix.albums.map((a) => [a.key, a.kind, a.files, a.cover]), ix.counts]);

  // Без реплик гостей нет: это и есть основа для сравнения альбомов
  await write(false);
  const bare = await build();
  assert.ok(!bare.albums.some((a) => a.script || a.scenes));
  await write(true);
  const index = await build();
  assert.strictEqual(shape(index), shape(bare), 'альбомы, файлы, обложки и счёт — как без реплик');
  const host = index.albums.filter((a) => a.scenes);
  assert.strictEqual(host.length, 1, JSON.stringify(index.albums.map((a) => [a.key, a.script, a.scenes])));
  assert.ok(!index.albums.some((a) => a.kind === 'dialogue'), 'сцена из роликов — гость альбома, а не диалог');
  const a = host[0];
  assert.strictEqual(a.script, true);
  assert.ok(a.files.length >= 2 && a.files.every((f) => /loop[ab]/.test(f)), JSON.stringify(a.files));
  // Копия «EV003» слилась с оригиналом «Сцена Б»; порядок — как в игре; ролики сцены — номера файлов альбома
  assert.deepStrictEqual(a.scenes.map((x) => x.t), ['Сцена А', 'Сцена Б']);
  // Сводка у каждого гостя: реплики с текстом (шесть и три), ролик; картинок у сцен из одних роликов нет
  assert.deepStrictEqual(a.scenes.map((x) => x.sum), [{ l: 6, p: 0, f: 'a1', m: 1 }, { l: 3, p: 0, f: 'b1', m: 1 }]);
  const at = (rel) => a.files.findIndex((f) => f.includes(rel));
  assert.deepStrictEqual(a.scenes.map((x) => x.f), [[at('loopa'), at('loopb')], [at('loopb')]]);
  // scene(n): первая — по ключу, вторая — гость; чужие номера — нет сцены
  const s0 = await svc.scene('G', a.key);
  const s1 = await svc.scene('G', a.key, null, { n: 1 });
  assert.deepStrictEqual(s1.steps.filter((x) => x.k === 'say').map((x) => x.text), ['b1', 'b2', 'b3']);
  assert.deepStrictEqual(s0.steps.filter((x) => x.k === 'say').map((x) => x.text), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  const v1 = s1.steps.find((x) => x.k === 'vid' && x.v.length).v[0];
  assert.ok(/loopb/.test(v1.f) && v1.loop && !('own' in v1), JSON.stringify(v1));
  assert.deepStrictEqual(s1.screen, index.screen);
  for (const n of [2, -1, 0.5, NaN, '1']) assert.strictEqual(await svc.scene('G', a.key, null, { n }), null, `n=${n}`);
  assert.deepStrictEqual((await svc.scene('G', a.key, null, null)).steps, s0.steps, 'старый вызов — сцена 0');
  // Языки сцен читают и гостей: слова гостя в списке «что перевести»
  const wanted = await svc.wantedLines('G', index);
  assert.ok(wanted.msgs.has('b1') && wanted.msgs.has('a1'));
  // У альбома без гостей сцена только одна
  assert.strictEqual(await svc.scene('G', 'нет такого', null, { n: 0 }), null);

  // Проход раздачи с ошибкой: гостей нет, альбомы те же
  const orig = svc.buildSceneAlbums.bind(svc);
  svc.buildSceneAlbums = async (...x) => { const r = await orig(...x); r.vscenes = [{ id: 'x', at: 0, core: [], own: ['movies/loopa.webm'] }]; return r; };
  const warn = t.mock.method(console, 'warn', () => {});
  const broken = await build();
  assert.ok(warn.mock.calls.some((x) => /сцены-гости не собрались/.test(String(x.arguments[0]))));
  warn.mock.restore();
  assert.strictEqual(shape(broken), shape(index));
  assert.ok(!broken.albums.some((x) => x.scenes), 'гостей нет');
  // Сбой посреди раздачи, когда настоящие гости уже посчитаны: не раздаём никого, ни одна сцена не числится розданной
  svc.buildSceneAlbums = async (...x) => { const r = await orig(...x); r.vscenes = [...r.vscenes, { id: 'z', at: 99999, core: [], own: ['movies/loopa.webm'], script: [], get title() { throw new Error('сбой посреди раздачи'); } }]; return r; };
  const warn3 = t.mock.method(console, 'warn', () => {});
  const middle = await build();
  assert.ok(warn3.mock.calls.some((x) => /сцены-гости не собрались: сбой посреди раздачи/.test(String(x.arguments[0]))));
  warn3.mock.restore();
  assert.strictEqual(shape(middle), shape(index));
  assert.ok(!middle.albums.some((x) => x.scenes), 'гостей нет, хотя часть уже была посчитана');
  // Сборка сцен из событий упала целиком: оглавление пишется, гостей нет
  svc.buildSceneAlbums = async () => { throw new Error('сбой'); };
  const warn2 = t.mock.method(console, 'warn', () => {});
  const down = await build();
  warn2.mock.restore();
  assert.ok(down.albums.length && !down.albums.some((x) => x.scenes));
  assert.ok(fs.existsSync(svc.indexPath('G')));
});

test('галерея: сводка сцены в оглавлении — реплики с текстом, картинки, голос, выбор, ролик, анимация и двое говорящих больше всех', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-sum-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  await fsp.mkdir(path.join(root, 'G', 'movies'), { recursive: true });
  const albums = [{ key: 'events/00000/Полная', kind: 'cg', files: ['a.png', 'b.png', 'c.png'] }, { key: 'events/00001/Тихая', kind: 'cg', files: ['a.png'] }];
  const index = { builtAt: 9, albums, parts: [] };
  const say = (text, who = '') => ({ k: 'say', l: [text], ...(who ? { n: who } : {}) });
  const pending = new Map([
    // Три говорящих: Аня — три реплики, Боря — две, Вика — одна; пустое окно в счёт не идёт; a.png показана дважды — одна картинка
    ['events/00000/Полная', [{ k: 'pic', f: 'a.png' }, say('1', 'Аня'), say('2', 'Боря'), say('', 'Аня'), say('3', 'Аня'), { k: 'pic', f: 'b.png' }, say('4', 'Боря'), say('5', 'Вика'), say('6', 'Аня'),
      { k: 'pic', f: 'a.png' }, { k: 'choice', o: ['да', 'нет'], i: 0 }, { k: 'snd', kind: 'voice', f: 'v.ogg', vol: 90, pitch: 100, pan: 0 },
      { k: 'anim', f: ['b.png', 'c.png'], d: [4, 4], loop: true, r: 0 }]],
    // Одна реплика без имени, музыка без голоса: ни голоса, ни выбора, ни анимации
    ['events/00001/Тихая', [{ k: 'pic', f: 'a.png' }, { k: 'snd', kind: 'bgm', f: 'm.ogg', vol: 90, pitch: 100, pan: 0 }, say('Первая\nстрока ' + '😀'.repeat(100))]]]);
  await svc.writeScripts('G', path.join(root, 'G'), index, pending);
  // f — первая реплика с текстом (пустое окно перед ней не в счёт); у длинной — одной строкой и ровно 80 символов, эмодзи не рвутся
  assert.deepStrictEqual(albums[0].sum, { l: 6, p: 3, f: '1', w: ['Аня', 'Боря'], v: 1, c: 1, a: 1 });
  assert.deepStrictEqual(albums[1].sum, { l: 1, p: 1, f: 'Первая строка ' + '😀'.repeat(66) });
  assert.strictEqual(Array.from(albums[1].sum.f).length, 80);
});

test('галерея: запись сценариев-гостей — первая сцена по ключу, n-я по «ключ\\nn», сцена без картинки и ролика выпадает без дыры в номерах; альбом получает scenes', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-wguest-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  await fsp.mkdir(path.join(root, 'G', 'movies'), { recursive: true });
  const index = { builtAt: 9, albums: [{ key: 'scenes/ce1/А#loop', kind: 'animation', files: ['movies/a.webm', 'movies/b.webm'] }], parts: [] };
  const say = (s) => ({ k: 'say', l: [s] });
  const vid = (f) => ({ k: 'vid', v: [{ s: 'v1', f, loop: true, x: 0, y: 0 }] });
  const hosted = new Map([['scenes/ce1/А#loop', [
    { t: 'Первая', f: [0], steps: [vid('movies/a.webm'), say('one')] },
    { t: 'Пустая', f: [0], steps: [say('no video')] },
    { t: 'Вторая', f: [0, 1], steps: [vid('movies/b.webm'), say('two')] }]]]);
  await svc.writeScripts('G', path.join(root, 'G'), index, new Map(), { hosted });
  const read = async (key) => JSON.parse(await fsp.readFile(svc.scriptPath('G', index.scripts, key), 'utf8'));
  assert.deepStrictEqual(index.albums[0].scenes, [{ t: 'Первая', f: [0], sum: { l: 1, p: 0, f: 'one', m: 1 } }, { t: 'Вторая', f: [0, 1], sum: { l: 1, p: 0, f: 'two', m: 1 } }]);
  assert.strictEqual(index.albums[0].script, true);
  assert.deepStrictEqual((await read('scenes/ce1/А#loop')).videos, ['movies/a.webm']);
  assert.deepStrictEqual((await read('scenes/ce1/А#loop\n1')).videos, ['movies/b.webm']);
  assert.ok(!fs.existsSync(svc.scriptPath('G', index.scripts, 'scenes/ce1/А#loop\n2')), 'третьего файла нет');
  // Ошибка в сборке сценариев в runBuild не оставляет флагов: проверено в тесте сцен-гостей выше
});

test('галерея: сцены с анимацией (analyze.ascenes) — анимация и пять реплик; четыре реплики, боевая анимация без реплик, тестовая карта и текст без анимации — не сцены; у группы — g.ascene', () => {
  const S = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const names = ['pa_00', 'pa_01', 'pa_02', 'pa_03'];
  const anim = (...ls) => [c(356, ['PA_INIT 4 6 連番 2']), c(231, [2, 'pa_00', 0, 0, 0, 0, 100, 100, 255, 0]), c(356, ['PA_START_LOOP 2 1']), ...ls.flatMap(line), c(235, [2])];
  // Кадры — не CG и не слои (картинок для группы нет): событие — одни кадры анимации
  const run = (sources, kind = 'portrait') => S.analyze(sources, [], () => kind, () => false, names, [], () => false, null, {});
  const ev = (id, list, extra = {}) => ({ id, name: `Сцена ${id}`, where: 'Город', list, ...extra });

  const ok = run([ev('ce1', anim('а', 'б', 'в', 'г', 'д'))]);
  assert.deepStrictEqual(ok.ascenes.map((x) => [x.id, x.title, x.lines, x.core.length, x.named]), [['ce1', 'Сцена ce1', 5, 5, true]]);
  assert.ok(ok.ascenes[0].script.some((x) => x.k === 'anim') && !ok.groups.length, 'сценарий с анимацией, группы нет');
  assert.strictEqual(S.ASCENE_LINES, 5);
  // Название гостя: вопрос «Продолжить?» и карта с этажом — не названия, берётся первая содержательная реплика
  const say = (t) => ({ k: 'say', l: [t] });
  assert.strictEqual(S.guestTitle('Время до сюжета будет пропущено. Продолжить？', [say('Время до сюжета будет пропущено. Продолжить？'), say('Старый форт')]), 'Старый форт');
  assert.strictEqual(S.guestTitle('Old Fortress - B1', [say('Old Fortress - B1'), say('Hello there')]), 'Hello there');
  assert.strictEqual(S.guestTitle('Старый форт', [say('другое')]), 'Старый форт', 'нормальное название не трогаем');
  assert.strictEqual(S.guestTitle('Что дальше?', [say('Что дальше?')]), 'Что дальше?', 'нет замены — остаётся как было');
  // Четыре реплики, боевая анимация без реплик, тестовая карта, реплики без анимации — не сцены
  assert.deepStrictEqual(run([ev('ce1', anim('а', 'б', 'в', 'г'))]).ascenes, []);
  assert.deepStrictEqual(run([ev('ce1', anim())]).ascenes, []);
  assert.deepStrictEqual(run([ev('m1e1p0', anim('а', 'б', 'в', 'г', 'д'), { where: 'テスト' })]).ascenes, []);
  assert.deepStrictEqual(run([ev('ce1', ['а', 'б', 'в', 'г', 'д'].flatMap(line))]).ascenes, []);
  // Пустые окна не в счёт: «\M[…]» без текста плеер пропускает
  assert.deepStrictEqual(run([ev('ce1', anim('\\M[1]', '\\M[2]', 'в', 'г', 'д'))]).ascenes, []);
  // Есть группа (картинки — CG): сцену несёт она, ascenes пуст
  const grouped = run([ev('ce1', anim('а', 'б', 'в', 'г', 'д'))], 'cg');
  assert.deepStrictEqual(grouped.ascenes, []);
  assert.deepStrictEqual(grouped.groups.map((g) => [g.id, g.ascene && g.ascene.lines]), [['ce1', 5]]);
  // Сцена из роликов — не сцена с анимацией: её ведёт свой проход (vscenes)
  assert.strictEqual(S.animScene([{ k: 'vid', v: [] }, ...['а', 'б', 'в', 'г', 'д'].map((s) => ({ k: 'say', l: [s] }))]), null);
  assert.strictEqual(S.animScene([{ k: 'anim', items: [{}, {}], par: true }, ...['а', 'б', 'в', 'г', 'д'].map((s) => ({ k: 'say', l: [s] }))]), null, 'петли страниц — не анимация сцены');
});

test('галерея: сцены с анимацией и позднее событие — гости альбома: анимация без своей сцены, клип без картинок, копия один раз, позднее событие у альбома раннего, по имени не дублируется', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-ascene-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  await fsp.mkdir(path.join(game, 'js'), { recursive: true });
  await fsp.writeFile(path.join(game, 'js', 'plugins.js'), 'var $plugins = [{"name":"PictureAnimation","status":true,"description":"","parameters":{}}];\n');
  let uniq = 0;
  const png = (w = 816, h = 624, size = 200000) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.writeUInt32BE(++uniq, size - 4); return b; };
  const names = [...['pa', 'pb', 'pc', 'pd'].flatMap((p) => [0, 1, 2, 3].map((i) => `${p}_0${i}`)), 'cgA_1', 'cgA_2', 'cgA_3', 'cgB_1', 'cgB_2', 'cgB_3', 'cgC_1', 'cgC_2', 'cgC_3', 'byn_1', 'byn_2', 'byn_3'];
  // Кадры pa и pb — не на весь экран (не CG): у их событий нет группы, это события из одних кадров анимации
  for (const n of names) await fsp.writeFile(path.join(game, 'img', 'pictures', `${n}.png`), /^p[ab]_/.test(n) ? png(400, 600) : png());
  await fsp.writeFile(path.join(game, 'img', 'pictures', 'lay_base.png'), png());
  await fsp.writeFile(path.join(game, 'img', 'pictures', 'lay_cloth.png'), png(816, 624, 1000));
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  // Анимация листа PictureAnimation: кадры pa_00…pa_03 крутятся под репликами
  const anim = (p, ...ls) => [c(356, ['PA_INIT 4 6 連番 2']), show(2, `${p}_00`), c(356, ['PA_START_LOOP 2 1']), ...ls.flatMap(line), c(235, [2])];
  const still = (...pairs) => pairs.flatMap(([n, s]) => [show(1, n), ...line(s)]);
  const ces = [null,
    // 1 — клип из одних кадров с четырьмя репликами; 2 — две реплики; 3 — боевая анимация без реплик
    { id: 1, name: 'АнимА', list: [...anim('pa', 'a1', 'a2', 'a3', 'a4', 'a5'), c(0)] },
    { id: 2, name: 'Короткая', list: [...anim('pb', 'b1', 'b2', 'b3', 'b4'), c(0)] },
    { id: 3, name: 'Бой', list: [...anim('pd'), c(0)] },
    // 4 — копия первой в комнате воспоминаний (вопрос перед теми же репликами); 5 — продолжение на тех же кадрах
    { id: 4, name: 'Копия', list: [...line('Посмотреть сцену?'), ...anim('pa', 'a1', 'a2', 'a3', 'a4', 'a5'), c(0)] },
    { id: 5, name: 'Продолжение', list: [...anim('pa', 'c1', 'c2', 'c3', 'c4', 'c5'), c(0)] },
    // 6 и 7 — одни и те же картинки, у позднего свои реплики: картинки достаются раннему
    { id: 6, name: 'Ранняя', list: [...still(['cgA_1', 'e1'], ['cgA_2', 'e2'], ['cgA_3', 'e3']), ...line('e4'), ...line('e5'), c(0)] },
    // ровно десять реплик — вторая сцена; у раннего альбома своя сцена есть
    { id: 7, name: 'Поздняя', list: [...still(['cgA_1', 'l1'], ['cgA_2', 'l2'], ['cgA_3', 'l3']), ...['l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].flatMap(line), c(0)] },
    // 11 и 12: у раннего события картинки есть, реплик нет — своей сцены у альбома нет, и позднее с десятью репликами гостем
    // не становится (иначе оно было бы единственной «сценой» альбома под чужим названием)
    { id: 11, name: 'РанняяТихая', list: [show(1, 'cgB_1'), c(230, [20]), show(1, 'cgB_2'), c(230, [20]), show(1, 'cgB_3'), c(230, [20]), c(0)] },
    { id: 12, name: 'ОпоздавшаяТихая', list: [...still(['cgB_1', 'q1'], ['cgB_2', 'q2'], ['cgB_3', 'q3']), ...['q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'].flatMap(line), c(0)] },
    // 13 и 14: у раннего своя сцена, но в позднем девять реплик — на одну меньше предела, не вторая сцена
    { id: 13, name: 'РанняяС', list: [...still(['cgC_1', 'r1'], ['cgC_2', 'r2'], ['cgC_3', 'r3']), ...line('r4'), ...line('r5'), c(0)] },
    { id: 14, name: 'ОпоздавшаяКороткая', list: [...still(['cgC_1', 'w1'], ['cgC_2', 'w2'], ['cgC_3', 'w3']), ...['w4', 'w5', 'w6', 'w7', 'w8', 'w9'].flatMap(line), c(0)] },
    // 8 — картинки остаются в альбоме по имени, он и получает сценарий: гостем анимации сцена не становится
    { id: 8, name: 'ПоИмени', list: [...still(['byn_1', 'n1'], ['byn_2', 'n2'], ['byn_3', 'n3']), ...anim('pc', 'n4', 'n5', 'n6'), c(0)] },
    // 9 и 10 — у обоих одна и та же склейка (основа и прозрачный слой) и разные реплики: альбом из одной склейки — не повод
    // вешать на него второе событие, оно остаётся как было
    { id: 9, name: 'Склейка', list: [show(1, 'lay_base'), show(2, 'lay_cloth'), ...['s1', 's2', 's3', 's4', 's5'].flatMap(line), c(0)] },
    { id: 10, name: 'СклейкаДва', list: [show(1, 'lay_base'), show(2, 'lay_cloth'), ...['t1', 't2', 't3', 't4', 't5'].flatMap(line), c(0)] }];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify(ces));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const q = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  q.mock.restore();
  const by = (re) => index.albums.filter((a) => re.test(a.key));
  const says = async (key, n) => (await svc.scene('G', key, null, n === undefined ? null : { n })).steps.filter((x) => x.k === 'say').map((x) => x.text);

  // Клип из одних кадров + пять реплик: гость альбома анимации (картинок у события нет — своего сценария не было);
  // копия из комнаты воспоминаний слилась с оригиналом, продолжение на тех же кадрах — вторая сцена
  const [host] = by(/^scenes\/ce1\//);
  assert.ok(host && host.script && host.kind === 'animation', JSON.stringify(index.albums.map((a) => [a.key, a.script])));
  assert.deepStrictEqual(host.scenes.map((x) => [x.t, x.f, x.sum.l]), [['АнимА', [0, 1, 2, 3], 5], ['Продолжение', [0, 1, 2, 3], 5]]);
  assert.deepStrictEqual(await says(host.key), ['a1', 'a2', 'a3', 'a4', 'a5']);
  assert.deepStrictEqual(await says(host.key, 1), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.strictEqual(await svc.scene('G', host.key, null, { n: 2 }), null);
  // Четыре реплики и боевая анимация без реплик остаются просто анимациями
  assert.ok(by(/^scenes\/ce2\//).every((a) => !a.script && !a.scenes), 'четыре реплики — не сцена');
  assert.ok(!index.albums.some((a) => a.files.some((f) => /pd_0/.test(f)) && (a.script || a.scenes)), 'боевая анимация без реплик — без сцены');
  // Позднее событие — вторая сцена альбома раннего; у него своя сцена первая, на любом файле
  const early = by(/^events\/\d+\/Ранняя$/);
  assert.strictEqual(early.length, 1);
  assert.deepStrictEqual(early[0].scenes.map((x) => [x.t, x.f, x.sum.l]), [['Ранняя', [0, 1, 2], 5], ['Поздняя', [0, 1, 2], 10]]);
  assert.deepStrictEqual(await says(early[0].key), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepStrictEqual(await says(early[0].key, 1), ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10']);
  assert.ok(!index.albums.some((a) => a.kind === 'dialogue') && !by(/Поздняя/).length, 'позднее событие — гость, а не диалог и не потерянное');
  // Девять реплик или альбом-хозяин без своей сцены — не гость: ни сцены у хозяина, ни нового альбома
  const withC = by(/^events\/\d+\/РанняяС/);
  assert.ok(withC.length === 1 && withC[0].script && !withC[0].scenes, JSON.stringify(withC.map((a) => [a.key, a.scenes])));
  assert.ok(!index.albums.some((a) => a.scenes && a.scenes.some((x) => /Опоздавшая/.test(x.t))), 'девять реплик или хозяин без сцены — не гость');
  assert.ok(by(/РанняяТихая/).every((a) => !a.script && !a.scenes), 'у тихого хозяина своей сцены нет');
  const lay = by(/^events\/\d+\/Склейка/);
  assert.ok(lay.length === 1 && lay[0].script && !lay[0].scenes, JSON.stringify(lay.map((a) => [a.key, a.files.length, a.scenes])));
  assert.ok(!by(/СклейкаДва/).length && !index.albums.some((a) => a.scenes && a.scenes.some((x) => x.t === 'СклейкаДва')), 'второе событие с той же склейкой — не гость');
  // Сценарий отдал альбому по имени — второй раз гостем анимации он не становится
  const byName = by(/^img\/pictures\/byn/);
  assert.ok(byName.length === 1 && byName[0].script && !byName[0].scenes, JSON.stringify(byName));
  assert.deepStrictEqual(await says(byName[0].key), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  assert.ok(by(/^scenes\/ce8\//).every((a) => !a.script && !a.scenes), 'по имени и гостем — дубль');
  // Языки и «что перевести» читают гостей с анимацией и позднего события
  const wanted = await svc.wantedLines('G', index);
  assert.ok(wanted.msgs.has('c1') && wanted.msgs.has('l1') && wanted.msgs.has('e1'));
});

test('галерея: пересборка заново греет игру, которую уже открывали, — склейки с новыми именами не склеиваются на лету', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-rewarm-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  await fsp.mkdir(path.join(game, 'img', 'pictures'), { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=816x624', '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', 'cg_1.png')]);
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), '[null]');
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const warmed = [];
  svc.prewarm = (id, index) => { warmed.push([id, index.albums.length]); };
  const quiet = t.mock.method(console, 'log', () => {});
  // Игру не открывали (прогрева не было) — сборка её не греет
  await svc.runBuild('G', { done: 0, total: 0 });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(warmed, []);
  // Открывали (прогрев сделан) — после пересборки греем снова, уже по новому оглавлению
  svc.warmed = new Set(['G']);
  await svc.runBuild('G', { done: 0, total: 0 });
  await new Promise((r) => setImmediate(r));
  quiet.mock.restore();
  assert.deepStrictEqual(warmed.map((x) => x[0]), ['G']);
  assert.ok(warmed[0][1] >= 1, 'прогрев получил новое оглавление');
  assert.ok(!svc.warmed.has('G'), 'метка прогрева сброшена: прогрев (настоящий) поставит её сам');
});

test('галерея: сцены TS_ADVsystem — макросы сценария в команды RPG Maker (toCommands)', () => {
  const adv = require('./src/services/galleryAdv.js');
  const screen = { w: 1024, h: 768 };
  const codes = (l) => l.map((c) => `${c.code}:${JSON.stringify(c.parameters)}`);
  const full = { ev01: [1024, 768], ev01a: [1024, 768] };
  const size = (n) => (full[n] ? { w: full[n][0], h: full[n][1] } : null);
  // Реплика с голосом и строкой «\n», рассказ с \CL, звук, вспышка, тряска, стоны BGV (буфер BGS и 50 кадров), пауза,
  // CG и «стереть», затемнение парой; стоячие портреты, комментарии, метки и всё после @end — ничего
  const text = ['@bgm f=h_001', '@bgf bg=ev01 t=300', '[Dragon:/scv0001]  Hmm.\\nSecond row', ' \\CL Narration', '@se f=raftsu1 pitch=60',
    '@flash col=215,126,171,150 t=1000 wt=0', '@qk wt=0', '@bgv f=Handwork', '@bgv', '@wait t=500', '@ev f=ev01a', '@ev', '@bs', '@bs f=Est@Normal',
    '@move f=Run x=1', ';c', '*label', '@fade type=out t=500', '[Lan] dark', '@fade type=in t=500 wt=0', '@end', 'after end'].join('\n');
  assert.deepStrictEqual(codes(adv.toCommands(text, screen, size)), [
    '241:[{"name":"h_001","volume":90,"pitch":100,"pan":0}]',
    '224:[[255,255,255,255],18,false]',
    '231:[15,"ev01",0,0,0,0,100,100,255,0]',
    '355:["AudioManager.playVoice({\\"name\\":\\"scv0001\\",\\"volume\\":90,\\"pitch\\":100,\\"pan\\":0})"]',
    '101:["",0,0,2,"Dragon"]', '401:["Hmm."]', '401:["Second row"]',
    '101:["",0,0,2,""]', '401:["Narration"]',
    '250:[{"name":"raftsu1","volume":90,"pitch":60,"pan":0}]',
    '224:[[215,126,171,150],60,false]',
    '225:[5,5,9,false]',
    '245:[{"name":"Handwork","volume":90,"pitch":100,"pan":0}]', '230:[50]',
    '246:[1]',
    '230:[30]',
    '231:[15,"ev01a",0,0,0,0,100,100,255,0]',
    '235:[15]',
    '355:["$gameScreen.startFadeOut(30)"]', '230:[30]',
    '101:["",0,0,2,"Lan"]', '401:["dark"]',
    '355:["$gameScreen.startFadeIn(30)"]',
  ]);
  // Картинки: размер известен — левым верхним углом (CG на весь экран — целая), неизвестен — серединой (origin 1);
  // вариант «_v»; «@bs» стирает всё, кроме врезки 75; лист-анимация с выключенной анимацией — CG без «a_»
  const sizes = { ev01: [1024, 768], ev12: [1024, 764], cut: [400, 300], ev05: [1024, 768], ev07: [1024, 768] };
  const size2 = (n) => (sizes[n] ? { w: sizes[n][0], h: sizes[n][1] } : null);
  const exists = (n) => !!sizes[n] || n === 'x_v';
  assert.deepStrictEqual(codes(adv.toCommands(['@ev f=ev12', '@ev f=cut x=-100', '@ev f=nosuch', '@ev f=x v=1', '@ev2 f=ev07', '@bs', '@ev2',
    '@ev_anime f=a_ev05 sx=4 sy=1', '@ev_anime f=a_zz sx=4 sy=1', '@ev del=1 f=ev0', '@bg f=ev01', '@ev f=x'].join('\n'), screen, size2, exists)), [
    '231:[15,"ev12",0,0,0,2,100,100,255,0]',
    '231:[15,"cut",0,0,212,234,100,100,255,0]',
    '231:[15,"nosuch",1,0,512,384,100,100,255,0]',
    '231:[15,"x_v",1,0,512,384,100,100,255,0]',
    '231:[75,"ev07",0,0,0,0,100,100,255,0]',
    '235:[15]',
    '235:[75]',
    '231:[15,"ev05",0,0,0,0,100,100,255,0]',
    '235:[15]',
    '231:[1,"ev01",0,0,0,0,100,100,255,0]',
    '231:[15,"x",1,0,512,384,100,100,255,0]',
  ]);
  // Макросы, которые плагин разворачивает сам (macroChange): @fin и @rps_ex
  assert.deepStrictEqual(codes(adv.toCommands('@ev f=ev01\n@fin bg=ev05 se=pon\n@rps_ex', screen, size2, exists)), [
    '231:[15,"ev01",0,0,0,0,100,100,255,0]',
    '246:[1]', '224:[[255,255,255,255],18,true]', '224:[[255,255,255,255],18,true]', '224:[[255,255,255,255],60,false]',
    '231:[15,"ev05",0,0,0,0,100,100,255,0]', '250:[{"name":"pon","volume":90,"pitch":100,"pan":0}]',
    '355:["$gameScreen.startFadeOut(60)"]', '230:[60]', '246:[1]', '242:[1]', '235:[15]', '230:[60]', '355:["$gameScreen.startFadeIn(60)"]', '230:[60]',
  ]);
});

test('галерея: сцены TS_ADVsystem — файл читается по содержимому, ссылки AdvLoad, id с расширением, файл сценария не делает CG события общей', async (t) => {
  const adv = require('./src/services/galleryAdv.js');
  const scenes = require('./src/services/galleryScenes.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-adv-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'js'));
  // Папка с большой буквы — тоже она
  await fsp.mkdir(path.join(root, 'Scenario'));
  const plug = (on, decode) => fsp.writeFile(path.join(root, 'js', 'plugins.js'),
    `var $plugins =\n${JSON.stringify([{ name: 'TS_ADVsystem', status: on, parameters: {} }, { name: 'TS_Decode', status: true, parameters: { Decode: decode, Key: '255' } }])};\n`);
  // Шифр — по знаку UTF-16: эмодзи (два знака) переживает его целым
  const text = '@ev f=ev01\n[Нэми:/v1] 日本語 😀 text\n';
  await fsp.writeFile(path.join(root, 'Scenario', 'rp01.sl'), adv.xor(text, 255), 'utf8');
  await fsp.writeFile(path.join(root, 'Scenario', 'plain.txt'), text, 'utf8');
  await fsp.writeFile(path.join(root, 'Scenario', 'both.txt'), '@ev f=from_txt\n', 'utf8');
  await fsp.writeFile(path.join(root, 'Scenario', 'both.sl'), adv.xor('@ev f=from_sl\n', 255), 'utf8');
  await fsp.writeFile(path.join(root, 'Scenario', 'junk.txt'), 'just text\nno macros\n', 'utf8');
  await plug(true, 'true');
  let cfg = await adv.config(root);
  assert.strictEqual((await cfg.read('RP01')).text, text, 'зашифрованный .sl при Decode: true; имя без учёта регистра');
  assert.strictEqual((await cfg.read('plain')).text, text, 'обычный .txt при Decode: true (Clockwork Vale) — как есть');
  assert.deepStrictEqual(await cfg.read('both'), { file: 'both.txt', text: '@ev f=from_txt\n' }, '.txt раньше .sl, как в rpg-fixes');
  assert.strictEqual(await cfg.read('junk'), null, 'ни одной строки-макроса ни так, ни после шифра — не сценарий');
  assert.strictEqual(await cfg.read('missing'), null);
  await plug(true, 'false');
  cfg = await adv.config(root);
  assert.strictEqual((await cfg.read('rp01')).text, text, 'Decode: false, а файл зашифрован — читается');
  await plug(false, 'true');
  assert.strictEqual(await adv.config(root), null, 'плагин выключен — ничего не читаем');
  // Ссылки: только «AdvLoad имя»; одна строка-макрос, имя из переменной и другие команды плагина — не сцена
  const refs = adv.refs([{ code: 356, parameters: ['AdvLoad rp01'] }, { code: 356, parameters: ['AdvLoad macro @se f=a'] }, { code: 356, parameters: ['AdvLoad \\V[3]'] },
    { code: 356, parameters: ['AutMessageLoad x'] }, null], 'Комната', true, 'm1e1p0');
  assert.deepStrictEqual(refs, [{ file: 'rp01', where: 'Комната', map: true, id: 'm1e1p0' }]);
  // Файлы rp07 и rp15 с анимацией: id кончается расширением — «p07»/«p15» не принимаются за страницы события «adv:r»
  const screen = { w: 1024, h: 768 };
  const full = () => ({ w: 1024, h: 768 });
  const scen = (p) => [`@ev f=${p}`, '[A] start', ...[1, 2, 3].flatMap(() => [`@ev f=${p}a`, '@wait t=100', `@ev f=${p}b`, '@wait t=100', `@ev f=${p}c`, '@wait t=100']), '[A] end', `@ev f=${p}d`, '[A] after'].join('\n');
  const names = ['ev07', 'ev15'].flatMap((p) => ['', 'a', 'b', 'c', 'd'].map((s) => p + s));
  const two = [['rp07.txt', 'ev07'], ['rp15.sl', 'ev15']].map(([f, p]) => ({ id: `${adv.ADV_ID}${f}`, name: '', where: '', adv: true, list: adv.toCommands(scen(p), screen, full) }));
  const an = scenes.analyze(two, [], () => 'cg', () => false, names, [], () => false, null);
  assert.strictEqual(an.clips.length, 2);
  assert.strictEqual(new Set(an.clips.map((c) => c.id.replace(/p\d+$/, ''))).size, 2, 'две анимации — два альбома');
  // Событие показывает ev07, четыре файла сценария — ev07 и ev07a: ev07 не становится «общей» (CG_REUSE) из-за файлов
  const show = (n, name) => ({ code: 231, indent: 0, parameters: [n, name, 0, 0, 0, 0, 100, 100, 255, 0] });
  const ev = { id: 'm1e1p0', name: 'EV', where: 'Map', list: [show(1, 'ev07'), show(2, 'ev15'), { code: 0, indent: 0, parameters: [] }] };
  const many = [1, 2, 3, 4].map((i) => ({ id: `adv:f${i}.txt`, name: '', where: '', adv: true, list: adv.toCommands('@ev f=ev07\n[A] x\n@ev f=ev07a\n[A] y', screen, full) }));
  const u = scenes.analyze([ev, ...many], [], () => 'cg', () => false, names, [], () => false, null);
  assert.deepStrictEqual([u.uses.get('ev07'), u.uses.get('ev07a')], [1, 4]);
  // Без файлов сценария — тот же счёт, что был
  assert.deepStrictEqual([...scenes.analyze([ev], [], () => 'cg', () => false, names, [], () => false, null).uses], [['ev07', 1], ['ev15', 1]]);
});

// Игра с TS_ADVsystem для тестов сборки: сценарий rp01.sl (XOR 255) зовут общее событие, карта и тестовая карта;
// img/F_pictures — копия img/pictures байт в байт. shown — какие CG показывает сценарий; lines — свой текст сценария
async function advGame(root, { on = true, folder = true, shown = ['ev01', 'ev01a'], lines = null, extra = [] } = {}) {
  const game = path.join(root, 'G');
  await fsp.rm(game, { recursive: true, force: true });
  for (const d of ['data', 'js', 'img/pictures', 'img/F_pictures', 'audio/voice', 'audio/bgm']) await fsp.mkdir(path.join(game, d), { recursive: true });
  let uniq = 0;
  const png = (w, h, size) => { const b = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.write('IDAT', 37, 'latin1'); b.writeUInt32BE(++uniq, size - 4); return b; };
  for (const n of ['ev01', 'ev01a', 'ev01b']) {
    const b = png(816, 624, 200000);
    await fsp.writeFile(path.join(game, 'img/pictures', `${n}.png`), b);
    await fsp.writeFile(path.join(game, 'img/F_pictures', `${n}.png`), b);
  }
  for (const n of extra) await fsp.writeFile(path.join(game, 'img/pictures', `${n}.png`), png(816, 624, 200000));
  await fsp.writeFile(path.join(game, 'audio/voice/scv0001.ogg'), Buffer.alloc(2000, 1));
  await fsp.writeFile(path.join(game, 'audio/bgm/h_001.ogg'), Buffer.alloc(2000, 2));
  await fsp.writeFile(path.join(game, 'js/plugins.js'), `var $plugins =\n${JSON.stringify([{ name: 'TS_ADVsystem', status: on, parameters: {} }, { name: 'TS_Decode', status: true, parameters: { Decode: 'true', Key: '255' } }])};\n`);
  await fsp.writeFile(path.join(game, 'data/System.json'), JSON.stringify({ gameTitle: 'Fake', advanced: { screenWidth: 816, screenHeight: 624 } }));
  const call = { code: 356, indent: 0, parameters: ['AdvLoad rp01'] };
  const end = { code: 0, indent: 0, parameters: [] };
  await fsp.writeFile(path.join(game, 'data/CommonEvents.json'), JSON.stringify([null, { id: 1, name: '◇RP01', list: [call, end] }]));
  await fsp.writeFile(path.join(game, 'data/MapInfos.json'), JSON.stringify([null, { id: 1, name: 'Room' }, { id: 2, name: 'TEST room' }]));
  const map = JSON.stringify({ events: [null, { id: 1, name: 'EV001', pages: [{ list: [call, end] }] }] });
  await fsp.writeFile(path.join(game, 'data/Map001.json'), map);
  await fsp.writeFile(path.join(game, 'data/Map002.json'), map);
  await fsp.writeFile(path.join(game, 'data/Troops.json'), '[null]');
  if (folder) {
    await fsp.mkdir(path.join(game, 'scenario'));
    const text = lines || ['@bgm f=h_001', `@bgf bg=${shown[0]} t=300`, '[Dragon:/scv0001]  Hmm.\\nSecond row', 'Narration one',
      ...shown.slice(1).flatMap((n, i) => [`@ev f=${n}`, `[Lan] Hyah ${i}`]), '[Lan] more', '@fade type=out t=500', 'In the dark', '@fade type=in t=500', '@end'];
    await fsp.writeFile(path.join(game, 'scenario', 'rp01.sl'), require('./src/services/galleryAdv.js').xor(text.join('\n'), 255), 'utf8');
  }
  return game;
}

test('галерея: сцены TS_ADVsystem — альбом сцены со сценарием, папка-копия уходит; без плагина и без папки — как раньше', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-adv-build-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const build = async (opts) => {
    await advGame(root, opts);
    await fsp.rm(path.join(root, '_media'), { recursive: true, force: true });
    const svc = new GalleryService();
    svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
    const quiet = t.mock.method(console, 'log', () => {});
    try { return { svc, index: await svc.runBuild('G', { done: 0, total: 0 }) }; } finally { quiet.mock.restore(); }
  };
  const shape = (ix) => ix.albums.map((a) => ({ key: a.key, kind: a.kind, files: a.files, script: !!a.script }));
  // Сценарий показывает 2 CG из 3: третья — его же (одна сцена, R12), копии из img/F_pictures — только в parts. Без
  // правила папки-копии ev01b осталась бы в «img/F_pictures/ev»: CG 5 и два повтора
  const { svc, index } = await build();
  assert.deepStrictEqual(shape(index), [{ key: 'events/00000/Hmm.', kind: 'cg', files: ['img/pictures/ev01.png', 'img/pictures/ev01a.png', 'img/pictures/ev01b.png'], script: true }]);
  assert.strictEqual(index.counts.cg, 3);
  for (const n of ['ev01', 'ev01a', 'ev01b']) assert.ok(index.parts.includes(`img/F_pictures/${n}.png`), n);
  const scene = await svc.scene('G', 'events/00000/Hmm.');
  const brief = scene.steps.slice(0, 7).map((x) => (x.k === 'snd' ? `snd ${x.kind} ${x.f}` : x.k === 'fx' ? `fx ${x.t} ${x.n}` : x.k === 'pic' ? `pic ${x.i}` : x.k === 'say' ? `say ${x.who}|${x.text}` : x.k));
  assert.deepStrictEqual(brief, ['snd bgm audio/bgm/h_001.ogg', 'fx flash 18', 'snd voice audio/voice/scv0001.ogg', 'pic 0', 'say Dragon|Hmm.\nSecond row', 'say |Narration one', 'pic 1']);
  // Затемнение парой — шаги fx fade, реплика под ним есть
  assert.deepStrictEqual(scene.steps.filter((x) => x.k === 'fx' && x.t === 'fade').map((x) => x.o), [1, 0]);
  assert.ok(scene.steps.some((x) => x.k === 'say' && x.text === 'In the dark'));
  // Плагин выключен или папки нет — ничего нового: копия — по имени, как раньше
  const before = [{ key: 'img/F_pictures/ev', kind: 'cg', files: ['img/F_pictures/ev01.png', 'img/F_pictures/ev01a.png', 'img/F_pictures/ev01b.png'], script: false }];
  for (const opts of [{ on: false }, { folder: false }]) {
    const { index: plain } = await build(opts);
    assert.deepStrictEqual(shape(plain), before, JSON.stringify(opts));
    for (const n of ['ev01', 'ev01a', 'ev01b']) assert.ok(plain.parts.includes(`img/pictures/${n}.png`));
  }
});

test('галерея: сцены TS_ADVsystem — файл с выбором (@select) не забирает альбом по имени целиком; папка-копия без сцен и частичная копия — как раньше', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const adv = require('./src/services/galleryAdv.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-adv-rules-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const build = async (opts, more = async () => {}) => {
    const game = await advGame(root, opts);
    await more(game);
    await fsp.rm(path.join(root, '_media'), { recursive: true, force: true });
    const svc = new GalleryService();
    svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
    const quiet = t.mock.method(console, 'log', () => {});
    try { return await svc.runBuild('G', { done: 0, total: 0 }); } finally { quiet.mock.restore(); }
  };
  const shape = (ix) => ix.albums.filter((a) => a.kind === 'cg').map((a) => [a.key, a.files.map((f) => path.basename(f, '.png')), !!a.script]);
  // R12: линейный файл (реплик не меньше картинок) — одна сцена: и одиночки room/beach, и альбом по имени h01 — ей
  const scene = ['@bgf bg=room', '[A] one', '@ev f=beach', '[A] two', '@ev f=h01_1', '[A] three', '@ev f=h01_2', '[A] four', '@ev f=h01_3', '[A] five', '[A] six'];
  const linear = await build({ lines: scene, extra: ['room', 'beach', 'h01_1', 'h01_2', 'h01_3'] });
  assert.deepStrictEqual(shape(linear).filter(([k]) => !k.includes('F_pictures')), [['events/00000/one', ['room', 'beach', 'h01_1', 'h01_2', 'h01_3'], true]]);
  // Тот же файл с меню выбора — не linear: обычный фильтр, альбом по имени h01 остаётся сам по себе
  const branchy = await build({ lines: [...scene.slice(0, 2), '@select s1=a s2=b', ...scene.slice(2)], extra: ['room', 'beach', 'h01_1', 'h01_2', 'h01_3'] });
  assert.deepStrictEqual(shape(branchy).filter(([k]) => !k.includes('F_pictures')).map(([k, f]) => [k, f]), [['events/00000/one', ['room', 'beach']], ['img/pictures/h01', ['h01_1', 'h01_2', 'h01_3']]]);
  assert.strictEqual((await adv.sources(path.join(root, 'G'), [{ file: 'rp01', where: '', map: false, id: 'ce1' }], { w: 816, h: 624 }, () => null, () => true, /test/i))[0].linear, false);
  // Папки-копии, которых не показывает ни одна сцена: как раньше — копия по порядку имён, вторая — в parts
  const none = await build({ folder: false }, async (game) => {
    for (const d of ['x', 'y']) await fsp.mkdir(path.join(game, 'img/pictures', d));
    for (const n of ['b1', 'b2']) {
      const b = await fsp.readFile(path.join(game, 'img/pictures/ev01.png'));
      b.writeUInt32BE(1000 + Number(n[1]), b.length - 4);
      await fsp.writeFile(path.join(game, 'img/pictures/x', `${n}.png`), b);
      await fsp.writeFile(path.join(game, 'img/pictures/y', `${n}.png`), b);
    }
  });
  assert.deepStrictEqual(none.albums.filter((a) => /\/[xy]\//.test(a.files[0])).map((a) => a.files.map((f) => f.split('/').slice(-2).join('/'))), [['x/b1.png', 'x/b2.png']]);
  assert.ok(none.parts.includes('img/pictures/y/b1.png') && none.parts.includes('img/pictures/y/b2.png'));
  // Частичная копия: кадр анимации anim/a_01 лежит ещё и в scene/ и его показывает сцена — анимация из 30 кадров цела
  const part = await build({ lines: ['@bgf bg=ev01', '[A] one', '@ev f=scene/a_01', '[A] two', '@ev f=ev01a', '[A] three', '[A] four'] }, async (game) => {
    for (const d of ['anim', 'scene']) await fsp.mkdir(path.join(game, 'img/pictures', d));
    const b = await fsp.readFile(path.join(game, 'img/pictures/ev01.png'));
    for (let i = 1; i <= 30; i++) { const f = Buffer.from(b); f.writeUInt32BE(5000 + i, f.length - 4); await fsp.writeFile(path.join(game, 'img/pictures/anim', `a_${String(i).padStart(2, '0')}.png`), f); }
    await fsp.copyFile(path.join(game, 'img/pictures/anim/a_01.png'), path.join(game, 'img/pictures/scene/a_01.png'));
  });
  const anim = part.albums.find((a) => a.files.some((f) => f.includes('/anim/')));
  assert.strictEqual(anim?.files.length, 30, JSON.stringify(shape(part)));
});

test('галерея: параллельные страницы, которые включает сцена — по переменной (старшая из выполненных), «один раз», счётчик в 99 кадров, звук петли и ожидание движения; кадры сцены те же', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const wait = (n) => c(230, [n]);
  const line = (s) => [c(101, ['', 0, 0, 2, '']), c(401, [s])];
  const setVar = (v, x) => c(122, [v, v, 0, 0, x]);
  const sw = (s, on) => c(121, [s, s, on ? 0 : 1]);
  const move = (n, op, d, w) => c(232, [n, 0, 0, 0, 0, 0, 100, 100, op, 0, d, w]);
  const se = (name) => c(250, [{ name, volume: 90, pitch: 100, pan: 0 }]);
  const ctxOf = (names, kinds = {}) => ({ names, has: (n) => names.includes(n), movies: [], audio: (k, n) => ({ rel: `audio/${k}/${n}.ogg` }), kind: (n) => kinds[n] || (names.includes(n) ? 'cg' : null) });
  const varC = (id, v) => ({ variableValid: true, variableId: id, variableValue: v });
  const pn = (pics) => pics.map((p) => `${p.n}:${p.name}${p.par ? '*' : ''}`).join(' ');

  // Страница карты по переменной (Clockwork Vale 2: врезка и петля над ней): идёт самая старшая страница из выполненных.
  // Кадры сцены от неё не меняются; под репликами — снимки «врезка + кадр петли», у каждой страницы — клип; в сценарии петля
  // одним шагом anim, а когда сцена кладёт свою картинку на тот же номер, экран — её
  const layers = ['l1', 'l2', 'l3', 'm1', 'm2', 'm3'];
  const ctx = ctxOf(['inset', ...layers, 'end'], Object.fromEntries(layers.map((n) => [n, 'layer'])));
  const loop = (a) => [show(2, `${a}1`), wait(7), show(2, `${a}2`), wait(7), show(2, `${a}3`), wait(7)];
  const pars = { ce: [], maps: new Map([[1, [{ id: 2, pages: [{ c: varC(36, 1), list: loop('l') }, { c: varC(36, 2), list: loop('m') }], ids: ['v36'] }]]]), battle: null };
  const list = [show(1, 'inset'), c(235, [2]), setVar(36, 1), ...line('a'), setVar(36, 2), ...line('b'), setVar(36, 0), show(2, 'end'), ...line('c')];
  const env = { pars, map: 1, ev: 1, self: 'm1e1p0' };
  const a = runList(list, [], ctx);
  const b = runList(list, [], ctx, env);
  assert.deepStrictEqual(b.frames, a.frames, 'кадры сцены — как без страниц');
  assert.deepStrictEqual(runList(list, [], ctx), a, 'без env разбор не меняется');
  assert.deepStrictEqual(b.frames.map((f) => (b.parOf.get(f) || { o: [] }).o.map(pn)), [['1:inset 2:l1*', '1:inset 2:m1*'], []], 'две реплики над одной картинкой — один кадр альбома, снимков у него два');
  assert.deepStrictEqual(b.parClips.map((x) => x.length), [3, 3]);
  assert.deepStrictEqual(b.scenario.filter((x) => x.k === 'anim').map((x) => [x.loop, x.par, x.cells.length, x.d]), [[true, true, 3, [7, 7, 7]], [true, true, 3, [7, 7, 7]]]);
  assert.strictEqual(pn(b.scenario.filter((x) => x.k === 'pics').pop().pics), '1:inset 2:end', 'сцена положила свою картинку на номер страницы — экран её');

  // Перенос на другую карту (201 прямо): идут страницы той карты, а не прежней
  const other = { pars: { ce: [], maps: new Map([[2, [{ id: 5, pages: [{ c: varC(36, 1), list: loop('l') }], ids: ['v36'] }]]]), battle: null }, map: 1, ev: 1, self: 'm1e1p0' };
  const moved = [show(1, 'inset'), setVar(36, 1), ...line('a'), c(201, [0, 2, 0, 0, 0, 0]), ...line('b')];
  assert.strictEqual((runList(moved, [], ctx, other).parClips || []).length, 1, 'страница новой карты идёт');
  assert.strictEqual(runList(moved.filter((x) => x.code !== 201), [], ctx, other).parClips, undefined, 'без переноса — нет');

  // Общее событие «один раз» (выключает свой переключатель, Tidewater Quest): шаг без круга, потом стоит последний кадр; сцена снова
  // включает — снова один раз; стёрла номер — картинка уходит
  const bg = ctxOf(['bg', 'a1', 'a2', 'a3']);
  const once = [show(3, 'a1'), wait(3), show(3, 'a2'), wait(3), show(3, 'a3'), sw(5, false), wait(3)];
  const ces = [null, null, null, { id: 3, trigger: 2, switchId: 5, list: once }];
  const r1 = runList([show(1, 'bg'), sw(5, true), wait(160), ...line('x'), sw(5, true), ...line('y'), c(235, [3]), ...line('z')], ces, bg, { pars: { ce: [{ id: 3, sw: 5, list: once }], maps: new Map(), battle: null }, self: 'ce1' });
  assert.deepStrictEqual(r1.scenario.filter((x) => x.k === 'anim' || x.k === 'pics').map((x) => (x.k === 'anim' ? `anim ${x.loop} ${x.cells.length} ${pn(x.cells[x.cells.length - 1])}` : `pics ${pn(x.pics)}`)),
    ['anim false 3 1:bg 3:a3*', 'anim false 3 1:bg 3:a3*', 'pics 1:bg']);

  // Широкий диапазон («включить переключатели 1–9999») включает страницу так же, как один переключатель
  const wide = runList([show(1, 'bg'), c(121, [1, 9999, 0]), wait(160), ...line('x'), ...line('y')], ces, bg, { pars: { ce: [{ id: 3, sw: 5, list: once }], maps: new Map(), battle: null }, self: 'ce1' });
  assert.strictEqual((wide.parClips || []).length, 1);

  // Сцена гасит картинку, что осталась от выключенной страницы, — она уходит с экрана вместе с командой сцены
  const fade = runList([show(1, 'bg'), sw(5, true), wait(160), ...line('x'), move(3, 0, 10, true), ...line('y')], ces, bg, { pars: { ce: [{ id: 3, sw: 5, list: once }], maps: new Map(), battle: null }, self: 'ce1' });
  assert.strictEqual(fade.scenario.filter((x) => x.k === 'pics').pop().pics.find((p) => p.n === 3).op, 0);

  // Включают страницу и свой переключатель события (только у его же карты и события), и скрипт «$gameSwitches.setValue»
  const selfPage = { c: { selfSwitchValid: true, selfSwitchCh: 'A' }, list: loop('l') };
  const selfEv = { pars: { ce: [], maps: new Map([[1, [{ id: 1, pages: [{ c: null }, selfPage], ids: ['self'] }]]]), battle: null }, map: 1, ev: 1, self: 'm1e1p0' };
  const selfList = [show(1, 'inset'), c(123, ['A', 0]), ...line('a'), ...line('b')];
  assert.strictEqual((runList(selfList, [], ctx, selfEv).parClips || []).length, 1);
  assert.strictEqual(runList(selfList, [], ctx, { ...selfEv, ev: 9, self: 'm1e9p0' }).parClips, undefined, 'чужой личный переключатель страницу не включает');
  const viaScript = runList([show(1, 'inset'), c(355, ['$gameSwitches.setValue(5, true);']), ...line('a'), ...line('b')], ces, ctxOf(['inset', 'a1', 'a2', 'a3']), { pars: { ce: [{ id: 3, sw: 5, list: once }], maps: new Map(), battle: null }, self: 'ce1' });
  assert.strictEqual((viaScript.parClips || []).length, 1);

  // Счётчик кадров длиннее 64 (Ember & Frost: до 137): страница считает до конца и выключает себя — все кадры, один раз
  const names = ['bg', ...Array.from({ length: 99 }, (_, k) => `f/${k + 1}`)];
  const page = [c(355, ['$gameScreen.showPicture(2, "f/" + $gameVariables.value(9), 0, 0, 0, 100, 100, 255, 0);']), wait(5), c(122, [9, 9, 1, 0, 1]),
    c(111, [1, 9, 0, 100, 0]), sw(7, false), c(0, [], 1), c(412)];
  page[4].indent = 1;
  const r2 = runList([show(1, 'bg'), setVar(9, 1), sw(7, true), ...line('x')], [null, { id: 1, trigger: 2, switchId: 7, list: page }], ctxOf(names), { pars: { ce: [{ id: 1, sw: 7, list: page }], maps: new Map(), battle: null }, self: 'ce2' });
  const long = r2.scenario.find((x) => x.k === 'anim');
  assert.deepStrictEqual([long.loop, long.cells.length, pn(long.cells[98])], [false, 99, '1:bg 2:f/99*']);
  // Сцена меняет переменную, от которой зависит страница, — страница считается заново: теперь с 90-го кадра
  const r2b = runList([show(1, 'bg'), setVar(9, 1), sw(7, true), ...line('x'), setVar(9, 90), ...line('y')], [null, { id: 1, trigger: 2, switchId: 7, list: page }], ctxOf(names), { pars: { ce: [{ id: 1, sw: 7, list: page }], maps: new Map(), battle: null }, self: 'ce2' });
  assert.deepStrictEqual(r2b.scenario.filter((x) => x.k === 'anim').map((x) => x.cells.length), [99, 10]);

  // Звук каждого прохода и ожидание движения (TOD): кадр стоит и паузу, и «ждать завершения»; звук — от первого кадра
  const snd = [show(2, 'p1'), se('hit'), wait(10), show(2, 'p2'), move(2, 255, 6, true), wait(10)];
  const r3 = runList([show(1, 'bg'), sw(3, true), ...line('x')], [null, { id: 1, trigger: 2, switchId: 3, list: snd }], ctxOf(['bg', 'p1', 'p2']), { pars: { ce: [{ id: 1, sw: 3, list: snd }], maps: new Map(), battle: null }, self: 'ce9' });
  const loopStep = r3.scenario.find((x) => x.k === 'anim');
  assert.deepStrictEqual(loopStep.d, [10, 16]);
  assert.deepStrictEqual(loopStep.s, [[0, { f: 'audio/se/hit.ogg', vol: 90, pitch: 100, pan: 0 }]]);
});

test('галерея: параллельные страницы — что не анимация сцены (интерфейс, медленный таймер, движение, ветка по неизвестному, реплика, бой без плагина, включение в конце) не включается; картинка сцены — кадр петли или закрыта ею', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, indent = 0) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0], indent);
  const wait = (n) => c(230, [n]);
  const line = (s) => [c(101, ['', 0, 0, 2, '']), c(401, [s])];
  const sw = (s, on) => c(121, [s, s, on ? 0 : 1]);
  const move = (n, op, d, w) => c(232, [n, 0, 0, 0, 0, 0, 100, 100, op, 0, d, w]);
  const ctxOf = (names, kinds = {}) => ({ names, has: (n) => names.includes(n), movies: [], audio: () => null, kind: (n) => kinds[n] || (names.includes(n) ? 'cg' : null) });
  const pn = (pics) => pics.map((p) => `${p.n}:${p.name}${p.par ? '*' : ''}`).join(' ');

  const run = (page, list, opt = {}) => {
    const ctx = ctxOf(['bg', 'p1', 'p2', 'ui_gauge1', 'ui_gauge2'], { ui_gauge1: 'other', ui_gauge2: 'other' });
    const pars = { ce: [{ id: 1, sw: 3, list: page }], maps: new Map(), battle: opt.battle || null };
    const r = runList(list || [show(1, 'bg'), sw(3, true), ...line('x')], [null, { id: 1, trigger: 2, switchId: 3, list: page }], ctx, { pars, self: 'ce9', battle: !!opt.inBattle });
    return { parOf: r.parOf || null, clips: r.parClips || null, anim: r.scenario.some((x) => x.k === 'anim') };
  };
  const none = { parOf: null, clips: null, anim: false };
  const loop = [show(2, 'p1'), wait(5), show(2, 'p2'), wait(5)];
  assert.notDeepStrictEqual(run(loop), none, 'петля из двух картинок сцены — включается');
  assert.deepStrictEqual(run([show(2, 'ui_gauge1'), wait(5), show(2, 'ui_gauge2'), wait(5)]), none, 'интерфейс — не картинка сцены');
  assert.deepStrictEqual(run([show(2, 'p1'), wait(60), show(2, 'p2'), wait(60)]), none, 'кадр дольше PAR_WAIT — таймер, слайд-шоу');
  assert.deepStrictEqual(run([show(2, 'p1'), move(2, 0, 5, true), move(2, 255, 5, true)]), none, 'одна картинка, меняется только прозрачность');
  assert.deepStrictEqual(run([show(2, 'p1'), wait(5), c(111, [1, 50, 0, 1, 0]), show(2, 'p2', 1), c(0, [], 1), c(412), wait(5)]), none, 'ветка по тому, чего не знаем, с картинками: вторая картинка — как повезёт');
  assert.deepStrictEqual(run([show(2, 'p1'), ...line('page talks'), show(2, 'p2'), wait(5)]), none, 'страница с репликой');
  assert.deepStrictEqual(run(loop, null, { inBattle: true }), none, 'в бою общие события «параллельно» не идут без плагина');
  assert.notDeepStrictEqual(run(loop, null, { inBattle: true, battle: { all: false, ids: new Set([1]), mapOff: new Set() } }), none, 'а с плагином, где оно в списке, — идут');
  assert.deepStrictEqual(run(loop, null, { battle: { all: false, ids: new Set([1]), mapOff: new Set([1]) } }), none, 'плагин держит его только в бою — на карте не идёт');
  assert.deepStrictEqual(run(loop, [show(1, 'bg'), sw(3, true)]), none, 'включено в самом конце — экрана сцены с ним уже нет');

  // Картинка сцены — кадр петли (сцена сама показала первый кадр): снимок альбома — с ней, своего кадра из-за страницы не прибавляется;
  // петля закрыла картинку сцены — снимок и сам кадр сцены (plain)
  const ctx = ctxOf(['bg', 'p1', 'p2', 'x']);
  const page = [show(2, 'p1'), wait(5), show(2, 'p2'), wait(5)];
  const go = (list) => runList(list, [null, { id: 1, trigger: 2, switchId: 3, list: page }], ctx, { pars: { ce: [{ id: 1, sw: 3, list: page }], maps: new Map(), battle: null }, self: 'ce9' });
  assert.strictEqual(go([show(1, 'bg'), show(2, 'p1'), sw(3, true), ...line('x')]).parOf, undefined);
  const hidden = go([show(1, 'bg'), show(2, 'x'), sw(3, true), ...line('x')]);
  const p = hidden.parOf.get(hidden.frames[0]);
  assert.deepStrictEqual([p.o.map(pn), p.plain], [['1:bg 2:p1*'], true]);
});

test('галерея: параллельные страницы — анимация плагина и петля страницы на одном экране дают один шаг anim; analyze не меняет группы, клипы и счёт картинок, снимки — в shots, клип страницы — par', () => {
  const { runList, analyze } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const wait = (n) => c(230, [n]);
  const line = (s) => [c(101, ['', 0, 0, 2, '']), c(401, [s])];
  const sw = (s, on) => c(121, [s, s, on ? 0 : 1]);
  const ctxOf = (names, kinds = {}) => ({ names, has: (n) => names.includes(n), movies: [], audio: () => null, kind: (n) => kinds[n] || (names.includes(n) ? 'cg' : null) });

  // Лист PictureAnimation из 4 кадров и петля страницы из двух по 10 кадров игры: общий круг — 20 кадров, 4 ячейки
  const page = [show(2, 'p1'), wait(10), show(2, 'p2'), wait(10)];
  const ces = [null, { id: 1, trigger: 2, switchId: 3, list: page }];
  const mix = [c(356, ['PA_INIT 4 5 横']), show(1, 'sheet'), c(356, ['PA_START_LOOP 1']), sw(3, true), ...line('x')];
  const r = runList(mix, ces, ctxOf(['sheet', 'p1', 'p2'], { sheet: 'cg' }), { pars: { ce: [{ id: 1, sw: 3, list: page }], maps: new Map(), battle: null }, self: 'ce9' });
  const anims = r.scenario.filter((x) => x.k === 'anim');
  assert.strictEqual(anims.length, 1);
  assert.deepStrictEqual([anims[0].loop, anims[0].d.reduce((x, y) => x + y, 0), anims[0].cells.length, anims[0].par], [true, 20, 4, true]);

  // analyze: страница карты, включённая сценой, — группа и клипы своих сцен, uses/stills/shown как без неё
  const kinds = { inset: 'cg', end: 'cg', other1: 'cg', l1: 'layer', l2: 'layer', l3: 'layer' };
  const names = Object.keys(kinds);
  const cond = { variableValid: true, variableId: 36, variableValue: 1 };
  const loop = [show(2, 'l1'), wait(7), show(2, 'l2'), wait(7), show(2, 'l3'), wait(7)];
  const pars = { ce: [], maps: new Map([[1, [{ id: 2, pages: [{ c: cond, list: loop }], ids: ['v36'] }]]]), battle: null };
  const sources = [{ id: 'm1e1p0', map: 1, ev: 1, name: 'scene', where: 'Map', list: [show(1, 'inset'), c(122, [36, 36, 0, 0, 1]), ...line('a'), c(122, [36, 36, 0, 0, 0]), c(235, [2]), show(1, 'end'), ...line('b'), show(1, 'other1'), ...line('c')] }];
  const kind = (n) => kinds[n] || null;
  const a = analyze(sources, [], kind, () => false, names, [], () => false, null, {});
  const b = analyze(sources, [], kind, () => false, names, [], () => false, null, { pars });
  const strip = ({ shots, script, ...g }) => g;
  assert.deepStrictEqual(b.groups.map(strip), a.groups.map(strip));
  assert.deepStrictEqual([...b.uses], [...a.uses]);
  assert.deepStrictEqual([...b.stills], [...a.stills]);
  assert.deepStrictEqual([...b.shown], [...a.shown]);
  assert.deepStrictEqual(b.clips.filter((x) => !x.par), a.clips);
  assert.deepStrictEqual(b.groups[0].shots.map(([k, items, plain]) => [k, items.map((x) => x.layers.map((l) => l.name).join('+')), plain]), [[0, ['inset+l1'], false]]);
  assert.strictEqual(b.clips.filter((x) => x.par).length, 1, 'клип страницы поверх сцены — свой, с пометкой par');
  assert.ok(b.groups[0].script.some((x) => x.k === 'anim' && x.par), 'шаг со страницей помечен: сценарий по имени альбома его не считает показом');

  // Страница рисует на номере, где у сцены своя картинка: на кадре видна одна страница — это не врезка поверх сцены, снимка и клипа нет
  const kinds2 = { ...kinds, m1: 'cg', m2: 'cg', m3: 'cg' };
  const loop2 = [show(1, 'm1'), wait(7), show(1, 'm2'), wait(7), show(1, 'm3'), wait(7)];
  const pars2 = { ce: [], maps: new Map([[1, [{ id: 2, pages: [{ c: cond, list: loop2 }], ids: ['v36'] }]]]), battle: null };
  const src2 = [{ ...sources[0], list: [show(1, 'inset'), c(122, [36, 36, 0, 0, 1]), ...line('a'), c(122, [36, 36, 0, 0, 0]), show(1, 'end'), ...line('b'), show(1, 'other1'), ...line('c')] }];
  const d = analyze(src2, [], (n) => kinds2[n] || null, () => false, [...names, 'm1', 'm2', 'm3'], [], () => false, null, { pars: pars2 });
  assert.deepStrictEqual([d.clips.filter((x) => x.par).length, d.groups[0].shots], [0, undefined]);
});

test('галерея: параллельные страницы и ветки-варианты — перенос (201) в чужой ветке не сбивает карту и страницы остальной сцены; перенос по переменным гасит страницу прежней карты', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, indent = 0) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0], indent);
  const wait = (n) => c(230, [n]);
  const line = (s) => [c(101, ['', 0, 0, 2, '']), c(401, [s])];
  const setVar = (v, x) => c(122, [v, v, 0, 0, x]);
  const ctx = { names: ['inset', 'l1', 'l2', 'l3', 'alt'], has: () => true, movies: [], audio: () => null, kind: (n) => (/^l/.test(n) ? 'layer' : 'cg') };
  const loop = [show(2, 'l1'), wait(7), show(2, 'l2'), wait(7), show(2, 'l3'), wait(7)];
  const pars = { ce: [], maps: new Map([[1, [{ id: 2, pages: [{ c: { variableValid: true, variableId: 36, variableValue: 1 }, list: loop }], ids: ['v36'] }]]]), battle: null };
  const env = { pars, map: 1, ev: 1, self: 'm1e1p0' };
  const choice = (inB) => [show(1, 'inset'), c(102, [['A', 'B']]), c(402, [0, 'A']), show(3, 'alt', 1), c(0, [], 1), c(402, [1, 'B']), show(3, 'alt', 1), ...inB.map((x) => ({ ...x, indent: 1 })), c(0, [], 1), c(404), setVar(36, 1), ...line('a'), ...line('b')];
  const plain = runList(choice([]), [], ctx, env);
  const moved = runList(choice([c(201, [0, 2, 0, 0, 0, 0])]), [], ctx, env);
  assert.strictEqual((plain.parClips || []).length, 1, 'страница главной карты идёт');
  assert.strictEqual((moved.parClips || []).length, 1, 'перенос в другой ветке карту сцены не меняет');
  assert.strictEqual(runList(choice([c(201, [1, 5, 6, 7, 0, 0])]), [], ctx, env).parClips.length, 1, 'перенос по переменным в чужой ветке — тоже');

  // Перенос по переменным в самой сцене: карту не знаем — петля прежней карты под следующим кадром уже не идёт
  const away = (to) => [show(1, 'inset'), setVar(36, 1), ...line('a'), ...(to ? [c(201, [1, 5, 6, 7, 0, 0])] : []), show(1, 'alt'), ...line('b')];
  const steps = (r) => r.scenario.filter((x) => x.k === 'anim' || x.k === 'pics' || x.k === 'say').map((x) => x.k).join();
  assert.strictEqual(steps(runList(away(false), [], ctx, env)), 'anim,say,anim,say', 'без переноса петля идёт и под новой картинкой');
  assert.strictEqual(steps(runList(away(true), [], ctx, env)), 'anim,say,pics,say', 'после ухода по переменным петля прежней карты стоит');
});

test('галерея: параллельные страницы и ExternMessage — переключатели из «:event[n]» в песочнице страницу не включают и места на сцену не тратят; обычное включение после них работает', () => {
  const { expandList } = require('./src/services/galleryExtern.js');
  const { runList } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], extra = {}) => ({ code, indent: 0, parameters, ...extra });
  const names = ['cg2', 'scene_cg1', 'loopa', 'loopb'];
  const kinds = { cg2: 'cg', scene_cg1: 'cg', loopa: 'layer', loopb: 'layer' };
  const ctx = { names, has: (n) => names.includes(n), movies: [], kind: (n) => kinds[String(n).toLowerCase()] || null, audio: (k, n) => (k === 'voice' && n === 'moan' ? { rel: 'audio/voice/moan.ogg', voice: true } : null) };
  const ces = [];
  ces[30] = { id: 30, trigger: 2, switchId: 50, list: [c(231, [5, 'loopA', 0, 0, 0, 0, 100, 100, 255, 0]), c(230, [10]), c(231, [5, 'loopB', 0, 0, 0, 0, 100, 100, 255, 0]), c(230, [10])] };
  // Событие из CSV включает и выключает переключатель страницы 31 раз — дважды: больше PAR_MAX, если считать эти включения
  ces[40] = { id: 40, list: [...Array.from({ length: 31 }, () => [c(121, [50, 50, 0]), c(121, [50, 50, 1])]).flat(), c(356, ['SV_PLAY_VOICE moan'])] };
  const pars = { ce: [{ id: 30, sw: 50, list: ces[30].list }], maps: new Map(), battle: null };
  const em = { get: (k) => ({ a: ':name[Anna,Actor1]\n:event[40]\nhello\n:event[40]\nagain' })[k], lineMax: 4, nameTag: true, mv: true };
  const list = [c(231, [1, 'cg2', 0, 0, 0, 0, 100, 100, 255, 0]), c(101, ['', 0, 0, 2]), c(401, [' \\M[a]']), c(230, [30]), c(121, [50, 50, 0]), c(230, [40]),
    c(231, [1, 'scene_cg1', 0, 0, 0, 0, 100, 100, 255, 0]), c(101, ['', 0, 0, 2]), c(401, ['end'])];
  const env = { pars, map: 1, ev: 1, self: 'm1e1p0', battle: false };
  const J = (x) => JSON.stringify(x, (k, v) => (v instanceof Map ? [...v] : v));
  const sum = (r) => ({ frames: r.frames.map((f) => `${f.pics.map((p) => p.name).join('+')} w${f.wait}`).join(' | '), parOf: J(r.parOf || null), clips: (r.parClips || []).length, voice: r.scenario.filter((x) => x.k === 'snd' && x.kind === 'voice').length });
  const raw = sum(runList(list, ces, ctx, env));
  const exp = sum(runList(expandList(list, em, {}), ces.map((x) => (x ? { ...x, list: expandList(x.list, em, {}) } : x)), ctx, env));
  assert.ok(raw.clips === 1 && raw.parOf !== 'null', 'страница после выключателя сцены идёт');
  assert.deepStrictEqual({ ...exp, voice: 0 }, { ...raw, voice: 0 }, 'кадры, снимки и клипы — как без разворота');
  assert.strictEqual(exp.voice, 2, 'голос из песочницы — в сценарии, дважды');
});

test('галерея: параллельные страницы в сборке — снимок «врезка + кадр петли» в альбоме события, альбом «…#par», шаг anim с файлами в сценарии', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-par-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  const pics = path.join(game, 'img', 'pictures');
  await fsp.mkdir(pics, { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  const ff = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  // Врезка — плотный шум на весь экран (CG); кадры петли — фигура на прозрачном холсте во весь экран (слои)
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=816x624', '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(pics, 'inset.png')]);
  for (const [k, x] of [['l1', 100], ['l2', 300], ['l3', 500]]) ff(['-f', 'lavfi', '-i', 'color=c=blue:s=200x300', '-vf', `noise=alls=60:allf=t,format=rgba,pad=816:624:${x}:200:color=black@0`, '-frames:v', '1', path.join(pics, `${k}.png`)]);
  ff(['-f', 'lavfi', '-i', 'color=c=green:s=816x624', '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(pics, 'after.png')]);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const say = (s) => [c(101, ['', 0, 0, 2, '']), c(401, [s])];
  const cond = (o) => ({ actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0, ...o });
  const scene = [show(1, 'inset'), c(122, [7, 7, 0, 0, 1]), ...say('one'), ...say('two'), c(122, [7, 7, 0, 0, 0]), c(235, [2]), show(1, 'after'), ...say('three'), c(0)];
  const loop = [show(2, 'l1'), c(230, [7]), show(2, 'l2'), c(230, [7]), show(2, 'l3'), c(230, [7]), c(0)];
  const ev = (id, name, page) => ({ id, name, x: 0, y: 0, pages: [page] });
  const map = { events: [null, ev(1, 'Сцена', { conditions: cond({}), trigger: 3, list: scene }), ev(2, 'Петля', { conditions: cond({ variableValid: true, variableId: 7, variableValue: 1 }), trigger: 4, list: loop })] };
  await fsp.writeFile(path.join(game, 'data', 'Map001.json'), JSON.stringify(map));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), JSON.stringify([null, { id: 1, name: 'Дом' }]));
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const frames = JSON.parse(await fsp.readFile(svc.scenesPath('G'), 'utf8'));
  const names = (f) => (f.startsWith('@cg/') ? frames[f.slice(4)].map((l) => l.name).join('+') : path.basename(f, '.png'));
  const byKey = (re) => index.albums.find((a) => re.test(a.key));
  // Альбом события: кадр под репликами — врезка с кадром петли над ней (снимок), потом кадр самой сцены
  const evAlbum = byKey(/^events\//);
  assert.ok(evAlbum, JSON.stringify(index.albums.map((a) => a.key)));
  assert.deepStrictEqual(evAlbum.files.map(names), ['inset+l1', 'after']);
  // Клип страницы поверх сцены — свой альбом, файлы из других альбомов он не забирает
  const par = byKey(/^scenes\/m1e1\/.*#par$/);
  assert.ok(par && par.kind === 'animation' && par.files.length === 3, JSON.stringify(par));
  assert.deepStrictEqual(par.files.map(names), ['inset+l1', 'inset+l2', 'inset+l3']);
  const own = byKey(/^img\/pictures\/l$/);
  assert.deepStrictEqual(own && own.files.map(names), ['l1', 'l2', 'l3'], 'слои страницы остаются в своём альбоме, как без сцены');
  // Сценарий: картинка, потом анимация по кадрам из files (их можно читать), паузы — кадры игры
  const data = JSON.parse(await fsp.readFile(svc.scriptPath('G', index.scripts, evAlbum.key), 'utf8'));
  const anim = data.steps.find((x) => x.k === 'anim');
  assert.ok(anim, JSON.stringify(data.steps));
  assert.deepStrictEqual([anim.f.map((i) => names(data.files[i])), anim.d, anim.loop], [['inset+l1', 'inset+l2', 'inset+l3'], [7, 7, 7], true]);
  assert.strictEqual(anim.par, undefined, 'метка par — внутренняя, в файл не идёт');
  assert.deepStrictEqual(data.steps[data.steps.indexOf(anim) - 1], { k: 'pic', i: anim.f[0] });
  const readable = new Set([...index.albums.flatMap((a) => a.files), ...(index.parts || [])]);
  for (const i of anim.f) assert.ok(readable.has(data.files[i]), data.files[i]);
  const img = await svc.image('G', data.files[anim.f[1]]);
  assert.strictEqual(img.type, 'image/webp');
  const served = await svc.scene('G', evAlbum.key);
  assert.ok(served.steps.some((x) => x.k === 'anim' && x.f.length === 3 && !('par' in x)));
  // Пересборка: ключи альбомов те же (по ним хранятся избранное и «просмотрено»), «#par» не совпадает с обычным альбомом
  const keys = (ix) => ix.albums.map((x) => x.key).sort();
  const again = await svc.runBuild('G', { done: 0, total: 0 });
  assert.deepStrictEqual(keys(again), keys(index), 'ключи при пересборке те же');
  assert.ok(index.albums.filter((x) => /#par$/.test(x.key)).every((x) => !index.albums.some((y) => y !== x && y.key === x.key)));
});

test('галерея: параллельные страницы — картинки страницы, что одни на экране сцены, сцена «от себя» не показывает: альбом страницы по имени она не занимает', () => {
  const { analyze, shownItems } = require('./src/services/galleryScenes.js');
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name) => c(231, [n, name, 0, 0, 0, 0, 100, 100, 255, 0]);
  const line = (s) => [c(101, ['', 0, 0, 2, '']), c(401, [s])];
  const names = ['inset', 'end', 'm1', 'm2', 'm3'];
  const loop = [show(2, 'm1'), c(230, [7]), show(2, 'm2'), c(230, [7]), show(2, 'm3'), c(230, [7])];
  const pars = { ce: [], maps: new Map([[1, [{ id: 2, pages: [{ c: { variableValid: true, variableId: 36, variableValue: 1 }, list: loop }], ids: ['v36'] }]]]), battle: null };
  // Сцена показывает свою картинку, стирает её и включает страницу: на экране — только кадры страницы (сплошные CG, целые файлы)
  const sources = [{ id: 'm1e1p0', map: 1, ev: 1, name: 'scene', where: 'Map', list: [show(1, 'inset'), ...line('a'), c(235, [1]), c(122, [36, 36, 0, 0, 1]), ...line('b'), c(122, [36, 36, 0, 0, 0]), c(235, [2]), show(1, 'end'), ...line('c')] }];
  const { groups } = analyze(sources, [], (n) => (names.includes(n) ? 'cg' : null), () => false, names, [], () => false, null, { pars });
  const script = groups[0].script;
  const step = script.find((x) => x.k === 'anim');
  assert.ok(step && step.par && step.items.every((it) => /^m\d$/.test(it.name)), JSON.stringify(step));
  assert.deepStrictEqual(script.flatMap(shownItems).map((it) => it.name), ['inset', 'end'], 'показывает сама сцена; кадры страницы — нет');
  assert.deepStrictEqual(shownItems({ k: 'anim', items: [{ name: 'x' }] }), [{ name: 'x' }], 'анимация без страницы — показ, как раньше');
});

test('rpg-fixes: сценарии TS_ADVsystem расшифровываются по содержимому — обычный .txt при «Decode: true» не портится; без плагина патч не ставится', () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, 'public', 'rpg-fixes.js'), 'utf8');
  const start = src.indexOf('    var aggressiveAdvPatch = setInterval(function() {');
  const end = src.indexOf('    setTimeout(function() { clearInterval(aggressiveAdvPatch); }, 15000);');
  assert.ok(start > 0 && end > start, 'блок TS_ADVsystem');
  const block = src.slice(start, end);
  const xor = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += String.fromCharCode(s.charCodeAt(i) ^ 255); return o; };
  // Заглушки браузера: сервер отдаёт served[url], остальное — 404; интервал срабатывает сразу
  const run = (served, params, ADV_System = function ADV() {}) => {
    const asked = [];
    const logs = [];
    const ctx = { ADV_System, console: { log: (m) => logs.push(m), error() {} }, PluginManager: { parameters: () => params },
      setInterval: (fn) => { fn(); return 1; }, clearInterval() {},
      XMLHttpRequest: function XHR() { let url; this.open = (m, u) => { url = u; asked.push(u); }; this.overrideMimeType = () => {}; this.send = () => { this.status = served[url] !== undefined ? 200 : 404; this.responseText = served[url] || ''; }; } };
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    return { load: (n) => ADV_System.prototype.fileLoad(n), asked, logs };
  };
  const text = '@ev f=ev01\n[A:/v1] 日本語 😀\n';
  // Clockwork Vale: «Decode: true», файл — обычный .txt
  assert.strictEqual(run({ 'scenario/rp01.txt': text }, { Decode: 'true', Key: '255' }).load('rp01'), text);
  // Tidecaller: .txt нет (404), .sl зашифрован
  const sf = run({ 'scenario/rp01.sl': xor(text) }, { Decode: 'true', Key: '255' });
  assert.strictEqual(sf.load('rp01'), text);
  assert.deepStrictEqual(sf.asked, ['scenario/rp01.txt', 'scenario/rp01.sl']);
  // Параметр «false», а файл зашифрован — тоже читается; текст без макросов — как был (не шифр и не сценарий)
  assert.strictEqual(run({ 'scenario/rp01.sl': xor(text) }, { Decode: 'false' }).load('rp01'), text);
  assert.strictEqual(run({ 'scenario/x.txt': 'no macros here' }, { Decode: 'true' }).load('x'), 'no macros here');
  // Зашифрованный .sl без строк «@» (реплики Tidecaller) при Decode: true — расшифровывается; обычный японский текст — нет
  assert.strictEqual(run({ 'scenario/m.sl': xor('[Student:]  Hm? Is this right?\nline two') }, { Decode: 'true', Key: '255' }).load('m'), '[Student:]  Hm? Is this right?\nline two');
  assert.strictEqual(run({ 'scenario/j.txt': '日本語のテキスト\n二行目' }, { Decode: 'true' }).load('j'), '日本語のテキスト\n二行目');
  assert.strictEqual(run({ 'scenario/k.sl': xor('日本語のテキスト\n二行目') }, { Decode: 'true', Key: '255' }).load('k'), '日本語のテキスト\n二行目');
  // Пустой файл и 404 — пустая строка
  assert.strictEqual(run({ 'scenario/e.sl': '' }, { Decode: 'true' }).load('e'), '');
  assert.strictEqual(run({}, { Decode: 'true' }).load('nope'), '');
  // Игра без TS_ADVsystem: заглушка rpg-fixes «ADV_System = null» — патч не ставится и ничего не бросает
  let none;
  assert.doesNotThrow(() => { none = run({}, {}, null); });
  assert.deepStrictEqual(none.logs, []);
});

test('rpg-fixes: сейв (момент, слот, перемотка) подменяет объекты игры только в своей пустой сцене, не под живой Scene_Map', async () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, 'public', 'rpg-fixes.js'), 'utf8');
  const start = src.indexOf('    function inLoadScene(run) {');
  const end = src.indexOf('    // Игру открыли сразу на моменте или сейве (?mark=, ?slot=)');
  assert.ok(start > 0 && end > start, 'функция inLoadScene');
  // Движок в миниатюре: goto только ставит следующую сцену, смена и start() — на следующем «кадре»
  const make = () => {
    function Scene_Base() {}
    Scene_Base.prototype.start = function () { this.started = true; };
    function Scene_Map() {}
    Scene_Map.prototype = Object.create(Scene_Base.prototype);
    function Scene_Title() {}
    Scene_Title.prototype = Object.create(Scene_Base.prototype);
    const SceneManager = { _scene: new Scene_Map(), _next: null, goto(C) { this._next = C; }, tick() { if (this._next) { const C = this._next; this._next = null; this._scene = new C(); this._scene.start(); } } };
    const ctx = { Scene_Base, Scene_Map, Scene_Title, SceneManager, Promise };
    vm.createContext(ctx);
    vm.runInContext(src.slice(start, end) + '\nthis.inLoadScene = inLoadScene;', ctx);
    return ctx;
  };
  // Подмена идёт в следующем кадре и не в Scene_Map; обещание — после неё
  const ok = make();
  const seen = [];
  const done = ok.inLoadScene(() => { seen.push(ok.SceneManager._scene.constructor === ok.Scene_Map ? 'map' : 'own'); });
  assert.deepStrictEqual(seen, [], 'под живой картой ничего не меняем');
  ok.SceneManager.tick();
  await done;
  assert.deepStrictEqual(seen, ['own']);
  assert.ok(ok.SceneManager._scene instanceof ok.Scene_Base && !(ok.SceneManager._scene instanceof ok.Scene_Map));
  // Не вышло (в том числе обещанием, как MZ) — первый экран игры, а не пустая сцена; ошибка доходит
  for (const fail of [() => { throw new Error('x'); }, () => Promise.reject(new Error('x'))]) {
    const bad = make();
    const p = bad.inLoadScene(fail);
    bad.SceneManager.tick();
    await assert.rejects(p, /x/);
    assert.strictEqual(bad.SceneManager._next, bad.Scene_Title);
  }
  // Все три входа идут через неё
  assert.match(src, /function applySave\(json, atEdge = false\) \{[\s\S]*?return inLoadScene\(/);
  assert.match(src, /inLoadScene\(async \(\) => \{[\s\S]*?DataManager\.loadGame\(/);
  assert.match(src, /await applySave\(json, m\.edge\)/);
});

test('rpg-fixes: ошибка игры попадает в журнал, даже если плагин заменил catchException после нас (YEP Core)', () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, 'public', 'rpg-fixes.js'), 'utf8');
  const start = src.indexOf('        function trapHook(obj, name, before) {');
  const end = src.indexOf('        const hook = setInterval(() => {', start);
  assert.ok(start > 0 && end > start, 'функция trapHook');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.trapHook = trapHook;', ctx);
  const calls = [];
  const SM = { catchException(e) { calls.push('engine:' + e); } };
  const reported = [];
  ctx.trapHook(SM, 'catchException', (e) => reported.push(e));
  // Плагин сохранил прежнюю и зовёт её из своей; второй плагин заменил целиком — как YEP Core
  const prev = SM.catchException;
  SM.catchException = function (e) { calls.push('plugin:' + e); prev.call(this, e); };
  SM.catchException('a');
  assert.deepStrictEqual(reported, ['a'], 'в журнал — один раз');
  assert.deepStrictEqual(calls, ['plugin:a', 'engine:a'], 'цепочка плагина цела, без зацикливания');
  SM.catchException = function (e) { calls.push('yep:' + e); };
  calls.length = 0;
  SM.catchException('b');
  assert.deepStrictEqual(reported, ['a', 'b']);
  assert.deepStrictEqual(calls, ['yep:b']);
});

// --- Spine в сценах (шаги spine): PictureSpine и PKD Spine2DPlayer ---
const spineHelpers = () => {
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const say = (t, indent = 0) => [c(101, ['', 0, 0, 2, ''], indent), c(401, [t], indent)];
  const sets = ['img/spines/piston03/piston03.json', 'img/pSpineAssets/chapter1_scene1/chapter1_scene1.json', 'img/pSpineAssets/reina_trap/reina_trap.json'];
  const ctx = { names: ['cg1'], has: (n) => n === 'cg1', movies: [], audio: null, spines: sets };
  const sp = (r) => r.scenario.filter((x) => x.k === 'spine');
  const strip = (sc) => sc.filter((x) => x.k !== 'spine');
  const brief = (r) => r.scenario.map((x) => (x.k === 'say' ? x.l[0] : x.k === 'spine' ? (x.off ? 'off' : x.a.join('+')) : x.k));
  return { c, say, sets, ctx, sp, strip, brief };
};

test('галерея: Spine в сценах — runList: PictureSpine на картинке, потерянная переменная, ветки, очередь и бюджет; кадры и сценарий без Spine те же', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const { c, say, ctx, sp, strip, brief } = spineHelpers();
  const ctx0 = { ...ctx, spines: null };
  const same = (list, ces = []) => {
    const r = runList(list, ces, ctx);
    const o = runList(list, ces, ctx0);
    assert.deepStrictEqual(r.frames, o.frames, 'кадры альбомов от Spine не зависят');
    assert.deepStrictEqual(r.mentions, o.mentions);
    assert.deepStrictEqual(strip(r.scenario), o.scenario, 'сценарий без шагов spine прежний');
    return r;
  };
  // PictureSpine: номер картинки — переменная; цепочка в двух строках 355 + 655; список анимаций в очереди
  let r = same([c(231, [1, 'cg1', 0, 0, 0, 0, 100, 100, 255, 0]), c(122, [146, 146, 0, 0, 64]),
    c(355, ['$gameScreen.showPicture($gameVariables.value(146),"",0,500,30,60,60,255,0)']),
    c(355, ["$gameScreen.spine($gameVariables.value(146)).setSkeleton('piston03')"]), c(655, [".setAnimation(0, 'insert', 'none').setSkin('human');"]), ...say('a'),
    c(355, ["$gameScreen.spine($gameVariables.value(146)).setAnimation(0, ['ejaculation','election'], 'continue', false)"]), ...say('b'),
    c(355, ['$gameScreen.erasePicture($gameVariables.value(146))']), ...say('c')]);
  const base = { k: 'spine', id: 'p64', s: 'img/spines/piston03/piston03.json', q: true, skin: ['human'], at: [500, 30, 0.6, 0.6] };
  assert.deepStrictEqual(sp(r), [{ ...base, a: ['insert'], loop: false, t: 1 }, { ...base, a: ['ejaculation', 'election'], loop: true, t: 2 }, { k: 'spine', id: 'p64', off: true }]);
  // Номер потерян (общее событие, что зовёт само себя, переменные стёрло): то же выражение — тот же слой, стирание тоже
  r = same([c(231, [1, 'cg1', 0, 0, 0, 0, 100, 100, 255, 0]), c(122, [146, 146, 0, 0, 64]),
    c(355, ['$gameScreen.showPicture($gameVariables.value(146),"",0,500,30,60,60,255,0)']),
    c(355, ["$gameScreen.spine($gameVariables.value(146)).setSkeleton('piston03').setAnimation(0,'piston01')"]), ...say('a'), c(117, [5]),
    c(355, ["$gameScreen.spine($gameVariables.value(146)).setAnimation(0,'piston01/timeScale=2')"]), ...say('b'),
    c(355, ['$gameScreen.erasePicture($gameVariables.value(146))']), ...say('c')], [null, null, null, null, null, { id: 5, list: [c(117, [5])] }]);
  assert.deepStrictEqual(sp(r).map((x) => [x.id, x.ats, !!x.off]), [['p64', undefined, false], ['p64', [2], false], ['p64', undefined, true]], 'слой найден по выражению, стирание его убрало');
  // Два живых слоя с разными выражениями, потом переменные потеряли: вызов с тем же выражением трогает свой слой, с чужим — ничего
  r = same([c(231, [1, 'cg1', 0, 0, 0, 0, 100, 100, 255, 0]), c(122, [1, 1, 0, 0, 64]), c(122, [2, 2, 0, 0, 65]),
    c(355, ['$gameScreen.showPicture($gameVariables.value(1),"",0,10,10,100,100,255,0)']), c(355, ['$gameScreen.showPicture($gameVariables.value(2),"",0,20,20,100,100,255,0)']),
    c(355, ["$gameScreen.spine($gameVariables.value(1)).setSkeleton('piston03').setAnimation(0,'a')"]), c(355, ["$gameScreen.spine($gameVariables.value(2)).setSkeleton('piston03').setAnimation(0,'b')"]), ...say('x'), c(117, [5]),
    c(355, ["$gameScreen.spine($gameVariables.value(3)).setAnimation(0,'zzz')"]), c(355, ["$gameScreen.spine($gameVariables.value(2)).setAnimation(0,'c')"]), ...say('y')], [null, null, null, null, null, { id: 5, list: [c(117, [5])] }]);
  assert.deepStrictEqual(sp(r).map((x) => [x.id, x.a[0]]), [['p64', 'a'], ['p65', 'b'], ['p65', 'c']]);

  // PKD Spine2DPlayer: set / add сразу друг за другом — один список; «убрать» и снова «поставить» подряд (без развилки) — слой не возвращается
  r = same([c(355, ['CreateSAnim("r","chapter1_scene1",0,0).setScale(1)']), c(355, ['SAnim("r").setPosition(960,540).setAnimation("step_1", true)']), ...say('a'),
    c(355, ['SAnim("r").setAnimation("step_4", false)']), c(355, ['SAnim("r").addAnimation("step_5", true)']), ...say('b'), c(355, ['RemoveSAnim("r")']), ...say('c')]);
  assert.deepStrictEqual(sp(r).map((x) => [x.a, x.loop, x.t, x.at, x.off]), [[['step_1'], true, 1, [960, 540, 1, 1], undefined], [['step_4', 'step_5'], true, 3, [960, 540, 1, 1], undefined], [undefined, undefined, undefined, undefined, true]]);
  assert.strictEqual(sp(r)[1].q, undefined, 'set + add подряд — не очередь');
  const lin = same([c(355, ['CreateSAnim("t","reina_trap",0,0)']), c(355, ['SAnim("t").setAnimation("idle", true)']), ...say('a'), c(355, ['RemoveSAnim("t")']), ...say('b'), c(355, ['SAnim("t").setAnimation("idle3", true)']), ...say('c')]);
  assert.deepStrictEqual(brief(lin), ['idle', 'a', 'off', 'b', 'c'], 'убрали на верхнем уровне — не возвращается');
  // Взаимоисключающие ветки с неизвестным условием: убрали в закрытой ветке — следующий вызов слоя его возвращает, лишний off уходит
  const trap = [c(355, ['CreateSAnim("t","reina_trap",0,0)']), c(355, ['SAnim("t").setAnimation("idle", true)']), ...say('start'), c(122, [31, 31, 0, 2, 1, 3]),
    c(111, [1, 31, 0, 1, 0]), ...say('ok', 1), c(355, ['RemoveSAnim("t")'], 1), c(0, [], 1), c(412),
    c(111, [1, 31, 0, 2, 0]), ...say('fail1', 1), c(355, ['SAnim("t").setAnimation("idle3", true)'], 1), ...say('fail2', 1), c(355, ['RemoveSAnim("t")'], 1), c(0, [], 1), c(412), ...say('end')];
  assert.deepStrictEqual(brief(same(trap)), ['idle', 'start', 'ok', 'fail1', 'idle3', 'fail2', 'off', 'end'], 'между «ok» и «fail1» off нет');
  // Картинка-носитель уходит из-под скелета: новая «Показать картинку» на тот же номер, «Стереть» (235) и «Стереть все» — слой убран
  const host = (end) => [c(231, [1, 'cg1', 0, 0, 0, 0, 100, 100, 255, 0]), c(231, [64, 'cg1', 0, 0, 5, 5, 100, 100, 255, 0]), c(355, ["$gameScreen.spine(64).setSkeleton('piston03').setAnimation(0,'go')"]), ...say('a'), ...end, ...say('b')];
  for (const end of [[c(231, [64, 'cg1', 0, 0, 5, 5, 100, 100, 255, 0])], [c(235, [64])], [c(355, ['$gameScreen.clearPictures()'])]]) {
    assert.deepStrictEqual(brief(same(host(end))).filter((x) => x !== 'pics'), ['go', 'a', 'off', 'b']);
  }
  // Одно имя у двух наборов — не гадаем, шагов нет
  assert.deepStrictEqual(sp(runList([c(355, ["CreateSAnim('k','x')"]), c(355, ["SAnim('k').setAnimation('go', true)"]), ...say('a')], [], { ...ctx, spines: ['img/a/x/x.json', 'img/b/x/x.json'] })), []);
  // Выбор по имени героя, которое игра пропустила бы: звук и реплики ветки из сценария уходят, а врезку (состояние экрана) не режем
  const named = runList([c(320, [1, 'Bob']), c(111, [4, 1, 1, 'Alice']), c(355, ["CreateSAnim('k','chapter1_scene1',0,0)"], 1), c(355, ["SAnim('k').setAnimation('go', true)"], 1), ...say('в ветке', 1), c(0, [], 1), c(412), ...say('потом')], [], ctx);
  assert.deepStrictEqual(brief(named).filter((x) => x !== 'pics'), ['go', 'потом']);
  // Набор, которого findSpines не нашёл, и обрыв строки: шагов нет, кадры целы
  r = same([c(231, [1, 'cg1', 0, 0, 0, 0, 100, 100, 255, 0]), c(355, ["$gameScreen.spine(64).setSkeleton('nope')"]), c(355, ["$gameScreen.spine(64).setSkeleton("]), ...say('a')]);
  assert.deepStrictEqual(sp(r), []);
  // Сбой в разборе Spine (ctx.spines бросает) выключает Spine только в этом событии
  const bad = { length: 1, filter() { throw new Error('boom'); } };
  const list = [c(231, [1, 'cg1', 0, 0, 0, 0, 100, 100, 255, 0]), c(355, ["$gameScreen.spine(64).setSkeleton('piston03').setAnimation(0,'a')"]), ...say('a')];
  const guarded = runList(list, [], { ...ctx, spines: bad });
  assert.deepStrictEqual(guarded.frames, runList(list, [], ctx0).frames);
  assert.deepStrictEqual(strip(guarded.scenario), runList(list, [], ctx0).scenario);
  // Бюджет: 1600 реплик, перед каждой смена анимации — все 1500 шагов сценария на месте, шагов spine не больше 300
  const long = [c(355, ['CreateSAnim("r","chapter1_scene1",0,0)'])];
  for (let i = 0; i < 1600; i++) long.push(c(355, [`SAnim("r").setAnimation("s${i % 3}", true)`]), ...say(`x${i}`));
  r = runList(long, [], ctx);
  assert.strictEqual(strip(r.scenario).length, runList(long.filter((x) => x.code !== 355), [], ctx0).scenario.length);
  assert.strictEqual(sp(r).length, 300);
  // Откат прохода цикла (проход без новых картинок) возвращает и счёт шагов spine, и «что записали в последний раз»:
  // в откаченном проходе 300 смен анимации (весь бюджет), после цикла они обязаны записаться снова, а не считаться уже сделанными
  const two = { ...ctx, names: ['cg1', 'cg2'], has: (n) => ['cg1', 'cg2'].includes(n) };
  const pic = (n, indent) => c(231, [1, n, 0, 0, 0, 0, 100, 100, 255, 0], indent);
  const anim = (i, indent) => [c(355, [`SAnim("r").setAnimation("s${i}", true)`], indent), ...say(`t${i}`, indent)];
  const rolled = [c(355, ['CreateSAnim("r","chapter1_scene1",0,0)']), c(122, [1, 1, 0, 0, 0]), c(112),
    c(111, [1, 1, 0, 0, 0], 1), pic('cg1', 2), c(230, [10], 2), pic('cg2', 2), c(230, [10], 2), c(0, [], 2), c(412, [], 1),
    c(111, [1, 1, 0, 1, 0], 1), ...Array.from({ length: 300 }, (_, i) => anim(i, 2)).flat(), c(0, [], 2), c(412, [], 1),
    c(122, [1, 1, 1, 0, 1], 1), c(111, [1, 1, 0, 3, 0], 1), c(113, [], 2), c(0, [], 2), c(412, [], 1), c(0, [], 1), c(413),
    ...say('end'), ...[1, 2, 3, 4].flatMap((i) => anim(i, 0))];
  r = runList(rolled, [], two);
  assert.deepStrictEqual(sp(r).map((x) => x.a[0]), [undefined, 's299', 's1', 's2', 's3', 's4'], 'первый шаг — создание скелета; шаги откаченного прохода не остались, бюджет и «последнее» вернулись (состояние слоя после цикла записывается одним шагом)');
});

test('галерея: Spine в сценах — analyze: сцена альбома Spine, интерфейсный набор, лишние наборы, сбой блока; место картинки в сценарии', () => {
  const { analyze } = require('./src/services/galleryScenes.js');
  const { c, say } = spineHelpers();
  const hero = 'img/spines/hero/hero.json';
  const names = ['cg1', 'cg2'];
  const kind = () => 'cg';
  const audioOf = (k, n) => ({ rel: `audio/${k}/${n}.ogg`, voice: false });
  const run = (sources, spine, ces = [], nm = names) => analyze(sources, ces, kind, () => false, nm, [], () => false, audioOf, spine ? { spine } : {});
  const setup = { id: 1, name: 'Setup', list: [c(355, ["CreateSAnim('h','hero',0,0)"]), c(355, ["SAnim('h').setAnimation('go', true)"])] };
  // (а) событие только со Spine: до скелета остаётся только музыка, конец — на последнем «убрать», награда после него не сцена
  const only = { id: 'ce2', name: 'Сцена', where: '', list: [c(241, [{ name: 'bgm1', volume: 90, pitch: 100, pan: 0 }]), ...say('до'), c(117, [1]), ...say('один'), ...say('два'), ...say('три'), c(355, ["RemoveSAnim('h')"]), ...say('награда')] };
  const a = run([], { sets: [hero], sources: [only] }, [null, setup]);
  assert.strictEqual(a.spineScenes.length, 1);
  const sc = a.spineScenes[0];
  assert.deepStrictEqual([sc.set, sc.id, sc.under], [hero, 'ce2', 3]);
  assert.deepStrictEqual(sc.script.map((x) => (x.k === 'say' ? x.l[0] : x.k === 'spine' ? (x.off ? 'off' : 'on') : x.k === 'snd' ? x.kind : x.k)), ['bgm', 'on', 'один', 'два', 'три', 'off']);
  // Двух реплик под скелетом мало?  Нужно SPINE_SAYS = 2: одна реплика — не сцена
  assert.strictEqual(run([], { sets: [hero], sources: [{ ...only, list: [c(117, [1]), ...say('одна'), c(355, ["RemoveSAnim('h')"])] }] }, [null, setup]).spineScenes.length, 0);
  // (б) пять наборов в одном событии — комната воспоминаний, а не сцена
  const five = ['a', 'b', 'c', 'd', 'e'].map((n) => `img/spines/${n}/${n}.json`);
  const room = { id: 'ce3', name: 'Комната', where: '', list: five.flatMap((s, i) => [c(355, [`CreateSAnim('k${i}','${s.split('/')[2]}',0,0)`]), c(355, [`SAnim('k${i}').setAnimation('go', true)`])]).concat(say('1'), say('2'), say('3')) };
  assert.strictEqual(run([], { sets: five, sources: [room] }).spineScenes.length, 0);
  // (г) из двух событий с тем же числом реплик сцену набору отдаёт то, что само его создаёт, а не обёртка
  const wrapper = { id: 'ce4', name: 'Обёртка', where: '', list: [c(117, [1]), ...say('1'), ...say('2'), ...say('3')] };
  const maker = { id: 'ce5', name: 'Создаёт', where: '', list: [c(355, ["CreateSAnim('h','hero',0,0)"]), c(355, ["SAnim('h').setAnimation('go', true)"]), ...say('1'), ...say('2'), ...say('3')] };
  assert.deepStrictEqual(run([], { sets: [hero], sources: [wrapper, maker] }, [null, setup]).spineScenes.map((x) => x.id), ['ce5']);
  // Событие с CG — сцена группы, а не альбома Spine (кадр с CG исключает кандидата)
  const withCg = { id: 'ce6', name: 'С картинками', where: '', list: [c(231, [1, 'cg1', 0, 0, 0, 0, 100, 100, 255, 0]), c(231, [2, 'cg2', 0, 0, 0, 0, 100, 100, 255, 0]), c(117, [1]), ...say('1'), ...say('2'), ...say('3')] };
  const g = run([withCg], { sets: [hero], sources: [] }, [null, setup]);
  assert.deepStrictEqual([g.spineScenes.length, g.groups.length], [0, 1]);
  assert.ok(g.groups[0].script.some((x) => x.k === 'spine' && !x.off), 'врезка осталась в сценарии группы');
  // (в) набор, который двенадцать событий показывают чужим общим событием, — интерфейс: из сценариев групп уходит вместе с off
  const ui = { id: 2, name: 'UI', list: [c(355, ["CreateSAnim('ui','hero',0,0)"]), c(355, ["SAnim('ui').setAnimation('go', false)"]), ...say('баннер'), c(355, ["RemoveSAnim('ui')"])] };
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `ce${10 + i}`, name: `Сцена ${i}`, where: '', list: [c(231, [1, `a${i}`, 0, 0, 0, 0, 100, 100, 255, 0]), ...say('1'), c(231, [2, `b${i}`, 0, 0, 0, 0, 100, 100, 255, 0]), c(117, [2]), ...say('2')] }));
  const nm = many.flatMap((_, i) => [`a${i}`, `b${i}`]);
  const shared = run(many, { sets: [hero], sources: [] }, [null, null, ui], nm);
  assert.strictEqual(shared.groups.length, 12);
  assert.ok(shared.groups.every((x) => !x.script.some((s) => s.k === 'spine')), 'интерфейсный набор из сценариев убран');
  const few = run(many.slice(0, 3), { sets: [hero], sources: [] }, [null, null, ui], nm);
  assert.ok(few.groups.every((x) => x.script.some((s) => s.k === 'spine')), 'у набора в трёх событиях врезка остаётся');
  // Блок Spine упал (событие отдаёт список один раз): сценарии групп — как без Spine, сцен Spine нет, ошибка записана
  let n = 0;
  const evil = { id: 'ce9', name: 'x', where: '', get list() { if (++n > 1) throw new Error('boom'); return [c(355, ["CreateSAnim('h','hero')"]), ...say('x'), ...say('y')]; } };
  const spine = { sets: [hero], sources: [evil] };
  const broken = run([withCg], spine, [null, setup]);
  const plain = run([withCg], null, [null, setup]);
  assert.strictEqual(spine.error, 'boom');
  assert.deepStrictEqual(broken.spineScenes, []);
  assert.deepStrictEqual(broken.groups, plain.groups, 'группы те же, что у игры без Spine');
  // Место картинки в сценарии: у сцены со Spine целая картинка получает geo, у сцены без Spine — нет
  const geoOf = (res) => res.groups[0].script.filter((x) => x.k === 'pic').map((x) => x.item.geo);
  const shows = (extra) => ({ id: 'ce7', name: 'Сцена', where: '', list: [c(231, [1, 'cg1', 0, 0, 100, 20, 50, 50, 255, 0]), ...extra, ...say('1'), c(231, [1, 'cg2', 0, 0, 0, 0, 100, 100, 255, 0]), ...say('2')] });
  const spun = geoOf(run([shows([c(117, [1])])], { sets: [hero], sources: [] }, [null, setup]));
  assert.deepStrictEqual(spun[0], [100, 20, 0, 50, 50], 'место и масштаб на экране игры');
  assert.ok(geoOf(run([shows([])], { sets: [hero], sources: [] }, [null, setup])).every((x) => x === undefined), 'без врезки места нет');
  assert.ok(geoOf(run([shows([])], null)).every((x) => x === undefined), 'и без наборов Spine вовсе');
});

test('галерея: Spine в сценах — запись сценария: набор номером в spines, чужой набор и его off вон, box у картинок, пустой сценарий только у альбома Spine; fades считает врезку сменой', async (t) => {
  const { GalleryService } = require('./src/services/gallery.js');
  const { fades } = require('./src/services/galleryScenes.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-wspine-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const set = { atlas: 'img/spines/h/h.atlas', skeleton: 'img/spines/h/h.json', pages: ['img/spines/h/h.png'], version: '3.8.87' };
  const on = (id, s, extra = {}) => ({ k: 'spine', id, s, a: ['go'], loop: true, t: 1, ...extra });
  const say = { k: 'say', l: ['hi'] };
  const write = async (key, raw, albumExtra = {}) => {
    const index = { builtAt: 9, albums: [{ key, kind: 'cg', files: ['a.png', 'b.png'], ...albumExtra }, { key: 'img/spines/h/h', kind: 'animation', files: ['img/spines/h/h.json#go'], spine: set }], parts: [] };
    await svc.writeScripts('G', path.join(root, 'G'), index, new Map([[key, raw]]));
    const out = index.scripts ? JSON.parse(await fsp.readFile(svc.scriptPath('G', index.scripts, key), 'utf8')) : null;
    return { index, out, album: index.albums[0] };
  };
  // Врезка в сцене с картинкой: s — номер в spines, box у картинок; чужой набор и его off уходят; та же картинка с другим box — отдельный шаг
  const a = await write('events/0/С', [{ k: 'pic', f: 'a.png', box: [0, 0, 816, 624] }, { k: 'pic', f: 'a.png', box: [0, 0, 816, 624] }, { k: 'pic', f: 'a.png', box: [5, 5, 800, 600] }, on('p64', set.skeleton, { at: [500, 30, 0.6, 0.6] }), say, { k: 'pic', f: 'a.png', box: [10, 0, 800, 624] },
    on('p9', 'img/spines/none/none.json'), say, { k: 'spine', id: 'p9', off: true }, { k: 'spine', id: 'p64', off: true }, say]);
  assert.deepStrictEqual(a.out.spines, [set]);
  assert.deepStrictEqual(a.out.steps.map((x) => x.k === 'pic' ? [x.i, x.box] : x.k === 'spine' ? [x.id, x.off ? 'off' : x.s] : x.k),
    [[0, [0, 0, 816, 624]], [0, [5, 5, 800, 600]], ['p64', 0], 'say', [0, [10, 0, 800, 624]], 'say', ['p64', 'off'], 'say']);
  assert.deepStrictEqual(a.album.sum.a, 1, 'врезка — тоже анимация для плитки сцены');
  // Файл сцены отдаётся с spines и экраном; вторая запись без Spine — без ключа spines
  const plain = await write('events/1/Т', [{ k: 'pic', f: 'a.png' }, say]);
  assert.strictEqual(plain.out.spines, undefined);
  assert.ok(!plain.out.steps.some((x) => x.box));
  // Картинки нет: у события сценария нет, у альбома Spine — есть (скелет на чёрном и реплики)
  const bare = [on('kd:h', set.skeleton), say, say];
  assert.strictEqual((await write('events/2/Н', bare)).out, null);
  const index = { builtAt: 9, albums: [{ key: 'img/spines/h/h', kind: 'animation', files: ['img/spines/h/h.json#go'], spine: set }], parts: [] };
  await svc.writeScripts('G', path.join(root, 'G'), index, new Map([['img/spines/h/h', bare]]));
  assert.strictEqual(index.albums[0].script, true);
  assert.strictEqual(index.albums[0].sum.l, 2);
  // Только off и чужой набор — для альбома Spine это не сцена
  const idx2 = { builtAt: 9, albums: [{ ...index.albums[0], script: undefined }], parts: [] };
  await svc.writeScripts('G', path.join(root, 'G'), idx2, new Map([['img/spines/h/h', [on('p1', 'img/spines/none/none.json'), say, say]]]));
  assert.ok(!idx2.albums[0].script);
  // fades: врезка под чёрным — смена картинки, пара остаётся; без неё пустая пара убирается
  const fx = (o) => ({ k: 'fx', t: 'fade', o, n: 24 });
  assert.deepStrictEqual(fades([fx(1), { k: 'wait', n: 24 }, fx(0)]).filter((x) => x.k === 'fx').length, 0);
  assert.strictEqual(fades([fx(1), on('p1', 'x'), fx(0)]).filter((x) => x.k === 'fx').length, 2);
});

test('галерея: Spine в сценах — сборка: скелет и реплики без картинок — сцена альбома Spine (script, «Смотреть сцену»), врезка в CG-сцене с box, остальные альбомы прежние', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-sscene-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  const dir = path.join(game, 'img', 'spines', 'hero');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(path.join(game, 'data'), { recursive: true });
  await fsp.writeFile(path.join(game, 'data', 'System.json'), '{}');
  const png = Buffer.alloc(300000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(1024, 16); png.writeUInt32BE(1024, 20); png[24] = 8; png[25] = 6;
  await fsp.writeFile(path.join(dir, 'hero.png'), png);
  await fsp.writeFile(path.join(dir, 'hero.atlas'), '\nhero.png\nsize: 1024,1024\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\narm\n  rotate: false\n  xy: 0, 0\n  size: 8, 8\n');
  await fsp.writeFile(path.join(dir, 'hero.json'), JSON.stringify({ skeleton: { spine: '3.8.87' }, bones: [{ name: 'root' }], slots: [{ name: 'arm', bone: 'root', attachment: 'arm' }], skins: [{ name: 'default', attachments: { arm: { arm: {} } } }], animations: { idle: {}, go: {} } }));
  const pic = (name, size) => {
    fs.mkdirSync(path.dirname(path.join(game, 'img', 'pictures', `${name}.png`)), { recursive: true });
    return spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${size}`, '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', `${name}.png`)]);
  };
  pic('s1/cg1', '816x624'); pic('s2/cg2', '816x624'); pic('s3/cg3', '816x624'); pic('s4/cg4', '816x624');
  // Слой с прозрачностью: сцена из основы и слоя — склейка «@cg/…» (обрезка по окну слоя), а не целая картинка
  fs.mkdirSync(path.join(game, 'img', 'pictures', 's5'), { recursive: true });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black@0:s=816x624,format=rgba,drawbox=x=300:y=200:w=120:h=120:color=red@1:t=fill', '-frames:v', '1', path.join(game, 'img', 'pictures', 's5', 'cg5.png')]);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const show = (n, name, x = 0, y = 0, z = 100) => c(231, [n, name, 0, 0, x, y, z, z, 255, 0]);
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const spineOn = [c(355, ["CreateSAnim('h','hero',0,0)"]), c(355, ["SAnim('h').setAnimation('go', true)"])];
  const ces = [null,
    // 1: скелет и реплики без единой картинки — сцена альбома Spine
    { id: 1, name: 'Только скелет', list: [c(117, [4]), ...line('раз'), ...line('два'), ...line('три'), c(117, [5]), ...line('после')] },
    // 2: CG-сцена: целая картинка 816×624 в масштабе 50 на (100, 0) и врезка поверх; другая CG рядом
    { id: 2, name: 'CG и врезка', list: [show(1, 's1/cg1'), ...line('а'), show(1, 's2/cg2', 100, 0, 50), ...spineOn, ...line('б'), c(355, ["RemoveSAnim('h')"]), show(1, 's3/cg3'), ...line('в')] },
    // 3: CG-сцена без Spine
    { id: 3, name: 'Просто CG', list: [show(1, 's4/cg4'), ...line('г'), show(2, 's5/cg5'), ...line('д')] },
    // 4: сам запускает скелет, реплик нет; событие 1 его зовёт — так находят события без картинок (вызовы до трёх уровней)
    { id: 4, name: 'Скелет', list: spineOn },
    { id: 5, name: 'Убрать скелет', list: [c(355, ["RemoveSAnim('h')"])] }];
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify(ces));
  await fsp.writeFile(path.join(game, 'data', 'MapInfos.json'), '[null]');
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const build = async () => { const quiet = t.mock.method(console, 'log', () => {}); const ix = await svc.runBuild('G', { done: 0, total: 0 }); quiet.mock.restore(); return ix; };
  const index = await build();
  const hero = index.albums.find((a) => a.spine);
  assert.ok(hero.script, JSON.stringify(index.albums.map((a) => [a.key, a.script])));
  const scene = await svc.scene('G', hero.key);
  assert.strictEqual(scene.spines.length, 1);
  assert.strictEqual(scene.spines[0].skeleton, 'img/spines/hero/hero.json');
  assert.deepStrictEqual(scene.screen, index.screen);
  // С выбором языка (opts) ответ несёт те же spines
  assert.deepStrictEqual((await svc.scene('G', hero.key, null, { ui: 'en', known: [], want: [] })).spines, scene.spines);
  assert.deepStrictEqual(scene.steps.map((x) => (x.k === 'spine' ? (x.off ? 'off' : `on:${x.s}`) : x.k)), ['on:0', 'say', 'say', 'say', 'off'], 'после последнего off — награда уже не сцена');
  assert.strictEqual(hero.sum.l, 3);
  assert.strictEqual(hero.sum.a, 1);
  // Альбом Spine остался прежним: файлы и обложка
  assert.deepStrictEqual(hero.files, ['img/spines/hero/hero.json#idle', 'img/spines/hero/hero.json#go']);
  assert.strictEqual(hero.cover, 'img/spines/hero/hero.png');
  // CG-сцена со врезкой: у картинки box из места на экране, у шага spine — место; CG-сцена без Spine — без box
  const ev = index.albums.filter((a) => a.key.startsWith('events/') && a.script);
  const scenes = await Promise.all(ev.map((a) => svc.scene('G', a.key)));
  const withSpine = scenes.find((s) => s.steps.some((x) => x.k === 'spine'));
  assert.ok(withSpine, JSON.stringify(ev.map((a) => a.key)));
  assert.deepStrictEqual(withSpine.steps.filter((x) => x.k === 'pic').map((x) => [withSpine.files[x.i].split('/').pop(), x.box]), [['cg1.png', [0, 0, 816, 624]], ['cg2.png', [100, 0, 408, 312]], ['cg3.png', [0, 0, 816, 624]]]);
  const without = scenes.find((s) => !s.steps.some((x) => x.k === 'spine'));
  assert.ok(without && !without.steps.some((x) => x.box) && !without.spines, 'сцена без Spine — без box и spines');
  // Остальные альбомы те же, что без событий Spine: убираем скелетные события — ключи и файлы альбомов не меняются
  const shape = (ix) => ix.albums.filter((a) => !a.spine).map((a) => [a.key, a.files, a.cover]);
  await fsp.writeFile(path.join(game, 'data', 'CommonEvents.json'), JSON.stringify([null, null, { id: 2, name: 'CG и врезка', list: ces[2].list.filter((x) => x.code !== 355) }, ces[3]]));
  svc.forget('G');
  const plain = await build();
  assert.deepStrictEqual(shape(index), shape(plain), 'врезка в сценарии альбомов не меняет');
  assert.ok(!plain.albums.find((a) => a.spine).script, 'без скелетных событий у альбома Spine сценария нет');
});

// --- Live2D в сценах (шаги l2d): PictureLive2D и Live2DInterfaceMZ ---
const l2dHelpers = () => {
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const say = (t, indent = 0) => [c(101, ['', 0, 0, 2, ''], indent), c(401, [t], indent)];
  const hero = 'img/live2d/hero/hero.model3.json';
  const jen = 'assets/Jen/Jen.model3.json';
  const motion = (name, group, i, extra = {}) => ({ name, group, i, base: name, ...extra });
  const l2d = [
    { model: hero, via: 'pic', name: '', motions: [motion('idle', 'Idle', 0), motion('smile', 'Idle', 1, { mname: 'Happy' }), motion('Tap/idle', 'Tap', 0, { base: 'idle' }), motion('still', '', -1)], exps: ['sad', 'wink'] },
    { model: jen, via: 'if', name: 'ジェニー', tags: { 'm-01': 'Idle_1', 'm-02': 'Idle_2, Idle_3' }, def: { x: 408, y: 320, k: 1, left: 100, middle: 408, right: 716 },
      motions: [motion('m-01', 'Idle', 0), motion('m-02', 'Idle', 1), motion('m-03', 'Idle', 2)], exps: [] },
  ];
  const audio = (k, n) => (n === 'v1' ? { rel: 'audio/voice/v1.ogg', voice: true } : null);
  const ctx = { names: ['cg1'], has: (n) => n === 'cg1', movies: [], audio, spines: null, l2d };
  const rigs = (r) => r.scenario.filter((x) => x.k === 'l2d');
  const strip = (sc) => sc.filter((x) => x.k !== 'l2d');
  const iface = (cmd, args) => c(357, ['Live2DInterfaceMZ', cmd, '', args]);
  const host = (n = 5, x = 10, y = 20, z = 50) => c(231, [n, '', 0, 0, x, y, z, z, 255, 0]);
  return { c, say, hero, jen, l2d, ctx, rigs, strip, iface, host };
};

test('галерея: Live2D в сценах — runList: PictureLive2D (каждый метод цепочки) и Live2DInterfaceMZ (каждая команда); кадры и сценарий без Live2D те же', () => {
  const { runList } = require('./src/services/galleryScenes.js');
  const { c, say, hero, jen, ctx, rigs, strip, iface, host } = l2dHelpers();
  const ctx0 = { ...ctx, l2d: null };
  const same = (list, ces = []) => {
    const r = runList(list, ces, ctx);
    const o = runList(list, ces, ctx0);
    assert.deepStrictEqual(r.frames, o.frames, 'кадры альбомов от Live2D не зависят');
    assert.deepStrictEqual(r.mentions, o.mentions);
    assert.deepStrictEqual(strip(r.scenario), o.scenario, 'сценарий без шагов l2d прежний');
    return r;
  };
  const js = (src, indent = 0) => c(355, [src], indent);
  // Носитель: картинка без имени (x, y — левый верхний угол холста, 50 % от игры); цепочка в двух строках 355 + 655 (setModel сбрасывает всё)
  let r = same([c(231, [1, 'cg1', 0, 0, 0, 0, 100, 100, 255, 0]), host(5, 10, 20, 50), js("$gameScreen.live2d(5).setModel('hero')"), c(655, [".setAnimation(0, 'Idle01').setExpression('sad');"]), ...say('a'),
    js("$gameScreen.live2d(5).setScale(0.2, 0.4).setOffset(100, 50)"), ...say('b'), js('$gameScreen.erasePicture(5)'), ...say('c')]);
  const base = { k: 'l2d', id: 'p5', s: hero, a: ['idle'], loop: true, t: 1, q: true, e: 'sad' };
  assert.deepStrictEqual(rigs(r), [{ ...base, at: [10, 20, 0.5, 0.5] }, { ...base, at: [60, 45, 0.1, 0.2] }, { k: 'l2d', id: 'p5', off: true }]);
  // Имя движения: Name из model3.json, «Группа + номер из двух цифр», имя файла (если оно не двусмысленно); чужое имя в списке пропускается
  r = same([host(), js("$gameScreen.live2d(5).setModel('hero/hero')"), js("$gameScreen.live2d(5).setAnimation(0, ['Happy', 'Nope', 'Idle01/times=2,timeScale=1.5'], 'sequential', 'continue', true)"), ...say('a'),
    js("$gameScreen.live2d(5).setAnimation(0, 'Tap01', 'none', true)"), ...say('b'), js("$gameScreen.live2d(5).setAnimation(0, 'Nope')"), ...say('c'), js("$gameScreen.live2d(5).setAnimation(1, 'Idle01')"), ...say('d')]);
  assert.deepStrictEqual(rigs(r).map((x) => [x.a, x.loop, x.q, x.ats, x.t]), [
    [['smile', 'idle', 'idle'], true, undefined, [1, 1.5, 1.5], 1], [['Tap/idle'], false, undefined, undefined, 2]], 'неизвестные имена и чужая дорожка не меняют ничего');
  // clearAnimation (дорожка 0) останавливает; setExpression/clearExpression; setVisible(false) и цвет с нулевой прозрачностью прячут/гасят; setTimeScale
  r = same([host(), js("$gameScreen.live2d(5).setModel('hero').setAnimation(0, 'Idle01')"), ...say('a'), js("$gameScreen.live2d(5).clearAnimation(0, 0.5).setExpression('wink').setTimeScale(2)"), ...say('b'),
    js("$gameScreen.live2d(5).clearExpression().setVisible(false).setColor(1, 1, 1, 0)"), ...say('c'), js("$gameScreen.live2d(5).setVisible(true).setColor(1, 1, 1, 0.5)"), ...say('d')]);
  assert.deepStrictEqual(rigs(r).map((x) => [x.a, x.e, x.ts, x.hide, x.op]), [
    [['idle'], undefined, undefined, undefined, undefined], [[], 'wink', 2, undefined, undefined], [[], undefined, 2, true, 0], [[], undefined, 2, undefined, 128]]);
  // Новая «Показать картинку» на тот же номер — модели на ней больше нет; setModel другой модели начинает с чистого слоя
  r = same([host(), js("$gameScreen.live2d(5).setModel('hero').setAnimation(0, 'Idle01')"), ...say('a'), host(), ...say('b')]);
  assert.deepStrictEqual(rigs(r).map((x) => !!x.off), [false, true]);
  r = same([host(), js("$gameScreen.live2d(5).setModel('hero').setScale(2, 2).setAnimation(0, 'Idle01')"), ...say('a'), js("$gameScreen.live2d(5).setModel('hero')"), ...say('b')]);
  assert.deepStrictEqual(rigs(r).map((x) => [x.a, x.at[2]]), [[['idle'], 1], [[], 0.5]], 'масштаб и движения после setModel сброшены; картинка 50 %');
  // Голос: файл среди звуков игры → шаг voice; неизвестный — ничего
  r = runList([host(), js("$gameScreen.live2d(5).setModel('hero').playVoice('audio/voice/v1.ogg', { volume: 80 })"), ...say('a'), js("$gameScreen.live2d(5).playVoice('absent')"), ...say('b')], [], ctx);
  assert.deepStrictEqual(r.scenario.filter((x) => x.k === 'snd').map((x) => [x.kind, x.f]), [['voice', 'audio/voice/v1.ogg']]);
  // Номер потерян (переменная): то же выражение — тот же слой. Модели, которой нет среди найденных, — шагов нет, кадры целы
  r = same([c(122, [7, 7, 0, 0, 12]), js('$gameScreen.showPicture($gameVariables.value(7),"",0,0,0,100,100,255,0)'), js("$gameScreen.live2d($gameVariables.value(7)).setModel('hero').setAnimation(0, 'Idle01')"), ...say('a'), c(117, [5]),
    js("$gameScreen.live2d($gameVariables.value(7)).setAnimation(0, 'Happy')"), ...say('b')], [null, null, null, null, null, { id: 5, list: [c(117, [5])] }]);
  assert.deepStrictEqual(rigs(r).map((x) => [x.id, x.a]), [['p12', ['idle']], ['p12', ['smile']]]);
  assert.deepStrictEqual(rigs(runList([host(), js("$gameScreen.live2d(5).setModel('nope').setAnimation(0, 'Idle01')"), js("$gameScreen.live2d(5).setModel("), ...say('a')], [], ctx)), []);

  // Live2DInterfaceMZ: модель по имени, движение по метке из параметров плагина; петля — если не «false»; список меток — очередь
  const at = (x, y, k = 0.2) => [x, y, k, k];
  r = same([iface('show', { modelName: 'ジェニー' }), ...say('до движения'), iface('motion', { modelName: 'ジェニー', motionName: 'm-01', loop: 'false' }), ...say('a'),
    iface('motion', { modelName: 'ジェニー', motionName: 'm-02', loop: 'true' }), iface('scale', { modelName: 'ジェニー', scale: '2.5' }), iface('pos', { modelName: 'ジェニー', x: '650', y: '390', dur: '1', wait: 'false' }), ...say('b'),
    iface('left', { modelName: 'ジェニー' }), iface('pos', { modelName: 'ジェニー', x: '300', y: '300', dur: '30', wait: 'true' }), iface('expression', { modelName: 'ジェニー', expressionName: 'sad' }), ...say('c'),
    iface('middle', { modelName: 'ジェニー' }), iface('right', { modelName: 'ジェニー' }), iface('hide', { modelName: 'ジェニー' }), ...say('d'), iface('show', { modelName: 'ジェニー' }), ...say('e')]);
  assert.deepStrictEqual(rigs(r).map((x) => [x.a, x.loop, x.at, x.c, x.d, x.e, !!x.off]), [
    [[], true, at(408, 320), 1, undefined, undefined, false],
    [['m-01'], false, at(408, 320), 1, undefined, undefined, false],
    [['m-02', 'm-03'], true, at(650, 390, 0.5), 1, undefined, undefined, false],
    [['m-02', 'm-03'], true, at(300, 300, 0.5), 1, 30, 'sad', false],
    [undefined, undefined, undefined, undefined, undefined, undefined, true],
    [['m-02', 'm-03'], true, at(716, 300, 0.5), 1, undefined, 'sad', false]], 'show, motion, scale+pos, left/pos с переездом и expression одним шагом, hide (right и middle под ним не видны) и снова show');
  // Модель без показа в сценарий не попадает; чужое имя и метка без движения — ничего
  assert.deepStrictEqual(rigs(runList([iface('motion', { modelName: 'ジェニー', motionName: 'm-01', loop: 'true' }), ...say('a')], [], ctx)), []);
  assert.deepStrictEqual(rigs(runList([iface('show', { modelName: 'Нет такой' }), iface('motion', { modelName: 'Нет такой', motionName: 'm-01' }), ...say('a')], [], ctx)), []);
  r = runList([iface('show', { modelName: 'ジェニー' }), iface('motion', { modelName: 'ジェニー', motionName: 'm-99' }), ...say('a')], [], ctx);
  assert.deepStrictEqual(rigs(r).map((x) => x.a), [[]], 'метки m-99 нет — движение не меняется');
  // «Общие события-кирпичи» (117) и отступы веток: модель показывает кирпич, ветка неизвестного условия идёт по первой
  r = runList([c(117, [1]), ...say('a'), c(117, [2]), ...say('b')], [null, { id: 1, list: [iface('show', { modelName: 'ジェニー' }), iface('motion', { modelName: 'ジェニー', motionName: 'm-01', loop: 'false' })] }, { id: 2, list: [iface('hide', { modelName: 'ジェニー' })] }], ctx);
  assert.deepStrictEqual(rigs(r).map((x) => [!!x.off, x.a]), [[false, ['m-01']], [true, undefined]]);
  // Сбой разбора (ctx.l2d бросает) выключает Live2D только в этом событии
  const bad = { length: 1, filter() { throw new Error('boom'); }, find() { throw new Error('boom'); } };
  const list = [host(), js("$gameScreen.live2d(5).setModel('hero')"), iface('show', { modelName: 'ジェニー' }), ...say('a')];
  const guarded = runList(list, [], { ...ctx, l2d: bad });
  assert.deepStrictEqual(guarded.frames, runList(list, [], ctx0).frames);
  assert.deepStrictEqual(strip(guarded.scenario), runList(list, [], ctx0).scenario);
  // Spine и Live2D рядом: у игры с обоими в одном событии слои не путаются
  const both = runList([js("CreateSAnim('h','hero',0,0)"), js("SAnim('h').setAnimation('go', true)"), iface('show', { modelName: 'ジェニー' }), ...say('a')], [], { ...ctx, spines: ['img/spines/hero/hero.json'] });
  assert.deepStrictEqual(both.scenario.filter((x) => x.k === 'spine' || x.k === 'l2d').map((x) => [x.k, x.id]), [['spine', 'kd:h'], ['l2d', 'i:ジェニー']]);
});

test('галерея: Live2D в сценах — analyze: сцена модели (по нескольку на модель), портрет говорящего — интерфейс, группа с CG держит модель; без моделей блок не нужен', () => {
  const { analyze } = require('./src/services/galleryScenes.js');
  const { c, say, jen, hero, l2d, iface } = l2dHelpers();
  const kind = () => 'cg';
  const audioOf = () => null;
  const run = (sources, ces = [], nm = ['cg1', 'cg2'], models = l2d, extra = []) => analyze(sources, ces, kind, () => false, nm, [], () => false, audioOf, { spine: { sets: [], l2d: models, sources: extra } });
  const brick = (n, cmd, args) => ({ id: n, name: `к${n}`, list: [iface(cmd, { modelName: 'ジェニー', ...args })] });
  const ces = [null, brick(1, 'show', {}), brick(2, 'motion', { motionName: 'm-01', loop: 'true' }), brick(3, 'motion', { motionName: 'm-02', loop: 'true' }), brick(4, 'hide', {})];
  const ev = (id, lines, steps = [1, 2]) => ({ id, name: `Сцена ${id}`, where: '', list: [...steps.map((n) => c(117, [n])), ...lines.flatMap((t) => say(t)), c(117, [4]), ...say('награда')] });
  // Три события: оригинал, копия с другим текстом (то же число реплик) и другая сцена с другим движением
  const a = ev('m1e1p0', ['1', '2', '3']);
  const copy = ev('m2e1p0', ['x', 'y', 'z']);
  const other = ev('m1e2p0', ['1', '2', '3'], [1, 3]);
  const out = run([], ces, undefined, undefined, [a, copy, other]);
  assert.strictEqual(out.l2dScenes.length, 3, 'сцены модели отдаются все: копии отсеивает галерея по отпечатку');
  assert.deepStrictEqual(out.l2dScenes.map((x) => [x.id, x.set, x.under, x.says]), [['m1e1p0', jen, 3, 3], ['m2e1p0', jen, 3, 3], ['m1e2p0', jen, 3, 3]]);
  assert.strictEqual(out.l2dScenes[0].sig, out.l2dScenes[1].sig);
  assert.notStrictEqual(out.l2dScenes[0].sig, out.l2dScenes[2].sig, 'другое движение — другой отпечаток');
  assert.deepStrictEqual(out.spineScenes, [], 'у Spine сцен нет');
  // Одна реплика под моделью — не сцена
  assert.deepStrictEqual(run([], ces, undefined, undefined, [ev('m3e1p0', ['1'])]).l2dScenes, []);
  // Модель в двадцати событиях — портрет говорящего: из сценариев уходит вместе с off, сцен у неё нет; у модели в трёх — остаётся
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `ce${10 + i}`, name: `С ${i}`, where: '', list: [c(231, [1, `a${i}`, 0, 0, 0, 0, 100, 100, 255, 0]), c(117, [1]), ...say('1'), c(231, [2, `b${i}`, 0, 0, 0, 0, 100, 100, 255, 0]), ...say('2'), ...say('3')] }));
  const nm = many.flatMap((_, i) => [`a${i}`, `b${i}`]);
  const shared = run(many, ces, nm, undefined, []);
  assert.strictEqual(shared.groups.length, 20);
  assert.ok(shared.groups.every((g) => !g.script.some((s) => s.k === 'l2d')), 'портрет из сценариев убран');
  const few = run(many.slice(0, 3), ces, nm, undefined, []);
  assert.ok(few.groups.every((g) => g.script.some((s) => s.k === 'l2d' && !s.off)), 'у модели в трёх событиях остаётся в группе с CG');
  assert.deepStrictEqual(few.l2dScenes, [], 'событие с CG — сцена группы, а не альбома модели');
  // Модель PictureLive2D на картинке без имени: домой — модель, не интерфейс
  const pic = { id: 'm1e5p0', name: 'Н', where: '', list: [c(231, [5, '', 0, 0, 0, 0, 100, 100, 255, 0]), c(355, ["$gameScreen.live2d(5).setModel('hero').setAnimation(0, 'Idle01')"]), ...say('1'), ...say('2'), c(235, [5])] };
  assert.deepStrictEqual(run([], ces, undefined, undefined, [pic]).l2dScenes.map((x) => [x.set, x.under]), [[hero, 2]]);
  // Без моделей Live2D блок не нужен и ничего не добавляет
  assert.deepStrictEqual(run([], ces, undefined, [], [a]).l2dScenes, []);
});

test('галерея: Live2D в сценах — сборка: сцены-гости альбома модели, копии один раз, сценарий с l2ds, ядро и файлы отдаются; остальные альбомы прежние', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const { GalleryService } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-l2scene-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'G');
  const put = async (rel, data) => { await fsp.mkdir(path.dirname(path.join(game, rel)), { recursive: true }); await fsp.writeFile(path.join(game, rel), data); };
  const png = Buffer.alloc(300000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(2048, 16); png.writeUInt32BE(2048, 20); png[24] = 8; png[25] = 6;
  const moc = Buffer.concat([Buffer.from('MOC3', 'latin1'), Buffer.from([5]), Buffer.alloc(64)]);
  await put('data/System.json', '{}');
  await put('js/plugins.js', `var $plugins = [
  { name: "PictureLive2D", status: true, parameters: { "json file": '["hero/hero"]' } },
  { name: "Live2DInterfaceMZ", status: true, parameters: { Modelcondition: '["{\\\\"Modelname\\\\":\\\\"ジェニー\\\\",\\\\"folderpath\\\\":\\\\"./assets/Jen/\\\\",\\\\"motiongroupnames\\\\":\\\\"\\\\\\\\"<m-01:Idle_1>\\\\\\\\\\\\\\\\n<m-02:Idle_2>\\\\\\\\\\\\\\\\n<m-03:Idle_3>\\\\\\\\"\\\\"}"]', vertical: "320", left: "100", middle: "408", right: "716", DefaultScale: "1.0" } },
];`);
  await put('js/plugins/live2dcubismcore.min.js', '/* MocVersion_50 */');
  const files = (dir, stem, n) => Promise.all([
    put(`${dir}/${stem}.moc3`, moc), put(`${dir}/${stem}.${n}/texture_00.png`, png), put(`${dir}/${stem}.physics3.json`, '{}'),
    ...['m-01', 'm-02', 'm-03'].map((m) => put(`${dir}/Motion/${m}.motion3.json`, '{}'))]);
  await put('assets/Jen/Jen.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'Jen.moc3', Textures: ['Jen.1024/texture_00.png'], Physics: 'Jen.physics3.json', Motions: { Idle: ['m-01', 'm-02', 'm-03'].map((m) => ({ File: `Motion/${m}.motion3.json` })) } } }));
  await files('assets/Jen', 'Jen', 1024);
  await put('img/live2d/hero/hero.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'hero.moc3', Textures: ['hero.2048/texture_00.png'], Physics: 'hero.physics3.json',
    Expressions: [{ Name: 'sad', File: 'sad.exp3.json' }], Motions: { Idle: [{ File: 'Motion/m-01.motion3.json' }, { File: 'Motion/m-02.motion3.json' }] } } }));
  await files('img/live2d/hero', 'hero', 2048);
  await put('img/live2d/hero/sad.exp3.json', '{}');
  // Фон: любая картинка — без неё сборка сцен не нужна
  fs.mkdirSync(path.join(game, 'img', 'pictures'), { recursive: true });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=816x624', '-vf', 'noise=alls=100:allf=t', '-frames:v', '1', path.join(game, 'img', 'pictures', 'bg.png')]);
  const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
  const line = (s) => [c(101, ['', 0, 0, 2]), c(401, [s])];
  const face = (cmd, args) => c(357, ['Live2DInterfaceMZ', cmd, '', { modelName: 'ジェニー', ...args }]);
  const ces = [null,
    { id: 1, name: 'показать', list: [face('show'), face('scale', { scale: '2.6' }), face('pos', { x: '650', y: '350', dur: '1', wait: 'false' }), face('motion', { motionName: 'm-01', loop: 'false' })] },
    { id: 2, name: 'движение 2', list: [face('motion', { motionName: 'm-02', loop: 'true' })] },
    { id: 3, name: 'движение 3', list: [face('motion', { motionName: 'm-03', loop: 'true' })] },
    { id: 4, name: 'убрать', list: [face('hide')] }];
  const page = (list) => ({ conditions: {}, list, trigger: 0 });
  const scene = (ids, words) => page([c(231, [1, 'bg', 0, 0, 0, 0, 100, 100, 255, 0]), c(117, [ids[0]]), ...words.slice(0, 2).flatMap(line), c(117, [ids[1]]), ...words.slice(2).flatMap(line), c(117, [4]), ...line('после')]);
  const hero = page([c(231, [1, 'bg', 0, 0, 0, 0, 100, 100, 255, 0]), c(231, [5, '', 0, 0, 30, 40, 50, 50, 255, 0]), c(355, ["$gameScreen.live2d(5).setModel('hero')"]), c(655, [".setAnimation(0, 'Idle02').setExpression('sad');"]), ...['я', 'ты', 'он'].flatMap(line), c(235, [5]), ...line('после')]);
  await put('data/CommonEvents.json', JSON.stringify(ces));
  await put('data/MapInfos.json', JSON.stringify([null, { id: 1, name: 'Карта', parentId: 0, order: 1 }]));
  // Оригинал, копия в «комнате воспоминаний» (те же модели и движения, другой текст и порядок страниц), другая сцена и сцена героя
  await put('data/Map001.json', JSON.stringify({ events: [null,
    { id: 1, name: 'Сцена А', pages: [scene([1, 2], ['один', 'два', 'три', 'четыре'])] },
    { id: 2, name: 'Сцена А', pages: [scene([1, 2], ['uno', 'dos', 'tres', 'cuatro'])] },
    { id: 3, name: 'Сцена Б', pages: [scene([1, 3], ['пять', 'шесть', 'семь', 'восемь'])] },
    { id: 4, name: 'Герой', pages: [hero] }] }));
  const svc = new GalleryService();
  svc.setDependencies({ gamesDir: root, mediaDir: path.join(root, '_media') });
  const quiet = t.mock.method(console, 'log', () => {});
  const index = await svc.runBuild('G', { done: 0, total: 0 });
  quiet.mock.restore();
  const jen = index.albums.find((a) => a.live2d && a.live2d.model === 'assets/Jen/Jen.model3.json');
  const her = index.albums.find((a) => a.live2d && a.live2d.model === 'img/live2d/hero/hero.model3.json');
  // Модель Interface: две сцены (копия — один раз), с названиями по первой реплике; к ним — плитка «движение» в сводке
  assert.ok(jen.script, JSON.stringify(jen));
  assert.deepStrictEqual(jen.scenes.map((x) => x.t), ['Сцена А', 'Сцена Б']);
  assert.deepStrictEqual(jen.scenes.map((x) => x.f), [[0, 1], [0, 2]], 'файлы альбома — движения, что сцена играет');
  assert.ok(jen.scenes.every((x) => x.sum.a === 1 && x.sum.l === 4), JSON.stringify(jen.scenes));
  const s0 = await svc.scene('G', jen.key, null, { n: 0 });
  assert.strictEqual(s0.l2ds.length, 1);
  assert.deepStrictEqual(s0.l2ds[0].motions, [['m-01', 'Idle', 0], ['m-02', 'Idle', 1], ['m-03', 'Idle', 2]]);
  assert.deepStrictEqual(s0.steps.filter((x) => x.k === 'l2d').map((x) => [x.id, x.s, x.a, x.loop, !!x.off, x.at, x.c]), [
    ['i:ジェニー', 0, ['m-01'], false, false, [650, 350, 0.52, 0.52], 1], ['i:ジェニー', 0, ['m-02'], true, false, [650, 350, 0.52, 0.52], 1], ['i:ジェニー', undefined, undefined, undefined, true, undefined, undefined]]);
  assert.deepStrictEqual((await svc.scene('G', jen.key, null, { n: 1 })).steps.filter((x) => x.k === 'l2d' && !x.off).map((x) => x.a), [['m-01'], ['m-03']]);
  assert.strictEqual(await svc.scene('G', jen.key, null, { n: 2 }), null, 'третьей сцены нет: копия отсеяна');
  // Герой PictureLive2D: носитель — картинка без имени; ядро и файлы отдаются плееру
  assert.ok(her.script);
  const sh = await svc.scene('G', her.key);
  assert.deepStrictEqual(sh.steps.filter((x) => x.k === 'l2d').map((x) => [x.id, x.a, x.e, x.at]), [['p5', ['m-02'], 'sad', [30, 40, 0.5, 0.5]], ['p5', undefined, undefined, undefined]]);
  assert.strictEqual(sh.l2ds[0].core, 'js/plugins/live2dcubismcore.min.js');
  assert.equal((await svc.live2dFile('G', sh.l2ds[0].core)).type, 'text/javascript; charset=utf-8');
  assert.equal((await svc.live2dFile('G', 'assets/Jen/Motion/m-01.motion3.json')).type, 'application/json');
  // Остальные альбомы без изменений: ни у одного нет сценария, кроме моделей
  assert.deepStrictEqual(index.albums.filter((a) => a.script).map((a) => a.key).sort(), [jen.key, her.key].sort());
});

test('галерея: Live2D в сценах — метки движений и места по умолчанию из параметров Live2DInterfaceMZ, имя движения (Name) из model3.json', async (t) => {
  const { findLive2D } = require('./src/services/gallery.js');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-l2tags-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const put = async (rel, data) => { await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fsp.writeFile(path.join(root, rel), data); };
  const moc = Buffer.concat([Buffer.from('MOC3', 'latin1'), Buffer.from([4]), Buffer.alloc(64)]);
  await put('js/plugins.js', `var $plugins = [
  { name: "Live2DInterfaceMZ", status: true, parameters: { Modelcondition: '["{\\\\"Modelname\\\\":\\\\"ハンナ\\\\",\\\\"folderpath\\\\":\\\\"./assets/hanna2/\\\\",\\\\"motiongroupnames\\\\":\\\\"\\\\\\\\"<m-01:Idle_1>\\\\\\\\\\\\\\\\n<m-02:Idle_2, Idle_3>\\\\\\\\"\\\\"}"]', vertical: "300", left: "90", middle: "400", right: "700", DefaultScale: "1.5" } },
  { name: "PictureLive2D", status: true, parameters: { "json file": '["h/h"]' } },
];`);
  await put('js/libs/live2dcubismcore.min.js', '/* MocVersion_42 */');
  await put('assets/hanna2/hanna2.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: ['t.png'], Motions: { Idle: [{ File: 'a.motion3.json' }] } } }));
  await put('assets/hanna2/a.moc3', moc); await put('assets/hanna2/t.png', 'x'); await put('assets/hanna2/a.motion3.json', '{}');
  await put('img/live2d/h/h.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: ['t.png'], Motions: { Idle: [{ File: 'dir/a.motion3.json', Name: 'Happy' }] } } }));
  await put('img/live2d/h/a.moc3', moc); await put('img/live2d/h/t.png', 'x'); await put('img/live2d/h/dir/a.motion3.json', '{}');
  const found = await findLive2D(root);
  const iface = found.find((x) => x.via === 'if');
  assert.deepStrictEqual([iface.name, iface.tags, iface.def], ['ハンナ', { 'm-01': 'Idle_1', 'm-02': 'Idle_2, Idle_3' }, { x: 400, y: 300, k: 1.5, left: 90, middle: 400, right: 700 }]);
  const pic = found.find((x) => x.via === 'pic');
  assert.deepStrictEqual(pic.motions.map((m) => [m.name, m.base, m.mname]), [['a', 'a', 'Happy']]);
  assert.strictEqual(pic.tags, undefined);
});
