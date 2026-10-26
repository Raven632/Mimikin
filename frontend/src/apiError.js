// Ошибка запроса к серверу — для показа человеку. Сервер пишет причину по-русски: в русском
// интерфейсе показываем её как есть, она точнее; в английском и немецком — своё сообщение по коду
// ответа («не найдено», «нужно войти»), а нет такого — сообщение действия (fallback) или общее.
// До сервера запрос не дошёл (нет кода ответа) — это сеть (offline), а не текст браузера
// вроде «Failed to fetch»
export function errorText(t, err, { fallback = '', byStatus = {}, offline = t.err_net } = {}) {
  const status = err?.status || 0;
  if (!status) return offline;
  const message = String(err.error ?? err.message ?? '').trim();
  if (message && t.lang_id === 'ru') return message;
  return byStatus[status] || t.err_status[status] || fallback || t.err_status.server;
}

// Ошибка ответа сервера: его текст и код ответа — для errorText
export const httpError = (res, data) => Object.assign(new Error(data?.error || ''), { status: res.status, reason: data?.reason || '', why: data?.why || '' });
