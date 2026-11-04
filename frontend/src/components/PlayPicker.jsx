import { useEffect, useMemo, useRef, useState } from 'react';
import { useLayer } from '../layers';
import { useClosing } from '../useClosing';
import { getCoverUrl } from '../coverUrl';
import { launchGame } from '../launchGame';
import { errorText, httpError } from '../apiError';
import { postDismiss } from '../findData';
import { isOwner } from '../me';
import { langsLabel } from '../catalogItems';
import { languageName } from '../formatLanguage';
import { reasonShort } from '../pickReasons';
import StateView from './StateView';
import { IconClose, IconPlay } from './icons';
import RetryImg from './RetryImg';
import PickReasons from './PickReasons';

const ROW = 5;
// Плашки — на местах будущих плиток: без «Вернуться» лента шире на одну
const GHOSTS = Array.from({ length: ROW + 1 }, (_, i) => i);

// Край обложки, осыпающийся в окно крупными клетками: отражённая полоса обложки на холсте в несколько клеток, холст растянут
// без сглаживания, столбец за столбцом темнее. С холста ничего не читаем: обложка с чужого адреса его «пачкает», но рисовать
// на нём не мешает, поэтому здесь не нужен ни CORS, ни запрос к чужому серверу
const MOSAIC = { across: { w: 14, h: 8, strip: 0.3, base: 0.55, fade: 0.5 }, down: { w: 10, h: 14, strip: 0.35, base: 0.28, fade: 0.72 } };
// Узкая обложка стоит по центру своего места: клетки начались бы далеко от её края, отдельной полосой за чёрным провалом
const MOSAIC_MIN_RATIO = 1.3;
function drawMosaic(canvas, img, side) {
  const ctx = canvas?.getContext('2d');
  if (!ctx || !img.naturalWidth || img.naturalWidth / img.naturalHeight < MOSAIC_MIN_RATIO) return;
  const { w, h, strip, base, fade } = MOSAIC[side];
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const across = side === 'across';
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  if (across) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, nw * (1 - strip), 0, nw * strip, nh, 0, 0, w, h);
  } else {
    ctx.translate(0, h);
    ctx.scale(1, -1);
    ctx.drawImage(img, 0, nh * (1 - strip), nw, nh * strip, 0, 0, w, h);
  }
  ctx.restore();
  for (let i = 0; i < (across ? w : h); i++) {
    ctx.fillStyle = `rgba(11, 9, 12, ${1 - base * fade ** i})`;
    if (across) ctx.fillRect(i, 0, 1, h); else ctx.fillRect(0, i, w, 1);
  }
}

const GameThumb = ({ game }) => {
  const cover = getCoverUrl(game);
  return (
    <span className="pick-thumb">
      {cover ? <RetryImg src={cover} alt="" loading="lazy" fallback={<span className="pick-empty">RPG</span>} /> : <span className="pick-empty">RPG</span>}
    </span>
  );
};

// Плитка своей игры: в ленте и в «Вернуться»
const GameTile = ({ game, reason, t, lang, onClick }) => {
  const name = game.displayTitle || game.title;
  const why = reasonShort(t, lang, reason);
  return (
    <button type="button" className="pick-tile" onClick={onClick}>
      <GameThumb game={game} />
      <span className="pick-tile-name" data-tip={name}>{name}</span>
      <span className="pick-tile-meta">
        {game.developer && <span className="pick-tile-dev" data-tip={game.developer}>{game.developer}</span>}
      </span>
      {why && <span className="pick-why" data-tip={why}>{why}</span>}
    </button>
  );
};

// Что известно об игре, одной строкой под названием
const GameFacts = ({ game, lang }) => {
  const langs = game.textLang?.langs || [];
  return (
    <div className="pick-facts">
      {game.developer && <span>{game.developer}</span>}
      {langs.length > 0 ? (
        <span className="lang-set">
          {langs.map((code, i) => <span key={code} className={`modal-lang${i === 0 ? ' main' : ''}`} data-tip={languageName(code, lang)}>{langsLabel([code])}</span>)}
        </span>
      ) : game.language && <span>{game.language}</span>}
    </div>
  );
};

// «Во что поиграть?»: только свои игры. Одна в фокусе и почему именно она, рядом ещё из библиотеки и то, что бросили. Порядок и причины — у сервера
// (services/recommend.js). startId — игра, которую выплюнул мимик (пять щелчков по знаку, App.jsx): встаёт первой без всяких причин,
// как и начатая из «Вернуться»: это гостья на сцене, из очереди она не берётся
const PlayPicker = ({ games, t, lang, onClose, onOpenGame, showToast, hideToast, startId = null }) => {
  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const [attempt, setAttempt] = useState(0);
  const key = String(attempt);
  // Последний удачный ответ: повторный запрос ещё грузится, а окно не прыгает и показывает прежнее
  const [data, setData] = useState(null);
  const [settled, setSettled] = useState({ key: '', error: null });
  const [guest, setGuest] = useState(startId);
  const [dropped, setDropped] = useState(() => new Set());
  const [resumeOpen, setResumeOpen] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/recommend/library', { signal: ctl.signal });
        const answer = await res.json().catch(() => ({}));
        if (!res.ok) throw httpError(res, answer);
        setData({ ...answer, order: answer.items.map((x) => x.id) });
        setSettled({ key, error: null });
      } catch (e) {
        if (!ctl.signal.aborted) setSettled({ key, error: e });
      }
    })();
    return () => ctl.abort();
  }, [key]);

  const loading = settled.key !== key;
  const error = !loading ? settled.error : null;

  const contentRef = useRef(null);
  // Закрытие — коротким исчезновением, как у окна игры
  const [closing, close] = useClosing(onClose);
  useLayer(contentRef, close);

  const usable = (id) => byId.has(id) && !dropped.has(id);
  const pool = error ? [] : (data?.order || []).filter(usable);
  const focusId = usable(guest) ? guest : pool[0] || null;
  const rest = pool.filter((id) => id !== focusId);
  const resume = error ? [] : (data?.resume || []).filter((x) => usable(x.id));
  const reasons = new Map([...(data?.resume || []), ...(data?.items || [])].map((x) => [x.id, x.reasons]));
  const game = focusId ? byId.get(focusId) : null;
  const name = game ? game.displayTitle || game.title : '';
  const cover = game ? getCoverUrl(game, 720) : null;

  // Телефон: окно листается целиком, и новая игра осталась бы выше экрана — человек нажал и не видит, что получил.
  // На компьютере всё и так на месте, а фокус должен остаться на плитке
  const toStage = () => {
    if (window.matchMedia('(max-width: 700px)').matches) contentRef.current?.querySelector('.pick-stage')?.scrollIntoView({ block: 'start' });
  };
  const setOrder = (change) => setData((d) => d && { ...d, order: change(d.order) });
  // «Другую»: на сцену следующая, эта — в конец очереди: так список идёт по кругу
  const another = () => {
    setOrder((order) => (order.includes(focusId) ? [...order.filter((id) => id !== focusId), focusId] : order));
    setGuest(null);
    toStage();
  };
  // Из ленты: игра на сцену, та, что была на сцене, — на её место
  const bring = (id) => {
    setOrder((order) => {
      const from = guest ? -1 : order.indexOf(focusId);
      const to = order.indexOf(id);
      if (from < 0 || to < 0) return [id, ...order.filter((x) => x !== id)];
      const next = [...order];
      next[to] = focusId;
      next[from] = id;
      return next;
    });
    setGuest(null);
    toStage();
  };
  // С «Вернуться»: гостья на сцене, очередь не меняется
  const bringBack = (id) => {
    setGuest(id);
    toStage();
  };

  const forget = (id, on) => setDropped((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const undoDismiss = async (id) => {
    hideToast?.();
    try {
      await postDismiss({ key: id, undo: true });
      forget(id, false);
      // Вернули — снова на сцену: в очереди её может уже не быть
      setGuest(id);
    } catch (e) {
      showToast?.(errorText(t, e), 'error');
    }
  };
  // Сразу дальше, не дожидаясь сервера: ответа он ждать не заставляет, а не вышло — игра вернётся и будет сказано почему
  const dismiss = async () => {
    const id = focusId;
    const title = name;
    forget(id, true);
    toStage();
    try {
      await postDismiss({ key: id });
      showToast?.(t.pick_dismissed(title), 'success', { label: t.undo, onClick: () => undoDismiss(id) });
    } catch (e) {
      forget(id, false);
      showToast?.(errorText(t, e), 'error');
    }
  };

  const showResume = resumeOpen || (!loading && !rest.length && resume.length > 0);
  const reasonOf = (id) => reasons.get(id)?.[0];

  return (
    <div className={`modal-overlay active pop pick-overlay${closing ? ' closing' : ''}`} onClick={close}>
      <div ref={contentRef} className="stats-content play-pick" role="dialog" aria-modal="true" aria-label={t.pick_title} aria-description={t.pick_hint} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-actions-top"><button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button></div>

        <div className="pick-head">
          <h2 className="pick-title">{t.pick_title}</h2>
        </div>

        {game ? (
          <section className="pick-stage" aria-busy={loading}>
            <canvas key={`across-${focusId}`} className="pick-mosaic across" width={MOSAIC.across.w} height={MOSAIC.across.h} aria-hidden="true" />
            <canvas key={`down-${focusId}`} className="pick-mosaic down" width={MOSAIC.down.w} height={MOSAIC.down.h} aria-hidden="true" />
            <div className="pick-cover">
              {cover
                ? <RetryImg src={cover} alt="" fallback={<span className="pick-empty">RPG</span>}
                  onLoad={(e) => { const stage = e.currentTarget.closest('.pick-stage'); drawMosaic(stage?.querySelector('.pick-mosaic.across'), e.currentTarget, 'across'); drawMosaic(stage?.querySelector('.pick-mosaic.down'), e.currentTarget, 'down'); }} />
                : <span className="pick-empty">RPG</span>}
            </div>
            <div className="pick-focus">
              <h3 className="pick-name" aria-live="polite">{name}</h3>
              <GameFacts game={game} lang={lang} />
              <PickReasons reasons={reasons.get(focusId) || []} cold={!!data?.cold} t={t} lang={lang} games={byId} />
              <div className="pick-actions">
                <button type="button" className="save-btn pick-play" onClick={() => { onClose(); launchGame(game).catch((e) => showToast?.(errorText(t, e), 'error')); }}><IconPlay /> {t.play}</button>
                <button type="button" className="meta-status-btn" onClick={another} disabled={!rest.length}>{t.pick_another}</button>
                <button type="button" className="meta-status-btn" onClick={() => { onClose(); onOpenGame(game.id); }}>{t.pick_open}</button>
                {isOwner() && <button type="button" className="catalog-back pick-skip" onClick={dismiss}>{t.pick_dismiss}</button>}
              </div>
            </div>
          </section>
        ) : loading ? (
          <section className="pick-stage" aria-busy="true">
            <div className="pick-cover pick-ghost" aria-hidden="true" />
            <div className="pick-focus"><p className="pick-loading" role="status">{t.pick_loading}</p></div>
          </section>
        ) : (
          <section className="pick-stage pick-stage-empty">
            {error
              ? <StateView kind="error" title={errorText(t, error)} onRetry={() => setAttempt((n) => n + 1)} retryLabel={t.retry} />
              : <StateView title={t.pick_none_any} />}
          </section>
        )}

        {/* С игрой от мимика подбор мог и не ответить: игра на месте, а сбой сказан здесь */}
        {error && game && <div className="pick-more-fail"><StateView kind="error" title={errorText(t, error)} onRetry={() => setAttempt((n) => n + 1)} retryLabel={t.retry} /></div>}

        {(loading && !data) ? (
          <section className="pick-more only" aria-hidden="true">
            <div className="pick-more-col">
              <h3 className="pick-label">{t.pick_more}</h3>
              <div className="pick-strip wide">
                {GHOSTS.map((n) => <div key={n} className="pick-tile"><span className="pick-thumb pick-ghost" /><span className="pick-ghost-lines"><i /><i /><i /></span></div>)}
              </div>
            </div>
          </section>
        ) : showResume && resume.length > 0 ? (
          <section className="pick-more only">
            <div className="pick-more-col">
              <div className="pick-more-head">
                <h3 className="pick-label">{t.pick_back}</h3>
                {rest.length > 0 && <button type="button" className="catalog-back pick-more-switch" onClick={() => setResumeOpen(false)}>{t.pick_back_close}</button>}
              </div>
              <div className="pick-strip wide">
                {resume.map((x) => <GameTile key={x.id} game={byId.get(x.id)} reason={x.reasons?.[0]} t={t} lang={lang} onClick={() => bringBack(x.id)} />)}
              </div>
            </div>
          </section>
        ) : rest.length > 0 && (
          <section className={`pick-more${resume.length ? '' : ' only'}`} aria-busy={loading}>
            <div className="pick-more-col">
              <h3 className="pick-label">{t.pick_more}</h3>
              <div className={`pick-strip${resume.length ? '' : ' wide'}`}>
                {/* Ключ — место в ленте: фокус остаётся на той же плитке, куда только что встала игра со сцены */}
                {rest.slice(0, resume.length ? ROW : ROW + 1).map((id, i) => <GameTile key={i} game={byId.get(id)} reason={reasonOf(id)} t={t} lang={lang} onClick={() => bring(id)} />)}
              </div>
            </div>
            {resume.length > 0 && (
              <div className="pick-more-col pick-back">
                <h3 className="pick-label">{t.pick_back}</h3>
                <GameTile game={byId.get(resume[0].id)} reason={resume[0].reasons?.[0]} t={t} lang={lang} onClick={() => bringBack(resume[0].id)} />
                {resume.length > 1 && <button type="button" className="catalog-back pick-more-switch" onClick={() => setResumeOpen(true)}>{t.pick_back_all(resume.length)}</button>}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
};

export default PlayPicker;
