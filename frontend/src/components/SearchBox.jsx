import { useRef } from 'react';
import { IconClose, IconSearch } from './icons';

// Поле поиска — в библиотеке и в «Новинках»: значок слева, крестик «очистить» справа, когда есть
// что очищать (на телефоне раньше стирали по букве). Escape в поле тоже очищает — и только его:
// окно вокруг не закрывается (preventDefault — знак стопке слоёв, layers.js)
const SearchBox = ({ value, onChange, placeholder, clearLabel, maxLength, inputRef, keyHint }) => {
  const ownRef = useRef(null);
  const ref = inputRef || ownRef;
  return (
    <div className={`search-box${value ? ' has-value' : ''}`}>
      <span className="search-icon" aria-hidden="true"><IconSearch /></span>
      <input
        ref={ref}
        type="text"
        placeholder={placeholder}
        aria-label={placeholder}
        aria-keyshortcuts={keyHint}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); }
        }}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          aria-label={clearLabel}
          data-tip={clearLabel}
          onClick={() => { onChange(''); ref.current?.focus(); }}
        ><IconClose /></button>
      )}
    </div>
  );
};

export default SearchBox;
