import { useEffect, useRef, useState } from 'react';
import { IconUpload } from './icons';
import { BLINK, HALF, LOOK, OPEN, SHUT, gridPath } from '../brandGrid';
import { useCrispSide } from '../crispSize';
import { useOtherMimic } from '../mimicMood';

// Пустая библиотека — первый экран после установки. Выглядит как обычная главная: полка «Ваши игры»,
// где первая плитка — место для архива (пунктир из квадратиков 4 px), остальные едва видны.
// Без лендинга по центру: первая игра встанет ровно в эту плитку, и страница не поменяет вид.
// Перетащить архив можно в любое место окна (Toolbar) — на телефоне про «перетащите» не пишем
const GHOSTS = 5;

// Иногда из плитки выглядывает мимик: ящик, который ждёт архив. Окно обрезки стоит низом на нижнем крае плитки,
// тело рисуется поверх нижнего ряда пунктира и прерывает его — мимик вылезает из-за края, а не висит над ним.
// Кадры: [кадр, сдвиг вниз в клетках из 16, сколько держится мс]. Всё кратно 80 мс (--px-frame), 2,4 с в сумме:
// подъём 4 шага по 2 клетки, пауза, прикрыл, глянул, моргнул, открыт, прикрыл, захлопнул, спуск 4 шага
const PAUSE_Y = 4;
const PEEK_STEPS = [
  ['shut', 12, 80], ['shut', 10, 80], ['shut', 8, 80], ['shut', 6, 80],
  ['shut', PAUSE_Y, 240], ['half', PAUSE_Y, 80], ['look', PAUSE_Y, 720], ['blink', PAUSE_Y, 160], ['open', PAUSE_Y, 400],
  ['half', PAUSE_Y, 80], ['shut', PAUSE_Y, 80],
  ['shut', 4, 80], ['shut', 6, 80], ['shut', 8, 80], ['shut', 10, 80],
];
const PEEK_FRAMES = Object.fromEntries(Object.entries({ open: OPEN, blink: BLINK, look: LOOK, half: HALF, shut: SHUT })
  .map(([key, grid]) => [key, { body: gridPath(grid, '#'), eyes: gridPath(grid, 'o') }]));
// Не больше трёх раз за визит, промежутки растут: через ≈30 с, ≈90 с и ≈4 мин (±20 %). Эти же слова про «больше
// никогда» — в sessionStorage: нажали на плитку или бросили файл — значит, человек уже знает, что делать
const PEEK_GAPS = [30, 90, 240];
const QUIET_MS = 3000;
const NEVER_KEY = 'mimikin_peek_never';
let peeked = 0;
let neverMem = false;
const isNever = () => {
  try { return neverMem || sessionStorage.getItem(NEVER_KEY) === '1'; } catch { return neverMem; }
};
const setNever = () => {
  neverMem = true;
  try { sessionStorage.setItem(NEVER_KEY, '1'); } catch { /* приватный режим — хватит и памяти страницы */ }
};
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

// Когда выглядывать. Не выглядывает: 3 с после клавиш и прокрутки (человек занят), пока над окном тащат файл
// (плитка сама меняет вид), во вкладке в фоне, если плитки не видно и при «уменьшить движение». Возвращает
// номер кадра сценария или -1, когда мимика нет
const usePeek = (tileRef, enabled) => {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    const tile = tileRef.current;
    if (!enabled || !tile) return undefined;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    let play = 0;
    let drag = 0;
    let lastInput = -Infinity;
    let visible = false;
    const hide = () => { clearTimeout(play); setStep(-1); };
    const stop = () => { setNever(); clearTimeout(timer); hide(); };
    const schedule = () => {
      clearTimeout(timer);
      if (peeked >= PEEK_GAPS.length || isNever() || calm.matches) return;
      timer = setTimeout(tryPeek, Math.round(PEEK_GAPS[peeked] * (0.8 + Math.random() * 0.4)) * 1000);
    };
    function tryPeek() {
      if (isNever() || calm.matches) return;
      if (document.hidden || !visible || drag || performance.now() - lastInput < QUIET_MS) {
        timer = setTimeout(tryPeek, QUIET_MS);
        return;
      }
      peeked += 1;
      let i = 0;
      const next = () => {
        setStep(i);
        const ms = PEEK_STEPS[i][2];
        i += 1;
        play = setTimeout(i < PEEK_STEPS.length ? next : hide, ms);
      };
      next();
      schedule();
    }
    const touch = () => { lastInput = performance.now(); };
    const onEnter = (e) => { if (hasFiles(e)) { drag += 1; hide(); } };
    const onLeave = (e) => { if (hasFiles(e)) drag = Math.max(0, drag - 1); };
    const onDrop = (e) => { if (hasFiles(e)) { drag = 0; stop(); } };
    const onVisibility = () => { if (document.hidden) hide(); };
    const onCalm = () => { if (calm.matches) { clearTimeout(timer); hide(); } else schedule(); };
    const events = ['keydown', 'input', 'wheel', 'scroll', 'touchmove'];
    events.forEach((ev) => window.addEventListener(ev, touch, { passive: true, capture: true }));
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    document.addEventListener('visibilitychange', onVisibility);
    calm.addEventListener('change', onCalm);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (!visible) hide(); }, { threshold: 0.5 });
    observer.observe(tile);
    tile.addEventListener('click', stop);
    schedule();
    return () => {
      clearTimeout(timer);
      clearTimeout(play);
      events.forEach((ev) => window.removeEventListener(ev, touch, { capture: true }));
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      document.removeEventListener('visibilitychange', onVisibility);
      calm.removeEventListener('change', onCalm);
      observer.disconnect();
      tile.removeEventListener('click', stop);
    };
  }, [tileRef, enabled]);
  return step;
};

const Peek = ({ step }) => {
  const side = useCrispSide(32);
  // Пока выглядывает плитка, мимик в шапке не двигается
  useOtherMimic(step >= 0);
  const [frame, y] = step >= 0 ? PEEK_STEPS[step] : ['shut', 12];
  const f = PEEK_FRAMES[frame];
  return (
    <span className="welcome-peek" hidden={step < 0} style={{ width: side, height: side }} aria-hidden="true">
      <svg viewBox="0 0 16 16" shapeRendering="crispEdges" focusable="false" style={{ transform: `translateY(${(y * side) / 16}px)` }}>
        <path fill="currentColor" d={f.body} />
        <path fill="var(--gold-light)" d={f.eyes} />
      </svg>
    </span>
  );
};

const Welcome = ({ t, canUpload, onUpload }) => {
  const tileRef = useRef(null);
  const step = usePeek(tileRef, canUpload);
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h2 id="welcome-title" className="shelf-title welcome-title">{t.shelf_yours}</h2>
      <div className="welcome-row">
        {canUpload ? (
          <button type="button" className="welcome-drop" ref={tileRef} onClick={onUpload}>
            <IconUpload />
            <span className="welcome-drop-title">{t.add_game}</span>
            <span className="welcome-drop-hint">{t.drop_hint}</span>
            <Peek step={step} />
          </button>
        ) : (
          <div className="welcome-drop"><span className="welcome-drop-hint">{t.drop_hint}</span></div>
        )}
        {Array.from({ length: GHOSTS }, (_, i) => <span key={i} className="welcome-ghost" aria-hidden="true" />)}
      </div>
      <p className="welcome-note">{t.welcome_folder}</p>
    </section>
  );
};

export default Welcome;
