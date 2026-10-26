const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const { Client, utils } = require('ssh2');
const { secret } = require('../utils/secrets.js');
const { ARCHIVE } = require('./inbox.js');

// Seedbox: удалённый сервер, куда качает JDownloader (или торрент-клиент). Раз в минуту забираем оттуда по SFTP готовые
// архивы во «Входящие» и удаляем их там — дальше их берёт библиотека (services/inbox.js). Без rclone и cron: человек
// вписывает в «Настройках» адрес, логин, пароль и папку, остальное делаем сами.
// Пароль нужен один раз: заводим свой ключ (ed25519) в ~/.ssh/authorized_keys на сервере, хранится ключ, а не пароль.
// Отпечаток сервера запоминаем при настройке: подменённый сервер ключ не получит и архивы не подсунет
const EVERY_MS = 60 * 1000;
// Моложе — ещё могут дописывать (торрент-клиент пишет в файл с окончательным именем; JDownloader — в «….part»)
const MIN_AGE_MS = 2 * 60 * 1000;
const DEPTH = 3;
// Ключ подписан «mimikin-<id установки>»: при перенастройке убираем только свой прежний, не ключ соседней установки
const COMMENT = 'mimikin';
// Имя файла с сервера — только имя: «/», «\», «..» и NUL не выпустят запись за пределы «Входящих»
const SAFE_NAME = (n) => !!n && !/[/\\\0]/.test(n) && n !== '..' && !n.startsWith('.');
// Папка второй установки (services/relay.js): «.<имя>»
const BOX_DIR = /^\.[a-z0-9_-]{1,32}$/;

const fail = (message) => Object.assign(new Error(message), { seedbox: true });

// Сохранённая настройка: JSON { host, port, user, folder, key, hostKey }
function settings() {
    try {
        const v = JSON.parse(secret('seedbox') || 'null');
        return v?.host && v?.user && v?.key ? v : null;
    } catch { return null; }
}

// Папка на сервере — от домашней, как её показывает SFTP: «downloads/jdownloader2/Games/Mimikin»
const cleanFolder = (f) => String(f || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^~\//, '');
// Папка обязательна и внутри домашней: пустая — это весь дом, и забирались бы все архивы оттуда
const folderError = (f) => (!f ? 'Укажите папку на сервере' : f.startsWith('/') ? 'Папка — от домашней, без «/» в начале'
    : f.split('/').includes('..') ? 'В пути к папке не должно быть «..»' : '');

class SeedboxService {
    constructor() {
        this.dir = '';
        this.Client = Client;
        this.state = { last: 0, error: '', current: null, pulled: 0 };
        this.pulling = null;
        this.kept = new Set(); // забрали, а удалить на сервере не вышло — второй раз не забираем
    }

    setDependencies({ dir }) {
        this.dir = dir;
    }

    // Вход: { password } или { privateKey }. Отпечаток сервера — sha256 его ключа; известен — сверяем
    connect(cfg, auth) {
        return new Promise((resolve, reject) => {
            const conn = new this.Client();
            let seen = '';
            conn.on('ready', () => conn.sftp((e, sftp) => (e ? (conn.end(), reject(e)) : resolve({ conn, sftp, hostKey: seen }))))
                // Пароль у некоторых серверов спрашивается «с клавиатуры» — отвечаем тем же паролем
                .on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish(prompts.map(() => auth.password || '')))
                .on('error', reject)
                .connect({
                    // keepalive: оборванная посреди скачивания связь — ошибка через минуту, а не проход, висящий вечно
                    host: cfg.host, port: cfg.port || 22, username: cfg.user, readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 4,
                    tryKeyboard: !!auth.password, ...auth,
                    hostVerifier: (key) => {
                        seen = crypto.createHash('sha256').update(key).digest('base64');
                        return !cfg.hostKey || cfg.hostKey === seen;
                    },
                });
        });
    }

    // Настройка из «Настроек» (routes/settings.js, проверка seedbox): пароль → свой ключ на сервере → папка.
    // { ok: true, value } — value без пароля, его и сохраняем; { ok: false, message } — что не так. null не отдаём:
    // «не ответил» сохранило бы введённое как есть, с паролем
    async setup(raw) {
        try {
            return await this.configure(raw);
        } catch (e) {
            return { ok: false, message: e.message };
        }
    }

    async configure(raw) {
        let o;
        try { o = JSON.parse(raw); } catch { return { ok: false, message: 'Непонятная настройка' }; }
        const cfg = { host: o.host, port: o.port, user: o.user, folder: cleanFolder(o.folder) };
        if (folderError(cfg.folder)) return { ok: false, message: folderError(cfg.folder) };
        // id установки — прежний, если уже настраивали: тогда заменится свой старый ключ
        const id = settings()?.id || crypto.randomBytes(4).toString('hex');
        const { private: key, public: pub } = utils.generateKeyPairSync('ed25519', { comment: `${COMMENT}-${id}` });
        let session;
        try {
            session = await this.connect(cfg, { password: o.password });
        } catch (e) {
            return { ok: false, message: /authentication/i.test(e.message) ? 'Сервер не пустил: неверный логин или пароль' : `Сервер не ответил: ${e.message}` };
        }
        try {
            await this.addKey(session.sftp, pub, `${COMMENT}-${id}`);
            await this.mkdirs(session.sftp, cfg.folder);
        } catch (e) {
            return { ok: false, message: `Вошли, но настроить не вышло: ${e.message}` };
        } finally {
            session.conn.end();
        }
        const saved = { ...cfg, id, key, hostKey: session.hostKey };
        // Ключ мог не подойти (сервер пускает только по паролю) — проверяем сразу, а не через минуту
        try {
            (await this.connect(saved, { privateKey: key })).conn.end();
        } catch (e) {
            return { ok: false, message: `Сервер не принял ключ: ${e.message}` };
        }
        return { ok: true, value: JSON.stringify(saved) };
    }

    // Чужие ключи в authorized_keys — вход человека на его сервер: не прочитали файл (кроме «нет такого») — не пишем.
    // Пишем во временный и переименовываем: оборвись запись — прежний файл цел
    async addKey(sftp, pub, comment) {
        await call(sftp, 'mkdir', '.ssh', { mode: 0o700 }).catch(() => {});
        const file = '.ssh/authorized_keys';
        const exists = await call(sftp, 'stat', file).then(() => true, (e) => { if (e.code === 2) return false; throw e; });
        const text = exists ? await readText(sftp, file) : '';
        const lines = text.split('\n').filter((l) => l.trim() && !l.trim().endsWith(` ${comment}`));
        lines.push(pub);
        const tmp = `${file}.${comment}.tmp`;
        await writeText(sftp, tmp, `${lines.join('\n')}\n`);
        // Переименование поверх — расширение OpenSSH; без него — удалить старый и переименовать (окно в миг)
        const swapped = await call(sftp, 'ext_openssh_rename', tmp, file).then(() => true, () => false);
        if (!swapped) {
            if (exists) await call(sftp, 'unlink', file);
            await call(sftp, 'rename', tmp, file);
        }
        await call(sftp, 'chmod', file, 0o600).catch(() => {});
        await call(sftp, 'chmod', '.ssh', 0o700).catch(() => {});
    }

    async mkdirs(sftp, folder) {
        let cur = '';
        for (const part of folder.split('/').filter(Boolean)) {
            cur = cur ? `${cur}/${part}` : part;
            await call(sftp, 'mkdir', cur).catch(() => {});
        }
        await call(sftp, 'stat', folder).catch(() => { throw fail(`Нет папки ${folder}`); });
    }

    // Один проход: готовые архивы — во «Входящие», с сервера — долой. Распакованное (папки игр) не трогаем
    pull() {
        this.pulling ??= this.pass().finally(() => { this.pulling = null; });
        return this.pulling;
    }

    async pass() {
        const cfg = settings();
        if (!cfg || !this.dir || folderError(cfg.folder)) return;
        let session;
        try {
            session = await this.connect(cfg, { privateKey: cfg.key });
            const files = await this.archives(session.sftp, cfg.folder, 0);
            // Папки вторых установок, «.<имя>» (services/relay.js): JDownloader качал для них — переносим в такие же папки
            // у себя, «Входящие» их не берут, оттуда архивы забирает сама вторая. Только связанные — у них папка во
            // «Входящих» уже есть (её заводит «Связать»); чужие скрытые (.cache, .local) на сервере не трогаем
            for (const e of await call(session.sftp, 'readdir', cfg.folder)) {
                if (!e.attrs.isDirectory() || !BOX_DIR.test(e.filename) || !(await fsp.stat(path.join(this.dir, e.filename)).catch(() => null))?.isDirectory()) continue;
                files.push(...(await this.archives(session.sftp, `${cfg.folder}/${e.filename}`, 0)).map((f) => ({ ...f, box: e.filename })));
            }
            // Один плохой архив (права, обрыв) не держит остальные: ошибку запоминаем, идём дальше
            const errors = [];
            for (const f of files) await this.fetch(session.sftp, f).catch((e) => { errors.push(e.message); console.error('[Seedbox]', e.message); });
            this.state.error = errors.join('; ');
        } catch (e) {
            this.state.error = e.message;
            console.error('[Seedbox]', e.message);
        } finally {
            session?.conn.end();
            this.state.last = Date.now();
            this.state.current = null;
        }
    }

    // Архивы в папке и в подпапках пакетов (JDownloader кладёт пакет в свою). В папку, где лежат не только архивы
    // (распакованная игра: Game.exe, www/…), не заходим — её data.zip не наш
    async archives(sftp, dir, depth) {
        const out = [];
        const list = (await call(sftp, 'readdir', dir)).filter((e) => SAFE_NAME(e.filename));
        for (const e of list) {
            const p = `${dir}/${e.filename}`;
            if (e.attrs.isDirectory()) {
                if (depth < DEPTH) out.push(...await this.archives(sftp, p, depth + 1));
            } else if (ARCHIVE.test(e.filename) && Date.now() - e.attrs.mtime * 1000 >= MIN_AGE_MS && !this.kept.has(`${p}\n${e.attrs.size}`)) {
                out.push({ remote: p, name: e.filename, size: e.attrs.size });
            }
        }
        const unpacked = depth > 0 && list.some((e) => !e.attrs.isDirectory() && !ARCHIVE.test(e.filename) && !/\.part$/i.test(e.filename));
        return unpacked ? [] : out;
    }

    // Сначала во временный «.…» (его «Входящие» не берут), потом сверка размера и переименование, и только тогда —
    // удаление на сервере. Оборвалось — на сервере архив остался, следующий проход скачает заново
    async fetch(sftp, f) {
        const dir = f.box ? path.join(this.dir, f.box) : this.dir;
        await fsp.mkdir(dir, { recursive: true });
        const dest = path.join(dir, path.basename(f.name.normalize('NFC')));
        if (await fsp.stat(dest).catch(() => null)) return; // такой уже ждёт во «Входящих» — не затираем
        const tmp = path.join(dir, `.${path.basename(f.name)}.${crypto.randomBytes(4).toString('hex')}.seedbox`);
        this.state.current = { name: f.name.normalize('NFC'), got: 0, total: f.size };
        try {
            await new Promise((resolve, reject) => sftp.fastGet(f.remote, tmp, {
                step: (got) => { if (this.state.current) this.state.current.got = got; },
            }, (e) => (e ? reject(e) : resolve())));
            const st = await fsp.stat(tmp);
            if (st.size !== f.size) throw fail(`${f.name}: пришло ${st.size} байт из ${f.size}`);
            await fsp.rename(tmp, dest);
        } catch (e) {
            await fsp.rm(tmp, { force: true });
            throw e;
        }
        this.state.pulled += 1;
        // Не удалился — помним до перезапуска, иначе после импорта он пришёл бы снова и встал в библиотеку второй раз
        await call(sftp, 'unlink', f.remote).catch((e) => {
            this.kept.add(`${f.remote}\n${f.size}`);
            throw fail(`${f.name}: забран, но на сервере не удалён (${e.message}) — удалите его там сами`);
        });
        console.log(`[Seedbox] ${f.name}: во «Входящих», ${Math.round(f.size / 1048576)} МБ`);
    }

    status() {
        const cfg = settings();
        return { set: !!cfg, host: cfg?.host || '', port: cfg?.port || 22, user: cfg?.user || '', folder: cfg?.folder || '', ...this.state };
    }

    start() {
        setInterval(() => this.pull(), EVERY_MS).unref();
        setTimeout(() => this.pull(), 10 * 1000).unref();
    }
}

const call = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (e, r) => (e ? reject(e) : resolve(r))));

const readText = (sftp, file) => new Promise((resolve, reject) => {
    let text = '';
    sftp.createReadStream(file, { encoding: 'utf8' }).on('data', (d) => { text += d; }).on('end', () => resolve(text)).on('error', reject);
});

const writeText = (sftp, file, text) => new Promise((resolve, reject) => {
    const s = sftp.createWriteStream(file, { mode: 0o600 });
    s.on('close', resolve).on('error', reject);
    s.end(text);
});

module.exports = new SeedboxService();
module.exports.SeedboxService = SeedboxService;
module.exports.cleanFolder = cleanFolder;
