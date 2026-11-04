const util = require('util');

// Журнал сервера для «О программе»: docker rm стирает журнал контейнера, а достать его человеку на Windows или NAS
// трудно. Держим в памяти последние предупреждения и ошибки с запуска. Память ограничена: 500 записей по 2000 знаков.
// Наружу строки идут только через services/problemReport.js: здесь они как есть, с ключами и именами игр
const MAX_LINES = 500;
const MAX_CHARS = 2000;
const lines = [];
let total = 0;
let busy = false;

function remember(level, args) {
    // Свой inspect у объекта может сам что-то написать в console: второй раз сюда не входим
    if (busy) return;
    busy = true;
    try {
        const text = util.stripVTControlCharacters(util.formatWithOptions({ depth: 2, maxArrayLength: 20, maxStringLength: MAX_CHARS, breakLength: Infinity }, ...args));
        lines.push({ at: Date.now(), level, text: text.slice(0, MAX_CHARS), cut: text.length > MAX_CHARS });
        if (lines.length > MAX_LINES) lines.shift();
        total++;
    } catch {
        // Журнал не должен ломать саму запись в консоль
    } finally {
        busy = false;
    }
}

// Обёртка не зависит от this и зовёт прежний метод с теми же аргументами: так .catch(console.error) и подмены console
// в тестах работают как раньше. Второй вызов ничего не делает. Потоки (dlaFilesWorker) пишут в свой console — их тут нет
let wrapped = false;
function capture() {
    if (wrapped) return;
    wrapped = true;
    for (const level of ['warn', 'error']) {
        const original = console[level];
        console[level] = (...args) => {
            remember(level, args);
            return original.apply(console, args);
        };
    }
}

const recent = () => ({ lines: [...lines], total });

module.exports = { capture, recent, remember, MAX_LINES, MAX_CHARS };
