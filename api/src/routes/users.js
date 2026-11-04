const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const dbService = require('../db/database.js');
const { getIo, emitToPerson } = require('../utils/cache.js');
const gameAccess = require('../services/gameAccess.js');
const { passwordFits, cleanName, nameFits, nameTaken, exclusiveNames } = require('../utils/account.js');
const avatars = require('../utils/avatars.js');
const sessions = require('../utils/sessions.js');
const { flags } = require('../utils/access.js');
const { dropSessionSockets, rightsOf } = require('./auth.js');
const { rename, nameBad, nameBusy, peopleChanged, notRestoring, rawBody, tooBig, putAvatar, dropAvatar } = require('./account.js');

// Люди рядом с главным администратором: список, новый человек, имя, картинка, сброс пароля, закрыть вход, убрать. Только он
// (замок прав, utils/access.js: этих адресов в списке людей нет). Закрытый и убранный человек остаётся в базе со всеми
// данными (users.state): сейвы, строки и пароль на месте, а имя за ним занято — вернуть можно в любой момент
const router = express.Router();

// Пока выключатель не включён, маршрутов как будто нет: ответ тот же, что у любого неизвестного адреса
router.use((req, res, next) => (flags.accountsOn ? next() : next('router')));

// Главный администратор — первой строкой, без записи в users (его логин в настройках): так экран людей рисует всех одним
// списком. Остальные — по имени; убранные тоже, у них state: 'removed', экран прячет их в «Удалённых».
// noPassword — запись восстановлена из копии, а в копии паролей нет: войти по ней нельзя, пока владелец не задаст временный
router.get('/', async (req, res) => {
    const db = dbService.get();
    const rows = await db.all("SELECT id, name, must_change AS mustChange, pass_hash = '' AS noPassword, created_at AS createdAt, state, may_request, may_download, may_upload, may_view FROM users ORDER BY name");
    const admin = (await db.get("SELECT value FROM settings WHERE key = 'admin_user'"))?.value ?? '';
    const people = await Promise.all(rows.sort((a, b) => a.name.localeCompare(b.name)).map(async ({ may_request, may_download, may_upload, may_view, ...r }) => ({ ...r, role: 'user', isOwner: false, mustChange: !!r.mustChange, noPassword: !!r.noPassword, avatar: await avatars.versionOf(r.id), rights: rightsOf({ may_request, may_download, may_upload, may_view }) })));
    res.json([{ id: 'owner', name: admin, role: 'owner', isOwner: true, mustChange: false, noPassword: false, createdAt: 0, state: '', avatar: await avatars.versionOf('owner'), rights: { request: true, download: true, upload: true, view: true } }, ...people]);
});

// Имя и временный пароль. Человек сам выберет свой при первом входе
router.post('/', notRestoring, async (req, res) => {
    const name = cleanName(req.body?.name);
    const password = req.body?.password;
    if (!nameFits(name)) return res.status(nameBad().status).json(nameBad().body);
    if (!passwordFits(password)) return res.status(400).json({ error: 'Слишком короткий пароль' });
    const db = dbService.get();
    // Логин владельца занят тоже: вход по нему — вход владельца. Регистр не различаем (и у кириллицы тоже: account.js)
    // Проверка и вставка — под общей очередью имён (utils/account.js): иначе «Анна» и «анна» разом оба проходят проверку
    const id = `u${crypto.randomBytes(8).toString('hex')}`;
    const hash = await bcrypt.hash(password, 10);
    const fail = await exclusiveNames(async () => {
        const busy = await nameTaken(db, name);
        if (busy) return nameBusy(busy);
        try {
            await db.run('INSERT INTO users (id, name, pass_hash, must_change, created_at) VALUES (?, ?, ?, 1, ?)', [id, name, hash, Date.now()]);
        } catch (e) {
            if (/UNIQUE/.test(e.message)) return nameBusy({ state: '' });
            throw e;
        }
        return null;
    });
    if (fail) return res.status(fail.status).json(fail.body);
    // Первый человек рядом: прежняя кука «одного общего ключа» больше не годится. Окно закрываем, а сокеты, открытые ею, рвём
    if (dbService.legacyOpen()) {
        await dbService.closeLegacyWindow();
        for (const socket of getIo()?.sockets.sockets.values() || []) if (socket.data?.legacy) socket.disconnect(true);
    }
    peopleChanged();
    res.json({ id, name, mustChange: true });
});

// Человек по id; строки владельца нет — для него эти маршруты отвечают «нет такого» (имя меняет он сам, в «Аккаунте»)
const personById = (id) => dbService.get().get('SELECT id, name, state FROM users WHERE id = ?', [id]);

// Переименовать другого человека: пароль не нужен. Входы живут, ему передают новое имя — оно же логин
router.patch('/:id', notRestoring, async (req, res) => {
    const person = await personById(req.params.id);
    if (!person) return res.status(404).json({ error: 'Нет такого человека' });
    const done = await rename(person.id, req.body?.name);
    if (done.fail) return res.status(done.fail.status).json(done.fail.body);
    res.json({ success: true, name: done.name });
});

// Закрыть вход ('locked'), убрать из списка ('removed') или вернуть ('' — открыт). Ничего не стирается: пароль, сейвы и строки
// остаются, копии берут их как раньше. Закрытие и удаление выводят человека со всех устройств
router.post('/:id/state', notRestoring, async (req, res) => {
    const state = req.body?.state;
    if (!['', 'locked', 'removed'].includes(state)) return res.status(400).json({ error: 'Неизвестное состояние' });
    const person = await personById(req.params.id);
    if (!person) return res.status(404).json({ error: 'Нет такого человека' });
    await dbService.get().run('UPDATE users SET state = ? WHERE id = ?', [state, person.id]);
    if (state && state !== person.state) dropSessionSockets(await sessions.endAllFor(person.id));
    peopleChanged();
    res.json({ success: true, state });
});

// Картинка другого человека — владелец может поставить и убрать. Тело и проверки те же, что у своей (routes/account.js)
router.put('/:id/avatar', notRestoring, async (req, res, next) => {
    if (!(await personById(req.params.id))) return res.status(404).json({ error: 'Нет такого человека' });
    next();
}, rawBody, tooBig, (req, res) => putAvatar(req.params.id, req, res));
router.delete('/:id/avatar', notRestoring, async (req, res) => {
    if (!(await personById(req.params.id))) return res.status(404).json({ error: 'Нет такого человека' });
    await dropAvatar(req.params.id, res);
});

// Какие игры видит человек: { limited, games }. limited: false — все (и новые тоже), games тогда ни на что не влияет, но
// хранится: передумали — список на месте. Игры, закрытые человеку, отвечают ему как несуществующие, а его сейвы, заметки и
// списки остаются на диске и возвращаются, когда игру откроют снова (services/gameAccess.js)
router.get('/:id/games', async (req, res) => {
    const person = await personById(req.params.id);
    if (!person) return res.status(404).json({ error: 'Нет такого человека' });
    const db = dbService.get();
    const limited = !!(await db.get('SELECT games_limited AS v FROM users WHERE id = ?', [person.id])).v;
    res.json({ limited, games: (await db.all('SELECT game_id AS id FROM user_game_access WHERE user_id = ? ORDER BY game_id', [person.id])).map((r) => r.id) });
});

// Заменить флаг и список разом. Игра, которой нет в библиотеке, — 400: молча пропущенная выглядела бы выданной
router.put('/:id/games', notRestoring, async (req, res) => {
    const person = await personById(req.params.id);
    if (!person) return res.status(404).json({ error: 'Нет такого человека' });
    const { limited, games } = req.body || {};
    if (typeof limited !== 'boolean' || !Array.isArray(games) || games.length > 20000 || !games.every((id) => typeof id === 'string')) {
        return res.status(400).json({ error: 'Непонятный список игр', reason: 'bad-games' });
    }
    const ids = [...new Set(games)];
    const known = new Set((await dbService.get().all('SELECT id FROM games WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)])).map((r) => r.id));
    if (ids.some((id) => !known.has(id))) return res.status(400).json({ error: 'В списке есть игра, которой нет в библиотеке', reason: 'unknown-game' });
    await gameAccess.replace(person.id, { limited, games: ids });
    // Открытая страница человека спросит список заново; уже открытая игра получит отказ на следующем запросе
    emitToPerson(person.id, 'library-changed');
    res.json({ success: true, limited, games: ids.length });
});

// Четыре права человека: просить игры, скачивать с сайтов, загружать свои файлы, видеть ход всех загрузок. Только все разом и только
// да или нет: забытое поле не должно молча закрыть или открыть право
router.put('/:id/rights', notRestoring, async (req, res) => {
    const person = await personById(req.params.id);
    if (!person) return res.status(404).json({ error: 'Нет такого человека' });
    const { request, download, upload, view } = req.body || {};
    if (![request, download, upload, view].every((v) => typeof v === 'boolean')) return res.status(400).json({ error: 'Непонятные права', reason: 'bad-rights' });
    await dbService.get().run('UPDATE users SET may_request = ?, may_download = ?, may_upload = ?, may_view = ? WHERE id = ?', [request, download, upload, view].map(Number).concat(person.id));
    emitToPerson(person.id, 'rights-changed');
    peopleChanged();
    res.json({ success: true, rights: { request, download, upload, view } });
});

// Сброс: новый временный пароль, все входы человека стёрты
router.post('/:id/password', notRestoring, async (req, res) => {
    const password = req.body?.password;
    if (!passwordFits(password)) return res.status(400).json({ error: 'Слишком короткий пароль' });
    const db = dbService.get();
    const person = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!person) return res.status(404).json({ error: 'Нет такого человека' });
    await db.run('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?', [await bcrypt.hash(password, 10), person.id]);
    dropSessionSockets(await sessions.endAllFor(person.id));
    peopleChanged();
    res.json({ success: true });
});

module.exports = router;
