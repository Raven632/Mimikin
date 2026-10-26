import { useCallback, useEffect, useState } from 'react';

export const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–:––');

// Действия над <video> — функциями вне хука: линтер React не даёт менять элемент, пришедший из состояния, прямо в хуке.
// play() на доигранном ролике сам начинает его сначала; отказ браузера (нет касания) не ошибка
const playPause = (v) => { if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); };
const muteToggle = (v) => { if (v) v.muted = !v.muted; };
const seekTo = (v, t) => { if (v) v.currentTime = t; };

// Управление роликом в просмотре галереи: [attach, vid] — attach ставят в ref у <video> (отдельно от vid: линтер счёл бы
// ссылкой весь объект), пауза и звук — в состоянии (меняются редко), а время
// живёт в VideoSeek: <video> шлёт timeupdate четыре раза в секунду, и перерисовывать из-за него весь просмотр незачем
export const useVideoControl = () => {
  const [el, setEl] = useState(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (!el) return undefined;
    const sync = () => { setPaused(el.paused); setMuted(el.muted); };
    const on = ['play', 'pause', 'ended', 'volumechange'];
    on.forEach((n) => el.addEventListener(n, sync));
    sync();
    return () => on.forEach((n) => el.removeEventListener(n, sync));
  }, [el]);
  const toggle = useCallback(() => playPause(el), [el]);
  const toggleMute = useCallback(() => muteToggle(el), [el]);
  const seek = useCallback((t) => seekTo(el, t), [el]);
  return [setEl, { el, paused, muted, toggle, toggleMute, seek }];
};
