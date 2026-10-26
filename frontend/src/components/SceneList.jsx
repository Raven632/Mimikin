import RetryImg from './RetryImg';
import { IconPlay, IconSound, IconFilm, IconLoop, IconFork } from './icons';

// Разделы «Сцены» и «Диалоги» галереи: плитки в той же сетке, что и альбомы. Название сверху (под ним — говорящие), внизу
// слева значки (голос, выбор, ролик, анимация), внизу справа золотая пилюля «▶ N реплик»: нажатие сразу открывает плеер
// (GameGallery, onOpen). У плитки нет своего файла, поэтому ни сердечка, ни просмотра картинок. src — адрес миниатюры.
// У диалога портрет почти всегда один и тот же, поэтому он затемнён, а главное на плитке — первая реплика (sum.f);
// без неё — название по центру. Сводки (sum) нет у старого оглавления: тогда только название и «▶»

const SceneList = ({ rows, t, src, spineCover, onOpen }) => {
  const s = t.scene_list;
  return (
    <div className="gallery-grid">
      {rows.map((r, i) => {
        const m = r.sum;
        const talk = r.album.kind === 'dialogue';
        const who = m?.w ? m.w.join(', ') : '';
        // Название диалога часто и есть его первая реплика, поэтому над репликой — говорящие (нет их — название), а не то же самое дважды
        const top = talk ? (m?.f ? who || r.title : '') : r.title;
        const sub = talk ? '' : who;
        // «118 реплик»: на самом узком экране слово убираем, остаётся «▶ 118»
        const [num, ...word] = m?.l ? s.lines(m.l).split(' ') : [];
        const badges = m ? [m.v && ['voice', IconSound, s.voice], m.c && ['choice', IconFork, s.choice], m.m && ['video', IconFilm, s.video], m.a && ['anim', IconLoop, s.anim]].filter(Boolean) : [];
        return (
          <button key={`${r.album.key}\n${r.n}`} type="button" className={`gallery-tile scene-tile${talk ? ' talk' : ''}`} onClick={() => onOpen(i)}>
            {/* Набор Spine: обложка — кадр, снятый при первом просмотре (хранилище браузера); пока его нет — пустая плитка с названием */}
            {r.album.spine || r.album.live2d ? (spineCover(r.album) ? <img src={spineCover(r.album)} alt="" className="loaded" /> : <span className="gallery-tile-empty" aria-hidden="true" />)
              : r.cover ? <RetryImg src={src('thumb', r.cover)} alt="" loading="lazy" fallback={<span className="gallery-tile-empty" aria-hidden="true" />} /> : <span className="gallery-tile-empty" aria-hidden="true" />}
            {talk && <span className="tile-quote"><span>{m?.f || r.title}</span></span>}
            {top && <span className="gallery-name">{top}{sub && <span className="tile-sub">{sub}</span>}</span>}
            <span className="gallery-count play">
              <IconPlay />
              {m && (m.l ? <span>{num}<span className="lines-w"> {word.join(' ')}</span></span> : <span>{s.no_lines}</span>)}
            </span>
            {badges.length > 0 && (
              <span className="tile-badges">
                {badges.map(([k, Ic, label]) => <span key={k} className={`gallery-badge ${k}`} aria-label={label} data-tip={label}><Ic /></span>)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default SceneList;
