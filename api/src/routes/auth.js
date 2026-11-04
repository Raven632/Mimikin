const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const dbService = require('../db/database.js');
const { getIo } = require('../utils/cache.js');
const { passwordFits, writePassword, cleanName, nameFits, foldName, findAccount, nameTaken } = require('../utils/account.js');
const sessions = require('../utils/sessions.js');
const avatars = require('../utils/avatars.js');

const router = express.Router();
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'auth_token';

// Общий apiLimiter пропускает 200 запросов в минуту — для подбора пароля это
// 288 000 попыток в сутки, то есть защиты нет. Форме входа нужен свой лимит.
// Считаем по адресу и имени: в одной квартире все ходят с одного адреса, и человек, забывший пароль, не должен
// закрывать вход остальным. А чтобы перебор имён не обходил лимит, на адрес есть ещё один, общий и пошире
const WINDOW = 15 * 60 * 1000;
const tooMany = { error: 'Слишком много попыток входа. Повторите через 15 минут.' };
const attemptsByName = new rateLimit.MemoryStore();
const attemptsByIp = new rateLimit.MemoryStore();
const limiterOf = (store, max, keyGenerator) => rateLimit({
    store, windowMs: WINDOW, max, keyGenerator,
    skipSuccessfulRequests: true, // удачный вход попытку не тратит
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany,
});
// Имя — из формы входа, а у смены пароля — тот, кто вошёл. Ключ в той же форме, что у findAccount (края, NFC, регистр
// кириллицы): «admin», «admin » и «ADMIN» — одна учётка и одно ведро, а не по десять попыток на каждое написание.
// Обрезаем: длинные случайные имена не должны раздувать память
const nameOf = (req) => foldName(String(req.body?.username ?? req.person?.id ?? '').trim()).slice(0, 64);
const byNameLimiter = limiterOf(attemptsByName, 10, (req) => `${ipKeyGenerator(req.ip)}|${nameOf(req)}`);
const byIpLimiter = limiterOf(attemptsByIp, 100, (req) => ipKeyGenerator(req.ip));
const loginLimiter = (req, res, next) => byIpLimiter(req, res, (err) => (err ? next(err) : byNameLimiter(req, res, next)));

// Пароль сбросили из консоли (scripts/reset-password.js): тот, кто его забыл, обычно уже выбрал все попытки, и новый
// пароль ещё 15 минут отвечал бы «слишком много попыток»
const forgetLoginAttempts = () => { attemptsByName.resetAll(); attemptsByIp.resetAll(); };

// Кука входа. Secure — только когда сам запрос пришёл по HTTPS (за прокси это видно при TRUST_PROXY): по обычному HTTP
// в домашней сети браузер такую куку не сохранит, и войти было бы нельзя
const authCookie = (req) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure });
const THIRTY_DAYS = sessions.LIFETIME;

function tokensEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Прежняя кука — сам ключ сессии. Пока окно открыто (dbService.legacyOpen), она годится и тут же меняется на вход этого
// устройства. Страница шлёт десяток запросов разом, и все они несут старую куку: делаем один вход на всех, а не по
// одному на запрос (браузер всё равно оставит последнюю куку)
let swapped = null;
function swapLegacy(cookie) {
    if (swapped && swapped.cookie === cookie && Date.now() - swapped.at < 10e3) return swapped.made;
    // Вход живёт не дольше окна: старая кука не жила бы дольше
    const made = sessions.create(sessions.OWNER, { expiresAt: dbService.legacyUntil });
    swapped = { cookie, at: Date.now(), made };
    made.catch(() => { if (swapped?.made === made) swapped = null; });
    return made;
}

// Четыре права человека (users.may_*). Читаем на каждый запрос: выключили — закрыто сразу, без нового входа
const rightsOf = (row) => ({ request: !!row.may_request, download: !!row.may_download, upload: !!row.may_upload, view: !!row.may_view });

// Владелец — без обращения к базе. Человек — его строка из users; строки нет (база восстановлена из копии без неё) —
// входа нет: вход без хозяина не пускаем. Закрытый и убранный человек тоже никто: их входы стираются сразу, но и найденный
// случайно (запись о входе пережила, например, откат базы) не должен пройти
async function personOf(session) {
    if (session.userId === sessions.OWNER) return { id: sessions.OWNER, sid: session.id, isOwner: true, mustChange: false, rights: { request: true, download: true, upload: true, view: true } };
    const row = await dbService.get().get('SELECT name, must_change AS mustChange, state, may_request, may_download, may_upload, may_view FROM users WHERE id = ?', [session.userId]);
    return row && !row.state ? { id: session.userId, sid: session.id, name: row.name, isOwner: false, mustChange: !!row.mustChange, rights: rightsOf(row) } : null;
}

// Кто пришёл: req.person или null. Никогда не отказывает — отказывает requireAuth. База не открыта — просто никто
async function loadSession(req, res) {
    req.person = null;
    const provided = req.cookies && req.cookies[COOKIE_NAME];
    if (typeof provided !== 'string' || !provided) return;
    try {
        const found = await sessions.find(provided);
        if (found) { req.person = await personOf(found); return; }
        const expected = dbService.getSessionToken();
        if (expected && dbService.legacyOpen() && tokensEqual(provided, expected)) {
            const made = await swapLegacy(provided);
            res.cookie(COOKIE_NAME, made.token, { ...authCookie(req), maxAge: Math.max(0, made.expiresAt - Date.now()) });
            req.person = await personOf({ id: made.id, userId: sessions.OWNER });
        }
    } catch (e) {
        console.error('[Auth] Не удалось проверить вход:', e.message);
    }
}

const loadPerson = (req, res, next) => loadSession(req, res).then(() => next(), next);

// Middleware для защиты маршрутов: человек уже определён (loadPerson стоит раньше всех) или определяем здесь
async function requireAuth(req, res, next) {
    try {
        if (req.person === undefined) await loadSession(req, res);
    } catch (e) { return next(e); }
    if (!req.person) return res.status(401).json({ error: 'Требуется авторизация' });
    next();
}

router.get('/setup/status', async (req, res) => {
    const adminSet = await dbService.get().get('SELECT value FROM settings WHERE key = "admin_user"');
    res.json({ initialized: !!adminSet });
});

router.post('/setup/init', loginLimiter, async (req, res) => {
    const adminSet = await dbService.get().get('SELECT value FROM settings WHERE key = "admin_user"');
    if (adminSet) return res.status(403).json({ error: 'Сервер уже настроен!' });

    const { password } = req.body;
    const username = cleanName(req.body.username);
    if (username.length < 3 || !nameFits(username) || !passwordFits(password)) {
        return res.status(400).json({ error: 'Слишком короткий логин или пароль' });
    }
    // Имя человека из users занято: иначе вход по нему мог бы оказаться входом владельца
    if (await nameTaken(dbService.get(), username)) return res.status(409).json({ error: 'Это имя занято', reason: 'name-taken' });

    const hashedPass = await bcrypt.hash(password, 10);
    await dbService.get().run('INSERT INTO settings (key, value) VALUES (?, ?)', ['admin_user', username]);
    await dbService.get().run('INSERT INTO settings (key, value) VALUES (?, ?)', ['admin_pass', hashedPass]);
    res.json({ success: true });
});

// Пароль сверяем всегда, даже когда имени нет: по времени ответа не угадать, какие имена есть
let dummyHash = null;
const dummy = () => (dummyHash ||= bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 10));

router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const wrong = () => res.status(401).json({ error: 'Неверный логин или пароль' });
    if (typeof username !== 'string' || typeof password !== 'string') return wrong();
    // Идёт восстановление копии: вход записал бы сессию в её транзакцию, а при откате она пропала бы молча
    if (dbService.restoring) return res.status(503).json({ error: 'Идёт восстановление копии, попробуйте через минуту' });
    // Одна сверка имени для всех (utils/account.js, findAccount): точное имя главнее, потом без учёта регистра
    const found = await findAccount(dbService.get(), username);

    if (found?.owner) {
        const dbPass = await dbService.get().get('SELECT value FROM settings WHERE key = "admin_pass"');
        if (dbPass && await bcrypt.compare(password, dbPass.value)) {
            // Вход этого устройства на 30 дней
            const made = await sessions.create(sessions.OWNER);
            res.cookie(COOKIE_NAME, made.token, { ...authCookie(req), maxAge: THIRTY_DAYS });
            return res.json({ success: true });
        }
        return wrong();
    }
    const person = found?.person;
    // Пустой хэш (запись восстановлена из копии, где хэшей нет) пароль не принимает: сравнение идёт с пустышкой и отказывает
    const fits = await bcrypt.compare(password, person?.hash || dummy());
    if (!person || !person.hash || !fits) return wrong();
    // О закрытом входе говорим только тому, кто знает пароль: чужому по ответу не узнать, что за имя тут есть
    if (person.state) return res.status(403).json({ error: 'Вход для этой учётной записи закрыт', reason: 'account-locked' });
    const made = await sessions.create(person.id);
    res.cookie(COOKIE_NAME, made.token, { ...authCookie(req), maxAge: THIRTY_DAYS });
    res.json({ success: true, ...(person.mustChange ? { mustChange: true } : {}) });
});

// Кто я: страница спрашивает один раз при загрузке. Имя владельца — его логин из настроек
router.get('/me', requireAuth, async (req, res) => {
    const { id, isOwner, mustChange, rights } = req.person;
    const name = isOwner ? (await dbService.get().get('SELECT value FROM settings WHERE key = "admin_user"'))?.value ?? '' : req.person.name;
    // shared — в библиотеке есть другие люди. Пока их нет, страница не показывает имён и не сбрасывает запомненное:
    // владелец с одной учётной записью не видит никакой разницы. Убранные не в счёт: их в библиотеке уже нет.
    // avatar — версия картинки (время файла) или null; role — для подписи в интерфейсе, права решает isOwner
    const shared = !!(await dbService.get().get("SELECT 1 AS n FROM users WHERE state != 'removed' LIMIT 1"));
    res.json({ id, name, isOwner, mustChange, shared, avatar: await avatars.versionOf(id), role: isOwner ? 'owner' : 'user', rights });
});

// Выход закрывает вход этого устройства: остальные остаются во входе. Раньше менялся общий ключ, и выход на телефоне
// выводил из библиотеки компьютер. Забытое устройство закрывается сменой пароля (она выводит все остальные).
// Только со входом: иначе кто угодно выводил бы владельца одним запросом
router.post('/logout', requireAuth, async (req, res) => {
    try {
        await sessions.end(req.person.sid);
        // Открытые веб-сокеты проверку проходили при подключении, а не постоянно: вкладки этого устройства разрываем руками
        dropSessionSockets([req.person.sid]);
    } catch (e) {
        console.error('[Auth] Не удалось закрыть вход:', e.message);
    }
    res.clearCookie(COOKIE_NAME, authCookie(req));
    res.json({ success: true });
});

// Сокеты этих входов (комната session:<id>, server.js)
function dropSessionSockets(ids) {
    const io = getIo();
    for (const id of ids) io?.in(`session:${id}`).disconnectSockets(true);
}

// Смена пароля — из «Настроек». Нужен прежний пароль: открытая на чужом устройстве вкладка не должна
// давать сменить его. Остальные устройства выходят, а это остаётся во входе. Заодно закрывается окно старой
// куки: устройство, которое не успело обновиться, с ней больше не войдёт. Тот же лимит попыток, что у входа
router.post('/account/password', loginLimiter, requireAuth, async (req, res) => {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string') return res.status(400).json({ error: 'Нужны прежний и новый пароль' });
    if (!passwordFits(next)) return res.status(400).json({ error: 'Слишком короткий пароль' });
    const { isOwner, id } = req.person;
    const stored = isOwner
        ? (await dbService.get().get('SELECT value FROM settings WHERE key = "admin_pass"'))?.value
        : (await dbService.get().get('SELECT pass_hash AS value FROM users WHERE id = ?', [id]))?.value;
    if (!stored || !(await bcrypt.compare(current, stored))) return res.status(401).json({ error: 'Прежний пароль неверный' });
    if (isOwner) await writePassword(dbService.get(), next);
    else await dbService.get().run('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?', [await bcrypt.hash(next, 10), id]);
    let others = [];
    try {
        others = await sessions.endAllFor(id, req.person.sid);
        // Окно старой куки — владельцу: это его кука; от пароля другого человека она не зависит
        if (isOwner) {
            await dbService.closeLegacyWindow();
            for (const socket of getIo()?.sockets.sockets.values() || []) if (socket.data?.legacy) socket.disconnect(true);
        }
        dropSessionSockets(others);
    } catch (e) {
        console.error('[Auth] Не удалось закрыть остальные входы:', e.message);
    }
    res.json({ success: true, otherDevicesSignedOut: others.length > 0 });
});

// У веб-сокета нет express-мидлвар, но заголовки при рукопожатии есть. Достаём куку руками и сверяем так же, как
// loadSession. Ответ — { sid, userId } или { legacy: true } для старой куки в окне (комнаты входа у неё нет: обмен
// на настоящий вход делает первый же запрос страницы), либо null
async function socketPerson(req) {
    const raw = req.headers.cookie || '';
    const found = raw.split(';').map(s => s.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
    if (!found) return null;
    const provided = decodeURIComponent(found.slice(COOKIE_NAME.length + 1));
    try {
        const session = await sessions.find(provided);
        if (session) return { sid: session.id, userId: session.userId };
        const expected = dbService.getSessionToken();
        if (expected && dbService.legacyOpen() && tokensEqual(provided, expected)) return { legacy: true, userId: sessions.OWNER };
    } catch (e) {
        console.error('[Auth] Не удалось проверить вход сокета:', e.message);
    }
    return null;
}

module.exports = { authRouter: router, requireAuth, loadPerson, socketPerson, forgetLoginAttempts, dropSessionSockets, loginLimiter, rightsOf };
