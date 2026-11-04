import { httpError } from './apiError';

// Аватар: страница сама вырезает квадрат из середины и уменьшает до 256 px, а на сервер уходит готовый JPEG
// (api/src/routes/account.js принимает до 256 КБ и проверяет сигнатуру). Холст заодно выкидывает из файла метаданные,
// в том числе место съёмки. Фон чёрный: у PNG с прозрачностью без заливки вышли бы чёрные пятна по краям непредсказуемо
export const AVATAR_SIDE = 256;

// Файл человека → JPEG-квадрат. Не открылся (битый файл, формат, который браузер не знает) — бросает ошибку: экран покажет
// «не удалось открыть». imageOrientation: фотография с телефона лежит боком и повёрнута меткой — берём картинку, как её видят
export async function cropAvatar(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error('empty');
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, AVATAR_SIDE, AVATAR_SIDE);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('encode');
    return blob;
  } finally {
    bitmap.close?.();
  }
}

async function send(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'image/jpeg' } : undefined, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
}

// url — /api/account/avatar (своя) или /api/users/<id>/avatar (главный администратор — чужая)
export const putAvatar = (url, blob) => send('PUT', url, blob);
export const dropAvatar = (url) => send('DELETE', url);

// Адрес картинки; версия в адресе — время файла: новая картинка — новый адрес, кеш на неделю не мешает
export const avatarSrc = (person) => (person?.avatar ? `/api/avatars/${encodeURIComponent(person.id)}?v=${person.avatar}` : '');
