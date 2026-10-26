const express = require('express');

// Полная проверка библиотеки (services/fullcheck.js): GET — ход нынешней или итог последней,
// POST — начать, POST /cancel — остановить. Идёт она долго, поэтому оба POST отвечают сразу,
// а ход приходит событием 'fullcheck'
function createCheckRouter(fullCheck) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            res.json(await fullCheck.status());
        } catch (e) {
            console.error('[Проверка]', e.message);
            res.status(500).json({ error: 'Не удалось узнать, как идёт проверка' });
        }
    });

    router.post('/', async (req, res) => {
        try {
            res.json(await fullCheck.start());
        } catch (e) {
            console.error('[Проверка]', e.message);
            res.status(500).json({ error: 'Не удалось начать проверку' });
        }
    });

    router.post('/cancel', async (req, res) => {
        try {
            res.json(await fullCheck.cancel());
        } catch (e) {
            console.error('[Проверка]', e.message);
            res.status(500).json({ error: 'Не удалось остановить проверку' });
        }
    });

    return router;
}

module.exports = createCheckRouter;
