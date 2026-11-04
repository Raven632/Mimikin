import { useEffect, useRef, useState } from 'react';
import SceneList from './SceneList';
import SceneView from './SceneView';
import StateView from './StateView';
import { TagPanel, TagPicked } from './PictureTags';
import { IconPlay, IconShuffle, IconTag } from './icons';
import { readSpeed, readSpineCover } from '../galleryView';

// Плиток у игры до «Ещё N сцен» — один ряд, как его сложит .gallery-grid (от 220 px, зазор 12, окно — 16 px с боков);
// на телефоне — два ряда по две. Считается при открытии окна
const perRow = () => (window.matchMedia('(max-width: 560px)').matches ? 4 : Math.min(12, Math.max(2, Math.floor((window.innerWidth - 20) / 232))));
const api = (id, what, file) => `/api/gallery/${encodeURIComponent(id)}/${what}?f=${encodeURIComponent(file)}`;

// Окно «Сцены» без запроса: все сцены библиотеки по играм (сервер: /api/scenes, services/libraryScenes.js). Чипы
// «Сцены» и «Диалоги» — как вкладки галереи игры, «С голосом» и «С анимацией» — отбор; у каждой игры ряд плиток и
// «Ещё N сцен». «Смотреть подряд» и «Вперемешку» — очередь с сервера, сцены идут одна за другой по всей
// библиотеке. Плитка — та сцена, плеер поверх окна; закрыли — снова окно
const LibraryScenes = ({ titleOf, t, hidden }) => {
  const s = t.scenes_lib;
  const [kind, setKind] = useState('scenes');
  const [voice, setVoice] = useState(false);
  const [anim, setAnim] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [extra, setExtra] = useState({});      // игра → все строки после «Ещё N сцен»; null — грузятся
  const [play, setPlay] = useState(null);       // { list: [{ game, key, n, title }], at, chain, more } — more: «подряд» ещё не кончился
  const [chainAuto, setChainAuto] = useState(false);
  const [speed] = useState(readSpeed);
  const [per] = useState(perRow);
  const [tagYes, setTagYes] = useState([]);     // теги панели «Теги»: только сцены с ними…
  const [tagNo, setTagNo] = useState([]);       // …и без этих
  const [tagPanel, setTagPanel] = useState(false);
  const tagBtn = useRef(null);
  const query = `kind=${kind}${voice ? '&voice=1' : ''}${anim ? '&anim=1' : ''}${tagYes.map((x) => `&tag=${encodeURIComponent(x)}`).join('')}${tagNo.map((x) => `&no=${encodeURIComponent(x)}`).join('')}`;

  useEffect(() => {
    let alive = true;
    fetch(`/api/scenes?${query}&per=${per}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) { setData({ query, ...d }); setError(false); } }, () => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [query, reload, per]);
  const fresh = data && data.query === query ? data : null;
  const tagN = tagYes.length + tagNo.length;
  const pickTag = (tag) => { setTagYes(tagYes.includes(tag) ? tagYes.filter((x) => x !== tag) : [...tagYes, tag]); setTagNo(tagNo.filter((x) => x !== tag)); };
  const notTag = (tag) => { setTagNo(tagNo.includes(tag) ? tagNo.filter((x) => x !== tag) : [...tagNo, tag]); setTagYes(tagYes.filter((x) => x !== tag)); };
  const resetTags = () => { setTagYes([]); setTagNo([]); };

  const showMore = (id) => {
    setExtra((x) => ({ ...x, [id]: null }));
    fetch(`/api/scenes?${query}&game=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setExtra((x) => ({ ...x, [id]: d?.games?.[0] ? { query, rows: d.games[0].rows } : undefined })), () => setExtra((x) => ({ ...x, [id]: undefined })));
  };
  const queue = (random) => {
    fetch(`/api/scenes?${query}&queue=${random ? 'random' : 'order'}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.queue?.length) { setChainAuto(false); setPlay({ list: d.queue, at: 0, chain: true, more: !!d.more, query }); } }, () => {});
  };
  // «Подряд» дошёл до конца порции — следующая порция с сервера, плеер идёт дальше; не пришла — конец
  const nextPart = () => {
    const p = play;
    fetch(`/api/scenes?${p.query}&queue=order&from=${p.list.length}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPlay(d?.queue?.length ? { ...p, list: [...p.list, ...d.queue], at: p.at + 1, more: !!d.more } : null), () => setPlay(null));
  };

  const chip = (on, label, onClick, count) => (
    <button type="button" className={`chip${on ? ' active' : ''}`} aria-pressed={on} onClick={onClick}>
      {label}{count !== undefined && <span className="chip-count">{count}</span>}
    </button>
  );
  const bar = (
    <div className="gallery-lv2 lib-scenes-bar">
      <div className="gallery-tabs" role="group" aria-label={s.filter}>
        {chip(kind === 'scenes', t.gallery_tabs.scenes, () => setKind('scenes'), fresh?.counts.scenes)}
        {chip(kind === 'dialogue', t.gallery_tabs.dialogue, () => setKind('dialogue'), fresh?.counts.dialogue)}
        <span className="lib-scenes-sep" aria-hidden="true" />
        {chip(voice, s.voice, () => setVoice(!voice))}
        {chip(anim, s.anim, () => setAnim(!anim))}
      </div>
      <div className="gallery-tools">
        {fresh?.total > 0 && (
          <>
            <button type="button" className="gallery-play" onClick={() => queue(false)} aria-label={t.scene_list.all}><IconPlay /><span className="tool-label">{t.scene_list.all}</span></button>
            <button type="button" className="gallery-play" onClick={() => queue(true)} aria-label={s.shuffle}><IconShuffle /><span className="tool-label">{s.shuffle}</span></button>
          </>
        )}
        <button ref={tagBtn} type="button" className="gallery-play tag-tool" aria-haspopup="dialog" aria-expanded={tagPanel} aria-pressed={tagN > 0} onClick={() => setTagPanel((on) => !on)} aria-label={t.gallery_tags}>
          <IconTag /><span className="tool-label">{t.gallery_tags}</span>{tagN > 0 && <span className="tag-tool-n">{tagN}</span>}
        </button>
      </div>
    </div>
  );

  let state = null;
  if (error) state = <StateView kind="error" title={s.failed} onRetry={() => { setError(false); setReload((n) => n + 1); }} retryLabel={t.retry} />;
  else if (!fresh) state = <StateView kind="loading" title={s.loading} />;
  else if (!fresh.total) state = tagN ? <StateView title={t.gallery_tags_nothing} hint={t.gallery_tags_nothing_hint} /> : voice || anim ? <StateView title={s.none_title} hint={s.none} /> : <StateView title={s.empty_title} hint={s.empty} />;

  const cur = play && play.list[play.at];
  const next = !play?.chain ? null : play.at + 1 < play.list.length ? () => setPlay({ ...play, at: play.at + 1 }) : play.more ? nextPart : null;
  return (
    <>
      {bar}
      {tagN > 0 && <TagPicked t={t} picked={tagYes} not={tagNo} count={fresh ? t.lines_scenes(fresh.total) : ''} hidden={fresh?.hidden || data?.hidden || []} onPick={pickTag} onNot={notTag} onReset={resetTags} onHidden={() => setReload((n) => n + 1)} />}
      {tagPanel && data && (
        <TagPanel t={t} anchor={tagBtn} counts={data.tags || []} total={data.total || 0} picked={tagYes} not={tagNo} onPick={pickTag} onNot={notTag} onReset={resetTags} result={t.lines_scenes} none={s.tags_none} onClose={() => setTagPanel(false)} />
      )}
      {state}
      {!state && (
        <>
          <p className="pics-covered">{s.found(fresh.total, fresh.games.length)}</p>
          {fresh.games.map((g) => {
            const more = extra[g.id];
            const rows = (more && more.query === query ? more.rows : g.rows).map((r) => ({ ...r, album: { key: r.key, kind: r.kind, spine: r.spine, live2d: r.live2d } }));
            return (
              <section key={g.id} className="line-group">
                <h3 className="line-group-title">{titleOf(g.id)}<span className="shelf-count">{t.lines_scenes(g.count)}</span></h3>
                <SceneList rows={rows} t={t} src={(what, f) => api(g.id, what, f)} spineCover={(a) => readSpineCover(g.id, a.key) || undefined}
                  onOpen={(i) => setPlay({ list: rows.map((r) => ({ game: g.id, key: r.key, n: r.n, title: r.title })), at: i, chain: false })} />
                {g.count > rows.length && (
                  <button type="button" className="shelf-all line-more" disabled={more === null} onClick={() => showMore(g.id)}>{t.lines_more(g.count - rows.length)}</button>
                )}
              </section>
            );
          })}
        </>
      )}
      {cur && (
        <SceneView key={`${play.at}\n${cur.game}\n${cur.key}\n${cur.n}`} game={{ id: cur.game }} t={t} album={{ key: cur.key }} n={cur.n} title={cur.title}
          speed={speed} hidden={hidden} auto0={play.chain && chainAuto} onAuto={play.chain ? setChainAuto : null} onNext={next} onClose={() => setPlay(null)} />
      )}
    </>
  );
};

export default LibraryScenes;
