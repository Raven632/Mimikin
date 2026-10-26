const express = require('express');
const wishlistService = require('../services/wishlist.js');

const router = express.Router();

const failed = (res, e, what) => {
    if (e.bad) return res.status(400).json({ error: e.message });
    console.error(`[Хочу поиграть] ${what}:`, e.message);
    res.status(500).json({ error: 'Не получилось' });
};

// Весь список
router.get('/', async (req, res) => {
    try {
        res.json(await wishlistService.list());
    } catch (e) {
        failed(res, e, 'Список');
    }
});

// Отложить игру из окна новинок — со всем, что окно о ней показывало
router.post('/', async (req, res) => {
    try {
        res.json(await wishlistService.add(req.body));
    } catch (e) {
        failed(res, e, 'Добавление');
    }
});

// Убрать игру: ключ вида «itch:<адрес игры>» — в адресе запроса
router.delete('/', async (req, res) => {
    try {
        res.json({ removed: await wishlistService.remove(req.query.key) });
    } catch (e) {
        failed(res, e, 'Удаление');
    }
});

module.exports = router;
