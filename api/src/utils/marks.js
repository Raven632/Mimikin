const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Моменты и снимки игры (rpg-fixes, setupSceneMarks): что запомнили в игре — с сейвом целиком, как у слота, но не в
// списке слотов игры. Вернуться к ним можно из игры и из окна игры в библиотеке (вкладка «Скриншоты»). Вида три:
//   mark — момент: «Запомнить момент» или снимок (F8) на карте — сейв, кадр целиком и маленький;
//   shot — снимок там, где сейва не сделать (бой, меню): только кадр;
//   auto — точка перемотки: игра ставит её сама (перед сценой, перед выбором, перед боем, на новой карте, раз в 10
//          минут игры), «до перемотки» и «где вышли» — сейв и маленький кадр. Хранятся по времени (thin): последние
//          полчаса — все, дальше реже, в каждом окне — самая важная; у каждого прохождения отдельно. Две точки за
//          3 секунды — одна (вход на карту, сразу сцена, сразу выбор). «Оставить» делает точку моментом.
// Прохождение и путь: в сейве точки — её id и прохождение (rpg-fixes: $gameSystem._rpgLast, _rpgLine); описание помнит
// прохождение (line) и предка (parent). _tree.json — предки всех точек, и стёртых: по ним лента находит путь к нынешнему
// состоянию (trail), даже если середину проредили, — и не путает его с веткой, от которой перемотали
// Лежат рядом с сейвами и вместе с ними попадают в резервные копии:
//   _saves/.marks/<игра>/<id>.json — вид, подпись, карта, время;
//   <id>.save.gz — сам сейв, сжатый (строка, как её пишет движок: JsonEx); у моментов до сжатия — <id>.save;
//   <id>.jpg — кадр для списков; <id>.full.jpg — кадр целиком.
// Удалённый момент или снимок не стирается сразу: уходит в .deleted/ своей игры и лежит там 30 дней
const MAX_MARKS = 200;
// Кого оставить в окне прореживания: сцену — раньше выбора, выбор — раньше боя и т. д.
const PRIORITY = { scene: 5, choice: 4, battle: 3, map: 2, timer: 1 };
// Окна: моложе 30 минут — все; до 3 часов — одна на 5 минут; до суток — на полчаса; старше — на 3 часа
const THIN = [[30 * 60e3, 0], [3 * 3600e3, 5 * 60e3], [24 * 3600e3, 30 * 60e3], [Infinity, 3 * 3600e3]];
const MAX_AUTO = 150;
// «До перемотки» и «Где вышли» — не история, а страховка: последние несколько
const SMALL_KEEP = { back: 5, exit: 3 };
const MERGE_MS = 3000;
const MAX_VALUE = 45 * 1024 * 1024;
const MAX_THUMB = 400 * 1024;
const MAX_SHOT = 8 * 1024 * 1024;
const KINDS = ['mark', 'shot', 'auto'];
// back — «До перемотки»: где был перед тем, как перемотать (передумал — вернуться); exit — где вышли из игры
const WHY = [...Object.keys(PRIORITY), ...Object.keys(SMALL_KEEP)];
const FILES = ['json', 'save', 'save.gz', 'jpg', 'full.jpg'];
const KEEP_DELETED_MS = 30 * 24 * 3600 * 1000;
const ID = /^[0-9a-z]{6,32}$/;
const LABEL_MAX = 120;

// Подпись — одна строка без управляющих знаков
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// data:image/jpeg;base64,… → Buffer, если это JPEG не больше max; иначе null — без картинки: момент важнее неё
function jpegOf(data, max) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!m) return null;
    const jpg = Buffer.from(m[1], 'base64');
    return jpg.length <= max && jpg[0] === 0xff && jpg[1] === 0xd8 ? jpg : null;
}

async function writeAtomic(file, data) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
}

// now — часы (в тестах свои)
function createMarkStore(savesDir, { now: clock = () => Date.now() } = {}) {
    // Игра — имя папки, без путей и без точки в начале (там служебное: .deleted)
    const validGame = (game) => { const g = String(game || ''); return !!g && g === path.basename(g) && !g.startsWith('.'); };
    const dirOf = (game) => path.join(savesDir, '.marks', String(game));
    const fileOf = (game, id, ext) => path.join(dirOf(game), `${id}.${ext}`);
    const validId = (id) => ID.test(String(id || ''));
    const valid = (game, id) => validGame(game) && validId(id);
    const treeFile = (game) => path.join(dirOf(game), '_tree.json');
    // Запись точки, прореживание и предки — по очереди в пределах игры: две точки разом не потеряют друг друга в _tree
    const queues = new Map();
    const queued = (game, fn) => {
        const run = (queues.get(game) || Promise.resolve()).then(fn, fn);
        queues.set(game, run.catch(() => {}));
        return run;
    };
    // Нет файла — путей ещё нет. Битый — в сторону (_tree.broken-<время>.json) и с чистого: точки целы, путь начнётся
    // заново. Не прочитался (права, диск) — ошибка: иначе следующая запись затёрла бы всех предков одной строкой
    // repair — только в очереди (запись точки): чтение пути битый файл не трогает, иначе отложило бы и свежий, только
    // что записанный очередью
    const readTree = async (game, { repair = false } = {}) => {
        let text;
        try { text = await fsp.readFile(treeFile(game), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
        try {
            const tree = JSON.parse(text);
            if (tree && typeof tree === 'object' && !Array.isArray(tree)) return tree;
        } catch { /* ниже */ }
        if (repair) await fsp.rename(treeFile(game), path.join(dirOf(game), `_tree.broken-${Date.now()}.json`)).catch(() => {});
        return {};
    };
    // shortcut: _tree растёт на ~40 байт за точку и не чистится — сотни часов игры дают сотни КБ; чистить, если вырастет
    const linkTree = async (game, id, parent) => {
        const tree = await readTree(game, { repair: true });
        tree[id] = parent;
        await writeAtomic(treeFile(game), JSON.stringify(tree));
    };

    async function readMeta(game, id) {
        try {
            const meta = JSON.parse(await fsp.readFile(fileOf(game, id, 'json'), 'utf8'));
            return meta && typeof meta === 'object' ? { ...meta, id } : null;
        } catch {
            return null;
        }
    }

    // Новые — первыми
    async function list(game) {
        if (!validGame(game)) return [];
        const names = await fsp.readdir(dirOf(game)).catch(() => []);
        const out = [];
        for (const name of names) {
            const id = name.endsWith('.json') ? name.slice(0, -5) : '';
            if (!validId(id)) continue;
            const meta = await readMeta(game, id);
            if (!meta) continue;
            // Записанные до снимков и перемотки — моменты с сейвом
            const kind = KINDS.includes(meta.kind) ? meta.kind : 'mark';
            out.push({
                id, kind, why: meta.why || '', label: meta.label || '', map: meta.map || '', at: Number(meta.at) || 0,
                thumb: !!meta.thumb, full: !!meta.full, save: meta.save !== false, playtime: Number(meta.playtime) || 0,
                line: meta.line || '', ...(meta.also?.length ? { also: meta.also } : {}),
                ...(meta.answer ? { answer: meta.answer } : {}), ...(meta.cancel ? { cancel: true } : {}),
            });
        }
        return out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    }

    async function value(game, id) {
        if (!valid(game, id)) return null;
        const packed = await fsp.readFile(fileOf(game, id, 'save.gz')).catch(() => null);
        if (packed) return (await gunzip(packed)).toString('utf8');
        return fsp.readFile(fileOf(game, id, 'save'), 'utf8').catch(() => null);
    }

    async function picture(game, id, ext) {
        if (!valid(game, id)) return null;
        const file = fileOf(game, id, ext);
        return fsp.access(file).then(() => file, () => null);
    }
    const thumb = (game, id) => picture(game, id, 'jpg');
    // Кадр целиком; у моментов до снимков его нет — маленький
    const shotFile = async (game, id) => (await picture(game, id, 'full.jpg')) || thumb(game, id);

    // Свои (моменты и снимки) — до MAX_MARKS; перемотка в этот счёт не входит
    const ownCount = async (game) => (await list(game)).filter((m) => m.kind !== 'auto').length;

    // Прореживание точек: стираем сразу — их ставила сама игра, это не то, что человек сохранил. В _tree они остаются
    // предками: путь к нынешнему состоянию через них не рвётся
    async function thin(game) {
        const autos = (await list(game)).filter((m) => m.kind === 'auto');
        const doomed = [];
        for (const [why, keep] of Object.entries(SMALL_KEEP)) doomed.push(...autos.filter((m) => m.why === why).slice(keep));
        const lines = new Map();
        for (const m of autos.filter((x) => !SMALL_KEEP[x.why])) lines.set(m.line, [...(lines.get(m.line) || []), m]);
        const t = clock();
        const kept = [];
        for (const points of lines.values()) {
            const best = new Map();
            // Новые — первыми: при равной важности в окне остаётся самая свежая
            for (const m of points) {
                const step = THIN.find(([upTo]) => t - m.at < upTo)[1];
                if (!step) { kept.push(m); continue; }
                const key = `${step}:${Math.floor(m.at / step)}`;
                const have = best.get(key);
                if (have && (PRIORITY[m.why] || 0) <= (PRIORITY[have.why] || 0)) { doomed.push(m); continue; }
                if (have) doomed.push(have);
                best.set(key, m);
            }
            kept.push(...best.values());
        }
        doomed.push(...kept.sort((a, b) => b.at - a.at).slice(MAX_AUTO));
        for (const m of doomed) {
            // Пока решали, её сделали моментом («Оставить») — её больше не трогаем
            if ((await readMeta(game, m.id))?.kind !== 'auto') continue;
            for (const ext of FILES) await fsp.rm(fileOf(game, m.id, ext), { force: true });
        }
    }

    // Та же игра, то же прохождение, предыдущая точка истории моложе MERGE_MS — новая с ней одна: остаётся прежняя
    // (из неё сыграется и то, что было следом), подпись — у более важной, причины — обе
    async function merge(game, line, why, label) {
        if (!line || !PRIORITY[why]) return null;
        const prev = (await list(game)).find((m) => m.kind === 'auto' && PRIORITY[m.why] && m.line === line);
        if (!prev || clock() - prev.at >= MERGE_MS) return null;
        const meta = await readMeta(game, prev.id);
        if (!meta) return null;
        const { id: _, ...rest } = meta;
        const also = [...new Set([...(rest.also || []), rest.why, why].filter(Boolean))];
        const upgrade = (PRIORITY[why] || 0) > (PRIORITY[rest.why] || 0);
        await writeAtomic(fileOf(game, prev.id, 'json'), JSON.stringify({ ...rest, also, ...(upgrade ? { why, label: clean(label, LABEL_MAX) || rest.label } : {}) }));
        return prev.id;
    }

    // value — строка сейва (у снимка без сейва — нет); thumb — кадр для списков, shot — целиком (data:image/jpeg;base64,…,
    // необязательно); kind, why — что это и почему (см. выше); playtime — время игры, с. id — какой дала игра (он уже в
    // сейве: следующие точки пойдут от него), parent — предок, line — прохождение. Ответ — { id }, { id, merged } (точка
    // слита с предыдущей — её id) или { error }
    function create(game, body = {}) {
        return validGame(game) ? queued(game, () => createNow(game, body)) : Promise.resolve({ error: 'bad-value' });
    }
    async function createNow(game, { label, map, value: data, thumb: small, shot: big, kind = 'mark', why = '', playtime = 0, id: wanted, parent, line } = {}) {
        if (!KINDS.includes(kind)) return { error: 'bad-value' };
        const saved = typeof data === 'string' && data.length > 0;
        if ((kind !== 'shot' && !saved) || (saved && data.length > MAX_VALUE)) return { error: 'bad-value' };
        const jpg = jpegOf(small, MAX_THUMB);
        const full = kind === 'auto' ? null : jpegOf(big, MAX_SHOT);
        if (kind === 'shot' && !full && !jpg) return { error: 'bad-value' };
        if (kind !== 'auto' && (await ownCount(game)) >= MAX_MARKS) return { error: 'too-many' };
        const now = clock();
        const taken = validId(wanted) && (await fsp.access(fileOf(game, wanted, 'json')).then(() => true, () => false));
        const id = validId(wanted) && !taken ? String(wanted) : `${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`;
        const from = validId(parent) && parent !== id ? String(parent) : '';
        const run = validId(line) ? String(line) : '';
        await fsp.mkdir(dirOf(game), { recursive: true });
        // Предки не читаются (права, диск) — ошибка до записи файлов, а не точка без пути и без прореживания
        if (saved) await readTree(game, { repair: true });
        if (kind === 'auto') {
            const into = await merge(game, run, why, label);
            if (into) {
                await linkTree(game, id, into);
                return { id: into, merged: true };
            }
        }
        if (saved) await writeAtomic(fileOf(game, id, 'save.gz'), await gzip(Buffer.from(data, 'utf8')));
        if (jpg) await writeAtomic(fileOf(game, id, 'jpg'), jpg);
        if (full) await writeAtomic(fileOf(game, id, 'full.jpg'), full);
        // Описание — последним: по нему момент виден в списке, а без сейва и кадров его не должно быть
        await writeAtomic(fileOf(game, id, 'json'), JSON.stringify({
            kind, why: WHY.includes(why) ? why : '', label: clean(label, LABEL_MAX), map: clean(map, 80), at: now,
            thumb: !!jpg, full: !!full, save: saved, playtime: Math.max(0, Math.floor(Number(playtime) || 0)), line: run, parent: from,
        }));
        if (saved) await linkTree(game, id, from);
        if (kind === 'auto') await thin(game);
        return { id };
    }

    // Путь к нынешнему состоянию: from — последняя точка его истории (из сейва игры); живые точки этого пути, от новой
    // к старой. Ветки, от которых перемотали, сюда не попадают: их точки — не предки
    async function trail(game, from) {
        if (!valid(game, from)) return [];
        const tree = await readTree(game);
        const alive = new Set((await list(game)).filter((m) => m.save).map((m) => m.id));
        const out = [];
        const seen = new Set();
        for (let cur = String(from); cur && !seen.has(cur) && seen.size < 10000; cur = tree[cur]) {
            seen.add(cur);
            if (alive.has(cur)) out.push(cur);
        }
        return out;
    }

    // Что ответили на выбор после точки «перед выбором» — плёнка покажет его у точки
    // cancel — отказались выбирать (слово — на языке, на котором покажут)
    // Правки описания — в той же очереди, что запись и прореживание: «Оставить» посреди прореживания не потеряет точку,
    // ответ на выбор и слияние не затрут друг друга
    const inQueue = (fn, bad) => (game, ...args) => (validGame(game) ? queued(game, () => fn(game, ...args)) : Promise.resolve(bad));
    async function setAnswerNow(game, id, answer, cancel = false) {
        if (!valid(game, id)) return false;
        const meta = await readMeta(game, id);
        if (!meta || (meta.why !== 'choice' && !(meta.also || []).includes('choice'))) return false;
        const { id: _, answer: __, cancel: ___, ...rest } = meta;
        await writeAtomic(fileOf(game, id, 'json'), JSON.stringify({ ...rest, ...(cancel ? { cancel: true } : { answer: clean(answer, 80) }) }));
        // Пока писали, новая точка вытеснила эту (trimAuto стёр сейв) — описание без сейва не оставляем
        if (!(await value(game, id).catch(() => null))) {
            await fsp.rm(fileOf(game, id, 'json'), { force: true });
            return false;
        }
        return true;
    }

    // «Оставить» точку перемотки — станет моментом и не сменится новой
    async function keepNow(game, id) {
        if (!valid(game, id)) return { error: 'bad-mark' };
        const meta = await readMeta(game, id);
        if (!meta) return { error: 'not-found' };
        if (meta.kind !== 'auto') return { id };
        if ((await ownCount(game)) >= MAX_MARKS) return { error: 'too-many' };
        const { id: _, ...rest } = meta;
        await writeAtomic(fileOf(game, id, 'json'), JSON.stringify({ ...rest, kind: 'mark' }));
        // Пока писали, новая точка вытеснила эту (trimAuto стёр сейв) — описание без сейва не оставляем
        if (!(await value(game, id).catch(() => null))) {
            await fsp.rm(fileOf(game, id, 'json'), { force: true });
            return { error: 'not-found' };
        }
        return { id };
    }

    async function renameNow(game, id, label) {
        if (!valid(game, id)) return false;
        const meta = await readMeta(game, id);
        if (!meta) return false;
        const { id: _, ...rest } = meta;
        await writeAtomic(fileOf(game, id, 'json'), JSON.stringify({ ...rest, label: clean(label, LABEL_MAX) }));
        return true;
    }

    // В .deleted/ на 30 дней; старше — стираем при следующем удалении
    async function removeNow(game, id) {
        if (!valid(game, id) || !(await readMeta(game, id))) return false;
        const trash = path.join(dirOf(game), '.deleted');
        await fsp.mkdir(trash, { recursive: true });
        const now = Date.now();
        for (const ext of FILES) {
            await fsp.rename(fileOf(game, id, ext), path.join(trash, `${id}.${ext}`)).catch(() => {});
        }
        // Время удаления — время файла описания в .deleted
        const when = new Date(now);
        await fsp.utimes(path.join(trash, `${id}.json`), when, when).catch(() => {});
        for (const name of await fsp.readdir(trash).catch(() => [])) {
            if (!name.endsWith('.json')) continue;
            const st = await fsp.stat(path.join(trash, name)).catch(() => null);
            if (!st || now - st.mtimeMs < KEEP_DELETED_MS) continue;
            const old = name.slice(0, -5);
            for (const ext of FILES) await fsp.rm(path.join(trash, `${old}.${ext}`), { force: true });
        }
        return true;
    }

    const keep = inQueue(keepNow, { error: 'bad-mark' });
    const setAnswer = inQueue(setAnswerNow, false);
    const rename = inQueue(renameNow, false);
    const remove = inQueue(removeNow, false);
    return { list, value, thumb, shot: shotFile, create, keep, setAnswer, rename, remove, trail, validId };
}

module.exports = { createMarkStore, MAX_MARKS, MAX_AUTO, SMALL_KEEP };
