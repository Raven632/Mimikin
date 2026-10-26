import { useEffect, useRef, useState } from 'react';
import MimicLoader from './MimicLoader';
import { EASE, hideCover, reducedMotion, toRect } from '../windowFly';

// «Играть»: обложка растёт из своего места в экран будущей игры, рассыпается на крупные клетки и темнеет
// ступенями — как переход в бой в старом RPG Maker; из чёрного начинается игра. Всё идёт параллельно с
// запросом на запуск и его не задерживает: слой уходит, когда стало чёрно и игра уже запущена (ready).
// Рост 300 мс по EASE, мозаика кадрами: [мс от нажатия, клетка в точках, яркость], 0 — чёрный. Кадры выбираем
// по времени в requestAnimationFrame, а не по setTimeout: занятый процессор не сдвинет их относительно роста.
// «Уменьшить движение» — сразу чёрный экран
const GROW_MS = 300;
const STEPS = [[140, 4, 1], [220, 8, 0.75], [300, 16, 0.5], [380, 32, 0.25], [460, 0, 0]];
// Экран игры по умолчанию. Настоящий (System.json) сюда пока не доходит: игра в рамке подгоняется под окно
const SCREEN = 816 / 624;
// Чёрный экран ждёт игру дольше этого — показываем мимика и даём выйти (Escape или нажатие)
const STUCK_MS = 3000;

const LaunchIntro = ({ from, ready, onDone, onCancel }) => {
  const layer = useRef(null);
  const back = useRef(null);
  const canvas = useRef(null);
  const [black, setBlack] = useState(reducedMotion);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; });
  useEffect(() => { if (black && ready) doneRef.current(); }, [black, ready]);
  // Игра была запущена, а потом пропала (рамку закрыли посреди перехода) — слой не оставляем
  const wasReady = useRef(false);
  useEffect(() => {
    if (ready) wasReady.current = true;
    else if (wasReady.current) doneRef.current();
  }, [ready]);
  // Сервер не отвечает: через 3 с после чёрного — мимик, Escape и нажатие отменяют запуск. Фокус уходит с кнопки
  // «Играть» под слоем, иначе Enter нажал бы её ещё раз
  const [stuck, setStuck] = useState(false);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; });
  useEffect(() => {
    if (!black || ready) return undefined;
    document.activeElement?.blur?.();
    const timer = setTimeout(() => setStuck(true), STUCK_MS);
    return () => { clearTimeout(timer); setStuck(false); };
  }, [black, ready]);
  useEffect(() => {
    if (!stuck) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancelRef.current?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stuck]);

  useEffect(() => {
    const cover = from.el;
    if (reducedMotion()) return undefined;
    let alive = true;
    const L = layer.current.getBoundingClientRect();
    // Где появится игра: её экран вписан в окно, обложка ложится в него, не меняя своих пропорций
    let gw = L.width, gh = L.width / SCREEN;
    if (gh > L.height) { gh = L.height; gw = L.height * SCREEN; }
    const a = from.rect.w / from.rect.h;
    let w = gw, h = gw / a;
    if (h > gh) { h = gh; w = gh * a; }
    const T = { x: (L.width - w) / 2, y: (L.height - h) / 2, w, h };
    const C = { x: from.rect.x - L.left, y: from.rect.y - L.top, w: from.rect.w, h: from.rect.h };
    // Слой в масштабе 1/--zoom (frame.css): его точки — точки экрана, клетка мозаики — целое число точек
    const q = window.devicePixelRatio || 1;
    const cv = canvas.current;
    cv.width = Math.round(T.w * q);
    cv.height = Math.round(T.h * q);
    Object.assign(cv.style, { left: `${T.x}px`, top: `${T.y}px`, width: `${T.w}px`, height: `${T.h}px` });
    const g = cv.getContext('2d');
    const small = document.createElement('canvas');
    // Обложка карточки обрезана по object-fit: cover — берём ту же часть картинки, иначе её растянет
    let sx = 0, sy = 0, sw = cover.naturalWidth, sh = cover.naturalHeight;
    if (from.cropped) {
      if (sw / sh > a) { const nw = sh * a; sx = (sw - nw) / 2; sw = nw; } else { const nh = sw / a; sy = (sh - nh) / 2; sh = nh; }
    }
    // Снимок обложки на миг нажатия: «Продолжить» могла сменить игру в карточке, и живая картинка поменялась бы
    // посреди перехода. Дальше рисуем со снимка
    const snap = document.createElement('canvas');
    snap.width = Math.max(1, Math.round(sw));
    snap.height = Math.max(1, Math.round(sh));
    snap.getContext('2d').drawImage(cover, sx, sy, sw, sh, 0, 0, snap.width, snap.height);
    sx = 0; sy = 0; sw = snap.width; sh = snap.height;
    const paint = (cell, bright) => {
      const W = cv.width, H = cv.height;
      if (bright <= 0) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); return; }
      if (cell <= 1) {
        // Растущая обложка — с обычным сглаживанием: рисунки и JPEG ближайшим соседом рвутся в квадраты
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(snap, sx, sy, sw, sh, 0, 0, W, H);
      } else {
        const n = Math.max(1, Math.round(cell * q));
        small.width = Math.ceil(W / n);
        small.height = Math.ceil(H / n);
        const s = small.getContext('2d');
        s.imageSmoothingEnabled = true;
        s.imageSmoothingQuality = 'high';
        s.drawImage(snap, sx, sy, sw, sh, 0, 0, W / n, H / n);
        g.imageSmoothingEnabled = false;
        g.clearRect(0, 0, W, H);
        g.drawImage(small, 0, 0, small.width, small.height, 0, 0, small.width * n, small.height * n);
      }
      if (bright < 1) { g.fillStyle = `rgba(0,0,0,${1 - bright})`; g.fillRect(0, 0, W, H); }
    };
    paint(1, 1);
    // Обложка уходит со своего места, а не раздваивается
    hideCover(cover, true);
    back.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GROW_MS, fill: 'both' });
    cv.animate([{ transform: toRect(T, C, true, 1) }, { transform: 'translate(0px, 0px) scale(1, 1)' }], { duration: GROW_MS, easing: EASE, fill: 'both' });
    const t0 = performance.now();
    let shown = -1;
    const tick = () => {
      if (!alive) return;
      const t = performance.now() - t0;
      let i = -1;
      STEPS.forEach((s, j) => { if (t >= s[0]) i = j; });
      if (i !== shown && i >= 0) { shown = i; paint(STEPS[i][1], STEPS[i][2]); }
      if (i === STEPS.length - 1) {
        back.current.getAnimations().forEach((x) => x.cancel());
        back.current.style.opacity = 1;
        cv.style.display = 'none';
        setBlack(true);
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      alive = false;
      hideCover(cover, false);
    };
  }, [from]);

  return (
    <div ref={layer} className="frame-intro" aria-hidden="true" onClick={stuck ? () => cancelRef.current?.() : undefined}>
      <div ref={back} className="frame-intro-back" style={reducedMotion() ? { opacity: 1 } : undefined} />
      <canvas ref={canvas} className="frame-intro-cv" />
      {stuck && <div className="game-frame-wait"><MimicLoader size={64} /></div>}
    </div>
  );
};

export default LaunchIntro;
