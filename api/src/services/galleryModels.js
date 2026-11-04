const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { OFFLINE } = require('../config/index.js');
const { option, savedOption } = require('../utils/options.js');

// Общее у трёх моделей поиска по картинкам (galleryVision.js, galleryTags.js, galleryText.js): включён ли разбор, файлы
// в _media/_models и сессии в памяти. Все вместе занимают около 1,5 ГБ и на простое ничего не делают
// Простой, после которого сессия закрывается: на разборе вызовы идут подряд, а открыть заново — секунды
const IDLE_MS = 5 * 60 * 1000;
const DOWNLOAD_MS = 20 * 60 * 1000;
const FAILED_MS = 60 * 60 * 1000;
// Меньше 2 ГБ на всё — разбор сам не включается: на нём модели занимают около 1 ГБ, и система убила бы сервер.
// Малина и маленькие NAS уходили бы в перезапуск по кругу. Включить самому можно: слово человека главнее
// Машина «на 2 ГБ» показывает около 1,9: она сюда не попадает
const MIN_MEMORY = 1.8 * 1024 ** 3;

const memory = () => {
    const limit = process.constrainedMemory();
    return limit > 0 ? Math.min(limit, os.totalmem()) : os.totalmem();
};

// Не включился только потому, что мало памяти, — строка в «Настройках» так и скажет
const tooSmall = (bytes = memory()) => savedOption('picture_analysis') === undefined && option('picture_analysis') && bytes < MIN_MEMORY;
// Идёт ли разбор: переключатель в «Настройках», не трогали — PICTURE_PASS (образ и docker-compose.yml)
const analysisOn = (bytes = memory()) => savedOption('picture_analysis') ?? (option('picture_analysis') && !tooSmall(bytes));
// Человек выключил сам. Просто PICTURE_PASS=0 (dev) галерею не меняет: она так и сверяет кадры уже скачанной моделью
const turnedOff = () => savedOption('picture_analysis') === false;

// Разметчику — одно ядро: так кадр стоит меньше всего работы процессора. Два — только если человек выбрал «Быстро», и не на
// машине из двух ядер: они нужны и играм. Читается при открытии сессии: сменили скорость — сессию надо закрыть (server.js)
const tagThreads = (cores = os.availableParallelism(), speed = option('picture_speed')) => (cores > 2 && speed === 'fast' ? 2 : 1);

// Очередь на один кадр: кто раньше встал, тот раньше считает, поэтому векторы и теги в тихом режиме идут через кадр.
// Упавший кадр место тоже отдаёт: иначе разбор встал бы навсегда
class FrameTurns {
    constructor() {
        this.busy = false;
        this.waiting = [];
    }

    async run(fn) {
        if (this.busy) await new Promise((resolve) => this.waiting.push(resolve));
        this.busy = true;
        try {
            return await fn();
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.busy = false;
        }
    }
}

const known = new Map();       // файл модели → размер: сколько всего нужно скачать (строка в «Настройках»)
const active = new Map();      // файл модели → { done, total } байт, пока качается
const checked = new Set();     // файлы, чью сумму уже сверили: сессия открывается заново после простоя, а 378 МБ считать долго
let stop = new AbortController();
let failed = 0;

const registerModels = (specs) => { for (const s of specs) known.set(s.name, s.size); };

const hashFile = async (file) => {
    const h = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), h);
    return h.digest('hex');
};

// Потоком во временный файл, с суммой по ходу; зависшее соединение обрывается, выключенный разбор — тоже
async function downloadModel(spec, file) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const res = await fetch(spec.url, { redirect: 'follow', signal: AbortSignal.any([AbortSignal.timeout(DOWNLOAD_MS), stop.signal]) });
    if (!res.ok || !res.body) throw new Error(`${spec.name}: HTTP ${res.status}`);
    const h = crypto.createHash('sha256');
    const tmp = `${file}.${process.pid}.tmp`;
    const progress = { done: 0, total: Number(res.headers.get('content-length')) || 0 };
    active.set(spec.name, progress);
    try {
        await pipeline(Readable.fromWeb(res.body), new Transform({ transform(chunk, enc, done) { h.update(chunk); progress.done += chunk.length; done(null, chunk); } }), fs.createWriteStream(tmp));
        if (h.digest('hex') !== spec.sha256) throw new Error(`${spec.name}: не та контрольная сумма`);
        await fsp.rename(tmp, file);
    } finally {
        active.delete(spec.name);
        await fsp.rm(tmp, { force: true });
    }
}

// Файл модели на диске: оборвался или испорчен — скачать заново, а не падать на нём каждый час. Разбор выключен — только
// то, что уже скачано: из-за окна поиска или открытой галереи 740 МБ качаться не должны
async function modelFile(spec, mediaDir) {
    const file = path.join(mediaDir, '_models', spec.name);
    const has = () => fsp.access(file).then(() => true, () => false);
    if (!checked.has(file) && await has() && (await hashFile(file)) !== spec.sha256) await fsp.rm(file, { force: true });
    if (!(await has())) {
        if (OFFLINE) throw new Error('OFFLINE: модель не скачиваем');
        if (!analysisOn()) throw new Error('разбор картинок выключен: модель не скачиваем');
        await downloadModel(spec, file);
    }
    checked.add(file);
    return file;
}

// Скачивание файлов этой модели: { done, total } или {}
const progressOf = (specs) => {
    const hit = specs.map((s) => active.get(s.name)).find(Boolean);
    return hit ? { done: hit.done, total: hit.total } : {};
};

// Все модели вместе: сколько байт уже есть и сколько нужно; downloading — качается ли что-то сейчас
async function modelsOnDisk(mediaDir) {
    let have = 0;
    let total = 0;
    for (const [name, size] of known) {
        total += size;
        const st = await fsp.stat(path.join(mediaDir, '_models', name)).catch(() => null);
        if (st) have += st.size;
        else if (active.has(name)) have += active.get(name).done;
    }
    return { have, total, downloading: active.size > 0 };
}

// Модель не скачалась или не открылась: час сервис не пробует снова, строка в «Настройках» говорит об этом
const modelFailed = () => { failed = Date.now(); return failed; };
const modelsFailed = () => Date.now() - failed < FAILED_MS;
const stopDownloads = () => { stop.abort(); stop = new AbortController(); };
const clearFailure = () => { failed = 0; };

// Модель в памяти — только пока нужна. Все, кому она нужна, идут через use: открывается один раз на всех, а закрывается,
// только когда ею никто не пользуется, поэтому закрытую сессию никто не получит. Ждать открытия (warm) — тоже можно: окно
// поиска открылось, человек ещё печатает. Пока прежняя закрывается, новая не открывается: две сразу памяти не хватило бы
class ModelHolder {
    constructor(open, { close = (session) => session.release(), idleMs = IDLE_MS } = {}) {
        this.open = open;
        this.closeModel = close;
        this.idleMs = idleMs;
        this.model = null;
        this.opening = null;
        this.closing = null;
        this.users = 0;
        this.timer = null;
        this.dropping = false;
    }

    get ready() { return !!this.model; }

    async get() {
        if (this.closing) await this.closing;
        if (this.model) return this.model;
        if (!this.opening) {
            this.opening = Promise.resolve().then(() => this.open()).then((m) => { this.model = m; return m; }).finally(() => { this.opening = null; });
        }
        return this.opening;
    }

    async use(fn) {
        this.users++;
        clearTimeout(this.timer);
        try {
            return await fn(await this.get());
        } finally {
            this.users--;
            this.rest();
        }
    }

    warm() {
        return this.get().then((m) => { this.rest(); return m; }, () => { this.rest(); return null; });
    }

    // Выключили разбор: закрыть сразу, а кто считает прямо сейчас — как только досчитает
    unload() {
        this.dropping = true;
        this.rest();
    }

    rest() {
        clearTimeout(this.timer);
        if (this.users || this.opening) return;
        if (!this.model) { this.dropping = false; return; }
        if (this.dropping) { this.close(); return; }
        this.timer = setTimeout(() => this.close(), this.idleMs);
        this.timer.unref?.();
    }

    close() {
        this.dropping = false;
        const m = this.model;
        if (!m || this.users) return this.closing;
        this.model = null;
        this.closing = Promise.resolve().then(() => this.closeModel(m))
            .catch((e) => console.warn(`[Галерея] модель не закрылась: ${e.message}`))
            .finally(() => { this.closing = null; });
        return this.closing;
    }
}

module.exports = {
    ModelHolder, FrameTurns, registerModels, downloadModel, modelFile, modelsOnDisk, progressOf, modelFailed, modelsFailed, stopDownloads, clearFailure,
    analysisOn, turnedOff, tooSmall, tagThreads,
};
