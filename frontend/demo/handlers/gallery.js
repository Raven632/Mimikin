// Галерея, избранные картинки, «Сцены», плеер сцены, поиск по репликам и по картинкам словами, лента и теги картинок.
// Сцены, реплики и звуки записаны с четырёх игр; слова поиска — список, остальное отвечает подсказкой (texts.js).
import { fail } from '../router.js';
import { reqKey } from '../keys.js';
import { LINE_WORDS, noteText, pictureWord, wordsHint } from '../texts.js';
import { bodyOf, gamesOf, recordedOr404, visibleIds } from './lib.js';

// Виды картинок в избранном, как у сервера (server.js, FAVORITE_KINDS)
const FAVORITE_KINDS = ['cg', 'engine', 'animation', 'video', 'portrait', 'backdrop', 'layer', 'other'];
// Сцен в одной порции очереди «Смотреть подряд», как у сервера (libraryScenes.js, QUEUE)
const QUEUE = 300;

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

  // Плеер сцены: ответ записан по альбому, номеру сцены и языку интерфейса (lang выбранного перевода реплик на ответ не влияет)
  r.rec('GET', '/api/gallery/:id/scene', { q: ['key', 'n', 'ui'] });

  // «Сцены» всей библиотеки (services/libraryScenes.js): записаны строки по видам (kind), фильтры, «Ещё N сцен» и очередь
  // считаются здесь из них. Тегов у записанных кадров нет, поэтому выбор тега даёт «ничего», а «без тега» — всё
  const sceneRows = async (ctx) => {
    const seen = await visibleIds(ctx);
    const byGame = new Map();
    for (const kind of ['scenes', 'dialogue']) {
      for (const g of (await ctx.store.read(`/api/scenes?kind=${kind}`))?.games || []) {
        if (seen.has(g.id)) byGame.set(g.id, [...(byGame.get(g.id) || []), ...g.rows]);
      }
    }
    return byGame;
  };
  const names = (v) => [].concat(v || []).filter((x) => typeof x === 'string' && x.length <= 100).slice(0, 20);
  r.calc('GET', '/api/scenes', async (ctx) => {
    const { kind: k, game = '', queue } = ctx.query;
    const kind = ['scenes', 'dialogue'].includes(k) ? k : '';
    const voice = ctx.query.voice === '1';
    const anim = ctx.query.anim === '1';
    const tags = names(ctx.query.tag);
    const rows = await sceneRows(ctx);
    const fit = () => !tags.length;
    const any = (row) => (!voice || !!row.sum?.v) && (!anim || !!row.sum?.a);
    const kindOk = (row) => !kind || (kind === 'dialogue') === (row.kind === 'dialogue');

    if (queue === 'order' || queue === 'random') {
      const all = [];
      for (const [id, list] of rows) for (const row of list) if (any(row) && kindOk(row) && fit()) all.push({ game: id, key: row.key, n: row.n, title: row.title });
      if (queue === 'random') {
        for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
      }
      const start = queue === 'random' ? 0 : Math.max(0, parseInt(ctx.query.from, 10) || 0);
      return { queue: all.slice(start, start + QUEUE), more: queue !== 'random' && all.length > start + QUEUE };
    }
    const per = Math.min(12, Math.max(1, parseInt(ctx.query.per, 10) || 4));
    const counts = { all: 0, scenes: 0, dialogue: 0 };
    const games = [];
    for (const [id, list] of rows) {
      if (game && id !== game) continue;
      const mine = [];
      for (const row of list) {
        if (!fit() || !any(row)) continue;
        counts.all++;
        counts[row.kind === 'dialogue' ? 'dialogue' : 'scenes']++;
        if (kindOk(row)) mine.push(row);
      }
      if (mine.length) games.push({ id, count: mine.length, rows: game ? mine : mine.slice(0, per) });
    }
    const hidden = (await ctx.store.read('/api/pictures/hidden'))?.tags || [];
    return { total: games.reduce((sum, g) => sum + g.count, 0), counts, tags: [], games, hidden };
  });

  // Поиск по репликам идёт по записанным сценам: ответ записан для списка слов, для game и limit он урезается здесь.
  // Другое слово — отказ с подсказкой (приложение показывает её как «поиск не удался», см. lines_failed в texts.js)
  r.calc('GET', '/api/lines/search', async (ctx) => {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
    if (!q || q.length > 100) throw fail(400, 'bad-query');
    if ([...q].filter((c) => /\p{L}|\p{N}/u.test(c)).length < 3) throw fail(400, 'short');
    const word = q.toLowerCase();
    if (!LINE_WORDS.includes(word)) throw fail(409, wordsHint(ctx.lang, 'lines'), 'demo-off', { what: 'words' });
    const full = await ctx.store.read(reqKey('/api/lines/search', { q: word }, ['q']));
    if (!full) throw fail(404, 'bad-query');
    const seen = await visibleIds(ctx);
    const game = typeof ctx.query.game === 'string' ? ctx.query.game : '';
    const limit = Math.min(60, Math.max(1, parseInt(ctx.query.limit, 10) || 24));
    const games = full.games.filter((g) => seen.has(g.id) && (!game || g.id === game));
    return {
      ...full,
      total: games.reduce((sum, g) => sum + g.lines, 0),
      games,
      scenes: full.scenes.filter((x) => seen.has(x.game) && (!game || x.game === game)).slice(0, limit),
    };
  });

  // Картинки: анализ «включён и закончил» (так записан), лента и теги пусты — ей нужна модель тегов и случайный порядок
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
  // Поиск по словам: кадры записаны для слов из списка (модель CLIP на машине записи); русское и немецкое слово из списка
  // понимается как английское, и ответ говорит об этом в understood, как у сервера. Другое слово — подсказка со списком
  r.calc('GET', '/api/pictures/search', async (ctx) => {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
    if (!q || q.length > 100) throw fail(400, 'bad-query');
    const word = pictureWord(ctx.lang, q);
    if (!word) throw fail(409, wordsHint(ctx.lang, 'pictures'), 'demo-off', { what: 'words' });
    const full = await ctx.store.read(reqKey('/api/pictures/search', { q: word }, ['q']));
    // Запись без слов (DEMO_NO_WORDS=1): ответов нет — подсказка, а не пустая страница ошибки
    if (!full) throw fail(409, wordsHint(ctx.lang, 'pictures'), 'demo-off', { what: 'words' });
    const seen = await visibleIds(ctx);
    const from = Math.max(0, parseInt(ctx.query.from, 10) || 0);
    const limit = Math.min(60, Math.max(1, parseInt(ctx.query.limit, 10) || 24));
    const rows = full.results.filter((x) => seen.has(x.game));
    return { ...full, results: rows.slice(from, from + limit), more: rows.length > from + limit, ...(word !== q.toLowerCase() ? { understood: word } : {}) };
  });
  // «Похожие» считает та же модель, но по любому кадру — в демо записаны только слова
  r.calc('GET', '/api/pictures/similar', (ctx) => { throw fail(409, noteText(ctx.lang, 'similar'), 'demo-off', { what: 'similar' }); });
  r.off('POST', '/api/pictures/by-image', 'similar');
}
