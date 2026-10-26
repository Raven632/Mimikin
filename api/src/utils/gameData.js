const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// Файлы игры, которые автор зашифровал поверх RPG Maker. Sky Knight of the Blue Sea держит System.json и события в
// AES (CryptoJS, формат OpenSSL «Salted__», в base64 — «U2FsdGVkX1…»), а пароль — в своём же коде:
// CryptoJS.AES.decrypt(file, "…") в rmmz_managers.js. Игра в браузере расшифровывает так же; галерее и звуку без
// этого не прочитать ни событий, ни ключа картинок
const SALTED = 'U2FsdGVkX1';
const PASS_RE = /AES\s*\.\s*decrypt\s*\(\s*[\w$.[\]]+\s*,\s*(["'])((?:\\.|(?!\1)[^\\\n])+)\1/g;
const JS_MAX = 8 * 1024 * 1024;
const passes = new Map();      // папка игры → Promise<пароли из кода (у плагинов сохранений бывают свои)>
const keys = new Map();        // папка игры → Promise<ключ картинок (hex) | ''>
const CACHE_MAX = 200;

const remember = (map, k, v) => { if (map.size >= CACHE_MAX) map.delete(map.keys().next().value); map.set(k, v); return v; };

// Пустые ответы не запоминаем: игру могли докачивать или распаковывать, и в следующий раз найдётся
function cached(map, root, make) {
    if (map.has(root)) return map.get(root);
    const job = make().then((v) => { if (!v || (Array.isArray(v) && !v.length)) map.delete(root); return v; }, (e) => { map.delete(root); throw e; });
    return remember(map, root, job);
}

function aesPasses(root) {
    return cached(passes, root, async () => {
        const found = [];
        for (const dir of ['js', path.join('js', 'plugins')]) {
            let names = [];
            try { names = (await fsp.readdir(path.join(root, dir))).filter((n) => n.endsWith('.js')); } catch { continue; }
            for (const n of names) {
                const file = path.join(root, dir, n);
                const st = await fsp.stat(file).catch(() => null);
                if (!st || st.size > JS_MAX) continue;
                for (const m of (await fsp.readFile(file, 'utf8').catch(() => '')).matchAll(PASS_RE)) {
                    const pass = m[2].replace(/\\(.)/g, '$1');
                    if (!found.includes(pass)) found.push(pass);
                }
            }
        }
        return found;
    });
}

// OpenSSL: соль после «Salted__», ключ и IV — EVP_BytesToKey на MD5 (так делает CryptoJS с паролем-строкой)
function opensslDecrypt(b64, pass) {
    const buf = Buffer.from(b64.trim(), 'base64');
    if (buf.subarray(0, 8).toString('latin1') !== 'Salted__') throw new Error('не OpenSSL');
    const salt = buf.subarray(8, 16);
    let d = Buffer.alloc(0);
    let prev = Buffer.alloc(0);
    while (d.length < 48) { prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(pass, 'utf8'), salt])).digest(); d = Buffer.concat([d, prev]); }
    const decipher = crypto.createDecipheriv('aes-256-cbc', d.subarray(0, 32), d.subarray(32, 48));
    return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
}

// Текст файла игры: обычный — как есть, зашифрованный AES — расшифрованный (пароля не нашли — как есть)
async function readGameText(root, file) {
    const text = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
    if (!text.startsWith(SALTED)) return text;
    // Паролей в коде бывает несколько: подходит тот, с которым текст расшифровывается без ошибки
    for (const pass of await aesPasses(root)) {
        try { return opensslDecrypt(text, pass).replace(/^﻿/, ''); } catch { /* следующий */ }
    }
    return text;
}

async function readGameJson(root, file) {
    try { return JSON.parse(await readGameText(root, file)); } catch { return null; }
}

// Первая зашифрованная картинка игры: сначала img/pictures, потом остальные папки img
async function encryptedSample(root) {
    const img = path.join(root, 'img');
    let dirs = [];
    try { dirs = (await fsp.readdir(img, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
    dirs.sort((a, b) => (b === 'pictures') - (a === 'pictures'));
    for (const d of dirs) {
        let names = [];
        try { names = await fsp.readdir(path.join(img, d)); } catch { continue; }
        const n = names.find((x) => /\.(png_|rpgmvp)$/i.test(x));
        if (n) return path.join(img, d, n);
    }
    return null;
}

// Ключ картинок и звука (hex): из System.json; нет его там (System.json зашифрован, ключ вырезан) — из самой
// картинки: первые 16 байт PNG у всех одни и те же, а в файле они сложены с ключом по XOR
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
function mediaKey(root) {
    return cached(keys, root, async () => {
        const system = await readGameJson(root, path.join(root, 'data', 'System.json'));
        if (system && typeof system.encryptionKey === 'string' && /^[0-9a-f]{32}$/i.test(system.encryptionKey)) return system.encryptionKey;
        const sample = await encryptedSample(root);
        if (!sample) return '';
        const fh = await fsp.open(sample, 'r').catch(() => null);
        if (!fh) return '';
        try {
            const buf = Buffer.alloc(32);
            const { bytesRead } = await fh.read(buf, 0, 32, 0);
            if (bytesRead < 32 || buf.subarray(0, 4).toString('latin1') !== 'RPGM') return '';
            return Buffer.from(buf.subarray(16, 32).map((b, i) => b ^ PNG_HEAD[i])).toString('hex');
        } finally {
            await fh.close();
        }
    });
}

// Игру обновили — пароль и ключ могли смениться
function forgetGame(root) {
    passes.delete(root);
    keys.delete(root);
}

module.exports = { readGameText, readGameJson, mediaKey, forgetGame, opensslDecrypt };
