import { useRef } from 'react';
import { getCoverUrl, getMediaUrl } from '../coverUrl';
import { formatPlaytime } from '../formatPlaytime';
import { timeAgo } from '../formatAgo';
import { launchGame, withIntro } from '../launchGame';
import { flightFrom } from '../windowFly';
import { errorText } from '../apiError';
import { isFormatTag } from '../formatTags';
import { levelOf, placeOf } from '../playProgress';
import { IconHistory, IconImage, IconPin, IconPlay } from './icons';
import { launchPoint, useResumePoint } from '../resumePoint';
import MetaLine from './MetaLine';

// Скриншотов в середине карточки — до трёх; на экране поуже стили оставляют два, на телефоне — ни одного
const SHOTS = 3;

// Последняя запущенная игра — карточкой «Продолжить» наверху главной, как в Steam: обложка, полное
// название, сколько наиграно и когда, и «Играть». На телефоне кнопка — значком ▶: подписью она съедала
// половину названия, а «сколько» и «когда» — двумя строками, без обрезанного «12 ми…».
// Обложка и название — кнопка: открывают окно игры (сведения, сейвы, правка); «Играть» — сразу в игру.
// Обложка — левая стенка карточки на всю высоту, без размытой подложки. На
// компьютере середина не пустая: скриншоты, оценка, жанры, новая версия, а под «Играть» — «Галерея» и
// «Сейвы». На телефоне под карточкой та же строка «с чего продолжит» и кнопки значками. onOpen(game, initial) — окно игры сразу с галереей ('gallery') или раскрытым «Продолжить с…» ('saves')
// или раскрытым скриншотом (его номер).
// «Играть» здесь — продолжить: игра открывается сразу на самом свежем сейве или моменте (resumePoint.js), без
// титульного экрана; под кнопкой — с чего именно. Нет ни того, ни другого — как обычно, с титула
const ContinueCard = ({ game, t, lang, onUpdateGame, showToast, onOpen }) => {
  // Перечитать, когда игру снова запускали (lastPlayed): после неё — новые сейвы
  const point = useResumePoint(game?.id, t, game?.lastPlayed || 0);
  const coverRef = useRef(null);
  if (!game) return null;
  const cover = getCoverUrl(game);
  const name = game.displayTitle || game.title;
  const played = formatPlaytime(game.playtime, t);
  // Где остановился: место из сейва и уровень
  const where = [placeOf(game), levelOf(game) && t.where_level(levelOf(game))].filter(Boolean);
  const playedText = played && t.continue_played(played);
  const meta = [playedText, game.lastPlayed && timeAgo(game.lastPlayed, lang)].filter(Boolean);
  const tags = (game.tags || []).filter((tag) => !isFormatTag(tag)).slice(0, 3);
  const facts = [
    tags.length > 0 && <span key="tags">{tags.join(', ')}</span>,
  ].filter(Boolean);
  const shots = (game.screens || []).slice(0, SHOTS);
  // Откуда лететь окну и «Играть»: обложка этой карточки (windowFly.js). Нет обложки — без полёта
  const from = () => flightFrom(coverRef.current?.querySelector('img'));
  const open = (initial) => onOpen?.(game, initial, from());

  return (
    <section className="continue-strip" aria-label={t.continue_label}>
      {/* Обложка — левая стенка карточки на всю высоту, резкая. Вне кнопки названия: на телефоне она
          занимает обе строки сетки. Тот же клик; с клавиатуры открывает кнопка с названием */}
      {cover && <div ref={coverRef} className="continue-cover" onClick={() => open()} aria-hidden="true"><img src={cover} alt="" /></div>}
      <button type="button" className="continue-open" onClick={() => open()} disabled={!onOpen} data-tip={name}>
        <span className="continue-info">
          <span className="continue-title">{name}</span>
          {where.length > 0 && <span className="continue-where" data-tip={t.where_title}><IconPin /><MetaLine parts={where} /></span>}
          {meta.length > 0 && (
            <MetaLine className="continue-meta" parts={meta.map((part, i) => <span key={i} className="continue-meta-part">{part}</span>)} />
          )}
          {facts.length > 0 && <MetaLine className="continue-facts" parts={facts} />}
        </span>
      </button>
      {shots.length > 0 && (
        <div className="continue-shots">
          {shots.map((src, i) => (
            <button key={src} type="button" className="continue-shot" onClick={() => open(i)} disabled={!onOpen} data-tip={t.screens_open}>
              <img src={getMediaUrl(src, 360)} alt={`${name} — ${i + 1}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <div className="continue-actions">
        <button type="button" className="continue-btn" aria-label={`${t.play}: ${name}${point ? ` — ${t.resume_from(point.kind, point.name)}` : ''}`} data-tip={point ? t.resume_from(point.kind, point.name) : undefined}
          onClick={() => withIntro(game, from(), () => launchGame(game, onUpdateGame, launchPoint(point))).catch((e) => showToast?.(errorText(t, e), 'error'))}>
          <IconPlay /><span className="continue-btn-text">{t.play}</span>
        </button>
        {point && <MetaLine className="continue-resume" parts={[t.resume_from(point.kind, point.name), timeAgo(point.at, lang)]} />}
        {onOpen && (
          <div className="continue-more">
            <button type="button" className="meta-status-btn" onClick={() => open('gallery')} data-tip={t.gallery_title} aria-label={t.gallery_btn}><IconImage /><span className="continue-more-text">{t.gallery_btn}</span></button>
            <button type="button" className="meta-status-btn" onClick={() => open('saves')} data-tip={t.continue_from} aria-label={t.continue_saves}><IconHistory /><span className="continue-more-text">{t.continue_saves}</span></button>
          </div>
        )}
      </div>
    </section>
  );
};

export default ContinueCard;
