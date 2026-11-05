// Запуск игры, сейвы, моменты и «Путь». Настоящей игры в демо нет: «Играть» открывает в рамке игры титульную страницу
// выдуманной игры (demo-data/play/<id>.html, её делает tests/demo/record.js) с кнопкой «В библиотеку».
import { fail } from '../router.js';
import { bodyOf, gameOf } from './lib.js';

const e = encodeURIComponent;

export default function register(r) {
  // Где лежит страница, считаем от адреса, с которого открыто демо: оно живёт под любым путём (github.io/Mimikin/demo/, свой домен).
  // check нет нарочно: проверять «свой ли сервер игр» незачем, запуск в рамке не ждёт
  r.calc('POST', '/api/play/:id', async (ctx) => {
    const game = await gameOf(ctx, ctx.params.id);
    // Игры на полке нет на диске, как и страницы для неё
    if (game.shelf) throw fail(404, 'Игра не найдена');
    const base = globalThis.document?.baseURI || 'http://demo.invalid/';
    return { mode: 'frame', origin: globalThis.location?.origin || 'http://demo.invalid', path: new URL(`play/${e(game.id)}.html`, base).pathname };
  });

  // --- Сейвы ---
  r.rec('GET', '/api/saves/:id');
  r.rec('GET', '/api/saves/history/:id');
  // Пишет только игра в рамке, а её в демо нет; страница досылает очередь сейвов после обрыва связи — принимаем и ничего не храним
  r.calc('POST', '/api/saves/:id/:key', () => ({ success: true }));
  r.calc('DELETE', '/api/saves/:id/:key', () => ({ success: true }));

  // «Вернуть эту версию»: выбранная становится нынешней, прежняя нынешняя остаётся в списке («перед возвратом»)
  r.mut('POST', '/api/saves/history/:id/restore', async (ctx) => {
    const { key, version } = bodyOf(ctx);
    if (typeof key !== 'string' || !key || typeof version !== 'string') throw fail(400, 'Непонятно, что вернуть');
    const history = await ctx.store.read(`/api/saves/history/${e(ctx.params.id)}`);
    const slot = history?.slots?.find((s) => s.key === key);
    const back = slot?.versions.find((v) => v.id === version);
    if (!back) throw fail(404, 'Такой версии нет');
    const now = ctx.now();
    if (slot.current) slot.versions.unshift({ id: `${now}-restore.json`, at: slot.current.at, reason: 'restore', size: slot.current.size, summary: slot.current.summary });
    slot.current = { at: now, size: back.size, summary: back.summary };
    return { success: true };
  });
  r.off('GET', '/api/saves/export/:id', 'download');
  r.off('POST', '/api/saves/import/:id', 'files');

  // --- Моменты («Продолжить с…», вкладки «Путь» и «Моменты») ---
  r.rec('GET', '/api/marks/:id');
  r.mut('POST', '/api/marks/:id/:mark/keep', async (ctx) => {
    const mark = (await ctx.store.read(`/api/marks/${e(ctx.params.id)}`))?.find((m) => m.id === ctx.params.mark);
    if (!mark) throw fail(404, 'not-found');
    mark.kind = 'mark';
    return { success: true };
  });
  r.mut('PATCH', '/api/marks/:id/:mark', async (ctx) => {
    const label = bodyOf(ctx).label;
    if (typeof label !== 'string') throw fail(400, 'bad-label');
    const mark = (await ctx.store.read(`/api/marks/${e(ctx.params.id)}`))?.find((m) => m.id === ctx.params.mark);
    if (!mark) throw fail(404, 'not-found');
    mark.label = label.trim().slice(0, 120);
    return { success: true };
  });
  r.mut('DELETE', '/api/marks/:id/:mark', async (ctx) => {
    const list = await ctx.store.read(`/api/marks/${e(ctx.params.id)}`);
    const at = list ? list.findIndex((m) => m.id === ctx.params.mark) : -1;
    if (at < 0) throw fail(404, 'not-found');
    list.splice(at, 1);
    return { success: true };
  });

  r.rec('GET', '/api/journal/:id');
  r.rec('GET', '/api/journal/:id/room');
}
