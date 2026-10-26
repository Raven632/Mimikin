// «Настройки → Службы»: по каждой службе — есть ли ключ, отвечает ли она, сколько осталось и когда
// лимит обновится. Остаток — у самой службы, где она его отдаёт бесплатно: DeepL (/v2/usage) и ScraperAPI
// (/account) — эти запросы ни знаков, ни кредитов не тратят. Microsoft и Google по одному ключу остаток не
// отдают — там наш счётчик (services/translate.js считает отправленные знаки), так и помечено (local).
// Telegram и LibreTranslate — только «отвечает ли». Ответ храним 5 минут: окно настроек открывают часто
const { secret } = require('../utils/secrets.js');

const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15 * 1000;

// Первое число следующего месяца (UTC) — так считает и наш счётчик (месяц по UTC)
const nextMonth = (now) => {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

// Следующая дата обновления подписки ScraperAPI: тот же день месяца, что у даты подписки
function nextRenewal(since, now) {
    const start = new Date(since);
    if (Number.isNaN(start.getTime())) return null;
    const d = new Date(now);
    let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(start.getUTCDate(), 28));
    if (at <= now) at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(start.getUTCDate(), 28));
    return at;
}

const getJson = async (url, headers = {}) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
};

class QuotaService {
    constructor() {
        this.translate = null;     // services/translate.js — счётчики Microsoft и Google, лимиты, проверка ключей
        this.scraper = null;       // services/scraper.js — дневной запас ScraperAPI
        this.telegram = null;
        this.cache = null;
        this.pending = null;
        this.generation = 0;        // растёт, когда сменили ключ: ответ, начатый раньше, в память не идёт
    }

    // Ключ сменился — сводку спросить заново
    invalidate() {
        this.generation++;
        this.cache = null;
        this.pending = null;
    }

    setDependencies({ translate, scraper, telegram }) {
        Object.assign(this, { translate, scraper, telegram });
    }

    // ok: true — отвечает и принял ключ, false — не принял, null — не ответил или проверить нельзя
    async deepl() {
        const key = secret('deepl');
        if (!key) return { key: false };
        const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
        try {
            const r = await getJson(`${host}/v2/usage`, { Authorization: `DeepL-Auth-Key ${key}` });
            if (r.status === 403) return { key: true, ok: false };
            if (!r.ok || !r.data) return { key: true, ok: null };
            const used = Number(r.data.character_count) || 0;
            const limit = Number(r.data.character_limit) || 0;
            // Pro отдаёт границы расчётного периода; бесплатный — нет: тогда «в начале месяца подписки»
            const end = Date.parse(r.data.end_time || '') || null;
            return { key: true, ok: true, unit: 'chars', used, limit, left: Math.max(0, limit - used), resetAt: end, from: 'service' };
        } catch (e) {
            return { key: true, ok: null };
        }
    }

    async scraperapi(now) {
        const key = secret('scraper');
        if (!key) return { key: false };
        const today = this.scraper ? await this.scraper.scraperDayState() : null;
        try {
            const r = await getJson(`https://api.scraperapi.com/account?api_key=${encodeURIComponent(key)}`);
            if (r.status === 401 || r.status === 403) return { key: true, ok: false, today };
            if (!r.ok || !r.data) return { key: true, ok: null, today };
            const used = Number(r.data.requestCount) || 0;
            const limit = Number(r.data.requestLimit) || 0;
            return {
                key: true, ok: true, unit: 'credits', used, limit, left: Math.max(0, limit - used),
                resetAt: nextRenewal(r.data.subscriptionDate, now), from: 'service', today,
            };
        } catch (e) {
            return { key: true, ok: null, today };
        }
    }

    // Microsoft, Google: остатка служба не отдаёт — наш счётчик за месяц и бесплатный лимит
    async counted(engine, now) {
        if (!secret(engine)) return { key: false };
        const used = await this.translate.usage(engine, now);
        const limit = this.translate.FREE[engine] || 0;
        const exhausted = await this.translate.exhausted(engine, now);
        // «Отвечает ли» по ключу не узнать без перевода (знаки) — ok неизвестно; кончился лимит — служба сказала сама
        return {
            key: true, ok: null, exhausted, unit: 'chars', used, limit,
            left: exhausted ? 0 : Math.max(0, limit - used), resetAt: nextMonth(now), from: 'local',
        };
    }

    async libre() {
        const value = secret('libre');
        if (!value) return { key: false };
        const [url] = value.split('|');
        try {
            const r = await getJson(`${url.replace(/\/+$/, '')}/languages`);
            return { key: true, ok: r.ok ? true : null, unit: 'chars', limit: 0, from: 'service' };
        } catch (e) {
            return { key: true, ok: null };
        }
    }

    async telegramState() {
        const token = secret('telegram');
        if (!token || !this.telegram) return { key: !!token };
        const r = await this.telegram.checkToken(token).catch(() => null);
        return { key: true, ok: r ? r.ok : null };
    }

    // Сводка: { at, services: { deepl: {…}, … } }. fresh — спросить заново, а не из памяти
    async report({ fresh = false, now = Date.now() } = {}) {
        if (!fresh && this.cache && now - this.cache.at < TTL_MS) return this.cache;
        if (!this.pending) {
            const gen = this.generation;
            const run = (async () => {
                const [deepl, microsoft, google, libre, scraper, telegram] = await Promise.all([
                    this.deepl(), this.counted('microsoft', now), this.counted('google', now), this.libre(),
                    this.scraperapi(now), this.telegramState(),
                ]);
                const result = { at: now, services: { deepl, microsoft, google, libre, scraper, telegram } };
                if (gen === this.generation) this.cache = result;
                return result;
            })().finally(() => { if (this.pending === run) this.pending = null; });
            this.pending = run;
        }
        return this.pending;
    }
}

module.exports = new QuotaService();
module.exports.QuotaService = QuotaService;
module.exports.nextRenewal = nextRenewal;
