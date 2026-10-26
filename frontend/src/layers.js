import { useEffect, useRef } from 'react';

// Всё, что открыто поверх страницы, — стопкой слоёв: окно игры, поверх — его галерея, режим правки
// или картинка на весь экран, окно подтверждения, меню «⋯». Со стопкой окна ведут себя одинаково
// и как на любом сайте:
//   Escape закрывает верхний слой — один, а не все разом. Escape, уже обработанный внутри
//     (раскрытый список фильтра зовёт e.preventDefault()), слой не закрывает;
//   жест «назад» на телефоне закрывает верхнее окно, а не уводит со страницы библиотеки: пока
//     окно открыто, у него своя запись в истории браузера;
//   Tab ходит только по верхнему окну, а после закрытия фокус возвращается туда, откуда окно
//     открыли, — на карточку игры, на кнопку.
// Игра в рамке (GameFrame) ведёт историю сама и в её записи кладёт уровень слоёв (rpgLayer)
const layers = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

export const historyLevel = () => window.history.state?.rpgLayer || 0;
// Открыто ли что-нибудь поверх страницы: горячие клавиши страницы («/» — в поиск) тогда молчат.
// Вкладка «Библиотека» — тоже слой (жест «назад» возвращает на главную), но не окно: она не в счёт
export const layersOpen = () => layers.some((layer) => layer.modal);
const shown = (el) => el.getClientRects().length > 0;

function onKeyDown(e) {
  const top = layers.at(-1);
  if (!top) return;
  if (e.key === 'Escape') {
    if (e.defaultPrevented || e.isComposing || !top.escape) return;
    e.preventDefault();
    top.close();
    return;
  }
  if (e.key !== 'Tab' || !top.trap) return;
  const root = top.ref.current;
  if (!root) return;
  const items = [...root.querySelectorAll(FOCUSABLE)].filter(shown);
  const active = document.activeElement;
  if (!items.length) {
    e.preventDefault();
    root.focus({ preventScroll: true });
  } else if (!root.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? items.at(-1) : items[0]).focus();
  } else if (e.shiftKey && (active === items[0] || active === root)) {
    e.preventDefault();
    items.at(-1).focus();
  } else if (!e.shiftKey && active === items.at(-1)) {
    e.preventDefault();
    items[0].focus();
  }
}

// Свои записи в истории снимаем сами, когда окно закрыли крестиком, Escape или кнопкой. Шагов назад
// браузер делает по одному и не сразу, поэтому: всё, что закрылось за раз, — одним шагом; пока он
// идёт, новые окна свою запись не кладут (иначе шаг назад снял бы и её), а кладут после
let dropTo = null;
let moving = false;
const waiting = [];

function pushEntry(layer) {
  layer.level = historyLevel() + 1;
  window.history.pushState({ rpgLayer: layer.level }, '');
}

function settle() {
  moving = false;
  if (dropTo !== null) { flushDrop(); return; }
  for (const layer of waiting.splice(0)) if (layers.includes(layer)) pushEntry(layer);
}

function flushDrop() {
  if (dropTo === null || moving) return;
  const steps = historyLevel() - dropTo;
  dropTo = null;
  if (steps <= 0) { settle(); return; }
  moving = true;
  window.history.go(-steps);
  // Браузер не сообщил, что дошёл (так бывает при восстановлении страницы из кэша), — не ждём вечно
  setTimeout(() => { if (moving) settle(); }, 1500);
}

function dropEntry(toLevel) {
  dropTo = dropTo === null ? toLevel : Math.min(dropTo, toLevel);
  queueMicrotask(flushDrop);
}

// «Назад»: закрываем слои, чья запись осталась выше той, на которую вернулись
function onPopState() {
  if (moving) { settle(); return; }
  const now = historyLevel();
  for (const layer of [...layers].reverse()) {
    if (layer.level > now && !layer.popped) {
      layer.popped = true;
      layer.close(() => keep(layer));
    }
  }
}

// Слой, закрытый жестом «назад», решил остаться (правка спросила «не сохранять?», и человек вернулся
// к ней) — возвращаем ему запись в истории, иначе следующее «назад» закрыло бы окно под ним. Не сразу:
// сначала уйдёт окно вопроса со своей записью — ждём, пока слой снова станет верхним
function keep(layer, tries = 0) {
  setTimeout(() => {
    if (!layer.popped || !layers.includes(layer)) return;
    if (layers.at(-1) !== layer && tries < 50) { keep(layer, tries + 1); return; }
    layer.popped = false;
    if (dropTo !== null || moving) waiting.push(layer);
    else pushEntry(layer);
  }, tries ? 20 : 0);
}

document.addEventListener('keydown', onKeyDown);
window.addEventListener('popstate', onPopState);

// Слой: ref — его корень (по нему ходит Tab и туда ставится фокус), onClose — закрыть его. После жеста
// «назад» onClose получает функцию keep: вызвать её, если окно всё же осталось открытым.
//   active  — открыт ли (у режима правки, меню, картинки — пока включены);
//   history — своя запись в истории: «назад» закрывает. У меню и игры в рамке — нет;
//   escape  — закрывать ли по Escape. Игре в рамке Escape нужен самой — она его не отдаёт ниже;
//   trap    — держать ли Tab внутри (у меню — нет: Tab из меню уходит дальше, как обычно);
//   focus   — куда поставить фокус при открытии: селектор внутри корня или 'self' — сам корень
//             (просмотрщик картинок: стрелки и пробел — его, а не первой кнопки), иначе — на первое,
//             что можно нажать. Поле ввода сюда не ставим: на телефоне выскочила бы клавиатура.
//             false — фокус не трогать ни при открытии, ни при закрытии;
//   modal   — окно поверх страницы. Не окно (вкладка страницы) горячие клавиши страницы не глушит
export function useLayer(ref, onClose, { active = true, history = true, escape = true, trap = true, focus = '', modal = true } = {}) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    if (!active) return undefined;
    const layer = {
      ref, escape, trap, history, modal, level: 0, popped: false,
      opener: document.activeElement,
      close: (keepOpen) => closeRef.current?.(keepOpen),
    };
    layers.push(layer);
    if (history) {
      if (dropTo !== null || moving) waiting.push(layer);
      else pushEntry(layer);
    }
    const frame = focus !== false && requestAnimationFrame(() => {
      const root = ref.current;
      if (!root || (!focus && root.contains(document.activeElement))) return;
      const target = focus === 'self' ? root
        : (focus && root.querySelector(focus)) || [...root.querySelectorAll(FOCUSABLE)].find(shown) || root;
      target.focus({ preventScroll: true });
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      const queued = waiting.indexOf(layer);
      if (queued >= 0) waiting.splice(queued, 1);
      else if (history && layer.level && !layer.popped) dropEntry(layer.level - 1);
      // Фокус остался в закрытом слое или потерялся — туда, откуда открывали; того уже нет на
      // странице (пункт меню) — в окно, что под ним
      if (focus === false) return;
      const active = document.activeElement;
      const lost = !active || active === document.body || layer.ref.current?.contains(active);
      if (!lost) return;
      if (layer.opener?.isConnected && layer.opener !== document.body) layer.opener.focus({ preventScroll: true });
      else layers.findLast((other) => other.modal)?.ref.current?.focus({ preventScroll: true });
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}
