import { useEffect, useRef } from 'react';
import { readSpineCover } from '../galleryView';
import { loadModel, patchMasks } from './live2dLoad';
import { placeModel, snapshot, saveRigCover, destroyApp } from './rigCapture';

// Проигрыватель модели Live2D для галереи: движение из файла «модель.model3.json#имя» идёт по кругу, по центру и целиком.
// Как SpineView: компонент грузят лениво (GameGallery.jsx), pixi и библиотека подтягиваются только здесь. Один холст на
// модель и закрытие его целиком — контекстов WebGL в браузере считаные штуки, на телефоне ещё меньше
const filterBlur = 'blur(18px) brightness(0.55) saturate(0.7)';

export default function Live2DView({ game, album, file, speed = 1, hidden = false, loop = true, exp = -1, onClick, onFail }) {
  const box = useRef(null);
  const live = useRef(null); // { app, play, expression, layout } — то, что нужно другим эффектам
  const l2d = album.live2d;
  const name = file.slice(l2d.model.length + 1);
  // Эффект ниже стартует один раз на альбом, а движение, повтор и выражение успевают сменить, пока грузятся файлы: берём свежие
  const now = useRef({ name, speed, loop, exp });
  useEffect(() => { now.current = { name, speed, loop, exp }; });
  const fail = useRef(onFail);
  useEffect(() => { fail.current = onFail; });

  useEffect(() => {
    let dead = false;
    let app = null;
    let model = null;
    (async () => {
      try {
        const PIXI = await import('pixi.js');
        if (dead) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        app = new PIXI.Application({ backgroundAlpha: 0, antialias: dpr < 2, resolution: dpr, autoDensity: true, width: box.current.clientWidth || 800, height: box.current.clientHeight || 600 });
        box.current.appendChild(app.view);
        const loaded = await loadModel(game.id, l2d, app, () => dead);
        if (!loaded) return;
        model = loaded.model;
        const { MotionPriority } = loaded.lib;
        const inner = model.internalModel;
        patchMasks(model);
        app.stage.addChild(model);
        // Рисуется «холст» модели из редактора (originalWidth/Height), а не обрезанный рисунок: вписываем его целиком
        const layout = () => {
          if (!box.current) return;
          const w = box.current.clientWidth, h = box.current.clientHeight;
          if (!w || !h) return;
          placeModel(model, app, w, h);
        };
        // Выражение: -1 — без него. Запуск движения сбрасывает выражение (библиотека), поэтому после play оно ставится заново
        const expression = () => {
          const e = now.current.exp;
          if (e >= 0) return model.expression(e).catch(() => {});
          inner.motionManager.expressionManager?.resetExpression();
          return undefined;
        };
        let token = 0;
        const play = async () => {
          const mine = ++token;
          const mo = l2d.motions.find((m) => m[0] === now.current.name);
          if (!mo || mo[2] < 0) { inner.motionManager.stopAllMotions(); await expression(); return; }
          // Повтор библиотека не читает ни из файла, ни из настроек — включаем у самого движения до запуска
          const motion = await inner.motionManager.loadMotion(mo[1], mo[2]);
          if (dead || mine !== token) return;
          motion?.setIsLoop(now.current.loop);
          await model.motion(mo[1], mo[2], MotionPriority.FORCE);
          if (!dead && mine === token) await expression();
        };
        live.current = { app, play, expression, layout };
        app.ticker.speed = now.current.speed;
        layout();
        play();
        const watch = new ResizeObserver(layout);
        watch.observe(box.current);
        live.current.watch = watch;
        // Обложка плитки: кадр чуть после начала, уменьшенный. Сразу после render буфер WebGL ещё цел — его можно скопировать
        // без preserveDrawingBuffer. Лист текстуры (части тела вперемешку) обложкой не годится, как и атлас Spine
        if (!readSpineCover(game.id, album.key) && !album.rigCover) {
          live.current.snap = setTimeout(() => {
            if (dead) return;
            const url = snapshot(app);
            if (url) saveRigCover(game.id, album.key, url);
          }, 1500);
        }
      } catch { if (!dead) fail.current?.(); /* модель не открылась — пустое поле, листать можно */ }
    })();
    return () => {
      dead = true;
      clearTimeout(live.current?.snap);
      live.current?.watch?.disconnect();
      live.current = null;
      // Модель с текстурами и контекст WebGL освобождаем сразу: листают альбомы подряд
      // Ошибка при закрытии не должна ронять галерею: убираем модель со сцены до уничтожения, чтобы сцена не трогала её второй раз
      destroyApp(app, model);
    };
  }, [game.id, album.key, l2d, album.rigCover]);

  useEffect(() => { live.current?.play(); }, [name, loop]);
  useEffect(() => { live.current?.expression(); }, [exp]);
  useEffect(() => { if (live.current) live.current.app.ticker.speed = speed; }, [speed]);

  return (
    <div ref={box} className="gallery-spine" style={hidden ? { filter: filterBlur } : undefined} onClick={onClick} />
  );
}
