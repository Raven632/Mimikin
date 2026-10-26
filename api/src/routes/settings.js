const express = require('express');
const { secret, secretFromEnv, setSavedSecret, describeSecret, SECRETS, seal, myjdWithoutPassword } = require('../utils/secrets.js');
const { OPTIONS, checkOption, setOption, describeOptions } = require('../utils/options.js');
const { version } = require('../../package.json');


// «Настройки»: то, что раньше задавалось только в .env на сервере, и сведения о программе.
// Сами ключи наружу не отдаём — только задан ли, откуда и последние четыре знака.
// checks — проверка на месте: принял ли Telegram токен, вошёл ли MyJDownloader. Ответ { ok: true },
// { ok: false } (не принял — не сохраняем) или null (сайт не ответил — сохраняем, проверим потом).
// onSaved(name) — после сохранения: Telegram начнёт работу
const RULES = {
    scraper: {
        clean: (v) => v,
        valid: (v) => /^[A-Za-z0-9]{16,64}$/.test(v),
        bad: 'Это не похоже на ключ ScraperAPI',
    },
    telegram: {
        clean: (v) => v,
        valid: (v) => /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(v),
        bad: 'Это не похоже на токен бота: он выглядит как 123456789:AAE…',
        refused: 'Telegram не принял токен — скопируйте его у @BotFather ещё раз',
    },
    backup: {
        clean: (v) => v,
        valid: (v) => v.length >= 8 && v.length <= 200,
        bad: 'Пароль копий — не короче 8 знаков',
    },
    deepl: {
        clean: (v) => v,
        valid: (v) => /^[0-9a-f-]{36}(:fx)?$/i.test(v),
        bad: 'Это не похоже на ключ DeepL: он выглядит как 1a2b3c4d-…:fx',
        refused: 'DeepL не принял ключ',
    },
    // Ключ и регион ресурса Azure через пробел: «ключ westeurope». Глобальному ресурсу регион не нужен
    microsoft: {
        clean: (v) => v.split(/[\s,|]+/).filter(Boolean).slice(0, 2).join('|'),
        valid: (v) => /^[A-Za-z0-9]{32,100}(\|[a-z0-9]{2,30})?$/.test(v),
        bad: 'Это не похоже на ключ Microsoft Translator: ключ и, через пробел, регион (например, westeurope)',
        refused: 'Microsoft не принял ключ или регион',
    },
    google: {
        clean: (v) => v,
        valid: (v) => /^AIza[0-9A-Za-z_-]{30,45}$/.test(v),
        bad: 'Это не похоже на ключ Google Cloud: он начинается с AIza',
        refused: 'Google не принял ключ',
    },
    // MyJDownloader: почта, пароль, имя устройства и папка «Входящие» на его сервере — одним JSON. Пароль дальше не идёт:
    // сразу превращается в две суммы, которых протоколу хватает для входа (utils/secrets.js, myjdWithoutPassword)
    myjd: {
        // Пусто — «Отключить»
        clean: (v) => {
            if (!v) return '';
            try {
                const o = JSON.parse(v);
                const password = String(o.password || '');
                const fields = { email: String(o.email || '').trim(), device: String(o.device || '').trim() || 'server', folder: String(o.folder || '').trim() };
                // Без пароля — поменять устройство или папку у сохранённого входа: суммы для входа — его, если почта та же
                if (!password) {
                    const prev = JSON.parse(secret('myjd') || 'null');
                    return prev?.loginSecret && String(prev.email || '').toLowerCase() === fields.email.toLowerCase()
                        ? JSON.stringify({ ...fields, loginSecret: prev.loginSecret, deviceSecret: prev.deviceSecret }) : '-';
                }
                if (password.length > 200) return '-';
                return myjdWithoutPassword(JSON.stringify({ ...fields, password }));
            } catch { return '-'; }
        },
        valid: (v) => {
            let o;
            try { o = JSON.parse(v); } catch { return false; }
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email) && /^[0-9a-f]{64}$/.test(o.loginSecret) && /^[0-9a-f]{64}$/.test(o.deviceSecret)
                && o.device.length <= 80 && o.folder.length <= 500;
        },
        bad: 'Нужны почта и пароль MyJDownloader',
        refused: 'MyJDownloader не пустил: неверные почта или пароль, или нет такого устройства',
    },
    // Seedbox: адрес, порт, логин, пароль и папка — одним JSON. Сохраняется не он, а то, что вернула настройка
    // (services/seedbox.js): ключ вместо пароля
    seedbox: {
        clean: (v) => {
            if (!v) return '';
            try {
                const o = JSON.parse(v);
                const host = String(o.host || '').trim().replace(/^(sftp|ssh):\/\//i, '').replace(/\/.*$/, '');
                return JSON.stringify({ host, port: Number(o.port) || 22, user: String(o.user || '').trim(), password: String(o.password || ''), folder: String(o.folder || '').trim() });
            } catch { return '-'; }
        },
        valid: (v) => {
            let o;
            try { o = JSON.parse(v); } catch { return false; }
            return /^[A-Za-z0-9.-]{1,253}$/.test(o.host) && Number.isInteger(o.port) && o.port > 0 && o.port < 65536 && /^[A-Za-z0-9._-]{1,64}$/.test(o.user)
                && ((o.password || '').length > 0 || !!o.key) && (o.password || '').length <= 200 && String(o.folder || '').trim().length > 0 && String(o.folder).length <= 500;
        },
        bad: 'Нужны адрес сервера, логин, пароль и папка',
        refused: 'Сервер не пустил',
        // Сохраняется только то, что вернула проверка (ключ вместо пароля): без неё введённое с паролем не сохраняем
        mustCheck: true,
    },
    // Помощник обновлений (services/updates.js): адрес его /v1/update и ключ. Не проверяем запросом: у Watchtower это
    // и есть «обновить сейчас». Адрес — только http(s) без логина, ?параметров и #: ключ уходит заголовком, а не в адресе
    updater: {
        clean: (v) => {
            if (!v) return '';
            try {
                const o = JSON.parse(v);
                return JSON.stringify({ url: String(o.url || '').trim(), token: String(o.token || '').trim() });
            } catch { return '-'; }
        },
        valid: (v) => {
            let o;
            try { o = JSON.parse(v); } catch { return false; }
            return /^https?:\/\/[^\s/@?#]+(\/[^\s?#]*)?$/i.test(o.url) && o.url.length <= 500 && o.token.length <= 500 && !/\s/.test(o.token);
        },
        bad: 'Нужен адрес вида http://mimikin-update:8080/v1/update',
    },
    // Адрес своего LibreTranslate и, через пробел, его ключ, если задан
    libre: {
        clean: (v) => v.split(/\s+/).filter(Boolean).slice(0, 2).join('|'),
        valid: (v) => /^https?:\/\/[^\s|]+(\|\S+)?$/.test(v),
        bad: 'Нужен адрес LibreTranslate, например http://192.168.1.10:5000',
        refused: 'LibreTranslate не ответил по этому адресу',
    },
};

// services(fresh) — сводка по службам для вкладки «Службы» (services/quota.js)
// seedbox — забор архивов с seedbox (services/seedbox.js): что с ним сейчас и «проверить сейчас»
// updates — новая версия на GitHub и «Обновить» (services/updates.js)
// server() — что задаётся только на сервере (.env): для «О программе», без значений секретов
function createSettingsRouter(dbService, { checks = {}, onSaved = () => {}, services = null, seedbox = null, relay = null, updates = null, server = null } = {}) {
    const router = express.Router();
    const describe = () => ({
        version,
        ...Object.fromEntries(Object.keys(SECRETS).map((name) => [name, describeSecret(name)])),
        options: describeOptions(),
    });

    router.get('/', (req, res) => res.json(describe()));

    // Службы: есть ли ключ, отвечает ли, сколько осталось и когда обновится. ?fresh=1 — спросить заново
    router.get('/services', async (req, res) => {
        if (!services) return res.status(404).json({ error: 'Нет' });
        try { res.json(await services(req.query.fresh === '1')); } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
    });

    // Любимые теги: названия маленькими буквами, до 20. По ним — отметка у игр в «Новинках» и в окне игры
    const readFavorites = async () => {
        const row = await dbService.get().get("SELECT value FROM settings WHERE key = 'favorite_tags'").catch(() => null);
        try { return JSON.parse(row?.value || '[]'); } catch (e) { return []; }
    };
    router.get('/favorite-tags', async (req, res) => res.json({ tags: await readFavorites() }));
    router.post('/favorite-tags', async (req, res) => {
        const raw = Array.isArray(req.body?.tags) ? req.body.tags : null;
        if (!raw) return res.status(400).json({ error: 'Нужен список тегов' });
        const tags = [...new Set(raw.map((x) => String(x || '').trim().toLowerCase()).filter((x) => x && x.length <= 40))].slice(0, 20);
        try {
            await dbService.get().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('favorite_tags', ?)", [JSON.stringify(tags)]);
            await Promise.resolve(onSaved('favorite_tags')).catch((e) => console.error('[Настройки]', e.message));
            res.json({ tags });
        } catch (e) {
            console.error('[Настройки]', e.message);
            // Нет ключа шифрования — так и сказать, что чинить, а не «не удалось»
            res.status(500).json({ error: e.seal ? e.message : 'Не удалось сохранить' });
        }
    });

    // Языки, которые человек знает: игры на них не предлагаем переводить (окно игры). Коды языков текста
    // игры (services/textLang), до 12
    const KNOWN_LANGS = ['en', 'ru', 'de', 'ja', 'zh', 'ko', 'es', 'fr', 'pt', 'it', 'pl', 'id'];
    const readKnownLangs = async () => {
        const row = await dbService.get().get("SELECT value FROM settings WHERE key = 'known_langs'").catch(() => null);
        try { return JSON.parse(row?.value || '[]'); } catch (e) { return []; }
    };
    router.get('/known-langs', async (req, res) => res.json({ langs: await readKnownLangs() }));
    router.post('/known-langs', async (req, res) => {
        const raw = Array.isArray(req.body?.langs) ? req.body.langs : null;
        if (!raw) return res.status(400).json({ error: 'Нужен список языков' });
        const langs = [...new Set(raw.map((x) => String(x || '').trim().toLowerCase()).filter((x) => KNOWN_LANGS.includes(x)))].slice(0, 12);
        try {
            await dbService.get().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('known_langs', ?)", [JSON.stringify(langs)]);
            await Promise.resolve(onSaved('known_langs')).catch((e) => console.error('[Настройки]', e.message));
            res.json({ langs });
        } catch (e) {
            console.error('[Настройки]', e.message);
            res.status(500).json({ error: 'Не удалось сохранить' });
        }
    });

    router.get('/seedbox', (req, res) => (seedbox ? res.json(seedbox.status()) : res.status(404).json({ error: 'Нет' })));
    router.post('/seedbox/pull', async (req, res) => {
        if (!seedbox) return res.status(404).json({ error: 'Нет' });
        await seedbox.pull();
        res.json(seedbox.status());
    });

    // Две установки на одном JDownloader (services/relay.js): связь, просьбы связать, последний проход. Каждое действие
    // отвечает тем же, что GET: страница сразу видит, что стало
    const relayAct = (fn) => async (req, res) => {
        if (!relay) return res.status(404).json({ error: 'Нет' });
        try {
            await fn(req);
            res.json(await relay.status());
        } catch (e) {
            res.status(e.status || 500).json({ error: e.status ? e.message : 'Не вышло' });
            if (!e.status) console.error('[Две установки]', e.message);
        }
    };
    router.get('/relay', relayAct(() => {}));
    router.post('/relay/pull', relayAct(() => relay.tick()));
    router.post('/relay/pair', relayAct((req) => relay.pair(req.body?.url, req.body?.self)));
    router.post('/relay/cancel', relayAct(() => relay.cancel()));
    router.post('/relay/approve', relayAct((req) => relay.approve(String(req.body?.request || ''))));
    router.post('/relay/deny', relayAct((req) => relay.deny(String(req.body?.request || ''))));
    router.post('/relay/unlink', relayAct(() => relay.unlink()));

    // Простые параметры (utils/options.js): { name, value }; value: null — вернуть как по умолчанию
    router.post('/options', async (req, res) => {
        const name = String(req.body?.name || '');
        const o = OPTIONS[name];
        if (!o) return res.status(404).json({ error: 'Такой настройки нет' });
        if (describeOptions()[name].fromEnv) return res.status(409).json({ error: 'Задано в .env на сервере — менять нужно там' });
        const raw = req.body?.value ?? null;
        const value = checkOption(name, raw);
        if (value === undefined) return res.status(400).json({ error: o.type === 'int' ? `Нужно целое число от ${o.min} до ${o.max}` : 'Непонятное значение', reason: 'bad' });
        try {
            if (value === null) await dbService.get().run('DELETE FROM settings WHERE key = ?', [name]);
            else await dbService.get().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [name, String(value)]);
            // В память — после базы: не записалось — действует прежнее, как и после перезапуска
            setOption(name, value);
            await Promise.resolve(onSaved(name)).catch((e) => console.error('[Настройки]', e.message));
            res.json(describe());
        } catch (e) {
            console.error('[Настройки]', e.message);
            res.status(500).json({ error: 'Не удалось сохранить' });
        }
    });

    router.get('/server', (req, res) => (server ? res.json(server()) : res.status(404).json({ error: 'Нет' })));

    router.get('/update', async (req, res) => (updates ? res.json(await updates.status(req.query.fresh === '1')) : res.status(404).json({ error: 'Нет' })));
    router.post('/update', async (req, res) => {
        if (!updates) return res.status(404).json({ error: 'Нет' });
        try {
            res.json(await updates.update());
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    // Ключ или пароль. Пустой — убрать. Задан в .env — он главный, из «Настроек» его не поменять
    router.post('/:name', async (req, res) => {
        const name = req.params.name;
        const rule = RULES[name];
        if (!rule) return res.status(404).json({ error: 'Такой настройки нет' });
        if (secretFromEnv(name)) return res.status(409).json({ error: 'Задано в .env на сервере — менять нужно там' });
        let value = rule.clean(String(req.body?.key || '').trim());
        if (value && !rule.valid(value)) return res.status(400).json({ error: rule.bad, reason: 'bad' });
        let checked = null;
        if (value && checks[name]) {
            checked = await checks[name](value).catch(() => null);
            // Проверка знает причину точнее (неверная почта, нет устройства) — её и показываем
            if (checked && checked.ok === false) return res.status(400).json({ error: checked.message || rule.refused, reason: 'refused', ...(checked.why ? { why: checked.why } : {}) });
            // Проверка дополнила значение (например, пароль, достроенный по двум другим полям) — сохраняем полное
            if (checked?.value && rule.valid(checked.value)) value = checked.value;
            else if (rule.mustCheck) return res.status(502).json({ error: checked?.message || rule.refused, reason: 'refused' });
        }
        try {
            const key = SECRETS[name].setting;
            // В базу — зашифрованным (utils/secrets.js), в память — как есть
            if (value) await dbService.get().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, seal(value, key)]);
            else await dbService.get().run('DELETE FROM settings WHERE key = ?', [key]);
            setSavedSecret(name, value);
            await Promise.resolve(onSaved(name)).catch((e) => console.error('[Настройки]', e.message));
            // checked: true — сайт подтвердил, false — проверить не вышло (сайт не ответил)
            res.json({ ...describe(), checked: value && checks[name] ? !!checked?.ok : undefined });
        } catch (e) {
            console.error('[Настройки]', e.message);
            res.status(500).json({ error: 'Не удалось сохранить' });
        }
    });

    return router;
}

module.exports = createSettingsRouter;
