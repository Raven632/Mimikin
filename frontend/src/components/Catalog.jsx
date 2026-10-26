import { useEffect, useRef, useState } from 'react';
import { useLayer } from '../layers';
import { useClosing } from '../useClosing';
import Picker from './Picker';
import { timeAgo } from '../formatAgo';
import { IconStar, IconClose, IconArrowLeft, IconGrid, IconRows, IconSliders, IconStarSolid, IconPlus } from './icons';
import StateView from './StateView';
import { flash } from '../pulse';
import { catalogItem, fmtCount } from '../catalogItems';
import { fitWide } from '../coverUrl';
import MetaLine from './MetaLine';
import { HelpMark } from './Help';

const options = (list) => list.map(([value, label]) => ({ value, label }));
// «Хочу поиграть»: недавно отложенные — первыми
const sortWish = (list) => [...list].sort((a, b) => b.addedAt - a.addedAt);
// Запись списка — в вид карточки новинок: то, что показывало окно, плюс ключ и «в библиотеке»
const wishItem = (e) => ({ ...e.info, source: e.source, key: e.key, url: e.url, game: e.game });

// Новинки игр на RPG Maker с itch.io: свежие, популярные, со скидкой, по тегам. Показывает, что
// из этого уже есть в библиотеке. Скачивать — на самом itch.io.
// Понравившееся откладывают звёздочкой в «Хочу поиграть» — это вторая вкладка.
// initialSource — с какой вкладки открыть: itch | list
// asPage — «Новинки» страницей (вкладка в шапке рядом с «Главной» и «Библиотекой»), а не окном поверх: без крестика
// и затемнения, «назад» закрывает только открытую игру
const Catalog = ({ t, lang, initialSource = 'itch', wishlist = [], onWishAdd, onWishRemove, onClose, onOpenGame, asPage = false }) => {
  const [source, setSource] = useState(initialSource);   // itch | list
  const [itchSort, setItchSort] = useState('popular');
  const [itchDays, setItchDays] = useState(0);
  const [itchPrice, setItchPrice] = useState('');
  const [itchPlatform, setItchPlatform] = useState('');
  const [itchTags, setItchTags] = useState([]);
  const [itchMeta, setItchMeta] = useState({ tags: [], details: false });
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [state, setState] = useState(initialSource === 'list' ? 'ready' : 'loading');   // loading | more | ready | error | limited
  // «Хочу поиграть» снимаем, когда открыли вкладку: убранная звёздочкой игра остаётся на месте
  // до ухода с вкладки — её можно вернуть той же звёздочкой
  const [listSnap, setListSnap] = useState(() => (initialSource === 'list' ? sortWish(wishlist) : []));
  const [open, setOpen] = useState(null);            // игра в подробном просмотре
  const [shot, setShot] = useState(0);               // какая картинка там крупно: 0 — обложка
  const [details, setDetails] = useState(null);      // страница игры: null — ещё нет, false — не открылась
  // «Скрыть мои»: игр, что уже в библиотеке, в выдаче не показываем — помним на этом устройстве
  const [hideOwned, setHideOwned] = useState(() => { try { return localStorage.getItem('mimikin.catalog.hideOwned') === '1'; } catch { return false; } });
  const toggleHideOwned = () => setHideOwned((v) => { try { localStorage.setItem('mimikin.catalog.hideOwned', v ? '0' : '1'); } catch { /* приватный режим */ } return !v; });
  // Сеткой (обложки крупно) или списком (строка на игру, как поиск Steam) — помним на этом устройстве
  const [view, setView] = useState(() => { try { return localStorage.getItem('mimikin.catalog.view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } });
  const pickView = (v) => { setView(v); try { localStorage.setItem('mimikin.catalog.view', v); } catch { /* приватный режим */ } };
  // Пояснение к источнику видно, пока его не закроют «?»; закрыли — помним, и над сеткой место для игр
  const [help, setHelp] = useState(() => { try { return localStorage.getItem('mimikin.catalog.hint') !== 'off'; } catch { return true; } });
  const toggleHelp = () => setHelp((v) => { try { localStorage.setItem('mimikin.catalog.hint', v ? 'off' : 'on'); } catch { /* приватный режим */ } return !v; });
  const request = useRef(0);
  const lastPage = useRef(1);

  useEffect(() => {
    let alive = true;
    fetch('/api/itch/meta').then(r => r.json()).then(d => { if (alive) setItchMeta(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Адрес страницы выдачи при нынешних фильтрах
  const pageUrl = (nextPage) => {
    const params = new URLSearchParams({ page: nextPage, sort: itchSort });
    if (itchDays) params.set('days', itchDays);
    if (itchPrice) params.set('price', itchPrice);
    if (itchPlatform === 'web') params.set('web', '1');
    if (itchTags.length) params.set('tags', itchTags.join(','));
    return `/api/itch/latest?${params}`;
  };

  // Запрос страницы. Состояние не трогает — только возвращает ответ: data или fail
  const requestPage = async (nextPage) => {
    try {
      const res = await fetch(pageUrl(nextPage));
      if (res.status === 429) return { fail: 'limited' };
      if (!res.ok) return { fail: 'error' };
      const data = await res.json();
      return Array.isArray(data?.items) ? { data } : { fail: 'error' };
    } catch {
      return { fail: 'error' };
    }
  };

  // Ответ — в список. Фильтры меняют быстрее, чем отвечает сайт: опоздавший ответ — мимо
  const applyPage = (my, nextPage, { data, fail }) => {
    if (my !== request.current) return;
    if (fail) { setState(fail); return; }
    const fresh = data.items.map(catalogItem);
    setItems(prev => {
      if (nextPage === 1) return fresh;
      // Лента живая: пока листали, игры сдвигаются, и одна может прийти второй раз
      const seen = new Set(prev.map(x => x.key));
      return [...prev, ...fresh.filter(x => !seen.has(x.key))];
    });
    setPage(data.page);
    setMore(!!data.more);
    setState('ready');
  };

  // Страница выдачи: запрос, ответ — в список (в колбэке). Её зовёт и эффект смены фильтров:
  // «загружается» к тому времени уже выставлено при отрисовке (ниже)
  const fetchPage = (nextPage) => {
    // «Хочу поиграть» грузить не нужно: список уже есть
    if (source === 'list') return;
    const my = ++request.current;
    lastPage.current = nextPage;
    requestPage(nextPage).then((result) => applyPage(my, nextPage, result));
  };

  // Следующая страница или «Повторить» — по нажатию: «загружается» ставим сразу
  const load = (nextPage) => {
    if (source === 'list') return;
    setState(nextPage > 1 ? 'more' : 'loading');
    // Первая страница заново — прежний список уже не про эти фильтры
    if (nextPage === 1) setItems([]);
    fetchPage(nextPage);
  };

  // Фильтры сменились — прежний список уже не про них: «загружается» выставляем при отрисовке,
  // а сам запрос — эффектом
  const filtersKey = JSON.stringify([source, itchSort, itchDays, itchPrice, itchPlatform, itchTags]);
  const [loadedFor, setLoadedFor] = useState(null);
  if (loadedFor !== filtersKey) {
    setLoadedFor(filtersKey);
    if (source !== 'list') {
      setState('loading');
      setItems([]);
    }
  }
  useEffect(() => { fetchPage(1); }, [filtersKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape и «назад» закрывают сначала подробный просмотр, потом окно (layers.js). Раскрытый
  // список фильтра Escape забирает себе — окно тогда не закрывается
  const contentRef = useRef(null);
  // Закрытие — коротким исчезновением, как у окна игры
  const [closing, close] = useClosing(onClose);
  useLayer(contentRef, close, { active: !asPage });
  useLayer(contentRef, () => setOpen(null), asPage ? { active: !!open, modal: false, trap: false, focus: false } : { active: !!open });
  // Страницей список и игра — в одной прокрутке окна: игру открываем сверху, а «Назад» возвращает туда же в списке
  const listScroll = useRef(0);
  useEffect(() => {
    if (asPage) window.scrollTo(0, open ? 0 : listScroll.current);
  }, [open, asPage]);

  // Игру открыли — подтягиваем её страницу: кадры, теги, оценку, описание (через ScraperAPI,
  // если он есть)
  const openItem = (item) => {
    if (asPage) listScroll.current = window.scrollY;
    setShot(0);
    setDetails(null);
    setOpen(item);
    if (!itchMeta.details) return;
    // 429 с budget — дневной запас ScraperAPI на страницы itch.io кончился: скажем об этом
    fetch(`/api/itch/game?url=${encodeURIComponent(item.url)}`)
      .then(r => (r.ok ? r.json() : r.status === 429 ? r.json().then(b => (b.budget ? 'budget' : false), () => false) : false))
      .then(d => setDetails(prev => (prev === null ? d : prev)))
      .catch(() => setDetails(false));
  };

  // Карточки прежней вкладки убираем сразу: у выдачи и у списка разные поля
  const switchSource = (next) => {
    if (next === source) return;
    setOpen(null);
    setItems([]);
    setMore(false);
    setState(next === 'list' ? 'ready' : 'loading');
    if (next === 'list') setListSnap(sortWish(wishlist));
    setSource(next);
  };

  // --- Хочу поиграть ---
  const wished = new Set(wishlist.map(x => x.key));
  const toggleWish = (item) => (wished.has(item.key) ? onWishRemove?.(item.key) : onWishAdd?.(item));

  // --- Фильтры ---
  const sortOptions = options([
    ['popular', t.itch_sort_popular], ['newest', t.itch_sort_newest], ['top-rated', t.itch_sort_top_rated],
    ['top-sellers', t.itch_sort_top_sellers], ['featured', t.itch_sort_featured],
  ]);
  // Период у itch.io один из двух: неделя или месяц
  const periodOptions = options([[0, t.cat_days_all], [7, t.cat_days_7], [30, t.cat_days_30]]);
  const priceOptions = options([['', t.itch_price_any], ['free', t.itch_price_free], ['sale', t.itch_price_sale]]);
  const platformOptions = options([['', t.itch_platform_any], ['web', t.itch_platform_web]]);
  const tagOptions = [
    { value: 'all', label: t.cat_tag_with },
    ...itchMeta.tags.filter(tag => !itchTags.includes(tag)).map(tag => ({ value: tag, label: tag.replace(/-/g, ' ') })),
  ];
  // itch.io ищет по тегам только вместе, не больше трёх
  const addTag = (tag) => { if (tag !== 'all' && itchTags.length < 3) setItchTags(prev => [...prev, tag]); };
  const platformLabel = (p) => (p === 'html' ? t.itch_pl_web : ({ windows: 'Windows', osx: 'macOS', linux: 'Linux', android: 'Android' })[p] || p);
  const priceLabel = (item) => item.price || t.itch_free;

  const owned = (item) => item.game && <span className="catalog-owned">{t.cat_in_lib}</span>;

  // На телефоне списки фильтров — под кнопкой «Фильтры», как в библиотеке: пять списков занимали
  // больше половины экрана, и игры начинались ниже середины. На число — сколько фильтров включено.
  // На широком экране кнопки нет, списки стоят в ряд
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = (itchDays ? 1 : 0) + (itchPrice ? 1 : 0) + (itchPlatform ? 1 : 0) + itchTags.length;

  const detail = open && (() => {
    const page = details && typeof details === 'object' ? details : null;
    const pics = [page?.coverUrl || open.cover, ...(page?.screens || [])].filter(Boolean);
    const main = pics[Math.min(shot, pics.length - 1)];
    const line = [open.genre || page?.genre, page?.developer || open.creator, priceLabel(open), ...(open.platforms || []).map(platformLabel),
      t.cat_updated(timeAgo(open.updatedAt, lang))];
    const about = page?.description || open.description;
    // Клик по тегу — искать ещё игры с ним (теги из фильтра; из «Хочу поиграть» — на вкладку новинок)
    const tags = (page?.tags || []).map(name => {
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      const usable = itchMeta.tags.includes(slug) && !itchTags.includes(slug) && itchTags.length < 3;
      return (
        <button key={name} type="button" className="tag tag-link" disabled={!usable}
          onClick={() => { if (source !== 'itch') switchSource('itch'); addTag(slug); setOpen(null); }}>{name}</button>
      );
    });
    // Окно игры в две колонки (на широком экране): слева картинки, справа название, сведения, кнопки и теги —
    // главное видно без прокрутки; описание — под обеими. На телефоне — одной колонкой в том же порядке
    return (
      <div className="catalog-detail">
        <button type="button" className="catalog-back" onClick={() => setOpen(null)}><IconArrowLeft /> {t.cat_back}</button>
        <div className="catalog-detail-grid">
          <div className="catalog-detail-head">
            <h2 className="stats-title catalog-detail-title">{open.title}</h2>
          </div>
          {main && (
            <div className="catalog-detail-media">
              {/* Картинка целиком, а по бокам — она же, размытая: без чёрных полос у узких и высоких */}
              <div className="catalog-detail-frame">
                <img className="catalog-detail-fill" src={main} alt="" aria-hidden="true" decoding="async" referrerPolicy="no-referrer" />
                <img className="catalog-detail-main" src={main} alt={open.title} referrerPolicy="no-referrer" />
              </div>
              {pics.length > 1 && (
                <div className="catalog-detail-thumbs">
                  {pics.map((src, i) => (
                    <button key={src} type="button" className={`catalog-thumb${i === shot ? ' active' : ''}`} onClick={() => setShot(i)}>
                      <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="catalog-detail-side">
            <div className="catalog-detail-meta"><MetaLine parts={line} /></div>
            <div className="catalog-detail-meta">
              {page?.rating && <span>{t.itch_rating(page.rating.value, fmtCount(page.rating.count))}</span>}
              {itchMeta.details && details === null && <span>{t.itch_details_loading}</span>}
              {details === 'budget' && <span>{t.itch_budget}</span>}
              {owned(open)}
            </div>
            <div className="catalog-detail-actions">
              <a className="meta-status-btn catalog-primary" href={open.url} target="_blank" rel="noopener noreferrer">{t.itch_open}</a>
              <div className="catalog-detail-actions-row">
                <button type="button" className={`meta-status-btn catalog-wish-btn${wished.has(open.key) ? ' on' : ''}`}
                  aria-pressed={wished.has(open.key)} onClick={(e) => { if (!wished.has(open.key)) flash([e.currentTarget]); toggleWish(open); }}>
                  <IconStar /> {wished.has(open.key) ? t.wish_in : t.wish_add}
                </button>
                {open.game && (
                  <button type="button" className="meta-status-btn" onClick={() => onOpenGame(open.game.id)}>{t.cat_open_game}</button>
                )}
              </div>
            </div>
            {tags.length > 0 && <div className="modal-tags catalog-detail-tags">{tags}</div>}
          </div>
          {about && <p className="modal-description catalog-detail-text">{about}</p>}
        </div>
      </div>
    );
  })();

  const text = source === 'list'
    ? { hint: t.wish_hint, loading: '', error: '' }
    : { hint: t.itch_cat_hint, loading: t.itch_loading, error: t.itch_error, limited: t.itch_limited };
  // Выбранные теги — чипами с крестиком
  const chosenChips = source === 'itch'
    ? itchTags.map(tag => ({ key: tag, label: tag.replace(/-/g, ' '), name: tag, drop: () => setItchTags(prev => prev.filter(x => x !== tag)) }))
    : [];
  // Что показываем сеткой: выдачу сайта или снятый список — с актуальными данными тех игр,
  // что в нём остались
  const current = new Map(wishlist.map(e => [e.key, e]));
  // Список пришёл позже, чем открыли вкладку, — показываем его как есть
  const snap = listSnap.length ? listSnap : sortWish(wishlist);
  const shown = (source === 'list' ? snap.map(e => wishItem(current.get(e.key) || e)) : items).filter((x) => !hideOwned || !x.game);

  const body = (
    <>
        {/* Подробный просмотр поверх списка: список со всеми подгруженными страницами
            остаётся, и «Назад» возвращает туда же, где остановились */}
        {detail}
        <div hidden={!!open}>
          {/* Шапка в одну строку: название, вкладки, справа — вид и «?» с пояснением */}
          <div className="catalog-head">
            <h2 className="stats-title">{t.cat_title}</h2>
            <div className="filter-chips catalog-sources">
              {[['itch', t.src_itch], ['list', <><IconStarSolid /> {t.wish_title}{wishlist.length ? ` ${wishlist.length}` : ''}</>]].map(([key, label]) => (
                <button key={key} type="button" aria-pressed={source === key} onClick={() => switchSource(key)}
                  className={`chip ${source === key ? 'active' : ''}${key === 'list' ? ' catalog-wish-tab' : ''}`}>{label}</button>
              ))}
            </div>
            <div className="catalog-tools">
              <div className="catalog-view" role="group" aria-label={t.cat_view}>
                <button type="button" aria-pressed={view === 'grid'} data-tip={t.cat_view_grid} aria-label={t.cat_view_grid} onClick={() => pickView('grid')}><IconGrid /></button>
                <button type="button" aria-pressed={view === 'list'} data-tip={t.cat_view_list} aria-label={t.cat_view_list} onClick={() => pickView('list')}><IconRows /></button>
              </div>
              <HelpMark className="catalog-help" t={t} help={{ open: help, toggle: toggleHelp, id: 'catalog-hint', close: () => { if (help) toggleHelp(); } }} />
            </div>
          </div>
          {help && <p className="audit-hint catalog-hint" id="catalog-hint">{text.hint}</p>}

          {source === 'itch' && (
            <div className="catalog-filters">
              <button
                type="button"
                className={`filters-toggle${filtersOpen ? ' open' : ''}${activeFilters ? ' active' : ''}`}
                onClick={() => setFiltersOpen((v) => !v)}
                aria-expanded={filtersOpen}
                aria-controls="catalog-filters"
              >
                <IconSliders />
                {t.filters}
                {activeFilters > 0 && <span className="filters-count">{activeFilters}</span>}
              </button>
              <div className={`catalog-filter-list${filtersOpen ? ' open' : ''}`} id="catalog-filters">
                <Picker options={sortOptions} value={itchSort} onChange={setItchSort} label={t.cat_sort} />
                <Picker options={periodOptions} value={itchDays} onChange={setItchDays} label={t.cat_period} highlight={itchDays !== 0} />
                <Picker options={priceOptions} value={itchPrice} onChange={setItchPrice} label={t.itch_price} highlight={!!itchPrice} />
                <Picker options={platformOptions} value={itchPlatform} onChange={setItchPlatform} label={t.itch_platform} highlight={!!itchPlatform} />
                <Picker
                  options={tagOptions} value="all" onChange={addTag} label={t.cat_tag_with}
                  searchable searchPlaceholder={t.cat_tag_search} emptyText={t.cat_tag_none}
                />
              </div>
            </div>
          )}

          {chosenChips.length > 0 && (
            <div className="filter-chips catalog-chosen">
              {chosenChips.map(chip => (
                <button key={chip.key} type="button" className="chip active" data-tip={t.cat_tag_remove(chip.name)}
                  onClick={chip.drop}><IconPlus /> {chip.label} <IconClose /></button>
              ))}
            </div>
          )}

          {/* «Скрыть мои» — игры, что уже в библиотеке, из выдачи уходят */}
          <div className="catalog-actions">
            <label className="catalog-check">
              <input type="checkbox" role="switch" checked={hideOwned} onChange={toggleHideOwned} />
              <span>{t.cat_hide_owned}</span>
            </label>
          </div>

          {state === 'loading' && <StateView kind="loading" title={text.loading} />}
          {(state === 'error' || state === 'limited') && (
            <StateView kind="error" title={state === 'limited' ? text.limited : text.error} onRetry={() => load(lastPage.current)} retryLabel={t.retry} />
          )}
          {state === 'ready' && shown.length === 0 && (hideOwned && (source === 'list' ? wishlist.length : items.length) > 0
            ? <StateView title={t.cat_all_owned} hint={t.cat_all_owned_hint} />
            : source === 'list'
              ? <StateView title={t.wish_empty_title} hint={t.wish_empty} />
              : <StateView title={t.cat_empty} hint={t.cat_empty_hint} />)}

          {state !== 'loading' && shown.length > 0 && (
            <div className={view === 'list' ? 'catalog-rows' : 'catalog-grid'}>
              {/* Звёздочка — рядом с карточкой, а не внутри: кнопка в кнопке недопустима */}
              {shown.map(item => {
                const meta = [item.genre, item.creator];
                const stat = (item.platforms || []).map(platformLabel).join(', ');
                const right = timeAgo(item.updatedAt || item.createdAt, lang);
                const cover = (
                  <div className="catalog-cover">
                    {item.cover ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onLoad={fitWide} /> : <div className="catalog-cover-empty">RPGM</div>}
                    <span className={`catalog-status ${item.price ? 'paid' : 'free'}`}>{priceLabel(item)}</span>
                    {owned(item)}
                  </div>
                );
                const title = <span className="catalog-card-title">{item.title}</span>;
                return (
                  <div key={item.key} className={view === 'list' ? 'catalog-row-box' : 'catalog-card-box'}>
                    {view === 'list' ? (
                      <button type="button" className="catalog-card catalog-row" onClick={() => openItem(item)}>
                        {cover}
                        <span className="catalog-row-main">
                          {title}
                          <MetaLine className="catalog-card-line" parts={meta} />
                          {item.description && <span className="catalog-card-tags">{item.description}</span>}
                        </span>
                        <span className="catalog-row-stats">
                          {stat && <span>{stat}</span>}
                          {right && <span>{right}</span>}
                        </span>
                      </button>
                    ) : (
                      <button type="button" className="catalog-card" onClick={() => openItem(item)}>
                        {cover}
                        <span className="catalog-card-info">
                          {title}
                          <MetaLine className="catalog-card-line" parts={meta} />
                          {(stat || right) && (
                            <span className="catalog-card-foot">
                              <span>{stat}</span>
                              <span>{right}</span>
                            </span>
                          )}
                        </span>
                      </button>
                    )}
                    <button type="button" className={`catalog-wish${wished.has(item.key) ? ' on' : ''}`} aria-pressed={wished.has(item.key)}
                      data-tip={wished.has(item.key) ? t.wish_star_remove : t.wish_star_add} aria-label={wished.has(item.key) ? t.wish_star_remove : t.wish_star_add}
                      onClick={(e) => { if (!wished.has(item.key)) flash([e.currentTarget]); toggleWish(item); }}><IconStar /></button>
                  </div>
                );
              })}
            </div>
          )}

          {state !== 'loading' && state !== 'error' && state !== 'limited' && more && (
            <button type="button" className="audit-retry catalog-more" disabled={state === 'more'} onClick={() => load(page + 1)}>
              {state === 'more' ? text.loading : t.cat_more}
            </button>
          )}
        </div>
    </>
  );
  if (asPage) {
    return <section ref={contentRef} className="catalog-page catalog-content" aria-label={t.cat_title}>{body}</section>;
  }
  return (
    <div className={`modal-overlay active pop${closing ? ' closing' : ''}`} onClick={close}>
      <div ref={contentRef} className="stats-content catalog-content" role="dialog" aria-modal="true" aria-label={t.cat_title} tabIndex={-1} onClick={e => e.stopPropagation()}>
        <div className="modal-actions-top"><button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button></div>
        {body}
      </div>
    </div>
  );
};

export default Catalog;
