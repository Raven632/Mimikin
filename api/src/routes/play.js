const express = require('express');
const compression = require('compression');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const audioService = require('../services/audio.js');
const { findGameFolder } = require('../utils/archive.js');
const { isSafeSegment } = require('../utils/validate.js');
const { GAMES_DIR, SYSTEM_DIRS } = require('../config/index.js');

// Игры — на своём адресе (порт GAME_PORT), отдельно от библиотеки. Код игры — чужой: её скачали с
// форума или с сайта репаков. На адресе библиотеки он работал бы с вашим входом и мог бы позвать
// её API — скачать базу, удалить игры. Так же itch.io запускает игры с отдельного домена. Здесь у
// игры нет ни входа библиотеки, ни её API: только свои файлы и свои сейвы, по ключу в адресе
// (/g/<ключ>/<игра>/…). Ключ — подпись имени игры ключом сессии: выход из библиотеки меняет и его.
// Библиотека открывает игру в рамке на весь экран (frontend GameFrame) и отвечает на её сообщения
// только с этого адреса.
//
// Заодно игре закрыта связь с чужими сайтами (Content-Security-Policy): игры работают без сети, а
// собирать и отправлять куда-то данные ей незачем. Что заблокировано — в журнал ([CSP])

// rev — «ревизия» папки игры (номер папки на диске, revOf): обновление, патч или возврат прежней
// версии кладут на место другую папку, и у файлов игры меняется адрес. Поэтому файлы можно
// кэшировать надолго: старый кэш после обновления просто не пригодится
function gameKey(secret, id, rev = '') {
    return crypto.createHmac('sha256', String(secret)).update(`play\n${id}${rev ? `\n${rev}` : ''}`).digest('hex').slice(0, 32);
}

// Перевод игры (services/translate.js): включённый язык и подстановка перевода в data/*.json. Задаёт
// server.js; без него — игры как есть
let translation = { langOf: async () => '', overlay: async () => null, langs: [] };
function setTranslation(t) { translation = t; }

// Включённый перевод — тоже часть «ревизии»: у переведённой игры другой адрес, и браузер не возьмёт из
// кэша оригинальные файлы (и наоборот). Сам перевод, пока игра идёт, адрес не меняет
async function revOf(id) {
    let rev;
    try { rev = String((await fsp.stat(path.join(GAMES_DIR, id))).ino); } catch { return ''; }
    const lang = await translation.langOf(id).catch(() => '');
    return lang ? `${rev}:tl-${lang}` : rev;
}

// Какие ключи ещё подходят к игре: той же папки, с любым языком перевода или без. Перевод включили или
// выключили, пока игра открыта, — её адрес по-прежнему годится: иначе следующие файлы и, главное,
// сохранения получали бы 403, и прогресс пропал бы молча. Данные она с этого момента получает уже по
// нынешнему языку. Новый запуск — уже с новым адресом (кэш браузера не смешает оригинал и перевод)
async function revsOf(id) {
    let rev;
    try { rev = String((await fsp.stat(path.join(GAMES_DIR, id))).ino); } catch { return ['']; }
    return [rev, ...(translation.langs || []).map((l) => `${rev}:tl-${l}`)];
}

function keyMatches(secret, id, key, rev = '') {
    const want = Buffer.from(gameKey(secret, id, rev));
    const got = Buffer.from(String(key || ''));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const CSP = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline' data: blob:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' data: blob:",
    "frame-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'report-uri /csp-report',
].join('; ');

// Версия rpg-fixes.js для адреса — время изменения его или чит-меню, что позже (проверяем не чаще раза в 10 секунд).
// Чит-меню rpg-fixes грузит с той же версией: без неё браузер сутки держал старое cheats.js после обновления
const FIXES = path.join(__dirname, '..', '..', 'public', 'rpg-fixes.js');
const CHEATS = path.join(__dirname, '..', '..', 'public', 'cheats.js');
let fixesSeen = { at: 0, v: '' };
async function fixesVersion() {
    if (Date.now() - fixesSeen.at > 10e3) {
        const [st, ch] = await Promise.all([fsp.stat(FIXES).catch(() => null), fsp.stat(CHEATS).catch(() => null)]);
        fixesSeen = { at: Date.now(), v: st ? String(Math.round(Math.max(st.mtimeMs, ch ? ch.mtimeMs : 0))) : String(Date.now()) };
    }
    return fixesSeen.v;
}

// Содержимое папок для подбора регистра — на минуту: игра просит сотни файлов из одних и тех же папок
const dirCache = new Map();
async function listDir(dir) {
    const hit = dirCache.get(dir);
    if (hit && Date.now() - hit.at < 60e3) return hit.names;
    let names = null;
    try { names = await fsp.readdir(dir); } catch { names = null; }
    if (dirCache.size > 2000) dirCache.clear();
    dirCache.set(dir, { names, at: Date.now() });
    return names;
}

// Путь rel внутри root с подобранным регистром каждой части: «audio/se/Cursor2.ogg» → «Audio/se/Cursor2.ogg».
// Не нашлась часть — дальше как есть (файла нет, ответит 404)
async function fixCase(root, rel) {
    let cur = root;
    const parts = String(rel).split(/[\\/]+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        const exact = path.join(cur, parts[i]);
        if (fs.existsSync(exact)) { cur = exact; continue; }
        const low = parts[i].toLowerCase();
        const match = (await listDir(cur))?.find((n) => n.toLowerCase() === low);
        if (!match) return path.join(cur, ...parts.slice(i));
        cur = path.join(cur, match);
    }
    return cur;
}

// Путь внутри GAMES_DIR → адрес для перехода, с приставкой (/g/<ключ> или пусто)
const toUrl = (prefix, rel) => `${prefix}/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`;

// Отдать файл игры. rel — путь от GAMES_DIR («Игра/www/js/main.js»), prefix — приставка адреса для
// переходов, inject — что вставить в index.html перед rpg-fixes.js (window.__RPG)
// cache — адрес файла меняется вместе с папкой игры (сервер игр, gameKey с rev): файлы можно держать
// в кэше браузера год и не переспрашивать. Без этого каждый запуск — сотни проверок «не изменился ли»
async function serveGameFile(req, res, next, { rel, prefix, inject, cache = false }) {
    const LONG = 'private, max-age=31536000, immutable';
    // Перевод только для экрана (rpg-fixes берёт его рядом со страницей игры): строки, которые в файлах
    // не меняются. Файла на диске нет — его собирает сервер, когда перевод включён
    if (path.basename(rel) === 'mimikin-tl.json' && translation.displayDict) {
        const gameId = rel.split(/[\\/]/)[0];
        const dict = await translation.displayDict(gameId).catch(() => null);
        if (!dict) return res.status(404).json({});
        res.setHeader('Cache-Control', 'no-cache');
        return res.json(dict);
    }
    // Заплатка, стирающая подпись на картинке (services/pictures.js): «mimikin-tl/patch/<хэш>.png» рядом со страницей
    const patch = /(?:^|[\\/])mimikin-tl[\\/]patch[\\/]([0-9a-f]{40})\.png$/.exec(rel);
    if (patch && translation.patch) {
        const png = await translation.patch(patch[1]).catch(() => null);
        if (!png) return res.status(404).end();
        res.setHeader('Cache-Control', LONG);
        return res.type('png').send(png);
    }
    let reqPath = rel;
    let filePath = path.join(GAMES_DIR, reqPath);

    // 1. Защита от выхода за пределы папки (Path Traversal)
    const normalizedGamesDir = path.resolve(GAMES_DIR);
    const normalizedFilePath = path.resolve(filePath);
    if (normalizedFilePath !== normalizedGamesDir && !normalizedFilePath.startsWith(normalizedGamesDir + path.sep)) {
        return res.status(403).send('Доступ запрещен');
    }

    try {
        // 2. Регистр букв в пути: игры собирают под Windows, где «Audio» и «audio» — одна папка, а
        //    движок просит «audio/se/…», «fonts/…». Подбираем каждую часть пути, не только имя файла:
        //    иначе у игры с папками «Audio», «Fonts» не было ни звуков, ни шрифта, и она вставала
        if (!fs.existsSync(filePath)) {
            const fixed = await fixCase(GAMES_DIR, reqPath);
            if (fixed !== filePath && path.resolve(fixed).startsWith(normalizedGamesDir + path.sep)) {
                filePath = fixed;
                reqPath = path.relative(GAMES_DIR, filePath);
            }
        }

        let stat;
        try { stat = await fsp.stat(filePath); } catch(e) {}

        // 3. Если запрошена директория - ищем исполняемый файл (index.html)
        if (stat && stat.isDirectory()) {
            // Строку запроса при переходе в папку игры не теряем: в ней язык меню (?lang=), адрес
            // библиотеки (?lib=) и отладочные ?fps, ?dev
            const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            if (!req.path.endsWith('/')) return res.redirect(req.path + '/' + query);

            if (fs.existsSync(path.join(filePath, 'index.html'))) {
                filePath = path.join(filePath, 'index.html');
            } else if (fs.existsSync(path.join(filePath, 'www', 'index.html'))) {
                return res.redirect(req.path + 'www/' + query);
            } else {
                const deepDir = await findGameFolder(filePath);
                if (deepDir) return res.redirect(toUrl(prefix, path.relative(GAMES_DIR, deepDir)) + '/' + query);
                return res.status(404).send(`<div style="color:red; text-align:center; padding:50px;">index.html не найден.</div>`);
            }
        }

        // 4. Звук: отдаём тот формат, который попросили
        // Формат выбирает браузер: rpg-fixes проверяет, умеет ли он Ogg. .ogg — всегда
        // настоящий Ogg (MZ на старых iOS разбирает его своим декодером). .m4a просит только
        // браузер без Ogg — если готового m4a в игре нет, перекодируем (FFmpeg, с кэшем).
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.m4a' || ext === '.ogg') {
            const base = filePath.slice(0, -4);
            // Для m4a первыми — готовые (.rpgmvm — тот же m4a, зашифрованный): их не надо перекодировать
            const pathsToTry = ext === '.m4a'
                ? [filePath, base + '.rpgmvm', base + '.ogg', base + '.rpgmvo']
                : [filePath, base + '.m4a', filePath + '_', base + '.rpgmvm', base + '.rpgmvo'];

            let sourcePath = null;
            for (const p of pathsToTry) {
                try { await fsp.access(p); sourcePath = p; break; } catch {}
            }
            // Папка игры — та, где лежит audio/: в ней data/System.json с ключом шифрования.
            // Так находится и игра в www/, и во вложенной папке
            const parts = sourcePath ? path.relative(GAMES_DIR, sourcePath).split(path.sep) : [];
            const audioAt = parts.indexOf('audio');
            const gameRoot = path.join(GAMES_DIR, ...(audioAt > 0 ? parts.slice(0, audioAt) : parts.slice(0, 1)));

            if (sourcePath && sourcePath !== filePath && ext === '.m4a') {
                try {
                    const readyPath = await audioService.ensureM4aFromSource(sourcePath, gameRoot);
                    res.type('audio/mp4');
                    res.setHeader('Cache-Control', cache ? LONG : 'public, max-age=86400');
                    return res.sendFile(readyPath, { cacheControl: false });
                } catch (err) { filePath = sourcePath; }
            } else if (sourcePath && sourcePath !== filePath && /\.(rpgmvo|rpgmvm|ogg_)$/i.test(sourcePath)) {
                // Просили обычный .ogg, а в игре только зашифрованный — отдаём расшифрованным
                try {
                    const data = await audioService.decryptRpgmvo(sourcePath, gameRoot);
                    res.type(sourcePath.endsWith('.rpgmvm') ? 'audio/mp4' : 'audio/ogg');
                    res.setHeader('Cache-Control', cache ? LONG : 'public, max-age=86400');
                    return res.send(data);
                } catch (err) { filePath = sourcePath; }
            } else if (sourcePath) {
                filePath = sourcePath;
            }
        }

        // Ролики: в сборках для Windows они только .webm, а MV на телефоне просит .mp4.
        // Если файла в нужном формате нет, отдаём другой: браузер разберёт его по содержимому
        if (ext === '.webm' || ext === '.mp4') {
            try { await fsp.access(filePath); } catch {
                const other = filePath.slice(0, -ext.length) + (ext === '.webm' ? '.mp4' : '.webm');
                try { await fsp.access(other); filePath = other; } catch {}
            }
        }

        // 5. Инъекция патчей в HTML и JS файлы игр
        let finalStat;
        try { finalStat = await fsp.stat(filePath); } catch(e) {}

        if (finalStat && finalStat.isFile()) {
            // index.html: убираем CSP самой игры и вставляем наш скрипт-эмулятор rpg-fixes.js,
            // а перед ним — что игре знать о себе (window.__RPG)
            if (filePath.endsWith('index.html')) {
                let html = await fsp.readFile(filePath, 'utf8');
                html = html.replace(/<meta[^>]+http-equiv=['"]?Content-Security-Policy['"]?[^>]*>/gi, '');
                const config = inject ? `<script>window.__RPG=${JSON.stringify(inject).replace(/</g, '\\u003c')}</script>` : '';
                // Версия rpg-fixes — время его файла: новый выкачается, прежний берётся из кэша
                html = html.replace(/(<body[^>]*>)/i, `$1${config}<script src="/rpg-fixes.js?v=${await fixesVersion()}"></script>`);
                res.setHeader('Content-Type', 'text/html');
                res.setHeader('Cache-Control', 'no-store');
                return res.send(html);
            }

            // js/plugins.js при включённом переводе — с переводом подписей и подсказок из параметров плагинов
            if (path.basename(filePath) === 'plugins.js' && path.basename(path.dirname(filePath)).toLowerCase() === 'js' && translation.overlayPlugins) {
                const gameId = reqPath.split(/[\\/]/)[0];
                const lang = await translation.langOf(gameId).catch(() => '');
                if (lang) {
                    const raw = await fsp.readFile(filePath, 'utf8');
                    const out = await translation.overlayPlugins(gameId, raw).catch((e) => {
                        console.error(`[Перевод] ${gameId}: подстановка в plugins.js не вышла — отдаём оригинал:`, e.message);
                        return null;
                    });
                    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                    res.setHeader('Cache-Control', 'no-cache');
                    return res.send(out ?? raw);
                }
            }

            // JS плагины: заменяем import.meta для обхода ошибок Webpack
            if (filePath.endsWith('.js') && finalStat.size < 5 * 1024 * 1024) {
                let jsContent = await fsp.readFile(filePath, 'utf8');
                if (jsContent.includes('import.meta')) {
                    jsContent = jsContent.replace(/\bimport\.meta\b/g, "window.__import_meta");
                    res.setHeader('Content-Type', 'application/javascript');
                    if (cache) res.setHeader('Cache-Control', LONG);
                    return res.send(jsContent);
                }
            }

            // Данные игры (data/*.json) при включённом переводе — с переводом. Не в кэш браузера надолго:
            // перевод прибавляется, пока в игру не играют, и следующий запуск должен его увидеть
            if (filePath.toLowerCase().endsWith('.json') && path.basename(path.dirname(filePath)).toLowerCase() === 'data') {
                const gameId = reqPath.split(/[\\/]/)[0];
                const lang = await translation.langOf(gameId).catch(() => '');
                if (lang) {
                    const raw = await fsp.readFile(filePath);
                    const out = await translation.overlay(gameId, path.basename(filePath, path.extname(filePath)), raw).catch((e) => {
                        console.error(`[Перевод] ${gameId}: подстановка не вышла — отдаём оригинал:`, e.message);
                        return null;
                    });
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.setHeader('Cache-Control', 'no-cache');
                    return res.send(out ?? raw);
                }
            }

            if (cache) {
                res.setHeader('Cache-Control', LONG);
                return res.sendFile(filePath, { cacheControl: false });
            }
            return res.sendFile(filePath);
        }
    } catch(e) {
        // Ошибки ФС просто прокидываем дальше (к 404)
    }

    // === ПРОПАВШИЕ ФАЙЛЫ И ШРИФТЫ (404) ===
    const reqExt = path.extname(reqPath).toLowerCase();
    // 1. Сейвы и конфиги -> отдаем пустой объект, чтобы не ломать плагины
    if (['.json', '.rpgsave', '.rmmzsave'].includes(reqExt)) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(404).send('{}');
    }
    // 2. Стили (шрифты) -> отдаем пустой CSS, чтобы браузер не ругался на MIME type
    if (reqExt === '.css') {
        res.setHeader('Content-Type', 'text/css');
        return res.status(404).send('');
    }
    // 3. Картинка, звук или ролик, которых нет, при включённом переводе: может, перевод задел имя файла —
    //    отдаём настоящий (services/translate.js, originalFile)
    if (translation.originalFile && ['.png', '.jpg', '.jpeg', '.webp', '.m4a', '.ogg', '.webm', '.mp4', '.rpgmvp', '.rpgmvo', '.png_', '.ogg_', '.m4a_'].includes(reqExt)) {
        const gameId = reqPath.split(/[\\/]/)[0];
        const real = await translation.originalFile(gameId, reqPath).catch(() => null);
        if (real) {
            console.warn(`[Перевод] ${gameId}: игра попросила «${path.basename(reqPath)}» — отдаём «${path.basename(real)}» (перевод задел имя файла)`);
            res.setHeader('Cache-Control', 'no-cache');
            return res.sendFile(real, { dotfiles: 'allow' }, (err) => { if (err && !res.headersSent) res.status(404).send(''); });
        }
    }
    // 4. Остальные файлы (картинки, аудио, шрифты) -> просто отдаем пустоту
    if (['.js', '.png', '.jpg', '.m4a', '.ogg', '.ttf', '.woff', '.woff2'].includes(reqExt)) {
        return res.status(404).send('');
    }
    next();
}

// «%» без двух шестнадцатеричных цифр за ним — просто знак процента. MV 1.6 раскодирует путь картинки
// перед загрузкой (ImageManager.loadNormalBitmap → Bitmap.load(decodeURIComponent(path))), и файл
// «$Hero%(8).png» (так называет кадры плагин ExtraMovementFrames) приходит с голым «%(». Express не может
// раскодировать такой адрес и отвечает 400 ещё до нашего кода — игра висит на загрузке.
// Нашёл и прислал исправление tk344 (issue #1 в Raven632/rpg-library)
function fixBarePercent(req, res, next) {
    if (req.url.includes('%')) req.url = req.url.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
    next();
}

// Путь запроса без приставки → путь от GAMES_DIR. Битая %-кодировка — null
function relFrom(urlPath) {
    try { return decodeURIComponent(urlPath).replace(/^\/+/, ''); } catch { return null; }
}

const isGameId = (id) => isSafeSegment(id) && !id.startsWith('.') && !SYSTEM_DIRS.includes(id);

// Сервер игр. secret() — нынешний ключ сессии, store — сейвы (utils/savestore.js),
// onSaved(id, key) — после записи слота (прогресс игры), onMarked(id, playtime) — после нового момента или точки
// перемотки (время игры), publicDir — где rpg-fixes.js и чит-меню
// onError(id, отчёт, User-Agent) — ошибка в игре (services/gameErrors.js), marks — моменты (utils/marks.js)
function createGameApp({ secret, store, marks = null, journal = null, onSaved = () => {}, onMarked = () => {}, onError = async () => {}, publicDir }) {
    const app = express();
    app.disable('x-powered-by');
    app.use(fixBarePercent);
    app.use(compression());
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });

    // Наши скрипты для игр — открыты: в них ничего своего
    // rpg-fixes.js с версией в адресе (?v=) — надолго, чит-меню — на сутки
    for (const file of ['rpg-fixes.js', 'cheats.js']) {
        app.get(`/${file}`, (req, res) => res.sendFile(path.join(publicDir, file), req.query.v ? { maxAge: '365d', immutable: true } : { maxAge: '1d' }));
    }
    // Шрифт переведённого текста (rpg-fixes, setupTranslationFont): латиница и кириллица M PLUS Rounded 1c, OFL
    for (const file of ['mplus-rounded-1c-latin-500.woff2', 'mplus-rounded-1c-cyrillic-500.woff2']) {
        // Адрес без версии — неделя без immutable: заменённый файл дойдёт до браузеров
        app.get(`/fonts/${file}`, (req, res) => res.sendFile(path.join(publicDir, 'fonts', file), { maxAge: '7d' }));
    }

    // Что заблокировал запрет на чужие сайты. Одно и то же — не чаще раза в час
    const reported = new Map();
    app.post('/csp-report', express.json({ type: ['application/csp-report', 'application/json', 'application/reports+json'], limit: '16kb' }), (req, res) => {
        const r = req.body?.['csp-report'] || req.body?.[0]?.body || req.body || {};
        const game = relFrom(new URL(r['document-uri'] || r.documentURL || 'http://x/', 'http://x').pathname)?.split('/')[2] || '?';
        const what = `${r['violated-directive'] || r.effectiveDirective || '?'} ${r['blocked-uri'] || r.blockedURL || '?'}`;
        const key = `${game}\n${what}`;
        if (!reported.has(key) || Date.now() - reported.get(key) > 3600e3) {
            if (reported.size > 500) reported.clear();
            reported.set(key, Date.now());
            console.log(`[CSP] ${game}: заблокировано ${what}`);
        }
        res.status(204).end();
    });

    // Ключ из адреса: подходит к этой игре — дальше, нет — 403
    const checkKey = async (req, res, next) => {
        const { key, game } = req.params;
        if (!isGameId(game) || !(await revsOf(game)).some((rev) => keyMatches(secret(), game, key, rev))) return res.status(403).send('Нет доступа');
        next();
    };

    // Сейвы — только этой игры
    app.get('/saves/:key/:game', checkKey, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await store.list(req.params.game));
    });
    app.post('/saves/:key/:game/:slot', checkKey, express.json({ limit: '50mb' }), async (req, res) => {
        if (typeof req.body?.value !== 'string') return res.status(400).json({ error: 'Bad data' });
        try {
            const slot = path.basename(req.params.slot);
            const result = await store.write(req.params.game, slot, req.body.value, req.body.updatedAt);
            res.json(result === 'older' ? { success: true, kept: 'server' } : { success: true });
            if (result === 'older') console.log(`[Saves] ${req.params.game}: «${slot}» на сервере новее — присланный сейв ушёл в историю`);
            if (result === 'saved') onSaved(req.params.game, slot);
        } catch (e) {
            res.status(500).json({ error: 'Server error' });
        }
    });
    // Снимок экрана к только что записанному слоту: где был, когда игра сохранилась
    app.post('/saves/:key/:game/:slot/shot', checkKey, express.json({ limit: '1mb' }), async (req, res) => {
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.thumb || ''));
        if (!m || typeof store.writeShot !== 'function') return res.status(400).json({ error: 'bad-shot' });
        try {
            const ok = await store.writeShot(req.params.game, path.basename(req.params.slot), Buffer.from(m[1], 'base64'), req.body?.updatedAt);
            res.status(ok ? 200 : 400).json({ success: ok });
        } catch (e) {
            res.status(500).json({ error: 'Server error' });
        }
    });
    app.delete('/saves/:key/:game/:slot', checkKey, async (req, res) => {
        try { await store.remove(req.params.game, path.basename(req.params.slot)); } catch (e) {}
        res.json({ success: true });
    });

    // Моменты этой игры: список, сейв момента, снимок и новый момент (rpg-fixes, setupSceneMarks)
    if (marks) {
        app.get('/marks/:key/:game', checkKey, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.json(await marks.list(req.params.game));
        });
        // Путь к нынешнему состоянию игры: from — последняя точка его истории; лента показывает его как «Это прохождение»
        app.get('/marks/:key/:game/trail/:from', checkKey, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.json({ trail: await marks.trail(req.params.game, req.params.from) });
        });
        app.get('/marks/:key/:game/:id', checkKey, async (req, res) => {
            const value = await marks.value(req.params.game, req.params.id);
            if (value === null) return res.status(404).json({ error: 'not-found' });
            res.setHeader('Cache-Control', 'no-store');
            res.json({ value });
        });
        app.get('/marks/:key/:game/:id/thumb', checkKey, async (req, res) => {
            const file = await marks.thumb(req.params.game, req.params.id);
            if (!file) return res.status(404).end();
            res.sendFile(file, { maxAge: '1d' });
        });
        // Ответ на выбор — к точке «перед выбором» (плёнка покажет, что ответили)
        app.post('/marks/:key/:game/:id/answer', checkKey, express.json({ limit: '4kb' }), async (req, res) => {
            const ok = await marks.setAnswer(req.params.game, req.params.id, String(req.body?.answer ?? ''), req.body?.cancel === true);
            res.status(ok ? 200 : 404).json({ success: ok });
        });
        // «Оставить» точку перемотки прямо в игре
        app.post('/marks/:key/:game/:id/keep', checkKey, async (req, res) => {
            const result = await marks.keep(req.params.game, req.params.id);
            res.status(result.error ? (result.error === 'too-many' ? 409 : 404) : 200).json(result);
        });
        app.post('/marks/:key/:game', checkKey, express.json({ limit: '60mb' }), async (req, res) => {
            try {
                const result = await marks.create(req.params.game, req.body || {});
                if (!result.error) onMarked(req.params.game, req.body?.playtime);
                res.status(result.error ? (result.error === 'too-many' ? 409 : 400) : 200).json(result);
            } catch (e) {
                res.status(500).json({ error: 'Server error' });
            }
        });
    }

    // «Путь» по игре: запись (локация, сцена, выбор с ответом, бой, снимок) и кадр сцены (utils/journal.js)
    if (journal) {
        app.post('/journal/:key/:game', checkKey, express.json({ limit: '16kb' }), async (req, res) => {
            const result = await journal.add(req.params.game, req.body || {});
            res.status(result.error ? 400 : 200).json(result);
        });
        app.post('/journal/:key/:game/room', checkKey, express.json({ limit: '4kb' }), async (req, res) => {
            const ok = await journal.setRoom(req.params.game, req.body || {});
            res.status(ok ? 200 : 400).json({ success: ok });
        });
        app.post('/journal/:key/:game/:id/thumb', checkKey, express.json({ limit: '400kb' }), async (req, res) => {
            res.status((await journal.setThumb(req.params.game, req.params.id, req.body?.thumb)) ? 200 : 404).json({ success: true });
        });
    }

    // Ошибки игры с устройства — в журнал для «Ревизии»
    app.post('/errors/:key/:game', checkKey, express.json({ limit: '64kb' }), async (req, res) => {
        try { await onError(req.params.game, req.body || {}, req.get('user-agent') || ''); } catch (e) {}
        res.status(204).end();
    });

    // Файлы игры: /g/<ключ>/<игра>/<путь>
    app.get(['/g/:key/:game', '/g/:key/:game/*'], checkKey, (req, res, next) => {
        const prefix = `/g/${req.params.key}`;
        const rel = relFrom(req.path.slice(prefix.length));
        if (rel === null) return res.status(400).send('Непонятный адрес');
        // Ключ — на одну игру: путь только внутри её папки («..%2flibrary.db» отдал бы базу с ключом сессии)
        const parts = rel.split(/[\\/]/);
        if (parts[0] !== req.params.game || parts.includes('..')) return res.status(403).send('Нет доступа');
        const inject = { id: req.params.game, saves: `/saves/${req.params.key}`, errors: `/errors/${req.params.key}`, framed: true };
        if (marks) inject.marks = `/marks/${req.params.key}`;
        if (journal) inject.journal = `/journal/${req.params.key}`;
        // Перевод включён — rpg-fixes переносит длинные строки в окне диалога
        Promise.resolve(translation.langOf(req.params.game)).catch(() => '').then((tl) => {
            if (tl) inject.tl = tl;
            return serveGameFile(req, res, next, { rel, prefix, inject, cache: true });
        }).catch(next);
    });

    app.use((req, res) => res.status(404).send(''));
    return app;
}

module.exports = { createGameApp, serveGameFile, gameKey, keyMatches, revOf, relFrom, isGameId, fixCase, fixBarePercent, CSP, setTranslation };
