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
const { isGameId } = require('./play.js');
const { cleanName, nameFits, nameTaken } = require('../utils/account.js');
const avatars = require('../utils/avatars.js');
const { storesFor, rootOf, PEOPLE_DIR } = require('../utils/personStores.js');

const execFileP = util.promisify(require('child_process').execFile);

// «Скачать резервную копию» из меню: то, что не скачать заново, — база (игры, найденные данные,
// наигранное время, статусы, оценки) и сейвы. Собирается по запросу, свежая. Ночная копия
// (deploy/backup.sh) лежит на том же диске, что и библиотека: откажет он — пропадёт и она, а эта
// уходит к человеку на компьютер или телефон. Настройки сервера (.env) сюда не входят: в них ключи.
// Readme по-английски: копию собирают и без запроса (Telegram, раз в сутки), языка спросить не у кого
const readme = (date) => `Mimikin backup from ${date}

library.db  - the database: games, found details, play time, statuses, ratings, translations
_saves/     - game saves, one folder per game. When the library has other people, their saves are in _saves/.people
games.txt   - which games were in the library. The games themselves are not in the backup: download them again

To restore: in the library open "... > Settings > Backups > Restore from a backup" and choose this
archive. Games whose folders are in the library come back whole. The others wait on the shelf as cards,
with their play time, status, notes, lists, saves and moments. Upload a game's archive, or put its folder
back under the name in games.txt, and it takes its place with all of that. Your login, password and keys
stay as they are on the server now. Other people come back with their data but without a password: set a new one for each in Settings.

By hand (the server does not start): stop the server, put library.db and the _saves folder into the
server's games folder (GAMES_DIR) and start it. The backup has no login: the server asks you to create an account again.
`;

// Ключ входа — он же значение куки — и учётная запись остаются только на сервере: с ключом из
// файла копии в библиотеку вошли бы без пароля. Без SESSION_SECRET в .env ключ живёт в базе.
// После восстановления сервер создаст новый ключ и попросит завести учётную запись.
// Ключ ScraperAPI из «Настроек» — тоже секрет: копия уходит и в Telegram
// Окно старой куки и эпоха входов — тоже только серверу: из копии, сделанной до смены пароля, окно открылось бы заново
const PRIVATE_SETTINGS = ['session_secret', 'admin_user', 'admin_pass', 'legacy_session_until', 'accounts_epoch', ...SECRET_SETTINGS];

async function stripSecrets(file) {
    const db = await open({ filename: file, driver: sqlite3.Database });
    try {
        await db.run(`DELETE FROM settings WHERE key IN (${PRIVATE_SETTINGS.map(() => '?').join(', ')})`, PRIVATE_SETTINGS);
        // Входы устройств и хэши паролей людей: в копии (она уходит и в Telegram) им делать нечего
        const has = async (name) => !!(await db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
        if (await has('sessions')) await db.run('DELETE FROM sessions');
        if (await has('users')) await db.run("UPDATE users SET pass_hash = ''");
        // Чаты людей с ботом в копию не идут: человек привяжет свой заново (services/telegram.js)
        if ((await columnsOf(db, 'main', 'users')).includes('tg_chat')) await db.run("UPDATE users SET tg_chat = '', tg_name = '', tg_lang = ''");
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
// Не подмена файла базы, а слияние: игры из копии получают свои данные из копии; чьей папки в библиотеке нет — встаёт
// карточкой на полку и ждёт свой архив или папку (utils/audit.js, shelfMatches); игры, добавленные после копии, остаются
// как есть; отложенные в «Хочу поиграть» и настройки — из копии, кроме входа и ключей. Сейвы — из копии, нынешние уходят
// в историю сейвов.
// Нынешняя база перед этим — в корзину на 30 дней (services/trash.js): передумали — она там.
// Копия из Telegram зашифрована паролем BACKUP_PASSWORD из .env — им же и открываем

// Таблицы, которые вливаются кроме игр и настроек: то, что даром не вернуть, — перевод, оплаченный квотой DeepL, и
// разобранные картинки с правками. game — столбец с игрой: строки игр, которых после восстановления нет, ни к чему не
// привязаны. newer — своя строка новее копии остаётся; без него своя строка главнее всегда: у game_pictures она про
// файл, что лежит в папке сейчас, а заплатка определена своим хэшем. Что человек сделал сам, главнее машинного при любой
// дате (rank — как в services/translate.js и pictures.js). Шедшие в копии задачи — на паузу: здесь их никто не ведёт, а
// при перезапуске сервер запустил бы их и для игры без папки
const ownLine = (t) => `CASE ${t}.origin WHEN 'failed' THEN 0 WHEN 'machine' THEN 1 WHEN 'glossary' THEN 2 ELSE 3 END`;
const ownLabels = (t) => `(${t}.labels LIKE '%"checked":true%' OR ${t}.labels LIKE '%"source":"manual"%')`;
const paused = "CASE WHEN state IN ('running', 'queued') THEN 'paused' ELSE state END";
const RESTORE_TABLES = [
    { table: 'gallery_favorites', game: 'game_id', newer: true },
    // «Не дубликат»: ответ человека, повторно спрашивать незачем
    { table: 'not_duplicates' },
    // 'failed' — не работа, а пустая отметка «не вышло»: новая служба попробует строку ещё раз
    { table: 'translations', where: "origin != 'failed'", newer: true, rank: ownLine },
    { table: 'game_translation', game: 'id', newer: true, values: { state: paused } },
    { table: 'picture_text', newer: true, rank: ownLabels },
    { table: 'picture_patches' },
    { table: 'game_pictures', game: 'game_id' },
    { table: 'picture_jobs', game: 'game_id', newer: true, values: { state: paused } },
    // Личное людей (services/personal.js). Без game: строки переживают удаление игры, как сейвы. Только тех людей, что есть
    // здесь после слияния users: строка без человека никому не видна
    ...['user_games', 'user_wishlist', 'user_gallery_favorites'].map((table) => ({ table, where: 'user_id IN (SELECT id FROM main.users)', newer: true })),
    // Дни игры (utils/saveprogress.js). Своя строка остаётся: день, начатый после копии, в ней неполон, а сложить нельзя — посчитается
    // дважды. Строки игр, которых нет, — ни к чему: стёртую игру корзина из этой таблицы уже убрала
    { table: 'play_days', game: 'game_id', where: "(user_id = 'owner' OR user_id IN (SELECT id FROM main.users))" },
    // Запросы (services/requests.js). Записи о загрузках в копии нет, а «да» из копии не должно само открыть игру, закрытую с тех пор:
    // шедшие — сразу «не вышло», их можно повторить или нажать снова
    { table: 'user_requests', where: 'user_id IN (SELECT id FROM main.users)', newer: true, values: {
        status: "CASE WHEN status = 'approved' THEN 'failed' ELSE status END",
        why: "CASE WHEN status = 'approved' THEN 'job-gone' ELSE why END",
        job: "CASE WHEN status = 'approved' THEN '' ELSE job END",
    } },
];

async function columnsOf(db, schema, table) {
    return (await db.all(`PRAGMA ${schema}.table_info(${table})`)).map((c) => c.name);
}

// В копии старой версии таблицы может не быть — тогда нечего и вливать
async function mergeTable(db, { table, game, where, newer, rank = () => '0', values = {} }) {
    const info = await db.all(`PRAGMA main.table_info(${table})`);
    const theirs = new Set(await columnsOf(db, 'bk', table));
    const both = info.map((c) => c.name).filter((c) => theirs.has(c));
    const key = info.filter((c) => c.pk).map((c) => c.name);
    if (!both.length || !key.every((c) => theirs.has(c))) return;
    const filter = [where, game && `${game} IN (SELECT id FROM main.games)`].filter(Boolean).join(' AND ') || '1';
    const [mine, copy] = [rank(table), rank('excluded')];
    const update = both.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
    const onConflict = newer ? `DO UPDATE SET ${update} WHERE ${copy} > ${mine} OR (${copy} = ${mine} AND excluded.at > ${table}.at)` : 'DO NOTHING';
    await db.run(`INSERT INTO main.${table} (${both.join(', ')}) SELECT ${both.map((c) => values[c] || c).join(', ')} FROM bk.${table}
        WHERE ${filter} ON CONFLICT(${key.join(', ')}) ${onConflict}`);
}

// Обложки и скриншоты лежат в _media и папках игр, а этого в копии нет. Мёртвый адрес карточка показала бы сломанной
// картинкой, а поиск данных счёл бы, что всё уже есть. Без адреса — обычная пустая обложка; игра вернётся — обложка
// найдётся в её файлах (database.js, refreshGame)
async function liveMedia(row, there) {
    const alive = (rel) => fsp.access(path.join(GAMES_DIR, rel)).then(() => true, () => false);
    const dir = path.join(GAMES_DIR, row.id);
    let { cover, screens } = row;
    if (cover && !(await alive(cover))) cover = there ? (await dbService.ownCover(row.id, dir)) || (await dbService.gameImageCover(row.id, dir)) : null;
    let list = null;
    try { list = JSON.parse(screens || '[]'); } catch { /* строка как есть */ }
    if (Array.isArray(list)) {
        const kept = [];
        for (const rel of list) if (await alive(String(rel))) kept.push(rel);
        if (kept.length !== list.length) screens = JSON.stringify(kept);
    }
    return { cover: cover ?? null, screens: screens ?? '' };
}

// Люди из копии: кого здесь нет — заводим с тем же id (по нему лежат их строки и папка сейвов), но без пароля: хэшей в копии
// нет. Войти нельзя, пока владелец не задаст новый. Своя строка с тем же id главнее (в том числе её имя и state). Имя занято
// другим человеком, в том числе убранным, (или это имя владельца) — «Имя (2)»: имена уникальны, а чужого человека не склеиваем
// с нашим по одному имени. Копия старее столбцов (нет must_change, created_at, state) — берём то, что есть: иначе вся
// восстановленная копия откатилась бы из-за одной отсутствующей колонки. Возвращает id людей, заведённых этим восстановлением:
// только им копия задаёт, какие игры они видят (restoreAccess)
const PERSON_ID = /^u[0-9a-f]{16}$/;
async function mergePeople(db) {
    const created = [];
    const theirs = new Set(await columnsOf(db, 'bk', 'users'));
    if (!theirs.has('id') || !theirs.has('name')) return created;
    const pick = (col, fallback) => (theirs.has(col) ? col : `${fallback} AS ${col}`);
    const rows = await db.all(`SELECT id, name, ${pick('must_change', '0')}, ${pick('created_at', '0')}, ${pick('state', "''")}, ${pick('games_limited', '0')}, ${pick('may_request', '1')}, ${pick('may_download', '0')}, ${pick('may_upload', '0')}, ${pick('may_view', '0')} FROM bk.users`);
    for (const row of rows) {
        // Вход ищет имя в той же форме (utils/account.js, cleanName), поэтому и здесь: с пробелом по краям или невидимым знаком
        // человек не вошёл бы
        const base = cleanName(String(row.name || ''));
        if (!PERSON_ID.test(row.id) || !nameFits(base)) continue;
        if (await db.get('SELECT 1 FROM main.users WHERE id = ?', [row.id])) continue;
        let name = base;
        for (let i = 2; await nameTaken(db, name); i++) name = `${base} (${i})`;
        await db.run("INSERT INTO main.users (id, name, pass_hash, must_change, created_at, state, games_limited, may_request, may_download, may_upload, may_view) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)",
            [row.id, name, row.must_change ? 1 : 0, Number(row.created_at) || 0, ['locked', 'removed'].includes(row.state) ? row.state : '', row.games_limited ? 1 : 0,
                row.may_request ? 1 : 0, row.may_download ? 1 : 0, row.may_upload ? 1 : 0, row.may_view ? 1 : 0]);
        created.push(row.id);
    }
    return created;
}

// Какие игры видит человек (services/gameAccess.js) — отдельным шагом, а не в RESTORE_TABLES: слияние таблиц вставляет и
// строки, которых здесь нет, а снятый доступ — это удалённая строка, следа не оставляет. Копия постарше вернула бы закрытое.
// Поэтому копия задаёт список только заведённым ею людям; у тех, кто здесь уже есть, остаётся нынешний — флаг и строки. Копия
// без этой таблицы (старая) списка не несёт: её человек будет со всеми играми, как тогда
async function restoreAccess(db, created) {
    if (!created.length || !(await columnsOf(db, 'bk', 'user_game_access')).includes('game_id')) return;
    await db.run(`INSERT OR IGNORE INTO main.user_game_access (user_id, game_id, at) SELECT user_id, game_id, at FROM bk.user_game_access
        WHERE user_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(created)]);
}

async function unpackBackup(archive, dir) {
    // Без -p 7-Zip спросил бы пароль и ждал ответа вечно
    const pass = `-p${secret('backup') || 'no-password'}`;
    let listing;
    try {
        ({ stdout: listing } = await execFileP('7zz', ['l', '-ba', '-slt', pass, archive], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
        const text = `${e.stdout || ''}${e.stderr || ''}`;
        if (/password|encrypted/i.test(text)) throw Object.assign(new Error('Копия под паролем, а пароль копий в «Настройках» (или BACKUP_PASSWORD в .env) к ней не подходит'), { status: 400, reason: 'backup-password' });
        throw Object.assign(new Error('Это не архив резервной копии'), { status: 400, reason: 'backup-not-archive' });
    }
    // Имена в архиве не выводят за папку распаковки (Zip Slip)
    const base = path.resolve(dir) + path.sep;
    for (const line of listing.split('\n').filter((l) => l.startsWith('Path = '))) {
        if (!path.resolve(dir, line.slice(7).trim()).startsWith(base)) throw Object.assign(new Error('Это не архив резервной копии'), { status: 400, reason: 'backup-not-archive' });
    }
    try {
        await execFileP('7zz', ['x', '-y', '-bso0', '-bsp0', pass, `-o${dir}`, archive], { maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
        if (/password/i.test(`${e.stdout || ''}${e.stderr || ''}`)) throw Object.assign(new Error('Копия под паролем, а пароль копий в «Настройках» (или BACKUP_PASSWORD в .env) к ней не подходит'), { status: 400, reason: 'backup-password' });
        throw e;
    }
    // library.db — в корне архива; архив, пересобранный руками, мог положить всё в одну папку
    for (const root of [dir, ...(await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== '_saves').map((e) => path.join(dir, e.name))]) {
        if (await fsp.access(path.join(root, 'library.db')).then(() => true, () => false)) return root;
    }
    throw Object.assign(new Error('В архиве нет library.db — это не резервная копия библиотеки'), { status: 400, reason: 'backup-no-db' });
}

// Сейвы, моменты и «путь» одного человека: fromRoot — его _saves в распакованной копии, toRoot — где они лежат здесь
// (у владельца _saves, у остальных — их папка в .people), store — сейвы того же человека. Возвращает число файлов сейвов
async function restoreRoot(fromRoot, toRoot, { store, onSave = async () => {}, present }) {
    let count = 0;
    // Сейвы: _saves/<игра>/<ключ>.json, как их кладёт utils/savestore.js
    for (const id of await fsp.readdir(fromRoot).catch(() => [])) {
        if (id.startsWith('.') || path.basename(id) !== id) continue;
        const saves = [];
        for (const name of await fsp.readdir(path.join(fromRoot, id)).catch(() => [])) {
            if (!name.endsWith('.json')) continue;
            let key = name.slice(0, -5);
            try { key = decodeURIComponent(key); } catch { /* имя как есть */ }
            saves.push({ key, value: await fsp.readFile(path.join(fromRoot, id, name), 'utf8') });
        }
        if (!saves.length) continue;
        await store.importSaves(id, saves);
        // Прогресс считается по карте из файлов игры: у карточки без папки он потерял бы название места из копии
        if (present.has(id)) await onSave(id);
        count += saves.length;
    }
    // Картинка человека (.avatar.jpg в корне) — если здесь своей нет; проверки — в utils/avatars.js
    await avatars.restore(fromRoot, toRoot).catch(() => {});
    // Моменты (_saves/.marks/<игра>, utils/marks.js) — добавляются те, которых здесь нет; свои не трогаем
    const marksDir = path.join(fromRoot, '.marks');
    for (const id of await fsp.readdir(marksDir).catch(() => [])) {
        if (id.startsWith('.') || path.basename(id) !== id) continue;
        await fsp.cp(path.join(marksDir, id), path.join(toRoot, '.marks', id), {
            recursive: true, force: false, errorOnExist: false, filter: (src) => path.basename(src) !== '.deleted',
        }).catch(() => {});
    }
    // «Путь» (_saves/.journal/<игра>, utils/journal.js) — так же: чего здесь нет, то и возвращаем
    const journalDir = path.join(fromRoot, '.journal');
    for (const id of await fsp.readdir(journalDir).catch(() => [])) {
        if (id.startsWith('.') || path.basename(id) !== id) continue;
        await fsp.cp(path.join(journalDir, id), path.join(toRoot, '.journal', id), { recursive: true, force: false, errorOnExist: false }).catch(() => {});
    }
    return count;
}

async function restoreBackup(root, { trash, store, onSave = async () => {} }) {
    const file = path.join(root, 'library.db');
    // Целая ли база в копии и та ли это база
    const check = await open({ filename: file, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        const ok = await check.get('PRAGMA quick_check').catch(() => null);
        const hasGames = await check.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'").catch(() => null);
        if (ok?.quick_check !== 'ok' || !hasGames) throw Object.assign(new Error('База в копии повреждена или это не база библиотеки'), { status: 400, reason: 'backup-broken' });
    } finally {
        await check.close();
    }

    const db = dbService.get();
    const before = path.join(path.dirname(root), `library-before-restore-${Date.now()}.db`);
    await db.run('VACUUM INTO ?', [before]);
    const keptKey = await trash.keepFile(before, 'library-before-restore');

    const present = new Set((await fsp.readdir(GAMES_DIR, { withFileTypes: true }))
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !SYSTEM_DIRS.includes(e.name)).map((e) => e.name));
    const result = { games: 0, shelved: [], saves: 0, keptKey };
    // На полку — днём копии: игра, загруженная уже после неё, — возможно, та самая (shelfMatches смотрит, что позже)
    const now = Date.now();
    const copied = Math.floor((await fsp.stat(file)).mtimeMs);
    const shelfAt = copied > 0 && copied < now ? copied : now;
    await db.run('ATTACH DATABASE ? AS bk', [file]);
    try {
        await db.exec('BEGIN');
        try {
            const mine = new Set(await columnsOf(db, 'main', 'games'));
            const cols = (await columnsOf(db, 'bk', 'games')).filter((c) => mine.has(c));
            const list = cols.join(', ');
            for (const row of await db.all('SELECT * FROM bk.games')) {
                const { id } = row;
                // Имя из файла копии дальше становится путём (сейвы, shelf-match, загрузка на её место), а папки, которая
                // его проверила бы, у карточки нет: чужое имя в библиотеку не пускаем
                if (!isGameId(id)) continue;
                const there = present.has(id);
                // Уже на полке (своей или в копии) — остаётся на полке с прежней датой: по ней сверяются файлы в корзине
                const mine = await db.get('SELECT shelved_at, playtime FROM main.games WHERE id = ?', [id]);
                const shelvedAt = there ? 0 : mine?.shelved_at || row.shelved_at || shelfAt;
                const { cover, screens } = await liveMedia(row, there);
                await db.run(`INSERT OR REPLACE INTO main.games (${list}) SELECT ${list} FROM bk.games WHERE id = ?`, [id]);
                // Время игры только растёт и здесь: дни игры (play_days) после копии остаются, и откат времени записал бы те же часы в день ещё раз
                await db.run('UPDATE main.games SET shelved_at = ?, cover = ?, screens = ?, playtime = MAX(COALESCE(playtime, 0), ?) WHERE id = ?', [shelvedAt, cover, screens, mine?.playtime || 0, id]);
                if (there) result.games++;
                else result.shelved.push(id);
            }
            const wishCols = (await columnsOf(db, 'bk', 'wishlist')).join(', ');
            if (wishCols) await db.run(`INSERT OR REPLACE INTO main.wishlist (${wishCols}) SELECT ${wishCols} FROM bk.wishlist`);
            await restoreAccess(db, await mergePeople(db));
            for (const table of RESTORE_TABLES) await mergeTable(db, table);
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

    result.saves = await restoreRoot(path.join(root, '_saves'), SAVES_DIR, { store, onSave, present });
    // Люди: у каждого своя папка зеркала, тем же ходом в его хранилище. Берём только тех, кто есть в users после слияния:
    // чужое имя папки на диск не пускаем
    const peopleDir = path.join(root, '_saves', PEOPLE_DIR);
    result.peopleSaves = 0;
    for (const uid of await fsp.readdir(peopleDir).catch(() => [])) {
        if (!PERSON_ID.test(uid) || !(await db.get('SELECT 1 FROM main.users WHERE id = ?', [uid]))) continue;
        result.peopleSaves += await restoreRoot(path.join(peopleDir, uid), rootOf(uid), { store: storesFor({ id: uid }).saves, present });
    }
    result.shelved.sort();
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
        return res.status(409).json({ error: 'Копия уже восстанавливается', reason: 'backup-busy' });
    }
    restoring = true;
    // Восстановление — одна транзакция на общем соединении: чужая запись (вход, время игры) попала бы в неё и пропала при откате
    dbService.restoring = true;
    const dir = await fsp.mkdtemp(path.join(EXTRACT_TMP, 'restore_'));
    try {
        // Здесь, а не наверху файла: saves.js и games.js сами тянут много модулей
        const { trash } = require('./games.js');
        const { store } = require('./saves.js');
        const { updateProgress } = require('../utils/saveprogress.js');
        const root = await unpackBackup(archive, dir);
        const result = await restoreBackup(root, { trash, store, onSave: (id) => updateProgress(id).catch(() => {}) });
        await invalidateGamesList();
        // Словари игр в памяти собраны без вернувшихся строк (services/translate.js, dictionary)
        require('../services/translate.js').version++;
        console.log(`[Backup] Восстановлено из копии: игр ${result.games}, на полке ${result.shelved.length}, сейвов ${result.saves}`);
        res.json({ success: true, ...result });
    } catch (e) {
        if (!e.status) console.error('[Backup] Восстановление:', e.message);
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось восстановить копию', reason: e.reason });
    } finally {
        restoring = false;
        dbService.restoring = false;
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
