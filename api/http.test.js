// Проверки HTTP-слоя: настоящее приложение из server.js на свободном порту и настоящая база во
// временной папке. Правила и сервисы проверяет server.test.js — здесь только то, как всё собрано
// вместе: вход, защита API от страниц игр, проверка id в адресе, лимиты тела, раздача файлов
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Всё это — до подключения server.js: настройки читаются при загрузке модулей
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-http-'));
process.env.GAMES_DIR = root;
// Ключ сессии — из базы, как без .env: так проверяется и смена ключа при выходе
delete process.env.SESSION_SECRET;
// Модель распознавания картинок галереи (85 МБ) тесты не качают
process.env.GALLERY_VISION = '0';
// Запросов тесты делают почти на весь предел ограничителя API (200) — с запасом, иначе новый тест роняет последние
process.env.API_RATE_LIMIT = '400';
// Игры — на своём адресе, как в проде
delete process.env.GAME_ISOLATION;
process.env.GAME_PORT = '8081';
// Своя база Redis (номер 15): в dev тот же Redis обслуживает живой сервер, и его кэш списка игр
// не должен смешиваться с тестовым
const redisUrl = new URL(process.env.REDIS_URL || 'redis://redis:6379');
redisUrl.pathname = '/15';
process.env.REDIS_URL = redisUrl.toString();

const { app } = require('./server.js');
const dbService = require('./src/db/database.js');
const { redisClient } = require('./src/utils/cache.js');

const COOKIE = process.env.AUTH_COOKIE_NAME || 'auth_token';
const GAME = 'Test_Game';
const USER = 'owner';
const PASS = 'correct horse battery staple';
// Картинка 1×1: обложка в _media и такая же вне папки игр — для проверки выхода за её пределы
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const outside = path.join(os.tmpdir(), `${path.basename(root)}-outside.png`);

let server;
let port;
let cookie = '';

// Запрос модулем http, а не fetch: так можно поставить любые заголовки, в том числе Sec-Fetch-Site
function call(method, urlPath, { headers = {}, json, auth = true, raw: rawBody } = {}) {
    return new Promise((resolve, reject) => {
        const body = rawBody !== undefined ? rawBody : json === undefined ? undefined : JSON.stringify(json);
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method,
            headers: {
                ...(body === undefined ? {} : { 'content-type': rawBody !== undefined ? 'image/jpeg' : 'application/json', 'content-length': Buffer.byteLength(body) }),
                ...(auth && cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                let data = null;
                try { data = JSON.parse(raw.toString()); } catch {}
                resolve({ status: res.statusCode, headers: res.headers, raw, data });
            });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

const cookieFrom = (res) => {
    const line = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${COOKIE}=`)) || '';
    return { value: line.split(';')[0].slice(COOKIE.length + 1), line };
};

const login = async (password = PASS) => call('POST', '/api/login', { json: { username: USER, password }, auth: false });

test.before(async () => {
    // Сеть в этих тестах не нужна: если какой-то путь всё же пойдёт наружу — пусть падает сразу
    globalThis.fetch = async () => { throw new Error('сеть в тестах HTTP-слоя не используется'); };
    await redisClient.flushDb().catch(() => {});
    await dbService.init(root);

    // Игра — папка и строка в базе с уже найденными данными: поиск данных здесь не нужен
    fs.mkdirSync(path.join(root, GAME, 'www', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, GAME, 'www', 'index.html'), '<!doctype html><title>Test</title>');
    fs.writeFileSync(path.join(root, GAME, 'www', 'data', 'System.json'), JSON.stringify({ gameTitle: 'Test Game' }));
    fs.mkdirSync(path.join(root, '_media', GAME), { recursive: true });
    fs.writeFileSync(path.join(root, '_media', GAME, 'cover-0123456789.png'), PNG);
    fs.writeFileSync(outside, PNG);
    await dbService.get().run(
        `INSERT INTO games (id, title, cover, tags, description, rating, lastPlayed, addedAt, scraped, ready, size, meta_status)
         VALUES (?, 'Test Game', ?, '[]', '', 0, 0, ?, 1, 1, 1024, 'ok')`,
        [GAME, `_media/${GAME}/cover-0123456789.png`, Date.now()]
    );

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    port = server.address().port;
});

test.after(async () => {
    server?.close();
    await redisClient.flushDb().catch(() => {});
    await dbService.get().close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
});

test('вход: учётная запись создаётся один раз, без куки закрыто всё, кроме входа', async () => {
    assert.deepStrictEqual((await call('GET', '/api/setup/status')).data, { initialized: false });
    assert.strictEqual((await call('POST', '/api/setup/init', { json: { username: USER, password: '123' } })).status, 400, 'короткий пароль');
    assert.strictEqual((await call('POST', '/api/setup/init', { json: { username: USER, password: PASS } })).status, 200);
    assert.strictEqual((await call('POST', '/api/setup/init', { json: { username: 'intruder', password: PASS } })).status, 403, 'второй раз — нет');
    assert.deepStrictEqual((await call('GET', '/api/setup/status')).data, { initialized: true });

    for (const [method, url] of [['GET', '/api/games'], ['GET', '/api/backup'], ['GET', `/api/saves/${GAME}`], ['POST', `/api/play/${GAME}`], ['GET', '/api/storage'], ['POST', '/api/check']]) {
        assert.strictEqual((await call(method, url)).status, 401, `${method} ${url} без входа`);
    }

    assert.strictEqual((await login('wrong password')).status, 401);
    const ok = await login();
    assert.strictEqual(ok.status, 200);
    const { value, line } = cookieFrom(ok);
    assert.ok(value.length >= 64, 'кука с ключом сессии');
    assert.match(line, /HttpOnly/i, 'скрипт страницы куку не прочитает');
    assert.match(line, /SameSite=Lax/i);
    cookie = value;

    const list = await call('GET', '/api/games');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.data.map((g) => [g.id, g.displayTitle]), [[GAME, 'Test Game']]);
});

test('API отвечает только страницам библиотеки: страница игры и чужой сайт получают 403', async () => {
    const games = (headers) => call('GET', '/api/games', { headers }).then((r) => r.status);
    assert.strictEqual(await games({ 'sec-fetch-site': 'same-origin' }), 200);
    assert.strictEqual(await games({ 'sec-fetch-site': 'none' }), 200, 'адрес набран руками');
    assert.strictEqual(await games({}), 200, 'не браузер (curl): заголовков нет, но и чужого кода нет');
    assert.strictEqual(await games({ 'sec-fetch-site': 'same-site' }), 403, 'сервер игр — тот же хост, другой порт');
    assert.strictEqual(await games({ 'sec-fetch-site': 'cross-site' }), 403);
    // Старый браузер без Sec-Fetch-Site: смотрим Origin
    assert.strictEqual(await games({ origin: 'http://127.0.0.1:8081' }), 403, 'Origin с порта игр');
    assert.strictEqual(await games({ origin: `http://127.0.0.1:${port}` }), 200);
    // Проверка стоит раньше входа: чужой сайт не может даже попробовать войти от имени посетителя
    const fromOtherSite = await call('POST', '/api/login', { json: { username: USER, password: PASS }, auth: false, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.strictEqual(fromOtherSite.status, 403);
});

test('id игры в адресе: точки и слэши не проходят ни в один маршрут', async () => {
    assert.strictEqual((await call('DELETE', '/api/games/%2e%2e')).status, 400);
    assert.strictEqual((await call('DELETE', '/api/games/..%2F..%2Fetc')).status, 400);
    assert.strictEqual((await call('POST', '/api/games/%2e%2e/meta', { json: { rating: 5 } })).status, 400);
    assert.strictEqual((await call('GET', '/api/saves/%2e%2e')).status, 400);
    assert.strictEqual((await call('GET', '/api/saves/.history')).status, 400, 'служебная папка сейвов');
    assert.strictEqual((await call('POST', '/api/play/%2e%2e')).status, 404);
    assert.strictEqual((await call('POST', '/api/play/_saves')).status, 404, 'служебная папка — не игра');
    // Ничего не удалилось: ни папка игр, ни база
    assert.ok(fs.existsSync(path.join(root, 'library.db')));
    assert.ok(fs.existsSync(path.join(root, GAME, 'www', 'index.html')));
});

test('тело запроса: больше 1 МБ — 413 до любого маршрута; сейвам можно больше', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    assert.strictEqual((await call('POST', `/api/games/${GAME}/meta`, { json: { status: big } })).status, 413);

    const saved = await call('POST', `/api/saves/${GAME}/${encodeURIComponent('RPG File1')}`, { json: { value: big, updatedAt: Date.now() } });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.data, { success: true });
    const saves = await call('GET', `/api/saves/${GAME}`);
    assert.strictEqual(saves.data['RPG File1'].value.length, big.length);
    assert.strictEqual((await call('POST', `/api/saves/${GAME}/x`, { json: { value: 42 } })).status, 400, 'сейв — только строка');
});

test('статус и оценка игры: только допустимые значения, изменения сразу видны в списке', async () => {
    assert.strictEqual((await call('POST', `/api/games/${GAME}/meta`, { json: { status: 'evil' } })).status, 400);
    assert.strictEqual((await call('POST', `/api/games/${GAME}/meta`, { json: { status: 'done', rating: 4 } })).status, 200);
    const game = (await call('GET', '/api/games')).data.find((g) => g.id === GAME);
    assert.deepStrictEqual([game.status, game.rating], ['done', 4], 'кэш списка сброшен');
    assert.strictEqual((await call('POST', '/api/games/Nope/meta', { json: { rating: 1 } })).status, 404);
});

test('файлы: картинки — только со входом и только из папки игр, код игры с адреса библиотеки не отдаётся', async () => {
    const coverUrl = `/_media/${GAME}/cover-0123456789.png`;
    assert.strictEqual((await call('GET', coverUrl, { auth: false })).status, 401);
    const cover = await call('GET', coverUrl);
    assert.strictEqual(cover.status, 200);
    assert.match(cover.headers['content-type'], /^image\/png/);
    assert.strictEqual(cover.headers['x-content-type-options'], 'nosniff');
    assert.ok(cover.raw.equals(PNG));

    // Картинка рядом с папкой игр — за её пределами: не отдаём
    assert.strictEqual((await call('GET', `/..%2F${path.basename(outside)}`)).status, 403);

    // Страница игры с адреса библиотеки не открывается: её код запустился бы со входом в библиотеку
    const page = await call('GET', `/${GAME}/www/index.html`);
    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.location, `/?play=${GAME}`);

    const play = await call('POST', `/api/play/${GAME}`);
    assert.strictEqual(play.data.mode, 'frame');
    assert.strictEqual(play.data.port, '8081');
    assert.match(play.data.path, new RegExp(`^/g/[0-9a-f]{32}/${GAME}/$`));
    assert.strictEqual((await call('POST', '/api/play/Nope')).status, 404);
});

test('обложка: какая вернётся вместо своей, видно заранее и без изменений; сброс ставит именно её', async () => {
    const custom = `_media/${GAME}/cover_custom_1.png`;
    const found = `_media/${GAME}/cover-abcdef0123.jpg`;
    const coverNow = async () => (await dbService.get().get('SELECT cover FROM games WHERE id = ?', [GAME])).cover;
    const before = await coverNow();
    fs.writeFileSync(path.join(root, custom), PNG);
    fs.writeFileSync(path.join(root, found), PNG);
    await dbService.get().run('UPDATE games SET cover = ? WHERE id = ?', [custom, GAME]);
    try {
        const peek = await call('GET', `/api/games/${GAME}/cover/found`);
        assert.deepStrictEqual([peek.status, peek.data.coverPath], [200, found]);
        assert.strictEqual(await coverNow(), custom, 'в базе — по-прежнему своя');
        assert.ok(fs.existsSync(path.join(root, custom)), 'своя обложка на месте');
        assert.strictEqual((await call('GET', '/api/games/Nope/cover/found')).status, 404);

        const reset = await call('DELETE', `/api/games/${GAME}/cover`);
        assert.deepStrictEqual([reset.status, reset.data.coverPath], [200, found]);
        assert.strictEqual(await coverNow(), found);
        assert.ok(!fs.existsSync(path.join(root, custom)), 'своя обложка удалена');
    } finally {
        fs.rmSync(path.join(root, custom), { force: true });
        fs.rmSync(path.join(root, found), { force: true });
        await dbService.get().run('UPDATE games SET cover = ? WHERE id = ?', [before, GAME]);
        await redisClient.flushDb().catch(() => {});
    }
});

test('полная проверка: до первой — пустой итог; запуск и отмена отвечают сразу, ход — по сокету', async (t) => {
    assert.deepStrictEqual((await call('GET', '/api/check')).data, { running: false, steps: [] });
    // Саму проверку здесь не запускаем: она пошла бы в сеть и по очереди поиска. Шаги — в server.test.js
    const fullCheck = require('./src/services/fullcheck.js');
    const start = t.mock.method(fullCheck, 'start', async () => ({ running: true, steps: [] }));
    const res = await call('POST', '/api/check');
    assert.deepStrictEqual([res.status, res.data.running, start.mock.callCount()], [200, true, 1]);
    const cancel = t.mock.method(fullCheck, 'cancel', async () => ({ running: true, cancelling: true, steps: [] }));
    const stop = await call('POST', '/api/check/cancel');
    assert.deepStrictEqual([stop.status, stop.data.cancelling, cancel.mock.callCount()], [200, true, 1]);
    assert.strictEqual((await call('POST', '/api/check/cancel', { auth: false })).status, 401);
});

test('смена пароля: нужен прежний; другие устройства выходят, это остаётся со входом', async () => {
    const NEW = 'another long passphrase';
    assert.strictEqual((await call('POST', '/api/account/password', { json: { current: PASS, next: NEW }, auth: false })).status, 401, 'без входа — нет');
    assert.strictEqual((await call('POST', '/api/account/password', { json: { current: 'wrong', next: NEW } })).status, 401, 'прежний неверный');
    assert.strictEqual((await call('POST', '/api/account/password', { json: { current: PASS, next: '12' } })).status, 400, 'короткий');
    const old = cookie;
    const res = await call('POST', '/api/account/password', { json: { current: PASS, next: NEW } });
    assert.deepStrictEqual([res.status, res.data.otherDevicesSignedOut], [200, true]);
    cookie = cookieFrom(res).value;
    assert.notStrictEqual(cookie, old);
    assert.strictEqual((await call('GET', '/api/games')).status, 200, 'это устройство — со входом');
    assert.strictEqual((await call('GET', '/api/games', { headers: { cookie: `${COOKIE}=${old}` }, auth: false })).status, 401, 'прежняя кука — нет');
    assert.strictEqual((await login(NEW)).status, 200);
    // Вернуть как было — следующим проверкам нужен прежний пароль
    const back = await call('POST', '/api/account/password', { json: { current: NEW, next: PASS } });
    cookie = cookieFrom(back).value;
    assert.strictEqual(back.status, 200);
});

test('настройки: ключ ScraperAPI — в базе, наружу только хвост; пустой — убрать', async (t) => {
    // Ключ из .env главнее: с ним поле в настройках только для чтения
    const envKey = process.env.SCRAPER_API_KEY;
    t.after(() => { if (envKey === undefined) delete process.env.SCRAPER_API_KEY; else process.env.SCRAPER_API_KEY = envKey; });
    process.env.SCRAPER_API_KEY = 'fromenv0123456789zz';
    assert.deepStrictEqual((await call('GET', '/api/settings')).data.scraper, { set: true, fromEnv: true, tail: '89zz' });
    assert.strictEqual((await call('POST', '/api/settings/scraper', { json: { key: 'abcdef0123456789abcd' } })).status, 409);
    delete process.env.SCRAPER_API_KEY;
    assert.deepStrictEqual((await call('GET', '/api/settings')).data.scraper, { set: false, fromEnv: false, tail: '' });
    assert.strictEqual((await call('POST', '/api/settings/scraper', { json: { key: 'not a key!' } })).status, 400);
    const saved = await call('POST', '/api/settings/scraper', { json: { key: 'abcdef0123456789abcd' } });
    assert.deepStrictEqual(saved.data.scraper, { set: true, fromEnv: false, tail: 'abcd' });
    assert.ok(!JSON.stringify(saved.data).includes('abcdef0123'), 'ключ целиком не отдаём');
    // В базе — зашифрованным: файл базы отдельно от ключа шифрования ключа не выдаёт
    const stored = (await dbService.get().get("SELECT value FROM settings WHERE key = 'scraper_api_key'")).value;
    assert.ok(stored.startsWith('enc1:') && !stored.includes('abcdef0123'), 'в базе не открытым текстом');
    const { unseal } = require('./src/utils/secrets.js');
    assert.strictEqual(unseal(stored, 'scraper_api_key'), 'abcdef0123456789abcd');
    assert.strictEqual(unseal(stored, 'telegram_bot_token'), null, 'шифр привязан к строке: в другую не подложить');
    assert.deepStrictEqual((await call('POST', '/api/settings/scraper', { json: { key: '' } })).data.scraper.set, false);
    assert.match((await call('GET', '/api/settings')).data.version, /^\d+\.\d+\.\d+$/);
});

test('настройки: MyJDownloader — форма с сохранённым; устройство и папку меняем без пароля, если почта та же', async (t) => {
    const myjd = require('./src/services/myjd.js');
    const seen = [];
    t.mock.method(myjd, 'check', async (v) => { seen.push(JSON.parse(v)); return { ok: true }; });
    const env = process.env.MYJD_LOGIN;
    delete process.env.MYJD_LOGIN;
    t.after(async () => { await call('POST', '/api/settings/myjd', { json: { key: '' } }); if (env !== undefined) process.env.MYJD_LOGIN = env; });
    const first = await call('POST', '/api/settings/myjd', { json: { key: JSON.stringify({ email: 'Me@x.org', password: 'pw', device: 'server', folder: '/output' }) } });
    assert.deepStrictEqual(first.data.myjd, { set: true, fromEnv: false, tail: '', email: 'Me@x.org', device: 'server', folder: '/output' });
    const moved = await call('POST', '/api/settings/myjd', { json: { key: JSON.stringify({ email: 'me@x.org', device: 'mac', folder: '/output/mac' }) } });
    assert.strictEqual(moved.status, 200);
    assert.deepStrictEqual([moved.data.myjd.device, moved.data.myjd.folder], ['mac', '/output/mac']);
    assert.ok(seen[1].loginSecret === seen[0].loginSecret && seen[1].deviceSecret === seen[0].deviceSecret, 'вход — прежний, проверен с новым устройством');
    assert.ok(!JSON.stringify(moved.data).includes(seen[0].loginSecret), 'суммы для входа наружу не отдаём');
    assert.strictEqual((await call('POST', '/api/settings/myjd', { json: { key: JSON.stringify({ email: 'other@x.org', device: 'mac' }) } })).status, 400, 'другая почта — без пароля нельзя');
});

test('настройки: параметры из .env — и на сайте; помощник обновлений — зашифрованным; что только на сервере — без секретов', async (t) => {
    const env = process.env.DISK_WARN_GB;
    t.after(() => { if (env === undefined) delete process.env.DISK_WARN_GB; else process.env.DISK_WARN_GB = env; });
    delete process.env.DISK_WARN_GB;
    assert.strictEqual((await call('GET', '/api/settings')).data.options.disk_warn_gb.value, 10);
    assert.strictEqual((await call('POST', '/api/settings/options', { json: { name: 'disk_warn_gb', value: 'много' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/settings/options', { json: { name: 'nope', value: 1 } })).status, 404);
    const ok = await call('POST', '/api/settings/options', { json: { name: 'disk_warn_gb', value: 25 } });
    assert.strictEqual(ok.data.options.disk_warn_gb.value, 25);
    assert.strictEqual((await dbService.get().get("SELECT value FROM settings WHERE key = 'disk_warn_gb'")).value, '25');
    process.env.DISK_WARN_GB = '7';
    assert.strictEqual((await call('POST', '/api/settings/options', { json: { name: 'disk_warn_gb', value: 30 } })).status, 409, 'в .env — менять там');
    delete process.env.DISK_WARN_GB;
    assert.strictEqual((await call('POST', '/api/settings/options', { json: { name: 'disk_warn_gb', value: null } })).data.options.disk_warn_gb.value, 10);

    assert.strictEqual((await call('POST', '/api/settings/updater', { json: { key: JSON.stringify({ url: 'http://user:pw@helper/v1/update', token: 't' }) } })).status, 400, 'логин в адресе — нет');
    for (const url of ['ftp://helper/v1/update', 'http://helper/v1/update?token=x', 'http://helper/v1#x']) {
        assert.strictEqual((await call('POST', '/api/settings/updater', { json: { key: JSON.stringify({ url, token: 't' }) } })).status, 400, url);
    }
    // Проверка обновлений: выкл и вкл — булевым из интерфейса
    assert.strictEqual((await call('POST', '/api/settings/options', { json: { name: 'update_check', value: false } })).data.options.update_check.value, false);
    assert.strictEqual((await dbService.get().get("SELECT value FROM settings WHERE key = 'update_check'")).value, 'false');
    assert.strictEqual((await call('POST', '/api/settings/options', { json: { name: 'update_check', value: true } })).data.options.update_check.value, true);
    assert.strictEqual((await call('POST', '/api/settings/options', { json: { name: 'update_check', value: null } })).status, 200);
    const saved = await call('POST', '/api/settings/updater', { json: { key: JSON.stringify({ url: 'http://mimikin-update:8080/v1/update', token: 'tok123' }) } });
    assert.deepStrictEqual(saved.data.updater, { set: true, fromEnv: false, tail: '' });
    assert.ok((await dbService.get().get("SELECT value FROM settings WHERE key = 'update_helper'")).value.startsWith('enc1:'));
    assert.strictEqual((await call('POST', '/api/settings/updater', { json: { key: '' } })).data.updater.set, false);

    const srv = (await call('GET', '/api/settings/server')).data;
    assert.ok(['env', 'file'].includes(srv.secretsKey) && typeof srv.isolation === 'boolean');
    assert.ok(!JSON.stringify(srv).includes('redis://'), 'адрес Redis (в нём бывает пароль) не отдаём');
});

test('«Загрузить»: в JDownloader — только известные файлообменники, собранные сервером; ключ записи — только свой вид', async () => {
    const bad = [{}, { url: 123 }, { url: 'https://evil.example/post/' }, { url: 'http://mega.nz/file/a#b' }, { url: 'https://user:pw@mega.nz/file/a' },
        { url: 'https://store.steampowered.com/app/1' }, { url: 'https://moon-studio.itch.io/y' }];
    for (const body of bad) assert.strictEqual((await call('POST', '/api/downloads', { json: body })).status, 400, JSON.stringify(body));
    assert.strictEqual((await call('POST', '/api/downloads', { auth: false, json: { url: 'https://mega.nz/file/AbCd#Key' } })).status, 401, 'без входа закрыто');
    // Годный адрес, а MyJDownloader не настроен — «сначала подключите»
    for (const body of [{ url: 'https://mega.nz/file/AbCd#Key' }, { url: 'https://mega.nz/file/AbCd#Key', title: 'Lantern Witch', version: 'v1.2', game: 'Own_Game' }]) {
        const r = await call('POST', '/api/downloads', { json: body });
        assert.deepStrictEqual([r.status, r.data.reason], [409, 'off'], JSON.stringify(body));
    }
    assert.strictEqual((await call('DELETE', '/api/downloads/link:0123456789ab')).status, 200);
    assert.strictEqual((await call('DELETE', '/api/downloads/link:xyz')).status, 400);
    assert.strictEqual((await call('DELETE', '/api/downloads/evil:1')).status, 400);
    assert.strictEqual((await call('POST', '/api/downloads/evil:1/retry')).status, 400);
});

test('настройки: токен бота, пароль копий — проверка на сайте, хвост, в копию не попадают', async (t) => {
    const { secret } = require('./src/utils/secrets.js');
    const envs = ['TELEGRAM_BOT_TOKEN', 'BACKUP_PASSWORD'];
    const prev = Object.fromEntries(envs.map((k) => [k, process.env[k]]));
    t.after(() => { for (const k of envs) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
    envs.forEach((k) => delete process.env[k]);
    // Сайт в тесте не настоящий: Telegram принимает только токен с «GOOD»
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
        const u = String(url);
        if (u.includes('api.telegram.org')) {
            const ok = u.includes('GOOD');
            return { ok, status: ok ? 200 : 401, json: async () => (ok ? { ok: true, result: { username: 'mimikin_test_bot' } } : { ok: false }) };
        }
        return realFetch(url, opts);
    });

    const tokenBad = `123456789:${'a'.repeat(35)}`;
    assert.strictEqual((await call('POST', '/api/settings/telegram', { json: { key: tokenBad } })).data.reason, 'refused');
    assert.strictEqual((await call('POST', '/api/settings/telegram', { json: { key: 'nope' } })).data.reason, 'bad');
    const tokenGood = `123456789:GOOD${'b'.repeat(31)}`;
    const tg = await call('POST', '/api/settings/telegram', { json: { key: tokenGood } });
    assert.deepStrictEqual([tg.status, tg.data.telegram.tail], [200, 'bbbb']);
    assert.strictEqual(require('./src/services/telegram.js').token, tokenGood, 'бот берёт токен из настроек без перезапуска');

    assert.strictEqual((await call('POST', '/api/settings/backup', { json: { key: 'short' } })).status, 400);
    const pass = await call('POST', '/api/settings/backup', { json: { key: 'long-enough-pass' } });
    assert.deepStrictEqual(pass.data.backup, { set: true, fromEnv: false, tail: '' }, 'хвост пароля не показываем');
    assert.ok(!JSON.stringify(pass.data).includes('long-enough') && !JSON.stringify(tg.data).includes('GOOD'), 'наружу значения не уходят');

    // Из .env — главнее, из настроек не поменять
    process.env.BACKUP_PASSWORD = 'from-env-password';
    assert.strictEqual((await call('POST', '/api/settings/backup', { json: { key: 'other-password' } })).status, 409);
    assert.strictEqual(secret('backup'), 'from-env-password');
    delete process.env.BACKUP_PASSWORD;
    assert.strictEqual((await call('POST', '/api/settings/nope', { json: { key: 'x' } })).status, 404);

    // В резервной копии этих ключей нет
    const { PRIVATE_SETTINGS } = require('./src/routes/backup.js');
    for (const key of ['telegram_bot_token', 'backup_password', 'scraper_api_key']) assert.ok(PRIVATE_SETTINGS.includes(key), key);

    for (const name of ['telegram', 'backup']) assert.strictEqual((await call('POST', `/api/settings/${name}`, { json: { key: '' } })).data[name].set, false);
    assert.strictEqual(secret('telegram'), '');
});

test('настройки: любимые теги — маленькими буквами, без повторов, не больше 20', async () => {
    assert.deepStrictEqual((await call('GET', '/api/settings/favorite-tags')).data, { tags: [] });
    const many = Array.from({ length: 30 }, (_, i) => `tag ${i}`);
    const saved = await call('POST', '/api/settings/favorite-tags', { json: { tags: ['Pixel Art', 'pixel art', ' COZY ', '', 'x'.repeat(41), ...many] } });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.data.tags.slice(0, 3), ['pixel art', 'cozy', 'tag 0']);
    assert.strictEqual(saved.data.tags.length, 20);
    assert.strictEqual((await call('POST', '/api/settings/favorite-tags', { json: { tags: 'cozy' } })).status, 400);
    assert.deepStrictEqual((await call('POST', '/api/settings/favorite-tags', { json: { tags: [] } })).data.tags, []);
});

test('заголовки: сервер не называет себя, браузер не угадывает тип ответа', async () => {
    const res = await call('GET', '/api/setup/status');
    assert.strictEqual(res.headers['x-powered-by'], undefined);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
});

test('база: журнал WAL и ожидание, если базу держит кто-то ещё', async () => {
    const db = dbService.get();
    assert.strictEqual((await db.get('PRAGMA journal_mode')).journal_mode, 'wal');
    assert.strictEqual((await db.get('PRAGMA busy_timeout')).timeout, 5000);
    // Второе соединение — как sqlite3 из консоли или ночная копия: читает, пока сервер пишет
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const other = await open({ filename: path.join(root, 'library.db'), driver: sqlite3.Database });
    try {
        await other.exec('BEGIN');
        assert.strictEqual((await other.get('SELECT COUNT(*) AS n FROM games')).n, 1);
        await db.run("UPDATE games SET rating = 5 WHERE id = ?", [GAME]);
        assert.strictEqual((await other.get('SELECT rating FROM games WHERE id = ?', [GAME])).rating, 4, 'читатель видит свой снимок');
        await other.exec('COMMIT');
        assert.strictEqual((await other.get('SELECT rating FROM games WHERE id = ?', [GAME])).rating, 5);
    } finally {
        await other.close();
    }
});

test('резервная копия: файл архива, отдаётся только со входом', { skip: !hasSevenZip() && 'нет 7zz' }, async () => {
    assert.strictEqual((await call('GET', '/api/backup', { auth: false })).status, 401);
    const res = await call('GET', '/api/backup');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-disposition'], /attachment; filename="mimikin-backup_[\d_-]+\.zip"/);
    assert.strictEqual(res.raw.subarray(0, 2).toString(), 'PK', 'zip');
});

// Тело multipart/form-data с одним файлом — как его шлёт браузер
const multipart = (field, name, data) => {
    const boundary = `----rpgtest${Date.now()}`;
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length } };
};
function upload(urlPath, field, name, data) {
    const { body, headers } = multipart(field, name, data);
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { ...headers, cookie: `${COOKIE}=${cookie}` } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let data = null;
                try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
                resolve({ status: res.statusCode, data });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

test('корзина: удалённая игра лежит 30 дней со всеми данными, вернуть можно, если имя свободно', async () => {
    const ID = 'Trash_Game';
    const dir = path.join(root, ID);
    fs.mkdirSync(path.join(dir, 'www'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'www', 'index.html'), 'x');
    await dbService.get().run("INSERT INTO games (id, title, rating, playtime, addedAt, ready) VALUES (?, 'Trash Game', 4, 600, 1, 1)", [ID]);

    const del = await call('DELETE', `/api/games/${ID}`);
    assert.strictEqual(del.status, 200);
    const key = del.data.trashKey;
    assert.match(key, /^\d{13}-Trash_Game$/);
    assert.ok(!fs.existsSync(dir), 'из библиотеки ушла');
    assert.ok(fs.existsSync(path.join(root, '_trash', key, 'game', 'www', 'index.html')), 'а в корзине целая');
    assert.ok(!(await call('GET', '/api/games')).data.some((g) => g.id === ID));
    const listed = (await call('GET', '/api/games/trash')).data.items.find((i) => i.key === key);
    assert.deepStrictEqual([listed.title, listed.playtime, listed.taken], ['Trash Game', 600, false]);

    // Под тем же именем загрузили другую — вернуть нельзя, ни одну не трогаем
    fs.mkdirSync(dir);
    assert.strictEqual((await call('POST', `/api/games/trash/${key}/restore`)).status, 409);
    fs.rmdirSync(dir);

    assert.strictEqual((await call('POST', `/api/games/trash/${key}/restore`)).status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'www', 'index.html')));
    const back = await dbService.get().get('SELECT title, rating, playtime FROM games WHERE id = ?', [ID]);
    assert.deepStrictEqual({ ...back }, { title: 'Trash Game', rating: 4, playtime: 600 });
    assert.ok(!fs.existsSync(path.join(root, '_trash', key)));

    // Стереть навсегда; чужие имена — 404
    const again = (await call('DELETE', `/api/games/${ID}`)).data.trashKey;
    assert.strictEqual((await call('DELETE', '/api/games/trash/..')).status, 404);
    assert.strictEqual((await call('DELETE', '/api/games/trash/123-x')).status, 404);
    assert.strictEqual((await call('DELETE', `/api/games/trash/${again}`)).status, 200);
    assert.ok(!fs.existsSync(path.join(root, '_trash', again)));
});

test('корзина: через 30 дней запись стирается сама, раньше — нет', async () => {
    const { trash } = require('./src/routes/games.js');
    const ID = 'Old_Trash';
    fs.mkdirSync(path.join(root, ID));
    await dbService.get().run("INSERT INTO games (id, title) VALUES (?, 'Old')", [ID]);
    const t0 = Date.now();
    const { key } = await trash.trashGame(ID, t0);
    assert.strictEqual(await trash.purge(t0 + 29 * 864e5), 0);
    assert.ok(fs.existsSync(path.join(root, '_trash', key)));
    assert.strictEqual(await trash.purge(t0 + 31 * 864e5), 1);
    assert.ok(!fs.existsSync(path.join(root, '_trash', key)));
});

test('восстановление из копии: данные игр и сейвы — из копии, нынешние — в корзину и историю, вход прежний', { skip: !hasSevenZip() && 'нет 7zz' }, async () => {
    const db = dbService.get();
    const slot = path.join(root, '_saves', GAME, `${encodeURIComponent('RPG File1')}.json`);
    fs.mkdirSync(path.dirname(slot), { recursive: true });
    await db.run("UPDATE games SET rating = 2, status = 'playing' WHERE id = ?", [GAME]);
    fs.writeFileSync(slot, 'A');
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('restore_probe', 'old')");
    const backup = await call('GET', '/api/backup');
    assert.strictEqual(backup.status, 200);

    // После копии всё поменялось
    await db.run("UPDATE games SET rating = 5, status = 'completed' WHERE id = ?", [GAME]);
    fs.writeFileSync(slot, 'B');
    await db.run("UPDATE settings SET value = 'new' WHERE key = 'restore_probe'");
    const passBefore = (await db.get("SELECT value FROM settings WHERE key = 'admin_pass'")).value;

    assert.strictEqual((await upload('/api/backup/restore', 'backup', 'junk.zip', Buffer.from('not a zip'))).status, 400);
    const res = await upload('/api/backup/restore', 'backup', 'copy.zip', backup.raw);
    assert.strictEqual(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.games >= 1);
    assert.ok(res.data.saves >= 1);

    assert.deepStrictEqual({ ...(await db.get('SELECT rating, status FROM games WHERE id = ?', [GAME])) }, { rating: 2, status: 'playing' });
    assert.strictEqual(fs.readFileSync(slot, 'utf8'), 'A');
    const hist = fs.readdirSync(path.join(root, '_saves', '.history', GAME, encodeURIComponent('RPG File1')));
    assert.ok(hist.some((f) => /-import\.json$/.test(f)), 'сейв «B» — в истории');
    assert.strictEqual((await db.get("SELECT value FROM settings WHERE key = 'restore_probe'")).value, 'old');
    assert.strictEqual((await db.get("SELECT value FROM settings WHERE key = 'admin_pass'")).value, passBefore, 'пароль — нынешний');
    assert.strictEqual((await call('GET', '/api/games')).status, 200, 'вход — прежний');
    assert.ok(fs.existsSync(path.join(root, '_trash', res.data.keptKey, path.basename(fs.readdirSync(path.join(root, '_trash', res.data.keptKey)).find((f) => f.endsWith('.db'))))), 'прежняя база — в корзине');
});

test('выход без входа ничего не меняет: чужой не выведет владельца', async () => {
    assert.strictEqual((await call('POST', '/api/logout', { auth: false })).status, 401);
    assert.strictEqual((await call('GET', '/api/games')).status, 200, 'кука владельца работает');
});

test('выход меняет ключ сессии: прежняя кука больше не работает нигде', async () => {
    const out = await call('POST', '/api/logout');
    assert.deepStrictEqual(out.data, { success: true, allDevices: true });
    assert.strictEqual((await call('GET', '/api/games')).status, 401, 'старая кука');
    const again = await login();
    assert.strictEqual(again.status, 200);
    const fresh = cookieFrom(again).value;
    assert.notStrictEqual(fresh, cookie);
    cookie = fresh;
    assert.strictEqual((await call('GET', '/api/games')).status, 200);
});

test('галерея: файлы модели Live2D отдаются только из перечня оглавления; регистр не важен; ?max= ужимает лист и принимает лишь свои числа', async () => {
  const game = path.join(root, 'Live2D_Game', 'www');
  const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true }); fs.writeFileSync(path.join(game, rel), data); };
  // Настоящий PNG 3000×1000 (его ужимает ffmpeg); нет ffmpeg — эту часть пропускаем
  const big = path.join(root, 'big.png');
  const made = require('child_process').spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=3000x1000', '-frames:v', '1', big]);
  put('data/System.json', '{}');
  put('js/plugins.js', 'var $plugins = [{ name: "PictureLive2D", status: true, parameters: { "json file": "[\\"hero/hero\\"]" } }];');
  put('js/libs/live2dcubismcore.min.js', '/* MocVersion_40 MocVersion_50 */');
  put('img/live2d/hero/hero.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'hero.moc3', Textures: ['hero.2048/texture_00.png'], Motions: { Idle: [{ File: 'idle.motion3.json' }] } } }));
  put('img/live2d/hero/hero.moc3', Buffer.concat([Buffer.from('MOC3'), Buffer.from([5]), Buffer.alloc(16)]));
  put('img/live2d/hero/idle.motion3.json', '{}');
  fs.mkdirSync(path.join(game, 'img', 'live2d', 'hero', 'hero.2048'), { recursive: true });
  if (made.status === 0) fs.copyFileSync(big, path.join(game, 'img', 'live2d', 'hero', 'hero.2048', 'texture_00.png'));
  else fs.writeFileSync(path.join(game, 'img', 'live2d', 'hero', 'hero.2048', 'texture_00.png'), PNG);
  put('img/live2d/other/other.model3.json', '{}'); // вне списка плагина
  put('secret.txt', 'x');
  const gallery = require('./src/services/gallery.js');
  await gallery.forget('Live2D_Game');
  await gallery.build('Live2D_Game').promise;
  const url = (f, q = '') => `/api/gallery/Live2D_Game/live2d?f=${encodeURIComponent(f)}${q}`;
  const model = await call('GET', url('img/live2d/hero/hero.model3.json'));
  assert.deepStrictEqual([model.status, model.headers['content-type'], model.headers['x-content-type-options']], [200, 'application/json', 'nosniff']);
  assert.strictEqual((await call('GET', url('img/live2d/hero/hero.moc3'))).headers['content-type'], 'application/octet-stream');
  assert.strictEqual((await call('GET', url('IMG/Live2D/HERO/Hero.Moc3'))).status, 200, 'регистр букв не важен');
  assert.strictEqual((await call('GET', url('js/libs/live2dcubismcore.min.js'))).headers['content-type'], 'text/javascript; charset=utf-8');
  // Всё остальное в игре — 404, в том числе пути с обходом и чужие id
  for (const bad of ['data/System.json', 'secret.txt', 'js/plugins.js', 'img/live2d/other/other.model3.json', 'img/live2d/hero/../../../data/System.json', 'img/live2d/hero/%2e%2e/%2e%2e/secret.txt', '/etc/passwd', 'img/live2d/hero/hero.moc3\0', '']) {
    assert.strictEqual((await call('GET', url(bad))).status, 404, JSON.stringify(bad));
  }
  assert.strictEqual((await call('GET', `/api/gallery/${GAME}/live2d?f=${encodeURIComponent('img/live2d/hero/hero.moc3')}`)).status, 404, 'файл другой игры не отдаём');
  assert.strictEqual((await call('GET', `/api/gallery/..%2F${GAME}/live2d?f=x`)).status, 404);
  assert.strictEqual((await call('GET', url('img/live2d/hero/hero.moc3'), { auth: false })).status, 401);
  if (made.status !== 0) return;
  // Ужатие: лист 3000×1000 при max=1024 — 1024 по длинной стороне, копия одна; чужие числа — исходный файл
  const tex = 'img/live2d/hero/hero.2048/texture_00.png';
  const size = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  assert.deepStrictEqual(size((await call('GET', url(tex, '&max=1024'))).raw), [1024, 341]);
  assert.deepStrictEqual(size((await call('GET', url(tex, '&max=2048'))).raw), [2048, 683]);
  assert.deepStrictEqual(size((await call('GET', url(tex, '&max=4096'))).raw), [3000, 1000], 'лист меньше max — как есть');
  for (const q of ['&max=1000', '&max=abc', '&max=0', '&max=-1024', '&max=1024.5', '&max=1024&max=2048', '&max=']) {
    assert.deepStrictEqual(size((await call('GET', url(tex, q))).raw), [3000, 1000], q);
  }
  assert.strictEqual(fs.readdirSync(path.join(gallery.mediaDir, 'Live2D_Game', 'live2d')).filter((n) => n.endsWith('.png')).length, 2, 'по копии на каждый размер');
});

test('галерея: обложка плитки Live2D — PUT только JPEG и только для набора из оглавления, первая остаётся, в оглавлении отмечена', async () => {
  const gallery = require('./src/services/gallery.js');
  const key = (await call('GET', '/api/gallery/Live2D_Game')).data.albums.find((a) => a.live2d).key;
  const put = (k, body, opts) => call('PUT', `/api/gallery/Live2D_Game/rig-cover?key=${encodeURIComponent(k)}`, { raw: body, ...opts });
  const get = (k, id = 'Live2D_Game') => call('GET', `/api/gallery/${id}/rig-cover?key=${encodeURIComponent(k)}`);
  const jpeg = (n, tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag), Buffer.alloc(n)]);
  const flag = async () => (await call('GET', '/api/gallery/Live2D_Game')).data.albums.find((a) => a.key === key).rigCover;
  fs.rmSync(path.join(gallery.mediaDir, 'Live2D_Game', 'rig-covers'), { recursive: true, force: true });
  assert.strictEqual(await flag(), undefined, 'пока обложки нет — без отметки');
  assert.strictEqual((await get(key)).status, 404);
  assert.strictEqual((await put('нет такого', jpeg(10, 'a'))).status, 404, 'чужой ключ');
  assert.strictEqual((await put('', jpeg(10, 'a'))).status, 404, 'пустой ключ');
  assert.strictEqual((await put(key, Buffer.from('GIF89a not a jpeg'))).status, 400, 'не JPEG');
  assert.strictEqual((await put(key, Buffer.alloc(0))).status, 400, 'пустое тело');
  assert.strictEqual((await put(key, jpeg(300 * 1024, 'big'))).status, 413, 'больше 256 КБ');
  assert.strictEqual((await put(key, jpeg(10, 'a'), { auth: false })).status, 401);
  assert.strictEqual((await call('PUT', `/api/gallery/${GAME}/rig-cover?key=${encodeURIComponent(key)}`, { raw: jpeg(10, 'a') })).status, 404, 'набор другой игры');
  assert.strictEqual(fs.existsSync(path.join(gallery.mediaDir, 'Live2D_Game', 'rig-covers')), false, 'отказы ничего не записали');
  assert.strictEqual((await put(key, jpeg(10, 'tiny'))).status, 204);
  assert.strictEqual((await put(key, jpeg(3000, 'first'))).status, 204, 'почти пустую обложку (меньше 2 КБ) заменяет более полная');
  assert.strictEqual((await put(key, jpeg(4000, 'second'))).status, 204, 'повтор — тоже 204, но полную не меняет');
  assert.strictEqual((await put(key, jpeg(10, 'third'))).status, 204);
  const got = await get(key);
  assert.deepStrictEqual([got.status, got.headers['content-type']], [200, 'image/jpeg']);
  assert.ok(got.raw.includes('first') && !got.raw.includes('second'), 'осталась первая');
  assert.strictEqual(await flag(), true, 'в оглавлении набор отмечен');
  assert.deepStrictEqual(fs.readdirSync(path.join(gallery.mediaDir, 'Live2D_Game', 'rig-covers')).filter((n) => n.endsWith('.jpg')).length, 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(gallery.mediaDir, 'Live2D_Game', 'rig-covers')).filter((n) => n.endsWith('.tmp')), [], 'временных файлов не осталось');
  assert.strictEqual((await get('нет такого')).status, 404);
  assert.strictEqual((await put('../../etc/passwd', jpeg(3000, 'x'))).status, 404, 'путь в ключе — не набор');
  assert.strictEqual((await call('PUT', `/api/gallery/nope_game/rig-cover?key=${encodeURIComponent(key)}`, { raw: jpeg(3000, 'x') })).status, 404, 'игры нет');
  // Обычный альбом (не Spine и не Live2D) в оглавлении есть, но обложку набора для него не принимаем
  const realCached = gallery.cached;
  gallery.cached = async (gid) => { const ix = await realCached.call(gallery, gid); return { ...ix, albums: [...ix.albums, { key: 'pictures/cg', kind: 'cg', files: ['pictures/cg.png'] }] }; };
  try { assert.strictEqual((await put('pictures/cg', jpeg(3000, 'x'))).status, 404, 'обычный альбом — не набор'); } finally { gallery.cached = realCached; }
  // Два устройства сразу: остаётся ровно одна из присланных, файл целый
  fs.rmSync(path.join(gallery.mediaDir, 'Live2D_Game', 'rig-covers'), { recursive: true, force: true });
  const both = await Promise.all([put(key, jpeg(3000, 'racea')), put(key, jpeg(3000, 'raceb'))]);
  assert.deepStrictEqual(both.map((r) => r.status), [204, 204]);
  const won = (await get(key)).raw;
  assert.ok(won.includes('racea') !== won.includes('raceb'), 'одна из двух, не смесь');
  assert.deepStrictEqual(fs.readdirSync(path.join(gallery.mediaDir, 'Live2D_Game', 'rig-covers')).length, 1);
  assert.strictEqual((await get(key, GAME)).status, 404, 'у другой игры такого набора нет');
  // Пересборка оглавления обложку не трогает
  await gallery.forget('Live2D_Game');
  await gallery.build('Live2D_Game').promise;
  assert.strictEqual(await flag(), true, 'обложка пережила пересборку');
});

test('галерея: большой PNG по Accept: image/webp — лёгкая копия на том же адресе, иначе и по ?orig=1 — оригинал', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('нет ffmpeg');
  const www = path.join(root, GAME, 'www');
  const pics = path.join(www, 'img', 'pictures');
  fs.mkdirSync(pics, { recursive: true });
  const big = path.join(pics, 'view_big.png');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=320x240:seed=4:d=1', '-vf', 'noise=alls=25:allf=t', '-frames:v', '1', big]);
  fs.writeFileSync(path.join(pics, 'view_small.png'), PNG);
  const gallery = require('./src/services/gallery.js');
  t.after(async () => { fs.rmSync(big, { force: true }); fs.rmSync(path.join(pics, 'view_small.png'), { force: true }); await gallery.forget(GAME); });
  await gallery.forget(GAME);
  await gallery.build(GAME).promise;
  const url = (f, q = '') => `/api/gallery/${GAME}/image?f=${encodeURIComponent(f)}${q}`;
  const webp = { accept: 'image/avif,image/webp,image/apng,*/*;q=0.8' };
  const original = fs.readFileSync(big);
  assert.ok(original.length >= 256 * 1024, 'картинка для проверки не меньше порога');

  const light = await call('GET', url('img/pictures/view_big.png'), { headers: webp });
  assert.deepStrictEqual([light.status, light.headers['content-type']], [200, 'image/webp']);
  assert.match(light.headers.vary, /Accept/);
  assert.strictEqual(light.raw.subarray(8, 12).toString(), 'WEBP');
  assert.ok(light.raw.length <= original.length * 0.8);
  // Без Accept (curl, старый браузер), по ?orig=1 и у маленького файла — оригинал, и везде Vary
  const plain = await call('GET', url('img/pictures/view_big.png'), { headers: { accept: '*/*' } });
  assert.deepStrictEqual([plain.status, plain.headers['content-type'], plain.raw.equals(original)], [200, 'image/png', true]);
  assert.match(plain.headers.vary, /Accept/);
  const orig = await call('GET', url('img/pictures/view_big.png', '&orig=1'), { headers: webp });
  assert.deepStrictEqual([orig.headers['content-type'], orig.raw.equals(original)], ['image/png', true]);
  const small = await call('GET', url('img/pictures/view_small.png'), { headers: webp });
  assert.deepStrictEqual([small.headers['content-type'], small.raw.equals(PNG)], ['image/png', true]);
  // Пустой файл-маркер: копия не вышла или вышла не легче — отдаём оригинал и копию заново не делаем
  const dir = path.join(gallery.mediaDir, GAME, 'view');
  const copies = fs.readdirSync(dir).filter((n) => n.endsWith('.webp'));
  assert.ok(copies.length >= 1);
  for (const n of copies) fs.writeFileSync(path.join(dir, n), '');
  const marked = await call('GET', url('img/pictures/view_big.png'), { headers: webp });
  assert.deepStrictEqual([marked.headers['content-type'], marked.raw.equals(original)], ['image/png', true]);
  assert.strictEqual(fs.statSync(path.join(dir, copies[0])).size, 0, 'маркер не перезаписан');
  assert.strictEqual((await call('GET', url('img/pictures/none.png'), { headers: webp })).status, 404);
});

// Последним: после него вход заблокирован на 15 минут
test('подбор пароля: после 10 неудач вход закрыт, даже с верным паролем', async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await login(`wrong-${i}`);
    assert.strictEqual(last.status, 429);
    assert.strictEqual((await login()).status, 429, 'и верный пароль ждёт');
    assert.strictEqual((await call('GET', '/api/games')).status, 200, 'уже вошедших лимит не касается');
});

function hasSevenZip() {
    return (process.env.PATH || '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, '7zz')));
}

test('галерея: ролик отдаётся файлом с перемоткой (Range); чужие пути и картинки под видом ролика — 404', async () => {
    const www = path.join(root, GAME, 'www');
    fs.mkdirSync(path.join(www, 'img', 'pictures'), { recursive: true });
    fs.mkdirSync(path.join(www, 'movies'), { recursive: true });
    fs.writeFileSync(path.join(www, 'movies', 'opening.webm'), Buffer.from('0123456789abcdefghij'));
    fs.writeFileSync(path.join(www, 'img', 'pictures', 'cg.png'), PNG);
    // Оглавление — сразу, без опроса: сотня запросов подряд упёрлась бы в ограничитель запросов API
    const gallery = require('./src/services/gallery.js');
    await gallery.forget(GAME);
    await gallery.build(GAME).promise;
    const state = (await call('GET', `/api/gallery/${GAME}`)).data;
    assert.ok(state.albums.some((a) => a.kind === 'video' && a.files.includes('movies/opening.webm')));

    const url = (f) => `/api/gallery/${GAME}/video?f=${encodeURIComponent(f)}`;
    const whole = await call('GET', url('movies/opening.webm'));
    assert.deepStrictEqual([whole.status, whole.headers['content-type'], whole.raw.length], [200, 'video/webm', 20]);
    const part = await call('GET', url('movies/opening.webm'), { headers: { range: 'bytes=0-9' } });
    assert.deepStrictEqual([part.status, part.raw.toString()], [206, '0123456789'], 'перемотка — кусками');
    for (const bad of ['../www/data/System.json', 'data/System.json', 'img/pictures/cg.png', 'movies/none.webm']) {
        assert.strictEqual((await call('GET', url(bad))).status, 404, bad);
    }
    assert.strictEqual((await call('GET', `/api/gallery/${GAME}/image?f=${encodeURIComponent('movies/opening.webm')}`)).status, 404, 'ролик картинкой не отдаём');

    // Избранное: только файл из оглавления галереи; одним списком и по игре; игра в корзине — её избранного не видно
    const fav = (json) => call('PUT', '/api/favorites', { json });
    assert.strictEqual((await fav({ game: GAME, file: '../www/data/System.json', kind: 'cg' })).status, 400);
    assert.strictEqual((await fav({ game: '../x', file: 'img/pictures/cg.png' })).status, 400);
    assert.strictEqual((await fav({ game: GAME, file: 'movies/opening.webm', kind: 'video' })).status, 200);
    assert.strictEqual((await fav({ game: GAME, file: 'img/pictures/cg.png', kind: 'нечто' })).status, 200);
    let favs = (await call('GET', '/api/favorites')).data;
    assert.deepStrictEqual(favs.map((f) => [f.game, f.file, f.kind]).sort(), [[GAME, 'img/pictures/cg.png', ''], [GAME, 'movies/opening.webm', 'video']]);
    assert.strictEqual((await call('GET', `/api/favorites?game=${GAME}`)).data.length, 2);
    assert.strictEqual((await call('GET', '/api/favorites?game=..')).status, 400);
    // Анимация целиком: кадры — из оглавления, первый — сам файл; темп — в разумных пределах
    for (const frames of [['img/pictures/cg.png', '../www/data/System.json'], ['movies/opening.webm', 'img/pictures/cg.png'], ['img/pictures/cg.png'], 'img/pictures/cg.png']) {
        assert.strictEqual((await fav({ game: GAME, file: 'img/pictures/cg.png', kind: 'animation', frames, fps: 12 })).status, 400, JSON.stringify(frames));
    }
    assert.strictEqual((await fav({ game: GAME, file: 'img/pictures/cg.png', kind: 'animation', frames: ['img/pictures/cg.png', 'movies/opening.webm'], fps: 500 })).status, 200);
    const anim = (await call('GET', `/api/favorites?game=${GAME}`)).data.find((f) => f.file === 'img/pictures/cg.png');
    assert.deepStrictEqual([anim.kind, anim.frames, anim.fps], ['animation', ['img/pictures/cg.png', 'movies/opening.webm'], 60]);
    assert.ok(!('anim' in anim), 'столбец как есть не отдаём');
    assert.strictEqual((await fav({ game: GAME, file: 'img/pictures/cg.png', kind: 'cg' })).status, 200);
    assert.strictEqual((await call('GET', `/api/favorites?game=${GAME}`)).data.find((f) => f.file === 'img/pictures/cg.png').frames.length, 2, 'тот же файл одной картинкой анимацию не стирает');
    await dbService.get().run("UPDATE games SET id = 'Gone' WHERE id = ?", [GAME]);
    assert.deepStrictEqual((await call('GET', '/api/favorites')).data, [], 'игры нет в библиотеке — и избранного её не видно');
    await dbService.get().run("UPDATE games SET id = ? WHERE id = 'Gone'", [GAME]);
    assert.strictEqual((await call('DELETE', `/api/favorites?game=${GAME}&f=${encodeURIComponent('img/pictures/cg.png')}`)).status, 200);
    favs = (await call('GET', '/api/favorites')).data;
    assert.deepStrictEqual(favs.map((f) => f.file), ['movies/opening.webm']);
    // Склейки, которой после пересборки нет в оглавлении, не видно, но запись не стёрта
    await dbService.get().run('INSERT INTO gallery_favorites (game_id, file, kind, at) VALUES (?, ?, ?, ?)', [GAME, '@cg/0123456789abcdef0123', 'cg', 1]);
    assert.deepStrictEqual((await call('GET', '/api/favorites')).data.map((f) => f.file), ['movies/opening.webm']);
    assert.ok(await dbService.get().get('SELECT 1 FROM gallery_favorites WHERE file = ?', ['@cg/0123456789abcdef0123']));
    await dbService.get().run('DELETE FROM gallery_favorites WHERE file = ?', ['@cg/0123456789abcdef0123']);
    // Без входа — нет
    assert.strictEqual((await call('GET', '/api/favorites', { auth: false })).status, 401);
});

test('галерея: номер сцены n в запросе — только целое из цифр, остальное — 404', async () => {
    const gallery = require('./src/services/gallery.js');
    const real = gallery.scene;
    const got = [];
    // Сцену не строим: важно, какой номер дошёл до сервиса
    gallery.scene = async (id, key, tr, opts) => { got.push(opts.n); return opts.n >= 0 && opts.n < 2 ? { steps: [] } : null; };
    try {
        const url = (q) => `/api/gallery/${GAME}/scene?key=k${q}`;
        assert.strictEqual((await call('GET', url(''))).status, 200);
        assert.strictEqual((await call('GET', url('&n=1'))).status, 200);
        for (const bad of ['&n=abc', '&n=0.5', '&n=-1', '&n=999', '&n=', '&n[]=1']) assert.strictEqual((await call('GET', url(bad))).status, 404, bad);
        assert.deepStrictEqual(got, [0, 1, -1, -1, -1, 999, -1, -1]);
    } finally { gallery.scene = real; }
});

test('поиск по картинкам: слова → кадры игр библиотеки по близости векторов, чужое и пропавшее не показываем', async () => {
    const gallery = require('./src/services/gallery.js');
    const text = require('./src/services/galleryText.js');
    await gallery.forget(GAME);
    await gallery.build(GAME).promise;
    // Векторы кадров — как их кладёт visionPass: по байту на число, масштаб 200 (число 0,6 — байт 120)
    const pack = (head) => Buffer.from(Int8Array.from({ length: 512 }, (_, i) => head[i] || 0)).toString('base64');
    const save = (id, embeds) => {
        fs.mkdirSync(path.join(gallery.mediaDir, id), { recursive: true });
        fs.writeFileSync(gallery.visionPath(id), JSON.stringify({ version: gallery.vision.version, scores: {}, embeds }));
    };
    save(GAME, {
        'img/pictures/cg.png\n67': pack([120]),                       // совпадает с запросом
        'movies/opening.webm\n20': pack([36, 114]),                   // далеко
        'img/pictures/gone.png\n1': pack([120]),                      // в оглавлении нет — пересобрали после ответа
    });
    save('Not_In_Library', { 'img/pictures/cg.png\n67': pack([120]) });
    const realEmbed = text.embed;
    try {
        text.embed = async (q) => (q === 'unavailable' ? null : Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)));
        const search = (q, extra = '') => call('GET', `/api/pictures/search?q=${encodeURIComponent(q)}${extra}`);
        const found = await search('горничная');
        assert.strictEqual(found.status, 200);
        assert.strictEqual(found.data.games, 1, 'игра не из библиотеки в поиске не участвует');
        assert.deepStrictEqual(found.data.results.map((r) => [r.game, r.file]), [[GAME, 'img/pictures/cg.png'], [GAME, 'movies/opening.webm']], 'по близости; кадра вне оглавления нет');
        assert.ok(found.data.results[0].score === 0.6 && found.data.results[1].score === 0.18);
        assert.strictEqual((await search('maid', '&limit=1')).data.results.length, 1);
        for (const bad of ['', '   ', 'x'.repeat(101)]) assert.strictEqual((await search(bad)).status, 400, 'пустой или слишком длинный запрос');
        assert.strictEqual((await call('GET', '/api/pictures/search')).status, 400);
        assert.strictEqual((await search('unavailable')).status, 503, 'модели текста нет — честный ответ, а не пустой список');
        assert.strictEqual((await call('GET', '/api/pictures/search?q=maid', { auth: false })).status, 401);
        // Сбой — общий код, а не текст ошибки (в нём бывают пути на диске)
        text.embed = async () => { throw new Error('/data/секретный/путь'); };
        const broken = await search('maid');
        assert.deepStrictEqual([broken.status, broken.data], [500, { error: 'search-failed' }]);
    } finally {
        text.embed = realEmbed;
        fs.rmSync(path.join(gallery.mediaDir, 'Not_In_Library'), { recursive: true, force: true });
        fs.rmSync(gallery.visionPath(GAME), { force: true });
    }
});

test('галерея: звуки — разделы по папкам, расшифрованный звук с Range, чужие пути — 404', async () => {
    const ID = 'Sound_Game';
    const www = path.join(root, ID, 'www');
    const key = '00112233445566778899aabbccddeeff';
    const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(www, rel)), { recursive: true }); fs.writeFileSync(path.join(www, rel), data); };
    // Как кладёт RPG Maker: 16 байт своего заголовка, потом звук с первыми 16 байтами, сложенными по XOR с ключом
    const seal = (data) => {
        const body = Buffer.from(data);
        for (let i = 0; i < 16; i++) body[i] ^= parseInt(key.substr((i % 16) * 2, 2), 16);
        return Buffer.concat([Buffer.from('RPGMV\0\0\0\0\x03\x01\0\0\0\0\0', 'latin1'), body]);
    };
    const ogg = (tag) => Buffer.concat([Buffer.from('OggS\0\x02'), Buffer.from(tag.padEnd(34, '.'))]);
    fs.mkdirSync(path.join(www, 'img'), { recursive: true });
    put('data/System.json', JSON.stringify({ encryptionKey: key }));
    put('audio/bgm/Theme1.rpgmvo', seal(ogg('theme')));
    put('audio/bgm/Theme2.ogg_', seal(ogg('theme2')));
    put('audio/bgm/Plain.ogg', ogg('plain'));
    put('audio/me/Fanfare.m4a_', seal(Buffer.from('....ftypM4A ' + 'x'.repeat(30))));
    put('audio/bgs/Rain.ogg', ogg('rain'));
    put('audio/se/Click.ogg', ogg('click'));
    put('audio/se/voice_hey1.ogg', ogg('hey'));
    put('audio/voice/elena_01_jp.rpgmvo', seal(ogg('v1')));
    put('audio/voice/elena_02_jp.rpgmvo', seal(ogg('v2')));
    put('audio/notes.txt', 'не звук');

    const got = await call('GET', `/api/gallery/${ID}/sounds`);
    const list = got.data;
    assert.strictEqual(got.status, 200, JSON.stringify(got.data));
    assert.strictEqual(list.count, 9);
    assert.deepStrictEqual(list.albums.map((a) => [a.section, a.key, a.files.length]), [
        ['music', 'audio/bgm', 3], ['music', 'audio/me', 1], ['voice', 'audio/se#voice', 1], ['voice', 'audio/voice', 2],
        ['ambience', 'audio/bgs', 1], ['effects', 'audio/se', 1]]);
    assert.strictEqual((await call('GET', '/api/gallery/Nope_Game/sounds')).status, 404);

    const url = (f) => `/api/gallery/${ID}/audio?f=${encodeURIComponent(f)}`;
    const sealed = await call('GET', url('audio/bgm/Theme1.rpgmvo'));
    assert.deepStrictEqual([sealed.status, sealed.headers['content-type']], [200, 'audio/ogg']);
    assert.deepStrictEqual(sealed.raw, ogg('theme'), 'расшифрован: те же байты, что до шифрования');
    assert.deepStrictEqual((await call('GET', url('audio/bgm/Theme2.ogg_'))).raw, ogg('theme2'), 'MZ — .ogg_');
    assert.strictEqual((await call('GET', url('audio/me/Fanfare.m4a_'))).headers['content-type'], 'audio/mp4');
    const plain = await call('GET', url('audio/bgm/Plain.ogg'));
    assert.deepStrictEqual([plain.status, plain.headers['content-type'], plain.raw], [200, 'audio/ogg', ogg('plain')]);

    const part = await call('GET', url('audio/bgm/Theme1.rpgmvo'), { headers: { range: 'bytes=4-9' } });
    assert.deepStrictEqual([part.status, part.headers['content-range'], part.raw], [206, `bytes 4-9/${ogg('theme').length}`, ogg('theme').subarray(4, 10)]);
    const tail = await call('GET', url('audio/bgm/Theme1.rpgmvo'), { headers: { range: 'bytes=-4' } });
    assert.deepStrictEqual([tail.status, tail.raw], [206, ogg('theme').subarray(-4)]);
    assert.strictEqual((await call('GET', url('audio/bgm/Theme1.rpgmvo'), { headers: { range: 'bytes=999-' } })).status, 416);
    // Диапазон через границу 16 байт с XOR: расшифрована только первая часть, остальное — как в файле
    const across = await call('GET', url('audio/bgm/Theme1.rpgmvo'), { headers: { range: 'bytes=10-30' } });
    assert.deepStrictEqual([across.status, across.headers['content-range'], across.raw], [206, `bytes 10-30/${ogg('theme').length}`, ogg('theme').subarray(10, 31)]);
    const after = await call('GET', url('audio/bgm/Theme1.rpgmvo'), { headers: { range: 'bytes=20-' } });
    assert.deepStrictEqual([after.status, after.raw], [206, ogg('theme').subarray(20)]);
    const plainPart = await call('GET', url('audio/bgm/Plain.ogg'), { headers: { range: 'bytes=0-3' } });
    assert.deepStrictEqual([plainPart.status, plainPart.raw.toString()], [206, 'OggS'], 'обычный файл — Range через sendFile');

    for (const bad of ['../www/data/System.json', 'data/System.json', 'audio/notes.txt', 'audio/bgm/none.ogg', 'audio/bgm/../../data/System.json']) {
        assert.strictEqual((await call('GET', url(bad))).status, 404, bad);
    }
    assert.strictEqual((await call('GET', url('audio/bgm/Plain.ogg'), { auth: false })).status, 401, 'без входа — нет');
});

test('галерея: звуки — папка Audio с большой буквы находится, вложенная — нет', async () => {
    const ID = 'Sound_Case';
    const www = path.join(root, ID, 'www');
    const put = (rel) => { fs.mkdirSync(path.dirname(path.join(www, rel)), { recursive: true }); fs.writeFileSync(path.join(www, rel), 'OggS....'); };
    fs.mkdirSync(path.join(www, 'img'), { recursive: true });
    put('data/System.json');
    put('Audio/BGM/Theme.ogg');
    put('Audio/voice/hey.ogg');
    put('www/Audio/BGM/Nested.ogg');
    const resp = await call('GET', `/api/gallery/${ID}/sounds`);
    const list = resp.data;
    assert.strictEqual(resp.status, 200, JSON.stringify(resp.data));
    assert.deepStrictEqual(list.albums.map((a) => [a.section, a.name, a.files]), [['music', 'BGM', ['Audio/BGM/Theme.ogg']], ['voice', 'voice', ['Audio/voice/hey.ogg']]]);
    const got = await call('GET', `/api/gallery/${ID}/audio?f=${encodeURIComponent('Audio/BGM/Theme.ogg')}`);
    assert.deepStrictEqual([got.status, got.raw.toString()], [200, 'OggS....']);
});

test('галерея: сцена для плеера — шаги и файлы альбома; чужой ключ, альбом без сценария, неизвестная игра — 404; без входа — нет', async () => {
    const ID = 'Scene_Game';
    const www = path.join(root, ID, 'www');
    fs.mkdirSync(path.join(www, 'img', 'pictures'), { recursive: true });
    fs.mkdirSync(path.join(www, 'data'), { recursive: true });
    fs.writeFileSync(path.join(www, 'img', 'pictures', 'cg.png'), PNG);
    const gallery = require('./src/services/gallery.js');
    await gallery.forget(ID);
    await gallery.build(ID).promise;
    // Альбом со сценарием, как его оставляет сборка: флаг в оглавлении и файл в папке сценариев этой сборки
    const key = 'events/00001/Сцена';
    const file = gallery.indexPath(ID);
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    index.albums.push({ key, kind: 'cg', w: 1, h: 1, files: ['img/pictures/cg.png'], script: true });
    index.scripts = 'scripts-1';
    fs.writeFileSync(file, JSON.stringify(index));
    gallery.memo.delete(ID);
    fs.mkdirSync(path.dirname(gallery.scriptPath(ID, index.scripts, key)), { recursive: true });
    fs.writeFileSync(gallery.scriptPath(ID, index.scripts, key), JSON.stringify({ sounds: ['audio/bgm/Theme.ogg'], steps: [
        { k: 'snd', kind: 'bgm', f: 0, vol: 80, pitch: 100, pan: 0 }, { k: 'pic', i: 0 },
        { k: 'say', l: ['\\C[2]【Анна】\\C[0]', 'Привет, \\V[3]!'], v: { 3: 5 } }, { k: 'wait', n: 30 },
        { k: 'choice', o: ['Да', 'Нет'], i: 0 }] }));

    const url = (k, id = ID) => `/api/gallery/${id}/scene?key=${encodeURIComponent(k)}`;
    const got = await call('GET', url(key));
    assert.strictEqual(got.status, 200, JSON.stringify(got.data));
    assert.deepStrictEqual(got.data, { files: ['img/pictures/cg.png'], steps: [
        { k: 'snd', kind: 'bgm', f: 'audio/bgm/Theme.ogg', vol: 80, pitch: 100, pan: 0 }, { k: 'pic', i: 0 },
        { k: 'say', who: 'Анна', text: 'Привет, 5!' }, { k: 'wait', n: 30 }, { k: 'choice', o: ['Да', 'Нет'], i: 0 }], screen: index.screen });
    // Язык реплик в запросе: у игры без таблиц любые значения (и странные: массив, объект, «../», нулевой байт) отдают то же тело
    for (const extra of ['&lang=en&ui=ru', '&lang=en&lang=ja', '&lang[x]=1', '&lang=../../x,ZZZZZZZZZ&ui=%00']) {
        const same = await call('GET', url(key) + extra);
        assert.strictEqual(same.status, 200, extra);
        assert.deepStrictEqual(same.data, got.data, extra);
    }
    // Остальные случаи (нет ключа, альбом без сценария, чужой ключ) — в server.test.js, у сервиса: здесь каждый запрос
    // считает ограничитель API, а до него остаётся мало
    assert.strictEqual((await call('GET', url('events/00009/нет'))).status, 404, 'такого альбома нет');
    assert.strictEqual((await call('GET', url(key, 'Nope_Game'))).status, 404, 'игры нет');
    assert.strictEqual((await call('GET', url(key), { auth: false })).status, 401, 'без входа — нет');
});

test('сейвы в окне игры: у слота снимок экрана, где был; без входа — нет', async () => {
    const store = require('./src/routes/saves.js').store;
    await store.write(GAME, 'RPG File3', '{"party":{"_gold":5}}', Date.now());
    await store.writeShot(GAME, 'RPG File3', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const hist = (await call('GET', `/api/saves/history/${GAME}`)).data;
    assert.strictEqual(hist.slots.find((s) => s.key === 'RPG File3')?.shot, true);
    assert.ok(hist.slots.filter((s) => s.key !== 'RPG File3').every((s) => s.shot === false), 'у слотов без снимка — нет');
    const shot = await call('GET', `/api/saves/shot/${GAME}?key=${encodeURIComponent('RPG File3')}`);
    assert.deepStrictEqual([shot.status, shot.raw[0], shot.raw[1]], [200, 0xff, 0xd8]);
    assert.strictEqual((await call('GET', `/api/saves/shot/${GAME}?key=${encodeURIComponent('RPG File9')}`)).status, 404);
    assert.strictEqual((await call('GET', `/api/saves/shot/${GAME}`)).status, 404);
    assert.strictEqual((await call('GET', `/api/saves/shot/${GAME}?key=${encodeURIComponent('RPG File3')}`, { auth: false })).status, 401);
    await store.remove(GAME, 'RPG File3');
});

test('моменты в окне игры: список со снимками, подпись, убрать — только со входом', async () => {
    const marks = require('./src/routes/marks.js').store;
    const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
    const { id } = await marks.create(GAME, { label: 'Ванная', map: 'Дом', value: '{"map":1}', thumb: jpg });
    let r = await call('GET', `/api/marks/${GAME}`);
    assert.deepStrictEqual(r.data.map((m) => [m.id, m.label, m.map, m.thumb]), [[id, 'Ванная', 'Дом', true]]);
    assert.ok(!('value' in r.data[0]), 'сам сейв в список не идёт');
    r = await call('GET', `/api/marks/${GAME}/${id}/thumb`);
    assert.deepStrictEqual([r.status, r.raw[0], r.raw[1]], [200, 0xff, 0xd8]);
    assert.strictEqual((await call('PATCH', `/api/marks/${GAME}/${id}`, { json: { label: 'После боя' } })).status, 200);
    assert.strictEqual((await call('GET', `/api/marks/${GAME}`)).data[0].label, 'После боя');
    assert.strictEqual((await call('PATCH', `/api/marks/${GAME}/${id}`, { json: {} })).status, 400);
    assert.strictEqual((await call('GET', `/api/marks/${GAME}/..%2F..%2Fx/thumb`)).status, 400);
    assert.strictEqual((await call('GET', `/api/marks/..%2Fx`)).status, 400);
    assert.strictEqual((await call('GET', `/api/marks/${GAME}`, { auth: false })).status, 401);
    assert.strictEqual((await call('DELETE', `/api/marks/${GAME}/${id}`)).status, 200);
    assert.deepStrictEqual((await call('GET', `/api/marks/${GAME}`)).data, []);
    assert.strictEqual((await call('DELETE', `/api/marks/${GAME}/${id}`)).status, 404);
});

test('перевод игры: включили — у игры новый адрес и данные с переводом, открытая игра по старому адресу работает дальше; выключили — оригинал', async () => {
    const { createGameApp, gameKey, revOf } = require('./src/routes/play.js');
    const ID = 'Tl_Game';
    const data = path.join(root, ID, 'www', 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(root, ID, 'www', 'index.html'), '<html><body></body></html>');
    fs.writeFileSync(path.join(data, 'System.json'), JSON.stringify({ terms: { commands: ['戦う'] } }));
    fs.writeFileSync(path.join(data, 'Map001.json'), JSON.stringify({ displayName: '', events: [null, { pages: [{ list: [{ code: 401, parameters: ['こんにちは'] }, { code: 0, parameters: [] }] }] }] }));
    fs.mkdirSync(path.join(root, ID, 'www', 'js'), { recursive: true });
    fs.writeFileSync(path.join(root, ID, 'www', 'js', 'plugins.js'), 'var $plugins = [{"name":"Menu","status":true,"parameters":{"Help Text":"こんにちは"}}];');
    await dbService.get().run("INSERT INTO games (id, title, ready) VALUES (?, 'Tl', 1)", [ID]);

    const gameApp = createGameApp({ secret: () => dbService.getSessionToken(), store: { list: async () => [] }, publicDir: path.join(__dirname, 'public') });
    const gameServer = gameApp.listen(0, '127.0.0.1');
    await new Promise((r) => gameServer.once('listening', r));
    const get = (url) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: gameServer.address().port, path: url }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
    });
    const url = async (file) => `/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}/www/data/${file}`;
    try {
        const plain = await url('Map001.json');
        assert.match((await get(plain)).body, /こんにちは/);

        // Ключей служб нет — перевод включается, но переводить нечем; перевод строки — из своего файла
        const on = await call('POST', `/api/games/${ID}/translation`, { json: { lang: 'en' } });
        assert.deepStrictEqual([on.status, on.data.lang], [200, 'en']);
        // Сначала в словарь — стандартные слова (без службы), потом выясняется, что службы нет
        let err = '';
        for (let i = 0; i < 40 && !err; i++) {
            await new Promise((r) => setTimeout(r, 50));
            err = (await call('GET', `/api/games/${ID}/translation`)).data.error;
        }
        assert.strictEqual(err, 'no-engine');
        const imported = await call('POST', `/api/games/${ID}/translation/import`, { json: { lang: 'en', content: JSON.stringify({ 'こんにちは': 'Hello', '戦う': 'Fight' }) } });
        assert.deepStrictEqual([imported.status, imported.data.matched, imported.data.total], [200, 2, 2]);

        const translated = await url('Map001.json');
        assert.notStrictEqual(translated, plain, 'у переведённой игры другой адрес');
        const res = await get(translated);
        assert.deepStrictEqual([res.status, JSON.parse(res.body).events[1].pages[0].list[0].parameters[0], res.headers['cache-control']], [200, 'Hello', 'no-cache']);
        assert.strictEqual(JSON.parse((await get(await url('System.json'))).body).terms.commands[0], 'Fight');
        // Прежний адрес — у игры, открытой до включения перевода: файлы и сохранения по нему не отказывают
        const old = await get(plain);
        assert.deepStrictEqual([old.status, JSON.parse(old.body).events[1].pages[0].list[0].parameters[0]], [200, 'Hello'], 'старый адрес работает — уже с переводом');
        const savesKey = plain.split('/')[2];
        assert.strictEqual((await get(`/saves/${savesKey}/${ID}`)).status, 200, 'сохранения по старому адресу — тоже');
        // plugins.js — тоже через перевод (подписи меню из параметров), не в кэш надолго
        const pjs = await get(`/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}/www/js/plugins.js`);
        assert.deepStrictEqual([pjs.status, pjs.headers['cache-control'], /javascript/.test(pjs.headers['content-type'])], [200, 'no-cache', true]);
        assert.match(pjs.body, /"Help Text":"Hello"/);
        // Игра просит звук по переведённому имени — сервер игр отдаёт настоящий файл, а не пустоту
        fs.mkdirSync(path.join(root, ID, 'www', 'audio', 'se'), { recursive: true });
        fs.writeFileSync(path.join(root, ID, 'www', 'audio', 'se', 'クリック.ogg'), 'OGG');
        await dbService.get().run("INSERT OR REPLACE INTO translations (src, lang, text) VALUES ('クリック', 'en', 'Click')");
        const translateService = require('./src/services/translate.js');
        translateService.version++;
        translateService.cache.clear();
        const snd = await get(`/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}/www/audio/se/Click.ogg`);
        assert.deepStrictEqual([snd.status, snd.body], [200, 'OGG']);
        // Перевод только для экрана — рядом со страницей игры; без перевода его нет
        const dd = await get(`/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}/www/mimikin-tl.json`);
        assert.deepStrictEqual([dd.status, dd.headers['cache-control'], typeof JSON.parse(dd.body)], [200, 'no-cache', 'object']);
        // В страницу игры — язык перевода: rpg-fixes переносит длинные строки
        const page = (await get(`/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}/www/index.html`)).body;
        assert.match(page, /"tl":"en"/);
        // Версия rpg-fixes в адресе — по последней правке его или чит-меню (cheats.js грузится с той же версией)
        const mtime = (f) => fs.statSync(path.join(__dirname, 'public', f)).mtimeMs;
        assert.match(page, new RegExp(`rpg-fixes\\.js\\?v=${Math.round(Math.max(mtime('rpg-fixes.js'), mtime('cheats.js')))}"`));
        // Шрифт переведённого текста: два файла из списка, остальное в /fonts/ — нет
        const font = await get('/fonts/mplus-rounded-1c-cyrillic-500.woff2');
        assert.deepStrictEqual([font.status, font.headers['content-type']], [200, 'font/woff2']);
        assert.strictEqual((await get('/fonts/OFL-M-PLUS-Rounded-1c.txt')).status, 404);

        await call('POST', `/api/games/${ID}/translation`, { json: { lang: '' } });
        const back = await url('Map001.json');
        assert.strictEqual(back, plain, 'выключили — прежний адрес');
        assert.match((await get(back)).body, /こんにちは/);
        assert.doesNotMatch((await get(`/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}/www/index.html`)).body, /"tl":/, 'без перевода rpg-fixes не трогает шрифт и строки');
        assert.strictEqual((await get(`/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}/www/mimikin-tl.json`)).status, 404);
        assert.strictEqual((await call('POST', `/api/games/${ID}/translation`, { json: { lang: 'xx' } })).status, 400);
        assert.strictEqual((await call('POST', '/api/games/No_Such_Game/translation/import', { json: { lang: 'en', content: '{"a":"b"}' } })).status, 404);
        // Оценка, проверка, исправление: игры нет — 404; перевод выключен — проверять нечего (409)
        assert.strictEqual((await call('GET', '/api/games/No_Such_Game/translation/estimate?lang=en')).status, 404);
        assert.strictEqual((await call('GET', '/api/games/No_Such_Game/translation/check')).status, 404);
        assert.strictEqual((await call('POST', '/api/games/No_Such_Game/translation/fix')).status, 404);
        assert.strictEqual((await call('GET', `/api/games/${ID}/translation/check`)).status, 409);
        const est = await call('GET', `/api/games/${ID}/translation/estimate?lang=ru`);
        assert.deepStrictEqual([est.status, est.data.total, est.data.engine], [200, 2, '']);
        // Ключ открывает только папку своей игры: ни файла рядом с играми (там база библиотеки), ни чужой игры
        fs.writeFileSync(path.join(root, 'secret.txt'), 'x');
        const base = `/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}`;
        for (const bad of ['/..%2fsecret.txt', '/www/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', `/..%2f${GAME}%2f`]) {
            assert.strictEqual((await get(base + bad)).status, 403, bad);
        }
    } finally {
        gameServer.close();
    }
});

test('текст на картинках: без службы распознавания блок скрыт; заплатка подписи — рядом со страницей игры, надолго', async () => {
    const { createGameApp, gameKey, revOf } = require('./src/routes/play.js');
    const pictureService = require('./src/services/pictures.js');
    const ID = 'Pic_Game';
    fs.mkdirSync(path.join(root, ID, 'www', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, ID, 'www', 'index.html'), '<html><body></body></html>');
    fs.writeFileSync(path.join(root, ID, 'www', 'data', 'System.json'), JSON.stringify({ terms: { commands: ['戦う'] } }));
    await dbService.get().run("INSERT INTO games (id, title, ready) VALUES (?, 'Pic', 1)", [ID]);
    const url = pictureService.url;
    pictureService.url = '';
    try {
        const st = await call('GET', `/api/games/${ID}/pictures`);
        assert.deepStrictEqual([st.status, st.data.configured, st.data.available], [200, false, false]);
        assert.strictEqual((await call('POST', `/api/games/${ID}/pictures`, { json: { scope: 'ui' } })).status, 503, 'без службы — не начинается');
        assert.strictEqual((await call('GET', '/api/games/Nope/pictures')).status, 404);
    } finally {
        pictureService.url = url;
    }

    const png = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex');
    const hash = 'ab'.repeat(20);
    await dbService.get().run('INSERT OR REPLACE INTO picture_patches (hash, png) VALUES (?, ?)', [hash, png]);
    const gameApp = createGameApp({ secret: () => dbService.getSessionToken(), store: { list: async () => [] }, publicDir: path.join(__dirname, 'public') });
    const gameServer = gameApp.listen(0, '127.0.0.1');
    await new Promise((r) => gameServer.once('listening', r));
    const get = (u) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: gameServer.address().port, path: u }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
    try {
        const base = `/g/${gameKey(dbService.getSessionToken(), ID, await revOf(ID))}/${ID}/www/mimikin-tl/patch`;
        const r = await get(`${base}/${hash}.png`);
        assert.deepStrictEqual([r.status, r.headers['content-type'], /immutable/.test(r.headers['cache-control'])], [200, 'image/png', true]);
        assert.ok(r.body.equals(png));
        assert.strictEqual((await get(`${base}/${'cd'.repeat(20)}.png`)).status, 404);
        // Чит-меню — своё (cheats.js); прежнего чужого плагина больше нет
        // Без версии — на сутки; с версией (rpg-fixes грузит его со своей ?v=) — надолго: обновление — новый адрес
        const plainCheats = await get('/cheats.js');
        const versioned = await get('/cheats.js?v=123');
        assert.deepStrictEqual([plainCheats.status, /max-age=86400/.test(plainCheats.headers['cache-control']), versioned.status, /immutable/.test(versioned.headers['cache-control'])],
            [200, true, 200, true]);
        for (const old of ['/Cheat_Menu.js', '/Cheat_Menu.css']) assert.strictEqual((await get(old)).status, 404, old);
        // Для экрана «Картинки» — та же заплатка через библиотеку (вход по сессии)
        const lib = await call('GET', `/api/games/pictures/patch/${hash}`);
        assert.strictEqual(lib.status, 200);
    } finally {
        gameServer.close();
    }
});

// Архив игры: ZIP без сжатия с заранее известной длиной. Папка игры — во временной папке теста, в настоящих играх ничего не пишется
test('архив игры: длина известна заранее и сходится с байтами, имена и содержимое целы, чужое не попадает, больше двух сразу — 429', async () => {
    const { execFileSync } = require('child_process');
    const ID = 'Archive_Game';
    const dir = path.join(root, ID);
    const big = require('crypto').randomBytes(3 * 1024 * 1024 + 17);
    const jp = 'ファイル 日本語.txt';
    fs.mkdirSync(path.join(dir, 'www', 'audio'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'www', 'empty'));
    fs.writeFileSync(path.join(dir, 'www', 'index.html'), '<!doctype html><title>A</title>');
    fs.writeFileSync(path.join(dir, 'www', 'audio', jp), 'こんにちは');
    fs.writeFileSync(path.join(dir, 'www', 'big.bin'), big);
    fs.writeFileSync(path.join(dir, 'zero.dat'), '');
    // Ссылка на файл вне игры: в архив не идёт
    fs.symlinkSync(outside, path.join(dir, 'www', 'leak.png'));
    await dbService.get().run(
        `INSERT INTO games (id, title, cover, tags, description, rating, lastPlayed, addedAt, scraped, ready, size, meta_status)
         VALUES (?, 'Игра: «Архив» / test', '', '[]', '', 0, 0, ?, 1, 1, 1024, 'ok')`, [ID, Date.now()]);

    const get = (url, { hold = false, method = 'GET', auth = true } = {}) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: auth ? { cookie: `${COOKIE}=${cookie}` } : {} }, (res) => {
            if (hold) return resolve({ res, req });
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });

    assert.strictEqual((await get(`/api/games/${ID}/archive`, { auth: false })).res.statusCode, 401);
    assert.strictEqual((await get('/api/games/No_Such_Game/archive')).res.statusCode, 404);

    const { res, body } = await get(`/api/games/${ID}/archive`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'application/zip');
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    assert.strictEqual(Number(res.headers['content-length']), body.length, 'Content-Length равен числу полученных байт');
    assert.match(res.headers['content-disposition'], /^attachment; filename="[\x20-\x7e]+\.zip"; filename\*=UTF-8''.+\.zip$/);
    assert.ok(!/[\/:"]/.test(decodeURIComponent(res.headers['content-disposition'].split("UTF-8''")[1])), 'в имени файла нет символов, запрещённых в Windows');

    // HEAD отдаёт ту же длину без тела
    const head = await get(`/api/games/${ID}/archive`, { method: 'HEAD' });
    assert.strictEqual(Number(head.res.headers['content-length']), body.length);

    // Без 7zz (в CI его нет) — хотя бы запись конца архива на месте
    assert.strictEqual(body.readUInt32LE(body.length - 22), 0x06054b50, 'в конце потока стоит запись EOCD');
    assert.match(decodeURIComponent(res.headers['content-disposition'].split("UTF-8''")[1]), /^Игра «Архив» test\.zip$/, 'имя файла из показываемого названия');

    if (hasSevenZip()) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-zip-'));
        try {
            const zip = path.join(tmp, 'a.zip');
            fs.writeFileSync(zip, body);
            const sevenZ = (...a) => execFileSync('7zz', [...a, '-sccUTF-8'], { encoding: 'utf8' });
            assert.match(sevenZ('t', zip), /Everything is Ok/);
            const names = sevenZ('l', '-slt', zip);
            assert.ok(names.includes(`Path = ${ID}/www/audio/${jp}`), 'японское имя дошло как есть');
            assert.ok(names.includes(`Path = ${ID}/www/empty`), 'пустая папка на месте');
            assert.ok(!names.includes('leak.png'), 'ссылка за пределы игры не попала в архив');
            const out = path.join(tmp, 'out');
            sevenZ('x', zip, `-o${out}`, '-y');
            assert.ok(fs.readFileSync(path.join(out, ID, 'www', 'big.bin')).equals(big));
            assert.strictEqual(fs.readFileSync(path.join(out, ID, 'www', 'audio', jp), 'utf8'), 'こんにちは');
            assert.strictEqual(fs.readFileSync(path.join(out, ID, 'www', 'index.html'), 'utf8'), '<!doctype html><title>A</title>');
            assert.strictEqual(fs.statSync(path.join(out, ID, 'zero.dat')).size, 0);
            assert.ok(fs.statSync(path.join(out, ID, 'www', 'empty')).isDirectory());
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // Два архива сразу — предел: третий получает 429, а когда клиенты ушли, место освобождается.
    // Файл больше сетевых буферов, поэтому ответ стоит на паузе и держит место
    fs.writeFileSync(path.join(dir, 'www', 'huge.bin'), Buffer.alloc(48 * 1024 * 1024, 7));
    const a = await get(`/api/games/${ID}/archive`, { hold: true });
    const b = await get(`/api/games/${ID}/archive`, { hold: true });
    a.res.pause(); b.res.pause();
    const third = await get(`/api/games/${ID}/archive`);
    assert.strictEqual(third.res.statusCode, 429);
    assert.match(JSON.parse(third.body).error, /подождите/);
    a.req.destroy(); b.req.destroy();
    let freed = false;
    for (let i = 0; i < 50 && !freed; i++) {
        freed = (await get(`/api/games/${ID}/archive`, { method: 'HEAD' })).res.statusCode === 200;
        if (!freed) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(freed, 'после ухода клиентов место под архив освободилось');

    // Застывшая загрузка (клиент на паузе) не держит место вечно: без передачи байт ответ закрывается
    const gameArchive = require('./src/services/gameArchive.js');
    gameArchive.state.idleMs = 400;
    try {
        const c = await get(`/api/games/${ID}/archive`, { hold: true });
        const d = await get(`/api/games/${ID}/archive`, { hold: true });
        c.res.pause(); d.res.pause();
        let freedIdle = false;
        for (let i = 0; i < 60 && !freedIdle; i++) {
            freedIdle = (await get(`/api/games/${ID}/archive`, { method: 'HEAD' })).res.statusCode === 200;
            if (!freedIdle) await new Promise((r) => setTimeout(r, 100));
        }
        c.req.destroy(); d.req.destroy();
        assert.ok(freedIdle, 'застывшие загрузки закрыты по сроку, места свободны');
    } finally {
        gameArchive.state.idleMs = 5 * 60 * 1000;
    }
});

// Читает zip64-архив нашего устройства в самом тесте (7zz в CI нет): имя -> содержимое
function readZip(buf) {
    const eocd64 = buf.length - 22 - 20 - 56;
    assert.strictEqual(buf.readUInt32LE(eocd64), 0x06064b50, 'запись ZIP64 на месте');
    const count = Number(buf.readBigUInt64LE(eocd64 + 32));
    let at = Number(buf.readBigUInt64LE(eocd64 + 48));
    const files = new Map();
    for (let i = 0; i < count; i++) {
        assert.strictEqual(buf.readUInt32LE(at), 0x02014b50);
        const crc = buf.readUInt32LE(at + 16);
        const nl = buf.readUInt16LE(at + 28);
        const name = buf.toString('utf8', at + 46, at + 46 + nl);
        const x = at + 46 + nl;
        const size = Number(buf.readBigUInt64LE(x + 4));
        const off = Number(buf.readBigUInt64LE(x + 20));
        const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
        const data = buf.subarray(start, start + size);
        assert.strictEqual(require('zlib').crc32(data), crc, `CRC ${name}`);
        files.set(name, data);
        at = x + buf.readUInt16LE(at + 30);
    }
    return files;
}

test('архив игры с сейвами: сейвы Mimikin лежат там, где их читает движок, заменяют файл игры, длина сходится', async () => {
    const ID = 'Archive_Saves_Game';
    const dir = path.join(root, ID);
    const savesDir = path.join(root, '_saves', ID);
    fs.mkdirSync(path.join(dir, 'www', 'save'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'www', 'index.html'), '<title>A</title>');
    fs.writeFileSync(path.join(dir, 'www', 'save', 'file1.rpgsave'), 'старый сейв из папки игры');
    fs.writeFileSync(path.join(dir, 'www', 'save', 'file2.rpgsave'), 'второй из папки игры');
    fs.mkdirSync(savesDir, { recursive: true });
    const put = (key, v) => fs.writeFileSync(path.join(savesDir, `${encodeURIComponent(key)}.json`), v);
    put('RPG File1', 'сейв Mimikin 1');
    put('RPG Global', 'глобальный');
    put('RPG File1bak', 'копия слота');
    put('MZ_file3', 'mz');
    await dbService.get().run(
        `INSERT INTO games (id, title, cover, tags, description, rating, lastPlayed, addedAt, scraped, ready, size, meta_status)
         VALUES (?, 'Saves Game', '', '[]', '', 0, 0, ?, 1, 1, 1024, 'ok')`, [ID, Date.now()]);
    const fetchZip = (url, method = 'GET') => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { cookie: `${COOKIE}=${cookie}` } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });

    assert.deepStrictEqual((await call('GET', `/api/games/${ID}/archive-info`)).data, { saves: 3 }, 'считаются слоты и общие файлы, копия слота нет');
    assert.deepStrictEqual((await call('GET', '/api/games/Archive_Game/archive-info')).data, { saves: 0 });

    const plain = await fetchZip(`/api/games/${ID}/archive`);
    const plainFiles = readZip(plain.body);
    assert.strictEqual(plainFiles.get(`${ID}/www/save/file1.rpgsave`).toString(), 'старый сейв из папки игры', 'без ?saves=1 — только файлы игры');
    assert.ok(![...plainFiles.keys()].some((n) => n.endsWith('.rmmzsave')));

    const withSaves = await fetchZip(`/api/games/${ID}/archive?saves=1`);
    assert.strictEqual(Number(withSaves.res.headers['content-length']), withSaves.body.length, 'длина учитывает сейвы');
    const head = await fetchZip(`/api/games/${ID}/archive?saves=1`, 'HEAD');
    assert.strictEqual(Number(head.res.headers['content-length']), withSaves.body.length);
    const files = readZip(withSaves.body);
    const text = (n) => files.get(`${ID}/${n}`)?.toString();
    assert.strictEqual(text('www/save/file1.rpgsave'), 'сейв Mimikin 1', 'сейв Mimikin заменил файл игры');
    assert.strictEqual(text('www/save/file2.rpgsave'), 'второй из папки игры', 'чужие файлы остались');
    assert.strictEqual(text('www/save/global.rpgsave'), 'глобальный');
    assert.strictEqual(text('www/save/file3.rmmzsave'), 'mz');
    assert.ok(![...files.keys()].some((n) => /bak/i.test(n)), 'копия слота не попала');
    assert.strictEqual([...files.keys()].filter((n) => n.toLowerCase() === `${ID}/www/save/file1.rpgsave`.toLowerCase()).length, 1, 'одноимённых записей нет');

    // Игра без папки www: save/ рядом с index.html
    fs.mkdirSync(path.join(root, 'Archive_Flat'));
    fs.writeFileSync(path.join(root, 'Archive_Flat', 'index.html'), 'x');
    fs.mkdirSync(path.join(root, '_saves', 'Archive_Flat'), { recursive: true });
    fs.writeFileSync(path.join(root, '_saves', 'Archive_Flat', `${encodeURIComponent('MZ_file1')}.json`), 'flat');
    await dbService.get().run(
        `INSERT INTO games (id, title, cover, tags, description, rating, lastPlayed, addedAt, scraped, ready, size, meta_status)
         VALUES ('Archive_Flat', 'Flat', '', '[]', '', 0, 0, ?, 1, 1, 1, 'ok')`, [Date.now()]);
    const flat = readZip((await fetchZip('/api/games/Archive_Flat/archive?saves=1')).body);
    assert.strictEqual(flat.get('Archive_Flat/save/file1.rmmzsave')?.toString(), 'flat');
});
