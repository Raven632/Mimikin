// Список обработчиков демо. Файлы по областям лежат рядом: каждый — функция register(r). Явный список, а не
// import.meta.glob: его грузит и Node (запись, проверка покрытия), а у Node glob нет.
//
//   export default function register(r) {
//     r.rec('GET', '/api/games');                                  // записанный ответ, обработчик не нужен
//     r.rec('GET', '/api/games/trash', { q: ['count'] });          // q — параметры запроса, что выбирают ответ
//     r.mut('POST', '/api/games/:id/meta', async (ctx) => {...});  // меняет память демо (ctx.store), отвечает как сервер
//     r.calc('GET', '/api/lines/search', (ctx) => {...});          // считает ответ из памяти, ничего не меняя
//     r.off('POST', '/api/games/:id/rescrape', 'lookup');          // 409 demo-off, params.what = 'lookup'
//   }
//
// Обработчик: async (ctx) => значение (JSON) | reply(status, body); `throw off('что')` / `throw fail(status, 'текст', 'код')`.
// ctx: method, path, params, query, body, key, lang, store, emit(event, ...args), now(), signal.
// Полное описание — router.js (reply, fail, off). Тексты заметок по ключу «что» — texts.js: новое «что» без текста там покажет
// общую заметку «это работает на вашем сервере».
import session from './session.js';
import games from './games.js';
import translate from './translate.js';
import play from './play.js';
import gallery from './gallery.js';
import settings from './settings.js';

export default [session, games, translate, play, gallery, settings];
