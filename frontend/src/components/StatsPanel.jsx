import { useMemo } from 'react';
import { effectiveStatus } from '../gameStatus';
import { formatPlaytime } from '../formatPlaytime';
import StateView from './StateView';
import { FORMAT_TAGS } from '../formatTags';
import { IconStarSolid } from './icons';

// Горизонтальная полоса: подпись, шкала, число. Ширина — доля от максимума.
const Bar = ({ label, value, max, text }) => (
  <div className="stat-bar">
    <span className="stat-bar-label" data-tip={typeof label === 'string' ? label : undefined}>{label}</span>
    <span className="stat-bar-track">
      <span className="stat-bar-fill" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
    </span>
    <span className="stat-bar-value">{text || value}</span>
  </div>
);

// Теги формата, а не содержания. В библиотеке игр на RPG Maker они есть почти у всех («2dcg» —
// у 75 из 84) и в «Частых тегах» ничего не говорят. Убираем их оттуда, когда они у большинства игр,
// и называем строкой под заголовком — чтобы ничего не пропадало молча

// Вкладка «Статистика» окна «Статистика и ревизия» (LibraryModal): окно, крестик и Escape — там
const StatsPanel = ({ games, t, lang }) => {
  // Считаем один раз на изменение списка: перебор 80 игр дёшев, но в рендере он был бы на каждый чих
  const s = useMemo(() => {
    const tags = {};
    const byStatus = {};
    const byRating = {};
    const byMonth = {};

    games.forEach(g => {
      (g.tags || []).forEach(tag => { tags[tag] = (tags[tag] || 0) + 1; });
      if (g.rating > 0) byRating[g.rating] = (byRating[g.rating] || 0) + 1;
      const key = effectiveStatus(g) || 'none';
      byStatus[key] = (byStatus[key] || 0) + 1;
      if (g.addedAt) {
        const d = new Date(g.addedAt);
        const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        byMonth[m] = (byMonth[m] || 0) + 1;
      }
    });

    const byCount = (a, b) => b[1] - a[1];
    const formatTags = Object.entries(tags).filter(([tag, n]) => FORMAT_TAGS.has(tag) && n >= games.length / 2).sort(byCount);
    return {
      total: games.length,
      gb: games.reduce((a, g) => a + (g.size || 0), 0) / 1073741824,
      seconds: games.reduce((a, g) => a + (g.playtime || 0), 0),
      launched: games.filter(g => g.lastPlayed).length,
      rated: games.filter(g => g.rating > 0),
      byStatus,
      byRating,
      topTags: Object.entries(tags).filter(([tag]) => !formatTags.some(([f]) => f === tag)).sort(byCount).slice(0, 10),
      formatTags,
      topPlayed: games.filter(g => g.playtime >= 60).sort((a, b) => b.playtime - a.playtime).slice(0, 5),
      months: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).slice(-12),
    };
  }, [games]);

  const statusOrder = ['playing', 'done', 'dropped', 'wish', 'new', 'none'];
  const statusLabel = (k) => (k === 'none' ? t.stats_none : t[`status_${k}`]);
  const maxRating = Math.max(...Object.values(s.byRating), 1);
  const maxTag = s.topTags[0]?.[1] || 1;
  const maxPlayed = s.topPlayed[0]?.playtime || 1;
  const maxMonth = Math.max(...s.months.map(([, n]) => n), 1);
  const avg = s.rated.length ? (s.rated.reduce((a, g) => a + g.rating, 0) / s.rated.length).toFixed(1) : '—';
  const locale = lang === 'en' ? 'en-US' : lang === 'de' ? 'de-DE' : 'ru-RU';
  // «05» ничего не говорит. Показываем название месяца, а год — только когда он меняется,
  // иначе двенадцать одинаковых «26» просто съедают место.
  const monthLabel = (key, prevKey) => {
    const [y, m] = key.split('-');
    const name = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(locale, { month: 'short' });
    return prevKey && prevKey.slice(0, 4) === y ? name : `${name} ${y.slice(2)}`;
  };
  
  // В пустой библиотеке считать нечего: нули и пустые графики только путают
  if (!games.length) return <StateView title={t.stats_empty} hint={t.stats_empty_hint} />;

  return (
    <>
        {/* Сводной плитки нет: итог каждого раздела стоит справа в его заголовке */}
        <h3 className="stats-section stats-section-first">
          {t.stats_library}
          <span className="stats-section-n">{t.stats_games_n(s.total)}<small>{s.gb.toFixed(1)} GB</small></span>
        </h3>
        {/* Статусы одной полосой, как диск в «Месте». Пять долей различаются заливкой, а не только оттенком
            золота (оттенки на тёмном сливались): сплошная, светлая, тёмная, контур, штриховка */}
        <div className="stats-split" role="img" aria-label={statusOrder.filter(k => s.byStatus[k]).map(k => `${statusLabel(k)} ${s.byStatus[k]}`).join(', ')}>
          {statusOrder.filter(k => s.byStatus[k]).map(k => (
            <i key={k} className={`stats-split-part st-${k}`} style={{ flexGrow: s.byStatus[k] }} data-tip={`${statusLabel(k)}: ${s.byStatus[k]}`} />
          ))}
        </div>
        <ul className="stats-legend">
          {statusOrder.filter(k => s.byStatus[k]).map(k => (
            <li key={k}><i className={`stats-legend-mark st-${k}`} aria-hidden="true" />{statusLabel(k)} <b>{s.byStatus[k]}</b></li>
          ))}
        </ul>

        {s.seconds > 0 && (
          <>
            <h3 className="stats-section">{t.stats_time}<span className="stats-section-n">{formatPlaytime(s.seconds, t)}</span></h3>
            {s.topPlayed.map(g => (
              <Bar key={g.id} label={g.displayTitle || g.title} value={g.playtime} max={maxPlayed} text={formatPlaytime(g.playtime, t)} />
            ))}
            <p className="stats-after">{t.stats_launched_line(s.launched, s.total)}</p>
          </>
        )}

        {s.rated.length > 0 && (
          <>
            <h3 className="stats-section">
              {t.stats_ratings}
              <span className="stats-section-n">{t.stats_games_n(s.rated.length)}<small>{t.stats_rated_avg(avg)}</small></span>
            </h3>
            {[5, 4, 3, 2, 1].filter(n => s.byRating[n]).map(n => (
              <Bar key={n} label={<span className="stats-stars" role="img" aria-label={`${n}`}>{[1, 2, 3, 4, 5].map(i => <span key={i} className={i <= n ? '' : 'off'}><IconStarSolid /></span>)}</span>}
                value={s.byRating[n]} max={maxRating} />
            ))}
          </>
        )}

        <h3 className="stats-section">{t.stats_top_tags}</h3>
        {s.formatTags.length > 0 && (
          <div className="audit-hint">{t.stats_tags_format(s.formatTags.map(([tag, n]) => `${tag} ${n}`).join(', '))}</div>
        )}
        {s.topTags.map(([tag, n]) => <Bar key={tag} label={tag} value={n} max={maxTag} />)}

        <h3 className="stats-section">{t.stats_by_month}</h3>
        <div className="stats-months">
          {s.months.map(([month, n], i) => (
            <div key={month} className="stats-month" data-tip={`${month}: ${n}`}>
              <span className="stats-month-bar" style={{ height: `${(n / maxMonth) * 100}%` }} />
              <span className="stats-month-num">{n}</span>
              <span className="stats-month-label">{monthLabel(month, s.months[i - 1]?.[0])}</span>
            </div>
          ))}
        </div>
    </>
  );
};

export default StatsPanel;
