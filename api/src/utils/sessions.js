const crypto = require('crypto');
const dbService = require('../db/database.js');

// Вход по устройствам. В куке — 32 случайных байта, в базе — только их SHA-256: прочитанная база не даёт войти.
// id (16 hex) — публичная часть: по нему вход находят в адресах игр (routes/play.js, ключ сессии) и в комнатах сокетов.
// Срок фиксированный от входа, как у прежней куки
const LIFETIME = 30 * 24 * 60 * 60 * 1000;
const OWNER = 'owner';

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// expiresAt — только у обмена старой куки: срок не больше окна, в которое она ещё годится
async function create(userId, { expiresAt = Date.now() + LIFETIME } = {}) {
    const db = dbService.get();
    const now = Date.now();
    const token = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomBytes(8).toString('hex');
    // Просроченные убираем при каждом входе: отдельного обходчика не нужно
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
    await db.run('INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [id, hashOf(token), userId, now, expiresAt]);
    return { token, id, expiresAt };
}

async function find(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const row = await dbService.get().get('SELECT id, user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ? AND expires_at > ?', [hashOf(token), Date.now()]);
    return row || null;
}

// По публичному id: ключ сессии в адресе игры
async function findById(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null;
    // Запись о входе закрытого или убранного человека (пережила бы, например, откат базы) ключом игры не служит: сейвы писать нельзя
    return (await dbService.get().get(`SELECT id, user_id AS userId, expires_at AS expiresAt FROM sessions
        WHERE id = ? AND expires_at > ? AND (user_id = 'owner' OR user_id IN (SELECT id FROM users WHERE state = ''))`, [id, Date.now()])) || null;
}

async function end(id) {
    await dbService.get().run('DELETE FROM sessions WHERE id = ?', [id]);
}

// Все входы человека, кроме одного (тот, с которого сменили пароль). Ответ — id стёртых: их сокеты надо отключить
async function endAllFor(userId, exceptId = null) {
    const db = dbService.get();
    const ids = (await db.all('SELECT id FROM sessions WHERE user_id = ? AND id IS NOT ?', [userId, exceptId])).map((r) => r.id);
    if (ids.length) await db.run('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?', [userId, exceptId]);
    return ids;
}

module.exports = { LIFETIME, OWNER, create, find, findById, end, endAllFor };
