// Игры на RPG Maker с itch.io — для окна «Новинки».
//
// Список — из RSS-лент каталога itch.io: они открыты серверу, в отличие от страниц игр.
// В лентах нет поиска по названию, тегов у игр и оценок — только выдача по тегу.
// Подробности игры (кадры, теги, оценка, описание) — со страницы через ScraperAPI,
// когда игру открывают, и с кэшем на неделю: страница стоит 10 кредитов.
// itch.io быстро отвечает «слишком часто»: ленты кэшируем на полчаса, а после отказа
// минуту не спрашиваем вовсе

const { scraperKey } = require('../utils/scraperKey.js');
const { redisClient } = require('../utils/cache.js');
const { itchGameUrl, parseItchRss } = require('../utils/itch.js');
const scraperService = require('./scraper.js');

const ITCH_PAGE_CREDITS = 10;                         // цена страницы игры у ScraperAPI

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
// Порядок в каталоге: «популярные» — без слова в адресе
const SORTS = { popular: '', newest: 'newest', 'top-rated': 'top-rated', 'top-sellers': 'top-sellers', featured: 'featured' };
const PERIODS = { 7: 'last-7-days', 30: 'last-30-days' };
// Теги, которые точно есть в каталоге itch.io (проверено запросом каждого): по пустым тегам
// выдача была бы пустой
const TAGS = [
    'female-protagonist', 'horror', 'psychological-horror', 'fantasy', 'jrpg', 'pixel-art', 'story-rich', 'short',
    'mystery', 'comedy', 'cute', 'dark', 'exploration', 'turn-based',
];
const FEED_TTL = 1800;
const PAUSE_MS = 60 * 1000;

class ItchService {
    constructor() {
        this.dbService = null;
        this.pausedUntil = 0;
    }

    setDependencies(dbService) {
        this.dbService = dbService;
    }

    // Адрес ленты: «/games/newest/last-7-days/free/made-with-rpg-maker/on-sale/platform-web/tag-fantasy.xml».
    // Если порядок частей itch.io видит иначе, он переадресует на свой — fetch пройдёт следом
    feedUrl({ sort = 'popular', days = 0, price = '', web = false, tags = [], page = 1 }) {
        const parts = ['games'];
        if (SORTS[sort]) parts.push(SORTS[sort]);
        if (PERIODS[days]) parts.push(PERIODS[days]);
        if (price === 'free') parts.push('free');
        parts.push('made-with-rpg-maker');
        if (price === 'sale') parts.push('on-sale');
        if (web) parts.push('platform-web');
        for (const tag of tags) parts.push(`tag-${tag}`);
        return `https://itch.io/${parts.join('/')}.xml${page > 1 ? `?page=${page}` : ''}`;
    }

    // Ссылки itch.io у игр библиотеки: что из каталога у нас уже есть
    async libraryGames() {
        const rows = await this.dbService.get().all("SELECT id, link FROM games WHERE ready = 1 AND link LIKE '%.itch.io/%'");
        const map = new Map();
        for (const row of rows) {
            const url = itchGameUrl(row.link);
            if (url && !map.has(url)) map.set(url, row.id);
        }
        return map;
    }

    // Параметры приходят из адреса запроса — проверяем каждый
    async latest(query = {}) {
        const opts = {
            page: Math.min(Math.max(parseInt(query.page, 10) || 1, 1), 100),
            sort: Object.prototype.hasOwnProperty.call(SORTS, query.sort) ? query.sort : 'popular',
            days: PERIODS[query.days] ? Number(query.days) : 0,
            price: ['free', 'sale'].includes(query.price) ? query.price : '',
            web: query.web === '1' || query.web === 'true',
            tags: [...new Set(String(query.tags || '').split(','))].filter((t) => TAGS.includes(t)).slice(0, 3),
        };
        const url = this.feedUrl(opts);
        const key = `itch:feed:${url}`;
        let items = null;
        try { items = JSON.parse(await redisClient.get(key) || 'null'); } catch (e) {}
        if (!items) {
            if (Date.now() < this.pausedUntil) throw Object.assign(new Error('itch.io просит подождать'), { limited: true });
            const res = await globalThis.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
            if (res.status === 429) {
                this.pausedUntil = Date.now() + PAUSE_MS;
                throw Object.assign(new Error('itch.io просит подождать'), { limited: true });
            }
            if (!res.ok) throw new Error(`itch.io ответил ${res.status}`);
            items = parseItchRss(await res.text());
            try { await redisClient.set(key, JSON.stringify(items), { EX: FEED_TTL }); } catch (e) {}
        }
        const lib = await this.libraryGames();
        return {
            page: opts.page,
            // Сколько всего страниц, лента не говорит: полная страница — значит, есть и следующая
            more: items.length >= 30,
            items: items.map((item) => (lib.has(item.url) ? { ...item, game: { id: lib.get(item.url) } } : item)),
        };
    }

    // Подробности игры — со страницы, тем же путём и с тем же кэшем, что и поиск данных для
    // библиотеки. Нужен ScraperAPI; без ключа — null
    async details(rawUrl) {
        if (!itchGameUrl(rawUrl)) throw Object.assign(new Error('Не ссылка на игру itch.io'), { bad: true });
        return scraperService.fetchItchMetadata(rawUrl);
    }

    // Страница игры стоит 10 кредитов ScraperAPI (заголовок ответа sa-credit-cost). Осталось на
    // сегодня меньше — страницы до завтра не будет, и окно скажет почему, а не «не открылась»
    async budgetSpent() {
        return (await scraperService.scraperCreditsLeft()) < ITCH_PAGE_CREDITS;
    }

    catalogMeta() {
        return { tags: TAGS, details: !!scraperKey() };
    }
}

module.exports = new ItchService();
