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
      analysis: 'Разбор картинок запускает модель на вашем сервере. В демо её нет.',
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
      analysis: 'Picture analysis runs a model on your server. The demo has none.',
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
      analysis: 'Die Bildanalyse lässt ein Modell auf deinem Server laufen. Das Demo hat keins.',
      server: 'Das arbeitet mit deinem eigenen Server zusammen. Das Demo hat keinen.',
    },
  },
};

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
    err_reason: { ...t.err_reason, 'demo-off': ({ what } = {}) => noteText(lang, what) },
  };
}
