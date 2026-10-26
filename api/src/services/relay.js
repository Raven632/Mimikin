const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { secret, setSavedSecret, seal, SECRETS, myjdWithoutPassword } = require('../utils/secrets.js');
const { ARCHIVE } = require('./inbox.js');

// Две установки на одном JDownloader — без «главной» и «второй». Связывают их один раз: на одной вписывают адрес другой
// и жмут «Связать», на другой владелец жмёт «Разрешить» — установки обмениваются ключами сами. Дальше каждая качает тем
// же JDownloader в свою папку — «.<её номер>» в его папке «Входящие» (services/myjd.js, linked) — и сама смотрит, куда
// легли её архивы: к ней во «Входящие» — переносит у себя, к соседке — забирает у неё по сети (routes/relay.js, по
// ключу) и удаляет там. Папки с точкой «Входящие» не берут (services/inbox.js): чужие архивы не встанут не в ту библиотеку
const ID = /^[0-9a-f]{8}$/;
const KEY = /^[A-Za-z0-9_-]{32,100}$/;
// Запрос «Связать» живёт 10 минут; без входа их приходит не больше MAX_ASKS — старые вытесняются, а не копятся
const ASK_MS = 10 * 60 * 1000;
const MAX_ASKS = 5;
// JDownloader дописывает в «….part» и переименовывает в конце: архив с окончательным именем уже не меняется
const MIN_AGE_MS = 20 * 1000;
const EVERY_MS = 30 * 1000;
// Соседка перестала отдавать посреди архива — бросаем через минуту тишины, а не висим вечно; следующий проход заново
const IDLE_MS = 60 * 1000;
const DEPTH = 3;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const token = () => crypto.randomBytes(32).toString('base64url');
const same = (a, b) => {
    const sum = (s) => crypto.createHash('sha256').update(String(s)).digest();
    return !!a && !!b && crypto.timingSafeEqual(sum(a), sum(b));
};
// Адрес установки — как его открывают в браузере: http(s)://хост[:порт][/путь], без логина, ?параметров и #
const cleanUrl = (v) => {
    const url = String(v || '').trim().replace(/\/+$/, '');
    return /^https?:\/\/[^\s/@?#]+(\/[^\s?#]*)?$/i.test(url) && url.length <= 300 ? url : '';
};
const exists = (p) => fsp.stat(p).then(() => true, () => false);
// Код просьбы — номер просящей установки: виден на обеих, владелец сверяет, что разрешает свою, а не подложенную
const codeOf = (id) => `${id.slice(0, 4)}-${id.slice(4)}`;

class RelayService {
    constructor() {
        this.dir = '';
        this.db = null;
        this.fetch = (...args) => fetch(...args);
        // Где связь и вход MyJDownloader хранятся (utils/secrets.js); в тестах — у каждой установки свои
        this.load = (name) => secret(name);
        this.state = { last: 0, error: '', peer: '', current: null, pulled: 0 };
        this.asks = new Map();   // запросы «Связать» сюда: номер → { id, url, key, nonce, folder, ip, at, status }
        this.outgoing = null;    // наш запрос туда: { url, request, nonce, id, key, at, status, error }
        this.pulling = null;
        this.kept = new Set(); // забрали, а удалить у соседки не вышло — второй раз не забираем
    }

    setDependencies({ dir, db = null }) {
        Object.assign(this, { dir, db });
    }

    // Связь: { self, peer, url, keyIn, keyOut, folder } — свой и её номер, её адрес, ключ к нам и к ней, её папка
    // MyJDownloader (наша пустая — качаем в её)
    link() {
        try {
            const v = JSON.parse(this.load('pair') || 'null');
            return ID.test(v?.self) && ID.test(v?.peer) && v.url && v.keyIn && v.keyOut ? v : null;
        } catch { return null; }
    }

    myjd() {
        try { return JSON.parse(myjdWithoutPassword(this.load('myjd') || 'null')); } catch { return null; }
    }

    // Как «Сохранить» в «Настройках» (routes/settings.js): в базу — зашифрованным, в память — как есть
    async store(name, value) {
        const key = SECRETS[name].setting;
        if (this.db) {
            if (value) await this.db.get().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, seal(value, key)]);
            else await this.db.get().run('DELETE FROM settings WHERE key = ?', [key]);
        }
        setSavedSecret(name, value);
    }

    // Папки обеих установок во «Входящих» — сразу: по ним seedbox узнаёт, какие скрытые папки на сервере наши
    // (services/seedbox.js), и соседке есть откуда отдавать
    async makeDirs(link) {
        for (const id of [link.self, link.peer]) await fsp.mkdir(path.join(this.dir, `.${id}`), { recursive: true });
    }

    // Без перенаправлений: адрес вписан руками, и уйти с него на другой сервер (внутри сети) запрос не должен
    async call(url, what, { key = '', method = 'GET', body, timeout = 15000, signal, headers = {} } = {}) {
        let res;
        try {
            res = await this.fetch(`${url}/api/relay/${what}`, {
                method,
                redirect: 'error',
                headers: { ...headers, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: signal || AbortSignal.timeout(timeout),
            });
        } catch (e) {
            throw fail(`Установка по адресу ${url} не ответила`, 502);
        }
        if (res.status === 401) throw fail('Та установка не приняла ключ: связь там убрана — свяжите заново', 502);
        if (!res.ok) {
            const why = await res.json().then((d) => (typeof d?.error === 'string' ? d.error.slice(0, 200) : ''), () => '');
            throw fail(why || `Установка по адресу ${url} ответила ${res.status}`, 502);
        }
        return res;
    }

    // --- Связать ---

    // «Связать» здесь: просим установку по адресу url. self — наш адрес, как его открывают (по нему та забирает отсюда)
    async pair(rawUrl, rawSelf) {
        if (this.link()) throw fail('Эта установка уже связана — сначала отвяжите', 409);
        const url = cleanUrl(rawUrl);
        if (!url) throw fail('Нужен адрес другой установки, как вы открываете её сайт: например, http://192.168.1.10');
        const me = { id: crypto.randomBytes(4).toString('hex'), key: token(), nonce: token() };
        // Наш вход MyJDownloader туда не уходит: адрес могли набрать с ошибкой. Только папка — она не секрет
        const r = await (await this.call(url, 'pair', { method: 'POST', body: { id: me.id, url: cleanUrl(rawSelf), key: me.key, nonce: me.nonce, folder: this.myjd()?.folder || '' } })).json();
        if (typeof r?.request !== 'string') throw fail('Та установка ответила непонятно', 502);
        this.outgoing = { url, request: r.request, ...me, at: Date.now(), status: 'waiting', error: '' };
    }

    // «Отменить» — и там просьбу убираем, чтобы её не разрешили по ошибке
    async cancel() {
        const o = this.outgoing;
        this.outgoing = null;
        if (o?.status === 'waiting') await this.call(o.url, `pair/${encodeURIComponent(o.request)}`, { method: 'DELETE', headers: { 'X-Relay-Nonce': o.nonce }, timeout: 3000 }).catch(() => {});
    }

    // Ждём «Разрешить» там: спрашиваем не чаще раза в 2 с — со страницы «Настроек» и сами, раз в 30 с (страницу могли
    // закрыть и пойти нажимать «Разрешить» к другому компьютеру). nonce — заголовком, не в адресе: адреса пишут в журналы
    async checkOutgoing() {
        const o = this.outgoing;
        if (!o || o.status !== 'waiting' || Date.now() - (o.checked || 0) < 2000) return;
        o.checked = Date.now();
        if (Date.now() - o.at > ASK_MS) { o.status = 'expired'; return; }
        try {
            const r = await (await this.call(o.url, `pair/${encodeURIComponent(o.request)}`, { headers: { 'X-Relay-Nonce': o.nonce }, timeout: 3000 })).json();
            if (r?.status === 'denied') o.status = 'denied';
            if (r?.status !== 'approved') return;
            if (!ID.test(r.id) || !KEY.test(r.key) || r.id === o.id) throw fail('Та установка ответила непонятно', 502);
            const link = { self: o.id, peer: r.id, url: o.url, keyIn: o.key, keyOut: r.key, folder: String(r.folder || '').slice(0, 500) };
            await this.store('pair', JSON.stringify(link));
            await this.makeDirs(link);
            // Здесь MyJDownloader не настроен — берём вход той установки (её владелец разрешил связь); там нет — даём наш
            if (r.myjd && !this.myjd()?.email) await this.adopt(r.myjd);
            else if (r.needLogin && this.shared()) await this.call(o.url, 'login', { key: link.keyOut, method: 'POST', body: { myjd: this.shared() } }).catch(() => {});
            this.outgoing = null;
            this.asks.clear();
            console.log(`[Две установки] Связана с ${o.url}`);
            this.pull();
        } catch (e) {
            o.error = e.message;
        }
    }

    // Вход MyJDownloader для соседки: почта, суммы для входа, устройство, папка — без пароля
    shared() {
        const m = this.myjd();
        return m?.email && m.loginSecret ? { email: m.email, loginSecret: m.loginSecret, deviceSecret: m.deviceSecret, device: m.device || 'server', folder: m.folder || '' } : null;
    }

    // Вход MyJDownloader от соседки — только если здесь своего нет
    async adopt(m) {
        if (this.myjd()?.email || !m || !/^[^\s@]+@[^\s@]+$/.test(m.email) || !/^[0-9a-f]{64}$/.test(m.loginSecret) || !/^[0-9a-f]{64}$/.test(m.deviceSecret)) return;
        await this.store('myjd', JSON.stringify({ email: String(m.email), loginSecret: m.loginSecret, deviceSecret: m.deviceSecret, device: String(m.device || 'server').slice(0, 80), folder: String(m.folder || '').slice(0, 500) }));
        console.log('[Две установки] Вход MyJDownloader — от связанной установки');
    }

    // Запрос «Связать» оттуда (routes/relay.js, без входа): ждёт, пока владелец здесь нажмёт «Разрешить». ip — откуда
    // пришёл: «Настройки» показывают его рядом с адресом, который та установка назвала сама
    ask(body, ip) {
        if (this.link()) throw fail('Эта установка уже связана с другой', 409);
        const { id, key, nonce } = body || {};
        // Без своего адреса связь вышла бы односторонней: эта установка не смогла бы забирать у той
        const url = cleanUrl(body?.url);
        if (!ID.test(id) || !KEY.test(key) || !KEY.test(nonce) || !url) throw fail('Непонятный запрос');
        const from = String(ip || '').replace(/^::ffff:/, '');
        this.prune();
        // «Связать» ещё раз с того же адреса — прежняя просьба не нужна: разрешили бы ключ, которого там уже не знают
        for (const [k, a] of this.asks) if (a.status === 'waiting' && a.url === url && a.ip === from) this.asks.delete(k);
        if (this.asks.size >= MAX_ASKS) this.asks.delete(this.asks.keys().next().value);
        const request = token();
        this.asks.set(request, { id, key, nonce, url, folder: String(body.folder || '').slice(0, 500), ip: from, at: Date.now(), status: 'waiting' });
        console.log(`[Две установки] Просят связать: ${url} (${from})`);
        return { request };
    }

    prune() {
        for (const [k, a] of this.asks) if (Date.now() - a.at > ASK_MS) this.asks.delete(k);
    }

    // Та установка спрашивает, разрешили ли: ответ — только ей (nonce знает только она). Разрешённый отдаём, пока
    // просьба жива: ответ мог потеряться в сети, а связь здесь уже есть
    answer(request, nonce) {
        const a = this.asks.get(request);
        if (!a || !same(a.nonce, nonce)) throw fail('Нет такого запроса', 404);
        return a.status === 'approved' ? a.reply : { status: a.status === 'approving' ? 'waiting' : a.status };
    }

    // Та установка отменила просьбу
    withdraw(request, nonce) {
        const a = this.asks.get(request);
        if (!a || !same(a.nonce, nonce)) throw fail('Нет такого запроса', 404);
        if (a.status === 'waiting') this.asks.delete(request);
    }

    // «Разрешить» здесь
    // «Разрешить» здесь. Занимаем просьбу сразу, до первого await: двойной щелчок не свяжет дважды разными ключами
    async approve(request) {
        const a = this.asks.get(request);
        if (!a || a.status !== 'waiting') throw fail('Запрос устарел — нажмите «Связать» на той установке ещё раз', 404);
        if (this.link() || this.approving) throw fail('Эта установка уже связана', 409);
        const own = this.myjd();
        if (!own?.folder && !a.folder) throw fail('Укажите в MyJDownloader папку «Входящие» — здесь или на той установке: в её подпапки JDownloader и будет качать', 409);
        a.status = 'approving';
        this.approving = true;
        try {
            const link = { self: crypto.randomBytes(4).toString('hex'), peer: a.id, url: a.url, keyIn: token(), keyOut: a.key, folder: a.folder };
            await this.store('pair', JSON.stringify(link));
            await this.makeDirs(link);
            const login = this.shared();
            a.reply = { status: 'approved', id: link.self, key: link.keyIn, folder: own?.folder || '', ...(login ? { myjd: login } : { needLogin: true }) };
            Object.assign(a, { status: 'approved', at: Date.now() });
        } catch (e) {
            a.status = 'waiting';
            throw e;
        } finally {
            this.approving = false;
        }
        for (const [k, x] of this.asks) if (k !== request) x.status = 'denied';
        // Свою просьбу туда отзываем: иначе там разрешили бы и её — и связей вышло бы две, с разными ключами
        await this.cancel();
        console.log(`[Две установки] Связана с ${a.url} (${a.ip})`);
    }

    deny(request) {
        const a = this.asks.get(request);
        if (a) a.status = 'denied';
    }

    // «Отвязать» здесь — и там (если та установка ответит); там отвязали — и здесь (routes/relay.js, DELETE /pair)
    async unlink(tell = true) {
        const link = this.link();
        if (!link) return;
        if (tell) await this.call(link.url, 'pair', { method: 'DELETE', key: link.keyOut, timeout: 5000 }).catch(() => {});
        await this.store('pair', '');
        // Свои архивы, что успели лечь в свою папку, — во «Входящие»; архивы той установки остаются в её папке
        await this.moveOwn(link).catch(() => {});
        for (const id of [link.self, link.peer]) await fsp.rmdir(path.join(this.dir, `.${id}`)).catch(() => {});
        Object.assign(this.state, { error: '', peer: '' });
        console.log('[Две установки] Связь убрана');
    }

    // Ключ соседки (Authorization: Bearer …) — сравнение за постоянное время
    allowed(header) {
        return same(this.link()?.keyIn, String(header || '').replace(/^Bearer\s+/i, ''));
    }

    // --- Архивы ---

    // Готовые архивы в папке — и в подпапках пакетов: путь от неё, имя, размер. Ссылки (симлинки) не отдаём: ключ
    // соседки — не ключ ко всему диску
    async scan(root) {
        const out = [];
        const walk = async (dir, depth) => {
            for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
                if (e.name.startsWith('.')) continue;
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (depth < DEPTH) await walk(p, depth + 1);
                } else if (e.isFile() && ARCHIVE.test(e.name)) {
                    const st = await fsp.stat(p).catch(() => null);
                    if (st && Date.now() - st.mtimeMs >= MIN_AGE_MS) out.push({ path: path.relative(root, p).split(path.sep).join('/'), name: e.name, size: st.size, full: p });
                }
            }
        };
        await walk(root, 0);
        return out;
    }

    // Соседке — её архивы, которые JDownloader положил сюда, в «.<её номер>»
    peerDir() {
        const link = this.link();
        if (!link) throw fail('Установки не связаны', 401);
        return path.join(this.dir, `.${link.peer}`);
    }

    async files() {
        return (await this.scan(this.peerDir())).map(({ path: p, name, size }) => ({ path: p, name, size }));
    }

    // Путь от её папки → файл архива внутри неё: { f, root } настоящими путями. Без «..», абсолютных путей, скрытого
    // и ссылок наружу
    async fileOf(rel) {
        const parts = String(rel || '').split(/[\\/]/);
        if (!rel || path.isAbsolute(rel) || parts.some((p) => !p || p === '..' || p.startsWith('.')) || !ARCHIVE.test(rel)) throw fail('Нет такого архива', 404);
        const root = await fsp.realpath(this.peerDir()).catch(() => '');
        const f = root && await fsp.realpath(path.join(root, ...parts)).catch(() => '');
        const st = f && await fsp.lstat(f).catch(() => null);
        if (!f.startsWith(root + path.sep) || !st?.isFile()) throw fail('Нет такого архива', 404);
        return { f, root };
    }

    // Соседка забрала — архив долой, и опустевшую папку пакета тоже
    async remove(rel) {
        const { f, root } = await this.fileOf(rel);
        await fsp.rm(f);
        await this.tidy(path.dirname(f), root);
    }

    async tidy(dir, root) {
        for (; dir !== root && dir.startsWith(root); dir = path.dirname(dir)) {
            if (await fsp.rmdir(dir).then(() => false, () => true)) break;
        }
    }

    pull() {
        this.pulling ??= this.pass().finally(() => { this.pulling = null; });
        return this.pulling;
    }

    // Проход: свои архивы, легшие сюда, — во «Входящие»; свои архивы у соседки — забрать
    async pass() {
        const link = this.link();
        if (!link || !this.dir) return;
        const errors = [];
        await this.moveOwn(link).catch((e) => errors.push(e.message));
        // Соседка выключена (ноутбук спит) — это не ошибка: её архивы подождут, а JDownloader мог и вовсе писать сюда
        let files = [];
        try {
            files = await (await this.call(link.url, 'files', { key: link.keyOut, timeout: 10000 })).json();
            this.state.peer = '';
        } catch (e) {
            this.state.peer = e.message;
        }
        for (const f of Array.isArray(files) ? files : []) await this.take(link, f).catch((e) => { errors.push(e.message); console.error('[Две установки]', e.message); });
        Object.assign(this.state, { error: errors.join('; '), last: Date.now(), current: null });
    }

    // Свои архивы, которые JDownloader положил сюда, в «.<свой номер>», — во «Входящие» (тот же диск: переименованием)
    async moveOwn(link) {
        const root = path.join(this.dir, `.${link.self}`);
        for (const f of await this.scan(root)) {
            const dest = path.join(this.dir, f.name.normalize('NFC'));
            if (await exists(dest)) continue; // такой уже ждёт во «Входящих» — не затираем
            await fsp.rename(f.full, dest);
            await this.tidy(path.dirname(f.full), root);
            console.log(`[Две установки] ${f.name}: во «Входящих»`);
        }
    }

    // Сначала во временный «.….seedbox» (его «Входящие» не берут), сверка размера, переименование — и только тогда
    // удаление у соседки. Оборвалось — у неё архив остался, следующий проход скачает заново.
    // shortcut: оборванный архив качается заново с начала, без докачки — если начнут рваться большие
    async take(link, f) {
        const name = String(f?.name || '').normalize('NFC');
        // Список пришёл с другого сервера: имя — только имя, размер — число
        if (!ARCHIVE.test(name) || /[\\/\0]/.test(name) || name.startsWith('.') || typeof f.path !== 'string' || !Number.isSafeInteger(f.size)) return;
        if (this.kept.has(`${f.path}\n${f.size}`)) return;
        await fsp.mkdir(this.dir, { recursive: true });
        const dest = path.join(this.dir, name);
        if (await exists(dest)) return;
        const tmp = path.join(this.dir, `.${name}.${crypto.randomBytes(4).toString('hex')}.seedbox`);
        const q = `path=${encodeURIComponent(f.path)}`;
        this.state.current = { name, got: 0, total: f.size };
        const ctl = new AbortController();
        let idle = null;
        let got = 0;
        const poke = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), IDLE_MS); };
        try {
            poke();
            const res = await this.call(link.url, `file?${q}`, { key: link.keyOut, signal: ctl.signal });
            const count = new Transform({
                transform: (chunk, enc, done) => {
                    poke();
                    got += chunk.length;
                    if (this.state.current) this.state.current.got = got;
                    // Больше, чем было в списке, — не тот файл: не забиваем диск
                    done(got > f.size ? fail(`${name}: пришло больше ${f.size} байт`) : null, chunk);
                },
            });
            await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(tmp));
            const st = await fsp.stat(tmp);
            if (st.size !== f.size) throw fail(`${name}: пришло ${st.size} байт из ${f.size}`);
            await fsp.rename(tmp, dest);
        } catch (e) {
            await fsp.rm(tmp, { force: true });
            throw e;
        } finally {
            clearTimeout(idle);
        }
        this.state.pulled += 1;
        // Не удалился — помним до перезапуска, иначе после импорта он пришёл бы снова и встал в библиотеку второй раз
        await this.call(link.url, `file?${q}`, { key: link.keyOut, method: 'DELETE' }).catch((e) => {
            this.kept.add(`${f.path}\n${f.size}`);
            throw fail(`${name}: забран, но у той установки не удалён (${e.message})`);
        });
        console.log(`[Две установки] ${name}: забран у связанной, ${Math.round(f.size / 1048576)} МБ`);
    }

    // Для «Настроек»: с кем связана, кто просит связать, наш запрос туда, как прошёл последний проход
    async status() {
        await this.checkOutgoing();
        this.prune();
        const link = this.link();
        const o = this.outgoing;
        return {
            linked: link ? { url: link.url, self: link.self, folder: String(this.myjd()?.folder || link.folder || '') } : null,
            outgoing: o ? { url: o.url, status: o.status, error: o.error, code: codeOf(o.id) } : null,
            asks: [...this.asks].filter(([, a]) => a.status === 'waiting').map(([request, a]) => ({ request, url: a.url, ip: a.ip, at: a.at, code: codeOf(a.id) })),
            ...this.state,
        };
    }

    // Раз в 30 с: ждём «Разрешить» там (страницу «Настроек» здесь могли закрыть) и проходим по архивам
    tick() {
        return this.checkOutgoing().then(() => this.pull());
    }

    start() {
        setInterval(() => this.tick(), EVERY_MS).unref();
        setTimeout(() => this.tick(), 10 * 1000).unref();
    }
}

module.exports = new RelayService();
module.exports.RelayService = RelayService;
