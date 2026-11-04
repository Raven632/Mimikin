const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ModelHolder, registerModels, modelFile, modelFailed, progressOf, analysisOn } = require('./galleryModels.js');

// Слова → вектор в том же пространстве, что и картинки галереи (galleryVision.js): поиск по картинкам. Берём
// sentence-transformers/clip-ViT-B-32-multilingual-v1: многоязычный текстовый кодировщик (DistilBERT, 50+ языков, в том
// числе русский и немецкий), обученный повторять текстовую часть исходного CLIP ViT-B/32 — а «картинка» у нас та же
// ViT-B/32, так что запрос «горничная» ложится рядом с картинками горничных без перевода и без платных служб. Три файла
// (модель в fp16 257 МБ, слой 768→512 1,5 МБ, словарь 1 МБ) качаются один раз в _media/_models и проверяются по сумме.
// Готовая int8-версия (129 МБ) не годится: после сжатия все слова дают почти один и тот же вектор
// Нет модуля onnxruntime-node или файлов — поиск выключен, галерея работает как без него
const BASE = 'https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1/resolve/main/';
const FILES = {
    model: { url: `${BASE}onnx/model_O4.onnx`, name: 'clip-multilingual-text-fp16.onnx', sha256: 'c477ffcac84a350f654d0c1b27e68b038056f0922c933b146a67cd301f8092fd', size: 269490710 },
    dense: { url: `${BASE}2_Dense/model.safetensors`, name: 'clip-multilingual-dense.safetensors', sha256: 'd12568dc7300970a4d3dbb49068ad16cd89b99840b74b026f8e48071e9414f74', size: 1572984 },
    vocab: { url: `${BASE}vocab.txt`, name: 'clip-multilingual-vocab.txt', sha256: 'fe0fda7c425b48c516fc8f160d594c8022a0808447475c1a7c6d6479763f310c', size: 995526 },
};
registerModels(Object.values(FILES));
const WORDS = require('./galleryTextWords.json');
// Окончания, с которыми короткий ключ словаря ещё то же слово (см. toEnglish): падежи («ванная», «ванную», «кровью»,
// «орков», «баня», «тело») и прилагательные («голая», «голый», «голых»)
const ENDINGS = { ru: /^(а|и|у|е|о|я|ю|ь|ой|ом|ы|ам|ами|ах|ями|ях|ая|ую|ые|ый|ий|ое|ых|ым|ов|ей|ью)?$/, de: /^(e|en|n|s|es)?$/ };
// С какой длины ключ — основа и совпадает по началу слова. Немецкие покороче — начало английских слов («regen» —
// «regeneration», «mutter» — «muttering», «unter» — «Unterhose»): им — только целое слово с окончанием
const STEM = { ru: 5, de: 7 };
const MAX_TOKENS = 64;
const MAX_WORD = 100;

let ort = null;
try { ort = require('onnxruntime-node'); } catch { /* модуля нет — без поиска */ }

// Подряд идущие знаки CJK BERT разделяет пробелами: каждый — своё слово
const CJK = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2fa1f}]/gu;

class GalleryText {
    constructor() {
        this.mediaDir = '';
        this.hold = new ModelHolder(() => this.open(), { close: (m) => m.session.release() });
        this.failedAt = 0;
        this.queue = Promise.resolve();
        this.cache = new Map();     // запрос → вектор: человек дописывает слово, а не набирает заново
    }

    setDependencies({ mediaDir }) {
        this.mediaDir = mediaDir;
    }

    // GALLERY_VISION=0 — выключено, как и распознавание (тесты: ничего не качаем)
    get available() {
        return !!ort && !!this.mediaDir && process.env.GALLERY_VISION !== '0';
    }

    // Готов ли поиск — без ожидания: 'ready'; 'preparing' — модель качается или открывается (done и total — байты
    // скачивания, пока оно идёт); 'off' — выключено или не вышло (час не пробуем). Заодно начинает загрузку: первый раз
    // модель (~270 МБ) качается минуты, а после простоя открывается секунды, и запрос поиска не должен всё это время висеть.
    // Разбор выключен — работает то, что уже скачано; start: false — только спросить (строка в «Настройках»)
    prepare({ start = true } = {}) {
        if (this.hold.ready) return { state: 'ready' };
        if (!this.available || Date.now() - this.failedAt < 60 * 60 * 1000) return { state: 'off' };
        if (!analysisOn() && !Object.values(FILES).every((spec) => fs.existsSync(path.join(this.mediaDir, '_models', spec.name)))) return { state: 'off' };
        if (start) this.hold.warm();
        return { state: 'preparing', ...progressOf(Object.values(FILES)) };
    }

    // Модель, слой и словарь: скачать недостающее (не в OFFLINE), проверить, открыть. Не вышло — час не пробуем снова
    async open() {
        if (!this.available || Date.now() - this.failedAt < 60 * 60 * 1000) return null;
        try {
            const paths = {};
            for (const [k, spec] of Object.entries(FILES)) paths[k] = await modelFile(spec, this.mediaDir);
            const session = await ort.InferenceSession.create(paths.model, { intraOpNumThreads: 2, interOpNumThreads: 1 });
            const raw = await fsp.readFile(paths.dense);
            const head = Number(raw.readBigUInt64LE(0));
            const meta = JSON.parse(raw.subarray(8, 8 + head).toString('utf8'))['linear.weight'];
            if (!meta || meta.shape.join() !== '512,768') throw new Error('слой: не тот размер');
            const at = 8 + head + meta.data_offsets[0];
            const dense = new Float32Array(512 * 768);
            for (let i = 0; i < dense.length; i++) dense[i] = raw.readFloatLE(at + i * 4);
            const vocab = new Map();
            (await fsp.readFile(paths.vocab, 'utf8')).split('\n').forEach((w, i) => { if (w) vocab.set(w, i); });
            return { session, dense, vocab };
        } catch (e) {
            this.failedAt = modelFailed();
            console.warn(`[Галерея] поиск по картинкам выключен: ${e.message}`);
            return null;
        }
    }

    // BERT: знаки препинания и CJK — отдельными словами, остальное режем по пробелам; регистр и ударения не трогаем
    // (модель «cased»). Слово — жадно самыми длинными кусками из словаря, продолжения с «##»
    tokens(text, vocab) {
        const ids = [vocab.get('[CLS]')];
        const words = text.normalize('NFC').replace(CJK, ' $& ').replace(/[\u0000-\u001f]/g, ' ').split(/\s+/).filter(Boolean);
        for (const w of words) {
            for (const part of w.split(/(\p{P}|\p{S})/u).filter(Boolean)) {
                if (ids.length >= MAX_TOKENS - 1) break;
                const chars = Array.from(part);
                if (chars.length > MAX_WORD) { ids.push(vocab.get('[UNK]')); continue; }
                const pieces = [];
                let start = 0;
                while (start < chars.length) {
                    let end = chars.length;
                    let found = null;
                    while (start < end) {
                        const s = (start ? '##' : '') + chars.slice(start, end).join('');
                        if (vocab.has(s)) { found = vocab.get(s); break; }
                        end--;
                    }
                    if (found === null) { pieces.length = 0; pieces.push(vocab.get('[UNK]')); break; }
                    pieces.push(found);
                    start = end;
                }
                ids.push(...pieces);
            }
        }
        ids.length = Math.min(ids.length, MAX_TOKENS - 1);
        ids.push(vocab.get('[SEP]'));
        return ids;
    }

    // Многоязычная модель знает русские и немецкие слова заметно хуже английских: «драконы» и
    // «спящая девушка» находят одну картинку из десяти, «dragons» и «sleeping girl» — восемь-десять. Слово из
    // короткого списка (galleryTextWords.json) заменяем английским. Именно заменяем: русское слово рядом с английским
    // тянет запрос обратно («драконы, dragons» — снова одна из десяти). Самое длинное совпадение; слова не из списка
    // остаются как есть. Короткий ключ (STEM: «сад», «лес», «бан», «mann») совпадает со словом целиком или со словом и
    // окончанием: по началу он цеплял бы «садистка», «банк», «оркестр», «mannequin»; ключ в одну-две буквы («в», «с»,
    // «im») — только целым словом. Длинный ключ — основа, ему хватает начала слова. Службы перевода тут не помогают:
    // одно слово без контекста DeepL переводит как придётся («мир» → «peace»)
    toEnglish(q) {
        return q.replace(/\p{L}+/gu, (word) => {
            const w = word.toLowerCase().replace(/ё/g, 'е');
            for (const [lang, dict] of Object.entries(WORDS)) {
                const stem = Object.keys(dict).filter((k) => {
                    const key = k.replace(/ё/g, 'е');
                    if (!w.startsWith(key)) return false;
                    const rest = w.slice(key.length);
                    return key.length >= (STEM[lang] || 5) || (key.length > 2 ? (ENDINGS[lang] || /^$/).test(rest) : !rest);
                }).sort((a, b) => b.length - a.length)[0];
                if (stem) return dict[stem];
            }
            return word;
        });
    }

    // Запрос → единичный вектор из 512 чисел, null — кодировать нечем. Среднее по словам, затем слой 768→512
    embed(text) {
        const q = String(text).trim().slice(0, 200);
        if (this.cache.has(q)) return Promise.resolve(this.cache.get(q));
        const run = this.queue.then(() => this.hold.use(async (m) => {
            if (!m) return null;
            const ids = this.tokens(this.toEnglish(q), m.vocab);
            const len = ids.length;
            const out = await m.session.run({
                input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, len]),
                attention_mask: new ort.Tensor('int64', new BigInt64Array(len).fill(1n), [1, len]),
            });
            const h = out.last_hidden_state.data;
            const mean = new Float32Array(768);
            for (let t = 0; t < len; t++) for (let j = 0; j < 768; j++) mean[j] += h[t * 768 + j] / len;
            const v = new Float32Array(512);
            for (let i = 0; i < 512; i++) { let s = 0; for (let j = 0; j < 768; j++) s += m.dense[i * 768 + j] * mean[j]; v[i] = s; }
            const n = Math.hypot(...v) || 1;
            for (let i = 0; i < 512; i++) v[i] /= n;
            if (this.cache.size > 200) this.cache.clear();
            this.cache.set(q, v);
            return v;
        }));
        this.queue = run.catch(() => {});
        return run;
    }
}

module.exports = new GalleryText();
module.exports.GalleryText = GalleryText;
