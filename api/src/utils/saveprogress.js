const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { GAMES_DIR, SAVES_DIR } = require('../config/index.js');
const dbService = require('../db/database.js');
const { invalidateGamesList, redisClient } = require('./cache.js');
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
async function readProgress(gameId) {
    const dir = path.join(SAVES_DIR, path.basename(gameId));
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

// Время игры только растёт: его дают и моменты с точками перемотки (notePlaytime), а сейвы бывают старее них
async function updateProgress(gameId) {
    const progress = await readProgress(gameId);
    if (!progress) return;
    await dbService.get().run(
        'UPDATE games SET playtime = MAX(COALESCE(playtime, 0), ?), progress = ? WHERE id = ?',
        [progress.playtime, JSON.stringify(progress), gameId]
    );
    await invalidateGamesList();
}

// Время игры из моментов и точек перемотки (в них — время игры на миг снимка): играют и без сохранений — с P,
// перемоткой и «Где вышли», — и библиотека показывала 0 ч. Только вперёд и не чаще раза в минуту игры: точки
// ставятся перед каждой сценой и выбором, а список игр после записи собирается заново
async function notePlaytime(gameId, seconds) {
    const s = playtimeOf(seconds);
    if (!s) return;
    const res = await dbService.get().run('UPDATE games SET playtime = ? WHERE id = ? AND COALESCE(playtime, 0) + 60 <= ?', [s, gameId, s]);
    if (res?.changes) await invalidateGamesList();
}

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

module.exports = { readProgress, updateProgress, notePlaytime, backfillProgress, parseSave, placeName, mapName };
