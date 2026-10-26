import { useLayoutEffect, useRef, useState } from 'react';
import { pageZoom } from './pageZoom';

// Шапка полки на главной («Ваши игры», «Новинки»): название, переключатель подборок и «Все». Как её
// разложить, решают не ширины экрана — подписи разной длины на разных языках, числа на вкладках растут, —
// а сама шапка, по месту:
//   'row'     — всё в одну строку (широкий экран);
//   'stacked' — переключатель своей строкой под названием, на всю ширину;
//   'compact' — и так не влезает: у невыбранных вкладок только значок (если у вкладок есть значки).
// Подписи не переносятся никогда. Не влезло и в 'compact' — лента листается вбок: пальцем, колесом мыши
// и с затуханием у того края, за которым ещё есть чипы (data-fade, как у чипов статусов в библиотеке)
const GAP = 14;

// Ширина содержимого, а не коробки: в раскладке «под названием» лента растянута на всю ширину, и scrollWidth
// показывал бы её, а не сумму вкладок. Название меряем по тексту — его ячейка тоже бывает шире текста
const contentWidth = (el) => {
    const kids = [...el.children].filter((k) => k.getClientRects().length);
    if (!kids.length) return 0;
    return kids[kids.length - 1].getBoundingClientRect().right - kids[0].getBoundingClientRect().left;
};
const textWidth = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
};

export function useShelfHead(deps, { canCompact = false } = {}) {
  const headRef = useRef(null);
  const chipsRef = useRef(null);
  const [mode, setMode] = useState('row');

  useLayoutEffect(() => {
    const head = headRef.current;
    const chips = chipsRef.current;
    if (!head || !chips) return undefined;
    const fade = () => {
      const marks = [];
      if (chips.scrollLeft > 4) marks.push('left');
      if (chips.scrollLeft + chips.clientWidth < chips.scrollWidth - 4) marks.push('right');
      chips.dataset.fade = marks.join(' ');
    };
    const measure = () => {
      // Ширина переключателя с полными подписями: на миг снимаем «compact» (до отрисовки, глазу не видно)
      const was = head.dataset.layout;
      head.dataset.layout = 'stacked';
      const full = contentWidth(chips);
      head.dataset.layout = was;
      const title = head.querySelector('.shelf-title');
      const tools = head.querySelector('.shelf-tools');
      // Ширина — тоже по getBoundingClientRect, как и вкладки: на широком экране clientWidth — в других точках (pageZoom.js)
      const width = head.getBoundingClientRect().width;
      const need = (title ? textWidth(title) : 0) + full + (tools ? tools.getBoundingClientRect().width : 0) + GAP * 2 * pageZoom();
      const next = need <= width ? 'row' : full <= width || !canCompact ? 'stacked' : 'compact';
      setMode(next);
      fade();
    };
    // Шапка поменяла ширину — или сами вкладки: подгрузился шрифт, выросло число на вкладке. От шрифта
    // размер шапки не меняется, поэтому следим и за каждой вкладкой
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    for (const chip of chips.children) observer.observe(chip);
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) measure(); });
    chips.addEventListener('scroll', fade, { passive: true });
    // Колесо мыши над лентой, которая не влезла, листает её вбок, а не страницу. Ctrl+колесо — масштаб
    // страницы, его не трогаем; дошли до края ленты — колесо снова листает страницу
    const wheel = (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = chips.scrollWidth - chips.clientWidth;
      // Firefox считает колесо строками (deltaY ≈ 3) — переводим в пиксели
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? chips.clientWidth : 1);
      if (max <= 1 || (d < 0 && chips.scrollLeft <= 0) || (d > 0 && chips.scrollLeft >= max - 1)) return;
      e.preventDefault();
      chips.scrollLeft += d;
    };
    chips.addEventListener('wheel', wheel, { passive: false });
    measure();
    return () => {
      alive = false;
      observer.disconnect();
      chips.removeEventListener('scroll', fade);
      chips.removeEventListener('wheel', wheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Выбранная вкладка — в поле зрения ленты, если та листается. Листаем только ленту: scrollIntoView
  // прокрутил бы и страницу к полке, которую ещё не видно
  useLayoutEffect(() => {
    const row = chipsRef.current;
    const active = row?.querySelector('.chip.active');
    if (!row) return;
    if (active && row.scrollWidth > row.clientWidth) {
      const left = (active.getBoundingClientRect().left - row.getBoundingClientRect().left) / pageZoom() + row.scrollLeft;
      if (left < row.scrollLeft || left + active.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.max(0, left - 24);
    }
    // Затухание — по ленте в новой раскладке (её размеры могли и не поменяться, и наблюдатель промолчит)
    const marks = [];
    if (row.scrollLeft > 4) marks.push('left');
    if (row.scrollLeft + row.clientWidth < row.scrollWidth - 4) marks.push('right');
    row.dataset.fade = marks.join(' ');
  }, [mode, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return { headRef, chipsRef, layout: mode };
}
