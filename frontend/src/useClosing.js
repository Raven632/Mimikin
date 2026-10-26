import { useEffect, useRef, useState } from 'react';

// Закрыть окно не мгновенно, а коротким исчезновением — как окно игры. close() ставит closing
// (у окна — класс .closing, index.css) и зовёт onClose, когда исчезновение доиграло
const CLOSE_MS = 200;

export function useClosing(onClose) {
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = () => {
    if (timer.current) return;
    setClosing(true);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    timer.current = setTimeout(() => onCloseRef.current(), reduce ? 0 : CLOSE_MS);
  };
  return [closing, close];
}
