import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLayer } from '../layers';

// Выбор сцены у альбома со сценами-гостями (album.scenes): маленький чёрный список над кнопкой «Смотреть сцену», хвостик
// указывает на неё. list — [{ t, n }] (название и номер сцены), anchor — ref кнопки. ↑↓ ходят по строкам, Enter берёт,
// Esc и нажатие мимо закрывают (картинка под списком остаётся открытой).
// Тот же список — выбор в панели плеера сцен и просмотра Live2D (BarChoose) вместо системного <select>: title — подпись
// сверху вместо «Выберите сцену», current — номер выбранной строки (с неё начинаются стрелки).
// grid — вместо ленты сетка клеток по группам (движения Live2D из model3.json): у строки списка { t, n, g, c } — полное
// имя, номер, группа и короткая подпись клетки; сверху имя выбранной или наведённой клетки. grid.of(i, n) — «42 из 63»,
// grid.search — подпись поля поиска (только у моделей со словесными именами; у номерных поиск — это набор цифр, а
// сетка и так видна целиком), grid.none — когда ничего не нашлось. ←/→ ходят по клеткам, ↑/↓ — по строкам сетки
const ScenePick = ({ t, list: all, anchor, onPick, onClose, title, current, grid }) => {
  const rootRef = useRef(null);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // useMemo: новый массив на каждый кадр гонял бы расчёт места по кругу
  const list = useMemo(() => (q ? all.filter((s) => `${s.t} ${s.g || ''}`.toLowerCase().includes(q)) : all), [all, q]);
  const [at, setAt] = useState(() => Math.max(0, all.findIndex((s) => s.n === current)));
  const [place, setPlace] = useState(null);
  // История не нужна: это не окно, жест «назад» закроет просмотр; Tab из списка уходит дальше. Фокус — на выбранную строку (у сцен — на первую), если
  // стрелка не успела поставить его раньше
  // С полем поиска на компьютере фокус — в поле (набирать можно сразу), на телефоне — на клетку: клавиатура сама не выскакивает
  const toSearch = !!grid?.search && window.matchMedia?.('(pointer: fine)').matches;
  useLayer(rootRef, onClose, { history: false, trap: false, focus: toSearch ? '.scene-pick-search' : '.scene-pick-opt.active' });
  // Список над кнопкой по её месту на экране; окно или панель поменяли размер — считаем заново
  useLayoutEffect(() => {
    const put = () => {
      const a = anchor.current?.getBoundingClientRect();
      const w = rootRef.current?.offsetWidth;
      if (!a || !w) return;
      const vw = document.documentElement.clientWidth;
      const left = Math.max(12, Math.min(vw - w - 12, a.left + a.width / 2 - w / 2));
      // Сетка на телефоне встаёт над всей нижней панелью, а не над кнопкой: строку «Альбом…» она не закрывает
      const bar = grid && vw <= 560 ? anchor.current.closest('.gallery-bar')?.getBoundingClientRect() : null;
      setPlace({ left, bottom: window.innerHeight - (bar || a).top + 10, caret: a.left + a.width / 2 - left - 6, sheet: !!bar });
    };
    put();
    window.addEventListener('resize', put);
    return () => window.removeEventListener('resize', put);
  }, [anchor, list, grid]);
  // Нажатие мимо закрывает только список: следующий за ним click глотаем, иначе он дошёл бы до фона просмотра и закрыл его
  useEffect(() => {
    const down = (e) => {
      if (rootRef.current?.contains(e.target) || anchor.current?.contains(e.target)) return;
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 400);
      onClose();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [anchor, onClose]);
  // Клавиши — с документа, а не с самого списка: фокус встаёт на первую строку на следующем кадре, а человек уже нажал
  // стрелку. Enter на строке нажимает её сам; если фокус ещё на кнопке «Смотреть сцену» или нигде — берём выделенную строку. На других кнопках (Tab из списка ушёл на «Показ», «×») Enter их собственный
  const live = useRef({ at, list, onPick, grid });
  useEffect(() => { live.current = { at, list, onPick, grid }; });
  useEffect(() => {
    const key = (e) => {
      const { at: now, list: items, onPick: pickIt, grid: cells } = live.current;
      const inField = e.target instanceof Element && e.target.matches('.scene-pick-search');
      const to = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      // В сетке ←/→ — соседняя клетка (в поле поиска они двигают курсор), ↑/↓ — ближайшая клетка в соседней строке
      const side = cells && !inField ? (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0) : 0;
      if ((to || side) && items.length) {
        e.preventDefault();
        e.stopPropagation();
        const nodes = [...(rootRef.current?.querySelectorAll('.scene-pick-opt') || [])];
        let next = (now + (side || to) + items.length) % items.length;
        // Из поля поиска стрелка только уходит в сетку, на уже подсвеченную клетку
        if (inField) next = now;
        else if (cells) {
          next = Math.min(items.length - 1, Math.max(0, now + side));
          if (to && nodes[now]) {
            const a = nodes[now].getBoundingClientRect();
            let best = Infinity;
            nodes.forEach((n, i) => {
              const r = n.getBoundingClientRect();
              const dy = (r.top - a.top) * to;
              if (dy < 4) return;
              const rank = dy * 1000 + Math.abs(r.left + r.width / 2 - (a.left + a.width / 2));
              if (rank < best) { best = rank; next = i; }
            });
          }
        }
        setAt(next);
        nodes[next]?.focus();
      } else if (e.key === 'Enter' && items.length && (inField || e.target === anchor.current || e.target === document.body || !e.target || e.target === document.documentElement)) {
        e.preventDefault();
        e.stopPropagation();
        pickIt(items[now].n);
      }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [anchor]);
  const cur = list[Math.min(at, list.length - 1)];
  // Строки сетки — группы в порядке первого появления; одна группа (или без групп) — подписей нет
  const rows = [];
  if (grid) list.forEach((s, i) => { const r = rows.find((x) => x.g === (s.g || '')) || rows[rows.push({ g: s.g || '', cells: [] }) - 1]; r.cells.push({ s, i }); });
  const cell = (s, i) => (
    <button key={s.n} type="button" className={`scene-pick-opt scene-pick-cell${i === at ? ' active' : ''}${s.n === current ? ' selected' : ''}`}
      aria-label={s.t} onMouseEnter={() => setAt(i)} onFocus={() => setAt(i)} onClick={() => onPick(s.n)}>{s.c}</button>
  );
  return (
    <div ref={rootRef} className={`scene-pick${grid ? ' grid' : ''}${place?.sheet ? ' sheet' : ''}`} role="dialog" aria-label={title || t?.scene.pick}
      onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}
      style={place ? { left: place.left, bottom: place.bottom, '--caret': `${place.caret}px` } : { visibility: 'hidden' }}>
      <div className="scene-pick-head"><span>{title || t?.scene.pick}</span><span className="scene-pick-n">{grid ? grid.of(q ? list.length : Math.max(0, all.findIndex((s) => s.n === current)) + 1, all.length) : list.length}</span></div>
      {grid ? (
        <>
          <div className="scene-pick-name">{cur?.t}{cur?.g && rows.length > 1 && <span>{cur.g}</span>}</div>
          {grid.search && (
            <input type="search" className="scene-pick-search" value={query} placeholder={grid.search} aria-label={grid.search} autoComplete="off" spellCheck="false"
              onChange={(e) => { setQuery(e.target.value); setAt(0); }} />
          )}
          <div className="scene-pick-list scene-pick-grid">
            {rows.map((r) => (
              <div key={r.g} className="scene-pick-row">
                {rows.length > 1 && <span className="scene-pick-group">{r.g}</span>}
                <div className="scene-pick-cells">{r.cells.map(({ s, i }) => cell(s, i))}</div>
              </div>
            ))}
            {!list.length && <p className="scene-pick-none">{grid.none}</p>}
          </div>
        </>
      ) : (
        <div className="scene-pick-list">
          {list.map((s, i) => (
            <button key={s.n} type="button" className={`scene-pick-opt${i === at ? ' active' : ''}${s.n === current ? ' selected' : ''}`}
              onMouseEnter={() => setAt(i)} onFocus={() => setAt(i)} onClick={() => onPick(s.n)}>{s.t}</button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ScenePick;
