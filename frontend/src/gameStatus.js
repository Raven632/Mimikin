// Статус игры: вписанный руками, а если его нет — сам по себе, по наигранному. Руками статусы почти
// не ставят (на проде в сентябре 2026 — ни у одной из 89 игр), а «во что я сейчас играю» и «что ещё
// не начинал» видно и так:
//   playing — запускали за последние две недели и наиграли хотя бы 10 минут: запуск на пару минут
//             «посмотреть» — ещё не игра
//   new     — ни разу не запускали
// Вписанный руками главнее. Считаем на лету, в базе автоматический статус не хранится
const RECENT_MS = 14 * 24 * 3600 * 1000;
const PLAYED_SEC = 10 * 60;

export function autoStatus(game, now = Date.now()) {
  if (!game.lastPlayed && !game.playtime) return 'new';
  if (game.lastPlayed && now - game.lastPlayed < RECENT_MS && (game.playtime || 0) >= PLAYED_SEC) return 'playing';
  return '';
}

export const effectiveStatus = (game, now) => game.status || autoStatus(game, now);
