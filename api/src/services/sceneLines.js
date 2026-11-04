// Поиск по репликам сцен во всех играх: «муж» или «husband» → сцены, где так говорят, и номер реплики, на которой
// плеер откроется сразу. Индекс — отдельный файл-кэш _media/scene-lines.db, не library.db: он весит сотню мегабайт и
// раздул бы копию базы в Telegram (предел 50 МБ) и архивы. Его всегда можно стереть и собрать заново из сценариев
// галереи (gallery.js, writeScripts): реплики берёт тот же sceneLangs.serve, что и плеер, — в индексе ровно тот текст,
// что видно в сцене, а номер остановки (say и choice подряд) совпадает с e.stops плеера.
// Поиск — FTS5 unicode61 по «форме для поиска» (fold): trigram на замерах в 6 раз толще, не умеет запросы из 1–2 знаков
// CJK и шумит на подстроках («her» находит «there»)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const scenes = require('./galleryScenes.js');
const sceneLangs = require('./sceneLangs.js');
const { scopeKey } = require('./gameAccess.js');

// Другая схема — файл стирается и строится заново: это только кэш
const SCHEMA = 1;
// Другие правила отбора реплик (collect) — игры переиндексируются по одной, поиск тем временем идёт по прежним.
// 2 — без реплик из одного имени («Matis: ...») и системных строк «■…»
const RULES = 2;
const FILE = 'scene-lines.db';
const CANDIDATES = 1000;      // кандидатов из FTS по bm25 — дальше группировка в JS
const PER_SCENE = 3;          // реплик сцены в ответе (остальные — числом more)
const SNIPPET = 160;          // длина фрагмента длинной реплики
const MEMO = 50;              // ответов в памяти; любая запись в индекс их сбрасывает
const TOUCH_MS = 60 * 1000;   // перевод Mimikin закончился — переиндексация через минуту (их бывает несколько подряд)
const FIRST_MS = 2 * 60 * 1000;
const EVERY_MS = 60 * 60 * 1000;
const BATCH = 2000;

// Письменности без пробелов между словами: каждый знак — отдельное слово индекса, тогда «夫» и «旦那» находятся
// внутри любой фразы. Хангыль пишется словами — остаётся как есть
const SOLID = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}ー々〆]/u;
const LATIN = /\p{Script=Latin}/u;
const WORD = /[\p{L}\p{N}]/u;
// Найти тут нечего: одно имя без слов («Matis: ...», «Мужчина А: …», «ミナ：……» — имя, которое игра пишет в строку) или
// системная строка игры («■Получено ? урона», «■Ямэмото - Атака +2»): ■ и □ в начале — пометка игры, имя с ними speech()
// уже снял. После двоеточия — пробел и знаки: «Слушай:» и «Yes:)» — реплики
const EMPTY_SAY = /^[^:：\n]{1,24}(?::\s+|：\s*)[^\p{L}\p{N}\s][^\p{L}\p{N}]*$/u;
const SYSTEM_ROW = /^[■□]/;
const noise = (text) => EMPTY_SAY.test(text) || SYSTEM_ROW.test(text);

// Приведение одного знака: NFKC («ＡＢＣ» → «abc»), нижний регистр, ё → е; у латиницы — без диакритики («naïve» →
// «naive»). Только у латиницы: NFD у каны отделил бы дакутэн, и «が» перестала бы находиться
function foldChar(c) {
    let f = c.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
    if (LATIN.test(c)) f = f.normalize('NFD').replace(/\p{M}/gu, '');
    return f;
}

// Одно правило для индекса, запроса и подсветки. split — знаки SOLID окружить пробелами (для FTS)
function fold(s, split = false) {
    let out = '';
    for (const c of String(s ?? '')) {
        const f = foldChar(c);
        out += split && SOLID.test(c) ? ` ${f} ` : f;
    }
    return out;
}

// fold без пробелов и с картой: from[i]/to[i] — где в исходной строке знак, давший i-й знак результата (для подсветки)
function foldMap(s) {
    let text = '';
    const from = [];
    const to = [];
    let at = 0;
    for (const c of String(s ?? '')) {
        const f = foldChar(c);
        for (let i = 0; i < f.length; i++) { from.push(at); to.push(at + c.length); }
        text += f;
        at += c.length;
    }
    return { text, from, to };
}

// Запрос → { match, terms } или null, если искать нечего («он», «t»). Слова от двух букв — приставкой («муж» находит
// «мужем»), подряд идущие знаки CJK — фразой. Всё в кавычках: синтаксис FTS5 (OR, NEAR, *, -) из запроса не протекает.
// Годится, если есть знак CJK или в словах в сумме от трёх букв. Однобуквенные слова выпадают: «won't» иначе тянул бы
// 0,2 с на «t»
function parseQuery(q) {
    const folded = fold(String(q ?? '').slice(0, 100), true);
    const out = [];
    const terms = [];
    let run = [];
    let letters = 0;
    let solid = false;
    const flush = () => { if (run.length) { out.push(`"${run.join(' ')}"`); terms.push({ text: run.join(''), solid: true }); run = []; } };
    for (const w of folded.split(/[^\p{L}\p{N}]+/u)) {
        if (!w) continue;
        if ([...w].length === 1 && SOLID.test(w)) { run.push(w); solid = true; continue; }
        flush();
        if ([...w].length < 2) continue;
        letters += [...w].length;
        out.push(`"${w}"*`);
        terms.push({ text: w, solid: false });
    }
    flush();
    if (!out.length || (!solid && letters < 3)) return null;
    return { match: out.join(' '), terms };
}

// Где в реплике найденные слова: [[от, до]] в исходной строке. Слово — от его начала до конца (запрос — приставка),
// фраза CJK — где угодно
function hits(text, terms) {
    const m = foldMap(text);
    const out = [];
    for (const t of terms) {
        let i = m.text.indexOf(t.text);
        while (i >= 0) {
            if (t.solid || i === 0 || !WORD.test(m.text[i - 1])) {
                let end = i + t.text.length;
                if (!t.solid) while (end < m.text.length && WORD.test(m.text[end])) end++;
                out.push([m.from[i], m.to[end - 1]]);
            }
            i = m.text.indexOf(t.text, i + Math.max(1, t.text.length));
        }
    }
    out.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const h of out) {
        const last = merged.at(-1);
        if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]); else merged.push([...h]);
    }
    return merged;
}

// Длинная реплика — окно до SNIPPET знаков вокруг первого совпадения, с «…» по краям; hl сдвигаются вместе с ней
function snippet(text, hl) {
    if (text.length <= SNIPPET) return { text, hl };
    const first = hl[0]?.[0] ?? 0;
    let start = Math.max(0, first - 50);
    const end = Math.min(text.length, start + SNIPPET);
    start = Math.max(0, end - SNIPPET);
    // Не резать суррогатную пару пополам
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
    const head = start > 0 ? '…' : '';
    const shift = head.length - start;
    const body = `${head}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
    return { text: body, hl: hl.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a + shift, b + shift]) };
}

class SceneLines {
    constructor() {
        this.gallery = null;
        this.translate = null;
        this.mediaDir = '';
        this.db = null;
        this.opening = null;
        this.failedAt = 0;
        this.chain = Promise.resolve();   // записи в индекс — по одной
        this.memo = new Map();
        this.touched = new Map();         // игра → таймер переиндексации
        this.progress = null;             // { done, total } — идёт проход по библиотеке
    }

    setDependencies({ gallery, translate, mediaDir }) {
        this.gallery = gallery;
        this.translate = translate || null;
        this.mediaDir = mediaDir || gallery?.mediaDir || '';
    }

    file() { return path.join(this.mediaDir, FILE); }

    // Файл индекса: не открылся, битый или другой схемы — стираем и создаём заново. Совсем не вышло — null (поиск
    // ответит 503) и новая попытка не раньше чем через минуту
    async open() {
        if (this.db) return this.db;
        if (!this.mediaDir || Date.now() - this.failedAt < 60 * 1000) return null;
        if (!this.opening) this.opening = this.connect().finally(() => { this.opening = null; });
        return this.opening;
    }

    async connect() {
        const file = this.file();
        for (let attempt = 0; attempt < 2; attempt++) {
            let db = null;
            try {
                await fsp.mkdir(this.mediaDir, { recursive: true });
                db = await open({ filename: file, driver: sqlite3.Database });
                await db.exec('PRAGMA busy_timeout = 5000');
                const v = (await db.get('PRAGMA user_version')).user_version;
                if (v !== SCHEMA) {
                    if (v !== 0 || (await db.get("SELECT count(*) c FROM sqlite_master")).c) throw new Error(`схема ${v}`);
                    await db.exec('PRAGMA journal_mode = WAL');
                    await db.exec(`BEGIN;
                        CREATE TABLE game (id TEXT PRIMARY KEY, stamp TEXT, lines INTEGER, at INTEGER);
                        CREATE TABLE scene (id INTEGER PRIMARY KEY, game TEXT, key TEXT, n INTEGER, kind TEXT, title TEXT, cover TEXT, pics TEXT);
                        CREATE INDEX scene_game ON scene(game);
                        CREATE TABLE line (id INTEGER PRIMARY KEY, scene INTEGER, stop INTEGER, lang TEXT, who TEXT, text TEXT, pic INTEGER, choice INTEGER);
                        CREATE INDEX line_scene ON line(scene);
                        CREATE VIRTUAL TABLE line_fts USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
                        PRAGMA user_version = ${SCHEMA};
                        COMMIT;`);
                }
                this.db = db;
                return db;
            } catch (e) {
                console.warn(`[Реплики] индекс не открылся (${e.message}) — строю заново`);
                await db?.close().catch(() => {});
                for (const f of [file, `${file}-wal`, `${file}-shm`]) await fsp.rm(f, { force: true }).catch(() => {});
            }
        }
        this.failedAt = Date.now();
        return null;
    }

    async close() {
        const db = this.db;
        this.db = null;
        await db?.close().catch(() => {});
    }

    // Записи — по одной (транзакции на одном соединении не вкладываются); сбой одной не останавливает следующие
    serial(job) {
        const run = this.chain.then(job);
        this.chain = run.catch(() => {});
        return run;
    }

    // Отпечаток игры: другая схема, другая версия таблиц языков (а с ней и разбор реплик), новая сборка галереи или
    // другой язык перевода Mimikin — переиндексировать
    stampOf(index, mt) { return `${SCHEMA}|${sceneLangs.VERSION}|${RULES}|${index.scripts}|${mt}`; }

    // Реплики одной игры → индекс. force — перевод Mimikin поменялся (язык тот же, строки новые)
    indexGame(id, { force = false } = {}) {
        return this.serial(async () => {
            const db = await this.open();
            if (!db || !this.gallery) return false;
            const index = await this.gallery.cached(id);
            if (!index || !index.scripts) return this.drop(db, id);
            const mt = this.translate ? await this.translate.langOf(id).catch(() => '') : '';
            const stamp = this.stampOf(index, mt);
            const row = await db.get('SELECT stamp FROM game WHERE id = ?', [id]);
            if (row && row.stamp === stamp && !force) return false;
            const st = await fsp.stat(this.gallery.indexPath(id)).catch(() => null);
            const { sceneRows, lineRows } = await this.collect(id, index, mt);
            const sid = ((await db.get('SELECT max(id) m FROM scene')).m || 0) + 1;
            const lid = ((await db.get('SELECT max(id) m FROM line')).m || 0) + 1;
            await db.exec('BEGIN');
            try {
                await this.remove(db, id);
                for (let i = 0; i < sceneRows.length; i += BATCH) {
                    await db.run('INSERT INTO scene SELECT value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6, value->>7 FROM json_each(?)',
                        [JSON.stringify(sceneRows.slice(i, i + BATCH).map((r, j) => [sid + i + j, id, ...r]))]);
                }
                for (let i = 0; i < lineRows.length; i += BATCH) {
                    const part = lineRows.slice(i, i + BATCH).map((r, j) => [lid + i + j, sid + r[0], ...r.slice(1)]);
                    await db.run('INSERT INTO line SELECT value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6, value->>7 FROM json_each(?)',
                        [JSON.stringify(part.map((r) => r.slice(0, 8)))]);
                    await db.run('INSERT INTO line_fts(rowid, body) SELECT value->>0, value->>1 FROM json_each(?)', [JSON.stringify(part.map((r) => [r[0], r[8]]))]);
                }
                await db.run('INSERT INTO game (id, stamp, lines, at) VALUES (?, ?, ?, ?)', [id, stamp, lineRows.length, st ? Math.floor(st.mtimeMs) : 0]);
                await db.exec('COMMIT');
            } catch (e) {
                await db.exec('ROLLBACK').catch(() => {});
                throw e;
            }
            this.memo.clear();
            return true;
        });
    }

    // Сцены и реплики игры: [номер сцены, key, n, kind, title, cover, pics] и [номер сцены, stop, lang, who, text, pic,
    // choice, body]. Между сценами отпускаем цикл событий: у самой большой игры 40 тысяч реплик
    async collect(id, index, mt) {
        const T = await this.gallery.sceneLangs(id, index).catch(() => null);
        const sceneRows = [];
        const lineRows = [];
        for (const a of index.albums || []) {
            if (!a.script) continue;
            // Название и обложка — по правилу плиток «Сцен» (galleryView.js, sceneRows)
            const name = a.title || a.key.split('/').pop().replace(/(#\w+)+$/, '');
            const many = Array.isArray(a.scenes) && a.scenes.length;
            for (let n = 0; n < (many ? a.scenes.length : 1); n++) {
                await new Promise((done) => setImmediate(done));
                const data = await this.gallery.readJson(this.gallery.scriptPath(id, index.scripts, n ? `${a.key}\n${n}` : a.key));
                if (!data || !Array.isArray(data.steps)) continue;
                const g = many ? a.scenes[n] : null;
                const files = Array.isArray(data.files) ? data.files : a.files || [];
                let tr = null;
                if (mt && this.translate) {
                    const strings = new Set();
                    for (const x of data.steps) {
                        if (x.k === 'say') { for (const l of x.l) strings.add(l); if (x.n) strings.add(x.n); } else if (x.k === 'choice') for (const o of x.o) strings.add(o);
                        if (x.a) for (const v of Object.values(x.a)) strings.add(v);
                    }
                    tr = strings.size ? await this.translate.lookup(id, [...strings]).catch(() => new Map()) : null;
                }
                const serve = (code) => sceneLangs.serve(data, T, { want: [code], mt, tr, client: true }, scenes.speech);
                let base;
                try { base = serve('orig'); } catch { continue; }
                const no = sceneRows.length;
                const pics = [];
                const picNo = new Map();
                const stops = [];   // по остановке: { pic, seen: Set текстов }
                let pic = -1;
                for (const x of base.steps) {
                    if (x.k === 'pic') pic = x.i >= 0 && files[x.i] ? x.i : -1;
                    else if (x.k === 'anim') pic = Array.isArray(x.f) && x.f[0] >= 0 && files[x.f[0]] ? x.f[0] : pic;
                    if (x.k !== 'say' && x.k !== 'choice') continue;
                    let p = -1;
                    if (pic >= 0) {
                        if (!picNo.has(pic)) { picNo.set(pic, pics.length); pics.push(files[pic]); }
                        p = picNo.get(pic);
                    }
                    stops.push({ pic: p, seen: new Set() });
                }
                const add = (steps, lang) => {
                    let stop = 0;
                    for (const x of steps) {
                        if (x.k !== 'say' && x.k !== 'choice') continue;
                        const s = stops[stop];
                        const no2 = stop++;
                        if (!s) break;
                        const text = x.k === 'say' ? String(x.text || '') : x.o.join('\n');
                        // Реплики без букв и цифр («……!?»), одно имя и системные строки не ищутся; одинаковый текст на одной остановке — один раз
                        if (!WORD.test(text) || (x.k === 'say' && noise(text)) || s.seen.has(text)) continue;
                        s.seen.add(text);
                        lineRows.push([no, no2, lang, x.k === 'say' ? x.who || '' : '', text, s.pic, x.k === 'choice' ? 1 : 0, fold(text, true)]);
                    }
                };
                add(base.steps, 'orig');
                for (const o of base.langs || []) {
                    if (o.orig) continue;
                    try { add(serve(o.code).steps, o.code); } catch { /* язык сцены не собрался — только оригинал */ }
                }
                sceneRows.push([a.key, n, a.kind || '', (g ? g.t || name : name).slice(0, 200),
                    (g ? a.files?.[g.f?.[0]] : '') || a.cover || a.files?.[0] || '', JSON.stringify(pics)]);
            }
        }
        // Сцены без единой найденной реплики не храним
        const used = new Set(lineRows.map((r) => r[0]));
        const keep = new Map();
        const scenesOut = [];
        sceneRows.forEach((r, i) => { if (used.has(i)) { keep.set(i, scenesOut.length); scenesOut.push(r); } });
        for (const r of lineRows) r[0] = keep.get(r[0]);
        return { sceneRows: scenesOut, lineRows };
    }

    async remove(db, id) {
        await db.run('DELETE FROM line_fts WHERE rowid IN (SELECT l.id FROM line l JOIN scene s ON s.id = l.scene WHERE s.game = ?)', [id]);
        await db.run('DELETE FROM line WHERE scene IN (SELECT id FROM scene WHERE game = ?)', [id]);
        await db.run('DELETE FROM scene WHERE game = ?', [id]);
        await db.run('DELETE FROM game WHERE id = ?', [id]);
    }

    async drop(db, id) {
        if (!(await db.get('SELECT 1 FROM game WHERE id = ?', [id]))) return false;
        await db.exec('BEGIN');
        try { await this.remove(db, id); await db.exec('COMMIT'); } catch (e) { await db.exec('ROLLBACK').catch(() => {}); throw e; }
        this.memo.clear();
        return true;
    }

    // Игру убрали (корзина) или галерею сбросили (forget) — её реплик в поиске больше нет
    dropGame(id) {
        return this.serial(async () => {
            const db = await this.open();
            return db ? this.drop(db, id) : false;
        });
    }

    // Перевод Mimikin поменялся: переиндексировать через минуту — один раз на серию изменений
    touch(id, ms = TOUCH_MS) {
        clearTimeout(this.touched.get(id));
        const timer = setTimeout(() => {
            this.touched.delete(id);
            this.indexGame(id, { force: true }).catch((e) => console.warn(`[Реплики] ${id}: ${e.message}`));
        }, ms);
        timer.unref?.();
        this.touched.set(id, timer);
    }

    // Проход по библиотеке: изменившиеся игры — заново, чужие (удалённые насовсем) — вон. Быстрая проверка — по времени
    // записи gallery.json и отпечатку без языка перевода (его меняет touch)
    async sweep(ids) {
        if (this.progress) return false;
        const db = await this.open();
        if (!db || !this.gallery) return false;
        this.progress = { done: 0, total: ids.length };
        let changed = false;
        try {
            const rows = new Map((await db.all('SELECT id, stamp, at FROM game')).map((r) => [r.id, r]));
            for (const id of ids) {
                const row = rows.get(id);
                const st = await fsp.stat(this.gallery.indexPath(id)).catch(() => null);
                const same = row && st && row.at === Math.floor(st.mtimeMs) && row.stamp.startsWith(`${SCHEMA}|${sceneLangs.VERSION}|${RULES}|`);
                if (!same) {
                    try { changed = (st ? await this.indexGame(id) : await this.dropGame(id)) || changed; } catch (e) { console.warn(`[Реплики] ${id}: ${e.message}`); }
                }
                this.progress.done++;
            }
            const keep = new Set(ids);
            for (const id of rows.keys()) if (!keep.has(id)) changed = (await this.dropGame(id)) || changed;
            if (changed) await this.serial(() => db.exec("INSERT INTO line_fts(line_fts) VALUES('optimize')"));
        } finally {
            this.progress = null;
        }
        return changed;
    }

    // Первый проход — через 2 минуты после старта (сервер успевает подняться), дальше раз в час
    start(listIds) {
        const run = async () => { await this.sweep(await listIds()); };
        const first = setTimeout(() => run().catch((e) => console.error('[Реплики]', e.message)), FIRST_MS);
        first.unref?.();
        const every = setInterval(() => run().catch((e) => console.error('[Реплики]', e.message)), EVERY_MS);
        every.unref?.();
    }

    // Поиск. ids — игры библиотеки; game — только эта; limit — сколько сцен. null — индекс недоступен
    async search(q, { ids = [], game = '', limit = 24 } = {}) {
        const parsed = parseQuery(q);
        if (!parsed) return { error: 'short' };
        const db = await this.open();
        if (!db) return null;
        const scope = game ? ids.filter((x) => x === game) : ids;
        // В ключе — весь набор игр: у двух людей он может совпасть по длине и по краям, а внутри отличаться, и чужие находки
        // достались бы не тому (services/gameAccess.js)
        const memoKey = JSON.stringify([q, game, limit, scopeKey(new Set(ids))]);
        if (this.memo.has(memoKey)) return this.memo.get(memoKey);
        const json = JSON.stringify(scope);
        const per = await db.all(`SELECT s.game, count(*) lines, count(DISTINCT l.scene) scenes FROM line_fts f JOIN line l ON l.id = f.rowid JOIN scene s ON s.id = l.scene
            WHERE line_fts MATCH ? AND s.game IN (SELECT value FROM json_each(?)) GROUP BY s.game ORDER BY lines DESC`, [parsed.match, json]);
        const cand = await db.all(`SELECT f.rowid id, f.rank, l.scene, l.stop, l.lang, l.who, l.text, l.pic, l.choice, s.game, s.key, s.n, s.kind, s.title, s.cover, s.pics
            FROM line_fts f JOIN line l ON l.id = f.rowid JOIN scene s ON s.id = l.scene
            WHERE line_fts MATCH ? AND s.game IN (SELECT value FROM json_each(?)) ORDER BY f.rank LIMIT ${CANDIDATES}`, [parsed.match, json]);
        // Сначала реплики, где запрос стоит целиком, потом по bm25 (порядок SQL — sort устойчивый)
        const whole = fold(String(q).trim().replace(/\s+/g, ' '));
        const flat = (t) => fold(t).replace(/\s+/g, ' ');
        for (const r of cand) r.whole = flat(r.text).includes(whole) ? 1 : 0;
        cand.sort((a, b) => b.whole - a.whole);
        // Повторы в игре (тот же текст в сцене CG и в диалоге, в двух сценах) — один раз, на сцене с CG
        const kept = [];
        const at = new Map();
        for (const r of cand) {
            const k = `${r.game}\u0000${flat(r.text)}`;
            if (!at.has(k)) { at.set(k, kept.length); kept.push(r); } else if (kept[at.get(k)].kind === 'dialogue' && r.kind !== 'dialogue') kept[at.get(k)] = r;
        }
        const byScene = new Map();
        for (const r of kept) {
            if (!byScene.has(r.scene)) {
                if (byScene.size >= limit) continue;
                byScene.set(r.scene, { r, lines: [] });
            }
            const s = byScene.get(r.scene);
            if (s.lines.length < PER_SCENE) s.lines.push(r);
        }
        const counts = byScene.size ? new Map((await db.all(`SELECT l.scene, count(*) c FROM line_fts f JOIN line l ON l.id = f.rowid
            WHERE line_fts MATCH ? AND l.scene IN (SELECT value FROM json_each(?)) GROUP BY l.scene`, [parsed.match, JSON.stringify([...byScene.keys()])])).map((x) => [x.scene, x.c])) : new Map();
        const indexed = (await db.get('SELECT count(*) c FROM game WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)])).c;
        const out = {
            total: per.reduce((sum, g) => sum + g.lines, 0),
            games: per.map((g) => ({ id: g.game, lines: g.lines, scenes: g.scenes })),
            indexed,
            library: ids.length,
            building: this.progress ? { ...this.progress } : null,
            scenes: [...byScene.entries()].map(([id, { r, lines }]) => {
                let pics = [];
                try { pics = JSON.parse(r.pics || '[]'); } catch { pics = []; }
                return {
                    game: r.game, key: r.key, n: r.n, kind: r.kind, title: r.title, cover: r.cover,
                    lines: lines.sort((a, b) => a.stop - b.stop).map((l) => {
                        const cut = snippet(l.text, hits(l.text, parsed.terms));
                        // cut — текст обрезан: плеер сверяет реплику только по номеру
                        return { stop: l.stop, lang: l.lang, who: l.who, text: cut.text, hl: cut.hl, pic: pics[l.pic] || '', ...(l.choice ? { choice: true } : {}), ...(cut.text !== l.text ? { cut: true } : {}) };
                    }),
                    more: Math.max(0, (counts.get(id) || 0) - lines.length),
                };
            }),
        };
        if (this.memo.size >= MEMO) this.memo.delete(this.memo.keys().next().value);
        this.memo.set(memoKey, out);
        return out;
    }
}

module.exports = new SceneLines();
module.exports.SceneLines = SceneLines;
module.exports.fold = fold;
module.exports.parseQuery = parseQuery;
module.exports.hits = hits;
module.exports.snippet = snippet;
module.exports.SCHEMA = SCHEMA;
