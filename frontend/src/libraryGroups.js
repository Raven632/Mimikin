import { effectiveStatus } from './gameStatus';

// Группы вкладки «Библиотека». Порядок внутри группы — тот, что задала сортировка: games приходят уже упорядоченными
export const GROUPS = ['none', 'status', 'list', 'date'];

const DAY = 24 * 3600 * 1000;
const STATUS_ORDER = ['playing', 'wish', 'new', 'done', 'dropped'];
const AGES = [['week', 7], ['month', 31], ['half', 183]];

function byStatus(games, t) {
  const rows = [...STATUS_ORDER.map((key) => ({ key, title: t[`status_${key}`], games: [] })),
    // Давно игранная без статуса: effectiveStatus даёт для неё пусто, а пропасть из библиотеки она не должна
    { key: 'other', title: t.select_no_status, games: [] },
    { key: 'shelf', title: t.shelf_label, games: [] }];
  const find = (key) => rows.find((row) => row.key === key);
  for (const game of games) (game.shelf ? find('shelf') : find(effectiveStatus(game)) || find('other')).games.push(game);
  return rows;
}

function byList(games, t) {
  const names = [...new Set(games.flatMap((g) => g.lists || []))].sort((a, b) => a.localeCompare(b));
  // Имя подборки — любое, поэтому ключ с приставкой: подборка не совпадёт с группой «без подборки»
  return [...names.map((name) => ({ key: `list:${name}`, title: name, games: games.filter((g) => g.lists?.includes(name)) })),
    { key: 'nolist', title: t.group_no_list, games: games.filter((g) => !g.lists?.length) }];
}

function byDate(games, t, now) {
  const rows = [...AGES, ['older', Infinity]].map(([key, days]) => ({ key, days, title: t[`group_${key}`], games: [] }));
  for (const game of games) {
    const age = game.addedAt ? (now - game.addedAt) / DAY : Infinity;
    rows.find((row) => age <= row.days).games.push(game);
  }
  return rows;
}

export function groupGames(games, mode, t, now = Date.now()) {
  const rows = mode === 'status' ? byStatus(games, t) : mode === 'list' ? byList(games, t) : byDate(games, t, now);
  return rows.filter((row) => row.games.length);
}

// Что нарисовать на этой странице: заголовки вперемешку с карточками, плоским списком. Считаются только карточки.
// У игры из двух подборок две карточки, поэтому ключ — с группой
export function pageOfGroups(groups, shut, limit) {
  const items = [];
  let n = 0;
  for (const group of groups) {
    const open = !shut.includes(group.key);
    // Страница кончилась ровно на прошлой группе: заголовок без карточек под ним появится вместе с ними
    if (open && n >= limit) break;
    items.push({ group, key: `group:${group.key}` });
    if (!open) continue;
    for (const game of group.games) {
      if (n >= limit) return items;
      items.push({ game, key: `${group.key}/${game.id}`, n });
      n += 1;
    }
  }
  return items;
}
