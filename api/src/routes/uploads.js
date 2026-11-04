const express = require('express');
const { uploadLimiter } = require('../utils/upload.js');

// Загрузка архивов игр: начать или продолжить, кусок, состояние, пароль архива, повтор распаковки, отмена, что осталось
// недогруженным. Вся работа — в services/uploads.js, здесь только HTTP
module.exports = function createUploadsRouter(uploads) {
    const router = express.Router();
    router.use(uploadLimiter);

    // Не владелец (право upload, utils/access.js): только свои архивы и только новой игрой. Обновить или залатать чужое ему нечем: цель,
    // режим и «всё равно» до службы не доходят, а чужая загрузка отвечает как несуществующая
    const byOf = (req) => (req.person && !req.person.isOwner ? req.person.id : '');
    // «Имя занято, это вторая карточка» выдало бы игру, которая ему закрыта
    const shown = (req, answer) => (byOf(req) && answer && 'copy' in answer ? { ...answer, copy: false } : answer);

    // Ошибка — кодом и текстом; received, busy и state подсказывают клиенту, что делать дальше. reason 'space' — не
    // хватает места: need и free — сколько нужно и свободно, hard — не влезет и сам архив («всё равно» не предлагать).
    // Прочие reason с params — причина кодом: текст на языке человека делает страница (frontend/src/apiError.js)
    const handle = (work) => async (req, res) => {
        try {
            res.json(await work(req));
        } catch (e) {
            if (!e.status) console.error('[Upload]', e.message);
            if (res.headersSent) return;
            const { received, busy, state, reason, params, need, free, hard } = e;
            res.status(e.status || 500).json({ error: e.message, received, busy, state, reason, params, need, free, hard: byOf(req) && reason === 'space' ? true : hard });
        }
    };

    // Маршрут с номером загрузки: сначала — его ли она
    const owned = (work) => handle(async (req) => {
        const id = String(req.query.id || '');
        await uploads.checkBy(id, byOf(req));
        return shown(req, await work(id, req));
    });

    router.post('/start', handle(async (req) => {
        const by = byOf(req);
        if (!by) return uploads.start(req.body);
        const { name, size, fingerprint } = req.body || {};
        return shown(req, await uploads.start({ name, size, fingerprint }, by));
    }));
    router.post('/chunk', owned((id, req) => uploads.writeChunk(id, Number(req.query.offset || NaN), req)));
    router.get('/status', owned((id) => uploads.status(id)));
    router.post('/cancel', owned((id) => uploads.cancel(id)));
    router.post('/password', owned((id, req) => uploads.setPassword(id, req.body?.password)));
    router.post('/retry', owned((id) => uploads.retry(id)));
    router.get('/list', handle((req) => uploads.list(byOf(req))));

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
