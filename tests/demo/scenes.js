// Сцены и звуки четырёх игр демо: что добавляет к демо-библиотеке запись демо-сайта (rich.js вызывает seed ПОСЛЕ демо-игр).
// Всё выдумано: кадры рисует тот же пиксельный рисовальщик, что и обложки (api/scripts/demo-library.js), реплики и
// названия — свои, звуки синтезирует ffmpeg из формул (lavfi), чужих сэмплов нет.
// Настоящий сервер собирает из этого альбомы сам: общие события (CommonEvents.json) показывают кадры (231), говорят
// (101/401), играют звук (241/250) и ждут (230) — по ним galleryScenes.js строит альбомы «cg» со сценарием. Записанные
// сцены появляются у игры только отсюда: запись (record.js) падает, если у игры из SCENE_GAMES нет альбома со сценарием
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawnSync } = require('child_process');

// Экран игры по умолчанию (System.json демо-игр экран не задаёт) — 816×624; кадры сцен рисуются на него, иначе сервер
// не принял бы их за «CG» (gallery.js, classify: «во весь экран» — от 0,8 экрана)
const SCREEN = { w: 816, h: 624 };

// ---------------------------------------------------------------- звуки
// Нота: [старт в секундах, длина, частота, громкость]. Голос затухает по экспоненте, как щипок струны; по краю — короткий
// подъём, чтобы не щёлкало
const note = (t0, len, hz, amp = 0.3) => `between(t,${t0},${+(t0 + len).toFixed(3)})*${amp}*min(1,(t-${t0})*80)*exp(-${(3 / len).toFixed(2)}*(t-${t0}))*(sin(2*PI*${hz}*t)+0.35*sin(4*PI*${hz}*t))`;
const HZ = (n) => Math.round(440 * 2 ** ((n - 69) / 12) * 100) / 100;
// Мелодия: шаг — доля такта, ноты — номера MIDI (0 — пауза). Играется дважды: левая рука отдельно, потому что у петли без
// баса слышен шов
function melody(steps, { len = 0.5, step = 0.5, bass = [], bassStep = 2 }) {
    const parts = [];
    steps.forEach((n, i) => { if (n) parts.push(note(+(i * step).toFixed(3), len * 1.6, HZ(n), 0.22)); });
    bass.forEach((n, i) => { if (n) parts.push(note(+(i * bassStep).toFixed(3), bassStep * 0.95, HZ(n), 0.2)); });
    return parts.join('+');
}
const SOUNDS = {
    bgm: {
        Inn_Evening: { d: 8, expr: melody([69, 0, 72, 76, 74, 0, 72, 69, 67, 0, 71, 74, 72, 0, 69, 0], { bass: [45, 40, 43, 45] }) },
        Star_Waltz: { d: 9, expr: melody([76, 79, 83, 0, 81, 79, 76, 0, 74, 77, 81, 0, 79, 77, 74, 0, 72, 76, 79, 0], { step: 0.45, bass: [48, 41, 43, 48, 40], bassStep: 1.8 }) },
        Salt_Wind: { d: 8, expr: melody([62, 0, 65, 69, 67, 0, 65, 62, 60, 0, 64, 67, 65, 0, 62, 0], { step: 0.5, len: 0.7, bass: [38, 34, 36, 38] }) },
        Lamp_Room: { d: 8, expr: melody([57, 0, 0, 60, 0, 0, 64, 0, 62, 0, 0, 59, 0, 0, 57, 0], { step: 0.5, len: 0.9, bass: [33, 31, 33, 28] }) },
        Frozen_Road: { d: 8, expr: melody([72, 71, 69, 0, 67, 0, 69, 71, 72, 0, 74, 0, 72, 71, 69, 0], { step: 0.5, len: 0.8, bass: [36, 33, 31, 36] }) },
        Two_Hearths: { d: 9, expr: melody([67, 71, 74, 0, 72, 69, 67, 0, 65, 69, 72, 0, 71, 67, 65, 0, 67, 0], { step: 0.5, len: 0.7, bass: [43, 41, 36, 43, 43] }) },
        Airship_Dock: { d: 8, expr: melody([60, 64, 67, 72, 71, 67, 64, 67, 65, 69, 72, 77, 76, 72, 69, 72], { step: 0.5, len: 0.5, bass: [36, 41, 43, 36] }) },
        Whale_Song: { d: 9, expr: melody([55, 0, 0, 62, 0, 0, 60, 0, 0, 58, 0, 0, 55, 0, 0, 0, 0, 0], { step: 0.5, len: 1.4, bass: [31, 34, 29, 31, 31] }) },
    },
    se: {
        Door_Bell: { d: 1.2, expr: `${note(0, 1.1, 1318.5, 0.35)}+${note(0.18, 1.0, 987.77, 0.3)}` },
        Chime: { d: 1.4, expr: `${note(0, 1.3, 1567.98, 0.3)}+${note(0.12, 1.2, 2093, 0.25)}` },
        Pot_Lid: { d: 0.5, expr: `${note(0, 0.45, 520, 0.4)}+${note(0, 0.3, 1160, 0.3)}` },
        Step: { d: 0.25, expr: '0.5*exp(-30*t)*sin(2*PI*90*t)' },
        Gust: { d: 1.6, noise: true },
        Wave: { d: 2.0, noise: true },
        Lamp_Click: { d: 0.3, expr: `${note(0, 0.25, 220, 0.5)}+0.3*exp(-60*t)*sin(2*PI*1800*t)` },
        Bell_Far: { d: 2.0, expr: `${note(0, 1.9, 392, 0.3)}+${note(0, 1.9, 587.33, 0.2)}` },
        Hearth: { d: 1.0, noise: true },
        Ice_Crack: { d: 0.6, expr: `0.4*exp(-14*t)*sin(2*PI*2400*t*exp(-2*t))+${note(0, 0.5, 1900, 0.15)}` },
        Rope: { d: 0.4, expr: '0.4*exp(-9*t)*sin(2*PI*180*t)' },
        Propeller: { d: 1.5, noise: true },
        Whoosh: { d: 1.0, noise: true },
        Gong: { d: 2.0, expr: `${note(0, 1.9, 196, 0.45)}+${note(0, 1.9, 293.66, 0.2)}` },
    },
};

function synth(name, kind, spec) {
    const sr = 22050;
    const source = spec.noise
        // Шум задан зерном: без seed ffmpeg берёт случайное, и файлы каждый раз разные
        ? `anoisesrc=d=${spec.d}:c=${name === 'Wave' || name === 'Hearth' ? 'brown' : 'pink'}:r=${sr}:a=0.5:seed=${name.length * 7 + 1}`
        : `aevalsrc=exprs='${spec.expr}':s=${sr}:d=${spec.d}`;
    // Шуму — форма: волна поднимается и спадает, ветер не гудит ровно
    const shape = spec.noise ? `,lowpass=f=${name === 'Whoosh' || name === 'Propeller' ? 1800 : 900},afade=t=in:d=${spec.d * 0.4},afade=t=out:st=${spec.d * 0.4}:d=${spec.d * 0.6},volume=0.8` : ',alimiter=limit=0.9';
    const run = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${source}${shape}`,
        // bitexact — выходные параметры: без него ogg-мультиплексор берёт случайный номер потока, и файлы каждый раз разные
        '-ac', '1', '-c:a', 'libvorbis', '-q:a', kind === 'bgm' ? '1' : '0', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'ogg', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 });
    if (run.status !== 0 || !run.stdout.length) throw new Error(`ffmpeg не сделал звук ${name}: ${String(run.stderr).slice(0, 300)}`);
    return run.stdout;
}

// ---------------------------------------------------------------- кадры
// Фигура: голова, тело, ноги — прямоугольники крупнее обложечного спрайта (тот в кадре 640×480 был бы с ноготь)
function figure(cv, C, x, y, s, body, hair) {
    cv.rect(x + 2 * s, y, 4 * s, 3 * s, hair);
    cv.rect(x + 2 * s, y + 2 * s, 4 * s, 2 * s, C('#f2c9a0'));
    cv.rect(x + 1 * s, y + 4 * s, 6 * s, 4 * s, body);
    cv.rect(x + 2 * s, y + 8 * s, 1 * s, 2 * s, C('#2a1810'));
    cv.rect(x + 5 * s, y + 8 * s, 1 * s, 2 * s, C('#2a1810'));
    cv.rect(x + 3 * s, y + 3 * s, 1, 1, C('#2a1810'));
    cv.rect(x + 5 * s, y + 3 * s, 1, 1, C('#2a1810'));
}
// Сундук покрупнее того, что рисует сцена «cave»: на нём модель слов узнаёт «chest»
function bigChest(cv, C, x, y, k) {
    const gold = C('#c9a84c'), dark = C('#2a1810'), light = C('#fff1c2');
    cv.rect(x, y + 6 * k, 18 * k, 9 * k, gold);
    cv.rect(x + k, y, 16 * k, 5 * k, gold);
    cv.rect(x, y + 5 * k, 18 * k, k, dark);
    for (let i = 0; i < 4; i++) { cv.rect(x + (3 + i * 4) * k, y + 6 * k, k, k, light); cv.rect(x + (4 + i * 4) * k, y + 4 * k, k, k, light); }
    cv.rect(x + 5 * k, y + 3 * k, 2 * k, k, C('#ffd76a')); cv.rect(x + 11 * k, y + 3 * k, 2 * k, k, C('#ffd76a'));
    cv.rect(x + 8 * k, y + 9 * k, 2 * k, 3 * k, dark);
}
const COLORS = { red: '#a83a3a', blue: '#3a5ea8', green: '#3f7a4a', violet: '#6b3f7a', gold: '#c9a84c', white: '#e8e0d0', brown: '#6b4a2a' };
const HAIR = { dark: '#2a1810', fair: '#e0c070', red: '#a8502a', grey: '#b8b8c0' };

// PNG с палитрой, как у многих настоящих игр. Кадр рисуется 160×120 и растягивается на весь экран (816/160 — не целое,
// «пиксели» выходят то в 5, то в 6 точек, на глаз незаметно); поверх — редкая крупинка
// (светлее или темнее на пару тонов). Без неё плоский пиксельный рисунок весит 0,01 байта на пиксель, и сервер
// (gallery.js, classify: порог плотности) счёл бы его прозрачным слоем, а не CG; с крупинкой — 0,047
const CRC = new Int32Array(256).map((_, n) => { let k = n; for (let i = 0; i < 8; i++) k = k & 1 ? 0xEDB88320 ^ (k >>> 1) : k >>> 1; return k; });
const crc32 = (buf) => { let k = -1; for (const b of buf) k = CRC[(k ^ b) & 0xFF] ^ (k >>> 8); return (k ^ -1) >>> 0; };
function png8(w, h, rows, palette) {
    const chunk = (type, data) => {
        const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
        return Buffer.concat([head, body, tail]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(palette.flat())),
        chunk('IDAT', require('zlib').deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const GRAIN = 0.018;

function frame(paint, f) {
    const { Canvas, PAL, C, rng, SCENES } = paint;
    const cv = new Canvas(160, 120);
    SCENES[f.scene](cv, PAL[f.palette], rng(f.seed));
    for (const [x, y, s, body, hair] of f.figs || []) figure(cv, C, x, y, s || 2, C(COLORS[body]), C(HAIR[hair]));
    for (const [x, y, k] of f.chests || []) bigChest(cv, C, x, y, k);
    const base = [];
    const index = new Map();
    const cells = new Uint8Array(cv.w * cv.h);
    for (let i = 0; i < cells.length; i++) {
        const key = (cv.px[i * 3] << 16) | (cv.px[i * 3 + 1] << 8) | cv.px[i * 3 + 2];
        if (!index.has(key)) { index.set(key, base.length); base.push([cv.px[i * 3], cv.px[i * 3 + 1], cv.px[i * 3 + 2]]); }
        cells[i] = index.get(key);
    }
    // Цвета: исходные, потом их тёмные и светлые двойники для крупинки
    if (base.length * 3 > 256) throw new Error(`кадр ${f.scene}/${f.palette}: ${base.length} цветов, в палитру с двойниками не влезает`);
    const n = base.length;
    const palette = [...base, ...base.map((c) => c.map((v) => Math.round(v * 0.82))), ...base.map((c) => c.map((v) => Math.round(v + (255 - v) * 0.14)))];
    const rand = rng(f.seed * 31 + 7);
    const { w: W, h: H } = SCREEN;
    const rows = Buffer.alloc((W + 1) * H);
    for (let y = 0; y < H; y++) {
        const cy = Math.floor(y * cv.h / H) * cv.w;
        for (let x = 0; x < W; x++) {
            const cell = cells[cy + Math.floor(x * cv.w / W)];
            rows[y * (W + 1) + 1 + x] = rand() < GRAIN ? cell + n * (1 + Math.floor(rand() * 2)) : cell;
        }
    }
    return png8(W, H, rows, palette);
}

// ---------------------------------------------------------------- игры
// pics — кадры сцены; script — что играет событие: [pic, номер кадра] | [say, кто, текст] | [se, имя] | [bgm, имя] | [wait, кадров]
const GAMES = {
    Starfall_Inn: {
        events: [
            {
                name: 'Late guests', prefix: 'late',
                pics: [
                    { scene: 'inn', palette: 'night', seed: 4101, figs: [[18, 52, 3, 'red', 'dark']] },
                    { scene: 'inn', palette: 'night', seed: 4101, figs: [[18, 52, 3, 'red', 'dark'], [90, 54, 3, 'violet', 'grey']] },
                    { scene: 'inn', palette: 'dusk', seed: 4102, figs: [[40, 50, 3, 'red', 'dark'], [96, 52, 3, 'violet', 'grey'], [68, 56, 2, 'green', 'fair']] },
                ],
                script: [
                    ['bgm', 'Inn_Evening'], ['pic', 0], ['say', 'Mara', 'The lamp over the door is lit. Anyone still out there is welcome at the inn.'],
                    ['se', 'Door_Bell'], ['pic', 1], ['say', 'Old Fenn', 'Good evening. I came to see the stars fall. Is there a room left?'],
                    ['say', 'Mara', 'Twenty gold for the room, and the stars are free. Soup first, though.'],
                    ['se', 'Pot_Lid'], ['pic', 2], ['say', 'Pip', 'Mara, the soup is ready. It only burned a little.'],
                    ['say', 'Old Fenn', 'Warm soup under a falling star. This is a good inn.'],
                    ['say', 'Mara', 'Then you will like the rooftop. Mind the stoves, they bite.'],
                    ['se', 'Step'], ['say', 'Pip', 'He asked for the room with the best view of the stars. We only have one view.'],
                    ['say', 'Mara', 'Then it is the best one. Put a lantern in the window, Pip, so he finds the stairs.'],
                    ['wait', 60],
                ],
            },
            {
                name: 'Festival menu', prefix: 'feast',
                pics: [
                    { scene: 'inn', palette: 'dusk', seed: 4110, figs: [[30, 50, 3, 'red', 'dark'], [100, 54, 3, 'green', 'fair']] },
                    { scene: 'forest', palette: 'dusk', seed: 4111, figs: [[56, 62, 3, 'red', 'dark']] },
                    { scene: 'inn', palette: 'night', seed: 4112, figs: [[20, 52, 3, 'red', 'dark'], [60, 56, 2, 'green', 'fair'], [104, 52, 3, 'gold', 'red']] },
                ],
                script: [
                    ['bgm', 'Star_Waltz'], ['pic', 0], ['say', 'Pip', 'The festival is in three days. We need a menu that fits on one chalkboard.'],
                    ['say', 'Mara', 'Star flour bread, lantern stew and honey tea. Nothing that needs a second stove.'],
                    ['se', 'Chime'], ['pic', 1], ['say', 'Pip', 'Star flour comes from the miller on the hill. He says the stars make it rise.'],
                    ['say', 'Mara', 'Then we ask the miller, not the baker. The baker only has opinions.'],
                    ['pic', 2], ['say', 'Rook', 'I will carry the sacks. Is lantern stew really on the menu?'],
                    ['say', 'Mara', 'Every inn needs one dish that smells like home. Light the lanterns, Pip.'],
                    ['se', 'Pot_Lid'], ['say', 'Pip', 'The inn smells like stew already. Is that the lantern stew or the burnt soup?'],
                    ['say', 'Rook', 'It smells like a festival. I will take both.'],
                    ['wait', 60],
                ],
            },
        ],
        bgm: ['Inn_Evening', 'Star_Waltz'], se: ['Door_Bell', 'Chime', 'Pot_Lid', 'Step', 'Hearth', 'Gust'],
    },
    The_Last_Lighthouse: {
        events: [
            {
                name: 'Arrival', prefix: 'arrive',
                pics: [
                    { scene: 'sea', palette: 'night', seed: 5201, figs: [[24, 66, 2, 'brown', 'dark']] },
                    { scene: 'lighthouse', palette: 'night', seed: 5202, figs: [[96, 66, 2, 'brown', 'dark']] },
                    { scene: 'lighthouse', palette: 'sea', seed: 5203, figs: [[84, 64, 2, 'brown', 'dark']] },
                ],
                script: [
                    ['bgm', 'Salt_Wind'], ['pic', 0], ['se', 'Wave'], ['say', '', 'The boat leaves before the tide turns. Nobody waves from the shore.'],
                    ['say', 'Keeper', 'Seven years of dust, and still the lamp is warm.'],
                    ['pic', 1], ['se', 'Step'], ['say', '', 'The door is not locked. Somebody has oiled the hinges.'],
                    ['say', 'Keeper', 'The logbook says the light must never go out. It does not say who lights it.'],
                    ['pic', 2], ['say', '', 'The lighthouse hums, the way a house hums when it is waiting for someone.'],
                    ['se', 'Gust'], ['say', 'Keeper', 'If I stay one night, the lighthouse has a keeper. If I stay two, it has a home.'],
                    ['say', '', 'Far out on the water, one small light answers the lamp.'],
                    ['wait', 60],
                ],
            },
            {
                name: 'The lamp room', prefix: 'lamp',
                pics: [
                    { scene: 'lighthouse', palette: 'night', seed: 5210, figs: [[60, 66, 2, 'brown', 'dark']] },
                    { scene: 'cave', palette: 'copper', seed: 5211, figs: [[100, 56, 3, 'brown', 'dark']], chests: [[26, 38, 3]] },
                    { scene: 'lighthouse', palette: 'dusk', seed: 5212, figs: [[40, 66, 2, 'brown', 'dark'], [100, 66, 2, 'white', 'grey']] },
                ],
                script: [
                    ['bgm', 'Lamp_Room'], ['pic', 0], ['se', 'Lamp_Click'], ['say', 'Keeper', 'A lantern in a lighthouse. Whoever lit it did not need the big lamp.'],
                    ['pic', 1], ['say', 'Keeper', 'The glass is clean. The wick is new. Somebody was here this morning.'],
                    ['say', 'Keeper', 'Under the stairs there is a sea chest. Locked, and it hums too.'],
                    ['se', 'Bell_Far'], ['pic', 2], ['say', 'Gull Woman', 'You are early. The last keeper always arrived after dark.'],
                    ['say', 'Keeper', 'Who are you?'],
                    ['say', 'Gull Woman', 'I only feed the gulls. The lamp lights itself when the sea is lonely.'],
                    ['se', 'Wave'], ['say', 'Keeper', 'Then let the lamp be lit. I will keep the lantern for the stairs.'],
                    ['say', 'Gull Woman', 'Good. The ships have been asking after this lighthouse for years.'],
                    ['wait', 60],
                ],
            },
        ],
        bgm: ['Salt_Wind', 'Lamp_Room'], se: ['Wave', 'Lamp_Click', 'Bell_Far', 'Gust', 'Step', 'Chime'],
    },
    Ember_and_Frost: {
        events: [
            {
                name: 'Two sisters', prefix: 'sisters',
                pics: [
                    { scene: 'snow', palette: 'snow', seed: 6301, figs: [[30, 60, 3, 'red', 'red'], [100, 60, 3, 'blue', 'fair']] },
                    { scene: 'snow', palette: 'snow', seed: 6302, figs: [[44, 60, 3, 'red', 'red'], [88, 60, 3, 'blue', 'fair']] },
                    { scene: 'castle', palette: 'snow', seed: 6303, figs: [[40, 66, 3, 'red', 'red'], [96, 66, 3, 'blue', 'fair']] },
                ],
                script: [
                    ['bgm', 'Frozen_Road'], ['pic', 0], ['se', 'Gust'], ['say', 'Ember', 'The winter has lasted a hundred years. I am tired of wearing a coat to dinner.'],
                    ['say', 'Frost', 'You are tired of everything that is not on fire.'],
                    ['pic', 1], ['say', 'Ember', 'Fine. The road to the capital is open. The snow does not bite.'],
                    ['say', 'Frost', 'It listens. Winter is not an enemy, it is a very long sentence.'],
                    ['se', 'Hearth'], ['pic', 2], ['say', 'Ember', 'Then we go and ask whoever started it to put a full stop.'],
                    ['say', 'Frost', 'Take my scarf. And do not set the gate on fire.'],
                    ['se', 'Step'], ['say', 'Ember', 'Do you hear that? The snow is crunching in time with us.'],
                    ['say', 'Frost', 'It is only the winter keeping count. One hundred years, one hundred steps.'],
                    ['wait', 60],
                ],
            },
            {
                name: 'The frozen gate', prefix: 'gate',
                pics: [
                    { scene: 'castle', palette: 'snow', seed: 6310, figs: [[24, 66, 2, 'red', 'red'], [48, 66, 2, 'blue', 'fair']] },
                    { scene: 'cave', palette: 'snow', seed: 6311, figs: [[100, 56, 3, 'blue', 'fair']], chests: [[26, 38, 3]] },
                    { scene: 'snow', palette: 'dusk', seed: 6312, figs: [[30, 60, 3, 'red', 'red'], [100, 60, 3, 'blue', 'fair']] },
                ],
                script: [
                    ['bgm', 'Two_Hearths'], ['pic', 0], ['se', 'Ice_Crack'], ['say', 'Frost', 'The gate is one piece of ice. There is no keyhole.'],
                    ['say', 'Ember', 'Then I make one. Stand back.'],
                    ['pic', 1], ['se', 'Hearth'], ['say', 'Ember', 'It is warm inside. Someone is keeping a hearth for us.'],
                    ['say', 'Frost', 'Or for the winter. Do not touch anything pretty.'],
                    ['pic', 2], ['say', 'Ember', 'We walked through a hundred winters in an afternoon. Did you notice?'],
                    ['say', 'Frost', 'I noticed the stars on the other side were the wrong way round.'],
                    ['se', 'Bell_Far'], ['say', 'Ember', 'A bell behind the gate. Somebody is ringing it for the end of winter.'],
                    ['say', 'Frost', 'Or for the beginning of dinner. Open the gate, sister.'],
                    ['wait', 60],
                ],
            },
        ],
        bgm: ['Frozen_Road', 'Two_Hearths'], se: ['Gust', 'Hearth', 'Ice_Crack', 'Step', 'Bell_Far', 'Chime'],
    },
    Sky_Knight_Chronicles: {
        events: [
            {
                name: 'Dock Island', prefix: 'dock',
                pics: [
                    { scene: 'floating', palette: 'day', seed: 7401, figs: [[30, 36, 2, 'blue', 'fair']] },
                    { scene: 'floating', palette: 'day', seed: 7402, figs: [[30, 36, 2, 'blue', 'fair'], [76, 34, 2, 'gold', 'dark']] },
                    { scene: 'clockwork', palette: 'copper', seed: 7403, figs: [[50, 56, 3, 'blue', 'fair'], [100, 56, 3, 'gold', 'dark']] },
                ],
                script: [
                    ['bgm', 'Airship_Dock'], ['pic', 0], ['se', 'Rope'], ['say', 'Sir Arin', 'The airship is repaired. Tell me again that it is safe to stand on the deck.'],
                    ['pic', 1], ['se', 'Propeller'], ['say', 'Moss', 'The deck is safe. The edge of the deck is the problem.'],
                    ['say', 'Sir Arin', 'I am a knight. I do not look down. I look ahead, slightly up.'],
                    ['pic', 2], ['say', 'Moss', 'The engineer says the clockwork heart needs one more spring.'],
                    ['say', 'Sir Arin', 'Then we fly to the next island and borrow one. Politely.'],
                    ['se', 'Chime'], ['say', 'Moss', 'The harbour master says our airship needs a name before it leaves the dock.'],
                    ['say', 'Sir Arin', 'The Brave Cloud. No, the Slightly Brave Cloud.'],
                    ['wait', 60],
                ],
            },
            {
                name: 'The sky whale', prefix: 'whale',
                pics: [
                    { scene: 'floating', palette: 'dusk', seed: 7410, figs: [[24, 36, 2, 'blue', 'fair']] },
                    { scene: 'sea', palette: 'dusk', seed: 7411, figs: [[40, 60, 2, 'blue', 'fair'], [80, 60, 2, 'gold', 'dark']] },
                    { scene: 'floating', palette: 'night', seed: 7412, figs: [[70, 34, 2, 'blue', 'fair']] },
                ],
                script: [
                    ['bgm', 'Whale_Song'], ['pic', 0], ['se', 'Whoosh'], ['say', 'Moss', 'Something under the clouds is singing. Very low. Very large.'],
                    ['pic', 1], ['say', 'Sir Arin', 'It is only a sky whale. They are gentle. Mostly.'],
                    ['se', 'Gong'], ['say', 'Moss', 'It looked at the airship. Then it looked at your armour. Then it looked away.'],
                    ['pic', 2], ['say', 'Sir Arin', 'See? It likes me. It is following us home.'],
                    ['say', 'Moss', 'It is following the stars you are wearing on your helmet.'],
                    ['se', 'Whoosh'], ['say', 'Sir Arin', 'Tell the engineer to fly slowly. A sky whale does not like a loud airship.'],
                    ['say', 'Moss', 'It does not like loud knights either. Take off the helmet, Sir Arin.'],
                    ['wait', 60],
                ],
            },
        ],
        bgm: ['Airship_Dock', 'Whale_Song'], se: ['Rope', 'Propeller', 'Whoosh', 'Gong', 'Wave', 'Chime'],
    },
};
const SCENE_GAMES = Object.keys(GAMES);

// Команды события: те же шаги, что у настоящих игр (RPG Maker MV/MZ); имя говорящего — пятый параметр 101 (MZ)
const c = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
const sound = (name, volume = 85) => ({ name, volume, pitch: 100, pan: 0 });
function commands(ev) {
    const list = [];
    for (const [kind, a, b] of ev.script) {
        if (kind === 'pic') list.push(c(231, [1, `${ev.prefix}_${a + 1}`, 0, 0, 0, 0, 100, 100, 255, 0]));
        else if (kind === 'say') list.push(c(101, ['', 0, 0, 2, a]), c(401, [b]));
        else if (kind === 'se') list.push(c(250, [sound(a)]));
        else if (kind === 'bgm') list.push(c(241, [sound(a, 70)]));
        else if (kind === 'wait') list.push(c(230, [a]));
    }
    list.push(c(0));
    return list;
}

// Пишет сцены и звуки в игры демо-библиотеки dir. paint — рисовальщик (rich.js, painters)
async function seed(dir, paint) {
    const have = spawnSync('ffmpeg', ['-version']).status === 0;
    if (!have) throw new Error('нет ffmpeg: звуки демо не синтезировать');
    for (const [id, g] of Object.entries(GAMES)) {
        const www = path.join(dir, id, 'www');
        if (!fs.existsSync(www)) throw new Error(`нет игры ${id} в демо-библиотеке (tests/demo/scenes.js)`);
        const pictures = path.join(www, 'img', 'pictures');
        await fsp.mkdir(pictures, { recursive: true });
        for (const ev of g.events) {
            for (const [i, f] of ev.pics.entries()) await fsp.writeFile(path.join(pictures, `${ev.prefix}_${i + 1}.png`), frame(paint, f));
        }
        // События игры — общие (CommonEvents.json): файла в демо-игре не было, остальное в data/ не трогаем
        await fsp.writeFile(path.join(www, 'data', 'CommonEvents.json'), JSON.stringify([null, ...g.events.map((ev, i) => ({ id: i + 1, name: ev.name, list: commands(ev) }))]));
        for (const kind of ['bgm', 'se']) {
            await fsp.mkdir(path.join(www, 'audio', kind), { recursive: true });
            for (const name of g[kind]) await fsp.writeFile(path.join(www, 'audio', kind, `${name}.ogg`), synth(name, kind, SOUNDS[kind][name]));
        }
        // Звуки, что играют события, но не названы в списке игры, тоже нужны: сцена без файла молчит
        for (const ev of g.events) {
            for (const [kind, name] of ev.script) {
                if ((kind === 'bgm' && !g.bgm.includes(name)) || (kind === 'se' && !g.se.includes(name))) throw new Error(`${id}: звук ${name} события «${ev.name}» не входит в список игры`);
            }
        }
    }
}

module.exports = { seed, synth, SCENE_GAMES, GAMES, SOUNDS };
