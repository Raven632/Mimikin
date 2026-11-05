// Раздача собранного демо для обхода (tour.spec.mjs) под тем же путём, что на GitHub Pages: /Mimikin/demo/.
// Не под корнем нарочно: демо должно работать из подпапки, а ошибка в относительных адресах под корнем не видна.
// Запуск: node tests/demo/serve.mjs [папка]. DEMO_DIST — папка сборки (по умолчанию frontend/dist-demo), DEMO_PORT — порт
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.resolve(process.argv[2] || process.env.DEMO_DIST || path.join(ROOT, 'frontend/dist-demo'));
const PORT = Number(process.env.DEMO_PORT || 4173);
const PREFIX = '/Mimikin/demo/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.webm': 'video/webm', '.mp4': 'video/mp4',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === PREFIX.slice(0, -1)) { res.writeHead(301, { location: PREFIX + url.search }); res.end(); return; }
  if (!url.pathname.startsWith(PREFIX)) { res.writeHead(404); res.end('not found'); return; }
  let file = path.join(DIST, decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html');
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (file.endsWith(path.sep) || (fs.existsSync(file) && fs.statSync(file).isDirectory())) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  // Звук и видео браузер просит кусками (Range): без ответа 206 перемотка не работает ни здесь, ни в Safari
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.error(`[demo] ${DIST} на http://127.0.0.1:${PORT}${PREFIX}`));
