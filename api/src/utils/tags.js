const map = require('../data/tagmap.json');
const drop = new Set(map.drop);

// Приводим теги источников к общему словарю
// становятся одним тегом. В базе оставляем оригинал, нормализуем на выдаче —
// поэтому словарь можно править когда угодно, без миграций и без потери данных.
function normalizeTags(tags) {
    const out = new Set();
    for (const raw of tags || []) {
        const key = String(raw).toLowerCase().trim();
        if (!key || drop.has(key)) continue;
        const mapped = map.canonical[key];
        // Один сырой тег может дать два канонических
        for (const tag of [].concat(mapped || key)) out.add(tag);
    }
    return [...out].sort();
}

module.exports = { normalizeTags };
