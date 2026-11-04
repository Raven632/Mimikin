const bcrypt = require('bcrypt');

// Правила пароля — в одном месте: их зовут и маршруты входа (routes/auth.js), и сброс пароля из
// консоли (scripts/reset-password.js), у которого нет ни сервера, ни сервиса базы, а только своё подключение к файлу
const MIN_PASSWORD = 4;
const passwordFits = (password) => typeof password === 'string' && password.length >= MIN_PASSWORD;

// Имя человека — и его логин, и подпись везде. Приводим к одной форме: «й» одним знаком и «и» с бревом — одно и то же имя
// (NFC), края без пробелов. Каждый, кто принимает имя (создание, смена, копия, страница входа), зовёт именно это
const NAME_MAX = 40;
const cleanName = (raw) => (typeof raw === 'string' ? raw.normalize('NFC').trim() : '');
// Без управляющих знаков и невидимых форматирующих (\p{Cf}: нулевой ширины, смена направления письма): два разных на вид
// имени не должны совпадать глазами, а подпись — перекручивать соседний текст. Имя выбирают сами, так что это уже не теория
const nameFits = (name) => name.length > 0 && name.length <= NAME_MAX && !/[\u0000-\u001f\u007f\p{Cf}]/u.test(name);
// Сравнение имён без учёта регистра. SQLite NOCASE сворачивает только ASCII («Анна» и «анна» для него разные), поэтому
// сравниваем в JS. Колонка NOCASE остаётся запасным замком для латиницы
const foldName = (name) => String(name).normalize('NFC').toLowerCase();

async function writePassword(db, password) {
    await db.run("UPDATE settings SET value = ? WHERE key = 'admin_pass'", [await bcrypt.hash(password, 10)]);
}

// Забытый пароль: старый спросить не у кого, поэтому вход — сама консоль сервера. name пусто — владелец, иначе человек из
// users (по тем же правилам, что вход; логин владельца тоже годится). Все входы человека стираются, accounts_epoch растёт:
// запущенный сервер заметит это сам и отключит их сокеты (db/database.js, followAccount). Владельцу заодно закрывается
// окно старой куки, иначе она вернула бы вход. Другому человеку пароль ставится временный — при входе он выберет свой.
// Одной транзакцией: пароль новый, а потерянное устройство осталось во входе — хуже, чем не сменилось ничего.
// Ответ: имя входа (его забывают вместе с паролем) и имена остальных — чтобы выбрать, кому сбрасывать
async function resetPassword(db, password, name = '') {
    if (!passwordFits(password)) throw Object.assign(new Error(`The password must be at least ${MIN_PASSWORD} characters long.`), { told: true });
    await db.exec('BEGIN IMMEDIATE');
    try {
        const { owner, person } = await accountNamed(db, name);
        let login;
        if (person) {
            await db.run('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?', [await bcrypt.hash(password, 10), person.id]);
            await db.run('DELETE FROM sessions WHERE user_id = ?', [person.id]);
            login = person.name;
        } else {
            await writePassword(db, password);
            await db.run("DELETE FROM sessions WHERE user_id = 'owner'");
            await db.run("INSERT INTO settings (key, value) VALUES ('legacy_session_until', '0') ON CONFLICT(key) DO UPDATE SET value = '0'");
            login = owner;
        }
        await db.run("INSERT INTO settings (key, value) VALUES ('accounts_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(Date.now())]);
        // Удалённых в списке нет: выбирать из них нечего. Закрытых показываем отдельно — сброс пароля вход не открывает
        const left = await db.all("SELECT name, state FROM users WHERE state != 'removed' ORDER BY name");
        await db.exec('COMMIT');
        return { login, others: left.map((r) => r.name).filter((n) => n !== login), locked: left.filter((r) => r.state === 'locked').map((r) => r.name) };
    } catch (e) {
        await db.exec('ROLLBACK').catch(() => {});
        throw e;
    }
}

// Кого найти по набранному имени (вход и сброс пароля). Сначала точное совпадение: у кого уже есть два имени, отличающихся
// только регистром («Анна» и «анна»), каждый входит под своим. Потом без учёта регистра, но только если подходит один:
// «АННА» из этих двоих не выбрать. Ответ — { owner: true, name } для владельца, { person: строка users } для человека или null.
// Удалённые тоже находятся: имя за ними занято, а вход скажет, что он закрыт
async function findAccount(db, typed) {
    if (typeof typed !== 'string') return null;
    const owner = (await db.get("SELECT value FROM settings WHERE key = 'admin_user'"))?.value;
    const all = (await db.all('SELECT id, name, pass_hash AS hash, must_change AS mustChange, state FROM users'))
        .map((person) => ({ person, name: person.name }));
    if (owner) all.unshift({ owner: true, name: owner });
    const text = typed.normalize('NFC');
    const trimmed = text.trim();
    const exact = all.find((a) => a.name === typed) || all.find((a) => a.name === trimmed);
    const found = exact || (() => {
        const same = all.filter((a) => foldName(a.name) === foldName(trimmed));
        return same.length === 1 ? same[0] : null;
    })();
    if (!found) return null;
    return found.owner ? { owner: true, name: found.name } : { person: found.person };
}

// Занято ли имя (для создания, смены и копии). exceptId — кто сам его и носит: 'owner' или id человека. Ответ — null или
// { by: 'owner' | 'person', id, state }: удалённый человек держит имя тоже, и тогда отвечаем «верните его»
async function nameTaken(db, name, exceptId = null) {
    const key = foldName(name);
    if (exceptId !== 'owner') {
        const owner = (await db.get("SELECT value FROM settings WHERE key = 'admin_user'"))?.value;
        if (owner && foldName(owner) === key) return { by: 'owner', id: 'owner', state: '' };
    }
    for (const row of await db.all('SELECT id, name, state FROM users')) {
        if (row.id !== exceptId && foldName(row.name) === key) return { by: 'person', id: row.id, state: row.state || '' };
    }
    return null;
}

// Проверка «имя свободно» и запись — не одно действие: между ними есть await, и два запроса разом («Анна» и «анна») оба
// прошли бы проверку, а замок колонки (NOCASE) кириллицу не ловит. Поэтому всё, что занимает имя, идёт по очереди.
// Одна очередь на процесс — база одна. Упавший шаг очередь не ломает
let namesQueue = Promise.resolve();
function exclusiveNames(fn) {
    const run = namesQueue.then(fn);
    namesQueue = run.catch(() => {});
    return run;
}

// Кого сбрасывают: пустое имя — владельца ({ person: null }), иначе та же сверка, что при входе (логин владельца тоже
// годится). Неизвестное и удалённое имя — отказ. Скрипт спрашивает это до пароля: пароль, набранный в аргументах по привычке,
// не должен дойти до записи
async function accountNamed(db, name = '') {
    const owner = await db.get("SELECT value FROM settings WHERE key = 'admin_user'");
    if (!owner) throw Object.assign(new Error('There is no account yet: open the library in a browser and create one.'), { told: true });
    if (!name) return { owner: owner.value, person: null };
    const found = await findAccount(db, name);
    if (found?.owner) return { owner: owner.value, person: null };
    if (!found || found.person.state === 'removed') throw noSuchAccount();
    return { owner: owner.value, person: { id: found.person.id, name: found.person.name, state: found.person.state } };
}

// Одна и та же фраза для любого неизвестного имени: по ответу скрипта не угадать, какие имена есть
const noSuchAccount = () => Object.assign(new Error('There is no such account. Run the script without a name to reset the main administrator.'), { told: true });

module.exports = { MIN_PASSWORD, NAME_MAX, passwordFits, cleanName, nameFits, foldName, findAccount, nameTaken, exclusiveNames, writePassword, resetPassword, accountNamed };
