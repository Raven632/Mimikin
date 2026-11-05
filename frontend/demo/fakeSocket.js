// Подмена socket.io-client в демо-сборке (vite.demo.config.js: alias). Сервера нет — события шлёт сам демо-роутер
// после изменений (ctx.emit('library-changed')), и страница перечитывает данные из памяти демо.
// Клиент в приложении только слушает (socket.on) и подключает/отключает по входу; ничего не отправляет.
const listeners = new Map();
const once = new WeakSet();

const fire = (event, ...args) => {
  for (const fn of [...(listeners.get(event) || [])]) {
    if (once.has(fn)) { listeners.get(event).delete(fn); once.delete(fn); }
    try { fn(...args); } catch (e) { console.error(`[demo] обработчик события ${event}:`, e); }
  }
};

const socket = {
  connected: false,
  id: 'demo',
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return socket;
  },
  once(event, fn) { once.add(fn); return socket.on(event, fn); },
  off(event, fn) {
    if (!event) listeners.clear();
    else if (!fn) listeners.delete(event);
    else listeners.get(event)?.delete(fn);
    return socket;
  },
  emit: () => socket,
  // Как у настоящего: подключение приходит чуть позже, а не сразу в той же строке
  connect() {
    if (!socket.connected) { socket.connected = true; setTimeout(() => fire('connect'), 0); }
    return socket;
  },
  disconnect() {
    if (socket.connected) { socket.connected = false; fire('disconnect', 'io client disconnect'); }
    return socket;
  },
};

export const io = () => socket;
// События «от сервера»: доходят только до подключённой страницы, как и у настоящего сокета
export const emitFromServer = (event, ...args) => { if (socket.connected) fire(event, ...args); };
