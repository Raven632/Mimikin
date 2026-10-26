import { useEffect, useRef, useState } from 'react';
import { historyLevel, useLayer } from '../layers';
import MimicLoader from './MimicLoader';
import { useDelayedShow } from '../useDelayedShow';

// Сколько ждать, пока игра отправит сейвы перед закрытием рамки (rpg-fixes ждёт до 5 секунд)
const LEAVE_WAIT_MS = 6000;

// Игра на весь экран в рамке. Сама игра — на сервере игр (другой адрес), поэтому до страницы
// библиотеки ей не дотянуться; говорим с ней только сообщениями и только с её адреса.
// Уход из игры: «В библиотеку» или «Выход» в игре — rpg-fixes присылает rpg:leave, когда сейвы
// долетели. Кнопка «Назад» браузера — сначала просим игру уйти (rpg:leave-request) и ждём ответа.
// Адрес страницы на время игры — «?play=<игра>»: обновили страницу — игра откроется снова.
// «Скрыть» (H): в игре rpg-fixes закрывает экран и ставит паузу, а нам присылает rpg:quiet — вкладку подписывает
// App (событие rpg-quiet). H, нажатая здесь, мимо рамки, — тоже ей: rpg:quiet-toggle
const GameFrame = ({ game, url, origin, onClose, holdLoader = false }) => {
  const frameRef = useRef(null);
  const boxRef = useRef(null);
  // Пока игра не прислала onLoad — на чёрном мимик 64 (через 250 мс, не меньше 400 мс). Исчезает сразу, без затухания
  const [loaded, setLoaded] = useState(false);
  const { busy: waiting } = useDelayedShow(!loaded);
  // Запуск с «Играть» (LaunchIntro): пока поверх идёт переход, мимика нет — его 250 мс отсчитываются от чёрного
  // экрана; а игра проявляется за 200 мс, когда переход ушёл и она загрузилась
  const [introduced] = useState(holdLoader);
  // Слой поверх окон (layers.js): Escape нужен самой игре — окну игры под рамкой он не достаётся.
  // Историю рамка ведёт сама (ниже), Tab — по игре
  useLayer(boxRef, () => {}, { history: false, escape: false, trap: false, focus: 'iframe' });
  // onClose у App новая на каждую отрисовку — держим последнюю, чтобы не перезапускать эффект
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    let done = false;
    let timer = null;
    // Закрыть рамку. Ушли кнопкой в игре — убираем и «?play=» из истории
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (window.history.state?.rpgPlay === game.id) window.history.back();
      onCloseRef.current();
    };
    const onMessage = (e) => {
      if (e.origin !== origin || e.source !== frameRef.current?.contentWindow) return;
      if (e.data?.type === 'rpg:leave') finish();
      if (e.data?.type === 'rpg:quiet') window.dispatchEvent(new CustomEvent('rpg-quiet', { detail: !!e.data.on }));
    };
    // Снимок (P) и перемотка (Backspace), нажатые мимо рамки, — тоже игре (rpg-fixes, setupSceneMarks)
    const RELAY = { KeyP: 'shot', Backspace: 'rewind' };
    const onKey = (e) => {
      if ((e.code !== 'KeyH' && !RELAY[e.code]) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      if (RELAY[e.code]) frameRef.current?.contentWindow?.postMessage({ type: 'rpg:key', action: RELAY[e.code] }, origin);
      else frameRef.current?.contentWindow?.postMessage({ type: 'rpg:quiet-toggle' }, origin);
    };
    // «Назад» в браузере: игра отправит сейвы и ответит rpg:leave; не ответила — закрываем сами
    const onPop = () => {
      if (done || window.history.state?.rpgPlay === game.id) return;
      frameRef.current?.contentWindow?.postMessage({ type: 'rpg:leave-request' }, origin);
      timer = setTimeout(finish, LEAVE_WAIT_MS);
    };

    if (window.history.state?.rpgPlay !== game.id) {
      const params = new URLSearchParams(window.location.search);
      params.set('play', game.id);
      // Уровень слоёв — тот же, что под рамкой: «назад» из игры не закрывает окно игры под ней
      window.history.pushState({ rpgPlay: game.id, rpgLayer: historyLevel() }, '', `${window.location.pathname}?${params}`);
    }
    window.addEventListener('message', onMessage);
    window.addEventListener('popstate', onPop);
    document.addEventListener('keydown', onKey);
    // Страница под игрой не прокручивается
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('keydown', onKey);
      // Игру закрыли скрытой — обложки так и остаются размытыми (App), но «как было до» забываем
      window.dispatchEvent(new CustomEvent('rpg-quiet', { detail: null }));
      document.body.style.overflow = overflow;
    };
  }, [game.id, origin]);

  return (
    <div ref={boxRef} className={`game-frame${introduced ? ' intro' : ''}${introduced && holdLoader ? ' holding' : ''}${introduced && loaded && !holdLoader ? ' revealed' : ''}`}>
      <iframe
        ref={frameRef}
        src={url}
        title={game.displayTitle || game.title || game.id}
        // Без allow-top-navigation: игра не уведёт страницу библиотеки. allow-same-origin — у игры
        // свой адрес (не библиотеки), ей нужно своё хранилище
        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox allow-orientation-lock"
        allow="fullscreen; autoplay; gamepad; screen-wake-lock"
        allowFullScreen
        onLoad={() => { setLoaded(true); frameRef.current?.focus(); }}
      />
      {waiting && !holdLoader && <div className="game-frame-wait"><MimicLoader size={64} /></div>}
    </div>
  );
};

export default GameFrame;
