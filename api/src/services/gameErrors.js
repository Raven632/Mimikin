const crypto = require('crypto');

// Журнал ошибок игр с настоящих устройств: их присылает rpg-fixes.js (ошибки страницы, движка и
// «Failed to load»), показывает «Ревизия». Одна и та же ошибка на одном устройстве — одна строка
// со счётчиком. На игру — не больше 50 строк, старше 60 дней — забываем
const PER_GAME = 50;
const KEEP_MS = 60 * 24 * 3600e3;
const KINDS = new Set(['error', 'rejection', 'engine', 'load']);

// «iPhone · Safari», «Windows · Chrome» — чтобы было видно, где падает
function deviceOf(ua = '', standalone = false) {
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua)) ? 'iPad'
        : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'другое';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : '';
    return [os, standalone ? 'веб-приложение' : browser].filter(Boolean).join(' · ');
}

// Адрес файла — от папки игры: ключ сервера игр и сам адрес сервера в журнале не нужны
function shortSource(src = '') {
    return String(src).replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\/g\/[0-9a-f]{32}\//, '/').slice(0, 300);
}

class GameErrors {
    constructor() {
        this.dbService = null;
        this.recent = new Map();        // игра → [время отчёта] за последнюю минуту
    }

    setDependencies(dbService) { this.dbService = dbService; }
    db() { return this.dbService.get(); }

    async init() {
        await this.db().exec(`CREATE TABLE IF NOT EXISTS game_errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, sig TEXT NOT NULL, device TEXT DEFAULT '',
            kind TEXT DEFAULT '', message TEXT DEFAULT '', source TEXT DEFAULT '', line INTEGER DEFAULT 0,
            stack TEXT DEFAULT '', scene TEXT DEFAULT '', count INTEGER DEFAULT 1, first_at INTEGER, last_at INTEGER,
            UNIQUE(game, sig))`);
    }

    // Отчёт от игры. Больше 20 в минуту от одной игры — лишние не пишем (игра в цикле ошибок)
    async record(game, body = {}, ua = '') {
        const now = Date.now();
        const times = (this.recent.get(game) || []).filter((t) => now - t < 60e3);
        if (times.length >= 20) return false;
        times.push(now);
        this.recent.set(game, times);

        const kind = KINDS.has(body.kind) ? body.kind : 'error';
        const message = String(body.message || '').slice(0, 500).trim();
        if (!message) return false;
        const source = shortSource(body.source);
        const line = Number(body.line) || 0;
        const device = deviceOf(ua, !!body.standalone);
        // Числа в тексте (номера, координаты) не делают ошибку другой
        const sig = crypto.createHash('sha1').update([kind, message.replace(/\d+/g, '#'), source, line, device].join('\n')).digest('hex');
        const stack = String(body.stack || '').replace(/[a-z]+:\/\/[^/\s]+\/g\/[0-9a-f]{32}/gi, '').slice(0, 2000);
        const res = await this.db().run(
            `INSERT INTO game_errors (game, sig, device, kind, message, source, line, stack, scene, count, first_at, last_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(game, sig) DO UPDATE SET count = count + 1, last_at = excluded.last_at, scene = excluded.scene`,
            [game, sig, device, kind, message, source, line, stack, String(body.scene || '').slice(0, 60), now, now]
        );
        const row = await this.db().get('SELECT count FROM game_errors WHERE game = ? AND sig = ?', [game, sig]);
        // В журнал сервера — первый раз и на 10-й, 100-й повтор
        if ([1, 10, 100].includes(row?.count)) {
            console.log(`[Ошибка в игре] ${game} (${device})${row.count > 1 ? ` ×${row.count}` : ''}: ${message}${source ? ` — ${source}${line ? `:${line}` : ''}` : ''}`);
        }
        if (res.changes && row?.count === 1) {
            await this.db().run(
                `DELETE FROM game_errors WHERE game = ? AND id NOT IN (SELECT id FROM game_errors WHERE game = ? ORDER BY last_at DESC LIMIT ${PER_GAME})`,
                [game, game]
            );
        }
        return true;
    }

    // Для «Ревизии»: игры с ошибками, свежие первыми
    async list() {
        await this.db().run('DELETE FROM game_errors WHERE last_at < ?', [Date.now() - KEEP_MS]);
        const rows = await this.db().all('SELECT id, game, device, kind, message, source, line, stack, scene, count, first_at, last_at FROM game_errors ORDER BY last_at DESC');
        const games = new Map();
        for (const r of rows) {
            if (!games.has(r.game)) games.set(r.game, { game: r.game, lastAt: r.last_at, errors: [] });
            games.get(r.game).errors.push(r);
        }
        return [...games.values()];
    }

    async clear(game) {
        await this.db().run('DELETE FROM game_errors WHERE game = ?', [game]);
    }
}

module.exports = new GameErrors();
module.exports.GameErrors = GameErrors;
module.exports.deviceOf = deviceOf;
