// Общее для обработчиков демо: игры и корзина в памяти, вход, разбор тела запроса. Чистый модуль (без window при загрузке):
// его читает и Node — проверка обработчиков и запись данных.
import { fail } from '../router.js';

export const DAY = 86400000;
// Срок корзины, как у настоящего сервера (services/trash.js, KEEP_MS)
export const KEEP_MS = 30 * DAY;

// Тело запроса как объект: форма (FormData) и пустое тело обработчикам не нужны, пусть читают поля и получают undefined
export const bodyOf = (ctx) => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) && !(ctx.body instanceof FormData) ? ctx.body : {});

// Вход после «Выйти»: страница перезагружается сама (App.handleLogout), поэтому флаг живёт в sessionStorage, а не в памяти.
// «Начать сначала» стирает sessionStorage целиком — и посетитель снова вошёл
const OUT = 'demo_out';
export const signedOut = () => { try { return sessionStorage.getItem(OUT) === '1'; } catch { return false; } };
export const setSignedOut = (on) => {
  try { if (on) sessionStorage.setItem(OUT, '1'); else sessionStorage.removeItem(OUT); } catch { /* закрытое хранилище — выхода не будет */ }
};
// Ответ сервера без входа (routes/auth.js, requireAuth)
export const needLogin = () => fail(401, 'Требуется авторизация');
// Первым это спрашивают /api/me и /api/games: после них страница показывает вход и больше ничего не просит
export const guardLogin = (ctx, body) => { if (signedOut()) throw needLogin(); return body; };

export const gamesOf = (ctx) => ctx.store.read('/api/games');
export async function gameOf(ctx, id) {
  const game = (await gamesOf(ctx)).find((g) => g.id === id);
  if (!game) throw fail(404, 'Игра не найдена');
  return game;
}
// Список игр поменялся: страница перечитывает его (сервер говорит то же событие)
export const libraryChanged = (ctx) => ctx.emit('library-changed');

// Корзина: записанные строки + то, что посетитель убрал или вернул. Лежит в store.state, пока открыта страница.
// trashed — снимки удалённых игр по ключу корзины: вернуть можно только то, что убрали здесь
export async function trashOf(ctx) {
  const state = ctx.store.state;
  if (!state.trash) {
    state.trash = [...((await ctx.store.read('/api/games/trash'))?.items || [])];
    state.trashed = new Map();
  }
  return state.trash;
}

// Записанные ответы, которых для части игр нет (у игры на полке нет галереи — сервер отвечает 404, и запись такого не хранит).
// Сервер на таком запросе тоже отвечает 404, а не «не записано», поэтому это calc, а не rec: без предупреждения [demo] unrecorded
export async function recordedOr404(ctx) {
  const body = await ctx.store.read(ctx.key);
  if (body === undefined) throw fail(404, 'Игра не найдена');
  return body;
}

// Строка из тела: обрезанная, не длиннее max; не строка — null
export const text = (v, max) => (typeof v === 'string' && v.trim().length <= max ? v.trim() : null);
