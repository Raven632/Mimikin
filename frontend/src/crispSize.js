import { useEffect, useState } from 'react';
import { pageZoom } from './pageZoom';

// Размер пиксельного мимика по правилу целых клеток: клетка = целое число точек экрана, иначе ряды
// выходят неровными (26 css при 16 клетках — 1,625 точки на клетку). Клетку считаем из желаемой стороны px:
// round(px / 16 × DPR × зум); сторона = 16 × клетка / (DPR × зум). max — потолок места: если клетка его
// переросла больше чем на точку, берём на одну меньше
export const crispSide = (px, max = Infinity) => {
  const scale = (window.devicePixelRatio || 1) * pageZoom();
  let cell = Math.max(1, Math.round((px / 16) * scale));
  if (cell > 1 && (16 * cell) / scale > max + 1) cell -= 1;
  return (16 * cell) / scale;
};

// Сторона для render: пересчёт, когда меняется плотность экрана (окно перетащили на другой монитор, зум
// страницы) или масштаб широкого экрана (--zoom зависит от ширины окна)
export const useCrispSide = (px, max) => {
  const [side, setSide] = useState(() => crispSide(px, max));
  useEffect(() => {
    let mq = null;
    const calc = () => setSide(crispSide(px, max));
    const onDpr = () => { calc(); watch(); };
    const watch = () => {
      mq?.removeEventListener('change', onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', onDpr);
    };
    watch();
    calc();
    window.addEventListener('resize', calc);
    return () => { mq?.removeEventListener('change', onDpr); window.removeEventListener('resize', calc); };
  }, [px, max]);
  return side;
};
