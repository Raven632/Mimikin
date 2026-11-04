// Свои подборки человека: у игры — список имён (столбец games.lists, JSON). Отдельной таблицы нет: подборка — это игры с её
// именем, поэтому она живёт вместе с игрой (корзина, полка, копии) и исчезает сама, когда в ней не осталось игр
const NAME_MAX = 60;
const PER_GAME = 50;
const NOTES_MAX = 5000;

const cleanName = (x) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : '');
const goodName = (name) => name.length > 0 && name.length <= NAME_MAX;

// Из браузера: чистый список без повторов или null, если прислали не то
function cleanLists(value) {
    if (!Array.isArray(value) || value.length > PER_GAME) return null;
    const names = [...new Set(value.map(cleanName))];
    return names.every(goodName) ? names : null;
}

function parseLists(text) {
    try {
        const list = JSON.parse(text || '[]');
        return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
}

// Подборку переименовали (to) или удалили (to пустое). Если подборка to у игры уже есть, это слияние
const renamed = (list, from, to) => [...new Set(list.flatMap((x) => (x === from ? (to ? [to] : []) : [x])))];

module.exports = { cleanName, goodName, cleanLists, parseLists, renamed, NOTES_MAX };
