#!/usr/bin/env node
// Что добавляет к демо-библиотеке запись демо-сайта (tests/demo/record.js): дни игры за четыре месяца, моменты, история
// сейвов, серия, подборки, игра «на полке», заметки, избранное, перевод, список «Отложенные», второй человек в настройках.
// Запускается ПОСЛЕ api/scripts/demo-library.js, который не меняется, и ДО сервера:
//
//   DEMO_NOW=2026-10-03T12:00:00Z TZ=UTC node tests/demo/rich.js <папка с демо-библиотекой>
//
// Пишет только в демо-папку (метка .mimikin-demo), в настоящую библиотеку не лезет. Всё — из сервисов самого сервера
// (хранилище моментов, сейвов, корзина) или строками базы там, где у сервера нет входа без запущенной игры (дни игры).
// Ничего случайного и ничего от часов: те же входные данные дают те же байты — записи без этого не сравнить
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DAY = 24 * 60 * 60 * 1000;
// Где лежит сервер: в образе /app/api
const API = process.env.DEMO_API || '/app/api';

// ---------------------------------------------------------------- картинки
// Рисовальщик демо-библиотеки (обложки, кадры «из игры») лежит в api/scripts/demo-library.js вперемешку с запуском. Файл
// не меняем: достаём из него кусок с рисованием, чтобы у новых игр и моментов был тот же пиксельный вид
function painters() {
    const text = fs.readFileSync(path.join(API, 'scripts', 'demo-library.js'), 'utf8');
    const from = text.indexOf('// ---------------------------------------------------------------- PNG без графических библиотек');
    const to = text.indexOf('// ---------------------------------------------------------------- игры');
    if (from < 0 || to < from) throw new Error('demo-library.js изменился: не нашёл границы рисовальщика (tests/demo/rich.js, painters)');
    const body = `${text.slice(from, to)}\nreturn { cover, townShot, dungeonShot, battleShot, artwork, SCENES, Canvas, PAL, C, rng };`;
    return new Function('zlib', 'crypto', body)(require('zlib'), crypto);
}

// PNG → JPEG для моментов и снимков (сервер принимает кадры только JPEG). bitexact — чтобы вывод не зависел от времени и версии
function jpeg(png, width) {
    const run = spawnSync('ffmpeg', ['-v', 'error', '-fflags', '+bitexact', '-i', 'pipe:0', '-frames:v', '1',
        '-vf', `scale=${width}:-1:flags=neighbor`, '-c:v', 'mjpeg', '-flags:v', '+bitexact', '-q:v', '6', '-f', 'mjpeg', 'pipe:1'],
    { input: png, maxBuffer: 16 * 1024 * 1024 });
    if (run.status !== 0 || !run.stdout.length) throw new Error(`ffmpeg не сделал JPEG: ${String(run.stderr).slice(0, 200)}`);
    return run.stdout;
}
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash4 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 4);

// ---------------------------------------------------------------- что играли и когда
// first/last — сколько дней назад начали и играли в последний раз. Секунды в сумме — столбец playtime игры, поэтому
// календарь и «наиграно» в окне игры сходятся. Раньше, чем игра «добавлена», играть нельзя: addedAt подтягивается
const PLAYED = {
    Starfall_Inn: { first: 11, last: 0 },
    Sky_Knight_Chronicles: { first: 104, last: 3 },
    The_Lantern_Road: { first: 5, last: 1 },
    Tidecaller: { first: 26, last: 12 },
    Hollow_Spire: { first: 41, last: 20 },
    Marlows_Bakery_Quest: { first: 118, last: 30 },
    The_Last_Lighthouse: { first: 4, last: 2 },
};

// Дни игры: в выходные чаще, ни один день не короче 8 минут, первый и последний день заданы. Сумма — ровно total
function sessions(total, first, last, rand, now) {
    let days = [];
    for (let d = first; d >= last; d--) {
        const weekday = new Date(now - d * DAY).getUTCDay();
        if (d === first || d === last || rand() < (weekday === 0 || weekday === 6 ? 0.5 : 0.2)) days.push(d);
    }
    while (days.length * 480 > total && days.length > 1) {
        const i = 1 + Math.floor(rand() * Math.max(1, days.length - 2));
        if (days.length === 2) { days.pop(); break; }
        days.splice(i, 1);
    }
    days = [...new Set(days)];
    const weights = days.map(() => 0.4 + rand() * 1.6);
    const sum = weights.reduce((a, b) => a + b, 0);
    const seconds = weights.map((w) => Math.max(60, Math.round((w / sum) * total / 10) * 10));
    seconds[seconds.length - 1] += total - seconds.reduce((a, b) => a + b, 0);
    return days.map((d, i) => ({ day: new Date(now - d * DAY).toISOString().slice(0, 10), seconds: seconds[i] }));
}

// ---------------------------------------------------------------- моменты и сейвы
const MAPS = {
    Starfall_Inn: ['Common Room', 'Cellar', 'Rooftop Kitchen', 'Market Lane'],
    The_Lantern_Road: ['Old Gate', 'Lantern Hill', 'Mill Bridge'],
    The_Last_Lighthouse: ['Shore Path', 'Lamp Room', 'Keeper Quarters'],
};
// Моменты: когда (дней назад), подпись, карта (номер в MAPS или своя), сколько наиграно к тому времени, какой кадр
const MOMENTS = {
    Starfall_Inn: [
        { ago: 10.5, label: 'First guests arrive', map: 'Common Room', play: 0.6, shot: 'town' },
        { ago: 8, label: 'The cellar key', map: 'Cellar', play: 1.5, shot: 'dungeon' },
        { ago: 3, label: 'Festival menu is ready', map: 'Rooftop Kitchen', play: 3.9, shot: 'town' },
        { ago: 0.4, label: 'Before the star flour', map: 'Market Lane', play: 5.0, shot: 'battle' },
    ],
    The_Lantern_Road: [
        { ago: 4.5, label: 'First lantern lit', map: 'Old Gate', play: 0.5, shot: 'town' },
        { ago: 2.5, label: 'The mill bridge is out', map: 'Mill Bridge', play: 1.6, shot: 'dungeon' },
        { ago: 1.1, label: 'Fox at the hill', map: 'Lantern Hill', play: 2.6, shot: 'battle' },
    ],
    The_Last_Lighthouse: [
        { ago: 3.8, label: 'Arrival', map: 'Shore Path', play: 0.1, shot: 'town' },
        { ago: 2.4, label: 'The lamp is still lit', map: 'Lamp Room', play: 0.5, shot: 'dungeon' },
        { ago: 2.1, label: 'Logbook, last page', map: 'Keeper Quarters', play: 0.7, shot: 'town' },
    ],
    Sky_Knight_Chronicles: [
        { ago: 70, label: 'Airship is repaired', map: 'Dock Island', play: 6, shot: 'town' },
        { ago: 41, label: 'Sky whale ahead', map: 'Cloud Strait', play: 11, shot: 'battle' },
        { ago: 12, label: 'Last save before the finale', map: 'Crown Island', play: 17.5, shot: 'dungeon' },
        { ago: 3.2, label: 'Credits', map: 'Dock Island', play: 18.5, shot: 'town' },
    ],
    Marlows_Bakery_Quest: [
        { ago: 100, label: 'The dragon wants croissants', map: 'Bakery', play: 2, shot: 'town' },
        { ago: 60, label: 'Contract signed', map: 'Market Square', play: 6, shot: 'dungeon' },
        { ago: 30.5, label: 'Debt paid', map: 'Bakery', play: 9, shot: 'battle' },
    ],
};
// Сейвы с историей — у трёх игр «в процессе». Две ячейки, у каждой нынешний сейв и три прежние версии; последняя
// версия первой ячейки совпадает с тем, что показывает игра на «Главной» (уровень, золото, карта)
const SAVES = {
    Starfall_Inn: { slots: 2, maps: MAPS.Starfall_Inn, total: 5.2, last: 0.05, level: 12, gold: 3480, mapId: 3 },
    The_Lantern_Road: { slots: 2, maps: MAPS.The_Lantern_Road, total: 2.7, last: 1, level: 7, gold: 410, mapId: 2 },
    The_Last_Lighthouse: { slots: 2, maps: MAPS.The_Last_Lighthouse, total: 0.75, last: 2, level: 4, gold: 120, mapId: 2 },
};

// Сейв в том виде, как читает сервер (utils/saveprogress.js, parseSave): обычный JSON MV
const saveText = ({ seconds, level, gold, mapId }) => JSON.stringify({
    system: { _framesOnSave: Math.round(seconds * 60) },
    actors: { _data: [null, { _level: level }, { _level: Math.max(1, level - 2) }] },
    party: { _gold: gold },
    map: { _mapId: mapId },
});

// ---------------------------------------------------------------- «Отложенные» (вкладка «Найти»)
// Адреса выдуманные, поддомены не существуют. Обложек нет: картинки отложенных берутся только с чужого сайта
const SAVED = [
    { slug: 'glass-orchard', title: 'Glass Orchard', creator: 'Orchard Hill', genre: 'Adventure', price: '$4.99', platforms: ['windows', 'linux', 'html'], ago: 2, description: 'Walk through an orchard where every fruit is a small locked room. Short, quiet and a little strange.' },
    { slug: 'night-ferry', title: 'Night Ferry', creator: 'Ferry Light', genre: 'Mystery', price: 'Free', platforms: ['windows', 'osx', 'html'], ago: 5, description: 'One ferry, one night, eleven passengers. Ask the right questions before the far shore.' },
    { slug: 'moss-court', title: 'Moss Court', creator: 'Moss & Co', genre: 'Roguelite', price: '$2.50', platforms: ['windows', 'linux'], ago: 9, description: 'A card duel game played in an overgrown courtroom. The judge is a heron.' },
    { slug: 'salt-and-ember', title: 'Salt and Ember', creator: 'Tern Works', genre: 'Role playing', price: '$7.00', platforms: ['windows', 'osx', 'linux'], ago: 15, description: 'A seaside party RPG about a salt trade and a lighthouse that burns the wrong colour.' },
    { slug: 'the-quiet-archive', title: 'The Quiet Archive', creator: 'Archive Club', genre: 'Puzzle', price: 'Free', platforms: ['html'], ago: 21, description: 'Sort an archive of letters nobody sent. Plays in the browser, takes an hour.' },
];

async function seed(dir) {
    process.env.GAMES_DIR = dir;
    process.env.REDIS_URL = process.env.REDIS_URL || 'memory';
    const now = Date.parse(process.env.DEMO_NOW || '');
    if (Number.isNaN(now)) throw new Error('DEMO_NOW — не дата: без неё запись не повторить');
    if (!fs.existsSync(path.join(dir, '.mimikin-demo'))) throw new Error(`${dir}: нет метки .mimikin-demo — это не демо-библиотека, ничего не пишу`);

    const dbService = require(path.join(API, 'src/db/database.js'));
    await dbService.init(dir);
    const db = dbService.get();
    const { createMarkStore } = require(path.join(API, 'src/utils/marks.js'));
    const { createSaveStore } = require(path.join(API, 'src/utils/savestore.js'));
    const { createTrash } = require(path.join(API, 'src/services/trash.js'));
    const paint = painters();
    const savesDir = path.join(dir, '_saves');

    // ---- второе продолжение серии: новая игра в библиотеке, картинки те же, что рисует demo-library.js
    const sequel = {
        id: 'Sky_Knight_Chronicles_II', title: 'Sky Knight Chronicles II', dev: 'Pinecone Games', scene: 'clockwork', palette: 'night',
        tags: ['fantasy', 'turn-based combat', 'adventure', '2d game'], status: 'wish', added: 3, size: 1340, version: '0.9',
        line1: 'THE ISLANDS ARE RISING.', line2: 'THE KNIGHT STILL HATES HEIGHTS.', seed: 1000 + 16 * 77, coverTitle: 'Sky Knight Chronicles II',
        desc: 'The sequel to the floating islands story: the airship is new, the sky whales are back, and the knight has started to like the view.',
    };
    {
        const g = sequel;
        const root = path.join(dir, g.id, 'www');
        await fsp.mkdir(path.join(root, 'data'), { recursive: true });
        await fsp.mkdir(path.join(root, 'img', 'pictures'), { recursive: true });
        await fsp.writeFile(path.join(root, 'data', 'System.json'), JSON.stringify({ gameTitle: g.title, locale: 'en' }));
        await fsp.writeFile(path.join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><title>${g.title}</title><body>${g.title}</body>\n`);
        await fsp.writeFile(path.join(dir, g.id, 'package.json'), JSON.stringify({ name: g.id.toLowerCase(), main: 'www/index.html' }));
        const scenes = Object.keys(paint.SCENES);
        for (let k = 0; k < 3; k++) {
            await fsp.writeFile(path.join(root, 'img', 'pictures', `scene_${k + 1}.png`), paint.artwork({ ...g, scene: scenes[(5 + k * 3) % scenes.length] }, g.seed + 500 + k));
        }
        const media = path.join(dir, '_media', g.id);
        await fsp.mkdir(media, { recursive: true });
        const save = async (name, buf) => {
            const file = `${name}-${crypto.createHash('md5').update(buf).digest('hex').slice(0, 10)}.png`;
            await fsp.writeFile(path.join(media, file), buf);
            return `_media/${g.id}/${file}`;
        };
        const cover = await save('cover', paint.cover(g));
        const screens = [await save('screen-1', paint.townShot(g, g.seed + 1)), await save('screen-2', paint.dungeonShot(g, g.seed + 2)), await save('screen-3', paint.battleShot(g, g.seed + 3))];
        await db.run(
            `INSERT OR REPLACE INTO games (id, title, cover, tags, description, rating, lastPlayed, addedAt, scraped, ready,
                developer, releaseDate, link, size, status, playtime, progress, screens, meta_status, meta_checked_at, meta_attempts,
                meta_retry_at, text_lang, my_version)
             VALUES (?, ?, ?, ?, ?, 0, 0, ?, 1, 1, ?, ?, '', ?, ?, 0, '', ?, 'ok', ?, 0, NULL, ?, ?)`,
            [g.id, g.title, cover, JSON.stringify(g.tags), g.desc, now - g.added * DAY, g.dev, new Date(now - 20 * DAY).toISOString().slice(0, 10),
                g.size * 1024 * 1024, g.status, JSON.stringify(screens), now, JSON.stringify({ main: 'en', langs: ['en'], original: 'en' }), g.version],
        );
    }
    await db.run("UPDATE games SET series = 'Sky Knight Chronicles' WHERE id IN ('Sky_Knight_Chronicles', 'Sky_Knight_Chronicles_II')");

    // ---- дни игры: сумма по игре — её playtime; addedAt не позже первого дня
    for (const [id, p] of Object.entries(PLAYED)) {
        const row = await db.get('SELECT playtime FROM games WHERE id = ?', [id]);
        if (!row) throw new Error(`нет игры ${id} в демо-библиотеке`);
        const rand = rng(parseInt(hash4(id), 16));
        for (const s of sessions(row.playtime, p.first, p.last, rand, now)) {
            await db.run('INSERT OR REPLACE INTO play_days (user_id, game_id, day, seconds) VALUES (?, ?, ?, ?)', ['owner', id, s.day, s.seconds]);
        }
        await db.run('UPDATE games SET addedAt = MIN(addedAt, ?) WHERE id = ?', [now - (p.first + 1) * DAY, id]);
    }

    // ---- названия карт: «Где вышли» и сейвы показывают их из data/MapInfos.json игры
    for (const [id, maps] of Object.entries(MAPS)) {
        const infos = [null, ...maps.map((name, i) => ({ id: i + 1, name, parentId: 0, order: i + 1 }))];
        await fsp.writeFile(path.join(dir, id, 'www', 'data', 'MapInfos.json'), JSON.stringify(infos));
    }

    // ---- сцены и звуки четырёх игр (scenes.js): альбомы со сценарием, комната звуков
    await require('./scenes.js').seed(dir, paint);

    // ---- моменты: хранилище сервера, часы — наши
    let clockNow = now;
    const marks = createMarkStore(savesDir, { now: () => clockNow });
    const shotOf = { town: paint.townShot, dungeon: paint.dungeonShot, battle: paint.battleShot };
    for (const [id, list] of Object.entries(MOMENTS)) {
        const game = (await db.get('SELECT title, tags FROM games WHERE id = ?', [id]));
        const g = { title: game.title, palette: 'night', line1: 'WELCOME!', line2: '' };
        for (const [n, m] of list.entries()) {
            clockNow = Math.round(now - m.ago * DAY);
            const png = shotOf[m.shot]({ ...g, line1: m.label.toUpperCase().slice(0, 40), line2: '' }, 7000 + n * 31 + parseInt(hash4(id), 16) % 997);
            const made = await marks.create(id, {
                id: `mk${hash4(id)}${n}`, kind: 'mark', label: m.label, map: m.map, playtime: Math.round(m.play * 3600),
                value: saveText({ seconds: m.play * 3600, level: 3 + n * 3, gold: 100 + n * 700, mapId: 1 }),
                thumb: dataUrl(jpeg(png, 192)), shot: dataUrl(jpeg(png, 384)),
            });
            if (!made.id) throw new Error(`момент ${id}/${m.label}: ${JSON.stringify(made)}`);
        }
    }

    // ---- сейвы: четыре записи в каждую из двух ячеек, три прежние версии остаются в истории
    const saves = createSaveStore(savesDir);
    for (const [id, s] of Object.entries(SAVES)) {
        const state = { level: s.level, gold: s.gold, mapId: s.mapId };
        for (let slot = 1; slot <= s.slots; slot++) {
            const key = `RPG File${slot}`;
            // Вторая ячейка — другое прохождение: меньше уровень, раньше по времени
            const k = slot === 1 ? 1 : 0.6;
            for (let v = 0; v < 4; v++) {
                const f = (v + 1) / 4;
                const at = Math.round(now - (s.last + (3 - v) * (slot === 1 ? 1.4 : 2.1) * (id === 'Starfall_Inn' ? 1 : 0.5)) * DAY);
                const result = await saves.write(id, key, saveText({
                    seconds: s.total * 3600 * k * f, level: Math.max(1, Math.round(state.level * k * f)), gold: Math.round(state.gold * k * f),
                    mapId: Math.max(1, Math.min(s.maps.length, Math.ceil(s.mapId * f))),
                }), at);
                if (result !== 'saved') throw new Error(`сейв ${id}/${key} v${v}: ${result}`);
                if (v === 3) await saves.writeShot(id, key, jpeg(shotOf.town({ title: id, palette: 'night', line1: `${s.maps[s.mapId - 1]}`.toUpperCase(), line2: '' }, 9100 + slot), 192), at);
            }
        }
    }

    // ---- подборки, заметки, избранное
    const lists = {
        'Cozy evenings': ['Starfall_Inn', 'Marlows_Bakery_Quest', 'Dragon_Post_Office', 'Moonlit_Library', 'Hoshifuru_Yado'],
        'Mystery night': ['The_Last_Lighthouse', 'The_Lantern_Road', 'Moonlit_Library'],
        Dungeons: ['Hollow_Spire', 'Seven_Keys', 'Ashen_Crown'],
    };
    const of = new Map();
    for (const [name, ids] of Object.entries(lists)) for (const id of ids) of.set(id, [...(of.get(id) || []), name]);
    for (const [id, names] of of) await db.run('UPDATE games SET lists = ? WHERE id = ?', [JSON.stringify(names), id]);
    await db.run('UPDATE games SET notes = ? WHERE id = ?', ['The rooftop kitchen needs three stoves before the festival. Ask the miller about star flour, not the baker.', 'Starfall_Inn']);
    await db.run('UPDATE games SET notes = ? WHERE id = ?', ['The dragon likes croissants, not baguettes. Save before the bakery contest.', 'Marlows_Bakery_Quest']);
    await db.run("UPDATE games SET favorite = 1 WHERE id IN ('Starfall_Inn', 'Sky_Knight_Chronicles', 'Marlows_Bakery_Quest')");

    // ---- избранное галереи: шесть картинок, в разные дни. Файлы — те, что рисует demo-library.js для каждой игры
    const favorites = [
        ['Starfall_Inn', 1, 1], ['Starfall_Inn', 2, 4], ['Sky_Knight_Chronicles', 1, 7], ['Sky_Knight_Chronicles', 3, 12],
        ['Tidecaller', 2, 18], ['Marlows_Bakery_Quest', 1, 25],
    ];
    for (const [id, n, ago] of favorites) {
        await db.run("INSERT OR REPLACE INTO gallery_favorites (game_id, file, kind, at, anim) VALUES (?, ?, '', ?, '')", [id, `img/pictures/scene_${n}.png`, now - ago * DAY]);
    }

    // ---- перевод: русская игра уже переведена на английский
    await db.run("INSERT OR REPLACE INTO game_translation (id, lang, state, done, total, failed, engine, error, at) VALUES ('Kristalnyi_Priliv', 'en', 'done', 412, 412, 0, 'libre', '', ?)", [now - 6 * DAY]);

    // ---- «Отложенные»: адреса выдуманные (поддомена mimikin-demo-* на itch.io нет)
    for (const s of SAVED) {
        const url = `https://mimikin-demo-${s.slug}.itch.io/${s.slug}`;
        const info = { title: s.title, cover: '', screens: [], creator: s.creator, genre: s.genre, price: s.price, platforms: s.platforms, description: s.description, createdAt: now - 90 * DAY, updatedAt: now - 30 * DAY };
        await db.run('INSERT OR REPLACE INTO wishlist (key, source, ref, url, info, addedAt) VALUES (?, ?, ?, ?, ?, ?)', [`itch:${url}`, 'itch', url, url, JSON.stringify(info), now - s.ago * DAY]);
    }

    // ---- второй человек: Мира, только играет. Пароль «!» — не хэш, войти под ней нельзя. Свой список из пяти игр и картинка
    // (JPEG 256 px, как отдаёт страница): «Настройки → Люди» без них показывали бы пустую карточку. Версия картинки — время
    // файла (меняется адрес, когда файл заменили). Ставим её сами и крошечной: настоящее время записи было бы «временем» в
    // ответе, которое демо обязано сдвигать (timeShift.js), а версия нужна только как метка кэша
    const mira = 'u4d69726100000001';
    await db.run(`INSERT OR REPLACE INTO users (id, name, pass_hash, must_change, created_at, state, games_limited, may_request, may_download, may_upload, may_view)
        VALUES (?, 'Mira', '!', 0, ?, '', 1, 0, 0, 0, 0)`, [mira, now - 20 * DAY]);
    for (const id of ['Starfall_Inn', 'Marlows_Bakery_Quest', 'Dragon_Post_Office', 'Moonlit_Library', 'Tidecaller']) {
        await db.run('INSERT OR REPLACE INTO user_game_access (user_id, game_id) VALUES (?, ?)', [mira, id]);
    }
    {
        const { Canvas, C } = paint;
        const cv = new Canvas(64, 64);
        cv.rect(0, 0, 64, 64, C('#2b1830'));
        cv.rect(0, 40, 64, 24, C('#1b1020'));
        for (let i = 0; i < 18; i++) cv.set((i * 37) % 64, (i * 11) % 28, C('#f4efe0'));
        cv.rect(14, 46, 36, 18, C('#3a5ea8'));                      // плечи
        cv.rect(24, 40, 16, 8, C('#f2c9a0'));                       // шея
        cv.disc(32, 28, 15, C('#f2c9a0'));                          // лицо
        cv.rect(16, 10, 32, 12, C('#a8502a'));                      // волосы сверху
        cv.rect(14, 16, 6, 28, C('#a8502a')); cv.rect(44, 16, 6, 28, C('#a8502a'));
        cv.rect(25, 28, 3, 3, C('#2a1810')); cv.rect(37, 28, 3, 3, C('#2a1810'));
        cv.rect(29, 36, 7, 1, C('#a83a3a'));
        cv.rect(24, 48, 16, 4, C('#c9a84c'));                       // шарф
        const avatars = require(path.join(API, 'src/utils/avatars.js'));
        await avatars.put(mira, jpeg(cv.png(4), 256));
        await fsp.utimes(avatars.fileOf(mira), 1, 1);
    }

    // ---- игра «на полке»: файлы в корзине, карточка, сейвы, моменты и время остаются
    const trash = createTrash({ db: () => db, trashDir: path.join(dir, '_trash'), gamesDir: dir });
    await trash.shelveGame('Hollow_Spire', now - 9 * DAY);

    await db.close();
}

module.exports = { seed };

if (require.main === module) {
    const dir = process.argv[2] ? path.resolve(process.argv[2]) : null;
    if (!dir) { console.error('Использование: DEMO_NOW=… node tests/demo/rich.js <демо-библиотека>'); process.exit(2); }
    seed(dir).then(() => { console.error(`[rich] готово: ${dir}`); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
