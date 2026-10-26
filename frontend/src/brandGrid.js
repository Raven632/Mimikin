// Сетка знака Mimikin 16×16 — одна на шапку (components/BrandMark.jsx) и плашку загрузки (TransferBar.jsx)
export const MIMIC_GRID = [
  '................',
  '...##########...',
  '..############..',
  '.##############.',
  '.##############.',
  '..#.#.#..#.#.#..',
  '................',
  '....##....##....',
  '................',
  '...#.#.##.#.#...',
  '.##############.',
  '.######..######.',
  '.######..######.',
  '.##############.',
  '.##############.',
  '................',
];

// Кадры мимика для движения. Тот же знак, но глаза — своим символом «o» (тело — «#»): их красят отдельно
// (светлее тела) и в следующих кадрах двигают. MIMIC_GRID выше не тронут: на нём шапка и плашка загрузок.
//   OPEN  — открыт, ждёт          BLINK — моргнул (глаз нет)       LOOK — глянул вправо
//   HALF  — прикрыл (крышка ниже) SHUT  — захлопнул: значит «готово», в ожидании его нет
const withRow = (grid, y, row) => grid.map((r, i) => (i === y ? row : r));
const EYES_AT = 7;
export const OPEN = withRow(MIMIC_GRID, EYES_AT, '....oo....oo....');
export const BLINK = withRow(OPEN, EYES_AT, '................');
export const LOOK = withRow(OPEN, EYES_AT, '...oo....oo.....');
export const HALF = [
  '................', '................', '................',
  '...##########...', '..############..', '.##############.', '.##############.', '..#.#.#..#.#.#..',
  '................', '...#.#.##.#.#...', '.##############.', '.######..######.', '.######..######.',
  '.##############.', '.##############.', '................',
];
export const SHUT = [
  '................', '................', '................', '................', '................',
  '...##########...', '..############..', '.##############.', '.##############.', '..############..',
  '.##############.', '.######..######.', '.######..######.', '.##############.', '.##############.', '................',
];

// Подряд идущие клетки строки — одним прямоугольником пути: без щелей между клетками при любом масштабе
export const gridPath = (grid, chars, ox = 0) => {
  let d = '';
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (!chars.includes(row[x])) continue;
      let end = x;
      while (end + 1 < row.length && chars.includes(row[end + 1])) end += 1;
      d += `M${ox + x} ${y}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });
  return d;
};

// ---- Живой мимик в шапке (mimicMood.js, BrandMark live). Кадры по спецификации «номер 8»: только смены кадра ----
// Глаза всегда на ряду 7: ниже на клетку они срастаются с нижними зубами и читаются как клыки
const NO_EYES = '................';
const EYE_ROW = '....oo....oo....';
const shiftRow = (s, dx) => (dx > 0 ? '.'.repeat(dx) + s.slice(0, 16 - dx) : dx < 0 ? s.slice(-dx) + '.'.repeat(-dx) : s);
const eyesAt = (g, dx) => withRow(g, EYES_AT, shiftRow(EYE_ROW, dx));
export const noEyes = (g) => g.map((r) => r.replaceAll('o', '.'));
// Наведение: крышка на ряд выше. Сон: на ряд ниже и без глаз
export const WIDE = [...OPEN.slice(1, 6), NO_EYES, ...OPEN.slice(6)];
export const SLEEP = [NO_EYES, NO_EYES, ...OPEN.slice(1, 6), NO_EYES, NO_EYES, ...OPEN.slice(9)];
export const HOP = [...SHUT.slice(1), NO_EYES];
// Ночь: крышка ниже, как во сне, глаза под самым её краем. Зубов прямо над глазами нет — иначе они срастаются с ними в клыки
const nightTeeth = (dx) => [...OPEN[5]].map((c, x) => ([4, 5, 10, 11].includes(x - dx) ? '.' : c)).join('');
const drowsy = (dx) => withRow(withRow(SLEEP, 6, nightTeeth(dx)), EYES_AT, shiftRow(EYE_ROW, dx));
// Крышка — ряды над глазами (0–6): ошибка сдвигает её на клетку, глаза и низ на месте
const lidShift = (g, dx) => g.map((r, i) => (i < 7 ? shiftRow(r, dx) : r));

const LIVE = {
  OPEN, BLINK, HALF, SHUT, SLEEP, HOP, W: WIDE,
  L: eyesAt(OPEN, -1), R: eyesAt(OPEN, 1), WL: eyesAt(WIDE, -1), WR: eyesAt(WIDE, 1),
  D: drowsy(0), DL: drowsy(-1), DR: drowsy(1),
};
// Имя кадра → сетка. Составные: «B:R» — R без глаз (моргнул), «K-:DR» / «K+:DR» — крышка на клетку влево / вправо
const cache = new Map();
export const liveGrid = (name) => {
  let g = cache.get(name);
  if (g) return g;
  const [op, base] = name.includes(':') ? name.split(':') : ['', name];
  g = LIVE[base];
  if (op === 'B') g = noEyes(g);
  else if (op === 'K-') g = lidShift(g, -1);
  else if (op === 'K+') g = lidShift(g, 1);
  cache.set(name, g);
  return g;
};

// Поверх кадра: монета («готово», за телом, --gold-light) и обложка (секрет, поверх тела, --text). Клетки той же
// сетки, могут лежать за её краем (svg знака с запасом: viewBox −2 −4 24 22). hi — монета над поднятой крышкой (W)
// на клетку выше. Монета не падает и не отскакивает: поднимается и пропадает на вершине
const box = (x, y, w, h) => `M${x} ${y}h${w}v${h}h${-w}z`;
export const OVERLAYS = {};
[[7, 2, 2], [7, 0, 2], [8, -1, 1], [8, -2, 2], [9, -2, 1]].forEach(([x, y, w], i) => {
  OVERLAYS[`c${i}`] = { coin: true, d: box(x, y, w, 2), hi: box(x, y - 1, w, 2) };
});
[[7, 5], [13, 5], [16, 6], [18, 9]].forEach(([x, y], i) => { OVERLAYS[`p${i}`] = { coin: false, d: box(x, y, 2, 3) }; });
