import { useEffect, useMemo, useState } from 'react';
import { getCoverUrl } from '../coverUrl';
import StateView from './StateView';

// Выбор одной игры по обложкам, как в «Игры» на странице человека. Сразу не отвечаем: мимо обложки легко попасть, а выбор что-то меняет.
// label — подпись кнопки, not — игра, которой в списке быть не должно
const PickGame = ({ t, busy, onPick, onCancel, label, not }) => {
  const R = t.pick_game;
  const [games, setGames] = useState(null);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/api/games').then((r) => (r.ok ? r.json() : [])).then((list) => { if (alive) setGames(list); }, () => { if (alive) setGames([]); });
    return () => { alive = false; };
  }, []);
  const nameOf = (g) => g.displayTitle || g.title;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (games || []).filter((g) => g.id !== not && (!q || nameOf(g).toLowerCase().includes(q)));
  }, [games, query, not]);
  if (!games) return <StateView kind="loading" title={t.library_loading} />;
  return (
    <div className="req-pick">
      <div className="games-tools">
        <input type="search" className="games-search" value={query} placeholder={R.pick_search} aria-label={R.pick_search} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="meta-status-btn catalog-primary req-pick-save" disabled={busy || !sel} onClick={() => onPick(sel, games.find((g) => g.id === sel))}>{label || R.this_game}</button>
        <button type="button" className="meta-status-btn subtle" onClick={onCancel}>{R.pick_cancel}</button>
      </div>
      <ul className="games-covers">
        {shown.map((g) => {
          const cover = getCoverUrl(g);
          return (
            <li key={g.id}>
              <button type="button" className={`games-cover req-pick-game${sel === g.id ? ' on' : ''}`} aria-pressed={sel === g.id} data-game={g.id} onClick={() => setSel(g.id)}>
                <span className="games-cover-pic">{cover ? <img src={cover} alt="" loading="lazy" decoding="async" /> : <span className="games-cover-none" aria-hidden="true" />}</span>
                <span className="games-cover-name">{nameOf(g)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default PickGame;
