import { useSyncExternalStore } from 'react';
import { httpError } from './apiError';

// Языки, которые человек знает (api/src/routes/settings.js, «Настройки → Общие»): коды вроде 'en'.
// Игры на этих языках не предлагаем переводить. Одно общее хранилище, как у любимых тегов
export const KNOWN_LANGS = ['en', 'ru', 'de', 'ja', 'zh', 'ko', 'es', 'fr', 'pt', 'it', 'pl', 'id'];

let langs = [];
const subs = new Set();
const emit = () => subs.forEach((fn) => fn());

export async function loadKnownLangs() {
  try {
    const res = await fetch('/api/settings/known-langs');
    if (!res.ok) return;
    langs = (await res.json()).langs || [];
    emit();
  } catch { /* нет связи — перевод предлагается как раньше */ }
}

export async function saveKnownLangs(next) {
  const res = await fetch('/api/settings/known-langs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ langs: next }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  langs = data.langs || [];
  emit();
  return langs;
}

export const useKnownLangs = () => useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn); }, () => langs);
