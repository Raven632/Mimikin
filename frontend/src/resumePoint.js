import { useEffect, useState } from 'react';
import { slotName } from './saveSlots';

// Откуда продолжить игру: её сейвы (слоты, у каждого — нынешняя версия) и моменты (rpg-fixes, «Запомнить момент»).
// slots — от свежих к старым, только с нынешним сейвом; marks — так же. Не ответил сервер — пусто и failed.
// Точки перемотки сюда не идут: их игра ставит сама (перед боем, перед выбором), и «Продолжить» с них начинало бы
// прямо перед боем; снимок без сейва — не откуда продолжить. Кроме одной — «Где вышли» (exit: true), когда она свежее
// всех сейвов и моментов: сыгранное после перемотки без сохранения иначе потерялось бы, а сейв из брошенной ветки
// был бы «самым свежим»
export async function loadResume(id, signal) {
  let failed = false;
  const get = (url, empty) => fetch(url, { signal }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .catch(() => { failed = true; return empty; });
  const [hist, marks] = await Promise.all([
    get(`/api/saves/history/${encodeURIComponent(id)}`, { slots: [] }),
    get(`/api/marks/${encodeURIComponent(id)}`, []),
  ]);
  // Запуск отменили (Escape на чёрном экране): пустой ответ был бы принят за «нет сейвов» и игра бы запустилась
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const slots = (hist.slots || []).filter((s) => s.current).sort((a, b) => b.current.at - a.current.at);
  const all = Array.isArray(marks) ? marks : [];
  const own = all.filter((m) => m.kind !== 'auto' && m.save !== false);
  const exit = all.find((m) => m.kind === 'auto' && m.why === 'exit' && m.save !== false);
  const fresh = exit && (!own[0] || exit.at > own[0].at) && (!slots[0] || exit.at > slots[0].current.at);
  return { slots, marks: fresh ? [{ ...exit, exit: true }, ...own] : own, failed };
}

// Самое свежее: { slot, at, name } или { mark, at, name }, нет ни сейвов, ни моментов — null
export function latestOf({ slots, marks }, t) {
  const s = slots[0];
  const m = marks[0];
  if (!s && !m) return null;
  if (m && (!s || m.at > s.current.at)) return { mark: m.id, at: m.at, name: m.exit ? m.map || m.label || '' : m.label || m.map || '', kind: m.exit ? 'exit' : 'moment' };
  return { slot: s.key, at: s.current.at, name: [slotName(s.key, t), s.current.summary?.map].filter(Boolean).join(', '), kind: 'save' };
}

// Откуда запускать с этой точки (аргумент launchGame): сейв — slot, момент и «Где вышли» — mark; точки нет — с титула
export const launchPoint = (point) => (point ? (point.slot ? { slot: point.slot } : { mark: point.mark }) : {});

// Для карточки «Продолжить»: что запустит «Играть». reload — номер, вырос — спросить заново. Ответ помним вместе с
// игрой: карточка перешла на другую игру — прежний не годится, пока не придёт новый. Сервер не ответил — остаётся
// прежний ответ этой игры (а не «с титула» молча)
export function useResumePoint(id, t, reload = 0) {
  const [state, setState] = useState({ id: null, point: null });
  useEffect(() => {
    let alive = true;
    if (!id) return undefined;
    loadResume(id).then((data) => {
      if (!alive) return;
      setState((prev) => (data.failed && prev.id === id ? prev : { id, point: latestOf(data, t) }));
    });
    return () => { alive = false; };
  }, [id, t, reload]);
  return state.id === id ? state.point : null;
}
