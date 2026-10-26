import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { useCoversHidden } from '../coversHidden';
import { errorText, httpError } from '../apiError';
import StateView from './StateView';
import MimicLoader from './MimicLoader';
import RetryImg from './RetryImg';
import SoundRoom from './SoundRoom';
import SceneView from './SceneView';
import ScenePick from './ScenePick';
import BarChoose from './BarChoose';
import { VideoSeek } from './VideoSeek';
import { useVideoControl } from '../videoControl';
import SceneList from './SceneList';
import { rigCoverUrl, useRigCovers } from './rigCapture';
import { HelpMark } from './Help';
import { useHelp } from '../useHelp';
import { IconClose, IconChevronLeft, IconChevronRight, IconHeart, IconHeartLine, IconExpand, IconSound, IconMute, IconPlay, IconPause, IconShuffle, IconTalk, IconFilm, IconLoop, IconFork } from './icons';
import { readSound, writeSound, hasSound, SPEEDS, readSpeed, writeSpeed, STEPS, readStep, writeStep, shuffled, useZoom, useGalleryImage, readSpineCover, sceneRows } from '../galleryView';
import { flash } from '../pulse';
// Набор Spine играет pixi: тяжёлый, грузится только когда открыли такую анимацию
// Файл не открылся (заблокирован, сайт обновили, а вкладка старая) — пустое поле вместо белого экрана
const SpineView = lazy(() => import('./SpineView').catch(() => ({ default: () => null })));
// Модель Live2D — так же: pixi и библиотека грузятся, когда открыли такой альбом
const Live2DView = lazy(() => import('./Live2DView').catch(() => ({ default: () => null })));

const PAGE = 48;
// Два уровня: раздел («Картинки», «Сцены», «Звуки», «С сайтов») и чипы внутри него. «Сцены» и «Диалоги» — плитки сцен
// (SceneList) в той же сетке, что и альбомы; чипы «Картинок» — альбомы по виду. Первый чип — CG: книга картинок игры
const SCENE_TABS = ['scenes', 'dialogue'];
const PIC_TABS = ['cg', 'animation', 'video', 'portrait', 'backdrop', 'all', 'engine'];
const FPS = 8;
const NO_ROWS = [];
// Сколько кадров анимации грузим вперёд
const PRELOAD = 24;
// Что во вкладке: «Всё» — файлы игры без стандартных ресурсов движка (у них своя вкладка); «Анимации» — ещё и
// покадровые (кадры подряд, играют сами), из любых разделов
const tabAlbums = (albums, key) => albums.filter((a) => {
  // Диалоги — не картинки: их нет ни в «Всё», ни в других вкладках с альбомами
  if (key === 'all') return a.kind !== 'engine' && a.kind !== 'dialogue';
  if (key === 'animation') return a.kind === 'animation' || (a.anim && a.kind !== 'engine');
  // Покадровая анимация живёт во вкладке «Анимации», не в CG, персонажах и фонах
  return a.kind === key && !a.anim;
});
// Темп раскадровки из событий — от сервера (по паузам в событии)
const fpsOf = (a) => (a?.anim ? a.fps || FPS : FPS);
// Ролик — плеером, а не картинкой (сервер отдаёт его отдельно, с перемоткой)
const isVideo = (f) => /\.(webm|mp4|m4v|ogv)$/i.test(f || '');
// Имя сцены — последняя часть ключа альбома; «#loop», «#parts» и подобное — пометки сервера (петли и части
// отдельно), а не имя
const sceneName = (key) => key.split('/').pop().replace(/(#\w+)+$/, '');
// Набор Spine или модель Live2D: кадр альбома — движение, играет canvas; обложку плитки снимает первый просмотр
const isRig = (a) => !!(a.spine || a.live2d);

const api = (id, what, file) => `/api/gallery/${encodeURIComponent(id)}/${what}?f=${encodeURIComponent(file)}`;

// Галерея из файлов игры (сервер: services/gallery.js). Альбомы — в порядке игры.
// Вкладки: CG (и кадры, склеенные из слоёв: основа, лицо, одежда), анимации (GIF, APNG, WebP — движутся
// сами), видео (ролики из movies/ и те, что плагины кладут в img/), персонажи в полный рост, фоны и всё
// подряд (со слоями, из которых игра собирает CG, и интерфейсом). Альбом — одна сцена со всеми
// вариантами и кадрами: листается подряд, за последним кадром — следующий альбом; кадры можно
// проиграть, как анимацию. Сетка догружается сама при прокрутке. Сердечко — в «Избранное» (FavoritesGallery):
// лучшее из разных игр одним альбомом.
// Подпись клетки в сетке движений Live2D: число из имени (emotion_103 — «103», m-17 — «17», idle_01_70 — «01_70»),
// а если цифр в имени нет — само имя
const motionCell = (name) => (name.match(/\d[\w-]*$/) || [name])[0];
// Поле поиска нужно только моделям со словесными именами (angry, happy, idle): у номерных поиск — это набор цифр, а сетка
// и так видна целиком. Словесных — больше половины и список не короткий
const wordMotions = (motions) => motions.length > 12 && motions.filter((m) => !/\d/.test(m[0])).length * 2 > motions.length;

const GameGallery = ({ game, t, onClose, initialFile = '' }) => {
  const help = useHelp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState(null);       // чип раздела; null — первый непустой
  const [shown, setShown] = useState(PAGE);
  const [view, setView] = useState(null);      // { album, index } — открытая картинка
  const viewOpen = useRef(false);
  useEffect(() => { viewOpen.current = !!view; }, [view]);
  const [playing, setPlaying] = useState(false);
  // Плеер сцены (SceneView) поверх просмотра: { album, n } — альбом и номер сцены (у альбомов со сценами-гостями их несколько).
  // Из вкладок «Сцены» и «Диалоги» — ещё title и, если «Смотреть подряд», at: номер строки (конец сцены ведёт к следующей)
  const [scene, setScene] = useState(null);
  // Выбор сцены: { at, list } — у какого кадра открыли и список [{ t, n }]; сменился альбом или кадр — выбор уже не наш
  const [picked, setPicked] = useState(null);
  const pick = picked && view && picked.at === `${view.album}:${view.index}` ? picked.list : null;
  const setPick = (list) => setPicked(list && { at: `${view.album}:${view.index}`, list });
  // Кадр или альбом сменился (стрелки, показ, перемешивание): выбор закрыт насовсем, а не прячется до возврата на тот же кадр
  if (picked && !pick) setPicked(null);
  const watchRef = useRef(null);
  // «Скрыть обложки» касается и этого окна (оно рисуется в body, вне страницы с этим классом)
  const hidden = useCoversHidden();
  const touch = useRef(null);
  // Звук петель, скорость анимаций и секунды показа: выборы общие для всех игр и помнятся (galleryView.js)
  const [sound, setSound] = useState(readSound);
  const toggleSound = () => setSound((on) => { writeSound(!on); return !on; });
  // Свой плеер ролика (заставка, сцена со звуком): пауза, звук и перемотка вместо системных <video controls>
  const [attachVideo, vid] = useVideoControl();
  const [speed, setSpeed] = useState(readSpeed);
  const nextSpeed = () => setSpeed((v) => { const next = SPEEDS[(SPEEDS.indexOf(v) + 1) % SPEEDS.length]; writeSpeed(next); return next; });
  // Показ с таймером — как в «Избранном» (FavoritesGallery)
  const [show, setShow] = useState(false);
  const [seconds, setSeconds] = useState(readStep);
  const pickSeconds = (s) => { setSeconds(s); writeStep(s); };
  const more = useRef(null);
  // Модель Live2D в просмотре: повтор движения, выражение (-1 — без него; у каждой модели свои), не открылась ли
  const [l2dLoop, setL2dLoop] = useState(true);
  const [l2dExp, setL2dExp] = useState({ key: '', i: -1 });
  const [modelFailed, setModelFailed] = useState('');
  // Что выбрал человек: раздел. Пока не выбрал — сам (см. section ниже)
  const [secPick, setSecPick] = useState(null);
  const [fullSrc, setFullSrc] = useState('');     // адрес картинки, которая в просмотре догрузилась целиком
  // Оглавление: строится при первом открытии — спрашиваем, пока не будет готово
  const jumped = useRef(false);
  useEffect(() => {
    let alive = true;
    let timer = null;
    const load = () => fetch(`/api/gallery/${encodeURIComponent(game.id)}`)
      .then((r) => r.json().then((d) => { if (!r.ok) throw httpError(r, d); return d; }))
      .then((d) => {
        if (!alive) return;
        setData(d);
        if (d.state !== 'ready') timer = setTimeout(load, 1000);
        // Пришли из поиска по картинкам (initialFile): оглавление готово — открыть альбом с этим кадром, один раз
        else if (initialFile && !jumped.current) {
          jumped.current = true;
          // Плитки сцен — без своих картинок: в них файл не найти; альбом открываем в «Картинках»
          for (const key of PIC_TABS) {
            const list = tabAlbums(d.albums, key);
            const i = list.findIndex((a) => a.files.includes(initialFile));
            if (i >= 0) { setSecPick('pics'); setTab(key); setPlaying(!!list[i].anim); setView({ album: i, index: list[i].files.indexOf(initialFile) }); break; }
          }
        }
      })
      .catch((e) => { if (alive) setError(errorText(t, e)); });
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [game.id, t, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Звуки игры (вкладка «Звуки»): список отдельным запросом — он не зависит от сборки оглавления картинок
  const [sounds, setSounds] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/gallery/${encodeURIComponent(game.id)}/sounds`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d?.count) setSounds(d); }).catch(() => {});
    return () => { alive = false; };
  }, [game.id]);

  const ready = data?.state === 'ready';
  // Плитки «Сцен» и «Диалогов»: одни и те же для числа на чипе и для сетки
  const sceneTabs = useMemo(() => (ready ? { scenes: sceneRows(data.albums, false), dialogue: sceneRows(data.albums, true) } : { scenes: [], dialogue: [] }), [data, ready]);
  const count = (key) => (!ready ? 0 : SCENE_TABS.includes(key) ? sceneTabs[key].length : tabAlbums(data.albums, key).length);
  // Разделы: пустые скрыты. Пока оглавление строится, показываем «Картинки» (их число ещё неизвестно)
  const picChips = PIC_TABS.filter((k) => count(k) > 0);
  const sceneChips = SCENE_TABS.filter((k) => count(k) > 0);
  const found = [
    (!ready || picChips.length > 0) && { key: 'pics', n: ready ? count('all') : null },
    sceneChips.length > 0 && { key: 'scenes', n: count('scenes') + count('dialogue') },
    sounds && { key: 'sounds', n: sounds.count },
  ].filter(Boolean);
  // Совсем пусто — всё равно «Картинки», чтобы было где сказать «картинок нет»
  const sections = found.length ? found : [{ key: 'pics', n: null }];
  const hasSection = (k) => sections.some((x) => x.key === k);
  // Сам открывается: «Картинки» (если есть CG); иначе «Сцены»; иначе первый непустой
  const auto = !ready || count('cg') > 0 ? 'pics' : hasSection('scenes') ? 'scenes' : sections[0].key;
  const section = secPick && hasSection(secPick) ? secPick : auto;
  const chips = section === 'pics' ? picChips : section === 'scenes' ? sceneChips : NO_ROWS;
  // Чип раздела: выбранный, а нет такого (сменили раздел) — первый непустой; в пустой игре — «Всё» с сообщением
  // Шаблонной строкой — иначе компилятор React принимает её за часть массива чипов и отказывается от оптимизации
  const current = section === 'sounds' ? 'sounds' : `${chips.find((k) => k === tab) || chips.at(0) || 'all'}`;
  const inScenes = section === 'scenes';
  const rows = inScenes ? sceneTabs[current] : NO_ROWS;
  const inSounds = section === 'sounds' && !!sounds;
  // Вперемешку — как в «Избранном»: порядок альбомов перемешан один раз при включении
  const [order, setOrder] = useState(null);
  const albums = useMemo(() => {
    // Файлы игры — в порядке, как прислал сервер (как в игре)
    const base = ready && !inScenes ? tabAlbums(data.albums, current) : [];
    if (!order) return base;
    const rank = new Map(order.map((k, i) => [k, i]));
    return [...base].sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  }, [data, ready, current, inScenes, order]);
  const toggleShuffle = () => {
    setView(null);
    setShow(false);
    setOrder(order ? null : shuffled([...new Set([...(data?.albums || []), ...albums].map((a) => a.key))]));
  };
  // Адрес миниатюры и картинки — из файлов игры
  const src = (what, f) => api(game.id, what, f);
  // Обложки наборов Spine — из хранилища браузера (строки по 20 КБ): заново, когда закрыли просмотр — там могла сняться новая
  const covers = useMemo(() => new Map((inScenes ? rows.map((r) => r.album) : albums).filter(isRig).map((a) => [a.key, readSpineCover(game.id, a.key)])), [albums, rows, inScenes, game.id, view]); // eslint-disable-line react-hooks/exhaustive-deps
  // Снятое только что (фоном) — плитка обновляется сразу, не дожидаясь, пока оглавление узнает об обложке на сервере
  const [fresh, setFresh] = useState(() => new Map());
  // Обложка плитки: этот браузер → сервер (rigCover — её там уже видели) → пусто, тогда её снимет фон (useRigCovers)
  const spineCover = (a) => covers.get(a.key) || fresh.get(`${game.id}/${a.key}`) || (a.rigCover ? rigCoverUrl(game.id, a.key) : undefined);
  // Фоновая съёмка — только для плиток на экране и пока нет просмотра и плеера сцены (у них свой холст WebGL)
  const shownRigs = useMemo(() => {
    const seen = new Set();
    return (inScenes ? rows.slice(0, shown).map((r) => r.album) : albums.slice(0, shown)).filter((a) => isRig(a) && !seen.has(a.key) && seen.add(a.key));
  }, [albums, rows, inScenes, shown]);
  useRigCovers(game.id, ready ? shownRigs.filter((a) => !spineCover(a)) : [], !!view || !!scene, (key, url) => setFresh((m) => new Map(m).set(`${game.id}/${key}`, url)));

  // Избранное этой игры: какие файлы отмечены сердечком
  const [favs, setFavs] = useState(() => new Set());
  useEffect(() => {
    let alive = true;
    fetch(`/api/favorites?game=${encodeURIComponent(game.id)}`).then((r) => (r.ok ? r.json() : []))
      .then((list) => { if (alive) setFavs(new Set((Array.isArray(list) ? list : []).map((x) => x.file))); }, () => {});
    return () => { alive = false; };
  }, [game.id]);
  // anim — покадровая анимация целиком: { frames, fps }
  const toggleFav = async (file, kind, anim) => {
    const on = !favs.has(file);
    const r = await fetch(on ? '/api/favorites' : `/api/favorites?game=${encodeURIComponent(game.id)}&f=${encodeURIComponent(file)}`, on
      ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: game.id, file, kind, ...anim }) }
      : { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) return;
    setFavs((prev) => { const next = new Set(prev); if (on) next.add(file); else next.delete(file); return next; });
  };

  // Прокрутили до конца сетки — показать ещё
  useEffect(() => {
    const el = more.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [albums, shown, rows]);

  // Куда ведёт шаг на dir кадров (через границу альбома — в соседний); null — дальше некуда
  const target = (v, dir) => {
    let { album, index } = v;
    index += dir;
    if (index >= albums[album].files.length) { album += 1; index = 0; }
    if (index < 0) { album -= 1; index = album >= 0 ? albums[album].files.length - 1 : 0; }
    if (album < 0 || album >= albums.length) return null;
    return { album, index };
  };
  const step = (dir) => { setView((v) => (v ? target(v, dir) || v : v)); };

  // Кадры, которые браузер уже загрузил: анимация идёт по ним и ждёт, если следующий ещё не готов (кадр из слоёв сервер
  // склеивает не сразу, а в анимации их бывают сотни — без ожидания она бы мигала пустыми кадрами)
  const loaded = useRef(new Set());
  const asked = useRef(new Set());
  useEffect(() => { loaded.current = new Set(); asked.current = new Set(); }, [game.id]);
  const preload = (f) => {
    const url = src('image', f);
    if (asked.current.has(url)) return;
    asked.current.add(url);
    const img = new Image();
    img.onload = () => loaded.current.add(url);
    // Не загрузился — не ждём его вечно: пропустим, а в следующий раз попросим снова
    img.onerror = () => { loaded.current.add(url); asked.current.delete(url); };
    img.src = url;
  };

  // Перейти к первому кадру соседнего альбома (↑/↓, вертикальный свайп): в альбоме на 90 кадров стрелками
  // по кадрам до следующего не дойти
  // Анимация играет сама, как при открытии из сетки (open)
  const stepAlbum = (dir) => {
    const next = view ? view.album + dir : -1;
    if (next < 0 || next >= albums.length) return;
    setModelFailed(''); // плашка «модель не открылась» относится к прошлому открытию
    setPlaying(!!albums[next].anim);
    setView({ album: next, index: 0 });
  };

  // Анимация: кадры альбома по кругу
  useEffect(() => {
    if (!playing || !view) return undefined;
    const timer = setInterval(() => setView((v) => {
      if (!v) return v;
      const files = albums[v.album].files;
      const next = (v.index + 1) % files.length;
      if (!isVideo(files[next]) && !loaded.current.has(src('image', files[next]))) return v;
      return { ...v, index: next };
    }), 1000 / (fpsOf(albums[view.album]) * speed));
    return () => clearInterval(timer);
  }, [playing, view?.album, albums, speed]); // eslint-disable-line react-hooks/exhaustive-deps

  const album = view ? albums[view.album] : null;
  const file = album ? album.files[view.index] : null;
  // Выражение и ошибка помнят свой альбом: у другой модели выражение прежней не подходит, и ошибка была не о ней
  const expNow = album && l2dExp.key === album.key ? l2dExp.i : -1;
  const withSound = !!file && isVideo(file) && album.kind === 'animation' && hasSound(album.audio, file);
  const loop = !!file && isVideo(file) && album.kind === 'animation';
  // Ролик под своим плеером: не петля, не Live2D и не Spine
  const plain = !!file && isVideo(file) && !loop && !album.live2d && !album.spine;
  // Покадровая анимация — в избранное целиком: первым кадром, со всеми кадрами и темпом; остальное — открытая картинка
  const favFile = album?.anim ? album.files[0] : file;

  // Показ: картинка — seconds секунд, потом следующая; анимация из кадров идёт сама столько же, потом следующий альбом;
  // ролик со звуком — до конца (onEnded). За последним альбомом — снова первый
  const advance = () => {
    if (!view) return;
    const a = albums[view.album];
    if (!(a.anim || playing) && view.index + 1 < a.files.length) { setView({ ...view, index: view.index + 1 }); return; }
    const next = (view.album + 1) % albums.length;
    setModelFailed(''); // плашка «модель не открылась» относится к прошлому открытию
    setPlaying(!!albums[next].anim);
    setView({ album: next, index: 0 });
  };
  // Кадры анимации сменяются сами — таймер показа от них не начинается заново
  const showAt = !view ? '' : album.anim || playing ? `${view.album}` : `${view.album}/${view.index}`;
  useEffect(() => {
    if (!show || !file || (isVideo(file) && !loop)) return undefined;
    const timer = setTimeout(advance, seconds * 1000);
    return () => clearTimeout(timer);
  }, [show, showAt, seconds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Стрелки и пробел — по открытой картинке. Escape закрывает сначала картинку, потом галерею:
  // это делает стопка слоёв (layers.js), слои — ниже
  useEffect(() => {
    const onKey = (e) => {
      // Плеер сцены поверх: стрелки и пробел — его
      if (scene || pick) return;
      // Выбор Live2D (BarChoose и его список) разбирает клавиши сам: ←/→ и пробел не листают альбом
      if (e.target instanceof Element && e.target.closest('.bar-choose, .scene-pick')) return;
      // Полоса перемотки ролика разбирает ←/→ и пробел сама (у петли полосы нет — листаем)
      if (e.target instanceof Element && e.target.closest('.vseek')) return;
      if (view && e.key === 'ArrowRight') { setPlaying(false); step(1); }
      else if (view && e.key === 'ArrowLeft') { setPlaying(false); step(-1); }
      else if (view && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); stepAlbum(e.key === 'ArrowDown' ? 1 : -1); }
      // Пробел у ролика — пауза его плеера, у картинок — проиграть кадры
      else if (view && e.key === ' ' && plain) { e.preventDefault(); vid.toggle(); }
      else if (view && e.key === ' ' && !isVideo(file) && !isRig(album)) { e.preventDefault(); setPlaying((p) => !p); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Следующие картинки — заранее; для анимации — следующие кадры по кругу (не весь альбом разом: в нём бывают сотни)
  useEffect(() => {
    if (!album) return;
    const next = playing
      ? Array.from({ length: Math.min(album.files.length, PRELOAD) }, (_, k) => album.files[(view.index + k) % album.files.length])
      : [album.files[view.index + 1], album.files[view.index + 2], albums[view.album + 1]?.files[0]].filter(Boolean);
    next.filter((f) => !isVideo(f) && !/\.json#/.test(f)).forEach(preload);
  }, [album, view, playing, albums, game.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Раскадровка анимации из событий играет сама, как GIF
  const open = (i) => { setModelFailed(''); setShow(false); setPlaying(!!albums[i]?.anim); setView({ album: i, index: 0 }); };
  const close = () => { setPlaying(false); setShow(false); setPicked(null); setView(null); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); };
  // «Смотреть сцену»: у альбома со сценами-гостями — те, где играют ролик, который сейчас на экране (нет таких — все); одна —
  // сразу, несколько — выбор над кнопкой. Нажать ещё раз — убрать выбор
  const watch = (a) => {
    if (pick) { setPick(null); return; }
    const all = (a.scenes || [{ t: '', f: [] }]).map((s, n) => ({ ...s, n }));
    const mine = all.filter((s) => s.f.includes(view.index));
    const list = mine.length ? mine : all;
    if (list.length > 1) { setPick(list); return; }
    startScene(a, list[0].n);
  };
  const startScene = (a, n) => {
    setPick(null);
    setPlaying(false);
    setShow(false);
    document.querySelectorAll('.gallery-view video').forEach((v) => v.pause());
    setScene({ album: a, n });
  };
  // Строка списка (SceneList) → плеер сразу; chain — идти дальше по списку, когда сцена кончилась
  // «Авто» в цепочке переходит на следующие сцены (плеер на каждой сцене новый), вне цепочки начинается с нуля
  const [chainAuto, setChainAuto] = useState(false);
  const playRow = (i, chain) => { const r = rows[i]; if (r) { if (!(chain && scene?.chain)) setChainAuto(false); setScene({ album: r.album, n: r.n, title: r.title, at: i, chain }); } };
  const playRandom = () => playRow(Math.floor(Math.random() * rows.length), false);
  const nextRow = scene?.chain && scene.at + 1 < rows.length ? () => playRow(scene.at + 1, true) : null;
  const rootRef = useRef(null);
  const viewRef = useRef(null);
  // Картинка, которую надо показать: у ролика, Spine и Live2D её нет — они листаются как раньше. На экране она появляется
  // после img.decode() (shown), а на телефоне идёт за пальцем (swipe, galleryView.js)
  const wantSrc = file && !isVideo(file) && !isRig(album) ? src('image', file) : '';
  // Для свайпа: соседний кадр — null, если дальше некуда; '' — если там не картинка
  const neighbor = (dir) => {
    const to = view && target(view, dir);
    if (!to) return null;
    const a = albums[to.album];
    const f = a.files[to.index];
    return isVideo(f) || isRig(a) ? '' : src('image', f);
  };
  const { shown: imgSrc, swipe, took } = useGalleryImage(wantSrc, viewRef, {
    instant: !!album && (playing || !!album.anim), // кадры анимации сменяются как в GIF, без наплыва
    neighbor,
    go: (dir) => { setPlaying(false); step(dir); },
    blocked: () => zoom.blocks(),
  });
  // Увеличение картинки; у играющей анимации — одно на все кадры
  const zoom = useZoom(imgSrc ? (playing ? `${view.album}` : imgSrc) : '', viewRef);
  // На весь экран — как в «Избранном» (FavoritesGallery)
  const fullscreen = () => {
    const el = viewRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };
  useLayer(rootRef, onClose);
  useLayer(viewRef, close, { active: !!file, focus: 'self' });

  // Чипы раздела: один непустой — ряда нет, выбирать не из чего
  const chipRow = chips.length > 1 && chips.map((k) => (
    <button key={k} type="button" role="tab" aria-selected={current === k} className={`chip${current === k ? ' active' : ''}`} onClick={() => { setTab(k); setShown(PAGE); }}>
      {t.gallery_tabs[k]} {count(k)}
    </button>
  ));
  // Кнопки раздела — справа от чипов, на одном месте; на телефоне — значками (подпись остаётся для чтения с экрана)
  const tools = inScenes && rows.length > 0 ? (
    <>
      <button type="button" className="gallery-play" onClick={() => playRow(0, true)} aria-label={t.scene_list.all}><IconPlay /><span className="tool-label">{t.scene_list.all}</span></button>
      <button type="button" className="gallery-play" onClick={playRandom} aria-label={t.scene_list.random}><IconShuffle /><span className="tool-label">{t.scene_list.random}</span></button>
    </>
  ) : albums.length > 0 ? (
    <>
      <button type="button" className="gallery-play" onClick={() => { open(0); setShow(true); }} aria-label={t.favs_show}><IconPlay /><span className="tool-label">{t.favs_show}</span></button>
      <button type="button" className="gallery-play" aria-pressed={!!order} onClick={toggleShuffle} aria-label={t.favs_shuffle}><IconShuffle /><span className="tool-label">{t.favs_shuffle}</span></button>
    </>
  ) : null;
  // Подсказка — одна строка: что делает нажатие и где то же самое в другом виде; вторая половина — только на компьютере
  const h = t.gallery_hint;
  const sh = t.scene_list.hint;
  const legend = [['v', IconSound, t.scene_list.voice], ['c', IconFork, t.scene_list.choice], ['m', IconFilm, t.scene_list.video], ['a', IconLoop, t.scene_list.anim]]
    .filter(([k]) => rows.some((r) => r.sum?.[k]));
  const hintBody = !ready || inSounds ? null : inScenes ? (
    <p className="gallery-hint" id={help.id}>
      {sh[current]}
      <span className="hint-more"> {sh[`${current}_more`]}
        {current === 'scenes' && legend.map(([k, Ic, label]) => <span key={k}> <span className="hint-ic"><Ic /> {label}</span></span>)}
      </span>
    </p>
  ) : (
    <p className="gallery-hint" id={help.id}>
      {h.pics}
      {albums.some((a) => a.script) && <> <span className="hint-ic"><IconTalk /></span> {h.mark}</>}
      <span className="hint-more"> {albums.some((a) => a.script) && `${h.pics_more} `}{h.keys}</span>
    </p>
  );

  return createPortal(
    // Окно нарисовано в body, но события React идут по дереву компонентов — до фона окна игры, а
    // нажатие по фону его закрывает. Поэтому дальше галереи нажатия не пускаем
    <div ref={rootRef} className={`gallery${hidden ? ' covers-hidden' : ''}`} role="dialog" aria-modal="true" aria-label={t.gallery_title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      <div className="gallery-head">
        <h2>{t.gallery_title}<span className="gallery-game">{game.displayTitle || game.title}</span></h2>
        <button type="button" className="gallery-close" onClick={onClose} aria-label={t.close} data-tip={t.close}><IconClose /></button>
        <div className="gallery-sources" role="tablist" aria-label={t.gallery_title}>
          {sections.map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={section === x.key} className={`gallery-source${section === x.key ? ' active' : ''}`}
              onClick={() => { setSecPick(x.key); setTab(null); setView(null); setPlaying(false); setShown(PAGE); }}>
              {t.gallery_sections[x.key]}{x.n ? <span className="gallery-source-count"> {x.n}</span> : null}
            </button>
          ))}
        </div>
        {(chipRow || tools || hintBody) && (
          <div className="gallery-lv2">
            {chipRow && <div className="gallery-tabs" role="tablist">{chipRow}</div>}
            {(tools || hintBody) && <div className="gallery-tools">{tools}{hintBody && <HelpMark help={help} t={t} />}</div>}
          </div>
        )}
        {help.open && hintBody}
      </div>

      {error && <StateView kind="error" title={error} onRetry={() => { setError(''); setReload((n) => n + 1); }} retryLabel={t.retry} />}
      {!error && data?.state === 'building' && (
        // Мимик 64 по центру; когда счёт известен, клетки горят снизу по доле «N из M» (глаза моргают в том же ритме)
        <div className="gallery-wait">
          <MimicLoader size={64} col frac={data.total ? data.done / data.total : undefined}>
            <p className="gallery-note">{t.gallery_building(data.done, data.total)}</p>
          </MimicLoader>
        </div>
      )}
      {ready && !inSounds && !inScenes && albums.length === 0 && <StateView title={t.gallery_empty} />}

      {inScenes && ready && <SceneList rows={rows.slice(0, shown)} t={t} src={src} spineCover={spineCover} onOpen={(i) => playRow(i, false)} />}
      {ready && !inSounds && !inScenes && (
        <div className="gallery-grid">
          {albums.slice(0, shown).map((a, i) => (
            <button key={a.key} type="button" className={`gallery-tile ${a.kind}`} onClick={() => open(i)}>
              {/* Миниатюру сервер делает по запросу и может не успеть сразу — ещё попытки (RetryImg) */}
              {/* У набора Spine и модели Live2D — кадр с первого просмотра (galleryView.js), пока его нет — пустая плитка с названием */}
              {isRig(a) ? (spineCover(a) ? <img src={spineCover(a)} alt="" className="loaded" /> : <span className="gallery-tile-empty" aria-hidden="true" />)
                : <RetryImg src={src('thumb', a.cover || a.files[0])} alt="" loading="lazy" fallback={<span className="gallery-tile-empty" aria-hidden="true" />} />}
              {/* Имя сцены — если оно человеческое («Cam x Alice Bath», папка сцены), а не «eva_c132» */}
              {/* Альбом события и сцена — с названием из игры (реплика, имя события); у альбома по имени файла — только человеческое */}
              {/* «Без сцены» — картинки, которым не нашлось сцены: одним альбомом в конце */}
              {(a.loose || /^(scenes|events)\//.test(a.key) || isRig(a) || /\s/.test(sceneName(a.key))) && <span className="gallery-name">{a.loose ? t.gallery_loose : a.live2d?.name || sceneName(a.key)}</span>}
              {a.files.length > 1 && <span className="gallery-count">{(isRig(a) ? t.gallery_moves : isVideo(a.files[0]) ? t.gallery_clips : t.gallery_frames)(a.files.length)}</span>}
              {a.files.some((f) => favs.has(f)) && <span className="gallery-fav-badge" aria-label={t.favs_in}><IconHeart /></span>}
              {/* Значки внизу слева: ролик (плёнка), анимация, облачко — у альбома есть сцена с репликами */}
              {(a.kind === 'video' || a.kind === 'animation' || a.anim || a.script) && (
                <span className="tile-badges">
                  {(a.kind === 'video' || a.kind === 'animation' || a.anim) && <span className={`gallery-badge ${a.anim ? 'animation' : a.kind}`} aria-label={t.gallery_tabs[a.anim ? 'animation' : a.kind]} data-tip={t.gallery_tabs[a.anim ? 'animation' : a.kind]}>{a.kind === 'video' ? <IconFilm /> : <IconLoop />}</span>}
                  {a.script && <span className="gallery-badge gallery-scene-mark" aria-label={t.scene_list.has} data-tip={t.scene_list.has}><IconTalk /></span>}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {scene && <SceneView key={`${scene.album.key}\n${scene.n}`} game={game} t={t} album={scene.album} n={scene.n} title={scene.title} speed={speed} hidden={hidden} auto0={scene.chain && chainAuto} onAuto={scene.chain ? setChainAuto : null} onNext={nextRow} onClose={() => setScene(null)} />}
      {sounds && <SoundRoom game={game} t={t} sounds={sounds} active={!!inSounds} hidden={hidden} />}
      {(inScenes ? rows : albums).length > shown && <div ref={more} className="gallery-more-sentinel" />}

      {file && (
        <div
          ref={viewRef}
          className={`gallery-view${plain ? ' has-vseek' : ''}`}
          tabIndex={-1}
          onClick={close}
          {...swipe}
          onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
          onTouchEnd={(e) => {
            // Картинку по горизонтали уже листал свайп за пальцем (useGalleryImage): второй раз не листаем, а нажатие после него отменяем
            if (took()) { e.preventDefault(); return; }
            // Палец на плеере — это перемотка ролика, а не листание (у петли плеера нет — листаем). Увеличенную картинку
            // палец двигает, а не листает
            if (e.target.closest?.('.vseek') || zoom.blocks()) return;
            const from = touch.current || { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
            const dx = e.changedTouches[0].clientX - from.x;
            const dy = e.changedTouches[0].clientY - from.y;
            // Больше вбок — кадр, больше вверх-вниз — альбом (вверх — следующий, как в ленте)
            if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) { e.preventDefault(); stepAlbum(dy < 0 ? 1 : -1); }
            else if (Math.abs(dx) > 40) { e.preventDefault(); setPlaying(false); step(dx < 0 ? 1 : -1); }
          }}
        >
          {album.live2d ? (
            // Модель играет на canvas, как скелет Spine ниже: касание листает к следующему движению, плеер сцены холст не делит
            !scene && <Suspense fallback={null}><Live2DView key={album.key} game={game} album={album} file={file} speed={speed} hidden={hidden} loop={l2dLoop} exp={expNow} onFail={() => setModelFailed(album.key)} onClick={(e) => { e.stopPropagation(); step(1); }} /></Suspense>
          ) : album.spine ? (
            // Скелет играет на canvas; касание листает к следующей анимации, как у картинки. Пока открыт плеер сцены, у которого
            // свой холст, этот убираем: контекстов WebGL в браузере считаные штуки
            !scene && <Suspense fallback={null}><SpineView key={album.key} game={game} album={album} file={file} speed={speed} hidden={hidden} onClick={(e) => { e.stopPropagation(); step(1); }} /></Suspense>
          ) : isVideo(file) ? (
            // key — новый плеер на каждый ролик: иначе браузер доигрывал бы прежний
            album.kind === 'animation'
              // Ролик-петля — как GIF: по кругу, без кнопок. Звук (если он есть) — только по кнопке в панели; скрытие (H) глушит
              // Со звуком браузер (Safari) может не дать запуститься без касания — тогда без звука, а не стоп-кадр
              // Скорость — и по умолчанию: загрузка ролика сбрасывает playbackRate на defaultPlaybackRate
              ? <video key={file} ref={(v) => { if (v) { v.defaultPlaybackRate = speed; v.playbackRate = speed; } }} src={api(game.id, 'video', file)} autoPlay loop muted={!(sound && withSound) || hidden} playsInline onClick={(e) => { e.stopPropagation(); setPlaying(false); step(1); }}
                onCanPlay={(e) => { const v = e.currentTarget; if (v.paused && !v.muted) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }} />
              // Заставка или сцена со звуком — плеером, один раз
              : <video key={file} ref={attachVideo} src={api(game.id, 'video', file)} autoPlay playsInline onClick={(e) => { e.stopPropagation(); vid.toggle(); }} onEnded={() => { if (show) advance(); }} />
          ) : (
            <img
              key={imgSrc} src={imgSrc} alt="" {...zoom.props}
              // Пока обложка альбома грузится целиком, под ней уже лежит миниатюра плитки (она в кэше: сетка её показала).
              // Снимаем по загрузке: у прозрачной картинки миниатюра иначе просвечивала бы сквозь неё
              style={view.index === 0 && !playing && (album.cover || album.files[0]) === file && imgSrc === wantSrc && fullSrc !== imgSrc
                ? { ...zoom.props.style, backgroundImage: `url("${src('thumb', file)}")`, backgroundPosition: 'center', backgroundSize: 'contain', backgroundRepeat: 'no-repeat' }
                : zoom.props.style}
              onLoad={() => setFullSrc(imgSrc)}
              onClick={(e) => { e.stopPropagation(); if (zoom.blocks()) return; setPlaying(false); step(1); }}
            />
          )}
          {modelFailed === album.key && <p className="gallery-view-note" onClick={(e) => e.stopPropagation()}>{t.gallery_l2d_error}</p>}
          <button type="button" className="lightbox-nav prev" aria-label={t.shelf_prev} onClick={(e) => { e.stopPropagation(); setPlaying(false); step(-1); }}><IconChevronLeft /></button>
          <button type="button" className="lightbox-nav next" aria-label={t.shelf_next} onClick={(e) => { e.stopPropagation(); setPlaying(false); step(1); }}><IconChevronRight /></button>
          {pick && <ScenePick t={t} list={pick} anchor={watchRef} onPick={(n) => startScene(album, n)} onClose={() => setPick(null)} />}
          <div className="gallery-bar" onClick={(e) => e.stopPropagation()}>
            {plain && <VideoSeek el={vid.el} onSeek={vid.seek} onToggle={vid.toggle} label={t.gallery_sounds.seek} />}
            {plain && (
              <>
                <button type="button" className="gallery-play bar-vctl" onClick={vid.toggle} aria-label={vid.paused ? t.gallery_play : t.gallery_pause} data-tip={vid.paused ? t.gallery_play : t.gallery_pause}>
                  {vid.paused ? <IconPlay /> : <IconPause />}
                </button>
                <button type="button" className="gallery-play bar-vctl" aria-pressed={!vid.muted} onClick={vid.toggleMute} aria-label={vid.muted ? t.gallery_sound_on : t.gallery_sound_off} data-tip={vid.muted ? t.gallery_sound_on : t.gallery_sound_off}>
                  {vid.muted ? <IconMute /> : <IconSound />}
                </button>
              </>
            )}
            <span className="gallery-where">
              {(album.loose || album.live2d || /^(scenes|events)\//.test(album.key)) && <span className="gallery-where-name">{album.loose ? t.gallery_loose : album.live2d?.name || sceneName(album.key)}</span>}
              <span className="gallery-where-pos">{(isRig(album) ? t.gallery_moves_position : t.gallery_position)(view.album + 1, albums.length, view.index + 1, album.files.length)}</span>
            </span>
            {/* Анимацию из двух кадров тоже можно остановить */}
            {album.files.length >= (album.anim ? 2 : 3) && !isVideo(file) && !isRig(album) && (
              <button type="button" className="gallery-play" onClick={() => setPlaying((p) => !p)}>
                {playing ? <><IconPause /> {t.gallery_pause}</> : <><IconPlay /> {t.gallery_play}</>}
              </button>
            )}
            {album.script && <button ref={watchRef} type="button" className="gallery-play" aria-haspopup={album.scenes ? 'dialog' : undefined} aria-expanded={album.scenes ? !!pick : undefined} aria-pressed={pick ? true : undefined} onClick={() => watch(album)}><IconPlay /> {t.scene.watch}</button>}
            <button type="button" className="gallery-play" aria-pressed={show} onClick={() => setShow((on) => !on)} data-tip={show ? t.favs_pause : t.favs_show}>
              {show ? <IconPause /> : <IconPlay />} {t.favs_show}
            </button>
            {show && STEPS.map((s) => (
              <button key={s} type="button" className={`gallery-play fav-step${seconds === s ? ' on' : ''}`} aria-pressed={seconds === s} onClick={() => pickSeconds(s)} data-tip={t.favs_step_hint}>{t.favs_step(s)}</button>
            ))}
            {album.live2d && (
              <>
                {album.live2d.motions.length > 1 && (
                  <BarChoose label={t.gallery_l2d_motion} value={view.index} options={album.live2d.motions.map((m, i) => ({ value: i, label: m[0], group: m[1], cell: motionCell(m[0]) }))}
                    grid={{ of: t.gallery_l2d_of, none: t.gallery_l2d_none, search: wordMotions(album.live2d.motions) ? t.gallery_l2d_search : null }}
                    onChange={(i) => { setPlaying(false); setView({ ...view, index: i }); }} />
                )}
                {album.live2d.exps.length > 0 && (
                  <BarChoose label={t.gallery_l2d_expression} value={expNow}
                    options={[{ value: -1, label: t.gallery_l2d_expression_none }, ...album.live2d.exps.map((x, i) => ({ value: i, label: x }))]}
                    onChange={(i) => setL2dExp({ key: album.key, i })} />
                )}
                <button type="button" className="gallery-play" aria-pressed={l2dLoop} onClick={() => setL2dLoop((on) => !on)}>{t.gallery_l2d_loop}</button>
              </>
            )}
            {(album.anim || playing || loop || isRig(album)) && (
              <button type="button" className="gallery-play" onClick={nextSpeed} aria-label={t.gallery_speed(speed)} data-tip={t.gallery_speed(speed)}>{t.gallery_speed_value(speed)}</button>
            )}
            {/* Склейка «@cg/…» — тоже в избранное: её адрес — по составу слоёв, после пересборки тот же */}
            {!isRig(album) && <button
              type="button" className={`gallery-play gallery-fav${favs.has(favFile) ? ' on' : ''}`} aria-pressed={favs.has(favFile)}
              onClick={(e) => { if (!favs.has(favFile)) flash([e.currentTarget]); return album.anim ? toggleFav(favFile, 'animation', { frames: album.files, fps: fpsOf(album) }) : toggleFav(file, album.kind); }}
              aria-label={favs.has(favFile) ? t.favs_remove : album.anim ? t.favs_add_anim : t.favs_add} data-tip={favs.has(favFile) ? t.favs_remove : album.anim ? t.favs_add_anim : t.favs_add}
            >
              {favs.has(favFile) ? <IconHeart /> : <IconHeartLine />}
            </button>}
            {withSound && <button type="button" className="gallery-play" aria-pressed={sound} onClick={toggleSound} aria-label={sound ? t.gallery_sound_off : t.gallery_sound_on} data-tip={sound ? t.gallery_sound_off : t.gallery_sound_on}>
              {sound ? <IconSound /> : <IconMute />}
            </button>}
            <button type="button" className="gallery-play" onClick={fullscreen} aria-label={t.favs_fullscreen} data-tip={t.favs_fullscreen}><IconExpand /></button>
            <button type="button" className="gallery-play" onClick={close} aria-label={t.gallery_back} data-tip={t.gallery_back}><IconClose /></button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};

export default GameGallery;
