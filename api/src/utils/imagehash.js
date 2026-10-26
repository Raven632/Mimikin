const os = require('os');
const { spawn } = require('child_process');

// Отпечаток картинки для сверки с облачным набором (services/galleryCloud.js): dHash 8×8 — светлее ли точка соседа
// справа. Прозрачное — на чёрный (premultiply): CG без фона и в игре, и в облаке прозрачные, а цвет «под» прозрачными
// точками у копии свой — без этого отпечатки одной и той же картинки не сходились (Altair: 2 из 124, с ним — 124)
const TIMEOUT_MS = 15 * 1000;

function dhash(data) {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1',
            '-vf', 'format=rgba,premultiply=inplace=1,scale=9:8:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1']);
        // Сверка идёт фоном: не отнимаем процессор у игр и страниц
        try { os.setPriority(proc.pid, 10); } catch { /* нет прав или процесс уже вышел — не важно */ }
        const out = [];
        const timer = setTimeout(() => proc.kill('SIGKILL'), TIMEOUT_MS);
        proc.stdout.on('data', (d) => out.push(d));
        proc.stdin.on('error', () => {});
        proc.on('error', () => { clearTimeout(timer); resolve(null); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            const px = Buffer.concat(out);
            if (code !== 0 || px.length < 72) return resolve(null);
            let bits = 0n;
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
            resolve(bits.toString(16).padStart(16, '0'));
        });
        proc.stdin.end(data);
    });
}

// Сколько бит из 64 различаются
function distance(a, b) {
    let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
    let n = 0;
    while (x) { n += Number(x & 1n); x >>= 1n; }
    return n;
}

// Ширина и высота WebP (наши миниатюры — WebP): { w, h } или null
function webpSize(buf) {
    if (!buf || buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
}

module.exports = { dhash, distance, webpSize };
