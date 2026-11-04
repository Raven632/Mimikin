// Сколько дней ещё лежат в корзине файлы игры с полки (services/trash.js: 30 дней). 0 — их там уже нет
export function shelfDaysLeft(game, now = Date.now()) {
  const shelf = game?.shelf;
  if (!shelf?.key || shelf.until <= now) return 0;
  return Math.max(1, Math.ceil((shelf.until - now) / 864e5));
}
