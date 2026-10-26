import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { SeekLine } from './VideoSeek';
import { clock } from '../videoControl';
import { IconChevronLeft, IconChevronRight, IconPlay, IconPause, IconLoop } from './icons';

// Сколько дорожек альбома рисуем сразу: у Ironhold Keep в audio/voice 5800 озвучек одной папкой
const SHOWN = 200;
const SECTIONS = ['music', 'voice', 'ambience', 'effects'];

const api = (id, file) => `/api/gallery/${encodeURIComponent(id)}/audio?f=${encodeURIComponent(file)}`;
// Имя дорожки — по файлу: без папки и расширения (.ogg_, .rpgmvo), подчёркивания — пробелы
const trackName = (rel) => rel.split('/').pop().replace(/\.[^.]+$/, '').replace(/_/g, ' ');
// Папка альбома без «audio/» и пометки сервера «#voice» (озвучка из папки эффектов)
const albumName = (key) => key.replace(/^audio\//i, '').replace('#voice', '') || 'audio';

// Время и перемотка — отдельным компонентом со своим временем: <audio> шлёт timeupdate четыре раза в секунду, и
// перерисовывать из-за этого весь список дорожек незачем
const SoundTime = ({ audio, duration, label, onSeek, onToggle }) => {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const el = audio.current;
    if (!el) return undefined;
    const tick = () => setTime(el.currentTime);
    el.addEventListener('timeupdate', tick);
    tick();
    return () => el.removeEventListener('timeupdate', tick);
  }, [audio]);
  const max = Number.isFinite(duration) ? duration : 0;
  return (
    <>
      <span className="sound-time">{clock(time)}</span>
      <SeekLine className="sound-seek" onToggle={onToggle} value={Math.min(time, max)} max={max} label={label} onSeek={(v) => { setTime(v); onSeek(v); }} />
      <span className="sound-time">{clock(duration)}</span>
    </>
  );
};

// Список дорожек: не перерисовывается, пока не сменились дорожка, состояние или длина
const SoundList = memo(({ s, sections, file, playing, duration, shown, onStart, onToggle, onMore }) => (
  <div className="sound-room">
    <p className="gallery-hint">{s.hint}</p>
    {sections.map(({ key, albums }) => {
      const all = albums.flatMap((a) => a.files);
      return (
        <section key={key} className="sound-section">
          <h3>{s.sections[key]} <span className="sound-count">{all.length}</span>
            <button type="button" className="gallery-play" onClick={() => onStart(all, 0)}><IconPlay /> {s.play_section}</button>
          </h3>
          {albums.map((a) => {
            const limit = shown[a.key] || SHOWN;
            return (
              <div key={a.key} className="sound-album">
                {(albums.length > 1 || all.length > SHOWN) && <h4>{albumName(a.key)} <span className="sound-count">{a.files.length}</span></h4>}
                <ul className="sound-list">
                  {a.files.slice(0, limit).map((f, i) => (
                    <li key={f}>
                      <button type="button" className={`sound-row${f === file ? ' current' : ''}`} aria-current={f === file ? 'true' : undefined}
                        onClick={() => (f === file ? onToggle() : onStart(a.files, i))}>
                        <span className="sound-mark" aria-hidden="true">{f === file && playing ? <IconPause /> : <IconPlay />}</span>
                        <span className="sound-name">{trackName(f)}</span>
                        {f === file && Number.isFinite(duration) && <span className="sound-len">{clock(duration)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                {a.files.length > limit && (
                  <button type="button" className="gallery-play" onClick={() => onMore(a.key, limit + SHOWN)}>{s.more(a.files.length - limit)}</button>
                )}
              </div>
            );
          })}
        </section>
      );
    })}
  </div>
));

// Звуковая комната галереи (сервер: services/gallery.js, sounds). Один <audio> на всю галерею: список можно
// закрыть вкладкой, а звук и полоса управления остаются — переключаться между вкладками можно под музыку. Очередь —
// альбом, из которого нажали дорожку, или весь раздел («Играть подряд»). Окно галереи закрыли — элемент исчезает
// вместе с ним, но детачнутый <audio> играет дальше, поэтому останавливаем явно
const SoundRoom = ({ game, t, sounds, active, hidden }) => {
  const s = t.gallery_sounds;
  const audio = useRef(null);
  const [queue, setQueue] = useState([]);
  const [pos, setPos] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(NaN);
  const [loop, setLoop] = useState(false);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState({});
  const file = queue[pos];

  useEffect(() => {
    const el = audio.current;
    return () => { el?.pause(); el?.removeAttribute('src'); el?.load(); };
  }, []);
  // «Скрыть обложки» (H) — тишина вместе с картинками
  useEffect(() => { if (hidden) audio.current?.pause(); }, [hidden]);

  // Запуск — прямо в обработчике нажатия: iOS и Safari не дают начать звук, если src сменился позже и играть
  // стали через autoPlay. Тот же адрес ставим заново — «Играть подряд» на текущей первой дорожке начинает её сначала
  const start = useCallback((files, i) => {
    setFailed(false); setDuration(NaN); setQueue(files); setPos(i);
    const el = audio.current;
    if (!el) return;
    el.src = api(game.id, files[i]);
    el.play().catch(() => setFailed(true));
  }, [game.id]);
  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el || !el.getAttribute('src')) return;
    if (el.paused) el.play().catch(() => setFailed(true)); else el.pause();
  }, []);
  const seek = useCallback((v) => { if (audio.current) audio.current.currentTime = v; }, []);
  const more = useCallback((key, to) => setShown((m) => ({ ...m, [key]: to })), []);
  const go = (to) => { if (to >= 0 && to < queue.length) start(queue, to); };

  const sections = SECTIONS.map((key) => ({ key, albums: sounds.albums.filter((a) => a.section === key) })).filter((x) => x.albums.length);

  return (
    <>
      {active && <SoundList s={s} sections={sections} file={file} playing={playing} duration={duration} shown={shown} onStart={start} onToggle={toggle} onMore={more} />}
      <audio
        ref={audio} loop={loop}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => { if (pos + 1 < queue.length) go(pos + 1); }}
        onError={() => { setFailed(true); setPlaying(false); }}
      />
      {file && (
        <div className="sound-bar" role="group" aria-label={s.sections.music}>
          <button type="button" className="gallery-play" onClick={() => go(pos - 1)} disabled={pos <= 0} aria-label={s.prev} data-tip={s.prev}><IconChevronLeft /></button>
          <button type="button" className="gallery-play" onClick={toggle} aria-label={playing ? s.pause : s.play} data-tip={playing ? s.pause : s.play}>{playing ? <IconPause /> : <IconPlay />}</button>
          <button type="button" className="gallery-play" onClick={() => go(pos + 1)} disabled={pos + 1 >= queue.length} aria-label={s.next} data-tip={s.next}><IconChevronRight /></button>
          <span className="sound-title">{failed ? s.failed : trackName(file)}</span>
          <SoundTime audio={audio} duration={duration} label={s.seek} onSeek={seek} onToggle={toggle} />
          <button type="button" className="gallery-play" aria-pressed={loop} onClick={() => setLoop((v) => !v)}><IconLoop /> {s.loop}</button>
        </div>
      )}
    </>
  );
};

export default SoundRoom;
