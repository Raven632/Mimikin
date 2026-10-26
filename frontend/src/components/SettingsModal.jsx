import { useEffect, useRef, useState } from 'react';
import { useLayer } from '../layers';
import { useClosing } from '../useClosing';
import { confirmDialog } from '../confirm';
import { errorText, httpError } from '../apiError';
import TelegramPanel from './TelegramPanel';
import { getCoverUrl } from '../coverUrl';
import { timeAgo } from '../formatAgo';
import StateView from './StateView';
import BrandMark from './BrandMark';
import { IconChevronRight, IconClose, IconExternal, IconGrid, IconHeart, IconRefresh } from './icons';
import Picker from './Picker';
import { hideOnLeave, setHideOnLeave } from '../coversHidden';
import { saveFavoriteTags, useFavoriteTags } from '../favoriteTags';
import { loadKnownLangs, saveKnownLangs, useKnownLangs } from '../knownLangs';
import KnownLangsPicker from './KnownLangsPicker';
import HelpTitle from './Help';

const LANGS = [['ru', 'Русский'], ['en', 'English'], ['de', 'Deutsch']];
const MIN_PASS = 4; // как проверяет сервер (api/src/routes/auth.js)
const REPO = 'https://github.com/Raven632/rpg-library';

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
}

// Строка «переключатель + подпись + пояснение» — как в настройках телефона
const Toggle = ({ checked, onChange, label, hint }) => (
  <label className="set-toggle">
    <span className="set-toggle-text">
      <span className="set-label">{label}</span>
      {hint && <span className="set-hint">{hint}</span>}
    </span>
    <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  </label>
);

// Заголовок раскрывающегося блока со своей стрелкой: стандартный треугольник браузера в чёрно-золотом окне выбивался
const Summary = ({ children }) => <summary><span className="set-sum-chev" aria-hidden="true"><IconChevronRight /></span>{children}</summary>;

// Любимые теги: выбор из тегов игр библиотеки (tags приходят из App.jsx). Отметка «♥» у игр с этими
// тегами в окне игры, и они идут первыми в списке тегов
const FavoriteTags = ({ t, showToast, tags: all }) => {
  const favorites = useFavoriteTags();
  const [busy, setBusy] = useState(false);
  const save = async (next) => {
    setBusy(true);
    try { await saveFavoriteTags(next); } catch (err) { showToast?.(errorText(t, err), 'error'); } finally { setBusy(false); }
  };
  const options = [
    { value: 'all', label: t.fav_add },
    ...[...new Set(all)].filter((x) => !favorites.includes(x)).sort().map((x) => ({ value: x, label: x })),
  ];
  return (
    <section className="set-section" data-section="favorites">
      <HelpTitle t={t} title={t.fav_title} hint={t.fav_hint} />
      {favorites.length > 0 && (
        <div className="filter-chips fav-chips">
          {favorites.map((tag) => (
            <button key={tag} type="button" className="chip active" disabled={busy} data-tip={t.cat_tag_remove(tag)}
              onClick={() => save(favorites.filter((x) => x !== tag))}><IconHeart /> {tag} <IconClose /></button>
          ))}
        </div>
      )}
      {favorites.length < 20 && (
        <Picker options={options} value="all" onChange={(tag) => { if (tag !== 'all') save([...favorites, tag]); }} label={t.fav_add} className="fav-add"
          searchable searchPlaceholder={t.cat_tag_search} emptyText={t.cat_tag_none} />
      )}
    </section>
  );
};

// Языки, которые я знаю: игры на них окно игры не предлагает переводить
const KnownLangs = ({ t, showToast }) => {
  const langs = useKnownLangs();
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadKnownLangs(); }, []);
  const save = async (next) => {
    setBusy(true);
    try { await saveKnownLangs(next); } catch (err) { showToast?.(errorText(t, err), 'error'); } finally { setBusy(false); }
  };
  return (
    <section className="set-section" data-section="known-langs">
      <HelpTitle t={t} title={t.kl_title} hint={t.kl_hint} />
      <KnownLangsPicker t={t} value={langs} onChange={save} disabled={busy} />
    </section>
  );
};

// Только этого устройства (localStorage), поэтому без запроса к серверу, как и «Скрывать обложки»
const HideOnLeave = ({ t }) => {
  const [on, setOn] = useState(hideOnLeave);
  return <Toggle checked={on} onChange={(v) => { setHideOnLeave(v); setOn(v); }} label={t.set_hide_leave} hint={t.set_hide_leave_hint} />;
};

const GeneralTab = ({ t, lang, onLangChange, blurCovers, setBlurCovers, onShowKeys, showToast, tags }) => (
  <>
    <section className="set-section">
      <h3 className="set-title">{t.set_lang}</h3>
      <div className="set-choice" role="radiogroup" aria-label={t.set_lang}>
        {LANGS.map(([code, label]) => (
          <button key={code} type="button" role="radio" aria-checked={lang === code}
            className={`set-choice-btn${lang === code ? ' active' : ''}`} onClick={() => onLangChange(code)}>{label}</button>
        ))}
      </div>
    </section>
    <section className="set-section">
      <h3 className="set-title">{t.set_groups.covers}</h3>
      <Toggle checked={blurCovers} onChange={setBlurCovers} label={t.set_covers} hint={t.set_covers_hint} />
      <HideOnLeave t={t} />
    </section>
    <KnownLangs t={t} showToast={showToast} />
    <FavoriteTags t={t} showToast={showToast} tags={tags} />
    {onShowKeys && (
      <section className="set-section keys-only-desktop">
        <HelpTitle t={t} title={t.keys_title} hint={t.keys_hint} />
        <button type="button" className="meta-status-btn" onClick={onShowKeys}>{t.keys_show}</button>
      </section>
    )}
  </>
);

// Смена пароля: прежний — чтобы с чужого открытого устройства пароль не сменили. После смены
// другие устройства выходят, это — остаётся со входом (сервер ставит новую куку)
const AccountTab = ({ t, onLogout, showToast }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!current || !next) { setError(t.auth_fill); return; }
    if (next.length < MIN_PASS) { setError(t.auth_pass_hint(MIN_PASS)); return; }
    if (next !== next2) { setError(t.auth_mismatch); return; }
    setError('');
    setBusy(true);
    try {
      const data = await post('/api/account/password', { current, next });
      setCurrent(''); setNext(''); setNext2('');
      showToast(data.otherDevicesSignedOut ? t.set_pass_done_others : t.set_pass_done, 'success');
    } catch (err) {
      setError(errorText(t, err, { byStatus: { 401: t.set_pass_wrong, 429: t.login_too_many }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="set-section set-form" onSubmit={submit} noValidate>
        <h3 className="set-title">{t.set_pass_title}</h3>
        {/* Скрытое имя — менеджеру паролей, чтобы он обновил нужную запись */}
        <input type="text" name="username" autoComplete="username" hidden readOnly />
        <label className="auth-field">
          <span className="auth-label">{t.set_pass_current}</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} aria-invalid={!!error} />
        </label>
        <label className="auth-field">
          <span className="auth-label">{t.set_pass_new}</span>
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={!!error} />
          <span className="auth-hint">{t.auth_pass_hint(MIN_PASS)}</span>
        </label>
        <label className="auth-field">
          <span className="auth-label">{t.auth_pass2}</span>
          <input type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} aria-invalid={!!error} />
        </label>
        <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
        <button type="submit" className="save-btn set-submit" disabled={busy}>{busy ? t.auth_busy : t.set_pass_save}</button>
        <p className="set-hint">{t.set_pass_note}</p>
      </form>
      <section className="set-section">
        <h3 className="set-title">{t.logout}</h3>
        <p className="set-hint">{t.logout_text}</p>
        <button type="button" className="meta-status-btn" onClick={onLogout}>{t.logout}</button>
      </section>
    </>
  );
};

const formatSize = (bytes) => {
  const mb = (bytes || 0) / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(mb, 0.1).toFixed(1)} MB`;
};

// Восстановить из копии: выбрать архив — спросить — отправить. Что вернулось и каких игр не хватает
// показываем здесь же, а не тостом: список может быть длинным
const RestoreSection = ({ t, onLibraryChanged }) => {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!(await confirmDialog({ title: t.restore_q, name: file.name, text: t.restore_text, confirmLabel: t.restore_go }))) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const form = new FormData();
      form.append('backup', file);
      const res = await fetch('/api/backup/restore', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      setResult(data);
      onLibraryChanged?.();
    } catch (err) {
      setError(errorText(t, err, { fallback: t.restore_err, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="set-section">
      <HelpTitle t={t} title={t.restore_title} hint={t.restore_hint} />
      <input ref={fileRef} className="set-file" type="file" accept=".zip,.7z" onChange={pick} />
      <button type="button" className="meta-status-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? t.restore_busy : t.restore_pick}
      </button>
      <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
      {result && (
        <div className="set-result" role="status">
          {t.restore_done(result.games, result.saves)}
          {result.missing.length > 0 && (
            <details>
              <Summary>{t.restore_missing(result.missing.length)}</Summary>
              {result.missing.join(', ')}
            </details>
          )}
        </div>
      )}
    </section>
  );
};

const BackupTab = ({ t, onLibraryChanged, info, setInfo, showToast }) => (
  <>
    <section className="set-section">
      <HelpTitle t={t} title={t.backup_download} hint={t.set_backup_text} />
      <ul className="set-list">
        <li>{t.set_backup_in}</li>
        <li>{t.set_backup_out}</li>
      </ul>
      <a className="save-btn set-submit set-link-btn" href="/api/backup" download>{t.backup_download}</a>
    </section>
    <RestoreSection t={t} onLibraryChanged={onLibraryChanged} />
    {/* Пароль копий: им запирается копия, которую библиотека шлёт в Telegram, им же открывается при восстановлении */}
    <SecretField t={t} name="backup" info={info} setInfo={setInfo} showToast={showToast} secretInput
      title={t.set_secret.backup.title} text={t.set_secret.backup.text} check={(v) => v.length >= 8} />
  </>
);

// Корзина: удалённые игры 30 дней. Вернуть — со всеми данными; стереть — сразу и навсегда
const TrashTab = ({ t, lang, onRestore, onCount }) => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch('/api/games/trash')
      .then(async (res) => { const data = await res.json().catch(() => ({})); if (!res.ok) throw httpError(res, data); return data; })
      .then((d) => { if (alive) setItems(d.items); }, (e) => { if (alive) setError(errorText(t, e)); });
    return () => { alive = false; };
  }, [t, reload]);

  const restore = async (item) => {
    setBusy(item.key);
    if (await onRestore(item.key)) setItems((list) => list.filter((i) => i.key !== item.key));
    setBusy('');
  };
  const erase = async (item) => {
    const text = item.vanished ? t.trash_erase_vanished_text : t.trash_erase_text;
    if (!(await confirmDialog({ title: t.trash_erase_q, name: item.title, cover: item.cover ? getCoverUrl(item, 360) : null, text, confirmLabel: t.trash_erase, danger: true }))) return;
    setBusy(item.key);
    try {
      const res = await fetch(`/api/games/trash/${encodeURIComponent(item.key)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      setItems((list) => list.filter((i) => i.key !== item.key));
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy('');
    }
  };

  // Сколько игр в корзине — строка состояния под вкладкой; своего запроса у окна на это нет
  useEffect(() => { onCount?.(items ? items.length : null); }, [items, onCount]);

  const total = (items || []).reduce((sum, i) => sum + (i.size || 0), 0);
  return (
    <section className="set-section">
      <HelpTitle t={t} title={t.trash_title} hint={t.trash_hint} />
      {error && <StateView kind="error" title={error} onRetry={() => { setError(''); setItems(null); setReload((n) => n + 1); }} retryLabel={t.retry} />}
      {!items && !error && <StateView kind="loading" />}
      {items?.length === 0 && <StateView title={t.trash_empty} hint={t.trash_empty_hint} />}
      {items?.length > 0 && (
        <>
          <p className="set-hint">{t.trash_total(items.length, formatSize(total))}</p>
          {/* Ведомость, как таблица библиотеки в Steam: подписи колонок сверху, размер справа, срок полоской.
              На телефоне колонок две (игра и размер), срок и кнопки уходят под название */}
          <div className="trash-head" aria-hidden="true">
            <span>{t.trash_col_game}</span><span className="trash-col-size">{t.trash_col_size}</span><span className="trash-col-days">{t.trash_col_days}</span>
          </div>
          <ul className="trash-list">
            {items.map((item) => (
              <li key={item.key} className="trash-item">
                {item.cover ? <img className="trash-cover" src={getCoverUrl(item, 360)} alt="" loading="lazy" /> : <span className="trash-cover" aria-hidden="true" />}
                <div className="trash-info">
                  <span className="trash-name" data-tip={item.title}>{item.title}</span>
                  {/* Папку убрали мимо приложения — в корзине только запись: вернётся сама вместе с папкой */}
                  <span className="trash-meta">
                    {item.vanished ? t.trash_meta_vanished(timeAgo(item.deletedAt, lang)) : t.trash_meta(timeAgo(item.deletedAt, lang))}
                  </span>
                  {item.vanished && !item.taken && <span className="trash-meta">{t.trash_vanished_hint}</span>}
                </div>
                <span className="trash-size">{item.vanished ? '' : formatSize(item.size)}</span>
                <span className="trash-days">
                  {t.trash_days(item.daysLeft)}
                  <span className="trash-gauge" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, (item.daysLeft / 30) * 100))}%` }} /></span>
                </span>
                <div className="trash-actions">
                  {(!item.vanished || item.taken) && (
                    <button type="button" className="meta-status-btn" disabled={!!busy || (!item.vanished && item.taken)} data-tip={!item.vanished && item.taken ? t.trash_taken : undefined} onClick={() => restore(item)}>{t.trash_restore}</button>
                  )}
                  <button type="button" className="meta-status-btn subtle" disabled={!!busy} onClick={() => erase(item)}>{t.trash_erase}</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

// Ключ или пароль, который раньше задавался только в .env на сервере (api/src/utils/secrets.js): из .env —
// он главный, тут только видно, что он есть. Иначе — вписать здесь. Сам ключ сервер не отдаёт — только
// хвост. name — scraper, telegram, backup; check — быстрая проверка вида до отправки;
// onSaved — после сохранения (Telegram перечитывает своё состояние)
// parts — значение из нескольких полей (name=значение): поле на каждое, как они называются у службы. Вставили в
// любое поле всю строку — она сама разложится по полям
// bare — внутри строки службы (ServiceRow): название уже в строке, своё не повторяем
const SecretField = ({ t, name, info, setInfo, showToast, title, text, steps, check, secretInput = false, link, onSaved, parts, bare = false }) => {
  const [key, setKey] = useState('');
  const [vals, setVals] = useState({});
  const setPart = (part, v) => {
    const pairs = [...String(v).matchAll(/([A-Za-z_][\w-]*)=([^;\s]+)/g)].filter(([, k]) => parts.some((p) => p.name === k));
    if (pairs.length) setVals((m) => ({ ...m, ...Object.fromEntries(pairs.map(([, k, x]) => [k, x])) }));
    else setVals((m) => ({ ...m, [part]: v.trim() }));
  };
  const composed = parts ? parts.filter((p) => vals[p.name]).map((p) => `${p.name}=${vals[p.name]}`).join('; ') : '';
  const value = parts ? composed : key.trim();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cur = info?.[name];
  const L = t.set_secret[name];

  const save = async (value) => {
    if (value && check && !check(value)) { setError(L.bad); return; }
    setError('');
    setBusy(true);
    try {
      const next = await post(`/api/settings/${name}`, { key: value });
      setInfo(next);
      setKey('');
      setVals({});
      // Сайт не ответил — ключ сохранён, но не проверен
      showToast(value ? (next.checked === false ? t.set_secret_unchecked : L.saved) : L.removed, 'success');
      onSaved?.();
    } catch (err) {
      // Сайт не принял (вход устарел, токен чужой) — своё сообщение; вид не тот — «не похоже»
      setError(errorText(t, err, { byStatus: { 400: err?.reason === 'refused' ? L.refused : L.bad }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (await confirmDialog({ title: L.remove_q, text: L.remove_text, confirmLabel: L.remove, danger: true })) save('');
  };

  return (
    <section className="set-section" data-secret={name}>
      {/* Без заголовка (внутри строки службы) пояснение остаётся на виду: «?» ему не к чему */}
      {!bare && text ? <HelpTitle t={t} title={title} hint={text} /> : (<>
        {!bare && <h3 className="set-title">{title}</h3>}
        {text && <p className="set-hint">{text}</p>}
      </>)}
      {steps && !cur?.set && <ol className="set-list set-steps">{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>}
      {!cur ? <p className="set-hint">…</p>
        : cur.fromEnv ? <p className="set-status ok">{L.env(cur.tail)}</p>
          : (
            <form className="set-form" onSubmit={(e) => { e.preventDefault(); save(value); }} noValidate>
              {/* auto — служба рядом из docker-compose нашлась сама (api/src/utils/nearby.js); nearby — как её включить */}
              <p className={`set-status${cur.set ? ' ok' : ''}`}>{cur.auto ? `${L.auto}` : cur.set ? `${L.has(cur.tail)}` : L.none}</p>
              {!cur.set && L.nearby && <p className="set-hint">{L.nearby}</p>}
              {parts ? parts.map((p) => (
                <label key={p.name} className="auth-field">
                  <span className="auth-label">{p.label}</span>
                  <input type={secretInput ? 'password' : 'text'} autoComplete={secretInput ? 'new-password' : 'off'} spellCheck={false} autoCapitalize="none"
                    value={vals[p.name] || ''} placeholder={p.optional ? L.optional : ''} onChange={(e) => setPart(p.name, e.target.value)} aria-invalid={!!error} />
                </label>
              )) : (
                <label className="auth-field">
                  <span className="auth-label">{cur.set && !cur.auto ? L.replace : L.key}</span>
                  <input type={secretInput ? 'password' : 'text'} autoComplete={secretInput ? 'new-password' : 'off'} spellCheck={false} autoCapitalize="none" value={key}
                    onChange={(e) => setKey(e.target.value)} aria-invalid={!!error} />
                </label>
              )}
              <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
              <div className="set-row">
                <button type="submit" className="save-btn set-submit" disabled={busy || !value}>{busy && name !== 'backup' && name !== 'scraper' ? t.set_secret_checking : t.set_save}</button>
                {cur.set && !cur.auto && <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={remove}>{L.remove}</button>}
              </div>
            </form>
          )}
      {link && <a className="set-ext" href={link.href} target="_blank" rel="noopener noreferrer">{link.label} <IconExternal /></a>}
    </section>
  );
};

// MyJDownloader для «Загрузить» в «Новинках» (api/src/services/myjd.js): почта, пароль, устройство и папка «Входящие»,
// как её видит сервер JDownloader. Хранится одним JSON; наружу — только «задан». При сохранении сервер входит и ищет
// устройство. Своя форма, а не SecretField с parts: тот склеивает поля в «имя=значение; …», а в пароле может быть что угодно
const MyJdField = ({ t, info, setInfo, showToast, linked = false, bare = false }) => {
  const L = t.set_secret.myjd;
  const cur = info?.myjd;
  // Пока не правили — поля из сохранённого: поменять устройство или папку, не вводя почту и пароль заново
  const [edited, setF] = useState(null);
  const f = edited || { email: cur?.email || '', password: '', device: cur?.device || 'server', folder: cur?.folder || '' };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (value) => {
    setError('');
    setBusy(true);
    try {
      setInfo(await post('/api/settings/myjd', { key: value }));
      setF(null);
      showToast(value ? L.saved : L.removed, 'success');
    } catch (err) {
      // Причина точнее общего «не пустил»: неверная почта, пароль, нет устройства
      setError(errorText(t, err, { byStatus: { 400: err?.reason === 'refused' ? L.why[err.why] || L.refused : L.bad }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (await confirmDialog({ title: L.remove_q, text: L.remove_text, confirmLabel: L.remove, danger: true })) save('');
  };
  const field = (name, type = 'text') => (
    <label className="auth-field">
      <span className="auth-label">{L.fields[name]}</span>
      <input type={type} autoComplete={type === 'password' ? 'new-password' : 'off'} spellCheck={false} autoCapitalize="none"
        value={f[name]} onChange={(e) => setF({ ...f, [name]: e.target.value })} aria-invalid={!!error}
        placeholder={name === 'password' && cur?.email && f.email.trim().toLowerCase() === cur.email.toLowerCase() ? L.password_keep : undefined} />
    </label>
  );
  return (
    <section className="set-section" data-secret="myjd">
      {!bare ? <HelpTitle t={t} title="MyJDownloader" hint={L.text} /> : <p className="set-hint">{L.text}</p>}
      {!cur ? <p className="set-hint">…</p>
        : cur.fromEnv ? <p className="set-status ok">{L.env}</p>
          : (
            <form className="set-form" onSubmit={(e) => { e.preventDefault(); save(JSON.stringify(f)); }} noValidate>
              <p className={`set-status${cur.set ? ' ok' : ''}`}>{cur.set ? `${L.has}` : L.none}</p>
              {field('email', 'email')}
              {field('password', 'password')}
              {field('device')}
              {field('folder')}
              <p className="set-hint">{linked ? L.linked_hint : L.folder_hint}</p>
              <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
              <div className="set-row">
                <button type="submit" className="save-btn set-submit" disabled={busy || !f.email.trim() || (!f.password && f.email.trim().toLowerCase() !== (cur?.email || '').toLowerCase())}>{busy ? t.set_secret_checking : t.set_save}</button>
                {cur.set && <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={remove}>{L.remove}</button>}
              </div>
            </form>
          )}
    </section>
  );
};

// Seedbox: сервер, куда качает JDownloader. Пароль — один раз: сервер Mimikin заводит там свой ключ и дальше
// раз в минуту сам забирает готовые архивы во «Входящие» (api/src/services/seedbox.js)
// st — состояние с сервера (/api/settings/seedbox): его же показывает строка службы, поэтому читает его вкладка
const SeedboxField = ({ t, lang, info, setInfo, showToast, st, setSt, bare = false }) => {
  const L = t.set_secret.seedbox;
  // Настроенный — поля заполнены тем, что сохранено: поменять пароль или папку, не вспоминая остальное. Пришло
  // сохранённое позже — вкладка пересоздаёт форму (key), и поля заполняются заново
  const [f, setF] = useState(() => ({ host: st?.host || '', port: String(st?.port || 22), user: st?.user || '', password: '', folder: st?.folder || '' }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cur = info?.seedbox;
  const save = async (value) => {
    setError('');
    setBusy(true);
    try {
      setInfo(await post('/api/settings/seedbox', { key: value }));
      setF((v) => ({ ...v, password: '' }));
      showToast(value ? L.saved : L.removed, 'success');
    } catch (err) {
      setError(errorText(t, err, { byStatus: { 400: err?.reason === 'refused' ? err.message || L.refused : L.bad }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };
  const pull = async () => {
    setBusy(true);
    try { setSt(await post('/api/settings/seedbox/pull', {})); } catch (err) { setError(errorText(t, err)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (await confirmDialog({ title: L.remove_q, text: L.remove_text, confirmLabel: L.remove, danger: true })) save('');
  };
  const field = (name, type = 'text', extra = {}) => (
    <label className="auth-field">
      <span className="auth-label">{L.fields[name]}</span>
      <input type={type} autoComplete={type === 'password' ? 'new-password' : 'off'} spellCheck={false} autoCapitalize="none"
        value={f[name]} onChange={(e) => setF((v) => ({ ...v, [name]: e.target.value }))} aria-invalid={!!error} {...extra} />
    </label>
  );
  return (
    <section className="set-section" data-secret="seedbox">
      {!bare ? <HelpTitle t={t} title={L.title} hint={L.text} /> : <p className="set-hint">{L.text}</p>}
      {!cur ? <p className="set-hint">…</p>
        : cur.fromEnv ? <p className="set-status ok">{L.env}</p>
          : (
            <form className="set-form" onSubmit={(e) => { e.preventDefault(); save(JSON.stringify(f)); }} noValidate>
              <p className={`set-status${cur.set ? ' ok' : ''}`}>{cur.set && st?.set ? `${L.has(`${st.user}@${st.host}`, st.folder || '~')}` : L.none}</p>
              {cur.set && st?.set && (
                <p className={`set-hint${st.error ? ' set-error' : ''}`}>
                  {st.error ? L.last_error(st.error) : st.last ? L.last_ok(timeAgo(st.last, lang), st.pulled) : L.waiting}
                </p>
              )}
              {field('host', 'text', { placeholder: 'wolf.usbx.me' })}
              {field('port', 'text', { inputMode: 'numeric' })}
              {field('user')}
              {field('password', 'password', { placeholder: cur.set ? L.password_again : '' })}
              {field('folder', 'text', { placeholder: 'downloads/jdownloader2/Games/Mimikin' })}
              <p className="set-hint">{L.folder_hint}</p>
              <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
              <div className="set-row">
                <button type="submit" className="save-btn set-submit" disabled={busy || !f.host.trim() || !f.user.trim() || !f.password || !f.folder.trim()}>{busy ? t.set_secret_checking : cur.set ? L.resave : L.connect}</button>
                {cur.set && <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={pull}>{L.pull}</button>}
                {cur.set && <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={remove}>{L.remove}</button>}
              </div>
            </form>
          )}
    </section>
  );
};

// Параметр, который раньше был только в .env (api/src/utils/options.js): число с кнопкой «Сохранить». Задан в .env —
// только видно, какой. Отличается от значения по умолчанию — есть и «Вернуть»
const OptionNumber = ({ t, info, setInfo, showToast, name, label, hint }) => {
  const o = info?.options?.[name];
  const [v, setV] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!o) return null;
  const save = async (value) => {
    setError('');
    setBusy(true);
    try {
      setInfo(await post('/api/settings/options', { name, value }));
      setV('');
      showToast(t.set_option_saved, 'success');
    } catch (err) {
      setError(errorText(t, err, { byStatus: { 400: t.set_option_bad(o.min, o.max) }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="set-form set-option" onSubmit={(e) => { e.preventDefault(); save(Number(v)); }} noValidate data-option={name}>
      <label className="auth-field">
        <span className="auth-label">{label}</span>
        {o.fromEnv
          ? <span className="set-status ok">{t.set_option_env(o.value)}</span>
          : <input type="number" inputMode="numeric" min={o.min} max={o.max} value={v} placeholder={String(o.value)}
            onChange={(e) => setV(e.target.value)} aria-invalid={!!error} />}
      </label>
      {hint && <p className="set-hint">{hint(o.def)}</p>}
      <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
      {!o.fromEnv && (
        <div className="set-row">
          <button type="submit" className="meta-status-btn" disabled={busy || v.trim() === ''}>{t.set_save}</button>
          {o.value !== o.def && <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={() => save(null)}>{t.set_option_reset(o.def)}</button>}
        </div>
      )}
    </form>
  );
};

// Сводка служб с сервера (services/quota.js): есть ли ключ, отвечает ли служба, сколько осталось и когда обновится.
// fresh — спросить службы заново (кнопка «Проверить службы»)
const useServices = (info) => {
  const [data, setData] = useState(null);
  const [fresh, setFresh] = useState(0);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch(`/api/settings/services${fresh ? '?fresh=1' : ''}`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setData(d); }).catch(() => {}).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [fresh, info]);
  return { svc: data?.services || {}, busy, refresh: () => { setBusy(true); setFresh((n) => n + 1); } };
};

// Состояние строки службы с ключом: [тон, слово]. Тон — цвет: ok золото, off приглушённый, bad красный
const keyState = (t, cur, s) => {
  const S = t.set_row_state;
  if (!cur?.set) return ['off', S.off];
  if (s?.exhausted) return ['bad', S.exhausted];
  if (s?.ok === false) return ['bad', S.refused];
  return ['ok', cur.fromEnv ? S.env : S.on];
};

// Остаток лимита строкой: DeepL и ScraperAPI называют его сами, у Microsoft и Google — счётчик библиотеки
const quotaLine = (t, lang, name, s) => {
  if (!s?.key) return '';
  if (name === 'libre') return t.svc_unlimited;
  if (!(s.limit > 0)) return '';
  const num = (n) => Number(n || 0).toLocaleString(lang);
  const date = (at) => new Date(at).toLocaleDateString(lang, { day: 'numeric', month: 'long' });
  return [t.svc_left(num(s.left), num(s.limit), t.svc_unit[s.unit]), s.resetAt ? t.svc_reset(date(s.resetAt)) : t.svc_reset_monthly, s.from === 'local' ? t.svc_local : '']
    .filter(Boolean).join(', ');
};

// Строка службы: название, что она даёт, остаток и состояние; щелчок — её настройка под строкой. Открыта одна:
// вкладка остаётся списком, по которому видно, что подключено, а что нет
const ServiceRow = ({ id, open, setOpen, name, desc, quota, state, children }) => (
  <div className={`svc-item${open === id ? ' open' : ''}`}>
    <button type="button" className="svc-item-head" aria-expanded={open === id} aria-controls={`svc-${id}`} onClick={() => setOpen(open === id ? null : id)}>
      <span className="svc-item-main">
        <span className="svc-item-top">
          <span className="svc-item-name">{name}</span>
          {/* Знак — самоцвет из сундука-мимика: горит — работает, тусклый — не настроено, красный — ошибка.
              Не квадратик: пустой читался галочкой. Слово рядом есть всегда, знак его только подкрепляет */}
          <span className={`svc-item-state ${state[0]}`}><i className={`svc-gem ${state[0]}`} aria-hidden="true" />{state[1]}</span>
        </span>
        <span className="svc-item-desc">{desc}</span>
        {quota && <span className="svc-item-quota">{quota}</span>}
      </span>
    </button>
    {open === id && <div className="svc-item-body" id={`svc-${id}`}>{children}</div>}
  </div>
);

const SvcToolbar = ({ t, busy, refresh }) => (
  <div className="svc-toolbar">
    <button type="button" className="meta-status-btn subtle svc-refresh" disabled={busy} onClick={refresh}><IconRefresh />{busy ? t.svc_checking : t.svc_refresh}</button>
  </div>
);

// Строка без раскрытия: источник, которому ключ не нужен (VNDB, Steam) — название, что он даёт и слово «без ключа»
const OpenRow = ({ name, desc, state }) => (
  <div className="svc-item">
    <div className="svc-item-head static">
      <span className="svc-item-main">
        <span className="svc-item-top">
          <span className="svc-item-name">{name}</span>
          <span className="svc-item-state ok"><i className="svc-gem ok" aria-hidden="true" />{state}</span>
        </span>
        <span className="svc-item-desc">{desc}</span>
      </span>
    </div>
  </div>
);

// «Источники»: откуда библиотека берёт данные игр. itch.io читается через ScraperAPI (страницы игр за защитой сайта,
// страница — 10 кредитов), VNDB и Steam отвечают открыто, ключ им не нужен
const SourcesTab = ({ t, lang, info, setInfo, showToast }) => {
  const [open, setOpen] = useState(null);
  const { svc, busy, refresh } = useServices(info);
  const R = t.set_rows;
  const common = { t, info, setInfo, showToast, bare: true, secretInput: true };
  return (
    <>
      <section className="set-section svc-group">
        <h3 className="set-title">{t.set_groups.data}</h3>
        <div className="svc-items">
        <ServiceRow id="scraper" open={open} setOpen={setOpen} name="ScraperAPI" desc={R.scraper} quota={quotaLine(t, lang, 'scraper', svc.scraper)} state={keyState(t, info?.scraper, svc.scraper)}>
          {svc.scraper?.today && <p className="set-hint">{t.svc_today(svc.scraper.today.used, svc.scraper.today.limit)}</p>}
          <SecretField {...common} secretInput={false} name="scraper" title="ScraperAPI" text={t.set_scraper_text} check={(v) => /^[A-Za-z0-9]{16,64}$/.test(v)}
            link={{ href: 'https://www.scraperapi.com/', label: t.set_scraper_get }} />
          <OptionNumber t={t} info={info} setInfo={setInfo} showToast={showToast} name="scraper_daily_limit" label={t.set_option.scraper_daily_limit} hint={t.set_option.scraper_daily_limit_hint} />
        </ServiceRow>
        <OpenRow name="VNDB" desc={R.vndb} state={t.set_row_state.open} />
        <OpenRow name="Steam" desc={R.steam} state={t.set_row_state.open} />
        </div>
      </section>
      <SvcToolbar t={t} busy={busy} refresh={refresh} />
    </>
  );
};

// «Перевод»: как он устроен, ключи служб по порядку очереди и словарь терминов
const TL_SERVICES = [
  ['deepl', 'DeepL', (v) => /^[0-9a-f-]{36}(:fx)?$/i.test(v)],
  ['microsoft', 'Microsoft Translator', (v) => /^[A-Za-z0-9]{32,100}([\s,|]+[a-z0-9]{2,30})?$/.test(v)],
  ['google', 'Google Cloud', (v) => /^AIza[0-9A-Za-z_-]{30,45}$/.test(v)],
  ['libre', 'LibreTranslate', (v) => /^https?:\/\/\S+(\s+\S+)?$/.test(v)],
];
const TranslateTab = ({ t, lang, info, setInfo, showToast }) => {
  const [open, setOpen] = useState(null);
  const { svc, busy, refresh } = useServices(info);
  return (
    <>
      <section className="set-section">
        <p className="set-hint">{t.set_tl_intro}</p>
      </section>
      <div className="svc-items">
        {TL_SERVICES.map(([name, title, check]) => (
          <ServiceRow key={name} id={name} open={open} setOpen={setOpen} name={title} desc={t.set_rows[name]}
            quota={quotaLine(t, lang, name, svc[name])} state={keyState(t, info?.[name], svc[name])}>
            <SecretField t={t} name={name} info={info} setInfo={setInfo} showToast={showToast} bare secretInput={name !== 'libre'}
              title={t.set_secret[name].title} text={t.set_secret[name].text} steps={t.set_secret[name].steps} check={check} />
          </ServiceRow>
        ))}
      </div>
      <SvcToolbar t={t} busy={busy} refresh={refresh} />
      <TermsSection t={t} />
    </>
  );
};

// Две установки на одном JDownloader (api/src/services/relay.js): на одной — адрес другой и «Связать», на другой —
// «Разрешить». Ролей нет: каждая сама находит свои архивы. st — состояние с сервера (/api/settings/relay)
const RelayField = ({ t, lang, showToast, st, setSt }) => {
  const L = t.set_relay;
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Пока открыто — спрашиваем сервер каждые 3 с: там нажали «Разрешить» или сюда пришла просьба связать
  useEffect(() => {
    const id = setInterval(() => fetch('/api/settings/relay').then((r) => (r.ok ? r.json() : null)).then((d) => d && setSt(d)).catch(() => {}), 3000);
    return () => clearInterval(id);
  }, [setSt]);
  const act = async (what, body = {}, done = '') => {
    setError('');
    setBusy(true);
    try {
      setSt(await post(`/api/settings/relay/${what}`, body));
      if (done) showToast(done, 'success');
    } catch (err) {
      setError(errorText(t, err, { byStatus: { 502: L.no_answer, 409: L.conflict }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    if (await confirmDialog({ title: L.unlink_q, text: L.unlink_text, confirmLabel: L.unlink, danger: true })) act('unlink', {}, L.unlinked);
  };
  if (!st) return <p className="set-hint">…</p>;
  const o = st.outgoing;
  return (
    <section className="set-section" data-secret="relay">
      <p className="set-hint">{L.text}</p>
      {st.linked ? (
        <>
          <p className="set-status ok">{L.linked_to(st.linked.url)}</p>
          {st.linked.folder && <p className="set-hint">{L.folder(st.linked.folder, st.linked.self)}</p>}
          {st.peer && <p className="set-hint">{L.peer_down}</p>}
          {st.error ? <p className="set-hint set-error">{L.last_error(st.error)}</p> : st.last ? <p className="set-hint">{L.last_ok(timeAgo(st.last, lang), st.pulled)}</p> : null}
          <div className="set-row">
            <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={() => act('pull')}>{L.pull}</button>
            <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={unlink}>{L.unlink}</button>
          </div>
        </>
      ) : (
        <>
          {st.asks.map((a) => (
            <div key={a.request} className="set-section" role="alert">
              <p className="set-status">{L.ask(a.url, a.ip && !a.url.includes(a.ip) ? a.ip : '', a.code)}</p>
              <div className="set-row">
                <button type="button" className="save-btn set-submit" disabled={busy} onClick={() => act('approve', { request: a.request }, L.linked)}>{L.approve}</button>
                <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={() => act('deny', { request: a.request })}>{L.deny}</button>
              </div>
            </div>
          ))}
          {o?.status === 'waiting' ? (
            <>
              <p className="set-status">{L.waiting(o.url, o.code)}</p>
              {o.error && <p className="set-hint set-error">{o.error}</p>}
              <div className="set-row">
                <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={() => act('cancel')}>{L.cancel}</button>
              </div>
            </>
          ) : (
            <form className="set-form" onSubmit={(e) => { e.preventDefault(); act('pair', { url, self: window.location.origin }); }} noValidate>
              {o && <p className="set-hint set-error">{o.status === 'denied' ? L.denied(o.url) : L.expired}</p>}
              <label className="auth-field">
                <span className="auth-label">{L.address}</span>
                <input type="text" inputMode="url" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="http://192.168.1.10"
                  value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!!error} />
              </label>
              <p className="set-hint">{L.address_hint}</p>
              <div className="set-row">
                <button type="submit" className="save-btn set-submit" disabled={busy || !url.trim()}>{busy ? t.set_secret_checking : L.pair}</button>
              </div>
            </form>
          )}
        </>
      )}
      <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
    </section>
  );
};

// Закладка «В Mimikin»: на странице файла открывает библиотеку с #jd=<адрес страницы> (App.jsx, JdLinkPanel). Адрес
// библиотеки — тот, с которого открыты настройки. Ссылку javascript: кладём в href мимо React: он такие адреса в разметке
// не пропускает, а закладке нужен именно он. Здесь, в настройках, нажимать её нечем — гасим клик, её надо перетащить
const JdBookmark = ({ t, info }) => {
  const M = t.jd_mark;
  const code = `javascript:(function(){window.open('${window.location.origin}/#jd='+encodeURIComponent(location.href),'_blank')})()`;
  return (
    <section className="set-section" data-section="jd-bookmark">
      {/* Закладку перетаскивают на панель браузера — на сенсорном экране этого нет: там прячем её и подпись к ней
          (.jd-pointer), а заголовок меняем на «Ссылка с телефона» (.jd-touch) */}
      <h3 className="set-title jd-pointer">{M.title}</h3>
      <h3 className="set-title jd-touch">{M.title_phone}</h3>
      <p className="set-hint jd-pointer">{M.hint}</p>
      <div className="set-row jd-pointer">
        <a ref={(el) => el?.setAttribute('href', code)} className="meta-status-btn catalog-primary jd-bookmark" onClick={(e) => e.preventDefault()}>{M.link}</a>
        <span className="set-hint">{M.drag}</span>
      </div>
      <p className="set-hint">{M.phone}</p>
      {/* Строка без раскрытия: бот живёт в «Уведомлениях», здесь только видно, подключён ли он */}
      <div className="jd-touch"><div className="svc-items">
        <div className="svc-item">
          <div className="svc-item-head static">
            <span className="svc-item-main">
              <span className="svc-item-top">
                <span className="svc-item-name">{M.bot}</span>
                <span className={`svc-item-state ${info?.telegram?.set ? 'ok' : 'off'}`}><i className={`svc-gem ${info?.telegram?.set ? 'ok' : 'off'}`} aria-hidden="true" />{info?.telegram?.set ? M.bot_on : M.bot_off}</span>
              </span>
            </span>
          </div>
        </div>
      </div></div>
    </section>
  );
};

// «Загрузки»: «Загрузить» в «Новинках» (MyJDownloader) и забор скачанного с seedbox
const DownloadsTab = ({ t, lang, info, setInfo, showToast }) => {
  const [open, setOpen] = useState(null);
  const [box, setBox] = useState(null);
  const [rel, setRel] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/settings/seedbox').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setBox(d); }).catch(() => {});
    fetch('/api/settings/relay').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setRel(d); }).catch(() => {});
    return () => { alive = false; };
  }, [info]);
  const S = t.set_row_state;
  const boxState = !info?.seedbox?.set ? ['off', S.off] : box?.error ? ['bad', S.error] : ['ok', S.on];
  const relState = rel?.linked ? (rel.error ? ['bad', S.error] : ['ok', t.set_relay.state_linked]) : rel?.asks?.length ? ['bad', t.set_relay.state_ask]
    : rel?.outgoing?.status === 'waiting' ? ['off', t.set_relay.state_waiting] : ['off', S.off];
  return (
    <>
    <section className="set-section svc-group">
    <h3 className="set-title">{t.set_groups.jd}</h3>
    <div className="svc-items">
      <ServiceRow id="myjd" open={open} setOpen={setOpen} name="MyJDownloader" desc={t.set_rows.myjd} state={keyState(t, info?.myjd)}>
        <MyJdField t={t} info={info} setInfo={setInfo} showToast={showToast} linked={!!rel?.linked} bare />
      </ServiceRow>
      <ServiceRow id="seedbox" open={open} setOpen={setOpen} name={t.set_secret.seedbox.title} desc={t.set_rows.seedbox}
        quota={box?.set && box.last ? t.set_row_checked(timeAgo(box.last, lang)) : ''} state={boxState}>
        <SeedboxField key={box?.set ? `${box.host}|${box.user}|${box.folder}` : 'new'} t={t} lang={lang} info={info} setInfo={setInfo} showToast={showToast} st={box} setSt={setBox} bare />
      </ServiceRow>
      <ServiceRow id="relay" open={open} setOpen={setOpen} name={t.set_relay.title} desc={t.set_rows.relay}
        quota={rel?.linked && rel.last ? t.set_row_checked(timeAgo(rel.last, lang)) : ''} state={relState}>
        <RelayField t={t} lang={lang} showToast={showToast} st={rel} setSt={setRel} />
      </ServiceRow>
    </div>
    </section>
    <JdBookmark t={t} info={info} />
    </>
  );
};

const TL_LANGS = ['ru', 'en', 'de'];

// Словарь терминов: как перевести команды меню и характеристики. Из переведённых игр библиотеки (за
// какой вариант сколько игр) или встроенный — сервер: services/termlib.js. Только посмотреть
const TermsSection = ({ t }) => {
  const [data, setData] = useState(null);
  const [lang, setLang] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/games/translation/terms').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!data) return null;
  const current = lang || TL_LANGS.find((l) => data.games[l] > 0) || 'ru';
  const fromLibrary = data.terms.filter((r) => r[current].votes).length;
  return (
    <section className="set-section">
      <details className="set-terms">
        <Summary>{t.set_terms_title}</Summary>
        <p className="set-hint">{t.set_terms_hint}</p>
        <div className="tl-langs" role="radiogroup" aria-label={t.set_terms_title}>
          {TL_LANGS.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={current === l} className={`chip${current === l ? ' active' : ''}`} onClick={() => setLang(l)}>
              {t.tl_names[l]}
            </button>
          ))}
        </div>
        <p className="set-hint">{t.set_terms_count(data.games[current], fromLibrary)}</p>
        <ul className="set-terms-list">
          {data.terms.map((r) => (
            <li key={r.ja}>
              <span className="set-terms-ja" lang="ja">{r.ja}</span>
              <span className="set-terms-tr">{r[current].text}</span>
              <span className="set-terms-from">{r[current].votes ? t.set_terms_votes(r[current].votes, r[current].total) : t.set_terms_builtin}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
};

// Новая версия (api/src/services/updates.js). «Обновить» — через помощника рядом (Watchtower и совместимые): сервер
// уходит на перезапуск, страница ждёт, пока он вернётся с другой версией, и перезагружается. Помощника нет — команда
const UPDATE_WAIT_MS = 10 * 60 * 1000;
const UpdateBlock = ({ t, lang, up, setUp }) => {
  const U = t.set_update;
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [copied, setCopied] = useState(false);
  // Ожидание новой версии — до закрытия окна: закрыли — не опрашиваем и не перезагружаем страницу
  const waitTimer = useRef(null);
  useEffect(() => () => clearTimeout(waitTimer.current), []);
  const check = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/settings/update?fresh=1');
      if (r.ok) setUp(await r.json());
    } catch { /* нет сети — оставим прежнее */ } finally { setBusy(false); }
  };
  const update = async () => {
    setPhase('updating');
    try {
      await post('/api/settings/update', {});
    } catch (err) {
      setPhase('');
      setUp((u) => ({ ...u, actionError: errorText(t, err) }));
      return;
    }
    const until = Date.now() + UPDATE_WAIT_MS;
    const wait = async () => {
      const v = await fetch('/api/settings').then((r) => (r.ok ? r.json() : null), () => null);
      if (v?.version && v.version !== up.current) return window.location.reload();
      if (Date.now() > until) return setPhase('slow');
      waitTimer.current = setTimeout(wait, 5000);
    };
    waitTimer.current = setTimeout(wait, 5000);
  };
  if (!up) return <p className="set-hint">{U.checking}</p>;
  if (up.off) return <p className="set-hint">{U.off}</p>;
  const command = up.how === 'image' ? `docker pull ${up.image}:latest` : 'git pull && docker compose up -d --build';
  const copy = () => navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => {});
  const when = up.checkedAt ? new Date(up.checkedAt).toLocaleString(lang, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  if (!up.newer) {
    return (
      <div className="set-row set-update-line">
        <p className={`set-status${up.error ? '' : ' ok'}`}>{up.error ? U.failed(up.error) : `${U.latest}`}{when && <span className="set-hint">, {U.checked(when)}</span>}</p>
        <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={check}>{busy ? t.svc_checking : U.check}</button>
      </div>
    );
  }
  return (
    <div className="set-update" role="status">
      <p className="set-update-title">{U.available(up.latest)}</p>
      {up.notes?.length > 0 && <ul className="set-update-notes">{up.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {up.url && <a className="set-ext" href={up.url} target="_blank" rel="noopener noreferrer">{U.all_changes} <IconExternal /></a>}
      {up.how === 'button' ? (
        <>
          <p className="set-hint">{phase === 'updating' ? U.updating : phase === 'slow' ? U.slow : U.button_hint}</p>
          <div className="set-row">
            <button type="button" className="save-btn set-submit" disabled={!!phase} onClick={update}>{phase ? U.updating_short : U.update}</button>
          </div>
          {up.actionError && <p className="auth-error" role="alert">{up.actionError}</p>}
        </>
      ) : (
        <>
          <p className="set-hint">{up.how === 'image' ? U.image_hint : U.source_hint}</p>
          <div className="set-command">
            <code>{command}</code>
            <button type="button" className="meta-status-btn subtle" onClick={copy}>{copied ? U.copied : U.copy}</button>
          </div>
        </>
      )}
    </div>
  );
};

// Помощник обновлений (Watchtower и совместимые): адрес его /v1/update и ключ — в базе зашифрованными (api: updater).
// Свой маленький вид, а не SecretField с parts: тот склеивает поля в «имя=значение; …»
const UpdaterField = ({ t, info, setInfo, showToast, onSaved }) => {
  const U = t.set_updater;
  const cur = info?.updater;
  const [f, setF] = useState({ url: '', token: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (value) => {
    setError('');
    setBusy(true);
    try {
      setInfo(await post('/api/settings/updater', { key: value }));
      setF({ url: '', token: '' });
      showToast(value ? U.saved : U.removed, 'success');
      onSaved?.();
    } catch (err) {
      setError(errorText(t, err, { byStatus: { 400: U.bad }, offline: t.srv_lost }));
    } finally {
      setBusy(false);
    }
  };
  if (!cur) return null;
  if (cur.fromEnv) return <p className="set-status ok">{U.env}</p>;
  return (
    <form className="set-form" onSubmit={(e) => { e.preventDefault(); save(JSON.stringify(f)); }} noValidate data-secret="updater">
      <p className="set-hint">{U.text}</p>
      <p className={`set-status${cur.set ? ' ok' : ''}`}>{cur.set ? `${U.has}` : U.none}</p>
      <label className="auth-field">
        <span className="auth-label">{U.url}</span>
        <input type="url" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="http://mimikin-update:8080/v1/update"
          value={f.url} onChange={(e) => setF((v) => ({ ...v, url: e.target.value }))} aria-invalid={!!error} />
      </label>
      <label className="auth-field">
        <span className="auth-label">{U.token}</span>
        <input type="password" autoComplete="new-password" spellCheck={false} value={f.token} onChange={(e) => setF((v) => ({ ...v, token: e.target.value }))} aria-invalid={!!error} />
      </label>
      <div className="auth-error" role="alert" aria-live="assertive">{error}</div>
      <div className="set-row">
        <button type="submit" className="save-btn set-submit" disabled={busy || !f.url.trim()}>{t.set_save}</button>
        {cur.set && <button type="button" className="meta-status-btn subtle" disabled={busy}
          onClick={async () => { if (await confirmDialog({ title: U.remove_q, text: U.remove_text, confirmLabel: U.remove, danger: true })) save(''); }}>{U.remove}</button>}
      </div>
    </form>
  );
};

// Что задаётся только на сервере (.env) и почему: порты, папки, ключ шифрования. Только посмотреть: значения секретов
// сюда не приходят — только «задан» и откуда
const ServerFacts = ({ t }) => {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/settings/server').then((r) => (r.ok ? r.json() : null)).then((x) => { if (alive) setD(x); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!d) return null;
  const S = t.set_server;
  const rows = [
    ['GAME_PORT', d.gamePort, S.gamePort],
    ['GAME_ISOLATION', d.isolation ? S.on : S.off, S.isolation],
    ['GAMES_DIR', d.gamesDir, S.gamesDir],
    ['INBOX_DIR', d.inboxDir, S.inboxDir],
    ['SECRETS_KEY', d.secretsKey === 'env' ? S.secretsEnv : S.secretsFile, S.secretsKey],
    ['SESSION_SECRET', d.sessionSecret === 'env' ? S.sessionEnv : S.sessionDb, S.sessionSecret],
    ['REDIS_URL', d.redis ? 'Redis' : S.memory, S.redis],
    ['OCR_URL', d.ocr ? S.set : S.unset, S.ocr],
    ...(d.offline ? [['OFFLINE', S.on, S.offline]] : []),
  ];
  return (
    <details className="set-terms set-server">
      <Summary>{S.title}</Summary>
      <p className="set-hint">{S.intro}</p>
      <dl className="set-server-list">
        {rows.map(([k, v, why]) => (
          <div key={k}>
            <dt><code>{k}</code> <span>{v}</span></dt>
            <dd>{why}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
};

const AboutTab = ({ t, lang, info, setInfo, showToast, up, setUp }) => {
  const [open, setOpen] = useState(null);
  const check = info?.options?.update_check;
  // Помощника сохранили или убрали, проверку включили — «О программе» спрашивает заново: кнопка или команда
  const recheck = () => fetch('/api/settings/update').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setUp(d); }).catch(() => {});
  const toggleCheck = async (on) => {
    try { setInfo(await post('/api/settings/options', { name: 'update_check', value: on })); recheck(); } catch (err) { showToast(errorText(t, err), 'error'); }
  };
  return (
    <>
      <section className="set-section">
        <div className="set-about-brand"><BrandMark size={48} /><span>Mimikin</span></div>
        <p className="set-hint">{t.subtitle}</p>
        <p className="set-status">{info ? t.set_version(info.version) : '…'}</p>
        <UpdateBlock t={t} lang={lang} up={up} setUp={setUp} />
        <div className="set-row">
          <a className="set-ext" href={`${REPO}/blob/main/CHANGELOG.md`} target="_blank" rel="noopener noreferrer">{t.set_changes} <IconExternal /></a>
          <a className="set-ext" href={REPO} target="_blank" rel="noopener noreferrer">GitHub <IconExternal /></a>
        </div>
      </section>
      <div className="svc-items">
        {check && (
          // Без интернета (OFFLINE=1) проверка не идёт, что бы ни стояло, — так и показываем
          <ServiceRow id="check" open={open} setOpen={setOpen} name={t.set_update.check_title} desc={t.set_update.check_desc}
            state={up?.offline ? ['off', t.set_row_state.files_off] : check.value ? ['ok', t.set_row_state.files_on] : ['off', t.set_row_state.files_off]}>
            {up?.offline ? <p className="set-hint">{t.set_server.offline}</p> : check.fromEnv
              ? <p className="set-status ok">{t.set_option_env(check.value ? t.set_row_state.files_on : t.set_row_state.files_off)}</p>
              : <Toggle checked={check.value} onChange={toggleCheck} label={t.set_update.check_title} hint={t.set_update.check_hint} />}
          </ServiceRow>
        )}
        <ServiceRow id="updater" open={open} setOpen={setOpen} name={t.set_updater.title} desc={t.set_updater.desc}
          state={info?.updater?.set ? ['ok', info.updater.fromEnv ? t.set_row_state.env : t.set_row_state.on] : ['off', t.set_row_state.off]}>
          <UpdaterField t={t} info={info} setInfo={setInfo} showToast={showToast} onSaved={recheck} />
        </ServiceRow>
      </div>
      <ServerFacts t={t} />
    </>
  );
};

// Строка состояния под названием раздела: [текст, тон]. Считается из того, что окно уже получило (/api/settings,
// проверка обновлений) и что вкладки сами сообщили о себе (корзина, копия) — своих запросов на это нет. Данных нет —
// и строки нет: «…» в оглавлении ничего не говорит. Тон: '' обычный, 'bad' ошибка, 'new' есть что открыть
const SOURCE_KEYS = ['scraper'];
const TL_KEYS = TL_SERVICES.map(([name]) => name);
const stateLines = ({ t, lang, info, up, box, trash, backupAt }) => {
  const S = t.set_state;
  const count = (keys) => keys.filter((k) => info?.[k]?.set).length;
  const out = { general: [S.lang[lang]], account: [S.account] };
  if (info) {
    out.sources = [S.sources(count(SOURCE_KEYS), SOURCE_KEYS.length)];
    out.translate = [S.translate(count(TL_KEYS), TL_KEYS.length)];
    out.downloads = box?.error ? [S.downloads_bad(t.set_secret.seedbox.title), 'bad'] : [S.downloads(count(['myjd', 'seedbox']), 2)];
    out.notify = [info.telegram?.set ? S.notify_on : S.notify_off];
  }
  if (backupAt > 0) {
    const d = new Date(backupAt);
    const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    out.backup = [d.toDateString() === new Date().toDateString() ? S.backup_today(time) : S.backup_at(d.toLocaleDateString(lang, { day: 'numeric', month: 'short' }), time)];
  }
  if (trash != null) out.trash = [trash ? S.trash(trash) : S.trash_none];
  if (up?.newer) out.about = [S.about_new(up.latest), 'new'];
  else if (info?.version) out.about = [t.set_version(info.version)];
  return out;
};

// «Настройки» — одно окно со всем, что меняют редко: раньше это были отдельные пункты меню
// (копия, Telegram), язык в подвале меню, а ключ и пароль — только в .env на сервере.
// Вкладки слева; на телефоне — окно на весь экран: вверху оглавление в две колонки (название и состояние), раздел
// открывается под ним, а когда оглавление пролистано — оно сворачивается в строку с кнопкой «Разделы»
const SettingsModal = ({ tab: initialTab = 'general', t, lang, onLangChange, blurCovers, setBlurCovers, socket, showToast, onLogout, onRestoreTrash, onLibraryChanged, onShowKeys, tags, onClose }) => {
  const [tab, setTab] = useState(initialTab);
  const [info, setInfo] = useState(null);
  // Токен бота сменили — панель Telegram перечитывает своё состояние
  const [tgRev, setTgRev] = useState(0);
  const contentRef = useRef(null);
  const navRef = useRef(null);
  const [closing, close] = useClosing(onClose);
  useLayer(contentRef, close);

  // Новая версия — мимик у «О программе». Сервер спрашивает GitHub не чаще раза в 6 часов
  const [up, setUp] = useState(null);
  const [box, setBox] = useState(null);
  const [trash, setTrash] = useState(null);
  const [backupAt, setBackupAt] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch('/api/settings').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setInfo(d); }).catch(() => {});
    fetch('/api/settings/update').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setUp(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // Число игр в корзине (без подсчёта размеров — тот только во вкладке) и время последней копии (её сообщает Telegram):
  // без них строки под «Корзиной» и «Копиями» были бы пустыми, пока не зайдёшь во вкладку
  const tgSet = !!info?.telegram?.set;
  useEffect(() => {
    let alive = true;
    fetch('/api/games/trash?count=1').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && typeof d?.count === 'number') setTrash((n) => n ?? d.count); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!tgSet) return undefined;
    let alive = true;
    fetch('/api/telegram').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d?.backupAt) setBackupAt((at) => at || d.backupAt); }).catch(() => {});
    return () => { alive = false; };
  }, [tgSet]);
  // Seedbox отвечает из памяти сервера, в сеть не ходит; спрашиваем, только если он задан, — ради «Ошибка у Seedbox»
  const boxSet = !!info?.seedbox?.set;
  useEffect(() => {
    if (!boxSet) return undefined;
    let alive = true;
    fetch('/api/settings/seedbox').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setBox(d); }).catch(() => {});
    return () => { alive = false; };
  }, [boxSet]);

  // Оглавление ушло за верх окна — показываем свёрнутую строку. Следит браузер, не прокрутка
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const nav = navRef.current;
    const root = contentRef.current;
    if (!nav || !root || typeof IntersectionObserver === 'undefined') return undefined;
    // Корень сужен сверху на высоту свёрнутой строки: оглавление, от которого остался обрезок, строка перекрывает
    const io = new IntersectionObserver(([e]) => setCollapsed(!e.isIntersecting), { root, threshold: 0, rootMargin: '-76px 0px 0px 0px' });
    io.observe(nav);
    return () => io.disconnect();
  }, []);
  const toIndex = () => {
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    contentRef.current?.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
  };

  const tabs = [
    ['general', t.set_tab_general],
    ['account', t.set_tab_account],
    ['sources', t.set_tab_sources],
    ['translate', t.set_tab_translate],
    ['downloads', t.set_tab_downloads],
    ['notify', t.set_tab_notify],
    ['backup', t.set_tab_backup],
    ['trash', t.set_tab_trash],
    ['about', t.set_tab_about],
  ];
  const lines = stateLines({ t, lang, info, up, box, trash, backupAt });
  const here = lines[tab];

  return (
    <div className={`modal-overlay active pop settings-overlay${closing ? ' closing' : ''}`} onClick={close}>
      <div ref={contentRef} className="stats-content settings-content settings-main" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        {/* Свёрнутое оглавление (только телефон): обёртка нулевой высоты липнет к верху, строка висит в ней,
            поэтому появление строки не сдвигает содержимое и не раскачивает прокрутку */}
        <div className="settings-sticky">
          {collapsed && (
            <div className="settings-bar">
              <span className="settings-bar-text">
                <b>{tabs.find(([key]) => key === tab)?.[1]}</b>
                {here && <small className={here[1] || ''}>{here[0]}</small>}
              </span>
              <button type="button" className="meta-status-btn subtle settings-bar-btn" onClick={toIndex}><IconGrid />{t.set_sections}</button>
              <button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button>
            </div>
          )}
        </div>
        <div className="modal-actions-top"><button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button></div>
        <h2 id="settings-title" className="stats-title settings-title">{t.settings}</h2>
        <div className="settings-body">
          <nav ref={navRef} className="settings-tabs" role="tablist" aria-orientation="vertical">
            {tabs.map(([key, label]) => {
              const line = lines[key];
              return (
                <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={`settings-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
                  <span className="settings-tab-name">
                    {label}
                    {key === 'about' && up?.newer && <BrandMark size={16} className="settings-tab-new" />}
                  </span>
                  {line && <small className={`settings-tab-state${line[1] ? ` ${line[1]}` : ''}`}>{line[0]}</small>}
                </button>
              );
            })}
          </nav>
          <div className="settings-panel" role="tabpanel">
            {tab === 'general' && <GeneralTab t={t} lang={lang} onLangChange={onLangChange} blurCovers={blurCovers} setBlurCovers={setBlurCovers} onShowKeys={onShowKeys} showToast={showToast} tags={tags} />}
            {tab === 'account' && <AccountTab t={t} onLogout={onLogout} showToast={showToast} />}
            {tab === 'notify' && (
              <>
                <TelegramPanel key={tgRev} t={t} lang={lang} socket={socket} showToast={showToast} onBackupAt={setBackupAt} />
                <SecretField t={t} name="telegram" info={info} setInfo={setInfo} showToast={showToast} secretInput
                  title={t.set_secret.telegram.title} text={t.set_secret.telegram.text}
                  check={(v) => /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(v)} onSaved={() => setTgRev((n) => n + 1)} />
                <section className="set-section">
                  <OptionNumber t={t} info={info} setInfo={setInfo} showToast={showToast} name="disk_warn_gb" label={t.set_option.disk_warn_gb} hint={t.set_option.disk_warn_gb_hint} />
                </section>
              </>
            )}
            {tab === 'backup' && <BackupTab t={t} onLibraryChanged={onLibraryChanged} info={info} setInfo={setInfo} showToast={showToast} />}
            {tab === 'trash' && <TrashTab t={t} lang={lang} onRestore={onRestoreTrash} onCount={setTrash} />}
            {tab === 'sources' && <SourcesTab t={t} lang={lang} info={info} setInfo={setInfo} showToast={showToast} />}
            {tab === 'translate' && <TranslateTab t={t} lang={lang} info={info} setInfo={setInfo} showToast={showToast} />}
            {tab === 'downloads' && <DownloadsTab t={t} lang={lang} info={info} setInfo={setInfo} showToast={showToast} />}
            {tab === 'about' && <AboutTab t={t} lang={lang} info={info} setInfo={setInfo} showToast={showToast} up={up} setUp={setUp} />}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
