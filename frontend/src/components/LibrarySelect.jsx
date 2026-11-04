import { useLayoutEffect, useRef, useState } from 'react';
import { useLayer } from '../layers';
import Picker from './Picker';

const STATUSES = ['playing', 'done', 'dropped', 'wish'];
const NO_STATUS = 'none';
// Такого имени у подборки не бывает: имена без управляющих символов
const NEW_LIST = '\u0000new';

// Панель режима выбора (librarySelect.js) внизу экрана. Выбор варианта в списке сразу применяется ко всем выбранным играм,
// поэтому список всегда показывает своё название, а не последний выбор
const LibrarySelect = ({ select, owner, lists, t }) => {
  const bar = useRef(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  // Не окно: страница под панелью работает. Но Escape и жест «назад» снимают сперва режим выбора, как и у верхнего слоя
  useLayer(bar, (keep) => { if (select.busy) keep?.(); else select.exit(); }, { modal: false, trap: false, focus: false });
  useLayoutEffect(() => {
    const root = document.documentElement;
    const measure = new ResizeObserver(() => root.style.setProperty('--select-bar', `${bar.current.offsetHeight}px`));
    measure.observe(bar.current);
    return () => { measure.disconnect(); root.style.removeProperty('--select-bar'); };
  }, []);

  const off = select.busy || !select.count;
  const pickStatus = (v) => { if (v) select.setStatus(v === NO_STATUS ? '' : v); };
  const pickRating = (v) => { if (v) select.setRating(Number(v)); };
  const pickList = (v) => {
    if (v === NEW_LIST) setNaming(true);
    else if (v) select.addToList(v);
  };
  const addNew = (e) => {
    e.preventDefault();
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    // Как в окне игры: имя существующей с другим регистром — та же подборка
    select.addToList(lists.find((x) => x.toLowerCase() === clean.toLowerCase()) || clean);
    setName('');
    setNaming(false);
  };

  return (
    <>
      <div className="select-room" />
      <div ref={bar} className="select-bar" role="group" aria-label={t.select_bar}>
        <span className="select-count" role="status">{t.select_count(select.count)}</span>
        <button type="button" disabled={select.busy || select.allPicked} onClick={select.selectAll}>{t.select_all}</button>
        <Picker label={t.select_status} value="" disabled={off} onChange={pickStatus}
          options={[{ value: '', label: t.select_status }, ...STATUSES.map((key) => ({ value: key, label: t[`status_${key}`] })), { value: NO_STATUS, label: t.select_no_status }]} />
        {naming ? (
          <form className="select-new" onSubmit={addNew}>
            <input type="text" value={name} maxLength={60} autoFocus placeholder={t.lists_new} aria-label={t.lists_new} onChange={(e) => setName(e.target.value)}
              // Escape здесь — про поле, а не про весь режим
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setNaming(false); } }} />
            <button type="submit" disabled={off || !name.trim()}>{t.lists_create}</button>
          </form>
        ) : (
          <Picker label={t.select_list} value="" disabled={off} onChange={pickList}
            options={[{ value: '', label: t.select_list }, ...lists.map((x) => ({ value: x, label: x })), { value: NEW_LIST, label: t.lists_new }]} />
        )}
        <Picker label={t.select_rating} value="" disabled={off} onChange={pickRating}
          options={[{ value: '', label: t.select_rating }, ...[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: '★'.repeat(n) })), { value: '0', label: t.select_no_rating }]} />
        {owner && select.diskCount > 0 && <button type="button" disabled={select.busy} onClick={select.shelve}>{t.shelf_confirm}</button>}
        <button type="button" disabled={off} onClick={select.clear}>{t.select_clear}</button>
        <button type="button" className="select-exit" disabled={select.busy} onClick={select.exit}>{t.select_exit}</button>
      </div>
    </>
  );
};

export default LibrarySelect;
