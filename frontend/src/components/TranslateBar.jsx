import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { errorText, httpError } from '../apiError';
import { confirmDialog } from '../confirm';
import { useLayer } from '../layers';
import { useClosing } from '../useClosing';
import GameCheck from './GameCheck';
import Picker from './Picker';
import PicturesPanel from './PicturesPanel';
import { IconClose, IconSettings } from './icons';

const LANGS = ['en', 'ru', 'de'];
// Разделы окна «Настройки перевода»
const SECTIONS = ['lang', 'check', 'lines', 'pics', 'game', 'file'];
const ENGINE_NAMES = { deepl: 'DeepL', microsoft: 'Microsoft', google: 'Google', libre: 'LibreTranslate' };
const SHOWN = 50;

const send = async (url, options = {}) => {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};
const post = (url, body) => send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// «Перевод» в окне игры (сервер: services/translate.js). Язык — выключатель: включил — сервер переводит
// то, чего ещё нет в словаре, и со следующего запуска игра получает текст с переводом; выключил — снова
// оригинал (игра на диске не меняется). Ход перевода — опросом, пока он идёт. Готовый перевод (MTool,
// свой файл) — загрузить файлом. Включить перевод — с вопросом: сколько строк уйдёт службе и сколько её
// лимита останется (нажал случайно — ничего не потрачено). «Проверить» — слипшиеся слова и текст, который
// не влезет в окно, даже когда игра ужмёт его сама (сервер: utils/tlcheck.js)
// known — игра на языке, который человек знает («Настройки → Общие»): вместо полосы — строка «перевод не
// нужен» с «Всё равно перевести». Перевод уже включён — полоса видна всегда: его надо мочь выключить.
// В карточке игры — одна строка (язык, ход, «Пауза»/«Продолжить», что требует внимания); редкие инструменты —
// проверка, строки, текст на картинках, проверка в игре, файл перевода — в окне «Настройки перевода»
// onRunning(true|false) — идёт ли перевод: окно игры ставит точку на ярлык вкладки «Перевод»
const TranslateBar = ({ game, t, lang, notify, known = false, onRunning, onLang }) => {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [anyway, setAnyway] = useState(false);
  // Окно «Настройки перевода» и его раздел
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState('lang');
  // «Проверить в игре» из строки в карточке — проверка начинается сама (метка — время нажатия)
  const [autoCheck, setAutoCheck] = useState(0);
  // Текст на картинках: сколько подписей ждут проверки — для строки в карточке
  const [pics, setPics] = useState(null);
  const base = `/api/games/${encodeURIComponent(game.id)}/translation`;

  // Сколько подписей на картинках ждёт проверки — при включённом переводе: один раз и после закрытия окна (там их
  // проверяют)
  const tlOn = !!st?.lang;
  useEffect(() => {
    if (open || !tlOn) return undefined;
    let alive = true;
    send(`/api/games/${encodeURIComponent(game.id)}/pictures`).then((d) => { if (alive) setPics(d?.configured ? d : null); }).catch(() => {});
    return () => { alive = false; };
  }, [game.id, open, tlOn]);
  const openSettings = (key) => {
    setSection(key);
    // Перевод готов, а в игре его ещё не проверяли — «Проверить в игре» сразу и запускает проверку
    setAutoCheck(key === 'game' && st?.state === 'done' && !st?.check ? Date.now() : 0);
    setOpen(true);
  };

  useEffect(() => {
    let alive = true;
    let timer = null;
    const load = () => send(base).then((d) => {
      if (!alive) return;
      setSt(d);
      if (d.state === 'running' || d.state === 'queued') timer = setTimeout(load, 2000);
    }).catch(() => {});
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [base, busy]);

  const going = st?.state === 'running' || st?.state === 'queued';
  useEffect(() => { onRunning?.(going); }, [going, onRunning]);
  // Язык перевода — окну игры, для чипа рядом с кодом
  const tlLang = st?.lang || null;
  useEffect(() => { onLang?.(tlLang); }, [tlLang, onLang]);

  const act = async (fn) => {
    setBusy(true);
    try {
      setSt(await fn());
    } catch (e) {
      notify(errorText(t, e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const choose = async (lang) => {
    setCheck(null);
    if (lang) {
      // Спрашиваем, только когда что-то уйдёт в службу: всё уже в словаре или служб нет — тратить нечего.
      // Пока спрашиваем — кнопки заняты: второе нажатие не задаст второй вопрос
      setBusy(true);
      let ok = true;
      try {
        let est = null;
        try { est = await send(`${base}/estimate?lang=${lang}`); } catch { /* без оценки — спросим без цифр */ }
        if (!est || (est.todo > 0 && est.engine)) {
          ok = await confirmDialog({
            title: t.tl_confirm_title,
            name: game.displayTitle || game.title,
            text: est ? t.tl_confirm_text(t.tl_names[lang], ENGINE_NAMES[est.engine], est.todo, est.chars, est.left) : t.tl_confirm_unknown(t.tl_names[lang]),
            confirmLabel: t.tl_confirm_go,
          });
        }
      } finally {
        setBusy(false);
      }
      if (!ok) return;
    }
    await act(async () => {
      const next = await post(base, { lang });
      notify(t.tl_relaunch, 'info');
      return next;
    });
  };
  // «Перевести заново»: lines — выбранные строки, без них — вся игра. Сначала — сколько это стоит
  const redo = async (lines = null) => {
    setBusy(true);
    let ok;
    try {
      const est = await post(`${base}/estimate-redo`, lines ? { lines } : {}).catch(() => null);
      if (est && !est.todo) { notify(t.tl_redo_nothing, 'info'); return; }
      ok = await confirmDialog({
        title: lines ? t.tl_redo_lines_title(lines.length) : t.tl_redo_title,
        name: game.displayTitle || game.title,
        text: [est?.engine ? t.tl_confirm_text(t.tl_names[st.lang], ENGINE_NAMES[est.engine], est.todo, est.chars, est.left) : '', t.tl_redo_note].filter(Boolean).join(' '),
        confirmLabel: t.tl_redo_go,
      });
    } finally {
      setBusy(false);
    }
    if (!ok) return;
    await act(async () => {
      const next = await post(`${base}/redo`, lines ? { lines } : {});
      notify(t.tl_relaunch, 'info');
      return next;
    });
  };
  const runCheck = () => act(async () => {
    setCheck(await send(`${base}/check`));
    return send(base);
  });
  const runFix = () => act(async () => {
    const r = await post(`${base}/fix`);
    notify(t.tl_fixed(r.fixed), r.fixed ? 'success' : 'info');
    setCheck(await send(`${base}/check`));
    return send(base);
  });
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !st?.lang) return;
    await act(async () => {
      const r = await post(`${base}/import`, { lang: st.lang, content: await file.text() });
      notify(t.tl_imported(r.matched, r.total), r.matched ? 'success' : 'info');
      return send(base);
    });
  };

  if (!st) return null;
  const on = !!st.lang;
  if (known && !on && !anyway) {
    return (
      <p className="known-lang-note">
        {t.kl_known_note}
        <button type="button" className="meta-status-btn" onClick={() => setAnyway(true)}>{t.kl_translate_anyway}</button>
      </p>
    );
  }
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
  const running = st.state === 'running' || st.state === 'queued';
  const stateText = st.state === 'running' ? t.tl_state.running(st.done, st.total)
    : st.state === 'queued' ? t.tl_state.queued
      : st.state === 'done' ? t.tl_state.done(st.total)
        : st.state === 'paused' ? t.tl_state.paused(st.done, st.total) : '';
  const errorLine = st.state === 'error' ? (t.tl_error[st.error] || t.tl_error_other(st.error)) : '';
  const canResume = (st.state === 'paused' || (st.state === 'error' && st.error !== 'no-data')) && st.engines?.length > 0;
  const pauseBtn = running && <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={() => act(() => post(`${base}/pause`))}>{t.tl_pause}</button>;
  const resumeBtn = canResume && <button type="button" className="meta-status-btn" disabled={busy} onClick={() => act(() => post(`${base}/resume`))}>{t.tl_resume}</button>;
  const progress = (st.state === 'running' || st.state === 'paused') && st.total > 0 && (
    <div className="tl-track" role="progressbar" aria-valuemin={0} aria-valuemax={st.total} aria-valuenow={st.done}><span style={{ width: `${pct}%` }} /></div>
  );
  // Что требует внимания — строкой в карточке, нажатие ведёт в нужный раздел окна
  const alerts = on ? [
    st.gameErrors?.length > 0 && ['lang', t.tl_alert_errors, true],
    st.check && !st.check.ok && ['game', t.tl_alert_check, true],
    st.failed > 0 && ['lang', t.tl_failed(st.failed), false],
    pics?.review > 0 && ['pics', t.tl_alert_pics(pics.review), false],
    st.state === 'done' && st.done > 0 && !st.check && ['game', t.tl_alert_try, false],
  ].filter(Boolean) : [];

  return (
    <>
      {/* В карточке игры — одна строка: язык, ход, «Пауза»/«Продолжить» и «Настройки перевода» (всё остальное там) */}
      <div className="tl-bar tl-row">
        <span className="tl-title">{t.tl_title}</span>
        <Picker className="tl-select" label={t.tl_title} value={st.lang} disabled={busy} highlight={on}
          options={['', ...LANGS].map((code) => ({ value: code, label: code ? t.tl_names[code] : t.tl_off }))} onChange={choose} />
        <div className="tl-row-status">
          {on && progress}
          {on && stateText && <span className="tl-state">{stateText}{st.engine && st.state === 'running' ? `, ${st.engine}` : ''}</span>}
          {on && errorLine && <span className="tl-state tl-error">{errorLine}</span>}
          {!on && <span className="tl-state">{t.tl_row_off}</span>}
        </div>
        {pauseBtn}{resumeBtn}
        <button type="button" className="meta-status-btn subtle tl-settings-btn" aria-label={t.tl_settings} data-tip={t.tl_settings} onClick={() => openSettings('lang')}><IconSettings />{t.tl_settings_short}</button>
        {alerts.length > 0 && (
          <div className="tl-alerts">
            {alerts.map(([section, text, bad]) => (
              <button key={text} type="button" className={`tl-alert${bad ? ' bad' : ''}`} onClick={() => openSettings(section)}>{text}</button>
            ))}
          </div>
        )}
      </div>

      {/* «Настройки перевода»: разделы слева, как в «Настройках» библиотеки (вариант А). Своим компонентом: монтируется
          на каждое открытие — анимация закрытия и слой Escape начинаются заново */}
      {open && (
        <TranslateWindow
          game={game} t={t} lang={lang} notify={notify} st={st} setSt={setSt} busy={busy} base={base} pics={pics}
          initial={section} autoCheck={autoCheck} check={check} running={running} on={on}
          stateText={stateText} errorLine={errorLine} progress={progress} pauseBtn={pauseBtn} resumeBtn={resumeBtn}
          choose={choose} redo={redo} runCheck={runCheck} runFix={runFix} onFile={onFile}
          onClose={() => { setOpen(false); setAutoCheck(0); }}
        />
      )}
    </>
  );
};

// Окно «Настройки перевода» (TranslateBar → «Настройки» или плашка «что требует внимания»): разделы слева, как в
// «Настройках» библиотеки. Состояние перевода и действия — у TranslateBar; здесь — раздел и само окно
const TranslateWindow = ({
  game, t, lang, notify, st, setSt, busy, base, pics, initial, autoCheck, check, running, on,
  stateText, errorLine, progress, pauseBtn, resumeBtn, choose, redo, runCheck, runFix, onFile, onClose,
}) => {
  const [section, setSection] = useState(initial);
  const windowRef = useRef(null);
  const fileRef = useRef(null);
  const [closing, close] = useClosing(onClose);
  useLayer(windowRef, close);
  return createPortal(
        <div className={`modal-overlay active pop${closing ? ' closing' : ''}`} onClick={close}>
          <div ref={windowRef} className="stats-content settings-content tl-window" role="dialog" aria-modal="true" aria-labelledby="tl-window-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="modal-actions-top"><button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button></div>
            <h2 id="tl-window-title" className="stats-title settings-title">{t.tl_settings_title}<span className="tl-window-game">{game.displayTitle || game.title}</span></h2>
            <div className="settings-body">
              <nav className="settings-tabs" role="tablist" aria-orientation="vertical">
                {SECTIONS.map((key) => (
                  <button key={key} type="button" role="tab" aria-selected={section === key} className={`settings-tab${section === key ? ' active' : ''}`} onClick={() => setSection(key)}>
                    {t.tl_sections[key]}{key === 'pics' && pics?.review > 0 ? ` ${pics.review}` : ''}
                  </button>
                ))}
              </nav>
              <div className="settings-panel tl-panel" role="tabpanel">
                {section === 'lang' && (
                  <section className="set-section">
                    <div className="tl-langs" role="radiogroup" aria-label={t.tl_title}>
                      {['', ...LANGS].map((code) => (
                        <button key={code || 'off'} type="button" role="radio" aria-checked={st.lang === code} disabled={busy}
                          className={`chip${st.lang === code ? ' active' : ''}`} onClick={() => st.lang !== code && choose(code)}>
                          {code ? t.tl_names[code] : t.tl_off}
                        </button>
                      ))}
                    </div>
                    {on && progress}
                    {on && stateText && <span className="tl-state">{stateText}{st.engine && st.state === 'running' ? `, ${st.engine}` : ''}</span>}
                    {on && errorLine && <span className="tl-state tl-error">{errorLine}</span>}
                    {on && st.failed > 0 && <span className="tl-state">{t.tl_failed(st.failed)}</span>}
                    {on && (
                      <div className="tl-actions">
                        {pauseBtn}{resumeBtn}
                        {!running && st.done > 0 && <button type="button" className="meta-status-btn subtle" disabled={busy} data-tip={t.tl_redo_hint} onClick={() => redo()}>{t.tl_redo}</button>}
                      </div>
                    )}
                    {/* После включения перевода игра присылала ошибки — предупредить и предложить играть без перевода */}
                    {on && st.gameErrors?.length > 0 && (
                      <div className="tl-warn" role="alert">
                        <span>{t.chk_errors_after}</span>
                        <ul className="tl-check-list">
                          {st.gameErrors.map((x, i) => <li key={i}><span className="tl-check-text">{[x.message, x.source].filter(Boolean).join(' — ')}</span></li>)}
                        </ul>
                        <button type="button" className="meta-status-btn" disabled={busy} onClick={() => choose('')}>{t.chk_turn_off}</button>
                      </div>
                    )}
                    <span className="tl-note">{t.tl_note}</span>
                  </section>
                )}
                {section === 'check' && (
                  <section className="set-section">
                    <p className="set-hint">{t.tl_check_hint}</p>
                    {!on || st.done === 0 ? <p className="set-hint">{t.tl_needs_done}</p> : (
                      <>
                        <div className="tl-actions"><button type="button" className="meta-status-btn" disabled={busy || running} onClick={runCheck}>{t.tl_check}</button></div>
                        {check && <CheckResult check={check} t={t} busy={busy} onFix={runFix} />}
                      </>
                    )}
                  </section>
                )}
                {section === 'lines' && (
                  <section className="set-section">
                    <p className="set-hint">{t.tl_lines_hint}</p>
                    {!on || st.done === 0 ? <p className="set-hint">{t.tl_needs_done}</p>
                      : <LinesPanel base={base} t={t} busy={busy || running} onRedo={redo} />}
                  </section>
                )}
                {section === 'pics' && (
                  <section className="set-section">
                    <p className="set-hint">{t.tl_pics_hint}</p>
                    <PicturesPanel game={game} t={t} notify={notify} engine={ENGINE_NAMES[st.engines?.[0]] || ''} />
                  </section>
                )}
                {/* Проверка в игре — смонтирована, пока окно открыто: смена раздела её не обрывает (рамка с игрой живёт
                    в GameCheck). Закрыть окно — проверка прервётся, об этом говорит подсказка */}
                <section className="set-section" hidden={section !== 'game'}>
                  <p className="set-hint">{t.tl_game_hint}</p>
                  {!on || st.done === 0 ? <p className="set-hint">{t.tl_needs_done}</p>
                    : <GameCheck game={game} t={t} lang={lang} last={st.check} auto={autoCheck} onSaved={setSt} />}
                </section>
                {section === 'file' && (
                  <section className="set-section">
                    <p className="set-hint">{t.tl_file_hint}</p>
                    <div className="tl-actions">
                      <button type="button" className="meta-status-btn" disabled={busy || !on} data-tip={t.tl_import_hint} onClick={() => fileRef.current?.click()}>{t.tl_import}</button>
                      {on && st.done > 0 && <a className="meta-status-btn subtle" href={`${base}/export`} download data-tip={t.tl_export_hint}>{t.tl_export}</a>}
                    </div>
                    {!on && <p className="set-hint">{t.tl_file_need_lang}</p>}
                    <input ref={fileRef} type="file" accept=".json,.csv,.txt,application/json,text/csv,text/plain" hidden onChange={onFile} />
                  </section>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
  );
};

// «Найти строки»: поиск по оригиналу и переводу («Мэйбел»), отметить — перевести заново только их
const LinesPanel = ({ base, t, busy, onRedo }) => {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const search = async (e) => {
    e?.preventDefault();
    setLoading(true);
    try {
      const d = await send(`${base}/lines?q=${encodeURIComponent(q.trim())}`);
      setRes(d);
      setPicked(new Set());
    } catch {
      setRes({ total: 0, items: [], error: true });
    } finally {
      setLoading(false);
    }
  };
  const toggle = (src) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(src)) next.delete(src); else next.add(src);
    return next;
  });
  // Свой перевод из файла и стандартные слова заново не переводятся — их не отметить
  const machine = (res?.items || []).filter((x) => x.origin === 'machine' || x.origin === 'failed');
  const all = machine.length > 0 && machine.every((x) => picked.has(x.src));
  return (
    <div className="tl-lines">
      <form className="tl-lines-search" onSubmit={search}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.tl_lines_placeholder} aria-label={t.tl_lines_placeholder} />
        <button type="submit" className="meta-status-btn" disabled={loading}>{t.tl_lines_find}</button>
      </form>
      {res && (
        <>
          <span className="tl-state">{res.error ? t.tl_lines_error : t.tl_lines_found(res.total, res.items.length)}</span>
          {res.items.length > 0 && (
            <>
              <div className="tl-lines-actions">
                <label className="tl-lines-all">
                  <input type="checkbox" className="sq-check" checked={all} disabled={!machine.length}
                    onChange={() => setPicked(all ? new Set() : new Set(machine.map((x) => x.src)))} />
                  {t.tl_lines_all}
                </label>
                <button type="button" className="meta-status-btn" disabled={busy || !picked.size} onClick={() => onRedo([...picked])}>{t.tl_lines_redo(picked.size)}</button>
              </div>
              <ul className="tl-check-list">
                {res.items.map((x) => {
                  const own = x.origin === 'import' || x.origin === 'glossary';
                  return (
                    <li key={x.src} className="tl-lines-item">
                      <label>
                        <input type="checkbox" className="sq-check" checked={picked.has(x.src)} disabled={own} onChange={() => toggle(x.src)} />
                        <span className="tl-check-src" lang="ja">{x.src}</span>
                      </label>
                      <span className="tl-check-text">{x.text}</span>
                      {own && <span className="tl-check-kind">{t.tl_lines_own[x.origin]}</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
};

// Итог проверки: сколько мест какого вида и сами места — оригинал и перевод
const CheckResult = ({ check, t, busy, onFix }) => {
  const total = Object.values(check.counts).reduce((a, n) => a + n, 0);
  if (!total) return <span className="tl-state tl-check-ok">{t.tl_check_ok}</span>;
  return (
    <div className="tl-check">
      <div className="tl-check-head">
        <span className="tl-state">{t.tl_check_found(total)}: {Object.entries(check.counts).map(([k, n]) => `${t.tl_check_kinds[k] || k} — ${n}`).join(', ')}</span>
        {check.fixable > 0 && <button type="button" className="meta-status-btn" disabled={busy} onClick={onFix}>{t.tl_check_fix(check.fixable)}</button>}
      </div>
      <ul className="tl-check-list">
        {check.issues.slice(0, SHOWN).map((x) => (
          <li key={`${x.kind}\n${x.src}`}>
            <span className="tl-check-kind">{t.tl_check_kinds[x.kind] || x.kind}</span>
            <span className="tl-check-src" lang="ja">{x.src}</span>
            <span className="tl-check-text">{x.fix || x.text}</span>
          </li>
        ))}
      </ul>
      {total > SHOWN && <span className="tl-note">{t.tl_check_more(total - SHOWN)}</span>}
      <span className="tl-note">{t.tl_check_note}</span>
    </div>
  );
};

export default TranslateBar;
