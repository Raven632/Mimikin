const express = require('express');
const { secret, SECRET_SETTINGS } = require('../utils/secrets.js');
const fsp = require('fs').promises;
const path = require('path');
const util = require('util');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const dbService = require('../db/database.js');
const { GAMES_DIR, SAVES_DIR, EXTRACT_TMP, SYSTEM_DIRS } = require('../config/index.js');

const { upload, uploadLimiter } = require('../utils/upload.js');
const { invalidateGamesList } = require('../utils/cache.js');

const execFileP = util.promisify(require('child_process').execFile);

// «Скачать резервную копию» из меню: то, что не скачать заново, — база (игры, найденные данные,
// наигранное время, статусы, оценки) и сейвы. Собирается по запросу, свежая. Ночная копия
// (deploy/backup.sh) лежит на том же диске, что и библиотека: откажет он — пропадёт и она, а эта
// уходит к человеку на компьютер или телефон. Настройки сервера (.env) сюда не входят: в них ключи
const readme = (date) => `Резервная копия Mimikin от ${date}

library.db  — база: игры, найденные данные, наигранное время, статусы, оценки
_saves/     — сохранения игр, по папке на игру
games.txt   — какие игры были в библиотеке. Сами игры в копию не входят: их можно скачать заново

Как восстановить: в библиотеке «⋯ → Настройки → Копии → Восстановить из копии» и выбрать этот
архив. Данные вернутся для игр, папки которых есть в библиотеке; сейвы — для всех. Игры вернуть
в папку игр под теми же именами, что в games.txt: сохранения и данные привязаны к имени папки.
Вход, пароль и ключи остаются те, что сейчас на сервере.

Вручную (сервер не запускается): остановить сервер, положить library.db и папку _saves в папку игр
сервера (GAMES_DIR) и запустить. Входа в копии нет: сервер попросит завести учётную запись заново.
`;

// Ключ входа — он же значение куки — и учётная запись остаются только на сервере: с ключом из
// файла копии в библиотеку вошли бы без пароля. Без SESSION_SECRET в .env ключ живёт в базе.
// После восстановления сервер создаст новый ключ и попросит завести учётную запись.
// Ключ ScraperAPI из «Настроек» — тоже секрет: копия уходит и в Telegram
const PRIVATE_SETTINGS = ['session_secret', 'admin_user', 'admin_pass', ...SECRET_SETTINGS];

async function stripSecrets(file) {
    const db = await open({ filename: file, driver: sqlite3.Database });
    try {
        await db.run(`DELETE FROM settings WHERE key IN (${PRIVATE_SETTINGS.map(() => '?').join(', ')})`, PRIVATE_SETTINGS);
        // Удалённая строка остаётся в свободных страницах файла, пока их не перепишут, — VACUUM
        // собирает файл заново только из живых данных
        await db.exec('VACUUM');
    } finally {
        await db.close();
    }
}

// Собрать копию в папке dir. С паролем — архив 7z, где под паролем и содержимое, и имена файлов:
// так её отправляют в Telegram (services/telegram.js), если в .env задан BACKUP_PASSWORD
async function buildBackup(dir, { password = '' } = {}) {
    const now = new Date();
    // VACUUM INTO — согласованная копия, даже если сервер в этот миг пишет в базу
    await dbService.get().run('VACUUM INTO ?', [path.join(dir, 'library.db')]);
    await stripSecrets(path.join(dir, 'library.db'));
    const games = (await fsp.readdir(GAMES_DIR, { withFileTypes: true }))
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !SYSTEM_DIRS.includes(e.name))
        .map((e) => e.name);
    await fsp.writeFile(path.join(dir, 'games.txt'), `${games.join('\n')}\n`);
    await fsp.writeFile(path.join(dir, 'README.txt'), readme(now.toLocaleString('ru-RU')));
    const parts = ['library.db', 'games.txt', 'README.txt'].map((f) => path.join(dir, f));
    const saves = (await fsp.readdir(SAVES_DIR, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
    if (await fsp.access(SAVES_DIR).then(() => true, () => false)) parts.push(SAVES_DIR);
    const stamp = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const name = `mimikin-backup_${stamp}.${password ? '7z' : 'zip'}`;
    const file = path.join(dir, name);
    const format = password ? ['-t7z', '-mhe=on', `-p${password}`] : ['-tzip'];
    // История сейвов (_saves/.history) — страховка на сервере на ближайшие часы, в копию не идёт
    await execFileP('7zz', ['a', ...format, '-bso0', '-bsp0', '-xr!.history', file, ...parts]);
    const { size } = await fsp.stat(file);
    return { file, name, size, games: games.length, saves };
}

// --- Восстановление из копии ---
// Не подмена файла базы, а слияние: игры из копии, чьи папки есть в библиотеке, получают свои данные
// из копии; игры, добавленные после неё, остаются как есть; отложенные в «Хочу поиграть» и
// настройки — из копии, кроме входа и ключей. Сейвы — из копии, нынешние уходят в историю сейвов.
// Нынешняя база перед этим — в корзину на 30 дней (services/trash.js): передумали — она там.
// Копия из Telegram зашифрована паролем BACKUP_PASSWORD из .env — им же и открываем
const RESTORE_TABLES = ['wishlist', 'gallery_favorites'];

async function columnsOf(db, schema, table) {
    return (await db.all(`PRAGMA ${schema}.table_info(${table})`)).map((c) => c.name);
}

async function unpackBackup(archive, dir) {
    // Без -p 7-Zip спросил бы пароль и ждал ответа вечно
    const pass = `-p${secret('backup') || 'no-password'}`;
    let listing;
    try {
        ({ stdout: listing } = await execFileP('7zz', ['l', '-ba', '-slt', pass, archive], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
        const text = `${e.stdout || ''}${e.stderr || ''}`;
        if (/password|encrypted/i.test(text)) throw Object.assign(new Error('Копия под паролем, а пароль копий в «Настройках» (или BACKUP_PASSWORD в .env) к ней не подходит'), { status: 400 });
        throw Object.assign(new Error('Это не архив резервной копии'), { status: 400 });
    }
    // Имена в архиве не выводят за папку распаковки (Zip Slip)
    const base = path.resolve(dir) + path.sep;
    for (const line of listing.split('\n').filter((l) => l.startsWith('Path = '))) {
        if (!path.resolve(dir, line.slice(7).trim()).startsWith(base)) throw Object.assign(new Error('Это не архив резервной копии'), { status: 400 });
    }
    try {
        await execFileP('7zz', ['x', '-y', '-bso0', '-bsp0', pass, `-o${dir}`, archive], { maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
        if (/password/i.test(`${e.stdout || ''}${e.stderr || ''}`)) throw Object.assign(new Error('Копия под паролем, а пароль копий в «Настройках» (или BACKUP_PASSWORD в .env) к ней не подходит'), { status: 400 });
        throw e;
    }
    // library.db — в корне архива; архив, пересобранный руками, мог положить всё в одну папку
    for (const root of [dir, ...(await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== '_saves').map((e) => path.join(dir, e.name))]) {
        if (await fsp.access(path.join(root, 'library.db')).then(() => true, () => false)) return root;
    }
    throw Object.assign(new Error('В архиве нет library.db — это не резервная копия библиотеки'), { status: 400 });
}

async function restoreBackup(root, { trash, store, onSave = async () => {} }) {
    const file = path.join(root, 'library.db');
    // Целая ли база в копии и та ли это база
    const check = await open({ filename: file, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        const ok = await check.get('PRAGMA quick_check').catch(() => null);
        const hasGames = await check.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'").catch(() => null);
        if (ok?.quick_check !== 'ok' || !hasGames) throw Object.assign(new Error('База в копии повреждена или это не база библиотеки'), { status: 400 });
    } finally {
        await check.close();
    }

    const db = dbService.get();
    const before = path.join(path.dirname(root), `library-before-restore-${Date.now()}.db`);
    await db.run('VACUUM INTO ?', [before]);
    const keptKey = await trash.keepFile(before, 'library-before-restore');

    const present = new Set((await fsp.readdir(GAMES_DIR, { withFileTypes: true }))
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !SYSTEM_DIRS.includes(e.name)).map((e) => e.name));
    const result = { games: 0, missing: [], saves: 0, keptKey };
    await db.run('ATTACH DATABASE ? AS bk', [file]);
    try {
        await db.exec('BEGIN');
        try {
            const mine = new Set(await columnsOf(db, 'main', 'games'));
            const cols = (await columnsOf(db, 'bk', 'games')).filter((c) => mine.has(c));
            const list = cols.join(', ');
            for (const { id } of await db.all('SELECT id FROM bk.games')) {
                if (!present.has(id)) { result.missing.push(id); continue; }
                await db.run(`INSERT OR REPLACE INTO main.games (${list}) SELECT ${list} FROM bk.games WHERE id = ?`, [id]);
                result.games++;
            }
            for (const table of RESTORE_TABLES) {
                const theirs = await columnsOf(db, 'bk', table);
                const ours = new Set(await columnsOf(db, 'main', table));
                const both = theirs.filter((c) => ours.has(c)).join(', ');
                if (both) await db.run(`INSERT OR REPLACE INTO main.${table} (${both}) SELECT ${both} FROM bk.${table}`);
            }
            await db.run(
                `INSERT OR REPLACE INTO main.settings (key, value) SELECT key, value FROM bk.settings WHERE key NOT IN (${PRIVATE_SETTINGS.map(() => '?').join(', ')})`,
                PRIVATE_SETTINGS,
            );
            await db.exec('COMMIT');
        } catch (e) {
            await db.exec('ROLLBACK').catch(() => {});
            throw e;
        }
    } finally {
        await db.run('DETACH DATABASE bk').catch(() => {});
    }

    // Сейвы: _saves/<игра>/<ключ>.json, как их кладёт utils/savestore.js
    const savesDir = path.join(root, '_saves');
    for (const id of await fsp.readdir(savesDir).catch(() => [])) {
        if (id.startsWith('.') || path.basename(id) !== id) continue;
        const saves = [];
        for (const name of await fsp.readdir(path.join(savesDir, id)).catch(() => [])) {
            if (!name.endsWith('.json')) continue;
            let key = name.slice(0, -5);
            try { key = decodeURIComponent(key); } catch { /* имя как есть */ }
            saves.push({ key, value: await fsp.readFile(path.join(savesDir, id, name), 'utf8') });
        }
        if (!saves.length) continue;
        await store.importSaves(id, saves);
        await onSave(id);
        result.saves += saves.length;
    }
    // Моменты (_saves/.marks/<игра>, utils/marks.js) — добавляются те, которых здесь нет; свои не трогаем
    const marksDir = path.join(savesDir, '.marks');
    for (const id of await fsp.readdir(marksDir).catch(() => [])) {
        if (id.startsWith('.') || path.basename(id) !== id) continue;
        await fsp.cp(path.join(marksDir, id), path.join(SAVES_DIR, '.marks', id), {
            recursive: true, force: false, errorOnExist: false, filter: (src) => path.basename(src) !== '.deleted',
        }).catch(() => {});
    }
    // «Путь» (_saves/.journal/<игра>, utils/journal.js) — так же: чего здесь нет, то и возвращаем
    const journalDir = path.join(savesDir, '.journal');
    for (const id of await fsp.readdir(journalDir).catch(() => [])) {
        if (id.startsWith('.') || path.basename(id) !== id) continue;
        await fsp.cp(path.join(journalDir, id), path.join(SAVES_DIR, '.journal', id), { recursive: true, force: false, errorOnExist: false }).catch(() => {});
    }
    result.missing.sort();
    return result;
}

const router = express.Router();

router.get('/', async (req, res) => {
    const dir = await fsp.mkdtemp(path.join(EXTRACT_TMP, 'backup_'));
    const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    try {
        const { file, name } = await buildBackup(dir);
        res.download(file, name, cleanup);
    } catch (e) {
        await cleanup();
        console.error('[Backup]', e.message);
        if (!res.headersSent) res.status(500).json({ error: 'Не удалось собрать резервную копию' });
    }
});

let restoring = false;
router.post('/restore', uploadLimiter, upload.single('backup'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const archive = req.file.path;
    if (restoring) {
        await fsp.rm(archive, { force: true });
        return res.status(409).json({ error: 'Копия уже восстанавливается' });
    }
    restoring = true;
    const dir = await fsp.mkdtemp(path.join(EXTRACT_TMP, 'restore_'));
    try {
        // Здесь, а не наверху файла: saves.js и games.js сами тянут много модулей
        const { trash } = require('./games.js');
        const { store } = require('./saves.js');
        const { updateProgress } = require('../utils/saveprogress.js');
        const root = await unpackBackup(archive, dir);
        const result = await restoreBackup(root, { trash, store, onSave: (id) => updateProgress(id).catch(() => {}) });
        await invalidateGamesList();
        console.log(`[Backup] Восстановлено из копии: игр ${result.games}, без папки ${result.missing.length}, сейвов ${result.saves}`);
        res.json({ success: true, ...result });
    } catch (e) {
        if (!e.status) console.error('[Backup] Восстановление:', e.message);
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось восстановить копию' });
    } finally {
        restoring = false;
        await fsp.rm(archive, { force: true }).catch(() => {});
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

module.exports = router;
module.exports.restoreBackup = restoreBackup;
module.exports.unpackBackup = unpackBackup;
module.exports.stripSecrets = stripSecrets;
module.exports.buildBackup = buildBackup;
module.exports.PRIVATE_SETTINGS = PRIVATE_SETTINGS;
