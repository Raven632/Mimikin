import { useEffect, useRef } from 'react';
import { readSpineCover } from '../galleryView';
import { loadSet } from './spineLoad';
import { playSpine, placeSpine, snapshot, saveRigCover, destroyApp } from './rigCapture';

// Проигрыватель набора Spine для галереи: анимация из файла «скелет.json#имя» идёт по кругу, по центру и целиком.
// Библиотеки тяжёлые — компонент грузят лениво (GameGallery.jsx), а pixi подтягивается только здесь.
const filterBlur = 'blur(18px) brightness(0.55) saturate(0.7)';

export default function SpineView({ game, album, file, speed = 1, hidden = false, onClick }) {
  const box = useRef(null);
  const live = useRef(null); // { spine, layout } — то, что нужно другим эффектам
  const name = file.slice(album.spine.skeleton.length + 1);
  // Эффект ниже стартует один раз на альбом, а анимацию и скорость успевают сменить, пока грузятся файлы: берём свежие
  const now = useRef({ name, speed });
  useEffect(() => { now.current = { name, speed }; });

  // Сцена, WebGL и скелет — на альбом; смена анимации (стрелки) обходится без нового контекста WebGL
  useEffect(() => {
    let dead = false;
    let app = null;
    const sp = album.spine;
    (async () => {
      try {
        const set = await loadSet(game.id, sp, () => dead);
        if (!set) return;
        const { PIXI, rt, json, atlas } = set;
        if (dead) { atlas.dispose(); return; }
        const parser = new rt.SkeletonJson(new rt.AtlasAttachmentLoader(atlas));
        const spine = new rt.Spine(parser.readSkeletonData(json));
        app = new PIXI.Application({ backgroundAlpha: 0, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true, width: box.current.clientWidth || 800, height: box.current.clientHeight || 600 });
        box.current.appendChild(app.view);
        app.stage.addChild(spine);
        // Положение по границам: bounds — { x, y, width, height } вокруг всех отсчётов анимации
        const view = { bounds: null };
        const layout = () => {
          const b = view.bounds;
          if (!b || !b.width || !b.height || !box.current) return;
          placeSpine(spine, app, b, box.current.clientWidth, box.current.clientHeight);
        };
        const play = (anim) => {
          const b = playSpine(spine, anim);
          if (!b) return;
          view.bounds = b;
          layout();
        };
        live.current = { spine, play, layout };
        play(now.current.name);
        spine.state.timeScale = now.current.speed;
        const watch = new ResizeObserver(layout);
        watch.observe(box.current);
        live.current.watch = watch;
        // Обложка плитки: кадр чуть после начала (не поза покоя), уменьшенный. Сразу после render буфер WebGL ещё цел —
        // его можно скопировать без preserveDrawingBuffer
        if (!readSpineCover(game.id, album.key) && !album.rigCover) {
          live.current.snap = setTimeout(() => {
            if (dead) return;
            const url = snapshot(app);
            if (url) saveRigCover(game.id, album.key, url);
          }, 700);
        }
      } catch { /* набор не открылся — пустое поле, листать можно */ }
    })();
    return () => {
      dead = true;
      clearTimeout(live.current?.snap);
      live.current?.watch?.disconnect();
      live.current = null;
      // Контекст WebGL освобождаем сразу: их в браузере считаные штуки, а листают альбомы подряд
      destroyApp(app);
    };
  }, [game.id, album.key, album.spine, album.rigCover]);

  useEffect(() => { live.current?.play(name); }, [name]);
  useEffect(() => { if (live.current) live.current.spine.state.timeScale = speed; }, [speed]);

  return (
    <div ref={box} className="gallery-spine" style={hidden ? { filter: filterBlur } : undefined} onClick={onClick} />
  );
}
