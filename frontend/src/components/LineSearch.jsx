import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { useCoversHidden } from '../coversHidden';
import { lineQueryOk, useLineSearch, sceneAt } from '../lineSearch';
import StateView from './StateView';
import SearchBox from './SearchBox';
import LineTile from './LineTile';
import LibraryScenes from './LibraryScenes';
import { IconClose } from './icons';

const GameGallery = lazy(() => import('./GameGallery'));
const PER_GAME = 4;

// Окно «Сцены». Без запроса — все сцены библиотеки (LibraryScenes). С запросом — поиск по репликам: слова → сцены всех
// игр, где так говорят (сервер: /api/lines/search). Группы по играм — до четырёх сцен, «Ещё N сцен» спрашивает только
// эту игру. Плитка открывает галерею игры, и плеер встаёт сразу на найденной реплике (GameGallery, initialScene).
// Открывается из меню и по «Все» на полке под поиском библиотеки (query0)
const LineSearch = ({ games, t, query0 = '', onClose }) => {
  const [q, setQ] = useState(query0);
  const [open, setOpen] = useState(null);           // { game, at } — открытая галерея и реплика
  const [extra, setExtra] = useState({});           // игра → { q, scenes } после «Ещё N сцен»; null — грузится
  const hidden = useCoversHidden();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const text = q.trim();
  const { data, error, busy } = useLineSearch(text, { limit: 60 });
  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const titleOf = (id) => { const g = byId.get(id); return g ? g.displayTitle || g.title || id : id; };
  const groups = (data?.games || []).filter((g) => byId.has(g.id)).map((g) => {
    const more = extra[g.id];
    const scenes = more && more.q === text ? more.scenes : (data.scenes || []).filter((s) => s.game === g.id).slice(0, PER_GAME);
    return { ...g, list: scenes, loading: more === null, expanded: !!(more && more.q === text) };
  });
  const showMore = (id) => {
    setExtra((x) => ({ ...x, [id]: null }));
    fetch(`/api/lines/search?q=${encodeURIComponent(text)}&game=${encodeURIComponent(id)}&limit=60`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setExtra((x) => ({ ...x, [id]: d ? { q: text, scenes: d.scenes || [] } : undefined })), () => setExtra((x) => ({ ...x, [id]: undefined })));
  };

  let state = null;
  if (!text) state = <LibraryScenes titleOf={titleOf} t={t} hidden={hidden} />;
  else if (!lineQueryOk(text)) state = <StateView kind="empty" title={t.lines_short} />;
  else if (error) state = <StateView kind="error" title={error === 'unavailable' ? t.lines_unavailable : t.lines_failed} />;
  else if (busy || !data) state = <StateView kind="loading" title={t.lines_searching} />;
  else if (!groups.length) state = <StateView title={t.lines_empty_title} hint={data.building ? t.lines_building(data.building.done, data.building.total) : t.lines_empty} />;

  useLayer(rootRef, onClose);
  return createPortal(
    <div ref={rootRef} className={`gallery favorites line-search${hidden ? ' covers-hidden' : ''}`} role="dialog" aria-modal="true" aria-label={t.lines_title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      <div className="gallery-head">
        <h2>{t.lines_title}</h2>
        <button type="button" className="gallery-close" onClick={onClose} aria-label={t.close} data-tip={t.close}><IconClose /></button>
        <div className="pics-search">
          <SearchBox value={q} onChange={setQ} placeholder={t.lines_placeholder} clearLabel={t.search_clear} maxLength={100} inputRef={inputRef} />
        </div>
      </div>

      {state}
      {!state && (
        <>
          <p className="pics-covered">
            {t.lines_found(data.total, data.games.length)}. {t.lines_covered(data.indexed, data.library)}.
            {data.building && ` ${t.lines_building(data.building.done, data.building.total)}.`}
          </p>
          {groups.map((g) => (
            <section key={g.id} className="line-group">
              <h3 className="line-group-title">{titleOf(g.id)}<span className="shelf-count">{t.lines_scenes(g.scenes)}</span></h3>
              {g.list.length > 0 && (
                <div className="gallery-grid">
                  {g.list.map((s) => (
                    <LineTile key={`${s.key}\n${s.n}`} scene={s} line={s.lines[0]} label={s.title} tip={s.title} t={t}
                      onOpen={() => setOpen({ game: s.game, at: sceneAt(s, s.lines[0]) })} />
                  ))}
                </div>
              )}
              {g.scenes > g.list.length && !g.expanded && (
                <button type="button" className="shelf-all line-more" disabled={g.loading} onClick={() => showMore(g.id)}>{t.lines_more(g.scenes - g.list.length)}</button>
              )}
            </section>
          ))}
        </>
      )}

      {open && byId.has(open.game) && (
        <Suspense fallback={null}>
          <GameGallery game={byId.get(open.game)} t={t} initialScene={open.at} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </div>,
    document.body,
  );
};

export default LineSearch;
