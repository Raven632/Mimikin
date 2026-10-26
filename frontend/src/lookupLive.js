import { useEffect, useState } from 'react';
import { socket } from './socket';

// Сайты поиска — как в журнале «Как искали» (LookupHelp)
export const SITES = { itch: 'itch.io', vndb: 'VNDB', steam: 'Steam' };

// Шаги поиска одной игры вживую: сервер шлёт каждый шаг, как только сайт ответил (services/scraper.js,
// lookup-step). initial — шаги, сделанные до того, как окно открылось (из очереди поиска). Новый поиск
// этой игры (lookup-start) начинает список заново. Компонент с другой игрой — со своим key
// Шаг с номером n ложится на своё место: пришёл и в снимке, и по сокету — показывается один раз
export function useLiveSteps(id, initial = null) {
  const [live, setLive] = useState({ restarted: false, steps: [], running: null });
  useEffect(() => {
    const onStart = (d) => { if (d.id === id) setLive({ restarted: true, steps: [], running: true }); };
    const onStep = (d) => {
      if (d.id !== id) return;
      setLive((l) => ({ ...l, steps: [...l.steps, { n: d.n, step: d.step }], running: true }));
    };
    const onDone = (d) => { if (d.id === id) setLive((l) => ({ ...l, running: false })); };
    socket.on('lookup-start', onStart);
    socket.on('lookup-step', onStep);
    socket.on('lookup-done', onDone);
    return () => {
      socket.off('lookup-start', onStart);
      socket.off('lookup-step', onStep);
      socket.off('lookup-done', onDone);
    };
  }, [id]);
  const steps = live.restarted ? [] : [...(initial || [])];
  for (const { n, step } of live.steps) {
    if (Number.isInteger(n) && n >= 0) steps[n] = step;
    else steps.push(step);
  }
  return { steps: steps.filter(Boolean), running: live.running ?? !!initial };
}
