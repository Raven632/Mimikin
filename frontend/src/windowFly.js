import { pageZoom } from './pageZoom';

// Окно игры вырастает из карточки (GameModal) и «Играть» растит обложку до экрана игры (LaunchIntro).
// Общее здесь: откуда лететь и как посчитать полёт. Двигаем только transform и opacity — раскладка
// страницы за время полёта не пересчитывается. Прямоугольники берём из getBoundingClientRect (точки экрана);
// сдвиг в transform — в точках вёрстки, поэтому делим на масштаб широкого экрана (pageZoom.js)

export const OPEN_MS = 240;
export const CLOSE_MS = 200;
export const EASE = 'cubic-bezier(.2,0,0,1)';

export const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

// Что видно на экране от картинки: у object-fit: contain поля по бокам — не обложка, и лететь должна она
const visibleRect = (img) => {
  const box = rectOf(img);
  if (getComputedStyle(img).objectFit !== 'contain' || !img.naturalWidth) return box;
  const k = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight);
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
};

// Откуда лететь: обложка нажатой карточки, плитки полки или «Продолжить». Не загружена, не видна или
// целиком за краем экрана — null, и окно просто появляется без полёта
export function flightFrom(img) {
  if (!img || !img.isConnected || !img.naturalWidth) return null;
  // «Скрыть обложки»: картинка на экране размыта, а копия для полёта была бы чёткой — не летим
  if (img.closest('.covers-hidden')) return null;
  const rect = visibleRect(img);
  if (rect.w < 2 || rect.h < 2) return null;
  if (rect.y + rect.h <= 0 || rect.y >= window.innerHeight || rect.x + rect.w <= 0 || rect.x >= window.innerWidth) return null;
  return { el: img, src: img.currentSrc || img.src, rect, cropped: getComputedStyle(img).objectFit !== 'contain' };
}

// FLIP: элемент стоит на своём месте F, transform переносит его в прямоугольник r. uniform — один масштаб
// на обе оси (обложка не искажается), по центру r по высоте
export function toRect(F, r, uniform, z = pageZoom()) {
  const sx = r.w / F.w, sy = uniform ? sx : r.h / F.h;
  const dy = uniform ? (r.h - F.h * sx) / 2 : 0;
  return `translate(${((r.x - F.x) / z).toFixed(2)}px, ${((r.y + dy - F.y) / z).toFixed(2)}px) scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`;
}
const NONE = 'translate(0px, 0px) scale(1, 1)';
const tf = (t) => (!t || t === 'none' ? NONE : t);

// Куда садится призрак обложки: пропорции карточки, вписанные в видимую обложку окна. Обложка окна другой
// пропорции (вертикальная витрина) — призрак ложится по центру, настоящая проявляется следом
function ghostBox(cover, from) {
  const g = cover.tagName === 'IMG' ? visibleRect(cover) : rectOf(cover);
  if (g.w < 2 || g.h < 2) return null;
  const a = from.rect.w / from.rect.h;
  const w = Math.min(g.w, g.h * a), h = w / a;
  return { x: g.x + (g.w - w) / 2, y: g.y + (g.h - h) / 2, w, h, cover: g };
}

const coverOf = (win) => win.querySelector('#modal-cover, .modal-placeholder');
const live = (win, overlay, ghost) => [overlay, win, ghost, ...win.children];
const stop = (els) => els.forEach((e) => e?.getAnimations().forEach((a) => a.cancel()));
const settled = (list) => Promise.all(list.map((a) => a.finished)).then(() => true, () => false);

function setGhost(ghost, box, src) {
  const z = pageZoom();
  Object.assign(ghost.style, { left: `${box.x / z}px`, top: `${box.y / z}px`, width: `${box.w / z}px`, height: `${box.h / z}px` });
  if (src) ghost.src = src;
  ghost.classList.add('fly');
}

function endFlight(win, ghost) {
  ghost?.classList.remove('fly');
  delete win.dataset.flying;
  win.style.willChange = '';
  win.style.transformOrigin = '';
}

// Открытие. Окно уже стоит на своём месте (так мы его измерили), дальше только transform и opacity:
// рамка — от карточки к месту окна, обложка-призрак — тем же движением, подложка — прозрачностью,
// остальное содержимое проявляется с 170 мс, пока рамка садится
export function flyOpen({ overlay, win, ghost }, from) {
  const ctl = { phase: 'opening', seq: 0, from, overlay, win, ghost };
  const my = ++ctl.seq;
  stop(live(win, overlay, ghost));
  if (reducedMotion()) { ctl.phase = 'open'; return ctl; }
  const kids = [...win.children];
  if (!from) {
    // Карточки не видно (ссылка ?game=, поиск, ревизия): просто появляется
    overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
    ctl.phase = 'open';
    return ctl;
  }
  const cover = coverOf(win);
  // Обложка окна (крупнее карточной) ещё не пришла — у img с height: auto нет высоты, окно меряется без неё и
  // призраку некуда садиться. До загрузки даём ей пропорции карточки; пришла — своя высота
  if (cover?.tagName === 'IMG' && !cover.naturalWidth) {
    cover.style.aspectRatio = `${from.rect.w} / ${from.rect.h}`;
    cover.addEventListener('load', () => { cover.style.aspectRatio = ''; }, { once: true });
  }
  const W = rectOf(win);
  const G = cover && ghostBox(cover, from);
  const o = { duration: OPEN_MS, easing: EASE, fill: 'both' };
  win.style.transformOrigin = '0 0';
  win.style.willChange = 'transform';
  const list = [
    win.animate([{ transform: toRect(W, from.rect) }, { transform: NONE }], o),
    overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, fill: 'both' }),
    ...kids.map((k) => k.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: 170, fill: 'both' })),
  ];
  if (G && ghost) {
    setGhost(ghost, G, from.src);
    win.dataset.flying = '1';
    list.push(ghost.animate([{ transform: toRect(G, from.rect, true) }, { transform: NONE }], o));
  }
  settled(list).then((ok) => {
    if (my !== ctl.seq) return;
    // Анимацию отменили не мы (React пересоздал узел окна): всё равно снимаем призрака и признак полёта
    if (!ok) { endFlight(win, ghost); ctl.phase = 'open'; return; }
    stop(live(win, overlay, ghost));
    endFlight(win, ghost);
    ctl.phase = 'open';
    // Обложка окна другой пропорции, чем у карточки: призрак лёг по центру, настоящая проявляется за 80 мс
    if (G && (Math.abs(G.w - G.cover.w) > 2 || Math.abs(G.h - G.cover.h) > 2)) {
      cover.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80 });
    }
  });
  return ctl;
}

// Закрытие едет от текущего места, а не с начала: закрыли на полпути открытия — разворот. Обложка
// садится в карточку, текст гаснет за 40 мс. Карточки уже нет на экране (список перерисовался,
// прокрутили) — окно гаснет на месте. onDone зовём, когда движение доиграло
export function flyClose(ctl, onDone) {
  if (!ctl) { onDone(); return; }
  if (ctl.phase === 'closing') return;
  const { overlay, win, ghost, from } = ctl;
  const my = ++ctl.seq;
  const wasOpening = ctl.phase === 'opening';
  ctl.phase = 'closing';
  if (reducedMotion()) { onDone(); return; }
  const num = (el) => Number(getComputedStyle(el).opacity);
  const cur = {
    win: wasOpening ? getComputedStyle(win).transform : 'none',
    ghost: wasOpening && ghost?.classList.contains('fly') ? getComputedStyle(ghost).transform : 'none',
    ov: num(overlay),
    kids: win.children[0] ? num(win.children[0]) : 1,
  };
  stop(live(win, overlay, ghost));
  // Карточка могла сдвинуться: берём её место сейчас, а не то, что было при открытии
  const target = from?.el?.isConnected ? flightFrom(from.el) : null;
  const finish = () => { if (my === ctl.seq) onDone(); };
  if (!target) {
    endFlight(win, ghost);
    overlay.animate([{ opacity: cur.ov }, { opacity: 0 }], { duration: CLOSE_MS, fill: 'both' });
    setTimeout(finish, CLOSE_MS);
    return;
  }
  const W = rectOf(win);
  const cover = coverOf(win);
  const G = cover && ghostBox(cover, target);
  // Обложка прокручена за край окна — призрак нечему садиться, летит одна рамка
  const inside = G && G.cover.y >= W.y - 1 && G.cover.y + G.cover.h <= W.y + W.h + 1;
  const o = { duration: CLOSE_MS, easing: EASE, fill: 'both' };
  win.style.transformOrigin = '0 0';
  win.style.willChange = 'transform';
  const list = [
    win.animate([{ transform: tf(cur.win) }, { transform: toRect(W, target.rect) }], o),
    overlay.animate([{ opacity: cur.ov }, { opacity: 0 }], { duration: CLOSE_MS, fill: 'both' }),
    ...[...win.children].map((k) => k.animate([{ opacity: cur.kids }, { opacity: 0 }], { duration: Math.max(1, 40 * cur.kids), fill: 'both' })),
  ];
  if (inside && ghost) {
    setGhost(ghost, G, target.src);
    win.dataset.flying = '1';
    list.push(ghost.animate([{ transform: tf(cur.ghost) }, { transform: toRect(G, target.rect, true) }], o));
  }
  // Отмена чужая (узел окна пересоздан) — окно всё равно закрываем: прозрачный слой перехватывал бы клики
  settled(list).then(finish);
}

export function flyCancel(ctl) {
  if (!ctl) return;
  ctl.seq += 1;
  stop(live(ctl.win, ctl.overlay, ctl.ghost));
  endFlight(ctl.win, ctl.ghost);
}

// Исходная обложка на время перехода «Играть» прячется: на месте остаётся пусто, а не две копии
export function hideCover(img, on) {
  img.style.visibility = on ? 'hidden' : '';
}
