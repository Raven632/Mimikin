// Загрузка архива игры кусками, с продолжением после обрыва (сервер — api/src/services/uploads.js).
// Сервер помнит, сколько получил; здесь решаем, что слать и что делать, когда связь рвётся.
// Временные сбои (нет сети, деплой, зависший кусок, телефон уснул) переживаем сами: пауза и повтор
// с того места, где сервер остановился, — сколько угодно раз, пока загрузку не отменят. Сдаёмся
// только там, где повтор не поможет (нет места, не тот архив, файл не читается), и тогда сервер
// хранит полученное: тот же файл, выбранный снова, продолжит загрузку

const API = '/api/games/upload';
const MB = 1024 * 1024;
// Размер куска — под скорость: примерно CHUNK_SECONDS передачи, от 16 до 256 МБ. Мелкие куски —
// это паузы между ними: при 20 МБ на планшете пауза была длиннее самой передачи, и гигабайт шёл
// 35 секунд вместо двенадцати. Большой кусок не страшен: оборвётся — сервер сохранит всё, что дошло
const MIN_CHUNK = 16 * MB;
const MAX_CHUNK = 256 * MB;
const CHUNK_SECONDS = 8;
// Пока байты идут, браузер сообщает о ходе отправки много раз в секунду. 20 секунд тишины — это не
// медленная сеть, а зависший запрос: обрываем и пробуем снова. Через 10 секунд тишины отправляем
// на сервер журнал страницы — по нему видно, где именно застрял телефон
const STALL_MS = 20 * 1000;
const REPORT_MS = 10 * 1000;
// Когда кусок ушёл, а ответа нет, — через сколько спросить сервер и как часто спрашивать дальше
const FIRST_ASK_MS = 300;
const ASK_MS = 500;
// Паузы между повторами, дальше — по 30 с
const RETRY_MS = [2000, 5000, 10000, 20000, 30000];
// Как часто спрашивать о распаковке
const POLL_MS = 1500;

export class UploadError extends Error {
  // kind: server — сервер отказал (текст от него), read — файл не читается, cancelled — отменили.
  // stalled — запрос завис: ни байта за STALL_MS
  constructor(kind, message = '', extra = {}) {
    super(message);
    Object.assign(this, { kind, status: 0, body: null, ...extra });
  }
}

const cancelled = () => new UploadError('cancelled');
const mb = (bytes) => (bytes / MB).toFixed(1);

// Журнал загрузки: что делала страница, по шагам и секундам. Уходит в журнал сервера, когда
// загрузка встала, пошла на повтор, закончилась или её отменили. Айфон отдавал первый кусок и
// замолкал, а по серверу не понять, что он при этом делал: ждал ответа, не отправил запрос или
// отправил, но тот не дошёл
function makeTrace(file) {
  const t0 = Date.now();
  const lines = [];
  const trace = {
    id: null,
    note(text) {
      lines.push(`${((Date.now() - t0) / 1000).toFixed(1)} ${text}`);
      if (lines.length > 60) lines.splice(0, lines.length - 60);
    },
    send(why) {
      try {
        const standalone = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
        navigator.sendBeacon?.(`${API}/trace`, JSON.stringify({ id: trace.id, name: file.name, why, standalone, ua: navigator.userAgent, lines }));
      } catch { /* журнал — не главное */ }
    },
  };
  return trace;
}

// Короткий запрос с ответом JSON. Сторож обрывает его через STALL_MS: иначе уснувший телефон ждал бы
// ответа вечно
function request(method, url, { json, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (json) xhr.setRequestHeader('Content-Type', 'application/json');
    let stalled = false;
    const watchdog = setTimeout(() => { stalled = true; xhr.abort(); }, STALL_MS);
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const finish = (fn, value) => {
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    // Ответ не JSON (оборвался, страница ошибки прокси) — это сбой, а не ответ сервера
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      if (xhr.status < 300 && data) finish(resolve, data);
      else finish(reject, new UploadError('server', data?.error || '', { status: xhr.status, body: data }));
    });
    xhr.addEventListener('error', () => finish(reject, new UploadError('server')));
    xhr.addEventListener('abort', () => finish(reject, signal?.aborted ? cancelled() : new UploadError('server', '', { stalled })));
    xhr.send(json ? JSON.stringify(json) : null);
  });
}

// Кусок — файлом, а не байтами из памяти: браузер читает его с диска прямо во время отправки.
// До конца ответа на кусок не ждём. Айфон (iOS 27, и Safari, и Chrome) отправляет кусок, получает
// ответ сервера целиком — 40 байт, соединение закрыто, телефон это подтвердил, — но запрос так и не
// завершается: ни через xhr, ни через fetch. Короткие запросы у него при этом проходят. Поэтому,
// как только кусок ушёл, спрашиваем сервер, сколько он получил: подтвердил — кусок принят, зависший
// запрос бросаем. На остальных устройствах ответ приходит раньше первого вопроса
function sendChunk(url, body, { id, end, onUpload, signal, trace }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const log = (text) => trace.note(`  ${text}`);
    let moved = Date.now();
    let reported = false;
    let stalled = false;
    let settled = false;
    let sent = 0;
    let sentAt = 0;
    let confirmed = 0;
    let askTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(askTimer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    // Пока байты идут, браузер сообщает о ходе отправки много раз в секунду: тишина — это зависание
    const watchdog = setInterval(() => {
      const quiet = Date.now() - moved;
      if (!reported && quiet > REPORT_MS) {
        reported = true;
        log(`тишина ${Math.round(quiet / 1000)} с: состояние ${xhr.readyState}, ушло ${mb(sent)} МБ`);
        trace.send('кусок молчит');
      }
      if (quiet > STALL_MS) {
        stalled = true;
        xhr.abort();
      }
    }, 1000);
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort);

    // Кусок ушёл, а ответа всё нет — спрашиваем сервер. Отказ (заголовки пришли, тело — нет) —
    // по коду из заголовков: что делать с 409, 404 или 507, решает run()
    const ask = async () => {
      if (settled) return;
      if (xhr.readyState >= 2 && xhr.status >= 400) {
        log(`отказ ${xhr.status}, текст не дошёл`);
        finish(reject, new UploadError('server', '', { status: xhr.status }));
        xhr.abort();
        return;
      }
      try {
        const st = await request('GET', `${API}/status?id=${id}`, { signal });
        if (settled) return;
        if (st.received > confirmed) { confirmed = st.received; moved = Date.now(); }
        if (st.received >= end || st.state !== 'uploading') {
          log(`ответ не завершился — сервер подтвердил ${mb(st.received)} МБ через ${((Date.now() - sentAt) / 1000).toFixed(1)} с`);
          finish(resolve, { received: st.received, state: st.state === 'uploading' ? 'uploading' : 'processing' });
          xhr.abort();
          return;
        }
      } catch { /* не ответил — спросим ещё */ }
      askTimer = setTimeout(ask, ASK_MS);
    };

    xhr.upload.addEventListener('loadstart', () => log('отправка началась'));
    xhr.upload.addEventListener('progress', (e) => {
      moved = Date.now();
      sent = e.loaded;
      onUpload(e.loaded);
    });
    xhr.upload.addEventListener('load', () => {
      sentAt = Date.now();
      log(`ушло всё, ${mb(sent)} МБ`);
      askTimer = setTimeout(ask, FIRST_ASK_MS);
    });
    xhr.addEventListener('readystatechange', () => { if (xhr.readyState === 2) log(`пришёл ответ ${xhr.status}`); });
    xhr.addEventListener('progress', () => { moved = Date.now(); });
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      if (xhr.status < 300 && data) finish(resolve, data);
      else {
        log(`отказ ${xhr.status}: ${data?.error || 'ответ не JSON'}`);
        finish(reject, new UploadError('server', data?.error || '', { status: xhr.status, body: data }));
      }
    });
    xhr.addEventListener('error', () => {
      log(`сбой сети, ушло ${mb(sent)} МБ`);
      finish(reject, new UploadError('server'));
    });
    xhr.addEventListener('abort', () => {
      if (settled) return;
      if (stalled) log(`завис: ${Math.round(STALL_MS / 1000)} с ни байта, состояние ${xhr.readyState}, ушло ${mb(sent)} МБ`);
      finish(reject, signal?.aborted ? cancelled() : new UploadError('server', '', { stalled }));
    });
    xhr.send(body);
  });
}

// Повтор поможет: нет связи (0), сервер перезапускается или перегружен, лимит запросов,
// файл сейчас пишет другой запрос (409). 507 (нет места) и прочие 4xx — не помогут
const worthRetry = (status) => status === 0 || status === 408 || status === 409 || status === 429 || (status >= 500 && status !== 507);

// Пауза перед повтором. Вернулись на страницу или появилась сеть — повторяем сразу, не дожидаясь
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const stop = (fn) => () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', done);
      signal?.removeEventListener('abort', onAbort);
      fn(cancelled());
    };
    const done = stop(() => resolve());
    const onAbort = stop(reject);
    const onVisible = () => { if (!document.hidden) done(); };
    const timer = setTimeout(done, ms);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', done);
    signal?.addEventListener('abort', onAbort);
  });
}

async function readSlice(file, start, end) {
  try {
    return await file.slice(start, end).arrayBuffer();
  } catch {
    throw new UploadError('read');
  }
}

// cyrb53 — быстрый 53-битный хэш: crypto.subtle есть только на https
function cyrb53(bytes, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 2654435761);
    h2 = Math.imul(h2 ^ bytes[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Отпечаток — хэш первого и последнего мегабайта: по нему (с именем и размером) сервер узнаёт тот же
// файл, выбранный снова — после перезагрузки страницы или на другом устройстве
async function fingerprint(file) {
  const head = new Uint8Array(await readSlice(file, 0, Math.min(MB, file.size)));
  const tail = new Uint8Array(await readSlice(file, Math.max(0, file.size - MB), file.size));
  return cyrb53(head).toString(36) + cyrb53(tail, 1).toString(36);
}

// Экран не гаснет, пока идёт загрузка: погасший айфон усыпляет страницу. Работает только на https;
// нет — не беда: уснувшую загрузку разбудит возвращение на страницу
async function keepAwake() {
  let lock = null;
  const grab = async () => {
    try { if (!document.hidden && navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch { /* нельзя — и ладно */ }
  };
  const onVisible = () => { if (!document.hidden) grab(); };
  document.addEventListener('visibilitychange', onVisible);
  await grab();
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    lock?.release().catch(() => {});
  };
}

// Загрузки, начатые на этом устройстве. Недогруженную сервер считает «идущей сейчас», пока в неё
// недавно писали, и другому устройству не даёт её удалить. Но если страницу перезагрузили здесь же
// (айфон выгружает её из памяти), продолжить свою надо сразу, а не ждать полминуты
const OWN_KEY = 'rpg-own-uploads';
const ownUploads = () => {
  try { return JSON.parse(localStorage.getItem(OWN_KEY)) || []; } catch { return []; }
};
const rememberOwn = (id) => {
  try { localStorage.setItem(OWN_KEY, JSON.stringify([id, ...ownUploads().filter((x) => x !== id)].slice(0, 10))); } catch { /* не запомнили — не беда */ }
};

// Размер следующего куска: сколько при такой скорости уйдёт за seconds, кратно мегабайту
const nextChunk = (bytes, ms, seconds) => Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.round((bytes / Math.max(ms, 200)) * 1000 * seconds / MB) * MB));

// Загрузка по шагам: start — узнать у сервера, сколько он уже получил; upload — слать кусок с этого
// места; resync — после сбоя спросить, сколько дошло (оборванный кусок записан частично);
// processing — ждать распаковку; password — архив под паролем, спросить его через askPassword.
// onState({ phase, id, received, size, resumed, step, retryIn, wrong })
async function run(file, { onState, signal, trace, askPassword, target, mode }) {
  const { size } = file;
  let phase = 'start';
  let id = null;
  let received = 0;
  let failures = 0;
  let restarts = 0;
  let print = null;
  let chunk = MIN_CHUNK;
  for (;;) {
    if (signal?.aborted) throw cancelled();
    try {
      if (phase === 'start') {
        const t = Date.now();
        print = print || await fingerprint(file);
        const s = await request('POST', `${API}/start`, { json: { name: file.name, size, fingerprint: print, target, mode }, signal });
        ({ id, received } = s);
        trace.id = id;
        trace.note(`начало: ${mb(received)} из ${mb(size)} МБ уже на сервере (${Date.now() - t} мс)`);
        rememberOwn(id);
        phase = s.state === 'uploading' ? 'upload' : 'processing';
        onState({ phase, id, received, size, resumed: phase === 'upload' && received > 0 });
      } else if (phase === 'resync') {
        const st = await request('GET', `${API}/status?id=${id}`, { signal });
        trace.note(`на сервере ${mb(st.received)} МБ`);
        received = st.received;
        phase = st.state === 'uploading' ? 'upload' : 'processing';
        onState({ phase, id, received, size });
      } else if (phase === 'upload') {
        const from = received;
        const end = Math.min(from + chunk, size);
        const body = file.slice(from, end);
        const url = `${API}/chunk?id=${id}&offset=${from}`;
        trace.note(`→ кусок ${mb(from)}–${mb(end)} МБ`);
        const t = Date.now();
        const r = await sendChunk(url, body, { id, end, signal, trace, onUpload: (loaded) => onState({ phase, id, received: from + loaded, size }) });
        trace.note(`← ${mb(r.received)} МБ за ${((Date.now() - t) / 1000).toFixed(1)} с`);
        chunk = nextChunk(r.received - from, Date.now() - t, CHUNK_SECONDS);
        received = r.received;
        failures = 0;
        restarts = 0;
        if (r.state !== 'uploading') phase = 'processing';
        onState({ phase, id, received, size });
      } else {
        const st = await request('GET', `${API}/status?id=${id}`, { signal });
        failures = 0;
        if (st.state === 'done') return st;
        if (st.state === 'error') throw new UploadError('server', st.error, { processed: true });
        if (st.state === 'uploading') {
          phase = 'upload';
          received = st.received;
          continue;
        }
        // Архив под паролем: спрашиваем у человека и отдаём серверу. Проверит его сама распаковка:
        // не подошёл — сервер снова ждёт пароля, с пометкой, и мы спросим ещё раз
        if (st.state === 'password') {
          const wrong = !!st.error;
          trace.note(wrong ? 'пароль не подошёл' : 'архив под паролем');
          onState({ phase: 'password', id, received: size, size, wrong });
          const password = await askPassword();
          await request('POST', `${API}/password?id=${id}`, { json: { password }, signal });
          trace.note('пароль отдан серверу');
          onState({ phase: 'processing', id, received: size, size, step: '', wrong: false });
          continue;
        }
        onState({ phase, id, received: size, size, step: st.step });
        await pause(POLL_MS, signal);
      }
    } catch (e) {
      // parked — пароль не ждём (за архивом очередь, Toolbar.jsx): это не сбой, повтор не нужен
      if (e.kind === 'cancelled' || e.kind === 'parked' || e.processed) throw e;
      if (e.kind === 'read') throw Object.assign(e, { received });
      const { status, body } = e;
      // Не с того места (ответ на прошлый кусок потерялся) — сервер сказал, с какого
      if (status === 409 && typeof body?.received === 'number') { received = body.received; phase = 'upload'; continue; }
      // Файл уже получен целиком (дослали с другого устройства) — ждём распаковку
      if (status === 409 && body?.state) { phase = 'processing'; continue; }
      // Загрузки больше нет (отменили с другого устройства, убрала уборка) — начинаем заново,
      // но не по кругу: пропала и снова — это уже не случайность. 404 на самом начале — нет игры,
      // которую обновляют: тут начинать заново нечего
      if (status === 404 && phase !== 'start' && restarts++ < 2) { phase = 'start'; continue; }
      if (!worthRetry(status)) {
        trace.send(`ошибка ${status}`);
        throw Object.assign(e, { received });
      }
      failures += 1;
      if (phase === 'upload') {
        chunk = MIN_CHUNK;
        // Файл, который браузер не может прочитать, выглядит как сбой сети: после двух неудач
        // подряд проверяем, читается ли он вообще
        if (failures >= 2) {
          try {
            await readSlice(file, received, Math.min(received + 1, size));
          } catch (err) {
            trace.send('файл не читается');
            throw Object.assign(err, { received });
          }
        }
      }
      const wait = RETRY_MS[Math.min(failures, RETRY_MS.length) - 1];
      trace.note(`повтор через ${wait / 1000} с`);
      trace.send('повтор');
      onState({ phase: 'retry', id, received, size, retryIn: Math.round(wait / 1000) });
      await pause(wait, signal);
      if (phase === 'upload') phase = 'resync';
    }
  }
}

// Загрузить архив. Вернёт { folder } готовой игры или бросит UploadError. target — папка игры из
// библиотеки, которую архив обновляет: новая версия встанет на её место. mode: 'patch' — архив не
// новая версия, а патч или мод: ляжет поверх игры target
export async function uploadArchive(file, { onState, signal, askPassword, target, mode }) {
  const trace = makeTrace(file);
  // Уход страницы в фон и пропажа сети — тоже в журнал: айфон усыпляет скрытую страницу
  const onVisibility = () => trace.note(document.hidden ? 'страница скрыта' : 'страница снова видна');
  const onOffline = () => trace.note('сеть пропала');
  const onOnline = () => trace.note('сеть вернулась');
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  const release = await keepAwake();
  const t0 = Date.now();
  try {
    const result = await run(file, { onState, signal, trace, askPassword, target, mode });
    trace.note(`готово за ${Math.round((Date.now() - t0) / 1000)} с`);
    trace.send('готово');
    return result;
  } catch (e) {
    if (e.kind === 'cancelled') {
      trace.note('отменили');
      trace.send('отмена');
    }
    throw e;
  } finally {
    release();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
  }
}

// Недогруженные, распаковывающиеся и неудачные загрузки. Свои не бывают «чужими идущими»
export const listUploads = async () => {
  const own = ownUploads();
  return (await request('GET', `${API}/list`)).map((u) => (own.includes(u.id) ? { ...u, busy: false } : u));
};

// Отменить: сервер удаляет недогруженное. Неудачную — убирает из списка
export const cancelUpload = (id) => request('POST', `${API}/cancel?id=${id}`);

// Пароль к архиву, который его ждёт (из карточки «не догружено» — загрузку на этой странице уже закрыли)
export const sendPassword = (id, password) => request('POST', `${API}/password?id=${id}`, { json: { password } });
