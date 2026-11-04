import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { useCoversHidden } from '../coversHidden';
import { readSpeed, shuffled } from '../galleryView';
import StateView from './StateView';
import { IconClose, IconPlay } from './icons';

const GameGallery = lazy(() => import('./GameGallery'));
const SceneView = lazy(() => import('./SceneView'));
const url = (what, game, file) => `/api/gallery/${encodeURIComponent(game)}/${what}?f=${encodeURIComponent(file)}`;

// Кадр ленты. На весь экран телефона миниатюры мало, а полных картинок в ленте сотни: миниатюра грузится, когда кадр близко к
// экрану, и только после неё — полная. Размер до загрузки нужен всегда: кадр нулевой высоты браузер считает видимым и грузит все сразу
const FeedFrame = ({ game, frame, t, onOpen, onScene }) => {
  const [sharp, setSharp] = useState(false);
  const load = () => {
    if (sharp) return;
    const img = new Image();
    img.onload = () => setSharp(true);
    img.src = url('image', game, frame.file);
  };
  return (
    <div className="feed-frame">
      <button type="button" className="feed-open" onClick={() => onOpen(frame.file)}>
        <img src={url(sharp ? 'image' : 'thumb', game, frame.file)} alt="" loading="lazy" decoding="async" width={frame.w || 16} height={frame.h || 9} onLoad={load} />
      </button>
      {frame.scene && <button type="button" className="gallery-count play" onClick={() => onScene(frame)}><IconPlay /> {t.pics_scene}</button>}
    </div>
  );
};

// «Лента картинок»: игра за игрой, в случайном порядке, у каждой несколько разных рисунков (сервер: /api/pictures/feed). Игра —
// глава: название прилипает к верху, пока идут её кадры, поэтому лента не выглядит случайной смесью. Кадр открывает галерею игры
// на нём, там же «Похожие» и остальное; «Сцена» — плеер с этого кадра
const PictureFeed = ({ games, t, onClose }) => {
  const [list, setList] = useState(null);
  const [error, setError] = useState(false);
  const [off, setOff] = useState(false);      // разбор кадров выключен: новых в ленте не будет
  const [open, setOpen] = useState(null);     // { game, file } — открытая галерея
  const [scene, setScene] = useState(null);   // { game, file, key, n, title } — открытая сцена
  const [speed] = useState(readSpeed);
  const hidden = useCoversHidden();
  const rootRef = useRef(null);
  useLayer(rootRef, onClose);
  useEffect(() => {
    let alive = true;
    fetch('/api/pictures/feed')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) { setList(shuffled(d.games)); setOff(!!d.off); } }, () => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);
  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const shown = (list || []).filter((g) => byId.has(g.id));

  return createPortal(
    <div ref={rootRef} className={`gallery feed${hidden ? ' covers-hidden' : ''}`} role="dialog" aria-modal="true" aria-label={t.feed_title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      <div className="gallery-head">
        <h2>{t.feed_title}</h2>
        <button type="button" className="gallery-close" onClick={onClose} aria-label={t.close} data-tip={t.close}><IconClose /></button>
      </div>
      {error && <StateView kind="error" title={t.feed_error} />}
      {!error && !list && <StateView kind="loading" title={t.feed_title} />}
      {list && !shown.length && (off ? <StateView title={t.pics_off} hint={t.feed_off_hint} /> : <StateView title={t.feed_none} hint={t.feed_none_hint} />)}
      {shown.map((g) => {
        const name = byId.get(g.id).displayTitle || byId.get(g.id).title || g.id;
        const all = () => setOpen({ game: g.id, file: '' });
        return (
          <section key={g.id} className="feed-game">
            <button type="button" className="feed-title" onClick={all}>{name}</button>
            <div className="feed-frames">
              {g.frames.map((f) => (
                <FeedFrame key={f.file} game={g.id} frame={f} t={t} onOpen={(file) => setOpen({ game: g.id, file })} onScene={(x) => setScene({ game: g.id, file: x.file, ...x.scene })} />
              ))}
            </div>
            <button type="button" className="feed-all" onClick={all}>{t.feed_all}</button>
          </section>
        );
      })}
      {open && byId.has(open.game) && (
        <Suspense fallback={null}>
          <GameGallery game={byId.get(open.game)} t={t} initialFile={open.file} onClose={() => setOpen(null)} />
        </Suspense>
      )}
      {scene && (
        <Suspense fallback={null}>
          <SceneView key={`${scene.game}\n${scene.key}\n${scene.n}\n${scene.file}`} game={{ id: scene.game }} t={t} album={{ key: scene.key }} n={scene.n} title={scene.title}
            atFile={scene.file} speed={speed} hidden={hidden} onClose={() => setScene(null)} />
        </Suspense>
      )}
    </div>,
    document.body,
  );
};

export default PictureFeed;
