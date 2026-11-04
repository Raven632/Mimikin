import { useEffect, useRef, useState } from 'react';
import { useLayer } from '../layers';
import { IconClose, IconPlus } from './icons';

// Свои подборки в окне игры: строка в сведениях. Имя ведёт в библиотеку с этой подборкой, крестик убирает игру из неё, «+» —
// список всех подборок и поле для новой. Новая с именем уже существующей (без учёта регистра) — та же самая, а не вторая
const GameLists = ({ game, all, t, onPatch, onOpen }) => {
  const mine = game.lists || [];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const root = useRef(null);
  const panel = useRef(null);
  useLayer(panel, () => setOpen(false), { active: open, history: false, modal: false, trap: false });
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const set = (list) => onPatch(game.id, { lists: list });
  const toggle = (x) => set(mine.includes(x) ? mine.filter((y) => y !== x) : [...mine, x]);
  const add = (e) => {
    e.preventDefault();
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    const known = all.find((x) => x.toLowerCase() === clean.toLowerCase()) || clean;
    if (!mine.includes(known)) set([...mine, known]);
    setName('');
  };
  return (
    <div className="modal-fact game-lists" ref={root}>
      <span className="modal-fact-label">{t.lists_label}</span>
      <div className="modal-fact-value">
        {mine.map((x) => (
          <span key={x} className="game-list-chip">
            <button type="button" className="game-list-name" onClick={() => onOpen(x)}>{x}</button>
            <button type="button" className="game-list-off" onClick={() => toggle(x)} aria-label={t.lists_remove(x)} data-tip={t.lists_remove(x)}><IconClose /></button>
          </span>
        ))}
        <button type="button" className="game-list-add" aria-expanded={open} onClick={() => setOpen((v) => !v)}><IconPlus />{mine.length ? '' : t.lists_add}</button>
        {open && (
          <div ref={panel} className="game-list-panel" tabIndex={-1}>
            {all.map((x) => (
              <label key={x} className="catalog-check game-list-row">
                <input type="checkbox" checked={mine.includes(x)} onChange={() => toggle(x)} />
                <span>{x}</span>
              </label>
            ))}
            <form className="game-list-new" onSubmit={add}>
              <input type="text" value={name} maxLength={60} autoFocus placeholder={t.lists_new} aria-label={t.lists_new} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className="gallery-play" disabled={!name.trim()}>{t.lists_create}</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};

export default GameLists;
