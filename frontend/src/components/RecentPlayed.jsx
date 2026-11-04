import { getCoverUrl, getMediaUrl } from '../coverUrl';
import { formatPlaytime } from '../formatPlaytime';
import { timeAgo } from '../formatAgo';
import { flightFrom } from '../windowFly';
import { IconPlay } from './icons';

// Откуда лететь окну и «Играть»: картинка этой строки (windowFly.js)
const thumbFrom = (row) => flightFrom(row.querySelector('img'));

// «Недавно играли» — рядом со сценой на главной: вернуться к игре, начатой до последней, в один щелчок.
// Как плитка полки: строка открывает окно игры, золотая отметка — сразу в игру. Обложки нет — первый скриншот, как на сцене
const RecentPlayed = ({ games, t, lang, onOpen, onPlay, onShowAll }) => (
  <section className="home-recent" aria-label={t.tab_played}>
    <div className="home-recent-in">
      <h2 className="shelf-title">{t.tab_played}</h2>
      <div className="recent-rows">
        {games.map((game) => {
          const name = game.displayTitle || game.title;
          const thumb = getCoverUrl(game) || getMediaUrl(game.screens?.[0], 360);
          return (
            <div key={game.id} data-id={game.id} className="recent-row" role="button" tabIndex={0} onClick={(e) => onOpen(game, thumbFrom(e.currentTarget))}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(game, thumbFrom(e.currentTarget)); } }}>
              <span className="recent-thumb">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="shelf-empty">RPG</span>}</span>
              <span className="recent-text">
                <span className="recent-name" data-tip={name}>{name}</span>
                <span className="recent-note">{formatPlaytime(game.playtime, t) || timeAgo(game.lastPlayed, lang)}</span>
              </span>
              <button type="button" className="recent-play" tabIndex={-1} aria-hidden="true" data-tip={t.play}
                onClick={(e) => { e.stopPropagation(); onPlay(game, thumbFrom(e.currentTarget.closest('.recent-row'))); }}>
                <IconPlay />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="recent-all" onClick={onShowAll}>{t.home_all_games}</button>
    </div>
  </section>
);

export default RecentPlayed;
