import { useEffect, useMemo, useState } from 'react';
import { errorText, httpError } from '../apiError';
import { getCoverUrl } from '../coverUrl';
import StateView from './StateView';

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
}

// Вкладка «Игры» на странице человека: «все игры, и новые тоже» или только отмеченные — по обложкам. Новая игра у
// ограниченного человека не появляется сама, поэтому об этом сказано в подписи, а не в мелком шрифте. Список уходит на
// сервер целиком по «Сохранить»: пока не сохранено, человек видит прежнее. Снятая отметка ничего не стирает — сейвы и
// заметки скрытой игры лежат на месте и возвращаются вместе с игрой
const PersonGames = ({ t, person, showToast }) => {
  const P = t.set_people;
  const url = `/api/users/${encodeURIComponent(person.id)}/games`;
  const [games, setGames] = useState(null);
  const [saved, setSaved] = useState(null); // { limited, ids: Set } — как лежит на сервере
  const [limited, setLimited] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState(false); // «Выбрано N»: только отмеченные
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/games').then((r) => (r.ok ? r.json() : Promise.reject(new Error('games')))),
      fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error('access')))),
    ]).then(([list, acc]) => {
      if (!alive) return;
      const have = new Set(list.map((g) => g.id));
      // Игра из корзины в список не попадает: сервер такой id не примет; её строку доступа он сам не трогает при замене
      const ids = new Set((acc.games || []).filter((id) => have.has(id)));
      setGames(list);
      setSaved({ limited: !!acc.limited, ids });
      setLimited(!!acc.limited);
      setSel(new Set(ids));
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [url]);

  const nameOf = (g) => g.displayTitle || g.title;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (games || []).filter((g) => (!only || sel.has(g.id)) && (!q || nameOf(g).toLowerCase().includes(q)));
  }, [games, query, only, sel]);

  if (failed) return <StateView kind="error" title={P.games_error} />;
  if (!games || !saved) return <StateView kind="loading" title={t.library_loading} />;

  const dirty = limited !== saved.limited || sel.size !== saved.ids.size || [...sel].some((id) => !saved.ids.has(id));
  const toggle = (id) => setSel((cur) => { const next = new Set(cur); if (!next.delete(id)) next.add(id); return next; });
  const allShown = shown.length > 0 && shown.every((g) => sel.has(g.id));
  const markShown = () => setSel((cur) => {
    const next = new Set(cur);
    for (const g of shown) { if (allShown) next.delete(g.id); else next.add(g.id); }
    return next;
  });

  const save = async () => {
    setBusy(true);
    try {
      await call('PUT', url, { limited, games: [...sel] });
      setSaved({ limited, ids: new Set(sel) });
      showToast(P.games_saved(person.name), 'success');
    } catch (err) {
      showToast(errorText(t, err, { offline: t.srv_lost }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="set-section person-games" data-section="games">
      <label className="set-toggle">
        <span className="set-toggle-text">
          <span className="set-label">{P.games_all}</span>
          <span className="set-hint">{limited ? P.games_limited_hint(person.name) : P.games_all_hint(person.name)}</span>
        </span>
        <input type="checkbox" role="switch" checked={!limited} onChange={(e) => setLimited(!e.target.checked)} />
      </label>
      {limited && (
        <>
          <div className="games-tools">
            <input type="search" className="games-search" value={query} placeholder={P.games_search} aria-label={P.games_search}
              onChange={(e) => setQuery(e.target.value)} />
            <button type="button" className="games-chip" aria-pressed={!only} onClick={() => setOnly(false)}>{P.games_chip_all(games.length)}</button>
            <button type="button" className="games-chip" aria-pressed={only} onClick={() => setOnly(true)}>{P.games_chip_sel(sel.size)}</button>
            <button type="button" className="meta-status-btn" disabled={!shown.length} onClick={markShown}>{allShown ? P.games_unmark : P.games_mark}</button>
          </div>
          {sel.size === 0 && <p className="set-hint games-warn" role="status">{P.games_none(person.name)}</p>}
          {shown.length === 0 ? (
            <p className="set-hint">{games.length ? P.games_no_match : P.games_empty}</p>
          ) : (
            <ul className="games-covers">
              {shown.map((g) => {
                const cover = getCoverUrl(g);
                return (
                  <li key={g.id}>
                    <label className={`games-cover${sel.has(g.id) ? ' on' : ''}`}>
                      <span className="games-cover-pic">
                        {cover ? <img src={cover} alt="" loading="lazy" decoding="async" /> : <span className="games-cover-none" aria-hidden="true" />}
                      </span>
                      <input type="checkbox" className="sq-check" checked={sel.has(g.id)} onChange={() => toggle(g.id)} data-game={g.id} />
                      <span className="games-cover-name">{nameOf(g)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <div className="games-save">
        <button type="button" className="save-btn set-submit" disabled={busy || !dirty} onClick={save}>{P.games_save}</button>
        {limited && <span className="set-hint">{P.games_count(sel.size, games.length)}</span>}
      </div>
    </section>
  );
};

export default PersonGames;
