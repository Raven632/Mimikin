import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { useCoversHidden } from '../coversHidden';
import { errorText, httpError } from '../apiError';
import StateView from './StateView';
import { IconClose, IconChevronLeft, IconChevronRight, IconHeart, IconExpand, IconShuffle, IconPlay, IconPause, IconFilm, IconLoop, IconSound, IconMute } from './icons';
import { STEPS, readStep, writeStep, shuffled, useZoom, useGalleryImage } from '../galleryView';
import MetaLine from './MetaLine';
import { VideoSeek } from './VideoSeek';
import { useVideoControl } from '../videoControl';

const isVideo = (f) => /\.(webm|mp4|m4v|ogv)$/i.test(f || '');
const api = (game, what, file) => `/api/gallery/${encodeURIComponent(game)}/${what}?f=${encodeURIComponent(file)}`;
// Сколько кадров анимации грузим вперёд (как в GameGallery)
const PRELOAD = 24;

// «Избранное»: картинки и ролики, отмеченные сердечком в галереях разных игр (GameGallery), — одним альбомом.
// Можно смотреть по одной игре, показом с таймером (по порядку или вперемешку), на весь экран. Ролик со звуком
// в показе играет до конца, петля, анимация и картинка — сколько выбрано секунд. Анимация из кадров, отмеченная
// целиком (frames, fps), играет сама
const FavoritesGallery = ({ games, t, onClose }) => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [fullSrc, setFullSrc] = useState('');     // адрес картинки, которая в просмотре догрузилась целиком
  const [reload, setReload] = useState(0);
  const [only, setOnly] = useState('');          // игра; '' — все
  const [view, setView] = useState(null);        // номер в показываемом списке
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(readStep);
  const pickStep = (s) => { setStep(s); writeStep(s); };
  const hidden = useCoversHidden();
  const rootRef = useRef(null);
  const viewRef = useRef(null);
  const touch = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/favorites')
      .then((r) => r.json().then((d) => { if (!r.ok) throw httpError(r, d); return d; }))
      .then((d) => { if (alive) setItems(Array.isArray(d) ? d : []); })
      .catch((e) => { if (alive) setError(errorText(t, e)); });
    return () => { alive = false; };
  }, [t, reload]);

  const titleOf = useMemo(() => {
    const map = new Map(games.map((g) => [g.id, g.displayTitle || g.title || g.id]));
    return (id) => map.get(id) || id;
  }, [games]);
  // Игры с избранным — чипами, по числу отмеченного
  const byGame = useMemo(() => {
    const count = new Map();
    for (const it of items || []) count.set(it.game, (count.get(it.game) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1]);
  }, [items]);
  // Вперемешку (galleryView.js, shuffled)
  const [order, setOrder] = useState(null);     // ключи в перемешанном порядке
  const keyOf = (it) => `${it.game}\n${it.file}`;
  const list = useMemo(() => {
    const base = (items || []).filter((it) => !only || it.game === only);
    if (!order) return base;
    const rank = new Map(order.map((k, i) => [k, i]));
    return [...base].sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
  }, [items, only, order]);
  const toggleShuffle = () => {
    setOrder(order ? null : shuffled((items || []).map(keyOf)));
    setView(null);
  };

  const current = view !== null ? list[view] : null;
  // Ролик со звуком — под своим плеером (пауза, звук, перемотка), а не системными <video controls>; петля плеера не имеет
  const [attachVideo, vid] = useVideoControl();
  const plain = !!current && isVideo(current.file) && current.kind !== 'animation';
  const go = (dir) => setView((v) => (v === null || !list.length ? v : (v + dir + list.length) % list.length));
  const close = () => { setPlaying(false); setView(null); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); };

  // Показ: картинка и петля — step секунд, ролик со звуком — до конца (onEnded ниже)
  useEffect(() => {
    if (!playing || !current || (isVideo(current.file) && current.kind !== 'animation')) return undefined;
    const timer = setTimeout(() => go(1), step * 1000);
    return () => clearTimeout(timer);
  }, [playing, current, step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Анимация из кадров: по кругу в своём темпе. Следующий кадр — когда браузер его загрузил (кадры из слоёв сервер
  // склеивает не сразу): без ожидания она мигала бы пустыми кадрами. Вперёд грузим PRELOAD кадров, не все сотни разом
  const [frame, setFrame] = useState({ of: null, i: 0 });
  const frameNo = frame.of === current ? frame.i : 0;
  const asked = useRef(new Set());
  const loaded = useRef(new Set());
  useEffect(() => {
    const frames = current?.frames;
    if (!frames) return undefined;
    const url = (k) => api(current.game, 'image', frames[k % frames.length]);
    const want = (k) => {
      const u = url(k);
      if (asked.current.has(u)) return;
      asked.current.add(u);
      const img = new Image();
      img.onload = () => loaded.current.add(u);
      img.onerror = () => { loaded.current.add(u); asked.current.delete(u); };
      img.src = u;
    };
    const ahead = (from) => { for (let k = 0; k < Math.min(frames.length, PRELOAD); k++) want(from + k); };
    ahead(0);
    let i = 0;
    const timer = setInterval(() => {
      if (!loaded.current.has(url(i + 1))) return;
      i = (i + 1) % frames.length;
      ahead(i);
      setFrame({ of: current, i });
    }, 1000 / (current.fps || 8));
    return () => clearInterval(timer);
  }, [current]);
  const shownFile = current?.frames ? current.frames[frameNo] : current?.file;
  // Картинка на экране появляется после img.decode() и плывёт наплывом; на телефоне идёт за пальцем (galleryView.js).
  // Кадры анимации сменяются как в GIF, без наплыва
  const wantSrc = current && !isVideo(current.file) ? api(current.game, 'image', shownFile) : '';
  const neighbor = (dir) => {
    if (view === null || list.length < 2) return null;
    const it = list[(view + dir + list.length) % list.length];
    return isVideo(it.file) ? '' : api(it.game, 'image', it.file);
  };
  const { shown, swipe, took } = useGalleryImage(wantSrc, viewRef, { instant: !!current?.frames, neighbor, go, blocked: () => zoom.blocks() });
  const zoom = useZoom(shown && current ? (current.frames ? `${current.game}\n${current.file}` : shown) : '', viewRef);

  // Следующие картинки — заранее
  useEffect(() => {
    if (view === null) return;
    [list[view + 1], list[view + 2]].filter((it) => it && !isVideo(it.file)).forEach((it) => { const img = new Image(); img.src = api(it.game, 'image', it.file); });
  }, [view, list]);

  useEffect(() => {
    const onKey = (e) => {
      if (view === null) return;
      // Полоса перемотки ролика разбирает ←/→ и пробел сама
      if (e.target instanceof Element && e.target.closest('.vseek')) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      // Пробел: у ролика под плеером — его пауза, у остальных — показ
      else if (e.key === ' ') { e.preventDefault(); if (plain) vid.toggle(); else setPlaying((p) => !p); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const unfavorite = async (it) => {
    const r = await fetch(`/api/favorites?game=${encodeURIComponent(it.game)}&f=${encodeURIComponent(it.file)}`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) return;
    const rest = (items || []).filter((x) => !(x.game === it.game && x.file === it.file));
    setItems(rest);
    // Убрали то, что открыто, — остаёмся на том же месте списка (там уже следующее)
    const left = rest.filter((x) => !only || x.game === only).length;
    if (view !== null) setView(left ? Math.min(view, left - 1) : null);
    if (only && !rest.some((x) => x.game === only)) setOnly('');
  };
  const fullscreen = () => {
    const el = viewRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  useLayer(rootRef, onClose);
  useLayer(viewRef, close, { active: !!current, focus: 'self' });

  const ready = items !== null;
  return createPortal(
    <div ref={rootRef} className={`gallery favorites${hidden ? ' covers-hidden' : ''}`} role="dialog" aria-modal="true" aria-label={t.favs_title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      <div className="gallery-head">
        <h2>{t.favs_title}</h2>
        <button type="button" className="gallery-close" onClick={onClose} aria-label={t.close} data-tip={t.close}><IconClose /></button>
        {byGame.length > 1 && (
          <div className="gallery-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={!only} className={`chip${!only ? ' active' : ''}`} onClick={() => setOnly('')}>{t.favs_all} {items.length}</button>
            {byGame.map(([id, n]) => (
              <button key={id} type="button" role="tab" aria-selected={only === id} className={`chip${only === id ? ' active' : ''}`} onClick={() => setOnly(id)}>{titleOf(id)} {n}</button>
            ))}
          </div>
        )}
        {ready && list.length > 0 && (
          <div className="fav-tools">
            <button type="button" className="gallery-play" onClick={() => { setView(0); setPlaying(true); }}><IconPlay /> {t.favs_show}</button>
            <button type="button" className="gallery-play" aria-pressed={!!order} onClick={toggleShuffle}><IconShuffle /> {t.favs_shuffle}</button>
          </div>
        )}
      </div>

      {error && <StateView kind="error" title={error} onRetry={() => { setError(''); setReload((n) => n + 1); }} retryLabel={t.retry} />}
      {ready && !error && list.length === 0 && <StateView title={t.favs_empty_title} hint={t.favs_empty} />}

      {ready && list.length > 0 && (
        <div className="gallery-grid">
          {list.map((it, i) => (
            <button key={keyOf(it)} type="button" className={`gallery-tile ${it.kind}`} onClick={() => { setPlaying(false); setView(i); }}>
              <img src={api(it.game, 'thumb', it.file)} alt="" loading="lazy" />
              {!only && <span className="gallery-name">{titleOf(it.game)}</span>}
              {(isVideo(it.file) || it.kind === 'animation') && <span className="tile-badges"><span className={`gallery-badge ${it.kind}`}>{it.kind === 'animation' ? <IconLoop /> : <IconFilm />}</span></span>}
            </button>
          ))}
        </div>
      )}

      {current && (
        <div
          ref={viewRef} className={`gallery-view${plain ? ' has-vseek' : ''}`} tabIndex={-1} onClick={close} {...swipe}
          onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
          onTouchEnd={(e) => {
            // Уже пролистано за пальцем (useGalleryImage): второй раз не листаем, а нажатие после жеста отменяем
            if (took()) { e.preventDefault(); return; }
            if (e.target.closest?.('.vseek') || zoom.blocks()) return;
            const dx = e.changedTouches[0].clientX - (touch.current ?? e.changedTouches[0].clientX);
            if (Math.abs(dx) > 40) { e.preventDefault(); go(dx < 0 ? 1 : -1); }
          }}
        >
          {isVideo(current.file) ? (
            current.kind === 'animation'
              ? <video key={current.file} src={api(current.game, 'video', current.file)} autoPlay loop muted playsInline onClick={(e) => { e.stopPropagation(); go(1); }} />
              : <video key={current.file} src={api(current.game, 'video', current.file)} ref={attachVideo} autoPlay playsInline onClick={(e) => { e.stopPropagation(); vid.toggle(); }} onEnded={() => { if (playing) go(1); }} />
          ) : (
            <img
              key={current.frames ? current.file : shown} src={shown} alt="" {...zoom.props}
              // Миниатюра из сетки лежит под картинкой, пока та грузится целиком; снимаем по загрузке (прозрачная иначе просвечивала бы)
              style={shown === wantSrc && shownFile === current.file && fullSrc !== shown
                ? { ...zoom.props.style, backgroundImage: `url("${api(current.game, 'thumb', current.file)}")`, backgroundPosition: 'center', backgroundSize: 'contain', backgroundRepeat: 'no-repeat' }
                : zoom.props.style}
              onLoad={() => setFullSrc(shown)}
              onClick={(e) => { e.stopPropagation(); if (!zoom.blocks()) go(1); }}
            />
          )}
          <button type="button" className="lightbox-nav prev" aria-label={t.shelf_prev} onClick={(e) => { e.stopPropagation(); go(-1); }}><IconChevronLeft /></button>
          <button type="button" className="lightbox-nav next" aria-label={t.shelf_next} onClick={(e) => { e.stopPropagation(); go(1); }}><IconChevronRight /></button>
          <div className="gallery-bar fav-bar" onClick={(e) => e.stopPropagation()}>
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
            <MetaLine className="fav-where" parts={[t.favs_position(view + 1, list.length), titleOf(current.game)]} />
            <button type="button" className="gallery-play" aria-pressed={playing} onClick={() => setPlaying((p) => !p)} data-tip={playing ? t.favs_pause : t.favs_show}>
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            {STEPS.map((s) => (
              <button key={s} type="button" className={`gallery-play fav-step${step === s ? ' on' : ''}`} aria-pressed={step === s} onClick={() => pickStep(s)} data-tip={t.favs_step_hint}>{t.favs_step(s)}</button>
            ))}
            <button type="button" className="gallery-play gallery-fav on" aria-pressed="true" onClick={() => unfavorite(current)} aria-label={t.favs_remove} data-tip={t.favs_remove}><IconHeart /></button>
            <button type="button" className="gallery-play" onClick={fullscreen} aria-label={t.favs_fullscreen} data-tip={t.favs_fullscreen}><IconExpand /></button>
            <button type="button" className="gallery-play" onClick={close} aria-label={t.gallery_back} data-tip={t.gallery_back}><IconClose /></button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};

export default FavoritesGallery;
