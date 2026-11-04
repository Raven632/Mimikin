// Причина кодом: reason и его данные params в ответе сервера, текст — t.err_reason на языке человека.
// Незнакомый код или кода нет — ''
export function reasonText(t, err) {
  const text = t.err_reason?.[err?.reason];
  return typeof text === 'function' ? text(err.params || {}) : text || '';
}

// Ошибка запроса к серверу — для показа человеку. Есть причина кодом — её текст на любом языке. Иначе сервер пишет
// её по-русски: в русском интерфейсе показываем её как есть, она точнее; в английском и немецком — своё сообщение по
// коду ответа («не найдено», «нужно войти»), а нет такого — сообщение действия (fallback) или общее.
// До сервера запрос не дошёл (нет кода ответа) — это сеть (offline), а не текст браузера
// вроде «Failed to fetch»
export function errorText(t, err, { fallback = '', byStatus = {}, offline = t.err_net } = {}) {
  const status = err?.status || 0;
  if (!status) return offline;
  const coded = reasonText(t, err);
  if (coded) return coded;
  const message = String(err.error ?? err.message ?? '').trim();
  if (message && t.lang_id === 'ru') return message;
  return byStatus[status] || t.err_status[status] || fallback || t.err_status.server;
}

// Текст сервера без кода (журнал прохода, сообщение сборки, ошибка из чужой библиотеки): он бывает по-русски. В русском
// интерфейсе — как есть, в английском и немецком вместо русской строки fallback; английский текст чужой службы остаётся
export const serverWords = (t, text, fallback = t.err_log) => (t.lang_id !== 'ru' && /[а-яё]/i.test(text || '') ? fallback : text);

// Как прошёл проход seedbox или второй установки: неудачи (problems) по коду на языке человека, без кода — текст сервера.
// Одинаковые подряд — одной: десять архивов ждут места, причина одна
export const passWhy = (t, st) => {
  const lines = (st?.problems || []).map((p) => reasonText(t, p) || serverWords(t, p.text));
  return [...new Set(lines)].join('; ') || serverWords(t, st?.error);
};

// Ошибка ответа сервера: его текст и код ответа — для errorText
export const httpError = (res, data) => Object.assign(new Error(data?.error || ''), { status: res.status, reason: data?.reason || '', params: data?.params || null, why: data?.why || '' });
