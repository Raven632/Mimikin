import { useEffect, useRef, useState } from 'react';
import { IconMore } from './icons';

// Редкие действия — статистика, ревизия, дозагрузка, выход — раньше лежали
// четырьмя кнопками над библиотекой и весили столько же, сколько поиск и фильтры.
// Их место здесь: нажимают их раз в месяц, а место они занимали на каждом экране.
// children — то, что не действие, а настройка или справка: место на диске, язык, «Выйти».
// Они внизу, мелкой строкой, и язык меню не закрывает — видно, что он сменился.
// badge у пункта — число новостей (например, в «Хочу поиграть»); пока меню закрыто,
// о них говорит точка на самой кнопке
const HeaderMenu = ({ items = [], label, children }) => {
  const [open, setOpen] = useState(false);
  const news = items.some(item => item.badge);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // Закрываем по клику мимо и по Escape — иначе меню остаётся висеть
    // поверх страницы, когда человек передумал
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="header-menu" ref={boxRef}>
      <button
        type="button"
        className={`header-menu-btn ${open ? 'active' : ''}${news ? ' has-news' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-tip={label}
      >
        <IconMore />
      </button>

      {open && (
        <div className="header-menu-list" role="menu">
          {items.map(item => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              // Пояснение к пункту — подсказкой при наведении, а не второй строкой крупнее самой подписи
              data-tip={item.hint || undefined}
              className={`header-menu-item ${item.className || ''}`}
              onClick={() => { setOpen(false); item.onClick(); }}
            >
              <span className="header-menu-icon">{item.icon}</span>
              <span className="header-menu-text">
                {item.label}
              </span>
              {item.badge ? <span className="header-menu-badge">{item.badge}</span> : null}
            </button>
          ))}
          {children && <div className="header-menu-extras">{children}</div>}
        </div>
      )}
    </div>
  );
};

export default HeaderMenu;
