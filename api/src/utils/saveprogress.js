const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { GAMES_DIR, SAVES_DIR } = require('../config/index.js');
const dbService = require('../db/database.js');
const { invalidateGamesList, redisClient, emitToPerson } = require('./cache.js');
const personStores = require('./personStores.js');
const personal = require('../services/personal.js');
const { findDataDir } = require('./gamelang.js');
const LZString = require('lz-string');

const CJK = /[\u3040-\u30ff\u3400-\u9fff]/;
const PLACE_TR_TTL = 90 * 86400;

// Название места — читаемым: управляющие коды вон, «Caves_action_stage» и «AbandonedShrine» — по
// словам. «MAP001», «12», «OP» и пустое — не место: такое не показываем
function placeName(raw) {
    const name = String(raw || '')
        .replace(/\\[A-Za-z_]+\[[^\]]*\]/g, ' ')
        .replace(/_+/g, ' ')
        .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
    if (!name || /^(map|マップ|地图)?\s*\d+$/i.test(name)) return null;
    if (/^[\x20-\x7e]+$/.test(name) && name.replace(/\s/g, '').length < 3) return null;
    return name.slice(0, 60);
}

// Где игрок: название карты, на которой сохранились. То, что игра пишет при входе на карту
// (displayName), иначе — имя карты в редакторе (MapInfos.json). Папку игры только читаем
async function mapName(gameId, mapId, gamesDir = GAMES_DIR) {
    if (!(mapId > 0)) return null;
    const dataDir = await findDataDir(path.join(gamesDir, path.basename(gameId)));
    if (!dataDir) return null;
    const read = async (file) => {
        try {
            const full = path.join(dataDir, file);
            if ((await fsp.stat(full)).size > 40 * 1024 * 1024) return null;
            return JSON.parse((await fsp.readFile(full, 'utf8')).replace(/^\uFEFF/, ''));
        } catch (e) {
            return null;
        }
    };
    const map = await read(`Map${String(mapId).padStart(3, '0')}.json`);
    const shown = placeName(map?.displayName);
    if (shown) return shown;
    const infos = await read('MapInfos.json');
    return placeName(infos?.[mapId]?.name);
}

// Японское или китайское название места — ещё и по-английски: игрок японского обычно не читает.
// Перевод запоминаем надолго: карт в игре немного, а сейвы пишутся часто
async function placeInEnglish(name) {
    if (!name || !CJK.test(name)) return null;
    const key = `place:en:${name}`;
    try {
        const hit = await redisClient.get(key);
        if (hit) return hit;
    } catch (e) {}
    const scraperService = require('../services/scraper.js');
    const tr = String(await scraperService.translateText(name, 'en') || '').trim();
    if (!tr || tr === name) return null;
    try { await redisClient.set(key, tr, { EX: PLACE_TR_TTL }); } catch (e) {}
    return tr;
}

// Сейв лежит ровно в том виде, в каком игра положила его в localStorage:
// MV — обычный JSON, MZ — сжатый zlib. Обходимся встроенным модулем, без зависимостей.
function parseSave(raw) {
    // Три формата: обычный JSON, zlib (MZ) и LZString в base64 (стандартный MV).
    if (raw.charCodeAt(0) === 0x78) {
        // Файл писался как текст, поэтому байты возвращаем через latin1
        return JSON.parse(zlib.inflateSync(Buffer.from(raw, 'latin1')).toString('utf8'));
    }
    if (raw.trimStart().startsWith('{')) return JSON.parse(raw);
    return JSON.parse(LZString.decompressFromBase64(raw));
}

// Слоты сохранений: MV — «RPG%20File1.json», MZ — «MZ_file1.json».
// Файлы config и global прогресса не содержат, их не трогаем.
const SLOT_FILE = /^(RPG%20File\d+|MZ_file\d+)\.json$/i;

// Время игры приходит от самой игры (сейв, момент) и только растёт — выше 10 000 ч не верим: иначе одна испорченная
// запись (1e999 в JSON — это Infinity) осталась бы навсегда
const MAX_PLAYTIME = 10000 * 3600;
const playtimeOf = (seconds) => {
    const s = Math.floor(Number(seconds));
    return Number.isFinite(s) && s > 0 ? Math.min(s, MAX_PLAYTIME) : 0;
};

// Берём самый «продвинутый» слот — с наибольшим временем игры.
// root — где лежат сейвы: у владельца _saves, у остальных людей их папка (utils/personStores.js)
async function readProgress(gameId, root = SAVES_DIR) {
    const dir = path.join(root, path.basename(gameId));
    let files;
    try { files = await fsp.readdir(dir); } catch { return null; }

    let best = null;
    for (const file of files.filter(f => SLOT_FILE.test(f))) {
        const full = path.join(dir, file);
        try {
            const save = parseSave(await fsp.readFile(full, 'utf8'));
            // Движок считает время в кадрах, их 60 в секунде
            const playtime = playtimeOf((save?.system?._framesOnSave || 0) / 60);
            if (best && playtime <= best.playtime) continue;

            const levels = Object.values(save?.actors?._data || {})
                .map(a => a && a._level).filter(Boolean);
            best = {
                playtime,
                gold: save?.party?._gold ?? null,
                mapId: save?.map?._mapId ?? null,
                level: levels.length ? Math.max(...levels) : null,
                slot: file.replace(/\.json$/i, ''),
                savedAt: (await fsp.stat(full)).mtimeMs,
            };
        } catch (e) {
            // Чужой формат или битый слот — молча пропускаем, остальные читаем
        }
    }
    if (best) {
        best.map = await mapName(gameId, best.mapId).catch(() => null);
        best.mapEn = await placeInEnglish(best.map).catch(() => null);
    }
    return best;
}

// День на часах сервера: «2026-11-02»
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Записи времени — по очереди: разница считается от прежнего значения, и две записи разом (сейв и точка перемотки) посчитали бы
// один и тот же кусок дважды
let playTurn = Promise.resolve();
const inPlayTurn = (work) => {
    const run = playTurn.then(work);
    playTurn = run.catch(() => {});
    return run;
};

// Больше за одну запись не наиграть: записи идут каждую минуту игры и на каждом сейве. Такой скачок — наигранное раньше (игру загрузили
// заново к старым сейвам, у человека первый сейв) или чепуха от клиента, а не сегодняшний день
const MAX_PLAY_STEP = 12 * 3600;

// Сколько прибавилось — в сегодняшний день (play_days). Сбой календаря не должен мешать ни времени игры, ни самой игре
async function addPlayDay(userId, gameId, seconds) {
    if (!(seconds > 0) || seconds > MAX_PLAY_STEP || dbService.restoring) return;
    await dbService.get().run(
        `INSERT INTO play_days (user_id, game_id, day, seconds) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, game_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`,
        [userId, gameId, dayOf(), seconds]
    ).catch((e) => console.warn(`[Дни игры] ${gameId}: ${e.message}`));
}

// Время игры только растёт: его дают и моменты с точками перемотки (notePlaytime), а сейвы бывают старее них
// person — кто сохранился. Человек не владелец: сейвы из его папки, время и прогресс — в его строку user_games,
// строка владельца в games и общий список не меняются
async function updateProgress(gameId, person = null) {
    const user = personal.other(person);
    const progress = await readProgress(gameId, user ? personStores.storesFor(user).root : SAVES_DIR);
    if (!progress) return;
    await inPlayTurn(async () => {
        if (user) {
            const before = await dbService.get().get('SELECT playtime FROM user_games WHERE user_id = ? AND game_id = ?', [user.id, gameId]);
            await dbService.get().run(
                `INSERT INTO user_games (user_id, game_id, playtime, progress, at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, game_id) DO UPDATE SET playtime = MAX(COALESCE(playtime, 0), excluded.playtime), progress = excluded.progress, at = excluded.at`,
                [user.id, gameId, progress.playtime, JSON.stringify(progress), Date.now()]
            );
            await addPlayDay(user.id, gameId, progress.playtime - (before?.playtime || 0));
            emitToPerson(user.id, 'library-changed');
            return;
        }
        const before = await dbService.get().get('SELECT playtime FROM games WHERE id = ?', [gameId]);
        await dbService.get().run(
            'UPDATE games SET playtime = MAX(COALESCE(playtime, 0), ?), progress = ? WHERE id = ?',
            [progress.playtime, JSON.stringify(progress), gameId]
        );
        if (before) await addPlayDay('owner', gameId, progress.playtime - (before.playtime || 0));
        await invalidateGamesList();
    });
}

// Время игры из моментов и точек перемотки (в них — время игры на миг снимка): играют и без сохранений — с P,
// перемоткой и «Где вышли», — и библиотека показывала 0 ч. Только вперёд и не чаще раза в минуту игры: точки
// ставятся перед каждой сценой и выбором, а список игр после записи собирается заново
async function notePlaytime(gameId, seconds, person = null) {
    const s = playtimeOf(seconds);
    if (!s) return;
    // Восстановление копии держит транзакцию на общем соединении; запись сюда пропала бы при откате. Следующая точка перемотки допишет
    if (dbService.restoring) return;
    const user = personal.other(person);
    await inPlayTurn(async () => {
        if (user) {
            // Строки ещё нет — первую запись тоже не чаще, чем раз в минуту игры, как у владельца (его UPDATE на пустом времени
            // меньше минуты ничего не меняет)
            if (s < 60) return;
            const before = await dbService.get().get('SELECT playtime FROM user_games WHERE user_id = ? AND game_id = ?', [user.id, gameId]);
            const res = await dbService.get().run(
                `INSERT INTO user_games (user_id, game_id, playtime, at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, game_id) DO UPDATE SET playtime = excluded.playtime, at = excluded.at WHERE COALESCE(user_games.playtime, 0) + 60 <= excluded.playtime`,
                [user.id, gameId, s, Date.now()]
            );
            if (res?.changes) {
                await addPlayDay(user.id, gameId, s - (before?.playtime || 0));
                emitToPerson(user.id, 'library-changed');
            }
            return;
        }
        const before = await dbService.get().get('SELECT playtime FROM games WHERE id = ?', [gameId]);
        const res = await dbService.get().run('UPDATE games SET playtime = ? WHERE id = ? AND COALESCE(playtime, 0) + 60 <= ?', [s, gameId, s]);
        if (res?.changes) {
            await addPlayDay('owner', gameId, s - (before?.playtime || 0));
            await invalidateGamesList();
        }
    });
}

// Что сервер игр делает после записи слота и момента (routes/play.js, createGameApp). Тот же код берёт и server.js, и тесты:
// провод между «кто сохранился» и «чья строка меняется» проверяется на настоящих функциях, а не на копии
const gameHooks = {
    onSaved: (id, slot, userId) => { if (/^(RPG File\d+|MZ_file\d+)$/i.test(slot)) updateProgress(id, { id: userId, isOwner: userId === 'owner' }).catch(() => {}); },
    onMarked: (id, playtime, userId) => { notePlaytime(id, playtime, { id: userId, isOwner: userId === 'owner' }).catch(() => {}); },
};

// Разовый проход по уже накопленным сейвам: прогресс появится и у старых игр
async function backfillProgress() {
    const rows = await dbService.get().all('SELECT id FROM games WHERE ready = 1');
    let updated = 0;
    for (const row of rows) {
        const progress = await readProgress(row.id);
        if (!progress) continue;
        await dbService.get().run(
            'UPDATE games SET playtime = MAX(COALESCE(playtime, 0), ?), progress = ? WHERE id = ?',
            [progress.playtime, JSON.stringify(progress), row.id]
        );
        updated++;
    }
    if (updated) {
        await invalidateGamesList();
        console.log(`[Progress] Прогресс прочитан из сейвов: ${updated} игр`);
    }
}

module.exports = { dayOf, readProgress, updateProgress, notePlaytime, gameHooks, backfillProgress, parseSave, placeName, mapName };
