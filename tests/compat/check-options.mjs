// Проверка настроек: на титульном экране открываем «Опции», меняем каждую стандартную
// настройку (и язык, если он там есть), закрываем, смотрим, что игра отправила на
// сохранение, и открываем опции снова — изменения должны остаться.
//
// ЗАПИСЬ НА СЕРВЕР ПЕРЕХВАТЫВАЕТСЯ. Настройки игр лежат в _saves рядом с настоящими
// конфигами владельца, поэтому POST и DELETE на /api/saves до сервера не доходят:
// тест только читает, что игра пыталась записать, и отвечает «ок».
//
// Запуск: docker compose run --rm --no-deps compat node check-options.mjs
// Одна игра: docker compose run --rm --no-deps -e ONLY='Elena' compat node check-options.mjs
// Результат: report/options.json
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = process.env.BASE_URL ?? 'http://rpg-library:3000';
const USER = process.env.RPG_USER;
const PASS = process.env.RPG_PASS;
const STEP_MS = Number(process.env.STEP_MS ?? 30000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const ONLY = process.env.ONLY;
const OUT = 'report';
const READY = ['Scene_Title', 'Scene_TitleMap', 'Scene_Map'];
// Стандартные пункты опций MV и MZ. Свои пункты плагинов не трогаем: у них бывают
// свои правила, и «не поменялось» там не обязательно значит «сломано»
const STANDARD = ['alwaysDash', 'commandRemember', 'touchUI', 'bgmVolume', 'bgsVolume', 'meVolume', 'seVolume'];
const LANG = /lang|locale|language|язык|言語|sprache|idioma/i;

if (!USER || !PASS) throw new Error('Задай RPG_USER и RPG_PASS (логин dev-сервера)');

function withTimeout(promise, ms, what) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: нет ответа ${ms / 1000} с`)), ms);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const api = await browser.newContext();
const login = await api.request.post(`${BASE_URL}/api/login`, { data: { username: USER, password: PASS } });
if (!login.ok()) throw new Error(`Логин не удался: HTTP ${login.status()}`);
const authState = await api.storageState();
let games = await (await api.request.get(`${BASE_URL}/api/games`)).json();
// Игры открываются на сервере игр по ключу (api/src/routes/play.js); внутри сети Docker он —
// rpg-library:3001. GAME_ISOLATION=off — по-старому, на адресе библиотеки
const GAME_URL = process.env.GAME_URL ?? 'http://rpg-library:3001';
for (const game of games) {
    const play = await (await api.request.post(`${BASE_URL}/api/play/${encodeURIComponent(game.id)}`)).json().catch(() => ({}));
    game.launch = play.mode === 'frame' ? `${GAME_URL}${play.path}` : `${BASE_URL}${play.path || game.url}`;
}
await api.close();
if (ONLY) games = games.filter(g => new RegExp(ONLY, 'i').test(g.id));
await mkdir(OUT, { recursive: true });
console.log(`Проверяю настройки в ${games.length} играх, параллельно ${CONCURRENCY}`);

async function checkGame(game, page, writes) {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const scene = () => page.evaluate(() => window.SceneManager?._scene?.constructor?.name ?? null).catch(() => null);
    const errorScreen = () => page.evaluate(() =>
        document.querySelector('#ErrorPrinter, #errorPrinter')?.textContent?.trim() || null).catch(() => null);
    const waitScene = async (ok, { skip = false, ms = STEP_MS } = {}) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const s = await scene();
            const err = await errorScreen();
            if (err) return { scene: s, error: err };
            if (ok(s)) return { scene: s };
            if (skip && s && s !== 'Scene_Boot') {
                // Заставки пропускаем Enter'ом; держим дольше кадра, иначе нажатие проскакивает
                await page.keyboard.down('Enter');
                await page.waitForTimeout(400);
                await page.keyboard.up('Enter');
            }
            await page.waitForTimeout(400);
        }
        return { scene: await scene(), timeout: true };
    };
    const r = { id: game.id, engine: null, ok: false, detail: '', language: null, errors };

    // --- до титула
    await page.goto(game.launch, { waitUntil: 'domcontentloaded', timeout: STEP_MS });
    const boot = await waitScene(s => READY.includes(s), { skip: true });
    r.engine = await page.evaluate(() => window.Utils?.RPGMAKER_NAME ? `${Utils.RPGMAKER_NAME} ${Utils.RPGMAKER_VERSION ?? ''}`.trim() : null).catch(() => null);
    if (boot.error || boot.timeout) {
        r.detail = boot.error ? `экран ошибки при запуске: ${boot.error.slice(0, 120)}` : `не дошла до титула (сцена ${boot.scene})`;
        return r;
    }
    await page.waitForTimeout(2500);   // титул проявляется из чёрного

    const openOptions = async () => {
        // Как кнопка «Опции» на титуле: её обработчик ещё и закрывает окно команд, и часть
        // игр на возврате рассчитывает именно на это. Если кнопки нет — открываем напрямую
        await page.evaluate(() => {
            const sc = SceneManager._scene;
            if (typeof sc?.commandOptions === 'function') sc.commandOptions();
            else SceneManager.push(Scene_Options);
        });
        const opened = await waitScene(s => s === 'Scene_Options', { ms: 15000 });
        await page.waitForTimeout(1200);
        return opened;
    };
    const closeOptions = async () => {
        await page.evaluate(() => SceneManager.pop());
        return waitScene(s => s && s !== 'Scene_Options', { ms: 15000 });
    };

    // --- 1. Открыли и поменяли всё стандартное
    const opened = await openOptions();
    if (opened.scene !== 'Scene_Options') {
        r.detail = opened.error ? `экран ошибки в опциях: ${opened.error.slice(0, 120)}` : `опции не открылись (сцена ${opened.scene})`;
        return r;
    }
    const changed = await page.evaluate(({ STANDARD, LANG_SRC }) => {
        const LANG = new RegExp(LANG_SRC, 'i');
        const w = SceneManager._scene._optionsWindow;
        const list = w?._list || [];
        // Значение — из ConfigManager: окно опций у некоторых плагинов отдаёт своё
        // (у Ironhold Keep getConfigValue('alwaysDash') возвращает NaN)
        const read = (sym) => { const v = ConfigManager[sym]; return typeof v === 'boolean' || (typeof v === 'number' && !isNaN(v)) ? v : undefined; };
        const out = { items: [], language: null };
        for (const sym of STANDARD) {
            if (!list.some(c => c.symbol === sym) || read(sym) === undefined) continue;
            const from = read(sym);
            const to = typeof from === 'boolean' ? !from : (from >= 60 ? from - 40 : from + 40);
            w.changeValue(sym, to);
            out.items.push({ sym, from, to, now: read(sym) });
        }
        // Язык: переключаем, как стрелкой вправо. Он остаётся переключённым — так и
        // проверим, сохранился ли он вместе с остальными настройками
        const li = list.findIndex(c => LANG.test(`${c.symbol} ${c.name}`));
        if (li >= 0) {
            const sym = list[li].symbol;
            const val = () => { try { return JSON.stringify(w.getConfigValue(sym)); } catch { return '?'; } };
            const text = () => { try { return w.statusText(li); } catch { return '?'; } };
            const before = { value: val(), text: text() };
            w.select(li);
            w.cursorRight(false);
            if (val() === before.value && typeof w.processOk === 'function') w.processOk();
            w.refresh();
            out.language = { sym, name: list[li].name, from: before.text, to: text(), switched: val() !== before.value || text() !== before.text, value: val() };
        }
        return out;
    }, { STANDARD, LANG_SRC: LANG.source }).catch(e => ({ error: e.message.split('\n')[0] }));
    if (changed.error) { r.detail = `ошибка при смене настроек: ${changed.error}`; return r; }
    const stuck = changed.items.filter(i => i.now !== i.to);

    // --- 2. Закрыли — игра должна сохранить настройки. Что она отправила, расшифровываем
    const writesBefore = writes.length;
    const back = await closeOptions();
    await page.waitForTimeout(2500);
    if (back.error) { r.detail = `экран ошибки после выхода из опций: ${back.error.slice(0, 120)}`; return r; }
    const configWrite = writes.slice(writesBefore).reverse().find(w => /config/i.test(w.key));
    let saved = null;
    if (configWrite) {
        saved = await page.evaluate((raw) => {
            let v = raw;
            try { v = JSON.parse(raw).value ?? raw; } catch {}
            // MZ хранит настройки сжатыми в zip+base64, MV — в LZString+base64 или как есть
            const tries = [
                () => JSON.parse(v),
                // MZ: zipToJson асинхронный, поэтому распаковываем тем же pako напрямую
                () => JSON.parse(pako.inflate(v, { to: 'string' })),
                () => JSON.parse(LZString.decompressFromBase64(v)),
            ];
            for (const t of tries) { try { const o = t(); if (o && typeof o === 'object') return o; } catch {} }
            return null;
        }, configWrite.body).catch(() => null);
    }
    const notSaved = saved ? changed.items.filter(i => saved[i.sym] !== i.to) : changed.items;

    // --- 3. Открыли снова — значения должны остаться
    const again = await openOptions();
    let lost = [];
    if (again.scene === 'Scene_Options') {
        lost = await page.evaluate((items) => items.filter(i => ConfigManager[i.sym] !== i.to).map(i => i.sym), changed.items).catch(() => ['?']);
        await closeOptions();
    }

    // --- итог
    const names = changed.items.map(i => i.sym);
    r.language = changed.language;
    // Язык у части плагинов хранится не в общем конфиге — это пометка, а не провал
    if (r.language && saved) r.language.saved = r.language.sym in saved ? JSON.stringify(saved[r.language.sym]) === r.language.value : null;
    if (!names.length && !changed.language) { r.ok = true; r.detail = 'стандартных настроек нет — у игры свои опции'; return r; }
    const problems = [];
    if (stuck.length) problems.push(`не меняется: ${stuck.map(i => i.sym).join(', ')}`);
    if (!configWrite) problems.push('игра не пыталась сохранить настройки');
    else if (!saved) problems.push(`сохранение (${configWrite.key}) не удалось прочитать`);
    else if (notSaved.length) problems.push(`не попало в сохранение: ${notSaved.map(i => i.sym).join(', ')}`);
    if (again.scene !== 'Scene_Options') problems.push('повторно опции не открылись');
    else if (lost.length) problems.push(`после повторного открытия сбросилось: ${lost.join(', ')}`);
    if (changed.language && !changed.language.switched) problems.push(`язык «${changed.language.name}» не переключается`);
    r.ok = problems.length === 0;
    r.detail = r.ok
        ? `изменено ${names.length}: ${names.join(', ')}; сохранено (${configWrite.key}) и осталось после повторного открытия`
        : problems.join('; ');
    return r;
}

const results = [];
const saveReport = () => writeFile(`${OUT}/options.json`, JSON.stringify(results, null, 2));
let next = 0;
async function worker() {
    while (next < games.length) {
        const game = games[next++];
        const ctx = await browser.newContext({ viewport: { width: 816, height: 624 }, storageState: authState });
        const writes = [];
        await ctx.route('**/api/saves/**', (route) => {
            const req = route.request();
            if (req.method() === 'GET') return route.continue();
            writes.push({ method: req.method(), key: decodeURIComponent(new URL(req.url()).pathname.split('/').pop()), body: req.postData() || '' });
            return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
        });
        const page = await ctx.newPage();
        const started = Date.now();
        const r = await withTimeout(checkGame(game, page, writes), STEP_MS * 5, 'Проверка').catch(e => ({
            id: game.id, engine: null, ok: false, detail: e.message, language: null, errors: [],
        }));
        r.seconds = Math.round((Date.now() - started) / 1000);
        await withTimeout(ctx.close(), 10000, 'Закрытие').catch(() => {});
        results.push(r);
        await saveReport();
        console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(r.seconds).padStart(3)}с  ${game.id}${r.ok ? '' : '  — ' + r.detail}`);
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await browser.close();

const ok = results.filter(r => r.ok).length;
console.log(`\n=== Итог: ${ok} из ${results.length} ===`);
console.log('\n=== Языки ===');
for (const r of results.filter(x => x.language)) {
    const l = r.language;
    const kept = l.saved === true ? ', сохранился' : l.saved === false ? ', НЕ сохранился' : ', хранится вне общего конфига';
    console.log(`${l.switched ? '✔' : '✘'} ${r.id}: «${l.name}» ${l.from} → ${l.to}${kept}`);
}
const fails = results.filter(r => !r.ok);
if (fails.length) {
    console.log('\n=== Проблемы ===');
    for (const r of fails) console.log(`${r.id} (${r.engine ?? '?'}): ${r.detail}`);
}
