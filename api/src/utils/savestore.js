const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// Сейвы игры — в _saves/<папка игры>/<ключ>.json, ключ — тот, под которым игра кладёт сейв в
// хранилище браузера. Прежние версии слотов — рядом, в _saves/.history/<игра>/<ключ>/, файл
// «<время>-<причина>.json»: время — когда версию сохранили, причина — почему она ушла из слота:
//   saved    — слот перезаписали новым сейвом
//   conflict — устройство прислало сейв старше того, что уже на сервере: на нём играли без сети,
//              а на другом за это время сохранились позже. Новый не затираем, присланный — сюда
//   deleted  — слот удалили в игре
//   import   — слот заменили сейвами из архива
//   restore  — слот заменили версией из истории: то, что было до возврата
//   merge    — сейвы игры лежали в двух папках (см. migrate), эта версия оказалась старше
// Пять последних версий слота остаются все; старше — по одной на 10 минут, кроме причин не saved:
// такие не прореживаем. Всего на слот — не больше 30
const HISTORY_DIR = '.history';
const SHOTS_DIR = '.shots';
const RECENT = 5;
const KEEP = 30;
const BUCKET_MS = 10 * 60 * 1000;
const VERSION_RE = /^(\d{1,15})-(saved|conflict|deleted|import|restore|merge)(?:-\d+)?\.json$/;

// Слот — где прогресс: «RPG File1» и «RPG <название игры> File3» у MV, «MZ_file1» и автосохранение
// «MZ_file0» у MZ. Копия слота перед записью («RPG File1bak»), настройки и общие данные — не слоты
const isSlotKey = (key) => /file\d+$/i.test(key);

// Имя папки сейвов раньше выбирала страница игры: всё, кроме латиницы, кириллицы, цифр и «._-»,
// становилось «_». У японского названия выходили одни подчёркивания, и две игры с названиями
// одной длины делили бы сейвы. Теперь папка сейвов называется как папка игры, старые переносит migrate
const legacySaveId = (id) => id.replace(/[^a-zA-Z0-9._\-а-яА-Я]/g, '_');

const fileName = (key) => `${encodeURIComponent(path.basename(key))}.json`;
const decodeName = (name) => { try { return decodeURIComponent(name); } catch { return name; } };

async function readdirSafe(dir) {
    try { return await fsp.readdir(dir); } catch { return []; }
}

async function readCurrent(file) {
    try {
        const st = await fsp.stat(file);
        return { value: await fsp.readFile(file, 'utf8'), at: st.mtimeMs, size: st.size };
    } catch {
        return null;
    }
}

// Сначала во временный файл, потом переименованием: оборванная запись не оставит слот
// наполовину записанным. Время файла — время сейва: по нему страница игры сравнивает версии
async function atomicWrite(file, value, at) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, value, 'utf8');
    await fsp.rename(tmp, file);
    const when = new Date(at);
    await fsp.utimes(file, when, when).catch(() => {});
}

async function listVersions(dir) {
    const out = [];
    for (const name of await readdirSafe(dir)) {
        const m = name.match(VERSION_RE);
        if (m) out.push({ name, at: Number(m[1]), reason: m[2] });
    }
    return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

// Какие версии лишние (список — от старых к новым)
function thin(list) {
    const keep = new Set(list.slice(-RECENT).map((v) => v.name));
    const buckets = new Set();
    for (const v of list.slice(0, Math.max(0, list.length - RECENT)).reverse()) {
        if (v.reason !== 'saved') { keep.add(v.name); continue; }
        const bucket = Math.floor(v.at / BUCKET_MS);
        if (!buckets.has(bucket)) { buckets.add(bucket); keep.add(v.name); }
    }
    const kept = list.filter((v) => keep.has(v.name));
    const drop = list.filter((v) => !keep.has(v.name));
    if (kept.length > KEEP) drop.push(...kept.slice(0, kept.length - KEEP));
    return drop;
}

function createSaveStore(root) {
    const gameDir = (id) => path.join(root, id);
    const slotFile = (id, key) => path.join(gameDir(id), fileName(key));
    const historyDir = (id, key) => path.join(root, HISTORY_DIR, id, encodeURIComponent(path.basename(key)));

    // Всё, что трогает один слот, — по очереди: два сейва подряд не должны прочитать один и тот же «текущий»
    const locks = new Map();
    const serial = (id, key, fn) => {
        const lock = `${id}\n${key}`;
        const run = (locks.get(lock) || Promise.resolve()).then(fn, fn);
        const tail = run.catch(() => {});
        locks.set(lock, tail);
        tail.then(() => { if (locks.get(lock) === tail) locks.delete(lock); });
        return run;
    };

    async function addVersion(id, key, value, at, reason) {
        const dir = historyDir(id, key);
        await fsp.mkdir(dir, { recursive: true });
        const list = await listVersions(dir);
        const stamp = Math.round(at);
        let name = `${stamp}-${reason}.json`;
        for (let n = 1; list.some((v) => v.name === name); n++) name = `${stamp}-${reason}-${n}.json`;
        await atomicWrite(path.join(dir, name), value, at);
        list.push({ name, at: stamp, reason });
        list.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
        for (const v of thin(list)) await fsp.rm(path.join(dir, v.name), { force: true });
        return name;
    }

    // Сейв от игры. updatedAt — когда его сделали на устройстве: сейв из очереди того, кто играл
    // без сети, приходит позже, но со своим временем. Время из будущего (часы устройства спешат)
    // считаем нынешним. Ответ: saved — записан, same — такой уже лежит, older — на сервере новее
    // (присланный — в истории, причина conflict)
    function write(id, key, value, updatedAt) {
        return serial(id, key, async () => {
            const now = Date.now();
            const at = Math.min(Number(updatedAt) > 0 ? Number(updatedAt) : now, now);
            await fsp.mkdir(gameDir(id), { recursive: true });
            const file = slotFile(id, key);
            if (!isSlotKey(key)) {
                await atomicWrite(file, value, at);
                return 'saved';
            }
            const current = await readCurrent(file);
            if (current && current.value === value) return 'same';
            if (current && at < current.at) {
                await addVersion(id, key, value, at, 'conflict');
                return 'older';
            }
            if (current) await addVersion(id, key, current.value, current.at, 'saved');
            await atomicWrite(file, value, at);
            return 'saved';
        });
    }

    // Все сейвы игры для страницы игры: ключ → { value, updatedAt }. Имя файла, которое не
    // раскодировать (сейв из архива «100%.json»), — как есть: из-за одного такого раньше пропадали все
    async function list(id) {
        const saves = {};
        for (const name of await readdirSafe(gameDir(id))) {
            if (!name.endsWith('.json')) continue;
            const current = await readCurrent(path.join(gameDir(id), name));
            if (current) saves[decodeName(name.slice(0, -5))] = { value: current.value, updatedAt: current.at };
        }
        return saves;
    }

    // Удалить сейв. Слот не пропадает, а уходит в историю
    function remove(id, key) {
        return serial(id, key, async () => {
            const file = slotFile(id, key);
            if (!isSlotKey(key)) return fsp.rm(file, { force: true });
            const current = await readCurrent(file);
            if (!current) return undefined;
            await addVersion(id, key, current.value, current.at, 'deleted');
            await fsp.rm(shotFile(id, key), { force: true });
            return fsp.rm(file, { force: true });
        });
    }

    // Сейвы из архива: заменённые слоты — в историю, время — нынешнее (свежие должны победить)
    async function importSaves(id, saves) {
        for (const { key, value } of saves) {
            await serial(id, key, async () => {
                await fsp.mkdir(gameDir(id), { recursive: true });
                const file = slotFile(id, key);
                const current = await readCurrent(file);
                if (current && current.value === value) return;
                if (current && isSlotKey(key)) await addVersion(id, key, current.value, current.at, 'import');
                await atomicWrite(file, value, Date.now());
                await fsp.rm(shotFile(id, key), { force: true });
            });
        }
    }

    // Слоты игры с их прежними версиями — для окна «История сейвов» (новые версии первыми)
    async function history(id) {
        const slots = new Map();
        for (const name of await readdirSafe(gameDir(id))) {
            if (!name.endsWith('.json')) continue;
            const key = decodeName(name.slice(0, -5));
            if (!isSlotKey(key)) continue;
            const file = path.join(gameDir(id), name);
            const st = await fsp.stat(file).catch(() => null);
            if (st) slots.set(key, { key, current: { at: st.mtimeMs, size: st.size, file }, versions: [] });
        }
        const base = path.join(root, HISTORY_DIR, id);
        for (const name of await readdirSafe(base)) {
            const key = decodeName(name);
            if (!isSlotKey(key)) continue;
            const versions = [];
            for (const v of (await listVersions(path.join(base, name))).reverse()) {
                const file = path.join(base, name, v.name);
                const st = await fsp.stat(file).catch(() => null);
                if (st) versions.push({ id: v.name, at: v.at, reason: v.reason, size: st.size, file });
            }
            if (!versions.length) continue;
            const slot = slots.get(key) || { key, current: null, versions: [] };
            slot.versions = versions;
            slots.set(key, slot);
        }
        const num = (key) => Number(key.match(/(\d+)$/)?.[1] ?? 0);
        return [...slots.values()].sort((a, b) => num(a.key) - num(b.key) || a.key.localeCompare(b.key));
    }

    // Вернуть версию из истории. То, что было в слоте, — в историю (причина restore): возврат
    // тоже можно отменить. Время — нынешнее: у устройств в памяти может быть прежний сейв, и
    // вернуть версию значит сделать её самой новой
    function restore(id, key, version) {
        return serial(id, key, async () => {
            if (!VERSION_RE.test(version || '')) throw Object.assign(new Error('Такой версии нет'), { status: 404 });
            const vfile = path.join(historyDir(id, key), version);
            let value;
            try { value = await fsp.readFile(vfile, 'utf8'); }
            catch { throw Object.assign(new Error('Такой версии нет'), { status: 404 }); }
            await fsp.mkdir(gameDir(id), { recursive: true });
            const file = slotFile(id, key);
            const current = await readCurrent(file);
            if (current && current.value !== value) await addVersion(id, key, current.value, current.at, 'restore');
            await atomicWrite(file, value, Date.now());
            await fsp.rm(vfile, { force: true });
            // Снимок был от того, что в слоте лежало, — к вернутой версии он не подходит
            await fsp.rm(shotFile(id, key), { force: true });
        });
    }

    // Перенести сейвы из папки from в сейвы игры id. Такой же ключ уже есть — текущим остаётся
    // тот, что новее, другой уходит в историю (причина merge). Ничего не удаляется
    async function merge(from, id) {
        for (const name of await readdirSafe(from)) {
            if (!name.endsWith('.json')) continue;
            const key = decodeName(name.slice(0, -5));
            const src = path.join(from, name);
            const st = await fsp.stat(src).catch(() => null);
            if (!st || !st.isFile()) continue;
            await serial(id, key, async () => {
                await fsp.mkdir(gameDir(id), { recursive: true });
                const dest = slotFile(id, key);
                const current = await readCurrent(dest);
                if (!current) return fsp.rename(src, dest);
                const value = await fsp.readFile(src, 'utf8');
                if (value !== current.value) {
                    if (st.mtimeMs > current.at) {
                        await addVersion(id, key, current.value, current.at, 'merge');
                        await atomicWrite(dest, value, st.mtimeMs);
                    } else {
                        await addVersion(id, key, value, st.mtimeMs, 'merge');
                    }
                }
                return fsp.rm(src, { force: true });
            });
        }
        await fsp.rmdir(from).catch(() => {});
    }

    // Сейвы, которые лежат под прежним именем папки (legacySaveId) или под именем в %-кодировке, —
    // к их игре. Имя, которое подходит нескольким играм или само является папкой игры, не трогаем
    async function migrate(ids) {
        const own = new Set(ids);
        const claims = new Map();
        for (const id of ids) {
            for (const name of new Set([legacySaveId(id), encodeURIComponent(id)])) {
                if (name === id || own.has(name) || name.startsWith('.')) continue;
                if (!claims.has(name)) claims.set(name, []);
                claims.get(name).push(id);
            }
        }
        const moved = [];
        for (const [name, owners] of claims) {
            const from = path.join(root, name);
            if (!fs.existsSync(from)) continue;
            if (owners.length > 1) {
                console.warn(`[Saves] Папка сейвов «${name}» подходит нескольким играм (${owners.join(', ')}) — оставлена как есть`);
                continue;
            }
            await merge(from, owners[0]);
            moved.push(`«${name}» → «${owners[0]}»`);
        }
        if (moved.length) console.log(`[Saves] Сейвы перенесены в папки по именам игр: ${moved.join(', ')}`);
        return moved;
    }

    // Снимок экрана к слоту — где был, когда игра сохранилась (rpg-fixes, setupCloudSaves): _saves/.shots/<игра>/<ключ>.jpg.
    // Один на слот, последний: у прежних версий снимков нет. Только JPEG и не больше 400 КБ. Время файла — время сейва,
    // к которому он снят (updatedAt с устройства, как у слота в write): так снимок узнаёт «свой» сейв при любых часах
    // устройства
    const shotFile = (id, key) => path.join(root, SHOTS_DIR, path.basename(String(id)), `${encodeURIComponent(path.basename(String(key)))}.jpg`);
    async function writeShot(id, key, jpg, updatedAt) {
        if (!isSlotKey(key) || !Buffer.isBuffer(jpg) || jpg.length > 400 * 1024 || jpg[0] !== 0xff || jpg[1] !== 0xd8) return false;
        const now = Date.now();
        const file = shotFile(id, key);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await atomicWrite(file, jpg, Math.min(Number(updatedAt) > 0 ? Number(updatedAt) : now, now));
        return true;
    }
    // { file, at } или null. Снимок не от нынешнего сейва слота (слот перезаписали без снимка — из очереди без сети,
    // вернули из истории, сейв пришёл из архива) — не отдаём: чужой кадр хуже, чем никакого. Полминуты допуска — на
    // устройство, чьи часы спешат: тогда время и слоту, и снимку ставит сервер, каждому в миг своего запроса
    async function shotOf(id, key) {
        const file = shotFile(id, key);
        const [shot, slot] = await Promise.all([fsp.stat(file).catch(() => null), fsp.stat(slotFile(id, key)).catch(() => null)]);
        if (!shot || !slot || Math.abs(shot.mtimeMs - slot.mtimeMs) > 30 * 1000) return null;
        return { file, at: shot.mtimeMs };
    }

    return { list, write, remove, importSaves, history, restore, migrate, slotFile, writeShot, shotOf };
}

module.exports = { createSaveStore, isSlotKey, legacySaveId, HISTORY_DIR, VERSION_RE };
