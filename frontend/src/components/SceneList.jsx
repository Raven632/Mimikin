import { useEffect, useRef, useState } from 'react';
import RetryImg from './RetryImg';
import { IconPlay, IconSound, IconFilm, IconLoop, IconFork } from './icons';
import { peekFrames } from '../galleryView';
import { reducedMotion } from '../windowFly';

// Разделы «Сцены» и «Диалоги» галереи: плитки в той же сетке, что и альбомы. Название сверху (под ним — говорящие), внизу
// слева значки (голос, выбор, ролик, анимация), внизу справа золотая пилюля «▶ N реплик»: нажатие сразу открывает плеер
// (GameGallery, onOpen). У плитки нет своего файла, поэтому ни сердечка, ни просмотра картинок. src — адрес миниатюры.
// У диалога портрет почти всегда один и тот же, поэтому он затемнён, а главное на плитке — первая реплика (sum.f);
// без неё — название по центру. Сводки (sum) нет у старого оглавления: тогда только название и «▶»

// Живая плитка: при наведении, а на телефоне при долгом нажатии кадры сцены сменяют друг друга, и видно, что внутри.
// Следующий кадр показываем, только когда он уже загружен: иначе плитка мигала бы пустотой. Палец сдвинулся — браузер
// листает страницу и шлёт pointercancel: это не нажатие
const rowId = (r) => `${r.album.key}\n${r.n}`;
const HOVER_MS = 250;
const PRESS_MS = 350;
const STEP_MS = 650;
const usePeek = (src) => {
  const [peek, setPeek] = useState(null);   // { id, file } — плитка и её кадр сейчас
  const run = useRef({ wait: 0, step: 0, touch: false, pressed: false });
  const stop = () => {
    clearTimeout(run.current.wait);
    clearInterval(run.current.step);
    run.current.touch = false;
    setPeek(null);
  };
  useEffect(() => () => { clearTimeout(run.current.wait); clearInterval(run.current.step); }, []);
  const start = (id, frames, touch, delay) => {
    stop();
    if (frames.length < 2 || reducedMotion()) return;
    run.current.touch = touch;
    run.current.wait = setTimeout(() => {
      run.current.pressed = touch;
      const ready = new Set();
      for (const f of frames) { const img = new Image(); img.onload = () => ready.add(f); img.src = src('thumb', f); }
      let at = 0;
      run.current.step = setInterval(() => {
        const list = frames.filter((f) => ready.has(f));
        if (list.length) setPeek({ id, file: list[at++ % list.length] });
      }, STEP_MS);
    }, delay);
  };
  const bind = (id, frames) => ({
    onPointerEnter: (e) => { if (e.pointerType === 'mouse') start(id, frames, false, HOVER_MS); },
    onPointerLeave: stop,
    onPointerDown: (e) => { if (e.pointerType === 'touch') { run.current.pressed = false; start(id, frames, true, PRESS_MS); } },
    onPointerUp: (e) => { if (e.pointerType === 'touch') stop(); },
    // Отмена — листают: клика после неё не будет, следующий клик настоящий
    onPointerCancel: () => { run.current.pressed = false; stop(); },
    // Долгое нажатие на телефоне — не меню браузера над картинкой
    onContextMenu: (e) => { if (run.current.touch) e.preventDefault(); },
  });
  // Отпустили после долгого нажатия: сцену не открываем, человек только смотрел
  const pressed = () => { const was = run.current.pressed; run.current.pressed = false; return was; };
  return { peek, bind, pressed };
};

const SceneList = ({ rows, t, src, spineCover, onOpen }) => {
  const s = t.scene_list;
  const { peek, bind, pressed } = usePeek(src);
  return (
    <div className="gallery-grid">
      {rows.map((r, i) => {
        const m = r.sum;
        const talk = r.album.kind === 'dialogue';
        // Кто говорит: из таблицы «Кто в сцене» (r.w, GameGallery), без неё — из оглавления
        const w = r.w !== undefined ? r.w : m?.w;
        const who = w ? w.join(', ') : '';
        // Название диалога часто и есть его первая реплика, поэтому над репликой — говорящие (нет их — название), а не то же самое дважды
        const top = talk ? (m?.f ? who || r.title : '') : r.title;
        const sub = talk ? '' : who;
        // «118 реплик»: на самом узком экране слово убираем, остаётся «▶ 118»
        const [num, ...word] = m?.l ? s.lines(m.l).split(' ') : [];
        const badges = m ? [m.v && ['voice', IconSound, s.voice], m.c && ['choice', IconFork, s.choice], m.m && ['video', IconFilm, s.video], m.a && ['anim', IconLoop, s.anim]].filter(Boolean) : [];
        return (
          <button key={`${r.album.key}\n${r.n}`} type="button" className={`gallery-tile scene-tile${talk ? ' talk' : ''}`} onClick={() => { if (!pressed()) onOpen(i); }} {...bind(rowId(r), peekFrames(r))}>
            {/* Набор Spine: обложка — кадр, снятый при первом просмотре (хранилище браузера); пока его нет — пустая плитка с названием */}
            {r.album.spine || r.album.live2d ? (spineCover(r.album) ? <img src={spineCover(r.album)} alt="" className="loaded" /> : <span className="gallery-tile-empty" aria-hidden="true" />)
              : r.cover ? <RetryImg src={src('thumb', r.cover)} alt="" loading="lazy" fallback={<span className="gallery-tile-empty" aria-hidden="true" />} /> : <span className="gallery-tile-empty" aria-hidden="true" />}
            {peek?.id === rowId(r) && <img src={src('thumb', peek.file)} alt="" className="tile-peek loaded" />}
            {talk && <span className="tile-quote"><span>{m?.f || r.title}</span></span>}
            {top && <span className="gallery-name">{top}{sub && <span className="tile-sub">{sub}</span>}</span>}
            <span className="gallery-count play">
              <IconPlay />
              {m && (m.l ? <span>{num}<span className="lines-w"> {word.join(' ')}</span></span> : <span>{s.no_lines}</span>)}
            </span>
            {badges.length > 0 && (
              <span className="tile-badges">
                {badges.map(([k, Ic, label]) => <span key={k} className={`gallery-badge ${k}`} aria-label={label} data-tip={label}><Ic /></span>)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default SceneList;
