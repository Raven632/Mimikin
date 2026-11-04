const crypto = require('crypto');
const { spawn } = require('child_process');
const { ModelHolder, registerModels, downloadModel, modelFile, modelFailed } = require('./galleryModels.js');

// Что нарисовано на картинке — для галереи: сцена или экран игры (меню, статус, карточка персонажа, фон без людей,
// карта, титры, предмет). По файлам их не отличить — все во весь экран и плотные, — а по рисунку можно. Модель CLIP
// (часть «картинка», сжатая, 85 МБ) сравнивает картинку с подписями; подписи посчитаны заранее
// (galleryVisionLabels.json), их модель «текста» серверу не нужна. Всё на самом сервере, без сети: модель скачивается
// один раз в _media/_models и проверяется по контрольной сумме. Нет модуля onnxruntime-node или модели — служба
// выключена, галерея работает как без неё
const MODEL = {
    url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx',
    name: 'clip-vit-b32-vision-q8.onnx',
    sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
    size: 89117001,
};
registerModels([MODEL]);
const SIZE = 224;
// Нормировка CLIP (preprocessor_config.json модели)
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const LABELS = require('./galleryVisionLabels.json');
// Сменились подписи или модель — прежние ответы уже не те. Векторы картинок версию не меняют: их дописывает
// visionPass к готовым ответам, а сами ответы остаются
const VERSION = crypto.createHash('sha1').update(JSON.stringify(LABELS)).digest('hex').slice(0, 12);
const TIMEOUT_MS = 30 * 1000;

let ort = null;
try { ort = require('onnxruntime-node'); } catch { /* модуля нет — без распознавания */ }

class GalleryVision {
    constructor() {
        this.mediaDir = '';
        this.hold = new ModelHolder(() => this.open());
        this.failedAt = 0;
        this.queue = Promise.resolve();
        this.version = VERSION;
        // Векторы кадров для поиска зависят только от модели, не от подписей: разбор всех кадров (gallery.js, picturePass)
        // сверяется с ней
        this.embedModel = MODEL.sha256.slice(0, 12);
    }

    setDependencies({ mediaDir }) {
        this.mediaDir = mediaDir;
    }

    // GALLERY_VISION=0 — выключено (тесты: модель не качаем)
    get available() {
        return !!ort && !!this.mediaDir && process.env.GALLERY_VISION !== '0';
    }

    // Модель: скачать один раз (не в OFFLINE), проверить сумму, открыть. Не вышло — час не пробуем снова
    async open() {
        if (!this.available || Date.now() - this.failedAt < 60 * 60 * 1000) return null;
        try {
            return await ort.InferenceSession.create(await modelFile(MODEL, this.mediaDir), { intraOpNumThreads: 1, interOpNumThreads: 1 });
        } catch (e) {
            this.failedAt = modelFailed();
            console.warn(`[Галерея] распознавание картинок выключено: ${e.message}`);
            return null;
        }
    }

    download(file) {
        return downloadModel(MODEL, file);
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
        const run = this.queue.then(() => this.hold.use(async (session) => {
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
        }));
        this.queue = run.catch(() => {});
        return run;
    }
}

module.exports = new GalleryVision();
module.exports.GalleryVision = GalleryVision;
