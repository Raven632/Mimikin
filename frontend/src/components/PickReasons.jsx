import { getCoverUrl } from '../coverUrl';
import { reasonRow } from '../pickReasons';
import RetryImg from './RetryImg';

const strong = (value, key) => <b key={key}>{value}</b>;

// Причины в окне «Во что поиграть?» — не список, а счёт: слева утверждение, справа его доказательство (обложка игры того же
// автора, теги). Первая причина крупнее: сначала читается она, остальные — подтверждение
const PickReasons = ({ reasons, cold, t, lang, games }) => {
  const rows = reasons.map((reason) => ({ reason, row: reasonRow(t, lang, reason, strong) })).filter((x) => x.row);
  return (
    <div className="pick-reasons">
      {cold && <div className="pick-reason"><p>{t.pick_cold}</p></div>}
      {!rows.length && !cold && <div className="pick-reason"><p>{t.pick_r.none}</p></div>}
      {rows.map(({ reason, row }, i) => {
        const proof = row.proof ? games.get(row.proof) : null;
        const cover = proof ? getCoverUrl(proof) : null;
        return (
          <div key={reason.code} className="pick-reason" data-code={reason.code}>
            <p className={i === 0 ? 'pick-lead' : undefined}>{row.text}</p>
            {cover && <RetryImg className="pick-proof" src={cover} alt="" loading="lazy" fallback={null} />}
            {row.tags && <span className="pick-tags">{row.tags.map((tag) => <span key={tag} data-tip={tag}>{tag}</span>)}</span>}
          </div>
        );
      })}
    </div>
  );
};

export default PickReasons;
