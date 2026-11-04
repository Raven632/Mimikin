// Страница ошибки, которую человек видит прямо в браузере: адрес игры устарел, файла нет, сейвов нет. Страницы
// библиотеки тут нет и языка из её настроек не узнать — язык берём из заголовка браузера, а не знаем такого — английский.
// Вид — как у библиотеки (frontend/src/styles/base.css), стили внутри: на сервере игр своих файлов у этой страницы нет
const TEXT = {
    en: {
        denied: ['Access denied', 'This link no longer works. Go back to the library and open the game again.'],
        address: ['Bad address', 'This address does not point to anything in the library. Go back to the library and open the game from there.'],
        start: ['The game cannot start', 'The game folder has no index.html. The files may be incomplete: upload the game again.'],
        saves: ['No saves yet', 'This game has no saves to download. Go back to the library.'],
    },
    ru: {
        denied: ['Нет доступа', 'Эта ссылка больше не работает. Вернитесь в библиотеку и откройте игру заново.'],
        address: ['Непонятный адрес', 'По этому адресу в библиотеке ничего нет. Вернитесь в библиотеку и откройте игру оттуда.'],
        start: ['Игра не запускается', 'В папке игры нет index.html. Возможно, файлы неполные: загрузите игру снова.'],
        saves: ['Сохранений ещё нет', 'У этой игры нет сохранений, которые можно скачать. Вернитесь в библиотеку.'],
    },
    de: {
        denied: ['Kein Zugriff', 'Dieser Link funktioniert nicht mehr. Geh zurück in die Bibliothek und öffne das Spiel erneut.'],
        address: ['Ungültige Adresse', 'Unter dieser Adresse gibt es in der Bibliothek nichts. Geh zurück in die Bibliothek und öffne das Spiel dort.'],
        start: ['Das Spiel startet nicht', 'Im Spielordner fehlt die index.html. Die Dateien sind vielleicht unvollständig: Lade das Spiel erneut hoch.'],
        saves: ['Noch keine Spielstände', 'Für dieses Spiel gibt es keine Spielstände zum Herunterladen. Geh zurück in die Bibliothek.'],
    },
};

const page = (lang, title, text) => `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title} | Mimikin</title>
<style>
html, body { height: 100%; margin: 0; }
body { display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; background: #080608; color: #e8dfc8; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
main { max-width: 34em; border-left: 2px solid #c9a84c; padding: 4px 0 4px 20px; }
h1 { margin: 0 0 8px; color: #f0d080; font-size: 1.4em; font-weight: 600; }
p { margin: 0; }
p + p { margin-top: 12px; }
strong { color: #f0d080; font-weight: 600; }
code { color: #f0d080; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${text}</p>
</main>
</body>
</html>
`;

// Первый в списке — ответ, когда браузер не сказал языка; ничего из списка не принимает — тоже английский
function pageLang(req) {
    return req.acceptsLanguages('en', 'ru', 'de') || 'en';
}

function sendErrorPage(req, res, status, kind) {
    const lang = pageLang(req);
    const [title, text] = TEXT[lang][kind];
    // Ответ зависит от заголовка: кэш не должен отдать его человеку с другим языком
    res.status(status).set({ Vary: 'Accept-Language', 'Cache-Control': 'no-store' }).type('html').send(page(lang, title, text));
}

module.exports = { sendErrorPage, page, pageLang };
