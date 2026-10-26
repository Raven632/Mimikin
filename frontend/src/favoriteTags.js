import { useSyncExternalStore } from 'react';
import { httpError } from './apiError';

// Любимые теги (api/src/routes/settings.js, «Настройки → Общие»): названия маленькими буквами.
// По ним — отметка у игр с сайтов и в окне игры, и с них начинается подборка «Для вас».
// Одно общее хранилище: поменяли в настройках — отметки везде обновились сразу
let tags = [];
const subs = new Set();
const emit = () => subs.forEach((fn) => fn());

export async function loadFavoriteTags() {
  try {
    const res = await fetch('/api/settings/favorite-tags');
    if (!res.ok) return;
    tags = (await res.json()).tags || [];
    emit();
  } catch { /* нет связи — отметок просто не будет */ }
}

export async function saveFavoriteTags(next) {
  const res = await fetch('/api/settings/favorite-tags', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: next }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  tags = data.tags || [];
  emit();
  return tags;
}

export const useFavoriteTags = () => useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn); }, () => tags);

// Любимые среди тегов игры — по названию без регистра. Теги бывают строками и
// объектами { name }
export function favoritesOf(list, favorites) {
  if (!favorites.length) return [];
  const names = (list || []).map((x) => (typeof x === 'string' ? x : x?.name || ''));
  return names.filter((name) => favorites.includes(name.toLowerCase()));
}
