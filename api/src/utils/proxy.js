// Сервер за обратным прокси (nginx, Caddy, Traefik): что читать из заголовков и где живут игры.

// TRUST_PROXY — кому верить в X-Forwarded-*: значения те же, что у настройки Express «trust proxy» — число прокси перед
// сервером («1»), их адреса («10.0.0.0/8», «loopback», через запятую). По умолчанию никому: без прокси заголовок пишет сам
// посетитель, и подделанный X-Forwarded-For обнулял бы счётчик попыток входа
function parseTrustProxy(raw) {
    const value = String(raw ?? '').trim();
    if (!value || /^(off|false|no|0)$/i.test(value)) return false;
    if (/^(on|true|yes)$/i.test(value)) return true;
    return /^\d+$/.test(value) ? Number(value) : value;
}

// Включить в приложении. Опечатка в адресе не должна ронять сервер: остаётся безопасное «не верить», а причина — в журнал
function applyTrustProxy(app, raw) {
    const value = parseTrustProxy(raw);
    try {
        app.set('trust proxy', value);
    } catch (e) {
        console.error(`[Прокси] TRUST_PROXY «${raw}» не разобрать (${e.message}) — заголовкам X-Forwarded-* не верим`);
        app.set('trust proxy', false);
        return false;
    }
    // «Верить всем» — это самый левый адрес в цепочке, а его пишет посетитель: лимит входа так обходится
    if (value === true) console.warn('[Прокси] TRUST_PROXY=true верит любому X-Forwarded-For: лучше указать число прокси (TRUST_PROXY=1)');
    return value;
}

// GAME_ORIGIN — полный адрес сервера игр за прокси. Сравниваем его с Origin и e.origin сообщений игры, поэтому держим в
// том же виде, что браузер: без слэша и пути, строчными. Не адрес — как не задан: игры пойдут на «тот же хост, порт GAME_PORT»
function parseGameOrigin(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch (e) { /* ниже — в журнал */ }
    console.error(`[Прокси] GAME_ORIGIN «${value}» — не адрес вида https://games.example.com, не используем`);
    return '';
}

// Запрос со страницы игры? Смотрим Origin у браузера без Sec-Fetch-Site (fromLibraryOnly в server.js). Origin, который не
// разобрать, — тоже нет доверия: «null» присылает страница в песочнице
function isGameOrigin(origin, { gameOrigin = '', gamePort = '' } = {}) {
    let url;
    try { url = new URL(origin); } catch (e) { return true; }
    return url.port === gamePort || (!!gameOrigin && url.origin === gameOrigin);
}

module.exports = { parseTrustProxy, applyTrustProxy, parseGameOrigin, isGameOrigin };
