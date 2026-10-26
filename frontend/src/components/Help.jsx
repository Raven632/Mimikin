import { useHelp } from '../useHelp';

// Тихий «?» вместо пояснений на виду: тонкий знак без кольца и подложки, тусклый; золотеет
// на наведении, фокусе и когда пояснение открыто. Открытое пояснение встаёт строкой под
// подписью (не всплывающим окном), закрывается вторым нажатием или Esc на самом знаке.
export function HelpMark({ help, t, className = '' }) {
  return (
    <button
      type="button" className={`help-mark${help.open ? ' on' : ''}${className ? ` ${className}` : ''}`}
      aria-expanded={help.open} aria-controls={help.open ? help.id : undefined} aria-label={t.help_label}
      onClick={help.toggle}
      // Esc закрывает только пояснение: окно вокруг (настройки, галерея) остаётся
      onKeyDown={(e) => { if (e.key === 'Escape' && help.open) { e.stopPropagation(); help.close(); } }}
    >
      <svg viewBox="4.5 4 15 15.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8.8 9.2a3.2 3.2 0 1 1 4.6 2.9c-.9.5-1.4 1.1-1.4 2" />
        <path d="M12 18.2h.01" />
      </svg>
    </button>
  );
}

// Название раздела с «?» и пояснением под ним (заголовки окон настроек)
export default function HelpTitle({ t, title, hint, className = 'set-title', tag: Tag = 'h3', hintClass = 'set-hint' }) {
  const help = useHelp();
  return (
    <>
      <Tag className={className}>{title}<HelpMark help={help} t={t} /></Tag>
      {help.open && <p className={hintClass} id={help.id}>{hint}</p>}
    </>
  );
}
