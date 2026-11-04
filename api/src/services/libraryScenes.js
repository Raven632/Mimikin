// Все сцены библиотеки — окно «Сцены» без запроса (frontend: LineSearch.jsx): по играм, первые плитки каждой и «Ещё N»,
// очередь для «Смотреть подряд» и «Случайно». Строки — как у вкладок «Сцены» и «Диалоги» галереи игры (frontend:
// galleryView.js, sceneRows): то же название, обложка и нумерация одинаковых названий — правится вместе с ним.
// Оглавления галерей читаются по разу: строки игры лежат в памяти, пока файл оглавления тот же (новая сборка — заново)
const fsp = require('fs').promises;

const NONE = [];
const PEEK = 5;      // кадров живой плитки (при наведении), равномерно по сцене; то же — galleryView.js, peekFrames
const QUEUE = 300;   // сцен в одной порции очереди: «подряд» просит следующую порцию сам (from), «вперемешку» — выборка

// Строки одной вкладки: dialogue — альбомы «dialogue», иначе остальные со сценарием. Альбом со сценами-гостями — строка
// на гостя (n — его номер). Одинаковые названия внутри вкладки нумеруются по порядку («Village Doctor 3»)
function tabRows(albums, dialogue) {
    const rows = [];
    for (const a of albums || []) {
        if (!a.script || (a.kind === 'dialogue') !== dialogue) continue;
        const name = a.title || a.key.split('/').pop().replace(/(#\w+)+$/, '');
        const files = a.files || [];
        const base = { key: a.key, kind: a.kind || '', ...(a.spine ? { spine: true } : {}), ...(a.live2d ? { live2d: true } : {}) };
        if (Array.isArray(a.scenes) && a.scenes.length) {
            a.scenes.forEach((g, n) => rows.push({ ...base, n, title: g.t || name, sum: g.sum || null, cover: files[g.f?.[0]] || a.cover || files[0] || '' }));
        } else rows.push({ ...base, n: 0, title: name, sum: a.sum || null, cover: a.cover || files[0] || '' });
    }
    const total = new Map();
    for (const r of rows) total.set(r.title, (total.get(r.title) || 0) + 1);
    const seen = new Map();
    for (const r of rows) {
        if (total.get(r.title) < 2) continue;
        const no = (seen.get(r.title) || 0) + 1;
        seen.set(r.title, no);
        r.title = `${r.title} ${no}`;
    }
    return rows;
}

// Отбор: kind — 'scenes' (всё, кроме диалогов), 'dialogue' или '' (все); voice — с голосом, anim — с анимацией
const pass = ({ kind = '', voice = false, anim = false }) => (r) => (!kind || (kind === 'dialogue') === (r.kind === 'dialogue'))
    && (!voice || !!r.sum?.v) && (!anim || !!r.sum?.a);
// Теги строки: есть все из tags и нет ни одного из not и hide (скрытые теги)
const tagsFit = ({ tags = [], not = [], hide = [] }) => (have) => tags.every((x) => have.includes(x)) && !not.some((x) => have.includes(x)) && !hide.some((x) => have.includes(x));

class LibraryScenes {
    constructor() {
        this.gallery = null;
        this.memo = new Map();   // игра → { at: время файла оглавления, rows }
    }

    setDependencies({ gallery }) { this.gallery = gallery; }

    async rowsOf(id) {
        const st = await fsp.stat(this.gallery.indexPath(id)).catch(() => null);
        if (!st) { this.memo.delete(id); return []; }
        const hit = this.memo.get(id);
        if (hit && hit.at === st.mtimeMs) return hit.rows;
        const index = await this.gallery.cached(id);
        const rows = index ? [...tabRows(index.albums, false), ...tabRows(index.albums, true)] : [];
        // Кадр → его сцена (sceneOf): у альбома со сценами-гостями — гость, чьи кадры его содержат, у остальных — сцена
        // альбома. Только альбомы со сценарием — это малая часть кадров
        const title = new Map(rows.map((r) => [`${r.key}\n${r.n}`, r.title]));
        const files = new Map();
        for (const a of index ? index.albums : []) {
            if (!a.script) continue;
            const list = a.files || [];
            const mark = (f, n) => { if (f && !files.has(f) && title.has(`${a.key}\n${n}`)) files.set(f, { key: a.key, n, title: title.get(`${a.key}\n${n}`) }); };
            if (Array.isArray(a.scenes) && a.scenes.length) a.scenes.forEach((g, n) => { for (const i of g.f || []) mark(list[i], n); });
            else for (const f of list) mark(f, 0);
        }
        // Кадры каждой строки — по порядку строк: для тегов (rowTags)
        const byKey = new Map((index ? index.albums : []).map((a) => [a.key, a]));
        const frames = rows.map((r) => {
            const a = byKey.get(r.key);
            const list = a?.files || [];
            return (Array.isArray(a?.scenes) && a.scenes.length ? (a.scenes[r.n]?.f || []).map((i) => list[i]) : list).filter(Boolean);
        });
        rows.forEach((r, i) => {
            const list = frames[i];
            if (r.kind === 'dialogue' || r.spine || r.live2d || list.length < 2) return;
            const n = Math.min(PEEK, list.length);
            r.peek = Array.from({ length: n }, (_, k) => list[Math.floor((k * list.length) / n)]);
        });
        this.memo.set(id, { at: st.mtimeMs, rows, files, frames });
        return rows;
    }

    // Теги каждой строки игры: всё, что разметчик увидел на её кадрах (gallery.js, gameTags), — по порядку строк. Сцена
    // подходит, даже если теги на разных её кадрах. Считаем заново, когда разбор дописал файл тегов этой игры
    async rowTags(id) {
        const rows = await this.rowsOf(id);
        const hit = this.memo.get(id);
        const st = hit && this.gallery.tagsPath ? await fsp.stat(this.gallery.tagsPath(id)).catch(() => null) : null;
        if (!st) return rows.map(() => NONE);
        if (hit.tagsAt !== st.mtimeMs) {
            const { files, tags } = await this.gallery.gameTags(id);
            const of = new Map();
            for (const { tag, f } of tags) for (const i of f) (of.get(files[i]) || of.set(files[i], []).get(files[i])).push(tag);
            hit.rowTags = hit.frames.map((list) => [...new Set(list.flatMap((f) => of.get(f) || []))]);
            hit.tagsAt = st.mtimeMs;
        }
        return hit.rowTags;
    }

    // Сцена, в которой есть кадр (поиск по картинкам, «Смотреть сцену»): { key, n, title } или null
    async sceneOf(id, file) {
        await this.rowsOf(id);
        return this.memo.get(id)?.files.get(file) || null;
    }

    // ids — игры по порядку (недавние первыми). per — первых строк на игру; game — только эта игра, все строки. tags, not,
    // hide — отбор по тегам (tagsFit). → { total, counts: { all, scenes, dialogue }, tags: [{ tag, n }], games: [{ id, count, rows }] };
    // counts — с голосом, анимацией и тегами из отбора, но без kind: числа на чипах «Все», «Сцены», «Диалоги». tags — теги
    // среди отобранного, для панели «Теги»: числа сужаются с каждым выбором
    // evict — забыть игры, которых нет в ids (по умолчанию да). Список человека с ограниченным набором игр короче общего, и он
    // вытеснял бы память остальных: ему evict: false
    async list(ids, { game = '', per = 4, tags = [], not = [], hide = [], evict = true, ...filter } = {}) {
        const keep = new Set(ids);
        if (evict) for (const id of this.memo.keys()) if (!keep.has(id)) this.memo.delete(id);
        const ok = pass(filter);
        const any = pass({ ...filter, kind: '' });
        const fit = tagsFit({ tags, not, hide });
        const counts = { all: 0, scenes: 0, dialogue: 0 };
        const seen = new Map();
        const games = [];
        for (const id of game ? ids.filter((x) => x === game) : ids) {
            const rows = await this.rowsOf(id);
            const have = await this.rowTags(id);
            const mine = [];
            rows.forEach((r, i) => {
                if (!fit(have[i]) || !any(r)) return;
                counts.all++;
                counts[r.kind === 'dialogue' ? 'dialogue' : 'scenes']++;
                if (!ok(r)) return;
                mine.push(r);
                for (const tag of have[i]) seen.set(tag, (seen.get(tag) || 0) + 1);
            });
            if (mine.length) games.push({ id, count: mine.length, rows: game ? mine : mine.slice(0, per) });
        }
        return { total: games.reduce((s, g) => s + g.count, 0), counts, tags: [...seen].filter(([tag]) => !hide.includes(tag)).map(([tag, n]) => ({ tag, n })), games };
    }

    // Очередь для плеера: order — по играм и по порядку в игре, порциями с from; random — QUEUE случайных сцен всей
    // библиотеки. Только то, что нужно плееру: игра, ключ, номер, название. → { queue, more } (more — есть следующая порция)
    async queue(ids, { random = false, from = 0, tags = [], not = [], hide = [], ...filter } = {}) {
        const ok = pass(filter);
        const fit = tagsFit({ tags, not, hide });
        const all = [];
        for (const id of ids) {
            const rows = await this.rowsOf(id);
            const have = await this.rowTags(id);
            rows.forEach((r, i) => { if (ok(r) && fit(have[i])) all.push({ game: id, key: r.key, n: r.n, title: r.title }); });
        }
        if (random) {
            for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
        }
        const start = random ? 0 : from;
        return { queue: all.slice(start, start + QUEUE), more: !random && all.length > start + QUEUE };
    }
}

module.exports = new LibraryScenes();
module.exports.LibraryScenes = LibraryScenes;
module.exports.tabRows = tabRows;
