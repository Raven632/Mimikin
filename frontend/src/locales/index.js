// Тексты интерфейса по языкам. Раньше все три языка (115 КБ) лежали в главном файле приложения —
// теперь при первой загрузке приходит только выбранный, остальные — когда язык переключат
import { DEMO } from '../demoHooks';

const loaders = {
  ru: () => import('./ru.js'),
  en: () => import('./en.js'),
  de: () => import('./de.js'),
};
const loaded = {};

export const LANGS = Object.keys(loaders);
// Английский — когда своего языка у человека нет: его поймут чаще, чем русский или немецкий
export const validLang = (lang) => (loaders[lang] ? lang : 'en');

// Первый заход: первый из языков браузера, на котором у нас есть тексты ('en-GB' — это en)
const browserLang = () => {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  return validLang(tags.map((tag) => String(tag).toLowerCase().split('-')[0]).find((code) => loaders[code]));
};

// Язык, который выбрали в прошлый раз, а не выбирали — язык браузера. Его и грузим до первой отрисовки (main.jsx)
export function savedLang() {
  let saved = null;
  try { saved = localStorage.getItem('rpg_lang'); } catch { /* хранилище закрыто — как при первом заходе */ }
  return loaders[saved] ? saved : browserLang();
}

export async function loadLocale(lang) {
  const key = validLang(lang);
  // В демо-сборке тексты языка дополняют своими (отказы «демо», заметки): window.mimikinDemo.extendLocale задаёт frontend/demo/install.js
  if (!loaded[key]) {
    const texts = (await loaders[key]()).default;
    loaded[key] = DEMO ? window.mimikinDemo.extendLocale(key, texts) : texts;
  }
  return loaded[key];
}

// Уже загруженный язык (до первой отрисовки main.jsx загружает выбранный)
export const locale = (lang) => loaded[validLang(lang)] || Object.values(loaded)[0];
