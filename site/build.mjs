// Сборка страницы проекта: node site/build.mjs [папка], по умолчанию _site в корне репозитория.
// Один шаблон и тексты en/ru/de → index.html, ru/, de/ и 404.html. Без зависимостей, чтобы CI не ставил лишнего.
// Не чистит папку: туда же CI кладёт демо (_site/demo), порядок шагов не должен иметь значения.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SITE, '..');
const out = resolve(process.argv[2] || join(ROOT, '_site'));
// Абсолютные адреса нужны для canonical, og:image (превью в Telegram и LinkedIn не понимают относительных) и для 404,
// которая открывается с любой глубины. CI подставляет base_url из configure-pages.
const siteUrl = (process.env.SITE_URL || 'https://raven632.github.io/Mimikin').replace(/\/+$/, '');
const repo = 'https://github.com/Raven632/Mimikin';
const version = JSON.parse(readFileSync(join(ROOT, 'frontend/package.json'), 'utf8')).version;

// Скриншоты: порядок как в texts/*.json → shots. Размеры читаем из самих файлов, чтобы новые снимки не требовали правки чисел.
const SHOTS = ['app-home.webp', 'app-game.webp', 'app-phone.webp'];
const LANGS = [
  { code: 'en', short: 'EN', name: 'English', dir: '' },
  { code: 'ru', short: 'RU', name: 'Русский', dir: 'ru/' },
  { code: 'de', short: 'DE', name: 'Deutsch', dir: 'de/' },
];

function webpSize(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') throw new Error(`${file}: не WebP`);
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
  if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  throw new Error(`${file}: неизвестный блок ${kind}`);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const get = (ctx, path) => {
  const own = path.startsWith('.');
  const v = (own ? path.slice(1) : path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), own ? ctx.item : ctx);
  if (v === undefined) throw new Error(`в шаблоне нет значения «${path}»`);
  return v;
};
// {{путь}} — с экранированием, {{{путь}}} — как есть (разметка из наших текстов), {{#each список}}…{{/each}} — повтор.
// Внутри повтора «.поле» — поле элемента. Вложенных повторов нет, и они не нужны.
function render(tpl, ctx) {
  return tpl
    .replace(/\{\{#each ([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, name, inner) =>
      get(ctx, name).map((item) => render(inner, { ...ctx, item })).join(''))
    .replace(/\{\{\{(\.?[\w.]+)\}\}\}/g, (_, p) => get(ctx, p))
    .replace(/\{\{(\.?[\w.]+)\}\}/g, (_, p) => esc(get(ctx, p)));
}

const read = (p) => readFileSync(join(SITE, p), 'utf8');
const write = (rel, text) => { const f = join(out, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
const copy = (from, rel) => {
  if (!existsSync(from)) throw new Error(`нет файла ${from}`);
  const f = join(out, rel); mkdirSync(dirname(f), { recursive: true }); copyFileSync(from, f);
};

const sizes = SHOTS.map((f) => webpSize(join(SITE, 'img', f)));
const template = read('template.html');
const en = JSON.parse(read('texts/en.json'));

for (const L of LANGS) {
  const t = JSON.parse(read(`texts/${L.code}.json`));
  if (t.shots.length !== SHOTS.length) throw new Error(`${L.code}: подписей к снимкам ${t.shots.length}, снимков ${SHOTS.length}`);
  if (t.points.length !== en.points.length || t.facts.length !== en.facts.length) throw new Error(`${L.code}: число пунктов не совпадает с en`);
  const root = L.dir ? '../' : '';
  const shots = t.shots.map((s, i) => ({
    ...s, file: SHOTS[i], ...sizes[i],
    current: i === 0 ? ' aria-current="true"' : '',
    lazy: i === 0 ? '' : ' loading="lazy"',
  }));
  const langs = LANGS.map((M) => ({
    ...M,
    url: `${siteUrl}/${M.dir}`,
    // Ссылки на соседние страницы — относительные, чтобы работали и при локальном просмотре
    href: M.code === L.code ? './' : (L.dir ? '../' : '') + M.dir,
    current: M.code === L.code ? ' aria-current="page"' : '',
  }));
  const html = render(template, {
    t, lang: L.code, root, siteUrl, repo, version, langs, shots, facts: t.facts, points: t.points,
    canonical: `${siteUrl}/${L.dir}`,
    home: './',
    // ?lang= и для en: иначе в демо остаётся язык, сохранённый на другой странице (rpg_lang в localStorage)
    demoHref: `${root}demo/?lang=${L.code}`,
  });
  write(`${L.dir}index.html`, html);
}

write('404.html', render(read('404.html'), { t: en, siteUrl }));
copy(join(SITE, 'site.css'), 'site.css');
copy(join(SITE, 'site.js'), 'site.js');
for (const f of readdirSync(join(SITE, 'img'))) copy(join(SITE, 'img', f), `img/${f}`);
// Шрифты, значок и логотип берём из приложения: один источник на файл
const front = join(ROOT, 'frontend/public');
for (const f of readdirSync(join(front, 'ui-fonts'))) {
  if (/^(fira-sans-(latin|cyrillic)-(400|500|600|700)|tiny5-(latin|cyrillic)-400)-normal\.woff2$|^OFL-/.test(f)) copy(join(front, 'ui-fonts', f), `fonts/${f}`);
}
copy(join(front, 'favicon.svg'), 'favicon.svg');
copy(join(front, 'apple-touch-icon.png'), 'apple-touch-icon.png');
console.error(`site: ${out} (версия ${version}, ${siteUrl})`);
