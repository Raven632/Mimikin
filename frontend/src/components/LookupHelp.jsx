import { useEffect, useState } from 'react';
import { timeAgo } from '../formatAgo';
import { linkIcon, siteName } from '../gameLinks';
import { httpError } from '../apiError';
import { IconChevronRight } from './icons';
import MetaLine from './MetaLine';

// Сайты журнала поиска — в том порядке, в каком их спрашивает поиск (services/scraper.js)
const SITES = { itch: 'itch.io', vndb: 'VNDB', steam: 'Steam' };
// Итог сайта — лучший из его шагов: нашёл, нашёл убранную руками, не ответил, ответил «нет»
const RANK = { found: 0, refused: 1, down: 2, none: 3 };

const getJson = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};

// Шаги журнала — по сайту строкой: «Steam · по названию «…» — такой игры нет, похожая «…» — 62%»
function siteLines(journal) {
  const bySite = new Map();
  for (const step of journal?.steps || []) {
    if (!bySite.has(step.site)) bySite.set(step.site, []);
    bySite.get(step.site).push(step);
  }
  return [...bySite.entries()].map(([site, steps]) => {
    const best = [...steps].sort((a, b) => (RANK[a.result] ?? 9) - (RANK[b.result] ?? 9))[0];
    const near = (journal.near || []).filter((n) => n.site === site).sort((a, b) => b.score - a.score)[0] || null;
    const asked = best.result === 'found' ? [best] : steps;
    return { site, best, near, asked };
  });
}

// «Как искали» и «Возможно, это она» — под строкой о неполных данных в окне игры. Журнал — с прошлого
// поиска (бесплатно): что спросили у каждого сайта и какие похожие игры поиск видел, но не принял.
// onPick(url) — «Это она»: ссылка добавляется к игре, и данные ищутся по ней (routes/games.js, /edit)
export default function LookupHelp({ game, t, lang, onPick }) {
  const [journal, setJournal] = useState(null);
  const [busy, setBusy] = useState('');
  const checkedAt = game.meta?.checkedAt || 0;

  // Журнал новый после каждого поиска — перечитываем, когда сменилось время проверки
  useEffect(() => {
    let alive = true;
    getJson(`/api/games/${encodeURIComponent(game.id)}/lookup`)
      .then((d) => { if (alive) setJournal(d.journal); }, () => { if (alive) setJournal(null); });
    return () => { alive = false; };
  }, [game.id, checkedAt]);

  const pick = async (url) => {
    setBusy(url);
    try { await onPick(url); } finally { setBusy(''); }
  };

  const lines = siteLines(journal);
  // Похожие — что поиск уже видел и отверг
  const maybe = journal?.near ?? [];
  const byLine = (by, q) => (by === 'link' ? t.lookup_by_link : t.lookup_by_title(q));

  return (
    <div className="lookup-help">
      {lines.length > 0 && (
        <details className="lookup-log">
          <summary><span className="set-sum-chev" aria-hidden="true"><IconChevronRight /></span>{t.lookup_log(timeAgo(journal.at, lang))}</summary>
          <ul>
            {lines.map(({ site, best, near, asked }) => (
              <li key={site} className={`lookup-step ${best.result}`}>
                <b>{SITES[site] || site}</b>
                {': '}
                {[...new Set(asked.map((s) => byLine(s.by, s.q)))].join(', ')}
                {', '}
                {best.result === 'found' && best.link
                  ? <a href={best.link} target="_blank" rel="noopener noreferrer">{t.lookup_found}</a>
                  : t[`lookup_${best.result}`]}
                {best.result !== 'found' && near && (
                  <>{'; '}<a href={near.link} target="_blank" rel="noopener noreferrer">{t.lookup_near(near.title, Math.round(near.score * 100))}</a></>
                )}
              </li>
            ))}
          </ul>
          {/* Сколько кредитов ScraperAPI стоил этот поиск и на какие сайты они ушли */}
          {journal.credits && (
            <p className="lookup-credits">
              {t.lookup_credits(Object.values(journal.credits).reduce((a, n) => a + n, 0),
                Object.entries(journal.credits).map(([site, n]) => `${SITES[site] || site} ${n}`).join(', '))}
            </p>
          )}
        </details>
      )}

      {maybe.length > 0 && (
        <div className="lookup-maybe">
          <div className="lookup-maybe-head"><b>{t.lookup_maybe}</b></div>
          <span className="meta-status-hint">{t.lookup_maybe_hint}</span>
          <ul className="lookup-candidates">
            {maybe.map((x) => (
              <li key={x.link}>
                {linkIcon(x.link) && <img className="lookup-site" src={linkIcon(x.link)} alt="" />}
                <a className="lookup-title" href={x.link} target="_blank" rel="noopener noreferrer" data-tip={x.title}>{x.title}</a>
                <MetaLine className="lookup-meta" parts={[siteName(x.link), x.creator, x.version, `${Math.round(x.score * 100)}%`]} />
                <button type="button" className="meta-status-btn" disabled={!!busy} onClick={() => pick(x.link)}>
                  {busy === x.link ? t.lookup_pick_busy : t.lookup_pick}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
