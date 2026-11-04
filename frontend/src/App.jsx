import { useCallback, useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { flushSync } from 'react-dom'
import { socket } from './socket'
import Header from './components/Header'
import { JdDownloads } from './components/JdProgress'
import Toolbar from './components/Toolbar'
import GameCard from './components/GameCard'
import GameModal from './components/GameModal'
// Редкие окна — отдельными кусками: грузятся при первом открытии, а не вместе со страницей
const LoginModal = lazy(() => import('./components/LoginModal'))
import Toast from './components/Toast'
import ConfirmHost from './components/ConfirmDialog'
import Tip from './components/Tip'
import { confirmDialog } from './confirm'
import { errorText, httpError } from './apiError'
import { getCoverUrl } from './coverUrl'
import { fmtSize } from './transferSize'
import { useLibraryLook } from './libraryLook'
import { groupGames, pageOfGroups } from './libraryGroups'
import { detectSeries } from './gameSeries'
import { ListHead, LookSwitch } from './components/LibraryLook'
import LibraryLetters from './components/LibraryLetters'
import LibrarySelect from './components/LibrarySelect'
import { useLibrarySelect } from './librarySelect'
import { showCard, useLibraryKeys } from './libraryKeys'
import LibraryMast from './components/LibraryMast'
import { loadLocale, locale, savedLang } from './locales'
import StorageMonitor from './components/StorageMonitor';
import ContinueCard from './components/ContinueCard';
import RecentPlayed from './components/RecentPlayed';
import { loadFavoriteTags } from './favoriteTags';
import { findStartTab } from './findData';
import { loadKnownLangs } from './knownLangs';
const LibraryModal = lazy(() => import('./components/LibraryModal'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const ShortcutsHelp = lazy(() => import('./components/ShortcutsHelp'));
// Отдельным куском вместе с пакетом QR-кода: окно открывают редко, основной бандл не растёт
const PhoneLink = lazy(() => import('./components/PhoneLink'));
const LookupQueue = lazy(() => import('./components/LookupQueue'));
import GameFrame from './components/GameFrame';
import MimicLoader from './components/MimicLoader';
import { useDelayedShow } from './useDelayedShow';
const loadPicker = () => import('./components/PlayPicker');
// Порядок столбца «Статус» в списке — как в статистике (StatsPanel)
const STATUS_ORDER = ['playing', 'done', 'dropped', 'wish', 'new'];
// Версии — как текст с числами: «1.10» новее «1.9». Точное сравнение (api/src/utils/version.js) живёт на сервере, а для порядка строк хватает этого
const VERSIONS = new Intl.Collator('en', { numeric: true });
const PlayPicker = lazy(loadPicker);
const FavoritesGallery = lazy(() => import('./components/FavoritesGallery'));
const PictureSearch = lazy(() => import('./components/PictureSearch'));
const PictureFeed = lazy(() => import('./components/PictureFeed'));
const LineSearch = lazy(() => import('./components/LineSearch'));
import { launchGame, withIntro, cancelLaunch, launchSignal } from './launchGame';
import LaunchIntro from './components/LaunchIntro';
import { latestOf, launchPoint, loadResume } from './resumePoint';
import { hideOnLeave } from './coversHidden';
import { mood } from './mimicMood';
import { layersOpen, useLayer } from './layers';
import { IconStats, IconUpload, IconDice, IconSettings, IconFavorites, IconImage, IconSearch, IconLines, IconPhone } from './components/icons';
import { pollJobs } from './jdJobs';
import JdLinkPanel from './components/JdLinkPanel';
import { effectiveStatus, shownStatus } from './gameStatus';
import StatusChips from './components/StatusChips';
import ListBar from './components/ListBar';
const Catalog = lazy(() => import('./components/Catalog'));
import { languageKey } from './formatLanguage';
import CheckStrip from './components/CheckStrip';
import Shelves from './components/Shelves';
import LineShelf from './components/LineShelf';
import Welcome from './components/Welcome';
import StateView from './components/StateView';
import { checkSummary } from './checkSummary';
import { currentMe, isOwner, loadMe, forgetPreferences, personChanged } from './me';

// Закладка «В Mimikin» открывает библиотеку с #jd=<адрес страницы файла>. Адрес забираем сразу и стираем из строки браузера:
// иначе он остался бы в записи истории, и «назад» из окна подтверждения возвращал бы его снова
function takeJdLink() {
  const m = /^#jd=(.+)$/.exec(window.location.hash);
  if (!m) return '';
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  try {
    const url = decodeURIComponent(m[1]);
    return /^https?:\/\/\S{1,2000}$/i.test(url) ? url : '';
  } catch { return ''; }
}
const TagPanel = lazy(() => import('./components/PictureTags').then((m) => ({ default: m.TagPanel })));
const TagPicked = lazy(() => import('./components/PictureTags').then((m) => ({ default: m.TagPicked })));
const firstJdLink = takeJdLink();


function App() {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  // Мимик, если показался, стоит не меньше 400 мс: список за 260 мс не должен оставлять вспышку
  const { busy: loadingShown } = useDelayedShow(loading);
  // Список игр не пришёл (сервер ответил ошибкой или не ответил): без этого пустой список выглядел как «библиотека пока пустая»
  const [gamesError, setGamesError] = useState(false);
  const [lang, setLang] = useState(savedLang);
  // Сменить язык: сначала догрузить его тексты, потом переключить — без мигания полупереведённого экрана
  const changeLang = (next) => { loadLocale(next).then(() => setLang(next)).catch(() => {}); };
  // Скрытие обложек: помним выбор между заходами, как и язык
  const [blurCovers, setBlurCovers] = useState(() => localStorage.getItem('rpg_blur') === '1');
  // Окно «Статистика и ревизия»: null — закрыто, иначе открытая вкладка
  const [libraryTab, setLibraryTab] = useState(null);
  // «Настройки»: null — закрыты, иначе вкладка, с которой открыть
  const [settingsTab, setSettingsTab] = useState(null);
  // Место в шапке для глаза и «Добавить игру» (Header → Toolbar)
  const [headerTools, setHeaderTools] = useState(null);
  // Быстро скрыть: клавиша H где угодно, кроме полей ввода, и поверх окон тоже — обложки размываются,
  // вкладка браузера подписана нейтрально. Ещё раз H — вернуть. Внутри игры в рамке клавиши у игры
  // Пока открыта игра, H — её «Скрыть» (GameFrame передаёт ей)
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'KeyH' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.game-frame')) return;
      e.preventDefault();
      setBlurCovers((v) => !v);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // «Прятать, когда сворачиваю» (Настройки → Основные): вкладку свернули — всё скрыто, как от H. Обратно само не
  // открывается: показать — H или нажатие, как и после H
  useEffect(() => {
    const onHide = () => { if (document.hidden && hideOnLeave()) setBlurCovers(true); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);
  // Игру скрыли (H в игре, GameFrame → rpg-quiet): вкладка подписана нейтрально, обложки размыты — на случай,
  // если игру закроют, не вернув. Вернули игру — как было до этого
  const blurRef = useRef(blurCovers);
  useEffect(() => { blurRef.current = blurCovers; }, [blurCovers]);
  // Обложки скрыты (H, кнопка-глаз, «Прятать, когда сворачиваю») — мимик в шапке закрывает глаза сразу
  useEffect(() => { mood.covers(blurCovers); }, [blurCovers]);
  const quietBefore = useRef(null);
  useEffect(() => {
    const onQuiet = (e) => {
      if (e.detail === null) { quietBefore.current = null; return; }
      if (e.detail) {
        if (quietBefore.current === null) quietBefore.current = blurRef.current;
        setBlurCovers(true);
      } else if (quietBefore.current !== null) {
        setBlurCovers(quietBefore.current);
        quietBefore.current = null;
      }
    };
    window.addEventListener('rpg-quiet', onQuiet);
    return () => window.removeEventListener('rpg-quiet', onQuiet);
  }, []);
  // «?» — окно со всеми клавишами. Когда поверх ничего не открыто и курсор не в поле ввода
  const [keysOpen, setKeysOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || layersOpen()) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      setKeysOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const [pickerOpen, setPickerOpen] = useState(false);
  // «Избранное» из галерей игр (FavoritesGallery)
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  // Поиск картинок по словам во всех галереях (PictureSearch)
  // { q, n } — открыто, q — с какими словами (тег из галереи: searchPictures); n — новое открытие сбрасывает окно
  const [picSearch, setPicSearch] = useState(null);
  useEffect(() => {
    const open = (e) => setPicSearch((p) => ({ q: String(e.detail?.q || ''), like: e.detail?.like || null, n: (p?.n || 0) + 1 }));
    window.addEventListener('rpg-pictures', open);
    return () => window.removeEventListener('rpg-pictures', open);
  }, []);
  // Поиск по репликам сцен (LineSearch): null — закрыт, иначе запрос, с которым открыли (из меню — пустой)
  const [lineSearch, setLineSearch] = useState(null);
  // Игра, которую выплюнул мимик (пять щелчков по знаку): окно открывается уже на ней
  const [pickerStart, setPickerStart] = useState(null);
  const closePicker = useMemo(() => () => { setPickerOpen(false); setPickerStart(null); }, []);
  const spitTimer = useRef(0);
  useEffect(() => () => clearTimeout(spitTimer.current), []);
  const spitGame = () => {
    // Код окна грузим уже на пятом щелчке, пока летит обложка: иначе в первый раз за вкладку после неё пусто
    loadPicker();
    const pool = games.filter((g) => ['new', 'wish'].includes(effectiveStatus(g)));
    if (!pool.length) return;
    const id = pool[Math.floor(Math.random() * pool.length)].id;
    const open = () => { setPickerStart(id); setPickerOpen(true); };
    clearTimeout(spitTimer.current);
    // Обложка летит из рта 320–480 мс, потом окно; «уменьшить движение» и вкладка в фоне — сразу окно
    const ms = mood.spit();
    if (ms) spitTimer.current = setTimeout(open, ms); else open();
  };
  // Игра в рамке на весь экран (launchGame → событие rpg-play): { game, url, origin }
  const [playing, setPlaying] = useState(null);
  // Переход «Играть» (LaunchIntro): { game, from } с нажатия до чёрного экрана и запущенной игры. Ошибка запуска
  // (rpg-intro-end) убирает слой сразу
  const [intro, setIntro] = useState(null);
  useEffect(() => {
    const start = (e) => setIntro((cur) => cur || e.detail);
    const end = () => setIntro(null);
    window.addEventListener('rpg-intro', start);
    window.addEventListener('rpg-intro-end', end);
    return () => { window.removeEventListener('rpg-intro', start); window.removeEventListener('rpg-intro-end', end); };
  }, []);
  useEffect(() => {
    const onPlay = (e) => setPlaying(e.detail);
    window.addEventListener('rpg-play', onPlay);
    return () => window.removeEventListener('rpg-play', onPlay);
  }, []);
  const [catalogKey, setCatalogKey] = useState(0);
  // С чего открыть «Найти»: выдача itch.io или «Отложенные» (findData.js). Страница перезагрузилась на этой вкладке — с того, что выбрали в прошлый раз
  const [catalogTab, setCatalogTab] = useState(() => findStartTab());
  // «Отложенные»: игры, отложенные закладкой
  const [wishlist, setWishlist] = useState({ items: [] });
  const [wishReady, setWishReady] = useState(false);
  // Полная проверка библиотеки («Проверить всё» в ревизии). Её ход сервер шлёт по сокету всем
  // устройствам: полоса под шапкой видна и с закрытым окном. В ref — для обработчиков сокета
  const [check, setCheck] = useState(null);
  const checkRef = useRef(null);
  // Сколько игр ещё ждёт сбора метаданных — приходит с сервера по сокету
  const [scrapeLeft, setScrapeLeft] = useState(0);
  // Очередь поиска на паузе (игры ждут) и открыто ли окно очереди
  const [scrapePaused, setScrapePaused] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  
  useEffect(() => {
    localStorage.setItem('rpg_lang', lang);
    // Язык страницы — для читалок, переносов и переводчика браузера
    document.documentElement.lang = lang;
  }, [lang]);
  
  useEffect(() => {
    localStorage.setItem('rpg_blur', blurCovers ? '1' : '0');
  }, [blurCovers]);

  const t = locale(lang);
  // Обложки скрыты — и вкладка браузера подписана нейтрально: на панели вкладок не видно, что открыто
  useEffect(() => {
    document.title = blurCovers ? t.quiet_title : 'Mimikin';
  }, [blurCovers, t]);
  // Обработчики сокета заводятся один раз, а язык могут сменить потом
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  // Поиск — на сессию: найденный на неделе назад текст молча прятал бы игры. Жанр, сортировка, статус и язык
  // переживают новую вкладку и перезапуск (localStorage); раз прочитанное из старого sessionStorage подхватываем
  const kept = (key) => {
    try { return localStorage.getItem(key) ?? sessionStorage.getItem(key); } catch { return null; }
  };
  const [searchQuery, setSearchQuery] = useState(() => { try { return sessionStorage.getItem('rpg_search') || ''; } catch { return ''; } });
  const [selectedTag, setSelectedTag] = useState(() => kept('rpg_tag') || 'all');
  const [currentSort, setCurrentSort] = useState(() => kept('rpg_sort') || 'newest');
  // «Избранное» убрано — сохранённый с тех пор фильтр по нему становится «Все»
  const [statusFilter, setStatusFilter] = useState(() => {
    const saved = kept('rpg_status');
    return saved && saved !== 'fav' ? saved : 'all';
  });
  // Язык по тексту самой игры: «всё, во что можно играть на русском» — одним выбором
  const [langFilter, setLangFilter] = useState(() => kept('rpg_langf') || 'all');
  // Своя подборка, '' — все (подборка может называться как угодно, и «all» тоже). Её могли удалить, пока страница была закрыта:
  // тогда как все
  const [listPick, setListFilter] = useState(() => kept('rpg_list') || '');
  const allLists = useMemo(() => [...new Set(games.flatMap((g) => g.lists || []))].sort((a, b) => a.localeCompare(b)), [games]);
  const listFilter = allLists.includes(listPick) ? listPick : '';

  useEffect(() => {
    // Приватное окно и запрет хранилища бросают исключение — фильтры тогда просто не запоминаются
    try {
      sessionStorage.setItem('rpg_search', searchQuery);
      localStorage.setItem('rpg_tag', selectedTag);
      localStorage.setItem('rpg_sort', currentSort);
      localStorage.setItem('rpg_status', statusFilter);
      localStorage.setItem('rpg_langf', langFilter);
      localStorage.setItem('rpg_list', listPick);
    } catch { /* не запомнится — не страшно */ }
  }, [searchQuery, selectedTag, currentSort, statusFilter, langFilter, listPick]);

  // Фильтр библиотеки по тому, что нарисовано (сервер: gallery.js, libraryTags). Не запоминаем, как и поиск: разбор кадров идёт,
  // сводка меняется — поэтому и читаем её заново при каждом открытии панели. Только размеченные игры: про остальные нечего сказать
  const [picYes, setPicYes] = useState([]);
  const [picNo, setPicNo] = useState([]);
  const [picPanel, setPicPanel] = useState(false);
  const [picIndex, setPicIndex] = useState(null);   // { covered, games: Map(игра → Map(тег → кадров)) }
  const picBtn = useRef(null);
  // Есть ли у этого человека разобранные игры и избранное: без них панель открылась бы с одной фразой, а пункты меню — с «пока пусто».
  // Лёгкий ответ, сам список — при открытии. Спрашиваем при смене страницы и при открытии меню: разбор идёт, сердечки ставят.
  // null — ответа ещё нет или сервер не ответил: пункты меню тогда на месте, прятать что-то по незнанию нельзя
  const [picInfo, setPicInfo] = useState(null);
  const picAny = !!picInfo?.tagged;
  const askPicInfo = useCallback(() => fetch('/api/pictures/status?peek=1&tagged=1').then((r) => (r.ok ? r.json() : null)).then((d) => d && setPicInfo(d), () => {}), []);
  useEffect(() => {
    if (!picPanel) return undefined;
    let alive = true;
    fetch('/api/pictures/games').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d) => {
      if (!alive) return;
      const games = new Map(Object.entries(d.games).map(([id, row]) => {
        const tags = new Map();
        for (let k = 0; k < row.length; k += 2) tags.set(d.tags[row[k]], row[k + 1]);
        return [id, tags];
      }));
      setPicIndex({ covered: d.covered, games });
    }, () => { if (alive) setPicIndex((was) => was || { covered: 0, games: new Map() }); });
    return () => { alive = false; };
  }, [picPanel]);
  const picOn = picYes.length + picNo.length > 0;
  const picOf = useCallback((id) => picIndex?.games.get(id), [picIndex]);
  const pickPic = (tag) => { setPicYes(picYes.includes(tag) ? picYes.filter((x) => x !== tag) : [...picYes, tag]); setPicNo(picNo.filter((x) => x !== tag)); };
  const notPic = (tag) => { setPicNo(picNo.includes(tag) ? picNo.filter((x) => x !== tag) : [...picNo, tag]); setPicYes(picYes.filter((x) => x !== tag)); };
  const resetPic = () => { setPicYes([]); setPicNo([]); };

  const filtersActive = !!searchQuery || selectedTag !== 'all' || statusFilter !== 'all' || langFilter !== 'all' || !!listFilter || picOn;
  const resetFilters = () => {
    resetPic();
    setSearchQuery('');
    setSelectedTag('all');
    setStatusFilter('all');
    setLangFilter('all');
    setListFilter('');
  };

  // Две страницы, как у Steam и Jellyfin: «Главная» — то, к чему возвращаются (продолжить, недавние,
  // обновления, новые), «Библиотека» — все игры с поиском и фильтрами. Раньше всё шло одной лентой:
  // три полки по 12 обложек с повторами, а под ними ещё все игры — больше сотни обложек подряд.
  // Библиотека — слой в истории (layers.js): жест «назад» возвращает на главную
  // «Найти» — третья страница: раньше она открывалась окном из меню «⋯», и о ней мало кто знал
  const [view, setView] = useState(() => (['library', 'new'].includes(sessionStorage.getItem('rpg_view')) ? sessionStorage.getItem('rpg_view') : 'home'));
  useEffect(() => {
    sessionStorage.setItem('rpg_view', view);
    window.scrollTo(0, 0);
  }, [view]);
  const mainRef = useRef(null);
  useLayer(mainRef, () => setView('home'), { active: view !== 'home', modal: false, escape: false, trap: false, focus: false });
  // «Все» на полке главной и «Вся библиотека» — подборка целиком: прежние поиск и фильтры сбрасываем
  const showLibrary = ({ sort, status = 'all' } = {}) => {
    resetFilters();
    setStatusFilter(status);
    if (sort) setCurrentSort(sort);
    setView('library');
  };
  const showShelf = (key) => (key.startsWith('list:') ? openList(key.slice(5)) : showLibraryOf(key));
  const openList = (name) => {
    setSelectedGame(null);
    resetFilters();
    setListFilter(name);
    setView('library');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  // Переименовать (name) или удалить подборку. Сначала на экране, потом на сервере: не вышло — вернём только списки этих игр,
  // остальное за это время могло измениться. Имя существующей с другим регистром — та же подборка, как и при добавлении игры
  const changeList = async (from, name) => {
    const to = name && (allLists.find((x) => x !== from && x.toLowerCase() === name.toLowerCase()) || name);
    const before = new Map(games.filter((g) => g.lists?.includes(from)).map((g) => [g.id, g.lists]));
    const swap = (list) => [...new Set(list.flatMap((x) => (x === from ? (to ? [to] : []) : [x])))];
    setGames((prev) => prev.map((g) => (g.lists?.includes(from) ? { ...g, lists: swap(g.lists) } : g)));
    setListFilter(to || '');
    try {
      const res = await fetch('/api/games/lists/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(to ? { from, to } : { from }) });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setGames((prev) => prev.map((g) => (before.has(g.id) ? { ...g, lists: before.get(g.id) } : g)));
      setListFilter(from);
      showToast(t.lists_err, 'error');
    }
  };
  const deleteList = async (name) => {
    if (await confirmDialog({ title: t.lists_delete_q(name), text: t.lists_delete_text, confirmLabel: t.lists_delete })) changeList(name);
  };
  const showLibraryOf = (key) => showLibrary({ played: { sort: 'recent' }, unplayed: { status: 'new' }, added: { sort: 'newest' } }[key]);
  // Искать начинают и с главной — найденное показывает библиотека
  const search = (query) => {
    setSearchQuery(query);
    if (query.trim()) setView('library');
  };

  // Кнопку «Добавить игру» на телефоне убрали в меню, а сама загрузка живёт в панели:
  // панель кладёт сюда функцию, которая открывает выбор файла
  const openUploadRef = useRef(null);

  const [selectedGame, setSelectedGame] = useState(null);
  const [authMode, setAuthMode] = useState(null);
  // Кто вошёл (me.js). Владелец видит всё; остальные люди — библиотеку, свои сейвы и заметки. Состоянием, чтобы страница
  // перерисовалась после входа; остальные части читают isOwner() из me.js
  const [me, setMe] = useState(currentMe);
  const owner = !me || me.isOwner;
  // Имя, картинка или роль человека изменились (он сам или главный администратор, на этом устройстве или другом): шапка и
  // «Мой профиль» берут их из me. Нет ответа — остаётся прежнее
  const refreshMe = async () => {
    const before = currentMe();
    const now = await loadMe();
    setMe(now || before);
  };
    // Вошёл ли пользователь: виджеты, которым нужен вход (StorageMonitor), показываем только после него
  const [isAuthed, setIsAuthed] = useState(false);
  useEffect(() => { if (isAuthed) askPicInfo(); }, [view, isAuthed, askPicInfo]);
  // Права человека: кнопка «Добавить игру» и ход загрузок. Изменил владелец — приходит rights-changed, страница не перезагружается
  const canUpload = isAuthed && (owner || !!me?.rights?.upload);
  const seesJobs = isAuthed && (owner || !!me?.rights?.view);
  // Страница файла от закладки «В Mimikin»: окно подтверждения открывается после входа
  const [jdLink, setJdLink] = useState(firstJdLink);
  useEffect(() => {
    // Переход по ссылке с #jd=… внутри открытой страницы — это popstate: браузеры шлют его и при смене одного «#»
    const onHash = () => { const url = takeJdLink(); if (url) setJdLink(url); };
    window.addEventListener('popstate', onHash);
    return () => window.removeEventListener('popstate', onHash);
  }, []);

  // --- ЛЕНИВАЯ ЗАГРУЗКА (PAGINATION) ---
  const [page, setPage] = useState(1);
  const itemsPerPage = 24;
  const loaderRef = useRef(null);

  // Фильтры поменялись — снова с первой страницы. Сверяем при отрисовке, а не эффектом: эффект
  // сначала показал бы прежнюю страницу и только следом — первую
  const filterKey = [searchQuery, selectedTag, currentSort, statusFilter, langFilter, listFilter, ...picYes, '', ...picNo].join('\u0000');
  // Ушли из библиотеки — панель «Теги картинок» закрываем: иначе при возврате она откроется сама
  const [picView, setPicView] = useState(view);
  if (picView !== view) {
    setPicView(view);
    setPicPanel(false);
  }
  const [pageFilters, setPageFilters] = useState(filterKey);
  if (pageFilters !== filterKey) {
    setPageFilters(filterKey);
    setPage(1);
  }

  const [toast, setToast] = useState({ message: '', type: 'success', visible: false });
  const toastTimerRef = useRef(null);

  // action — кнопка в тосте («Отменить»): с ним тост висит дольше, чтобы успеть нажать.
  // background — тост пришёл сам, не в ответ на нажатие (ход проверки по сокету): мимик на него не дрожит
  const showToast = (message, type = 'success', action = null, { background = false } = {}) => {
    if (type === 'error' && !background) mood.error();
    setToast({ message, type, visible: true, action });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }));
    }, action ? 10000 : 4000);
  };
  const hideToast = () => {
    clearTimeout(toastTimerRef.current);
    setToast(prev => ({ ...prev, visible: false }));
  };

  // «Отложенные»: игры, отложенные закладкой
  const fetchWishlist = async () => {
    try {
      const res = await fetch('/api/wishlist');
      if (res.ok) {
        setWishlist(await res.json());
        setWishReady(true);
      }
    } catch { /* подтянется со следующим событием сервера */ }
  };

  // Новое состояние полной проверки. Шла и закончилась — на глазах или пока вкладка спала — итог
  // одной строкой (подробный — в ревизии); оборвал перезапуск сервера — так и говорим
  const applyCheck = (state) => {
    const was = checkRef.current;
    checkRef.current = state;
    setCheck(state);
    // Полная проверка — работа в фоне без своего мимика: шапка жуёт, пока она идёт
    mood.work('check', !!state.running);
    if (!was?.running || state.running) return;
    if (state.interrupted) showToast(tRef.current.check_interrupted, 'error', null, { background: true });
    else showToast(checkSummary(state, tRef.current), 'success');
  };

  // Идёт ли полная проверка и чем кончилась последняя. Пока вкладка спала, события сокета
  // могли пройти мимо — поэтому и при каждом возвращении на неё
  const fetchCheck = async () => {
    try {
      const res = await fetch('/api/check');
      if (res.ok) applyCheck(await res.json());
    } catch { /* придёт со следующим событием сервера */ }
  };

  // Из игры вернулись: наигранное время и прогресс поменялись
  const closeGame = () => {
    setPlaying(null);
    // Рамку закрыли, пока шёл переход «Играть» (Назад): чёрный слой снимается только когда игра запущена — иначе он завис бы
    setIntro(null);
    fetchGames({ silent: true });
  };

  // Сейвы, которые игра на адресе библиотеки (до сервера игр) не успела отправить без сети, лежат
  // в хранилище этого адреса, а игры теперь на другом — туда их не увидят. Досылаем отсюда: сервер
  // сам решит, чей сейв новее, и старый не затрёт. Имя игры в ключе бывает прежним, «исправленным»
  useEffect(() => {
    // Очереди в этом браузере — владельца (у людей ключ с их id, игра досылает их сама). Человеку чужую очередь слать нельзя:
    // она легла бы в его сейвы
    if (!games.length || !isOwner()) return;
    const legacy = (id) => id.replace(/[^a-zA-Z0-9._\-а-яА-Я]/g, '_');
    const byName = new Map();
    for (const g of games) { byName.set(g.id, g.id); if (!byName.has(legacy(g.id))) byName.set(legacy(g.id), g.id); }
    let keys;
    try { keys = Object.keys(localStorage).filter((k) => k.startsWith('_rpg_offline_queue_')); } catch { return; }
    for (const storageKey of keys) {
      const id = byName.get(storageKey.slice('_rpg_offline_queue_'.length));
      let queue = null;
      try { queue = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* битая — пропускаем */ }
      if (!id || !queue || typeof queue !== 'object') continue;
      Promise.all(Object.entries(queue).map(([key, payload]) => fetch(`/api/saves/${encodeURIComponent(id)}/${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then((r) => { if (!r.ok) throw new Error(r.status); })))
        .then(() => localStorage.removeItem(storageKey))
        .catch(() => { /* попробуем при следующем открытии */ });
    }
  }, [games.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Страницу открыли с «?play=<игра>» (обновили её во время игры) — открыть игру снова, когда список
  // загрузится. Ключ игры выдаётся заново: старый адрес рамки после выхода из библиотеки не годится.
  // С того же места, что «Играть» (самый свежий сейв, момент или «Где вышли»), а не с титула: так Safari на iPhone
  // возвращает выгруженную вкладку — открывает её заново по этому адресу
  const playParamRef = useRef(new URLSearchParams(window.location.search).get('play'));
  useEffect(() => {
    const id = playParamRef.current;
    if (!id || !games.length) return;
    playParamRef.current = null;
    // Сам «?play=» из адреса убираем: рамка поставит его заново, а выход из игры вернёт чистый адрес
    const params = new URLSearchParams(window.location.search);
    params.delete('play');
    window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
    const game = games.find((g) => g.id === id);
    if (game) loadResume(game.id).then((data) => launchGame(game, undefined, launchPoint(latestOf(data, t)))).catch(() => {});
  }, [games]); // eslint-disable-line react-hooks/exhaustive-deps

  const retryTimer = useRef(null);
  const retryDelay = useRef(0);
  useEffect(() => () => clearTimeout(retryTimer.current), []);
  const fetchGames = async ({ silent = false } = {}) => {
    // Тихое обновление — без индикатора: данные приехали сами, пользователь ничего не ждёт
    if (!silent) setLoading(true);
    try {
      const statusRes = await fetch('/api/setup/status');
      const statusData = await statusRes.json().catch(() => null);
      // Сервер перезапускается или прокси не достучался — это не «библиотека не настроена»: экран создания владельца
      // показывать нельзя, спросим снова чуть позже
      if (!statusRes.ok || typeof statusData?.initialized !== 'boolean') throw Object.assign(new Error(`setup/status: ${statusRes.status}`), { retry: true });

      if (!statusData.initialized) {
        setAuthMode('setup');
        setIsAuthed(false);
        setLoading(false);
        return;
      }

      // Страница спрашивала, кто вошёл, ещё до первой отрисовки; не ответили тогда — спросим теперь
      if (!currentMe()) await loadMe();
      setMe(currentMe());
      // Временный пароль (новый человек, сброс владельцем): библиотеки не видно, пока не выбран свой — сервер её и не отдаст
      if (currentMe()?.mustChange) {
        setAuthMode('change');
        setIsAuthed(false);
        setLoading(false);
        return;
      }
      const response = await fetch('/api/games');
      if (response.status === 401) {
        setAuthMode('login');
        setIsAuthed(false);
        setLoading(false);
        return;
      }

      if (!response.ok) throw Object.assign(new Error(`games: ${response.status}`), { retry: true });
      const data = await response.json();
      clearTimeout(retryTimer.current);
      retryDelay.current = 0;
      setGamesError(false);
      setGames(data);
      // Игру могли изменить или удалить с другого устройства, пока окно открыто
      setSelectedGame(prev => {
        if (!prev) return null;
        const fresh = data.find(g => g.id === prev.game.id);
        return fresh ? { ...prev, game: fresh } : null;
      });
      setAuthMode(null);
      setIsAuthed(true);
      // «Отложенные» и полная проверка — вместе с играми: и после входа, и когда вкладку снова открыли
      fetchWishlist();
      // Полная проверка, любимые теги, знакомые языки и очередь поиска — настройки и работа владельца: человеку сервер
      // ответил бы отказом на каждый запрос
      if (isOwner()) {
        fetchCheck();
        loadFavoriteTags();
        // Знакомые языки — тоже здесь, а не при открытии окна: ответ приходил посреди полёта окна и перерисовывал его
        loadKnownLangs();
        // Очередь поиска: сколько ждут и не на паузе ли — полоса видна и до первого события сервера
        fetch('/api/games/lookup-queue').then((r) => (r.ok ? r.json() : null))
          .then((q) => { if (q) { setScrapeLeft(q.left); setScrapePaused(q.paused); } }).catch(() => {});
      }
      // Свежий список — тому, кто ждал его, чтобы сразу открыть игру из него (handleShelfMatch)
      return data;
    } catch (error) {
      console.error("Ошибка загрузки игр:", error);
      setGamesError(true);
      // Сервер не ответил (перезапуск, сеть) — повторяем тихо: одна цепочка, пауза 3, 6, 12… до 30 секунд
      if (error?.retry || error instanceof TypeError) {
        clearTimeout(retryTimer.current);
        retryDelay.current = Math.min(30000, (retryDelay.current || 1500) * 2);
        retryTimer.current = setTimeout(() => fetchGames({ silent: true }), retryDelay.current);
      }
    } finally {
      setLoading(false);
    }
  };

  // События от сервера прилетают пачкой: игра добавлена, посчитан размер, найдены теги.
  // Обновляем список один раз, через 800 мс после последнего события.
  const refetchTimer = useRef(null);
  const scheduleRefetch = () => {
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => fetchGames({ silent: true }), 800);
  };

  // Сокет — только со входом: без него сервер отвечает 403, и страница входа стучалась бы каждые 5 секунд.
  // После входа подключаемся сами, перезагрузка не нужна
  useEffect(() => {
    if (isAuthed) socket.connect();
    else socket.disconnect();
    // Загрузки JDownloader — у владельца и у человека с правом их видеть
    pollJobs(seesJobs);
  }, [isAuthed, seesJobs]);

  useEffect(() => {
    fetchGames();
    socket.on('scrape-success', (data) => {
      // Во время полной проверки данные ищутся для всех игр подряд: её ход виден в полосе под
      // шапкой, а уведомление на каждую игру только мешало бы
      // Сервер шлёт вид события и название, текст берём из переводов: готовая русская строка на en и de не годится
      const toast = data.kind && tRef.current.scrape_toast?.[data.kind];
      if (!checkRef.current?.running) {
        showToast(toast ? toast(data.title, data.count) : data.message, 'success');
        // Монета в шапке — как тост: во время полной проверки данные ищутся для всех игр, на каждую она не нужна
        mood.done();
      }
      scheduleRefetch();
    });

    // Кто-то изменил библиотеку с другого устройства — тихо подтягиваем список
    socket.on('library-changed', () => scheduleRefetch());
    // Своё имя или картинку изменили (на другом устройстве или главный администратор): шапка перечитывает, кто вошёл
    const onAccount = () => { loadMe().then((now) => { if (now) setMe(now); }); };
    socket.on('account-changed', onAccount);
    socket.on('rights-changed', onAccount);
    // Вход этой вкладки закрыли (выход на другом устройстве, смена или сброс пароля): сервер оборвал связь сам. Страница
    // перезагружается и показывает вход. Выкладка новой версии рвёт связь по другой причине (transport close) — её не трогаем
    const onDisconnect = (reason) => { if (reason === 'io server disconnect') window.location.reload(); };
    socket.on('disconnect', onDisconnect);
    socket.on('scrape-progress', ({ left, paused }) => { setScrapeLeft(left); setScrapePaused(!!paused); mood.work('queue', left > 0 && !paused); });
    // Поиск данных одной игры: шапка жуёт, пока он идёт (в очереди они идут один за другим)
    const lookups = new Set();
    const onLookupStart = ({ id }) => { lookups.add(id); mood.work('lookup', true); };
    const onLookupDone = ({ id }) => { lookups.delete(id); mood.work('lookup', lookups.size > 0); };
    socket.on('lookup-start', onLookupStart);
    socket.on('lookup-done', onLookupDone);
    // Новая игра встала на полку (после финала плашки загрузки, landing.js) — «готово» и в шапке
    const onLanded = () => mood.done();
    window.addEventListener('rpg-landed', onLanded);

    // Список «Отложенные» поменяли на другом устройстве
    socket.on('wishlist-changed', () => fetchWishlist());
    // Ход полной проверки
    socket.on('fullcheck', (state) => applyCheck(state));

    // Вернулись на вкладку: если в соседней вошёл другой человек, перезагружаем — иначе правки уйдут не тому
    const refresh = () => personChanged().then((other) => (other ? window.location.reload() : fetchGames({ silent: true })));
    const handleVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    const handlePageShow = (event) => {
      if (event.persisted) refresh();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      clearTimeout(refetchTimer.current);
      socket.off('scrape-success');
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      socket.off('library-changed');
      socket.off('account-changed', onAccount);
      socket.off('rights-changed', onAccount);
      socket.off('disconnect', onDisconnect);
      socket.off('scrape-progress');
      socket.off('lookup-start', onLookupStart);
      socket.off('lookup-done', onLookupDone);
      window.removeEventListener('rpg-landed', onLanded);
      mood.work('lookup', false);
      mood.work('queue', false);
      socket.off('fullcheck');
      socket.off('wishlist-changed');
    };
    // Обработчики сокета заводятся один раз: функции, которые они зовут, трогают только setState и
    // ref (tRef, checkRef), поэтому свежие копии им не нужны
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // «Проверить всё» и «Отменить» в ревизии: сервер отвечает сразу, ход придёт по сокету.
  // Отменённая останавливается на ближайшей игре — итог придёт, когда она встанет
  const postCheck = async (path) => {
    try {
      const res = await fetch(path, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyCheck(await res.json());
    } catch {
      showToast(t.err_net, 'error');
    }
  };
  const startCheck = () => postCheck('/api/check');
  const cancelCheck = () => postCheck('/api/check/cancel');

  // «Отложенные» из вкладки «Найти»: отложить игру, убрать.
  // Убираем сразу, не дожидаясь сервера: закладка гаснет под пальцем
  const handleWishAdd = async (item) => {
    try {
      const res = await fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entry = await res.json();
      setWishlist(prev => ({ ...prev, items: [entry, ...prev.items.filter(x => x.key !== entry.key)] }));
    } catch {
      showToast(t.wish_error, 'error');
    }
  };
  const handleWishRemove = async (key) => {
    setWishlist(prev => ({ ...prev, items: prev.items.filter(x => x.key !== key) }));
    try {
      const res = await fetch(`/api/wishlist?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      showToast(t.wish_error, 'error');
      fetchWishlist();
    }
  };
  // «Все» в меню и переходы извне открывают «Найти» на нужном режиме. catalogKey — заново с этим началом, даже если
  // страница уже открыта. Память последнего выбора это не меняет (findData.js)
  const openCatalog = (tab) => {
    setCatalogTab(tab);
    setCatalogKey((k) => k + 1);
    setView('new');
  };

  // Вернуть игру из корзины — из тоста «Отменить» и из «Настроек → Корзина»
  // done — текст тоста: у файлов игры с полки свой («можно играть»)
  const restoreFromTrash = async (key, done = t.trash_restored) => {
    try {
      const res = await fetch(`/api/games/trash/${encodeURIComponent(key)}/restore`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      await fetchGames({ silent: true });
      showToast(done, 'success');
      return true;
    } catch (e) {
      showToast(errorText(t, e, { byStatus: { 409: t.trash_taken } }), 'error');
      return false;
    }
  };

  // Возвращает, удалилась ли игра. Спрашиваем своим окном: с обложкой и названием, что именно
  // удалится и что останется (сейвы)
  const handleDeleteGame = async (game) => {
    const ok = await confirmDialog({
      title: t.burn_title,
      name: game.displayTitle || game.title,
      cover: getCoverUrl(game, 360),
      text: t.burn_text,
      confirmLabel: t.burn,
      danger: true,
    });
    if (!ok) return false;

    try {
      const res = await fetch(`/api/games/${encodeURIComponent(game.id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setGames(prevGames => prevGames.filter(g => g.id !== game.id));
        // Игра в корзине 30 дней — «Отменить» возвращает её сразу, со всеми данными
        showToast(t.burn_done, 'success', data.trashKey ? { label: t.undo, onClick: () => { hideToast(); restoreFromTrash(data.trashKey); } } : null);
        return true;
      }
      showToast(errorText(t, { status: res.status, error: data.error }, { fallback: t.burn_err }), 'error');
    } catch {
      showToast(t.err_net, 'error');
    }
    return false;
  };

  // «На полку»: файлы — в корзину, карточка, сейвы и время — здесь (services/trash.js). Окно игры остаётся открытым и
  // показывает, как вернуть; тост «Отменить» кладёт файлы назад сразу
  const handleShelveGame = async (game) => {
    const ok = await confirmDialog({
      title: t.shelf_q,
      name: game.displayTitle || game.title,
      cover: getCoverUrl(game, 360),
      text: t.shelf_text(game.size > 0 ? fmtSize(game.size, t) : ''),
      confirmLabel: t.shelf_confirm,
    });
    if (!ok) return false;
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/shelf`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      await fetchGames({ silent: true });
      showToast(t.shelf_done, 'success', data.trashKey ? { label: t.undo, onClick: () => { hideToast(); restoreFromTrash(data.trashKey, t.shelf_restored); } } : null);
      return true;
    } catch (e) {
      showToast(errorText(t, e, { fallback: t.shelf_err }), 'error');
      return false;
    }
  };

  // «Похоже, это … с полки» (routes/games.js, shelf-match): «это она» — файлы новой встают на место игры с полки, окно
  // переходит на неё; «нет» — вопрос уходит и больше про эту игру не задаётся
  const handleShelfMatch = async (game, accept) => {
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(game.id)}/shelf-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: game.shelfMatch.id, accept }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      const list = await fetchGames({ silent: true });
      if (!accept) return;
      const index = list ? list.findIndex((g) => g.id === data.id) : -1;
      if (index >= 0) setSelectedGame({ game: list[index], index });
      showToast(t.shelf_match_done, 'success');
    } catch (e) {
      showToast(errorText(t, e), 'error');
    }
  };

  // Загрузили как новую, а это, похоже, игра с полки — тост один раз за сессию; ответ — в окне игры
  const matchToasted = useRef(new Set());
  useEffect(() => {
    const fresh = games.filter((g) => g.shelfMatch && !matchToasted.current.has(g.id));
    if (!fresh.length) return;
    fresh.forEach((g) => matchToasted.current.add(g.id));
    const g = fresh[0];
    const open = () => {
      hideToast();
      const index = games.findIndex((x) => x.id === g.id);
      if (index >= 0) setSelectedGame({ game: games[index], index });
    };
    showToast(t.shelf_match_toast(g.shelfMatch.title), 'info', { label: t.jd_open_game, onClick: open });
  }, [games]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRateGame = async (id, ratingValue) => {
    setGames(prevGames => prevGames.map(g => g.id === id ? { ...g, rating: ratingValue } : g));
    try {
      await fetch(`/api/games/${encodeURIComponent(id)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: ratingValue })
      });
    } catch { /* оценка уже на экране; не дошла — вернётся со следующим списком игр */ }
  };

  // Правим поле сразу на экране и следом отправляем на сервер.
  // Ждать ответ нельзя: звезда «моргала» бы на каждый клик.
  const patchGame = async (id, patch) => {
    setGames(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g));
    setSelectedGame(prev => prev && prev.game.id === id ? { ...prev, game: { ...prev.game, ...patch } } : prev);
    try {
      // keepalive: заметка уходит и при закрытии вкладки
      const res = await fetch(`/api/games/${encodeURIComponent(id)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        keepalive: true,
      });
      if (!res.ok) showToast(t.err_status[res.status] || t.err_status.server, 'error');
    } catch {
      showToast(t.err_net, 'error');
    }
  };

  // Поправка серии из окна игры. Для двух игр — по очереди; вторая не записалась — первую возвращаем, на экране ничего не меняется
  const changeSeries = async (changes) => {
    const before = new Map(games.map((g) => [g.id, g.series || '']));
    const post = (id, series) => fetch(`/api/games/${encodeURIComponent(id)}/series`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ series }) });
    const done = [];
    try {
      for (const [id, series] of changes) {
        const res = await post(id, series);
        if (!res.ok) throw new Error(String(res.status));
        done.push(id);
      }
    } catch {
      await Promise.all(done.map((id) => post(id, before.get(id)).catch(() => {})));
      showToast(t.series_err, 'error');
      return false;
    }
    const next = new Map(changes);
    setGames((prev) => prev.map((g) => (next.has(g.id) ? { ...g, series: next.get(g.id) } : g)));
    return true;
  };

  const handleUpdateGame = (index, updatedGame) => {
    // 1. Обновляем игру в общем списке (чтобы на главной странице обложка поменялась)
    // Заметку и подборки человек мог поменять, пока шёл запрос: из его ответа они устарели
    setGames(prev => prev.map(g => g.id === updatedGame.id ? { ...updatedGame, notes: g.notes, lists: g.lists } : g));
    
    // 2. КРИТИЧЕСКИ ВАЖНО: Обновляем снимок в выбранной игре, чтобы модалка сразу перерисовала обложку!
    setSelectedGame(prev => prev ? { ...prev, game: { ...updatedGame, notes: prev.game.notes, lists: prev.game.lists } } : null);
  };

  // Выход закрывает вход только этого устройства (остальные остаются во входе); забытое устройство закрывается сменой пароля.
  // Предупреждаем, чтобы выход не был сюрпризом.
  const handleLogout = async () => {
    if (!(await confirmDialog({ title: t.logout_title, text: t.logout_text, confirmLabel: t.logout }))) return;
    // Сеть упала — всё равно выходим локально: кука без ключа на сервере бесполезна
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* см. выше */ }
    // В библиотеке есть другие люди: запомненное этим человеком (поиск, вид, подборка) не должно достаться следующему,
    // а в памяти страницы оно осталось бы. Стираем и перезагружаем — страница начинается заново
    if (currentMe()?.shared) {
      forgetPreferences();
      window.location.reload();
      return;
    }
    setSettingsTab(null);
    // «Найти» без входа пусто — следующий вход с главной; «Библиотека» остаётся, как была
    setView((v) => (v === 'new' ? 'home' : v));
    setIsAuthed(false);
    setAuthMode('login');
  };

  // «Играть» с карточки или полки — сразу, без окна игры (время запуска отметит launchGame). Как «Продолжить»:
  // с самого свежего сейва или момента, а нечего — с титула
  // Запуск сначала узнаёт, откуда продолжить (сейвы и моменты): второе нажатие за это время игру ещё раз не запускает
  const launching = useRef(false);
  const playGame = async (game, from) => {
    if (launching.current) return;
    launching.current = true;
    try {
      await withIntro(game, from, async () => {
        const point = latestOf(await loadResume(game.id, launchSignal()), t);
        await launchGame(game, (updated) => setGames(prev => prev.map(g => g.id === updated.id ? updated : g)), launchPoint(point));
      });
    } catch (e) {
      showToast(errorText(t, e), 'error');
    } finally {
      launching.current = false;
    }
  };

  // Ревизия знает только id, а окну игры нужен сам объект и его номер в списке
  const handleOpenGameById = (id, initial, from) => {
    const index = games.findIndex(g => g.id === id);
    if (index >= 0) setSelectedGame({ game: games[index], index, initial, from });
  };

  // Клик по тегу в окне игры. Заодно сбрасываем поиск и статус: иначе после клика
  // библиотека может оказаться пустой по причине, которой не видно — например,
  // остался фильтр «пройдено» или строка поиска от прошлого раза.
  const handleTagClick = (tag) => {
    setSelectedGame(null);
    setSearchQuery('');
    setStatusFilter('all');
    setLangFilter('all');
    setSelectedTag(tag);
    setView('library');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };


  // Все теги игр библиотеки — для «Любимых тегов» в настройках
  const libraryTags = useMemo(() => [...new Set(games.flatMap((g) => g.tags || []).map((x) => String(x).toLowerCase()))], [games]);
  const availableTags = useMemo(() => {
    const tagCounts = {};
    games.forEach(g => {
      if (g.tags && g.tags.length > 0) {
        g.tags.forEach(tg => { tagCounts[tg] = (tagCounts[tg] || 0) + 1; });
      }
    });
    return Object.keys(tagCounts)
      // Теги-одиночки только засоряют список. Найти такую игру по-прежнему можно поиском,
      // а выбранный тег оставляем всегда — иначе он исчезнет из списка прямо под курсором.
      .filter(tag => tagCounts[tag] >= 2 || tag === selectedTag)
      .sort((a, b) => a.localeCompare(b))
      .map(tag => ({ name: tag, count: tagCounts[tag] }));
  }, [games, selectedTag]);

  // Языки, которые есть в библиотеке, — для фильтра. Самые частые первыми
  const availableLangs = useMemo(() => {
    const counts = {};
    games.forEach(g => (g.textLang?.langs || []).forEach(code => { counts[code] = (counts[code] || 0) + 1; }));
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count }));
  }, [games]);

  // Язык большинства игр — его на карточках не подписываем (см. GameCard)
  const usualLang = useMemo(() => {
    const counts = {};
    games.forEach(g => { const key = languageKey(g); if (key) counts[key] = (counts[key] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }, [games]);

  // Последняя запущенная игра — первой на главной. Фильтры библиотеки главную не трогают. Игра с полки — не
  // «продолжить»: её файлов нет
  const continueGame = useMemo(
    () => [...games].filter(g => g.lastPlayed && !g.shelf).sort((a, b) => b.lastPlayed - a.lastPlayed)[0] || null,
    [games],
  );

  // Игры с файлами: подборки главной и «Что играть?» — только из них, игру с полки сразу не запустить
  const onDisk = useMemo(() => games.filter((g) => !g.shelf), [games]);
  // Список рядом со сценой: те, во что играли до последней, — четыре строки входят в высоту сцены
  const recentGames = useMemo(
    () => onDisk.filter((g) => g.lastPlayed && g.id !== continueGame?.id).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 4),
    [onDisk, continueGame],
  );

  // Поиск, язык и жанр — отдельно от статуса: по ним же считаются числа на чипах статусов, и видно,
  // сколько игр даст каждый статус при нынешних фильтрах
  const matchedGames = useMemo(() => {
    let result = games;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(game => {
        // Ищем и по показанному названию, и по исходному: японское, версия и имя папки
        // тоже находят игру
        const matchTitle = [game.displayTitle, game.originalTitle, game.title, game.id]
          .some(s => s?.toLowerCase().includes(query));
        const matchTags = game.tags?.some(tag => tag.toLowerCase().includes(query));
        // Студия тоже ищется: помнят часто её, а не название. И своя заметка: человек помнит, что написал
        return matchTitle || matchTags || game.developer?.toLowerCase().includes(query) || game.notes?.toLowerCase().includes(query);
      });
    }
    if (langFilter !== 'all') {
      result = result.filter(g => g.textLang?.langs?.includes(langFilter));
    }
    if (selectedTag !== 'all') {
      result = result.filter(g => g.tags && g.tags.includes(selectedTag));
    }
    if (listFilter) result = result.filter((g) => g.lists?.includes(listFilter));
    if (picOn) {
      result = result.filter((g) => {
        const have = picOf(g.id);
        return !!have && picYes.every((x) => have.has(x)) && !picNo.some((x) => have.has(x));
      });
    }
    return result;
  }, [games, searchQuery, selectedTag, langFilter, listFilter, picOn, picYes, picNo, picOf]);

  // Числа панели: сколько подходящих игр с каждым тегом, сужаются с каждым выбором
  const picCounts = useMemo(() => {
    const seen = new Map();
    let total = 0;
    if (picPanel) {
      for (const g of matchedGames) {
        const have = picOf(g.id);
        if (!have) continue;
        total++;
        for (const tag of have.keys()) seen.set(tag, (seen.get(tag) || 0) + 1);
      }
    }
    return { total, counts: [...seen].map(([tag, n]) => ({ tag, n })) };
  }, [picPanel, matchedGames, picOf]);

  const statusCounts = useMemo(() => {
    const counts = { all: matchedGames.length, shelf: 0 };
    for (const g of matchedGames) {
      const status = effectiveStatus(g);
      if (status) counts[status] = (counts[status] || 0) + 1;
      if (g.shelf) counts.shelf++;
    }
    return counts;
  }, [matchedGames]);

  // Какие статусы есть в библиотеке вообще: от этого зависит, какие чипы стоят. От поиска не зависит, иначе ряд прыгал бы при наборе
  const statusPresent = useMemo(() => {
    const present = { shelf: 0 };
    for (const g of games) {
      const status = effectiveStatus(g);
      if (status) present[status] = (present[status] || 0) + 1;
      if (g.shelf) present.shelf++;
    }
    return present;
  }, [games]);

  const processedGames = useMemo(() => {
    let result = matchedGames;
    // Фильтруем по статусу
    if (statusFilter === 'shelf') {
      result = result.filter(g => g.shelf);
    } else if (statusFilter !== 'all') {
      result = result.filter(g => effectiveStatus(g) === statusFilter);
    }
        // При равных значениях упорядочиваем по id: иначе порядок одинаковых игр «прыгает»
    const byId = (a, b) => a.id.localeCompare(b.id);
    // Выбран тег картинок — сначала игры, где таких кадров больше (у нескольких тегов — по самому редкому). Сортировка из списка
    // в это время скрыта (Toolbar)
    const picFrames = (g) => Math.min(...picYes.map((x) => picOf(g.id)?.get(x) || 0));
    // Столбцы списка: игры без значения — в конце при обоих направлениях, иначе «сначала меньшие» начинались бы с пустых строк
    const filled = (a, b, pick, dir, compare = (x, y) => x - y) => {
      const [x, y] = [pick(a), pick(b)];
      if (!x || !y) return (!x - !y) || byId(a, b);
      return dir * compare(x, y) || byId(a, b);
    };
    const nameOf = (g) => g.displayTitle || g.title || g.id;
    const versionOf = (g) => g.version || '';
    const statusRank = (g) => STATUS_ORDER.indexOf(shownStatus(g)) + 1;
    result = [...result].sort((a, b) => {
      if (picYes.length) return picFrames(b) - picFrames(a) || byId(a, b);
      switch (currentSort) {
        case 'newest':      return (b.addedAt || 0) - (a.addedAt || 0) || byId(a, b);
        case 'oldest':      return filled(a, b, (g) => g.addedAt, 1);
        case 'recent':      return (b.lastPlayed || 0) - (a.lastPlayed || 0) || byId(a, b);
        case 'rating_desc': return (b.rating || 0) - (a.rating || 0) || byId(a, b);
        case 'name':        return nameOf(a).localeCompare(nameOf(b));
        case 'name_desc':   return nameOf(b).localeCompare(nameOf(a));
        case 'version_desc': return filled(a, b, versionOf, -1, VERSIONS.compare);
        case 'version_asc': return filled(a, b, versionOf, 1, VERSIONS.compare);
        case 'status':      return filled(a, b, statusRank, 1);
        case 'status_rev':  return filled(a, b, statusRank, -1);
        case 'playtime_asc': return filled(a, b, (g) => g.playtime, 1);
        case 'rating_asc':  return filled(a, b, (g) => g.rating, 1);
        case 'size_desc':   return (b.size || 0) - (a.size || 0) || byId(a, b);
        case 'size_asc':    return filled(a, b, (g) => g.size, 1);
        case 'playtime':    return (b.playtime || 0) - (a.playtime || 0) || byId(a, b);
        // Та же оценка, что на карточках; игры без неё — в конце, а не вперемешку с плохими
        default:            return 0;
      }
    });
    return result;
  }, [matchedGames, currentSort, statusFilter, picYes, picOf]);

  // Высчитываем, какие игры показывать на текущей странице
  const visibleGames = processedGames.slice(0, page * itemsPerPage);
  const look = useLibraryLook(games.length, picYes.length > 0);
  const groups = useMemo(() => (look.group === 'none' ? null : groupGames(processedGames, look.group, t)), [processedGames, look.group, t]);
  // Карточки подряд, как на экране: страницы считают их, а не игры. Свёрнутые не считаются, игра из двух подборок считается дважды
  const openGames = useMemo(() => (groups ? groups.flatMap((g) => (look.shut.includes(g.key) ? [] : g.games)) : processedGames), [groups, processedGames, look.shut]);
  const gridItems = groups ? pageOfGroups(groups, look.shut, page * itemsPerPage) : visibleGames.map((game, n) => ({ game, key: game.id, n }));
  const shownCount = new Set(gridItems.flatMap((item) => (item.game ? [item.game.id] : []))).size;
  // Серии — по всему списку, а не по найденному: от фильтра «Часть 2 из 3» не должна меняться
  const seriesOf = useMemo(() => detectSeries(games), [games]);
  const { setEl: libraryEl } = look;
  // Стрелки и буквы ведут к карточке, которой может ещё не быть: страницу рисуем сразу, чтобы тут же поставить на неё фокус
  useLibraryKeys(view === 'library' && isAuthed, () => {
    if (openGames.length <= page * itemsPerPage) return false;
    flushSync(() => setPage((p) => p + 1));
    return true;
  });
  const select = useLibrarySelect({ shown: processedGames, order: openGames, active: view === 'library' && isAuthed, setGames, refresh: () => fetchGames({ silent: true }), showToast, t });
  const jumpToGame = (index) => {
    flushSync(() => setPage((p) => Math.max(p, Math.ceil((index + 1) / itemsPerPage))));
    const card = document.querySelector(`.library .game-card[data-game="${CSS.escape(processedGames[index].id)}"]`);
    if (card) showCard(card, 'start');
  };

  // Настройка IntersectionObserver
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const target = entries[0];
      // Подгружаем следующую страницу, если элемент пересек границу видимости
      if (target.isIntersecting && openGames.length > page * itemsPerPage) {
        setPage(p => p + 1);
      }
    }, { rootMargin: '400px' });

    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [openGames.length, page, itemsPerPage, view]);


  // Пустая библиотека: владельцу — приглашение добавить игру; человеку, которому не открыто ни одной, — прямое «пока нет игр»:
  // добавлять он ничего не может, а подсказка про папку на сервере ему ни к чему
  const emptyLibrary = isAuthed && !owner
    ? <StateView title={t.person_no_games_title} hint={t.person_no_games_hint} />
    : <Welcome t={t} canUpload={isAuthed && owner} onUpload={() => openUploadRef.current?.()} />;

  // Загрузка кончилась, сбоя нет, игр нет. games пуст и пока список идёт: без !loading панель мигала бы при каждом входе
  const noGames = !loading && !gamesError && games.length === 0;

  return (
    <div className={`app-container${blurCovers ? ' covers-hidden' : ''}`}>
      <Header
        currentLang={lang}
        onLangChange={changeLang}
        t={t}
        // Пункты, под каждым — строка, что за ним. Три части: подбор; картинки и сцены; статистика, телефон, настройки. Пункт есть, когда за ним
        // что-то есть, иначе он открывал бы пустой экран. «Отложенные» — вкладка «Найти»: есть
        // новости — окно откроется на ней. «Проверить всё» — в ревизии. Копия, Telegram, пароль,
        // ключи — в «Настройках»; язык, место на диске и «Выйти» — ещё и мелкой строкой внизу меню
        onMenuOpen={isAuthed ? askPicInfo : undefined}
        menuItems={isAuthed ? [
          // Только на телефоне: там кнопка на панели убрана, игры с телефона добавляют редко. Добавляет игры владелец и человек с правом загрузки
          ...(canUpload ? [{ key: 'upload', icon: <IconUpload />, group: 1, label: t.add_game, hint: t.menu_upload_hint, onClick: () => openUploadRef.current?.(), className: 'mobile-only' }] : []),
          // Случайная из не начатых — когда их много и выбрать трудно
          ...(games.some((g) => ['new', 'wish'].includes(effectiveStatus(g))) ? [{ key: 'pick', group: 1, icon: <IconDice />, label: t.pick_title, hint: t.menu_pick_hint, onClick: () => setPickerOpen(true) }] : []),
          // Отмеченное сердечком в галереях игр — одним альбомом, показом
          ...(!picInfo || picInfo.faved !== false ? [{ key: 'favorites', group: 2, icon: <IconFavorites />, label: t.favs_title, hint: t.menu_favs_hint, onClick: () => setFavoritesOpen(true) }] : []),
          // Листать картинки игр без цели: игра за игрой
          // Лента и поиск без разбора показывают только «разбор выключен», а включить его обычный человек всё равно не может
          ...(!picInfo || picInfo.analysis?.on || picInfo.tagged ? [{ key: 'feed', group: 2, icon: <IconImage />, label: t.feed_title, hint: t.menu_feed_hint, onClick: () => setFeedOpen(true) }] : []),
          // Найти картинку по словам во всех галереях сразу
          ...(!picInfo || picInfo.analysis?.on || picInfo.tagged ? [{ key: 'pictures', group: 2, icon: <IconSearch />, label: t.pics_title, hint: t.menu_pics_hint, onClick: () => setPicSearch((p) => ({ q: '', n: (p?.n || 0) + 1 })) }] : []),
          // Найти сцену по словам из реплик во всех играх
          ...(games.length ? [{ key: 'lines', group: 2, icon: <IconLines />, label: t.lines_title, hint: t.menu_lines_hint, onClick: () => setLineSearch('') }] : []),
          { key: 'library', group: 3, icon: <IconStats />, label: t.stats, hint: t.menu_library_hint, onClick: () => setLibraryTab('stats') },
          // Только на компьютере: с телефона код сканировать нечем. Адрес сервера — дело владельца
          ...(owner ? [{ key: 'phone', group: 3, icon: <IconPhone />, label: t.phone_title, hint: t.menu_phone_hint, onClick: () => setPhoneOpen(true), className: 'desktop-only' }] : []),
          { key: 'settings', group: 3, icon: <IconSettings />, label: t.settings, hint: t.menu_settings_hint, onClick: () => setSettingsTab('general') },
        ] : []}
        onLogout={isAuthed ? handleLogout : null}
        // Знак и имя — когда в библиотеке есть другие люди или поставлена картинка: у одного владельца без картинки шапка прежняя
        person={isAuthed ? me : null}
        onPerson={() => setSettingsTab('account')}
        // Уже на «Найти» — вкладка ничего не сбрасывает (поиск, открытая игра остаются)
        view={view} onView={isAuthed ? (v) => (v !== 'new' ? setView(v) : view !== 'new' && openCatalog(findStartTab({ wishEmpty: !wishlist.items.length }))) : null}
        toolsRef={setHeaderTools}
        onSecret={isAuthed ? spitGame : null}
        side={seesJobs && <JdDownloads t={t} onOpenGame={handleOpenGameById} />}
      >
        {isAuthed && owner && <StorageMonitor t={t} />}
      </Header>
      {/* Полная проверка ищет данные для всех игр — её полоса заменяет счётчик сбора метаданных */}
      {check?.running
        ? <CheckStrip check={check} t={t} onOpen={() => setLibraryTab('audit')} />
        : scrapeLeft > 0 && (
          <button type="button" className="scrape-progress" onClick={() => setQueueOpen(true)} data-tip={t.queue_open}>
            {scrapePaused ? t.scrape_paused(scrapeLeft) : t.scrape_left(scrapeLeft)}
          </button>
        )}
      
      {view === 'library' && games.length > 0 && <LibraryMast games={games} start={continueGame} blurCovers={blurCovers} t={t} />}
      <Toolbar 
        hideBar={view === 'new' || noGames} inHeader={view === 'home'} toolsEl={headerTools}
        noSearch={noGames}
        // Человеку с правом загрузки плитки нет (emptyLibrary), кнопка у него единственная. Глаз без игр нужен, пока есть ряд популярного с Главной и «Найти»
        showAdd={!(noGames && owner)} showEye={!noGames || view !== 'library' || blurCovers}
        blurCovers={blurCovers} setBlurCovers={setBlurCovers}
        searchQuery={searchQuery} setSearchQuery={search} filters={view === 'library' && !noGames}
        availableTags={availableTags} selectedTag={selectedTag} setSelectedTag={setSelectedTag}
        availableLangs={availableLangs} langFilter={langFilter} setLangFilter={setLangFilter} lang={lang}
        openUploadRef={openUploadRef}
        onTargetPicked={() => setSelectedGame(null)}
        currentSort={currentSort} setCurrentSort={setCurrentSort}
        onUploadSuccess={() => fetchGames({ silent: true })}
        t={t}
        showToast={showToast}
        canUpload={canUpload} authed={isAuthed}
        onOpenGame={handleOpenGameById}
        onOpenSpace={() => setLibraryTab('space')}
        lists={allLists} listFilter={listFilter} setListFilter={setListFilter}
        picRef={picBtn} picTags={picAny || picOn ? { n: picYes.length + picNo.length, open: picPanel, ordered: picYes.length > 0, onClick: () => setPicPanel((on) => !on) } : null}
      />
      {view === 'library' && picPanel && picIndex && (
        <Suspense fallback={null}>
          <TagPanel t={t} anchor={picBtn} counts={picCounts.counts} total={picCounts.total} picked={picYes} not={picNo} onPick={pickPic} onNot={notPic} onReset={resetPic} result={t.lib_pic_games} none={t.lib_pic_none} under onClose={() => setPicPanel(false)} />
        </Suspense>
      )}
      
      <main className={`content view-${view}`} ref={mainRef}>
        {view === 'new' && isAuthed ? (
          <Suspense fallback={null}>
          <Catalog
            key={catalogKey} asPage
            t={t} lang={lang} initialSource={catalogTab}
            wishlist={wishlist.items}
            onWishAdd={handleWishAdd} onWishRemove={handleWishRemove}
            onClose={() => setView('home')}
            onOpenGame={handleOpenGameById}
            libraryCount={games.length}
            wishReady={wishReady} recheckStart={catalogKey === 0}
          />
          </Suspense>
        ) : loading || loadingShown ? (
          // Мимик по центру места под сетку (через 250 мс, MimicLoader): быстрый ответ обходится без него
          <div className="library">
            <div className="library-wait"><MimicLoader size={48} col><span>{t.library_loading}</span></MimicLoader></div>
          </div>
        ) : view === 'home' ? (
          games.length === 0 && gamesError ? (
            <div className="library">
              <StateView kind="error" title={t.games_error_title} hint={t.games_error_hint} onRetry={() => fetchGames()} retryLabel={t.retry} />
            </div>
          ) : games.length === 0 ? (
            <>
              <div className="library">
                {emptyLibrary}
              </div>
            </>
          ) : (
            <>
              {continueGame && (
                <div className={`home-top${recentGames.length ? '' : ' solo'}`}>
                  <div className="home-continue">
                    <ContinueCard
                      game={continueGame}
                      t={t} lang={lang}
                      onUpdateGame={(updated) => setGames(prev => prev.map(g => g.id === updated.id ? updated : g))}
                      showToast={showToast}
                      onOpen={(g, initial, from) => handleOpenGameById(g.id, initial, from)}
                    />
                  </div>
                  {recentGames.length > 0 && (
                    <RecentPlayed games={recentGames} t={t} lang={lang}
                      onOpen={(g, from) => handleOpenGameById(g.id, undefined, from)} onPlay={playGame} onShowAll={() => showShelf('played')} />
                  )}
                </div>
              )}
              <Shelves games={onDisk} t={t} lang={lang}
                onOpen={(g, from) => handleOpenGameById(g.id, undefined, from)} onPlay={playGame} onShowAll={showShelf} onRandom={() => setPickerOpen(true)} />
            </>
          )
        ) : (
          <>
            {listFilter && (
              <div className="library-bar">
                <ListBar key={listFilter} name={listFilter} count={games.filter((g) => g.lists?.includes(listFilter)).length} t={t} onRename={(to) => changeList(listFilter, to)} onDelete={() => deleteList(listFilter)} />
              </div>
            )}
            {games.length > 0 && (
              <div className="library-bar">
                <StatusChips value={statusFilter} onChange={setStatusFilter} t={t} shelf={statusPresent.shelf} counts={statusCounts} present={statusPresent} />
                <LookSwitch look={look} t={t} group={{ value: look.groupPick, onChange: (v) => { look.setGroup(v); setPage(1); }, locked: picYes.length > 0, lists: allLists.length > 0 }} select={isAuthed ? select : null} />
              </div>
            )}
            {picOn && (
              <div className="library-bar">
                <Suspense fallback={null}>
                  <TagPicked t={t} picked={picYes} not={picNo} count={t.lib_pic_found(matchedGames.length, picIndex?.covered || 0)} hidden={[]} onPick={pickPic} onNot={notPic} onReset={resetPic} />
                </Suspense>
              </div>
            )}
            {(currentSort === 'name' || currentSort === 'name_desc') && !picYes.length && !groups && processedGames.length >= 30 && look.shown !== 'feat' && (
              <LibraryLetters games={processedGames} onJump={jumpToGame} t={t} />
            )}
            <div ref={libraryEl} className={`${look.className}${select.on ? ' picking' : ''}`}>
              {look.shown === 'list' && processedGames.length > 0 && (
                <ListHead sort={currentSort} setSort={setCurrentSort} locked={picYes.length > 0} t={t} />
              )}
              {gridItems.map((item) => {
                if (item.group) {
                  const open = !look.shut.includes(item.group.key);
                  return (
                    // Прямо в сетке, а не обёрткой вокруг карточек: виды, стрелки и страницы работают с .library > .game-card как обычно
                    <h2 key={item.key} className="lib-group">
                      <button type="button" aria-expanded={open} onClick={() => look.toggleShut(item.group.key)}>
                        <span className="lib-group-name">{item.group.title}</span>
                        <span className="lib-group-n">{item.group.games.length}</span>
                        <span className="lib-group-do">{open ? t.lib_group_fold : t.lib_group_unfold}</span>
                      </button>
                    </h2>
                  );
                }
                const { game, n: index } = item;
                return (
                  <GameCard 
                    key={item.key} game={game} index={index} look={look.shown}
                    onClick={(from) => setSelectedGame({ game, index, from })} 
                    onRate={handleRateGame}
                    onPlay={playGame}
                    t={t} lang={lang} usualLang={usualLang}
                    frames={picYes.length === 1 ? picOf(game.id)?.get(picYes[0]) : undefined}
                    picking={select.on} picked={select.isPicked(game.id)} onPick={select.toggle}
                    part={seriesOf.get(game.id)}
                  />
                );
              })}
              {/* Игр пока мало: пустое место в ряду — приглашение добавить */}
              {look.shown === 'grid' && !groups && canUpload && games.length <= 12 && !filtersActive && (
                <button type="button" className="lib-add-tile" onClick={() => openUploadRef.current?.()}>{t.add_game}</button>
              )}
              {processedGames.length === 0 && games.length === 0 && !filtersActive && (
                emptyLibrary
              )}
              {processedGames.length === 0 && (games.length > 0 || filtersActive) && (
                /* Одна строка и «Сбросить фильтры» — без тупика: какой из фильтров всё отсеял, вспоминать не надо */
                <StateView title={t.not_found}>
                  {filtersActive && <button type="button" className="state-action empty-reset" onClick={resetFilters}>{t.reset_filters}</button>}
                </StateView>
              )}
            </div>
            
            {/* Невидимый блок-якорь для Observer'а */}
            <div ref={loaderRef} style={{ height: '20px' }}></div>

            {processedGames.length > 0 && (
              <div className="library-info">
                {t.shown(shownCount, processedGames.length)}
              </div>
            )}
            {select.on && <LibrarySelect select={select} owner={owner} lists={allLists} t={t} />}

            {/* Набранное в поиске — ещё и в репликах сцен всех игр. «Скрыть обложки» — полки нет: текст сцен на главной не нужен */}
            {isAuthed && !blurCovers && <LineShelf query={searchQuery} games={games} t={t} onShowAll={(q) => setLineSearch(q)} />}
          </>
        )}
      </main>
      
      <Suspense fallback={null}>
      {authMode && (
        <LoginModal 
          mode={authMode} 
          onSuccess={async () => {
            // Другой человек за тем же браузером: прежнее запомненное (поиск, подборка, вид) ему не показываем
            const was = currentMe();
            await loadMe();
            // Сессия кончилась, вошёл другой человек: кэши страницы (подбор, вишлист, любимые теги) прежнего ему не нужны
            if (was?.id && currentMe()?.id && was.id !== currentMe().id) { forgetPreferences(); window.location.reload(); return; }
            if (currentMe()?.shared || was?.shared) { forgetPreferences(); resetFilters(); setView('home'); }
            setMe(currentMe());
            setAuthMode(null);
            fetchGames();
          }}
          t={t}
          lang={lang}
          onLangChange={changeLang}
        />
      )}
      
      {libraryTab && (
        <LibraryModal
          tab={libraryTab} games={games} t={t} lang={lang}
          onClose={() => setLibraryTab(null)} onOpenGame={handleOpenGameById}
          check={check} onStartCheck={startCheck} onCancelCheck={cancelCheck}
          onChanged={() => fetchGames({ silent: true })}
        />
      )}

      {playing && (
        <GameFrame
          key={playing.url}
          game={playing.game} url={playing.url} origin={playing.origin}
          holdLoader={!!intro}
          onClose={closeGame}
        />
      )}
      {intro && <LaunchIntro key={intro.game.id} from={intro.from} ready={!!playing} onDone={() => setIntro(null)} onCancel={cancelLaunch} />}

      {feedOpen && (
        <Suspense fallback={null}><PictureFeed games={games} t={t} onClose={() => setFeedOpen(false)} /></Suspense>
      )}
      {favoritesOpen && (
        <Suspense fallback={null}><FavoritesGallery games={games} t={t} onClose={() => setFavoritesOpen(false)} /></Suspense>
      )}
      {lineSearch !== null && (
        <Suspense fallback={null}><LineSearch games={games} t={t} query0={lineSearch} onClose={() => setLineSearch(null)} /></Suspense>
      )}
      {picSearch && (
        <Suspense fallback={null}><PictureSearch key={picSearch.n} q0={picSearch.q} like0={picSearch.like} games={games} t={t} onClose={() => setPicSearch(null)} /></Suspense>
      )}
      {pickerOpen && (
        <PlayPicker games={onDisk} t={t} lang={lang} startId={pickerStart} onClose={closePicker} onOpenGame={handleOpenGameById} showToast={showToast} hideToast={hideToast} />
      )}

      {settingsTab && isAuthed && (
        <SettingsModal
          tab={settingsTab} t={t} lang={lang} onLangChange={changeLang}
          blurCovers={blurCovers} setBlurCovers={setBlurCovers}
          socket={socket} showToast={showToast} onLogout={handleLogout} onRestoreTrash={restoreFromTrash}
          onShowKeys={() => setKeysOpen(true)}
          tags={libraryTags}
          onLibraryChanged={() => fetchGames({ silent: true })}
          me={me} onMe={refreshMe}
          onClose={() => setSettingsTab(null)}
        />
      )}

      {/* «Клавиши» — после «Настроек»: из них окно открывается кнопкой и должно встать поверх, а не под
          ними. Своя граница Suspense: пока догружается окно, настройки не исчезают */}
      {keysOpen && <Suspense fallback={null}><ShortcutsHelp t={t} onClose={() => setKeysOpen(false)} /></Suspense>}
      {phoneOpen && <Suspense fallback={null}><PhoneLink t={t} onClose={() => setPhoneOpen(false)} /></Suspense>}
      {queueOpen && owner && <Suspense fallback={null}><LookupQueue t={t} notify={showToast} onClose={() => setQueueOpen(false)} /></Suspense>}


      {selectedGame && (
        <GameModal 
          game={selectedGame.game} index={selectedGame.index} initial={selectedGame.initial} from={selectedGame.from}
          onClose={() => setSelectedGame(null)} onUpdateGame={handleUpdateGame}
          t={t} lang={lang}
          showToast={showToast}
          onPatch={patchGame}
          onDelete={handleDeleteGame}
          onShelve={handleShelveGame}
          onRestoreShelf={(key) => restoreFromTrash(key, t.shelf_restored)}
          onShelfMatch={handleShelfMatch}
          onTagClick={handleTagClick}
          lists={allLists} onListOpen={openList}
          series={seriesOf.get(selectedGame.game.id)} onOpenGame={handleOpenGameById} onSeries={changeSeries}
          onUploadNewVersion={(g) => openUploadRef.current?.({ id: g.id, title: g.displayTitle || g.title })}
          onUploadPatch={(g) => openUploadRef.current?.({ id: g.id, title: g.displayTitle || g.title, mode: 'patch' })}
        />
      )}

      </Suspense>

      {jdLink && isAuthed && <JdLinkPanel key={jdLink} t={t} url={jdLink} onClose={() => setJdLink('')} showToast={showToast} />}

      {/* Окно подтверждения — одно на всю библиотеку (confirm.js): удалить игру, выйти и прочее */}
      <ConfirmHost t={t} />

      <Tip />
      <Toast message={toast.message} type={toast.type} visible={toast.visible} action={toast.action} />
    </div>
  )
}

export default App
