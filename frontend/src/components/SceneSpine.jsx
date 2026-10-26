import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { loadSet, spineUrl } from './spineLoad';

// Врезки Spine в плеере сцены (шаги spine): один холст PIXI на сцену поверх картинки и под тоном экрана. Плеер (SceneView) пишет
// сюда состояние слоёв — sync(слои, прыжок) — и ждёт ответа внутри settled(). Лениво: у игры без Spine ни этот файл, ни pixi
// не грузятся. Любой сбой (набор не открылся, нет WebGL, потерян контекст) прячет врезку, а реплики, звук и картинки идут дальше
const SAMPLES = 12;         // отсчётов анимации для границ набора
const FIT = 0.96;           // доля сцены, которую занимает врезка в режиме «вписать»
const PIC_SHARE = 0.5;      // какая часть врезки должна быть на сцене, чтобы класть её по месту картинки; иначе — вписать

const SceneSpine = forwardRef(function SceneSpine({ game, spines, steps, screen, rect, speed, initial }, ref) {
  const host = useRef(null);
  // Всё живое — вне React: слои, наборы и холст не должны перерисовывать окно. now — свежие свойства для эффектов и ответов
  const me = useRef({ app: null, PIXI: null, layers: new Map(), sets: new Map(), token: 0, dead: false, failed: false, warmed: new Set(), now: {} }).current;
  useEffect(() => { me.now = { game, spines, steps, screen, rect, speed }; });

  // Положение и размер каждого слоя: по месту картинки на экране игры (at → rect показанной картинки) или вписано
  const layout = () => {
    const el = host.current;
    if (!me.app || !el) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    if (!W || !H) return;
    if (me.app.renderer.width !== W || me.app.renderer.height !== H) me.app.renderer.resize(W, H);
    const { rect: r } = me.now;
    for (const L of me.layers.values()) {
      const b = L.set.fit;
      if (!b || !b.width || !b.height) continue;
      const at = L.step.at;
      let pic = false;
      let px = 0, py = 0, sx = 1, sy = 1;
      if (at && r && r[2] > 0 && r[3] > 0) {
        // Картинка сидит в сцене по contain: её прямоугольник в игре r вписан в сцену, масштаб k — пикселей сцены на пиксель игры
        const k = Math.min(W / r[2], H / r[3]);
        px = (W - r[2] * k) / 2 + (at[0] - r[0]) * k;
        py = (H - r[3] * k) / 2 + (at[1] - r[1]) * k;
        sx = at[2] * k;
        sy = at[3] * k;
        const x0 = px + Math.min(b.x * sx, (b.x + b.width) * sx), x1 = px + Math.max(b.x * sx, (b.x + b.width) * sx);
        const y0 = py + Math.min(b.y * sy, (b.y + b.height) * sy), y1 = py + Math.max(b.y * sy, (b.y + b.height) * sy);
        const inside = Math.max(0, Math.min(x1, W) - Math.max(x0, 0)) * Math.max(0, Math.min(y1, H) - Math.max(y0, 0));
        pic = (x1 - x0) * (y1 - y0) > 0 && inside / ((x1 - x0) * (y1 - y0)) >= PIC_SHARE;
      }
      if (!pic) {
        const k = Math.min(W / b.width, H / b.height) * FIT;
        sx = k;
        sy = k;
        px = W / 2 - (b.x + b.width / 2) * k;
        py = H / 2 - (b.y + b.height / 2) * k;
      }
      L.spine.position.set(px, py);
      L.spine.scale.set(sx, sy);
    }
  };

  // Набор по номеру в spines: файлы читаем один раз; граница «вписать» — объединение всех анимаций, что сцена на нём играет
  const getSet = (i) => {
    let p = me.sets.get(i);
    if (p) return p;
    const sp = me.now.spines[i];
    p = sp ? loadSet(me.now.game.id, sp, () => me.dead).then((s) => {
      if (!s || me.dead) { s?.atlas.dispose(); return null; }
      const { rt, json, atlas } = s;
      const data = new rt.SkeletonJson(new rt.AtlasAttachmentLoader(atlas)).readSkeletonData(json);
      const used = new Set(me.now.steps.filter((x) => x.k === 'spine' && !x.off && x.s === i).flatMap((x) => x.a));
      const tmp = new rt.Spine(data);
      tmp.autoUpdate = false;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of used) {
        const a = data.findAnimation(n);
        if (!a) continue;
        tmp.state.clearTracks();
        tmp.skeleton.setToSetupPose();
        tmp.state.setAnimation(0, n, true);
        for (let k = 0; k < SAMPLES; k++) {
          tmp.update(a.duration / SAMPLES || 0);
          const b = tmp.getLocalBounds();
          if (!b.width || !b.height) continue;
          x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
        }
      }
      if (!(x1 > x0)) { tmp.state.clearTracks(); tmp.skeleton.setToSetupPose(); tmp.update(0); const b = tmp.getLocalBounds(); x0 = b.x; y0 = b.y; x1 = b.x + b.width; y1 = b.y + b.height; }
      try { tmp.destroy({ children: true }); } catch { /* временный — не жалко */ }
      return { rt, atlas, data, PIXI: s.PIXI, fit: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    }).catch(() => null) : Promise.resolve(null);
    me.sets.set(i, p);
    return p;
  };

  // Слою — анимации шага: список с очередью (q) или заново; скин, скорость, прозрачность, скрытие
  const play = (L, step, jump) => {
    const { spine } = L;
    const data = spine.skeleton.data;
    let names = (step.a || []).filter((n) => data.findAnimation(n));
    let loop = !!step.loop;
    // Имени нет в скелете — играет первая анимация по кругу
    if (!names.length) { if (!data.animations.length) return; names = [data.animations[0].name]; loop = true; }
    if (step.skin?.length) {
      try {
        const rt = L.set.rt;
        const skin = typeof rt.Skin === 'function' ? new rt.Skin('scene') : null;
        if (skin && typeof skin.addSkin === 'function') {
          for (const n of step.skin) { const one = data.findSkin(n); if (one) skin.addSkin(one); }
          spine.skeleton.setSkin(skin);
        } else spine.skeleton.setSkinByName(step.skin[0]);
        spine.skeleton.setSlotsToSetupPose();
      } catch { /* скина нет — остаётся прежний */ }
    }
    const ats = step.ats || [];
    const last = names.length - 1;
    // Очередь (q): текущий круг доигрывается, дальше идут новые анимации; при прыжке (назад) — сразу и без очереди
    const cur = spine.state.tracks[0];
    const queued = !jump && step.q && cur;
    if (queued) cur.loop = false;
    names.forEach((n, i) => {
      const entry = queued || i > 0 ? spine.state.addAnimation(0, n, i === last && loop, 0) : spine.state.setAnimation(0, n, names.length === 1 && loop);
      if (entry && ats[i]) entry.timeScale = ats[i];
    });
    spine.state.timeScale = (step.ts || 1) * me.now.speed;
    spine.alpha = (step.op ?? 255) / 255;
    spine.visible = !step.hide;
  };

  const ensureApp = (PIXI) => {
    if (me.app || me.failed) return;
    try {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      me.app = new PIXI.Application({ backgroundAlpha: 0, antialias: dpr < 2, resolution: dpr, autoDensity: true, width: host.current.clientWidth || 800, height: host.current.clientHeight || 600 });
      me.PIXI = PIXI;
      // Касание проходит сквозь холст (pointer-events: none в стиле): реплика листается как обычно
      host.current.appendChild(me.app.view);
      me.app.view.addEventListener('webglcontextlost', (e) => { e.preventDefault(); me.failed = true; if (host.current) host.current.style.display = 'none'; });
    } catch { me.failed = true; me.app = null; }
  };

  const removeLayer = (id) => {
    const L = me.layers.get(id);
    if (!L) return;
    try { L.spine.parent?.removeChild(L.spine); L.spine.destroy({ children: true }); } catch { /* уже убран */ }
    me.layers.delete(id);
  };

  // Слои плеера → холст. Ответ приходит, когда нужные наборы загружены (или не открылись); новый вызов отменяет старый
  const sync = (map, jump) => {
    const token = ++me.token;
    return (async () => {
      const want = new Map(map);
      for (const id of [...me.layers.keys()]) if (!want.has(id)) removeLayer(id);
      const sets = new Map();
      for (const step of want.values()) if (!sets.has(step.s)) sets.set(step.s, await getSet(step.s));
      if (token !== me.token || me.dead) return;
      const first = [...sets.values()].find(Boolean);
      if (first) ensureApp(first.PIXI);
      if (me.app && !me.failed) {
        for (const [id, step] of want) {
          const set = sets.get(step.s);
          let L = me.layers.get(id);
          if (L && L.step.s !== step.s) { removeLayer(id); L = null; }
          if (!set) continue;
          if (!L) {
            L = { spine: new set.rt.Spine(set.data), set, step, key: '' };
            me.app.stage.addChild(L.spine);
            me.layers.set(id, L);
          }
          const key = `${step.s}:${step.t}`;
          L.step = step;
          if (L.key !== key) { L.key = key; play(L, step, jump); } else {
            // Тот же запуск: меняются только скорость, прозрачность и скрытие
            L.spine.state.timeScale = (step.ts || 1) * me.now.speed;
            L.spine.alpha = (step.op ?? 255) / 255;
            L.spine.visible = !step.hide;
          }
        }
        layout();
      }
      // Набор, на котором слоёв не осталось, освобождаем: на телефоне большие атласы по нескольку страниц
      const inUse = new Set([...me.layers.values()].map((L) => L.step.s));
      for (const [i, p] of [...me.sets]) {
        if (inUse.has(i)) continue;
        me.sets.delete(i);
        p.then((s) => { try { s?.atlas.dispose(); } catch { /* уже освобождён */ } });
      }
    })().catch(() => {});
  };

  // Подгрузка заранее без разбора в память: адреса попадают в кэш браузера. Набор — тот, что понадобится в ближайших репликах
  const warm = (i) => {
    const sp = me.now.spines[i];
    if (!sp || me.sets.has(i) || me.warmed.has(i)) return;
    me.warmed.add(i);
    for (const rel of [sp.atlas, sp.skeleton, ...sp.pages]) fetch(spineUrl(me.now.game.id, rel)).catch(() => {});
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
      for (const p of me.sets.values()) p.then((s) => { try { s?.atlas.dispose(); } catch { /* уже освобождён */ } });
      me.sets.clear();
      if (me.app) { try { me.app.destroy(true, { children: true, texture: true, baseTexture: true }); } catch { /* контекст уже потерян */ } me.app = null; }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Картинка под врезкой сменилась или размер сцены — врезка встаёт по новому месту; скорость — всем слоям
  useEffect(() => { layout(); }, [rect, screen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { for (const L of me.layers.values()) L.spine.state.timeScale = (L.step.ts || 1) * speed; }, [speed]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className="scene-spine" />;
});

export default SceneSpine;
