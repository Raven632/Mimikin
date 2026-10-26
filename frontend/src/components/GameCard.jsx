import { autoStatus } from '../gameStatus';
import { formatPlaytime } from '../formatPlaytime';

const ROMAN_NUMERALS = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ','Ⅺ','Ⅻ'];

import { getCoverUrl } from '../coverUrl';
import { languageKey, languageShort, languageLine } from '../formatLanguage';
import { flashStars } from '../pulse';
import { IconClock, IconHourglass, IconStarSolid, IconPlay } from './icons';
import { flightFrom } from '../windowFly';

// Откуда лететь окну и «Играть»: обложка этой карточки (windowFly.js)
const coverFrom = (card) => flightFrom(card.querySelector('.card-cover img'));

// usualLang — язык большинства игр библиотеки. На их карточках плашки нет: «АНГЛИЙСКИЙ» на каждой
// карточке был шумом. Плашка — только у тех, что на другом языке, и коротко: «JP», «CN»
const GameCard = ({ game, index, onClick, onRate, onPlay, t, lang, usualLang }) => {
  const badge = game.status || (autoStatus(game) === 'playing' ? 'playing' : '');
  const coverUrl = getCoverUrl(game);
  const roman = ROMAN_NUMERALS[index % ROMAN_NUMERALS.length] || String(index + 1);
  const name = game.displayTitle || game.title;
  // Пустая строка означает «меньше минуты» — тогда не рисуем даже значок
  const played = formatPlaytime(game.playtime, t);
  const langKey = languageKey(game);
  const language = langKey && langKey !== usualLang ? languageShort(game) : null;

  return (
    <div
      className="game-card"
      onClick={(e) => onClick(coverFrom(e.currentTarget))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(coverFrom(e.currentTarget)); } }}
    >
      {/* Ни корзины, ни звезды «Избранного» здесь больше нет: удаление — в окне игры,
          а избранным никто не пользовался */}

      <div className="card-cover">
        <div className={`card-rating ${game.rating > 0 ? 'has-rating' : ''}`}>
          {[1, 2, 3, 4, 5].map(star => (
            <span 
              key={star} 
              className={`star ${star <= (game.rating || 0) ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); flashStars(e.currentTarget.parentElement, '.star', game.rating || 0, star); onRate(game.id, star); }}
            >
              <IconStarSolid />
            </span>
          ))}
        </div>

        {coverUrl ? (
          <img
            src={coverUrl} alt={name} loading="lazy"
            // Подгрузилась при прокрутке — проявляется, а не вспыхивает целиком (.loaded, index.css)
            onLoad={(e) => e.currentTarget.classList.add('loaded')}
            onError={(e) => e.currentTarget.classList.add('loaded')}
          />
        ) : (
          <div className="cover-placeholder">
            <span className="rune">{roman}</span>
            <span className="folder-name">{game.id}</span>
          </div>
        )}
        {/* «Играть» при наведении — как в Steam и GOG: запуск в один клик, без окна игры. Для мыши:
            с клавиатуры и на телефоне игру запускают из её окна (кнопка в кнопке — недопустима) */}
        {onPlay && (
          <button type="button" className="card-play" tabIndex={-1} aria-hidden="true"
            data-tip={t.play} onClick={(e) => { e.stopPropagation(); onPlay(game, coverFrom(e.currentTarget.closest('.game-card'))); }}>
            <IconPlay />
          </button>
        )}
        {/* Язык по тексту самой игры; при наведении — все языки, как в окне игры */}
        {language && <span className="card-lang" data-tip={languageLine(game, t, lang)}>{language}</span>}
      </div>

      {/* Раньше здесь стояли «ТОМ 01» — номер по дате добавления, который менялся
          с каждой новой игрой, — и «Подробнее →», хотя открывает игру вся карточка.
          Теперь под названием то, что полезно видеть в сетке: версия, статус, время */}
      <div className="card-info">
        <h3 className="card-title" data-tip={name}>{name}</h3>
        <div className="card-meta">
          {game.version && <span className="card-version">v{game.version}</span>}
          {/* Значок — вписанный статус или «Играю», найденный сам. «Не начата» не показываем:
              висел бы на половине карточек */}
          {badge && <span className={`status-badge ${badge}`}>{t[`status_${badge}`]}</span>}
          {played && <span className="card-playtime"><IconClock /> {played}</span>}
          {!game.scraped && <span className="card-pending" data-tip={t.meta_line_new}><IconHourglass /></span>}
        </div>
      </div>

    </div>
  );
};

export default GameCard;
