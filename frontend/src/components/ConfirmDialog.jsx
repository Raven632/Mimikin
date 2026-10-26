import { useEffect, useRef, useState } from 'react';
import { answer, setConfirmHost } from '../confirm';
import { useLayer } from '../layers';

// Окно подтверждения (см. confirm.js): заголовок-вопрос, название и обложка игры, что именно
// случится, и две кнопки. Фокус сразу на «Отмена»: Enter по привычке игру не удалит. Escape,
// жест «назад» и клик мимо окна — тоже «Отмена»
const ConfirmDialog = ({ request, t }) => {
  const ref = useRef(null);
  const cancel = () => answer(false);
  useLayer(ref, cancel, { focus: '.confirm-cancel' });
  return (
    <div className="modal-overlay active pop confirm-overlay" onClick={cancel}>
      <div
        ref={ref}
        className="confirm-box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={request.text ? 'confirm-text' : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {request.cover && <img className="confirm-cover" src={request.cover} alt="" />}
        <h2 id="confirm-title" className="confirm-title">{request.title}</h2>
        {request.name && <div className="confirm-name">{request.name}</div>}
        {request.text && <p id="confirm-text" className="confirm-text">{request.text}</p>}
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={cancel}>{request.cancelLabel || t.cancel}</button>
          <button type="button" className={`confirm-ok${request.danger ? ' danger' : ''}`} onClick={() => answer(true)}>
            {request.confirmLabel || t.confirm_ok}
          </button>
        </div>
      </div>
    </div>
  );
};

// Стоит в App один раз и показывает вопросы из confirm.js по одному
const ConfirmHost = ({ t }) => {
  const [request, setRequest] = useState(null);
  useEffect(() => {
    setConfirmHost(setRequest);
    return () => setConfirmHost(null);
  }, []);
  return request ? <ConfirmDialog key={request.id} request={request} t={t} /> : null;
};

export default ConfirmHost;
