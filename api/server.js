// ============================================================================
// [1] ИМПОРТЫ И КОНФИГУРАЦИЯ
// ============================================================================
require('dotenv').config({ quiet: true });   // без рекламных подсказок dotenv в журнале при каждом старте

// Встроенные модули Node.js
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const util = require('util');
const http = require('http');
const execFilePromise = util.promisify(require('child_process').execFile);

// Сторонние библиотеки (NPM)
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { setIo, redisClient, invalidateGamesList } = require('./src/utils/cache.js');

// Локальные сервисы и утилиты
const dbService = require('./src/db/database.js');
const scraperService = require('./src/services/scraper.js');
const audioService = require('./src/services/audio.js');
const { startNearby } = require('./src/utils/nearby.js');
const itchService = require('./src/services/itch.js');
const wishlistService = require('./src/services/wishlist.js');
const inboxService = require('./src/services/inbox.js');
const myjdService = require('./src/services/myjd.js');
const downloadsService = require('./src/services/downloads.js');
const seedboxService = require('./src/services/seedbox.js');
const relayService = require('./src/services/relay.js');
const createRelayRouter = require('./src/routes/relay.js');
const updateService = require('./src/services/updates.js');
const uploadService = require('./src/services/uploads.js');
const telegramService = require('./src/services/telegram.js');
const gameErrors = require('./src/services/gameErrors.js');
const galleryService = require('./src/services/gallery.js');
const galleryText = require('./src/services/galleryText.js');
const sceneLangs = require('./src/services/sceneLangs.js');
const fullCheck = require('./src/services/fullcheck.js');
const { thumbnail } = require('./src/utils/thumbs.js');
const { authRouter, requireAuth, isAuthedSocket } = require('./src/routes/auth.js');
const gamesRouter = require('./src/routes/games.js');
const createUploadsRouter = require('./src/routes/uploads.js');
const backupRouter = require('./src/routes/backup.js');
const createSavesRouter = require('./src/routes/saves.js');
const marksRouter = require('./src/routes/marks.js');
const journalRouter = require('./src/routes/journal.js');
const itchRouter = require('./src/routes/itch.js');
const downloadsRouter = require('./src/routes/downloads.js');
const translateService = require('./src/services/translate.js');
const pictureService = require('./src/services/pictures.js');
const wishlistRouter = require('./src/routes/wishlist.js');
const createTelegramRouter = require('./src/routes/telegram.js');
const createCheckRouter = require('./src/routes/check.js');
const createSettingsRouter = require('./src/routes/settings.js');
const quotaService = require('./src/services/quota.js');
const { loadSecrets } = require('./src/utils/secrets.js');
const { loadOptions } = require('./src/utils/options.js');
const { createGameApp, serveGameFile, gameKey, revOf, relFrom, isGameId, fixBarePercent, setTranslation } = require('./src/routes/play.js');
const { findGameFolder, getFolderSize } = require('./src/utils/archive.js');
const { GAMES_DIR, EXTRACT_TMP, SAVES_DIR, AUDIOCACHE, OLD_DIR, INBOX_DIR, SYSTEM_DIRS, OFFLINE } = require('./src/config/index.js');
const { backfillProgress, updateProgress, notePlaytime } = require('./src/utils/saveprogress.js');

// ============================================================================
// [2] ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ И ЗАВИСИМОСТЕЙ
// ============================================================================
const app = express();
const server = http.createServer(app);
// CORS к веб-сокетам браузером не применяется, поэтому пускаем по той же куке,
// что и обычные запросы: чужая страница и сторонний скрипт получат 403.
const io = new Server(server, {
    allowRequest: (req, done) => done(null, isAuthedSocket(req) && fromLibraryOnly(req.headers)),
});

// Запросы к API и сокету — только со страниц самой библиотеки. Браузер помечает, откуда запрос
// (Sec-Fetch-Site): с сервера игр (тот же хост, другой порт) — same-site, с чужого сайта — cross-site.
// Старый браузер без пометки: смотрим Origin — с порта игр не пускаем. Без обоих заголовков — не
// браузер (проверка совместимости, curl): у него есть вход, но нет чужого кода
function fromLibraryOnly(headers) {
    const site = headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = headers.origin;
    if (origin && ISOLATED) {
        try { if (new URL(origin).port === GAME_PORT) return false; } catch (e) { return false; }
    }
    return true;
}

// Внедрение зависимостей в сервисы
scraperService.setDependencies(io, GAMES_DIR, dbService);
dbService.setDependencies(io, scraperService, GAMES_DIR, gamesRouter.trash);
itchService.setDependencies(dbService);
wishlistService.setDependencies(dbService, { itch: itchService });
uploadService.setDependencies({
    dir: EXTRACT_TMP,
    gamesDir: GAMES_DIR,
    oldDir: OLD_DIR,
    inboxDir: INBOX_DIR,
    addGameToDB: dbService.addGameToDB.bind(dbService),
    refreshGame: dbService.refreshGame.bind(dbService),
    findGameFolder,
    // Размер новой игры — в фоне: у большой du считает минуту
    afterAdd: (folder, dest) => getFolderSize(dest)
        .then((size) => size && dbService.get().run('UPDATE games SET size = ? WHERE id = ?', [size, folder]))
        .then(() => invalidateGamesList())
        .catch((e) => console.error('[Upload] Размер игры:', e.message)),
});
myjdService.setDependencies({ file: path.join(GAMES_DIR, '_media', 'jd-downloads.json'), uploads: uploadService, inbox: inboxService, seedbox: seedboxService, relay: relayService });
// Сообщения в Telegram: загрузки без присмотра, копия базы и сейвов, проблемы. И пульт: ссылка на файл —
// «Загрузить» через MyJDownloader; встало на сборе ссылок — бот так и скажет
telegramService.setDependencies({
    db: dbService, buildBackup: backupRouter.buildBackup, tmpDir: EXTRACT_TMP, gamesDir: GAMES_DIR, savesDir: SAVES_DIR,
    download: (what) => downloadsService.startFrom(what, 'tg'),
});
myjdService.onStage = (job) => telegramService.downloadStage(job);
uploadService.onFinished = (info) => telegramService.uploadFinished(info);
gameErrors.setDependencies(dbService);
galleryService.setDependencies({ gamesDir: GAMES_DIR });
galleryText.setDependencies({ mediaDir: galleryService.mediaDir });
// Полная проверка библиотеки — кнопкой из ревизии: ход по сокету всем открытым страницам
fullCheck.setDependencies({
    db: dbService, scraper: scraperService,
    emit: (state) => io.emit('fullcheck', state),
});
// Перевод игр: словарь и очередь (services/translate.js); сервер игр подставляет перевод в data/*.json
translateService.setDependencies({ dbService, gamesDir: GAMES_DIR, onChange: () => invalidateGamesList() });
// Остатки служб для «Настроек → Службы» и для вопроса «перевести?»
quotaService.setDependencies({ translate: translateService, scraper: scraperService, telegram: telegramService });
translateService.quota = quotaService;
// Текст на картинках игр (services/pictures.js): служба распознавания — свой контейнер (ocr/, адрес OCR_URL)
pictureService.setDependencies({ dbService, translate: translateService });
translateService.pictures = pictureService;
setTranslation({ langOf: (id) => translateService.langOf(id), overlay: (id, name, raw) => translateService.overlay(id, name, raw), overlayPlugins: (id, raw) => translateService.overlayPlugins(id, raw), displayDict: (id) => translateService.displayDict(id), originalFile: (id, rel) => translateService.originalFile(id, rel), patch: (hash) => pictureService.patch(hash), langs: translateService.LANGS });
// «Место»: что сколько занимает на диске (окно «Статистика и ревизия»)
require('./src/services/space.js').setDependencies({
    db: dbService, trash: gamesRouter.trash, uploads: uploadService, gamesDir: GAMES_DIR, oldDir: OLD_DIR, savesDir: SAVES_DIR,
});
setIo(io);

// ============================================================================
// [3] ГЛОБАЛЬНЫЕ MIDDLEWARE И НАСТРОЙКА ПАПОК
// ============================================================================
// Голый «%» в адресе (картинка «$Hero%(8).png» у MV 1.6) — знак процента, а не ошибка: так игры
// работают и без отдельного сервера игр (GAME_ISOLATION=off)
app.use(fixBarePercent);
app.use(compression());
// Тело JSON у нас обычно в несколько килобайт (метаданные, форма входа), и 1 МБ
// хватает с запасом: 50 МБ позволяли любому неавторизованному клиенту занимать
// память сервера. Исключение — сейвы: у больших игр один слот весит больше мегабайта
// (Ironhold Keep — 1,1 МБ), и с общим лимитом сервер отвечал 413 — сохранение
// оставалось только в браузере. Их разбирает сам роут сохранений с лимитом побольше
// и уже после проверки входа (routes/saves.js)
const smallJson = express.json({ limit: '1mb' });
// Так же — файл готового перевода игры (MTool и другие): у большой игры это мегабайты; его маршрут
// (routes/games.js, /translation/import) разбирает тело сам, после проверки входа
app.use((req, res, next) => (
    req.method === 'POST' && (req.path.startsWith('/api/saves/') || /^\/api\/games\/[^/]+\/translation\/import$/.test(req.path)) ? next() : smallJson(req, res, next)
));
app.use(cookieParser());
// Отключаем строгие политики Helmet, чтобы игры в iframe (Cross-Origin) работали корректно
app.use(helmet({ 
    contentSecurityPolicy: false, 
    crossOriginEmbedderPolicy: false, 
    crossOriginOpenerPolicy: false, 
    originAgentCluster: false 
}));

// Лимитер запросов для API
// Куски загрузки игры сюда не входят: по 20 МБ в быстрой сети их за минуту больше двухсот,
// и загрузка упиралась бы в 429. У них свой лимит (routes/uploads.js), после проверки входа
// API_RATE_LIMIT — сколько запросов в минуту с одного адреса (по умолчанию 200). Автотесты интерфейса
// (tests/e2e) ходят быстрее человека и поднимают его
const apiLimiter = rateLimit({ 
    windowMs: 60 * 1000, 
    max: Number(process.env.API_RATE_LIMIT) || 200, 
    message: { error: 'Слишком много запросов' },
    // Картинки галереи (services/gallery.js) — десятки на экран сразу: лимит они выбрали бы за минуту
    // Снимки закладок сцен — так же
    skip: (req) => req.path.startsWith('/games/upload/') || /^\/gallery\/[^/]+\/(thumb|image|video|spine|live2d|audio|sounds|rig-cover)$/.test(req.path)
        || /^\/marks\/[^/]+\/[^/]+\/thumb$/.test(req.path) || /^\/saves\/shot\/[^/]+$/.test(req.path),
});
app.use('/api/', apiLimiter);
app.use('/api/', (req, res, next) => (fromLibraryOnly(req.headers) ? next() : res.status(403).json({ error: 'Запрос не со страницы библиотеки' })));

// Создание системных директорий при старте
Promise.all([
    fsp.mkdir(EXTRACT_TMP, { recursive: true }),
    fsp.mkdir(SAVES_DIR, { recursive: true }),
    fsp.mkdir(AUDIOCACHE, { recursive: true })
]).catch(err => console.error('[Init] Ошибка создания системных папок:', err));


// ============================================================================
// [4] ФОНОВЫЕ ЗАДАЧИ (КРОН)
// ============================================================================

// Авто-очистка временной папки загрузок (каждый час)
setInterval(async () => {
    try {
        const files = await fsp.readdir(EXTRACT_TMP);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(EXTRACT_TMP, file);
            const stat = await fsp.stat(filePath);
            
            // Удаляем файлы и папки старше 24 часов (86400000 мс)
            if (now - stat.mtimeMs > 86400000) { 
                await fsp.rm(filePath, { recursive: true, force: true }).catch(()=>{});
                console.log(`[Cleanup] Удален старый временный файл: ${file}`);
            }
        }
    } catch (e) {
        console.error('[Cleanup] Ошибка очистки:', e.message);
    }
}, 60 * 60 * 1000);

// Корзина: что лежит дольше 30 дней — стираем (services/trash.js). Раз в шесть часов и при старте
const purgeTrash = () => gamesRouter.trash.purge().catch((e) => console.error('[Корзина]', e.message));
setInterval(purgeTrash, 6 * 60 * 60 * 1000);
setTimeout(purgeTrash, 60 * 1000);


// ============================================================================
// [5] API РОУТЫ (ОТКРЫТЫЕ И ЗАКРЫТЫЕ)
// ============================================================================

// --- ОТКРЫТЫЕ API ---
app.use('/api', authRouter); // Логин, логаут, проверка статуса настройки
// Связанная установка: просит связать и забирает свои архивы — по ключу, без куки (services/relay.js)
app.use('/api/relay', createRelayRouter());

// --- ЗАМОК АВТОРИЗАЦИИ ---
app.use('/api', requireAuth); // Все роуты ниже этой строки требуют куки `auth_token`

// --- ЗАКРЫТЫЕ API ---
app.use('/api/games/upload', createUploadsRouter(uploadService));
app.use('/api/backup', backupRouter);
app.use('/api/games', gamesRouter);
app.use('/api/saves', createSavesRouter(EXTRACT_TMP));
app.use('/api/marks', marksRouter);
app.use('/api/journal', journalRouter);
app.use('/api/itch', itchRouter);
app.use('/api/downloads', downloadsRouter);
app.use('/api/wishlist', wishlistRouter);
app.use('/api/telegram', createTelegramRouter(telegramService));
app.use('/api/check', createCheckRouter(fullCheck));
app.use('/api/settings', createSettingsRouter(dbService, {
    checks: {
        telegram: (v) => telegramService.checkToken(v),
        myjd: (v) => myjdService.check(v),
        seedbox: (v) => seedboxService.setup(v),
        // Службы перевода: ключ проверяем одним словом
        ...Object.fromEntries(['deepl', 'microsoft', 'google', 'libre'].map((name) => [name, (v) => translateService.checkKey(name, v)])),
    },
    services: (fresh) => quotaService.report({ fresh }),
    seedbox: seedboxService,
    relay: relayService,
    updates: updateService,
    // Что задаётся только на сервере — для «О программе». Секреты и адреса с паролями — только «задан / нет»
    server: () => ({
        gamePort: GAME_PORT,
        isolation: ISOLATED,
        offline: OFFLINE,
        gamesDir: GAMES_DIR,
        inboxDir: INBOX_DIR,
        redis: !!process.env.REDIS_URL && process.env.REDIS_URL !== 'memory',
        ocr: !!process.env.OCR_URL,
        secretsKey: process.env.SECRETS_KEY ? 'env' : 'file',
        sessionSecret: process.env.SESSION_SECRET ? 'env' : 'db',
    }),
    onSaved: (name) => {
        quotaService.invalidate();       // ключ сменился — сводку служб спросить заново
        if (name === 'telegram') { telegramService.tokenChanged(); telegramService.start(); }
        if (translateService.ENGINES.includes(name)) translateService.clearExhausted(name).catch(() => {});
        if (name === 'seedbox') seedboxService.pull();
    },
}));

// Журнал ошибок игр (services/gameErrors.js): прислать — игра по-старому, на адресе библиотеки
// (на своём адресе она шлёт серверу игр); прочитать и очистить — «Ревизия»
app.post('/api/errors/:id', async (req, res) => {
    if (isGameId(req.params.id)) await gameErrors.record(req.params.id, req.body || {}, req.get('user-agent') || '').catch(() => {});
    res.status(204).end();
});
// Галерея из файлов игры (services/gallery.js): оглавление, миниатюра, картинка целиком
app.get('/api/gallery/:id', async (req, res) => {
    if (!isGameId(req.params.id) || !fs.existsSync(path.join(GAMES_DIR, req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
    try {
        res.json(await galleryService.state(req.params.id));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/gallery/:id/thumb', async (req, res) => {
    try {
        const file = isGameId(req.params.id) && await galleryService.thumb(req.params.id, req.query.f);
        if (!file) return res.status(404).end();
        res.setHeader('Cache-Control', 'private, max-age=604800');
        res.sendFile(file);
    } catch (e) { res.status(500).end(); }
});
app.get('/api/gallery/:id/image', async (req, res) => {
    try {
        // Один адрес, два вида: браузеру с WebP — лёгкая копия большого PNG (gallery.view), остальным и по ?orig=1 — оригинал
        res.setHeader('Vary', 'Accept');
        if (isGameId(req.params.id) && !req.query.orig && /image\/webp/.test(req.get('accept') || '')) {
            const copy = await galleryService.view(req.params.id, req.query.f);
            if (copy) {
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Cache-Control', 'private, max-age=86400');
                return res.sendFile(copy);
            }
        }
        const img = isGameId(req.params.id) && await galleryService.image(req.params.id, req.query.f, true);
        if (!img) return res.status(404).end();
        res.setHeader('Content-Type', img.type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(img.data);
    } catch (e) { res.status(500).end(); }
});
// Избранное из галерей: картинки и ролики разных игр одним альбомом (FavoritesGallery). Только игр из библиотеки
// (убранная в корзину своё избранное не показывает, вернули — снова видно). ?game= — одной игры (GameGallery)
const FAVORITE_KINDS = ['cg', 'engine', 'animation', 'video', 'portrait', 'backdrop', 'layer', 'other'];
app.get('/api/favorites', async (req, res) => {
    const game = typeof req.query.game === 'string' ? req.query.game : '';
    if (game && !isGameId(game)) return res.status(400).json({ error: 'bad-id' });
    try {
        const rows = await dbService.get().all(`SELECT f.game_id AS game, f.file, f.kind, f.at, f.anim FROM gallery_favorites f
            JOIN games g ON g.id = f.game_id ${game ? 'WHERE f.game_id = ?' : ''} ORDER BY f.at DESC, f.file`, game ? [game] : []);
        // Склейка «@cg/…» — по составу слоёв: если разбор сцен изменился, в новом оглавлении её может не быть. Такую
        // не показываем (битая плитка), но и не стираем: вернётся в оглавление — снова видно. У анимации — так же по кадрам
        const gone = async (game, file) => file.startsWith('@cg/') && (await galleryService.knows(game, file)) === false;
        const shown = [];
        for (const { anim, ...row } of rows) {
            if (await gone(row.game, row.file)) continue;
            let saved = null;
            try { saved = anim ? JSON.parse(anim) : null; } catch { /* испорченная запись — как одна картинка */ }
            const frames = [];
            for (const f of Array.isArray(saved?.frames) ? saved.frames : []) if (!(await gone(row.game, f))) frames.push(f);
            shown.push(frames.length > 1 ? { ...row, frames, fps: saved.fps } : row);
        }
        res.json(shown);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Поиск картинок по словам (русский, английский, немецкий) во всех играх библиотеки: запрос — вектором в пространстве
// CLIP (galleryText.js), сравнение — с векторами кадров, которые распознавание уже посчитало (gallery.js, searchPictures).
// Игры, которых распознавание ещё не касалось, в поиске не участвуют: games — сколько игр искали
app.get('/api/pictures/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length > 100) return res.status(400).json({ error: 'bad-query' });
    const limit = Math.min(120, Math.max(1, parseInt(req.query.limit, 10) || 60));
    try {
        const vec = await galleryText.embed(q);
        if (!vec) return res.status(503).json({ error: 'unavailable' });
        const ids = (await dbService.get().all('SELECT id FROM games')).map((g) => g.id).filter(isGameId);
        const { rows, games } = await galleryService.searchPictures(vec, ids, limit);
        res.json({ games, results: rows });
    } catch (e) {
        // Что именно сломалось — в журнал, а не человеку: текст ошибки может содержать пути на диске
        console.error('[Поиск картинок]', e.message);
        res.status(500).json({ error: 'search-failed' });
    }
});
// Добавить можно только файл из оглавления галереи этой игры (gallery.js, resolve). Анимация из кадров — целиком:
// frames (первый — сам file, каждый — тоже из оглавления) и темп fps
app.put('/api/favorites', async (req, res) => {
    const { game, file, kind, frames, fps } = req.body || {};
    try {
        if (!isGameId(game) || typeof file !== 'string' || !(await galleryService.resolve(game, file))) return res.status(400).json({ error: 'bad-file' });
        let anim = '';
        if (frames !== undefined) {
            const ok = Array.isArray(frames) && frames.length >= 2 && frames.length <= 2000 && frames[0] === file && frames.every((f) => typeof f === 'string')
                && (await Promise.all(frames.map((f) => galleryService.knows(game, f)))).every((known) => known === true);
            if (!ok) return res.status(400).json({ error: 'bad-file' });
            anim = JSON.stringify({ frames, fps: Math.min(60, Math.max(1, Number(fps) || 8)) });
        }
        // Тот же файл сердечком как одна картинка (первый кадр анимации бывает и в альбоме события) не превращает
        // отмеченную анимацию в один кадр
        await dbService.get().run(`INSERT INTO gallery_favorites (game_id, file, kind, at, anim) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(game_id, file) DO UPDATE SET kind = excluded.kind, anim = excluded.anim WHERE excluded.anim <> '' OR anim = ''`,
        [game, file, FAVORITE_KINDS.includes(kind) ? kind : '', Date.now(), anim]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/favorites', async (req, res) => {
    const { game, f } = req.query;
    if (!isGameId(game) || typeof f !== 'string') return res.status(400).json({ error: 'bad-file' });
    try {
        await dbService.get().run('DELETE FROM gallery_favorites WHERE game_id = ? AND file = ?', [game, f]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Ролик из галереи: файлом, с перемоткой — браузер просит его кусками (Range)
app.get('/api/gallery/:id/video', async (req, res) => {
    try {
        const video = isGameId(req.params.id) && await galleryService.video(req.params.id, req.query.f);
        if (!video) return res.status(404).end();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Файл — только из оглавления галереи (gallery.js, resolve): точка в имени папки не повод для 404
        res.sendFile(video.file, { dotfiles: 'allow', headers: { 'Content-Type': video.type, 'Cache-Control': 'private, max-age=86400' } }, (err) => {
            if (err && !res.headersSent) res.status(err.status || 500).end();
        });
    } catch (e) { res.status(500).end(); }
});
// Звуки игры (gallery.js, sounds): список по папкам и сам звук — расшифрованный, с перемоткой (Range), как ролик
app.get('/api/gallery/:id/sounds', async (req, res) => {
    if (!isGameId(req.params.id) || !fs.existsSync(path.join(GAMES_DIR, req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
    try { res.json(await galleryService.sounds(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Сцена для плеера галереи (gallery.js, scene): картинки альбома, реплики, звук и паузы по порядку. Реплики — в переводе
// Mimikin, если игра переводится. n — только целое число из цифр; пусто, дробь, массив и прочее — номер -1, сцены нет
app.get('/api/gallery/:id/scene', async (req, res) => {
    if (!isGameId(req.params.id) || !fs.existsSync(path.join(GAMES_DIR, req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
    try {
        const mt = await translateService.langOf(req.params.id);
        // Язык реплик: lang — выбранный человеком, ui — язык интерфейса; клиент без них (старая страница) получает как раньше
        const want = sceneLangs.codes(req.query.lang);
        const ui = sceneLangs.codes(req.query.ui)[0] || '';
        let known = [];
        if (want.length || ui) {
            try { known = JSON.parse((await dbService.get().get("SELECT value FROM settings WHERE key = 'known_langs'"))?.value || '[]').filter((x) => typeof x === 'string'); } catch (e) { known = []; }
        }
        const scene = await galleryService.scene(req.params.id, String(req.query.key || ''), mt ? (strings) => translateService.lookup(req.params.id, strings) : null,
            { want, ui, known, mt, client: !!(want.length || ui), n: req.query.n === undefined ? 0 : typeof req.query.n === 'string' && /^\d{1,4}$/.test(req.query.n) ? Number(req.query.n) : -1 });
        if (!scene) return res.status(404).json({ error: 'Сцены нет' });
        res.json(scene);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/gallery/:id/audio', async (req, res) => {
    try {
        const sound = isGameId(req.params.id) && await galleryService.sound(req.params.id, req.query.f);
        if (!sound) return res.status(404).end();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const headers = { 'Content-Type': sound.type, 'Cache-Control': 'private, max-age=86400' };
        if (sound.file) {
            return res.sendFile(sound.file, { dotfiles: 'allow', headers }, (err) => {
                if (err && !res.headersSent) res.status(err.status || 500).end();
            });
        }
        // Зашифрованное читаем с диска только нужным куском: Range разбираем сами (один диапазон — как просит <audio>)
        const size = sound.size;
        res.set(headers);
        res.setHeader('Accept-Ranges', 'bytes');
        const send = (start, end) => {
            res.setHeader('Content-Length', end - start + 1);
            const stream = sound.read(start, end);
            stream.on('error', () => res.destroy());
            res.on('close', () => stream.destroy());
            stream.pipe(res);
        };
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (!m || (!m[1] && !m[2])) return size ? send(0, size - 1) : res.status(200).end();
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || start > end) { res.setHeader('Content-Range', `bytes */${size}`); return res.status(416).end(); }
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.status(206);
        send(start, end);
    } catch (e) { res.status(500).end(); }
});
// Файлы набора Spine (атлас, скелет, страницы) для проигрывателя галереи — только перечисленные в оглавлении (gallery.js, spineFile)
app.get('/api/gallery/:id/spine', async (req, res) => {
    try {
        const spine = isGameId(req.params.id) && await galleryService.spineFile(req.params.id, req.query.f);
        if (!spine) return res.status(404).end();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(spine.file, { dotfiles: 'allow', headers: { 'Content-Type': spine.type, 'Cache-Control': 'private, max-age=86400' } }, (err) => {
            if (err && !res.headersSent) res.status(err.status || 500).end();
        });
    } catch (e) { res.status(500).end(); }
});
// Файлы модели Live2D (model3.json, moc3, текстуры, движения, ядро игры) — только перечисленные в оглавлении (gallery.js, live2dFile).
// ?max= — ужать текстуру (телефону не по силам лист больше его MAX_TEXTURE_SIZE)
app.get('/api/gallery/:id/live2d', async (req, res) => {
    try {
        const part = isGameId(req.params.id) && await galleryService.live2dFile(req.params.id, req.query.f, req.query.max);
        if (!part) return res.status(404).end();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(part.file, { dotfiles: 'allow', headers: { 'Content-Type': part.type, 'Cache-Control': 'private, max-age=86400' } }, (err) => {
            if (err && !res.headersSent) res.status(err.status || 500).end();
        });
    } catch (e) { res.status(500).end(); }
});
// Обложка плитки набора Spine / модели Live2D (gallery.js, rigCoverPut): сервер их не рисует, кадр присылает браузер,
// который их открыл. Тело — сам JPEG; первая присланная остаётся (приборы не спорят), чужой ключ и не-JPEG отвергаются
app.put('/api/gallery/:id/rig-cover', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    try {
        if (!isGameId(req.params.id)) return res.status(404).end();
        const body = Buffer.isBuffer(req.body) ? req.body : null;
        if (!body || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) return res.status(400).end();
        const done = await galleryService.rigCoverPut(req.params.id, String(req.query.key || ''), body);
        res.status(done === 'bad-key' ? 404 : 204).end();
    } catch (e) { res.status(500).end(); }
});
// Слишком большое тело express.raw отвергает ошибкой, а не ответом: превращаем её в 413
app.use('/api/gallery/:id/rig-cover', (err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).end();
    next(err);
});
app.get('/api/gallery/:id/rig-cover', async (req, res) => {
    try {
        const file = isGameId(req.params.id) && await galleryService.rigCover(req.params.id, String(req.query.key || ''));
        if (!file) return res.status(404).end();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Сутки, а не неделя: почти пустую обложку сервер заменяет полной, а адрес у неё тот же
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.sendFile(file);
    } catch (e) { res.status(500).end(); }
});
app.get('/api/errors', async (req, res) => {
    try { res.json({ games: await gameErrors.list() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/errors/:id', async (req, res) => {
    await gameErrors.clear(req.params.id).catch(() => {});
    res.json({ success: true });
});

// Место на диске для шапки. du по всей папке игр — десятки секунд на большой библиотеке, поэтому
// считаем его фоном раз в час, а отвечаем сразу: до первого подсчёта — размером игр из базы
let cachedStorage = null;
let storageRunning = false;
const STORAGE_TTL = 60 * 60 * 1000;
async function refreshStorage() {
    if (storageRunning) return;
    storageRunning = true;
    try {
        const { stdout } = await execFilePromise('nice', ['-n', '19', 'du', '-sb', GAMES_DIR]);
        const stats = await fsp.statfs(GAMES_DIR);
        cachedStorage = { used: parseInt(stdout.split('\t')[0], 10), free: stats.bavail * stats.bsize, at: Date.now() };
    } catch (error) {
        console.error('[Storage] Ошибка чтения диска:', error.message);
    } finally {
        storageRunning = false;
    }
}

app.get('/api/storage', async (req, res) => {
    try {
        if (!cachedStorage || Date.now() - cachedStorage.at > STORAGE_TTL) refreshStorage();
        const stats = await fsp.statfs(GAMES_DIR);
        const free = stats.bavail * stats.bsize;
        const used = cachedStorage?.used ?? ((await dbService.get().get('SELECT SUM(size) AS s FROM games'))?.s || 0);
        res.json({ used, free });
    } catch (error) {
        console.error('[Storage] Ошибка чтения диска:', error);
        res.status(500).json({ error: 'Failed to read storage' });
    }
});


// ============================================================================
// [6] РАЗДАЧА СТАТИКИ И ПРОКСИ ИГР (ЯДРО ПЛАТФОРМЫ)
// ============================================================================

// Раздача фронтенда (React сборка в папке public)
// Файлы сборки (assets/…-хеш.js) меняют имя вместе с содержимым — их держим в кэше год; страницу
// index.html браузер переспрашивает всегда, иначе после выкатки он показывал бы прежнюю версию
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, file) => {
        if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
}));

// Игры — на своём адресе (routes/play.js): порт GAME_PORT, по умолчанию 8081. GAME_ISOLATION=off —
// по-старому, на адресе библиотеки (на случай, если на каком-то устройстве игры в рамке не пойдут)
const GAME_PORT = String(process.env.GAME_PORT || '8081').trim();
const ISOLATED = process.env.GAME_ISOLATION !== 'off';
// Полный адрес сервера игр, если он не «тот же адрес, другой порт» (dev за прокси)
const GAME_ORIGIN = (process.env.GAME_ORIGIN || '').replace(/\/+$/, '');

// Старт игры: адрес для страницы. В рамке — сервер игр с ключом этой игры, по-старому — папка игры
app.post('/api/play/:id', async (req, res) => {
    const id = req.params.id;
    if (!isGameId(id) || !(await fsp.stat(path.join(GAMES_DIR, id)).then((st) => st.isDirectory(), () => false))) {
        return res.status(404).json({ error: 'Игра не найдена' });
    }
    if (!ISOLATED) return res.json({ mode: 'page', path: `/${encodeURIComponent(id)}/` });
    res.json({ mode: 'frame', port: GAME_PORT, origin: GAME_ORIGIN, path: `/g/${gameKey(dbService.getSessionToken(), id, await revOf(id))}/${encodeURIComponent(id)}/` });
});

// Картинки из папок — обложки и снимки (_media/…, старые обложки в папке игры). Остальное из папок
// игр адрес библиотеки не отдаёт: код игры здесь не должен запускаться. Старая ссылка на игру
// (закладка) — в библиотеку, она откроет игру сама
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
app.get('*', requireAuth, async (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/') return next();
    const rel = relFrom(req.path);
    if (rel === null) return res.status(400).send('Непонятный адрес');
    const first = rel.split('/')[0];
    if (!ISOLATED) {
        // Перевод включён — rpg-fixes переносит длинные строки (как и на сервере игр)
        const tl = await translateService.langOf(first).catch(() => '');
        return serveGameFile(req, res, next, { rel, prefix: '', inject: { id: first, saves: '/api/saves', errors: '/api/errors', ...(tl ? { tl } : {}) } });
    }
    if (IMAGE_FILE.test(rel)) {
        const file = path.resolve(GAMES_DIR, rel);
        if (!file.startsWith(path.resolve(GAMES_DIR) + path.sep)) return res.status(403).end();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // ?w=360 или 720 — уменьшенная копия (utils/thumbs.js): карточкам на телефоне хватает её.
        // Не получилось (не картинка, нет ffmpeg) — отдаём исходную
        if (req.query.w) {
            const small = await thumbnail(file, req.query.w, path.join(GAMES_DIR, '_media', '.thumbs')).catch(() => null);
            if (small) {
                res.setHeader('Cache-Control', 'private, max-age=604800');
                return res.sendFile(small, { cacheControl: false });
            }
        }
        return res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    }
    if (isGameId(first) && fs.existsSync(path.join(GAMES_DIR, first))) return res.redirect(`/?play=${encodeURIComponent(first)}`);
    next();
});


// ============================================================================
// [7] ЗАПУСК СЕРВЕРА И ФАЙЛОВЫЙ ВОТЧЕР
// ============================================================================

if (require.main === module) {
    dbService.init(GAMES_DIR).then(async () => {
        // Пауза очереди поиска — до первого запуска воркера (импорт и синхронизация его зовут сразу)
        await scraperService.loadPaused().catch(() => {});
        // Ключи, вписанные в «Настройках»: ScraperAPI, бот Telegram, пароль копий (.env главнее)
        await loadSecrets(dbService.get());
        await loadOptions(dbService.get());
        
        await gameErrors.init();
        // Первичная синхронизация базы при старте
        await dbService.syncDatabase();
        // Сейвы, которые лежат под прежними, «исправленными» именами папок, — к своим играм
        const ids = (await dbService.get().all('SELECT id FROM games')).map((r) => r.id);
        await createSavesRouter.store.migrate(ids).catch((e) => console.error('[Saves]', e.message));
        // Загрузки, чья распаковка оборвалась перезапуском, — доделать
        uploadService.recover().catch((e) => console.error('[Upload]', e.message));
        // «Входящие»: архивы, положенные в папку (JDownloader и т. п.), — в библиотеку сами
        // «Загрузить» у игры из библиотеки — скачанный архив встаёт её обновлением
        inboxService.setDependencies({ dir: INBOX_DIR, uploads: uploadService, targetOf: (name) => myjdService.targetFor(name), volumesOf: (name) => myjdService.volumesOf(name) });
        inboxService.start();
        startNearby();
        // Seedbox: готовые архивы с удалённого сервера — во «Входящие» (если настроен в «Настройках»)
        seedboxService.setDependencies({ dir: INBOX_DIR });
        seedboxService.start();
        relayService.setDependencies({ dir: INBOX_DIR, db: dbService });
        relayService.start();

        // Запуск HTTP и WebSocket сервера
        const PORT = process.env.PORT || 3000;
        const srv = server.listen(PORT, () => {
            console.log(`🚀 RPG API: Сервер запущен на порту ${PORT}`);
        });
        
        // Отключаем таймауты для поддержки долгих загрузок больших архивов
        srv.timeout = 0; srv.requestTimeout = 0; srv.keepAliveTimeout = 0;

        // Сервер игр — внутри контейнера порт 3001, снаружи GAME_PORT (docker-compose.yml)
        let gameSrv = null;
        if (ISOLATED) {
            const gameApp = createGameApp({
                secret: () => dbService.getSessionToken(),
                store: createSavesRouter.store,
                marks: marksRouter.store,
                journal: journalRouter.store,
                publicDir: path.join(__dirname, 'public'),
                onError: (id, body, ua) => gameErrors.record(id, body, ua),
                onSaved: (id, slot) => { if (/^(RPG File\d+|MZ_file\d+)$/i.test(slot)) updateProgress(id).catch(() => {}); },
                onMarked: (id, playtime) => { notePlaytime(id, playtime).catch(() => {}); },
            });
            gameSrv = http.createServer(gameApp).listen(3001, () => console.log(`🎮 Игры: порт 3001 (снаружи ${GAME_PORT})`));
        }
        
        // Ядро не доставляет процессу с PID 1 сигналы, для которых нет обработчика.
        // Без этих строк сервер не слышал SIGTERM и через 10 секунд получал SIGKILL.
        const shutdown = async (signal) => {
            console.log(`⏹️  Получен ${signal}, завершаем работу`);
            // Страховка: если что-то зависнет при закрытии — выходим сами
            setTimeout(() => process.exit(0), 5000).unref();
            io.close();
            srv.close();
            gameSrv?.close();
            try { await redisClient.quit(); } catch (e) {}
            try { await dbService.get().close(); } catch (e) {}
            process.exit(0);
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        
        // Разовый проход по существующим сейвам, чтобы прогресс появился у старых игр
        setTimeout(() => backfillProgress().catch(e => console.error('[Progress]', e.message)), 3000);
        // И язык по тексту игры — для тех, что добавлены до появления этой проверки
        setTimeout(() => dbService.fillTextLang().catch(e => console.error('[Lang]', e.message)), 4000);

        // OFFLINE=1 (автотесты, демо): ничего из того, что ходит на чужие сайты, не запускаем
        if (OFFLINE) console.log('📴 OFFLINE=1: поиск данных и проверки на сайтах выключены');

        // Поиск метаданных: воркер берёт из базы игры, чей срок подошёл. На старте —
        // догнать то, что созрело, пока сервер лежал; дальше раз в полчаса проверять,
        // не подошёл ли срок у отложенных (повторы идут с паузами от часа до месяца).
        // Ключи старой очереди в Redis больше не нужны — убираем разово.
        if (!OFFLINE) setTimeout(async () => {
            await scraperService.cleanupLegacyQueue();
            scraperService.processBackgroundScrape().catch(e => console.error('[Queue]', e.message));
        }, 5000);
        if (!OFFLINE) setInterval(() => {
            scraperService.processBackgroundScrape().catch(e => console.error('[Queue]', e.message));
        }, 30 * 60 * 1000).unref();

        if (!OFFLINE) {
            // Перевод игр, прерванный перезапуском, — продолжить
            translateService.recover().catch((e) => console.error('[Перевод]', e.message));
            // И разбор картинок
            pictureService.recover().catch((e) => console.error('[Картинки]', e.message));
        }
        // Telegram: раз в час — место на диске и копия базы и сейвов (если бот настроен)
        telegramService.start();
        // Оглавления галерей — фоном, по одной игре, через 10 минут после старта
        galleryService.start(async () => (await dbService.get().all('SELECT id FROM games WHERE ready = 1 ORDER BY lastPlayed DESC')).map((r) => r.id));

        // Настройка "наблюдателя" (Watcher) за папкой игр для автообновления библиотеки
        let syncTimer = null;
        let syncInProgress = false;
        let pendingSync = false;
        let lastReadyCount = (await dbService.get().get('SELECT COUNT(*) as c FROM games WHERE ready = 1'))?.c || 0;

        async function runSyncSafely(reason = 'watcher') {
            if (syncInProgress) { pendingSync = true; return; }
            syncInProgress = true;
            try {
                await dbService.syncDatabase();
                const newReadyCount = (await dbService.get().get('SELECT COUNT(*) as c FROM games WHERE ready = 1'))?.c || 0;
                
                // Если количество игр изменилось, уведомляем фронтенд
                if (newReadyCount !== lastReadyCount) {
                    const diff = newReadyCount - lastReadyCount;
                    lastReadyCount = newReadyCount;
                    io.emit('scrape-success', diff > 0 ? { kind: 'synced', count: diff, message: `Добавлено готовых игр: ${diff}` } : { kind: 'refreshed', message: 'Библиотека обновлена' });
                }
                console.log('[Watcher] ✅ Синхронизация завершена');
            } catch (e) { 
                console.error('[Watcher] ❌ Ошибка синхронизации:', e); 
            } finally {
                syncInProgress = false;
                // Если пока мы синкали, файлы снова изменились — запускаем еще раз
                if (pendingSync) { pendingSync = false; setTimeout(() => runSyncSafely('pending'), 300); }
            }
        }

        // Прослушиваем изменения директории (игнорируя служебные папки)
        fs.watch(GAMES_DIR, { persistent: true }, (eventType, filename) => {
            if (!filename || SYSTEM_DIRS.includes(filename)) return;
            
            // Используем Debounce (5 сек), чтобы не запускать синк на каждый скопированный файл
            clearTimeout(syncTimer);
            syncTimer = setTimeout(() => runSyncSafely(`fs.watch:${eventType}:${filename}`), 5000);
        });

        console.log(`[Watcher] 👀 Наблюдение за ${GAMES_DIR} включено`);
    }).catch(console.error);
}

module.exports = { app };
