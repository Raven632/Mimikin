import { useEffect, useState } from 'react';
import { errorText } from '../apiError';
import BrandMark from './BrandMark';
import { IconEye, IconEyeOff } from './icons';
import KnownLangsPicker from './KnownLangsPicker';
import { saveKnownLangs } from '../knownLangs';

const LANGS = [['ru', 'RU'], ['en', 'EN'], ['de', 'DE']];
// Те же пределы, что проверяет сервер (api/src/routes/auth.js): подсказываем заранее, а не после отказа
const MIN_USER = 3;
const MIN_PASS = 4;

// Экран входа и первого запуска — страница целиком, а не окно поверх пустой библиотеки.
// Как у игровых библиотек (Steam, Jellyfin, RomM): знак проекта, карточка по центру на тёмном фоне.
// И как советуют для форм входа: подписи над полями (подсказку внутри поля не читают), autocomplete
// для менеджеров паролей, «показать пароль», Caps Lock, понятная ошибка рядом с полями; при первом
// запуске — требования заранее и повтор пароля, а после создания — сразу вход, без повторного ввода
const LoginModal = ({ mode, onSuccess, t, lang, onLangChange }) => {
  const [isSetup, setIsSetup] = useState(mode === 'setup');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Мимик на входе спит, пока не начали печатать: первая буква будит его (mimicMood.sleep)
  const [typed, setTyped] = useState(false);
  // Пока ничего не нажато — язык интерфейса (он же меняется кнопками внизу); нажали — берём выбор человека
  const [picked, setPicked] = useState(null);
  const knownLangs = picked || [lang];

  // Страница входа — не окно: прокрутка библиотеки под ней не нужна
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const onKey = (e) => setCaps(!!e.getModifierState?.('CapsLock'));

  const post = (url) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password }),
  });

  const fail = (res, data) => setError(errorText(t, { status: res.status, error: data.error }, {
    byStatus: { 400: t.login_short, 401: t.login_wrong, 403: t.setup_done, 429: t.login_too_many },
    offline: t.srv_lost,
  }));

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError(t.auth_fill); return; }
    if (isSetup) {
      if (username.trim().length < MIN_USER || password.length < MIN_PASS) { setError(t.login_short); return; }
      if (password !== password2) { setError(t.auth_mismatch); return; }
    }
    setError('');
    setBusy(true);
    const wasSetup = isSetup;
    try {
      if (isSetup) {
        const res = await post('/api/setup/init');
        const data = await res.json().catch(() => ({}));
        if (!data.success) { fail(res, data); return; }
        setIsSetup(false);
      }
      // Только что создали — сразу входим теми же данными
      const res = await post('/api/login');
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        // Нужен вход (кука): сохраняем сразу после него. Не вышло — не страшно, это можно сделать в «Настройках»
        if (wasSetup) await saveKnownLangs(knownLangs).catch(() => {});
        onSuccess();
      }
      else fail(res, data);
    } catch {
      setError(t.srv_lost);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit} onInput={() => setTyped(true)} noValidate aria-labelledby="auth-title">
        <div className="auth-brand" aria-hidden="true">
          <BrandMark size={64} live view="login" sleep={!typed} />
          <span className="auth-brand-name">Mimikin</span>
        </div>

        <h1 id="auth-title" className="auth-title">{isSetup ? t.auth_setup_title : t.auth_login_title}</h1>
        {isSetup && <p className="auth-lead">{t.auth_setup_text}</p>}

        <label className="auth-field">
          <span className="auth-label">{t.auth_user}</span>
          <input
            type="text" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
            autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
            aria-invalid={!!error}
          />
          {isSetup && <span className="auth-hint">{t.auth_user_hint(MIN_USER)}</span>}
        </label>

        <label className="auth-field">
          <span className="auth-label">{t.auth_pass}</span>
          <span className="auth-pass">
            <input
              type={showPass ? 'text' : 'password'} name="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onKey} onKeyUp={onKey} aria-invalid={!!error}
            />
            <button
              type="button" className="auth-eye" onClick={() => setShowPass((v) => !v)}
              aria-label={showPass ? t.auth_hide : t.auth_show} data-tip={showPass ? t.auth_hide : t.auth_show}
              aria-pressed={showPass}
            >
              {showPass
                ? <IconEyeOff />
                : <IconEye />}
            </button>
          </span>
          {isSetup && <span className="auth-hint">{t.auth_pass_hint(MIN_PASS)}</span>}
          {caps && <span className="auth-hint warn">{t.auth_caps}</span>}
        </label>

        {isSetup && (
          <label className="auth-field">
            <span className="auth-label">{t.auth_pass2}</span>
            <input
              type={showPass ? 'text' : 'password'} name="password2" autoComplete="new-password"
              value={password2} onChange={(e) => setPassword2(e.target.value)} aria-invalid={!!error}
            />
          </label>
        )}

        {isSetup && (
          <div className="auth-field">
            <span className="auth-label">{t.kl_title}</span>
            <KnownLangsPicker t={t} value={knownLangs} onChange={setPicked} disabled={busy} />
            <span className="auth-hint">{t.kl_hint}</span>
          </div>
        )}

        <div className="auth-error" role="alert" aria-live="assertive">{error}</div>

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy && <span className="auth-spinner" aria-hidden="true" />}
          {busy ? t.auth_busy : (isSetup ? t.auth_submit_setup : t.auth_submit_login)}
        </button>

        <p className="auth-note">{t.auth_note}</p>

        <div className="auth-langs" role="group" aria-label={t.menu_language}>
          {LANGS.map(([code, label]) => (
            <button key={code} type="button" className={`auth-lang${lang === code ? ' active' : ''}`}
              aria-pressed={lang === code} onClick={() => onLangChange?.(code)}>{label}</button>
          ))}
        </div>
      </form>
    </div>
  );
};

export default LoginModal;
