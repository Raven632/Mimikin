// Сверка демо с настоящим сервером: одни и те же запросы идут и на сервер этого же коммита (на демо-библиотеке, как при
// записи), и в таблицу демо, которая отвечает из записанных файлов. Сравниваются код ответа и форма тела (какие поля
// и какого вида), а не значения: время, случайные ключи и размеры у сервера свои.
// Зачем: запись берёт ответы у сервера сама, а вот то, что демо считает само (изменение игры, корзина, люди, подборки),
// написано руками — и тихо разойдётся с сервером, когда тот поменяет ответ. Здесь это видно сразу.
// Запуск из папки api (нужны её пакеты), после tests/demo/record.sh или record.js и сборки данных:
//   node --test --test-force-exit ../tests/demo/contract.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const API = path.join(ROOT, 'api');
const DATA = process.env.DEMO_DATA || path.join(ROOT, 'frontend/demo-data');
const PORT = process.env.CONTRACT_PORT || '3057';
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'demo';
const PASS = 'demo-pass-123';
const NOW = process.env.DEMO_NOW || '2026-10-03T12:00:00Z';

const { dispatch } = await import(pathToFileURL(path.join(ROOT, 'frontend/demo/table.js')).href);
const { createStore } = await import(pathToFileURL(path.join(ROOT, 'frontend/demo/store.js')).href);
const { shiftTimes } = await import(pathToFileURL(path.join(ROOT, 'frontend/demo/timeShift.js')).href);
const { createRequire } = await import('node:module');
const manifest = createRequire(import.meta.url)(path.join(HERE, 'manifest.js'));

// В Node нет sessionStorage; вход и выход демо держат флаг в нём
const mem = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};

const boot = JSON.parse(fs.readFileSync(path.join(DATA, 'boot.json'), 'utf8'));
const warns = [];
const events = [];
const makeStore = () => createStore({
  boot: structuredClone(boot),
  fetchJson: async (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')),
});
let store = makeStore();
const env = () => ({ store, warn: (m) => warns.push(m), emit: (e) => events.push(e), now: () => Date.now(), lang: 'en' });

// ---------- настоящий сервер
let server;
let lib;
let G; // идентификаторы игр для сценариев
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  lib = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-lib-'));
  const childEnv = {
    PATH: process.env.PATH, HOME: lib, TZ: 'UTC', DEMO_NOW: NOW, GAMES_DIR: lib, OFFLINE: '1', REDIS_URL: 'memory',
    PICTURE_PASS: '0', NODE_ENV: 'production', API_RATE_LIMIT: '5000', GAME_PORT: '3058', PORT,
  };
  for (const args of [
    [path.join(API, 'scripts/demo-library.js'), lib, '--user', USER, '--password', PASS],
    [path.join(HERE, 'rich.js'), lib],
  ]) {
    const run = spawnSync('node', args, { cwd: API, env: childEnv, encoding: 'utf8', timeout: 180000 });
    assert.equal(run.status, 0, `${path.basename(args[0])}: ${(run.stdout || '') + (run.stderr || '')}`.slice(-1500));
  }
  const log = fs.openSync(path.join(lib, '..', `contract-server-${process.pid}.log`), 'w');
  server = spawn('node', ['--require', path.join(HERE, 'clock.js'), 'server.js'], { cwd: API, env: childEnv, stdio: ['ignore', log, log] });
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/setup/status`)).ok; } catch { await sleep(1000); }
  }
  assert.ok(up, 'сервер не поднялся за 90 с');
  await realLogin();
  // Как в record.js (settle): через 3 с сервер дочитывает «где остановился» из сейвов. Сравнивать раньше — значит
  // сравнивать то с прогрессом, то без, смотря по скорости машины
  const logText = () => fs.readFileSync(path.join(lib, '..', `contract-server-${process.pid}.log`), 'utf8');
  for (let i = 0; i < 60 && !logText().includes('[Progress]'); i++) await sleep(500);
  assert.ok(logText().includes('[Progress]'), 'сервер не дочитал прогресс из сейвов за 30 с');
  const list = await gamesNow();
  const plain = list.filter((g) => !g.shelf);
  G = { a: plain[0].id, b: plain[1].id, c: plain[2].id, d: plain[3].id };
});

after(() => {
  server?.kill();
  if (lib) fs.rmSync(lib, { recursive: true, force: true });
});

async function realLogin() {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(r.ok && cookie, `вход на настоящем сервере: ${r.status}`);
}

async function real(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: r.status, body: json };
}
const fake = (method, url, body) => dispatch({ method, url, body }, env());

// ---------- форма ответа
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
// Все пути поля → виды значений. Массив сливает форму всех своих элементов (путь «[]»); null ничего не говорит о виде
function paths(v, p = '', out = new Map()) {
  const k = kind(v);
  if (k === 'null') return out;
  if (!out.has(p)) out.set(p, new Set());
  out.get(p).add(k);
  if (k === 'array') for (const x of v) paths(x, `${p}[]`, out);
  else if (k === 'object') for (const [key, x] of Object.entries(v)) paths(x, `${p}.${key}`, out);
  return out;
}
function shapeDiff(a, b) {
  const A = paths(a);
  const B = paths(b);
  const out = [];
  for (const [p, kinds] of A) {
    if (!B.has(p)) { if (![...B.keys()].some((q) => p.startsWith(`${q}[]`) && !B.has(`${q}[]`))) out.push(`у сервера есть ${p || '(корень)'}, у демо нет`); continue; }
    const other = B.get(p);
    if (![...kinds].some((x) => other.has(x))) out.push(`${p || '(корень)'}: сервер ${[...kinds]}, демо ${[...other]}`);
  }
  for (const p of B.keys()) {
    if (!A.has(p) && ![...A.keys()].some((q) => p.startsWith(`${q}[]`) && !A.has(`${q}[]`))) out.push(`у демо есть ${p || '(корень)'}, у сервера нет`);
  }
  return out;
}

// Один запрос на обе стороны. url может быть функцией от стороны: ключи, которые сервер выдаёт случайными, у каждой свои
async function both(method, url, body, { ignore } = {}) {
  const u = (side) => (typeof url === 'function' ? url(side) : url);
  const r = await real(method, u('real'), typeof body === 'function' ? body('real') : body);
  const f = await fake(method, u('fake'), typeof body === 'function' ? body('fake') : body);
  const where = `${method} ${u('real')}`;
  assert.equal(f.status, r.status, `${where}: код сервера ${r.status}, демо ${f.status} (${JSON.stringify(f.body)?.slice(0, 160)})`);
  const bad = shapeDiff(r.body, f.body).filter((x) => !(ignore && ignore.test(x)));
  assert.deepEqual(bad, [], `${where}: форма ответа разошлась`);
  return { real: r.body, fake: f.body };
}

async function gamesNow() {
  return (await real('GET', '/api/games')).body;
}

// ---------- чтение
test('чтение: записанные ответы по форме те же, что у сервера', async () => {
  for (const entry of manifest.GLOBAL) {
    for (const ask of entry.asks || [{}]) {
      const qs = new URLSearchParams(ask).toString();
      await both('GET', qs ? `${entry.path}?${qs}` : entry.path, undefined, { ignore: entry.same });
    }
  }
  for (const entry of manifest.PER_GAME) {
    if (entry.gallery) continue; // собирается при первом вопросе: сервер сначала отвечает «building»
    const ask = entry.ask ? `?${new URLSearchParams(entry.ask(G.a))}` : '';
    await both('GET', entry.path.replace('{id}', encodeURIComponent(G.a)) + ask);
  }
});

test('сцены: плеер и поиск по репликам', async () => {
  // Сцена и слова — из записи (там ровно то, что у сервера на этой же библиотеке); сервер должен ответить тем же видом
  const rows = (await fake('GET', '/api/scenes?kind=scenes')).body.games.flatMap((g) => g.rows.map((r) => ({ id: g.id, key: r.key, n: r.n })));
  assert.ok(rows.length, 'в записи нет ни одной сцены');
  const one = rows[0];
  for (const ui of ['en', 'ru', 'de']) {
    for (let i = 0; i < 60 && (await real('GET', `/api/gallery/${one.id}`)).body?.state !== 'ready'; i++) await sleep(500);
    await both('GET', `/api/gallery/${encodeURIComponent(one.id)}/scene?key=${encodeURIComponent(one.key)}&n=${one.n}&ui=${ui}`);
  }
  // Поиск ждёт, пока сервер соберёт реплики всех игр: до того он отвечает «ещё собирается» без результатов
  for (let i = 0; i < 60; i++) {
    const r = await real('GET', `/api/lines/search?q=${manifest.LINE_WORDS[0]}&limit=60`);
    if (r.body?.games?.length) break;
    await sleep(500);
  }
  for (const word of manifest.LINE_WORDS.slice(0, 3)) await both('GET', `/api/lines/search?q=${word}&limit=60`, undefined, { ignore: /indexed|library|building/ });
  // Слишком короткое слово: тот же отказ (слово без записи — только у демо, сервер просто ничего не найдёт)
  await both('GET', '/api/lines/search?q=ab&limit=60');
});

test('время: ни одно записанное время не осталось без сдвига', () => {
  // Сдвигаем копию на заведомо большую дельту: число из окна «год до записи» (и два дня после), которое не сдвинулось,
  // лежит в поле, которого нет в списке timeShift.js
  const lo = boot.recordedAt - 365 * 86400000;
  const hi = boot.recordedAt + 2 * 86400000;
  const stuck = [];
  const files = Object.values(boot.lazy || {}).map((f) => [f, JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))]);
  const bodies = [...Object.entries(boot.rec), ...Object.entries(boot.lazy || {}).map(([k], i) => [k, files[i][1]])];
  const walk = (raw, moved, at) => {
    if (Array.isArray(raw)) raw.forEach((x, i) => walk(x, moved[i], `${at}[${i}]`));
    else if (raw && typeof raw === 'object') for (const k of Object.keys(raw)) walk(raw[k], moved[k], `${at}.${k}`);
    else if (typeof raw === 'number' && raw >= lo && raw <= hi && moved === raw) stuck.push(at);
  };
  for (const [key, body] of bodies) {
    if (key === '/api/play-days') continue; // дни считаются по-другому (shiftPlayDays), в них нет миллисекунд
    walk(body, shiftTimes(structuredClone(body), 10 * 365 * 86400000), key);
  }
  assert.deepEqual(stuck.slice(0, 10), [], 'поля со временем вне списка timeShift.js');
});

// ---------- изменения: тот же запрос на сервер и в демо, потом чтение
test('изменение игры, ряд, подборки', async () => {
  await both('POST', `/api/games/${G.a}/meta`, { rating: 4, favorite: true, notes: 'проверка', status: 'playing' });
  await both('POST', `/api/games/${G.a}/meta`, { lists: ['Контракт', 'Ночные'] });
  await both('POST', `/api/games/${G.a}/series`, { series: 'Проверочный ряд' });
  await both('GET', '/api/games');
  await both('POST', '/api/games/lists/change', { from: 'Контракт', to: 'Договор' });
  await both('POST', '/api/games/lists/change', { from: 'Договор' });
  await both('POST', `/api/games/${G.b}/edit`, { title: 'Проверочное название', developer: 'Студия' });
  await both('POST', `/api/games/${G.a}/meta`, { status: 'nonsense' });
  await both('GET', '/api/games');
});

test('полка и корзина: на полку, в корзину, обратно, насовсем', async () => {
  const shelved = await both('POST', `/api/games/${G.c}/shelf`);
  await both('GET', '/api/games/trash');
  await both('GET', '/api/games/trash?count=1');
  await both('GET', '/api/games');
  await both('POST', (s) => `/api/games/trash/${encodeURIComponent((s === 'real' ? shelved.real : shelved.fake).trashKey)}/restore`);
  const gone = await both('DELETE', `/api/games/${G.d}`);
  await both('GET', '/api/games/trash');
  await both('DELETE', (s) => `/api/games/trash/${encodeURIComponent((s === 'real' ? gone.real : gone.fake).trashKey)}`);
  await both('GET', '/api/games/trash?count=1');
  await both('GET', '/api/games');
});

test('избранные кадры, моменты и сохранения', async () => {
  // Сервер берёт в избранное только файл из галереи игры: возьмём первый из записанной
  // и пока галерея не собрана (первый вопрос запускает сборку), сервер ответит «bad-file»
  for (let i = 0; i < 60 && (await real('GET', `/api/gallery/${G.a}`)).body?.state !== 'ready'; i++) await sleep(500);
  const file = (await fake('GET', `/api/gallery/${G.a}`)).body.albums.flatMap((a) => a.files)[0];
  assert.ok(file, 'в записи нет ни одного кадра галереи');
  await both('PUT', '/api/favorites', { game: G.a, file });
  await both('GET', `/api/favorites?game=${G.a}`);
  await both('DELETE', `/api/favorites?game=${G.a}&f=${encodeURIComponent(file)}`);
  await both('GET', '/api/favorites');
  const marks = (await real('GET', `/api/marks/${G.a}`)).body;
  const slots = (await real('GET', `/api/saves/history/${G.a}`)).body;
  if (marks.length) {
    await both('PATCH', `/api/marks/${G.a}/${marks[0].id}`, { label: 'Переименовано' });
    await both('GET', `/api/marks/${G.a}`);
    await both('DELETE', `/api/marks/${G.a}/${marks[0].id}`);
    await both('GET', `/api/marks/${G.a}`);
  }
  if (slots.slots?.length && slots.slots[0].versions?.length) {
    await both('POST', `/api/saves/history/${G.a}/restore`, { key: slots.slots[0].key, version: slots.slots[0].versions[0].id });
    await both('GET', `/api/saves/history/${G.a}`);
  }
});

test('люди: добавить, права, состояние, список игр', async () => {
  const made = await both('POST', '/api/users', { name: 'Проверка', password: 'abcd1234' }, { ignore: /password/ });
  const id = (s) => (s === 'real' ? made.real : made.fake).id;
  await both('PUT', (s) => `/api/users/${id(s)}/rights`, { request: false, download: true, upload: false, view: true });
  await both('POST', (s) => `/api/users/${id(s)}/state`, { state: 'locked' });
  await both('GET', '/api/users');
  await both('GET', (s) => `/api/users/${id(s)}/games`);
  await both('PUT', (s) => `/api/users/${id(s)}/games`, { limited: true, games: [G.a] });
  await both('GET', (s) => `/api/users/${id(s)}/games`);
  await both('POST', '/api/users', { name: 'проверка', password: 'abcd1234' });
});

test('Найти и «Отложенное»: отложить, убрать, не предлагать', async () => {
  const item = { source: 'itch', url: 'https://mimikin-contract.itch.io/test', title: 'Contract', info: { title: 'Contract' } };
  const added = await both('POST', '/api/wishlist', item);
  await both('GET', '/api/wishlist');
  await both('DELETE', (s) => `/api/wishlist?key=${encodeURIComponent((s === 'real' ? added.real : added.fake).key)}`);
  await both('GET', '/api/wishlist');
  await both('POST', '/api/recommend/dismiss', { key: G.a });
  await both('GET', '/api/recommend/dismissed');
  await both('POST', '/api/recommend/dismiss', { key: G.a, undo: true });
  await both('GET', '/api/recommend/dismissed');
});

test('настройки, запуск, вход и выход', async () => {
  await both('POST', '/api/settings/options', { name: 'disk_warn_gb', value: 20 }, { ignore: /./ });
  await both('POST', '/api/settings/favorite-tags', { tags: ['тест', 'тест', ' '] });
  await both('POST', '/api/settings/known-langs', { langs: ['en'] });
  await both('GET', '/api/settings/known-langs');
  // Запуск: сервер поднимает игру на втором порту, демо отдаёт готовую страницу — важна только форма, поля mode и origin
  const run = await real('POST', `/api/play/${G.a}`);
  const mine = await fake('POST', `/api/play/${G.a}`);
  assert.equal(mine.status, run.status, 'запуск игры: код');
  for (const k of ['mode', 'origin', 'path']) assert.ok(k in mine.body, `запуск игры: у демо нет «${k}»`);
  await both('POST', '/api/logout');
  await both('GET', '/api/me');
  await realLogin();
  await both('POST', '/api/login', { username: USER, password: PASS });
  await both('GET', '/api/me');
});
