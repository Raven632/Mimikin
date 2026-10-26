const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// «Путь» по игре (вкладка в окне игры): что человек в ней прошёл — новые локации, сцены, выборы с его ответом, бои,
// свои снимки. Пишет сама игра (rpg-fixes, setupSceneMarks), по записи. Это не сейвы: вернуться — по точке перемотки
// (utils/marks.js), запись лишь помнит её id (point), пока та жива, и id снимка (mark).
//   _saves/.journal/<игра>/log.json — записи по порядку; <id>.jpg — маленький кадр сцены.
// Без повторов: локация и сцена — только в первый раз (у сцены — по ключу события), бои подряд с теми же врагами —
// одна запись с числом, тот же вопрос с тем же ответом подряд — одна. Больше MAX — уходят старые бои, потом всё старое
const MAX = 3000;
const KINDS = ['map', 'scene', 'choice', 'battle', 'shot'];
const MAX_THUMB = 200 * 1024;
const ID = /^[0-9a-z]{6,32}$/;
const BATTLE_MERGE_MS = 15 * 60e3;
const CHOICE_REPEAT_MS = 2 * 60e3;

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function writeAtomic(file, data) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
}

// max — сколько записей держать (тесты ставят поменьше)
function createJournal(savesDir, { max = MAX } = {}) {
    const validGame = (game) => { const g = String(game || ''); return !!g && g === path.basename(g) && !g.startsWith('.'); };
    const dirOf = (game) => path.join(savesDir, '.journal', String(game));
    const logOf = (game) => path.join(dirOf(game), 'log.json');
    const thumbOf = (game, id) => path.join(dirOf(game), `${id}.jpg`);
    // Записи одной игры — по очереди: игра шлёт их подряд, и две одновременные затёрли бы друг друга
    const queues = new Map();
    const queued = (game, work) => {
        const run = (queues.get(game) || Promise.resolve()).then(work);
        queues.set(game, run.catch(() => {}));
        return run;
    };

    // Файла нет — путь пуст. Не прочитался (диск) — ошибка: запись поверх стёрла бы весь путь. Испорчен — откладываем
    // рядом (log.bad-<время>.json), а не затираем: человек его не писал, но и терять его нельзя
    async function read(game) {
        let text;
        try {
            text = await fsp.readFile(logOf(game), 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }
        try {
            const list = JSON.parse(text);
            if (Array.isArray(list)) return list;
        } catch { /* испорчен */ }
        await fsp.rename(logOf(game), path.join(dirOf(game), `log.bad-${Date.now()}.json`)).catch(() => {});
        return [];
    }

    async function list(game) {
        return validGame(game) ? read(game).catch(() => []) : [];
    }

    // Лишнее сверх MAX: сначала старые бои, потом что старше; их кадры — тоже
    async function trim(game, entries) {
        if (entries.length <= max) return entries;
        let over = entries.length - max;
        const drop = new Set();
        for (const e of entries) { if (over && e.kind === 'battle') { drop.add(e.id); over--; } }
        for (const e of entries) { if (over && !drop.has(e.id)) { drop.add(e.id); over--; } }
        for (const id of drop) await fsp.rm(thumbOf(game, id), { force: true });
        return entries.filter((e) => !drop.has(e.id));
    }

    // { kind, label, map, mapId, key, answer, point, mark, playtime } → { id } | { id, merged } | { skipped } | { error }
    function add(game, raw = {}) {
        if (!validGame(game) || !KINDS.includes(raw.kind)) return Promise.resolve({ error: 'bad-entry' });
        return queued(game, async () => {
            const entries = await read(game);
            const now = Date.now();
            // ago — сколько прошло в игре с события до отправки (сцена ждёт свою точку перемотки): время — события, не прихода
            const at = now - Math.min(Math.max(Number(raw.ago) || 0, 0), 10 * 60e3);
            const e = { id: `${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`, at, kind: raw.kind, label: clean(raw.label, 120), map: clean(raw.map, 80) };
            const mapId = Number(raw.mapId) || 0;
            if (mapId > 0) e.mapId = mapId;
            const key = clean(raw.key, 80);
            if (key) e.key = key;
            // Отказ (отмена выбора) — отметкой, а не словом: слово — на языке библиотеки при показе
            if (raw.kind === 'choice' && raw.cancel === true) e.cancel = true;
            else if (raw.kind === 'choice' && raw.answer != null) e.answer = clean(raw.answer, 80);
            if (ID.test(String(raw.point || ''))) e.point = String(raw.point);
            if (ID.test(String(raw.mark || ''))) e.mark = String(raw.mark);
            const playtime = Math.floor(Number(raw.playtime) || 0);
            if (playtime > 0) e.playtime = playtime;
            const last = entries[entries.length - 1];
            if (e.kind === 'map' && (!mapId || entries.some((x) => x.kind === 'map' && x.mapId === mapId))) return { skipped: true };
            if (e.kind === 'scene' && key && entries.some((x) => x.kind === 'scene' && x.key === key)) return { skipped: true };
            if (e.kind === 'choice' && last && last.kind === 'choice' && last.label === e.label && last.answer === e.answer && !!last.cancel === !!e.cancel && now - last.at < CHOICE_REPEAT_MS) return { skipped: true };
            if (e.kind === 'battle' && last && last.kind === 'battle' && last.label === e.label && now - last.at < BATTLE_MERGE_MS) {
                last.count = (last.count || 1) + 1;
                last.at = now;
                await writeAtomic(logOf(game), JSON.stringify(entries));
                return { id: last.id, merged: true };
            }
            await fsp.mkdir(dirOf(game), { recursive: true });
            // Пришла позже следующей (сцена ждала точку) — встаёт на своё место по времени
            const next = [...entries, e].sort((a, b) => a.at - b.at);
            await writeAtomic(logOf(game), JSON.stringify(await trim(game, next)));
            return { id: e.id };
        }).catch((err) => {
            console.error(`[Путь] ${game}:`, err.message);
            return { error: 'unreadable' };
        });
    }

    // Кадр сцены — чуть позже записи: в первую секунду сцены на экране ещё карта
    function setThumb(game, id, dataUrl) {
        if (!validGame(game) || !ID.test(String(id || ''))) return Promise.resolve(false);
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
        const jpg = m ? Buffer.from(m[1], 'base64') : null;
        if (!jpg || jpg.length > MAX_THUMB || jpg[0] !== 0xff || jpg[1] !== 0xd8) return Promise.resolve(false);
        return queued(game, async () => {
            const entries = await read(game).catch(() => null);
            const e = entries && entries.find((x) => x.id === id);
            if (!e) return false;
            await writeAtomic(thumbOf(game, id), jpg);
            e.thumb = true;
            await writeAtomic(logOf(game), JSON.stringify(entries));
            return true;
        });
    }

    // «Ещё не видели»: сколько сцен комнаты воспоминаний открыто — считает игра (cheats.js, roomStatus); последнее — здесь
    const roomOf = (game) => path.join(dirOf(game), 'room.json');
    // open: null — сколько открыто, по этой игре не понять (cheats.js, roomStatus): покажем только число сцен
    async function setRoom(game, raw = {}) {
        const total = Math.floor(Number(raw.total));
        const open = raw.open === null ? null : Math.floor(Number(raw.open));
        if (!validGame(game) || !(total >= 0 && total <= 5000) || !(open === null || (open >= 0 && open <= total))) return false;
        const rooms = (Array.isArray(raw.rooms) ? raw.rooms : []).map((r) => clean(r, 60)).filter(Boolean).slice(0, 3);
        await fsp.mkdir(dirOf(game), { recursive: true });
        await writeAtomic(roomOf(game), JSON.stringify({ total, open, rooms, at: Date.now() }));
        return true;
    }
    async function room(game) {
        if (!validGame(game)) return null;
        try { return JSON.parse(await fsp.readFile(roomOf(game), 'utf8')); } catch { return null; }
    }

    async function thumb(game, id) {
        if (!validGame(game) || !ID.test(String(id || ''))) return null;
        const file = thumbOf(game, id);
        return fsp.access(file).then(() => file, () => null);
    }

    return { list, add, setThumb, thumb, setRoom, room, validId: (id) => ID.test(String(id || '')) };
}

module.exports = { createJournal, MAX: MAX, KINDS };
