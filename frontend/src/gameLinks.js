// Ссылки игры на сайты (Steam, VNDB, itch.io…): в базе — одна строка через запятую. Окно игры
// показывает их значками, правка — списком с подписями

export const splitLinks = (s) => String(s || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean);

// Что человек вставил в поле «добавить»: ссылку или несколько ссылок.
// Непонятный кусок — null: лучше переспросить, чем молча сохранить мусор
export function parseLinkInput(text) {
  const out = [];
  for (const part of String(text).split(/[\s,]+/).filter(Boolean)) {
    if (/^https?:\/\/\S+$/i.test(part)) out.push(part);
    else return null;
  }
  return out.length ? out : null;
}

// Логотип сайта для ссылки
export function linkIcon(url) {
  if (url.includes('vndb.org')) return '/vndb-logo.png';
  if (url.includes('steampowered.com')) return '/steam-logo.png';
  if (/\.itch\.io\//.test(url)) return '/itch-logo.svg';
  return '';
}

// Название сайта для подписанной ссылки в окне игры: «Steam ↗», а не безымянный значок
export function siteName(url) {
  const known = [['vndb.org', 'VNDB'], ['steampowered.com', 'Steam'], ['itch.io', 'itch.io']];
  const hit = known.find(([part]) => url.includes(part));
  if (hit) return hit[1];
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// Подпись ссылки в правке: сайт и что именно — номер в магазине, автор и игра
export function describeLink(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return { host: url, label: '' }; }
  const app = url.match(/app\/(\d+)/);
  if (app) return { host, label: `app ${app[1]}` };
  const vn = url.match(/vndb\.org\/(v\d+)/i);
  if (vn) return { host, label: vn[1] };
  // itch.io: «автор.itch.io/игра» — подписываем автора и игру
  const itch = url.match(/\/\/([^./]+)\.itch\.io\/([^/?#]+)/i);
  if (itch) return { host: 'itch.io', label: `${itch[1]}, ${itch[2].replace(/-/g, ' ')}` };
  return { host, label: '' };
}
