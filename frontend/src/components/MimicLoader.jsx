import { BLINK, HALF, LOOK, OPEN, SHUT, gridPath } from '../brandGrid';
import { useCrispSide } from '../crispSize';
import { useDelayedShow } from '../useDelayedShow';
import { useOtherMimic } from '../mimicMood';

// Мимик вместо полосы загрузки: пиксельный знак ждёт вместе с пользователем. Появляется через 250 мс
// (useDelayedShow), анимация стартует с показом и всегда с кадра «открыт». В ожидании: моргнул на 1,6 с
// (160 мс), прикрыл на 2,8 с (240 мс), цикл 3,6 с, step-end. Захлопнутого мимика здесь нет: SHUT значит «готово».
// «Уменьшить движение» — стоит открытым (controls.css). Размер 32, 48 или 64: клетка — целое число точек
// экрана (crispSize.js). С frac (0..1) — мимик из клеток, горят снизу по доле, как в плашке загрузок.
// Кадры лежат в brandGrid.js: их же берёт мимик в шапке и пустая полка

// Полоска из кадров рядом: сдвиг фона на целую клетку переключает кадр без перерисовки
const FRAMES = [OPEN, BLINK, HALF, SHUT, LOOK];
const STRIP = (() => {
  const body = FRAMES.map((g, i) => gridPath(g, '#', i * 16)).join('');
  const eyes = FRAMES.map((g, i) => gridPath(g, 'o', i * 16)).join('');
  const w = FRAMES.length * 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 16" width="${w}" height="16" shape-rendering="crispEdges"><path fill="#c9a84c" d="${body}"/><path fill="#f0d080" d="${eyes}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
})();

const CELLS = OPEN.flatMap((row, y) => [...row].flatMap((c, x) => (c === '.' ? [] : [{ x, y, eye: c === 'o' }])));

// children — подпись; она появляется вместе с мимиком. col — подпись под ним по центру, иначе рядом
const MimicLoader = ({ size = 48, frac, col = false, className = '', children }) => {
  const { show } = useDelayedShow(true);
  // Пока загрузчик на экране, мимик в шапке стоит: в движении один
  useOtherMimic(show);
  const side = useCrispSide(size);
  const lit = frac == null ? null : Math.round(Math.max(0, Math.min(1, frac)) * 14);
  return (
    <div className={`mimic-wait${col ? ' col' : ''}${show ? ' show' : ''} ${className}`.trim()}>
      {lit == null ? (
        <span className="mimic" style={{ '--sz': `${side}px`, backgroundImage: STRIP }} aria-hidden="true" />
      ) : (
        <svg className="mimic-cells" style={{ '--sz': `${side}px` }} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
          {CELLS.map(({ x, y, eye }) => <rect key={`${x}-${y}`} className={eye ? 'eye' : y >= 15 - lit ? 'on' : 'off'} x={x} y={y} width="1" height="1" />)}
        </svg>
      )}
      {children}
    </div>
  );
};

export default MimicLoader;
