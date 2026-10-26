import { KNOWN_LANGS } from '../knownLangs';

// Выбор языков, которые человек знает: метки-кнопки, можно несколько. Общий для «Настроек» и первого запуска
const KnownLangsPicker = ({ t, value, onChange, disabled }) => (
  <div className="filter-chips known-langs" role="group" aria-label={t.kl_title}>
    {KNOWN_LANGS.map((code) => {
      const on = value.includes(code);
      return (
        <button key={code} type="button" className={`chip${on ? ' active' : ''}`} aria-pressed={on} disabled={disabled}
          onClick={() => onChange(on ? value.filter((x) => x !== code) : [...value, code])}>{t.lang_names[code]}</button>
      );
    })}
  </div>
);

export default KnownLangsPicker;
