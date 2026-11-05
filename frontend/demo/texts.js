// Тексты демо на трёх языках: полоса, заметка «здесь это не работает», отказы сервера и подсказка на экране входа.
// Голос — как у остального интерфейса: просто, без «Упс» и восклицательных знаков. Приложение берёт их через
// extendLocale (locales/index.js), поэтому лежат отдельно от locales/*.js и в обычную сборку не попадают.
//
// what — «что не работает»: его называют `off('what')` в обработчиках и хуки приложения (upload, download).
// Новое what без текста здесь покажет общую заметку server — не пустое окно.

const TEXTS = {
  ru: {
    bar: { mark: 'Демо', start: 'Начать сначала', about: 'О Mimikin' },
    note_title: 'В демо этого нет',
    demo_login_hint: 'Демо: подойдут любые имя и пароль.',
    // Эти два текста заменяют обычные: здесь нет сервера без интернета, здесь нет самих источников
    find_offline: 'В демо нет интернет-источников: itch.io здесь недоступен, отложенные игры на месте.',
    find_offline_empty: 'В демо нет интернет-источников: itch.io здесь недоступен.',
    what: {
      upload: 'В демо нет сервера, который принял бы файл. В своём Mimikin вы бросаете сюда архив игры, и она появляется в библиотеке.',
      download: 'Скачивание работает на вашем сервере. Здесь файлов нет.',
      files: 'Выбранные файлы остаются у вас на устройстве: демо их не принимает.',
      lookup: 'Для поиска данных об играх нужны интернет и ваш сервер.',
      translate: 'Перевод идёт на вашем сервере с вашим ключом DeepL, Microsoft, Google или LibreTranslate.',
      secrets: 'Набранное здесь остаётся на этой странице и никуда не уходит. В своём Mimikin ключи и пароли хранятся на вашем сервере в зашифрованном виде.',
      telegram: 'Бот Telegram работает с вашим сервером. В демо его нет.',
      check: 'Проверка открывает каждую игру в скрытом браузере на вашем сервере.',
      update: 'Обновления приходят на ваш сервер. Демо — неизменная копия.',
      analysis: 'Разбор картинок запускает модель на вашем сервере. В демо он всегда включён: ответы поиска записаны заранее.',
      similar: 'Поиск похожих картинок считает модель на вашем сервере. В демо работает поиск по словам из подсказки.',
      server: 'Это работает вместе с вашим сервером. В демо его нет.',
    },
  },
  en: {
    bar: { mark: 'Demo', start: 'Start over', about: 'About Mimikin' },
    note_title: 'Not in the demo',
    demo_login_hint: 'Demo: any name and password works.',
    find_offline: 'The demo has no internet sources: itch.io is out of reach here, your saved games are still here.',
    find_offline_empty: 'The demo has no internet sources: itch.io is out of reach here.',
    what: {
      upload: 'The demo has no server to take files. In your own Mimikin you drop a game archive here and it appears in the library.',
      download: 'Downloads need your own server. Here the files are not real.',
      files: 'Files you choose stay on your device: the demo does not take them.',
      lookup: 'Looking up game data needs the internet and your own server.',
      translate: 'Translation runs on your server with your own DeepL, Microsoft, Google or LibreTranslate key.',
      secrets: 'Nothing you type here leaves this page. In your own Mimikin, keys and passwords are stored encrypted on your server.',
      telegram: 'The Telegram bot talks to your own server. The demo has none.',
      check: 'The check opens every game in a headless browser on your server.',
      update: 'Updates arrive on your own server. The demo is a fixed copy.',
      analysis: 'Picture analysis runs a model on your server. In the demo it always stays on: the search answers are recorded in advance.',
      similar: 'Finding similar pictures is done by a model on your server. The demo only searches the words from the hint.',
      server: 'This works together with your own server. The demo has none.',
    },
  },
  de: {
    bar: { mark: 'Demo', start: 'Von vorn beginnen', about: 'Über Mimikin' },
    note_title: 'Im Demo nicht dabei',
    demo_login_hint: 'Demo: Name und Passwort sind beliebig.',
    find_offline: 'Das Demo hat keine Internetquellen: itch.io ist hier nicht erreichbar, deine gemerkten Spiele sind noch da.',
    find_offline_empty: 'Das Demo hat keine Internetquellen: itch.io ist hier nicht erreichbar.',
    what: {
      upload: 'Das Demo hat keinen Server, der Dateien annimmt. In deinem eigenen Mimikin ziehst du hier ein Spielarchiv hinein, und es erscheint in der Bibliothek.',
      download: 'Downloads brauchen deinen eigenen Server. Hier sind die Dateien nicht echt.',
      files: 'Dateien, die du auswählst, bleiben auf deinem Gerät: Das Demo nimmt sie nicht an.',
      lookup: 'Die Suche nach Spieldaten braucht Internet und deinen eigenen Server.',
      translate: 'Die Übersetzung läuft auf deinem Server mit deinem eigenen Schlüssel für DeepL, Microsoft, Google oder LibreTranslate.',
      secrets: 'Was du hier eingibst, bleibt auf dieser Seite und geht nirgendwohin. In deinem eigenen Mimikin liegen Schlüssel und Passwörter verschlüsselt auf deinem Server.',
      telegram: 'Der Telegram-Bot spricht mit deinem eigenen Server. Das Demo hat keinen.',
      check: 'Die Prüfung öffnet jedes Spiel in einem unsichtbaren Browser auf deinem Server.',
      update: 'Updates kommen auf deinem eigenen Server an. Das Demo ist eine feste Kopie.',
      analysis: 'Die Bildanalyse lässt ein Modell auf deinem Server laufen. Im Demo bleibt sie immer an: Die Antworten der Suche sind vorab aufgezeichnet.',
      similar: 'Ähnliche Bilder findet ein Modell auf deinem Server. Das Demo sucht nur die Wörter aus dem Hinweis.',
      server: 'Das arbeitet mit deinem eigenen Server zusammen. Das Demo hat keinen.',
    },
  },
};

// Поиск по словам в демо: ответы записаны для короткого списка, остальное слово отвечает подсказкой со списком.
// PICTURE_WORDS и LINE_WORDS — те же слова, что записывает tests/demo/manifest.js (проверяет handlers.test.mjs).
// Картинки ищет многоязычная модель, поэтому русскому и немецкому посетителю список показан на его языке; английское
// слово принимается на любом
export const PICTURE_WORDS = ['castle', 'sea', 'snow', 'night', 'chest', 'forest', 'lighthouse'];
export const LINE_WORDS = ['inn', 'lantern', 'stars', 'soup', 'lamp', 'winter', 'gate', 'airship', 'whale', 'festival'];
const PICTURE_NAMES = {
  ru: ['замок', 'море', 'снег', 'ночь', 'сундук', 'лес', 'маяк'],
  de: ['Burg', 'Meer', 'Schnee', 'Nacht', 'Truhe', 'Wald', 'Leuchtturm'],
};
// Слово посетителя → слово записи или null. Падежи и множественное число не угадываем: записано то, что в списке
export function pictureWord(lang, q) {
  const w = String(q).trim().toLowerCase();
  if (PICTURE_WORDS.includes(w)) return w;
  const at = (PICTURE_NAMES[lang] || []).findIndex((n) => n.toLowerCase() === w);
  return at >= 0 ? PICTURE_WORDS[at] : null;
}
// Строки поиска (подсказка в поле): примеры — слова, на которые у демо есть ответ
const PLACEHOLDERS = {
  ru: { pictures: 'Что нарисовано: замок, море, снег…', lines: 'Найти по словам из реплик: lantern, soup, whale…' },
  en: { pictures: 'What is drawn: castle, sea, snow…', lines: 'Find by words from lines: lantern, soup, whale…' },
  de: { pictures: 'Was zu sehen ist: Burg, Meer, Schnee…', lines: 'Über Wörter aus dem Dialog finden: lantern, soup, whale…' },
};
const HINTS = {
  ru: {
    pictures: (list) => `В демо поиск по картинкам знает только эти слова: ${list}. В своём Mimikin он понимает любое слово.`,
    lines: (list) => `В демо поиск по репликам знает только эти слова: ${list}. В своём Mimikin он ищет по всем репликам ваших игр.`,
  },
  en: {
    pictures: (list) => `The demo's picture search knows only these words: ${list}. In your own Mimikin it understands any word.`,
    lines: (list) => `The demo's line search knows only these words: ${list}. In your own Mimikin it searches every line of your games.`,
  },
  de: {
    pictures: (list) => `Die Bildsuche im Demo kennt nur diese Wörter: ${list}. In deinem eigenen Mimikin versteht sie jedes Wort.`,
    lines: (list) => `Die Zeilensuche im Demo kennt nur diese Wörter: ${list}. In deinem eigenen Mimikin durchsucht sie jede Zeile deiner Spiele.`,
  },
};
// kind — 'pictures' | 'lines'
export function wordsHint(lang, kind) {
  const l = HINTS[lang] ? lang : 'en';
  return HINTS[l][kind]((kind === 'pictures' ? PICTURE_NAMES[l] || PICTURE_WORDS : LINE_WORDS).join(', '));
}

const of = (lang) => TEXTS[lang] || TEXTS.en;

// Текст заметки по what; неизвестное what — общая заметка
export const noteText = (lang, what) => of(lang).what[what] || of(lang).what.server;
export const barTexts = (lang) => of(lang).bar;
export const noteTitle = (lang) => of(lang).note_title;

// Тексты выбранного языка с добавкой демо: новый объект, исходный (его делит вся страница) не трогаем.
// err_reason['demo-off'] — функция от params, как и остальные: приложение само показывает её текст тостом
export function extendLocale(lang, t) {
  const d = of(lang);
  return {
    ...t,
    demo_login_hint: d.demo_login_hint,
    find_offline: d.find_offline,
    find_offline_empty: d.find_offline_empty,
    // Эти два текста приложение показывает, когда запрос не удался: в демо так отвечает слово, которого нет в записи
    lines_failed: wordsHint(lang, 'lines'),
    lines_placeholder: PLACEHOLDERS[lang]?.lines || PLACEHOLDERS.en.lines,
    pics_placeholder: PLACEHOLDERS[lang]?.pictures || PLACEHOLDERS.en.pictures,
    pics_hint: wordsHint(lang, 'pictures'),
    pics_image_bad: noteText(lang, 'similar'),
    err_reason: { ...t.err_reason, 'demo-off': ({ what } = {}) => noteText(lang, what) },
  };
}
