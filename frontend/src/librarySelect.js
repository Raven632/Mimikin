import { useMemo, useRef, useState } from 'react';
import { confirmDialog } from './confirm';

// Сразу не больше четырёх запросов: на сотне выбранных игр иначе сервер получал бы сотню разом
const META_AT_ONCE = 4;
const NONE = new Set();

// От отмеченной раньше карточки до этой. Игра может стоять в двух группах: берём два ближайших её места, иначе Shift внутри одной группы
// захватывал бы всё от первой группы, где она встретилась
function rangeBetween(order, a, b) {
  const spots = (id) => order.flatMap((g, i) => (g.id === id ? [i] : []));
  let best = null;
  for (const x of spots(a)) {
    for (const y of spots(b)) {
      if (!best || Math.abs(x - y) < best[1] - best[0]) best = [Math.min(x, y), Math.max(x, y)];
    }
  }
  return best && order.slice(best[0], best[1] + 1);
}

// Выбор нескольких игр во вкладке «Библиотека». Отдельного маршрута на сервере нет: для каждой игры те же запросы, что и в её окне,
// поэтому человек и здесь меняет только свои отметки. shown — игры по текущим фильтрам, каждая один раз, и ещё не подгруженные тоже.
// order — карточки подряд, как на экране: в группах порядок другой, игра из двух подборок стоит дважды, а свёрнутых нет.
// «Выбрать все» идёт по order: действие не должно задевать игры из свёрнутой группы, которых человек не видит
export function useLibrarySelect({ shown, order, active, setGames, refresh, showToast, t }) {
  const [on, setOn] = useState(false);
  const [picked, setPicked] = useState(NONE);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const anchor = useRef(null);

  const chosen = useMemo(() => shown.filter((g) => picked.has(g.id)), [shown, picked]);
  const openIds = useMemo(() => [...new Set(order.map((g) => g.id))], [order]);
  // Прямо при рисовании, как страница при смене фильтров в App: ушла с вкладки — выбор кончился; фильтр убрал игру — и из выбора убрана
  if (on && !active) { setOn(false); setPicked(NONE); }
  else if (chosen.length !== picked.size) setPicked(new Set(chosen.map((g) => g.id)));

  const enter = () => setOn(true);
  const clear = () => { anchor.current = null; setPicked(NONE); };
  const exit = () => {
    if (running.current) return;
    clear();
    setOn(false);
  };
  const selectAll = () => { if (!running.current) setPicked(new Set(openIds)); };
  const toggle = (game, range) => {
    if (running.current) return;
    const span = range && anchor.current ? rangeBetween(order, anchor.current, game.id) : null;
    setPicked((prev) => {
      const next = new Set(prev);
      if (span) span.forEach((g) => next.add(g.id));
      else if (next.has(game.id)) next.delete(game.id);
      else next.add(game.id);
      return next;
    });
    anchor.current = game.id;
  };

  // Сбой одной игры не останавливает остальные. Не вышедшие остаются выбранными; их и подсчитает один общий тост
  const run = async (items, atOnce, job) => {
    running.current = true;
    setBusy(true);
    const failed = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const game = items[next++];
        try { await job(game); } catch { failed.push(game.id); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
    if (failed.length < items.length) await refresh();
    setPicked(new Set(failed));
    anchor.current = null;
    running.current = false;
    setBusy(false);
    const done = items.length - failed.length;
    if (failed.length) showToast(t.select_partial(done, failed.length), 'error');
    else showToast(t.select_done(done), 'success');
  };

  // Как patchGame в App: сначала на экране, потом на сервере. Не вышло — вернём только эти поля этой игры: остальное могло измениться
  const changeMeta = (patchOf) => {
    if (running.current || !chosen.length) return;
    const patches = new Map(chosen.map((g) => [g.id, patchOf(g)]));
    setGames((prev) => prev.map((g) => (patches.get(g.id) ? { ...g, ...patches.get(g.id) } : g)));
    run(chosen, META_AT_ONCE, async (game) => {
      const patch = patches.get(game.id);
      if (!patch) return;
      try {
        const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        if (!res.ok) throw new Error(String(res.status));
      } catch (e) {
        const before = Object.fromEntries(Object.keys(patch).map((key) => [key, game[key]]));
        setGames((prev) => prev.map((g) => (g.id === game.id ? { ...g, ...before } : g)));
        throw e;
      }
    });
  };
  const setStatus = (status) => changeMeta(() => ({ status }));
  const setRating = (rating) => changeMeta(() => ({ rating }));
  // Подборка добавляется к тем, что уже есть у игры: запрос заменяет список целиком
  const addToList = (name) => changeMeta((g) => (g.lists?.includes(name) ? null : { lists: [...(g.lists || []), name] }));

  const onDisk = chosen.filter((g) => !g.shelf);
  // По одной: каждая игра переносит файлы на диске. Кнопки отключены, пока это идёт, и второй перенос не начать
  const shelve = async () => {
    if (running.current || !onDisk.length) return;
    const items = onDisk;
    const ok = await confirmDialog({
      title: t.select_shelf_q,
      name: t.select_shelf_name(items.length),
      text: t.select_shelf_text,
      confirmLabel: t.shelf_confirm,
    });
    if (!ok || running.current) return;
    await run(items, 1, async (game) => {
      const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/shelf`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
    });
  };

  return {
    on, busy, count: chosen.length, allPicked: openIds.length > 0 && chosen.length === openIds.length && openIds.every((id) => picked.has(id)), diskCount: onDisk.length,
    isPicked: (id) => picked.has(id),
    enter, exit, clear, selectAll, toggle, setStatus, setRating, addToList, shelve,
  };
}
