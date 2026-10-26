// Тексты интерфейса по языкам. Раньше все три языка (115 КБ) лежали в главном файле приложения —
// теперь при первой загрузке приходит только выбранный, остальные — когда язык переключат
const loaders = {
  ru: () => import('./ru.js'),
  en: () => import('./en.js'),
  de: () => import('./de.js'),
};
const loaded = {};

export const LANGS = Object.keys(loaders);
export const validLang = (lang) => (loaders[lang] ? lang : 'ru');

// Язык, который выбрали в прошлый раз, — его и грузим до первой отрисовки (main.jsx)
export function savedLang() {
  try { return validLang(localStorage.getItem('rpg_lang')); } catch { return 'ru'; }
}

export async function loadLocale(lang) {
  const key = validLang(lang);
  loaded[key] ??= (await loaders[key]()).default;
  return loaded[key];
}

// Уже загруженный язык (до первой отрисовки main.jsx загружает выбранный)
export const locale = (lang) => loaded[validLang(lang)] || loaded.ru || Object.values(loaded)[0];
