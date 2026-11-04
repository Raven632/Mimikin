import { useEffect, useRef, useState } from 'react';
import { IconPlus } from './icons';

const SAVE_MS = 800;
const MAX = 5000;

// Заметка к игре: где застрял, что делать дальше. Сохраняется сама, пока человек печатает, и при уходе из поля. Окно закрыли
// сразу после набора — допишем при закрытии: иначе последние слова пропали бы молча. Пустая заметка — одна пунктирная кнопка, как «В подборку»:
// поле на каждой игре занимало место, а заметки есть у немногих. Открытое поле остаётся и когда текст стёрли: иначе оно исчезло бы под руками
const GameNotes = ({ game, t, onPatch }) => {
  const [text, setText] = useState(game.notes || '');
  const [open, setOpen] = useState(!!game.notes);
  const saved = useRef(game.notes || '');
  const timer = useRef(0);
  const box = useRef(null);
  const latest = useRef({ text, id: game.id, onPatch });
  useEffect(() => { latest.current = { text, id: game.id, onPatch }; });
  const save = () => {
    clearTimeout(timer.current);
    const { text: now, id, onPatch: patch } = latest.current;
    if (now === saved.current) return;
    saved.current = now;
    patch(id, { notes: now });
  };
  // save читает только ссылки. pagehide — вкладку закрыли или обновили, пока не прошли SAVE_MS
  useEffect(() => {
    window.addEventListener('pagehide', save);
    return () => { window.removeEventListener('pagehide', save); save(); };
  }, []);
  // Поле растёт вместе с текстом: своя прокрутка внутри окна неудобна на телефоне
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text, open]);
  if (!open) {
    return (
      <section className="game-notes">
        <button type="button" className="game-notes-add" onClick={() => setOpen(true)}><IconPlus />{t.notes_add}</button>
      </section>
    );
  }
  return (
    <section className="game-notes">
      <label className="modal-side-title" htmlFor="game-notes-text">{t.notes_label}</label>
      <textarea
        ref={box} id="game-notes-text" rows={2} maxLength={MAX} value={text} placeholder={t.notes_placeholder} autoFocus={!game.notes}
        onChange={(e) => { setText(e.target.value); clearTimeout(timer.current); timer.current = setTimeout(save, SAVE_MS); }}
        onBlur={save}
      />
    </section>
  );
};

export default GameNotes;
