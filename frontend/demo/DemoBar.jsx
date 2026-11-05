import { useEffect, useRef, useState } from 'react';
import { locale, savedLang } from '../src/locales/index.js';
import { useLayer } from '../src/layers.js';
import { startOver } from './startOver.js';
import { barTexts, noteText, noteTitle } from './texts.js';

// Язык страницы меняют в самом приложении (App пишет rpg_lang, потом html lang): полоса и заметка ждут второго
function useLang() {
  const [lang, setLang] = useState(savedLang);
  useEffect(() => {
    const watch = new MutationObserver(() => setLang(savedLang()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => watch.disconnect();
  }, []);
  return lang;
}

// Страница о проекте лежит на уровень выше демо (…/Mimikin/demo/ → …/Mimikin/ru/): адрес считается от самой страницы,
// поэтому не зависит от имени репозитория и от того, под каким адресом выложено демо
const aboutUrl = (lang) => new URL(lang === 'en' ? '../' : `../${lang}/`, document.baseURI).href;

// Знак «Демо» у нижнего края слева: одна маленькая рамка, остальное — под ней. Нажали — над знаком два действия:
// «Начать сначала» (память демо и настройки страницы стираются, страница открывается заново) и «О Mimikin».
// Знак плавает поверх страницы, а не стоит в её потоке: шапка и поле поиска закреплены по верху экрана, и полоса над ними
// сдвинула бы одну от другой (проверено, поле поиска уезжало на высоту полосы)
const Bar = ({ lang }) => {
  const T = barTexts(lang);
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    const key = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      root.current?.querySelector('.demo-mark')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="demo-bar" ref={root}>
      {open && (
        <div className="demo-bar-menu" id="demo-bar-menu">
          <button type="button" className="demo-bar-btn" onClick={startOver}>{T.start}</button>
          <a className="demo-bar-btn" href={aboutUrl(lang)}>{T.about}</a>
        </div>
      )}
      <button type="button" className="demo-mark" aria-expanded={open} aria-controls={open ? 'demo-bar-menu' : undefined} onClick={() => setOpen((v) => !v)}>{T.mark}</button>
    </div>
  );
};

// Заметка «в демо этого нет»: то же окно, что у вопросов приложения (confirm-box), но с одной кнопкой — отвечать нечего.
// Закрывается так же, как они: кнопкой, Escape, касанием мимо окна, жестом «назад»
const Note = ({ what, lang, onClose }) => {
  const ref = useRef(null);
  useLayer(ref, onClose, { focus: '.confirm-ok' });
  return (
    <div className="modal-overlay active pop confirm-overlay" onClick={onClose}>
      <div ref={ref} className="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="demo-note-title"
        aria-describedby="demo-note-text" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h2 id="demo-note-title" className="confirm-title">{noteTitle(lang)}</h2>
        <p id="demo-note-text" className="confirm-text">{noteText(lang, what)}</p>
        <div className="confirm-actions">
          <button type="button" className="confirm-ok" onClick={onClose}>{locale(lang)?.close}</button>
        </div>
      </div>
    </div>
  );
};

// register — ui.js отдаёт сюда функцию «показать заметку», пока страница не успела её вызвать
const DemoUi = ({ register }) => {
  const lang = useLang();
  const [what, setWhat] = useState('');
  useEffect(() => { register(setWhat); return () => register(null); }, [register]);
  return (
    <>
      <Bar lang={lang} />
      {what && <Note key={what} what={what} lang={lang} onClose={() => setWhat('')} />}
    </>
  );
};

export default DemoUi;
