const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const dbService = require('../db/database.js');
const scraperService = require('../services/scraper.js');
const { GAMES_DIR, SAVES_DIR, OLD_DIR, TRASH_DIR } = require('../config/index.js');
const { coverUpload } = require('../utils/upload.js');
const { getFolderSize } = require('../utils/archive.js');
const { validateIdParam } = require('../utils/validate.js');
const { redisClient, invalidateGamesList, GAMES_LIST_KEY } = require('../utils/cache.js');
const { normalizeTags } = require('../utils/tags.js');
const { shownTitle } = require('../utils/title.js');
const { installedVersion } = require('../utils/version.js');
const { splitLinks, linkKey, removedAfterEdit, parseRemoved } = require('../utils/links.js');
const { duplicateGroups, improvable, coverage } = require('../utils/audit.js');
const { createTrash } = require('../services/trash.js');
const gameArchive = require('../services/gameArchive.js');
const { pipeline } = require('stream');
const spaceService = require('../services/space.js');
const translateService = require('../services/translate.js');
const pictureService = require('../services/pictures.js');

const router = express.Router();

// Все роуты с :id — только безопасное имя папки (без "." / ".." / слэшей)
router.param('id', validateIdParam);

let isCalculatingSizes = false; // Глобальный замок

const trash = createTrash({ db: () => dbService.get(), trashDir: TRASH_DIR, gamesDir: GAMES_DIR, onChange: invalidateGamesList });

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
        res.json({ success: true, ...(await trash.restore(req.params.key)) });
    } catch (e) {
        if (!e.status) console.error('[Корзина]', e.message);
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось вернуть игру' });
    }
});

router.delete('/trash/:key', async (req, res) => {
    try {
        await trash.remove(req.params.key);
        res.json({ success: true });
    } catch (e) {
        if (!e.status) console.error('[Корзина]', e.message);
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось стереть' });
    }
});

// Прежние версии игры в _old/<игра>: папки по дате, старые первыми (рядом — их .json)
const oldVersionsOf = async (id) => (await fsp.readdir(path.join(OLD_DIR, id), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

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
            return res.json(JSON.parse(cachedGames));
        }

        const rows = await dbService.get().all('SELECT * FROM games WHERE ready = 1');

        // =========================================================
        // БЕЗОПАСНОЕ ФОНОВОЕ ВЗВЕШИВАНИЕ (С ЗАЩИТОЙ ОТ ГОНКИ)
        // =========================================================
        const gamesWithoutSize = rows.filter(r => !r.size || r.size === 0);
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
            scraped: !!row.scraped,
            tags: normalizeTags(row.tags ? JSON.parse(row.tags) : []),
            description: row.description, 
            url: `/${row.id}/`, 
            number: 0,
            addedAt: row.addedAt, 
            lastPlayed: row.lastPlayed, 
            rating: row.rating,
            status: row.status || '',
            favorite: !!row.favorite,
            playtime: row.playtime || 0,
            progress: parseProgress(row.progress),
            screens: parseProgress(row.screens) || [],
            oldVersions: oldVersions[row.id] || 0,
            // Язык по тексту самой игры: { main, langs, original }. language выше —
            // только ручная правка, она главнее
            textLang: parseProgress(row.text_lang),
            // Состояние поиска метаданных — для строчки в окне игры и для ревизии
            meta: {
                status: row.meta_status || 'new',
                attempts: row.meta_attempts || 0,
                retryAt: row.meta_retry_at || null,
                checkedAt: row.meta_checked_at || 0,
                error: row.meta_error || '',
            },
        })).sort((a, b) => b.addedAt - a.addedAt); 
        games.forEach((g, i) => g.number = i + 1);

        // [REDIS] 2. Сохраняем собранный список в кэш на 5 минут (300 секунд)
        await redisClient.set(GAMES_LIST_KEY, JSON.stringify(games), { EX: 300 });

        res.json(games);
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
        const broken = [];
        for (const g of rows) {
            const dir = path.join(GAMES_DIR, g.id);
            const ok = await exists(path.join(dir, 'index.html'))
                || await exists(path.join(dir, 'www', 'index.html'));
            if (!ok) broken.push({ id: g.id, title: g.title, size: g.size || 0 });
        }

        // Одна игра в двух папках: одно название или одна страница магазина (utils/audit.js)
        const duplicates = duplicateGroups(rows);

        const slim = (g) => ({ id: g.id, title: g.title, size: g.size || 0 });
        const bySize = (a, b) => b.size - a.size;

        const never = rows.filter(g => !g.lastPlayed && !g.playtime).map(slim).sort(bySize);
        const heavy = rows.map(slim).sort(bySize).slice(0, 10);

        // Поиск метаданных: берём готовое состояние, а не угадываем по пустым полям.
        // Раньше ревизия и кнопка «Дозагрузить» считали «без метаданных» по-разному.
        const withMeta = (g) => ({ ...slim(g), status: g.meta_status, retryAt: g.meta_retry_at || null, error: g.meta_error || '' });
        const missing = rows.filter(g => g.meta_status === 'not_found' || g.meta_status === 'error').map(withMeta).sort(bySize);
        const partial = rows.filter(g => g.meta_status === 'partial').map(withMeta).sort(bySize);
        const now = Date.now();
        const pending = rows.filter(g => g.meta_status === 'new' || (g.meta_retry_at && g.meta_retry_at <= now)).length;

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
        if (!latest) return res.status(404).json({ error: 'Прежней версии нет' });
        const st = await fsp.lstat(game).catch(() => null);
        if (!st || st.isSymbolicLink() || !st.isDirectory()) return res.status(409).json({ error: 'Эту игру здесь не вернуть' });
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
                meta: {
                    status: g.meta_status,
                    attempts: g.meta_attempts || 0,
                    retryAt: g.meta_retry_at || null,
                    checkedAt: g.meta_checked_at || 0,
                    error: g.meta_error || '',
                },
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
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось включить перевод' });
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
        if (!lang) return res.status(409).json({ error: 'Перевод не включён' });
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
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось' });
    }
});
// Проверка перевода: слипшиеся слова и текст, который не влезет в окно; «Исправить» — то, что исправляется само
// Сколько уйдёт службе на «перевести заново»: { lines? } — выбранные строки, без них — вся игра
router.post('/:id/translation/estimate-redo', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        const lang = await translateService.langOf(id);
        if (!lang) return res.status(409).json({ error: 'Перевод не включён' });
        const lines = Array.isArray(req.body?.lines) ? req.body.lines.map(String).slice(0, 20000) : null;
        if (lines && !lines.length) return res.status(400).json({ error: 'Нужен список строк' });
        res.json(await translateService.estimate(id, lang, lines || 'all'));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось' });
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
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось' });
    }
});
// Строки перевода с поиском: ?q=Мэйбел
router.get('/:id/translation/lines', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.lines(id, String(req.query.q || '').slice(0, 200)));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось' });
    }
});
// Итог проверки переведённой игры в браузере: { ok, steps, errors } (rpg-fixes, setupSelfTest)
router.post('/:id/translation/check-result', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (await noGame(id)) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.saveCheck(id, req.body || {}));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось' });
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
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось' });
    }
});
router.get('/:id/translation/check', async (req, res) => {
    try {
        if (await noGame(path.basename(req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.check(path.basename(req.params.id))); } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось проверить перевод' });
    }
});
router.post('/:id/translation/fix', async (req, res) => {
    try {
        if (await noGame(path.basename(req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.fix(path.basename(req.params.id))); } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось исправить' });
    }
});
// Готовый перевод из файла (MTool, свой): { lang, content } — JSON «оригинал → перевод» или CSV
router.post('/:id/translation/import', express.json({ limit: '50mb' }), async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        if (!(await dbService.get().get('SELECT id FROM games WHERE id = ?', [id]))) return res.status(404).json({ error: 'Игра не найдена' });
        res.json(await translateService.importFile(id, String(req.body?.lang || ''), String(req.body?.content || '')));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось загрузить перевод' });
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
        if (!(await pictureService.available({ fresh: true }))) return res.status(503).json({ error: 'Служба распознавания не отвечает' });
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
        if (e instanceof pictureService.OcrDown) return res.status(503).json({ error: 'Служба распознавания не отвечает' });
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
    const { rating, lastPlayed, status, favorite } = req.body;

    try {
        const game = await dbService.get().get('SELECT id FROM games WHERE id = ?', [folder]);
        if (!game) return res.status(404).json({ error: 'Игра не найдена' });

        const updates = [], params = [];
        if (rating !== undefined) { updates.push('rating = ?'); params.push(rating); }
        if (lastPlayed !== undefined) { updates.push('lastPlayed = ?'); params.push(lastPlayed); }

        // Статус приходит из браузера — принимаем только известные значения.
        // Иначе в базе окажется любой текст, который пришлёт клиент.
        const STATUSES = ['', 'playing', 'done', 'dropped', 'wish'];
        if (status !== undefined) {
            if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Неизвестный статус' });
            updates.push('status = ?'); params.push(status);
        }
        if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }

        if (updates.length > 0) {
            params.push(folder);
            await dbService.get().run(`UPDATE games SET ${updates.join(', ')} WHERE id = ?`, params);
            
            // [REDIS] Сбрасываем кэш, так как рейтинг или время игры обновились
            await invalidateGamesList();
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка сохранения метаданных' }); }
});

// --- 6. УДАЛЕНИЕ ИГРЫ ---
// Не стираем, а в корзину на 30 дней: ответ несёт key — по нему тост «Отменить» вернёт игру
router.delete('/:id', async (req, res) => {
    const id = path.basename(req.params.id);
    try {
        // Удаляем только то, что есть в библиотеке (не _saves, не library.db и т.п.)
        const game = await dbService.get().get('SELECT id FROM games WHERE id = ?', [id]);
        if (!game || !(await fsp.lstat(path.join(GAMES_DIR, id)).catch(() => null))) return res.status(404).json({ error: 'Игра не найдена' });
        const { key } = await trash.trashGame(id);
        res.json({ success: true, trashKey: key });
    } catch (e) {
        console.error('[Корзина]', e.message);
        res.status(500).json({ error: 'Не удалось удалить игру' });
    }
});

module.exports = router;
module.exports.trash = trash;
