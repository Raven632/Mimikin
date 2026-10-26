import { IconCheck, IconRefresh } from './icons';
import MimicLoader from './MimicLoader';

// Одно и то же «загружается / пусто / ошибка / всё хорошо» во всех окнах. Состояние стоит там, где
// начался бы список, слева и обычным текстом панели: без значка в кольце и без центровки (раньше
// полэкрана под кольцом пустовало, а на телефоне заглушка выглядела чужой). Мимик живёт только на
// первом запуске пустой библиотеки (Welcome).
//   loading — мимик 32 с подписью (MimicLoader): появляется через 250 мс, быстрый ответ не мигает
//   empty   — что здесь будет и как это сюда попадёт (hint); действие — ссылкой в children
//   error   — красная черта слева и «Ещё раз» рядом, если повтор имеет смысл (onRetry)
//   done    — проверили, всё в порядке
const StateView = ({ kind = 'empty', title, hint, onRetry, retryLabel, children }) => (
  <div className={`state state-${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-live="polite">
    {kind === 'loading' ? (
      <MimicLoader size={32}>
        <div>
          {title && <p className="state-title">{title}</p>}
          {hint && <p className="state-hint">{hint}</p>}
        </div>
      </MimicLoader>
    ) : (title || onRetry) && (
      <p className="state-title">
        {kind === 'done' && <IconCheck />}
        {title}
        {onRetry && <button type="button" className="state-retry" onClick={onRetry}><IconRefresh />{retryLabel}</button>}
      </p>
    )}
    {kind !== 'loading' && hint && <p className="state-hint">{hint}</p>}
    {children}
  </div>
);

export default StateView;
