import { useId, useRef, useState } from 'react';
import { VIEWS, SIZES } from '../libraryLook';
import { GROUPS } from '../libraryGroups';

const ICON = {
  grid: 'M2 2h6v4H2zM10 2h6v4h-6zM2 8h6v4H2zM10 8h6v4h-6zM2 14h6v2H2zM10 14h6v2h-6z',
  feat: 'M2 3h7v5H2zM11 3h5v1.4h-5zM11 6h4v1.4h-4zM2 10h7v5H2zM11 10h5v1.4h-5zM11 13h4v1.4h-4z',
  list: 'M2 3h3v2H2zM7 3h9v2H7zM2 8h3v2H2zM7 8h9v2H7zM2 13h3v2H2zM7 13h9v2H7z',
  wall: 'M2 2h4v4H2zM7 2h4v4H7zM12 2h4v4h-4zM2 7h4v4H2zM7 7h4v4H7zM12 7h4v4h-4zM2 12h4v4H2zM7 12h4v4H7zM12 12h4v4h-4z',
};
const Glyph = ({ name }) => <svg viewBox="0 0 18 18" width="18" height="18" fill="currentColor" aria-hidden="true"><path d={ICON[name]} /></svg>;

// Столбцы списка: первое нажатие — то, что ждёшь от столбца (название от А, остальное — сверху большее и новое), второе — наоборот.
// Значения те же, что у сортировки в панели (App.jsx)
const COLUMNS = [
  ['name', 'name', 'name_desc', 'ascending'],
  ['version', 'version_desc', 'version_asc', 'descending'],
  ['status', 'status', 'status_rev', 'ascending'],
  ['played', 'playtime', 'playtime_asc', 'descending'],
  ['rating', 'rating_desc', 'rating_asc', 'descending'],
  ['size', 'size_desc', 'size_asc', 'descending'],
  ['added', 'newest', 'oldest', 'descending'],
];
const ARROW = { ascending: 'M4 1l4 6H0z', descending: 'M4 7L0 1h8z' };
const flipped = (dir) => (dir === 'ascending' ? 'descending' : 'ascending');

// locked — список упорядочен по тегу картинок: сортировка в это время скрыта и в панели
export const ListHead = ({ sort, setSort, locked, t }) => (
  <div role="table" aria-label={t.lib_view_list}>
    <div role="row" className="lib-list-head">
      {COLUMNS.map(([key, first, second, dir]) => {
        const now = locked ? null : (sort === first && dir) || (sort === second && flipped(dir)) || null;
        return (
          <span key={key} role="columnheader" aria-sort={now || 'none'}>
            <button type="button" className={now ? 'on' : ''} disabled={locked} onClick={() => setSort(sort === first ? second : first)}>
              {t[`lib_col_${key}`]}
              {now && <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d={ARROW[now]} /></svg>}
            </button>
          </span>
        );
      })}
    </div>
  </div>
);

// Вид открывается рядом под чипами, а не окошком: игры сдвигаются вниз, и выбор виден на деле. Помним на устройстве: кто
// настроил вид раз, открытым его не ждёт, кто часто трогает — оставил открытым
const ROW_KEY = 'rpg_libviewrow';
const readRow = () => { try { return localStorage.getItem(ROW_KEY) === '1'; } catch { return false; } };

// group — «Группировать»: { value, onChange, locked, lists }, locked — порядок задаёт тег картинок, lists — у человека есть подборки.
// Здесь, а не в панели: шестой список в её ряду выталкивал «Добавить игру» на вторую строку, и первый ряд игр уезжал вниз
export const LookSwitch = ({ look, t, select, group }) => {
  const [open, setOpenNow] = useState(readRow);
  const setOpen = (on) => { setOpenNow(on); try { localStorage.setItem(ROW_KEY, on ? '1' : ''); } catch { /* вид просто не запомнится */ } };
  const btnRef = useRef(null);
  const ids = useId();
  const sizeOff = look.shown === 'list' || (look.shown === 'feat' && look.view === 'feat');
  // «По подборке» без подборок — пустой выбор; но если он уже выбран (подборки удалили), прячем его только когда он не нужен
  const groups = GROUPS.filter((v) => v !== 'list' || group.lists || group.value === 'list');
  // Escape закрывает только ряд, в котором фокус: preventDefault — знак слоям страницы (layers.js), что клавиша уже занята
  const onKeyDown = (e) => {
    if (e.key !== 'Escape' || !open || e.defaultPrevented || e.nativeEvent.isComposing) return;
    e.preventDefault();
    setOpen(false);
    btnRef.current?.focus();
  };
  const opt = (key, label, pressed, onClick, extra) => (
    <button key={key} type="button" className="look-opt" aria-pressed={pressed} onClick={onClick} {...extra}>{label}</button>
  );
  return (
    <>
      <div className="look-switches" onKeyDown={onKeyDown}>
        <div className="look-seg">
          <button ref={btnRef} type="button" className="look-btn" aria-expanded={open} aria-controls={open ? `${ids}-row` : undefined} aria-label={`${t.lib_view}: ${t[`lib_view_${look.shown}`]}`} onClick={() => setOpen(!open)}>
            <Glyph name={look.shown} />
            {t[`lib_view_${look.shown}`]}
            <svg className="look-chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
          </button>
        </div>
        {select && (
          <div className="look-seg">
            <button type="button" className="look-btn" aria-pressed={select.on} disabled={select.busy} onClick={select.on ? select.exit : select.enter}>{t.select_btn}</button>
          </div>
        )}
      </div>
      {open && (
        <div className="look-row" id={`${ids}-row`} onKeyDown={onKeyDown}>
          <div className="look-grp g-view" role="group" aria-labelledby={`${ids}-view`}>
            <span id={`${ids}-view`}>{t.lib_view_how}</span>
            <div className="look-opts">
              {VIEWS.map((k) => opt(k, <><Glyph name={k} />{t[`lib_view_${k}`]}</>, look.shown === k, () => look.setView(k)))}
            </div>
          </div>
          {!sizeOff && (
            <div className="look-grp g-size" role="group" aria-labelledby={`${ids}-size`}>
              <span id={`${ids}-size`}>{t.lib_size}</span>
              <div className="look-opts">
                {SIZES.map((k) => opt(k, t[`lib_size_${k}`], look.size === k, () => look.setSize(k), k === 'auto' ? { 'data-tip': t.lib_size_auto_hint } : null))}
              </div>
            </div>
          )}
          {look.shown === 'wall' && (
            <div className="look-grp g-wall" role="group" aria-labelledby={`${ids}-wall`}>
              <span id={`${ids}-wall`}>{t.lib_wall}</span>
              <div className="look-opts one">
                {opt('titles', t.lib_titles_always, look.titles, () => look.setTitles(!look.titles))}
              </div>
            </div>
          )}
          <div className="look-grp g-group" role="group" aria-labelledby={`${ids}-group`} aria-describedby={group.locked ? `${ids}-why` : undefined}>
            <span id={`${ids}-group`}>{t.lib_group}</span>
            <div className="look-opts" data-n={groups.length}>
              {groups.map((v) => opt(v, v === 'none' ? t.lib_group_off : t[`lib_group_${v}`], (group.locked ? v === 'none' : group.value === v), () => group.onChange(v), { disabled: group.locked, 'data-group': v }))}
            </div>
            {/* Выключено — не спрятано: человек видит, что группировка есть, и почему сейчас недоступна */}
            {group.locked && <small id={`${ids}-why`}>{t.lib_group_locked}</small>}
          </div>
        </div>
      )}
    </>
  );
};
