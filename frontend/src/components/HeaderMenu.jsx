import { Fragment, useEffect, useRef, useState } from 'react';
import { IconMore } from './icons';
import PersonMark from './PersonMark';

// Редкие действия — статистика, ревизия, дозагрузка, выход — раньше лежали
// четырьмя кнопками над библиотекой и весили столько же, сколько поиск и фильтры.
// Их место здесь: нажимают их раз в месяц, а место они занимали на каждом экране.
// children — то, что не действие, а настройка или справка: место на диске, язык, «Выйти».
// Они внизу, мелкой строкой, и язык меню не закрывает — видно, что он сменился.
// badge у пункта — число новостей (например, в «Хочу поиграть»); пока меню закрыто,
// о них говорит точка на самой кнопке
// person — кто вошёл: его знак стоит на самой кнопке меню, а в первой строке — знак, имя и роль; нажатие на неё открывает
// «Мой профиль» (onPerson). Без person (страница не узнала, кто вошёл) — прежние три точки
// group у пункта — номер части меню: между частями тонкая черта. Часть только из пунктов телефона: черта после неё тоже только на телефоне.
// onOpen — меню открыли: пункты зависят от данных, которые могли измениться (первое сердечко)
const HeaderMenu = ({ items = [], label, children, person = null, onPerson, onOpen, t }) => {
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
        onClick={() => { if (!open) onOpen?.(); setOpen(v => !v); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-tip={label}
      >
        {person ? <PersonMark person={person} size={32} crown={false} /> : <IconMore />}
      </button>

      {open && (
        <div className="header-menu-list" role="menu">
          {person && (
            <button type="button" className="menu-person" data-tip={t?.set_tab_account} onClick={() => { setOpen(false); onPerson?.(); }}>
              <PersonMark person={person} size={48} />
              <span className="menu-person-text">
                <span className="menu-person-name">{person.name}</span>
                <span className={`menu-person-role${person.isOwner ? ' adm' : ''}`}>{person.isOwner ? t?.role_owner : t?.role_user}</span>
              </span>
            </button>
          )}
          {items.map((item, at) => (
            <Fragment key={item.key}>
            {at > 0 && items[at - 1].group !== item.group && (
              <div role="separator" className={`header-menu-sep${items.filter((x) => x.group === items[at - 1].group).every((x) => x.className === 'mobile-only') ? ' mobile-only' : ''}`} />
            )}
            <button
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
            </Fragment>
          ))}
          {children && <div className="header-menu-extras">{children}</div>}
        </div>
      )}
    </div>
  );
};

export default HeaderMenu;
