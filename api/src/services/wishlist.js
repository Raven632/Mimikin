// Список «Хочу поиграть»: игры из окна новинок (itch.io), отложенные на потом.
//
// Игру откладывают со всем, что о ней показывало окно новинок (обложка, цена, платформы,
// описание), и список рисуется без походов на сайт. Игра, которая уже есть в библиотеке
// (её itch.io-ссылка стоит у игры), помечается: из списка её можно убрать.

const { getIo } = require('../utils/cache.js');
const { itchGameUrl } = require('../utils/itch.js');

// Картинки — только с сайта источника: адрес уходит в <img> как есть
const IMAGE_HOSTS = ['img.itch.zone'];
const ITCH_PLATFORMS = ['windows', 'osx', 'linux', 'android', 'html'];
const MAX_ITEMS = 500;

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const list = (v, fn, max) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter(Boolean) : []);
const oneOf = (values) => (v) => (values.includes(v) ? v : '');
const image = (v) => {
    try {
        const u = new URL(String(v || ''));
        return u.protocol === 'https:' && IMAGE_HOSTS.includes(u.hostname) ? u.href : '';
    } catch (e) {
        return '';
    }
};

// Что сохраняем об игре: только известные поля, каждое проверено. Адрес страницы собираем сами
// из адреса игры — присланному не верим
function normalize(body = {}) {
    if (body.source !== 'itch') return null;
    const url = itchGameUrl(body.url);
    if (!url) return null;
    return {
        key: `itch:${url}`, source: 'itch', ref: url, url,
        info: {
            title: str(body.title), cover: image(body.cover), screens: list(body.screens, image, 8),
            creator: str(body.creator, 100), genre: str(body.genre, 50), price: str(body.price, 20),
            platforms: list(body.platforms, oneOf(ITCH_PLATFORMS), 5), description: str(body.description, 400),
            createdAt: num(body.createdAt), updatedAt: num(body.updatedAt),
        },
    };
}

class WishlistService {
    constructor() {
        this.dbService = null;
        this.sources = null;                            // { itch } — чьи игры уже в библиотеке
    }

    setDependencies(dbService, sources) {
        this.dbService = dbService;
        this.sources = sources;
    }

    db() {
        return this.dbService.get();
    }

    view(row) {
        return {
            key: row.key, source: row.source, ref: row.ref, url: row.url,
            info: JSON.parse(row.info || '{}'), addedAt: row.addedAt,
        };
    }

    // Список с отметкой «уже в библиотеке»: скачал игру — видно, что из списка её можно убрать
    async list() {
        const rows = await this.db().all('SELECT * FROM wishlist ORDER BY addedAt DESC');
        const library = await this.sources.itch.libraryGames();
        const items = rows.map((row) => {
            const item = this.view(row);
            if (library.has(item.ref)) item.game = { id: library.get(item.ref) };
            return item;
        });
        return { items };
    }

    async add(body) {
        const entry = normalize(body);
        if (!entry) throw Object.assign(new Error('Это не игра из новинок'), { bad: true });
        const db = this.db();
        const exists = await db.get('SELECT key FROM wishlist WHERE key = ?', [entry.key]);
        if (!exists && (await db.get('SELECT COUNT(*) AS n FROM wishlist')).n >= MAX_ITEMS) {
            throw Object.assign(new Error(`В списке уже ${MAX_ITEMS} игр`), { bad: true });
        }
        await db.run(
            `INSERT INTO wishlist (key, source, ref, url, info, addedAt) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET url = excluded.url, info = excluded.info`,
            [entry.key, entry.source, entry.ref, entry.url, JSON.stringify(entry.info), Date.now()]
        );
        this.changed();
        return this.view(await db.get('SELECT * FROM wishlist WHERE key = ?', [entry.key]));
    }

    async remove(key) {
        const res = await this.db().run('DELETE FROM wishlist WHERE key = ?', [String(key || '')]);
        if (res.changes) this.changed();
        return res.changes > 0;
    }

    // Другое устройство тоже держит список открытым — пусть перечитает
    changed() {
        getIo()?.emit('wishlist-changed');
    }
}

module.exports = new WishlistService();
module.exports.normalize = normalize;
