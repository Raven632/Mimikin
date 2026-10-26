// Язык игры — по её собственному тексту, а не по магазину. Магазин про любую игру
// пишет «Japanese», даже если в папке лежит русский перевод, а Steam — «Multi».
// Здесь читаем то, что игрок на самом деле увидит: реплики из карт и общих событий,
// таблицы переводов и папки локализаций, и считаем, какими буквами они написаны.
const fsp = require('fs').promises;
const path = require('path');

// Сколько букв реплик хватает для уверенного ответа. Дальше читать незачем:
// большие игры весят десятки мегабайт карт, а язык за первые файлы уже ясен
const ENOUGH = 80000;
// Язык засчитывается, если на нём написана заметная доля текста. Меньше — это
// остатки: непереведённая табличка или японское имя в английской игре
const MIN_LETTERS = 300;
const MIN_SHARE = 0.1;
const MAX_READ = 4 * 1024 * 1024;

// Латиница одинаковая у десятка языков — различаем по частым коротким словам
const STOPWORDS = {
    en: 'the and you to is it that of what this me my your are was be have do not with for',
    es: 'que el la los las y no es en por un una lo me qué está pero con para',
    pt: 'que não o os você é um uma do da com para eu isso mas se',
    fr: 'je le la les et pas vous est que un une ne tu ce il qui mais',
    de: 'und ich die der das nicht du ist zu es ein sie mit was wir auch',
    it: 'che non il di è un per sono mi ho cosa questo ma io',
    pl: 'nie się to jest że na co jak ja mnie tak czy ale',
    id: 'yang dan tidak aku kamu ini itu ke apa ada dengan saya',
};
const STOP = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

// Управляющие коды сообщений: \C[2], \N[1], \FS[20], \{, \. и теги плагинов <...>.
// Имя кода бывает с подчёркиванием: Ironhold Keep хранит в картах не реплики, а
// ссылки \REM_MAP[map17_ev63_p2_elena_15] на файлы перевода — это не текст
const stripCodes = (s) => String(s)
    .replace(/\\[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]/g, ' ')
    .replace(/\\[A-Za-z_][A-Za-z0-9_]*<[^>]*>/g, ' ')
    .replace(/\\[{}.|!><^$A-Za-z]/g, ' ')
    .replace(/<[^>]{0,80}>/g, ' ');

// Одна реплика — одна письменность. Считать по репликам, а не по всему тексту,
// приходится из-за игр вроде Serena, где японский и английский блоки чередуются
function classifyUnit(raw) {
    const s = stripCodes(raw);
    let kana = 0, han = 0, hangul = 0, thai = 0, cyr = 0, latin = 0, viet = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c >= 0x3040 && c <= 0x30ff) kana++;
        else if (c >= 0x4e00 && c <= 0x9fff) han++;
        else if (c >= 0xac00 && c <= 0xd7af) hangul++;
        else if (c >= 0x0e00 && c <= 0x0e7f) thai++;
        else if (c >= 0x0400 && c <= 0x04ff) cyr++;
        else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin++;
        else if (c >= 0x1ea0 && c <= 0x1eff) { latin++; viet++; }
    }
    const groups = { cjk: kana + han, hangul, thai, cyr, latin };
    const [script, letters] = Object.entries(groups).sort((a, b) => b[1] - a[1])[0];
    if (letters < 2) return null;
    // Японская реплика почти всегда с каной; строка из одних иероглифов — китайская
    if (script === 'cjk') return { script: kana ? 'ja' : 'zh', letters, text: s };
    if (script === 'hangul') return { script: 'ko', letters, text: s };
    if (script === 'thai') return { script: 'th', letters, text: s };
    return { script, letters, text: s, viet };
}

// Сводка по набору реплик: сколько букв на каком языке
function tally(units) {
    const letters = {};
    const latinText = [];
    const cyrText = [];
    let viet = 0;
    for (const u of units) {
        if (!u) continue;
        letters[u.script] = (letters[u.script] || 0) + u.letters;
        if (u.script === 'latin') { latinText.push(u.text); viet += u.viet; }
        if (u.script === 'cyr') cyrText.push(u.text);
    }

    // Иероглифы без каны внутри японской игры — это короткие строки вроде «魔物»,
    // а не второй язык. Китайский отдельно считаем, только когда его много
    if (letters.ja && letters.zh && letters.zh < letters.ja * 0.5) {
        letters.ja += letters.zh;
        delete letters.zh;
    }
    if (letters.cyr) {
        const txt = cyrText.join(' ');
        const uk = (txt.match(/[іїєґІЇЄҐ]/g) || []).length;
        const ru = (txt.match(/[ыэъёЫЭЪЁ]/g) || []).length;
        letters[uk > ru ? 'uk' : 'ru'] = letters.cyr;
        delete letters.cyr;
    }
    if (letters.latin) {
        const lang = viet > letters.latin * 0.05 ? 'vi' : latinLanguage(latinText.join(' '));
        // Латиница без узнаваемых слов — идентификаторы и имена файлов, не язык
        if (lang) letters[lang] = (letters[lang] || 0) + letters.latin;
        delete letters.latin;
    }
    return letters;
}

function latinLanguage(text) {
    // Слова с цифрами и подчёркиваниями — идентификаторы (ev63_p2), а не речь
    const words = text.toLowerCase().split(/\s+/)
        .filter(w => !/[\d_]/.test(w))
        .flatMap(w => w.split(/[^a-zà-ɏ]+/))
        .filter(Boolean);
    if (words.length < 20) return null;
    let best = null, bestHits = 0;
    for (const [lang, set] of Object.entries(STOP)) {
        let hits = 0;
        for (const w of words) if (set.has(w)) hits++;
        if (hits > bestHits) { best = lang; bestHits = hits; }
    }
    // В обычной речи таких слов 15–25%, но в играх, где текст — это в основном
    // «Получено: 1 Barometz Fluff», их около 4%. Ниже 3% — уже не язык, а имена
    return bestHits >= 5 && bestHits / words.length >= 0.03 ? best : null;
}

// Языки, на которых написана заметная доля текста, — от главного к второстепенным
function significant(letters) {
    const total = Object.values(letters).reduce((a, b) => a + b, 0);
    return Object.entries(letters)
        .filter(([, n]) => n >= MIN_LETTERS && n >= total * MIN_SHARE)
        .sort((a, b) => b[1] - a[1]);
}

async function readJson(file) {
    try {
        const stat = await fsp.stat(file);
        if (stat.size > 40 * 1024 * 1024) return null;
        return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''));
    } catch (e) {
        return null;
    }
}

// Реплики из событий: «Текст» (401), «Прокручиваемый текст» (405) и варианты выбора (102)
function collectCommands(list, out) {
    for (const c of list || []) {
        if (!c || !Array.isArray(c.parameters)) continue;
        if ((c.code === 401 || c.code === 405) && typeof c.parameters[0] === 'string') out.push(c.parameters[0]);
        else if (c.code === 102 && Array.isArray(c.parameters[0])) out.push(...c.parameters[0].filter(x => typeof x === 'string'));
    }
}

async function dialogueUnits(dataDir) {
    let files;
    try { files = await fsp.readdir(dataDir); } catch (e) { return []; }
    const maps = files.filter(f => /^Map\d+\.json$/i.test(f)).sort();
    const order = ['CommonEvents.json', 'Troops.json', ...maps].filter(f => files.includes(f));

    const units = [];
    let letters = 0;
    for (const f of order) {
        const json = await readJson(path.join(dataDir, f));
        if (!json) continue;
        const lines = [];
        if (Array.isArray(json)) {
            for (const item of json) {
                if (!item) continue;
                collectCommands(item.list, lines);
                for (const page of item.pages || []) collectCommands(page.list, lines);
            }
        } else {
            for (const ev of json.events || []) {
                for (const page of (ev && ev.pages) || []) collectCommands(page.list, lines);
            }
        }
        for (const line of lines) {
            const u = classifyUnit(line);
            if (u) { units.push(u); letters += u.letters; }
        }
        if (letters >= ENOUGH) break;
    }
    return units;
}

// Минимальный разбор CSV: кавычки, "" внутри кавычек и переводы строк в ячейках.
// Таблицы переводов (Hendrix_Localization и похожие) без этого ломаются на первой реплике
function parseCsv(text, maxRows = 4000) {
    const firstLine = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 2000);
    const sep = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length && rows.length < maxRows; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
            } else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === sep) { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (ch !== '\r') cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

// Таблица переводов: у каждой колонки свой язык. Таблица с одним языком — это
// просто данные игры (списки сцен, предметов), о переводах она ничего не говорит
async function csvLanguages(file) {
    let text;
    try {
        const stat = await fsp.stat(file);
        if (stat.size > 12 * 1024 * 1024) return {};
        const fh = await fsp.open(file, 'r');
        try {
            const buf = Buffer.alloc(Math.min(stat.size, MAX_READ));
            await fh.read(buf, 0, buf.length, 0);
            text = buf.toString('utf8').replace(/^﻿/, '');
        } finally { await fh.close(); }
    } catch (e) {
        return {};
    }
    const rows = parseCsv(text);
    const columns = [];
    for (const row of rows.slice(1)) {
        row.forEach((cell, i) => { (columns[i] = columns[i] || []).push(classifyUnit(cell)); });
    }
    const found = {};
    for (const col of columns) {
        if (!col) continue;
        const top = significant(tally(col))[0];
        if (top) found[top[0]] = (found[top[0]] || 0) + top[1];
    }
    return Object.keys(found).length >= 2 ? found : {};
}

// Все строки из JSON-файла перевода — ключи не нужны, только значения
function jsonStrings(node, out, budget = { left: 20000 }) {
    if (budget.left <= 0 || node == null) return out;
    if (typeof node === 'string') { out.push(node); budget.left--; }
    else if (Array.isArray(node)) for (const x of node) jsonStrings(x, out, budget);
    else if (typeof node === 'object') for (const v of Object.values(node)) jsonStrings(v, out, budget);
    return out;
}

async function fileLanguage(file) {
    if (/\.csv$/i.test(file)) return csvLanguages(file);
    if (!/\.(json|txt|po)$/i.test(file)) return {};
    let text;
    try {
        const fh = await fsp.open(file, 'r');
        try {
            const buf = Buffer.alloc(Math.min((await fh.stat()).size, MAX_READ));
            await fh.read(buf, 0, buf.length, 0);
            text = buf.toString('utf8').replace(/^﻿/, '');
        } finally { await fh.close(); }
    } catch (e) {
        return {};
    }
    let strings;
    try { strings = jsonStrings(JSON.parse(text), []); } catch (e) { strings = text.split('\n'); }
    // Файл перевода — один язык: берём главный
    const top = significant(tally(strings.map(classifyUnit)))[0];
    return top ? { [top[0]]: top[1] } : {};
}

// Папки локализаций. Внутри — файл или подпапка на каждый язык, но имя ничего
// не гарантирует: в LAT в «en.json» лежит русский перевод. Поэтому читаем содержимое.
// locales/*.pak — это файлы самого NW.js, к языкам игры отношения не имеют
const LOC_DIR = /^(locales?|languages?|langs?|loc|locali[sz]ation|translations?|i18n)$/i;

async function locDirLanguages(dir) {
    const found = {};
    const add = (res) => { for (const [k, v] of Object.entries(res)) found[k] = (found[k] || 0) + v; };
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return found; }
    for (const e of entries.slice(0, 40)) {
        if (e.name.startsWith('.') || /\.(pak|info)$/i.test(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isFile()) add(await fileLanguage(full));
        else if (e.isDirectory()) {
            // Подпапка языка (languages/DE/...). Читаем, пока язык не станет ясен:
            // полный перевод определится по первым файлам, а неполный (Seven Keys,
            // немецкий — 338 файлов, почти все пустые) заполнен кусками где-то в конце
            const inner = await fsp.readdir(full).catch(() => []);
            const merged = {};
            for (const f of inner.filter(x => /\.(json|txt|po|csv)$/i.test(x)).slice(0, 500)) {
                for (const [k, v] of Object.entries(await fileLanguage(path.join(full, f)))) merged[k] = (merged[k] || 0) + v;
                if (Math.max(0, ...Object.values(merged)) >= 20000) break;
            }
            const top = significant(merged)[0];
            if (top) add({ [top[0]]: top[1] });
        }
    }
    return found;
}

// Язык, на котором игру делали. Имена карт видит только автор в редакторе, и
// переводчики их обычно не трогают: японские имена карт у английской игры —
// верный признак перевода. Кириллица и латиница в именах карт ничего не доказывают
// (их как раз переводят), тогда смотрим язык редактора из System.json
const LOCALE_LANG = { ja: 'ja', zh: 'zh', ko: 'ko', en: 'en', us: 'en', ru: 'ru', uk: 'uk', de: 'de', fr: 'fr', es: 'es', pt: 'pt', it: 'it', pl: 'pl', th: 'th', vi: 'vi', id: 'id' };

async function originalLanguage(dataDir) {
    const infos = await readJson(path.join(dataDir, 'MapInfos.json'));
    if (Array.isArray(infos)) {
        const names = infos.filter(Boolean).map(m => m.name || '').join(' ');
        const kana = (names.match(/[぀-ヿ]/g) || []).length;
        const han = (names.match(/[一-鿿]/g) || []).length;
        const hangul = (names.match(/[가-힯]/g) || []).length;
        const thai = (names.match(/[฀-๿]/g) || []).length;
        if (kana >= 3) return 'ja';
        if (han >= 8) return 'zh';
        if (hangul >= 8) return 'ko';
        if (thai >= 8) return 'th';
    }
    const sys = await readJson(path.join(dataDir, 'System.json'));
    const prefix = String(sys?.locale || '').slice(0, 2).toLowerCase();
    return LOCALE_LANG[prefix] || null;
}

async function findDataDir(gamePath) {
    for (const d of ['data', 'www/data']) {
        const dir = path.join(gamePath, d);
        try { await fsp.access(path.join(dir, 'System.json')); return dir; } catch (e) {}
    }
    return null;
}

// Итог: main — язык, которым игра говорит по умолчанию; langs — все языки с
// настоящим текстом, главный первым; original — язык, на котором её делали.
// Перевод — это когда main не совпадает с original
async function detectGameLanguages(gamePath) {
    const dataDir = await findDataDir(gamePath);
    if (!dataDir) return null;
    const root = path.dirname(dataDir);

    const dialogue = significant(tally(await dialogueUnits(dataDir)));

    const extra = {};
    const add = (res) => { for (const [k, v] of Object.entries(res)) extra[k] = (extra[k] || 0) + v; };

    // Соседние папки данных под другой язык: data_ru рядом с data
    for (const e of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory() && /^data[_-][a-z]{2,5}$/i.test(e.name)) {
            for (const [lang, n] of significant(tally(await dialogueUnits(path.join(root, e.name))))) add({ [lang]: n });
        }
    }

    // Таблицы переводов и папки локализаций — в корне игры, рядом с data и в самой data
    const places = [...new Set([gamePath, root, dataDir])];
    for (const place of places) {
        for (const e of await fsp.readdir(place, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(place, e.name);
            if (e.isFile() && /\.csv$/i.test(e.name) && !/backup/i.test(e.name)) add(await csvLanguages(full));
            else if (e.isDirectory() && LOC_DIR.test(e.name)) add(await locDirLanguages(full));
        }
    }

    // Порог доли уже применён внутри каждого источника, здесь — только объём
    const langs = dialogue.map(([lang]) => lang);
    const others = Object.entries(extra).filter(([, n]) => n >= MIN_LETTERS).sort((a, b) => b[1] - a[1]);
    for (const [lang] of others) if (!langs.includes(lang)) langs.push(lang);
    if (!langs.length) return null;

    return { main: langs[0], langs, original: await originalLanguage(dataDir) };
}

module.exports = { detectGameLanguages, findDataDir, classifyUnit, tally, significant, dialogueUnits, latinLanguage, parseCsv };
