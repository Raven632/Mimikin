const express = require('express');
const myjd = require('../services/myjd.js');
const downloads = require('../services/downloads.js');
const { isGameId } = require('./play.js');

const router = express.Router();

// «Загрузить» по ссылке на файлообменник (services/downloads.js: что можно скачать)
const reply = async (res, work) => {
    try {
        res.json(await work());
    } catch (e) {
        if (e.reason === 'off') return res.status(409).json({ error: e.message, reason: 'off' });
        if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message, reason: e.reason || '' });
        console.error('[MyJDownloader]', e.message);
        res.status(502).json({ error: e.message, reason: e.reason || 'site' });
    }
};

// Что качать: { url } — ссылка на файл (title, version, game — из окна игры). game — игра библиотеки:
// скачанное встанет её обновлением
router.post('/', (req, res) => reply(res, async () => {
    const game = isGameId(String(req.body?.game || '')) ? String(req.body.game) : '';
    if (typeof req.body?.url !== 'string') throw Object.assign(new Error('Нужна ссылка на файл'), { status: 400, reason: 'site' });
    return downloads.startUrl(req.body.url, { title: req.body.title, version: req.body.version, game });
}));

const JOB_KEY = /^link:[0-9a-f]{12}$/;

// «Повторить» у вставшей загрузки в списке в шапке
router.post('/:key/retry', (req, res) => {
    const key = String(req.params.key);
    if (!JOB_KEY.test(key)) return res.status(400).json({ error: 'Непонятная загрузка' });
    return reply(res, () => myjd.retry(key));
});

// Ход загрузок: окно игры и список в шапке опрашивают это раз в несколько секунд
router.get('/', async (req, res) => {
    try {
        res.json(await myjd.downloads());
    } catch (e) {
        console.error('[MyJDownloader] Ход загрузок:', e.message);
        res.status(502).json({ error: e.message });
    }
});

// Убрать из списка — только запись о загрузке: у JDownloader и в библиотеке ничего не трогаем
router.delete('/:key', async (req, res) => {
    const key = String(req.params.key);
    if (!JOB_KEY.test(key)) return res.status(400).json({ error: 'Непонятная загрузка' });
    try {
        await myjd.forgetJob(key);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
