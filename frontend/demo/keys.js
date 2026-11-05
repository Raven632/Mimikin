// Ключи демо — в одном месте: их пишет запись (tests/demo/record.js), читает страница. Свои копии этих правил
// у записи и у страницы разошлись бы молча, и ответ «не записан» вылез бы только в демо.
// Чистый модуль: работает и в браузере, и в Node.

const enc = encodeURIComponent;

// Параметры запроса — простым объектом (повтор имени: последний)
export function queryOf(search) {
  const out = {};
  for (const [k, v] of new URLSearchParams(search)) out[k] = v;
  return out;
}

// Ключ записанного ответа: путь плюс только те параметры, что выбирают ответ (q у маршрута), по алфавиту.
// Остальные (метка версии v, ширина w) на ответ не влияют и ключ не меняют
export function reqKey(pathname, query = {}, q = []) {
  const pairs = [...q].sort().filter((name) => query[name] !== undefined).map((name) => `${enc(name)}=${enc(query[name])}`);
  return pairs.length ? `${pathname}?${pairs.join('&')}` : pathname;
}

// Ключ картинки, звука или видео: путь плюс f и key. Ширина ?w= не входит — обложки лежат оригиналами, а метка
// версии ?v= говорит лишь «файл новый», в демо файл один. В dev файлы библиотеки идут через /media — приставку срезаем
const MEDIA_PARAMS = ['f', 'key'];
export function mediaKey(url) {
  const u = new URL(url, 'http://demo.invalid');
  const path = u.pathname.replace(/^\/media\//, '/');
  return reqKey(path, queryOf(u.search), MEDIA_PARAMS);
}
