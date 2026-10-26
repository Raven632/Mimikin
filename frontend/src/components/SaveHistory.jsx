import { useCallback, useEffect, useState } from 'react';
import { formatPlaytime } from '../formatPlaytime';
import { confirmDialog } from '../confirm';
import { errorText, httpError } from '../apiError';
import StateView from './StateView';
import { IconHourglass } from './icons';
import { slotName } from '../saveSlots';

// «ур. 12 · 3400 G · 5 ч 20 мин · Town» — что разобралось из сейва
function describe(summary, t) {
  if (!summary) return '';
  return [
    summary.level ? t.saves_level(summary.level) : '',
    summary.gold != null ? `${summary.gold.toLocaleString()} G` : '',
    formatPlaytime(summary.playtime, t),
    summary.map || '',
  ].filter(Boolean).join(', ');
}

async function fetchHistory(id) {
  const res = await fetch(`/api/saves/history/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data.slots || [];
}

// «История сейвов» в окне игры: слоты и их прежние версии (сервер хранит их при каждой
// перезаписи слота, при удалении в игре и при импорте) — любую можно вернуть
export default function SaveHistory({ game, t, lang, notify, onClose, onRestored }) {
  const [slots, setSlots] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  // Прочитать заново — после возврата версии
  const [reload, setReload] = useState(0);

  const when = useCallback((at) => new Date(at).toLocaleString(lang, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }), [lang]);

  useEffect(() => {
    let alive = true;
    fetchHistory(game.id).then(
      (list) => { if (alive) { setSlots(list); setError(''); } },
      (e) => { if (alive) setError(errorText(t, e)); },
    );
    return () => { alive = false; };
  }, [game.id, t, reload]);

  const restore = async (slot, version) => {
    const ok = await confirmDialog({
      title: t.saves_restore_title,
      name: game.displayTitle || game.title,
      text: t.saves_restore_text(slotName(slot.key, t), when(version.at)),
      confirmLabel: t.saves_restore,
    });
    if (!ok) return;
    setBusy(version.id);
    try {
      const res = await fetch(`/api/saves/history/${encodeURIComponent(game.id)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: slot.key, version: version.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      notify(t.saves_restored, 'success');
      onRestored?.();
      setReload((n) => n + 1);
    } catch (e) {
      notify(errorText(t, e), 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="save-history">
      <div className="save-history-head">
        <h2>{t.saves_history}</h2>
        <button type="button" className="cancel-btn" onClick={onClose}>{t.saves_back}</button>
      </div>
      <p className="save-history-hint">{t.saves_history_hint}</p>

      {error && <StateView kind="error" title={error} onRetry={() => { setError(''); setReload((n) => n + 1); }} retryLabel={t.retry} />}
      {!error && !slots && <StateView kind="loading" title={t.saves_loading} />}
      {!error && slots && slots.length === 0 && <StateView title={t.saves_none} hint={t.saves_none_hint} />}

      {slots?.map((slot) => (
        <section key={slot.key} className="save-slot">
          <h3>{slotName(slot.key, t)}</h3>
          <div className="save-version current">
            <div className="save-version-main">
              <span className="save-version-when">
                {slot.current ? `${t.saves_now}, ${when(slot.current.at)}` : t.saves_empty_slot}
              </span>
              {slot.current?.summary && <span className="save-version-info">{describe(slot.current.summary, t)}</span>}
            </div>
          </div>
          {slot.versions.length === 0 && <p className="save-version-none">{t.saves_no_versions}</p>}
          {slot.versions.map((v) => (
            <div key={v.id} className="save-version">
              <div className="save-version-main">
                <span className="save-version-when">{when(v.at)}</span>
                {v.summary && <span className="save-version-info">{describe(v.summary, t)}</span>}
                {t.saves_reason[v.reason] && <span className="save-version-reason">{t.saves_reason[v.reason]}</span>}
              </div>
              <button type="button" className="save-version-btn" disabled={!!busy} onClick={() => restore(slot, v)}>
                {busy === v.id ? <IconHourglass /> : t.saves_restore}
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
