require('dotenv').config({ quiet: true });   // без рекламных подсказок dotenv в журнале при каждом старте
const path = require('path');

const GAMES_DIR = process.env.GAMES_DIR || path.join(__dirname, '..', '..', '..', 'games');

// Теперь любую системную папку можно переопределить через .env!
const EXTRACT_TMP = process.env.EXTRACT_TMP || path.join(GAMES_DIR, '_tmp_uploads'); 
const UPLOAD_TMP = EXTRACT_TMP; 
const SAVES_DIR = process.env.SAVES_DIR || path.join(GAMES_DIR, '_saves');
const AUDIOCACHE = process.env.AUDIOCACHE || path.join(GAMES_DIR, '.audio-cache');
// Прежние версии игр, отложенные при обновлении (services/uploads.js), — пока человек их не удалит
const OLD_DIR = process.env.OLD_DIR || path.join(GAMES_DIR, '_old');
// Корзина: удалённые игры и база до восстановления из копии — 30 дней (services/trash.js)
const TRASH_DIR = process.env.TRASH_DIR || path.join(GAMES_DIR, '_trash');
// «Входящие»: архив, положенный сюда (JDownloader, торрент-клиент, по сети), библиотека принимает сама (services/inbox.js)
const INBOX_DIR = process.env.INBOX_DIR || path.join(GAMES_DIR, '_inbox');

// OFFLINE=1 — сервер не ходит в интернет сам: не ищет данные игр, не проверяет обновления программы.
// Для автотестов и демо-библиотеки (scripts/demo-library.js): там нечего искать,
// а тесты не должны зависеть от чужих сайтов
const OFFLINE = process.env.OFFLINE === '1';

// Служебные папки рядом с играми: это не игры, в библиотеку их не берём
const SYSTEM_DIRS = ['_saves', '_tmp_uploads', '_media', '_old', '_trash', '_inbox', 'node_modules', '.audio-cache'];

module.exports = {
    GAMES_DIR,
    EXTRACT_TMP,
    UPLOAD_TMP,
    SAVES_DIR,
    AUDIOCACHE,
    OLD_DIR,
    INBOX_DIR,
    TRASH_DIR,
    SYSTEM_DIRS,
    OFFLINE,
};
