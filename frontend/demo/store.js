// Память демо: записанные ответы (boot.json и ленивые файлы рядом с ним) и всё, что посетитель в них поменял.
// Живёт, пока открыта страница: перезагрузка — свежее демо. Чистый модуль без обращения к window при загрузке.
import { shiftBody } from './timeShift.js';

export function createStore({ boot, fetchJson, now = () => Date.now() }) {
  const live = new Map();
  const loading = new Map();
  const ctx = { recordedAt: boot.recordedAt, now: now() };

  const take = (key, body) => {
    shiftBody(key, body, ctx);
    live.set(key, body);
    return body;
  };
  for (const [key, body] of Object.entries(boot.rec || {})) take(key, body);

  return {
    // Не записанное и не записанное в файл — undefined. Один ленивый файл читаем один раз, даже если спросили дважды подряд
    async read(key) {
      if (live.has(key)) return live.get(key);
      const file = boot.lazy?.[key];
      if (!file) return undefined;
      if (!loading.has(key)) loading.set(key, fetchJson(file).then((body) => take(key, body)).finally(() => loading.delete(key)));
      return loading.get(key);
    },
    write(key, body) { live.set(key, body); return body; },
    has: (key) => live.has(key) || !!boot.lazy?.[key],
    // Ключи с общим началом — и прочитанные, и ещё лежащие в файлах
    list: (prefix) => [...new Set([...live.keys(), ...Object.keys(boot.lazy || {})])].filter((k) => k.startsWith(prefix)),
    // Свободное место для обработчиков: корзина, счётчики, флаги входа — всё, чего нет в записи
    state: {},
    recordedAt: boot.recordedAt,
  };
}
