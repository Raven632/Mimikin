// Машинный перевод игр RPG Maker MV/MZ — «как MTool», но на сервере: на любом устройстве и без правки игры.
// Текст берём из data/*.json (utils/gametext.js — что переводить и что защищено), переводим через службы
// со своими ключами из «Настроек», храним в базе (таблица translations: оригинал → перевод, общий для всех
// игр — одинаковые строки переводятся один раз), а подставляем на лету, когда сервер игр отдаёт файл
// (overlay). Выключили перевод — игра снова оригинальная: на диске она не менялась.
//
// Службы — по порядку качества; у каждой месячный бесплатный лимит (знаки оригинала). Лимит кончился —
// дальше следующая, до начала месяца эта не спрашивается:
//   deepl     — DeepL API Free: 500 тыс. знаков (ключ с «:fx»), Pro — без лимита
//   microsoft — Microsoft Translator F0: 2 млн
//   google    — Google Cloud Translation: 500 тыс. (кредит $10 в месяц)
//   libre     — LibreTranslate на своём сервере: без лимита, японский слабее
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const path = require('path');
const { secret } = require('../utils/secrets.js');
const { eachShown, codeStrings, makeGuard, protect, restore, pluginTexts, overlayPlugins, displayText, pluginParamTypes, pluginLiterals, pluginDisplayTexts, pluginTemplates, numberTemplate, numbersBack } = require('../utils/gametext.js');
const { termOf, norm, TERMS } = require('../utils/glossary.js');
const { TermLibrary } = require('./termlib.js');
const { decodeEntities } = require('../utils/html.js');
const { checkGame, layoutOf } = require('../utils/tlcheck.js');

const LANGS = ['en', 'ru', 'de'];
const ENGINES = ['deepl', 'microsoft', 'google', 'libre'];
// Сколько строк и знаков за один запрос: у служб свои пределы (DeepL — 50 строк, Google — 128)
const BATCH = { deepl: { lines: 50, chars: 30000 }, microsoft: { lines: 100, chars: 45000 }, google: { lines: 100, chars: 25000 }, libre: { lines: 40, chars: 20000 } };
const TIMEOUT_MS = 60 * 1000;
// Бесплатный лимит служб в месяц (знаки) — для вопроса «перевести?»: сколько останется. LibreTranslate — без лимита
const FREE = { deepl: 500000, microsoft: 2000000, google: 500000, libre: 0 };
// В ответе проверки — не больше стольких мест (всего — в counts)
const CHECK_LIMIT = 200;

const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
// Текст для служб — с экранированными &, < и >: они читают его как XML/HTML, а метки кодов — теги
const escape = (s) => s.replace(/&/g, '&amp;').replace(/<(?!x i="\d+"\/>)/g, '&lt;').replace(/(?<!<x i="\d+"\/)>/g, '&gt;');

class QuotaError extends Error {}

const parseJson = (s) => { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } };

const deeplHost = (key) => (key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');

// Глоссарии DeepL: на время перевода одной игры. Создать и удалить — бесплатно, знаки не тратятся
const glossaries = {
    async create(key, source, target, entries) {
        const res = await fetch(`${deeplHost(key)}/v2/glossaries`, {
            method: 'POST',
            headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'mimikin', source_lang: source, target_lang: target, entries: entries.map(([a, b]) => `${a}\t${b}`).join('\n'), entries_format: 'tsv' }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`DeepL: глоссарий не создан (${res.status})`);
        return (await res.json()).glossary_id;
    },
    // Наши глоссарии (остались, если сервер упал посреди перевода)
    async list(key) {
        const res = await fetch(`${deeplHost(key)}/v2/glossaries`, { headers: { Authorization: `DeepL-Auth-Key ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return [];
        return ((await res.json()).glossaries || []).filter((g) => g.name === 'mimikin').map((g) => g.glossary_id);
    },
    async remove(key, id) {
        await fetch(`${deeplHost(key)}/v2/glossaries/${encodeURIComponent(id)}`, {
            method: 'DELETE', headers: { Authorization: `DeepL-Auth-Key ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    },
};

// Что идёт в глоссарий DeepL кроме имён: характеристики, уровень, опыт. Короткие общие слова («水», «光»,
// «攻撃») — нет: в японском нет пробелов, и DeepL подменил бы их внутри других слов («水着» — «Вода…»)
const GLOSSARY_TERMS = ['最大HP', '最大MP', '攻撃力', '防御力', '魔法力', '魔法攻撃', '魔法防御', '敏捷性', '命中率', '回避率', 'レベル', '経験値'];
const KANA = /[\p{sc=Hiragana}\p{sc=Katakana}]/u;
const HAN = /\p{sc=Han}/u;
const CJK_LINE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;

// Язык оригинала игры для глоссария: японский — если хотя бы у 5% строк есть кана, китайский — иероглифы
// без каны. Иначе (английская игра) — без глоссария
function sourceOf(strings) {
    const n = Math.max(1, strings.length);
    if (strings.filter((s) => KANA.test(s)).length / n >= 0.05) return 'ja';
    if (strings.filter((s) => HAN.test(s)).length / n >= 0.05) return 'zh';
    return null;
}

// Имена файлов игры без расширения (img/, audio/, movies/ — две папки вглубь): строка, равная имени файла,
// — ссылка на картинку или звук, перевод её сломал бы
// Имя — и само по себе («クリック音１»), и с подпапками от папки вида, как его пишут игра и плагины
// («arina/other/クリック音１» в audio/se/arina/other). Глубина — до шести папок
async function fileNames(root) {
    const out = [];
    const walk = async (dir, depth, rel) => {
        for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (e.isDirectory()) {
                if (depth < 6) await walk(path.join(dir, e.name), depth + 1, depth >= 1 ? [...rel, e.name] : rel);
                continue;
            }
            const stem = e.name.replace(/\.[^.]+$/, '').replace(/\.[^.]+$/, '');
            out.push(stem);
            if (rel.length) out.push([...rel, stem].join('/'));
        }
    };
    for (const sub of ['img', 'audio', 'movies']) await walk(path.join(root, sub), 0, []);
    return out;
}

// Разметки картинок с нарисованными подписями (api/src/data/image-labels/*.json): какой файл (по пути и хэшу
// содержимого — обновлённая картинка автора разметку уже не получит), где на нём какие подписи и каким стилем.
// Подписи переводятся словарём игры, а перерисовывает их сама игра при загрузке картинки (rpg-fixes) — файл
// на диске не меняется. Зашифрованные картинки (.png_, .rpgmvp) — другие байты: к ним разметка не применяется
const LABELS_DIR = path.join(__dirname, '..', 'data', 'image-labels');
let labelSets = null;
function imageLabelSets() {
    if (labelSets) return labelSets;
    labelSets = [];
    for (const f of (() => { try { return fs.readdirSync(LABELS_DIR); } catch (e) { return []; } })()) {
        if (!f.endsWith('.json')) continue;
        try {
            const set = JSON.parse(fs.readFileSync(path.join(LABELS_DIR, f), 'utf8'));
            if (set.file && set.sha1 && Array.isArray(set.labels)) labelSets.push(set);
        } catch (e) { console.warn(`[Перевод] разметка картинки ${f} не читается:`, e.message); }
    }
    return labelSets;
}

// Разметки, подходящие к этой игре: файл на месте, тот же размер (хэш считаем только тогда) и тот же хэш.
// sets — разметки (по умолчанию из api/src/data/image-labels; тесты подставляют свои)
async function imageLabelsOf(root, sets = imageLabelSets()) {
    const out = [];
    for (const set of sets) {
        const file = path.join(root, ...String(set.file).split('/'));
        if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) continue;
        const st = await fsp.stat(file).catch(() => null);
        if (!st?.isFile() || (set.size && st.size !== set.size)) continue;
        const buf = await fsp.readFile(file).catch(() => null);
        if (!buf || crypto.createHash('sha1').update(buf).digest('hex') !== set.sha1) continue;
        out.push({ path: set.file.replace(/\.[^./]+$/, ''), style: set.style || {}, labels: set.labels });
    }
    return out;
}

// Плагины игры: Map(имя, как в js/plugins.js, — «トリアコンタン/MessageSpeedCustomize» → исходник). Подпапки — тоже
async function pluginSources(dir) {
    const out = new Map();
    const walk = async (d, rel, depth) => {
        for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
            if (e.isDirectory() && depth < 3) await walk(path.join(d, e.name), [...rel, e.name], depth + 1);
            else if (e.isFile() && e.name.endsWith('.js')) out.set([...rel, e.name.slice(0, -3)].join('/'), await fsp.readFile(path.join(d, e.name), 'utf8').catch(() => ''));
        }
    };
    await walk(dir, [], 0);
    return out;
}

// Запрос к службе: список строк → список переводов того же размера. Бросает QuotaError, когда лимит
// месяца кончился, обычную ошибку — когда служба не ответила или отказала
const engines = {
    // opts.glossary — глоссарий DeepL (имена героев и характеристики игры); с ним DeepL требует язык оригинала
    async deepl(texts, lang, key, opts = {}) {
        const res = await fetch(`${deeplHost(key)}/v2/translate`, {
            method: 'POST',
            headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: texts, target_lang: { en: 'EN-US', ru: 'RU', de: 'DE' }[lang], tag_handling: 'xml', ignore_tags: ['x'],
                ...(opts.glossary ? { glossary_id: opts.glossary, source_lang: opts.source.toUpperCase() } : {}),
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 456) throw new QuotaError('DeepL: лимит месяца исчерпан');
        if (!res.ok) throw new Error(`DeepL ответил ${res.status}`);
        return (await res.json()).translations.map((x) => x.text);
    },
    async microsoft(texts, lang, value) {
        const [key, region] = value.split('|');
        const res = await fetch(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${lang}&textType=html`, {
            method: 'POST',
            headers: { 'Ocp-Apim-Subscription-Key': key, ...(region ? { 'Ocp-Apim-Subscription-Region': region } : {}), 'Content-Type': 'application/json' },
            body: JSON.stringify(texts.map((Text) => ({ Text }))),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Лимит бесплатного уровня — 403 с кодом 4030xx; другой 403 — что-то с ресурсом, а 429 — «слишком
        // часто»: это не лимит месяца, а повод повторить через паузу
        if (res.status === 403) {
            const body = await res.json().catch(() => ({}));
            if (String(body?.error?.code).startsWith('4030')) throw new QuotaError('Microsoft: лимит исчерпан');
        }
        if (!res.ok) throw new Error(`Microsoft ответил ${res.status}`);
        return (await res.json()).map((x) => x.translations[0].text);
    },
    async google(texts, lang, key) {
        const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: texts, target: lang, format: 'html' }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Лимит — RESOURCE_EXHAUSTED или причина «…LimitExceeded»; другой 403 (API выключен, нет оплаты) — ошибка
        if (res.status === 403 || res.status === 429) {
            const body = await res.json().catch(() => ({}));
            const reason = body?.error?.errors?.[0]?.reason || '';
            if (body?.error?.status === 'RESOURCE_EXHAUSTED' || /LimitExceeded|quotaExceeded/i.test(reason)) throw new QuotaError('Google: лимит исчерпан');
            throw new Error(`Google ответил ${res.status}${reason ? ` (${reason})` : ''}`);
        }
        if (!res.ok) throw new Error(`Google ответил ${res.status}`);
        return (await res.json()).data.translations.map((x) => x.translatedText);
    },
    async libre(texts, lang, value) {
        const [url, apiKey] = value.split('|');
        const res = await fetch(`${url.replace(/\/+$/, '')}/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: texts, source: 'auto', target: lang, format: 'html', ...(apiKey ? { api_key: apiKey } : {}) }),
            signal: AbortSignal.timeout(TIMEOUT_MS * 5),
        });
        if (!res.ok) throw new Error(`LibreTranslate ответил ${res.status}`);
        const data = await res.json();
        return Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText];
    },
};

class TranslateService {
    constructor() {
        this.dbService = null;
        this.gamesDir = '';
        this.engines = engines;
        this.queue = [];             // игры, ждущие перевода: { id, lang }
        this.current = null;         // { id, lang, done, total, failed, engine, stop }
        this.cache = new Map();      // игра → { at, strings, guard } — разобранный текст
        this.pending = new Map();    // игра → разбор, который идёт сейчас
        this.dictPending = new Map();
        this.writeLock = Promise.resolve();
        this.version = 0;            // растёт с каждой записью перевода: подстановка перечитывает словарь
        this.dicts = new Map();      // `${игра}\n${язык}` → { version, map }
        this.onChange = () => {};
        this.retryMs = 5000;
        this.glossaries = glossaries;
        this.terms = new TermLibrary();  // термины из переведённых игр библиотеки (services/termlib.js)
        this.FREE = FREE;
        this.quota = null;               // services/quota.js — настоящий остаток DeepL для вопроса «перевести?»
        this.pictures = null;            // services/pictures.js — подписи, найденные на картинках игры
    }

    setDependencies({ dbService, gamesDir, onChange }) {
        Object.assign(this, { dbService, gamesDir });
        this.terms.setDir(gamesDir);
        if (onChange) this.onChange = onChange;
    }

    db() { return this.dbService.get(); }

    // Много строк в словарь — одной транзакцией на пачку: по одной десятки тысяч строк игры писались бы
    // минуты. Сбой посередине — записанное до него остаётся (COMMIT), а не откатывается вместе с чужими
    // записями, которые сервер успел сделать в это время
    // Записи — по очереди (writeLock): импорт во время перевода начал бы вторую транзакцию поверх первой
    writeMany(sql, rows) {
        const run = this.writeLock.then(async () => {
            let changes = 0;
            for (let i = 0; i < rows.length; i += 1000) {
                await this.db().exec('BEGIN');
                try {
                    for (const r of rows.slice(i, i + 1000)) changes += (await this.db().run(sql, r))?.changes || 0;
                } finally {
                    await this.db().exec('COMMIT');
                }
            }
            return changes;
        });
        this.writeLock = run.catch(() => {});
        return run;
    }

    // После перезапуска сервера: перевод, который шёл, продолжаем; в базе он остался бы «идёт» навсегда
    async recover() {
        const rows = await this.db().all("SELECT id, lang FROM game_translation WHERE state IN ('running', 'queued') AND lang != ''");
        await this.db().run("UPDATE game_translation SET state = 'paused' WHERE state IN ('running', 'queued')");
        // Глоссарии DeepL, оставшиеся от перевода, который оборвался, — убрать (у DeepL их число ограничено)
        if (secret('deepl')) {
            this.glossaries.list(secret('deepl')).then((ids) => Promise.all(ids.map((g) => this.glossaries.remove(secret('deepl'), g))))
                .catch(() => {});
        }
        for (const { id, lang } of rows) this.enqueue(id, lang);
    }

    // Новый ключ службы — прежняя отметка «лимит исчерпан» к нему не относится. И строки, которые раньше
    // не вышли (перевод портил коды), — пусть новая служба попробует их ещё раз
    async clearExhausted(engine) {
        await this.db().run('DELETE FROM settings WHERE key = ?', [`tl_exhausted_${engine}`]);
        await this.db().run("DELETE FROM translations WHERE origin = 'failed'");
    }

    // Папка data/ игры: в корне или в www/. Нет — переводить нечего (не MV/MZ)
    async dataDir(id) {
        for (const dir of [path.join(this.gamesDir, id, 'www', 'data'), path.join(this.gamesDir, id, 'data')]) {
            if (await fsp.stat(path.join(dir, 'System.json')).then((s) => s.isFile(), () => false)) return dir;
        }
        return null;
    }

    // Текст игры: все видимые строки без защищённых и защита (guard) для подстановки. На 10 минут: игра
    // просит десятки файлов подряд, а разбор всех — секунды
    // Игра при старте просит десятки файлов разом — разбираем один раз на всех (pending). В памяти — не
    // больше нескольких игр
    async gameText(id, now = Date.now()) {
        const hit = this.cache.get(id);
        if (hit && now - hit.at < 10 * 60 * 1000) return hit;
        if (!this.pending.has(id)) this.pending.set(id, this.readGameText(id, now).finally(() => this.pending.delete(id)));
        return this.pending.get(id);
    }

    async readGameText(id, now) {
        const dir = await this.dataDir(id);
        if (!dir) return null;
        const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
        const parsed = [];
        const code = [];
        for (const f of files) {
            try {
                const data = JSON.parse((await fsp.readFile(path.join(dir, f), 'utf8')).replace(/^﻿/, ''));
                parsed.push([f.slice(0, -5), data]);
                codeStrings(f.slice(0, -5), data, code);
            } catch (e) {
                // Не JSON (зашифрованные данные некоторых сборок) — такой файл не переводим
            }
        }
        // Код плагинов: их параметры и сами файлы — сравнения с именами и тексты бывают и там
        const js = path.join(dir, '..', 'js');
        const plugins = await fsp.readFile(path.join(js, 'plugins.js'), 'utf8').catch(() => '');
        const sources = await pluginSources(path.join(js, 'plugins'));
        const pluginFiles = [...sources.values()];
        // Типы параметров из шапок плагинов: файл, число, переключатель — не текст (gametext, pluginParamTypes)
        const types = new Map([...sources].map(([name, src]) => [name, pluginParamTypes(src)]));
        const guard = makeGuard({ scripts: code, plugins, pluginFiles, types, exempt: (s) => !!termOf(s, 'en') });
        // Параметр плагина, равный имени файла игры, — ссылка на картинку или звук: его не переводим. Реплику
        // или предмет с тем же текстом («光» и картинка 光.png) — переводим: файлы они не называют
        const fileSet = new Set(await fileNames(path.join(dir, '..')));
        const strings = new Set();
        // Что игра показывает, но менять в файлах нельзя: защищённое (с ним сравнивает код) и строки из кода
        // плагинов. Их переводим тоже, но подставляем только на экране (displayDict → rpg-fixes)
        const extra = new Set();
        // Что игра кладёт в сохранение: строки переменных (скрипт в «変数の操作») и имена, прозвища, описания героев.
        // Сохранение, сделанное до перевода, держит их по-японски, а события, которые их пишут, уже прошли —
        // rpg-fixes подменяет их при загрузке тем же переводом (displayDict → saved)
        const saved = { vars: new Set(), actors: new Set() };
        for (const [name, data] of parsed) {
            eachShown(name, data, (s, set, kind) => {
                if (guard(s)) { extra.add(s); return; }
                strings.add(s);
                if (kind === 'variable') saved.vars.add(s);
                else if (kind === 'Actors') saved.actors.add(s);
            });
        }
        // Подписи и подсказки из параметров плагинов (меню, магазин, окна) — тоже текст игры
        for (const s of pluginTexts(plugins, types)) if (!guard(s) && !fileSet.has(s)) strings.add(s);
        // Строки из кода плагинов — на экран всегда, даже если такая же есть в данных игры: файл переведён,
        // а плагин рисует свою копию («装備» вкладкой своего меню)
        for (const src of pluginFiles) {
            for (const s of pluginLiterals(src)) if (!fileSet.has(s)) extra.add(s);
            for (const s of pluginTemplates(src)) extra.add(s);
        }
        for (const s of pluginDisplayTexts(plugins, types)) if (!fileSet.has(s)) extra.add(s);
        // Подписи на картинках с разметкой — тоже текст для экрана. Ручная разметка (data/image-labels) и найденное
        // распознаванием (services/pictures.js); у картинки с ручной разметкой — только она
        const images = await imageLabelsOf(path.join(dir, '..'), this.labelSets || undefined);
        const marked = new Set(images.map((im) => im.path.toLowerCase()));
        for (const im of this.pictures ? await this.pictures.forGame(id).catch(() => []) : []) {
            if (!marked.has(String(im.path).toLowerCase())) images.push(im);
        }
        const pictureTexts = new Set();
        for (const im of images) {
            for (const l of im.labels) {
                if (typeof l.text === 'string' && l.text) { extra.add(l.text); pictureTexts.add(l.text); }
            }
        }
        // Имена героев — для глоссария DeepL: переводятся первыми, дальше — одинаково везде. Только из Actors и
        // не короче двух знаков: «光» или «少女» глоссарий подменил бы и внутри других слов
        const names = new Set();
        for (const [name, data] of parsed) {
            if (name !== 'Actors' || !Array.isArray(data)) continue;
            for (const a of data) if (typeof a?.name === 'string' && [...a.name.trim()].length >= 2 && strings.has(a.name)) names.add(a.name);
        }
        const display = [...extra].filter((s) => !fileSet.has(s)).slice(0, 20000);
        // all — всё, что переводится: строки файлов и строки только для экрана
        const all = [...new Set([...strings, ...display])];
        const entry = {
            at: now, strings: [...strings], display, all, guard, types, files: fileSet, names: [...names].slice(0, 300), images,
            pictureTexts: [...pictureTexts],
            // Лимит — чтобы mimikin-tl.json не разрастался: у обычной игры таких строк десятки, сверх него — японские
            saved: { vars: [...saved.vars].slice(0, 5000), actors: [...saved.actors].slice(0, 2000) },
        };
        this.cache.set(id, entry);
        while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
        return entry;
    }

    // Состояние перевода игры — для окна игры
    async status(id) {
        const row = await this.db().get('SELECT * FROM game_translation WHERE id = ?', [id]);
        const running = this.current?.id === id ? this.current : null;
        const queued = this.queue.some((q) => q.id === id);
        let state = running ? 'running' : queued ? 'queued' : row?.state || '';
        let total = running ? running.total : row?.total || 0;
        // Переведено раньше, а строк в игре теперь больше (обновление игры, новые виды текста) — не «готово»,
        // а «на паузе»: «Продолжить» переведёт новое
        if (state === 'done' && row?.lang) {
            const text = await this.gameText(id).catch(() => null);
            if (text && text.all.length > total) { state = 'paused'; total = text.all.length; }
        }
        return {
            lang: row?.lang || '',
            state,
            done: running ? running.done : row?.done || 0,
            total,
            failed: running ? running.failed : row?.failed || 0,
            engine: running ? running.engine : row?.engine || '',
            error: row?.error || '',
            engines: this.availableEngines(),
            gameErrors: row?.lang ? await this.errorsSince(id, Math.max(row.at || 0, row.check_at || 0)) : [],
            check: row?.check_at ? { at: row.check_at, ...parseJson(row.check_result) } : null,
        };
    }

    // Итог проверки в браузере (rpg-fixes, setupSelfTest): { ok, steps, errors }. Только для включённого перевода
    async saveCheck(id, result) {
        const lang = await this.langOf(id);
        if (!lang) throw Object.assign(new Error('Перевод не включён'), { status: 409 });
        const clip = (x, n) => String(x || '').slice(0, n);
        const clean = {
            lang,
            ok: !!result?.ok,
            steps: (Array.isArray(result?.steps) ? result.steps : []).slice(0, 10).map((x) => ({ name: clip(x?.name, 20), ok: !!x?.ok })),
            errors: (Array.isArray(result?.errors) ? result.errors : []).slice(0, 20).map((x) => ({ kind: clip(x?.kind, 20), message: clip(x?.message, 300), source: clip(x?.source, 300) })),
        };
        await this.db().run('UPDATE game_translation SET check_at = ?, check_result = ? WHERE id = ?', [Date.now(), JSON.stringify(clean), id]);
        return this.status(id);
    }

    // Ошибки игры с тех пор, как включили перевод (журнал services/gameErrors.js): «Failed to load» и сбои кода.
    // Окно игры предлагает выключить перевод. Таблицы журнала нет (тесты) — ошибок нет
    async errorsSince(id, since) {
        try {
            const rows = await this.db().all(
                'SELECT kind, message, source, last_at AS at, count FROM game_errors WHERE game = ? AND first_at > ? ORDER BY last_at DESC LIMIT 3',
                [id, since]);
            return rows.map((r) => ({ kind: r.kind, message: r.message, source: r.source, at: r.at, count: r.count }));
        } catch (e) {
            return [];
        }
    }

    availableEngines() {
        return ENGINES.filter((e) => secret(e));
    }

    // Включить перевод на язык (и поставить игру в очередь перевода) или выключить (lang '')
    async setLang(id, lang) {
        if (lang && !LANGS.includes(lang)) throw Object.assign(new Error('Такого языка нет'), { status: 400 });
        await this.db().run(`INSERT INTO game_translation (id, lang, at) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET lang = excluded.lang, at = excluded.at, check_at = 0, check_result = ''`, [id, lang, Date.now()]);
        // Выключили или сменили язык — перевод на прежний не тратит лимит дальше
        this.queue = this.queue.filter((q) => q.id !== id || q.lang === lang);
        if (this.current?.id === id && this.current.lang !== lang) this.current.stop = true;
        this.onChange(id);
        if (lang) this.enqueue(id, lang);
        return this.status(id);
    }

    // Перевести строки игры, которых ещё нет в словаре. Очередь — по одной игре
    // redo — «перевести заново»: 'all' или список строк; машинный перевод этих строк отправляется ещё раз
    enqueue(id, lang, redo = null) {
        if (this.current?.id === id && this.current.lang === lang) {
            if (!redo) return;
            this.current.stop = true;                     // идущий перевод — на остановку, заново — следом
        }
        // Уже ждёт «перевести заново» того же языка — не теряем: обычный запуск поверх него его сохраняет
        const waiting = this.queue.find((q) => q.id === id && q.lang === lang && q.redo);
        let merged = redo;
        if (waiting) {
            merged = waiting.redo === 'all' || redo === 'all' ? 'all' : [...new Set([...waiting.redo, ...(redo || [])])];
        }
        this.queue = this.queue.filter((q) => q.id !== id);
        this.queue.push({ id, lang, redo: merged });
        if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
    }

    // «Пауза»: идущий перевод останавливается после текущей пачки, сделанное остаётся
    async pause(id) {
        this.queue = this.queue.filter((q) => q.id !== id);
        if (this.current?.id === id) this.current.stop = true;
        await this.db().run("UPDATE game_translation SET state = 'paused' WHERE id = ?", [id]);
    }

    async drain() {
        while (this.queue.length) {
            const { id, lang, redo } = this.queue.shift();
            // Сразу «идёт»: пока разбирается игра, окно игры не должно видеть прежнее состояние из базы
            this.current = { id, lang, done: 0, total: 0, failed: 0, engine: '', stop: false };
            await this.translateGame(id, lang, redo).catch((e) => console.error(`[Перевод] ${id}:`, e.message));
            // Игра без данных или ошибка до начала — «идёт» не должно остаться
            if (this.current?.id === id) this.current = null;
        }
    }

    async usage(engine, now = Date.now()) {
        const row = await this.db().get('SELECT value FROM settings WHERE key = ?', [`tl_used_${engine}_${month(now)}`]);
        return Number(row?.value || 0);
    }

    async addUsage(engine, chars, now = Date.now()) {
        await this.db().run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?`,
            [`tl_used_${engine}_${month(now)}`, String(chars), chars]);
    }

    async usageReport(now = Date.now()) {
        const out = {};
        for (const engine of ENGINES) out[engine] = { used: await this.usage(engine, now), exhausted: await this.exhausted(engine, now) };
        return out;
    }

    async exhausted(engine, now = Date.now()) {
        const row = await this.db().get('SELECT value FROM settings WHERE key = ?', [`tl_exhausted_${engine}`]);
        return row?.value === month(now);
    }

    async translateGame(id, lang, redo = null, now = () => Date.now()) {
        const text = await this.gameText(id);
        const save = (fields) => {
            const keys = Object.keys(fields);
            return this.db().run(`UPDATE game_translation SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
        };
        if (!text) {
            await save({ state: 'error', error: 'no-data' });
            return;
        }
        await this.applyTerms(text.all, lang);
        // Уже переведённое — из словаря; не вышедшее раньше (отметка «failed») снова не шлём: лимит не резиновый
        const known = await this.dictionary(id, lang, { fresh: true });
        const tried = await this.failedOf(text.all, lang);
        // «Перевести заново»: эти строки — снова в службу, кроме своего перевода из файла и стандартных слов
        const again = await this.redoSet(text.all, lang, redo);
        // Шаблоны, переведённые раньше с метками («%1 / Day 30: %2»), — один раз заново, уже с числами
        const tplFlag = `tl_numbers_v1_${lang}_${id}`;
        const tplDone = await this.db().get('SELECT value FROM settings WHERE key = ?', [tplFlag]).catch(() => null);
        if (!tplDone) for (const s of await this.redoSet(text.all.filter((x) => /%\d/.test(x)), lang, text.all.filter((x) => /%\d/.test(x)))) again.add(s);
        const left = text.all.filter((s) => again.has(s) || (!known.has(s) && !tried.has(s)));
        // Имена — первыми и отдельной пачкой: их перевод идёт в глоссарий DeepL для всего остального
        const nameSet = new Set(text.names || []);
        const todo = [...left.filter((s) => nameSet.has(s)), ...left.filter((s) => !nameSet.has(s))];
        const namesFirst = todo.filter((s) => nameSet.has(s)).length;
        const source = sourceOf(text.strings);
        let glossary = null;
        let glossaryTried = false;
        const tagged = new Set();        // шаблоны, у которых числа не вернулись: второй раз — с метками
        // Пока разбирали, перевод могли выключить или поставить на паузу (stop у прежней записи)
        const stopped = this.current?.id === id && this.current.lang === lang && this.current.stop;
        const job = { id, lang, done: text.all.length - todo.length, total: text.all.length, failed: 0, engine: '', stop: stopped };
        this.current = job;
        await save({ state: 'running', done: job.done, total: job.total, failed: 0, error: '' });
        try {
            let i = 0;
            let fails = 0;
            while (i < todo.length && !job.stop) {
                const engine = await this.pickEngine();
                if (!engine) {
                    await save({ state: 'error', error: this.availableEngines().length ? 'quota' : 'no-engine', done: job.done, failed: job.failed });
                    return;
                }
                job.engine = engine;
                // Имена переведены — глоссарий DeepL из них и характеристик (один раз; не вышел — без него)
                if (engine === 'deepl' && source && !glossaryTried && i >= namesFirst) {
                    glossaryTried = true;
                    glossary = await this.makeGlossary(id, text, lang, source).catch((e) => {
                        console.warn(`[Перевод] ${id}: ${e.message} — дальше без глоссария`);
                        return null;
                    });
                }
                const limit = BATCH[engine];
                const batch = [];
                let chars = 0;
                while (i < todo.length && batch.length < limit.lines && chars + todo[i].length <= limit.chars && !(i === namesFirst && batch.length)) {
                    chars += todo[i].length;
                    batch.push(todo[i++]);
                }
                if (!batch.length) batch.push(todo[i++]);       // одна строка длиннее предела — отдельно
                // Шаблон — с числами вместо %1 (если уже не вышло так — с метками)
                const prepared = batch.map((s) => {
                    const nt = tagged.has(s) ? null : numberTemplate(s);
                    return { ...protect(nt ? nt.text : s), nt };
                });
                let out;
                try {
                    out = await this.send(engine, batch, prepared.map((p) => escape(p.text)), lang, engine === 'deepl' && glossary ? { glossary, source } : null);
                } catch (e) {
                    i -= batch.length;                            // эту пачку — следующей службой
                    // DeepL отказал в запросе с глоссарием (не лимит) — дальше без глоссария, перевод не встаёт
                    if (glossary && engine === 'deepl' && !(e instanceof QuotaError)) {
                        console.warn(`[Перевод] ${id}: ${e.message} с глоссарием — дальше без него`);
                        await this.glossaries.remove(secret('deepl'), glossary).catch(() => {});
                        glossary = null;
                        continue;
                    }
                    if (e instanceof QuotaError) {
                        await this.db().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`tl_exhausted_${engine}`, month(now())]);
                        console.warn(`[Перевод] ${e.message} — дальше следующая служба`);
                        continue;
                    }
                    // Сеть моргнула или служба ответила ошибкой — ещё два раза с паузой, потом стоп
                    // (сделанное остаётся: «Продолжить» начнёт с непереведённого)
                    if (++fails >= 3) throw e;
                    await new Promise((r) => setTimeout(r, this.retryMs));
                    continue;
                }
                fails = 0;
                const rows = [];
                const failed = [];
                let retried = 0;
                batch.forEach((src, k) => {
                    let restored = restore(decodeEntities(String(out[k] ?? '')).replace(/&lt;/g, '<').replace(/&gt;/g, '>'), prepared[k].codes);
                    if (restored !== null && prepared[k].nt) restored = numbersBack(restored, prepared[k].nt);
                    // Числа шаблона потерялись — ещё раз этой же строкой, но с метками
                    if (restored === null && prepared[k].nt) {
                        tagged.add(src);
                        todo.push(src);
                        retried++;
                        return;
                    }
                    // Коды потерялись или перевод пустой — строка остаётся оригинальной: лучше по-японски, чем сломанной
                    if (restored === null || !restored.trim()) {
                        job.failed++;
                        failed.push([src, lang, '', engine, now()]);
                    } else rows.push([src, lang, restored, engine, now()]);
                });
                if (failed.length) {
                    await this.writeMany(`INSERT INTO translations (src, lang, text, engine, origin, at) VALUES (?, ?, ?, ?, 'failed', ?)
                        ON CONFLICT(src, lang) DO NOTHING`, failed);
                }
                await this.writeMany(`INSERT INTO translations (src, lang, text, engine, origin, at) VALUES (?, ?, ?, ?, 'machine', ?)
                    ON CONFLICT(src, lang) DO UPDATE SET text = excluded.text, engine = excluded.engine, origin = 'machine', at = excluded.at
                    WHERE translations.origin IN ('machine', 'failed')`, rows);
                this.version++;
                job.done += batch.length - retried;
                await save({ done: job.done, failed: job.failed, engine });
            }
            await save({ state: job.stop ? 'paused' : 'done', done: job.done, failed: job.failed });
            if (!job.stop && !tplDone) await this.db().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [tplFlag, '1']).catch(() => {});
            console.log(`[Перевод] ${id} → ${lang}: ${job.done} из ${job.total}${job.failed ? `, не вышло: ${job.failed}` : ''}`);
        } catch (e) {
            await save({ state: 'error', error: String(e.message).slice(0, 200), done: job.done, failed: job.failed });
            throw e;
        } finally {
            this.current = null;
            this.onChange(id);
            if (glossary) await this.glossaries.remove(secret('deepl'), glossary).catch(() => {});
        }
    }

    // Пачка — в службу. С глоссарием DeepL переводит строки с японским (китайским) — у них язык оригинала
    // известен; строки без иероглифов и каны (английские вставки) — отдельным запросом, без глоссария
    // Знаки — в счётчик месяца после каждого ответа службы: при двух запросах на пачку первый уже оплачен,
    // даже если второй не прошёл
    async send(engine, batch, texts, lang, opts) {
        const charsOf = (ks) => ks.reduce((n, k) => n + batch[k].length, 0);
        const all = batch.map((_, k) => k);
        if (!opts) {
            const out = await this.engines[engine](texts, lang, secret(engine));
            await this.addUsage(engine, charsOf(all));
            return out;
        }
        const withG = [];
        const without = [];
        batch.forEach((s, k) => (CJK_LINE.test(s) ? withG : without).push(k));
        const out = new Array(texts.length);
        if (withG.length) {
            (await this.engines[engine](withG.map((k) => texts[k]), lang, secret(engine), opts)).forEach((t, j) => { out[withG[j]] = t; });
            await this.addUsage(engine, charsOf(withG));
        }
        if (without.length) {
            (await this.engines[engine](without.map((k) => texts[k]), lang, secret(engine))).forEach((t, j) => { out[without[j]] = t; });
            await this.addUsage(engine, charsOf(without));
        }
        return out;
    }

    // Строки, которые «перевести заново» отправит в службу: 'all' — все строки игры, массив — эти (только
    // строки игры). Свой перевод из файла (import) и стандартные слова (glossary) — не трогаем
    async redoSet(strings, lang, redo) {
        if (!redo) return new Set();
        const own = new Set(strings);
        const wanted = redo === 'all' ? strings : (Array.isArray(redo) ? redo : []).filter((s) => own.has(s));
        const kept = new Set();
        for (let i = 0; i < wanted.length; i += 500) {
            const part = wanted.slice(i, i + 500);
            const rows = await this.db().all(`SELECT src FROM translations WHERE lang = ? AND origin IN ('import', 'glossary') AND src IN (${part.map(() => '?').join(',')})`, [lang, ...part]);
            for (const r of rows) kept.add(r.src);
        }
        return new Set(wanted.filter((s) => !kept.has(s)));
    }

    // «Перевести заново»: всю игру (lines не задан) или выбранные строки. Перевод должен быть включён
    async redo(id, lines = null) {
        const lang = await this.langOf(id);
        if (!lang) throw Object.assign(new Error('Перевод не включён'), { status: 409 });
        if (lines && (!Array.isArray(lines) || lines.length > 20000)) throw Object.assign(new Error('Нужен список строк'), { status: 400 });
        this.enqueue(id, lang, lines ? lines.map(String) : 'all');
        return this.status(id);
    }

    // Строки перевода игры с поиском: по оригиналу и по переводу, без учёта регистра. Для «перевести заново
    // выбранное»: нашёл «Мэйбел» — отметил — перевёл ещё раз
    async lines(id, q = '', limit = 100) {
        const lang = await this.langOf(id);
        if (!lang) throw Object.assign(new Error('Перевод не включён'), { status: 409 });
        const text = await this.gameText(id);
        if (!text) return { lang, total: 0, items: [] };
        const dict = await this.dictionary(id, lang, { fresh: true });
        const needle = String(q).trim().toLowerCase();
        const found = text.all.filter((s) => {
            const t = dict.get(s);
            return t !== undefined && (!needle || s.toLowerCase().includes(needle) || t.toLowerCase().includes(needle));
        });
        const shown = found.slice(0, limit);
        const origin = new Map();
        for (let i = 0; i < shown.length; i += 500) {
            const part = shown.slice(i, i + 500);
            for (const r of await this.db().all(`SELECT src, origin FROM translations WHERE lang = ? AND src IN (${part.map(() => '?').join(',')})`, [lang, ...part])) origin.set(r.src, r.origin);
        }
        return { lang, total: found.length, items: shown.map((s) => ({ src: s, text: dict.get(s), origin: origin.get(s) || 'machine' })) };
    }

    // Перевод игры файлом: { оригинал: перевод } — как хранит MTool и как принимает «Загрузить перевод»
    async exportFile(id, lang) {
        const l = lang || await this.langOf(id);
        if (!LANGS.includes(l)) throw Object.assign(new Error('Перевод не включён'), { status: 409 });
        const text = await this.gameText(id);
        if (!text) throw Object.assign(new Error('У игры нет данных RPG Maker MV/MZ'), { status: 409 });
        const dict = await this.dictionary(id, l, { fresh: true });
        const out = {};
        for (const s of text.all) if (dict.has(s)) out[s] = dict.get(s);
        return { lang: l, data: out, count: Object.keys(out).length };
    }

    // Глоссарий DeepL для игры: имена героев (как их уже перевели) и характеристики (японский оригинал).
    // Нечего класть — null
    async makeGlossary(id, text, lang, source) {
        const dict = await this.dictionary(id, lang, { fresh: true });
        const overrides = await this.terms.overrides(lang);
        const entries = new Map();
        const add = (a, b) => {
            const x = String(a || '').trim();
            const y = String(b || '').trim();
            // В TSV глоссария не бывает табуляций и переводов строк, коды игры (\C[2]) — тоже не нужны
            if (!x || !y || x === y || /[\t\r\n\\<>]/.test(x + y) || entries.has(x)) return;
            entries.set(x, y);
        };
        for (const n of text.names || []) add(n, dict.get(n));
        if (source === 'ja') for (const ja of GLOSSARY_TERMS) add(ja, termOf(ja, lang, overrides));
        if (!entries.size) return null;
        const gid = await this.glossaries.create(secret('deepl'), source, lang, [...entries]);
        console.log(`[Перевод] ${id}: глоссарий DeepL — ${entries.size} слов`);
        return gid;
    }

    // Словарь терминов для «Настроек»: по каждому стандартному слову — что выбрано для языка и откуда
    // (из переведённых игр библиотеки — с числом голосов, или встроенный)
    async termsReport() {
        const lib = await this.terms.load();
        const rows = Object.keys(TERMS).map((ja) => {
            const row = { ja };
            for (const lang of LANGS) {
                const hit = lib.langs[lang]?.terms.get(norm(ja));
                row[lang] = hit ? { text: hit.text, votes: hit.votes, total: hit.total } : { text: termOf(ja, lang) };
            }
            return row;
        });
        return { games: Object.fromEntries(LANGS.map((l) => [l, lib.langs[l]?.games || 0])), terms: rows };
    }

    // Проверка ключа при сохранении в «Настройках»: перевести одно слово. { ok } или null — служба не ответила.
    // Лимит кончился — ключ всё равно верный
    async checkKey(engine, value) {
        try {
            const [out] = await this.engines[engine](['テスト'], 'en', value);
            return { ok: typeof out === 'string' };
        } catch (e) {
            if (e instanceof QuotaError) return { ok: true };
            if (/ответил (400|401|403)\b/.test(e.message)) return { ok: false };
            return null;
        }
    }

    // Первая по порядку служба с ключом, у которой не кончился лимит месяца
    async pickEngine() {
        for (const engine of this.availableEngines()) {
            if (!(await this.exhausted(engine))) return engine;
        }
        return null;
    }

    // Словарь игры: перевод каждой её строки, что уже есть. Перечитываем, когда переводы прибавились
    // Пока идёт перевод, словарь растёт с каждой пачкой — перечитываем не чаще раза в 5 секунд и одним
    // чтением на все запросы файлов разом (dictPending)
    async dictionary(id, lang, { fresh = false, now = Date.now() } = {}) {
        const key = `${id}\n${lang}`;
        const hit = this.dicts.get(key);
        // Не чаще раза в 5 секунд — только пока эта игра переводится; решать «что переводить» — по свежему
        const busy = !fresh && this.current?.id === id && hit && now - hit.at < 5000;
        if (hit && (hit.version === this.version || busy)) return hit.map;
        if (!this.dictPending.has(key)) {
            this.dictPending.set(key, (async () => {
                const version = this.version;
                const text = await this.gameText(id);
                const map = new Map();
                const strings = text?.all || [];
                for (let i = 0; i < strings.length; i += 500) {
                    const part = strings.slice(i, i + 500);
                    for (const row of await this.db().all(`SELECT src, text FROM translations WHERE lang = ? AND text != '' AND src IN (${part.map(() => '?').join(',')})`, [lang, ...part])) {
                        map.set(row.src, row.text);
                    }
                }
                this.dicts.set(key, { version, at: Date.now(), map });
                while (this.dicts.size > 8) this.dicts.delete(this.dicts.keys().next().value);
                return map;
            })().finally(() => this.dictPending.delete(key)));
        }
        return this.dictPending.get(key);
    }

    // Свой перевод строки (экран «Картинки»): как перевод из файла — главнее машинного, «перевести заново» его не трогает
    async setOwn(src, lang, text) {
        await this.db().run(`INSERT INTO translations (src, lang, text, engine, origin, at) VALUES (?, ?, ?, 'import', 'import', ?)
            ON CONFLICT(src, lang) DO UPDATE SET text = excluded.text, engine = 'import', origin = 'import', at = excluded.at`, [src, lang, text, Date.now()]);
        this.version++;
    }

    // Строки, которые уже не вышли у какой-то службы (перевод портил коды)
    async failedOf(strings, lang) {
        const out = new Set();
        for (let i = 0; i < strings.length; i += 500) {
            const part = strings.slice(i, i + 500);
            for (const row of await this.db().all(`SELECT src FROM translations WHERE lang = ? AND origin = 'failed' AND src IN (${part.map(() => '?').join(',')})`, [lang, ...part])) out.add(row.src);
        }
        return out;
    }

    // Перевод включён — язык, иначе ''
    async langOf(id) {
        return (await this.db().get('SELECT lang FROM game_translation WHERE id = ?', [id]))?.lang || '';
    }

    // Переводы готовых строк игры (плеер сцен галереи): Map(оригинал → показываемый перевод). Защищённые и непереведённые
    // строки в ответ не попадают — их показывают как есть
    async lookup(id, strings) {
        const out = new Map();
        const lang = await this.langOf(id);
        const text = lang && await this.gameText(id);
        if (!text) return out;
        const dict = await this.dictionary(id, lang);
        for (const s of strings) {
            if (text.guard(s)) continue;
            const t = dict.get(s);
            if (t !== undefined && t !== s) out.set(s, displayText(t));
        }
        return out;
    }

    // Подстановка: файл data/<name>.json — с переводом. Защищённые строки и строки без перевода — как были.
    // Не разобрался файл — отдаём как есть (null)
    async overlay(id, name, raw) {
        const lang = await this.langOf(id);
        if (!lang) return null;
        const text = await this.gameText(id);
        if (!text) return null;
        let data;
        try { data = JSON.parse(String(raw).replace(/^﻿/, '')); } catch (e) { return null; }
        const dict = await this.dictionary(id, lang);
        let changed = 0;
        eachShown(name, data, (s, set) => {
            if (text.guard(s)) return;
            const t = dict.get(s);
            if (t !== undefined && t !== s) { set(displayText(t)); changed++; }
        });
        return changed ? JSON.stringify(data) : null;
    }

    // Подстановка в js/plugins.js: видимые параметры плагинов (подписи меню, подсказки) — с переводом
    async overlayPlugins(id, raw) {
        const lang = await this.langOf(id);
        if (!lang) return null;
        const text = await this.gameText(id);
        if (!text) return null;
        const dict = await this.dictionary(id, lang);
        return overlayPlugins(String(raw), (s) => {
            if (text.guard(s) || text.files?.has(s)) return undefined;
            const t = dict.get(s);
            return t === undefined ? undefined : displayText(t);
        }, text.types);
    }

    // Запасной файл: игра просит файл, которого нет, а его имя — перевод имени настоящего файла («arina/other/
    // Click Sound 1» вместо «arina/other/クリック音１»: перевод задел ссылку на файл, правила этого не
    // угадали). Тогда отдаём настоящий — игра не встаёт на «Failed to load». rel — путь от папки игр
    // («<игра>/www/audio/se/arina/other/Click Sound 1.ogg»). Нет такого — null
    async originalFile(id, rel) {
        const lang = await this.langOf(id);
        if (!lang) return null;
        const text = await this.gameText(id);
        if (!text?.files?.size) return null;
        const parts = String(rel).split(/[\\/]/);
        // Папка вида: img/<вид>/…, audio/<вид>/…, movies/… — дальше имя так, как его пишет игра
        const at = parts.findIndex((p, i) => i > 0 && /^(img|audio|movies)$/i.test(p));
        if (at < 0) return null;
        const head = parts.slice(0, /^movies$/i.test(parts[at]) ? at + 1 : at + 2);
        const tail = parts.slice(head.length);
        if (!tail.length) return null;
        const last = tail[tail.length - 1];
        const ext = path.extname(last);
        const wanted = [...tail.slice(0, -1), last.slice(0, last.length - ext.length)].join('/');
        // Обратный словарь имён файлов этой игры: перевод → настоящее имя (и с подпапками, и без). Имена файлов
        // — не строки игры, в её словаре их нет: спрашиваем базу
        // Два файла перевелись одинаково — какой из них, не угадать: такой перевод не подменяем (null).
        // Строится один раз на все одновременные запросы (игра просит десятки файлов разом)
        if (!text.reverse || text.reverse.version !== this.version || text.reverse.lang !== lang) {
            const version = this.version;
            if (!text.reversePending || text.reversePending.version !== version || text.reversePending.lang !== lang) {
                const build = (async () => {
                    const map = new Map();
                    const put = (k, v) => { map.set(k, map.has(k) && map.get(k) !== v ? null : v); };
                    const names = [...text.files];
                    for (let i = 0; i < names.length; i += 500) {
                        const part = names.slice(i, i + 500);
                        const rows = await this.db().all(`SELECT src, text FROM translations WHERE lang = ? AND text != '' AND src IN (${part.map(() => '?').join(',')})`, [lang, ...part]);
                        for (const r of rows) {
                            if (r.text === r.src) continue;
                            put(r.text, r.src);
                            if (displayText(r.text) !== r.text) put(displayText(r.text), r.src);
                        }
                    }
                    text.reverse = { version, lang, map };
                })();
                text.reversePending = { version, lang, promise: build.finally(() => { text.reversePending = null; }) };
            }
            await text.reversePending.promise;
        }
        const real = text.reverse.map.get(wanted)
            || (() => {
                // Перевели только имя («Click Sound 1» в той же папке)
                const base = text.reverse.map.get(wanted.split('/').pop());
                return base ? [...tail.slice(0, -1), base.split('/').pop()].join('/') : null;
            })();
        if (!real) return null;
        const file = path.join(this.gamesDir, ...head, ...real.split('/')) + ext;
        const root = path.resolve(this.gamesDir, id);
        if (!path.resolve(file).startsWith(root + path.sep)) return null;
        return (await fsp.stat(file).then((s) => s.isFile(), () => false)) ? file : null;
    }

    // Перевод только для экрана: { words: { оригинал: перевод }, images: разметки картинок, saved } — строки, которые
    // в файлах не меняются (защищённое и строки из кода плагинов). rpg-fixes подставляет их при выводе текста и
    // перерисовывает подписи на картинках при их загрузке — игра внутри видит оригинал.
    // saved: { vars, actors } — переводы строк, которые игра хранит в сохранении (переменные, герои): тот же
    // перевод, что подставлен в файлы, — для сохранений, сделанных до перевода
    async displayDict(id) {
        const lang = await this.langOf(id);
        if (!lang) return null;
        const text = await this.gameText(id);
        if (!text) return { words: {}, images: [], saved: { vars: {}, actors: {} } };
        const dict = await this.dictionary(id, lang);
        const out = {};
        for (const s of text.display) {
            const t = dict.get(s);
            if (t !== undefined && t !== s) out[s] = displayText(t);
        }
        // Короткие строки данных (названия, типы, термины) — тоже: плагины рисуют их сами, часто в рамке
        // («― " + тип + " ―»), а такую строку на экране узнаёт только словарь
        for (const s of text.strings) {
            if (s.length > 30 || out[s] !== undefined) continue;
            const t = dict.get(s);
            if (t !== undefined && t !== s) out[s] = displayText(t);
        }
        const saved = { vars: {}, actors: {} };
        for (const kind of ['vars', 'actors']) {
            for (const s of text.saved?.[kind] || []) {
                const t = dict.get(s);
                if (t !== undefined && t !== s) saved[kind][s] = displayText(t);
            }
        }
        return { words: out, images: text.images || [], saved };
    }

    // Стандартные слова RPG Maker (utils/glossary.js) — в словарь без службы. И поверх прежнего машинного
    // перевода: «Атака» должна быть «Атакой» во всех играх. Свой перевод из файла не трогаем
    async applyTerms(strings, lang) {
        const overrides = await this.terms.overrides(lang);
        const rows = [];
        for (const s of strings) {
            const t = termOf(s, lang, overrides);
            if (t) rows.push([s, lang, t, Date.now()]);
        }
        if (!rows.length) return 0;
        const changed = await this.writeMany(`INSERT INTO translations (src, lang, text, engine, origin, at) VALUES (?, ?, ?, 'glossary', 'glossary', ?)
            ON CONFLICT(src, lang) DO UPDATE SET text = excluded.text, engine = 'glossary', origin = 'glossary', at = excluded.at
            WHERE translations.origin != 'import' AND translations.text != excluded.text`, rows);
        if (changed) this.version++;
        return changed;
    }

    // Перед включением перевода — что он будет стоить: сколько строк ещё нет в словаре, сколько в них знаков,
    // какая служба возьмётся и сколько у неё останется лимита месяца
    async estimate(id, lang, redo = null) {
        if (!LANGS.includes(lang)) throw Object.assign(new Error('Такого языка нет'), { status: 400 });
        const text = await this.gameText(id);
        if (!text) return { total: 0, todo: 0, chars: 0, engine: '', left: null };
        const known = await this.dictionary(id, lang, { fresh: true });
        const tried = await this.failedOf(text.all, lang);
        const overrides = await this.terms.overrides(lang);
        const again = await this.redoSet(text.all, lang, redo);
        const todo = text.all.filter((s) => !termOf(s, lang, overrides) && (again.has(s) || (!known.has(s) && !tried.has(s))));
        const engine = (await this.pickEngine()) || '';
        let left = engine && FREE[engine] ? Math.max(0, FREE[engine] - (await this.usage(engine))) : null;
        // DeepL сам знает, сколько осталось (и с других устройств, и с Pro) — его число точнее нашего
        if (engine === 'deepl' && this.quota) {
            // Только DeepL и свежий ответ: остаток после недавнего перевода важен, ждать другие службы — нет
            const real = await this.quota.deepl().catch(() => null);
            if (real?.ok && real.limit) left = real.left;
        }
        return { total: text.all.length, todo: todo.length, chars: todo.reduce((n, s) => n + s.length, 0), engine, left };
    }

    // Проверка переведённой игры (utils/tlcheck.js): слипшиеся слова и текст, который не влезет в окно.
    // Само исправляется только машинный перевод: свой (загруженный файлом) не трогаем — его делал человек
    async issuesOf(id) {
        const lang = await this.langOf(id);
        if (!lang) throw Object.assign(new Error('Перевод не включён'), { status: 409 });
        const text = await this.gameText(id);
        const dir = await this.dataDir(id);
        if (!text || !dir) throw Object.assign(new Error('У игры нет данных RPG Maker MV/MZ'), { status: 409 });
        const files = [];
        for (const f of (await fsp.readdir(dir)).filter((x) => x.endsWith('.json'))) {
            try { files.push([f.slice(0, -5), JSON.parse((await fsp.readFile(path.join(dir, f), 'utf8')).replace(/^\uFEFF/, ''))]); } catch (e) { /* не JSON — не переводится */ }
        }
        const system = files.find(([n]) => n === 'System')?.[1];
        const plugins = await fsp.readFile(path.join(dir, '..', 'js', 'plugins.js'), 'utf8').catch(() => '');
        const layout = layoutOf(system, plugins);
        const issues = checkGame(files, await this.dictionary(id, lang, { fresh: true }), text.guard, layout);
        const srcs = issues.filter((x) => x.fix).map((x) => x.src);
        const machine = new Set();
        for (let i = 0; i < srcs.length; i += 500) {
            const part = srcs.slice(i, i + 500);
            for (const row of await this.db().all(`SELECT src FROM translations WHERE lang = ? AND origin = 'machine' AND src IN (${part.map(() => '?').join(',')})`, [lang, ...part])) machine.add(row.src);
        }
        for (const x of issues) if (x.fix && !machine.has(x.src)) delete x.fix;
        return { lang, layout, issues };
    }

    async check(id) {
        const { lang, layout, issues } = await this.issuesOf(id);
        const counts = {};
        for (const x of issues) counts[x.kind] = (counts[x.kind] || 0) + 1;
        const fixable = issues.filter((x) => x.fix);
        // Исправимые — первыми, остальные — до предела ответа
        const ordered = [...fixable, ...issues.filter((x) => !x.fix)].slice(0, CHECK_LIMIT);
        return { lang, layout: { width: layout.width, font: layout.font }, counts, fixable: fixable.length, issues: ordered };
    }

    // Исправить слипание (пробел перед кодом, после точки, между словами). Словарь общий — строка исправится
    // во всех играх, где она есть. Строку, которую за это время перевели заново, не трогаем (text = прежний)
    async fix(id) {
        const { lang, issues } = await this.issuesOf(id);
        const rows = issues.filter((x) => x.fix).map((x) => [x.fix, Date.now(), x.src, lang, x.text]);
        const fixed = rows.length ? await this.writeMany("UPDATE translations SET text = ?, at = ? WHERE src = ? AND lang = ? AND text = ? AND origin = 'machine'", rows) : 0;
        if (fixed) {
            this.version++;
            this.onChange(id);
        }
        return { fixed };
    }

    // Импорт готового перевода: { "оригинал": "перевод" } (так хранят переводы MTool и многие программы)
    // или CSV из двух колонок. Свой перевод главнее машинного и машинным потом не заменяется
    async importFile(id, lang, content) {
        if (!LANGS.includes(lang)) throw Object.assign(new Error('Такого языка нет'), { status: 400 });
        const pairs = parseImport(content);
        if (!pairs.length) throw Object.assign(new Error('В файле нет пар «оригинал — перевод»'), { status: 400 });
        if (pairs.length > 300000) throw Object.assign(new Error('Слишком большой файл перевода'), { status: 413 });
        const text = await this.gameText(id);
        const ours = new Set(text?.all || []);
        let matched = 0;
        const rows = [];
        for (const [src, dst] of pairs) {
            // Тот же набор кодов, что в оригинале, — иначе перевод сломал бы строку игры
            const a = protect(src).codes.slice().sort().join('\u0001');
            const b = protect(dst).codes.slice().sort().join('\u0001');
            if (a !== b) continue;
            rows.push([src, lang, dst, Date.now()]);
            if (ours.has(src)) matched++;
        }
        await this.writeMany(`INSERT INTO translations (src, lang, text, engine, origin, at) VALUES (?, ?, ?, 'import', 'import', ?)
            ON CONFLICT(src, lang) DO UPDATE SET text = excluded.text, engine = 'import', origin = 'import', at = excluded.at`, rows);
        this.version++;
        this.onChange(id);
        return { pairs: pairs.length, matched, total: ours.size };
    }
}

// Пары из файла: JSON-объект, массив пар или CSV (две колонки, кавычки по правилам CSV)
function parseImport(content) {
    const s = String(content || '').replace(/^﻿/, '').trim();
    try {
        const data = JSON.parse(s);
        if (Array.isArray(data)) return data.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string' && p[1]).map((p) => [p[0], p[1]]);
        if (data && typeof data === 'object') return Object.entries(data).filter(([k, v]) => k && typeof v === 'string' && v);
    } catch (e) { /* не JSON — CSV */ }
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quoted) {
            if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
            if (c === '\r' && s[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += c;
    }
    row.push(cell); rows.push(row);
    return rows.filter((r) => r.length >= 2 && r[0] && r[1]).map((r) => [r[0], r[1]]);
}

module.exports = new TranslateService();
module.exports.TranslateService = TranslateService;
module.exports.QuotaError = QuotaError;
module.exports.parseImport = parseImport;
module.exports.LANGS = LANGS;
module.exports.ENGINES = ENGINES;
module.exports.escape = escape;
module.exports.BATCH = BATCH;
module.exports.sourceOf = sourceOf;
module.exports.imageLabelSets = imageLabelSets;
