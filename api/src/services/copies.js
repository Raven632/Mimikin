const fsp = require('fs').promises;
const path = require('path');
const { pairKey, sameGame } = require('../utils/audit.js');
const { shownTitle } = require('../utils/title.js');
const personal = require('./personal.js');
const { PEOPLE_DIR } = require('../utils/personStores.js');

// Две копии одной игры из ревизии: склеить в одну или сказать «Не дубликат».
// Склейка берёт только то, что не спорит с оставшейся копией: время складывается, статус, оценка, заметки и подборки — туда,
// где пусто. Сейвы и моменты переезжают, только если своих у неё нет ни тех, ни других: иначе смешались бы два прохождения.
// Вторая копия уходит в корзину (services/trash.js) и там же возвращается; её сейвы, если не переехали, остаются в
// _saves под её именем: корзина их не трогает, вернут копию — они при ней.
// Остальные люди (_saves/.people/<id>) решаются каждый сам по тому же правилу, по своим папкам: у одного сейвы переехали,
// у другого остались, а владельца их сейвы не касаются. Личные строки (user_games) переносит services/personal.js.
const FIELDS = ['status', 'rating', 'notes', 'lists'];
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const filled = (row, field) => {
    const v = row[field];
    return !!v && v !== '[]' && v !== '""';
};
const exists = (p) => fsp.lstat(p).then(() => true, () => false);
const notEmpty = (dir) => fsp.readdir(dir).then((list) => list.length > 0, () => false);

function createCopies({ db, trash, savesDir, gamesDir, onChange = async () => {} }) {
    const hasSaves = (id) => notEmpty(path.join(savesDir, id));
    const hasMoments = (id) => notEmpty(path.join(savesDir, '.marks', id));
    const hasPlay = async (id) => await hasSaves(id) || await hasMoments(id);

    // Обе строки — настоящие игры, и одна и та же: кнопки ревизии могли устареть, а адрес можно вызвать и руками
    async function pair(a, b) {
        if (!a || !b || a === b) throw fail(400, 'Нужны две разные копии');
        const [one, two] = await Promise.all([a, b].map((id) => db().get('SELECT * FROM games WHERE id = ? AND ready = 1', [id])));
        if (!one || !two) throw fail(404, 'Игра не найдена');
        return [one, two];
    }

    // Что случится, если останется keep. Без файлов оставить нельзя, когда у другой они есть: библиотека потеряла бы игру,
    // в которую можно играть (null вместо плана)
    async function planFor(keep, drop) {
        if (keep.shelved_at > 0 && !(drop.shelved_at > 0)) return null;
        const theirs = await hasPlay(drop.id);
        return {
            keep: keep.id,
            drop: drop.id,
            playtime: (keep.playtime || 0) + (drop.playtime || 0),
            carries: FIELDS.filter((f) => !filled(keep, f) && filled(drop, f)),
            saves: !theirs ? 'none' : await hasPlay(keep.id) ? 'both' : 'move',
        };
    }

    const facts = async (row) => ({
        id: row.id,
        title: shownTitle(row).title,
        size: row.size || 0,
        playtime: row.playtime || 0,
        shelved: row.shelved_at > 0,
        saves: await hasSaves(row.id),
        moments: await hasMoments(row.id),
    });

    async function plan(a, b) {
        const [one, two] = await pair(a, b);
        return {
            copies: [await facts(one), await facts(two)],
            plans: { [one.id]: await planFor(one, two), [two.id]: await planFor(two, one) },
        };
    }

    // Что переезжает вместе с сейвами: сама папка и всё, что рядом лежит по имени игры (.marks, .history, .shots, .journal).
    // Служебная папка, где у оставшейся уже что-то есть (старая история), остаётся под прежним именем: не теряется.
    // root — _saves владельца или папка человека; у владельца .people — не «служебная папка с играми», её не обходим
    async function moves(from, to, root = savesDir) {
        const hidden = (await fsp.readdir(root).catch(() => [])).filter((n) => n.startsWith('.') && !(root === savesDir && n === PEOPLE_DIR));
        const out = [];
        for (const base of [root, ...hidden.map((n) => path.join(root, n))]) {
            const way = [path.join(base, from), path.join(base, to)];
            if (await exists(way[0]) && !(await notEmpty(way[1]))) out.push(way);
        }
        return out;
    }

    // Люди, у кого есть своя папка сейвов: id → корень
    async function peopleRoots() {
        const base = path.join(savesDir, PEOPLE_DIR);
        const names = (await fsp.readdir(base).catch(() => [])).filter((n) => /^u[0-9a-f]{16}$/.test(n));
        return names.map((id) => [id, path.join(base, id)]);
    }
    const hasPlayIn = async (root, id) => await notEmpty(path.join(root, id)) || await notEmpty(path.join(root, '.marks', id));

    // Каждый человек сам: сейвы были у from и нет у to — переезжают с прогрессом, иначе остаются на месте. Переехавшие пары
    // дописываются в moved (откат склейки вернёт их), личные строки user_games переходят к to в любом случае. Зовёт и слияние
    // копий, и перенос на место игры с полки (routes/games.js)
    async function movePeople(from, to, moved = []) {
        const movedPeople = new Set();
        for (const [uid, root] of await peopleRoots()) {
            if (!(await hasPlayIn(root, from))) continue;
            if (await hasPlayIn(root, to)) { console.log(`[Копии] ${uid}: сейвы ${from} остались на месте, у ${to} свои`); continue; }
            for (const [a, b] of await moves(from, to, root)) {
                await fsp.rename(a, b);
                moved.push([a, b]);
            }
            movedPeople.add(uid);
        }
        await personal.carry(from, to, { progress: movedPeople, db: db() });
        return movedPeople;
    }

    // Сначала папка в корзину: у трёх частей склейки только она бывает долгой (корзина на другом диске) и только её нельзя
    // держать внутри транзакции, общей на одно соединение. Не вышло — ничего ещё не менялось. Дальше транзакция: строка
    // оставшейся и переезд сейвов; сбой — сейвы обратно, копия из корзины обратно. Оборвись сервер посередине — копия
    // в корзине со своей строкой, сейвы на месте, потерять нечего
    async function merge(keepId, dropId) {
        const [keep, drop] = await pair(keepId, dropId);
        if (!sameGame(keep, drop)) throw fail(409, 'Это не копии одной игры', 'merge-not-same');
        const what = await planFor(keep, drop);
        if (!what) throw fail(409, 'Оставить копию без файлов нельзя, пока у другой они есть', 'merge-keep-shelved');
        for (const row of [keep, drop]) {
            if (!(row.shelved_at > 0) && !(await exists(path.join(gamesDir, row.id)))) throw fail(404, 'Игра не найдена');
        }

        const { key } = await trash.trashGame(drop.id);
        const moved = [];
        try {
            await db().exec('BEGIN');
            try {
                const carried = what.saves === 'move' ? drop.progress || '' : '';
                await db().run(`UPDATE games SET playtime = ?, lastPlayed = MAX(COALESCE(lastPlayed, 0), ?),
                    status = CASE WHEN COALESCE(status, '') = '' THEN ? ELSE status END,
                    rating = CASE WHEN COALESCE(rating, 0) = 0 THEN ? ELSE rating END,
                    favorite = MAX(COALESCE(favorite, 0), ?),
                    notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes END,
                    lists = CASE WHEN COALESCE(lists, '[]') = '[]' THEN ? ELSE lists END,
                    series = CASE WHEN series = '' THEN ? ELSE series END,
                    progress = CASE WHEN ? <> '' THEN ? ELSE progress END WHERE id = ?`,
                [what.playtime, drop.lastPlayed || 0, drop.status || '', drop.rating || 0, drop.favorite || 0, drop.notes || '', drop.lists || '[]', drop.series === 'none' ? '' : drop.series || '', carried, carried, keep.id]);
                await db().run('UPDATE OR IGNORE gallery_favorites SET game_id = ? WHERE game_id = ?', [keep.id, drop.id]);
                if (what.saves === 'move') {
                    for (const [from, to] of await moves(drop.id, keep.id)) {
                        await fsp.rename(from, to);
                        moved.push([from, to]);
                    }
                }
                await movePeople(drop.id, keep.id, moved);
                await db().exec('COMMIT');
            } catch (e) {
                await db().exec('ROLLBACK').catch(() => {});
                throw e;
            }
        } catch (e) {
            for (const [from, to] of moved.reverse()) {
                await fsp.rename(to, from).catch((err) => console.error(`[Копии] ${from}: не вернулось из ${to} (${err.message})`));
            }
            await trash.restore(key).catch((err) => console.error(`[Копии] ${drop.id}: осталась в корзине, ${key} (${err.message})`));
            throw e;
        }
        // Время уже у оставшейся: вернут копию из корзины — не посчитается второй раз
        await trash.updateRow(key, { playtime: 0 }).catch((err) => console.error(`[Копии] ${key}: время осталось в записи корзины (${err.message})`));
        await onChange();
        console.log(`[Копии] ${drop.id} склеена с ${keep.id}: сейвы ${what.saves}, в корзине ${key}`);
        return { success: true, keep: keep.id, drop: drop.id, trashKey: key, saves: what.saves };
    }

    async function dismiss(a, b) {
        await pair(a, b);
        const [first, second] = pairKey(a, b).split('\n');
        await db().run('INSERT OR IGNORE INTO not_duplicates (a, b) VALUES (?, ?)', [first, second]);
        return { success: true };
    }

    const dismissed = async () => new Set((await db().all('SELECT a, b FROM not_duplicates')).map((r) => pairKey(r.a, r.b)));

    return { plan, merge, dismiss, dismissed, movePeople };
}

module.exports = { createCopies };
