import { useRef, useState } from 'react';
import { useLayer } from '../layers';
import { useClosing } from '../useClosing';
import StatsPanel from './StatsPanel';
import AuditPanel from './AuditPanel';
import SpacePanel from './SpacePanel';
import { IconClose } from './icons';

// Статистика, ревизия и место — одно окно с вкладками. Все — о библиотеке целиком, и отдельными
// пунктами меню стояли бы рядом с тем, что нужно каждый день
const LibraryModal = ({ tab: initialTab = 'stats', games, t, lang, onClose, onOpenGame, check, onStartCheck, onCancelCheck }) => {
  const [tab, setTab] = useState(initialTab);

  // Escape и «назад» закрывают окно — как и остальные окна библиотеки (layers.js)
  const contentRef = useRef(null);
  // Закрытие — коротким исчезновением, как у окна игры
  const [closing, close] = useClosing(onClose);
  useLayer(contentRef, close);

  // Из ревизии — сразу к игре: окно закрываем, чтобы не заслоняло её
  const openGame = (id) => { onClose(); onOpenGame(id); };

  return (
    <div className={`modal-overlay active pop${closing ? ' closing' : ''}`} onClick={close}>
      <div ref={contentRef} className="stats-content" role="dialog" aria-modal="true" aria-label={t.stats_audit} tabIndex={-1} onClick={e => e.stopPropagation()}>
        <div className="modal-actions-top"><button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button></div>
        <div className="library-tabs" role="tablist">
          {[['stats', t.stats], ['audit', t.audit], ['space', t.space]].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`library-tab${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'stats' && <StatsPanel games={games} t={t} lang={lang} />}
        {tab === 'audit' && <AuditPanel t={t} lang={lang} games={games} onOpenGame={openGame} check={check} onStartCheck={onStartCheck} onCancelCheck={onCancelCheck} />}
        {tab === 'space' && <SpacePanel t={t} lang={lang} onOpenGame={openGame} />}
      </div>
    </div>
  );
};

export default LibraryModal;
