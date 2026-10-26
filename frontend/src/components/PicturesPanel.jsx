import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { errorText, httpError } from '../apiError';
import { confirmDialog } from '../confirm';
import MetaLine from './MetaLine';

const PicturesReview = lazy(() => import('./PicturesReview'));

const send = async (url, options = {}) => {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};
const post = (url, body) => send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const minutes = (seconds) => Math.max(1, Math.round((seconds || 0) / 60));

// «Текст на картинках» в окне перевода (сервер: services/pictures.js, служба ocr/): найти подписи, нарисованные
// на картинках игры, — сначала картинки интерфейса, потом, по желанию, сцен. Идёт в фоне, ход — опросом. Найденное
// переводится вместе с игрой и рисуется в игре поверх подписи; проверить и поправить — экран «Картинки».
// Службы нет (запуск без docker compose) — блока нет; служба не отвечает — строка об этом
const PicturesPanel = ({ game, t, notify, engine }) => {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const prev = useRef('');
  const base = `/api/games/${encodeURIComponent(game.id)}/pictures`;

  useEffect(() => {
    let alive = true;
    let timer = null;
    const load = () => send(base).then((d) => {
      if (!alive) return;
      setSt(d);
      if ((prev.current === 'running' || prev.current === 'queued') && d.state === 'done') {
        notify(d.found ? t.pic_done_toast(d.found) : t.pic_none, d.found ? 'success' : 'info');
      }
      prev.current = d.state;
      if (d.state === 'running' || d.state === 'queued') timer = setTimeout(load, 2000);
    }).catch(() => {});
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [base, reload, notify, t]);

  if (!st?.configured) return null;
  if (!st.available && st.state !== 'running') return <span className="tl-state">{t.pic_title}: {t.pic_offline}</span>;

  const start = async (scope) => {
    const part = scope === 'all' ? st.estimate?.scene : st.estimate?.ui;
    const ok = await confirmDialog({
      title: t.pic_confirm_title,
      name: game.displayTitle || game.title,
      text: t.pic_confirm_text(part?.todo || 0, minutes(part?.seconds), engine),
      confirmLabel: t.pic_confirm_go,
    });
    if (!ok) return;
    setBusy(true);
    try {
      setSt(await post(base, { scope }));
      setReload((n) => n + 1);
    } catch (e) {
      notify(errorText(t, e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const pause = async () => {
    setBusy(true);
    try { setSt(await post(`${base}/pause`)); } catch (e) { notify(errorText(t, e), 'error'); } finally { setBusy(false); }
  };

  const running = st.state === 'running' || st.state === 'queued';
  const ui = st.estimate?.ui;
  const scene = st.estimate?.scene;
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
  let line = '';
  if (running) line = st.state === 'queued' ? t.pic_queued : t.pic_running(st.done, st.total);
  else if (st.state === 'paused') line = t.pic_paused(st.done, st.total);
  else if (st.state === 'error') line = t.pic_error;
  else if (st.state === 'done') line = st.found ? t.pic_found(st.found, st.pictures) : t.pic_none;
  else if (ui) line = t.pic_idle(ui.todo, minutes(ui.seconds));

  return (
    <div className="pic-panel">
      <MetaLine className="tl-state" parts={[<span key="t" className="pic-title">{t.pic_title}</span>, line, st.review > 0 && !running && t.pic_review_count(st.review)]} />
      {(running || st.state === 'paused') && st.total > 0 && (
        <div className="tl-track" role="progressbar" aria-valuemin={0} aria-valuemax={st.total} aria-valuenow={st.done}><span style={{ width: `${pct}%` }} /></div>
      )}
      <div className="tl-actions">
        {running && <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={pause}>{t.tl_pause}</button>}
        {!running && (st.state === 'paused' || st.state === 'error') && (
          <button type="button" className="meta-status-btn" disabled={busy} onClick={() => start(st.scope)}>{t.tl_resume}</button>
        )}
        {!running && !st.state && ui?.todo > 0 && (
          <button type="button" className="meta-status-btn" disabled={busy} onClick={() => start('ui')}>{t.pic_find}</button>
        )}
        {!running && st.found > 0 && (
          <button type="button" className="meta-status-btn" disabled={busy} onClick={() => setOpen(true)}>{t.pic_review}</button>
        )}
        {!running && st.state === 'done' && st.scope !== 'all' && scene?.todo > 0 && (
          <button type="button" className="meta-status-btn subtle" disabled={busy} data-tip={t.pic_scenes_hint} onClick={() => start('all')}>
            {t.pic_scenes(scene.todo, minutes(scene.seconds))}
          </button>
        )}
        {!running && st.state === 'done' && ui?.todo > 0 && (
          <button type="button" className="meta-status-btn subtle" disabled={busy} data-tip={t.pic_again_hint} onClick={() => start(st.scope)}>{t.pic_again(ui.todo)}</button>
        )}
      </div>
      {open && (
        <Suspense fallback={null}>
          <PicturesReview game={game} t={t} notify={notify} onClose={() => { setOpen(false); setReload((n) => n + 1); }} />
        </Suspense>
      )}
    </div>
  );
};

export default PicturesPanel;
