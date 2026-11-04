// Двое людей в одном браузере, одна игра, один слот — в настоящей игре (rpg-fixes с window.__RPG.who).
// Проверяет: каждый получает свой сейв обратно после перезагрузки; хранилище браузера (localStorage у MV, IndexedDB
// у MZ) держит их ключи порознь; очередь «не отправилось» у каждого своя и чужой вкладкой не разбирается; у владельца
// ключи прежние (его игру открываем только на чтение: запись на сервер обрывается, на сервере ничего не меняется).
//
// Нужны два временных человека в базе библиотеки без обязательной смены пароля (must_change = 0), после проверки их убрать:
// PEOPLE='имя:пароль,имя:пароль'. Владелец — по RPG_USER/RPG_PASS. Сейвы пишутся только этим двоим, в _saves/.people/<id>.
// ONLY обязателен: проверка идёт минуты на игру и пишет сейвы, на всю библиотеку случайно её не пускаем.
//
// Для шага «доступ» владелец на время ограничивает B (PUT /api/users/<id>/games) и в конце возвращает «все игры».
//
// Запуск: docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm --no-deps -e PEOPLE=… -e RPG_USER=… -e RPG_PASS=… \
//   -e ONLY='<regex id>' -v "$PWD/tests/compat/check-people.mjs:/work/check-people.mjs:ro" compat node check-people.mjs
import { chromium } from 'playwright';
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://rpg-library:3000';
const GAME_URL = process.env.GAME_URL ?? 'http://rpg-library:3001';
if (!process.env.ONLY) throw new Error("ONLY: укажи игры, например ONLY='^Ironhold_Keep'");
const ONLY = new RegExp(process.env.ONLY);
const OWNER = { name: process.env.RPG_USER, pass: process.env.RPG_PASS };
const PEOPLE = (process.env.PEOPLE ?? '').split(',').filter(Boolean).map((s) => { const [name, pass] = s.split(':'); return { name, pass }; });
if (PEOPLE.length < 2) throw new Error('PEOPLE: нужны двое');

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const log = (game, ok, what) => { console.log(`${ok ? 'OK ' : 'НЕТ'} ${game}: ${what}`); if (!ok) failures.push(`${game}: ${what}`); };

async function signIn(who) {
    const ctx = await browser.newContext();
    const res = await ctx.request.post(`${BASE_URL}/api/login`, { data: { username: who.name, password: who.pass } });
    if (!res.ok()) throw new Error(`вход ${who.name}: HTTP ${res.status()}`);
    who.api = ctx.request;
    who.id = (await (await ctx.request.get(`${BASE_URL}/api/me`)).json()).id;
}
const savesOf = async (who, game) => (await who.api.get(`${BASE_URL}/api/saves/${encodeURIComponent(game)}`)).json();

// Страница игры: новый «заход» человека. Ключ записи — как у настоящего клиента (POST /api/play)
async function openGame(ctx, who, game, { blockWrites = false, abortWrites = false } = {}) {
    const play = await (await who.api.post(`${BASE_URL}/api/play/${encodeURIComponent(game)}`)).json();
    if (play.mode !== 'frame') throw new Error('игры на своём адресе нет');
    const page = await ctx.newPage();
    const state = { block: blockWrites };
    page.state = state;
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message.slice(0, 160)));
    if (abortWrites) {
        // Владелец: чтение разрешено, любая запись обрывается — на сервере ничего не меняется
        await page.route('**/*', (r) => (['GET', 'HEAD', 'OPTIONS'].includes(r.request().method()) ? r.fallback() : r.abort()));
    } else {
        await page.route(/\/saves\//, (r) => (state.block && r.request().method() === 'POST' ? r.abort() : r.fallback()));
    }
    await page.goto(`${GAME_URL}${play.path}?s=${play.session}`, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 90; i++) {
        const s = await page.evaluate(() => window.SceneManager?._scene?.constructor?.name).catch(() => null);
        if (s && s !== 'Scene_Boot') break;
        await wait(1000);
    }
    // Данные игры загружены не сразу после первой сцены: «новая игра» раньше них падает (плагины читают $dataSystem)
    for (let i = 0; i < 60; i++) {
        if (await page.evaluate(() => !!window.DataManager?.isDatabaseLoaded?.() && !!window.$dataSystem).catch(() => false)) break;
        await wait(500);
    }
    await wait(3000); // облако rpg-fixes отвечает не сразу
    return page;
}
const newGame = async (page) => {
    await page.evaluate(() => { DataManager.setupNewGame(); SceneManager.goto(Scene_Map); });
    for (let i = 0; i < 40; i++) {
        if (await page.evaluate(() => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring()).catch(() => false)) break;
        await wait(500);
    }
    await wait(1000);
};
const gold = (page) => page.evaluate(() => $gameParty.gold());
const saveSlot = (page, n) => page.evaluate(async (slot) => { const r = await DataManager.saveGame(slot); return r !== false; }, n);
const loadSlot = (page, n) => page.evaluate(async (slot) => { try { const r = await DataManager.loadGame(slot); return r !== false; } catch (e) { return false; } }, n);
const lsKeys = (page) => page.evaluate(() => Object.keys(localStorage));
// Ключи IndexedDB (сейвы MZ лежат там)
const idbKeys = (page) => page.evaluate(async () => {
    const out = [];
    for (const info of (await indexedDB.databases?.()) || []) {
        const db = await new Promise((res, rej) => { const q = indexedDB.open(info.name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        for (const store of [...db.objectStoreNames]) {
            const keys = await new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
            out.push(...keys.map(String));
        }
        db.close();
    }
    return out;
});
async function until(fn, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await wait(500); } return false; }

const all = await (async () => { const o = { name: OWNER.name, pass: OWNER.pass }; await signIn(o); return o; })();
for (const p of PEOPLE) await signIn(p);
const [A, B] = PEOPLE;
const library = await (await all.api.get(`${BASE_URL}/api/games`)).json();
const games = library.filter((g) => ONLY.test(g.id));
if (!games.length) throw new Error('игра не найдена');

for (const game of games.map((g) => g.id)) {
    const engine = (n) => `${game} [${n}]`;
    // Один браузер на обоих: общее хранилище страницы — ровно то, что надо проверить
    const shared = await browser.newContext({ viewport: { width: 900, height: 600 } });
    try {
        // 1. Каждый сохраняется в слот 1 со своей суммой золота. Золото — признак «чей это сейв»
        const mine = {};
        for (const [who, extra] of [[A, 1111], [B, 2222]]) {
            const page = await openGame(shared, who, game);
            await newGame(page);
            await page.evaluate((n) => $gameParty.gainGold(n), extra);
            mine[who.name] = await gold(page);
            const saved = await saveSlot(page, 1);
            log(engine(who.name), saved, `слот 1 сохранён, золото ${mine[who.name]}`);
            const onServer = await until(async () => Object.keys(await savesOf(who, game)).some((k) => /file1$/i.test(k.replace(/\s/g, ''))));
            log(engine(who.name), onServer, 'сейв дошёл до сервера этого человека');
            await page.close();
        }
        log(engine('оба'), mine[A.name] !== mine[B.name], `суммы разные: ${mine[A.name]} и ${mine[B.name]}`);

        // 2. Слот на сервере у каждого свой
        const ha = Object.values(await savesOf(A, game)).map((s) => sha(s.value)).join();
        const hb = Object.values(await savesOf(B, game)).map((s) => sha(s.value)).join();
        log(engine('сервер'), ha && hb && ha !== hb, `сейвы на сервере разные (${ha} и ${hb})`);

        // 3. Перезагрузка по очереди — каждый получает своё
        for (const who of [A, B, A, B]) {
            const page = await openGame(shared, who, game);
            const loaded = await loadSlot(page, 1);
            const g = loaded ? await gold(page) : null;
            log(engine(who.name), loaded && g === mine[who.name], `после перезагрузки в слоте 1 своё золото: ${g} (ждали ${mine[who.name]})`);
            if (who === B) {
                // Ключи хранилища браузера: у каждого с приставкой, без общих «голых»
                const ls = await lsKeys(page);
                const ids = [A.id, B.id];
                const own = ls.filter((k) => k.startsWith(`rpgm:${who.id}/`));
                log(engine(who.name), own.length > 0, `ключи localStorage под своим id: ${own.length}`);
                const bare = ls.filter((k) => /^rpgm:/.test(k) && !ids.some((id) => k.startsWith(`rpgm:${id}/`)));
                log(engine('ключи'), bare.length === 0, `общих ключей rpgm: без id нет (${bare.slice(0, 3).join('|')})`);
                const idb = await idbKeys(page);
                // У MZ сейвы лежат только там: пустая база значила бы, что проверять было нечего
                const mz = await page.evaluate(() => window.Utils?.RPGMAKER_NAME === 'MZ');
                if (mz) log(engine('IndexedDB'), idb.length > 0, `у MZ ключи в IndexedDB есть: ${idb.length}`);
                if (idb.length) {
                    const bareIdb = idb.filter((k) => !ids.some((id) => k.startsWith(`${id}.`)));
                    log(engine('IndexedDB'), idb.some((k) => k.startsWith(`${A.id}.`)) && idb.some((k) => k.startsWith(`${B.id}.`)) && bareIdb.length === 0,
                        `ключи IndexedDB обоих с приставкой: ${idb.length} (без приставки: ${bareIdb.slice(0, 2).join('|')})`);
                }
            }
            await page.close();
        }

        // 4. Очередь без сети: слот 2 у A не ушёл — ждёт в очереди A; B её не трогает и не отправляет от своего имени
        const offline = await openGame(shared, A, game, { blockWrites: true });
        await newGame(offline);
        await offline.evaluate(() => $gameParty.gainGold(3333));
        const queuedGold = await gold(offline);
        await saveSlot(offline, 2);
        await wait(2000);
        const queueOf = (page, who) => page.evaluate(([id, g]) => { try { return Object.keys(JSON.parse(localStorage.getItem(`_rpg_offline_queue_${id}_${g}`) || '{}')); } catch (e) { return []; } }, [who.id, game]);
        const slot2 = (keys) => keys.filter((k) => /file2$/i.test(k.replace(/\s/g, '')));
        const qA = slot2(await queueOf(offline, A));
        log(engine('очередь'), qA.length === 1, `в очереди A под её id слот 2: ${qA.join('|') || 'нет'}`);
        log(engine('очередь'), slot2(await queueOf(offline, B)).length === 0, 'в очереди B слота 2 нет');
        log(engine('очередь'), !(await lsKeys(offline)).includes(`_rpg_offline_queue_${game}`), 'общей очереди без id нет');
        await offline.close();
        const viaB = await openGame(shared, B, game);
        await wait(3000);
        const bSaves = Object.keys(await savesOf(B, game)).filter((k) => /file2$/i.test(k.replace(/\s/g, '')));
        log(engine('очередь'), bSaves.length === 0, 'у B слота 2 нет: чужая очередь им не отправлена');
        log(engine('очередь'), slot2(await queueOf(viaB, A)).length === 1, 'очередь A осталась на месте после захода B');
        log(engine('очередь'), slot2(await queueOf(viaB, B)).length === 0, 'в очереди B слота 2 нет и после захода');
        await viaB.close();
        const back = await openGame(shared, A, game);
        const flushed = await until(async () => Object.keys(await savesOf(A, game)).some((k) => /file2$/i.test(k.replace(/\s/g, ''))), 30000);
        log(engine(A.name), flushed, 'вернулся — очередь ушла на сервер A');
        if (flushed) {
            const ok2 = await loadSlot(back, 2);
            const g2 = ok2 ? await gold(back) : null;
            log(engine(A.name), g2 === queuedGold, `слот 2 из очереди: золото ${g2} (ждали ${queuedGold})`);
        }
        await back.close();
        const bAfter = Object.keys(await savesOf(B, game)).filter((k) => /file2$/i.test(k.replace(/\s/g, '')));
        log(engine('очередь'), bAfter.length === 0, 'у B слота 2 так и нет');
    } finally {
        await shared.close();
    }

    // 5. Владелец: ключи прежние (без id). Только чтение — запись на сервер обрывается
    const fresh = await browser.newContext({ viewport: { width: 900, height: 600 } });
    try {
        const page = await openGame(fresh, all, game, { abortWrites: true });
        await newGame(page);
        await saveSlot(page, 3);
        await wait(2000);
        const ls = await lsKeys(page);
        const idb = await idbKeys(page);
        const ids = [A.id, B.id];
        log(engine('владелец'), !ls.concat(idb).some((k) => ids.some((id) => k.includes(id))), 'в ключах владельца нет чужих id');
        log(engine('владелец'), ls.some((k) => k === `rpgm:${game}:RPG File3` || k.startsWith(`rpgm:${game}:`)) || idb.some((k) => /^RPG Maker MZ/.test(k)), `ключи прежние: ${ls.filter((k) => /rpgm:|_rpg_offline/.test(k)).slice(0, 3).join('|')} ${idb.slice(0, 2).join('|')}`);
        log(engine('владелец'), ls.includes(`_rpg_offline_queue_${game}`), 'очередь владельца без id');
        await page.close();
    } finally {
        await fresh.close();
    }

    // 6. Ограниченный человек (личный ключ тот же, но доступ проверяется на каждом файле): открытая игра отдаётся, закрытая —
    // нет, и уже выданный адрес с прежним ключом умирает со следующим запросом; открыли снова — тот же адрес работает
    const setList = (limited, ids) => all.api.put(`${BASE_URL}/api/users/${encodeURIComponent(B.id)}/games`, { data: { limited, games: ids } });
    const status = async (play) => (await fetch(`${GAME_URL}${play.path}?s=${play.session}`)).status;
    try {
        log(engine('доступ'), (await setList(true, [game])).ok(), 'B ограничен одной этой игрой');
        const play = await (await B.api.post(`${BASE_URL}/api/play/${encodeURIComponent(game)}`)).json();
        log(engine('доступ'), (await status(play)) === 200, 'открытая игра на своём адресе отдаётся');
        await setList(true, []);
        // Закрытая игра отвечает как адрес с чужим ключом: порт игр не различает «закрыта» и «ключ не тот»
        const forged = (await status({ ...play, path: play.path.replace(/^\/g\/[^/]+/, '/g/forged') }));
        const closed = await status(play);
        log(engine('доступ'), closed !== 200 && closed === forged, `игру закрыли — выданный адрес отвечает ${closed}, как чужой ключ (${forged}), со следующего запроса`);
        log(engine('доступ'), (await B.api.post(`${BASE_URL}/api/play/${encodeURIComponent(game)}`)).status() === 404, 'запустить закрытую игру нельзя (404)');
        await setList(true, [game]);
        log(engine('доступ'), (await status(play)) === 200, 'открыли снова — тот же адрес работает');
    } finally {
        await setList(false, []);
    }
}
await browser.close();
console.log(failures.length ? `\nПровалов: ${failures.length}\n${failures.join('\n')}` : '\nВсе проверки прошли');
process.exit(failures.length ? 1 : 0);
