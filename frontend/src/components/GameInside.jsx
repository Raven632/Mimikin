import { useEffect, useState } from 'react';
import { tagLabel } from '../galleryView';

// «Что на картинках» в окне игры: что разметчик нашёл на кадрах и что отличает её от других игр (сервер: gallery.js, gameInside),
// с числом кадров. Не теги сайта, а то, что на самом деле нарисовано. Тег открывает галерею игры с этим тегом. Игра ещё не
// размечена — блока нет
const GameInside = ({ game, t, onPick }) => {
  const [tags, setTags] = useState([]);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/gallery/${encodeURIComponent(game.id)}/inside`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTags(d?.tags || []), () => {});
    return () => ctl.abort();
  }, [game.id]);
  if (!tags.length) return null;
  return (
    <>
      <div className="modal-section-label">{t.inside_title}</div>
      <div className="modal-tags game-inside">
        {tags.map((x) => (
          <button key={x.tag} type="button" className="tag tag-link" onClick={() => onPick(x.tag)} data-tip={t.inside_open}>
            {tagLabel(t, x.tag)}<span className="tag-n">{x.n}</span>
          </button>
        ))}
      </div>
    </>
  );
};

export default GameInside;
