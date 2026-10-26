// Сцены движка сценариев TS_ADVsystem (Tidecaller, Clockwork Vale): событие игры зовёт «AdvLoad 001», а сама сцена —
// текстовый файл scenario/001.(txt|sl) с макросами «@bgf bg=ev01», «@se f=…» и строками «[Имя:/голос] реплика».
// Файл переводим в обычные команды RPG Maker — те, что делает сам плагин (231 картинка, 101/401 реплика, звук,
// вспышка, затемнение) — и отдаём сборке сцен как ещё одно событие: альбомы и сценарии плеера строит тот же путь, что для событий
const fsp = require('fs').promises;
const path = require('path');
const { readGameText } = require('../utils/gameData.js');

const ADV_ID = 'adv:';
const ADV_FILES = 2000;              // файлов сценария на игру: дальше не читаем
const ADV_BYTES = 2 * 1024 * 1024;   // файл больше — не сценарий (у Tidecaller самый большой — 27 КБ)
const ADV_LINES = 20000;
// Номера картинок плагина: фон — 1, CG «@ev» — слой 1 (база 10 + 5), врезка «@ev2» — слой 7 (75)
const SLOT = { bg: 1, ev: 15, ev2: 75 };
// «Стереть всё» плагина (deletePicture(-1)) обходит слои 0…6: врезку 75 оно не трогает
const KEEP_ON_CLEAR = new Set([SLOT.ev2]);
// Меню выбора и переходы: такой файл — не одна сцена от начала до конца
const BRANCH = /^[ \t]*@(?:select|if|jump)(?:\s|$)/m;

const isLine = (text) => text.split('\n').some((l) => l.trim()[0] === '@');
// Шифр TS_Decode: каждый символ UTF-16 (не код символа: эмодзи — два) XOR ключ, записано как UTF-8
const xor = (s, key) => {
    let out = '';
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ key);
    return out;
};

// Плагин включён и папка сценариев есть — { dir, read(name) → { file, text } | null }, иначе null
async function config(root) {
    let plugins;
    try {
        const text = await fsp.readFile(path.join(root, 'js', 'plugins.js'), 'utf8');
        plugins = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    } catch { return null; }
    if (!Array.isArray(plugins)) return null;
    const on = (name) => plugins.find((p) => p && p.name === name && p.status === true);
    if (!on('TS_ADVsystem')) return null;
    // Папка — рядом с index.html (так её читает rpg-fixes), у раскладки с www — ещё и рядом с www (так её ищет сам плагин)
    let dir = null;
    for (const base of path.basename(root).toLowerCase() === 'www' ? [root, path.dirname(root)] : [root]) {
        const e = (await fsp.readdir(base, { withFileTypes: true }).catch(() => [])).find((x) => x.isDirectory() && x.name.toLowerCase() === 'scenario');
        if (e) { dir = path.join(base, e.name); break; }
    }
    if (!dir) return null;
    // Ключ — из TS_Decode, а шифровать или нет — по самому файлу: у Clockwork Vale параметр «Decode: true», а плагин
    // переписан на обычный .txt без шифра
    const k = parseInt(on('TS_Decode')?.parameters?.Key, 10);
    const key = Number.isInteger(k) && k > 0 && k < 65536 ? k : 255;
    const files = new Map();       // имя без расширения (регистр не важен) → { txt, sl }
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const m = /^(.+)\.(txt|sl)$/i.exec(e.name);
        if (!e.isFile() || !m) continue;
        const n = m[1].toLowerCase();
        if (!files.has(n)) files.set(n, {});
        files.get(n)[m[2].toLowerCase()] = e.name;
    }
    const cache = new Map();
    const read = async (name) => {
        const n = String(name).toLowerCase();
        if (cache.has(n)) return cache.get(n);
        let out = null;
        const f = files.get(n);
        // .txt первым — как rpg-fixes в браузере
        for (const file of f ? [f.txt, f.sl].filter(Boolean) : []) {
            const full = path.join(dir, file);
            const st = await fsp.stat(full).catch(() => null);
            if (!st || st.size > ADV_BYTES) continue;
            const raw = await readGameText(root, full).catch(() => null);
            if (raw === null) continue;
            const ways = /\.sl$/i.test(file) ? [() => xor(raw, key), () => raw] : [() => raw, () => xor(raw, key)];
            for (const way of ways) {
                const text = way().replace(/^﻿/, '');
                // Ключ не тот или файл не сценарий: ни одной строки-макроса
                if (isLine(text)) { out = { file, text }; break; }
            }
            if (out) break;
        }
        cache.set(n, out);
        return out;
    };
    return { dir, read };
}

// Ссылки «AdvLoad имя» в командах события (356, MV). «AdvLoad macro …» — одна строка-макрос, имя с \V[n] — из переменной
function refs(list, where, map, id) {
    const out = [];
    for (const c of Array.isArray(list) ? list : []) {
        if (!c || c.code !== 356) continue;
        const m = /^\s*AdvLoad\s+(\S+)/.exec(String(c.parameters?.[0] ?? ''));
        if (m && m[1] !== 'macro' && !m[1].includes('\\')) out.push({ file: m[1], where, map, id });
    }
    return out;
}

// Аргументы макроса — как makeArg плагина: «ключ=значение» через пробел, значение может содержать «=»
const makeArg = (line) => {
    const out = {};
    for (const w of line.split(' ').slice(1)) { const [k, ...v] = w.split('='); if (k) out[k] = v.join('='); }
    return out;
};
const frames = (ms) => Math.floor((60 * Number(ms)) / 1000);
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

// Текст сценария → команды RPG Maker. screen — { w, h }; size(name) → { w, h } | null; exists(name) — картинка есть
function toCommands(text, screen, size, exists = (n) => !!size(n)) {
    const W = screen.w / 2;
    const H = screen.h / 2;
    const list = [];
    const at = new Map();          // номер картинки → имя
    const cmd = (code, parameters) => list.push({ code, indent: 0, parameters });
    const show = (id, name, x, y) => {
        const s = size(name);
        x = num(x, 0);
        y = num(y, 0);
        // Плагин ставит картинку серединой в середину экрана со сдвигом; размер знаем — левым верхним углом, как её
        // видит composeFrames (CG на весь экран — целая картинка, не слой). Прозрачность — 255: проявление «@move» не считаем
        if (s) cmd(231, [id, name, 0, 0, Math.round(W + x - s.w / 2), Math.round(H + y - s.h / 2), 100, 100, 255, 0]);
        else cmd(231, [id, name, 1, 0, W + x, H + y, 100, 100, 255, 0]);
        at.set(id, name);
    };
    const erase = (id) => { if (at.has(id)) { cmd(235, [id]); at.delete(id); } };
    const clear = () => { for (const id of [...at.keys()]) if (!KEEP_ON_CLEAR.has(id)) erase(id); };
    const byName = (f) => { for (const [id, n] of [...at]) if (n.includes(f)) erase(id); };
    const audio = (a) => ({ name: a.f, volume: num(a.vol, 90), pitch: num(a.pitch, 100), pan: num(a.pan, 0) });
    const color = (s, d) => { const c = String(s ?? '').split(',').map(Number); return c.length === 4 && c.every(Number.isFinite) ? c : d; };
    // «v» — вариант «_v» по переключателю игры: основной картинки нет — берём его
    const pick = (f, v) => (v && !exists(f) && exists(`${f}_v`) ? `${f}_v` : f);
    const ev = (id, a, exact) => {
        if (exact) { erase(id); return; }
        if (a.f === undefined) { clear(); return; }
        if (num(a.del, 0) === 1) { byName(a.f); return; }
        show(id, pick(a.f, a.v), a.x, a.y);
    };
    // Затемнение экрана — тот же вызов, что делает плагин; разбирает его runList (шаг fx «fade»)
    const fade = (out, a) => {
        const n = frames(num(a.t, 1000));
        cmd(355, [`$gameScreen.startFade${out ? 'Out' : 'In'}(${n})`]);
        if (num(a.wt, 1) === 1 && n > 0) cmd(230, [n]);
    };
    const run = (line) => {
        const name = line.split(' ')[0];
        const exact = line === name;
        const a = makeArg(line);
        switch (name) {
            case '@bg': if (exact) erase(SLOT.bg); else if (a.f === undefined) clear(); else show(SLOT.bg, a.f, a.x, a.y); return;
            case '@ev': ev(SLOT.ev, a, exact); return;
            case '@ev2': ev(SLOT.ev2, a, exact); return;
            // Лист-анимация: с выключенной анимацией плагин показывает CG без двух первых букв («a_ev05» → «ev05») — её и
            // берём; её нет — лист не CG, прежняя CG уходит
            case '@ev_anime': {
                if (exact || a.f === undefined) { clear(); return; }
                const still = pick(a.f.slice(2), a.v);
                if (exists(still)) show(SLOT.ev, still, a.x, a.y); else erase(SLOT.ev);
                return;
            }
            case '@bs': if (exact) clear(); return;
            case '@flash':
                if (exact) cmd(224, [[255, 255, 255, 255], 60, true]);
                else cmd(224, [color(a.col, [255, 255, 255, 255]), frames(num(a.t, 1000)), num(a.wt, 0) === 1]);
                return;
            case '@qk': cmd(225, [num(a.p, 5) || 5, num(a.s, 5) || 5, frames(num(a.t, 150)), num(a.wt, 1) === 1]); return;
            case '@fade': if (a.type === 'out' || a.type === 'in') fade(a.type === 'out', a); return;
            case '@fadeout': fade(true, a); return;
            case '@fadein': fade(false, a); return;
            case '@fade_c': cmd(223, [[num(a.r, 0), num(a.g, 0), num(a.b, 0), num(a.gr, 0)], frames(num(a.t, 250)), num(a.wt, 1) === 1]); return;
            case '@fadeout_c': if ((a.c ?? 'w') === 'w') cmd(223, [[255, 255, 255, 0], frames(num(a.t, 250)), num(a.wt, 1) === 1]); return;
            case '@fadein_c': cmd(223, [[0, 0, 0, 0], frames(num(a.t, 250)), num(a.wt, 1) === 1]); return;
            case '@wait': if (!exact && num(a.t, null) !== null) cmd(230, [frames(a.t)]); return;
            case '@se': if (a.f) cmd(250, [audio(a)]); return;
            case '@me': if (a.f) cmd(249, [audio(a)]); return;
            case '@bgm': if (a.f) cmd(241, [audio(a)]); else cmd(242, [Math.floor(num(a.t, 1000) / 1000)]); return;
            // Стоны «BGV» плагин крутит буфером BGS (audio/bgs) и ждёт 50 кадров
            case '@bgv': if (a.f) { cmd(245, [audio(a)]); cmd(230, [50]); } else cmd(246, [Math.floor(num(a.t, 1000) / 1000)]); return;
            case '@voice': if (a.f) cmd(355, [`AudioManager.playVoice(${JSON.stringify(audio(a))})`]); return;
            default:
        }
    };
    // Макросы, которые плагин разворачивает при чтении файла (macroChange: ищет подстроку, в этом порядке)
    const expand = (line) => {
        const a = makeArg(line);
        const evm = () => (a.bg ? [`@ev f=${a.bg}${a.v ? ` v=${a.v}` : ''}`] : []);
        if (line.includes('@fin')) return ['@se', '@bgs', '@bgv', '@flash t=300 wt=1', '@flash t=300 wt=1', '@flash t=1000', ...evm(), ...(a.se ? [`@se f=${a.se}`] : [])];
        if (line.includes('@bgf')) return [`@flash t=${a.t ?? 1000}`, ...evm()];
        if (line.includes('@rps_ex')) return ['@fadeout', '@se', '@bgs', '@bgv', '@bgm', '@bs', '@ev', '@wait t=1000', '@fadein'];
        if (line.includes('@rps')) return ['@se', '@bgs', '@bgv', '@bgm', '@bs', '@ev', '@wait t=1000'];
        return [line];
    };
    const say = (t) => {
        let who = '';
        let body = t;
        const close = t.indexOf(']');
        if (t[0] === '[' && close > 0) {
            let head = t.slice(1, close);
            const slash = head.indexOf('/');
            if (slash >= 0) {
                const voice = head.slice(slash + 1).trim();
                if (voice) run(`@voice f=${voice}`);
                head = head.slice(0, slash);
            }
            who = head.replace(/[\s:：]+$/u, '').trim();
            body = t.slice(close + 1);
        }
        // Метка «без отступа» \CL, фуригана [слово:чтение] и сердечко ＃ハート＃ — в окне их не видно как текст
        body = body.replace(/\\CL/gi, '').replace(/\[([^[\]:]+):[^[\]]*\]/g, '$1').replace(/＃(?:ハート|はーと)＃/g, '♥');
        const rows = body.split('\\n').map((r) => r.trim());
        while (rows.length && !rows[rows.length - 1]) rows.pop();
        if (!rows.some(Boolean)) return;
        cmd(101, ['', 0, 0, 2, who]);
        for (const r of rows) cmd(401, [r]);
    };
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && i < ADV_LINES; i++) {
        const t = lines[i].replace(/\r/g, '').trim();
        if (!t || t[0] === ';' || t[0] === '*') continue;
        if (t[0] === '@') {
            if (t.split(' ')[0] === '@end') break;
            for (const m of expand(t)) run(m);
            continue;
        }
        say(t);
    }
    return list;
}

// Источники сцен для analyze: файл, который зовут события, — одна сцена { id: 'adv:<файл>', name, where, list, adv, linear }.
// id кончается расширением (.sl, .txt): «adv:rp07» сборка анимаций приняла бы за страницу 7 события «adv:r»
async function sources(root, all, screen, size, exists, testMap) {
    const cfg = all.length ? await config(root) : null;
    if (!cfg) return [];
    const byFile = new Map();
    for (const r of all) {
        const k = r.file.toLowerCase();
        if (!byFile.has(k)) { if (byFile.size >= ADV_FILES) continue; byFile.set(k, { file: r.file, callers: [] }); }
        byFile.get(k).callers.push(r);
    }
    const out = [];
    for (const { file, callers } of byFile.values()) {
        const got = await cfg.read(file).catch(() => null);
        if (!got) continue;
        let list;
        try { list = toCommands(got.text, screen, size, exists); } catch { continue; }
        if (!list.some((c) => c.code === 231)) continue;
        // Место сцены — карта первого настоящего (не тестового) вызова; зовёт общее событие — без места
        const real = callers.find((c) => !testMap.test(c.where || '')) || callers[0];
        // Без меню выбора и переходов (@select, @if, @jump) файл идёт от начала до конца — одна сцена (linear)
        out.push({ id: `${ADV_ID}${got.file}`, name: '', where: real.map ? real.where || '' : '', list, adv: true, linear: !BRANCH.test(got.text) });
    }
    return out;
}

module.exports = { config, refs, toCommands, sources, makeArg, xor, ADV_ID, ADV_FILES, ADV_BYTES, SLOT };
