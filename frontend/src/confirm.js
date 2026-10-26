// Подтверждение своим окном вместо window.confirm: в стиле библиотеки, с названием и обложкой игры,
// кнопкой своего цвета. Рисует окно ConfirmHost (components/ConfirmDialog.jsx, стоит в App), а здесь
// — только «спросить и дождаться ответа»:
//   if (!(await confirmDialog({ title, text, confirmLabel, danger: true }))) return;
// Вопросы по очереди: второй ждёт, пока ответят на первый
let host = null;
const queue = [];
let seq = 0;

export function confirmDialog(options) {
  return new Promise((resolve) => {
    queue.push({ ...options, resolve, id: ++seq });
    if (queue.length === 1) host?.(queue[0]);
    // Окна ещё нет на странице (такого быть не должно) — спрашиваем по-старому
    if (!host) answer(window.confirm([options.title, options.text].filter(Boolean).join('\n\n')));
  });
}

// Ответ на текущий вопрос — от ConfirmHost
export function answer(ok) {
  const current = queue.shift();
  current?.resolve(!!ok);
  host?.(queue[0] || null);
}

export function setConfirmHost(show) {
  host = show;
  if (show && queue[0]) show(queue[0]);
}
