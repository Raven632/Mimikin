const express = require('express');
const { SAVES_DIR } = require('../config/index.js');
const { isSafeSegment } = require('../utils/validate.js');
const { requireAuth } = require('./auth.js');
const { createMarkStore } = require('../utils/marks.js');

// Моменты, снимки и перемотка для окна игры в библиотеке («Продолжить с…», вкладка «Скриншоты»): список с кадрами,
// кадр целиком, подписать, «Оставить» точку перемотки, убрать. Создаёт их сама игра
// (сервер игр, routes/play.js), открыть игру на моменте — запуск с ?mark=<id> (frontend launchGame)
const store = createMarkStore(SAVES_DIR);

const router = express.Router();
router.use(requireAuth);
router.param('id', (req, res, next, value) => (
    isSafeSegment(value) && !value.startsWith('.') ? next() : res.status(400).json({ error: 'Некорректный идентификатор' })
));
router.param('mark', (req, res, next, value) => (store.validId(value) ? next() : res.status(400).json({ error: 'bad-mark' })));

router.get('/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await store.list(req.params.id));
});
router.get('/:id/:mark/thumb', async (req, res) => {
    const file = await store.thumb(req.params.id, req.params.mark);
    if (!file) return res.status(404).end();
    res.sendFile(file, { maxAge: '1d' });
});
router.get('/:id/:mark/shot', async (req, res) => {
    const file = await store.shot(req.params.id, req.params.mark);
    if (!file) return res.status(404).end();
    res.sendFile(file, { maxAge: '1d' });
});
router.post('/:id/:mark/keep', async (req, res) => {
    const result = await store.keep(req.params.id, req.params.mark);
    res.status(result.error ? (result.error === 'too-many' ? 409 : 404) : 200).json(result);
});
router.patch('/:id/:mark', express.json({ limit: '4kb' }), async (req, res) => {
    if (typeof req.body?.label !== 'string') return res.status(400).json({ error: 'bad-label' });
    res.status((await store.rename(req.params.id, req.params.mark, req.body.label)) ? 200 : 404).json({ success: true });
});
router.delete('/:id/:mark', async (req, res) => {
    res.status((await store.remove(req.params.id, req.params.mark)) ? 200 : 404).json({ success: true });
});

module.exports = router;
module.exports.store = store;
