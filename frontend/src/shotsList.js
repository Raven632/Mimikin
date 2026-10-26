import { useEffect, useState } from 'react';

// Снимки, моменты и перемотка игры (api/src/routes/marks.js) — для вкладки «Скриншоты» (ShotsPanel) и числа на ней.
// Список — тут же и для числа на вкладке: ответ сервера, перечитать — reload(). refresh сменился (открыли вкладку) —
// спросить заново: после игры там новые снимки и точки
export function useShots(gameId, refresh) {
  const [state, setState] = useState({ id: null, items: null, failed: false });
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(`/api/marks/${encodeURIComponent(gameId)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((items) => { if (alive) setState({ id: gameId, items: Array.isArray(items) ? items : [], failed: false }); })
      .catch(() => { if (alive) setState((s) => ({ id: gameId, items: s.id === gameId ? s.items : [], failed: true })); });
    return () => { alive = false; };
  }, [gameId, turn, refresh]);
  const items = state.id === gameId ? state.items : null;
  return { items, failed: state.failed, reload: () => setTurn((n) => n + 1) };
}
