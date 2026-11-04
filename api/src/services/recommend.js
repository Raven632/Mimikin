// «Во что поиграть?»: умный подбор. Вкус считаем по самой библиотеке, в основном по наигранному: оценки и статусы люди почти не
// ставят (в живой библиотеке оценки бывают у каждой двадцатой игры), а наигранное есть само собой. Чистые функции — разбор
// вкуса, порядок игр и причины, — отдельно от чтения базы: createRecommend ниже только собирает им данные.
//
// Причины — кодами с данными ({ code, params }), текст на языке человека — у интерфейса. Причина всегда правда про эту игру:
// если тег назван, он есть и у неё, и у названной игры, в которую играли; поэтому их собирает код, а не шаблон по баллам
const crypto = require('crypto');
const { normalizeTags } = require('../utils/tags.js');
const { shownTitle } = require('../utils/title.js');
const personal = require('./personal.js');

// Автор бывает составным («Ann/Bob», «A & B» — разработчик вместе с издателем): сверяем по частям, иначе целое «annbob» не совпало бы
// с «Bob». Короткие и общие («unknown», «various») — не автор, по ним совпадало бы что попало
const NOT_DEV = new Set(['unknown', 'anonymous', 'various', 'na', 'none', 'other', 'others', 'translator', 'team']);
const devKey = (name) => String(name || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const devKeys = (name) => String(name || '').split(/\s*(?:\/|&|,|\+|\|)\s*|\s+(?:x|and|feat\.?|ft\.?)\s+/i)
    .map(devKey).filter((k) => k.length >= 3 && !NOT_DEV.has(k));
// Теги формата — есть почти у всех игр и вкусов не выдают (как formatTags.js в интерфейсе)
const FORMAT_TAGS = new Set(['rpg', 'rpgm', 'rpg maker', 'rpg maker mv', 'rpg maker mz', 'rpg maker vx ace', 'rpg maker xp', 'japanese game', '2d game', 'animated']);

const DAY_MS = 24 * 3600 * 1000;
// Те же 14 дней и 10 минут, что у статуса игры в интерфейсе (frontend/src/gameStatus.js): запуск на пару минут «посмотреть» —
// ещё не игра. В живой библиотеке таких больше половины: считай их начатыми, и половину библиотеки нельзя было бы предложить ни так, ни так
const LEFT_AFTER_MS = 14 * DAY_MS;
const PLAYED_SEC = 10 * 60;
const WELL_PLAYED_SEC = 3600;
// Вес игры во вкусе. Не запущенная — почти ноль: сотня таких весит как один час игры
const NEVER_WEIGHT = 0.02;
const LOOKED_WEIGHT = 0.05;
const LIKED_FLOOR = 1.5;
const LIKED_FACTOR = 1.5;
// Тег на большей части библиотеки вкуса не выдаёт (как в forYou). На маленькой библиотеке доля ничего не значит
const COMMON_SHARE = 0.6;
const COMMON_MIN_LIBRARY = 10;
const FAVORITE_WEIGHT = 1;

// Вклады в балл. Вкус — от -1 до 1 (лучшая игра из кандидатов — 1), остальное подобрано по настоящей библиотеке
const DEV_BONUS = 0.7;
// Тот же автор — самое понятное объяснение: в списке причин всегда первое, какой бы ни был вклад тегов
const DEV_REASON = 10;
const BAD_DEV = -0.3;
const PICTURE_WEIGHT = 0.2;
const KNOWN_LANG = 0.08;
const OTHER_LANG_BUILD = 0.06;
const TRANSLATED_HERE = 0.08;
const UNKNOWN_LANG = -0.25;
const PLANNED_BASE = 0.05;
const PLANNED_MAX_WAIT = 0.15;
const PLANNED_FULL_DAYS = 365;
const LOOKED_PENALTY = -0.05;
// Сегодняшняя добавка: чтобы верх менялся день ото дня; вклады выше подобраны так, чтобы она не вытаскивала наверх чужое
const DAILY_JITTER = 0.25;

const MIN_REASON_STRENGTH = 0.03;
const TAG_REASON_MIN = 0.04;
const MAX_REASONS = 3;
const REASON_TAGS = 3;
const LIKE_GAMES = 4;

// Разнообразие: каждая уже выбранная игра того же автора или почти с теми же тегами отодвигает следующую
const SAME_DEV_PENALTY = 0.5;
const SAME_TAGS_PENALTY = 0.35;
const SAME_TAGS_FROM = 0.75;
const DIVERSE_POOL = 150;
const LIST_MAX = 60;
const RESUME_MAX = 12;

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const round2 = (x) => Math.round(x * 100) / 100;
const parseJson = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
// Список из базы: разобранное, но не список («5», «{}») — как пустой, иначе одна такая строка роняет весь ответ
const parseList = (s) => { const value = parseJson(s, []); return Array.isArray(value) ? value : []; };
// Теги картинок пишутся через подчёркивание, теги игр — через пробел: сверяем и скрытые, и те и другие
const plain = (t) => String(t ?? '').toLowerCase().replace(/_/g, ' ').trim();
// Скрытые теги — словами, какими зовутся и теги игр: те уже прошли через словарь, и «big_breasts» с кадров у игры — «big tits».
// Тег, который словарь разворачивает в два, не добавляем: скрыть «dark fantasy» не значит скрыть всё с «fantasy»
function hiddenSet(hidden) {
    const out = new Set();
    for (const tag of hidden) {
        const name = plain(tag);
        if (!name) continue;
        out.add(name);
        const mapped = normalizeTags([name]);
        if (mapped.length === 1) out.add(mapped[0]);
    }
    return out;
}
const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const dailyHash = (seed, id) => crypto.createHash('md5').update(`${seed}|${id}`).digest().readUInt32LE(0) / 0x100000000;

// Сколько весит игра во вкусе: чем больше наиграно, тем больше (логарифм, как в forYou); понравилась — больше, бросил — минус
function gameSignal(row) {
    const playtime = row.playtime || 0;
    const rating = row.rating || 0;
    const played = playtime >= PLAYED_SEC;
    const likes = rating >= 4 || row.status === 'done' || !!row.favorite;
    const dislikes = (rating >= 1 && rating <= 2) || row.status === 'dropped';
    let weight = played ? 1 + Math.log2(1 + playtime / 3600) : row.lastPlayed || playtime ? LOOKED_WEIGHT : NEVER_WEIGHT;
    // Поставил пятёрку и бросил — сигналы спорят, такая игра вкуса не выдаёт
    if (likes && dislikes) weight = 0;
    else if (likes) weight = Math.max(weight, LIKED_FLOOR) * LIKED_FACTOR;
    else if (dislikes) weight = -Math.max(1, weight);
    return { weight, likes, real: played || rating > 0 || (!!row.status && row.status !== 'wish') || !!row.favorite };
}

// Игра для расчётов: теги один раз разобраны, авторы по частям (devKeys), вес. Строка — как в базе
function prepare(row) {
    const tags = normalizeTags(parseList(row.tags));
    return {
        row,
        tags,
        tagSet: new Set(tags),
        // Для сравнения игр между собой формат не нужен: он у всех
        meaningful: new Set(tags.filter((t) => !FORMAT_TAGS.has(t))),
        devs: new Set(devKeys(row.developer)),
        ...gameSignal(row),
    };
}

// Вес тега: сумма весов игр с ним, умноженная на редкость, и доведённая до 1 у самого весомого
function tagWeights(entries, hide) {
    const sum = new Map();
    const seen = new Map();
    for (const { tags, weight } of entries) {
        for (const tag of tags) {
            seen.set(tag, (seen.get(tag) || 0) + 1);
            sum.set(tag, (sum.get(tag) || 0) + weight);
        }
    }
    const total = entries.length;
    const out = new Map();
    let top = 0;
    for (const [tag, value] of sum) {
        if (FORMAT_TAGS.has(tag) || hide.has(plain(tag))) continue;
        if (total >= COMMON_MIN_LIBRARY && seen.get(tag) > total * COMMON_SHARE) continue;
        const raw = value * Math.log(1 + total / seen.get(tag));
        out.set(tag, raw);
        top = Math.max(top, Math.abs(raw));
    }
    if (top > 0) for (const [tag, raw] of out) out.set(tag, raw / top);
    return out;
}

// Вкус. rows — все готовые игры, и с полки: в них тоже играли. pictures — { id игры: [теги кадров] }, не у всех
function buildTaste(rows, { favorites = [], hidden = [], pictures = {} } = {}) {
    const hide = hiddenSet(hidden);
    const games = rows.map(prepare);
    // Ни во что не играли — вкуса нет: одни не запущенные игры дали бы веса, доведённые до 1, из ничего
    const cold = !games.some((g) => g.real);
    const tags = cold ? new Map() : tagWeights(games, hide);
    const fav = new Set(normalizeTags(favorites).filter((t) => !hide.has(plain(t))));
    // Любимые теги — выбрал сам: сильнее наигранного, даже если игр с ними ещё не запускал
    for (const tag of fav) tags.set(tag, Math.max(tags.get(tag) || 0, 0) + FAVORITE_WEIGHT);
    const liked = games.filter((g) => g.real && g.weight > 0).sort((a, b) => b.weight - a.weight);

    const devs = new Map();
    for (const g of liked) {
        if ((g.row.playtime || 0) < WELL_PLAYED_SEC && !g.likes) continue;
        for (const key of g.devs) if (!devs.has(key)) devs.set(key, g);
    }
    const badDevs = new Set();
    for (const g of games) if (g.real && g.weight < 0) for (const key of g.devs) if (!devs.has(key)) badDevs.add(key);
    const byId = new Map(games.map((g) => [g.row.id, g]));
    const pictureEntries = [];
    for (const [id, list] of Object.entries(pictures)) {
        const g = byId.get(id);
        if (g && Array.isArray(list) && list.length) pictureEntries.push({ tags: list.filter((t) => !hide.has(plain(t))), weight: g.weight });
    }
    return {
        games, tags, favorites: fav, hide, liked, devs, badDevs, pictures,
        pictureTags: tagWeights(pictureEntries, hide),
        cold,
    };
}

// Игру со скрытым тегом не предлагаем вовсе: человек скрыл то, чего видеть не хочет, а не только «не считать во вкус»
const hasHiddenTag = (tags, taste) => tags.some((t) => taste.hide.has(plain(t)));

// Сколько теги игры дают вкусу. Делим на корень из числа тегов: иначе выигрывают игры с длинным списком тегов
function tagMatch(tags, taste) {
    const scale = Math.sqrt(Math.max(4, tags.length));
    let total = 0;
    const liked = [];
    const favorite = [];
    for (const tag of tags) {
        const w = taste.tags.get(tag);
        if (!w) continue;
        total += w / scale;
        if (taste.favorites.has(tag)) favorite.push([tag, w]);
        else if (w > 0) liked.push([tag, w]);
    }
    const byWeight = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
    return { total, scale, liked: liked.sort(byWeight), favorite: favorite.sort(byWeight) };
}

// Игра, в которую играли, с теми же тегами; называем только общие с ней теги. Подходят те, где общих тегов на полную причину:
// самая наигранная совпала бы почти со всем, и весь список говорил бы про неё одну. Из подходящих — постоянно одна на игру
function likeGame(tags, taste, salt) {
    const wanted = tags.slice(0, REASON_TAGS * 2);
    const found = taste.liked
        .filter((g) => g.row.id !== salt)
        .map((game) => ({ game, tags: wanted.filter(([tag]) => game.tagSet.has(tag)) }))
        .filter((x) => x.tags.length);
    if (!found.length) return null;
    const need = Math.min(REASON_TAGS, Math.max(...found.map((x) => x.tags.length)));
    const fit = found.filter((x) => x.tags.length >= need).slice(0, LIKE_GAMES);
    const { game, tags: shared } = fit[Math.floor(dailyHash('like', salt) * fit.length)];
    return { game, tags: shared.slice(0, REASON_TAGS) };
}

const gameRef = (g) => ({ game: shownTitle(g.row).title, gameId: g.row.id, playtime: g.row.playtime || 0 });

// Причины от вкуса — общие у игр библиотеки и карточек сайтов. norm — на что делить совпадение тегов
function tasteReasons(match, taste, norm, salt) {
    const parts = [];
    if (match.favorite.length) {
        parts.push({
            code: 'favorite-tags',
            params: { tags: match.favorite.slice(0, REASON_TAGS).map(([t]) => t) },
            strength: match.favorite.reduce((sum, [, w]) => sum + w, 0) / match.scale / norm,
        });
    }
    const strength = match.liked.reduce((sum, [, w]) => sum + w, 0) / match.scale / norm;
    if (strength >= TAG_REASON_MIN) {
        const like = likeGame(match.liked, taste, salt);
        if (like) {
            const { game, gameId } = gameRef(like.game);
            parts.push({ code: 'tags-like', params: { tags: like.tags.map(([t]) => t), game, gameId }, strength });
        }
    }
    return parts;
}

// Тот же автор, что у игры, в которую хорошо играли (или которая понравилась). Имя — то, что совпало: у составного
// «Ann/Bob» автор может быть вторым
function sameDev(names, taste, ownId = null) {
    for (const name of names) {
        for (const key of devKeys(name)) {
            const g = taste.devs.get(key);
            if (g && g.row.id !== ownId) return { code: 'same-dev', params: { dev: name, ...gameRef(g) }, strength: DEV_REASON };
        }
    }
    return null;
}

// Язык: сначала текст самой игры. Столбец language ищем только если текст ещё не читали: магазин про всё пишет «Japanese»
const LANG_CODES = {
    english: 'en', russian: 'ru', german: 'de', japanese: 'ja', chinese: 'zh', korean: 'ko', spanish: 'es', french: 'fr', portuguese: 'pt', italian: 'it', polish: 'pl', indonesian: 'id',
};
function languageFit(row, known, mtLang) {
    if (!known.size) return { value: 0, parts: [] };
    const text = parseJson(row.text_lang, null) || {};
    const typed = plain(row.language);
    const main = text.main || LANG_CODES[typed] || (/^[a-z]{2}$/.test(typed) ? typed : '');
    if (main && known.has(main)) return { value: KNOWN_LANG, parts: [{ code: 'known-lang', params: { lang: main }, strength: KNOWN_LANG }] };
    const build = (Array.isArray(text.langs) ? text.langs : []).find((x) => known.has(x));
    if (build) return { value: OTHER_LANG_BUILD, parts: [{ code: 'known-lang', params: { lang: build }, strength: OTHER_LANG_BUILD }] };
    if (mtLang && known.has(mtLang)) return { value: TRANSLATED_HERE, parts: [{ code: 'translation', params: { lang: mtLang, site: 'mimikin' }, strength: TRANSLATED_HERE }] };
    // Язык ещё не определён — это не «чужой»
    return { value: main ? UNKNOWN_LANG : 0, parts: [] };
}

// Что предлагать. Не начатые: ни разу не запускали или смотрели пару минут. Оценил — значит, знает её, предлагать незачем.
// «В планы» — всегда, сам выбрал, разве что потом оценил единицей или двойкой
function isCandidate(row) {
    if (row.ready !== undefined && !row.ready) return false;
    if (row.shelved_at) return false;
    const rating = row.rating || 0;
    if (row.status === 'wish') return !(rating >= 1 && rating <= 2);
    return !row.status && !rating && (row.playtime || 0) < PLAYED_SEC;
}

// Теги кадров: балл игры от среднего по размеченным, чтобы игра без разметки (ноль) не оказывалась хуже в среднем
function pictureScores(candidates, taste) {
    const raw = new Map();
    for (const g of candidates) {
        const list = taste.pictures[g.row.id];
        if (!Array.isArray(list) || !list.length) continue;
        raw.set(g.row.id, list.reduce((sum, t) => sum + (taste.pictureTags.get(t) || 0), 0) / Math.sqrt(Math.max(4, list.length)));
    }
    if (!raw.size) return raw;
    const mean = [...raw.values()].reduce((sum, x) => sum + x, 0) / raw.size;
    const top = Math.max(...[...raw.values()].map((x) => Math.abs(x - mean))) || 1;
    for (const [id, x] of raw) raw.set(id, clamp((x - mean) / top));
    return raw;
}

// Балл и причины одной игры библиотеки
function scoreGame(g, taste, { norm, picture, known, mtLang, now }) {
    const { row } = g;
    const match = tagMatch(g.tags, taste);
    const parts = tasteReasons(match, taste, norm, row.id);
    let score = clamp(match.total / norm);

    const same = sameDev([row.developer], taste, row.id);
    if (same) {
        score += DEV_BONUS;
        parts.push(same);
    } else if ([...g.devs].some((key) => taste.badDevs.has(key))) score += BAD_DEV;

    // Причиной кадры не называем: редкие теги разметчика («:o», «formal») читаются как чушь
    if (picture !== undefined) score += PICTURE_WEIGHT * picture;

    const lang = languageFit(row, known, mtLang);
    score += lang.value;
    parts.push(...lang.parts);

    if (row.status === 'wish') {
        // Когда игру отложили, база не знает: ждёт она самое меньшее с тех пор, как появилась в библиотеке
        const days = row.addedAt ? Math.max(0, now - row.addedAt) / DAY_MS : 0;
        const planned = PLANNED_BASE + PLANNED_MAX_WAIT * Math.min(1, days / PLANNED_FULL_DAYS);
        score += planned;
        parts.push({ code: 'planned', params: { at: row.addedAt || 0 }, strength: planned });
    } else if (row.lastPlayed || row.playtime) score += LOOKED_PENALTY;

    return { score, reasons: finishReasons(parts) };
}

// Сильнейшие первыми, не больше трёх; совсем слабые не называем — это не причина
function finishReasons(parts) {
    return parts
        .filter((p) => p.strength >= MIN_REASON_STRENGTH || p.code === 'translation')
        .sort((a, b) => b.strength - a.strength)
        .slice(0, MAX_REASONS)
        .map(({ code, params }) => ({ code, params }));
}

// Почти одинаковые игры не должны занять весь верх: жадно берём лучшую с учётом уже взятых. Считаем только верх списка,
// на тысячах игр дальше порядок всё равно никто не увидит
function diversify(list) {
    const pool = list.slice(0, DIVERSE_POOL);
    const out = [];
    const similar = (a, b) => {
        if (!a.meaningful.size || !b.meaningful.size) return 0;
        let both = 0;
        for (const tag of a.meaningful) if (b.meaningful.has(tag)) both++;
        return both / (a.meaningful.size + b.meaningful.size - both);
    };
    while (pool.length) {
        let bestIndex = 0;
        let bestValue = -Infinity;
        pool.forEach((item, i) => {
            let value = item.order;
            for (const taken of out) {
                if ([...item.game.devs].some((key) => taken.game.devs.has(key))) value -= SAME_DEV_PENALTY;
                if (similar(item.game, taken.game) >= SAME_TAGS_FROM) value -= SAME_TAGS_PENALTY;
            }
            if (value > bestValue) {
                bestValue = value;
                bestIndex = i;
            }
        });
        out.push(pool.splice(bestIndex, 1)[0]);
    }
    return [...out, ...list.slice(DIVERSE_POOL)];
}

// Порядок игр библиотеки. rows — строки games. Оценка считается до отбора по скрытым: они не должны менять баллы.
// seed — обычно день: один день — один порядок, на другой верх другой. → { cold, total, items: [{ id, score, reasons }] }
function rankLibrary(rows, options = {}) {
    const { now = Date.now(), seed = dayKey(now), dismissed = [], known = [], translated = {}, limit = LIST_MAX } = options;
    const taste = buildTaste(rows, options);
    const knownSet = new Set(known);
    const gone = new Set(dismissed);

    const candidates = taste.games.filter((g) => isCandidate(g.row) && !hasHiddenTag(g.tags, taste));
    const norm = Math.max(0.0001, ...candidates.map((g) => Math.abs(tagMatch(g.tags, taste).total)));
    const pictures = pictureScores(candidates, taste);

    const scored = candidates
        .filter((g) => !gone.has(g.row.id))
        .map((game) => {
            const { score, reasons } = scoreGame(game, taste, { norm, picture: pictures.get(game.row.id), known: knownSet, mtLang: translated[game.row.id], now });
            return { game, score, reasons, order: score + DAILY_JITTER * dailyHash(seed, game.row.id) };
        })
        .sort((a, b) => b.order - a.order || (a.game.row.id < b.game.row.id ? -1 : 1));

    return {
        // cold говорит человеку «вкус не учтён»: при любимых тегах это неправда, порядок и причина уже от них
        cold: taste.cold && !taste.favorites.size,
        total: scored.length,
        items: diversify(scored).slice(0, limit).map((x) => ({ id: x.game.row.id, score: round2(x.score), reasons: x.reasons })),
    };
}

// Начатые и оставленные: играли хотя бы десять минут, больше двух недель назад, не прошёл, не бросил и не оценил единицей или
// двойкой: такую он уже не любит (gameSignal), вернуться в неё не предлагаем. Больше наиграно — выше.
// «В планы» с наигранным здесь нет: она уже в основном списке. Время из сейвов без запуска в Mimikin (lastPlayed = 0): когда
// играли, неизвестно, недавно — вряд ли, запуск отметился бы. at у неё 0
function resumeList(rows, { now = Date.now(), dismissed = [], hidden = [], limit = RESUME_MAX } = {}) {
    const taste = { hide: hiddenSet(hidden) };
    const gone = new Set(dismissed);
    return rows
        .filter((row) => (row.ready === undefined || row.ready) && !row.shelved_at && !gone.has(row.id))
        .filter((row) => (!row.status || row.status === 'playing') && (row.playtime || 0) >= PLAYED_SEC)
        .filter((row) => !(row.rating >= 1 && row.rating <= 2))
        .filter((row) => !row.lastPlayed || now - row.lastPlayed > LEFT_AFTER_MS)
        .filter((row) => !hasHiddenTag(normalizeTags(parseList(row.tags)), taste))
        .sort((a, b) => b.playtime - a.playtime || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((row) => ({ id: row.id, reasons: [{ code: 'left', params: { playtime: row.playtime, at: row.lastPlayed || 0 } }] }));
}

const DISMISSED_MAX = 2000;
// Что можно скрыть кроме своих игр — карточки itch.io, те же ключи, что в интерфейсе (catalogItems.js)
const CATALOG_KEY = /^itch:[1-9]\d{0,11}$/;
const DISMISSED_SETTING = 'recommend_dismissed';
// Сборка: база и разметка кадров. Подбор идёт только по своей библиотеке: сайтов, откуда брать чужие карточки, у открытой версии нет
function createRecommend({ db, gallery, pictureGames, hiddenTags, offline = false, isGameId = () => false }) {
    let writes = Promise.resolve();

    const readSetting = async (key) => parseList((await db.get().get('SELECT value FROM settings WHERE key = ?', [key]))?.value);
    // Для показа сбой чтения — как пустая настройка: подбор работает и без неё. Запись так читать нельзя (dismiss)
    const setting = (key) => readSetting(key).catch(() => []);
    // Человек, не владелец: игры те же, а играно, оценки и статусы — его (services/personal.js). Настройки владельца (любимые теги,
    // языки, скрытые теги, «не интересно») ему не принадлежат — у него они пустые
    const settingFor = (person, key) => (personal.other(person) ? Promise.resolve([]) : setting(key));
    const hiddenFor = (person) => (personal.other(person) ? Promise.resolve([]) : hiddenTags());
    const readRows = (person) => db.get().all(`SELECT id, title, tags, developer, playtime, lastPlayed, rating, status, favorite,
        shelved_at, ready, text_lang, language, addedAt, link, meta_locked FROM games WHERE ready = 1`)
        .then((rows) => personal.overlay(rows, person, { raw: true }));

    // Разметки может не быть вовсе (разбор кадров выключен): тогда просто без неё
    const readPictures = async (hide) => {
        try {
            const { tags, games } = await gallery.libraryTags(await pictureGames(), { hide });
            const out = {};
            for (const [id, pairs] of Object.entries(games)) {
                out[id] = [];
                for (let i = 0; i < pairs.length; i += 2) out[id].push(tags[pairs[i]]);
            }
            return out;
        } catch (e) {
            console.warn('[Подбор] Теги кадров:', e.message);
            return {};
        }
    };

    async function library({ now = Date.now(), person } = {}) {
        const [rows, favorites, known, hidden, dismissed] = await Promise.all([readRows(person), settingFor(person, 'favorite_tags'), settingFor(person, 'known_langs'), hiddenFor(person), settingFor(person, DISMISSED_SETTING)]);
        // Только законченный перевод: язык в строке появляется уже при включении, когда ещё ничего не переведено
        const translated = {};
        for (const row of await db.get().all("SELECT id, lang FROM game_translation WHERE lang != '' AND state = 'done' AND done > 0").catch(() => [])) translated[row.id] = row.lang;
        const pictures = await readPictures(hidden);
        const list = rankLibrary(rows, { now, dismissed, known, translated, favorites, hidden, pictures });
        return { ...list, resume: resumeList(rows, { now, dismissed, hidden }) };
    }

    // Что знаем о вкусе: new — игр нет и ничего не выбрано; collection — игры есть, но вкус они не выдают; known — вкус есть.
    // cold этого не скажет: он про наигранное и любимых тегов не учитывает
    const tasteStage = (taste) => ({ stage: taste.favorites.size || !taste.cold ? 'known' : taste.games.length ? 'collection' : 'new', games: taste.games.length });

    // Шапка «Найти»: без походов в сеть. Режим один — свои игры (list); вкус нужен окну, чтобы сказать «играйте, и подбор подстроится»
    async function modes({ person } = {}) {
        const [rows, favorites, hidden] = await Promise.all([readRows(person), settingFor(person, 'favorite_tags'), hiddenFor(person)]);
        return { offline, taste: tasteStage(buildTaste(rows, { favorites, hidden })), modes: ['list'] };
    }

    // «Не интересно»: только список ключей в настройках, у игры ничего не меняется. Запись за записью: два быстрых нажатия
    // читают и пишут один и тот же список, и второе не должно потерять первое
    function dismiss(key, { undo = false } = {}) {
        const text = typeof key === 'string' ? key : '';
        const badKey = () => Object.assign(new Error('Непонятно, что скрыть'), { status: 400, reason: 'bad-key' });
        const catalog = CATALOG_KEY.test(text);
        if (!catalog && !isGameId(text)) return Promise.reject(badKey());
        const write = writes.then(async () => {
            // Имя папки может быть почти любым, и «itch:abc» тоже годится по виду. Скрыть можно только свою игру; отменить — и пропавшую
            if (!catalog && !undo && !await db.get().get('SELECT id FROM games WHERE id = ?', [text])) throw badKey();
            // Прочитать не вышло — запись не делаем: из пустого списка она стёрла бы всё, что человек скрыл раньше
            const current = await readSetting(DISMISSED_SETTING);
            const next = current.filter((x) => x !== text);
            if (!undo) next.push(text);
            // Самые старые уходят первыми: список не растёт без конца
            const kept = next.slice(-DISMISSED_MAX);
            await db.get().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [DISMISSED_SETTING, JSON.stringify(kept)]);
            return { ok: true, dismissed: kept.length };
        });
        writes = write.catch(() => {});
        return write;
    }

    // Пропустил «Отменить» в тосте — вернуть скрытое можно только отсюда (Настройки). В той же очереди записи, что и dismiss
    const dismissedCount = async () => ({ count: (await readSetting(DISMISSED_SETTING)).length });
    function resetDismissed() {
        const write = writes.then(async () => {
            await db.get().run('DELETE FROM settings WHERE key = ?', [DISMISSED_SETTING]);
            return { ok: true, dismissed: 0 };
        });
        writes = write.catch(() => {});
        return write;
    }

    return { library, modes, dismiss, dismissedCount, resetDismissed };
}

module.exports = { buildTaste, rankLibrary, resumeList, isCandidate, gameSignal, dayKey, createRecommend };
