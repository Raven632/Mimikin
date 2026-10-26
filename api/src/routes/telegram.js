const express = require('express');

// Окно «Telegram» в меню библиотеки: подключить чат, выбрать, что присылать, проверить связь,
// отправить копию сейчас (services/telegram.js)
module.exports = function createTelegramRouter(telegram) {
    const router = express.Router();
    const handle = (work) => async (req, res) => {
        try {
            res.json(await work(req));
        } catch (e) {
            if (!e.status) console.error('[Telegram]', e.message);
            res.status(e.status || 502).json({ error: e.message });
        }
    };

    router.get('/', handle(() => telegram.status()));
    router.post('/link', handle((req) => telegram.startLink({ lang: req.body?.lang, library: req.body?.library })));
    router.delete('/link', handle(async () => { await telegram.unlink(); return telegram.status(); }));
    router.post('/prefs', handle(async (req) => { await telegram.savePrefs(req.body || {}); return telegram.status(); }));
    router.post('/test', handle(async () => { await telegram.test(); return { ok: true }; }));
    router.post('/backup', handle(async () => telegram.checkBackup({ force: true })));
    return router;
};
