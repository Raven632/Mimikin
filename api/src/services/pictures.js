// «Перевести картинки»: текст, нарисованный на картинках игры (подписи статуса, кнопки, карточки персонажей).
// Картинки по очереди уходят в службу распознавания (ocr/, свой контейнер; адрес — OCR_URL), найденные подписи
// ложатся в ту же разметку, что и ручная (data/image-labels): тексты — в перевод игры, а rpg-fixes при загрузке
// картинки стирает подпись «заплаткой» и пишет перевод. Файлы игры не меняются — ни картинки, ни что-либо ещё.
//
// Результат — по хэшу картинки (picture_text): та же картинка в другой игре или версии не распознаётся заново,
// а поправленное на экране «Картинки» остаётся. Какая картинка игры какой хэш имеет — game_pictures (с размером
// и временем файла: файл поменялся — старая разметка к нему не применяется, пока его не разберут снова).
// Сначала — картинки интерфейса (system, titles, прозрачные и меньше экрана), картинки сцен — по желанию: их много,
// а текст на них редок. Подпись, в которой распознавание не уверено, выключена, пока её не проверят
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { decrypt, pngInfo, sha1, lexiconOf, snap } = require('../utils/picturetext.js');

const DIRS = ['img/system', 'img/titles2', 'img/titles1', 'img/pictures'];
const PICTURE = /\.(png|png_|rpgmvp)$/i;
const MAX_FILES = 30000;
const SECONDS = 1.5;                  // ≈ на картинку: поиск строк около секунды, чтение подписи — ещё 0.3 с
const HEALTH_MS = 30 * 1000;
const LIST_MS = 10 * 60 * 1000;
const MAX_PIXELS = 25000000;          // больше — не разбираем: в памяти службы картинка в разы больше файла
// Что из ответа службы нужно игре и экрану «Картинки»
const STYLE = ['x', 'y', 'w', 'h', 'maxW', 'align', 'size', 'color', 'outline', 'outlineWidth', 'bold', 'vertical'];

class OcrDown extends Error {}
class OcrFailed extends Error {}     // служба ответила ошибкой на эту картинку (не «испорчена») — разберём в следующий раз
const FAILS_IN_A_ROW = 5;             // столько сбоев подряд — служба не в порядке, разбор останавливается

// Дата на картинке («1987年10月12日») — правдоподобная: год до 4 цифр, месяц до 12, день до 31. В пиксельных шрифтах
// «9» похожа на «日», и оба распознавателя дружно читают «1日87年», — такую подпись надо проверить
function plausibleDate(text) {
    const t = String(text).normalize('NFKC');
    if (!/\d/.test(t) || !/[年月日]/.test(t)) return true;
    const core = t.replace(/[^\d年月日]/g, '');
    const m = /^(?:(\d{1,4})年)?(?:(\d{1,2})月)?(?:(\d{1,2})日)?$/.exec(core);
    if (!m || core === '') return false;
    return (!m[2] || (+m[2] >= 1 && +m[2] <= 12)) && (!m[3] || (+m[3] >= 1 && +m[3] <= 31));
}

const parse = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

class PictureService {
    constructor() {
        this.dbService = null;
        this.translate = null;            // services/translate.js: папка игры, словарь, очередь перевода
        this.url = String(process.env.OCR_URL || '').replace(/\/+$/, '');
        this.queue = [];                  // { id, scope, auto } — auto: фоновый пересчёт (upgrade)
        this.current = null;              // { id, scope, auto, done, total, stop, yield }
        this.running = null;
        this.health = { at: 0, value: null };
        this.lists = new Map();           // игра → { at, list }
        this.version = 0;                 // версия разбора службы (pipeline.VERSION): старше — разобрать заново
        this.recovered = false;           // recover отработал (дождался службы или нет)
        this.onChange = () => {};
        this.timeoutMs = 3 * 60 * 1000;
        this.fetch = (...args) => fetch(...args);   // тесты подставляют свой
        this.markupSets = null;                       // ручные разметки (по умолчанию — data/image-labels)
    }

    setDependencies({ dbService, translate, onChange }) {
        Object.assign(this, { dbService, translate });
        if (onChange) this.onChange = onChange;
    }

    db() { return this.dbService.get(); }

    // Служба отвечает? { ok, version, busy } или null. Ответ держим полминуты: окно игры спрашивает часто
    async available({ fresh = false, now = Date.now() } = {}) {
        if (!this.url) return null;
        if (!fresh && now - this.health.at < HEALTH_MS) return this.health.value;
        let value = null;
        try {
            const r = await this.fetch(`${this.url}/health`, { signal: AbortSignal.timeout(3000) });
            if (r.ok) value = await r.json();
        } catch (e) { value = null; }
        const was = this.version;
        if (value?.version) this.version = value.version;
        this.health = { at: now, value };
        // Службу обновили, а сервер не перезапускали, или она поднялась, когда recover её уже не дождался, —
        // пересчёт тоже сам
        if ((was || this.recovered) && value?.version > was) this.upgrade().catch((e) => console.warn('[Картинки] пересчёт:', e.message));
        return value;
    }

    async root(id) {
        const dir = await this.translate.dataDir(id);
        return dir ? path.join(dir, '..') : null;
    }

    // Размер экрана игры: у MZ — в System.json, у MV — стандартный 816×624
    async screen(root) {
        try {
            const sys = JSON.parse((await fsp.readFile(path.join(root, 'data', 'System.json'), 'utf8')).replace(/^﻿/, ''));
            const a = sys.advanced || {};
            return { w: Number(a.screenWidth) || 816, h: Number(a.screenHeight) || 624 };
        } catch (e) {
            return { w: 816, h: 624 };
        }
    }

    // Картинки игры: путь, размер, прозрачность — по первым байтам файла (зашифрованного — тоже).
    // kind: 'ui' — интерфейс (папки system и titles, прозрачные, меньше экрана), 'scene' — во весь экран без прозрачности
    async list(id, { fresh = false, now = Date.now() } = {}) {
        const hit = this.lists.get(id);
        if (!fresh && hit && now - hit.at < LIST_MS) return hit.list;
        const root = await this.root(id);
        if (!root) return [];
        const screen = await this.screen(root);
        const out = [];
        const head = Buffer.alloc(4096);
        const walk = async (abs, rel, depth) => {
            const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const e of entries) {
                if (out.length >= MAX_FILES) return;
                const relPath = `${rel}/${e.name}`;
                if (e.isDirectory() && depth < 6) { await walk(path.join(abs, e.name), relPath, depth + 1); continue; }
                if (!e.isFile() || !PICTURE.test(e.name)) continue;
                const file = path.join(abs, e.name);
                const fh = await fsp.open(file, 'r').catch(() => null);
                if (!fh) continue;
                let info = null;
                let st = null;
                try {
                    st = await fh.stat();
                    const { bytesRead } = await fh.read(head, 0, head.length, 0);
                    info = pngInfo(head.subarray(0, bytesRead), e.name);
                } catch (err) { info = null; } finally { await fh.close().catch(() => {}); }
                if (!info || info.w * info.h > MAX_PIXELS) continue;
                const dir = rel.split('/').slice(0, 2).join('/');
                const ui = dir !== 'img/pictures' || info.alpha || info.w < screen.w * 0.9 || info.h < screen.h * 0.9;
                out.push({
                    key: relPath.replace(PICTURE, ''), rel: relPath, file, size: st.size, mtime: Math.floor(st.mtimeMs),
                    w: info.w, h: info.h, kind: ui ? 'ui' : 'scene', order: DIRS.indexOf(dir),
                });
            }
        };
        for (const dir of DIRS) await walk(path.join(root, ...dir.split('/')), dir, 0);
        this.lists.delete(id);
        this.lists.set(id, { at: now, list: out });
        while (this.lists.size > 4) this.lists.delete(this.lists.keys().next().value);
        return out;
    }

    // Картинки игры, которые сейчас лежат в её папке: ключ → { size, mtime }. Удалённую или заменённую (обновление
    // игры) не показываем и не считаем
    async present(id) {
        return new Map((await this.list(id)).map((e) => [e.key, e]));
    }

    // Разобрана: тот же файл (размер и время) и либо этой версией службы, либо в ней правили руками (правки не теряем)
    fresh(k, e) {
        return !!k && k.size === e.size && k.mtime === e.mtime && !!k.version && (k.version >= this.version || k.kept);
    }

    // Что уже разобрано: картинка с тем же размером и временем файла, разобранная этой версией службы
    async knownOf(id) {
        const rows = await this.db().all(`SELECT g.key, g.size, g.mtime, g.sha1, p.version, p.labels FROM game_pictures g
            LEFT JOIN picture_text p ON p.sha1 = g.sha1 WHERE g.game_id = ?`, [id]);
        return new Map(rows.map(({ labels, ...r }) => [r.key, { ...r, kept: parse(labels).some((l) => l.checked || l.source === 'manual') }]));
    }

    async estimate(id) {
        const list = await this.list(id);
        const known = await this.knownOf(id);
        const out = { ui: { count: 0, todo: 0 }, scene: { count: 0, todo: 0 } };
        for (const e of list) {
            out[e.kind].count++;
            if (!this.fresh(known.get(e.key), e)) out[e.kind].todo++;
        }
        out.ui.seconds = Math.round(out.ui.todo * SECONDS);
        out.scene.seconds = Math.round(out.scene.todo * SECONDS);
        return out;
    }

    // Найденные подписи игры: сколько всего, сколько включено, сколько ждут проверки, на скольких картинках
    async counts(id) {
        const files = await this.present(id);
        const rows = (await this.db().all(`SELECT g.key, g.size, g.mtime, p.labels FROM game_pictures g JOIN picture_text p ON p.sha1 = g.sha1
            WHERE g.game_id = ? AND p.labels != '[]'`, [id])).filter((r) => this.onDisk(files, r));
        let found = 0; let on = 0; let review = 0;
        for (const r of rows) {
            for (const l of parse(r.labels)) {
                found++;
                if (l.on) on++;
                if (l.unsure && !l.checked) review++;
            }
        }
        return { found, on, review, pictures: rows.length };
    }

    async status(id) {
        const ocr = await this.available();
        const job = await this.db().get('SELECT * FROM picture_jobs WHERE game_id = ?', [id]);
        const running = this.current?.id === id ? this.current : null;
        const queued = this.queue.some((q) => q.id === id);
        const state = running ? 'running' : queued ? 'queued' : job?.state || '';
        return {
            configured: !!this.url,
            available: !!ocr,
            state,
            scope: running?.scope || job?.scope || 'ui',
            done: running ? running.done : job?.done || 0,
            total: running ? running.total : job?.total || 0,
            error: job?.error || '',
            ...(await this.counts(id)),
            estimate: state === 'running' ? null : await this.estimate(id).catch(() => null),
        };
    }

    async saveJob(id, fields) {
        const keys = Object.keys(fields);
        await this.db().run(`INSERT INTO picture_jobs (game_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})
            ON CONFLICT(game_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}`, [id, ...keys.map((k) => fields[k])]);
    }

    // Строка game_pictures — про тот файл, что лежит в папке сейчас
    onDisk(files, r) {
        const f = files.get(r.key);
        return !!f && f.size === r.size && f.mtime === r.mtime;
    }

    start(id, scope = 'ui', { auto = false } = {}) {
        // Идёт — не трогаем; только что поставили на паузу (текущая картинка ещё дочитывается) — следом снова
        if (this.current?.id === id && !this.current.stop && !this.current.yield) {
            if (!auto) this.current.auto = false;
            return;
        }
        this.queue = this.queue.filter((q) => q.id !== id);
        // Запущенное рукой — раньше фонового пересчёта (upgrade): человек ждать не должен. Идущий пересчёт
        // уступает после текущей картинки и потом продолжает с того же места (разобранное не повторяется)
        const firstAuto = () => { const i = this.queue.findIndex((q) => q.auto); return i < 0 ? this.queue.length : i; };
        if (!auto && this.current?.auto && !this.current.stop && !this.current.yield) {
            this.current.yield = true;
            this.queue.splice(firstAuto(), 0, { id: this.current.id, scope: this.current.scope, auto: true });
        }
        const job = { id, scope: scope === 'all' ? 'all' : 'ui' };
        if (auto) job.auto = true;
        this.queue.splice(auto ? this.queue.length : firstAuto(), 0, job);
        this.kick();
    }

    // Очередь — по одной игре. Встали в очередь, пока прежний проход заканчивался, — следующий проход сам
    kick() {
        if (this.running) return;
        this.running = this.drain().finally(() => {
            this.running = null;
            if (this.queue.length) this.kick();
        });
    }

    async pause(id) {
        this.queue = this.queue.filter((q) => q.id !== id);
        if (this.current?.id === id) this.current.stop = true;
        await this.saveJob(id, { state: 'paused', at: Date.now() });
    }

    // После перезапуска сервера — продолжить то, что шло. Служба поднимается дольше сервера (грузит модели) —
    // ждём её до трёх минут, а не ставим «ошибку» сразу
    // Пока ждём, задача в базе остаётся «идёт»: перезапуск сервера в это время её не потеряет, а «Пауза», нажатая
    // за это время, — в силе
    async recover({ waitMs = 3 * 60 * 1000, stepMs = 10 * 1000 } = {}) {
        const pending = () => this.db().all("SELECT game_id, scope FROM picture_jobs WHERE state IN ('running', 'queued')");
        const before = await pending();
        if (!this.url) {
            // Службы нет совсем (OCR_URL пуст) — остаётся на паузе
            if (before.length) await this.db().run("UPDATE picture_jobs SET state = 'paused' WHERE state IN ('running', 'queued')");
            return;
        }
        for (let waited = 0; waited < waitMs && !(await this.available({ fresh: true })); waited += stepMs) {
            await new Promise((r) => setTimeout(r, stepMs));
        }
        const rows = await pending();
        if (rows.length) await this.db().run("UPDATE picture_jobs SET state = 'paused' WHERE state IN ('running', 'queued')");
        for (const r of rows) this.start(r.game_id, r.scope);
        this.recovered = true;
        await this.upgrade();
    }

    // Разбор стал лучше (у службы новая версия) — уже разобранные игры пересчитываются сами, в фоне: нажимать ничего
    // не надо. Правленное на экране «Картинки» не теряется (fresh: картинки с правками не разбираются заново)
    async upgrade() {
        // Один проход за раз: recover и новая версия службы могут позвать его почти одновременно
        if (this.upgrading) return;
        this.upgrading = true;
        try {
            await this.upgradeNow();
        } finally {
            this.upgrading = false;
        }
    }

    async upgradeNow() {
        const version = (await this.available())?.version;
        if (!version) return;
        // Только игры, которые есть в библиотеке (убранная в корзину своё отработала), и картинки своего охвата
        const rows = await this.db().all(`SELECT j.game_id, j.scope FROM picture_jobs j JOIN games ON games.id = j.game_id WHERE j.state = 'done' AND EXISTS (
            SELECT 1 FROM game_pictures g JOIN picture_text p ON p.sha1 = g.sha1 WHERE g.game_id = j.game_id AND p.version < ?
            AND (j.scope = 'all' OR g.kind = 'ui') AND p.labels NOT LIKE '%"checked":true%')`, [version]);
        for (const r of rows) {
            if (this.current?.id === r.game_id || this.queue.some((q) => q.id === r.game_id)) continue;
            // Сверка с папкой: картинка, которую из игры убрали, в базе так и осталась старой версии — из-за неё
            // пересчёт крутился бы на каждом перезапуске
            const left = await this.estimate(r.game_id).catch(() => null);
            if (!left || !(left.ui.todo + (r.scope === 'all' ? left.scene.todo : 0))) continue;
            console.log(`[Картинки] ${r.game_id}: разбор стал лучше (версия ${version}) — пересчитываю`);
            this.start(r.game_id, r.scope, { auto: true });
        }
    }

    async drain() {
        while (this.queue.length) {
            const { id, scope, auto = false } = this.queue.shift();
            this.current = { id, scope, auto, done: 0, total: 0, stop: false };
            await this.run(id, scope).catch(async (e) => {
                console.error(`[Картинки] ${id}:`, e.message);
                await this.saveJob(id, { state: 'error', error: e instanceof OcrDown ? 'ocr-down' : 'failed', at: Date.now() }).catch(() => {});
            });
            this.current = null;
        }
    }

    // Строки игры для сверки распознанного (utils/picturetext.js, snap) — без текстов с самих картинок
    async lexicon(id) {
        const text = await this.translate.gameText(id).catch(() => null);
        if (!text) return lexiconOf([]);
        const own = new Set(text.pictureTexts || []);
        return lexiconOf([...text.all.filter((s) => !own.has(s)), ...(text.names || [])]);
    }

    async run(id, scope) {
        if (!(await this.available({ fresh: true }))) throw new OcrDown('служба распознавания не отвечает');
        const list = (await this.list(id, { fresh: true }))
            .filter((e) => scope === 'all' || e.kind === 'ui')
            .sort((a, b) => a.order - b.order || (a.kind === b.kind ? 0 : a.kind === 'ui' ? -1 : 1));
        const known = await this.knownOf(id);
        const markup = new Set((this.markupSets || require('./translate.js').imageLabelSets()).map((s) => s.sha1));
        const lexicon = await this.lexicon(id);
        const cur = this.current;
        cur.total = list.length;
        await this.saveJob(id, { state: 'running', scope, done: 0, total: list.length, error: '', at: Date.now() });
        let found = 0;
        let fails = 0;
        for (const e of list) {
            // Уступил запущенному рукой (start): в базе остаётся «идёт» — после перезапуска сервера продолжится сам
            if (cur.yield) {
                if (found) this.changed(id);
                return;
            }
            if (cur.stop) {
                await this.saveJob(id, { state: 'paused', done: cur.done, at: Date.now() });
                this.changed(id);
                return;
            }
            if (!this.fresh(known.get(e.key), e)) {
                try {
                    found += await this.processOne(id, e, { lexicon, markup });
                    fails = 0;
                } catch (err) {
                    if (!(err instanceof OcrFailed)) throw err;
                    console.warn(`[Картинки] ${id}: ${e.rel} — ${err.message}`);
                    if (++fails >= FAILS_IN_A_ROW) {
                        if (found) this.changed(id);
                        throw new OcrDown(`${fails} сбоев подряд`);
                    }
                }
            }
            cur.done++;
            if (cur.done % 20 === 0) {
                await this.saveJob(id, { done: cur.done, at: Date.now() });
                if (found) { this.changed(id); found = 0; }
            }
        }
        // Уступить просили на последней картинке — уступать уже нечего: повторный проход был бы пустым
        if (cur.yield) this.queue = this.queue.filter((q) => !(q.id === id && q.auto));
        await this.saveJob(id, { state: 'done', done: cur.done, at: Date.now() });
        this.changed(id);
        // Новые подписи — в перевод (если он включён): переводятся только они, остальное уже в словаре
        const lang = await this.translate.langOf(id);
        if (lang) this.translate.enqueue(id, lang);
    }

    // Подписи игры поменялись: текст игры разобрать заново (перевод и mimikin-tl.json)
    changed(id) {
        this.translate.cache?.delete(id);
        this.translate.version++;           // словарь игры собирается по её строкам — тоже заново
        this.onChange(id);
    }

    async processOne(id, e, { lexicon, markup }) {
        const raw = await fsp.readFile(e.file).catch(() => null);
        const png = raw && decrypt(raw, e.file);
        if (!png) return 0;
        const hash = sha1(png);
        await this.db().run(`INSERT INTO game_pictures (game_id, key, rel, sha1, size, mtime, kind) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id, key) DO UPDATE SET rel = excluded.rel, sha1 = excluded.sha1, size = excluded.size, mtime = excluded.mtime, kind = excluded.kind`,
        [id, e.key, e.rel, hash, e.size, e.mtime, e.kind]);
        // Ручная разметка (data/image-labels) — главнее: эту картинку уже переводит она. Помечаем разобранной (без
        // подписей), чтобы она не числилась «не проверенной»
        const kept = (row) => !!row && parse(row.labels).some((l) => l.checked || l.source === 'manual');
        const have = await this.db().get('SELECT version, labels FROM picture_text WHERE sha1 = ?', [hash]);
        if (markup.has(hash)) {
            // Найденное раньше распознаванием и не правленное — убираем: подписи этой картинки теперь у разметки
            if (!kept(have)) {
                await this.db().run(`INSERT INTO picture_text (sha1, version, w, h, labels, at) VALUES (?, ?, ?, ?, '[]', ?)
                    ON CONFLICT(sha1) DO UPDATE SET version = excluded.version, labels = '[]', bilingual = 0, at = excluded.at`,
                [hash, this.version || 1, e.w, e.h, Date.now()]);
            }
            return 0;
        }
        // Разобрана этой версией — или в ней что-то правили руками: правки не теряем
        if (have && (have.version >= this.version || kept(have))) return 0;
        let res;
        try {
            res = await this.fetch(`${this.url}/analyze`, {
                method: 'POST', body: png, headers: { 'Content-Type': 'image/png' }, signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            throw new OcrDown(err.message);
        }
        // 422 — картинка испорчена, не того формата или слишком большая: помним пустой итог, чтобы не спрашивать
        // снова. Другая ошибка — сбой самой службы: эту картинку разберёт следующий запуск
        if (!res.ok && res.status !== 422) throw new OcrFailed(`служба ответила ${res.status}`);
        const data = await res.json().catch(() => null);
        const labels = res.ok && Array.isArray(data?.labels) ? await this.prepare(data, lexicon) : [];
        // Пока служба читала (до минуты), подписи этой картинки могли поправить на экране «Картинки» — их не затираем
        if (kept(await this.db().get('SELECT labels FROM picture_text WHERE sha1 = ?', [hash]))) return 0;
        const version = Number(data?.version) || this.version || 1;
        await this.db().run(`INSERT INTO picture_text (sha1, version, w, h, bilingual, labels, at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sha1) DO UPDATE SET version = excluded.version, w = excluded.w, h = excluded.h, bilingual = excluded.bilingual,
            labels = excluded.labels, at = excluded.at`,
        [hash, version, data?.w || e.w, data?.h || e.h, data?.bilingual ? 1 : 0, JSON.stringify(labels), Date.now()]);
        return labels.length;
    }

    // Подписи из ответа службы: текст — по строкам игры, заплатка — в свою таблицу (по хэшу), включена ли
    async prepare(data, lexicon, { first = 1, manual = false } = {}) {
        const out = [];
        let n = first;
        for (const raw of data.labels) {
            if (!raw || typeof raw.text !== 'string') continue;
            const l = snap(raw, lexicon);
            let patch = '';
            if (typeof raw.patch === 'string' && raw.patch) {
                const buf = Buffer.from(raw.patch, 'base64');
                patch = sha1(buf);
                await this.db().run('INSERT OR IGNORE INTO picture_patches (hash, png) VALUES (?, ?)', [patch, buf]);
            }
            const label = { id: n++, text: l.text, paddle: raw.paddle || '', manga: raw.manga || '', source: manual ? 'manual' : 'auto', box: raw.box };
            for (const k of STYLE) if (raw[k] !== undefined) label[k] = raw[k];
            label.patch = patch;
            label.patchBox = raw.patchBox;
            label.score = raw.score;
            label.agree = raw.agree;
            label.unsure = !manual && (!!l.unsure || !plausibleDate(l.text));
            label.vertical = !!raw.vertical;
            label.judge = raw.judge || '';
            label.known = !!l.known;
            // Включена сразу: уверенная и картинка не двуязычная. Обведённая рукой — всегда. Вертикальную игра рисует
            // повёрнутой вдоль столбца — её не выключаем
            label.on = manual || (!label.unsure && !data.bilingual);
            label.checked = manual;
            out.push(label);
        }
        return out;
    }

    // Строки картинки игры по хэшу — только если хэш действительно этой игры
    async pictureRow(id, hash) {
        return this.db().get(`SELECT g.key, g.rel, p.sha1, p.labels FROM game_pictures g JOIN picture_text p ON p.sha1 = g.sha1
            WHERE g.game_id = ? AND g.sha1 = ?`, [id, hash]);
    }

    // Для перевода игры (translate.readGameText → displayDict → rpg-fixes): картинки с включёнными подписями.
    // Файл поменялся с тех пор, как его разобрали (обновление игры), — его разметку не отдаём: стёрли бы не то
    async forGame(id) {
        const rows = await this.db().all(`SELECT g.key, g.rel, g.size, g.mtime, p.labels FROM game_pictures g
            JOIN picture_text p ON p.sha1 = g.sha1 WHERE g.game_id = ? AND p.labels != '[]'`, [id]);
        if (!rows.length) return [];
        const root = await this.root(id);
        if (!root) return [];
        const out = [];
        for (const r of rows) {
            const labels = parse(r.labels).filter((l) => l.on && typeof l.text === 'string' && l.text);
            if (!labels.length) continue;
            const st = await fsp.stat(path.join(root, ...r.rel.split('/'))).catch(() => null);
            if (!st || st.size !== r.size || Math.floor(st.mtimeMs) !== r.mtime) continue;
            out.push({
                path: r.key,
                labels: labels.map((l) => {
                    const o = { text: l.text };
                    // null тоже передаём: «обводки нет» — это не «обводка по умолчанию»
                    for (const k of STYLE) if (l[k] !== undefined) o[k] = l[k];
                    if (l.patch && Array.isArray(l.patchBox)) Object.assign(o, { patch: `mimikin-tl/patch/${l.patch}.png`, patchBox: l.patchBox });
                    return o;
                }),
            });
        }
        return out;
    }

    // Экран «Картинки»: картинки игры с подписями и переводом каждой
    async review(id) {
        const files = await this.present(id);
        const rows = (await this.db().all(`SELECT g.key, g.rel, g.kind, g.size, g.mtime, p.sha1, p.w, p.h, p.bilingual, p.labels FROM game_pictures g
            JOIN picture_text p ON p.sha1 = g.sha1 WHERE g.game_id = ? AND p.labels != '[]' ORDER BY g.key`, [id])).filter((r) => this.onDisk(files, r));
        const lang = await this.translate.langOf(id);
        const dict = lang ? await this.translate.dictionary(id, lang) : new Map();
        return rows.map((r) => ({
            key: r.key, rel: r.rel, kind: r.kind, sha1: r.sha1, w: r.w, h: r.h, bilingual: !!r.bilingual,
            labels: parse(r.labels).map((l) => ({ ...l, translation: dict.get(l.text) || '' })),
        }));
    }

    async saveLabels(hash, labels) {
        await this.db().run('UPDATE picture_text SET labels = ?, at = ? WHERE sha1 = ?', [JSON.stringify(labels), Date.now(), hash]);
    }

    // Правка подписи: включить/выключить, поправить распознанный текст, отметить проверенной
    async setLabel(id, hash, labelId, { on, text } = {}) {
        const row = await this.pictureRow(id, hash);
        if (!row) return null;
        const labels = parse(row.labels);
        const l = labels.find((x) => x.id === Number(labelId));
        if (!l) return null;
        if (typeof on === 'boolean') l.on = on;
        if (typeof text === 'string' && text.trim() && text.trim() !== l.text) {
            l.text = text.trim().slice(0, 200);
            l.edited = true;
        }
        l.checked = true;
        await this.saveLabels(hash, labels);
        this.changed(id);
        return l;
    }

    // Подпись, которую поиск пропустил: обвели рамкой — служба читает её, определяет стиль и готовит заплатку
    async addBox(id, key, box) {
        if (!(await this.available({ fresh: true }))) throw new OcrDown('служба распознавания не отвечает');
        const row = await this.db().get(`SELECT g.rel, g.sha1, p.labels FROM game_pictures g JOIN picture_text p ON p.sha1 = g.sha1
            WHERE g.game_id = ? AND g.key = ?`, [id, key]);
        if (!row) return null;
        const png = await this.image(id, key);
        if (!png) return null;
        const b = (Array.isArray(box) ? box : []).slice(0, 4).map((v) => Math.round(Number(v) || 0));
        if (b.length < 4 || b[2] < 4 || b[3] < 4) return null;
        const res = await this.fetch(`${this.url}/boxes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs),
            body: JSON.stringify({ png: png.toString('base64'), boxes: [b] }),
        }).catch((e) => { throw new OcrDown(e.message); });
        const data = await res.json().catch(() => null);
        const found = (data?.labels || []).filter(Boolean);
        if (!res.ok || !found.length) return null;
        const labels = parse(row.labels);
        const first = labels.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0) + 1;
        const added = await this.prepare({ labels: found }, lexiconOf([]), { first, manual: true });
        labels.push(...added);
        await this.saveLabels(row.sha1, labels);
        this.changed(id);
        const lang = await this.translate.langOf(id);
        if (lang) this.translate.enqueue(id, lang);
        return added[0] || null;
    }

    // Убрать подпись: обведённую рукой — совсем, найденную — выключить (иначе поиск нашёл бы её снова)
    async removeLabel(id, hash, labelId) {
        const row = await this.pictureRow(id, hash);
        if (!row) return false;
        let labels = parse(row.labels);
        const l = labels.find((x) => x.id === Number(labelId));
        if (!l) return false;
        if (l.source === 'manual') labels = labels.filter((x) => x !== l);
        else Object.assign(l, { on: false, checked: true });
        await this.saveLabels(hash, labels);
        this.changed(id);
        return true;
    }

    // Картинка игры (расшифрованная) — для экрана «Картинки». Только из папок картинок этой игры
    async image(id, key) {
        const row = await this.db().get('SELECT rel FROM game_pictures WHERE game_id = ? AND key = ?', [id, String(key)]);
        const root = row && await this.root(id);
        if (!root) return null;
        const file = path.resolve(root, ...row.rel.split('/'));
        if (!file.startsWith(path.resolve(root) + path.sep)) return null;
        const raw = await fsp.readFile(file).catch(() => null);
        return raw && decrypt(raw, file);
    }

    async patch(hash) {
        if (!/^[0-9a-f]{40}$/.test(String(hash))) return null;
        return (await this.db().get('SELECT png FROM picture_patches WHERE hash = ?', [hash]))?.png || null;
    }
}

module.exports = new PictureService();
module.exports.PictureService = PictureService;
module.exports.OcrDown = OcrDown;
module.exports.plausibleDate = plausibleDate;
