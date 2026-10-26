import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { useCoversHidden } from '../coversHidden';
import StateView from './StateView';
import SearchBox from './SearchBox';
import { IconClose } from './icons';

const GameGallery = lazy(() => import('./GameGallery'));
const thumb = (game, file) => `/api/gallery/${encodeURIComponent(game)}/thumb?f=${encodeURIComponent(file)}`;

// «Поиск по картинкам»: слова → кадры из галерей всех игр, на которые уже посмотрело распознавание (сервер:
// /api/pictures/search). Плитка открывает галерею той игры сразу на этом кадре (GameGallery, initialFile).
// Запрос уходит, когда человек перестал печатать, — модель текста считает его на сервере
const PictureSearch = ({ games, t, onClose }) => {
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ q: '' });   // ответ на запрос q: { data } или { error }
  const [open, setOpen] = useState(null);        // { game, file } — открытая галерея
  const hidden = useCoversHidden();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const text = q.trim();
  const active = text.length >= 2;
  useEffect(() => {
    if (!active) return undefined;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/pictures/search?q=${encodeURIComponent(text)}&limit=60`, { signal: ctl.signal })
        .then((r) => r.json().then((d) => { if (!r.ok) throw new Error(r.status === 503 ? t.pics_unavailable : (d.error || r.status)); return d; }))
        .then((data) => setRes({ q: text, data }))
        .catch((e) => { if (e.name !== 'AbortError') setRes({ q: text, error: e.message }); });
    }, 400);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [active, text, t]);
  // Ответ на прежний запрос не показываем: он ждёт нового
  const fresh = active && res.q === text;
  const found = fresh ? res.data : null;
  const error = fresh ? res.error : '';
  const busy = active && !fresh;

  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const titleOf = (id) => { const g = byId.get(id); return g ? g.displayTitle || g.title || id : id; };
  const results = (found?.results || []).filter((r) => byId.has(r.game));

  useLayer(rootRef, onClose);
  return createPortal(
    <div ref={rootRef} className={`gallery favorites${hidden ? ' covers-hidden' : ''}`} role="dialog" aria-modal="true" aria-label={t.pics_title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      <div className="gallery-head">
        <h2>{t.pics_title}</h2>
        <button type="button" className="gallery-close" onClick={onClose} aria-label={t.close} data-tip={t.close}><IconClose /></button>
        <div className="pics-search">
          <SearchBox value={q} onChange={setQ} placeholder={t.pics_placeholder} clearLabel={t.search_clear} maxLength={100} inputRef={inputRef} />
        </div>
      </div>

      {error && <StateView kind="error" title={error} />}
      {!error && !found && <StateView kind={busy ? 'loading' : 'empty'} title={busy ? t.pics_searching : t.pics_hint} />}
      {!error && found && found.games === 0 && <StateView title={t.pics_none} hint={t.pics_none_hint} />}
      {!error && found && found.games > 0 && results.length === 0 && <StateView title={t.pics_empty_title} hint={t.pics_empty} />}
      {!error && results.length > 0 && (
        <>
          <p className="pics-covered">{t.pics_covered(found.games)}</p>
          <div className="gallery-grid">
            {results.map((r) => (
              <button key={`${r.game}\n${r.file}`} type="button" className="gallery-tile cg" onClick={() => setOpen(r)}>
                <img src={thumb(r.game, r.file)} alt="" loading="lazy" />
                <span className="gallery-name">{titleOf(r.game)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {open && byId.has(open.game) && (
        <Suspense fallback={null}>
          <GameGallery game={byId.get(open.game)} t={t} initialFile={open.file} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </div>,
    document.body,
  );
};

export default PictureSearch;
