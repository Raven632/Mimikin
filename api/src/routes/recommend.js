const express = require('express');

// «Во что поиграть?»: умный подбор по своей библиотеке (services/recommend.js). Сбой — код причины, текст у интерфейса
const fail = (res, e, label) => {
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message, reason: e.reason || '' });
    console.error(`[Подбор] ${label}:`, e.message);
    res.status(500).json({ error: 'Подбор не удался', reason: 'recommend-failed' });
};

function createRecommendRouter(recommend) {
    const router = express.Router();

    // Шапка «Найти», без походов в сеть: { offline, taste: { stage: new|collection|known, games }, modes }
    router.get('/modes', async (req, res) => {
        try {
            res.json(await recommend.modes({ person: req.person }));
        } catch (e) { fail(res, e, 'Режимы'); }
    });

    // Свои игры: { cold, total, items: [{ id, score, reasons }], resume: [{ id, reasons }] }
    router.get('/library', async (req, res) => {
        try {
            res.json(await recommend.library({ person: req.person }));
        } catch (e) { fail(res, e, 'Библиотека'); }
    });

    // «Не интересно» и его отмена: { key } и { key, undo: true }
    router.post('/dismiss', async (req, res) => {
        try {
            res.json(await recommend.dismiss(req.body?.key, { undo: req.body?.undo === true }));
        } catch (e) { fail(res, e, 'Не интересно'); }
    });
    router.get('/dismissed', async (req, res) => {
        try {
            res.json(await recommend.dismissedCount());
        } catch (e) { fail(res, e, 'Не интересно'); }
    });
    router.delete('/dismissed', async (req, res) => {
        try {
            res.json(await recommend.resetDismissed());
        } catch (e) { fail(res, e, 'Не интересно'); }
    });

    return router;
}

module.exports = createRecommendRouter;
