import { useRef, useState } from 'react';
import ScenePick from './ScenePick';
import { IconChevronDown } from './icons';

// Выбор из короткого списка в панели плеера сцен и просмотра Live2D — вместо системного <select>: тот раскрывался
// белым списком Windows/Android поверх чёрной панели и на весь экран на телефоне. Кнопка в виде таблетки панели,
// список — тот же чёрный, что у «Смотреть сцену» (ScenePick), над кнопкой. options — [{ value, label }]; для сетки движений
// Live2D — ещё group и cell, а grid передаёт подписи (см. ScenePick).
// Список открывают клик, Enter и стрелка вниз; пробел на кнопке плеер сцен отдаёт реплике (SceneView), а после выбора
// фокус возвращается на кнопку — снимать его таймером не нужно, Tab идёт дальше по панели
const BarChoose = ({ options, value, onChange, label, className = '', grid }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const done = () => setOpen(false);
  const current = options.find((o) => o.value === value) || options[0];
  return (
    <>
      <button ref={ref} type="button" className={`scene-lang bar-choose ${className}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={label} data-tip={label} onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}>
        <span className="bar-choose-name">{current?.label}</span><IconChevronDown />
      </button>
      {open && (
        <ScenePick title={label} current={value} anchor={ref} list={options.map((o) => ({ t: o.label, n: o.value, g: o.group, c: o.cell }))} grid={grid}
          onPick={(n) => { done(); onChange(n); }} onClose={done} />
      )}
    </>
  );
};

export default BarChoose;
