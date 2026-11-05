// Обработчики демо без браузера: вход, поля игры, полка и корзина, подборки, люди, избранное, запуск, заметки.
// Данные — маленькая выдуманная запись прямо здесь, настоящая (frontend/demo-data) нужна только последнему тесту.
// Запуск: node --test --test-force-exit tests/demo/handlers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { routes, dispatch } from '../../frontend/demo/table.js';
import { createStore } from '../../frontend/demo/store.js';
import { extendLocale, noteText, LINE_WORDS, PICTURE_WORDS, pictureWord, wordsHint } from '../../frontend/demo/texts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = 2_000_000_000_000;

// В Node нет sessionStorage: подставляем простой, чтобы проверить вход и выход
const memory = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); },
  clear: () => memory.clear(),
};

const game = (id, n, extra = {}) => ({
  id, title: id, displayTitle: id, cover: `_media/${id}/c.png`, number: n, size: 100, playtime: 60, rating: 0, status: '', favorite: false,
  notes: '', lists: [], series: '', shelf: null, link: '', developer: '', language: '', releaseDate: '', ...extra,
});
const owner = { id: 'owner', name: 'demo', role: 'owner', isOwner: true, state: '', rights: { request: true, download: true, upload: true, view: true } };
const guest = { id: 'ugu', name: 'Mira', role: 'user', isOwner: false, state: '', rights: { request: false, download: false, upload: false, view: false } };

function fresh() {
  const boot = {
    recordedAt: NOW,
    rec: {
      '/api/me': { id: 'owner', name: 'demo', isOwner: true },
      '/api/games': [
        game('A', 1, { lists: ['Cozy', 'Night'] }), game('B', 2, { lists: ['Cozy'] }), game('C', 3),
        game('S', 4, { shelf: { at: NOW - 1000, key: `${NOW - 1000}-S`, until: NOW + 1e9 } }),
      ],
      '/api/games/trash': { items: [{ key: `${NOW - 1000}-S`, id: 'S', title: 'S', cover: null, deletedAt: NOW - 1000, purgeAt: NOW + 1e9, daysLeft: 20, size: 1, playtime: 0, taken: false, vanished: false, shelf: true }] },
      '/api/users': [{ ...owner }, { ...guest }],
      '/api/wishlist': { items: [{ key: 'itch:https://a.invalid/x', source: 'itch', url: 'https://a.invalid/x', info: {}, addedAt: NOW }] },
      '/api/favorites': [{ game: 'A', file: 'f1.png', kind: '', at: NOW }, { game: 'S', file: 'f2.png', kind: '', at: NOW }],
      '/api/settings': { options: { disk_warn_gb: { value: 10, def: 10, min: 1, max: 100 }, update_check: { value: true, def: true }, picture_analysis: { value: false, def: false } } },
      '/api/recommend/library': { cold: false, total: 2, items: [{ id: 'A' }, { id: 'B' }] },
      '/api/recommend/dismissed': { count: 0 },
      '/api/pictures/hidden': { tags: [] },
      '/api/errors': { games: [{ id: 'A' }] },
      '/api/saves/history/A': { slots: [{ key: 'F1', current: { at: NOW - 5, size: 9, summary: { level: 5 } }, versions: [{ id: 'v1', at: NOW - 50, size: 8, reason: 'saved', summary: { level: 3 } }] }] },
      '/api/marks/A': [{ id: 'm1', kind: 'auto', label: 'one' }, { id: 'm2', kind: 'mark', label: 'two' }],
      '/api/settings/favorite-tags': { tags: [] },
    },
    lazy: { '/api/users/ugu/games': 'd/ugu.json' },
  };
  const store = createStore({ boot, fetchJson: async () => ({ limited: true, games: ['A'] }), now: () => NOW });
  const warns = [];
  const events = [];
  const env = { store, warn: (m) => warns.push(m), emit: (e) => events.push(e), now: () => NOW, lang: 'en' };
  const call = (method, url, body) => dispatch({ method, url, body }, env);
  return { store, warns, events, call };
}

const ids = async (store) => (await store.read('/api/games')).map((g) => g.id);

test('вход: после выхода /api/me и /api/games отвечают 401, после входа — снова 200', async () => {
  memory.clear();
  const { call } = fresh();
  assert.equal((await call('GET', '/api/me')).status, 200);
  assert.equal((await call('POST', '/api/logout')).status, 200);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/games')).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'x', password: 'y' })).body.success, true);
  assert.equal((await call('GET', '/api/games')).status, 200);
  memory.clear();
});

test('поля игры: статус, оценка, избранное, заметка, подборки; чужой статус и длинная заметка — 400; страница узнаёт об изменении', async () => {
  const { call, store, events } = fresh();
  const res = await call('POST', '/api/games/A/meta', { status: 'done', rating: 4, favorite: true, notes: 'hi', lists: ['X', ' X ', 'Y'] });
  assert.equal(res.status, 200);
  const a = (await store.read('/api/games')).find((g) => g.id === 'A');
  assert.deepEqual([a.status, a.rating, a.favorite, a.notes, a.lists], ['done', 4, true, 'hi', ['X', 'Y']]);
  assert.ok(events.includes('library-changed'));
  assert.equal((await call('POST', '/api/games/A/meta', { status: 'zzz' })).status, 400);
  assert.equal((await call('POST', '/api/games/A/meta', { notes: 'x'.repeat(5001) })).status, 400);
  assert.equal((await call('POST', '/api/games/nope/meta', { rating: 1 })).status, 404);
});

test('серия: имя пишется, пустое без букв — 400', async () => {
  const { call, store } = fresh();
  assert.equal((await call('POST', '/api/games/B/series', { series: 'Waves' })).body.series, 'Waves');
  assert.equal((await store.read('/api/games')).find((g) => g.id === 'B').series, 'Waves');
  assert.equal((await call('POST', '/api/games/B/series', { series: '---' })).status, 400);
});

test('подборки: переименование сливает одинаковые, без to — убирает', async () => {
  const { call, store } = fresh();
  assert.equal((await call('POST', '/api/games/lists/change', { from: 'Night', to: 'Cozy' })).body.changed, 1);
  assert.deepEqual((await store.read('/api/games')).find((g) => g.id === 'A').lists, ['Cozy']);
  assert.equal((await call('POST', '/api/games/lists/change', { from: 'Cozy' })).body.changed, 2);
  assert.deepEqual((await store.read('/api/games')).find((g) => g.id === 'B').lists, []);
  assert.equal((await call('POST', '/api/games/lists/change', { from: '' })).status, 400);
});

test('полка и корзина: на полку и обратно, удаление и возврат на прежнее место, стирание файлов с полки', async () => {
  const { call, store } = fresh();
  const shelved = await call('POST', '/api/games/B/shelf');
  assert.equal(shelved.status, 200);
  assert.ok((await store.read('/api/games')).find((g) => g.id === 'B').shelf);
  assert.equal((await call('GET', '/api/games/trash?count=1')).body.count, 2);
  assert.equal((await call('POST', '/api/games/B/shelf')).status, 404, 'вторая полка подряд — игры уже нет на диске');
  assert.equal((await call('POST', `/api/games/trash/${shelved.body.trashKey}/restore`)).status, 200);
  assert.equal((await store.read('/api/games')).find((g) => g.id === 'B').shelf, null);

  const del = await call('DELETE', '/api/games/A');
  assert.deepEqual(await ids(store), ['B', 'C', 'S']);
  const list = (await call('GET', '/api/games/trash')).body.items;
  assert.equal(list[0].id, 'A');
  assert.equal(list[0].shelf, false);
  assert.ok(list[0].daysLeft >= 29);
  assert.equal((await call('POST', `/api/games/trash/${del.body.trashKey}/restore`)).status, 200);
  assert.deepEqual(await ids(store), ['A', 'B', 'C', 'S'], 'вернулась на своё место по номеру');
  assert.equal((await call('POST', `/api/games/trash/${del.body.trashKey}/restore`)).status, 404, 'вторично уже нечего');

  // файлы игры с полки стёрли: карточка остаётся на полке, но без ключа корзины
  const key = `${NOW - 1000}-S`;
  assert.equal((await call('DELETE', `/api/games/trash/${key}`)).status, 200);
  const card = (await store.read('/api/games')).find((g) => g.id === 'S');
  assert.equal(card.shelf.key, '');
  assert.equal((await call('GET', '/api/games/trash?count=1')).body.count, 0);
});

test('правка: поля пишутся; новая ссылка — заметка «поиск», но уже записанное остаётся', async () => {
  const { call, store } = fresh();
  const ok = await call('POST', '/api/games/C/edit', { title: ' New C ', developer: 'Dev', link: '' });
  assert.equal(ok.body.game.displayTitle, 'New C');
  assert.equal(ok.body.found, false);
  const refused = await call('POST', '/api/games/C/edit', { developer: 'Dev2', link: 'https://x.invalid/a' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.params.what, 'lookup');
  const c = (await store.read('/api/games')).find((g) => g.id === 'C');
  assert.deepEqual([c.developer, c.link], ['Dev2', 'https://x.invalid/a']);
});

test('запуск: страница игры лежит рядом (play/<id>.html), проверки сервера нет, игра на полке не запускается', async () => {
  const { call } = fresh();
  const res = await call('POST', '/api/play/A');
  assert.equal(res.body.mode, 'frame');
  assert.ok(res.body.path.endsWith('/play/A.html'));
  assert.equal(res.body.check, undefined);
  assert.equal((await call('POST', '/api/play/S')).status, 404);
});

test('люди: новый человек, занятое имя, права, закрытый вход, список игр; владельца этими адресами не тронуть', async () => {
  const { call, store, events } = fresh();
  const added = await call('POST', '/api/users', { name: 'Joe', password: 'abcd' });
  assert.equal(added.status, 200);
  assert.equal((await call('POST', '/api/users', { name: 'JOE', password: 'abcd' })).body.reason, 'name-taken');
  assert.equal((await call('POST', '/api/users', { name: 'Zed', password: 'ab' })).status, 400);
  assert.equal((await call('POST', '/api/users', { name: ' ', password: 'abcd' })).body.reason, 'name-bad');
  const rights = await call('PUT', `/api/users/${added.body.id}/rights`, { request: false, download: true, upload: false, view: true });
  assert.deepEqual(rights.body.rights, { request: false, download: true, upload: false, view: true });
  assert.equal((await call('PUT', `/api/users/${added.body.id}/rights`, { download: true })).status, 400);
  await call('POST', `/api/users/${added.body.id}/state`, { state: 'locked' });
  assert.equal((await store.read('/api/users')).find((p) => p.id === added.body.id).state, 'locked');
  assert.equal((await call('POST', '/api/users/owner/state', { state: 'locked' })).status, 404);
  // у записанной гостьи список игр из записи, у нового — все игры; сохранение проверяет игры
  assert.deepEqual((await call('GET', '/api/users/ugu/games')).body, { limited: true, games: ['A'] });
  assert.deepEqual((await call('GET', `/api/users/${added.body.id}/games`)).body, { limited: false, games: [] });
  assert.equal((await call('PUT', `/api/users/${added.body.id}/games`, { limited: true, games: ['nope'] })).body.reason, 'unknown-game');
  assert.equal((await call('PUT', `/api/users/${added.body.id}/games`, { limited: true, games: ['B', 'B'] })).body.games, 1);
  assert.deepEqual((await call('GET', `/api/users/${added.body.id}/games`)).body.games, ['B']);
  assert.equal((await call('POST', `/api/users/${added.body.id}/password`, { password: 'abcd' })).status, 409);
  assert.ok(events.includes('people-changed'));
});

test('избранные картинки: сердечко ставится и снимается, список игры считается из общего, игры на полке не видно', async () => {
  const { call } = fresh();
  assert.deepEqual((await call('GET', '/api/favorites')).body.map((f) => f.file), ['f1.png'], 'файл игры на полке скрыт');
  await call('PUT', '/api/favorites', { game: 'B', file: 'f3.png' });
  assert.deepEqual((await call('GET', '/api/favorites?game=B')).body.map((f) => f.file), ['f3.png']);
  assert.equal((await call('GET', '/api/favorites')).body.length, 2);
  await call('DELETE', '/api/favorites?game=B&f=f3.png');
  assert.equal((await call('GET', '/api/favorites?game=B')).body.length, 0);
  assert.equal((await call('PUT', '/api/favorites', { game: 'B' })).status, 400);
});

test('сейвы и моменты: возврат версии, переименование, «сохранить» и удаление момента', async () => {
  const { call } = fresh();
  assert.equal((await call('POST', '/api/saves/history/A/restore', { key: 'F1', version: 'v1' })).status, 200);
  const slot = (await call('GET', '/api/saves/history/A')).body.slots[0];
  assert.equal(slot.current.summary.level, 3);
  assert.equal(slot.versions[0].reason, 'restore', 'прежний сейв остался в списке');
  assert.equal(slot.versions[0].summary.level, 5);
  assert.equal((await call('POST', '/api/saves/history/A/restore', { key: 'F1', version: 'zzz' })).status, 404);
  assert.equal((await call('PATCH', '/api/marks/A/m1', { label: '  renamed  ' })).status, 200);
  await call('POST', '/api/marks/A/m1/keep');
  const marks = (await call('GET', '/api/marks/A')).body;
  assert.deepEqual([marks[0].label, marks[0].kind], ['renamed', 'mark']);
  assert.equal((await call('DELETE', '/api/marks/A/m2')).status, 200);
  assert.equal((await call('GET', '/api/marks/A')).body.length, 1);
  assert.equal((await call('DELETE', '/api/marks/A/m2')).status, 404);
});

test('настройки: параметр меняется в границах, разбор картинок и ключи — заметка', async () => {
  const { call, store } = fresh();
  assert.equal((await call('POST', '/api/settings/options', { name: 'disk_warn_gb', value: 20 })).status, 200);
  assert.equal((await store.read('/api/settings')).options.disk_warn_gb.value, 20);
  assert.equal((await call('POST', '/api/settings/options', { name: 'disk_warn_gb', value: 5000 })).status, 400);
  assert.equal((await call('POST', '/api/settings/options', { name: 'picture_analysis', value: true })).body.params.what, 'analysis');
  assert.equal((await call('POST', '/api/settings/deepl', { key: 'k' })).body.params.what, 'secrets');
  assert.equal((await call('POST', '/api/settings/update', {})).body.params.what, 'update');
  assert.deepEqual((await call('POST', '/api/settings/favorite-tags', { tags: ['a', 'a', ' ', 'b'] })).body.tags, ['a', 'b']);
});

test('«Не предлагать» убирает игру из подбора, счётчик растёт, «Вернуть» очищает; отложенные добавляются и убираются', async () => {
  const { call } = fresh();
  await call('POST', '/api/recommend/dismiss', { key: 'A' });
  const lib = (await call('GET', '/api/recommend/library')).body;
  assert.deepEqual([lib.items.map((i) => i.id), lib.total], [['B'], 1]);
  assert.equal((await call('GET', '/api/recommend/dismissed')).body.count, 1);
  await call('POST', '/api/recommend/dismiss', { key: 'A', undo: true });
  assert.equal((await call('GET', '/api/recommend/library')).body.items.length, 2);
  await call('POST', '/api/recommend/dismiss', { key: 'B' });
  await call('DELETE', '/api/recommend/dismissed');
  assert.equal((await call('GET', '/api/recommend/dismissed')).body.count, 0);

  const wish = await call('POST', '/api/wishlist', { source: 'itch', url: 'https://b.invalid/y', title: 'Y' });
  assert.equal(wish.body.key, 'itch:https://b.invalid/y');
  assert.equal((await call('GET', '/api/wishlist')).body.items.length, 2);
  assert.equal((await call('DELETE', `/api/wishlist?key=${encodeURIComponent(wish.body.key)}`)).body.removed, true);
  assert.equal((await call('POST', '/api/wishlist', { source: 'x', url: 'u' })).status, 400);
});

test('«Найти»: сайтов нет — отвечает как сервер без интернета', async () => {
  const { call } = fresh();
  const res = await call('GET', '/api/itch/latest?page=1');
  assert.deepEqual([res.status, res.body.reason], [503, 'offline']);
});

test('скрытые теги картинок и ошибки игр', async () => {
  const { call } = fresh();
  assert.deepEqual((await call('POST', '/api/pictures/hidden', { add: ['a', 'b'], remove: ['a'] })).body.tags, ['b']);
  assert.equal((await call('DELETE', '/api/errors/A')).status, 200);
  assert.deepEqual((await call('GET', '/api/errors')).body.games, []);
});

test('загрузки: список пуст, остальное — заметка «upload»; скачивание — «download»', async () => {
  const { call } = fresh();
  assert.deepEqual((await call('GET', '/api/games/upload/list')).body, []);
  assert.equal((await call('POST', '/api/games/upload/start', {})).body.params.what, 'upload');
  assert.equal((await call('GET', '/api/games/A/archive')).body.params.what, 'download');
  assert.equal((await call('GET', '/api/backup')).body.params.what, 'download');
});

test('тексты заметок: каждое «что» из маршрутов и обработчиков есть на ru, en и de (не общая заметка)', () => {
  const used = new Set(routes.filter((r) => r.kind === 'off').map((r) => r.what));
  const dir = path.join(here, '../../frontend/demo/handlers');
  for (const file of fs.readdirSync(dir)) {
    for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/\boff\('([a-z]+)'\)/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 8);
  const server = noteText('en', 'server');
  for (const lang of ['ru', 'en', 'de']) {
    for (const what of used) {
      const text = noteText(lang, what);
      assert.ok(text && text.length > 20, `${lang}: ${what}`);
      if (what !== 'server') assert.notEqual(text, noteText(lang, 'server'), `${lang}: ${what} показывает общую заметку`);
    }
    // extendLocale не трогает исходный объект и даёт функцию отказа и подсказку входа
    const t = { err_reason: { x: 'y' } };
    const out = extendLocale(lang, t);
    assert.equal(t.err_reason['demo-off'], undefined);
    assert.equal(out.err_reason.x, 'y');
    assert.equal(out.err_reason['demo-off']({ what: 'upload' }), noteText(lang, 'upload'));
    assert.ok(out.demo_login_hint && out.find_offline && out.find_offline_empty);
    // Слова подсказки названы на языке посетителя и перечислены все
    assert.equal(out.lines_failed, wordsHint(lang, 'lines'));
    for (const w of LINE_WORDS) assert.ok(wordsHint(lang, 'lines').includes(w));
    const pics = wordsHint(lang, 'pictures');
    for (const w of PICTURE_WORDS) assert.equal(pictureWord(lang, w), w);
    assert.equal(pics.split(': ')[1].split('. ')[0].split(', ').length, PICTURE_WORDS.length);
  }
  assert.equal(pictureWord('ru', ' Маяк '), 'lighthouse');
  assert.equal(pictureWord('de', 'leuchtturm'), 'lighthouse');
  assert.equal(pictureWord('en', 'dragon'), null);
  assert.notEqual(noteText('ru', 'upload'), noteText('en', 'upload'));
  assert.equal(noteText('en', 'zzz'), server, 'неизвестное «что» — общая заметка, а не пустое окно');
});

// Настоящая запись (tests/demo/record.sh кладёт её в frontend/demo-data, в git её нет): на каждый записанный маршрут
// у каждой игры есть ответ — иначе страница получит 404 и предупреждение [demo] unrecorded
const bootFile = path.join(here, '../../frontend/demo-data/boot.json');
test('запись: у каждого записанного маршрута есть ответ для каждой игры', { skip: !fs.existsSync(bootFile) && 'нет frontend/demo-data: сначала tests/demo/record.sh' }, async () => {
  const data = path.dirname(bootFile);
  const boot = JSON.parse(fs.readFileSync(bootFile, 'utf8'));
  const store = createStore({ boot, fetchJson: async (f) => JSON.parse(fs.readFileSync(path.join(data, f), 'utf8')), now: () => boot.recordedAt });
  const warns = [];
  const env = { store, warn: (m) => warns.push(m), emit: () => {}, now: () => boot.recordedAt, lang: 'en' };
  const gameIds = (await store.read('/api/games')).map((g) => g.id);
  const missing = [];
  for (const route of routes.filter((r) => r.kind === 'rec' && r.method === 'GET')) {
    const urls = route.template.includes(':id') ? gameIds.map((id) => route.template.replace(':id', id)) : [route.template];
    // Плеер сцены просит альбом и язык: его проверяет тест «сцены» ниже
    if (route.template.endsWith('/scene')) continue;
    const query = route.q.length ? `?${route.q.map((k) => `${k}=${k === 'kind' ? 'scenes' : '1'}`).join('&')}` : '';
    for (const url of urls) if ((await dispatch({ method: 'GET', url: url + query }, env)).status !== 200) missing.push(url + query);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(warns, []);
});

// Сцены, реплики и слова картинок на настоящей записи. Слова записи берёт из manifest.js: список там и в texts.js один и тот же
test('сцены и поиск: фильтры, очередь, реплики по слову и игре, слова картинок, плеер сцены, игра на полке исчезает',
  { skip: !fs.existsSync(bootFile) && 'нет frontend/demo-data: сначала tests/demo/record.sh' }, async () => {
    const data = path.dirname(bootFile);
    const boot = JSON.parse(fs.readFileSync(bootFile, 'utf8'));
    const store = createStore({ boot, fetchJson: async (f) => JSON.parse(fs.readFileSync(path.join(data, f), 'utf8')), now: () => boot.recordedAt });
    const warns = [];
    const lang = { v: 'en' };
    const env = { store, warn: (m) => warns.push(m), emit: () => {}, now: () => boot.recordedAt, get lang() { return lang.v; } };
    const call = (url) => dispatch({ method: 'GET', url }, env);
    const manifest = createRequire(import.meta.url)('./manifest.js');
    assert.deepEqual(LINE_WORDS, manifest.LINE_WORDS);
    assert.deepEqual(PICTURE_WORDS, manifest.PICTURE_WORDS);

    // окно «Сцены»: 8 сцен в 4 играх, «Диалоги» пусты, «С голосом» отбирает по записи, «Ещё N» отдаёт всё, а не per
    const all = (await call('/api/scenes?kind=scenes&per=1')).body;
    assert.deepEqual([all.total, all.counts.scenes, all.counts.dialogue, all.games.length], [8, 8, 0, 4]);
    assert.ok(all.games.every((g) => g.rows.length === 1 && g.count === 2));
    assert.equal((await call('/api/scenes?kind=dialogue')).body.total, 0);
    const voiced = (await call('/api/scenes?kind=scenes&voice=1')).body;
    const withVoice = all.games.length && (await call('/api/scenes?kind=scenes')).body.games.flatMap((g) => g.rows).filter((x) => x.sum?.v).length;
    assert.equal(voiced.total, withVoice);
    assert.equal((await call('/api/scenes?kind=scenes&tag=nothing')).body.total, 0);
    const one = (await call(`/api/scenes?kind=scenes&game=${all.games[0].id}`)).body;
    assert.deepEqual([one.games.length, one.games[0].rows.length], [1, 2]);

    // очередь: по порядку и вперемешку — те же 8 сцен; порция со «from»
    const order = (await call('/api/scenes?kind=scenes&queue=order')).body;
    assert.equal(order.queue.length, 8);
    assert.deepEqual(Object.keys(order.queue[0]).sort(), ['game', 'key', 'n', 'title']);
    assert.equal((await call('/api/scenes?kind=scenes&queue=order&from=6')).body.queue.length, 2);
    const mixed = (await call('/api/scenes?kind=scenes&queue=random')).body;
    assert.deepEqual(mixed.queue.map((x) => `${x.game}${x.key}`).sort(), order.queue.map((x) => `${x.game}${x.key}`).sort());

    // плеер: ответ записан по альбому и языку интерфейса
    const first = order.queue[0];
    for (const ui of ['en', 'ru', 'de']) {
      const res = await call(`/api/gallery/${first.game}/scene?key=${encodeURIComponent(first.key)}&n=${first.n}&ui=${ui}`);
      assert.equal(res.status, 200, ui);
      assert.ok(res.body.steps.some((x) => x.k === 'say') && res.body.steps.some((x) => x.k === 'snd'), ui);
    }

    // реплики: слово из записи, одна игра, limit, чужое слово — подсказка со списком, короткое — 400
    const lamp = (await call('/api/lines/search?q=lamp&limit=60')).body;
    assert.ok(lamp.total >= 3 && lamp.scenes.length >= 2);
    const lampOne = (await call(`/api/lines/search?q=Lamp&game=${lamp.games[0].id}&limit=1`)).body;
    assert.deepEqual([lampOne.games.length, lampOne.scenes.length, lampOne.total], [1, 1, lamp.games[0].lines]);
    for (const l of ['ru', 'en', 'de']) {
      lang.v = l;
      const no = await call('/api/lines/search?q=dragon');
      assert.deepEqual([no.status, no.body.error], [409, wordsHint(l, 'lines')]);
    }
    lang.v = 'en';
    assert.equal((await call('/api/lines/search?q=ab')).status, 400);
    for (const w of LINE_WORDS) assert.ok((await call(`/api/lines/search?q=${w}&limit=60`)).body.total > 0, w);

    // картинки: у каждого слова есть кадры; русское слово — тот же ответ с understood; чужое — подсказка; «похожие» — заметка
    for (const w of PICTURE_WORDS) assert.ok((await call(`/api/pictures/search?q=${w}&limit=60&from=0`)).body.results.length > 0, w);
    lang.v = 'ru';
    const ru = await call('/api/pictures/search?q=%D0%BC%D0%B0%D1%8F%D0%BA&limit=60&from=0');
    assert.equal(ru.body.understood, 'lighthouse');
    assert.deepEqual(ru.body.results, (await call('/api/pictures/search?q=lighthouse&limit=60&from=0')).body.results);
    // «замок» (ru) и «Burg» (de) — это castle; слово чужого языка не принимается
    const castle = (await call('/api/pictures/search?q=castle&limit=60&from=0')).body;
    const zamok = (await call('/api/pictures/search?q=%D0%B7%D0%B0%D0%BC%D0%BE%D0%BA&limit=60&from=0')).body;
    assert.deepEqual([zamok.understood, zamok.results], ['castle', castle.results]);
    lang.v = 'de';
    const burg = (await call('/api/pictures/search?q=Burg&limit=60&from=0')).body;
    assert.deepEqual([burg.understood, burg.results], ['castle', castle.results]);
    assert.equal((await call('/api/pictures/search?q=%D0%B7%D0%B0%D0%BC%D0%BE%D0%BA')).status, 409);
    lang.v = 'ru';
    const unknown = await call('/api/pictures/search?q=dragon');
    assert.deepEqual([unknown.status, unknown.body.error], [409, wordsHint('ru', 'pictures')]);
    assert.equal((await call('/api/pictures/similar?game=a&f=b')).body.params.what, 'similar');
    lang.v = 'en';
    const page = (await call('/api/pictures/search?q=sea&limit=5&from=0')).body;
    assert.deepEqual([page.results.length, page.more], [5, true]);

    // игра на полке не попадает ни в сцены, ни в реплики, ни в картинки
    const game = (await store.read('/api/games')).find((g) => g.id === first.game);
    game.shelf = { at: 1, key: 'k', until: 2 };
    assert.ok((await call('/api/scenes?kind=scenes')).body.games.every((g) => g.id !== first.game));
    assert.ok((await call('/api/lines/search?q=lamp&limit=60')).body.scenes.every((x) => x.game !== first.game));
    assert.ok((await call('/api/pictures/search?q=sea&limit=60')).body.results.every((x) => x.game !== first.game));
    assert.deepEqual(warns, []);
  });

// Запись без слов (DEMO_NO_WORDS=1): поиск картинок отвечает подсказкой, не 404
test('поиск картинок без записанных слов отвечает подсказкой', async () => {
  const boot = { recordedAt: NOW, rec: {}, lazy: {} };
  const store = createStore({ boot, fetchJson: async () => undefined, now: () => NOW });
  const env = { store, warn: () => {}, emit: () => {}, now: () => NOW, lang: 'en' };
  const res = await dispatch({ method: 'GET', url: '/api/pictures/search?q=castle' }, env);
  assert.deepEqual([res.status, res.body.error], [409, wordsHint('en', 'pictures')]);
});

// Запись слов: порядок плиток не зависит от третьего знака оценки (он гуляет между процессорами)
test('steadyResults: оценка до сотых, при равенстве по игре и файлу', () => {
  const { steadyResults } = createRequire(import.meta.url)('./manifest.js');
  const a = [{ game: 'B', file: 'x', score: 0.2241 }, { game: 'A', file: 'z', score: 0.2249 }, { game: 'A', file: 'y', score: 0.231 }];
  const b = [{ game: 'A', file: 'z', score: 0.2244 }, { game: 'A', file: 'y', score: 0.2306 }, { game: 'B', file: 'x', score: 0.2249 }];
  assert.deepEqual(steadyResults(a).map((r) => r.file), ['y', 'z', 'x']);
  assert.deepEqual(steadyResults(a), steadyResults(b));
});
