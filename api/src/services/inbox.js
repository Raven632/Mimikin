const fsp = require('fs').promises;
const path = require('path');

// «Входящие»: архив, который положили в папку (JDownloader, торрент-клиент, копирование по сети), библиотека принимает
// сама — как «Добавить игру»: очередь, распаковка, узнавание, данные (services/uploads.js, importFile). Раз в 15 секунд
// смотрим папку и её подпапки (JDownloader кладёт каждый пакет в свою). Архив докачан, когда его размер и время не
// менялись между двумя проходами, и он не моложе 30 секунд: недокачанные у JDownloader зовутся «….part» и сюда не
// подходят, а торрент-клиент пишет в файл с окончательным именем. Архив томами (Game.part1.rar, Game.part2.rar …) —
// одной загрузкой, когда легли все тома: номера подряд с первого, ни один не докачивается и есть все, что качает эта
// загрузка JDownloader (volumesOf — он качает тома по очереди, следующего на диске ещё нет).
// shortcut: только тома RAR «.partN.rar»; «.7z.001» и «.r00» — если начнут попадаться
const EVERY_MS = 15 * 1000;
const SETTLE_MS = 30 * 1000;
// Тома, которых не ждёт ни одна загрузка (скопировали руками, торрент): сколько всех их не было — не знаем, ждём дольше
const LOOSE_SETTLE_MS = 10 * 60 * 1000;
const ARCHIVE = /\.(zip|7z|rar)$/i;
const VOLUME = /\.part(\d+)\.rar$/i;
// Набор томов: «Game.part2.rar» → «Game»
const setOf = (name) => String(name || '').replace(VOLUME, '');
const volume = (file) => Number((file.match(VOLUME) || [])[1]) || 0;
const DEPTH = 3;

// Нет прав на файл — чаще всего не наша ошибка, а как его положили: другой владелец с правами 600 или, на Fedora и RHEL,
// метка SELinux — перенесённый (mv) из домашней папки файл сохраняет свою, и контейнеру его не прочитать
const denied = (e) => (['EACCES', 'EPERM'].includes(e.code)
    ? '— нет прав на файл. Проверьте владельца и права, а на Fedora/RHEL — метку SELinux: копируйте во «Входящие», а не переносите, или chcon -t container_file_t <файл>'
    : '');

class InboxService {
    constructor() {
        this.dir = '';
        this.uploads = null;
        this.seen = new Map(); // файл → { size, mtime } с прошлого прохода
        this.warned = new Set();
    }

    // targetOf(name) — игра библиотеки, обновлением которой должен встать этот архив («Загрузить» у своей игры), или ''.
    // volumesOf(name) — все тома этого архива, что качает загрузка (services/myjd.js), или []
    setDependencies({ dir, uploads, targetOf = null, volumesOf = null }) {
        Object.assign(this, { dir, uploads, targetOf, volumesOf });
    }

    async files() {
        const out = [];
        const walk = async (dir, depth) => {
            const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory() && depth < DEPTH && e.name !== '_failed' && !e.name.startsWith('.')) await walk(p, depth + 1);
                else if (e.isFile() && ARCHIVE.test(e.name)) out.push(p);
            }
        };
        await walk(this.dir, 0);
        return out;
    }

    // Проход не начинается, пока идёт прежний: перенос большого архива на другой диск — минуты
    async scan(now = Date.now()) {
        if (this.scanning) return;
        this.scanning = true;
        try { await this.pass(now); } finally { this.scanning = false; }
    }

    async pass(now) {
        await fsp.mkdir(this.dir, { recursive: true });
        const present = new Set();
        const sets = new Map(); // набор томов (папка и имя) → [{ file, settled }]
        for (const file of await this.files()) {
            present.add(file);
            // Без прав (SELinux не даёт даже stat) — скажем один раз, а не будем молча пропускать вечно
            const st = await fsp.stat(file).catch((e) => {
                if (denied(e) && !this.warned.has(file)) {
                    console.warn(`[Входящие] ${path.basename(file)}`, denied(e));
                    this.warned.add(file);
                }
                return null;
            });
            if (!st) continue;
            const prev = this.seen.get(file);
            this.seen.set(file, { size: st.size, mtime: st.mtimeMs });
            const settled = prev && prev.size === st.size && prev.mtime === st.mtimeMs && now - st.mtimeMs >= SETTLE_MS;
            if (VOLUME.test(file)) {
                if (!sets.has(setOf(file))) sets.set(setOf(file), []);
                sets.get(setOf(file)).push({ file, settled, mtime: st.mtimeMs });
                continue;
            }
            if (!settled) continue;
            this.seen.delete(file);
            await this.take([file]);
        }
        for (const [set, parts] of sets) if (await this.complete(set, parts, now)) await this.take(parts.map((p) => p.file).sort((a, b) => volume(a) - volume(b)));
        for (const file of this.seen.keys()) if (!present.has(file)) this.seen.delete(file);
    }

    // Архив томами лёг весь: каждый том улёгся, номера подряд с первого, ни один не докачивается (у JDownloader —
    // «….partN.rar.part», у seedbox — «.….partN.rar.<код>.seedbox») и нет тех, что эта загрузка ещё качает
    async complete(set, parts, now) {
        if (!parts.every((p) => p.settled)) return false;
        const nums = parts.map((p) => volume(p.file)).sort((a, b) => a - b);
        if (nums.some((n, i) => n !== i + 1)) return false;
        const unfinished = (n) => n.replace(/^\./, '').replace(/\.part$|\.[0-9a-f]{8}\.seedbox$/i, '');
        const loading = (await fsp.readdir(path.dirname(set)).catch(() => []))
            .some((n) => unfinished(n) !== n && VOLUME.test(unfinished(n)) && setOf(unfinished(n)) === path.basename(set));
        if (loading) return false;
        const first = path.basename(parts.find((p) => volume(p.file) === 1).file);
        const want = this.volumesOf ? await this.volumesOf(first).catch(() => []) : [];
        if (!want.length) return parts.every((p) => now - p.mtime >= LOOSE_SETTLE_MS);
        const have = new Set(parts.map((p) => path.basename(p.file).normalize('NFC')));
        return want.every((n) => have.has(n.normalize('NFC')));
    }

    // Архив (или все его тома, первый — первым) — в библиотеку
    async take(files) {
        for (const f of files) this.seen.delete(f);
        const name = path.basename(files[0]);
        const hit = this.targetOf ? await this.targetOf(name).catch(() => null) : null;
        await this.uploads.importFile(files.length > 1 ? files : files[0], hit ? { target: hit.target || '', version: hit.version || '', passwords: hit.passwords || [] } : {})
            .catch((e) => console.error(`[Входящие] ${name}:`, e.message, denied(e)));
    }

    start() {
        const run = () => this.scan().catch((e) => console.error('[Входящие]', e.message));
        setInterval(run, EVERY_MS).unref();
        run();
    }
}

module.exports = new InboxService();
module.exports.InboxService = InboxService;
module.exports.ARCHIVE = ARCHIVE;
module.exports.VOLUME = VOLUME;
module.exports.setOf = setOf;
