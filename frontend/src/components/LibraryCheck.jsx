import { useState } from 'react';
import { timeAgo } from '../formatAgo';
import { formatDuration, checkEstimate } from '../checkSummary';
import { IconCheck, IconClose } from './icons';
import MetaLine from './MetaLine';

// Значок шага: ждёт — пустой круг, идёт — крутится, готово — галочка, не всё — «!», ошибка — «×»,
// отменён — «–»
const MARK = { done: <IconCheck />, partial: '!', error: <IconClose />, stopped: <IconClose />, cancelled: '–' };

// Сколько строк списка показывать сразу: остальное — по нажатию «…и ещё N»
const LIMIT = 12;

// Полная проверка библиотеки — сверху ревизии (AuditPanel). Сервер идёт по шагам
// (api/src/services/fullcheck.js) и шлёт ход по сокету, App держит его состояние и отдаёт сюда
// готовым. Здесь только показ: какой шаг идёт, сколько из скольких, чья игра сейчас и сколько
// примерно осталось, а в конце — что нового нашлось, с переходом к игре. «Отменить» — рядом с кнопкой
// запуска, а не на её месте: второе нажатие по «Проверить всё» не остановит только что начатую
const LibraryCheck = ({ check, onStart, onCancel, games = [], t, lang, onOpenGame }) => {
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Какие списки итога раскрыты целиком
  const [expanded, setExpanded] = useState({});
  const steps = check?.steps || [];
  const running = !!check?.running;
  const interrupted = !!check?.interrupted;
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));

  const start = async () => {
    setStarting(true);
    try {
      await onStart();
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    setStopping(true);
    try {
      await onCancel();
    } finally {
      setStopping(false);
    }
  };

  // Название — как в библиотеке сейчас; игру могли переименовать после проверки
  const titleOf = (id, fallback) => {
    const g = games.find((x) => x.id === id);
    return g ? g.displayTitle || g.title || id : fallback || id;
  };

  const time = (ms) => new Date(ms).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });

  // Строка под шапкой: идёт с такого-то времени, прервалась или когда была последняя
  let when = null;
  if (running) when = <div className="check-when">{t.check_started(time(check.startedAt))}</div>;
  else if (interrupted) when = <div className="check-when warn">{t.check_interrupted}</div>;
  else if (check?.cancelled) {
    when = <div className="check-when">{t.check_cancelled(timeAgo(check.finishedAt, lang), formatDuration(check.finishedAt - check.startedAt, t))}</div>;
  } else if (check?.finishedAt) {
    when = <div className="check-when">{t.check_last(timeAgo(check.finishedAt, lang), formatDuration(check.finishedAt - check.startedAt, t))}</div>;
  }

  // Шаг, на котором проверку прервал перезапуск сервера, не «идёт» — он остановлен
  const statusOf = (step) => (interrupted && step.status === 'running' ? 'stopped' : step.status);

  // Справа от названия шага: «45 из 84», пока идёт; «готово, 12 мин», когда закончен
  const stateText = (step, status) => {
    if (status === 'running') return step.total > 0 ? t.check_of(step.done, step.total) : t.check_state.running;
    const took = step.finishedAt && step.startedAt ? step.finishedAt - step.startedAt : 0;
    return took >= 60e3 ? <MetaLine parts={[t.check_state[status], formatDuration(took, t)]} /> : t.check_state[status];
  };

  // Строки под названием: что шаг делает, кого проверяет сейчас, итог или почему не всё
  const notes = (step, status) => {
    const r = step.result;
    if (status === 'pending') return [<div key="about" className="check-step-note">{t.check_about[step.key]}</div>];
    if (status === 'running') {
      const out = [];
      if (step.current) out.push(<div key="now" className="check-step-note now">{t.check_now(step.current)}</div>);
      else out.push(<div key="about" className="check-step-note">{t.check_about[step.key]}</div>);
      if (step.eta > 0) out.push(<div key="eta" className="check-step-note">{t.check_left(Math.round(step.eta / 60e3))}</div>);
      return out;
    }
    if (status === 'error' || status === 'stopped') {
      return step.error ? [<div key="err" className="check-step-note bad">{t.check_error(step.error)}</div>] : [];
    }
    const out = r ? [<div key="result" className="check-step-note">{t.check_result[step.key](r)}</div>] : [];
    if (status === 'partial') out.push(<div key="partial" className="check-step-note warn">{t.check_partial[step.key]}</div>);
    return out;
  };

  // Полоса хода. Шаг без счёта — бегущая полоска
  const bar = (step) => {
    if (!step.total) return <span className="check-bar indeterminate" role="progressbar"><span /></span>;
    const pct = Math.min(100, Math.round((step.done / step.total) * 100));
    return (
      <span className="check-bar" role="progressbar" aria-valuemin={0} aria-valuemax={step.total} aria-valuenow={step.done}>
        <span style={{ width: `${pct}%` }} />
      </span>
    );
  };

  // Итог: что нового нашлось. После перезапуска сервера — то, что успели до него
  const changed = byKey.sources?.result?.changed || [];
  const finished = !running && steps.some((s) => s.result);
  const nothingNew = !changed.length;

  const changeText = (c) => [
    c.linksAdded?.length ? t.check_changed.linksAdded(c.linksAdded.length) : '',
    c.linksRemoved?.length ? t.check_changed.linksRemoved(c.linksRemoved.length) : '',
    ...(c.fields || []).filter((f) => f !== 'status').map((f) => t.check_changed[f] || f),
    c.status ? t.check_status_now(t.check_status[c.status] || c.status) : '',
  ].filter(Boolean).join(', ');

  const section = (key, title, items, row) => {
    if (!items.length) return null;
    const shown = expanded[key] ? items : items.slice(0, LIMIT);
    return (
      <>
        <h3 className="stats-section">{title} <span className="audit-count">{items.length}</span></h3>
        <div className="audit-list">{shown.map(row)}</div>
        {items.length > shown.length && (
          <button type="button" className="audit-more check-more" onClick={() => setExpanded((prev) => ({ ...prev, [key]: true }))}>
            {t.audit_more(items.length - shown.length)}
          </button>
        )}
      </>
    );
  };

  const gameRow = (id, title, note) => (
    <button key={id} type="button" className="audit-item" onClick={() => onOpenGame(id)}>
      <span className="audit-item-name">{titleOf(id, title)}</span>
      <span className="audit-item-size">{note}</span>
    </button>
  );

  return (
    <section className="check" aria-label={t.check_title}>
      <div className="check-head">
        <span className="check-title">{t.check_title}</span>
        <div className="check-buttons">
          <button type="button" className="audit-retry check-start" disabled={running || starting} onClick={start}>
            {running ? t.check_busy : t.check_start}
          </button>
          {running && onCancel && (
            <button type="button" className="audit-retry check-cancel" disabled={check.cancelling || stopping} onClick={cancel}>
              {check.cancelling ? t.check_cancelling : t.check_cancel}
            </button>
          )}
        </div>
      </div>
      {!running && <div className="audit-hint check-hint">{t.check_hint(checkEstimate(check, games.length))}</div>}
      {when}

      {steps.length > 0 && (
        <ol className="check-steps">
          {steps.map((step) => {
            const status = statusOf(step);
            return (
              <li key={step.key} className={`check-step ${status}`}>
                <span className={`check-mark ${status}`} aria-hidden="true">{MARK[status] || ''}</span>
                <div className="check-step-body">
                  <div className="check-step-head">
                    <span className="check-step-name">{t.check_steps[step.key]}</span>
                    <span className="check-step-state">{stateText(step, status)}</span>
                  </div>
                  {status === 'running' && bar(step)}
                  {notes(step, status)}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {finished && (
        <div className="check-found">
          {nothingNew && <div className="check-nothing">{t.check_nothing}</div>}
          {section('changed', t.check_new_changed, changed, (c) => gameRow(c.id, c.title, changeText(c)))}
        </div>
      )}
    </section>
  );
};

export default LibraryCheck;
