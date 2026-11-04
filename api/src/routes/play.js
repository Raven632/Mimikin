const express = require('express');
const compression = require('compression');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const audioService = require('../services/audio.js');
const { findGameFolder } = require('../utils/archive.js');
const { isSafeSegment } = require('../utils/validate.js');
const { sendErrorPage } = require('../utils/errorPage.js');
const { GAMES_DIR, SYSTEM_DIRS } = require('../config/index.js');
const { deviceOf } = require('../services/gameErrors.js');

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
//
// Адрес файлов владельца — gameKey, один на игру. Строка подписи сменена один раз (play → play2): до учётных записей ключ был общим
// на всех и без входа, и тот, у кого он мог остаться, не должен открывать игры, которые потом закрыли. Ничего долговечного на
// значении ключа не держится: его выдаёт каждый запуск (POST /api/play), сейвы и моменты лежат по id игры
function gameKey(secret, id, rev = '') {
    return crypto.createHmac('sha256', String(secret)).update(`play2\n${id}${rev ? `\n${rev}` : ''}`).digest('hex').slice(0, 32);
}

// Адрес файлов человека (не владельца): его id и подпись «эти файлы — ему». Свой у каждого, поэтому доступ проверяется на каждом
// файле (createGameApp, mayOpen) и закрытая игра перестаёт открываться со следующего запроса, без кэша. Привязан к человеку, а не
// ко входу: так браузер не скачивает большую игру заново после каждого входа
const PERSON_KEY = /^(u[0-9a-f]{16})([0-9a-f]{32})$/;
function personKey(secret, uid, id, rev = '') {
    return uid + crypto.createHmac('sha256', String(secret)).update(`file\n${uid}\n${id}\n${rev}`).digest('hex').slice(0, 32);
}
const sameKey = (want, got) => {
    const a = Buffer.from(want);
    const b = Buffer.from(String(got || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Ключ сессии для записей игры (сейвы, моменты, «путь», ошибки): 16 hex id входа и 32 hex подписи «эта игра у этого входа».
// Адрес файлов (gameKey) один на всех и живёт годами в кэше браузера; кто пишет — определяет только этот ключ, он
// приходит в ?s= при запуске (frontend launchGame) и подставляется в страницу игры. Пока выход закрывает вход — закрывается и он
const SESSION_KEY = /^([0-9a-f]{16})([0-9a-f]{32})$/;
function sessionKey(secret, sid, id) {
    return sid + crypto.createHmac('sha256', String(secret)).update(`play\n${sid}\n${id}`).digest('hex').slice(0, 32);
}
// Подпись сходится — id входа, иначе null. Что вход ещё жив, проверяет вызывающий
function sessionIdOf(secret, key, id) {
    const m = SESSION_KEY.exec(String(key || ''));
    if (!m) return null;
    const want = Buffer.from(sessionKey(secret, m[1], id));
    const got = Buffer.from(String(key));
    return crypto.timingSafeEqual(got, want) ? m[1] : null;
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
    return sameKey(gameKey(secret, id, rev), key);
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

// Все карты игры одним ответом для чит-меню (data/mimikin-maps.json, cheats.js, readMaps). У больших игр карты весят
// 150–200 МБ, и почти всё это — поле data (плитки), которое меню не читает: без него в пять раз меньше. Файла на диске
// нет и не будет: в папке игры ничего не пишем, ответ живёт в памяти и только для последней игры — он сжат, но у
// большой игры это всё равно мегабайты. Обновление игры, патч или недораспакованная игра меняют файлы карт — тогда
// собираем заново (mapsStamp)
const MAPS_FILE = /(?:^|[\\/])data[\\/]mimikin-maps\.json$/i;
let mapsMemo = null;           // { dir, stamp, gz }
const mapsBuilds = new Map();  // папка → идущая сборка: запросы, пришедшие во время неё, ждут её же

// Как прочитает карту сама игра: файл ровно с тем номером, который она спросит (Map001.json, Map1000.json, а не
// Map1.json), и с точным именем, если рядом есть такое же в другом регистре. Битого файла или файла, которого уже нет,
// нет и в ответе: игра его тоже не откроет. Другая ошибка чтения (нет прав, сбой диска) — сбой всей сборки: такой ответ
// не запомнится как полный, а меню прочитает карты по одной и само скажет, что прочиталось не всё. Читаем по одному и
// ждём каждый: большая игра не должна останавливать сервер на секунды
async function buildMaps(dir, names) {
    const files = new Map();
    for (const name of names) {
        const digits = (/^map(\d+)\.json$/i.exec(name) || [])[1];
        if (digits && String(Number(digits)).padStart(3, '0') === digits && (!files.has(digits) || name === `Map${digits}.json`)) files.set(digits, name);
    }
    const parts = [];
    for (const [digits, name] of files) {
        let map = null;
        try {
            map = JSON.parse((await fsp.readFile(path.join(dir, name), 'utf8')).replace(/^\uFEFF/, ''));
        } catch (e) {
            if (e instanceof SyntaxError || e.code === 'ENOENT' || e.code === 'EISDIR') continue;
            throw e;
        }
        if (!map) continue;
        if (typeof map === 'object') delete map.data;
        parts.push(`"${Number(digits)}":${JSON.stringify(map)}`);
    }
    return promisify(zlib.gzip)(`{${parts.join(',')}}`);
}

// Отпечаток файлов карт: имя, размер, время. Одного MapInfos.json мало: патч часто меняет только MapNNN.json. Архив
// сохраняет старое время файла, поэтому смотрим все файлы, а не самое новое время. Сотни stat — миллисекунды рядом со сборкой
async function mapsStamp(dir, names) {
    const hash = crypto.createHash('sha1');
    for (const name of names) {
        if (!/^map(infos|\d+)\.json$/i.test(name)) continue;
        const st = await fsp.stat(path.join(dir, name)).catch(() => null);
        if (st) hash.update(`${name}:${st.size}:${st.mtimeMs}\n`);
    }
    return hash.digest('hex');
}

async function mapsGz(dir) {
    const names = await fsp.readdir(dir);
    const stamp = await mapsStamp(dir, names);
    if (mapsMemo && mapsMemo.dir === dir && mapsMemo.stamp === stamp) return mapsMemo.gz;
    let build = mapsBuilds.get(dir);
    if (!build) {
        build = buildMaps(dir, names).then((gz) => { mapsMemo = { dir, stamp, gz }; return gz; }).finally(() => mapsBuilds.delete(dir));
        mapsBuilds.set(dir, build);
    }
    return build;
}

async function serveMaps(req, res, dir, gameId) {
    res.setHeader('Cache-Control', 'no-cache');
    // Перевод меняет тексты, которые вход в комнату потом покажет (goRoom): такая игра читает карты по одной, с переводом
    if (await translation.langOf(gameId).catch(() => '')) return res.status(404).json({});
    if (!(await fsp.stat(dir).then((st) => st.isDirectory(), () => false))) return res.status(404).json({});
    try {
        const gz = await mapsGz(dir);
        res.vary('Accept-Encoding');
        res.type('json');
        if (!req.acceptsEncodings('gzip')) return res.send(await promisify(zlib.gunzip)(gz));
        // С этим заголовком compression() не сожмёт ответ второй раз
        res.setHeader('Content-Encoding', 'gzip');
        return res.send(gz);
    } catch (e) {
        console.error(`[Чит-меню] ${gameId}: не собрались карты:`, e.message);
        return res.status(500).json({});
    }
}

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
        return sendErrorPage(req, res, 403, 'denied');
    }
    if (MAPS_FILE.test(rel)) return serveMaps(req, res, await fixCase(GAMES_DIR, path.dirname(rel)), rel.split(/[\\/]/)[0]);

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
                return sendErrorPage(req, res, 404, 'start');
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
                const injected = typeof inject === 'function' ? await inject() : inject;
                if (injected === null) return sendErrorPage(req, res, 403, 'denied');
                const config = injected ? `<script>window.__RPG=${JSON.stringify(injected).replace(/</g, '\\u003c')}</script>` : '';
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
// Нашли и прислали исправление в сообщении об ошибке на GitHub
function fixBarePercent(req, res, next) {
    if (req.url.includes('%')) req.url = req.url.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
    next();
}

// Путь запроса без приставки → путь от GAMES_DIR. Битая %-кодировка — null
function relFrom(urlPath) {
    try { return decodeURIComponent(urlPath).replace(/^\/+/, ''); } catch { return null; }
}

const isGameId = (id) => isSafeSegment(id) && !id.startsWith('.') && !SYSTEM_DIRS.includes(id);

// Сервер игр. secret() — ключ сессии (подпись адресов), sessions — входы: { find(id), legacyOpen() }; без него (тесты) годится
// и адрес файлов, как у прежних версий. store — сейвы (utils/savestore.js), storesFor(id человека) → { saves, marks, journal }
// его личные хранилища (utils/personStores.js); без него все пишут в store, marks и journal,
// onSaved(id, key) — после записи слота (прогресс игры), onMarked(id, playtime) — после нового момента или точки
// перемотки (время игры), publicDir — где rpg-fixes.js и чит-меню
// onError(id, отчёт, User-Agent) — ошибка в игре (services/gameErrors.js), marks — моменты (utils/marks.js),
// mayOpen(id человека, игра) → открыта ли ему игра (services/gameAccess.js): без него адреса файлов людей и их ключи записи не
// принимаются вовсе
function createGameApp({ secret, sessions = null, store, marks = null, journal = null, storesFor = null, onSaved = () => {}, onMarked = () => {}, onError = async () => {}, mayOpen = null, publicDir }) {
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

    // Ключ файлов подходит к игре: владельца (gameKey) или человека (personKey) — тогда ещё и игра ему открыта, каждый раз
    const keyOpens = async (key, game) => {
        const revs = await revsOf(game);
        const who = PERSON_KEY.exec(String(key || ''));
        if (!who) return revs.some((rev) => keyMatches(secret(), game, key, rev));
        return !!mayOpen && revs.some((rev) => sameKey(personKey(secret(), who[1], game, rev), key)) && await mayOpen(who[1], game);
    };
    // Ключ из адреса: подходит к этой игре — дальше, нет — 403
    const checkKey = async (req, res, next) => {
        const { key, game } = req.params;
        if (!isGameId(game) || !(await keyOpens(key, game))) return sendErrorPage(req, res, 403, 'denied');
        next();
    };

    // Чьи хранилища: у человека за ключом сессии — свои (utils/personStores.js), у владельца — переданные. Без storesFor
    // (тесты, старые вызовы) все пишут в переданные
    const mine = (req) => (storesFor && req.who ? storesFor(req.who.userId) : { saves: store, marks, journal });

    // Кто пишет: ключ сессии (48 hex) — живой вход; адрес файлов (32 hex) — как раньше, но только пока открыто окно старой куки,
    // тогда это владелец (вкладка, открытая до обновления, продолжает сохранять). req.who — для личных данных
    const checkWriter = async (req, res, next) => {
        const { key, game } = req.params;
        if (!isGameId(game)) return sendErrorPage(req, res, 403, 'denied');
        const who = await writerOf(key, game);
        if (!who) return sendErrorPage(req, res, 403, 'denied');
        req.who = who;
        next();
    };
    async function writerOf(key, game) {
        const sid = sessions && sessionIdOf(secret(), key, game);
        if (sid) {
            const live = await sessions.find(sid).catch(() => null);
            if (!live) return null;
            // Вход жив, но игру человеку закрыли: писать в неё (и открывать страницу) уже нельзя
            if (live.userId !== 'owner' && !(mayOpen && await mayOpen(live.userId, game))) return null;
            return { sid, userId: live.userId };
        }
        if (sessions && !sessions.legacyOpen()) return null;
        return (await revsOf(game)).some((rev) => keyMatches(secret(), game, key, rev)) ? { sid: null, userId: 'owner' } : null;
    }

    // «Здесь ли эта библиотека»: страница спрашивает перед тем, как открыть рамку (launchGame.js). Порт опубликован не тот —
    // ответа нет; там другая установка — её ключ сессии другой, 403. Рамка показала бы только белую страницу. Отдельного
    // «номера установки» нет намеренно: ответ открыт любому сайту (CORS), а так он не узнаёт ничего, кроме «подходит ли ключ»
    app.get('/ready/:key/:game', (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store');
        next();
    }, checkKey, (req, res) => res.json({ mimikin: true }));

    // Сейвы — только этой игры
    app.get('/saves/:key/:game', checkWriter, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await mine(req).saves.list(req.params.game));
    });
    app.post('/saves/:key/:game/:slot', checkWriter, express.json({ limit: '50mb' }), async (req, res) => {
        if (typeof req.body?.value !== 'string') return res.status(400).json({ error: 'Bad data' });
        try {
            const slot = path.basename(req.params.slot);
            const result = await mine(req).saves.write(req.params.game, slot, req.body.value, req.body.updatedAt);
            res.json(result === 'older' ? { success: true, kept: 'server' } : { success: true });
            if (result === 'older') console.log(`[Saves] ${req.params.game}: «${slot}» на сервере новее — присланный сейв ушёл в историю`);
            if (result === 'saved') onSaved(req.params.game, slot, req.who?.userId);
        } catch (e) {
            res.status(500).json({ error: 'Server error' });
        }
    });
    // Снимок экрана к только что записанному слоту: где был, когда игра сохранилась
    app.post('/saves/:key/:game/:slot/shot', checkWriter, express.json({ limit: '1mb' }), async (req, res) => {
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.thumb || ''));
        if (!m || typeof mine(req).saves.writeShot !== 'function') return res.status(400).json({ error: 'bad-shot' });
        try {
            const ok = await mine(req).saves.writeShot(req.params.game, path.basename(req.params.slot), Buffer.from(m[1], 'base64'), req.body?.updatedAt);
            res.status(ok ? 200 : 400).json({ success: ok });
        } catch (e) {
            res.status(500).json({ error: 'Server error' });
        }
    });
    app.delete('/saves/:key/:game/:slot', checkWriter, async (req, res) => {
        try { await mine(req).saves.remove(req.params.game, path.basename(req.params.slot)); } catch (e) {}
        res.json({ success: true });
    });

    // Моменты этой игры: список, сейв момента, снимок и новый момент (rpg-fixes, setupSceneMarks)
    if (marks) {
        app.get('/marks/:key/:game', checkWriter, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.json(await mine(req).marks.list(req.params.game));
        });
        // Путь к нынешнему состоянию игры: from — последняя точка его истории; лента показывает его как «Это прохождение»
        app.get('/marks/:key/:game/trail/:from', checkWriter, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.json({ trail: await mine(req).marks.trail(req.params.game, req.params.from) });
        });
        app.get('/marks/:key/:game/:id', checkWriter, async (req, res) => {
            const value = await mine(req).marks.value(req.params.game, req.params.id);
            if (value === null) return res.status(404).json({ error: 'not-found' });
            res.setHeader('Cache-Control', 'no-store');
            res.json({ value });
        });
        app.get('/marks/:key/:game/:id/thumb', checkWriter, async (req, res) => {
            const file = await mine(req).marks.thumb(req.params.game, req.params.id);
            if (!file) return res.status(404).end();
            res.sendFile(file, { maxAge: '1d' });
        });
        // Ответ на выбор — к точке «перед выбором» (плёнка покажет, что ответили)
        app.post('/marks/:key/:game/:id/answer', checkWriter, express.json({ limit: '4kb' }), async (req, res) => {
            const ok = await mine(req).marks.setAnswer(req.params.game, req.params.id, String(req.body?.answer ?? ''), req.body?.cancel === true);
            res.status(ok ? 200 : 404).json({ success: ok });
        });
        // «Оставить» точку перемотки прямо в игре
        app.post('/marks/:key/:game/:id/keep', checkWriter, async (req, res) => {
            const result = await mine(req).marks.keep(req.params.game, req.params.id);
            res.status(result.error ? (result.error === 'too-many' ? 409 : 404) : 200).json(result);
        });
        app.post('/marks/:key/:game', checkWriter, express.json({ limit: '60mb' }), async (req, res) => {
            try {
                const result = await mine(req).marks.create(req.params.game, req.body || {});
                if (!result.error) onMarked(req.params.game, req.body?.playtime, req.who?.userId);
                // «Где вышли» — строкой в журнале: по docker logs видно, долетает ли точка с iPhone, когда вкладку выгружают
                if (!result.error && req.body?.kind === 'auto' && req.body?.why === 'exit') {
                    const kb = Math.round((Number(req.get('content-length')) || 0) / 1024);
                    console.log(`[Где вышли] ${req.params.game}: ${req.body.mid === true ? 'посреди сцены' : 'на карте'}, ${deviceOf(req.get('user-agent') || '', !!req.body.standalone)}, ${kb} КБ`);
                }
                res.status(result.error ? (result.error === 'too-many' ? 409 : 400) : 200).json(result);
            } catch (e) {
                res.status(500).json({ error: 'Server error' });
            }
        });
    }

    // «Путь» по игре: запись (локация, сцена, выбор с ответом, бой, снимок) и кадр сцены (utils/journal.js)
    if (journal) {
        app.post('/journal/:key/:game', checkWriter, express.json({ limit: '16kb' }), async (req, res) => {
            const result = await mine(req).journal.add(req.params.game, req.body || {});
            res.status(result.error ? 400 : 200).json(result);
        });
        app.post('/journal/:key/:game/room', checkWriter, express.json({ limit: '4kb' }), async (req, res) => {
            const ok = await mine(req).journal.setRoom(req.params.game, req.body || {});
            res.status(ok ? 200 : 400).json({ success: ok });
        });
        app.post('/journal/:key/:game/:id/thumb', checkWriter, express.json({ limit: '400kb' }), async (req, res) => {
            res.status((await mine(req).journal.setThumb(req.params.game, req.params.id, req.body?.thumb)) ? 200 : 404).json({ success: true });
        });
    }

    // Ошибки игры с устройства — в журнал для «Ревизии»
    app.post('/errors/:key/:game', checkWriter, express.json({ limit: '64kb' }), async (req, res) => {
        try { await onError(req.params.game, req.body || {}, req.get('user-agent') || ''); } catch (e) {}
        res.status(204).end();
    });

    // Файлы игры: /g/<ключ>/<игра>/<путь>
    app.get(['/g/:key/:game', '/g/:key/:game/*'], checkKey, (req, res, next) => {
        const prefix = `/g/${req.params.key}`;
        const rel = relFrom(req.path.slice(prefix.length));
        if (rel === null) return sendErrorPage(req, res, 400, 'address');
        // Ключ — на одну игру: путь только внутри её папки («..%2flibrary.db» отдал бы базу с ключом сессии)
        const parts = rel.split(/[\\/]/);
        if (parts[0] !== req.params.game || parts.includes('..')) return sendErrorPage(req, res, 403, 'denied');
        // Адреса записи — только в index.html (serveGameFile зовёт это один раз): ключ сессии из ?s=, а без живого — адрес файлов
        // пока открыто окно старой куки. Иначе страница не открывается: писать ей было бы нечем
        const inject = async () => {
            const game = req.params.game;
            let writeKey = null;
            let who = typeof req.query.s === 'string' ? await writerOf(req.query.s, game) : null;
            if (who) writeKey = req.query.s;
            else if ((who = await writerOf(req.params.key, game))) writeKey = req.params.key;
            if (!writeKey) return null;
            const config = { id: game, saves: `/saves/${writeKey}`, errors: `/errors/${writeKey}`, framed: true };
            // Не владельцу — его id: rpg-fixes кладёт всё своё в браузере под ним (хранилище страницы общее у людей одного браузера)
            if (who.userId !== 'owner') config.who = who.userId;
            if (marks) config.marks = `/marks/${writeKey}`;
            if (journal) config.journal = `/journal/${writeKey}`;
            // Перевод включён — rpg-fixes переносит длинные строки в окне диалога
            const tl = await Promise.resolve(translation.langOf(game)).catch(() => '');
            if (tl) config.tl = tl;
            return config;
        };
        serveGameFile(req, res, next, { rel, prefix, inject, cache: true }).catch(next);
    });

    app.use((req, res) => res.status(404).send(''));
    return app;
}

module.exports = { createGameApp, serveGameFile, gameKey, personKey, sessionKey, keyMatches, revOf, relFrom, isGameId, fixCase, fixBarePercent, CSP, setTranslation };
