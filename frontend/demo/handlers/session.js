// Вход, «Мой профиль» и люди. Посетитель — владелец, рядом одна выдуманная гостья (она в записи, см. tests/demo/rich.js).
// Выйти и войти снова можно: пароль и имя любые, ничего не проверяется и никуда не уходит.
import { fail } from '../router.js';
import { bodyOf, gamesOf, guardLogin, setSignedOut } from './lib.js';

const NAME_MAX = 40;
const MIN_PASS = 4;
const RIGHTS = ['request', 'download', 'upload', 'view'];
const STATES = ['', 'locked', 'removed'];

const cleanName = (raw) => (typeof raw === 'string' ? raw.normalize('NFC').trim() : '');
const fits = (name) => name.length > 0 && name.length <= NAME_MAX;
// Имена сравниваются без учёта регистра, как у сервера (utils/account.js, foldName)
const fold = (name) => name.normalize('NFC').toLowerCase();

export default function register(r) {
  r.rec('GET', '/api/setup/status');
  // Владелец в демо уже создан; экран «создайте владельца» не показывается
  r.off('POST', '/api/setup/init', 'secrets');
  r.mut('POST', '/api/login', () => { setSignedOut(false); return { success: true }; });
  r.mut('POST', '/api/logout', () => { setSignedOut(true); return { success: true }; });
  r.rec('GET', '/api/me', {}, guardLogin);

  r.off('POST', '/api/account/password', 'secrets');
  r.off('POST', '/api/account/name', 'secrets');
  r.off('PUT', '/api/account/avatar', 'files');
  r.off('DELETE', '/api/account/avatar', 'files');
  // Календарь «Мои дни за игрой»: записан за четыре месяца, дни сдвинуты так, что последний — сегодняшний (timeShift.js)
  r.rec('GET', '/api/play-days');

  // --- Люди (Настройки → Пользователи) ---
  r.rec('GET', '/api/users');
  const people = (ctx) => ctx.store.read('/api/users');
  const personOf = async (ctx) => {
    // Строки владельца среди людей нет: имя ему меняет «Мой профиль», права у него все (routes/users.js, personById)
    const person = (await people(ctx)).find((p) => p.id === ctx.params.id && !p.isOwner);
    if (!person) throw fail(404, 'Нет такого человека');
    return person;
  };
  // Другой человек уже с таким именем (владелец тоже считается). reason — как у сервера, текст берёт интерфейс
  const taken = async (ctx, name, except = '') => (await people(ctx)).some((p) => p.id !== except && p.state !== 'removed' && fold(p.name) === fold(name));

  r.mut('POST', '/api/users', async (ctx) => {
    const name = cleanName(bodyOf(ctx).name);
    const password = bodyOf(ctx).password;
    if (!fits(name)) throw fail(400, 'Неверное имя', 'name-bad');
    if (typeof password !== 'string' || password.length < MIN_PASS) throw fail(400, 'Слишком короткий пароль');
    if (await taken(ctx, name)) throw fail(409, 'Это имя уже занято', 'name-taken');
    // Пароль дальше этого места не идёт: не хранится и никуда не отправляется
    const id = `u${ctx.now().toString(16)}`;
    (await people(ctx)).push({
      id, name, mustChange: true, noPassword: false, createdAt: ctx.now(), state: '', role: 'user', isOwner: false, avatar: null,
      rights: Object.fromEntries(RIGHTS.map((k) => [k, false])),
    });
    ctx.emit('people-changed');
    return { id, name, mustChange: true };
  });
  r.mut('PATCH', '/api/users/:id', async (ctx) => {
    const person = await personOf(ctx);
    const name = cleanName(bodyOf(ctx).name);
    if (!fits(name)) throw fail(400, 'Неверное имя', 'name-bad');
    if (await taken(ctx, name, person.id)) throw fail(409, 'Это имя уже занято', 'name-taken');
    person.name = name;
    ctx.emit('people-changed');
    return { success: true, name };
  });
  r.mut('POST', '/api/users/:id/state', async (ctx) => {
    const person = await personOf(ctx);
    const state = bodyOf(ctx).state;
    if (!STATES.includes(state)) throw fail(400, 'Неизвестное состояние');
    person.state = state;
    ctx.emit('people-changed');
    return { success: true, state };
  });
  // Четыре права разом и только да или нет: забытое поле не должно молча закрыть или открыть право
  r.mut('PUT', '/api/users/:id/rights', async (ctx) => {
    const person = await personOf(ctx);
    const body = bodyOf(ctx);
    if (!RIGHTS.every((k) => typeof body[k] === 'boolean')) throw fail(400, 'Непонятные права', 'bad-rights');
    person.rights = Object.fromEntries(RIGHTS.map((k) => [k, body[k]]));
    ctx.emit('people-changed');
    return { success: true, rights: person.rights };
  });
  r.off('POST', '/api/users/:id/password', 'secrets');
  r.off('PUT', '/api/users/:id/avatar', 'files');
  r.off('DELETE', '/api/users/:id/avatar', 'files');

  // Какие игры видит человек. В записи есть только гостья; у вновь добавленного — «все игры»
  r.calc('GET', '/api/users/:id/games', async (ctx) => {
    await personOf(ctx);
    return (await ctx.store.read(ctx.key)) ?? { limited: false, games: [] };
  });
  r.mut('PUT', '/api/users/:id/games', async (ctx) => {
    await personOf(ctx);
    const { limited, games } = bodyOf(ctx);
    if (typeof limited !== 'boolean' || !Array.isArray(games) || !games.every((id) => typeof id === 'string')) throw fail(400, 'Непонятный список игр', 'bad-games');
    const ids = [...new Set(games)];
    const known = new Set((await gamesOf(ctx)).map((g) => g.id));
    if (ids.some((id) => !known.has(id))) throw fail(400, 'В списке есть игра, которой нет в библиотеке', 'unknown-game');
    ctx.store.write(ctx.key, { limited, games: ids });
    return { success: true, limited, games: ids.length };
  });

  // Telegram: статус «не связан» записан, связать нечем — бот работает на сервере владельца
  r.rec('GET', '/api/telegram');
  for (const step of ['link', 'prefs', 'test', 'backup']) r.off('POST', `/api/telegram/${step}`, 'telegram');
  r.off('DELETE', '/api/telegram/link', 'telegram');
}
