// Предпросмотр «с переводом» на экране «Картинки» — как рисует игра (api/public/rpg-fixes.js, relabel):
// заплатка заменяет пиксели надписи, перевод — шрифтом перевода (M PLUS Rounded 1c, как в игре) с цветом,
// обводкой и размером подписи; не влезает — шрифт меньше, но не меньше 60%, дальше строка сжимается
export const FONT = 'MimikinTl';
const FACES = [
  ['mplus-rounded-1c-latin-500.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
  ['mplus-rounded-1c-cyrillic-500.woff2', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'],
];

let fontReady = null;
export function loadFont() {
  if (!fontReady) {
    fontReady = Promise.all(FACES.map(([file, range]) => {
      try {
        const face = new FontFace(FONT, `url(/fonts/${file})`, { unicodeRange: range });
        document.fonts.add(face);
        return face.load().catch(() => null);
      } catch {
        return null;
      }
    }));
  }
  return fontReady;
}

export function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Заплатка — картинка вдвое выше места надписи: сверху новые пиксели, снизу маска «где заменить»
export function applyPatch(ctx, img, [px, py, pw, ph]) {
  const c = document.createElement('canvas');
  c.width = pw;
  c.height = ph * 2;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const src = cx.getImageData(0, 0, pw, ph * 2).data;
  const cur = ctx.getImageData(px, py, pw, ph);
  const d = cur.data;
  const n = pw * ph * 4;
  for (let i = 0; i < n; i += 4) {
    if (src[n + i + 3] > 127) {
      d[i] = src[i]; d[i + 1] = src[i + 1]; d[i + 2] = src[i + 2]; d[i + 3] = src[i + 3];
    }
  }
  ctx.putImageData(cur, px, py);
}

// Перевод на месте подписи — как Bitmap.drawText движка: строка по центру высоты, обводка под заливкой
export function drawLabel(ctx, l, text) {
  const size0 = l.size || Math.max(10, Math.round(l.h * 0.95));
  // Вертикальная надпись — перевод повёрнут и идёт вдоль столбца (как в игре)
  const width = l.maxW || (l.vertical ? l.h : l.w);
  const min = Math.max(8, Math.round(size0 * 0.6));
  const font = (s) => `${l.bold ? 'bold ' : ''}${s}px ${FONT}, sans-serif`;
  let size = size0;
  ctx.font = font(size);
  while (size > min && ctx.measureText(text).width > width) ctx.font = font(--size);
  ctx.save();
  let tx;
  let ty;
  if (l.vertical) {
    ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
    ctx.rotate(Math.PI / 2);
    tx = 0;
    ty = Math.round(size * 0.35);
  } else {
    const left = l.align === 'center' ? l.x - (width - l.w) / 2 : l.x;
    tx = l.align === 'center' ? left + width / 2 : left;
    ty = Math.round(l.y + l.h / 2 + size * 0.35);
  }
  ctx.textAlign = l.vertical || l.align === 'center' ? 'center' : 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const outline = l.outline === null ? 0 : l.outlineWidth ?? 4;
  if (outline > 0) {
    ctx.strokeStyle = l.outline || 'rgba(0, 0, 0, 0.85)';
    ctx.lineWidth = outline;
    ctx.strokeText(text, tx, ty, width);
  }
  ctx.fillStyle = l.color || '#ffffff';
  ctx.fillText(text, tx, ty, width);
  ctx.restore();
}
