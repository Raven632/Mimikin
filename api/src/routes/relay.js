const express = require('express');
const rateLimit = require('express-rate-limit');
const relayService = require('../services/relay.js');

// Связанные установки говорят друг с другом (services/relay.js). Без входа на сайт: та установка — другой сервер, куки
// у неё нет. Попросить связать может кто угодно, но связь появится, только когда владелец здесь нажмёт «Разрешить»;
// всё остальное — по ключу, который она получила при этом
function createRelayRouter(relay = relayService) {
    const router = express.Router();

    const reply = (fn) => async (req, res) => {
        try {
            await fn(req, res);
        } catch (e) {
            if (!res.headersSent) res.status(e.status || 500).json({ error: e.status ? e.message : 'Не вышло' });
            if (!e.status) console.error('[Две установки]', e.message);
        }
    };
    // Просьбы «Связать» — не чаще 10 за 15 минут с одного адреса: перебирать тут нечего, но и засыпать просьбами незачем
    const asks = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много просьб связать' } });

    router.post('/pair', asks, reply((req, res) => res.json(relay.ask(req.body, req.ip))));
    // nonce — заголовком: адреса запросов пишут в журналы прокси
    router.get('/pair/:request', reply((req, res) => res.json(relay.answer(req.params.request, req.get('x-relay-nonce')))));
    router.delete('/pair/:request', reply((req, res) => { relay.withdraw(req.params.request, req.get('x-relay-nonce')); res.json({ ok: true }); }));

    // Дальше — только с ключом связанной установки
    const keyed = (req, res, next) => (relay.allowed(req.get('authorization')) ? next() : res.status(401).json({ error: 'Нужен ключ связанной установки' }));
    router.delete('/pair', keyed, reply(async (req, res) => { await relay.unlink(false); res.json({ ok: true }); }));
    router.post('/login', keyed, reply(async (req, res) => { await relay.adopt(req.body?.myjd); res.json({ ok: true }); }));
    router.get('/files', keyed, reply(async (req, res) => res.json(await relay.files())));
    // Папка той установки — «.<номер>», поэтому dotfiles: 'allow'; скрытое внутри неё fileOf не отдаёт
    router.get('/file', keyed, reply(async (req, res) => {
        const { f } = await relay.fileOf(req.query.path);
        await new Promise((resolve, reject) => res.sendFile(f, { dotfiles: 'allow' }, (e) => (e && !res.headersSent ? reject(Object.assign(e, { status: 404, message: 'Нет такого архива' })) : resolve())));
    }));
    router.delete('/file', keyed, reply(async (req, res) => {
        await relay.remove(req.query.path).catch((e) => { throw e.code === 'ENOENT' ? Object.assign(e, { status: 404, message: 'Нет такого архива' }) : e; });
        res.json({ ok: true });
    }));

    return router;
}

module.exports = createRelayRouter;
