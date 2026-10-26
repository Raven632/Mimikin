// Язык игры для карточки и окна. Данные приходят с сервера как { main, langs, original }:
// langs — все языки с настоящим текстом (главный первым), original — на каком её делали.
// Названия языков берём у браузера: Intl.DisplayNames знает их на любом языке интерфейса.
const names = new Map();

export function languageName(code, lang) {
  const key = `${lang}:${code}`;
  if (!names.has(key)) {
    let name = code.toUpperCase();
    try {
      name = new Intl.DisplayNames([lang], { type: 'language' }).of(code) || name;
    } catch {
      // Браузер без Intl.DisplayNames — остаётся код языка, «RU»
    }
    names.set(key, name);
  }
  return names.get(key);
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// С большой буквы — для списков и фильтра: «Русский», а не «русский»
export const languageTitle = (code, lang) => capitalize(languageName(code, lang));

// Язык игры одним ключом — чтобы сравнить с обычным для библиотеки: код (английский, если он есть
// среди языков игры, иначе основной) или вписанное руками, как есть
export function languageKey(game) {
  if (game.language) return game.language.trim().toLowerCase();
  const info = game.textLang;
  if (!info?.langs?.length) return null;
  return info.langs.includes('en') ? 'en' : info.main;
}

// Коротко для плашки: «JP», «CN» — привычнее кодов языка «JA», «ZH». Вписанное руками — как есть
const SHORT = { ja: 'JP', zh: 'CN', ko: 'KR' };
export function languageShort(game) {
  if (game.language) return game.language;
  const key = languageKey(game);
  return key ? SHORT[key] || key.toUpperCase() : null;
}

// Окно игры — все языки, главный первым: «Китайский, английский, японский».
// У перевода — с какого: «Русский, перевод с японского». Если язык оригинала
// тоже есть в игре (японский и английский на выбор), это не перевод, а многоязычное издание
export function languageLine(game, t, lang) {
  if (game.language) return game.language;
  const info = game.textLang;
  if (!info?.langs?.length) return null;

  let line = capitalize(info.langs.map((code) => languageName(code, lang)).join(', '));
  if (info.original && !info.langs.includes(info.original)) {
    line += `, ${t.lang_translated_from(languageName(info.original, lang))}`;
  }
  return line;
}
