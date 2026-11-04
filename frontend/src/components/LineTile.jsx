import RetryImg from './RetryImg';
import { IconFork } from './icons';
import { lineParts } from '../lineSearch';

const thumb = (game, file) => `/api/gallery/${encodeURIComponent(game)}/thumb?f=${encodeURIComponent(file)}`;

// Найденная реплика (полка «В репликах» и окно «Поиск по репликам»): кадр, который на экране к этой реплике, затемнён, а
// поверх — сама реплика, как у плитки диалога в «Сценах» (SceneList). Найденные слова — золотом с тонким подчёркиванием.
// label — подпись сверху (игра или сцена), tip — полное название сцены. Выбор — значок, как бейдж в «Сценах»
const LineTile = ({ scene, line, label, tip, t, onOpen }) => {
  const file = line.pic || scene.cover;
  const empty = <span className="gallery-tile-empty" aria-hidden="true" />;
  return (
    <button type="button" className="gallery-tile line-tile" data-tip={tip || undefined} onClick={onOpen}>
      {file ? <RetryImg src={thumb(scene.game, file)} alt="" loading="lazy" fallback={empty} /> : empty}
      <span className="tile-quote">
        <span>
          {line.who && <span className="line-who">{line.who} </span>}
          {lineParts(line.text, line.hl).map((p, i) => (p.hit ? <mark key={i} className="line-hit">{p.text}</mark> : p.text))}
        </span>
      </span>
      {label && <span className="gallery-name">{label}</span>}
      {line.choice && (
        <span className="tile-badges">
          <span className="gallery-badge choice" aria-label={t.lines_choice} data-tip={t.lines_choice}><IconFork /></span>
        </span>
      )}
    </button>
  );
};

export default LineTile;
