// Библиотека: список игр, их поля, полка, корзина, подборки. Всё, что меняет посетитель, живёт в памяти страницы
// (store) и пропадает с перезагрузкой. Ответы и проверки — как у api/src/routes/games.js, но без диска и без поиска данных.
import { fail, off } from '../router.js';
import {
  KEEP_MS, DAY, bodyOf, gamesOf, gameOf, libraryChanged, trashOf, guardLogin, text,
} from './lib.js';

const STATUSES = ['', 'playing', 'done', 'dropped', 'wish'];
const NOTES_MAX = 5000;
const SERIES_MAX = 120;
const LIST_NAME_MAX = 60;
const LISTS_PER_GAME = 50;

const cleanName = (x) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : '');
const goodName = (name) => name.length > 0 && name.length <= LIST_NAME_MAX;

// Запись корзины: как её отдаёт services/trash.js (list). Для файлов с полки shelf = true, для удалённой игры — false
const trashItem = (game, key, now, shelf) => ({
  key, id: game.id, title: game.title || game.id, cover: game.cover || null,
  deletedAt: now, purgeAt: now + KEEP_MS, daysLeft: 30, size: game.size || 0, playtime: game.playtime || 0,
  taken: false, vanished: false, shelf,
});

export default function register(r) {
  // После «Выйти» список не отдаётся, и страница показывает вход (App.fetchGames)
  r.rec('GET', '/api/games', {}, guardLogin);

  r.mut('POST', '/api/games/:id/meta', async (ctx) => {
    const game = await gameOf(ctx, ctx.params.id);
    const { rating, lastPlayed, status, favorite, notes, lists } = bodyOf(ctx);
    // Статус приходит из браузера — только известные значения, как на сервере
    if (status !== undefined && !STATUSES.includes(status)) throw fail(400, 'Неизвестный статус');
    if (notes !== undefined && (typeof notes !== 'string' || notes.length > NOTES_MAX)) throw fail(400, 'Слишком длинная заметка');
    let clean = null;
    if (lists !== undefined) {
      clean = Array.isArray(lists) && lists.length <= LISTS_PER_GAME ? [...new Set(lists.map(cleanName))] : null;
      if (!clean || !clean.every(goodName)) throw fail(400, 'Неверные подборки');
    }
    if (rating !== undefined) game.rating = Number(rating) || 0;
    if (lastPlayed !== undefined) game.lastPlayed = Number(lastPlayed) || 0;
    if (status !== undefined) game.status = status;
    if (favorite !== undefined) game.favorite = !!favorite;
    if (notes !== undefined) game.notes = notes;
    if (clean) game.lists = clean;
    libraryChanged(ctx);
    return { success: true };
  });

  r.mut('POST', '/api/games/:id/series', async (ctx) => {
    const game = await gameOf(ctx, ctx.params.id);
    const series = text(bodyOf(ctx).series, SERIES_MAX);
    // Без единой буквы и цифры ключ серии пуст, и разные такие серии склеились бы в одну
    // eslint-disable-next-line no-control-regex
    if (series === null || /[\u0000-\u001f\u007f]/.test(series) || (series && !/[\p{L}\p{N}]/u.test(series))) throw fail(400, 'Неверное имя серии');
    game.series = series;
    libraryChanged(ctx);
    return { success: true, series };
  });

  // Переименовать подборку (to) или убрать её (to нет): игры остаются. Где подборка to уже есть, они сливаются
  r.mut('POST', '/api/games/lists/change', async (ctx) => {
    const body = bodyOf(ctx);
    const from = cleanName(body.from);
    const to = cleanName(body.to);
    if (!goodName(from) || (body.to !== undefined && !goodName(to))) throw fail(400, 'Неверное имя подборки');
    let changed = 0;
    for (const game of await gamesOf(ctx)) {
      if (!game.lists?.includes(from)) continue;
      game.lists = [...new Set(game.lists.flatMap((x) => (x === from ? (to ? [to] : []) : [x])))];
      changed++;
    }
    if (changed) libraryChanged(ctx);
    return { changed };
  });

  // «Изменить»: поля пишутся сразу. Искать новые данные по ссылкам нечем — об этом заметка, а сами поля остаются
  r.mut('POST', '/api/games/:id/edit', async (ctx) => {
    const game = await gameOf(ctx, ctx.params.id);
    const { title, developer, language, releaseDate, link, myVersion } = bodyOf(ctx);
    if (typeof title === 'string' && title.trim()) { game.title = title.trim(); game.displayTitle = title.trim(); }
    if (typeof developer === 'string') game.developer = developer;
    if (typeof language === 'string') game.language = language;
    if (typeof releaseDate === 'string') game.releaseDate = releaseDate;
    if (typeof myVersion === 'string') game.myVersion = myVersion.trim().slice(0, 40);
    const linkChanged = typeof link === 'string' && link !== (game.link || '');
    if (typeof link === 'string') game.link = link;
    libraryChanged(ctx);
    if (linkChanged) throw off('lookup');
    const keep = ['title', 'displayTitle', 'originalTitle', 'version', 'myVersion', 'cover', 'developer', 'language', 'releaseDate', 'link', 'tags', 'description', 'screens', 'meta'];
    return { success: true, found: false, failed: [], game: Object.fromEntries(keep.map((k) => [k, game[k]])) };
  });

  // --- Полка и корзина (services/trash.js) ---
  r.mut('POST', '/api/games/:id/shelf', async (ctx) => {
    const game = await gameOf(ctx, ctx.params.id);
    if (game.shelf) throw fail(404, 'Игра не найдена');
    const now = ctx.now();
    const key = `${now}-${game.id}`;
    game.shelf = { at: now, key, until: now + KEEP_MS };
    (await trashOf(ctx)).unshift(trashItem(game, key, now, true));
    libraryChanged(ctx);
    return { success: true, trashKey: key };
  });
  // «Похоже, это … с полки» бывает только у загруженной игры, а загружать в демо нечего
  r.off('POST', '/api/games/:id/shelf-match', 'upload');

  // В корзину, а не насовсем: ключ в ответе нужен тосту «Отменить»
  r.mut('DELETE', '/api/games/:id', async (ctx) => {
    const games = await gamesOf(ctx);
    const at = games.findIndex((g) => g.id === ctx.params.id);
    if (at < 0) throw fail(404, 'Игра не найдена');
    const [game] = games.splice(at, 1);
    const trash = await trashOf(ctx);
    // Игра с полки: её файлы в корзине переходят в эту же запись, отдельной больше нет
    const shelved = trash.findIndex((i) => i.key === game.shelf?.key);
    if (shelved >= 0) trash.splice(shelved, 1);
    const now = ctx.now();
    const key = `${now}-${game.id}`;
    trash.unshift(trashItem(game, key, now, false));
    ctx.store.state.trashed.set(key, game);
    libraryChanged(ctx);
    return { success: true, trashKey: key };
  });

  // ?count=1 — только число (строка состояния в «Настройках»). Считается из памяти, а не читается из записи: убрал игру — число другое
  r.calc('GET', '/api/games/trash', async (ctx) => {
    const items = await trashOf(ctx);
    if (ctx.query.count) return { count: items.length };
    const now = ctx.now();
    return { items: items.map((i) => ({ ...i, daysLeft: Math.max(1, Math.ceil((i.purgeAt - now) / DAY)) })) };
  });

  r.mut('POST', '/api/games/trash/:key/restore', async (ctx) => {
    const trash = await trashOf(ctx);
    const item = trash.find((i) => i.key === ctx.params.key);
    if (!item) throw fail(404, 'Нет такой записи в корзине');
    const games = await gamesOf(ctx);
    const taken = () => fail(409, 'Игра с такой папкой уже есть в библиотеке');
    if (item.shelf) {
      // Файлы с полки встают к своей карточке: игра снова играется
      const card = games.find((g) => g.id === item.id);
      if (!card?.shelf) throw taken();
      card.shelf = null;
    } else {
      const game = ctx.store.state.trashed.get(item.key);
      if (!game) throw fail(404, 'Нет такой записи в корзине');
      if (games.some((g) => g.id === item.id)) throw taken();
      games.push(game);
      // Список приходит по номеру игры: вернувшаяся встаёт на своё место
      games.sort((a, b) => (a.number || 0) - (b.number || 0));
      ctx.store.state.trashed.delete(item.key);
    }
    trash.splice(trash.indexOf(item), 1);
    libraryChanged(ctx);
    return { success: true, id: item.id };
  });

  // Стереть: у игры с полки уходят только файлы, карточка остаётся (без «Вернуть» в окне игры)
  r.mut('DELETE', '/api/games/trash/:key', async (ctx) => {
    const trash = await trashOf(ctx);
    const at = trash.findIndex((i) => i.key === ctx.params.key);
    if (at < 0) throw fail(404, 'Нет такой записи в корзине');
    const [item] = trash.splice(at, 1);
    if (item.shelf) {
      const card = (await gamesOf(ctx)).find((g) => g.id === item.id);
      if (card?.shelf?.key === item.key) { card.shelf = { at: card.shelf.at, key: '', until: 0 }; libraryChanged(ctx); }
    }
    ctx.store.state.trashed.delete(item.key);
    return { success: true };
  });

  // --- Окно игры: записанное как есть ---
  r.rec('GET', '/api/games/space');
  r.rec('GET', '/api/games/audit');
  r.rec('GET', '/api/games/:id/old');
  r.rec('GET', '/api/games/:id/archive-info');
  r.rec('GET', '/api/games/:id/lookup');
  r.rec('GET', '/api/games/lookup-queue');

  // --- Что в демо не работает: нет сервера, диска и интернета ---
  r.off('POST', '/api/games/:id/old/restore', 'server');
  r.off('DELETE', '/api/games/:id/old', 'server');
  r.off('GET', '/api/games/:id/archive', 'download');
  r.off('POST', '/api/games/:id/cover', 'files');
  r.off('DELETE', '/api/games/:id/cover', 'files');
  r.off('GET', '/api/games/:id/cover/found', 'lookup');
  r.off('POST', '/api/games/:id/rescrape', 'lookup');
  r.off('POST', '/api/games/rescan', 'lookup');
  r.off('POST', '/api/games/lookup-queue/pause', 'lookup');
  r.off('GET', '/api/games/duplicates/plan', 'server');
  r.off('POST', '/api/games/duplicates/merge', 'server');
  r.off('POST', '/api/games/duplicates/dismiss', 'server');
  r.off('POST', '/api/games/upload-match', 'upload');
  // Загрузки: список пуст (так выглядит сервер, которому никто ничего не грузит), остальное — заметка
  r.calc('GET', '/api/games/upload/list', () => []);
  r.off('GET', '/api/games/upload/status', 'upload');
  for (const step of ['start', 'chunk', 'cancel', 'password', 'retry']) r.off('POST', `/api/games/upload/${step}`, 'upload');
}
