import { useEffect, useState } from 'react';
import { httpError } from './apiError';

// Вкладка «Найти»: что помним на этом устройстве и то, что спрашивают окна «Во что поиграть?» и настроек.

// --- Память: последний режим. Пишут только нажатия внутри «Найти»: переход с Главной или из поиска открывает своё и не
// должен менять то, что человек выбрал сам. Режимов два: выдача itch.io («sites») и «Отложенные» («list») ---
const MEMORY = 'rpg_find';
const MODES = ['sites', 'list'];

export const readFindMemory = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(MEMORY) || '{}');
    return { mode: MODES.includes(saved.mode) ? saved.mode : 'sites' };
  } catch {
    return { mode: 'sites' };
  }
};

export const writeFindMemory = (mode) => {
  try { localStorage.setItem(MEMORY, JSON.stringify({ mode })); } catch { /* приватный режим — просто не запомним */ }
};

// С чего открыть вкладку: с того, что выбрали в прошлый раз. Пустой список — не первый экран: смотреть там нечего
export function findStartTab({ wishEmpty = false } = {}) {
  const { mode } = readFindMemory();
  return mode === 'list' && !wishEmpty ? 'list' : 'itch';
}

// Ответов сайтов, которые стоило бы помнить, здесь нет: выдачу itch.io вкладка спрашивает сама. Окна зовут это после «Не предлагать» и
// скрытых тегов — оставлено, чтобы они не знали, что подбор с сайтов в этой сборке не живёт
export function forgetFindAnswers() {}

// «Не предлагать» и его отмена: своя игра по номеру, карточка сайта по ключу
export async function postDismiss(body) {
  const res = await fetch('/api/recommend/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, answer);
}

// Шапка «Найти» без походов в сеть: есть ли у сервера интернет. Ответа нет (или маршрута нет) — считаем, что есть: вкладка живёт и без него
export function useFindModes() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/recommend/modes').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setData(d); }, () => {});
    return () => { alive = false; };
  }, []);
  return { data };
}
