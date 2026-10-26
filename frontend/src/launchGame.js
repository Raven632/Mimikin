import { httpError } from './apiError';
import { hideOnLeave } from './coversHidden';
import { layersOpen } from './layers';
import { mood } from './mimicMood';

// Запуск игры: отмечаем время и открываем игру.
// Общий код для модалки и блока «Продолжить»: иначе отметка времени
// разойдётся между ними при первой же правке.
//
// Игра живёт на своём адресе (сервер игр, api/src/routes/play.js): её код чужой и не должен
// работать с входом библиотеки. Адрес с ключом этой игры даёт сервер; открывает его рамка на весь
// экран (GameFrame) — событием rpg-play, его слушает App. Так страница-приложение на айфоне
// остаётся собой: переход на другой адрес открыл бы игру во встроенном браузере с его панелью.
// По-старому (GAME_ISOLATION=off) сервер отвечает mode: 'page' — переходим на страницу игры.
// Не вышло — ошибка с кодом ответа: текст для человека по ней делает errorText (apiError.js)
// mark — открыть сразу на моменте (rpg-fixes, setupSceneMarks), slot — на сейве игры (ключ слота, setupSlotLaunch):
// игра загрузит его вместо титула. Включено «Прятать, когда сворачиваю» — игра открывается уже скрытой (hide=1)
// Запрос на запуск, который можно оборвать (withIntro / cancelLaunch): сервер завис, а человек смотрит в чёрный экран
let launchAbort = null;

export async function launchGame(game, onUpdate, { mark = '', slot = '' } = {}) {
  const lastPlayed = Date.now();
  // Тот же сигнал на отметку времени и на запуск: сервер завис на любом из них — Escape обрывает
  const signal = launchAbort?.signal;
  try {
    await fetch(`/api/games/${encodeURIComponent(game.id)}/meta`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastPlayed })
    });
    onUpdate?.({ ...game, lastPlayed });
  } catch {
    // Не смогли отметить — это не повод не запускать игру
  }

  // Язык меню в игре: у сервера игр своё хранилище, выбранного языка там не видно
  const lang = localStorage.getItem('rpg_lang') || 'ru';
  const res = await fetch(`/api/play/${encodeURIComponent(game.id)}`, { method: 'POST', signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);

  if (data.mode === 'frame') {
    const origin = data.origin || `${window.location.protocol}//${window.location.hostname}:${data.port}`;
    const url = `${origin}${data.path}?lang=${lang}&lib=${encodeURIComponent(`${window.location.origin}/`)}${mark ? `&mark=${encodeURIComponent(mark)}` : ''}${slot ? `&slot=${encodeURIComponent(slot)}` : ''}${hideOnLeave() ? '&hide=1' : ''}`;
    window.dispatchEvent(new CustomEvent('rpg-play', { detail: { game, url, origin } }));
    return;
  }

  // В dev страницу отдаёт Vite (:5173), а игры — бэкенд на своём порту
  window.location.href = import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:${import.meta.env.VITE_BACKEND_PORT}${data.path}?lang=${lang}`
    : data.path;
}

// «Играть»: обложка растёт в экран игры (LaunchIntro, App) параллельно с запросом — сразу на нажатии, пока
// сервер ещё думает. Не вышло — слой убираем тут же, ошибку показывает тот, кто вызвал. Обложки не видно
// (нет картинки, она за краем) — запуск как раньше, без перехода. run — всё, что идёт до открытия игры
export async function withIntro(game, from, run) {
  if (!from) return run();
  // Мимик в шапке глотает: захлопнулся и прикрыл. Открыто окно (игры, «Во что поиграть?») — шапка под затемнением, не глотает
  mood.gulp(layersOpen());
  const ctl = new AbortController();
  launchAbort = ctl;
  window.dispatchEvent(new CustomEvent('rpg-intro', { detail: { game, from } }));
  try {
    return await run();
  } catch (e) {
    window.dispatchEvent(new Event('rpg-intro-end'));
    // Человек сам отменил (Escape на чёрном экране) — это не ошибка, тост не нужен
    if (ctl.signal.aborted) return undefined;
    throw e;
  } finally {
    if (launchAbort === ctl) launchAbort = null;
  }
}

// Отменить запуск, который ещё ждёт ответа сервера
export const cancelLaunch = () => launchAbort?.abort();
// Сигнал текущего запуска: loadResume до launchGame тоже должен обрываться
export const launchSignal = () => launchAbort?.signal;
