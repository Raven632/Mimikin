// Текст в stdout тестового файла ломает запускатель: Node разбирает этот поток как свои сообщения, и строка с кириллицей или
// эмодзи, пришедшая одним куском с сообщением, даёт «Unable to deserialize cloned data» и срывает весь файл (то в CI, то нет,
// как повезёт с кусками). Журнал приложения поэтому идёт в stderr. Ставим до загрузки приложения
console.log = console.info = console.debug = console.error;

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

// Ключ сессии — из базы, как без .env: он подписывает адреса игр, но в куке его больше нет
delete process.env.SESSION_SECRET;

// Модель распознавания картинок галереи (85 МБ) тесты не качают
process.env.GALLERY_VISION = '0';

// Запросов тесты делают почти на весь предел ограничителя API (200) — с запасом, иначе новый тест роняет последние
process.env.API_RATE_LIMIT = '2000';

// Игры — на своём адресе, как в проде
delete process.env.GAME_ISOLATION;

process.env.GAME_PORT = '8081';

// Своя база Redis (номер 15): в dev тот же Redis обслуживает живой сервер, и его кэш списка игр
// не должен смешиваться с тестовым
const redisUrl = new URL(process.env.REDIS_URL || 'redis://redis:6379');

redisUrl.pathname = '/15';

process.env.REDIS_URL = redisUrl.toString();

const { app, io, server: ioServer } = require('./server.js');

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
    // Часть служб ходит модулем https, а не fetch: иначе тесты спрашивали бы настоящие сайты, и их отказ
    // (пауза службы на 10 минут) делал ответы разными между прогонами
    const https = require('https');
    https.get = https.request = () => { throw new Error('сеть в тестах HTTP-слоя не используется'); };
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
    assert.ok(value.length >= 64, 'кука со входом этого устройства');
    assert.notStrictEqual(value, dbService.getSessionToken(), 'общий ключ сессии в куку не попадает');
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

test('сервер игр: перед рамкой страница спрашивает /ready — эта ли библиотека на адресе игр', async () => {
    const { createGameApp } = require('./src/routes/play.js');
    const play = (await call('POST', `/api/play/${GAME}`)).data;
    assert.strictEqual(play.mode, 'frame');
    assert.strictEqual(play.check, play.path.replace(/^\/g\//, '/ready/').replace(/\/$/, ''), 'тот же ключ, что и в адресе игры');

    const listen = async (secret) => {
        const srv = createGameApp({ secret, store: { list: async () => [] }, publicDir: path.join(__dirname, 'public') }).listen(0, '127.0.0.1');
        await new Promise((r) => srv.once('listening', r));
        return srv;
    };
    const get = (srv, url) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: srv.address().port, path: url }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
    });
    const ours = await listen(() => dbService.getSessionToken());
    const other = await listen(() => 'ключ другой установки');
    try {
        const ok = await get(ours, play.check);
        assert.deepStrictEqual([ok.status, JSON.parse(ok.body)], [200, { mimikin: true }]);
        assert.strictEqual(ok.headers['access-control-allow-origin'], '*', 'спрашивает страница с другого адреса');
        assert.strictEqual(ok.headers['set-cookie'], undefined);
        // Другая установка на этом порту: страница должна прочитать отказ, поэтому CORS есть и у него
        const foreign = await get(other, play.check);
        assert.strictEqual(foreign.status, 403);
        assert.strictEqual(foreign.headers['access-control-allow-origin'], '*');
        assert.strictEqual((await get(ours, `/ready/${'0'.repeat(32)}/${GAME}`)).status, 403);
        assert.strictEqual((await get(ours, `/ready/${'0'.repeat(32)}/..%2F..`)).status, 403);
        // CORS — только у этого ответа: остальному на сервере игр он не нужен
        assert.strictEqual((await get(ours, `/saves/${play.check.split('/')[2]}/${GAME}`)).headers['access-control-allow-origin'], undefined);
    } finally {
        ours.close();
        other.close();
    }
});

test('за прокси (TRUST_PROXY): адрес посетителя и HTTPS — из заголовков, только если им верим', async () => {
    const WRONG = { json: { username: USER, password: 'not it' }, auth: false };
    const left = (res) => Number(res.headers['ratelimit-remaining']);
    const secure = (res) => /;\s*secure/i.test(cookieFrom(res).line);
    const https = { 'x-forwarded-proto': 'https' };
    const loginVia = (headers) => call('POST', '/api/login', { json: { username: USER, password: PASS }, auth: false, headers });

    // По умолчанию не верим: X-Forwarded-For пишет сам посетитель, подменой счётчик попыток не сбросить, а по HTTP кука без Secure
    const first = await call('POST', '/api/login', { ...WRONG, headers: { 'x-forwarded-for': '198.51.100.1' } });
    const second = await call('POST', '/api/login', { ...WRONG, headers: { 'x-forwarded-for': '198.51.100.2' } });
    assert.strictEqual(first.status, 401);
    assert.strictEqual(left(second), left(first) - 1, 'подделанный адрес считается вместе с настоящим');
    assert.strictEqual(secure(await loginVia(https)), false, 'подделанный X-Forwarded-Proto не делает куку Secure');
    assert.strictEqual(secure(await loginVia({})), false);

    app.set('trust proxy', 1);
    try {
        // Каждому посетителю за прокси — свой счётчик
        const a = await call('POST', '/api/login', { ...WRONG, headers: { 'x-forwarded-for': '198.51.100.11' } });
        const a2 = await call('POST', '/api/login', { ...WRONG, headers: { 'x-forwarded-for': '198.51.100.11' } });
        const b = await call('POST', '/api/login', { ...WRONG, headers: { 'x-forwarded-for': '198.51.100.12' } });
        assert.deepStrictEqual([left(a), left(a2), left(b)], [9, 8, 9]);
        // Посетитель дописал адрес от себя: прокси ставит настоящий последним, берётся он
        const spoof = await call('POST', '/api/login', { ...WRONG, headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.11' } });
        assert.strictEqual(left(spoof), 7);

        assert.strictEqual(secure(await loginVia(https)), true, 'HTTPS у прокси — кука Secure');
        assert.strictEqual(secure(await loginVia({ 'x-forwarded-proto': 'http' })), false, 'домашняя сеть по HTTP: с Secure браузер куку не сохранит');
        assert.strictEqual(secure(await loginVia({})), false);
    } finally {
        app.set('trust proxy', false);
    }
});

test('страница за прокси на порту, совпавшем с GAME_PORT: браузер с Sec-Fetch-Site пропускаем', async () => {
    const games = async (headers) => (await call('GET', '/api/games', { headers })).status;
    assert.strictEqual(await games({ 'sec-fetch-site': 'same-origin', origin: 'https://library.example:8081' }), 200);
    assert.strictEqual(await games({ 'sec-fetch-site': 'same-site', origin: 'https://games.example:8081' }), 403);
    assert.strictEqual(await games({ origin: 'null' }), 403, 'старый браузер, страница в песочнице');
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
    const other = cookieFrom(await login()).value;
    const res = await call('POST', '/api/account/password', { json: { current: PASS, next: NEW } });
    assert.deepStrictEqual([res.status, res.data.otherDevicesSignedOut], [200, true]);
    assert.strictEqual(cookieFrom(res).value, '', 'это устройство остаётся с прежней кукой');
    assert.strictEqual((await call('GET', '/api/games')).status, 200, 'это устройство — со входом');
    assert.strictEqual((await call('GET', '/api/games', { headers: { cookie: `${COOKIE}=${other}` }, auth: false })).status, 401, 'другое устройство — нет');
    assert.strictEqual((await login(NEW)).status, 200);
    // Вернуть как было — следующим проверкам нужен прежний пароль
    const back = await call('POST', '/api/account/password', { json: { current: NEW, next: PASS } });
    assert.strictEqual(back.status, 200);
    assert.strictEqual((await call('GET', '/api/games')).status, 200);
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
    const saved = await call('POST', '/api/settings/favorite-tags', { json: { tags: ['Pixel Art', 'pixel art', ' RPG ', '', 'x'.repeat(41), ...many] } });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.data.tags.slice(0, 3), ['pixel art', 'rpg', 'tag 0']);
    assert.strictEqual(saved.data.tags.length, 20);
    assert.strictEqual((await call('POST', '/api/settings/favorite-tags', { json: { tags: 'rpg' } })).status, 400);
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

test('«На полку»: файлы — в корзину, карточка в списке с пометкой; обложка из папки — копией в _media; «Вернуть» и удаление карточки', async () => {
    const ID = 'Shelf_Game';
    const dir = path.join(root, ID);
    fs.mkdirSync(path.join(dir, 'www'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'www', 'index.html'), 'x');
    fs.writeFileSync(path.join(dir, 'cover.jpg'), 'jpeg');
    await dbService.get().run("INSERT INTO games (id, title, cover, playtime, addedAt, ready) VALUES (?, 'Shelf Game', ?, 900, 1, 1)", [ID, `${ID}/cover.jpg`]);

    assert.strictEqual((await call('POST', '/api/games/Nope_Game/shelf')).status, 404);
    const res = await call('POST', `/api/games/${ID}/shelf`);
    assert.strictEqual(res.status, 200);
    const key = res.data.trashKey;
    assert.ok(!fs.existsSync(dir), 'папки в библиотеке нет');
    assert.ok(fs.existsSync(path.join(root, '_trash', key, 'game', 'www', 'index.html')), 'файлы — в корзине');
    const row = await dbService.get().get('SELECT cover, playtime, shelved_at FROM games WHERE id = ?', [ID]);
    assert.match(row.cover, /^_media\/Shelf_Game\/cover-[0-9a-f]{10}\.jpg$/, 'обложка — уже не из папки игры');
    assert.strictEqual(fs.readFileSync(path.join(root, row.cover), 'utf8'), 'jpeg');
    assert.strictEqual(row.playtime, 900);

    const listed = (await call('GET', '/api/games')).data.find((g) => g.id === ID);
    assert.deepStrictEqual(listed.shelf, { at: row.shelved_at, key, until: row.shelved_at + 30 * 864e5 }, 'в списке — с пометкой и сроком файлов');
    assert.strictEqual((await call('GET', '/api/games')).data.find((g) => g.id === GAME).shelf, null);
    // Второй раз на полку — папки нет
    assert.strictEqual((await call('POST', `/api/games/${ID}/shelf`)).status, 404);

    assert.strictEqual((await call('POST', `/api/games/trash/${key}/restore`)).status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'www', 'index.html')));
    assert.strictEqual((await call('GET', '/api/games')).data.find((g) => g.id === ID).shelf, null, 'вернули — снова игра');

    // Файлы с полки стёрли — карточка остаётся, вернуть её нечем: только «Скачать снова» или свой архив
    const again = (await call('POST', `/api/games/${ID}/shelf`)).data.trashKey;
    assert.strictEqual((await call('DELETE', `/api/games/trash/${again}`)).status, 200);
    assert.strictEqual((await call('GET', '/api/games')).data.find((g) => g.id === ID).shelf.key, '');

    // Удалить карточку с полки можно и без папки и без файлов
    const del = await call('DELETE', `/api/games/${ID}`);
    assert.strictEqual(del.status, 200);
    assert.ok(!(await call('GET', '/api/games')).data.some((g) => g.id === ID));
    assert.deepStrictEqual((await call('GET', '/api/games/trash')).data.items.filter((i) => i.id === ID).map((i) => [i.key, i.shelf]), [[del.data.trashKey, false]]);
    await call('DELETE', `/api/games/trash/${del.data.trashKey}`);
});

test('«Похоже, это … с полки»: новая игра с тем же названием — вопрос в списке; «это она» ставит её файлы на место игры с полки, «нет» помнится', async () => {
    const OLD = 'Lantern_Old_v1';
    const NEW = 'Lantern_Old_v2';
    const NEW2 = 'Lantern_Third';
    const make = (id) => { fs.mkdirSync(path.join(root, id, 'www'), { recursive: true }); fs.writeFileSync(path.join(root, id, 'www', 'index.html'), id); };
    make(OLD);
    await dbService.get().run("INSERT INTO games (id, title, playtime, status, rating, addedAt, ready) VALUES (?, 'Lantern Old', 7200, 'playing', 5, 1, 1)", [OLD]);
    const shelfKey = (await call('POST', `/api/games/${OLD}/shelf`)).data.trashKey;
    // Загрузили заново как новую — та же игра новой версией
    make(NEW);
    await dbService.get().run("INSERT INTO games (id, title, playtime, rating, favorite, addedAt, ready, series) VALUES (?, 'Lantern Old v2', 60, 3, 1, ?, 1, 'none')", [NEW, Date.now() + 1000]);
    await dbService.get().run("INSERT INTO gallery_favorites (game_id, file, kind, at) VALUES (?, 'img/pictures/a.png', 'image', 1)", [NEW]);
    const listed = (await call('GET', '/api/games')).data.find((g) => g.id === NEW);
    assert.deepStrictEqual(listed.shelfMatch, { id: OLD, title: 'Lantern Old', playtime: 7200, why: ['name'] });

    // Свои сейвы у новой — не спрашиваем: перенос смешал бы два прохождения
    fs.mkdirSync(path.join(root, '_saves', NEW), { recursive: true });
    fs.writeFileSync(path.join(root, '_saves', NEW, 'file1.rpgsave'), 'x');
    await require('./src/utils/cache.js').invalidateGamesList();
    assert.strictEqual((await call('GET', '/api/games')).data.find((g) => g.id === NEW).shelfMatch, null);
    assert.strictEqual((await call('POST', `/api/games/${NEW}/shelf-match`, { json: { into: OLD, accept: true } })).status, 409);
    fs.rmSync(path.join(root, '_saves', NEW), { recursive: true });

    // «Это она»: файлы новой — на месте игры с полки; её время, статус и оценка — при ней; прежние файлы с полки — в _old
    const yes = await call('POST', `/api/games/${NEW}/shelf-match`, { json: { into: OLD, accept: true } });
    assert.deepStrictEqual([yes.status, yes.data.id], [200, OLD]);
    assert.strictEqual(fs.readFileSync(path.join(root, OLD, 'www', 'index.html'), 'utf8'), NEW, 'в папке — новая версия');
    assert.ok(!fs.existsSync(path.join(root, NEW)));
    const back = await dbService.get().get('SELECT playtime, status, rating, favorite, shelved_at, series FROM games WHERE id = ?', [OLD]);
    assert.deepStrictEqual({ ...back }, { playtime: 7260, status: 'playing', rating: 5, favorite: 1, shelved_at: 0, series: '' }, 'своя оценка у игры с полки главнее, отметка «избранное» — с новой, а «не серия» другой копии — не переходит');
    assert.deepStrictEqual((await dbService.get().all('SELECT game_id, file FROM gallery_favorites WHERE game_id IN (?, ?)', [OLD, NEW])).map((r) => ({ ...r })),
        [{ game_id: OLD, file: 'img/pictures/a.png' }], 'избранные картинки новой — у неё');
    assert.strictEqual(await dbService.get().get('SELECT id FROM games WHERE id = ?', [NEW]), undefined, 'строки новой нет');
    assert.ok(!fs.existsSync(path.join(root, '_trash', shelfKey)), 'запись с полки ушла из корзины');
    const old = fs.readdirSync(path.join(root, '_old', OLD)).filter((f) => !f.endsWith('.json'));
    assert.strictEqual(fs.readFileSync(path.join(root, '_old', OLD, old[0], 'www', 'index.html'), 'utf8'), OLD, 'прежние файлы — прежней версией');

    // «Нет, это другая»: больше не спрашиваем
    await call('POST', `/api/games/${OLD}/shelf`);
    make(NEW2);
    await dbService.get().run("INSERT INTO games (id, title, addedAt, ready) VALUES (?, 'Lantern Old', ?, 1)", [NEW2, Date.now() + 1000]);
    assert.strictEqual((await call('GET', '/api/games')).data.find((g) => g.id === NEW2).shelfMatch.id, OLD);
    assert.strictEqual((await call('POST', `/api/games/${NEW2}/shelf-match`, { json: { into: OLD } }).then((r) => r.status)), 200);
    assert.strictEqual((await call('GET', '/api/games')).data.find((g) => g.id === NEW2).shelfMatch, null);
    assert.strictEqual((await call('POST', `/api/games/${NEW2}/shelf-match`, { json: { into: 'Nope' } })).status, 404);

    for (const id of [OLD, NEW2]) {
        const del = await call('DELETE', `/api/games/${id}`);
        await call('DELETE', `/api/games/trash/${del.data.trashKey}`);
    }
    fs.rmSync(path.join(root, '_old', OLD), { recursive: true, force: true });
    await dbService.get().run('DELETE FROM gallery_favorites WHERE game_id = ?', [OLD]);
});

test('восстановление из копии: данные игр и сейвы — из копии, нынешние — в корзину и историю, вход прежний', { skip: !hasSevenZip() && 'нет 7zz' }, async () => {
    const db = dbService.get();
    const slot = path.join(root, '_saves', GAME, `${encodeURIComponent('RPG File1')}.json`);
    fs.mkdirSync(path.dirname(slot), { recursive: true });
    const playedBefore = (await db.get('SELECT playtime FROM games WHERE id = ?', [GAME])).playtime;
    await db.run("UPDATE games SET rating = 2, status = 'playing', playtime = 1000 WHERE id = ?", [GAME]);
    fs.writeFileSync(slot, 'A');
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('restore_probe', 'old')");
    await db.run("INSERT INTO play_days VALUES ('owner', ?, '2026-01-01', 60), ('owner', ?, '2026-01-02', 70), ('owner', 'Ghost_Days', '2026-01-01', 5)", [GAME, GAME]);
    const backup = await call('GET', '/api/backup');
    assert.strictEqual(backup.status, 200);
    await db.run("DELETE FROM play_days WHERE day = '2026-01-01'");
    await db.run("UPDATE play_days SET seconds = 99 WHERE day = '2026-01-02'");

    // После копии всё поменялось
    await db.run("UPDATE games SET rating = 5, status = 'completed', playtime = 1500 WHERE id = ?", [GAME]);
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
    assert.deepStrictEqual((await db.all("SELECT game_id, day, seconds FROM play_days WHERE day LIKE '2026-01-%' ORDER BY day")).map((r) => ({ ...r })),
        [{ game_id: GAME, day: '2026-01-01', seconds: 60 }, { game_id: GAME, day: '2026-01-02', seconds: 99 }], 'дни из копии вернулись, своя строка осталась, игры без строки нет');
    await db.run("DELETE FROM play_days WHERE day LIKE '2026-01-%'");
    assert.strictEqual((await db.get('SELECT playtime FROM games WHERE id = ?', [GAME])).playtime, 1500, 'время не откатилось: иначе те же часы записались бы в день ещё раз');
    await db.run('UPDATE games SET playtime = ? WHERE id = ?', [playedBefore, GAME]);
    assert.strictEqual((await db.get("SELECT value FROM settings WHERE key = 'admin_pass'")).value, passBefore, 'пароль — нынешний');
    assert.strictEqual((await call('GET', '/api/games')).status, 200, 'вход — прежний');
    assert.ok(fs.existsSync(path.join(root, '_trash', res.data.keptKey, path.basename(fs.readdirSync(path.join(root, '_trash', res.data.keptKey)).find((f) => f.endsWith('.db'))))), 'прежняя база — в корзине');
});

test('восстановление из копии: перевод и картинки возвращаются, новое на сервере и своё остаются, чужие игры и секреты — нет', { skip: !hasSevenZip() && 'нет 7zz' }, async () => {
    const db = dbService.get();
    const { SECRETS } = require('./src/utils/secrets.js');
    const { unpackBackup, PRIVATE_SETTINGS } = require('./src/routes/backup.js');
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const translate = require('./src/services/translate.js');
    const GHOST = 'Ghost_Game';
    const line = (src, text, origin, at) => db.run('INSERT OR REPLACE INTO translations (src, lang, text, engine, origin, at) VALUES (?, \'ru\', ?, \'deepl\', ?, ?)', [src, text, origin, at]);
    const text = async (src) => (await db.get('SELECT text FROM translations WHERE src = ? AND lang = \'ru\'', [src]))?.text;
    const KEPT = '[{"src":"a","checked":true}]';
    const key = SECRETS.deepl.setting;
    await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, 'enc1:probe']);

    await line('rt back', 'из копии', 'machine', 100);
    await line('rt newer here', 'копия', 'machine', 100);
    await line('rt newer there', 'копия новее', 'machine', 300);
    await line('rt own there', 'своё из копии', 'import', 100);
    await line('rt own here', 'машинное из копии', 'machine', 900);
    await line('rt failed', '', 'failed', 100);
    await line('rt failed here', 'нашлось в копии', 'machine', 100);
    await db.run("INSERT INTO game_translation (id, lang, state, done, total, at) VALUES (?, 'ru', 'running', 5, 10, 100), (?, 'ru', 'done', 1, 1, 100)", [GAME, GHOST]);
    await db.run("INSERT INTO picture_text (sha1, version, labels, at) VALUES ('rt1', 1, '[{\"src\":\"x\"}]', 100), ('rt2', 1, ?, 100), ('rt3', 1, '[]', 100)", [KEPT]);
    await db.run('INSERT INTO picture_patches (hash, png) VALUES (?, ?)', ['rtpatch', PNG]);
    await db.run("INSERT INTO game_pictures (game_id, key, rel, sha1, size, mtime, kind) VALUES (?, 'img/a', 'img/a.png', 'rt1', 1, 1, 'ui'), (?, 'img/a', 'img/a.png', 'rt1', 1, 1, 'ui')", [GAME, GHOST]);
    await db.run("INSERT INTO picture_jobs (game_id, state, at) VALUES (?, 'queued', 100), (?, 'done', 100)", [GAME, GHOST]);
    await db.run("INSERT INTO gallery_favorites (game_id, file, kind, at) VALUES (?, 'rt.png', 'image', 100), (?, 'rt.png', 'image', 100)", [GAME, GHOST]);

    const backup = await call('GET', '/api/backup');
    assert.strictEqual(backup.status, 200);
    // В самом файле копии — перевод есть, ключей нет
    const dir = fs.mkdtempSync(path.join(root, '_tmp_rt'));
    fs.writeFileSync(path.join(dir, 'copy.zip'), backup.raw);
    const unpacked = await unpackBackup(path.join(dir, 'copy.zip'), path.join(dir, 'out'));
    const inside = await open({ filename: path.join(unpacked, 'library.db'), driver: sqlite3.Database });
    assert.strictEqual((await inside.get("SELECT text FROM translations WHERE src = 'rt back'")).text, 'из копии');
    const left = await inside.all(`SELECT key FROM settings WHERE key IN (${PRIVATE_SETTINGS.map(() => '?').join(', ')})`, PRIVATE_SETTINGS);
    assert.deepStrictEqual(left, [], 'ни входа, ни ключей');
    await inside.close();
    fs.rmSync(dir, { recursive: true, force: true });

    // После копии: что-то пропало, что-то поменялось
    await db.run("DELETE FROM translations WHERE src IN ('rt back', 'rt failed')");
    await line('rt newer here', 'свежее', 'machine', 200);
    await line('rt newer there', 'старое', 'machine', 200);
    await line('rt own there', 'машинное новее', 'machine', 500);
    await line('rt own here', 'своё старее', 'import', 100);
    await line('rt failed here', '', 'failed', 500);
    await db.run('DELETE FROM game_translation WHERE id IN (?, ?)', [GAME, GHOST]);
    await db.run("DELETE FROM picture_text WHERE sha1 = 'rt1'");
    await db.run("UPDATE picture_text SET labels = '[]', at = 500 WHERE sha1 = 'rt2'");
    await db.run("UPDATE picture_text SET labels = '[{\"src\":\"mine\"}]', at = 500 WHERE sha1 = 'rt3'");
    await db.run("DELETE FROM picture_patches WHERE hash = 'rtpatch'");
    await db.run('DELETE FROM game_pictures WHERE game_id = ?', [GHOST]);
    await db.run("UPDATE game_pictures SET sha1 = 'now' WHERE game_id = ? AND key = 'img/a'", [GAME]);
    await db.run('DELETE FROM picture_jobs WHERE game_id IN (?, ?)', [GAME, GHOST]);
    await db.run('DELETE FROM gallery_favorites WHERE game_id IN (?, ?)', [GAME, GHOST]);
    await db.run('UPDATE settings SET value = ? WHERE key = ?', ['enc1:now', key]);
    const version = translate.version;

    const res = await upload('/api/backup/restore', 'backup', 'copy.zip', backup.raw);
    assert.strictEqual(res.status, 200, JSON.stringify(res.data));

    assert.strictEqual(await text('rt back'), 'из копии');
    assert.strictEqual(await text('rt newer here'), 'свежее', 'своя строка новее копии');
    assert.strictEqual(await text('rt newer there'), 'копия новее', 'в копии новее');
    assert.strictEqual(await text('rt own there'), 'своё из копии', 'своё из копии главнее машинного при любой дате');
    assert.strictEqual(await text('rt own here'), 'своё старее', 'машинное из копии своё не заменяет');
    assert.strictEqual(await text('rt failed'), undefined, 'отметка «не вышло» — не работа');
    assert.strictEqual(await text('rt failed here'), 'нашлось в копии', 'настоящий перевод вместо своей отметки «не вышло»');
    assert.ok(translate.version > version, 'словари в памяти перечитаются');

    const tr = await db.all('SELECT id, state, done FROM game_translation WHERE id IN (?, ?)', [GAME, GHOST]);
    assert.deepStrictEqual(tr.map((r) => ({ ...r })), [{ id: GAME, state: 'paused', done: 5 }], 'задача из копии — на паузе, игры без строки в библиотеке нет');
    assert.deepStrictEqual((await db.all('SELECT game_id, state FROM picture_jobs WHERE game_id IN (?, ?)', [GAME, GHOST])).map((r) => ({ ...r })), [{ game_id: GAME, state: 'paused' }]);
    assert.deepStrictEqual((await db.all('SELECT game_id, sha1 FROM game_pictures WHERE game_id IN (?, ?)', [GAME, GHOST])).map((r) => ({ ...r })), [{ game_id: GAME, sha1: 'now' }], 'строка про файл в папке — своя');
    assert.deepStrictEqual((await db.all("SELECT game_id FROM gallery_favorites WHERE file = 'rt.png'")).map((r) => r.game_id), [GAME]);
    assert.strictEqual((await db.get("SELECT labels FROM picture_text WHERE sha1 = 'rt1'")).labels, '[{"src":"x"}]');
    assert.strictEqual((await db.get("SELECT labels FROM picture_text WHERE sha1 = 'rt2'")).labels, KEPT, 'правка из копии главнее машинного разбора');
    assert.strictEqual((await db.get("SELECT labels FROM picture_text WHERE sha1 = 'rt3'")).labels, '[{"src":"mine"}]', 'разбор новее копии');
    assert.ok((await db.get("SELECT png FROM picture_patches WHERE hash = 'rtpatch'")).png.equals(PNG));
    assert.strictEqual((await db.get('SELECT value FROM settings WHERE key = ?', [key])).value, 'enc1:now', 'ключ — нынешний');

    await db.run("DELETE FROM translations WHERE src LIKE 'rt %'");
    await db.run('DELETE FROM game_translation WHERE id = ?', [GAME]);
    await db.run("DELETE FROM picture_text WHERE sha1 LIKE 'rt%'");
    await db.run("DELETE FROM picture_patches WHERE hash = 'rtpatch'");
    await db.run('DELETE FROM game_pictures WHERE game_id = ?', [GAME]);
    await db.run('DELETE FROM picture_jobs WHERE game_id = ?', [GAME]);
    await db.run("DELETE FROM gallery_favorites WHERE file = 'rt.png'");
    await db.run('DELETE FROM settings WHERE key = ?', [key]);
});

test('переезд: игра без папки встаёт на полку со всем своим; загруженный архив и возвращённая папка становятся на её место, сейвы остаются', { skip: !hasSevenZip() && 'нет 7zz' }, async (t) => {
    const db = dbService.get();
    t.mock.method(require('./src/services/scraper.js'), 'requestScrape', async () => 0);
    const ARCHIVED = 'Moved_Lantern_v1';
    const DROPPED = 'Moved_Harbor_v1';
    const EARLY = 'Harbor_Uploaded_Early';
    const cardOf = async (id) => {
        await require('./src/utils/cache.js').invalidateGamesList();
        return (await call('GET', '/api/games')).data.find((g) => g.id === id);
    };
    const saveOf = (id) => path.join(root, '_saves', id, `${encodeURIComponent('RPG File1')}.json`);
    const markOf = (id) => path.join(root, '_saves', '.marks', id, 'moment.json');
    for (const id of [ARCHIVED, DROPPED]) {
        fs.mkdirSync(path.join(root, id, 'www'), { recursive: true });
        fs.writeFileSync(path.join(root, id, 'www', 'index.html'), 'x');
        fs.mkdirSync(path.dirname(saveOf(id)), { recursive: true });
        fs.writeFileSync(saveOf(id), `save of ${id}`);
        fs.mkdirSync(path.dirname(markOf(id)), { recursive: true });
        fs.writeFileSync(markOf(id), `moment of ${id}`);
    }
    fs.mkdirSync(path.join(root, '_media', ARCHIVED), { recursive: true });
    fs.writeFileSync(path.join(root, '_media', ARCHIVED, 'cover-aaaaaaaaaa.png'), PNG);
    fs.writeFileSync(path.join(root, '_media', ARCHIVED, 'shot.png'), PNG);
    await db.run(`INSERT INTO games (id, title, cover, screens, playtime, status, notes, lists, rating, addedAt, ready, scraped, size, meta_status)
        VALUES (?, 'Moved Lantern', ?, ?, 7200, 'playing', 'у моста', '["Потом"]', 4, 1, 1, 1, 5000, 'ok')`,
    [ARCHIVED, `_media/${ARCHIVED}/cover-aaaaaaaaaa.png`, JSON.stringify([`_media/${ARCHIVED}/shot.png`])]);
    await db.run(`INSERT INTO games (id, title, cover, playtime, addedAt, ready, scraped, meta_status) VALUES (?, 'Moved Harbor', ?, 600, 1, 1, 1, 'ok')`, [DROPPED, `${DROPPED}/cover.jpg`]);

    const backup = await call('GET', '/api/backup');
    assert.strictEqual(backup.status, 200);
    // Время в архиве — с точностью до двух секунд: загруженная после копии должна быть точно позже
    await new Promise((resolve) => setTimeout(resolve, 2100));

    // Новая установка: ни папок, ни _media, ни сейвов этих игр. Одну игру успели загрузить ещё до восстановления
    for (const id of [ARCHIVED, DROPPED]) {
        fs.rmSync(path.join(root, id), { recursive: true, force: true });
        fs.rmSync(path.join(root, '_saves', id), { recursive: true, force: true });
        fs.rmSync(path.join(root, '_saves', '.marks', id), { recursive: true, force: true });
        fs.rmSync(path.join(root, '_media', id), { recursive: true, force: true });
        await db.run('DELETE FROM games WHERE id = ?', [id]);
    }
    fs.mkdirSync(path.join(root, EARLY, 'www'), { recursive: true });
    await db.run("INSERT INTO games (id, title, addedAt, ready) VALUES (?, 'Moved Harbor', ?, 1)", [EARLY, Date.now()]);

    const res = await upload('/api/backup/restore', 'backup', 'copy.zip', backup.raw);
    assert.strictEqual(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.shelved.includes(ARCHIVED) && res.data.shelved.includes(DROPPED), 'итог называет игры на полке');
    assert.ok(res.data.games >= 1, 'и считает вернувшиеся с файлами');

    const card = await cardOf(ARCHIVED);
    assert.ok(card.shelf.at > 0 && card.shelf.at <= Date.now());
    assert.strictEqual(card.shelf.key, '', 'файлов в корзине нет');
    assert.strictEqual(card.cover, null, 'файла обложки нет — пустая обложка, а не сломанная картинка');
    assert.deepStrictEqual(card.screens, []);
    assert.deepStrictEqual([card.playtime, card.status, card.notes, card.lists, card.rating, card.size], [7200, 'playing', 'у моста', ['Потом'], 4, 5000]);
    assert.strictEqual(fs.readFileSync(saveOf(ARCHIVED), 'utf8'), `save of ${ARCHIVED}`, 'сейвы — при карточке');
    assert.strictEqual(fs.readFileSync(markOf(ARCHIVED), 'utf8'), `moment of ${ARCHIVED}`, 'моменты — при карточке');
    assert.strictEqual((await cardOf(EARLY)).shelfMatch.id, DROPPED, 'загруженная до восстановления, но после копии, — тоже спрашивает');
    await db.run('DELETE FROM games WHERE id = ?', [EARLY]);
    fs.rmSync(path.join(root, EARLY), { recursive: true, force: true });

    // Настоящая загрузка архива с тем же именем: имя занято карточкой — новая папка рядом, и окно игры спрашивает «это она?»
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-move-'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'index.html'), 'new');
    fs.writeFileSync(path.join(dir, 'cover.jpg'), 'jpeg');
    fs.writeFileSync(path.join(dir, 'data', 'System.json'), JSON.stringify({ gameTitle: 'Moved Lantern' }));
    const zip = path.join(os.tmpdir(), `${path.basename(dir)}.zip`);
    require('child_process').execFileSync('7zz', ['a', '-tzip', '-bso0', '-bsp0', zip, './*'], { cwd: dir });
    const data = fs.readFileSync(zip);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    const started = await call('POST', '/api/games/upload/start', { json: { name: `${ARCHIVED}.zip`, size: data.length, fingerprint: 'moved1' } });
    assert.strictEqual(started.status, 200, JSON.stringify(started.data));
    assert.strictEqual((await call('POST', `/api/games/upload/chunk?id=${started.data.id}&offset=0`, { raw: data })).status, 200);
    let state = {};
    for (let i = 0; i < 200 && !['done', 'error'].includes(state.state); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = (await call('GET', `/api/games/upload/status?id=${started.data.id}`)).data;
    }
    assert.strictEqual(state.state, 'done', JSON.stringify(state));
    const uploaded = state.folder;
    assert.notStrictEqual(uploaded, ARCHIVED, 'имя карточки занято');
    assert.strictEqual((await cardOf(uploaded)).shelfMatch.id, ARCHIVED);

    const yes = await call('POST', `/api/games/${encodeURIComponent(uploaded)}/shelf-match`, { json: { into: ARCHIVED, accept: true } });
    assert.deepStrictEqual([yes.status, yes.data.id], [200, ARCHIVED]);
    const back = await cardOf(ARCHIVED);
    assert.strictEqual(back.shelf, null, 'снова игра');
    assert.strictEqual(fs.readFileSync(path.join(root, ARCHIVED, 'index.html'), 'utf8'), 'new');
    assert.deepStrictEqual([back.playtime, back.status, back.notes, back.lists], [7200, 'playing', 'у моста', ['Потом']]);
    assert.strictEqual(back.cover, `${ARCHIVED}/cover.jpg`, 'обложка — из вернувшихся файлов');
    assert.strictEqual(fs.readFileSync(saveOf(ARCHIVED), 'utf8'), `save of ${ARCHIVED}`, 'сейвы остались');
    assert.strictEqual(fs.readFileSync(markOf(ARCHIVED), 'utf8'), `moment of ${ARCHIVED}`, 'моменты остались');

    // Папку положили руками под тем же именем (вотчер зовёт addGameToDB) — карточка становится игрой
    fs.mkdirSync(path.join(root, DROPPED, 'www'), { recursive: true });
    fs.writeFileSync(path.join(root, DROPPED, 'cover.jpg'), 'jpeg');
    await dbService.addGameToDB(DROPPED, path.join(root, DROPPED), { copying: true });
    const dropped = await cardOf(DROPPED);
    assert.deepStrictEqual([dropped.shelf, dropped.cover, dropped.playtime], [null, `${DROPPED}/cover.jpg`, 600]);
    assert.strictEqual(fs.readFileSync(saveOf(DROPPED), 'utf8'), `save of ${DROPPED}`);

    for (const id of [ARCHIVED, DROPPED]) {
        const del = await call('DELETE', `/api/games/${id}`);
        await call('DELETE', `/api/games/trash/${del.data.trashKey}`);
        fs.rmSync(path.join(root, '_saves', id), { recursive: true, force: true });
        fs.rmSync(path.join(root, '_saves', '.marks', id), { recursive: true, force: true });
    }
});

test('восстановление из копии: имя игры, которое не годится для папки, в библиотеку не попадает', { skip: !hasSevenZip() && 'нет 7zz' }, async () => {
    const { restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const dir = fs.mkdtempSync(path.join(root, '_tmp_bad'));
    const db = await open({ filename: path.join(dir, 'library.db'), driver: sqlite3.Database });
    await db.exec("CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE wishlist (key TEXT PRIMARY KEY)");
    await db.run("INSERT INTO games VALUES ('../../outside', 'x'), ('_media', 'x'), ('.hidden', 'x'), ('Old_Copy_Game', 'Old')");
    await db.close();
    const res = await restoreBackup(dir, { trash, store: {} });
    assert.deepStrictEqual(res.shelved, ['Old_Copy_Game'], 'копия старой версии без новых таблиц и столбцов тоже читается');
    for (const id of ['../../outside', '_media', '.hidden']) assert.strictEqual(await dbService.get().get('SELECT id FROM games WHERE id = ?', [id]), undefined);
    await dbService.get().run("DELETE FROM games WHERE id = 'Old_Copy_Game'");
    fs.rmSync(dir, { recursive: true, force: true });
});

test('копии в ревизии: архив узнаётся как новая версия; план, склейка с сейвами, «Не дубликат» — и он переживает восстановление из копии', async () => {
    const make = (id) => { fs.mkdirSync(path.join(root, id, 'www'), { recursive: true }); fs.writeFileSync(path.join(root, id, 'www', 'index.html'), id); };
    const add = (id, playtime) => dbService.get().run("INSERT INTO games (id, title, playtime, addedAt, ready) VALUES (?, 'Copper Bell', ?, 1, 1)", [id, playtime]);
    const [V1, V2] = ['Copper_Bell_v1', 'Copper_Bell_v2'];
    for (const id of [V1, V2]) make(id);
    await add(V1, 60);
    await add(V2, 120);
    fs.mkdirSync(path.join(root, '_saves', V1), { recursive: true });
    fs.writeFileSync(path.join(root, '_saves', V1, 'RPG%20File1.json'), 'мой сейв');

    const match = await call('POST', '/api/games/upload-match', { json: { name: 'Copper_Bell_v3.zip' } });
    assert.deepStrictEqual([match.status, match.data.match?.title, match.data.match?.why], [200, 'Copper Bell', 'name']);
    assert.strictEqual((await call('POST', '/api/games/upload-match', { json: { name: 'Copper_Bell_2_v1.zip' } })).data.match, null, 'другая часть серии');

    const pairOf = async () => (await call('GET', '/api/games/audit')).data.duplicates.flatMap((g) => g.pairs).find((p) => p.games.some((x) => x.id === V1));
    assert.deepStrictEqual((await pairOf()).why, ['name']);
    const plan = await call('GET', `/api/games/duplicates/plan?a=${V1}&b=${V2}`);
    assert.deepStrictEqual([plan.status, plan.data.plans[V2].saves, plan.data.plans[V2].playtime], [200, 'move', 180]);

    // «Не дубликат» держится, а восстановление из копии его не теряет — и приносит ответ из копии
    assert.strictEqual((await call('POST', '/api/games/duplicates/dismiss', { json: { a: V2, b: V1 } })).status, 200);
    assert.strictEqual(await pairOf(), undefined);
    const { restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    const dir = fs.mkdtempSync(path.join(root, '_tmp_copies'));
    // Серия из копии возвращается той, что была в копии
    assert.strictEqual((await call('POST', `/api/games/${V1}/series`, { json: { series: 'Copper Saga' } })).status, 200);
    await dbService.get().run('VACUUM INTO ?', [path.join(dir, 'library.db')]);
    assert.strictEqual((await call('POST', `/api/games/${V1}/series`, { json: { series: 'none' } })).status, 200);
    await dbService.get().run('DELETE FROM not_duplicates WHERE a = ?', [V1]);
    assert.ok(await pairOf(), 'ответа нет — пара снова видна');
    await restoreBackup(dir, { trash, store: {} });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(await pairOf(), undefined, 'ответ вернулся из копии');
    assert.strictEqual((await dbService.get().get('SELECT series FROM games WHERE id = ?', [V1])).series, 'Copper Saga');
    await dbService.get().run('DELETE FROM not_duplicates WHERE a = ?', [V1]);

    assert.strictEqual((await call('POST', '/api/games/duplicates/merge', { json: { keep: V2, drop: 'Copper_Nope' } })).status, 404);
    const done = await call('POST', '/api/games/duplicates/merge', { json: { keep: V2, drop: V1 } });
    assert.deepStrictEqual([done.status, done.data.saves], [200, 'move']);
    assert.strictEqual(fs.readFileSync(path.join(root, '_saves', V2, 'RPG%20File1.json'), 'utf8'), 'мой сейв');
    const list = (await call('GET', '/api/games')).data;
    assert.strictEqual(list.find((g) => g.id === V2).playtime, 180, 'список игр — уже новый');
    assert.strictEqual(list.find((g) => g.id === V2).series, 'Copper Saga', 'у оставшейся серии не было: она берёт серию второй копии');
    assert.strictEqual(list.find((g) => g.id === V1), undefined);
    assert.strictEqual(fs.existsSync(path.join(root, V1)), false);

    await call('DELETE', `/api/games/trash/${done.data.trashKey}`);
    const del = await call('DELETE', `/api/games/${V2}`);
    await call('DELETE', `/api/games/trash/${del.data.trashKey}`);
    fs.rmSync(path.join(root, '_saves', V2), { recursive: true, force: true });
});

test('выход без входа ничего не меняет: чужой не выведет владельца', async () => {
    assert.strictEqual((await call('POST', '/api/logout', { auth: false })).status, 401);
    assert.strictEqual((await call('GET', '/api/games')).status, 200, 'кука владельца работает');
});

test('выход закрывает только это устройство: другое остаётся во входе, адрес файлов игры прежний', async () => {
    const phone = cookieFrom(await login()).value;
    const asPhone = (method, url) => call(method, url, { headers: { cookie: `${COOKIE}=${phone}` }, auth: false });
    const before = (await call('POST', `/api/play/${GAME}`)).data;
    const out = await call('POST', '/api/logout');
    assert.deepStrictEqual(out.data, { success: true });
    assert.strictEqual((await call('GET', '/api/games')).status, 401, 'кука этого устройства');
    assert.strictEqual((await asPhone('GET', '/api/games')).status, 200, 'телефон остался во входе');
    const again = await login();
    assert.strictEqual(again.status, 200);
    const fresh = cookieFrom(again).value;
    assert.ok(fresh !== cookie && fresh !== phone);
    cookie = fresh;
    assert.strictEqual((await call('GET', '/api/games')).status, 200);
    // Ключи записи у входов разные, адрес файлов один: год в кэше браузера не пропадает от выхода
    const after = (await call('POST', `/api/play/${GAME}`)).data;
    const onPhone = (await asPhone('POST', `/api/play/${GAME}`)).data;
    assert.strictEqual(after.path, before.path);
    assert.strictEqual(onPhone.path, before.path);
    assert.match(before.session, /^[0-9a-f]{48}$/);
    assert.notStrictEqual(after.session, before.session);
    assert.notStrictEqual(onPhone.session, after.session);
    // Выход стёр только свою строку
    const rows = await dbService.get().all("SELECT id FROM sessions WHERE user_id = 'owner'");
    assert.ok(rows.some((r) => after.session.startsWith(r.id)) && !rows.some((r) => before.session.startsWith(r.id)));
    await asPhone('POST', '/api/logout');
});

// Установка с прежней кукой: кука — сам ключ сессии, которым раньше входили все устройства
const legacyCall = (method, url, extra = {}) => call(method, url, { auth: false, headers: { cookie: `${COOKIE}=${dbService.getSessionToken()}` }, ...extra });

test('обновление: прежняя кука в окне открывает библиотеку и меняется на вход устройства; за окном и после смены пароля — нет', async (t) => {
    t.after(() => { dbService.legacyUntil = 0; });
    const until = Date.now() + 3600e3;
    dbService.legacyUntil = until;
    const first = await legacyCall('GET', '/api/games');
    assert.strictEqual(first.status, 200);
    const swapped = cookieFrom(first).value;
    assert.match(swapped, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(swapped, dbService.getSessionToken());
    assert.match(cookieFrom(first).line, /HttpOnly/i);
    assert.strictEqual((await call('GET', '/api/games', { auth: false, headers: { cookie: `${COOKIE}=${swapped}` } })).status, 200, 'новая кука сама по себе годится');
    // Вход живёт не дольше окна: старая кука не жила бы дольше
    const row = await dbService.get().get('SELECT expires_at AS e FROM sessions ORDER BY created_at DESC LIMIT 1');
    assert.strictEqual(row.e, until);
    // Страница шлёт десяток запросов разом со старой кукой — вход на всех один
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => legacyCall('GET', '/api/games')));
    assert.strictEqual(new Set(burst.map((r) => cookieFrom(r).value)).size, 1);
    // Выход на устройстве, которое обменяло куку, не возвращает старую: она ещё в окне, но обмен — уже новый вход, а не вход вечный
    // Окно вышло — кука не годится и ничего не выставляет
    dbService.legacyUntil = Date.now() - 1;
    const late = await legacyCall('GET', '/api/games');
    assert.strictEqual(late.status, 401);
    assert.strictEqual(cookieFrom(late).value, '');
    assert.strictEqual((await call('GET', '/api/games', { auth: false, headers: { cookie: `${COOKIE}=${swapped}` } })).status, 200, 'обмененный вход окно не трогает');
    // Смена пароля закрывает окно: устройство, не успевшее обновиться, с прежней кукой не войдёт
    dbService.legacyUntil = Date.now() + 3600e3;
    const NEW = 'window closing passphrase';
    assert.strictEqual((await call('POST', '/api/account/password', { json: { current: PASS, next: NEW } })).status, 200);
    assert.strictEqual(dbService.legacyUntil, 0);
    assert.strictEqual((await dbService.get().get("SELECT value FROM settings WHERE key = 'legacy_session_until'")).value, '0');
    assert.strictEqual((await legacyCall('GET', '/api/games')).status, 401);
    assert.strictEqual((await call('GET', '/api/games', { auth: false, headers: { cookie: `${COOKIE}=${swapped}` } })).status, 401, 'обменянный вход тоже вышел вместе с остальными');
    assert.strictEqual((await call('POST', '/api/account/password', { json: { current: NEW, next: PASS } })).status, 200);
});

test('обновление: вкладка игры, открытая до него, сохраняет в окне; новый запуск пишет по ключу сессии, и окно ему не нужно', async (t) => {
    const { createGameApp, gameKey, revOf, sessionKey } = require('./src/routes/play.js');
    // Своя игра: странице нужен <body>, в него вставляется window.__RPG
    const GAME = 'Upgrade_Game';
    fs.mkdirSync(path.join(root, GAME, 'www', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, GAME, 'www', 'index.html'), '<html><body></body></html>');
    fs.writeFileSync(path.join(root, GAME, 'www', 'data', 'System.json'), '{}');
    const sessions = require('./src/utils/sessions.js');
    const saved = [];
    const store = { list: async () => ({}), write: async (id, slot, value) => { saved.push([id, slot, value]); return 'saved'; }, remove: async () => {} };
    const gameApp = createGameApp({
        secret: () => dbService.getSessionToken(), sessions: { find: sessions.findById, legacyOpen: () => dbService.legacyOpen() },
        store, publicDir: path.join(__dirname, 'public'),
    });
    const gameServer = gameApp.listen(0, '127.0.0.1');
    await new Promise((r) => gameServer.once('listening', r));
    t.after(() => { gameServer.close(); dbService.legacyUntil = 0; });
    const send = (method, url, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: gameServer.address().port, path: url, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body && JSON.stringify(body));
    });
    const save = (key, value) => send('POST', `/saves/${key}/${GAME}/${encodeURIComponent('RPG File1')}`, { value, updatedAt: 1 });
    const fileKey = gameKey(dbService.getSessionToken(), GAME, await revOf(GAME));
    // Вход этой проверки — свой: в конце он закрывается, а общая кука нужна следующим тестам
    const mine = cookieFrom(await login()).value;
    const sid = (await call('POST', `/api/play/${GAME}`, { auth: false, headers: { cookie: `${COOKIE}=${mine}` } })).data.session.slice(0, 16);
    const live = sessionKey(dbService.getSessionToken(), sid, GAME);

    // Окно открыто: страница, загруженная до обновления, держит адрес с ключом файлов — и пишет как прежде
    dbService.legacyUntil = Date.now() + 3600e3;
    assert.strictEqual((await save(fileKey, 'old tab')).status, 200);
    assert.strictEqual((await save(live, 'new tab')).status, 200);
    assert.deepStrictEqual(saved.map((x) => x[2]), ['old tab', 'new tab']);
    // index.html: с ?s= адреса записи по ключу сессии, без него — по ключу файлов (пока окно открыто)
    const page = (query) => send('GET', `/g/${fileKey}/${GAME}/www/index.html${query}`);
    assert.match((await page(`?s=${live}`)).body, new RegExp(`"saves":"/saves/${live}".*"errors":"/errors/${live}"`));
    assert.match((await page('')).body, new RegExp(`"saves":"/saves/${fileKey}"`));
    assert.strictEqual((await send('GET', `/g/${fileKey}/${GAME}/www/index.html?s=${'0'.repeat(48)}`)).status, 200, 'ключ не подошёл — как без него');

    // Окно закрыто: ключ файлов больше не пишет, ключ сессии — пишет; страница без живого ключа не открывается, остальные файлы — как были
    dbService.legacyUntil = 0;
    assert.strictEqual((await save(fileKey, 'late')).status, 403);
    assert.strictEqual((await save(live, 'after window')).status, 200);
    assert.strictEqual((await send('GET', `/saves/${fileKey}/${GAME}`)).status, 403);
    assert.strictEqual((await send('GET', `/saves/${live}/${GAME}`)).status, 200);
    assert.strictEqual((await page('')).status, 403);
    assert.strictEqual((await page(`?s=${'0'.repeat(48)}`)).status, 403);
    const withKey = await page(`?s=${live}`);
    assert.deepStrictEqual([withKey.status, /"saves":"\/saves\/[0-9a-f]{48}"/.test(withKey.body)], [200, true]);
    assert.strictEqual((await send('GET', `/g/${fileKey}/${GAME}/www/data/System.json`)).status, 200, 'файлы игры по адресу файлов открываются и без окна');
    // Ключ чужой игры не подходит
    assert.strictEqual((await send('GET', `/saves/${sessionKey(dbService.getSessionToken(), sid, 'Other')}/${GAME}`)).status, 403);

    // Вход закрыт (выход, сброс) — ключ сессии перестаёт писать
    await sessions.end(sid);
    assert.strictEqual((await save(live, 'ended')).status, 403);
    assert.deepStrictEqual(saved.map((x) => x[2]), ['old tab', 'new tab', 'after window']);
});

test('сокет: вход кладёт соединение в комнаты входа, человека и owner; выход рвёт только свои вкладки', async (t) => {
    const WebSocket = require('ws');
    const sockets = ioServer.listen(0, '127.0.0.1');
    await new Promise((r) => sockets.once('listening', r));
    t.after(() => { for (const s of io.sockets.sockets.values()) s.disconnect(true); sockets.close(); dbService.legacyUntil = 0; });
    const connect = async (token) => {
        const ws = new WebSocket(`ws://127.0.0.1:${sockets.address().port}/socket.io/?EIO=4&transport=websocket`, { headers: { cookie: `${COOKIE}=${token}` } });
        const closed = new Promise((r) => ws.on('close', r));
        const text = (d) => d.toString();
        const connected = new Promise((resolve, reject) => {
            ws.on('error', reject);
            ws.on('message', (d) => { if (text(d) === '0' || text(d).startsWith('0{')) ws.send('40'); if (text(d).startsWith('40')) resolve(); });
        });
        await Promise.race([connected, closed.then(() => { throw new Error('сокет не принят'); })]);
        ws.closed = closed;
        return ws;
    };
    const phone = cookieFrom(await login()).value;
    const mine = await connect(cookie);
    const other = await connect(phone);
    const rooms = (ws) => [...io.sockets.sockets.values()].filter((s) => s.request.headers.cookie.endsWith(ws === mine ? cookie : phone))[0].rooms;
    const sidOf = async (token) => (await require('./src/utils/sessions.js').find(token)).id;
    const myRooms = rooms(mine);
    assert.ok(myRooms.has(`session:${await sidOf(cookie)}`) && myRooms.has('owner') && myRooms.has('user:owner'));
    assert.ok(rooms(other).has(`session:${await sidOf(phone)}`));
    // Без куки и с чужой — не принимаются
    await assert.rejects(connect('0'.repeat(64)), /сокет не принят|Unexpected server response/);
    // Старая кука в окне: принимается как владелец, без комнаты входа
    dbService.legacyUntil = Date.now() + 3600e3;
    const old = await connect(dbService.getSessionToken());
    const oldSocket = [...io.sockets.sockets.values()].find((s) => s.data.legacy);
    assert.ok(oldSocket && ![...oldSocket.rooms].some((r) => r.startsWith('session:')) && oldSocket.rooms.has('owner'));
    // Окно закрылось, а сверка раз в несколько секунд проходит по эпохе: такой сокет отключается, живые остаются
    dbService.legacyUntil = 0;
    await dbService.dropDeadSockets();
    await old.closed;
    assert.strictEqual(other.readyState, WebSocket.OPEN);
    // Выход на телефоне рвёт его вкладки и не трогает вкладки этого устройства
    assert.strictEqual((await call('POST', '/api/logout', { headers: { cookie: `${COOKIE}=${phone}` }, auth: false })).status, 200);
    await other.closed;
    assert.strictEqual(mine.readyState, WebSocket.OPEN);
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
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=480x360:seed=4:d=1', '-vf', 'noise=alls=25:allf=t', '-frames:v', '1', big]);
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

// ============================================================================
// Люди рядом с владельцем: вход, права, лимиты. Выключатель учётных записей закрыт, поэтому строки в users — напрямую
// ============================================================================
const bcrypt = require('bcrypt');

const access = require('./src/utils/access.js');

const { forgetLoginAttempts } = require('./src/routes/auth.js');

async function addUser(name, password, { mustChange = 0, empty = false } = {}) {
    const id = `u${require('crypto').randomBytes(8).toString('hex')}`;
    await dbService.get().run('INSERT INTO users (id, name, pass_hash, must_change, created_at) VALUES (?, ?, ?, ?, ?)', [id, name, empty ? '' : await bcrypt.hash(password, 4), mustChange, Date.now()]);
    return id;
}

const loginAs = (username, password) => call('POST', '/api/login', { json: { username, password }, auth: false });

const withCookie = (value) => ({ headers: { cookie: `${COOKIE}=${value}` }, auth: false });

const dropUsers = async () => {
    await dbService.get().run('DELETE FROM sessions WHERE user_id != ?', ['owner']);
    await dbService.get().run('DELETE FROM users');
    await dbService.get().run('DELETE FROM user_game_access');
    await dbService.get().run('DELETE FROM user_requests');
    // В программе выключатель включён; тест «выключенный» ставит false сам, а следующим тестам нужен прежний
    access.flags.accountsOn = true;
    forgetLoginAttempts();
};

test('люди: вход по имени, /me, пустой хэш не пускает, /users молчит, пока учётные записи выключены', async (t) => {
    t.after(dropUsers);
    // Выключатель в программе включён; эта проверка — про выключенный, как на установке, где его отключили
    access.flags.accountsOn = false;
    assert.strictEqual((await call('GET', '/api/me')).data.shared, false, 'людей нет — страница ничего не показывает и не сбрасывает');
    await addUser('Anna', 'anna-pass-1');
    await addUser('Empty', '', { empty: true });
    const owner = await call('GET', '/api/me');
    assert.deepStrictEqual(owner.data, { id: 'owner', name: USER, isOwner: true, mustChange: false, shared: true, avatar: null, role: 'owner', rights: { request: true, download: true, upload: true, view: true } });
    assert.strictEqual((await call('GET', '/api/me', { auth: false })).status, 401);

    const ok = await loginAs('anna', 'anna-pass-1');
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.data, { success: true }, 'у владельца и у человека ответ входа одинаковый');
    const anna = cookieFrom(ok).value;
    const me = await call('GET', '/api/me', withCookie(anna));
    assert.deepStrictEqual([me.data.name, me.data.isOwner, me.data.mustChange, me.data.shared], ['Anna', false, false, true], 'имя — как записано, вход — без учёта регистра');

    assert.strictEqual((await loginAs(' Anna ', 'anna-pass-1')).status, 200, 'пробелы по краям имени не мешают');
    const bad = await loginAs('Anna', 'wrong');
    const nobody = await loginAs('Nobody', 'anna-pass-1');
    assert.deepStrictEqual([bad.status, nobody.status], [401, 401]);
    assert.deepStrictEqual(bad.data, nobody.data, 'ответ не выдаёт, есть ли такое имя');
    for (const pass of ['', 'x', ' ']) assert.strictEqual((await loginAs('Empty', pass)).status, 401, 'пустой хэш пароль не принимает');
    assert.strictEqual((await loginAs(USER, 'anna-pass-1')).status, 401, 'пароль человека к владельцу не подходит');
    assert.strictEqual((await loginAs({ $ne: '' }, 'x')).status, 401);

    // Выключатель закрыт: владелец получает то же, что у любого неизвестного адреса; человек — отказ по правам
    const before = (await dbService.get().get('SELECT COUNT(*) AS n FROM users')).n;
    assert.strictEqual((await call('POST', '/api/users', { json: { name: 'Boris', password: 'temp-pass' } })).status, 404);
    assert.strictEqual((await call('GET', '/api/users')).status, 404);
    assert.strictEqual((await call('POST', '/api/users', { ...withCookie(anna), json: { name: 'Boris', password: 'temp-pass' } })).data.reason, 'owner-only');
    assert.strictEqual((await dbService.get().get('SELECT COUNT(*) AS n FROM users')).n, before, 'людей не прибавилось');
});

test('люди: владелец заводит человека, временный пароль заставляет выбрать свой, сброс запирает', async (t) => {
    t.after(dropUsers);
    access.flags.accountsOn = true;
    const post = (json, extra = {}) => call('POST', '/api/users', { json, ...extra });
    assert.strictEqual((await post({ name: 'x'.repeat(41), password: 'temp-pass' })).status, 400);
    assert.strictEqual((await post({ name: '  ', password: 'temp-pass' })).status, 400);
    assert.strictEqual((await post({ name: 'Boris', password: '12' })).status, 400);
    assert.strictEqual((await post({ name: USER.toUpperCase(), password: 'temp-pass' })).status, 409, 'логин владельца занят');
    // Окно старой куки закрывается с первым человеком
    dbService.legacyUntil = Date.now() + 60e3;
    const made = await post({ name: 'Boris', password: 'temp-pass' });
    assert.strictEqual(made.status, 200);
    assert.deepStrictEqual([made.data.name, made.data.mustChange], ['Boris', true]);
    assert.strictEqual(dbService.legacyOpen(), false);
    assert.strictEqual((await post({ name: 'BORIS', password: 'temp-pass' })).status, 409);
    assert.deepStrictEqual((await call('GET', '/api/users')).data.map((u) => [u.name, u.mustChange, u.noPassword]), [[USER, false, false], ['Boris', true, false]], 'главный администратор — первой строкой');
    assert.strictEqual((await dbService.get().get('SELECT pass_hash FROM users')).pass_hash.startsWith('$2'), true);
    // Запись из копии: хэша нет — список так и говорит, владельцу остаётся задать временный пароль
    await addUser('Restored', '', { empty: true });
    assert.deepStrictEqual((await call('GET', '/api/users')).data.map((u) => [u.name, u.noPassword]), [[USER, false], ['Boris', false], ['Restored', true]]);
    await dbService.get().run("DELETE FROM users WHERE name = 'Restored'");

    const first = await loginAs('Boris', 'temp-pass');
    assert.deepStrictEqual(first.data, { success: true, mustChange: true });
    const boris = cookieFrom(first).value;
    // Пока пароль не выбран — только /me и смена пароля
    const games = await call('GET', '/api/games', withCookie(boris));
    assert.deepStrictEqual([games.status, games.data.reason], [403, 'must-change']);
    assert.strictEqual((await call('GET', '/api/me', withCookie(boris))).data.mustChange, true);
    assert.strictEqual((await call('POST', '/api/account/password', { ...withCookie(boris), json: { current: 'nope', next: 'boris-pass-1' } })).status, 401);
    const other = cookieFrom(await loginAs('Boris', 'temp-pass')).value;
    const changed = await call('POST', '/api/account/password', { ...withCookie(boris), json: { current: 'temp-pass', next: 'boris-pass-1' } });
    assert.deepStrictEqual([changed.status, changed.data.otherDevicesSignedOut], [200, true]);
    assert.strictEqual((await call('GET', '/api/games', withCookie(boris))).status, 200, 'это устройство осталось');
    assert.strictEqual((await call('GET', '/api/games', withCookie(other))).status, 401, 'другое вышло');
    assert.strictEqual((await loginAs('Boris', 'temp-pass')).status, 401);
    assert.strictEqual(dbService.legacyOpen(), false, 'смена пароля человека окно не трогает, оно уже закрыто');

    // Сброс владельцем: входы стёрты, пароль временный
    const id = made.data.id;
    assert.strictEqual((await call('POST', `/api/users/${id}/password`, { ...withCookie(boris), json: { password: 'again-pass' } })).data.reason, 'owner-only');
    assert.strictEqual((await call('POST', '/api/users/nope/password', { json: { password: 'again-pass' } })).status, 404);
    assert.strictEqual((await call('POST', `/api/users/${id}/password`, { json: { password: 'x' } })).status, 400);
    assert.strictEqual((await call('POST', `/api/users/${id}/password`, { json: { password: 'again-pass' } })).status, 200);
    assert.strictEqual((await call('GET', '/api/games', withCookie(boris))).status, 401);
    assert.strictEqual((await loginAs('Boris', 'boris-pass-1')).status, 401);
    assert.strictEqual((await loginAs('Boris', 'again-pass')).data.mustChange, true);
    // Сброс пароля запись не убирает
    assert.strictEqual((await dbService.get().get('SELECT COUNT(*) AS n FROM users')).n, 1);
});

// Что человеку можно — по таблице прав плана. Всё остальное за замком — владельцу
const USER_MAY = `GET /api/games/|GET /api/play-days|POST /api/games/lists/change|GET /api/games/:id/translation|POST /api/games/:id/meta
GET /api/saves/export/:id|POST /api/saves/import/:id|GET /api/saves/history/:id|GET /api/saves/shot/:id|POST /api/saves/history/:id/restore|GET /api/saves/:gameId|POST /api/saves/:gameId/:key|DELETE /api/saves/:gameId/:key
GET /api/marks/:id|GET /api/marks/:id/:mark/thumb|GET /api/marks/:id/:mark/shot|POST /api/marks/:id/:mark/keep|PATCH /api/marks/:id/:mark|DELETE /api/marks/:id/:mark
GET /api/journal/:id|GET /api/journal/:id/room|GET /api/journal/:id/:entry/thumb
GET /api/itch/latest|GET /api/itch/meta|GET /api/itch/game|GET /api/wishlist/|POST /api/wishlist/|DELETE /api/wishlist/|POST /api/errors/:id|GET /api/favorites|PUT /api/favorites|DELETE /api/favorites
POST /api/account/name|PUT /api/account/avatar|DELETE /api/account/avatar|GET /api/avatars/:id
GET /api/gallery/:id|GET /api/gallery/:id/tags|GET /api/gallery/:id/inside|GET /api/gallery/:id/thumb|GET /api/gallery/:id/image
GET /api/gallery/:id/video|GET /api/gallery/:id/sounds|GET /api/gallery/:id/cast|GET /api/gallery/:id/scene|GET /api/gallery/:id/audio|GET /api/gallery/:id/spine|GET /api/gallery/:id/live2d|GET /api/gallery/:id/rig-cover
GET /api/recommend/modes|GET /api/recommend/library
GET /api/pictures/search|GET /api/pictures/similar|POST /api/pictures/by-image|GET /api/pictures/games|GET /api/pictures/feed|GET /api/pictures/status|GET /api/lines/search|GET /api/scenes|POST /api/play/:id`
    .split(/[\n|]/).filter(Boolean);

// Все маршруты за замком — из самого приложения: добавленный завтра маршрут попадёт сюда без правки теста
function routesBehindGate() {
    const mountOf = (layer) => {
        if (layer.regexp.fast_slash) return '';
        return layer.regexp.source.replace('^\\/', '/').replace(/\\\/\?\(\?=\\\/\|\$\)\$?$/, '').replace(/\\\//g, '/').replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ':p');
    };
    const out = [];
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
            else if (layer.name === 'router' && layer.handle.stack) walk(layer.handle.stack, prefix + mountOf(layer));
        }
    };
    const stack = app._router.stack;
    const at = stack.findIndex((l) => l.handle === access.gate);
    assert.ok(at > 0, 'замок прав стоит в приложении');
    walk(stack.slice(at + 1), '');
    return out.filter((r) => r.path !== '*');
}

test('права: закрытый список — загрузки, убранные сайты и заявки человеку не открываются', () => {
    // Список закрытый: кто-то вернёт маршрут в таблицу — тест скажет сразу
    for (const [method, p] of [
        ['POST', '/downloads'], ['DELETE', '/downloads'], ['GET', '/itch/downloads'], ['POST', '/itch/downloads'],
        ['GET', '/catalog/latest'], ['GET', '/requests'], ['POST', '/requests'], ['GET', '/recommend/sites'],
    ]) assert.strictEqual(access.userMay(method, p), false, `${method} ${p}`);
    assert.strictEqual(access.userMay('GET', '/downloads'), false, 'без права просмотра — закрыто');
    assert.strictEqual(access.userMay('GET', '/downloads', { rights: { view: true } }), true, 'ход загрузок — только с правом просмотра');
    assert.strictEqual(access.userMay('POST', '/downloads', { rights: { view: true, download: true, upload: true } }), false, 'и с правами POST закрыт');
});

test('права: каждый маршрут за замком, которого нет в списке, человеку отвечает 403, а список — ровно по таблице', async (t) => {
    t.after(dropUsers);
    await addUser('Carl', 'carl-pass-1');
    const carl = cookieFrom(await loginAs('Carl', 'carl-pass-1')).value;
    const routes = routesBehindGate();
    assert.ok(routes.length > 150, `маршрутов нашлось ${routes.length}`);
    const concrete = (p) => p.replace(/:[A-Za-z]+/g, 'x').replace(/^\/api/, '');
    const allowed = routes.filter((r) => access.userMay(r.method, concrete(r.path))).map((r) => `${r.method} ${r.path}`);
    assert.deepStrictEqual([...allowed].sort(), [...USER_MAY].sort());
    for (const r of routes) {
        if (allowed.includes(`${r.method} ${r.path}`)) continue;
        const res = await call(r.method, `/api${concrete(r.path)}`, { ...withCookie(carl), json: r.method === 'GET' ? undefined : {} });
        assert.deepStrictEqual([res.status, res.data?.reason], [403, 'owner-only'], `${r.method} ${r.path}`);
    }
    // Владельцу замок не мешает
    assert.strictEqual((await call('GET', '/api/settings')).status, 200);
    assert.strictEqual((await call('GET', '/api/settings', withCookie(carl))).status, 403);

    // Что Express сопоставил бы с тем же маршрутом, а список не пропустит
    for (const [method, p] of [
        ['GET', '/pictures/hidden'], ['GET', '/PICTURES/Hidden'], ['GET', '/pictures/hidden/'], ['GET', '/downloads'], ['GET', '/Downloads/'],
        ['GET', '/games/x/lookup'], ['GET', '/games/x/guides/translate'], ['GET', '/saves/../settings'], ['GET', '/saves/./x'], ['GET', '/games/x/../settings'],
        ['POST', '/games/x/edit'], ['GET', '/itch/downloads'], ['GET', '/recommend/chips'], ['POST', '/recommend/dismiss'], ['PUT', '/gallery/x/rig-cover'],
        ['OPTIONS', '/games'], ['TRACE', '/games'], ['GET', '/'],
        ['PATCH', '/users/x'], ['POST', '/users/x/state'], ['PUT', '/users/x/avatar'], ['DELETE', '/users/x/avatar'], ['GET', '/avatars/x/y'], ['GET', '/avatars/..'],
        ['GET', '/account/name'], ['POST', '/account/avatar'], ['PATCH', '/account/name'],
    ]) assert.strictEqual(access.userMay(method, p), false, `${method} ${p}`);
    assert.strictEqual(access.userMay('POST', '/account/name', { mustChange: true }), false, 'имя меняют после первого пароля');
    assert.strictEqual(access.userMay('HEAD', '/games'), true, 'HEAD — как GET');
    assert.strictEqual(access.userMay('GET', '/games', { mustChange: true }), false);
    assert.strictEqual(access.userMay('GET', '/me', { mustChange: true }), true);
});

test('лимиты: вошедших считаем по человеку, а не по адресу', async (t) => {
    t.after(dropUsers);
    await addUser('Dina', 'dina-pass-1');
    const dina = cookieFrom(await loginAs('Dina', 'dina-pass-1')).value;
    const left = (res) => Number(res.headers['x-ratelimit-remaining']);
    // Окно лимита — 60 с с первого запроса; смена окна посреди теста сбросила бы счёт владельца, поэтому
    // сравниваем «до» и «после»: за три запроса счёт должен упасть на три, если окно то же (иначе — повторяем)
    let before = 0;
    let owner = 0;
    for (let tries = 0; tries < 3; tries++) {
        before = left(await call('GET', '/api/me'));
        for (let i = 0; i < 2; i++) await call('GET', '/api/me');
        owner = left(await call('GET', '/api/me'));
        if (owner <= before - 3) break;
    }
    const first = left(await call('GET', '/api/me', withCookie(dina)));
    assert.ok(owner <= before - 3, `у владельца потрачено: было ${before}, стало ${owner}`);
    assert.strictEqual(first, Number(process.env.API_RATE_LIMIT) - 1, 'у человека свой счёт с адреса того же владельца');
});

test('вход: одна семья за одним адресом — запертое имя не запирает остальных, а перебор имён упирается в общий лимит адреса', async (t) => {
    t.after(dropUsers);
    forgetLoginAttempts();
    await addUser('Eva', 'eva-pass-1');
    await addUser('Fred', 'fred-pass-1');
    let last;
    for (let i = 0; i < 11; i++) last = await loginAs('Eva', `wrong-${i}`);
    assert.strictEqual(last.status, 429);
    assert.strictEqual((await loginAs('EVA', 'eva-pass-1')).status, 429, 'то же имя в другом регистре — та же корзина');
    assert.strictEqual((await loginAs('Fred', 'fred-pass-1')).status, 200, 'другое имя с того же адреса входит');
    assert.strictEqual((await loginAs(USER, PASS)).status, 200, 'владелец тоже');
    // Перебор разных имён: каждое по разу, зато на адрес — не больше ста неудач
    for (let i = 0; i < 100; i++) last = await loginAs(`guess-${i}`, 'x');
    assert.strictEqual(last.status, 429);
    assert.strictEqual((await loginAs('Fred', 'fred-pass-1')).status, 429, 'адрес выбрал свой лимит');
    forgetLoginAttempts();
    assert.strictEqual((await loginAs('Fred', 'fred-pass-1')).status, 200, 'сброс из консоли снимает оба лимита');
});

test('файлы: «..» не доходит до сейвов, снимок сейва отдаёт только /api/saves, обложки из _media на месте', async (t) => {
    const shot = path.join(root, '_saves', GAME, 'shot.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    fs.writeFileSync(shot, PNG);
    t.after(() => fs.rmSync(path.join(root, '_saves'), { recursive: true, force: true }));
    await addUser('Gleb', 'gleb-pass-1');
    t.after(dropUsers);
    const gleb = cookieFrom(await loginAs('Gleb', 'gleb-pass-1')).value;
    for (const p of [
        `/_saves/${GAME}/shot.png`, `/${GAME}/../_saves/${GAME}/shot.png`, `/${GAME}/%2e%2e/_saves/${GAME}/shot.png`,
        `/${GAME}/..%2f_saves/${GAME}/shot.png`, `/x/../${GAME}/../_saves/${GAME}/shot.png`, `/_media/../_saves/${GAME}/shot.png`,
    ]) {
        for (const who of [{}, withCookie(gleb)]) {
            const res = await call('GET', p, who);
            assert.strictEqual(res.status, 403, p);
            assert.ok(!res.raw.equals(PNG), p);
        }
    }
    assert.strictEqual((await call('GET', `/_media/${GAME}/cover-0123456789.png`)).raw.equals(PNG), true);
    assert.strictEqual((await call('GET', `/_media/${GAME}/cover-0123456789.png`, withCookie(gleb))).raw.equals(PNG), true, 'обложка — и человеку');
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

test('разбор картинок: переключатель в настройках главнее PICTURE_PASS и действует сразу; поиск и лента говорят, что он выключен', async (t) => {
    const gallery = require('./src/services/gallery.js');
    const env = process.env.PICTURE_PASS;
    t.after(() => { if (env === undefined) delete process.env.PICTURE_PASS; else process.env.PICTURE_PASS = env; });
    // Сборка галерей всей библиотеки здесь не нужна: смотрим, что её попросили
    const asked = t.mock.method(gallery, 'prepare', () => {});
    const stopped = t.mock.method(gallery, 'stopPictures', () => {});
    const set = (value) => call('POST', '/api/settings/options', { json: { name: 'picture_analysis', value } });
    const on = async () => (await call('GET', '/api/pictures/status?peek=1')).data.analysis.on;
    process.env.PICTURE_PASS = '1';
    assert.strictEqual(await on(), true, 'не трогали — как в окружении');
    assert.strictEqual((await call('GET', '/api/pictures/feed')).data.off, undefined);
    const off = await set(false);
    assert.strictEqual(off.status, 200, 'PICTURE_PASS — значение по умолчанию, а не запрет менять');
    assert.deepStrictEqual([off.data.options.picture_analysis.value, off.data.options.picture_analysis.fromEnv], [false, false]);
    assert.strictEqual((await dbService.get().get("SELECT value FROM settings WHERE key = 'picture_analysis'")).value, 'false');
    assert.strictEqual(await on(), false);
    assert.strictEqual(stopped.mock.callCount(), 1, 'очереди и модели останавливаются сразу');
    assert.strictEqual((await call('GET', '/api/pictures/feed')).data.off, true);
    assert.deepStrictEqual(await call('GET', '/api/pictures/search?q=maid').then((r) => [r.status, r.data]), [503, { error: 'unavailable', off: true }]);
    assert.strictEqual((await call('GET', '/api/pictures/search?q=maid', { auth: false })).status, 401);
    process.env.PICTURE_PASS = '0';
    const before = asked.mock.callCount();
    assert.strictEqual((await set(true)).data.options.picture_analysis.value, true, 'и наоборот: PICTURE_PASS=0, а человек включил');
    assert.strictEqual(await on(), true);
    assert.strictEqual(asked.mock.callCount(), before + 1, 'разбор начинается без перезапуска');
    assert.strictEqual((await set(null)).data.options.picture_analysis.value, false, 'вернули — снова как в окружении');
    assert.strictEqual(await dbService.get().get("SELECT value FROM settings WHERE key = 'picture_analysis'"), undefined);
});

test('скорость разбора картинок: чужое значение — 400; сохранённое действует сразу и закрывает сессию разметчика', async (t) => {
    const gallery = require('./src/services/gallery.js');
    const closed = t.mock.method(gallery.tags.hold, 'unload', () => {});
    const set = (value) => call('POST', '/api/settings/options', { json: { name: 'picture_speed', value } });
    for (const bad of ['turbo', 5, true]) assert.strictEqual((await set(bad)).status, 400, String(bad));
    assert.strictEqual(closed.mock.callCount(), 0);
    assert.strictEqual(await dbService.get().get("SELECT value FROM settings WHERE key = 'picture_speed'"), undefined);
    const fast = await set('fast');
    assert.deepStrictEqual([fast.status, fast.data.options.picture_speed.value, fast.data.options.picture_speed.fromEnv], [200, 'fast', false]);
    assert.strictEqual(closed.mock.callCount(), 1);
    assert.strictEqual((await dbService.get().get("SELECT value FROM settings WHERE key = 'picture_speed'")).value, 'fast');
    assert.strictEqual((await set(null)).data.options.picture_speed.value, 'quiet');
    assert.strictEqual(closed.mock.callCount(), 2);
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
        text.prepare = () => ({ state: 'ready' });
        text.embed = async (q) => (q === 'unavailable' ? null : Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)));
        const search = (q, extra = '') => call('GET', `/api/pictures/search?q=${encodeURIComponent(q)}${extra}`);
        const found = await search('горничная');
        assert.strictEqual(found.status, 200);
        assert.strictEqual(found.data.games, 1, 'игра не из библиотеки в поиске не участвует');
        assert.deepStrictEqual(found.data.results.map((r) => [r.game, r.file]), [[GAME, 'img/pictures/cg.png'], [GAME, 'movies/opening.webm']], 'по близости; кадра вне оглавления нет');
        assert.ok(found.data.results[0].score === 0.6 && found.data.results[1].score === 0.18);
        assert.strictEqual((await search('maid', '&limit=1')).data.results.length, 1);
        // Как поиск понял запрос: английскими словами; слово, которого словарь не знает, — отдельно
        assert.strictEqual(found.data.understood, 'maid');
        assert.strictEqual(found.data.more, false);
        assert.ok(!('understood' in (await search('maid')).data), 'английский запрос — без «Искал»');
        assert.deepStrictEqual((await search('горничная писюн')).data.unknown, ['писюн']);
        // «Ещё»: вторая страница — со второй картинки
        assert.deepStrictEqual((await search('maid', '&limit=1&from=1')).data.results.map((r) => r.file), ['movies/opening.webm']);
        // «Похожие»: по вектору кадра, сам кадр не в счёт; чужая игра или кадр вне оглавления — 400 и 404
        const like = (q) => call('GET', `/api/pictures/similar?${q}`);
        const similar = await like(`game=${encodeURIComponent(GAME)}&f=${encodeURIComponent('img/pictures/cg.png')}`);
        assert.strictEqual(similar.status, 200);
        assert.deepStrictEqual(similar.data.results.map((r) => r.file), ['movies/opening.webm']);
        assert.strictEqual((await like(`game=${encodeURIComponent(GAME)}&f=${encodeURIComponent('img/pictures/gone.png')}`)).status, 404);
        assert.strictEqual((await like('game=..&f=x.png')).status, 400);
        assert.strictEqual((await like(`game=${encodeURIComponent(GAME)}`)).status, 400);
        assert.strictEqual((await call('GET', `/api/pictures/similar?game=${encodeURIComponent(GAME)}&f=x.png`, { auth: false })).status, 401);
        // Теги картинок: разметчика нет (тесты) — пусто, а не ошибка; кривой запрос — 400
        assert.deepStrictEqual((await call('GET', `/api/gallery/${encodeURIComponent(GAME)}/tags`)).data, { files: [], tags: [], hidden: [] });
        assert.deepStrictEqual((await call('GET', `/api/gallery/${encodeURIComponent(GAME)}/tags?f=img/pictures/cg.png`)).data, { tags: [] });
        assert.strictEqual((await call('GET', `/api/gallery/${encodeURIComponent(GAME)}/tags?f=${'x'.repeat(1001)}`)).status, 400);
        // Скрытые теги: добавить, повтор не удваивает, убрать; без входа — нельзя; мусор не попадает
        const hide = (body) => call('POST', '/api/pictures/hidden', { json: body });
        assert.deepStrictEqual((await hide({ add: ['maid', 'maid', 7, ''] })).data, { tags: ['maid'] });
        assert.deepStrictEqual((await call('GET', '/api/pictures/hidden')).data, { tags: ['maid'] });
        assert.strictEqual((await call('POST', '/api/pictures/hidden', { json: { add: ['x'] }, auth: false })).status, 401);
        assert.deepStrictEqual((await hide({ add: ['toddler', 'child_art', '1girl'] })).data, { tags: ['maid'] }, 'служебные и про детей не записываем');
        assert.deepStrictEqual((await hide({ remove: ['maid'] })).data, { tags: [] });
        // Теги кадров по играм и «Что на картинках»: разметчика нет — пусто, а не ошибка
        assert.deepStrictEqual((await call('GET', '/api/pictures/games')).data, { covered: 0, tags: [], games: {} });
        assert.strictEqual((await call('GET', '/api/pictures/games', { auth: false })).status, 401);
        assert.deepStrictEqual((await call('GET', `/api/gallery/${encodeURIComponent(GAME)}/inside`)).data, { frames: 0, tags: [] });
        assert.strictEqual((await call('GET', `/api/gallery/${encodeURIComponent(GAME)}/inside`, { auth: false })).status, 401);
        // Заметка и подборки: хранятся у игры, неверное не принимается; переименование и удаление подборки игры не трогают
        const meta = (json) => call('POST', `/api/games/${encodeURIComponent(GAME)}/meta`, { json });
        const mine = async () => (await call('GET', '/api/games')).data.find((g) => g.id === GAME);
        assert.deepStrictEqual([(await mine()).notes, (await mine()).lists], ['', []]);
        assert.strictEqual((await meta({ notes: 'застрял на боссе' })).status, 200);
        assert.strictEqual((await meta({ lists: ['  На   вечер ', 'На вечер', 'Ждать перевод'] })).status, 200);
        assert.strictEqual((await mine()).notes, 'застрял на боссе');
        assert.deepStrictEqual((await mine()).lists, ['На вечер', 'Ждать перевод'], 'лишние пробелы и повторы убраны');
        for (const bad of [{ notes: 'x'.repeat(5001) }, { notes: 5 }, { lists: 'строка' }, { lists: [''] }, { lists: ['x'.repeat(61)] }, { lists: [7] }]) {
            assert.strictEqual((await meta(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
        }
        assert.strictEqual((await mine()).notes, 'застрял на боссе', 'после отказа всё как было');
        // Границы: что влезает — принимается. Поломанный столбец не роняет список игр
        assert.strictEqual((await meta({ lists: ['x'.repeat(60)] })).status, 200);
        assert.strictEqual((await meta({ lists: Array.from({ length: 51 }, (_, i) => `n${i}`) })).status, 400);
        assert.strictEqual((await meta({ lists: Array.from({ length: 50 }, (_, i) => `n${i}`) })).status, 200);
        assert.strictEqual((await meta({ lists: ['На вечер', 'Ждать перевод'] })).status, 200);
        const change = (json, opts = {}) => call('POST', '/api/games/lists/change', { json, ...opts });
        assert.deepStrictEqual((await change({ from: 'На вечер', to: 'Вечером' })).data, { changed: 1 });
        assert.deepStrictEqual((await mine()).lists, ['Вечером', 'Ждать перевод']);
        assert.deepStrictEqual((await change({ from: 'Вечером', to: 'Ждать перевод' })).data, { changed: 1 });
        assert.deepStrictEqual((await mine()).lists, ['Ждать перевод'], 'в уже существующую — слияние, без повтора');
        assert.deepStrictEqual((await change({ from: 'Такой нет', to: 'Другая' })).data, { changed: 0 });
        assert.strictEqual((await change({ from: '' })).status, 400);
        assert.strictEqual((await change({ from: 'Ждать перевод', to: '' })).status, 400, 'пустое новое имя — не удаление');
        assert.deepStrictEqual((await change({ from: 'Ждать перевод' })).data, { changed: 1 });
        assert.deepStrictEqual((await mine()).lists, []);
        assert.strictEqual((await mine()).notes, 'застрял на боссе', 'игра и заметка на месте');
        assert.strictEqual((await change({ from: 'x' }, { auth: false })).status, 401);
        assert.strictEqual((await meta({ notes: '' })).status, 200);
        // Лента картинок: разметчика нет — пусто, а не ошибка; разбор в тестах выключен — так и сказано
        assert.deepStrictEqual((await call('GET', '/api/pictures/feed')).data, { games: [], off: true });
        assert.strictEqual((await call('GET', '/api/pictures/feed', { auth: false })).status, 401);
        // Своя картинка: только картинка и только со входом; модели нет — честный ответ. Кривой вектор — 400
        const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)]);
        const send = (raw, opts = {}) => call('POST', '/api/pictures/by-image', { raw, ...opts });
        assert.strictEqual((await send(Buffer.from('#EXTM3U\nfile:///etc/passwd'))).status, 400, 'плейлист до ffmpeg не доходит');
        assert.strictEqual((await send(Buffer.alloc(0))).status, 400);
        assert.strictEqual((await send(png, { auth: false })).status, 401);
        assert.strictEqual((await send(png)).status, 503);
        assert.strictEqual((await send(Buffer.concat([png, Buffer.alloc(26 * 1024 * 1024)]))).status, 413);
        assert.strictEqual((await call('GET', '/api/pictures/similar?v=AAAA')).status, 400);
        assert.deepStrictEqual((await call('GET', `/api/pictures/similar?v=${encodeURIComponent(Buffer.alloc(512).toString('base64'))}`)).status, 200);
        // Про детей не ищем — пусто, как «ничего не нашлось», на любом языке
        for (const q of ['child', 'малыш', 'ребёнок']) assert.deepStrictEqual((await search(q)).data.results, [], q);
        assert.strictEqual((await call('GET', '/api/gallery/../tags')).status === 200, false);
        assert.strictEqual((await call('GET', `/api/gallery/${encodeURIComponent(GAME)}/tags`, { auth: false })).status, 401);
        for (const bad of ['', '   ', 'x'.repeat(101)]) assert.strictEqual((await search(bad)).status, 400, 'пустой или слишком длинный запрос');
        assert.strictEqual((await call('GET', '/api/pictures/search')).status, 400);
        assert.strictEqual((await search('unavailable')).status, 503, 'модели текста нет — честный ответ, а не пустой список');
        assert.strictEqual((await call('GET', '/api/pictures/search?q=maid', { auth: false })).status, 401);
        // Модель слов ещё качается — ответ сразу, со сколько скачано; выключена или не вышла — unavailable. Окно открылось — status
        text.prepare = () => ({ state: 'preparing', done: 5, total: 270 });
        assert.deepStrictEqual(await search('maid').then((r) => [r.status, r.data]), [503, { error: 'preparing', done: 5, total: 270 }]);
        assert.deepStrictEqual((await call('GET', '/api/pictures/status')).data, { state: 'preparing', done: 5, total: 270, analysis: { on: false, state: 'unavailable' } });
        text.prepare = () => ({ state: 'off' });
        assert.deepStrictEqual(await search('maid').then((r) => [r.status, r.data]), [503, { error: 'unavailable', off: true }]);
        assert.strictEqual((await call('GET', '/api/pictures/status', { auth: false })).status, 401);
        // Есть ли разобранные игры — только по просьбе (опросы хода разбора идут часто) и только да или нет
        assert.strictEqual((await call('GET', '/api/pictures/status?peek=1')).data.tagged, undefined);
        assert.strictEqual(typeof (await call('GET', '/api/pictures/status?peek=1&tagged=1')).data.tagged, 'boolean');
        // Пункт «Избранное» в меню: тоже только да или нет
        assert.strictEqual(typeof (await call('GET', '/api/pictures/status?peek=1&tagged=1')).data.faved, 'boolean');
        text.prepare = () => ({ state: 'ready' });
        // Сбой — общий код, а не текст ошибки (в нём бывают пути на диске)
        text.embed = async () => { throw new Error('/srv/секретный/путь'); };
        const broken = await search('maid');
        assert.deepStrictEqual([broken.status, broken.data], [500, { error: 'search-failed' }]);
    } finally {
        text.embed = realEmbed;
        delete text.prepare;
        fs.rmSync(path.join(gallery.mediaDir, 'Not_In_Library'), { recursive: true, force: true });
        fs.rmSync(gallery.visionPath(GAME), { force: true });
    }
});

test('поиск по репликам: вход, проверка запроса и игры, форма ответа, сбой без путей, индекс недоступен — 503', async () => {
    const lines = require('./src/services/sceneLines.js');
    const search = (q, extra = '') => call('GET', `/api/lines/search?q=${encodeURIComponent(q)}${extra}`);
    assert.strictEqual((await call('GET', '/api/lines/search?q=husband', { auth: false })).status, 401);
    for (const bad of ['', '   ', 'x'.repeat(101)]) assert.strictEqual((await search(bad)).status, 400, 'пустой или слишком длинный запрос');
    assert.strictEqual((await call('GET', '/api/lines/search')).status, 400);
    assert.deepStrictEqual((await search('он')).data, { error: 'short' }, 'короткий запрос нашёл бы полбиблиотеки');
    for (const bad of ['&game=..', '&game=a%2Fb', '&game[]=x']) assert.deepStrictEqual((await search('husband', bad)).data, { error: 'bad-game' }, bad);
    // Настоящий индекс (пустой): форма ответа, игры библиотеки посчитаны
    const empty = await search('husband');
    assert.strictEqual(empty.status, 200);
    assert.ok(empty.data.total === 0 && Array.isArray(empty.data.games) && Array.isArray(empty.data.scenes) && empty.data.library >= 1, JSON.stringify(empty.data));
    let seen = null;
    try {
        lines.search = async (q, opts) => { seen = { q, ...opts }; return { total: 0, games: [], indexed: 0, library: opts.ids.length, building: null, scenes: [] }; };
        await search('  husband  ', `&game=${GAME}&limit=999`);
        assert.deepStrictEqual([seen.q, seen.game, seen.limit, seen.ids.includes(GAME)], ['husband', GAME, 60, true]);
        await search('husband', '&limit=abc');
        assert.strictEqual(seen.limit, 24, 'по умолчанию — 24 сцены');
        lines.search = async () => null;
        assert.deepStrictEqual(await search('husband').then((r) => [r.status, r.data]), [503, { error: 'unavailable' }]);
        // Сбой — общий код, а не текст ошибки (в нём бывают пути на диске)
        lines.search = async () => { throw new Error('/srv/секретный/путь'); };
        const err = console.error;
        console.error = () => {};
        try { assert.deepStrictEqual(await search('husband').then((r) => [r.status, r.data]), [500, { error: 'search-failed' }]); } finally { console.error = err; }
    } finally {
        // Своё свойство поверх метода класса — убрать, метод снова из класса
        delete lines.search;
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
    put('audio/voice/heroine_01_jp.rpgmvo', seal(ogg('v1')));
    put('audio/voice/heroine_02_jp.rpgmvo', seal(ogg('v2')));
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
    // Кто в сценах: одна сцена, одна реплика Анны — ряда нет, подпись плитки есть; чужая игра — 404; без сценариев — {}
    const cast = await call('GET', `/api/gallery/${ID}/cast`);
    assert.deepStrictEqual([cast.status, cast.data], [200, { scenes: { names: [], rows: {}, w: { [`${key}\n0`]: ['Анна'] } }, dialogue: { names: [], rows: {}, w: {} } }]);
    assert.strictEqual((await call('GET', '/api/gallery/Nope_Game/cast')).status, 404);
    assert.deepStrictEqual((await call('GET', '/api/gallery/Sound_Case/cast')).data, {});
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

test('перевод игры: включили — у игры новый адрес и данные с переводом, открытая игра по старому адресу работает дальше; выключили — оригинал', async (t) => {
    const { createGameApp, gameKey, revOf } = require('./src/routes/play.js');
    const ID = 'Tl_Game';
    const data = path.join(root, ID, 'www', 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(root, ID, 'www', 'index.html'), '<html><body></body></html>');
    fs.writeFileSync(path.join(data, 'System.json'), JSON.stringify({ terms: { commands: ['戦う'] } }));
    fs.writeFileSync(path.join(data, 'Map001.json'), JSON.stringify({ displayName: '', events: [null, { pages: [{ list: [{ code: 401, parameters: ['こんにちは'] }, { code: 0, parameters: [] }] }] }] }));
    fs.mkdirSync(path.join(root, ID, 'www', 'js'), { recursive: true });
    fs.writeFileSync(path.join(root, ID, 'www', 'js', 'plugins.js'), 'var $plugins = [{"name":"Menu","status":true,"parameters":{"Help Text":"こんにちは"}}];');
    // Размер задан сразу: у готовой игры без размера первый же список через секунду взвешивает её папку
    // и меняет список (library-changed), а это ломало сравнения списков в соседних тестах. Игру и папку
    // убираем: после теста она никому не нужна
    t.after(async () => {
        await dbService.get().run('DELETE FROM games WHERE id = ?', [ID]);
        await dbService.get().run('DELETE FROM game_translation WHERE id = ?', [ID]);
        fs.rmSync(path.join(root, ID), { recursive: true, force: true });
    });
    await dbService.get().run("INSERT INTO games (id, title, ready, size) VALUES (?, 'Tl', 1, 1024)", [ID]);

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

test('текст на картинках: без службы распознавания блок скрыт; заплатка подписи — рядом со страницей игры, надолго', async (t) => {
    const { createGameApp, gameKey, revOf } = require('./src/routes/play.js');
    const pictureService = require('./src/services/pictures.js');
    const ID = 'Pic_Game';
    fs.mkdirSync(path.join(root, ID, 'www', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, ID, 'www', 'index.html'), '<html><body></body></html>');
    fs.writeFileSync(path.join(root, ID, 'www', 'data', 'System.json'), JSON.stringify({ terms: { commands: ['戦う'] } }));
    // Размер задан и всё убирается после теста — по той же причине, что у игры «Tl_Game» выше
    t.after(async () => {
        await dbService.get().run('DELETE FROM games WHERE id = ?', [ID]);
        await dbService.get().run('DELETE FROM picture_patches WHERE hash = ?', ['ab'.repeat(20)]);
        fs.rmSync(path.join(root, ID), { recursive: true, force: true });
    });
    await dbService.get().run("INSERT INTO games (id, title, ready, size) VALUES (?, 'Pic', 1, 1024)", [ID]);
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

test('сцены библиотеки: вход, отбор из запроса, игра, очередь, сбой без путей', async () => {
    const ls = require('./src/services/libraryScenes.js');
    assert.strictEqual((await call('GET', '/api/scenes', { auth: false })).status, 401);
    for (const bad of ['..', 'a%2Fb']) assert.deepStrictEqual((await call('GET', `/api/scenes?game=${bad}`)).data, { error: 'bad-game' }, bad);
    // Настоящий ответ: форма
    const real = await call('GET', '/api/scenes');
    assert.strictEqual(real.status, 200);
    assert.ok(Array.isArray(real.data.games) && typeof real.data.total === 'number' && real.data.counts, JSON.stringify(real.data));
    let seen = null;
    try {
        ls.list = async (ids, opts) => { seen = { ids, ...opts }; return { total: 0, counts: { all: 0, scenes: 0, dialogue: 0 }, games: [] }; };
        ls.queue = async (ids, opts) => { seen = { ids, ...opts, queue: true }; return { queue: [], more: false }; };
        await call('GET', `/api/scenes?kind=dialogue&voice=1&anim=0&per=99&game=${GAME}`);
        assert.deepStrictEqual([seen.kind, seen.voice, seen.anim, seen.per, seen.game, seen.ids.includes(GAME)], ['dialogue', true, false, 12, GAME, true]);
        await call('GET', '/api/scenes?kind=evil&per=abc');
        assert.deepStrictEqual([seen.kind, seen.per], ['', 4], 'неизвестная вкладка — все, по умолчанию — 4 сцены на игру');
        assert.deepStrictEqual((await call('GET', '/api/scenes?queue=random&kind=scenes')).data, { queue: [], more: false });
        assert.deepStrictEqual([seen.queue, seen.random, seen.kind], [true, true, 'scenes']);
        await call('GET', '/api/scenes?queue=order&from=300');
        assert.deepStrictEqual([seen.random, seen.from], [false, 300]);
        await call('GET', '/api/scenes?queue=order&from=-5');
        assert.strictEqual(seen.from, 0);
        // Сбой — общий код, а не текст ошибки (в нём бывают пути на диске)
        ls.list = async () => { throw new Error('/srv/секретный/путь'); };
        const err = console.error;
        console.error = () => {};
        try { assert.deepStrictEqual(await call('GET', '/api/scenes').then((r) => [r.status, r.data]), [500, { error: 'scenes-failed' }]); } finally { console.error = err; }
    } finally {
        // Свои свойства поверх методов класса — убрать, методы снова из класса
        delete ls.list;
        delete ls.queue;
    }
});

test('подбор «Во что поиграть?»: вход, форма ответа, «не интересно» и отмена, перевод как причина', async (t) => {
    for (const [method, url] of [['GET', '/api/recommend/library'], ['POST', '/api/recommend/dismiss'], ['GET', '/api/recommend/dismissed'], ['DELETE', '/api/recommend/dismissed']]) {
        assert.strictEqual((await call(method, url, { auth: false, json: method === 'POST' ? { key: 'x' } : undefined })).status, 401, `${method} ${url} без входа`);
    }
    const db = dbService.get();
    const insert = (id) => db.run(`INSERT INTO games (id, title, tags, addedAt, scraped, ready, meta_status) VALUES (?, ?, '["fantasy"]', ?, 1, 1, 'ok')`, [id, id, Date.now()]);
    await insert('Rec_Short');
    await insert('Rec_Long');
    await db.run("UPDATE games SET playtime = 7200, lastPlayed = ? WHERE id = 'Rec_Long'", [Date.now() - 30 * 86400000]);
    const warn = t.mock.method(console, 'warn', () => {});
    try {
        const all = await call('GET', '/api/recommend/library');
        assert.strictEqual(all.status, 200);
        assert.deepStrictEqual(Object.keys(all.data).sort(), ['cold', 'items', 'resume', 'total']);
        const short = all.data.items.find((x) => x.id === 'Rec_Short');
        assert.deepStrictEqual(Object.keys(short).sort(), ['id', 'reasons', 'score'], 'игру клиент уже знает — только номер, балл и причины');
        assert.deepStrictEqual(short.reasons.find((r) => r.code === 'tags-like').params.tags, ['fantasy']);
        assert.deepStrictEqual(all.data.resume.find((x) => x.id === 'Rec_Long').reasons[0].code, 'left');
        assert.ok(!all.data.items.some((x) => x.id === 'Rec_Long'));

        const hide = await call('POST', '/api/recommend/dismiss', { json: { key: 'Rec_Short' } });
        assert.deepStrictEqual([hide.status, hide.data], [200, { ok: true, dismissed: 1 }]);
        const after = (await call('GET', '/api/recommend/library')).data;
        assert.ok(!after.items.some((x) => x.id === 'Rec_Short'));
        assert.deepStrictEqual((await call('POST', '/api/recommend/dismiss', { json: { key: 'Rec_Short', undo: true } })).data, { ok: true, dismissed: 0 });
        assert.ok((await call('GET', '/api/recommend/library')).data.items.some((x) => x.id === 'Rec_Short'));
        // Тост с отменой пропущен: из Настроек видно, сколько скрыто, и возвращается всё разом
        await call('POST', '/api/recommend/dismiss', { json: { key: 'Rec_Short' } });
        assert.deepStrictEqual((await call('GET', '/api/recommend/dismissed')).data, { count: 1 });
        assert.deepStrictEqual((await call('DELETE', '/api/recommend/dismissed')).data, { ok: true, dismissed: 0 });
        assert.deepStrictEqual((await call('GET', '/api/recommend/dismissed')).data, { count: 0 });
        assert.ok((await call('GET', '/api/recommend/library')).data.items.some((x) => x.id === 'Rec_Short'));
        for (const key of ['../evil', 'itch:abc', 'No_Such_Game']) {
            const bad = await call('POST', '/api/recommend/dismiss', { json: { key } });
            assert.deepStrictEqual([bad.status, bad.data.reason], [400, 'bad-key'], key);
        }

        // Перевод здесь — причина только у законченного: язык в строке появляется уже при включении
        for (const id of ['Rec_Tl_Done', 'Rec_Tl_Queued', 'Rec_Tl_Paused']) await insert(id);
        await db.run(`UPDATE games SET text_lang = '{"main":"ja","langs":["ja"]}' WHERE id LIKE 'Rec_Tl_%'`);
        await db.run("INSERT INTO game_translation (id, lang, state, done, total) VALUES ('Rec_Tl_Done', 'ru', 'done', 10, 10), ('Rec_Tl_Queued', 'ru', 'queued', 0, 10), ('Rec_Tl_Paused', 'ru', 'paused', 5, 10)");
        await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('known_langs', '["ru"]')`);
        const translatedHere = (await call('GET', '/api/recommend/library')).data.items.filter((x) => x.reasons.some((r) => r.code === 'translation' && r.params.site === 'mimikin'));
        assert.deepStrictEqual(translatedHere.map((x) => x.id), ['Rec_Tl_Done']);
        await db.run("DELETE FROM settings WHERE key = 'known_langs'");
    } finally {
        warn.mock.restore();
        await db.run("DELETE FROM games WHERE id IN ('Rec_Short', 'Rec_Long') OR id LIKE 'Rec_Tl_%'");
        await db.run("DELETE FROM game_translation WHERE id LIKE 'Rec_Tl_%'");
        await db.run("DELETE FROM settings WHERE key IN ('recommend_dismissed', 'known_langs')");
    }
});

// ============================================================================
// Личное у людей: заметки, оценки, подборки, избранное и список желаний владельца до них не доходят, и наоборот
// ============================================================================
async function personalSetup(t) {
    // Начинаем с чистого: от соседних тестов в списке желаний и избранном могли остаться записи
    const clean = async () => {
        const db = dbService.get();
        for (const table of ['user_games', 'user_wishlist', 'user_gallery_favorites']) await db.run(`DELETE FROM ${table}`);
        await db.run('DELETE FROM wishlist');
        await db.run('DELETE FROM gallery_favorites');
        await db.run("DELETE FROM settings WHERE key IN ('favorite_tags', 'hidden_tags', 'known_langs', 'recommend_dismissed')");
        await db.run("UPDATE games SET rating = 0, status = '', favorite = 0, notes = '', lists = '[]', lastPlayed = 0, playtime = 0 WHERE id = ?", [GAME]);
        await redisClient.del('api:games:list');
    };
    await clean();
    t.after(async () => { await clean(); await dropUsers(); });
    access.flags.accountsOn = true;
    await addUser('Vera', 'vera-pass-1');
    return cookieFrom(await loginAs('Vera', 'vera-pass-1')).value;
}

const OWNER_NOTE = 'owner-secret-note';
// Игры из «Найти»: ключ списка желаний — «itch:» и адрес игры
const WISH = (name) => ({ source: 'itch', url: `https://moon-studio.itch.io/${name}`, title: name });
const WISH_KEY = (name) => `itch:https://moon-studio.itch.io/${name}`;

test('личное: записи человека не меняют строку владельца, записи владельца не доходят до человека, ответ владельца не зависит от чужих строк', async (t) => {
    const vera = await personalSetup(t);
    const as = (value) => (value ? withCookie(value) : {});
    const db = dbService.get();
    // Картинка в галерее игры: избранное принимает только файл из оглавления
    const www = path.join(root, GAME, 'www');
    fs.mkdirSync(path.join(www, 'img', 'pictures'), { recursive: true });
    fs.writeFileSync(path.join(www, 'img', 'pictures', 'mine.png'), PNG);
    const gallery = require('./src/services/gallery.js');
    await gallery.forget(GAME);
    await gallery.build(GAME).promise;
    const FILE = 'img/pictures/mine.png';

    // Владелец: всё личное заполнено, включая теги и «не интересно»
    const meta = await call('POST', `/api/games/${GAME}/meta`, { json: { rating: 5, status: 'done', favorite: true, notes: OWNER_NOTE, lists: ['Owner list'], lastPlayed: 1700000000000 } });
    assert.strictEqual(meta.status, 200);
    await db.run('UPDATE games SET playtime = 7200 WHERE id = ?', [GAME]);
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('favorite_tags', ?), ('hidden_tags', ?), ('known_langs', ?), ('recommend_dismissed', ?)",
        [JSON.stringify(['pixel art']), JSON.stringify(['horror']), JSON.stringify(['ru']), JSON.stringify(['itch:1'])]);
    assert.strictEqual((await call('PUT', '/api/favorites', { json: { game: GAME, file: FILE, kind: 'cg' } })).status, 200);
    assert.strictEqual((await call('POST', '/api/wishlist', { json: WISH('owner-wish') })).status, 200);
    const snapshot = async () => JSON.stringify([
        await db.get('SELECT * FROM games WHERE id = ?', [GAME]), await db.all('SELECT * FROM wishlist'), await db.all('SELECT * FROM gallery_favorites'),
        await db.all("SELECT * FROM settings WHERE key IN ('favorite_tags', 'hidden_tags', 'known_langs', 'recommend_dismissed') ORDER BY key"),
    ]);
    const ownerList = async () => { await redisClient.del('api:games:list'); return (await call('GET', '/api/games')).raw; };
    const before = await snapshot();
    const listBefore = await ownerList();
    assert.ok(listBefore.toString().includes(OWNER_NOTE));

    // Человек до своих записей видит игру без чужого личного
    const empty = (await call('GET', '/api/games', as(vera))).data.find((g) => g.id === GAME);
    assert.deepStrictEqual([empty.id, empty.rating, empty.status, empty.favorite, empty.notes, empty.lists, empty.playtime, empty.lastPlayed, empty.progress, empty.shelfMatch],
        [GAME, 0, '', false, '', [], 0, 0, null, null]);
    const everything = [
        (await call('GET', '/api/games', as(vera))).raw, (await call('GET', '/api/wishlist', as(vera))).raw, (await call('GET', '/api/favorites', as(vera))).raw,
        (await call('GET', '/api/recommend/library', as(vera))).raw, (await call('GET', '/api/recommend/modes', as(vera))).raw, (await call('GET', `/api/gallery/${GAME}/tags`, as(vera))).raw,
    ].join('\n');
    for (const secret of [OWNER_NOTE, 'Owner list', 'owner-wish', 'fantasy', 'horror']) assert.ok(!everything.includes(secret), `человек не видит: ${secret}`);
    assert.deepStrictEqual((await call('GET', '/api/wishlist', as(vera))).data, { items: [] });
    assert.deepStrictEqual((await call('GET', '/api/favorites', as(vera))).data, []);
    // Остальные поля игры у человека те же, что у владельца
    const same = (a, b) => { const { rating, status, favorite, notes, lists, playtime, lastPlayed, progress, shelfMatch, ...rest } = a; void rating; void status; void favorite; void notes; void lists; void playtime; void lastPlayed; void progress; void shelfMatch; return rest; };
    assert.deepStrictEqual(same(empty), same(JSON.parse(listBefore).find((g) => g.id === GAME)));

    // Записи человека: заметка, оценка, статус, подборка, любимая, избранное, список желаний
    const mine = await call('POST', `/api/games/${GAME}/meta`, { ...as(vera), json: { rating: 2, status: 'playing', favorite: true, notes: 'vera-note', lists: ['Vera list'], lastPlayed: 1800000000000 } });
    assert.strictEqual(mine.status, 200);
    assert.deepStrictEqual((await call('POST', `/api/games/${GAME}/meta`, { ...as(vera), json: { status: 'bogus' } })).status, 400);
    assert.deepStrictEqual((await call('POST', '/api/games/lists/change', { ...as(vera), json: { from: 'Vera list', to: 'Vera shelf' } })).data, { changed: 1 });
    assert.deepStrictEqual((await call('POST', '/api/games/lists/change', { ...as(vera), json: { from: 'Owner list', to: 'Stolen' } })).data, { changed: 0 }, 'подборку владельца человек не переименует');
    assert.strictEqual((await call('PUT', '/api/favorites', { ...as(vera), json: { game: GAME, file: FILE, kind: 'cg' } })).status, 200);
    assert.strictEqual((await call('POST', '/api/wishlist', { ...as(vera), json: WISH('vera-wish') })).status, 200);
    const seen = (await call('GET', '/api/games', as(vera))).data.find((g) => g.id === GAME);
    assert.deepStrictEqual([seen.rating, seen.status, seen.favorite, seen.notes, seen.lists, seen.lastPlayed, seen.playtime], [2, 'playing', true, 'vera-note', ['Vera shelf'], 1800000000000, 0]);
    assert.deepStrictEqual((await call('GET', '/api/wishlist', as(vera))).data.items.map((x) => x.key), [WISH_KEY('vera-wish')]);
    assert.strictEqual((await call('GET', '/api/favorites', as(vera))).data.length, 1);

    // В ту сторону: строка владельца, его таблицы и настройки не изменились ни на байт, ответ владельца тот же
    assert.strictEqual(await snapshot(), before, 'записи человека владельца не тронули');
    assert.ok((await ownerList()).equals(listBefore), 'список владельца с чужими строками и без них одинаков');
    assert.deepStrictEqual((await call('GET', '/api/wishlist')).data.items.map((x) => x.key), [WISH_KEY('owner-wish')]);
    assert.strictEqual(JSON.stringify((await call('GET', '/api/favorites')).data.map((f) => f.file)), JSON.stringify([FILE]));

    // И в обратную: владелец меняет своё — человек не замечает
    const veraListBefore = (await call('GET', '/api/games', as(vera))).raw;
    await call('POST', `/api/games/${GAME}/meta`, { json: { rating: 1, status: 'dropped', notes: 'changed by owner', lists: ['Other'], favorite: false } });
    await call('POST', '/api/games/lists/change', { json: { from: 'Other', to: 'Renamed' } });
    await call('DELETE', `/api/favorites?game=${GAME}&f=${encodeURIComponent(FILE)}`);
    await call('DELETE', `/api/wishlist?key=${WISH_KEY('owner-wish')}`);
    assert.ok((await call('GET', '/api/games', as(vera))).raw.equals(veraListBefore), 'ответ человека не изменился');
    assert.strictEqual((await call('GET', '/api/favorites', as(vera))).data.length, 1);
    assert.deepStrictEqual((await call('GET', '/api/wishlist', as(vera))).data.items.map((x) => x.key), [WISH_KEY('vera-wish')]);
    const removed = await call('DELETE', `/api/wishlist?key=${WISH_KEY('vera-wish')}`, as(vera));
    assert.deepStrictEqual(removed.data, { removed: true });
    assert.strictEqual((await call('DELETE', `/api/favorites?game=${GAME}&f=${encodeURIComponent(FILE)}`, as(vera))).status, 200);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM user_gallery_favorites')).n, 0);
    assert.strictEqual((await db.get('SELECT rating FROM games WHERE id = ?', [GAME])).rating, 1);
});

test('личное: подбор человеку — его игры и пустые настройки, скрытые теги владельца не прячут ему картинки', async (t) => {
    const vera = await personalSetup(t);
    const db = dbService.get();
    await db.run("UPDATE games SET rating = 5, status = 'done', playtime = 7200, lastPlayed = ? WHERE id = ?", [Date.now(), GAME]);
    await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('favorite_tags', ?), ('hidden_tags', ?)", [JSON.stringify(['pixel art']), JSON.stringify(['horror'])]);
    const ownerLib = (await call('GET', '/api/recommend/library')).data;
    const userLib = (await call('GET', '/api/recommend/library', withCookie(vera))).data;
    assert.strictEqual(ownerLib.cold, false, 'у владельца игра сыграна');
    assert.deepStrictEqual(userLib.resume, [], 'человек эту игру не играл');
    assert.strictEqual(userLib.cold, true);
    const tags = await call('GET', `/api/gallery/${GAME}/tags`, withCookie(vera));
    assert.deepStrictEqual(tags.data.hidden, []);
    assert.deepStrictEqual((await call('GET', `/api/gallery/${GAME}/tags`)).data.hidden, ['horror']);
    assert.strictEqual((await call('GET', '/api/pictures/hidden', withCookie(vera))).data.reason, 'owner-only');
});

test('личное: сокет человека не слышит события владельца; список изменился — слышат все, запись человека — только его устройства', async (t) => {
    const vera = await personalSetup(t);
    const WebSocket = require('ws');
    const sockets = ioServer.listen(0, '127.0.0.1');
    await new Promise((r) => sockets.once('listening', r));
    const heard = new Map();
    t.after(() => { for (const s of io.sockets.sockets.values()) s.disconnect(true); sockets.close(); });
    const connect = async (name, token) => {
        const ws = new WebSocket(`ws://127.0.0.1:${sockets.address().port}/socket.io/?EIO=4&transport=websocket`, { headers: { cookie: `${COOKIE}=${token}` } });
        const events = [];
        heard.set(name, events);
        await new Promise((resolve, reject) => {
            ws.on('error', reject);
            ws.on('message', (d) => {
                const text = d.toString();
                if (text.startsWith('0{')) ws.send('40');
                else if (text.startsWith('40')) resolve();
                else if (text === '2') ws.send('3');
                else if (text.startsWith('42')) events.push(JSON.parse(text.slice(2))[0]);
            });
        });
        return ws;
    };
    await connect('owner', cookie);
    await connect('vera', vera);
    const settle = () => new Promise((r) => setTimeout(r, 300));
    const mark = () => { for (const events of heard.values()) events.length = 0; };
    // Сдача фоновой работы соседних тестов (их «список изменился» слышат все) приходит когда угодно, на быстрой машине CI — позже.
    // Ждём, пока секунду никто ничего не слышал, и только потом начинаем счёт
    const quiet = async () => {
        const total = () => [...heard.values()].reduce((n, events) => n + events.length, 0);
        for (let calm = 0, tries = 0; calm < 5 && tries < 50; tries++) {
            const before = total();
            await new Promise((r) => setTimeout(r, 200));
            calm = total() === before ? calm + 1 : 0;
        }
        mark();
    };

    // Событие службы владельца (как «идёт проверка») — по комнате owner. Сначала дать затихнуть
    // фоновой работе соседних тестов: её «список изменился» слышат все
    await quiet();
    const { getIo } = require('./src/utils/cache.js');
    getIo().emit('fullcheck', { x: 1 });
    getIo().emit('scrape-progress', { left: 3 });
    await settle();
    // «Список изменился» от фоновой работы соседних тестов слышат все и в любой миг, даже после тихой секунды; здесь проверяем службы
    const besides = (name) => heard.get(name).filter((event) => event !== 'library-changed');
    assert.deepStrictEqual([besides('owner'), besides('vera')], [['fullcheck', 'scrape-progress'], []], 'службы шлют владельцу');

    // Запись владельца: список игр изменился — всем; список желаний — только ему
    await quiet();
    await call('POST', `/api/games/${GAME}/meta`, { json: { notes: 'n' } });
    await call('POST', '/api/wishlist', { json: WISH('owner-wish-2') });
    await settle();
    // Кто что слышал, а не сколько раз: «список изменился» одной записи могут дополнить соседние
    const kinds = (name) => [...new Set(heard.get(name))].sort();
    assert.deepStrictEqual([kinds('owner'), kinds('vera')], [['library-changed', 'wishlist-changed'], ['library-changed']]);

    // Запись человека: его устройствам, владельцу — тишина, общий кэш не сброшен
    await quiet();
    await redisClient.set('api:games:list', JSON.stringify([]), { EX: 300 });
    await call('POST', `/api/games/${GAME}/meta`, { ...withCookie(vera), json: { notes: 'v' } });
    await call('POST', '/api/wishlist', { ...withCookie(vera), json: WISH('vera-wish-2') });
    await settle();
    // Чужое общее «список изменился» слышат оба поровну, поэтому у человека его ровно на одно больше: это его собственное.
    // Ушла бы его запись всем — было бы поровну
    const lists = (name) => heard.get(name).length - besides(name).length;
    assert.deepStrictEqual([besides('vera'), besides('owner')], [['wishlist-changed'], []]);
    assert.strictEqual(lists('vera'), lists('owner') + 1, 'запись человека — только его устройствам');
    // Общее событие соседа сбрасывает и кэш: тогда сверять его нечем
    if (!lists('owner')) assert.strictEqual(await redisClient.get('api:games:list'), '[]', 'запись человека кэш владельца не сбросила');
});

// ============================================================================
// Личные сейвы: у каждого человека свои сейвы, моменты и «путь» (_saves/.people/<id>), владелец остаётся в _saves
// ============================================================================
const SAVE_GAME = 'Shared_Slot_Game';

const slotValue = (seconds, gold) => JSON.stringify({ system: { _framesOnSave: seconds * 60 }, party: { _gold: gold }, map: { _mapId: 0 }, actors: { _data: [] } });

const JPG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

// Двое людей, игра с строкой в games и сервер игр с теми же хранилищами, что собирает server.js
async function savesSetup(t) {
    const veraCookie = await personalSetup(t);
    await addUser('Boris', 'boris-pass-1');
    const borisCookie = cookieFrom(await loginAs('Boris', 'boris-pass-1')).value;
    const db = dbService.get();
    const veraId = (await db.get("SELECT id FROM users WHERE name = 'Vera'")).id;
    const borisId = (await db.get("SELECT id FROM users WHERE name = 'Boris'")).id;
    const savesRoot = path.join(root, '_saves');
    const wipe = () => {
        for (const base of ['', '.marks', '.journal', '.history', '.shots']) fs.rmSync(path.join(savesRoot, base, SAVE_GAME), { recursive: true, force: true });
        fs.rmSync(path.join(savesRoot, '.people'), { recursive: true, force: true });
    };
    wipe();
    fs.mkdirSync(path.join(root, SAVE_GAME, 'www', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, SAVE_GAME, 'www', 'index.html'), '<html><body></body></html>');
    fs.writeFileSync(path.join(root, SAVE_GAME, 'www', 'data', 'System.json'), '{}');
    await db.run("INSERT OR REPLACE INTO games (id, title, addedAt, ready, scraped) VALUES (?, 'Shared Slot', 1, 1, 1)", [SAVE_GAME]);

    const { createGameApp, gameKey, revOf } = require('./src/routes/play.js');
    const sessions = require('./src/utils/sessions.js');
    const personStores = require('./src/utils/personStores.js');
    const { gameHooks } = require('./src/utils/saveprogress.js');
    const gameServer = createGameApp({
        secret: () => dbService.getSessionToken(), sessions: { find: sessions.findById, legacyOpen: () => dbService.legacyOpen() },
        store: personStores.owner.saves, marks: personStores.owner.marks, journal: personStores.owner.journal,
        storesFor: (userId) => personStores.storesFor({ id: userId }), publicDir: path.join(__dirname, 'public'),
        mayOpen: (userId, id) => require('./src/services/gameAccess.js').may({ id: userId }, id),
        ...gameHooks,
    }).listen(0, '127.0.0.1');
    await new Promise((r) => gameServer.once('listening', r));
    t.after(async () => {
        gameServer.close();
        wipe();
        fs.rmSync(path.join(root, SAVE_GAME), { recursive: true, force: true });
        await db.run('DELETE FROM games WHERE id = ?', [SAVE_GAME]);
        dbService.legacyUntil = 0;
    });
    // Окно старой куки закрыто: сразу после первого человека оно и так закрывается (routes/users.js)
    dbService.legacyUntil = 0;
    const send = (method, url, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: gameServer.address().port, path: url, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body && JSON.stringify(body));
    });
    const keyOf = async (headers) => (await call('POST', `/api/play/${SAVE_GAME}`, headers)).data.session;
    const keys = { owner: await keyOf({}), vera: await keyOf(withCookie(veraCookie)), boris: await keyOf(withCookie(borisCookie)) };
    const as = { owner: {}, vera: withCookie(veraCookie), boris: withCookie(borisCookie) };
    const until = async (fn) => { for (let i = 0; i < 60; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
    return { db, veraId, borisId, savesRoot, send, keys, as, until, gameKey, revOf, personStores };
}

test('личные сейвы: двое играют в одну игру и один слот — каждый видит и пишет только своё, владелец остаётся в своих путях', async (t) => {
    const { db, veraId, borisId, savesRoot, send, keys, as, until, gameKey, revOf, personStores } = await savesSetup(t);
    const slot = encodeURIComponent('RPG File1');
    const write = (who, value, at = 1000) => send('POST', `/saves/${keys[who]}/${SAVE_GAME}/${slot}`, { value, updatedAt: at });
    const mark = (who, label, playtime) => send('POST', `/marks/${keys[who]}/${SAVE_GAME}`, { label, map: 'Map', value: `{"by":"${label}"}`, thumb: JPG, playtime });
    const scene = (who, label) => send('POST', `/journal/${keys[who]}/${SAVE_GAME}`, { kind: 'scene', label, key: `scene-${label}` });

    // Ключ сессии у каждого свой; хранилище владельца — одно на процесс и в тех же путях, что всегда
    assert.strictEqual(new Set(Object.values(keys)).size, 3);
    assert.strictEqual(personStores.storesFor(null), personStores.owner);
    assert.strictEqual(personStores.storesFor({ id: 'owner', isOwner: true }), personStores.owner);
    assert.strictEqual(personStores.owner.root, savesRoot);
    assert.strictEqual(require('./src/routes/saves.js').store, personStores.owner.saves);
    assert.strictEqual(require('./src/routes/marks.js').store, personStores.owner.marks);
    assert.strictEqual(require('./src/routes/journal.js').store, personStores.owner.journal);
    assert.throws(() => personStores.storesFor({ id: '../owner' }), /Некорректный/);
    assert.throws(() => personStores.storesFor({ id: 'u' + '0'.repeat(15) + '/' }), /Некорректный/);

    // Все трое пишут в один и тот же слот
    const ownerGames = await db.get('SELECT * FROM games WHERE id = ?', [SAVE_GAME]);
    assert.strictEqual((await write('owner', slotValue(600, 1))).status, 200);
    assert.strictEqual((await write('vera', slotValue(1200, 2))).status, 200);
    assert.strictEqual((await write('boris', slotValue(1800, 3))).status, 200);
    assert.strictEqual((await mark('vera', 'Vera spot', 4000)).status, 200);
    assert.strictEqual((await mark('boris', 'Boris spot', 5000)).status, 200);
    assert.strictEqual((await mark('owner', 'Owner spot', 0)).status, 200);
    for (const who of ['vera', 'boris', 'owner']) assert.strictEqual((await scene(who, `${who} scene`)).status, 200);

    // Сейв, момент и запись «Пути» каждого — только его
    for (const who of ['owner', 'vera', 'boris']) {
        const saves = (await call('GET', `/api/saves/${SAVE_GAME}`, as[who])).data;
        assert.deepStrictEqual(Object.values(saves).map((s) => JSON.parse(s.value).party._gold), [{ owner: 1, vera: 2, boris: 3 }[who]], `сейвы: ${who}`);
        const marks = (await call('GET', `/api/marks/${SAVE_GAME}`, as[who])).data;
        assert.deepStrictEqual(marks.map((m) => m.label), [`${who[0].toUpperCase()}${who.slice(1)} spot`], `моменты: ${who}`);
        const trail = (await call('GET', `/api/journal/${SAVE_GAME}`, as[who])).data;
        assert.deepStrictEqual(trail.map((e) => e.label), [`${who} scene`], `путь: ${who}`);
        // То же через сервер игр, по его ключу
        const viaGame = JSON.parse((await send('GET', `/saves/${keys[who]}/${SAVE_GAME}`)).body);
        assert.deepStrictEqual(Object.values(viaGame).map((s) => JSON.parse(s.value).party._gold), [{ owner: 1, vera: 2, boris: 3 }[who]]);
    }

    // Новый сейв Веры того же слота уходит в историю её слота, а не затирает сейвы других
    assert.strictEqual((await write('vera', slotValue(2400, 22), 2000)).status, 200);
    assert.deepStrictEqual(Object.values((await call('GET', `/api/saves/${SAVE_GAME}`, as.vera)).data).map((s) => JSON.parse(s.value).party._gold), [22]);
    const history = (await call('GET', `/api/saves/history/${SAVE_GAME}`, as.vera)).data.slots[0];
    assert.deepStrictEqual([JSON.parse(await fs.promises.readFile(personStores.storesFor({ id: veraId }).saves.slotFile(SAVE_GAME, 'RPG File1'), 'utf8')).party._gold, history.versions.length], [22, 1]);
    assert.deepStrictEqual((await call('GET', `/api/saves/history/${SAVE_GAME}`, as.owner)).data.slots[0].versions, [], 'у владельца версий не прибавилось');
    assert.deepStrictEqual(Object.values((await call('GET', `/api/saves/${SAVE_GAME}`, as.boris)).data).map((s) => JSON.parse(s.value).party._gold), [3]);

    // Пути на диске: владелец — как всегда, остальные — зеркало в .people/<id>
    const ownerFile = path.join(savesRoot, SAVE_GAME, 'RPG%20File1.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).party._gold, 1);
    assert.deepStrictEqual(fs.readdirSync(path.join(savesRoot, SAVE_GAME)), ['RPG%20File1.json'], 'у владельца в папке игры только его слот');
    assert.deepStrictEqual(fs.readdirSync(path.join(savesRoot, '.marks', SAVE_GAME)).filter((n) => n.endsWith('.json') && !n.startsWith('_')).length, 1);
    assert.ok(fs.existsSync(path.join(savesRoot, '.journal', SAVE_GAME, 'log.json')));
    assert.deepStrictEqual(fs.readdirSync(path.join(savesRoot, '.people')).sort(), [veraId, borisId].sort());
    for (const id of [veraId, borisId]) {
        assert.ok(fs.existsSync(path.join(savesRoot, '.people', id, SAVE_GAME, 'RPG%20File1.json')));
        assert.ok(fs.existsSync(path.join(savesRoot, '.people', id, '.journal', SAVE_GAME, 'log.json')));
        assert.strictEqual(fs.readdirSync(path.join(savesRoot, '.people', id, '.marks', SAVE_GAME)).filter((n) => n.endsWith('.json') && !n.startsWith('_')).length, 1);
    }

    // Время игры и прогресс человека — в его user_games; строка владельца в games не получает от людей ничего
    assert.ok(await until(async () => (await db.get('SELECT playtime FROM games WHERE id = ?', [SAVE_GAME])).playtime === 600), 'время владельца записалось в games');
    const mine = async (id) => db.get('SELECT playtime, progress FROM user_games WHERE user_id = ? AND game_id = ?', [id, SAVE_GAME]);
    assert.ok(await until(async () => (await mine(veraId))?.playtime === 4000 && (await mine(borisId))?.playtime === 5000), 'момент человека поднял его время');
    assert.deepStrictEqual([JSON.parse((await mine(veraId)).progress).playtime, JSON.parse((await mine(borisId)).progress).gold], [2400, 3], 'прогресс — по его сейву');
    const afterOwner = await db.get('SELECT playtime, progress FROM games WHERE id = ?', [SAVE_GAME]);
    assert.strictEqual(afterOwner.playtime, 600);
    assert.strictEqual(JSON.parse(afterOwner.progress).gold, 1, 'прогресс владельца — по его сейву');
    void ownerGames;
    // Людям список показывает их собственные
    assert.deepStrictEqual((await call('GET', '/api/games', as.vera)).data.filter((g) => g.id === SAVE_GAME).map((g) => [g.playtime, g.progress.gold]), [[4000, 22]]);

    // Страница игры: человеку сервер называет его в window.__RPG (хранилище браузера у людей одного браузера общее), владельцу — нет
    const fileKey = gameKey(dbService.getSessionToken(), SAVE_GAME, await revOf(SAVE_GAME));
    const page = (who) => send('GET', `/g/${fileKey}/${SAVE_GAME}/www/index.html?s=${keys[who]}`);
    assert.match((await page('vera')).body, new RegExp(`"who":"${veraId}"`));
    assert.ok(!(await page('owner')).body.includes('"who"'), 'владельцу страница та же, что всегда');

    // Очередь сцен: человеку игры не в порядке «играл владелец» — это выдало бы, во что тот играл
    const ls = require('./src/services/libraryScenes.js');
    const oldQueue = ls.queue;
    try {
        let ids = null;
        ls.queue = async (list) => { ids = list; return { queue: [], more: false }; };
        await db.run('UPDATE games SET lastPlayed = 0');
        await db.run('UPDATE games SET lastPlayed = 999999 WHERE id = ?', [SAVE_GAME]);
        await call('GET', '/api/scenes?queue=order');
        assert.strictEqual(ids[0], SAVE_GAME, 'владельцу — недавние первыми');
        await call('GET', '/api/scenes?queue=order', as.vera);
        const added = (await db.all('SELECT id FROM games WHERE shelved_at = 0 ORDER BY addedAt DESC')).map((g) => g.id);
        assert.deepStrictEqual(ids, added, 'человеку — по дате добавления');
    } finally { ls.queue = oldQueue; }
});

test('личные сейвы: человек не дотянется до сейвов владельца и других ни ключом, ни путём, ни «..»', async (t) => {
    const { veraId, borisId, savesRoot, send, keys, as, gameKey, revOf, db } = await savesSetup(t);
    const slot = encodeURIComponent('RPG File1');
    await send('POST', `/saves/${keys.owner}/${SAVE_GAME}/${slot}`, { value: 'OWNER-SECRET-SAVE', updatedAt: 1 });
    await send('POST', `/saves/${keys.boris}/${SAVE_GAME}/${slot}`, { value: 'BORIS-SECRET-SAVE', updatedAt: 1 });
    await send('POST', `/marks/${keys.boris}/${SAVE_GAME}`, { label: 'BORIS-SECRET-MARK', map: 'M', value: '{}', thumb: JPG });
    // Картинка внутри чужой папки: через адрес картинок библиотеки её тоже не отдать
    fs.mkdirSync(path.join(savesRoot, '.people', borisId, SAVE_GAME), { recursive: true });
    fs.writeFileSync(path.join(savesRoot, '.people', borisId, SAVE_GAME, 'shot.png'), PNG);
    fs.mkdirSync(path.join(savesRoot, SAVE_GAME), { recursive: true });
    fs.writeFileSync(path.join(savesRoot, SAVE_GAME, 'shot.png'), PNG);
    const secrets = /OWNER-SECRET|BORIS-SECRET/;

    // Через API библиотеки: имя игры с точкой или «..» отбивается до работы с диском, остальное читает папку самого человека
    const veraRoot = (rest) => path.join(savesRoot, '.people', veraId, rest);
    for (const url of [
        '/api/saves/.people', '/api/saves/..', `/api/saves/%2e%2e%2f.people%2f${borisId}`, `/api/saves/history/.people`, '/api/saves/history/..',
        `/api/saves/export/%2e%2e%2f.people%2f${borisId}`, `/api/saves/shot/..%2f.people?key=x`, '/api/marks/.people', `/api/marks/..%2f.people%2f${borisId}`,
        '/api/journal/.people', `/api/journal/..%2f.people%2f${borisId}%2f${SAVE_GAME}`,
    ]) {
        const res = await call('GET', url, as.vera);
        assert.ok([400, 403, 404].includes(res.status), `${url}: ${res.status}`);
        assert.ok(!secrets.test(res.raw.toString()), url);
    }
    // Игра с id, похожим на id человека, — просто игра: читается папка Веры, не Бориса
    const odd = await call('GET', `/api/saves/${borisId}`, as.vera);
    assert.deepStrictEqual([odd.status, odd.data], [200, {}]);
    assert.ok(!fs.existsSync(veraRoot(borisId)), 'чтение ничего не создало');

    // Сервер игр: ключ сессии — на одну игру и один вход; ключ файлов (его знает и человек: он в адресе игры) без окна не пишет
    const other = encodeURIComponent('Other_Game');
    assert.strictEqual((await send('GET', `/saves/${keys.vera}/${other}`)).status, 403, 'ключ сессии чужой игры');
    for (const game of ['..', '%2e%2e', '.people', `%2e%2e%2f.people%2f${borisId}`, '.marks']) {
        assert.strictEqual((await send('GET', `/saves/${keys.vera}/${game}`)).status, 403, `игра «${game}»`);
        assert.strictEqual((await send('POST', `/saves/${keys.vera}/${game}/${slot}`, { value: 'x', updatedAt: 1 })).status, 403);
        assert.strictEqual((await send('GET', `/marks/${keys.vera}/${game}`)).status, 403);
        assert.strictEqual((await send('POST', `/journal/${keys.vera}/${game}`, { kind: 'scene', label: 'x' })).status, 403);
    }
    const fileKey = gameKey(dbService.getSessionToken(), SAVE_GAME, await revOf(SAVE_GAME));
    for (const url of [`/saves/${fileKey}/${SAVE_GAME}`, `/marks/${fileKey}/${SAVE_GAME}`]) {
        assert.strictEqual((await send('GET', url)).status, 403, `ключ файлов не пишет и не читает: ${url}`);
    }
    assert.strictEqual((await send('POST', `/journal/${fileKey}/${SAVE_GAME}`, { kind: 'scene', label: 'x' })).status, 403);
    assert.strictEqual((await send('GET', `/saves/${'0'.repeat(48)}/${SAVE_GAME}`)).status, 403, 'выдуманный ключ сессии');
    // Слот с «..» в имени сводится к имени файла и ложится в папку самого человека
    assert.strictEqual((await send('POST', `/saves/${keys.vera}/${SAVE_GAME}/${encodeURIComponent('../../' + borisId)}`, { value: 'VERA-WROTE', updatedAt: 1 })).status, 200);
    assert.ok(fs.existsSync(path.join(savesRoot, '.people', veraId, SAVE_GAME, `${borisId}.json`)));
    assert.deepStrictEqual(fs.readdirSync(path.join(savesRoot, '.people', borisId, SAVE_GAME)).sort(), ['RPG%20File1.json', 'shot.png'].sort());
    // Файлы игры по ключу файлов: путь только внутри папки игры
    for (const rest of [`../_saves/${SAVE_GAME}/RPG%20File1.json`, `..%2f_saves%2f.people%2f${borisId}%2f${SAVE_GAME}%2fRPG%2520File1.json`, `www/..%2f..%2flibrary.db`]) {
        assert.ok([400, 403, 404].includes((await send('GET', `/g/${fileKey}/${SAVE_GAME}/${rest}`)).status), rest);
    }

    // Адрес картинок библиотеки: «..» выводил бы в _saves — владельцу и людям закрыто одинаково
    for (const who of ['vera', 'owner']) {
        for (const rest of [`/${SAVE_GAME}/../_saves/.people/${borisId}/${SAVE_GAME}/shot.png`, `/x/../_saves/${SAVE_GAME}/shot.png`, `/${SAVE_GAME}/%2e%2e/_saves/.people/${borisId}/${SAVE_GAME}/shot.png`]) {
            const res = await call('GET', rest, as[who]);
            assert.ok([400, 403, 404].includes(res.status) && !res.raw.equals(PNG), `${who} ${rest}: ${res.status}`);
        }
    }
    void db;
});

test('личные сейвы: страница игры называет человека (window.__RPG.who), владельцу — нет; без живого входа страница не открывается', async (t) => {
    const { veraId, borisId, send, keys, gameKey, revOf } = await savesSetup(t);
    const fileKey = gameKey(dbService.getSessionToken(), SAVE_GAME, await revOf(SAVE_GAME));
    const page = async (s) => send('GET', `/g/${fileKey}/${SAVE_GAME}/www/index.html${s === undefined ? '' : `?s=${s}`}`);
    const config = (res) => JSON.parse(/window\.__RPG=(\{.*?\})<\/script>/.exec(res.body)[1]);

    const vera = await page(keys.vera);
    assert.strictEqual(vera.status, 200);
    assert.strictEqual(config(vera).who, veraId, 'человеку страница называет его id');
    assert.strictEqual(config(await page(keys.boris)).who, borisId);
    assert.ok(config(vera).saves.includes(keys.vera), 'и пишет сейвы по его ключу сессии');
    const owner = config(await page(keys.owner));
    assert.ok(!('who' in owner), 'владельцу who не вставляется: его ключи в браузере прежние');
    assert.ok(owner.saves.includes(keys.owner));
    // Окно старой куки закрыто (savesSetup), адрес файлов без ключа сессии писать не даёт: страницы нет
    assert.strictEqual((await page()).status, 403);
});

test('личные сейвы: ревизия не считает .people сиротой, восстановление не читает её как игру', async (t) => {
    const { veraId, savesRoot } = await savesSetup(t);
    const { restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    fs.mkdirSync(path.join(savesRoot, '.people', veraId, 'Friend_Only_Game'), { recursive: true });
    fs.writeFileSync(path.join(savesRoot, '.people', veraId, 'Friend_Only_Game', 'RPG%20File1.json'), 'x');
    fs.mkdirSync(path.join(savesRoot, 'Real_Orphan_Game'), { recursive: true });
    t.after(() => fs.rmSync(path.join(savesRoot, 'Real_Orphan_Game'), { recursive: true, force: true }));
    const ids = (await call('GET', '/api/games/audit')).data.orphans.map((o) => o.id);
    assert.ok(ids.includes('Real_Orphan_Game'), 'настоящая сирота на месте');
    assert.ok(!ids.some((id) => id === '.people' || id === veraId || id === 'Friend_Only_Game'), `в ревизии: ${ids}`);

    // Копия, в которой есть и сейвы владельца, и .people: игрой читается только первое
    const dir = fs.mkdtempSync(path.join(root, '_tmp_people'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { open } = require('sqlite');
    const sqlite3 = require('sqlite3');
    const bk = await open({ filename: path.join(dir, 'library.db'), driver: sqlite3.Database });
    await bk.exec('CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE wishlist (key TEXT PRIMARY KEY)');
    await bk.close();
    for (const rel of ['Own_Game', path.join('.people', veraId, 'Friend_Only_Game')]) {
        fs.mkdirSync(path.join(dir, '_saves', rel), { recursive: true });
        fs.writeFileSync(path.join(dir, '_saves', rel, 'RPG%20File1.json'), 'save');
    }
    const imported = [];
    const res = await restoreBackup(dir, { trash, store: { importSaves: async (id, saves) => { imported.push([id, saves.length]); } }, onSave: async () => {} });
    assert.deepStrictEqual(imported, [['Own_Game', 1]]);
    assert.strictEqual(res.saves, 1);
});

// --- Копия и люди (routes/backup.js): их строки, сейвы и входы ---
const openDb = async (file, mode) => require('sqlite').open({ filename: file, driver: require('sqlite3').Database, ...(mode && { mode }) });

test('копия и люди: старая копия без людей возвращает владельца как раньше и не трогает людей', async (t) => {
    const { veraId, savesRoot, db } = await savesSetup(t);
    const { restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    await db.run("INSERT INTO user_games (user_id, game_id, rating, notes, at) VALUES (?, ?, 5, 'vera note', 1)", [veraId, SAVE_GAME]);
    const hash = (await db.get('SELECT pass_hash FROM users WHERE id = ?', [veraId])).pass_hash;
    const mine = path.join(savesRoot, '.people', veraId, SAVE_GAME);
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'RPG%20File1.json'), 'vera save');

    // Копия прежней версии: ни users, ни user_*, ни .people
    const dir = fs.mkdtempSync(path.join(root, '_tmp_oldbk'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bk = await openDb(path.join(dir, 'library.db'));
    await bk.exec('CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE wishlist (key TEXT PRIMARY KEY)');
    await bk.run("INSERT INTO games VALUES ('Old_Copy_Game', 'Old')");
    await bk.close();
    fs.mkdirSync(path.join(dir, '_saves', 'Own_Game'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_saves', 'Own_Game', 'RPG%20File1.json'), 'own save');
    const imported = [];
    t.after(() => db.run("DELETE FROM games WHERE id = 'Old_Copy_Game'"));
    const res = await restoreBackup(dir, { trash, store: { importSaves: async (id, saves) => { imported.push([id, saves.length]); } }, onSave: async () => {} });

    assert.deepStrictEqual([res.shelved, res.saves, res.peopleSaves], [['Old_Copy_Game'], 1, 0]);
    assert.deepStrictEqual(imported, [['Own_Game', 1]]);
    assert.deepStrictEqual(await db.all('SELECT id, pass_hash FROM users WHERE id = ?', [veraId]), [{ id: veraId, pass_hash: hash }]);
    assert.deepStrictEqual(await db.all('SELECT rating, notes FROM user_games WHERE user_id = ?', [veraId]), [{ rating: 5, notes: 'vera note' }]);
    assert.strictEqual(fs.readFileSync(path.join(mine, 'RPG%20File1.json'), 'utf8'), 'vera save');
});

test('копия и люди: круг — люди, их строки и сейвы возвращаются, хэши и входы в архив не попадают', { skip: !hasSevenZip() && 'нет 7zz' }, async (t) => {
    const { veraId, borisId, savesRoot, db, personStores } = await savesSetup(t);
    const { buildBackup, unpackBackup, restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    const slot = 'RPG File1';
    const file = (id) => path.join(savesRoot, '.people', id, SAVE_GAME, 'RPG%20File1.json');
    await personStores.owner.saves.write(SAVE_GAME, slot, slotValue(600, 1), 1000);
    await personStores.storesFor({ id: veraId }).saves.write(SAVE_GAME, slot, slotValue(1200, 2), 1000);
    await personStores.storesFor({ id: borisId }).saves.write(SAVE_GAME, slot, slotValue(1800, 3), 1000);
    // Вторая версия слота — в истории: ночная копия её не берёт, но и эта (скачанная) не должна тащить её людям
    await personStores.storesFor({ id: veraId }).saves.write(SAVE_GAME, slot, slotValue(1300, 4), 2000);
    fs.mkdirSync(path.join(savesRoot, '.people', veraId, '.marks', SAVE_GAME), { recursive: true });
    fs.writeFileSync(path.join(savesRoot, '.people', veraId, '.marks', SAVE_GAME, 'spot.json'), '{"by":"vera"}');
    await db.run("INSERT INTO user_games (user_id, game_id, rating, notes, at) VALUES (?, ?, 5, 'vera note', 1), (?, ?, 2, 'boris note', 1)", [veraId, SAVE_GAME, borisId, SAVE_GAME]);
    await db.run("INSERT INTO user_wishlist (user_id, key, source, ref, url, at) VALUES (?, 'x:1', 'x', '1', 'https://x.test/1', 1)", [veraId]);
    await db.run("INSERT INTO user_gallery_favorites (user_id, game_id, file, at) VALUES (?, ?, 'img/a.png', 1)", [borisId, SAVE_GAME]);
    const users = await db.all('SELECT id, name, pass_hash FROM users ORDER BY id');
    assert.ok(users.length === 2 && users.every((u) => u.pass_hash.startsWith('$2')));
    assert.ok((await db.get('SELECT COUNT(*) AS n FROM sessions')).n >= 3, 'входы есть');

    const made = fs.mkdtempSync(path.join(root, '_tmp_bk_made'));
    const opened = fs.mkdtempSync(path.join(root, '_tmp_bk_open'));
    t.after(() => { fs.rmSync(made, { recursive: true, force: true }); fs.rmSync(opened, { recursive: true, force: true }); });
    const { file: archive } = await buildBackup(made);
    const unpacked = await unpackBackup(archive, opened);

    // Что в архиве: ни хэшей, ни входов; сейвы людей на месте, история — нет
    const bytes = fs.readFileSync(path.join(unpacked, 'library.db'));
    for (const u of users) assert.strictEqual(bytes.includes(u.pass_hash), false, `хэш ${u.name} в копии`);
    const inside = await openDb(path.join(unpacked, 'library.db'), require('sqlite3').OPEN_READONLY);
    try {
        assert.strictEqual((await inside.get('SELECT COUNT(*) AS n FROM sessions')).n, 0);
        assert.deepStrictEqual(await inside.all("SELECT id, pass_hash FROM users WHERE pass_hash != ''"), []);
        assert.strictEqual((await inside.get('SELECT COUNT(*) AS n FROM users')).n, 2);
        assert.strictEqual((await inside.get('SELECT COUNT(*) AS n FROM user_games')).n, 2);
    } finally { await inside.close(); }
    assert.ok(fs.existsSync(path.join(unpacked, '_saves', '.people', veraId, SAVE_GAME, 'RPG%20File1.json')));
    assert.strictEqual(fs.existsSync(path.join(unpacked, '_saves', '.people', veraId, '.history')), false, 'история сейвов человека в копию не идёт');

    // Людей и их данных больше нет — как на новой установке
    await db.run('DELETE FROM sessions WHERE user_id != ?', ['owner']);
    await db.run('DELETE FROM users');
    for (const table of ['user_games', 'user_wishlist', 'user_gallery_favorites']) await db.run(`DELETE FROM ${table}`);
    fs.rmSync(path.join(savesRoot, '.people'), { recursive: true, force: true });

    const res = await restoreBackup(unpacked, { trash, store: personStores.owner.saves, onSave: async () => {} });
    assert.strictEqual(res.peopleSaves, 2);
    assert.deepStrictEqual(await db.all('SELECT id, name, pass_hash FROM users ORDER BY id'), users.map((u) => ({ ...u, pass_hash: '' })), 'те же id и имена, пароля нет');
    assert.deepStrictEqual(await db.all('SELECT user_id, rating, notes FROM user_games ORDER BY user_id, game_id'),
        [{ user_id: veraId, rating: 5, notes: 'vera note' }, { user_id: borisId, rating: 2, notes: 'boris note' }].sort((a, b) => a.user_id.localeCompare(b.user_id)));
    assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM user_wishlist WHERE user_id = ?', [veraId])).n, 1);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM user_gallery_favorites WHERE user_id = ?', [borisId])).n, 1);
    const gold = (id) => JSON.parse(fs.readFileSync(file(id), 'utf8')).party._gold;
    assert.deepStrictEqual([gold(veraId), gold(borisId)], [4, 3], 'у каждого свой сейв, у Веры — последний');
    assert.strictEqual(fs.readFileSync(path.join(savesRoot, '.people', veraId, '.marks', SAVE_GAME, 'spot.json'), 'utf8'), '{"by":"vera"}');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(savesRoot, SAVE_GAME, 'RPG%20File1.json'), 'utf8')).party._gold, 1, 'сейв владельца остался своим');
    // Войти без пароля нельзя
    assert.strictEqual((await loginAs('Vera', '')).status === 200, false);
});

test('копия и люди: имя занято — «Имя (2)»; свой человек с тем же id не меняется; чужие id и строки без человека не проходят', async (t) => {
    const { veraId, db } = await savesSetup(t);
    const { restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    const savesRoot = path.join(root, '_saves');
    const hash = (await db.get('SELECT pass_hash FROM users WHERE id = ?', [veraId])).pass_hash;
    const admin = (await db.get("SELECT value FROM settings WHERE key = 'admin_user'")).value;
    const [a, b, c, stranger, d, e] = ['a', 'b', 'c', '9', 'd', 'e'].map((ch) => `u${ch.repeat(16)}`);

    const dir = fs.mkdtempSync(path.join(root, '_tmp_clash'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bk = await openDb(path.join(dir, 'library.db'));
    await bk.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE wishlist (key TEXT PRIMARY KEY);
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE user_games (user_id TEXT NOT NULL, game_id TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, game_id))`);
    await bk.run('INSERT INTO users VALUES (?, ?, ?, 0, 5), (?, ?, ?, 0, 6), (?, ?, ?, 1, 7), (?, ?, ?, 0, 8), (?, ?, ?, 0, 9), (?, ?, ?, 0, 10), (?, ?, ?, 0, 11)',
        [a, 'vera', 'leaked-hash', b, 'VERA', '', c, admin.toUpperCase(), '', veraId, 'Renamed Vera', 'other-hash', '../evil', 'Bad', '', d, '  Anna ', '', e, 'Bad\u0001name', '']);
    await bk.run("INSERT INTO user_games VALUES (?, ?, 'a note', 1), (?, ?, 'ghost note', 1), (?, ?, 'veras copy', 1)", [a, SAVE_GAME, stranger, SAVE_GAME, veraId, SAVE_GAME]);
    await bk.close();
    for (const uid of [a, stranger]) {
        fs.mkdirSync(path.join(dir, '_saves', '.people', uid, SAVE_GAME), { recursive: true });
        fs.writeFileSync(path.join(dir, '_saves', '.people', uid, SAVE_GAME, 'RPG%20File1.json'), 'x');
    }
    const res = await restoreBackup(dir, { trash, store: {}, onSave: async () => {} });

    const rows = await db.all('SELECT id, name, pass_hash FROM users ORDER BY created_at, id');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepStrictEqual([byId[veraId].name, byId[veraId].pass_hash], ['Vera', hash], 'свой человек остался как был');
    assert.deepStrictEqual([byId[a].name, byId[b].name, byId[c].name], ['vera (2)', 'VERA (3)', `${admin.toUpperCase()} (2)`]);
    assert.ok([a, b, c].every((id) => byId[id].pass_hash === ''), 'пароль из копии не берётся, даже если он там был');
    assert.strictEqual(byId[d].name, 'Anna', 'пробелы по краям обрезаны: вход ищет имя обрезанным');
    assert.strictEqual(byId[e], undefined, 'имя с управляющим знаком не заводится');
    assert.strictEqual(rows.length, 6, 'Вера и Борис были, четверо пришли, id не по форме не заводится');
    assert.deepStrictEqual(await db.all('SELECT user_id, notes FROM user_games ORDER BY user_id'), [{ user_id: a, notes: 'a note' }, { user_id: veraId, notes: 'veras copy' }].sort((x, y) => x.user_id.localeCompare(y.user_id)));
    assert.strictEqual(res.peopleSaves, 1);
    assert.ok(fs.existsSync(path.join(savesRoot, '.people', a, SAVE_GAME, 'RPG%20File1.json')));
    assert.strictEqual(fs.existsSync(path.join(savesRoot, '.people', stranger)), false, 'папка человека, которого нет, не создаётся');
});

test('личные сейвы: сейвы друга не мешают вопросу «это игра с полки», а при согласии встают на её место вместе с его личным', async (t) => {
    const veraCookie = await personalSetup(t);
    const db = dbService.get();
    const veraId = (await db.get("SELECT id FROM users WHERE name = 'Vera'")).id;
    const [OLD, NEW] = ['Quill_Old_v1', 'Quill_Old_v2'];
    const make = (id) => { fs.mkdirSync(path.join(root, id, 'www'), { recursive: true }); fs.writeFileSync(path.join(root, id, 'www', 'index.html'), id); };
    const people = path.join(root, '_saves', '.people');
    t.after(async () => {
        for (const id of [OLD, NEW]) {
            const del = await call('DELETE', `/api/games/${id}`);
            if (del.data?.trashKey) await call('DELETE', `/api/games/trash/${del.data.trashKey}`);
        }
        fs.rmSync(path.join(root, '_old', OLD), { recursive: true, force: true });
        fs.rmSync(people, { recursive: true, force: true });
        await db.run('DELETE FROM games WHERE id IN (?, ?)', [OLD, NEW]);
    });
    make(OLD);
    await db.run("INSERT INTO games (id, title, playtime, addedAt, ready) VALUES (?, 'Quill Old', 7200, 1, 1)", [OLD]);
    assert.strictEqual((await call('POST', `/api/games/${OLD}/shelf`)).status, 200);
    make(NEW);
    await db.run("INSERT INTO games (id, title, addedAt, ready) VALUES (?, 'Quill Old v2', ?, 1)", [NEW, Date.now() + 1000]);

    // У Веры уже есть сейвы и момент новой игры и её личные записи; у владельца своих нет
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(people, veraId, rel)), { recursive: true }); fs.writeFileSync(path.join(people, veraId, rel), text); };
    put(`${NEW}/RPG%20File1.json`, 'vera save');
    put(`.marks/${NEW}/m.json`, 'vera mark');
    await db.run("INSERT INTO user_games (user_id, game_id, playtime, notes, progress, at) VALUES (?, ?, 300, 'vera note', '{\"gold\":5}', 1)", [veraId, NEW]);
    await redisClient.del('api:games:list');
    const seen = (await call('GET', '/api/games')).data.find((g) => g.id === NEW);
    assert.strictEqual(seen.shelfMatch?.id, OLD, 'сейвы друга вопрос не прячут');
    assert.strictEqual((await call('GET', '/api/games', withCookie(veraCookie))).data.find((g) => g.id === NEW).shelfMatch, null, 'а человеку вопрос о библиотеке владельца не задаётся');

    const yes = await call('POST', `/api/games/${NEW}/shelf-match`, { json: { into: OLD, accept: true } });
    assert.deepStrictEqual([yes.status, yes.data.id], [200, OLD]);
    assert.strictEqual(fs.readFileSync(path.join(people, veraId, OLD, 'RPG%20File1.json'), 'utf8'), 'vera save');
    assert.strictEqual(fs.readFileSync(path.join(people, veraId, '.marks', OLD, 'm.json'), 'utf8'), 'vera mark');
    assert.ok(!fs.existsSync(path.join(people, veraId, NEW)) && !fs.existsSync(path.join(people, veraId, '.marks', NEW)));
    const rows = (await db.all('SELECT game_id, playtime, notes, progress FROM user_games WHERE user_id = ? ORDER BY game_id', [veraId])).map((r) => ({ ...r }));
    assert.deepStrictEqual(rows, [
        { game_id: OLD, playtime: 300, notes: 'vera note', progress: '{"gold":5}' },
        { game_id: NEW, playtime: 0, notes: 'vera note', progress: '{"gold":5}' },
    ], 'время ушло к игре с полки, у прежней строки оно обнулено — вернут игру из корзины, счёт не удвоится');
});

test('импорт сейвов: архив больше 50 МБ отклоняется, не доходя до диска', async () => {
    const big = Buffer.alloc(51 * 1024 * 1024, 1);
    const boundary = '----saves51';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="saves"; filename="big.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const res = await call('POST', '/api/saves/import/Some_Game', { raw: Buffer.concat([head, big, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.reason, 'saves-too-big');
});

test('вход не принимается, пока идёт восстановление копии', async () => {
    dbService.restoring = true;
    try {
        const res = await login();
        assert.strictEqual(res.status, 503);
    } finally { dbService.restoring = false; }
});

// ---------------------------------------------------------------------------------------------------------------------
// Учётные записи, часть вторая: имя = логин, картинки, закрыть вход / убрать (users.state)
// ---------------------------------------------------------------------------------------------------------------------

// JPEG-заголовок нужного размера: сервер смотрит только на сигнатуру и размер кадра (utils/jpegSize.js), пикселей не читает.
// pad — сколько нулей добавить внутрь, чтобы набрать вес
const jpegOf = (w, h, pad = 0) => Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]),
    Buffer.alloc(pad), Buffer.from([0xff, 0xd9]),
]);

const SAVES = path.join(root, '_saves');

const avatarFile = (id) => (id === 'owner' ? path.join(SAVES, '.avatar.jpg') : path.join(SAVES, '.people', id, '.avatar.jpg'));

const wipeAvatars = () => {
    fs.rmSync(path.join(SAVES, '.avatar.jpg'), { force: true });
    fs.rmSync(path.join(SAVES, '.people'), { recursive: true, force: true });
};

const nameOfOwner = async () => (await dbService.get().get("SELECT value FROM settings WHERE key = 'admin_user'")).value;

// Вернуть логин владельца прямо в базе: тесты ниже его переименовывают, а остальным нужен прежний
const restoreOwnerName = () => dbService.get().run("UPDATE settings SET value = ? WHERE key = 'admin_user'", [USER]);

const asPerson = async (name, password) => cookieFrom(await loginAs(name, password)).value;

test('имена: «Анна» и «анна» — одно имя (кириллица), невидимые знаки не проходят, NFC; у кого уже два — каждый входит под своим', async (t) => {
    t.after(dropUsers);
    const make = (name, extra = {}) => call('POST', '/api/users', { json: { name, password: 'temp-pass', ...extra } });
    assert.strictEqual((await make('Анна')).status, 200);
    for (const clash of ['анна', 'АННА', ' анна ']) {
        const res = await make(clash);
        assert.deepStrictEqual([res.status, res.data.reason], [409, 'name-taken'], clash);
    }
    // Вход — в любом регистре, если подходит один человек
    await call('POST', `/api/users/${(await dbService.get().get("SELECT id FROM users WHERE name = 'Анна'")).id}/password`, { json: { password: 'anna-pass-1' } });
    assert.strictEqual((await loginAs('аННА', 'anna-pass-1')).status, 200);

    // Невидимые знаки: нулевой ширины, смена направления, мягкий перенос; обычные управляющие
    for (const bad of ['Ан\u200bна', '\u202eBoris', 'Bo\u00adris', 'Bo\u0007ris', 'x'.repeat(41)]) {
        const res = await make(bad);
        assert.deepStrictEqual([res.status, res.data.reason], [400, 'name-bad'], JSON.stringify(bad));
    }
    // «Й» одним знаком и «И» с бревом — одно имя, хранится в NFC; войти можно любым написанием
    const decomposed = 'И\u0306ван';
    const made = await make(decomposed);
    assert.strictEqual(made.data.name, 'Йван'.normalize('NFC'), 'хранится в NFC');
    assert.strictEqual((await make('Й'.normalize('NFC') + 'ван')).status, 409, 'то же имя другим написанием');
    await call('POST', `/api/users/${made.data.id}/password`, { json: { password: 'ivan-pass-1' } });
    assert.strictEqual((await loginAs(decomposed, 'ivan-pass-1')).status, 200);
    assert.strictEqual((await loginAs(made.data.name, 'ivan-pass-1')).status, 200);

    // Уже есть двое с разным регистром (база SQLite для кириллицы их не различает): входят оба, неоднозначное имя — нет
    await dbService.get().run('DELETE FROM users');
    await addUser('Олег', 'oleg-upper-1');
    await addUser('олег', 'oleg-lower-1');
    assert.strictEqual((await loginAs('Олег', 'oleg-upper-1')).status, 200, 'точное имя главнее');
    assert.strictEqual((await loginAs('олег', 'oleg-lower-1')).status, 200);
    const cookieUpper = await asPerson('Олег', 'oleg-upper-1');
    const cookieLower = await asPerson('олег', 'oleg-lower-1');
    assert.strictEqual((await call('GET', '/api/me', withCookie(cookieUpper))).data.name, 'Олег');
    assert.strictEqual((await call('GET', '/api/me', withCookie(cookieLower))).data.name, 'олег');
    assert.strictEqual((await loginAs('ОЛЕГ', 'oleg-upper-1')).status, 401, 'не выбрать из двоих — отказ, а не чужой вход');
    assert.strictEqual((await loginAs('Олег', 'oleg-lower-1')).status, 401, 'пароль соседа не подходит');
});

test('имена: логин владельца сверяется тем же правилом, что у людей — в обе стороны, и вход владельца без учёта регистра', async (t) => {
    t.after(async () => { await dropUsers(); await restoreOwnerName(); });
    const renameSelf = (name) => call('POST', '/api/account/name', { json: { password: PASS, name } });
    assert.strictEqual((await renameSelf('Хозяин')).status, 200);
    assert.strictEqual((await nameOfOwner()), 'Хозяин');
    // Человек с этим именем в другом регистре — нельзя (кириллица: SQLite сама не заметила бы)
    for (const clash of ['хозяин', 'ХОЗЯИН']) assert.strictEqual((await call('POST', '/api/users', { json: { name: clash, password: 'temp-pass' } })).status, 409, clash);
    // И наоборот: владелец не может взять имя человека в другом регистре
    await addUser('Мария', 'maria-pass-1');
    const taken = await renameSelf('мария');
    assert.deepStrictEqual([taken.status, taken.data.reason], [409, 'name-taken']);
    assert.strictEqual((await renameSelf('Хозяин')).status, 200, 'своё же имя — не «занято»');
    assert.strictEqual((await renameSelf('ХОЗЯИН')).status, 200, 'только регистр — можно');
    assert.strictEqual((await loginAs('хозяин', PASS)).status, 200, 'владелец входит и в другом регистре');
    assert.strictEqual((await loginAs('Мария', PASS)).status, 401);
});

test('имя: свою меняют по паролю, входы живут, старое имя не входит, новое входит; чужое, занятое и невидимое — отказ', async (t) => {
    t.after(dropUsers);
    const id = await addUser('Борис', 'boris-pass-1');
    await addUser('Вера', 'vera-pass-1');
    const device1 = await asPerson('Борис', 'boris-pass-1');
    const device2 = await asPerson('Борис', 'boris-pass-1');
    const rename = (json, cookieValue = device1) => call('POST', '/api/account/name', { ...withCookie(cookieValue), json });

    assert.strictEqual((await rename({ name: 'Боря' })).data.reason, 'password-empty');
    const wrong = await rename({ name: 'Боря', password: 'nope' });
    assert.deepStrictEqual([wrong.status, wrong.data.reason], [401, 'wrong-password']);
    assert.strictEqual((await call('GET', '/api/me', withCookie(device1))).data.name, 'Борис', 'с неверным паролем имя не изменилось');
    for (const [name, status, reason] of [['вера', 409, 'name-taken'], ['ВЕРА', 409, 'name-taken'], [USER, 409, 'name-taken'], ['Бо\u200bря', 400, 'name-bad'], ['', 400, 'name-bad']]) {
        const res = await rename({ name, password: 'boris-pass-1' });
        assert.deepStrictEqual([res.status, res.data.reason], [status, reason], JSON.stringify(name));
    }

    const done = await rename({ name: '  Боря ', password: 'boris-pass-1' });
    assert.deepStrictEqual([done.status, done.data], [200, { success: true, name: 'Боря' }]);
    const me = await call('GET', '/api/me', withCookie(device2));
    assert.deepStrictEqual([me.status, me.data.id, me.data.name], [200, id, 'Боря'], 'второе устройство осталось во входе, id тот же');
    assert.strictEqual((await call('GET', '/api/games', withCookie(device1))).status, 200);
    assert.strictEqual((await loginAs('Борис', 'boris-pass-1')).status, 401, 'старое имя не входит');
    assert.strictEqual((await loginAs('боря', 'boris-pass-1')).status, 200);

    // Выбравший пароль только что: имя меняется после первого пароля
    await addUser('Новичок', 'temp-pass', { mustChange: 1 });
    const fresh = await asPerson('Новичок', 'temp-pass');
    const blocked = await rename({ name: 'Другой', password: 'temp-pass' }, fresh);
    assert.deepStrictEqual([blocked.status, blocked.data.reason], [403, 'must-change']);
    // Без входа
    assert.strictEqual((await call('POST', '/api/account/name', { json: { name: 'x', password: 'y' }, auth: false })).status, 401);
});

test('имя: смена идёт через тот же лимит попыток, что и вход — перебор пароля через неё не обходит защиту', async (t) => {
    t.after(dropUsers);
    await addUser('Лев', 'lev-pass-1');
    const lev = await asPerson('Лев', 'lev-pass-1');
    let last;
    for (let i = 0; i < 11; i++) last = await call('POST', '/api/account/name', { ...withCookie(lev), json: { name: 'Лёва', password: `wrong-${i}` } });
    assert.strictEqual(last.status, 429);
    forgetLoginAttempts();
    assert.strictEqual((await call('POST', '/api/account/name', { ...withCookie(lev), json: { name: 'Лёва', password: 'lev-pass-1' } })).status, 200);
});

test('имя: главный администратор переименовывает себя — login в settings, входы живут; других — без пароля, с тем же правилом', async (t) => {
    t.after(async () => { await dropUsers(); await restoreOwnerName(); });
    const id = await addUser('Дмитрий', 'dima-pass-1');
    const dima = await asPerson('Дмитрий', 'dima-pass-1');

    const me = await call('POST', '/api/account/name', { json: { password: PASS, name: 'Админ' } });
    assert.deepStrictEqual([me.status, me.data.name], [200, 'Админ']);
    assert.strictEqual(await nameOfOwner(), 'Админ');
    assert.strictEqual((await call('GET', '/api/me')).data.name, 'Админ', 'сессия владельца осталась');
    assert.strictEqual((await loginAs(USER, PASS)).status, 401);
    assert.strictEqual((await loginAs('Админ', PASS)).status, 200);
    assert.strictEqual((await call('GET', '/api/users')).data[0].name, 'Админ');
    await restoreOwnerName();

    // Чужое имя: пароль не нужен, но права нужны
    const patch = (who, json, extra = {}) => call('PATCH', `/api/users/${who}`, { json, ...extra });
    assert.deepStrictEqual((await patch(id, { name: 'Дима' })).data, { success: true, name: 'Дима' });
    assert.strictEqual((await call('GET', '/api/me', withCookie(dima))).data.name, 'Дима', 'вход человека живёт');
    assert.strictEqual((await loginAs('Дмитрий', 'dima-pass-1')).status, 401);
    assert.strictEqual((await loginAs('дима', 'dima-pass-1')).status, 200);
    assert.strictEqual((await patch(id, { name: USER.toUpperCase() })).data.reason, 'name-taken');
    assert.strictEqual((await patch(id, { name: 'Ди\u200bма' })).data.reason, 'name-bad');
    assert.strictEqual((await patch('owner', { name: 'Кто-то' })).status, 404, 'владельца здесь нет — он меняет себя сам');
    assert.strictEqual((await patch('unope', { name: 'Кто-то' })).status, 404);
    assert.strictEqual((await patch(id, { name: 'Взлом' }, withCookie(dima))).data.reason, 'owner-only');
});

test('картинка: проверки (не JPEG, огромный кадр, больше 256 КБ), заголовки, хозяин и главный администратор; файл лежит под _saves', async (t) => {
    t.after(async () => { await dropUsers(); wipeAvatars(); });
    const veraId = await addUser('Вера', 'vera-pass-1');
    const borisId = await addUser('Борис', 'boris-pass-1');
    const vera = await asPerson('Вера', 'vera-pass-1');
    const boris = await asPerson('Борис', 'boris-pass-1');
    const put = (raw, cookieValue = vera, url = '/api/account/avatar') => call('PUT', url, { ...(cookieValue === null ? { auth: false } : withCookie(cookieValue)), raw });

    for (const [what, raw] of [['PNG', PNG], ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')], ['пусто', Buffer.alloc(0)], ['кадр 5000×5000', jpegOf(5000, 5000)], ['кадр 513', jpegOf(513, 256)], ['без размера', Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0])]]) {
        const res = await put(raw);
        assert.deepStrictEqual([res.status, res.data?.reason], [400, 'avatar-bad'], what);
    }
    assert.strictEqual((await put(jpegOf(256, 256, 300 * 1024))).status, 413, 'больше 256 КБ');
    assert.strictEqual(fs.existsSync(avatarFile(veraId)), false, 'ничего не записано');
    assert.strictEqual((await put(jpegOf(256, 256), null)).status, 401);

    const good = jpegOf(256, 256, 1000);
    const done = await put(good);
    assert.strictEqual(done.status, 200);
    assert.ok(Number.isInteger(done.data.avatar) && done.data.avatar > 0);
    assert.ok(fs.existsSync(avatarFile(veraId)), 'в _saves/.people/<id>/.avatar.jpg');
    assert.strictEqual((await call('GET', '/api/me', withCookie(vera))).data.avatar, done.data.avatar, '/me несёт версию');

    const got = await call('GET', `/api/avatars/${veraId}?v=${done.data.avatar}`, withCookie(vera));
    assert.deepStrictEqual([got.status, got.headers['content-type'], got.headers['x-content-type-options']], [200, 'image/jpeg', 'nosniff']);
    assert.strictEqual(got.headers['cache-control'], 'private, max-age=604800');
    assert.ok(got.raw.equals(good), 'тот же файл, что прислали');
    // Главный администратор видит; другой человек и вошедший без входа — нет
    assert.strictEqual((await call('GET', `/api/avatars/${veraId}`)).status, 200);
    const other = await call('GET', `/api/avatars/${veraId}`, withCookie(boris));
    assert.deepStrictEqual([other.status, other.data.reason], [403, 'not-yours']);
    assert.strictEqual((await call('GET', `/api/avatars/${veraId}`, { auth: false })).status, 401);
    // Не картинка Бориса — у него её нет
    assert.strictEqual((await call('GET', `/api/avatars/${borisId}`, withCookie(boris))).status, 404);
    // Плохие id не доходят до диска
    for (const id of ['..%2F..%2Fetc', 'u123', 'owner%00', `${veraId}x`, 'U0000000000000000', '.']) {
        const res = await call('GET', `/api/avatars/${id}`);
        assert.ok([400, 404].includes(res.status), `${id}: ${res.status}`);
    }
    // Тот же файл общий адрес библиотеки не отдаёт: _saves закрыт
    assert.strictEqual((await call('GET', `/_saves/.people/${veraId}/.avatar.jpg`)).status === 200, false);

    // Своя картинка владельца — в корне _saves
    assert.strictEqual((await put(jpegOf(256, 256), cookie)).status, 200);
    assert.ok(fs.existsSync(avatarFile('owner')));
    assert.strictEqual((await call('GET', '/api/avatars/owner')).status, 200);
    assert.strictEqual((await call('GET', '/api/avatars/owner', withCookie(vera))).data.reason, 'not-yours');
    assert.strictEqual((await call('GET', '/api/users')).data[0].avatar > 0, true, 'в списке людей — версия');

    // Убрать: файл стёрт, версия пустая, адрес отвечает 404
    assert.strictEqual((await call('DELETE', '/api/account/avatar', withCookie(vera))).status, 200);
    assert.strictEqual(fs.existsSync(avatarFile(veraId)), false);
    assert.strictEqual((await call('GET', '/api/me', withCookie(vera))).data.avatar, null);
    assert.strictEqual((await call('GET', `/api/avatars/${veraId}`)).status, 404);
    assert.strictEqual((await call('DELETE', '/api/account/avatar', withCookie(vera))).status, 200, 'повторно — не ошибка');

    // Главный администратор ставит и убирает чужую
    assert.strictEqual((await put(good, cookie, `/api/users/${borisId}/avatar`)).status, 200);
    assert.ok(fs.existsSync(avatarFile(borisId)));
    assert.strictEqual((await put(good, vera, `/api/users/${borisId}/avatar`)).data.reason, 'owner-only');
    assert.strictEqual((await put(good, cookie, '/api/users/unope/avatar')).status, 404);
    assert.strictEqual((await put(PNG, cookie, `/api/users/${borisId}/avatar`)).status, 400);
    assert.strictEqual((await call('DELETE', `/api/users/${borisId}/avatar`)).status, 200);
    assert.strictEqual(fs.existsSync(avatarFile(borisId)), false);
});

test('картинка: ссылка вместо файла не отдаётся и в версию не попадает', async (t) => {
    t.after(async () => { await dropUsers(); wipeAvatars(); });
    const id = await addUser('Нина', 'nina-pass-1');
    const nina = await asPerson('Нина', 'nina-pass-1');
    const secret = path.join(root, 'secret-target.jpg');
    fs.writeFileSync(secret, jpegOf(256, 256));
    t.after(() => fs.rmSync(secret, { force: true }));
    fs.mkdirSync(path.dirname(avatarFile(id)), { recursive: true });
    fs.symlinkSync(secret, avatarFile(id));
    assert.strictEqual((await call('GET', `/api/avatars/${id}`, withCookie(nina))).status, 404);
    assert.strictEqual((await call('GET', '/api/me', withCookie(nina))).data.avatar, null);
});

test('картинка и копия: аватар возвращается, свой не затирается; не JPEG и ссылка из архива игнорируются; старая копия без state и без людей — без ошибки', async (t) => {
    t.after(async () => { await dropUsers(); wipeAvatars(); });
    const { restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    const db = dbService.get();
    const veraId = await addUser('Вера', 'vera-pass-1');
    const borisId = await addUser('Борис', 'boris-pass-1');
    const [a, b] = ['a', 'b'].map((ch) => `u${ch.repeat(16)}`);
    const mine = jpegOf(256, 256, 11);
    fs.mkdirSync(path.dirname(avatarFile(veraId)), { recursive: true });
    fs.writeFileSync(avatarFile(veraId), mine);
    fs.writeFileSync(path.join(SAVES, '.avatar.jpg'), mine);

    // Копия прежней версии: users без state, без must_change и без created_at — только id и name
    const dir = fs.mkdtempSync(path.join(root, '_tmp_avbk'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bk = await openDb(path.join(dir, 'library.db'));
    await bk.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE wishlist (key TEXT PRIMARY KEY);
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL)`);
    await bk.run('INSERT INTO users VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)', [veraId, 'Вера', '', borisId, 'Борис', '', a, 'Анна', '', b, 'Богдан', '']);
    await bk.close();
    const fromSaves = path.join(dir, '_saves');
    const theirs = jpegOf(200, 200, 33);
    fs.mkdirSync(path.join(fromSaves, '.people', veraId), { recursive: true });
    fs.mkdirSync(path.join(fromSaves, '.people', borisId), { recursive: true });
    fs.mkdirSync(path.join(fromSaves, '.people', a), { recursive: true });
    fs.mkdirSync(path.join(fromSaves, '.people', b), { recursive: true });
    fs.writeFileSync(path.join(fromSaves, '.avatar.jpg'), theirs);
    fs.writeFileSync(path.join(fromSaves, '.people', veraId, '.avatar.jpg'), theirs);
    fs.writeFileSync(path.join(fromSaves, '.people', borisId, '.avatar.jpg'), theirs);
    fs.writeFileSync(path.join(fromSaves, '.people', a, '.avatar.jpg'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    fs.symlinkSync(path.join(root, 'secret-target.jpg'), path.join(fromSaves, '.people', b, '.avatar.jpg'));
    fs.writeFileSync(path.join(root, 'secret-target.jpg'), jpegOf(100, 100));
    t.after(() => fs.rmSync(path.join(root, 'secret-target.jpg'), { force: true }));

    const res = await restoreBackup(dir, { trash, store: { importSaves: async () => {} }, onSave: async () => {} });
    assert.strictEqual(res.peopleSaves, 0);
    assert.ok(fs.readFileSync(path.join(SAVES, '.avatar.jpg')).equals(mine), 'своя картинка владельца не затёрта');
    assert.ok(fs.readFileSync(avatarFile(veraId)).equals(mine), 'и человека тоже');
    assert.ok(fs.readFileSync(avatarFile(borisId)).equals(theirs), 'у Бориса своей не было — вернулась из копии');
    assert.strictEqual(fs.existsSync(avatarFile(a)), false, 'не JPEG из архива проигнорирован');
    assert.strictEqual(fs.existsSync(avatarFile(b)), false, 'ссылка из архива проигнорирована');
    // Люди из копии без столбцов state и must_change заведены без ошибки
    const rows = await db.all('SELECT id, name, state, must_change FROM users WHERE id IN (?, ?) ORDER BY id', [a, b]);
    assert.deepStrictEqual(rows.map((r) => ({ ...r })), [{ id: a, name: 'Анна', state: '', must_change: 0 }, { id: b, name: 'Богдан', state: '', must_change: 0 }]);
});

test('копия и люди: state возвращается у заведённых из копии; у своего человека остаётся свой', async (t) => {
    t.after(async () => { await dropUsers(); });
    const { restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    const db = dbService.get();
    const mineId = await addUser('Свой', 'own-pass-1');
    await db.run("UPDATE users SET state = 'locked' WHERE id = ?", [mineId]);
    const [a, b, c] = ['a', 'b', 'c'].map((ch) => `u${ch.repeat(16)}`);
    const dir = fs.mkdtempSync(path.join(root, '_tmp_statebk'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bk = await openDb(path.join(dir, 'library.db'));
    await bk.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE wishlist (key TEXT PRIMARY KEY);
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '')`);
    await bk.run("INSERT INTO users VALUES (?, 'Свой', 'h', 0, 1, ''), (?, 'Закрытая', 'h', 0, 2, 'locked'), (?, 'Удалённый', 'h', 0, 3, 'removed'), (?, 'Странный', 'h', 0, 4, 'admin')", [mineId, a, b, c]);
    await bk.close();
    await restoreBackup(dir, { trash, store: {}, onSave: async () => {} });
    const states = Object.fromEntries((await db.all('SELECT id, state FROM users')).map((r) => [r.id, r.state]));
    assert.deepStrictEqual(states, { [mineId]: 'locked', [a]: 'locked', [b]: 'removed', [c]: '' }, 'свой — как есть; чужие — из копии; незнакомое значение — обычный');
    // Имя удалённого занято и после восстановления
    assert.strictEqual((await call('POST', '/api/users', { json: { name: 'удалённый', password: 'temp-pass' } })).data.reason, 'name-removed');
});

test('закрыть вход: входы и сокеты рвутся, пароль нужен для ответа «закрыт», открыть — тот же пароль; сброс пароля не открывает', async (t) => {
    t.after(dropUsers);
    const id = await addUser('Тимур', 'timur-pass-1');
    const phone = await asPerson('Тимур', 'timur-pass-1');
    const laptop = await asPerson('Тимур', 'timur-pass-1');
    const lock = (state, extra = {}) => call('POST', `/api/users/${id}/state`, { json: { state }, ...extra });
    const hash = () => dbService.get().get('SELECT pass_hash FROM users WHERE id = ?', [id]).then((r) => r.pass_hash);
    const before = await hash();

    assert.strictEqual((await lock('closed')).status, 400);
    assert.strictEqual((await call('POST', '/api/users/unope/state', { json: { state: 'locked' } })).status, 404);
    assert.strictEqual((await call('POST', '/api/users/owner/state', { json: { state: 'locked' } })).status, 404, 'главного администратора закрыть нельзя');
    assert.strictEqual((await lock('locked', withCookie(phone))).data.reason, 'owner-only');

    assert.deepStrictEqual((await lock('locked')).data, { success: true, state: 'locked' });
    for (const device of [phone, laptop]) assert.strictEqual((await call('GET', '/api/games', withCookie(device))).status, 401, 'вход стёрт');
    assert.strictEqual((await dbService.get().get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [id])).n, 0);
    const right = await loginAs('Тимур', 'timur-pass-1');
    assert.deepStrictEqual([right.status, right.data.reason, right.headers['set-cookie']], [403, 'account-locked', undefined]);
    const wrong = await loginAs('Тимур', 'wrong');
    const nobody = await loginAs('Никто', 'timur-pass-1');
    assert.deepStrictEqual([wrong.status, nobody.status], [401, 401], 'без верного пароля «закрыт» не говорят');
    assert.deepStrictEqual(wrong.data, nobody.data);
    assert.strictEqual(await hash(), before, 'пароль на месте');

    // Список: закрытый виден с state, /me владельца считает его человеком
    const listed = (await call('GET', '/api/users')).data.find((u) => u.id === id);
    assert.deepStrictEqual([listed.state, listed.role, listed.isOwner], ['locked', 'user', false]);
    assert.strictEqual((await call('GET', '/api/me')).data.shared, true);

    // Сброс пароля не открывает вход
    assert.strictEqual((await call('POST', `/api/users/${id}/password`, { json: { password: 'again-pass' } })).status, 200);
    assert.strictEqual((await dbService.get().get('SELECT state FROM users WHERE id = ?', [id])).state, 'locked');
    assert.strictEqual((await loginAs('Тимур', 'again-pass')).data.reason, 'account-locked');

    // Открыть: пароль — тот, что был
    assert.strictEqual((await lock('')).status, 200);
    assert.strictEqual((await loginAs('Тимур', 'again-pass')).status, 200);
    assert.strictEqual((await loginAs('Тимур', 'timur-pass-1')).status, 401);
});

test('закрыть вход: вкладка закрытого человека отключается, а владелец узнаёт об изменениях событием people-changed', async (t) => {
    t.after(dropUsers);
    const WebSocket = require('ws');
    const sockets = ioServer.listen(0, '127.0.0.1');
    await new Promise((r) => sockets.once('listening', r));
    t.after(() => { for (const s of io.sockets.sockets.values()) s.disconnect(true); sockets.close(); });
    const connect = async (token) => {
        const ws = new WebSocket(`ws://127.0.0.1:${sockets.address().port}/socket.io/?EIO=4&transport=websocket`, { headers: { cookie: `${COOKIE}=${token}` } });
        const events = [];
        ws.events = events;
        ws.closed = new Promise((r) => ws.on('close', r));
        await new Promise((resolve, reject) => {
            ws.on('error', reject);
            ws.on('message', (d) => {
                const text = d.toString();
                if (text.startsWith('0{')) ws.send('40');
                else if (text.startsWith('40')) resolve();
                else if (text === '2') ws.send('3');
                else if (text.startsWith('42')) events.push(JSON.parse(text.slice(2))[0]);
            });
        });
        return ws;
    };
    const id = await addUser('Ульяна', 'ulia-pass-1');
    const mine = await connect(cookie);
    const hers = await connect(await asPerson('Ульяна', 'ulia-pass-1'));
    const settle = () => new Promise((r) => setTimeout(r, 300));
    const heard = (ws) => ws.events.filter((e) => e === 'account-changed' || e === 'people-changed');
    await settle();
    mine.events.length = 0; hers.events.length = 0;

    // Она сама меняет имя: ей — account-changed, владельцу — people-changed
    const herCookie = await asPerson('Ульяна', 'ulia-pass-1');
    assert.strictEqual((await call('POST', '/api/account/name', { ...withCookie(herCookie), json: { password: 'ulia-pass-1', name: 'Юля' } })).status, 200);
    await settle();
    assert.deepStrictEqual([heard(hers), heard(mine)], [['account-changed'], ['people-changed']]);

    // Администратор переименовывает: тем же образом
    mine.events.length = 0; hers.events.length = 0;
    await call('PATCH', `/api/users/${id}`, { json: { name: 'Ульяна' } });
    await settle();
    assert.deepStrictEqual([heard(hers), heard(mine)], [['account-changed'], ['people-changed']]);

    // Закрытие: её вкладка отключается, других людей это не касается, владельцу — people-changed
    mine.events.length = 0;
    await call('POST', `/api/users/${id}/state`, { json: { state: 'locked' } });
    await hers.closed;
    assert.deepStrictEqual(heard(mine), ['people-changed']);
    assert.strictEqual(mine.readyState, WebSocket.OPEN);
});

test('убрать: человек уходит из /me.shared, имя за ним занято, данные на месте, вернуть — тот же пароль и сейвы', async (t) => {
    t.after(dropUsers);
    const id = await addUser('Эльвира', 'elvira-pass-1');
    const db = dbService.get();
    await db.run("INSERT INTO user_games (user_id, game_id, rating, notes, at) VALUES (?, ?, 4, 'моя заметка', 1)", [id, GAME]);
    const folder = path.join(SAVES, '.people', id, GAME);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'RPG%20File1.json'), 'сейв');
    t.after(() => fs.rmSync(path.join(SAVES, '.people'), { recursive: true, force: true }));
    const remove = (state) => call('POST', `/api/users/${id}/state`, { json: { state } });

    assert.strictEqual((await call('GET', '/api/me')).data.shared, true);
    assert.strictEqual((await remove('removed')).status, 200);
    assert.strictEqual((await call('GET', '/api/me')).data.shared, false, 'убранный в счёт не идёт: экран снова как у одного');
    assert.strictEqual((await loginAs('Эльвира', 'elvira-pass-1')).data.reason, 'account-locked');
    assert.strictEqual((await call('GET', '/api/users')).data.find((u) => u.id === id).state, 'removed');
    // Имя занято: создать и переименовать на него нельзя, сказано, что делать
    const again = await call('POST', '/api/users', { json: { name: 'эльвира', password: 'temp-pass' } });
    assert.deepStrictEqual([again.status, again.data.reason], [409, 'name-removed']);
    await addUser('Другая', 'other-pass-1');
    const otherId = (await db.get("SELECT id FROM users WHERE name = 'Другая'")).id;
    assert.strictEqual((await call('PATCH', `/api/users/${otherId}`, { json: { name: 'Эльвира' } })).data.reason, 'name-removed');
    // Данные целы, в копию они попадают (папка и строки не тронуты)
    assert.strictEqual(fs.readFileSync(path.join(folder, 'RPG%20File1.json'), 'utf8'), 'сейв');
    assert.deepStrictEqual((await db.all('SELECT rating, notes FROM user_games WHERE user_id = ?', [id])).map((r) => ({ ...r })), [{ rating: 4, notes: 'моя заметка' }]);
    // Слияние копий игр продолжает переносить его строки (movePeople ищет по папкам, а не по списку людей)
    const personal = require('./src/services/personal.js');
    await personal.carry(GAME, 'Merge_Target', { progress: new Set([id]), db });
    assert.strictEqual((await db.get('SELECT notes FROM user_games WHERE user_id = ? AND game_id = ?', [id, 'Merge_Target'])).notes, 'моя заметка');
    await db.run("DELETE FROM user_games WHERE game_id = 'Merge_Target'");

    // Вернуть
    assert.strictEqual((await remove('')).status, 200);
    assert.strictEqual((await call('GET', '/api/me')).data.shared, true);
    const back = await loginAs('Эльвира', 'elvira-pass-1');
    assert.strictEqual(back.status, 200);
    assert.strictEqual(fs.readFileSync(path.join(folder, 'RPG%20File1.json'), 'utf8'), 'сейв');
});

test('идёт восстановление копии: запись людей, имён и картинок отвечает 503, чтение работает', async (t) => {
    t.after(dropUsers);
    const id = await addUser('Рита', 'rita-pass-1');
    const rita = await asPerson('Рита', 'rita-pass-1');
    dbService.restoring = true;
    try {
        for (const [method, url, extra] of [
            ['POST', '/api/users', { json: { name: 'Новый', password: 'temp-pass' } }],
            ['PATCH', `/api/users/${id}`, { json: { name: 'Новая' } }],
            ['POST', `/api/users/${id}/state`, { json: { state: 'locked' } }],
            ['POST', `/api/users/${id}/password`, { json: { password: 'temp-pass' } }],
            ['PUT', `/api/users/${id}/avatar`, { raw: jpegOf(64, 64) }],
            ['POST', '/api/account/name', { ...withCookie(rita), json: { name: 'Новая', password: 'rita-pass-1' } }],
            ['PUT', '/api/account/avatar', { ...withCookie(rita), raw: jpegOf(64, 64) }],
            ['DELETE', '/api/account/avatar', withCookie(rita)],
        ]) {
            const res = await call(method, url, extra);
            assert.deepStrictEqual([res.status, res.data?.reason], [503, 'restoring'], `${method} ${url}`);
        }
        assert.strictEqual((await call('GET', '/api/users')).status, 200);
    } finally { dbService.restoring = false; }
    assert.strictEqual((await dbService.get().get('SELECT name, state FROM users WHERE id = ?', [id])).name, 'Рита');
});

test('адрес картинок библиотеки: не главному администратору закрыты _trash, _old, _inbox и _tmp_uploads, обложки (и обложка игры с полки) открыты', async (t) => {
    t.after(dropUsers);
    await addUser('Гость', 'guest-pass-1');
    const guest = await asPerson('Гость', 'guest-pass-1');
    const put = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), PNG); };
    const files = ['_trash/1-X/game/cover.png', '_old/X/2025/cover.png', '_inbox/_failed/cover.png', '_tmp_uploads/part/cover.png'];
    files.forEach(put);
    t.after(() => { for (const f of files) fs.rmSync(path.join(root, f.split('/')[0], f.split('/')[1]), { recursive: true, force: true }); });
    for (const rel of files) {
        assert.strictEqual((await call('GET', `/${rel}`)).status, 200, `главный администратор: ${rel}`);
        assert.strictEqual((await call('GET', `/${rel}`, withCookie(guest))).status, 403, `человек: ${rel}`);
        // Обход через соседнюю папку: после resolve это тот же путь
        assert.notStrictEqual((await call('GET', `/${GAME}/..${'/'}${rel}`, withCookie(guest))).status, 200, `обход: ${rel}`);
        assert.strictEqual((await call('GET', `/${rel}`, { auth: false })).status, 401);
    }
    // Обложка из _media человеку отдаётся, как раньше
    assert.strictEqual((await call('GET', `/_media/${GAME}/cover-0123456789.png`, withCookie(guest))).status, 200);
    assert.strictEqual((await call('GET', `/_media/${GAME}/cover-0123456789.png?w=360`, withCookie(guest))).status, 200);

    // Игра на полке: «На полку» копирует обложку в _media, и карточка у человека её показывает
    const ID = 'Shelf_Cover_Guest';
    fs.mkdirSync(path.join(root, ID, 'www'), { recursive: true });
    fs.writeFileSync(path.join(root, ID, 'www', 'index.html'), 'x');
    fs.writeFileSync(path.join(root, ID, 'cover.png'), PNG);
    await dbService.get().run("INSERT INTO games (id, title, cover, addedAt, ready) VALUES (?, 'Shelf Cover', ?, 1, 1)", [ID, `${ID}/cover.png`]);
    const shelved = await call('POST', `/api/games/${ID}/shelf`);
    t.after(async () => {
        await call('DELETE', `/api/games/${ID}`);
        if (shelved.data?.trashKey) await call('DELETE', `/api/games/trash/${shelved.data.trashKey}`);
        await dbService.get().run('DELETE FROM games WHERE id = ?', [ID]);
    });
    assert.strictEqual(shelved.status, 200);
    const card = (await call('GET', '/api/games', withCookie(guest))).data.find((g) => g.id === ID);
    assert.match(card.cover, /^_media\//, 'обложка полки — не из корзины');
    assert.strictEqual((await call('GET', `/${card.cover}`, withCookie(guest))).status, 200);
});

test('внешние каталоги: человеку не больше 20 запросов в минуту, владельцу без счёта', async (t) => {
    const vera = await personalSetup(t);
    let last;
    for (let i = 0; i < 21; i++) last = await call('GET', '/api/itch/game?url=https%3A%2F%2Fmoon-studio.itch.io%2Fx', withCookie(vera));
    assert.strictEqual(last.status, 429);
    assert.strictEqual(last.data.reason, 'catalog-busy');
    assert.notStrictEqual((await call('GET', '/api/itch/game?url=https%3A%2F%2Fmoon-studio.itch.io%2Fx')).status, 429);
});

test('вход: ведро попыток не зависит от пробелов по краям и регистра имени (кириллица тоже)', async (t) => {
    t.after(dropUsers);
    await addUser('Лев', 'lev-pass-1');
    const variants = ['Лев', 'лев', ' Лев', 'ЛЕВ ', 'лЕв', 'Лев  ', '  лев', 'ЛЕВ', 'лев ', ' ЛЕВ '];
    for (const v of variants) assert.strictEqual((await loginAs(v, 'wrong')).status, 401, v);
    const blocked = await loginAs('Лев ', 'lev-pass-1');
    assert.strictEqual(blocked.status, 429, 'одиннадцатая попытка под любым написанием — в том же ведре');
});

test('имена: два запроса разом на «Ирина» и «ирина» — проходит один (создание и переименование)', async (t) => {
    t.after(dropUsers);
    const make = (name) => call('POST', '/api/users', { json: { name, password: 'temp-pass' } });
    const made = await Promise.all([make('Ирина'), make('ирина')]);
    assert.deepStrictEqual(made.map((r) => r.status).sort(), [200, 409]);
    assert.strictEqual((await dbService.get().get("SELECT COUNT(*) AS n FROM users WHERE name IN ('Ирина', 'ирина')")).n, 1);

    const a = await addUser('Первый', 'first-pass-1');
    const b = await addUser('Второй', 'second-pass-1');
    const renamed = await Promise.all([a, b].map((id, i) => call('PATCH', `/api/users/${id}`, { json: { name: i ? 'зоя' : 'Зоя' } })));
    assert.deepStrictEqual(renamed.map((r) => r.status).sort(), [200, 409]);
    const names = (await dbService.get().all("SELECT name FROM users WHERE id IN (?, ?)", [a, b])).map((r) => r.name);
    assert.strictEqual(names.filter((n) => n.toLowerCase() === 'зоя').length, 1);
});

test('сессия закрытого или убранного человека не служит ключом игры (findById), даже если запись о входе уцелела', async (t) => {
    t.after(dropUsers);
    const sessions = require('./src/utils/sessions.js');
    const id = await addUser('Тоня', 'tonya-pass-1');
    const made = await sessions.create(id);
    assert.ok(await sessions.findById(made.id), 'открытый человек — ключ годится');
    for (const state of ['locked', 'removed']) {
        await dbService.get().run('UPDATE users SET state = ? WHERE id = ?', [state, id]);
        assert.strictEqual(await sessions.findById(made.id), null, state);
    }
    await dbService.get().run("UPDATE users SET state = '' WHERE id = ?", [id]);
    assert.ok(await sessions.findById(made.id));
    const mine = await sessions.create(sessions.OWNER);
    assert.ok(await sessions.findById(mine.id), 'у главного администратора строки в users нет — ключ годится');
});

test('человек с обязательной сменой пароля: имя, картинка и чтение картинки закрыты ответом must-change', async (t) => {
    t.after(dropUsers);
    await addUser('Новенький', 'temp-pass', { mustChange: 1 });
    const fresh = await asPerson('Новенький', 'temp-pass');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const calls = [
        call('POST', '/api/account/name', { ...withCookie(fresh), json: { name: 'Другой', password: 'temp-pass' } }),
        call('PUT', '/api/account/avatar', { ...withCookie(fresh), raw: jpeg }),
        call('GET', '/api/avatars/owner', withCookie(fresh)),
    ];
    for (const res of await Promise.all(calls)) assert.deepStrictEqual([res.status, res.data?.reason], [403, 'must-change']);
});

test('убрать: переименовать убранного человека может главный администратор; имя за ним остаётся занятым', async (t) => {
    t.after(dropUsers);
    const id = await addUser('Старое', 'old-pass-1');
    await call('POST', `/api/users/${id}/state`, { json: { state: 'removed' } });
    const done = await call('PATCH', `/api/users/${id}`, { json: { name: 'Новое' } });
    assert.deepStrictEqual([done.status, done.data.name], [200, 'Новое']);
    const clash = await call('POST', '/api/users', { json: { name: 'новое', password: 'temp-pass' } });
    assert.deepStrictEqual([clash.status, clash.data.reason], [409, 'name-removed']);
});

// ============================================================================
// Доступ к играм по людям: ограниченный человек видит только открытые ему игры, а закрытая закрыта по-настоящему —
// не только убрана из списка (services/gameAccess.js, utils/access.js)
// ============================================================================
const gameAccess = require('./src/services/gameAccess.js');

const OPEN = 'Open_Game';

const HID = 'Zqx_Hidden_Canary';

const NOPE = 'Nope_Game_Zz';

// Чего человек с ограниченным набором не должен увидеть ни в одном ответе: имя папки, название, автор, описание, имя файла картинки и
// слово из ссылки на страницу игры. Регистр разный нарочно: поле запроса, которое маршрут повторит в ответе, не должно выдать себя за утечку
const NEEDLES = [HID, 'Zqx Canary Title', 'Zqx Studio', 'ZqxDescr', 'zqxsecret', 'zqxthread'];

const QUERY = 'q=zqx+canary&name=ZQX+STUDIO&search=zqxsecret&id=9988776&source=itch&title=zqx+canary+title&f=x.png&ui=en&tag=zqxtag&key=x';

// Две игры на диске и в базе: открытая и «секретная» со всеми приметами. Люди — по именам; ничего другого тест не трогает
async function accessSetup(t, { people = true } = {}) {
    const db = dbService.get();
    access.flags.accountsOn = true;
    const dirs = (id) => ({ www: path.join(root, id, 'www'), media: path.join(root, '_media', id) });
    const cleanup = async () => {
        for (const id of [OPEN, HID, 'Zqx_New_Game']) {
            await gallery.forget(id).catch(() => {});
            await db.run('DELETE FROM games WHERE id = ?', [id]);
            fs.rmSync(path.join(root, id), { recursive: true, force: true });
            fs.rmSync(path.join(root, '_media', id), { recursive: true, force: true });
        }
        for (const dir of ['_old', '_trash']) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
        await db.run('DELETE FROM user_game_access');
        await db.run('DELETE FROM user_games');
        await db.run('DELETE FROM user_gallery_favorites');
        await db.run('DELETE FROM user_wishlist');
        fs.rmSync(path.join(root, '_saves', '.people'), { recursive: true, force: true });
        await redisClient.del('api:games:list');
        await dropUsers();
    };
    const gallery = require('./src/services/gallery.js');
    const make = async (id, fields) => {
        const { www, media } = dirs(id);
        fs.mkdirSync(path.join(www, 'img', 'pictures'), { recursive: true });
        fs.mkdirSync(path.join(www, 'data'), { recursive: true });
        fs.mkdirSync(media, { recursive: true });
        fs.writeFileSync(path.join(www, 'index.html'), '<html><body></body></html>');
        fs.writeFileSync(path.join(www, 'data', 'System.json'), '{}');
        fs.writeFileSync(path.join(www, 'img', 'pictures', fields.file), PNG);
        fs.writeFileSync(path.join(root, id, 'cover.jpg'), PNG);
        fs.writeFileSync(path.join(media, 'cover-0123456789.png'), PNG);
        await db.run(
            `INSERT OR REPLACE INTO games (id, title, cover, developer, tags, description, link, rating, lastPlayed, addedAt, scraped, ready, size, meta_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, 1, 1024, 'ok')`,
            [id, fields.title, `_media/${id}/cover-0123456789.png`, fields.developer, JSON.stringify(fields.tags), fields.descr || '', fields.link, fields.at]
        );
        await gallery.forget(id);
        await gallery.build(id).promise;
    };
    await cleanup();
    t.after(cleanup);
    await make(OPEN, { file: 'open.png', title: 'Open Title', developer: 'Open Dev', tags: ['OpenTag'], link: '', at: 2000 });
    await make(HID, {
        file: 'zqxsecret.png', title: 'Zqx Canary Title', developer: 'Zqx Studio', tags: ['ZqxTag'], descr: 'ZqxDescr text', at: 3000,
        link: 'https://zqxstudio.itch.io/zqxthread',
    });
    fs.writeFileSync(path.join(dirs(HID).www, 'data', 'MapInfos.json'), JSON.stringify([null, { id: 1, name: 'Zqx Map Needle' }]));
    await redisClient.del('api:games:list');

    // Человек: имя, ограниченный список (null — все игры), кука
    const made = [];
    const person = async (name, games = null) => {
        const id = await addUser(name, `${name}-pass-1`);
        if (games) await gameAccess.replace(id, { limited: true, games });
        const who = { id, name, cookie: cookieFrom(await loginAs(name, `${name}-pass-1`)).value };
        who.as = withCookie(who.cookie);
        made.push(who);
        return who;
    };
    return { db, dirs, person, make, cleanup, gallery };
}

// Маршруты за замком из самого приложения (routesBehindGate выше): GET, которые человеку можно. Путь — с подставленным id игры
const gameRoutesOf = (method) => routesBehindGate().filter((r) => r.method === method && access.userMay(method, r.path.replace(/^\/api/, '').replace(/:[A-Za-z]+/g, 'x')));

const withId = (p, id) => p.replace(/\/:(?:id|gameId)\b/g, `/${encodeURIComponent(id)}`).replace(/:[A-Za-z]+/g, 'x');

const needlesIn = (res, sent) => {
    // Адрес, который мы сами послали, маршрут вправе повторить (страница ошибки, подпись): его не считаем
    let text = res.raw.toString('utf8');
    for (const s of [sent, decodeURI(sent), encodeURI(sent)]) text = text.split(s).join('');
    return NEEDLES.filter((n) => text.includes(n));
};

test('доступ к играм: у каждой строки списка прав есть область; маршрут без неё и маршрут с id игры без области человеку закрыт или не проходит проверку', async (t) => {
    const fx = await accessSetup(t);
    const nora = await fx.person('Nora', [OPEN]);
    for (const [, re, scope] of access.USER_ROUTES) {
        assert.ok(scope && ['none', 'list', 'marks', 'one'].includes(scope.kind), `у строки ${re} нет области`);
        if (scope.kind === 'one') assert.strictEqual(typeof scope.ids, 'function', String(re));
    }
    // Маршрут, добавленный в список без области, отвечает как отсутствующий — 403, а не пропускает
    access.USER_ROUTES.push(['GET', /^\/zz-no-scope$/]);
    try {
        assert.strictEqual(access.userMay('GET', '/zz-no-scope'), false);
        const res = await call('GET', '/api/zz-no-scope', nora.as);
        assert.deepStrictEqual([res.status, res.data?.reason], [403, 'owner-only']);
    } finally { access.USER_ROUTES.pop(); }

    // Каждый настоящий маршрут, где в адресе игра (:id, :gameId), в списке с областью «игра», и область её находит. Исключение —
    // /avatars/:id: там id картинки человека, а не игры
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const r of gameRoutesOf(method)) {
            if (!/\/:(?:id|gameId)\b/.test(r.path) || r.path.startsWith('/api/avatars/')) continue;
            const p = withId(r.path, HID).replace(/^\/api/, '');
            const scope = access.scopeOf(method, p);
            assert.strictEqual(scope?.kind, 'one', `${method} ${r.path}: область не «игра»`);
            assert.ok(scope.ids({ method, path: p, query: {}, body: {} }).includes(HID), `${method} ${r.path}: область не нашла игру в адресе`);
        }
    }
});

test('серия: пишет только владелец, неверное имя не проходит; человек видит её только у своих игр', async (t) => {
    const fx = await accessSetup(t);
    const url = (id) => `/api/games/${id}/series`;
    assert.strictEqual((await call('POST', url('Nope_Game'), { json: { series: 'x' } })).status, 404);
    for (const series of ['x'.repeat(121), 'a\u0001b', 'a\nb', 5, null, '!!!']) {
        assert.strictEqual((await call('POST', url(OPEN), { json: { series } })).status, 400, String(series));
    }
    assert.strictEqual((await call('POST', url(HID), { json: { series: 'Zqx Canary Saga' } })).status, 200);
    const done = await call('POST', url(OPEN), { json: { series: '  Open Saga ' } });
    assert.deepStrictEqual([done.status, done.data.series], [200, 'Open Saga']);
    const byId = (list, id) => list.find((g) => g.id === id);
    assert.strictEqual(byId((await call('GET', '/api/games')).data, OPEN).series, 'Open Saga');

    const nora = await fx.person('Nora', [OPEN]);
    const asNora = (method, p, opts) => call(method, p, { ...opts, ...nora.as });
    assert.strictEqual((await asNora('POST', url(OPEN), { json: { series: 'none' } })).status, 403);
    assert.strictEqual((await asNora('POST', url(HID), { json: { series: 'none' } })).status, 403);
    const seen = await asNora('GET', '/api/games');
    assert.strictEqual(byId(seen.data, OPEN).series, 'hidden 1', 'имя, которого нет в названиях его игр, человеку не приходит');
    assert.ok(!seen.raw.toString('utf8').includes('Open Saga'));
    assert.ok(!seen.raw.toString('utf8').includes('Zqx Canary Saga'), 'серия скрытой игры не приходит');
    assert.strictEqual((await dbService.get().get('SELECT series FROM games WHERE id = ?', [OPEN])).series, 'Open Saga');

    // Владелец добавил открытую игру в серию из окна закрытой: имя — основа названия закрытой
    await call('POST', url(OPEN), { json: { series: 'Zqx Canary' } });
    const leak = await asNora('GET', '/api/games');
    assert.strictEqual(byId(leak.data, OPEN).series, 'hidden 1');
    assert.ok(!leak.raw.toString('utf8').includes('Zqx Canary'), 'основа названия закрытой игры не приходит');
    assert.strictEqual(byId((await call('GET', '/api/games')).data, OPEN).series, 'Zqx Canary', 'у владельца имя настоящее');
    // Имя — начало названия его же игры: ничего не выдаёт, и часть серии сходится с остальными по названию
    const shown = byId(leak.data, OPEN).displayTitle;
    await call('POST', url(OPEN), { json: { series: shown } });
    assert.strictEqual(byId((await asNora('GET', '/api/games')).data, OPEN).series, shown);
    await call('POST', url(OPEN), { json: { series: 'Open Saga' } });

    // Правка названия серию не трогает: она в своём столбце; удаление с возвратом из корзины её приносит обратно
    const del = await call('DELETE', `/api/games/${OPEN}`);
    assert.strictEqual((await call('POST', `/api/games/trash/${del.data.trashKey}/restore`)).status, 200);
    assert.strictEqual(byId((await call('GET', '/api/games')).data, OPEN).series, 'Open Saga');
});

test('доступ к играм: канарейка — ограниченный человек не получает ни следа закрытой игры ни от одного GET из настоящего списка маршрутов', async (t) => {
    const fx = await accessSetup(t);
    const routes = gameRoutesOf('GET');
    assert.ok(routes.length > 40, `GET-маршрутов человеку: ${routes.length}`);
    const passes = [
        ['игра в адресе — закрытая', (r) => withId(r.path, HID)],
        ['игра в адресе — открытая, закрытая названа в запросе', (r) => `${withId(r.path, OPEN)}?${QUERY}&game=${HID}&id=${HID}`],
        ['игра в адресе — открытая, запрос про библиотеку', (r) => `${withId(r.path, OPEN)}?${QUERY}`],
    ];
    const found = new Map();
    // У каждого прохода свой человек: запросы к внешним каталогам одного человека ограничены 20 в минуту
    for (const [i, [name, url]] of passes.entries()) {
        const lena = await fx.person(`Lena${i}`, [OPEN]);
        for (const r of routes) {
            const sent = url(r);
            const res = await call('GET', sent, lena.as);
            const hit = needlesIn(res, sent);
            assert.deepStrictEqual(hit, [], `${name}: GET ${r.path} → ${res.status} выдал ${hit}`);
            found.set(`${name}|${r.path}`, res.status);
        }
    }
    // Проверка проверки: владельцу те же запросы дают все приметы. Иначе «ничего не нашли» могло бы значить «ничего не искали»
    const seen = new Set();
    for (const r of routes) for (const sent of [withId(r.path, HID), `${withId(r.path, OPEN)}?${QUERY}`]) {
        for (const n of needlesIn(await call('GET', sent), sent)) seen.add(n);
    }
    assert.deepStrictEqual([...seen].sort(), [...NEEDLES].sort(), 'владелец видит все приметы, значит, обход их находит');
    assert.ok([...found.values()].some((s) => s === 200), 'часть маршрутов отвечает по делу, а не только отказом');
});

test('доступ к играм: tagged и faved в ответе меню — только про открытые человеку игры и его сердечки', async (t) => {
    const fx = await accessSetup(t);
    const lena = await fx.person('Lena', [OPEN]);
    const menu = async (who) => {
        const { tagged, faved } = (await call('GET', '/api/pictures/status?peek=1&tagged=1', who)).data;
        return { tagged, faved };
    };
    const tagFile = (id) => fs.writeFileSync(path.join(root, '_media', id, 'gallery-tags.json'), '{}');
    // Разобрана и отмечена только закрытая: у человека пусто, а владелец свою закрытую игру видит; сердечки у каждого свои
    tagFile(HID);
    await fx.db.run("INSERT INTO user_gallery_favorites (user_id, game_id, file, kind, at) VALUES (?, ?, 'img/pictures/zqx.png', 'cg', 1)", [lena.id, HID]);
    assert.deepStrictEqual(await menu(lena.as), { tagged: false, faved: false });
    assert.deepStrictEqual(await menu(), { tagged: true, faved: false });
    await fx.db.run("INSERT INTO gallery_favorites (game_id, file, kind, at) VALUES (?, 'img/pictures/zqx.png', 'cg', 1)", [HID]);
    t.after(() => fx.db.run('DELETE FROM gallery_favorites WHERE game_id = ?', [HID]));
    assert.deepStrictEqual(await menu(), { tagged: true, faved: true });
    assert.deepStrictEqual(await menu(lena.as), { tagged: false, faved: false });
    // Своё в открытой игре — да
    tagFile(OPEN);
    await fx.db.run("INSERT INTO user_gallery_favorites (user_id, game_id, file, kind, at) VALUES (?, ?, 'img/pictures/open.png', 'cg', 1)", [lena.id, OPEN]);
    assert.deepStrictEqual(await menu(lena.as), { tagged: true, faved: true });
});

test('доступ к играм: человек с ограниченным набором получает те же ответы, есть закрытая игра в библиотеке или нет её совсем', async (t) => {
    const fx = await accessSetup(t);
    const routes = gameRoutesOf('GET');
    const url = (r) => `${withId(r.path, OPEN)}?${QUERY}`;
    const take = async (who) => {
        const out = new Map();
        for (const r of routes) {
            const res = await call('GET', url(r), who.as);
            out.set(`GET ${r.path}`, [res.status, res.raw.toString('utf8')]);
        }
        return out;
    };
    // Прогрев: сборка галерей, кэши, первые ответы — отдельным человеком, чтобы не занять лимит каталогов у проверяемого
    await take(await fx.person('Warm', [OPEN]));
    const lena = await fx.person('Lena', [OPEN]);
    // Личное человека, чтобы ответы были не пустыми: заметка и список открытой игры, закладка
    await fx.db.run("INSERT INTO user_games (user_id, game_id, notes, lists, at) VALUES (?, ?, 'mine', '[\"mine\"]', 1)", [lena.id, OPEN]);
    await fx.db.run("INSERT INTO user_gallery_favorites (user_id, game_id, file, kind, at) VALUES (?, ?, 'img/pictures/open.png', 'cg', 1)", [lena.id, OPEN]);
    await redisClient.del('api:games:list');
    const present = await take(lena);
    assert.ok([...present.values()].some(([status, body]) => status === 200 && body.length > 20), 'ответы не пустые');
    const games = JSON.parse(present.get('GET /api/games/')[1]);
    assert.deepStrictEqual(games.map((g) => [g.id, g.number]), [[OPEN, 1]], 'в списке только открытая, и номер — место среди видимых, а не среди всех');

    // Закрытой игры нет совсем: ни строки, ни папки, ни галереи
    await fx.gallery.forget(HID);
    await fx.db.run('DELETE FROM games WHERE id = ?', [HID]);
    fs.rmSync(path.join(root, HID), { recursive: true, force: true });
    fs.rmSync(path.join(root, '_media', HID), { recursive: true, force: true });
    await redisClient.flushDb();
    const absent = await take(lena);
    const differ = [...present.keys()].filter((k) => JSON.stringify(present.get(k)) !== JSON.stringify(absent.get(k)));
    assert.deepStrictEqual(differ, [], `ответы разошлись: ${differ.map((k) => `${k}\n  было ${present.get(k)[1].slice(0, 200)}\n  стало ${absent.get(k)[1].slice(0, 200)}`).join('\n')}`);
});

test('доступ к играм: каждый маршрут с игрой в запросе отвечает про закрытую и про несуществующую одинаково — 404, в любой записи id', async (t) => {
    const fx = await accessSetup(t);
    const lena = await fx.person('Lena', [OPEN]);
    const asked = async (method, urlOf, body) => {
        const real = await call(method, urlOf(HID), { ...lena.as, ...(body ? { json: body(HID) } : {}) });
        const none = await call(method, urlOf(NOPE), { ...lena.as, ...(body ? { json: body(NOPE) } : {}) });
        assert.strictEqual(real.status, 404, `${method} ${urlOf(HID)}`);
        assert.deepStrictEqual([real.status, real.raw.toString()], [none.status, none.raw.toString()], `${method} ${urlOf('ID')}: закрытая отличается от несуществующей`);
        assert.deepStrictEqual(needlesIn(real, urlOf(HID)), []);
    };
    // Все маршруты из настоящего списка, где игра в адресе, всеми методами, которые человеку разрешены
    let count = 0;
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const r of gameRoutesOf(method)) {
            if (!/\/:(?:id|gameId)\b/.test(r.path) || r.path.startsWith('/api/avatars/')) continue;
            await asked(method, (id) => withId(r.path, id), method === 'GET' ? null : () => ({}));
            count++;
        }
    }
    assert.ok(count > 25, `маршрутов с игрой в адресе: ${count}`);
    // Записи id: %-коды, лишний «/», HEAD, регистр служебных слов /saves, одинаковый ответ на трёх путях сейвов
    const cases = [
        ['GET', (id) => `/api/gallery/${[...id].map((c, i) => (i % 2 ? `%${c.charCodeAt(0).toString(16)}` : c)).join('')}`],
        ['GET', (id) => `/api/gallery/${id}/`],
        ['HEAD', (id) => `/api/gallery/${id}/thumb?f=x.png`],
        ['GET', (id) => `/api/saves/EXPORT/${id}`],
        ['GET', (id) => `/api/saves/History/${id}`],
        ['POST', (id) => `/api/saves/import/${id}`],
        ['POST', (id) => `/api/saves/history/${id}/restore`],
        ['GET', (id) => `/api/saves/${id}`],
        ['GET', (id) => `/api/scenes?game=${id}`],
        ['GET', (id) => `/api/scenes?game[]=${id}`],
        ['GET', (id) => `/api/scenes?game=${OPEN}&game=${id}`],
        ['GET', (id) => `/api/scenes?game=${OPEN}&game[]=${id}`],
        ['GET', (id) => `/api/lines/search?q=zqx+canary&game[]=${id}`],
        ['GET', (id) => `/api/pictures/similar?game[]=${id}&f=x.png`],
        ['GET', (id) => `/api/pictures/similar?game=${id}&f=x.png`],
        ['GET', (id) => `/api/favorites?game[]=${id}`],
        ['GET', (id) => `/api/favorites?game=${id}`],
        ['DELETE', (id) => `/api/favorites?game=${id}&f=x.png`],
        ['DELETE', (id) => `/api/favorites?game[]=${id}&f=x.png`],
    ];
    for (const [method, urlOf] of cases) await asked(method, urlOf);
    await asked('PUT', () => '/api/favorites', (id) => ({ game: id, file: 'x.png' }));
    await asked('PUT', () => '/api/favorites', (id) => ({ game: [id], file: 'x.png' }));
    // Открытая игра теми же записями проходит замок: проверка не отказывает всем подряд
    for (const url of [`/api/gallery/Open%5FGame`, `/api/gallery/${OPEN}/`, `/api/scenes?game=${OPEN}`, `/api/favorites?game[]=${OPEN}`, `/api/saves/${OPEN}`]) {
        assert.strictEqual((await call('GET', url, lena.as)).status, 200, url);
    }
    // Без игры в запросе замок пропускает: «game=» пустой — то же, что не задан
    assert.strictEqual((await call('GET', '/api/scenes?game=', lena.as)).status, 200);
});

test('доступ к играм: подделанный сейв закрытой игры не раскрывает названий её карт, и импорт ничего не создаёт', async (t) => {
    const fx = await accessSetup(t);
    const lena = await fx.person('Lena', [OPEN, HID]);
    const mine = path.join(root, '_saves', '.people', lena.id, HID);
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'RPG%20File1.json'), slotValue(60, 1).replace('"_mapId":0', '"_mapId":1'));
    const history = () => call('GET', `/api/saves/history/${HID}`, lena.as);
    assert.match((await history()).raw.toString(), /Zqx Map Needle/, 'пока игра открыта, название карты видно: проверка не пустая');
    await gameAccess.replace(lena.id, { limited: true, games: [OPEN] });
    const closed = await history();
    assert.strictEqual(closed.status, 404);
    assert.ok(!closed.raw.toString().includes('Zqx Map Needle'));
    const before = fs.readdirSync(path.join(root, '_saves', '.people', lena.id)).sort();
    for (const id of [HID, NOPE]) {
        const res = await call('POST', `/api/saves/import/${id}`, { ...lena.as, raw: Buffer.from('PK forged'), headers: { ...lena.as.headers, 'content-type': 'multipart/form-data; boundary=x' } });
        assert.strictEqual(res.status, 404, `импорт в ${id}`);
    }
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '_saves', '.people', lena.id)).sort(), before, 'ни папки, ни файла не появилось');
    assert.ok(!fs.existsSync(path.join(root, '_saves', '.people', lena.id, NOPE)));
});

test('дни игры: у каждого свои, закрытых игр и дней только с ними нет, окно 371 день, today с сервера', async (t) => {
    const fx = await accessSetup(t);
    const dayBack = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    t.after(() => fx.db.run('DELETE FROM play_days'));
    await fx.db.run('DELETE FROM play_days');
    assert.deepStrictEqual((await call('GET', '/api/play-days')).data, { days: [], since: null, today: dayBack(0) });

    const nora = await fx.person('Nora', [OPEN]);
    const lena = await fx.person('Lena');
    const add = (user, game, day, seconds) => fx.db.run('INSERT INTO play_days (user_id, game_id, day, seconds) VALUES (?, ?, ?, ?)', [user, game, day, seconds]);
    await add('owner', OPEN, dayBack(1), 100);
    await add('owner', HID, dayBack(1), 900);
    await add('owner', OPEN, dayBack(370), 10);
    await add('owner', OPEN, dayBack(371), 20);
    await add(nora.id, HID, dayBack(400), 50);
    await add(nora.id, HID, dayBack(2), 50);
    await add(nora.id, OPEN, dayBack(1), 70);
    await add(nora.id, OPEN, dayBack(3), 0);
    await add(lena.id, HID, dayBack(5), 30);

    const owner = (await call('GET', '/api/play-days')).data;
    assert.deepStrictEqual(owner.days, [
        { day: dayBack(370), games: [{ id: OPEN, seconds: 10 }] },
        { day: dayBack(1), games: [{ id: HID, seconds: 900 }, { id: OPEN, seconds: 100 }] },
    ], 'день 371 назад за окном, в дне больше наигранное выше');
    assert.strictEqual(owner.since, dayBack(371), 'since — самая ранняя строка вообще, и за окном тоже');

    // Игра в корзине: её дней нет, ни в списке, ни в since; вернули — вернулись
    await add('owner', 'Zqx_Trashed_Game', dayBack(380), 500);
    await add('owner', 'Zqx_Trashed_Game', dayBack(4), 500);
    const noTrash = (await call('GET', '/api/play-days')).data;
    assert.ok(!noTrash.days.some((d) => d.day === dayBack(4)), 'день только с игрой не из списка не отдаётся');
    assert.strictEqual(noTrash.since, dayBack(371));
    await fx.db.run("DELETE FROM play_days WHERE game_id = 'Zqx_Trashed_Game'");

    const limited = await call('GET', '/api/play-days', nora.as);
    assert.strictEqual(limited.status, 200);
    assert.deepStrictEqual(limited.data, { days: [{ day: dayBack(1), games: [{ id: OPEN, seconds: 70 }] }], since: dayBack(1), today: dayBack(0) }, 'день только с закрытой игрой не отдаётся, since её не выдаёт');
    assert.ok(!limited.raw.toString().includes(HID));
    assert.deepStrictEqual((await call('GET', '/api/play-days', lena.as)).data.days, [{ day: dayBack(5), games: [{ id: HID, seconds: 30 }] }], 'человек со всеми играми видит только свои строки');
});

test('доступ к играм: адрес картинок библиотеки отдаёт закрытую игру не по любому пути — и обложку, и миниатюру, и «..»; открытая и владелец без изменений', async (t) => {
    const fx = await accessSetup(t);
    fs.mkdirSync(path.join(root, '_old', HID, '2026-01-01'), { recursive: true });
    fs.writeFileSync(path.join(root, '_old', HID, '2026-01-01', 'a.png'), PNG);
    fs.mkdirSync(path.join(root, '_trash', `1700000000000-${HID}`, 'game'), { recursive: true });
    fs.writeFileSync(path.join(root, '_trash', `1700000000000-${HID}`, 'game', 'a.png'), PNG);
    const lena = await fx.person('Lena', [OPEN]);
    // Страница Express «Cannot GET /путь» повторяет адрес: имя игры в ней — не утечка и не отличие
    const answer = async (who, p, id = '') => {
        const res = await call('GET', p, who);
        return [res.status, res.raw.toString('latin1').split(id || '\0').join('<id>'), (res.headers.location || '').split(id || '\0').join('<id>')];
    };
    const paths = (id) => [
        `/${id}/www/img/pictures/zqxsecret.png`, `/${id}/cover.jpg`, `/x/../${id}/cover.jpg`, `/${id}/%2e%2e/${id}/cover.jpg`, `/_media/${id}/cover-0123456789.png`,
        `/_media/${id}/cover-0123456789.png?w=360`, `/${id}/cover.jpg?w=720`, `/_media/x/../${id}/cover-0123456789.png`, `/_old/${id}/2026-01-01/a.png`,
        `/_trash/1700000000000-${id}/game/a.png`, `/${id}`, `/${id}/`, `/${id}/www/index.html`,
    ];
    for (const [i, p] of paths(HID).entries()) {
        const real = await answer(lena.as, p, HID);
        const none = await answer(lena.as, paths(NOPE)[i], NOPE);
        assert.deepStrictEqual(real, none, `${p}: закрытая отвечает не так, как несуществующая`);
        assert.ok(!real[1].startsWith('\x89PNG') && !real[2], `${p}: файл или переход`);
        // Проверка проверки: владелец по тем же путям получает файл или переход
        const owner = await answer({}, p);
        assert.ok(owner[0] === 200 || owner[2], `владелец: ${p} → ${owner[0]}`);
    }
    assert.ok((await answer({}, `/${HID}`))[2].startsWith('/?play='), 'владельцу переход в библиотеку, как раньше');
    // Открытая игра человеку отдаётся, в том числе уменьшенной и через «..» внутри своей папки
    for (const p of [`/${OPEN}/cover.jpg`, `/_media/${OPEN}/cover-0123456789.png`, `/_media/${OPEN}/cover-0123456789.png?w=360`, `/${OPEN}/www/../cover.jpg`]) {
        assert.strictEqual((await call('GET', p, lena.as)).status, 200, p);
    }
    assert.strictEqual((await answer(lena.as, `/${OPEN}`))[2], `/?play=${OPEN}`, 'переход в библиотеку на открытую игру остался');
    // Человек со всеми играми — как раньше
    const max = await fx.person('Max');
    assert.strictEqual((await call('GET', `/${HID}/cover.jpg`, max.as)).status, 200);
});

test('доступ к играм: GAME_ISOLATION=off — закрытая игра не отдаётся и страницей игры, и картинкой; открытая и владелец без изменений', { timeout: 60000 }, async (t) => {
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-isolation-off-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = `
        console.log = console.error;
        const fs = require('fs'); const path = require('path'); const http = require('http');
        const { app } = require('./server.js');
        const db = require('./src/db/database.js');
        const sessions = require('./src/utils/sessions.js');
        (async () => {
            const root = process.env.GAMES_DIR;
            await db.init(root);
            const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
            for (const id of ['Open_Game', 'Zqx_Hidden_Canary']) {
                fs.mkdirSync(path.join(root, id, 'www', 'img'), { recursive: true });
                fs.writeFileSync(path.join(root, id, 'www', 'index.html'), '<html><body><title>' + id + '</title></body></html>');
                fs.writeFileSync(path.join(root, id, 'www', 'img', 'a.png'), PNG);
                fs.writeFileSync(path.join(root, id, 'cover.jpg'), PNG);
                fs.mkdirSync(path.join(root, '_media', id), { recursive: true });
                fs.writeFileSync(path.join(root, '_media', id, 'cover-0123456789.png'), PNG);
            }
            await db.get().run("INSERT INTO users (id, name, pass_hash) VALUES ('ulena0000000000a', 'Lena', 'x')");
            await db.get().run("UPDATE users SET games_limited = 1 WHERE id = 'ulena0000000000a'");
            await db.get().run("INSERT INTO user_game_access (user_id, game_id) VALUES ('ulena0000000000a', 'Open_Game')");
            const lena = await sessions.create('ulena0000000000a');
            const owner = await sessions.create('owner');
            const srv = app.listen(0, '127.0.0.1');
            await new Promise((r) => srv.once('listening', r));
            const get = (token, p) => new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers: { cookie: (process.env.AUTH_COOKIE_NAME || 'auth_token') + '=' + token } }, (res) => {
                    const chunks = []; res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('latin1'), location: res.headers.location || '' }));
                }).on('error', reject);
            });
            const paths = (id) => ['/' + id + '/www/index.html', '/' + id + '/www/img/a.png', '/' + id + '/cover.jpg', '/_media/' + id + '/cover-0123456789.png', '/x/../' + id + '/www/index.html', '/' + id];
            const out = {};
            for (const [name, token] of [['lena', lena.token], ['owner', owner.token]]) {
                out[name] = {};
                for (const id of ['Open_Game', 'Zqx_Hidden_Canary', 'Nope_Game_Zz']) out[name][id] = await Promise.all(paths(id).map((p) => get(token, p)));
            }
            process.stdout.write(JSON.stringify(out));
            process.exit(0);
        })().catch((e) => { console.error(e); process.exit(1); });
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], {
        cwd: __dirname, encoding: 'utf8', timeout: 50000, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GAMES_DIR: dir, GAME_ISOLATION: 'off', REDIS_URL: 'memory', OFFLINE: '1', GALLERY_VISION: '0' },
    }));
    const hidden = out.lena.Zqx_Hidden_Canary;
    const none = out.lena.Nope_Game_Zz;
    // Страница Express «Cannot GET /путь» повторяет адрес: имя игры в ней — не отличие
    const plain = (answer, id) => JSON.parse(JSON.stringify(answer).split(id).join('<id>'));
    hidden.forEach((answer, i) => {
        assert.deepStrictEqual(plain(answer, 'Zqx_Hidden_Canary'), plain(none[i], 'Nope_Game_Zz'), `путь ${i}: закрытая игра отвечает не так, как несуществующая`);
        assert.ok(!answer.body.includes('<title>Zqx_Hidden_Canary') && !answer.body.startsWith('\x89PNG') && !answer.location, `путь ${i}`);
    });
    assert.ok(out.lena.Open_Game[0].body.includes('window.__RPG'), 'открытая игра запускается: страница с нашей вставкой');
    assert.ok(out.lena.Open_Game[1].body.startsWith('\x89PNG'));
    // Проверка проверки: владельцу та же закрытая игра отдаётся и страницей, и картинкой
    assert.ok(out.owner.Zqx_Hidden_Canary[0].body.includes('window.__RPG') && out.owner.Zqx_Hidden_Canary[1].body.startsWith('\x89PNG'));
});

// Сервер игр: тот же, что собирает server.js, на свободном порту
async function gamePortSetup(t) {
    const { createGameApp } = require('./src/routes/play.js');
    const sessions = require('./src/utils/sessions.js');
    const personStores = require('./src/utils/personStores.js');
    const { gameHooks } = require('./src/utils/saveprogress.js');
    const server = createGameApp({
        secret: () => dbService.getSessionToken(), sessions: { find: sessions.findById, legacyOpen: () => dbService.legacyOpen() },
        store: personStores.owner.saves, marks: personStores.owner.marks, journal: personStores.owner.journal,
        storesFor: (userId) => personStores.storesFor({ id: userId }), publicDir: path.join(__dirname, 'public'),
        mayOpen: (userId, id) => gameAccess.may({ id: userId }, id),
        ...gameHooks,
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const prevLegacy = dbService.legacyUntil;
    dbService.legacyUntil = 0;
    t.after(() => { server.close(); dbService.legacyUntil = prevLegacy; });
    const send = (method, url, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body && JSON.stringify(body));
    });
    return { send };
}

test('доступ к играм: сервер игр — ключ человека проверяется на каждом файле, закрытая игра не открывается ни ключом, ни входом; вернули — открылась', async (t) => {
    const fx = await accessSetup(t);
    const { send } = await gamePortSetup(t);
    const { gameKey, revOf } = require('./src/routes/play.js');
    const crypto = require('crypto');
    const lena = await fx.person('Lena', [OPEN, HID]);
    const max = await fx.person('Max');
    const play = async (who, id) => (await call('POST', `/api/play/${id}`, who ? who.as : {})).data;
    const urls = (p) => ({
        file: `${p.path}www/data/System.json`, ready: p.check, tl: `${p.path}www/mimikin-tl.json`, maps: `${p.path}www/data/mimikin-maps.json`,
        page: `${p.path}www/index.html?s=${p.session}`,
    });
    const open = async (p) => {
        const u = urls(p);
        const codes = [(await send('GET', u.file)).status, (await send('GET', u.ready)).status, (await send('GET', u.page)).status];
        return codes;
    };
    const lenaOpen = await play(lena, OPEN);
    const lenaHid = await play(lena, HID);
    assert.match(lenaOpen.path, new RegExp(`^/g/u[0-9a-f]{16}[0-9a-f]{32}/${OPEN}/$`), 'ключ человека: его id и подпись');
    assert.deepStrictEqual(await open(lenaOpen), [200, 200, 200]);
    assert.deepStrictEqual(await open(lenaHid), [200, 200, 200]);

    // Закрыли HID: тот же адрес, что работал, отвечает 403 на следующем же запросе, с кукой и без неё, всеми путями
    await call('PUT', `/api/users/${lena.id}/games`, { json: { limited: true, games: [OPEN] } });
    const gone = urls(lenaHid);
    for (const [name, url] of Object.entries({ file: gone.file, ready: gone.ready, tl: gone.tl, maps: gone.maps, page: gone.page })) {
        for (const headers of [{}, { cookie: `${COOKIE}=${lena.cookie}` }]) {
            assert.strictEqual((await send('GET', url, { headers })).status, 403, `${name}${headers.cookie ? ' с кукой' : ''}`);
        }
    }
    const sess = lenaHid.session;
    for (const [method, url, body] of [
        ['GET', `/saves/${sess}/${HID}`], ['POST', `/saves/${sess}/${HID}/${encodeURIComponent('RPG File1')}`, { value: slotValue(1, 1), updatedAt: 5 }],
        ['GET', `/marks/${sess}/${HID}`], ['POST', `/journal/${sess}/${HID}`, { kind: 'scene', label: 'x' }], ['POST', `/errors/${sess}/${HID}`, { message: 'x' }],
    ]) assert.strictEqual((await send(method, url, { body })).status, 403, `${method} ${url}`);
    assert.ok(!fs.existsSync(path.join(root, '_saves', '.people', lena.id, HID)), 'в закрытую игру ничего не записалось');
    // Открытая у неё по-прежнему работает тем же ключом
    assert.deepStrictEqual(await open(lenaOpen), [200, 200, 200]);

    // Ключ привязан к человеку и к игре: чужой uid, чужая игра, ключ владельца до смены строки подписи
    const maxHid = await play(max, HID);
    assert.deepStrictEqual(await open(maxHid), [200, 200, 200], 'человеку «со всеми играми» закрытое для другого открыто');
    const keyOf = (p) => p.path.split('/')[2];
    assert.strictEqual((await send('GET', `/g/${keyOf(lenaOpen)}/${HID}/www/data/System.json`)).status, 403, 'ключ человека к игре A не открывает игру B, даже открытую ему');
    const forged = lenaOpen.path.replace(keyOf(lenaOpen), lena.id.slice(0, 17) + keyOf(maxHid).slice(17));
    assert.strictEqual((await send('GET', `${forged}www/data/System.json`)).status, 403, 'подпись одного человека с id другого');
    assert.strictEqual((await send('GET', `/g/${keyOf(maxHid).replace(/^u[0-9a-f]{16}/, lena.id)}/${HID}/www/data/System.json`)).status, 403);
    const rev = await revOf(OPEN);
    const old = crypto.createHmac('sha256', String(dbService.getSessionToken())).update(`play\n${OPEN}\n${rev}`).digest('hex').slice(0, 32);
    assert.strictEqual((await send('GET', `/g/${old}/${OPEN}/www/data/System.json`)).status, 403, 'общий ключ прежней версии больше не годится');
    assert.strictEqual((await send('GET', `/ready/${old}/${OPEN}`)).status, 403);
    const now = await play(null, OPEN);
    assert.strictEqual(keyOf(now), gameKey(dbService.getSessionToken(), OPEN, rev), 'у владельца формат один, ключ по-новому');
    assert.strictEqual(keyOf(now), keyOf(await play(null, OPEN)), 'и адрес владельца стабилен от запуска к запуску');
    assert.match(keyOf(now), /^[0-9a-f]{32}$/);
    assert.deepStrictEqual(await open(now), [200, 200, 200]);

    // Вернули — тот же адрес снова рабочий; «все игры» открывает всё, закрытое при этом не стирается
    await call('PUT', `/api/users/${lena.id}/games`, { json: { limited: true, games: [OPEN, HID] } });
    assert.deepStrictEqual(await open(lenaHid), [200, 200, 200], 'после возврата тот же адрес работает');
    await call('PUT', `/api/users/${lena.id}/games`, { json: { limited: true, games: [] } });
    assert.deepStrictEqual(await open(lenaOpen), [403, 403, 403]);
    await call('PUT', `/api/users/${lena.id}/games`, { json: { limited: false, games: [] } });
    assert.deepStrictEqual(await open(lenaOpen), [200, 200, 200], '«все игры»');
    // Закрыли человека совсем — ключ, выданный раньше, тоже не открывает
    await fx.db.run("UPDATE users SET state = 'locked' WHERE id = ?", [lena.id]);
    assert.strictEqual((await send('GET', urls(lenaOpen).file)).status, 403);
});

test('доступ к играм: владелец — ответы побайтно те же с ограниченными людьми и без них; запись по ключу владельца работает', async (t) => {
    const fx = await accessSetup(t);
    const { send } = await gamePortSetup(t);
    // /me и ему подобные игр не касаются, а «shared» в нём меняется с первым же человеком
    const routes = gameRoutesOf('GET').filter((r) => access.scopeOf('GET', r.path.replace(/^\/api/, '').replace(/:[A-Za-z]+/g, 'x')).kind !== 'none');
    const url = (r) => `${withId(r.path, OPEN)}?${QUERY}`;
    const take = async () => {
        const out = new Map();
        for (const r of routes) {
            const res = await call('GET', url(r));
            out.set(r.path, [res.status, res.raw.toString('utf8')]);
        }
        return out;
    };
    await take();
    const first = await take();
    const second = await take();
    const steady = [...first.keys()].filter((k) => JSON.stringify(first.get(k)) === JSON.stringify(second.get(k)));
    assert.ok(steady.length > 30, `устойчивых ответов: ${steady.length}`);
    await fx.person('Lena', [OPEN]);
    await fx.person('Max');
    await fx.person('Nobody', []);
    const after = await take();
    const differ = steady.filter((k) => JSON.stringify(first.get(k)) !== JSON.stringify(after.get(k)));
    assert.deepStrictEqual(differ, [], 'ответы владельца изменились из-за людей с ограничениями');
    // Запись владельца по ключу сессии
    const play = (await call('POST', `/api/play/${HID}`)).data;
    const slot = encodeURIComponent('RPG File1');
    t.after(() => fs.rmSync(path.join(root, '_saves', HID), { recursive: true, force: true }));
    assert.strictEqual((await send('POST', `/saves/${play.session}/${HID}/${slot}`, { body: { value: slotValue(1, 1), updatedAt: 5 } })).status, 200);
    assert.strictEqual((await send('GET', `/saves/${play.session}/${HID}`)).status, 200);
});

test('доступ к играм: отметка game в карточках каталога itch.io и списке желаний есть у открытых и у владельца, у закрытых нет', async (t) => {
    const fx = await accessSetup(t);
    const lena = await fx.person('Lena', [OPEN]);
    const max = await fx.person('Max');
    const OPEN_URL = 'https://openstudio.itch.io/open-game';
    const HID_URL = 'https://zqxstudio.itch.io/zqxthread';
    await fx.db.run('UPDATE games SET link = ? WHERE id = ?', [OPEN_URL, OPEN]);
    // Лента itch.io подменена: в сеть тест не ходит. Кэш ленты — в Redis, его на время теста чистим
    const feed = [OPEN_URL, HID_URL].map((url, n) => `<item><link>${url}</link><plainTitle>Card ${n + 1}</plainTitle><title>Card ${n + 1} [Free]</title><price>0</price></item>`).join('');
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, text: async () => `<rss><channel>${feed}</channel></rss>` }));
    for (const key of await redisClient.keys('itch:feed:*')) await redisClient.del(key);
    t.after(async () => { for (const key of await redisClient.keys('itch:feed:*')) await redisClient.del(key); });
    const marks = (res) => (res.data?.items || []).map((x) => x.game?.id || null);
    assert.deepStrictEqual(marks(await call('GET', '/api/itch/latest')), [OPEN, HID], 'владелец');
    assert.deepStrictEqual(marks(await call('GET', '/api/itch/latest', max.as)), [OPEN, HID], 'все игры');
    assert.deepStrictEqual(marks(await call('GET', '/api/itch/latest', lena.as)), [OPEN, null], 'ограниченный');
    // Список желаний: отметка настоящая, по ссылке игры
    for (const as of [lena.as, max.as]) await call('POST', '/api/wishlist', { ...as, json: { source: 'itch', url: HID_URL, title: 'Wish' } });
    const wish = async (as) => ((await call('GET', '/api/wishlist', as)).data?.items || []).map((x) => x.game?.id || null);
    assert.deepStrictEqual(await wish(max.as), [HID], 'пока доступ есть, отметка на месте: проверка не пустая');
    assert.deepStrictEqual(await wish(lena.as), [null], 'у ограниченного — карточка без отметки');
});

test('доступ к играм: закрыли и открыли снова — сейвы, моменты, путь, заметки, списки, избранное на месте как были, время не удвоилось', async (t) => {
    const fx = await accessSetup(t);
    const lena = await fx.person('Lena', [OPEN, HID]);
    const base = path.join(root, '_saves', '.people', lena.id);
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
    put(`${HID}/RPG%20File1.json`, slotValue(60, 7).replace('"_mapId":0', '"_mapId":1'));
    put(`.marks/${HID}/spot.json`, '{"by":"lena"}');
    put(`.journal/${HID}/step.json`, '{"k":"scene"}');
    await fx.db.run("INSERT INTO user_games (user_id, game_id, playtime, rating, notes, lists, at) VALUES (?, ?, 777, 4, 'zqx note', '[\"zqxlist\"]', 1)", [lena.id, HID]);
    await fx.db.run("INSERT INTO user_gallery_favorites (user_id, game_id, file, kind, at) VALUES (?, ?, 'img/pictures/zqxsecret.png', 'cg', 1)", [lena.id, HID]);
    await redisClient.del('api:games:list');
    const tree = () => fs.readdirSync(base, { recursive: true }).sort().map((p) => (fs.statSync(path.join(base, p)).isFile() ? `${p}=${fs.readFileSync(path.join(base, p), 'utf8')}` : p)).join('\n');
    const rows = async () => JSON.stringify([
        await fx.db.all('SELECT * FROM user_games WHERE user_id = ? ORDER BY game_id', [lena.id]),
        await fx.db.all('SELECT * FROM user_gallery_favorites WHERE user_id = ? ORDER BY file', [lena.id]),
    ]);
    const view = async () => {
        const g = (await call('GET', '/api/games', lena.as)).data.find((x) => x.id === HID);
        const fav = (await call('GET', '/api/favorites', lena.as)).data;
        const hist = (await call('GET', `/api/saves/history/${HID}`, lena.as)).data;
        return JSON.stringify([g && [g.notes, g.lists, g.playtime, g.rating], fav.map((f) => f.file), hist?.slots?.map((s) => [s.key, s.current?.summary?.map])]);
    };
    const filesBefore = tree();
    const rowsBefore = await rows();
    const viewBefore = await view();
    assert.match(viewBefore, /zqx note/);
    assert.match(viewBefore, /Zqx Map Needle/);

    await call('PUT', `/api/users/${lena.id}/games`, { json: { limited: true, games: [OPEN] } });
    assert.strictEqual(await view(), '[null,[],null]', 'пока закрыто: ни игры, ни избранного, ни истории');
    for (const url of [`/api/saves/${HID}`, `/api/saves/export/${HID}`, `/api/marks/${HID}`, `/api/journal/${HID}`, `/api/gallery/${HID}`]) assert.strictEqual((await call('GET', url, lena.as)).status, 404, url);
    // Подборку переименовывают и в закрытых играх: вернут игру — список в ней уже новый
    assert.strictEqual((await call('POST', '/api/games/lists/change', { ...lena.as, json: { from: 'zqxlist', to: 'zqxlist2' } })).data.changed, 1);
    assert.strictEqual(tree(), filesBefore, 'файлы на диске те же');
    assert.strictEqual(JSON.parse(await rows())[0][0].lists, '["zqxlist2"]');

    await call('PUT', `/api/users/${lena.id}/games`, { json: { limited: true, games: [OPEN, HID] } });
    const back = await view();
    assert.strictEqual(back, viewBefore.replace('zqxlist', 'zqxlist2'), 'вернулось как было (подборка — под новым именем)');
    assert.strictEqual(tree(), filesBefore);
    assert.strictEqual(JSON.parse(await rows())[0][0].playtime, 777, 'время не удвоилось');
    void rowsBefore;
});

test('доступ к играм: новая игра ограниченному человеку не видна и не открыта, «всем играм» видна — без всякой выдачи', async (t) => {
    const fx = await accessSetup(t);
    const lena = await fx.person('Lena', [OPEN]);
    const max = await fx.person('Max');
    await fx.make('Zqx_New_Game', { file: 'new.png', title: 'Zqx New Title', developer: 'Zqx New Dev', tags: [], link: '', at: 5000 });
    await redisClient.del('api:games:list');
    const ids = async (who) => (await call('GET', '/api/games', who.as)).data.map((g) => g.id);
    assert.deepStrictEqual(await ids(lena), [OPEN]);
    assert.ok((await ids(max)).includes('Zqx_New_Game'));
    assert.ok((await ids({ as: {} })).includes('Zqx_New_Game'));
    for (const url of ['/api/gallery/Zqx_New_Game', '/api/saves/Zqx_New_Game', '/Zqx_New_Game/cover.jpg']) assert.strictEqual((await call('GET', url, lena.as)).status, 404, url);
    assert.strictEqual((await call('POST', '/api/play/Zqx_New_Game', lena.as)).status, 404);
    assert.strictEqual((await call('POST', '/api/play/Zqx_New_Game', max.as)).status, 200);
});

test('доступ к играм: PUT /users/:id/games — только владелец, проверка списка, ответ человека обновляется сразу; GET отдаёт флаг и список', async (t) => {
    const fx = await accessSetup(t);
    const lena = await fx.person('Lena');
    const url = `/api/users/${lena.id}/games`;
    assert.deepStrictEqual((await call('GET', url)).data, { limited: false, games: [] }, 'новый человек — все игры');
    assert.strictEqual((await call('GET', url, lena.as)).data.reason, 'owner-only');
    assert.strictEqual((await call('PUT', url, { ...lena.as, json: { limited: false, games: [] } })).data.reason, 'owner-only', 'сам себе доступ не расширит');
    for (const body of [{}, { limited: 1, games: [] }, { limited: true, games: 'x' }, { limited: true, games: [1] }, { limited: true, games: [OPEN, OPEN, 'Nope'] }]) {
        const res = await call('PUT', url, { json: body });
        assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.strictEqual((await call('PUT', '/api/users/ughost000000000a/games', { json: { limited: true, games: [] } })).status, 404);
    assert.strictEqual((await call('GET', '/api/users/owner/games')).status, 404, 'у владельца ограничений нет');
    assert.deepStrictEqual((await call('GET', url)).data, { limited: false, games: [] }, 'отказы ничего не изменили');
    const seen = async () => (await call('GET', '/api/games', lena.as)).data.map((g) => g.id);
    assert.ok((await seen()).includes(HID) && (await seen()).includes(OPEN), 'пока ограничений нет, видно всё');
    assert.strictEqual((await call('PUT', url, { json: { limited: true, games: [OPEN, OPEN] } })).status, 200);
    assert.deepStrictEqual((await call('GET', url)).data, { limited: true, games: [OPEN] });
    assert.deepStrictEqual((await call('GET', '/api/games', lena.as)).data.map((g) => g.id), [OPEN], 'со следующего запроса, без кэша');
    assert.strictEqual((await call('PUT', url, { json: { limited: false, games: [OPEN] } })).status, 200);
    assert.ok((await seen()).includes(HID), 'снова все игры');
    assert.deepStrictEqual((await call('GET', url)).data, { limited: false, games: [OPEN] }, 'список хранится, пока флаг снят');
    // Игра в корзине (в games её нет): владелец не видит её в библиотеке и не шлёт, а доступ к ней сохранение не стирает
    await dbService.get().run("INSERT INTO user_game_access (user_id, game_id, at) VALUES (?, 'In_Trash_Game', 1)", [lena.id]);
    assert.strictEqual((await call('PUT', url, { json: { limited: true, games: [HID] } })).status, 200);
    assert.deepStrictEqual((await call('GET', url)).data, { limited: true, games: [HID, 'In_Trash_Game'].sort() }, 'OPEN снят, игра из корзины на месте');
});

test('доступ к играм: сокет ограниченного человека не слышит службы, а «список изменился» идёт без данных', async (t) => {
    const fx = await accessSetup(t);
    const lena = await fx.person('Lena', [OPEN]);
    const WebSocket = require('ws');
    const sockets = ioServer.listen(0, '127.0.0.1');
    await new Promise((r) => sockets.once('listening', r));
    t.after(() => { for (const s of io.sockets.sockets.values()) s.disconnect(true); sockets.close(); });
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${sockets.address().port}/socket.io/?EIO=4&transport=websocket`, { headers: { cookie: `${COOKIE}=${lena.cookie}` } });
    await new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('message', (d) => {
            const text = d.toString();
            if (text.startsWith('0{')) ws.send('40');
            else if (text.startsWith('40')) resolve();
            else if (text === '2') ws.send('3');
            else if (text.startsWith('42')) frames.push(text);
        });
    });
    const settle = () => new Promise((r) => setTimeout(r, 300));
    const { getIo } = require('./src/utils/cache.js');
    await settle();
    frames.length = 0;
    getIo().emit('fullcheck', { game: HID });
    getIo().emit('scrape-progress', { left: 3, game: HID });
    getIo().emit('telegram-changed', { items: [HID] });
    await settle();
    assert.deepStrictEqual(frames, [], 'события служб идут комнате владельца');
    await call('PUT', `/api/users/${lena.id}/games`, { json: { limited: true, games: [] } });
    await settle();
    assert.deepStrictEqual([...new Set(frames)], ['42["library-changed"]'], 'человеку — только «список изменился», без полей');
});

test('копия и доступ к играм: у человека, который здесь есть, список не расширяется старой копией; новый получает флаг и строки из копии; копия без таблицы восстанавливается', async (t) => {
    const fx = await accessSetup(t);
    const { restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    const lena = await fx.person('Lena', [OPEN]);
    const dir = fs.mkdtempSync(path.join(root, '_tmp_access_bk'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const [fresh, plain, legacy] = ['d', 'e', 'f'].map((ch) => `u${ch.repeat(16)}`);
    const bk = await openDb(path.join(dir, 'library.db'));
    await bk.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE wishlist (key TEXT PRIMARY KEY);
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '', games_limited INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE user_game_access (user_id TEXT NOT NULL, game_id TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, game_id))`);
    await bk.run('INSERT INTO users (id, name, pass_hash, games_limited) VALUES (?, ?, ?, 0), (?, ?, ?, 1), (?, ?, ?, 0), (?, ?, ?, 0)',
        [lena.id, 'Lena', '', fresh, 'Fresh', '', plain, 'Plain', '', legacy, 'Legacy', '']);
    await bk.run('INSERT INTO user_game_access (user_id, game_id, at) VALUES (?, ?, 1), (?, ?, 1), (?, ?, 1), (?, ?, 1)', [lena.id, OPEN, lena.id, HID, fresh, HID, plain, OPEN]);
    await bk.close();
    await restoreBackup(dir, { trash, store: {}, onSave: async () => {} });
    const state = async (id) => ({ ...(await fx.db.get('SELECT games_limited AS limited FROM users WHERE id = ?', [id])), games: (await fx.db.all('SELECT game_id FROM user_game_access WHERE user_id = ? ORDER BY game_id', [id])).map((r) => r.game_id) });
    assert.deepStrictEqual(await state(lena.id), { limited: 1, games: [OPEN] }, 'копия, где Лена видела всё, её сегодняшний список не расширила');
    assert.deepStrictEqual(await state(fresh), { limited: 1, games: [HID] }, 'новый человек — флаг и строки из копии');
    assert.deepStrictEqual(await state(plain), { limited: 0, games: [OPEN] });
    // Повторное восстановление той же копии: теперь все они здесь есть — не меняется ничего
    await fx.db.run('DELETE FROM user_game_access WHERE user_id = ?', [fresh]);
    await restoreBackup(dir, { trash, store: {}, onSave: async () => {} });
    assert.deepStrictEqual((await state(fresh)).games, [], 'человек уже здесь: закрытое ему не возвращается копией');

    // Старая копия: ни столбца, ни таблицы. Человек из неё — со всеми играми, как тогда
    const old = fs.mkdtempSync(path.join(root, '_tmp_access_old'));
    t.after(() => fs.rmSync(old, { recursive: true, force: true }));
    const ob = await openDb(path.join(old, 'library.db'));
    await ob.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE wishlist (key TEXT PRIMARY KEY);
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)`);
    await ob.run('INSERT INTO users (id, name, pass_hash) VALUES (?, ?, ?)', [legacy, 'Legacy', '']);
    await ob.close();
    await restoreBackup(old, { trash, store: {}, onSave: async () => {} });
    assert.deepStrictEqual(await state(legacy), { limited: 0, games: [] });
});

test('копия и доступ к играм: круг через архив — флаг и список возвращаются, а таблица не ходит в RESTORE_TABLES', { skip: !hasSevenZip() && 'нет 7zz' }, async (t) => {
    const fx = await accessSetup(t);
    const { buildBackup, unpackBackup, restoreBackup } = require('./src/routes/backup.js');
    const { trash } = require('./src/routes/games.js');
    const lena = await fx.person('Lena', [OPEN, HID]);
    const made = fs.mkdtempSync(path.join(root, '_tmp_acc_made'));
    const opened = fs.mkdtempSync(path.join(root, '_tmp_acc_open'));
    t.after(() => { fs.rmSync(made, { recursive: true, force: true }); fs.rmSync(opened, { recursive: true, force: true }); });
    const { file } = await buildBackup(made);
    const unpacked = await unpackBackup(file, opened);
    const inside = await openDb(path.join(unpacked, 'library.db'), require('sqlite3').OPEN_READONLY);
    try {
        assert.deepStrictEqual(await inside.all('SELECT games_limited FROM users'), [{ games_limited: 1 }], 'флаг пережил VACUUM INTO');
        assert.strictEqual((await inside.get('SELECT COUNT(*) AS n FROM user_game_access')).n, 2);
    } finally { await inside.close(); }
    // Людей и доступа больше нет — как на новой установке
    await fx.db.run('DELETE FROM sessions WHERE user_id != ?', ['owner']);
    await fx.db.run('DELETE FROM users');
    await fx.db.run('DELETE FROM user_game_access');
    await restoreBackup(unpacked, { trash, store: require('./src/utils/personStores.js').owner.saves, onSave: async () => {} });
    assert.deepStrictEqual(await fx.db.all('SELECT id, games_limited FROM users'), [{ id: lena.id, games_limited: 1 }]);
    assert.deepStrictEqual((await fx.db.all('SELECT game_id FROM user_game_access WHERE user_id = ? ORDER BY game_id', [lena.id])).map((r) => r.game_id), [OPEN, HID].sort());
    // Таблицы доступа нет среди сливаемых: иначе снятый доступ вернулся бы вместе со строками копии
    assert.ok(!require('fs').readFileSync(path.join(__dirname, 'src/routes/backup.js'), 'utf8').match(/RESTORE_TABLES = \[[\s\S]*?\n\];/)[0].includes('user_game_access'));
});
