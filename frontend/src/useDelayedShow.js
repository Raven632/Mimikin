import { useEffect, useRef, useState } from 'react';

// Ожидание показываем не сразу: ответ быстрее 250 мс обходится без мигания. А если показали, то держим
// не меньше 400 мс — иначе ответ на 260-й миллисекунде оставил бы вспышку, которую не успеть понять.
//   show — пора рисовать ожидание (прошло delay с начала)
//   busy — ожидание ещё занимает место: идёт само или дотягивает минимум показа; по нему родитель
//          решает, что нарисовать — ожидание или готовое
export const useDelayedShow = (active, delay = 250, hold = 400) => {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  const shownRef = useRef(false);

  // setState — только из таймеров: показ и снятие по истечении минимума
  useEffect(() => {
    let id = 0;
    if (active && !shownRef.current) {
      id = setTimeout(() => { shownAt.current = performance.now(); shownRef.current = true; setShown(true); }, delay);
    } else if (!active && shownRef.current) {
      id = setTimeout(() => { shownRef.current = false; setShown(false); }, Math.max(0, shownAt.current + hold - performance.now()));
    }
    return () => clearTimeout(id);
  }, [active, delay, hold]);

  return { show: shown, busy: active || shown };
};
