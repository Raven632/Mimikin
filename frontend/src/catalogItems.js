// Игры с itch.io — для окна «Новинки» и списка «Хочу поиграть»

export const fmtCount = (n) => (
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
);

// Языки одной строкой: «EN/JP». Так их пишут и окно игры, и карточки
const LANG_SHORT = { ja: 'JP', en: 'EN', zh: 'CN', ko: 'KR', es: 'ES', ru: 'RU' };
export const langsLabel = (langs) => (langs || []).map(l => LANG_SHORT[l] || l.toUpperCase()).join('/');

// Ключ и адрес страницы игры — свои. Ключ тот же, что у сервера в «Хочу поиграть»
// (api/src/services/wishlist.js), — по нему звёздочка знает, отложена ли игра
export const catalogItem = (item) => ({ ...item, source: 'itch', key: `itch:${String(item.url).toLowerCase()}` });
