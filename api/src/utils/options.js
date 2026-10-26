// Простые параметры, которые раньше задавались только в .env: теперь их можно и в «Настройках» (таблица settings,
// открытым текстом — это не секреты). Как у ключей (utils/secrets.js): задан в .env — он главный, в «Настройках» его
// видно, но не поменять. server.js читает сохранённые при старте, маршрут настроек — при сохранении
const OPTIONS = {
    // Дневной потолок кредитов ScraperAPI (services/scraper.js): 30 в день — около 1000 бесплатных в месяц
    scraper_daily_limit: { env: 'SCRAPER_DAILY_LIMIT', type: 'int', min: 1, max: 100000, def: 30 },
    // Свободного места меньше — предупреждение в Telegram (services/telegram.js)
    disk_warn_gb: { env: 'DISK_WARN_GB', type: 'int', min: 1, max: 100000, def: 10 },
    // Раз в 6 часов смотреть, не вышла ли новая версия (services/updates.js)
    update_check: { env: 'UPDATE_CHECK', type: 'bool', def: true },
};

const saved = {};

const parse = (o, raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    if (o.type === 'bool') return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
    const n = Number(raw);
    return Number.isInteger(n) && n >= o.min && n <= o.max ? n : undefined;
};

const option = (name) => {
    const o = OPTIONS[name];
    return parse(o, process.env[o.env]) ?? saved[name] ?? o.def;
};

// Из «Настроек»: проверенное значение или undefined (не годится); null — вернуть по умолчанию. Только проверка:
// в память — setOption, после того как значение записано в базу
const checkOption = (name, raw) => (raw === null ? null : parse(OPTIONS[name], typeof raw === 'boolean' || typeof raw === 'number' ? String(raw) : raw));

function setOption(name, raw) {
    const v = checkOption(name, raw);
    if (v === null) delete saved[name];
    else if (v !== undefined) saved[name] = v;
    return v;
}

async function loadOptions(db) {
    for (const name of Object.keys(OPTIONS)) {
        const row = await db.get('SELECT value FROM settings WHERE key = ?', [name]).catch(() => null);
        const v = parse(OPTIONS[name], row?.value);
        if (v !== undefined) saved[name] = v;
    }
}

// Для «Настроек»: значение, откуда оно и что по умолчанию
const describeOptions = () => Object.fromEntries(Object.entries(OPTIONS).map(([name, o]) => [name, {
    value: option(name), fromEnv: parse(o, process.env[o.env]) !== undefined, def: o.def, ...(o.type === 'int' ? { min: o.min, max: o.max } : {}),
}]));

module.exports = { OPTIONS, option, checkOption, setOption, loadOptions, describeOptions };
