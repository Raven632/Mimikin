// Кто вошёл: ответ GET /api/me, страница спрашивает его до первой отрисовки и после входа. Владелец видит всё, остальные
// люди — библиотеку, свои сейвы и заметки (api/src/utils/access.js); кнопки, которых для них нет, не рисуем, а
// запросы, на которые сервер ответит отказом, не шлём.
// Нет ответа (вход не выполнен, сервер не ответил) — считаем владельцем: показывать там всё равно нечего, а урезанный
// интерфейс у владельца после сбоя связи был бы хуже лишней кнопки, которую сервер всё равно не пропустит
let current = null;

export const currentMe = () => current;
export const isOwner = () => !current || current.isOwner;
// Четыре права человека (api/src/routes/auth.js). У владельца и без ответа — все, как и в isOwner
const ALL_RIGHTS = { request: true, download: true, upload: true, view: true };
export const rights = () => (isOwner() ? ALL_RIGHTS : current.rights || {});

export async function loadMe() {
  try {
    // Без срока зависший ответ оставил бы белый экран: main.jsx ждёт его до первой отрисовки
    const res = await fetch('/api/me', { signal: AbortSignal.timeout(8000) });
    current = res.ok ? await res.json() : null;
  } catch {
    current = null;
  }
  return current;
}

// В другой вкладке этого же браузера мог войти другой человек: кука одна на всех вкладок, а эта страница ещё показывает
// прежнего и отправила бы его заметку в чужую строку. Спрашиваем сервер, не трогая current: нет ответа — считаем, что тот же
export async function personChanged() {
  if (!current) return false;
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return false;
    const now = await res.json();
    return !!now?.id && now.id !== current.id;
  } catch {
    return false;
  }
}

// Запомненное страницей (поиск, вид, подборка, тег, статус, открытый хостинг) лежит в браузере одно на всех, кто в нём
// входит. Пока человек один, оно нужно как есть — «как оставил, так и застал». Когда рядом есть другие, при входе и
// выходе его стираем: иначе поиск одного оказывался бы в строке другого
const KEPT = ['rpg_search', 'rpg_view', 'rpg_libview', 'rpg_libsize', 'rpg_libtitles', 'rpg_libgroup', 'rpg_libshut', 'rpg_libviewrow', 'rpg_libfilters', 'rpg_list', 'rpg_tag', 'rpg_status'];
export function forgetPreferences() {
  if (!current?.shared) return;
  for (const store of [localStorage, sessionStorage]) {
    for (const key of KEPT) {
      try { store.removeItem(key); } catch { /* закрытое хранилище — нечего стирать */ }
    }
  }
}
