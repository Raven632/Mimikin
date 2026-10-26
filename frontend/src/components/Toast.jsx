// action — кнопка в тосте, например «Отменить» после удаления: { label, onClick }
const Toast = ({ message, type, visible, action }) => {
  return (
    <div className={`toast ${type} ${visible ? 'show' : ''}${action ? ' has-action' : ''}`} role="status" aria-live="polite">
      <span>{message}</span>
      {action && (
        <button type="button" className="toast-action" tabIndex={visible ? 0 : -1} onClick={action.onClick}>{action.label}</button>
      )}
    </div>
  );
};

export default Toast;
