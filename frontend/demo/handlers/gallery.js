// Галерея, избранные картинки, «Сцены», лента и теги картинок. В этой версии демо нет альбомов-сцен, звуков и поиска
// картинок по словам (их записывает и считает вторая часть работы): окна открываются и показывают пустое состояние.
import { fail } from '../router.js';
import { bodyOf, gamesOf, recordedOr404 } from './lib.js';

// Виды картинок в избранном, как у сервера (server.js, FAVORITE_KINDS)
const FAVORITE_KINDS = ['cg', 'engine', 'animation', 'video', 'portrait', 'backdrop', 'layer', 'other'];

export default function register(r) {
  // Игра на полке без файлов: галереи у неё нет, сервер отвечает 404 — в записи таких ответов нет, отдаём то же
  r.calc('GET', '/api/gallery/:id', recordedOr404);
  r.calc('GET', '/api/gallery/:id/sounds', recordedOr404);
  r.calc('GET', '/api/gallery/:id/cast', recordedOr404);
  r.rec('GET', '/api/gallery/:id/inside');
  r.rec('GET', '/api/gallery/:id/tags');

  // Избранные картинки: общий список записан целиком, список одной игры считается из него (в записи и такой есть, но
  // поставил или снял сердечко — менять пришлось бы оба). Игры на полке в избранном не видны, как у сервера
  const favorites = async (ctx) => ctx.store.read('/api/favorites');
  r.calc('GET', '/api/favorites', async (ctx) => {
    const shelved = new Set((await gamesOf(ctx)).filter((g) => g.shelf).map((g) => g.id));
    const game = ctx.query.game;
    return (await favorites(ctx)).filter((f) => !shelved.has(f.game) && (!game || f.game === game));
  });
  r.mut('PUT', '/api/favorites', async (ctx) => {
    const { game, file, kind, frames, fps } = bodyOf(ctx);
    if (typeof game !== 'string' || typeof file !== 'string' || !file) throw fail(400, 'bad-file');
    const list = await favorites(ctx);
    const item = { game, file, kind: FAVORITE_KINDS.includes(kind) ? kind : '', at: ctx.now(), ...(Array.isArray(frames) && frames.length >= 2 ? { frames, fps: Math.min(60, Math.max(1, Number(fps) || 8)) } : {}) };
    const at = list.findIndex((f) => f.game === game && f.file === file);
    if (at >= 0) list.splice(at, 1);
    list.unshift(item);
    return { success: true };
  });
  r.mut('DELETE', '/api/favorites', async (ctx) => {
    const { game, f } = ctx.query;
    if (typeof game !== 'string' || typeof f !== 'string') throw fail(400, 'bad-file');
    const list = await favorites(ctx);
    const at = list.findIndex((x) => x.game === game && x.file === f);
    if (at >= 0) list.splice(at, 1);
    return { success: true };
  });

  // «Сцены» всей библиотеки: основа записана по виду (kind), сцен в этой версии демо нет — окно показывает «пока пусто»
  r.rec('GET', '/api/scenes', { q: ['kind'] });
  // Поиск по репликам идёт по записанным сценам; их нет — ответ «ничего не нашлось», как у сервера с пустым указателем
  r.calc('GET', '/api/lines/search', () => ({ total: 0, games: 0, indexed: 0, library: 0, building: false, scenes: [] }));

  // Картинки: анализ выключен (как у сервера без модели), лента и теги пусты
  r.rec('GET', '/api/pictures/status');
  r.rec('GET', '/api/pictures/games');
  r.rec('GET', '/api/pictures/feed');
  r.rec('GET', '/api/pictures/hidden');
  r.mut('POST', '/api/pictures/hidden', async (ctx) => {
    const body = bodyOf(ctx);
    const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x && x.length <= 100) : []);
    const hidden = await ctx.store.read('/api/pictures/hidden');
    const remove = new Set(names(body.remove));
    hidden.tags = [...new Set([...hidden.tags, ...names(body.add)])].filter((x) => !remove.has(x)).slice(0, 200);
    return { tags: hidden.tags };
  });
  r.off('GET', '/api/pictures/search', 'analysis');
  r.off('GET', '/api/pictures/similar', 'analysis');
  r.off('POST', '/api/pictures/by-image', 'analysis');
}
