const { createClient } = require('redis');

// Кэш в памяти вместо Redis — REDIS_URL=memory: библиотеку тогда запускают одним контейнером
// (docker run, README). Те же команды, что зовёт сервер; после перезапуска кэш пустой — это только
// кэш: список игр, ответы сайтов, счётчик кредитов ScraperAPI за день
function memoryRedis() {
    const data = new Map();
    const live = (key) => {
        const e = data.get(key);
        if (e && e.exp && e.exp <= Date.now()) { data.delete(key); return undefined; }
        return e;
    };
    const ttl = (opts) => (opts?.EX ? Date.now() + opts.EX * 1000 : 0);
    // Просроченное убираем и без обращения к ключу — иначе память росла бы
    setInterval(() => { for (const key of [...data.keys()]) live(key); }, 10 * 60 * 1000).unref();
    return {
        isMemory: true,
        on() {},
        async connect() {},
        async quit() {},
        async flushDb() { data.clear(); return 'OK'; },
        async get(key) { const e = live(key); return e && typeof e.v === 'string' ? e.v : null; },
        async set(key, value, opts) { data.set(key, { v: String(value), exp: ttl(opts) }); return 'OK'; },
        async del(keys) { let n = 0; for (const key of [].concat(keys)) if (data.delete(key)) n++; return n; },
        async expire(key, sec) { const e = live(key); if (!e) return 0; e.exp = Date.now() + sec * 1000; return 1; },
        async incrBy(key, by) {
            const e = live(key);
            const n = (Number(e?.v) || 0) + by;
            data.set(key, { v: String(n), exp: e?.exp || 0 });
            return n;
        },
        async hmGet(key, fields) { const e = live(key); return fields.map((f) => (e?.v instanceof Map ? e.v.get(f) ?? null : null)); },
        async hSet(key, obj) {
            let e = live(key);
            if (!e || !(e.v instanceof Map)) { e = { v: new Map(), exp: 0 }; data.set(key, e); }
            for (const [f, v] of Object.entries(obj)) e.v.set(f, String(v));
            return Object.keys(obj).length;
        },
        async *scanIterator({ MATCH = '*' } = {}) {
            const re = new RegExp(`^${MATCH.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
            for (const key of [...data.keys()]) if (live(key) && re.test(key)) yield key;
        },
    };
}

// Один общий клиент Redis на всё приложение: раньше их было два (games.js и scraper.js)
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const redisClient = REDIS_URL === 'memory' ? memoryRedis() : createClient({ url: REDIS_URL });
// Без обработчика 'error' любой разрыв связи с Redis роняет весь процесс
redisClient.on('error', (err) => console.error('❌ [Redis] Ошибка:', err.message));
redisClient.connect().then(() => console.log(redisClient.isMemory ? '📦 [Кэш] В памяти, без Redis' : '📦 [Redis] Подключён')).catch(console.error);

const GAMES_LIST_KEY = 'api:games:list';

// Сокет отдаёт сюда server.js. Сброс кэша и рассылка «список изменился» —
// это одно и то же событие, поэтому живут в одном месте.
let io = null;
function setIo(instance) { io = instance; }
function getIo() { return io; }

// Список игр закэширован на 5 минут. Любое изменение библиотеки обязано сбросить кэш,
// иначе изменение увидят с задержкой до 5 минут.
async function invalidateGamesList() {
    try {
        await redisClient.del(GAMES_LIST_KEY);
    } catch (e) {
        console.error('❌ [Redis] Не удалось сбросить кэш списка:', e.message);
    }
    // Рассылаем событие о том, что список игр изменился
    if (io) {
        io.emit('library-changed');
    }
}

module.exports = { memoryRedis, redisClient, invalidateGamesList, GAMES_LIST_KEY, setIo, getIo };
