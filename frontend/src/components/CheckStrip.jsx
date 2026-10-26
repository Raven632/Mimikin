import { currentStep } from '../checkSummary';

// Полоса под шапкой, пока идёт полная проверка библиотеки: её ход виден и с закрытым окном ревизии.
// Нажатие открывает ревизию, где шаги расписаны подробно (LibraryCheck)
const CheckStrip = ({ check, t, onOpen }) => {
  const now = currentStep(check);
  if (!now) return null;
  const { step, index, count } = now;
  const pct = step.status === 'running' && step.total ? Math.min(100, Math.round((step.done / step.total) * 100)) : null;
  return (
    <button type="button" className="check-strip" onClick={onOpen}>
      <span>
        {t.check_strip(index + 1, count, t.check_steps[step.key])}
        {pct !== null && <span className="check-strip-count">{t.check_of(step.done, step.total)}</span>}
        {check.cancelling && <span className="check-strip-count">{t.check_cancelling}</span>}
      </span>
      <span className={`check-bar${pct === null ? ' indeterminate' : ''}`} aria-hidden="true">
        <span style={pct === null ? undefined : { width: `${pct}%` }} />
      </span>
    </button>
  );
};

export default CheckStrip;
