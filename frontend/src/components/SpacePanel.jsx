import { useEffect, useState } from 'react';
import { confirmDialog } from '../confirm';
import { timeAgo } from '../formatAgo';
import { formatPlaytime } from '../formatPlaytime';
import StateView from './StateView';
import MetaLine from './MetaLine';

const GB = 1073741824;
const fmtSize = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1048576))} MB`);
const sum = (list) => list.reduce((s, x) => s + (x.size || 0), 0);
const ALL_LIMIT = 15;
// Части диска на полосе: что именно занимает место библиотеки и сколько свободно
// system — всё остальное на том же диске (система, чужие файлы): так полоса складывается в весь диск
const PARTS = ['games', 'old', 'trash', 'other', 'uploads', 'system', 'free'];

// Раздел «что можно убрать»: пустой не показываем
const Section = ({ title, hint, items, total, children }) => {
  if (!items?.length) return null;
  return (
    <>
      <h3 className="stats-section">
        {title} <span className="audit-count">{items.length}</span>
        {total > 0 && <span className="space-total">{fmtSize(total)}</span>}
      </h3>
      {hint && <div className="audit-hint">{hint}</div>}
      {children}
    </>
  );
};

// «Место» — вкладка окна «Статистика и ревизия»: что сколько занимает на диске и что можно убрать.
// Считает сервер (services/space.js). Убрать — там, где это и так делается с вопросом: в окне игры
// (игра — в корзину, прежние версии), в корзине, в карточке загрузки. Прежние версии — ещё и все разом
// здесь: по одной через окно каждой игры 5 ГБ не убрать. Удалённая игра 30 дней лежит в корзине и место
// не освобождает — об этом сказано сразу
const SpacePanel = ({ t, lang, onOpenGame }) => {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [fresh, setFresh] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notRemoved, setNotRemoved] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch(`/api/games/space${fresh ? '?fresh=1' : ''}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => { if (alive) { setData(d); setFailed(false); } }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [fresh]);

  if (failed) return <StateView kind="error" title={t.space_error} onRetry={() => { setFailed(false); setFresh((n) => n + 1); }} retryLabel={t.retry} />;
  if (!data) return <StateView kind="loading" title={t.space_loading} />;

  const { disk, parts, suggest, trash, games } = data;
  const library = parts.games + parts.old + parts.trash + parts.media + parts.saves + parts.uploads;
  const sizes = { ...parts, other: parts.media + parts.saves, system: Math.max(0, disk.total - disk.free - library), free: disk.free };
  const shown = PARTS.filter((key) => sizes[key] > 0);
  const whole = shown.reduce((s, key) => s + sizes[key], 0) || 1;

  // Все прежние версии: тот же вопрос и тот же запрос, что в окне игры, — по игре за раз
  // Кнопка гаснет сразу, ещё до вопроса: двойной щелчок не задаёт его дважды
  const removeAllOld = async () => {
    if (removing) return;
    setRemoving(true);
    const list = suggest.old;
    try {
      if (!(await confirmDialog({ title: t.space_old_all_title, text: t.space_old_all_text(list.length), confirmLabel: t.space_old_all(fmtSize(sum(list))), danger: true }))) return;
      let failedCount = 0;
      for (const o of list) {
        try {
          const res = await fetch(`/api/games/${encodeURIComponent(o.id)}/old`, { method: 'DELETE' });
          if (!res.ok) failedCount++;
        } catch {
          failedCount++;
        }
      }
      setNotRemoved(failedCount);
      setFresh((n) => n + 1);
    } finally {
      setRemoving(false);
    }
  };

  // Строка игры: открыть её окно — оттуда она уходит в корзину или убираются прежние версии
  // Наигранное время и когда запускали; не запускали ни разу — так и пишем
  const gameNote = (g) => (g.playtime || g.lastPlayed
    ? [g.playtime ? formatPlaytime(g.playtime, t) : '', g.lastPlayed ? timeAgo(g.lastPlayed, lang) : '']
    : [t.space_never_played]);
  const gameRow = (g, size = g.size, note = gameNote(g)) => (
    <button key={g.id} type="button" className="audit-item" onClick={() => onOpenGame(g.id)}>
      <span className="audit-item-main">
        <span className="audit-item-name">{g.title}</span>
        <MetaLine className="audit-item-sub" parts={note} />
      </span>
      <span className="audit-item-num">{size ? fmtSize(size) : t.space_unsized}</span>
    </button>
  );
  const days = trash.nextPurgeAt ? Math.max(1, Math.ceil((trash.nextPurgeAt - data.at) / 864e5)) : 0;
  const candidates = [suggest.old, suggest.uploads, suggest.done, suggest.dropped, suggest.never, suggest.dupes].some((x) => x.length) || trash.count > 0;
  const list = showAll ? games : games.slice(0, ALL_LIMIT);

  return (
    <div className="space-panel">
      <div className="space-head">
        <div className="audit-hint">{t.space_summary(fmtSize(disk.total - disk.free), fmtSize(disk.total), fmtSize(disk.free))}</div>
        <button type="button" className="audit-retry" onClick={() => { setData(null); setFresh((n) => n + 1); }}>{t.space_refresh}</button>
      </div>
      {/* Полоса: части библиотеки и свободное — в долях от их суммы */}
      <div className="space-bar" role="img" aria-label={shown.map((key) => `${t.space_parts[key]}: ${fmtSize(sizes[key])}`).join(', ')}>
        {shown.map((key) => <span key={key} className={`space-bar-part ${key}`} style={{ flexGrow: sizes[key] / whole }} />)}
      </div>
      <ul className="space-legend">
        {shown.map((key) => (
          <li key={key}><span className={`space-dot ${key}`} aria-hidden="true" />{t.space_parts[key]} <b>{fmtSize(sizes[key])}</b></li>
        ))}
      </ul>
      {data.unsized > 0 && <div className="audit-hint">{t.space_unsized_hint(data.unsized)}</div>}

      <h3 className="stats-section space-title">{t.space_free_title}</h3>
      <div className="audit-hint">{t.space_free_hint}</div>
      {!candidates && <StateView kind="done" title={t.space_nothing} />}

      {trash.count > 0 && (
        <div className="audit-list">
          <div className="audit-item audit-item-static">
            <span className="audit-item-main">
              <span className="audit-item-name">{t.space_trash(trash.count)}</span>
              <span className="audit-item-sub">{t.space_trash_when(days)}</span>
            </span>
            <span className="audit-item-num">{fmtSize(trash.size)}</span>
          </div>
        </div>
      )}

      <Section title={t.space_old} hint={t.space_old_hint} items={suggest.old} total={sum(suggest.old)}>
        <div className="audit-list">
          {suggest.old.map((o) => (o.gone
            ? <div key={o.id} className="audit-item audit-item-static"><span className="audit-item-name">{o.title}</span><MetaLine className="audit-item-size" parts={[t.space_old_gone, fmtSize(o.size)]} /></div>
            : gameRow(o, o.size, [])))}
        </div>
        <button type="button" className="audit-retry space-remove-all" disabled={removing} onClick={removeAllOld}>{t.space_old_all(fmtSize(sum(suggest.old)))}</button>
        {notRemoved > 0 && <div className="audit-hint" role="alert">{t.space_old_all_failed(notRemoved)}</div>}
      </Section>

      <Section title={t.space_uploads} hint={t.space_uploads_hint} items={suggest.uploads} total={sum(suggest.uploads)}>
        <div className="audit-list">
          {suggest.uploads.map((u) => (
            <div key={u.id} className="audit-item audit-item-static">
              <span className="audit-item-name">{u.name}</span>
              <span className="audit-item-size">{t.space_uploads_of(fmtSize(u.size), fmtSize(u.of))}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t.space_done} hint={t.space_saves_kept} items={suggest.done} total={sum(suggest.done)}>
        <div className="audit-list">{suggest.done.map((g) => gameRow(g))}</div>
      </Section>
      <Section title={t.space_dropped} items={suggest.dropped} total={sum(suggest.dropped)}>
        <div className="audit-list">{suggest.dropped.map((g) => gameRow(g))}</div>
      </Section>
      <Section title={t.space_never} hint={t.space_never_hint} items={suggest.never} total={sum(suggest.never)}>
        <div className="audit-list">{suggest.never.map((g) => gameRow(g))}</div>
      </Section>
      <Section title={t.space_dupes} hint={t.space_dupes_hint} items={suggest.dupes}>
        {suggest.dupes.map((group) => (
          <div key={group.map((g) => g.id).join('|')} className="audit-group">
            {group.map((g) => gameRow(g))}
          </div>
        ))}
      </Section>

      <h3 className="stats-section space-title">{t.space_all} <span className="audit-count">{games.length}</span></h3>
      <div className="audit-list">
        {list.map((g) => gameRow(g, g.size, [...gameNote(g), g.old ? t.space_with_old(fmtSize(g.old)) : '']))}
      </div>
      {games.length > list.length && (
        <button type="button" className="audit-more check-more" onClick={() => setShowAll(true)}>{t.audit_more(games.length - list.length)}</button>
      )}
    </div>
  );
};

export default SpacePanel;
