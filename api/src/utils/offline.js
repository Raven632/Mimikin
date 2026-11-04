// OFFLINE=1 — сервер не ходит на сайты (config/index.js). Главная и «Найти» спрашивают ленты сами при открытии, поэтому
// одного выключенного фона мало: у них свой ответ здесь, а поиск данных не обещает то, чего не будет

// Ленты и страницы игр — отказ, как если бы сайт не ответил: пустой список «Найти» показали бы как «Ничего не нашлось».
// К сайтам не ходят теги для фильтров и ход загрузок; POST — то, что человек начал сам
const LOCAL = /^\/(?:meta|downloads?)(?:\/|$)/;

function offlineSites(req, res, next) {
    if (req.method !== 'GET' || LOCAL.test(req.path)) return next();
    return res.status(503).json({ error: 'Сервер работает без интернета (OFFLINE=1)', reason: 'offline' });
}

// Строка поиска в окне игры: «ищем…» и номер в очереди — неправда, поиска не будет. Новая игра — просто без строки
const offlineMeta = (meta) => ({ ...meta, status: meta.status === 'new' ? 'ok' : meta.status, retryAt: null });

module.exports = { offlineSites, offlineMeta };
