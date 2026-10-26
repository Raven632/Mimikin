// Знак Mimikin: мимик в сетке 16×16 — сундук с приподнятой крышкой, зубы и глаза в щели.
// Пиксельный, как игры на RPG Maker. Цвет — от текста (currentColor): золотой в шапке, чёрный на
// золотой плитке. Чётче всего при размере, кратном 16 (16, 32, 48, 64): тогда клетка = целые пиксели.
// Та же сетка — в значках приложения и иконке вкладки (scripts/brand-icons.py)
// live — живой мимик шапки и входа (mimicMood.js): кадр называет хранилище, здесь он только рисуется. Место знака
// остаётся size × size, а svg живого знака больше него на запас клеток (viewBox −2 −4 24 22): над W монета, справа
// от рта обложка. Сторона — целое число клеток в точках экрана (crispSize.js), svg не принимает мышь
import { useLayoutEffect } from 'react';
import { MIMIC_GRID, OVERLAYS, gridPath, liveGrid, noEyes } from '../brandGrid';
import { useCrispSide } from '../crispSize';
import { mood, useMimicFrame } from '../mimicMood';

// Подряд идущие клетки строки — одним прямоугольником: 40 фигур вместо сотни
const RUNS = MIMIC_GRID.flatMap((row, y) => {
  const out = [];
  for (let x = 0; x < row.length; x += 1) {
    if (row[x] !== '#') continue;
    let end = x;
    while (row[end + 1] === '#') end += 1;
    out.push({ x, y, w: end - x + 1 });
    x = end;
  }
  return out;
});

// Пути кадров считаем один раз на имя кадра
const PATHS = new Map();
const pathsOf = (f, shut) => {
  const key = `${f}|${shut}`;
  let p = PATHS.get(key);
  if (!p) {
    const g = shut ? noEyes(liveGrid(f)) : liveGrid(f);
    p = { body: gridPath(g, '#'), eyes: gridPath(g, 'o') };
    PATHS.set(key, p);
  }
  return p;
};

// view: 'head' — шапка (наведение, глаза за курсором, события), 'login' — вход (спит, пока не начали печатать)
const Live = ({ size, className, view, sleep }) => {
  const frame = useMimicFrame(view);
  // До первой отрисовки: иначе на входе мигнул бы открытый знак, а потом заснул
  useLayoutEffect(() => { if (view === 'login') mood.sleep(sleep); }, [view, sleep]);
  const side = useCrispSide(size, size);
  const [f, ov, shut] = frame.split('|');
  const { body, eyes } = pathsOf(f, shut === '1');
  const o = ov && OVERLAYS[ov];
  const cell = side / 16;
  const over = o && <path className={o.coin ? 'mood-coin' : 'mood-spit'} d={/^W/.test(f) && o.hi ? o.hi : o.d} />;
  return (
    <span className={`brand-mark m16 ${className}`} style={{ width: side, height: side }} aria-hidden="true">
      <svg data-frame={f} data-over={ov || undefined} viewBox="-2 -4 24 22" shapeRendering="crispEdges" focusable="false"
        style={{ left: -2 * cell, top: -4 * cell, width: 24 * cell, height: 22 * cell }}>
        {o?.coin && over}
        <path fill="currentColor" d={body} />
        <path fill="currentColor" className="mood-eyes" d={eyes} />
        {o && !o.coin && over}
      </svg>
    </span>
  );
};

const BrandMark = ({ size = 32, className = '', live = false, view = 'head', sleep = false }) => (live
  ? <Live size={size} className={className} view={view} sleep={sleep} />
  : (
    <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        {RUNS.map(({ x, y, w }) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height="1" />)}
      </g>
    </svg>
  ));

export default BrandMark;
