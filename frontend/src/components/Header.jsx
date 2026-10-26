import { useRef } from 'react';
import HeaderMenu from './HeaderMenu';
import BrandMark from './BrandMark';
import { mood, sideAt } from '../mimicMood';

const LANGUAGES = [['ru', 'Русский'], ['en', 'English'], ['de', 'Deutsch']];

// Шапка — одна узкая строка, как у Steam, GOG и Jellyfin: знак библиотеки слева, рядом — разделы
// «Главная» и «Библиотека», меню «⋯» справа. Раньше над названием был девиз, по бокам — линии и ромбы:
// около 80px украшения на каждом экране, а под шапкой ещё прилипает панель поиска. Место отдаём играм.
// Язык, место на диске и «Выйти» — мелкой строкой внизу меню «⋯»: нужны редко
// side — что стоит в шапке перед меню «⋯» (значок загрузок JDownloader)
// newsCount — новости «Хочу поиграть» (новая версия, скидка): точкой с числом у вкладки «Новинки»
// onSecret — пятый щелчок по знаку за 2 с (см. mimicMood.click): App выплёвывает обложку и открывает «Во что поиграть?»
// Мимик живой (mimicMood.js): мышь на знаке 160 мс — крышка вверх, над шапкой — глаза к курсору; фокус с клавиатуры
// и палец — сразу. Сторону считаем от середины места знака (.brand-slot), а не от svg с запасом клеток
const Header = ({ currentLang, onLangChange, t, menuItems, onLogout, view, onView, onSecret, libraryCount = 0, newsCount = 0, side, children }) => {
  const slot = useRef(null);
  const mouse = (e) => e.pointerType === 'mouse';
  return (
    <header
      onPointerMove={(e) => { if (mouse(e)) mood.look(e.target.closest('.brand') ? null : sideAt(e.clientX, slot.current)); }}
      onPointerLeave={(e) => { if (mouse(e)) mood.look(null); }}
    >
      <div className="header-inner">
        {/* Знак с названием — на главную, как на любом сайте */}
        <a className="brand" href="./" data-tip={onView ? t.nav_home : t.subtitle}
          onPointerEnter={(e) => { if (mouse(e)) mood.hover(sideAt(e.clientX, slot.current)); }}
          onPointerMove={(e) => { if (mouse(e)) mood.hover(sideAt(e.clientX, slot.current)); }}
          onPointerLeave={(e) => (mouse(e) ? mood.hover(e.currentTarget.matches(':focus-visible') ? 0 : null) : mood.hoverNow(null))}
          onPointerDown={(e) => { mood.press(); if (!mouse(e)) mood.hoverNow(0); }}
          onPointerUp={(e) => { if (!mouse(e)) mood.hoverNow(null); }}
          onPointerCancel={() => mood.hoverNow(null)}
          onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) mood.hoverNow(0); }}
          onBlur={() => mood.hoverNow(null)}
          onClick={(e) => {
            if (!onView) return;
            e.preventDefault();
            onView('home');
            if (mood.click()) onSecret?.();
          }}>
          <span className="brand-slot" ref={slot}><BrandMark size={32} live /></span>
          <h1 className="brand-title">Mimikin</h1>
        </a>

        {onView && (
          <nav className="main-nav" aria-label={t.nav_label}>
            {[['home', t.nav_home, t.nav_home_hint], ['library', t.nav_library, t.nav_library_hint], ['new', t.nav_new, t.nav_new_hint]].map(([key, label, hint]) => (
              <button
                key={key}
                type="button"
                className={`nav-tab${view === key ? ' active' : ''}`}
                data-tip={hint}
                aria-current={view === key ? 'page' : undefined}
                onClick={() => onView(key)}
              >
                {label}
                {key === 'library' && libraryCount > 0 && <span className="nav-count">{libraryCount}</span>}
                {key === 'new' && newsCount > 0 && <span className="nav-count nav-news" data-tip={t.nav_new_news(newsCount)}>{newsCount}</span>}
              </button>
            ))}
          </nav>
        )}

        <div className="header-side">
          {side}
          <HeaderMenu items={menuItems} label={t.menu_more}>
            {children}
            <div className="menu-footer-row">
              <div className="menu-langs" role="group" aria-label={t.menu_language}>
                {LANGUAGES.map(([code, name]) => (
                  <button
                    key={code}
                    type="button"
                    className={`menu-lang ${currentLang === code ? 'active' : ''}`}
                    aria-pressed={currentLang === code}
                    aria-label={name}
                    data-tip={name}
                    onClick={() => onLangChange(code)}
                  >
                    {code.toUpperCase()}
                  </button>
                ))}
              </div>
              {onLogout && <button type="button" className="menu-logout" onClick={onLogout}>{t.logout}</button>}
            </div>
          </HeaderMenu>
        </div>
      </div>
    </header>
  );
};

export default Header;
