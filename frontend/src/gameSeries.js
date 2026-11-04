// Серии игр. Считаем в браузере по списку, который страница уже получила: человеку приходят только его игры, поэтому скрытую часть
// нельзя ни посчитать, ни назвать. По этой же причине сервер серий не считает и ни в каком ответе их не отдаёт.
// games.series — поправка владельца: '' — узнаём сами, 'none' — не в серии, иначе имя серии, и оно главнее узнанного.
// Правило про номер в конце названия повторяет numberAfter из api/src/utils/audit.js: из браузера сервер не достать

const KANJI = '一二三四五六七八九十';
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const NOT_WORD = '(?<![\\p{L}\\p{N}])';

const VERSION = [
  new RegExp(`${NOT_WORD}[\\[(]?(?:v|ver|version)\\.?\\s*\\d+(?:\\.\\d+)*[a-z]?[\\])]?$`, 'iu'),
  new RegExp(`${NOT_WORD}[\\[(]?\\d+(?:\\.\\d+)+[a-z]?[\\])]?$`, 'iu'),
];
// Голая римская цифра в конце. Одиночная x, v, i может быть и просто словом: «Project X», «Generation X» (см. sure)
const BARE_ROMAN = /(?<=\s)(i{1,3}|iv|vi{0,3}|ix|x)$/iu;
const MARKS = [
  new RegExp(`${NOT_WORD}(?:part|vol|volume|ep|episode|chapter)\\.?\\s*(\\d{1,2}|[ivx]+)$`, 'iu'),
  new RegExp(`第\\s*(\\d{1,2}|[${KANJI}]+)\\s*[話话章部巻卷作弾弹期幕編编]?$`, 'u'),
  // Без пробела тоже: «魔法少女2», «Garden2». Больше двух цифр — уже не номер части: «Project 2025»
  /(?<![\d.])(\d{1,2})$/u,
  BARE_ROMAN,
];
const SUBTITLE = /\s*[~〜]|\s-\s|:\s/u;
const TAIL = /[\s\-–—:~〜._,]+$/u;

const trimTail = (s) => s.replace(TAIL, '');
const noVersion = (s) => trimTail(VERSION.reduce((out, re) => out.replace(re, ''), trimTail(s)));

function numberOf(mark) {
  if (/^\d+$/.test(mark)) return Number(mark);
  const roman = ROMAN[mark.toLowerCase()];
  if (roman) return roman;
  // Японские: 二 — 2, 十二 — 12
  const digits = [...mark].map((c) => KANJI.indexOf(c) + 1);
  if (!digits.length || digits.includes(0)) return null;
  return digits.length === 1 ? digits[0] : digits[0] === 10 ? 10 + digits[1] : digits[0] * 10 + (digits[1] === 10 ? 0 : digits[1]);
}

function cutMark(s) {
  for (const re of MARKS) {
    const m = re.exec(s);
    const part = m && numberOf(m[1]);
    if (part) return { rest: s.slice(0, m.index), part, marked: true, weak: re === BARE_ROMAN && m[1].length === 1 };
  }
  return null;
}

// Название без номера части и подзаголовка. Сначала номер всей строки (Name: Part 2), потом номер перед подзаголовком (Name 2 ~Spring~)
function parseTitle(title) {
  const clean = noVersion(String(title || '').normalize('NFKC').trim());
  const whole = cutMark(clean);
  const head = (s) => noVersion(s.split(SUBTITLE)[0]);
  if (whole) return { ...whole, base: head(whole.rest) };
  const first = head(clean);
  const inner = cutMark(first);
  return inner ? { ...inner, base: trimTail(inner.rest) } : { base: first, part: 1 };
}

const keyOf = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const nameOf = (g) => g.displayTitle || g.title || g.id;

// Имя для ручной серии, когда своего у игры ещё нет
export const seriesName = (game) => (parseTitle(nameOf(game)).base || nameOf(game)).slice(0, 120);

const dateOf = (g) => { const at = Date.parse(g.releaseDate || ''); return Number.isNaN(at) ? Infinity : at; };
const inOrder = (a, b) => a.part - b.part || dateOf(a.game) - dateOf(b.game) || (a.game.addedAt || 0) - (b.game.addedAt || 0) || a.game.id.localeCompare(b.game.id);

// Кто с кем: разработчик сравнивается, только когда известен у обоих. Неизвестный при единственном известном — с ним; при нескольких
// разных непонятно, с кем, и такие остаются своей кучкой
function byDeveloper(rows) {
  const known = new Map();
  const unknown = [];
  for (const row of rows) {
    const dev = keyOf(row.game.developer);
    if (!dev) unknown.push(row);
    else known.set(dev, [...(known.get(dev) || []), row]);
  }
  if (known.size <= 1) return [[...[...known.values()].flat(), ...unknown]];
  return [...known.values(), unknown].filter((group) => group.length);
}

const devsOf = (rows) => rows.map((row) => keyOf(row.game.developer)).filter(Boolean);
// Неизвестный разработчик у одной из игр ручной серии не открывает её для всех: сравниваем тех, кто известен, как и в byDeveloper
const fits = (rows, manual) => {
  const theirs = devsOf(rows);
  const ours = devsOf(manual);
  return !theirs.length || !ours.length || theirs.some((dev) => ours.includes(dev));
};

// Слово на конце похоже на номер («Project X»): номером считаем, только если рядом есть часть с другим номером. Просто «Project» не довод
const sure = (rows) => rows.filter((row) => !row.weak || rows.some((other) => other !== row && other.marked && other.part !== row.part));

// { id игры → { name, manual, parts: [игры по порядку], at, of } }. Только настоящие серии: одной части в ответе нет
export function detectSeries(games) {
  const manual = new Map();
  const auto = new Map();
  for (const game of games) {
    if (game.series === 'none') continue;
    const row = { game, ...parseTitle(nameOf(game)) };
    const key = keyOf(game.series || row.base);
    const into = game.series ? manual : auto;
    if (!into.has(key)) into.set(key, []);
    into.get(key).push(row);
  }

  const result = new Map();
  const add = (rows, name, isManual) => {
    rows.sort(inOrder);
    // Совпавший номер — копия, а не ещё одна часть: одно место в счёте и в списке. Исключение — игры, которые владелец сам внёс в серию:
    // номера в их названиях могут совпасть, а частями их назвал он
    const slots = [];
    for (const row of rows) {
      const last = slots.at(-1);
      if (last && last[0].part === row.part && (!isManual || row.joined || last.every((x) => x.joined))) last.push(row);
      else slots.push([row]);
    }
    if (slots.length < 2) return;
    slots.forEach((slot, i) => {
      for (const row of slot) {
        // На своём месте — эта копия: иначе в её окне текущая часть не была бы отмечена
        const parts = slots.map((other) => (other === slot ? row.game : other[0].game));
        result.set(row.game.id, { name, manual: isManual, parts, at: i + 1, of: slots.length });
      }
    });
  };

  for (const [key, rows] of auto) {
    for (const group of byDeveloper(rows).map(sure)) {
      if (!group.length) continue;
      // Владелец уже назвал серию так же, как зовутся эти части: добавив игру к узнанной серии, он не должен её разбить
      const named = manual.get(key);
      if (named && fits(group, named)) { named.push(...group.map((row) => ({ ...row, joined: true }))); continue; }
      // Коротких имён слишком много совпадает случайно: «Eve 2» и «Eve»
      if ((key.match(/\p{L}/gu) || []).length >= 4) add(group, group[0].base, false);
    }
  }
  for (const rows of manual.values()) add(rows, rows.find((row) => row.game.series)?.game.series, true);
  return result;
}
