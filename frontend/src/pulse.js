// Отклик на нажатие: оценка, сердечко «в избранное», статус «вспыхивают» двумя кадрами цвета — видно, что нажатие принято,
// ещё до ответа сервера. Без увеличения и перелёта (кривая с отскоком читалась как «ИИшная»), только цвет по кадрам.
// Кадр — атрибут data-f, а не класс: React при смене className стёр бы класс посреди вспышки (оценка и сердечко
// перерисовываются сразу после нажатия), а атрибут, которого нет в его разметке, он не трогает. Цвета — game.css.
// Кто отключил анимации в системе — без движения: сразу конечное состояние
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const FRAME = 80; // --px-frame из base.css

let live = [];   // элементы с кадром сейчас
let timers = [];

function stop() {
  timers.forEach(clearTimeout);
  timers = [];
  live.forEach((el) => { el.removeAttribute('data-f'); el.removeAttribute('data-spark'); });
  live = [];
}

// els вспыхивают: f1 (почти белое) 80 мс, f2 (светлое золото) 80 мс. pressed (среди els) — нажатая: f1 держится 160 мс,
// потом f2 80 мс, и в первом кадре у неё искры крестом 2×2. Новая вспышка обрывает прежнюю на месте
export function flash(els, pressed = []) {
  stop();
  // Не нажали ни на что (фокус на странице целиком) — красить нечего
  const all = els.filter((el) => el && el !== document.body);
  if (!all.length || reduced()) return;
  const press = all.filter((el) => pressed.includes(el));
  const rest = all.filter((el) => !press.includes(el));
  live = all;
  const at = (n, fn) => timers.push(setTimeout(fn, FRAME * n));
  all.forEach((el) => el.setAttribute('data-f', '1'));
  press.forEach((el) => el.setAttribute('data-spark', ''));
  at(1, () => { press.forEach((el) => el.removeAttribute('data-spark')); rest.forEach((el) => el.setAttribute('data-f', '2')); });
  at(2, () => { rest.forEach((el) => el.removeAttribute('data-f')); press.forEach((el) => el.setAttribute('data-f', '2')); });
  at(3, stop);
}

// Звёзды оценки: вспыхивают только новые горящие (было from, стало n); при понижении — только нажатая
export function flashStars(group, selector, from, n) {
  if (!group || !(n > 0) || n === from) return;
  const stars = [...group.querySelectorAll(selector)];
  const pressed = stars[n - 1];
  flash(n > from ? stars.slice(from, n) : [pressed], [pressed]);
}
