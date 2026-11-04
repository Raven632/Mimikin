import { lazy, Suspense, useMemo, useState } from 'react';
import LineTile from './LineTile';
import { useLineSearch, sceneAt } from '../lineSearch';

const GameGallery = lazy(() => import('./GameGallery'));
const SHOWN = 8;
const PER_GAME = 2;

// Полка «В репликах» под поиском библиотеки: набранное ищется ещё и в репликах сцен всех игр.
// Одна строка до восьми плиток, не больше двух от одной игры — чтобы игра с тысячей «муж» не заняла всю полку. Нажатие
// открывает галерею игры, и плеер сразу встаёт на эту реплику; «Все» — окно «Поиск по репликам» с тем же запросом.
// Ничего не нашлось — полки нет: под поиском библиотеки не нужен лишний «пусто»
const LineShelf = ({ query, games, t, onShowAll }) => {
  const { data } = useLineSearch(query, { limit: 24 });
  const [open, setOpen] = useState(null);      // { game, at } — открытая галерея и реплика
  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const titleOf = (id) => { const g = byId.get(id); return g ? g.displayTitle || g.title || id : id; };
  const tiles = [];
  const per = new Map();
  for (const s of data?.scenes || []) {
    if (tiles.length >= SHOWN) break;
    if (!byId.has(s.game) || !s.lines.length || (per.get(s.game) || 0) >= PER_GAME) continue;
    per.set(s.game, (per.get(s.game) || 0) + 1);
    tiles.push(s);
  }
  return (
    <>
      {tiles.length > 0 && (
        <section className="shelves line-shelf" aria-label={t.lines_shelf}>
          <div className="shelf">
            <div className="shelf-head">
              <h2 className="shelf-title">
                {t.lines_shelf}
                <span className="shelf-count">{t.lines_found(data.total, data.games.length)}</span>
              </h2>
              <div className="shelf-tools">
                <button type="button" className="shelf-all" onClick={() => onShowAll(query.trim())}>{t.shelf_see_all}</button>
              </div>
            </div>
            <div className="shelf-row">
              {tiles.map((s) => (
                <LineTile key={`${s.game}\n${s.key}\n${s.n}`} scene={s} line={s.lines[0]} label={titleOf(s.game)} tip={s.title} t={t}
                  onOpen={() => setOpen({ game: s.game, at: sceneAt(s, s.lines[0]) })} />
              ))}
            </div>
          </div>
        </section>
      )}
      {open && byId.has(open.game) && (
        <Suspense fallback={null}>
          <GameGallery game={byId.get(open.game)} t={t} initialScene={open.at} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </>
  );
};

export default LineShelf;
