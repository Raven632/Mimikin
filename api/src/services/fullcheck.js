// Полная проверка библиотеки — кнопка «Проверить всё» в ревизии. Всё, что сервер и так проверяет сам
// по расписанию, здесь делается сразу и по всем играм, по шагам:
//   sources  — поиск данных заново для всех игр: по одной, через общую очередь (services/scraper.js).
//              Шаги устроены списком (STEPS): будет ещё один — встанет рядом.
// Ход — событием 'fullcheck' по сокету (не чаще раза в секунду): у шага done из total, current —
// игра, которую проверяют сейчас, и eta — сколько шагу осталось, в мс. Итог — в settings
// (fullcheck_last): окно можно закрыть, итог останется, а после перезапуска сервера видно,
// что проверка прервалась. «Отменить» (cancel) останавливает шаг на ближайшей игре: сделанное
// остаётся, следующие шаги не начинаются
const { shownTitle } = require('../utils/title.js');

const STEPS = ['sources'];
const KEY = 'fullcheck_last';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { splitLinks } = require('../utils/links.js');

// То, что из данных игры видно человеку: по этому сравниваем «до» и «после» поиска
function snapshot(row) {
    let tags = [];
    let screens = [];
    try { tags = JSON.parse(row.tags || '[]') || []; } catch {}
    try { screens = JSON.parse(row.screens || '[]') || []; } catch {}
    return {
        links: splitLinks(row.link).sort(),
        description: String(row.description || ''),
        tags: tags.map(String).sort().join('|'),
        screens: screens.length,
        cover: String(row.cover || ''),
        developer: String(row.developer || ''),
        releaseDate: String(row.releaseDate || ''),
        status: String(row.meta_status || ''),
    };
}

// Что изменилось: появившиеся и пропавшие ссылки — списком, остальное — названиями полей
function changesOf(before, after) {
    const out = {};
    const added = after.links.filter((l) => !before.links.includes(l));
    const removed = before.links.filter((l) => !after.links.includes(l));
    if (added.length) out.linksAdded = added;
    if (removed.length) out.linksRemoved = removed;
    const fields = ['description', 'tags', 'screens', 'cover', 'developer', 'releaseDate', 'status'].filter((k) => before[k] !== after[k]);
    if (fields.length) out.fields = fields;
    if (before.status !== after.status) out.status = after.status;
    return Object.keys(out).length ? out : null;
}

class FullCheck {
    constructor() {
        this.state = null;
        this.running = null;
        this.pollMs = 3000;            // как часто смотреть, сколько игр очередь уже прошла
        this.stallMs = 20 * 60e3;      // очередь столько не двигается — дальше не ждём, она доделает сама
        this.emitGapMs = 1000;
        this.lastEmit = 0;
        this.emitTimer = null;
    }

    setDependencies({ db, scraper, emit }) {
        Object.assign(this, { db, scraper, emitFn: emit });
    }

    sql() { return this.db.get(); }

    // Нынешняя проверка или последняя сохранённая. Сохранённая «идёт», а у нас её нет — сервер
    // перезапускался посреди проверки
    async status() {
        if (this.state) return this.state;
        const row = await this.sql().get('SELECT value FROM settings WHERE key = ?', [KEY]);
        let last = null;
        try { last = row ? JSON.parse(row.value) : null; } catch {}
        if (last?.running) return { ...last, running: false, interrupted: true };
        return last || { running: false, steps: [] };
    }

    // Вторую поверх идущей не начинаем — отдаём ту, что идёт
    async start() {
        if (this.running) return this.state;
        this.abort = new AbortController();
        this.state = {
            running: true, cancelling: false, cancelled: false, startedAt: Date.now(), finishedAt: 0,
            steps: STEPS.map((key) => ({ key, status: 'pending', done: 0, total: 0, current: '', eta: 0, result: null, error: '' })),
        };
        await this.save();
        this.emit(true);
        this.running = this.run().finally(() => { this.running = null; });
        return this.state;
    }

    // «Отменить». Шаг, что идёт, видит сигнал и останавливается на ближайшей игре — сделанное
    // остаётся, остальные шаги не начинаются. Ответ — сразу, проверка закончится чуть позже
    async cancel() {
        if (!this.running) return this.status();
        if (!this.state.cancelling) {
            this.state.cancelling = true;
            this.abort.abort();
            console.log('[Проверка] Отменили — останавливаю');
            await this.save().catch((e) => console.error('[Проверка]', e.message));
            this.emit(true);
        }
        return this.state;
    }

    async run() {
        console.log('[Проверка] Полная проверка библиотеки началась');
        const { signal } = this.abort;
        for (const step of this.state.steps) {
            if (signal.aborted) {
                step.status = 'cancelled';
                continue;
            }
            step.status = 'running';
            step.startedAt = Date.now();
            // В базу — и начало шага: перезапустят сервер сейчас — будет видно, на каком шаге прервалась
            await this.save().catch((e) => console.error('[Проверка]', e.message));
            this.emit(true);
            try {
                step.result = await this[`check_${step.key}`](step, signal);
                // stopped — остановили кнопкой посреди шага; partial — сайт не ответил или попросил
                // подождать: сделано не всё, остальное — в следующий раз
                step.status = step.result?.stopped ? 'cancelled' : step.result?.partial ? 'partial' : 'done';
            } catch (e) {
                step.status = 'error';
                step.error = String(e?.message || e).slice(0, 200);
                console.error(`[Проверка] ${step.key}:`, step.error);
            }
            step.current = '';
            step.eta = 0;
            step.finishedAt = Date.now();
            await this.save().catch((e) => console.error('[Проверка]', e.message));
            this.emit(true);
        }
        this.state.running = false;
        this.state.cancelling = false;
        this.state.cancelled = signal.aborted;
        this.state.finishedAt = Date.now();
        await this.save().catch((e) => console.error('[Проверка]', e.message));
        this.emit(true);
        const took = Math.round((this.state.finishedAt - this.state.startedAt) / 60e3);
        console.log(signal.aborted ? `[Проверка] Остановлена через ${took} мин` : `[Проверка] Готово за ${took} мин`);
    }

    // Сколько осталось — по скорости уже пройденного, считая от первого отчёта шага.
    // Пока позади меньше двух — не гадаем
    progress(step) {
        let base = null;
        return ({ done, total, current = '' }) => {
            const now = Date.now();
            if (!base) base = { at: now, done };
            const went = done - base.done;
            const eta = went >= 2 && total > done ? Math.round(((now - base.at) / went) * (total - done)) : 0;
            Object.assign(step, { done, total, current, eta });
            this.emit();
        };
    }

    // В сокет — не чаще раза в секунду: прогресс очереди идёт часто
    emit(force = false) {
        if (!this.emitFn || !this.state) return;
        const send = () => {
            this.lastEmit = Date.now();
            this.emitTimer = null;
            this.emitFn(this.state);
        };
        if (force || Date.now() - this.lastEmit >= this.emitGapMs) {
            clearTimeout(this.emitTimer);
            send();
        } else if (!this.emitTimer) {
            this.emitTimer = setTimeout(send, this.emitGapMs - (Date.now() - this.lastEmit));
            this.emitTimer.unref?.();
        }
    }

    async save() {
        await this.sql().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [KEY, JSON.stringify(this.state)]);
    }

    // Поиск данных заново для всех игр. Ищет общая очередь (services/scraper.js): игры по одной, с
    // паузами, а перезапустят сервер — продолжит сама. Здесь — следим, сколько она прошла (время
    // проверки игры позже начала шага), и сравниваем данные игр до и после. Отменили — игры, до
    // которых очередь не дошла, возвращаются к своему сроку: искать их она больше не будет
    async check_sources(step, signal) {
        const COLS = 'id, title, link, description, tags, screens, cover, developer, releaseDate, meta_status, meta_locked, meta_retry_at, meta_attempts';
        const db = this.sql();
        const rows = await db.all(`SELECT ${COLS} FROM games WHERE ready = 1`);
        if (!rows.length) return { checked: 0, total: 0, changed: [], byStatus: {} };
        const before = new Map(rows.map((r) => [r.id, snapshot(r)]));
        const titles = new Map(rows.map((r) => [r.id, shownTitle(r).title]));
        const ids = rows.map((r) => r.id);
        const marks = ids.map(() => '?').join(',');
        const since = Date.now();
        // Проверку попросил человек — ищется и при паузе очереди поиска
        await this.scraper.requestScrape(ids, { priority: true });

        const report = this.progress(step);
        let done = -1;
        let movedAt = Date.now();
        let stalled = false;
        let stopped = false;
        for (;;) {
            const cur = await db.get(
                `SELECT COUNT(*) AS total, SUM(CASE WHEN meta_checked_at >= ? THEN 1 ELSE 0 END) AS done FROM games WHERE id IN (${marks})`,
                [since, ...ids]
            );
            const count = cur.done || 0;
            // Какую игру очередь ищет сейчас — если из наших (могла и новую, добавленную только что)
            const current = titles.get(this.scraper.currentId) || '';
            if (count !== done || current !== step.current) {
                if (count !== done) movedAt = Date.now();
                done = count;
                report({ done, total: cur.total, current });
            }
            if (done >= cur.total) break;
            if (signal?.aborted) { stopped = true; break; }
            if (Date.now() - movedAt > this.stallMs) { stalled = true; break; }
            await sleep(this.pollMs);
        }
        if (stopped) {
            for (const r of rows) {
                await db.run(
                    'UPDATE games SET meta_retry_at = ?, meta_attempts = ? WHERE id = ? AND (meta_checked_at IS NULL OR meta_checked_at < ?)',
                    [r.meta_retry_at, r.meta_attempts, r.id, since]
                );
            }
        }

        const after = await db.all(`SELECT ${COLS} FROM games WHERE id IN (${marks})`, ids);
        const changed = [];
        const byStatus = {};
        for (const row of after) {
            const status = row.meta_status || 'new';
            byStatus[status] = (byStatus[status] || 0) + 1;
            const diff = before.has(row.id) ? changesOf(before.get(row.id), snapshot(row)) : null;
            if (diff) changed.push({ id: row.id, title: shownTitle(row).title, ...diff });
        }
        return { checked: Math.max(done, 0), total: after.length, changed, byStatus, partial: stalled, stopped };
    }
}

module.exports = new FullCheck();
module.exports.FullCheck = FullCheck;
module.exports.STEPS = STEPS;
module.exports.snapshot = snapshot;
module.exports.changesOf = changesOf;
