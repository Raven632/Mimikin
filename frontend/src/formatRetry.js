// Когда будет следующая попытка найти метаданные. Ближайшие повторы (сбой
// источника — через час-шесть) показываем временем, дальние — датой.
export function formatRetry(ts, lang) {
  if (!ts) return '';
  const locale = lang === 'en' ? 'en-US' : lang === 'de' ? 'de-DE' : 'ru-RU';
  const date = new Date(ts);
  if (ts - Date.now() < 20 * 60 * 60 * 1000) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

// Что у игры есть из найденного, а чего нет — списком: «Нет картинок или ссылки» не говорило, чего
// именно не хватает. Ссылка — на страницу игры на сайте, по ней поиск идёт точно
export function metaParts(game) {
  const links = String(game.link || '').split(/[\s,]+/).filter(Boolean);
  return [
    ['description', !!game.description],
    ['tags', (game.tags || []).length > 0],
    ['cover', !!game.cover],
    ['screens', (game.screens || []).length > 0],
    ['link', links.length > 0],
  ];
}

// Подпись состояния поиска для игры: что случилось и что будет дальше
export function describeMeta(meta, t, lang) {
  if (!meta || meta.status === 'ok') return null;
  const due = meta.retryAt && meta.retryAt <= Date.now();
  if (meta.status === 'new' || due) return { text: t.meta_line_new, searching: true };

  const parts = [];
  if (meta.status === 'error' && meta.error) parts.push(t.meta_failed(meta.error));
  if (meta.attempts) parts.push(t.meta_attempts(meta.attempts));
  parts.push(meta.retryAt ? t.meta_next(formatRetry(meta.retryAt, lang)) : t.meta_stopped);

  const head = {
    partial: t.meta_line_partial,
    not_found: t.meta_line_not_found,
    error: t.meta_line_error,
  }[meta.status] || t.meta_line_not_found;

  return { text: head, details: parts.join(', '), searching: false };
}
