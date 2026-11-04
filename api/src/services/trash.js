const fsp = require('fs').promises;
const path = require('path');
const { getFolderSize } = require('../utils/archive.js');

// Корзина. «Удалить игру» не стирает папку, а переносит её в _trash/<время>-<игра>/game вместе
// со строкой из базы (entry.json): всё, что о ней известно, — найденные данные, наигранное время,
// статус, оценка. Вернуть можно 30 дней — тостом «Отменить» сразу или из «Настроек → Корзина».
// Потом запись стирается сама. Сейвы при удалении и так не трогаем (_saves).
// Папку игры убрали мимо приложения (стёрли, перенесли) — сюда же кладётся одна строка из базы
// (vanished): вернут папку под тем же именем — игра вернётся со всеми данными (db/database.js)
// «На полку» (shelf) — наоборот: сюда уходит только папка, а строка остаётся в библиотеке с пометкой shelved_at.
// Карточка, сейвы, моменты и наигранное время — при игре; вернуть файлы — отсюда, пока не прошли 30 дней, потом —
// «Скачать снова» или своим архивом (services/uploads.js: новая версия встаёт на место игры с полки)
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

    // Строку игры — в корзину, папку — туда же. Сначала строка: папка без неё в корзине не нужна.
    // Игра с полки: её файлы, если они ещё здесь, переезжают в эту же запись — вернут её, и игра встанет целиком
    async function trashGame(id, now = Date.now()) {
        const row = await db().get('SELECT * FROM games WHERE id = ?', [id]);
        if (!row) return null;
        const key = `${now}-${id}`;
        await fsp.mkdir(entryDir(key), { recursive: true });
        await fsp.writeFile(path.join(entryDir(key), 'entry.json'), JSON.stringify({ kind: 'game', id, deletedAt: now, row }));
        try {
            if (!row.shelved_at) await move(path.join(gamesDir, id), path.join(entryDir(key), 'game'));
            else {
                const shelf = (await shelves()).get(id);
                if (shelf) {
                    await move(path.join(entryDir(shelf.key), 'game'), path.join(entryDir(key), 'game'));
                    await fsp.rm(entryDir(shelf.key), { recursive: true, force: true });
                }
            }
            await db().run('DELETE FROM games WHERE id = ?', [id]);
        } catch (e) {
            // Строка не стёрлась, а папка уже здесь — обратно: игра осталась в библиотеке, в корзине ей быть незачем.
            // Запись без файлов не нужна; с остатком переезда на другой диск (cp, потом rm) — не трогаем, как у полки
            const here = path.join(entryDir(key), 'game');
            if (!row.shelved_at && !(await exists(path.join(gamesDir, id))) && await exists(here)) await move(here, path.join(gamesDir, id)).catch(() => {});
            if (!(await exists(here))) await fsp.rm(entryDir(key), { recursive: true, force: true });
            throw e;
        }
        await onChange();
        return { key, id, deletedAt: now };
    }

    // «На полку»: папка — сюда, строка остаётся с пометкой. Сначала папка, потом пометка: оборвётся между ними —
    // сверка библиотеки найдёт папку здесь и пометку поставит сама (db/database.js, syncDatabase)
    async function shelveGame(id, now = Date.now()) {
        const row = await db().get('SELECT title, cover FROM games WHERE id = ?', [id]);
        if (!row) return null;
        const key = `${now}-${id}`;
        // Запись — своя, новая: два запроса в одну миллисекунду не делят одну, и убираем при сбое только её
        await fsp.mkdir(trashDir, { recursive: true });
        await fsp.mkdir(entryDir(key));
        await fsp.writeFile(path.join(entryDir(key), 'entry.json'), JSON.stringify({ kind: 'shelf', id, deletedAt: now, title: row.title || id, cover: row.cover || null }));
        try {
            await move(path.join(gamesDir, id), path.join(entryDir(key), 'game'));
        } catch (e) {
            // Убираем запись, только если файлов игры в ней нет: переезд на другой диск (cp, потом rm) мог оборваться уже
            // после копии — тогда копия здесь может быть единственной целой
            if (!(await exists(path.join(entryDir(key), 'game')))) await fsp.rm(entryDir(key), { recursive: true, force: true });
            throw e;
        }
        await db().run('UPDATE games SET shelved_at = ? WHERE id = ?', [now, id]);
        await onChange();
        return { key, id, shelvedAt: now };
    }

    // Файлы игр с полки, что ещё лежат здесь: игра → { key, purgeAt } самой свежей записи. Запись без папки game (её
    // вернули, а стереть запись не успели) — уже не полка
    async function shelves() {
        const out = new Map();
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) {
            const entry = await readEntry(key);
            if (entry?.kind !== 'shelf' || out.get(entry.id)?.at > entry.deletedAt || !(await exists(path.join(entryDir(key), 'game')))) continue;
            out.set(entry.id, { key, at: entry.deletedAt, purgeAt: entry.deletedAt + KEEP_MS });
        }
        return out;
    }

    // На место игры с полки встала новая версия (services/uploads.js), а её прежние файлы ещё здесь — они уезжают в to
    // (_old/<игра>/<дата>): прежняя версия, как при обычном обновлении. false — файлов здесь уже нет
    async function shelfToOld(id, to) {
        const shelf = (await shelves()).get(id);
        if (!shelf) return false;
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await move(path.join(entryDir(shelf.key), 'game'), to);
        await fsp.rm(entryDir(shelf.key), { recursive: true, force: true });
        await onChange();
        return true;
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

    // Строка в записи корзины устарела: склейка забрала у неё наигранное время (services/copies.js)
    async function updateRow(key, fields) {
        const entry = await readEntry(key);
        if (entry?.row) await fsp.writeFile(path.join(entryDir(key), 'entry.json'), JSON.stringify({ ...entry, row: { ...entry.row, ...fields } }));
    }

    const listed = (entry) => entry?.kind === 'game' || entry?.kind === 'shelf';

    // Сколько игр в корзине — по записям, без подсчёта размеров папок (list() считает их и долго)
    async function count() {
        let n = 0;
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) if (listed(await readEntry(key))) n++;
        return n;
    }

    async function list(now = Date.now()) {
        const out = [];
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) {
            const entry = await readEntry(key);
            if (!listed(entry) || (entry.kind === 'shelf' && !(await exists(path.join(entryDir(key), 'game'))))) continue;
            const row = entry.row || { title: entry.title, cover: entry.cover };
            out.push({
                key, id: entry.id, title: row.title || entry.id, cover: row.cover || null,
                deletedAt: entry.deletedAt, purgeAt: entry.deletedAt + KEEP_MS,
                daysLeft: Math.max(1, Math.ceil((entry.deletedAt + KEEP_MS - now) / 864e5)),
                size: await getFolderSize(path.join(entryDir(key), 'game')).catch(() => 0),
                playtime: row.playtime || 0, taken: await exists(path.join(gamesDir, entry.id)),
                vanished: !!entry.vanished, shelf: entry.kind === 'shelf',
            });
        }
        return out.sort((a, b) => b.deletedAt - a.deletedAt);
    }

    // Вернуть: папку на прежнее место, строку — какой была. Под этим именем уже другая игра
    // (загрузили заново) — не трогаем ни ту, ни эту. У записи без папки (vanished) наоборот:
    // вернуть можно, только когда папка снова на месте. Файлы с полки — к своей карточке: игра снова играется.
    // Карточка с полки без файлов (их срок вышел раньше) — встаёт обратно на полку
    async function restore(key) {
        if (!validKey(key)) throw Object.assign(new Error('Нет такой записи в корзине'), { status: 404 });
        const entry = await readEntry(key);
        if (!listed(entry)) throw Object.assign(new Error('Нет такой записи в корзине'), { status: 404 });
        const target = path.join(gamesDir, entry.id);
        const there = await exists(target);
        const taken = () => Object.assign(new Error('Игра с такой папкой уже есть в библиотеке'), { status: 409 });
        if (entry.kind === 'shelf') {
            const row = await db().get('SELECT shelved_at FROM games WHERE id = ?', [entry.id]);
            if (there || !row?.shelved_at) throw taken();
            await move(path.join(entryDir(key), 'game'), target);
            await db().run('UPDATE games SET shelved_at = 0 WHERE id = ?', [entry.id]);
            await fsp.rm(entryDir(key), { recursive: true, force: true });
            await onChange();
            return { id: entry.id };
        }
        const files = !entry.vanished && await exists(path.join(entryDir(key), 'game'));
        if (entry.vanished && !there) throw Object.assign(new Error('Папки игры нет: положите её на место — игра вернётся сама'), { status: 409, reason: 'trash-vanished' });
        // Игру удалили, а строка её вернулась карточкой на полке (восстановили копию, routes/backup.js): файлы — к карточке,
        // иначе они пролежали бы здесь 30 дней без возможности вернуть. Строка — та, что сейчас в библиотеке; обложку из
        // папки игры копия обнулила, пока папки не было, поэтому пустую берём из записи
        const card = files && !there && await db().get('SELECT shelved_at FROM games WHERE id = ?', [entry.id]);
        if (card?.shelved_at > 0) {
            await move(path.join(entryDir(key), 'game'), target);
            await db().run("UPDATE games SET shelved_at = 0, cover = COALESCE(NULLIF(cover, ''), ?) WHERE id = ?", [entry.row?.cover || null, entry.id]);
            await fsp.rm(entryDir(key), { recursive: true, force: true });
            await onChange();
            return { id: entry.id };
        }
        if (!entry.vanished && (there || await db().get('SELECT id FROM games WHERE id = ?', [entry.id]))) throw taken();
        const cols = new Set((await db().all('PRAGMA table_info(games)')).map((c) => c.name));
        const fields = Object.keys(entry.row || {}).filter((k) => cols.has(k));
        await db().run(
            `INSERT OR REPLACE INTO games (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
            fields.map((k) => entry.row[k]),
        );
        if (files) {
            await move(path.join(entryDir(key), 'game'), target);
            await db().run('UPDATE games SET shelved_at = 0 WHERE id = ?', [entry.id]);
        }
        await fsp.rm(entryDir(key), { recursive: true, force: true });
        await onChange();
        return { id: entry.id };
    }

    // Игры больше нет ни в библиотеке, ни в корзине — доступ людей к ней (user_game_access) стираем: другая игра с тем же именем
    // папки, появившись потом, не должна открыться тем, кому открывали эту. Пока запись хоть одна лежит в корзине, игру ещё можно
    // вернуть — и доступ при ней. У игры с полки в библиотеке остаётся карточка, так что ничего не стирается
    async function forgetAccess(id) {
        if (!id || await db().get('SELECT 1 FROM games WHERE id = ?', [id])) return;
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) if (key.match(ENTRY_RE)[2] === id) return;
        await db().run('DELETE FROM user_game_access WHERE game_id = ?', [id]);
        await db().run("UPDATE user_requests SET game_id = '' WHERE game_id = ?", [id]);
        // И дни игры: иначе новая игра с тем же именем папки получила бы чужую историю
        await db().run('DELETE FROM play_days WHERE game_id = ?', [id]);
    }

    // Стереть навсегда — по просьбе человека или когда 30 дней прошли
    // У игры с полки — только её файлы: карточка остаётся, вернуть её можно «Скачать снова»
    async function remove(key) {
        if (!validKey(key) || !(await exists(entryDir(key)))) throw Object.assign(new Error('Нет такой записи в корзине'), { status: 404 });
        const entry = await readEntry(key);
        await fsp.rm(entryDir(key), { recursive: true, force: true });
        await forgetAccess(entry?.id || key.match(ENTRY_RE)[2]);
        await onChange();
    }

    async function purge(now = Date.now()) {
        let removed = 0;
        for (const key of (await fsp.readdir(trashDir).catch(() => [])).filter(validKey)) {
            const entry = await readEntry(key);
            const at = entry?.deletedAt || Number(key.match(ENTRY_RE)[1]);
            if (now - at < KEEP_MS) continue;
            await fsp.rm(entryDir(key), { recursive: true, force: true });
            await forgetAccess(entry?.id || key.match(ENTRY_RE)[2]);
            console.log(`[Корзина] ${key}: прошло ${KEEP_DAYS} дней — стёрто`);
            removed++;
        }
        if (removed) await onChange();
        return removed;
    }

    return { trashGame, shelveGame, shelves, shelfToOld, keepVanished, takeVanished, keepFile, updateRow, list, count, restore, remove, purge };
}

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

module.exports = { createTrash, KEEP_DAYS };
