import { useEffect, useRef } from 'react';
import { writeSpineCover } from '../galleryView';

// Обложки плиток наборов Spine и моделей Live2D. Сервер их не рисует, поэтому кадр снимает браузер: при первом просмотре
// альбома (SpineView, Live2DView) или фоном, не дожидаясь просмотра (captureRig, useRigCovers). Снятое кладётся в браузер
// (galleryView.js) и уходит на сервер (saveRigCover) — на других устройствах плитка с картинкой сразу

export const rigCoverUrl = (gameId, key) => `/api/gallery/${encodeURIComponent(gameId)}/rig-cover?key=${encodeURIComponent(key)}`;

// Кадр сцены → JPEG-строка 320 px в ширину. Сразу после render буфер WebGL ещё цел — его можно скопировать без
// preserveDrawingBuffer. Пустой кадр (модель не успела нарисоваться) и почти чёрный (движение гасит свет: у части моделей
// первое движение ставит тень на всё тело) — null: такой кадр не должен стать обложкой, ему подберут другое движение
export function snapshot(app) {
  if (!app.view.width || !app.view.height) return null;
  app.renderer.render(app.stage);
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = Math.round(320 * app.view.height / app.view.width);
  const g = c.getContext('2d');
  g.drawImage(app.view, 0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-over';
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 12 || px[i + 1] > 12 || px[i + 2] > 12) lit++;
  if (lit < c.width * c.height * 0.02) return null;
  return c.toDataURL('image/jpeg', 0.7);
}

// Обложку — в браузер и на сервер (первая присланная там остаётся: PUT повторно ничего не меняет, кроме почти пустой — её заменяет полная). Ошибка сети не страшна
export function saveRigCover(gameId, key, dataUrl) {
  writeSpineCover(gameId, key, dataUrl);
  try {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    fetch(`/api/gallery/${encodeURIComponent(gameId)}/rig-cover?key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: bytes }).catch(() => {});
  } catch { /* не вышло — обложка осталась в этом браузере */ }
}

// Все кадры движения: границы считаем по нескольким отсчётам, а не по позе покоя — иначе рука, вылетающая за край, обрежется
const SAMPLES = 24;

// Запуск анимации anim у скелета с нуля и прямоугольник вокруг всех её отсчётов { x, y, width, height }; нет такой
// анимации — undefined, ничего не тронуто
export function playSpine(spine, anim) {
  const animation = spine.skeleton.data.findAnimation(anim);
  if (!animation) return undefined;
  spine.scale.set(1);
  spine.position.set(0, 0);
  spine.state.clearTracks();
  spine.skeleton.setToSetupPose();
  spine.state.setAnimation(0, anim, true);
  // Прогоняем анимацию вперёд, собирая общий прямоугольник, потом начинаем с нуля
  const scale = spine.state.timeScale;
  spine.state.timeScale = 1;
  spine.autoUpdate = false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    spine.update(animation.duration / SAMPLES || 0);
    const b = spine.getLocalBounds();
    if (!b.width || !b.height) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  spine.state.clearTracks();
  spine.skeleton.setToSetupPose();
  spine.state.setAnimation(0, anim, true);
  spine.update(0);
  spine.autoUpdate = true;
  spine.state.timeScale = scale;
  return x1 > x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : spine.getLocalBounds().clone();
}

// Скелет по центру окна w×h целиком (с полями 4 %)
export function placeSpine(spine, app, b, w, h) {
  app.renderer.resize(w, h);
  const k = Math.min(w / b.width, h / b.height) * 0.96;
  spine.scale.set(k);
  spine.x = w / 2 - (b.x + b.width / 2) * k;
  spine.y = h / 2 - (b.y + b.height / 2) * k;
}

// Рисуется «холст» модели из редактора (originalWidth/Height), а не обрезанный рисунок: вписываем его целиком
export function placeModel(model, app, w, h) {
  const inner = model.internalModel;
  app.renderer.resize(w, h);
  const k = Math.min(w / inner.originalWidth, h / inner.originalHeight) * 0.96;
  model.scale.set(k);
  model.x = (w - inner.originalWidth * k) / 2;
  model.y = (h - inner.originalHeight * k) / 2;
}

// Сцену и контекст WebGL освобождаем сразу: их в браузере считаные штуки (около 16)
export function destroyApp(app, model = null) {
  try { app?.stage.removeChild(model); model?.destroy({ children: true, texture: true, baseTexture: true }); } catch { /* осталась частично — контекст всё равно уйдёт */ }
  try { app?.destroy(true, { children: true, texture: true, baseTexture: true }); } catch { /* то же */ }
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Размер скрытого окна: того же вида 4:3, что у окна просмотра, но меньше — плитка 320 px, а память и время съёмки на телефоне дороги
const W = 480, H = 360;
// Сколько движений пробуем, пока кадр не получится непустым
const TRIES = 3;

// Снять обложку альбома album (набор Spine или модель Live2D) в скрытом окне: загрузить, поставить как в просмотре, подождать
// кадр после начала движения, снять и всё освободить. → JPEG-строка или null (закрыли, пустой кадр). Ошибка загрузки — исключение
export async function captureRig(gameId, album, isDead = () => false) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px;height:${H}px;pointer-events:none;overflow:hidden`;
  document.body.appendChild(host);
  let app = null;
  let model = null;
  try {
    if (album.spine) {
      // Загрузчики — по требованию: у игры без Spine и Live2D галерея их не тянет вовсе
      const { loadSet } = await import('./spineLoad');
      const set = await loadSet(gameId, album.spine, isDead);
      if (!set) return null;
      const { PIXI, rt, json, atlas } = set;
      if (isDead()) { atlas.dispose(); return null; }
      const spine = new rt.Spine(new rt.SkeletonJson(new rt.AtlasAttachmentLoader(atlas)).readSkeletonData(json));
      app = new PIXI.Application({ backgroundAlpha: 0, antialias: true, resolution: 1, width: W, height: H });
      host.appendChild(app.view);
      app.stage.addChild(spine);
      for (const f of album.files.slice(0, TRIES)) {
        const b = playSpine(spine, f.slice(album.spine.skeleton.length + 1));
        if (!b || !b.width || !b.height) continue;
        placeSpine(spine, app, b, W, H);
        await wait(700);
        if (isDead()) return null;
        const url = snapshot(app);
        if (url) return url;
      }
      return null;
    } else {
      const [PIXI, { loadModel, patchMasks }] = await Promise.all([import('pixi.js'), import('./live2dLoad')]);
      if (isDead()) return null;
      app = new PIXI.Application({ backgroundAlpha: 0, antialias: false, resolution: 1, width: W, height: H });
      host.appendChild(app.view);
      const l2d = album.live2d;
      const loaded = await loadModel(gameId, l2d, app, isDead);
      if (!loaded) return null;
      model = loaded.model;
      patchMasks(model);
      app.stage.addChild(model);
      placeModel(model, app, W, H);
      for (const f of album.files.slice(0, TRIES)) {
        const mo = l2d.motions.find((m) => m[0] === f.slice(l2d.model.length + 1));
        if (mo && mo[2] >= 0) await model.motion(mo[1], mo[2], loaded.lib.MotionPriority.FORCE).catch(() => {});
        await wait(1500);
        if (isDead()) return null;
        const url = snapshot(app);
        if (url) return url;
      }
      return null;
    }
  } finally {
    destroyApp(app, model);
    host.remove();
  }
}

// Не вышло в этом сеансе — повторно не пробуем (ключ игра/альбом)
const failed = new Set();

// Ждём, пока вкладка видна и браузер не занят, плюс пауза между кадрами: съёмка грузит главный поток на секунды,
// и без перерыва страница (чип «CG», прокрутка) отзывалась бы с задержкой. false — эффект закрыли
async function breathe(isDead) {
  await wait(1500);
  while (!isDead() && document.hidden) await wait(1000);
  if (isDead()) return false;
  await new Promise((ok) => (window.requestIdleCallback ? window.requestIdleCallback(ok, { timeout: 4000 }) : setTimeout(ok, 200)));
  return !isDead();
}

// Фоновая съёмка обложек: albums — наборы без обложки в видимом списке; по одному, с паузами, пока не paused (открыт
// просмотр или плеер сцены — там свой холст WebGL). Снято — onCover(key, dataUrl). Сбой одного не мешает остальным и галерее.
// Очередь читаем из ref на каждом шаге: снятая обложка убирает альбом из списка, и эффект не должен из-за этого
// перезапускаться — иначе начатая съёмка следующего бросалась бы и шла заново (лишние окна и контексты WebGL)
export function useRigCovers(gameId, albums, paused, onCover) {
  const cb = useRef(onCover);
  const queue = useRef(albums);
  useEffect(() => { cb.current = onCover; queue.current = albums; });
  const any = albums.some((a) => !failed.has(`${gameId}/${a.key}`));
  useEffect(() => {
    if (paused || !any) return undefined;
    let dead = false;
    const done = new Set();
    (async () => {
      let first = true;
      while (!dead) {
        const a = queue.current.find((x) => !failed.has(`${gameId}/${x.key}`) && !done.has(x.key));
        if (!a) { await wait(500); continue; }
        if (!first && !(await breathe(() => dead))) return;
        first = false;
        const id = `${gameId}/${a.key}`;
        try {
          const url = await captureRig(gameId, a, () => dead);
          if (dead) return;
          if (!url) { failed.add(id); continue; }
          done.add(a.key);
          saveRigCover(gameId, a.key, url);
          cb.current(a.key, url);
        } catch { if (!dead) failed.add(id); }
      }
    })();
    return () => { dead = true; };
  }, [gameId, paused, any]);
}
