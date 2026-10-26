import { useEffect, useSyncExternalStore } from 'react';
import { layersOpen } from './layers';

// Настроение мимика в шапке: один источник на приложение (useSyncExternalStore), как в спецификации «номер 8».
// Хранит покой (ночь, сторону курсора, наведение, глаза закрыты) и событие с номером кадра; BrandMark live только
// рисует кадр, который здесь назван. Анимация — только смена кадра (80 мс), без сдвигов и плавности.
// Таймер один: между движениями ничего не крутится (ни rAF, ни interval), нет вкладки или нет знака — таймеров нет.
// Своё движение — только после паузы ввода: 2 с после указателя и прокрутки, 3 с после клавиши («печать»)

const PXF = 80; // один кадр
const AIM_MS = 160; // курсор: сторона глаз и подъём крышки меняются, когда он простоял на новой стороне
const QUIET_MS = 2000;
const KEY_QUIET_MS = 3000;
const ERR_ACT_MS = 2000; // дрожь — на тост не позже 2 с после нажатия
const ERR_GAP_MS = 10000; // и не чаще раза в 10 с: ошибки приходят пачками
const DONE_TTL = 10000; // отложенные «готово» и обновления ждут не дольше 10 с
const COIN_GAP_MS = 60000; // монета не чаще раза в минуту: пачка игр даёт одну
const IDLE_S = [20, 40]; // пауза покоя, ночью вдвое длиннее
const IDLE_MAX = 3; // движений покоя подряд без ввода, потом замер до первого ввода
const CHEW_FAST = 34 * PXF; // открыт после укуса: 480 + 2720 = 3,2 с в первые 10 с работы
const CHEW_SLOW = 114 * PXF; // дальше 480 + 9120 = 9,6 с: сборка галереи идёт минуты
const CHEW_FAST_MS = 10000;
const NIGHT = [1, 6]; // 01:00–06:00 по часам устройства
const CLICKS = 5; // секрет: пять щелчков по знаку за 2 с
const CLICKS_MS = 2000;
const PLAY = '.card-play, .continue-btn'; // кнопки «Играть», что запускают игру с переходом (withIntro)

// [кадр, сколько кадров по 80 мс, что поверх]. Кадры-ссылки разворачиваются от покоя вида: '=' — кадр покоя
// (ночью D, глаза у курсора, под наведением W), 'B' — он же без глаз, 'K-'/'K+' — его крышка на клетку влево/вправо,
// 'G-'/'G+' — взгляд в сторону (ночью DL/DR: крышка не поднимается). После последнего кадра — кадр покоя
const SEQ = {
  blink: [['B', 2]],
  nblink: [['B', 4]], // ночью медленнее: глаза закрыты 320 мс
  glanceL: [['G-', 8]],
  glanceR: [['G+', 8]],
  glance2: [['G-', 8], ['=', 2], ['G+', 8]],
  bite: [['HALF', 2], ['=', 2], ['HALF', 2]],
  // Прикрыл, захлопнул, подскочил; приземлился приоткрытым — монета выходит из щели; открылся, пока она поднимается
  done: [['HALF', 1], ['SHUT', 1], ['HOP', 2], ['HALF', 1, 'c0'], ['HALF', 1, 'c1'], ['HALF', 1, 'c2'], ['=', 1, 'c3'], ['=', 1, 'c4']],
  wake: [['B', 1], ['=', 4], ['B', 2]],
  rattle: [['K-', 1], ['K+', 1]],
  gulp: [['SHUT', 1], ['HALF', 1]], // «Играть»: W держится, пока кнопка нажата (arm); на click — захлопнул и прикрыл
  spit: [['W', 2], ['W', 1, 'p0'], ['W', 1, 'p1'], ['=', 1, 'p2'], ['=', 1, 'p3']],
  updL: [['G-', 3], ['=', 2], ['G-', 3]],
  updR: [['G+', 3], ['=', 2], ['G+', 3]],
};
const seqMs = (name, from = 0) => SEQ[name].slice(from).reduce((s, [, n]) => s + n, 0) * PXF;
// Поверх наведения видно только это: «готово» и то, что вызвал сам человек, — на знак он и смотрит
const OVER = new Set(['done', 'rattle', 'gulp', 'spit']);
// Мелкие движения прерывает что угодно; «готово», «Играть» и секрет доигрывают
const MINOR = new Set(['blink', 'nblink', 'glanceL', 'glanceR', 'glance2', 'bite', 'updL', 'updR', 'rattle']);
const LOOKS = new Set(['blink', 'nblink', 'glanceL', 'glanceR', 'glance2', 'updL', 'updR']);
// Взгляды сами знают, куда смотреть: пока идут, глаза к курсору не тянутся
const NOLOOK = new Set(['glanceL', 'glanceR', 'glance2', 'updL', 'updR']);
// Вид «вход» показывает только покой: больше на странице входа ничего не происходит
const LOGIN_ONLY = ['blink', 'nblink', 'glanceL', 'glanceR', 'glance2'];

const motion = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const rm = () => !!motion?.matches;

const IN = { key: -1e9, ptr: -1e9, act: -1e9 };
const quietAt = () => Math.max(IN.key + KEY_QUIET_MS, IN.ptr + QUIET_MS);
const isQuiet = () => performance.now() >= quietAt();
const typing = () => performance.now() < IN.key + KEY_QUIET_MS;

const newView = (only = null, covers = false) => ({ only, covers, hover: null, look: null, want: null, aimT: 0, sleeping: false, local: null, localT: 0, key: '' });
const views = { head: newView(null, true), login: newView(LOGIN_ONLY, false) };
const st = {
  frame: '=', ov: '', tag: '', run: null, timer: 0, nightTimer: 0,
  work: new Set(), busySince: 0, nextBite: 0, nextIdle: 0, idleCount: 0, frozen: false,
  pendingDone: 0, pendingUpd: 0, updSide: 1, shut: false, night: false, others: 0, armed: false,
  lastCoin: -1e9, lastRattle: -1e9, clicks: [],
};
const listeners = new Set();
let mounts = 0;

const busy = () => st.work.size > 0;
const anyHover = () => views.head.hover !== null;
const anyLook = () => views.head.look !== null;
const held = () => st.armed || (st.run && !MINOR.has(st.tag));
const gap = () => (IDLE_S[0] + Math.random() * (IDLE_S[1] - IDLE_S[0])) * 1000 * (st.night ? 2 : 1);
const chewRest = () => (performance.now() - st.busySince < CHEW_FAST_MS ? CHEW_FAST : CHEW_SLOW);
const at = (t, fn) => { clearTimeout(st.timer); st.timer = setTimeout(fn, Math.max(0, t - performance.now())); };

// Кадр покоя вида: наведение (W, WL, WR) → ночь или день, глаза к курсору над шапкой. Глаза закрыты (обложки
// скрыты) — следить нечем и крышка не поднимается: ни наведение, ни курсор кадр не меняют
function rest(v, look = true) {
  const shut = st.shut && v.covers;
  if (v.hover && !shut) return v.hover.side < 0 ? 'WL' : v.hover.side > 0 ? 'WR' : 'W';
  const i = (look && !shut && v.look ? v.look : 0) + 1;
  return (st.night ? ['DL', 'D', 'DR'] : ['L', 'OPEN', 'R'])[i];
}

// Что видно в виде: сон и пробуждение (вход) → «Играть» нажато → кадр события → покой. Событие под наведением не
// видно, кроме OVER; вход видит только покой. «Уменьшить движение» — всегда открытый, без глаз при скрытых обложках
function viewFrame(v) {
  const shut = st.shut && v.covers;
  if (rm()) return { f: 'OPEN', ov: '', shut };
  if (v.sleeping && !v.local) return { f: 'SLEEP', ov: '', shut };
  let tag = st.run ? st.tag : '';
  let f = '=';
  let ov = '';
  if (v.local) { f = v.local; tag = ''; }
  else if (st.armed) f = 'W';
  else if (tag && !(v.hover && !OVER.has(tag)) && !(v.only && !v.only.includes(tag))) { f = st.frame; ov = st.ov; }
  const look = !NOLOOK.has(tag);
  if (f === '=') f = rest(v, look);
  else if (f === 'B' || f === 'K-' || f === 'K+') f = `${f}:${rest(v, look)}`;
  else if (f === 'G-' || f === 'G+') f = (st.night ? ['DL', 'DR'] : ['L', 'R'])[f === 'G-' ? 0 : 1];
  // Глаза закрыты — крышка не выше открытой: в секрете и «Играть» вместо W — открытый без глаз
  if (shut) f = f.replace(/W[LR]?$/, 'OPEN');
  return { f, ov, shut };
}

// Снимок вида — строка «кадр|поверх|глаза закрыты»: React сравнивает её по значению
const snap = (v) => { const s = viewFrame(v); return `${s.f}|${s.ov}|${s.shut ? 1 : 0}`; };

// f — новый общий кадр (тогда и ov: что поверх); без f — перерисовать виды, если у них что-то поменялось
function draw(f, ov) {
  if (f !== undefined) { st.frame = f; st.ov = ov || ''; }
  let changed = false;
  for (const v of Object.values(views)) {
    const key = snap(v);
    if (key !== v.key) { v.key = key; changed = true; }
  }
  if (changed) listeners.forEach((fn) => fn());
}
for (const v of Object.values(views)) v.key = snap(v);

function stopRun() {
  if (st.run) { clearTimeout(st.run.t); st.run = null; }
}

// Кадры по 80 мс; новое прерывает прежнее, в конце — кадр покоя и решение, что дальше. from — с какого кадра начать
// (секрет, когда крышку уже поднял курсор)
function seq(name, from = 0) {
  stopRun();
  clearTimeout(st.timer);
  st.armed = false;
  // Уменьшить движение и вкладка в фоне: кадров нет, только кадр покоя
  if (rm() || document.hidden) { draw('='); return; }
  const token = { t: 0 };
  st.run = token;
  st.tag = name;
  const steps = SEQ[name].slice(from);
  let i = 0;
  const step = () => {
    if (st.run !== token) return;
    if (i >= steps.length) {
      st.run = null;
      draw('=');
      // После укуса — пауза жевания; после покоя и событий — полная пауза покоя
      if (name === 'bite') st.nextBite = performance.now() + chewRest();
      else st.nextIdle = performance.now() + gap();
      next();
      return;
    }
    const [f, n, ov] = steps[i];
    i += 1;
    draw(f, ov);
    token.t = setTimeout(step, n * PXF);
  };
  step();
}

const isNight = () => { const h = new Date().getHours(); return h >= NIGHT[0] && h < NIGHT[1]; };
// Ночь по часам: проверка при каждом решении и один setTimeout до ближайших 01:00 или 06:00 — без опроса
function updateNight() {
  clearTimeout(st.nightTimer);
  if (!mounts || rm()) {
    if (st.night) { st.night = false; draw(); }
    return;
  }
  const d = new Date();
  const h = d.getHours();
  const t = new Date(d);
  t.setHours(h < NIGHT[0] ? NIGHT[0] : h < NIGHT[1] ? NIGHT[1] : 24 + NIGHT[0], 0, 1, 0);
  st.nightTimer = setTimeout(() => { updateNight(); if (!st.run) next(); }, t - d);
  const n = isNight();
  if (n === st.night) return;
  st.night = n;
  draw();
}

// Что дальше: показать отложенное «готово» или обновления, куснуть, ждать случая моргнуть или стоять. Своё
// движение — только после паузы ввода; один setTimeout, между движениями ничего не крутится
function next() {
  clearTimeout(st.timer);
  if (!mounts || rm() || document.hidden || st.run || st.armed) return;
  updateNight();
  if (st.others) return; // на экране свой мимик (плашка, загрузчик): этот стоит — в движении один
  const now = performance.now();
  const q = quietAt();
  // «Готово» — поверх наведения: ждёт только паузы ввода
  if (st.pendingDone) { at(Math.max(now, q), fireDone); return; }
  if (anyHover()) return; // курсор на знаке — стоит в кадре наведения
  if (st.pendingUpd) { at(Math.max(now, q), fireUpd); return; }
  if (busy()) { at(Math.max(st.nextBite, q), chew); return; }
  // Глаза закрыты — моргать и коситься нечем: покой не тикает, пока обложки не вернут
  if (st.shut) return;
  if (st.frozen) return;
  if (st.idleCount >= IDLE_MAX) { st.frozen = true; return; }
  if (!st.nextIdle) st.nextIdle = now + gap();
  at(Math.max(st.nextIdle, q), fireIdle);
}

function fireIdle() {
  if (!isQuiet() || busy() || anyHover() || st.others || st.shut) { next(); return; }
  st.idleCount += 1;
  if (st.night) { seq('nblink'); return; }
  // Курсор над шапкой — глаза уже на нём: коситься некуда, только моргнуть
  if (anyLook()) { seq('blink'); return; }
  const r = Math.random();
  seq(r < 0.6 ? 'blink' : r < 0.76 ? 'glance2' : r < 0.88 ? 'glanceL' : 'glanceR');
}

function chew() {
  if (!busy() || !isQuiet() || anyHover() || st.others) { next(); return; }
  seq('bite');
}

function fireDone() {
  if (performance.now() - st.pendingDone > DONE_TTL) {
    st.pendingDone = 0;
    st.nextIdle = performance.now() + gap();
    next();
    return;
  }
  if (!isQuiet()) { next(); return; }
  st.pendingDone = 0;
  st.lastCoin = performance.now();
  seq('done');
}

function fireUpd() {
  if (performance.now() - st.pendingUpd > DONE_TTL) { st.pendingUpd = 0; next(); return; }
  if (!isQuiet() || anyHover()) { next(); return; }
  st.pendingUpd = 0;
  seq(st.updSide < 0 ? 'updL' : 'updR');
}

// Курсор: сторона глаз и подъём крышки меняются, только если он простоял на новой стороне 160 мс — и на входе, и на
// уходе. Проход через шапку к вкладкам браузера и задетый угол знака рывков не дают. Наведение и глаза — одно
// желаемое состояние с одним таймером: с шапки на знак кадр меняется сразу (L → WR), без промежуточного OPEN
function aim(kind, side) {
  const v = views.head;
  if (rm() || st.shut) return;
  const cur = { hover: v.hover ? v.hover.side : null, look: v.look };
  const want = { ...(v.aimT ? v.want : cur), [kind]: side };
  if (want.hover === cur.hover && want.look === cur.look) { clearAim(); return; }
  if (v.aimT && want.hover === v.want.hover && want.look === v.want.look) return;
  clearTimeout(v.aimT);
  v.want = want;
  v.aimT = setTimeout(() => {
    v.aimT = 0;
    v.look = want.look;
    if (!setHover(want.hover)) draw();
  }, AIM_MS);
}
function clearAim() {
  const v = views.head;
  clearTimeout(v.aimT);
  v.aimT = 0;
  v.want = null;
}
// side: −1, 0, 1 — где курсор от середины знака; null — ушёл. true — кадр поменялся
function setHover(side) {
  if (rm()) return false;
  const v = views.head;
  const was = v.hover;
  v.hover = side == null ? null : { side };
  if ((was?.side ?? null) === (v.hover?.side ?? null)) return false;
  draw();
  if (v.hover) return true;
  // Курсор ушёл: своё движение — не сразу, а через полную паузу: на знак ещё смотрят
  const now = performance.now();
  st.nextBite = Math.max(st.nextBite, now + chewRest());
  st.nextIdle = Math.max(st.nextIdle, now + gap());
  if (!st.run) next();
  return true;
}

// Ввод человека: счёт движений покоя с нуля; замерший знак снова ждёт полную паузу
function onInput() {
  st.idleCount = 0;
  if (!st.frozen) return;
  st.frozen = false;
  st.nextIdle = performance.now() + gap();
  next();
}

// Enter и пробел на кнопке — нажатие, а не печать
const isPress = (e) => (e.key === 'Enter' || e.key === ' ') && e.target?.closest?.('button, [role="button"], .brand');
function onKey(e) {
  const now = performance.now();
  if (e.type === 'keydown' && isPress(e)) {
    IN.ptr = IN.act = now;
    if (e.key === ' ' && !e.repeat && e.target.closest(PLAY)) mood.arm(layersOpen());
  } else IN.key = now;
  onInput();
}
function onPointer(e) {
  const now = performance.now();
  IN.ptr = now;
  if (e.type === 'pointerdown') {
    IN.act = now;
    if (e.button === 0 && e.target?.closest?.(PLAY)) mood.arm(layersOpen());
  }
  onInput();
}
// «Играть» отпущено мимо кнопки или потеряло фокус — W опускается; click без перехода (rpg-intro) тоже
function onPlayRelease(e) {
  if (!st.armed) return;
  if (e.type === 'pointerout') {
    const b = e.target?.closest?.(PLAY);
    if (!b || b.contains(e.relatedTarget)) return;
  }
  mood.disarm();
}
// click ловим до обработчиков карточек, но запуск с переходом (gulp) идёт в них же, синхронно, и должен застать
// armed: снимаем после — если gulp не пришёл (картинки нет, переход не начался), W не остаётся до ухода мыши
function onPlayClick(e) {
  if (st.armed) setTimeout(() => onPlayRelease(e), 0);
}
// Вкладка в фоне — ничего не крутится; вернулись — первое движение через полную паузу, не в ту же миллисекунду
function onVisibility() {
  for (const v of Object.values(views)) { clearTimeout(v.localT); v.local = null; }
  if (document.hidden) {
    stopRun();
    clearTimeout(st.timer);
    st.armed = false;
    st.pendingDone = 0;
    st.pendingUpd = 0;
    draw('=');
    return;
  }
  const now = performance.now();
  st.nextIdle = now + gap();
  st.nextBite = now + chewRest();
  next();
}
// «Уменьшить движение» включили или выключили на лету
function onMotion() {
  if (rm()) {
    stopRun();
    clearTimeout(st.timer);
    for (const v of Object.values(views)) { clearTimeout(v.localT); v.local = null; v.sleeping = false; v.hover = null; v.look = null; clearTimeout(v.aimT); v.aimT = 0; }
    st.armed = false;
    st.pendingDone = 0;
    st.pendingUpd = 0;
    updateNight();
    draw('=');
    return;
  }
  st.nextIdle = performance.now() + gap();
  updateNight();
  draw();
  next();
}

const WIN = [
  [['keydown', 'input'], onKey, { capture: true }],
  [['pointermove', 'pointerdown', 'wheel', 'scroll', 'touchmove'], onPointer, { passive: true, capture: true }],
  [['pointerout', 'pointercancel', 'focusout'], onPlayRelease, { capture: true }],
  [['click'], onPlayClick, { capture: true }], // capture: Shelves и GameCard глушат click (stopPropagation) до window
];
function start() {
  WIN.forEach(([evs, fn, opt]) => evs.forEach((ev) => window.addEventListener(ev, fn, opt)));
  document.addEventListener('visibilitychange', onVisibility);
  motion?.addEventListener('change', onMotion);
  updateNight();
  next();
}
function stop() {
  WIN.forEach(([evs, fn, opt]) => evs.forEach((ev) => window.removeEventListener(ev, fn, opt)));
  document.removeEventListener('visibilitychange', onVisibility);
  motion?.removeEventListener('change', onMotion);
  stopRun();
  clearTimeout(st.timer);
  clearTimeout(st.nightTimer);
  for (const v of Object.values(views)) { clearTimeout(v.aimT); v.aimT = 0; clearTimeout(v.localT); v.local = null; v.hover = null; v.look = null; v.want = null; }
  st.armed = false;
}

const subscribe = (fn) => {
  listeners.add(fn);
  mounts += 1;
  if (mounts === 1) start();
  return () => {
    listeners.delete(fn);
    mounts -= 1;
    if (mounts === 0) stop();
  };
};

export const mood = {
  // Идёт работа в фоне, у которой нет своего мимика: поиск данных, очередь, проверка. key — кто; жуёт, пока есть хоть одна
  work(key, on) {
    if (st.work.has(key) === on) return;
    const was = busy();
    if (on) st.work.add(key); else st.work.delete(key);
    if (was === busy()) return;
    if (busy()) { st.busySince = performance.now(); st.nextBite = st.busySince; }
    // Покой во время работы не тикает: кончилась — полная пауза, а не моргание в ту же миллисекунду
    else st.nextIdle = performance.now() + gap();
    if (rm()) return;
    if (busy() && st.run && MINOR.has(st.tag)) { stopRun(); draw('='); }
    next();
  },
  // Готово: захлопнулся, подскочил и выпустил монету. Поверх наведения. Пока печатают — после паузы, если успеет за
  // 10 с; вкладка в фоне — не показываем. Монета одна: второе «готово», пока идёт или ждёт первое, её не добавляет,
  // а следующее меньше чем через минуту — без движения. Возвращает, что решил (для тестов и отладки)
  done() {
    if (rm() || document.hidden) return 'still';
    if (st.others) return 'other';
    if (st.run && st.tag === 'done') return 'dup';
    if (st.pendingDone) { st.pendingDone = performance.now(); return 'dup'; }
    const now = performance.now();
    if (now - st.lastCoin < COIN_GAP_MS) return 'calm';
    if (!isQuiet() || held()) { st.pendingDone = now; if (!st.run && !st.armed) next(); return 'later'; }
    st.lastCoin = now;
    seq('done');
    return 'now';
  },
  // Ошибка — ответ на то, что человек только что сделал: тост не позже 2 с после его нажатия. Сразу или никогда:
  // дрожь через 3 с уже ни к чему не привязана. Не чаще раза в 10 с. Фоновые тосты — без дрожи (вызывающий не зовёт)
  error() {
    if (rm() || document.hidden || !mounts) return 'still';
    if (st.others) return 'other';
    if (typing()) return 'typing';
    const now = performance.now();
    if (now - IN.act > ERR_ACT_MS) return 'bg';
    if (now - st.lastRattle < ERR_GAP_MS) return 'often';
    if (held()) return 'busy';
    st.lastRattle = now;
    seq('rattle');
    return 'now';
  },
  // Число обновлений выросло: дважды глянуть в сторону вкладки с числом (side −1 или 1). Поверх глаз за курсором,
  // но ждёт, пока курсор уйдёт со знака, и паузы ввода, как «готово»
  updates(side) {
    if (rm() || document.hidden || st.shut || !side) return 'still';
    if (st.others) return 'other';
    st.updSide = side;
    if (held() || st.pendingDone || anyHover() || !isQuiet()) {
      st.pendingUpd = performance.now();
      if (!st.run && !st.armed) next();
      return anyHover() ? 'hover' : 'later';
    }
    st.pendingUpd = 0;
    seq(side < 0 ? 'updL' : 'updR');
    return 'now';
  },
  // «Играть» — нажатие человека, работает и поверх наведения, и сразу после печати: нажатие печать кончает.
  // W, пока кнопка нажата. Открыт слой (окно игры, «Во что поиграть?») — шапка под затемнением: не поднимает вовсе
  arm(layer) {
    IN.key = -1e9;
    if (rm() || document.hidden || layer || !mounts) return false;
    stopRun();
    clearTimeout(st.timer);
    st.armed = true;
    draw('=');
    return true;
  },
  disarm() {
    if (!st.armed) return;
    st.armed = false;
    draw('=');
    next();
  },
  // click по «Играть» (withIntro): захлопнул и прикрыл. Enter нажимает и щёлкает в один миг — W нет, сразу SHUT
  gulp(layer) {
    IN.key = -1e9;
    if (rm() || document.hidden || !mounts) return 'still';
    if (layer) { mood.disarm(); return 'layer'; }
    const pressed = st.armed;
    seq('gulp');
    return pressed ? 'now' : 'click';
  },
  // Пять щелчков: крышка вверх и обложка изо рта. Возвращает, через сколько мс открыть «Во что поиграть?»:
  // 480 мс, 320 — если крышку уже поднял курсор, 0 — при «уменьшить движение» и во вкладке в фоне
  spit() {
    IN.key = -1e9;
    if (rm() || document.hidden || !mounts) return 0;
    const from = anyHover() ? 1 : 0;
    seq('spit', from);
    return seqMs('spit', from);
  },
  // Щелчок по знаку: пятый за 2 с — секрет. true — пятый
  click() {
    const now = performance.now();
    st.clicks = [...st.clicks.filter((t) => now - t < CLICKS_MS), now];
    if (st.clicks.length < CLICKS) return false;
    st.clicks = [];
    return true;
  },
  // Нажатие по знаку кончает печать: пять щелчков сразу после буквы в поиске честно выплёвывают обложку
  press() { IN.key = -1e9; },
  // Обложки скрыты — глаза закрыты. Сразу, и во время печати, и при «уменьшить движение»: это ответ на нажатие.
  // Моргание и взгляды прерываются: глаз нет; жевание и «готово» идут дальше
  covers(on) {
    if (st.shut === on) return;
    st.shut = on;
    if (on && st.run && LOOKS.has(st.tag)) { stopRun(); draw('='); }
    if (on) { st.pendingUpd = 0; clearAim(); views.head.hover = null; views.head.look = null; }
    draw();
    if (!on) { st.idleCount = 0; st.frozen = false; st.nextIdle = performance.now() + gap(); }
    if (!st.run) next();
  },
  // Мышь над знаком (side) или над шапкой (look); null — ушла. Через 160 мс на месте
  hover: (side) => aim('hover', side),
  look: (side) => { if (!typing()) aim('look', side); },
  // Фокус с клавиатуры и палец на телефоне — без задержки: это не проход курсора мимо
  hoverNow(side) { clearAim(); setHover(side); },
  // На экране свой мимик (плашка загрузок, загрузчик, выглядывание): этот стоит, мелкое движение прерывается
  other(delta) {
    st.others = Math.max(0, st.others + delta);
    if (st.others && st.run && MINOR.has(st.tag)) { stopRun(); draw('='); }
    if (!st.run) next();
  },
  // Вход: спит (SLEEP), пока не нажата первая буква; потом поднял крышку, открыл глаза и моргнул — и общий покой
  sleep(on) {
    const v = views.login;
    clearTimeout(v.localT);
    v.local = null;
    if (on) { v.sleeping = !rm(); draw(); return; }
    if (!v.sleeping) return;
    if (rm() || document.hidden) { v.sleeping = false; draw(); return; }
    let i = 0;
    const step = () => {
      if (i >= SEQ.wake.length) { v.local = null; v.sleeping = false; draw(); return; }
      const [f, n] = SEQ.wake[i];
      i += 1;
      v.local = f;
      draw();
      v.localT = setTimeout(step, n * PXF);
    };
    step();
  },
};

// Для тестов: страница отдаёт хранилище, чтобы вести состояние без ожидания настоящих событий сервера
if (typeof window !== 'undefined') window.__mimicMood = mood;

export const useMimicFrame = (view = 'head') => useSyncExternalStore(subscribe, () => views[view].key);

// Свой мимик на экране (плашка загрузок, загрузчик, выглядывание) — пока on, мимик в шапке молчит
export const useOtherMimic = (on) => {
  useEffect(() => {
    if (!on) return undefined;
    mood.other(1);
    return () => mood.other(-1);
  }, [on]);
};

// Сторона курсора от середины места знака (.m16): дальше двух клеток — влево или вправо, ближе — прямо
export const sideAt = (x, box) => {
  const r = box.getBoundingClientRect();
  const dx = x - (r.left + r.width / 2);
  return Math.abs(dx) <= r.width / 8 ? 0 : Math.sign(dx);
};
