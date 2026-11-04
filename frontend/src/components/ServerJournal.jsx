import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { copyText } from '../copyText';
import { IconExternal } from './icons';

const ISSUE_URL = 'https://github.com/Raven632/Mimikin/issues/new?template=bug_report.md';

// Окно отчёта: человек видит ровно то, что уйдёт в буфер. Поле — обычный текст: на HTTP буфер браузер может и не дать,
// а отсюда скопировать можно руками. Поверх окна настроек — через портал: внутри него окно обрезала бы его анимация
const ReportWindow = ({ t, text, onClose, showToast }) => {
  const J = t.set_journal;
  const ref = useRef(null);
  const box = useRef(null);
  const [refused, setRefused] = useState(false);
  useLayer(ref, onClose, { focus: '.confirm-ok' });
  const copy = async () => {
    if (await copyText(text)) {
      setRefused(false);
      showToast(J.copied, 'info');
      return;
    }
    setRefused(true);
    box.current?.focus();
    box.current?.select();
  };
  return createPortal(
    <div className="modal-overlay active pop confirm-overlay" onClick={onClose}>
      <div ref={ref} className="confirm-box report-box" role="dialog" aria-modal="true" aria-labelledby="report-title" aria-describedby="report-text" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h2 id="report-title" className="confirm-title">{J.win}</h2>
        <p id="report-text" className="confirm-text">{J.win_text}</p>
        <textarea ref={box} className="report-text" readOnly spellCheck={false} value={text} aria-label={J.win} onFocus={(e) => e.target.select()} />
        {refused && <p className="set-hint set-error" role="alert">{J.copy_failed}</p>}
        <a className="set-ext" href={ISSUE_URL} target="_blank" rel="noopener noreferrer">{J.issue} <IconExternal /></a>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onClose}>{t.close}</button>
          <button type="button" className="confirm-ok" onClick={copy}>{J.copy}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

// «О программе»: журнал сервера и отчёт о проблеме. Всё приходит с сервера уже очищенным (services/problemReport.js)
const ServerJournal = ({ t, lang, showToast }) => {
  const J = t.set_journal;
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [report, setReport] = useState(null);
  const list = useRef(null);

  const request = async () => {
    const res = await fetch('/api/settings/problem-report');
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  };
  const show = (next) => {
    setData(next);
    setFailed(false);
    return next;
  };
  const refresh = () => request().then(show).catch(() => setFailed(true));
  useEffect(() => {
    let alive = true;
    request().then((next) => { if (alive) show(next); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);
  // Свежие строки внизу: журнал открывается на них
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [data]);

  // Заново, а не из уже загруженного: отчёт должен быть про то, что есть сейчас
  const openReport = () => request().then(show).then((next) => setReport(next.report)).catch(() => { setFailed(true); showToast(J.failed, 'error'); });

  const time = (at) => new Date(at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <section className="set-section">
      <h3 className="set-title">{J.title}</h3>
      <p className="set-hint">{J.hint}</p>
      {failed && <p className="set-hint set-error">{J.failed}</p>}
      {data && (data.lines.length
        ? (
          <div ref={list} className="set-journal" role="log" tabIndex={0} aria-label={J.title}>
            {data.lines.map((line, i) => (
              <div key={`${line.at}-${i}`} className={`set-journal-line ${line.level}`}><time>{time(line.at)}</time>{line.text}</div>
            ))}
          </div>
        )
        : <p className="set-status">{J.empty}</p>)}
      <div className="set-row">
        <button type="button" className="meta-status-btn" onClick={openReport}>{J.open}</button>
        <button type="button" className="meta-status-btn subtle" onClick={refresh}>{J.refresh}</button>
      </div>
      {report !== null && <ReportWindow t={t} text={report} onClose={() => setReport(null)} showToast={showToast} />}
    </section>
  );
};

export default ServerJournal;
