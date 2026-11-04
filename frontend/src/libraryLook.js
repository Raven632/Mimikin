import { useLayoutEffect, useState } from 'react';
import { GROUPS } from './libraryGroups';

// Вид вкладки «Библиотека»: сетка, крупно, список, стена, и размер плиток. Размер «Авто» идёт от числа игр: мало — крупно, с описанием,
// много — плотно. Считаем по всей библиотеке, а не по найденному: иначе от каждого фильтра сетка меняла бы размер под рукой
export const VIEWS = ['grid', 'feat', 'list', 'wall'];
export const SIZES = ['auto', 's', 'm', 'l'];
const SIZE_PX = { s: [160, 120], m: [220, 180], l: [320, 280] };
const PHONE = 560;
const CARD_TEXT = 66; // название и строка сведений под обложкой
const GAP = 16;

const autoOf = (n) => (n >= 1 && n <= 4 ? { view: 'feat', min: 320, wall: 300 }
  : n <= 12 ? { min: 320, wall: 280 }
    : n <= 40 ? { min: 240, wall: 210 }
      : { min: 190, wall: 150 });

const read = (key, allowed, fallback) => {
  try { const v = localStorage.getItem(key); return allowed.includes(v) ? v : fallback; } catch { return fallback; }
};
const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* вид просто не запомнится */ } };
const NO_SHUT = [];
const readShut = () => {
  try {
    const v = JSON.parse(localStorage.getItem('rpg_libshut'));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
};

// Первый ряд должен быть виден целиком: в «Авто» карточка не выше места, что осталось под шапкой. Колонок становится больше, а не
// наоборот. Пишем в стиль напрямую: пересчёт при изменении окна не должен перерисовывать всю страницу
function fit(el, total, size) {
  // Над первым рядом может стоять заголовок группы: ряд должен войти вместе с ним
  const head = el.querySelector(':scope > .lib-group');
  const room = window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 14 - (head ? head.offsetHeight + GAP : 0);
  const auto = autoOf(total);
  const [min, wall] = SIZE_PX[size] || [auto.min, auto.wall];
  el.style.setProperty('--wall-min', `${wall}px`);
  el.style.setProperty('--feat-w', `${Math.max(220, (room - 30) * 1.6)}px`);
  if (size !== 'auto' || window.innerWidth <= PHONE) return el.style.setProperty('--card-min', `${min}px`);
  const css = getComputedStyle(el);
  const width = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
  const most = Math.max(150, (room - CARD_TEXT) * 1.6);
  let n = Math.max(1, Math.floor((width + GAP) / (min + GAP)));
  let w = (width - (n - 1) * GAP) / n;
  while (w > most) { n += 1; w = (width - (n - 1) * GAP) / n; }
  return el.style.setProperty('--card-min', `${Math.floor(w)}px`);
}

// locked — список упорядочен по тегу картинок: группы в это время не действуют, запомненный выбор не трогаем
export function useLibraryLook(total, locked) {
  // Узел сетки — состоянием: пока список грузится, вместо него другой элемент, а вернувшийся — новый узел, и мерить надо его
  const [el, setEl] = useState(null);
  const [view, setViewNow] = useState(() => read('rpg_libview', VIEWS, 'grid'));
  const [size, setSizeNow] = useState(() => read('rpg_libsize', SIZES, 'auto'));
  const setSize = (v) => { setSizeNow(v); save('rpg_libsize', v); };
  const [titles, setTitlesNow] = useState(() => read('rpg_libtitles', ['1'], '') === '1');
  const setTitles = (on) => { setTitlesNow(on); save('rpg_libtitles', on ? '1' : ''); };
  const [groupPick, setGroupNow] = useState(() => read('rpg_libgroup', GROUPS, 'none'));
  const setGroup = (v) => { setGroupNow(v); save('rpg_libgroup', v); };
  const group = locked ? 'none' : groupPick;
  // Свёрнутые группы — у каждого способа свои
  const [shutAll, setShutAll] = useState(readShut);
  const shut = Array.isArray(shutAll[group]) ? shutAll[group] : NO_SHUT;
  const toggleShut = (key) => {
    const next = { ...shutAll, [group]: shut.includes(key) ? shut.filter((x) => x !== key) : [...shut, key] };
    setShutAll(next);
    save('rpg_libshut', JSON.stringify(next));
  };
  const auto = autoOf(total);
  const shown = view === 'grid' && size === 'auto' && auto.view ? auto.view : view;
  const setView = (v) => {
    setViewNow(v);
    save('rpg_libview', v);
    // Просит сетку там, где «Авто» показывает крупно: значит, хочет именно сетку
    if (v === 'grid' && size === 'auto' && auto.view) setSize('l');
  };
  useLayoutEffect(() => {
    if (!el) return undefined;
    const measure = () => fit(el, total, size);
    measure();
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure);
    // Над сеткой меняется высота: раскрыли фильтры, чипы перенеслись, сменился язык
    const above = new ResizeObserver(measure);
    for (const node of document.querySelectorAll('.controls-zone, .library-bar')) above.observe(node);
    return () => { window.removeEventListener('resize', measure); above.disconnect(); };
  }, [el, total, size, shown, group]);
  const className = `library look-${shown} size-${size}${size === 'auto' && total <= 12 ? ' roomy' : ''}${titles && shown === 'wall' ? ' wall-titles' : ''}`;
  return { setEl, view, size, shown, titles, setView, setSize, setTitles, className, groupPick, setGroup, group, shut, toggleShut };
}
