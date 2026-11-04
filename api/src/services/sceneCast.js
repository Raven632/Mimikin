// Кто в сцене: ряд имён над «Сценами» и «Диалогами» галереи и, для каждой плитки, кто в ней есть. Только чистые
// функции: файлы сценариев читает gallery.js (cast), таблица лежит рядом со сценариями (cast.json). Пол героев игра не
// хранит, поэтому ряд нейтральный: все, кто говорит в сценах, кроме главного героя. Пороги подобраны замерами по
// библиотеке prod (95 игр со сценами): так скрываются и мужской герой, и героиня-главная, а героини игр с одним героем остаются
// 1 — первая таблица; 2 — без концовок и заголовков игры (NOT_NAME)
const CAST_VERSION = 2;

// Персонаж есть в сцене, если сказал не меньше MIN_SAYS реплик и не меньше MIN_SHARE реплик с именем; больше PER_ROW на сцену
// не берём: остальные — эпизод
const MIN_SAYS = 3;
const MIN_SHARE = 0.15;
const PER_ROW = 3;
// Главный герой: есть почти во всех сценах вкладки — или он первый в отряде в начале игры и есть хотя бы в половине.
// Отдельный порог для лидера осторожный: героиня, которая не лидер, бывает и в 70 % сцен (её не прячем)
const EVERYWHERE = 0.9;
const LEADER = 0.5;
// В ряду — только имена хотя бы из двух сцен: фильтр по одной плитке ничего не даёт
const MIN_ROWS = 2;

// Имя говорящего для ряда: теги плагинов, хвост «(lv.?)» и «（…）», вопросы «凌华？？？», обёртки {} 【】 [] — прочь; буква или номер
// в конце («Man A», «Студент 2», «①», «村人A») — та же роль; широкая буква, приклеенная к латинице («Heroｔ»), — пометка игры, не
// часть имени. Без букв («0», одни «?…・.!») или с кодом, который не разобрался («\V[201»), — не имя ('')
// Не имя, а заголовок игры: концовка («BAD END 4», «Paradise End», «TRUE END»), достижение, подсказка, обучение, сложность.
// Окно имени им тоже подписывают, а строку «BAD END 4» над репликой в кавычках легко принять за имя (galleryScenes.speech)
const NOT_NAME = /(?:(?:^|\s)(?:END|ENDING)|エンド)(?:\s*[#№]?\s*\d{1,3}|\s+\p{Lu})?$|^(?:TIPS?|Tutorial|Hint|Difficulty|Achievement|About\s.+|Достижение|Подсказка|Обучение|Сложность|ヒント|チュートリアル|実績|難易度)(?:\s*\d{1,3})?$/iu;
const notName = (s) => NOT_NAME.test(String(s ?? '').replace(/^[【[{(（]+|[】\]})）]+$/g, '').trim());

function norm(name) {
    let s = String(name ?? '').replace(/<[^>]*>/g, '').trim();
    if (s.includes('\\')) return '';
    s = s.replace(/\s*[(（].*$/, '').replace(/[?？]+$/, '').trim();
    s = s.replace(/^[{【[]+|[}】\]]+$/g, '').trim();
    s = s.replace(/\s+(?:\p{Lu}|\d{1,3})$|\s*[①-⑳]$|(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[A-ZＡ-Ｚ0-9０-９]$|(?<=[A-Za-z])[Ａ-Ｚａ-ｚ]$/u, '').trim();
    if (!/\p{L}/u.test(s) || notName(s)) return '';
    return s;
}

// Реплика на двоих («Mina & Syrup», «A、B», «A и B», «A and B») — каждому из них
const split = (who) => [...new Set(String(who ?? '').split(/\s*[&＆、]\s*|\s+(?:and|и)\s+/i).map(norm).filter(Boolean))];

// Одна сцена: says — говорящий каждой реплики с текстом (пусто — без имени). present — кто в сцене (по порогам), top — двое,
// кто говорит больше всех (подпись плитки, как sum.w у оглавления, но по тем же именам, что в ряду)
function sceneCast(says) {
    const n = new Map();
    let named = 0;
    for (const who of says) {
        const names = split(who);
        if (!names.length) continue;
        named++;
        for (const x of names) n.set(x, (n.get(x) || 0) + 1);
    }
    // Порядок при равенстве — кто заговорил раньше (Map хранит порядок появления)
    const byCount = [...n].sort((a, b) => b[1] - a[1]);
    const present = byCount.filter(([, c]) => c >= MIN_SAYS && c >= named * MIN_SHARE).slice(0, PER_ROW).map(([x]) => x);
    return { present, top: byCount.slice(0, 2).map(([x]) => x) };
}

// Одна вкладка: rows — [{ key, says }] в порядке игры; leader — имя первого в отряде (System.partyMembers[0]) или ''.
// → { names: [[имя, сцен]…], rows: { ключ: [номера имён] }, w: { ключ: [двое главных] } }
function tabCast(rows, leader = '') {
    const cast = rows.map((r) => ({ key: r.key, ...sceneCast(r.says) }));
    const lead = norm(leader);
    const seen = cast.filter((r) => r.present.length);
    const count = new Map();
    for (const r of seen) for (const x of r.present) count.set(x, (count.get(x) || 0) + 1);
    const hidden = (x, c) => c >= seen.length * EVERYWHERE || (x === lead && c >= seen.length * LEADER);
    const names = [...count].filter(([x, c]) => c >= MIN_ROWS && !hidden(x, c)).sort((a, b) => b[1] - a[1]);
    const at = new Map(names.map(([x], i) => [x, i]));
    const out = { names, rows: {}, w: {} };
    for (const r of cast) {
        const ids = r.present.filter((x) => at.has(x)).map((x) => at.get(x));
        if (ids.length) out.rows[r.key] = ids;
        if (r.top.length) out.w[r.key] = r.top;
    }
    return out;
}

// Вся таблица: tabs — { scenes: [{ key, says }], dialogue: [...] }
const build = (tabs, leader = '') => ({ v: CAST_VERSION, scenes: tabCast(tabs.scenes || [], leader), dialogue: tabCast(tabs.dialogue || [], leader) });

module.exports = { CAST_VERSION, notName, norm, split, sceneCast, tabCast, build };
