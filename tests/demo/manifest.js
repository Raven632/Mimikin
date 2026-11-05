// Что записывает tests/demo/record.js: адреса GET, которые спрашивает страница, и правила «вычистить из ответа то, что зависит
// от машины». Ключи (reqKey, mediaKey) пишет и читает frontend/demo/keys.js — запись берёт их оттуда, своих копий нет.
//
// Адрес — как его строит интерфейс (frontend/src, поиск «/api/»). q — имена параметров, от которых зависит ответ (по ним
// строится ключ); asks — какие значения этих параметров записать. Если у маршрута в frontend/demo/handlers есть свой q,
// запись берёт его: страница читает по ключу маршрута, и записать надо ровно такой
'use strict';

// boot: true — ответ нужен для первого экрана и лежит прямо в boot.json; остальные — файлами d/<хэш>.json, их страница
// берёт, когда спросит. Порядок — как страница спрашивает при старте (App.jsx), на содержимое он не влияет
const GLOBAL = [
    { path: '/api/setup/status', boot: true },
    { path: '/api/me', boot: true },
    { path: '/api/games', boot: true },
    { path: '/api/settings', boot: true },
    { path: '/api/recommend/modes', boot: true },
    { path: '/api/games/lookup-queue', boot: true },
    { path: '/api/check', boot: true },
    { path: '/api/wishlist', boot: true },
    { path: '/api/storage', boot: true },
    { path: '/api/play-days', boot: true },
    { path: '/api/games/trash', q: ['count'], asks: [{}, { count: '1' }] },
    { path: '/api/games/space' },
    { path: '/api/games/audit' },
    { path: '/api/games/translation/terms' },
    { path: '/api/games/translation/usage' },
    { path: '/api/settings/services' },
    { path: '/api/settings/favorite-tags' },
    { path: '/api/settings/known-langs' },
    { path: '/api/settings/server' },
    { path: '/api/settings/update' },
    { path: '/api/settings/seedbox' },
    { path: '/api/settings/relay' },
    { path: '/api/settings/problem-report' },
    { path: '/api/telegram' },
    { path: '/api/users' },
    { path: '/api/downloads' },
    { path: '/api/errors' },
    { path: '/api/itch/meta' },
    { path: '/api/recommend/library' },
    { path: '/api/recommend/dismissed' },
    { path: '/api/pictures/status' },
    { path: '/api/pictures/games' },
    { path: '/api/pictures/feed' },
    { path: '/api/pictures/hidden' },
    { path: '/api/favorites' },
    // Окно «Сцены»: страница шлёт ещё per (по ширине экрана) и фильтры. Здесь — основа, остальное считает демо в браузере
    { path: '/api/scenes', q: ['kind'], asks: [{ kind: 'scenes' }, { kind: 'dialogue' }] },
];

// По каждой игре (id подставляется). Что вернуло не 2xx (игра на полке, нет файлов) — не записывается, без ошибки
const PER_GAME = [
    { path: '/api/gallery/{id}', gallery: true },
    { path: '/api/gallery/{id}/sounds' },
    { path: '/api/gallery/{id}/cast' },
    { path: '/api/gallery/{id}/inside' },
    { path: '/api/gallery/{id}/tags' },
    { path: '/api/favorites', q: ['game'], ask: (id) => ({ game: id }) },
    { path: '/api/marks/{id}' },
    { path: '/api/journal/{id}' },
    { path: '/api/journal/{id}/room' },
    { path: '/api/saves/{id}' },
    { path: '/api/saves/history/{id}' },
    { path: '/api/games/{id}/old' },
    { path: '/api/games/{id}/archive-info' },
    { path: '/api/games/{id}/translation' },
    { path: '/api/games/{id}/translation/check' },
    { path: '/api/games/{id}/pictures' },
    { path: '/api/games/{id}/lookup' },
];

// Для каждого человека, кроме владельца
const PER_USER = [{ path: '/api/users/{id}/games' }];

// Что должно быть непременно: без этого запись падает громко, а не отдаёт пустое демо
const MUST = {
    games: 17,           // 16 игр demo-library.js и вторая часть серии (rich.js)
    shelved: 1,
    users: 1,            // не считая владельца
    wishlist: 5,
    favorites: 6,
};

// Числа, которые зависят от машины записи, подменяются выдуманными: размер диска хоста не должен попасть в публичный сайт
const GB = 1024 ** 3;
const FAKE_DISK = { total: 2000 * GB, free: 1380 * GB };
function scrub(path, body) {
    if (path === '/api/storage') return { ...body, free: FAKE_DISK.free, ...(body.total !== undefined ? { total: FAKE_DISK.total } : {}) };
    if (path === '/api/games/space') return { ...body, disk: { ...body.disk, free: FAKE_DISK.free, total: FAKE_DISK.total } };
    if (path === '/api/settings/problem-report') return { ...body, report: fakeReport(body.report) };
    return body;
}

// «Отчёт о проблеме» начинается с данных машины: система, память, диск. Хозяин записи этих строк публике не показывает —
// вместо них выдуманные, как у обычного домашнего сервера
const fakeMachine = {
    OS: 'Linux 6.8.0',
    Architecture: 'x64',
    CPUs: '4',
    Memory: '5.6 GB free of 7.8 GB',
    'Free disk': `${(FAKE_DISK.free / GB).toFixed(1)} GB of ${(FAKE_DISK.total / GB).toFixed(1)} GB`,
};
function fakeReport(text) {
    return String(text).split('\n').map((line) => {
        const name = line.split(':')[0];
        return Object.hasOwn(fakeMachine, name) ? `${name}: ${fakeMachine[name]}` : line;
    }).join('\n');
}

module.exports = { GLOBAL, PER_GAME, PER_USER, MUST, scrub, FAKE_DISK };
