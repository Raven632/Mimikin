// Сравнение версий игр. Пишут их как попало: «v1.2.3», «0.99a», «Ver.1.02»,
// «v1.3.1.69 FULL + DLCs», «v.260926 Hotfix 2», «Final». Берём первую цепочку чисел
// через точку и букву сразу за ней («0.99a», «v2.18X»); слова вокруг не считаются.
// «1.3» и «1.3.0» — одна версия, «1.10» новее «1.9»

const { extractVersion } = require('./title.js');

function parseVersion(value) {
    const m = String(value || '').toLowerCase().match(/(\d+(?:\.\d+)*)([a-z](?![a-z]))?/);
    if (!m) return null;
    return { nums: m[1].split('.').map(Number), digits: m[1].replace(/\./g, ''), suffix: m[2] || '' };
}

// Дата вместо номера: «2026-08-27», «v.260926»
const DATE_LIKE = /(?:^|\D)(?:(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{6,8})(?:\D|$)/;

// 1 — a новее, -1 — старше, 0 — та же, null — не сравнить (нет чисел, «Final»)
function compareVersions(a, b) {
    const x = parseVersion(a), y = parseVersion(b);
    if (!x || !y) return null;
    // Дату с номером не сравнить: «2026-08-27» на форуме не значит, что наша 1.0.0 старее
    if (DATE_LIKE.test(String(a)) !== DATE_LIKE.test(String(b))) return null;
    // «1.09» и «1.0.9», «1.01» и «1.0.1» — одна версия, записанная по-разному
    if (x.digits === y.digits && x.suffix === y.suffix) return 0;
    const n = Math.max(x.nums.length, y.nums.length);
    for (let i = 0; i < n; i++) {
        const d = (x.nums[i] || 0) - (y.nums[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    if (x.suffix !== y.suffix) return x.suffix > y.suffix ? 1 : -1;
    return 0;
}

// Версия у себя: вписанная руками, иначе из названия или папки
function installedVersion(row) {
    return row.my_version || extractVersion(row.title, row.id);
}

module.exports = { parseVersion, compareVersions, installedVersion };
