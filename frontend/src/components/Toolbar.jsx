import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { languageTitle } from '../formatLanguage';
import { uploadArchive, matchUpload, listUploads, cancelUpload, sendPassword, retryUpload, UploadError } from '../resumableUpload';
import Picker from './Picker';
import SearchBox from './SearchBox';
import { layersOpen } from '../layers';
import { pageKeysFree } from '../libraryKeys';
import { confirmDialog } from '../confirm';
import { getCoverUrl } from '../coverUrl';
import { errorText } from '../apiError';
import { isFormatTag } from '../formatTags';
import TransferBar from './TransferBar';
import { IconSliders, IconEye, IconEyeOff, IconTag, IconUpload } from './icons';
import { isOwner } from '../me';
import { fmtOf, fmtSize } from '../transferSize';
import { pageZoom } from '../pageZoom';
import { landingBegin, landingEnd } from '../landing';

const IDLE = { active: false };
// Пока байты в пути, закрыть страницу — значит оборвать загрузку (продолжить потом можно, но зачем)
const SENDING = ['start', 'upload', 'resync', 'retry'];
// Финал загрузки по очереди: «В библиотеке» держится 960 мс, плашка гаснет 200 мс (transfer.css, .tb.leaving),
// и только потом игра встаёт на полку. При «уменьшить движение» плашка исчезает в тот же кадр
const FINALE_HOLD = 960;
const FINALE_FADE = 200;

// Пароль архива: поле и кнопка «Распаковать». Пароль уходит серверу и на странице не остаётся
// Набранное хранит Toolbar (value, setValue): панель плашки при сворачивании размонтируется, и пароль терялся бы
const PasswordForm = ({ t, onSubmit, value, setValue }) => {
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!value || busy) return;
    setBusy(true);
    try { await onSubmit(value); } finally { setBusy(false); setValue(''); }
  };
  return (
    <form className="upload-password" onSubmit={submit}>
      <input
        type="password" value={value} onChange={(e) => setValue(e.target.value)}
        placeholder={t.up_pw_placeholder} aria-label={t.up_pw_placeholder}
        autoComplete="off" autoCapitalize="off" spellCheck={false}
      />
      <button type="submit" className="tb-gold" disabled={!value || busy}>{t.up_pw_submit}</button>
    </form>
  );
};

// Архивы, которые принимает сервер (services/uploads.js)
const ARCHIVE_NAME = /\.(zip|7z|rar)$/i;

// От этой ширины глаз и «Добавить игру» стоят в шапке, на всех вкладках. Ниже — как раньше: глаз за «Фильтрами», добавление в меню
const HEADER_TOOLS = '(min-width: 1100px)';
const onWidthShift = (fn) => {
  const media = window.matchMedia(HEADER_TOOLS);
  media.addEventListener('change', fn);
  return () => media.removeEventListener('change', fn);
};

const Toolbar = ({ 
  searchQuery, setSearchQuery, availableTags, selectedTag, setSelectedTag,
  currentSort, setCurrentSort, onUploadSuccess, t, showToast, onOpenGame,
  blurCovers, setBlurCovers, canUpload, authed = canUpload,
  availableLangs = [], langFilter, setLangFilter, lang, openUploadRef, onTargetPicked,
  // Вкладка «Место» (App.jsx): места на сервере не хватает — там видно, что занимает диск
  onOpenSpace,
  // «Теги картинок» — фильтр по тому, что нарисовано в играх (App.jsx): { n, open, ordered, onClick }, picRef — кнопка, к ней прилегает панель
  picTags = null, picRef = null,
  // Свои подборки (App.jsx): список есть, когда есть хоть одна
  lists = [], listFilter = '', setListFilter,
  // На главной — только поиск (и «глаз» с «Добавить игру» на компьютере): жанры, языки и сортировка
  // относятся к библиотеке. Сама панель стоит на обеих страницах — в ней живёт загрузка архива
  filters = true,
  // На «Найти» строку прячем, но не убираем: в панели живёт загрузка (очередь, пароль архива, отмена,
  // «Добавить игру» из меню телефона) — её карточка и перетаскивание архива выводятся поверх страницы
  hideBar = false,
  // На главной поиск, «глаз» и «Добавить игру» стоят в строке шапки (toolbar.css, .in-header; только на компьютере). Узел
  // тот же и остаётся на месте в дереве: поиск с главной уводит в библиотеку, и поле не должно терять фокус и набранное
  inHeader = false,
  // Пустая библиотека (App.jsx): поиска нет — искать нечего; у добавления своя плитка, глаз — пока есть чьи обложки размывать
  noSearch = false, showAdd = canUpload, showEye = true,
  // Куда в шапке ставить глаз и «Добавить игру»: узел из Header, поэтому в «Найти» они тоже есть, хотя строка скрыта
  toolsEl = null,
}) => {
  const fileInputRef = useRef(null);
  const toolsWide = useSyncExternalStore(onWidthShift, () => window.matchMedia(HEADER_TOOLS).matches);

  // Варианты трёх списков панели. Жанры — самые частые первыми: по алфавиту
  // нужное приходилось искать среди сотни строк. Теги формата («2dcg», «japanese game») есть почти
  // у всех игр и стояли в самом верху — теперь они в конце, отдельной группой (formatTags.js)
  const genreOptions = useMemo(() => {
    const sorted = [...availableTags].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const option = (tag) => ({ value: tag.name, label: tag.name, count: tag.count });
    const formats = sorted.filter((tag) => isFormatTag(tag.name));
    return [
      { value: 'all', label: t.all_genres },
      ...sorted.filter((tag) => !isFormatTag(tag.name)).map(option),
      ...formats.map((tag, i) => ({ ...option(tag), group: i === 0 ? t.genre_format : undefined })),
    ];
  }, [availableTags, t]);
  const langOptions = useMemo(() => [
    { value: 'all', label: t.all_langs },
    ...availableLangs.map(({ code, count }) => ({ value: code, label: languageTitle(code, lang), count })),
  ], [availableLangs, lang, t]);
  const sortOptions = [
    ['newest', t.sort_new], ['oldest', t.sort_old], ['recent', t.sort_rec], ['playtime', t.sort_playtime],
    ['rating_desc', t.sort_rat], ['name', t.sort_alp], ['size_desc', t.sort_size_desc], ['size_asc', t.sort_size_asc],
    // Эти задают столбцы списка: в выпадающем списке — только пока выбраны, он и так длинный
    ...[['name_desc', t.sort_name_desc], ['version_desc', t.sort_version_desc], ['version_asc', t.sort_version_asc], ['status', t.sort_status], ['status_rev', t.sort_status_rev],
      ['playtime_asc', t.sort_playtime_asc], ['rating_asc', t.sort_rating_asc]].filter(([value]) => value === currentSort),
  ].map(([value, label]) => ({ value, label }));

  // Выбор архива: для новой игры или для новой версии игры из библиотеки (target — { id, title }).
  // Кому архив, запоминаем до выбора: отменённый выбор файла ничего не оставит — следующий
  // выбор всё равно скажет, кому он
  const targetRef = useRef(null);
  const openUpload = (target = null) => {
    targetRef.current = target;
    fileInputRef.current?.click();
  };
  // На телефоне кнопка «Добавить игру» живёт в меню шапки, «Обновить игру» — в окне игры:
  // отдаём им открытие выбора файла
  useEffect(() => {
    if (!openUploadRef) return undefined;
    openUploadRef.current = (target) => {
      targetRef.current = target || null;
      fileInputRef.current?.click();
    };
    return () => { openUploadRef.current = null; };
  }, [openUploadRef]);
  // Жанр, язык, подборки и теги картинок — за кнопкой «Фильтры» на любой ширине, под панелью: фильтруют не каждый день, а в ряд они
  // занимали полпанели. Ниже 1100 за ней же сортировка и «глаз». Число на кнопке — сколько фильтров включено; открытое запоминаем
  const [filtersShown, setFiltersShown] = useState(() => { try { return localStorage.getItem('rpg_libfilters') === '1'; } catch { return false; } });
  const setFiltersOpen = (next) => {
    const on = typeof next === 'function' ? next(filtersShown) : next;
    setFiltersShown(on);
    try { localStorage.setItem('rpg_libfilters', on ? '1' : ''); } catch { /* панель просто не запомнится */ }
  };
  const filtersOpen = filters && filtersShown;
  // Панель прилипает к верху под шапкой (index.css, .controls-zone): фильтровать и искать можно, не
  // прокручивая к началу. Высота прилипшей шапки на компьютере и телефоне разная — меряем её и отдаём
  // в --header-stuck; прилипла ли панель — в data-stuck (тень и фон), без перерисовки React
  const zoneRef = useRef(null);
  useLayoutEffect(() => {
    const header = document.querySelector('header');
    const zone = zoneRef.current;
    if (!header || !zone) return undefined;
    const root = document.documentElement.style;
    let stuckAt = 0;
    let fixed = false;
    const measure = () => {
      stuckAt = Math.max(0, header.offsetHeight + (parseFloat(getComputedStyle(header).top) || 0));
      root.setProperty('--header-stuck', `${stuckAt}px`);
      // Панель в шапке: слева её держат разделы (подписи на трёх языках, числа), справа — значок загрузок и «⋯»,
      // и то и другое меняет ширину на ходу. getBoundingClientRect — в точках экрана, стили — в точках вёрстки (pageZoom.js)
      fixed = getComputedStyle(zone).position === 'fixed';
      const zoom = pageZoom();
      const left = header.querySelector('.main-nav') || header.querySelector('.brand');
      const side = header.querySelector('.header-side');
      if (left) root.setProperty('--header-left', `${left.getBoundingClientRect().right / zoom}px`);
      if (side) root.setProperty('--header-right', `${(header.getBoundingClientRect().right - side.getBoundingClientRect().left) / zoom}px`);
      // Сколько сверху закрыто прилипшими шапкой и панелью: на столько отступает прокрутка к заголовку
      // или к карточке в фокусе (html { scroll-padding-top }) — иначе они уезжали под панель. Панель в шапке места не занимает
      root.setProperty('--sticky-total', `${stuckAt + (fixed ? 0 : zone.offsetHeight) + 12}px`);
      onScroll();
    };
    const onScroll = () => { zone.dataset.stuck = !fixed && zone.getBoundingClientRect().top / pageZoom() <= stuckAt + 1 && window.scrollY > 0 ? '1' : ''; };
    const resize = new ResizeObserver(measure);
    resize.observe(header);
    resize.observe(zone);
    // Ширина шапки от них не меняется: появился значок загрузок, сменился язык, подгрузился шрифт
    for (const el of header.querySelectorAll('.main-nav, .brand, .header-side')) resize.observe(el);
    window.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => { resize.disconnect(); window.removeEventListener('scroll', onScroll); };
    // authed: после входа в шапке появляются разделы — за ними надо следить (canUpload у человека не владельца не меняется)
  }, [inHeader, authed]);

  // «/» — сразу в поиск, как на GitHub и YouTube: когда поверх страницы ничего не открыто и курсор
  // не в поле ввода
  const searchRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || layersOpen()) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Библиотека: начали печатать буквы или цифры — сразу в поиск. Без preventDefault: знак сам попадёт в поле и способ ввода
  // (японский, китайский) останется при своём. Клавиша H — «Скрыть» и в другой раскладке (App.jsx, по e.code), поиск с неё не начинается
  useEffect(() => {
    if (!filters) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.code === 'KeyH') return;
      if (!/^[\p{L}\p{N}]$/u.test(e.key) && !(e.key === 'Process' && /^(Key|Digit)/.test(e.code))) return;
      if (!pageKeysFree(e) || !searchRef.current) return;
      searchRef.current.focus();
      // Уже что-то написано: продолжаем в конце, а не перед ним
      const end = searchRef.current.value.length;
      searchRef.current.setSelectionRange(end, end);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [filters]);
  const activeFilters = (selectedTag !== 'all' ? 1 : 0) + (langFilter !== 'all' ? 1 : 0) + (listFilter ? 1 : 0) + (picTags?.n ? 1 : 0);
  const [isDragging, setIsDragging] = useState(false);
  // Загрузка: phase — start, upload, resync, retry, processing, done, failed (resumableUpload.js)
  const [upload, setUpload] = useState(IDLE);
  // Недогруженные, распаковывающиеся и неудачные загрузки с сервера — видны и после перезагрузки
  // страницы: айфон выгружает её из памяти, пока смотришь другое приложение
  const [pending, setPending] = useState([]);
  const abortRef = useRef(null);
  // Загрузка ждёт пароль архива: сюда кладётся, кому его отдать
  const passwordRef = useRef(null);
  // Номер загрузки: таймер, закрывающий карточку прошлой, не закроет карточку новой
  const runRef = useRef(0);
  const onUploadSuccessRef = useRef(onUploadSuccess);
  useEffect(() => { onUploadSuccessRef.current = onUploadSuccess; }, [onUploadSuccess]);

  // Очередь: архивы, выбранные или брошенные, пока грузится другой. Грузятся по одному, по порядку;
  // неудача одного не останавливает остальные. Здесь — только ждущие, идущий — в upload.
  // Файлы живут в памяти страницы: закрыли её — очередь пропала (уже полученное сервер хранит)
  // queueRef — для решений (кто следующий), queue — для показа: обработчики окна и конец загрузки
  // видят ref свежим, а не тем, что было на момент их создания
  const [queue, setQueueState] = useState([]);
  const queueRef = useRef([]);
  const setQueue = (list) => { queueRef.current = list; setQueueState(list); };
  const queueKey = useRef(0);
  // Идёт загрузка (от выбора файла до «готово», ошибки или отмены) — следующему ждать
  const sendingRef = useRef(false);
  const startNext = () => {
    if (sendingRef.current) return;
    const [next, ...rest] = queueRef.current;
    if (!next) return;
    setQueue(rest);
    uploadFileRef.current(next.file, next.target);
  };
  // Тот же файл — по имени и размеру: время изменения у копии того же архива бывает другим
  const sameFile = (a, b) => a.name === b.name && a.size === b.size;

  // Поставить в очередь. Не архив, тот же файл второй раз, второе обновление той же игры — нет
  const enqueue = (files, target = null) => {
    const wrong = files.filter((f) => !ARCHIVE_NAME.test(f.name));
    if (wrong.length) showToast(t.wrong_ext, 'error');
    const add = [];
    for (const file of files.filter((f) => ARCHIVE_NAME.test(f.name))) {
      const taken = [...(sendingRef.current && upload.file ? [{ file: upload.file, target: upload.target }] : []), ...queueRef.current, ...add];
      if (taken.some((x) => sameFile(x.file, file) && (x.target?.id || '') === (target?.id || ''))) {
        showToast(t.up_queue_dup(file.name), 'error');
        continue;
      }
      if (target && taken.some((x) => x.target?.id === target.id)) {
        showToast(t.up_queue_same_game(target.title), 'error');
        continue;
      }
      add.push({ key: ++queueKey.current, file, target });
    }
    if (!add.length) return;
    // Ждать некого — первый пошёл сразу; остальные — в очередь
    if (sendingRef.current) showToast(t.up_queued_toast(add.length), 'success');
    setQueue([...queueRef.current, ...add]);
    startNext();
  };

  // Архив, выбранный как новая игра, бывает новой версией игры из библиотеки — иначе вторая карточка с пустыми сейвами.
  // Спрашиваем до отправки и сразу про все, а не когда подойдёт очередь: за большой очередью человек не сидит. Остальные
  // идут сразу, сервер не ответил — вопроса нет. Вопросов бывает несколько: в каждом — имя файла
  const addNew = async (files) => {
    // Человек с правом загрузки добавляет только новые игры: вопроса про новую версию ему нет, и этот адрес ему закрыт
    if (!isOwner()) { enqueueRef.current(files); return; }
    const answers = await Promise.all(files.map((f) => (ARCHIVE_NAME.test(f.name) ? matchUpload(f.name).catch(() => null) : null)));
    const plain = files.filter((_, i) => !answers[i]?.match);
    if (plain.length) enqueueRef.current(plain);
    for (const [i, file] of files.entries()) {
      const match = answers[i]?.match;
      if (!match) continue;
      const choice = await confirmDialog({
        title: t.up_newver_title(match.title), name: file.name, text: t.up_newver_text,
        confirmLabel: t.up_newver_replace, otherLabel: t.up_newver_separate, cover: getCoverUrl(match, 360),
      });
      if (choice === 'other') separateRef.current.add(file);
      if (choice) enqueueRef.current([file], choice === true ? { id: match.id, title: match.title } : null);
    }
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    const target = targetRef.current;
    targetRef.current = null;
    e.target.value = '';
    if (!files.length) return;
    // Архив для новой версии выбран — окно игры закрываем: на телефоне карточка загрузки
    // легла бы поверх его крестика, а ход обновления и так виден на карточке.
    // Новая версия или патч — один архив: остальные выбранные не к ней
    if (target) {
      onTargetPicked?.(target);
      if (files.length > 1) showToast(t.up_one_for_update, 'error');
      enqueue(files.slice(0, 1), target);
    } else {
      addNew(files);
    }
  };

  // Обработчики ниже вешаются на окно один раз, а uploadFile и enqueue пересоздаются на каждом
  // рендере (в них язык, тосты, очередь). Через ref они всегда зовут свежую версию,
  // иначе после смены языка загрузка писала бы сообщения на старом.
  const uploadFileRef = useRef(null);
  const enqueueRef = useRef(null);
  const addNewRef = useRef(null);
  // Архивы, про которые человек сам сказал «Добавить отдельной игрой»: «появилась вторая копия» им уже не новость
  const separateRef = useRef(new WeakSet());

  // Архив можно бросить в любое место страницы, а не только на кнопку: кнопка
  // на телефоне и на широком экране — маленькая цель, а при прокрутке её вообще не видно.
  useEffect(() => {
    if (!canUpload) return undefined;

    // dragenter и dragleave приходят на каждый дочерний элемент по пути курсора.
    // Без счётчика оверлей мигал бы на каждой границе карточки.
    let depth = 0;
    // Картинку со страницы тоже можно потащить, и браузер тоже назовёт её «файлом».
    // Такие перетаскивания начинаются внутри документа — их отличаем по dragstart.
    let internal = false;

    const hasFiles = (e) => !internal && Array.from(e.dataTransfer?.types || []).includes('Files');

    const onStart = () => { internal = true; };
    const onEnd = () => { internal = false; };
    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setIsDragging(true);
    };
    const onOver = (e) => {
      if (!hasFiles(e)) return;
      // Без preventDefault браузер не разрешит бросить файл и просто откроет его во вкладке
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setIsDragging(false);
      // Несколько архивов разом — все в очередь; идёт загрузка — встанут за ней
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) addNewRef.current(files);
    };

    window.addEventListener('dragstart', onStart);
    window.addEventListener('dragend', onEnd);
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragstart', onStart);
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [canUpload]);

  const refreshPending = useCallback(() => {
    if (canUpload) listUploads().then(setPending).catch(() => {});
  }, [canUpload]);
  useEffect(() => { refreshPending(); }, [refreshPending]);

  // Распаковка, начатая до перезагрузки страницы, и загрузка, идущая с другого устройства: следим,
  // пока не кончатся. Готовая уходит из списка — значит, игра уже в библиотеке
  useEffect(() => {
    const going = pending.filter((u) => u.state === 'processing' || u.busy);
    if (!going.length) return undefined;
    const timer = setInterval(async () => {
      const list = await listUploads().catch(() => null);
      if (!list) return;
      if (going.some((u) => !list.some((x) => x.id === u.id))) onUploadSuccessRef.current();
      setPending(list);
    }, 3000);
    return () => clearInterval(timer);
  }, [pending]);

  // Уйти со страницы посреди загрузки или с очередью — спросить: ждущие архивы живут только здесь
  const leaving = (upload.active && SENDING.includes(upload.phase)) || queue.length > 0;
  useEffect(() => {
    if (!leaving) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [leaving]);

  // Кнопка «Открыть «Место»» у тоста и строки, которым не хватило места
  const spaceAction = onOpenSpace && isOwner() ? { label: t.space_open, onClick: onOpenSpace } : null;
  const sizes = (x) => [fmtSize(x?.need || 0, t), fmtSize(x?.free || 0, t)];

  const uploadErrorText = (e) => {
    if (e.kind === 'read') return t.up_read(e.received ? fmtSize(e.received, t) : '');
    // Не распаковалось — это ответ сервера (из состояния загрузки, без кода ответа), а не сеть
    const text = errorText(t, e.processed ? { status: 422, error: e.message, reason: e.reason, params: e.params } : e, { fallback: t.up_err });
    return e.received > 0 && !e.processed ? `${text}. ${t.up_resume_hint(fmtSize(e.received, t))}` : text;
  };

  const uploadFile = async (file, target = null) => {
    if (!ARCHIVE_NAME.test(file.name)) {
      showToast(t.wrong_ext, 'error');
      return;
    }
    sendingRef.current = true;
    const run = ++runRef.current;
    const closeLater = (ms) => setTimeout(() => { if (runRef.current === run) setUpload(IDLE); }, ms);
    // Новая игра (не обновление и не патч) встанет на полку после финала плашки; не дошло до него — отпускаем сразу
    const lands = !target;
    let landed = !lands;
    let finale = false;
    const land = (folder) => { if (landed) return; landed = true; landingEnd(folder); };
    if (lands) landingBegin();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // Остаток времени: скорость — с начала этой передачи (при докачке — с места, где продолжили), не раньше чем через 3 с
    const clock = { at: 0, from: 0, eta: 0 };
    setUpload({ active: true, name: file.name, size: file.size, received: 0, phase: 'start', target, file });
    try {
      const result = await uploadArchive(file, {
        signal: ctrl.signal,
        target: target?.id,
        mode: target?.mode,
        onState: (state) => {
          if (state.resumed) showToast(t.up_resumed(fmtSize(state.received, t), fmtSize(state.size, t)), 'success');
          if (typeof state.received === 'number') {
            const now = Date.now();
            if (!clock.at) { clock.at = now; clock.from = state.received; }
            else if (now - clock.at >= 3000 && state.received > clock.from) clock.eta = Math.ceil((file.size - state.received) / ((state.received - clock.from) / ((now - clock.at) / 1000)));
          }
          setUpload((prev) => ({ ...prev, ...state, eta: clock.eta }));
        },
        // Ответ — из поля пароля на карточке; отмена загрузки обрывает ожидание. За архивом в очереди
        // ждут другие — пароль не ждём: архив остаётся на сервере ждать пароля (его спросит список
        // «не догружено», когда очередь пройдёт), а очередь идёт дальше
        // Оценка места не сошлась: архив с игрой может не влезть. Решает человек — сжатый репак влезет и так
        // Человеку «всё равно» не предлагаем: сервер отвечает ему жёстким отказом
        askSpace: isOwner() ? ({ need, free }) => confirmDialog({
          title: t.up_space_title, name: file.name, text: t.up_space_text(...sizes({ need, free })), confirmLabel: t.up_space_anyway,
        }) : undefined,
        askPassword: () => new Promise((resolve, reject) => {
          if (queueRef.current.length > 0) {
            reject(new UploadError('parked'));
            return;
          }
          passwordRef.current = resolve;
          ctrl.signal.addEventListener('abort', () => reject(new UploadError('cancelled')), { once: true });
        }),
      });
      setUpload((prev) => ({ ...prev, phase: 'done', patch: result?.patch || null, copy: !!result?.copy }));
      // Такая игра уже была: вышла вторая карточка. Человек мог хотеть обновить её — сказать об этом, а не «игра добавлена»
      if (result?.copy && !separateRef.current.has(file)) showToast(t.up_copy(file.name), 'info');
      onUploadSuccess();
      finale = true;
      // Следующий архив из очереди мог уже занять плашку: тогда финала для этого не будет, игру ставим сразу
      setTimeout(() => {
        if (runRef.current !== run) { land(result?.folder); return; }
        const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        setUpload((prev) => ({ ...prev, leaving: true }));
        setTimeout(() => {
          if (runRef.current === run) setUpload(IDLE);
          land(result?.folder);
        }, calm ? 0 : FINALE_FADE);
      }, FINALE_HOLD);
    } catch (e) {
      if (e.kind === 'cancelled') {
        // Список обновит сама отмена — когда сервер удалит полученное
        setUpload(IDLE);
        showToast(t.up_cancelled, 'success');
        return;
      }
      if (e.kind === 'parked') {
        setUpload(IDLE);
        showToast(t.up_parked(file.name), 'info');
        refreshPending();
        return;
      }
      // Места нет: до начала — не грузим (не влезет и архив или «всё равно» не нажали); на распаковке — архив ждёт
      // на сервере, «Повторить» у него в списке. Причина — нашими словами на любом языке, и кнопка «Место»
      const text = e.space && e.processed ? t.up_space_unpack(...sizes(e.body))
        : e.space ? (e.body?.hard ? t.up_space_hard : t.up_space_text)(...sizes(e.body))
          : uploadErrorText(e);
      showToast(text, 'error', e.space ? spaceAction : null);
      setUpload((prev) => ({ ...prev, phase: 'failed', text }));
      // Отказ в распаковке остаётся в списке с сервера, пока человек его не закроет: кто отошёл на время большой загрузки,
      // вернётся и прочтёт причину. Карточка уходит — на её месте встаёт строка этого списка
      closeLater(8000);
    } finally {
      abortRef.current = null;
      passwordRef.current = null;
      if (!finale) land();
      // Следующий из очереди — как только этот кончился, чем бы ни кончился. Карточка готового
      // («Готово», ошибка) ждать своего закрытия не заставляет
      sendingRef.current = false;
      startNext();
    }
    refreshPending();
  };

  // Набранные пароли: ключ — текущая загрузка или id недогруженной
  const [drafts, setDrafts] = useState({});
  const draft = (key) => ({ value: drafts[key] || '', setValue: (v) => setDrafts((d) => ({ ...d, [key]: v })) });

  const submitPassword = (password) => {
    const give = passwordRef.current;
    passwordRef.current = null;
    give?.(password);
  };
  // Пароль для архива из карточки «не догружено»: страницу, с которой его грузили, уже закрыли
  const submitPendingPassword = async (u, password) => {
    try {
      await sendPassword(u.id, password);
    } catch (e) {
      showToast(errorText(t, e, { fallback: t.up_err }), 'error');
    }
    refreshPending();
  };
  useEffect(() => {
    uploadFileRef.current = uploadFile;
    enqueueRef.current = enqueue;
    addNewRef.current = addNew;
  });

  // Отменить идущую загрузку: полученное сервер удалит. Случайное касание на телефоне стоило бы
  // гигабайтов, поэтому — с вопросом
  const cancelCurrent = async () => {
    const ok = await confirmDialog({
      title: t.up_cancel_title, name: upload.name, text: t.up_cancel_text,
      confirmLabel: t.up_cancel, cancelLabel: t.up_keep, danger: true,
    });
    if (!ok) return;
    abortRef.current?.abort();
    if (upload.id) cancelUpload(upload.id).catch(() => {}).finally(refreshPending);
  };

  // Ждёт места: место освободили — распаковать снова. Не хватит и теперь — строка останется с новыми числами
  const retryPending = async (u) => {
    try {
      await retryUpload(u.id);
    } catch (e) {
      showToast(errorText(t, e, { fallback: t.up_err }), 'error');
    }
    refreshPending();
  };

  // Убрать из списка: недогруженную или ждущую пароля или места — удалить с сервера (тоже с вопросом),
  // неудачную — просто скрыть
  const forgetPending = async (u) => {
    if (u.state === 'uploading' || u.state === 'password' || u.state === 'space') {
      const ok = await confirmDialog({ title: t.up_forget_title, name: u.name, text: t.up_forget_text, confirmLabel: t.up_forget, danger: true });
      if (!ok) return;
    }
    cancelUpload(u.id).catch(() => {}).finally(refreshPending);
  };

  const pct = ['processing', 'password', 'done'].includes(upload.phase) ? 100 : Math.floor(((upload.received || 0) / (upload.size || 1)) * 100);
  const uploadText = {
    start: t.up_trans(upload.name),
    retry: t.up_retry(upload.retryIn),
    password: upload.wrong ? t.up_pw_wrong : t.up_pw_need,
    processing: (upload.step && t.up_steps[upload.step]) || t.up_wait,
    done: upload.target?.mode === 'patch'
      ? t.up_patched(upload.patch?.replaced ?? 0, upload.patch?.added ?? 0)
      : upload.target ? t.up_updated : upload.copy ? t.up_copy_short : t.up_done,
    failed: upload.text,
  }[upload.phase] || t.up_prog(fmtSize(upload.received || 0, t), fmtSize(upload.size || 0, t));
  // Та же загрузка, что идёт сейчас (при докачке сервер уже знает её под этим же именем), в списке второй раз не нужна
  const shownPending = pending.filter((u) => u.id !== upload.id && !(upload.active && u.name === upload.name && u.size === upload.size));

  // Строки для плашки (TransferBar.jsx): всё, что решает, живёт здесь, плашка только рисует.
  // Этап: 0 — передача, 1 — распаковка (и ожидание пароля), 2 — в библиотеке
  const nameOf = (target, mode, name) => (target ? (mode === 'patch' ? t.up_patch_of : t.up_update_of)(target) : name);
  const stage = ['processing', 'password'].includes(upload.phase) || (upload.phase === 'failed' && upload.received >= upload.size) ? 1 : upload.phase === 'done' ? 2 : 0;
  const cancellable = SENDING.includes(upload.phase) || upload.phase === 'password';
  const currentItem = upload.active ? {
    key: 'current', name: nameOf(upload.target?.title, upload.target?.mode, upload.name), stage, frac: (upload.received || 0) / (upload.size || 1),
    leaving: !!upload.leaving,
    // На «В библиотеке» проценты остаются, но приглушены (TransferBar.jsx, dim): без них место справа пустело бы
    pct, word: upload.phase === 'failed' ? '' : t.tb_stage[stage],
    // «Передача X...» из заголовка карточки здесь лишнее: имя стоит строкой выше, а сколько ушло — в размере
    text: upload.phase === 'start' ? fmtOf(0, upload.size || 0, t)
      : ['upload', 'resync'].includes(upload.phase) || !upload.phase ? fmtOf(upload.received || 0, upload.size || 0, t) : uploadText,
    bad: upload.phase === 'failed' || (upload.phase === 'password' && !!upload.wrong),
    ask: upload.phase === 'password' ? 'password' : null,
    extra: upload.phase === 'password' ? <PasswordForm t={t} onSubmit={submitPassword} {...draft('current')} /> : null,
    eta: upload.phase === 'upload' && upload.eta > 0 ? t.tb_eta(Math.ceil(upload.eta / 60)) : '',
    onStop: cancellable ? cancelCurrent : null, stopLabel: t.tb_cancel, stopTitle: t.up_cancel,
  } : null;
  // Недогруженные и ждущие пароль видны и пока идёт другая загрузка: иначе плашка обещала бы «ещё N» без пояснений
  const pendingItems = shownPending.map((u) => {
    const text = u.state === 'uploading' ? (u.busy ? t.up_busy_other : t.up_left)(fmtSize(u.received, t), fmtSize(u.size, t))
      : u.state === 'processing' ? (u.queued ? t.up_steps.queued : t.up_wait)
        : u.state === 'password' ? (u.error ? t.up_pw_wrong : t.up_pw_need)
          : u.state === 'space' ? t.up_space_unpack(...sizes(u))
            // Неудачная: причина из метки загрузки, как и у той, за которой следит страница (uploadErrorText)
            : errorText(t, { status: 422, error: u.error, reason: u.reason, params: u.params }, { fallback: t.up_err });
    return {
      key: u.id, name: nameOf(u.target, u.mode, u.name), stage: u.state === 'uploading' ? 0 : 1, frac: (u.received || 0) / (u.size || 1),
      pct: u.state === 'uploading' ? Math.floor(((u.received || 0) / (u.size || 1)) * 100) : null,
      word: u.state === 'error' ? '' : t.tb_stage[u.state === 'uploading' ? 0 : 1], text,
      // В строке плашки — только «сколько из скольких»; «Не догружено: …» целиком читается в панели
      short: u.state === 'uploading' && !u.busy ? fmtOf(u.received, u.size, t) : undefined,
      bad: u.state === 'error' || (u.state === 'password' && !!u.error),
      ask: u.state === 'password' ? 'password' : u.state === 'space' ? 'space' : u.state === 'uploading' && !u.busy ? 'left' : null,
      acts: u.state === 'space' ? [{ key: 'retry', label: t.jd_retry, onClick: () => retryPending(u) }, ...(spaceAction ? [{ key: 'space', ...spaceAction, close: true }] : [])] : null,
      onPick: u.state === 'uploading' && !u.busy ? () => openUpload(u.target ? { id: u.target, title: u.target, mode: u.mode || undefined } : null) : null,
      onStop: u.state !== 'processing' && !u.busy ? () => forgetPending(u) : null,
      stopLabel: u.state === 'error' ? t.up_hide : t.tb_cancel, stopTitle: u.state === 'error' ? t.up_hide : t.up_forget,
      extra: u.state === 'password' ? <PasswordForm t={t} onSubmit={(password) => submitPendingPassword(u, password)} {...draft(u.id)} /> : null,
    };
  });
  const queueItems = queue.map((q) => ({
    key: q.key, name: nameOf(q.target?.title, q.target?.mode, q.file.name), size: fmtSize(q.file.size, t),
    onRemove: () => setQueue(queueRef.current.filter((x) => x.key !== q.key)),
  }));

  // Пока выбран тег картинок, порядок — по числу таких кадров. При открытой панели список остаётся, но выключен: иначе
  // кнопки в ряду разъезжались бы прямо под рукой, и панель оказывалась не под своей кнопкой
  const sortPicker = (!picTags?.ordered || picTags.open) && <Picker options={sortOptions} value={currentSort} onChange={setCurrentSort} label={t.list_sort} className="sort-order" disabled={!!picTags?.ordered} />;

  // Кнопка глаза без текста, поэтому смысл — в подсказке и в aria-label:
  // иначе назначение приходится угадывать, а экранный диктор читает «кнопка»
  const tools = (
    <>
      {showEye && <button
        type="button"
        className={`cover-toggle ${blurCovers ? 'active' : ''}`}
        onClick={() => setBlurCovers(v => !v)}
        data-tip={blurCovers ? t.covers_show : t.covers_hide}
        aria-label={blurCovers ? t.covers_show : t.covers_hide}
        aria-pressed={blurCovers}
      >
        {blurCovers ? (
          <IconEyeOff />
        ) : (
          <IconEye />
        )}
      </button>}

      {/* Игры добавляет владелец и человек с правом загрузки: у остальных кнопки нет */}
      {canUpload && showAdd && (
        <button
          type="button"
          className="upload-btn"
          aria-label={t.add_game}
          data-tip={t.add_game}
          onClick={() => openUpload()}
        >
          <IconUpload />
          {/* На ширине ноутбука подпись прячется — кнопка значком, как «глаз», и ряд влезает в строку */}
          <span className="upload-btn-text">{t.add_game}</span>
        </button>
      )}
    </>
  );

  return (
    <div ref={zoneRef} className={`controls-zone${filtersOpen ? ' filters-open' : ''}${filters ? '' : ' compact'}${hideBar ? ' bar-hidden' : ''}${inHeader ? ' in-header' : ''}`}>
      {!noSearch && <SearchBox
        value={searchQuery} onChange={setSearchQuery} placeholder={t.search} clearLabel={t.search_clear}
        inputRef={searchRef} keyHint="/"
      />}

      {filters && <button
        type="button"
        className={`filters-toggle${filtersOpen ? ' open' : ''}${activeFilters ? ' active' : ''}`}
        onClick={() => setFiltersOpen(v => !v)}
        aria-expanded={filtersOpen}
        aria-controls="toolbar-filters"
      >
        <IconSliders />
        {t.filters}
        {activeFilters > 0 && <span className="filters-count">{activeFilters}</span>}
      </button>}

      {/* От 1100 сортировка стоит рядом с «Фильтры» и видна всегда; ниже — внутри, вместе с «глазом». Один экземпляр на ширину */}
      {filters && toolsWide && sortPicker}

      <div className="toolbar-filters" id="toolbar-filters">
      {/* Три списка одного вида: жанры с поиском (их под сотню), языки и сортировка —
          без него. Подсветка кнопки — знак, что фильтр включён */}
      {filters && <>
      <Picker
        options={genreOptions} value={selectedTag} onChange={setSelectedTag} label={t.list_genre}
        searchable searchPlaceholder={t.genre_search} emptyText={t.genre_none}
        highlight={selectedTag !== 'all'}
      />

      {/* Язык по тексту самой игры, а не по магазину */}
      {availableLangs.length > 1 && (
        <Picker
          options={langOptions} value={langFilter} onChange={setLangFilter} label={t.list_lang}
          highlight={langFilter !== 'all'} className="lang-filter"
        />
      )}

      {lists.length > 0 && (
        <Picker
          options={[{ value: '', label: t.lists_all }, ...lists.map((x) => ({ value: x, label: x }))]} value={listFilter} onChange={setListFilter} label={t.lists_label}
          searchable={lists.length > 8} searchPlaceholder={t.lists_search} emptyText={t.lists_none}
          highlight={!!listFilter} className="list-filter"
        />
      )}

      {picTags && (
        <div className="picker pic-tags-tool">
          <button ref={picRef} type="button" className={`sort-box picker-btn ${picTags.n ? 'has-value' : ''}`} aria-haspopup="dialog" aria-expanded={picTags.open} onClick={picTags.onClick}>
            <IconTag /><span>{t.lib_pic_tags}</span>{picTags.n > 0 && <span className="tag-tool-n">{picTags.n}</span>}
          </button>
        </div>
      )}

      {!toolsWide && sortPicker}
      </>}

      {toolsWide && toolsEl ? createPortal(tools, toolsEl) : tools}
      </div>

      <input type="file" multiple ref={fileInputRef} style={{ display: 'none' }} accept=".zip,.7z,.rar,application/zip,application/x-rar-compressed,application/vnd.rar,application/x-7z-compressed,application/octet-stream" onChange={handleFileSelect}/>

      {/* Оверлей и карточка загрузки рисуются прямо в body: бросить архив можно
          с любого места страницы, и ход загрузки должен быть виден там же,
          а не в панели, до которой надо прокручивать */}
      {isDragging && createPortal(
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-frame">
            <span className="drop-overlay-icon"><IconUpload /></span>
            <div className="drop-overlay-title">{t.drop_title}</div>
            <div className="drop-overlay-hint">{t.drop_hint}</div>
          </div>
        </div>,
        document.body
      )}

      <TransferBar t={t} current={currentItem} pending={pendingItems} queue={queueItems} onAdd={() => openUpload()} onOpenGame={onOpenGame} />
    </div>
  );
};

export default Toolbar;
