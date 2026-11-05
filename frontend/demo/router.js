// Таблица маршрутов демо и разбор запроса. Описание для тех, кто пишет обработчики: см. шапку handlers/index.js.
// Чистый модуль (без window): запись, проверка покрытия и проверка контракта в Node грузят его же.
import { queryOf, reqKey } from './keys.js';

// Ответ с кодом, отличным от 200
export class Reply {
  constructor(status, body) { this.status = status; this.body = body; }
}
export const reply = (status, body) => new Reply(status, body);

// Отказ, каким отвечает настоящий сервер: { error, reason, params }. Причина кодом — текст на языке человека берёт
// само приложение (apiError.js → t.err_reason)
export const fail = (status, error, reason, params) => new Reply(status, { error, ...(reason ? { reason } : {}), ...(params ? { params } : {}) });
// В демо это не работает: what — о чём заметка (ключ в texts.js). Бросают из обработчика: `throw off('lookup')`
export const off = (what) => fail(409, 'demo-off', 'demo-off', { what });

const KINDS = ['rec', 'mut', 'calc', 'off'];

// Шаблон пути → { segments, fixed }: «:имя» — один отрезок, «*» в конце — всё остальное
function compile(template) {
  const segments = template.split('/').slice(1).map((s) => (s === '*' ? { rest: true } : s.startsWith(':') ? { param: s.slice(1) } : { text: s }));
  return { segments, fixed: segments.filter((s) => s.text !== undefined).length };
}

function matchPath(compiled, pathname) {
  const parts = pathname.split('/').slice(1);
  const params = {};
  const { segments } = compiled;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.rest) { params['*'] = parts.slice(i).map(decodeURIComponent).join('/'); return params; }
    if (i >= parts.length) return null;
    if (seg.param) {
      try { params[seg.param] = decodeURIComponent(parts[i]); } catch { return null; }
    } else if (seg.text !== parts[i]) return null;
  }
  return parts.length === segments.length ? params : null;
}

// files — список функций register(r) из handlers/index.js
export function createRouter(files) {
  const routes = [];

  const add = (kind, method, template, a, b) => {
    if (!KINDS.includes(kind)) throw new Error(`demo router: неизвестный вид «${kind}»`);
    const route = { kind, method, template, ...compile(template), q: [], handler: null, what: '' };
    if (kind === 'off') route.what = String(a || '');
    else if (kind === 'rec') { route.q = a?.q || []; route.handler = b || null; } else route.handler = a;
    if (kind === 'off' && !route.what) throw new Error(`demo router: ${method} ${template}: у off нужно «что» (what)`);
    if ((kind === 'mut' || kind === 'calc') && typeof route.handler !== 'function') throw new Error(`demo router: ${method} ${template}: нужен обработчик`);
    if (routes.some((x) => x.method === method && x.template === template)) throw new Error(`demo router: ${method} ${template} уже есть`);
    routes.push(route);
  };
  const r = {
    rec: (method, template, opts, post) => add('rec', method, template, opts, post),
    mut: (method, template, handler) => add('mut', method, template, handler),
    calc: (method, template, handler) => add('calc', method, template, handler),
    off: (method, template, what) => add('off', method, template, what),
  };
  for (const register of files) register(r);

  // Из подходящих берётся тот, где больше постоянных отрезков: /api/games/space раньше /api/games/:id
  function match(method, pathname) {
    let best = null;
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPath(route, pathname);
      if (params && (!best || route.fixed > best.route.fixed)) best = { route, params };
    }
    return best;
  }

  // req: { method, url, body, signal }; env: { store, emit, now, lang, warn }
  // Ответ: { status, body }. body — то, что станет JSON; у HEAD — null
  async function dispatch(req, env) {
    const warn = env.warn || console.warn;
    const method = String(req.method || 'GET').toUpperCase();
    const u = new URL(req.url, 'http://demo.invalid');
    const found = match(method === 'HEAD' ? 'GET' : method, u.pathname);
    if (!found) {
      warn(`[demo] unhandled ${method} ${u.pathname}`);
      return { status: 404, body: { error: 'demo: no such route' } };
    }
    const { route, params } = found;
    const done = (res) => (method === 'HEAD' ? { status: res.status, body: null } : res);
    if (route.kind === 'off') return done({ status: 409, body: off(route.what).body });
    if (method === 'HEAD') return { status: 200, body: null };

    const query = queryOf(u.search);
    const key = reqKey(u.pathname, query, route.q);
    const ctx = {
      method, path: u.pathname, params, query, body: req.body ?? null, key, lang: env.lang || 'en',
      store: env.store, emit: env.emit || (() => {}), now: env.now || Date.now, signal: req.signal,
    };
    try {
      let out;
      if (route.kind === 'rec') {
        out = await env.store.read(key);
        if (out === undefined) {
          warn(`[demo] unrecorded ${method} ${key}`);
          return { status: 404, body: { error: 'demo: not recorded' } };
        }
        if (route.handler) out = await route.handler(ctx, out);
      } else {
        out = await route.handler(ctx);
      }
      if (out === undefined) throw new Error(`обработчик ${method} ${route.template} ничего не вернул`);
      return out instanceof Reply ? { status: out.status, body: out.body } : { status: 200, body: out };
    } catch (e) {
      if (e instanceof Reply) return { status: e.status, body: e.body };
      warn(`[demo] unhandled error ${method} ${u.pathname}: ${e?.message || e}`);
      return { status: 500, body: { error: 'demo: handler failed' } };
    }
  }

  return { routes, match, dispatch };
}
