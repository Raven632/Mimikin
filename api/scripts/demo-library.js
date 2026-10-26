#!/usr/bin/env node
// Демо-библиотека Mimikin: шестнадцать выдуманных игр с пиксельными обложками, кадрами и картинками
// для галереи. Для автотестов (tests/e2e), скриншотов README и чтобы попробовать библиотеку без своих игр.
//
//   node scripts/demo-library.js <папка> [--reset] [--user имя --password пароль]
//
// В настоящую библиотеку не пишет: если в папке уже есть library.db, а метки демо (.mimikin-demo) нет,
// отказывается. --reset стирает только папку, помеченную как демо. Учётная запись — по желанию:
// без неё библиотека при первом входе попросит её завести. Сервер с демо запускают с OFFLINE=1 —
// искать данные выдуманных игр в интернете незачем. DEMO_NOW=2026-10-03T12:00:00Z — «сегодня» для дат
// игр (добавлена, вышла, запускалась): у снимков экрана они не должны меняться от дня к дню
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const args = process.argv.slice(2);
const dir = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!dir) {
    console.error('Использование: node scripts/demo-library.js <папка> [--reset] [--user имя --password пароль]');
    process.exit(2);
}
const MARK = path.join(dir, '.mimikin-demo');

// Пути сервера (config/index.js) читаются при загрузке модулей — до них
process.env.GAMES_DIR = dir;
process.env.REDIS_URL = process.env.REDIS_URL || 'memory';

// ---------------------------------------------------------------- PNG без графических библиотек
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function encodePng(w, h, rgb) {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
    const chunk = (type, data) => {
        const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
        return Buffer.concat([head, body, tail]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- холст в «игровых» пикселях
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

class Canvas {
    constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8Array(w * h * 3); }
    set(x, y, c) {
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        this.px.set(c, (y * this.w + x) * 3);
    }
    rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
    // Вертикальный перелив в несколько тонов с упорядоченным растром — как в 16-битных играх
    gradient(y0, y1, colors) {
        for (let y = y0; y < y1; y++) {
            const t = (y - y0) / Math.max(1, y1 - y0 - 1) * (colors.length - 1);
            const i = Math.min(colors.length - 2, Math.floor(t));
            const f = t - i;
            for (let x = 0; x < this.w; x++) this.set(x, y, f > BAYER[(y % 4) * 4 + (x % 4)] ? colors[i + 1] : colors[i]);
        }
    }
    disc(cx, cy, r, c) { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) this.set(cx + x, cy + y, c); }
    tri(x0, y0, base, h, c) { for (let j = 0; j < h; j++) { const half = Math.round((j / h) * base / 2); this.rect(x0 - half, y0 + j, half * 2 + 1, 1, c); } }
    png(scale) {
        const W = this.w * scale, H = this.h * scale, out = Buffer.alloc(W * H * 3);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = ((Math.floor(y / scale) * this.w) + Math.floor(x / scale)) * 3;
            out[(y * W + x) * 3] = this.px[s]; out[(y * W + x) * 3 + 1] = this.px[s + 1]; out[(y * W + x) * 3 + 2] = this.px[s + 2];
        }
        return encodePng(W, H, out);
    }
}

function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- пиксельный шрифт 5×7
const FONT = {
    A: '.###.#...##...#######...##...##...#', B: '####.#...##...#####.#...##...#####.', C: '.###.#...##....#....#....#...#.###.',
    D: '####.#...##...##...##...##...#####.', E: '######....#....####.#....#....#####', F: '######....#....####.#....#....#....',
    G: '.###.#...##....#.####...##...#.####', H: '#...##...##...#######...##...##...#', I: '.###...#....#....#....#....#...###.',
    J: '..###...#....#....#.#..#.#..#..##..', K: '#...##..#.#.#..##...#.#..#..#.#...#', L: '#....#....#....#....#....#....#####',
    M: '#...###.###.#.##.#.##...##...##...#', N: '#...###..##.#.##..###...##...##...#', O: '.###.#...##...##...##...##...#.###.',
    P: '####.#...##...#####.#....#....#....', Q: '.###.#...##...##...##.#.##..#..##.#', R: '####.#...##...#####.#.#..#..#.#...#',
    S: '.#####....#.....###.....#....#####.', T: '#####..#....#....#....#....#....#..', U: '#...##...##...##...##...##...#.###.',
    V: '#...##...##...##...##...#.#.#...#..', W: '#...##...##...##.#.##.#.##.#.#.#.#.', X: '#...##...#.#.#...#...#.#.#...##...#',
    Y: '#...##...#.#.#...#....#....#....#..', Z: '#####....#...#...#...#...#....#####',
    0: '.###.#...##..###.#.###..##...#.###.', 1: '..#...##....#....#....#....#...###.', 2: '.###.#...#....#...#...#...#...#####',
    3: '####.....#....#.###.....#....#####.', 4: '...#...##..#.#.#..#.#####...#....#.', 5: '######....####.....#....##...#.###.',
    6: '.###.#....#....####.#...##...#.###.', 7: '#####....#...#...#...#....#....#...', 8: '.###.#...##...#.###.#...##...#.###.',
    9: '.###.#...##...#.####....#....#.###.', "'": '..#....#...#.......................', '!': '..#....#....#....#....#.........#..',
    '.': '................................#..', ',': '..........................#...#....', ':': '.......#.................#.........',
    '-': '................###................', '&': '.##..#..#.#.#...#...#.#.##..#..##.#', '?': '.###.#...#....#...#...#.........#..',
    ' ': '...................................',
};
function text(cv, str, x, y, color, shadow) {
    const s = str.toUpperCase();
    for (const [dx, dy] of shadow ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]] : []) {
        drawText(cv, s, x + dx, y + dy, shadow);
    }
    drawText(cv, s, x, y, color);
}
function drawText(cv, s, x, y, color) {
    let cx = x;
    for (const ch of s) {
        const g = (FONT[ch] || FONT[' ']).padEnd(35, '.');
        for (let i = 0; i < 35; i++) if (g[i] === '#') cv.set(cx + (i % 5), y + Math.floor(i / 5), color);
        cx += 6;
    }
}
const textWidth = (s) => s.length * 6 - 1;
const latinTitle = (s) => /^[A-Za-z0-9 '!.,:&?-]+$/.test(s);

// ---------------------------------------------------------------- сцены обложек
const PAL = {
    night:  { sky: ['#0b0a1f', '#1c1846', '#3a2a6b', '#6b3f7a'], far: '#22204a', near: '#14122e', ground: '#0f0d22', light: '#ffd76a', accent: '#f4efe0' },
    dusk:   { sky: ['#2a1a3d', '#7a3a5a', '#e0705a', '#ffb56b'], far: '#5a2f4f', near: '#2b1830', ground: '#1b1020', light: '#ffe08a', accent: '#fff1c2' },
    day:    { sky: ['#5fb8ff', '#8fd3ff', '#c8ecff'], far: '#6c9bd1', near: '#3f7a4a', ground: '#2e5a35', light: '#fff4b0', accent: '#ffffff' },
    snow:   { sky: ['#6d8fc9', '#a9c4ea', '#e6f0ff'], far: '#c9d8f0', near: '#f3f7ff', ground: '#dfe8f6', light: '#ffd76a', accent: '#ffffff' },
    desert: { sky: ['#f08a4b', '#f7b267', '#ffe0a3'], far: '#d98a4e', near: '#c56b35', ground: '#e0a35a', light: '#fff1c2', accent: '#5a2c18' },
    sea:    { sky: ['#1d2b5a', '#3a5ea8', '#8fb8e8'], far: '#2c4a86', near: '#173264', ground: '#0e2148', light: '#ffe9a8', accent: '#e8f4ff' },
    cave:   { sky: ['#07060a', '#141019', '#241a24'], far: '#2a2030', near: '#1a1420', ground: '#120e16', light: '#ffb347', accent: '#c9a84c' },
    copper: { sky: ['#2b1c14', '#5a3422', '#a3683a', '#e0a35a'], far: '#4a2c1c', near: '#2a1810', ground: '#1c100a', light: '#ffd27a', accent: '#c98b4c' },
};
const C = (s) => hex(s);

function ridge(cv, base, amp, color, rand, rough = 0.35) {
    const a = rand() * 6, b = rand() * 6, f1 = 0.05 + rand() * 0.05, f2 = 0.15 + rand() * 0.15;
    for (let x = 0; x < cv.w; x++) {
        const y = Math.round(base - amp * (0.55 + 0.45 * Math.sin(x * f1 + a)) - amp * rough * Math.sin(x * f2 + b));
        cv.rect(x, y, 1, cv.h - y, color);
    }
}
function stars(cv, n, rand, maxY, color) { for (let i = 0; i < n; i++) cv.set(Math.floor(rand() * cv.w), Math.floor(rand() * maxY), color); }
function castle(cv, x, base, p) {
    const wall = C(p.near), win = C(p.light);
    cv.rect(x, base - 14, 30, 14, wall);
    for (const [tx, h] of [[x - 4, 26], [x + 13, 32], [x + 30, 24]]) {
        cv.rect(tx, base - h, 8, h, wall);
        for (let k = 0; k < 4; k++) cv.rect(tx + k * 2, base - h - 2, 1, 2, wall);
        cv.rect(tx + 3, base - h + 6, 2, 3, win);
    }
    cv.tri(x + 17, base - 44, 10, 12, wall);
    cv.rect(x + 12, base - 6, 6, 6, C('#000000'));
    for (const wx of [x + 4, x + 22]) cv.rect(wx, base - 10, 2, 2, win);
}
function house(cv, x, base, w, h, roof, wall, win) {
    cv.rect(x, base - h, w, h, wall);
    for (let j = 0; j < 6; j++) cv.rect(x - 1 + j, base - h - 6 + j, w + 2 - j * 2, 1, roof);
    cv.rect(x + 2, base - h + 2, 2, 2, win);
    cv.rect(x + w - 4, base - h + 2, 2, 2, win);
    cv.rect(x + Math.floor(w / 2) - 1, base - 4, 3, 4, C('#2a1810'));
}
function pine(cv, x, base, h, color) { cv.tri(x, base - h, Math.round(h * 0.7), h - 2, color); cv.rect(x, base - 2, 1, 2, C('#2a1a12')); }
function chest(cv, x, y, gold, dark, eye) {
    cv.rect(x, y + 6, 18, 9, gold);
    cv.rect(x + 1, y, 16, 5, gold);
    cv.rect(x, y + 5, 18, 1, dark);
    for (let k = 0; k < 4; k++) { cv.set(x + 3 + k * 4, y + 6, C('#fff1c2')); cv.set(x + 4 + k * 4, y + 4, C('#fff1c2')); }
    cv.rect(x + 5, y + 3, 2, 1, eye); cv.rect(x + 11, y + 3, 2, 1, eye);
    cv.rect(x + 8, y + 9, 2, 3, dark);
}

const SCENES = {
    castle(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C)); stars(cv, 40, rand, 40, C(p.accent));
        cv.disc(100, 18, 7, C(p.accent)); cv.disc(103, 16, 6, C(p.sky[1]));
        ridge(cv, 58, 12, C(p.far), rand); castle(cv, 46, 64, p); ridge(cv, 72, 6, C(p.ground), rand, 0.2);
    },
    inn(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C)); stars(cv, 25, rand, 30, C(p.accent));
        ridge(cv, 56, 8, C(p.far), rand);
        cv.rect(0, 62, cv.w, 18, C(p.ground));
        house(cv, 18, 62, 22, 14, C('#7a2f2f'), C('#c49a6c'), C(p.light));
        house(cv, 52, 62, 28, 18, C('#5a2f5a'), C('#d6b48c'), C(p.light));
        house(cv, 92, 62, 20, 12, C('#2f4f7a'), C('#c49a6c'), C(p.light));
        cv.rect(81, 48, 1, 14, C('#2a1a12')); cv.rect(77, 46, 9, 4, C(p.light));
    },
    forest(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C)); ridge(cv, 50, 10, C(p.far), rand);
        for (let i = 0; i < 16; i++) pine(cv, 4 + i * 8 + Math.floor(rand() * 4), 64, 16 + Math.floor(rand() * 10), C('#1f4a33'));
        cv.rect(0, 64, cv.w, 16, C(p.ground));
        for (let i = 0; i < 9; i++) pine(cv, Math.floor(rand() * cv.w), 80, 22 + Math.floor(rand() * 10), C('#123322'));
        cv.disc(64, 70, 3, C('#ff9a3c')); cv.disc(64, 69, 1, C('#fff1c2'));
    },
    sea(cv, p, rand) {
        cv.gradient(0, 46, p.sky.map(C)); cv.disc(30, 40, 9, C(p.light));
        for (let y = 46; y < cv.h; y++) for (let x = 0; x < cv.w; x++) cv.set(x, y, (y + Math.floor(x / 7)) % 5 === 0 ? C(p.accent) : C(y < 60 ? p.far : p.near));
        cv.rect(70, 40, 26, 4, C('#2a1810')); cv.tri(83, 18, 18, 20, C(p.accent)); cv.rect(82, 18, 1, 22, C('#2a1810'));
    },
    cave(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C));
        for (let i = 0; i < 70; i++) cv.rect(Math.floor(rand() * cv.w), Math.floor(rand() * 40), 3, 2, C(p.far));
        cv.rect(0, 62, cv.w, 18, C(p.ground));
        for (const tx of [22, 106]) { cv.rect(tx, 40, 2, 10, C('#4a3020')); cv.disc(tx + 1, 38, 3, C('#ff9a3c')); cv.disc(tx + 1, 37, 1, C('#fff1c2')); }
        chest(cv, 55, 46, C(p.accent), C('#2a1810'), C('#ffd76a'));
    },
    lighthouse(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C)); stars(cv, 30, rand, 30, C(p.accent));
        for (let k = 0; k < 18; k++) cv.rect(36 + k * 3, 21 - k, 3, 1 + Math.floor(k / 3), C('#3a3a6a'));
        cv.rect(0, 58, cv.w, 22, C(p.far));
        for (let y = 58; y < cv.h; y += 3) cv.rect(Math.floor(rand() * cv.w), y, 6, 1, C(p.accent));
        cv.rect(14, 50, 40, 30, C(p.near));
        cv.rect(26, 22, 8, 28, C('#e8e0d0')); for (let y = 26; y < 50; y += 8) cv.rect(26, y, 8, 3, C('#a83a3a'));
        cv.rect(25, 18, 10, 4, C(p.light)); cv.tri(30, 12, 8, 6, C('#a83a3a'));
    },
    floating(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C));
        for (let i = 0; i < 5; i++) { const x = Math.floor(rand() * cv.w); cv.rect(x, 10 + i * 6, 14, 2, C(p.accent)); }
        for (const [x, y, w] of [[18, 44, 30], [70, 30, 40], [104, 56, 20]]) {
            cv.rect(x, y, w, 3, C('#4caf50'));
            for (let j = 0; j < 10; j++) cv.rect(x + j, y + 3 + j, w - j * 2, 1, C('#6b4a2a'));
            cv.rect(x + Math.floor(w / 2), y + 3, 1, 20, C('#9fd8ff'));
        }
        castle(cv, 76, 30, { near: '#e8e0d0', light: '#3a5ea8' });
    },
    desert(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C)); cv.disc(96, 26, 10, C(p.light));
        ridge(cv, 58, 6, C(p.far), rand, 0.1);
        cv.tri(40, 26, 44, 32, C('#b8763d')); for (let j = 0; j < 32; j++) cv.rect(40, 26 + j, Math.round(j * 0.7), 1, C('#8a5228'));
        ridge(cv, 72, 5, C(p.near), rand, 0.1);
        cv.rect(100, 52, 2, 14, C(p.accent)); cv.rect(97, 56, 8, 1, C(p.accent));
    },
    snow(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C));
        for (const [x, h] of [[20, 44], [64, 54], [108, 40]]) { cv.tri(x, 70 - h, h * 1.4, h, C('#8fa8cf')); cv.tri(x, 70 - h, h * 0.5, Math.round(h * 0.35), C(p.accent)); }
        cv.rect(0, 66, cv.w, 14, C(p.ground));
        house(cv, 30, 70, 16, 10, C('#a83a3a'), C('#6b4a2a'), C(p.light)); house(cv, 84, 70, 18, 11, C('#3a5ea8'), C('#6b4a2a'), C(p.light));
        for (let i = 0; i < 60; i++) cv.set(Math.floor(rand() * cv.w), Math.floor(rand() * cv.h), C('#ffffff'));
    },
    clockwork(cv, p, rand) {
        cv.gradient(0, cv.h, p.sky.map(C));
        for (const [x, y, r] of [[28, 30, 14], [96, 22, 10], [70, 50, 18]]) {
            cv.disc(x, y, r, C(p.far)); cv.disc(x, y, Math.round(r * 0.45), C(p.sky[1]));
            for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; cv.rect(Math.round(x + Math.cos(a) * (r + 1)) - 1, Math.round(y + Math.sin(a) * (r + 1)) - 1, 3, 3, C(p.far)); }
        }
        cv.rect(0, 64, cv.w, 16, C(p.ground));
        for (let i = 0; i < 6; i++) { const x = 8 + i * 21; cv.rect(x, 44 - (i % 3) * 6, 10, 20 + (i % 3) * 6, C(p.near)); cv.rect(x + 3, 48 - (i % 3) * 6, 2, 2, C(p.light)); }
    },
};

function cover(game) {
    const cv = new Canvas(128, 80), rand = rng(game.seed);
    SCENES[game.scene](cv, PAL[game.palette], rand);
    if (latinTitle(game.coverTitle)) {
        const words = game.coverTitle.toUpperCase().split(' ');
        const lines = textWidth(game.coverTitle) > 118 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [game.coverTitle];
        lines.forEach((line, i) => text(cv, line, Math.round((128 - textWidth(line)) / 2), 5 + i * 9, C('#fff1c2'), C('#1a1020')));
    }
    return cv.png(3);
}

// ---------------------------------------------------------------- кадры «из игры» в духе RPG Maker
const TILE = {
    grass(cv, x, y, r) { cv.rect(x, y, 8, 8, C('#4f9a4a')); for (let k = 0; k < 3; k++) cv.set(x + Math.floor(r() * 8), y + Math.floor(r() * 8), C('#3d7f3a')); },
    path(cv, x, y) { cv.rect(x, y, 8, 8, C('#d8b47a')); cv.set(x + 2, y + 5, C('#c49a62')); cv.set(x + 6, y + 2, C('#c49a62')); },
    water(cv, x, y) { cv.rect(x, y, 8, 8, C('#3a7fd0')); cv.rect(x + 1, y + 3, 3, 1, C('#8fc8ff')); cv.rect(x + 5, y + 6, 2, 1, C('#8fc8ff')); },
    floor(cv, x, y) { cv.rect(x, y, 8, 8, C('#4a4458')); cv.rect(x, y, 8, 1, C('#5a5468')); cv.rect(x, y, 1, 8, C('#5a5468')); },
    wall(cv, x, y) { cv.rect(x, y, 8, 8, C('#2a2433')); cv.rect(x, y + 3, 8, 1, C('#3a3344')); cv.rect(x + 4, y, 1, 3, C('#3a3344')); },
};
function sprite(cv, x, y, body, hair) {
    cv.rect(x + 2, y, 4, 3, hair); cv.rect(x + 2, y + 2, 4, 2, C('#f2c9a0')); cv.rect(x + 1, y + 4, 6, 3, body); cv.rect(x + 2, y + 7, 1, 1, C('#2a1810')); cv.rect(x + 5, y + 7, 1, 1, C('#2a1810'));
}
// Окно сообщения внизу кадра, как в RPG Maker: текст переносится по словам, не больше двух строк
function messageBox(cv, line1, line2) {
    const max = Math.floor((cv.w - 14) / 6);
    const lines = [];
    for (const word of `${line1} ${line2 || ''}`.trim().split(/\s+/)) {
        const last = lines[lines.length - 1];
        if (last && (last + ' ' + word).length <= max) lines[lines.length - 1] = last + ' ' + word;
        else lines.push(word);
    }
    const shown = lines.slice(0, 2), h = 8 + shown.length * 9, y = cv.h - h - 3;
    cv.rect(3, y, cv.w - 6, h, C('#14102a'));
    cv.rect(3, y, cv.w - 6, 1, C('#c9a84c')); cv.rect(3, y + h - 1, cv.w - 6, 1, C('#c9a84c'));
    cv.rect(3, y, 1, h, C('#c9a84c')); cv.rect(cv.w - 4, y, 1, h, C('#c9a84c'));
    shown.forEach((line, i) => text(cv, line, 8, y + 4 + i * 9, i ? C('#c9c2e0') : C('#fff1c2')));
}
function townShot(game, seed) {
    const cv = new Canvas(128, 96), r = rng(seed);
    for (let ty = 0; ty < 12; ty++) for (let tx = 0; tx < 16; tx++) TILE.grass(cv, tx * 8, ty * 8, r);
    for (let tx = 0; tx < 16; tx++) TILE.path(cv, tx * 8, 40);
    for (let ty = 0; ty < 9; ty++) TILE.path(cv, 64, ty * 8);
    for (let ty = 1; ty < 4; ty++) for (let tx = 11; tx < 15; tx++) TILE.water(cv, tx * 8, ty * 8);
    house(cv, 12, 36, 22, 12, C('#7a2f2f'), C('#d6b48c'), C('#ffd76a'));
    house(cv, 84, 72, 20, 12, C('#2f4f7a'), C('#d6b48c'), C('#ffd76a'));
    for (let i = 0; i < 6; i++) { const x = 8 + Math.floor(r() * 110), y = 50 + Math.floor(r() * 20); cv.disc(x, y, 3, C('#2e6b34')); cv.rect(x, y + 3, 1, 2, C('#5a3a22')); }
    sprite(cv, 60, 30, C('#3a5ea8'), C('#6b3a1a')); sprite(cv, 76, 30, C('#a83a5a'), C('#e0c070'));
    messageBox(cv, game.line1, game.line2);
    return cv.png(3);
}
function dungeonShot(game, seed) {
    const cv = new Canvas(128, 96), r = rng(seed);
    for (let ty = 0; ty < 12; ty++) for (let tx = 0; tx < 16; tx++) (ty < 3 || tx === 0 || tx === 15 ? TILE.wall : TILE.floor)(cv, tx * 8, ty * 8, r);
    for (const tx of [3, 12]) { cv.rect(tx * 8 + 3, 12, 2, 6, C('#5a3a22')); cv.disc(tx * 8 + 4, 11, 2, C('#ff9a3c')); }
    chest(cv, 55, 34, C('#c9a84c'), C('#2a1810'), C('#ffd76a'));
    sprite(cv, 60, 58, C('#3a5ea8'), C('#6b3a1a'));
    messageBox(cv, 'A CHEST...', 'IS IT BREATHING?');
    return cv.png(3);
}
function battleShot(game, seed) {
    const cv = new Canvas(128, 96), r = rng(seed), p = PAL[game.palette];
    cv.gradient(0, 60, p.sky.map(C)); ridge(cv, 56, 8, C(p.far), r); cv.rect(0, 56, cv.w, 40, C(p.ground));
    cv.disc(64, 40, 12, C('#5fbf6a')); cv.disc(64, 44, 11, C('#4aa858')); cv.rect(58, 36, 3, 3, C('#ffffff')); cv.rect(67, 36, 3, 3, C('#ffffff')); cv.rect(59, 37, 1, 1, C('#000000')); cv.rect(68, 37, 1, 1, C('#000000'));
    cv.rect(3, 64, 60, 29, C('#14102a')); cv.rect(3, 64, 60, 1, C('#c9a84c'));
    ['ATTACK', 'SKILL', 'RUN'].forEach((w, i) => text(cv, w, 10, 68 + i * 8, i === 0 ? C('#ffd76a') : C('#fff1c2')));
    cv.rect(66, 64, 59, 29, C('#14102a')); cv.rect(66, 64, 59, 1, C('#c9a84c'));
    ['ARIN', 'MOSS'].forEach((n, i) => { text(cv, n, 70, 68 + i * 12, C('#fff1c2')); cv.rect(96, 69 + i * 12, 24, 3, C('#3a2a2a')); cv.rect(96, 69 + i * 12, 14 + i * 6, 3, C('#5fbf6a')); });
    return cv.png(3);
}
function artwork(game, seed) {
    const cv = new Canvas(160, 120), rand = rng(seed);
    SCENES[game.scene](cv, PAL[game.palette], rand);
    return cv.png(4);
}

// ---------------------------------------------------------------- игры
const DAY = 24 * 60 * 60 * 1000;
const GAMES = [
    { id: 'Starfall_Inn', title: 'Starfall Inn', dev: 'Moon Studio', scene: 'inn', palette: 'night', tags: ['fantasy', 'cozy', 'management', '2d game'], status: 'playing', play: 5.2 * 3600, last: 0.05, rating: 5, version: '1.4.2', added: 2, size: 742, progress: { level: 12, gold: 3480, map: 'Rooftop Kitchen' }, line1: 'WELCOME TO THE INN!', line2: 'ROOMS: 20 GOLD.', desc: 'Run a small inn at the edge of the sky. Cook for travellers, hear their stories and help them find the falling stars before the festival.' },
    { id: 'Sky_Knight_Chronicles', title: 'Sky Knight Chronicles', dev: 'Pinecone Games', scene: 'floating', palette: 'day', tags: ['fantasy', 'turn-based combat', 'adventure', '2d game'], status: 'done', play: 18.5 * 3600, last: 3, rating: 4, version: '2.0', added: 40, size: 1530, progress: { level: 48, gold: 92000 }, line1: 'THE ISLANDS ARE FALLING.', line2: 'GET TO THE AIRSHIP!', desc: 'A classic party RPG among floating islands: airships, sky whales and a knight who is afraid of heights.' },
    { id: 'The_Lantern_Road', title: 'The Lantern Road', dev: 'Little Lantern', scene: 'forest', palette: 'dusk', tags: ['adventure', 'exploration', 'mystery'], status: 'playing', play: 2.7 * 3600, last: 1, rating: 0, version: '0.9.1', added: 6, size: 388, progress: { level: 7, gold: 410 }, line1: 'THE LANTERNS GO OUT', line2: 'ONE BY ONE...', desc: 'Walk the old forest road and relight the lanterns. Every lantern you light remembers someone who once passed by.' },
    { id: 'Ashen_Crown', title: 'Ashen Crown', dev: 'Arcfox', scene: 'castle', palette: 'night', tags: ['dark fantasy', 'turn-based combat', 'dungeon crawler'], status: 'wish', play: 0, last: null, rating: 0, version: '1.2', added: 1, size: 1210, line1: 'THE KING IS DEAD.', line2: 'LONG LIVE THE ASH.', desc: 'A grim tale of a burned kingdom and the heir nobody wanted. Tactical battles, hard choices, no happy endings promised.' },
    { id: 'Tidecaller', title: 'Tidecaller', dev: 'Studio Tern', scene: 'sea', palette: 'sea', tags: ['adventure', 'sailing', 'fantasy'], status: '', play: 25 * 60, last: 12, rating: 3, version: '1.0', added: 25, size: 655, line1: 'THE SEA REMEMBERS.', line2: 'DO YOU?', desc: 'Sail between small islands, call the tides and trade with strange merchants who only appear at low water.' },
    { id: 'Hollow_Spire', title: 'Hollow Spire', dev: 'Kettle & Co', scene: 'cave', palette: 'cave', tags: ['dungeon crawler', 'roguelite', 'puzzle'], status: 'dropped', play: 70 * 60, last: 20, rating: 2, version: '0.6', added: 33, size: 290, line1: 'FLOOR 13.', line2: 'THE STAIRS GO UP NOW.', desc: 'A tower that grows downwards. Every floor rearranges itself, and the treasure chests are not always treasure chests.' },
    { id: 'Marlows_Bakery_Quest', title: "Marlow's Bakery Quest", dev: 'Kettle & Co', scene: 'inn', palette: 'day', tags: ['cozy', 'comedy', 'crafting'], status: 'done', play: 9 * 3600, last: 30, rating: 5, version: '1.1', added: 60, size: 310, progress: { level: 20, gold: 15600 }, line1: 'FRESH BREAD!', line2: 'DRAGONS LOVE CROISSANTS.', desc: 'Marlow inherited a bakery and a debt to a dragon. Bake, deliver and negotiate your way out of trouble.' },
    { id: 'Ember_and_Frost', title: 'Ember & Frost', dev: 'Pinecone Games', scene: 'snow', palette: 'snow', tags: ['fantasy', 'turn-based combat', 'story rich'], status: '', play: 0, last: null, rating: 0, version: '1.0.3', added: 4, size: 980, line1: 'TWO SISTERS.', line2: 'ONE WINTER.', desc: 'Two sisters, one of fire and one of ice, cross a frozen kingdom to end a winter that has lasted a hundred years.' },
    { id: 'The_Last_Lighthouse', title: 'The Last Lighthouse', dev: 'Little Lantern', scene: 'lighthouse', palette: 'night', tags: ['mystery', 'horror', 'exploration'], status: 'playing', play: 45 * 60, last: 2, rating: 0, version: '1.0', added: 9, size: 245, line1: 'THE LIGHT IS ON.', line2: 'NOBODY LIVES HERE.', desc: 'A keeper arrives at a lighthouse that has been abandoned for years. The lamp is still lit every night.' },
    { id: 'Clockwork_Vale', title: 'Clockwork Vale', dev: 'Arcfox', scene: 'clockwork', palette: 'copper', tags: ['sci-fi', 'steampunk', 'puzzle'], status: '', play: 0, last: null, rating: 0, version: '0.4', added: 14, size: 512, line1: 'TICK. TOCK.', line2: 'THE VALLEY IS WINDING DOWN.', desc: 'A valley that runs on clockwork. Somebody stole the main spring, and the town has three days left.' },
    { id: 'Moonlit_Library', title: 'Moonlit Library', dev: 'Moon Studio', scene: 'castle', palette: 'dusk', tags: ['mystery', 'puzzle', 'cozy', 'rpg'], status: '', play: 0, last: null, rating: 4, version: '1.0', added: 18, size: 204, line1: 'SHHH.', line2: 'THE BOOKS ARE SLEEPING.', desc: 'A library that only opens at night. Find the missing chapters before the moon sets.' },
    { id: 'Seven_Keys', title: 'Seven Keys', dev: 'Studio Tern', scene: 'cave', palette: 'copper', tags: ['puzzle', 'adventure', 'dungeon crawler'], status: 'wish', play: 0, last: null, rating: 0, version: '1.3', added: 11, size: 433, line1: 'SIX KEYS FOUND.', line2: 'WHERE IS THE LAST ONE?', desc: 'Seven doors, seven keys and one very suspicious chest guarding the last of them.' },
    { id: 'Dragon_Post_Office', title: 'Dragon Post Office', dev: 'Kettle & Co', scene: 'floating', palette: 'dusk', tags: ['comedy', 'cozy', 'fantasy'], status: '', play: 0, last: null, rating: 0, version: '1.0', added: 8, size: 276, line1: 'PARCEL FOR THE VOLCANO.', line2: 'HANDLE WITH CARE.', desc: 'Deliver letters across a kingdom of very busy dragons. Do not lose the fireproof stamps.' },
    { id: 'Wanderers_Almanac', title: "Wanderer's Almanac", dev: 'Little Lantern', scene: 'desert', palette: 'desert', tags: ['exploration', 'open world', 'crafting', 'rpg'], status: '', play: 0, last: null, rating: 0, version: '0.8', added: 3, size: 860, line1: 'DAY 1.', line2: 'WATER: 3 FLASKS.', desc: 'Cross a desert of forgotten roads and write the almanac nobody else survived to finish.' },
    { id: 'Kristalnyi_Priliv', title: 'Кристальный прилив', coverTitle: 'CRYSTAL TIDE', dev: 'Северный ветер', scene: 'sea', palette: 'dusk', tags: ['fantasy', 'adventure'], status: '', play: 0, last: null, rating: 0, version: '1.0', added: 21, size: 590, lang: 'ru', line1: 'THE TIDE GLOWS.', line2: '', desc: 'Небольшая история о городе на берегу, где во время прилива вода светится, а старый маяк рассказывает сказки.' },
    { id: 'Hoshifuru_Yado', title: '星降る宿', coverTitle: '', dev: '月工房', scene: 'inn', palette: 'dusk', tags: ['fantasy', 'cozy', 'japanese game'], status: '', play: 0, last: null, rating: 0, version: '1.02', added: 27, size: 610, lang: 'ja', line1: 'WELCOME!', line2: '', desc: '星が降る夜だけ開く小さな宿。旅人たちの話を聞いて、流れ星を集めよう。' },
];

async function main() {
    const db = await (async () => {
        const hasDb = fs.existsSync(path.join(dir, 'library.db'));
        if (hasDb && !fs.existsSync(MARK)) {
            console.error(`В ${dir} уже есть library.db, и это не демо-библиотека. Ничего не трогаю.`);
            process.exit(1);
        }
        if (hasDb && !flag('--reset')) {
            console.error(`В ${dir} уже есть демо-библиотека. Пересоздать — с --reset.`);
            process.exit(1);
        }
        if (flag('--reset') && fs.existsSync(MARK)) {
            for (const name of await fsp.readdir(dir)) await fsp.rm(path.join(dir, name), { recursive: true, force: true });
        }
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(MARK, 'Демо-библиотека Mimikin (api/scripts/demo-library.js). Можно пересоздать с --reset.\n');
        const dbService = require('../src/db/database.js');
        await dbService.init(dir);
        return dbService.get();
    })();

    const now = process.env.DEMO_NOW ? Date.parse(process.env.DEMO_NOW) : Date.now();
    if (Number.isNaN(now)) throw new Error(`DEMO_NOW — не дата: ${process.env.DEMO_NOW}`);
    for (const [n, g] of GAMES.entries()) {
        g.seed = 1000 + n * 77;
        g.coverTitle = g.coverTitle ?? g.title;
        const root = path.join(dir, g.id, 'www');
        await fsp.mkdir(path.join(root, 'data'), { recursive: true });
        await fsp.mkdir(path.join(root, 'img', 'pictures'), { recursive: true });
        await fsp.writeFile(path.join(root, 'data', 'System.json'), JSON.stringify({ gameTitle: g.title, locale: g.lang || 'en' }));
        await fsp.writeFile(path.join(root, 'index.html'), demoGamePage(g));
        await fsp.writeFile(path.join(dir, g.id, 'package.json'), JSON.stringify({ name: g.id.toLowerCase(), main: 'www/index.html' }));
        for (let k = 0; k < 3; k++) await fsp.writeFile(path.join(root, 'img', 'pictures', `scene_${k + 1}.png`), artwork({ ...g, scene: Object.keys(SCENES)[(n + k * 3) % Object.keys(SCENES).length] }, g.seed + 500 + k));

        const media = path.join(dir, '_media', g.id);
        await fsp.mkdir(media, { recursive: true });
        const save = async (name, buf) => {
            const file = `${name}-${crypto.createHash('md5').update(buf).digest('hex').slice(0, 10)}.png`;
            await fsp.writeFile(path.join(media, file), buf);
            return `_media/${g.id}/${file}`;
        };
        const coverPath = await save('cover', cover(g));
        const screens = [await save('screen-1', townShot(g, g.seed + 1)), await save('screen-2', dungeonShot(g, g.seed + 2)), await save('screen-3', battleShot(g, g.seed + 3))];
        const lang = g.lang || 'en';
        await db.run(
            `INSERT OR REPLACE INTO games (id, title, cover, tags, description, rating, lastPlayed, addedAt, scraped, ready,
                developer, releaseDate, link, size, status, playtime, progress, screens, meta_status, meta_checked_at, meta_attempts,
                meta_retry_at, text_lang, my_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, '', ?, ?, ?, ?, ?, 'ok', ?, 0, NULL, ?, ?)`,
            [g.id, g.title, coverPath, JSON.stringify(g.tags), g.desc, g.rating, g.last == null ? 0 : now - g.last * DAY, now - g.added * DAY,
                g.dev, new Date(now - (g.added + 120) * DAY).toISOString().slice(0, 10), g.size * 1024 * 1024, g.status, Math.round(g.play),
                g.progress ? JSON.stringify(g.progress) : '', JSON.stringify(screens), now,
                JSON.stringify({ main: lang, langs: [lang], original: lang }), g.version],
        );
    }

    const user = option('--user'), password = option('--password');
    if (user && password) {
        const bcrypt = require('bcrypt');
        await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_user', ?)", [user]);
        await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_pass', ?)", [await bcrypt.hash(password, 10)]);
    }
    await db.close();
    console.log(`Демо-библиотека готова: ${GAMES.length} игр в ${dir}${user ? `, вход: ${user}` : ''}. Запуск сервера — с OFFLINE=1.`);
    process.exit(0);
}

// Страница «игры»: титульный экран и пара строк. Настоящая игра на RPG Maker здесь не нужна —
// библиотеке хватает того, что окно игры открывается и закрывается
function demoGamePage(g) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<!doctype html><html lang="${g.lang || 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(g.title)}</title>
<style>html,body{margin:0;height:100%;background:#0c0a0e;color:#f4efe0;font:16px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
main{text-align:center;padding:24px}h1{color:#c9a84c;letter-spacing:.08em;margin:0 0 8px}p{color:#a39883;margin:4px 0}</style></head>
<body><main id="demo-game"><h1>${esc(g.title)}</h1><p>${esc(g.dev)}</p><p>Demo game · Mimikin demo library</p></main></body></html>
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
