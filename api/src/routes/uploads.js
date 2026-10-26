const express = require('express');
const { uploadLimiter } = require('../utils/upload.js');

// Загрузка архивов игр: начать или продолжить, кусок, состояние, пароль архива, отмена, что осталось
// недогруженным. Вся работа — в services/uploads.js, здесь только HTTP
module.exports = function createUploadsRouter(uploads) {
    const router = express.Router();
    router.use(uploadLimiter);

    // Ошибка — кодом и текстом; received, busy и state подсказывают клиенту, что делать дальше
    const handle = (work) => async (req, res) => {
        try {
            res.json(await work(req));
        } catch (e) {
            if (!e.status) console.error('[Upload]', e.message);
            if (res.headersSent) return;
            const { received, busy, state } = e;
            res.status(e.status || 500).json({ error: e.message, received, busy, state });
        }
    };

    router.post('/start', handle((req) => uploads.start(req.body)));
    router.post('/chunk', handle((req) => uploads.writeChunk(String(req.query.id || ''), Number(req.query.offset || NaN), req)));
    router.get('/status', handle((req) => uploads.status(String(req.query.id || ''))));
    router.post('/cancel', handle((req) => uploads.cancel(String(req.query.id || ''))));
    router.post('/password', handle((req) => uploads.setPassword(String(req.query.id || ''), req.body?.password)));
    router.get('/list', handle(() => uploads.list()));

    // Журнал страницы (resumableUpload.js): что она делала, когда кусок завис, пошёл на повтор или
    // загрузка кончилась. Приходит через sendBeacon простым текстом — одной строкой в журнал сервера
    router.post('/trace', express.text({ type: () => true, limit: '64kb' }), (req, res) => {
        let t = {};
        try { t = JSON.parse(req.body || '{}'); } catch (e) {}
        const clean = (v, n) => String(v || '').replace(/[\r\n]+/g, ' ').slice(0, n);
        const lines = (Array.isArray(t.lines) ? t.lines : []).slice(-60).map((l) => clean(l, 200));
        // Адрес — чтобы видеть, напрямую ли пришло устройство или через что-то посередине
        const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        console.log(`[Upload] журнал «${clean(t.name, 120)}» (${clean(t.why, 40)}) с ${from}, ${clean(t.ua, 200)}${t.standalone ? ', веб-приложение' : ''}: ${lines.join(' | ')}`);
        res.status(204).end();
    });
    return router;
};
