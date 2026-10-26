import { useEffect, useState } from 'react';
import { confirmDialog } from '../confirm';
import { errorText, httpError } from '../apiError';
import StateView from './StateView';
import { IconHourglass } from './icons';

const KINDS = ['updates', 'wishlist', 'watch', 'uploads', 'backup', 'problems'];

async function call(method, url, body) {
  const res = await fetch(`/api/telegram${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
}

// Вкладка «Уведомления» в настройках: подключить бота, выбрать, что присылать, проверить связь,
// отправить копию. Сам бот — свой, создаётся в @BotFather; его токен — в .env сервера (services/telegram.js)
const TelegramPanel = ({ t, lang, socket, showToast, onBackupAt }) => {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reload, setReload] = useState(0);

  // Время последней копии — строка состояния под вкладкой «Копии» в настройках
  useEffect(() => { if (state) onBackupAt?.(state.backupAt || 0); }, [state, onBackupAt]);

  useEffect(() => {
    let alive = true;
    const load = () => call('GET', '').then(
      (s) => { if (alive) { setState(s); setError(''); } },
      (e) => { if (alive) setError(errorText(t, e)); },
    );
    load();
    // Чат привязался (человек нажал «Start» в Telegram) — перечитать
    socket?.on('telegram-changed', load);
    return () => {
      alive = false;
      socket?.off('telegram-changed', load);
    };
  }, [socket, t, reload]);

  const act = async (name, work, done) => {
    setBusy(name);
    try {
      const result = await work();
      if (result && typeof result === 'object' && 'configured' in result) setState(result);
      if (done) showToast(done, 'success');
    } catch (e) {
      showToast(errorText(t, e), 'error');
    } finally {
      setBusy('');
    }
  };

  const connect = () => act('link', async () => {
    const s = await call('POST', '/link', { lang, library: `${window.location.origin}/` });
    if (s.pending?.url) window.open(s.pending.url, '_blank', 'noopener');
    return s;
  });
  const toggle = (kind) => act(kind, () => call('POST', '/prefs', { [kind]: !state.prefs[kind] }));
  const unlink = async () => {
    if (await confirmDialog({ title: t.tg_unlink_title, text: t.tg_unlink_text, confirmLabel: t.tg_unlink, danger: true })) act('unlink', () => call('DELETE', '/link'));
  };
  const sendBackup = () => act('backup', async () => {
    await call('POST', '/backup');
    return call('GET', '');
  }, t.tg_backup_sent);

  return (
    <div className="telegram-content">
      <p className="tg-note">{t.tg_intro}</p>

      {error && <StateView kind="error" title={error} onRetry={() => { setError(''); setReload((n) => n + 1); }} retryLabel={t.retry} />}
      {!state && !error && <StateView kind="loading" />}

      {state && !state.configured && (
        <ol className="tg-steps">
          <li>{t.tg_setup_1}</li>
          <li>{t.tg_setup_2}</li>
        </ol>
      )}

      {state?.configured && state.error && <p className="tg-note tg-error">{state.error}</p>}

      {state?.configured && !state.linked && (
        <div className="tg-block">
          {state.pending ? (
            <>
              <a className="save-btn tg-link" href={state.pending.url} target="_blank" rel="noopener noreferrer">{t.tg_open_link}</a>
              <p className="tg-note">{t.tg_waiting(state.pending.code)}</p>
            </>
          ) : (
            <button type="button" className="save-btn" disabled={!!busy || !state.bot} onClick={connect}>{t.tg_connect}{state.bot ? ` @${state.bot}` : ''}</button>
          )}
        </div>
      )}

      {state?.linked && (
        <>
          <p className="tg-linked">{state.linked.fromEnv ? t.tg_from_env : t.tg_linked(state.linked.name)}</p>
          <h3 className="set-title">{t.tg_what}</h3>
          <div className="tg-kinds">
            {KINDS.map((kind) => (
              <label key={kind} className="set-toggle">
                <span className="set-toggle-text"><span className="set-label">{t.tg_kind[kind]}</span></span>
                <input type="checkbox" role="switch" checked={!!state.prefs[kind]} disabled={!!busy} onChange={() => toggle(kind)} />
              </label>
            ))}
          </div>
          <p className="tg-note">{t.tg_quiet}</p>
          {state.backupAt > 0 && (
            <p className="tg-note">{t.tg_backup_last(new Date(state.backupAt).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</p>
          )}
          <div className="tg-actions">
            <button type="button" className="meta-status-btn" disabled={!!busy} onClick={() => act('test', () => call('POST', '/test'), t.tg_tested)}>{t.tg_test}</button>
            <button type="button" className="meta-status-btn" disabled={!!busy} onClick={sendBackup}>{busy === 'backup' ? <IconHourglass /> : t.tg_backup_now}</button>
            {!state.linked.fromEnv && (
              <button type="button" className="meta-status-btn subtle" disabled={!!busy} onClick={unlink}>{t.tg_unlink}</button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default TelegramPanel;
