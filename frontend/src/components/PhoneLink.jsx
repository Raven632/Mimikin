import { useMemo, useRef } from 'react';
import { generate } from 'lean-qr';
import { toSvgPath } from 'lean-qr/extras/svg';
import { useLayer } from '../layers';
import { useClosing } from '../useClosing';
import { IconClose } from './icons';

// Такие адреса на телефоне ведут в сам телефон: код сработал бы, но открыл бы пустоту
const isLoopback = (host) => /^(localhost|.+\.localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(host);

// Рисуем векторно: при --zoom на больших экранах растровый код размылся бы, и камера его не прочла.
// Тихая зона в 4 клетки входит в сам рисунок — её требует стандарт QR
const QrCode = ({ text, label }) => {
  const { path, size } = useMemo(() => {
    const code = generate(text);
    return { path: toSvgPath(code), size: code.size };
  }, [text]);
  return (
    <svg className="phone-link-code" viewBox={`-4 -4 ${size + 8} ${size + 8}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <path d={path} />
    </svg>
  );
};

// Окно «Открыть на телефоне». В коде только origin: у него не бывает ни логина из адреса, ни параметров
// открытого окна, а вход телефон проходит сам. Подсказки зависят от протокола: Android по http не
// устанавливает приложение, только ярлык, поэтому обещать «без панелей» можно лишь по https
const PhoneLink = ({ t, onClose }) => {
  const ref = useRef(null);
  const [closing, close] = useClosing(onClose);
  useLayer(ref, close);
  const { origin, hostname, protocol, port } = window.location;
  const address = `${origin}/`;
  const secure = protocol === 'https:';
  return (
    <div className={`modal-overlay active pop${closing ? ' closing' : ''}`} onClick={close}>
      <div ref={ref} className="stats-content phone-link-content" role="dialog" aria-modal="true" aria-labelledby="phone-link-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-actions-top"><button type="button" className="modal-close" aria-label={t.close} data-tip={t.close} onClick={close}><IconClose /></button></div>
        <h2 id="phone-link-title" className="stats-title">{t.phone_title}</h2>
        {isLoopback(hostname)
          ? <p className="set-hint phone-link-local">{t.phone_local(`${protocol}//192.168.1.20${port ? `:${port}` : ''}`)}</p>
          : (
            <div className="phone-link-body">
              <div className="phone-link-side">
                <QrCode text={address} label={t.phone_code_label} />
                <p className="phone-link-address">{address}</p>
              </div>
              <div className="phone-link-hints">
                <div className="set-section">
                  <h3 className="set-update-title">iPhone</h3>
                  <p className="set-hint">{secure ? t.phone_iphone_https : t.phone_iphone_http}</p>
                </div>
                <div className="set-section">
                  <h3 className="set-update-title">Android</h3>
                  <p className="set-hint">{secure ? t.phone_android_https : t.phone_android_http}</p>
                </div>
                {!secure && <p className="set-hint">{t.phone_need_https}</p>}
                <p className="set-hint">{t.phone_login_note}</p>
              </div>
            </div>
          )}
      </div>
    </div>
  );
};

export default PhoneLink;
