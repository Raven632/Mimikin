import { useCallback, useEffect, useRef, useState } from 'react';
import { useLayer } from '../layers';
import { useClosing } from '../useClosing';
import { socket } from '../socket';
import { errorText, httpError } from '../apiError';
import LookupSteps from './LookupSteps';
import { useLiveSteps } from '../lookupLive';
import StateView from './StateView';
import { IconClose } from './icons';

const send = async (url, options = {}) => {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};

// Шаги игры, которая ищется сейчас: сделанные до открытия окна и новые вживую
const CurrentSteps = ({ current, t }) => {
  const { steps, running } = useLiveSteps(current.id, current.steps);
  return <LookupSteps steps={steps} running={running} t={t} />;
};

// «Поиск данных» — по нажатию на полосу «Ищутся данные…»: какая игра ищется сейчас и что с ней на каждом
// сайте, какие ждут, «Искать первой», пауза (сервер: services/scraper.js, queueState). Игры, которые
// попросили искать сами, ищутся и на паузе
const LookupQueue = ({ t, onClose, notify }) => {
  const ref = useRef(null);
  const [closing, close] = useClosing(onClose);
  useLayer(ref, close);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => send('/api/games/lookup-queue').then(setState).catch(() => setState((s) => s || { error: true })), []);
  useEffect(() => {
    load();
    // Игра нашлась, следующая началась, кто-то поставил на паузу — список меняется
    const reload = () => load();
    socket.on('lookup-start', reload);
    socket.on('lookup-done', reload);
    socket.on('scrape-progress', reload);
    return () => {
      socket.off('lookup-start', reload);
      socket.off('lookup-done', reload);
      socket.off('scrape-progress', reload);
    };
  }, [load]);

  const current = state?.current || null;

  const act = async (key, fn) => {
    setBusy(key);
    try { setState(await fn()); } catch (e) { notify?.(errorText(t, e), 'error'); } finally { setBusy(''); }
  };
  const pause = () => act('pause', () => send('/api/games/lookup-queue/pause', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: !state.paused }),
  }));
  const first = (id) => act(id, async () => {
    await send(`/api/games/${encodeURIComponent(id)}/rescrape`, { method: 'POST' });
    return send('/api/games/lookup-queue');
  });

  return (
    <div className={`modal-overlay active pop${closing ? ' closing' : ''}`} onClick={close}>
      <div ref={ref} className="stats-content queue-content" role="dialog" aria-modal="true" aria-labelledby="queue-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-actions-top"><button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button></div>
        <h2 id="queue-title" className="stats-title">{t.queue_title}</h2>
        {!state && <StateView kind="loading" title={t.queue_loading} />}
        {state?.error && <StateView kind="error" title={t.queue_error} onRetry={load} retryLabel={t.retry} />}
        {state && !state.error && (
          <>
            <div className="queue-head">
              <span className="set-hint">{state.paused ? t.queue_paused(state.left) : state.left ? t.queue_left(state.left) : t.queue_empty}</span>
              {(state.left > 0 || state.paused) && (
                <button type="button" className="meta-status-btn" disabled={!!busy} onClick={pause}>{state.paused ? t.queue_resume : t.queue_pause}</button>
              )}
            </div>
            {current && (
              <section className="queue-now">
                <h3 className="stats-section">{t.queue_now}</h3>
                <div className="queue-game">{current.title}</div>
                <CurrentSteps key={current.id} current={current} t={t} />
              </section>
            )}
            {state.next.length > 0 && (
              <section>
                <h3 className="stats-section">{t.queue_next}</h3>
                <ol className="queue-list">
                  {state.next.map((g) => (
                    <li key={g.id}>
                      <span className="queue-game">{g.title}</span>
                      {g.first
                        ? <span className="set-hint">{t.queue_first_set}</span>
                        : <button type="button" className="meta-status-btn subtle" disabled={!!busy} onClick={() => first(g.id)}>{t.queue_first}</button>}
                    </li>
                  ))}
                </ol>
                {state.left > state.next.length && <p className="set-hint">{t.queue_more(state.left - state.next.length)}</p>}
              </section>
            )}
            <p className="set-hint">{t.queue_note}</p>
          </>
        )}
      </div>
    </div>
  );
};

export default LookupQueue;
