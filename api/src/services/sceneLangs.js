// Языки реплик сцен: переводы, которые игра везёт с собой (таблица плагина, папка data_xx), и выбор языка при показе
// сцены. Таблица строится один раз на сборку галереи (gallery.js, sceneLangs) и лежит рядом со сценариями (langs.json);
// файлы игры только читаются. Язык таблицы определяем по самому тексту, а не по названию столбца или папки: в играх
// «en.json» бывает русским, а «data_ru» — японским с вырезанными «っ»
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { classifyUnit, tally, significant, parseCsv } = require('../utils/gamelang.js');
const { readGameJson } = require('../utils/gameData.js');

const VERSION = 1;
const MAX_FILE = 32 * 1024 * 1024;
const MIN_SHARE = 0.1;
const SAMPLE = 3000;
const NAMEBOX = /^((?:\\[Cc]\[\d+\])*\\n<([^>]*)>)/i;
const TAG = /\{(.*?)\}/g;
const ALIAS = { jp: 'ja', cn: 'zh', ch: 'zh', tc: 'zh', sc: 'zh', zw: 'zh', kr: 'ko' };
const SCRIPT = (code) => (['ja', 'zh', 'ko', 'th'].includes(code) ? code : code === 'ru' || code === 'uk' ? 'cyr' : 'latin');
const FAMILY = (s) => (s === 'ja' || s === 'zh' ? 'cjk' : s);
const base = (n) => String(n || '').split('/').pop();
const jparse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const str = (v) => (typeof v === 'string' && v ? v : undefined);
// Имя говорящего без тегов плагинов («阿乌拉<e19>» → «阿乌拉»); если от имени ничего не осталось («<???>») — оно само
const stripTags = (n) => String(n || '').replace(/<[^>]+>/g, '').trim() || String(n || '');

async function readText(file) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile() || st.size > MAX_FILE) return null;
    return (await fsp.readFile(file, 'utf8').catch(() => '')).replace(/^﻿/, '') || null;
}
const readJson = async (file) => { const t = await readText(file); return t ? jparse(t, null) : null; };

async function enabledPlugins(root) {
    const out = new Map();
    let text;
    try { text = await fsp.readFile(path.join(root, 'js', 'plugins.js'), 'utf8'); } catch { return out; }
    const list = jparse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1), null);
    if (Array.isArray(list)) {
        for (const p of list) if (p && p.status === true) out.set(base(p.name), p.parameters || {});
        return out;
    }
    // plugins.js не JSON (лишняя запятая, ключи без кавычек): хотя бы имена включённых плагинов, параметры — по умолчанию
    for (const m of text.matchAll(/["']?name["']?\s*:\s*["']([^"']+)["']\s*,\s*["']?status["']?\s*:\s*true/g)) out.set(base(m[1]), null);
    return out;
}

async function detect(root) {
    const pl = await enabledPlugins(root);
    const has = (f) => fs.existsSync(path.join(root, f));
    const found = [];
    if (pl.has('Hendrix_Localization') && has('game_messages.csv')) found.push(['hendrix', pl.get('Hendrix_Localization')]);
    if (pl.has('ROC_MultiLanguage') && has('languages/languages.list')) found.push(['roc', pl.get('ROC_MultiLanguage')]);
    if (pl.has('Hakubox_Translate')) {
        const files = (await fsp.readdir(path.join(root, 'data')).catch(() => [])).filter((f) => /^Hakubox-Translate-[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?\.json$/.test(f));
        if (files.length) found.push(['hakubox', pl.get('Hakubox_Translate')]);
    }
    if (pl.has('DKTools_Localization')) {
        const folder = String(pl.get('DKTools_Localization')?.['Localization Folder'] || 'locales/');
        if (!folder.includes('..') && has(folder)) found.push(['dktools', pl.get('DKTools_Localization')]);
    }
    const dirs = (await fsp.readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && /^data[_-][a-z]{2,5}$/i.test(e.name));
    const suffixed = (await fsp.readdir(path.join(root, 'data')).catch(() => [])).some((f) => /^(?:Map\d{3,}|CommonEvents|Troops)_[a-z]{2,5}\.json$/i.test(f));
    if (dirs.length || suffixed) found.push(['data', null]);
    return found;
}

// ---------- loaders: { code, src, values: [строки для подписи], msg(lines) → текст | undefined, str(s) → текст | undefined }
async function hendrix(root, params) {
    const text = await readText(path.join(root, 'game_messages.csv'));
    if (!text) return [];
    const rows = parseCsv(text, Infinity);
    const head = (rows[0] || []).map((s) => String(s).trim());
    const oi = head.indexOf('Original');
    const ei = head.indexOf('Excluded');
    if (oi < 0) return [];
    const declared = (jparse(params?.Languages, []) || []).map((x) => jparse(x, {})?.Symbol).filter(Boolean);
    const symbols = (jparse(params?.['Excluded Symbols'], []) || []).map((x) => jparse(x, {})?.Symbol).filter((s) => typeof s === 'string' && s);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const yep = (t) => {
        let name = '';
        let rest = t;
        for (const s of symbols) for (const m of rest.match(new RegExp(esc(s).replace('\\*', '(.+?)'), 'g')) || []) { name += m; rest = rest.replace(m, ''); }
        return { name, rest };
    };
    const out = [];
    for (let c = oi + 1; c < head.length; c++) {
        if (!head[c] || /^(change|excluded|name)$/i.test(head[c]) || (declared.length && !declared.includes(head[c]))) continue;
        const d = new Map();
        for (const r of rows.slice(1)) {
            const o = r[oi];
            const v = r[c];
            if (!o || !v || !v.trim()) continue;
            d.set(o, v);
            if (ei >= 0 && r[ei]) d.set(r[ei] + o, v);
        }
        if (!d.size) continue;
        const msg = (lines) => {
            const { name, rest } = yep(lines.join('\n'));
            const v = d.get(name + rest) ?? d.get(rest);
            if (v !== undefined) return name + v;
            const ls = rest.split('\n').map((l) => d.get(l.trim()) ?? l);
            ls[0] = name + ls[0];
            return ls.join('\n');
        };
        out.push({ code: head[c], src: 'hendrix', values: [...d.values()], msg, str: (s) => d.get(s) ?? d.get(String(s).trim()) });
    }
    return out;
}

async function roc(root) {
    const dir = path.join(root, 'languages');
    const list = await readJson(path.join(dir, 'languages.list'));
    const out = [];
    for (const l of Array.isArray(list) ? list : []) {
        const f = String(l?.filename || '');
        if (!f || /[\\/]|\.\./.test(f)) continue;
        const d = await readJson(path.join(dir, f));
        if (!d || typeof d.talks !== 'object' || !d.talks) continue;
        const talks = d.talks;
        const other = d.othertexts && typeof d.othertexts === 'object' ? d.othertexts : {};
        out.push({ code: String(l.name || f), src: 'roc', values: Object.values(talks).filter((x) => typeof x === 'string'),
            msg: (lines) => str(talks[lines.join('<br>')])?.split('<br>').join('\n'), str: (s) => str(other[s]) ?? str(talks[s]) });
    }
    return out;
}

async function hakubox(root) {
    const dir = path.join(root, 'data');
    const out = [];
    for (const f of (await fsp.readdir(dir).catch(() => [])).sort()) {
        const m = /^Hakubox-Translate-([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.json$/.exec(f);
        if (!m) continue;
        const d = await readJson(path.join(dir, f));
        if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
        const g = (k) => str(d[k]);
        const msg = (lines) => {
            const all = lines.join('\n');
            const v = g(all);
            if (v !== undefined) return v;
            const p = NAMEBOX.exec(all);
            const rest = p && g(all.slice(p[1].length));
            if (rest === undefined || rest === null) return undefined;
            const bare = p[2].replace(/\\[Cc]\[\d+\]/g, '');
            const nm = bare && g(bare);
            return (nm ? p[1].replace(`<${p[2]}>`, `<${p[2].replace(bare, nm)}>`) : p[1]) + rest;
        };
        out.push({ code: m[1], src: 'hakubox', values: Object.values(d).filter((x) => typeof x === 'string'), msg, str: g });
    }
    return out;
}

const resolver = (depth) => (d, s) => {
    let t = String(s);
    for (let k = 0; k < depth; k++) {
        const n = t.replace(TAG, (m, key) => (d && typeof d[key] === 'string' ? d[key] : key));
        if (n === t) break;
        t = n;
    }
    return t;
};
async function dktools(root, params) {
    const folder = String(params?.['Localization Folder'] || 'locales/');
    if (folder.includes('..')) return [];
    const dir = path.join(root, folder);
    const resolve = resolver(Math.max(1, Math.min(3, Number(params?.['Parse Depth']) || 2)));
    let codes = (jparse(params?.Languages, []) || []).map((x) => jparse(x, {})?.Locale).filter((c) => typeof c === 'string' && /^[\w-]{1,16}$/.test(c));
    if (!codes.length) codes = (await fsp.readdir(dir).catch(() => [])).filter((f) => /^[\w-]{1,16}\.json$/.test(f)).map((f) => f.slice(0, -5));
    const out = [];
    for (const code of codes) {
        const d = await readJson(path.join(dir, `${code}.json`));
        if (!d || typeof d !== 'object') continue;
        const tagged = (s) => /\{.*?\}/.test(s);
        out.push({ code, src: 'dktools', values: Object.values(d).filter((x) => typeof x === 'string'),
            msg: (lines) => (lines.some(tagged) ? lines.map((l) => resolve(d, l)).join('\n') : undefined),
            str: (s) => (tagged(s) ? resolve(d, s) : undefined) });
    }
    return { tables: out, base: (s) => resolve(null, s) };
}

// ---------- параллельные данные: data_xx/ или data/<Файл>_xx.json
function eachList(json, file, fn) {
    if (/^CommonEvents/i.test(file)) (Array.isArray(json) ? json : []).forEach((c) => c && Array.isArray(c.list) && fn(`ce${c.id}`, c.list));
    else if (/^Troops/i.test(file)) (Array.isArray(json) ? json : []).forEach((t) => t && (t.pages || []).forEach((pg, i) => pg && Array.isArray(pg.list) && fn(`t${t.id}p${i}`, pg.list)));
    else (json && Array.isArray(json.events) ? json.events : []).forEach((ev) => ev && (ev.pages || []).forEach((pg, i) => pg && Array.isArray(pg.list) && fn(`e${ev.id}p${i}`, pg.list)));
}
function messagesOf(list) {
    const msgs = [];
    const chs = [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        if (c.code === 101) {
            const lines = [];
            for (let j = i + 1; list[j] && list[j].code === 401; j++) lines.push(String(list[j].parameters?.[0] ?? ''));
            const p = c.parameters || [];
            msgs.push({ lines, name: typeof p[4] === 'string' ? p[4] : '', face: `${p[0] || ''}#${p[0] ? p[1] : ''}` });
        } else if (c.code === 102 && Array.isArray(c.parameters?.[0])) chs.push(c.parameters[0].map(String));
    }
    return { msgs, chs };
}
async function parallel(root, wanted, stats) {
    const data = path.join(root, 'data');
    const variants = new Map();
    for (const e of (await fsp.readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const m = /^data[_-]([a-z]{2,5})$/i.exec(e.name);
        if (e.isDirectory() && m && !variants.has(m[1].toLowerCase())) variants.set(m[1].toLowerCase(), (f) => path.join(root, e.name, f));
    }
    const all = await fsp.readdir(data).catch(() => []);
    for (const f of all.sort()) {
        const m = /^(?:Map\d{3,}|CommonEvents|Troops)_([a-z]{2,5})\.json$/i.exec(f);
        const c = m && m[1].toLowerCase();
        if (c && !variants.has(c)) variants.set(c, (x) => path.join(data, x.replace(/\.json$/i, `_${m[1]}.json`)));
    }
    if (!variants.size) return [];
    const infos = await readGameJson(root, path.join(data, 'MapInfos.json')).catch(() => null);
    const files = ['CommonEvents.json', 'Troops.json', ...(Array.isArray(infos) ? infos : []).filter(Boolean).map((m) => `Map${String(m.id).padStart(3, '0')}.json`)];
    const origin = new Map();
    const oorigin = new Map();
    const hits = new Map();
    const parsed = new Map();   // файл → Map(список → разобранные сообщения): оригиналы читаем и разбираем один раз на все варианты
    for (const f of files) {
        const j = await readGameJson(root, path.join(data, f)).catch(() => null);
        if (!j) continue;
        await new Promise(setImmediate);   // карты Stigma — 9,6 МБ: между файлами отдаём цикл событий
        eachList(j, f, (lid, list) => {
            const { msgs, chs } = messagesOf(list);
            const mark = () => {
                (hits.get(f) || hits.set(f, new Set()).get(f)).add(lid);
                (parsed.get(f) || parsed.set(f, new Map()).get(f)).set(lid, { msgs, chs });
            };
            msgs.forEach((m, k) => { const key = m.lines.join('\n'); if (wanted.msgs.has(key) && !origin.has(key)) { origin.set(key, `${f}|${lid}|${k}`); mark(); } });
            chs.forEach((o, k) => { const key = o.join('\u0000'); if (wanted.optSets.has(key) && !oorigin.has(key)) { oorigin.set(key, `${f}|${lid}|${k}`); mark(); } });
        });
    }
    const out = [];
    for (const [code, at] of variants) {
        const msgT = new Map();
        const names = new Map();
        const opts = new Map();
        for (const [f, lids] of hits) {
            if (!fs.existsSync(at(f))) continue;
            const tr = await readGameJson(root, at(f)).catch(() => null);
            if (!tr) continue;
            await new Promise(setImmediate);
            const A = parsed.get(f);
            const B = new Map();
            eachList(tr, f, (lid, list) => lids.has(lid) && B.set(lid, messagesOf(list)));
            for (const [lid, a] of A) {
                const b = B.get(lid);
                // То же число сообщений и те же лица — иначе список переписан: не сопоставляем совсем
                if (!b || b.msgs.length !== a.msgs.length || a.msgs.some((m, k) => m.face !== b.msgs[k].face)) { stats.skipped = (stats.skipped || 0) + 1; continue; }
                a.msgs.forEach((m, k) => {
                    const key = m.lines.join('\n');
                    if (origin.get(key) !== `${f}|${lid}|${k}`) return;
                    msgT.set(key, b.msgs[k].lines.join('\n'));
                    if (m.name && b.msgs[k].name && !names.has(m.name)) names.set(m.name, b.msgs[k].name);
                });
                if (b.chs.length === a.chs.length) a.chs.forEach((o, k) => { if (oorigin.get(o.join('\u0000')) === `${f}|${lid}|${k}` && b.chs[k].length === o.length) o.forEach((s, i) => { if (!opts.has(s)) opts.set(s, b.chs[k][i]); }); });
            }
        }
        out.push({ code, src: 'data', values: [...msgT.values()], msg: (lines) => msgT.get(lines.join('\n')), str: (s) => names.get(s) ?? opts.get(s) });
    }
    return out;
}

// ---------- подпись по тексту
function topLang(texts) {
    const t = tally(texts.map(classifyUnit));
    const sig = significant(t);
    if (sig.length) return sig[0][0];
    const e = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
    return e && e[1] >= 20 ? e[0] : '';
}
const alias = (c) => { const m = /^[a-z]{2}/i.exec(String(c)); const k = m && m[0].toLowerCase(); return k ? ALIAS[k] || k : ''; };
const sample = (arr) => (arr.length <= SAMPLE ? arr : Array.from({ length: SAMPLE }, (_, i) => arr[Math.floor((i * arr.length) / SAMPLE)]));

// wanted: { msgs: Map(key → lines), optSets: Set(o.join('\0')), opts: Set, names: Set (без тегов) }
async function build(root, loadWanted, stats = {}) {
    const found = await detect(root);
    stats.mechs = found.map((x) => x[0]);
    if (!found.length) return { v: VERSION, orig: '', langs: [], text: {} };
    const wanted = await loadWanted();
    const tables = [];
    let dk = null;
    for (const [kind, params] of found) {
        await new Promise(setImmediate);
        try {
            if (kind === 'hendrix') tables.push(...(await hendrix(root, params)));
            else if (kind === 'roc') tables.push(...(await roc(root)));
            else if (kind === 'hakubox') tables.push(...(await hakubox(root)));
            else if (kind === 'dktools') { const r = await dktools(root, params); dk = r.base; tables.push(...r.tables); }
            else if (kind === 'data') tables.push(...(await parallel(root, wanted, stats)));
        } catch (e) { stats.errors = [...(stats.errors || []), `${kind}: ${e.message}`]; }
    }
    // Как реплику видит игра без перевода: у DKTools в тексте ключи «{…}» — без скобок
    const baseText = new Map();
    const baseStr = new Map();
    if (dk) {
        for (const [key, lines] of wanted.msgs) if (lines.some((l) => /\{.*?\}/.test(l))) baseText.set(key, lines.map(dk).join('\n'));
        for (const s of [...wanted.opts, ...wanted.names]) if (/\{.*?\}/.test(s)) baseStr.set(s, dk(s));
    }
    const view = (key) => baseText.get(key) ?? key;
    const viewS = (s) => baseStr.get(s) ?? s;
    const orig = topLang([...wanted.msgs.keys()].map(view));
    const counted = [...wanted.msgs.keys()].filter((k) => classifyUnit(view(k)));
    const total = counted.length;
    const kept = new Map();
    stats.decisions = [];
    for (const t of tables) {
        let label = '';
        try { label = topLang(sample(t.values)) || alias(t.code); } catch { label = alias(t.code); }
        const text = {};
        let n = 0;
        let off = 0;
        // Перевод на письменности оригинала, когда язык таблицы на другой, — испорченный оригинал (data_ru без «っ»), не перевод
        const accept = (from, to) => {
            if (typeof to !== 'string' || to === from) return false;
            const uo = classifyUnit(from);
            const ut = classifyUnit(to);
            if (uo && ut && FAMILY(ut.script) === FAMILY(uo.script) && FAMILY(SCRIPT(label)) !== FAMILY(uo.script)) { off++; return false; }
            return true;
        };
        for (const [key, lines] of wanted.msgs) {
            let v;
            try { v = t.msg(lines); } catch { v = undefined; }
            if (!accept(view(key), v)) continue;
            text[key] = v;
            if (classifyUnit(view(key)) && classifyUnit(v)?.script === SCRIPT(label)) n++;
        }
        for (const s of new Set([...wanted.opts, ...wanted.names])) {
            let v;
            try { v = t.str(s); } catch { v = undefined; }
            if (accept(viewS(s), v)) text[s] = v;
        }
        const why = !label ? 'no label' : label === orig ? 'same as original' : n < Math.max(1, MIN_SHARE * total) ? 'coverage' : '';
        stats.decisions.push({ src: `${t.src}:${t.code}`, label, n, of: total, off, why: why || 'keep' });
        if (why) continue;
        if (!kept.has(label) || kept.get(label).n < n) kept.set(label, { code: label, src: t.src, n, of: total, text });
    }
    const langs = [...kept.values()].sort((a, b) => b.n - a.n);
    const out = { v: VERSION, orig, langs: langs.map(({ code, src, n, of }) => ({ code, src, n, of })), text: Object.fromEntries(langs.map((l) => [l.code, l.text])) };
    if (baseText.size || baseStr.size) out.base = Object.fromEntries([...baseText, ...baseStr]);
    return out;
}

// ---------- показ: какой язык выбран и откуда берётся каждая реплика
const CODE = /^(orig|[a-z]{2,3}(-[a-z0-9]{2,8})?)$/;
// Коды языков из запроса: строка или список через запятую, до 8, только по шаблону — ключи поиска и больше ничего
const codes = (v) => String(v ?? '').toLowerCase().split(',').map((c) => c.trim()).filter((c) => CODE.test(c)).slice(0, 8);
// Таблица перевода склеила имя с репликой («Мейбер: Фух…»): имя обратно в рамку, только если у оригинала оно было
const MERGED = /^([^\n:：「『"“（(.!?。！？]{1,40}?)\s*[:：]\s*([\s\S]+)$/;

// Шаги сцены с текстом на выбранном языке. data — сценарий из файла; T — таблица игры (или null); speech — разбор кодов
// окна сообщения (galleryScenes.speech). opts: want (коды из запроса), ui (язык интерфейса), known (языки, которые
// знает человек), mt (язык перевода Mimikin), tr (Map оригинал → перевод Mimikin или null), client (новый клиент:
// прислал ui или lang). Шаги и их порядок одни и те же на любом языке: есть ли реплика, решает вид оригинала
function serve(data, T, { want = [], ui = '', known = [], mt = '', tr = null, client = false } = {}, speech) {
    const tables = T?.text || {};
    const base = T?.base || {};
    const origCode = T?.orig || '';
    const says = data.steps.filter((x) => x.k === 'say' || x.k === 'choice');
    // Варианты: оригинал, таблицы игры и перевод Mimikin (если его язык — не язык таблицы игры)
    let options = [{ code: origCode || 'orig', orig: true }, ...(T?.langs || []).map((l) => ({ code: l.code }))];
    if (mt && mt !== origCode && !options.some((o) => o.code === mt)) options.push({ code: mt, mt: true });
    // Язык, в котором на этой сцене нет ни одной реплики, не предлагаем
    const covers = (code, x) => {
        const t = tables[code];
        const m = code === mt && tr;
        if (x.k === 'say') return t?.[x.l.join('\n')] !== undefined || (!!x.n && t?.[stripTags(x.n)] !== undefined) || (!!m && (x.l.some((l) => tr.has(l)) || (!!x.n && tr.has(x.n))));
        return x.o.some((o) => t?.[o] !== undefined || (!!m && tr.has(o)));
    };
    for (const o of options) if (!o.orig) o.n = says.filter((x) => covers(o.code, x)).length;
    options = options.filter((o) => o.orig || o.n > 0);
    // Старый клиент (без ui и lang) получает то, что было: перевод Mimikin, если он есть
    const chain = client ? [...new Set([...want, mt, ui, ...known, 'en'].filter(Boolean))] : [mt].filter(Boolean);
    const avail = chain.filter((c) => c === 'orig' || options.some((o) => o.code === c)).map((c) => (c === 'orig' || c === origCode ? 'orig' : c));
    const chosen = avail[0] || 'orig';
    // Чего не нашлось на выбранном языке — со следующего по цепочке, но не дальше оригинала
    const order = chosen === 'orig' ? [] : [...new Set(avail.slice(0, avail.indexOf('orig') < 0 ? undefined : avail.indexOf('orig')))];
    const pickMsg = (key, lines) => {
        for (const c of order) {
            if (tables[c]?.[key] !== undefined) return tables[c][key].split('\n');
            if (c === mt && tr && lines.some((l) => tr.has(l))) return lines.map((l) => tr.get(l) ?? l);
        }
        return null;
    };
    const pickStr = (s, raw) => {
        for (const c of order) {
            if (tables[c]?.[s] !== undefined) return tables[c][s];
            if (c === mt && tr && tr.has(raw)) return tr.get(raw);
        }
        return null;
    };
    // Имена героев, которые сцена задала сама (a), поверх Actors.json — тоже по цепочке
    const cast = (x, view) => (x.a ? Object.assign([...(data.actors || [])], Object.fromEntries(Object.entries(x.a).map(([n, v]) => [n, (view ? null : pickStr(stripTags(v), v)) ?? base[stripTags(v)] ?? v]))) : data.actors);
    const steps = [];
    for (const x of data.steps) {
        if (x.k === 'say') {
            const key = x.l.join('\n');
            const n0 = x.n ? stripTags(x.n) : '';
            const view = base[key] !== undefined ? base[key].split('\n') : x.l;
            const nameView = n0 ? base[n0] ?? n0 : '';
            const first = speech(view, nameView, x.v, cast(x, true));
            if (!first.text) continue;
            const lines = pickMsg(key, x.l);
            const name = n0 ? pickStr(n0, x.n) ?? nameView : '';
            let shown = lines ? speech(lines, name, x.v, cast(x)) : null;
            if (shown && !shown.text) shown = null;
            if (!shown) shown = name === nameView && !x.a ? first : speech(view, name, x.v, cast(x));
            else if (first.who && !shown.who) {
                const m = MERGED.exec(shown.text);
                if (m) shown = { who: m[1].trim(), text: m[2] };
            }
            steps.push({ k: 'say', who: shown.who, text: shown.text });
        } else if (x.k === 'choice') {
            steps.push({ k: 'choice', o: x.o.map((o) => speech([pickStr(o, o) ?? base[o] ?? o], '', {}, cast(x)).text), i: x.i });
        } else if (x.k === 'snd') {
            const f = data.sounds?.[x.f];
            if (f) steps.push({ k: 'snd', kind: x.kind, f, vol: x.vol, pitch: x.pitch, pan: x.pan });
        } else steps.push(x);
    }
    return { steps, ...(options.length > 1 ? { lang: chosen === 'orig' ? options[0].code : chosen, langs: options } : {}) };
}

module.exports = { VERSION, detect, build, serve, codes, stripTags, enabledPlugins };
