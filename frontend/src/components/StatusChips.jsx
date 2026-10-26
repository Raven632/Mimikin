import { useEffect, useRef } from 'react';

// Быстрый фильтр по статусу. Живёт в одной строке с «Продолжить», а не отдельным
// рядом под поиском: справа от чипов было пустое место шириной в полэкрана.
// «Играю» и «Не начата» считаются и сами, по наигранному (gameStatus.js). «Избранного» нет:
// им никто не пользовался
// counts — сколько игр у каждого статуса при нынешних поиске, жанре и языке: видно заранее, что
// даст нажатие; статус без игр приглушён
const StatusChips = ({ value, onChange, t, counts = null }) => {
  // На телефоне чипы — лентой с прокруткой (index.css), и «Пройдено» просто обрезалось по краю.
  // Что лента листается, подсказывает затухание: справа — пока есть что листать дальше, слева —
  // когда уже пролистали. Отметка — в data-fade, без перерисовки на каждый сдвиг пальцем
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => {
      const fade = [];
      if (el.scrollLeft > 4) fade.push('left');
      if (el.scrollLeft + el.clientWidth < el.scrollWidth - 4) fade.push('right');
      el.dataset.fade = fade.join(' ');
    };
    // Первый отчёт приходит сразу: так отметка есть и до первого сдвига
    const resize = new ResizeObserver(update);
    resize.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => { resize.disconnect(); el.removeEventListener('scroll', update); };
  }, []);

  return (
    <div ref={ref} className="filter-chips status-chips">
      {[
        ['all', t.filter_all],
        ['playing', t.status_playing],
        ['new', t.status_new],
        ['done', t.status_done],
        ['dropped', t.status_dropped],
        ['wish', t.status_wish],
      ].map(([key, label]) => {
        const count = counts ? counts[key] || 0 : null;
        return (
          <button
            key={key}
            type="button"
            className={`chip ${value === key ? 'active' : ''}${count === 0 && value !== key ? ' chip-empty' : ''}`}
            aria-pressed={value === key}
            onClick={() => onChange(key)}
          >
            {label}
            {count !== null && <span className="chip-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
};

export default StatusChips;
