// ============================================================================
// [1] ИМПОРТЫ И КОНФИГУРАЦИЯ
// ============================================================================
require('dotenv').config({ quiet: true });   // без рекламных подсказок dotenv в журнале при каждом старте
// Журнал для «О программе» — раньше всех: и то, что случилось при загрузке модулей, туда попадёт
require('./src/utils/serverLog.js').capture();

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
const { setIo, ownerOnly, redisClient, invalidateGamesList } = require('./src/utils/cache.js');
const personal = require('./src/services/personal.js');

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
const { sendErrorPage } = require('./src/utils/errorPage.js');
const { serveDbDown } = require('./src/utils/dbDown.js');
const problemReport = require('./src/services/problemReport.js');
const uploadService = require('./src/services/uploads.js');
const telegramService = require('./src/services/telegram.js');
const gameErrors = require('./src/services/gameErrors.js');
const galleryService = require('./src/services/gallery.js');
const galleryText = require('./src/services/galleryText.js');
const { analysisOn } = require('./src/services/galleryModels.js');
const sceneLangs = require('./src/services/sceneLangs.js');
const fullCheck = require('./src/services/fullcheck.js');
const { thumbnail } = require('./src/utils/thumbs.js');
const { authRouter, requireAuth, loadPerson, socketPerson, forgetLoginAttempts } = require('./src/routes/auth.js');
const sessions = require('./src/utils/sessions.js');
const access = require('./src/utils/access.js');
const usersRouter = require('./src/routes/users.js');
const accountRouter = require('./src/routes/account.js');
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
const sceneLines = require('./src/services/sceneLines.js');
const libraryScenes = require('./src/services/libraryScenes.js');
const wishlistRouter = require('./src/routes/wishlist.js');
const createTelegramRouter = require('./src/routes/telegram.js');
const createCheckRouter = require('./src/routes/check.js');
const createRecommendRouter = require('./src/routes/recommend.js');
const { createRecommend } = require('./src/services/recommend.js');
const createSettingsRouter = require('./src/routes/settings.js');
const quotaService = require('./src/services/quota.js');
const { loadSecrets } = require('./src/utils/secrets.js');
const { loadOptions } = require('./src/utils/options.js');
const { createGameApp, serveGameFile, gameKey, personKey, sessionKey, revOf, relFrom, isGameId, fixBarePercent, setTranslation } = require('./src/routes/play.js');
const { findGameFolder, getFolderSize } = require('./src/utils/archive.js');
const { GAMES_DIR, EXTRACT_TMP, SAVES_DIR, AUDIOCACHE, OLD_DIR, INBOX_DIR, TRASH_DIR, SYSTEM_DIRS, OFFLINE } = require('./src/config/index.js');
const { offlineSites } = require('./src/utils/offline.js');
const { applyTrustProxy, parseGameOrigin, isGameOrigin } = require('./src/utils/proxy.js');
const { backfillProgress, gameHooks } = require('./src/utils/saveprogress.js');
const personStores = require('./src/utils/personStores.js');
const gameAccess = require('./src/services/gameAccess.js');

// ============================================================================
// [2] ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ И ЗАВИСИМОСТЕЙ
// ============================================================================
const app = express();
const server = http.createServer(app);
// За обратным прокси: req.ip — адрес посетителя (лимиты входа и API у каждого свои), req.secure — HTTPS (кука входа)
const TRUST_PROXY = applyTrustProxy(app, process.env.TRUST_PROXY);
// CORS к веб-сокетам браузером не применяется, поэтому пускаем по той же куке,
// что и обычные запросы: чужая страница и сторонний скрипт получат 403.
const io = new Server(server, {
    // Кто подключается — определяется один раз здесь; io.on('connection') ниже кладёт сокет в комнаты его входа
    allowRequest: (req, done) => {
        if (!fromLibraryOnly(req.headers)) return done(null, false);
        socketPerson(req).then((person) => { req.person = person; done(null, !!person); }, () => done(null, false));
    },
});
// Комната на вход (выход закрывает только это устройство), на человека и «owner». У старой куки в окне входа ещё нет:
// её обменяет первый же запрос страницы, а закрытие окна отключает такие сокеты (database.js, dropDeadSockets)
io.on('connection', (socket) => {
    const person = socket.request.person;
    socket.data = { sid: person.sid || null, legacy: !!person.legacy };
    if (person.sid) socket.join(`session:${person.sid}`);
    socket.join(`user:${person.userId}`);
    if (person.userId === sessions.OWNER) socket.join('owner');
});
// События служб (проверка, поиск данных, новости списка) слышит только владелец; «список игр изменился» уходит всем
// (utils/cache.js, invalidateGamesList), а чужие записи людей — только их устройствам
const ownerIo = ownerOnly(io);

// Запросы к API и сокету — только со страниц самой библиотеки. Браузер помечает, откуда запрос
// (Sec-Fetch-Site): с сервера игр (тот же хост, другой порт, или соседнее имя за прокси) — same-site, с чужого
// сайта — cross-site. Пометку скрипт подделать не может, и её хватает: номер порта у страницы за прокси может совпасть
// с GAME_PORT. Старый браузер без пометки: смотрим Origin — с адреса игр не пускаем. Без обоих заголовков — не
// браузер (проверка совместимости, curl): у него есть вход, но нет чужого кода
function fromLibraryOnly(headers) {
    const site = headers['sec-fetch-site'];
    if (site) return site === 'same-origin' || site === 'none';
    const origin = headers.origin;
    return !origin || !ISOLATED || !isGameOrigin(origin, { gameOrigin: GAME_ORIGIN, gamePort: GAME_PORT });
}

// Внедрение зависимостей в сервисы
scraperService.setDependencies(ownerIo, GAMES_DIR, dbService);
dbService.setDependencies(ownerIo, scraperService, GAMES_DIR, gamesRouter.trash);
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
    grant: (userId, id) => gameAccess.grant(userId, id),
    // Размер новой игры — в фоне: у большой du считает минуту
    afterAdd: (folder, dest) => getFolderSize(dest)
        .then((size) => size && dbService.get().run('UPDATE games SET size = ? WHERE id = ?', [size, folder]))
        .then(() => invalidateGamesList())
        .catch((e) => console.error('[Upload] Размер игры:', e.message)),
    // «Скачать снова» у игры с полки: новая версия встаёт на её место (services/trash.js)
    isShelved: async (id) => (await dbService.get().get('SELECT shelved_at FROM games WHERE id = ?', [id]))?.shelved_at > 0,
    oldFromShelf: (id, to) => gamesRouter.trash.shelfToOld(id, to),
    // Бронь места: что ещё ляжет на этот диск помимо загрузок — JDownloader и архив, который забирают с seedbox или
    // у второй установки (он же обычно и есть загрузка JDownloader — не считаем дважды)
    inFlight: async () => {
        const out = await myjdService.inFlight();
        const names = new Set(out.flatMap((x) => x.names));
        for (const c of [seedboxService.state.current, relayService.state.current]) {
            if (c && !names.has(c.name)) out.push({ names: [c.name], size: c.total, have: c.got });
        }
        return out;
    },
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
// Поиск по репликам сцен (services/sceneLines.js): свой файл-кэш в _media; новая сборка галереи — заново, сброс — вон
sceneLines.setDependencies({ gallery: galleryService, translate: translateService });
libraryScenes.setDependencies({ gallery: galleryService });
// Новая сборка галереи — и разбор её кадров для поиска по картинкам: эту игру очередь берёт следующей
galleryService.onBuilt = (id) => { sceneLines.indexGame(id).catch((e) => console.warn(`[Реплики] ${id}: ${e.message}`)); galleryService.queuePictures([id], { first: true }); };
galleryService.onForget = (id) => { sceneLines.dropGame(id).catch((e) => console.warn(`[Реплики] ${id}: ${e.message}`)); };
// Полная проверка библиотеки — кнопкой из ревизии: ход по сокету всем открытым страницам
fullCheck.setDependencies({
    db: dbService, scraper: scraperService,
    emit: (state) => ownerIo.emit('fullcheck', state),
});
// Перевод игр: словарь и очередь (services/translate.js); сервер игр подставляет перевод в data/*.json
// Перевод игры поменялся — и реплики в поиске по репликам (sceneLines.js), через минуту
translateService.setDependencies({ dbService, gamesDir: GAMES_DIR, onChange: (id) => { invalidateGamesList(); if (id) sceneLines.touch(id); } });
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
setIo(ownerIo);

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
// Вошедшего считаем по нему самому, а не по адресу: дома все ходят с одного адреса, и один человек с десятком вкладок не
// должен занимать лимит остальных. Без входа — по адресу (для IPv6 берётся его сеть, ipKeyGenerator)
const apiLimiter = rateLimit({ 
    windowMs: 60 * 1000, 
    max: Number(process.env.API_RATE_LIMIT) || 200, 
    message: { error: 'Слишком много запросов' },
    keyGenerator: (req) => (req.person ? `p:${req.person.id}` : `ip:${rateLimit.ipKeyGenerator(req.ip)}`),
    // Картинки галереи (services/gallery.js) — десятки на экран сразу: лимит они выбрали бы за минуту
    // Снимки закладок сцен — так же
    skip: (req) => req.path.startsWith('/games/upload/') || /^\/gallery\/[^/]+\/(thumb|image|video|spine|live2d|audio|sounds|rig-cover)$/.test(req.path)
        || /^\/marks\/[^/]+\/[^/]+\/thumb$/.test(req.path) || /^\/saves\/shot\/[^/]+$/.test(req.path),
});
app.use('/api/', loadPerson);
app.use('/api/', apiLimiter);
app.use('/api/', (req, res, next) => (fromLibraryOnly(req.headers) ? next() : res.status(403).json({ error: 'Запрос не со страницы библиотеки', reason: 'foreign-origin' })));

// Создание системных директорий при старте
Promise.all([
    fsp.mkdir(EXTRACT_TMP, { recursive: true }),
    fsp.mkdir(SAVES_DIR, { recursive: true }),
    fsp.mkdir(AUDIOCACHE, { recursive: true })
]).catch(err => console.error('[Init] Ошибка создания системных папок:', err));


// ============================================================================
// [4] ФОНОВЫЕ ЗАДАЧИ (КРОН)
// ============================================================================

// Только когда база открылась: без неё они не нужны, а страница об ошибке (utils/dbDown.js) не должна ничего запускать
function startCleanups() {
    // Авто-очистка временной папки загрузок (каждый час): старше суток — долой, загрузки — через uploads.forget
    // (services/uploads.js, cleanup): архив из «Входящих» уходит в _inbox/_failed, а не стирается
    setInterval(() => {
        uploadService.cleanup(86400000).catch((e) => console.error('[Cleanup] Ошибка очистки:', e.message));
    }, 60 * 60 * 1000);

    // Корзина: что лежит дольше 30 дней — стираем (services/trash.js). Раз в шесть часов и при старте
    const purgeTrash = () => gamesRouter.trash.purge().catch((e) => console.error('[Корзина]', e.message));
    setInterval(purgeTrash, 6 * 60 * 60 * 1000);
    setTimeout(purgeTrash, 60 * 1000);
}


// ============================================================================
// [5] API РОУТЫ (ОТКРЫТЫЕ И ЗАКРЫТЫЕ)
// ============================================================================

// --- ОТКРЫТЫЕ API ---
app.use('/api', authRouter); // Логин, логаут, проверка статуса настройки
// Связанная установка: просит связать и забирает свои архивы — по ключу, без куки (services/relay.js)
app.use('/api/relay', createRelayRouter());

// --- ЗАМОК АВТОРИЗАЦИИ ---
app.use('/api', requireAuth); // Все роуты ниже этой строки требуют куки `auth_token`
// ...и права: не владельцу открыто только перечисленное (utils/access.js), остальное — 403
app.use('/api', access.gate);

// --- ЗАКРЫТЫЕ API ---
app.use('/api/games/upload', createUploadsRouter(uploadService));
app.use('/api/backup', backupRouter);
app.use('/api/users', usersRouter);
// Свои имя и картинка: после замка, чтобы человеку, не выбравшему пароль, они были закрыты (routes/account.js)
app.use('/api', accountRouter);
app.use('/api/games', gamesRouter);
app.use('/api/saves', createSavesRouter(EXTRACT_TMP));
app.use('/api/marks', marksRouter);
app.use('/api/journal', journalRouter);
if (OFFLINE) app.use('/api/itch', offlineSites);
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
        gameOrigin: GAME_ORIGIN,
        trustProxy: TRUST_PROXY,
        isolation: ISOLATED,
        offline: OFFLINE,
        gamesDir: GAMES_DIR,
        inboxDir: INBOX_DIR,
        redis: !!process.env.REDIS_URL && process.env.REDIS_URL !== 'memory',
        ocr: !!process.env.OCR_URL,
        secretsKey: process.env.SECRETS_KEY ? 'env' : 'file',
        sessionSecret: process.env.SESSION_SECRET ? 'env' : 'db',
    }),
    problemReport: (browser) => problemReport.build({
        db: dbService.get(), browser, redis: !redisClient.isMemory && !!redisClient.isReady, extraSecrets: [dbService.getSessionToken()],
    }),
    onSaved: (name) => {
        quotaService.invalidate();       // ключ сменился — сводку служб спросить заново
        if (name === 'telegram') { telegramService.tokenChanged(); telegramService.start(); }
        if (translateService.ENGINES.includes(name)) translateService.clearExhausted(name).catch(() => {});
        if (name === 'seedbox') seedboxService.pull();
        if (name === 'picture_analysis') return applyPictureAnalysis();
        if (name === 'picture_speed') galleryService.pictureSpeedChanged();
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
// Теги картинок игры (разметчик, gallery.js): ?f= — теги кадра (просмотр, кнопка «Теги»), без него — теги всей игры для
// фильтра галереи. Разметчик игру ещё не прошёл — пусто
app.get('/api/gallery/:id/tags', async (req, res) => {
    if (!isGameId(req.params.id)) return res.status(400).json({ error: 'bad-id' });
    const file = typeof req.query.f === 'string' ? req.query.f : '';
    if (file.length > 1000) return res.status(400).json({ error: 'bad-request' });
    try {
        res.json(file ? { tags: await galleryService.frameTags(req.params.id, file) } : { ...(await galleryService.gameTags(req.params.id)), hidden: await hiddenFor(req) });
    } catch (e) {
        console.error('[Теги картинок]', e.message);
        res.status(500).json({ error: 'tags-failed' });
    }
});
// «Что на картинках» в окне игры: теги, которые отличают её от остальных (gallery.js, gameInside)
app.get('/api/gallery/:id/inside', async (req, res) => {
    if (!isGameId(req.params.id)) return res.status(400).json({ error: 'bad-id' });
    try {
        res.json(await galleryService.gameInside(req.params.id, await pictureGames(req.allowed), { hide: await hiddenFor(req) }));
    } catch (e) {
        console.error('[Теги картинок]', e.message);
        res.status(500).json({ error: 'tags-failed' });
    }
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
        // Избранное человека, не владельца, — своя таблица (services/personal.js); у владельца запрос прежний
        const user = personal.other(req.person);
        const rows = user
            ? await dbService.get().all(`SELECT f.game_id AS game, f.file, f.kind, f.at, f.anim FROM user_gallery_favorites f
                JOIN games g ON g.id = f.game_id AND g.shelved_at = 0 WHERE f.user_id = ? ${game ? 'AND f.game_id = ?' : ''} ORDER BY f.at DESC, f.file`, game ? [user.id, game] : [user.id])
            : await dbService.get().all(`SELECT f.game_id AS game, f.file, f.kind, f.at, f.anim FROM gallery_favorites f
                JOIN games g ON g.id = f.game_id AND g.shelved_at = 0 ${game ? 'WHERE f.game_id = ?' : ''} ORDER BY f.at DESC, f.file`, game ? [game] : []);
        // Склейка «@cg/…» — по составу слоёв: если разбор сцен изменился, в новом оглавлении её может не быть. Такую
        // не показываем (битая плитка), но и не стираем: вернётся в оглавление — снова видно. У анимации — так же по кадрам
        const gone = async (game, file) => file.startsWith('@cg/') && (await galleryService.knows(game, file)) === false;
        const shown = [];
        for (const { anim, ...row } of gameAccess.only(req.allowed, rows, (r) => r.game)) {
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
// Скрытые теги (Настройки): их кадры и сцены не показываем там, где библиотека целиком, — в поиске по картинкам, «Похожих» и
// окне «Сцены». Галерея игры показывает всё: там человек сам выбирает, что отобрать. Всегда из базы: их приносит и восстановление
// из копии. Испорченная строка — как без скрытых
const hiddenTags = async () => {
    const row = await dbService.get().get("SELECT value FROM settings WHERE key = 'hidden_tags'").catch(() => null);
    try { const v = JSON.parse(row?.value || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
// Скрытые теги — настройка владельца: у людей их нет, и они видят всё разобранное
const hiddenFor = async (req) => (personal.other(req.person) ? [] : hiddenTags());
// Ответ поиска по картинкам: сцена, в которой есть кадр (плитка «Смотреть сцену»), — у тех, у кого она есть. Сцены
// игры читаются по разу: сначала по игре, потом кадры
const withScenes = async (rows) => {
    for (const id of new Set(rows.map((r) => r.game))) await libraryScenes.rowsOf(id).catch(() => null);
    return Promise.all(rows.map(async (r) => {
        const scene = await libraryScenes.sceneOf(r.game, r.file).catch(() => null);
        return scene ? { ...r, scene } : r;
    }));
};
const picturePage = (req) => ({
    limit: Math.min(120, Math.max(1, parseInt(req.query.limit, 10) || 60)),
    from: Math.min(1000, Math.max(0, parseInt(req.query.from, 10) || 0)),
});
// Игры для поиска по картинкам; с полки — без файлов: картинку не открыть. allowed — игры человека (null — все): отбираем здесь, до
// любых подсчётов, чтобы числа и теги в ответе были про то, что он видит
const pictureGames = async (allowed = null) => gameAccess.only(allowed, (await dbService.get().all('SELECT id FROM games WHERE shelved_at = 0')).map((g) => g.id).filter(isGameId));
// «Во что поиграть?»: подбор из своих игр и с сайтов (services/recommend.js); здесь, ниже hiddenTags и pictureGames
app.use('/api/recommend', createRecommendRouter(createRecommend({
    db: dbService, gallery: galleryService, pictureGames, hiddenTags, offline: OFFLINE, isGameId,
    sites: {},
})));
// Разбор кадров выключен: поиск и лента говорят об этом сами — новых кадров в них не будет, а модели не скачаются
const pictureOff = () => (analysisOn() ? {} : { off: true });
// Галереи и разбор кадров всей библиотеки (gallery.js, prepare и queuePictures); недавние игры первыми. Уже разобранное
// пропускается за секунды
const startPictures = async () => {
    const rows = await dbService.get().all('SELECT id FROM games WHERE shelved_at = 0 ORDER BY lastPlayed DESC, addedAt DESC');
    const ids = rows.map((r) => r.id).filter(isGameId);
    // Игры без готовой галереи (новая версия оглавления, сборку прервали) — тоже заранее
    galleryService.prepare(ids);
    galleryService.queuePictures(ids);
};
// Переключатель в «Настройках»: действует сразу, без перезапуска
const applyPictureAnalysis = async () => {
    if (analysisOn()) {
        galleryService.retryPictures();
        galleryText.failedAt = 0;
        await startPictures();
    } else {
        galleryService.stopPictures();
        galleryText.hold.unload();
    }
};
// Поиск картинок по словам (русский, английский, немецкий) во всех играх библиотеки: запрос — вектором в пространстве
// CLIP (galleryText.js) и тегами разметчика (galleryTags.js), сравнение — с кадрами, которые разбор уже посчитал
// (gallery.js, searchPictures). Игры, которых разбор ещё не касался, в поиске не участвуют: games — сколько игр искали.
// from — с какой картинки («Ещё»), more — есть ли дальше. understood — как поиск понял запрос (английскими словами),
// unknown — слова, которых словарь не знает: их модель понимает плохо
app.get('/api/pictures/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length > 100) return res.status(400).json({ error: 'bad-query' });
    const { limit, from } = picturePage(req);
    // Модели слов ещё нет или она открывается — отвечаем сразу, а не через минуты скачивания: окно покажет, сколько
    // скачано, и спросит снова (preparing). Выключено или не вышло — unavailable
    const ready = galleryText.prepare();
    if (ready.state !== 'ready') return res.status(503).json({ error: ready.state === 'off' ? 'unavailable' : 'preparing', ...(ready.state === 'off' ? pictureOff() : {}), ...(ready.total ? { done: ready.done, total: ready.total } : {}) });
    try {
        const vec = await galleryText.embed(q);
        if (!vec) return res.status(503).json({ error: 'unavailable', ...pictureOff() });
        const english = galleryText.toEnglish(q);
        const ids = await pictureGames(req.allowed);
        // Про детей не ищем — пустой ответ, как «ничего не нашлось»
        if (galleryService.tags.blockedQuery(q, english)) return res.json({ games: ids.length, results: [], more: false });
        const groups = galleryService.tags.concepts(english, await galleryService.tags.list().catch(() => null));
        const { rows, games, more } = await galleryService.searchPictures(vec, ids, limit, { from, groups, hide: await hiddenFor(req) });
        const unknown = [...new Set((english.match(/\p{L}+/gu) || []).filter((w) => /[^\u0000-\u007f]/.test(w)))];
        res.json({ games, results: await withScenes(rows), more, ...(english !== q ? { understood: english } : {}), ...(unknown.length ? { unknown } : {}), ...pictureOff() });
    } catch (e) {
        // Что именно сломалось — в журнал, а не человеку: текст ошибки может содержать пути на диске
        console.error('[Поиск картинок]', e.message);
        res.status(500).json({ error: 'search-failed' });
    }
});
// «Похожие»: картинки всей библиотеки, похожие на этот кадр (game, f), — по вектору CLIP; сама картинка и её копии —
// не в счёт. Кадр, который разбор ещё не прошёл, считается сразу. v — вместо кадра вектор своей картинки (/api/pictures/by-image)
app.get('/api/pictures/similar', async (req, res) => {
    const game = typeof req.query.game === 'string' ? req.query.game : '';
    const file = typeof req.query.f === 'string' ? req.query.f : '';
    const own = req.query.v !== undefined ? galleryService.uploadedVector(req.query.v) : null;
    if (req.query.v !== undefined ? !own : !isGameId(game) || !file || file.length > 1000) return res.status(400).json({ error: 'bad-request' });
    const { limit, from } = picturePage(req);
    try {
        const vec = own || await galleryService.frameVector(game, file);
        if (!vec) {
            // Кадр на месте, а считать его нечем: разбор выключен, модель не скачана. Это не «кадра больше нет»
            if (!analysisOn() && await galleryService.knows(game, file) !== false) return res.status(503).json({ error: 'unavailable', off: true });
            return res.status(404).json({ error: 'not-found' });
        }
        const { rows, games, more } = await galleryService.searchPictures(vec, await pictureGames(req.allowed), limit, { from, ...(own ? {} : { exclude: { game, file } }), hide: await hiddenFor(req) });
        res.json({ games, results: await withScenes(rows), more, ...pictureOff() });
    } catch (e) {
        console.error('[Похожие картинки]', e.message);
        res.status(500).json({ error: 'search-failed' });
    }
});
// Поиск по своей картинке: тело — сам файл (PNG, JPEG, WebP, GIF, до 25 МБ; ffmpeg выбирает разбор по содержимому, поэтому
// чужое до него не доходит) → { v } — её вектор для /api/pictures/similar. Картинка нигде не остаётся
const isPicture = (b) => b.length > 12 && (b.subarray(0, 4).toString('hex') === '89504e47' || b.subarray(0, 3).toString('hex') === 'ffd8ff'
    || b.subarray(0, 4).toString('latin1') === 'GIF8' || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'));
app.post('/api/pictures/by-image', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !isPicture(req.body)) return res.status(400).json({ error: 'bad-image' });
    let v;
    try {
        v = await galleryService.imageVector(req.body);
    } catch (e) {
        console.warn('[Поиск по своей картинке]', e.message);
        return res.status(422).json({ error: 'bad-image' });
    }
    if (!v) return res.status(503).json({ error: 'unavailable', ...pictureOff() });
    res.json({ v });
});
app.use('/api/pictures/by-image', (err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too-large' });
    next(err);
});
// Теги кадров всей библиотеки — фильтр игр («Теги картинок» в библиотеке), сводкой (gallery.js, libraryTags)
app.get('/api/pictures/games', async (req, res) => {
    try {
        res.json(await galleryService.libraryTags(await pictureGames(req.allowed), { hide: await hiddenFor(req) }));
    } catch (e) {
        console.error('[Теги картинок]', e.message);
        res.status(500).json({ error: 'tags-failed' });
    }
});
// Лента картинок: игры главами, в каждой несколько разных рисунков (gallery.js, feedGames); порядок игр — на стороне окна
app.get('/api/pictures/feed', async (req, res) => {
    try {
        const games = await galleryService.feedGames(await pictureGames(req.allowed), { hide: await hiddenFor(req) });
        const rows = await withScenes(games.flatMap((g) => g.frames.map((f) => ({ ...f, game: g.id }))));
        res.json({ games: games.map((g) => ({ id: g.id, frames: rows.filter((r) => r.game === g.id).map(({ game, ...r }) => r) })), ...pictureOff() });
    } catch (e) {
        console.error('[Лента картинок]', e.message);
        res.status(500).json({ error: 'feed-failed' });
    }
});
app.get('/api/pictures/hidden', async (req, res) => res.json({ tags: await hiddenTags() }));
// add — только теги, которые вообще можно показывать (не служебные и не про детей)
app.post('/api/pictures/hidden', express.json(), async (req, res) => {
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x && x.length <= 100) : []);
    const remove = new Set(list(req.body?.remove));
    try {
        const tags = [...new Set([...await hiddenTags(), ...list(req.body?.add).filter((x) => galleryService.tags.shown(x))])].filter((x) => !remove.has(x)).slice(0, 200);
        await dbService.get().run("INSERT OR REPLACE INTO settings (key, value) VALUES ('hidden_tags', ?)", [JSON.stringify(tags)]);
        res.json({ tags });
    } catch (e) {
        console.error('[Скрытые теги]', e.message);
        res.status(500).json({ error: 'hidden-failed' });
    }
});
// Есть ли у человека избранное среди открытых ему игр. Те же таблицы, что в GET /api/favorites, но без разбора файлов: нужен только ответ да или нет
const hasFavorites = async (req) => {
    const user = personal.other(req.person);
    const rows = user
        ? await dbService.get().all('SELECT DISTINCT f.game_id AS game FROM user_gallery_favorites f JOIN games g ON g.id = f.game_id AND g.shelved_at = 0 WHERE f.user_id = ?', [user.id])
        : await dbService.get().all('SELECT DISTINCT f.game_id AS game FROM gallery_favorites f JOIN games g ON g.id = f.game_id AND g.shelved_at = 0');
    return gameAccess.only(req.allowed, rows, (r) => r.game).length > 0;
};
// Окно поиска по картинкам открылось — пусть модель слов начинает готовиться, пока человек печатает (galleryText.prepare).
// pass — сколько кадров библиотеки уже разобрано, пока разбор идёт (gallery.js, pictureStatus); analysis — строка «Разбор
// картинок» в «Настройках». peek=1 — только спросить, модель не трогать: она нужна, когда окно открыто, а не при каждом опросе
app.get('/api/pictures/status', async (req, res) => {
    const ready = galleryText.prepare({ start: req.query.peek !== '1' });
    // Сколько кадров разобрано — число про всю библиотеку, вместе со скрытыми играми: человеку с ограниченным списком оно не отдаётся
    const pass = req.allowed ? null : galleryService.pictureStatus();
    const analysis = await galleryService.analysisStatus();
    if (req.allowed) delete analysis.frames;
    // tagged=1 — есть ли разобранные игры и избранное у этого человека (кнопка «Что на картинках» в библиотеке, пункты меню): только да или нет и только
    // про его игры. По запросу: опросы хода разбора идут часто, а тут обход игр
    const tagged = req.query.tagged === '1' ? { tagged: await galleryService.anyTagged(await pictureGames(req.allowed)), faved: await hasFavorites(req) } : {};
    res.json({ state: ready.state, ...(ready.total ? { done: ready.done, total: ready.total } : {}), ...(pass ? { pass } : {}), analysis, ...tagged });
});
// Поиск по репликам сцен во всех играх библиотеки (services/sceneLines.js): q — слова (1–100 знаков), game — только эта
// игра («Ещё N сцен»), limit — сцен в ответе (1–60). Короткий запрос («он») — 400 short: такой нашёл бы полбиблиотеки
app.get('/api/lines/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length > 100) return res.status(400).json({ error: 'bad-query' });
    const game = req.query.game === undefined ? '' : String(req.query.game);
    if (req.query.game !== undefined && (typeof req.query.game !== 'string' || !isGameId(game))) return res.status(400).json({ error: 'bad-game' });
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 24));
    if (!sceneLines.parseQuery(q)) return res.status(400).json({ error: 'short' });
    try {
        const ids = await pictureGames(req.allowed);
        const out = await sceneLines.search(q, { ids, game, limit });
        if (!out) return res.status(503).json({ error: 'unavailable' });
        res.json(out);
    } catch (e) {
        // Что именно сломалось — в журнал, а не человеку: текст ошибки может содержать пути на диске
        console.error('[Поиск реплик]', e.message);
        res.status(500).json({ error: 'search-failed' });
    }
});
// Все сцены библиотеки (services/libraryScenes.js) — окно «Сцены» без запроса. kind — scenes | dialogue, voice=1 и anim=1 —
// только с голосом и анимацией; per — первых сцен на игру (1–12), game — все сцены этой игры («Ещё N сцен»);
// queue=order | random — очередь для «Смотреть подряд» (порциями, from — с какой сцены) и «Вперемешку». Игры — недавние
// первыми, без полки
app.get('/api/scenes', async (req, res) => {
    const kind = ['scenes', 'dialogue'].includes(req.query.kind) ? req.query.kind : '';
    const game = typeof req.query.game === 'string' ? req.query.game : '';
    if (game && !isGameId(game)) return res.status(400).json({ error: 'bad-game' });
    // tag — теги, которые должны быть, no — которых быть не должно (панель «Теги»), скрытые теги — всегда
    const names = (v) => [].concat(v || []).filter((x) => typeof x === 'string' && x.length <= 100).slice(0, 20);
    const filter = { kind, voice: req.query.voice === '1', anim: req.query.anim === '1', tags: names(req.query.tag), not: names(req.query.no), hide: [] };
    try {
        filter.hide = await hiddenFor(req);
        // Порядок «недавние первыми» — по lastPlayed владельца; человеку он выдал бы, во что тот играл. Ему — по дате добавления
        const order = personal.other(req.person) ? 'addedAt DESC' : 'lastPlayed DESC, addedAt DESC';
        const ids = gameAccess.only(req.allowed, (await dbService.get().all(`SELECT id FROM games WHERE shelved_at = 0 ORDER BY ${order}`)).map((g) => g.id).filter(isGameId));
        if (req.query.queue === 'order' || req.query.queue === 'random') {
            return res.json(await libraryScenes.queue(ids, { ...filter, random: req.query.queue === 'random', from: Math.max(0, parseInt(req.query.from, 10) || 0) }));
        }
        const per = Math.min(12, Math.max(1, parseInt(req.query.per, 10) || 4));
        res.json({ ...(await libraryScenes.list(ids, { ...filter, game, per, evict: !req.allowed })), hidden: filter.hide });
    } catch (e) {
        // Что именно сломалось — в журнал, а не человеку: текст ошибки может содержать пути на диске
        console.error('[Сцены]', e.message);
        res.status(500).json({ error: 'scenes-failed' });
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
        const user = personal.other(req.person);
        if (user) {
            await dbService.get().run(`INSERT INTO user_gallery_favorites (user_id, game_id, file, kind, at, anim) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, game_id, file) DO UPDATE SET kind = excluded.kind, anim = excluded.anim WHERE excluded.anim <> '' OR anim = ''`,
            [user.id, game, file, FAVORITE_KINDS.includes(kind) ? kind : '', Date.now(), anim]);
            return res.json({ success: true });
        }
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
        const user = personal.other(req.person);
        if (user) await dbService.get().run('DELETE FROM user_gallery_favorites WHERE user_id = ? AND game_id = ? AND file = ?', [user.id, game, f]);
        else await dbService.get().run('DELETE FROM gallery_favorites WHERE game_id = ? AND file = ?', [game, f]);
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
// Кто в сценах (gallery.js, cast): ряд имён над «Сценами» и «Диалогами» и кто в каждой плитке. Нет сценариев — {}
app.get('/api/gallery/:id/cast', async (req, res) => {
    if (!isGameId(req.params.id) || !fs.existsSync(path.join(GAMES_DIR, req.params.id))) return res.status(404).json({ error: 'Игра не найдена' });
    try {
        const table = await galleryService.cast(req.params.id);
        res.json(table ? { scenes: table.scenes, dialogue: table.dialogue } : {});
    } catch (e) { res.status(500).json({ error: e.message }); }
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
        const used = cachedStorage?.used ?? ((await dbService.get().get('SELECT SUM(size) AS s FROM games WHERE shelved_at = 0'))?.s || 0);
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
// Полный адрес сервера игр, если он не «тот же хост, другой порт»: за прокси с HTTPS у игр своё имя или свой порт с TLS
const GAME_ORIGIN = parseGameOrigin(process.env.GAME_ORIGIN);

// Старт игры: адрес для страницы. В рамке — сервер игр с ключом этой игры, по-старому — папка игры.
// check — куда страница спросит сервер игр, прежде чем открыть рамку (routes/play.js, /ready)
app.post('/api/play/:id', async (req, res) => {
    const id = req.params.id;
    if (!isGameId(id) || !(await fsp.stat(path.join(GAMES_DIR, id)).then((st) => st.isDirectory(), () => false))) {
        return res.status(404).json({ error: 'Игра не найдена' });
    }
    if (!ISOLATED) return res.json({ mode: 'page', path: `/${encodeURIComponent(id)}/` });
    // Владельцу — один адрес на игру, человеку — свой (routes/play.js, personKey): доступ к нему сервер игр проверяет на каждом файле
    const rev = await revOf(id);
    const key = req.person.isOwner ? gameKey(dbService.getSessionToken(), id, rev) : personKey(dbService.getSessionToken(), req.person.id, id, rev);
    // session — ключ записи для этого входа (routes/play.js, sessionKey): страница добавляет его к адресу игры как ?s=
    res.json({ mode: 'frame', port: GAME_PORT, origin: GAME_ORIGIN, path: `/g/${key}/${encodeURIComponent(id)}/`, check: `/ready/${key}/${encodeURIComponent(id)}`, session: sessionKey(dbService.getSessionToken(), req.person.sid, id) });
});

// Картинки из папок — обложки и снимки (_media/…, старые обложки в папке игры). Остальное из папок
// игр адрес библиотеки не отдаёт: код игры здесь не должен запускаться. Старая ссылка на игру
// (закладка) — в библиотеку, она откроет игру сама
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
// Корзина, прежние версии, «Входящие» и недогруженные архивы: в них лежат целые игры и чужие загрузки. Экраны человека
// картинок оттуда не берут — обложки и снимки (в том числе у игры на полке, её обложку «На полку» копирует в _media) лежат в
// _media и папках игр, — поэтому не владельцу этот путь закрыт. Имена и по умолчанию, и из .env: их можно переставить
const OWNER_ONLY_DIRS = [...new Set([TRASH_DIR, OLD_DIR, INBOX_DIR, EXTRACT_TMP, ...['_trash', '_old', '_inbox', '_tmp_uploads'].map((n) => path.join(GAMES_DIR, n))].map((d) => path.resolve(d)))];
// Какую игру называет путь — по нормализованному, как его увидит диск: «/x/../Игра/a.png» и «/_media/Игра/…» называют ту же игру,
// хотя первый сегмент сырого пути другой
const gameOfPath = (rel) => {
    const parts = path.relative(GAMES_DIR, path.resolve(GAMES_DIR, rel)).split(path.sep);
    return parts[0] === '_media' ? parts[1] : parts[0];
};
app.get('*', requireAuth, async (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/') return next();
    const rel = relFrom(req.path);
    if (rel === null) return sendErrorPage(req, res, 400, 'address');
    const first = rel.split('/')[0];
    // Игра, которой у человека нет, отвечает как несуществующая: ни файла, ни миниатюры, ни перехода в библиотеку
    const allowed = await gameAccess.allowedIds(req.person);
    const closed = !!allowed && !allowed.has(gameOfPath(rel));
    // Файлы игры отдаём, только если путь — внутри папки самой игры: без «..» и с первым сегментом, который есть папка игры.
    // Иначе в режиме без отдельного сервера игр отдавалось бы всё в GAMES_DIR (library.db, сейвы). Обложки из _media и
    // остальное идёт дальше, на проверку картинок
    const inGame = !closed && !rel.split(/[\\/]/).includes('..') && isGameId(first) && fs.statSync(path.join(GAMES_DIR, first), { throwIfNoEntry: false })?.isDirectory();
    if (!ISOLATED && inGame) {
        // Перевод включён — rpg-fixes переносит длинные строки (как и на сервере игр)
        const tl = await translateService.langOf(first).catch(() => '');
        return serveGameFile(req, res, next, { rel, prefix: '', inject: { id: first, saves: '/api/saves', errors: '/api/errors', ...(tl ? { tl } : {}), ...(req.person && !req.person.isOwner ? { who: req.person.id } : {}) } });
    }
    if (IMAGE_FILE.test(rel)) {
        const file = path.resolve(GAMES_DIR, rel);
        if (!file.startsWith(path.resolve(GAMES_DIR) + path.sep)) return res.status(403).end();
        // Сейвы лежат внутри GAMES_DIR, а «/любая/../_saves/…png» после resolve указывает на них: снимки сейвов и моменты
        // отдаёт только /api/saves (по входу и по своей игре)
        const saves = path.resolve(SAVES_DIR);
        if (file === saves || file.startsWith(saves + path.sep)) return res.status(403).end();
        if (!req.person.isOwner && OWNER_ONLY_DIRS.some((dir) => file === dir || file.startsWith(dir + path.sep))) return res.status(403).end();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (closed) return res.status(404).end();
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
    if (!closed && isGameId(first) && fs.existsSync(path.join(GAMES_DIR, first))) return res.redirect(`/?play=${encodeURIComponent(first)}`);
    next();
});


// ============================================================================
// [7] ЗАПУСК СЕРВЕРА И ФАЙЛОВЫЙ ВОТЧЕР
// ============================================================================

if (require.main === module) {
    // Всё, что читает базу до запуска служб. Сбой в любом из этих шагов — та же беда: порт ещё не открыт, и человек
    // видел бы «сайт недоступен». Повреждённая не целиком база, например, открывается и падает только на первом SELECT
    const openLibrary = async () => {
        await dbService.init(GAMES_DIR);
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
    };
    openLibrary().then(async () => {
        startCleanups();
        // Пароль, сброшенный из консоли (scripts/reset-password.js): ключ сессии и счётчик попыток входа живут здесь, в памяти
        const followAccount = () => dbService.followAccount().then((changed) => { if (changed) forgetLoginAttempts(); }).catch(() => {});
        followAccount();
        setInterval(followAccount, 5000).unref();
        // Загрузки, чья распаковка оборвалась перезапуском, — доделать
        uploadService.recover().catch((e) => console.error('[Upload]', e.message));
        // «Входящие»: архивы, положенные в папку (JDownloader и т. п.), — в библиотеку сами
        // «Загрузить» у игры из библиотеки — скачанный архив встаёт её обновлением
        inboxService.setDependencies({ dir: INBOX_DIR, uploads: uploadService, targetOf: (name) => myjdService.targetFor(name), volumesOf: (name) => myjdService.volumesOf(name) });
        inboxService.start();
        startNearby();
        // Seedbox: готовые архивы с удалённого сервера — во «Входящие» (если настроен в «Настройках»)
        // Места на диске нет — архив ждёт на seedbox или у второй установки, а не качается до конца диска
        const forced = (name) => myjdService.forced(name);
        seedboxService.setDependencies({ dir: INBOX_DIR, uploads: uploadService, forced });
        seedboxService.start();
        relayService.setDependencies({ dir: INBOX_DIR, db: dbService, uploads: uploadService, forced });
        relayService.start();
        // Галереи и разбор кадров для поиска по картинкам — через пару минут, когда сервер поднялся
        setTimeout(() => { startPictures().catch((e) => console.warn('[Галерея] разбор картинок:', e.message)); }, 2 * 60 * 1000);

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
                sessions: { find: sessions.findById, legacyOpen: () => dbService.legacyOpen() },
                store: createSavesRouter.store,
                marks: marksRouter.store,
                journal: journalRouter.store,
                storesFor: (userId) => personStores.storesFor({ id: userId }),
                mayOpen: (userId, id) => gameAccess.may({ id: userId }, id),
                publicDir: path.join(__dirname, 'public'),
                onError: (id, body, ua) => gameErrors.record(id, body, ua),
                // Третий аргумент хуков — кто играл: время и прогресс человека идут в его user_games, не в games владельца
                ...gameHooks,
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
        // Игры с полки — без файлов: ни оглавления, ни реплик, ни сверки с облаком
        galleryService.start(async () => (await dbService.get().all('SELECT id FROM games WHERE ready = 1 AND shelved_at = 0 ORDER BY lastPlayed DESC')).map((r) => r.id));
        // Индекс реплик: первый проход через 2 минуты после старта, дальше раз в час — изменившиеся игры заново
        sceneLines.start(async () => (await dbService.get().all('SELECT id FROM games WHERE shelved_at = 0 ORDER BY lastPlayed DESC')).map((r) => r.id).filter(isGameId));

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
                    ownerIo.emit('scrape-success', diff > 0 ? { kind: 'synced', count: diff, message: `Добавлено готовых игр: ${diff}` } : { kind: 'refreshed', message: 'Библиотека обновлена' });
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
    }, (e) => serveDbDown(e, {
        dir: GAMES_DIR,
        port: process.env.PORT || 3000,
        // Кэшу тут делать нечего, а недоступный Redis писал бы в журнал о каждой попытке соединения
        stopRedis: () => redisClient.disconnect?.(),
    })).catch(console.error);
}

module.exports = { app, io, server };
