const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { SAVES_DIR } = require('../config/index.js');
const { rootOf } = require('./personStores.js');
const { jpegSize } = require('./jpegSize.js');

// Картинка человека: JPEG 256 px, который страница сама вырезала и уменьшила (frontend/src/avatar.js). Лежит в корне его
// сейвов, а не в _media: _saves входит в копии (routes/backup.js), а _media — нет, и ревизия не считает точечное имя сиротой.
// У владельца это _saves/.avatar.jpg, у остальных — _saves/.people/<id>/.avatar.jpg. Версия картинки — время файла: столбца
// в базе нет, адрес /api/avatars/<id>?v=<версия> меняется сам, когда файл заменили
const AVATAR_FILE = '.avatar.jpg';
// Страница шлёт ~10–30 КБ; с запасом, но не больше. Сторона — защита от «бомбы»: крошечный файл с огромным кадром
const MAX_BYTES = 256 * 1024;
const MAX_SIDE = 512;
const PERSON_ID = /^u[0-9a-f]{16}$/;

// Только владелец и id по форме: rootOf (personStores.js) чужой id не проверяет, а он станет частью пути на диске
const validId = (id) => id === 'owner' || (typeof id === 'string' && PERSON_ID.test(id));
const fileOf = (id) => (id === 'owner' ? path.join(SAVES_DIR, AVATAR_FILE) : PERSON_ID.test(String(id)) ? path.join(rootOf(id), AVATAR_FILE) : null);

// Только настоящий JPEG: SVG и всё остальное сюда не попадает ни при каких заголовках запроса (CSP у нас выключен, а SVG
// мог бы нести скрипт). ffmpeg не зовём: он необязателен, а файл отдаётся как image/jpeg с nosniff
function validJpeg(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.length > MAX_BYTES) return false;
    if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return false;
    const { width, height } = jpegSize(buf);
    return width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE;
}

// Время файла в миллисекундах или null. Не файл (ссылка, папка) — нет картинки
async function versionOf(id) {
    const file = fileOf(id);
    const st = file && await fsp.lstat(file).catch(() => null);
    return st?.isFile() ? Math.floor(st.mtimeMs) : null;
}

// Временный файл и rename, как у миниатюр (utils/thumbs.js): оборванная запись не оставит половину картинки. Папки человека
// может ещё не быть — у него нет сейвов
async function writeFile(file, buf) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, file);
    } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
    }
}

async function put(id, buf) {
    await writeFile(fileOf(id), buf);
    return versionOf(id);
}

async function remove(id) {
    const file = fileOf(id);
    if (file) await fsp.rm(file, { force: true });
}

// Из распакованной копии: только если здесь своей нет. Архив чужой — ссылку и не-JPEG отбрасываем, как и всё остальное
async function restore(fromRoot, toRoot) {
    const mine = path.join(toRoot, AVATAR_FILE);
    if (await fsp.lstat(mine).catch(() => null)) return false;
    const src = path.join(fromRoot, AVATAR_FILE);
    const st = await fsp.lstat(src).catch(() => null);
    if (!st?.isFile() || st.size > MAX_BYTES) return false;
    const buf = await fsp.readFile(src);
    if (!validJpeg(buf)) return false;
    await writeFile(mine, buf);
    return true;
}

module.exports = { AVATAR_FILE, MAX_BYTES, MAX_SIDE, validId, fileOf, validJpeg, versionOf, put, remove, restore };
