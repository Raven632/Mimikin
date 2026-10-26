import { useEffect, useRef, useState } from 'react';
import { clock } from '../videoControl';

// Своя полоса перемотки вместо системных <video controls> и <input type=range>: у них серая панель Chromium и белый
// ползунок. Дорожка 3 точки с прямыми концами, пройденное — золотом, бегунок — самоцвет, как отметки состояний
// в Настройках (.svc-gem). Это slider без <input>: тянется мышью и пальцем (pointer events), с клавиатуры — ←/→ на
// step секунд, Home/End, пробел отдаёт onToggle (пауза). onSeek получает секунды
export const SeekLine = ({ value, max, onSeek, onToggle, label, step = 5, className = '' }) => {
  const box = useRef(null);
  const drag = useRef(false);
  const frac = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const at = (e) => {
    const r = box.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * max;
  };
  return (
    <span
      ref={box} className={`seek-line ${className}`} role="slider" tabIndex={0} aria-label={label}
      aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={`${clock(value)} / ${clock(max)}`}
      onPointerDown={(e) => { if (!(max > 0)) return; drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); onSeek(at(e)); }}
      onPointerMove={(e) => { if (drag.current) onSeek(at(e)); }}
      onPointerUp={() => { drag.current = false; }}
      onPointerCancel={() => { drag.current = false; }}
      onKeyDown={(e) => {
        const to = e.key === 'ArrowRight' ? value + step : e.key === 'ArrowLeft' ? value - step : e.key === 'Home' ? 0 : e.key === 'End' ? max : null;
        if (to !== null) { e.preventDefault(); onSeek(Math.min(max, Math.max(0, to))); }
        else if (e.key === ' ' && onToggle) { e.preventDefault(); onToggle(); }
      }}
    >
      <span className="seek-fill" style={{ width: `${frac * 100}%` }} />
      <span className="seek-gem" style={{ left: `${frac * 100}%` }} aria-hidden="true" />
    </span>
  );
};

// Строка перемотки под роликом: время по краям, полоса между ними. Лежит над короткой панелью просмотра; на светлом
// ролике у неё полупрозрачная тёмная подложка, на телефоне — чёрное поле под кадром
export const VideoSeek = ({ el, onSeek, onToggle, label }) => {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(NaN);
  useEffect(() => {
    if (!el) return undefined;
    const sync = () => { setTime(el.currentTime); setDuration(el.duration); };
    const on = ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked'];
    on.forEach((n) => el.addEventListener(n, sync));
    sync();
    return () => on.forEach((n) => el.removeEventListener(n, sync));
  }, [el]);
  const max = Number.isFinite(duration) ? duration : 0;
  const seek = (v) => { onSeek(v); setTime(v); };
  return (
    <div className="vseek" onClick={(e) => e.stopPropagation()}>
      <span className="seek-time cur">{clock(time)}</span>
      <SeekLine value={Math.min(time, max)} max={max} onSeek={seek} onToggle={onToggle} label={label} />
      <span className="seek-time">{clock(duration)}</span>
    </div>
  );
};
