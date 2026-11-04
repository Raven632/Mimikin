import { useEffect, useState } from 'react';
import { errorText, httpError } from '../apiError';
import { confirmDialog } from '../confirm';
import PersonMark from './PersonMark';
import PersonGames from './PersonGames';
import ProfileEditor from './ProfileEditor';

// Те же пределы, что проверяет сервер (api/src/routes/users.js, utils/account.js)
const MIN_PASS = 4;

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
}

// «Пользователи» в Настройках (только у главного администратора): плитки людей, у плитки — своя страница. Первой стоит
// сам главный администратор (его плитка ведёт в «Мой профиль»), последней — «Добавить». Закрытый вход — плитка притушена;
// удалённые люди — отдельной частью под плитками, с «Вернуть». Ничего не стирается: пароль, сейвы и строки остаются
// goProfile — открыть вкладку «Мой профиль»; onMe — перечитать /me (имя и картинка в шапке); onChanged — список людей изменился:
// странице пора узнать, что в библиотеке теперь есть другие
const AccountsPanel = ({ t, showToast, onChanged, onMe, goProfile, socket }) => {
  const P = t.set_people;
  const [list, setList] = useState(null);
  // null — плитки; 'add' — форма нового человека; иначе id человека, чья страница открыта
  const [view, setView] = useState(null);

  const load = () => fetch('/api/users').then((r) => (r.ok ? r.json() : []), () => []).then((d) => setList(Array.isArray(d) ? d : []));
  useEffect(() => { load(); }, []);
  // Людей изменили с другого устройства (или этого же, но другая вкладка): список обновляется без перезагрузки
  useEffect(() => {
    socket?.on('people-changed', load);
    return () => { socket?.off('people-changed', load); };
  }, [socket]);

  const changed = async () => { await load(); await onMe?.(); onChanged?.(); };

  const active = (list || []).filter((p) => p.state !== 'removed');
  const removed = (list || []).filter((p) => p.state === 'removed');
  // Страница человека, которого уже нет среди активных (его удалили с другого устройства), не рисуется — видны плитки
  const person = view && view !== 'add' ? active.find((p) => p.id === view) : null;

  if (view === 'add') {
    return <AddPerson t={t} showToast={showToast} onBack={() => setView(null)} onAdded={async () => { setView(null); await changed(); }} />;
  }
  if (person) {
    return <PersonPage t={t} person={person} showToast={showToast} onBack={() => setView(null)} onChanged={changed} />;
  }

  const stateOf = (p) => (p.state === 'locked' ? P.locked : p.noPassword ? P.state_restored : p.mustChange ? P.state_temp : '');
  const restore = async (p) => {
    try {
      await call('POST', `/api/users/${encodeURIComponent(p.id)}/state`, { state: '' });
      showToast(P.restored(p.name), 'success');
      await changed();
    } catch (err) {
      showToast(errorText(t, err, { offline: t.srv_lost }), 'error');
    }
  };

  return (
    <section className="set-section" data-section="people">
      <h3 className="set-title">{P.title}</h3>
      <p className="set-hint">{P.hint}</p>
      {list && (
        <ul className="people-tiles">
          {active.map((p) => (
            <li key={p.id}>
              <button type="button" className={`people-tile${p.state === 'locked' ? ' off' : ''}`} data-person={p.id}
                onClick={() => (p.isOwner ? goProfile() : setView(p.id))}>
                <PersonMark person={p} />
                <span className="people-name">{p.name}</span>
                <span className={`people-role${p.isOwner ? ' adm' : ''}`}>{p.isOwner ? t.role_owner : t.role_user}</span>
                <span className={`people-state${p.state === 'locked' ? ' bad' : ''}`}>{stateOf(p)}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="people-tile people-add" onClick={() => setView('add')}>
              <span className="people-add-box">{P.add_tile}</span>
            </button>
          </li>
        </ul>
      )}
      {removed.length > 0 && (
        <div className="people-removed" data-section="removed">
          <h4 className="set-subtitle">{P.removed_title}</h4>
          <p className="set-hint">{P.removed_hint}</p>
          <ul className="set-watch-list">
            {removed.map((p) => (
              <li key={p.id}>
                <span className="people-removed-who"><PersonMark person={p} size={32} />{p.name}</span>
                <button type="button" className="meta-status-btn subtle" onClick={() => restore(p)}>{P.restore}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

// Новый человек: имя и временный пароль. Свой пароль он выберет при первом входе
const AddPerson = ({ t, showToast, onBack, onAdded }) => {
  const P = t.set_people;
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 40) { setError(P.name_short); return; }
    if (pass.length < MIN_PASS) { setError(t.auth_pass_hint(MIN_PASS)); return; }
    setError('');
    setBusy(true);
    try {
      await call('POST', '/api/users', { name: trimmed, password: pass });
      showToast(P.added(trimmed), 'success');
      await onAdded();
    } catch (err) {
      setError(errorText(t, err, { byStatus: { 400: P.name_short, 409: P.taken }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="set-section" data-section="people-add">
      <button type="button" className="people-back" onClick={onBack}>{P.back}</button>
      <form className="set-form" onSubmit={add} noValidate>
        <h3 className="set-title">{P.add_title}</h3>
        <label className="auth-field">
          <span className="auth-label">{P.add_name}</span>
          <input type="text" name="person-name" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={40}
            value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} />
        </label>
        <label className="auth-field">
          <span className="auth-label">{P.add_pass}</span>
          <input type="password" name="person-pass" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} aria-invalid={!!error} />
          <span className="auth-hint">{P.add_hint}</span>
        </label>
        <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
        <button type="submit" className="save-btn set-submit" disabled={busy}>{P.add_save}</button>
      </form>
    </section>
  );
};

// Страница человека. Вкладки: «Профиль» (имя, аватар), «Игры» (какие игры он видит), «Права» (запросы, загрузки) и «Вход» (пароль, закрыть вход, удалить)
const PersonPage = ({ t, person, showToast, onBack, onChanged }) => {
  const P = t.set_people;
  const [tab, setTab] = useState('profile');
  const tabs = [['profile', P.tab_profile], ['games', P.tab_games], ['rights', P.tab_rights], ['login', P.tab_login]];
  return (
    <section className="set-section person-page" data-section="person" data-person={person.id}>
      <button type="button" className="people-back" onClick={onBack}>{P.back}</button>
      <div className="person-head">
        <PersonMark person={person} size={64} />
        <div>
          <h3 className="set-title person-title">{person.name}</h3>
          <span className="people-role">{t.role_user}</span>
          {person.state === 'locked' && <span className="people-state bad">{P.locked}</span>}
        </div>
      </div>
      <div className="person-tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`person-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'profile' && <ProfileEditor t={t} person={person} self={false} showToast={showToast} onChanged={onChanged} />}
      {tab === 'games' && <PersonGames t={t} person={person} showToast={showToast} />}
      {tab === 'rights' && <RightsTab t={t} person={person} showToast={showToast} onChanged={onChanged} />}
      {tab === 'login' && <LoginTab t={t} person={person} showToast={showToast} onChanged={onChanged} onGone={onBack} />}
    </section>
  );
};

// Четыре права, каждое сразу уходит на сервер: страница человека меняется сама, без перезагрузки (сокет rights-changed).
// Сервер ждёт все четыре разом, поэтому незатронутые берём из того, что он прислал
const RIGHTS = ['request', 'download', 'upload', 'view'];
// Право «request» (запросы игр) в витрине не показываем: запросам тут не от чего работать. Оно остаётся в теле запроса —
// сервер ждёт все четыре разом, и прежнее значение уходит как есть
const SHOWN_RIGHTS = RIGHTS.filter((k) => k !== 'request');
const RightsTab = ({ t, person, showToast, onChanged }) => {
  const P = t.set_people;
  const [busy, setBusy] = useState(false);
  const rights = person.rights || {};
  const toggle = async (key, on) => {
    setBusy(true);
    try {
      await call('PUT', `/api/users/${encodeURIComponent(person.id)}/rights`, { ...Object.fromEntries(RIGHTS.map((k) => [k, !!rights[k]])), [key]: on });
      await onChanged();
    } catch (err) {
      showToast(errorText(t, err, { offline: t.srv_lost }), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="set-section" data-section="rights">
      <p className="set-hint">{P.rights_hint}</p>
      {SHOWN_RIGHTS.map((key) => (
        <label key={key} className="set-toggle" data-right={key}>
          <span className="set-toggle-text">
            <span className="set-label">{P.right[key]}</span>
            <span className="set-hint">{P.right_hint[key]}</span>
          </span>
          <input type="checkbox" role="switch" checked={!!rights[key]} disabled={busy} onChange={(e) => toggle(key, e.target.checked)} />
        </label>
      ))}
    </section>
  );
};

const LoginTab = ({ t, person, showToast, onChanged, onGone }) => {
  const P = t.set_people;
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const url = `/api/users/${encodeURIComponent(person.id)}`;
  const locked = person.state === 'locked';

  const reset = async (e) => {
    e.preventDefault();
    if (pass.length < MIN_PASS) { setError(t.auth_pass_hint(MIN_PASS)); return; }
    setError('');
    setBusy(true);
    try {
      await call('POST', `${url}/password`, { password: pass });
      showToast(P.reset_done(person.name), 'success');
      setPass('');
      await onChanged();
    } catch (err) {
      setError(errorText(t, err, { offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };

  const setState = async (state, done) => {
    setBusy(true);
    try {
      await call('POST', `${url}/state`, { state });
      showToast(done, 'success');
      await onChanged();
      return true;
    } catch (err) {
      showToast(errorText(t, err, { offline: t.srv_lost }), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: P.remove_q(person.name), text: P.remove_text, confirmLabel: P.remove, danger: true }))) return;
    // Страница удалённого человека закрывается: вернуть его можно в списке «Удалённые», а не открытой страницей
    if (await setState('removed', P.remove_done(person.name))) onGone();
  };

  return (
    <>
      <form className="set-section set-form" onSubmit={reset} noValidate data-section="reset">
        <h3 className="set-title">{P.reset}</h3>
        <label className="auth-field">
          <span className="auth-label">{P.reset_label(person.name)}</span>
          <input type="password" name="reset-pass" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} aria-invalid={!!error} />
          <span className="auth-hint">{P.reset_hint}</span>
        </label>
        <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
        <button type="submit" className="save-btn set-submit" disabled={busy}>{P.reset_save}</button>
      </form>
      <section className="set-section" data-section="lock">
        <h3 className="set-title">{locked ? P.unlock : P.lock}</h3>
        <p className="set-hint">{locked ? P.unlock_text : P.lock_text}</p>
        <button type="button" className="meta-status-btn" disabled={busy}
          onClick={() => setState(locked ? '' : 'locked', locked ? P.unlocked_done(person.name) : P.locked_done(person.name))}>{locked ? P.unlock : P.lock}</button>
      </section>
      <section className="set-section" data-section="remove">
        <h3 className="set-title">{P.remove}</h3>
        <p className="set-hint">{P.remove_text}</p>
        <button type="button" className="meta-status-btn danger" disabled={busy} onClick={remove}>{P.remove}</button>
      </section>
    </>
  );
};

export default AccountsPanel;
