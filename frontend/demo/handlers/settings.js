// Настройки, службы, «Найти» и «Отложенные», подбор «Во что поиграть?». Записанное читается как есть; то, что на настоящем
// сервере записывается (параметры, любимые теги, отложенные игры), меняется в памяти страницы. Ключи, пароли и службы — заметка:
// набранное в такие поля никуда не уходит и нигде не хранится.
import { fail, off } from '../router.js';
import { bodyOf, text } from './lib.js';

export default function register(r) {
  // --- Настройки ---
  r.rec('GET', '/api/settings');
  r.mut('POST', '/api/settings/options', async (ctx) => {
    const { name, value } = bodyOf(ctx);
    const info = await ctx.store.read('/api/settings');
    const opt = info?.options?.[name];
    if (!opt) throw fail(400, 'Неизвестный параметр');
    // Разбор картинок запускает модель на сервере владельца; в демо её нет, и переключатель остаётся выключенным
    if (name === 'picture_analysis') throw off('analysis');
    if (typeof opt.def === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < opt.min || n > opt.max) throw fail(400, 'Неверное значение');
      opt.value = n;
    } else if (typeof opt.def === 'boolean') opt.value = !!value;
    else opt.value = String(value);
    return info;
  });
  // Ключи и пароли служб: поле можно набрать, «Сохранить» — заметка (всё равно бы ушло на сервер и осело там зашифрованным)
  r.off('POST', '/api/settings/:name', 'secrets');
  r.off('POST', '/api/settings/update', 'update');
  r.off('POST', '/api/settings/seedbox/pull', 'server');
  r.off('POST', '/api/settings/relay/:what', 'server');
  for (const key of ['services', 'server', 'update', 'problem-report', 'seedbox', 'relay']) r.rec('GET', `/api/settings/${key}`);

  // Любимые теги и знакомые языки: список заменяется целиком, как на сервере
  const list = (v, max) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.trim() && x.length <= max).map((x) => x.trim()))].slice(0, 100) : null);
  r.rec('GET', '/api/settings/favorite-tags');
  r.mut('POST', '/api/settings/favorite-tags', async (ctx) => {
    const tags = list(bodyOf(ctx).tags, 60);
    if (!tags) throw fail(400, 'Неверный список');
    return ctx.store.write('/api/settings/favorite-tags', { tags });
  });
  r.rec('GET', '/api/settings/known-langs');
  r.mut('POST', '/api/settings/known-langs', async (ctx) => {
    const langs = list(bodyOf(ctx).langs, 12);
    if (!langs) throw fail(400, 'Неверный список');
    return ctx.store.write('/api/settings/known-langs', { langs });
  });

  r.off('GET', '/api/backup', 'download');
  r.off('POST', '/api/backup/restore', 'files');
  r.rec('GET', '/api/storage');
  r.rec('GET', '/api/check');
  r.off('POST', '/api/check', 'check');
  r.off('POST', '/api/check/cancel', 'check');
  r.rec('GET', '/api/downloads');
  r.off('POST', '/api/downloads', 'server');
  r.off('POST', '/api/downloads/:key/retry', 'server');
  r.off('DELETE', '/api/downloads/:key', 'server');
  r.rec('GET', '/api/errors');
  r.mut('DELETE', '/api/errors/:id', async (ctx) => {
    const errors = await ctx.store.read('/api/errors');
    errors.games = (errors.games || []).filter((g) => g.id !== ctx.params.id);
    return { success: true };
  });

  // --- «Найти» и «Отложенные». Сайтов в демо нет: подбор говорит об этом сам (recommend/modes: offline), а страницы выдачи
  // отвечают как сервер без интернета. Отложенные игры (выдуманные записи) показываются и убираются
  r.rec('GET', '/api/itch/meta');
  const offline = () => { throw fail(503, 'Сервер работает без интернета (OFFLINE=1)', 'offline'); };
  r.calc('GET', '/api/itch/latest', offline);
  r.calc('GET', '/api/itch/game', offline);

  r.rec('GET', '/api/wishlist');
  r.mut('POST', '/api/wishlist', async (ctx) => {
    const body = bodyOf(ctx);
    const url = text(body.url, 300);
    if (body.source !== 'itch' || !url) throw fail(400, 'Не получилось');
    const str = (v, max) => String(v ?? '').trim().slice(0, max);
    const entry = {
      key: `itch:${url}`, source: 'itch', ref: url, url, addedAt: ctx.now(),
      info: {
        title: str(body.title, 200), cover: '', screens: [], creator: str(body.creator, 100), genre: str(body.genre, 50), price: str(body.price, 20),
        platforms: Array.isArray(body.platforms) ? body.platforms.filter((p) => typeof p === 'string').slice(0, 5) : [],
        description: str(body.description, 400), createdAt: Number(body.createdAt) || 0, updatedAt: Number(body.updatedAt) || 0,
      },
    };
    const wish = await ctx.store.read('/api/wishlist');
    wish.items = [entry, ...wish.items.filter((x) => x.key !== entry.key)];
    ctx.emit('wishlist-changed');
    return entry;
  });
  r.mut('DELETE', '/api/wishlist', async (ctx) => {
    const wish = await ctx.store.read('/api/wishlist');
    const before = wish.items.length;
    wish.items = wish.items.filter((x) => x.key !== ctx.query.key);
    if (wish.items.length !== before) ctx.emit('wishlist-changed');
    return { removed: wish.items.length !== before };
  });

  // --- «Во что поиграть?» ---
  r.rec('GET', '/api/recommend/modes');
  // «Не предлагать»: убранные игры лежат в памяти страницы и пропадают из подбора; «Вернуть» (Настройки) очищает их
  const gone = (ctx) => (ctx.store.state.dismissed ||= new Set());
  r.rec('GET', '/api/recommend/library', {}, (ctx, body) => {
    const hidden = gone(ctx);
    if (!hidden.size) return body;
    const items = body.items.filter((i) => !hidden.has(i.id));
    return { ...body, items, total: Math.max(0, body.total - (body.items.length - items.length)), ...(body.resume ? { resume: body.resume.filter((i) => !hidden.has(i.id)) } : {}) };
  });
  r.mut('POST', '/api/recommend/dismiss', async (ctx) => {
    const { key, undo } = bodyOf(ctx);
    if (typeof key !== 'string' || !key || key.length > 300) throw fail(400, 'Непонятно, что скрыть', 'bad-key');
    if (undo === true) gone(ctx).delete(key); else gone(ctx).add(key);
    return { ok: true, dismissed: gone(ctx).size };
  });
  r.rec('GET', '/api/recommend/dismissed', {}, (ctx, body) => ({ count: body.count + gone(ctx).size }));
  r.mut('DELETE', '/api/recommend/dismissed', async (ctx) => {
    gone(ctx).clear();
    (await ctx.store.read('/api/recommend/dismissed')).count = 0;
    return { ok: true, dismissed: 0 };
  });
}
