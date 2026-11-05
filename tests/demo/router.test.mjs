// Роутер демо без браузера: разбор путей, виды маршрутов, отказы, ключи и сдвиг времени.
// Запуск: node --test --test-force-exit tests/demo/router.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, reply, fail, off } from '../../frontend/demo/router.js';
import { reqKey, mediaKey } from '../../frontend/demo/keys.js';
import { shiftTimes, shiftPlayDays, shiftBody } from '../../frontend/demo/timeShift.js';
import { createStore } from '../../frontend/demo/store.js';
import handlers from '../../frontend/demo/handlers/index.js';

const store = () => createStore({
  boot: { recordedAt: 1000, rec: { '/api/games': [{ id: 'a', rating: 1 }], '/api/games/trash?count=1': { count: 0 } }, lazy: { '/api/lazy': 'd/lazy.json' } },
  fetchJson: async (file) => ({ file }),
  now: () => 1000,
});
const warns = [];
const env = (s) => ({ store: s, warn: (m) => warns.push(m), emit: (...a) => env.emitted.push(a) });
env.emitted = [];

const router = createRouter([(r) => {
  r.rec('GET', '/api/games');
  r.rec('GET', '/api/games/trash', { q: ['count'] });
  r.rec('GET', '/api/lazy');
  r.rec('GET', '/api/missing');
  r.calc('GET', '/api/games/space', () => ({ space: true }));
  r.calc('GET', '/api/games/:id', (ctx) => ({ id: ctx.params.id }));
  r.mut('POST', '/api/games/:id/meta', async (ctx) => {
    const games = await ctx.store.read('/api/games');
    Object.assign(games.find((g) => g.id === ctx.params.id), ctx.body);
    ctx.emit('library-changed');
    return { success: true };
  });
  r.mut('POST', '/api/created', () => reply(201, { ok: 1 }));
  r.mut('POST', '/api/refused', () => { throw off('lookup'); });
  r.mut('POST', '/api/bad', () => { throw fail(400, 'нет', 'name-bad'); });
  r.mut('POST', '/api/boom', () => { throw new Error('boom'); });
  r.mut('POST', '/api/nothing', () => undefined);
  r.calc('GET', '/api/files/*', (ctx) => ({ rest: ctx.params['*'] }));
  r.off('POST', '/api/games/:id/rescrape', 'lookup');
  r.off('GET', '/api/games/:id/archive', 'download');
}]);
const call = (method, url, body) => router.dispatch({ method, url, body }, env(call.store));

test('handlers/index.js: пустой список грузится и собирает таблицу', () => {
  assert.doesNotThrow(() => createRouter(handlers));
});

test('постоянные отрезки сильнее :имени, :имя декодируется', async () => {
  call.store = store();
  assert.deepEqual((await call('GET', '/api/games/space')).body, { space: true });
  assert.deepEqual((await call('GET', '/api/games/%D0%B8%D0%B3%D1%80%D0%B0')).body, { id: 'игра' });
  assert.deepEqual((await call('GET', '/api/files/a/b%20c')).body, { rest: 'a/b c' });
});

test('rec: параметры вне q ключ не меняют, из q — выбирают ответ', async () => {
  call.store = store();
  assert.deepEqual((await call('GET', '/api/games/trash?count=1&v=5')).body, { count: 0 });
  assert.equal((await call('GET', '/api/games/trash')).status, 404);
  assert.equal(reqKey('/api/x', { b: '2', a: '1', z: '9' }, ['b', 'a']), '/api/x?a=1&b=2');
});

test('rec: ленивый файл читается один раз, неизвестное — 404 и предупреждение', async () => {
  call.store = store();
  warns.length = 0;
  assert.deepEqual((await call('GET', '/api/lazy')).body, { file: 'd/lazy.json' });
  const miss = await call('GET', '/api/missing');
  assert.equal(miss.status, 404);
  assert.match(warns.at(-1), /^\[demo\] unrecorded GET \/api\/missing/);
});

test('mut меняет память: следующий GET видит правку, событие уходит в сокет', async () => {
  call.store = store();
  env.emitted.length = 0;
  assert.deepEqual((await call('POST', '/api/games/a/meta', { rating: 5 })).body, { success: true });
  assert.equal((await call('GET', '/api/games')).body[0].rating, 5);
  assert.deepEqual(env.emitted, [['library-changed']]);
});

test('отказы: demo-off как у сервера, fail, reply, ошибка обработчика', async () => {
  call.store = store();
  warns.length = 0;
  const offRes = await call('POST', '/api/games/a/rescrape');
  assert.equal(offRes.status, 409);
  assert.deepEqual(offRes.body, { error: 'demo-off', reason: 'demo-off', params: { what: 'lookup' } });
  assert.deepEqual((await call('POST', '/api/refused')).body.params, { what: 'lookup' });
  assert.deepEqual(await call('POST', '/api/bad'), { status: 400, body: { error: 'нет', reason: 'name-bad' } });
  assert.deepEqual(await call('POST', '/api/created'), { status: 201, body: { ok: 1 } });
  assert.equal((await call('POST', '/api/boom')).status, 500);
  assert.equal((await call('POST', '/api/nothing')).status, 500);
  assert.match(warns.join('\n'), /unhandled error POST \/api\/boom: boom/);
});

test('нет маршрута: 404 и «[demo] unhandled»; HEAD берёт строку GET', async () => {
  call.store = store();
  warns.length = 0;
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal(warns[0], '[demo] unhandled GET /api/nope');
  assert.deepEqual(await call('HEAD', '/api/games'), { status: 200, body: null });
  assert.deepEqual(await call('HEAD', '/api/nope'), { status: 404, body: { error: 'demo: no such route' } });
  const offHead = await call('HEAD', '/api/games/a/archive');
  assert.deepEqual(offHead, { status: 409, body: null });
});

test('регистрация: повтор и пустой what — ошибка сразу', () => {
  assert.throws(() => createRouter([(r) => { r.rec('GET', '/a'); r.rec('GET', '/a'); }]), /уже есть/);
  assert.throws(() => createRouter([(r) => r.off('GET', '/a')]), /what/);
  assert.throws(() => createRouter([(r) => r.mut('POST', '/a')]), /обработчик/);
});

test('mediaKey: ширина, метка версии и /media не входят; f и key входят', () => {
  assert.equal(mediaKey('/_media/g/cover-1.png?w=360'), '/_media/g/cover-1.png');
  assert.equal(mediaKey('/media/_media/g/cover-1.png'), '/_media/g/cover-1.png');
  assert.equal(mediaKey('/api/gallery/g/thumb?f=cg%2Fa.webp'), '/api/gallery/g/thumb?f=cg%2Fa.webp');
  assert.equal(mediaKey('/api/saves/shot/g?key=slot1&v=77'), '/api/saves/shot/g?key=slot1');
  assert.equal(mediaKey('/api/avatars/owner?v=3'), '/api/avatars/owner');
});

test('время: поля из списка сдвигаются, чужие числа нет; секунды в своей мере', () => {
  const body = { addedAt: 1.7e12, size: 1.7e12, list: [{ lastPlayed: 1.7e12, n: { at: 1.7e9 } }] };
  shiftTimes(body, 3600000);
  assert.equal(body.addedAt, 1.7e12 + 3600000);
  assert.equal(body.size, 1.7e12);
  assert.equal(body.list[0].lastPlayed, 1.7e12 + 3600000);
  assert.equal(body.list[0].n.at, 1.7e9 + 3600);
});

test('дни за игрой: последний день записи становится сегодняшним по часам посетителя', () => {
  const now = new Date(2027, 0, 10, 15, 0).getTime();
  const body = shiftPlayDays({ today: '2026-11-04', since: '2026-10-30', days: [{ day: '2026-11-03', games: [] }, { day: '2026-11-04', games: [] }] }, now);
  assert.equal(body.today, '2027-01-10');
  assert.equal(body.since, '2027-01-05');
  assert.deepEqual(body.days.map((d) => d.day), ['2027-01-09', '2027-01-10']);
  const k = shiftBody('/api/play-days', { today: '2027-01-10', days: [] }, { recordedAt: 0, now });
  assert.equal(k.today, '2027-01-10');
});

test('хранилище: записанное сдвигается один раз при создании', async () => {
  const s = createStore({ boot: { recordedAt: 0, rec: { '/api/x': { at: 1.7e12 } } }, fetchJson: async () => ({}), now: () => 5000 });
  assert.equal((await s.read('/api/x')).at, 1.7e12 + 5000);
  assert.equal(s.has('/api/x'), true);
  assert.deepEqual(s.list('/api/'), ['/api/x']);
});
