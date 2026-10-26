const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { OFFLINE } = require('../config/index.js');

// Слова → вектор в том же пространстве, что и картинки галереи (galleryVision.js): поиск по картинкам. Берём
// sentence-transformers/clip-ViT-B-32-multilingual-v1: многоязычный текстовый кодировщик (DistilBERT, 50+ языков, в том
// числе русский и немецкий), обученный повторять текстовую часть исходного CLIP ViT-B/32 — а «картинка» у нас та же
// ViT-B/32, так что запрос «горничная» ложится рядом с картинками горничных без перевода и без платных служб. Три файла
// (модель в fp16 257 МБ, слой 768→512 1,5 МБ, словарь 1 МБ) качаются один раз в _media/_models и проверяются по сумме.
// Готовая int8-версия (129 МБ) не годится: после сжатия все слова дают почти один и тот же вектор
// Нет модуля onnxruntime-node или файлов — поиск выключен, галерея работает как без него
const BASE = 'https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1/resolve/main/';
const FILES = {
    model: { url: `${BASE}onnx/model_O4.onnx`, name: 'clip-multilingual-text-fp16.onnx', sha256: 'c477ffcac84a350f654d0c1b27e68b038056f0922c933b146a67cd301f8092fd' },
    dense: { url: `${BASE}2_Dense/model.safetensors`, name: 'clip-multilingual-dense.safetensors', sha256: 'd12568dc7300970a4d3dbb49068ad16cd89b99840b74b026f8e48071e9414f74' },
    vocab: { url: `${BASE}vocab.txt`, name: 'clip-multilingual-vocab.txt', sha256: 'fe0fda7c425b48c516fc8f160d594c8022a0808447475c1a7c6d6479763f310c' },
};
const WORDS = require('./galleryTextWords.json');
// Окончания, с которыми короткий ключ словаря ещё то же слово (см. withEnglish); ая|ую|ые — «ванная», «ванную», «ванные»
const ENDINGS = { ru: /^(а|и|у|е|ой|ом|ы|ам|ами|ах|ая|ую|ые)?$/, de: /^(e|en|n|s|es)?$/ };
const DOWNLOAD_MS = 10 * 60 * 1000;
const MAX_TOKENS = 64;
const MAX_WORD = 100;

let ort = null;
try { ort = require('onnxruntime-node'); } catch { /* модуля нет — без поиска */ }

// Подряд идущие знаки CJK BERT разделяет пробелами: каждый — своё слово
const CJK = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2fa1f}]/gu;

class GalleryText {
    constructor() {
        this.mediaDir = '';
        this.loaded = null;
        this.loading = null;
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

    async has(file) { return fsp.access(file).then(() => true, () => false); }

    async hash(file) {
        const h = crypto.createHash('sha256');
        await pipeline(fs.createReadStream(file), h);
        return h.digest('hex');
    }

    // Потоком во временный файл, с суммой по ходу; зависшее соединение обрывается
    async download(spec, file) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const res = await fetch(spec.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_MS) });
        if (!res.ok || !res.body) throw new Error(`${spec.name}: HTTP ${res.status}`);
        const h = crypto.createHash('sha256');
        const tmp = `${file}.${process.pid}.tmp`;
        try {
            await pipeline(Readable.fromWeb(res.body), new Transform({ transform(chunk, enc, done) { h.update(chunk); done(null, chunk); } }), fs.createWriteStream(tmp));
            if (h.digest('hex') !== spec.sha256) throw new Error(`${spec.name}: не та контрольная сумма`);
            await fsp.rename(tmp, file);
        } finally {
            await fsp.rm(tmp, { force: true });
        }
    }

    // Модель, слой и словарь: скачать недостающее (не в OFFLINE), проверить, открыть. Не вышло — час не пробуем снова
    async load() {
        if (this.loaded) return this.loaded;
        if (!this.available || Date.now() - this.failedAt < 60 * 60 * 1000) return null;
        if (!this.loading) {
            this.loading = (async () => {
                const paths = {};
                for (const [k, spec] of Object.entries(FILES)) {
                    const file = path.join(this.mediaDir, '_models', spec.name);
                    // Оборванный или испорченный файл — заново, а не падать на нём каждый час
                    if (await this.has(file) && (await this.hash(file)) !== spec.sha256) await fsp.rm(file, { force: true });
                    if (!(await this.has(file))) {
                        if (OFFLINE) throw new Error('OFFLINE: модель не скачиваем');
                        await this.download(spec, file);
                    }
                    paths[k] = file;
                }
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
                this.loaded = { session, dense, vocab };
                return this.loaded;
            })().catch((e) => {
                this.failedAt = Date.now();
                console.warn(`[Галерея] поиск по картинкам выключен: ${e.message}`);
                return null;
            }).finally(() => { this.loading = null; });
        }
        return this.loading;
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

    // Многоязычная модель знает русские и немецкие слова заметно хуже английских («драконы» находят три картинки из
    // десяти, «dragons» — девять): ей помогает английское слово рядом. Короткий список слов (galleryTextWords.json),
    // самое длинное совпадение; слова не из списка остаются как есть. Ключ короче 5 букв («сад», «лес», «бан», «man»)
    // совпадает со словом целиком или со словом и падежным окончанием: по началу он цеплял бы «садистка», «лесбиянка»,
    // «банк», «оркестр», «mannequin». Длинный ключ — основа, ему хватает начала слова
    withEnglish(q) {
        const extra = [];
        for (const w of q.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(Boolean)) {
            for (const [lang, dict] of Object.entries(WORDS)) {
                const stem = Object.keys(dict).filter((k) => {
                    const key = k.replace(/ё/g, 'е');
                    return w.startsWith(key) && (key.length >= 5 || (ENDINGS[lang] || /^$/).test(w.slice(key.length)));
                }).sort((a, b) => b.length - a.length)[0];
                if (stem) { extra.push(dict[stem]); break; }
            }
        }
        return extra.length ? `${q}, ${[...new Set(extra)].join(' ')}` : q;
    }

    // Запрос → единичный вектор из 512 чисел, null — кодировать нечем. Среднее по словам, затем слой 768→512
    embed(text) {
        const q = String(text).trim().slice(0, 200);
        if (this.cache.has(q)) return Promise.resolve(this.cache.get(q));
        const run = this.queue.then(async () => {
            const m = await this.load();
            if (!m) return null;
            const ids = this.tokens(this.withEnglish(q), m.vocab);
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
        });
        this.queue = run.catch(() => {});
        return run;
    }
}

module.exports = new GalleryText();
module.exports.GalleryText = GalleryText;
