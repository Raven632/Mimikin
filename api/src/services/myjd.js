const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const { secret } = require('../utils/secrets.js');
const { ARCHIVE, VOLUME, setOf } = require('./inbox.js');

// «Загрузить» по ссылке: ссылка на файлообменник уходит в JDownloader человека через MyJDownloader (api.jdownloader.org).
// Страницу файлообменника JDownloader открывает сам, со своего сервера: наш сервер на файлообменники не ходит.
// Ссылка — в «Захват ссылок» без автостарта и без распаковки; собрал —
// на скачивание идёт только архив самой игры (pick), остальное убираем. Зеркала одного файла JDownloader скачивает один раз.
// Скачанный архив кладётся во «Входящие» (папка назначения), дальше его берёт библиотека (services/inbox.js).
// Протокол MyJDownloader: запросы подписаны HMAC-SHA256, ответы и запросы к устройству зашифрованы AES-128-CBC ключами
// из почты и пароля (как в официальной библиотеке myjdapi)
const API = 'https://api.jdownloader.org';
const APP_KEY = 'Mimikin';
const COLLECT_MS = 90 * 1000;
// Сбор встал на капче — ждём, пока её решат в MyJDownloader (с телефона — минута-другая), и собираем дальше сами
const CAPTCHA_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
// Ход загрузки (окно игры, обложка в «Новинках», список в шапке) помним сутки после конца
const KEEP_MS = 24 * 60 * 60 * 1000;
// Список закачек у JDownloader спрашиваем не чаще: страницу опрашивают раз в 4 с, окон может быть несколько
const JD_CACHE_MS = 3000;
// Столько архив может идти во «Входящие» после того, как JDownloader его скачал; дольше — «не приходит», с подсказкой
const STUCK_MS = 15 * 60 * 1000;
const sameFolder = (a, b) => String(a || '').replace(/[\\/]+$/, '') === String(b || '').replace(/[\\/]+$/, '');
// Сборки не для ПК — не качаем. Сама игра на RPG Maker MV/MZ идёт в браузере из сборки Win/Linux. Слово — между
// не-буквами и не-цифрами: «Game_mac.zip» — Mac, «Machine» — нет
const NOT_PC = /(?<![a-z0-9])(?:mac|macos|osx|android)(?![a-z0-9])|\.(?:apk|dmg)$/i;
const LINUX = /(?<![a-z0-9])linux(?![a-z0-9])/i;
const words = (s) => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))))).digest();
const secretOf = (email, password, domain) => sha256(email.toLowerCase() + password + domain.toLowerCase());
const sign = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
const encrypt = (token, text) => {
    const c = crypto.createCipheriv('aes-128-cbc', token.subarray(16, 32), token.subarray(0, 16));
    return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
};
const decrypt = (token, b64) => {
    const d = crypto.createDecipheriv('aes-128-cbc', token.subarray(16, 32), token.subarray(0, 16));
    return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
};

// Вход из «Настроек» (utils/secrets.js, myjd): JSON { email, loginSecret, deviceSecret, device, folder } — без пароля,
// только суммы, которые из него считает протокол. Из .env (MYJD_LOGIN) можно и с паролем: { email, password, … }
function login() {
    try {
        const v = JSON.parse(secret('myjd') || 'null');
        return v?.email && (v?.password || v?.loginSecret) ? linked({ device: 'server', folder: '', ...v }) : null;
    } catch { return null; }
}

// Связанная установка (services/relay.js) качает в свою подпапку «.<номер>» папки «Входящие» JDownloader: своей, а
// не задана — той установки. Где лягут архивы, разберётся relay
function linked(acc) {
    const link = JSON.parse(secret('pair') || 'null');
    const base = String(acc.folder || link?.folder || '').replace(/[\\/]+$/, '');
    // Связь — та же, что видит relay (link()): без адреса и ключей её нет, и качаем как без неё
    if (!/^[0-9a-f]{8}$/.test(link?.self) || !link.url || !link.keyIn || !link.keyOut || !base) return acc;
    return { ...acc, folder: `${base}${base.includes('\\') && !base.includes('/') ? '\\' : '/'}.${link.self}` };
}

const fail = (reason, message) => Object.assign(new Error(message), { reason });
// Чей вход у общей сессии: сменили почту, пароль или устройство — входим заново
const loginKey = (acc) => `${acc.email}\n${acc.loginSecret || acc.password}\n${acc.device}`;

// Отказ MyJDownloader приходит открытым JSON { src, type } — с кодом 500 и для неверной почты. Понятными словами;
// неверная почта или пароль — «не пустил» (login), а не «не ответил»
const REFUSED = {
    EMAIL_INVALID: 'MyJDownloader не знает такую почту — проверьте адрес',
    AUTH_FAILED: 'MyJDownloader не пустил: неверный пароль',
    EMAIL_FORBIDDEN: 'MyJDownloader не пустил эту почту',
    TOO_MANY_REQUESTS: 'MyJDownloader просит подождать: слишком много запросов',
};
function refusal(status, text) {
    let type = '';
    try { type = JSON.parse(text)?.type || ''; } catch { /* не JSON */ }
    if (REFUSED[type]) return Object.assign(fail(type === 'TOO_MANY_REQUESTS' ? 'site' : 'login', REFUSED[type]), { type });
    return fail(status === 403 ? 'login' : 'site', `MyJDownloader ответил ${status}${type ? ` (${type})` : ''}`);
}

class MyJdService {
    constructor() {
        this.api = API;
        this.session = null;
        this.rid = Date.now();
        this.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        this.fetch = (...args) => fetch(...args);
        this.file = '';
        this.uploads = null;
        this.inbox = null;
        this.jobs = null;
        this.writing = Promise.resolve();
        this.runs = new Map();   // идущие в фоне сборы: key → promise (тесты ждут их)
        this.captchaWaitMs = CAPTCHA_WAIT_MS;
    }

    // file — где помнить загрузки (без него — только в памяти, для тестов); uploads и inbox — чтобы видеть, дошёл ли архив
    // seedbox, relay — чей архив Mimikin сейчас забирает сам, с seedbox (services/seedbox.js) или с главной установки
    // (services/relay.js): перенос с байтами
    setDependencies({ file, uploads, inbox, seedbox, relay = null }) {
        Object.assign(this, { file, uploads, inbox, seedbox, relay });
    }

    nextRid() { this.rid += 1; return this.rid; }

    // Запрос к самому MyJDownloader (вход, список устройств): подпись токеном, ответ — тем же ключом
    async server(path, params, token) {
        const rid = this.nextRid();
        const query = `${path}?${[...Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`), `rid=${rid}`].join('&')}`;
        const res = await this.fetch(`${this.api}${query}&signature=${sign(token, query)}`, { signal: AbortSignal.timeout(30000) });
        const text = await res.text();
        if (!res.ok) throw refusal(res.status, text);
        return JSON.parse(decrypt(token, text));
    }

    // Вход и устройство. Сессия становится общей только целиком: при «нет устройства» прежняя не ломается. Два запроса
    // во время входа ждут один и тот же вход
    connect(acc) {
        const key = loginKey(acc);
        if (this.connecting?.key !== key) {
            const promise = this.login(acc, key).then((session) => { this.session = session; return session; })
                .finally(() => { if (this.connecting?.promise === promise) this.connecting = null; });
            this.connecting = { key, promise };
        }
        return this.connecting.promise;
    }

    async login(acc, key) {
        const loginSecret = acc.loginSecret ? Buffer.from(acc.loginSecret, 'hex') : secretOf(acc.email, acc.password, 'server');
        const deviceSecret = acc.deviceSecret ? Buffer.from(acc.deviceSecret, 'hex') : secretOf(acc.email, acc.password, 'device');
        const r = await this.server('/my/connect', { email: acc.email.toLowerCase(), appkey: APP_KEY }, loginSecret);
        const token = Buffer.from(r.sessiontoken, 'hex');
        const serverToken = sha256(loginSecret, token);
        const devices = (await this.server('/my/listdevices', { sessiontoken: r.sessiontoken }, serverToken)).list || [];
        const device = devices.find((d) => String(d.name).toLowerCase() === String(acc.device).toLowerCase());
        if (!device) throw fail('device', `В MyJDownloader нет устройства «${acc.device}»: ${devices.map((d) => d.name).join(', ') || 'ни одного'}`);
        return { key, token: r.sessiontoken, serverToken, deviceToken: sha256(deviceSecret, token), deviceId: device.id };
    }

    // Действие на устройстве: запрос и ответ зашифрованы ключом устройства. Сессия протухла — входим заново один раз
    async call(acc, action, params = [], retried = false) {
        const s = this.session?.key === loginKey(acc) ? this.session : await this.connect(acc);
        // Параметры — строками JSON, а списки — как есть (так их ждёт JDownloader, см. myjdapi)
        const body = encrypt(s.deviceToken, JSON.stringify({ url: action, params: params.map((p) => (Array.isArray(p) ? p : JSON.stringify(p))), rid: this.nextRid(), apiVer: 1 }));
        const res = await this.fetch(`${this.api}/t_${s.token}_${s.deviceId}${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/aesjson-jd; charset=utf-8' }, body, signal: AbortSignal.timeout(30000),
        });
        const text = await res.text();
        if (res.status === 403 && !retried) { if (this.session === s) this.session = null; return this.call(acc, action, params, true); }
        if (!res.ok) throw fail('device', `JDownloader ответил ${res.status}${res.status === 503 ? ': устройство не в сети' : ''}`);
        let reply = null;
        try { reply = JSON.parse(decrypt(s.deviceToken, text)); } catch { /* ниже */ }
        if (!reply || !('data' in reply)) throw fail('device', `JDownloader ответил непонятно на ${action}`);
        return reply.data;
    }

    // Проверка из «Настроек»: вход и устройство. { ok: true } | { ok: false } (не пустил) | null (не ответил)
    // Своим отдельным клиентом: проверка ещё не сохранённого входа не трогает сессию идущей отправки
    async check(raw) {
        let acc;
        try { acc = linked({ device: 'server', ...JSON.parse(raw) }); } catch { return { ok: false }; }
        const probe = new MyJdService();
        Object.assign(probe, { api: this.api, fetch: this.fetch });
        try {
            await probe.connect(acc);
            return { ok: true };
        } catch (e) {
            return e.reason === 'login' || e.reason === 'device' ? { ok: false, message: e.message, why: e.type || e.reason } : null;
        }
    }

    // «Загрузить» с запоминанием хода: key — ключ загрузки («link:…», services/downloads.js), по нему загрузку находят
    // окно игры и список в шапке.
    // Этапы: collect (сбор ссылок) → download (JDownloader качает) → transfer (скачано, ждём архив во «Входящих» —
    // его переносит не Mimikin, а rclone или сетевая папка) → import (архив у библиотеки) → done; captcha, error — встало
    // С key — в фоне: ответ сразу ({ started }), а ход — в записи загрузки (сбор длится до полутора минут, с капчей —
    // дольше: страницу закрыли или прокси оборвал долгий запрос — загрузка всё равно идёт). Без key — как раньше, ждём
    // итог (тесты, проверка руками). version — версия, заданная человеком: из нескольких архивов берём её (pick). target — игра
    // библиотеки: скачанное встанет её обновлением, а не второй копией (inbox → uploads.importFile). via — откуда
    // начали: 'tg' — из Telegram, туда и скажем, если сбор встал (onStage). Адрес и версия — в записи: «Повторить»
    // passwords — пароли архива: распаковка попробует их сама
    async send(url, title, key = '', { version = '', target = '', via = '', passwords = [] } = {}) {
        const acc = login();
        if (!acc) throw fail('off', 'MyJDownloader не настроен');
        const packageName = title || 'Mimikin';
        if (!key) return this.collect(acc, url, title, packageName, { version, passwords });
        const jobs = await this.loadJobs();
        // Уже собирает или качает (вторая вкладка, двойное нажатие, та же ссылка в Telegram ещё раз) — второй сбор
        // положил бы те же ссылки в JDownloader ещё раз, а ход загрузки пропал бы. От проверки до записи в runs — без
        // await: два запроса подряд не пройдут оба
        if (this.runs.has(key) || ['download', 'transfer', 'import'].includes(jobs.get(key)?.stage)) return { started: true, already: true };
        const started = Date.now();
        const job = { key, title, packageName, folder: acc.folder, url, version, ...(via ? { via } : {}), ...(passwords.length ? { passwords: passwords.slice(0, 5) } : {}) };
        // Запись убрали крестиком (или это уже другая загрузка) — сбор её не возвращает и не перетирает
        const track = async (patch) => {
            if ((await this.loadJobs()).get(key)?.started !== started) return;
            await this.saveJob({ ...job, ...patch });
            // Готовое скажет сама библиотека (uploads → «Игра добавлена»), а вставшее на сборе — только мы
            if (via && ['captcha', 'error'].includes(patch.stage)) {
                Promise.resolve(this.onStage?.({ ...job, ...patch, target })).catch((e) => console.error('[MyJDownloader]', e.message));
            }
        };
        // Новое нажатие — запись заново: старые ошибка, капча и игра не тянутся из прошлого раза.
        // Сбор занят сразу, до первой записи: иначе два запроса подряд оба прошли бы проверку выше
        const first = (async () => {
            jobs.delete(key);
            await this.saveJob({ ...job, stage: 'collect', names: [], started, ...(target ? { target } : {}) });
        })();
        const run = first.then(() => this.collect(acc, url, title, packageName, {
            version,
            passwords,
            // Капча — этап «ждёт капчу»; решили — снова «сбор ссылок»
            onCaptcha: (site) => track(site ? { stage: 'captcha', captcha: site } : { stage: 'collect', captcha: '' }),
        })).then((r) => track(r.captcha ? { stage: 'error', error: 'captcha', captcha: r.captcha }
            : r.sent ? { stage: 'download', names: r.names }
                : { stage: 'error', error: r.volumes ? 'volumes' : r.found ? 'none' : 'empty' }),
        (e) => {
            console.error('[MyJDownloader]', e.message);
            return track({ stage: 'error', error: e.message });
        });
        this.runs.set(key, run);
        run.finally(() => { if (this.runs.get(key) === run) this.runs.delete(key); }).catch(() => {});
        await first;
        return { started: true };
    }

    // Скачанный архив с этим именем — что о нём знает загрузка (inbox спрашивает перед тем, как взять архив): игра
    // библиотеки, которую он обновит, версия (в имени архива её бывает и нет), пароли архива.
    // { target, version, passwords } или null
    async targetFor(name) {
        const n = String(name || '').normalize('NFC');
        for (const j of (await this.loadJobs()).values()) {
            // Готовая уже в библиотеке: архив с тем же именем, положенный позже руками, — не её
            if (j.stage === 'done' || !(j.names || []).some((x) => x.normalize('NFC') === n)) continue;
            if (!j.target && !j.passwords?.length) continue;
            return { target: j.target || '', version: j.version || '', passwords: j.passwords || [] };
        }
        return null;
    }

    // Тома того же архива, что качает загрузка с этим томом: «Входящие» берут архив, когда легли все (services/inbox.js)
    async volumesOf(name) {
        const n = String(name || '').normalize('NFC');
        for (const j of (await this.loadJobs()).values()) {
            const names = (j.names || []).map((x) => x.normalize('NFC'));
            if (j.stage !== 'done' && names.includes(n)) return names.filter((x) => VOLUME.test(x) && setOf(x) === setOf(n));
        }
        return [];
    }

    // Вход в MyJDownloader задан
    configured() { return !!login(); }

    // «Повторить» у вставшей загрузки: то же, что и в первый раз. Записи до этой версии адреса не помнят
    async retry(key) {
        const job = (await this.loadJobs()).get(key);
        if (!job?.url) throw Object.assign(new Error('Эту загрузку не повторить — начните её заново'), { status: 404 });
        if (job.stage !== 'error') throw Object.assign(new Error('Загрузка ещё идёт'), { status: 409 });
        return this.send(job.url, job.title, key, { version: job.version || '', target: job.target || '', via: job.via || '', passwords: job.passwords || [] });
    }

    // Ссылку — в JDownloader, архив игры — на скачивание. { found, sent, names, partial, captcha?, volumes? }
    // onCaptcha — ждать капчу, пока её решают (до CAPTCHA_WAIT_MS); без него — сразу вернуть { captcha }
    async collect(acc, url, title, packageName, { version = '', onCaptcha = null, passwords = [] } = {}) {
        await this.call(acc, '/linkgrabberv2/addLinks', [{
            links: url, packageName, autostart: false, autoExtract: false, overwritePackagizerRules: true,
            ...(acc.folder ? { destinationFolder: acc.folder } : {}),
            // Пароль архива — и JDownloader: распаковывает он и сам (autoExtract: false
            // у него действует не всегда), а без пароля спрашивает его окном. Одна строка: больше одного он не берёт
            ...(passwords[0] ? { extractPassword: passwords[0] } : {}),
        }]);
        let links = [];
        let stable = 0;
        let waiting = 0;
        let until = Date.now() + COLLECT_MS;
        let captchaShown = false;
        // Собирает — ждём, пока число ссылок перестанет расти (раскрытие ссылок — у JDownloader).
        // Ссылки — по пакету с нашим именем: отбор по номеру задания (jobUUIDs) у настоящего JDownloader не вернул ничего.
        // Пакет с тем же именем от прошлого нажатия JDownloader дополняет — это та же игра, отбираем из всего пакета
        while (Date.now() < until && stable < 2) {
            await this.sleep(POLL_MS);
            const next = await this.packageLinks(acc, packageName);
            const collecting = await this.call(acc, '/linkgrabberv2/isCollecting');
            // Сбор встал на капче (файлообменник показывает её на защищённых ссылках). Решать её не наше дело — человек
            // решает в MyJDownloader и жмёт «Загрузить» ещё раз: пакет тот же, собранное не теряется. Ничего не
            // отправляем, чтобы не выбрать архив из половины ссылок.
            // shortcut: капча не привязана к нашей ссылке — любая во время сбора; если мешают чужие, сверять link с job
            // Висит два опроса подряд: капчу, которую JDownloader решил сам (свой решатель), за отказ не считаем
            const captcha = collecting ? await this.captcha(acc) : null;
            waiting = captcha ? waiting + 1 : 0;
            if (waiting >= 2) {
                if (!onCaptcha || (captchaShown && Date.now() >= until)) return { found: next.length, sent: 0, names: [], partial: true, captcha };
                if (!captchaShown) { captchaShown = true; until = Date.now() + this.captchaWaitMs; await onCaptcha(captcha); }
                links = next;
                continue;
            }
            if (captchaShown && !captcha) { captchaShown = false; until = Date.now() + COLLECT_MS; await onCaptcha(null); }
            stable = !collecting && next.length && next.length === links.length ? stable + 1 : 0;
            links = next;
        }
        // Не дождались — отправляем найденное, остальное JDownloader оставит в «Захвате ссылок» (partial)
        const partial = stable < 2;
        if (!links.length) return { found: 0, sent: 0, names: [], partial };
        const keep = pick(links, title, version);
        // Архива игры не нашлось (только .exe, только для Mac) — ничего не убираем: человек выберет в JDownloader сам
        const drop = keep.length ? links.filter((l) => !keep.includes(l)) : [];
        // Есть только архив по частям: «Входящие» его не примут (по тому не распаковать) — так и скажем
        const volumes = !keep.length && links.some((l) => l.availability !== 'OFFLINE' && VOLUME.test(l.name || ''));
        if (drop.length) await this.call(acc, '/linkgrabberv2/removeLinks', [drop.map((l) => l.uuid), []]);
        const names = [...new Set(keep.map((l) => l.name))];
        if (keep.length) {
            await this.call(acc, '/linkgrabberv2/moveToDownloadlist', [keep.map((l) => l.uuid), []]);
            await this.call(acc, '/downloadcontroller/start');
        }
        // sent — файлы, а не ссылки: четыре зеркала одного архива — один файл
        return { found: links.length, sent: names.length, names, partial, ...(volumes ? { volumes: true } : {}) };
    }

    // Сайт, который ждёт капчу, или null. Старый JDownloader без /captcha — как без капчи
    async captcha(acc) {
        const list = await this.call(acc, '/captcha/list').catch(() => null);
        return Array.isArray(list) && list.length ? String(list[0].hoster || '?') : null;
    }

    async packageLinks(acc, packageName) {
        const packages = (await this.call(acc, '/linkgrabberv2/queryPackages', [{ saveTo: true }])) || [];
        const ids = packages.filter((p) => p.name === packageName && (!acc.folder || sameFolder(p.saveTo, acc.folder))).map((p) => p.uuid);
        if (!ids.length) return [];
        return (await this.call(acc, '/linkgrabberv2/queryLinks', [{ packageUUIDs: ids, name: true, host: true, bytesTotal: true, availability: true }])) || [];
    }

    // --- Ход загрузок ---

    // Один разбор файла на всех: два первых запроса разом не заведут каждый свою карту
    async loadJobs() {
        this.loading ??= (async () => {
            let list = [];
            try { list = this.file ? JSON.parse(await fsp.readFile(this.file, 'utf8')) : []; } catch { /* нет файла — нет загрузок */ }
            // Сбор ссылок и ожидание капчи идут в этом процессе (send): запись с прошлого запуска — сервер
            // перезапустили посреди них, сами они уже не закончатся
            for (const j of list) if (['collect', 'captcha'].includes(j.stage)) Object.assign(j, { stage: 'error', error: 'stale' });
            this.jobs = new Map(list.map((j) => [j.key, j]));
        })();
        await this.loading;
        for (const [k, j] of this.jobs) {
            // Идущие (скачивание, перенос, распаковка) не забываем — качаться большой архив может и дольше суток;
            // зависшую человек убирает крестиком
            if (Date.now() - j.at > KEEP_MS && !['download', 'transfer', 'import'].includes(j.stage)) this.jobs.delete(k);
        }
        return this.jobs;
    }

    // Через временный файл и переименование, как метки загрузок (services/uploads.js)
    async saveJob(job) {
        const jobs = await this.loadJobs();
        jobs.set(job.key, { ...jobs.get(job.key), ...job, at: Date.now() });
        await this.persist();
    }

    async forgetJob(key) {
        if ((await this.loadJobs()).delete(key)) await this.persist();
    }

    // Записи по очереди: снимок берётся в свою очередь, и более старый не ляжет на диск после нового
    persist() {
        this.writing = this.writing.then(() => this.write()).catch((e) => console.error('[MyJDownloader] Ход загрузок не записан:', e.message));
        return this.writing;
    }

    async write() {
        if (!this.file) return;
        const jobs = await this.loadJobs();
        const tmp = `${this.file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.writeFile(tmp, JSON.stringify([...jobs.values()]));
        await fsp.rename(tmp, this.file);
    }

    // Пакеты в списке закачек JDownloader: { name, saveTo, bytesLoaded, bytesTotal, speed, eta, finished }
    jdPackages(acc) {
        if (!this.jdCache || Date.now() - this.jdCache.at > JD_CACHE_MS) {
            this.jdCache = { at: Date.now(), promise: this.call(acc, '/downloadsV2/queryPackages', [{ saveTo: true, bytesLoaded: true, bytesTotal: true, speed: true, eta: true, finished: true }]).then((r) => r || []) };
            this.jdCache.promise.catch(() => { this.jdCache = null; });
        }
        return this.jdCache.promise;
    }

    // Где сейчас загрузка. Смотрим с конца пути: метка у библиотеки (распаковывает, готово, ошибка) → архив во
    // «Входящих» → пакет у JDownloader. JDownloader не ответил — этап не меняем: качать он от этого не перестал
    async advance(job, acc) {
        const next = {};
        const names = (job.names || []).map((n) => n.normalize('NFC'));
        const moving = [this.seedbox, this.relay].map((s) => s?.state.current).find((c) => c && names.includes(c.name));
        const meta = names.length && this.uploads ? await this.uploads.inboxStatus(names, job.started || 0) : null;
        if (meta) {
            if (meta.state === 'done') Object.assign(next, { stage: 'done', game: meta.game });
            else if (meta.state === 'processing') Object.assign(next, { stage: 'import', step: meta.step });
            else Object.assign(next, { stage: 'error', error: meta.state === 'password' ? 'password' : meta.error || 'import' });
        } else if (names.length && this.inbox && await this.arrived(names, job.started || 0)) {
            Object.assign(next, { stage: 'import', step: 'settle' });
        } else if (moving) {
            Object.assign(next, { stage: 'transfer', loaded: moving.got, total: moving.total });
        } else if (job.stage === 'download' && acc) {
            const pkg = (await this.jdPackages(acc).catch(() => null))?.find((p) => p.name === job.packageName && (!job.folder || sameFolder(p.saveTo, job.folder)));
            if (pkg) {
                const done = pkg.finished || (pkg.bytesTotal > 0 && pkg.bytesLoaded >= pkg.bytesTotal);
                Object.assign(next, done ? { stage: 'transfer' } : { loaded: pkg.bytesLoaded || 0, total: pkg.bytesTotal || 0, speed: pkg.speed || 0, eta: pkg.eta > 0 ? pkg.eta : 0 });
            }
        }
        // Скачано, а во «Входящие» не приходит — подскажем, где искать: чаще всего этот JDownloader пишет во «Входящие»
        // другой установки Mimikin (их связывают «Две установки», services/relay.js) или архив лежит на seedbox
        // Отсчёт — с перехода на «Перенос»; у записи без отметки (до этой версии) — с первого опроса
        const stage = next.stage || job.stage;
        if (stage === 'transfer' && (job.stage !== 'transfer' || !job.transferAt)) next.transferAt = Date.now();
        if (stage === 'transfer' && !next.total && Date.now() - (next.transferAt || job.transferAt) > STUCK_MS) next.stuck = true;
        // Байты меняются каждый опрос — их не пишем на диск, только этапы
        const { loaded, total, speed, eta, stuck, ...lasting } = next;
        // Пока спрашивали, запись убрали или начали заново — не воскрешаем и не портим
        const jobs = await this.loadJobs();
        if (jobs.get(job.key)?.started === job.started && Object.entries(lasting).some(([k, v]) => job[k] !== v)) await this.saveJob({ key: job.key, ...lasting });
        return { ...job, ...next };
    }

    // Архив с таким именем во «Входящих», пришедший после «Загрузить» — не старый неудачный с тем же именем.
    // Архив томами — когда пришли все тома: пока JDownloader качает следующий, загрузка ещё «качается»
    async arrived(names, since) {
        const got = new Set();
        for (const f of await this.inbox.files()) {
            const name = path.basename(f).normalize('NFC');
            if (!names.includes(name)) continue;
            const st = await fsp.stat(f).catch(() => null);
            if (st && st.mtimeMs >= since - 60 * 1000) got.add(name);
        }
        return got.size > 0 && names.every((n) => got.has(n) || !VOLUME.test(n));
    }

    // Для страницы: загрузки, свежие сверху
    async downloads() {
        const acc = login();
        const jobs = [...(await this.loadJobs()).values()];
        const out = await Promise.all(jobs.map((j) => (['download', 'transfer', 'import'].includes(j.stage) ? this.advance(j, acc) : j)));
        return out.sort((a, b) => (b.started || 0) - (a.started || 0)).map(({ key, title, stage, names, captcha, error, game, step, loaded, total, speed, eta, stuck, target, url }) => (
            { key, title, stage, file: names?.[0] || '', captcha, error, game, step, loaded, total, speed, eta, stuck, target, retry: !!url }));
    }
}

// Что из собранного качать. В папке файлообменника кроме игры бывают другие игры автора, моды, ссылки на соцсети,
// битые и безымянные ссылки. Берём только архивы (кроме недоступных), которые библиотека примет (как во
// «Входящих»), и из них — с наибольшей долей слов названия в имени файла; ни одно слово не совпало (название
// по-японски) — все архивы. Сборка для Linux — только если для Windows нет. Из оставшихся — один файл: одна игра —
// один архив, иначе в библиотеке две копии (в папке Clockwork Vale лежали «…1.2.0.7z» и тот же архив «…1.2.0.7z.7z»).
// Берём без двойного расширения, на большем числе зеркал (главный архив выкладывают везде), побольше. Зеркало
// с другим размером, чем у большинства зеркал того же файла, JDownloader скачал бы второй раз (хостинг размер угадал
// или файл другой) — убираем; зеркало без размера оставляем
function pick(links, title, version = '') {
    const usable = links.filter((l) => l.availability !== 'OFFLINE' && ARCHIVE.test(l.name || '') && !NOT_PC.test(l.name));
    // Архив одним файлом — он; нет — архив томами (по 1 ГБ): все тома одного набора.
    // Набор дальше — как одно имя: зеркала, версия, размер
    const singles = usable.filter((l) => !VOLUME.test(l.name));
    const archives = singles.length ? singles : usable;
    const key = (l) => setOf(l.name);
    const want = words(title).filter((w) => w.length > 2);
    const score = (name) => {
        const have = words(name);
        return want.length ? want.filter((w) => have.some((h) => h.startsWith(w))).length / want.length : 0;
    };
    const best = Math.max(0, ...archives.map((l) => score(key(l))));
    let chosen = best ? archives.filter((l) => score(key(l)) === best) : archives;
    if (chosen.some((l) => !LINUX.test(l.name))) chosen = chosen.filter((l) => !LINUX.test(l.name));
    const mirrors = (name) => chosen.filter((l) => key(l) === name);
    const doubled = (name) => /\.(zip|7z|rar)\.(zip|7z|rar)$/i.test(name);
    const size = (name) => Math.max(0, ...mirrors(name).map((l) => l.bytesTotal || 0));
    // Версия в имени архива («1.0.9», «1_0_9») — это он; рядом бывает и прежняя версия
    const digits = String(version || '').match(/\d+(?:[._]\d+)*/)?.[0] || '';
    const ofVersion = (name) => (digits && digits.includes('.') && new RegExp(`(^|[^0-9])${digits.replace(/[._]/g, '[._]')}([^0-9]|$)`).test(name) ? 0 : 1);
    const [one] = [...new Set(chosen.map(key))]
        .sort((a, b) => doubled(a) - doubled(b) || ofVersion(a) - ofVersion(b) || mirrors(b).length - mirrors(a).length || size(b) - size(a));
    chosen = mirrors(one);
    const sizes = new Map(); // имя → размер → сколько зеркал
    for (const l of chosen.filter((m) => m.bytesTotal > 0)) {
        const of = sizes.get(l.name) || new Map();
        sizes.set(l.name, of.set(l.bytesTotal, (of.get(l.bytesTotal) || 0) + 1));
    }
    const usual = (name) => [...(sizes.get(name) || [])].sort((a, b) => b[1] - a[1])[0]?.[0];
    return chosen.filter((l) => !(l.bytesTotal > 0) || l.bytesTotal === usual(l.name));
}

module.exports = new MyJdService();
module.exports.MyJdService = MyJdService;
module.exports.cipher = { secretOf, sign, encrypt, decrypt, sha256 };
module.exports.NOT_PC = NOT_PC;
module.exports.pick = pick;
module.exports.account = login; // для тестов: с чем «Загрузить» пойдёт в MyJDownloader
