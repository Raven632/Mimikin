const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { OFFLINE } = require('../config/index.js');

// Что нарисовано на картинке — для галереи: сцена или экран игры (меню, статус, карточка персонажа, фон без людей,
// карта, титры, предмет). По файлам их не отличить — все во весь экран и плотные, — а по рисунку можно. Модель CLIP
// (часть «картинка», сжатая, 85 МБ) сравнивает картинку с подписями; подписи посчитаны заранее
// (galleryVisionLabels.json), их модель «текста» серверу не нужна. Всё на самом сервере, без сети: модель скачивается
// один раз в _media/_models и проверяется по контрольной сумме. Нет модуля onnxruntime-node или модели — служба
// выключена, галерея работает как без неё
const MODEL_URL = 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx';
const MODEL_SHA256 = '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299';
const MODEL_FILE = 'clip-vit-b32-vision-q8.onnx';
const SIZE = 224;
// Нормировка CLIP (preprocessor_config.json модели)
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const LABELS = require('./galleryVisionLabels.json');
// Сменились подписи или модель — прежние ответы уже не те. Векторы картинок версию не меняют: их дописывает
// visionPass к готовым ответам, а сами ответы остаются
const VERSION = crypto.createHash('sha1').update(JSON.stringify(LABELS)).digest('hex').slice(0, 12);
const TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_MS = 10 * 60 * 1000;

let ort = null;
try { ort = require('onnxruntime-node'); } catch { /* модуля нет — без распознавания */ }

class GalleryVision {
    constructor() {
        this.mediaDir = '';
        this.session = null;
        this.loading = null;
        this.failedAt = 0;
        this.queue = Promise.resolve();
        this.version = VERSION;
    }

    setDependencies({ mediaDir }) {
        this.mediaDir = mediaDir;
    }

    // GALLERY_VISION=0 — выключено (тесты: модель не качаем)
    get available() {
        return !!ort && !!this.mediaDir && process.env.GALLERY_VISION !== '0';
    }

    // Модель: скачать один раз (не в OFFLINE), проверить сумму, открыть. Не вышло — час не пробуем снова
    async model() {
        if (this.session) return this.session;
        if (!this.available || Date.now() - this.failedAt < 60 * 60 * 1000) return null;
        if (!this.loading) {
            this.loading = (async () => {
                const file = path.join(this.mediaDir, '_models', MODEL_FILE);
                // Файл оборвался или испорчен — скачать заново, а не падать на нём каждый час
                if (await fsp.access(file).then(() => true, () => false) && (await this.hash(file)) !== MODEL_SHA256) await fsp.rm(file, { force: true });
                if (!(await fsp.access(file).then(() => true, () => false))) {
                    if (OFFLINE) throw new Error('OFFLINE: модель не скачиваем');
                    await this.download(file);
                }
                this.session = await ort.InferenceSession.create(file, { intraOpNumThreads: 1, interOpNumThreads: 1 });
                return this.session;
            })().catch((e) => {
                this.failedAt = Date.now();
                console.warn(`[Галерея] распознавание картинок выключено: ${e.message}`);
                return null;
            }).finally(() => { this.loading = null; });
        }
        return this.loading;
    }

    async hash(file) {
        const h = crypto.createHash('sha256');
        await pipeline(fs.createReadStream(file), h);
        return h.digest('hex');
    }

    // Потоком во временный файл, с суммой по ходу; зависшее соединение обрывается — очередь распознавания не встаёт
    async download(file) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const res = await fetch(MODEL_URL, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_MS) });
        if (!res.ok || !res.body) throw new Error(`модель: HTTP ${res.status}`);
        const h = crypto.createHash('sha256');
        const tmp = `${file}.${process.pid}.tmp`;
        try {
            await pipeline(Readable.fromWeb(res.body), new Transform({ transform(chunk, enc, done) { h.update(chunk); done(null, chunk); } }), fs.createWriteStream(tmp));
            if (h.digest('hex') !== MODEL_SHA256) throw new Error('модель: не та контрольная сумма');
            await fsp.rename(tmp, file);
        } finally {
            await fsp.rm(tmp, { force: true });
        }
    }

    // Пиксели 224×224 (короткая сторона — 224, середина), RGB — ffmpeg
    pixels(file) {
        return new Promise((resolve, reject) => {
            // Прозрачное — на тёмном, как в галерее: пустой холст вокруг фигуры не должен читаться как белый фон
            const proc = spawn('ffmpeg', ['-v', 'error', '-i', file, '-filter_complex',
                `color=c=0x181818:s=${SIZE}x${SIZE}[b];[0:v]scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase:flags=bicubic,crop=${SIZE}:${SIZE}[f];[b][f]overlay=format=auto,format=rgb24`,
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

    // Насколько картинка похожа на сцену: 0…1 — доля подписей «сцена» среди всех. null — распознать нечем. Вектор
    // картинки (512 чисел, длина 1) модель всё равно считает — отдаём его в seen.embed для поиска по картинкам
    score(file, seen = {}) {
        // По одной: модели хватает одного ядра, остальные — играм и страницам
        const run = this.queue.then(async () => {
            const session = await this.model();
            if (!session) return null;
            const raw = await this.pixels(file);
            const px = new Float32Array(3 * SIZE * SIZE);
            for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) px[c * SIZE * SIZE + i] = (raw[i * 3 + c] / 255 - MEAN[c]) / STD[c];
            const out = await session.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, SIZE, SIZE]) });
            const e = Array.from(out.image_embeds.data);
            const n = Math.hypot(...e) || 1;
            seen.embed = e.map((x) => x / n);
            const logits = LABELS.embeds.map((t) => (100 * t.reduce((a, x, i) => a + x * e[i], 0)) / n);
            const m = Math.max(...logits);
            const ex = logits.map((l) => Math.exp(l - m));
            const z = ex.reduce((a, b) => a + b, 0);
            return ex.slice(0, LABELS.scene.length).reduce((a, b) => a + b, 0) / z;
        });
        this.queue = run.catch(() => {});
        return run;
    }
}

module.exports = new GalleryVision();
module.exports.GalleryVision = GalleryVision;
