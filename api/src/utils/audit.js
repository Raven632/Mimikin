// Ревизия библиотеки — правила, по строкам базы: одна игра в двух папках, чего не хватает в
// данных, насколько библиотека покрыта. Файлы и сеть — в routes/games.js, здесь их нет,
// поэтому правила проверяются тестами

const { normTitle, cleanTitle } = require('./title.js');
const { itchGameUrl } = require('./itch.js');

// Когда поиск данных в последний раз стал умнее. Игры, данные которых искали раньше,
// с пробелами — в «Можно дополнить»: поиск заново
// может их заполнить. Искали после — больше нечего: из списка они уходят, даже если пробелы
// остались, и кнопка не гоняет их по кругу. Поднять, когда поиск снова станет умнее
// 2026-10-07: источник спрашивается всегда, не ответивший сайт не стирает найденное
const LOOKUP_IMPROVED_AT = Date.UTC(2026, 9, 7, 22, 0);

const isFilled = (v) => !!v && v !== '[]' && v !== '""';
const slim = (g) => ({ id: g.id, title: g.title, size: g.size || 0 });
// Пара копий без порядка: так «Не дубликат» лежит в таблице not_duplicates и так же сверяется
const pairKey = (a, b) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

// Страницы игры в магазинах и каталогах — из её ссылок: адрес на itch.io, номер в Steam, номер
// новеллы на VNDB. «itch:https://dev.itch.io/game», «steam:1234», «vndb:v17»
function pagesOf(g) {
    const pages = [];
    for (const link of String(g.link || '').split(',').map((x) => x.trim()).filter(Boolean)) {
        const itch = itchGameUrl(link);
        const steam = link.match(/store\.steampowered\.com\/app\/(\d+)/i);
        const vndb = link.match(/vndb\.org\/(v\d+)/i);
        if (itch) pages.push(`itch:${itch}`);
        else if (steam) pages.push(`steam:${steam[1]}`);
        else if (vndb) pages.push(`vndb:${vndb[1].toLowerCase()}`);
    }
    return [...new Set(pages)];
}

// Название без версий и знаков: «Starfall Inn-1.08» и «Starfall Inn v1.1» — одно. Любые буквы, не только
// латиница: прежде японское название превращалось в пустую строку и ни с чем не сравнивалось.
// Короче четырёх знаков — не сравниваем: от «TOD» и «123» пользы нет
function nameKey(g) {
    const key = normTitle(cleanTitle(g.title || g.id));
    return [...key].length >= 4 ? key : '';
}

// Одна игра в разных папках: одно название или одна страница магазина. Группы
// объединяются по цепочке: A и B — одно название, B и C — одна страница, значит, все три вместе.
// why — по чему совпали: name, page. pairs — пары копий с прямым совпадением: склеивают и отклоняют именно пару.
// notDuplicates — пары, про которые сказали «Не дубликат» (pairKey): они не связывают копии и в цепочке
function duplicateGroups(rows, notDuplicates = new Set()) {
    const byKey = new Map();
    const add = (kind, value, id) => {
        if (!value) return;
        const key = `${kind}:${value}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(id);
    };
    for (const g of rows) {
        add('name', nameKey(g), g.id);
        for (const page of pagesOf(g)) add('page', page, g.id);
    }
    const shared = [...byKey.entries()].filter(([, ids]) => new Set(ids).size > 1);

    const parent = new Map(rows.map((g) => [g.id, g.id]));
    const root = (id) => {
        while (parent.get(id) !== id) id = parent.get(id);
        return id;
    };
    const byId = new Map(rows.map((g) => [g.id, g]));
    const pairs = new Map();
    for (const [key, ids] of shared) {
        const list = [...new Set(ids)];
        list.forEach((a, i) => list.slice(i + 1).forEach((b) => {
            const pair = pairKey(a, b);
            if (notDuplicates.has(pair)) return;
            if (!pairs.has(pair)) pairs.set(pair, { a, b, why: new Set() });
            pairs.get(pair).why.add(key.split(':')[0]);
            parent.set(root(a), root(b));
        }));
    }
    const groups = new Map();
    for (const g of rows) {
        const r = root(g.id);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(g);
    }
    return [...groups.values()].filter((group) => group.length > 1).map((group) => {
        const ids = new Set(group.map((g) => g.id));
        const own = [...pairs.values()].filter((p) => ids.has(p.a));
        return {
            why: [...new Set(own.flatMap((p) => [...p.why]))],
            games: group.map(slim),
            pairs: own.map((p) => ({ why: [...p.why], games: [slim(byId.get(p.a)), slim(byId.get(p.b))] })),
        };
    });
}

// По чему игры можно счесть одной: название без версии и страницы в магазинах — как у одной игры в двух папках
const keysOf = (g) => [
    nameKey(g) && `name:${nameKey(g)}`,
    ...pagesOf(g).map((page) => `page:${page}`),
].filter(Boolean);

// Есть ли у двух строк общее название или страница: склеить можно только такие
const sameGame = (a, b) => {
    const theirs = new Set(keysOf(b));
    return keysOf(a).some((k) => theirs.has(k));
};

// cleanTitle срезает эти слова как хвост версии, и «Game English patch» становится просто «Game». «patched» — это вся игра
const PART_WORDS = /(?<![\p{L}\p{N}])(?:patch|demo|dlcs?|mods?|walkthrough|trial)(?![\p{L}\p{N}])|体験版/iu;

// Одно название отличается от другого только номером в конце: «game» и «game2»
const numberAfter = (a, b) => a.startsWith(b) && /^\p{N}+$/u.test(a.slice(b.length));
const onlyNumberApart = (a, b) => !!a && !!b && (numberAfter(a, b) || numberAfter(b, a));

// Архив грузят как новую игру, а похоже, это новая версия игры из библиотеки. Страница магазина — точно она; название
// без версии — по названию игры и по имени папки: папка взята из имени прошлого архива, а название игра могла сменить на
// своё или найденное. Разные страницы при одном названии — разные издания, не спрашиваем. Номер серии — часть
// названия: «Game 2» не новая версия «Game 1». У папки с хвостом «_1» номер не про серию: так зовётся вторая карточка
// (services/uploads.js), поэтому по имени такой папки не сравниваем. Строка, у которой название и папка расходятся только
// номером («Game» в папке «Game 2 v1.0»), — про неё неясно, какая это часть: тоже не спрашиваем.
// Архив с PART_WORDS в имени — не вся игра, а кусок к ней или проба: заменять ею полную игру не предлагаем, разве что те же
// слова есть у игры из библиотеки («Demo Lord», новая версия демо).
// → [{ row, why }]: сначала самые точные, среди равных — во что играли позже
function newVersionMatches(rows, { title, link = '' }) {
    const part = PART_WORDS.test(title);
    const upload = { id: title, title, link };
    const name = nameKey(upload);
    const pages = pagesOf(upload);
    const found = [];
    for (const row of rows) {
        if (part && !PART_WORDS.test(`${row.title} ${row.id}`)) continue;
        const theirPages = pagesOf(row);
        const titleKey = nameKey(row);
        const folderKey = /_\d+$/.test(row.id) ? '' : nameKey({ title: row.id });
        let why = '';
        if (pages.some((p) => theirPages.includes(p))) why = 'page';
        else if (name && (name === titleKey || name === folderKey)
            && !(pages.length && theirPages.length)
            && !onlyNumberApart(titleKey, folderKey)) why = 'name';
        if (why) found.push({ row, why });
    }
    const rank = { page: 0, name: 1 };
    return found.sort((a, b) => rank[a.why] - rank[b.why] || (b.row.lastPlayed || 0) - (a.row.lastPlayed || 0));
}

// Игру загрузили заново как новую, а она та же, что «на полке» (services/trash.js): с игрой на полке у неё общее
// название или страница магазина — напрямую, а не по цепочке через третью игру, как у дубликатов. Только загруженная
// после того, как ту убрали на полку, и если на «это она?» про ту не ответили «нет» (shelf_dismissed — их id по
// строкам). Новая игра → { row, why } — самая свежая из подходящих игр на полке и по чему совпали
function shelfMatches(rows) {
    const out = new Map();
    const shelved = rows.filter((r) => r.shelved_at > 0).sort((a, b) => b.shelved_at - a.shelved_at)
        .map((row) => ({ row, keys: new Set(keysOf(row)) }));
    if (!shelved.length) return out;
    for (const g of rows) {
        if (g.shelved_at > 0) continue;
        const no = String(g.shelf_dismissed || '').split('\n');
        const mine = keysOf(g);
        for (const { row, keys } of shelved) {
            if ((g.addedAt || 0) <= row.shelved_at || no.includes(row.id)) continue;
            const why = [...new Set(mine.filter((k) => keys.has(k)).map((k) => k.split(':')[0]))];
            if (why.length) {
                out.set(g.id, { row, why });
                break;
            }
        }
    }
    return out;
}

// Чего не хватает в данных игры
function gapsOf(g) {
    return [
        !pagesOf(g).length && 'link',
        !g.description && 'description',
        !(g.developer && g.releaseDate) && 'devdate',
        !isFilled(g.screens) && 'screens',
    ].filter(Boolean);
}

// «Можно дополнить»: данные найдены (не найденные и неполные — в своих разделах), но искались
// до последнего улучшения поиска, и в них есть пробелы. Больше пробелов — выше
function improvable(rows, improvedAt = LOOKUP_IMPROVED_AT) {
    return rows
        .filter((g) => g.meta_status === 'ok' && (g.meta_checked_at || 0) < improvedAt)
        .map((g) => ({ ...slim(g), gaps: gapsOf(g) }))
        .filter((g) => g.gaps.length)
        .sort((a, b) => b.gaps.length - a.gaps.length || b.size - a.size);
}

// Насколько библиотека покрыта: у скольких игр есть страница на itch.io, в Steam, на VNDB
function coverage(rows) {
    const has = (kind) => rows.filter((g) => pagesOf(g).some((p) => p.startsWith(`${kind}:`))).length;
    return { itch: has('itch'), steam: has('steam'), vndb: has('vndb') };
}

module.exports = { LOOKUP_IMPROVED_AT, pagesOf, nameKey, pairKey, sameGame, duplicateGroups, newVersionMatches, shelfMatches, gapsOf, improvable, coverage };
