import { useEffect, useState } from 'react';
import { formatRetry } from '../formatRetry';
import { timeAgo } from '../formatAgo';
import LibraryCheck from './LibraryCheck';
import StateView from './StateView';

const GB = 1073741824;
const fmtSize = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`);

// Раздел показываем только если в нём что-то есть: пустые заголовки создают
// ощущение, что проверка не отработала
const Section = ({ title, hint, count, children }) => {
  if (!count) return null;
  return (
    <>
      <h3 className="stats-section">{title} <span className="audit-count">{count}</span></h3>
      {hint && <div className="audit-hint">{hint}</div>}
      {children}
    </>
  );
};

// Ревизия библиотеки: то, чего по списку игр не видно. Считает сервер, здесь —
// только показ и переход к игре, чтобы найденное можно было сразу починить.
// Вкладка окна «Статистика и ревизия» (LibraryModal): окно, крестик и Escape — там.
// Сверху — полная проверка (LibraryCheck): сервер проверяет и сам, понемногу, а она — все игры сразу
const AuditPanel = ({ t, lang, games = [], onOpenGame, check, onStartCheck, onCancelCheck }) => {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  // «Ещё раз» после ошибки — собрать ревизию заново
  const [reload, setReload] = useState(0);
  // Итог кнопки «Искать ещё раз» по каждой группе: null → ещё не жали, число → поставлено
  const [retried, setRetried] = useState({});
  // Полная проверка закончилась, пока окно открыто, — ревизию собираем заново: данные игр изменились
  const checkFinished = check?.finishedAt || 0;

  useEffect(() => {
    // Окно могут закрыть раньше, чем придёт ответ: тогда setState уже некуда писать
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/games/audit');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (alive) { setData(json); setFailed(false); }
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [checkFinished, reload]);

  const openGame = (id) => onOpenGame(id);

  // Ошибки в играх с настоящих устройств (rpg-fixes присылает, services/gameErrors.js хранит)
  const [gameErrors, setGameErrors] = useState([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/errors').then((r) => r.json()).then((d) => { if (alive) setGameErrors(d.games || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const clearErrors = async (id) => {
    await fetch(`/api/errors/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    setGameErrors((prev) => prev.filter((g) => g.game !== id));
  };
  const titleOf = (id) => {
    const g = games.find((x) => x.id === id);
    return g ? g.displayTitle || g.title || id : id;
  };

  const list = (items, limit = 12) => (
    <>
      <div className="audit-list">
        {items.slice(0, limit).map(item => (
          <button key={item.id} type="button" className="audit-item" onClick={() => openGame(item.id)}>
            <span className="audit-item-name">{item.title || item.id}</span>
            {item.size > 0 && <span className="audit-item-size">{fmtSize(item.size)}</span>}
          </button>
        ))}
      </div>
      {items.length > limit && <div className="audit-more">{t.audit_more(items.length - limit)}</div>}
    </>
  );

  // Что будет с игрой дальше: когда следующая попытка, или что автопоиск сдался
  const metaNote = (item) => {
    const parts = [];
    if (item.status === 'error' && item.error) parts.push(t.meta_failed(item.error));
    parts.push(item.retryAt ? t.meta_next(formatRetry(item.retryAt, lang)) : t.meta_stopped);
    return parts.join(', ');
  };

  const metaList = (items, limit = 12) => (
    <>
      <div className="audit-list">
        {items.slice(0, limit).map(item => (
          <button key={item.id} type="button" className="audit-item" onClick={() => openGame(item.id)}>
            <span className="audit-item-name">{item.title || item.id}</span>
            <span className="audit-item-size">{metaNote(item)}</span>
          </button>
        ))}
      </div>
      {items.length > limit && <div className="audit-more">{t.audit_more(items.length - limit)}</div>}
    </>
  );

  // Поиск заново для всей группы: срок у игр «подходит» сразу, воркер берёт их по одной
  const retry = async (scope) => {
    setRetried(prev => ({ ...prev, [scope]: 'busy' }));
    try {
      const res = await fetch('/api/games/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const json = await res.json();
      setRetried(prev => ({ ...prev, [scope]: res.ok ? (json.queued || 0) : null }));
    } catch {
      setRetried(prev => ({ ...prev, [scope]: null }));
    }
  };

  const retryButton = (scope, count, label = t.audit_retry_all) => {
    const state = retried[scope];
    if (typeof state === 'number') return <div className="audit-retry-done">{t.rescan_queued(state)}</div>;
    return (
      <button type="button" className="audit-retry" disabled={state === 'busy'} onClick={() => retry(scope)}>
        {label(count)}
      </button>
    );
  };

  // Чего не хватает игре: «нет описания · нет ссылки»
  const gapList = (items, limit = 12) => (
    <>
      <div className="audit-list">
        {items.slice(0, limit).map(item => (
          <button key={item.id} type="button" className="audit-item" onClick={() => openGame(item.id)}>
            <span className="audit-item-name">{item.title || item.id}</span>
            <span className="audit-item-size">{item.gaps.map(g => t.audit_gap[g]).join(', ')}</span>
          </button>
        ))}
      </div>
      {items.length > limit && <div className="audit-more">{t.audit_more(items.length - limit)}</div>}
    </>
  );

  const improvable = data?.improvable || [];
  const nothing = data
    && !data.broken.length && !data.duplicates.length && !data.missing.length
    && !data.partial.length && !improvable.length && !data.never.length && !data.orphans.length && !gameErrors.length;

  return (
    <>
        {onStartCheck && (
          <LibraryCheck check={check} onStart={onStartCheck} onCancel={onCancelCheck} games={games} t={t} lang={lang} onOpenGame={openGame} />
        )}

        {!data && !failed && <StateView kind="loading" title={t.audit_loading} />}
        {failed && <StateView kind="error" title={t.audit_error} onRetry={() => { setFailed(false); setReload((n) => n + 1); }} retryLabel={t.retry} />}

        {data && (
          <>
            <div className="audit-hint">{t.audit_checked(data.total)}</div>
            {/* Насколько библиотека покрыта данными: ссылки на страницы Steam, VNDB и itch.io */}
            {data.coverage && <div className="audit-hint audit-coverage">{t.audit_coverage(data.coverage, data.total)}</div>}
            {data.pending > 0 && <div className="audit-hint">{t.audit_pending(data.pending)}</div>}
            {nothing && <StateView kind="done" title={t.audit_clean} />}

            <Section title={t.audit_errors} hint={t.audit_errors_hint} count={gameErrors.length}>
              <div className="audit-errors">
                {gameErrors.map((g) => (
                  <div key={g.game} className="audit-error-game">
                    <div className="audit-error-head">
                      <button type="button" className="audit-item" onClick={() => openGame(g.game)}>
                        <span className="audit-item-name">{titleOf(g.game)}</span>
                        <span className="audit-item-size">{timeAgo(g.lastAt, lang)}</span>
                      </button>
                      <button type="button" className="audit-retry" onClick={() => clearErrors(g.game)}>{t.audit_errors_clear}</button>
                    </div>
                    {g.errors.slice(0, 5).map((e) => (
                      <details key={e.id} className="audit-error">
                        <summary>
                          <span className="audit-error-device">{e.device}</span>
                          <span className="audit-error-msg">{e.message}</span>
                          {e.count > 1 && <span className="audit-error-count">×{e.count}</span>}
                        </summary>
                        <pre>{[e.source ? `${e.source}${e.line ? `:${e.line}` : ''}` : '', e.scene ? `${t.audit_errors_scene}: ${e.scene}` : '', e.stack].filter(Boolean).join('\n')}</pre>
                      </details>
                    ))}
                    {g.errors.length > 5 && <div className="audit-more">{t.audit_more(g.errors.length - 5)}</div>}
                  </div>
                ))}
              </div>
            </Section>

            <Section title={t.audit_broken} hint={t.audit_broken_hint} count={data.broken.length}>
              {list(data.broken)}
            </Section>

            <Section title={t.audit_dupes} hint={t.audit_dupes_hint} count={data.duplicates.length}>
              {data.duplicates.map(group => (
                <div key={group.games.map(g => g.id).join('|')} className="audit-group">
                  <div className="audit-group-why">{group.why.map(w => t.audit_dupes_why[w]).join(', ')}</div>
                  {group.games.map(item => (
                    <button key={item.id} type="button" className="audit-item" onClick={() => openGame(item.id)}>
                      <span className="audit-item-name">{item.title || item.id}</span>
                      <span className="audit-item-size">{item.size > 0 ? fmtSize(item.size) : item.id}</span>
                    </button>
                  ))}
                </div>
              ))}
            </Section>

            <Section title={t.audit_missing} hint={t.audit_missing_hint} count={data.missing.length}>
              {metaList(data.missing)}
              {retryButton('missing', data.missing.length)}
            </Section>

            <Section title={t.audit_partial} hint={t.audit_partial_hint} count={data.partial.length}>
              {metaList(data.partial)}
              {retryButton('partial', data.partial.length)}
            </Section>

            <Section title={t.audit_improvable} hint={t.audit_improvable_hint} count={improvable.length}>
              {gapList(improvable)}
              {retryButton('improvable', improvable.length, t.audit_improve_all)}
            </Section>

            <Section title={t.audit_orphans} hint={t.audit_orphans_hint} count={data.orphans.length}>
              <div className="audit-list">
                {data.orphans.map(o => (
                  <div key={`${o.kind}:${o.id}`} className="audit-item audit-item-static">
                    <span className="audit-item-name">{o.id}</span>
                    <span className="audit-item-size">{{ saves: t.audit_orphan_saves, media: t.audit_orphan_media, old: t.audit_orphan_old }[o.kind]}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section title={t.audit_never} count={data.never.length}>
              {list(data.never)}
            </Section>

            <Section title={t.audit_heavy} count={data.heavy.length}>
              {list(data.heavy, 10)}
            </Section>
          </>
        )}
    </>
  );
};

export default AuditPanel;
