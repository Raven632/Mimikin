const fs = require('fs');
const { secret } = require('../utils/secrets.js');
const { option } = require('../utils/options.js');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { shownTitle } = require('../utils/title.js');
const { getIo } = require('../utils/cache.js');

// Сообщения библиотеки в Telegram. Бот — свой: его создают в @BotFather, токен — в .env
// (TELEGRAM_BOT_TOKEN). Чат привязывается из библиотеки: пункт меню «Telegram» даёт ссылку
// t.me/<бот>?start=<код>, человек жмёт «Start» — и сервер узнаёт его чат по этому коду.
// Бот — ещё и пульт: ссылка на файл из привязанного чата — «Загрузить» через MyJDownloader. Чужие чаты бот не слушает.
//
// Без спама: всё, кроме проблем, —
// беззвучно; загрузка — только если за ней никто не следит; копия базы — не чаще раза в сутки и
// только если что-то изменилось; одна и та же проблема — не чаще раза в сутки; всего — не больше
// 10 сообщений в час. Какие виды присылать — выбирается в том же окне
const API = 'https://api.telegram.org';
const HOUR = 3600e3;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const KINDS = ['uploads', 'backup', 'problems'];
const PER_HOUR = 10;
const LINK_TTL = 10 * 60e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (text, url) => (url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

const TEXT = {
    ru: {
        added: (title) => `Игра добавлена: <b>${esc(title)}</b>`,
        updated: (title, version) => `Игра обновлена: <b>${esc(title)}</b>${version ? ` — версия ${esc(version)}` : ''}`,
        patched: (title) => `Патч установлен: <b>${esc(title)}</b>`,
        upload_error: (name, error) => `Загрузка «${esc(name)}» не удалась: ${esc(error)}`,
        upload_password: (name) => `Архив «${esc(name)}» под паролем — введите пароль в библиотеке`,
        backup: (games, saves, size) => `Копия библиотеки: игр — ${games}, сейвы — у ${saves}. ${size}`,
        backup_locked: ' Архив под паролем из BACKUP_PASSWORD.',
        backup_failed: (error) => `Копия библиотеки не отправлена: ${esc(error)}`,
        backup_big: (size) => `Копия библиотеки весит ${size}, а Telegram принимает до 50 МБ. Скачайте её из меню библиотеки`,
        disk_low: (free, games) => `На диске библиотеки осталось ${free}${games ? ` — примерно на ${games} игр` : ''}`,
        linked: (list) => `Библиотека подключена. Буду присылать: ${list}. Что присылать — в меню библиотеки, пункт «Telegram».`,
        test: 'Проверка связи — всё работает.',
        kinds: {
            uploads: 'готовые загрузки, если страница закрыта',
            backup: 'копию базы и сейвов раз в день, если что-то изменилось', problems: 'проблемы сервера',
        },
        open: 'Открыть библиотеку',
        units: ['МБ', 'ГБ'],
        bot_help: 'Пришлите ссылку на файл с игрой (mega, gofile, pixeldrain…) — и я скачаю её в библиотеку через MyJDownloader.',
        dl_started: (title) => `Качаю: <b>${esc(title)}</b>. Скажу, когда игра будет в библиотеке.`,
        dl_already: (title) => `Уже качаю: <b>${esc(title)}</b>.`,
        dl_off: 'MyJDownloader не подключён — «Настройки → Загрузки» в библиотеке.',
        dl_site: 'Качаю по ссылке на файл — mega, gofile, pixeldrain и похожие файлообменники.',
        dl_failed: (error) => `Не получилось: ${esc(error)}`,
        dl_captcha: (title, site) => `<b>${esc(title)}</b>: ${esc(site)} просит капчу — решите её в MyJDownloader, жду 10 минут.`,
        dl_stopped: (title, why) => `<b>${esc(title)}</b>: ${why}`,
        dl_why: {
            none: 'по ссылке нет архива игры для ПК — выберите файл в JDownloader сами',
            empty: 'JDownloader не нашёл по ссылке ни одного файла',
            volumes: 'игра выложена частями — выберите файлы в JDownloader сами',
            captcha: 'капчу не решили за 10 минут — пришлите ссылку ещё раз',
            stale: 'сервер перезапускался — пришлите ссылку ещё раз',
        },
    },
    en: {
        added: (title) => `Game added: <b>${esc(title)}</b>`,
        updated: (title, version) => `Game updated: <b>${esc(title)}</b>${version ? ` — version ${esc(version)}` : ''}`,
        patched: (title) => `Patch installed: <b>${esc(title)}</b>`,
        upload_error: (name, error) => `Upload of “${esc(name)}” failed: ${esc(error)}`,
        upload_password: (name) => `“${esc(name)}” is password-protected — enter the password in the library`,
        backup: (games, saves, size) => `Library backup: ${games} games, saves of ${saves}. ${size}`,
        backup_locked: ' The archive is locked with BACKUP_PASSWORD.',
        backup_failed: (error) => `The library backup was not sent: ${esc(error)}`,
        backup_big: (size) => `The library backup is ${size}, and Telegram takes up to 50 MB. Download it from the library menu`,
        disk_low: (free, games) => `${free} left on the library disk${games ? ` — about ${games} games` : ''}`,
        linked: (list) => `The library is connected. I will send: ${list}. What to send — in the library menu, “Telegram”.`,
        test: 'Connection check — everything works.',
        kinds: {
            uploads: 'finished uploads when the page is closed',
            backup: 'a backup of the database and saves once a day, if something changed', problems: 'server problems',
        },
        open: 'Open the library',
        units: ['MB', 'GB'],
        bot_help: 'Send me a link to a game file (mega, gofile, pixeldrain…) and I will download it into the library through MyJDownloader.',
        dl_started: (title) => `Downloading: <b>${esc(title)}</b>. I will tell you when it is in the library.`,
        dl_already: (title) => `Already downloading: <b>${esc(title)}</b>.`,
        dl_off: 'MyJDownloader is not connected — Settings → Downloads in the library.',
        dl_site: 'I download from a file link — mega, gofile, pixeldrain and similar file hosts.',
        dl_failed: (error) => `It did not work: ${esc(error)}`,
        dl_captcha: (title, site) => `<b>${esc(title)}</b>: ${esc(site)} asks for a captcha — solve it in MyJDownloader, I wait 10 minutes.`,
        dl_stopped: (title, why) => `<b>${esc(title)}</b>: ${why}`,
        dl_why: {
            none: 'there is no PC archive of the game behind the link — pick the file in JDownloader yourself',
            empty: 'JDownloader found no files behind the link',
            volumes: 'the game is posted in parts — pick the files in JDownloader yourself',
            captcha: 'the captcha was not solved in 10 minutes — send the link again',
            stale: 'the server restarted — send the link again',
        },
    },
    de: {
        added: (title) => `Spiel hinzugefügt: <b>${esc(title)}</b>`,
        updated: (title, version) => `Spiel aktualisiert: <b>${esc(title)}</b>${version ? ` — Version ${esc(version)}` : ''}`,
        patched: (title) => `Patch installiert: <b>${esc(title)}</b>`,
        upload_error: (name, error) => `Hochladen von „${esc(name)}“ fehlgeschlagen: ${esc(error)}`,
        upload_password: (name) => `„${esc(name)}“ ist passwortgeschützt — Passwort in der Bibliothek eingeben`,
        backup: (games, saves, size) => `Sicherung der Bibliothek: ${games} Spiele, Spielstände von ${saves}. ${size}`,
        backup_locked: ' Das Archiv ist mit BACKUP_PASSWORD verschlüsselt.',
        backup_failed: (error) => `Die Sicherung wurde nicht gesendet: ${esc(error)}`,
        backup_big: (size) => `Die Sicherung ist ${size} groß, Telegram nimmt bis 50 MB. Lade sie im Menü der Bibliothek herunter`,
        disk_low: (free, games) => `Auf der Platte der Bibliothek sind noch ${free} frei${games ? ` — etwa für ${games} Spiele` : ''}`,
        linked: (list) => `Die Bibliothek ist verbunden. Ich schicke: ${list}. Was geschickt wird — im Menü der Bibliothek, „Telegram“.`,
        test: 'Verbindungstest — alles funktioniert.',
        kinds: {
            uploads: 'fertige Uploads, wenn die Seite zu ist',
            backup: 'einmal am Tag eine Sicherung von Datenbank und Spielständen, wenn sich etwas geändert hat', problems: 'Serverprobleme',
        },
        open: 'Bibliothek öffnen',
        units: ['MB', 'GB'],
        bot_help: 'Schick mir einen Link zu einer Spieldatei (mega, gofile, pixeldrain…) und ich lade sie über MyJDownloader in die Bibliothek.',
        dl_started: (title) => `Lade herunter: <b>${esc(title)}</b>. Ich sage Bescheid, wenn es in der Bibliothek ist.`,
        dl_already: (title) => `Lade schon: <b>${esc(title)}</b>.`,
        dl_off: 'MyJDownloader ist nicht verbunden — Einstellungen → Downloads in der Bibliothek.',
        dl_site: 'Ich lade über einen Dateilink — mega, gofile, pixeldrain und ähnliche Hoster.',
        dl_failed: (error) => `Hat nicht geklappt: ${esc(error)}`,
        dl_captcha: (title, site) => `<b>${esc(title)}</b>: ${esc(site)} will ein Captcha — löse es in MyJDownloader, ich warte 10 Minuten.`,
        dl_stopped: (title, why) => `<b>${esc(title)}</b>: ${why}`,
        dl_why: {
            none: 'unter dem Link gibt es kein PC-Archiv des Spiels — wähle die Datei in JDownloader selbst',
            empty: 'JDownloader hat unter dem Link keine Datei gefunden',
            volumes: 'das Spiel ist in Teilen hochgeladen — wähle die Dateien in JDownloader selbst',
            captcha: 'das Captcha wurde nicht in 10 Minuten gelöst — schick den Link noch einmal',
            stale: 'der Server wurde neu gestartet — schick den Link noch einmal',
        },
    },
};

class TelegramService {
    constructor() {
        this.tokenOverride = null;   // тесты подставляют свой
        this.envChat = process.env.TELEGRAM_CHAT_ID || '';
        this.fetch = (...args) => fetch(...args);
        this.db = null;
        this.buildBackup = null;
        this.tmpDir = '';
        this.gamesDir = '';
        this.savesDir = '';
        this.pending = null;          // { code, expires } — ждём «/start <код>»
        this.offset = 0;
        this.polling = false;
        this.botName = '';
        this.sent = [];               // когда отправлены сообщения за последний час
        this.queue = Promise.resolve();
        this.gapMs = 1100;            // Telegram просит не чаще сообщения в секунду в один чат
        this.download = null;         // ({ url }) → { title } — «Загрузить» (services/downloads.js)
        this.pollError = '';
    }

    setDependencies({ db, buildBackup, tmpDir, gamesDir, savesDir, download }) {
        Object.assign(this, { db, buildBackup, tmpDir, gamesDir, savesDir });
        if (download) this.download = download;
    }

    sql() { return this.db.get(); }

    async getJson(key, fallback) {
        const row = await this.sql().get('SELECT value FROM settings WHERE key = ?', [key]);
        try { return row ? JSON.parse(row.value) : fallback; } catch { return fallback; }
    }

    async setJson(key, value) {
        if (value == null) return this.sql().run('DELETE FROM settings WHERE key = ?', [key]);
        return this.sql().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
    }

    async chat() {
        if (this.envChat) return { id: this.envChat, name: '', fromEnv: true };
        return this.getJson('telegram_chat', null);
    }

    async prefs() {
        const saved = await this.getJson('telegram_prefs', {});
        const out = { lang: 'ru', library: '' };
        for (const kind of KINDS) out[kind] = saved[kind] !== false;
        if (TEXT[saved.lang]) out.lang = saved.lang;
        if (/^https?:\/\/[^\s"<>]+$/.test(saved.library || '')) out.library = saved.library;
        return out;
    }

    async texts() { return TEXT[(await this.prefs()).lang]; }

    size(bytes, t, lang) {
        const big = bytes >= GB;
        const n = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(bytes / (big ? GB : MB));
        return `${n} ${t.units[big ? 1 : 0]}`;
    }

    // Запрос к Bot API. Токен — в адресе запроса, поэтому ни адрес, ни запрос целиком в журнал не пишем
    async api(method, params = {}, { timeoutMs = 20e3, form = null } = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await this.fetch(`${API}/bot${this.token}/${method}`, form
                ? { method: 'POST', body: form, signal: ctrl.signal }
                : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: ctrl.signal });
            const data = await res.json().catch(() => ({}));
            if (!data.ok) {
                throw Object.assign(new Error(data.description || `Telegram: HTTP ${res.status}`), {
                    status: res.status, retryAfter: Number(data.parameters?.retry_after) || 0,
                });
            }
            return data.result;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('Telegram не ответил');
            if (e.status) throw e;
            throw new Error(`нет связи с Telegram (${e.cause?.code || e.message})`);
        } finally {
            clearTimeout(timer);
        }
    }

    // Токен бота — из .env или из «Настроек» (utils/secrets.js)
    get token() { return this.tokenOverride ?? secret('telegram'); }
    set token(value) { this.tokenOverride = value; }

    // Подходит ли токен: Telegram знает такого бота. { ok, bot } или null — Telegram не ответил
    async checkToken(token) {
        let res;
        try {
            res = await this.fetch(`${API}/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) });
        } catch (e) {
            return null;
        }
        if (res.status === 401 || res.status === 404) return { ok: false };
        const data = await res.json().catch(() => null);
        return data?.ok ? { ok: true, bot: data.result?.username || '' } : null;
    }

    // Токен сменили в «Настройках»: прежнее имя бота и ожидание кода — от другого бота
    tokenChanged() {
        this.botName = '';
        this.pending = null;
        // Номера сообщений у каждого бота свои: с номером прежнего новый молчал бы, пока его номера не дорастут
        this.offset = 0;
        this.offsetLoaded = true;
        this.setJson('telegram_offset', null).catch(() => {});
    }

    async me() {
        if (!this.botName) this.botName = (await this.api('getMe')).username || '';
        return this.botName;
    }

    // Сообщения — по одному, с паузой. Слишком часто — Telegram отвечает 429 и говорит, сколько ждать
    enqueue(job) {
        const run = this.queue.then(async () => {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await job();
                } catch (e) {
                    if (e.status === 429 && attempt < 2) { await sleep((e.retryAfter || 5) * 1000); continue; }
                    throw e;
                } finally {
                    await sleep(this.gapMs);
                }
            }
        });
        this.queue = run.catch(() => {});
        return run;
    }

    // Отправить, если чат привязан и этот вид сообщений не выключен. service — служебные (проверка,
    // привязка, копия по кнопке): их шлём всегда и без счёта. Возвращает, ушло ли сообщение
    async deliver(kind, text, { silent = true, document = null } = {}) {
        if (!this.token) return false;
        const chat = await this.chat();
        if (!chat) return false;
        if (kind !== 'service') {
            if ((await this.prefs())[kind] === false) return false;
            const now = Date.now();
            this.sent = this.sent.filter((at) => now - at < HOUR);
            if (kind !== 'problems' && this.sent.length >= PER_HOUR) {
                console.log(`[Telegram] Пропущено (${kind}): за час уже ${PER_HOUR} сообщений`);
                return false;
            }
            this.sent.push(now);
        }
        await this.enqueue(async () => {
            if (!document) {
                return this.api('sendMessage', {
                    chat_id: chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: silent,
                });
            }
            const form = new FormData();
            form.append('chat_id', String(chat.id));
            form.append('caption', text);
            form.append('parse_mode', 'HTML');
            form.append('disable_notification', String(silent));
            form.append('document', await fs.openAsBlob(document.file), document.name);
            return this.api('sendDocument', {}, { form, timeoutMs: 5 * 60e3 });
        });
        return true;
    }

    async libraryLine(t) {
        const { library } = await this.prefs();
        return library ? `\n${link(t.open, library)}` : '';
    }

    // Одна и та же проблема — не чаще раза в сутки
    async problemOnce(key, text) {
        const state = await this.getJson('telegram_problems', {});
        if (state[key] && Date.now() - state[key] < 24 * HOUR) return false;
        const ok = await this.deliver('problems', text, { silent: false }).catch((e) => {
            console.error('[Telegram]', e.message);
            return false;
        });
        if (ok) await this.setJson('telegram_problems', { ...state, [key]: Date.now() });
        return ok;
    }

    // --- Привязка чата ---

    async status() {
        if (!this.token) return { configured: false };
        let bot = '';
        let error = '';
        try { bot = await this.me(); } catch (e) { error = e.message; }
        const chat = await this.chat();
        const pending = this.pending && Date.now() < this.pending.expires && bot
            ? { code: this.pending.code, url: `https://t.me/${bot}?start=${this.pending.code}` }
            : null;
        return {
            configured: true, bot, error, pending,
            linked: chat ? { name: chat.name || '', fromEnv: !!chat.fromEnv } : null,
            prefs: await this.prefs(),
            backupAt: (await this.getJson('telegram_backup', {})).at || 0,
        };
    }

    async startLink({ lang, library } = {}) {
        if (!this.token) throw Object.assign(new Error('Бот не настроен: впишите токен в «Настройки → Уведомления»'), { status: 400 });
        await this.me();
        await this.savePrefs({ lang, library });
        this.pending = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + LINK_TTL };
        this.poll().catch((e) => console.error('[Telegram]', e.message));
        return this.status();
    }

    // Слушаем чат. Пока ждём привязку — «/start <код>» (или просто код) от кого угодно: так чат и находится. Привязан и
    // «Загрузить» подключено — сообщения только из этого чата; чужие пропускаем молча
    async poll() {
        if (this.polling) return;
        this.polling = true;
        try {
            if (!this.offsetLoaded) {
                // Подтверждённое до перезапуска не придёт второй раз: иначе одна ссылка скачалась бы дважды
                this.offset = Number(await this.getJson('telegram_offset', 0)) || 0;
                this.offsetLoaded = true;
            }
            for (;;) {
                const waiting = this.pending && Date.now() < this.pending.expires;
                const chat = this.download ? await this.chat() : null;
                if (!this.token || (!waiting && !chat)) break;
                let updates;
                try {
                    updates = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, { timeoutMs: 40e3 });
                } catch (e) {
                    // 409 — этого бота уже слушает другой сервер (вторая копия библиотеки с тем же токеном) или у него webhook:
                    // сообщения достаются то одному, то другому — говорим об этом в журнал раз в час, а не только первый раз
                    if (this.pollError !== e.message || Date.now() - (this.pollErrorAt || 0) > HOUR) {
                        console.error('[Telegram] Чат:', e.message, e.status === 409 ? '— этого бота слушает ещё один сервер или у него webhook' : '');
                        this.pollErrorAt = Date.now();
                    }
                    this.pollError = e.message;
                    await sleep(e.status === 409 ? 60e3 : 5000);
                    continue;
                }
                this.pollError = '';
                for (const u of updates) {
                    this.offset = u.update_id + 1;
                    await this.onUpdate(u, chat).catch((e) => console.error('[Telegram]', e.message));
                }
                if (updates.length) await this.setJson('telegram_offset', this.offset);
            }
        } finally {
            this.polling = false;
            if (this.pending && Date.now() >= this.pending.expires) this.pending = null;
        }
    }

    async onUpdate(u, chat) {
        const m = u.message;
        if (m?.chat?.type === 'private' && this.pending) {
            const code = String(m.text || '').trim().replace(/^\/start\s*/i, '');
            if (code === this.pending.code) return this.bind(m.chat);
        }
        if (!chat || !this.download) return;
        if (!m || String(m.chat?.id) !== String(chat.id)) return;
        // Ссылка — текстом или под словом (так её шлёт «Поделиться» из браузера)
        const entities = [...(m.entities || []), ...(m.caption_entities || [])].filter((e) => e.type === 'text_link').map((e) => e.url);
        const links = [...new Set([...(String(m.text || m.caption || '').match(/https?:\/\/[^\s<>"]+/g) || []), ...entities])].slice(0, 5);
        if (!links.length) return this.deliver('service', (await this.texts()).bot_help);
        for (const url of links) await this.startDownload({ url });
    }

    async startDownload(what) {
        const t = await this.texts();
        let text;
        try {
            const r = await this.download(what);
            text = r.already ? t.dl_already(r.title) : t.dl_started(r.title);
        } catch (e) {
            text = e.reason === 'off' ? t.dl_off : e.reason === 'site' ? t.dl_site : t.dl_failed(e.message);
        }
        await this.deliver('service', text);
    }

    // Загрузка, начатая отсюда, встала на сборе ссылок (services/myjd.js, onStage): капча или ошибка
    async downloadStage(job) {
        const t = await this.texts();
        const text = job.stage === 'captcha' ? t.dl_captcha(job.title, job.captcha || '?')
            : t.dl_stopped(job.title, t.dl_why[job.error] || esc(job.error || ''));
        await this.deliver('service', text, { silent: job.stage !== 'captcha' });
    }

    async bind(chat) {
        this.pending = null;
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') + (chat.username ? ` (@${chat.username})` : '');
        await this.setJson('telegram_chat', { id: chat.id, name: name.trim() });
        console.log('[Telegram] Чат привязан');
        const t = await this.texts();
        const prefs = await this.prefs();
        const list = KINDS.filter((k) => prefs[k]).map((k) => t.kinds[k]).join('; ');
        await this.deliver('service', t.linked(list || '—')).catch((e) => console.error('[Telegram]', e.message));
        getIo()?.emit('telegram-changed');
    }

    async unlink() {
        this.pending = null;
        await this.setJson('telegram_chat', null);
        getIo()?.emit('telegram-changed');
    }

    async savePrefs(changes = {}) {
        const prefs = await this.prefs();
        for (const kind of KINDS) if (typeof changes[kind] === 'boolean') prefs[kind] = changes[kind];
        if (TEXT[changes.lang]) prefs.lang = changes.lang;
        if (typeof changes.library === 'string' && /^https?:\/\/[^\s"<>]+$/.test(changes.library)) prefs.library = changes.library.replace(/\/+$/, '/');
        await this.setJson('telegram_prefs', prefs);
        return prefs;
    }

    async test() {
        const t = await this.texts();
        if (!(await this.deliver('service', t.test + (await this.libraryLine(t))))) {
            throw Object.assign(new Error('Чат не привязан'), { status: 400 });
        }
    }

    // --- Загрузки ---

    // Загрузка кончилась, а страницы с ней никто не смотрел (services/uploads.js)
    async uploadFinished({ name, state, error, folder, target, mode, version, unattended }) {
        if (!unattended || !this.token) return;
        const t = await this.texts();
        const id = folder || target;
        const row = id ? await this.sql().get('SELECT id, title, link, meta_locked FROM games WHERE id = ?', [id]) : null;
        const title = row ? shownTitle(row).title : id;
        let text;
        let silent = true;
        if (state === 'done') text = mode === 'patch' ? t.patched(title) : target ? t.updated(title, version) : t.added(title);
        else if (state === 'password') { text = t.upload_password(name); silent = false; }
        else { text = t.upload_error(name, error || ''); silent = false; }
        await this.deliver('uploads', text + (await this.libraryLine(t)), { silent });
    }

    // --- Раз в час: место на диске и копия ---

    // Часы идут всегда: токен могут вписать в «Настройках» и позже. Без токена и чата проверки молчат
    start() {
        // Слушать чат — при каждом вызове: токен вписали или сменили в «Настройках» (server.js)
        this.poll().catch((e) => console.error('[Telegram]', e.message));
        if (this.started) return;
        this.started = true;
        const tick = () => {
            if (!this.token) return;
            this.checkDisk().catch((e) => console.error('[Telegram] Диск:', e.message));
            this.checkBackup().catch((e) => console.error('[Telegram] Копия:', e.message));
        };
        setTimeout(tick, 2 * 60e3).unref();
        setInterval(tick, HOUR).unref();
    }

    // Меньше порога («Настройки → Уведомления» или DISK_WARN_GB, 10 ГБ) — сообщаем. Снова — только если стало меньше ещё на 5 ГБ;
    // освободилось больше чем на 5 ГБ сверх порога — забываем, что предупреждали
    async checkDisk() {
        if (!(await this.chat())) return;
        const st = await fsp.statfs(this.gamesDir);
        const free = st.bavail * st.bsize;
        const limit = option('disk_warn_gb') * GB;
        const state = await this.getJson('telegram_disk', {});
        if (free >= limit + 5 * GB) {
            if (state.warnedFree) await this.setJson('telegram_disk', null);
            return;
        }
        if (free >= limit || (state.warnedFree && free > state.warnedFree - 5 * GB)) return;
        const avg = (await this.sql().get('SELECT AVG(size) AS a FROM games WHERE size > 0'))?.a || 0;
        const t = await this.texts();
        const { lang } = await this.prefs();
        if (await this.deliver('problems', t.disk_low(this.size(free, t, lang), avg ? Math.floor(free / avg) : 0), { silent: false })) {
            await this.setJson('telegram_disk', { warnedFree: free });
        }
    }

    // Отпечаток того, что человек не скачает заново: его данные об играх, список «Хочу поиграть» и
    // сейвы (имя, размер, время файла). Найденное поиском сюда не входит — само по себе копию не шлёт
    async changeMark() {
        const h = crypto.createHash('sha1');
        h.update(JSON.stringify(await this.sql().all(
            'SELECT id, title, status, rating, link, my_version, meta_locked, lastPlayed, playtime FROM games ORDER BY id'
        )));
        h.update(JSON.stringify(await this.sql().all('SELECT key FROM wishlist ORDER BY key')));
        const dirs = (await fsp.readdir(this.savesDir).catch(() => [])).filter((n) => !n.startsWith('.')).sort();
        for (const dir of dirs) {
            for (const f of (await fsp.readdir(path.join(this.savesDir, dir)).catch(() => [])).sort()) {
                const st = await fsp.stat(path.join(this.savesDir, dir, f)).catch(() => null);
                if (st?.isFile()) h.update(`${dir}/${f}:${st.size}:${Math.round(st.mtimeMs)}\n`);
            }
        }
        return h.digest('hex');
    }

    // Копия базы и сейвов в чат — беззвучно. Сама: не чаще раза в 20 часов и только если что-то
    // изменилось с прошлой. force — кнопка «Отправить копию сейчас»
    async checkBackup({ force = false } = {}) {
        if (!this.token || !(await this.chat())) return { sent: false };
        const prefs = await this.prefs();
        const state = await this.getJson('telegram_backup', {});
        const mark = await this.changeMark();
        if (!force && (!prefs.backup || state.mark === mark || (state.at && Date.now() - state.at < 20 * HOUR))) return { sent: false };
        const t = TEXT[prefs.lang];
        const dir = await fsp.mkdtemp(path.join(this.tmpDir, 'tg_backup_'));
        try {
            const password = secret('backup');
            const b = await this.buildBackup(dir, { password });
            if (b.size > 49 * MB) {
                await this.problemOnce('backup_big', t.backup_big(this.size(b.size, t, prefs.lang)));
                return { sent: false };
            }
            const caption = t.backup(b.games, b.saves, this.size(b.size, t, prefs.lang)) + (password ? t.backup_locked : '');
            const sent = await this.deliver(force ? 'service' : 'backup', caption, { document: { file: b.file, name: b.name } });
            if (sent) {
                await this.setJson('telegram_backup', { at: Date.now(), mark });
                console.log(`[Telegram] Копия отправлена: ${b.name}, ${Math.round(b.size / 1024)} КБ`);
            }
            return { sent };
        } catch (e) {
            await this.problemOnce('backup_failed', t.backup_failed(e.message));
            throw e;
        } finally {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

module.exports = new TelegramService();
module.exports.TelegramService = TelegramService;
module.exports.KINDS = KINDS;
