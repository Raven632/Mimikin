const dbService = require('../db/database.js');
const { parseLists } = require('../utils/gameLists.js');
const gameAccess = require('./gameAccess.js');

// Личное по играм у людей, не владельца. Владелец хранит это в games (корзина, копии и откат опираются на столбцы), остальные —
// в user_games: одна строка на человека и игру. Чужие записи владельца не видны и не меняются — ни в ту, ни в другую сторону.
// Поля и то, что видит человек, пока строки у него нет
const FIELDS = { playtime: 0, lastPlayed: 0, rating: 0, status: '', favorite: 0, notes: '', lists: '[]', progress: '' };

// Человек, не владелец, или null. Нет req.person (вызов без входа, тесты) — как владелец: так всё и работало до людей
const other = (person) => (person && !person.isOwner ? person : null);

const parseProgress = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

// Личные поля одной игры в виде столбцов: что записал человек, остальное — по умолчанию
function columns(mine) {
    const out = {};
    for (const [name, empty] of Object.entries(FIELDS)) out[name] = mine ? mine[name] : empty;
    return out;
}

async function mineOf(person) {
    const rows = await dbService.get().all(`SELECT game_id AS id, ${Object.keys(FIELDS).join(', ')} FROM user_games WHERE user_id = ?`, [person.id]);
    return new Map(rows.map((r) => [r.id, r]));
}

// Имя ручной серии могло прийти из названия закрытой игры: владелец добавил открытую к ней в серию. Сравнить части странице хватит и
// метки, она имя нигде не показывает. Настоящее имя остаётся, если оно начинает название игры из этого же списка: оно уже ничего не
// выдаёт, а без него часть серии не сошлась бы с остальными частями, узнанными по названию (gameSeries.js)
const seriesKey = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function hideSeriesNames(games) {
    const titles = games.map((game) => seriesKey(game.displayTitle || game.title));
    const seen = new Map();
    let hidden = 0;
    return games.map((game) => {
        if (!game.series || game.series === 'none') return game;
        const key = seriesKey(game.series);
        if (!seen.has(key)) seen.set(key, titles.some((title) => title.startsWith(key)) ? null : `hidden ${(hidden += 1)}`);
        return seen.get(key) ? { ...game, series: seen.get(key) } : game;
    });
}

// games — ответ GET /games (поля уже в виде списка) или, с raw, строки таблицы games. Владельцу — те же объекты, без копий.
// Человеку: личные поля заменены его строками или пустыми значениями; кого-то из чужих (shelfMatch) в списке нет. Игры, которых
// ему не открыли (services/gameAccess.js), убираются здесь: этот список питает и «Библиотеку», и подбор. Номер — место в том, что
// он видит: по пропускам и наибольшему номеру размер библиотеки не угадать
async function overlay(games, person, { raw = false } = {}) {
    const user = other(person);
    if (!user) return games;
    const mine = await mineOf(user);
    const allowed = await gameAccess.allowedIds(user);
    const open = gameAccess.only(allowed, games, (game) => game.id);
    return (allowed ? hideSeriesNames(open) : open).map((game, i) => {
        const c = columns(mine.get(game.id));
        if (raw) return { ...game, ...c };
        return {
            ...game,
            lastPlayed: c.lastPlayed, rating: c.rating, status: c.status || '', favorite: !!c.favorite, notes: c.notes || '',
            lists: parseLists(c.lists), playtime: c.playtime || 0, progress: parseProgress(c.progress),
            shelfMatch: null,
            ...(allowed ? { number: i + 1 } : {}),
        };
    });
}

// fields — { rating, lastPlayed, status, favorite, notes, lists, ... } уже проверенные, в том порядке, как их собрал маршрут.
// Владелец: тот же UPDATE games, что и раньше. Человек: строка в user_games. Ответ — true, если писали человеку:
// его запись список игр владельца не меняет, и сбрасывать общий кэш не надо
async function write(person, gameId, fields) {
    const names = Object.keys(fields).filter((k) => Object.hasOwn(FIELDS, k));
    if (!names.length) return false;
    const db = dbService.get();
    const user = other(person);
    if (!user) {
        await db.run(`UPDATE games SET ${names.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...names.map((k) => fields[k]), gameId]);
        return false;
    }
    await db.run(
        `INSERT INTO user_games (user_id, game_id, ${names.join(', ')}, at) VALUES (?, ?, ${names.map(() => '?').join(', ')}, ?)
         ON CONFLICT(user_id, game_id) DO UPDATE SET ${names.map((k) => `${k} = excluded.${k}`).join(', ')}, at = excluded.at`,
        [user.id, gameId, ...names.map((k) => fields[k]), Date.now()]
    );
    return true;
}

// Игру слили в другую (copies.js) или она встала на место игры с полки: личное человека переходит к ней. Строка уже есть
// у обеих — складываем: время и «любимая» суммируются или берётся большее, остальное остаётся у той, что в игре-приёмнике, если оно
// там задано. progress переносим только по просьбе: он про сейвы, а те могут остаться у прежней папки. true — всем, Set с id
// людей — только им (сейвы у каждого переезжают или нет сами по себе, copies.js). Строка прежней игры остаётся, время в ней
// обнуляется — как у владельца (корзина записывает копию с нулевым временем): вернут копию из корзины — счёт не удвоится, а
// заметки и статус при ней
async function carry(fromId, toId, { progress = false, db = dbService.get() } = {}) {
    if (fromId === toId) return;
    for (const row of await db.all('SELECT * FROM user_games WHERE game_id = ?', [fromId])) {
        const withProgress = progress === true || (progress instanceof Set && progress.has(row.user_id));
        const into = await db.get('SELECT * FROM user_games WHERE user_id = ? AND game_id = ?', [row.user_id, toId]);
        const now = Date.now();
        if (!into) {
            await db.run(
                `INSERT INTO user_games (user_id, game_id, playtime, lastPlayed, rating, status, favorite, notes, lists, progress, at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.user_id, toId, row.playtime, row.lastPlayed, row.rating, row.status, row.favorite, row.notes, row.lists, withProgress ? row.progress : '', now]
            );
        } else {
            const lists = [...new Set([...parseLists(into.lists), ...parseLists(row.lists)])];
            await db.run(
                `UPDATE user_games SET playtime = ?, lastPlayed = ?, rating = ?, status = ?, favorite = ?, notes = ?, lists = ?, progress = ?, at = ?
                 WHERE user_id = ? AND game_id = ?`,
                [into.playtime + row.playtime, Math.max(into.lastPlayed, row.lastPlayed), into.rating || row.rating, into.status || row.status,
                    Math.max(into.favorite, row.favorite), into.notes || row.notes, JSON.stringify(lists), withProgress && !into.progress ? row.progress : into.progress,
                    now, row.user_id, toId]
            );
        }
        await db.run('UPDATE user_games SET playtime = 0 WHERE user_id = ? AND game_id = ?', [row.user_id, fromId]);
    }
    // Избранные картинки людей переезжают вслед за игрой: у владельца то же делает UPDATE gallery_favorites при слиянии. Без этого
    // JOIN games в GET /favorites прячет их, как только прежняя игра ушла в корзину
    await db.run('UPDATE OR IGNORE user_gallery_favorites SET game_id = ? WHERE game_id = ?', [toId, fromId]);
    // Кому была открыта прежняя игра — открывается и эта: иначе человек, которому дали только копию, ушедшую в корзину, потерял
    // бы игру. Строка прежней остаётся: вернут копию из корзины — доступ при ней. У тех, кому открыта только эта, ничего не меняется
    await db.run('INSERT OR IGNORE INTO user_game_access (user_id, game_id, at) SELECT user_id, ?, ? FROM user_game_access WHERE game_id = ?', [toId, Date.now(), fromId]);
    // Запрос, ставший этой игрой, тоже смотрит на неё: кнопка «Открыть игру» не должна вести в корзину
    await db.run('UPDATE user_requests SET game_id = ? WHERE game_id = ?', [toId, fromId]);
    // Дни игры уходят совсем, и владельца тоже: время уже у оставшейся, а вернут копию из корзины — её дни начнутся заново, без удвоения
    await db.run(`INSERT INTO play_days (user_id, game_id, day, seconds) SELECT user_id, ?, day, seconds FROM play_days WHERE game_id = ?
        ON CONFLICT(user_id, game_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`, [toId, fromId]);
    await db.run('DELETE FROM play_days WHERE game_id = ?', [fromId]);
}

module.exports = { FIELDS, other, overlay, write, carry };
