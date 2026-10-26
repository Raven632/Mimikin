import { useEffect, useRef, useState } from 'react';
import { useLayer } from '../layers';
import { writeSound, readSceneSound, readSceneLang, writeSceneLang, AUTO_PACES, readAutoPace, writeAutoPace } from '../galleryView';
import { languageTitle } from '../formatLanguage';
import BarChoose from './BarChoose';
import { IconClose, IconChevronLeft, IconChevronRight, IconPlay, IconPause, IconSound, IconMute, IconSkip } from './icons';

// Сцена из события игры: картинки, реплики, музыка и звуки по порядку — без запуска игры. Шаги присылает сервер
// (services/gallery.js, scene): pic (номер файла), anim (кадры по кругу или один раз, звуки кадров), say, choice, snd, stop,
// wait, fx (тон, вспышка, тряска, затемнение), rep (границы повторов цикла), vid (ролики на экране игры), vwait (игра
// ждёт конца ролика), spine (врезка Spine: слой на холсте SceneSpine, ленивом; pic.box — где на экране игры картинка) и l2d (модель Live2D: то же на холсте SceneLive2D); pic с номером −1 убирает картинку; язык текста — lang и langs, если вариантов несколько. Двигатель (createEngine) —
// обычный объект вне React: звук и таймеры не должны перерисовывать окно и теряться между кадрами

const MAX_WAIT = 6;       // секунд на паузу события: игра ждёт кадры анимации, которых здесь нет
const TYPE_CPS = 55;      // знаков в секунду, пока реплика печатается
const FADE_STEP = 60;     // мс между шагами затухания музыки
const AHEAD = 40;         // кадров заранее: анимация до следующей реплики не ждёт, пока сервер склеит кадр
const AHEAD_AT_ONCE = 6;  // запросов заранее одновременно: каждая склейка — работа сервера
const ANIM_MIN_MS = 16;   // мс на кадр анимации: чаще экран всё равно не обновляется
const CROSS_MIN = 4;      // кадров игры: плавная смена короче глазом не видна, кадр просто сменяется
const POOL = 3;           // звуков одного файла одновременно у анимации: частый звук кадра не плодит плееры
const DARK_STOPS = 5;     // реплик подряд под чёрным: больше — возврат потерялся, затемнение снимаем сами
const VID_LOAD = 3000;    // мс на первый кадр ролика: дольше — идём дальше без него
const VID_UNKNOWN = 8000; // мс ждать конец ролика, пока не знаем его длину (6000 — длина не число)
const PRELOAD = 2;        // роликов, что подгружаем заранее: больше телефону не потянуть
const SKIP_MS = 120;      // мс на реплику при пропуске: текст мелькает, как пропуск в игре
const SKIP_SPEED = 8;     // во сколько раз быстрее паузы, анимации и переходы, пока идёт пропуск
const isStop = (s) => s.k === 'say' || s.k === 'choice';
// Канал по кругу: музыка, фон, голос по кругу (стон, дыхание) — у голоса свой на каждый канал плагина
const slotOf = (s) => (s.kind === 'vloop' ? `vloop${s.ch || 0}` : s.kind);
const LOOPED = (s) => s.kind === 'bgm' || s.kind === 'bgs' || s.kind === 'vloop';
const rate = (pitch) => Math.max(0.5, Math.min(2, (pitch || 100) / 100));
const volume = (v) => Math.max(0, Math.min(1, (v ?? 90) / 100));
const imageUrl = (id, f) => `/api/gallery/${encodeURIComponent(id)}/image?f=${encodeURIComponent(f)}`;
const audioUrl = (id, f) => `/api/gallery/${encodeURIComponent(id)}/audio?f=${encodeURIComponent(f)}`;
const videoUrl = (id, f) => `/api/gallery/${encodeURIComponent(id)}/video?f=${encodeURIComponent(f)}`;
// Режим смешивания ролика на картинке: 1 — сложение, 2 — умножение, 3 — экран
const blendOf = (b) => (b === 1 ? (window.CSS?.supports?.('mix-blend-mode', 'plus-lighter') ? 'plus-lighter' : 'screen') : b === 2 ? 'multiply' : b === 3 ? 'screen' : '');
// Умеет ли браузер прозрачный WebM: крошечный ролик с нулевой прозрачностью рисуем на холсте. Один раз за сессию; ответа нет
// за 3 с или любая ошибка — «не умеет» (прозрачный ролик тогда не кладём на CG: она остаётся, как без роликов)
let alphaProbe = null;
const alphaOk = () => alphaProbe || (alphaProbe = new Promise((done) => {
  const v = document.createElement('video');
  const timer = setTimeout(() => done(false), 3000);
  const end = (ok) => { clearTimeout(timer); done(ok); };
  v.muted = true;
  v.playsInline = true;
  v.onloadeddata = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const g = c.getContext('2d');
      g.drawImage(v, 0, 0, 16, 16);
      end(g.getImageData(8, 8, 1, 1).data[3] < 128);
    } catch { end(false); }
  };
  v.onerror = () => end(false);
  v.src = '/alpha-test.webm';
  v.play?.().catch(() => {});
}));

function createEngine(game, live, ui) {
  // anim — играющая анимация; cur и old — две картинки поверх неподвижной (old держит прежний кадр, пока он гаснет); loaded
  // и bad — кадры, что загрузились и что нет; flight — что грузится; res — кто ждёт кадр; pool — звуки кадров; regions — повторы
  // цикла [откуда, докуда]; dark — экран затемнён
  const e = { data: null, stops: [], cursor: 0, at: -1, gen: 0, timer: 0, loops: {}, want: {}, shots: new Set(), voice: null, meOn: false, picToken: 0, pending: null, shown: -1, pic: -1, fades: new Set(), fading: {}, asked: new Set(), queue: [], loading: 0,
    anim: null, animUp: false, animToken: 0, cur: null, old: null, loaded: new Set(), bad: new Set(), flight: new Set(), res: new Map(), pool: {}, regions: [], dark: false, darkStops: 0,
    // Ролики: vids — слой на место (slot → { el, v, of, ready, old }), vidList — что сейчас задано шагом vid, vidPend — кто ещё грузится,
    // vbad — ролики, что не открылись, pre — подгруженные заранее, vtoken — какое ожидание ролика сейчас, alpha — умеет ли браузер
    // прозрачный WebM, dead — окно закрыто
    // spine — слои Spine и Live2D на экране (id → шаг), spinePend — ждём ли холст (в settled не при пропуске)
    box: null, vids: new Map(), vidList: [], vidPend: null, vbad: new Set(), pre: [], vtoken: 0, alpha: false, dead: false, spine: new Map(), spinePend: null };
  const audible = () => live.sound && !live.hidden;

  // Музыка и фон: играет то, что событие включило последним; то же имя — не с начала (игра так и делает)
  const loop = (kind) => {
    const w = e.want[kind];
    let el = e.loops[kind];
    if (!w) { el?.pause(); return; }
    // Та же музыка включена снова посреди затухания — затухание отменяем, иначе она доиграет на нулевой громкости
    if (e.fading[kind]) { clearInterval(e.fading[kind]); e.fades.delete(e.fading[kind]); e.fading[kind] = 0; }
    if (!el || el.dataset.f !== w.f) {
      el?.pause();
      el = new Audio(audioUrl(game, w.f));
      el.loop = true;
      el.dataset.f = w.f;
      e.loops[kind] = el;
    }
    el.volume = volume(w.vol);
    el.playbackRate = rate(w.pitch);
    // Не дали запустить (Safari без касания) — получится при следующем нажатии (resume)
    if (audible() && !e.meOn) el.play().catch(() => {}); else el.pause();
  };
  const loopAll = () => { for (const kind of new Set([...Object.keys(e.want), ...Object.keys(e.loops)])) loop(kind); };
  const stopLoop = (kind, fade) => {
    e.want[kind] = null;
    const el = e.loops[kind];
    if (!el) return;
    if (!(fade > 0) || !audible()) { el.pause(); return; }
    const from = el.volume;
    const t0 = Date.now();
    clearInterval(e.fading[kind]);
    const timer = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / (fade * 1000));
      el.volume = from * (1 - k);
      if (k >= 1) { clearInterval(timer); e.fades.delete(timer); e.fading[kind] = 0; if (!e.want[kind] || e.loops[kind] !== el) el.pause(); }
    }, FADE_STEP);
    e.fades.add(timer);
    e.fading[kind] = timer;
  };
  const shot = (s) => {
    if (!audible()) return;
    // Голос не накладывается на голос: говорит один. При пропуске ни голос, ни звук не начинаем — реплика уйдёт через
    // такт, а звуки каждой реплики слились бы в шквал; музыка и фон (циклы) играют
    if (s.kind === 'voice' && e.voice) e.voice.pause();
    if (live.skip) return;
    const el = new Audio(audioUrl(game, s.f));
    el.volume = volume(s.vol);
    el.playbackRate = rate(s.pitch);
    e.shots.add(el);
    if (s.kind === 'voice') e.voice = el;
    const done = () => { e.shots.delete(el); if (e.voice === el) e.voice = null; };
    el.addEventListener('ended', done);
    el.addEventListener('error', done);
    el.play().catch(done);
  };
  // Джингл: музыка на его время замолкает
  const jingle = (s) => {
    if (!audible()) return;
    e.meOn = true;
    e.loops.bgm?.pause();
    const el = new Audio(audioUrl(game, s.f));
    el.volume = volume(s.vol);
    e.shots.add(el);
    const done = () => { e.shots.delete(el); e.meOn = false; loop('bgm'); };
    el.addEventListener('ended', done);
    el.addEventListener('error', done);
    el.play().catch(done);
  };

  // Картинка меняется, когда загрузилась: склейку сервер делает не мгновенно, а реплика не должна уйти вперёд картинки.
  // Анимация поверх неё убирается тоже только теперь — чужой кадр не мелькает
  const show = (i, box) => {
    const f = e.data.files[i];
    if (f === undefined) return;
    // Та же картинка с другим местом на экране игры (шаг pic с новым box): картинка стоит, врезка Spine встаёт по-новому
    if (i === e.pic && !e.animUp) { ui.setPic(i, box); return; }
    e.pic = i;
    const token = ++e.picToken;
    e.pending = new Promise((done) => {
      const img = new Image();
      img.onload = img.onerror = () => { if (token === e.picToken) { ui.setPic(i, box); if (!e.anim) animOff(); } done(); };
      img.src = imageUrl(game, f);
    });
  };
  // Картинки нет совсем (под роликом на чёрном): −2 — отличается от −1 «ещё ничего не показывали» тем, что тусклого первого кадра нет
  const clearPic = () => {
    e.pic = -2;
    e.picToken++;
    e.pending = null;
    ui.setPic(-2);
    animOff();
  };
  // Следующие картинки сцены — заранее: все кадры до следующей реплики (и хоть две за ней), не больше AHEAD; кадры анимаций
  // — все, без счёта: анимация не стартует, пока их нет
  const ahead = () => {
    const want = new Set();
    const frames = new Set();
    const vids = new Set();
    let spineAt = -1;
    let l2dAt = -1;
    let lines = 0;
    for (let j = e.cursor; j < e.data.steps.length && want.size < AHEAD; j++) {
      const s = e.data.steps[j];
      if (isStop(s)) lines++;
      if (isStop(s) && want.size >= 2) break;
      if (s.k === 'pic' && s.i >= 0 && s.i !== e.pic) want.add(s.i);
      else if (s.k === 'anim') for (const i of s.f) frames.add(i);
      else if (s.k === 'vid' && lines < 2) for (const v of s.v) vids.add(v.f);
      // Набор Spine, что понадобится в ближайших двух репликах и ещё не на экране: подгружаем в кэш, не разбирая
      else if (s.k === 'spine' && !s.off && lines < 2 && spineAt < 0 && ![...e.spine.values()].some((x) => x.k === 'spine' && x.s === s.s)) spineAt = s.s;
      else if (s.k === 'l2d' && !s.off && lines < 2 && l2dAt < 0 && ![...e.spine.values()].some((x) => x.k === 'l2d' && x.s === s.s)) l2dAt = s.s;
    }
    if (spineAt >= 0) ui.warm(spineAt);
    if (l2dAt >= 0) ui.warmL2d(l2dAt);
    for (const i of [...want, ...frames]) if (!e.asked.has(i)) { e.asked.add(i); e.queue.push(i); }
    pump();
    preload([...vids]);
  };
  const pump = () => {
    while (e.loading < AHEAD_AT_ONCE && e.queue.length) {
      const i = e.queue.shift();
      const img = new Image();
      e.loading++;
      e.flight.add(i);
      const done = (ok) => {
        e.loading--;
        e.flight.delete(i);
        (ok ? e.loaded : e.bad).add(i);
        for (const wake of e.res.get(i) || []) wake();
        e.res.delete(i);
        pump();
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = imageUrl(game, e.data.files[i]);
    }
  };
  const frameReady = (i) => (e.loaded.has(i) || e.bad.has(i) ? Promise.resolve() : new Promise((wake) => e.res.set(i, [...(e.res.get(i) || []), wake])));

  // --- Анимация плагина под репликами. Кадры пишем прямо в две картинки поверх неподвижной (их вешает окно: attach), а не
  // через состояние React — кадров десятки в секунду
  const animOff = () => {
    e.animUp = false;
    for (const el of [e.cur, e.old]) if (el) { el.removeAttribute('src'); el.style.transition = ''; el.style.opacity = ''; }
    ui.anim(false);
  };
  const halt = () => {
    if (e.anim) clearTimeout(e.anim.timer);
    e.anim = null;
    e.animToken++;
    for (const list of Object.values(e.pool)) for (const el of list) el.pause();
  };
  // Звук кадра: не больше POOL одновременно на файл, дальше — перезапуск самого старого
  const chirp = (sd) => {
    if (!audible()) return;
    const list = e.pool[sd.f] || (e.pool[sd.f] = []);
    let el = list.find((x) => x.paused || x.ended);
    if (!el && list.length < POOL) { el = new Audio(audioUrl(game, sd.f)); list.push(el); }
    if (!el) { el = list.shift(); list.push(el); }
    el.volume = volume(sd.vol);
    el.playbackRate = rate(sd.pitch);
    try { el.currentTime = 0; } catch { /* ещё не загружен */ }
    el.play().catch(() => {});
  };
  // Кадр k: на второй картинке остаётся прежний и гаснет за x кадров игры (плавная смена, как в плагине)
  const put = (a, k, cross) => {
    const { cur, old } = e;
    if (!cur) return;
    const src = imageUrl(game, e.data.files[a.s.f[k]]);
    const x = cross ? a.s.x?.[k] || 0 : 0;
    if (x >= CROSS_MIN && old && cur.getAttribute('src')) {
      old.style.transition = 'none';
      old.src = cur.getAttribute('src');
      old.style.opacity = '1';
      cur.src = src;
      old.getBoundingClientRect();
      old.style.transition = `opacity ${(x * 1000) / 60 / live.speed}ms linear`;
      old.style.opacity = '0';
    } else {
      cur.src = src;
      if (old) { old.style.transition = 'none'; old.style.opacity = '0'; }
    }
  };
  const frame = (a, p) => {
    if (e.anim !== a) return;
    const k = a.ok[p];
    put(a, k, a.at >= 0);
    a.at = p;
    if (a.s.s && !live.still) for (const sd of a.s.s) if (sd.t >= a.cum[k] && sd.t < a.cum[k] + a.s.d[k]) chirp(sd);
    const last = p === a.ok.length - 1;
    // Один раз — последний кадр так и стоит; по кругу — с кадра r (разгон играет один раз)
    if (last && !a.s.loop) { a.next = -1; return; }
    a.next = last ? Math.max(0, a.ok.findIndex((q) => q >= (a.s.r || 0))) : p + 1;
    a.timer = setTimeout(() => tick(a), Math.max(ANIM_MIN_MS, (a.s.d[k] * 1000) / 60 / live.speed));
  };
  // Скрыто (H): кадры стоят, пока не вернут (refresh)
  const tick = (a) => {
    a.timer = 0;
    if (e.anim === a && !live.hidden) frame(a, a.next);
  };
  const beginAnim = (s, key) => {
    const ok = s.f.map((f, k) => k).filter((k) => !e.bad.has(s.f[k]));
    // Ни один кадр не загрузился — остаётся картинка
    if (!ok.length || !e.cur) return;
    let t = 0;
    const a = { s, key, ok, cum: s.d.map((d) => (t += d) - d), at: -1, next: -1, timer: 0 };
    e.anim = a;
    e.animUp = true;
    // «Меньше движения»: один кадр — первый кадр круга или последний у разового
    frame(a, live.still ? (s.loop ? Math.max(0, ok.findIndex((q) => q >= (s.r || 0))) : ok.length - 1) : 0);
    if (live.still) { clearTimeout(a.timer); a.timer = 0; a.next = -1; }
    // Неподвижную картинку прячем, когда первый кадр уже нарисован
    Promise.resolve(e.cur.decode?.()).catch(() => {}).then(() => { if (e.anim === a) ui.anim(true); });
  };
  const startAnim = (s) => {
    const key = JSON.stringify([s.f, s.d, s.loop, s.r, s.x]);
    if (s.loop && e.anim && e.anim.key === key) return;
    halt();
    const token = e.animToken;
    // Кадры — вперёд очереди: анимацию сцены не задерживает то, что грузится заранее
    const need = [...new Set(s.f)].filter((i) => !e.loaded.has(i) && !e.bad.has(i));
    for (const i of need) e.asked.add(i);
    e.queue = [...need.filter((i) => !e.flight.has(i)), ...e.queue.filter((i) => !need.includes(i))];
    pump();
    Promise.all(need.map(frameReady)).then(() => { if (token === e.animToken) beginAnim(s, key); });
  };
  // --- Ролики. Слои <video> лежат в рамке экрана игры (e.box): положение и размер — в долях рамки, поэтому ролик и картинка
  // под ним сходятся при любом размере окна. Запускаются без звука и «внутри страницы» (iOS не открывает их на весь экран);
  // звук включается, когда он разрешён и браузер даёт, и при нажатии
  const vidRate = (L) => Math.max(0.25, Math.min(4, ((L.v.rate || 100) / 100) * live.speed));
  const hear = (L) => {
    const el = L.el;
    el.playbackRate = vidRate(L);
    if (!audible() || L.skip || !((L.v.vol ?? 100) > 0)) { el.muted = true; return; }
    el.volume = Math.max(0, Math.min(1, (L.v.vol ?? 100) / 100));
    if (!el.muted) return;
    el.muted = false;
    // Без касания браузер звук не даёт: остановит ролик или откажет — играем дальше без звука
    const mute = () => { el.muted = true; if (!L.v.pause) el.play().catch(() => {}); };
    if (!L.v.pause) el.play().catch(mute);
    setTimeout(() => { if (el.paused && !el.ended && !L.v.pause && e.vids.get(L.v.s) === L) mute(); }, 250);
  };
  const place = (L) => {
    const { el, v } = L;
    const css = el.style;
    const sw = e.data?.screen?.w || 816;
    const sh = e.data?.screen?.h || 624;
    if (v.fit) { Object.assign(css, { left: '0', top: '0', width: '100%', height: '100%', objectFit: 'contain' }); return; }
    // Размер — после loadedmetadata; до него слой скрыт
    if (!el.videoWidth) return;
    const pic = v.s[0] === 'p';
    const zx = pic ? v.zx ?? 100 : 100;
    const zy = pic ? v.zy ?? 100 : 100;
    const w = (el.videoWidth * Math.abs(zx)) / 100;
    const h = (el.videoHeight * Math.abs(zy)) / 100;
    css.left = `${((v.x - (v.o ? w / 2 : 0)) / sw) * 100}%`;
    css.top = `${((v.y - (v.o ? h / 2 : 0)) / sh) * 100}%`;
    css.width = `${(w / sw) * 100}%`;
    css.height = `${(h / sh) * 100}%`;
    css.transform = zx < 0 || zy < 0 ? `scale(${zx < 0 ? -1 : 1}, ${zy < 0 ? -1 : 1})` : '';
    css.opacity = pic ? String((v.op ?? 255) / 255) : '';
    css.mixBlendMode = pic ? blendOf(v.b) : '';
  };
  const kill = (L) => {
    if (L.old) kill(L.old);
    L.old = null;
    L.el.pause();
    L.el.removeAttribute('src');
    L.el.load();
    L.el.remove();
  };
  const destroyVids = () => {
    for (const L of e.vids.values()) kill(L);
    e.vids.clear();
    e.vidList = [];
    e.vidPend = null;
    e.vtoken++;
    ui.vidOn(false);
  };
  // Конец ролика: следующий по цепочке (nx) встаёт на его место; без «keep» кончившийся ролик гаснет
  const ended = (L) => {
    if (e.vids.get(L.v.s) !== L) return;
    if (L.v.nx) {
      const { nx, ...rest } = L.v;
      const next = newLayer({ ...rest, f: nx.f, loop: nx.loop, x: nx.x, y: nx.y }, e.box);
      next.of = L.of;
      next.old = L;
      e.vids.set(L.v.s, next);
      place(next);
      hear(next);
    } else if (!L.v.loop && !L.v.keep) L.el.style.visibility = 'hidden';
  };
  const newLayer = (v, box) => {
    const i = e.pre.findIndex((q) => q.f === v.f);
    const el = i >= 0 ? e.pre.splice(i, 1)[0].el : document.createElement('video');
    el.className = 'scene-vid';
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.autoplay = true;
    el.preload = 'auto';
    el.loop = !!v.loop;
    el.style.visibility = 'hidden';
    const L = { el, v, of: v.f, old: null, ready: null };
    L.ready = new Promise((done) => {
      let timer = 0;
      L.fin = () => { clearTimeout(timer); done(); };
      if (e.vbad.has(v.f)) { done(); return; }
      timer = setTimeout(L.fin, VID_LOAD);
      // Новый слой встал — прежний на этом месте убираем, без чёрного кадра между ними. Подгруженный заранее мог получить
      // кадр раньше: события «loadeddata» уже не будет
      const loaded = () => {
        el.style.visibility = '';
        if (L.old) { kill(L.old); L.old = null; }
        if (L.v.pause) el.pause();
        L.fin();
      };
      if (el.readyState >= 2) loaded(); else el.addEventListener('loadeddata', loaded, { once: true });
      el.addEventListener('error', () => { e.vbad.add(v.f); el.style.display = 'none'; if (L.old) { kill(L.old); L.old = null; } L.fin(); }, { once: true });
    });
    el.addEventListener('loadedmetadata', () => place(L));
    el.addEventListener('ended', () => ended(L));
    if (!el.getAttribute('src')) el.src = videoUrl(game, v.f);
    box.appendChild(el);
    el.play().catch(() => L.fin());
    return L;
  };
  // Ролики экрана по списку шага vid: тот же файл на том же месте не перезапускаем, а двигаем; новый — слоем, который
  // сменит прежний, когда загрузится; ушедшие снимаем. Прозрачный ролик над картинкой или другим роликом браузер без
  // прозрачности нарисовал бы чёрным квадратом — такой слой не показываем
  const applyVids = (list) => {
    e.vidList = list;
    const box = e.box;
    if (!box) return;
    const keep = new Set(list.map((v) => v.s));
    for (const [slot, L] of [...e.vids]) if (!keep.has(slot)) { kill(L); e.vids.delete(slot); }
    const pend = [];
    list.forEach((v, k) => {
      let L = e.vids.get(v.s);
      if (!L || L.of !== v.f) {
        const had = L;
        L = newLayer(v, box);
        L.old = had || null;
        e.vids.set(v.s, L);
        pend.push(L.ready);
      } else {
        L.v = v;
        L.el.loop = !!v.loop;
        if (v.pause && !L.el.paused) L.el.pause();
        else if (!v.pause && L.el.paused && !L.el.ended) L.el.play().catch(() => {});
      }
      L.skip = !!v.a && !e.alpha && (e.pic >= 0 || e.animUp || k > 0);
      L.el.style.zIndex = String(k);
      L.el.style.display = L.skip || e.vbad.has(v.f) ? 'none' : '';
      place(L);
      hear(L);
    });
    e.vidPend = Promise.all(pend);
    ui.vidOn(list.length > 0);
  };
  // Игра ждёт конца ролика (vwait): до «ended»; по кругу — до конца текущего круга. Запас — таймер (в нём же нажатие
  // пропускает ожидание): длина неизвестна — 8 с, не число — 6 с; ошибка ролика ожидание кончает
  const waitVideo = (L, gen) => {
    const el = L.el;
    const tok = e.vtoken;
    const off = () => { el.removeEventListener('ended', over); el.removeEventListener('error', over); el.removeEventListener('loadedmetadata', arm); el.removeEventListener('durationchange', arm); };
    const over = () => { off(); if (tok === e.vtoken && gen === e.gen && e.timer) { clearTimeout(e.timer); go(gen); } };
    const arm = () => {
      clearTimeout(e.timer);
      const d = el.duration;
      const ms = el.readyState < 1 ? VID_UNKNOWN : !Number.isFinite(d) ? 6000 : ((Math.max(0, d - el.currentTime) / vidRate(L)) + (L.v.loop ? 0.3 : 1.5)) * 1000;
      e.timer = setTimeout(over, ms);
    };
    el.addEventListener('ended', over);
    el.addEventListener('error', over);
    el.addEventListener('loadedmetadata', arm);
    el.addEventListener('durationchange', arm);
    arm();
  };
  // Ролики, что понадобятся в ближайших двух репликах: невидимые, без звука; слой берёт готовый, когда подойдёт его шаг
  const preload = (list) => {
    e.pre = e.pre.filter((q) => { if (list.includes(q.f)) return true; q.el.removeAttribute('src'); q.el.load(); return false; });
    for (const f of list) {
      if (e.pre.length >= PRELOAD) break;
      if (e.pre.some((q) => q.f === f) || e.vbad.has(f) || [...e.vids.values()].some((L) => L.of === f)) continue;
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.src = videoUrl(game, f);
      e.pre.push({ f, el });
    }
  };
  // Затемнение: слой над картинкой и под текстом; переход — столько же, сколько в игре
  const fade = (s) => {
    e.dark = !!s.o;
    if (!s.o) e.darkStops = 0;
    ui.fade({ o: s.o ? 1 : 0, c: s.c, ms: (Math.max(0, s.n || 0) * 1000) / 60 / live.speed });
  };

  // Картинку ждём не дольше 6 с: склейка, которая не получается, не замораживает плеер
  // Ролики — тоже, но каждый ждёт первый кадр не дольше VID_LOAD
  // Врезку Spine — тоже, но при пропуске её не ждём: реплики уходят, холст догонит
  const settled = () => Promise.race([Promise.all([e.pending, e.vidPend, live.skip ? null : e.spinePend]), new Promise((done) => setTimeout(done, 6000))]);
  // Остановить голос: тот, что звучит, и голоса по кругу
  const hush = () => {
    if (e.voice) { e.voice.pause(); e.shots.delete(e.voice); e.voice = null; }
    for (const kind of Object.keys(e.want)) if (kind.startsWith('vloop')) stopLoop(kind, 0);
  };
  const apply = (s) => {
    if (s.k === 'pic') { halt(); if (s.i < 0) clearPic(); else show(s.i, s.box); }
    else if (s.k === 'anim') startAnim(s);
    else if (s.k === 'vid') applyVids(s.v);
    else if (s.k === 'spine' || s.k === 'l2d') {
      if (s.off) e.spine.delete(s.id); else e.spine.set(s.id, s);
      e.spinePend = ui.spine(new Map(e.spine), false);
    }
    else if (s.k === 'snd') {
      if (LOOPED(s)) { e.want[slotOf(s)] = s; loop(slotOf(s)); } else if (s.kind === 'me') jingle(s); else shot(s);
    } else if (s.k === 'stop') { if (s.kind === 'voice') hush(); else stopLoop(s.kind, s.fade); }
    else if (s.k === 'fx') { if (s.t === 'fade') fade(s); else ui.fx(s, live.speed); }
  };

  // Шаги до ближайшей реплики; пауза события — таймером (нажатие её пропускает)
  const go = (gen) => {
    if (gen !== e.gen) return;
    e.timer = 0;
    e.vtoken++;
    const { steps } = e.data;
    while (e.cursor < steps.length) {
      const at = e.cursor++;
      const s = steps[at];
      if (s.k === 'vwait') {
        const L = e.vids.get(s.s);
        if (!L || e.vbad.has(L.of)) continue;
        waitVideo(L, gen);
        return;
      }
      if (s.k === 'wait') {
        e.timer = setTimeout(() => go(gen), (Math.min(s.n / 60, MAX_WAIT) * 1000) / live.speed);
        return;
      }
      if (isStop(s)) {
        e.at = at;
        // Экран остался чёрным на много реплик подряд — возврат потерялся: светлеем сами
        if (e.dark && ++e.darkStops > DARK_STOPS) fade({ o: 0, n: 18 });
        ahead();
        // Реплику читаем, когда картинка встала: язык могли сменить, пока она грузилась (retext), и старый текст не вернётся
        settled().then(() => { if (gen === e.gen) { e.shown = at; ui.setLine(e.data.steps[at], e.stops.indexOf(at)); } });
        return;
      }
      apply(s);
    }
    e.at = steps.length;
    settled().then(() => { if (gen === e.gen) ui.setEnd(); });
  };
  const run = () => { e.shown = -1; ui.clear(); go(++e.gen); };

  const api = {
    start(data) {
      e.data = data;
      e.stops = data.steps.map((s, i) => (isStop(s) ? i : -1)).filter((i) => i >= 0);
      e.cursor = 0;
      e.loaded = new Set();
      e.bad = new Set();
      e.dark = false;
      e.darkStops = 0;
      e.dead = false;
      // Прежние слои Spine и Live2D (язык сменили, шаги не совпали — сцена с начала) убираем
      if (e.spine.size) ui.spine(new Map(), true);
      e.spine = new Map();
      e.spinePend = null;
      destroyVids();
      e.vbad = new Set();
      alphaOk().then((ok) => { if (ok && !e.alpha && !e.dead) { e.alpha = true; if (e.vidList.length) applyVids(e.vidList); } });
      // Повторы цикла: пары rep 1 … rep 0, могут вкладываться
      e.regions = [];
      const open = [];
      data.steps.forEach((s, i) => { if (s.k === 'rep') { if (s.o) open.push(i); else if (open.length) e.regions.push([open.pop(), i]); } });
      animOff();
      ahead();
      run();
    },
    // Язык текста сменили: шаги те же, а текст другой — подменяем его на месте, картинка, музыка и место остаются. Шаги
    // не совпали (сцену пересобрали) — сцена с начала
    retext(d) {
      const old = e.data;
      if (old && d.steps.length === old.steps.length && d.steps.every((s, i) => s.k === old.steps[i].k)) {
        e.data = { ...old, steps: d.steps };
        if (e.shown === e.at && e.at < d.steps.length) ui.setLine(d.steps[e.at], e.stops.indexOf(e.at));
        return;
      }
      api.silence();
      e.pic = -1;
      e.want = {};
      e.asked = new Set();
      e.queue = [];
      api.start(d);
    },
    // Дальше: пауза — пропустить; иначе следующая реплика
    next() {
      if (!e.data) return;
      if (e.timer) {
        clearTimeout(e.timer);
        // Пауза внутри повторов цикла: одно нажатие — к концу самых внешних повторов; остаётся последняя картинка или
        // анимация и музыка, одиночные звуки и вспышки пропускаем
        const at = e.cursor - 1;
        const region = e.regions.filter(([from, to]) => from < at && at < to).sort((x, y) => x[0] - y[0])[0];
        if (region) {
          let pic = -1;
          let anim = -1;
          for (let j = e.cursor; j < region[1]; j++) {
            const s = e.data.steps[j];
            if (s.k === 'pic') { pic = j; anim = -1; } else if (s.k === 'anim') anim = j;
            else if ((s.k === 'snd' && LOOPED(s)) || s.k === 'stop') apply(s);
          }
          if (pic >= 0) apply(e.data.steps[pic]);
          if (anim >= 0) apply(e.data.steps[anim]);
          e.cursor = region[1] + 1;
        }
        go(e.gen);
        return;
      }
      if (e.at >= e.data.steps.length) return;
      run();
    },
    // Назад: состояние перед предыдущей репликой собираем заново (картинка, музыка), дальше сцена идёт как обычно
    prev() {
      if (!e.data) return;
      const k = Math.max(0, (e.at >= e.data.steps.length ? e.stops.length : e.stops.indexOf(e.at)) - 1);
      api.silence();
      e.pic = -1;
      e.want = {};
      const from = k > 0 ? e.stops[k - 1] + 1 : 0;
      let pic = -1;
      let box;
      let anim = null;
      let dark = null;
      let tint = null;
      let vids = [];
      const spine = new Map();
      for (let j = 0; j < from; j++) {
        const s = e.data.steps[j];
        if (s.k === 'pic') { pic = s.i < 0 ? -2 : s.i; box = s.box; anim = null; }
        else if (s.k === 'spine' || s.k === 'l2d') { if (s.off) spine.delete(s.id); else spine.set(s.id, s); }
        else if (s.k === 'anim') anim = s;
        else if (s.k === 'vid') vids = s.v;
        else if (s.k === 'fx' && s.t === 'fade') dark = s.o ? s : null;
        else if (s.k === 'snd' && LOOPED(s)) e.want[slotOf(s)] = s;
        else if (s.k === 'stop' && s.kind === 'voice') { for (const kind of Object.keys(e.want)) if (kind.startsWith('vloop')) e.want[kind] = null; }
        else if (s.k === 'stop') e.want[s.kind] = null;
        else if (s.k === 'fx' && s.t === 'tint') tint = s;
      }
      if (pic >= 0) show(pic, box); else { e.pic = pic; ui.setPic(pic); if (!anim) animOff(); }
      if (anim) startAnim(anim);
      // Врезки Spine и Live2D — какими были к этой реплике: прыжком, слой с тем же запуском играет дальше
      const had = e.spine.size > 0;
      e.spine = spine;
      e.spinePend = had || spine.size ? ui.spine(new Map(spine), true) : null;
      // Ролики — каким был список к этой реплике; начинаются с начала
      destroyVids();
      if (vids.length) applyVids(vids);
      // Затемнение — каким было к этой реплике, сразу, без перехода
      e.dark = !!dark;
      e.darkStops = 0;
      ui.fade(dark ? { o: 1, c: dark.c, ms: 0 } : { o: 0, ms: 0 });
      // Тон экрана — тот, что стоял к этой реплике, сразу, без перехода
      ui.fx(tint ? { ...tint, n: 0 } : { k: 'fx', t: 'tint', c: [0, 0, 0, 0], n: 0 }, 1);
      loopAll();
      e.cursor = from;
      run();
    },
    // Громкость и скрытие (H) поменялись: музыка играет или молчит, одиночные звуки при молчании обрываем
    refresh() {
      loopAll();
      if (!audible()) { for (const el of e.shots) el.pause(); for (const list of Object.values(e.pool)) for (const el of list) el.pause(); }
      for (const L of e.vids.values()) hear(L);
      // Вернули (H): анимация идёт дальше с того кадра, где встала
      const a = e.anim;
      if (a && !a.timer && a.next >= 0 && !live.hidden && !live.still) frame(a, a.next);
    },
    // Нажатие человека — повод запустить то, что браузер не дал запустить сам
    // Ролик, который браузер остановил (экономия заряда) или оставил без звука, тоже пробуем запустить
    resume() {
      if (audible()) loopAll();
      for (const L of e.vids.values()) {
        hear(L);
        if (L.el.paused && !L.el.ended && !L.v.pause) L.el.play().catch(() => {});
      }
    },
    silence() {
      clearTimeout(e.timer);
      e.timer = 0;
      for (const t of e.fades) clearInterval(t);
      e.fades.clear();
      for (const el of e.shots) el.pause();
      e.shots.clear();
      e.voice = null;
      e.meOn = false;
      for (const el of Object.values(e.loops)) el.pause();
      halt();
    },
    dispose() {
      e.gen++;
      e.dead = true;
      e.queue = [];
      api.silence();
      destroyVids();
      for (const q of e.pre) { q.el.removeAttribute('src'); q.el.load(); }
      e.pre = [];
      for (const el of Object.values(e.loops)) { el.removeAttribute('src'); el.load(); }
      e.loops = {};
      e.want = {};
      for (const list of Object.values(e.pool)) for (const el of list) { el.removeAttribute('src'); el.load(); }
      e.pool = {};
    },
    // Две картинки анимации поверх неподвижной и рамка для роликов: окно вешает их сюда
    attach(cur, old, box) { e.cur = cur; e.old = old; e.box = box; },
    voice: () => e.voice,
    spineMap: () => new Map(e.spine),
    // Сцена стоит на паузе события или ждёт конец ролика (next() их пропускает), а не грузит картинку реплики
    pausing: () => !!e.timer,
    stopsCount: () => e.stops.length,
  };
  return api;
}

// n — номер сцены у альбома со сценами-гостями (album.scenes); у остальных 0. title — название строки списка (вкладки
// «Сцены» и «Диалоги»); onNext — «Смотреть подряд»: после конца сцены — следующая из списка, а не закрытие
const SceneView = ({ game, t, album, n = 0, title = '', speed, hidden, auto0 = false, onAuto = null, onNext = null, onClose }) => {
  const s = t.scene;
  const sceneUrl = (pick) => `/api/gallery/${encodeURIComponent(game.id)}/scene?key=${encodeURIComponent(album.key)}&n=${n}&ui=${encodeURIComponent(t.lang_id)}${pick ? `&lang=${encodeURIComponent(pick)}` : ''}`;
  const rootRef = useRef(null);
  const [data, setData] = useState(null);       // { files, steps }; false — не открылось
  const [pic, setPic] = useState(-1);
  const [picBox, setPicBox] = useState(null);   // прямоугольник экрана игры, который занимает показанная картинка (шаг pic, box)
  // Врезки Spine: компонент грузим, только когда у сцены есть наборы. null — ещё грузится, false — файл не открылся (реплики
  // идут без врезок). hold.wait — кто ждёт холст, пока он не встал
  const [Spine, setSpine] = useState(null);
  const [L2D, setL2D] = useState(null);         // то же для моделей Live2D (SceneLive2D)
  const makeHold = () => ({
    handle: null, failed: false, wait: [],
    bind(h) { this.handle = h; },
    fail() { this.failed = true; },
    release() { for (const done of this.wait.splice(0)) done(); },
    sync(map, jump) { return this.handle ? this.handle.sync(map, jump) : this.failed ? Promise.resolve() : new Promise((done) => this.wait.push(done)); },
    warm(i) { this.handle?.warm(i); },
  });
  const [hold] = useState(makeHold);
  const [holdL2d] = useState(makeHold);
  const spineRef = useRef(null);
  const l2dRef = useRef(null);
  const [line, setLine] = useState(null);       // { step, no } — реплика или выбор на экране
  const [ended, setEnded] = useState(false);
  const [typed, setTyped] = useState(0);
  const [auto, setAuto] = useState(auto0);
  useEffect(() => { onAuto?.(auto); }, [auto]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pace, setPace] = useState(readAutoPace);
  // Пропуск: пока держат Ctrl (как в играх) или включён кнопкой (на телефоне Ctrl нет)
  const [skipHeld, setSkipHeld] = useState(false);
  const [skipOn, setSkipOn] = useState(false);
  const skip = skipHeld || skipOn;
  const [noText, setNoText] = useState(false);
  const [sound, setSound] = useState(readSceneSound);
  const [langs, setLangs] = useState(null);     // варианты языка текста этой сцены (от двух) или null
  const [lang, setLang] = useState('');         // выбранный код (у оригинала — его настоящий код)
  const asked = useRef(0);                      // номер последнего запроса: ответ на прежний не нужен
  // Эффекты экрана: вспышка и тряска — разовые (n — новый номер, чтобы та же вспышка подряд сыграла снова), тон — держится
  const [flash, setFlash] = useState(null);
  const [shake, setShake] = useState(null);
  const [tint, setTint] = useState(null);
  const [dark, setDark] = useState(null);       // затемнение: { o — прозрачность, c — цвет, ms — переход }
  const [animOn, setAnimOn] = useState(false);  // поверх неподвижной картинки идёт анимация
  const [vidOn, setVidOn] = useState(false);    // на экране есть ролик: тусклый первый кадр не нужен
  const stageRef = useRef(null);
  const screenRef = useRef(null);               // рамка экрана игры: в неё двигатель кладёт ролики
  const animRef = useRef(null);
  const oldRef = useRef(null);
  // «Меньше движения»: реплика появляется целиком, анимация — одним кадром
  const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // Что двигателю знать о текущем окне: звук, скорость, скрытие (H) — он живёт вне React и читает это при каждом звуке
  const [live] = useState(() => ({ sound, speed, hidden, still }));
  useEffect(() => { Object.assign(live, { sound, speed: skip ? speed * SKIP_SPEED : speed, hidden, still, skip }); });
  const [eng] = useState(() => createEngine(game.id, live, {
    setPic: (i, box) => { setPic(i); setPicBox(box || null); },
    // Слои двух видов лежат в одном списке двигателя; каждый холст получает свои. Пустой список холсту, которого нет, не нужен
    spine: (map, jump) => Promise.all([[hold, 'spine'], [holdL2d, 'l2d']].map(([h, k]) => {
      const part = new Map([...map].filter(([, x]) => x.k === k));
      return part.size || h.handle ? h.sync(part, jump) : Promise.resolve();
    })),
    warm: (i) => hold.warm(i),
    warmL2d: (i) => holdL2d.warm(i),
    anim: setAnimOn,
    vidOn: setVidOn,
    fade: setDark,
    setLine: (step, no) => { setEnded(false); setTyped(0); setLine({ step, no }); },
    setEnd: () => { setLine(null); setEnded(true); },
    clear: () => { setLine(null); setEnded(false); },
    fx: (s, speed) => {
      const ms = (Math.max(0, s.n || 0) * 1000) / 60 / speed;
      if (s.t === 'tint') setTint({ c: s.c, ms });
      else if (s.t === 'flash') setFlash((f) => ({ c: s.c, ms: Math.max(ms, 50), n: (f?.n || 0) + 1 }));
      else if (s.t === 'shake') setShake((f) => ({ p: s.p, s: s.s, ms: Math.max(ms, 50), n: (f?.n || 0) + 1 }));
    },
  }));

  useEffect(() => {
    let alive = true;
    const my = ++asked.current;
    fetch(sceneUrl(readSceneLang(game.id)))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        if (d?.steps?.length) { setLangs(d.langs || null); setLang(d.lang || ''); setData(d); eng.start(d); } else setData(false);
      }, () => { if (alive) setData(false); });
    return () => { alive = false; asked.current = my + 1; eng.dispose(); };
  }, [game.id, album.key, n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { eng.attach(animRef.current, oldRef.current, screenRef.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Файл врезок — отдельным куском, и только если они есть. Не открылся (заблокирован, сеть) — сцена играет без них
  const wantSpine = !!data?.spines?.length;
  useEffect(() => {
    if (!wantSpine) return undefined;
    let alive = true;
    import('./SceneSpine').then((m) => { if (alive) setSpine(() => m.default); }, () => { if (alive) setSpine(false); });
    return () => { alive = false; };
  }, [wantSpine]);
  const wantL2d = !!data?.l2ds?.length;
  useEffect(() => {
    if (!wantL2d) return undefined;
    let alive = true;
    import('./SceneLive2D').then((m) => { if (alive) setL2D(() => m.default); }, () => { if (alive) setL2D(false); });
    return () => { alive = false; };
  }, [wantL2d]);
  // Холст встал (или не будет): реплики, что ждали его, идут дальше
  useEffect(() => {
    if (Spine === null) return;
    hold.bind(spineRef.current);
    if (Spine === false) hold.fail();
    Promise.resolve(Spine && spineRef.current?.ready?.()).then(() => hold.release());
  }, [Spine]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (L2D === null) return;
    holdL2d.bind(l2dRef.current);
    if (L2D === false) holdL2d.fail();
    Promise.resolve(L2D && l2dRef.current?.ready?.()).then(() => holdL2d.release());
  }, [L2D]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { eng.refresh(); }, [sound, hidden, speed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Выбрали язык текста: запоминаем для игры и берём те же шаги с новым текстом. Не вышло — язык в списке прежний
  const codeOf = (o) => (o.orig ? 'orig' : o.code);
  const choose = (value) => {
    const before = lang;
    const my = ++asked.current;
    setLang(langs.find((o) => codeOf(o) === value)?.code || before);
    fetch(sceneUrl(value))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (my !== asked.current) return;
        if (!d?.steps?.length) { setLang(before); return; }
        writeSceneLang(game.id, value);
        eng.retext(d);
        setData(d);
        setLangs(d.langs || null);
        setLang(d.lang || '');
      }, () => { if (my === asked.current) setLang(before); });
  };

  const text = line?.step.k === 'say' ? Array.from(line.step.text) : [];
  // Реплика печатается; «меньше движения» и пропуск — сразу целиком
  const whole = still || skip;
  const typing = text.length > 0 && !whole && typed < text.length;
  useEffect(() => {
    if (!line || line.step.k !== 'say' || still || !typing) return undefined;
    const timer = setInterval(() => setTyped((n) => Math.min(text.length, n + Math.max(1, Math.round(TYPE_CPS / 20)))), 50);
    return () => clearInterval(timer);
  }, [line, typing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Тряска как в игре: размах — сила, ход туда и обратно — 80 кадров игры / скорость
  useEffect(() => {
    const el = stageRef.current;
    if (!shake || still || !el?.animate) return undefined;
    const d = Math.min(24, shake.p * 2.5);
    const cycle = Math.max(60, 1333 / Math.max(1, shake.s));
    const a = el.animate([{ transform: 'none' }, { transform: `translateX(${d}px)` }, { transform: `translateX(${-d}px)` }, { transform: 'none' }], { duration: cycle, iterations: Math.max(1, Math.round(shake.ms / cycle)) });
    return () => a.cancel();
  }, [shake]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => {
    eng.resume();
    if (ended) { (onNext || onClose)(); return; }
    if (typing) { setTyped(text.length); return; }
    eng.next();
  };
  const prev = () => { eng.resume(); eng.prev(); };
  // Язык по кругу (L): по выбранному в списке, а не по пришедшему — быстрые нажатия идут друг за другом
  const nextLang = () => {
    const at = langs.findIndex((o) => o.code === lang);
    choose(codeOf(langs[(at + 1) % langs.length]));
  };

  // Авто: после голоса (если он играет) или через время по длине реплики — как авто-текст в игре; темп (pace) человек
  // выбирает сам. Пока идёт пропуск, листает он
  const waiting = !!line && !typing;
  useEffect(() => {
    if (!auto || skip || !waiting) return undefined;
    const voice = eng.voice();
    if (voice && !voice.paused && !voice.ended) {
      let timer = 0;
      const after = () => { timer = setTimeout(() => eng.next(), (700 * pace) / speed); };
      voice.addEventListener('ended', after);
      voice.addEventListener('error', after);
      return () => { clearTimeout(timer); voice.removeEventListener('ended', after); voice.removeEventListener('error', after); };
    }
    const len = line.step.k === 'say' ? text.length : 20;
    const timer = setTimeout(() => eng.next(), (Math.max(1500, Math.min(9000, 1000 + len * 60)) * pace) / speed);
    return () => clearTimeout(timer);
  }, [auto, skip, waiting, line, pace]); // eslint-disable-line react-hooks/exhaustive-deps

  // Пропуск: реплика сразу целиком и через такт (SKIP_MS) следующая; между репликами паузу события и конец ролика не ждём,
  // а картинку реплики — ждём: иначе реплики уходили бы невидимыми. На конце сцены встаёт: дальше — нажатием, как в «Авто».
  // Такт идёт и без реплики на экране (после next() её нет, пока не встала следующая), поэтому реплику берём из ref
  const lineRef = useRef(null);
  useEffect(() => { lineRef.current = line; }, [line]);
  useEffect(() => {
    if (!skip || ended) return undefined;
    // Ctrl — не жест для браузера: музыку и ролики, которые он не дал запустить, пробуем сейчас
    eng.resume();
    let seen = null;
    const timer = setInterval(() => {
      const l = lineRef.current;
      if (l ? l === seen : eng.pausing()) eng.next();
      seen = l;
    }, SKIP_MS);
    return () => clearInterval(timer);
  }, [skip, ended]); // eslint-disable-line react-hooks/exhaustive-deps

  // Клавиши: пробел, Enter, → — дальше; ← — назад; A — авто, V — без текста, M — звук; Ctrl держать — пропуск (как в игре)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Control') { setSkipHeld(true); return; }
      // Клавиша без Ctrl — значит, его отпустили, а keyup не пришёл (меню по Ctrl+клику на Mac): пропуск встаёт
      if (!e.ctrlKey) setSkipHeld(false);
      // Выбор в панели (BarChoose): в его списке стрелки, пробел и Enter — списку; на самой кнопке ему только Enter и
      // стрелка вниз (открыть), пробел листает реплику, как везде; Esc и буквы — плееру
      const inEl = e.target instanceof Element ? e.target : null;
      if (inEl?.closest('.scene-pick') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(e.key)) return;
      if (inEl?.closest('.bar-choose') && ['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Буквы — по коду клавиши: на русской раскладке «A» приходит как «ф»
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'enter' || k === 'arrowright') { if (!e.repeat) next(); }
      else if (k === 'arrowleft') prev();
      else if (e.code === 'KeyA') setAuto((v) => !v);
      else if (e.code === 'KeyV') setNoText((v) => !v);
      else if (e.code === 'KeyM') setSound((v) => { writeSound(!v); return !v; });
      // Пока открыт список языков, L его не трогает: иначе текст сменился бы, а строка в списке осталась старой
      else if (e.code === 'KeyL' && langs) { if (!e.repeat && !document.querySelector('.scene-pick')) nextLang(); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });
  // Ctrl отпустили — пропуск встаёт, а реплика на экране остаётся целиком, не печатается заново с середины; окно ушло из
  // фокуса или вкладку спрятали с зажатым Ctrl (Ctrl+Tab) — отпускания не будет, встаёт тоже
  useEffect(() => {
    const onUp = (e) => {
      // Пробел на кнопке BarChoose листает реплику (keydown выше); отпускание не должно «нажать» кнопку и открыть список
      if (e.key === ' ' && e.target instanceof Element && e.target.closest('.bar-choose')) e.preventDefault();
      if (e.key === 'Control') { setSkipHeld(false); setTyped(Infinity); } };
    const onBlur = () => setSkipHeld(false);
    document.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onBlur);
    return () => { document.removeEventListener('keyup', onUp, true); window.removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', onBlur); };
  }, []);
  useLayer(rootRef, onClose, { focus: 'self' });

  const tool = (fn) => (e) => { e.stopPropagation(); e.currentTarget.blur(); eng.resume(); fn(); };
  // Скрытие (H) — как «паника»: текст прячется вместе с картинкой
  const showText = !noText && !hidden;
  // Тон экрана игры (красный, зелёный, синий от −255 до 255 и серость): «плюс» — осветлением цветом, «минус» — затемнением
  // каналов; переход — столько же, сколько в игре
  const tc = tint?.c || [0, 0, 0, 0];
  const lift = `rgb(${tc.slice(0, 3).map((v) => Math.max(0, v)).join(',')})`;
  const dim = `rgb(${tc.slice(0, 3).map((v) => 255 + Math.min(0, v)).join(',')})`;
  const tintMove = { transition: `background-color ${tint?.ms || 0}ms linear` };
  const stage = { filter: tc[3] > 0 ? `grayscale(${Math.min(1, tc[3] / 255)})` : undefined, transition: `filter ${tint?.ms || 0}ms linear` };
  const total = data ? data.steps.filter((x) => x.k === 'say' || x.k === 'choice').length : 0;
  const origLang = langs?.find((o) => o.orig)?.code;
  const textLang = lang && lang !== origLang ? lang : undefined;
  // Название варианта: язык его же буквами; оригинал и перевод Mimikin помечены, неполный — долей реплик сцены
  const langLabel = (o) => {
    const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    const name = o.code === 'orig' ? cap(s.original) : languageTitle(o.code, o.code);
    const mark = o.orig ? (o.code === 'orig' ? '' : `, ${s.original}`) : o.mt ? `, ${s.mt}` : '';
    const part = !o.orig && total && o.n / total < 0.9 ? `, ${new Intl.NumberFormat(t.lang_id, { style: 'percent' }).format(o.n / total)}` : '';
    return name + mark + part;
  };
  const firstPic = data ? data.steps.find((x) => x.k === 'pic' && x.i >= 0)?.i : undefined;
  return (
    <div ref={rootRef} className="scene" role="dialog" aria-modal="true" aria-label={title || album.scenes?.[n]?.t || s.title} tabIndex={-1} onClick={next}
      onPointerDown={(e) => { if (!e.ctrlKey) setSkipHeld(false); }}>
      {/* Тряска — сцена целиком (картинка и тон), вспышка — поверх; без них, если человек просил меньше движения */}
      <div ref={stageRef} className={`scene-stage${animOn ? ' animating' : ''}`} style={stage}>
        {data && pic >= 0 && <img className="scene-pic" src={imageUrl(game.id, data.files[pic])} alt="" draggable={false} />}
        {/* Анимация: два слоя, кадры им пишет двигатель (src — не из React); второй держит прежний кадр, пока он гаснет */}
        <img ref={animRef} className="scene-pic scene-anim" alt="" draggable={false} />
        <img ref={oldRef} className="scene-pic scene-anim" alt="" draggable={false} />
        {/* Сцена начинается с реплик на карте, а CG ещё не показана: тускло — первый кадр, не чёрный экран */}
        {data && pic === -1 && !vidOn && firstPic !== undefined && <img className="scene-pic scene-dim" src={imageUrl(game.id, data.files[firstPic])} alt="" draggable={false} />}
        {/* Рамка экрана игры: ролики кладёт двигатель (положение в долях рамки), поверх картинок и тусклого кадра */}
        {/* Врезка Spine: один холст поверх картинок, под роликами и тоном; место — по картинке на экране игры */}
        {wantSpine && Spine && <Spine ref={spineRef} game={game} spines={data.spines} steps={data.steps} screen={data.screen} rect={pic >= 0 ? picBox || [0, 0, data.screen?.w || 816, data.screen?.h || 624] : null} speed={skip ? speed * SKIP_SPEED : speed} initial={() => new Map([...eng.spineMap()].filter(([, x]) => x.k === 'spine'))} />}
        {/* Модели Live2D: свой холст рядом; место — по картинке на экране игры, а без картинки — по экрану игры */}
        {wantL2d && L2D && <L2D ref={l2dRef} game={game} l2ds={data.l2ds} screen={data.screen} rect={pic >= 0 ? picBox || [0, 0, data.screen?.w || 816, data.screen?.h || 624] : null} speed={skip ? speed * SKIP_SPEED : speed} initial={() => new Map([...eng.spineMap()].filter(([, x]) => x.k === 'l2d'))} />}
        <div ref={screenRef} className="scene-screen" style={{ '--sw': data?.screen?.w || 816, '--sh': data?.screen?.h || 624 }} />
        <div className="scene-tint scene-tint-lift" style={{ ...tintMove, backgroundColor: lift }} />
        <div className="scene-tint scene-tint-dim" style={{ ...tintMove, backgroundColor: dim }} />
      </div>
      {flash && !still && <div key={flash.n} className="scene-flash" style={{ backgroundColor: `rgb(${flash.c.slice(0, 3).join(',')})`, '--flash': Math.min(1, (flash.c[3] ?? 255) / 255), animationDuration: `${flash.ms}ms` }} />}
      {/* Затемнение — над картинкой и вспышкой, под текстом: реплики под чёрным читаются */}
      <div className="scene-fade" style={{ opacity: dark?.o ?? 0, transition: `opacity ${dark?.ms ?? 0}ms linear`, ...(dark?.c ? { backgroundColor: `rgb(${dark.c.slice(0, 3).join(',')})` } : {}) }} />
      {data === null && <p className="scene-note">{s.loading}</p>}
      {data === false && <p className="scene-note">{s.failed}</p>}
      {/* Рамка и панель — одним столбцом снизу: на телефоне панель в три ряда не закрывает реплику */}
      <div className="scene-ui">
      {showText && line?.step.k === 'say' && (
        <div className="scene-box" data-testid="scene-box">
          {line.step.who && <div className="scene-who">{line.step.who}</div>}
          <p className="scene-text" lang={textLang}>{text.slice(0, whole ? text.length : typed).join('')}<span className="scene-rest">{text.slice(whole ? text.length : typed).join('')}</span></p>
        </div>
      )}
      {showText && line?.step.k === 'choice' && (
        <div className="scene-box" data-testid="scene-box">
          <ul className="scene-choices" lang={textLang}>
            {line.step.o.map((o, i) => <li key={i} className={i === line.step.i ? 'taken' : ''}>{o}</li>)}
          </ul>
        </div>
      )}
      {showText && ended && <div className="scene-box"><p className="scene-text scene-end">{s.end}</p></div>}
      <div className="scene-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="gallery-play" onClick={tool(prev)} aria-label={s.prev} data-tip={s.prev}><IconChevronLeft /></button>
        <button type="button" className="gallery-play" onClick={tool(next)} aria-label={s.next} data-tip={s.next}><IconChevronRight /></button>
        <span className="scene-pos">{line ? `${line.no + 1} / ${total}` : ended ? `${total} / ${total}` : ''}</span>
        <button type="button" className="gallery-play" aria-pressed={auto} onClick={tool(() => setAuto((v) => !v))} data-tip={s.auto_hint}>{auto ? <IconPause /> : <IconPlay />} {s.auto}</button>
        {/* Темп «Авто» — рядом с ним, пока оно включено: сколько времени дать на чтение реплики */}
        {auto && (
          <BarChoose className="scene-pace" label={s.pace} value={pace} options={AUTO_PACES.map((v, i) => ({ value: v, label: s.paces[i] }))}
            onChange={(v) => { setPace(v); writeAutoPace(v); }} />
        )}
        <button type="button" className="gallery-play" aria-pressed={skip} onClick={tool(() => { if (skipOn) setTyped(Infinity); setSkipOn(!skipOn); })} data-tip={s.skip_hint}><IconSkip /> {s.skip}</button>
        <button type="button" className="gallery-play" aria-pressed={noText} onClick={tool(() => setNoText((v) => !v))}>{s.no_text}</button>
        <button type="button" className="gallery-play" aria-pressed={sound} onClick={tool(() => setSound((v) => { writeSound(!v); return !v; }))} aria-label={sound ? s.sound_off : s.sound_on} data-tip={sound ? s.sound_off : s.sound_on}>
          {sound ? <IconSound /> : <IconMute />}
        </button>
        {langs && (
          <BarChoose label={`${s.lang} (L)`} value={codeOf(langs.find((o) => o.code === lang) || langs[0])}
            options={langs.map((o) => ({ value: codeOf(o), label: langLabel(o) }))} onChange={choose} />
        )}
        <button type="button" className="gallery-play" onClick={tool(onClose)} aria-label={s.close} data-tip={s.close}><IconClose /></button>
      </div>
      </div>
    </div>
  );
};

export default SceneView;
