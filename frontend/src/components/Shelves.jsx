import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCoverUrl } from '../coverUrl';
import { formatPlaytime } from '../formatPlaytime';
import { timeAgo } from '../formatAgo';
import { effectiveStatus } from '../gameStatus';
import { landingBusy } from '../landing';
import { pageZoom } from '../pageZoom';
import { flightFrom } from '../windowFly';
import MetaLine from './MetaLine';
import { useShelfHead } from '../shelfHead';
import { IconLists, IconChevronLeft, IconChevronRight, IconDice, IconNotStarted, IconChest, IconPlay } from './icons';

// Откуда лететь окну и «Играть»: обложка этой плитки (windowFly.js)
const coverFrom = (card) => flightFrom(card.querySelector('.shelf-cover img'));

// На полке — шесть: на компьютере они встают в ряд целиком, без обрезанной седьмой у края;
// остальное — по «Все» в библиотеке
const PER_SHELF = 6;
// «Не начаты» первыми: сыгранное — рядом, в сцене и списке над полкой. Но в новой библиотеке, где ещё ни во что не
// играли, первой открывается «Добавленные» — только что загруженные игры, а не все подряд «не начатые» (issue #17)
const TABS = ['unplayed', 'added'];
const TABS_NEW = ['added', 'unplayed'];
const TAB_ICONS = { unplayed: IconNotStarted, added: IconChest };

// Какая подборка «Что дальше» была открыта — с неё и в следующий раз
const savedTab = () => {
  try {
    return localStorage.getItem('rpg_shelf') || '';
  } catch {
    return '';
  }
};

// Полка — лента карточек с прокруткой вбок. На компьютере листают стрелками (они есть, только когда
// лента не помещается), на телефоне пальцем. Над лентой — переключатель подборок, как у «Найти»: у каждой
// свой значок; на телефоне у невыбранных — только значок и число, чтобы все встали в ряд.
// Карточка открывает окно игры, «Играть» при наведении — запускает сразу. «Все» — та же подборка
// целиком, в библиотеке. extra — кнопка в шапке рядом со «Все»
const Shelf = ({ title, tabs, active, onTab, items, note, t, onOpen, onPlay, onShowAll, extra, landed }) => {
  const rowRef = useRef(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    // Другая подборка — с начала ленты
    row.scrollLeft = 0;
    const observer = new ResizeObserver(() => setOverflow(row.scrollWidth > row.clientWidth + 1));
    observer.observe(row);
    return () => observer.disconnect();
  }, [items.length, active]);
  const scroll = (dir) => rowRef.current?.scrollBy({ left: dir * rowRef.current.clientWidth * 0.8, behavior: 'smooth' });
  // Шапка раскладывается по месту (shelfHead.js); пересчёт — когда меняются подписи, числа и стрелки
  const { headRef, chipsRef, layout } = useShelfHead([tabs.map((x) => `${x.key}:${x.label}:${x.count}`).join('|'), active, overflow, !!extra], { canCompact: true });
  return (
    <section className="shelf switch-shelf" aria-label={title}>
      <div className="shelf-head" ref={headRef} data-layout={layout}>
        <div className="hot-title-row">
          <h2 className="shelf-title">{title}</h2>
          <div className="shelf-tabs" role="group" aria-label={title} ref={chipsRef}>
            {tabs.map(({ key, label, count }) => {
              const TabIcon = TAB_ICONS[key] || IconLists;   // свои подборки — один значок на все
              return (
                <button key={key} type="button"
                  className={`chip shelf-tab${key === active ? ' active' : ''}`}
                  aria-pressed={key === active} aria-label={count > 0 ? `${label}: ${count}` : label} onClick={() => onTab(key)}>
                  <TabIcon />
                  <span className="shelf-tab-label">{label}</span>
                  {count > 0 && <span className="chip-count">{count}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="shelf-tools">
          {extra}
          {overflow && (
            <div className="shelf-arrows">
              <button type="button" className="shelf-arrow" aria-label={t.shelf_prev} onClick={() => scroll(-1)}><IconChevronLeft /></button>
              <button type="button" className="shelf-arrow" aria-label={t.shelf_next} onClick={() => scroll(1)}><IconChevronRight /></button>
            </div>
          )}
          <button type="button" className="shelf-all" onClick={onShowAll}>{t.shelf_see_all}</button>
        </div>
      </div>
      <div className="shelf-row" ref={rowRef}>
        {items.map((game) => {
          const cover = getCoverUrl(game);
          const name = game.displayTitle || game.title;
          const text = note(game);
          return (
            <div key={game.id} data-id={game.id} className={`shelf-card${landed?.includes(game.id) ? ' landed' : ''}`} role="button" tabIndex={0} onClick={(e) => onOpen(game, coverFrom(e.currentTarget))}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(game, coverFrom(e.currentTarget)); } }}>
              <div className="shelf-cover">
                {cover ? <img src={cover} alt="" loading="lazy" onLoad={(e) => e.currentTarget.classList.add('loaded')} /> : <span className="shelf-empty">RPG</span>}
                <button type="button" className="card-play" tabIndex={-1} aria-hidden="true" data-tip={t.play}
                  onClick={(e) => { e.stopPropagation(); onPlay(game, coverFrom(e.currentTarget.closest('.shelf-card'))); }}>
                  <IconPlay />
                </button>
              </div>
              <div className="shelf-name" data-tip={name}>{name}</div>
              <MetaLine className="shelf-note" parts={[text]} />
            </div>
          );
        })}
      </div>
    </section>
  );
};

// «Что дальше» на главной — одна полка с переключателем: не начатые, недавно добавленные, свои
// подборки. Было четыре полки друг под другом — пять рядов обложек, и глаза разбегались.
// Подборка без игр не показывается; выбранная запоминается. Сыгранное — над полкой: сцена и «Недавно играли»
// (App.jsx). Запомненная когда-то вкладка 'played' теперь просто не находится — откроется первая
const Shelves = ({ games: allGames, t, lang, onOpen, onPlay, onShowAll, onRandom }) => {
  const [chosen, setChosen] = useState(savedTab);
  const rootRef = useRef(null);
  // Игра из загрузки с плашкой встаёт на полку после финала плашки (landing.js): пока загрузка идёт, новые игры
  // придерживаем. known — что уже стояло или вправе появиться сразу (пришло без плашки: папка на сервере,
  // другое устройство); всё, чего в known нет, придержано до события rpg-landed
  const [known, setKnown] = useState(() => new Set(allGames.map((g) => g.id)));
  const held = allGames.filter((g) => !known.has(g.id));
  if (held.length && !landingBusy()) setKnown(new Set(allGames.map((g) => g.id)));
  const games = held.length ? allGames.filter((g) => known.has(g.id)) : allGames;
  // landing — только что севшие игры и где стояли карточки до этого: по ним двигаем соседей (FLIP) и рисуем рамку
  const [landing, setLanding] = useState(null);
  const latest = useRef({ allGames, known });
  useEffect(() => { latest.current = { allGames, known }; });
  const release = useCallback(() => {
    const { allGames: all, known: was } = latest.current;
    const ids = all.filter((g) => !was.has(g.id)).map((g) => g.id);
    if (!ids.length) return;
    const before = new Map([...(rootRef.current?.querySelectorAll('.shelf-card') || [])].map((el) => [el.dataset.id, el.getBoundingClientRect().left]));
    setKnown(new Set(all.map((g) => g.id)));
    setLanding({ ids, before });
  }, []);
  useEffect(() => {
    window.addEventListener('rpg-landed', release);
    return () => window.removeEventListener('rpg-landed', release);
  }, [release]);
  // Подстраховка: событие финала не пришло (вкладка уснула, загрузку оборвали) — игру не прячем дольше 10 с
  const heldCount = held.length;
  useEffect(() => {
    if (!heldCount) return undefined;
    const timer = setTimeout(release, 10000);
    return () => clearTimeout(timer);
  }, [heldCount, release]);
  // Соседи сдвигаются на 200 мс по --ease-out — только transform и только если новая игра видна в открытой
  // подборке: иначе полка стоит. Новая обложка в эти 200 мс прозрачна (library.css, .landed), потом рамка
  useLayoutEffect(() => {
    if (!landing) return undefined;
    const cards = [...(rootRef.current?.querySelectorAll('.shelf-card') || [])];
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Лента на телефоне листается вбок со scroll-snap: новая карточка встаёт первой, и Chrome прищёлкивает ленту к
    // прежней первой — новая оказывается за левым краем. Возвращаем ленту в начало до замера
    for (const el of cards) if (landing.ids.includes(el.dataset.id)) el.closest('.shelf-row')?.scrollTo({ left: 0, behavior: 'instant' });
    if (!calm && cards.some((el) => landing.ids.includes(el.dataset.id))) {
      const zoom = pageZoom();
      for (const el of cards) {
        const was = landing.before.get(el.dataset.id);
        if (was == null) continue;
        const dx = (was - el.getBoundingClientRect().left) / zoom;
        if (Math.abs(dx) >= 0.5) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: 200, easing: 'cubic-bezier(.2, 0, 0, 1)' });
      }
    }
    const timer = setTimeout(() => setLanding(null), 900);
    return () => clearTimeout(timer);
  }, [landing]);
  // Не начатые — их обычно больше половины; те же, что у статуса «Не начата» в библиотеке
  // («В планах» — у себя). Первыми — новые
  const unplayedAll = games.filter((g) => effectiveStatus(g) === 'new');
  const unplayed = [...unplayedAll].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, PER_SHELF);
  const lists = {
    unplayed: {
      label: t.tab_unplayed, count: unplayedAll.length, items: unplayed,
      note: (g) => timeAgo(g.addedAt, lang),
    },
    added: {
      label: t.tab_added,
      items: games.filter((g) => g.addedAt).sort((a, b) => b.addedAt - a.addedAt).slice(0, PER_SHELF),
      note: (g) => timeAgo(g.addedAt, lang),
    },
  };
  // Свои подборки — такие же вкладки, после готовых
  const recent = (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.addedAt || 0) - (a.addedAt || 0);
  const own = [...new Set(games.flatMap((g) => g.lists || []))].sort((a, b) => a.localeCompare(b));
  for (const name of own) {
    const all = games.filter((g) => g.lists?.includes(name));
    lists[`list:${name}`] = { label: name, count: all.length, items: [...all].sort(recent).slice(0, PER_SHELF), note: (g) => formatPlaytime(g.playtime, t) || timeAgo(g.addedAt, lang) };
  }
  const tabs = [...(games.some((g) => g.lastPlayed) ? TABS : TABS_NEW), ...own.map((x) => `list:${x}`)].filter((key) => lists[key].items.length).map((key) => ({ key, label: lists[key].label, count: lists[key].count }));
  if (!tabs.length) return null;
  const active = tabs.some((tab) => tab.key === chosen) ? chosen : tabs[0].key;
  const choose = (key) => {
    setChosen(key);
    try { localStorage.setItem('rpg_shelf', key); } catch { /* приватный режим — просто не запомним */ }
  };
  const { items, note } = lists[active];
  // «Во что поиграть?» — на любой вкладке: вопрос не зависит от того, какая подборка открыта. Сам выбор — из игр на диске.
  // Кнопка — когда не начатых много и выбрать трудно (порог как в «Найти»); пункт меню есть, пока есть из чего выбирать
  const random = unplayedAll.length >= 10 && onRandom;
  return (
    <div className="shelves" ref={rootRef}>
      <Shelf title={t.shelf_next_up} tabs={tabs} active={active} onTab={choose} items={items} note={note} landed={landing?.ids}
        t={t} onOpen={onOpen} onPlay={onPlay} onShowAll={() => onShowAll(active)}
        extra={random && (
          <button type="button" className="shelf-all shelf-random" onClick={onRandom} aria-label={t.shelf_random} data-tip={t.menu_pick_hint}>
            <IconDice /><span className="shelf-random-text">{t.shelf_random}</span>
          </button>
        )} />
    </div>
  );
};

export default Shelves;
