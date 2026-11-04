import { useEffect, useMemo, useRef, useState } from 'react';
import { getCoverUrl } from '../coverUrl';

// Шапка вкладки «Библиотека»: название, сводка и картинка игры за ними. Картинка — последней запущенной, а под курсором — той игры, что
// под ним. Слушаем сами, а не через App: иначе каждое движение мыши перерисовывало бы всю сетку. «Скрыть обложки» убирает картинку совсем:
// размытая на всю ширину всё равно выдавала бы, во что играют
const HOVER_MS = 160;

const LibraryMast = ({ games, start, blurCovers, t }) => {
  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const [hovered, setHovered] = useState(null);
  const first = start?.cover ? start : games.find((g) => g.cover && !g.shelf);
  // Под курсором игра без обложки — картинка остаётся прежней, а не пропадает
  const game = (hovered && byId.get(hovered)?.cover && byId.get(hovered)) || first;
  const url = !blurCovers && game ? getCoverUrl(game, 720) : null;
  // Два слоя: новая картинка проявляется поверх прежней, когда загрузилась, а не мигает пустотой
  const [layers, setLayers] = useState({ a: null, b: null, on: 'a' });
  const wanted = useRef(null);
  useEffect(() => {
    wanted.current = url;
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      if (wanted.current !== url) return;
      setLayers((now) => {
        if (now[now.on] === url) return now;
        const next = now.on === 'a' ? 'b' : 'a';
        return { ...now, [next]: url, on: next };
      });
    };
    img.src = url;
  }, [url]);
  useEffect(() => {
    if (blurCovers) return undefined;
    let timer = 0;
    const over = (e) => {
      if (e.pointerType !== 'mouse') return;
      const id = e.target.closest?.('.library [data-game]')?.dataset.game;
      if (!id) return;
      clearTimeout(timer);
      timer = setTimeout(() => setHovered(id), HOVER_MS);
    };
    document.addEventListener('pointerover', over);
    return () => { clearTimeout(timer); document.removeEventListener('pointerover', over); };
  }, [blurCovers]);

  const started = games.filter((g) => g.playtime > 0).length;
  const hours = Math.round(games.reduce((sum, g) => sum + (g.playtime || 0), 0) / 3600);
  return (
    <section className="lib-mast">
      {url && (
        <div className="lib-mast-art" aria-hidden="true">
          {['a', 'b'].map((k) => layers[k] && <img key={k} src={layers[k]} alt="" className={layers.on === k ? 'on' : ''} />)}
        </div>
      )}
      <div className="lib-mast-text">
        <h1>{t.lib_title}</h1>
        <p className="lib-mast-stats">{t.lib_stats(games.length, started, hours)}</p>
      </div>
    </section>
  );
};

export default LibraryMast;
