const express = require('express');
const bcrypt = require('bcrypt');
const path = require('path');
const dbService = require('../db/database.js');
const { getIo, emitToPerson } = require('../utils/cache.js');
const { cleanName, nameFits, nameTaken, exclusiveNames } = require('../utils/account.js');
const avatars = require('../utils/avatars.js');
const { loginLimiter } = require('./auth.js');
const personal = require('../services/personal.js');
const gameAccess = require('../services/gameAccess.js');
const { dayOf } = require('../utils/saveprogress.js');

// Свои имя и картинка: у каждого человека, у владельца тоже. Стоит ПОСЛЕ замка (server.js): authRouter стоит до него, и
// всё, что лежало бы там, открыто человеку, который ещё не выбрал пароль. Адреса — в списке прав (utils/access.js)
const router = express.Router();

// Событие людям. account-changed — устройствам этого человека (страница заново спрашивает /me), people-changed — владельцу
// (список людей обновляется без перезагрузки; его слышит только комната owner, utils/cache.js, ownerOnly)
const accountChanged = (id) => emitToPerson(id, 'account-changed');
const peopleChanged = () => getIo()?.emit('people-changed');
const announce = (id) => { accountChanged(id); peopleChanged(); };

// Идёт восстановление копии — это одна транзакция на общем соединении: чужая запись попала бы в неё и пропала при откате
// (то же, что у входа, routes/auth.js). Читать можно. На каждом маршруте отдельно: router.use перехватил бы чужие адреса
// /api, мимо которых этот роутер стоит в цепочке
const notRestoring = (req, res, next) => (!dbService.restoring
    ? next()
    : res.status(503).json({ error: 'Идёт восстановление копии, попробуйте через минуту', reason: 'restoring' }));

// Календарь «Мои игровые дни»: только свои строки. День и «сегодня» — по часам сервера, ими же дни записаны (utils/saveprogress.js):
// браузер в другом поясе сдвинул бы их. since считается по тем же открытым играм, иначе выдал бы время игры в закрытой.
// Игры из корзины нет в списке: её строк не отдаём, иначе день считался бы в итогах, а под ним было бы пусто. Вернут игру — вернутся и дни
const PLAY_DAYS_WINDOW = 371;
router.get('/play-days', async (req, res, next) => {
    try {
        const db = dbService.get();
        const userId = personal.other(req.person)?.id || 'owner';
        const now = new Date();
        const from = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (PLAY_DAYS_WINDOW - 1)));
        const listed = 'game_id IN (SELECT id FROM games WHERE ready = 1)';
        const firsts = await db.all(`SELECT game_id, MIN(day) AS day FROM play_days WHERE user_id = ? AND seconds > 0 AND ${listed} GROUP BY game_id`, [userId]);
        const rows = await db.all(`SELECT game_id, day, seconds FROM play_days WHERE user_id = ? AND day >= ? AND seconds > 0 AND ${listed} ORDER BY day, seconds DESC`, [userId, from]);
        const days = new Map();
        for (const r of gameAccess.only(req.allowed, rows, (x) => x.game_id)) {
            if (!days.has(r.day)) days.set(r.day, []);
            days.get(r.day).push({ id: r.game_id, seconds: r.seconds });
        }
        const open = gameAccess.only(req.allowed, firsts, (x) => x.game_id).map((x) => x.day).sort();
        res.json({ days: [...days].map(([day, games]) => ({ day, games })), since: open[0] || null, today: dayOf(now) });
    } catch (e) {
        next(e);
    }
});

const nameBad = () => ({ status: 400, body: { error: 'Имя от 1 до 40 знаков, без невидимых знаков', reason: 'name-bad' } });
// Удалённый человек держит имя: другой «Анна» без сейвов путала бы больше, чем возвращённая прежняя
const nameBusy = (by) => (by.state === 'removed'
    ? { status: 409, body: { error: 'Это имя за удалённым человеком: верните его из списка удалённых или выберите другое', reason: 'name-removed' } }
    : { status: 409, body: { error: 'Это имя занято', reason: 'name-taken' } });

// Сменить имя человеку или владельцу (у владельца это логин в настройках). Входы не трогаем: они держатся за id. Ответ —
// { name } или { fail: { status, body } }; кто сверил пароль и права — решает вызывающий
const rename = (id, raw) => exclusiveNames(() => renameNow(id, raw));
async function renameNow(id, raw) {
    const name = cleanName(raw);
    if (!nameFits(name)) return { fail: nameBad() };
    const db = dbService.get();
    const busy = await nameTaken(db, name, id);
    if (busy) return { fail: nameBusy(busy) };
    if (id === 'owner') await db.run("UPDATE settings SET value = ? WHERE key = 'admin_user'", [name]);
    else {
        try {
            await db.run('UPDATE users SET name = ? WHERE id = ?', [name, id]);
        } catch (e) {
            if (/UNIQUE/.test(e.message)) return { fail: nameBusy({ state: '' }) };
            throw e;
        }
    }
    announce(id);
    return { name };
}

// Картинка: тело — сам JPEG. Страница уже вырезала квадрат и уменьшила до 256 px; здесь только проверка, что это настоящий
// JPEG и кадр небольшой. Больше лимита express.raw отвергает ошибкой — её превращает в 413 tooBig
const rawBody = express.raw({ type: () => true, limit: '256kb' });
const tooBig = (err, req, res, next) => (err?.type === 'entity.too.large' ? res.status(413).json({ error: 'Картинка слишком большая', reason: 'avatar-big' }) : next(err));

async function putAvatar(id, req, res) {
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!avatars.validJpeg(body)) return res.status(400).json({ error: 'Нужна картинка JPEG, не больше 512 на 512', reason: 'avatar-bad' });
    const avatar = await avatars.put(id, body);
    announce(id);
    res.json({ success: true, avatar });
}

async function dropAvatar(id, res) {
    await avatars.remove(id);
    announce(id);
    res.json({ success: true, avatar: null });
}

// Смена имени. Нужен пароль: открытая на чужом устройстве вкладка не должна дать запереть человека (имя — его логин).
// Тот же лимит попыток, что у входа и смены пароля
router.post('/account/name', notRestoring, loginLimiter, async (req, res) => {
    const { password, name } = req.body || {};
    if (typeof password !== 'string') return res.status(400).json({ error: 'Нужен пароль', reason: 'password-empty' });
    const { isOwner, id } = req.person;
    const db = dbService.get();
    const stored = isOwner
        ? (await db.get('SELECT value FROM settings WHERE key = "admin_pass"'))?.value
        : (await db.get('SELECT pass_hash AS value FROM users WHERE id = ?', [id]))?.value;
    if (!stored || !(await bcrypt.compare(password, stored))) return res.status(401).json({ error: 'Пароль неверный', reason: 'wrong-password' });
    const done = await rename(id, name);
    if (done.fail) return res.status(done.fail.status).json(done.fail.body);
    res.json({ success: true, name: done.name });
});

router.put('/account/avatar', notRestoring, rawBody, tooBig, (req, res) => putAvatar(req.person.id, req, res));
router.delete('/account/avatar', notRestoring, (req, res) => dropAvatar(req.person.id, res));

// Картинка человека: ему самому и владельцу. Остальные людей друг у друга не видят (списка людей у них нет вовсе).
// id проверяем по форме до всего: он становится путём на диске
router.get('/avatars/:id', async (req, res) => {
    const { id } = req.params;
    if (!avatars.validId(id)) return res.status(404).end();
    if (!req.person.isOwner && req.person.id !== id) return res.status(403).json({ error: 'Это чужая картинка', reason: 'not-yours' });
    if (await avatars.versionOf(id) === null) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Неделя: адрес несёт версию (?v=время файла), новая картинка — новый адрес. dotfiles: файл лежит под точкой
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.sendFile(path.resolve(avatars.fileOf(id)), { dotfiles: 'allow', cacheControl: false }, (err) => {
        if (err && !res.headersSent) res.status(err.status || 500).end();
    });
});

module.exports = router;
module.exports.rename = rename;
module.exports.nameBad = nameBad;
module.exports.nameBusy = nameBusy;
module.exports.announce = announce;
module.exports.peopleChanged = peopleChanged;
module.exports.notRestoring = notRestoring;
module.exports.rawBody = rawBody;
module.exports.tooBig = tooBig;
module.exports.putAvatar = putAvatar;
module.exports.dropAvatar = dropAvatar;
