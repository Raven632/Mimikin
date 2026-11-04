const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { ModelHolder, registerModels, modelFile, modelFailed, tagThreads } = require('./galleryModels.js');

// Что нарисовано на кадре — тегами Danbooru (kimono, castle, holding_sword): для поиска по картинкам. CLIP
// (galleryVision.js) видит кадр целиком в 224 точки и мелких деталей не различает; разметчик WD v3
// (SmilingWolf/wd-vit-tagger-v3, обучен на Danbooru) смотрит в 448 точек и знает ~10 тыс. тегов. Медленный — ~2 с на
// кадр на одном ядре, поэтому только фоном (gallery.js, picturePass). Сжатая int8-версия не годится: на треть тегов
// отвечает иначе. Модель (378 МБ) и список тегов качаются один раз в _media/_models и проверяются по сумме; нет модуля
// или файлов — поиск идёт по одному CLIP, как раньше
const BASE = 'https://huggingface.co/SmilingWolf/wd-vit-tagger-v3/resolve/main/';
const FILES = {
    model: { url: `${BASE}model.onnx`, name: 'wd-vit-tagger-v3.onnx', sha256: '35f23693620b668f4d53fd3c62bf65e40af739bc52c7eb0fbc49258b58d065b6', size: 378536310 },
    tags: { url: `${BASE}selected_tags.csv`, name: 'wd-vit-tagger-v3-tags.csv', sha256: '298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217', size: 308468 },
};
registerModels(Object.values(FILES));
// Теги кадра в файле — номер в списке модели: другая модель или список — теги считаются заново
const VERSION = FILES.tags.sha256.slice(0, 12);
const SIZE = 448;
// Тег держим, если модель уверена хотя бы на 0,2: слабые ответы поиску только мешают, а файл растёт
const KEEP = 0.2;
const TIMEOUT_MS = 30 * 1000;
// Слова запроса (уже английские, galleryText.toEnglish) → теги, когда имя тега другое: «outfit» → dress
const WORDS = require('./galleryTagWords.json');
// Теги, которые вообще берём из ответа модели (api/src/data/picture-tags.json): нейтральный список — одежда, волосы, места, вещи.
// Остальное разметчик знает, но мы его не храним и не показываем: так список в окне картинки и поиск одинаковы у всех
const ALLOWED = new Set(require('../data/picture-tags.json'));
// Сколько слов подряд может быть в имени тега или синониме («witch hat»)
const PHRASE = 3;
// Теги про детей не показываем и по ним не ищем — никогда, в любой игре. По словам, а не по куску: тег одежды с похожим
// началом не про детей
const BLOCKED = /(^|[_-])(loli|shota|lolicon|lolidom)([_-]|$)|^oppai_loli$|(^|_)child|^bab(y|ies)($|_)|^(infant|toddler|aged_down|age_regression|age_comparison|younger|pacifier|diaper|onesie|bib|randoseru)$|elementary|kindergarten/;
// Запрос про детей не ищем вовсе — ни по тегам, ни по CLIP (поиск по картинкам, server.js): слова на трёх языках
const BLOCKED_QUERY = /\b(loli\w*|shota\w*|child\w*|kids?|toddlers?|bab(y|ies)|infants?|underage|preteens?|minors?|kind(er)?|kleinkind\w*|minderjährig\w*)\b|лоли|шота|ребён|ребен|(^|[^\p{L}])дет(и|ей|ям|ьми|ск\p{L}*|сад\p{L}*)($|[^\p{L}])|малолет|несовершеннолет|младен|малыш/iu;
// Показывать у картинки (окно картинки, строка тегов галереи) — только то, что говорит о самой картинке: без счёта
// персонажей («1girl»), цензуры, фона, ракурса, цвета глаз, причёски и служебных пометок рисовальщиков
const META = /_background$|_eyes$|censor|^\d\+?(girl|boy)s?$|^multiple_(girls|boys|others)$|^solo|_text$|^(looking_at_viewer|looking_at_another|looking_back|looking_away|looking_down|hair_between_eyes|parted_lips|open_mouth|closed_mouth|closed_eyes|one_eye_closed|blush|teeth|bangs|blunt_bangs|sidelocks|ahoge|upper_body|cowboy_shot|full_body|portrait|profile|close-up|monochrome|greyscale|comic|speech_bubble|signature|watermark|artist_name|twitter_username|dated|motion_lines|sound_effects|from_side|from_above|from_below|from_behind|pov|indoors|outdoors|simple_background|lineart|sketch|long_hair|short_hair|medium_hair|very_long_hair|standing|sitting|lying|holding|smile|grin|eyelashes|hand_up|arms_up|arm_up|head_tilt|male_focus|1other|no_humans|blurry|depth_of_field|heart|spoken_heart|sweatdrop|blush_stickers|alternate_costume|alternate_hairstyle|parody|v|jewelry|earrings|hair_ornament|hairclip|hair_ribbon|hair_bow|hairband|ribbon|bow|bowtie|frills|buttons|fingernails|lips|makeup|nail_polish|symbol-shaped_pupils|floating_hair|hair_intakes|eyes_visible_through_hair|hair_over_one_eye|shiny_hair|pokemon_\(creature\))$/;
// Тег показываем, если модель уверена хотя бы на 0,35 — так советуют её авторы
const SURE = 0.35;

let ort = null;
try { ort = require('onnxruntime-node'); } catch { /* модуля нет — без разметки */ }

class GalleryTags {
    constructor() {
        this.mediaDir = '';
        this.hold = new ModelHolder(() => this.open());
        this.names = null;          // теги по номерам; только «общие» (не персонажи и не рейтинг) — у остальных null
        this.listing = null;
        this.failedAt = 0;
        this.queue = Promise.resolve();
        this.version = VERSION;
    }

    setDependencies({ mediaDir }) {
        this.mediaDir = mediaDir;
    }

    // GALLERY_VISION=0 — выключено, как и распознавание (тесты: ничего не качаем)
    get available() {
        return !!ort && !!this.mediaDir && process.env.GALLERY_VISION !== '0';
    }

    // Список тегов (300 КБ) — отдельно от модели: запросу он нужен сразу, а модель — только фоновой разметке
    async list() {
        if (this.names) return this.names;
        if (!this.available || Date.now() - this.failedAt < 60 * 60 * 1000) return null;
        if (!this.listing) {
            this.listing = (async () => {
                const rows = (await fsp.readFile(await modelFile(FILES.tags, this.mediaDir), 'utf8')).trim().split('\n').slice(1);
                // tag_id,name,category,count; категория 0 — что нарисовано, 4 — персонажи, 9 — рейтинг. Оставляем теги из
                // picture-tags.json и теги про детей: их надо знать, чтобы прятать такие кадры из ленты (gallery.js), хотя
                // показать и найти по ним нельзя
                this.names = rows.map((l) => { const [, name, cat] = l.split(','); return cat === '0' && (ALLOWED.has(name) || BLOCKED.test(name)) ? name : null; });
                return this.names;
            })().catch((e) => {
                this.failedAt = modelFailed();
                console.warn(`[Галерея] теги картинок выключены: ${e.message}`);
                return null;
            }).finally(() => { this.listing = null; });
        }
        return this.listing;
    }

    async open() {
        if (!(await this.list())) return null;
        try {
            // На одном ядре кадр идёт 2 с, на двух — 1,2 с, на трёх — 0,9 с: каждое новое ядро отдаёт всё меньше, а сервер нужен и играм
            return await ort.InferenceSession.create(await modelFile(FILES.model, this.mediaDir), { intraOpNumThreads: tagThreads(), interOpNumThreads: 1 });
        } catch (e) {
            this.failedAt = modelFailed();
            console.warn(`[Галерея] разметка картинок выключена: ${e.message}`);
            return null;
        }
    }

    // Пиксели 448×448, BGR: картинка целиком, поля и прозрачное — белые (так учили модель)
    pixels(file) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', ['-v', 'error', '-i', file, '-filter_complex',
                `color=c=white:s=${SIZE}x${SIZE}[b];[0:v]scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease:flags=bicubic[f];[b][f]overlay=(W-w)/2:(H-h)/2:format=auto,format=bgr24`,
                '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
            const out = [];
            const timer = setTimeout(() => proc.kill('SIGKILL'), TIMEOUT_MS);
            proc.stdout.on('data', (d) => out.push(d));
            proc.on('error', (e) => { clearTimeout(timer); reject(e); });
            proc.on('close', (code) => {
                clearTimeout(timer);
                const raw = Buffer.concat(out);
                if (code !== 0 || raw.length < SIZE * SIZE * 3) return reject(new Error(`ffmpeg: ${code}`));
                resolve(raw);
            });
        });
    }

    // Теги кадра одной строкой: по 3 байта на тег (номер — 2 байта, уверенность 0…255) в base64. null — разметить нечем
    tag(file) {
        const run = this.queue.then(() => this.hold.use(async (session) => {
            if (!session) return null;
            const raw = await this.pixels(file);
            const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', Float32Array.from(raw), [1, SIZE, SIZE, 3]) });
            const p = out[session.outputNames[0]].data;
            const kept = [];
            for (let i = 0; i < p.length; i++) if (this.names[i] && p[i] >= KEEP) kept.push(i, Math.round(p[i] * 255));
            return pack(kept);
        }));
        this.queue = run.catch(() => {});
        return run;
    }

    // Тег можно показать человеку: из списка picture-tags.json, не служебный и не про детей
    shown(name) {
        return !!name && ALLOWED.has(name) && !BLOCKED.test(name) && !META.test(name);
    }

    // Тег про детей
    blocked(name) {
        return BLOCKED.test(name);
    }

    // Запрос про детей (на любом из трёх языков, исходный или уже английский) — не ищем
    blockedQuery(...texts) {
        return texts.some((x) => BLOCKED_QUERY.test(String(x || '')));
    }

    // Запрос английскими словами → группы тегов: каждая группа — одно понятие запроса, кадру хватает одного тега группы
    // («sea shore» → ocean, beach). Сначала свои синонимы (galleryTagWords.json), потом имя тега как
    // есть («witch hat» → witch_hat, «cats» → cat); до трёх слов подряд, самое длинное. Слова без тега ищет один CLIP.
    // names — список тегов (list()); без него — пусто
    concepts(text, names = this.names) {
        if (!names) return [];
        if (!this.byName || this.byNameOf !== names) {
            this.byName = new Map();
            names.forEach((n, i) => { if (n && !BLOCKED.test(n)) this.byName.set(n, i); });
            this.byNameOf = names;
        }
        const words = String(text).toLowerCase().match(/[\p{L}\p{N}'-]+/gu) || [];
        const groups = [];
        for (let i = 0; i < words.length;) {
            let hit = null;
            for (let len = Math.min(PHRASE, words.length - i); len > 0 && !hit; len--) {
                const phrase = words.slice(i, i + len).join(' ');
                const tags = WORDS[phrase] || [phrase.replace(/ /g, '_'), ...(phrase.endsWith('s') ? [phrase.slice(0, -1).replace(/ /g, '_')] : [])];
                const ids = tags.map((t) => this.byName.get(t)).filter((x) => x !== undefined);
                if (ids.length) hit = { ids, len };
            }
            if (hit) { groups.push(hit.ids); i += hit.len; } else i++;
        }
        return groups;
    }
}

// [номер, уверенность, номер, уверенность…] → строка и обратно
function pack(kept) {
    const b = Buffer.alloc((kept.length / 2) * 3);
    for (let k = 0, o = 0; k < kept.length; k += 2, o += 3) { b.writeUInt16BE(kept[k], o); b[o + 2] = kept[k + 1]; }
    return b.toString('base64');
}
function unpack(s) {
    const b = Buffer.from(s || '', 'base64');
    const out = [];
    for (let o = 0; o + 2 < b.length; o += 3) out.push(b.readUInt16BE(o), b[o + 2]);
    return out;
}

module.exports = new GalleryTags();
module.exports.GalleryTags = GalleryTags;
module.exports.pack = pack;
module.exports.unpack = unpack;
module.exports.SURE = SURE;
