const fsp = require('fs').promises;
const path = require('path');
const { getFolderSize } = require('../utils/archive.js');

// Корзина. «Удалить игру» не стирает папку, а переносит её в _trash/<время>-<игра>/game вместе
// со строкой из базы (entry.json): всё, что о ней известно, — найденные данные, наигранное время,
// статус, оценка. Вернуть можно 30 дней — тостом «Отменить» сразу или из «Настроек → Корзина».
// Потом запись стирается сама. Сейвы при удалении и так не трогаем (_saves).
// Папку игры убрали мимо приложения (стёрли, перенесли) — сюда же кладётся одна строка из базы
// (vanished): вернут папку под тем же именем — игра вернётся со всеми данными (db/database.js)
const KEEP_DAYS = 30;
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;
const ENTRY_RE = /^(\d{13})-(.+)$/;

function createTrash({ db, trashDir, gamesDir, onChange = async () => {} }) {
    const entryDir = (key) => path.join(trashDir, key);
    const readEntry = async (key) => {
        try { return JSON.parse(await fsp.readFile(path.join(entryDir(key), 'entry.json'), 'utf8')); } catch { return null; }
    };
    const validKey = (key) => typeof key === 'string' && ENTRY_RE.test(key) && path.basename(key) === key;

    // Переименование — мгновенно на том же диске. Корзину вынесли на другой (TRASH_DIR) — копируем
    async function move(from, to) {
        try {
            await fsp.rename(from, to);
        } catch (e) {
            if (e.code !== 'EXDEV') throw e;
            await fsp.cp(from, to, { recursive: true, verbatimSymlinks: true });
            await fsp.rm(from, { recursive: true, force: true });
        }
    }

    // Строку игры — в корзину, папку — туда же. Сначала строка: папка без неё в корзине не нужна
    async function trashGame(id, now = Date.now()) {
        const row = await db().get('SELECT * FROM games WHERE id = ?', [id]);
        if (!row) return null;
        const key = `${now}-${id}`;
        await fsp.mkdir(entryDir(key), { recursive: true });
        await fsp.writeFile(path.join(entryDir(key), 'entry.json'), JSON.stringify({ kind: 'game', id, deletedAt: now, row }));
        await move(path.join(gamesDir, id), path.join(entryDir(key), 'game'));
        await db().run('DELETE FROM games WHERE id = ?', [id]);
        await onChange();
        return { key, id, deletedAt: now };
    }

    // Папки игры уже нет — в корзину только строка из базы
    async function keepVanished(id, now = Date.now()) {
        const row = await db().get('SELECT * FROM games WHERE id = ?', [id]);
        if (!row) return null;
        const key = `${now}-${id}`;
        await fsp.mkdir(entryDir(key), { recursive: true });
        await fsp.writeFile(path.join(entryDir(key), 'entry.json'), JSON.stringify({ kind: 'game', id, deletedAt: now, row, vanished: true }));
        await db().run('DELETE FROM games WHERE id = ?', [id]);
        await onChange();
        return { key, id, deletedAt: now };
    }

    // Папка вернулась — строку забираем из корзины: самую свежую из убранных под этим именем
    async function takeVanished(id) {
        let found = null;
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) {
            if (key.match(ENTRY_RE)[2] !== id) continue;
            const entry = await readEntry(key);
            if (entry?.kind !== 'game' || !entry.vanished || entry.id !== id) continue;
            if (!found || entry.deletedAt > found.entry.deletedAt) found = { key, entry };
        }
        if (!found) return null;
        await fsp.rm(entryDir(found.key), { recursive: true, force: true });
        return found.entry.row || null;
    }

    // База до восстановления из копии — тоже сюда: передумали — файл лежит рядом 30 дней
    async function keepFile(file, label, now = Date.now()) {
        const key = `${now}-${label}`;
        await fsp.mkdir(entryDir(key), { recursive: true });
        await fsp.writeFile(path.join(entryDir(key), 'entry.json'), JSON.stringify({ kind: 'file', id: label, deletedAt: now }));
        await move(file, path.join(entryDir(key), path.basename(file)));
        return key;
    }

    // Сколько игр в корзине — по записям, без подсчёта размеров папок (list() считает их и долго)
    async function count() {
        let n = 0;
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) if ((await readEntry(key))?.kind === 'game') n++;
        return n;
    }

    async function list(now = Date.now()) {
        const out = [];
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) {
            const entry = await readEntry(key);
            if (entry?.kind !== 'game') continue;
            const row = entry.row || {};
            out.push({
                key, id: entry.id, title: row.title || entry.id, cover: row.cover || null,
                deletedAt: entry.deletedAt, purgeAt: entry.deletedAt + KEEP_MS,
                daysLeft: Math.max(1, Math.ceil((entry.deletedAt + KEEP_MS - now) / 864e5)),
                size: await getFolderSize(path.join(entryDir(key), 'game')).catch(() => 0),
                playtime: row.playtime || 0, taken: await exists(path.join(gamesDir, entry.id)),
                vanished: !!entry.vanished,
            });
        }
        return out.sort((a, b) => b.deletedAt - a.deletedAt);
    }

    // Вернуть: папку на прежнее место, строку — какой была. Под этим именем уже другая игра
    // (загрузили заново) — не трогаем ни ту, ни эту. У записи без папки (vanished) наоборот:
    // вернуть можно, только когда папка снова на месте
    async function restore(key) {
        if (!validKey(key)) throw Object.assign(new Error('Нет такой записи в корзине'), { status: 404 });
        const entry = await readEntry(key);
        if (entry?.kind !== 'game') throw Object.assign(new Error('Нет такой записи в корзине'), { status: 404 });
        const target = path.join(gamesDir, entry.id);
        const there = await exists(target);
        if (entry.vanished && !there) throw Object.assign(new Error('Папки игры нет: положите её на место — игра вернётся сама'), { status: 409 });
        if (!entry.vanished && there) throw Object.assign(new Error('Игра с такой папкой уже есть в библиотеке'), { status: 409 });
        const cols = new Set((await db().all('PRAGMA table_info(games)')).map((c) => c.name));
        const fields = Object.keys(entry.row || {}).filter((k) => cols.has(k));
        await db().run(
            `INSERT OR REPLACE INTO games (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
            fields.map((k) => entry.row[k]),
        );
        if (!entry.vanished) await move(path.join(entryDir(key), 'game'), target);
        await fsp.rm(entryDir(key), { recursive: true, force: true });
        await onChange();
        return { id: entry.id };
    }

    // Стереть навсегда — по просьбе человека или когда 30 дней прошли
    async function remove(key) {
        if (!validKey(key) || !(await exists(entryDir(key)))) throw Object.assign(new Error('Нет такой записи в корзине'), { status: 404 });
        await fsp.rm(entryDir(key), { recursive: true, force: true });
    }

    async function purge(now = Date.now()) {
        let removed = 0;
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) {
            const entry = await readEntry(key);
            const at = entry?.deletedAt || Number(key.match(ENTRY_RE)[1]);
            if (now - at < KEEP_MS) continue;
            await fsp.rm(entryDir(key), { recursive: true, force: true });
            console.log(`[Корзина] ${key}: прошло ${KEEP_DAYS} дней — стёрто`);
            removed++;
        }
        return removed;
    }

    return { trashGame, keepVanished, takeVanished, keepFile, list, count, restore, remove, purge };
}

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

module.exports = { createTrash, KEEP_DAYS };
