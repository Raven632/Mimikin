const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { version } = require('../../package.json');
const { GAMES_DIR, EXTRACT_TMP, SAVES_DIR, AUDIOCACHE, OLD_DIR, INBOX_DIR, TRASH_DIR, SYSTEM_DIRS } = require('../config/index.js');
const { secret, SECRETS } = require('../utils/secrets.js');
const serverLog = require('../utils/serverLog.js');

// Отчёт о проблеме для issue на GitHub: он публичный. Строки журнала не знают, что в них: чистим здесь, на сервере, и
// браузер получает уже чистое. Точные значения (ключи из настроек, названия игр) — заменой, а всё, что по ним не поймать
// (архив на загрузке, удалённая игра, чужой адрес), — по виду строки. Лишнее скрыть не страшно, пропустить — страшно.
const HIDDEN = '<hidden>';
const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Папки с играми и домашние: имя в них бывает с пробелами, поэтому съедаем до знака, который в конце пути, или до конца строки
const DATA_ROOTS = [...new Set([GAMES_DIR, EXTRACT_TMP, SAVES_DIR, AUDIOCACHE, OLD_DIR, INBOX_DIR, TRASH_DIR, '/games', '/srv', '/mnt', '/media', '/home', '/Users', '/root', '/volume1', '/share', '/data', '/tmp', '/var'])]
    .filter((root) => root && path.isAbsolute(root) && root !== '/');
const DATA_PATH = new RegExp(`(?<![\\w.<>/\\\\:-])(?:${DATA_ROOTS.map(escapeRe).join('|')})(?:/[^:'"\`«»,;)\\n]*)?(?![\\w-])`, 'g');
const OTHER_PATH = /(?<![\w.<>/\\:-])~?\/[^\s'"`«»,;()<>]+/g;
const WINDOWS_PATH = /(?<![\w])(?:[A-Za-z]:\\|\\\\)[^\n:'"`«»,;)]*/g;

// Первое место в строке «[Тег] имя: сообщение» — часто имя игры или архива (uploads.js, gallery.js, inbox.js). Оставляем
// только то, что не может быть названием: строчные русские слова или теги ниже, где на этом месте всегда текст сообщения.
// Новый тег по умолчанию считается тегом с именем — так безопаснее
const TEXT_TAGS = new Set(['DB', 'Redis', 'Ключи', 'Прокси', 'Telegram', 'Lang', 'ScraperAPI', 'Настройки', 'Проверка', 'Корзина', 'Progress', 'Init', 'Watcher', 'Хочу поиграть', 'Найти']);
const LOG_WORDS = /^(?:\p{Ll}[\p{Ll}-]*|\d+|<hidden>|[,()]|\s)+$/u;
const LATIN = /[a-z]/i;

function hideNameSlot(line) {
    return line.replace(/^([^\s[]{0,3}\s*\[([^\]\n]{1,40})\]\s+)([^\n]*?)(:\s|\s—\s|$)/mu, (all, head, tag, slot, end) => {
        if (!slot || TEXT_TAGS.has(tag) || (LOG_WORDS.test(slot) && !LATIN.test(slot.replace(/<hidden>/g, '')))) return all;
        return `${head}${HIDDEN}${end}`;
    });
}

const normalName = (s) => String(s).toLowerCase().replace(/%20/g, ' ').replace(/[\s_.+-]+/g, ' ').trim();
// Пробел, подчёркивание и точка в именах взаимозаменяемы: «Some_Game» в журнале — та же игра, что «Some Game» в базе
const nameRe = (name) => new RegExp(`(?<![\\p{L}\\p{N}])${normalName(name).split(' ').map(escapeRe).join('(?:[\\s_.+-]|%20)+')}(?![\\p{L}\\p{N}])`, 'giu');

// Сколько бы ни было игр, регулярное выражение строим только для тех, что в этих строках действительно встретились
function namesRule(names, texts) {
    const seen = normalName(texts.join('\n'));
    const hits = [...new Set(names.map(normalName))].filter((n) => n && seen.includes(n)).sort((a, b) => b.length - a.length);
    const rules = hits.map(nameRe);
    return (s) => rules.reduce((text, re) => text.replace(re, HIDDEN), s);
}

function redactLine(text, { secrets = [], names = () => (s) => s } = {}) {
    let s = String(text);
    for (const value of secrets) s = s.split(value).join(HIDDEN);
    // Адрес: остаётся только сайт. Вход в адресе, путь и параметры (ключи, названия тем) — долой
    s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`«»<>]+/gi, (url) => {
        const m = url.match(/^([a-z0-9+.-]+:\/\/)(?:[^/@]*@)?([^/?#]*)(.*)$/is);
        return m ? `${m[1]}${m[2]}${m[3] && m[3] !== '/' ? `/${HIDDEN}` : ''}` : HIDDEN;
    });
    s = s.replace(/\b(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s'"`«»<>]+/gi, (m) => `${m.split('/')[0]}/${HIDDEN}`)
        .replace(/\b[\w.-]+:\d+\/[^\s'"`«»<>]+/g, (m) => `${m.split('/')[0]}/${HIDDEN}`);
    // Заголовки целиком, до конца строки: в куке значения через «;»
    s = s.replace(/\b(set-cookie|cookie|proxy-authorization|authorization|x-api-key)\b(['"]?\s*[:=]\s*)[^\n]*/gi, `$1$2${HIDDEN}`);
    s = s.replace(/\bBearer\s+\S+/gi, `Bearer ${HIDDEN}`)
        .replace(/\b(?:bot)?\d{5,15}:[A-Za-z0-9_-]{30,}/g, HIDDEN)
        .replace(/\benc1:[A-Za-z0-9+/=]+/g, HIDDEN)
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, HIDDEN);
    // Длинные слова — раньше правила с ключевыми словами: оно перебирает слово по буквам, и на таком было бы медленным
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::fx)?\b/gi, HIDDEN)
        .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g, HIDDEN)
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, HIDDEN);
    s = s.replace(/([\p{L}\p{N}_.-]*(?:pass(?:word|wd|phrase)?|pwd|token|secret|api[_-]?key|apikey|cookie|session|sid|auth|clearance|chat_id|credential|login|hash|\bkey|парол|ключ|токен|кук)[\p{L}\p{N}_.-]*['"]?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/giu, `$1${HIDDEN}`);
    // Кука по частям: xf_user=…; xf_session=…
    s = s.replace(/((?:\b[A-Za-z_][\w-]*|<hidden>)=)[^\s;,&'"]{8,}/g, `$1${HIDDEN}`);
    s = s.replace(/\b[^\s:/@]+:[^\s/@]+@/g, `${HIDDEN}@`)
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, HIDDEN)
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, HIDDEN);
    s = names(s);
    // Файлы самой программы в стеке ошибки полезны и не говорят ни о ком; где она лежит — говорят
    s = s.split(APP_ROOT + path.sep).join('<app>/');
    s = s.replace(DATA_PATH, HIDDEN).replace(WINDOWS_PATH, HIDDEN).replace(OTHER_PATH, HIDDEN);
    // В кавычках в журнале — почти всегда имя: файла, игры, настройки
    s = s.replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|«[^»\n]*»|“[^”\n]*”/g, HIDDEN);
    // Архив с пробелами в имени: «Some Game v1.0.zip»
    s = s.replace(/(?:[^\s:<>[\]]+ ){0,8}[^\s:<>[\]]+\.(?:zip|rar|7z|tar|gz|tgz|part\d+|exe|iso|dmg|apk|torrent)\b/gi, HIDDEN);
    s = s.replace(/\b[RBV]J\d{6,8}\b/gi, HIDDEN)
        .replace(/(?:%[0-9A-Fa-f]{2}){2,}/g, HIDDEN)
        .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, HIDDEN);
    return hideNameSlot(s);
}

// Что точно нельзя показать: значения ключей из настроек и .env, с разбором JSON и куки по частям
function knownSecrets(extra = []) {
    const values = new Set(extra);
    const addParts = (value) => {
        const text = String(value || '');
        if (!text) return;
        values.add(text);
        for (const part of text.split(/[;|]/)) {
            values.add(part.trim());
            values.add(part.split('=').slice(1).join('=').trim());
        }
        try {
            for (const leaf of Object.values(JSON.parse(text))) if (typeof leaf === 'string') values.add(leaf);
        } catch { /* не JSON */ }
    };
    for (const name of Object.keys(SECRETS)) addParts(secret(name));
    for (const [name, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASS|COOKIE|LOGIN/i.test(name)) addParts(value);
    return [...values].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
}

const dirNames = async (dir) => (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !SYSTEM_DIRS.includes(e.name)).map((e) => e.name);

// Все имена, какие знает библиотека: игры, полка, «Хочу поиграть», корзина, отложенные версии, «Входящие». Плюс логин
// и имена компьютера и пользователя
async function knownNames(db) {
    const names = new Set();
    const add = (v) => { if (typeof v === 'string' && v.trim()) names.add(v.trim()); };
    const games = await db.all('SELECT id, title FROM games').catch(() => []);
    for (const g of games) { add(g.id); add(g.title); }
    const wished = await db.all('SELECT ref, info FROM wishlist').catch(() => []);
    for (const w of wished) {
        add(w.ref);
        try { const info = JSON.parse(w.info || '{}'); add(info.title); add(info.name); add(info.alt); add(info.original); } catch { /* запись без данных */ }
    }
    add((await db.get("SELECT value FROM settings WHERE key = 'admin_user'").catch(() => null))?.value);
    // Имена людей рядом: сейчас в журнал они не попадают, но имя теперь выбирают сами и логин может оказаться в тексте ошибки
    for (const row of await db.all('SELECT name FROM users').catch(() => [])) add(row.name);
    for (const dir of [GAMES_DIR, OLD_DIR, INBOX_DIR]) (await dirNames(dir)).forEach(add);
    for (const key of await dirNames(TRASH_DIR)) {
        add(key.replace(/^\d{13}-/, ''));
        const entry = await fsp.readFile(path.join(TRASH_DIR, key, 'entry.json'), 'utf8').then(JSON.parse).catch(() => null);
        add(entry?.row?.title); add(entry?.title);
    }
    try { add(os.userInfo().username); } catch { /* в контейнере без записи в passwd */ }
    add(os.hostname());
    return [...names];
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const onPath = (...tools) => (process.env.PATH || '').split(path.delimiter).some((dir) => tools.some((t) => fs.existsSync(path.join(dir, t))));

// Только то, что помогает с программой. Сайты со входом не называем: отчёт уходит в открытый issue, и список сайтов — личное
function optionalServices({ redis }) {
    return [
        ['Redis', redis], ['OCR', !!process.env.OCR_URL], ['ffmpeg', onPath('ffmpeg')], ['7-Zip', onPath('7zz', '7z')], ['ScraperAPI', !!secret('scraper')], ['Telegram', !!secret('telegram')],
        ['DeepL', !!secret('deepl')], ['Microsoft Translator', !!secret('microsoft')], ['Google Translate', !!secret('google')], ['LibreTranslate', !!secret('libre')],
        ['MyJDownloader', !!secret('myjd')], ['Seedbox', !!secret('seedbox')],
    ];
}

async function systemFacts({ browser = '', redis = false } = {}) {
    const disk = await fsp.statfs(GAMES_DIR).catch(() => null);
    const services = optionalServices({ redis });
    const list = (found) => services.filter(([, on]) => on === found).map(([name]) => name).join(', ') || 'none';
    return [
        `Version: ${version}`,
        `OS: ${os.type()} ${os.release()}`,
        `Architecture: ${os.arch()}`,
        `CPUs: ${os.availableParallelism?.() ?? os.cpus().length}`,
        `Memory: ${gb(os.freemem())} free of ${gb(os.totalmem())}`,
        `Free disk: ${disk ? `${gb(disk.bavail * disk.bsize)} of ${gb(disk.blocks * disk.bsize)}` : 'unknown'}`,
        `Docker: ${fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') ? 'yes' : 'no'}`,
        `Node: ${process.version}`,
        `Optional services found: ${list(true)}`,
        `Optional services not found: ${list(false)}`,
        `Browser: ${String(browser).replace(/[^\x20-\x7e]/g, '').slice(0, 300) || 'unknown'}`,
    ];
}

// GitHub не примет текст длиннее 65 КБ: в отчёт — самые свежие строки, сколько влезет
const REPORT_LOG_CHARS = 30000;

async function build({ db, browser, redis, extraSecrets = [] }) {
    const { lines, total } = serverLog.recent();
    const texts = lines.map((l) => (l.cut ? l.text.slice(0, -256) : l.text));
    const names = namesRule(await knownNames(db), texts);
    const secrets = knownSecrets(extraSecrets);
    const clean = lines.map((l, i) => ({ at: l.at, level: l.level, text: redactLine(texts[i], { secrets, names }) + (l.cut ? ' …' : '') }));

    const asText = (l) => `${new Date(l.at).toISOString().slice(0, 19)}Z ${l.level === 'error' ? 'ERROR' : 'WARN'} ${l.text}`;
    const kept = [];
    let room = REPORT_LOG_CHARS;
    for (let i = clean.length - 1; i >= 0; i--) {
        const line = asText(clean[i]);
        if (line.length + 1 > room) break;
        room -= line.length + 1;
        kept.unshift(line);
    }
    const report = [
        'Mimikin problem report',
        ...await systemFacts({ browser, redis }),
        '',
        `Recent warnings and errors (${kept.length} shown, ${total} since start):`,
        ...(kept.length ? kept : ['none']),
    ].join('\n');
    return { lines: clean, total, report };
}

module.exports = { build, redactLine, namesRule, knownNames, knownSecrets };
