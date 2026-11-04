// Права: главный администратор (в коде isOwner, id 'owner') может всё, остальные люди — только то, что перечислено ниже.
// Список закрывается сам: маршрут, которого здесь нет (в том числе добавленный завтра), для них отвечает 403 «только
// администратору». Забыть внести его опасно в другую сторону — человек не увидит нового экрана, — а это замечают сразу.

// Выключатель учётных записей. false — маршруты /users молчат (404) и людей в библиотеке не завести. Включён после проверки
// настоящей игры под вторым человеком, MV и MZ (tests/compat/check-people.mjs); тесты переключают его сами
const flags = { accountsOn: true };

const rateLimit = require('express-rate-limit');
const gameAccess = require('../services/gameAccess.js');

const SITES = '(?:itch)';
const ANY = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// У каждой строки третье поле — «область»: что маршрут знает об играх. Человеку с ограниченным списком игр (users.games_limited,
// services/gameAccess.js) замок по ней решает, пускать ли запрос; строка без области отвечает 403, как и отсутствующая, — маршрут,
// добавленный завтра и не подумавший об играх, не откроет скрытые.
//   NONE  — данных об играх нет;
//   one   — в запросе названа игра (адрес, ?game=, тело): скрытая и несуществующая отвечают одинаково, 404 «Игра не найдена»,
//           до самого маршрута. Остальное маршрут строит сам по req.allowed (null — все игры, Set — только они);
//   LIST  — ответ по всем играм: маршрут отбирает их сам по req.allowed;
//   MARKS — в ответе карточки каталогов с отметкой game: { id } — замок убирает её у чужих игр.
const NONE = { kind: 'none' };
const LIST = { kind: 'list' };
const MARKS = { kind: 'marks' };
const one = (ids) => ({ kind: 'one', ids });

// Сегменты пути без /api, как их видит Express: лишний «/» на конце не считается, %-коды раскрыты. Битая кодировка — знак,
// которого нет ни в одном списке: такой id закрыт
const decode = (s) => { try { return decodeURIComponent(s); } catch { return '\0'; }; };
const partsOf = (req) => req.path.replace(/\/$/, '').split('/').slice(1).map(decode);
const seg = (n) => (req) => [partsOf(req)[n]];
// ?game=a&game=b и game[]=a — оба случая это список; пустое значение — «не задано», как у самих маршрутов
const clean = (v) => [].concat(v ?? []).map(String).filter(Boolean);
const query = (...names) => (req) => names.flatMap((name) => clean(req.query[name]));
const field = (name) => (req) => clean(req.body?.[name]);
const anyOf = (...finders) => (req) => finders.flatMap((f) => f(req));
// /saves: export, import, history и shot называют игру вторым сегментом, остальные адреса — первым (routes/saves.js). Express
// сверяет имена без учёта регистра, и мы тоже
const savesGame = (req) => {
    const p = partsOf(req);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const named = method === 'GET' ? ['export', 'history', 'shot'] : method === 'POST' ? ['import', 'history'] : [];
    return [p.length >= 3 && named.includes(p[1].toLowerCase()) ? p[2] : p[1]];
};

// [методы, регулярка по пути без /api, область, право]. Четвёртое поле — право из users.may_* (req.person.rights): нет его, и строки
// как будто нет. Каждый сегмент — [^/]+, а не «всё что угодно»: «..» и вложенные пути лишнего
// не откроют. Первая подошедшая строка решает: особые адреса — выше общих
const USER_ROUTES = [
    ['GET', /^\/games\/?$/, LIST],
    // Свои дни игры: строки чужого человека маршрут не читает, а закрытые игры убирает сам
    ['GET', /^\/play-days$/, LIST],
    ['POST', /^\/games\/[^/]+\/meta$/, one(seg(1))],
    // Переименование списка трогает и строки скрытых игр: вернут игру — список в ней уже новый
    ['POST', /^\/games\/lists\/change$/, NONE],
    ['GET', /^\/games\/[^/]+\/translation$/, one(seg(1))],
    // Сейвы, моменты и «путь» — свои: у каждого человека хранилище в _saves/.people/<id> (utils/personStores.js)
    [ANY, /^\/saves(?:\/[^/]+){1,3}$/, one(savesGame)],
    [ANY, /^\/marks(?:\/[^/]+){1,3}$/, one(seg(1))],
    [ANY, /^\/journal(?:\/[^/]+){1,3}$/, one(seg(1))],
    ['POST', /^\/play\/[^/]+$/, one(seg(1))],
    ['POST', /^\/errors\/[^/]+$/, one(seg(1))],
    [ANY, /^\/wishlist(?:\/[^/]+)?$/, MARKS],
    [ANY, /^\/favorites$/, one(anyOf(query('game'), field('game')))],
    ['GET', /^\/recommend\/(?:library|modes)$/, MARKS],
    ['GET', /^\/gallery(?:\/[^/]+){1,4}$/, one(seg(1))],
    // Express сверяет пути без учёта регистра: «/PICTURES/Hidden» — тот же маршрут, поэтому исключения — с флагом i
    ['GET', /^\/pictures\/(?!hidden$)[^/]+$/i, one(query('game'))],
    ['POST', /^\/pictures\/by-image$/, NONE],
    ['GET', /^\/scenes$/, one(query('game'))],
    ['GET', /^\/lines\/search$/, one(query('game'))],
    // Свои архивы: чужое и цель обновления отсекают маршрут и службы (routes/uploads.js). Журнал страницы (trace) закрыт
    ['POST', /^\/games\/upload\/(?:start|chunk|cancel|password|retry)$/, NONE, 'upload'],
    ['GET', /^\/games\/upload\/(?:status|list)$/, NONE, 'upload'],
    // Ход загрузок — только с правом; POST /downloads не откроется никогда: он берёт любую ссылку и любую игру как цель обновления
    ['GET', /^\/downloads$/i, LIST, 'view'],
    // Витрина itch.io: смотреть можно, а «Загрузить» (и список загрузок владельца) — нет
    ['GET', new RegExp(`^/${SITES}/(?!downloads$)[^/]+$`, 'i'), MARKS],
    // Эти два отвечает auth.js до замка — тут они для полноты: список прав в одном месте
    ['GET', /^\/me$/, NONE],
    ['POST', /^\/account\/password$/, NONE],
    // Свои имя и картинка (routes/account.js, после замка). Чью картинку отдать, решает сам маршрут: хозяину и владельцу.
    // Чужие /users/:id/... здесь нет — это дело главного администратора
    ['POST', /^\/account\/name$/, NONE],
    [['PUT', 'DELETE'], /^\/account\/avatar$/, NONE],
    ['GET', /^\/avatars\/[^/]+$/, NONE],
];

// Пока человек не выбрал свой пароль, ему доступно только это
const MUST_CHANGE_ROUTES = [
    ['GET', /^\/me$/, NONE],
    ['POST', /^\/account\/password$/, NONE],
];

const find = (list, method, path) => list.find(([methods, re]) => [].concat(methods).includes(method) && re.test(path));

// Область маршрута, который человеку можно, или null. path — без /api и без строки запроса. Лишний «/» на конце Express
// не различает, мы тоже. Без человека строка с правом закрыта
function scopeOf(method, path, person = {}) {
    // HEAD отвечает маршрут GET; любой другой незнакомый метод (OPTIONS, TRACE) — закрыто
    const m = method === 'HEAD' ? 'GET' : method;
    const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    // «/saves/../settings» Express за маршрут сейвов не примет, но и проверять тут нечего: точечные сегменты — закрыто
    if (p.split('/').some((s) => s === '.' || s === '..')) return null;
    const row = find(person.mustChange ? MUST_CHANGE_ROUTES : USER_ROUTES, m, p);
    if (row?.[3] && !person.rights?.[row[3]]) return null;
    return row?.[2] || null;
}
const userMay = (method, path, person) => !!scopeOf(method, path, person);

// Запрос страницы игры на itch.io идёт через ключ ScraperAPI владельца, а кредиты тратятся за каждую страницу:
// на одного человека — не больше 20 в минуту. Владельца это не касается
const OUTSIDE = /^\/itch\/game(?:\/|$)/i;
const outsideLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    keyGenerator: (req) => req.person.id,
    message: { error: 'Слишком много запросов к каталогам, подождите минуту', reason: 'catalog-busy' },
});

// Замок прав. Стоит сразу за requireAuth: человек уже известен (req.person), владельца не трогаем
async function gate(req, res, next) {
    const person = req.person;
    if (!person || person.isOwner) return next();
    try {
        const scope = scopeOf(req.method, req.path, person);
        if (!scope) {
            if (person.mustChange) return res.status(403).json({ error: 'Сначала выберите свой пароль', reason: 'must-change' });
            return res.status(403).json({ error: 'Только для администратора', reason: 'owner-only' });
        }
        // null — у человека все игры; Set — только перечисленные. Ему и маршрут отбирает ответ по этому полю
        req.allowed = scope === NONE ? null : await gameAccess.allowedIds(person);
        if (req.allowed) {
            // Скрытая игра и несуществующая отвечают одинаково: человек не должен узнать, есть ли она в библиотеке
            if (scope.ids && scope.ids(req).some((id) => !req.allowed.has(id))) return res.status(404).json({ error: 'Игра не найдена' });
            if (scope === MARKS) {
                const send = res.json.bind(res);
                res.json = (body) => send(gameAccess.unmark(req.allowed, body));
            }
        }
        return OUTSIDE.test(req.path) ? outsideLimiter(req, res, next) : next();
    } catch (e) {
        next(e);
    }
}

module.exports = { flags, gate, userMay, scopeOf, USER_ROUTES, NONE, LIST, MARKS };
