import { useEffect, useRef, useState } from 'react';
import { shownStatus } from '../gameStatus';
import { formatPlaytime } from '../formatPlaytime';

const ROMAN_NUMERALS = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ','Ⅺ','Ⅻ'];

import { getCoverUrl, getMediaUrl } from '../coverUrl';
import { languageKey, languageShort, languageLine } from '../formatLanguage';
import { flashStars } from '../pulse';
import { IconClock, IconHourglass, IconStarSolid, IconPlay, IconShelf, IconCheck } from './icons';
import { flightFrom, reducedMotion } from '../windowFly';
import { layersOpen } from '../layers';
import { fmtSize } from '../transferSize';

// Откуда лететь окну и «Играть»: обложка этой карточки (windowFly.js)
const coverFrom = (card) => flightFrom(card.querySelector('.card-cover img'));

// Кадры при наведении. Меняем src той же картинки, а не кладём вторую сверху: размер задаёт .card-cover, и окно игры летит
// от того, что сейчас видно (coverFrom). Кадр показываем, когда он уже загружен: иначе обложка мигала бы пустотой
const PREVIEW_AFTER = 600;
const PREVIEW_STEP = 900;
const PREVIEW_FRAMES = 4;
function useCoverPreview(screens, allowed) {
  const [frame, setFrame] = useState(null);
  const run = useRef(null);
  const allow = useRef(allowed);
  useEffect(() => { allow.current = allowed; });
  const end = () => {
    if (run.current) clearTimeout(run.current.timer);
    run.current = null;
  };
  useEffect(() => end, []);
  const leave = () => { end(); setFrame(null); };
  const enter = (e) => {
    if (!allowed || run.current || e.pointerType !== 'mouse' || !screens?.length || reducedMotion() || !window.matchMedia?.('(hover: hover)').matches) return;
    const card = e.currentTarget;
    const list = screens.slice(0, PREVIEW_FRAMES).map((src) => getMediaUrl(src, 360));
    const mine = { timer: 0 };
    let at = 0;
    const next = () => {
      // Включили выбор или нажали H, пока мышь на карточке
      if (!allow.current || card.closest('.covers-hidden') || !list.length) { leave(); return; }
      // Поверх открылось окно: стоим на этом кадре, окно вернётся в него же
      if (layersOpen()) { mine.timer = setTimeout(next, PREVIEW_STEP); return; }
      at %= list.length;
      const img = new Image();
      img.onload = () => {
        if (run.current !== mine) return;
        setFrame(list[at]);
        at += 1;
        mine.timer = setTimeout(next, PREVIEW_STEP);
      };
      img.onerror = () => {
        if (run.current !== mine) return;
        list.splice(at, 1);
        next();
      };
      img.src = list[at];
    };
    run.current = mine;
    mine.timer = setTimeout(next, PREVIEW_AFTER);
  };
  return { frame: allowed ? frame : null, enter, leave };
}

// usualLang — язык большинства игр библиотеки. На их карточках плашки нет: «АНГЛИЙСКИЙ» на каждой
// карточке был шумом. Плашка — только у тех, что на другом языке, и коротко: «JP», «CN»
// look — вид вкладки «Библиотека» (LibraryLook.jsx): карточка одна, «Крупно» и «Список» только добавляют к ней сведения
// picking — режим выбора (librarySelect.js): нажатие отмечает игру, а не открывает её; picked — отмечена ли эта
// part — её место в серии (gameSeries.js): { at, of }
const GameCard = ({ game, index, onClick, onRate, onPlay, t, lang, usualLang, frames, look, picking, picked, onPick, part }) => {
  const badge = shownStatus(game);
  const coverUrl = getCoverUrl(game);
  const roman = ROMAN_NUMERALS[index % ROMAN_NUMERALS.length] || String(index + 1);
  const name = game.displayTitle || game.title;
  // Пустая строка означает «меньше минуты» — тогда не рисуем даже значок
  const played = formatPlaytime(game.playtime, t);
  const langKey = languageKey(game);
  const language = langKey && langKey !== usualLang ? languageShort(game) : null;
  // «На полке»: файлов нет — обложка приглушена, «Играть» при наведении нет, вернуть — из окна игры
  const shelf = !!game.shelf;
  const preview = useCoverPreview(game.screens, !!look && look !== 'list' && !picking && !shelf);
  const coverShown = preview.frame || coverUrl;

  return (
    <div
      className={`game-card${shelf ? ' shelved' : ''}${picked ? ' picked' : ''}`}
      data-game={game.id}
      onClick={(e) => (picking ? onPick(game, e.shiftKey) : onClick(coverFrom(e.currentTarget)))}
      onPointerEnter={preview.enter}
      onPointerLeave={preview.leave}
      role="button"
      aria-pressed={picking ? !!picked : undefined}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (picking) { if (!e.repeat) onPick(game, e.shiftKey); return; }
        // Shift+Enter — сразу «Играть», как кнопка при наведении: у игры на полке её нет. Удержанная клавиша второй раз не запускает
        if (e.key === 'Enter' && e.shiftKey) { if (onPlay && !shelf && !e.repeat) onPlay(game, coverFrom(e.currentTarget)); return; }
        onClick(coverFrom(e.currentTarget));
      }}
    >
      {/* Ни корзины, ни звезды «Избранного» здесь больше нет: удаление — в окне игры,
          а избранным никто не пользовался */}

      <div className="card-cover">
        {picking && <span className="card-check" aria-hidden="true">{picked && <IconCheck />}</span>}
        {!picking && (
          <div className="card-rating">
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
        )}

        {coverShown ? (
          <img
            src={coverShown} alt={name} loading="lazy"
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
        {onPlay && !shelf && !picking && (
          <button type="button" className="card-play" tabIndex={-1} aria-hidden="true"
            data-tip={t.play} onClick={(e) => { e.stopPropagation(); onPlay(game, coverFrom(e.currentTarget.closest('.game-card'))); }}>
            <IconPlay />
          </button>
        )}
        {/* Выбран тег картинок: сколько таких кадров в игре */}
        {frames > 0 && <span className="card-frames">{t.lib_pic_frames(frames)}</span>}
        {/* Своя оценка — внизу слева: пять звёзд сверху закрывали логотип, они теперь только при наведении. Место занято числом кадров — уступает ему */}
        {game.rating > 0 && !frames && <span className="card-my-rating" aria-label={t.card_my_rating(game.rating)}><IconStarSolid /> {game.rating}</span>}
        {/* Язык по тексту самой игры; при наведении — все языки, как в окне игры */}
        {language && <span className="card-lang" data-tip={languageLine(game, t, lang)}>{language}</span>}
      </div>

      {/* Раньше здесь стояли «ТОМ 01» — номер по дате добавления, который менялся
          с каждой новой игрой, — и «Подробнее →», хотя открывает игру вся карточка.
          Теперь под названием то, что полезно видеть в сетке: версия, статус, время */}
      <div className="card-info">
        <h3 className="card-title" data-tip={name}>{name}</h3>
        <div className="card-meta">
          {shelf && <span className="card-shelf"><IconShelf /> {t.shelf_label}</span>}
          {game.version && <span className="card-version">v{game.version}</span>}
          {/* Значок — вписанный статус или «Играю», найденный сам. «Не начата» не показываем:
              висел бы на половине карточек */}
          {badge && <span className={`status-badge ${badge}`}>{t[`status_${badge}`]}</span>}
          {played && <span className="card-playtime"><IconClock /> {played}</span>}
          {!game.scraped && <span className="card-pending" data-tip={t.meta_line_new}><IconHourglass /></span>}
        </div>
        {part && look && look !== 'wall' && <span className="card-part">{t.series_part(part.at, part.of)}</span>}
        {look === 'feat' && game.description && <p className="card-desc">{game.description}</p>}
        {look === 'feat' && onPlay && !shelf && !picking && (
          <button type="button" className="card-feat-play" tabIndex={-1} aria-hidden="true"
            onClick={(e) => { e.stopPropagation(); onPlay(game, coverFrom(e.currentTarget.closest('.game-card'))); }}>{t.play}</button>
        )}
        {look === 'list' && (
          <div className="card-cols">
            <span>{game.version ? `v${game.version}` : ''}</span>
            <span>{badge && <span className={`status-badge ${badge}`}>{t[`status_${badge}`]}</span>}</span>
            <span>{played}</span>
            <span className="card-col-stars">{game.rating > 0 ? '★'.repeat(game.rating) : ''}</span>
            <span>{game.size >= 1048576 ? fmtSize(game.size, t) : ''}</span>
            <span>{game.addedAt ? new Date(game.addedAt).toLocaleDateString(lang, { day: 'numeric', month: 'short' }) : ''}</span>
          </div>
        )}
      </div>

    </div>
  );
};

export default GameCard;
