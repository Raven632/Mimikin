// Проверка совместимости: открывает каждую игру в headless Chromium и смотрит,
// дошла ли она до титульного экрана (или сразу до карты).
// Результат: таблица в консоли, report/report.json и скриншот каждой игры.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = process.env.BASE_URL ?? 'http://rpg-library:3000';
const USER = process.env.RPG_USER;
const PASS = process.env.RPG_PASS;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const ONLY = process.env.ONLY; // регулярное выражение по id: 'Elena' или 'Ironhold|Seven_Keys'
const OUT = 'report';
// Сцены, до которых должна дойти рабочая игра (некоторые пропускают титул и сразу грузят карту)
const READY_SCENES = ['Scene_Title', 'Scene_Map', 'Scene_TitleMap'];

if (!USER || !PASS) throw new Error('Задай RPG_USER и RPG_PASS (логин dev-сервера)');

// Любое ожидание — с пределом. Если главный поток игры завис, page.evaluate ждёт ответа
// вечно: у Playwright на него нет таймаута. Promise.race — «кто первый: результат или таймер».
function withTimeout(promise, ms, what) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: нет ответа ${ms / 1000} с`)), ms);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// SwiftShader — программный WebGL: в контейнере нет видеокарты, а движку нужен WebGL
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const VIEWPORT = { width: 816, height: 624 };

// Логинимся через API один раз и запоминаем куку (storageState), чтобы выдать её каждой игре
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
console.log(`Проверяю ${games.length} игр: таймаут ${TIMEOUT_MS / 1000} с, параллельно ${CONCURRENCY}`);

// progress — «последнее, что видели»: если игра зависнет, по нему понятно, на каком этапе
async function checkGame(game, page, progress) {
    const errors = [];
    const missing = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => {
        if (r.status() >= 400) missing.push(`${r.status()} ${decodeURIComponent(new URL(r.url()).pathname)}`);
    });

    const started = Date.now();
    let state = { scene: null, engine: null, errorScreen: null };
    try {
        await page.goto(game.launch, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
        // Ждём титул/карту или экран ошибки движка. Заставки пропускаем Enter'ом, как нетерпеливый
        // игрок: без видеокарты кадры считаются программно, и заставки «по кадрам» тянутся долго.
        const deadline = Date.now() + TIMEOUT_MS;
        let reached = false;
        while (Date.now() < deadline) {
            const { scene, error } = await page.evaluate(() => ({
                scene: window.SceneManager?._scene?.constructor?.name,
                error: document.querySelector('#ErrorPrinter, #errorPrinter')?.textContent?.trim(),
            })).catch(() => ({}));
            if (scene) progress.scene = scene;
            if (READY_SCENES.includes(scene) || error) { reached = true; break; }
            if (scene && scene !== 'Scene_Boot') {
                // Держим клавишу дольше кадра: движок опрашивает клавиатуру раз в кадр,
                // и мгновенное нажатие при медленном рендеринге проскакивает между опросами
                await page.keyboard.down('Enter');
                await page.waitForTimeout(500);
                await page.keyboard.up('Enter');
            }
            await page.waitForTimeout(500);
        }
        // Титул обычно проявляется из чёрного — даём ему время перед скриншотом
        if (reached) await page.waitForTimeout(3000);
        state = await page.evaluate(() => ({
            scene: window.SceneManager?._scene?.constructor?.name ?? null,
            engine: window.Utils?.RPGMAKER_NAME ? `${Utils.RPGMAKER_NAME} ${Utils.RPGMAKER_VERSION ?? ''}`.trim() : null,
            errorScreen: document.querySelector('#ErrorPrinter, #errorPrinter')?.textContent?.trim() || null,
        }));
    } catch (e) {
        errors.push(`Страница не открылась: ${e.message.split('\n')[0]}`);
    }
    await page.screenshot({ path: `${OUT}/${game.id.replace(/[^\w.-]/g, '_')}.png`, timeout: 10000 }).catch(() => {});

    const status = state.errorScreen ? 'ERROR_SCREEN'
        : !state.engine ? 'NO_ENGINE'
        : !state.scene || state.scene === 'Scene_Boot' ? 'STUCK_BOOT'
        : READY_SCENES.includes(state.scene) ? 'OK'
        : 'OTHER_SCENE';
    return {
        id: game.id, status, ...state,
        seconds: Math.round((Date.now() - started) / 1000),
        errors: [...new Set(errors)].slice(0, 10),
        missing: [...new Set(missing)].slice(0, 20),
    };
}

// Отчёт пишем после КАЖДОЙ игры: если прогон упадёт или его прервут, результаты не пропадут
const results = [];
const sortResults = list => [...list].sort((a, b) => a.status.localeCompare(b.status) || a.id.localeCompare(b.id));
const saveReport = () => writeFile(`${OUT}/report.json`, JSON.stringify(sortResults(results), null, 2));

// Простой пул: CONCURRENCY «рабочих» по очереди забирают игры из общего списка
let next = 0;
async function worker() {
    while (next < games.length) {
        const game = games[next++];
        // Каждая игра — в своём контексте (песочнице): свои процессы, свой localStorage.
        // Закрытие контекста гарантированно убивает всё, что игра после себя оставила.
        const gameContext = await browser.newContext({ viewport: VIEWPORT, storageState: authState });
        const page = await gameContext.newPage();
        const progress = { scene: null };
        const started = Date.now();
        // Сторожевой таймер на всю игру: зависшую вкладку закрываем и идём дальше
        const r = await withTimeout(checkGame(game, page, progress), TIMEOUT_MS * 3, 'Проверка').catch(e => ({
            id: game.id, status: 'HUNG', scene: progress.scene, engine: null, errorScreen: null,
            seconds: Math.round((Date.now() - started) / 1000), errors: [e.message], missing: [],
        }));
        await withTimeout(gameContext.close(), 10000, 'Закрытие контекста').catch(() => {});
        results.push(r);
        await saveReport();
        console.log(`${r.status.padEnd(12)} ${String(r.seconds).padStart(3)}с  ${r.id}`);
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await browser.close();

console.log('\n=== Итог ===');
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
for (const [status, n] of Object.entries(counts)) console.log(`${status}: ${n}`);

console.log('\n=== Проблемные игры ===');
for (const r of sortResults(results).filter(r => r.status !== 'OK')) {
    console.log(`\n[${r.status}] ${r.id}  (${r.engine ?? 'движок не загрузился'}, сцена: ${r.scene ?? '-'})`);
    if (r.errorScreen) console.log(`  экран ошибки: ${r.errorScreen.slice(0, 200)}`);
    for (const e of r.errors.slice(0, 3)) console.log(`  ошибка: ${e.slice(0, 200)}`);
    for (const m of r.missing.slice(0, 3)) console.log(`  нет файла: ${m}`);
}
