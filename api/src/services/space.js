// «Место» (окно «Статистика и ревизия»): что сколько занимает на диске и что можно убрать.
// Игры — по размерам из базы (их считает список игр, routes/games.js), остальное — по папкам: прежние
// версии (_old), корзина, найденные картинки (_media), сейвы, недогруженные архивы. Ничего не удаляет:
// убрать — из окна игры, корзины и карточки загрузки, где это и так делается с вопросом.
// Удалённая игра 30 дней лежит в корзине и место не освобождает — так и говорим
const fsp = require('fs').promises;
const path = require('path');
const { getFolderSize } = require('../utils/archive.js');
const { shownTitle } = require('../utils/title.js');
const { duplicateGroups } = require('../utils/audit.js');

const CACHE_MS = 2 * 60 * 1000;
const DAY = 864e5;
// Добавленную недавно и не запущенную ещё не предлагаем: её только что скачали, чтобы играть
const NEVER_AFTER_DAYS = 30;

// Сколько освободит удаление папки: после патча прежняя версия делит с нынешней неизменённые файлы
// (жёсткие ссылки, services/uploads.js) — их удаление не освобождает, считаем только свои
async function ownSize(dir) {
    let total = 0;
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) total += await ownSize(p);
        else if (e.isFile()) {
            const st = await fsp.stat(p).catch(() => null);
            if (st && st.nlink === 1) total += st.size;
        }
    }
    return total;
}

class SpaceService {
    constructor() {
        this.deps = null;
        this.cache = null;
        this.running = null;
    }

    // db — dbService, trash — корзина (services/trash.js), uploads — services/uploads.js
    setDependencies(deps) {
        this.deps = deps;
    }

    // Через CACHE_MS — заново; fresh — сразу (кнопка «Пересчитать»). Два запроса разом — один подсчёт
    async report({ fresh = false, now = Date.now() } = {}) {
        if (!fresh && this.cache && now - this.cache.at < CACHE_MS) return this.cache.data;
        if (!this.running) {
            this.running = this.build(now)
                .then((data) => { this.cache = { at: now, data }; return data; })
                .finally(() => { this.running = null; });
        }
        return this.running;
    }

    async build(now) {
        const { db, trash, uploads, gamesDir, oldDir, savesDir } = this.deps;
        const rows = await db.get().all('SELECT * FROM games WHERE ready = 1');
        const title = (row) => shownTitle(row).title;

        // Прежние версии — по игре, сколько освободит их удаление
        const oldOf = new Map();
        for (const e of await fsp.readdir(oldDir, { withFileTypes: true }).catch(() => [])) {
            if (e.isDirectory()) oldOf.set(e.name, await ownSize(path.join(oldDir, e.name)));
        }
        const trashItems = await trash.list(now).catch(() => []);
        const pending = (await uploads.list().catch(() => [])).filter((u) => u.received > 0 && u.state !== 'processing');

        const games = rows.map((r) => ({
            id: r.id, title: title(r), size: r.size || 0, status: r.status || '',
            playtime: r.playtime || 0, lastPlayed: r.lastPlayed || 0, addedAt: r.addedAt || 0, old: oldOf.get(r.id) || 0,
        })).sort((a, b) => b.size - a.size);
        const byId = new Map(games.map((g) => [g.id, g]));

        const stat = await fsp.statfs(gamesDir);
        const parts = {
            games: games.reduce((s, g) => s + g.size, 0),
            old: [...oldOf.values()].reduce((s, n) => s + n, 0),
            trash: trashItems.reduce((s, x) => s + (x.size || 0), 0),
            media: await getFolderSize(path.join(gamesDir, '_media')).catch(() => 0),
            saves: await getFolderSize(savesDir).catch(() => 0),
            uploads: pending.reduce((s, u) => s + u.received, 0),
        };

        // Что можно убрать. Игры — кандидаты: решает человек; прежние версии, недогруженные архивы и
        // корзина — то, что точно лишнее или уже им удалено
        const played = (g) => g.lastPlayed || g.playtime;
        const pick = (list) => list.map((g) => ({ id: g.id, title: g.title, size: g.size, playtime: g.playtime, lastPlayed: g.lastPlayed }));
        const suggest = {
            old: [...oldOf.entries()].filter(([, size]) => size > 0)
                .map(([id, size]) => ({ id, title: byId.get(id)?.title || id, size, gone: !byId.has(id) }))
                .sort((a, b) => b.size - a.size),
            uploads: pending.map((u) => ({ id: u.id, name: u.name, size: u.received, of: u.size, state: u.state })),
            done: pick(games.filter((g) => g.status === 'done')),
            dropped: pick(games.filter((g) => g.status === 'dropped')),
            never: pick(games.filter((g) => !played(g) && !['wish', 'playing', 'done', 'dropped'].includes(g.status)
                && g.addedAt && now - g.addedAt > NEVER_AFTER_DAYS * DAY)),
            // Одна игра в нескольких папках: все копии, самые большие первыми
            dupes: duplicateGroups(rows).map((group) => group.games.map((g) => byId.get(g.id)).filter(Boolean)
                .sort((a, b) => b.size - a.size).map((g) => ({ id: g.id, title: g.title, size: g.size, playtime: g.playtime, lastPlayed: g.lastPlayed }))),
        };
        // Корзина: место вернётся, когда игру сотрут — руками или сама через 30 дней
        const trashInfo = {
            count: trashItems.length, size: parts.trash,
            nextPurgeAt: trashItems.length ? Math.min(...trashItems.map((x) => x.purgeAt)) : 0,
        };

        return {
            at: now,
            disk: { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize },
            parts,
            unsized: games.filter((g) => !g.size).length,
            trash: trashInfo,
            suggest,
            games,
        };
    }
}

module.exports = new SpaceService();
module.exports.SpaceService = SpaceService;
module.exports.NEVER_AFTER_DAYS = NEVER_AFTER_DAYS;
