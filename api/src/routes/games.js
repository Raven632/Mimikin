const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const dbService = require('../db/database.js');
const scraperService = require('../services/scraper.js');
const { GAMES_DIR, SAVES_DIR, OLD_DIR, TRASH_DIR, OFFLINE } = require('../config/index.js');
const { offlineMeta } = require('../utils/offline.js');
const { coverUpload } = require('../utils/upload.js');
const { getFolderSize } = require('../utils/archive.js');
const { validateIdParam } = require('../utils/validate.js');
const { redisClient, invalidateGamesList, GAMES_LIST_KEY, emitToPerson } = require('../utils/cache.js');
const { normalizeTags } = require('../utils/tags.js');
const { shownTitle } = require('../utils/title.js');
const { installedVersion } = require('../utils/version.js');
const { splitLinks, linkKey, removedAfterEdit, parseRemoved } = require('../utils/links.js');
const { duplicateGroups, shelfMatches, improvable, coverage } = require('../utils/audit.js');
const { createCopies } = require('../services/copies.js');
const uploadService = require('../services/uploads.js');
const { createTrash } = require('../services/trash.js');
const shownMeta = OFFLINE ? offlineMeta : (meta) => meta;
const gameArchive = require('../services/gameArchive.js');
const { pipeline } = require('stream');
const spaceService = require('../services/space.js');
const translateService = require('../services/translate.js');
const pictureService = require('../services/pictures.js');
const sceneLines = require('../services/sceneLines.js');
const galleryService = require('../services/gallery.js');
const personal = require('../services/personal.js');
const { cleanName, goodName, cleanLists, parseLists, renamed, NOTES_MAX } = require('../utils/gameLists.js');
const SERIES_MAX = 120;

const router = express.Router();

// Все роуты с :id — только безопасное имя папки (без "." / ".." / слэшей)
router.param('id', validateIdParam);

let isCalculatingSizes = false; // Глобальный замок

const trash = createTrash({ db: () => dbService.get(), trashDir: TRASH_DIR, gamesDir: GAMES_DIR, onChange: invalidateGamesList });
const copies = createCopies({ db: () => dbService.get(), trash, savesDir: SAVES_DIR, gamesDir: GAMES_DIR, onChange: invalidateGamesList });

// --- КОРЗИНА (services/trash.js): удалённые игры 30 дней ---
router.get('/trash', async (req, res) => {
    try {
        // ?count=1 — только число (строка состояния в «Настройках»): размеры папок для него не считаем, это долго
        if (req.query.count) return res.json({ count: await trash.count() });
        res.json({ items: await trash.list() });
    } catch (e) {
        console.error('[Корзина]', e.message);
        res.status(500).json({ error: 'Не удалось прочитать корзину' });
    }
});

router.post('/trash/:key/restore', async (req, res) => {
    try {
        const back = await trash.restore(req.params.key);
        // Вернули из корзины — реплики снова в поиске (сценарии галереи в _media остались)
        if (back?.id) sceneLines.indexGame(back.id).catch((e) => console.warn(`[Реплики] ${back.id}: ${e.message}`));
        res.json({ success: true, ...back });
    } catch (e) {
        if (!e.status) console.error('[Корзина]', e.message);
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось вернуть игру', reason: e.reason });
    }
});

router.delete('/trash/:key', async (req, res) => {
    try {
        await trash.remove(req.params.key);
        res.json({ success: true });
    } catch (e) {
        if (!e.status) console.error('[Корзина]', e.message);
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось стереть', reason: e.reason });
    }
});

// Прежние версии игры в _old/<игра>: папки по дате, старые первыми (рядом — их .json)
const oldVersionsOf = async (id) => (await fsp.readdir(path.join(OLD_DIR, id), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

// Своё у игры уже есть — сейвы (_saves/<игра>) или моменты и «Где вышли» (_saves/.marks/<игра>). Только владельца:
// сейвы других людей (_saves/.people) вопрос о переносе не блокируют
const hasPlayData = async (id) => (await fsp.readdir(path.join(SAVES_DIR, id)).catch(() => [])).length > 0
    || (await fsp.readdir(path.join(SAVES_DIR, '.marks', id)).catch(() => [])).length > 0;

// Строку пишем мы сами, но битое значение в базе не должно ронять весь список
const parseProgress = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

// Как показывать название: без версий и подписей переводчиков, японское — английским
// из папки. Название, вписанное руками в «Изменить», — как есть.
// Версия в колонке version у всех «1.0.0» по умолчанию, настоящая — в названии и папке,
// а если там её нет — вписанная руками (my_version)
function titleFields(row) {
    const shown = shownTitle(row);
    return {
        displayTitle: shown.title,
        originalTitle: shown.original,
        version: installedVersion(row),
        myVersion: row.my_version || '',
    };
}

// --- 1. ПОЛУЧЕНИЕ ВСЕХ ИГР (С КЭШИРОВАНИЕМ REDIS) ---
router.get('/', async (req, res) => {
    try {
        // [REDIS] 1. Проверяем кэш. Если есть — отдаем мгновенно!
        const cachedGames = await redisClient.get(GAMES_LIST_KEY);
        if (cachedGames) {
            const list = JSON.parse(cachedGames);
            // Список в Redis один и несёт личное владельца; человеку подменяем его поля его строками (services/personal.js)
            return res.json(personal.other(req.person) ? await personal.overlay(list, req.person) : list);
        }

        const rows = await dbService.get().all('SELECT * FROM games WHERE ready = 1');

        // =========================================================
        // БЕЗОПАСНОЕ ФОНОВОЕ ВЗВЕШИВАНИЕ (С ЗАЩИТОЙ ОТ ГОНКИ)
        // =========================================================
        // У игры с полки папки нет — взвешивать нечего, размер остаётся прежним: столько вернёт «Скачать снова»
        const gamesWithoutSize = rows.filter(r => (!r.size || r.size === 0) && !r.shelved_at);
        if (gamesWithoutSize.length > 0 && !isCalculatingSizes) {
            isCalculatingSizes = true; 
            
            setTimeout(async () => {
                try {
                    let sizeUpdated = false;
                    for (const g of gamesWithoutSize) {
                        const gamePath = path.join(GAMES_DIR, g.id);
                        const s = await getFolderSize(gamePath);
                        if (s > 0) {
                            await dbService.get().run('UPDATE games SET size = ? WHERE id = ?', [s, g.id]);
                            sizeUpdated = true;
                        }
                    }
                    // [REDIS] Сбрасываем кэш, если размеры обновились, чтобы UI увидел изменения
                    if (sizeUpdated) await invalidateGamesList();
                } catch (e) {
                    console.error('[Background] Ошибка взвешивания:', e);
                } finally {
                    isCalculatingSizes = false; 
                }
            }, 1000); 
        }
        // =========================================================

        // Прежние версии, отложенные при обновлении игры (services/uploads.js): сколько их у игры
        const oldVersions = {};
        for (const id of await fsp.readdir(OLD_DIR).catch(() => [])) {
            oldVersions[id] = (await oldVersionsOf(id)).length;
        }
        // Игры с полки: файлы в корзине ещё лежат — их можно вернуть сразу (key) до purgeAt
        const shelves = rows.some((r) => r.shelved_at) ? await trash.shelves().catch(() => new Map()) : new Map();
        const shelfOf = (row) => {
            if (!row.shelved_at) return null;
            const files = shelves.get(row.id);
            return { at: row.shelved_at, key: files?.key || '', until: files?.purgeAt || 0 };
        };
        // Загружена как новая, а похоже, это игра с полки (utils/audit.js): спросить в её окне, пока своих сейвов и
        // моментов у неё нет — с ними перенос смешал бы два прохождения
        const shelfMatch = new Map();
        for (const [id, { row, why }] of shelfMatches(rows)) {
            if (await hasPlayData(id)) continue;
            shelfMatch.set(id, { id: row.id, title: shownTitle(row).title, playtime: row.playtime || 0, why });
        }

        const games = rows.map(row => ({
            id: row.id, 
            title: row.title, 
            cover: row.cover,
            developer: row.developer || '',
            language: row.language || '',
            releaseDate: row.releaseDate || '',
            link: row.link || '',
            size: row.size || 0,
            ...titleFields(row),
            // Без этого поля значок «ждёт метаданные» горел на каждой карточке
            scraped: !!row.scraped || OFFLINE,
            tags: normalizeTags(row.tags ? JSON.parse(row.tags) : []),
            description: row.description, 
            url: `/${row.id}/`, 
            number: 0,
            addedAt: row.addedAt, 
            lastPlayed: row.lastPlayed, 
            rating: row.rating,
            status: row.status || '',
            favorite: !!row.favorite,
            notes: row.notes || '',
            lists: parseLists(row.lists),
            // Серию страница считает сама по этому же списку: человеку приходят только его игры, скрытые части не посчитать
            series: row.series || '',
            playtime: row.playtime || 0,
            progress: parseProgress(row.progress),
            screens: parseProgress(row.screens) || [],
            oldVersions: oldVersions[row.id] || 0,
            // «На полке»: { at, key, until } — файлов нет; key — их запись в корзине, пока не прошли 30 дней
            shelf: shelfOf(row),
            // «Похоже, это … с полки»: { id, title, playtime, why } — why: по чему совпали (name, code, thread)
            shelfMatch: shelfMatch.get(row.id) || null,
            // Язык по тексту самой игры: { main, langs, original }. language выше —
            // только ручная правка, она главнее
            textLang: parseProgress(row.text_lang),
            // Состояние поиска метаданных — для строчки в окне игры и для ревизии
            meta: shownMeta({
                status: row.meta_status || 'new',
                attempts: row.meta_attempts || 0,
                retryAt: row.meta_retry_at || null,
                checkedAt: row.meta_checked_at || 0,
                error: row.meta_error || '',
            }),
        })).sort((a, b) => b.addedAt - a.addedAt); 
        games.forEach((g, i) => g.number = i + 1);

        // [REDIS] 2. Сохраняем собранный список в кэш на 5 минут (300 секунд)
        await redisClient.set(GAMES_LIST_KEY, JSON.stringify(games), { EX: 300 });

        res.json(personal.other(req.person) ? await personal.overlay(games, req.person) : games);
    } catch (e) { res.status(500).json({ error: 'DB Error' }); }
});

// --- ДОГОН МЕТАДАННЫХ: ставим в очередь всех, у кого их нет ---
// Искать заново сразу для группы игр. Вызывается из ревизии: сначала видно,
// чего не хватает, и там же это чинится — раньше кнопка работала вслепую.
//   missing — не найденные и те, где источники не ответили
//   partial — с тегами, но без картинок или ссылки
//   improvable — найденные, но с пробелами, искались до последнего улучшения поиска
//     (список тот же, что в ревизии, и считает его сервер, а не присылает окно)
router.post('/rescan', async (req, res) => {
    try {
        let ids;
        if (req.body?.scope === 'improvable') {
            ids = improvable(await dbService.get().all('SELECT * FROM games WHERE ready = 1')).map((g) => g.id);
        } else {
            const scope = req.body?.scope === 'partial' ? ['partial'] : ['new', 'not_found', 'error'];
            ids = (await dbService.get().all(
                `SELECT id FROM games WHERE ready = 1 AND meta_status IN (${scope.map(() => '?').join(',')})`,
                scope
            )).map(r => r.id);
        }
        const queued = await scraperService.requestScrape(ids);
        await invalidateGamesList();
        res.json({ success: true, queued });
    } catch (e) {
        res.status(500).json({ error: 'Не удалось поставить в очередь' });
    }
});

// Очередь поиска данных: что ищется сейчас (с шагами), что дальше, на паузе ли
router.get('/lookup-queue', async (req, res) => {
    try { res.json(await scraperService.queueState()); } catch (e) { res.status(500).json({ error: 'Не удалось прочитать очередь' }); }
});
// Пауза очереди: { paused: true | false }. Игры, которые попросили искать сами, ищутся и на паузе
router.post('/lookup-queue/pause', async (req, res) => {
    try {
        await scraperService.setPaused(!!req.body?.paused);
        res.json(await scraperService.queueState());
    } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});

// «Искать сейчас» из окна игры и «Искать первой» из очереди: игра — в начало очереди
// Переименовать подборку (to) или удалить её (to нет): игры остаются. В игре, где подборка to уже есть, они сливаются
router.post('/lists/change', async (req, res) => {
    const from = cleanName(req.body?.from);
    const to = cleanName(req.body?.to);
    if (!goodName(from) || (req.body?.to !== undefined && !goodName(to))) return res.status(400).json({ error: 'Неверное имя подборки' });
    try {
        const db = dbService.get();
        // Человек переименовывает свои подборки: его строки в user_games, а не games
        const user = personal.other(req.person);
        let changed = 0;
        const rows = user
            ? await db.all("SELECT game_id AS id, lists FROM user_games WHERE user_id = ? AND lists <> '[]'", [user.id])
            : await db.all("SELECT id, lists FROM games WHERE COALESCE(lists, '[]') <> '[]'");
        for (const row of rows) {
            const list = parseLists(row.lists);
            if (!list.includes(from)) continue;
            // Только если список с чтения не менялся: иначе запись затёрла бы подборку, добавленную в эту минуту
            const { changes } = user
                ? await db.run('UPDATE user_games SET lists = ?, at = ? WHERE user_id = ? AND game_id = ? AND lists = ?', [JSON.stringify(renamed(list, from, to)), Date.now(), user.id, row.id, row.lists])
                : await db.run('UPDATE games SET lists = ? WHERE id = ? AND lists = ?', [JSON.stringify(renamed(list, from, to)), row.id, row.lists]);
            changed += changes;
        }
        if (changed) {
            if (user) emitToPerson(user.id, 'library-changed');
            else await invalidateGamesList();
        }
        res.json({ changed });
    } catch (e) {
        console.error('[Подборки]', e.message);
        res.status(500).json({ error: 'Не удалось изменить подборку' });
    }
});

router.post('/:id/rescrape', async (req, res) => {
    try {
        const queued = await scraperService.requestScrape([path.basename(req.params.id)], { priority: true });
        if (!queued) return res.status(404).json({ error: 'Игра не найдена' });
        await invalidateGamesList();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Не удалось поставить в очередь' });
    }
});

// --- РЕВИЗИЯ БИБЛИОТЕКИ ---
// Отвечает на вопросы, которых по списку игр не видно: что не запустится, что лежит
// дважды, что занимает место и ни разу не открывалось, от чего остались сейвы, хотя
// игры уже нет. Ничего не удаляет и не чинит — только показывает.
router.get('/audit', async (req, res) => {
    const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };

    try {
        const rows = await dbService.get().all('SELECT * FROM games WHERE ready = 1');

        // Движок открывает игру через index.html: либо в корне папки, либо в www —
        // ровно так его ищет раздача файлов. Нет ни того, ни другого — игра не запустится
        // Игры с полки — без файлов нарочно: ни «не запустится», ни «место занимает» к ним не относится
        const onDisk = rows.filter((g) => !g.shelved_at);
        const broken = [];
        for (const g of onDisk) {
            const dir = path.join(GAMES_DIR, g.id);
            const ok = await exists(path.join(dir, 'index.html'))
                || await exists(path.join(dir, 'www', 'index.html'));
            if (!ok) broken.push({ id: g.id, title: g.title, size: g.size || 0 });
        }

        // Одна игра в двух папках: одно название или одна страница магазина (utils/audit.js)
        const duplicates = duplicateGroups(rows, await copies.dismissed());

        const slim = (g) => ({ id: g.id, title: g.title, size: g.size || 0 });
        const bySize = (a, b) => b.size - a.size;

        const never = onDisk.filter(g => !g.lastPlayed && !g.playtime).map(slim).sort(bySize);
        const heavy = onDisk.map(slim).sort(bySize).slice(0, 10);

        // Поиск метаданных: берём готовое состояние, а не угадываем по пустым полям.
        // Раньше ревизия и кнопка «Дозагрузить» считали «без метаданных» по-разному.
        const withMeta = (g) => ({ ...slim(g), status: g.meta_status, retryAt: g.meta_retry_at || null, error: g.meta_error || '' });
        const missing = rows.filter(g => g.meta_status === 'not_found' || g.meta_status === 'error').map(withMeta).sort(bySize);
        const partial = rows.filter(g => g.meta_status === 'partial').map(withMeta).sort(bySize);
        const now = Date.now();
        const pending = OFFLINE ? 0 : rows.filter(g => g.meta_status === 'new' || (g.meta_retry_at && g.meta_retry_at <= now)).length;

        // Папки, игры к которым уже нет. Сейвы в таком случае — единственное, что
        // осталось от прохождения, поэтому показываем отдельно и ничего не трогаем.
        const ids = new Set(rows.map(g => g.id));
        const orphanDirs = async (dir, kind) => {
            try {
                const entries = await fsp.readdir(dir, { withFileTypes: true });
                // С точки — служебное, не игра: история сейвов (_saves/.history)
                return entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !ids.has(e.name)).map(e => ({ id: e.name, kind }));
            } catch (e) {
                return [];
            }
        };
        const orphans = [
            ...await orphanDirs(SAVES_DIR, 'saves'),
            ...await orphanDirs(path.join(GAMES_DIR, '_media'), 'media'),
            ...await orphanDirs(OLD_DIR, 'old'),
        ];

        res.json({
            total: rows.length, coverage: coverage(rows),
            broken, duplicates, missing, partial, improvable: improvable(rows), pending, orphans, never, heavy,
        });
    } catch (e) {
        console.error('[Audit] Ошибка:', e.message);
        res.status(500).json({ error: 'Не удалось собрать ревизию' });
    }
});

// Две копии одной игры из ревизии (services/copies.js): что будет при склейке, сама склейка, «Не дубликат»
const copiesRoute = (work) => async (req, res) => {
    try {
        res.json(await work(req));
    } catch (e) {
        if (!e.status) console.error('[Копии]', e.message);
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось склеить: обе копии остались как были', reason: e.reason });
    }
};
router.get('/duplicates/plan', copiesRoute((req) => copies.plan(String(req.query.a || ''), String(req.query.b || ''))));
router.post('/duplicates/merge', copiesRoute(async (req) => {
    const result = await copies.merge(String(req.body?.keep || ''), String(req.body?.drop || ''));
    // В корзине игры нет в библиотеке — и её реплик в поиске
    sceneLines.dropGame(result.drop).catch((e) => console.warn(`[Реплики] ${result.drop}: ${e.message}`));
    return result;
}));
router.post('/duplicates/dismiss', copiesRoute((req) => copies.dismiss(String(req.body?.a || ''), String(req.body?.b || ''))));

// Архив перед отправкой: похоже, это новая версия игры из библиотеки? { match: { id, title, cover, why } | null }
router.post('/upload-match', async (req, res) => {
    try {
        const rows = await dbService.get().all('SELECT * FROM games WHERE ready = 1');
        res.json({ match: await uploadService.versionMatch(rows, req.body) });
    } catch (e) {
        // Не вышло сравнить — не повод мешать загрузке: страница просто не спросит
        console.error('[Upload]', e.message);
        res.json({ match: null });
    }
});

// «Место»: что сколько занимает и что можно убрать (services/space.js). fresh=1 — пересчитать сейчас
router.get('/space', async (req, res) => {
    try {
        res.json(await spaceService.report({ fresh: req.query.fresh === '1' }));
    } catch (e) {
        console.error('[Место]', e.message);
        res.status(500).json({ error: 'Не удалось посчитать место' });
    }
});

// --- ПРЕЖНИЕ ВЕРСИИ: отложенные при обновлении игры (services/uploads.js) — посмотреть, вернуть, удалить ---
// Сколько места освободит удаление: после патча прежняя версия делит с нынешней неизменённые файлы
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

// Сколько сейвов можно положить в архив: окно игры по этому решает, предлагать ли выбор «с сейвами / без»
router.get('/:id/archive-info', async (req, res) => {
    // Путь к сейвам строится из id — только для игры, что есть в базе (id «..» вывел бы из SAVES_DIR)
    if (!await dbService.get().get('SELECT id FROM games WHERE id = ?', [req.params.id])) return res.status(404).json({ error: 'Игра не найдена' });
    res.json({ saves: await gameArchive.savesCount(path.join(SAVES_DIR, req.params.id)).catch(() => 0) });
});

// Скачать игру архивом (перенести на другое устройство). Только читает папку игры. ?saves=1 кладёт в архив
// текущие сейвы Mimikin там, где их читает движок; без него — только то, что лежит в папке игры.
// Размер известен заранее (services/gameArchive.js)
router.get('/:id/archive', async (req, res) => {
    const id = req.params.id;
    const release = gameArchive.acquire();
    if (!release) return res.status(429).json({ error: `Уже собираются ${gameArchive.MAX_ACTIVE} архива — подождите, пока закончится один` });
    try {
        const row = await dbService.get().get('SELECT * FROM games WHERE id = ?', [id]);
        if (!row) { release(); return res.status(404).json({ error: 'Игра не найдена' }); }
        // Папка игры в dev бывает ссылкой на игру прода — саму её разыменовываем (plan делает realpath)
        const dir = path.join(GAMES_DIR, id);
        const st = await fsp.stat(dir).catch(() => null);
        if (!st || !st.isDirectory()) { release(); return res.status(404).json({ error: 'Папка игры не найдена' }); }
        const p = await gameArchive.plan(dir, id, req.query.saves === '1' ? path.join(SAVES_DIR, id) : null);
        const version = installedVersion(row);
        const name = gameArchive.fileName(shownTitle(row).title, version, id);
        res.status(200);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', String(p.total));
        res.setHeader('Content-Disposition', gameArchive.disposition(name));
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'HEAD') { release(); return res.end(); }
        const started = Date.now();
        console.log(`[Архив] ${id}: начало, ${p.files} файлов, ${(p.total / 1048576).toFixed(1)} МБ`);
        // pipeline сам закрывает чтение, если клиент ушёл, и рвёт соединение, если чтение упало
        const stopWatch = gameArchive.watchIdle(res, () => res.destroy(new Error('нет передачи данных, место освобождено')));
        pipeline(gameArchive.stream(p), res, (err) => {
            stopWatch();
            release();
            const sec = ((Date.now() - started) / 1000).toFixed(1);
            if (err) console.log(`[Архив] ${id}: прервано через ${sec} с (${err.code === 'ERR_STREAM_PREMATURE_CLOSE' ? 'клиент ушёл' : err.message})`);
            else console.log(`[Архив] ${id}: готово, ${(p.total / 1048576).toFixed(1)} МБ за ${sec} с`);
        });
    } catch (e) {
        release();
        console.error('[Архив]', id, e.message);
        if (!res.headersSent) res.status(500).json({ error: 'Не удалось собрать архив' });
        else res.destroy();
    }
});

router.get('/:id/old', async (req, res) => {
    const versions = [];
    for (const date of await oldVersionsOf(req.params.id)) {
        let saved = {};
        try { saved = JSON.parse(await fsp.readFile(path.join(OLD_DIR, req.params.id, `${date}.json`), 'utf8')); } catch (e) {}
        // patch — имя архива патча, после которого эта версия ушла в запас
        versions.push({ date, size: await ownSize(path.join(OLD_DIR, req.params.id, date)), patch: saved.patch || '' });
    }
    res.json({ versions });
});

// «Вернуть прежнюю версию»: обновили не тем архивом или новая версия не работает. Те же два
// переименования, что при обновлении: текущая уходит в запас, последняя прежняя — на её место,
// а с ней своя версия и обложка, какими были до обновления
router.post('/:id/old/restore', async (req, res) => {
    const id = req.params.id;
    const dir = path.join(OLD_DIR, id);
    const game = path.join(GAMES_DIR, id);
    try {
        const latest = (await oldVersionsOf(id)).pop();
        if (!latest) return res.status(404).json({ error: 'Прежней версии нет', reason: 'no-old-version' });
        const st = await fsp.lstat(game).catch(() => null);
        if (!st || st.isSymbolicLink() || !st.isDirectory()) return res.status(409).json({ error: 'Эту игру здесь не вернуть', reason: 'game-readonly' });
        let saved = {};
        try { saved = JSON.parse(await fsp.readFile(path.join(dir, `${latest}.json`), 'utf8')); } catch (e) {}
        await fsp.rename(game, path.join(dir, new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')));
        await fsp.rename(path.join(dir, latest), game);
        await fsp.rm(path.join(dir, `${latest}.json`), { force: true });
        await dbService.restoreGame(id, saved);
        console.log(`[Old] ${id}: вернули версию от ${latest}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Old]', e.message);
        res.status(500).json({ error: 'Не удалось вернуть прежнюю версию' });
    }
});

router.delete('/:id/old', async (req, res) => {
    try {
        await fsp.rm(path.join(OLD_DIR, req.params.id), { recursive: true, force: true });
        await invalidateGamesList();
        res.json({ success: true });
    } catch (e) {
        console.error('[Old]', e.message);
        res.status(500).json({ error: 'Не удалось удалить прежнюю версию' });
    }
});

// --- 2. РОУТ ДЛЯ ЗАГРУЗКИ КАСТОМНОЙ ОБЛОЖКИ ---
router.post('/:id/cover', coverUpload.single('cover'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл обложки не получен' });
    const gameId = path.basename(req.params.id);
    try {
        const game = await dbService.get().get('SELECT cover FROM games WHERE id = ?', [gameId]);
        if (!game) {
            await fsp.unlink(req.file.path).catch(()=>{});
            return res.status(404).json({ error: 'Игра не найдена' });
        }
        if (game.cover && game.cover.includes('cover_custom')) {
            const oldCoverPath = path.join(GAMES_DIR, game.cover);
            await fsp.unlink(oldCoverPath).catch(() => {});
        }
        // Своя обложка — в _media, как и найденные поиском: внутрь папки игры мы не пишем.
        // Прежние свои обложки могли остаться в самой папке — их путь в базе, и работают они как раньше
        const ext = path.extname(req.file.originalname) || '.jpg';
        const coverName = `cover_custom_${Date.now()}${ext}`;
        const mediaDir = path.join(GAMES_DIR, '_media', gameId);
        await fsp.mkdir(mediaDir, { recursive: true });
        const finalCoverPath = path.join(mediaDir, coverName);
        const dbCoverPath = `_media/${gameId}/${coverName}`;

        await fsp.rename(req.file.path, finalCoverPath).catch(async (e) => {
            // Загрузка лежит на другом разделе — rename туда не умеет
            if (e.code !== 'EXDEV') throw e;
            await fsp.copyFile(req.file.path, finalCoverPath);
            await fsp.unlink(req.file.path).catch(() => {});
        });
        await dbService.get().run('UPDATE games SET cover = ? WHERE id = ?', [dbCoverPath, gameId]);
        
        // [REDIS] Сбрасываем кэш, так как обложка изменилась
        await invalidateGamesList();
        
        res.json({ success: true, coverPath: dbCoverPath });
    } catch (e) {
        await fsp.unlink(req.file.path).catch(()=>{});
        res.status(500).json({ error: 'Ошибка при смене обложки' });
    }
});

// --- 3. СБРОС СВОЕЙ ОБЛОЖКИ: ВОЗВРАТ К НАЙДЕННОЙ ---
// Найденная поиском обложка из _media (самая свежая; поиск пишет .jpg, демо-библиотека — .png), а если
// её нет — та, что лежит в самой игре. Раньше смотрели только в папку игры, и после сброса своей
// обложки игра оставалась без картинки до следующего поиска. '' — вернуть нечего
async function foundCover(gameId) {
    const mediaDir = path.join(GAMES_DIR, '_media', gameId);
    const found = [];
    for (const f of await fsp.readdir(mediaDir).catch(() => [])) {
        if (!/^cover(?:-[0-9a-f]{10})?\.(?:jpe?g|png|webp)$/i.test(f)) continue;
        const stat = await fsp.stat(path.join(mediaDir, f)).catch(() => null);
        if (stat) found.push({ f, at: stat.mtimeMs });
    }
    if (found.length) return `_media/${gameId}/${found.sort((a, b) => b.at - a.at)[0].f}`;
    try {
        await fsp.access(path.join(GAMES_DIR, gameId, 'cover.jpg'));
        return `${gameId}/cover.jpg`;
    } catch (e) {
        return '';
    }
}

// Какая обложка вернётся — правка показывает её до «Сохранить», ничего не меняя
router.get('/:id/cover/found', async (req, res) => {
    const gameId = path.basename(req.params.id);
    try {
        const game = await dbService.get().get('SELECT id FROM games WHERE id = ?', [gameId]);
        if (!game) return res.status(404).json({ error: 'Игра не найдена' });
        res.json({ coverPath: await foundCover(gameId) });
    } catch (e) {
        res.status(500).json({ error: 'Не удалось найти обложку' });
    }
});

router.delete('/:id/cover', async (req, res) => {
    const gameId = path.basename(req.params.id);
    try {
        const game = await dbService.get().get('SELECT cover FROM games WHERE id = ?', [gameId]);
        if (!game) return res.status(404).json({ error: 'Игра не найдена' });

        if (game.cover && game.cover.includes('cover_custom')) {
            const oldCoverPath = path.join(GAMES_DIR, game.cover);
            await fsp.unlink(oldCoverPath).catch(() => {});
        }
        const newDbCover = await foundCover(gameId);
        await dbService.get().run('UPDATE games SET cover = ? WHERE id = ?', [newDbCover, gameId]);
        
        // [REDIS] Сбрасываем кэш
        await invalidateGamesList();
        
        res.json({ success: true, coverPath: newDbCover });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка при сбросе обложки' });
    }
});

// --- 4. РЕДАКТИРОВАНИЕ МЕТАДАННЫХ ---
router.post('/:id/edit', async (req, res) => {
    const folder = path.basename(req.params.id);
    const { title, developer, language, releaseDate, link, myVersion } = req.body;

    try {
        const current = await dbService.get().get('SELECT * FROM games WHERE id = ?', [folder]);
        if (!current) return res.status(404).json({ error: 'Игра не найдена' });

        // Версия у себя — когда в названии папки её нет. Поиск не нужен
        if (myVersion !== undefined && String(myVersion).trim() !== (current.my_version || '')) {
            await dbService.get().run('UPDATE games SET my_version = ? WHERE id = ?', [String(myVersion).trim().slice(0, 40), folder]);
        }

        // Что человек действительно поменял. Форма присылает все поля разом, и если
        // считать ручным всё присланное, автопоиск навсегда перестал бы обновлять
        // поля, которые просто стояли в форме с прошлого раза.
        const sent = { developer, language, releaseDate, link };
        const manual = {};
        for (const [key, value] of Object.entries(sent)) {
            if (value !== undefined && String(value) !== String(current[key] || '')) manual[key] = value;
        }
        // Название тоже запоминаем как ручное: его показываем как есть, без чистки
        if (title !== undefined && title !== current.title) manual.title = title;

        // Поменянное пишем сразу: оно главнее всего, что найдётся, и должно остаться,
        // даже если поиск ничего не даст
        const direct = { ...manual };
        // Ссылки, которые человек убрал, запоминаем: поиск находил бы их по названию снова и снова
        // (Steam, VNDB), и убрать чужую игру из карточки было бы нельзя
        const removed = manual.link === undefined
            ? parseRemoved(current.links_removed)
            : removedAfterEdit(current.link, manual.link, parseRemoved(current.links_removed));
        if (manual.link !== undefined) direct.links_removed = JSON.stringify(removed);
        // Убрали ссылку — данные игры соберутся заново, только с оставшихся страниц (applyLookup)
        const before = new Set(splitLinks(current.link).map(linkKey));
        const after = new Set(splitLinks(manual.link).map(linkKey));
        const linksAdded = manual.link !== undefined && [...after].some((k) => !before.has(k));
        if (manual.link !== undefined && [...before].some((k) => !after.has(k))) direct.meta_rebuild = 1;
        const directKeys = Object.keys(direct);
        if (directKeys.length) {
            await dbService.get().run(
                `UPDATE games SET ${directKeys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
                [...directKeys.map(k => direct[k]), folder]
            );
        }

        const searchFrom = title || current.title || folder;
        // Ссылки, которые человек сейчас не трогал, ищем как при обычном повторном поиске:
        // найденные автопоиском по названию (Steam, VNDB) — заново и со сверкой. Иначе
        // «Сохранить» возвращало бы в карточку однажды принятую чужую игру
        let locked = [];
        try { locked = JSON.parse(current.meta_locked || '[]') || []; } catch (e) {}
        const linksForSearch = scraperService.searchableLinks(link, manual.link !== undefined || locked.includes('link')).join(',');
        const rawQuery = linksForSearch;

        // Шаги — вживую в окно игры, как у фонового поиска. «Начали» — только когда всё для поиска готово:
        // иначе сбой до него оставил бы окно в «ищется» навсегда
        const io = scraperService.io;
        const altTitle = scraperService.titleFromFolder(folder);
        const readmeTitle = await scraperService.readmeTitle(path.join(GAMES_DIR, folder));
        io?.emit('lookup-start', { id: folder, title: searchFrom });
        const lookup = await scraperService.lookupMetadata(searchFrom, rawQuery, {
            altTitle, readmeTitle, removed,
            onStep: (step, n) => io?.emit('lookup-step', { id: folder, step, n }),
        }).finally(() => io?.emit('lookup-done', { id: folder }));

        // Раньше при неудаче здесь выполнялось tags = '[]', description = '' — опечатка
        // в ссылке стирала хорошие теги и описание. Теперь неудача ничего не трогает.
        // Вписали новую ссылку — найденное заменяет прежнее, даже если какой-то сайт молчал:
        // прежнее могло быть про другую игру
        const result = await scraperService.applyLookup(folder, lookup, { manual, replace: linksAdded });

        // Текст сообщения собирает интерфейс на языке пользователя: отсюда — только факты
        const g = result.row;
        res.json({
            success: true,
            found: result.found,
            failed: result.failed,
            game: {
                title: g.title,
                ...titleFields(g),
                cover: g.cover,
                developer: g.developer || '',
                language: g.language || '',
                releaseDate: g.releaseDate || '',
                link: g.link || '',
                tags: normalizeTags(g.tags ? JSON.parse(g.tags) : []),
                description: g.description || '',
                screens: parseProgress(g.screens) || [],
                meta: shownMeta({
                    status: g.meta_status,
                    attempts: g.meta_attempts || 0,
                    retryAt: g.meta_retry_at || null,
                    checkedAt: g.meta_checked_at || 0,
                    error: g.meta_error || '',
                }),
            }
        });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Сбой сервера при обновлении' }); 
    }
});

// --- ПЕРЕВОД ИГРЫ (services/translate.js) ---
// Сколько знаков каждая служба перевела в этом месяце и не кончился ли её лимит — для «Настроек»
router.get('/translation/usage', async (req, res) => {
    try { res.json(await translateService.usageReport()); } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
// Словарь терминов: стандартные слова и как их перевели игры библиотеки (services/termlib.js)
router.get('/translation/terms', async (req, res) => {
    try { res.json(await translateService.termsReport()); } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
// Состояние: включённый язык, ход перевода, какие службы есть
router.get('/:id/translation', async (req, res) => {
    try { res.json(await translateService.status(path.basename(req.params.id))); } catch (e) { res.status(500).json({ error: 'Не удалось прочитать перевод' }); }
});
// Включить на язык (и перевести, чего ещё нет) или выключить: { lang: 'en' | 'ru' | 'de' | '' }
router.post('/:id/translation', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (!(await dbService.get().get('SELECT id FROM games WHERE id = ?', [id]))) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.setLang(id, String(req.body?.lang || '')));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось включить перевод', reason: e.reason });
    }
});
router.post('/:id/translation/pause', async (req, res) => {
    const id = path.basename(req.params.id);
    try { await translateService.pause(id); res.json(await translateService.status(id)); } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
router.post('/:id/translation/resume', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        const lang = await translateService.langOf(id);
        if (!lang) return res.status(409).json({ error: 'Перевод не включён', reason: 'tl-off' });
        translateService.enqueue(id, lang);
        res.json(await translateService.status(id));
    } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
// Перед включением: сколько строк и знаков уйдёт в службу и сколько её лимита останется
const noGame = async (id) => !(await dbService.get().get('SELECT id FROM games WHERE id = ?', [id]));
router.get('/:id/translation/estimate', async (req, res) => {
    try {
        if (await noGame(path.basename(req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.estimate(path.basename(req.params.id), String(req.query.lang || ''))); } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось', reason: e.reason });
    }
});
// Проверка перевода: слипшиеся слова и текст, который не влезет в окно; «Исправить» — то, что исправляется само
// Сколько уйдёт службе на «перевести заново»: { lines? } — выбранные строки, без них — вся игра
router.post('/:id/translation/estimate-redo', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        const lang = await translateService.langOf(id);
        if (!lang) return res.status(409).json({ error: 'Перевод не включён', reason: 'tl-off' });
        const lines = Array.isArray(req.body?.lines) ? req.body.lines.map(String).slice(0, 20000) : null;
        if (lines && !lines.length) return res.status(400).json({ error: 'Нужен список строк' });
        res.json(await translateService.estimate(id, lang, lines || 'all'));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось', reason: e.reason });
    }
});
// «Перевести заново»: { lines? }
router.post('/:id/translation/redo', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        const lines = Array.isArray(req.body?.lines) ? req.body.lines.map(String).slice(0, 20000) : null;
        if (lines && !lines.length) return res.status(400).json({ error: 'Нужен список строк' });
        res.json(await translateService.redo(id, lines));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось', reason: e.reason });
    }
});
// Строки перевода с поиском: ?q=Мэйбел
router.get('/:id/translation/lines', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.lines(id, String(req.query.q || '').slice(0, 200)));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось', reason: e.reason });
    }
});
// Итог проверки переведённой игры в браузере: { ok, steps, errors } (rpg-fixes, setupSelfTest)
router.post('/:id/translation/check-result', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.saveCheck(id, req.body || {}));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось', reason: e.reason });
    }
});
// Перевод игры файлом (JSON «оригинал → перевод», как у MTool): скачать
router.get('/:id/translation/export', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        const { lang, data } = await translateService.exportFile(id, String(req.query.lang || ''));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${id}.${lang}.json`)}`);
        res.send(JSON.stringify(data, null, 2));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось', reason: e.reason });
    }
});
router.get('/:id/translation/check', async (req, res) => {
    try {
        if (await noGame(path.basename(req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.check(path.basename(req.params.id))); } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось проверить перевод', reason: e.reason });
    }
});
router.post('/:id/translation/fix', async (req, res) => {
    try {
        if (await noGame(path.basename(req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.fix(path.basename(req.params.id))); } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось исправить', reason: e.reason });
    }
});
// Готовый перевод из файла (MTool, свой): { lang, content } — JSON «оригинал → перевод» или CSV
router.post('/:id/translation/import', express.json({ limit: '50mb' }), async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (!(await dbService.get().get('SELECT id FROM games WHERE id = ?', [id]))) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.importFile(id, String(req.body?.lang || ''), String(req.body?.content || '')));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось загрузить перевод', reason: e.reason });
    }
});

// --- ТЕКСТ НА КАРТИНКАХ (services/pictures.js, служба ocr/) ---
// Заплатка, стирающая подпись (PNG по хэшу содержимого — не меняется никогда)
router.get('/pictures/patch/:hash', async (req, res) => {
    try {
        const png = await pictureService.patch(req.params.hash);
        if (!png) return res.status(404).end();
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.type('png').send(png);
    } catch (e) { res.status(500).end(); }
});
// Состояние: есть ли служба, ход разбора, сколько подписей найдено и ждёт проверки, сколько картинок разобрать
router.get('/:id/pictures', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await pictureService.status(id));
    } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
// Начать: { scope: 'ui' — картинки интерфейса | 'all' — и картинки сцен }
router.post('/:id/pictures', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        if (!(await pictureService.available({ fresh: true }))) return res.status(503).json({ error: 'Служба распознавания не отвечает', reason: 'ocr-down' });
        pictureService.start(id, req.body?.scope === 'all' ? 'all' : 'ui');
        res.json(await pictureService.status(id));
    } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
router.post('/:id/pictures/pause', async (req, res) => {
    const id = path.basename(req.params.id);
    try { await pictureService.pause(id); res.json(await pictureService.status(id)); } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
// Экран «Картинки»: картинки с подписями, у каждой — текст, перевод, включена ли, ждёт ли проверки
router.get('/:id/pictures/review', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        res.json({ items: await pictureService.review(id) });
    } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
// Сама картинка (расшифрованная) — для «до/после»
router.get('/:id/pictures/image', async (req, res) => {
    try {
        const png = await pictureService.image(path.basename(req.params.id), String(req.query.key || ''));
        if (!png) return res.status(404).end();
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.type('png').send(png);
    } catch (e) { res.status(500).end(); }
});
// Правка подписи: { sha1, label, on?, text?, translation? } — включить/выключить, поправить текст, свой перевод
router.post('/:id/pictures/label', async (req, res) => {
    const id = path.basename(req.params.id);
    const b = req.body || {};
    try {
        const label = await pictureService.setLabel(id, String(b.sha1 || ''), b.label, {
            on: typeof b.on === 'boolean' ? b.on : undefined,
            text: typeof b.text === 'string' ? b.text : undefined,
        });
        if (!label) return res.status(404).json({ error: 'Подпись не найдена' });
        const lang = await translateService.langOf(id);
        if (lang && typeof b.translation === 'string' && b.translation.trim()) {
            await translateService.setOwn(label.text, lang, b.translation.trim().slice(0, 500));
        } else if (lang && b.text !== undefined) {
            // Поправили распознанный текст — у нового текста ещё нет перевода
            translateService.enqueue(id, lang);
        }
        res.json({ label });
    } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});
// Подпись, которую поиск пропустил: { key, box: [x, y, w, h] } — служба читает её в этой рамке
router.post('/:id/pictures/box', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        const label = await pictureService.addBox(id, String(req.body?.key || ''), req.body?.box);
        if (!label) return res.status(422).json({ error: 'В рамке текст не найден' });
        res.json({ label });
    } catch (e) {
        if (e instanceof pictureService.OcrDown) return res.status(503).json({ error: 'Служба распознавания не отвечает', reason: 'ocr-down' });
        res.status(500).json({ error: 'Не удалось' });
    }
});
router.post('/:id/pictures/remove', async (req, res) => {
    try {
        const ok = await pictureService.removeLabel(path.basename(req.params.id), String(req.body?.sha1 || ''), req.body?.label);
        if (!ok) return res.status(404).json({ error: 'Подпись не найдена' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Не удалось' }); }
});

// «Как искали»: журнал последнего поиска данных игры — что спросили у каждого сайта, что он ответил,
// что было похоже, но не подошло (services/scraper.js, lookupMetadata). Похожее — без ссылок, которые
// у игры уже есть или которые убрали руками
router.get('/:id/lookup', async (req, res) => {
    try {
        const row = await dbService.get().get('SELECT link, links_removed, meta_log FROM games WHERE id = ?', [path.basename(req.params.id)]);
        if (!row) return res.status(404).json({ error: 'Игра не найдена' });
        let journal = null;
        try { journal = JSON.parse(row.meta_log || 'null'); } catch (e) {}
        if (!journal) return res.json({ journal: null });
        const skip = new Set([...splitLinks(row.link).map(linkKey), ...parseRemoved(row.links_removed)]);
        res.json({ journal: { ...journal, near: (journal.near || []).filter((x) => !skip.has(linkKey(x.link))) } });
    } catch (e) {
        res.status(500).json({ error: 'Не удалось прочитать журнал' });
    }
});

// --- 5. СОХРАНЕНИЕ РЕЙТИНГА И ВРЕМЕНИ ИГРЫ ---
router.post('/:id/meta', async (req, res) => {
    const folder = path.basename(req.params.id);
    const { rating, lastPlayed, status, favorite, notes, lists } = req.body;

    try {
        const game = await dbService.get().get('SELECT id FROM games WHERE id = ?', [folder]);
        if (!game) return res.status(404).json({ error: 'Игра не найдена' });

        // Что менять — по порядку, как всегда; саму запись делает personal.write (владельцу тот же UPDATE games, человеку — его строка)
        const fields = {};
        if (rating !== undefined) fields.rating = rating;
        if (lastPlayed !== undefined) fields.lastPlayed = lastPlayed;

        // Статус приходит из браузера — принимаем только известные значения.
        // Иначе в базе окажется любой текст, который пришлёт клиент.
        const STATUSES = ['', 'playing', 'done', 'dropped', 'wish'];
        if (status !== undefined) {
            if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Неизвестный статус' });
            fields.status = status;
        }
        if (favorite !== undefined) fields.favorite = favorite ? 1 : 0;
        if (notes !== undefined) {
            if (typeof notes !== 'string' || notes.length > NOTES_MAX) return res.status(400).json({ error: 'Слишком длинная заметка' });
            fields.notes = notes;
        }
        if (lists !== undefined) {
            const clean = cleanLists(lists);
            if (!clean) return res.status(400).json({ error: 'Неверные подборки' });
            fields.lists = JSON.stringify(clean);
        }

        if (Object.keys(fields).length > 0) {
            const mine = await personal.write(req.person, folder, fields);
            // [REDIS] Сбрасываем кэш, так как рейтинг или время игры обновились. Запись человека общий список не меняет:
            // сообщаем только его устройствам
            if (mine) emitToPerson(req.person.id, 'library-changed');
            else await invalidateGamesList();
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка сохранения метаданных' }); }
});

// Поправка серии владельцем: кнопки в окне игры. В USER_ROUTES этого адреса нет: человеку 403
router.post('/:id/series', async (req, res) => {
    const id = path.basename(req.params.id);
    const series = typeof req.body?.series === 'string' ? req.body.series.trim() : null;
    // eslint-disable-next-line no-control-regex
    // Без единой буквы и цифры ключ серии пуст (gameSeries.js), и разные такие серии склеились бы в одну
    if (series === null || series.length > SERIES_MAX || /[\u0000-\u001f\u007f]/.test(series) || (series && !/[\p{L}\p{N}]/u.test(series))) return res.status(400).json({ error: 'Неверное имя серии' });
    try {
        const done = await dbService.get().run('UPDATE games SET series = ? WHERE id = ?', [series, id]);
        if (!done.changes) return res.status(404).json({ error: 'Игра не найдена' });
        await invalidateGamesList();
        res.json({ success: true, series });
    } catch (e) {
        console.error('[Серия]', e.message);
        res.status(500).json({ error: 'Ошибка сохранения серии' });
    }
});

// --- «НА ПОЛКУ» ---
// Файлы — в корзину на 30 дней (services/trash.js, shelveGame), карточка, сейвы, моменты и наигранное время остаются в
// библиотеке. Ответ несёт key — тост «Отменить» и «Вернуть» в окне игры кладут файлы обратно. Обложка из самой папки
// игры — сначала копией в _media: иначе карточка на полке осталась бы без картинки
router.post('/:id/shelf', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        const game = await dbService.get().get('SELECT id, cover FROM games WHERE id = ?', [id]);
        if (!game || !(await fsp.lstat(path.join(GAMES_DIR, id)).catch(() => null))) return res.status(404).json({ error: 'Игра не найдена' });
        if (game.cover && game.cover.startsWith(`${id}/`)) {
            const buf = await fsp.readFile(path.join(GAMES_DIR, game.cover)).catch(() => null);
            if (buf) {
                // Имя — по содержимому, как у найденных поиском (database.js, addGameToDB)
                const name = `cover-${crypto.createHash('md5').update(buf).digest('hex').slice(0, 10)}${path.extname(game.cover).toLowerCase() || '.jpg'}`;
                await fsp.mkdir(path.join(GAMES_DIR, '_media', id), { recursive: true });
                await fsp.writeFile(path.join(GAMES_DIR, '_media', id, name), buf);
                await dbService.get().run('UPDATE games SET cover = ? WHERE id = ?', [`_media/${id}/${name}`, id]);
            } else console.warn(`[Полка] ${id}: обложку из папки игры не прочитать (${game.cover}) — на полке карточка будет без неё`);
        }
        const { key } = await trash.shelveGame(id);
        // Сцен этой игры без её файлов не открыть — и в поиске по репликам их нет
        sceneLines.dropGame(id).catch((e) => console.warn(`[Реплики] ${id}: ${e.message}`));
        res.json({ success: true, trashKey: key });
    } catch (e) {
        console.error('[Полка]', e.message);
        res.status(500).json({ error: 'Не удалось убрать игру на полку' });
    }
});

// «Похоже, это … с полки» в окне игры, загруженной как новая (utils/audit.js, shelfMatches). accept — её папка встаёт на
// место игры с полки: та же карточка, её сейвы, моменты, время и найденные данные, а строка новой уходит (своего у неё
// ещё нет — иначе не спрашиваем). Прежние файлы с полки, если ещё в корзине, — в _old, как при обновлении. Иначе
// «нет, это другая» — больше не спрашивать про эту игру с полки
router.post('/:id/shelf-match', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        const db = dbService.get();
        const game = await db.get('SELECT * FROM games WHERE id = ?', [id]);
        const shelf = await db.get('SELECT * FROM games WHERE id = ?', [String(req.body?.into || '')]);
        if (!game || game.shelved_at || !shelf?.shelved_at) return res.status(404).json({ error: 'Игра не найдена' });
        // «Нет» — про эту игру с полки; ответы копятся: у одной игры бывает несколько копий на полке
        if (!req.body?.accept) {
            const no = String(game.shelf_dismissed || '').split('\n').filter(Boolean);
            await db.run('UPDATE games SET shelf_dismissed = ? WHERE id = ?', [[...new Set([...no, shelf.id])].join('\n'), id]);
            await invalidateGamesList();
            return res.json({ success: true });
        }
        const from = path.join(GAMES_DIR, id);
        const to = path.join(GAMES_DIR, shelf.id);
        if (!(await fsp.lstat(from).catch(() => null))) return res.status(404).json({ error: 'Игра не найдена' });
        if (await hasPlayData(id)) return res.status(409).json({ error: 'У этой игры уже свои сейвы или моменты — перенос смешал бы два прохождения', reason: 'shelf-has-data' });
        if (await fsp.lstat(to).catch(() => null)) return res.status(409).json({ error: 'Игра с полки уже на месте', reason: 'shelf-in-place' });
        // Сначала папка: не переехала — ничего не поменялось. Прежние файлы с полки — после, в _old
        await fsp.rename(from, to);
        const backupDir = path.join(OLD_DIR, shelf.id, new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
        const old = await trash.shelfToOld(shelf.id, backupDir).catch((e) => { console.warn(`[Полка] ${shelf.id}: прежние файлы остались в корзине (${e.message})`); return false; });
        // Что человек успел отметить у новой сам — статус, оценку, избранное, картинки галереи — не теряется: туда, где у
        // игры с полки пусто. Найденное поиском у той своё; время — вместе
        await db.run(`UPDATE games SET playtime = COALESCE(playtime, 0) + ?, lastPlayed = MAX(COALESCE(lastPlayed, 0), ?),
            status = CASE WHEN COALESCE(status, '') = '' THEN ? ELSE status END,
            rating = CASE WHEN COALESCE(rating, 0) = 0 THEN ? ELSE rating END,
            favorite = MAX(COALESCE(favorite, 0), ?),
            notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes END,
            lists = CASE WHEN COALESCE(lists, '[]') = '[]' THEN ? ELSE lists END,
            series = CASE WHEN series = '' THEN ? ELSE series END WHERE id = ?`,
        [game.playtime || 0, game.lastPlayed || 0, game.status || '', game.rating || 0, game.favorite || 0, game.notes || '', game.lists || '[]', game.series === 'none' ? '' : game.series || '', shelf.id]);
        await db.run('UPDATE OR IGNORE gallery_favorites SET game_id = ? WHERE game_id = ?', [shelf.id, id]);
        // Другие люди: их сейвы и личные строки тоже встают на место игры с полки, где у них там пусто; где нет — остаются
        // на месте. Вопрос о переносе их сейвы не блокируют (hasPlayData смотрит только владельца), а сбой здесь владельцу
        // не помеха: файлы уже переехали
        await copies.movePeople(id, shelf.id).catch((e) => console.warn(`[Полка] ${id}: сейвы других людей не перенеслись (${e.message})`));
        await db.run('DELETE FROM games WHERE id = ?', [id]);
        // Версия — из имени папки новой (это имя её архива) или своя у неё; название и прочее из файлов — как у новой версии
        await dbService.refreshGame(shelf.id, to, { archiveName: id, version: game.my_version || '', backupDir: old ? backupDir : '' });
        galleryService.forget(id).catch(() => {});
        sceneLines.dropGame(id).catch((e) => console.warn(`[Реплики] ${id}: ${e.message}`));
        console.log(`[Полка] ${id}: это ${shelf.id} с полки — файлы встали на её место`);
        res.json({ success: true, id: shelf.id });
    } catch (e) {
        console.error('[Полка]', e.message);
        res.status(500).json({ error: 'Не удалось' });
    }
});

// --- 6. УДАЛЕНИЕ ИГРЫ ---
// Не стираем, а в корзину на 30 дней: ответ несёт key — по нему тост «Отменить» вернёт игру.
// Игра с полки — без папки: в корзину уходит карточка (и её файлы, если они ещё там)
router.delete('/:id', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        // Удаляем только то, что есть в библиотеке (не _saves, не library.db и т.п.)
        const game = await dbService.get().get('SELECT id, shelved_at FROM games WHERE id = ?', [id]);
        if (!game || (!game.shelved_at && !(await fsp.lstat(path.join(GAMES_DIR, id)).catch(() => null)))) return res.status(404).json({ error: 'Игра не найдена' });
        const { key } = await trash.trashGame(id);
        // В корзине игры нет в библиотеке — и её реплик в поиске
        sceneLines.dropGame(id).catch((e) => console.warn(`[Реплики] ${id}: ${e.message}`));
        res.json({ success: true, trashKey: key });
    } catch (e) {
        console.error('[Корзина]', e.message);
        res.status(500).json({ error: 'Не удалось удалить игру' });
    }
});

module.exports = router;
module.exports.trash = trash;
