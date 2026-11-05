// Всё, что демо подменяет в браузере ДО запуска приложения: fetch и XHR к /api/, sendBeacon, ссылки на /api/, адреса
// картинок и звуков, тексты. Сервера нет; ответы дают роутер (table.js) и память (store.js). См. шапку handlers/index.js.
import { savedLang } from '../src/locales/index.js';
import { mediaKey } from './keys.js';
import { createStore } from './store.js';
import { dispatch } from './table.js';
import { emitFromServer } from './fakeSocket.js';
import { captureLinks } from './links.js';
import { showNote } from './ui.js';
import { extendLocale } from './texts.js';

const realFetch = window.fetch.bind(window);
// Откуда раздаётся демо: boot.json, d/, m/, play/ лежат рядом со страницей. Базовый путь сборки относительный («./»),
// поэтому демо живёт под любым адресом: github.io/Mimikin/demo/, свой домен, localhost/x/y/
const root = new URL(import.meta.env.BASE_URL, document.baseURI);
const fileUrl = (file) => new URL(file, root);

// ?lang=ru|en|de — выбор языка по ссылке (до загрузки текстов: savedLang читает то же место)
const wantLang = new URLSearchParams(location.search).get('lang');
if (['ru', 'en', 'de'].includes(wantLang)) {
  try { localStorage.setItem('rpg_lang', wantLang); } catch { /* хранилище закрыто — останется язык браузера */ }
}

let boot = null;
let store = null;
const ready = realFetch(fileUrl('boot.json')).then((res) => {
  if (!res.ok) throw new Error(`boot.json: ${res.status}`);
  return res.json();
}).then((data) => {
  boot = data;
  store = createStore({ boot, fetchJson: (file) => realFetch(fileUrl(file)).then((res) => res.json()) });
});

const env = () => ({ store, emit: emitFromServer, now: Date.now, lang: savedLang(), warn: console.warn });
const abortError = (signal) => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
// Короткая пауза, как у сети: быстрее useDelayedShow (250 мс), поэтому индикаторы загрузки не мигают
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError(signal)); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError(signal)); }, { once: true });
});

const isApi = (url) => url.origin === location.origin && url.pathname.startsWith('/api/');

async function readBody(init, request) {
  const raw = init.body ?? (request ? await request.clone().text() : null);
  if (typeof raw !== 'string') return raw ?? null;
  try { return raw ? JSON.parse(raw) : null; } catch { return raw; }
}

// Ответ роутера на запрос страницы. url — уже разобранный URL
async function ask({ method, url, body, signal }) {
  await ready;
  return dispatch({ method, url: url.pathname + url.search, body, signal }, env());
}

window.fetch = async function demoFetch(input, init = {}) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), location.href);
  if (!isApi(url)) return realFetch(input, init);
  const signal = init.signal || request?.signal;
  const method = (init.method || request?.method || 'GET').toUpperCase();
  const body = await readBody(init, request);
  await pause(40, signal);
  const res = await ask({ method, url, body, signal });
  if (signal?.aborted) throw abortError(signal);
  return new Response(res.body == null ? null : JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
};

// Загрузка файлов идёт через XHR (resumableUpload.js), но до неё в демо не доходит: кнопка «Добавить игру» показывает
// заметку раньше (demoStop). Это страховка: если до XHR всё же дошло, ответ даёт тот же роутер, а не сеть
const RealXHR = window.XMLHttpRequest;
window.XMLHttpRequest = class DemoXHR extends RealXHR {
  open(method, url, ...rest) {
    const parsed = new URL(String(url), location.href);
    this.demoCall = isApi(parsed) ? { method: String(method).toUpperCase(), url: parsed } : null;
    // настоящий open нужен, чтобы setRequestHeader и upload не падали; адрес пустой — в сеть ничего не уйдёт
    return super.open(method, this.demoCall ? 'data:,' : url, ...rest);
  }

  send(body) {
    if (!this.demoCall) { super.send(body); return; }
    const { method, url } = this.demoCall;
    ask({ method, url, body: typeof body === 'string' ? body : null }).then((res) => {
      const text = JSON.stringify(res.body);
      const own = { readyState: 4, status: res.status, statusText: '', responseText: text, response: this.responseType === 'json' ? res.body : text };
      for (const [k, v] of Object.entries(own)) Object.defineProperty(this, k, { value: v, configurable: true });
      for (const type of ['readystatechange', 'load', 'loadend']) this.dispatchEvent(new Event(type));
    });
  }
};

// Запросы /api/ из sendBeacon (след загрузки) в демо никуда не уходят
const realBeacon = navigator.sendBeacon?.bind(navigator);
navigator.sendBeacon = (url, data) => (isApi(new URL(String(url), location.href)) ? true : realBeacon?.(url, data) ?? false);

captureLinks({ ask: (url) => ask({ method: 'GET', url }), onOff: showNote });

// Страница, открытая до выкладки новой версии, просит файл, которого уже нет (имена с хэшем). Перезагрузка берёт новую.
// Не чаще раза в 10 с: иначе настоящая поломка превратилась бы в бесконечный цикл
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  try {
    const last = Number(sessionStorage.getItem('demo_reloaded') || 0);
    if (Date.now() - last < 10000) return;
    sessionStorage.setItem('demo_reloaded', String(Date.now()));
  } catch { /* закрытое хранилище — перезагрузим без защиты один раз */ }
  location.reload();
});

// Адрес картинки или звука → файл рядом со страницей. Нет в записи — предупреждение «[demo] unhandled» (тур и проверка
// на него падают) и пустой адрес внутри демо, а не запрос на /api/ в сеть
const hooks = (window.mimikinDemo = {});
hooks.media = (url) => {
  const file = boot?.media?.[mediaKey(url)];
  if (!file) {
    console.warn(`[demo] unhandled media ${mediaKey(url)}`);
    return fileUrl('m/none').href;
  }
  return fileUrl(file).href;
};
hooks.stop = (what) => { showNote(what); return true; };
hooks.extendLocale = extendLocale;
