import { useEffect, useState } from 'react';
import LookupSteps from './LookupSteps';
import { useLiveSteps } from '../lookupLive';

// Поиск данных этой игры, пока он идёт: шаги по сайтам вживую. Ещё не началась — какая по счёту в очереди
// (и что очередь на паузе: игру, которую попросили искать сами, это не держит)
const LookupLive = ({ id, t }) => {
  const [queue, setQueue] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/games/lookup-queue').then((r) => (r.ok ? r.json() : null)).then((q) => { if (alive) setQueue(q); }).catch(() => {});
    return () => { alive = false; };
  }, [id]);
  const initial = queue?.current?.id === id ? queue.current.steps : null;
  const { steps, running } = useLiveSteps(id, initial);
  const place = queue ? queue.next.findIndex((g) => g.id === id) : -1;
  if (!steps.length && !running) {
    return place >= 0 ? <span className="meta-status-hint">{t.queue_place(place + 1 + (queue.current ? 1 : 0))}</span> : null;
  }
  return <LookupSteps steps={steps} running={running} t={t} />;
};

export default LookupLive;
