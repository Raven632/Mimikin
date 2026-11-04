import { useRef, useState } from 'react';
import { errorText, httpError } from '../apiError';
import { cropAvatar, putAvatar, dropAvatar } from '../avatar';
import PersonMark from './PersonMark';

async function send(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
}

// Аватар и имя одного человека: на странице «Мой профиль» (self — свои, имя меняют с паролем) и на странице человека у
// главного администратора (чужие, пароль не нужен). Адреса те же по смыслу, разные по правам (api/src/routes/account.js, users.js)
// onChanged — что-то изменилось: страница перечитывает людей и /me. Сами имя и картинка приходят в person от родителя
const ProfileEditor = ({ t, person, self, showToast, onChanged }) => {
  const P = t.set_profile;
  const base = self ? '/api/account' : `/api/users/${encodeURIComponent(person.id)}`;
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAvatarError('');
    setBusy(true);
    try {
      let blob;
      try { blob = await cropAvatar(file); } catch { setAvatarError(P.avatar_bad_file); return; }
      await putAvatar(`${base}/avatar`, blob);
      showToast(P.avatar_saved, 'success');
      await onChanged();
    } catch (err) {
      setAvatarError(errorText(t, err, { offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setAvatarError('');
    setBusy(true);
    try {
      await dropAvatar(`${base}/avatar`);
      showToast(P.avatar_removed, 'success');
      await onChanged();
    } catch (err) {
      setAvatarError(errorText(t, err, { offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="set-section profile-avatar" data-section="avatar">
        <h3 className="set-title">{P.avatar_title}</h3>
        <div className="profile-avatar-row">
          <PersonMark person={person} size={96} />
          <div className="profile-avatar-side">
            <div className="profile-avatar-actions">
              <button type="button" className="meta-status-btn" disabled={busy} onClick={() => fileRef.current?.click()}>{P.avatar_pick}</button>
              {person.avatar && <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={clear}>{P.avatar_remove}</button>}
            </div>
            <p className="set-hint">{P.avatar_hint}</p>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
        <div className="auth-error" role="alert" aria-live="assertive">{avatarError}</div>
      </section>
      <NameForm key={`${person.id}:${person.name}`} t={t} person={person} self={self} base={base} showToast={showToast} onChanged={onChanged} />
    </>
  );
};

// Имя — это и логин. Себе его меняют с паролем: открытая на чужом устройстве вкладка не должна запереть человека.
// Чужое меняет главный администратор без пароля; тост напоминает передать новое имя
const NameForm = ({ t, person, self, base, showToast, onChanged }) => {
  const P = t.set_profile;
  const [name, setName] = useState(person.name);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  const submit = async (e) => {
    e.preventDefault();
    if (!trimmed || trimmed.length > 40) { setError(P.name_short); return; }
    if (self && !password) { setError(P.name_need_pass); return; }
    setError('');
    setBusy(true);
    try {
      const data = self ? await send('POST', `${base}/name`, { name: trimmed, password }) : await send('PATCH', base, { name: trimmed });
      showToast(self ? P.name_saved(data.name) : P.name_saved_other(data.name), 'success');
      await onChanged();
    } catch (err) {
      setError(errorText(t, err, { byStatus: { 400: P.name_short, 401: t.set_pass_wrong, 429: t.login_too_many }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="set-section set-form" onSubmit={submit} noValidate data-section="name">
      <h3 className="set-title">{P.name_title}</h3>
      <label className="auth-field">
        <span className="auth-label">{P.name_label}</span>
        <input type="text" name="profile-name" autoComplete="off" autoCapitalize="none" spellCheck={false}
          value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} />
      </label>
      {self && (
        <label className="auth-field">
          <span className="auth-label">{P.name_pass}</span>
          <input type="password" name="profile-pass" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
        </label>
      )}
      <p className="set-hint">{self ? P.name_hint : P.name_hint_other}</p>
      <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
      <button type="submit" className="save-btn set-submit" disabled={busy || trimmed === person.name}>{P.name_save}</button>
    </form>
  );
};

export default ProfileEditor;
