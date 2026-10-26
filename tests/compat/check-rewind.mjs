// Проверка перемотки в настоящих играх (rpg-fixes, setupSceneMarks): новая игра → P (момент) → игра меняется →
// Backspace → вернуться к моменту → всё как было; у сейвов — прохождение и путь (_rpgLine, _rpgLast), «До перемотки»
// и «Где вышли» — сбоку истории; «Это прохождение» на плёнке; под плёнкой игра стоит; «Игра окончена» открывает плёнку.
// Клавиши игры: A — авто-текст листает реплику сам, V — картинка без окон, M — без звука, T — турбо (буква, которую
// занимает сама игра, не наша — шаг пропускается).
// TOUCH=1 — как телефон: ещё и включённый «Пропуск» переживает плёнку, касание экрана листает реплику.
//
// МОМЕНТЫ И СЕЙВЫ НЕ ПИШУТСЯ. Сервер моментов подменён здесь же, в памяти (как utils/marks.js, без прореживания: его
// проверяют тесты API), сейвы и «Путь» — ответом «ок». Игры и данные владельца не меняются.
//
// Запуск: docker compose run --rm --no-deps compat node check-rewind.mjs
// Одни игры: docker compose run --rm --no-deps -e ONLY='Ironhold|Starfall' compat node check-rewind.mjs
// Как телефон: … -e TOUCH=1 …
// Результат: таблица в консоли и report/rewind.json
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = process.env.BASE_URL ?? 'http://rpg-library:3000';
const GAME_URL = process.env.GAME_URL ?? 'http://rpg-library:3001';
const USER = process.env.RPG_USER;
const PASS = process.env.RPG_PASS;
const ONLY = process.env.ONLY;
const TOUCH = !!process.env.TOUCH;
const OUT = 'report';

if (!USER || !PASS) throw new Error('Задай RPG_USER и RPG_PASS (логин dev-сервера)');

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const api = await browser.newContext();
const login = await api.request.post(`${BASE_URL}/api/login`, { data: { username: USER, password: PASS } });
if (!login.ok()) throw new Error(`Логин не удался: HTTP ${login.status()}`);
let games = await (await api.request.get(`${BASE_URL}/api/games`)).json();
if (ONLY) games = games.filter((g) => new RegExp(ONLY, 'i').test(g.id));

// Сервер моментов в памяти: тот же разговор, что у routes/play.js
function fakeMarks() {
    const items = new Map();   // id → { meta, value }
    const tree = {};
    const posts = [];
    const handle = async (route) => {
        const req = route.request();
        const m = /\/marks\/[^/]+\/[^/]+(?:\/(.*))?$/.exec(new URL(req.url()).pathname);
        const rest = (m && m[1]) || '';
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (req.method() === 'POST' && !rest) {
            const b = req.postDataJSON();
            const id = b.id || `x${Date.now().toString(36)}`;
            posts.push(b);
            items.set(id, { meta: { id, kind: b.kind, why: b.why || '', label: b.label || '', map: b.map || '', at: Date.now(), thumb: false, save: !!b.value, line: b.line || '' }, value: b.value });
            if (b.value) tree[id] = b.parent || '';
            return json({ id });
        }
        if (req.method() === 'POST') return json({ success: true });
        if (!rest) return json([...items.values()].map((x) => x.meta).sort((a, b) => b.at - a.at));
        if (rest.startsWith('trail/')) {
            const out = [];
            for (let cur = decodeURIComponent(rest.slice(6)), n = 0; cur && n < 1000; cur = tree[cur], n++) if (items.has(cur)) out.push(cur);
            return json({ trail: out });
        }
        if (rest.endsWith('/thumb')) return route.fulfill({ status: 404, body: '' });
        const it = items.get(decodeURIComponent(rest));
        return it && it.value ? json({ value: it.value }) : json({ error: 'not-found' }, 404);
    };
    return { handle, posts, items };
}

const results = [];
for (const game of games) {
    const play = await (await api.request.post(`${BASE_URL}/api/play/${encodeURIComponent(game.id)}`)).json().catch(() => ({}));
    if (play.mode !== 'frame') { console.log(`${game.id}: игры на своём адресе нет (GAME_ISOLATION=off) — пропуск`); continue; }
    const ctx = await browser.newContext(TOUCH
        ? { viewport: { width: 915, height: 412 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' }
        : { viewport: { width: 1100, height: 700 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    const marks = fakeMarks();
    await page.route(/\/marks\//, marks.handle);
    // Остальная запись — не на сервер
    await page.route('**/*', (r) => (['GET', 'HEAD'].includes(r.request().method()) || /\/marks\//.test(r.request().url())
        ? r.fallback() : r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })));
    const result = { id: game.id, status: 'OK', steps: [], errors };
    const fail = (why) => { result.status = 'FAIL'; result.steps.push(`НЕТ: ${why}`); };
    const ok = (what) => result.steps.push(what);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    try {
        await page.goto(`${GAME_URL}${play.path}`, { waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 90; i++) { const s = await ev(() => window.SceneManager?._scene?.constructor?.name).catch(() => null); if (s && s !== 'Scene_Boot') break; await page.waitForTimeout(1000); }
        await page.waitForTimeout(2000);
        await ev(() => { DataManager.setupNewGame(); SceneManager.goto(Scene_Map); });
        let onMap = false;
        for (let i = 0; i < 40 && !onMap; i++) {
            onMap = await ev(() => SceneManager._scene instanceof Scene_Map && (SceneManager._sceneStarted || !!SceneManager._scene.isStarted?.()) && !$gamePlayer.isTransferring()).catch(() => false);
            if (!onMap) await page.waitForTimeout(500);
        }
        if (!onMap) throw new Error('на карту не вышли');
        await page.waitForTimeout(1500);
        // Сцена на старте (автозапуск) — прочь: проверяем перемотку, а не её
        await ev(() => { $gameMessage.clear(); $gameMap._interpreter.clear(); });
        const before = await ev(() => ({ gold: $gameParty.gold(), x: $gamePlayer.x, y: $gamePlayer.y }));
        // P — момент: у сейва — своё id, предок и прохождение
        await page.keyboard.press('p');
        for (let i = 0; i < 20 && !marks.posts.some((b) => b.kind === 'mark'); i++) await page.waitForTimeout(250);
        const moment = marks.posts.find((b) => b.kind === 'mark');
        if (!moment) throw new Error('P не запомнил момент');
        const last = await ev(() => ({ last: $gameSystem._rpgLast, line: $gameSystem._rpgLine }));
        if (moment.id && moment.line && last.last === moment.id && last.line === moment.line) ok('момент: id и прохождение в сейве');
        else fail(`момент без пути: ${JSON.stringify({ id: moment.id, line: moment.line, last })}`);
        // Игра меняется
        await ev(() => { $gameParty.gainGold(777); });
        // Backspace → плёнка → Enter: назад к моменту
        await page.keyboard.press('Backspace');
        await page.waitForSelector('#_rewind', { state: 'visible', timeout: 8000 });
        await page.waitForFunction(() => document.querySelectorAll('#_rewind ._rw_card').length > 0, null, { timeout: 8000 });
        const strip = await ev(() => ({ cards: document.querySelectorAll('#_rewind ._rw_card').length, group: document.querySelector('#_rewind ._rw_tab._on')?.textContent || '' }));
        ok(`плёнка: ${strip.cards} ${strip.group ? `(${strip.group.trim()})` : ''}`);
        // Под плёнкой игра стоит: сцена не обновляется — иначе геймпад уводил «Игру окончена» на титул
        const frames = await ev(() => new Promise((done) => {
            const s = SceneManager._scene, own = Object.prototype.hasOwnProperty.call(s, 'update'), orig = s.update;
            let n = 0;
            s.update = function () { n++; return orig.apply(this, arguments); };
            setTimeout(() => { if (own) s.update = orig; else delete s.update; done(n); }, 600);
        }));
        if (frames === 0) ok('под плёнкой игра стоит');
        else fail(`под плёнкой игра идёт: ${frames} кадров`);
        await page.keyboard.press('Enter');
        let back = null;
        for (let i = 0; i < 40; i++) {
            back = await ev(() => (SceneManager._scene instanceof Scene_Map && document.querySelector('#_rewind')?.style.display === 'none' ? { gold: $gameParty.gold(), last: $gameSystem._rpgLast, line: $gameSystem._rpgLine } : null)).catch(() => null);
            if (back && back.gold === before.gold) break;
            await page.waitForTimeout(250);
        }
        if (back && back.gold === before.gold) ok('перемотка: золото как было');
        else fail(`перемотка не вернула: ${JSON.stringify(back)} (было ${before.gold})`);
        if (back && back.last === moment.id && back.line === moment.line) ok('после перемотки путь — от момента');
        else fail(`путь после перемотки: ${JSON.stringify(back)}`);
        // «До перемотки» уходит после загрузки точки, когда сожмётся кадр, — ждём её
        for (let i = 0; i < 20 && !marks.posts.some((b) => b.why === 'back'); i++) await page.waitForTimeout(250);
        const backPoint = marks.posts.find((b) => b.why === 'back');
        if (backPoint && backPoint.parent === moment.id && backPoint.line === moment.line) ok('«До перемотки» — сбоку, от момента');
        else fail(`«До перемотки»: ${JSON.stringify(backPoint && { parent: backPoint.parent, line: backPoint.line })}`);
        // Плёнка снова: «Это прохождение» — момент и «До перемотки»
        await page.waitForTimeout(500);
        await page.keyboard.press('Backspace');
        await page.waitForFunction(() => document.querySelectorAll('#_rewind ._rw_card').length > 0, null, { timeout: 8000 });
        const run = await ev(() => [...document.querySelectorAll('#_rewind ._rw_card ._rw_label')].map((x) => x.textContent));
        if (run.length >= 2) ok(`это прохождение: ${run.length} карточки`);
        else fail(`это прохождение: ${JSON.stringify(run)}`);
        await page.keyboard.press('Escape');
        // Телефон: включённый «Пропуск» после плёнки — всё ещё в игре. Раньше кнопка горела, а движок о нём забывал
        if (TOUCH) {
            const skipOn = () => ev(() => !!Input._currentState.control);
            const tapSkip = () => ev(() => document.querySelector('#_btn_skip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })));
            await tapSkip();
            const was = await skipOn();
            await page.keyboard.press('Backspace');
            await page.waitForSelector('#_rewind', { state: 'visible', timeout: 8000 });
            await page.keyboard.press('Escape');
            const after = await skipOn();
            await tapSkip();
            if (was && after) ok('«Пропуск» после плёнки — включён');
            else fail(`«Пропуск» после плёнки: ${JSON.stringify({ was, after })}`);
        }
        // Клавиши игры. Реплика — прямо в движок: проверяем наше, а не события игры
        const say = () => ev(() => { $gameMessage.clear(); $gameMessage.add('Mimikin test line'); });
        // Наша реплика ещё на экране. Просто «реплика есть» не годится: за нашей игра может показать свою (вступление)
        const busy = () => ev(() => $gameMessage.isBusy() && $gameMessage.allText().includes('Mimikin test line'));
        const waitFor = async (fn, ms) => { for (let i = 0; i < ms / 250; i++) { if (await fn()) return true; await page.waitForTimeout(250); } return !!(await fn()); };
        const free = (code) => ev((c) => !(Input.keyMapper && Input.keyMapper[c] !== undefined), code);
        // Реплика дописана и ждёт «дальше»: первые 10 кадров паузы движок нажатий не принимает (startPause → startWait)
        const paused = () => ev(() => { const w = SceneManager._scene._messageWindow; return !!w?.pause && !(w._waitCount > 0); });
        if (await free(65)) {
            await say();
            await waitFor(paused, 4000);
            await page.waitForTimeout(2500);
            if (await busy()) ok('без авто-текста реплика ждёт');
            else fail('реплика ушла сама без авто-текста');
            await page.keyboard.press('a');
            if (await waitFor(async () => !(await busy()), 9000)) ok('A — авто-текст листает сам');
            else {
                fail('авто-текст не перелистнул реплику');
                if (process.env.DEBUG) console.log('   окно:', await ev(() => { const w = SceneManager._scene._messageWindow; return { cls: w?.constructor?.name, pause: w?.pause, at: w?._rpgAutoAt, now: performance.now(), own: w && w.isTriggered === Window_MessageLike(), hooked: !!w?.isTriggered?.__rpgSkip, busy: $gameMessage.isBusy(), se: (AudioManager._seBuffers || []).filter((x) => x.isPlaying()).map((x) => x._url) }; function Window_MessageLike() { return Window_Message.prototype.isTriggered; } }));
            }
            await page.keyboard.press('a');
        } else ok('A занята игрой — авто-текст только из меню');
        if (await free(86)) {
            await say();
            await waitFor(paused, 4000);
            await page.keyboard.press('v');
            const clean = await ev(() => ({ layer: SceneManager._scene._windowLayer?.visible, cls: document.documentElement.classList.contains('_rpg_clean') }));
            await page.keyboard.press('ArrowDown');
            const back = await ev(() => ({ layer: SceneManager._scene._windowLayer?.visible, cls: document.documentElement.classList.contains('_rpg_clean'), busy: $gameMessage.isBusy() }));
            if (clean.layer === false && clean.cls && back.layer === true && !back.cls && back.busy) ok('V — картинка без текста; клавиша вернула, реплику не перелистнула');
            else fail(`картинка без текста: ${JSON.stringify({ clean, back })}`);
            await ev(() => { $gameMessage.clear(); });
        } else ok('V занята игрой');
        if (await free(77)) {
            const vol = () => ev(() => (typeof WebAudio._masterVolume === 'number' ? WebAudio._masterVolume : WebAudio._masterGainNode?.gain.value));
            const was = await vol();
            await page.keyboard.press('m');
            const off = await vol();
            await page.keyboard.press('m');
            const on = await vol();
            if (off === 0 && on === was) ok('M — без звука и обратно');
            else fail(`без звука: ${JSON.stringify({ was, off, on })}`);
        } else ok('M занята игрой');
        if (await free(84)) {
            await page.keyboard.press('t');
            const on = await ev(() => window.__rpgTurbo === true && /"turbo":true/.test(Object.entries(localStorage).find(([k]) => k.startsWith('rpgfix_game_'))?.[1] || ''));
            await page.keyboard.press('t');
            if (on && await ev(() => window.__rpgTurbo === false)) ok('T — турбо, запомнено для игры');
            else fail('турбо по T не включилось или не запомнилось');
        } else ok('T занята игрой');
        // Телефон: касание экрана — «дальше» по реплике
        if (TOUCH) {
            await say();
            const waited = await waitFor(paused, 10000);
            if (!waited && process.env.DEBUG) console.log('   реплика не дописалась до касания');
            const box = await page.locator('canvas').first().boundingBox();
            await page.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.4);
            if (await waitFor(async () => !(await busy()), 2000)) ok('касание экрана перелистнуло реплику');
            else {
                fail('касание экрана реплику не перелистнуло');
                if (process.env.DEBUG) console.log('   касание:', await ev(([x, y]) => { const el = document.elementFromPoint(x, y); return { el: el && (el.id || el.tagName), path: el && [...(function* (n) { while (n) { yield n.id || n.tagName; n = n.parentElement; } })(el)].join('<'), busy: $gameMessage.isBusy(), choice: $gameMessage.isChoice(), win: !!SceneManager._scene._messageWindow, pause: SceneManager._scene._messageWindow?.pause, touch: window.__rpgTouchEnabled, text: $gameMessage.allText().slice(0, 60) }; }, [box.x + box.width * 0.6, box.y + box.height * 0.4]));
            }
        }
        // «Где вышли» — когда вкладку убрали, если после перемотки играли (клавиша) и не посреди события; сбоку
        // истории: игра дальше — от прежней точки
        const hide = () => ev(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        });
        const press = async () => { await page.keyboard.down('ArrowDown'); await page.waitForTimeout(400); await page.keyboard.up('ArrowDown'); await page.waitForTimeout(300); };
        const exits = () => marks.posts.filter((b) => b.why === 'exit').length;
        await press();
        if (await ev(() => $gameMap.isEventRunning())) {
            await hide();
            await page.waitForTimeout(1500);
            if (exits() === 0) ok('«Где вышли» посреди события — нет');
            else fail('«Где вышли» взята посреди события');
        }
        // Событие на старте игры (вступление) идёт без конца — для проверки самой точки его не считаем
        await ev(() => { $gameMap.isEventRunning = () => false; });
        await press();
        const lastBefore = await ev(() => $gameSystem._rpgLast);
        await hide();
        for (let i = 0; i < 20 && !exits(); i++) await page.waitForTimeout(250);
        const exit = marks.posts.find((b) => b.why === 'exit');
        const lastAfter = await ev(() => $gameSystem._rpgLast);
        if (exit && exit.parent === lastBefore && lastAfter === lastBefore) ok('«Где вышли» — записана, сбоку');
        else fail(`«Где вышли»: ${JSON.stringify({ exit: !!exit, parent: exit?.parent, lastBefore, lastAfter })}`);
        await ev(() => { delete $gameMap.isEventRunning; });
        // «Игра окончена» — плёнка сама; вернуться — на карту
        await ev(() => SceneManager.goto(Scene_Gameover));
        // Под нагрузкой (программная графика, тяжёлая игра) затемнение и список — дольше обычного
        const over = await page.waitForSelector('#_rewind', { state: 'visible', timeout: 20000 }).then(() => true, () => false);
        if (!over && process.env.DEBUG) console.log('   экран:', await ev(() => ({ scene: SceneManager._scene?.constructor?.name, rw: document.querySelector('#_rewind')?.style.display, cards: document.querySelectorAll('#_rewind ._rw_card').length, text: document.querySelector('#_rewind ._rw_strip')?.textContent?.slice(0, 80) })));
        if (!over) fail('«Игра окончена» не открыла плёнку');
        else {
            await page.waitForFunction(() => !document.querySelector('#_rewind ._rw_go').disabled, null, { timeout: 8000 });
            await page.keyboard.press('Enter');
            let mapAgain = false;
            for (let i = 0; i < 40 && !mapAgain; i++) { mapAgain = await ev(() => SceneManager._scene instanceof Scene_Map).catch(() => false); if (!mapAgain) await page.waitForTimeout(250); }
            if (mapAgain) ok('после «Игра окончена» — снова на карте');
            else fail('после «Игра окончена» на карту не вернулись');
        }
    } catch (e) {
        result.status = 'FAIL';
        result.steps.push(`СБОЙ: ${e.message.split('\n')[0].slice(0, 140)}`);
    }
    if (errors.length) result.status = 'FAIL';
    results.push(result);
    console.log(`[${result.status}] ${game.id}\n   ${result.steps.join('\n   ')}${errors.length ? `\n   ошибки: ${[...new Set(errors)].slice(0, 3).join(' / ')}` : ''}`);
    await ctx.close();
}
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/rewind.json`, JSON.stringify(results, null, 2));
console.log(`\nИтог: ${results.filter((r) => r.status === 'OK').length} из ${results.length} — без замечаний`);
await browser.close();
process.exit(results.some((r) => r.status !== 'OK') ? 1 : 0);
