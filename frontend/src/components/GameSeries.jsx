import { useState } from 'react';
import { getCoverUrl } from '../coverUrl';
import { seriesName } from '../gameSeries';
import PickGame from './PickGame';

const manualOf = (game) => (game?.series && game.series !== 'none' ? game.series : '');

// Выбор игры открывают и из меню «⋯», а он бывает ниже края окна
const reveal = (el) => el?.scrollIntoView({ block: 'nearest' });

// Блок «Серия» в окне игры (gameSeries.js). Угадывание по названиям может ошибиться, поэтому у владельца есть обе поправки.
// Без серии блока нет: «Добавить в серию» — в меню «⋯» (GameModal), поэтому adding живёт в окне
const GameSeries = ({ game, series, owner, adding, setAdding, t, onOpen, onChange }) => {
  const [busy, setBusy] = useState(false);
  if (!series && !adding) return null;
  const run = async (changes) => {
    setBusy(true);
    const ok = await onChange(changes);
    setBusy(false);
    if (ok) setAdding(false);
  };
  const add = (id, other) => {
    // Обе игры получают одно имя: своё, если серия уже названа, иначе имя второй игры, иначе название этой без номера
    const name = manualOf(game) || (series?.manual ? series.name : '') || manualOf(other) || seriesName(game);
    run([[game.id, name], [id, name]]);
  };
  const addButton = owner && !adding && (
    <button type="button" className="meta-status-btn subtle series-add" disabled={busy} onClick={() => setAdding(true)}>{t.series_add}</button>
  );
  return (
    <div className="game-series">
      {series && <div className="modal-section-label">{t.series_title}</div>}
      {series && (
        <ol className="series-parts">
          {series.parts.map((g) => {
            const cover = getCoverUrl(g, 360);
            const inner = (
              <>
                <span className="series-thumb">{cover && <img src={cover} alt="" loading="lazy" decoding="async" />}</span>
                <span className="series-name">{g.displayTitle || g.title}</span>
              </>
            );
            return (
              <li key={g.id}>
                {g.id === game.id
                  ? <div className="series-part current" aria-current="true" data-tip={t.series_current}>{inner}</div>
                  : <button type="button" className="series-part" data-game={g.id} onClick={() => onOpen(g.id)}>{inner}</button>}
              </li>
            );
          })}
        </ol>
      )}
      {owner && series && (
        <div className="series-tools">
          <button type="button" className="meta-status-btn subtle series-not" disabled={busy} onClick={() => run([[game.id, 'none']])}>{t.series_not}</button>
          {addButton}
        </div>
      )}
      {adding && <div ref={reveal}><PickGame t={t} busy={busy} label={t.series_add} not={game.id} onPick={add} onCancel={() => setAdding(false)} /></div>}
    </div>
  );
};

export default GameSeries;
