// Ссылки игры: в базе — одной строкой через запятую. Одна и та же страница пишется по-разному
// (Steam с названием и без, с «www» и без), поэтому сравниваем ключи, а не строки

const splitLinks = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// Ключ страницы: «steam:100», «vndb:v100»;
// остальные — адрес без протокола, «www», хвостового «/», запроса и якоря
function linkKey(url) {
    const s = String(url || '').trim();
    const steam = s.match(/steampowered\.com\/app\/(\d+)/i);
    if (steam) return `steam:${steam[1]}`;
    const vndb = s.match(/vndb\.org\/(v\d+)/i);
    if (vndb) return `vndb:${vndb[1].toLowerCase()}`;
    try {
        const u = new URL(s);
        return `${u.hostname.replace(/^www\./i, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch (e) {
        return s.toLowerCase();
    }
}

// Ссылки, которые человек убрал из игры сам: их поиск больше не возвращает. Вписал обратно —
// ссылка снова своя. before и after — ссылки до и после правки, removed — убранные раньше (ключи)
function removedAfterEdit(before, after, removed = []) {
    const now = new Set(splitLinks(after).map(linkKey));
    const gone = splitLinks(before).map(linkKey).filter((k) => !now.has(k));
    return [...new Set([...removed, ...gone])].filter((k) => !now.has(k));
}

const parseRemoved = (v) => {
    try {
        const list = JSON.parse(v || '[]');
        return Array.isArray(list) ? list.map(String) : [];
    } catch (e) {
        return [];
    }
};

module.exports = { splitLinks, linkKey, removedAfterEdit, parseRemoved };
