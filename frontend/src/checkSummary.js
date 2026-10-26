// Полная проверка библиотеки (api/src/services/fullcheck.js): то, что о ней пишут и окно ревизии
// (components/LibraryCheck.jsx), и App — полоса под шапкой и уведомление в конце

// 4520000 мс → «1 ч 15 мин», 720000 → «12 мин», меньше минуты — словами
export function formatDuration(ms, t) {
  const min = Math.round(ms / 60e3);
  if (min < 1) return t.check_under_minute;
  const h = Math.floor(min / 60);
  return h ? `${h} ${t.unit_h} ${min % 60} ${t.unit_min}` : `${min} ${t.unit_min}`;
}

// Сколько займёт, в минутах: как в прошлый раз, а если полных проверок ещё не было (прошлую прервали
// или остановили) — по числу игр. Почти всё время уходит на поиск данных заново, около полуминуты на игру
export function checkEstimate(check, games) {
  if (check?.finishedAt && !check.interrupted && !check.cancelled) return Math.max(1, Math.round((check.finishedAt - check.startedAt) / 60e3));
  return Math.max(5, Math.round(games * 0.45));
}

// Шаг, который сейчас идёт, и его номер. Между шагами (один кончился, следующий ещё не начат) —
// следующий: полоса под шапкой не мигает
export function currentStep(check) {
  const steps = check?.steps || [];
  let i = steps.findIndex((s) => s.status === 'running');
  if (i < 0) i = steps.findIndex((s) => s.status === 'pending');
  return i < 0 ? null : { step: steps[i], index: i, count: steps.length };
}

// Итог одной строкой — для уведомления, когда проверка закончилась или её остановили
export function checkSummary(check, t) {
  const by = Object.fromEntries((check.steps || []).map((s) => [s.key, s.result || {}]));
  const counts = {
    changed: by.sources?.changed?.length || 0,
  };
  const parts = Object.entries(counts).filter(([, n]) => n).map(([key, n]) => t.check_toast_parts[key](n));
  const problems = (check.steps || []).some((s) => s.status === 'error' || s.status === 'partial');
  const head = check.cancelled ? t.check_toast_cancelled : t.check_toast;
  return [head(parts.join(', ')), problems ? t.check_toast_problems : ''].filter(Boolean).join('; ');
}
