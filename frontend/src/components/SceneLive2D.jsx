import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { live2dUrl, loadModel, patchMasks } from './live2dLoad';

// Модели Live2D в плеере сцены (шаги l2d): один холст PIXI на сцену поверх картинки и под тоном экрана — рядом с SceneSpine, тем же
// способом: плеер (SceneView) пишет сюда состояние слоёв — sync(слои, прыжок) — и ждёт ответа внутри settled(). Лениво: у игры без
// Live2D ни этот файл, ни pixi, ни библиотека не грузятся. Ядро Cubism берётся из папки самой игры (live2dLoad.js). Любой сбой
// (модель не открылась, нет WebGL, потерян контекст) прячет модель, а реплики, звук и картинки идут дальше
const FIT = 0.96;           // доля сцены, которую занимает модель в режиме «вписать»
const PIC_SHARE = 0.5;      // какая часть модели должна быть на сцене, чтобы класть её по месту в игре; иначе — вписать

// На телефоне лист текстур модели — десятки мегабайт видеопамяти: держим одну модель, самую новую
const oneAtATime = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; } };

const SceneLive2D = forwardRef(function SceneLive2D({ game, l2ds, screen, rect, speed, initial }, ref) {
  const host = useRef(null);
  // Всё живое — вне React: слои и холст не должны перерисовывать окно. now — свежие свойства для эффектов и ответов
  const me = useRef({ app: null, layers: new Map(), token: 0, chain: Promise.resolve(), dead: false, failed: false, warmed: new Set(), now: {} }).current;
  useEffect(() => { me.now = { game, l2ds, screen, rect, speed }; });

  // Место каждой модели: игровые пиксели (at) → сцена, как у картинки (она вписана в сцену по contain, её прямоугольник в игре — rect;
  // без картинки — весь экран игры). У Live2DInterfaceMZ at — центр модели (c), у PictureLive2D — левый верхний угол холста
  const layout = () => {
    const el = host.current;
    if (!me.app || !el) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    if (!W || !H) return;
    if (me.app.renderer.width !== W || me.app.renderer.height !== H) me.app.renderer.resize(W, H);
    const { rect: rc, screen: sc } = me.now;
    const r = rc || [0, 0, sc?.w || 816, sc?.h || 624];
    for (const L of me.layers.values()) {
      const { model } = L;
      const ow = model.internalModel.originalWidth;
      const oh = model.internalModel.originalHeight;
      if (!ow || !oh) continue;
      const at = L.step.at;
      let anchor = L.step.c ? 0.5 : 0;
      let x = 0, y = 0, sx = 1, sy = 1;
      let placed = false;
      if (at && r[2] > 0 && r[3] > 0) {
        const k = Math.min(W / r[2], H / r[3]);
        x = (W - r[2] * k) / 2 + (at[0] - r[0]) * k;
        y = (H - r[3] * k) / 2 + (at[1] - r[1]) * k;
        sx = at[2] * k;
        sy = at[3] * k;
        const w = ow * Math.abs(sx), h = oh * Math.abs(sy);
        const x0 = x - anchor * w, y0 = y - anchor * h;
        const inside = Math.max(0, Math.min(x0 + w, W) - Math.max(x0, 0)) * Math.max(0, Math.min(y0 + h, H) - Math.max(y0, 0));
        placed = w * h > 0 && inside / (w * h) >= PIC_SHARE;
      }
      if (!placed) {
        sx = sy = Math.min(W / ow, H / oh) * FIT;
        anchor = 0.5;
        x = W / 2;
        y = H / 2;
      }
      model.anchor.set(anchor, anchor);
      model.scale.set(sx, sy);
      L.target = [x, y];
      if (!L.mv) model.position.set(x, y);
      model.visible = !L.step.hide;
    }
  };

  // Кадр холста: переезд (pos с dur в игре), потом обновление моделей. Модели не на авто-обновлении: у слоя своя скорость (ts)
  const tick = () => {
    const now = performance.now();
    for (const L of me.layers.values()) {
      if (L.mv && L.target) {
        const t = Math.min(1, (now - L.mv.t0) / L.mv.ms);
        L.model.position.set(L.mv.x + (L.target[0] - L.mv.x) * t, L.mv.y + (L.target[1] - L.mv.y) * t);
        if (t >= 1) L.mv = null;
      }
      try { L.model.update(me.app.ticker.deltaMS * (L.step.ts || 1)); } catch { /* кадр пропускаем */ }
    }
  };

  const ensureApp = async () => {
    if (me.app || me.failed) return;
    try {
      const PIXI = await import('pixi.js');
      if (me.dead || me.app) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      me.app = new PIXI.Application({ backgroundAlpha: 0, antialias: dpr < 2, resolution: dpr, autoDensity: true, width: host.current.clientWidth || 800, height: host.current.clientHeight || 600 });
      // Касание проходит сквозь холст (pointer-events: none в стиле): реплика листается как обычно
      host.current.appendChild(me.app.view);
      me.app.view.addEventListener('webglcontextlost', (e) => { e.preventDefault(); me.failed = true; if (host.current) host.current.style.display = 'none'; });
      me.app.ticker.speed = me.now.speed || 1;
      me.app.ticker.add(tick);
    } catch { me.failed = true; me.app = null; }
  };

  const destroyModel = (L) => {
    L.gone = true;
    try { L.mm.off('motionFinish', L.onFinish); L.model.parent?.removeChild(L.model); L.model.destroy({ children: true, texture: true, baseTexture: true }); } catch { /* уже убрана */ }
  };
  const removeLayer = (id) => {
    const L = me.layers.get(id);
    if (!L) return;
    destroyModel(L);
    me.layers.delete(id);
  };

  // Выражение шага (e — имя): запуск движения сбрасывает выражение, поэтому после play оно ставится заново
  const express = (L) => {
    const e = L.step.e ? L.l2d.exps.indexOf(L.step.e) : -1;
    if (e >= 0) return L.model.expression(e).catch(() => {});
    L.mm.expressionManager?.resetExpression();
    return undefined;
  };
  // Движения идут цепочкой: [имя, группа, номер] — первое играет, остальные — по окончании предыдущего; повтор — у последнего.
  // Библиотека повтор не читает из файла: включаем у самого движения до запуска
  const start = async (L, list) => {
    const mine = ++L.run;
    const [, group, i] = list[0];
    L.queue = list.slice(1);
    const motion = await L.mm.loadMotion(group, i).catch(() => null);
    if (L.gone || mine !== L.run || !motion) return;
    motion.setIsLoop(!L.queue.length && L.loop);
    L.cur = motion;
    await L.model.motion(group, i, L.priority).catch(() => {});
    if (!L.gone && mine === L.run) await express(L);
  };
  const play = (L, step, jump) => {
    const list = (step.a || []).map((n) => L.l2d.motions.find((m) => m[0] === n)).filter((m) => m && m[2] >= 0);
    L.loop = !!step.loop;
    if (!list.length) { L.run++; L.queue = []; L.mm.stopAllMotions(); return; }
    // Очередь (q): текущий круг доигрывается, дальше идут новые движения; при прыжке (назад) — сразу и без очереди
    if (!jump && step.q && !L.mm.isFinished()) {
      L.cur?.setIsLoop(false);
      L.queue = [...L.queue, ...list];
      return;
    }
    start(L, list);
  };

  const addLayer = async (step) => {
    const l2d = me.now.l2ds[step.s];
    if (!l2d) return null;
    const loaded = await loadModel(me.now.game.id, l2d, me.app, () => me.dead);
    if (!loaded) return null;
    const { model, lib } = loaded;
    patchMasks(model);
    model.autoUpdate = false;
    model.visible = false;
    me.app.stage.addChild(model);
    const L = { model, l2d, step, key: '', run: 0, queue: [], loop: true, cur: null, gone: false, mv: null, target: null, mm: model.internalModel.motionManager, priority: lib.MotionPriority.FORCE };
    L.onFinish = () => { if (!L.gone && L.queue.length) start(L, L.queue); };
    L.mm.on('motionFinish', L.onFinish);
    return L;
  };

  // Слои плеера → холст. Ответ приходит, когда нужные модели загружены (или не открылись); новый вызов отменяет старый
  const sync = (map, jump) => {
    const token = ++me.token;
    const job = async () => {
      if (token !== me.token || me.dead) return;
      let want = new Map(map);
      if (oneAtATime() && want.size > 1) want = new Map([[...want][want.size - 1]]);
      for (const id of [...me.layers.keys()]) if (!want.has(id)) removeLayer(id);
      if (!want.size) return;
      await ensureApp();
      if (token !== me.token || me.dead || !me.app || me.failed) return;
      for (const [id, step] of want) {
        let L = me.layers.get(id);
        if (L && L.step.s !== step.s) { removeLayer(id); L = null; }
        if (!L) {
          L = await addLayer(step).catch(() => null);
          if (!L) continue;
          if (token !== me.token || me.dead) { destroyModel(L); return; }
          me.layers.set(id, L);
        }
        // Переезд за d кадров игры: едет из прежнего места, если оно было и это не прыжок
        const moved = L.step.at && step.at && (L.step.at[0] !== step.at[0] || L.step.at[1] !== step.at[1]);
        L.mv = !jump && step.d && moved ? { x: L.model.x, y: L.model.y, t0: performance.now(), ms: (step.d * 1000) / 60 / (me.now.speed || 1) } : null;
        const key = `${step.s}:${step.t}`;
        const expChanged = L.step.e !== step.e;
        L.step = step;
        if (L.key !== key) { L.key = key; play(L, step, jump); } else if (expChanged) express(L);
        L.model.alpha = (step.op ?? 255) / 255;
      }
      layout();
    };
    me.chain = me.chain.then(job, job).catch(() => {});
    return me.chain;
  };

  // Подгрузка заранее: ядро и описание модели попадают в кэш браузера. Модель — та, что понадобится в ближайших репликах
  const warm = (i) => {
    const l2d = me.now.l2ds[i];
    if (!l2d || me.warmed.has(i)) return;
    me.warmed.add(i);
    for (const rel of [l2d.core, l2d.model]) fetch(live2dUrl(me.now.game.id, rel)).catch(() => {});
  };

  useImperativeHandle(ref, () => ({ sync, warm, ready: () => me.first }));

  // Плеер мог начать до того, как этот файл загрузился: берём состояние слоёв, каким оно уже стало
  useEffect(() => {
    me.dead = false;
    me.first = sync(initial ? initial() : new Map(), false);
    const watch = new ResizeObserver(layout);
    if (host.current) watch.observe(host.current);
    return () => {
      me.dead = true;
      me.token++;
      watch.disconnect();
      for (const id of [...me.layers.keys()]) removeLayer(id);
      // Холст целиком — вместе с текстурами и контекстом WebGL: их в браузере считаные штуки
      if (me.app) { try { me.app.destroy(true, { children: true, texture: true, baseTexture: true }); } catch { /* контекст уже потерян */ } me.app = null; }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Картинка под моделью сменилась или размер сцены — модель встаёт по новому месту; скорость — всему холсту
  useEffect(() => { layout(); }, [rect, screen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (me.app) me.app.ticker.speed = speed; }, [speed]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className="scene-spine" />;
});

export default SceneLive2D;
