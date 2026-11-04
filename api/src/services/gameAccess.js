const crypto = require('crypto');
const dbService = require('../db/database.js');
const { emitToPerson } = require('../utils/cache.js');

// Какие игры видит человек. Владелец и человек с «все игры» (users.games_limited = 0) — все: null. Ограниченный — только
// перечисленные в user_game_access: Set с их id. Список положительный, поэтому новая игра для него невидима сама, а ошибка в
// проверке закрывает, а не открывает. Скрытая игра отвечает так же, как несуществующая (utils/access.js); его сейвы, моменты,
// заметки и списки лежат на месте, недоступны, пока игра скрыта, и возвращаются как были, когда её откроют снова.
//
// Флаг читаем из базы каждый раз, а не берём из req.person: человек без этого поля (хук сервера игр, вызов из службы) не
// должен оказаться «со всеми играми» только потому, что поле не передали. Внутри одного запроса ответ помним на самом объекте
// человека — он живёт столько же, сколько запрос
const MEMO = Symbol('gameAccess');

async function load(person) {
    const rows = await dbService.get().all(
        'SELECT u.games_limited AS limited, u.state, a.game_id AS game FROM users u LEFT JOIN user_game_access a ON a.user_id = u.id WHERE u.id = ?', [person.id]
    );
    // Строки человека нет (убрана базой из копии) или вход ему закрыт (state): видеть нечего. Ключ файлов игры, выданный до
    // закрытия, живёт дольше входов, поэтому и сервер игр спрашивает это же
    if (!rows.length || rows[0].state) return new Set();
    if (!rows[0].limited) return null;
    return new Set(rows.map((r) => r.game).filter(Boolean));
}

// null — все игры, Set — только они. Без человека (вызов без входа, тесты) и владелец — все, как до людей
function allowedIds(person) {
    if (!person || person.isOwner) return Promise.resolve(null);
    return (person[MEMO] ||= load(person));
}

async function may(person, id) {
    const allowed = await allowedIds(person);
    return !allowed || allowed.has(id);
}

// Из списка остаются разрешённые; of — как достать id из элемента (по умолчанию он сам)
const only = (allowed, list, of = (x) => x) => (allowed ? list.filter((x) => allowed.has(of(x))) : list);

// Отметка игры библиотеки в карточке каталога — game: { id }: у чужой её быть не должно, иначе по ней видно, что игра в
// библиотеке и как называется папка. Копия, а не правка: ответ сайта лежит в кэше службы
function unmark(allowed, value) {
    if (!allowed || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((x) => unmark(allowed, x));
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        if (key === 'game' && v && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string' && !allowed.has(v.id)) continue;
        out[key] = unmark(allowed, v);
    }
    return out;
}

// Часть ключа кэша: ответ, собранный по играм этого человека, не должен достаться другому. null (все игры) — пусто: ключи
// владельца остаются прежними
function scopeKey(allowed) {
    return allowed ? crypto.createHash('sha1').update([...allowed].sort().join('\n')).digest('hex').slice(0, 16) : '';
}

// Заменить доступ человека целиком: флаг и список — одной транзакцией. Ничего другого его данные не затрагивает.
// Строки игр, которых сейчас нет в games (лежат в корзине), не трогаем: список приходит из библиотеки без них, а возврат
// из корзины обязан вернуть доступ. Вставка одним запросом из json_each: транзакция на общем соединении не должна тянуться
// по числу игр, иначе чужие записи попадают в неё же
async function replace(userId, { limited, games }) {
    const db = dbService.get();
    await db.exec('BEGIN');
    try {
        await db.run('UPDATE users SET games_limited = ? WHERE id = ?', [limited ? 1 : 0, userId]);
        await db.run('DELETE FROM user_game_access WHERE user_id = ? AND game_id IN (SELECT id FROM games)', [userId]);
        await db.run('INSERT OR IGNORE INTO user_game_access (user_id, game_id, at) SELECT ?, value, ? FROM json_each(?)', [userId, Date.now(), JSON.stringify(games)]);
        await db.exec('COMMIT');
    } catch (e) {
        await db.exec('ROLLBACK').catch(() => {});
        throw e;
    }
}

// Открыть одну игру: ответ «да» на запрос и своя загрузка (services/requests.js, uploads.js). Строка — только ограниченному: человек
// со всеми играми её и так видит, а лишняя строка всплыла бы, ограничь его потом
async function grant(userId, gameId) {
    await dbService.get().run('INSERT OR IGNORE INTO user_game_access (user_id, game_id, at) SELECT id, ?, ? FROM users WHERE id = ? AND games_limited = 1', [gameId, Date.now(), userId]);
    emitToPerson(userId, 'library-changed');
}

module.exports = { allowedIds, may, only, unmark, scopeKey, replace, grant };
