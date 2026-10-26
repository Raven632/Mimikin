import { SITES } from '../lookupLive';

// Список шагов: «Steam · по названию — нашли», последний — «ищем дальше…», пока поиск идёт
const LookupSteps = ({ steps, running, t }) => {
  if (!steps.length && !running) return null;
  return (
    <ul className="lookup-live" aria-live="polite">
      {steps.map((s, i) => (
        <li key={`${i}-${s.site}`} className={`lookup-step ${s.result}`}>
          <b>{SITES[s.site] || s.site}</b>
          {': '}
          {s.by === 'link' ? t.lookup_by_link : s.by === 'code' ? t.lookup_by_code(s.q) : t.lookup_by_title(s.q)}
          {', '}
          {t[`lookup_${s.result}`]}
        </li>
      ))}
      {running && <li className="lookup-step pending">{t.lookup_live_more}</li>}
    </ul>
  );
};

export default LookupSteps;
