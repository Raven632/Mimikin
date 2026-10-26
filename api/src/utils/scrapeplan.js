// Политика поиска метаданных: какой итог у попытки и когда пробовать снова.
// Вынесена отдельно от сетевого кода, чтобы её можно было проверить тестами
// и поменять паузы в одном месте, не трогая источники.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Паузы между автоматическими попытками. Когда список кончился — автопоиск
// для игры останавливается: дальше только руками («Искать сейчас» или ссылка).
const DELAYS = {
    // Источники не ответили (лимит, сеть, Cloudflare): это временно, пробуем скоро
    error: [HOUR, 6 * HOUR, DAY, DAY, 3 * DAY],
    // Все ответили «нет такой игры»: ответ вряд ли изменится завтра, растягиваем
    not_found: [DAY, 7 * DAY, 30 * DAY],
    // Теги есть, но нет картинок или ссылки: иногда появляются позже
    partial: [7 * DAY, 30 * DAY],
};

// Итог по тому, что у игры лежит в базе после попытки, а не только по ответу
// источников: если поиск ничего не дал, но теги остались с прошлого раза,
// игра не должна стать «не найденной».
function classify({ hasMeta, hasLink, hasScreens, failed = [] }) {
    if (hasMeta) return hasLink && hasScreens ? 'ok' : 'partial';
    return failed.length > 0 ? 'error' : 'not_found';
}

// prevAttempts — сколько неудачных попыток было подряд до этой.
// Ручной поиск передаёт 0: человек нажал кнопку — отсчёт начинается заново.
function planNext(status, prevAttempts, now = Date.now()) {
    if (status === 'ok') return { attempts: 0, retryAt: null };
    const attempts = prevAttempts + 1;
    const delays = DELAYS[status] || [];
    const delay = delays[attempts - 1];
    return { attempts, retryAt: delay === undefined ? null : now + delay };
}

// Что считается «есть в базе»: пустой JSON-список тоже пусто
const isFilled = (v) => !!v && v !== '[]' && v !== '""';

function statusOfRow(row, failed = []) {
    return classify({
        hasMeta: isFilled(row.tags) || !!row.description,
        hasLink: !!row.link,
        hasScreens: isFilled(row.screens),
        failed,
    });
}

module.exports = { classify, planNext, statusOfRow, DELAYS, HOUR, DAY };
