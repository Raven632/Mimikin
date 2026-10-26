const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Плагин ExternMessage (Baizan): текст окна сообщения хранится в CSV, а в событии стоит «\M[ключ]». Игра подставляет его
// при показе, и в данных события реплик нет. Здесь тот же разбор, только заранее: строку 401 с «\M[» заменяем теми
// командами (101/401, а также 117 для «:event[n]» и 355 для «:script»), что построил бы плагин. Дальше runList читает
// их как обычный диалог. Порт convertMessageCommandCore из плагина, с несколькими осознанными отступлениями (ниже)
const CSV_MAX = 16 * 1024 * 1024;   // CSV больше — не наш файл (у Mika 400 КБ)
const DEPTH_MAX = 8;                // вложенных «\M»
const CHAIN_MAX = 16;               // значение, что само ключ другой строки: цепочка не длиннее (в игре цикл вешает стек)
const LINE_OUT = 4000;              // команд из одной строки 401
const LIST_OUT = 20000;             // команд, добавленных в один список
const MISS_MAX = 0.5;               // доля «\M» с неизвестным ключом, после которой считаем, что файл или кодировка не те

// Кодировка: BOM главнее параметра плагина (браузер тоже смотрит на него; у Mika BOM UTF-8, а в параметре shift_jis)
function decodeCsv(buf, label) {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
    try { return new TextDecoder(String(label || 'utf-8').trim().toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
}

// Границы ячеек — как у CsvImportor плагина: «,» кончает ячейку, «\n» строку, «"» прыгает к следующей «"» без «\» перед ней.
// Отступление: «""» внутри кавычек читаем как «"» (плагин оставляет обе)
function parseExternCsv(text) {
    text = String(text).replace(/\r\n/g, '\n');
    const rows = [];
    let cur = [];
    let begin = 0;
    const token = (b, n) => (text[b] === '"' ? text.substr(b + 1, n - 2).replace(/""/g, '"') : text.substr(b, n));
    const push = (i) => { cur.push(token(begin, i - begin)); begin = i + 1; };
    let i;
    for (i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === ',') push(i);
        else if (c === '"') {
            let j = i + 1;
            for (; ;) { j = text.indexOf('"', j); if (j < 0 || text[j - 1] !== '\\') break; j++; }
            if (j < 0) { i = text.length; break; }
            i = j;
        } else if (c === '\n') { push(i); rows.push(cur); cur = []; }
    }
    if (i !== begin || cur.length) { push(text.length); rows.push(cur); }
    return rows;
}

// Плагин включён → { get(ключ), lineMax, nameTag, mv }; нет плагина, файла или он не читается — null (ничего не меняем).
// Плагин — «ExternMessage» или его копия с суффиксом через не-букву («ExternMessage_Copy»), но не другой плагин с тем же началом
// («ExternMessageEx»). Параметры берём только у записи с именем ровно «ExternMessage»: у копии с другим именем плагин читает умолчания
async function loadExternMessage(root) {
    let plugins;
    try { const t = await fsp.readFile(path.join(root, 'js', 'plugins.js'), 'utf8'); plugins = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)); } catch { return null; }
    const pl = (Array.isArray(plugins) ? plugins : []).find((p) => p && p.status === true && /^ExternMessage(?![A-Za-z])/.test(String(p.name || '').split('/').pop()));
    if (!pl) return null;
    const prm = pl.name === 'ExternMessage' && pl.parameters && typeof pl.parameters === 'object' ? pl.parameters : {};
    const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
    const data = path.join(root, 'data');
    const full = path.join(data, String(prm['Csv File Path'] ?? 'ExternMessage.csv'));
    // Только внутри data/: путь из данных игры наружу не уводит
    if (!full.startsWith(data + path.sep)) return null;
    const st = await fsp.stat(full).catch(() => null);
    if (!st || !st.isFile() || st.size > CSV_MAX) return null;
    // Повтор ключа: побеждает последняя строка (плагин пишет в _map[ключ] подряд, так же)
    const map = new Map();
    // Пустой ключ — пустая строка или хвост файла, не запись: «\M[]» из неё ничего не берёт
    for (const r of parseExternCsv(decodeCsv(await fsp.readFile(full), prm['Csv File Encode'] ?? 'shift_jis'))) if (r[0] !== '') map.set(r[0], r.slice(1));
    if (map.size < 2) return null;
    const col = num(prm['Default Reference Column Index'], 1);
    // getValue плагина, с его сравнением «<=»: при двух столбцах и col 2 берётся первый
    const get = (key) => { const row = map.get(key); return row ? (row.length <= col ? row[0] : row[col - 1]) : undefined; };
    return { get, lineMax: Math.max(1, num(prm['Line Max'], 4)), nameTag: String(prm['Use Name Tag'] ?? 'true') === 'true', mv: !fs.existsSync(path.join(root, 'js', 'rmmz_core.js')) };
}

// Аргумент в скобках после ключа (скобки внутри учитываем); нет скобки — null
function parseArg(text, idx) {
    const head = idx;
    for (let depth = 0; idx < text.length; idx++) {
        if (text[idx] === '[') depth++; else if (text[idx] === ']') depth--;
        if (depth <= 0) break;
    }
    return head < idx ? text.substring(head + 1, idx) : null;
}
function parseCmd(text, key, call) {
    let result = '';
    let headIdx = 0;
    for (let idx = text.indexOf(key, headIdx); idx !== -1; idx = text.indexOf(key, headIdx)) {
        result += text.substring(headIdx, idx);
        headIdx = idx + key.length;
        const arg = parseArg(text, headIdx);
        if (arg != null) headIdx += arg.length + 2;
        const str = call(arg);
        if (str) result += str;
    }
    return headIdx > 0 ? result + text.substr(headIdx) : text;
}

// Одна строка 401 → { dest: команды, dynamic } или null. budget.left — сколько команд ещё можно добавить в список,
// budget.top/miss — «\M» верхнего уровня и среди них с неизвестным ключом (охрана: не тот файл или кодировка)
function expandLine(item, em, budget) {
    const text = String(item.parameters?.[0] ?? '');
    if (!text.includes('\\M[')) return null;
    const indent = item.indent || 0;
    const tryReplace = (v, n = 0) => { if (v == null) return ''; const r = em.get(String(v).trim()); return r === undefined || n >= CHAIN_MAX ? String(v) : tryReplace(r, n + 1); };
    const multi = (v, list = [], n = 0) => {
        v = String(v ?? '').trim();
        if (v.includes(',')) { for (const x of v.split(',')) multi(x, list, n); return list; }
        const r = n < CHAIN_MAX ? em.get(v) : undefined;
        if (r === undefined) list.push(v); else multi(r, list, n + 1);
        return list;
    };
    const ctx = { name: '', face: '', faceId: 0, lines: 0, bg: 0, pos: 2 };
    const dest = [];
    let dynamic = false;
    const p101 = () => {
        const face = ctx.faceId < 0 || ctx.face === '' ? ['', 0] : [ctx.face, Number(ctx.faceId) || 0];
        if (em.mv || !em.nameTag) return [...face, ctx.bg, ctx.pos];
        // MZ: имя — пятый параметр; «\» и пробелы — не имя (рассказчик), окна имени нет
        return [...face, ctx.bg, ctx.pos, /[^\\\s]/.test(ctx.name) ? ctx.name : ''];
    };
    const core = (txt, depth) => {
        const messages = txt.split('\n');
        for (let i = 0; i < messages.length; i++) {
            if (dest.length > LINE_OUT || budget.left <= 0) return;
            let message = messages[i];
            // Скрипт внутри текста: до «:end». «:script[immediate]» плагин исполняет сам при разборе — в сцене его нет
            if (depth > 0 && (message === ':script' || message === ':script[immediate]')) {
                let src = '';
                let j = i + 1;
                for (; j < messages.length && messages[j] !== ':end'; j++) src += `${messages[j]}\n`;
                if (j >= messages.length) break;      // не закрыт — плагин обрывает разбор
                if (message === ':script') dest.push({ code: 355, indent, parameters: [src], ext: true });
                i = j;
                continue;
            }
            message = parseCmd(message, '\\V', (a) => { const n = parseInt(tryReplace(a), 10); return Number.isFinite(n) ? `\\V[${n}]` : ''; });
            // Плагин здесь ищет «\V» (опечатка), мы делаем то, что он хотел
            message = parseCmd(message, '\\C', (a) => `\\C[${tryReplace(a)}]`);
            let found = false;
            message = parseCmd(message, '\\M', (a) => {
                found = true;
                // Ключ из переменной (имя героя из ввода игрока): что игра напечатает, не знаем
                if (a == null || /\\[Vv]\[/.test(a)) { dynamic = true; return ''; }
                if (depth === 0) budget.top = (budget.top || 0) + 1;
                // Ключа нет: игра напечатала бы сам ключ — это мёртвая ссылка, не текст. Не простой ключ (опечатка
                // «\M[a\M[b]» проглотила остаток строки) — как плагин, текстом: дальше разберётся следующий проход
                if (em.get(String(a).trim()) === undefined) { if (depth === 0) budget.miss = (budget.miss || 0) + 1; return /[\\[\]:\n]/.test(a) ? a : ''; }
                return tryReplace(a);
            });
            if (found) { if (depth < DEPTH_MAX) core(message, depth + 1); continue; }
            message = parseCmd(message, ':name', (a) => { const v = multi(a); ctx.name = v[0] || ''; ctx.face = v[1] || ''; ctx.faceId = 0; ctx.lines = em.lineMax; });
            message = parseCmd(message, ':face', (a) => { ctx.faceId = Number(tryReplace(a)) || 0; ctx.lines = em.lineMax; });
            message = parseCmd(message, ':page', () => { ctx.lines = em.lineMax; });
            message = parseCmd(message, ':event', (a) => { const id = parseInt(tryReplace(a), 10); if (Number.isFinite(id)) dest.push({ code: 117, indent, parameters: [id], ext: true }); ctx.lines = em.lineMax; });
            message = parseCmd(message, ':fadeout', () => { dest.push({ code: 221, indent, parameters: [], ext: true }); ctx.lines = em.lineMax; });
            message = parseCmd(message, ':fadein', () => { dest.push({ code: 222, indent, parameters: [], ext: true }); ctx.lines = em.lineMax; });
            message = parseCmd(message, ':bg', (a) => { ctx.bg = a === 'dim' ? 1 : a === 'transparent' ? 2 : 0; ctx.lines = em.lineMax; });
            message = parseCmd(message, ':layout', (a) => { ctx.pos = a === 'top' ? 0 : a === 'center' ? 1 : 2; ctx.lines = em.lineMax; });
            if (ctx.lines >= em.lineMax) {
                if (dest.length && dest[dest.length - 1].code === 101) dest.length--;
                dest.push({ code: 101, indent, parameters: p101(), ext: true });
                ctx.lines = 0;
            }
            let tagOnly = false;
            // MV: имя — тег «\n<имя>» в начале окна. Имя без видимых букв («:name[\,…]» — рассказчик): тега нет
            if (em.mv && em.nameTag && ctx.lines === 0 && /[^\\\s]/.test(ctx.name)) { tagOnly = message.length === 0; message = `\\n<${ctx.name}>${message}`; }
            if (message.length > 0 && !tagOnly) { dest.push({ code: 401, indent, parameters: [message], ext: true }); ctx.lines++; }
        }
    };
    core(text, 0);
    budget.left -= dest.length;
    return { dest, dynamic };
}

// Список команд с развёрнутыми «\M[…]». Только строки сообщения (401 после 101 или 401); нечего менять — тот же массив.
// Созданные команды помечены ext, первая — ext:'head': она стоит за ту строку 401, что заменила (счёт шагов обхода)
function expandList(list, em, stats = null) {
    if (!em || !Array.isArray(list) || !list.some((c) => c && c.code === 401 && String(c.parameters?.[0] ?? '').includes('\\M['))) return list;
    const out = [];
    const budget = { left: LIST_OUT };
    let prev = null;
    for (const c of list) {
        const r = c && c.code === 401 && budget.left > 0 && prev && (prev.code === 101 || prev.code === 401) ? expandLine(c, em, budget) : null;
        prev = c;
        if (!r || !r.dest.length) { out.push(c); continue; }
        r.dest[0].ext = 'head';
        if (stats) { stats.lines = (stats.lines || 0) + 1; if (r.dynamic) stats.dynamic = (stats.dynamic || 0) + 1; stats.cmds = (stats.cmds || 0) + r.dest.length; }
        out.push(...r.dest);
    }
    if (stats) { stats.top = (stats.top || 0) + (budget.top || 0); stats.miss = (stats.miss || 0) + (budget.miss || 0); }
    return out;
}

module.exports = { decodeCsv, parseExternCsv, loadExternMessage, expandLine, expandList, MISS_MAX };
