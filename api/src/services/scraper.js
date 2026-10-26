const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { scraperKey } = require('../utils/scraperKey.js');
const { option } = require('../utils/options.js');
const { OFFLINE } = require('../config/index.js');
const { redisClient, invalidateGamesList } = require('../utils/cache.js');
const { stripRelease, searchNames, bestSimilarity, normTitle } = require('../utils/title.js');
const { itchGameUrl, parseItchPage } = require('../utils/itch.js');
const { splitLinks, linkKey, parseRemoved } = require('../utils/links.js');

// Не латиница: японский, китайский, корейский. Такие названия Steam не ищем — его выдача
// английская, и на иероглифы она отвечает чем попало
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f\uac00-\ud7af]/;
// Ссылки, которые автопоиск находит по названию, а не по точной ссылке: их каждый поиск
// находит и сверяет заново (см. lookupInputs и applyLookup)
const BY_TITLE = /store\.steampowered\.com|vndb\.org/i;
const { statusOfRow, planNext } = require('../utils/scrapeplan.js');
// Протокол поиска: кто не ответил, что нашёл каждый сайт, что было похоже (utils/lookuprun.js)
const { lookupRun, newRun, noteFailed, noteUnreachable, noteStep, noteNear, noteCredits, failuresSoFar, journalOf } = require('../utils/lookuprun.js');

async function sourceFetch(url, options) {
    let host = 'источник';
    try { host = new URL(String(url)).hostname.replace(/^www\./, ''); } catch (e) {}
    try {
        // Без своего тайм-аута запрос ждал бы ответа минутами, а поиск идёт по одной игре — встала бы вся очередь
        const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(30000), ...options });
        if (res.status === 403 || res.status === 429 || res.status >= 500) noteFailed(host);
        // Оборвалось на теле (тот же тайм-аут) или пришёл не JSON (страница Cloudflare) — тоже «не ответил», а не «игры
        // нет»: иначе ссылка Steam или VNDB, найденная по названию, ушла бы как неподтверждённая
        for (const read of ['text', 'json']) {
            const orig = res[read]?.bind(res);
            if (orig) res[read] = () => orig().catch((e) => { noteFailed(host); throw e; });
        }
        return res;
    } catch (e) {
        noteFailed(host);
        throw e;
    }
}

// Игры с возрастной меткой (хорроры, например) Steam отдаёт только после подтверждения
// возраста. Без этих кук appdetails отвечает success: false, и ветка Steam молча
// возвращает пустоту.
const STEAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    Cookie: 'birthtime=283993201; lastagecheckage=1-0-1979',
};

// Тот же ли автор: «Moon Studio» и «Moon Studio, Marlow Localize», «PIXELBOX» и «Pixelbox»
function sameAuthor(found, authors) {
    return found.some((d) => authors.some((a) => {
        const x = normTitle(d), y = normTitle(a);
        return x && y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))));
    }));
}

class ScraperService {
    constructor() {
        this.isBackgroundScraping = false;
        this.priority = new Set();   // игры, которые человек попросил искать первыми (по порядку просьб)
        this.paused = false;         // очередь на паузе (settings.lookup_paused)
        this.live = null;            // что ищется сейчас: { id, title, startedAt, steps }
        // Игра, которую воркер ищет прямо сейчас: её показывает ход полной проверки (services/fullcheck.js)
        this.currentId = null;
        this.io = null;
        this.GAMES_DIR = '';
        this.dbService = null;
    }

    setDependencies(io, gamesDir, dbService) {
        this.io = io;
        this.GAMES_DIR = gamesDir;
        this.dbService = dbService;
    }

    // Попросить поиск для игр прямо сейчас: срок «подошёл», счётчик неудач обнулён.
    // Это и импорт новой игры, и кнопка «Искать сейчас» — очередь как отдельной
    // сущности больше нет, воркер просто берёт из базы тех, чей срок настал.
    // priority — человек попросил именно эти («Искать сейчас», «Искать первой»): они идут раньше
    // остальных и ищутся, даже когда очередь на паузе
    async requestScrape(ids, { priority = false } = {}) {
        if (!this.dbService || !ids.length) return 0;
        const marks = ids.map(() => '?').join(',');
        const res = await this.dbService.get().run(
            `UPDATE games SET meta_retry_at = ?, meta_attempts = 0 WHERE id IN (${marks})`,
            [Date.now(), ...ids]
        );
        if (priority) for (const id of ids) { this.priority.delete(id); this.priority.add(id); }
        this.processBackgroundScrape();
        return res?.changes || 0;
    }

    // Пауза очереди поиска — до снятия, и после перезапуска сервера тоже (таблица settings)
    async loadPaused() {
        const row = await this.dbService?.get().get("SELECT value FROM settings WHERE key = 'lookup_paused'").catch(() => null);
        this.paused = row?.value === '1';
    }

    async setPaused(paused) {
        this.paused = !!paused;
        await this.dbService.get().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('lookup_paused', ?)", [this.paused ? '1' : '0']);
        if (this.io) this.io.emit('scrape-progress', { left: await this.countDue(), paused: this.paused });
        if (!this.paused) this.processBackgroundScrape();
    }

    // Следующая игра: сначала те, что человек попросил сам, потом — по сроку; на паузе — только первые
    async nextDue() {
        const now = Date.now();
        for (const id of this.priority) {
            const row = await this.dbService.get().get(
                'SELECT id, meta_attempts FROM games WHERE id = ? AND ready = 1 AND meta_retry_at IS NOT NULL AND meta_retry_at <= ?', [id, now]);
            if (row) return row;
            this.priority.delete(id);
        }
        if (this.paused) return null;
        return this.dbService.get().get(
            `SELECT id, meta_attempts FROM games
             WHERE ready = 1 AND meta_retry_at IS NOT NULL AND meta_retry_at <= ?
             ORDER BY meta_retry_at LIMIT 1`, [now]);
    }

    // Очередь для окна «Поиск данных»: что ищется сейчас (с шагами), что дальше, на паузе ли
    async queueState(limit = 30) {
        const now = Date.now();
        const rows = await this.dbService.get().all(
            `SELECT id, title FROM games WHERE ready = 1 AND meta_retry_at IS NOT NULL AND meta_retry_at <= ?
             ORDER BY meta_retry_at`, [now]);
        const first = [...this.priority];
        const order = (r) => (first.includes(r.id) ? first.indexOf(r.id) : first.length);
        const next = rows.filter((r) => r.id !== this.live?.id)
            .map((r, i) => ({ r, i })).sort((a, b) => order(a.r) - order(b.r) || a.i - b.i)
            .map(({ r }) => ({ id: r.id, title: r.title || r.id, first: this.priority.has(r.id) }));
        // left — ждут (та, что ищется сейчас, уже не ждёт)
        return { paused: !!this.paused, current: this.live, left: next.length, next: next.slice(0, limit) };
    }

    async countDue() {
        // (на паузе — то же число: игры ждут, просто поиск стоит)
        const row = await this.dbService.get().get(
            'SELECT COUNT(*) AS n FROM games WHERE ready = 1 AND meta_retry_at IS NOT NULL AND meta_retry_at <= ?',
            [Date.now()]
        ).catch(() => null);
        return row?.n || 0;
    }

    // Старые ключи Redis от прошлой очереди. Разово убираем, чтобы не путали
    async cleanupLegacyQueue() {
        try {
            await redisClient.del(['scrape:queue', 'scrape:queued_set']);
            for await (const key of redisClient.scanIterator({ MATCH: 'scrape:miss:*', COUNT: 200 })) {
                await redisClient.del(key);
            }
        } catch (e) {}
    }

    // В имени папки за номером версии идёт только служебное: разработчик, язык,
    // источник («…_1.4-Moon_Studio», «…-v1.07-rus»). cleanTitle
    // срезает хвосты лишь с конца, поэтому здесь обрываем название на самой версии.
    titleFromFolder(folder) {
        const name = stripRelease(folder
            .replace(/[-_]/g, ' ')
            // Точки между словами — тоже пробелы: «Marlows.Bakery.Quest.KG». В версии
            // («v1.03») точка между цифрами — её не трогаем
            .replace(/(\p{L})\.(?=\p{L})/gu, '$1 ')
            .replace(/\s(?:v(?:er)?\.?\s?\d+(?:\.\d+)*|\d+(?:\.\d+)+)\b.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim());
        return name || folder;
    }

    // Название из readme игры. Японские игры пишут его в первой строке «説明書»:
    // 『Seven Keys3 ～星降る宿～』説明書 — полнее, чем о себе говорит сама игра («SevenKeys3»),
    // и по нему магазин находит игру. Старые readme — в Shift_JIS
    async readmeTitle(gamePath) {
        const README = /^(?:read[\s_-]?me|説明書|取扱説明書|はじめに|最初に|お読みください|必ずお読みください)[^/]*\.(?:txt|md)$/i;
        for (const dir of [gamePath, path.join(gamePath, 'www')]) {
            let names;
            try { names = await fsp.readdir(dir); } catch (e) { continue; }
            for (const name of names.filter((n) => README.test(n))) {
                try {
                    const buf = (await fsp.readFile(path.join(dir, name))).subarray(0, 4096);
                    let text = new TextDecoder('utf-8').decode(buf);
                    if (text.includes('\uFFFD')) text = new TextDecoder('shift_jis').decode(buf);
                    const m = text.slice(0, 600).match(/『([^』\n]{2,80})』|「([^」\n]{2,80})」/);
                    const title = (m?.[1] || m?.[2] || '').trim();
                    if (/[\p{L}\p{N}]/u.test(title)) return title;
                } catch (e) {}
            }
        }
        return '';
    }

    // Что искать для игры: сохранённые ссылки и название из самой игры
    async lookupInputs(folder) {
        const gamePath = path.join(this.GAMES_DIR, folder);
        const saved = await this.dbService.get().get('SELECT link, meta_locked, links_removed FROM games WHERE id = ?', [folder]);
        let locked = [];
        try { locked = JSON.parse(saved?.meta_locked || '[]') || []; } catch (e) {}
        // Все известные ссылки, а не только первая. Раньше дальше первой
        // ничего не проходило: Steam и VNDB искались заново по названию, и если в
        // этот раз не находились — их ссылки выпадали из карточки при повторном проходе.
        const savedLinks = this.searchableLinks(saved?.link, locked.includes('link'));
        // Всё одной строкой: разбор вытащит оттуда каждую ссылку.
        const query = savedLinks.join(' ');

        const folderTitle = this.titleFromFolder(folder);
        let title = folderTitle;
        try {
            const sys = JSON.parse(await fsp.readFile(path.join(gamePath, 'data', 'System.json'), 'utf8'));
            if (sys.gameTitle && !sys.gameTitle.toLowerCase().includes('rmmz')) title = sys.gameTitle;
        } catch (e) {}
        // Имя папки не выбрасываем: оно часто совпадает со страницей в каталоге лучше,
        // чем название, которое игра пишет о себе сама. Название из readme — тоже.
        // removed — ссылки, которые человек убрал сам: эти страницы поиск пропускает
        return {
            title, query, altTitle: folderTitle, readmeTitle: await this.readmeTitle(gamePath),
            removed: parseRemoved(saved?.links_removed),
        };
    }

    // Какие из ссылок игры подавать в поиск как точные. Ссылки Steam и VNDB, которые нашёл сам
    // автопоиск, — нет: они найдены по названию, и однажды принятая чужая игра находилась бы
    // снова и снова. Их поиск находит заново — и сверяет. Вписанные руками (manual) идут все
    searchableLinks(link, manual) {
        return splitLinks(link).filter((l) => manual || !BY_TITLE.test(l));
    }

    // Поиск с отчётом: кроме найденного — список источников, которые не ответили.
    // Только так «игры нигде нет» отличается от «Steam упёрся в лимит»: раньше
    // оба случая выглядели одинаково и получали одинаковую недельную пометку.
    // unreachable — сайты, которые спрашивали по названию и не дождались ответа (см. noteUnreachable);
    // journal — как искали: шаги по сайтам и похожее, что не подошло (окно игры, «Как искали»)
    // onStep — шаг поиска сразу, как сделан (окно игры показывает поиск вживую)
    async lookupMetadata(title, query, { altTitle = '', readmeTitle = '', removed = [], onStep = null } = {}) {
        const run = newRun(onStep);
        const data = await lookupRun.run(run, () => this.fetchUniversalMetadata(title, query, { altTitle, readmeTitle, removed }));
        return { data, failed: [...run.failed], unreachable: [...run.unreachable], journal: journalOf(run) };
    }

    // Записать итог поиска в игру. Одно место и для фоновой очереди, и для ручной
    // правки: раньше у них были свои правила, и ручная при неудаче стирала теги.
    //   manual       — поля, которые человек только что поменял сам: они главнее
    //                  найденного и дальше защищены от автопоиска
    //   prevAttempts — неудач подряд до этой попытки; ручной поиск передаёт 0
    //   replace      — человек вписал новые ссылки или код: найденное заменяет прежнее, даже если
    //                  какой-то сайт не ответил (прежнее могло быть про другую игру)
    // Человек убрал ссылки (meta_rebuild = 1, ставит routes/games.js) — данные собираются заново,
    // только с оставшихся страниц; чего они не дали, стирается: это было с убранной (чужой) игры.
    // Сделать это можно, только когда ответили все сайты, — до тех пор отметка держится
    // Правила записи (их проверяют «Сценарии» в server.test.js):
    //   • нашлось хоть что-то — записываем всё найденное, даже одну ссылку;
    //   • не нашлось ничего — ничего и не стираем;
    //   • какой-то сайт не ответил — записанное раньше не заменяем, только заполняем пустое;
    //   • ссылки, которые человек убрал сам, не возвращаются, и данные с их страниц — тоже;
    //   • найденная по названию ссылка (Steam, VNDB) уходит, только если её сайт
    //     ответил и игру не подтвердил; не ответил — остаётся
    async applyLookup(folder, { data, failed, unreachable = [], journal = null }, { manual = {}, prevAttempts = 0, replace = false } = {}) {
        const db = this.dbService.get();
        const row = await db.get('SELECT * FROM games WHERE id = ?', [folder]);
        if (!row) return null;

        let locked = [];
        try { locked = JSON.parse(row.meta_locked || '[]'); } catch (e) {}
        locked = [...new Set([...locked, ...Object.keys(manual)])];
        const removed = new Set(parseRemoved(row.links_removed));
        const wanted = (l) => !removed.has(linkKey(l));

        const found = !!data;
        const fields = {};
        let media = null;
        if (found) {
            // Какой-то сайт в этот раз не ответил — найденное могло прийти с сайта послабее: теги
            // Steam вместо тегов VNDB, описание Steam вместо описания itch.io. Тогда записанное раньше
            // не заменяем, только заполняем пустое: в следующий раз ответят все
            const keepOld = failed.length > 0 && !replace;
            const filled = (v) => !!v && v !== '[]' && v !== '""';
            const free = (key) => !(keepOld && filled(row[key]));
            if (data.tags?.length && free('tags')) fields.tags = JSON.stringify(data.tags);
            if (data.description && free('description')) fields.description = data.description;
            // Язык отсюда не берём: магазин знает язык своего издания, а не того, что
            // лежит в папке. Его определяет utils/gamelang.js по тексту самой игры
            for (const key of ['developer', 'releaseDate']) {
                if (!locked.includes(key) && data[key] && free(key)) fields[key] = data[key];
            }
            // Ссылки, введённые руками, остаются первыми; найденные дописываются следом
            // Повторный поиск не должен терять то, что уже было известно: источник мог
            // не ответить именно сейчас. Найденное идёт первым, известное — следом
            const discovered = splitLinks(data.link).filter(wanted);
            if (locked.includes('link')) {
                fields.link = [...new Set([...splitLinks(manual.link ?? row.link), ...discovered])].join(',');
            } else if (discovered.length) {
                // Прежняя ссылка Steam или VNDB остаётся, только если сайт сейчас не ответил.
                // Ответил и её не подтвердил — это была чужая игра: «SkyKnight» получала
                // «Sky Knight Quest» из Steam, и ссылка держалась бы в карточке навсегда
                const silent = [...failed, ...unreachable];
                const answered = (l) => !silent.some((host) => l.includes(host.split('.').slice(-2).join('.')));
                const kept = splitLinks(row.link).filter((l) => wanted(l) && !(BY_TITLE.test(l) && answered(l)));
                fields.link = [...new Set([...discovered, ...kept])].join(',');
            }

            let screensNow = [];
            try { screensNow = JSON.parse(row.screens || '[]') || []; } catch (e) {}
            // Найденные раньше обложку и кадры при неответившем сайте тоже не трогаем. Обложка из
            // папки самой игры (титульный экран) — не найденная: её найденная заменить может
            const foundCover = String(row.cover || '').startsWith('_media/');
            const mediaData = keepOld ? {
                ...data,
                ...(foundCover ? { coverUrl: '' } : {}),
                ...(filled(row.screens) ? { screens: [], spareScreens: [] } : {}),
            } : data;
            media = await this.saveGameMedia(folder, mediaData, row.cover, screensNow);
            if (media.cover) fields.cover = media.cover;
            if (media.screens.length) fields.screens = JSON.stringify(media.screens);
        }

        // Ссылку убрали: описание, теги и кадры с её страницы (обычно — чужой игры, найденной по
        // названию) не должны остаться. Чего не дали оставшиеся страницы — стираем. Какой-то сайт
        // не ответил — не стираем ничего: его данные могли быть верными. Тогда отметка остаётся,
        // и поиск повторится скоро, как после сбоя
        const rebuild = !!row.meta_rebuild;
        const everyone = !failed.length && !unreachable.length;
        if (rebuild && everyone) {
            fields.meta_rebuild = 0;
            if (!fields.tags) fields.tags = '[]';
            if (!fields.description) fields.description = '';
            for (const key of ['developer', 'releaseDate']) {
                if (!locked.includes(key) && !fields[key]) fields[key] = '';
            }
            if (!fields.screens) fields.screens = '[]';
            // Найденная обложка — тоже с убранной страницы; своя загруженная остаётся. Вместо неё —
            // картинка из самой игры, как у только что добавленной
            const foundCover = /^_media\//.test(row.cover || '') && !/cover_custom/i.test(row.cover || '');
            if (!fields.cover && foundCover) {
                let own = null;
                try { own = await this.dbService.gameImageCover?.(folder, path.join(this.GAMES_DIR, folder)); } catch (e) {}
                fields.cover = own || null;
            }
        }

        // Итог считаем по тому, что лежит у игры после записи: если поиск ничего
        // не дал, но теги остались с прошлого раза, игра не становится «не найденной»
        const status = statusOfRow({ ...row, ...fields }, failed);
        const plan = rebuild && !everyone ? planNext('error', prevAttempts) : planNext(status, prevAttempts);
        Object.assign(fields, {
            meta_status: status,
            meta_attempts: plan.attempts,
            meta_retry_at: plan.retryAt,
            meta_checked_at: Date.now(),
            meta_error: status === 'error' ? failed.join(', ') : '',
            meta_locked: JSON.stringify(locked),
            scraped: 1,
        });
        // Журнал «Как искали» — последнего поиска
        if (journal) fields.meta_log = JSON.stringify(journal);

        const keys = Object.keys(fields);
        await db.run(
            `UPDATE games SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
            [...keys.map(k => fields[k]), folder]
        );
        await invalidateGamesList();
        // Прежние картинки убираем через минуту: страницы, открытые до поиска, успеют
        // получить новые адреса и не покажут пустые рамки на месте удалённых файлов
        if (media?.stale.length) {
            setTimeout(() => media.stale.forEach((f) => fsp.unlink(f).catch(() => {})), 60 * 1000).unref();
        }
        return { found, status, retryAt: plan.retryAt, failed, row: { ...row, ...fields } };
    }

    // Воркер. Берёт из базы игру, у которой подошёл срок, ищет, записывает итог
    // и срок следующей попытки. Если сервер перезапустят посреди поиска, ничего
    // не потеряется: пока итог не записан, срок у игры по-прежнему «подошёл».
    async processBackgroundScrape() {
        // OFFLINE=1 — данные не ищем: игры остаются «ждут поиска» (config/index.js)
        if (OFFLINE || this.isBackgroundScraping || !this.dbService) return;
        this.isBackgroundScraping = true;
        let processed = 0;

        try {
            for (;;) {
                const game = await this.nextDue();
                if (!game) break;
                const folder = game.id;
                this.currentId = folder;
                this.priority.delete(folder);
                processed++;

                try {
                    console.log(`[Queue] ⏳ Поиск метаданных: ${folder}`);
                    const { title, query, altTitle, readmeTitle, removed } = await this.lookupInputs(folder);
                    // Что ищется сейчас и шаги — вживую в окно игры и окно очереди
                    this.live = { id: folder, title, startedAt: Date.now(), steps: [] };
                    if (this.io) this.io.emit('lookup-start', { id: folder, title });
                    const onStep = (step, n) => {
                        this.live?.steps.push(step);
                        if (this.io) this.io.emit('lookup-step', { id: folder, step, n });
                    };
                    const lookup = await this.lookupMetadata(title, query, { altTitle, readmeTitle, removed, onStep });
                    const result = await this.applyLookup(folder, lookup, { prevAttempts: game.meta_attempts || 0 });

                    const next = result.retryAt ? new Date(result.retryAt).toISOString().slice(0, 16).replace('T', ' ') : 'не будет';
                    console.log(`[Queue] ${result.found ? '✅' : '⚠️'} ${folder}: ${result.status}` +
                        (result.failed.length ? ` (не ответили: ${result.failed.join(', ')})` : '') +
                        `, следующая попытка: ${next}`);
                    if (result.found && this.io) {
                        this.io.emit('scrape-success', { kind: 'found', title, message: `Данные для «${title}» найдены` });
                    }
                } catch (e) {
                    // Сбой нашего кода, а не источника. Срок сдвигаем по той же политике,
                    // иначе цикл тут же схватил бы эту игру снова и крутился на ней вечно.
                    console.error(`[Queue] ❌ Ошибка для ${folder}:`, e.message);
                    const plan = planNext('error', game.meta_attempts || 0);
                    await this.dbService.get().run(
                        'UPDATE games SET meta_status = ?, meta_attempts = ?, meta_retry_at = ?, meta_error = ?, meta_checked_at = ? WHERE id = ?',
                        ['error', plan.attempts, plan.retryAt, String(e.message).slice(0, 200), Date.now(), folder]
                    ).catch(() => {});
                    await invalidateGamesList();
                }

                this.live = null;
                if (this.io) this.io.emit('lookup-done', { id: folder });
                // Показываем ход дела в интерфейсе: сколько игр ещё ждёт
                if (this.io) this.io.emit('scrape-progress', { left: await this.countDue(), paused: !!this.paused });

                // Пауза, чтобы не получить бан от источников
                await new Promise(r => setTimeout(r, 4000));
            }
        } finally {
            this.isBackgroundScraping = false;
            this.currentId = null;
            this.live = null;
            // На паузе игры ждут — так и показываем, а не «всё найдено»
            if (this.io) this.io.emit('scrape-progress', { left: this.paused ? await this.countDue() : 0, paused: !!this.paused });
            // Очередь разобрана — у новых игр теперь есть данные: пора искать то,
            // что по ним ищется. Кого звать — задаёт server.js
            if (processed && this.onQueueDone) this.onQueueDone();
        }
    }

    // Потолок ScraperAPI на день — в кредитах. Цена запроса у ScraperAPI разная: форма
    // Страница itch.io стоит десять кредитов (цену он пишет в заголовке
    // ответа sa-credit-cost). Раньше считали запросы, и «30 в день» могли обойтись в 300 кредитов
    // из 1000 в месяц. Число — в «Настройках» у ScraperAPI или SCRAPER_DAILY_LIMIT, по умолчанию 30: около 1000 в месяц
    scraperDayKey() {
        return `scraperapi:used:${new Date().toISOString().slice(0, 10)}`;
    }

    async scraperCreditsLeft() {
        const limit = option('scraper_daily_limit');
        let used = 0;
        try { used = Number(await redisClient.get(this.scraperDayKey())) || 0; } catch (e) {}
        return limit - used;
    }

    // Дневной запас приложения: сколько потрачено сегодня и сколько можно
    async scraperDayState() {
        const limit = option('scraper_daily_limit');
        return { used: limit - await this.scraperCreditsLeft(), limit };
    }

    async spendScraperCredits(cost) {
        const key = this.scraperDayKey();
        try {
            if ((await redisClient.incrBy(key, cost)) === cost) await redisClient.expire(key, 2 * 86400);
        } catch (e) {}
    }

    // Запаса нет (kind 'spent') или не хватает на этот запрос ('price'). В лог — раз в день на случай
    scraperLimitReached(kind, message) {
        const day = this.scraperDayKey();
        if (this.scraperWarned?.day !== day) this.scraperWarned = { day, kinds: new Set() };
        if (!this.scraperWarned.kinds.has(kind)) {
            this.scraperWarned.kinds.add(kind);
            console.warn(`[ScraperAPI] ${message}`);
        }
        noteFailed('ScraperAPI (limit)');
        return null;
    }

    // Единая точка выхода через ScraperAPI: он обходит и региональные блокировки,
    // и часовые лимиты. Но запрос стоит кредитов (1000 в месяц), поэтому
    // зовём его только когда бесплатный путь не сработал.
    // method/body/headers — для форм: ScraperAPI пересылает POST как есть (форма запроса).
    // Ждём ответа не меньше 75 секунд: запрос, оборванный нами раньше 70, ScraperAPI списывает,
    // а ответа мы не получаем. Страница за 10 кредитов с таймаутом в 15 секунд так и пропадала
    async fetchViaScraper(url, { country = '', timeoutMs = 75000, method = 'GET', body, headers } = {}) {
        if (!scraperKey()) return null;
        const left = await this.scraperCreditsLeft();
        if (left <= 0) return this.scraperLimitReached('spent', `Дневной запас (${option('scraper_daily_limit')} кредитов) исчерпан — до завтра без него`);
        try {
            // max_cost — остаток на сегодня: дороже ScraperAPI запрос не выполнит и ничего не спишет.
            // Так страница за 10 кредитов не уходит, когда осталось 5, а форма за кредит — уходит
            const proxied = `http://api.scraperapi.com?api_key=${scraperKey()}`
                + `&url=${encodeURIComponent(url)}`
                + (country ? `&country_code=${country}` : '')
                + `&max_cost=${left}`;
            const res = await globalThis.fetch(proxied, { method, body, headers, signal: AbortSignal.timeout(Math.max(timeoutMs, 75000)) });
            // Списывает он удачные ответы (и 404) — по цене из заголовка
            if (res.ok || res.status === 404) {
                const cost = Number(res.headers?.get?.('sa-credit-cost')) || 1;
                await this.spendScraperCredits(cost);
                noteCredits(url, cost);                  // в журнал поиска игры: сколько ушло и на какой сайт
            }
            if (res.status === 403 && /max_cost/i.test(await res.text().catch(() => ''))) {
                return this.scraperLimitReached('price', `Запрос стоит ${res.headers?.get?.('sa-credit-cost') || 'больше'} кредитов, а на сегодня осталось ${left} — такие до завтра не делаем`);
            }
            if (!res.ok) {
                if (res.status === 403 || res.status === 429 || res.status >= 500) noteFailed('api.scraperapi.com');
                return null;
            }
            return await res.text();
        } catch (e) {
            noteFailed('api.scraperapi.com');
            return null;
        }
    }

    // Страница игры на itch.io. Сервер туда напрямую не пускают (Cloudflare просит
    // JavaScript), поэтому только через ScraperAPI — кредит за страницу. Нет ключа — без itch.io.
    // Разобранное храним сутки: окно новинок и поиск для библиотеки открывают одни и те же игры
    async fetchItchMetadata(rawUrl) {
        const url = itchGameUrl(rawUrl);
        if (!url) return null;
        const key = `itch:page:${url}`;
        try {
            const cached = await redisClient.get(key);
            if (cached) return JSON.parse(cached);
        } catch (e) {}
        if (!scraperKey()) return null;
        const html = await this.fetchViaScraper(url);
        const data = html ? parseItchPage(html, url) : null;
        // Страница стоит 10 кредитов ScraperAPI — храним неделю: оценка и описание меняются редко
        if (!data) noteFailed('itch.io');
        else await redisClient.set(key, JSON.stringify(data), { EX: 7 * 86400 }).catch(() => {});
        return data;
    }

    // Приводим картинку к обычному JPEG. По ссылке с расширением .jpg некоторые
    // источники отдают то AVIF, то WebP, а обложкой темы бывает анимация на полтора мегабайта —
    // браузер такое либо не покажет, либо покажет мультик вместо обложки.
    // ffmpeg берёт первый кадр и заодно отсеивает битые файлы: что не декодируется,
    // то и не сохраняем.
    async toJpeg(buf) {
        // Исходник кладём во временный файл: через pipe ffmpeg не читает GIF —
        // его демультиплексору нужна перемотка, и картинка молча терялась.
        const tmp = path.join(os.tmpdir(), `rpgimg_${crypto.randomBytes(8).toString('hex')}`);
        try {
            await fsp.writeFile(tmp, buf);
            const out = await new Promise((resolve) => {
                const proc = spawn('ffmpeg', [
                    '-v', 'error', '-i', tmp, '-frames:v', '1',
                    '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', '-f', 'mjpeg', 'pipe:1',
                ]);
                const chunks = [];
                proc.stdout.on('data', (d) => chunks.push(d));
                proc.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
                proc.on('error', () => resolve(null));
            });
            return out && out.length > 1024 ? out : null;
        } catch (e) {
            return null;
        } finally {
            await fsp.unlink(tmp).catch(() => {});
        }
    }

    // Размер кадра читаем прямо из заголовка JPEG (маркер SOF), без лишнего процесса.
    // Нужен, чтобы отличить настоящий скриншот от превью 400×250 и от значка под темой.
    jpegSize(buf) {
        for (let i = 2; i + 9 < buf.length;) {
            if (buf[i] !== 0xff) { i += 1; continue; }
            const marker = buf[i + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            const len = buf.readUInt16BE(i + 2);
            const isSOF = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
            if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
            i += 2 + len;
        }
        return { width: 0, height: 0 };
    }

    // Грубый отпечаток картинки: уменьшаем до 16×16 в оттенках серого и сравниваем
    // каждую точку со средней яркостью. Одна и та же картинка в разных файлах даёт
    // почти одинаковый код, разные — расходятся на сотню бит. ffmpeg у нас уже есть.
    async imageFingerprint(buf) {
        const raw = await new Promise((resolve) => {
            const proc = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=16:16', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
            const chunks = [];
            proc.stdout.on('data', (d) => chunks.push(d));
            proc.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
            proc.on('error', () => resolve(null));
            proc.stdin.on('error', () => {});
            proc.stdin.end(buf);
        });
        if (!raw || raw.length < 64) return null;

        const mean = raw.reduce((sum, v) => sum + v, 0) / raw.length;
        return [...raw].map((v) => (v > mean ? 1 : 0));
    }

    // Картинки складываем в отдельную папку _media, а не внутрь игры: папки игр
    // мы не трогаем принципиально, да и на проде они бывают только для чтения.
    // Имена картинок — по содержимому («cover-3f2a9c1b7e.jpg», «2-9d0e4b77aa.jpg»). Раньше
    // обложка всегда была cover.jpg, а кадры — 1.jpg…6.jpg: после нового поиска адреса не
    // менялись, и браузер показывал старые картинки из своего кэша, пока страницу не
    // обновят. Сменилась картинка — сменился адрес. Прежние файлы игры, на которые ещё
    // смотрит база, возвращаются в stale: их удалит applyLookup, когда запишет новые адреса
    async saveGameMedia(folder, data, currentCover, currentScreens = []) {
        const result = { cover: null, screens: [], stale: [] };
        const dir = path.join(this.GAMES_DIR, '_media', folder);
        const named = (prefix, buf) => `${prefix}-${crypto.createHash('md5').update(buf).digest('hex').slice(0, 10)}.jpg`;

        try {
            await fsp.mkdir(dir, { recursive: true });
        } catch (e) {
            return result;
        }

        // Скачиваем в память и считаем отпечаток: источники любят отдавать обложку
        // ещё раз первым семплом, а платные страницы — одну и ту же заглушку.
        const seen = new Set();          // точные совпадения по содержимому
        const prints = [];               // отпечатки: ловят одну картинку в разных файлах
        const TOO_CLOSE = 6;             // расстояние, ниже которого считаем картинку повтором

        const remember = async (buf) => {
            const print = await this.imageFingerprint(buf);
            if (!print) return true;     // ffmpeg не справился — не мешаем сохранению
            const duplicate = prints.some((old) => old.reduce((n, v, i) => n + (v !== print[i] ? 1 : 0), 0) <= TOO_CLOSE);
            if (duplicate) return false;
            prints.push(print);
            return true;
        };

        // minWidth отсекает мелочь: превью (400 px), значки движка и баннеры
        // под шапкой страницы. Настоящий кадр из игры всегда шире.
        const grab = async (url, { minWidth = 0 } = {}) => {
            try {
                const res = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' },
                    signal: AbortSignal.timeout(30000),
                });
                if (!res.ok) return null;
                const raw = Buffer.from(await res.arrayBuffer());
                if (raw.length < 2048 || raw.length > 25 * 1024 * 1024) return null;

                const hash = crypto.createHash('md5').update(raw).digest('hex');
                if (seen.has(hash)) return null;
                seen.add(hash);

                const buf = await this.toJpeg(raw);
                if (!buf) return null;

                const { width, height } = this.jpegSize(buf);
                if (width < minWidth || height < Math.round(minWidth / 2)) return null;

                if (!await remember(buf)) return null;
                return buf;
            } catch (e) {
                return null;
            }
        };

        // Обложка со страницы игры — она официальная и не повторяет кадры. Свою загруженную
        // не трогаем никогда.
        const isManual = /cover_custom/i.test(currentCover || '');
        let coverUrlUsed = false;
        if (!isManual) {
            let saved = null;

            if (data.coverUrl) {
                saved = await grab(data.coverUrl, { minWidth: 300 });
                coverUrlUsed = !!saved;
            }

            if (saved) {
                const name = named('cover', saved);
                await fsp.writeFile(path.join(dir, name), saved);
                await remember(saved);   // чтобы тот же рисунок не приехал первым семплом
                result.cover = `_media/${folder}/${name}`;
            }
        }

        // Картинка из шапки страницы — такой же кадр из игры. Если обложку дал другой источник,
        // она осталась неиспользованной, и в галерее не хватало одного скриншота.
        const shots = [...(data.screens || [])];
        if (data.coverUrl && !coverUrlUsed) shots.unshift(data.coverUrl);
        // Кадры бывают превьюшками, которые отсеет minWidth, — добираем до шести
        // запасными кадрами магазина. Повторы одной картинки отсечёт отпечаток в grab
        shots.push(...(data.spareScreens || []));

        // Сначала собираем кадры в памяти и только потом переписываем папку: если в
        // этот раз ничего не нашлось, старая галерея останется на месте, а если
        // нашлось меньше прежнего — в папке не останется хвостов от прошлого разбора.
        const picked = [];
        for (const url of shots) {
            if (picked.length >= 6) break;
            // 500 px — граница между превью (400×250) и настоящей картинкой:
            // кадры магазина идут как раз 560×420, их терять нельзя
            const buf = await grab(url, { minWidth: 500 });
            if (buf) picked.push(buf);
        }

        for (let i = 0; i < picked.length; i += 1) {
            const name = named(String(i + 1), picked[i]);
            await fsp.writeFile(path.join(dir, name), picked[i]);
            result.screens.push(`_media/${folder}/${name}`);
        }

        // Уборка найденного прошлыми поисками: обложка «cover.jpg»/«cover-….jpg» и кадры
        // «1.jpg»/«1-….jpg». Своя загруженная обложка (cover_custom_…) сюда не попадает.
        // Не нашлось нового — старое остаётся на месте
        const keep = new Set([result.cover, ...result.screens].filter(Boolean).map((p) => path.basename(p)));
        const inUse = new Set([currentCover, ...currentScreens].filter(Boolean).map((p) => path.basename(String(p))));
        for (const f of await fsp.readdir(dir).catch(() => [])) {
            const isCover = /^cover(?:-[0-9a-f]{10})?\.jpg$/i.test(f);
            const isShot = /^\d+(?:-[0-9a-f]{10})?\.jpg$/i.test(f);
            if (keep.has(f) || !(isCover || isShot)) continue;
            if ((isCover && !result.cover) || (isShot && !result.screens.length)) continue;
            // На прежние файлы ещё ссылаются открытые страницы — их удалим после записи базы
            if (inUse.has(f)) result.stale.push(path.join(dir, f));
            else await fsp.unlink(path.join(dir, f)).catch(() => {});
        }
        return result;
    }


    async translateText(text, targetLang = 'en') {
        if (!text) return '';
        // В адрес запроса помещается около 1300 символов, поэтому длинный текст режем на куски
        const chunks = String(text).match(/[\s\S]{1,1200}/g) || [];
        const parts = [];
        try {
            for (const chunk of chunks) {
                // client=dict-chrome-ex вместо gtx: gtx с нашего адреса отвечает 429 (нас ограничивают)
                const url = `https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${targetLang}&q=${encodeURIComponent(chunk)}`;
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 8000);
                try {
                    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    // Ответ бывает двух видов: [["перевод","ja"]] и ["перевод"]
                    parts.push(data.map(item => (Array.isArray(item) ? item[0] : item)).join(''));
                } finally {
                    clearTimeout(timer);
                }
            }
            return parts.join('');
        } catch (e) {
            console.warn('[Translate] Не удалось перевести:', e.message);
            return text; // отдаём оригинал, как и раньше
        }
    }

    async fetchVNDBMetadata(query, verify = [query]) {
        try {
            let filter = ["search", "=", query];
            if (/^v\d+$/.test(query)) {
                filter = ["id", "=", query]; 
            }
            const res = await sourceFetch('https://api.vndb.org/kana/vn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filters: filter, fields: "title, released, description, image.url, tags.name" })
            });
            const data = await res.json();
            if (data.results && data.results.length > 0) {
                const vn = data.results[0];

                if (!/^v\d+$/.test(query)) {
                    // Раньше хватало вхождения: игра «Dancer» получала описание новеллы
                    // «My Pet Dancer». Теперь порог выше
                    const similar = bestSimilarity(vn.title, verify);
                    if (similar < 0.75) {
                        noteNear('vndb', { title: vn.title, link: `https://vndb.org/${vn.id}`, score: similar });
                        return null;
                    }
                    // Вся библиотека — игры на MV и MZ, а MV вышел в конце 2015-го.
                    // Новелла старше — однофамилица: «Seven Keys» (RPG) получала
                    // описание «Sister Sister» 2006 года
                    const year = parseInt(String(vn.released || ''), 10);
                    if (year && year < 2015) return null;
                }

                let desc = (vn.description || '').replace(/\[\/?(b|i|u|url|spoiler|quote)[^\]]*\]/gi, '').trim();
                return { 
                    coverUrl: vn.image ? vn.image.url : null, 
                    description: desc, 
                    tags: vn.tags ? vn.tags.map(t => t.name) : [],
                    releaseDate: vn.released ? vn.released.substring(0, 4) : '',
                    link: `https://vndb.org/${vn.id}`,
                    developer: '',
                    language: ''
                };
            }
        } catch (e) {}
        return null;
    }

    // authors — автор игры, каким его знают другие источники: по нему выбираем
    // между одноимёнными играми Steam
    async fetchSteamMetadata(query, verify = [query], authors = []) {
        try {
            const details = async (id) => {
                const detailRes = await sourceFetch(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=US&l=english`, { headers: STEAM_HEADERS });
                const detailData = await detailRes.json();
                // Переизданную игру магазин отдаёт под номером новой страницы: на запрос
                // 3938710 ответ приходит с ключом 5257330. Спрашивали один номер — берём
                // единственный ответ, как бы он ни был подписан
                const detail = detailData?.[id] || Object.values(detailData || {})[0];
                return detail?.success ? detail.data : null;
            };
            let appId = query;
            let game = null;
            if (!/^\d+$/.test(query)) {
                const searchRes = await sourceFetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=US`, { headers: STEAM_HEADERS });
                const searchData = await searchRes.json();
                // Порог как у VNDB: простого вхождения хватало, чтобы «Dancer»
                // превратилась в «Rift of the NecroDancer». Берём самое похожее из первых пяти
                const all = (searchData.items || []).slice(0, 5)
                    .map((item) => ({ id: item.id, name: item.name, score: bestSimilarity(item.name, verify) }));
                const scored = all.filter((x) => x.score >= 0.75);
                if (!scored.length) {
                    const near = all.sort((a, b) => b.score - a.score)[0];
                    if (near) noteNear('steam', { title: near.name, link: `https://store.steampowered.com/app/${near.id}`, score: near.score });
                    return null;
                }
                const top = Math.max(...scored.map((x) => x.score));
                const tied = scored.filter((x) => x.score === top);
                appId = tied[0].id;
                // Одноимённых игр в Steam бывает несколько — «Moon Witch» две, у разных авторов.
                // Берём ту, чей разработчик или издатель — автор, известный от других сайтов.
                // Не совпал ни один — первую, как раньше: itch.io пишет автора по-английски
                // («Moon Studio»), а Steam — как сам автор («ムーン工房»)
                if (tied.length > 1 && authors.length) {
                    for (const x of tied.slice(0, 3)) {
                        const data = await details(x.id);
                        if (data && sameAuthor([...(data.developers || []), ...(data.publishers || [])], authors)) {
                            appId = x.id;
                            game = data;
                            break;
                        }
                    }
                }
            }

            game = game || await details(appId);
            if (game) {
                const desc = (game.short_description || game.about_the_game || '').replace(/<[^>]*>?/gm, '').trim();

                // Обложка: сначала вертикальная витрина 600×900 — она по форме как
                // остальные обложки в сетке. Широкий баннер шапки оставляем запасным:
                // у карточки он выглядит полоской.
                let coverUrl = game.header_image;
                try {
                    const capsule = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
                    const head = await sourceFetch(capsule, { method: 'HEAD', headers: STEAM_HEADERS, signal: AbortSignal.timeout(10000) });
                    if (head.ok) coverUrl = capsule;
                } catch (e) {}

                return { 
                    coverUrl, 
                    // Кадры из игры магазин отдаёт прямо в ответе, а мы их не брали —
                    // у игр из Steam галерея всегда оставалась пустой
                    screens: (game.screenshots || []).slice(0, 6).map(x => x.path_full).filter(Boolean),
                    description: desc, 
                    tags: game.genres ? game.genres.map(g => g.description) : [],
                    developer: game.developers ? game.developers.join(', ') : '',
                    releaseDate: game.release_date?.date ? (game.release_date.date.match(/\d{4}/)?.[0] || '') : '',
                    link: `https://store.steampowered.com/app/${appId}`,
                    language: 'Multi'
                };
            }
        } catch (e) {}
        return null;
    }

    // altTitle — название из имени папки. Игра сама себя часто называет иначе, чем
    // страница в каталоге («Moonlit Harbour» против «Moonlit Harbor»), а папку обычно
    // называют так, как было при скачивании.
    // Поиск данных игры по всем источникам сразу. Общее знание:
    //   точные ссылки — itch.io, Steam, VNDB;
    //   названия — из самой игры, папки и readme.
    // Источники идут по порядку: itch.io (страница по ссылке), VNDB, Steam. Найденное по названию
    // сверяется со всеми названиями игры, а не с одним
    // removed — ключи ссылок (utils/links.js), которые человек убрал из игры сам: эти страницы
    // пропускаем целиком — ни ссылки, ни данных с них, даже если источник находит их снова
    async fetchUniversalMetadata(title, inputQuery, { altTitle = '', readmeTitle = '', removed = [] } = {}) {
        const aggregatedData = {
            tags: [], description: '', coverUrl: '', screens: [], developer: '', releaseDate: '', language: '',
            // Кадры Steam — запас после кадров страницы игры, см. saveGameMedia
            spareScreens: [],
            links: []
        };
        let foundAny = false;
        const refused = new Set(removed);
        const unwanted = (link) => !!link && refused.has(linkKey(link));
        // Спросить источник и записать шаг в журнал: нашёл, ответил «нет», не ответил или нашёл страницу,
        // которую человек убрал из игры (её не берём)
        const ask = async (site, by, q, call) => {
            const before = failuresSoFar();
            const page = await call();
            if (page && unwanted(page.link)) {
                noteStep({ site, by, q, result: 'refused', link: page.link });
                return null;
            }
            noteStep({ site, by, q, result: page ? 'found' : failuresSoFar() > before ? 'down' : 'none', link: page?.link });
            return page || null;
        };

        let explicitSteam = null;
        let explicitVndb = null;
        let explicitItch = '';

        if (inputQuery) {
            if (inputQuery.match(/app\/(\d+)/i)) explicitSteam = inputQuery.match(/app\/(\d+)/i)[1];
            // Номер новеллы — только из самой ссылки vndb.org: «v1» встречается и в других адресах
            const vndb = inputQuery.match(/vndb\.org\/(v\d+)/i);
            if (vndb) explicitVndb = vndb[1].toLowerCase();
            explicitItch = itchGameUrl(inputQuery);
        }

        // Названия игры: из неё самой, из имени папки (архива) и из readme. Полные идут раньше коротких, и
        // найденное по названию сверяем с полными: игра зовёт себя «SkyKnight», а архив —
        // «SkyKnight_TheCrystalLabyrinth», и без этого Steam отдавал ей чужую «Sky Knight Quest»
        // (см. searchNames в utils/title.js)
        const names = searchNames([title, altTitle, readmeTitle]);
        const latin = () => names.search.filter((n) => !CJK.test(n));
        // Несколько разных названий: «Marlow, City of Bakers» у игры и «Marlow Town of Bakers»
        // у архива — магазин знает второе, и искать надо оба
        const distinct = (list, n) => {
            const out = [];
            for (const x of list) if (out.length < n && !out.some((o) => normTitle(o) === normTitle(x))) out.push(x);
            return out;
        };

        // itch.io — страница только по ссылке, вписанной руками: она идёт через ScraperAPI (кредит),
        // а по названию легко найти чужую
        if (explicitItch) {
            const itch = await ask('itch', 'link', explicitItch, () => this.fetchItchMetadata(explicitItch));
            if (itch) {
                foundAny = true;
                aggregatedData.links.push(itch.link);
                aggregatedData.tags = itch.tags;
                aggregatedData.description = itch.description;
                aggregatedData.developer = itch.developer;
                aggregatedData.releaseDate = itch.releaseDate;
                aggregatedData.coverUrl = itch.coverUrl;
                aggregatedData.screens = itch.screens;
            }
        }

        // VNDB и Steam — по точной ссылке, а без неё по двум разным названиям, со сверкой
        // со всеми названиями игры
        const verify = (q) => (names.verify.length ? names.verify : [q]);
        const vndbQueries = explicitVndb ? [explicitVndb] : distinct(names.search.filter((q) => q.length >= 3), 2);
        for (const q of vndbQueries) {
            const vndbData = await ask('vndb', /^v\d+$/.test(q) ? 'link' : 'title', q, () => this.fetchVNDBMetadata(q, verify(q)));
            if (!vndbData) continue;
            foundAny = true;
            if (vndbData.link) aggregatedData.links.push(vndbData.link);
            if (aggregatedData.tags.length === 0 && vndbData.tags) aggregatedData.tags = vndbData.tags;
            aggregatedData.coverUrl = aggregatedData.coverUrl || vndbData.coverUrl || '';
            aggregatedData.description = aggregatedData.description || vndbData.description || '';
            aggregatedData.developer = aggregatedData.developer || vndbData.developer || '';
            aggregatedData.releaseDate = aggregatedData.releaseDate || vndbData.releaseDate || '';
            break;
        }

        const steamQueries = explicitSteam ? [explicitSteam] : distinct(latin().filter((q) => q.length >= 3), 2);
        const authors = [...new Set([aggregatedData.developer]
            .flatMap((d) => String(d || '').split(/\s*[,/]\s*/)).filter(Boolean))];
        for (const q of steamQueries) {
            const steamData = await ask('steam', /^\d+$/.test(q) ? 'link' : 'title', q, () => this.fetchSteamMetadata(q, verify(q), authors));
            if (!steamData) continue;
            foundAny = true;
            if (steamData.link) aggregatedData.links.push(steamData.link);
            if (aggregatedData.tags.length === 0 && steamData.tags) aggregatedData.tags = steamData.tags;
            aggregatedData.coverUrl = aggregatedData.coverUrl || steamData.coverUrl || '';
            // Steam найден по названию, а страница itch.io — по точной ссылке: кадры Steam только
            // запасом, а без кадров itch.io — основными
            if (aggregatedData.screens.length) aggregatedData.spareScreens.push(...(steamData.screens || []));
            else aggregatedData.screens = steamData.screens || [];
            aggregatedData.description = aggregatedData.description || steamData.description || '';
            aggregatedData.developer = aggregatedData.developer || steamData.developer || '';
            aggregatedData.releaseDate = aggregatedData.releaseDate || steamData.releaseDate || '';
            aggregatedData.language = aggregatedData.language || steamData.language || '';
            break;
        }

        if (!foundAny) return null;

        aggregatedData.tags = [...new Set(aggregatedData.tags)];
        aggregatedData.link = [...new Set(aggregatedData.links)].join(',');

        return aggregatedData;
    }
}

module.exports = new ScraperService();
// Для тестов: подменённый сайт отмечает «не ответил» так же, как настоящий
module.exports.noteFailed = noteFailed;
module.exports.sourceFetch = sourceFetch;
