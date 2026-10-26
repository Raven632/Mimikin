const express = require('express');
const itchService = require('../services/itch.js');

const router = express.Router();

// Игры на RPG Maker с itch.io — для окна «Новинки»
router.get('/latest', async (req, res) => {
    try {
        res.json(await itchService.latest(req.query));
    } catch (e) {
        if (!e.limited) console.error('[itch.io] Каталог:', e.message);
        res.status(e.limited ? 429 : 502).json({ error: e.limited ? 'itch.io просит подождать' : 'itch.io не ответил', limited: !!e.limited });
    }
});

// Теги для фильтра и есть ли подробности (они идут через ScraperAPI)
router.get('/meta', (req, res) => res.json(itchService.catalogMeta()));

// Подробности игры со страницы itch.io — только для ссылок на игры itch.io
router.get('/game', async (req, res) => {
    try {
        const data = await itchService.details(req.query.url);
        if (!data && await itchService.budgetSpent()) return res.status(429).json({ error: 'Дневной запас ScraperAPI кончился', budget: true });
        if (!data) return res.status(404).json({ error: 'Страница не открылась' });
        res.json(data);
    } catch (e) {
        if (e.bad) return res.status(400).json({ error: e.message });
        console.error('[itch.io] Страница игры:', e.message);
        res.status(502).json({ error: 'itch.io не ответил' });
    }
});

module.exports = router;
