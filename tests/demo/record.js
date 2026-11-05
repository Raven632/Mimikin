#!/usr/bin/env node
// Запись данных для демо-сайта. Работает ВНУТРИ контейнера с настоящим образом библиотеки, без сети (tests/demo/record.sh):
//   1. демо-библиотека (api/scripts/demo-library.js, как есть) и её дополнение tests/demo/rich.js;
//   2. настоящий сервер этого же коммита, OFFLINE=1, память вместо Redis, часы заморожены на DEMO_NOW (clock.js);
//   3. обход адресов из manifest.js: каждый GET, который спрашивает страница, и все картинки — в файлы.
// Ответы сервера не пишутся руками: форма ответов верна по построению и сама следует за интерфейсом при каждой сборке.
//
// Что получается в DEMO_OUT (в репозитории это frontend/demo-data/, в git не кладётся, правила — в frontend/demo/router.js):
//   boot.json   { recordedAt, rec: { <ключ>: ответ }, lazy: { <ключ>: 'd/<хэш>.json' }, media: { <ключ>: 'm/<хэш>.<расш>' } }
//   d/*.json    ответы, которые страница берёт по мере надобности; одинаковые ответы — один файл
//   m/*         картинки: обложки и кадры игр — оригиналами (без ?w=), миниатюры галереи, моменты, снимки сейвов
//   play/*.html титульные экраны игр (frontend/demo/play/template.html), по одному на игру
//   hashes.txt  sha1 каждого файла: запись дважды даёт одинаковый список — проверка, что в данных нет случайного
// Ключи — reqKey и mediaKey из frontend/demo/keys.js (общие со страницей, своей копии правил здесь нет).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const manifest = require('./manifest.js');

const HERE = __dirname;
const API = process.env.DEMO_API || '/app/api';
const FE = process.env.DEMO_FE || '/frontend-demo';
const OUT = process.env.DEMO_OUT || '/tmp/demo-out';
// /games — папка игр по умолчанию в образе: в «Настройках» демо путь выглядит так же, как у человека с docker run
const LIB = process.env.DEMO_LIB || '/games';
const LIB_MARK = '.mimikin-demo-record';
const NOW = process.env.DEMO_NOW || '2026-10-03T12:00:00Z';
const PORT = process.env.DEMO_PORT || '3000';
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'demo';
const PASS = 'demo-pass-123';
const STRICT = process.env.DEMO_STRICT === '1';
const SERVER_LOG = process.env.DEMO_SERVER_LOG || '/tmp/demo-server.log';

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
// Имя файла: номер по порядку ключей и пять цифр от содержимого. В шестнадцатеричном имени среди 250 файлов почти наверняка
// нашлось бы сочетание, которое чистильщик примет за чужое слово; цифры такого не дадут, а новую картинку от старой в кэше
// Pages (10 минут) они отличают так же
const fileName = (n, buf) => `${String(n).padStart(4, '0')}-${String(parseInt(sha(buf).slice(0, 6), 16) % 100000).padStart(5, '0')}`;
// sha1 в hashes.txt — пятью десятичными числами: в шестнадцатеричной записи тоже встречаются «чужие» слова
const spaced = (hex) => hex.match(/.{8}/g).map((h) => String(parseInt(h, 16)).padStart(10, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => console.error(`[record] ${msg}`);
const warnings = [];
const warn = (msg) => { warnings.push(msg); say(`ВНИМАНИЕ: ${msg}`); };

// Одна среда для дочерних процессов: ничего от хозяина, всё нужное задано. TZ=UTC — «день» игры считается по местным часам
const childEnv = {
    PATH: process.env.PATH, HOME: '/tmp', TZ: 'UTC', DEMO_NOW: NOW, DEMO_API: API, GAMES_DIR: LIB,
    OFFLINE: '1', REDIS_URL: 'memory', PICTURE_PASS: '0', NODE_ENV: 'production', API_RATE_LIMIT: '5000', GAME_PORT: '3001', PORT,
};

function seedLibrary() {
    // Саму папку не трогаем: /games создала точка входа образа, а родитель ей не принадлежит нашему пользователю
    fs.mkdirSync(LIB, { recursive: true });
    // Чистим только пустую папку или ту, что мы сами записывали раньше (метка внутри): иначе на хосте с настоящей /games
    // запуск «как в CI» стёр бы чужие игры
    const mark = path.join(LIB, LIB_MARK);
    const left = fs.readdirSync(LIB);
    if (left.length && !fs.existsSync(mark)) throw new Error(`${LIB} не пуста и не наша (нет ${LIB_MARK}) — стирать не буду; укажите пустую папку в DEMO_LIB`);
    for (const name of left) fs.rmSync(path.join(LIB, name), { recursive: true, force: true });
    fs.writeFileSync(mark, 'tests/demo/record.js\n');
    for (const args of [
        [path.join(API, 'scripts/demo-library.js'), LIB, '--user', USER, '--password', PASS],
        [path.join(HERE, 'rich.js'), LIB],
    ]) {
        const run = spawnSync('node', args, { cwd: API, env: childEnv, encoding: 'utf8', timeout: 180000 });
        if (run.status !== 0) throw new Error(`${path.basename(args[0])} не отработал (код ${run.status}):\n${(run.stdout || '') + (run.stderr || '')}`.slice(-2000));
    }
}

async function startServer() {
    const log = fs.openSync(SERVER_LOG, 'w');
    const child = spawn('node', ['--require', path.join(HERE, 'clock.js'), 'server.js'], { cwd: API, env: childEnv, stdio: ['ignore', log, log] });
    let exited = false;
    child.on('exit', () => { exited = true; });
    for (let i = 0; i < 90; i++) {
        if (exited) break;
        try { if ((await fetch(`${BASE}/api/setup/status`)).ok) return child; } catch { /* ещё не слушает */ }
        await sleep(1000);
    }
    child.kill();
    throw new Error(`сервер не поднялся за 90 с:\n${fs.readFileSync(SERVER_LOG, 'utf8').slice(-1500)}`);
}

let cookie = '';
async function login() {
    const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    if (!r.ok || !cookie) throw new Error(`вход не удался: ${r.status}`);
}
async function get(url) {
    const r = await fetch(BASE + url, { headers: { cookie } });
    return { status: r.status, type: r.headers.get('content-type') || '', buf: Buffer.from(await r.arrayBuffer()) };
}
async function getJson(url) {
    const r = await get(url);
    if (r.status < 200 || r.status >= 300) return undefined;
    try { return JSON.parse(r.buf.toString('utf8')); } catch { return undefined; }
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/webm': 'webm', 'video/mp4': 'mp4' };
const extOf = (type, url) => EXT[type.split(';')[0].trim()] || path.extname(url.split('?')[0]).slice(1) || 'bin';

// Маршруты демо, если они уже есть: у них свой q, и страница читает по нему. Нет или пусто — работаем по manifest.js
async function loadRouter() {
    try {
        const router = await import(pathToFileURL(path.join(FE, 'router.js')).href);
        const handlers = (await import(pathToFileURL(path.join(FE, 'handlers/index.js')).href)).default || [];
        return router.createRouter(handlers);
    } catch (e) {
        warn(`маршруты демо не загрузились (${e.message.split('\n')[0]}): беру q из manifest.js`);
        return null;
    }
}

async function main() {
    const keys = await import(pathToFileURL(path.join(FE, 'keys.js')).href);
    const router = await loadRouter();
    say(`библиотека: ${LIB}, часы: ${NOW}`);
    seedLibrary();
    const server = await startServer();
    const watchdog = setTimeout(() => { say('запись не уложилась в 10 минут'); server.kill(); process.exit(3); }, 600000);
    try {
        await login();
        await record(keys, router);
    } finally {
        clearTimeout(watchdog);
        server.kill();
    }
}

async function record(keys, router) {
    const rec = {};      // ключ → ответ (для boot.json)
    const lazy = {};     // ключ → ответ (потом файлами)
    const media = {};    // ключ → { url, buf, ext }
    const missed = [];
    const put = (entry, url, body) => {
        const [pathname, search = ''] = url.split('?');
        const hit = router?.match('GET', pathname);
        const q = hit?.route.kind === 'rec' ? hit.route.q : (entry.q || []);
        if (hit?.route.kind === 'rec' && entry.q && [...q].sort().join() !== [...entry.q].sort().join()) {
            const text = `${pathname}: q маршрута [${q}] не совпал с manifest.js [${entry.q}]`;
            if (STRICT) throw new Error(text);
            warn(text);
        }
        const key = keys.reqKey(pathname, keys.queryOf(search), q);
        // Маршрут может не различать вопросы, которые различает manifest.js (trash и trash?count=1 при q: []): тогда
        // остаётся первый, самый общий — он идёт в списке первым
        const into = entry.boot ? rec : lazy;
        if (!(key in into)) into[key] = manifest.scrub(pathname, body);
    };
    const one = async (entry, url) => {
        const body = await getJson(url);
        // null — тоже ответ (journal/…/room пуст, пока игру не запускали); нет ответа — undefined
        if (body === undefined) { missed.push(url); return undefined; }
        put(entry, url, body);
        return body;
    };
    const withAsks = (entry) => {
        const asks = entry.asks || [{}];
        return asks.map((a) => {
            const qs = new URLSearchParams(a).toString();
            return qs ? `${entry.path}?${qs}` : entry.path;
        });
    };

    // ---- общие ответы
    const bodies = {};
    for (const entry of manifest.GLOBAL) {
        for (const url of withAsks(entry)) {
            const body = await one(entry, url);
            if (body !== undefined && url === entry.path) bodies[entry.path] = body;
        }
    }
    const games = bodies['/api/games'];
    if (!Array.isArray(games) || games.length !== manifest.MUST.games) throw new Error(`игр ${games?.length}, ждали ${manifest.MUST.games}`);
    const shelved = games.filter((g) => g.shelf);
    if (shelved.length !== manifest.MUST.shelved) throw new Error(`на полке ${shelved.length}, ждали ${manifest.MUST.shelved}`);
    if (bodies['/api/wishlist']?.items?.length !== manifest.MUST.wishlist) throw new Error('«Отложенных» не пять');
    if (bodies['/api/favorites']?.length !== manifest.MUST.favorites) throw new Error(`избранных ${bodies['/api/favorites']?.length}, ждали ${manifest.MUST.favorites}`);
    const people = (bodies['/api/users'] || []).filter((u) => !u.isOwner);
    if (people.length !== manifest.MUST.users) throw new Error(`людей кроме владельца ${people.length}, ждали ${manifest.MUST.users}`);

    // ---- по играм
    const mediaUrls = new Set();
    const addMedia = (url) => { if (url) mediaUrls.add(url); };
    for (const g of games) {
        addMedia(`/${g.cover}`);
        for (const s of g.screens || []) addMedia(`/${s}`);
        for (const entry of manifest.PER_GAME) {
            const asks = entry.ask ? entry.ask(g.id) : null;
            const url = entry.path.replace('{id}', encodeURIComponent(g.id)) + (asks ? `?${new URLSearchParams(asks)}` : '');
            if (entry.gallery) {
                // Галерея собирается при первом вопросе: ждём, пока будет готова
                let body = null;
                for (let i = 0; i < 60; i++) {
                    body = await getJson(url);
                    if (body?.state === 'ready' || body === undefined) break;
                    await sleep(500);
                }
                if (body === undefined) { missed.push(url); continue; }
                if (body.state !== 'ready') throw new Error(`галерея ${g.id} не собралась: ${body.state}`);
                put(entry, url, body);
                for (const album of body.albums || []) {
                    for (const f of album.files || []) {
                        addMedia(`/api/gallery/${encodeURIComponent(g.id)}/thumb?f=${encodeURIComponent(f)}`);
                        addMedia(`/api/gallery/${encodeURIComponent(g.id)}/image?f=${encodeURIComponent(f)}`);
                    }
                }
                continue;
            }
            const body = await one(entry, url);
            if (body === undefined) continue;
            if (entry.path === '/api/marks/{id}') {
                for (const m of body) {
                    if (m.thumb) addMedia(`/api/marks/${encodeURIComponent(g.id)}/${m.id}/thumb`);
                    if (m.full || m.thumb) addMedia(`/api/marks/${encodeURIComponent(g.id)}/${m.id}/shot`);
                }
            }
            if (entry.path === '/api/saves/history/{id}') {
                for (const slot of body.slots || []) if (slot.shot) addMedia(`/api/saves/shot/${encodeURIComponent(g.id)}?key=${encodeURIComponent(slot.key)}`);
            }
        }
    }
    for (const u of people) for (const entry of manifest.PER_USER) await one(entry, entry.path.replace('{id}', encodeURIComponent(u.id)));

    // ---- картинки: ключ — mediaKey, файл назван по содержимому (одинаковые кадры в разных играх лежат один раз)
    for (const url of [...mediaUrls].sort()) {
        const r = await get(url);
        if (r.status !== 200) { missed.push(url); continue; }
        media[keys.mediaKey(url)] = { buf: r.buf, ext: extOf(r.type, url) };
    }

    // ---- запись на диск
    fs.rmSync(OUT, { recursive: true, force: true });
    for (const d of ['d', 'm', 'play']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
    const files = new Map();     // относительный путь → содержимое
    // Одинаковое содержимое — один файл (пустые списки, одни и те же кадры в разных играх)
    const placed = new Map();
    const place = (dir, ext, data) => {
        const id = `${dir}:${ext}:${sha(data)}`;
        if (!placed.has(id)) {
            const rel = `${dir}/${fileName(placed.size + 1, Buffer.from(data))}.${ext}`;
            placed.set(id, rel);
            files.set(rel, data);
        }
        return placed.get(id);
    };
    const lazyIndex = {};
    for (const key of Object.keys(lazy).sort()) lazyIndex[key] = place('d', 'json', JSON.stringify(lazy[key]));
    const mediaIndex = {};
    for (const key of Object.keys(media).sort()) mediaIndex[key] = place('m', media[key].ext, media[key].buf);
    // Титульные экраны: по игре, кроме тех, что на полке (играть в них нечем)
    const template = fs.readFileSync(path.join(FE, 'play/template.html'), 'utf8');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    for (const g of games.filter((x) => !x.shelf)) {
        const cover = mediaIndex[keys.mediaKey(`/${g.cover}`)];
        if (!cover) throw new Error(`у ${g.id} нет обложки в записи`);
        files.set(`play/${g.id}.html`, template.replace(/\{\{COVER\}\}/g, `../${cover}`).replace(/\{\{TITLE\}\}/g, esc(g.displayTitle || g.title)).replace(/\{\{DEV\}\}/g, esc(g.developer || '')));
    }
    const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    files.set('boot.json', JSON.stringify({ recordedAt: Date.parse(NOW), rec: sorted(Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v]))), lazy: lazyIndex, media: mediaIndex }));
    for (const [rel, data] of files) fs.writeFileSync(path.join(OUT, rel), data);
    const hashes = [...files.keys()].sort().map((rel) => `${spaced(sha(files.get(rel)))}  ${rel}`).join('\n');
    fs.writeFileSync(path.join(OUT, 'hashes.txt'), `${hashes}\n`);

    // ---- проверки и итог
    const leaks = [...files].filter(([rel, data]) => /\.(json|html)$/.test(rel) && /\/tmp\/demo|\/app\/api/.test(String(data)));
    if (leaks.length) throw new Error(`в данных путь контейнера: ${leaks.map(([rel, data]) => `${rel}: …${/.{0,60}(\/tmp\/demo|\/app\/api).{0,60}/.exec(String(data))[0]}…`).join('\n')}`);
    const size = (pred) => [...files].filter(([rel]) => pred(rel)).reduce((n, [, d]) => n + Buffer.byteLength(d), 0);
    const bootText = files.get('boot.json');
    say(`файлов ${files.size}; boot.json ${Buffer.byteLength(bootText)} Б (gz ${zlib.gzipSync(bootText).length}), d/ ${size((r) => r.startsWith('d/'))} Б, m/ ${size((r) => r.startsWith('m/'))} Б, play/ ${size((r) => r.startsWith('play/'))} Б`);
    say(`inline ${Object.keys(rec).length} ключей, lazy ${Object.keys(lazyIndex).length}, картинок ${Object.keys(mediaIndex).length}`);
    if (missed.length) say(`не записано (не 2xx): ${missed.length}${process.env.DEMO_VERBOSE ? `\n  ${missed.join('\n  ')}` : ' (DEMO_VERBOSE=1 — список)'}`);
    // Маршруты демо с видом rec, у которых не записан даже основной ключ, — страница ответит 404 «не записан»
    if (router) {
        const known = new Set([...Object.keys(rec), ...Object.keys(lazyIndex)]);
        for (const route of router.routes?.filter?.((x) => x.kind === 'rec' && x.method === 'GET') || []) {
            const base = route.template;
            if (!base.includes(':') && !known.has(base) && ![...known].some((k) => k.startsWith(`${base}?`))) warn(`rec-маршрут ${base} в записи не найден`);
        }
    }
    if (STRICT && warnings.length) throw new Error(`предупреждений: ${warnings.length} (DEMO_STRICT=1)`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
