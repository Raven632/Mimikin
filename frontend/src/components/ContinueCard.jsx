import { useRef, useState } from 'react';
import { WIDE_BANNER, getCoverUrl, getMediaUrl } from '../coverUrl';
import { formatPlaytime } from '../formatPlaytime';
import { timeAgo } from '../formatAgo';
import { launchGame, withIntro } from '../launchGame';
import { flightFrom } from '../windowFly';
import { errorText } from '../apiError';
import { levelOf, placeOf } from '../playProgress';
import { IconHistory, IconImage, IconPin, IconPlay } from './icons';
import { launchPoint, useResumePoint } from '../resumePoint';
import MetaLine from './MetaLine';

// Скриншотов на сцене — до трёх
const SHOTS = 3;
// Уже этого (ширина к высоте) — вертикальная обложка: в кадр 16:10 она встаёт целиком, а не отрезанной серединой
const PORTRAIT = 1.3;

// Последняя запущенная игра — сцена наверху главной: слева обложка целиком, справа название, где остановился,
// сколько наиграно и когда, скриншоты и «Играть». Обложка и название открывают окно игры (сведения, сейвы, правка);
// «Играть» — сразу в игру. Жанров здесь нет: они в окне игры, а сцена отвечает на «на чём я остановился».
// onOpen(game, initial) — окно игры сразу с галереей ('gallery'), раскрытым «Продолжить с…» ('saves') или
// раскрытым скриншотом (его номер).
// Обложки нет — кадром становится первый скриншот (и в ряду его уже нет); нет и скриншотов — заглушка, как на полке.
// «Играть» здесь — продолжить: игра открывается сразу на самом свежем сейве или моменте (resumePoint.js), без
// титульного экрана; под кнопкой — с чего именно. Нет ни того, ни другого — как обычно, с титула
const ContinueCard = ({ game, t, lang, onUpdateGame, showToast, onOpen }) => {
  // Перечитать, когда игру снова запускали (lastPlayed): после неё — новые сейвы
  const point = useResumePoint(game?.id, t, game?.lastPlayed || 0);
  const coverRef = useRef(null);
  // Какую картинку показать целиком (вертикальная или широкий баннер): пропорции известны только после загрузки
  const [whole, setWhole] = useState(null);
  if (!game) return null;
  const screens = game.screens || [];
  // 720 — кадр шире плитки полки: 360 на сцене было бы мылом
  const cover = getCoverUrl(game, 720) || getMediaUrl(screens[0], 720);
  // Номера скриншотов — как в окне игры: первый мог уйти в кадр
  const firstShot = game.cover ? 0 : 1;
  const name = game.displayTitle || game.title;
  const played = formatPlaytime(game.playtime, t);
  // Где остановился: место из сейва и уровень
  const where = [placeOf(game), levelOf(game) && t.where_level(levelOf(game))].filter(Boolean);
  const playedText = played && t.continue_played(played);
  const meta = [playedText, game.lastPlayed && timeAgo(game.lastPlayed, lang)].filter(Boolean);
  const shots = screens.slice(firstShot, firstShot + SHOTS);
  // Откуда лететь окну и «Играть»: обложка этой карточки (windowFly.js). Нет обложки — без полёта
  const from = () => flightFrom(coverRef.current?.querySelector('img'));
  const open = (initial) => onOpen?.(game, initial, from());

  return (
    <section className="continue-strip" aria-label={t.continue_label}>
      {/* Вне кнопки названия, тот же клик; с клавиатуры открывает кнопка с названием */}
      <div ref={coverRef} className={`continue-cover${whole === cover ? ' whole' : ''}`} onClick={() => open()} aria-hidden="true">
        {cover
          ? <img src={cover} alt="" onLoad={(e) => { const { naturalWidth: w, naturalHeight: h } = e.currentTarget; setWhole(h && (w / h < PORTRAIT || w / h >= WIDE_BANNER) ? cover : null); }} />
          : <span className="shelf-empty">RPG</span>}
      </div>
      <div className="continue-body">
        <button type="button" className="continue-open" onClick={() => open()} disabled={!onOpen} data-tip={name}>
          <span className="continue-info">
            <span className="continue-title">{name}</span>
            {where.length > 0 && <span className="continue-where" data-tip={t.where_title}><IconPin /><MetaLine parts={where} /></span>}
            {meta.length > 0 && (
              <MetaLine className="continue-meta" parts={meta.map((part, i) => <span key={i} className="continue-meta-part">{part}</span>)} />
            )}
            {game.notes && <span className="continue-note">{game.notes}</span>}
          </span>
        </button>
        {shots.length > 0 && (
          <div className="continue-shots">
            {shots.map((src, i) => (
              <button key={src} type="button" className="continue-shot" onClick={() => open(firstShot + i)} disabled={!onOpen} data-tip={t.screens_open}>
                <img src={getMediaUrl(src, 360)} alt={`${name} — ${firstShot + i + 1}`} loading="lazy" />
              </button>
            ))}
          </div>
        )}
        <div className="continue-actions">
          <button type="button" className="continue-btn" aria-label={`${t.play}: ${name}${point ? ` — ${t.resume_from(point.kind, point.name)}` : ''}`} data-tip={point ? t.resume_from(point.kind, point.name) : undefined}
            onClick={() => withIntro(game, from(), () => launchGame(game, onUpdateGame, launchPoint(point))).catch((e) => showToast?.(errorText(t, e), 'error'))}>
            <IconPlay /><span className="continue-btn-text">{t.play}</span>
          </button>
          {onOpen && (
            <div className="continue-more">
              <button type="button" className="meta-status-btn" onClick={() => open('gallery')} data-tip={t.gallery_title} aria-label={t.gallery_btn}><IconImage /><span className="continue-more-text">{t.gallery_btn}</span></button>
              <button type="button" className="meta-status-btn" onClick={() => open('saves')} data-tip={t.continue_from} aria-label={t.continue_saves}><IconHistory /><span className="continue-more-text">{t.continue_saves}</span></button>
            </div>
          )}
          {/* С чего продолжит «Играть» — строкой под кнопками */}
          {point && <MetaLine className="continue-resume" parts={[
            point.name ? <><span className="continue-resume-kind">{t.resume_from(point.kind)}: </span>{point.name}</> : t.resume_from(point.kind),
            timeAgo(point.at, lang),
          ]} />}
        </div>
      </div>
    </section>
  );
};

export default ContinueCard;
