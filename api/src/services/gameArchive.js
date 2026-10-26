// Архив игры «на лету»: ZIP без сжатия, который сервер отдаёт по мере чтения папки. Ресурсы игр
// (картинки, звук, видео) уже сжаты, поэтому store: быстро, процессор не нагружен. А главное — размер
// архива известен заранее до байта, и браузер с телефоном показывают обычную полосу загрузки.
// ZIP64 всегда: игры бывают больше 4 ГБ, а файлов — больше 65535. Имена в UTF-8 (бит 11), иначе
// японские названия на Windows превращаются в мусор. CRC считается на лету и уходит в «дескриптор
// данных» после файла, поэтому читать файл дважды не нужно. Сжимающую библиотеку не берём:
// в Node 22.2+ есть zlib.crc32, остальное — несколько десятков байт заголовков.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const CHUNK = 256 * 1024;
const MAX_ACTIVE = 2;
let active = 0;

// Занять место под архив: больше двух сразу — отказ, чтобы чтение гигабайтов не съело диск и сеть
function acquire() {
    if (active >= MAX_ACTIVE) return null;
    active++;
    let done = false;
    return () => { if (!done) { done = true; active--; } };
}

// Дата и время в формате MS-DOS; раньше 1980 года ZIP их не хранит
function dosTime(ms) {
    const d = new Date(Math.max(ms, Date.UTC(1980, 0, 1)));
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

// Обход папки игры. Символьные ссылки внутри пропускаем целиком: они могут вести за пределы папки
// (чужие файлы сервера) или по кругу. Сама папка игры может быть ссылкой — в dev так лежат игры
// прода, её разыменовывает вызывающий код (root уже настоящий путь)
async function walk(root, prefix, out) {
    let items = await fsp.readdir(root, { withFileTypes: true });
    items = items.filter((i) => i.isFile() || i.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!items.length && prefix) {
        const st = await fsp.stat(root);
        out.push({ name: `${prefix}/`, dir: true, mtime: st.mtimeMs });
    }
    for (const item of items) {
        const full = path.join(root, item.name);
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) { await walk(full, name, out); continue; }
        const st = await fsp.lstat(full).catch(() => null);
        if (!st || !st.isFile()) continue;   // исчез или подменён ссылкой между чтением папки и этим вызовом
        out.push({ name, full, size: st.size, mtime: st.mtimeMs });
    }
}

// Текущие сейвы Mimikin как файлы там, где их читает движок: у MV — www/save/file1.rpgsave (save/ рядом с
// index.html, если папки www нет), у MZ — save/file1.rmmzsave. Содержимое у файла и у хранилища браузера
// одинаковое (см. desktopSaveKey в routes/saves.js), различается только имя. История и «моменты» не входят
async function saveEntries(savesDir, root, top) {
    const hasWww = await fsp.stat(path.join(root, 'www', 'index.html')).then((s) => s.isFile(), () => false);
    const out = [];
    for (const f of await fsp.readdir(savesDir).catch(() => [])) {
        if (!f.endsWith('.json')) continue;
        let key;
        try { key = decodeURIComponent(f.slice(0, -5)); } catch { continue; }
        const m = key.match(/^(?:RPG (File\d+|Config|Global)|MZ_(file\d+|config|global))$/i);
        if (!m) continue;   // копии слотов («RPG File1bak») и чужие ключи в игру не идут
        const full = path.join(savesDir, f);
        const st = await fsp.lstat(full).catch(() => null);
        if (!st || !st.isFile()) continue;
        const data = await fsp.readFile(full).catch(() => null);
        if (!data) continue;
        const name = (m[1] || m[2]).toLowerCase();
        const rel = `${hasWww ? 'www/' : ''}save/${name}.${m[1] ? 'rpgsave' : 'rmmzsave'}`;
        out.push({ name: `${top}/${rel}`, data, size: data.length, mtime: st.mtimeMs });
    }
    return out;
}

// Список записей и точный размер будущего архива. top — имя папки внутри архива: при
// распаковке игра ляжет в свою папку, а не рассыплется по месту распаковки
async function plan(gameDir, top, savesDir = null) {
    const root = await fsp.realpath(gameDir);
    let entries = [];
    await walk(root, top, entries);
    if (savesDir) {
        // Сейв Mimikin заменяет файл игры с тем же путём: два одноимённых файла в архиве распаковались бы как попало
        const extra = await saveEntries(savesDir, root, top);
        const taken = new Set(extra.map((x) => x.name.toLowerCase()));
        entries = entries.filter((e) => !taken.has(e.name.toLowerCase())).concat(extra);
    }
    let total = 0;
    let offset = 0;
    for (const e of entries) {
        e.nameBuf = Buffer.from(e.name, 'utf8');
        e.offset = offset;
        e.local = e.dir ? 30 + e.nameBuf.length : 30 + e.nameBuf.length + 20;
        e.after = e.dir ? 0 : 24;
        offset += e.local + (e.dir ? 0 : e.size) + e.after;
    }
    total = offset;
    for (const e of entries) total += 46 + e.nameBuf.length + 28;
    total += 56 + 20 + 22;
    return { entries, total, files: entries.filter((e) => !e.dir).length, bytes: entries.reduce((s, e) => s + (e.size || 0), 0) };
}

function localHeader(e) {
    const { time, date } = dosTime(e.mtime);
    const b = Buffer.alloc(e.local);
    b.writeUInt32LE(0x04034b50, 0);
    b.writeUInt16LE(45, 4);
    b.writeUInt16LE(e.dir ? 0x0800 : 0x0808, 6);   // бит 11 — UTF-8, бит 3 — CRC и размеры после данных
    b.writeUInt16LE(0, 8);                         // store
    b.writeUInt16LE(time, 10);
    b.writeUInt16LE(date, 12);
    // CRC и размеры файла — нули: настоящие значения придут в дескрипторе
    if (!e.dir) { b.writeUInt32LE(0xffffffff, 18); b.writeUInt32LE(0xffffffff, 22); }
    b.writeUInt16LE(e.nameBuf.length, 26);
    b.writeUInt16LE(e.dir ? 0 : 20, 28);
    e.nameBuf.copy(b, 30);
    if (!e.dir) { b.writeUInt16LE(1, 30 + e.nameBuf.length); b.writeUInt16LE(16, 32 + e.nameBuf.length); }
    return b;
}

function centralEntry(e) {
    const { time, date } = dosTime(e.mtime);
    const b = Buffer.alloc(46 + e.nameBuf.length + 28);
    b.writeUInt32LE(0x02014b50, 0);
    b.writeUInt16LE(45, 4);
    b.writeUInt16LE(45, 6);
    b.writeUInt16LE(e.dir ? 0x0800 : 0x0808, 8);
    b.writeUInt16LE(0, 10);
    b.writeUInt16LE(time, 12);
    b.writeUInt16LE(date, 14);
    b.writeUInt32LE(e.crc >>> 0, 16);
    b.writeUInt32LE(0xffffffff, 20);
    b.writeUInt32LE(0xffffffff, 24);
    b.writeUInt16LE(e.nameBuf.length, 28);
    b.writeUInt16LE(28, 30);
    b.writeUInt32LE(0xffffffff, 42);
    e.nameBuf.copy(b, 46);
    const x = 46 + e.nameBuf.length;
    b.writeUInt16LE(1, x);
    b.writeUInt16LE(24, x + 2);
    b.writeBigUInt64LE(BigInt(e.size || 0), x + 4);
    b.writeBigUInt64LE(BigInt(e.size || 0), x + 12);
    b.writeBigUInt64LE(BigInt(e.offset), x + 20);
    return b;
}

function endRecords(count, cdSize, cdOffset) {
    const b = Buffer.alloc(56 + 20 + 22);
    b.writeUInt32LE(0x06064b50, 0);
    b.writeBigUInt64LE(44n, 4);
    b.writeUInt16LE(45, 12);
    b.writeUInt16LE(45, 14);
    b.writeBigUInt64LE(BigInt(count), 24);
    b.writeBigUInt64LE(BigInt(count), 32);
    b.writeBigUInt64LE(BigInt(cdSize), 40);
    b.writeBigUInt64LE(BigInt(cdOffset), 48);
    b.writeUInt32LE(0x07064b50, 56);
    b.writeBigUInt64LE(BigInt(cdOffset + cdSize), 64);
    b.writeUInt32LE(1, 72);
    b.writeUInt32LE(0x06054b50, 76);
    b.writeUInt16LE(0xffff, 84);
    b.writeUInt16LE(0xffff, 86);
    b.writeUInt32LE(0xffffffff, 88);
    b.writeUInt32LE(0xffffffff, 92);
    return b;
}

// Дескриптор данных после файла: настоящие CRC и размер
function descriptor(e) {
    const d = Buffer.alloc(24);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(e.crc >>> 0, 4);
    d.writeBigUInt64LE(BigInt(e.size), 8);
    d.writeBigUInt64LE(BigInt(e.size), 16);
    return d;
}

// Поток байтов архива. Закрытие соединения останавливает генератор — файл закрывается в finally.
// Файл, чей размер изменился с момента подсчёта, рвёт поток: лучше упавшая загрузка, чем тихо
// битый архив с неверной длиной
async function* generate(p) {
    let cdOffset = 0;
    for (const e of p.entries) {
        yield localHeader(e);
        cdOffset += e.local;
        e.crc = 0;
        if (e.dir) continue;
        if (e.data) {   // сейв Mimikin: уже в памяти
            e.crc = zlib.crc32(e.data);
            if (e.data.length) yield e.data;
            cdOffset += e.size + 24;
            yield descriptor(e);
            continue;
        }
        let fh;
        let left = e.size;
        try {
            fh = await fsp.open(e.full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            while (left > 0) {
                const buf = Buffer.allocUnsafe(Math.min(CHUNK, left));
                const { bytesRead } = await fh.read(buf, 0, buf.length, e.size - left);
                if (!bytesRead) throw new Error(`файл стал короче: ${e.name}`);
                const chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
                e.crc = zlib.crc32(chunk, e.crc);
                left -= bytesRead;
                yield chunk;
            }
            // Дописали в хвост — тоже расхождение с заявленной длиной
            const st = await fh.stat();
            if (st.size !== e.size) throw new Error(`файл изменился: ${e.name}`);
        } finally {
            await fh?.close().catch(() => {});
        }
        cdOffset += e.size + 24;
        yield descriptor(e);
    }
    let cdSize = 0;
    for (const e of p.entries) {
        const c = centralEntry(e);
        cdSize += c.length;
        yield c;
    }
    yield endRecords(p.entries.length, cdSize, cdOffset);
}

const stream = (p) => Readable.from(generate(p), { objectMode: false });

// Сколько сейвов Mimikin попадёт в архив (для выбора «с сейвами / без» в окне игры)
async function savesCount(savesDir) {
    return (await saveEntries(savesDir, '/nonexistent', 'x')).length;
}

// Имя файла для скачивания: без символов, которые Windows не принимает в именах
function safeName(raw, fallback) {
    const s = String(raw || '').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 120).trim();
    return s || fallback;
}

// Заголовок Content-Disposition: ASCII-имя для старых клиентов и filename* (RFC 5987) для остальных
function disposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
    const star = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// Имя файла: показываемое название (без версий и подписей переводчиков) и версия, если её ещё нет в названии
function fileName(title, version, fallback) {
    const v = String(version || '').trim();
    const t = String(title || '').trim();
    const has = v && t.toLowerCase().includes(v.toLowerCase());
    return safeName(`${t || fallback} ${v && !has ? v : ''}`, fallback) + '.zip';
}

// Закрыть ответ, если за срок не ушло ни байта: вкладка на паузе или зависший клиент иначе держат
// одно из двух мест до перезапуска API (таймауты сервера отключены). Срок читается при каждом запуске — его правят тесты
const state = { idleMs: 5 * 60 * 1000 };
function watchIdle(res, onIdle) {
    const idle = state.idleMs;
    let last = -1;
    let since = Date.now();
    const timer = setInterval(() => {
        const sent = res.socket ? res.socket.bytesWritten : 0;
        if (sent !== last) { last = sent; since = Date.now(); }
        else if (Date.now() - since >= idle) { clearInterval(timer); onIdle(); }
    }, Math.max(20, Math.min(30000, idle / 4)));
    timer.unref();
    return () => clearInterval(timer);
}

module.exports = { savesCount, acquire, plan, stream, safeName, fileName, watchIdle, state, disposition, MAX_ACTIVE };
