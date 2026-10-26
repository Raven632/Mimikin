const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Уменьшенные копии обложек и снимков для библиотеки: карточка на телефоне — 180 точек, а обложка
// весит 70 КБ, снимок — 200. Копия — WebP нужной ширины в <кэш>/<хеш>.webp; хеш — от пути, размера
// и времени файла: поменяли картинку — сделается новая. Больше трёх сразу не делаем
const WIDTHS = [360, 720];
const inFlight = new Map();
let running = 0;
const waiting = [];

const slot = () => (running < 3 ? (running++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

// Пишем в файл, а не в поток: размер RIFF в заголовке WebP ffmpeg дописывает в конце, перемотав
// файл к началу, — в потоке он оставался нулём, и Chrome такую картинку показывал не всегда
function resize(src, width, out) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-c:v', 'libwebp', '-quality', '72', '-f', 'webp', out]);
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${code}`))));
    });
}

// Путь к готовой копии (сделает, если её ещё нет). Ширина не из списка — null: копии любой ширины
// заполнили бы диск
async function thumbnail(src, width, cacheDir) {
    width = Number(width);
    if (!WIDTHS.includes(width)) return null;
    const st = await fsp.stat(src);
    const name = crypto.createHash('sha1').update(`${src}\n${st.size}\n${st.mtimeMs}\n${width}`).digest('hex').slice(0, 24);
    const out = path.join(cacheDir, `${name}.webp`);
    if (await fsp.access(out).then(() => true, () => false)) return out;
    if (!inFlight.has(out)) {
        inFlight.set(out, (async () => {
            await slot();
            try {
                await fsp.mkdir(cacheDir, { recursive: true });
                const tmp = `${out}.${process.pid}.tmp`;
                try {
                    await resize(src, width, tmp);
                    await fsp.rename(tmp, out);
                } finally {
                    await fsp.rm(tmp, { force: true });
                }
                return out;
            } finally {
                release();
            }
        })().finally(() => inFlight.delete(out)));
    }
    return inFlight.get(out);
}

module.exports = { thumbnail, WIDTHS };
