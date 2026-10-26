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
// why — по чему совпали: name, page
function duplicateGroups(rows) {
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
    for (const [, ids] of shared) {
        for (const id of ids.slice(1)) parent.set(root(id), root(ids[0]));
    }
    const groups = new Map();
    for (const g of rows) {
        const r = root(g.id);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(g);
    }
    return [...groups.values()].filter((group) => group.length > 1).map((group) => {
        const ids = new Set(group.map((g) => g.id));
        const why = [...new Set(shared.filter(([, list]) => ids.has(list[0])).map(([key]) => key.split(':')[0]))];
        return { why, games: group.map(slim) };
    });
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

module.exports = { LOOKUP_IMPROVED_AT, pagesOf, nameKey, duplicateGroups, gapsOf, improvable, coverage };
