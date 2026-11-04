import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { formatPlaytime } from '../formatPlaytime';

// Склейка двух копий одной игры (ревизия, services/copies.js). Сначала — что будет, и считает это сервер: копию человек
// выбирает сам, заранее не отмечаем — по имени папки не всегда видно, какая версия новее. Фокус на «Отмена», Escape — тоже она
const MergeCopies = ({ pair, t, onClose, onDone }) => {
  const ref = useRef(null);
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState('');
  const [keep, setKeep] = useState('');
  const [busy, setBusy] = useState(false);
  useLayer(ref, () => { if (!busy) onClose(); }, { focus: '.confirm-cancel' });

  const [a, b] = pair.games.map((g) => g.id);
  useEffect(() => {
    let alive = true;
    fetch(`/api/games/duplicates/plan?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json) => { if (alive) setInfo(json); })
      .catch(() => { if (alive) setFailed(t.merge_load_failed); });
    return () => { alive = false; };
  }, [a, b, t]);

  const plan = keep ? info?.plans[keep] : null;
  const other = plan && info.copies.find((c) => c.id === plan.drop);

  const facts = (copy) => [
    formatPlaytime(copy.playtime, t) && t.merge_time(formatPlaytime(copy.playtime, t)),
    copy.saves && t.merge_saves,
    copy.moments && t.merge_moments,
    !copy.saves && !copy.moments && t.merge_no_play,
    copy.shelved && !info.plans[copy.id] && t.merge_shelved,
  ].filter(Boolean).join(', ');

  const merge = async () => {
    setBusy(true);
    setFailed('');
    const res = await fetch('/api/games/duplicates/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep: plan.keep, drop: plan.drop }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) onDone(other.title);
    else setFailed(t.merge_failed);
  };

  return createPortal(
    <div className="modal-overlay active pop confirm-overlay" onClick={(e) => { e.stopPropagation(); if (!busy) onClose(); }}>
      <div ref={ref} className="confirm-box merge-box" role="dialog" aria-modal="true" aria-labelledby="merge-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h2 id="merge-title" className="confirm-title">{t.merge_title}</h2>
        {info && (
          <>
            <div className="confirm-name">{t.merge_question}</div>
            <div className="set-choice merge-choice" role="radiogroup" aria-label={t.merge_question}>
              {info.copies.map((copy) => (
                <button
                  key={copy.id} type="button" role="radio" aria-checked={keep === copy.id}
                  className={`set-choice-btn${keep === copy.id ? ' active' : ''}`}
                  disabled={!info.plans[copy.id] || busy} onClick={() => setKeep(copy.id)}
                >
                  <span className="merge-copy-title">{copy.title}</span>
                  <span className="merge-copy-facts">{copy.id}</span>
                  <span className="merge-copy-facts">{facts(copy)}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {plan && (
          <div className="merge-plan" role="status">
            {plan.saves === 'both' && <p className="merge-warn">{t.merge_saves_both}</p>}
            {plan.saves === 'move' && <p>{t.merge_saves_move}</p>}
            {plan.saves === 'none' && <p>{t.merge_saves_none}</p>}
            {plan.playtime >= 60 && <p>{t.merge_total(formatPlaytime(plan.playtime, t))}</p>}
            {plan.carries.length > 0 && <p>{t.merge_carry(plan.carries.map((f) => t.merge_fields[f]).join(', '))}</p>}
            <p className={plan.saves === 'both' ? 'merge-warn' : undefined}>{(plan.saves === 'both' ? t.merge_trash_saves : t.merge_trash)(other.title)}</p>
          </div>
        )}
        {failed && <p className="confirm-text" role="alert">{failed}</p>}
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" disabled={busy} onClick={onClose}>{t.cancel}</button>
          <button type="button" className="confirm-ok" disabled={!plan || busy} onClick={merge}>{busy ? t.merge_busy : t.merge_go}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default MergeCopies;
