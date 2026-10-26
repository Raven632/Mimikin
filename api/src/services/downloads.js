const crypto = require('crypto');
const myjd = require('./myjd.js');

// «Загрузить» по ссылке — откуда бы ни нажали: поле «Ссылка на файл», закладка «В Mimikin» в браузере, окно игры
// («Скачать новую версию») или сообщение в Telegram. Адрес для JDownloader собираем сами из проверенного: туда уходят
// только ссылки на известные файлообменники (список FILE_HOSTS ниже), никаких страниц сайтов. Ключ загрузки (ход в
// шапке) — «link:…» с хешем адреса.
// Цель — { url, key, title, version, target }: target — игра библиотеки, скачанное встанет её обновлением

const fail = (status, message, reason = '', extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
// Название — имя пакета в JDownloader: без управляющих знаков и <> (у JDownloader в названиях бывают подстановки)
const cleanTitle = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 200);
const cleanVersion = (s) => String(s || '').replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 40);
// Название из адреса, пока другого нет: «lantern-witch-v1-2» → «Lantern witch v1 2»
const fromSlug = (slug) => {
    const s = String(slug || '').replace(/[-_]+/g, ' ').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : '';
};

// Файлообменники, ссылки на которые принимаем как есть: те, что разбирает JDownloader. Список закрытый: JDownloader пойдёт по любому адресу, а сервер не должен гонять его по чужим
// сайтам (и по внутренним адресам сети). Поддомены своих хостов (www., download.) разрешены
const FILE_HOSTS = /(?:^|\.)(?:mega\.nz|mega\.io|gofile\.io|pixeldrain\.com|workupload\.com|mediafire\.com|drive\.google\.com|datanodes\.to|buzzheavier\.com|bzzhr\.to|krakenfiles\.com|files\.fm|1fichier\.com|dropbox\.com|catbox\.moe|send\.cm|vikingfile\.com|ranoz\.gg|mixdrop\.[a-z]{2,})$/;

// Ссылка на файл: только https, без логина и пароля в адресе, хост — из списка. Ключ — по хешу адреса целиком (у mega
// ключ шифрования стоит после #): та же ссылка — та же загрузка. Название — из окна игры, иначе имя файла из адреса
function hostLink(raw, { title = '', version = '', game = '' } = {}) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !FILE_HOSTS.test(u.hostname) || u.href.length > 2000) return null;
    let name = '';
    try { name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; }
    return {
        url: u.href,
        key: `link:${crypto.createHash('sha1').update(u.href).digest('hex').slice(0, 12)}`,
        title: cleanTitle(title) || fromSlug(name.replace(/\.[a-z0-9]{2,4}$/i, '')) || u.hostname,
        version: cleanVersion(version),
        target: game,
    };
}

// Ссылка из Telegram, поля «Ссылка на файл» или окна игры: ссылка на известный файлообменник — название и версия из
// окна, game — игра библиотеки, которую она обновляет. null — не ссылка на файл
async function fromLink(raw, opts = {}) {
    return hostLink(String(raw || '').trim(), opts);
}

async function start(target, { via = '' } = {}) {
    const r = await myjd.send(target.url, cleanTitle(target.title), target.key, { version: cleanVersion(target.version), target: target.target || '', via, passwords: target.passwords || [] });
    return { started: true, key: target.key, title: cleanTitle(target.title), update: !!target.target, ...(r?.already ? { already: true } : {}) };
}

// Ссылка → загрузка: окно игры и Telegram
async function startUrl(url, opts = {}, via = '') {
    const target = await fromLink(url, opts);
    if (!target) throw fail(400, 'Это не ссылка на известный файлообменник (mega, gofile, pixeldrain…)', 'site');
    return start(target, { via });
}

// Telegram: ссылка на файл ({ url })
async function startFrom({ url = '' }, via) {
    return startUrl(url, {}, via);
}

module.exports = { fromLink, start, startUrl, startFrom, cleanTitle, cleanVersion };
