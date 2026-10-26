import { useRef } from 'react';
import { useLayer } from '../layers';
import { useClosing } from '../useClosing';
import { IconClose } from './icons';

// Окно «Клавиши» — по «?», как на GitHub и в Gmail. Только то, что уже работает в библиотеке
const ROWS = [
  [['/'], 'key_search'],
  [['Esc'], 'key_escape'],
  [['←', '→'], 'key_arrows'],
  [['↑', '↓'], 'key_albums'],
  [['+', '−'], 'key_zoom'],
  [['Space'], 'key_space'],
  [['↑', '↓', 'Enter'], 'key_lists'],
  [['Tab'], 'key_tab'],
  [['H'], 'key_hide'],
  [['?'], 'key_help'],
];

const ShortcutsHelp = ({ t, onClose }) => {
  const ref = useRef(null);
  const [closing, close] = useClosing(onClose);
  useLayer(ref, close);
  return (
    <div className={`modal-overlay active pop${closing ? ' closing' : ''}`} onClick={close}>
      <div ref={ref} className="stats-content keys-content" role="dialog" aria-modal="true" aria-labelledby="keys-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-actions-top"><button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button></div>
        <h2 id="keys-title" className="stats-title">{t.keys_title}</h2>
        <dl className="keys-list">
          {ROWS.map(([keys, label]) => (
            <div key={label} className="keys-row">
              <dt>{keys.map((k) => <kbd key={k}>{k === 'Space' ? t.key_space_name : k}</kbd>)}</dt>
              <dd>{t[label]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
};

export default ShortcutsHelp;
