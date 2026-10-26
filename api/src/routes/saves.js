const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const { SAVES_DIR, GAMES_DIR } = require('../config/index.js');
const { spawnExtract } = require('../utils/archive.js');
const { upload, uploadLimiter } = require('../utils/upload.js');
const { isSafeSegment } = require('../utils/validate.js');
const { requireAuth } = require('./auth.js');
const { updateProgress, parseSave } = require('../utils/saveprogress.js');
const { createSaveStore } = require('../utils/savestore.js');

// В архиве с компьютера сейвы называются так, как их пишет сама игра: file1.rpgsave
// у MV и file1.rmmzsave у MZ. Движок же в браузере спрашивает сейв по своему ключу —
// «RPG File1» у MV и «MZ_file1» у MZ, — а мы храним файл под этим ключом. Без
// переименования импортированные сейвы в игре просто не появлялись, а файлы MZ
// вдобавок удалялись как посторонние. Содержимое у файла и у браузерного хранилища
// одинаковое, поэтому достаточно правильно назвать.
function desktopSaveKey(file) {
    const m = file.match(/^(.+)\.(rpgsave|rmmzsave)$/i);
    if (!m) return null;
    const [, name, ext] = m;
    return ext.toLowerCase() === 'rmmzsave'
        ? `MZ_${name}`
        : `RPG ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

const store = createSaveStore(SAVES_DIR);

// Что показать о версии слота: уровень, золото, время в игре и карта. Разбор сейва — десятки
// миллисекунд, а окно истории открывают снова и снова: помним по файлу, размеру и времени
const summaries = new Map();
async function summaryOf(file, size, at, mapNames) {
    const cacheKey = `${file}\n${size}\n${at}`;
    if (!summaries.has(cacheKey)) {
        let summary = null;
        try {
            const save = parseSave(await fsp.readFile(file, 'utf8'));
            const levels = Object.values(save?.actors?._data || {}).map((a) => a && a._level).filter(Boolean);
            summary = {
                playtime: Math.round((save?.system?._framesOnSave || 0) / 60),
                level: levels.length ? Math.max(...levels) : null,
                gold: save?.party?._gold ?? null,
                mapId: save?.map?._mapId ?? null,
            };
        } catch (e) {
            // Чужой формат — версия есть, подробностей нет
        }
        if (summaries.size > 1000) summaries.clear();
        summaries.set(cacheKey, summary);
    }
    const summary = summaries.get(cacheKey);
    return summary ? { ...summary, map: mapNames.get(summary.mapId) || '' } : null;
}

// Названия карт из редактора — data/MapInfos.json игры (у MV — в www)
async function mapNamesOf(gameId) {
    for (const dir of [path.join(GAMES_DIR, gameId, 'www', 'data'), path.join(GAMES_DIR, gameId, 'data')]) {
        try {
            const infos = JSON.parse(await fsp.readFile(path.join(dir, 'MapInfos.json'), 'utf8'));
            return new Map((Array.isArray(infos) ? infos : []).filter(Boolean).map((m) => [m.id, String(m.name || '')]));
        } catch (e) {
            // Нет файла или он зашифрован — без названий
        }
    }
    return new Map();
}

module.exports = function(EXTRACT_TMP) {
    const router = express.Router();

    router.use(requireAuth);

    // Иначе "/import/.." распаковал бы архив прямо в GAMES_DIR и снёс бы там все папки. Имя с точки
    // в начале — не игра: там лежит история сейвов (_saves/.history)
    const validId = (req, res, next, value) => (
        isSafeSegment(value) && !value.startsWith('.') ? next() : res.status(400).json({ error: 'Некорректный идентификатор' })
    );
    router.param('id', validId);
    router.param('gameId', validId);

    // --- 1. АРХИВЫ И ИСТОРИЯ (Должны быть вверху) ---
    router.get('/export/:id', async (req, res) => {
        const gameId = path.basename(req.params.id);
        const gameSavesDir = path.join(SAVES_DIR, gameId);

        try {
            const files = await fsp.readdir(gameSavesDir);
            if (files.filter(f => f.endsWith('.json')).length === 0) throw new Error();

            const tmpZip = path.join(EXTRACT_TMP, `saves_${crypto.randomBytes(4).toString('hex')}.zip`);
            await execFilePromise('7zz', ['a', '-tzip', tmpZip, path.join(gameSavesDir, '*.json')]);

            res.download(tmpZip, `${gameId}_saves.zip`, () => fsp.unlink(tmpZip).catch(() => {}));
        } catch (e) { res.status(404).json({ error: 'У этой игры еще нет сохранений' }); }
    });

    router.post('/import/:id', uploadLimiter, upload.single('saves'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

        // ВОЗВРАЩЕНА ПРОВЕРКА: Лимит 50MB
        if (req.file.size > 50 * 1024 * 1024) {
            await fsp.unlink(req.file.path).catch(() => {});
            return res.status(400).json({ error: 'Архив слишком большой' });
        }

        const gameId = path.basename(req.params.id);
        const archivePath = req.file.path;
        // Распаковываем в сторону, а в сейвы игры кладём по одному: заменённый слот уходит в
        // историю, а не пропадает
        const unpackDir = path.join(EXTRACT_TMP, `saves_import_${crypto.randomBytes(4).toString('hex')}`);

        try {
            await fsp.mkdir(unpackDir, { recursive: true });

            // ВОЗВРАЩЕНА ПРОВЕРКА: Zip Slip защита
            const { stdout } = await execFilePromise('7zz', ['l', '-ba', '-slt', archivePath], { maxBuffer: 50 * 1024 * 1024 });
            const baseTarget = path.resolve(unpackDir) + path.sep;
            for (const line of stdout.split('\n').filter(l => l.startsWith('Path = '))) {
                const internalPath = line.replace('Path = ', '').trim();
                if (!path.resolve(unpackDir, internalPath).startsWith(baseTarget)) throw new Error('Zip Slip Attack!');
            }

            // «e» — без папок из архива: все файлы в одну
            await spawnExtract('7zz', ['e', archivePath, `-o${unpackDir}`, '-y']);

            const saves = [];
            for (const file of await fsp.readdir(unpackDir)) {
                const filePath = path.join(unpackDir, file);
                if (!(await fsp.stat(filePath)).isFile()) continue;
                let key = desktopSaveKey(file);
                if (!key && file.toLowerCase().endsWith('.json')) {
                    try { key = decodeURIComponent(file.slice(0, -5)); } catch (e) { key = file.slice(0, -5); }
                }
                if (key) saves.push({ key, value: await fsp.readFile(filePath, 'utf8') });
            }
            if (!saves.length) throw Object.assign(new Error('В архиве нет сейвов'), { status: 400 });
            await store.importSaves(gameId, saves);
            updateProgress(gameId).catch(() => {});
            res.json({ success: true, message: 'Сохранения загружены!' });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.status ? e.message : 'Ошибка импорта' });
        } finally {
            await fsp.unlink(archivePath).catch(() => {});
            await fsp.rm(unpackDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    // Слоты игры и их прежние версии
    router.get('/history/:id', async (req, res) => {
        try {
            const gameId = path.basename(req.params.id);
            const mapNames = await mapNamesOf(gameId);
            const describe = async ({ file, ...rest }) => ({ ...rest, summary: await summaryOf(file, rest.size, rest.at, mapNames) });
            const slots = [];
            for (const slot of await store.history(gameId)) {
                slots.push({
                    key: slot.key,
                    current: slot.current ? await describe(slot.current) : null,
                    // Снимок экрана — только к нынешнему сейву слота
                    shot: !!(slot.current && await store.shotOf(gameId, slot.key)),
                    versions: await Promise.all(slot.versions.map(describe)),
                });
            }
            res.json({ slots });
        } catch (e) {
            console.error('[Saves] История:', e.message);
            res.status(500).json({ error: 'Не удалось прочитать историю сейвов' });
        }
    });

    // Снимок экрана к слоту (где был, когда игра сохранилась) — для списка «Продолжить с…»
    router.get('/shot/:id', async (req, res) => {
        const key = typeof req.query.key === 'string' ? req.query.key : '';
        const shot = key && await store.shotOf(path.basename(req.params.id), key);
        if (!shot) return res.status(404).end();
        res.sendFile(shot.file, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=60' } });
    });

    // Тело здесь разбираем сами: общий разборщик JSON запросы к сейвам пропускает (server.js)
    router.post('/history/:id/restore', express.json({ limit: '16kb' }), async (req, res) => {
        const gameId = path.basename(req.params.id);
        const { key, version } = req.body || {};
        if (typeof key !== 'string' || !key || typeof version !== 'string') return res.status(400).json({ error: 'Непонятно, что вернуть' });
        try {
            await store.restore(gameId, key, version);
            console.log(`[Saves] ${gameId}: слот «${key}» возвращён к версии ${version}`);
            updateProgress(gameId).catch(() => {});
            res.json({ success: true });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось вернуть версию' });
        }
    });

    // --- 2. ОДИНОЧНЫЕ ФАЙЛЫ ДВИЖКА (Внизу) ---
    router.get('/:gameId', async (req, res) => {
        const gameSavesDir = path.join(SAVES_DIR, path.basename(req.params.gameId));
        try {
            const files = await fsp.readdir(gameSavesDir);
            const saves = {};
            for (const file of files.filter(f => f.endsWith('.json'))) {
                const filePath = path.join(gameSavesDir, file);
                const stats = await fsp.stat(filePath);
                // Имя пришло из архива и может оказаться не тем, что мы записали сами:
                // на «100%.json» decodeURIComponent бросает ошибку, и раньше из-за
                // одного такого файла игра получала пустой список всех сейвов
                let key;
                try { key = decodeURIComponent(file.replace('.json', '')); }
                catch (e) { key = file.replace('.json', ''); }
                saves[key] = {
                    value: await fsp.readFile(filePath, 'utf8'), updatedAt: stats.mtimeMs
                };
            }
            res.json(saves);
        } catch(e) { res.json({}); }
    });

    // Сейв целиком в теле запроса. Общий лимит сервера — 1 МБ, а слоты больших игр
    // тяжелее, поэтому здесь свой: сюда доходят только после проверки входа.
    // kept: 'server' — на сервере этот слот новее (сохранились с другого устройства, пока это
    // было без сети): присланный сейв лёг в историю, страница игры скажет об этом
    router.post('/:gameId/:key', express.json({ limit: '50mb' }), async (req, res) => {
        if (typeof req.body?.value !== 'string') return res.status(400).json({ error: 'Bad data' });
        try {
            const gameId = path.basename(req.params.gameId);
            const key = path.basename(req.params.key);
            const result = await store.write(gameId, key, req.body.value, req.body.updatedAt);
            res.json(result === 'older' ? { success: true, kept: 'server' } : { success: true });
            if (result === 'older') console.log(`[Saves] ${gameId}: «${key}» на сервере новее — присланный сейв ушёл в историю`);

            // Игра ждёт ответа на запись, поэтому разбор сейва делаем уже после ответа.
            // Слоты — единственное, где есть прогресс: config и global пропускаем.
            if (result === 'saved' && /^(RPG File\d+|MZ_file\d+)$/i.test(key)) {
                updateProgress(gameId).catch(() => {});
            }
        } catch(e) { res.status(500).json({ error: 'Server error' }); }
    });

    // Удаление сейва. Слот не стирается, а уходит в историю сейвов
    router.delete('/:gameId/:key', async (req, res) => {
        try { await store.remove(path.basename(req.params.gameId), path.basename(req.params.key)); } catch(e) {}
        res.json({ success: true });
    });

    return router;
};

module.exports.store = store;
