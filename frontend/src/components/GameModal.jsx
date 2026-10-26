import { useState, useRef, useEffect, useLayoutEffect, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';

import { getCoverUrl, getMediaUrl } from '../coverUrl';

import { formatPlaytime } from '../formatPlaytime';

import { launchGame, withIntro, launchSignal } from '../launchGame';
import { flightFrom, flyOpen, flyClose, flyCancel } from '../windowFly';

import { IconEdit, IconDownload, IconUpload, IconTrash, IconRefresh, IconImage, IconClose, IconChevronLeft, IconChevronRight, IconStarSolid, IconPlay, IconCheck, IconMore } from './icons';
import GameEdit from './GameEdit';
// Открывают редко — грузим при первом открытии
const SaveHistory = lazy(() => import('./SaveHistory'));
const GameGallery = lazy(() => import('./GameGallery'));
import { autoStatus } from '../gameStatus';

import { describeMeta, metaParts } from '../formatRetry';
import { languageLine, languageName } from '../formatLanguage';
import { langsLabel } from '../catalogItems';
import { timeAgo } from '../formatAgo';
import { useLayer } from '../layers';
import { confirmDialog } from '../confirm';
import { errorText, httpError } from '../apiError';
import { flash, flashStars } from '../pulse';
import { linkIcon, siteName, splitLinks } from '../gameLinks';
import BrandMark from './BrandMark';
import ShotsPanel from './ShotsPanel';
import PathPanel from './PathPanel';
import { useShots } from '../shotsList';
import LookupHelp from './LookupHelp';
import LookupLive from './LookupLive';
import TranslateBar from './TranslateBar';
import ContinueFrom from './ContinueFrom';
import { latestOf, launchPoint, loadResume } from '../resumePoint';
import { useCoversHidden } from '../coversHidden';
import { placeOf } from '../playProgress';
import { favoritesOf, useFavoriteTags } from '../favoriteTags';
import { IconHeart } from './icons';
import { loadKnownLangs, useKnownLangs } from '../knownLangs';
import MetaLine from './MetaLine';

const ROMAN_NUMERALS = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ','Ⅺ','Ⅻ'];
// Сколько тегов видно сразу. Раньше показывались все — по 27 крупных плашек, и
// блок прокручивался внутри окна, которое само прокручивается
const TAGS_SHOWN = 12;

// initial — с чего открыть: 'gallery', 'saves' (раскрытый «Продолжить с…») или номер скриншота (так открывает «Продолжить» на главной)
// Вкладки правой колонки окна игры, по порядку
const MODAL_TABS = ['overview', 'path', 'shots', 'info', 'translate'];

// Меню «⋯» открывается вниз; на телефоне его низ оказывался за краем экрана — подкручиваем окно к нему. Функция
// вне компонента: ref с постоянной функцией вызывается раз при открытии, а не на каждой перерисовке
const revealOnOpen = (el) => el?.scrollIntoView({ block: 'nearest' });

const GameModal = ({ game, index, initial, onClose, onUpdateGame, onPatch, onDelete, onTagClick, onUploadNewVersion, onUploadPatch, from, t, lang, showToast }) => {
  const [showAllTags, setShowAllTags] = useState(false);
  // Звезда под курсором: подсвечиваем, какой будет оценка, ещё до клика
  const [hoverStar, setHoverStar] = useState(0);
  // Номер раскрытой картинки или null. Раньше кадр открывался новой вкладкой —
  // игру при этом приходилось терять из виду и возвращаться назад руками.
  const [lightbox, setLightbox] = useState(Number.isInteger(initial) ? initial : null);
  
  const importRef = useRef(null);
  const contentRef = useRef(null);
  const lightboxRef = useRef(null);
  // Просмотрщик кадра — в body, вне контейнера с covers-hidden: размывает себя сам
  const hidden = useCoversHidden();

  // Окно вырастает из карточки (windowFly.js). Измеряем и запускаем до первой отрисовки, чтобы не мелькнуло
  // окно на своём месте; from берём один раз — при открытии, а не при каждой смене игры в окне
  const overlayRef = useRef(null);
  const ghostRef = useRef(null);
  const flight = useRef(null);
  const fromRef = useRef(from);
  useLayoutEffect(() => {
    flight.current = flyOpen({ overlay: overlayRef.current, win: contentRef.current, ghost: ghostRef.current }, fromRef.current);
    return () => flyCancel(flight.current);
  }, []);
  // Перешли стрелкой на другую игру: карточка, из которой окно выросло, — уже не эта игра. Закрытие тогда
  // просто гаснет, а не сажает чужую обложку в старую карточку
  const openedId = useRef(game.id);
  useEffect(() => {
    if (game.id !== openedId.current && flight.current) flight.current.from = null;
  }, [game.id]);

  // Стрелки листают раскрытые кадры по кругу. Escape закрывает просмотрщик, а не всё окно игры:
  // это делает стопка слоёв (layers.js) — у просмотрщика свой слой, ниже
  useEffect(() => {
    if (lightbox === null) return undefined;
    const total = game.screens?.length || 0;
    const onKey = (e) => {
      if (e.key === 'ArrowRight' && total) setLightbox(i => (i + 1) % total);
      else if (e.key === 'ArrowLeft' && total) setLightbox(i => (i - 1 + total) % total);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, game.screens]);

  const handleCloseModal = () => flyClose(flight.current, onClose);

  const formatDate = (ms) => {
    if (!ms) return t.never;
    const locale = lang === 'en' ? 'en-US' : lang === 'de' ? 'de-DE' : 'ru-RU';
    return new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const formatReleaseDate = (dateStr) => {
    if (!dateStr) return '—';
    if (/^\d{4}$/.test(dateStr)) return dateStr;
    try {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        const locale = lang === 'en' ? 'en-US' : lang === 'de' ? 'de-DE' : 'ru-RU';
        return date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
      }
    } catch { /* не дата — покажем как есть */ }
    return dateStr;
  };

  const formatSize = (bytes) => {
    if (!bytes) return t.meta_unknown;
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) return (mb / 1024).toFixed(2) + ' GB';
    return mb.toFixed(2) + ' MB';
  };

  // Ссылка ведёт прямо на архив, но сначала HEAD: иначе отказ (два архива уже собираются, вход, 404) браузер
  // показал бы сорванной загрузкой «archive.json», а текст ошибки до человека не дошёл бы
  const handleArchive = async (e) => {
    e.preventDefault();
    setMoreOpen(false);
    const url = e.currentTarget.getAttribute('href');
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) { notify(errorText(t, httpError(res, {}), { byStatus: { 429: t.archive_busy } }), 'error'); return; }
    } catch {
      notify(t.err_net, 'error');
      return;
    }
    // Загрузку ведёт браузер: полоса, пауза, телефон
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const notify = (msg, type = 'info') => {
    if (showToast) showToast(msg, type);
    else alert(msg);
  };

  const [isEditing, setIsEditing] = useState(false);
  // «Искать сейчас» нажата: запоминаем время последней проверки на момент нажатия.
  // Пока оно не сменилось, воркер ещё не записал новый итог — поиск идёт.
  // Вычисляем, а не сбрасываем эффектом: так не бывает лишнего прохода рендера.
  const [queuedFrom, setQueuedFrom] = useState(null);
  const searchQueued = queuedFrom !== null && (game.meta?.checkedAt || 0) === queuedFrom;

  const handleRescrape = async () => {
    setQueuedFrom(game.meta?.checkedAt || 0);
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/rescrape`, { method: 'POST' });
      if (!res.ok) throw new Error();
    } catch {
      setQueuedFrom(null);
      showToast?.(t.err_net, 'error');
    }
  };
  // «Это она» в «Возможно, это она»: ссылка — к ссылкам игры, и поиск данных сразу по ней, как
  // после правки ссылок вручную (routes/games.js, /edit)
  const pickLink = async (url) => {
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: [...splitLinks(game.link), url].join(',') }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      onUpdateGame(index, { ...game, ...data.game });
      notify(data.found ? t.lookup_picked : t.lookup_picked_empty, data.found ? 'success' : 'info');
    } catch (e) {
      notify(errorText(t, e), 'error');
    }
  };
  const [isPlaying, setIsPlaying] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  // «Бэкап», «Импорт», «Удалить» — в меню «⋯»: нужны редко, а «Удалить» не должно стоять
  // рядом с частой кнопкой, где его легко нажать по ошибке
  const [moreOpen, setMoreOpen] = useState(false);
  // Вкладка правой колонки — вместе с игрой, для которой её выбрали: другая игра — снова «Обзор»
  const [tabOf, setTabOf] = useState({ id: game.id, key: 'overview' });
  const tab = tabOf.id === game.id ? tabOf.key : 'overview';
  const setTab = (key) => setTabOf({ id: game.id, key });
  const tabsRef = useRef(null);
  // Лента вкладок листается вбок (на телефоне «Прохождения» и «Перевод» уходят за край): затухание у того края,
  // за которым ещё есть вкладки, — как у чипов статусов (StatusChips). Отметка в data-fade, без перерисовки
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return undefined;
    const update = () => {
      const fade = [];
      if (el.scrollLeft > 4) fade.push('left');
      if (el.scrollLeft + el.clientWidth < el.scrollWidth - 4) fade.push('right');
      el.dataset.fade = fade.join(' ');
    };
    const resize = new ResizeObserver(update);
    resize.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => { resize.disconnect(); el.removeEventListener('scroll', update); };
  }, [isEditing, game.id]);
  // Прокрутили окно — крестик получает сплошную полосу: иначе он ложится поверх «Играть» и текста под ним
  // Помним, для какой игры и режима прокрутили: другая игра или правка и обратно — окно снова наверху
  const [scrolledAt, setScrolledAt] = useState(null);
  const viewKey = `${game.id}:${isEditing}`;
  const scrolled = scrolledAt === viewKey;
  const [descOpenId, setDescOpenId] = useState(null);
  const descOpen = descOpenId === game.id;
  // Длинное — точно больше четырёх строк: в строку шириной 72ch входит знаков 85–90, четыре строки — около 350;
  // с запасом 400, иначе кнопка «Читать полностью» была бы у текста, который и так виден целиком. Пять абзацев и больше —
  // всегда длинное
  const longDesc = (game.description || '').length > 400 || ((game.description || '').match(/\n/g) || []).length > 3;
  // Картинки, которые не загрузились (файла нет): браузер рисовал на их месте подпись и пустую рамку — вместо обложки
  // ставим заглушку, кадр не показываем
  const [badImg, setBadImg] = useState({});
  const markBad = (src) => setBadImg((m) => (m[src] ? m : { ...m, [src]: true }));
  const shots = (game.screens || []).map((src, i) => ({ src, i })).filter((x) => !badImg[x.src]);
  // Кадр для полосы сверху окна — первый, что загрузился
  const strip = shots[0]?.src;
  // Стрелки по вкладкам — как у любого списка вкладок: фокус и выбор вместе
  const onTabsKey = (e) => {
    const at = MODAL_TABS.indexOf(tab);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: MODAL_TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = MODAL_TABS[(to + MODAL_TABS.length) % MODAL_TABS.length];
    setTab(next);
    tabsRef.current?.querySelector(`#tab-${next}`)?.focus();
  };
  // «Скриншоты»: снимки и моменты из самой игры (перемотка в число не входит — её ставит игра сама)
  // Перечитываем, когда открывают «Путь» или «Скриншоты»: после игры там новые снимки и точки («Путь» по ним знает,
  // откуда можно играть)
  const myShots = useShots(game.id, tab === 'path' || tab === 'shots' ? tab : '');
  const shotsCount = (myShots.items || []).filter((m) => m.kind !== 'auto').length;
  // Идёт ли перевод этой игры (сообщает TranslateBar) — точка на ярлыке «Перевод»
  const [tlRun, setTlRun] = useState({ id: null, on: false });
  const tlRunning = tlRun.id === game.id && tlRun.on;
  // На какой язык игру переводит Mimikin (включён в полосе «Перевод») — чипом под названием
  const [mimikin, setMimikin] = useState({ id: null, lang: null });
  const mimikinTl = mimikin.id === game.id ? mimikin.lang : null;
  // «История сейвов» — вместо сведений об игре, пока открыта
  // «История сейвов» — из «Продолжить с…» (прежние версии слота); initial 'saves' открывает сам список «Продолжить с…»
  const [historyOpen, setHistoryOpen] = useState(false);
  // Закрыли «Историю сейвов» — «Продолжить с…» читает сейвы заново (версию могли вернуть)
  const [savesSeen, setSavesSeen] = useState(0);
  // Галерея из файлов игры — поверх всего окна
  const [galleryOpen, setGalleryOpen] = useState(initial === 'gallery');
  // Любимые теги («Настройки → Общие») — первыми в списке тегов и с сердцем
  const favorites = useFavoriteTags();
  const favTags = favoritesOf(game.tags, favorites);
  // Игра на языке, который человек знает, — полосу перевода не показываем, пока не попросит
  const knownLangs = useKnownLangs();
  useEffect(() => { loadKnownLangs(); }, []);
  const knownLang = knownLangs.includes(game.textLang?.main);
  const orderedTags = [...favTags, ...(game.tags || []).filter((tag) => !favTags.includes(tag))];
  const moreRef = useRef(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDown = (e) => { if (!moreRef.current?.contains(e.target)) setMoreOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [moreOpen]);
  // Пункт меню «⋯»: меню закрыть, действие выполнить
  const runMore = (fn) => { setMoreOpen(false); fn(); };

  // Прежние версии, отложенные при обновлении игры: сколько места занимают — узнаём, когда открыли «⋯»
  const [oldSize, setOldSize] = useState(0);
  // Последняя прежняя версия ушла в запас из-за патча — «Вернуть» тогда значит «убрать патч»
  const [oldPatch, setOldPatch] = useState('');
  useEffect(() => {
    if (!moreOpen || !game.oldVersions) return;
    fetch(`/api/games/${encodeURIComponent(game.id)}/old`)
      .then((res) => res.json())
      .then((data) => {
        const versions = data.versions || [];
        setOldSize(versions.reduce((sum, v) => sum + v.size, 0));
        setOldPatch(versions.at(-1)?.patch || '');
      })
      .catch(() => {});
  }, [moreOpen, game.id, game.oldVersions]);
  // Есть ли сейвы Mimikin для архива: только тогда предлагаем выбор «с сейвами / без»
  const [archiveSaves, setArchiveSaves] = useState({ id: null, n: 0 });
  useEffect(() => {
    if (!moreOpen) return;
    fetch(`/api/games/${encodeURIComponent(game.id)}/archive-info`)
      .then((res) => res.json())
      .then((data) => setArchiveSaves({ id: game.id, n: data.saves || 0 }))
      .catch(() => {});
  }, [moreOpen, game.id]);
  const hasArchiveSaves = archiveSaves.id === game.id && archiveSaves.n > 0;
  const handleRestoreOld = async () => {
    if (!(await confirmDialog({ title: t.old_restore_title, name: game.displayTitle || game.title, text: t.old_restore_text, confirmLabel: t.saves_restore }))) return;
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/old/restore`, { method: 'POST' });
      if (!res.ok) throw httpError(res, await res.json().catch(() => ({})));
      notify(t.old_restored, 'success');
    } catch (e) {
      notify(errorText(t, e), 'error');
    }
  };
  const handleDeleteOld = async () => {
    if (!(await confirmDialog({ title: t.old_delete_title, name: game.displayTitle || game.title, text: t.old_delete_text, confirmLabel: t.old_delete(oldSize ? formatSize(oldSize) : ''), danger: true }))) return;
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/old`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      notify(t.old_deleted, 'success');
      onUpdateGame(index, { ...game, oldVersions: 0 });
    } catch {
      notify(t.err_net, 'error');
    }
  };

  // Правка (GameEdit) — поверх сведений. Пока в ней есть несохранённое, окно игры не закрывается
  // крестиком или кликом мимо молча, а спрашивает, как и сама правка на «Отмену»
  const dirtyRef = useRef(false);
  const requestClose = async (keepOpen) => {
    const leave = !dirtyRef.current || await confirmDialog({
      title: t.edit_discard_title, name: game.displayTitle || game.title, text: t.edit_discard_text,
      confirmLabel: t.edit_discard, cancelLabel: t.edit_keep, danger: true,
    });
    if (leave) handleCloseModal();
    else keepOpen?.();
  };

  const handleBackup = () => {
    // Бэкенд ждет путь /export/:id (с учетом префикса роутера это /api/saves/export/)
    window.location.assign(`/api/saves/export/${game.id}`);
  };

  const handleImportSelect = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsImporting(true);
    const formData = new FormData();
    formData.append('saves', file);
    try {
      const res = await fetch(`/api/saves/import/${game.id}`, { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        notify(t.import_success, 'success');
        onUpdateGame(index, game);
      } else {
        notify(errorText(t, { status: res.status, error: data.error }, { fallback: t.import_fail }), 'error');
      }
    } catch {
      notify(t.err_net, 'error');
    } finally {
      setIsImporting(false);
      e.target.value = '';
    }
  };

  // «Играть» продолжает, как на карточке «Продолжить»: с самого свежего сейва или момента; нечего — с титула
  // (с титула можно и явно — «Продолжить с…»)
  const handlePlay = async () => {
    setIsPlaying(true);
    try {
      // Обложка окна растёт в экран игры сразу на нажатии, не дожидаясь ответа сервера (LaunchIntro)
      await withIntro(game, flightFrom(contentRef.current?.querySelector('#modal-cover')), async () => {
        const point = latestOf(await loadResume(game.id, launchSignal()), t);
        await launchGame(game, (updated) => onUpdateGame(index, updated), launchPoint(point));
      });
    } catch (e) {
      notify(errorText(t, e), 'error');
    }
    // Игра открылась в рамке поверх — кнопка снова «Играть», когда из неё вернутся
    setIsPlaying(false);
  };
  // Сразу на сейве или моменте («Продолжить с…»): { slot } или { mark }
  const playFrom = async (where) => {
    setIsPlaying(true);
    try {
      await withIntro(game, flightFrom(contentRef.current?.querySelector('#modal-cover')), () => launchGame(game, (updated) => onUpdateGame(index, updated), where));
    } catch (e) {
      notify(errorText(t, e), 'error');
    }
    setIsPlaying(false);
  };

  // Удаление живёт здесь, а не на карточке: там корзина стояла вплотную к звезде
  // «Избранное», и промахнуться было проще простого
  const handleDelete = async () => {
    if (await onDelete?.(game)) handleCloseModal();
  };

  // Слои окна (layers.js): Escape и «назад» закрывают верхний — картинку, галерею, меню «⋯»,
  // историю сейвов или правку (у неё свой слой, GameEdit), а уже потом само окно. Фокус при
  // открытии — на «Играть»: Enter сразу запускает игру
  useLayer(contentRef, requestClose, { focus: '#modal-play-btn' });
  useLayer(contentRef, () => { setHistoryOpen(false); setSavesSeen((n) => n + 1); }, { active: historyOpen });
  useLayer(moreRef, () => setMoreOpen(false), { active: moreOpen, history: false, trap: false, focus: '.modal-more-item' });
  useLayer(lightboxRef, () => setLightbox(null), { active: lightbox !== null, focus: 'self' });

  // Повторный клик по той же звезде снимает оценку
  const rate = (n) => onPatch(game.id, { rating: game.rating === n ? 0 : n });

  // --- НОВАЯ ЛОГИКА ОПРЕДЕЛЕНИЯ САЙТА ДЛЯ ССЫЛКИ ---
  // Подписи в локалях — с двоеточием («Разработчик:»): в парах и сетке оно лишнее
  const plain = (label) => String(label).replace(/:\s*$/, '');

  // Источники игры для вкладки «Сведения» (карточки) и строки «Данные: …» в «Обзоре». Ссылка — из ссылок игры;
  // info — что известно с этого сайта, hint — подсказка
  const sources = (() => {
    const links = splitLinks(game.link);
    const find = (re) => links.find((u) => re.test(u)) || '';
    const list = [
      { key: 'steam', name: 'Steam', url: find(/steampowered\.com\//), icon: '/steam-logo.png', info: '' },
      { key: 'vndb', name: 'VNDB', url: find(/vndb\.org\//), icon: '/vndb-logo.png', info: '' },
      { key: 'itch', name: 'itch.io', url: find(/\.itch\.io\//), icon: '/itch-logo.svg', info: '' },
    ];
    // Прочие ссылки игры — тоже карточками, после известных
    const known = new Set(list.map((x) => x.url).filter(Boolean));
    const other = [...new Set(links)].filter((u) => !known.has(u)).map((u) => ({ key: u, name: siteName(u), url: u, icon: linkIcon(u), info: '' }));
    return [...list.filter((x) => x.url), ...other, ...list.filter((x) => !x.url)];
  })();

  const coverUrl = getCoverUrl(game, 720);
  const roman = ROMAN_NUMERALS[index % ROMAN_NUMERALS.length] || String(index + 1);

  return (
    <div ref={overlayRef} className="modal-overlay active game-overlay" onClick={() => requestClose()}>
      {from && <img ref={ghostRef} className="modal-ghost" alt="" aria-hidden="true" />}
      <div
        ref={contentRef}
        className={`modal-content${isEditing ? ' editing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={isEditing ? 'edit-title' : 'modal-title'}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        
        {/* В углу остаётся только крестик — его там ищут по привычке в любом окне.
            Шестерёнка висела рядом и заезжала на длинное название: теперь это
            обычная кнопка «Изменить» в ряду с остальными действиями над игрой */}
        <div className={`modal-actions-top${scrolled ? ' scrolled' : ''}`}>
          <button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={() => requestClose()}><IconClose /></button>
        </div>

        {isEditing ? (
          <GameEdit
            game={game} index={index} roman={roman} contentRef={contentRef} dirtyRef={dirtyRef}
            t={t} lang={lang} notify={notify} onUpdateGame={onUpdateGame}
            onDone={() => setIsEditing(false)}
          />
        ) : (
        <div className={`modal-header${strip ? ' has-strip' : ''}`} onScroll={(e) => setScrolledAt(e.currentTarget.scrollTop > 8 ? viewKey : null)}>
          {/* Полоса сверху, как в Steam: настоящий кадр из игры, затемнённый; обложка заходит на неё. Обложка в окне и так
              есть, так что ею полосу не заполняем — одна картинка дважды. Нет кадров — нет полосы. На узком окне её нет */}
          {strip && <div className="modal-strip" aria-hidden="true"><img src={getMediaUrl(strip, 720)} alt="" /></div>}
          {/* Левая колонка: обложка, под ней своё и источники. Обложки у нас широкие — одна обложка оставляла под собой
              пустую колонку во всю высоту окна; своё здесь видно с любой вкладки */}
          <aside className="modal-side">
            <div className="modal-cover-wrapper">
              {coverUrl && !badImg[coverUrl] ? (
                <img id="modal-cover" src={coverUrl} alt={game.displayTitle || game.title} onError={() => markBad(coverUrl)} />
              ) : (
                <div className="cover-placeholder modal-placeholder"><BrandMark size={64} /></div>
              )}
            </div>

            {/* Своё: когда играл, где остановился, сколько наиграно и осталось, оценка, статус */}
            <section className="modal-mine" aria-labelledby="modal-mine-title">
              <h3 className="modal-side-title" id="modal-mine-title">{t.mine_title}</h3>
              <div className="modal-facts">
                {game.lastPlayed > 0 && (
                  <div className="modal-fact modal-progress"><span className="modal-fact-label">{t.last_played}</span><span className="modal-fact-value">{timeAgo(game.lastPlayed, lang)}</span></div>
                )}
                {/* Где остановился — по последнему сейву */}
                {placeOf(game) && (
                  <div className="modal-fact modal-progress" data-tip={t.where_title}><span className="modal-fact-label">{plain(t.where_label)}</span><span className="modal-fact-value">{placeOf(game)}</span></div>
                )}
                {formatPlaytime(game.playtime, t) && (
                  <div className="modal-fact modal-progress">
                    <span className="modal-fact-label">{plain(t.playtime)}</span>
                    <span className="modal-fact-value">
                      <MetaLine parts={[
                        formatPlaytime(game.playtime, t),
                        game.progress?.level != null && <span className="meta-nb"><span className="meta-label">{t.progress_level}</span> {game.progress.level}</span>,
                        game.progress?.gold != null && <span className="meta-nb"><span className="meta-label">{t.progress_gold}</span> {game.progress.gold.toLocaleString(lang === 'en' ? 'en-US' : lang === 'de' ? 'de-DE' : 'ru-RU')}</span>,
                      ]} />
                    </span>
                  </div>
                )}
                <div className="modal-fact">
                  <span className="modal-fact-label">{t.rating_label}</span>
                  <div className="modal-fact-value">
                    {/* Оценка: на карточке звёзды 16px, пальцем в них не попасть */}
                    <div className="modal-rating" role="group" aria-label={t.rating_label} onMouseLeave={() => setHoverStar(0)}>
                      {[1, 2, 3, 4, 5].map(n => (
                        <button
                          key={n}
                          type="button"
                          className={`rating-star ${n <= (hoverStar || game.rating || 0) ? 'active' : ''}`}
                          aria-label={t.rate_star(n)}
                          aria-pressed={game.rating === n}
                          onMouseEnter={() => setHoverStar(n)}
                          onClick={(e) => { flashStars(e.currentTarget.parentElement, '.rating-star', game.rating || 0, n); rate(n); }}
                        >
                          <IconStarSolid />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="modal-fact modal-fact-status">
                  <span className="modal-fact-label">{t.fact_status}</span>
                  <div className="modal-fact-value">
                    {/* Статус, вписанный руками, — подсвечен; найденный сам («Играю», gameStatus.js) —
                        пунктиром: нажатие закрепляет его руками */}
                    <div className="status-row">
                      {['playing', 'done', 'dropped', 'wish'].map(key => (
                        <button
                          key={key}
                          type="button"
                          className={`chip ${game.status === key ? 'active' : ''}${!game.status && autoStatus(game) === key ? ' auto' : ''}`}
                          aria-pressed={game.status === key}
                          data-tip={!game.status && autoStatus(game) === key ? t.status_auto_hint : undefined}
                          onClick={(e) => { if (game.status !== key) flash([e.currentTarget]); onPatch(game.id, { status: game.status === key ? '' : key }); }}
                        >
                          {t[`status_${key}`]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Источники — строками: сайт, что он дал (оценка, код, число картинок); непривязанные — одной строкой ниже */}
            <section className="modal-src" aria-labelledby="modal-src-title">
              <h3 className="modal-side-title" id="modal-src-title">{t.src_title}</h3>
              {sources.filter((x) => x.url).map((x) => (
                <a key={x.key} className="src-row" href={x.url} target="_blank" rel="noopener noreferrer" data-tip={[x.info, x.hint].filter(Boolean).join('\n') || x.url}>
                  {x.icon && <img src={x.icon} alt="" className="grimoire-source-logo" />}
                  <span className="src-row-name">{x.name}</span>
                  {x.info && <span className="src-row-info">{x.info}</span>}
                </a>
              ))}
              {sources.some((x) => !x.url) && <p className="src-off">{t.src_off(sources.filter((x) => !x.url).map((x) => x.name).join(', '))}</p>}
            </section>
          </aside>

          <div className="modal-info">
            {historyOpen ? (
              <Suspense fallback={null}><SaveHistory
                game={game}
                t={t}
                lang={lang}
                notify={notify}
                onClose={() => { setHistoryOpen(false); setSavesSeen((n) => n + 1); }}
                onRestored={() => onUpdateGame(index, game)}
              /></Suspense>
            ) : (
              <>
                <div className="modal-title-block">
                  {/* Длинное название («Leila, the Plundered Girl ~A Sacrificial Contract…~») — мельче: крупным оно
                      занимало три строки и уводило вкладки вниз */}
                  <h2 id="modal-title" className={(game.displayTitle || game.title || '').length > 48 ? 'long' : undefined}>{game.displayTitle || game.title}</h2>
                  {/* Японское название, которое заменили английским, — мелко под ним */}
                  {game.originalTitle && <div className="modal-original-title" lang="ja">{game.originalTitle}</div>}
                </div>

                {/* Главное — одной строкой под названием: кто сделал, когда, версия. Подробное — во вкладке «Сведения» */}
                {(() => {
                  const items = [
                    game.developer && <span key="dev" className="modal-summary-dev">{game.developer}</span>,
                    game.releaseDate && <span key="rel">{formatReleaseDate(game.releaseDate)}</span>,
                    game.version && <span key="ver">{t.meta_version.replace(/:\s*$/, '')} {game.version}</span>,
                  ].filter(Boolean);
                  return items.length ? <div className="modal-summary">{items}</div> : null;
                })()}

                {/* Языки игры — отдельной строкой чипами. Их нет — строки нет, «Играть» остаётся на первом экране телефона */}
                {(() => {
                  const info = game.textLang?.langs?.length ? game.textLang.langs : [];
                  const shown = info.length ? info : game.language ? [game.language] : [];
                  if (!shown.length && !mimikinTl) return null;
                  return (
                    <div className="modal-ids">
                      {shown.map((c, i) => (
                        <span key={c} className={`modal-lang${i === 0 ? ' main' : ''}`} data-tip={info.length ? languageName(c, lang) : undefined}>{info.length ? langsLabel([c]) : c}</span>
                      ))}
                      {mimikinTl && <span className="modal-lang tl" data-tip={t.code_mimikin_tl(languageName(mimikinTl, lang))}><BrandMark size={16} />{langsLabel([mimikinTl])}</span>}
                    </div>
                  );
                })()}

                {/* Действия — рядом, как в RomM: «Играть», «Продолжить с…», галерея, правка, «⋯» */}
                <div className="modal-actions">
                  <button id="modal-play-btn" onClick={handlePlay} disabled={isPlaying}>
                  <IconPlay /><span>{isPlaying ? t.launching : t.play}</span>
                </button>
                  <ContinueFrom key={`from-${game.id}`} game={game} t={t} lang={lang} notify={notify} open={initial === 'saves'} reload={savesSeen} onPlay={playFrom} onHistory={() => setHistoryOpen(true)} />
                  <button type="button" onClick={() => setGalleryOpen(true)} className="grimoire-action-btn" data-tip={t.gallery_title}><IconImage />{t.gallery_btn}</button>
                  <button type="button" onClick={() => { setMoreOpen(false); setIsEditing(true); }} className="grimoire-action-btn" data-tip={t.edit_meta}><IconEdit />{t.edit_btn}</button>
                  <div className="modal-more" ref={moreRef}>
                    <button
                      type="button"
                      className={`grimoire-action-btn modal-more-btn${moreOpen ? ' open' : ''}`}
                      onClick={() => setMoreOpen(v => !v)}
                      aria-haspopup="menu"
                      aria-expanded={moreOpen}
                      aria-label={t.more_actions}
                      data-tip={t.more_actions}
                    >
                      <IconMore />
                    </button>
                    {moreOpen && (
                      <div className="modal-more-list" role="menu" ref={revealOnOpen}>
                        <button type="button" role="menuitem" className="modal-more-item" onClick={() => runMore(handleBackup)}><IconDownload />{t.backup}</button>
                        {/* Обычные ссылки: загрузку ведёт сам браузер (полоса, пауза, телефон). С сейвами — по умолчанию, первым */}
                        {[...(hasArchiveSaves ? [[t.archive_dl_saves, '?saves=1'], [t.archive_dl_plain, '']] : [[t.archive_dl, '']])].map(([label, q]) => (
                          <a key={q} role="menuitem" className="modal-more-item" href={`/api/games/${encodeURIComponent(game.id)}/archive${q}`} download onClick={handleArchive}>
                            <IconDownload /><span>{label}</span>
                            {game.size > 0 && <span className="modal-more-size">{formatSize(game.size)}</span>}
                          </a>
                        ))}
                        <button type="button" role="menuitem" className="modal-more-item" onClick={() => runMore(() => importRef.current.click())}><IconUpload />{isImporting ? t.import_wait : t.import}</button>
                        <button type="button" role="menuitem" className="modal-more-item" onClick={() => runMore(() => onUploadNewVersion?.(game))}><IconRefresh />{t.update_game}</button>
                        <button type="button" role="menuitem" className="modal-more-item" onClick={() => runMore(() => onUploadPatch?.(game))}><IconUpload />{t.patch_game}</button>
                        {game.oldVersions > 0 && (
                          <button type="button" role="menuitem" className="modal-more-item" onClick={() => runMore(handleRestoreOld)}><IconRefresh />{oldPatch ? t.old_restore_patch(oldPatch.replace(/\.(zip|7z|rar)$/i, '')) : t.old_restore}</button>
                        )}
                        {game.oldVersions > 0 && (
                          <button type="button" role="menuitem" className="modal-more-item danger" onClick={() => runMore(handleDeleteOld)}><IconTrash />{t.old_delete(oldSize ? formatSize(oldSize) : '')}</button>
                        )}
                        <button type="button" role="menuitem" className="modal-more-item danger" onClick={() => runMore(handleDelete)}><IconTrash />{t.delete_btn}</button>
                      </div>
                    )}
                  </div>
                  <input type="file" ref={importRef} accept=".zip" style={{ display: 'none' }} onChange={handleImportSelect} />
                </div>

                {/* Если метаданные не полные — видно, почему и что будет дальше. Раньше
                    это было не узнать: пометки «не найдено» жили в Redis и никуда не выводились */}
                {(() => {
                  const info = describeMeta(game.meta, t, lang);
                  if (!info) return null;
                  const busy = info.searching || searchQueued;
                  const parts = metaParts(game);
                  const noLink = parts.some(([key, ok]) => key === 'link' && !ok);
                  return (
                    <div className={`meta-status ${game.meta.status}`}>
                      <div className="meta-status-text">
                        <b>{busy ? t.meta_line_new : info.text}</b>
                        {/* Ищется сейчас — шаги по сайтам вживую; ждёт — какая по счёту */}
                        {busy && <LookupLive key={game.id} id={game.id} t={t} />}
                        {/* Что нашлось и чего нет — по пунктам */}
                        {!busy && (
                          <ul className="meta-parts">
                            {parts.map(([key, ok]) => (
                              <li key={key} className={ok ? 'ok' : 'no'}>{ok ? <IconCheck /> : <IconClose />}{t.meta_part[key]}</li>
                            ))}
                          </ul>
                        )}
                        {!busy && info.details && <span>{info.details}</span>}
                        {/* Что сделать: без ссылки поиск гадает по названию — ссылка или код RJ его направят */}
                        {!busy && <span className="meta-status-hint">{noLink ? t.meta_fix_link : t.meta_fix_other}</span>}
                      </div>
                      {!busy && (
                        <button type="button" className="meta-status-btn" onClick={handleRescrape}>{t.meta_search_now}</button>
                      )}
                      {/* Как искали в прошлый раз и похожие игры на других сайтах — выбрать одним нажатием */}
                      {!busy && <LookupHelp game={game} t={t} lang={lang} onPick={pickLink} />}
                    </div>
                  );
                })()}

                {/* Вкладки: окно влезает в экран, а не тянется лентой из сведений, кадров, тегов, перевода и прохождений
                    одного веса. Уведомления выше — то, на что надо ответить, — видны на любой вкладке */}
                <div className="modal-tabs" role="tablist" aria-label={t.modal_tabs} ref={tabsRef} onKeyDown={onTabsKey}>
                  {MODAL_TABS.map((key) => (
                    <button key={key} type="button" role="tab" id={`tab-${key}`} aria-selected={tab === key} aria-controls={tab === key ? 'modal-tab-panel' : undefined}
                      tabIndex={tab === key ? 0 : -1} className={`modal-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
                      {t.modal_tab[key]}
                      {key === 'shots' && shotsCount > 0 && <span className="modal-tab-count">{shotsCount}</span>}
                      {/* Перевод идёт — видно с любой вкладки */}
                      {key === 'translate' && tlRunning && <span className="modal-tab-dot" data-tip={t.tl_state.queued} />}
                    </button>
                  ))}
                </div>

                <div className="modal-tab-panel" role="tabpanel" id="modal-tab-panel" aria-labelledby={`tab-${tab}`}>
                  {tab === 'overview' && (
                    <>
                    {/* Длинное описание — свёрнуто до четырёх строк: оно уводило кадры за край окна */}
                    {game.description && (
                      <div className={`modal-description${longDesc && !descOpen ? ' clamped' : ''}`} id="modal-description">{game.description}</div>
                    )}
                    {longDesc && (
                      <button type="button" className="modal-desc-more" aria-expanded={descOpen} aria-controls="modal-description" onClick={() => setDescOpenId(descOpen ? null : game.id)}>
                        {descOpen ? t.desc_less : t.desc_more}
                      </button>
                    )}

                    {shots.length > 0 && <div className="modal-section-label">{t.fact_screens}</div>}
                    {shots.length > 0 && (
                      <div className="game-screens">
                        {shots.map(({ src, i }) => (
                          <button key={src} type="button" className="screen-thumb" onClick={() => setLightbox(i)} data-tip={t.screens_open}>
                            <img src={getMediaUrl(src, 360)} alt={`${game.displayTitle || game.title} — ${i + 1}`} loading="lazy" onError={() => markBad(src)} />
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="modal-section-label">{t.fact_tags}</div>
                    <div className="modal-tags">
                      {game.tags && game.tags.length > 0 ? (
                        <>
                          {(showAllTags ? orderedTags : orderedTags.slice(0, TAGS_SHOWN)).map(tag => (
                            // Тег — кнопка, а не текст: клик уводит в библиотеку, отфильтрованную
                            // по нему. Раньше «а что ещё есть такого же» приходилось искать руками
                            // в выпадающем списке, хотя ответ был прямо перед глазами.
                            <button
                              key={tag}
                              type="button"
                              className={`tag tag-link${favTags.includes(tag) ? ' tag-fav' : ''}`}
                              onClick={() => onTagClick?.(tag)}
                              data-tip={t.tag_filter_by(tag)}
                            >
                              {favTags.includes(tag) && <IconHeart />}{tag}
                            </button>
                          ))}
                          {game.tags.length > TAGS_SHOWN && (
                            <button type="button" className="tag tag-more" onClick={() => setShowAllTags(v => !v)}>
                              {showAllTags ? t.tags_less : t.tags_more(game.tags.length - TAGS_SHOWN)}
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="tag" style={{ opacity: 0.5, borderColor: 'transparent' }}>{t.no_tags}</span>
                      )}
                    </div>
                    </>
                  )}
                  {tab === 'info' && (
                    <>
                    {/* Сведения — сеткой «подпись над значением», как «Dateiinfo» в RomM; поле без значения не показывается */}
                    <div className="info-grid">
                      {[
                        [t.meta_dev, <span className="meta-value">{game.developer || t.meta_unknown}</span>],
                        game.releaseDate && [t.meta_release, <span className="meta-value">{formatReleaseDate(game.releaseDate)}</span>],
                        // Язык неизвестен — поля нет: «Язык: —» ничего не говорит
                        languageLine(game, t, lang) && [t.meta_lang, <span className="meta-value">{languageLine(game, t, lang)}</span>],
                        game.version && [t.meta_version, <span className="meta-value">{game.version}</span>],
                        [t.meta_size, <span className="meta-value">{formatSize(game.size)}</span>],
                        [t.meta_added, <span className="meta-value">{formatDate(game.addedAt)}</span>],
                      ].filter(Boolean).map(([label, value]) => (
                        <div key={label} className="meta-item">
                          {/* Подписи в локалях — с двоеточием («Разработчик:»); над значением оно лишнее */}
                          <span className="meta-label">{plain(label)}</span>
                          {value}
                        </div>
                      ))}
                    </div>

                    </>
                  )}
                  {tab === 'path' && <PathPanel key={`path-${game.id}`} game={game} t={t} lang={lang} shots={myShots} onPlay={playFrom} />}
                  {tab === 'shots' && (
                    <ShotsPanel key={`shots-${game.id}`} game={game} t={t} lang={lang} shots={myShots} notify={notify} onPlay={playFrom}
                      onCover={(coverPath) => onUpdateGame(index, { ...game, cover: coverPath })} />
                  )}
                  {/* Перевод игры: язык, ход, готовый файл перевода (TranslateBar.jsx). Скрыт, а не убран, на других вкладках:
                      иначе полоса теряла бы своё («Всё равно перевести», проверку), а ход перевода — на точке ярлыка.
                      key — своя полоса у каждой игры: «Всё равно перевести» не переносится на следующую */}
                  <div hidden={tab !== 'translate'}>
                    <TranslateBar key={game.id} game={game} t={t} lang={lang} notify={notify} known={knownLang}
                      onLang={(l) => setMimikin((p) => (p.id === game.id && p.lang === l ? p : { id: game.id, lang: l }))}
                      onRunning={(on) => setTlRun((p) => (p.id === game.id && p.on === on ? p : { id: game.id, on }))} />
                  </div>
                </div>

              </>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Просмотрщик рисуем прямо в body: у окна игры есть backdrop-filter, а он
          становится точкой отсчёта для position: fixed внутри — картинка выросла бы
          не во весь экран, а в рамку окна за вычетом его отступов */}
      {galleryOpen && <Suspense fallback={null}><GameGallery game={game} t={t} onClose={() => setGalleryOpen(false)} /></Suspense>}

      {lightbox !== null && game.screens?.length > 0 && createPortal(
        <div ref={lightboxRef} className={`lightbox${hidden ? ' covers-hidden' : ''}`} role="dialog" aria-modal="true" aria-label={game.displayTitle || game.title} tabIndex={-1} onClick={(e) => { e.stopPropagation(); setLightbox(null); }}>
          <button type="button" className="lightbox-close" aria-label={t.close} onClick={(e) => { e.stopPropagation(); setLightbox(null); }}><IconClose /></button>

          {game.screens.length > 1 && (
            <>
              <button
                type="button"
                className="lightbox-nav prev"
                aria-label={t.shelf_prev}
                onClick={(e) => { e.stopPropagation(); setLightbox(i => (i - 1 + game.screens.length) % game.screens.length); }}
              ><IconChevronLeft /></button>
              <button
                type="button"
                className="lightbox-nav next"
                aria-label={t.shelf_next}
                onClick={(e) => { e.stopPropagation(); setLightbox(i => (i + 1) % game.screens.length); }}
              ><IconChevronRight /></button>
            </>
          )}

          {/* Клик по самой картинке не закрывает: промахнуться мимо мелкой кнопки легко */}
          <img
            src={getMediaUrl(game.screens[lightbox])}
            alt={`${game.displayTitle || game.title} — ${lightbox + 1}`}
            onClick={(e) => e.stopPropagation()}
          />

          {game.screens.length > 1 && (
            <div className="lightbox-counter">{lightbox + 1} / {game.screens.length}</div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

export default GameModal;
