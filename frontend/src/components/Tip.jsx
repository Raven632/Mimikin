import { useEffect, useRef, useState } from 'react';

// Своя подсказка вместо системной title=: одна на всё приложение, читает data-tip
// у ближайшего предка. Системная плашка на Windows светло-серая и приходит через секунду,
// на телефоне её нет совсем, а клавишу в ней не выделить.
// Мышь — через 0,3 с; клавиатура — сразу на фокусе. Касанием не показываем: там работают
// подписи на самих кнопках.
const DELAY = 300;
// «(клавиша H)», «(H key)», «(Taste H)» в конце текста выносим в отдельную клавишу
const KEY_AT_END = /\s*\((?:клавиша|key|Taste)\s+([^)]+)\)\s*$|\s*\(([^)\s]+)\s+key\)\s*$/i;

const split = (text) => {
  const m = KEY_AT_END.exec(text);
  return m ? { text: text.slice(0, m.index), key: m[1] || m[2] } : { text, key: '' };
};

// Старые title= не трогаем в коде: при первом наведении переносим в data-tip, пока системная
// подсказка ещё не показалась, и она не дублирует нашу
const tipTarget = (node) => {
  if (!(node instanceof Element)) return null;
  const el = node.closest('[data-tip], [title]');
  if (!el || el.tagName === 'IFRAME') return null;
  if (!el.hasAttribute('data-tip')) {
    el.setAttribute('data-tip', el.getAttribute('title'));
  }
  el.removeAttribute('title');
  return el.getAttribute('data-tip') ? el : null;
};

const Tip = () => {
  const [tip, setTip] = useState(null); // { text, key, x, y, above }
  const box = useRef(null);
  const timer = useRef(0);
  const current = useRef(null);

  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const show = (el) => {
      if (!el.isConnected || current.current !== el) return;
      const { text, key } = split(el.getAttribute('data-tip') || '');
      if (!text) return;
      const r = el.getBoundingClientRect();
      setTip({ text, key, cx: r.left + r.width / 2, top: r.bottom, bottom: r.top });
    };
    const over = (e) => {
      if (e.pointerType === 'touch' || !window.matchMedia('(hover: hover)').matches) return;
      const el = tipTarget(e.target);
      if (!el || el === current.current) return;
      hide();
      current.current = el; // уже «ждёт», чтобы pointerout внутри кнопки не сбрасывал отсчёт
      timer.current = setTimeout(() => show(el), DELAY);
    };
    const out = (e) => {
      if (current.current && !current.current.contains(e.relatedTarget)) hide();
    };
    const focus = (e) => {
      const el = tipTarget(e.target);
      // Только клавиатурный фокус: после щелчка мышью кнопка тоже в фокусе, подсказка мешала бы
      if (el && el.matches(':focus-visible')) { hide(); show(el); }
    };
    const key = (e) => { if (e.key === 'Escape' && current.current) hide(); };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Позицию считаем по размеру самой плашки: прижимаем к краям окна и ставим над кнопкой,
  // если снизу не помещается (панель просмотра лежит у нижнего края)
  useEffect(() => {
    const el = box.current;
    if (!tip || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(8, tip.cx - w / 2), window.innerWidth - w - 8);
    const below = tip.top + 8 + h <= window.innerHeight - 8;
    el.style.left = `${left}px`;
    el.style.top = `${below ? tip.top + 8 : Math.max(8, tip.bottom - 8 - h)}px`;
    el.style.visibility = 'visible';
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} className="tip" role="tooltip" style={{ visibility: 'hidden' }}>
      <span>{tip.text}</span>
      {tip.key && <kbd>{tip.key}</kbd>}
    </div>
  );
};

export default Tip;
