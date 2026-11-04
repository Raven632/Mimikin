import { useState } from 'react';

// Выбрана своя подборка: её имя, «Переименовать» и «Удалить». Удаление не трогает игры, поэтому без тяжёлых последствий, но
// вопрос всё же есть: собрать подборку заново дольше, чем нажать «да»
const ListBar = ({ name, count, t, onRename, onDelete }) => {
  const [editing, setEditing] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    const to = editing.trim().replace(/\s+/g, ' ');
    setEditing(null);
    if (to && to !== name) onRename(to);
  };
  return (
    <div className="list-bar">
      {editing === null ? (
        <>
          <strong>{name}</strong>
          <span className="chip-count">{count}</span>
          <button type="button" className="tag-reset" onClick={() => setEditing(name)}>{t.lists_rename}</button>
          <button type="button" className="tag-reset" onClick={onDelete}>{t.lists_delete}</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <input type="text" value={editing} maxLength={60} autoFocus aria-label={t.lists_rename} onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} />
          <button type="submit" className="gallery-play">{t.lists_save}</button>
          <button type="button" className="tag-reset" onClick={() => setEditing(null)}>{t.cancel}</button>
        </form>
      )}
    </div>
  );
};

export default ListBar;
