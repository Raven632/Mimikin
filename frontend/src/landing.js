// Игра из загрузки встаёт на полку не сразу, а после финала плашки (Toolbar.jsx, TransferBar.jsx): сначала
// «В библиотеке» и плашка гаснет, потом полка сдвигается и у новой обложки вспыхивает рамка. Сервер сообщает
// о новой игре раньше (library-changed), поэтому, пока загрузка с плашкой не дошла до конца, полка новые
// игры придерживает (Shelves.jsx). Игра пришла без плашки (папка на сервере, другое устройство) — сразу
let waiting = 0;

export const landingBusy = () => waiting > 0;
// Загрузка нового архива пошла: игра на подходе
export const landingBegin = () => { waiting += 1; };
// Финал показан (или загрузка не удалась): отпускаем полку. id — папка игры, если сервер её назвал
export const landingEnd = (id) => {
  waiting = Math.max(0, waiting - 1);
  window.dispatchEvent(new CustomEvent('rpg-landed', { detail: { id: id || null } }));
};
