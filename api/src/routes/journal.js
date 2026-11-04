const express = require('express');
const { isSafeSegment } = require('../utils/validate.js');
const { requireAuth } = require('./auth.js');
const personStores = require('../utils/personStores.js');

// «Путь» по игре для окна игры в библиотеке: записи и кадры сцен. Пишет их сама игра (сервер игр, routes/play.js)
const store = personStores.owner.journal;
const mine = (req) => personStores.storesFor(req.person).journal;

const router = express.Router();
router.use(requireAuth);
router.param('id', (req, res, next, value) => (
    isSafeSegment(value) && !value.startsWith('.') ? next() : res.status(400).json({ error: 'Некорректный идентификатор' })
));
router.param('entry', (req, res, next, value) => (store.validId(value) ? next() : res.status(400).json({ error: 'bad-entry' })));

router.get('/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await mine(req).list(req.params.id));
});
// «Ещё не видели»: сколько сцен комнаты воспоминаний открыто (последний счёт игры); нет — null
router.get('/:id/room', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await mine(req).room(req.params.id));
});
router.get('/:id/:entry/thumb', async (req, res) => {
    const file = await mine(req).thumb(req.params.id, req.params.entry);
    if (!file) return res.status(404).end();
    res.sendFile(file, { maxAge: '7d' });
});

module.exports = router;
module.exports.store = store;
