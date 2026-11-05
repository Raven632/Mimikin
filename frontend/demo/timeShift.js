// Запись сделана в один день, страницу открывают в другой: сдвигаем записанные времена на разницу, чтобы «2 часа назад»
// было правдой в момент визита. Чистый модуль (Node читает его же в проверке контракта).
// Список полей — один, здесь: добавили в приложение новое поле с временем — добавить и сюда, иначе оно «состарится»

const FIELDS = new Set([
  'addedAt', 'lastPlayed', 'at', 'createdAt', 'updatedAt', 'checkedAt', 'builtAt', 'deletedAt', 'nextPurgeAt',
  'retryAt', 'startedAt', 'seenAt', 'purgeAt', 'until',
]);

// Время сервера — миллисекунды с 1970 года (около 1.8e12). Секунды (около 1.8e9) тоже встречаются: сдвигаем в их мере.
// Всё остальное (размеры, счётчики) в эти границы по смыслу не попадает, а по имени поля мы и так выбираем только времена
const isMs = (n) => n > 1e11 && n < 1e14;
const isSec = (n) => n > 1e9 && n <= 1e11;

export function shiftTimes(value, delta) {
  if (Array.isArray(value)) {
    for (const item of value) shiftTimes(item, delta);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'number' && FIELDS.has(k)) {
        if (isMs(v)) value[k] = v + delta;
        else if (isSec(v)) value[k] = v + Math.round(delta / 1000);
      } else if (v && typeof v === 'object') {
        shiftTimes(v, delta);
      }
    }
  }
  return value;
}

const dayNumber = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const dayString = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
// Сегодняшний день по часам посетителя, а не по UTC: календарь «Мои дни за игрой» должен кончаться его сегодняшним числом
export const localDay = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// /api/play-days: дни целиком. Последний день записи (today) становится сегодняшним, остальные сдвигаются так же
export function shiftPlayDays(body, now) {
  if (!body?.today) return body;
  const days = dayNumber(localDay(now)) - dayNumber(body.today);
  if (days === 0) return body;
  const move = (iso) => (iso ? dayString(dayNumber(iso) + days) : iso);
  for (const d of body.days || []) d.day = move(d.day);
  body.since = move(body.since);
  body.today = localDay(now);
  return body;
}

// Один вход для хранилища: ключ записи → нужный сдвиг
export function shiftBody(key, body, { recordedAt, now }) {
  if (key === '/api/play-days') return shiftPlayDays(body, now);
  return shiftTimes(body, now - recordedAt);
}
