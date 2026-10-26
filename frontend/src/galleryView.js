import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pageZoom } from './pageZoom';

// Общее у просмотра галереи игры (GameGallery) и «Избранного» (FavoritesGallery). Выборы человека — одни на все игры
// и помнятся между заходами; без хранилища (приватное окно) — как по умолчанию
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, String(value)); } catch { /* без хранилища */ } };

// Звук роликов-петель. По умолчанию выключен — петли крутятся по кругу, и со звуком они мешали бы, пока человек сам не захочет
export const readSound = () => read('rpg_gallery_sound') === '1';
export const writeSound = (on) => write('rpg_gallery_sound', on ? '1' : '0');
// Плеер сцены (SceneView): звук — смысл самой сцены, поэтому пока человек не выбрал, он включён; выбор — тот же, что у петель
export const readSceneSound = () => read('rpg_gallery_sound') !== '0';
// Язык реплик сцены — свой на каждую игру: у одной есть перевод на китайский, у другой на русский. 'orig' — оригинал
export const readSceneLang = (gameId) => read(`rpg_scene_lang:${gameId}`);
export const writeSceneLang = (gameId, code) => write(`rpg_scene_lang:${gameId}`, code);
// Есть ли у ролика звук — по метке сервера: у альбома (audio: true) или списком файлов со звуком
export const hasSound = (audio, file) => (Array.isArray(audio) ? audio.includes(file) : !!audio);

// Темп «Авто» в плеере сцены: во сколько раз время на чтение реплики длиннее обычного (2 — очень медленно, 0.45 — очень
// быстро). Один на все игры, как скорость анимаций
export const AUTO_PACES = [2, 1.5, 1, 0.7, 0.45];
export const readAutoPace = () => { const v = Number(read('rpg_scene_auto_pace')); return AUTO_PACES.includes(v) ? v : 1; };
export const writeAutoPace = (v) => write('rpg_scene_auto_pace', v);

// Скорость анимаций (кадры, петли): кнопка перебирает по кругу
export const SPEEDS = [1, 2, 0.5];
export const readSpeed = () => { const v = Number(read('rpg_gallery_speed')); return SPEEDS.includes(v) ? v : 1; };
export const writeSpeed = (v) => write('rpg_gallery_speed', v);

// Сколько секунд показывать картинку в показе
export const STEPS = [3, 5, 10, 20];
export const readStep = () => { const v = Number(read('rpg_fav_step')); return STEPS.includes(v) ? v : 5; };
export const writeStep = (v) => write('rpg_fav_step', v);

// Обложка плитки набора Spine — кадр, снятый при первом просмотре (SpineView): сервер Spine не рисует, а страница атласа —
// россыпь частей тела. Живёт в этом браузере: в другом плитка пустая, пока набор там не откроют
const coverKey = (game, key) => `rpg_spine_cover:${game}/${key}`;
export const readSpineCover = (game, key) => read(coverKey(game, key));
export const writeSpineCover = (game, key, url) => write(coverKey(game, key), url);

// Вперемешку: порядок перемешивается один раз при включении, чтобы «назад» вело к тому, что уже было
export const shuffled = (keys) => {
  const out = [...keys];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

const MAX_ZOOM = 5;
const WHOLE = { s: 1, x: 0, y: 0 };
// Сдвиг — в пределах картинки: её край не уезжает внутрь экрана
const fit = (s, x, y, w, h) => (s <= 1 ? WHOLE : { s, x: Math.min(0, Math.max(w * (1 - s), x)), y: Math.min(0, Math.max(h * (1 - s), y)) });

// Увеличение картинки в просмотре: колесо мыши, «+» и «−» («0» — снова целиком), на телефоне — двумя пальцами; увеличенную
// двигают мышью или пальцем. Другая картинка (key) — снова целиком. Пока увеличено или жест двигал картинку, нажатие и
// свайп не листают (blocks). Сдвиг — в точках вёрстки, мышь и касания — в точках экрана (pageZoom)
export function useZoom(key, viewRef) {
  const [state, setState] = useState({ key, ...WHOLE });
  // Другая картинка — целиком; вернулись к прежней — тоже целиком, а не как её оставили
  if (state.key !== key) setState({ key, ...WHOLE });
  const z = state.key === key ? state : { key, ...WHOLE };
  const img = useRef(null);
  const pointers = useRef(new Map());
  // Картинка, которую жест двигал или увеличивал: её отпускание — не «нажатие»; у следующей картинки — снова нажатие
  const used = useRef(null);

  // Точка экрана — в точках вёрстки относительно картинки без увеличения
  const box = (cx, cy) => {
    const el = img.current;
    if (!el?.offsetParent) return null;
    const k = pageZoom();
    const r = el.offsetParent.getBoundingClientRect();
    return { x: (cx - r.left) / k - el.offsetLeft, y: (cy - r.top) / k - el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  };
  const zoomAt = (cx, cy, factor) => setState((prev) => {
    const cur = prev.key === key ? prev : { key, ...WHOLE };
    const b = box(cx, cy);
    if (!b) return cur;
    const s = Math.min(MAX_ZOOM, Math.max(1, cur.s * factor));
    // Точка под мышью (между пальцами) остаётся на месте
    return { key, ...fit(s, b.x - (b.x - cur.x) * (s / cur.s), b.y - (b.y - cur.y) * (s / cur.s), b.w, b.h) };
  });
  const middle = () => { const r = img.current?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : [0, 0]; };

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !key) return undefined;
    const onWheel = (e) => {
      if (e.target !== img.current) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.25 : 0.8);
    };
    const onKey = (e) => {
      if (!img.current || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') zoomAt(...middle(), 1.25);
      else if (e.key === '-') zoomAt(...middle(), 0.8);
      else if (e.key === '0') setState({ key, ...WHOLE });
    };
    view.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKey);
    return () => { view.removeEventListener('wheel', onWheel); document.removeEventListener('keydown', onKey); };
  });

  const end = (e) => { pointers.current.delete(e.pointerId); };
  return {
    blocks: () => z.s > 1 || used.current === key,
    props: {
      ref: img,
      // Иначе мышь тащит саму картинку (перетаскивание файла), и движения до сдвига не доходят
      draggable: false,
      style: z.s > 1 ? { transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})`, transformOrigin: '0 0', cursor: 'grab' } : undefined,
      onPointerDown: (e) => {
        if (!pointers.current.size) used.current = null;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (z.s > 1 || pointers.current.size > 1) e.currentTarget.setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e) => {
        const p = pointers.current.get(e.pointerId);
        if (!p) return;
        // Кнопку отпустили за краем картинки — отпускания она не видела: мышь без кнопки больше не тащит
        if (e.pointerType === 'mouse' && !e.buttons) { pointers.current.delete(e.pointerId); return; }
        if (pointers.current.size === 2) {
          const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)[1];
          const before = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 0) zoomAt((e.clientX + other.x) / 2, (e.clientY + other.y) / 2, Math.hypot(e.clientX - other.x, e.clientY - other.y) / before);
          used.current = key;
        } else if (z.s > 1 && (e.clientX !== p.x || e.clientY !== p.y)) {
          const k = pageZoom();
          setState((prev) => {
            const cur = prev.key === key ? prev : { key, ...WHOLE };
            const el = img.current;
            return el ? { key, ...fit(cur.s, cur.x + (e.clientX - p.x) / k, cur.y + (e.clientY - p.y) / k, el.offsetWidth, el.offsetHeight) } : cur;
          });
          used.current = key;
        }
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      },
      onPointerUp: end,
      onPointerCancel: end,
    },
  };
}

// Смена кадра в просмотре (GameGallery и «Избранное»): наплыв 140 мс, а на телефоне — картинка идёт за пальцем.
// Двигаем только transform и opacity; «Уменьшить движение» — смена сразу, за пальцем идёт, но не доезжает
const FADE_MS = 140;
const GAP = 16;                          // зазор между картинками в ленте свайпа, точек вёрстки
const EASE = 'cubic-bezier(.2, 0, 0, 1)';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const imgOf = (viewRef) => viewRef.current?.querySelector(':scope > img:not(.gallery-layer)') || null;

// Копия кадра рядом с настоящим: тот же ящик, что у img (в точках вёрстки — getBoundingClientRect даёт точки экрана).
// Картинка уже в кэше браузера, поэтому появляется сразу. Кладём перед img: прежний кадр лежит под новым
function layerOf(view, img, src) {
  const k = pageZoom();
  const r = img.getBoundingClientRect();
  const v = view.getBoundingClientRect();
  const el = document.createElement('img');
  el.className = 'gallery-layer';
  el.alt = '';
  el.draggable = false;
  Object.assign(el.style, { left: `${(r.left - v.left) / k}px`, top: `${(r.top - v.top) / k}px`, width: `${r.width / k}px`, height: `${r.height / k}px` });
  el.src = src;
  img.before(el);
  return el;
}
// Снять слой наплыва (fx) или ленты свайпа (strip): остановить движение и убрать копии
function drop(st, name) {
  const x = st[name];
  if (!x) return;
  st[name] = null;
  x.anims.forEach((a) => a.cancel());
  x.layers.forEach((l) => l.remove());
  if (x.img) x.img.style.transform = '';
}

// want — адрес картинки, которую надо показать ('' — картинки нет: ролик, Spine, Live2D, ничего не открыто). Возвращает
// { shown, swipe }: shown — адрес, который лежит на экране (новая картинка занимает место только после img.decode(), старая
// остаётся, пока та не готова); swipe — props для окна просмотра. instant — без наплыва и ожидания (кадры анимации).
// neighbor(dir) — для свайпа: null — туда листать нельзя, '' — можно, но там не картинка, иначе адрес соседней;
// go(dir) — перелистнуть; blocked() — жест сейчас не листает (картинка увеличена)
export function useGalleryImage(want, viewRef, { instant = false, neighbor, go, blocked } = {}) {
  const [shown, setShown] = useState(want);
  // Изменяемое состояние жестов и слоёв: живёт между отрисовками, на отрисовку не влияет (читаем его только в обработчиках и эффектах)
  const ref = useRef(null);
  if (ref.current === null) ref.current = { seq: 0, last: -1e9, fx: null, strip: null, swap: null, cut: false, drag: null, took: false, settle: 0 };
  // Не с чего плыть (первый показ, ролик, Spine) или кадры анимации — сразу
  const direct = !want || !shown || instant;
  if (direct && shown !== want) setShown(want);

  useEffect(() => {
    const st = ref.current;
    const my = ++st.seq;
    const now = performance.now();
    // Шаги чаще раза в 140 мс (держат клавишу) меняют кадр без наплыва; свайп уже проехал — наплыв не нужен
    const quick = now - st.last < FADE_MS || st.cut;
    // Отсчёт — от прошлого шага между картинками: открытие просмотра шагом не считается
    const stepping = !direct && want !== shown;
    if (stepping) st.last = now;
    st.cut = false;
    // Новое нажатие сразу доводит прежний наплыв до конца: слоёв не больше двух
    drop(st, 'fx');
    if (!stepping) return;
    const probe = new Image();
    probe.src = want;
    (probe.decode ? probe.decode() : Promise.resolve()).catch(() => { /* не открылась — покажем как есть, ошибку увидит сам img */ }).then(() => {
      // Пока ждали, нажали ещё: этот кадр уже не нужен
      if (my !== st.seq) return;
      const el = imgOf(viewRef);
      st.swap = { from: shown, to: want, quick, was: el?.naturalHeight ? el.naturalWidth / el.naturalHeight : 0, now: probe.naturalHeight ? probe.naturalWidth / probe.naturalHeight : 0 };
      setShown(want);
    });
  }, [want, instant]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const st = ref.current;
    // Новый кадр на месте: копии свайпа (соседа, под ним лежал новый) больше не нужны
    drop(st, 'strip');
    const sw = st.swap;
    st.swap = null;
    const view = viewRef.current;
    const el = imgOf(viewRef);
    if (!sw || sw.to !== shown || !view || !el || sw.quick || reducedMotion()) return;
    const old = layerOf(view, el, sw.from);
    const anims = [el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'linear' })];
    // Другая пропорция: края старого кадра не прикрыты новым — гасим и его, иначе они пропадут за один кадр
    if (sw.was && sw.now && Math.abs(sw.was - sw.now) > 0.01) anims.push(old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'linear', fill: 'forwards' }));
    st.fx = { anims, layers: [old] };
    const mine = st.fx;
    Promise.all(anims.map((a) => a.finished)).then(() => { if (st.fx === mine) drop(st, 'fx'); }, () => { /* оборвали новым нажатием */ });
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { drop(ref.current, 'fx'); drop(ref.current, 'strip'); }, []);

  const edge = (dx) => (neighbor && neighbor(dx > 0 ? -1 : 1) === null ? dx / 3 : dx);   // у края списка палец тянет втрое слабее
  const slide = (x) => { const s = ref.current.strip; if (s) { s.img.style.transform = `translateX(${x}px)`; s.layers.forEach((l) => { l.style.transform = `translateX(${x + l.off}px)`; }); } };

  // Отпустили: доезд к соседу или возврат. v — скорость пальца, точек вёрстки в мс
  const release = (x0, dx, v) => {
    const st = ref.current;
    const s = st.strip;
    if (!s) return;
    let dir = 0;
    if (dx < -s.step / 4 || v < -0.4) dir = 1;
    if (dx > s.step / 4 || v > 0.4) dir = -1;
    if (dir && neighbor?.(dir) === null) dir = 0;
    const x1 = -dir * s.step;
    const rem = Math.abs(x1 - x0);
    const vt = v * Math.sign(x1 - x0);      // > 0 — палец шёл туда же, куда едет картинка
    let ms = dir ? 220 : 180;
    let easing = EASE;
    if (vt > 0.2 && rem > 1) {
      // После взмаха картинка продолжает со скоростью пальца и дальше только тормозит: наклон кривой в начале m — скорость
      // пальца в долях пути за время, опорные точки на трети по x
      ms = clamp((2.3 * rem) / vt, 140, 300);
      const m = Math.min(3, (vt * ms) / rem);
      easing = `cubic-bezier(.333, ${(m / 3).toFixed(3)}, .667, 1)`;
    }
    const my = ++st.settle;
    const done = () => {
      if (my !== st.settle || st.strip !== s) return;
      // Ушли к соседу: копии остаются, пока на их месте не встанет настоящий кадр (layout-эффект выше), без наплыва
      if (dir) {
        s.committed = true;
        st.cut = true;
        go(dir);
        // Кадр так и не сменился (тот же адрес, картинка не открылась) — не оставляем ленту висеть за краем
        setTimeout(() => { if (st.strip === s) drop(st, 'strip'); }, 4000);
      } else drop(st, 'strip');
    };
    if (reducedMotion()) { slide(x1); done(); return; }
    const move = (el, off) => el.animate([{ transform: `translateX(${x0 + off}px)` }, { transform: `translateX(${x1 + off}px)` }], { duration: ms, easing, fill: 'forwards' });
    s.anims = [move(s.img, 0), ...s.layers.map((l) => move(l, l.off))];
    Promise.all(s.anims.map((a) => a.finished)).then(done, () => { /* схватили посреди доезда */ });
  };

  const swipe = {
    onPointerDown: (e) => {
      const st = ref.current;
      // Только палец: мышь нажатием листает и тянет увеличенную картинку. Жест на панели, на полосе перемотки и на увеличенной
      // картинке картинку не листает
      if (e.pointerType === 'mouse' || !shown || !go || blocked?.() || e.target.closest?.('.gallery-bar, .vseek, button')) return;
      if (st.strip?.committed) return;   // уже перелистнули, ждём новый кадр
      if (st.drag) { st.drag.multi = true; return; }   // второй палец — это увеличение, не листание
      const img = imgOf(viewRef);
      if (!img) return;
      st.took = false;
      let base = 0;
      const grab = !!st.strip;
      // Схватили картинку посреди доезда — тянем с того места, где она сейчас
      if (grab) {
        base = new DOMMatrixReadOnly(getComputedStyle(st.strip.img).transform).m41;
        st.settle += 1;
        st.strip.anims.forEach((a) => a.cancel());
        st.strip.anims = [];
        slide(base);
        st.took = true;
      }
      st.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, base, axis: grab ? 'x' : null, pts: [{ x: 0, t: performance.now() }], multi: false };
    },
    onPointerMove: (e) => {
      const st = ref.current;
      const d = st.drag;
      if (!d || e.pointerId !== d.id) return;
      const rx = e.clientX - d.x;
      if (!d.axis) {
        // Ось выбираем один раз, после 10 точек: вбок — листаем кадры, вверх-вниз — альбомы (старый жест, touchend)
        if (Math.hypot(rx, e.clientY - d.y) < 10) return;
        if (Math.abs(e.clientY - d.y) > Math.abs(rx)) { st.drag = null; return; }
        d.axis = 'x';
        st.took = true;
        const view = viewRef.current;
        const img = imgOf(viewRef);
        if (!view || !img) { st.drag = null; return; }
        drop(st, 'fx');
        const step = img.getBoundingClientRect().width / pageZoom() + GAP;
        const layers = [];
        for (const dir of [-1, 1]) {
          const src = neighbor?.(dir);
          if (src) { const l = layerOf(view, img, src); l.off = dir * step; layers.push(l); }
        }
        st.strip = { img, layers, anims: [], step, committed: false };
      }
      const dx = rx / pageZoom();
      d.pts.push({ x: dx, t: performance.now() });
      if (d.pts.length > 8) d.pts.shift();
      slide(d.base + edge(dx));
    },
    onPointerUp: (e) => end(e),
    onPointerCancel: (e) => end(e),
  };
  function end(e) {
    const st = ref.current;
    const d = st.drag;
    if (!d || e.pointerId !== d.id) return;
    st.drag = null;
    if (d.axis !== 'x' || !st.strip) return;
    const dx = (e.clientX - d.x) / pageZoom();
    const now = performance.now();
    // Скорость — по точкам последних 100 мс; палец стоял дольше — 0
    const p0 = d.pts.find((p) => now - p.t <= 100);
    const v = e.type === 'pointercancel' || d.multi ? 0 : p0 && now - p0.t > 0 ? (dx - p0.x) / (now - p0.t) : 0;
    const moved = e.type === 'pointercancel' || d.multi ? 0 : dx;
    release(d.base + edge(moved), d.base + moved, v);
  }
  // took() — жест разобран здесь: touchend не листает второй раз, а нажатие после него (click) отменяет
  return { shown: direct ? want : shown, swipe, took: () => ref.current.took };
}

// Строки вкладок «Сцены» и «Диалоги»: одна на каждую сцену, которую можно смотреть. Альбом со сценарием — своя строка, а у
// альбома со сценами-гостями (album.scenes) — по строке на гостя (открывается с его номером n). dialogue — альбомы «dialogue»
// (диалоги без своих картинок), иначе все остальные со сценарием. Порядок — как в игре. Одинаковые названия внутри вкладки
// нумеруем здесь, по порядку («Village Doctor 3»): в игре их много, а сервер их не различает. Сводка (album.sum) есть только у
// оглавления после пересборки — без неё строка просто покажет название
export const sceneRows = (albums, dialogue) => {
  const rows = [];
  for (const a of albums) {
    if (!a.script || (a.kind === 'dialogue') !== dialogue) continue;
    // Название сцены — последняя часть ключа; «#par», «#loop» и подобное — пометки сервера, а не имя
    const name = a.title || a.key.split('/').pop().replace(/(#\w+)+$/, '');
    if (Array.isArray(a.scenes) && a.scenes.length) {
      a.scenes.forEach((g, n) => rows.push({ album: a, n, title: g.t || name, sum: g.sum, cover: a.files[g.f?.[0]] || a.cover || a.files[0] }));
    } else rows.push({ album: a, n: 0, title: name, sum: a.sum, cover: a.cover || a.files[0] });
  }
  const total = new Map();
  for (const r of rows) total.set(r.title, (total.get(r.title) || 0) + 1);
  const seen = new Map();
  return rows.map((r) => {
    if (total.get(r.title) < 2) return r;
    const no = (seen.get(r.title) || 0) + 1;
    seen.set(r.title, no);
    return { ...r, title: `${r.title} ${no}` };
  });
};
