import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react'
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
import { loadLocale, locale, savedLang } from './locales'
import StorageMonitor from './components/StorageMonitor';
import ContinueCard from './components/ContinueCard';
import { loadFavoriteTags } from './favoriteTags';
const LibraryModal = lazy(() => import('./components/LibraryModal'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const ShortcutsHelp = lazy(() => import('./components/ShortcutsHelp'));
const LookupQueue = lazy(() => import('./components/LookupQueue'));
import GameFrame from './components/GameFrame';
import MimicLoader from './components/MimicLoader';
import { useDelayedShow } from './useDelayedShow';
const loadPicker = () => import('./components/PlayPicker');
const PlayPicker = lazy(loadPicker);
const FavoritesGallery = lazy(() => import('./components/FavoritesGallery'));
const PictureSearch = lazy(() => import('./components/PictureSearch'));
import { launchGame, withIntro, cancelLaunch, launchSignal } from './launchGame';
import LaunchIntro from './components/LaunchIntro';
import { latestOf, launchPoint, loadResume } from './resumePoint';
import { hideOnLeave } from './coversHidden';
import { mood } from './mimicMood';
import { layersOpen, useLayer } from './layers';
import { IconStats, IconUpload, IconDice, IconSettings, IconFavorites, IconSearch } from './components/icons';
import JdLinkPanel from './components/JdLinkPanel';
import { effectiveStatus } from './gameStatus';
import StatusChips from './components/StatusChips';
const Catalog = lazy(() => import('./components/Catalog'));
import { languageKey } from './formatLanguage';
import CheckStrip from './components/CheckStrip';
import Shelves from './components/Shelves';
import Welcome from './components/Welcome';
import StateView from './components/StateView';
import { checkSummary } from './checkSummary';

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
  // Поиск картинок по словам во всех галереях (PictureSearch)
  const [picSearchOpen, setPicSearchOpen] = useState(false);
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
  // С какой вкладки открыть «Новинки игр»: из меню «Хочу поиграть» — сразу со списка
  const [catalogTab, setCatalogTab] = useState('itch');
  // «Хочу поиграть»: отложенные из новинок игры
  const [wishlist, setWishlist] = useState({ items: [] });
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

  useEffect(() => {
    // Приватное окно и запрет хранилища бросают исключение — фильтры тогда просто не запоминаются
    try {
      sessionStorage.setItem('rpg_search', searchQuery);
      localStorage.setItem('rpg_tag', selectedTag);
      localStorage.setItem('rpg_sort', currentSort);
      localStorage.setItem('rpg_status', statusFilter);
      localStorage.setItem('rpg_langf', langFilter);
    } catch { /* не запомнится — не страшно */ }
  }, [searchQuery, selectedTag, currentSort, statusFilter, langFilter]);

  const filtersActive = !!searchQuery || selectedTag !== 'all' || statusFilter !== 'all' || langFilter !== 'all';
  const resetFilters = () => {
    setSearchQuery('');
    setSelectedTag('all');
    setStatusFilter('all');
    setLangFilter('all');
  };

  // Две страницы, как у Steam и Jellyfin: «Главная» — то, к чему возвращаются (продолжить, недавние,
  // обновления, новые), «Библиотека» — все игры с поиском и фильтрами. Раньше всё шло одной лентой:
  // три полки по 12 обложек с повторами, а под ними ещё все игры — больше сотни обложек подряд.
  // Библиотека — слой в истории (layers.js): жест «назад» возвращает на главную
  // «Новинки» — третья страница: раньше они открывались окном из меню «⋯», и о них мало кто знал
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
  const showShelf = (key) => showLibrary({ played: { sort: 'recent' }, unplayed: { status: 'new' }, added: { sort: 'newest' } }[key]);
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
    // Вошёл ли пользователь: виджеты, которым нужен вход (StorageMonitor), показываем только после него
  const [isAuthed, setIsAuthed] = useState(false);
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
  const filterKey = [searchQuery, selectedTag, currentSort, statusFilter, langFilter].join('\u0000');
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

  // «Хочу поиграть»: отложенные из новинок игры
  const fetchWishlist = async () => {
    try {
      const res = await fetch('/api/wishlist');
      if (res.ok) setWishlist(await res.json());
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
    if (!games.length) return;
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
  // загрузится. Ключ игры выдаётся заново: старый адрес рамки после выхода из библиотеки не годится
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
    if (game) launchGame(game).catch(() => {});
  }, [games]);

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
      // «Хочу поиграть» и полная проверка — вместе с играми: и после входа, и когда вкладку снова открыли
      fetchWishlist();
      fetchCheck();
      loadFavoriteTags();
      // Очередь поиска: сколько ждут и не на паузе ли — полоса видна и до первого события сервера
      fetch('/api/games/lookup-queue').then((r) => (r.ok ? r.json() : null))
        .then((q) => { if (q) { setScrapeLeft(q.left); setScrapePaused(q.paused); } }).catch(() => {});
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

    // Список «Хочу поиграть» поменяли на другом устройстве
    socket.on('wishlist-changed', () => fetchWishlist());
    // Ход полной проверки
    socket.on('fullcheck', (state) => applyCheck(state));

    const handleVisibilityChange = () => {
      if (!document.hidden) fetchGames({ silent: true });
    };
    const handlePageShow = (event) => {
      if (event.persisted) fetchGames({ silent: true });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      clearTimeout(refetchTimer.current);
      socket.off('scrape-success');
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      socket.off('library-changed');
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

  // «Хочу поиграть» из окна новинок: отложить игру, убрать.
  // Убираем сразу, не дожидаясь сервера: звёздочка гаснет под пальцем
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
  // Открывает страницу «Новинки» на нужной вкладке. catalogKey — заново с этой вкладкой, даже если страница уже открыта
  const openCatalog = (tab) => {
    setCatalogTab(tab);
    setCatalogKey((k) => k + 1);
    setView('new');
  };

  // Вернуть игру из корзины — из тоста «Отменить» и из «Настроек → Корзина»
  const restoreFromTrash = async (key) => {
    try {
      const res = await fetch(`/api/games/trash/${encodeURIComponent(key)}/restore`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(res, data);
      await fetchGames({ silent: true });
      showToast(t.trash_restored, 'success');
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
      await fetch(`/api/games/${encodeURIComponent(id)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
    } catch {
      showToast(t.err_net, 'error');
    }
  };

  const handleUpdateGame = (index, updatedGame) => {
    // 1. Обновляем игру в общем списке (чтобы на главной странице обложка поменялась)
    setGames(prev => prev.map(g => g.id === updatedGame.id ? updatedGame : g));
    
    // 2. КРИТИЧЕСКИ ВАЖНО: Обновляем снимок в выбранной игре, чтобы модалка сразу перерисовала обложку!
    setSelectedGame(prev => prev ? { ...prev, game: updatedGame } : null);
  };

  // Ключ сессии на сервере один на всех, поэтому выход закрывает доступ сразу
  // и на телефоне, и на компьютере. Предупреждаем, чтобы это не было сюрпризом.
  const handleLogout = async () => {
    if (!(await confirmDialog({ title: t.logout_title, text: t.logout_text, confirmLabel: t.logout }))) return;
    // Сеть упала — всё равно выходим локально: кука без ключа на сервере бесполезна
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* см. выше */ }
    setSettingsTab(null);
    // «Новинки» без входа пусты — следующий вход с главной; «Библиотека» остаётся, как была
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

  // Последняя запущенная игра — первой на главной. Фильтры библиотеки главную не трогают
  const continueGame = useMemo(
    () => [...games].filter(g => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed)[0] || null,
    [games],
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
        // Студия тоже ищется: помнят часто её, а не название
        return matchTitle || matchTags || game.developer?.toLowerCase().includes(query);
      });
    }
    if (langFilter !== 'all') {
      result = result.filter(g => g.textLang?.langs?.includes(langFilter));
    }
    if (selectedTag !== 'all') {
      result = result.filter(g => g.tags && g.tags.includes(selectedTag));
    }
    return result;
  }, [games, searchQuery, selectedTag, langFilter]);

  const statusCounts = useMemo(() => {
    const counts = { all: matchedGames.length };
    for (const g of matchedGames) {
      const status = effectiveStatus(g);
      if (status) counts[status] = (counts[status] || 0) + 1;
    }
    return counts;
  }, [matchedGames]);

  const processedGames = useMemo(() => {
    let result = matchedGames;
    // Фильтруем по статусу
    if (statusFilter !== 'all') {
      result = result.filter(g => effectiveStatus(g) === statusFilter);
    }
        // При равных значениях упорядочиваем по id: иначе порядок одинаковых игр «прыгает»
    const byId = (a, b) => a.id.localeCompare(b.id);
    result = [...result].sort((a, b) => {
      switch (currentSort) {
        case 'newest':      return (b.addedAt || 0) - (a.addedAt || 0) || byId(a, b);
        case 'oldest':      return (a.addedAt || 0) - (b.addedAt || 0) || byId(a, b);
        case 'recent':      return (b.lastPlayed || 0) - (a.lastPlayed || 0) || byId(a, b);
        case 'rating_desc': return (b.rating || 0) - (a.rating || 0) || byId(a, b);
        case 'name':        return (a.displayTitle || a.title || a.id).localeCompare(b.displayTitle || b.title || b.id);
        case 'size_desc':   return (b.size || 0) - (a.size || 0) || byId(a, b);
        case 'size_asc':    return (a.size || 0) - (b.size || 0) || byId(a, b);
        case 'playtime':    return (b.playtime || 0) - (a.playtime || 0) || byId(a, b);
        // Та же оценка, что на карточках; игры без неё — в конце, а не вперемешку с плохими
        default:            return 0;
      }
    });
    return result;
  }, [matchedGames, currentSort, statusFilter]);

  // Высчитываем, какие игры показывать на текущей странице
  const visibleGames = processedGames.slice(0, page * itemsPerPage);

  // Настройка IntersectionObserver
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const target = entries[0];
      // Подгружаем следующую страницу, если элемент пересек границу видимости
      if (target.isIntersecting && processedGames.length > page * itemsPerPage) {
        setPage(p => p + 1);
      }
    }, { rootMargin: '400px' });

    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [processedGames.length, page, itemsPerPage, view]);

  return (
    <div className={`app-container${blurCovers ? ' covers-hidden' : ''}`}>
      <Header
        currentLang={lang}
        onLangChange={changeLang}
        t={t}
        // Пункты, под каждым — строка, что за ним. «Хочу поиграть» — вкладка «Новинок»: есть
        // новости — окно откроется на ней. «Проверить всё» — в ревизии. Копия, Telegram, пароль,
        // ключи — в «Настройках»; язык, место на диске и «Выйти» — ещё и мелкой строкой внизу меню
        menuItems={isAuthed ? [
          // Только на телефоне: там кнопка на панели убрана, игры с телефона добавляют редко
          { key: 'upload', icon: <IconUpload />, label: t.add_game, hint: t.menu_upload_hint, onClick: () => openUploadRef.current?.(), className: 'mobile-only' },
          // Случайная из не начатых — когда их много и выбрать трудно
          { key: 'pick', icon: <IconDice />, label: t.pick_title, hint: t.menu_pick_hint, onClick: () => setPickerOpen(true) },
          // Отмеченное сердечком в галереях игр — одним альбомом, показом
          { key: 'favorites', icon: <IconFavorites />, label: t.favs_title, hint: t.menu_favs_hint, onClick: () => setFavoritesOpen(true) },
          // Найти картинку по словам во всех галереях сразу
          { key: 'pictures', icon: <IconSearch />, label: t.pics_title, hint: t.menu_pics_hint, onClick: () => setPicSearchOpen(true) },
          { key: 'library', icon: <IconStats />, label: t.stats_audit, hint: t.menu_library_hint, onClick: () => setLibraryTab('stats') },
          { key: 'settings', icon: <IconSettings />, label: t.settings, hint: t.menu_settings_hint, onClick: () => setSettingsTab('general') },
        ] : []}
        onLogout={isAuthed ? handleLogout : null}
        // Уже на «Новинках» — вкладка ничего не сбрасывает (поиск, открытая игра остаются)
        view={view} onView={isAuthed ? (v) => (v !== 'new' ? setView(v) : view !== 'new' && openCatalog('itch')) : null} libraryCount={games.length}
        onSecret={isAuthed ? spitGame : null}
        side={isAuthed && <JdDownloads t={t} onOpenGame={handleOpenGameById} />}
      >
        {isAuthed && <StorageMonitor t={t} />}
      </Header>
      {/* Полная проверка ищет данные для всех игр — её полоса заменяет счётчик сбора метаданных */}
      {check?.running
        ? <CheckStrip check={check} t={t} onOpen={() => setLibraryTab('audit')} />
        : scrapeLeft > 0 && (
          <button type="button" className="scrape-progress" onClick={() => setQueueOpen(true)} data-tip={t.queue_open}>
            {scrapePaused ? t.scrape_paused(scrapeLeft) : t.scrape_left(scrapeLeft)}
          </button>
        )}
      
      <Toolbar 
        hideBar={view === 'new'}
        blurCovers={blurCovers} setBlurCovers={setBlurCovers}
        searchQuery={searchQuery} setSearchQuery={search} filters={view === 'library'}
        availableTags={availableTags} selectedTag={selectedTag} setSelectedTag={setSelectedTag}
        availableLangs={availableLangs} langFilter={langFilter} setLangFilter={setLangFilter} lang={lang}
        openUploadRef={openUploadRef}
        onTargetPicked={() => setSelectedGame(null)}
        currentSort={currentSort} setCurrentSort={setCurrentSort}
        onUploadSuccess={() => fetchGames({ silent: true })}
        t={t}
        showToast={showToast}
        canUpload={isAuthed}
        onOpenGame={handleOpenGameById}
      />
      
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
                <Welcome t={t} canUpload={isAuthed} onUpload={() => openUploadRef.current?.()} />
              </div>
            </>
          ) : (
            <>
              {continueGame && (
                <div className="home-continue">
                  <ContinueCard
                    game={continueGame}
                    t={t} lang={lang}
                    onUpdateGame={(updated) => setGames(prev => prev.map(g => g.id === updated.id ? updated : g))}
                    showToast={showToast}
                    onOpen={(g, initial, from) => handleOpenGameById(g.id, initial, from)}
                  />
                </div>
              )}
              <Shelves games={games} t={t} lang={lang} skipId={continueGame?.id}
                onOpen={(g, from) => handleOpenGameById(g.id, undefined, from)} onPlay={playGame} onShowAll={showShelf} onRandom={() => setPickerOpen(true)} />
            </>
          )
        ) : (
          <>
            {games.length > 0 && (
              <div className="library-bar">
                <StatusChips value={statusFilter} onChange={setStatusFilter} t={t} counts={statusCounts} />
              </div>
            )}
            <div className="library">
              {visibleGames.map((game, index) => (
                <GameCard 
                  key={game.id} game={game} index={index}
                  onClick={(from) => setSelectedGame({ game, index, from })} 
                  onRate={handleRateGame}
                  onPlay={playGame}
                  t={t} lang={lang} usualLang={usualLang}
                />
              ))}
              {processedGames.length === 0 && games.length === 0 && !filtersActive && (
                <Welcome t={t} canUpload={isAuthed} onUpload={() => openUploadRef.current?.()} />
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
                {t.shown(Math.min(page * itemsPerPage, processedGames.length), processedGames.length)}
              </div>
            )}

          </>
        )}
      </main>
      
      <Suspense fallback={null}>
      {authMode && (
        <LoginModal 
          mode={authMode} 
          onSuccess={() => { setAuthMode(null); fetchGames(); }} 
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

      {favoritesOpen && (
        <Suspense fallback={null}><FavoritesGallery games={games} t={t} onClose={() => setFavoritesOpen(false)} /></Suspense>
      )}
      {picSearchOpen && (
        <Suspense fallback={null}><PictureSearch games={games} t={t} onClose={() => setPicSearchOpen(false)} /></Suspense>
      )}
      {pickerOpen && (
        <PlayPicker games={games} t={t} startId={pickerStart} onClose={closePicker} onOpenGame={handleOpenGameById} showToast={showToast} />
      )}

      {settingsTab && isAuthed && (
        <SettingsModal
          tab={settingsTab} t={t} lang={lang} onLangChange={changeLang}
          blurCovers={blurCovers} setBlurCovers={setBlurCovers}
          socket={socket} showToast={showToast} onLogout={handleLogout} onRestoreTrash={restoreFromTrash}
          onShowKeys={() => setKeysOpen(true)}
          tags={libraryTags}
          onLibraryChanged={() => fetchGames({ silent: true })}
          onClose={() => setSettingsTab(null)}
        />
      )}

      {/* «Клавиши» — после «Настроек»: из них окно открывается кнопкой и должно встать поверх, а не под
          ними. Своя граница Suspense: пока догружается окно, настройки не исчезают */}
      {keysOpen && <Suspense fallback={null}><ShortcutsHelp t={t} onClose={() => setKeysOpen(false)} /></Suspense>}
      {queueOpen && <Suspense fallback={null}><LookupQueue t={t} notify={showToast} onClose={() => setQueueOpen(false)} /></Suspense>}


      {selectedGame && (
        <GameModal 
          game={selectedGame.game} index={selectedGame.index} initial={selectedGame.initial} from={selectedGame.from}
          onClose={() => setSelectedGame(null)} onUpdateGame={handleUpdateGame}
          t={t} lang={lang}
          showToast={showToast}
          onPatch={patchGame}
          onDelete={handleDeleteGame}
          onTagClick={handleTagClick}
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
