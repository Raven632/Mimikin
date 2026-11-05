import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { useCoversHidden } from '../coversHidden';
import { readSpeed } from '../galleryView';
import StateView from './StateView';
import SearchBox from './SearchBox';
import { IconClose, IconImage, IconPlay } from './icons';
import { galleryUrl } from '../apiUrl';

const GameGallery = lazy(() => import('./GameGallery'));
const SceneView = lazy(() => import('./SceneView'));
const thumb = (game, file) => galleryUrl(game, 'thumb', file);
const PAGE = 60;

// «Поиск по картинкам»: слова → кадры из галерей всех игр (сервер: /api/pictures/search). Плитка открывает галерею той
// игры сразу на этом кадре (GameGallery, initialFile); «Похожие» — картинки всей библиотеки, похожие на этот кадр
// (/api/pictures/similar); «Сцена» — плеер сцены, в которой есть кадр, с этого места. «Ещё картинки» — следующие 60.
// Запрос уходит, когда человек перестал печатать, — модель текста считает его на сервере. Первый раз сервер её качает
// (~270 МБ, минуты): ответ preparing — показываем, сколько скачано, и спрашиваем снова, пока не готова. Пока сервер
// разбирает кадры библиотеки (векторы и теги), под строкой «Искал» — сколько разобрано: поиск видит не все кадры. Разбор
// выключен (в ответе off) — так и говорим: новых кадров не будет, а модель слов сервер без него не качает.
// «По картинке» — своя картинка вместо кадра: файл, вставка или перетаскивание в окно. Сервер считает её вектор и не хранит
// (/api/pictures/by-image), вектор уходит за каждой страницей похожих; в окне — её же маленькая копия.
// q0 — с какими словами открыть (тег из галереи), like0 — сразу «Похожие» на этот кадр (кнопка в просмотре)
const PictureSearch = ({ games, t, q0 = '', like0 = null, onClose }) => {
  const [q, setQ] = useState(q0);
  const [like, setLike] = useState(like0);        // { game, file } — «Похожие» на этот кадр вместо слов; { v, src } — на свою картинку
  const [sending, setSending] = useState({ busy: false, error: '' });
  const fileRef = useRef(null);
  const sendNo = useRef(0);   // номер последней отправки своей картинки
  const [res, setRes] = useState({ key: '' });   // ответ на запрос key: { data }, { error } или { preparing: { done, total } }
  const [retry, setRetry] = useState({ key: '', n: 0 });   // повтор запроса, пока модель готовится: без паузы на печать
  const [extra, setExtra] = useState({ key: '', rows: [], more: null, busy: false });   // страницы «Ещё картинки»
  const [open, setOpen] = useState(null);        // { game, file } — открытая галерея
  const [scene, setScene] = useState(null);      // { game, file, key, n, title } — открытая сцена
  const [pass, setPass] = useState(null);        // { embeds: { done, total }, tags: { done, total } } — разбор идёт
  const [speed] = useState(readSpeed);
  const hidden = useCoversHidden();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  // Окно открылось — пусть сервер начинает готовить модель, пока человек печатает; заодно — идёт ли разбор кадров
  useEffect(() => {
    let alive = true;
    let timer = 0;
    // Повторные — только спросить: окно, забытое на сутки разбора, не держало бы модель слов открытой
    const ask = (again) => fetch(`/api/pictures/status${again ? '?peek=1' : ''}`).then((r) => r.json()).then((d) => {
      if (!alive) return;
      setPass(d.pass || null);
      if (d.pass) timer = setTimeout(() => ask(true), 30000);
    }).catch(() => {});
    ask(false);
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const text = q.trim();
  const active = !!like || text.length >= 2;
  const key = like ? `like\n${like.v || `${like.game}\n${like.file}`}` : text;
  const url = (from) => (like
    ? `/api/pictures/similar?${like.v ? `v=${encodeURIComponent(like.v)}` : `game=${encodeURIComponent(like.game)}&f=${encodeURIComponent(like.file)}`}&limit=${PAGE}&from=${from}`
    : `/api/pictures/search?q=${encodeURIComponent(text)}&limit=${PAGE}&from=${from}`);
  // Файл, брошенный на окно, — только сюда: загрузчик игр слушает всё окно браузера (Toolbar) и принял бы архив как новую игру
  const holdDrag = (e) => { e.preventDefault(); e.stopPropagation(); };
  // Своя картинка → её вектор, дальше — как «Похожие». Копию для показа отпускаем, когда она больше не нужна. Ответ считается,
  // только если после отправки человек ничего другого не выбрал: иначе медленный ответ подменил бы то, что уже на экране
  const sendImage = (file) => {
    if (!file?.type.startsWith('image/')) return;
    const mine = ++sendNo.current;
    setSending({ busy: true, error: '' });
    fetch('/api/pictures/by-image', { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
      .then((r) => r.json().catch(() => ({})).then((d) => {
        if (mine !== sendNo.current) return;
        if (!r.ok) throw new Error(r.status === 413 ? t.pics_image_big : r.status === 503 ? (d.off ? t.pics_off : t.pics_unavailable) : t.pics_image_bad);
        setLike({ v: d.v, src: URL.createObjectURL(file) });
        setSending({ busy: false, error: '' });
        rootRef.current?.scrollTo?.({ top: 0 });
      }))
      .catch((e) => { if (mine === sendNo.current) setSending({ busy: false, error: e.message }); });
  };
  const dropSend = () => { sendNo.current++; setSending({ busy: false, error: '' }); };
  const ownSrc = like?.src;
  useEffect(() => (ownSrc ? () => URL.revokeObjectURL(ownSrc) : undefined), [ownSrc]);
  // Вставка (Ctrl+V): только картинка; текст — как обычно, в строку поиска
  useEffect(() => {
    const paste = (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); sendImage(file); }
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendImage пользуется только постоянными t и ссылками
  }, [t]);
  useEffect(() => {
    if (!active) return undefined;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(url(0), { signal: ctl.signal })
        .then((r) => r.json().then((d) => {
          if (r.status === 503 && d.error === 'preparing') return { preparing: d };
          if (r.status === 503 && d.off) return { off: true };
          if (!r.ok) throw new Error(r.status === 503 ? t.pics_unavailable : r.status === 404 ? t.pics_like_gone : (d.error || r.status));
          return { data: d };
        }))
        .then((x) => setRes({ key, ...x }))
        .catch((e) => { if (e.name !== 'AbortError') setRes({ key, error: e.message }); });
    }, like || (retry.key === key && retry.n) ? 0 : 400);
    return () => { clearTimeout(timer); ctl.abort(); };
    // url — из key: отдельной зависимостью он перезапускал бы запрос на каждый показ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, t, retry]);
  // Ответ на прежний запрос не показываем: он ждёт нового
  const fresh = active && res.key === key;
  const found = fresh ? res.data : null;
  const error = fresh ? res.error : '';
  const preparing = fresh ? res.preparing : null;
  const off = fresh && res.off;
  const busy = active && !fresh;
  // Модель ещё готовится — спросить снова через три секунды
  useEffect(() => {
    if (!preparing) return undefined;
    const timer = setTimeout(() => setRetry((r) => ({ key, n: r.n + 1 })), 3000);
    return () => clearTimeout(timer);
  }, [preparing, key]);

  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const titleOf = (id) => { const g = byId.get(id); return g ? g.displayTitle || g.title || id : id; };
  const pages = extra.key === key ? extra : null;
  const rows = [...(found?.results || []), ...(pages?.rows || [])];
  const results = rows.filter((r) => byId.has(r.game));
  const more = pages && pages.more !== null ? pages.more : !!found?.more;
  const showMore = () => {
    const from = rows.length;
    setExtra((x) => ({ key, rows: x.key === key ? x.rows : [], more: x.key === key ? x.more : null, busy: true }));
    fetch(url(from)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setExtra((x) => (x.key === key ? { key, rows: [...x.rows, ...(d.results || [])], more: !!d.more && !!d.results?.length, busy: false } : x)))
      .catch(() => setExtra((x) => (x.key === key ? { ...x, busy: false } : x)));
  };
  const similar = (r) => {
    dropSend();
    setLike({ game: r.game, file: r.file });
    rootRef.current?.scrollTo?.({ top: 0 });
  };
  const type = (v) => { setLike(null); dropSend(); setQ(v); };
  const pct = (x) => (x?.total ? Math.floor((100 * x.done) / x.total) : 0);

  useLayer(rootRef, onClose);
  return createPortal(
    <div ref={rootRef} className={`gallery favorites${hidden ? ' covers-hidden' : ''}`} role="dialog" aria-modal="true" aria-label={t.pics_title} tabIndex={-1} onClick={(e) => e.stopPropagation()}
      onDragEnter={holdDrag} onDragOver={holdDrag} onDragLeave={holdDrag} onDrop={(e) => { holdDrag(e); sendImage(e.dataTransfer?.files?.[0]); }}>
      <div className="gallery-head">
        <h2>{t.pics_title}</h2>
        <button type="button" className="gallery-close" onClick={onClose} aria-label={t.close} data-tip={t.close}><IconClose /></button>
        <div className="pics-search">
          <SearchBox value={q} onChange={type} placeholder={t.pics_placeholder} clearLabel={t.search_clear} maxLength={100} inputRef={inputRef} />
          <button type="button" className="gallery-play pics-image" disabled={sending.busy} onClick={() => fileRef.current?.click()} aria-label={t.pics_image} data-tip={t.pics_image_hint}>
            <IconImage /><span className="tool-label">{t.pics_image}</span>
          </button>
          {/* Перечень типов, а не image/*: iPhone тогда отдаёт снимок как JPEG, а не HEIC */}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { sendImage(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
      </div>

      {like && (
        <div className="pics-like">
          <img src={like.src || thumb(like.game, like.file)} alt="" />
          <span>{like.src ? t.pics_image_title : t.pics_like_title(titleOf(like.game))}</span>
          <button type="button" className="gallery-play" onClick={() => { setLike(null); inputRef.current?.focus(); }}>{t.pics_like_back}</button>
        </div>
      )}
      {sending.error && <StateView kind="error" title={sending.error} />}
      {error && <StateView kind="error" title={error} />}
      {preparing && <StateView kind="loading" title={t.pics_preparing} hint={t.pics_preparing_hint(preparing.done, preparing.total)} />}
      {off && <StateView title={t.pics_off} hint={t.pics_off_hint} />}
      {!error && !sending.error && !found && !preparing && !off && <StateView kind={busy || sending.busy ? 'loading' : 'empty'} title={sending.busy ? t.pics_image_reading : busy ? t.pics_searching : t.pics_hint} hint={busy || sending.busy ? undefined : t.pics_image_hint} />}
      {!error && found && found.games === 0 && (found.off ? <StateView title={t.pics_off} hint={t.pics_off_hint} /> : <StateView title={t.pics_none} hint={t.pics_none_hint} />)}
      {!error && found && found.games > 0 && results.length === 0 && <StateView title={t.pics_empty_title} hint={t.pics_empty} />}

      {!error && found && found.games > 0 && (
        <p className="pics-covered">
          {found.understood && `${t.pics_understood(found.understood)} `}
          {found.unknown?.length > 0 && `${t.pics_unknown(found.unknown)} `}
          {t.pics_covered(found.games)}
          {pass && ` ${t.pics_pass(pct(pass.embeds), pct(pass.tags))}`}
          {found.off && ` ${t.pics_off_note}`}
        </p>
      )}
      {!error && results.length > 0 && (
        <>
          <div className="gallery-grid">
            {results.map((r) => (
              <div key={`${r.game}\n${r.file}`} className="pics-tile">
                <button type="button" className="gallery-tile cg" onClick={() => setOpen(r)}>
                  <img src={thumb(r.game, r.file)} alt="" loading="lazy" />
                  <span className="gallery-name">{titleOf(r.game)}</span>
                </button>
                <span className="pics-acts">
                  {r.scene && <button type="button" className="gallery-count play" onClick={() => setScene({ game: r.game, file: r.file, ...r.scene })}><IconPlay /> {t.pics_scene}</button>}
                  <button type="button" className="gallery-count" onClick={() => similar(r)}>{t.pics_similar}</button>
                </span>
              </div>
            ))}
          </div>
          {more && <button type="button" className="shelf-all line-more" disabled={!!pages?.busy} onClick={showMore}>{t.pics_more}</button>}
        </>
      )}

      {open && byId.has(open.game) && (
        <Suspense fallback={null}>
          <GameGallery game={byId.get(open.game)} t={t} initialFile={open.file} onClose={() => setOpen(null)} />
        </Suspense>
      )}
      {scene && (
        <Suspense fallback={null}>
          <SceneView key={`${scene.game}\n${scene.key}\n${scene.n}\n${scene.file}`} game={{ id: scene.game }} t={t} album={{ key: scene.key }} n={scene.n} title={scene.title}
            atFile={scene.file} speed={speed} hidden={hidden} onClose={() => setScene(null)} />
        </Suspense>
      )}
    </div>,
    document.body,
  );
};

export default PictureSearch;
