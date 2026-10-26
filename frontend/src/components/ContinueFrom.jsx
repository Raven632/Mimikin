import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmDialog } from '../confirm';
import { timeAgo } from '../formatAgo';
import { formatPlaytime } from '../formatPlaytime';
import { slotName } from '../saveSlots';
import { useLayer } from '../layers';
import { useCoversHidden } from '../coversHidden';
import { loadResume } from '../resumePoint';
import { IconBookmark, IconClose, IconEdit, IconHistory, IconPlay, IconChevronDown } from './icons';
import { pageZoom } from '../pageZoom';
import MetaLine from './MetaLine';

const marksApi = (id, rest = '') => `/api/marks/${encodeURIComponent(id)}${rest}`;

// «Продолжить с…» под «Играть» (окно игры): откуда продолжить — из сейва игры или из момента.
//   Сейвы  — слоты, которые сохранила сама игра (её меню, автосохранение), со снимком экрана: где был, когда сохранился.
//            «прежние версии» — история слота (SaveHistory, onHistory).
//   Моменты — наши «Запомнить момент» из меню ⚙ в игре: где угодно, хоть посреди сцены (rpg-fixes, setupSceneMarks).
// Нажал — игра открывается сразу там (onPlay({ slot }) или onPlay({ mark })). Нет ни сейвов, ни моментов — кнопки нет,
// но если окно открыли кнопкой «Сейвы» с главной (open), список виден: с подсказкой, откуда они берутся.
// Список — всплывающий, поверх окна (как меню «⋯»): в карточке игры всегда одна строка. Рисуется в body, прямо под
// кнопкой (или над ней, если внизу не хватает места): внутри окна игры его обрезал бы край окна. Закрывают нажатие
// мимо и Escape
// reload — номер: вырос — прочитать сейвы заново (вернули версию в «Истории сейвов»)
const ContinueFrom = ({ game, t, lang, notify, open: openInitially = false, reload = 0, onPlay, onHistory }) => {
  const [slots, setSlots] = useState(null);
  const [marks, setMarks] = useState(null);
  const [open, setOpen] = useState(openInitially);
  const hidden = useCoversHidden();
  const [tab, setTab] = useState(null);           // 'saves' | 'moments'; null — сам (где свежее)
  const [editing, setEditing] = useState(null);   // { id, label } — подпись момента
  const cancelled = useRef(false);
  const inputRef = useRef(null);
  const boxRef = useRef(null);
  const panelRef = useRef(null);
  const [place, setPlace] = useState(null);       // { top | bottom, left, width, maxHeight }

  useEffect(() => {
    let alive = true;
    loadResume(game.id).then((d) => { if (alive) { setSlots(d.slots); setMarks(d.marks); } });
    return () => { alive = false; };
  }, [game.id, reload]);
  // Escape закрывает список, а не окно игры; нажатие мимо — тоже
  useLayer(panelRef, () => setOpen(false), { active: open && !!place, history: false, trap: false, focus: '.continue-from-tabs .chip.active' });
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target) || panelRef.current?.contains(e.target) || e.target.closest?.('.confirm-box, .confirm-overlay')) return;
      setOpen(false);
    };
    // pointerdown — и мышь, и палец (на телефоне mousedown бывает не всегда)
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  // Где рисовать: под кнопкой, во всю её ширину (на широком экране — не уже 420), над ней — если внизу тесно.
  // Окно игры прокручивается — список едет вместе с кнопкой
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const btn = boxRef.current?.querySelector('.continue-from-btn');
      if (!btn) return;
      // В точках вёрстки: на широком экране страница в масштабе, а список ставится стилями (pageZoom.js)
      const z = pageZoom();
      const box = btn.getBoundingClientRect();
      const r = { left: box.left / z, top: box.top / z, bottom: box.bottom / z, width: box.width / z };
      const vw = window.innerWidth / z;
      const vh = window.innerHeight / z;
      // Узкий экран (телефон) — ровно по кнопке
      const width = vw < 600 ? r.width : Math.min(Math.max(r.width, 420), vw - 16);
      const left = Math.max(8, Math.min(r.left, vw - width - 8));
      const below = vh - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 240 && above > below;
      setPlace(up
        ? { bottom: vh - r.top + 6, left, width, maxHeight: Math.min(380, above) }
        : { top: r.bottom + 6, left, width, maxHeight: Math.min(380, below) });
    };
    measure();
    // Прокрутка самого списка его места не меняет
    const onScroll = (e) => { if (!panelRef.current?.contains(e.target)) measure(); };
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('scroll', onScroll, true); };
  }, [open, slots, marks]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!slots || !marks || (!slots.length && !marks.length && !openInitially)) return null;
  // Вкладка сама — где самое свежее
  const auto = !slots.length && marks.length ? 'moments' : !marks.length ? 'saves'
    : (marks[0].at > slots[0].current.at ? 'moments' : 'saves');
  const current = tab || auto;

  const renameSave = async () => {
    if (cancelled.current || !editing) { cancelled.current = false; return; }
    const { id, label } = editing;
    setEditing(null);
    const r = await fetch(marksApi(game.id, `/${id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }).catch(() => null);
    if (!r?.ok) { notify(t.err_net, 'error'); return; }
    setMarks((list) => list.map((m) => (m.id === id ? { ...m, label: label.trim().slice(0, 120) } : m)));
  };
  const removeMark = async (m) => {
    if (!(await confirmDialog({ title: t.mark_remove_title, text: m.label || m.map, confirmLabel: t.mark_remove, danger: true }))) return;
    const r = await fetch(marksApi(game.id, `/${m.id}`), { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) { notify(t.err_net, 'error'); return; }
    setMarks((list) => list.filter((x) => x.id !== m.id));
  };

  const saveLine = (s) => {
    const sum = s.current.summary || {};
    return [sum.level ? t.saves_level(sum.level) : '', formatPlaytime(sum.playtime, t), timeAgo(s.current.at, lang)];
  };

  return (
    <div ref={boxRef} className={`continue-from${open ? ' open' : ''}`}>
      <button type="button" className="continue-from-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>{t.continue_from}</span>
        <span className="continue-from-count">{t.continue_from_count(slots.length, marks.length) || '—'} <span className="continue-from-caret" aria-hidden="true"><IconChevronDown /></span></span>
      </button>
      {open && place && createPortal(
        <div ref={panelRef} className={`continue-from-panel${hidden ? ' covers-hidden' : ''}`} role="dialog" aria-label={t.continue_from}
          style={{ ...place, position: 'fixed' }} onClick={(e) => e.stopPropagation()}>
          <div className="continue-from-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={current === 'saves'} className={`chip${current === 'saves' ? ' active' : ''}`} onClick={() => setTab('saves')}>{t.continue_saves} {slots.length}</button>
            <button type="button" role="tab" aria-selected={current === 'moments'} className={`chip${current === 'moments' ? ' active' : ''}`} onClick={() => setTab('moments')}>{t.marks_title} {marks.length}</button>
          </div>

          {current === 'saves' && (slots.length === 0 ? <p className="continue-from-empty">{t.saves_none_short}</p> : slots.map((s) => (
            <div key={s.key} className="continue-item">
              <button type="button" className="continue-item-play" onClick={() => onPlay({ slot: s.key })} data-tip={t.save_play}>
                {s.shot ? <img src={`/api/saves/shot/${encodeURIComponent(game.id)}?key=${encodeURIComponent(s.key)}&v=${Math.round(s.current.at)}`} alt="" loading="lazy" /> : <span className="continue-item-ph"><IconHistory /></span>}
                <span className="continue-item-text">
                  <MetaLine className="continue-item-name" parts={[slotName(s.key, t), s.current.summary?.map]} />
                  <MetaLine className="continue-item-sub" parts={saveLine(s)} />
                </span>
              </button>
              {s.versions.length > 0 && (
                <span className="continue-item-tools">
                  <button type="button" aria-label={t.save_versions(s.versions.length)} data-tip={t.save_versions(s.versions.length)} onClick={() => { setOpen(false); onHistory(); }}><IconHistory /></button>
                </span>
              )}
            </div>
          )))}

          {current === 'moments' && (marks.length === 0 ? <p className="continue-from-empty">{t.marks_empty}</p> : marks.map((m) => (
            <div key={m.id} className="continue-item">
              <button type="button" className="continue-item-play" onClick={() => onPlay({ mark: m.id })} data-tip={t.mark_play}>
                {m.thumb ? <img src={marksApi(game.id, `/${m.id}/thumb`)} alt="" loading="lazy" /> : <span className="continue-item-ph"><IconBookmark /></span>}
                <span className="continue-item-text">
                  {editing?.id === m.id ? null : <span className="continue-item-name">{m.exit ? t.resume_exit : m.label || m.map || '—'}</span>}
                  <MetaLine className="continue-item-sub" parts={[m.exit ? m.map || m.label : m.label && m.map !== m.label ? m.map : '', timeAgo(m.at, lang)]} />
                </span>
              </button>
              {editing?.id === m.id && (
                <input
                  ref={inputRef} className="continue-item-input" value={editing.label} maxLength={120} aria-label={t.mark_rename}
                  onChange={(e) => setEditing({ id: m.id, label: e.target.value })}
                  onBlur={renameSave}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setEditing(null); } }}
                />
              )}
              {/* «Где вышли» — не момент: подписать нечего, а убирать незачем — её сменит следующая */}
              {!m.exit && <span className="continue-item-tools">
                <button type="button" aria-label={t.mark_rename} data-tip={t.mark_rename} onClick={() => { cancelled.current = false; setEditing({ id: m.id, label: m.label || '' }); }}><IconEdit /></button>
                <button type="button" aria-label={t.mark_remove} data-tip={t.mark_remove} onClick={() => removeMark(m)}><IconClose /></button>
              </span>}
            </div>
          )))}

          {/* Явно с титула: «Играть» теперь продолжает с последней точки */}
          <button type="button" className="continue-from-all continue-from-title" onClick={() => onPlay({})}><IconPlay /> {t.continue_title}</button>
          {current === 'saves' && <button type="button" className="continue-from-all" onClick={() => { setOpen(false); onHistory(); }}><IconHistory /> {t.saves_history}</button>}
        </div>,
        document.body,
      )}
    </div>
  );
};

export default ContinueFrom;
