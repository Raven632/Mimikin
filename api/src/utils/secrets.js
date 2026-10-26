// Ключи и пароли, которые раньше задавались только в .env на сервере: ScraperAPI, бот
// Telegram, пароль резервных копий, ключи служб перевода. Главный — из .env: кто настроил так, у того всё как было. Нет его —
// вписанный в «Настройках» (таблица settings): скачавшему библиотеку не нужно лезть в файлы на сервере.
// server.js читает их из базы при старте, маршрут настроек — при сохранении. Наружу значения не
// отдаются: только задан ли, откуда и последние четыре знака. В резервные копии они не попадают
// (routes/backup.js, PRIVATE_SETTINGS).
// В базе они зашифрованы (AES-256-GCM, seal/unseal): база, скопированная или отданная для разбора отдельно от ключа,
// секретов не выдаёт. Ключ — SECRETS_KEY из .env (тогда он вне папки с играми — так надёжнее всего) или, без него,
// случайный ключ в GAMES_DIR/_media/.secrets.key с правами 600. Старые открытые значения шифруются при старте
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GAMES_DIR } = require('../config/index.js');

const SEALED = 'enc1:';
const keyError = (message) => Object.assign(new Error(message), { seal: true });
let sealKey = null;
// SECRETS_KEY может оказаться короткой фразой — через scrypt, а не голый sha256: подбор офлайн дороже.
// Файл ключа заводится целиком или никак: пишем во временный и ставим ссылкой (link не перезаписывает чужой) —
// второй процесс в тот же миг прочтёт либо готовый ключ, либо ничего
function keyOf() {
    if (sealKey) return sealKey;
    if (process.env.SECRETS_KEY) return (sealKey = crypto.scryptSync(process.env.SECRETS_KEY, 'mimikin-secrets', 32));
    const file = process.env.SECRETS_KEY_FILE || path.join(GAMES_DIR, '_media', '.secrets.key');
    const read = () => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
    let hex = read();
    if (hex === null) {
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
            try { fs.linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        } catch (e) {
            throw keyError(`Не завести ключ шифрования ${file}: ${e.message}. Задайте SECRETS_KEY в .env или дайте серверу запись в эту папку`);
        } finally {
            try { fs.unlinkSync(tmp); } catch { /* уже нет */ }
        }
        hex = read();
    }
    if (!/^[0-9a-f]{64}$/.test(hex || '')) {
        throw keyError(`Файл ключа шифрования ${file} испорчен. Верните прежний из копии — или удалите его, и тогда сохранённые ключи придётся вписать заново`);
    }
    return (sealKey = Buffer.from(hex, 'hex'));
}

// Значение → «enc1:<base64 iv|tag|шифр>». name — имя строки в settings: шифр привязан к ней (AAD), и токен из одной
// строки не подложить в другую. Пустое остаётся пустым
function seal(value, name) {
    if (!value) return '';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keyOf(), iv);
    c.setAAD(Buffer.from(String(name)));
    const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
    return SEALED + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

// Обратно. Открытое (из старой базы) — как есть; не расшифровалось (ключ сменили, потеряли, строку подменили) — null
function unseal(stored, name) {
    if (!stored || !String(stored).startsWith(SEALED)) return stored || '';
    try {
        const raw = Buffer.from(String(stored).slice(SEALED.length), 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', keyOf(), raw.subarray(0, 12));
        d.setAAD(Buffer.from(String(name)));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch (e) {
        if (e.seal) console.error('[Ключи]', e.message);
        return null;
    }
}

// Вход MyJDownloader хранится без пароля: для входа нужны только две суммы sha256(почта + пароль + «server»/«device»)
// (так устроен протокол, services/myjd.js). Сам пароль (он бывает и от других сайтов) так не утечёт, но суммы — это вход
// в MyJDownloader, а слабый пароль по ним подбирается: поэтому они зашифрованы, как остальное
function myjdWithoutPassword(json) {
    try {
        const o = JSON.parse(json);
        if (!o?.password) return json;
        const sum = (domain) => crypto.createHash('sha256').update(String(o.email).toLowerCase() + o.password + domain).digest('hex');
        const { password, ...rest } = o;
        return JSON.stringify({ ...rest, loginSecret: sum('server'), deviceSecret: sum('device') });
    } catch { return json; }
}

const SECRETS = {
    scraper: { env: 'SCRAPER_API_KEY', setting: 'scraper_api_key' },
    telegram: { env: 'TELEGRAM_BOT_TOKEN', setting: 'telegram_bot_token' },
    backup: { env: 'BACKUP_PASSWORD', setting: 'backup_password' },
    // Перевод игр (services/translate.js). Microsoft — «ключ|регион», LibreTranslate — «адрес|ключ»
    deepl: { env: 'DEEPL_API_KEY', setting: 'deepl_api_key' },
    microsoft: { env: 'MS_TRANSLATOR_KEY', setting: 'ms_translator_key' },
    google: { env: 'GOOGLE_TRANSLATE_KEY', setting: 'google_translate_key' },
    libre: { env: 'LIBRETRANSLATE_URL', setting: 'libretranslate_url' },
    // MyJDownloader: JSON { email, password, device, folder } — «Загрузить» из «Новинок» (services/myjd.js)
    myjd: { env: 'MYJD_LOGIN', setting: 'myjd_login' },
    // Seedbox: JSON { host, port, user, folder, key, hostKey } — ключ SFTP, заведённый по паролю (services/seedbox.js)
    seedbox: { env: 'SEEDBOX_LOGIN', setting: 'seedbox_login' },
    // Помощник обновлений (services/updates.js): JSON { url, token }. В .env — двумя строками, UPDATE_URL и UPDATE_TOKEN
    // Имя не «update»: POST /api/settings/update — это «обновить сейчас»
    updater: { env: 'UPDATE_URL', setting: 'update_helper' },
    // Две установки на одном JDownloader (services/relay.js): JSON { self, peer, url, keyIn, keyOut, folder } — связь
    // с той установкой и ключи в обе стороны. Задаётся только кнопками «Связать» и «Разрешить», не руками и не в .env
    pair: { env: 'MIMIKIN_PAIR', setting: 'relay_pair' },
};

const saved = {};
// Службы рядом (docker compose, профили): адрес, по которому нашлись сами (utils/nearby.js). Вписанное — главнее
const detected = {};

const secret = (name) => process.env[SECRETS[name].env] || saved[name] || detected[name] || '';
const setDetected = (name, url) => { detected[name] = String(url || ''); };
const secretFromEnv = (name) => !!process.env[SECRETS[name].env];
const setSavedSecret = (name, value) => { saved[name] = String(value || '').trim(); };

// Все сразу — из базы при старте. Открытое из старой базы — шифруем на месте (а вход MyJDownloader — ещё и без пароля).
// Не расшифровалось — секрета как будто нет, но строку не трогаем: вернут прежний SECRETS_KEY — вернётся и он
async function loadSecrets(db) {
    for (const [name, { setting }] of Object.entries(SECRETS)) {
        const row = await db.get('SELECT value FROM settings WHERE key = ?', [setting]).catch(() => null);
        let value = unseal(row?.value, setting);
        if (value === null) {
            console.warn(`[Ключи] ${setting}: не расшифровать — ключ шифрования (SECRETS_KEY или _media/.secrets.key) сменился или недоступен; впишите заново в «Настройках»`);
            value = '';
        } else if (value && !String(row.value).startsWith(SEALED)) {
            if (name === 'myjd') value = myjdWithoutPassword(value);
            // Ключа шифрования нет (папка только для чтения) — работаем с открытым, как раньше, но говорим об этом
            try {
                await db.run('UPDATE settings SET value = ? WHERE key = ?', [seal(value, setting), setting]);
            } catch (e) {
                console.error('[Ключи]', e.message);
            }
        }
        setSavedSecret(name, value);
    }
}

// Для «Настроек»: задан ли, откуда, хвост
function describeSecret(name) {
    const value = secret(name);
    // Пароль копий, вход MyJDownloader и ключ seedbox хвостом не показываем — только «задан»
    const auto = !secretFromEnv(name) && !saved[name] && !!detected[name];
    return { set: !!value, fromEnv: secretFromEnv(name), tail: value && !['backup', 'myjd', 'seedbox', 'updater', 'pair'].includes(name) ? value.slice(-4) : '', ...(auto ? { auto: true } : {}), ...(name === 'myjd' && !secretFromEnv(name) ? myjdShown(saved.myjd) : {}) };
}

// Вход MyJDownloader из «Настроек» — почта, устройство и папка (без сумм для входа): форма заполняется ими, и поменять
// устройство или папку можно, не вводя всё заново
function myjdShown(value) {
    try {
        const { email = '', device = '', folder = '' } = JSON.parse(value || 'null') || {};
        return email ? { email, device, folder } : {};
    } catch { return {}; }
}

const SECRET_SETTINGS = Object.values(SECRETS).map((s) => s.setting);

module.exports = { SECRETS, SECRET_SETTINGS, secret, secretFromEnv, setSavedSecret, setDetected, loadSecrets, describeSecret, seal, unseal, myjdWithoutPassword };
