import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { useCoversHidden } from '../coversHidden';
import { confirmDialog } from '../confirm';
import { timeAgo } from '../formatAgo';
import { formatPlaytime } from '../formatPlaytime';
import { IconChevronLeft, IconChevronRight, IconClock, IconClose, IconDownload, IconEdit, IconImage, IconPin, IconPlay, IconStarSolid, IconTrash } from './icons';
import MetaLine from './MetaLine';

// Вкладка «Скриншоты» в окне игры: что запомнили в самой игре (rpg-fixes, setupSceneMarks; хранит utils/marks.js).
//   Сверху — перемотка: точки, которые игра ставит сама (перед боем, перед выбором, на новой карте, раз в 10 минут).
//   Ниже — свои кадры по дням: снимки (F8) и моменты; у кого есть сейв — «Играть отсюда».
// Нажатие открывает кадр целиком: играть отсюда, оставить точку перемотки, сделать обложкой, скачать, подписать, убрать
const api = (id, rest = '') => `/api/marks/${encodeURIComponent(id)}${rest}`;

// Перед боем и перед выбором — свои значки (у остальных: карта — булавка, время — часы)
const IconBattle = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19L19 5M14 5h5v5M5 5l14 14M5 14v5h5" /></svg>;
const IconChoice = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21v-6M12 15L6 9V4M12 15l6-6V4" /></svg>;
const IconScene = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" /><path d="M10 9.5l4.5 2.5-4.5 2.5z" /></svg>;
const IconBack = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>;
const IconExit = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h5v16h-5" /><path d="M10 16l4-4-4-4M14 12H4" /></svg>;
const WHY_ICON = { scene: IconScene, battle: IconBattle, choice: IconChoice, map: IconPin, timer: IconClock, back: IconBack, exit: IconExit };
// Группы перемотки — как на плёнке в игре: по причине
const WHY_GROUPS = ['scene', 'choice', 'battle', 'map', 'timer', 'back', 'exit'];
const whyOf = (m) => (WHY_GROUPS.includes(m.why) ? m.why : 'timer');

const dayKey = (at) => new Date(at).toDateString();

function dayLabel(at, t, lang) {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t.shots_today;
  if (d.toDateString() === yesterday.toDateString()) return t.shots_yesterday;
  return d.toLocaleDateString(lang, { day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

const timeOf = (at, lang) => new Date(at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });

// Подпись точки перемотки: почему она здесь
function whyTitle(m, t) {
  if (m.why === 'scene') return m.label ? `${t.shots_why.scene}: ${m.label}` : t.shots_why.scene;
  if (m.why === 'battle') return m.label ? `${t.shots_why.battle}: ${m.label}` : t.shots_why.battle;
  if (m.why === 'choice') return m.label ? `${t.shots_why.choice}: ${m.label}` : t.shots_why.choice;
  if (m.why === 'map') return `${t.shots_why.map}${m.map || m.label ? `: ${m.map || m.label}` : ''}`;
  if (m.why === 'back') return t.shots_why.back;
  if (m.why === 'exit') return m.map ? `${t.shots_why.exit}: ${m.map}` : t.shots_why.exit;
  return m.label || m.map || t.shots_why.timer;
}

const ShotsPanel = ({ game, t, lang, shots, notify, onPlay, onCover }) => {
  const { items, failed, reload } = shots;
  const [filter, setFilter] = useState('all');
  const [why, setWhy] = useState('all');           // группа перемотки
  const [view, setView] = useState(null);          // { list: 'rewind' | 'own', at }
  const [editing, setEditing] = useState(null);    // подпись открытого кадра
  const [busy, setBusy] = useState('');
  const viewRef = useRef(null);
  // Кадр целиком рисуется в body, вне контейнера с covers-hidden (клавиша H): размывает себя сам
  const hidden = useCoversHidden();
  const touch = useRef(null);

  const rewindAll = (items || []).filter((m) => m.kind === 'auto');
  const groups = WHY_GROUPS.filter((g) => rewindAll.some((m) => whyOf(m) === g));
  const rewind = why === 'all' || !groups.includes(why) ? rewindAll : rewindAll.filter((m) => whyOf(m) === why);
  const own = (items || []).filter((m) => m.kind !== 'auto');
  const moments = own.filter((m) => m.save);
  const pictures = own.filter((m) => !m.save);
  const shown = filter === 'moments' ? moments : filter === 'shots' ? pictures : own;
  const list = view ? (view.list === 'rewind' ? rewind : shown) : [];
  // Удалили открытый — на месте следующего; список кончился — просмотр закрыт
  const at = view && list.length ? Math.min(view.at, list.length - 1) : -1;
  const current = at >= 0 ? list[at] : null;

  const close = () => { setView(null); setEditing(null); };
  const go = (d) => setView((v) => (v && list.length ? { ...v, at: (at + d + list.length) % list.length } : v));
  useLayer(viewRef, close, { active: !!current, focus: 'self' });
  useEffect(() => {
    if (!current) return undefined;
    const onKey = (e) => {
      if (editing) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const act = async (name, work) => {
    setBusy(name);
    try { await work(); } catch { notify(t.shots_failed, 'error'); }
    setBusy('');
  };
  const play = (m) => { close(); onPlay({ mark: m.id }); };
  const keep = (m) => act('keep', async () => {
    const r = await fetch(api(game.id, `/${m.id}/keep`), { method: 'POST' });
    if (r.status === 409) { notify(t.shots_full, 'error'); return; }
    if (!r.ok) throw new Error(String(r.status));
    notify(t.shots_kept);
    close();
    reload();
  });
  // Обложка — тот же путь, что «Своя обложка» в «Изменить» (routes/games.js): кадр уходит файлом
  const cover = (m) => act('cover', async () => {
    const blob = await fetch(api(game.id, `/${m.id}/shot`)).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
    const form = new FormData();
    form.append('cover', blob, 'shot.jpg');
    const r = await fetch(`/api/games/${encodeURIComponent(game.id)}/cover`, { method: 'POST', body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || String(r.status));
    onCover(data.coverPath);
    notify(t.shots_cover_done);
  });
  const rename = (m, label) => act('rename', async () => {
    setEditing(null);
    if (label.trim() === (m.label || '')) return;
    const r = await fetch(api(game.id, `/${m.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
    if (!r.ok) throw new Error(String(r.status));
    reload();
  });
  const remove = async (m) => {
    if (!(await confirmDialog({ title: m.save ? t.shots_remove_moment : t.shots_remove_shot, text: m.label || m.map || '', confirmLabel: t.shots_remove, danger: true }))) return;
    await act('remove', async () => {
      const r = await fetch(api(game.id, `/${m.id}`), { method: 'DELETE' });
      if (!r.ok) throw new Error(String(r.status));
      reload();
    });
  };

  if (items === null) return <p className="shots-wait">{t.shots_loading}</p>;

  const days = [];
  for (const m of shown) {
    const last = days[days.length - 1];
    if (last && last.key === dayKey(m.at)) last.items.push(m);
    else days.push({ key: dayKey(m.at), at: m.at, items: [m] });
  }
  const indexOf = (m) => shown.indexOf(m);

  return (
    <div className="shots">
      {rewindAll.length > 0 && (
        <section className="shots-rewind" aria-label={t.shots_rewind}>
          <div className="shots-rewind-head">
            <b>{t.shots_rewind}</b>
            <span>{t.shots_rewind_hint}</span>
            {groups.length > 1 && (
              <div className="shots-rewind-groups" role="group" aria-label={t.shots_filter}>
                {['all', ...groups].map((g) => (
                  <button key={g} type="button" className={`chip${(groups.includes(why) ? why : 'all') === g ? ' active' : ''}`} aria-pressed={(groups.includes(why) ? why : 'all') === g} onClick={() => setWhy(g)}>
                    {g === 'all' ? t.shots_all : t.shots_why_group[g]} <span className="chip-count">{g === 'all' ? rewindAll.length : rewindAll.filter((m) => whyOf(m) === g).length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="shots-rewind-row">
            {rewind.map((m, i) => {
              const Why = WHY_ICON[whyOf(m)];
              return (
                <button key={m.id} type="button" className="shots-rw" onClick={() => setView({ list: 'rewind', at: i })} data-tip={whyTitle(m, t)}>
                  <span className="shots-rw-pic">
                    {m.thumb ? <img src={api(game.id, `/${m.id}/thumb`)} alt="" loading="lazy" /> : <span className="shots-ph" />}
                    <span className="shots-why"><Why />{t.shots_why_short[whyOf(m)]}</span>
                  </span>
                  <small>{timeAgo(m.at, lang)}</small>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="shots-bar">
        {own.length > 0 && (
          <div className="shots-chips" role="group" aria-label={t.shots_filter}>
            {[['all', t.shots_all, own.length], ['moments', t.shots_moments, moments.length], ['shots', t.shots_pictures, pictures.length]].map(([key, label, n]) => (
              <button key={key} type="button" className={`chip${filter === key ? ' active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)} disabled={!n && key !== 'all'}>
                {label} <span className="chip-count">{n}</span>
              </button>
            ))}
          </div>
        )}
        <span className="shots-keys">{t.shots_keys}</span>
      </div>

      {failed && <p className="shots-wait" role="alert">{t.shots_load_failed}</p>}
      {!failed && own.length === 0 && (
        <div className="shots-empty">
          <IconImage />
          <p>{rewind.length ? t.shots_empty_own : t.shots_empty}</p>
        </div>
      )}

      {days.map((day) => (
        <section key={day.key} className="shots-day">
          <div className="shots-day-head"><h4>{dayLabel(day.at, t, lang)}</h4><span>{t.shots_count(day.items.length)}</span></div>
          <div className="shots-grid">
            {day.items.map((m) => (
              <button key={m.id} type="button" className="shots-card" onClick={() => setView({ list: 'own', at: indexOf(m) })}>
                {m.thumb || m.full ? <img src={api(game.id, `/${m.id}/${m.full ? 'shot' : 'thumb'}`)} alt="" loading="lazy" /> : <span className="shots-ph" />}
                {m.save && <span className="shots-play-badge"><IconPlay />{t.shots_play}</span>}
                <span className="shots-cap">
                  {m.label || m.map || '—'}
                  <MetaLine as="small" parts={[m.map && m.map !== m.label ? m.map : '', timeOf(m.at, lang)]} />
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {current && createPortal(
        <div
          ref={viewRef} className={`gallery-view shots-view${hidden ? ' covers-hidden' : ''}`} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t.modal_tab.shots} onClick={close}
          onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
          onTouchEnd={(e) => {
            const dx = e.changedTouches[0].clientX - (touch.current ?? e.changedTouches[0].clientX);
            if (Math.abs(dx) > 40 && !editing) { e.preventDefault(); go(dx < 0 ? 1 : -1); }
          }}
        >
          <img key={current.id} src={api(game.id, `/${current.id}/${current.full ? 'shot' : 'thumb'}`)} alt="" onClick={(e) => { e.stopPropagation(); go(1); }} />
          {list.length > 1 && <>
            <button type="button" className="lightbox-nav prev" aria-label={t.shelf_prev} onClick={(e) => { e.stopPropagation(); go(-1); }}><IconChevronLeft /></button>
            <button type="button" className="lightbox-nav next" aria-label={t.shelf_next} onClick={(e) => { e.stopPropagation(); go(1); }}><IconChevronRight /></button>
          </>}
          <button type="button" className="lightbox-close" aria-label={t.close} onClick={(e) => { e.stopPropagation(); close(); }}><IconClose /></button>
          <div className="shots-view-bar" onClick={(e) => e.stopPropagation()}>
            <div className="shots-view-cap">
              {editing !== null ? (
                <input
                  className="shots-view-input" autoFocus value={editing} maxLength={120} aria-label={t.shots_rename}
                  onChange={(e) => setEditing(e.target.value)} onBlur={() => rename(current, editing)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}
                />
              ) : (
                <b>{current.kind === 'auto' ? whyTitle(current, t) : current.label || current.map || '—'}</b>
              )}
              <MetaLine as="small" parts={[current.kind !== 'auto' && current.map && current.map !== current.label ? current.map : '',
                `${dayLabel(current.at, t, lang)}, ${timeOf(current.at, lang)}`,
                formatPlaytime(current.playtime, t) ? t.shots_playtime(formatPlaytime(current.playtime, t)) : '',
                t.shots_position(at + 1, list.length)]} />
            </div>
            <div className="shots-view-actions">
              {current.save && <button type="button" className="save-btn" disabled={!!busy} onClick={() => play(current)}><IconPlay />{t.shots_play}</button>}
              {current.kind === 'auto' && <button type="button" className="meta-status-btn" disabled={!!busy} onClick={() => keep(current)} data-tip={t.shots_keep_hint}><IconStarSolid />{t.shots_keep}</button>}
              {(current.full || current.thumb) && current.kind !== 'auto' && (
                <button type="button" className="meta-status-btn" disabled={!!busy} onClick={() => cover(current)}><IconImage />{t.shots_cover}</button>
              )}
              {(current.full || current.thumb) && (
                <a className="meta-status-btn" href={api(game.id, `/${current.id}/${current.full ? 'shot' : 'thumb'}`)} download={`${game.id}-${current.id}.jpg`}><IconDownload />{t.shots_download}</a>
              )}
              {current.kind !== 'auto' && <button type="button" className="meta-status-btn subtle" disabled={!!busy} onClick={() => setEditing(current.label || '')}><IconEdit />{t.shots_rename}</button>}
              {current.kind !== 'auto' && <button type="button" className="meta-status-btn subtle" disabled={!!busy} onClick={() => remove(current)}><IconTrash />{t.shots_remove}</button>}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default ShotsPanel;
