import { useEffect, useState } from 'react';

// Поиск по репликам сцен (сервер: /api/lines/search, services/sceneLines.js). Общее для полки под поиском библиотеки
// (LineShelf) и окна «Поиск по репликам» (LineSearch)

// Письменности без пробелов между словами: в них ищется и один знак («夫»)
const SOLID = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}ー々〆]/u;

// То же правило, что на сервере (parseQuery): есть знак CJK или в словах от двух букв в сумме от трёх букв. Короче
// («он», «t») сервер ответит 400 — такой запрос нашёл бы полбиблиотеки
export const lineQueryOk = (q) => {
  const s = String(q || '').trim();
  if (!s || s.length > 100) return false;
  if (SOLID.test(s)) return true;
  let n = 0;
  for (const w of s.normalize('NFKC').split(/[^\p{L}\p{N}]+/u)) {
    const len = [...w].length;
    if (len >= 2) n += len;
  }
  return n >= 3;
};

// Части реплики для подсветки: hl — [[от, до]] найденных слов (сервер) → [{ text, hit }]
export const lineParts = (text, hl) => {
  const out = [];
  let at = 0;
  for (const [a, b] of Array.isArray(hl) ? hl : []) {
    if (a < at || b <= a || b > text.length) continue;
    if (a > at) out.push({ text: text.slice(at, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
};

// Что передать галерее (GameGallery, initialScene), чтобы плеер открылся на этой реплике. Обрезанный текст («…») для
// сверки не годится — тогда только номер реплики
export const sceneAt = (scene, line) => ({ key: scene.key, n: scene.n, stop: line.stop, text: line.cut ? '' : line.text, lang: line.lang });

// Последние ответы: набрал, стёр, набрал снова — без нового запроса (у API предел 200 запросов в минуту)
const MEMO = 30;
const memo = new Map();
const PAUSE_MS = 450;

// Ответ на запрос q: { data, error, busy }. Запрос уходит, когда человек перестал печатать; новый отменяет прежний
export function useLineSearch(q, { game = '', limit = 24, enabled = true } = {}) {
  const text = String(q || '').trim();
  const active = enabled && lineQueryOk(text);
  const url = `/api/lines/search?q=${encodeURIComponent(text)}&limit=${limit}${game ? `&game=${encodeURIComponent(game)}` : ''}`;
  const [res, setRes] = useState({ url: '' });
  useEffect(() => {
    if (!active || memo.has(url)) return undefined;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(url, { signal: ctl.signal })
        .then((r) => r.json().then((d) => { if (!r.ok) throw Object.assign(new Error(d.error || String(r.status)), { status: r.status }); return d; }))
        .then((data) => {
          if (memo.size >= MEMO) memo.delete(memo.keys().next().value);
          // Индекс ещё строится — ответ не запоминаем: через минуту он будет полнее
          if (!data.building) memo.set(url, data);
          setRes({ url, data });
        })
        .catch((e) => { if (e.name !== 'AbortError') setRes({ url, error: e.status === 503 ? 'unavailable' : 'failed' }); });
    }, PAUSE_MS);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [active, url]);
  if (!active) return { data: null, error: '', busy: false };
  if (memo.has(url)) return { data: memo.get(url), error: '', busy: false };
  // Ответ на прежний запрос не показываем: он ждёт нового
  const fresh = res.url === url;
  return { data: fresh ? res.data || null : null, error: fresh ? res.error || '' : '', busy: !fresh };
}
