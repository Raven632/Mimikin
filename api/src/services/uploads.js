// Загрузка архивов игр — кусками, с продолжением после обрыва.
//
// TCP доставляет данные, пока живо соединение; оборвалось — всё, что шло по нему, пропало. А рвётся
// оно у телефона часто: гаснет экран, приложение уходит в фон, моргает Wi-Fi, сервер
// перезапускается на деплое. Медианная игра — 1.1 ГБ, по мобильной сети это минуты. Поэтому архив
// собирается из кусков, и сервер помнит, сколько уже получил: выбрали тот же файл снова (хоть после
// перезапуска страницы или сервера, хоть на другом устройстве) — загрузка продолжится с того места,
// где оборвалась.
//
// На диске, во временной папке, у загрузки два файла:
//   <id>.archive — собираемый архив; байты пишутся строго подряд, поэтому годится всё, что в нём
//                  лежит, и «сколько получено» — это его размер;
//   <id>.json    — состояние: uploading → processing → done | error, имя, размер, папка игры;
//                  архив под паролем ждёт его в состоянии password и после пароля снова processing.
// id — от имени, размера и «отпечатка» файла (хэш его начала и конца): тот же файл — та же загрузка.
// Распаковка идёт в фоне: последний кусок отвечает сразу, итог узнают запросом состояния — телефон
// за это время мог и уснуть. Игры в распакованном нет — ищем её во вложенных архивах (rar с zip
// внутри, многотомный архив в архиве). Брошенные загрузки убирает уборка временной папки
// (server.js): сутки без новых байтов их ещё можно продолжить

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const util = require('util');

const execFileP = util.promisify(require('child_process').execFile);
const { SYSTEM_DIRS } = require('../config/index.js');
const { isSafeSegment } = require('../utils/validate.js');
const { VOLUME, setOf } = require('./inbox.js');
const { otherEngine } = require('../utils/archive.js');

const MAX_SIZE = 200 * 1024 ** 3;              // больше 200 ГБ игр не бывает — это ошибка
const SPACE_MARGIN = 1024 ** 3;                // гигабайт про запас: диск не забиваем досуха
const ARCHIVE = /\.(zip|7z|rar)$/i;
const NESTED_DEPTH = 3;                        // архив в архиве — не глубже трёх уровней
const RESERVED = [...SYSTEM_DIRS, 'api', 'socket.io', 'public'];

// Ошибка с HTTP-кодом и подсказкой клиенту: received — «присылай с этого места», busy — «файл
// сейчас пишет другой запрос», state — «файл уже получен целиком»
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const mb = (bytes) => (bytes / 1048576).toFixed(1);
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;

// Разбор «7zz l -slt -ba»: блоки через пустую строку, в них «Path = …», «Size = …», «Encrypted = +»
function parseListing(text) {
    return String(text).split(/\n\s*\n/).map((block) => {
        const field = (name) => (block.match(new RegExp(`^${name} = (.*)$`, 'm')) || [])[1] || '';
        return { path: field('Path'), size: Number(field('Size')) || 0, encrypted: field('Encrypted') === '+' };
    }).filter((e) => e.path);
}

// Путь наружу: «../», абсолютный, «C:\». Ссылки наружу 7-Zip (с версии 22) сам не распаковывает,
// а ссылки внутри архива бывают у честных сборок для Mac — их не трогаем
function unsafePath(p) {
    p = p.replace(/\\/g, '/');
    return p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..');
}

// Вложенный архив, который стоит распаковать: обычный или первый том многотомного («.part1.rar»,
// «.7z.001»). Остальные тома 7-Zip найдёт сам рядом с первым
function isInnerArchive(name) {
    if (/\.part\d+\.rar$/i.test(name)) return /\.part0*1\.rar$/i.test(name);
    if (/\.(zip|7z|rar)\.\d+$/i.test(name)) return /\.0*1$/.test(name);
    return ARCHIVE.test(name);
}

// Вложенные архивы в распакованном, самые большие — первыми: игра обычно самое большое, что там
// есть. По ссылкам не ходим — только настоящие файлы и папки
async function innerArchives(dir) {
    const found = [];
    const walk = async (at, depth) => {
        let items = [];
        try { items = await fsp.readdir(at, { withFileTypes: true }); } catch (e) { return; }
        for (const item of items) {
            const full = path.join(at, item.name);
            if (item.isDirectory() && depth < 8) await walk(full, depth + 1);
            else if (item.isFile() && isInnerArchive(item.name)) found.push({ file: full, size: (await fsp.stat(full)).size });
        }
    };
    await walk(dir, 0);
    return found.sort((a, b) => b.size - a.size).map((x) => x.file);
}

// Отказ 7-Zip из-за пароля: его нет или он не тот. У zip и 7z — «Wrong password», у архива, где
// зашифрован и список файлов, — «Cannot open encrypted archive»
const PASSWORD_ERROR = /wrong password|encrypted archive/i;

// Частые отказы 7-Zip — понятными словами, прочее — как сказал он сам
function explain7z(text, code) {
    if (PASSWORD_ERROR.test(text)) return 'Архив под паролем';
    if (/missing volume/i.test(text)) return 'Архив из нескольких частей — упакуйте игру в один архив';
    if (/dangerous link/i.test(text)) return 'В архиве ссылка на файлы вне игры — такой архив не распаковываем';
    if (/no space left/i.test(text)) return 'Кончилось место на диске при распаковке';
    if (/is not archive|cannot open the file as/i.test(text)) return 'Файл не открывается как архив: он повреждён или это не архив';
    if (/crc failed|data error|unexpected end|headers error/i.test(text)) return 'Архив повреждён: 7-Zip нашёл ошибки в данных. Проверьте его у себя и загрузите снова';
    const line = text.split('\n').map((s) => s.trim()).find((s) => /error/i.test(s));
    return `7-Zip не справился: ${(line || `код ${code}`).slice(0, 200)}`;
}

// 7-Zip без вопросов: пароль — тот, что дал человек, а без него заведомо неверный: иначе на архиве
// с паролем 7-Zip ждал бы ввода вечно. Аргументом, без оболочки — любые знаки пароля безопасны.
// Отказ из-за пароля помечен password: его не удаляют, а спрашивают пароль
function run7z(args, { output = false, password = '' } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn('7zz', [...args, `-p${password || '_'}`], { stdio: ['ignore', output ? 'pipe' : 'ignore', 'pipe'] });
        const out = [];
        let stderr = '';
        proc.stdout?.on('data', (d) => out.push(d));
        proc.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d; });
        proc.on('error', (e) => reject(new Error(`7-Zip не запустился: ${e.message}`)));
        proc.on('close', (code) => {
            const stdout = Buffer.concat(out).toString('utf8');
            const text = `${stderr}\n${stdout}`;
            if (code === 0) resolve(stdout);
            else reject(Object.assign(new Error(explain7z(text, code)), { password: PASSWORD_ERROR.test(text) }));
        });
    });
}

// Настоящие инструменты — 7-Zip и диск; в тестах их подменяют
const defaultTools = {
    list: async (archive, password) => parseListing(await run7z(['l', '-slt', '-ba', archive], { output: true, password })),
    // Подходит ли пароль: проверка одного файла (only) — у zip и rar без шифрования списка иначе не узнать.
    // Имя — внутри ключа -i!: имя на «-» не примут за ключ
    test: (archive, password, only) => run7z(['t', archive, ...(only ? [`-i!${only}`] : []), '-bso0', '-bsp0'], { password }),
    extract: (archive, dir, password) => run7z(['x', archive, `-o${dir}`, '-y', '-bso0', '-bsp0'], { password }),
    freeSpace: async (dir) => {
        const st = await fsp.statfs(dir);
        return st.bavail * st.bsize;
    },
};

// --- Патчи и моды поверх игры ---
// Английский патч, мод с прохождением или читами — архив с частью файлов игры. Куда их класть,
// узнаём по совпадениям: пробуем отрезать от путей в архиве 0–3 первых папки и приложить их к корню
// игры или к её www; где совпало больше файлов, там и правильное место. Совпадения ищем без учёта
// регистра — браузеру игры он тоже не важен (server.js), — а пишем в тот путь, что уже есть в игре
const RM_DIRS = new Set(['data', 'js', 'img', 'audio', 'fonts', 'movies', 'icon', 'css', 'effects']);
const DOC_FILE = /\.(txt|md|url|pdf|nfo|rtf|docx?|html?)$/i;
const PATCHER_FILE = /\.(exe|bat|cmd|xdelta|vcdiff|bps|ips|ppf)$/i;

async function listFiles(dir, rel = '') {
    const out = [];
    for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...await listFiles(dir, r));
        else if (e.isFile()) out.push(r);
    }
    return out;
}

function planPatch(patchFiles, gameFiles) {
    const index = new Map(gameFiles.map((f) => [f.toLowerCase(), f]));
    const bases = [''];
    if (gameFiles.some((f) => f.toLowerCase().startsWith('www/'))) bases.push('www/');
    const strip = (f, k) => f.split('/').slice(k).join('/');
    let best = null;
    for (let k = 0; k <= 3; k++) {
        const files = patchFiles.filter((f) => f.split('/').length > k);
        if (!files.length) break;
        for (const base of bases) {
            const score = files.filter((f) => index.has((base + strip(f, k)).toLowerCase())).length;
            if (score && (!best || score > best.score)) best = { k, base, score };
        }
    }
    // Ничего не совпало — мод только добавляет файлы: кладём туда, где папки движка (js, data, img…)
    if (!best) {
        const content = bases.includes('www/') ? 'www/' : '';
        for (let k = 0; k <= 3 && !best; k++) {
            if (patchFiles.some((f) => f.split('/').length > k + 1 && RM_DIRS.has(f.split('/')[k].toLowerCase()))) best = { k, base: content, score: 0 };
        }
    }
    if (!best) {
        const patcher = patchFiles.find((f) => PATCHER_FILE.test(f));
        throw new Error(patcher
            ? `В архиве не файлы игры, а программа-патчер («${path.basename(patcher)}»): её запускают на компьютере с Windows`
            : 'Не понял, куда класть патч: в архиве нет ни файлов этой игры, ни папок движка (data, js, img, audio)');
    }
    const plan = [];
    let skipped = 0;
    for (const f of patchFiles) {
        if (f.split('/').length <= best.k) { skipped++; continue; }
        const rel = best.base + strip(f, best.k);
        const existing = index.get(rel.toLowerCase());
        // Readme и прочие тексты у корня патча, которых в игре нет, игре не нужны
        if (!existing && !rel.slice(best.base.length).includes('/') && DOC_FILE.test(rel) && !/^index\.html$/i.test(path.basename(rel))) { skipped++; continue; }
        plan.push({ from: f, to: existing || rel, replace: !!existing });
    }
    return { plan, skipped, replaced: plan.filter((x) => x.replace).length, added: plan.filter((x) => !x.replace).length };
}

class UploadService {
    constructor() {
        this.dir = '';
        this.gamesDir = '';
        this.oldDir = '';
        this.addGameToDB = async () => {};
        this.refreshGame = async () => ({});
        this.findGameFolder = async () => null;
        this.afterAdd = () => {};
        this.tools = defaultTools;
        // Кусок молчит дольше takeoverMs, а тот же файл уже шлют снова — старое соединение мёртвое
        // (телефон ушёл из сети, а сервер об этом не узнал): его место занимает новый запрос.
        // Молчит дольше stallMs и на смену никто не пришёл — закрываем сами
        this.takeoverMs = 15 * 1000;
        this.stallMs = 90 * 1000;
        this.writing = new Map();      // загрузки, в которые сейчас пишется кусок
        this.jobs = new Map();         // загрузки, которые сейчас распаковываются или ждут своей очереди
        // Распаковка — строго по одной: две разом вместе проверили бы свободное место и вместе его
        // переполнили, а новая версия и патч к одной игре меняли бы её папку одновременно. turn —
        // конец очереди, active — чья распаковка идёт сейчас (остальные в jobs ждут, шаг 'queued')
        this.turn = Promise.resolve();
        this.active = null;
        this.waiting = new Set();
        this.steps = new Map();        // что сейчас делает распаковка — для строки на карточке
        // Пароли архивов — только в памяти и только пока идёт распаковка: ни в файл состояния, ни
        // в журнал они не попадают. Перезапуск сервера посреди распаковки — пароль спросят снова
        this.passwords = new Map();
        // Архив томами из «Входящих»: номер → первый том в папке `${id}.parts` (тома лежат под своими именами — по ним
        // 7-Zip находит следующий). Восстанавливается из метки (readMeta, meta.parts)
        this.parts = new Map();
        // Когда страница в последний раз спрашивала о загрузке: закончилась, а спросить некому
        // (телефон уснул, вкладку закрыли) — сообщим в Telegram (onFinished, server.js)
        this.seen = new Map();
        this.finished = new Set();
        this.onFinished = null;
        this.unattendedMs = 60 * 1000;
    }

    setDependencies({ dir, gamesDir, oldDir, inboxDir, addGameToDB, refreshGame, findGameFolder, afterAdd, tools }) {
        Object.assign(this, { dir, gamesDir, addGameToDB, findGameFolder, inboxDir });
        this.oldDir = oldDir || path.join(gamesDir, '_old');
        if (refreshGame) this.refreshGame = refreshGame;
        if (afterAdd) this.afterAdd = afterAdd;
        if (tools) this.tools = { ...defaultTools, ...tools };
    }

    // Номер загрузки: тот же файл — та же загрузка. Новая версия для игры из библиотеки — своя:
    // тот же архив, загруженный как новая игра, её не продолжит
    static idFor(name, size, fingerprint, target = '', mode = '') {
        return crypto.createHash('sha256').update(`${name}\n${size}\n${fingerprint}${target ? `\n${target}` : ''}${mode ? `\n${mode}` : ''}`).digest('hex').slice(0, 32);
    }

    archivePath(id) { return this.parts.get(id) || path.join(this.dir, `${id}.archive`); }
    metaPath(id) { return path.join(this.dir, `${id}.json`); }
    partsDir(id) { return path.join(this.dir, `${id}.parts`); }
    // Что лежит на диске: файл архива или папка его томов
    stored(id) { return this.parts.has(id) ? this.partsDir(id) : this.archivePath(id); }

    async readMeta(id) {
        let meta = null;
        try { meta = JSON.parse(await fsp.readFile(this.metaPath(id), 'utf8')); } catch (e) { return null; }
        if (meta?.parts?.length) this.parts.set(id, path.join(this.partsDir(id), path.basename(meta.parts[0])));
        return meta;
    }

    // Архив больше не нужен (вместе с папкой томов)
    async dropArchive(id) {
        await fsp.rm(this.stored(id), { force: true, recursive: true });
        this.parts.delete(id);
    }

    // Через временный файл и переименование: оборвись запись посередине — старое состояние цело.
    // Имя временного у каждой записи своё: две записи разом не переименуют один файл дважды
    async writeMeta(meta) {
        meta.updatedAt = Date.now();
        const tmp = `${this.metaPath(meta.id)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(meta));
        await fsp.rename(tmp, this.metaPath(meta.id));
        return meta;
    }

    async received(id) {
        if (this.parts.has(id)) {
            const names = await fsp.readdir(this.partsDir(id)).catch(() => []);
            const sizes = await Promise.all(names.map((n) => fsp.stat(path.join(this.partsDir(id), n)).then((st) => st.size, () => 0)));
            return sizes.reduce((a, b) => a + b, 0);
        }
        try { return (await fsp.stat(this.archivePath(id))).size; } catch (e) { return 0; }
    }

    async forget(id) {
        // Архив из «Входящих» (отменили, пока ждал пароля) — не стираем, а в _inbox/_failed: другой копии может не быть
        const meta = await this.readMeta(id).catch(() => null);
        if (!meta?.inbox || await this.keepInbox(id, meta)) await this.dropArchive(id);
        await fsp.rm(this.metaPath(id), { force: true });
        this.steps.delete(id);
        this.passwords.delete(id);
    }

    checkId(id) {
        if (!/^[0-9a-f]{32}$/.test(String(id || ''))) throw fail(400, 'Непонятный номер загрузки');
    }

    // Начать или продолжить. Тот же файл — та же загрузка: сколько уже получено, с того и продолжаем
    // target — игра из библиотеки, которую архив обновляет (её папка); без него это новая игра
    // mode: 'patch' — архив не новая версия, а патч или мод поверх игры target
    async start({ name, size, fingerprint, target, mode } = {}) {
        // Айфон отдаёт имена в разложенном виде («и» + значок над ней): приводим к обычному,
        // иначе у того же файла с другого устройства был бы другой номер загрузки
        name = String(name || '').normalize('NFC').trim();
        size = Number(size);
        fingerprint = String(fingerprint || '');
        if (!ARCHIVE.test(name) || name.length > 255 || /[\\/]/.test(name)) throw fail(400, 'Поддерживаются только архивы ZIP, 7z и RAR');
        if (!Number.isInteger(size) || size <= 0 || size > MAX_SIZE) throw fail(400, 'Непонятный размер файла');
        if (!/^[0-9a-z]{1,64}$/.test(fingerprint)) throw fail(400, 'Непонятный отпечаток файла');
        target = target ? String(target) : '';
        mode = mode === 'patch' ? 'patch' : '';
        if (mode && !target) throw fail(400, 'Непонятно, к какой игре патч');
        // Игру, которую не обновить, видно сразу — а не после гигабайтов загрузки
        if (target) await this.checkTarget(target);
        await fsp.mkdir(this.dir, { recursive: true });

        const id = UploadService.idFor(name, size, fingerprint, target, mode);
        let meta = await this.readMeta(id);
        // Распаковывается (или распаковывался, а сервер перезапустился) или ждёт пароля — тот же архив
        if (meta?.state === 'processing' || meta?.state === 'password') return this.status(id);
        // Тот же файл ещё раз после готовой или неудачной загрузки — это новая загрузка
        if (meta && meta.state !== 'uploading') {
            await this.forget(id);
            meta = null;
        }

        let received = await this.received(id);
        // Архив больше заявленного размера — что-то не то: собираем заново
        if (received > size && !this.writing.has(id)) {
            await fsp.truncate(this.archivePath(id), 0);
            received = 0;
        }
        const need = size - received + SPACE_MARGIN;
        const free = await this.tools.freeSpace(this.dir);
        if (free < need) throw fail(507, `Не хватает места на диске: нужно ещё ${gb(need)}, свободно ${gb(free)}`);

        // Состояние пишем, только когда его нет: перезапись старой копией могла бы вернуть
        // «загружается» файлу, который другое устройство только что догрузило
        if (!meta) meta = await this.writeMeta({ id, name, size, state: 'uploading', createdAt: Date.now(), ...(target ? { target } : {}), ...(mode ? { mode } : {}) });
        this.seen.set(id, Date.now());
        console.log(`[Upload] ${name}: ${received ? `продолжение с ${mb(received)} из ${mb(size)} МБ` : `начало, ${mb(size)} МБ`}`);
        return { id, state: 'uploading', received, size };
    }

    // Архив из «Входящих» (services/inbox.js): дальше — как загруженный, только переносом, а не загрузкой. Тот же файл
    // (имя, размер, время), который ещё принимается, второй раз не берём; принятый или неудачный (вернули из _failed) —
    // берём заново. Описание — до переноса: оборвётся между ними — архив останется во «Входящих», а не потеряется
    // target — игра библиотеки: архив встаёт её обновлением, как «Обновить игру» (прежняя версия — в _old). Игру уже не
    // обновить (убрали, ссылка только для чтения) — берём как новую, а не теряем архив
    // file — архив или его тома списком (первый — первым)
    async importFile(file, { target = '', version = '', passwords = [] } = {}) {
        const files = [].concat(file);
        const name = path.basename(files[0]).normalize('NFC');
        if (target) {
            try { await this.checkTarget(target); } catch (e) {
                console.warn(`[Upload] ${name}: обновить «${target}» нельзя (${e.message}) — встанет новой игрой`);
                target = '';
            }
        }
        const stats = await Promise.all(files.map((f) => fsp.stat(f)));
        const st = { size: stats.reduce((a, b) => a + b.size, 0), mtimeMs: stats[0].mtimeMs };
        const id = UploadService.idFor(name, st.size, `inbox${Math.floor(st.mtimeMs)}`);
        const old = await this.readMeta(id);
        if (old && !['done', 'error'].includes(old.state)) return id;
        if (old) await this.forget(id);
        await fsp.mkdir(this.dir, { recursive: true });
        const known = (Array.isArray(passwords) ? passwords : []).map((p) => String(p || '').slice(0, 200)).filter((p) => p && !p.includes('\0')).slice(0, 5);
        const parts = files.length > 1 ? files.map((f) => path.basename(f)) : null;
        await this.writeMeta({ id, name, size: st.size, state: 'processing', createdAt: Date.now(), inbox: true, ...(target ? { target, ...(version ? { expect: version } : {}) } : {}), ...(known.length ? { passwords: known } : {}), ...(parts ? { parts } : {}) });
        if (parts) {
            await fsp.mkdir(this.partsDir(id), { recursive: true });
            this.parts.set(id, path.join(this.partsDir(id), parts[0]));
        }
        // «Входящие» на другом диске (INBOX_DIR) — переносом через копирование
        const move = (from, to) => fsp.rename(from, to).catch((e) => (e.code === 'EXDEV' ? execFileP('mv', [from, to]) : Promise.reject(e)));
        const moved = [];
        try {
            for (const f of files) {
                const dest = parts ? path.join(this.partsDir(id), path.basename(f)) : this.archivePath(id);
                await move(f, dest);
                moved.push([f, dest]);
            }
        } catch (e) {
            // Не перенёсся один том — перенесённые назад, метку долой: «Входящие» попробуют весь архив снова
            for (const [from, to] of moved) await move(to, from).catch((err) => console.error(`[Upload] ${path.basename(from)}: не вернуть во «Входящие» — лежит в ${to}:`, err.message));
            if (parts) await fsp.rmdir(this.partsDir(id)).catch(() => {});
            this.parts.delete(id);
            await fsp.rm(this.metaPath(id), { force: true });
            throw e;
        }
        console.log(`[Upload] ${name}: из «Входящих», ${mb(st.size)} МБ${parts ? `, томов: ${parts.length}` : ''}`);
        this.finalize(id);
        return id;
    }

    // Архив из «Входящих» — в _inbox/_failed, а не в никуда. Время в имени — прежний неудачный с тем же именем не
    // затирается. true — перенесли или переносить нечего; false — не вышло, архив остаётся, где был
    async keepInbox(id, meta) {
        if (!this.inboxDir) return false;
        const failed = path.join(this.inboxDir, '_failed');
        // Тома — папкой с именем архива
        const dest = path.join(failed, `${Date.now()}-${path.basename(meta.parts ? setOf(meta.name) : meta.name)}`);
        try {
            await fsp.mkdir(failed, { recursive: true });
            await fsp.rename(this.stored(id), dest);
        } catch (e) {
            if (e.code === 'ENOENT') return true;
            if (e.code !== 'EXDEV') { console.error(`[Upload] ${meta.name}: в _inbox/_failed не перенести — архив остаётся в ${this.dir}:`, e.message); return false; }
            try { await execFileP('mv', [this.stored(id), dest]); } catch (err) { console.error(`[Upload] ${meta.name}:`, err.message); return false; }
        }
        console.log(`[Upload] ${meta.name}: архив — в _inbox/_failed`);
        return true;
    }

    // Занять загрузку под запись куска. Занята живым запросом — 409; молчащим — он уступает место
    async claim(id, req) {
        for (;;) {
            const other = this.writing.get(id);
            if (!other) break;
            if (!other.stalled(this.takeoverMs)) throw fail(409, 'Этот файл уже загружается — в другой вкладке или с другого устройства', { busy: true });
            other.stop(fail(499, 'соединение молчало, его место занял новый запрос'));
            await other.closed;
        }
        // Без ошибки в destroy: ошибка на запросе, у которого ещё нет обработчика, уронила бы процесс
        const entry = { req, lastData: Date.now(), stop: () => req.destroy() };
        entry.stalled = (ms) => Date.now() - entry.lastData > ms;
        entry.closed = new Promise((resolve) => { entry.release = resolve; });
        this.writing.set(id, entry);
        return entry;
    }

    // Кусок с места offset. Писать можно только с того места, где архив кончается: байты идут строго
    // подряд, и ни дыр, ни двойной записи не бывает. Не то место (повтор куска, ответ на который
    // потерялся) — 409 и сколько получено: клиент продолжит оттуда
    async writeChunk(id, offset, req) {
        this.checkId(id);
        if (!Number.isInteger(offset) || offset < 0) throw fail(400, 'Непонятное место в файле');
        const length = Number(req.headers?.['content-length']);
        if (!Number.isInteger(length) || length <= 0) throw fail(411, 'У куска нет длины');

        const entry = await this.claim(id, req);
        const t0 = Date.now();
        this.seen.set(id, t0);
        try {
            const meta = await this.readMeta(id);
            if (!meta) throw fail(404, 'Такой загрузки нет — начните заново');
            if (meta.state !== 'uploading') throw fail(409, 'Файл уже получен целиком', { state: meta.state });
            const received = await this.received(id);
            if (offset !== received) throw fail(409, 'Не то место в файле', { received });
            if (offset + length > meta.size) throw fail(413, 'Кусок выходит за размер файла');

            let written = 0;
            try {
                written = await this.pipeChunk(id, offset, req, entry);
            } catch (e) {
                const total = offset + (e.written || 0);
                console.warn(`[Upload] ${meta.name}: кусок с ${mb(offset)} МБ прервался на ${mb(total)} МБ — ${e.message}`);
                if (e.code === 'ENOSPC') throw fail(507, 'Кончилось место на диске', { received: total });
                throw e;
            }

            const total = offset + written;
            console.log(`[Upload] ${meta.name}: ${mb(total)} из ${mb(meta.size)} МБ (+${mb(written)} МБ за ${((Date.now() - t0) / 1000).toFixed(1)} с)`);
            if (total < meta.size) {
                // Уборка временной папки смотрит на время изменения: состояние стареет вместе с архивом
                const now = new Date();
                await fsp.utimes(this.metaPath(id), now, now).catch(() => {});
                return { received: total, state: 'uploading' };
            }
            // Получен целиком — распаковка в фоне, ответ сразу
            meta.state = 'processing';
            await this.writeMeta(meta);
            this.finalize(id);
            return { received: total, state: 'processing' };
        } finally {
            if (this.writing.get(id) === entry) this.writing.delete(id);
            entry.release();
        }
    }

    // Тело запроса — прямо в архив с места offset. Сколько записано — по потоку записи: она
    // знает, сколько байтов реально легло на диск, в том числе когда телефон оборвал отправку
    pipeChunk(id, offset, req, entry) {
        return new Promise((resolve, reject) => {
            // Обрыв (телефон ушёл из сети, запрос сменили новым, отменили) — 499: отвечать уже некому
            const broken = (why) => fail(499, why);
            if (req.destroyed) return reject(Object.assign(broken('кусок оборвался'), { written: 0 }));
            const ws = fs.createWriteStream(this.archivePath(id), { flags: offset ? 'r+' : 'w', start: offset });
            let failed = null;
            const stop = (e, killRequest) => {
                if (failed) return;
                failed = e;
                req.unpipe(ws);
                ws.destroy();
                if (killRequest) req.destroy();
            };
            entry.stop = (e) => stop(e, true);
            // Пока диск пишет (буфер записи не пуст), запрос стоит не по своей вине — это не молчание
            entry.stalled = (ms) => ws.writableLength === 0 && Date.now() - entry.lastData > ms;
            const watchdog = setInterval(() => {
                if (entry.stalled(this.stallMs)) stop(broken(`кусок молчал ${Math.round(this.stallMs / 1000)} с`), true);
            }, Math.min(5000, this.stallMs / 3));

            req.on('data', () => { entry.lastData = Date.now(); });
            req.on('error', () => stop(broken('кусок оборвался')));
            // Телефон оборвал отправку — записанное остаётся: оно годное, с него и продолжат
            req.on('close', () => { if (!req.complete) stop(broken('кусок оборвался')); });
            ws.on('error', (e) => stop(e));
            // Занятость снимается, только когда файл закрыт: иначе запись, ещё идущая после обрыва,
            // наложилась бы на следующий кусок
            ws.on('close', () => {
                clearInterval(watchdog);
                if (failed) reject(Object.assign(failed, { written: ws.bytesWritten }));
                else resolve(ws.bytesWritten);
            });
            req.pipe(ws);
        });
    }

    // Состояние для клиента. «Распаковывается», а распаковки нет — сервер перезапустился посередине:
    // продолжаем
    async status(id) {
        this.checkId(id);
        const meta = await this.readMeta(id);
        if (!meta) throw fail(404, 'Такой загрузки нет — начните заново');
        this.seen.set(id, Date.now());
        if (meta.state === 'processing' && !this.jobs.has(id)) this.finalize(id);
        return {
            id, name: meta.name, state: meta.state, received: await this.received(id), size: meta.size,
            step: this.steps.get(id) || '', folder: meta.folder || '', error: meta.error || '', target: meta.target || '',
            mode: meta.mode || '', patch: meta.patch || null,
        };
    }

    // Пароль к архиву, который его ждёт. Проверяет его сама распаковка: не подошёл — архив снова
    // ждёт пароля, с пометкой «Неверный пароль»
    async setPassword(id, password) {
        this.checkId(id);
        password = String(password ?? '');
        if (!password || password.length > 1000 || password.includes('\0')) throw fail(400, 'Введите пароль');
        const meta = await this.readMeta(id);
        if (!meta) throw fail(404, 'Такой загрузки нет — начните заново');
        if (meta.state !== 'password' || this.jobs.has(id)) throw fail(409, 'Архив сейчас не ждёт пароля', { state: meta.state });
        this.passwords.set(id, password);
        this.seen.set(id, Date.now());
        meta.state = 'processing';
        meta.error = '';
        await this.writeMeta(meta);
        this.finalize(id);
        return this.status(id);
    }

    // Отменить: недогруженное — сразу с диска, идущий кусок — оборвать. Распаковку не прерываем:
    // 7-Zip посреди работы оставил бы полпапки. Ждущую очереди — можно: её очередь придёт, а состояния
    // уже нет, и распаковка ничего не сделает (runFinalize). Отмена неудачной загрузки убирает её из списка
    async cancel(id) {
        this.checkId(id);
        if (this.queued(id)) {
            this.waiting.delete(id);
            this.jobs.delete(id);
            await this.forget(id);
            return { cancelled: true };
        }
        if (this.jobs.has(id)) throw fail(409, 'Архив уже распаковывается — дождитесь конца', { state: 'processing' });
        const writer = this.writing.get(id);
        if (writer) {
            writer.stop(fail(499, 'загрузку отменили'));
            await writer.closed;
            // Оборванный кусок успел стать последним — распаковка уже началась
            if (this.jobs.has(id)) throw fail(409, 'Архив уже распаковывается — дождитесь конца', { state: 'processing' });
        }
        await this.forget(id);
        return { cancelled: true };
    }

    // Недогруженные, распаковывающиеся и неудачные — чтобы после перезагрузки страницы было видно,
    // что осталось и что с ним делать
    async list() {
        let files = [];
        try { files = await fsp.readdir(this.dir); } catch (e) { return []; }
        const items = [];
        for (const file of files) {
            const id = (file.match(/^([0-9a-f]{32})\.json$/) || [])[1];
            const meta = id && await this.readMeta(id);
            if (!meta || meta.state === 'done') continue;
            const received = await this.received(id);
            if (meta.state === 'uploading' && !received) continue;
            let mtime = 0;
            try { mtime = (await fsp.stat(this.archivePath(id))).mtimeMs; } catch (e) {}
            // Байты шли только что — её сейчас грузят (с другого устройства): удалить не предложим
            const busy = meta.state === 'uploading' && (this.writing.has(id) || Date.now() - mtime < 30 * 1000);
            items.push({ id, name: meta.name, size: meta.size, received, state: meta.state, error: meta.error || '', target: meta.target || '', mode: meta.mode || '', busy, queued: this.queued(id), updatedAt: Math.max(meta.updatedAt || 0, mtime) });
        }
        return items.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    // Архив из «Входящих» с одним из этих имён, принятый не раньше since, — для хода загрузки «Загрузить» (services/myjd.js):
    // { state, error, game, step } самой свежей метки или null
    async inboxStatus(names, since) {
        let files = [];
        try { files = await fsp.readdir(this.dir); } catch (e) { return null; }
        let best = null;
        for (const file of files) {
            const id = (file.match(/^([0-9a-f]{32})\.json$/) || [])[1];
            const meta = id && await this.readMeta(id);
            if (meta?.inbox && names.includes(meta.name) && meta.createdAt >= since && (!best || meta.createdAt > best.createdAt)) best = meta;
        }
        return best && { state: best.state, error: best.error || '', game: best.target || best.folder || '', step: this.steps.get(best.id) || (this.queued(best.id) ? 'queued' : '') };
    }

    // После перезапуска сервера: доделать распаковки, прерванные посередине, — даже если страницу,
    // с которой грузили, уже закрыли
    async recover() {
        for (const item of await this.list()) {
            if (item.state === 'processing') this.finalize(item.id);
        }
    }

    // Архив под паролем — первый подошедший из известных; не под паролем или ни один не подошёл — '' (спросим человека)
    async knownPassword(file, fromPage) {
        let entries = null;
        try {
            entries = await this.tools.list(file, '');
            if (!entries.some((e) => e.encrypted)) return '';
        } catch (e) {
            if (!e.password) return '';
        }
        // Быстро, а не проходом по архиву в гигабайты: зашифрован список — пароль проверяет само чтение списка;
        // иначе — проверка самого маленького зашифрованного файла
        const small = entries && entries.filter((e) => e.encrypted).sort((a, b) => a.size - b.size)[0];
        if (small && !this.tools.test) return '';
        const fits = (pw) => (small ? this.tools.test(file, pw, small.path) : this.tools.list(file, pw));
        for (const candidate of [...new Set(fromPage)]) {
            try {
                await fits(candidate);
                console.log(`[Upload] ${path.basename(file)}: архив под паролем — подошёл известный`);
                return candidate;
            } catch (e) { /* не этот */ }
        }
        return '';
    }

    // Архив, который сейчас распакуем: пути внутри и место на диске. Пароль — тот, что дал человек,
    // и для вложенных тот же; нет его или не тот — needPassword
    async checkArchive(file, { password, needPassword }) {
        let entries;
        try {
            entries = await this.tools.list(file, password);
        } catch (e) {
            // Зашифрован и список файлов: без верного пароля 7-Zip не открывает архив вовсе
            if (e.password) throw needPassword();
            throw e;
        }
        if (!entries.length) throw new Error('Архив пуст');
        if (entries.some((e) => e.encrypted) && !password) throw needPassword();
        if (entries.some((e) => unsafePath(e.path))) throw new Error('В архиве путь наружу («../») — такой архив не распаковываем');
        const unpacked = entries.reduce((sum, e) => sum + e.size, 0);
        const free = await this.tools.freeSpace(this.dir);
        if (free < unpacked + SPACE_MARGIN) throw new Error(`Не хватает места для распаковки: нужно ${gb(unpacked + SPACE_MARGIN)}, свободно ${gb(free)}`);
    }

    async extractArchive(file, dir, { password, needPassword }) {
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.mkdir(dir, { recursive: true });
        try {
            await this.tools.extract(file, dir, password);
        } catch (e) {
            if (e.password) throw needPassword();
            throw e;
        }
    }

    // Игра в распакованном, а нет — во вложенном архиве: игру часто пакуют дважды (rar, в нём zip)
    // или кладут в архив многотомный. Вложенные — самый большой первым, не глубже NESTED_DEPTH;
    // распакованный вложенный архив сразу удаляем — место ещё понадобится
    async findGame(dir, ctx, depth = 0) {
        const found = await this.findGameFolder(dir);
        if (found || depth >= NESTED_DEPTH) return found;
        for (const file of await innerArchives(dir)) {
            ctx.onNested();
            await this.checkArchive(file, ctx);
            const out = `${file}_unpacked`;
            await this.extractArchive(file, out, ctx);
            await fsp.rm(file, { force: true });
            const game = await this.findGame(out, ctx, depth + 1);
            if (game) return game;
        }
        return null;
    }

    // Игра, которую обновляют: должна быть в библиотеке и быть настоящей папкой. В dev игры прода —
    // ссылки только для чтения, их здесь не обновить
    async checkTarget(target) {
        if (!isSafeSegment(target) || RESERVED.includes(target.toLowerCase())) throw fail(400, 'Непонятная игра');
        const st = await fsp.lstat(path.join(this.gamesDir, target)).catch(() => null);
        if (!st) throw fail(404, 'Такой игры в библиотеке нет');
        // 403, а не 409: 409 страница понимает как «занято, повторить позже»
        if (st.isSymbolicLink() || !st.isDirectory()) throw fail(403, 'Эту игру здесь не обновить: её папка — ссылка только для чтения');
    }

    // Новые файлы — в папку игры, прежние — в _old/<игра>/<дата>. Два переименования в пределах диска,
    // мгновенно; без папки игра остаётся лишь на этот миг (сверка библиотеки его переживает). Куда
    // уедет прежняя версия, записано заранее: перезапуск сервера посередине — следующий заход
    // доделывает по тому, где что лежит
    async swapIn(meta, source) {
        const dest = path.join(this.gamesDir, meta.target);
        if (!meta.backup) {
            await this.checkTarget(meta.target);
            meta.backup = path.join(meta.target, new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
            await this.writeMeta(meta);
        }
        const backup = path.join(this.oldDir, meta.backup);
        const moved = fs.existsSync(backup);
        if (moved && fs.existsSync(dest)) return dest;
        if (!moved) {
            await fsp.mkdir(path.dirname(backup), { recursive: true });
            await fsp.rename(dest, backup);
        }
        await fsp.rename(source, dest);
        return dest;
    }

    // Патч поверх игры: новая версия папки — копия игры из жёстких ссылок (места почти не занимает),
    // в ней файлы патча заменяют прежние (прежний файл сначала убираем, а не переписываем: он общий с
    // копией), потом та же замена папок, что у новой версии. Прежний вид игры — в _old, «Вернуть
    // прежнюю версию» его вернёт. Сейвы, время и данные — при игре
    async applyPatch(meta, id, extractDir, ctx, say) {
        say('find');
        const dest = path.join(this.gamesDir, meta.target);
        const staging = path.join(this.dir, `patch_${id}`);
        const backup = meta.backup ? path.join(this.oldDir, meta.backup) : '';
        // Перезапуск сервера между двумя переименованиями swapIn: игра уже в _old, готовая копия ждёт
        const halfway = backup && fs.existsSync(backup) && !fs.existsSync(dest) && fs.existsSync(staging);
        if (!halfway) {
            await this.checkTarget(meta.target);
            let files = await listFiles(extractDir);
            // Патч, запакованный ещё раз, — распакуем вложенный архив
            if (files.length && files.every((f) => isInnerArchive(path.basename(f)))) {
                const inner = path.join(extractDir, files.sort((a, b) => fs.statSync(path.join(extractDir, b)).size - fs.statSync(path.join(extractDir, a)).size)[0]);
                ctx.onNested();
                await this.checkArchive(inner, ctx);
                await this.extractArchive(inner, `${inner}_unpacked`, ctx);
                await fsp.rm(inner, { force: true });
                files = await listFiles(extractDir);
            }
            if (!files.length) throw new Error('Архив пустой');
            const { plan, replaced, added, skipped } = planPatch(files, await listFiles(dest));
            say('save');
            await fsp.rm(staging, { recursive: true, force: true });
            await execFileP('cp', ['-al', dest, staging]);
            for (const { from, to } of plan) {
                const target = path.join(staging, to);
                if (!path.resolve(target).startsWith(path.resolve(staging) + path.sep)) continue;
                await fsp.mkdir(path.dirname(target), { recursive: true });
                await fsp.rm(target, { force: true });
                await fsp.rename(path.join(extractDir, from), target);
            }
            meta.patch = { replaced, added, skipped };
            await this.writeMeta(meta);
        }
        say('save');
        await this.swapIn(meta, staging);
        meta.folder = meta.target;
        await this.writeMeta(meta);
        await this.refreshGame(meta.target, dest, { archiveName: meta.name, backupDir: path.join(this.oldDir, meta.backup), patch: true });
        console.log(`[Upload] ${meta.name}: патч к ${meta.target} — заменено ${meta.patch?.replaced ?? '?'}, добавлено ${meta.patch?.added ?? '?'}, прежний вид — в _old/${meta.backup}`);
        this.afterAdd(meta.target, dest);
    }

    // Каждое задание — своё: отменённое в очереди (cancel) из jobs уходит, и если тот же архив
    // загрузят снова, его новое задание не спутается со старым — старое, дойдя до очереди, просто пропустится
    finalize(id) {
        if (!this.jobs.has(id)) {
            if (this.active || this.jobs.size) this.steps.set(id, 'queued');
            this.waiting.add(id);
            // job — сам себе пропуск: в jobs уже другое задание (или никакого) — это отменили
            const job = this.turn
                .then(async () => {
                    if (this.jobs.get(id) !== job) return;
                    this.waiting.delete(id);
                    this.active = id;
                    this.steps.delete(id);
                    try {
                        await this.runFinalize(id);
                    } finally {
                        this.active = null;
                    }
                })
                .catch((e) => console.error(`[Upload] ${id}: ${e.message}`))
                .finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); })
                .then(() => this.announce(id));
            // Следующая — после этой, чем бы эта ни кончилась
            this.turn = job.catch(() => {});
            this.jobs.set(id, job);
        }
        return this.jobs.get(id);
    }

    // Ждёт своей очереди на распаковку, а не распаковывается и не закончилась
    queued(id) {
        return this.waiting.has(id);
    }

    // Загрузка дошла до конца (готово, ошибка или ждёт пароля) — сказать тому, кто слушает
    async announce(id) {
        if (!this.finished.delete(id) || !this.onFinished) return;
        const meta = await this.readMeta(id).catch(() => null);
        if (!meta) return;
        try {
            await this.onFinished({
                name: meta.name, state: meta.state, error: meta.error || '', folder: meta.folder || '', target: meta.target || '',
                mode: meta.mode || '', version: meta.version || '', unattended: Date.now() - (this.seen.get(id) || 0) > this.unattendedMs,
            });
        } catch (e) {
            console.error('[Upload] Сообщение о загрузке:', e.message);
        }
    }

    async runFinalize(id) {
        const meta = await this.readMeta(id);
        if (!meta || meta.state !== 'processing') return;
        const say = (step) => this.steps.set(id, step);
        const extractDir = path.join(this.dir, `ext_${id}`);
        let password = this.passwords.get(id) || '';
        // Пароля нет или не тот — архив остаётся ждать пароля, а не уходит в ошибку
        const needPassword = () => Object.assign(new Error(password ? 'Неверный пароль' : 'Архив под паролем'), { needPassword: true });
        try {
            // Сервер перезапустился после того, как игра уже переехала в библиотеку: второй раз
            // не распаковываем — в базу её добавила сверка библиотеки при старте
            if (meta.folder && fs.existsSync(path.join(this.gamesDir, meta.folder))) {
                // Новая версия встала на место, а данные из её файлов записать не успели
                if (meta.target) await this.refreshGame(meta.target, path.join(this.gamesDir, meta.target), { archiveName: meta.name, backupDir: path.join(this.oldDir, meta.backup), patch: meta.mode === 'patch' });
                await fsp.rm(extractDir, { recursive: true, force: true });
                await this.dropArchive(id);
                meta.state = 'done';
                await this.writeMeta(meta);
                return;
            }
            if (await this.received(id) !== meta.size) throw new Error('Архив на сервере неполный — загрузите его снова');

            // Пароль не вводили — пробуем известные (заданные при загрузке по ссылке), пока архив не откроется
            if (!password) password = await this.knownPassword(this.archivePath(id), meta.passwords || []);
            let nested = 0;
            const ctx = { password, needPassword, onNested: () => { nested += 1; say('nested'); } };
            say('check');
            await this.checkArchive(this.archivePath(id), ctx);

            say('extract');
            await this.extractArchive(this.archivePath(id), extractDir, ctx);

            if (meta.mode === 'patch') {
                await this.applyPatch(meta, id, extractDir, ctx, say);
                await fsp.rm(extractDir, { recursive: true, force: true });
                await this.dropArchive(id);
                meta.state = 'done';
                await this.writeMeta(meta);
                this.finished.add(id);
                return;
            }

            say('find');
            const source = await this.findGame(extractDir, ctx);
            if (!source) {
                // Игра на другом движке — так и говорим: «нет папки www» человеку ничего не объясняет
                const engine = await otherEngine(extractDir);
                if (engine) throw new Error(`Это игра на ${engine} — библиотека запускает только игры на RPG Maker MV и MZ`);
                throw new Error(nested ? 'В архиве нет игры: ни папки www, ни index.html — и во вложенных архивах тоже' : 'В архиве нет игры: не найдены ни папка www, ни index.html');
            }
            // Новая версия игры из библиотеки: та же папка, тот же номер — сохранения, наигранное время,
            // статус и найденные данные остаются при ней. Прежние файлы — в _old, а не в корзину
            if (meta.target) {
                say('save');
                const dest = await this.swapIn(meta, source);
                meta.folder = meta.target;
                await this.writeMeta(meta);
                const { version } = await this.refreshGame(meta.target, dest, { archiveName: meta.name, backupDir: path.join(this.oldDir, meta.backup), version: meta.expect || '' });
                await fsp.rm(extractDir, { recursive: true, force: true });
                await this.dropArchive(id);
                meta.state = 'done';
                if (version) meta.version = version;
                await this.writeMeta(meta);
                this.finished.add(id);
                console.log(`[Upload] ${meta.name}: игра ${meta.target} обновлена${version ? ` до ${version}` : ''}, прежняя версия — в _old/${meta.backup}`);
                this.afterAdd(meta.target, dest);
                return;
            }

            // Имя папки — из имени архива: буквы любых алфавитов остаются (японское имя раньше
            // становилось «_________»), прочее — «_». Имя файла в Linux — не больше 255 байт, а знак
            // японского — три байта: режем по байтам, по целым знакам
            const chars = [...meta.name.replace(VOLUME, '').replace(ARCHIVE, '').normalize('NFC').replace(/[^\p{L}\p{N}\p{M} \-.[\]]/gu, '_').trim()];
            while (Buffer.byteLength(chars.join('')) > 200) chars.pop();
            let base = chars.join('').trim();
            if (!/[\p{L}\p{N}]/u.test(base) || RESERVED.includes(base.toLowerCase()) || base.startsWith('.')) base = `game_${Date.now()}`;
            let folder = base;
            for (let n = 1; fs.existsSync(path.join(this.gamesDir, folder)); n++) folder = `${base}_${n}`;

            // Папку запоминаем до переезда: перезапуск сервера после него не распакует игру дважды
            meta.folder = folder;
            await this.writeMeta(meta);
            say('save');
            const dest = path.join(this.gamesDir, folder);
            try {
                await fsp.rename(source, dest);
            } catch (e) {
                // Временная папка на другом диске — переносом через копирование
                if (e.code !== 'EXDEV') throw e;
                await execFileP('mv', [source, dest]);
            }
            await this.addGameToDB(folder, dest);

            await fsp.rm(extractDir, { recursive: true, force: true });
            await this.dropArchive(id);
            meta.state = 'done';
            await this.writeMeta(meta);
            this.finished.add(id);
            console.log(`[Upload] ${meta.name}: игра добавлена в папку ${folder}`);
            this.afterAdd(folder, dest);
        } catch (e) {
            // С неверным паролем 7-Zip всё равно создаёт пустые файлы — распакованное убираем всегда
            await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
            if (e.needPassword) {
                meta.state = 'password';
                meta.error = password ? e.message : '';
                await this.writeMeta(meta).catch(() => {});
                this.finished.add(id);
                console.log(`[Upload] ${meta.name}: ${password ? 'пароль не подошёл' : 'архив под паролем — ждём пароль'}`);
                return;
            }
            // Архив из «Входящих» не стираем: другой копии у человека может не быть — в _inbox/_failed, разобраться
            if (!meta.inbox || await this.keepInbox(id, meta)) await this.dropArchive(id).catch(() => {});
            meta.state = 'error';
            meta.error = e.message;
            await this.writeMeta(meta).catch(() => {});
            this.finished.add(id);
            console.error(`[Upload] ${meta.name}: ${e.message}`);
        } finally {
            this.steps.delete(id);
            this.passwords.delete(id);
        }
    }
}

module.exports = new UploadService();
module.exports.UploadService = UploadService;
module.exports.parseListing = parseListing;
module.exports.explain7z = explain7z;
module.exports.planPatch = planPatch;
