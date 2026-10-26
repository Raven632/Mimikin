const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const dbService = require('../db/database.js');
const { getIo } = require('../utils/cache.js');

const router = express.Router();
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'auth_token';

// Общий apiLimiter пропускает 200 запросов в минуту — для подбора пароля это
// 288 000 попыток в сутки, то есть защиты нет. Форме входа нужен свой лимит.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true, // удачный вход попытку не тратит
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много попыток входа. Повторите через 15 минут.' },
});

function tokensEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Middleware для защиты маршрутов токеном
function requireAuth(req, res, next) {
    const expected = dbService.getSessionToken();
    const provided = req.cookies && req.cookies[COOKIE_NAME];
    if (!expected || typeof provided !== 'string' || !tokensEqual(provided, expected)) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    next();
}

router.get('/setup/status', async (req, res) => {
    const adminSet = await dbService.get().get('SELECT value FROM settings WHERE key = "admin_user"');
    res.json({ initialized: !!adminSet });
});

router.post('/setup/init', loginLimiter, async (req, res) => {
    const adminSet = await dbService.get().get('SELECT value FROM settings WHERE key = "admin_user"');
    if (adminSet) return res.status(403).json({ error: 'Сервер уже настроен!' });

    const { username, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 4) {
        return res.status(400).json({ error: 'Слишком короткий логин или пароль' });
    }

    const hashedPass = await bcrypt.hash(password, 10);
    await dbService.get().run('INSERT INTO settings (key, value) VALUES (?, ?)', ['admin_user', username]);
    await dbService.get().run('INSERT INTO settings (key, value) VALUES (?, ?)', ['admin_pass', hashedPass]);
    res.json({ success: true });
});

router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const dbUser = await dbService.get().get('SELECT value FROM settings WHERE key = "admin_user"');
    const dbPass = await dbService.get().get('SELECT value FROM settings WHERE key = "admin_pass"');

    if (dbUser && dbPass && username === dbUser.value) {
        if (await bcrypt.compare(password, dbPass.value)) {
            // Выдаем куку сессии на 30 дней
            res.cookie(COOKIE_NAME, dbService.getSessionToken(), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
            return res.json({ success: true });
        }
    }
    res.status(401).json({ error: 'Неверный логин или пароль' });
});

// Раньше выход просто стирал куку в браузере, а сам ключ оставался прежним:
// копия куки с другого устройства продолжала работать вечно. Теперь ключ меняется,
// то есть выход действительно закрывает доступ — сразу на всех устройствах.
// Только со входом: иначе кто угодно выводил бы владельца со всех устройств одним запросом
router.post('/logout', requireAuth, async (req, res) => {
    let rotated = false;
    try {
        rotated = await dbService.rotateSessionToken();
        // Уже открытые веб-сокеты проверку проходили при подключении, а не постоянно,
        // поэтому их нужно разорвать руками: иначе живая вкладка осталась бы на связи
        if (rotated) getIo()?.disconnectSockets(true);
    } catch (e) {
        console.error('[Auth] Не удалось сменить ключ сессии:', e.message);
    }
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true, allDevices: rotated });
});

// Смена пароля — из «Настроек». Нужен прежний пароль: открытая на чужом устройстве вкладка не должна
// давать сменить его. Как и выход, меняет ключ сессии: другие устройства выходят, а это получает новый
// вход сразу — человек остаётся в библиотеке. Тот же лимит попыток, что у входа
router.post('/account/password', loginLimiter, requireAuth, async (req, res) => {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string') return res.status(400).json({ error: 'Нужны прежний и новый пароль' });
    if (next.length < 4) return res.status(400).json({ error: 'Слишком короткий пароль' });
    const dbPass = await dbService.get().get('SELECT value FROM settings WHERE key = "admin_pass"');
    if (!dbPass || !(await bcrypt.compare(current, dbPass.value))) return res.status(401).json({ error: 'Прежний пароль неверный' });
    await dbService.get().run('UPDATE settings SET value = ? WHERE key = "admin_pass"', [await bcrypt.hash(next, 10)]);
    let others = false;
    try {
        others = await dbService.rotateSessionToken();
        if (others) getIo()?.disconnectSockets(true);
    } catch (e) {
        console.error('[Auth] Не удалось сменить ключ сессии:', e.message);
    }
    res.cookie(COOKIE_NAME, dbService.getSessionToken(), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, otherDevicesSignedOut: others });
});

// У веб-сокета нет express-мидлвар, но заголовки при рукопожатии есть.
// Достаём куку руками и сверяем тем же способом, что и requireAuth.
function isAuthedSocket(req) {
    const raw = req.headers.cookie || '';
    const found = raw.split(';').map(s => s.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
    if (!found) return false;
    const provided = decodeURIComponent(found.slice(COOKIE_NAME.length + 1));
    const expected = dbService.getSessionToken();
    return !!expected && tokensEqual(provided, expected);
}

module.exports = { authRouter: router, requireAuth, isAuthedSocket };
