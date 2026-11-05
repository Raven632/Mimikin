// Перевод игры и текст на картинках: состояние читается из записи (вкладки открываются и показывают, что есть),
// действия — заметка: переводит сервер владельца, со своим ключом DeepL, Microsoft, Google или LibreTranslate.
import { fail } from '../router.js';

export default function register(r) {
  r.rec('GET', '/api/games/translation/terms');
  r.rec('GET', '/api/games/translation/usage');
  r.rec('GET', '/api/games/:id/translation');
  // Проверка перевода записана только у переведённой игры; у остальных сервер отвечает 409 «Перевод не включён» —
  // здесь так же, без записи (сверка с сервером — tests/demo/contract.test.mjs)
  r.calc('GET', '/api/games/:id/translation/check', async (ctx) => {
    const body = await ctx.store.read(ctx.key);
    if (body === undefined) throw fail(409, 'Перевод не включён', 'tl-off');
    return body;
  });

  for (const step of ['', '/pause', '/resume', '/redo', '/estimate-redo', '/fix', '/import']) r.off('POST', `/api/games/:id/translation${step}`, 'translate');
  r.off('GET', '/api/games/:id/translation/estimate', 'translate');
  r.off('GET', '/api/games/:id/translation/lines', 'translate');
  r.off('GET', '/api/games/:id/translation/export', 'download');
  // Проверка игры в окне (GameCheck) открывает её настоящую, а результат отправляет сюда
  r.off('POST', '/api/games/:id/translation/check-result', 'check');

  r.rec('GET', '/api/games/:id/pictures');
  for (const step of ['', '/pause', '/label', '/box', '/remove']) r.off('POST', `/api/games/:id/pictures${step}`, 'translate');
  r.off('GET', '/api/games/:id/pictures/review', 'translate');
  r.off('GET', '/api/games/:id/pictures/image', 'translate');
  r.off('GET', '/api/games/pictures/patch/:hash', 'translate');
}
