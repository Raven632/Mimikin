import { useEffect, useId, useMemo, useRef, useState } from 'react';

// Выпадающий список в стиле библиотеки — для жанров, языков и сортировки.
// Системный <select> у жанров раскрывался на весь экран (около сотни строк без
// поиска), а у каждой платформы он ещё и свой: три списка в одной строке выглядели
// по-разному. Этот одинаковый везде.
// searchable — поле поиска сверху: нужно, где вариантов много (жанры). У коротких
// списков его нет, стрелками и Enter управляет сам список.
// Первый вариант («Все жанры», «Все языки») остаётся при любом поиске — им сбрасывают выбор.
const Picker = ({
  options, value, onChange, label,
  searchable = false, searchPlaceholder = '', emptyText = '',
  highlight = false, className = '', disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [alignRight, setAlignRight] = useState(false);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const id = useId();

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? options.filter((o, i) => i === 0 || o.label.toLowerCase().includes(q)) : options),
    [options, q]
  );
  const current = options.find(o => o.value === value);

  const openPicker = () => {
    setQuery('');
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    // У правого края окошко раскрываем влево, иначе на телефоне оно уедет за экран
    const r = buttonRef.current?.getBoundingClientRect();
    setAlignRight(!!r && r.left > window.innerWidth / 2);
    setOpen(true);
  };
  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (v) => {
    onChange(v);
    close(true);
  };

  // Без поля поиска клавиши слушает сам список — ему и фокус
  useEffect(() => {
    if (open && !searchable) listRef.current?.focus();
  }, [open, searchable]);

  // Строка под стрелками всегда в видимой части списка
  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') setActive(i => Math.min(i + 1, shown.length - 1));
    else if (e.key === 'ArrowUp') setActive(i => Math.max(i - 1, 0));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(shown.length - 1);
    else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) { if (shown[active]) choose(shown[active].value); }
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') { close(); return; }
    else return;
    e.preventDefault();
  };

  const optionId = (i) => `${id}-opt-${i}`;

  return (
    <div className={`picker ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        className={`sort-box picker-btn ${highlight ? 'has-value' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : openPicker())}
      >
        {current?.label}
      </button>

      {/* Клик мимо окошка только закрывает его — как у системного списка. Без подложки
          тот же клик проходил дальше и открывал игру, на которую пришёлся */}
      {open && <div className="picker-backdrop" onClick={() => close()} />}

      {open && (
        <div className={`picker-pop ${alignRight ? 'right' : ''}`}>
          {searchable && (
            <input
              className="picker-search"
              type="text"
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={optionId(active)}
              placeholder={searchPlaceholder}
              value={query}
              // Набрали — под стрелкой первое совпадение, а не «Все…» сверху: иначе
              // Enter после набора сбрасывал выбор вместо того, чтобы выбрать найденное
              onChange={(e) => { setQuery(e.target.value); setActive(e.target.value.trim() ? 1 : 0); }}
              onKeyDown={onKeyDown}
            />
          )}
          <ul
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            className="picker-list"
            ref={listRef}
            tabIndex={searchable ? undefined : -1}
            aria-activedescendant={searchable ? undefined : optionId(active)}
            onKeyDown={searchable ? undefined : onKeyDown}
          >
            {shown.map((o, i) => (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={value === o.value}
                // group — подпись группы над первым её вариантом (например, «Формат» в жанрах)
                className={`picker-opt${i === active ? ' active' : ''}${value === o.value ? ' selected' : ''}${o.group ? ' group-start' : ''}`}
                data-group={o.group || undefined}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o.value)}
              >
                <span className="picker-name">{o.label}</span>
                {o.count != null && <span className="picker-count">{o.count}</span>}
              </li>
            ))}
            {q && shown.length <= 1 && <li className="picker-empty">{emptyText}</li>}
          </ul>
        </div>
      )}
    </div>
  );
};

export default Picker;
