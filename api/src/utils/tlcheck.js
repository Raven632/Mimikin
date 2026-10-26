// Проверка переведённой игры (services/translate.js, check): где слова слиплись и где текст не влезет в
// окно. Без запуска игры — по данным и словарю, поэтому ширина — оценка: шрифт перевода известен
// (M PLUS Rounded 1c, ширины букв — fontwidths.json, сняты браузером), размер экрана и шрифта — из данных
// игры (MZ — System.json, MV — параметры плагинов вроде YEP_CoreEngine), иначе стандартные RPG Maker.
//
// Что не влезает. Сама игра (rpg-fixes) переносит реплики по словам, слишком длинное слово — по буквам;
// описание в окне подсказки переносит и, если не влезает, уменьшает шрифт до 60%; длинный вариант ответа
// рисует шрифтом поменьше, тоже до 60%. Поэтому в списке только то, что не влезет и так:
//   choice      — вариант ответа шире экрана даже шрифтом в 60%;
//   description — описание (предмет, навык) не влезает в две строки подсказки даже шрифтом в 60%;
//   profile     — строка профиля героя шире окна даже шрифтом в 60% (переноса там нет).
// Слипание:
//   code        — код цвета, имени, значка вплотную между словами («одна\C[2]дочь»);
//   punct       — после точки, запятой, «!» или «?» сразу слово с большой буквы («дело.Её»);
//   case        — внутри русского слова маленькая буква, потом большая («единственнаяФон»);
//   script      — русские и латинские буквы в одном слове («Mabelфон»).
// code, punct и case исправляются сами (fix — исправленный текст): пробел там нужен всегда
const { INLINE, commandLists, DATABASE, spaceCodes } = require('./gametext.js');
const table = require('./fontwidths.json');

const WIDTHS = new Map([...table.chars].map((ch, i) => [ch, table.widths[i] / 1000]));
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}　-〿＀-￯]/u;

// Ширина текста в пикселях при размере шрифта size. Буквы не из таблицы: японские — во всю клетку,
// прочие — как средняя буква
function textWidth(s, size) {
    let w = 0;
    for (const ch of s) w += WIDTHS.get(ch) ?? (CJK.test(ch) ? 1 : 0.6);
    return w * size;
}

// Видимый текст строки: коды убраны, имя героя и переменная — примерным текстом, значок — его шириной
function visible(s, ctx) {
    let icons = 0;
    const text = String(s)
        .replace(/\\N\[(\d+)\]/gi, (m, n) => ctx.actors[Number(n)] || 'Name')
        .replace(/\\P\[\d+\]/gi, 'Name')
        .replace(/\\V\[\d+\]/gi, '000')
        .replace(/\\G/gi, ctx.currency || 'G')
        .replace(/\\I\[\d+\]/gi, () => { icons++; return ''; })
        .replace(new RegExp(INLINE.source, 'g'), '');
    return { text, icons };
}

// Размеры экрана игры: ширина, шрифт, поля окна, ширина значка и лица
function layoutOf(system, pluginsSource) {
    const mz = !!system?.advanced;
    if (mz) {
        const width = Number(system.advanced.uiAreaWidth || system.advanced.screenWidth) || 816;
        return { mz, width, font: Number(system.advanced.fontSize) || 26, padding: 12, face: 144 + 20, icon: 32 + 4 };
    }
    let list = [];
    const m = String(pluginsSource || '').match(/\$plugins\s*=\s*(\[[\s\S]*\])\s*;?/);
    try { list = m ? JSON.parse(m[1]) : []; } catch (e) { list = []; }
    const on = list.filter((p) => p && p.status !== false);
    const param = (re, plugin) => {
        for (const p of on) {
            if (plugin && !plugin.test(p.name || '')) continue;
            for (const [k, v] of Object.entries(p.parameters || {})) if (re.test(k) && Number(v) > 0) return Number(v);
        }
        return 0;
    };
    // Размер шрифта и поля — только у плагина ядра: «Font Size» у других плагинов — это их окна
    return {
        mz,
        width: param(/^screen ?width$/i) || 816,
        font: param(/^font ?size$/i, /CoreEngine|Core$/i) || 28,
        padding: param(/^window ?padding$/i, /CoreEngine|Core$/i) || 18,
        face: 144 + 24,
        icon: 32 + 4,
    };
}

// Слипание в переведённой строке: вид и, если исправляется само, исправленный текст
const PUNCT = /(?<=\p{Ll}{2}[.!?,;:])(?=\p{Lu})/gu;
const CASE = /(?<=\p{sc=Cyrillic})(?<=\p{Ll})(?=\p{Lu})(?=\p{sc=Cyrillic})/gu;
const SCRIPT = /\p{sc=Cyrillic}\p{sc=Latin}|\p{sc=Latin}\p{sc=Cyrillic}/u;
function glued(text, src = '') {
    const coded = spaceCodes(text);
    const punct = coded.replace(PUNCT, ' ');
    const fix = punct.replace(CASE, ' ');
    if (fix !== text) return { kind: coded !== text ? 'code' : punct !== coded ? 'punct' : 'case', fix };
    // Смесь была и в оригинале («あどあｄ») — это не перевод склеил
    if (SCRIPT.test(visible(text, { actors: [] }).text) && !/\p{sc=Latin}/u.test(visible(src, { actors: [] }).text)) return { kind: 'script' };
    return null;
}

// Проверить игру. files — [[имя, данные]] из data/, dict — оригинал → перевод, guard — защищённые строки
function checkGame(files, dict, guard, layout) {
    const byName = Object.fromEntries(files);
    const actors = (byName.Actors || []).map((a) => (a ? (dict.get(a.name) || a.name || '') : ''));
    const ctx = { actors, currency: dict.get(byName.System?.currencyUnit) || byName.System?.currencyUnit || '' };
    const inner = layout.width - layout.padding * 2;
    const issues = [];
    const seen = new Set();
    const add = (kind, file, src, text, extra = {}) => {
        const key = `${kind}\n${src}`;
        if (seen.has(key)) return;
        seen.add(key);
        issues.push({ kind, file, src, text, ...extra });
    };
    const translated = (s) => {
        if (typeof s !== 'string' || guard(s)) return null;
        const t = dict.get(s);
        return t !== undefined && t !== s ? t : null;
    };
    const lineWidth = (s, size = layout.font) => {
        const v = visible(s, ctx);
        return textWidth(v.text, size) + v.icons * layout.icon;
    };
    // Самый мелкий шрифт, до которого игра ужимает подсказку и варианты ответа
    const small = Math.max(14, Math.round(layout.font * 0.6));
    // Подсказка: две строки по 36 пикселей, поля текста по 6–8 с каждой стороны
    const help = inner - (layout.mz ? 16 : 12);
    const fitsHelp = (t) => {
        for (let size = layout.font; size >= small; size -= 2) {
            let lines = 0;
            for (const l of t.split(/\r?\n/)) {
                let cur = 0;
                lines++;
                for (const w of l.split(/(?<=\s)/)) {
                    const ww = lineWidth(w, size);
                    if (cur && cur + ww > help) { lines += Math.ceil(ww / help); cur = ww % help; } else cur += ww;
                    if (cur > help) { lines += Math.floor(cur / help); cur %= help; }
                }
            }
            // Высота строки: MZ — lineHeight 36 на обычный шрифт, MV — шрифт + 8
            if (lines * (size + (layout.mz ? Math.max(4, 36 - layout.font) : 8)) <= 72) return true;
        }
        return false;
    };
    const checkGlue = (file, src, t) => {
        const g = glued(t, src);
        if (g) add(g.kind, file, src, t, g.fix ? { fix: g.fix } : {});
    };

    for (const [name, data] of files) {
        for (const list of commandLists(name, data)) {
            let face = false;
            for (const cmd of list) {
                const params = Array.isArray(cmd?.parameters) ? cmd.parameters : [];
                if (cmd?.code === 101) face = !!params[0];
                if (cmd?.code === 401 || cmd?.code === 405) {
                    const t = translated(params[0]);
                    if (t) checkGlue(name, params[0], t);
                }
                if (cmd?.code === 102 && Array.isArray(params[0])) {
                    for (const c of params[0]) {
                        const t = translated(c);
                        if (!t) continue;
                        checkGlue(name, c, t);
                        const w = lineWidth(t, small) + 24;
                        if (w > inner) add('choice', name, c, t, { width: Math.round(w), max: Math.round(inner) });
                    }
                }
            }
        }
        if (DATABASE[name]) {
            for (const row of data || []) {
                if (!row) continue;
                for (const key of DATABASE[name]) {
                    const t = translated(row[key]);
                    if (!t) continue;
                    checkGlue(name, row[key], t);
                    if (key === 'profile') {
                        const widest = t.split(/\r?\n/).reduce((a, l) => Math.max(a, lineWidth(l, small)), 0);
                        if (widest > help) add('profile', name, row[key], t, { width: Math.round(widest), max: Math.round(help) });
                    }
                    if (key === 'description' && !fitsHelp(t)) add('description', name, row[key], t, { max: Math.round(help) });
                }
            }
        }
    }
    return issues;
}

module.exports = { checkGame, layoutOf, textWidth, glued };
