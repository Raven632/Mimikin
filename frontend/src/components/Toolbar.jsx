import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { languageTitle } from '../formatLanguage';
import { uploadArchive, listUploads, cancelUpload, sendPassword, UploadError } from '../resumableUpload';
import Picker from './Picker';
import SearchBox from './SearchBox';
import { layersOpen } from '../layers';
import { confirmDialog } from '../confirm';
import { errorText } from '../apiError';
import { isFormatTag } from '../formatTags';
import TransferBar from './TransferBar';
import { IconSliders, IconEye, IconEyeOff, IconUpload } from './icons';
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

const Toolbar = ({ 
  searchQuery, setSearchQuery, availableTags, selectedTag, setSelectedTag,
  currentSort, setCurrentSort, onUploadSuccess, t, showToast, onOpenGame,
  blurCovers, setBlurCovers, canUpload,
  availableLangs = [], langFilter, setLangFilter, lang, openUploadRef, onTargetPicked,
  // На главной — только поиск (и «глаз» с «Добавить игру» на компьютере): жанры, языки и сортировка
  // относятся к библиотеке. Сама панель стоит на обеих страницах — в ней живёт загрузка архива
  filters = true,
  // На «Новинках» строку прячем, но не убираем: в панели живёт загрузка (очередь, пароль архива, отмена,
  // «Добавить игру» из меню телефона) — её карточка и перетаскивание архива выводятся поверх страницы
  hideBar = false,
}) => {
  const fileInputRef = useRef(null);

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
  // На телефоне жанр, язык, сортировка и «глаз» — за кнопкой «Фильтры»: в четыре ряда панель
  // отодвигала первую игру на полэкрана. Число на кнопке — сколько фильтров включено
  const [filtersShown, setFiltersOpen] = useState(false);
  const filtersOpen = filters && filtersShown;
  // Панель прилипает к верху под шапкой (index.css, .controls-zone): фильтровать и искать можно, не
  // прокручивая к началу. Высота прилипшей шапки на компьютере и телефоне разная — меряем её и отдаём
  // в --header-stuck; прилипла ли панель — в data-stuck (тень и фон), без перерисовки React
  const zoneRef = useRef(null);
  useEffect(() => {
    const header = document.querySelector('header');
    const zone = zoneRef.current;
    if (!header || !zone) return undefined;
    let stuckAt = 0;
    const measure = () => {
      stuckAt = Math.max(0, header.offsetHeight + (parseFloat(getComputedStyle(header).top) || 0));
      document.documentElement.style.setProperty('--header-stuck', `${stuckAt}px`);
      // Сколько сверху закрыто прилипшими шапкой и панелью: на столько отступает прокрутка к заголовку
      // или к карточке в фокусе (html { scroll-padding-top }) — иначе они уезжали под панель
      document.documentElement.style.setProperty('--sticky-total', `${stuckAt + zone.offsetHeight + 12}px`);
      onScroll();
    };
    const onScroll = () => { zone.dataset.stuck = zone.getBoundingClientRect().top / pageZoom() <= stuckAt + 1 && window.scrollY > 0 ? '1' : ''; };
    const resize = new ResizeObserver(measure);
    resize.observe(header);
    resize.observe(zone);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { resize.disconnect(); window.removeEventListener('scroll', onScroll); };
  }, []);

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
  const activeFilters = (selectedTag !== 'all' ? 1 : 0) + (langFilter !== 'all' ? 1 : 0);
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
      enqueue(files);
    }
  };

  // Обработчики ниже вешаются на окно один раз, а uploadFile и enqueue пересоздаются на каждом
  // рендере (в них язык, тосты, очередь). Через ref они всегда зовут свежую версию,
  // иначе после смены языка загрузка писала бы сообщения на старом.
  const uploadFileRef = useRef(null);
  const enqueueRef = useRef(null);

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
      if (files.length) enqueueRef.current(files);
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

  const uploadErrorText = (e) => {
    if (e.kind === 'read') return t.up_read(e.received ? fmtSize(e.received, t) : '');
    // Не распаковалось — это ответ сервера (из состояния загрузки, без кода ответа), а не сеть
    const text = errorText(t, e.processed ? { status: 422, error: e.message } : e, { fallback: t.up_err });
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
    let id = null;
    // Остаток времени: скорость — с начала этой передачи (при докачке — с места, где продолжили), не раньше чем через 3 с
    const clock = { at: 0, from: 0, eta: 0 };
    setUpload({ active: true, name: file.name, size: file.size, received: 0, phase: 'start', target, file });
    try {
      const result = await uploadArchive(file, {
        signal: ctrl.signal,
        target: target?.id,
        mode: target?.mode,
        onState: (state) => {
          if (state.id) id = state.id;
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
        askPassword: () => new Promise((resolve, reject) => {
          if (queueRef.current.length > 0) {
            reject(new UploadError('parked'));
            return;
          }
          passwordRef.current = resolve;
          ctrl.signal.addEventListener('abort', () => reject(new UploadError('cancelled')), { once: true });
        }),
      });
      setUpload((prev) => ({ ...prev, phase: 'done', patch: result?.patch || null }));
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
      const text = uploadErrorText(e);
      showToast(text, 'error');
      setUpload((prev) => ({ ...prev, phase: 'failed', text }));
      // Ошибку распаковки уже показали — из списка неудачных её убираем
      if (e.processed && id) await cancelUpload(id).catch(() => {});
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

  // Убрать из списка: недогруженную или ждущую пароля — удалить с сервера (тоже с вопросом),
  // неудачную — просто скрыть
  const forgetPending = async (u) => {
    if (u.state === 'uploading' || u.state === 'password') {
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
      : upload.target ? t.up_updated : t.up_done,
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
        : u.state === 'password' ? (u.error ? t.up_pw_wrong : t.up_pw_need) : u.error;
    return {
      key: u.id, name: nameOf(u.target, u.mode, u.name), stage: u.state === 'uploading' ? 0 : 1, frac: (u.received || 0) / (u.size || 1),
      pct: u.state === 'uploading' ? Math.floor(((u.received || 0) / (u.size || 1)) * 100) : null,
      word: u.state === 'error' ? '' : t.tb_stage[u.state === 'uploading' ? 0 : 1], text,
      // В строке плашки — только «сколько из скольких»; «Не догружено: …» целиком читается в панели
      short: u.state === 'uploading' && !u.busy ? fmtOf(u.received, u.size, t) : undefined,
      bad: u.state === 'error' || (u.state === 'password' && !!u.error),
      ask: u.state === 'password' ? 'password' : u.state === 'uploading' && !u.busy ? 'left' : null,
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

  return (
    <div ref={zoneRef} className={`controls-zone${filtersOpen ? ' filters-open' : ''}${filters ? '' : ' compact'}${hideBar ? ' bar-hidden' : ''}`}>
      <SearchBox
        value={searchQuery} onChange={setSearchQuery} placeholder={t.search} clearLabel={t.search_clear}
        inputRef={searchRef} keyHint="/"
      />

      {/* Видна только на телефоне (index.css): на широком экране всё стоит в ряд и так */}
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

      <Picker options={sortOptions} value={currentSort} onChange={setCurrentSort} label={t.list_sort} className="sort-order" />
      </>}

      {/* Кнопка без текста, поэтому смысл — в подсказке и в aria-label:
          иначе назначение приходится угадывать, а экранный диктор читает «кнопка» */}
      <button
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
      </button>

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
