import { useRef, useState } from 'react';
import { useLayer } from '../layers';
import { refreshJobs } from '../jdJobs';

// Закладка «В Mimikin» открывает библиотеку с #jd=<страница файла>. Здесь человек видит, что именно уйдёт в JDownloader
// (хостинг, ссылка), вписывает название и версию и жмёт «Загрузить».
// Подходит ли хостинг, решает сервер (api: services/downloads.js, список файлообменников): с чужого сайта ответит отказом
const JdLinkPanel = ({ t, url, onClose, showToast }) => {
  const L = t.jd_panel;
  const ref = useRef(null);
  const [title, setTitle] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useLayer(ref, onClose, { focus: '.jd-panel-send' });
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/downloads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: title.trim(), version: version.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.reason === 'off' ? t.jd_off : d.reason === 'site' ? t.jd_bad_link : t.jd_error(d.error || res.status));
        return;
      }
      refreshJobs();
      showToast(L.started);
      onClose();
    } catch {
      setError(t.err_net);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay active pop confirm-overlay" onClick={onClose}>
      <div ref={ref} className="confirm-box jd-panel" role="dialog" aria-modal="true" aria-labelledby="jd-panel-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h2 id="jd-panel-title" className="confirm-title">{L.title}</h2>
        <dl className="jd-panel-facts">
          <dt>{L.host}</dt><dd>{host}</dd>
          <dt>{L.link}</dt><dd className="jd-panel-url">{url}</dd>
        </dl>
        <label className="auth-field">
          <span className="auth-label">{L.name}</span>
          <input type="text" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label className="auth-field">
          <span className="auth-label">{L.version}</span>
          <input type="text" value={version} maxLength={40} onChange={(e) => setVersion(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onClose}>{t.cancel}</button>
          <button type="button" className="confirm-ok jd-panel-send" disabled={busy} onClick={send}>{L.send}</button>
        </div>
      </div>
    </div>
  );
};

export default JdLinkPanel;
