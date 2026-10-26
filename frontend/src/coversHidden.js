import { useSyncExternalStore } from 'react';

// Скрыты ли обложки (клавиша H, App.jsx ставит covers-hidden на .app-container). Окна-порталы в body (галереи,
// «Продолжить с») лежат вне контейнера и размывают себя сами — им нужно знать о H и тогда, когда они уже открыты,
// а не только в миг открытия: иначе нажали H в галерее — а размытие не спало
const isHidden = () => !!document.querySelector('.app-container.covers-hidden');

const subscribe = (onChange) => {
  const root = document.querySelector('.app-container');
  if (!root) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};

export const useCoversHidden = () => useSyncExternalStore(subscribe, isHidden);

// «Прятать, когда сворачиваю»: свернул вкладку или ушёл с неё — обложки размываются сами, как от H (App.jsx), а игра
// открывается уже скрытой (launchGame, &hide=1). Настройка своя у каждого устройства, по умолчанию выключена
export const hideOnLeave = () => {
  try { return localStorage.getItem('rpg_hide_leave') === '1'; } catch { return false; }
};
export const setHideOnLeave = (on) => {
  try { localStorage.setItem('rpg_hide_leave', on ? '1' : '0'); } catch { /* без хранилища настройка живёт до перезагрузки — не беда */ }
};
