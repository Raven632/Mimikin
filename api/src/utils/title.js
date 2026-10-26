// Поисковые API ищут по названию буквально: «v1.02», «| TL: Marlow» или подчёркивания
// из имени папки убивают совпадение. Приводим название к виду, пригодному для поиска.
function cleanTitle(raw) {
    let t = String(raw || '');
    t = t.split('|')[0];                                   // «… | TL: Marlow», «… | Перевод: …»
    t = t.replace(/~[^~]+~/g, ' ');                        // японские подзаголовки в тильдах
    t = t.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    t = t.replace(/【[^】]*】/g, ' ');                      // метки изданий: 【English.ver】, 【繁体中文版】
    t = t.replace(/_+/g, ' ');                             // названия, собранные из имени папки

    // Метки версий и релизов срезаем ТОЛЬКО с хвоста: «Trial» в середине — часть названия.
    // «Version 1.3», «Production Version 1.4», «Complete» — тоже хвосты: срезаются за
    // два прохода цикла ниже (сначала число, потом слово). «Ver-1.2.2» — целиком: раньше
    // уходил только номер, и «Ver» оставался в запросе, которого в каталоге нет.
    const TAIL = /(?:[\s\-–—,~]+)?\b(?:o?v(?:er)?\.?[\s-]?\d[\w.]*|\d+(?:\.\d+)+|(?:product(?:ion)?\s+)?version|complete|final|full|dlcs?|compressed|repack|steam|dev|demo|patched?|tl|eng(?:lish)?)\b[\s\-–—,~]*$/i;
    // Стадия разработки в хвосте: игра зовёт себя «Moonlit Priestess Alpha», а страница в каталоге —
    // «Moonlit Priestess», и каталог, которому нужны все слова запроса, её не находил. Срезаем,
    // только если остаётся хотя бы два слова: «Project Alpha» — это название
    const STAGE = /[\s\-–—,:~]+(?:alpha|beta|prototype|preview|early[\s-]+access|pre-?release|trial(?:\s+version)?)[\s\-–—,~]*$/i;
    let prev;
    do {
        prev = t;
        t = t.replace(TAIL, '').trim();
        const bare = t.replace(STAGE, '').trim();
        if (bare.split(/\s+/).length >= 2) t = bare;
    } while (t !== prev);

    return t.replace(/\s{2,}/g, ' ').trim();
}

// ——— Название для показа в библиотеке ———
// Для поиска выше срезаем всё подряд, а здесь только мусор: версии, «| TL: …»,
// «(Перевод: …)», «Steam 04/17/2342». Подзаголовок в тильдах — часть названия, он остаётся.

// Версия может стоять и в середине: «Звёздный трактир 1.13 ov1.0.1 | Перевод…»,
// «Moonlit Harbor 1.3.0 Steam 04/17/2342». После неё идёт только служебное
// «EN1.12» — версия английского издания; «2.0.0v» — буква v после номера, а не часть его
const VERSION_AT = /(?:^|[\s\-–—,~(（])(?:o?v(?:er)?\.?[\s-]?(\d+(?:\.\d+)*[a-uw-z]?)|(?:en|eng|jp|jpn|ru|rus|cn)?(\d+(?:\.\d+)+[a-uw-z]?))(?=$|[\s\-–—,~)）]|v\b)/i;
const DISPLAY_TAIL = /[\s\-–—,~:]*\b(?:(?:product(?:ion)?\s+)?version|steam|compressed|repack|windows|win|pc|eng(?:lish)?|rus|full|complete|final|dev|tl|patched?|dlcs?)\s*$/i;
const EDGES = /^[\s\-–—,:|・]+|[\s\-–—,:|・]+$/g;

function tidyTitle(raw) {
    const source = String(raw || '');
    // Скобки в названиях игр здесь всегда служебные: «（ver1.19）», «(TL by Marlow)»,
    // а у некоторых игр в квадратных — подсказки управления вместо названия
    let t = source.replace(/\[[^\]]*\]|［[^］]*］|\([^)]*\)|（[^）]*）|【[^】]*】/g, ' ');
    t = t.split('|')[0];
    t = t.replace(/_/g, ' ');
    const cut = t.search(VERSION_AT);
    if (cut >= 0) t = t.slice(0, cut);
    let prev;
    do { prev = t; t = t.replace(DISPLAY_TAIL, ''); } while (t !== prev);
    // «Mira s Potion Shop»: апостроф пропал ещё в имени папки (Mira_s)
    t = t.replace(/(\p{L}) s\b/gu, "$1's");
    t = t.replace(/\s{2,}/g, ' ').replace(EDGES, '').trim();
    // Тильда в конце — либо закрывает подзаголовок «~Even Stars Fall…~» (тогда их чётное
    // число, оставляем), либо осталась висеть после отрезанной версии
    if (/[~～]$/.test(t) && (t.match(/[~～]/g) || []).length % 2) t = t.replace(/[\s~～]+$/, '');
    return t || source.trim();
}

// Иероглифы без единого латинского слова — такое название большинству не прочесть.
// «・» и «ー» встречаются и в английских названиях японских игр, их не считаем
const isCjkOnly = (s) => /[぀-ゟ゠-ヺ一-鿿가-힯]/.test(s) && !/[A-Za-zА-Яа-яЁё]{3}/.test(s);

// Имя папки обычно английское: «Echoes_of_the_Old_Lighthouse_v1.26-Final»
function titleFromFolderName(folder) {
    let f = String(folder || '').replace(/_/g, ' ');
    // Папка-слаг «starfall-inn-2.01-rus» — дефисы вместо пробелов
    if (!/\s/.test(f.trim())) f = f.replace(/-/g, ' ');
    const t = tidyTitle(f);
    return t === t.toLowerCase() ? t.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()) : t;
}

// title — что показывать; original — японское название, если его заменили английским
function presentTitle(raw, { folder = '' } = {}) {
    const tidy = tidyTitle(raw);
    if (isCjkOnly(tidy)) {
        const english = titleFromFolderName(folder);
        if (english && !isCjkOnly(english)) return { title: english, original: tidy };
    }
    // Игра называет себя сокращённо («Lantern» вместо «The Lantern Keeper of the
    // Northern Isles…»), а полное название осталось в имени папки
    if (!/\s/.test(tidy) && tidy.length <= 8) {
        const fromFolder = titleFromFolderName(folder);
        if (fromFolder.split(' ').length >= 3 && new RegExp(`\\b${tidy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(fromFolder)) {
            return { title: fromFolder, original: '' };
        }
    }
    // Слитно и сокращённо («SkyKnight», «TinyQuest3»), а в имени архива — полное:
    // «SkyKnight_TheCrystalLabyrinth_1.0_EN072p», «TinyQuest3_-_English_Release_by_Marlow»
    if (!/\s/.test(tidy)) {
        const full = splitWords(stripRelease(titleFromFolderName(folder)));
        if (full.split(' ').length >= 3 && normTitle(full).startsWith(normTitle(tidy))) return { title: full, original: '' };
    }
    return { title: tidy, original: '' };
}

// Название игры для показа по строке из базы: вписанное руками в «Изменить» — как есть,
// иначе очищенное presentTitle
function shownTitle(row) {
    let locked = [];
    try { locked = JSON.parse(row.meta_locked || '[]') || []; } catch (e) {}
    return locked.includes('title')
        ? { title: row.title, original: '' }
        : presentTitle(row.title || row.id, { folder: row.id });
}

// Версия для плашки: из названия, а если там нет — из имени папки. «v1» из названия
// уступает «1.03» из папки: номер с точкой почти всегда точнее
function extractVersion(title, folder) {
    // После «|» у переводов идёт своя версия («Версия перевода: 1.0») — это не версия игры
    const found = [String(title || '').split('|')[0], folder].map((s) => {
        const m = String(s || '').replace(/_/g, ' ').match(VERSION_AT);
        return m ? (m[1] || m[2]) : '';
    }).filter(Boolean);
    return found.find((v) => v.includes('.')) || found[0] || '';
}

// ——— Названия для поиска и сверки ———

// Слова, слепленные вместе: «SkyKnight» — «Sky Knight», «TinyQuest3» — «Tiny Quest 3»,
// «RPGMaker» — «RPG Maker». Каталоги ищут по словам, и слитное название там не находится
function splitWords(raw) {
    return String(raw || '')
        .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// Хвост релиза в имени архива: «TinyQuest3 - English Release by Marlow», «… TL by Marlow»
const RELEASE_TAILS = [
    /[\s\-–—,:]+(?:english|eng|en|russian|rus|translated)\s+(?:release|translation|version|ver|edition|tl|patch)\b.*$/i,
    /[\s\-–—,:]+(?:release|translation|translated|tl|patch)\s+(?:by|from)\s+.+$/i,
];
function stripRelease(raw) {
    let t = String(raw || '');
    for (const re of RELEASE_TAILS) t = t.replace(re, '');
    return t.trim();
}

// Буквы и цифры любого письма — японские названия тоже сравниваются. Диакритику
// у латиницы снимаем («Pokémon» = «Pokemon»), японские знаки остаются целыми
const normTitle = (s) => String(s || '').normalize('NFKD').replace(/([a-z])\p{M}+/giu, '$1').normalize('NFKC')
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Сходство названий: 1 — совпали, 0 — ничего общего. Нужен, чтобы автопоиск не приписал
// игре чужие теги: поиск на непонятный запрос охотно отдаёт «что-то похожее»
function titleSimilarity(a, b) {
    const x = normTitle(a), y = normTitle(b);
    if (!x || !y) return 0;
    if (x === y) return 1;

    // Название игры часто короче названия на странице: «Clockwork Garden» против
    // «Clockwork Garden -The Inventor's Daughter and the Brass Fox». Для таких случаев
    // вхождение надёжнее Дайса, который штрафует за разницу в длине.
    const shorter = x.length <= y.length ? x : y;
    const longer = x.length <= y.length ? y : x;
    if (shorter.length >= 8 && longer.startsWith(shorter)) return 0.95;
    if (shorter.length >= 12 && longer.includes(shorter)) return 0.9;
    // Коэффициент Дайса по парам знаков: устойчив к перестановкам и мелким опечаткам
    const grams = (s) => {
        const m = new Map();
        const chars = [...s];
        for (let i = 0; i < chars.length - 1; i++) {
            const g = chars[i] + chars[i + 1];
            m.set(g, (m.get(g) || 0) + 1);
        }
        return m;
    };
    const gx = grams(x), gy = grams(y);
    let hits = 0;
    for (const [g, n] of gx) if (gy.has(g)) hits += Math.min(n, gy.get(g));
    const total = ([...x].length - 1) + ([...y].length - 1);
    return total > 0 ? (2 * hits) / total : 0;
}

// Под какими названиями искать игру и по каким проверять найденное. names — названия из
// разных мест: из самой игры (System.json), из имени папки (обычно это имя архива), из readme.
// Название, которое лишь начало другого («SkyKnight» при «SkyKnight TheCrystalLabyrinth»),
// для проверки не годится: под него подходит и чужая «Sky Knight Quest». Искать по нему
// можно — после полного.
//   search — запросы по порядку: полные раньше коротких, слова раздельно раньше слитных
//   verify — с чем сверять найденное
// Названия, одинаковые без знаков, но с другими границами слов, — тоже запросы: «Grandpa-s Saga» с
// Steam и «Grandpas Saga» из папки для сверки одно, а каталог ищет по словам и находит только первое
const wordsOf = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function searchNames(names) {
    const all = [];
    const twins = [];
    for (const raw of names) {
        const t = cleanTitle(stripRelease(raw));
        if (normTitle(t).length < 3) continue;
        const same = all.find((x) => normTitle(x) === normTitle(t));
        if (!same) all.push(t);
        else if (wordsOf(same) !== wordsOf(t) && !twins.some((x) => wordsOf(x) === wordsOf(t))) twins.push(t);
    }
    const extendsOther = (a, b) => { const x = normTitle(a), y = normTitle(b); return x.length > y.length && x.startsWith(y); };
    const partial = (t) => all.some((o) => o !== t && extendsOther(o, t));
    const verify = all.filter((t) => !partial(t));
    const search = [];
    for (const t of [...verify, ...all.filter(partial)]) {
        const own = twins.filter((x) => normTitle(x) === normTitle(t));
        for (const v of [splitWords(t), t, ...own]) if (!search.includes(v)) search.push(v);
    }
    return { search, verify };
}

// Насколько найденное название подходит игре — лучшее совпадение с её названиями.
// Найденное сравниваем и целиком, и без подзаголовков и версий
function bestSimilarity(found, verify) {
    let best = 0;
    for (const name of verify) best = Math.max(best, titleSimilarity(name, found), titleSimilarity(name, cleanTitle(found)));
    return best;
}

module.exports = {
    cleanTitle, tidyTitle, presentTitle, shownTitle, extractVersion,
    splitWords, stripRelease, normTitle, titleSimilarity, searchNames, bestSimilarity,
};
