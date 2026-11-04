import { useEffect, useRef } from 'react';
import { layersOpen } from './layers';

// Клавиши вкладки «Библиотека» молчат, пока человек занят другим: окно поверх, курсор в поле, раскрыт список или меню
export const pageKeysFree = (e) => !layersOpen()
  && !e.target.closest?.('input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"]')
  && !document.querySelector('[aria-haspopup][aria-expanded="true"]');

// Фокус виден и после щелчка мышью по букве. Под липкую панель карточка не уйдёт: отступ сверху задан на html (base.css, --sticky-total)
export const showCard = (card, block = 'nearest') => {
  card.focus({ preventScroll: true, focusVisible: true });
  card.scrollIntoView({ block });
};

const cards = () => [...document.querySelectorAll('.library .game-card')];
const boxOf = (el) => el.getBoundingClientRect();
const middleX = (r) => (r.left + r.right) / 2;
const middleY = (r) => (r.top + r.bottom) / 2;

// Сосед — по тому, что на экране, а не по номеру: так работает при любом числе колонок и в списке, где колонка одна
function neighbour(from, key) {
  const at = boxOf(from);
  const others = cards().filter((c) => c !== from).map((el) => ({ el, r: boxOf(el) }));
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const row = others.filter(({ r }) => Math.abs(middleY(r) - middleY(at)) < at.height / 2);
    const side = key === 'ArrowRight' ? row.filter(({ r }) => r.left >= at.right - 1) : row.filter(({ r }) => r.right <= at.left + 1);
    const gap = ({ r }) => Math.abs(middleX(r) - middleX(at));
    return side.sort((a, b) => gap(a) - gap(b))[0]?.el || null;
  }
  const down = key === 'ArrowDown';
  const side = others.filter(({ r }) => (down ? middleY(r) > at.bottom : middleY(r) < at.top));
  if (!side.length) return null;
  const nearest = down ? Math.min(...side.map(({ r }) => r.top)) : Math.max(...side.map(({ r }) => r.top));
  const row = side.filter(({ r }) => Math.abs(r.top - nearest) < at.height / 2);
  const gap = ({ r }) => Math.abs(middleX(r) - middleX(at));
  return row.sort((a, b) => gap(a) - gap(b))[0].el;
}

// Первая карточка, которую видно: под липкой панелью не считается
function firstVisible() {
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-total')) || 0;
  const all = cards();
  return all.find((c) => { const r = boxOf(c); return r.bottom > top && r.top < window.innerHeight; }) || all[0] || null;
}

// Стрелки по карточкам. loadMore подгружает следующую страницу сразу и говорит, было ли что: дошли до края загруженного — идём дальше
export function useLibraryKeys(active, loadMore) {
  const more = useRef(loadMore);
  useEffect(() => { more.current = loadMore; });
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      // Alt+← — «назад» браузера. Стрелки, которые уже взял себе открытый список, здесь не считаем
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented || !pageKeysFree(e)) return;
      const from = document.activeElement?.closest?.('.library .game-card');
      const target = from ? neighbour(from, e.key) : firstVisible();
      if (!from && !target) return;
      e.preventDefault();
      if (target) { showCard(target); return; }
      const forward = e.key === 'ArrowDown' || (e.key === 'ArrowRight' && cards().at(-1) === from);
      if (forward && more.current()) {
        const next = neighbour(from, e.key);
        if (next) showCard(next);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);
}
