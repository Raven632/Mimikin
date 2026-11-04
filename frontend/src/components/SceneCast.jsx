import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFadeEdges } from '../fadeEdges';

// Кто в сцене: ряд имён над плитками «Сцен» и «Диалогов» (сервер: services/sceneCast.js). Первым — «Все N», дальше имена
// с числом сцен; выбрать можно одно, второе нажатие на выбранное — снова все. Как «Все N» и чипы игр в «Избранном».
// На компьютере — столько имён, сколько влезает в одну строку вместе с «Ещё N» (раскрывает ряд с переносом); на
// телефоне — одна лента с прокруткой и затуханием краёв, как у статусов в библиотеке. Выбранное имя видно всегда, даже за «Ещё»
// Длиннее — обрезано многоточием (CSS), полное имя — в подсказке
const LONG = 16;

// Сколько первых имён помещается в строку шириной W: «Все», имена, а если влезли не все — «Ещё N» и выбранное из скрытых
const fitCount = ({ W, gap, all, more, widths }, value) => {
  const row = (k) => all + widths.slice(0, k).reduce((sum, w) => sum + gap + w, 0)
    + (k < widths.length ? gap + more + (value !== null && value >= k ? gap + widths[value] : 0) : 0);
  let k = widths.length;
  while (k > 0 && row(k) > W) k--;
  return k;
};

const SceneCast = ({ names, total, value, onChange, t }) => {
  const s = t.scene_list;
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  // Ширины чипов этих имён; нет — меряем: один проход с каждым чипом в строку без переноса, до показа (useLayoutEffect)
  const [measured, setMeasured] = useState(null);
  const sizes = measured?.names === names ? measured : null;
  useFadeEdges(ref, [names, open]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (!sizes) {
      const chips = [...el.children].map((c) => c.offsetWidth);
      setMeasured({ names, W: el.clientWidth, gap: parseFloat(getComputedStyle(el).columnGap) || 0, all: chips[0], more: chips.at(-1), widths: chips.slice(1, -1) });
      return undefined;
    }
    // Окно стало шире или уже — меряем заново
    const resize = new ResizeObserver(() => { if (el.clientWidth !== sizes.W) setMeasured(null); });
    resize.observe(el);
    return () => resize.disconnect();
  }, [sizes, names]);
  // Шрифт догрузился после замера — чипы стали другой ширины, а ряд нет: меряем заново
  useEffect(() => {
    if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(() => setMeasured(null));
  }, []);
  const first = sizes ? fitCount(sizes, value) : names.length;
  const hidden = open ? 0 : names.filter((_, i) => i >= first && i !== value).length;
  return (
    <div ref={ref} className={`gallery-cast${open ? ' open' : ''}${sizes ? '' : ' measure'}`} role="group" aria-label={s.cast}>
      <button type="button" className={`chip${value === null ? ' active' : ''}`} aria-pressed={value === null} onClick={() => onChange(null)}>
        {t.filter_all}<span className="chip-count">{total}</span>
      </button>
      {names.map(([name, n], i) => (
        <button key={name} type="button" className={`chip${value === i ? ' active' : ''}${i >= first && !open && value !== i ? ' cast-extra' : ''}`}
          aria-pressed={value === i} data-tip={Array.from(name).length > LONG ? name : undefined}
          onClick={() => onChange(value === i ? null : i)}>
          <span className="cast-name">{name}</span><span className="chip-count">{n}</span>
        </button>
      ))}
      {(hidden > 0 || open || !sizes) && (
        <button type="button" className="chip cast-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? s.cast_less : s.cast_more(sizes ? hidden : names.length)}
        </button>
      )}
    </div>
  );
};

export default SceneCast;
