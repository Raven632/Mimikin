import { useEffect, useState } from 'react';
import { formatPlaytime } from '../formatPlaytime';
import { IconCheck, IconClock, IconImage, IconPin, IconPlay } from './icons';
import MetaLine from './MetaLine';

// Вкладка «Путь» в окне игры: что человек в игре прошёл, по дням — новые локации, сцены (с кадром), выборы с его
// ответом, бои, свои снимки. Пишет сама игра (rpg-fixes, setupSceneMarks → api/src/utils/journal.js). Это история, а не
// сейвы: «Играть отсюда» — только пока жива точка перемотки этой сцены (shots — список вкладки «Скриншоты»).
// Справа — «Ещё не видели»: сколько сцен комнаты воспоминаний открыто (считает игра, cheats.js roomStatus). Закрытые —
// без картинок и названий: без спойлеров
const api = (id, rest = '') => `/api/journal/${encodeURIComponent(id)}${rest}`;

const IconScene = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" /><path d="M10 9.5l4.5 2.5-4.5 2.5z" /></svg>;
const IconBattle = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19L19 5M14 5h5v5M5 5l14 14M5 14v5h5" /></svg>;
const IconChoice = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21v-6M12 15L6 9V4M12 15l6-6V4" /></svg>;
const ICON = { map: IconPin, scene: IconScene, choice: IconChoice, battle: IconBattle, shot: IconImage };
const FILTERS = ['all', 'scene', 'choice', 'battle'];

const dayKey = (at) => new Date(at).toDateString();
const timeOf = (at, lang) => new Date(at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });

function dayLabel(at, t, lang) {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t.shots_today;
  if (d.toDateString() === yesterday.toDateString()) return t.shots_yesterday;
  return d.toLocaleDateString(lang, { day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

// Плиток не больше стольких: у комнаты бывает за сотню сцен
const TILES = 60;

// open: null — сколько открыто, по этой игре не понять (сцены закрывает плагин): только число, без хода
function RoomPanel({ room, t, lang }) {
  const shown = Math.min(room.total, TILES);
  const known = room.open !== null && room.open !== undefined;
  const open = known ? Math.min(room.open, shown) : 0;
  return (
    <aside className="path-room" aria-label={t.path_room_title}>
      <h4>{t.path_room_title}</h4>
      <p>{known ? t.path_room_text(room.open, room.total, room.rooms?.[0] || '') : t.path_room_unknown(room.total, room.rooms?.[0] || '')}</p>
      {known && (
        <div className="path-room-bar" role="progressbar" aria-valuemin={0} aria-valuemax={room.total} aria-valuenow={room.open}>
          <i style={{ width: `${room.total ? (room.open / room.total) * 100 : 0}%` }} />
        </div>
      )}
      <div className="path-room-tiles" aria-hidden="true">
        {Array.from({ length: shown }, (_, i) => <span key={i} className={i < open ? 'open' : ''}>{i < open ? <IconCheck /> : '?'}</span>)}
      </div>
      {room.total > TILES && <small>{t.path_room_more(room.total - TILES)}</small>}
      {room.at > 0 && <small>{t.path_room_when(new Date(room.at).toLocaleDateString(lang, { day: 'numeric', month: 'long' }))}</small>}
    </aside>
  );
}

const PathPanel = ({ game, t, lang, shots, onPlay }) => {
  const [state, setState] = useState({ id: null, items: null, failed: false });
  const [room, setRoom] = useState({ id: null, data: null });
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    let alive = true;
    fetch(api(game.id)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((items) => { if (alive) setState({ id: game.id, items: Array.isArray(items) ? items : [], failed: false }); })
      .catch(() => { if (alive) setState({ id: game.id, items: [], failed: true }); });
    fetch(api(game.id, '/room')).then((r) => (r.ok ? r.json() : null)).then((data) => { if (alive) setRoom({ id: game.id, data }); }, () => {});
    return () => { alive = false; };
  }, [game.id]);
  const items = state.id === game.id ? state.items : null;
  const roomData = room.id === game.id && room.data && room.data.total > 0 ? room.data : null;
  if (items === null) return <p className="shots-wait">{t.shots_loading}</p>;
  if (state.failed) return <p className="shots-wait" role="alert">{t.path_failed}</p>;
  if (!items.length) {
    return (
      <div className={roomData ? 'path-cols' : ''}>
        <div className="shots-empty">
          <IconClock />
          <p>{t.path_empty}</p>
        </div>
        {roomData && <RoomPanel room={roomData} t={t} lang={lang} />}
      </div>
    );
  }

  // Точки перемотки, что ещё живы, — по ним «Играть отсюда»
  const alive = new Set((shots.items || []).filter((m) => m.save).map((m) => m.id));
  const count = (kind) => items.filter((e) => e.kind === kind).length;
  const shown = filter === 'all' ? items : items.filter((e) => e.kind === filter);
  const days = [];
  for (const e of shown) {
    const last = days[days.length - 1];
    if (last && last.key === dayKey(e.at)) last.items.push(e);
    else days.push({ key: dayKey(e.at), items: [e] });
  }
  // Сколько игры за день — по времени игры у первой и последней записи
  const dayPlay = (list) => {
    const times = list.map((e) => e.playtime).filter((x) => x > 0);
    return times.length > 1 ? formatPlaytime(Math.max(...times) - Math.min(...times), t) : '';
  };

  const text = (e) => {
    if (e.kind === 'map') return <>{e.label || e.map || '—'}<MetaLine as="small" parts={[t.path_new_place, timeOf(e.at, lang)]} /></>;
    if (e.kind === 'choice') {
      return (
        <>
          «{e.label || '…'}»{e.answer || e.cancel ? <> → <em>{e.cancel ? t.path_cancel : e.answer}</em></> : null}
          <MetaLine as="small" parts={[e.map, timeOf(e.at, lang)]} />
        </>
      );
    }
    if (e.kind === 'battle') return <>{t.path_battle(e.label || '—', e.count || 1)}<MetaLine as="small" parts={[e.map, timeOf(e.at, lang)]} /></>;
    if (e.kind === 'shot') return <>{e.label || t.path_shot}<MetaLine as="small" parts={[t.path_shot, e.map, timeOf(e.at, lang)]} /></>;
    return <>{e.label ? `«${e.label}»` : t.path_scene}<MetaLine as="small" parts={[e.map, timeOf(e.at, lang)]} /></>;
  };
  const pic = (e) => {
    if (e.kind === 'scene' && e.thumb) return <img className="path-thumb" src={api(game.id, `/${e.id}/thumb`)} alt="" loading="lazy" onError={(ev) => { ev.currentTarget.style.display = 'none'; }} />;
    if (e.kind === 'shot' && e.mark) return <img className="path-thumb" src={`/api/marks/${encodeURIComponent(game.id)}/${e.mark}/thumb`} alt="" loading="lazy" onError={(ev) => { ev.currentTarget.style.display = 'none'; }} />;
    return null;
  };
  const playFrom = (e) => {
    const id = e.kind === 'shot' ? e.mark : e.point;
    return id && alive.has(id) ? id : '';
  };

  return (
    <div className="path">
      <div className="path-top">
        <div className="path-stats">
          {formatPlaytime(game.playtime, t) && <span><b>{formatPlaytime(game.playtime, t)}</b>{t.path_played}</span>}
          <span><b>{count('map')}</b>{t.path_places}</span>
          <span><b>{count('scene')}</b>{t.path_scenes}</span>
          <span><b>{count('choice')}</b>{t.path_choices}</span>
        </div>
        <div className="path-chips" role="group" aria-label={t.shots_filter}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className={`chip${filter === f ? ' active' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}
              disabled={f !== 'all' && !count(f)}>
              {t.path_filter[f]}
            </button>
          ))}
        </div>
      </div>
      <div className={roomData ? 'path-cols' : ''}>
      <div>
      {days.map((day) => (
        <section key={day.key}>
          <div className="path-day"><h4>{dayLabel(day.items[0].at, t, lang)}</h4>{dayPlay(day.items) && <span>{t.shots_playtime(dayPlay(day.items))}</span>}</div>
          <ol className="path-line">
            {day.items.map((e) => {
              const Icon = ICON[e.kind] || IconPin;
              const from = playFrom(e);
              return (
                <li key={e.id} className={`path-step ${e.kind}`}>
                  <span className="path-ic"><Icon /></span>
                  {pic(e)}
                  <span className="path-txt">{text(e)}</span>
                  {from && <button type="button" className="path-play" onClick={() => onPlay({ mark: from })}><IconPlay />{t.shots_play}</button>}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      </div>
      {roomData && <RoomPanel room={roomData} t={t} lang={lang} />}
      </div>
    </div>
  );
};

export default PathPanel;
