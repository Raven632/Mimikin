const fs = require('fs');
const express = require('express');
const { page, pageLang } = require('./errorPage.js');

// База не открылась. Раньше это была одна строка в журнале: порт не открывался, таймеры держали процесс живым, и
// restart: unless-stopped ничего не делал, а браузер говорил «сайт недоступен». Теперь на обычном порту — страница с
// причиной и тем, что делать. Файл базы не чиним, не переименовываем и не закрываем соединение: закрытие последнего
// соединения переписало бы журнал в файл, а это может быть единственная копия человека.
// Отказ chown в docker-entrypoint.sh случается раньше Node, и эта страница его не покрывает: там своя строка в журнале.
const TEXT = {
    en: {
        title: 'The library database did not open',
        lead: 'The server is running, but it cannot open library.db, the file with your library. Nothing in the file or in your games was changed.',
        denied: ['Most likely the server may not write to the games folder.', 'Give the user inside the container (uid 1000) write access to the folder set by <code>GAMES_HOST_DIR</code> and to the library.db files in it. If it is a read-only mount, make it writable.'],
        full: ['The disk with the games folder looks full.', 'Free some space on that disk.'],
        damaged: ['The file library.db looks damaged.', 'Do not delete it: it may be your only copy. Stop the container and copy library.db, with library.db-wal and library.db-shm if they are there, to a safe place. To start again from a backup, move those files out of the folder, start the container and restore the backup in Settings, Backups.'],
        other: ['The error does not point to one clear reason.', 'A common cause is a network folder (NFS, SMB) without file locks, or another program holding the file. Try the games folder on a local disk. If that does not help, open an issue with the lines from the log.'],
        after: 'Then restart the container: <code>docker restart &lt;container&gt;</code>.',
        log: (code) => `The exact error is in the server log: <code>docker logs &lt;container&gt;</code>, the line starting with [DB]${code ? `. Error code: <code>${code}</code>` : ''}.`,
    },
    ru: {
        title: 'База библиотеки не открылась',
        lead: 'Сервер работает, но не может открыть library.db, файл с вашей библиотекой. Ни в файле, ни в играх ничего не изменилось.',
        denied: ['Скорее всего, серверу нельзя писать в папку с играми.', 'Дайте пользователю внутри контейнера (uid 1000) право на запись в папку из настройки <code>GAMES_HOST_DIR</code> и в файлы library.db в ней. Если папка подключена только для чтения, подключите её для записи.'],
        full: ['Похоже, диск с папкой игр заполнен.', 'Освободите место на этом диске.'],
        damaged: ['Похоже, файл library.db повреждён.', 'Не удаляйте его: возможно, это ваша единственная копия. Остановите контейнер и скопируйте в надёжное место library.db, а также library.db-wal и library.db-shm, если они есть. Чтобы начать заново из резервной копии, уберите эти файлы из папки, запустите контейнер и восстановите копию в «Настройки», «Копии».'],
        other: ['По ошибке нельзя назвать одну понятную причину.', 'Часто дело в сетевой папке (NFS, SMB) без блокировок файлов или в другой программе, которая держит файл. Попробуйте папку с играми на локальном диске. Не помогло — откройте issue и приложите строки из журнала.'],
        after: 'Затем перезапустите контейнер: <code>docker restart &lt;контейнер&gt;</code>.',
        log: (code) => `Точная ошибка — в журнале сервера: <code>docker logs &lt;контейнер&gt;</code>, строка начинается с [DB]${code ? `. Код ошибки: <code>${code}</code>` : ''}.`,
    },
    de: {
        title: 'Die Datenbank der Bibliothek hat sich nicht geöffnet',
        lead: 'Der Server läuft, kann aber library.db, die Datei mit deiner Bibliothek, nicht öffnen. An der Datei und an deinen Spielen wurde nichts geändert.',
        denied: ['Vermutlich darf der Server nicht in den Spielordner schreiben.', 'Gib dem Benutzer im Container (uid 1000) Schreibrechte auf den Ordner aus der Einstellung <code>GAMES_HOST_DIR</code> und auf die library.db-Dateien darin. Ist der Ordner nur lesbar eingebunden, binde ihn beschreibbar ein.'],
        full: ['Die Festplatte mit dem Spielordner scheint voll zu sein.', 'Gib auf dieser Festplatte Platz frei.'],
        damaged: ['Die Datei library.db scheint beschädigt zu sein.', 'Lösche sie nicht: Vielleicht ist es deine einzige Kopie. Halte den Container an und kopiere library.db, dazu library.db-wal und library.db-shm, falls vorhanden, an einen sicheren Ort. Um aus einer Sicherung neu zu beginnen, nimm diese Dateien aus dem Ordner, starte den Container und stelle die Sicherung unter Einstellungen, Sicherungen wieder her.'],
        other: ['Der Fehler weist nicht auf eine klare Ursache hin.', 'Oft liegt es an einem Netzwerkordner (NFS, SMB) ohne Dateisperren oder an einem anderen Programm, das die Datei festhält. Probiere den Spielordner auf einer lokalen Festplatte. Hilft das nicht, öffne ein Issue mit den Zeilen aus dem Protokoll.'],
        after: 'Starte danach den Container neu: <code>docker restart &lt;container&gt;</code>.',
        log: (code) => `Der genaue Fehler steht im Serverprotokoll: <code>docker logs &lt;container&gt;</code>, die Zeile beginnt mit [DB]${code ? `. Fehlercode: <code>${code}</code>` : ''}.`,
    },
};

// Меньше мегабайта свободно — считаем диск полным: SQLite при нехватке места отвечает и «не открыть», и «ошибка записи»
const NEARLY_FULL = 1024 * 1024;

function diagnose(err, free = Infinity) {
    const code = String(err?.code || '');
    if (/^SQLITE_(CORRUPT|NOTADB)/.test(code)) return 'damaged';
    if (/^(SQLITE_FULL|ENOSPC|EDQUOT)/.test(code)) return 'full';
    if (/^(EACCES|EPERM|EROFS|SQLITE_READONLY|SQLITE_PERM)/.test(code)) return 'denied';
    if (/^(SQLITE_CANTOPEN|SQLITE_IOERR)/.test(code) && free < NEARLY_FULL) return 'full';
    if (/^SQLITE_CANTOPEN/.test(code)) return 'denied';
    return 'other';
}

function freeBytes(dir) {
    try {
        const { bavail, bsize } = fs.statfsSync(dir);
        return bavail * bsize;
    } catch {
        return Infinity;
    }
}

// Отдельное маленькое приложение, а не основное: за ним нет ни одного маршрута, которому нужна база
function createDbDownApp(kind, errorCode) {
    // На страницу — только код вида SQLITE_NOTADB: в тексте ошибки бывает полный путь
    const code = /^[A-Z_]{2,40}$/.test(String(errorCode || '')) ? errorCode : '';
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res) => {
        const lang = pageLang(req);
        const T = TEXT[lang];
        res.status(503).set({ Vary: 'Accept-Language', 'Cache-Control': 'no-store' });
        const [reason, todo] = T[kind];
        if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) {
            return res.json({ error: 'database-unavailable', reason: kind, code, message: `${T.title}. ${reason}` });
        }
        res.type('html').send(page(lang, T.title, [T.lead, `<strong>${reason}</strong> ${todo}`, T.after, T.log(code)].join('</p><p>')));
    });
    return app;
}

// Таймеры и службы к этому моменту не запущены (server.js). Настоящая ошибка — в журнал: на странице её нет
function serveDbDown(err, { dir, port, stopRedis = () => {} }) {
    const kind = diagnose(err, freeBytes(dir));
    console.error(`[DB] База не открылась (${kind}):`, err);
    const server = createDbDownApp(kind, err?.code).listen(port, () => {
        console.error(`[DB] Служб нет: порт ${port} отвечает только страницей об ошибке и кодом 503. Файл базы не тронут`);
    });
    server.on('error', (e) => console.error('[DB] Страницу об ошибке не показать:', e.message));
    Promise.resolve().then(stopRedis).catch(() => {});
    // PID 1 без обработчика сигнала не слышит: docker stop ждал бы 10 секунд и убивал
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
    return server;
}

module.exports = { diagnose, createDbDownApp, serveDbDown };
