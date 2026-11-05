// Покрытие адресов: каждый /api/… в коде интерфейса должен иметь строку в таблице демо (rec, mut, calc или off).
// Новый запрос, который никто не описал, иначе дошёл бы до демо ответом «404 demo: no such route» уже у посетителя;
// здесь он падает в CI с файлом и строкой. Запуск из корня репозитория: node tests/demo/coverage.mjs
//
// Как читается код. Адрес берётся из строки, которая начинается с «/api/»: до «?» или до закрывающей кавычки, а
// «${…}» внутри становится «:p» (один отрезок пути). Если после «${…}» путь кончается и перед ним нет «/»
// (`/api/telegram${url}`, `${base}/…`), дальше дописывает вызывающий: тогда достаточно, чтобы адрес был началом
// какой-нибудь строки таблицы. Метод ищется рядом (`method: 'X'`, `call('X'`); не нашёлся — подходит любой метод и начало адреса.
// Чего здесь нет по замыслу: картинки, звуки и видео (их отдаёт запись из boot.json по ключу, а не таблица) и плеер
// сцен — они перечислены в NO_ROUTE и в apiUrl.js, а правило eslint не даёт строить такие адреса в других местах.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'frontend/src');
const { routes } = await import(pathToFileURL(path.join(ROOT, 'frontend/demo/table.js')).href);

// Адреса без строки в таблице. Каждый — либо файл для <img>/<audio>/<video> (ключ mediaKey, ответ из media в boot.json),
// либо то, что ждёт этапа R4 (плеер сцен): тогда при появлении обработчика строку отсюда убрать
const NO_ROUTE = [
  [/^\/api\/gallery\/:p\/(thumb|image|audio|video|frame|rig-cover|tags)$/, 'картинка или звук галереи'],
  [/^\/api\/gallery\/:p\/scene$/, 'плеер сцен (R4)'],
  [/^\/api\/avatars\/:p$/, 'картинка'],
  [/^\/api\/marks\/:p\/:p\/(thumb|image|shot)$/, 'картинка момента'],
  [/^\/api\/journal\/:p\/:p\/thumb$/, 'картинка записи'],
  [/^\/api\/saves\/shot\/:p$/, 'картинка сохранения'],
  [/^\/api\/account\/avatar$/, 'картинка'],
  [/^\/api\/users\/:p\/avatar$/, 'картинка'],
];

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'locales') walk(p); } else if (/\.jsx?$/.test(e.name)) files.push(p);
  }
})(SRC);
files.sort();

// Читает путь с позиции i (сразу после открывающей кавычки q). Возвращает { path, open }
function readPath(line, i, q) {
  let out = '';
  let open = false;
  while (i < line.length) {
    const c = line[i];
    if (c === q || c === '?' || c === '#' || c === ' ' || c === '\\') break;
    if (c === '$' && line[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < line.length && depth) { if (line[i] === '{') depth++; else if (line[i] === '}') depth--; i++; }
      out += ':p';
      // Путь кончился на подстановке без «/» перед ней: хвост дописывает вызывающий
      const end = i >= line.length || line[i] === q || line[i] === '?';
      if (end && !/\/:p$/.test(out)) { open = true; out = out.slice(0, -2); }
      continue;
    }
    out += c;
    i++;
  }
  return { path: out.replace(/\/+$/, ''), open };
}

const parts = (s) => s.split('/').filter(Boolean);
function fits(scan, route, open) {
  const a = parts(scan);
  const b = parts(route);
  if (!open && !route.includes('*') && a.length !== b.length) return false;
  if (open && a.length > b.length) return false;
  return a.every((s, k) => {
    if (b[k] === '*') return true;
    return s === ':p' || b[k].startsWith(':') || s === b[k];
  });
}

const problems = [];
let seen = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, n) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(/(['"`])(\/api\/)/g)) {
      const { path: p, open } = readPath(line, m.index + 1, m[1]);
      if (p === '/api') continue;
      seen++;
      const rel = `${path.relative(ROOT, file)}:${n + 1}`;
      const near = lines.slice(n, n + 4).join(' ');
      const method = (near.match(/method:\s*'([A-Z]+)'/) || near.match(/\b(?:call|send|post|request)\(\s*'([A-Z]+)'/) || [])[1];
      if (NO_ROUTE.some(([re]) => re.test(p))) continue;
      // Без метода рядом это чаще всего основа адреса (`const base = '/api/account'`), к которой дальше дописывают хвост:
      // тогда годится и начало строки таблицы
      const hit = routes.filter((r) => fits(p, r.template, open || !method));
      if (!hit.length) { problems.push(`${rel}: ${p} — в таблице демо нет такого адреса`); continue; }
      if (method && !open && !hit.some((r) => r.method === method)) {
        problems.push(`${rel}: ${method} ${p} — адрес в таблице есть, но не для ${method} (есть: ${[...new Set(hit.map((r) => r.method))].join(', ')})`);
      }
    }
  });
}

if (problems.length) {
  console.error(`Покрытие адресов: ${problems.length} без ответа в демо\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`Покрытие адресов: ${seen} обращений в ${files.length} файлах, строк в таблице ${routes.length}, всё есть`);
