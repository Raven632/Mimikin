import { useEffect } from 'react';

// Лента чипов, которая листается вбок (на телефоне): затухает тот край, за которым ещё что-то есть, — справа, пока есть
// что листать дальше, слева — когда уже пролистали. Отметка — в data-fade («left», «right»), без перерисовки на каждый
// сдвиг пальцем; как затухать, решает CSS. deps — от чего меняется ширина содержимого (чип появился, ряд раскрыли)
export function useFadeEdges(ref, deps = []) {
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
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}
