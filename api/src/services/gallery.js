const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const { Transform } = require('stream');
const scenes = require('./galleryScenes.js');
const advScenes = require('./galleryAdv.js');
const extern = require('./galleryExtern.js');
const sceneLangs = require('./sceneLangs.js');
const vision = require('./galleryVision.js');
const { readGameJson, readGameText, mediaKey, forgetGame } = require('../utils/gameData.js');
const { dhash: imagePrint } = require('../utils/imagehash.js');

// Галерея из файлов самой игры: её картинки — CG, персонажи, фоны — листать, не проходя игру.
// Файлы игры только читаем: оглавление и миниатюры — в _media/<игра>/, расшифровка — в памяти.
//
// Оглавление строится один раз (в фоне или при первом открытии): для каждой картинки хватает
// первых 40 байт — размеры PNG лежат в заголовке и у зашифрованных (.rpgmvp, .png_) не шифруются.
// По размеру, «весу» файла и имени картинка попадает в раздел:
//   cg       — во весь экран игры и плотная: CG и сцены
//   backdrop — во весь экран, но это фон: папки фонов карт и боёв, имена «Bg_…», «Sky…», «背景…»
//   layer    — во весь экран, но почти пустая (прозрачный слой, из которых игра собирает CG)
//   portrait — высотой в экран, но уже его: персонаж в полный рост
//   other    — мелкое: интерфейс, значки
//   animation — движется сама: GIF, анимированный PNG (APNG) и WebP — любого размера; и ролик не длиннее
//              двух секунд без звука — это повторяющаяся анимация сцены, а не заставка (играет по кругу)
//   video    — ролики: папка movies/ (заставки, сцены) и видео, которые плагины кладут в img/
// Альбом — одна сцена со всеми вариантами и кадрами: имя до первой части с цифрой (albumKey)
const ENGINE_DIRS = new Set(['characters', 'faces', 'tilesets', 'system', 'animations', 'battlebacks1', 'battlebacks2',
    'enemies', 'sv_actors', 'sv_enemies', 'weather']);
const IMAGE = /\.(png|rpgmvp|png_|jpe?g|webp|gif)$/i;
// Ролики. RPG Maker их не шифрует; браузер играет WebM и MP4 сам
const VIDEO = /\.(webm|mp4|m4v|ogv)$/i;
const VIDEO_TYPE = { webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4', ogv: 'video/ogg' };
// Ролик под чужим расширением: у Sky Knight Chronicles 275 сцен — «movies/scene03.pprn», а внутри обычный WebM. В
// оглавлении он — «movies/scene03.pprn#.webm»: всюду, где ролик узнают по расширению (здесь, на странице, в «Избранном»),
// он им и будет. Сам файл — имя до «#»
const ALIAS = /#\.(webm|mp4)$/i;
const realFile = (rel) => rel.replace(ALIAS, '');
// Имя без расширения: у псевдонима — без своего («.pprn#.webm»)
const bareName = (name) => (ALIAS.test(name) ? realFile(name).replace(/\.[^./]+$/, '') : name.replace(IMAGE, '').replace(VIDEO, ''));
// Что за ролик по первым байтам: WebM (заголовок EBML) или MP4 («ftyp»)
async function sniffVideo(file) {
    const fh = await fsp.open(file, 'r').catch(() => null);
    if (!fh) return null;
    try {
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(12), 0, 12, 0);
        if (bytesRead < 12) return null;
        if (buffer.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
        if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
        return null;
    } finally {
        await fh.close();
    }
}
// Тип ролика — по первым байтам, а не по имени: MP4 под именем .webm (Me_and_Dragon, Moonlit Library) Safari играет, только если
// сказать «mp4». Нет ни одного признака — вернём null, и тип возьмут по расширению
async function videoType(file) {
    const fh = await fsp.open(file, 'r').catch(() => null);
    if (!fh) return null;
    try {
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(12), 0, 12, 0);
        if (bytesRead < 12) return null;
        if (buffer.readUInt32BE(0) === 0x1a45dfa3) return VIDEO_TYPE.webm;
        if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') return VIDEO_TYPE.mp4;
        if (buffer.subarray(0, 4).toString('latin1') === 'OggS') return VIDEO_TYPE.ogv;
        return null;
    } finally {
        await fh.close();
    }
}
// Плагины роликов игры — по их коду, не по имени в списке (у Flash Knight «MovieManager» — это MoviePicture 1.3.3).
// movieManager — включён плагин со своим command261 («Показать видео» не ждёт и стоит где сказали — такое не пишем);
// keepEnd — у MoviePicture «удалять по окончании» выключено: кончившийся ролик стоит на последнем кадре
async function videoFlags(root) {
    const out = { movieManager: false, keepEnd: false };
    let text;
    try { text = await fsp.readFile(path.join(root, 'js', 'plugins.js'), 'utf8'); } catch { return out; }
    for (const part of text.split(/\{\s*["']?name["']?\s*:/).slice(1)) {
        const m = /^\s*["']([^"'\/\\]+)["']/.exec(part);
        if (!m || !/["']?status["']?\s*:\s*true/.test(part.slice(0, 400)) || !/movie|video|動画|ムービー/i.test(part.slice(0, 600))) continue;
        let code = '';
        try { code = await fsp.readFile(path.join(root, 'js', 'plugins', `${m[1]}.js`), 'utf8'); } catch { continue; }
        if (/prototype\.command261\s*=/.test(code)) out.movieManager = true;
        if (/MP_SET_MOVIE|setVideoPicture\b/.test(code) && /["']?(?:autoEraseOnEnd|終了時自動削除)["']?\s*:\s*["']\s*false\s*["']/.test(part)) out.keepEnd = true;
    }
    return out;
}
// Прозрачность WebM: элемент AlphaMode (53 C0) = 1 в заголовке дорожки — в первых 64 КБ (сверено с ffprobe на 1455 роликах)
async function videoAlpha(file) {
    const fh = await fsp.open(file, 'r').catch(() => null);
    if (!fh) return false;
    try {
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
        const b = buffer.subarray(0, bytesRead);
        return b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3 && b.indexOf(Buffer.from([0x53, 0xc0, 0x81, 0x01])) >= 0;
    } finally {
        await fh.close();
    }
}
// Файлы моделей Spine и Live2D рядом с текстурами
const RIG = /\.(atlas(\.txt)?|skel|moc3?|model3?\.json)$/i;
// Сколько начала файла читаем: размеры и признак анимации. У PNG признак (acTL) стоит до первых
// данных картинки, но после необязательных блоков вроде профиля цвета — 4 КБ хватает
const DENSE = 0.12;   // байт на пиксель: плотнее — настоящая картинка, реже — прозрачный слой
const DENSE_WEBP = 0.02; // WebP сжимает раз в пять сильнее PNG — и порог ниже
// PNG с палитрой (256 цветов) — байт на пиксель втрое меньше, чем у полноцветного: кадры анимаций Freya's Potion Shop
// во весь экран — 0,11 байта на пиксель, а прозрачный слой и в палитре — сотые доли
const DENSE_PALETTE = 0.04;
// Сколько картинки во весь экран непрозрачно и на какой ширине. Почти пустой холст с фигурой узкой полосой —
// персонаж в рост («Reiri_Base» в Dragon Conqueror: 15 %, по байтам плотная, а по бокам пусто): слой, а не CG.
// Поза во всю ширину без фона (нижний слой сцены в Seven Keys — 20 %) и H-CG без фона (Alter Echo — 75 %,
// фон игра кладёт снизу) — CG, но основой склейки лучше картинка, закрывающая весь экран
const OPAQUE_LAYER = 0.35;
const OPAQUE_BASE = 0.9;
const NARROW = 0.4;   // доля столбцов с рисунком: у персонажа в рост — полоса посередине (28 %), у позы сцены — 47 % и шире
const THUMB_WIDTH = 360;
const LANG_MEMO = 8;        // игр, у которых таблица языков сцен держится в памяти
const LANG_WAIT = 4000;     // мс: дольше сцена таблицу не ждёт, показывает оригинал, а таблица достроится для следующей
const THUMB_TIMEOUT_MS = 30 * 1000;
const HEAD_BYTES = 4096;
// Ролик-петля: не длиннее двух секунд и без звука. У игр библиотеки такие — кадры H-сцен по кругу
// (в Whispers of the Dark Elf 250 из 252 роликов), а короткие со звуком — реплики (Alter Echo)
const LOOP_MAX_SECONDS = 2.05;
const PROBE_TIMEOUT_MS = 10 * 1000;
// ffprobe не ответил хоть про один ролик — оглавление временное: через час соберём заново, иначе петля
// так и осталась бы роликом с плеером
const PROBE_RETRY_MS = 60 * 60 * 1000;
// Сколько первых кадров каждой анимации из склеек готовим заранее, когда открыли галерею
const PREWARM_FRAMES = 24;
// Лёгкая копия PNG для просмотра (view()): с какого размера оригинала её делаем, во сколько раз она должна быть
// меньше, чтобы стоило её держать, и до какого размера человека дожидаются (больше — отдаём оригинал, копию делаем
// фоном к следующему разу). Диск у сервера почти полон, поэтому при малом остатке копий не пишем. Следом за
// открытой картинкой готовим VIEW_AHEAD соседних
const VIEW_MIN = 256 * 1024;
const VIEW_RATIO = 0.8;
const VIEW_WAIT_MAX = 3 * 1024 * 1024;
const VIEW_MIN_FREE = 5 * 1024 ** 3;
const VIEW_AHEAD = 8;
const VIEW_TIMEOUT_MS = 120 * 1000;
// Сбой кодирования не по вине файла (таймаут под нагрузкой, kill, EBUSY) маркером не отмечаем, а пробуем снова не раньше
// чем через VIEW_RETRY_MS. В prewarm — первые экраны, а не всё подряд (у игр с тысячами PNG это десятки минут и гигабайты);
// потолок view/ на игру — на случай, когда человек сам листает тысячи картинок
const VIEW_RETRY_MS = 10 * 60 * 1000;
const VIEW_PREWARM_CG = 16;
const VIEW_PREWARM_ANIM = 8;
const VIEW_DIR_MAX = 2 * 1024 ** 3;

// Анимированный PNG: число проигрываний (acTL; 0 — без конца) и задержка последнего кадра в мс (последний fcTL).
// Не APNG, а у APNG один кадр — null: такой просто картинка
function apngInfo(data) {
    if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) return null;
    let frames = 0; let plays = 0; let delay = 0;
    for (let at = 8; at + 8 <= data.length;) {
        const len = data.readUInt32BE(at);
        const type = data.toString('latin1', at + 4, at + 8);
        if (type === 'acTL' && len >= 8) { frames = data.readUInt32BE(at + 8); plays = data.readUInt32BE(at + 12); }
        if (type === 'fcTL' && len >= 26) {
            const den = data.readUInt16BE(at + 8 + 22) || 100;
            delay = Math.round(data.readUInt16BE(at + 8 + 20) * 1000 / den);
        }
        at += 12 + len;
    }
    return frames > 1 ? { plays, delay } : null;
}

// ffmpeg пишет в WebP-анимацию последнему кадру среднюю задержку, а не свою: берём из PNG. Длительность кадра — 3 байта
// в конце заголовка ANMF (после X, Y, ширины и высоты по 3 байта)
function setLastFrameDelay(webp, ms) {
    if (!(ms > 0) || webp.length < 12) return webp;
    let last = -1;
    for (let at = 12; at + 8 <= webp.length;) {
        if (webp.toString('latin1', at, at + 4) === 'ANMF') last = at;
        at += 8 + webp.readUInt32LE(at + 4) + (webp.readUInt32LE(at + 4) & 1);
    }
    if (last < 0) return webp;
    webp.writeUIntLE(Math.min(ms, 0xffffff), last + 8 + 12, 3);
    return webp;
}
// Сколько кадров листа анимации склеивает один ffmpeg (запрошенный и следующие за ним в альбоме) и сколько таких пачек
// заводим вперёд
const FRAME_BATCH = 8;
const FRAME_BATCHES = 3;
// Распознавание (galleryVision.js): альбом CG, где ни один из VISION_SAMPLES кадров не похож на сцену больше чем на
// VISION_SCENE, — экран игры (меню, карточка, фон без людей, карта, титры): из CG — во «Всё»
const VISION_SCENE = 0.4;
const VISION_SAMPLES = 3;
const VISION_FAILED = -1;
// Сцену-панель (galleryScenes.panelStack: детали без CG) переводим из «Персонажей» в CG увереннее, чем оставляем CG:
// портрет с лицом поверх не должен стать сценой
const VISION_PROMOTE = 0.6;
// Проб-групп на игру (по три кадра); добавочные кадры PROBE_REST считаются в тех же кадрах, а не отдельной пробой
const PROBE_MAX = 400;
// Кадров группы-панели сверх первых трёх проб, которые распознавание судит, если три ответили «нет»
const PROBE_REST = 24;
// Склейку на «окне» обрезаем по нему, если окно занимает меньше этой доли экрана
const CROP_MAX = 0.6;
// Альбом по имени больше этого — набор, а не сцена: делим по следующей части имени
const BIG = 120;
// Папка позы (детали героини, которые игра собирает кодом) — от стольких картинок
const POSE_MIN = 40;
// Альбом по имени с номерами «сцена+кадр» делим по сцене от стольких картинок
const NUM_SPLIT = 24;
// Петли одного события от стольких роликов — по наборам имён
const LOOP_GROUP = 8;
// Соседние картинки одной сцены: отпечатки dHash различаются не больше чем на столько бит из 64
const DHASH_NEAR = 22;
// Вспышка или затемнение — по имени и почти пустому файлу (байт на точку)
const FLAT_NAME = /^(?:white|black|fade|flash|blank|whiteout|blackout)(?:[_\-\s]?(?:out|in))?(?:[_\-\s]?\d+)?$/i;
const FLAT_BYTES = 0.02;
// Сколько байт читаем, чтобы найти одинаковые картинки под разными именами, и сколько — с каждого края файла для
// отпечатка
const DEDUPE_BYTES = 768 * 1024 * 1024;
const DEDUPE_SAMPLE = 64 * 1024;
// 28: у альбомов событий с репликами или звуком — флаг script (сценарий для плеера сцены: кадры анимаций, эффекты экрана,
// голоса), сценарии — в папке своей сборки (index.scripts)
// 29: полные составные картинки, размер экрана по последнему плагину, гостевые сцены анимаций (поздние события),
// альбомы и сцены Live2D, вложенные \V-имена и строчные коды
// 30: движущиеся картинки (APNG, GIF, WebP) в альбоме вместе с неподвижными — своим альбомом «#loop», а не весь альбом «Анимации»
const INDEX_VERSION = 30;
// Вызов Spine-плагина в скрипте события (PKD Spine2DPlayer, PictureSpine): такие события без картинок читаем отдельно (readSources)
// и Live2D (PictureLive2D, Live2DInterfaceMZ) — они идут теми же слоями
const SPINE_CALL = /\b(?:CreateSAnim|SAnim|RemoveSAnim)\s*\(|\$gameScreen\s*\.\s*(?:spine|live2d)\s*\(/;
const callsSpine = (list) => list.some((x) => x && (((x.code === 355 || x.code === 655) && SPINE_CALL.test(String(x.parameters?.[0]))) || (x.code === 357 && x.parameters?.[0] === 'Live2DInterfaceMZ')));
const SPINE_SOURCES_MAX = 1500; // событий только со Spine или Live2D на игру: каждое разбирается отдельно, у испорченных данных предела нет (у Welcome — 530: кирпичи Live2D зовут десятки карт)
const SCENES_MAX = 40;       // сцен-гостей на альбом: больше в одном списке выбора не нужно (и файлов сценариев — не тысячи)
// Таблицы реплик плагина DialogFromCSVwithPic (data/*.csv): на файл, на все и сколько файлов. У единственной такой игры
// 166 файлов на 2,2 МБ — пределы только от испорченных данных
const CSV_MAX = 4 * 1024 * 1024;
const CSV_TOTAL = 32 * 1024 * 1024;
const CSV_FILES = 1000;
// Подсказка облака (services/galleryCloud.js): альбом «Слоёв» или «Прочего», чьи картинки облачный набор считает CG,
// — в CG. Это CG без фона: края прозрачные, и по замеру непрозрачности он выглядел слоем (Clockwork Vale — 166 таких)
const CLOUD_PROMOTE = new Set(['layer', 'other']);
const RANK = { video: 6, animation: 5, cg: 4, portrait: 3, backdrop: 2, layer: 1, other: 0, engine: -1 };
// Готовые картинки из слоёв (galleryScenes.js, composeFrames): их «файлы» — не файлы игры, а «@cg/<отпечаток набора
// слоёв>», которые склеивает ffmpeg. Отпечаток — по составу: та же картинка после пересборки — тот же адрес (избранное
// не теряется). Описание слоёв — рядом с оглавлением, gallery-scenes.json
const CG_PREFIX = '@cg/';
// Кадр листа анимации (cell) — тоже в отпечатке; у прочих слоёв его нет, и адреса прежних склеек не меняются
const cgHash = (layers) => crypto.createHash('sha1').update(JSON.stringify(layers.map((l) => {
    const k = [l.rel, l.x, l.y, l.o, l.zx, l.zy, l.op];
    if (l.cell) k.push([l.cell.i, l.cell.n, l.cell.dir]);
    return k;
}))).digest('hex').slice(0, 20);

function screenOf(system) {
    const w = Number(system?.advanced?.screenWidth) || 816;
    const h = Number(system?.advanced?.screenHeight) || 624;
    return { w, h };
}

// Фоны карт (parallaxes) и боёв — «Фоны», хоть и во весь экран. Так же картинки с именем фона
const BACKDROP_DIRS = new Set(['parallaxes', 'battlebacks1', 'battlebacks2']);
const BACKDROP_NAME = /^(bg|back|battle|effect|fog|sky|cloud|title|window|menu|map)|background|背景/i;
const BACKDROP_SUB = /^(?:backgrounds?|backs?|bgs?|背景|haikei|parallax(?:es)?)$/i;
// Папка фонов и глубже: «pictures/Background/…» (Seria), «pictures/bg/…». Фон из такой папки — фон, а не по имени
const inBackdropDir = (rel) => BACKDROP_DIRS.has((rel.split('/')[1] || '').toLowerCase()) || rel.split('/').slice(2, -1).some((d) => BACKDROP_SUB.test(d));

// Папки плагинов с интерфейсом и эффектами: меню, HUD, погода, частицы, мини-игры. Не картинки игры
const UI_DIR = /(?:^|[_\-])(?:ui|hud|weather|fogs?|particles?|choices?|indicators?|transitions?|bosshp|actorhud|live2d|messageBtn|textBigImg)(?:[_\-]|$)|^(?:fogs|particles|choices|menus|weather|transitions|eventindicators|dslot|slotmachine|highlow|tpoker|tblackjack|dice|bosshp|actorhud|battlehud|actor_picture_cm)$/i;
const isUiDir = (rel) => {
    const dir = rel.split('/')[1] || '';
    return !/^(pictures|titles\d?|parallaxes|movies)$/i.test(dir) && UI_DIR.test(dir);
};

// Стандартные ресурсы RPG Maker (титулы и фоны карт из комплекта): их ставят в десятки игр без изменений. Узнаём по
// папке, имени и размеру — тому же, что у автора комплекта; у зашифрованных (.rpgmvp, .png_) 16 байт заголовка не считаем
const RTP = new Set(require('./galleryRtp.json'));

// Фоновая работа галереи (обложки заранее, распознавание) — в своём контексте: её ffmpeg встаёт в очередь после
// запросов того, кто листает галерею, и занимает не больше одного места. Иначе картинка, которую открыли, ждала
// за сотнями обложек, и при быстром листании следующая не успевала
const background = new AsyncLocalStorage();
const inBackground = (fn) => background.run(true, fn);

// Вектор картинки для поиска (512 чисел, длина 1) — по байту на число: сравнению по смыслу точности хватает, а на
// кадр уходит 0,7 КБ вместо 4 КБ. Числа единичного вектора малы (до ~0,4), поэтому масштаб 200, а не 127
const EMBED_SCALE = 200;
const EMBED_SIZE = 512;
// Сколько игр держит поиск в памяти (вектора одной игры — до нескольких МБ)
const SEARCH_GAMES = 40;
const packEmbed = (e) => Buffer.from(Int8Array.from(e, (x) => Math.max(-127, Math.min(127, Math.round(x * EMBED_SCALE))))).toString('base64');
const unpackEmbed = (b64) => new Int8Array(Buffer.from(b64, 'base64'));
const cosine = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d / (EMBED_SCALE * EMBED_SCALE); };
// Очередь на size мест: сначала запросы человека, фон — когда место свободно и фона сейчас нет
function lane(size) { return { size, jobs: 0, bgJobs: 0, front: [], back: [] }; }
// Ответ take — «фоновое ли место»: его же отдают в give
function take(l) {
    const bg = !!background.getStore();
    if (l.jobs < l.size && (!bg || (l.bgJobs < 1 && !l.front.length))) { l.jobs++; if (bg) l.bgJobs++; return Promise.resolve(bg); }
    return new Promise((resolve) => (bg ? l.back : l.front).push(resolve));
}
function give(l, bg) {
    l.jobs--;
    if (bg) l.bgJobs--;
    if (l.front.length) { l.jobs++; l.front.shift()(false); return; }
    if (l.back.length && l.bgJobs < 1) { l.jobs++; l.bgJobs++; l.back.shift()(true); }
}
// Человек ждёт то, что начал фон (тот же кадр склейки): фоновые заявки встают в общую очередь
function boost(l) {
    l.front.push(...l.back.splice(0));
}
const isRtp = (rel, size) => {
    const m = /^img\/(titles1|titles2|parallaxes)\/([^/]+)\.(png|rpgmvp|png_)$/i.exec(rel);
    return !!m && RTP.has(`${m[1].toLowerCase()}/${m[2].toLowerCase()}:${/^png$/i.test(m[3]) ? size : size - 16}`);
};

// Стоячий портрет по имени: «tachie», «tati1_…» (立ち絵 латиницей), «立ち絵»
const STANDING = /(?:^|[_\-/ ])(?:tachie?|tati(?:e)?)(?:[_\-/ ]|\d|$)|立ち?絵|立绘/i;

function classify({ w, h, size, webp, palette, animated, video, loop, opaque = 1, cols = 1 }, screen, rel = '') {
    if (!video && (isUiDir(rel) || isRtp(rel, size))) return 'engine';
    if (video) return loop ? 'animation' : 'video';
    // Движется, но мелкая (значок, курсор, спрайт эффекта, 192×192): не анимация сцены — «Прочее»
    if (animated) return w && h && w < 0.35 * screen.w && h < 0.35 * screen.h ? 'other' : 'animation';
    if (!w || !h) return 'other';
    const full = w >= 0.8 * screen.w && h >= 0.8 * screen.h;
    if (inBackdropDir(rel)) return full || h >= 0.8 * screen.h ? 'backdrop' : 'other';
    if (full) {
        if (size / (w * h) < (webp ? DENSE_WEBP : palette ? DENSE_PALETTE : DENSE) || (opaque < OPAQUE_LAYER && cols < NARROW)) return 'layer';
        // Выше, чем шире, — кукла в рост («at01», «mt914» 720×810, куклы по слоям), а не CG: CG — горизонтальные. И
        // стоячий портрет на холсте во весь экран — по имени
        if ((h > w * 1.05 && screen.w > screen.h) || STANDING.test(path.posix.basename(rel))) return 'portrait';
        // Фон по имени — только плотный: прозрачный («battle_…», «Menu_…» — героиня в рост, «Effect_…» — дымка) слой
        return BACKDROP_NAME.test(path.posix.basename(rel)) ? (opaque < OPAQUE_LAYER ? 'layer' : 'backdrop') : 'cg';
    }
    if (h >= 0.8 * screen.h) return 'portrait';
    return 'other';
}

// Покадровая анимация: файлы одного альбома различаются только последним номером, номера идут почти подряд, все
// одного размера. Страницы одной сцены («CG12_1…CG12_5») и варианты позы — не она: нужны номера с нулями до
// одной ширины («ci_deepkiss_0000…0007», «kyouko … _00000…») и не меньше шести кадров, либо двенадцать и больше.
// listed — игра сама назвала эти кадры одним списком (параметры плагина анимации, см. listedFrames): тогда это не страницы
// и не варианты, и хватает двух кадров подряд и коротких номеров («Boat-001…003», «…Lean_0…2»)
const SEQ_MIN = 6;
const SEQ_MANY = 12;
const TALK_W = 0.36;        // портрет разговора: ширина фигуры до такой доли экрана…
const TALK_H = 0.6;         // …высота от такой доли, и стоит на нижнем краю
const TALK_EVENTS = 10;     // основа кадра есть в стольких событиях и больше — это говорящий персонаж, а не сцена
const TALK_RATIO = 0.75;    // фигура уже трёх четвертей своей высоты: портреты — 0,72 и уже, тело сцены начинается около 0,78
const SHOT_IOU = 0.5;       // рамки основ перекрываются на столько (пересечение к объединению) — кадры одного плана
const LISTED_MAX = 64;      // имён в списке кадров плагина: больше — список предзагрузки, а не анимация
function isFrameSequence(files, sizeOf, listed = false) {
    if (files.length < (listed ? 2 : SEQ_MIN)) return false;
    const nums = [];
    const widths = new Set();
    let unpadded = false;
    let prefix = null;
    for (const f of files) {
        const m = /^(.*?)(\d+)(?:\.[a-z_0-9]+)$/i.exec(path.posix.basename(f));
        if (!m) return false;
        const pre = `${path.posix.dirname(f)}/${m[1]}`;
        if (prefix !== null && pre !== prefix) return false;
        prefix = pre;
        nums.push(Number(m[2]));
        widths.add(m[2].length);
        if (!/^0/.test(m[2]) && m[2].length < 3) unpadded = true;
    }
    if (!listed && files.length < SEQ_MANY && (unpadded || widths.size !== 1 || [...widths][0] < 3)) return false;
    nums.sort((a, b) => a - b);
    if (new Set(nums).size !== nums.length) return false;
    if (nums[nums.length - 1] - nums[0] + 1 > Math.ceil(nums.length * 1.25)) return false;
    const dims = new Set(files.map((f) => sizeOf(f)));
    return dims.size === 1;
}

// Прямоугольник слоя на экране (пикселы) по рамке box (доли картинки). Минус у масштаба — зеркало: рамка отражена.
// null — не знаем (масштаб 0 или не число)
function placedRect(l, e, box) {
    const zx = Number(l.zx ?? 100) / 100, zy = Number(l.zy ?? 100) / 100;
    if (!zx || !zy || !Number.isFinite(zx) || !Number.isFinite(zy)) return null;
    const ax = Math.abs(zx), ay = Math.abs(zy);
    const [bx0, bx1] = zx > 0 ? [box[0], box[2]] : [1 - box[2], 1 - box[0]];
    const [by0, by1] = zy > 0 ? [box[1], box[3]] : [1 - box[3], 1 - box[1]];
    let x = Number(l.x) || 0, y = Number(l.y) || 0;
    if (l.o === 1) { x -= e.w * ax / 2; y -= e.h * ay / 2; } else { if (zx < 0) x -= e.w * ax; if (zy < 0) y -= e.h * ay; }
    return [x + bx0 * e.w * ax, y + by0 * e.h * ay, x + bx1 * e.w * ax, y + by1 * e.h * ay];
}

// Фигуры кадра панели по слоям: каждый слой (рамка — своя, а у плотной картинки — вся) становится прямоугольником на экране,
// прямоугольники по высоте складываются в фигуры: деталь (лицо, рука, волосы) идёт к телу, чей центр по x её накрывает
// и чья ширина не меньше её. Двое в разговоре — две фигуры. null — чего-то не знаем (рамка не измерена, кадр листа, масштаб 0):
// тогда ничего не решаем. Плотный слой на весь экран поверх фигуру не прячет — он сам фигура во весь экран (не портрет)
function talkFigures(layers, entries, screen) {
    const solid = (e) => !e.alpha || e.opaque >= OPAQUE_BASE;
    const rects = [];
    for (const [i, l] of layers.entries()) {
        const e = entries.get(l.rel);
        if (!e || !e.w || !e.h || l.cell) return null;
        const box = e.box || (solid(e) ? [0, 0, 1, 1] : null);
        if (!box) return null;
        const r = placedRect(l, e, box);
        if (!r) return null;
        // Дымка или линии поверх тела: рамка почти во всю картинку и слой прозрачный — фигуры не задаёт
        if (i && !solid(e) && box[2] - box[0] >= 0.9 && box[3] - box[1] >= 0.9) continue;
        const v = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(screen.w, r[2]), Math.min(screen.h, r[3])];
        if (v[2] <= v[0] || v[3] <= v[1]) continue;
        rects.push({ v, rel: l.rel });
    }
    const figs = [];
    for (const { v, rel } of rects.sort((p, q) => (q.v[3] - q.v[1]) - (p.v[3] - p.v[1]))) {
        const cx = (v[0] + v[2]) / 2;
        const host = figs.filter((f) => f.box[0] <= cx && cx <= f.box[2] && v[2] - v[0] <= 1.05 * (f.box[2] - f.box[0])
            && v[1] <= f.box[3] + 0.1 * screen.h && v[3] >= f.box[1] - 0.1 * screen.h)
            .sort((p, q) => (p.box[2] - p.box[0]) - (q.box[2] - q.box[0]))[0];
        if (host) host.box = [Math.min(host.box[0], v[0]), Math.min(host.box[1], v[1]), Math.max(host.box[2], v[2]), Math.max(host.box[3], v[3])];
        else figs.push({ box: v.slice(), base: rel });
    }
    return figs;
}

// Фигура — портрет разговора по размеру: стоит на нижнем краю, целиком (запас сверху), от TALK_H экрана ростом и узкая
function talkFigure({ box: [x0, y0, x1, y1] }, screen) {
    return y1 >= 0.98 * screen.h && y0 >= 0.02 * screen.h && y1 - y0 >= TALK_H * screen.h && x1 - x0 <= TALK_RATIO * (y1 - y0);
}

// Обрезка по плану: кадры одного плана (основа того же размера на том же месте, рамки основ перекрываются) должны быть
// обрезаны одинаково, иначе в альбоме и в плеере кадр прыгает. Решение — одно на связный набор кадров по всем альбомам
// (кадр в двух альбомах не может иметь две обрезки). Обрезку никогда не добавляем; оставленная содержит прежнюю.
// frames — built.frames (хэш → слои; обрезка в layers[0].crop), albums — index.albums, scripts — ключ альбома → шаги
// сценария (k: 'pic', f), panelSet — хэши кадров панелей. Ответ — сколько обрезок убрано и увеличено
function cropShots({ frames, entries, albums, scripts, panelSet, screen }) {
    const area = (c) => c[2] * c[3];
    const box = (h) => { const b = frames[h]?.[0]; const e = b && !b.cell && entries.get(b.rel); return e && e.box ? { b, e } : null; };
    const slotOf = (h, { b, e }) => `${e.w}x${e.h}|${b.x}|${b.y}|${b.zx}|${b.zy}|${b.o}|${panelSet.has(h)}`;
    const iou = (p, q) => {
        const ix = Math.max(0, Math.min(p[2], q[2]) - Math.max(p[0], q[0])), iy = Math.max(0, Math.min(p[3], q[3]) - Math.max(p[1], q[1]));
        const x = ix * iy;
        return x / ((p[2] - p[0]) * (p[3] - p[1]) + (q[2] - q[0]) * (q[3] - q[1]) - x);
    };
    // Планы среди хэшей: по месту, внутри места — связность по перекрытию рамок. Ответ — списки по два кадра и больше
    const shotsOf = (hashes) => {
        const bySlot = new Map();
        for (const h of hashes) {
            const x = box(h);
            if (!x) continue;
            const k = slotOf(h, x);
            if (!bySlot.has(k)) bySlot.set(k, []);
            bySlot.get(k).push({ h, box: x.e.box });
        }
        const out = [];
        for (const list of bySlot.values()) {
            if (list.length < 2) continue;
            const parent = list.map((_, i) => i);
            const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
            for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (iou(list[i].box, list[j].box) >= SHOT_IOU) parent[find(i)] = find(j);
            const groups = new Map();
            list.forEach((x, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(x.h); });
            for (const g of groups.values()) if (g.length >= 2) out.push(g);
        }
        return out;
    };
    // Связные наборы из планов (союз-поиск по хэшам)
    const components = (shots) => {
        const parent = new Map();
        const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
        for (const g of shots) for (const h of g) if (!parent.has(h)) parent.set(h, h);
        for (const g of shots) for (const h of g.slice(1)) parent.set(find(h), find(g[0]));
        const comps = new Map();
        for (const h of parent.keys()) { const r = find(h); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(h); }
        return [...comps.values()];
    };
    // Решение набора: у большинства есть обрезка — общая (объединение) или, если объединение слишком велико, ни у кого.
    // Меньшинство без обрезки остаётся без неё: оно шире окна. Обрезка не у большинства — ни у кого
    const stat = { removed: 0, enlarged: 0 };
    const decide = (comp) => {
        const ok = comp.filter((h) => frames[h][0].crop);
        let u = null;
        if (ok.length * 2 > comp.length) {
            const cs = ok.map((h) => frames[h][0].crop);
            const x0 = Math.min(...cs.map((c) => c[0])), y0 = Math.min(...cs.map((c) => c[1]));
            const x1 = Math.max(...cs.map((c) => c[0] + c[2])), y1 = Math.max(...cs.map((c) => c[1] + c[3]));
            u = [x0, y0, x1 - x0, y1 - y0];
            if (area(u) > (comp.every((h) => panelSet.has(h)) ? 0.95 : CROP_MAX) * screen.w * screen.h) u = null;
        }
        for (const h of ok) {
            const was = frames[h][0].crop;
            if (!u) { delete frames[h][0].crop; stat.removed++; } else if (JSON.stringify(was) !== JSON.stringify(u)) { frames[h][0].crop = u; stat.enlarged++; }
        }
    };
    const inAlbum = new Set();
    const albumShots = [];
    for (const a of albums) {
        const hs = [...new Set(a.files.filter((f) => f.startsWith(CG_PREFIX)).map((f) => f.slice(CG_PREFIX.length)))].filter((h) => frames[h]);
        for (const h of hs) inAlbum.add(h);
        if (hs.length >= 2) albumShots.push(...shotsOf(hs));
    }
    for (const comp of components(albumShots)) decide(comp);
    // Кадры, что есть только в сценариях: идут за кадрами альбомов своего плана (одно окно в сценарии и в альбоме), а
    // планы без кадров альбома решаются большинством, как альбомные. Кадры альбомов здесь не меняются
    const contains = (c, o) => c[0] <= o[0] && c[1] <= o[1] && c[0] + c[2] >= o[0] + o[2] && c[1] + c[3] >= o[1] + o[3];
    const done = new Set();
    const alone = [];
    for (const steps of scripts.values()) {
        const hs = [...new Set(steps.filter((x) => x.k === 'pic' && typeof x.f === 'string' && x.f.startsWith(CG_PREFIX)).map((x) => x.f.slice(CG_PREFIX.length)))].filter((h) => frames[h]);
        for (const shot of shotsOf(hs)) {
            const mine = shot.filter((h) => !inAlbum.has(h));
            if (!mine.length) continue;
            const album = shot.filter((h) => inAlbum.has(h));
            if (!album.length) { alone.push(shot.filter((h) => !inAlbum.has(h))); continue; }
            const crops = new Set(album.map((h) => JSON.stringify(frames[h][0].crop || null)));
            // Кадры альбомов решили по-разному — сценарий не вмешивается
            if (crops.size !== 1) continue;
            const c = frames[album[0]][0].crop || null;
            for (const h of mine) {
                if (done.has(h)) continue;
                done.add(h);
                const own = frames[h][0].crop;
                if (!own) continue;
                if (c && contains(c, own)) { if (JSON.stringify(c) !== JSON.stringify(own)) { frames[h][0].crop = c; stat.enlarged++; } } else { delete frames[h][0].crop; stat.removed++; }
            }
        }
    }
    for (const comp of components(alone.map((g) => g.filter((h) => !done.has(h))).filter((g) => g.length >= 2))) decide(comp);
    return stat;
}

// Имя альбома — имя картинки до первой части с цифрой: «eva_c132_0_1_0211013_…» → «eva_c132» (все
// варианты CG №132), «ecg_onna7_3» → «ecg_onna7», «074 (3)» → «074», «SceneB_05cleanup-11» →
// «SceneB_05cleanup». Порядковый номер в начале («1_受付嬢_普») пропускаем, если дальше есть буквы
function albumKey(rel) {
    const dir = path.posix.dirname(rel);
    const name = bareName(path.posix.basename(rel));
    // Имя — просто номер («1», «02»): сцена — это папка («CG/Cam x Alice Bath/1.png»). «074 (3)» —
    // другое: вариант 3 сцены 074
    if (/^\d+$/.test(name) && dir !== '.' && !/^img\/pictures$/i.test(dir)) return dir;
    // Два номера в начале — сцена и страница: «2_10_SidePos_…», «2_1側位_…» — всё сцена 2
    const two = /^(\d+)[_\-\s.]+\d+(?=\D|$)/.exec(name);
    if (two && /\p{L}/u.test(name)) return `${dir}/${two[1]}`;
    const tokens = name.match(/[^_\-\s.()@]+|[_\-\s.()@]+/g) || [name];
    let key = '';
    for (let i = 0; i < tokens.length; i++) {
        let t = tokens[i];
        if (/^[_\-\s.()@]+$/.test(t)) { if (key) key += t; continue; }
        if (!key && /^\d+$/.test(t) && /\p{L}/u.test(tokens.slice(i + 1).join(''))) continue;
        // Номер, слитый с именем не латиницей («1引导», «2引导»), — тоже порядковый
        if (!key && /^\d+[^\x00-\x7f]/.test(t) && !/\d/.test(t.replace(/^\d+/, ''))) t = t.replace(/^\d+/, '');
        if (/\d/.test(t)) {
            // Последняя часть имени — номер кадра или варианта («CG_badend_14», «ct_02b», «t_prince8»):
            // без него — одна сцена, один персонаж
            const rest = tokens.slice(i + 1).filter((x) => !/^[_\-\s.()@]+$/.test(x));
            if (!rest.length) { key += t.replace(/\(?\d+\)?[a-z]?$/i, ''); break; }
            // Номер и одна буква через пробел («Daisy Boob job 8 D», «… 8 S») — то же, что «8D»: кадр и вариант, не сцена
            if (rest.length === 1 && /^[a-z]$/i.test(rest[0]) && /^\d+$/.test(t) && /\p{L}/u.test(key)) break;
            key += t;
            // Дальше ровно два номера через «_» или «-» — сцена и страница («e01_001_004» — набор e01, сцена 001): альбом
            // сцены. «x01 (1) (2)» — другое
            const tail = tokens.slice(i + 1).join('');
            if (rest.length === 2 && /^[_-]\d+[_-]\d+$/.test(tail)) key += tokens[i + 1] + rest[0];
            break;
        }
        key += t;
    }
    return `${dir}/${key.replace(/[_\-\s.(@]+$/, '') || name}`;
}

// PictureAnimation: включено ли в плагине «вернуться к первому кадру» (ReturnToFirstCell, 最初のセルに戻る) — от него зависит,
// на каком кадре встаёт анимация без цикла. Файл plugins.js читаем как текст: ключи в нём то с кавычками, то без. Плагина
// нет или выключен, параметра нет — «нет», как у самого плагина
async function paFirstCell(root) {
    let src;
    try { src = await readGameText(root, path.join(root, 'js', 'plugins.js')); } catch { return false; }
    for (const part of src.split(/\{\s*["']?name["']?\s*:/).slice(1)) {
        const name = /^\s*["']([^"']*)["']/.exec(part)?.[1] || '';
        if (name !== 'PictureAnimation' && !name.endsWith('/PictureAnimation')) continue;
        if (!/["']?status["']?\s*:\s*true\b/.test(part)) continue;
        const m = /["']?(?:ReturnToFirstCell|returnToFirstCell|最初のセルに戻る)["']?\s*:\s*["']\s*([^"']*)["']/.exec(part);
        return !!m && /^(?:true|on)$/i.test(m[1].trim());
    }
    return false;
}

// Наборы Spine: «X.atlas» с «X.json» рядом (скелет в JSON; бинарный .skel плеер галереи не читает). Версии, которые знает
// проигрыватель: 3.7, 3.8, 4.0, 4.1. Ищем по всей папке игры: у игр наборы лежат где угодно (img/pSpineAssets, img/spines, spine/)
const SPINE_VERSION = /^(?:3\.[78]|4\.[01])(?:\.|$)/;
const SPINE_SKIP = new Set(['audio', 'movies', 'node_modules', 'fonts', 'locales', 'save', 'saves', 'data', 'js', 'css']);
async function findSpines(root) {
    const found = [];
    const walk = async (rel, depth) => {
        const list = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
        const names = new Set(list.filter((e) => e.isFile()).map((e) => e.name));
        for (const name of names) {
            const m = /^(.+)\.atlas$/i.exec(name);
            const json = m && [`${m[1]}.json`, `${m[1]}.JSON`].find((n) => names.has(n));
            if (!json) continue;
            try {
                const atlasRel = `${rel}/${name}`, skeletonRel = `${rel}/${json}`;
                const [atlas, skeleton] = await Promise.all([fsp.readFile(path.join(root, atlasRel), 'utf8'), fsp.readFile(path.join(root, skeletonRel), 'utf8')]);
                const data = JSON.parse(skeleton.replace(/^\uFEFF/, ''));
                const version = String(data?.skeleton?.spine || '');
                const animations = Object.keys(data?.animations || {});
                if (!SPINE_VERSION.test(version) || !animations.length) continue;
                // Скелет-кукла (портрет «tachie»: лицо и руки включаются скинами по ходу игры) в скине по умолчанию почти пуст —
                // сам по себе он не покажет ничего: как набор для просмотра не годится
                const skins = Array.isArray(data.skins) ? data.skins : Object.entries(data.skins || {}).map(([name, attachments]) => ({ name, attachments }));
                const shown = skins.find((k) => k.name === 'default')?.attachments || {};
                const named = (data.slots || []).filter((x) => x.attachment);
                if (!named.length || named.filter((x) => shown[x.name]?.[x.attachment]).length * 2 < named.length) continue;
                // Страницы атласа: строка без двоеточия после пустой строки (или в начале) — имя файла страницы
                const lines = atlas.split(/\r?\n/);
                const pages = lines.filter((l, i) => l.trim() && !l.includes(':') && !/^\s/.test(l) && (i === 0 || !lines[i - 1].trim()) && /\.(png|jpe?g|webp)$/i.test(l.trim())).map((l) => `${rel}/${l.trim()}`);
                if (!pages.length || pages.some((r) => r.includes('..'))) continue;
                for (const r of pages) await fsp.access(path.join(root, r));
                found.push({ rel, stem: m[1], atlas: atlasRel, skeleton: skeletonRel, version, pages, animations });
            } catch { /* не набор Spine или битый — остаётся как было */ }
        }
        if (depth >= 8) return;
        for (const e of list) if (e.isDirectory() && !SPINE_SKIP.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(`${rel}/${e.name}`, depth + 1);
    };
    await walk('.', 0);
    return found.map((x) => ({ ...x, atlas: x.atlas.slice(2), skeleton: x.skeleton.slice(2), pages: x.pages.map((r) => r.slice(2)), rel: x.rel.slice(2) }));
}

// Модели Live2D (Cubism 3 и новее, .moc3). Берём только те, что перечислены в плагине игры: в папках бывают заготовки и
// остатки, которые игра не показывает. Плагины двух видов: PictureLive2D («json file»: «папка/имя» без .model3.json,
// лежит в img/live2d) и Live2DInterfaceMZ («Modelname» и «folderpath»: файл — «папка/последняя часть папки.model3.json»).
// plugins.js читаем как текст: ключи в нём то с кавычками, то без, а списки вложены строкой в строку (слоёв экранирования
// бывает до трёх) — поэтому обратные косые убираем и ищем слова
const L2D_MAX = [1024, 2048, 4096, 8192]; // на какую сторону клиент просит ужать текстуру: чужие числа не берём — копии любой ширины заполнили бы диск
const L2D_TYPE = { json: 'application/json', moc3: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', js: 'text/javascript; charset=utf-8' };
// Версия формата moc3: байт сразу после «MOC3» (1 — Cubism 3.0, 2 — 3.3, 3 — 4.0, 4 — 4.2, 5 — 5.0). Ядро старше модели её
// не читает — клиенту нужен номер, чтобы взять ядро игры подходящее
function mocVersion(buf) {
    return buf && buf.length >= 5 && buf.subarray(0, 4).toString('latin1') === 'MOC3' ? buf[4] : 0;
}
// Какие модели называет плагин: { tails — «папка/имя» (хвост пути, PictureLive2D), exact — полный путь → имя модели (Interface),
// tags — у Interface путь → метки движений «m-01» → «Idle_1, Idle_2» (motiongroupnames), def — положение и масштаб по умолчанию
// и места left/middle/right (параметры плагина) }
async function live2dListed(root) {
    const out = { tails: new Set(), exact: new Map(), tags: new Map(), def: {} };
    let src;
    try { src = await readGameText(root, path.join(root, 'js', 'plugins.js')); } catch { return out; }
    for (const part of src.split(/\{\s*["']?name["']?\s*:/).slice(1)) {
        const name = /^\s*["']([^"']*)["']/.exec(part)?.[1] || '';
        if (!/live2d/i.test(name) || !/["']?status["']?\s*:\s*true\b/.test(part)) continue;
        const flat = part.replace(/\\/g, '');
        const list = /["']?json file["']?\s*:\s*["']?\[([^\]]*)\]/.exec(flat)?.[1];
        for (const m of (list || '').matchAll(/["']([^"']+)["']/g)) out.tails.add(m[1].trim().replace(/^\.?\//, '').toLowerCase());
        for (const chunk of flat.split(/Modelname/).slice(1)) {
            const label = /^["']?\s*:\s*["']([^"']*)["']/.exec(chunk)?.[1] || '';
            const dir = /folderpath["']?\s*:\s*["']([^"']+)["']/.exec(chunk)?.[1];
            if (!dir) continue;
            const clean = dir.trim().replace(/^\.?\//, '').replace(/\/+$/, '');
            if (!clean) continue;
            const key = `${clean}/${clean.split('/').pop()}`.toLowerCase();
            out.exact.set(key, label.trim());
            // Метки движений: «<m-01:Idle_1>» (после снятия косых «\n» между ними стало «n» — на разбор не влияет)
            const tags = {};
            for (const t of chunk.matchAll(/<([^<>:]+):([^<>]*)>/g)) tags[t[1].trim()] = t[2].trim();
            out.tags.set(key, tags);
        }
        // Положение и масштаб по умолчанию, места left/middle/right: числа среди параметров плагина (в списке моделей таких ключей нет)
        const num = (k) => { const v = new RegExp(`\\b${k}["']?\\s*:\\s*["']?(-?\\d+(?:\\.\\d+)?)`).exec(flat); return v ? Number(v[1]) : undefined; };
        if (flat.includes('Modelname')) out.def = { x: num('middle'), y: num('vertical'), k: num('DefaultScale'), left: num('left'), middle: num('middle'), right: num('right') };
    }
    return out;
}
// Ядро игры: самое новое по MocVersion_NN в файле (найденное не по имени: у игр их несколько, старое лежит рядом и не
// грузится). Равные — больший файл. moc — в номерах mocVersion(): 30→1, 33→2, 40→3, 42→4, 50→5, дальше (60…) по порядку
const MOC_OF = { 30: 1, 33: 2, 40: 3, 42: 4, 50: 5 };
async function live2dCore(root) {
    const cores = [];
    const walk = async (rel, depth) => {
        for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
            const r = `${rel}/${e.name}`;
            if (e.isDirectory() && depth < 3) await walk(r, depth + 1);
            else if (e.isFile() && /^live2dcubismcore.*\.js$/i.test(e.name)) {
                try {
                    const text = await fsp.readFile(path.join(root, r), 'latin1');
                    const nums = [...text.matchAll(/MocVersion_(\d+)/g)].map((m) => +m[1]);
                    cores.push({ rel: r, moc: Math.max(0, ...nums.map((n) => MOC_OF[n] || (n > 50 ? 5 + Math.round((n - 50) / 10) : 0))), size: text.length });
                } catch { /* нечитаемое ядро пропускаем */ }
            }
        }
    };
    await walk('js', 0);
    cores.sort((a, b) => b.moc - a.moc || b.size - a.size || (a.rel < b.rel ? -1 : 1));
    return cores[0] ? { rel: cores[0].rel, moc: cores[0].moc } : null;
}
async function findLive2D(root) {
    const listed = await live2dListed(root);
    if (!listed.tails.size && !listed.exact.size) return [];
    const core = await live2dCore(root);
    if (!core) return [];
    const found = [];
    const walk = async (rel, depth) => {
        const list = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
        for (const e of list) {
            const m = e.isFile() && /^(.+)\.model3\.json$/i.exec(e.name);
            if (!m) continue;
            const base = `${rel}/${m[1]}`.replace(/^\.\//, '');
            const low = base.toLowerCase();
            const label = listed.exact.get(low);
            if (label === undefined && ![...listed.tails].some((t) => low === t || low.endsWith(`/${t}`))) continue;
            try {
                const dir = rel.replace(/^\.\/?/, '');
                const data = JSON.parse((await fsp.readFile(path.join(root, rel, e.name), 'utf8')).replace(/^﻿/, ''));
                const refs = data?.FileReferences || {};
                // Путь из model3.json — от папки модели; наружу игры и абсолютные не берём
                const at = (ref) => {
                    if (typeof ref !== 'string' || !ref) return null;
                    const p = path.posix.normalize(`${dir}/${ref.replace(/\\/g, '/')}`.replace(/^\//, ''));
                    return p.startsWith('..') || path.posix.isAbsolute(p) ? null : p;
                };
                const must = [refs.Moc, ...(Array.isArray(refs.Textures) ? refs.Textures : [])];
                const maybe = [refs.Physics, refs.Pose, refs.DisplayInfo];
                const paths = [...must, ...maybe.filter(Boolean)].map(at);
                if (!refs.Moc || !must.slice(1).length || paths.some((p) => !p)) continue;
                for (const p of paths) await fsp.access(path.join(root, p));
                const mocPath = at(refs.Moc);
                const fh = await fsp.open(path.join(root, mocPath), 'r');
                const head = Buffer.alloc(8);
                try { await fh.read(head, 0, 8, 0); } finally { await fh.close(); }
                const moc = mocVersion(head);
                if (!moc) continue;
                // Движения: подпись — имя файла; два движения с одним именем (в разных группах) различаем группой, потом номером
                const motions = [];
                const seen = new Set();
                for (const [group, arr] of Object.entries(refs.Motions || {})) {
                    for (const [i, mo] of (Array.isArray(arr) ? arr : []).entries()) {
                        const p = at(mo?.File);
                        if (!p || !(await fsp.access(path.join(root, p)).then(() => true, () => false))) continue;
                        let name = path.posix.basename(p).replace(/\.motion3\.json$/i, '').replace(/#/g, '');
                        if (seen.has(name)) name = `${group || '-'}/${name}`;
                        for (let k = 2; seen.has(name); k++) name = `${name}~${k}`;
                        seen.add(name);
                        motions.push({ name, group, i, file: p, base: path.posix.basename(p).replace(/\.motion3\.json$/i, ''), ...(typeof mo.Name === 'string' && mo.Name ? { mname: mo.Name } : {}) });
                    }
                }
                const exps = [];
                for (const [i, ex] of (Array.isArray(refs.Expressions) ? refs.Expressions : []).entries()) {
                    const p = at(ex?.File);
                    if (p && await fsp.access(path.join(root, p)).then(() => true, () => false)) exps.push({ name: String(ex.Name || path.posix.basename(p).replace(/\.exp3\.json$/i, '')), i, file: p });
                }
                // Модель без движений — неподвижная поза (портрет с выражениями): один кадр без движения (i: -1)
                if (!motions.length && !exps.length) continue;
                if (!motions.length) motions.push({ name: m[1].replace(/#/g, ''), group: '', i: -1, file: null });
                found.push({
                    rel: dir, stem: m[1], model: `${dir}/${e.name}`.replace(/^\//, ''), moc, name: label || '', via: label === undefined ? 'pic' : 'if',
                    ...(label !== undefined ? { tags: listed.tags.get(low) || {}, def: listed.def } : {}), textures: must.slice(1).map(at), motions, exps,
                    files: [...new Set([`${dir}/${e.name}`.replace(/^\//, ''), ...paths, ...motions.map((x) => x.file).filter(Boolean), ...exps.map((x) => x.file)])],
                });
            } catch { /* не модель или битая — остаётся как было */ }
        }
        if (depth >= 8) return;
        for (const e of list) if (e.isDirectory() && !SPINE_SKIP.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(`${rel}/${e.name}`, depth + 1);
    };
    await walk('.', 0);
    return found.map((x) => ({ ...x, core: core.rel, coreMoc: core.moc, files: [...x.files, core.rel] }));
}

// Движется ли картинка: GIF — всегда (неподвижных GIF в играх почти не бывает); WebP — флаг анимации в
// VP8X; PNG — блок acTL (APNG) до первых данных картинки. У зашифрованного PNG свой заголовок в 16 байт,
// а блоки после первых 16 байт PNG не шифруются — их видно и так
function isAnimated(head) {
    let b = head;
    if (b.subarray(0, 4).toString('latin1') === 'GIF8') return true;
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 16).toString('latin1') === 'WEBPVP8X') return (b[20] & 0x02) !== 0;
    if (b.subarray(0, 4).toString('latin1') === 'RPGM') b = b.subarray(16);
    else if (b.subarray(12, 16).toString('latin1') !== 'IHDR') return false;
    // IHDR всегда первый и всегда 13 байт — следующий блок с 33-го байта. Так и у зашифрованного, где
    // сама подпись IHDR зашифрована
    for (let at = 33; at + 8 <= b.length;) {
        const type = b.subarray(at + 4, at + 8).toString('latin1');
        if (type === 'acTL') return true;
        if (type === 'IDAT' || type === 'IEND') return false;
        at += 12 + b.readUInt32BE(at);
    }
    return false;
}

// PNG: ширина и высота — байты 16–23. У зашифрованного перед ним свой заголовок в 16 байт. GIF — свои
// 16-битные числа сразу за подписью
function pngSize(head) {
    let b = head;
    if (b.subarray(0, 4).toString('latin1') === 'GIF8' && b.length >= 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    // Репаки «Compressed» пережимают картинки в WebP, а имя оставляют .png — размеры WebP в его
    // заголовке: VP8X (с прозрачностью) — 24-битные числа, VP8 (с потерями) и VP8L (без потерь) — свои
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' && b.length >= 30) {
        const kind = b.subarray(12, 16).toString('latin1');
        if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), webp: true, ...(b[20] & 0x10 ? { alpha: true } : {}) };
        if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, webp: true };
        if (kind === 'VP8L') {
            const bits = b.readUInt32LE(21);
            return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff), webp: true, ...((bits >>> 28) & 1 ? { alpha: true } : {}) };
        }
        return null;
    }
    if (b.subarray(0, 4).toString('latin1') === 'RPGM') b = b.subarray(16);
    else if (b.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    if (b.length < 24) return null;
    // Тип цвета (байт 25) не зашифрован: 4 и 6 — с прозрачностью, 3 — палитра (прозрачная, если до данных есть блок tRNS:
    // так хранят портреты в рост на пустом холсте)
    let alpha = b[25] === 4 || b[25] === 6;
    if (b[25] === 3) {
        for (let at = 33; at + 8 <= b.length;) {
            const type = b.subarray(at + 4, at + 8).toString('latin1');
            if (type === 'tRNS') { alpha = true; break; }
            if (type === 'IDAT' || type === 'IEND') break;
            at += 12 + b.readUInt32BE(at);
        }
    }
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), ...(alpha ? { alpha: true } : {}), ...(b[25] === 3 ? { palette: true } : {}) };
}

// Длина ролика и есть ли в нём звук — ffprobe. Не разобрался или молчит дольше 10 секунд — считаем
// обычным роликом (с плеером, без повтора)
function probeVideo(file) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
        let out = '';
        const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS);
        proc.stdout.on('data', (d) => { out += d; });
        proc.on('error', () => { clearTimeout(timer); resolve(null); });
        proc.on('close', () => {
            clearTimeout(timer);
            try {
                const info = JSON.parse(out);
                resolve({ duration: Number(info.format?.duration) || 0, audio: (info.streams || []).some((s) => s.codec_type === 'audio') });
            } catch {
                resolve(null);
            }
        });
    });
}

// Петля ли ролик (см. LOOP_MAX_SECONDS)
const isLoop = (info) => !!info && info.duration > 0 && info.duration <= LOOP_MAX_SECONDS && !info.audio;

async function readHead(file) {
    const fh = await fsp.open(file, 'r');
    try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

// Расшифровать картинку RPG Maker (MV .rpgmvp, MZ .png_): 16 байт своего заголовка, потом первые
// 16 байт PNG, сложенные по XOR с ключом (utils/gameData.js mediaKey). Незашифрованная — как есть
function decrypt(data, keyHex) {
    if (data.subarray(0, 4).toString('latin1') !== 'RPGM') return data;
    const out = Buffer.from(data.subarray(16));
    const key = (keyHex || '').match(/../g)?.map((x) => parseInt(x, 16)) || [];
    if (key.length) for (let i = 0; i < 16 && i < out.length; i++) out[i] ^= key[i % key.length];
    return out;
}

// Звуки игры: .ogg_/.m4a_ у MZ, .rpgmvo/.rpgmvm у MV (шифруются как картинки), обычные .ogg/.m4a и то, что браузер играет сам
const SOUND = /\.(ogg_?|m4a_?|rpgmvo|rpgmvm|mp3|wav|flac)$/i;
const SOUND_TYPE = { ogg: 'audio/ogg', rpgmvo: 'audio/ogg', m4a: 'audio/mp4', rpgmvm: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac' };
// Порядок разделов в списке: музыка и голоса первыми, эффекты последними
const SOUND_SECTIONS = ['music', 'voice', 'ambience', 'effects'];
// Озвучка: папка или файл со словом voice/vo/vc, «ボイス», «音声» или moan (у Ironhold Keep — audio/voice, audio/moan)
const VOICE_NAME = /(^|[/_\-\s.])(voice|vo|vc|moan)([/_\-\s.\d]|$)|ボイス|音声/i;
function soundSection(rel) {
    const top = rel.split('/')[1]?.toLowerCase();
    if (VOICE_NAME.test(rel.replace(/^audio\//i, ''))) return 'voice';
    if (top === 'bgm' || top === 'me') return 'music';
    if (top === 'bgs') return 'ambience';
    return 'effects';
}

// Имя без номеров: у кадров одной анимации оно общее
const frameStem = (rel) => rel.replace(IMAGE, '').toLowerCase().replace(/\d+/g, '#');

// count задач разом: list по порядку, fn(элемент)
async function pool(list, count, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(count, list.length) }, async () => {
        while (next < list.length) await fn(list[next++]);
    }));
}

// Плагины, с которыми общие события «параллельно» идут и в бою: NRP_BattleParallelCommon (список или все; invalidOnMap —
// тогда только в бою), BattleParallelEvent (все). Нет их — в бою общие события «параллельно» не идут (так в MV/MZ)
async function battleParallel(root) {
    let list;
    try { const txt = await fsp.readFile(path.join(root, 'js', 'plugins.js'), 'utf8'); list = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1)); } catch { return null; }
    const out = { all: false, ids: new Set(), mapOff: new Set() };
    let any = false;
    for (const p of Array.isArray(list) ? list : []) {
        if (!p || p.status !== true) continue;
        if (p.name === 'BattleParallelEvent') { out.all = true; any = true; }
        if (p.name !== 'NRP_BattleParallelCommon') continue;
        any = true;
        const pr = p.parameters || {};
        let ids = [];
        try { ids = JSON.parse(pr.commonEventsWhiteList || '[]').map(Number).filter(Number.isFinite); } catch { /* список не читается — без него */ }
        if (pr.validAllCommon === 'true') out.all = true;
        for (const id of ids) { out.ids.add(id); if (pr.invalidOnMap === 'true') out.mapOff.add(id); }
    }
    return any ? out : null;
}

class GalleryService {
    constructor() {
        this.gamesDir = '';
        this.mediaDir = '';
        this.building = new Map();     // игра → { done, total, promise }
        this.memo = new Map();         // игра → { index, files: Set } — прочитанное оглавление
        this.soundMemo = new Map();    // игра → { list, files: Set } — звуки (sounds())
        this.langMemo = new Map();     // игра → { dir, table } — языки сцен (sceneLangs()), не больше LANG_MEMO игр
        this.langPending = new Map();  // `${игра}|${папка сценариев}` → сборка таблицы, которая идёт
        this.langWait = LANG_WAIT;     // сколько сцена ждёт таблицу языков, мс
        this.thumbLane = lane(3);
        this.viewWaitMax = VIEW_WAIT_MAX;    // оригинал крупнее — человек не ждёт копию
        this.viewDirMax = VIEW_DIR_MAX;     // потолок view/ одной игры
        this.viewMinFree = VIEW_MIN_FREE;   // свободного места, ниже которого копий для просмотра не пишем
        this.sceneLane = lane(Math.max(2, Math.min(4, os.cpus().length)));
        this.vision = vision;
        this.forgotten = new Map();     // игра → сколько раз оглавление сбрасывали (фоновый проход по старой — не в счёт)
    }

    setDependencies({ gamesDir, mediaDir }) {
        this.gamesDir = gamesDir;
        this.mediaDir = mediaDir || path.join(gamesDir, '_media');
        this.vision.setDependencies?.({ mediaDir: this.mediaDir });
    }

    visionPath(id) { return path.join(this.mediaDir, id, 'gallery-vision.json'); }
    cloudPath(id) { return path.join(this.mediaDir, id, 'gallery-cloud.json'); }

    // Ответы распознавания по кадрам; от других подписей или модели — не в счёт
    async visionRead(id) {
        return (await this.visionLoad(id)).scores;
    }

    // Файл ответов целиком: scores — ответы по кадрам, embeds — векторы тех же кадров для поиска по картинкам (ключи те
    // же, значение — packEmbed)
    // broken: файл есть, но не читается (недописан) — поиск такой ответ не запоминает, а читает заново
    async visionLoad(id) {
        let text;
        try { text = await fsp.readFile(this.visionPath(id), 'utf8'); } catch { return { scores: {}, embeds: {} }; }
        try {
            const c = JSON.parse(text);
            return c && c.version === this.vision.version && c.scores ? { scores: c.scores, embeds: c.embeds || {} } : { scores: {}, embeds: {} };
        } catch { return { scores: {}, embeds: {}, broken: true }; }
    }

    // Ключ ответа распознавания: файл — по пути и размеру; склейка — по её слоям
    visionKey(rel, size, layers) {
        // Без обрезки врезки: сборка ставит её позже, чем сверяет ответы
        const plain = layers && layers.map(({ crop, ...l }) => l);
        return layers ? `${rel}\n${crypto.createHash('sha1').update(JSON.stringify(plain)).digest('hex').slice(0, 16)}` : `${rel}\n${size}`;
    }

    // Кадры альбома, по которым судим, сцена ли он: обложка, середина, последний
    visionSamples(a) {
        const f = a.files;
        return [...new Set([a.cover || f[0], f[Math.floor(f.length / 2)], f[f.length - 1]])].filter(Boolean).slice(0, VISION_SAMPLES);
    }

    // Фоном, по одной картинке: распознать кадры альбомов CG, у которых ответа ещё нет, и пересобрать оглавление
    // (остальное у пересборки — из кэшей, секунды). На игру — один проход за раз; новых ответов нет — без пересборки,
    // так что кадр, который не распознать (миниатюра не вышла), не гоняет сборку по кругу
    visionPass(id) {
        this.visionRuns = this.visionRuns || new Map();
        if (this.visionRuns.has(id)) return this.visionRuns.get(id);
        if (!this.vision.available) return Promise.resolve();
        const gen = this.forgotten.get(id) || 0;
        const run = inBackground(async () => {
            const index = await this.cached(id);
            if (!index) return;
            const all = await this.scenesOf(id);
            const { scores: known, embeds } = await this.visionLoad(id);
            const root = await this.contentRoot(id);
            let added = 0;
            // Дописанные векторы к уже известным ответам: файл сохраняем, а оглавление из-за них не пересобираем
            let filled = 0;
            // Сначала обложка; остальные кадры — только если обложка похожа на экран игры (сцену видно сразу, и так у
            // большинства альбомов — работы втрое меньше)
            // Ответ по кадру; VISION_FAILED — кадр не прочитать (миниатюра или ffmpeg не вышли): альбом с ним остаётся в CG,
            // и следующие сборки его не ждут. undefined — распознавать нечем (нет модели)
            const judge = async (rel) => {
                const layers = rel.startsWith(CG_PREFIX) ? all[rel.slice(CG_PREFIX.length)] : null;
                const size = layers ? 0 : await fsp.stat(path.join(root, realFile(rel))).then((st) => st.size, () => 0);
                const key = this.visionKey(rel, size, layers);
                // Готово — если есть и ответ, и вектор (у нечитаемого кадра вектора быть не может). Ответ без вектора (его
                // записали до поиска по картинкам) считаем заново ради вектора, а прежний ответ не трогаем
                if (known[key] !== undefined && (embeds[key] || known[key] === VISION_FAILED)) return known[key];
                const had = known[key];
                let score = VISION_FAILED;
                const thumb = await this.thumb(id, rel).catch(() => null);
                if (thumb) {
                    const seen = {};
                    try { score = await this.vision.score(thumb, seen); } catch { score = VISION_FAILED; }
                    if (seen.embed) { embeds[key] = packEmbed(seen.embed); if (had !== undefined) filled++; }
                    if (score === null || score === undefined) return had === undefined ? undefined : had;
                }
                if (had !== undefined) return had;
                known[key] = score < 0 ? VISION_FAILED : Math.round(score * 1000) / 1000;
                added++;
                return known[key];
            };
            // Альбомы CG — до первого кадра, похожего на сцену (нечитаемый кадр — тоже конец: альбом остаётся в CG); пробы
            // сцен-панелей — после них, до первого уверенного кадра, нечитаемые пропускаем (сборка ждёт ответа по всем)
            const lists = [...index.albums.filter((a) => a.kind === 'cg' && !a.anim && !a.panel).map((a) => ({ files: this.visionSamples(a), enough: VISION_SCENE })),
                ...(index.visionProbe || []).map((files) => ({ files, enough: VISION_PROMOTE, probe: true }))];
            let stop = false;
            for (const { files, enough, probe } of lists) {
                for (const rel of files) {
                    const x = await judge(rel);
                    // Распознать нечем (нет модели) — дальше не пробуем, но уже распознанное сохраняем
                    if (x === undefined) { stop = true; break; }
                    if (x >= enough || (x === VISION_FAILED && !probe)) break;
                }
                if (stop) break;
            }
            // Игру обновили, пока шёл проход, — ответы устарели
            if (!(added || filled) || (this.forgotten.get(id) || 0) !== gen) return;
            // Через временный файл: поиск по картинкам читает этот файл в любой момент и не должен видеть половину
            const out = this.visionPath(id);
            try {
                await fsp.writeFile(`${out}.tmp`, JSON.stringify({ version: this.vision.version, scores: known, embeds }));
                await fsp.rename(`${out}.tmp`, out);
            } catch (e) { console.warn(`[Галерея] ${id}: ответы распознавания не записаны: ${e.message}`); return; }
            if (!added) return;
            // Оглавление не удаляем: пока идёт пересборка, открытая галерея работает по прежнему. Сборка, начатая до записи
            // ответов, их не видела — дождаться её и собрать ещё раз
            await this.building.get(id)?.promise;
            if ((this.forgotten.get(id) || 0) !== gen) return;
            this.memo.delete(id);
            await this.build(id).promise;
        }).catch((e) => console.warn(`[Галерея] ${id}: распознавание: ${e.message}`))
            .finally(() => this.visionRuns.delete(id));
        this.visionRuns.set(id, run);
        return run;
    }

    // Поиск по картинкам: кадры игр, у которых есть вектор (visionPass), по близости к вектору запроса. Только по
    // переданным играм; игры без ответов распознавания в поиске просто не участвуют. Файл ответов читаем, только
    // если он изменился (по времени записи): в нём тысячи векторов. В памяти на игру — один сплошной массив
    // (не тысяча мелких) и не больше SEARCH_GAMES игр сразу; из результатов держим только лучшие, а не все кадры
    async searchPictures(query, ids, limit = 60) {
        this.searchMemo = this.searchMemo || new Map();
        // С запасом на повторы и пропавшие из оглавления кадры, которые отсеются ниже
        const pool = Math.min(limit * 4, 600);
        const best = [];
        let covered = 0;
        for (const id of ids) {
            let mtime = 0;
            try { mtime = (await fsp.stat(this.visionPath(id))).mtimeMs; } catch { continue; }
            let mine = this.searchMemo.get(id);
            if (!mine || mine.mtime !== mtime || mine.version !== this.vision.version) {
                const { embeds, broken } = await this.visionLoad(id);
                const keys = Object.keys(embeds);
                const mat = new Int8Array(keys.length * EMBED_SIZE);
                const names = [];
                for (const key of keys) {
                    const v = unpackEmbed(embeds[key]);
                    if (v.length !== EMBED_SIZE) continue;
                    mat.set(v, names.length * EMBED_SIZE);
                    names.push(key.split('\n')[0]);
                }
                mine = { mtime, version: this.vision.version, names, mat: mat.subarray(0, names.length * EMBED_SIZE) };
                // Недописанный файл не запоминаем: следующий поиск прочтёт его заново
                this.searchMemo.delete(id);
                if (!broken) this.searchMemo.set(id, mine);
            } else {
                // Недавно использованная — в конец очереди
                this.searchMemo.delete(id);
                this.searchMemo.set(id, mine);
            }
            if (this.searchMemo.size > SEARCH_GAMES) this.searchMemo.delete(this.searchMemo.keys().next().value);
            if (!mine.names.length) continue;
            covered++;
            const { names, mat } = mine;
            for (let r = 0; r < names.length; r++) {
                const o = r * EMBED_SIZE;
                let dot = 0;
                for (let i = 0; i < EMBED_SIZE; i++) dot += query[i] * mat[o + i];
                const score = dot / EMBED_SCALE;
                if (best.length >= pool && score <= best[best.length - 1].score) continue;
                // Список по убыванию, не длиннее pool: вставка на своё место
                let at = best.length;
                while (at > 0 && best[at - 1].score < score) at--;
                best.splice(at, 0, { game: id, file: names[r], v: mat.subarray(o, o + EMBED_SIZE), score });
                if (best.length > pool) best.pop();
            }
            // Игр сотня, векторов тысячи: между играми отдаём цикл событий другим запросам
            await new Promise((resolve) => setImmediate(resolve));
        }
        // Кадр мог пропасть из оглавления после пересборки (ответы живут дольше) — такой не показываем
        const seen = new Set();
        const rows = [];
        for (const r of best) {
            if (rows.length >= limit) break;
            const k = `${r.game}\n${r.file}`;
            if (seen.has(k)) continue;
            seen.add(k);
            if (await this.knows(r.game, r.file) === false) continue;
            // Один и тот же рисунок в игре лежит под разными именами (вариант без текста, склейка и исходник) — одним
            // результатом: вектора почти совпали (косинус > 0,97)
            if (rows.some((x) => x.game === r.game && cosine(x.v, r.v) > 0.97)) continue;
            rows.push({ game: r.game, file: r.file, v: r.v, score: Math.round(r.score * 1000) / 1000 });
        }
        return { rows: rows.map(({ v, ...r }) => r), games: covered };
    }

    // ffprobe — отдельным методом: в тестах его подменяют
    probe(file) {
        return probeVideo(file);
    }

    // Отпечаток картинки (dHash 8×8: светлее ли точка соседа справа) — чтобы делить по рисунку альбом, у которого имена
    // ничего не говорят. Сбой — null
    async dhash(file, root) {
        const data = decrypt(await fsp.readFile(file), await mediaKey(root));
        return new Promise((resolve) => {
            const proc = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1']);
            try { os.setPriority(proc.pid, 10); } catch { /* не важно */ }
            const out = [];
            const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS);
            proc.stdout.on('data', (d) => out.push(d));
            proc.stdin.on('error', () => {});
            proc.on('error', () => { clearTimeout(timer); resolve(null); });
            proc.on('close', (code) => {
                clearTimeout(timer);
                const px = Buffer.concat(out);
                if (code !== 0 || px.length < 72) return resolve(null);
                let bits = '';
                for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
                resolve(BigInt(`0b${bits}`).toString(16).padStart(16, '0'));
            });
            proc.stdin.end(data);
        });
    }

    // Доля непрозрачного и ширина рисунка: ffmpeg ужимает картинку до 32×24 и отдаёт пиксели RGBA. Ответ —
    // { share, cols, box }: доля непрозрачных точек, доля столбцов, где их хотя бы две, и рамка рисунка [x0, y0, x1, y1]
    // в долях картинки. Не разобрал — считаем непрозрачной (останется CG, как раньше)
    async opaqueShare(file, root) {
        const data = decrypt(await fsp.readFile(file), await mediaKey(root));
        return new Promise((resolve) => {
            const proc = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=32:24:flags=area,format=rgba', '-f', 'rawvideo', 'pipe:1']);
            // Сборка оглавления идёт фоном по всем играм: не отнимаем процессор у игр и страниц
            try { os.setPriority(proc.pid, 10); } catch { /* нет прав или процесс уже вышел — не важно */ }
            const out = [];
            const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS);
            proc.stdout.on('data', (d) => out.push(d));
            proc.stdin.on('error', () => {});
            const whole = { share: 1, cols: 1, failed: true };
            proc.on('error', () => { clearTimeout(timer); resolve(whole); });
            proc.on('close', (code) => {
                clearTimeout(timer);
                const px = Buffer.concat(out);
                if (code !== 0 || px.length < 32 * 24 * 4) return resolve(whole);
                let solid = 0;
                const perCol = new Array(32).fill(0);
                // Рамка рисунка (где хоть что-то видно): окно врезки на пустом холсте во весь экран
                let x0 = 32, y0 = 24, x1 = 0, y1 = 0;
                for (let i = 0; i < 32 * 24; i++) {
                    const a = px[i * 4 + 3];
                    if (a >= 240) { solid++; perCol[i % 32]++; }
                    if (a >= 32) { x0 = Math.min(x0, i % 32); x1 = Math.max(x1, (i % 32) + 1); y0 = Math.min(y0, Math.floor(i / 32)); y1 = Math.max(y1, Math.floor(i / 32) + 1); }
                }
                const box = x1 > x0 ? [x0 / 32, y0 / 24, x1 / 32, y1 / 24] : [0, 0, 1, 1];
                resolve({ share: solid / (32 * 24), cols: perCol.filter((n) => n >= 2).length / 32, box });
            });
            proc.stdin.end(data);
        });
    }

    // Папка с img/ и data/: корень игры или её www
    async contentRoot(id) {
        const game = path.join(this.gamesDir, id);
        for (const dir of [path.join(game, 'www'), game]) {
            if (await fsp.stat(path.join(dir, 'img')).then((s) => s.isDirectory(), () => false)) return dir;
        }
        return null;
    }

    // System.json (и у игр, которые шифруют данные AES, — utils/gameData.js)
    async system(root) {
        return (await readGameJson(root, path.join(root, 'data', 'System.json'))) || {};
    }

    indexPath(id) { return path.join(this.mediaDir, id, 'gallery.json'); }
    scenesPath(id) { return path.join(this.mediaDir, id, 'gallery-scenes.json'); }
    // Сценарии сцен: по файлу на альбом (в каждой игре их сотни, а плееру нужна одна)
    // Сценарии сцен — в папке своей сборки (index.scripts, «scripts-<время>»): сборка, оборванная перезапуском, не оставит
    // оглавлению полупустую папку — оно смотрит в свою, целую, пока новое оглавление её не сменит
    scriptPath(id, dir, key) { return path.join(this.mediaDir, id, dir, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}.json`); }
    async dropScripts(id, keep = '') {
        const names = await fsp.readdir(path.join(this.mediaDir, id)).catch(() => []);
        for (const n of names) if (/^scripts(?:-\d+)?$/.test(n) && n !== keep) await fsp.rm(path.join(this.mediaDir, id, n), { recursive: true, force: true });
    }

    // Читаем JSON игры (с BOM и без)
    async readJson(file) {
        try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
    }

    // Общие события, страницы событий на картах и в боях (отряды врагов: сцены поражения), где показывают картинки —
    // командой, скриптом «showPicture» или плагином картинок (или зовут общие события). Данные не того вида (не массив,
    // нет команд) — пропускаем: сборка оглавления из-за них не падает
    // withSpine — у игры есть наборы Spine: события, что только крутят скелет (без картинок), кладём в spineSources — их читает
    // один блок analyze, в счёт картинок, группы и размер экрана они не идут
    async readSources(root, withSpine = false) {
        const data = path.join(root, 'data');
        const readData = (file) => readGameJson(root, file);
        const asArray = (v) => (Array.isArray(v) ? v : []);
        const ces = asArray(await readData(path.join(data, 'CommonEvents.json')));
        const infos = asArray(await readData(path.join(data, 'MapInfos.json')));
        const shows = (list, calls) => list.some((x) => x && (x.code === 231 || (calls && x.code === 117)
            || ((x.code === 355 || x.code === 655) && /Picture\s*\(/.test(String(x.parameters?.[0])))
            || (x.code === 356 && /^\s*(?:PA_|ピクチャのアニメーション)/i.test(String(x.parameters?.[0]))) || (x.code === 357 && x.parameters?.[0] === 'PictureAnimation')));
        // Ролики без картинок: PKD_VPlayer (скрипт и команда MZ), «Показать видео». Такой источник — vonly: в альбомы и счёт
        // картинок не идёт, только сцена для плеера
        const vshows = (list) => list.some((x) => x && (x.code === 261 || (x.code === 357 && /VPlayer/i.test(String(x.parameters?.[0])) && x.parameters?.[1] === 'ShowVAnim')
            || ((x.code === 355 || x.code === 655) && /\bShowVAnim(?:OnSpriteset|ScreenBelowPictures)?\s*\(/.test(String(x.parameters?.[0])))));
        const sources = [];
        const spineAll = [];
        // Вызовы сценариев TS_ADVsystem («AdvLoad 001») — во всех списках: событие сцены само картинок не показывает
        const advRefs = [];
        // Параллельные страницы, которые сцена может включить: общие события «параллельно» с переключателем; страницы карт
        // «параллельно» с условием (переключатель, переменная, свой переключатель) — у события и условия остальных
        // страниц: игра крутит самую старшую страницу, чьи условия выполнены
        const pars = { ce: [], maps: new Map(), battle: await battleParallel(root) };
        const withCond = (c) => !!c && (c.switch1Valid || c.switch2Valid || c.variableValid || c.selfSwitchValid);
        // Кто зовёт общее событие: карта (страницы, меню) или только бой (отряды, навыки и предметы «только в бою»)
        const mapRef = new Set();
        const battleRef = new Set();
        const calls = new Map();
        const refs = (list, into) => { for (const x of list || []) if (x && x.code === 117) into.add(x.parameters?.[0]); };
        ces.forEach((c) => { if (c && Array.isArray(c.list)) advRefs.push(...advScenes.refs(c.list, '', false, `ce${c.id}`)); });
        ces.forEach((c) => {
            if (!c || !Array.isArray(c.list)) return;
            if (shows(c.list, false)) sources.push({ id: `ce${c.id}`, name: c.name, list: c.list, where: '' }); else if (vshows(c.list)) sources.push({ id: `ce${c.id}`, name: c.name, list: c.list, where: '', vonly: true });
            if (withSpine) spineAll.push({ id: `ce${c.id}`, ce: c.id, name: c.name, list: c.list, where: '' });
            if (c.trigger === 2 && c.switchId && shows(c.list, false)) pars.ce.push({ id: c.id, sw: c.switchId, list: c.list });
            const k = new Set();
            refs(c.list, k);
            calls.set(c.id, k);
            if (c.trigger === 1 || c.trigger === 2) mapRef.add(c.id);
        });
        for (const m of infos) {
            if (!m) continue;
            const map = await readData(path.join(data, `Map${String(m.id).padStart(3, '0')}.json`));
            for (const ev of asArray(map && map.events)) {
                const pages = asArray(ev && ev.pages).map((pg) => ({ c: pg ? pg.conditions : null,
                    ...(pg && Array.isArray(pg.list) && pg.trigger === 4 && withCond(pg.conditions) && shows(pg.list, false) ? { list: pg.list } : {}) }));
                if (pages.some((pg) => pg.list)) {
                    const ids = new Set();
                    for (const { c } of pages) if (c) { if (c.switch1Valid) ids.add(`s${c.switch1Id}`); if (c.switch2Valid) ids.add(`s${c.switch2Id}`); if (c.variableValid) ids.add(`v${c.variableId}`); if (c.selfSwitchValid) ids.add('self'); }
                    if (!pars.maps.has(m.id)) pars.maps.set(m.id, []);
                    pars.maps.get(m.id).push({ id: ev.id, pages, ids: [...ids] });
                }
                for (const [i, pg] of asArray(ev && ev.pages).entries()) {
                    if (!pg || !Array.isArray(pg.list)) continue;
                    refs(pg.list, mapRef);
                    advRefs.push(...advScenes.refs(pg.list, m.name || '', true, `m${m.id}e${ev.id}p${i}`));
                    if (shows(pg.list, true)) sources.push({ id: `m${m.id}e${ev.id}p${i}`, map: m.id, ev: ev.id, name: ev.name, list: pg.list, where: m.name || '' });
                    else if (vshows(pg.list)) sources.push({ id: `m${m.id}e${ev.id}p${i}`, map: m.id, ev: ev.id, name: ev.name, list: pg.list, where: m.name || '', vonly: true });
                    if (withSpine) spineAll.push({ id: `m${m.id}e${ev.id}p${i}`, map: m.id, name: ev.name, list: pg.list, where: m.name || '' });
                }
            }
        }
        for (const t of asArray(await readData(path.join(data, 'Troops.json')))) {
            for (const [i, pg] of asArray(t && t.pages).entries()) {
                if (pg && Array.isArray(pg.list)) { advRefs.push(...advScenes.refs(pg.list, '', false, `t${t.id}p${i}`)); refs(pg.list, battleRef); }
                // Название — по первой реплике: имя отряда («Гоблин×2») — не название сцены
                if (pg && Array.isArray(pg.list) && shows(pg.list, true)) sources.push({ id: `t${t.id}p${i}`, name: '', list: pg.list, where: t.name || '' });
                if (withSpine && pg && Array.isArray(pg.list)) spineAll.push({ id: `t${t.id}p${i}`, name: '', list: pg.list, where: t.name || '' });
            }
        }
        for (const file of ['Skills.json', 'Items.json']) {
            for (const x of asArray(await readData(path.join(data, file)))) for (const e of asArray(x && x.effects)) if (e && e.code === 44) (x.occasion === 1 ? battleRef : mapRef).add(e.dataId);
        }
        const spread = (set) => { const todo = [...set]; while (todo.length) for (const k of calls.get(todo.pop()) || []) if (!set.has(k)) { set.add(k); todo.push(k); } };
        spread(mapRef);
        spread(battleRef);
        for (const s of sources) { const m = /^ce(\d+)$/.exec(s.id); if (m && battleRef.has(Number(m[1])) && !mapRef.has(Number(m[1]))) s.battle = true; }
        // События только со Spine: прямой вызов плагина, общие события, что зовут такое (до трёх уровней), страницы карт и отрядов.
        // Свой try: сбой тут — без этих сцен, остальные источники целы. Читаем исходные списки (до разворота ExternMessage)
        const spineSources = [];
        if (withSpine) {
            try {
                const have = new Set(sources.map((x) => x.id));
                const callers = new Set(spineAll.filter((x) => x.ce !== undefined && callsSpine(x.list)).map((x) => x.ce));
                for (let k = 0; k < 3; k++) for (const x of spineAll) if (x.ce !== undefined && !callers.has(x.ce) && x.list.some((c) => c && c.code === 117 && callers.has(c.parameters?.[0]))) callers.add(x.ce);
                for (const x of spineAll) if (!have.has(x.id) && (x.ce !== undefined ? callers.has(x.ce) : callsSpine(x.list))) spineSources.push(x);
                spineSources.length = Math.min(spineSources.length, SPINE_SOURCES_MAX);
            } catch { spineSources.length = 0; }
        }
        const dialog = await this.dialogTables(root, [...sources.map((s) => s.list), ...ces.map((c) => c && c.list)]).catch(() => null);
        // ExternMessage: реплики из CSV разворачиваем последним — всё выше (кто показывает картинки, таблицы реплик) считано
        // по исходным спискам и от этого не меняется. Исходный список source остаётся в raw: по нему название сцены
        const em = await extern.loadExternMessage(root).catch(() => null);
        if (em) {
            const stats = {};
            const done = new Map();
            const expand = (list) => { if (!done.has(list)) done.set(list, extern.expandList(list, em, stats)); return done.get(list); };
            const ces2 = ces.map((c) => (c && Array.isArray(c.list) ? { ...c, list: expand(c.list) } : c));
            const sources2 = sources.map((s) => { const list = expand(s.list); return list === s.list ? s : { ...s, list, raw: s.list }; });
            // Почти все ключи неизвестны — не тот файл, столбец или кодировка: лучше исходные списки, чем номера вместо текста
            if (!(stats.top && stats.miss / stats.top > extern.MISS_MAX)) return { ces: ces2, sources: sources2, texts: dialog ? { dialog } : null, advRefs, pars, spineSources };
        }
        return { ces, sources, texts: dialog ? { dialog } : null, advRefs, pars, spineSources };
    }

    // Реплики DialogFromCSVwithPic: читаем только CSV, которые зовут события. Игру делали под Windows: «R1-…» в событии
    // и «r1-…» на диске — один файл. Ответ — dialog(файл, id) → { name, lines } или null; таких команд нет — null без чтения
    async dialogTables(root, lists) {
        const want = new Set();
        for (const list of lists) {
            for (const c of Array.isArray(list) ? list : []) {
                const a = scenes.csvDialog(c);
                // Только имя файла в data/: путь из данных игры наружу не уводит
                if (a && typeof a.csvFile === 'string' && a.csvFile && !/[\\/]|\.\./.test(a.csvFile)) want.add(a.csvFile);
            }
        }
        if (!want.size) return null;
        const dir = path.join(root, 'data');
        const names = await fsp.readdir(dir).catch(() => []);
        const exact = new Set(names);
        const lower = new Map();
        for (const n of names) if (!lower.has(n.toLowerCase())) lower.set(n.toLowerCase(), n);
        const tables = new Map();     // имя в событии → таблица
        const read = new Map();       // файл на диске → таблица: «R1-a.csv» и «r1-a.csv» читаем один раз
        let total = 0;
        for (const f of want) {
            const real = exact.has(f) ? f : lower.get(f.toLowerCase());
            if (!real) continue;
            if (!read.has(real)) {
                read.set(real, null);
                const file = path.join(dir, real);
                const st = read.size <= CSV_FILES ? await fsp.stat(file).catch(() => null) : null;
                if (!st || !st.isFile() || st.size > CSV_MAX || total + st.size > CSV_TOTAL) continue;
                total += st.size;
                const text = await readGameText(root, file).catch(() => null);
                if (text !== null) read.set(real, scenes.dialogCsv(text));
            }
            if (read.get(real)) tables.set(f, read.get(real));
        }
        return tables.size ? (file, id) => tables.get(file)?.get(id) || null : null;
    }

    // Сцены из событий игры и группы картинок по событиям. kindOf — раздел каждого файла из оглавления (по нему
    // отличаем CG и слои от портретов), partial — CG с прозрачными местами (не основа склейки). Ответ: { albums, frames: { сцена: кадры }, groups, pics }
    async buildSceneAlbums(root, screen, kindOf, loaded, partial = new Set(), entries = new Map(), audioOf = null, spineSets = [], l2dModels = []) {
        const { ces, sources, texts = null, advRefs = [], pars = null, spineSources = [] } = loaded || await this.readSources(root, spineSets.length > 0 || l2dModels.length > 0);
        // Имя картинки в команде — путь внутри img/pictures без расширения, регистр не важен
        const pics = new Map();
        for (const rel of kindOf.keys()) {
            if (rel.startsWith('img/pictures/')) pics.set(rel.slice('img/pictures/'.length).replace(IMAGE, '').toLowerCase(), rel);
        }
        if (!pics.size && ![...kindOf.keys()].some((rel) => rel.startsWith('movies/'))) return { albums: [], frames: {}, groups: [], pics, used: new Set(), shownRels: new Set(), stillRels: new Set(), vscenes: [], ascenes: [], wholeIds: new Set(), spineScenes: [], l2dScenes: [] };
        const picKind = (name) => { const rel = pics.get(String(name).toLowerCase()); return rel ? kindOf.get(rel) : null; };
        // Ролики — по имени внутри movies/ без расширения (так их называют плагины)
        const movieRels = new Map();
        for (const rel of kindOf.keys()) if (rel.startsWith('movies/') && VIDEO.test(rel)) movieRels.set(bareName(rel.slice('movies/'.length)).toLowerCase(), rel);
        // Вспышка, затемнение: имя «white», «black_out02», «fade» и почти пустой файл на весь экран (одноцветный PNG —
        // несколько КБ: у The Lantern Road «white» 1280×720 — 8 КБ)
        const flat = (name) => {
            const rel = pics.get(String(name).toLowerCase());
            const e = rel && entries.get(rel);
            return !!e && FLAT_NAME.test(path.posix.basename(rel).replace(IMAGE, '')) && e.w >= 0.8 * screen.w && e.h >= 0.8 * screen.h && e.size < FLAT_BYTES * e.w * e.h;
        };
        // Ролики для сценариев: имя в movies/ (как в командах) и путь от корня игры (MP_SET_OUTER_MOVIE) → файл оглавления.
        // Из двух форматов одного ролика в оглавлении один (mp4) — ищем по пути без расширения
        const videoStem = new Map();
        for (const rel of kindOf.keys()) if (VIDEO.test(rel)) videoStem.set(realFile(rel).replace(/\.[^./]+$/, '').toLowerCase(), rel);
        const video = { ...(await videoFlags(root)), videoRel: (name) => movieRels.get(name) || null,
            outerRel: (p) => videoStem.get(String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.[^./]+$/, '').toLowerCase()) || null };
        // Сцены из файлов сценария — после событий (события первыми забирают картинки) и после screenFor: их картинки
        // в масштабе 100 не сдвигают размер экрана. Сломанный файл или папка — без них, сцены событий как были
        const sizeOf = (name) => { const rel = pics.get(String(name).toLowerCase()); const e = rel && entries.get(rel); return e && e.w ? { w: e.w, h: e.h } : null; };
        const adv = advRefs.length ? await advScenes.sources(root, advRefs, screen, sizeOf, (name) => pics.has(String(name).toLowerCase()), scenes.TEST_MAP).catch(() => []) : [];
        const spine = spineSets.length || l2dModels.length ? { sets: spineSets, l2d: l2dModels, sources: spineSources } : undefined;
        const { clips, groups, shown, stills, uses, loops, vscenes, ascenes, spineScenes, l2dScenes } = scenes.analyze(adv.length ? [...sources, ...adv] : sources, ces, picKind, (name) => partial.has(pics.get(String(name).toLowerCase())),
            [...pics.keys()], [...movieRels.keys()], flat, audioOf, { texts, pars, paFirst: await paFirstCell(root), video, ...(spine ? { spine } : {}) });
        if (spine && spine.error) console.warn(`[Галерея] Spine и Live2D в сценах: ${spine.error}`);
        const albums = [];
        const frames = {};
        const used = new Set();     // файлы, ушедшие в анимации: целым кадром или слоем склейки
        // Анимации из событий — во вкладку «Анимации»: кадр — сам файл, если он на экране один, иначе склейка «@cg/…».
        // Темп — как в игре: паузы события в кадрах игры (60 в секунду)
        // Страницы одного события («m17e9p0…p3» — медленно, быстрее, финал) — стадии одной сцены: одним альбомом
        const byEvent = new Map();
        for (const clip of clips) {
            const key = clip.id.replace(/p\d+$/, '') + (clip.par ? '#par' : '');
            const had = byEvent.get(key);
            if (had) { had.finished.push(...clip.finished); had.waits.push(clip.wait); } else byEvent.set(key, { ...clip, finished: [...clip.finished], waits: [clip.wait] });
        }
        for (const clip of byEvent.values()) {
            const files = [];
            const mine = new Set();
            for (const item of clip.finished) {
                if (item.name) { const rel = pics.get(item.name.toLowerCase()); if (rel && !files.includes(rel)) { files.push(rel); mine.add(rel); } continue; }
                const layers = item.layers.map((l) => ({ ...l, rel: pics.get(l.name.toLowerCase()) || '' })).filter((l) => l.rel);
                if (!layers.length) continue;
                const h = cgHash(layers);
                if (files.includes(`${CG_PREFIX}${h}`)) continue;
                frames[h] = layers;
                files.push(`${CG_PREFIX}${h}`);
                for (const l of layers) mine.add(l.rel);
            }
            // Альбом не сложился — его файлы остаются там, где были
            if (files.length < 2) continue;
            // Петля страницы поверх сцены — показ того, что уже есть в других альбомах: файлы оттуда не забираем
            if (!clip.par) for (const rel of mine) used.add(rel);
            // Темп — как в игре, но не быстрее 30 кадров в секунду (анимации плагина бывают и по кадру игры)
            albums.push({ key: `scenes/${clip.id.replace(/p\d+$/, '')}/${clip.title.replace(/\//g, '∕')}${clip.par ? '#par' : ''}`, kind: 'animation', anim: true, w: screen.w, h: screen.h, files, cover: files[0],
                fps: Math.max(2, Math.min(30, Math.round(60 / Math.max(1, clip.waits.reduce((x, y) => x + y, 0) / clip.waits.length)))) });
        }
        // Ролики, которые событие крутит по кругу, — анимации его сцены: свой альбом рядом с кадрами (ролик в нём
        // играет как петля, без кнопок). Один ролик — в первой сцене, где встретился
        const looped = new Set();
        for (const l of loops || []) {
            const files = l.names.map((n) => movieRels.get(n)).filter((rel) => rel && !looped.has(rel));
            if (!files.length) continue;
            for (const rel of files) looped.add(rel);
            const key = `scenes/${l.id.replace(/p\d+$/, '')}/${l.title.replace(/\//g, '∕')}`;
            // Событие с именем ролика из переменной крутит десятки разных сцен (общий обработчик H-анимаций боя — 220
            // роликов): их много и по именам это разные наборы — альбом на каждый набор
            const byName = new Map();
            for (const rel of files) { const k = albumKey(rel); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(rel); }
            if (files.length > LOOP_GROUP && byName.size >= 2) {
                for (const [k, list] of byName) albums.push({ key: `${key}/${k.replace(/^movies\//, '').replace(/\//g, '∕')}#loop`, kind: 'animation', w: 0, h: 0, files: list, cover: list[0] });
            } else albums.push({ key: `${key}#loop`, kind: 'animation', w: 0, h: 0, files, cover: files[0] });
        }
        const relsOf = (names) => new Set([...names].map((n) => pics.get(String(n).toLowerCase())).filter(Boolean));
        return { albums, frames, groups, pics, used, shownRels: relsOf(shown), stillRels: relsOf(stills || []), uses, looped, vscenes: vscenes || [], ascenes: ascenes || [], wholeIds: new Set(adv.filter((s) => s.linear).map((s) => s.id)), spineScenes: spineScenes || [], l2dScenes: l2dScenes || [] };
    }

    // Списки кадров, которые игра называет в параметрах включённых плагинов (GIF-анимации Drill_up: «资源-动作元» —
    // ["Boat-000","Boat-Flip-001",…] и «帧间隔»). Список — массив строк-имён (2…LISTED_MAX), все они — картинки одной
    // папки; параметры бывают JSON внутри JSON. Ответ: [Set(пути кадров)]. Так отличаем короткую покадровую анимацию
    // от страниц сцены и вариантов позы: те ни в каком списке плагина вместе не стоят
    async listedFrames(root, entries) {
        let plugins;
        try {
            const text = await fsp.readFile(path.join(root, 'js', 'plugins.js'), 'utf8');
            plugins = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
        } catch { return []; }
        const byName = new Map();
        for (const rel of entries.keys()) {
            const k = bareName(path.posix.basename(rel)).toLowerCase();
            if (!byName.has(k)) byName.set(k, []);
            byName.get(k).push(rel);
        }
        const out = [];
        const seen = new Set();
        const walk = (v, depth) => {
            if (typeof v === 'string' && /^\s*[[{]/.test(v) && depth < 6) {
                try { walk(JSON.parse(v), depth + 1); } catch { /* не JSON — обычная строка */ }
            } else if (Array.isArray(v)) {
                if (v.length >= 2 && v.length <= LISTED_MAX && v.every((x) => typeof x === 'string')) {
                    const names = [...new Set(v.map((x) => bareName(path.posix.basename(x.trim())).toLowerCase()).filter(Boolean))];
                    // Папка, где есть все имена списка
                    const dirs = names.map((n) => new Set((byName.get(n) || []).map((r) => path.posix.dirname(r))));
                    const dir = names.length >= 2 ? [...dirs[0]].find((d) => dirs.every((x) => x.has(d))) : null;
                    if (dir) {
                        const rels = names.map((n) => byName.get(n).find((r) => path.posix.dirname(r) === dir));
                        const key = rels.join('|');
                        if (!seen.has(key)) { seen.add(key); out.push(new Set(rels)); }
                    }
                } else for (const x of v) walk(x, depth + 1);
            } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
        };
        for (const pl of plugins) if (pl && pl.status === true) walk(pl.parameters, 0);
        return out;
    }

    // Размер экрана игры: System.json (MZ), параметры плагина (MV: «Community_Basic», «YEP_CoreEngine»…), и по самим
    // картинкам — если почти все большие картинки одного размера той же пропорции, но крупнее (Clockwork Vale 2: везде
    // записано 816×624, а CG — 1020×778; игру растягивает другой плагин), экран — этот размер
    async screenFor(root, entries, sources = []) {
        const system = await this.system(root);
        let base = system.advanced ? screenOf(system) : null;
        let explicit = !!base;
        try {
            // Только включённые плагины: у выключенного свой «screenWidth» не действует. Из нескольких — последний: плагины
            // грузятся по порядку, и каждый перезаписывает размер (Кошмар Рыцаря: YEP_CoreEngine 816×624, ниже Community_Basic 1280×720)
            const text = await fsp.readFile(path.join(root, 'js', 'plugins.js'), 'utf8');
            const t = text.split(/\{\s*"name"\s*:/).filter((part) => /"status"\s*:\s*true/.test(part)).join('\n');
            const m = [...t.matchAll(/"(?:screenWidth|ScreenWidth|screen_width|Screen Width|画面の幅|画面幅)"\s*:\s*"(\d{3,4})"[^}]*?"(?:screenHeight|ScreenHeight|screen_height|Screen Height|画面の高さ|画面高さ)"\s*:\s*"(\d{3,4})"/g)].pop();
            if (m) { base = { w: Number(m[1]), h: Number(m[2]) }; explicit = true; }
        } catch { /* без плагинов */ }
        base = base || { w: 816, h: 624 };
        const sizes = new Map();
        let big = 0;
        for (const [rel, e] of entries) {
            if (!rel.startsWith('img/pictures/') || e.video || e.w < base.w * 0.9 || e.h < base.h * 0.9) continue;
            big++;
            const k = `${e.w}x${e.h}`;
            sizes.set(k, (sizes.get(k) || 0) + 1);
        }
        // Только если игра показывает картинки в натуральную величину: «123» выводит свои 2800×2100 в масштабе 30 %,
        // Seven Keys 3 — 2400×1350 в 66 %: экран у них обычный
        const zooms = new Map();
        for (const src of sources) for (const c of src.list || []) if (c && c.code === 231) { const z = Number(c.parameters?.[6]) || 100; zooms.set(z, (zooms.get(z) || 0) + 1); }
        const zoom = [...zooms].sort((a, b) => b[1] - a[1])[0];
        const top = [...sizes].sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= Math.max(10, big * 0.3) && (!zoom || zoom[0] === 100)) {
            const [w, h] = top[0].split('x').map(Number);
            // Той же формы — экран растянут; другой формы — только если размер нигде явно не записан (Ashen Crown:
            // в настройках MV стоит 816×624 по умолчанию, а все CG 1440×900 и показываются в 100 %)
            if (w > base.w && h >= base.h && (!explicit || Math.abs(w / h - base.w / base.h) < 0.04 * (base.w / base.h))) return { w, h };
        }
        return base;
    }

    async cached(id) {
        if (this.memo.has(id)) return this.memo.get(id).index;
        let index;
        try { index = JSON.parse(await fsp.readFile(this.indexPath(id), 'utf8')); } catch { return null; }
        // Оглавление прежнего вида (до разделов «CG» и «Фоны») — построим заново. Собранное, когда ffprobe
        // не ответил, — тоже, но не раньше чем через час
        if (index.v !== INDEX_VERSION) return null;
        if (index.retryAt && Date.now() > index.retryAt) return null;
        // Сверка с облаком — по этой же сборке оглавления: после пересборки альбомы могли стать другими
        try {
            const cloud = JSON.parse(await fsp.readFile(this.cloudPath(id), 'utf8'));
            const promote = new Set(cloud.built === index.builtAt && Array.isArray(cloud.promote) ? cloud.promote : []);
            const parts = [];
            for (const a of index.albums) {
                if (!promote.has(a.key) || !CLOUD_PROMOTE.has(a.kind)) continue;
                index.counts[a.kind] -= a.files.length;
                if (!index.counts[a.kind]) delete index.counts[a.kind];
                index.counts.cg = (index.counts.cg || 0) + a.files.length;
                a.kind = 'cg';
                a.cloud = true;
                if (a.key.endsWith('#parts')) parts.push(a);
            }
            // «X#parts» — детали сцены «X», которые сборка отделила в «Слои»: признанные CG, они — та же сцена, что и альбом «X»
            // (или «X» без номера в конце: «sc 1#parts» — «sc») рядом, а не вторая плитка с внутренним ключом вместо названия.
            // Сливаем после того, как признаны все: «X» мог быть признан позже своих деталей
            const merged = new Set();
            for (const a of parts) {
                const base = a.key.slice(0, -'#parts'.length);
                // Сначала «X» как есть: «ev10#parts» — к «ev10», а не к «ev», стоящему в списке раньше
                const hostOf = (key) => index.albums.find((x) => x !== a && x.key === key && x.kind === 'cg' && !x.anim && !x.panel);
                const host = hostOf(base) || hostOf(base.replace(/[\s_\-.]*\d+$/, ''));
                if (!host) continue;
                // Детали — в конец: порядок кадров у альбома события — порядок самого события, по имени его не переставляем
                const have = new Set(host.files);
                host.files = [...host.files, ...a.files.filter((f) => !have.has(f))];
                merged.add(a);
            }
            if (merged.size) index.albums = index.albums.filter((x) => !merged.has(x));
        } catch { /* сверки нет — как есть */ }
        if (this.memo.size > 20) this.memo.delete(this.memo.keys().next().value);
        // parts — файлы слоёв склеек, которых нет в альбомах (основа под слоями, кадр листа анимации): их читает склейка
        const spine = new Set(Array.isArray(index.spineFiles) ? index.spineFiles : []);
        // Файлы моделей Live2D: путь как на диске → он же, и по нижнему регистру (игра ссылается на текстуру с другим регистром)
        const live2d = { exact: new Set(), lower: new Map() };
        for (const f of Array.isArray(index.live2dFiles) ? index.live2dFiles : []) { live2d.exact.add(f); if (!live2d.lower.has(f.toLowerCase())) live2d.lower.set(f.toLowerCase(), f); }
        this.memo.set(id, { index, spine, live2d, files: new Set([...index.albums.flatMap((a) => a.files), ...(Array.isArray(index.parts) ? index.parts : []), ...spine, ...live2d.exact]) });
        return index;
    }

    // Обложки плиток Spine и Live2D (PUT/GET /api/gallery/:id/rig-cover): кадр присылает браузер, снявший его при первом
    // просмотре. Лежат в _media (не в папке игры) по хэшу ключа альбома и переживают пересборку оглавления
    rigCoverFile(id, key) { return path.join(this.mediaDir, id, 'rig-covers', `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}.jpg`); }
    async rigAlbum(id, key) {
        const index = key && await this.cached(id);
        return index && index.albums.find((a) => a.key === key && (a.spine || a.live2d)) || null;
    }
    // 'bad-key' — такого набора в оглавлении нет; 'exists' — обложка уже есть (первая остаётся: два устройства не спорят).
    // Исключение — почти пустой кадр (чёрный JPEG 320x240 около 1 КБ, настоящий заметно больше): его заменяет более полный
    async rigCoverPut(id, key, jpeg) {
        if (!(await this.rigAlbum(id, key))) return 'bad-key';
        const file = this.rigCoverFile(id, key);
        const old = await fsp.stat(file).then((s) => s.size, () => -1);
        if (old >= 0 && !(old < 2048 && jpeg.length > old)) return 'exists';
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fsp.writeFile(tmp, jpeg);
        try {
            // Замена пустого — rename; нового — link: если другой запрос успел раньше, его файл не затираем
            if (old >= 0) await fsp.rename(tmp, file);
            else await fsp.link(tmp, file);
        } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { await fsp.rm(tmp, { force: true }); }
        return 'ok';
    }
    async rigCover(id, key) {
        if (!(await this.rigAlbum(id, key))) return null;
        const file = this.rigCoverFile(id, key);
        return (await fsp.access(file).then(() => true, () => false)) ? file : null;
    }
    // Оглавление для ответа: у наборов с готовой обложкой — rigCover: true (не пробовать 404 на каждую плитку).
    // Оглавление в памяти общее, поэтому копируем только отмеченные альбомы
    async withRigCovers(id, index) {
        if (!index.albums.some((a) => a.spine || a.live2d)) return index;
        const have = new Set(await fsp.readdir(path.join(this.mediaDir, id, 'rig-covers')).catch(() => []));
        if (!have.size) return index;
        return { ...index, albums: index.albums.map((a) => ((a.spine || a.live2d) && have.has(path.basename(this.rigCoverFile(id, a.key))) ? { ...a, rigCover: true } : a)) };
    }

    // Игру обновили, поставили патч или вернули прежнюю версию — оглавление устарело
    async forget(id) {
        this.forgotten.set(id, (this.forgotten.get(id) || 0) + 1);
        const root = await this.contentRoot(id).catch(() => null);
        if (root) forgetGame(root);
        this.memo.delete(id);
        this.soundMemo.delete(id);
        this.langMemo.delete(id);
        this.sceneMemo?.delete(id);
        this.searchMemo?.delete(id);
        await fsp.rm(this.indexPath(id), { force: true });
        await fsp.rm(this.scenesPath(id), { force: true });
        await fsp.rm(path.join(this.mediaDir, id, 'gallery'), { recursive: true, force: true });
        await fsp.rm(path.join(this.mediaDir, id, 'scenes'), { recursive: true, force: true });
        await fsp.rm(path.join(this.mediaDir, id, 'view'), { recursive: true, force: true });
        this.viewBytes?.delete(id);
        this.aheaded?.clear();
        await this.dropScripts(id);
        await fsp.rm(path.join(this.mediaDir, id, 'cells'), { recursive: true, force: true });
        // Замеры прозрачности, ответы ffprobe и распознавания — по пути и размеру: патч мог заменить файл на такой же
        // по размеру
        await fsp.rm(path.join(this.mediaDir, id, 'gallery-opaque.json'), { force: true });
        await fsp.rm(path.join(this.mediaDir, id, 'gallery-probe.json'), { force: true });
        await fsp.rm(path.join(this.mediaDir, id, 'gallery-hash.json'), { force: true });
        await fsp.rm(this.visionPath(id), { force: true });
        await fsp.rm(path.join(this.mediaDir, id, 'gallery-print.json'), { force: true });
        await fsp.rm(this.cloudPath(id), { force: true });
    }

    // Отпечатки картинок игры для сверки с облаком (services/galleryCloud.js): { путь: отпечаток }. Только размером от
    // 40 % экрана (мелочь интерфейса облако не собирает), без роликов, движка и склеек — их слои и так здесь. Ответы
    // прошлой сверки — по пути и размеру файла: у Ironhold Keep 17 тысяч слоёв, это минуты
    async prints(id) {
        const index = await this.cached(id);
        const root = index && await this.contentRoot(id);
        if (!root) return null;
        const file = path.join(this.mediaDir, id, 'gallery-print.json');
        let known = {};
        try { known = JSON.parse(await fsp.readFile(file, 'utf8')) || {}; } catch { /* нет — посчитаем */ }
        const key = await mediaKey(root);
        const rels = [];
        for (const a of index.albums) {
            if (a.kind === 'engine' || a.kind === 'video' || a.w < index.screen.w * 0.4 || a.h < index.screen.h * 0.4) continue;
            for (const rel of a.files) if (!rel.startsWith(CG_PREFIX) && !VIDEO.test(rel)) rels.push(rel);
        }
        const out = {};
        const now = {};
        await pool(rels, 3, async (rel) => {
            const st = await fsp.stat(path.join(root, rel)).catch(() => null);
            if (!st) return;
            const k = known[rel];
            const h = Array.isArray(k) && k[0] === st.size ? k[1]
                : await fsp.readFile(path.join(root, rel)).then((data) => imagePrint(decrypt(data, key)), () => null);
            if (h) { out[rel] = h; now[rel] = [st.size, h]; }
        });
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, JSON.stringify(now)).catch(() => {});
        return out;
    }

    // Оглавление готово — оно; строится — сколько сделано; нет — начать строить
    async state(id) {
        const index = await this.cached(id);
        if (index) {
            this.prewarm(id, index);
            if (index.scripts) this.sceneLangs(id, index).catch(() => {});
            return { state: 'ready', ...(await this.withRigCovers(id, index)) };
        }
        const job = this.build(id);
        return { state: 'building', done: job.done, total: job.total };
    }

    build(id) {
        if (this.building.has(id)) return this.building.get(id);
        const job = { done: 0, total: 0 };
        job.promise = this.runBuild(id, job)
            .catch((e) => console.error(`[Галерея] ${id}:`, e.message))
            .finally(() => this.building.delete(id));
        this.building.set(id, job);
        return job;
    }

    async runBuild(id, job) {
        const root = await this.contentRoot(id);
        const index = { v: INDEX_VERSION, builtAt: Date.now(), screen: { w: 816, h: 624 }, counts: {}, albums: [] };
        if (root) {
            index.screen = screenOf(await this.system(root));
            const files = [];
            // Папки моделей Spine и Live2D: их картинки — текстуры (руки, глаза, волосы вперемешку на одном листе), не CG
            const rigs = new Set();
            const walk = async (rel) => {
                for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
                    const r = `${rel}/${e.name}`;
                    if (e.isDirectory()) {
                        if (rel === 'img' && ENGINE_DIRS.has(e.name.toLowerCase())) continue;
                        await walk(r);
                    } else if (e.isFile() && (IMAGE.test(e.name) || VIDEO.test(e.name))) files.push(r);
                    else if (e.isFile() && (rel === 'movies' || rel.startsWith('movies/'))) {
                        const kind = await sniffVideo(path.join(root, r));
                        if (kind) files.push(`${r}#.${kind}`);
                    }
                    // Не верхняя папка: случайный файл модели в img/pictures не делает текстурами все картинки
                    else if (e.isFile() && RIG.test(e.name) && rel.split('/').length >= 3) rigs.add(rel);
                }
            };
            await walk('img');
            // Ролики игры — в movies/ рядом с img/
            await walk('movies');
            // Ролик в двух форматах рядом («fog.mp4» и «fog.webm», так кладут для разных систем) — один раз: mp4 играет везде,
            // в том числе в Safari. Второй не в альбомах, но открывается (избранное)
            const twins = new Set();
            const videoStem = (rel) => `${path.posix.dirname(rel)}/${bareName(path.posix.basename(rel))}`.toLowerCase();
            const videoRank = (rel) => (/\.(?:mp4|m4v)$/i.test(rel) ? 0 : /\.webm$/i.test(rel) ? 1 : 2);
            const bestVideo = new Map();
            for (const rel of files) {
                if (!VIDEO.test(rel)) continue;
                const k = videoStem(rel);
                const had = bestVideo.get(k);
                if (!had) bestVideo.set(k, rel);
                else if (videoRank(rel) < videoRank(had)) { twins.add(had); bestVideo.set(k, rel); } else twins.add(rel);
            }
            if (twins.size) files.splice(0, files.length, ...files.filter((rel) => !twins.has(rel)));
            // Наборы Spine — отдельными альбомами-анимациями; их текстуры (части тела на листе) не картинки для галереи
            const spines = await findSpines(root);
            const spineFiles = new Set(spines.flatMap((x) => [x.atlas, x.skeleton, ...x.pages]));
            if (spineFiles.size) files.splice(0, files.length, ...files.filter((rel) => !spineFiles.has(rel)));
            // Модели Live2D — тоже отдельными альбомами-анимациями, листы их текстур (img/live2d лежит среди «Системных») — не картинки
            const live2d = await findLive2D(root).catch(() => []);
            const live2dFiles = new Set(live2d.flatMap((x) => x.files));
            if (live2dFiles.size) files.splice(0, files.length, ...files.filter((rel) => !live2dFiles.has(rel)));
            job.total = files.length;
            // Сначала размеры всех файлов, потом разделы: размер экрана уточняем по самим картинкам (screenFor)
            // Порядок в оглавлении — как у файлов на диске, хоть читаем их по несколько сразу
            const entries = new Map(files.map((rel) => [rel, { w: 0, h: 0, size: 0 }]));
            let probeFailed = 0;
            // ffprobe — секунда на ролик (у Alter Echo их 428): ответы прошлой сборки — по пути и размеру файла
            const probePath = path.join(path.dirname(this.indexPath(id)), 'gallery-probe.json');
            let probed = {};
            try { probed = JSON.parse(await fsp.readFile(probePath, 'utf8')) || {}; } catch { /* нет — спросим */ }
            const probedNow = {};
            const read = async (rel) => {
                const file = path.join(root, realFile(rel));
                try {
                    if (VIDEO.test(rel)) {
                        const st = await fsp.stat(file);
                        const k = probed[rel];
                        const info = Array.isArray(k) && k.length === 3 && k[0] === st.size ? { duration: k[1], audio: k[2] } : await this.probe(file);
                        if (!info) probeFailed++;
                        else probedNow[rel] = [st.size, info.duration, info.audio];
                        entries.set(rel, { w: 0, h: 0, size: st.size, video: true, loop: isLoop(info), audio: !!info?.audio });
                    } else {
                        const [head, st] = await Promise.all([readHead(file), fsp.stat(file)]);
                        entries.set(rel, { ...(pngSize(head) || { w: 0, h: 0 }), size: st.size, animated: isAnimated(head) });
                    }
                } catch (e) {
                    // Нечитаемый файл — в «Прочее»
                }
                job.done++;
            };
            // Заголовки — по 16 разом (у Freya's Potion Shop 25 000 картинок), ffprobe — по 3
            await pool(files.filter((rel) => !VIDEO.test(rel)), 16, read);
            await pool(files.filter((rel) => VIDEO.test(rel)), 3, read);
            if (Object.keys(probedNow).length) {
                await fsp.mkdir(path.dirname(probePath), { recursive: true });
                await fsp.writeFile(probePath, JSON.stringify(probedNow)).catch(() => {});
            } else await fsp.rm(probePath, { force: true });
            // События читаем один раз: и для размера экрана (масштаб картинок), и для сцен с альбомами
            const loaded = await this.readSources(root, spines.length > 0 || live2d.length > 0).catch(() => ({ ces: [], sources: [], advRefs: [] }));
            index.screen = await this.screenFor(root, entries, loaded.sources).catch(async () => screenOf(await this.system(root)));
            // Сколько картинки непрозрачно — только у тех, что иначе стали бы CG и умеют быть прозрачными. ffmpeg
            // на картинку — до секунды, а вариантов одной сцены бывает полторы сотни: меряем края альбома (и несколько
            // точек внутри большого), и если все по одну сторону порогов — остальным то же; разошлись — меряем каждую
            // Текстура модели — в её папке или во вложенной («model.4096/texture_00.png» у Live2D)
            const rigged = (rel) => { for (let d = path.posix.dirname(rel), k = 0; k < 3 && d.includes('/'); k++, d = path.posix.dirname(d)) if (rigs.has(d)) return true; return false; };
            const side = (e) => (e.opaque < OPAQUE_LAYER && e.cols < NARROW ? 0 : e.opaque < OPAQUE_BASE ? 1 : 2);
            const byAlbum = new Map();
            for (const [rel, e] of entries) {
                // Фон по имени тоже меряем: прозрачный — не фон (героиня в рост «battle_…», дымка «Effect_…»)
                const kind = classify(e, index.screen, rel);
                if (!e.alpha || rigged(rel) || !(kind === 'cg' || (kind === 'backdrop' && !inBackdropDir(rel)))) continue;
                const key = albumKey(rel);
                if (!byAlbum.has(key)) byAlbum.set(key, []);
                byAlbum.get(key).push([rel, e]);
            }
            // Замеры прошлой сборки — по пути и размеру файла: пересборка (новая версия оглавления) не мерит заново
            const opaquePath = path.join(path.dirname(this.indexPath(id)), 'gallery-opaque.json');
            let known = {};
            try { known = JSON.parse(await fsp.readFile(opaquePath, 'utf8')) || {}; } catch { /* нет — меряем */ }
            const measured = {};
            const measure = async ([rel, e]) => {
                if (e.opaque !== undefined) return;
                const k = known[rel];
                // Запись прошлой сборки: [размер, доля, ширина] и с недавних пор рамка (без рамки — её домерим, только если
                // картинка окажется основой врезки, ниже)
                const fresh = Array.isArray(k) && k[0] === e.size && typeof k[1] === 'number' && typeof k[2] === 'number';
                const m = fresh ? { share: k[1], cols: k[2], ...(k.length === 7 ? { box: k.slice(3) } : {}) }
                    : await this.opaqueShare(path.join(root, rel), root).catch(() => ({ share: 1, cols: 1, failed: true }));
                e.opaque = m.share;
                e.cols = m.cols;
                if (m.box) e.box = m.box;
                // Сбой ffmpeg (таймаут под нагрузкой) не запоминаем: в следующую сборку — замерим ещё раз
                if (!m.failed) measured[rel] = [e.size, e.opaque, e.cols, ...(m.box || (fresh ? [] : [0, 0, 1, 1]))];
            };
            const queue = [...byAlbum.values()];
            job.total += queue.length;
            // Замеры — фоном и с низким приоритетом: по одному на свободное ядро, но не меньше двух и не больше четырёх
            await Promise.all(Array.from({ length: Math.max(2, Math.min(4, os.cpus().length - 1)) }, async () => {
                for (let list; (list = queue.shift());) {
                    // Края, а в большом альбоме ещё шесть точек между ними (в одном имени бывают и CG, и прозрачные
                    // эффекты, и фигуры в рост — у The Last Lighthouse 525 картинок «ac_01»)
                    const picks = [...new Set([0, list.length - 1, ...(list.length > 8 ? [1, 2, 3, 4, 5, 6].map((k) => Math.round((k * (list.length - 1)) / 7)) : [])])];
                    const probes = picks.map((k) => list[k]);
                    for (const item of probes) await measure(item);
                    const es = probes.map(([, e]) => e);
                    // Все одного вида — остальным осторожная смесь замеров: меньшая доля, большая ширина (вид от этого не
                    // меняется: все замеры по одну сторону порогов)
                    // Только тем, что по размеру файла среди замеренных: в одном имени бывают и плотные фоны, и мелкие детали
                    // на пустом холсте («B6_I3_01_back» и «B6_I3_10_B3_ehe03» у Dragon Post Office) — деталь меряем сама
                    if (es.every((e) => side(e) === side(es[0]))) {
                        const mix = { opaque: Math.min(...es.map((e) => e.opaque)), cols: Math.max(...es.map((e) => e.cols)) };
                        const lo = 0.8 * Math.min(...es.map((e) => e.size)), hi = 1.25 * Math.max(...es.map((e) => e.size));
                        for (const item of list) {
                            const e = item[1];
                            if (e.opaque !== undefined) continue;
                            if (e.size >= lo && e.size <= hi) Object.assign(e, mix); else await measure(item);
                        }
                    } else for (const item of list) await measure(item);
                    job.done++;
                }
            }));
            const albums = new Map();
            const kindOf = new Map();
            const sizeOfFile = new Map();
            const albumOf = new Map();
            // Имена, под которыми лежат неподвижные картинки: движущиеся (APNG, GIF, WebP) с тем же именем — своим
            // альбомом «#loop»: иначе одна APNG делает «Анимацией» весь альбом (SevenKeys3 — 573 неподвижных в «Анимациях»)
            const stillNames = new Set();
            for (const [rel, entry] of entries) if (!entry.video && !entry.animated) stillNames.add(albumKey(rel));
            // Видеопетля с тем же именем («movies/ending.webm» рядом с «movies/ending.apng») — свой ключ «#loop» занят:
            // картинкам другой, иначе плеер получил бы видео и APNG в одном альбоме
            const videoLoopNames = new Set();
            for (const [rel, entry] of entries) if (entry.video && entry.loop) videoLoopNames.add(albumKey(rel));
            const splitNames = new Set();
            for (const [rel, entry] of entries) {
                const kind = rigged(rel) && !entry.video ? 'engine' : classify(entry, index.screen, rel);
                kindOf.set(rel, kind);
                // Петли и ролики-сцены из одной папки («movies/2.webm», «movies/3.webm» — один альбом по имени)
                // — разными альбомами: иначе альбом с одной сценой целиком ушёл бы в «Видео»
                const name = albumKey(rel);
                const moving = kind === 'animation' && !entry.video && stillNames.has(name);
                if (moving) splitNames.add(name);
                const key = name + (entry.video && entry.loop ? '#loop' : moving ? (videoLoopNames.has(name) ? '#img#loop' : '#loop') : '');
                sizeOfFile.set(rel, `${entry.w}x${entry.h}`);
                if (!albums.has(key)) albums.set(key, { key, kind, w: entry.w, h: entry.h, files: [] });
                const album = albums.get(key);
                album.files.push(rel);
                albumOf.set(rel, album);
                // Альбом — по самой «главной» картинке в нём: CG важнее персонажа, фона, слоя
                if (RANK[kind] > RANK[album.kind]) Object.assign(album, { kind, w: entry.w, h: entry.h });
            }
            // Папка позы: игра сама собирает героиню из деталей кодом (Ironhold Keep: «img/elena/toilet_sitting» — 707
            // прозрачных деталей на холсте во весь экран, 59 поз), и правильную стопку, не исполняя игру, не собрать. По
            // имени такие детали рассыпались бы на тысячи альбомов (у Elena — 11 922), а плотные (тело) попадали бы в CG.
            // Папка, где деталей на весь экран — POSE_MIN и больше и почти все прозрачные, — один альбом «Слои»
            const byDir = new Map();
            for (const [rel, e] of entries) {
                if (e.video) continue;
                const dir = path.posix.dirname(rel);
                if (!byDir.has(dir)) byDir.set(dir, []);
                byDir.get(dir).push(rel);
            }
            for (const [dir, rels] of byDir) {
                // Только вне img/pictures: оттуда картинки показывают события, и сцены из деталей там собираются склейками
                // («img/pictures/hcg/2» у Seven Keys); вне её детали ставит только код игры
                if (rels.length < POSE_MIN || /^img\/pictures(\/|$)/i.test(dir)) continue;
                const full = rels.filter((rel) => { const e = entries.get(rel); return e.w >= 0.95 * index.screen.w && e.h >= 0.95 * index.screen.h; });
                const clear = full.filter((rel) => kindOf.get(rel) === 'layer');
                if (full.length < 0.9 * rels.length || clear.length < 0.8 * rels.length) continue;
                const mine = new Set(rels);
                for (const [key, a] of [...albums]) if (a.files.every((f) => mine.has(f))) albums.delete(key);
                for (const a of albums.values()) a.files = a.files.filter((f) => !mine.has(f));
                for (const [key, a] of [...albums]) if (!a.files.length) albums.delete(key);
                const key = albums.has(dir) ? `${dir}#pose` : dir;
                const pose = { key, kind: 'layer', pose: true, w: index.screen.w, h: index.screen.h, files: rels };
                albums.set(key, pose);
                for (const rel of rels) { kindOf.set(rel, 'layer'); albumOf.set(rel, pose); }
            }
            // Номер из четырёх цифр и больше — сцена и кадр («r0106» у Loretta's Brand New Job: сцена 01, кадр 06; по
            // имени все 122 были одним альбомом «r»): альбом от NUM_SPLIT картинок делим по номеру без двух последних
            // цифр. Раскадровка («CG0001…CG0300» — кадры подряд) остаётся целой
            for (const [key, a] of [...albums]) {
                if (a.files.length < NUM_SPLIT || a.kind === 'video' || a.kind === 'engine' || a.pose) continue;
                const parts = new Map();
                let ok = true;
                for (const rel of a.files) {
                    const m = /^(.*?)(\d{4,})([a-z]?)$/i.exec(path.posix.basename(rel).replace(IMAGE, ''));
                    if (!m) { ok = false; break; }
                    // «#loop» остаётся в конце ключа: по нему клиент и сборка узнают петлю
                    const sub = `${path.posix.dirname(rel)}/${m[1]}${m[2].slice(0, -2)}${key.endsWith('#loop') ? '#loop' : ''}`;
                    if (!parts.has(sub)) parts.set(sub, []);
                    parts.get(sub).push(rel);
                }
                if (!ok || parts.size < 2 || isFrameSequence(a.files, (f) => sizeOfFile.get(f) || `${entries.get(f)?.w}x${entries.get(f)?.h}`)) continue;
                albums.delete(key);
                for (const [sub, files] of parts) {
                    const top = files.map((f) => kindOf.get(f)).reduce((x, y) => (RANK[y] > RANK[x] ? y : x));
                    const e = entries.get(files.find((f) => kindOf.get(f) === top));
                    const part = { key: albums.has(sub) ? `${sub}#` : sub, kind: top, w: e.w, h: e.h, files };
                    albums.set(part.key, part);
                    for (const f of files) albumOf.set(f, part);
                }
            }
            // Огромный альбом по имени (больше BIG картинок: «ac_01» у The Last Lighthouse — 525, «actor01» у Hollow Spire —
            // 1876) — это не сцена, а целый набор: делим по следующей части имени («ac_01_bats53», «actor01_cutin»), пока
            // он большой и в частях выходит хотя бы по три картинки
            for (let round = 0; round < 2; round++) {
                for (const [key, a] of [...albums]) {
                    if (a.files.length <= BIG || a.kind === 'video' || a.kind === 'engine' || a.pose) continue;
                    const loopSfx = key.endsWith('#loop') ? '#loop' : '';
                    const stem = path.posix.basename(key).replace(/#loop$/, '');
                    const parts = new Map();
                    for (const rel of a.files) {
                        const name = bareName(path.posix.basename(rel));
                        const rest = name.startsWith(stem) ? name.slice(stem.length) : '';
                        const m = /^([_\-\s.@]+)([^_\-\s.@]+)[_\-\s.@]+\S/.exec(rest);
                        const sub = m ? `${key.slice(0, key.length - loopSfx.length)}${m[1]}${m[2]}${loopSfx}` : key;
                        if (!parts.has(sub)) parts.set(sub, []);
                        parts.get(sub).push(rel);
                    }
                    if (parts.size < 2 || a.files.length / parts.size < 3) continue;
                    albums.delete(key);
                    for (const [sub, files] of parts) {
                        const kinds = files.map((f) => kindOf.get(f));
                        const top = kinds.reduce((x, y) => (RANK[y] > RANK[x] ? y : x));
                        const e = entries.get(files.find((f) => kindOf.get(f) === top));
                        const part = { key: albums.has(sub) ? `${sub}#` : sub, kind: top, w: e.w, h: e.h, files };
                        albums.set(part.key, part);
                        for (const f of files) albumOf.set(f, part);
                    }
                }
            }
            // Огромный альбом, который по именам не поделился («Renamed_files_42…507» у Agent Vega — 411 разных CG): делим
            // по рисунку. Файлы переименовывали по порядку, так что кадры одной сцены стоят рядом: режем ряд там, где
            // соседние картинки перестают быть похожими (отпечатки dHash, запоминаются в gallery-hash.json)
            const hashPath = path.join(path.dirname(this.indexPath(id)), 'gallery-hash.json');
            let hashKnown = null;
            const hashSeen = {};
            const collate = new Intl.Collator('en', { numeric: true });
            for (const [key, a] of [...albums]) {
                if (a.files.length <= BIG || !['cg', 'layer', 'other'].includes(a.kind) || a.pose || isFrameSequence(a.files, (f) => sizeOfFile.get(f))) continue;
                if (hashKnown === null) { try { hashKnown = JSON.parse(await fsp.readFile(hashPath, 'utf8')) || {}; } catch { hashKnown = {}; } }
                const files = [...a.files].sort(collate.compare);
                const at = new Map(files.map((f, i) => [f, i]));
                const hashes = [];
                await pool(files, Math.max(2, Math.min(4, os.cpus().length - 1)), async (rel) => {
                    const size = entries.get(rel)?.size || 0;
                    const k = hashKnown[rel];
                    const h = Array.isArray(k) && k[0] === size ? k[1] : await this.dhash(path.join(root, rel), root).catch(() => null);
                    if (h) hashSeen[rel] = [size, h];
                    hashes[at.get(rel)] = h;
                });
                const dist = (x, y) => { if (!x || !y) return 64; let v = BigInt(`0x${x}`) ^ BigInt(`0x${y}`), n = 0; while (v) { n += Number(v & 1n); v >>= 1n; } return n; };
                const runs = [[files[0]]];
                for (let i = 1; i < files.length; i++) {
                    const same = sizeOfFile.get(files[i]) === sizeOfFile.get(files[i - 1]) && dist(hashes[i], hashes[i - 1]) <= DHASH_NEAR;
                    if (same) runs[runs.length - 1].push(files[i]); else runs.push([files[i]]);
                }
                if (runs.length < 2 || runs.length > files.length * 0.9) continue;
                albums.delete(key);
                runs.forEach((list, n) => {
                    const top = list.map((f) => kindOf.get(f)).reduce((x, y) => (RANK[y] > RANK[x] ? y : x));
                    const e = entries.get(list.find((f) => kindOf.get(f) === top));
                    const part = { key: `${key}#${n + 1}`, kind: top, w: e.w, h: e.h, files: list };
                    albums.set(part.key, part);
                    for (const f of list) albumOf.set(f, part);
                });
            }
            if (hashKnown !== null) await fsp.writeFile(hashPath, JSON.stringify(hashSeen)).catch(() => {});
            // События: сцены из слоёв и группы картинок, которые показывает одно событие
            let built = { albums: [], frames: {}, groups: [], pics: new Map(), used: new Set(), shownRels: new Set(), stillRels: new Set(), vscenes: [], ascenes: [], wholeIds: new Set(), spineScenes: [], l2dScenes: [] };
            try {
                const partial = new Set([...entries].filter(([, e]) => e.opaque < OPAQUE_BASE).map(([rel]) => rel));
                built = await this.buildSceneAlbums(root, index.screen, kindOf, loaded, partial, entries, await this.audioOf(id), spines.map((x) => x.skeleton), live2d.map((x) => ({ model: x.model, name: x.name, via: x.via, tags: x.tags, def: x.def, motions: x.motions.map((m) => ({ name: m.name, group: m.group, i: m.i, base: m.base, mname: m.mname })), exps: x.exps.map((e) => e.name) })));
            } catch (e) {
                console.warn(`[Галерея] ${id}: сцены из событий не собрались: ${e.message}`);
            }
            // Альбом события — сцена так, как её видит игрок: готовые картинки по порядку показа. Кадр из слоёв (основа,
            // лицо, одежда, эффекты — так собирают CG 97 игр из 99) — склейкой «@cg/…»; целая картинка — файлом, если по
            // имени она ни с чем не сложилась («01», «02», … у Clockwork Vale 2). Общий фон или портрет, который показывают
            // многие события, остаётся в своём разделе. Одна и та же картинка — у одного события (см. «кому что достаётся»)
            const lower = (n) => String(n).toLowerCase();
            // В скольких событиях картинка на главной ветке: больше трёх — общий фон или портрет
            const usesOf = new Map();
            for (const [n, k] of built.uses || []) usesOf.set(lower(n), (usesOf.get(lower(n)) || 0) + k);
            const parts = new Set();       // слои поверх основы: сами по себе не CG
            const bases = new Set();       // основы склеек: они уже в альбоме события — со слоями поверх
            const byEvent = [];
            const scripts = new Map();    // ключ альбома события → сценарий для плеера (картинки — файлами альбома)
            // Сцены-панели (galleryScenes.panelStack: стопки деталей без CG) — альбомом события, только если распознавание
            // уверенно видит сцену хоть в одном кадре; до ответа — ничего не меняем, а три кадра (начало, середина, конец)
            // откладываем ему на пробу (index.visionProbe). Портрет с лицом поверх так и останется в «Персонажах»
            const visionKnown = await this.visionRead(id);
            const probes = [];
            // Рамка непрозрачного у картинки: по ней видно, где на экране стоит фигура. Рамка с прошлой сборки (по пути и
            // размеру файла): панелей и их деталей сотни, ffmpeg на каждую — зря
            const measureBox = async (rel) => {
                const e = entries.get(rel);
                const k = known[rel];
                if (Array.isArray(k) && k.length === 7 && k[0] === e.size) { e.box = k.slice(3); measured[rel] = k; return; }
                const m = await this.opaqueShare(path.join(root, rel), root).catch(() => null);
                if (!m || m.failed || !m.box) return;
                e.box = m.box;
                measured[rel] = [e.size, e.opaque, e.cols, ...m.box];
            };
            const needsBox = (rel) => { const e = rel && entries.get(rel); return !!e && e.alpha && !e.box && !(e.opaque >= OPAQUE_BASE); };
            const canvasPic = (e) => e && e.w >= 0.95 * index.screen.w && e.h >= 0.95 * index.screen.h;
            // Где на экране стоят фигуры кадра панели (пикселы): основа вместе с деталями, эффект на весь экран окна не
            // задаёт. Фигуры — полосы по x, что не касаются друг друга (двое в разговоре: слева и справа). null — чего-то
            // не знаем (рамки нет, масштаб, кадр листа): тогда ничего не решаем
            const figures = (layers) => {
                const spans = [];
                let [y0, y1] = [Infinity, -Infinity];
                for (const [i, l] of layers.entries()) {
                    const le = entries.get(l.rel);
                    if (!le || l.cell || l.o || Number(l.zx ?? 100) !== 100 || Number(l.zy ?? 100) !== 100) return null;
                    const box = le.box || (le.alpha && !(le.opaque >= OPAQUE_BASE) ? null : [0, 0, 1, 1]);
                    if (!box) return null;
                    if (i && box[2] - box[0] >= 0.9 && box[3] - box[1] >= 0.9) continue;
                    spans.push([(Number(l.x) || 0) + box[0] * le.w, (Number(l.x) || 0) + box[2] * le.w]);
                    y0 = Math.min(y0, (Number(l.y) || 0) + box[1] * le.h); y1 = Math.max(y1, (Number(l.y) || 0) + box[3] * le.h);
                }
                if (!spans.length) return null;
                spans.sort((p, q) => p[0] - q[0]);
                const bands = [spans[0].slice()];
                for (const [x0, x1] of spans.slice(1)) { const last = bands[bands.length - 1]; if (x0 <= last[1]) last[1] = Math.max(last[1], x1); else bands.push([x0, x1]); }
                return { bands, y0: Math.max(0, y0), y1: Math.min(index.screen.h, y1) };
            };
            // Портрет разговора — фигура в рост у нижнего края экрана и узкая (до TALK_W ширины): стоит рядом с окном
            // сообщения («NewTolinaL0Base» + слои, «Lloyd-Right-Base», «LH6» у Clockwork Vale 2); двое в разговоре — две такие
            // фигуры порознь. Сцена-панель шире: тело и то, что с ним делают. И основа кадра — в TALK_EVENTS событиях и
            // больше: разговаривающий персонаж есть в десятках событий, а узкая сцена («SH-Back-L0-Man») — в паре. Сначала
            // меряем основы, и только у узких — детали на весь холст. Фигура целиком в кадре, с запасом сверху: CG, что
            // занимает экран от края до края («hcg/16/Male_0» у Seven Keys, 440×720), — не портрет
            const panelPics = built.groups.filter((g) => g.panel).flatMap((g) => (g.finished || []).map((item) => item.layers
                && item.layers.map((l) => ({ ...l, rel: built.pics.get(lower(l.name)) || '' })).filter((l) => l.rel)).filter((layers) => layers && layers.length >= 2));
            await pool([...new Set(panelPics.map((layers) => layers[0].rel))].filter(needsBox), 3, measureBox);
            const narrowBase = (layers) => { const e = entries.get(layers[0].rel); return !!e && !!e.box && (e.box[2] - e.box[0]) * e.w <= TALK_W * index.screen.w; };
            await pool([...new Set(panelPics.filter(narrowBase).flatMap((layers) => layers.slice(1).map((l) => l.rel)).filter((rel) => canvasPic(entries.get(rel))))].filter(needsBox), 3, measureBox);
            const baseEvents = new Map();
            for (const g of built.groups) {
                if (!g.panel) continue;
                for (const item of g.finished || []) {
                    const rel = item.layers && built.pics.get(lower(item.layers[0].name));
                    if (rel) { if (!baseEvents.has(rel)) baseEvents.set(rel, new Set()); baseEvents.get(rel).add(g); }
                }
            }
            const oldTalking = (layers) => {
                if ((baseEvents.get(layers[0].rel)?.size || 0) < TALK_EVENTS || !narrowBase(layers)) return false;
                const f = figures(layers);
                return !!f && f.bands.every(([x0, x1]) => x1 - x0 <= TALK_W * index.screen.w) && f.y1 - f.y0 >= TALK_H * index.screen.h && f.y1 >= 0.98 * index.screen.h && f.y0 >= 0.02 * index.screen.h;
            };
            // Стоящая у нижнего края основа высотой от 0,4 экрана: у такого кадра меряем все детали без рамки, а не только
            // холст во весь экран — широкий спрайт (в рост, но шире TALK_W) тоже портрет, если фигура узкая
            const standingBase = (layers) => {
                const e = entries.get(layers[0].rel);
                const r = e && e.box && !layers[0].cell && placedRect(layers[0], e, e.box);
                return !!r && Math.min(index.screen.h, r[3]) >= 0.98 * index.screen.h && Math.min(index.screen.h, r[3]) - Math.max(0, r[1]) >= 0.4 * index.screen.h;
            };
            // Рамки этих деталей нужны только для суда о портрете: в e.box их не кладём (по ним считается обрезка, и кадры
            // панелей сжались бы по новым рамкам, а прежнее правило портрета дало бы другой ответ — и решения по группам, что
            // держатся на нём, поплыли бы), а запоминаем рядом в том же файле замеров под ключом «talk:файл»
            const talkBoxes = new Map();
            const measureTalk = async (rel) => {
                const e = entries.get(rel);
                if (!e || e.box) return;
                const k = known[`talk:${rel}`];
                let box = Array.isArray(k) && k.length === 5 && k[0] === e.size ? k.slice(1) : null;
                if (!box) { const m = await this.opaqueShare(path.join(root, rel), root).catch(() => null); box = m && !m.failed && m.box ? m.box : null; }
                if (!box) return;
                talkBoxes.set(rel, box);
                measured[`talk:${rel}`] = [e.size, ...box];
            };
            await pool([...new Set(panelPics.filter((layers) => narrowBase(layers) || standingBase(layers)).flatMap((layers) => layers.slice(1).map((l) => l.rel)))].filter(needsBox), 3, measureTalk);
            const talkEntries = { get: (rel) => { const e = entries.get(rel); return e && !e.box && talkBoxes.has(rel) ? { ...e, box: talkBoxes.get(rel) } : e; } };
            // Семья картинки — имя без номера, холст и рамка: тело с лицами одного персонажа. Говорит тот, чья семья есть в
            // TALK_EVENTS событиях панелей и больше; «hero» из пары событий — сцена
            const rectBox = (e) => e.box || (!e.alpha || e.opaque >= OPAQUE_BASE ? [0, 0, 1, 1] : null);
            const famOf = (rel) => { const e = talkEntries.get(rel); const b = e && rectBox(e); return b ? `${albumKey(rel)}|${e.w}x${e.h}|${b.join(',')}` : null; };
            const fam = new Map();
            for (const g of built.groups) {
                if (!g.panel) continue;
                for (const item of g.finished || []) {
                    const ls = item.layers && item.layers.map((l) => built.pics.get(lower(l.name))).filter(Boolean);
                    if (!ls || ls.length < 2) continue;
                    for (const rel of ls) { const k = famOf(rel); if (!k) continue; if (!fam.has(k)) fam.set(k, new Set()); fam.get(k).add(g); }
                }
            }
            // Портрет по фигурам кадра (рост, ширина, место — см. talkFigures) или по прежнему правилу. Ошибка в новой части — не
            // портрет: сборка из-за неё не падает
            const talkMemo = new Map();
            const talking = (layers) => {
                const h = cgHash(layers);
                if (talkMemo.has(h)) return talkMemo.get(h);
                let r = oldTalking(layers);
                if (!r) {
                    try {
                        const figs = talkFigures(layers, talkEntries, index.screen);
                        r = !!figs && figs.length >= 1 && figs.every((f) => talkFigure(f, index.screen) && (fam.get(famOf(f.base))?.size || 0) >= TALK_EVENTS);
                    } catch { r = false; }
                }
                talkMemo.set(h, r);
                return r;
            };
            // Файлы портретов разговора: из альбомов по имени они уходят в «Слои» (см. очистку ниже), а не остаются CG
            const talkParts = new Set(panelPics.filter(talking).flatMap((layers) => layers.map((l) => l.rel)));
            const talkOf = new Map();       // группа → её кадры, что новое правило признало портретами (прежнее — нет)
            // Группы-разговоры, которые фильтр убрал из CG: все кадры — портреты по новому или прежнему правилу, стоячий портрет,
            // а также группа, у которой новое правило признало портретами часть кадров, а оставшиеся распознавание не взяло
            // (стоячие спрайты «19セックスバック»: сегодня они в CG не остаются). Их сценарии не пропадают, а становятся
            // альбомами «dialogue» без своих картинок (ниже). Прежние портреты среди кадров, которые держит распознавание, —
            // не повод: такая группа не разговор
            const talkBranch = new Set();
            const groupsBefore = built.groups;
            built.groups = built.groups.filter((g) => {
                if (!g.panel) return true;
                // Основа панели — с четверть экрана и больше: полоска интерфейса с искоркой поверх — не сцена
                const big = (layers) => { const e = entries.get(layers[0].rel); return e && e.w * e.h * Math.abs(Number(layers[0].zx ?? 100) * Number(layers[0].zy ?? 100)) / 1e4 >= 0.25 * index.screen.w * index.screen.h; };
                const all = (g.finished || []).map((item) => item.layers && item.layers.map((l) => ({ ...l, rel: built.pics.get(lower(l.name)) || '' })).filter((l) => l.rel))
                    .filter((layers) => layers && layers.length >= 2 && big(layers));
                const frames = all.filter((layers) => !talking(layers));
                talkOf.set(g, all.filter((layers) => talking(layers) && !oldTalking(layers)).map(cgHash));
                // Все кадры — портреты разговора: не сцена, что бы ни ответило распознавание
                if (!frames.length) { if (all.length) talkBranch.add(g); return false; }
                // Стоячий портрет с выражениями («托莉娜立绘+表情»: кукла 405×600 без лица) — не сцена, что бы ни ответило
                // распознавание: имя события или основы называет его портретом. Основы смотрим и у новых портретов (кадры без
                // прежних портретов, как и было): «tachie» в имени основы закрывает группу, хоть портрет и новый
                // Исключение: поверх куклы лежит вставка сцены из другой папки («cutin/…» на «tachie/…») того же размера холста или
                // больше, с четверть экрана и больше. Кукла там осталась от разговора под вставкой — судит распознавание, а не имя
                // основы. Мелкая деталь куклы (лицо, выражение, значок) вставкой не считается
                const dirOf = (rel) => path.posix.dirname(rel);
                const coverOver = (layers) => { const b = entries.get(layers[0].rel); return !!b && layers.slice(1).some((l) => { const e = entries.get(l.rel); return e && dirOf(l.rel) !== dirOf(layers[0].rel) && e.w >= b.w && e.h >= b.h && e.w * e.h >= 0.25 * index.screen.w * index.screen.h; }); };
                const byBase = all.filter((layers) => !oldTalking(layers)).some((layers) => STANDING.test(layers[0].rel));
                if (STANDING.test(g.title) || /\bstanding\b/i.test(g.title) || (!all.some(coverOver) && byBase)) { talkBranch.add(g); return false; }
                // Распознавание ответило «не сцена»: если группу называла портретом основа (вставку поверх отдали распознаванию) или
                // большинство её кадров — портреты, это разговор, а не мусор. Сценарий не бросаем, а оставляем диалогом
                // (три кадра без портрета среди сорока — пауза, фон — не делают разговор сценой)
                const notScene = () => { if (byBase || frames.length * 2 < all.length) talkBranch.add(g); return false; }
                // В альбом — те же кадры, что судили (по склейке целиком, с найденными файлами)
                const kept = new Set(frames.map(cgHash));
                g.finished = g.finished.filter((item) => {
                    if (!item.layers) return true;
                    const layers = item.layers.map((l) => ({ ...l, rel: built.pics.get(lower(l.name)) || '' })).filter((l) => l.rel);
                    return layers.length >= 2 && kept.has(cgHash(layers));
                });
                const scoreOf = (layers) => visionKnown[this.visionKey(`${CG_PREFIX}${cgHash(layers)}`, 0, layers)];
                if (frames.some((layers) => scoreOf(layers) >= VISION_PROMOTE)) return true;
                // Поручительство: группу сегодня держит сцена-кадр, который теперь портрет, а оставшиеся кадры ещё не оценены —
                // группа остаётся, пока распознавание не ответит про оставшиеся (нечем отвечать — остаётся)
                const vouched = all.some((layers) => !frames.includes(layers) && !oldTalking(layers) && scoreOf(layers) >= VISION_PROMOTE)
                    && frames.some((layers) => scoreOf(layers) === undefined);
                // Распознавать нечем — и пробовать нечего
                if (!this.vision.available) return vouched;
                const picks = [...new Set([0, Math.floor(frames.length / 2), frames.length - 1])].map((k) => frames[k]).filter(Boolean);
                if (!picks.length) return notScene();
                if (picks.every((layers) => scoreOf(layers) !== undefined)) {
                    // Три кадра дали «нет», но у склеек одной сцены оценка скачет (тело+лицо без эффекта — 0,5, с эффектом — 0,97):
                    // оставшиеся кадры, которых не судили, проверяем тоже, и группа решается по всем. Ответили все — группа не сцена
                    const rest = frames.filter((layers) => !picks.includes(layers) && scoreOf(layers) === undefined).slice(0, PROBE_REST);
                    if (!rest.length) return notScene();
                    if (probes.flat().length >= PROBE_MAX * 3) return false;
                    for (const layers of rest) built.frames[cgHash(layers)] = layers;
                    probes.push(rest.map((layers) => `${CG_PREFIX}${cgHash(layers)}`));
                    return vouched;
                }
                // Проб на игру — не больше PROBE_MAX: каждая — склейка и распознавание, а портретов разговора бывают сотни. Все —
                // за один проход и одну пересборку (по 40 за раз пересборки шли десятками подряд); остальные — в следующую
                if (probes.flat().length >= PROBE_MAX * 3) return vouched;
                for (const layers of picks) built.frames[cgHash(layers)] = layers;
                probes.push(picks.map((layers) => `${CG_PREFIX}${cgHash(layers)}`));
                return vouched;
            });
            const survivors = new Set(built.groups);
            const talkDropped = groupsBefore.filter((g) => !survivors.has(g) && g.script && (talkBranch.has(g) || (talkOf.get(g) || []).length));
            const leftTalk = new Set(built.groups.flatMap((g) => talkOf.get(g) || []));
            // Что событие кладёт в альбом: склейку или целую картинку
            const entryOf = (item) => {
                let name = item.name;
                if (item.layers) {
                    const layers = item.layers.map((l) => ({ ...l, rel: built.pics.get(lower(l.name)) || '' })).filter((l) => l.rel);
                    // Кадр листа анимации — склейкой и в одиночку: целым файлом был бы весь лист
                    if (layers.length >= 2 || layers[0]?.cell) { const h = cgHash(layers); return { key: h, file: `${CG_PREFIX}${h}`, layers, alt: item.alt }; }
                    if (!layers.length) return null;
                    name = layers[0].name;
                }
                const rel = built.pics.get(lower(name));
                const a = rel && albumOf.get(rel);
                if (!a || built.used.has(rel) || !['cg', 'layer', 'other'].includes(a.kind) || (usesOf.get(lower(name)) || 0) > 3) return null;
                return { key: rel, file: rel, album: a, alt: item.alt };
            };
            // at — номер кадра в g.finished: по нему снимки со страницей (g.shots) находят свой файл в альбоме
            const items = built.groups.map((g) => (g.finished || []).map((it, at) => { const e = entryOf(it); return e && { ...e, at }; }).filter(Boolean));
            // Снимки с параллельной страницей: какой файл альбома события чем заменить — в самом конце сборки
            const shotPlan = new Map();      // ключ альбома → Map(файл → { files, plain })
            // Картинка шага сценария — тот же файл, что у этого кадра в альбоме. Кадра, которого в альбоме нет (кадры
            // анимации ушли во «Анимации», картинку показывают и другие сцены), — тоже: плеер показывает сцену как в игре,
            // а не одни её CG. Склейку записываем в описание склеек — её нарисуют по запросу, как кадры альбома
            // decor — склейка нужна только движению сценария (кадр анимации, экран у затемнения): такие склейки меряем после
            // остальных, чтобы их основы не меняли обрезку склеек альбомов. Склейку, которую вызвал и обычный шаг, это не касается
            const decorFrames = new Set();
            // Бледная картинка шага сценария (затемнение, переход между CG: composeFrames, faint) — склейкой с тем, что под ней,
            // иначе плеер показал бы её во всю яркость. Только когда она ложится на экран (±2 %): сдвинутую и увеличенную
            // оставляем целым файлом, чтобы затемнение не прыгало между рамками. Альбом событий её файл не меняет
            const faintFile = (item) => {
                const rel = built.pics.get(lower(item.name));
                const e = rel && entries.get(rel);
                if (!e || !e.w || !e.h) return rel;
                const r = placedRect(item.faint[item.faint.length - 1], e, [0, 0, 1, 1]);
                const { w, h } = index.screen;
                if (!r || Math.abs(r[0]) > 0.02 * w || Math.abs(r[1]) > 0.02 * h || Math.abs(r[2] - w) > 0.02 * w || Math.abs(r[3] - h) > 0.02 * h) return rel;
                const layers = item.faint.map((l) => ({ ...l, rel: built.pics.get(lower(l.name)) || '' }));
                if (layers.some((l) => !l.rel)) return rel;
                const hash = cgHash(layers);
                if (!built.frames[hash]) built.frames[hash] = layers;
                return `${CG_PREFIX}${hash}`;
            };
            // force — склейка и из одного слоя без листа (картинка под роликом, не по размеру экрана)
            // peek — только назвать файл, склейку не записывать (кадры сцен, которые, возможно, никому не достанутся)
            const stepFile = (item, decor = false, force = false, peek = false) => {
                if (!item.layers && item.faint) return peek ? '' : faintFile(item);
                if (!item.layers) return built.pics.get(lower(item.name));
                const layers = item.layers.map((l) => ({ ...l, rel: built.pics.get(lower(l.name)) || '' })).filter((l) => l.rel);
                if (!layers.length || (!force && layers.length < 2 && !layers[0]?.cell)) return layers[0]?.rel;
                const h = cgHash(layers);
                if (peek) return `${CG_PREFIX}${h}`;
                if (!built.frames[h]) { built.frames[h] = layers; if (decor) decorFrames.add(h); } else if (!decor) decorFrames.delete(h);
                return `${CG_PREFIX}${h}`;
            };
            // Шаги сценария с готовыми картинками → шаги с файлами. Одно место на все альбомы со сценарием (альбом события,
            // альбом по имени): новый вид шага с картинками дописывают сюда
            // Картинка под видимым роликом (at — её место на экране игры) ложится на экран склейкой из одного слоя, если файл
            // не по размеру экрана или стоит не на месте: ролик и картинка тогда в одной рамке. Нет картинки (null) — none
            const fits = (rel, at) => { const e = entries.get(rel); return !!e && e.w === index.screen.w && e.h === index.screen.h && !at.x && !at.y && !at.o && at.zx === 100 && at.zy === 100 && at.op === 255; };
            const picOf = (x) => {
                if (!x.item) return { k: 'pic', none: true };
                const rel = x.at && !x.item.layers && !x.item.faint ? built.pics.get(lower(x.item.name)) : null;
                if (rel && !fits(rel, x.at)) return { k: 'pic', f: stepFile({ layers: [{ name: x.item.name, ...x.at }] }, true, true) };
                // geo — место целой картинки на экране игры, только в сценариях со Spine: из него после обрезок выйдет box
                return { k: 'pic', f: stepFile(x.item, x.decor), ...(x.item.geo ? { g: x.item.geo } : {}) };
            };
            const stepsOf = (script) => script.map((x) => (x.k === 'pic' ? picOf(x)
                : x.k === 'anim' ? { k: 'anim', f: x.items.map((it) => stepFile(it, true)), d: x.d, loop: x.loop, ...(x.r ? { r: x.r } : {}), ...(x.x ? { x: x.x } : {}), ...(x.s ? { s: x.s } : {}) }
                : x.k === 'vid' ? { k: 'vid', v: x.v.map(({ own, ...v }) => v) } : x));
            // Целая картинка — в альбом события, если по имени она ни с чем не сложилась, или если альбом по имени
            // слишком широк: его картинки показывают разные события («hm0111…hm2811» у Mira's Potion Shop — все сцены героини
            // одним именем). Тогда сцены — по событиям, а не по имени
            const shownBy = new Map();
            items.forEach((list, gi) => { for (const e of list) if (e.album && !e.alt) { if (!shownBy.has(e.album)) shownBy.set(e.album, new Set()); shownBy.get(e.album).add(gi); } });
            // Остаётся в альбоме по имени: альбом в несколько картинок, и на главной ветке его показывает одна эта сцена.
            // Своего альбома сцене тогда может не достаться — её сценарий получит этот альбом (nameScenes ниже)
            const wholeByName = (e) => !!e.album && e.album.files.length !== 1 && (shownBy.get(e.album)?.size || 0) < 2;
            // Файл сценария — одна сцена от начала до конца (ветвей и меню выбора сцен в нём нет): его целые картинки — все
            // ему, иначе сцена делится между альбомом события и альбомом по имени без сценария. Только если реплик не меньше,
            // чем картинок: «просмотрщик CG» без реплик чужие альбомы по имени целиком не забирает. Такой группе keptByName
            // пуст, и сцена по имени (nameScenes) её не трогает — у альбома не бывает двух сценариев
            const whole = (g) => !!built.wholeIds?.has(g.id) && (g.script || []).filter((x) => x.k === 'say').length >= (g.finished || []).length;
            const plans = items.map((list, gi) => (whole(built.groups[gi]) ? list : list.filter((e) => !wholeByName(e))));
            // Что фильтр оставил альбомам по имени — запоминаем сейчас: раздача ниже меняет альбомы
            const keptByName = items.map((list, gi) => list.filter((e) => !e.alt && wholeByName(e) && !plans[gi].includes(e)));
            // Кому что достаётся: сначала картинки главных веток всех событий, потом варианты из других веток (меню выбора
            // сцены перебирает в ветках чужие картинки — они остаются у своей сцены). Событию досталась одна целая картинка
            // — это не альбом: разбираем заново без него
            const dead = new Set();
            let owner = new Map();
            const claim = () => {
                owner = new Map();
                for (const pass of [false, true]) {
                    plans.forEach((plan, gi) => { if (!dead.has(gi)) for (const e of plan) if (!!e.alt === pass && !owner.has(e.key)) owner.set(e.key, gi); });
                }
            };
            const mineOf = (gi) => plans[gi].filter((e) => owner.get(e.key) === gi);
            const thin = (gi) => { const mine = mineOf(gi); return mine.length < 2 && !mine.some((e) => e.layers); };
            for (let round = 0; round < 8; round++) {
                claim();
                const more = plans.map((_, gi) => gi).filter((gi) => !dead.has(gi) && thin(gi));
                if (!more.length) break;
                for (const gi of more) dead.add(gi);
            }
            claim();
            // Все картинки главной ветки события достались одному другому событию (картинка принадлежит первому): номер
            // этого события, иначе −1. У события без картинок вообще (всё ушло в альбомы по имени) хозяина нет. Общая одна
            // картинка или одна склейка (портрет героини, фон комнаты, врезка) — не сцена: нужны две картинки и больше и у
            // события, и у альбома хозяина, иначе на чужой альбом из одной склейки повесили бы десять разговоров
            const lateOwner = (gi) => {
                const main = plans[gi].filter((e) => !e.alt);
                const own = new Set(main.map((e) => owner.get(e.key)));
                const [one] = own;
                return own.size === 1 && one !== undefined && one !== gi && main.length >= 2 && mineOf(one).length >= 2 ? one : -1;
            };
            const eventKey = new Map();     // номер события → ключ его альбома
            const homeless = [];
            built.groups.forEach((g, gi) => {
                // Событие без своего альбома, у которого есть сцена из роликов, — гость альбома ролика (проход i07-B ниже)
                if (dead.has(gi) || thin(gi)) {
                    if (g.script && g.vscene) homeless.push({ gi, id: g.id, title: g.title, script: g.script, ...g.vscene });
                    // Группа, у которой новое правило признало портретами часть кадров, а своего альбома после этого не осталось, —
                    // тоже разговор (стоячие спрайты «19セックスバック»); сцены из роликов остаются гостями, а не диалогами
                    else if (g.script && (talkOf.get(g) || []).length) talkDropped.push(g);
                    // Сцена с анимацией или позднее событие (все его картинки уже в альбоме более раннего): тоже гость — альбома
                    // анимации, где крутятся её кадры, или альбома раннего события (проход i07-B ниже)
                    else if (g.script) {
                        const late = lateOwner(gi);
                        const lines = g.ascene || late >= 0 ? scenes.readable(g.script) : 0;
                        if (lines >= scenes.ASCENE_LINES) homeless.push({ gi, id: g.id, title: scenes.guestTitle(g.title, g.script), script: g.script, lines, core: scenes.sayLines(g.script), at: g.srcAt, named: g.srcNamed, ...(g.ascene ? { anim: true } : {}), ...(late >= 0 ? { late } : {}) });
                    }
                    return;
                }
                const files = [];
                for (const e of mineOf(gi)) {
                    if (e.layers) {
                        built.frames[e.key] = e.layers;
                        bases.add(e.layers[0].rel);
                        for (const l of e.layers.slice(1)) parts.add(l.rel);
                    } else {
                        // Из альбома по имени уходит только эта картинка; ушли все — альбома нет
                        e.album.files = e.album.files.filter((f) => f !== e.file);
                        if (!e.album.files.length) e.album.taken = true;
                    }
                    files.push(e.file);
                }
                // panel — сцена-панель, уже признанная распознаванием: обратно «экраном» её не считаем
                const key = `events/${String(gi).padStart(5, '0')}/${g.title.replace(/\//g, '∕')}`;
                if (g.shots && !g.panel) {
                    const plan = new Map();
                    for (const [at, list, plain] of g.shots) {
                        const e = mineOf(gi).find((x) => x.at === at);
                        const shot = e && list.map((it) => stepFile(it)).filter((f) => f && f !== e.file);
                        if (shot && shot.length) plan.set(e.file, { files: [...new Set(shot)], plain });
                    }
                    if (plan.size) shotPlan.set(key, plan);
                }
                eventKey.set(gi, key);
                byEvent.push({ key, kind: 'cg', w: index.screen.w, h: index.screen.h,
                    files, ordered: true, ...(g.panel ? { panel: true } : {}) });
                if (g.script) scripts.set(key, stepsOf(g.script));
            });
            // Сцена со сценарием без своего альбома, чьи целые картинки остались в альбоме по имени (keptByName): «Смотреть
            // сцену» — у этого альбома. Решаем в конце, после распознавания: альбом могли слить, опустошить, признать экраном
            const nameScenes = new Map();     // альбом по имени → номер сцены; на главной ветке его показывает только она
            built.groups.forEach((g, gi) => {
                if (!g.script || !(dead.has(gi) || thin(gi))) return;
                for (const e of keptByName[gi]) if (!nameScenes.has(e.album)) nameScenes.set(e.album, gi);
            });
            // Картинки, которых не показывает ни одно событие (вырезанные и запасные варианты: «0155», «0156» лежат
            // между показанными «0154» и «0157»), — в альбом события, где есть соседний номер, рядом с соседом
            const numbered = (rel) => { const m = /^(.*?)(\d+)\.[^./]+$/.exec(rel); return m ? { stem: m[1], n: Number(m[2]) } : null; };
            const near = new Map();       // «папка/приставка:номер» → альбом события
            const addNear = (rel, album) => { const x = numbered(rel); if (x && !near.has(`${x.stem}:${x.n}`)) near.set(`${x.stem}:${x.n}`, album); };
            for (const ev of byEvent) for (const f of ev.files) addNear(f.startsWith(CG_PREFIX) ? built.frames[f.slice(CG_PREFIX.length)]?.[0]?.rel || '' : f, ev);
            const lonely = [...albums.values()]
                .filter((a) => !a.taken && a.kind === 'cg' && a.files.length === 1 && !built.shownRels.has(a.files[0]) && numbered(a.files[0]))
                .sort((x, y) => numbered(x.files[0]).n - numbered(y.files[0]).n);
            for (const a of lonely) {
                const { stem, n } = numbered(a.files[0]);
                const after = near.has(`${stem}:${n - 1}`);
                const ev = near.get(`${stem}:${after ? n - 1 : n + 1}`);
                if (!ev) continue;
                // После соседа с меньшим номером, иначе перед соседом с большим — тем самым, по которому выбрали альбом
                const want = after ? n - 1 : n + 1;
                const at = ev.files.findIndex((f) => { const x = numbered(f.startsWith(CG_PREFIX) ? built.frames[f.slice(CG_PREFIX.length)]?.[0]?.rel || '' : f); return x && x.stem === stem && x.n === want; });
                ev.files.splice(at < 0 ? ev.files.length : after ? at + 1 : at, 0, a.files[0]);
                a.taken = true;
                addNear(a.files[0], ev);
            }
            // Событие с одной склейкой, чья основа — основа большого альбома события («---Watch "…"» у Dragon Post Office: меню
            // повтора показывает первый кадр сцены) — не свой альбом, а кадр той сцены
            const baseOf = (f) => (f.startsWith(CG_PREFIX) ? built.frames[f.slice(CG_PREFIX.length)]?.[0]?.rel || '' : '');
            // Основа — только одной большой сцены: общий фон комнаты под разными сценами — не повод сливать
            const bigByBase = new Map();
            for (const ev of byEvent) if (ev.files.length >= 2) for (const b of new Set(ev.files.map(baseOf))) if (b) bigByBase.set(b, bigByBase.has(b) && bigByBase.get(b) !== ev ? null : ev);
            for (let k = byEvent.length - 1; k >= 0; k--) {
                const ev = byEvent[k];
                if (ev.files.length !== 1 || ev.panel) continue;
                const host = bigByBase.get(baseOf(ev.files[0]));
                if (!host || host === ev) continue;
                if (!host.files.includes(ev.files[0])) host.files.push(ev.files[0]);
                byEvent.splice(k, 1);
            }
            // Ролики-петли сцен — уже в «Анимациях» своей сцены
            for (const rel of built.looped || []) { kindOf.set(rel, 'animation'); const a = albumOf.get(rel); if (a) a.files = a.files.filter((f) => f !== rel); }
            for (const [key, a] of [...albums]) if (!a.files.length) albums.delete(key);
            // Кадры анимаций из событий — только в «Анимациях», основы склеек — только в альбоме события: из альбомов
            // по имени их убираем (иначе та же сцена ещё раз в CG, по картинке без лица и одежды)
            // Фон под склейкой остаётся в «Фонах»: убираем только основы-CG
            for (const [key, a] of [...albums]) {
                if (a.taken || a.kind === 'engine' || a.kind === 'video') continue;
                a.files = a.files.filter((f) => !built.used.has(f) && !(bases.has(f) && kindOf.get(f) !== 'backdrop'));
                if (!a.files.length) albums.delete(key);
            }
            // Детали, которые ушли в склейки, — не CG: альбом из одних деталей — «Слои», смешанный — делим. Прозрачные
            // детали в альбоме CG по имени — тоже (у Dragon Post Office в «B6_I3» плотный фон и лица на пустом холсте: в CG они
            // были белыми карточками с крошкой посередине); кроме раскадровки — её кадры остаются вместе
            for (const a of [...albums.values()]) {
                if (a.taken || a.kind === 'engine' || a.kind === 'video') continue;
                // Тела и лица портретов разговора (их кадры ушли из CG) — тоже детали: раскадровку считаем без них, иначе набор
                // «MM0…MM17» стал бы альбомом CG из одних тел
                const talkOwn = a.kind === 'cg' ? a.files.filter((f) => talkParts.has(f)) : [];
                const loose = a.kind === 'cg' && !isFrameSequence(a.files.filter((f) => !talkOwn.includes(f)), (f) => sizeOfFile.get(f));
                const own = a.files.filter((f) => kindOf.get(f) !== 'animation' && (parts.has(f) || talkOwn.includes(f) || (loose && kindOf.get(f) === 'layer')));
                if (!own.length) continue;
                if (own.length === a.files.length) { a.kind = 'layer'; continue; }
                const gone = new Set(own);
                a.files = a.files.filter((f) => !gone.has(f));
                albums.set(`${a.key}#parts`, { key: `${a.key}#parts`, kind: 'layer', w: a.w, h: a.h, files: own });
            }
            const collator = new Intl.Collator('en', { numeric: true });
            const fileOf = (f) => (f.startsWith(CG_PREFIX) ? built.frames[f.slice(CG_PREFIX.length)]?.[0]?.rel || '' : f);
            // Одинаковые файлы под разными именами (английская и японская копии одной CG — у Saint Lantern 276 из 603):
            // один раз. Сравниваем только файлы одного размера — читать приходится немногие. Остаётся тот, что показывает
            // игра, иначе первый по имени
            const inScenes = new Set([...byEvent.flatMap((a) => a.files.map(fileOf)), ...built.used, ...bases, ...parts]);
            const bySize = new Map();
            for (const [rel, e] of entries) {
                if (e.video || e.size < 4096 || !['cg', 'layer'].includes(kindOf.get(rel))) continue;
                if (!bySize.has(e.size)) bySize.set(e.size, []);
                bySize.get(e.size).push(rel);
            }
            const dropped = new Set();
            const keeperOf = new Map();
            const sameAs = new Map();      // копия по байтам → оставленная (в том числе показанная событием)
            let budget = DEDUPE_BYTES;
            // Отпечаток: начало и конец файла (по 64 КБ) — разные картинки одного размера на них уже расходятся; целиком
            // читаем только совпавшие (у Freya's Potion Shop полторы тысячи кадров одного размера — читали все целиком)
            const hashOf = async (rel, whole) => {
                const size = entries.get(rel).size;
                const n = whole ? size : Math.min(DEDUPE_SAMPLE, size);
                budget -= whole ? size : 2 * n;
                const fh = await fsp.open(path.join(root, realFile(rel)), 'r');
                try {
                    const h = crypto.createHash('sha1');
                    const buf = Buffer.alloc(n);
                    await fh.read(buf, 0, n, 0);
                    h.update(buf);
                    if (!whole) { await fh.read(buf, 0, n, size - n); h.update(buf); }
                    return h.digest('hex');
                } finally {
                    await fh.close();
                }
            };
            for (const list of bySize.values()) {
                if (list.length < 2 || budget < 0) continue;
                const bySample = new Map();
                for (const rel of list) {
                    if (budget < 0) break;
                    const h = await hashOf(rel, false).catch(() => rel);
                    if (!bySample.has(h)) bySample.set(h, []);
                    bySample.get(h).push(rel);
                }
                for (const same of bySample.values()) {
                    if (same.length < 2 || budget < 0) continue;
                    const first = new Map();
                    for (const rel of same.sort((x, y) => (inScenes.has(y) - inScenes.has(x)) || collator.compare(x, y))) {
                        if (budget < entries.get(rel).size) break;
                        const h = await hashOf(rel, true).catch(() => rel);
                        const keeper = first.get(h);
                        if (!keeper) first.set(h, rel);
                        // Имена различаются только номером («Eve_49_0001» и «Eve_49_0013») — это кадр, повторённый в
                        // своей анимации (игра держит его дольше): не повтор
                        else if (frameStem(rel) !== frameStem(keeper)) {
                            sameAs.set(rel, keeper);
                            if (!inScenes.has(rel)) { dropped.add(rel); keeperOf.set(rel, keeper); }
                        }
                    }
                }
            }
            // Папка-копия (img/F_pictures у Tidecaller — та же img/pictures байт в байт): альбом, каждая картинка которого —
            // единственная копия одноимённой картинки одного другого альбома, и тот альбом показывают сцены, а этот — нет.
            // Тогда весь альбом-копия уходит, а картинки того альбома остаются целиком (и те, что сцены не показывают):
            // иначе часть копий осталась бы по имени, и сцена была бы и в альбоме сцены, и в альбоме-копии
            {
                const copiesOf = new Map();
                for (const [rel, k] of sameAs) { if (!copiesOf.has(k)) copiesOf.set(k, []); copiesOf.get(k).push(rel); }
                const pairOf = new Map();
                for (const [k, list] of copiesOf) if (list.length === 1) { pairOf.set(k, list[0]); pairOf.set(list[0], k); }
                const base = (f) => path.posix.basename(f).toLowerCase();
                for (const a of albums.values()) {
                    if (a.taken || a.files.length < 2 || ['engine', 'video'].includes(a.kind)) continue;
                    const pairs = a.files.map((f) => pairOf.get(f));
                    if (pairs.some((x, i) => !x || base(x) !== base(a.files[i]))) continue;
                    const other = new Set(pairs.map((x) => albumOf.get(x)));
                    if (other.size !== 1 || other.has(a) || other.has(undefined)) continue;
                    if (a.files.some((f) => inScenes.has(f)) || !pairs.some((x) => inScenes.has(x))) continue;
                    a.files.forEach((f, i) => {
                        const x = pairs[i];
                        if (dropped.has(x) && keeperOf.get(x) === f) { dropped.delete(x); keeperOf.delete(x); sameAs.delete(x); }
                        dropped.add(f); keeperOf.set(f, x); sameAs.set(f, x);
                    });
                }
            }
            // Повтор картинки из другого альбома уходит из альбома в несколько картинок, только если повторён весь альбом
            // (врезка другой героини с тем же партнёром): иначе в анимации по номерам появились бы дыры. Копии внутри
            // одного альбома (английская и японская одной CG) уходят всегда
            for (const a of albums.values()) {
                if (a.files.length < 2 || a.files.every((f) => dropped.has(f))) continue;
                for (const f of a.files) if (dropped.has(f) && albumOf.get(keeperOf.get(f)) !== a) dropped.delete(f);
            }
            for (const [key, a] of [...albums]) {
                if (a.taken || !dropped.size) continue;
                a.files = a.files.filter((f) => !dropped.has(f));
                if (!a.files.length) albums.delete(key);
            }
            // Копии одной картинки на разных языках («card-ja-JP», «card-zh-CN», «card-en-US»; «1406» и «1406_zh-CN» — Clockwork Vale 2:
            // шесть карточек в трёх языках): одна картинка, по именам они разных альбомов. Иначе распознавание судит каждую
            // отдельно (0.76, 0.65, 0.08 у одной карточки): одни копии остаются в CG, другие уходят в «Прочее». Остаётся
            // английская, нет её — без языка в имени, иначе первая по имени. В альбоме события копия заменяется оставленной
            // на том же месте. Язык — наверняка, только если он с регионом («-ja-JP») или языков у картинки хотя бы два:
            // одиночное «_de» или «_es» бывает и не языком, а «card» и «card_es» одного размера — разными картинками.
            // Другого размера копия бывает (корейская сцена выше остальных: 1440×840 при 1440×810) — такую берём, только если
            // язык в её имени наверняка: с регионом или языков у картинки хотя бы три. «face_it» и «face_de» другого размера —
            // скорее позы, а «title» без языка рядом с «title_en» — другая картинка
            const localeDup = new Set();
            const LOCALE = /[-_.](?:ja|jp|zh|cn|tw|tc|en|ko|kr|ru|de|fr|es|pt|it)(?:[-_](?:JP|CN|TW|US|GB|KR|RU|DE|FR|ES|BR|Hans|Hant))?$/i;
            const localeOf = (rel) => {
                const bare = bareName(path.posix.basename(rel));
                const m = LOCALE.exec(bare);
                return { stem: `${path.posix.dirname(rel)}/${m ? bare.slice(0, m.index) : bare}`.toLowerCase(), loc: m ? m[0] : '' };
            };
            const localeGroups = new Map();
            for (const a of [...byEvent, ...albums.values()]) {
                if (a.taken || a.anim || ['engine', 'video'].includes(a.kind)) continue;
                for (const f of a.files) {
                    if (f.startsWith(CG_PREFIX) || VIDEO.test(f)) continue;
                    const { stem, loc } = localeOf(f);
                    if (!localeGroups.has(stem)) localeGroups.set(stem, new Map());
                    localeGroups.get(stem).set(f, loc);
                }
            }
            const localeKeeper = new Map();      // копия → оставленная
            for (const group of localeGroups.values()) {
                if (group.size < 2 || ![...group.values()].some(Boolean)) continue;
                const locs = [...group.values()].filter(Boolean);
                const langs = new Set(locs.map((l) => l.slice(1, 3).toLowerCase())).size;
                if (!locs.some((l) => l.length > 3) && langs < 2) continue;
                const rank = (f) => (/^[-_.]en/i.test(group.get(f)) ? 0 : group.get(f) ? 2 : 1);
                const [keeper, ...rest] = [...group.keys()].sort((x, y) => rank(x) - rank(y) || collator.compare(x, y));
                const anySize = (f) => group.get(f).length > 3 || (group.get(f) && langs >= 3);
                for (const f of rest) {
                    if (!anySize(f) && sizeOfFile.get(f) !== sizeOfFile.get(keeper)) continue;
                    localeKeeper.set(f, keeper);
                    localeDup.add(f);
                }
            }
            if (localeKeeper.size) {
                const keepers = new Set(localeKeeper.values());
                const inEvents = new Set();
                for (const ev of byEvent) {
                    ev.files = [...new Set(ev.files.map((f) => localeKeeper.get(f) || f))];
                    for (const f of ev.files) inEvents.add(f);
                }
                for (const [key, a] of [...albums]) {
                    if (a.taken) continue;
                    a.files = a.files.filter((f) => !localeKeeper.has(f) && !(inEvents.has(f) && keepers.has(f)));
                    if (!a.files.length) albums.delete(key);
                }
            }
            // Копия по байтам в альбоме события («1406» и «1406_zh-CN» у Clockwork Vale 2 — одна карточка) уходит, если оставленная
            // стоит в том же альбоме: событие показывает обе, и в плитке они были бы дважды
            for (const ev of byEvent) {
                const have = new Set(ev.files);
                ev.files = ev.files.filter((f) => !(sameAs.has(f) && have.has(sameAs.get(f)) && localeDup.add(f)));
            }
            // Одиночки — CG, у которых не нашлось пары ни в событиях, ни по имени: дособираем
            const single = (a) => !a.taken && !a.anim && a.kind === 'cg' && a.files.length === 1 && !a.files[0].startsWith('movies/');
            // 1) Остальные варианты той же CG (то же имя без номера) ушли в альбом одного события — туда же, после соседа
            const keyEvents = new Map();
            for (const ev of byEvent) {
                for (const f of ev.files) {
                    const r = fileOf(f);
                    if (!r) continue;
                    const k = albumKey(r);
                    if (!keyEvents.has(k)) keyEvents.set(k, new Set());
                    keyEvents.get(k).add(ev);
                }
            }
            for (const a of albums.values()) {
                if (!single(a)) continue;
                const f = a.files[0];
                const k = albumKey(f);
                const evs = keyEvents.get(k);
                if (!evs || evs.size !== 1) continue;
                const ev = [...evs][0];
                let at = -1;
                ev.files.forEach((x, i) => { const r = fileOf(x); if (r && albumKey(r) === k && collator.compare(r, f) < 0) at = i; });
                ev.files.splice(at < 0 ? ev.files.length : at + 1, 0, f);
                a.taken = true;
            }
            // 2) Папка сцены («14 娼婦ダンス/…», «服装店/第一次用/…»): одиночки папки — к её единственному альбому, иначе вместе.
            // Не верхняя папка (img/pictures, img/CG — там все сцены)
            const merge = (groups, host) => {
                for (const { key, list } of groups.values()) {
                    const to = host(key);
                    if (!to && list.length < 2) continue;
                    const target = to || { key, kind: 'cg', w: list[0].w, h: list[0].h, files: [] };
                    for (const a of list) {
                        if (a === target) continue;
                        target.files.push(...a.files);
                        a.taken = true;
                    }
                    if (!to) albums.set(albums.has(key) ? `${key}#` : key, target);
                }
            };
            const own = (a) => !a.taken && !a.anim && a.kind === 'cg' && a.files.length > 1;
            const dirOf = (a) => path.posix.dirname(a.files[0]);
            // Регистр в именах не важен («_cena_2», «_Cena_X»): имя альбома — по первой картинке
            const groupBy = (keyOf) => {
                const out = new Map();
                for (const a of albums.values()) {
                    if (!single(a)) continue;
                    const k = keyOf(a);
                    if (!k) continue;
                    if (!out.has(k.toLowerCase())) out.set(k.toLowerCase(), { key: k, list: [] });
                    out.get(k.toLowerCase()).list.push(a);
                }
                return out;
            };
            merge(groupBy((a) => (dirOf(a).split('/').length >= 3 ? dirOf(a) : null)), (dir) => {
                const hosts = [...albums.values()].filter((x) => own(x) && x.files.every((f) => path.posix.dirname(f) === dir));
                return hosts.length === 1 ? hosts[0] : null;
            });
            // 3) Общее начало имени — персонаж с эмоциями («Aldos_bebado», «Aldos_Feliz»), слои одной сцены
            // («event-air_bj-hair0», «event-air_bj-steam»): без последней части имени, потом без двух — если начало ещё из двух частей
            const parent = (rel, drop) => {
                const bits = path.posix.basename(rel).replace(IMAGE, '').split(/([_\-\s.@]+)/);
                const keep = bits.length - 2 * drop;
                if (keep < (drop > 1 ? 3 : 1) || !/\p{L}{2}/u.test(bits.slice(0, keep).join(''))) return null;
                return `${path.posix.dirname(rel)}/${bits.slice(0, keep).join('')}`;
            };
            for (const drop of [1, 2]) {
                merge(groupBy((a) => parent(a.files[0], drop)), (key) => {
                    const x = albums.get(key);
                    return x && own(x) ? x : null;
                });
            }
            for (const [key, a] of [...albums]) if (a.taken && !byEvent.includes(a)) albums.delete(key);
            // Что так и осталось по одной, — одним альбомом «Без сцены» в конце, по порядку имён: не сотни плиток вперемешку со сценами
            const loose = [...albums].filter(([, a]) => single(a));
            if (loose.length >= 3) {
                for (const [key] of loose) albums.delete(key);
                albums.set('loose', { key: 'loose', kind: 'cg', loose: true, w: index.screen.w, h: index.screen.h, files: loose.map(([, a]) => a.files[0]) });
            }
            // Порядок — как в игре: по имени первой картинки альбома (авторы нумеруют CG по сюжету: «01», «02», …
            // «ev012»), у склейки — по её основе. Сначала img/pictures (там CG), потом свои папки плагинов, заставки
            // — в конце, ролики movies/ — следом
            // У альбома события — по первой картинке, которая не общий фон: фон («back/Ivent_Bedroom») лежит под сценами
            // из разных мест сюжета, и по нему они перемешались бы с фонами по алфавиту
            const baseIn = new Map();
            for (const ev of byEvent) for (const f of new Set(ev.files.map(fileOf))) baseIn.set(f, (baseIn.get(f) || 0) + 1);
            const ownOf = (f) => {
                if (!f.startsWith(CG_PREFIX)) return f;
                const layers = built.frames[f.slice(CG_PREFIX.length)] || [];
                const own = layers.find((l) => kindOf.get(l.rel) !== 'backdrop' && (baseIn.get(l.rel) || 0) < 3);
                return (own || layers[0])?.rel || '';
            };
            const firstOf = (a) => a.files.map(a.ordered ? ownOf : fileOf).filter(Boolean).sort(collator.compare)[0] || a.key;
            const group = (rel) => (rel.startsWith('img/pictures/') ? 0 : /^img\/titles/i.test(rel) ? 2 : rel.startsWith('movies/') ? 3 : 1);
            const framesListed = await this.listedFrames(root, entries);
            index.albums = [...byEvent, ...[...albums.values()].filter((a) => !a.taken), ...built.albums]
                .map(({ taken, ordered, ...a }) => {
                    // Альбом события и анимация — в порядке показа в игре; остальные — по имени
                    const sorted = ordered || a.anim ? a.files : a.files.sort(collator.compare);
                    // Кадры подряд по именам — анимация, если события не показывают большую часть этих картинок под
                    // репликами: иначе судим по событию (варианты одежды «LH0…LH11» и страницы сцены — не анимация; боевые
                    // врезки, которые бой крутит без реплик, и петля, у которой под репликой стоит первый кадр, — анимация)
                    const listed = framesListed.some((set) => sorted.every((f) => set.has(f)));
                    // Альбом, от которого отделили «#loop», — не раскадровка, если кадры не перечислил плагин
                    const seq = !ordered && !a.anim && ['cg', 'layer', 'other'].includes(a.kind) && sorted.filter((f) => built.stillRels.has(f)).length * 2 <= sorted.length
                        && (listed || !sorted.some((f) => splitNames.has(albumKey(f)))) && isFrameSequence(sorted, (f) => sizeOfFile.get(f), listed);
                    // Обложка альбома — первая картинка его раздела, а не прозрачный слой
                    // audio — в альбоме есть ролик со звуком: плеер анимаций крутит ролики без звука, а у петель событий звук
                    // бывает (Sky Knight Chronicles — 191 из 210), и его можно включить
                    const audio = sorted.some((f) => entries.get(f)?.audio);
                    return { ...a, ...(audio ? { audio: true } : {}), files: sorted, cover: a.cover || sorted.find((f) => kindOf.get(f) === a.kind) || sorted[0], ...(seq ? { anim: true, fps: 8 } : {}), first: firstOf({ ...a, ordered }) };
                })
                .sort((a, b) => (!!a.loose - !!b.loose) || group(a.first) - group(b.first) || collator.compare(a.first, b.first) || collator.compare(a.key, b.key));
            // Сцены, у которых «своя» картинка общая с другими (врезки Ember & Frost — одни и те же части в десятках
            // сцен), по именам не упорядочить — имена ничего не говорят о сюжете. Тогда сцены встают на свои места в порядке
            // событий игры (у Paradise он совпадает с номерами сцен в названиях: 123, 152, 213, 217…)
            const evAt = index.albums.map((a, i) => (a.key.startsWith('events/') ? i : -1)).filter((i) => i >= 0);
            if (evAt.length >= 4 && new Set(evAt.map((i) => index.albums[i].first)).size < 0.7 * evAt.length) {
                const inOrder = evAt.map((i) => index.albums[i]).sort((a, b) => collator.compare(a.key, b.key));
                evAt.forEach((i, k) => { index.albums[i] = inOrder[k]; });
            }
            index.albums = index.albums.map(({ first, ...a }) => a);
            // Spine: один альбом на набор, кадр — одна анимация скелета («файл#имя»); обложка — первая страница атласа.
            // Файлы набора не в альбомах, но отдаются плееру (spineFile) — перечень в spineFiles
            for (const x of spines) {
                index.albums.push({ key: `${x.rel === '.' || !x.rel ? '' : `${x.rel}/`}${x.stem}`, kind: 'animation', w: 0, h: 0, spine: { atlas: x.atlas, skeleton: x.skeleton, pages: x.pages, version: x.version }, files: x.animations.map((n) => `${x.skeleton}#${n}`), cover: x.pages[0] });
            }
            if (spineFiles.size) index.spineFiles = [...spineFiles];
            // Live2D: кадр — одно движение модели («файл.model3.json#имя»), обложка — первый лист текстуры (в плитке — кадр, снятый
            // при первом просмотре, как у Spine: лист текстуры — части тела вперемешку). Файлы моделей и ядро не в альбомах,
            // но отдаются плееру (live2dFile) — перечень в live2dFiles. exps/motions: [имя, группа, номер] в model3.json
            for (const x of live2d) {
                index.albums.push({
                    key: `${x.rel ? `${x.rel}/` : ''}${x.stem}`, kind: 'animation', w: 0, h: 0,
                    live2d: { model: x.model, moc: x.moc, core: x.core, coreMoc: x.coreMoc, ...(x.name ? { name: x.name } : {}), motions: x.motions.map((m) => [m.name, m.group, m.i]), exps: x.exps.map((e) => e.name) },
                    files: x.motions.map((m) => `${x.model}#${m.name}`), cover: x.textures[0],
                });
            }
            if (live2dFiles.size) index.live2dFiles = [...live2dFiles];
            // Экраны игры по рисунку (galleryVision.js): альбом CG, где ни один кадр не похож на сцену, — во «Всё». Ответы —
            // из прошлого распознавания; чего нет, распознается фоном после сборки. Кадры — те же, что смотрит проход: уже
            // в итоговом порядке альбома
            let visionMissing = probes.length;
            if (probes.length) index.visionProbe = probes;
            for (const a of index.albums) {
                if (a.kind !== 'cg' || a.anim || a.panel) continue;
                const scores = this.visionSamples(a).map((rel) => {
                    const layers = rel.startsWith(CG_PREFIX) ? built.frames[rel.slice(CG_PREFIX.length)] : null;
                    return visionKnown[this.visionKey(rel, layers ? 0 : entries.get(rel)?.size || 0, layers)];
                });
                // Хоть один кадр похож на сцену (или его не прочитать) — сцена; иначе нужны ответы по всем кадрам
                if (scores.some((x) => x !== undefined && (x >= VISION_SCENE || x === VISION_FAILED))) continue;
                if (scores.some((x) => x === undefined)) { visionMissing++; continue; }
                a.kind = 'other';
                a.screen = true;
            }
            // Кадры альбома события, под которыми шла параллельная страница, которую включила сцена: снимок экрана с ней
            // (врезка с петлёй под ней, комната с героиней). Всё остальное — кому что досталось, порядок, обложка,
            // распознавание — уже решено по кадрам самой сцены, как без страниц: здесь меняются только файлы альбома.
            // plain — кадр видели и без страницы: он остаётся первым
            for (const a of index.albums) {
                const plan = shotPlan.get(a.key);
                if (!plan || a.panel) continue;
                a.files = [...new Set(a.files.flatMap((f) => { const s = plan.get(f); return s ? [...(s.plain ? [f] : []), ...s.files] : [f]; }))];
                const c = a.cover && plan.get(a.cover);
                if (c && !c.plain) a.cover = c.files[0];
            }
            // Раздача сцен альбомам после распознавания: каждый проход в своём try/catch, общий реестр hosted (номер сцены →
            // ключ альбома, куда её отдали). Порядок проходов: сначала i12 (альбомы по имени), следующие — после него.
            const hosted = new Map();
            const framesBefore = new Set(Object.keys(built.frames));
            // Сценарий сцены — её альбому по имени (nameScenes). Альбомы не меняются: только флаг script и файл сценария.
            // Ошибка здесь — без этих сценариев, остальная сборка как была
            if (nameScenes.size) {
                try {
                    const alive = new Set(albums.values());
                    // Ключ → альбом оглавления; два альбома с одним ключом (слияние «key#») — не знаем, который наш
                    const finalOf = new Map();
                    for (const a of index.albums) finalOf.set(a.key, finalOf.has(a.key) ? null : a);
                    // Картинку сравниваем по имени, как её зовёт команда (путь в img/pictures без расширения): копии «x.png» и
                    // «x.rpgmvp» — одна картинка. Не из img/pictures — команды её не показывают
                    const nameOf = (rel) => (rel.startsWith('img/pictures/') ? rel.slice('img/pictures/'.length).replace(IMAGE, '').toLowerCase() : '');
                    // Целая картинка шага — по имени, без записи склеек (stepFile записывает склейку — для отказа это лишнее)
                    const wholeName = (item) => {
                        if (!item) return '';
                        if (!item.layers) return lower(item.name);
                        const layers = item.layers.filter((l) => built.pics.has(lower(l.name)));
                        return layers.length === 1 && !layers[0].cell ? lower(layers[0].name) : '';
                    };
                    const picItems = scenes.shownItems;
                    // Имя целой картинки → сцены, у которых она в кадрах (любая ветка) или названа: варианты сцены и чужие показы
                    const showers = new Map();
                    items.forEach((list, gj) => {
                        for (const e of list) {
                            const n = !e.layers && nameOf(e.file);
                            if (n) { if (!showers.has(n)) showers.set(n, new Set()); showers.get(n).add(gj); }
                        }
                    });
                    // Остановка плеера: реплика с текстом (scene() пустые окна и одни коды «\M[…]» пропускает) или выбор. Без
                    // остановок плеер сразу в конце сцены — кнопка была бы пустой
                    const visible = (x) => x.k === 'choice'
                        || (x.k === 'say' && (!!scenes.speech(x.l || [], x.n || '', x.v || {}).text || (x.l || []).some((l) => /\\n\[\d+\]/i.test(l))));
                    // Результат копим и применяем после цикла: ошибка на середине даёт «всё или ничего», не зависит от порядка
                    const given = [];
                    for (const [album, gi] of nameScenes) {
                        const a = !album.taken && alive.has(album) ? finalOf.get(album.key) : null;
                        if (!a || a.kind !== 'cg' || a.anim || a.screen || a.loose || a.panel || a.spine || scripts.has(a.key) || given.some((x) => x[0] === a.key)) {
                            continue;
                        }
                        const g = built.groups[gi];
                        const shown = new Set(g.script.flatMap(picItems).map(wholeName).filter(Boolean));
                        const main = new Set(items[gi].filter((e) => !e.alt && !e.layers).map((e) => nameOf(e.file)));
                        // Картинку альбома, под которой сцена крутит анимацию с кадрами из другого альбома («Анимации»), шаг сценария
                        // не называет: показ — это сама анимация. Для неё картинки главной ветки сцены считаем показанными
                        const albumNames = new Set(a.files.map(nameOf));
                        const covered = g.script.some((x) => x.k === 'anim' && !picItems(x).some((it) => albumNames.has(wholeName(it))));
                        if (covered) for (const n of main) if (albumNames.has(n)) shown.add(n);
                        // Картинка альбома для этой сцены — как в раздаче выше (главная ветка важнее варианта): mine — её
                        // показывает шаг сценария; own — она у сцены на главной ветке (или названа), потом — только в других
                        // ветках сцены, если на главной её не показывает никто; foreign — её показывают другие события: на
                        // главной ветке (usesOf) или в любой ветке другой сцены (повтор в комнате воспоминаний, меню выбора).
                        // Кого не показывает никто — ничья
                        let mine = 0, own = 0, foreign = 0;
                        for (const n of a.files.map(nameOf)) {
                            if (!n) continue;
                            if (shown.has(n)) mine++;
                            else if (main.has(n)) own++;
                            else if ((usesOf.get(n) || 0) >= 1) foreign++;
                            else if (showers.get(n)?.has(gi)) own++;
                            else if (showers.has(n)) foreign++;
                        }
                        // Сцена — хозяйка альбома: показывает его картинки, у неё их больше, чем у всех других событий вместе
                        // (поровну — альбом общий, кнопка была бы у одной из сцен наугад), и плееру есть где остановиться
                        const ok = mine >= 1 && mine + own > foreign && g.script.some(visible);
                        if (ok) given.push([a.key, gi, stepsOf(g.script), a, g.title]);
                    }
                    for (const [key, gi, steps, a, title] of given) {
                        scripts.set(key, steps);
                        if (!hosted.has(gi)) hosted.set(gi, key);
                        // Альбом по имени файла («CG/hm0111») зовётся по файлу — вкладке «Сцены» нужно название сцены из игры
                        if (title) a.title = title;
                    }
                } catch (e) {
                    console.warn(`[Галерея] ${id}: сценарии альбомов по имени: ${e.message}`);
                }
            }
            // Сцены из одних роликов (i07-B): гости альбома анимации или ролика, где лежат их ролики. Кандидаты — события без
            // группы (analyze.vscenes) и группы, которым не достался альбом (g.vscene). Тем же проходом — сцены с анимацией
            // (analyze.ascenes и группы без альбома, у которых кадры — анимация): гости альбома, где крутятся их кадры, и
            // позднее событие, чьи картинки целиком в альбоме более раннего, — гость этого альбома (у него может быть своя
            // сцена, она тогда идёт первой). Реестр hosted не даёт отдать сцену
            // второй раз: группу, чей сценарий уже получил альбом по имени (проход выше), здесь пропускаем. Следующий проход
            // (Spine) — после этого. Ошибка здесь гостей отменяет целиком, альбомы остаются как были
            const guests = new Map();
            try {
                const lines = (steps) => steps.filter((x) => x.k === 'say').map((x) => JSON.stringify(x.l));
                const inside = (x, y) => { if (!x.length || x.length > y.length) return false; for (let i = 0; i + x.length <= y.length; i++) { let k = 0; while (k < x.length && x[k] === y[i + k]) k++; if (k === x.length) return true; } return false; };
                const vidsOf = (steps) => new Set(steps.flatMap((x) => (x.k === 'vid' ? x.v.map((v) => v.f) : [])));
                // Кадры анимаций сценария — файлы альбома или склейки; без записи склеек (сцена может никому не достаться)
                const framesOf = (script) => [...new Set(script.flatMap((x) => (x.k === 'anim' && !x.par && Array.isArray(x.items) ? x.items.map((it) => stepFile(it, true, false, true)) : [])).filter(Boolean))];
                // Сцену уже играет альбом (события или по имени): её реплики — подряд внутри его сценария, это не меньше
                // половины его реплик, и её ролики там есть (событие зовёт её и добавляет пару реплик)
                const played = [...scripts.values()].map((x) => ({ seq: lines(x), vids: vidsOf(x) })).filter((x) => x.seq.length);
                for (const x of played) x.set = new Set(x.seq);
                const hosts = index.albums.filter((a) => !a.key.startsWith('events/') && !a.spine && !a.live2d && (a.kind === 'animation' || a.kind === 'video') && !scripts.has(a.key));
                const holder = new Map();
                hosts.forEach((a, k) => { for (const f of a.files) if (VIDEO.test(f) && !holder.has(f)) holder.set(f, []); for (const f of a.files) if (holder.has(f)) holder.get(f).push(k); });
                // Кадры анимаций из событий (не петли страниц «#par»): файл → хозяева-анимации, где он лежит
                const frameHolder = new Map();
                hosts.forEach((a, k) => { if (a.anim && !a.key.endsWith('#par')) for (const f of a.files) { if (!frameHolder.has(f)) frameHolder.set(f, []); frameHolder.get(f).push(k); } });
                // Та же сцена в двух событиях (копия в комнате воспоминаний с вопросом «посмотреть?», то же событие на двух
                // картах): реплики под её роликами (core) одной — подряд внутри другой, короче не больше чем вдвое, и своих
                // роликов у меньшей нет сверх тех, что у большей. Из копий — та, где меньше реплик вокруг сцены
                const sub = (x, y) => x.every((f) => y.includes(f));
                // Сцена без роликов (анимация, позднее событие) — копия по репликам: кадры у копии могут сложиться иначе, а
                // «воспоминание» из комнаты воспоминаний теряет или меняет пару реплик посередине — подряд внутри чужой сцены
                // оно уже не лежит. Копия — когда общих разных реплик не меньше четырёх пятых у более длинной сцены (половина —
                // уже другая сцена с тем же началом: вторая половина её собственная)
                const framed = (c) => c.anim || c.late !== undefined;
                const alike = (x, y) => { const a = x instanceof Set ? x : new Set(x), b = y instanceof Set ? y : new Set(y); let n = 0; for (const l of a) if (b.has(l)) n++; return n >= 2 && n * 5 >= Math.max(a.size, b.size) * 4; };
                const same = (x, y) => { const [m, n] = x.core.length <= y.core.length ? [x, y] : [y, x]; return framed(m) || framed(n) ? alike(m.set || m.core, n.set || n.core) : m.core.length * 2 >= n.core.length && inside(m.core, n.core) && sub(m.own, n.own); };
                const reps = [];
                let already = 0;
                const anims = (built.ascenes || []).map((c) => ({ ...c, anim: true }));
                for (const c of [...(built.vscenes || []), ...anims, ...homeless].sort((x, y) => (x.at ?? 0) - (y.at ?? 0))) {
                    if (c.gi !== undefined && hosted.has(c.gi)) { already++; continue; }
                    // Кадры сцены с анимацией — её собственные «ролики» для сравнения копий
                    if (!c.own) c.own = c.anim ? framesOf(c.script) : [];
                    if (framed(c)) c.set = new Set(c.core);
                    // Сцену с анимацией и позднее событие узнаём по репликам: кадры в сценарии могли сложиться иначе
                    if (played.some((x) => (framed(c) ? alike(c.set, x.set) : c.core.length * 2 >= x.seq.length && inside(c.core, x.seq) && c.own.every((f) => x.vids.has(f))))) continue;
                    // Из копий — с названием из имени события (не «Посмотреть сцену?..»), потом — где меньше реплик вокруг сцены
                    const rank = [c.named ? 0 : 1, lines(c.script).length - c.core.length];
                    const k = reps.findIndex((r) => same(r.c, c));
                    if (k < 0) reps.push({ c, rank }); else if (rank[0] < reps[k].rank[0] || (rank[0] === reps[k].rank[0] && rank[1] < reps[k].rank[1])) reps[k] = { c, rank };
                }
                const given = new Map();
                for (const { c } of reps) {
                    // Хозяин — альбом, где больше всего её собственных роликов (кадров анимации — не меньше двух); поровну — тот,
                    // чей ключ начинается с «scenes/<событие>/»
                    const home = c.anim ? frameHolder : holder;
                    const own = c.own.filter((f) => home.has(f));
                    let a = null;
                    if (own.length >= (c.anim ? 2 : 1)) {
                        const score = new Map();
                        for (const f of own) for (const k of home.get(f)) score.set(k, (score.get(k) || 0) + 1);
                        const pre = `scenes/${c.id.replace(/p\d+$/, '')}/`;
                        const best = [...score].sort((x, y) => y[1] - x[1] || (hosts[y[0]].key.startsWith(pre) ? 1 : 0) - (hosts[x[0]].key.startsWith(pre) ? 1 : 0) || x[0] - y[0])[0];
                        a = hosts[best[0]];
                    } else if (c.late !== undefined && eventKey.has(c.late) && c.lines >= scenes.LATE_LINES && scripts.has(eventKey.get(c.late))) {
                        // Позднее событие — гость альбома раннего: если в нём не меньше десяти реплик (короче — реплика у двери,
                        // не вторая сцена) и у альбома-хозяина уже есть своя сцена (иначе гость стал бы его единственной «сценой»
                        // с чужим названием). Два альбома с одним ключом — не знаем, который наш
                        const mine = index.albums.filter((x) => x.key === eventKey.get(c.late));
                        if (mine.length === 1 && !mine[0].spine) { a = mine[0]; own.length = 0; own.push(...a.files); }
                    }
                    if (!a) continue;
                    const list = given.get(a.key) || [];
                    if (list.length >= SCENES_MAX) continue;
                    // Одинаковые названия различаем номером: «Сцена (2)»
                    const twins = list.filter((x) => x.base === c.title).length;
                    list.push({ base: c.title, t: twins ? `${c.title} (${twins + 1})` : c.title, f: own.map((f) => a.files.indexOf(f)).filter((i) => i >= 0), steps: stepsOf(c.script), id: c.id });
                    given.set(a.key, list);
                }
                for (const [key, list] of given) { guests.set(key, list); for (const x of list) hosted.set(x.id, key); }
                if (already) console.log(`Сцены-гости ${id}: уже отданы альбомам по имени: ${already}`);
            } catch (e) {
                guests.clear();
                console.warn(`[Галерея] ${id}: сцены-гости не собрались: ${e.message}`);
            }
            // Сцены альбомов Spine (i11d): событие без картинок, где идёт скелет набора и реплики под ним, — сценарий альбома этого
            // набора. Альбомы и файлы не меняются: только флаг script. Ошибка здесь — без этих сценариев, остальное цело
            try {
                for (const sc of built.spineScenes || []) {
                    const a = index.albums.find((x) => x.spine && x.spine.skeleton === sc.set);
                    if (!a || scripts.has(a.key) || hosted.has(sc.id)) continue;
                    scripts.set(a.key, stepsOf(sc.script));
                    hosted.set(sc.id, a.key);
                }
            } catch (e) {
                console.warn(`[Галерея] ${id}: сцены альбомов Spine не собрались: ${e.message}`);
            }
            // Сцены альбомов Live2D: событие, где на экране модель (картинки — только фон) и под ней идут реплики, — гость альбома
            // этой модели. На модель их несколько, поэтому, как у остальных гостей, каждая своим номером. Копия (то же событие в комнате
            // воспоминаний, на другой карте) — те же модели и движения, число реплик то же с запасом на перевод: показываем одну,
            // где реплик под моделью больше, потом — ранняя. Ошибка здесь — без этих сцен, остальное цело (сцены Spine и Live2D собираются по-разному)
            try {
                const byAlbum = new Map();
                for (const sc of built.l2dScenes || []) {
                    const a = index.albums.find((x) => x.live2d && x.live2d.model === sc.set);
                    if (!a || hosted.has(sc.id)) continue;
                    if (!byAlbum.has(a.key)) byAlbum.set(a.key, { a, list: [] });
                    byAlbum.get(a.key).list.push(sc);
                }
                for (const [key, { a, list }] of byAlbum) {
                    const reps = [];
                    for (const c of list.sort((x, y) => x.at - y.at)) {
                        const k = reps.findIndex((r) => r.sig === c.sig && Math.abs(r.says - c.says) * 10 <= Math.max(r.says, c.says));
                        if (k < 0) reps.push(c); else if (c.under > reps[k].under) reps[k] = c;
                    }
                    const mine = guests.get(key) || [];
                    for (const c of reps.sort((x, y) => x.at - y.at)) {
                        if (mine.length >= SCENES_MAX) break;
                        const twins = mine.filter((x) => x.base === c.title).length;
                        const used = new Set(c.script.filter((x) => x.k === 'l2d' && !x.off && x.s === c.set).flatMap((x) => x.a));
                        mine.push({ base: c.title, t: twins ? `${c.title} (${twins + 1})` : c.title, f: [...used].map((n) => a.files.indexOf(`${c.set}#${n}`)).filter((i) => i >= 0), steps: stepsOf(c.script), id: c.id });
                        hosted.set(c.id, key);
                    }
                    if (mine.length) guests.set(key, mine);
                }
            } catch (e) {
                console.warn(`[Галерея] ${id}: сцены альбомов Live2D не собрались: ${e.message}`);
            }
            // Склейки, которые добавили сценарии блока выше, и склейки только от движения в сценариях (кадры анимаций, экраны
            // у затемнений): рамку им меряем и обрезку считаем после остальных (см. ниже)
            const hostedFrames = new Set([...Object.keys(built.frames).filter((h) => !framesBefore.has(h)), ...decorFrames]);
            // Кадры панелей: у них рамку меряем и у деталей, а не только у основы
            const plainHashes = new Set(index.albums.filter((a) => !a.panel).flatMap((a) => a.files).filter((f) => f.startsWith(CG_PREFIX)).map((f) => f.slice(CG_PREFIX.length)));
            // И портреты разговора, ушедшие из альбомов уцелевших групп: сцена показывает их рядом с кадрами альбома, и обрезка у них
            // прежняя — основа-прямоугольник, иначе кадр прыгал бы между обрезанным и целым
            const panelFrames = [...new Set([...index.albums.filter((a) => a.panel).flatMap((a) => a.files).filter((f) => f.startsWith(CG_PREFIX)).map((f) => f.slice(CG_PREFIX.length)),
                ...probes.flat().map((f) => f.slice(CG_PREFIX.length)), ...[...leftTalk].filter((h) => built.frames[h])])].filter((h) => !plainHashes.has(h));
            // Основы склеек с прозрачностью, у которых рамки ещё нет (замер прошлых версий), — домериваем: только они
            // нужны для обрезки врезок. И детали панелей на холсте во весь экран: окно панели — рамка основы и деталей вместе
            const canvasOf = (e) => e && e.w >= 0.95 * index.screen.w && e.h >= 0.95 * index.screen.h;
            // Склейки сценариев блока выше меряем и обрезаем отдельно, после остальных: рамка, снятая с их основы, не должна
            // менять обрезку склеек альбомов (слой на весь экран с рамкой уже не «холст без рамки» — окно разрастается до экрана)
            const needBox = [...new Set([...Object.entries(built.frames).filter(([h]) => !hostedFrames.has(h)).map(([, layers]) => layers[0]?.rel),
                ...panelFrames.flatMap((h) => (built.frames[h] || []).slice(1).map((l) => l.rel).filter((rel) => canvasOf(entries.get(rel))))])]
                .filter((rel) => { const e = rel && entries.get(rel); return e && e.alpha && !e.box && !(e.opaque >= OPAQUE_BASE); });
            await pool(needBox, 3, measureBox);
            // Слепые слои врезки: прозрачный слой на холсте без рамки (кадры анимации поверх окна) окном не учтён — обрезка по
            // остальным слоям его бы срезала. У кадров, где окно и так меньше предела, меряем такие слои тоже
            {
                const plainLayer = (l) => !l.cell && !l.o && Number(l.zx ?? 100) === 100 && Number(l.zy ?? 100) === 100;
                const canvasLayer = (l, le) => le && !(Number(l.x) || 0) && !(Number(l.y) || 0) && le.w >= 0.95 * index.screen.w && le.h >= 0.95 * index.screen.h;
                const blind = new Set();
                for (const layers of Object.values(built.frames)) {
                    const e = layers[0] && entries.get(layers[0].rel);
                    if (!e || !e.box || layers.length < 2 || !layers.every(plainLayer)) continue;
                    if (layers.slice(1).some((l) => { const le = entries.get(l.rel); return !le?.box && !canvasLayer(l, le); })) continue;
                    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
                    for (const l of layers) {
                        const le = entries.get(l.rel);
                        if (!le || !le.box) continue;
                        x0 = Math.min(x0, (Number(l.x) || 0) + le.box[0] * le.w); y0 = Math.min(y0, (Number(l.y) || 0) + le.box[1] * le.h);
                        x1 = Math.max(x1, (Number(l.x) || 0) + le.box[2] * le.w); y1 = Math.max(y1, (Number(l.y) || 0) + le.box[3] * le.h);
                    }
                    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(index.screen.w, x1); y1 = Math.min(index.screen.h, y1);
                    if (!(x1 > x0 && y1 > y0) || (x1 - x0) * (y1 - y0) > CROP_MAX * index.screen.w * index.screen.h) continue;
                    for (const l of layers.slice(1)) if (needsBox(l.rel)) blind.add(l.rel);
                }
                await pool([...blind], 3, measureBox);
            }
            // Врезка: основа — окно на пустом холсте во весь экран («cutin/Hero_Back_D» у Ember & Frost: 29 %
            // экрана слева), в игре под ним карта. Кадр обрезаем по окну, иначе он — маленький прямоугольник на чёрном.
            // Только если над основой нет других CG (их рамку не знаем — могли бы обрезать)
            const panelSet = new Set(panelFrames);
            const cropWindow = (hash, layers) => {
                const base = layers[0];
                const e = base && entries.get(base.rel);
                // Склейка из одного слоя (бледная картинка сценария на весь экран) — не врезка: её не обрезаем
                if (!e || !e.box || layers.length < 2 || base.cell || base.o || Number(base.zx ?? 100) !== 100 || Number(base.zy ?? 100) !== 100) return;
                // У каждого слоя — рамка и нет масштаба: слой без рамки (даже холст во весь экран — кадры анимации поверх окна)
                // мог бы выйти за окно, и обрезка срезала бы его; сдвинутый, увеличенный слой тоже
                const plain = (l) => !l.cell && !l.o && Number(l.zx ?? 100) === 100 && Number(l.zy ?? 100) === 100;
                if (layers.slice(1).some((l) => { const le = entries.get(l.rel); return !plain(l) || !le?.box; })) return;
                let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
                for (const l of layers) {
                    const le = entries.get(l.rel);
                    if (!le || !le.box || l.cell || l.o || Number(l.zx ?? 100) !== 100 || Number(l.zy ?? 100) !== 100) continue;
                    // Панель: эффект на весь экран (линии, вспышка, фильтр: рамка [0, 0, 1, 1]) окна не задаёт — окно рисует основа
                    // (SCG/SH у Ashen Crown: окно посреди чёрной плитки 1440×900)
                    if (l !== base && panelSet.has(hash) && le.box[2] - le.box[0] >= 0.9 && le.box[3] - le.box[1] >= 0.9) continue;
                    const lx = Number(l.x) || 0, ly = Number(l.y) || 0;
                    x0 = Math.min(x0, lx + le.box[0] * le.w); y0 = Math.min(y0, ly + le.box[1] * le.h);
                    x1 = Math.max(x1, lx + le.box[2] * le.w); y1 = Math.max(y1, ly + le.box[3] * le.h);
                }
                x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
                x1 = Math.min(index.screen.w, Math.ceil(x1)); y1 = Math.min(index.screen.h, Math.ceil(y1));
                if (!(x1 > x0 && y1 > y0) || (x1 - x0) * (y1 - y0) > CROP_MAX * index.screen.w * index.screen.h) return;
                base.crop = [x0, y0, x1 - x0, y1 - y0];
            };
            for (const [hash, layers] of Object.entries(built.frames)) if (!hostedFrames.has(hash)) cropWindow(hash, layers);
            // Панель — по прямоугольнику основы (детали лежат на ней): иначе кадр — полоска справа на чёрном экране
            // Склейку с той же стопкой в обычном альбоме (общий хэш) не трогаем
            const panelCrop = (h) => {
                const base = built.frames[h]?.[0];
                const e = base && entries.get(base.rel);
                if (!e || base.cell || base.o || base.crop) return;
                const zx = Math.abs(Number(base.zx ?? 100)) / 100, zy = Math.abs(Number(base.zy ?? 100)) / 100;
                const x0 = Math.max(0, Math.floor(Number(base.x) || 0)), y0 = Math.max(0, Math.floor(Number(base.y) || 0));
                const x1 = Math.min(index.screen.w, Math.ceil((Number(base.x) || 0) + e.w * zx)), y1 = Math.min(index.screen.h, Math.ceil((Number(base.y) || 0) + e.h * zy));
                if (x1 - x0 >= 16 && y1 - y0 >= 16 && (x1 - x0) * (y1 - y0) < 0.95 * index.screen.w * index.screen.h) base.crop = [x0, y0, x1 - x0, y1 - y0];
            };
            for (const h of panelFrames) panelCrop(h);
            // Склейки сценариев блока раздачи: рамку основы меряем теперь, когда обрезка остальных уже посчитана
            if (hostedFrames.size) {
                await pool([...new Set([...hostedFrames].map((h) => built.frames[h][0]?.rel))].filter(needsBox), 3, measureBox);
                for (const hash of hostedFrames) cropWindow(hash, built.frames[hash]);
            }
            // Диалоги: сценарии групп-разговоров, что фильтр убрал из CG, — альбомы «dialogue» без своих картинок (только
            // сценарий). Шаги и склейки считаем здесь, после раздачи сцен и обрезок: всё, что решили выше, они не меняют
            // (раздача сцен-гостей не видит этих сценариев, склейки не попадают в panelFrames и cropShots). Новые склейки —
            // портреты: обрезка по основе, как у портретов, ушедших из альбомов (panelCrop), один размер на весь разговор
            const dialogues = new Map();      // ключ альбома → { steps, cover }
            const twinFiles = new Set();
            try {
                const had = new Set(Object.keys(built.frames));
                // Одно событие, скопированное на несколько карт (приветствие торговца, случайная встреча), даёт тот же сценарий —
                // показываем его один раз (первая копия). Номер k у остальных прежний
                const seen = new Set();
                const made = talkDropped.map((g, k) => ({ g, k, steps: stepsOf(g.script) })).filter(({ steps }) => {
                    const sig = JSON.stringify(steps);
                    return !seen.has(sig) && seen.add(sig);
                });
                for (const h of Object.keys(built.frames)) if (!had.has(h)) panelCrop(h);
                // Обложка — первая картинка сценария. Склейку портрета без обрезки (двойник с другим хэшем): обрезанный портрет
                // у сотен разговоров одной игры — одно и то же лицо крупным планом
                const firstOf = (steps) => {
                    for (const x of steps) {
                        if (x.k === 'pic' && x.f) return x.f;
                        if (x.k === 'anim') { const f = x.f.find(Boolean); if (f) return f; }
                    }
                    return null;
                };
                for (const { g, k, steps } of made) {
                    let cover = firstOf(steps);
                    const h = cover && cover.startsWith(CG_PREFIX) ? cover.slice(CG_PREFIX.length) : null;
                    if (h && built.frames[h]?.[0]?.crop) {
                        const twin = crypto.createHash('sha1').update(`${h}:full`).digest('hex').slice(0, 20);
                        built.frames[twin] = built.frames[h].map(({ crop, ...l }) => l);
                        cover = `${CG_PREFIX}${twin}`;
                        twinFiles.add(cover);
                    }
                    dialogues.set(`dialogue/${String(k).padStart(5, '0')}/${g.title.replace(/\//g, '∕')}`, { steps, cover });
                }
            } catch (e) {
                dialogues.clear();
                console.warn(`[Галерея] ${id}: диалоги не собрались: ${e.message}`);
            }
            if (Object.keys(measured).length) {
                await fsp.mkdir(path.dirname(opaquePath), { recursive: true });
                await fsp.writeFile(opaquePath, JSON.stringify(measured)).catch(() => {});
            } else await fsp.rm(opaquePath, { force: true });
            // Обрезка одинакова у кадров одного плана — после всех обрезок выше: сравнивать надо итог
            cropShots({ frames: built.frames, entries, albums: index.albums, scripts, panelSet, screen: index.screen });
            // Врезка Spine кладётся по месту показанной картинки на экране игры: box = [x, y, w, h] в пикселях игры — окно
            // обрезанной склейки, весь экран у необрезанной, место × масштаб × размер файла у целой картинки (место — g из
            // сценария). Только в сценариях со Spine: остальные байт в байт прежние. Считаем после всех обрезок; сбой — без box
            // (плеер впишет врезку сам)
            try {
                const boxOf = (f, g) => {
                    if (typeof f !== 'string') return null;
                    if (f.startsWith(CG_PREFIX)) return built.frames[f.slice(CG_PREFIX.length)]?.[0]?.crop || [0, 0, index.screen.w, index.screen.h];
                    const e = entries.get(f);
                    if (!g || !e || !e.w || !e.h) return null;
                    const [x, y, o, zx, zy] = g;
                    const box = [x - o * e.w * Math.abs(zx) / 200, y - o * e.h * Math.abs(zy) / 200, e.w * Math.abs(zx) / 100, e.h * Math.abs(zy) / 100].map(Math.round);
                    return box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? box : null;
                };
                for (const steps of scripts.values()) {
                    const spiny = steps.some((x) => x.k === 'spine' || x.k === 'l2d');
                    for (const x of steps) {
                        if (x.k === 'pic' && x.f) {
                            const box = spiny ? boxOf(x.f, x.g) : null;
                            if (box) x.box = box;
                        } else if (x.k === 'anim' && spiny) {
                            const box = boxOf(x.f.find(Boolean));
                            if (box) x.box = box;
                        }
                        delete x.g;
                    }
                }
            } catch (e) {
                console.warn(`[Галерея] ${id}: место врезок Spine: ${e.message}`);
            }
            // Файлы, которых нет в альбомах, но читать их можно: слои склеек (основа под слоями, кадр листа анимации)
            const listed = new Set(index.albums.flatMap((a) => a.files));
            // Убранные повторы — тоже: на копию могли поставить сердечко раньше, в «Избранном» она открывается
            // и пробные кадры сцен-панелей (их смотрит распознавание)
            const unlisted = new Set([...Object.values(built.frames).flatMap((layers) => layers.map((l) => l.rel)), ...dropped, ...localeDup, ...twins, ...probes.flat()].filter((rel) => rel && !listed.has(rel)));
            if (unlisted.size) index.parts = [...unlisted];
            if (Object.keys(built.frames).length) {
                await fsp.mkdir(path.dirname(this.indexPath(id)), { recursive: true });
                await fsp.writeFile(this.scenesPath(id), JSON.stringify(built.frames));
            } else await fsp.rm(this.scenesPath(id), { force: true });
            this.sceneMemo?.delete(id);
            // Сценарии не записались — у сцен нет и кнопки: иначе плеер открывался бы на пустом месте
            // Обрезка склейки — после всех обрезок выше: анимацию с разными окнами у кадров показываем картинкой
            const cropOf = (f) => (typeof f === 'string' && f.startsWith(CG_PREFIX) && built.frames[f.slice(CG_PREFIX.length)]?.[0]?.crop ? JSON.stringify(built.frames[f.slice(CG_PREFIX.length)][0].crop) : '');
            // Альбомы диалогов — в конец: ключи и порядок остальных альбомов прежние. Те, из которых плеер ничего не соберёт
            // (флага script нет) или нечего читать, после записи уходят
            for (const [key, d] of dialogues) index.albums.push({ key, kind: 'dialogue', w: index.screen.w, h: index.screen.h, files: [], cover: d.cover });
            await this.writeScripts(id, root, index, new Map([...scripts, ...[...dialogues].map(([key, d]) => [key, d.steps])]), { cropOf, hosted: guests }).catch((e) => {
                for (const a of index.albums) { delete a.script; delete a.scenes; delete a.sum; }
                delete index.scripts;
                console.warn(`[Галерея] ${id}: сценарии сцен не записались: ${e.message}`);
            });
            // Разговор без единой реплики и выбора (портреты и звук) — не диалог: смотреть там нечего
            index.albums = index.albums.filter((a) => a.kind !== 'dialogue' || (a.script && (a.sum?.l || a.sum?.c)));
            // Обложка без обрезки — файл, которого в альбомах нет: читать его можно только из parts
            // (только у оставшихся диалогов: у отфильтрованных склейка никому не нужна)
            const twinKept = index.albums.filter((a) => a.kind === 'dialogue' && twinFiles.has(a.cover)).map((a) => a.cover);
            if (twinKept.length) index.parts = [...new Set([...(index.parts || []), ...twinKept])];
            if (visionMissing && this.vision.available) index.visionMissing = visionMissing;
            // У диалогов своих файлов нет: в счётчики картинок они не входят
            for (const a of index.albums) if (a.kind !== 'dialogue') index.counts[a.kind] = (index.counts[a.kind] || 0) + a.files.length;
            if (probeFailed) {
                index.retryAt = Date.now() + PROBE_RETRY_MS;
                console.warn(`[Галерея] ${id}: ffprobe не ответил про ${probeFailed} роликов — они пока «Видео», соберу заново через час`);
            }
        }
        const visionPending = !!index.visionMissing;
        delete index.visionMissing;
        await fsp.mkdir(path.dirname(this.indexPath(id)), { recursive: true });
        const tmp = `${this.indexPath(id)}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(index));
        await fsp.rename(tmp, this.indexPath(id));
        this.memo.delete(id);
        // Склейки названы по слоям: пересборка меняет часть имён, и первое открытие такого кадра склеивалось на лету (≈1 с чёрного
        // экрана). Прогрев делается раз за запуск сервера, поэтому игру, которую уже открывали, греем снова — фоном, сборку не держит
        if (this.warmed && this.warmed.delete(id)) setImmediate(() => this.prewarm(id, index));
        // Сценарии прежних сборок — уже не нужны: новое оглавление смотрит в свою папку
        await this.dropScripts(id, index.scripts || '').catch(() => {});
        // Альбомы CG без ответа распознавания — распознать фоном (оглавление уже записано и открывается)
        if (visionPending) setImmediate(() => this.visionPass(id));
        const c = index.counts;
        console.log(`[Галерея] ${id}: CG ${c.cg || 0}, анимаций ${c.animation || 0}, видео ${c.video || 0}, персонажей ${c.portrait || 0}, фонов ${c.backdrop || 0}, слоёв ${c.layer || 0}, прочего ${c.other || 0}, альбомов ${index.albums.length} — за ${Math.round((Date.now() - index.builtAt) / 1000)} с`);
        return index;
    }

    // Файл из оглавления этой игры — иначе null: чужие пути не читаем
    async resolve(id, rel) {
        if (typeof rel !== 'string' || !(await this.cached(id)) || !this.memo.get(id)?.files.has(rel)) return null;
        const root = await this.contentRoot(id);
        if (!root) return null;
        const file = path.resolve(root, realFile(rel));
        if (!file.startsWith(path.resolve(root) + path.sep)) return null;
        return { root, file };
    }

    // Есть ли файл в оглавлении: true/false; оглавления пока нет (строится) — null
    async knows(id, rel) {
        if (!(await this.cached(id))) return null;
        return !!this.memo.get(id)?.files.has(rel);
    }

    // Картинка целиком, расшифрованная: { data, type }. Ролики — не сюда, а video(). ahead — её смотрят: кадры альбома
    // после неё (склейки) делаем заранее
    async image(id, rel, ahead = false) {
        const found = await this.resolve(id, rel);
        if (!found || VIDEO.test(rel)) return null;
        if (rel.startsWith(CG_PREFIX)) return this.sceneFrame(id, rel, found.root, ahead);
        const data = decrypt(await fsp.readFile(found.file), await mediaKey(found.root));
        // Тип — по содержимому: в репаках под именем .png бывает WebP. APNG — тот же image/png: браузер
        // проигрывает его сам
        const magic = data.subarray(0, 12).toString('latin1');
        const type = magic.startsWith('RIFF') && magic.endsWith('WEBP') ? 'image/webp'
            : magic.startsWith('GIF8') ? 'image/gif'
                : data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png';
        return { data, type };
    }

    // Кадр сцены из событий: слои склеивает ffmpeg (overlay). Готовый кадр кладём в _media/<игра>/scenes/ — один раз.
    // ahead — кадр смотрят (листают, проигрывают анимацию): следующие кадры того же листа анимации склеиваем заодно, тем же
    // ffmpeg — их сейчас попросят. Миниатюре обложки соседи не нужны
    // Описание склеек игры (gallery-scenes.json), прочитанное один раз
    async scenesOf(id) {
        this.sceneMemo = this.sceneMemo || new Map();
        let all = this.sceneMemo.get(id);
        if (!all) {
            all = (await this.readJson(this.scenesPath(id))) || {};
            if (this.sceneMemo.size > 8) this.sceneMemo.delete(this.sceneMemo.keys().next().value);
            this.sceneMemo.set(id, all);
        }
        return all;
    }

    async sceneFrame(id, rel, root, ahead = false) {
        const m = /^@cg\/([0-9a-f]{20})$/.exec(rel);
        if (!m) return null;
        const all = await this.scenesOf(id);
        const layers = all[m[1]];
        if (!layers || !layers.length) return null;
        const index = await this.cached(id);
        const screen = index?.screen || screenOf(await this.system(root));
        const outOf = (ls) => path.join(this.mediaDir, id, 'scenes', `${crypto.createHash('sha1').update(`v1\n${JSON.stringify(ls)}\n${screen.w}x${screen.h}`).digest('hex').slice(0, 24)}.webp`);
        const out = outOf(layers);
        const thumbOf = (f) => this.thumbPath(id, f, all[f.slice(CG_PREFIX.length)]);
        const read = () => fsp.readFile(out).then((data) => ({ data, type: 'image/webp' }), () => null);
        const cached = await read();
        if (cached) return cached;
        // Один и тот же кадр, запрошенный дважды сразу (картинка и миниатюра), делается один раз
        this.frameJobs = this.frameJobs || new Map();
        if (!this.frameJobs.has(out)) {
            const batch = [{ out, layers, thumb: thumbOf(rel) }];
            // Пачкой — только кадры одного листа анимации: огромный лист (25 кадров в ширину) декодируется один раз. Обычные
            // склейки быстрее по одной на ядро
            const sheets = new Set(layers.filter((l) => l.cell).map((l) => l.rel));
            const album = ahead && sheets.size && index ? index.albums.find((a) => a.files.includes(rel)) : null;
            for (const f of album ? album.files.slice(album.files.indexOf(rel) + 1) : []) {
                if (batch.length >= FRAME_BATCH * FRAME_BATCHES) break;
                const k = /^@cg\/([0-9a-f]{20})$/.exec(f);
                const ls = k && all[k[1]];
                if (!ls || !ls.length) continue;
                if (!ls.some((l) => l.cell && sheets.has(l.rel))) break;
                const o = outOf(ls);
                if (this.frameJobs.has(o) || batch.some((b) => b.out === o)) continue;
                batch.push({ out: o, layers: ls, thumb: thumbOf(f) });
            }
            // Заявки на все кадры пачки — сразу, до первого ожидания: плеер просит 24 кадра разом, и запрос соседа не
            // заведёт второй ffmpeg на тот же кадр. Соседей, склеенных раньше, не делаем заново; пачки по FRAME_BATCH
            // кадров — каждая своим ffmpeg, на своём ядре
            const plan = (async () => {
                const todo = [batch[0]];
                for (const b of batch.slice(1)) if (!(await fsp.access(b.out).then(() => true, () => false))) todo.push(b);
                const parts = [];
                for (let i = 0; i < todo.length; i += FRAME_BATCH) parts.push(todo.slice(i, i + FRAME_BATCH));
                return { parts, jobs: parts.map((part) => this.renderFrames(id, part, screen)) };
            })();
            for (const b of batch) {
                const mine = plan.then(({ parts, jobs }) => { const k = parts.findIndex((part) => part.includes(b)); return k < 0 ? null : jobs[k]; })
                    .finally(() => { if (this.frameJobs.get(b.out) === mine) this.frameJobs.delete(b.out); });
                // Соседа не склеили — не беда: попросят ещё раз
                if (b !== batch[0]) mine.catch(() => {});
                this.frameJobs.set(b.out, mine);
            }
        }
        if (!background.getStore()) boost(this.sceneLane);
        await this.frameJobs.get(out);
        return read();
    }

    // Склейка слоёв: batch — [{ out, layers }], все кадры одним ffmpeg (каждая картинка читается один раз, лист кадров
    // анимации — тоже). Числа из данных игры чистим: не число или чужой размах — слой по умолчанию
    async renderFrames(id, batch, screen) {
        const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
        // Своя очередь: миниатюра кадра (она держит общее место) сама зовёт этот метод — на общей встали бы намертво
        const bg = await this.sceneSlot();
        const tmps = [];
        const outs = [];
        try {
            await fsp.mkdir(path.join(this.mediaDir, id, 'scenes'), { recursive: true });
            await fsp.mkdir(path.join(this.mediaDir, id, 'gallery'), { recursive: true });
            // Картинки слоёв — по одному входу на файл; кадр листа анимации — готовым файлом кадра (лист режем один раз)
            const inputs = [];
            const inputOf = new Map();
            const broken = new Set();     // кадры листов, которые не удалось нарезать
            const cellOf = (p) => (p.cell && Number.isInteger(p.cell.n) && p.cell.n > 1 ? p.cell : null);
            const srcKey = (p) => { const c = cellOf(p); return c ? `${p.rel}#${Math.max(0, Math.min(c.n - 1, Number(c.i) || 0))}/${c.n}${c.dir}` : p.rel; };
            for (const b of batch) {
                for (const p of b.layers) {
                    const key = p.rel && srcKey(p);
                    if (!key || inputOf.has(key)) continue;
                    const c = cellOf(p);
                    if (c) {
                        const cells = await this.sheetCells(id, p.rel, c.n, c.dir).catch(() => null);
                        const file = cells && cells[Math.max(0, Math.min(c.n - 1, Number(c.i) || 0))];
                        if (!file) { inputOf.set(key, null); broken.add(key); continue; }
                        inputOf.set(key, inputs.length / 2);
                        inputs.push('-i', file);
                        continue;
                    }
                    const img = await this.image(id, p.rel);
                    if (!img) { inputOf.set(key, null); continue; }
                    const tmp = path.join(this.mediaDir, id, 'scenes', `${process.pid}-${crypto.randomBytes(4).toString('hex')}.src`);
                    await fsp.writeFile(tmp, img.data);
                    tmps.push(tmp);
                    inputOf.set(key, inputs.length / 2);
                    inputs.push('-i', tmp);
                }
            }
            // Кадр без единого слоя не склеить, а без кадра листа (не нарезался) — склеили бы неверно и запомнили навсегда:
            // просили его — ошибка (попросят снова — попробуем снова); сосед — просто без него
            const jobs = batch.filter((b) => b.layers.some((p) => p.rel && inputOf.get(srcKey(p)) != null) && !b.layers.some((p) => p.rel && broken.has(srcKey(p))));
            if (!jobs.includes(batch[0])) throw new Error('нет слоёв');
            // Картинка в нескольких слоях и кадрах — split на нужное число копий
            const uses = new Map();
            for (const b of jobs) for (const p of b.layers) if (p.rel && inputOf.get(srcKey(p)) != null) uses.set(srcKey(p), (uses.get(srcKey(p)) || 0) + 1);
            const filters = [];
            const taps = new Map();
            for (const [key, u] of uses) {
                const k = inputOf.get(key);
                if (u === 1) { taps.set(key, [`${k}:v`]); continue; }
                const labels = Array.from({ length: u }, (_, j) => `s${k}_${j}`);
                filters.push(`[${k}:v]split=${u}${labels.map((l) => `[${l}]`).join('')}`);
                taps.set(key, labels);
            }
            const args = [];
            jobs.forEach((b, j) => {
                filters.push(`color=c=black:s=${screen.w}x${screen.h}:d=1[f${j}b0]`);
                let n = 0;
                for (const p of b.layers) {
                    if (!p.rel || inputOf.get(srcKey(p)) == null) continue;
                    const src = taps.get(srcKey(p)).shift();
                    // Масштаб 5–1000 % (минус — зеркало в MV — по модулю), непрозрачность 0–255, положение в пределах ±20000
                    const zx = num(Math.abs(Number(p.zx ?? 100)), 100, 5, 1000), zy = num(Math.abs(Number(p.zy ?? 100)), 100, 5, 1000);
                    const op = num(p.op, 255, 0, 255) / 255;
                    const x = Math.round(num(p.x, 0, -20000, 20000)), y = Math.round(num(p.y, 0, -20000, 20000));
                    // Начало отсчёта: 0 — левый верхний угол, 1 — центр. Размер после масштаба — w, h наложения
                    const cx = p.o === 1 ? 'w/2' : '0', cy = p.o === 1 ? 'h/2' : '0';
                    filters.push(`[${src}]format=rgba,scale=max(2\\,trunc(iw*${zx}/200)*2):max(2\\,trunc(ih*${zy}/200)*2),colorchannelmixer=aa=${op.toFixed(3)}[f${j}l${n}]`);
                    filters.push(`[f${j}b${n}][f${j}l${n}]overlay=x=${x}-${cx}:y=${y}-${cy}:format=auto[f${j}b${n + 1}]`);
                    n++;
                }
                // Врезка — по её окну (рамка посчитана при сборке): чётные размеры, в пределах экрана
                const c = Array.isArray(b.layers[0]?.crop) ? b.layers[0].crop.map((v) => Math.max(0, Math.round(Number(v) || 0))) : null;
                if (c && c[2] >= 16 && c[3] >= 16) {
                    const w = Math.min(c[2], screen.w - c[0]) & ~1, h = Math.min(c[3], screen.h - c[1]) & ~1;
                    if (w >= 16 && h >= 16) { filters.push(`[f${j}b${n}]crop=${w}:${h}:${c[0]}:${c[1]}[f${j}b${n + 1}]`); n++; }
                }
                const tmpOut = `${b.out}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
                outs.push([tmpOut, b.out]);
                // Миниатюра (для сетки альбомов) — из того же кадра, без второго ffmpeg
                let last = `f${j}b${n}`;
                if (b.thumb) {
                    filters.push(`[${last}]split[f${j}o][f${j}t]`, `[f${j}t]scale='min(${THUMB_WIDTH},iw)':-2[f${j}m]`);
                    last = `f${j}o`;
                    const tmpThumb = `${b.thumb}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
                    outs.push([tmpThumb, b.thumb]);
                    args.push('-map', `[f${j}m]`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '70', '-f', 'webp', tmpThumb);
                }
                // Быстрое сжатие (compression_level 0): кадр анимации нужен сейчас, а файл чуть больше — не беда
                args.push('-map', `[${last}]`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '85', '-compression_level', '0', '-f', 'webp', tmpOut);
            });
            await new Promise((resolve, reject) => {
                const proc = spawn('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), ...args]);
                let err = '';
                proc.stderr.on('data', (d) => { err += d; });
                const timer = setTimeout(() => proc.kill('SIGKILL'), THUMB_TIMEOUT_MS * Math.max(1, Math.ceil(jobs.length / 4)));
                proc.on('error', (e) => { clearTimeout(timer); reject(e); });
                proc.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg: ${code} ${err.slice(-200)}`)); });
            });
            for (const [tmp, out] of outs) await fsp.rename(tmp, out);
        } finally {
            for (const t of [...tmps, ...outs.map(([tmp]) => tmp)]) await fsp.rm(t, { force: true });
            this.sceneRelease(bg);
        }
    }
    // Лист кадров анимации — отдельными файлами кадров (в _media/<игра>/cells/), режем один раз: склейке кадра не нужно
    // каждый раз читать лист в 25 экранов шириной. Ответ — пути кадров по порядку
    async sheetCells(id, rel, n, dir) {
        const found = await this.resolve(id, rel);
        if (!found) return null;
        const st = await fsp.stat(found.file);
        const dirOut = path.join(this.mediaDir, id, 'cells');
        const stem = crypto.createHash('sha1').update(`${rel}\n${st.size}\n${st.mtimeMs}\n${n}${dir}`).digest('hex').slice(0, 20);
        const files = Array.from({ length: n }, (_, i) => path.join(dirOut, `${stem}_${String(i).padStart(3, '0')}.webp`));
        if (await fsp.access(files[n - 1]).then(() => true, () => false)) return files;
        this.cellJobs = this.cellJobs || new Map();
        if (!this.cellJobs.has(stem)) {
            this.cellJobs.set(stem, (async () => {
                await fsp.mkdir(dirOut, { recursive: true });
                const img = await this.image(id, rel);
                if (!img) throw new Error('нет листа');
                const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
                const src = path.join(dirOut, `${tag}.src`);
                await fsp.writeFile(src, img.data);
                const grid = dir === 'h' ? `crop=trunc(iw/${n})*${n}:ih:0:0,untile=${n}x1` : `crop=iw:trunc(ih/${n})*${n}:0:0,untile=1x${n}`;
                try {
                    await new Promise((resolve, reject) => {
                        const proc = spawn('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `format=rgba,${grid}`, '-fps_mode', 'passthrough', '-start_number', '0',
                            '-c:v', 'libwebp', '-quality', '92', '-compression_level', '0', '-f', 'image2', path.join(dirOut, `${tag}_%03d.webp`)]);
                        let err = '';
                        proc.stderr.on('data', (d) => { err += d; });
                        const timer = setTimeout(() => proc.kill('SIGKILL'), THUMB_TIMEOUT_MS * 2);
                        proc.on('error', (e) => { clearTimeout(timer); reject(e); });
                        proc.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg: ${code} ${err.slice(-200)}`)); });
                    });
                    // Готовые кадры — под своими именами; последний переименовываем последним: по нему видно, что лист разрезан
                    for (let i = 0; i < n; i++) await fsp.rename(path.join(dirOut, `${tag}_${String(i).padStart(3, '0')}.webp`), files[i]);
                } finally {
                    await fsp.rm(src, { force: true });
                    for (let i = 0; i < n; i++) await fsp.rm(path.join(dirOut, `${tag}_${String(i).padStart(3, '0')}.webp`), { force: true });
                }
                return files;
            })().finally(() => this.cellJobs.delete(stem)));
        }
        return this.cellJobs.get(stem);
    }

    // Склеек сразу — по ядру (не меньше двух и не больше четырёх)
    sceneSlot() { return take(this.sceneLane); }
    sceneRelease(bg) { give(this.sceneLane, bg); }

    // Файл набора Spine для плеера (атлас, скелет, страницы): только из перечня оглавления, под тем же корнем игры
    async spineFile(id, rel) {
        const found = await this.resolve(id, rel);
        if (!found || !this.memo.get(id)?.spine.has(rel)) return null;
        const ext = rel.split('.').pop().toLowerCase();
        const type = { atlas: 'text/plain; charset=utf-8', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext];
        return type ? { file: found.file, type } : null;
    }

    // Файл модели Live2D (model3.json, moc3, текстуры, движения, ядро) для плеера: только из перечня оглавления, регистр букв
    // не важен (игра ссылается на текстуру «Face.png», а на диске «face.png»). max — ужать текстуру до такой стороны (телефону
    // с MAX_TEXTURE_SIZE 4096 не загрузить лист 8192×4096): копия делается один раз и лежит в _media рядом с оглавлением
    async live2dFile(id, rel, max) {
        if (typeof rel !== 'string' || !(await this.cached(id))) return null;
        const set = this.memo.get(id)?.live2d;
        const real = set && (set.exact.has(rel) ? rel : set.lower.get(rel.toLowerCase()));
        if (!real) return null;
        const root = await this.contentRoot(id);
        const file = root && path.resolve(root, real);
        if (!file || !file.startsWith(path.resolve(root) + path.sep)) return null;
        const ext = real.split('.').pop().toLowerCase();
        const type = L2D_TYPE[ext];
        if (!type) return null;
        const side = L2D_MAX.includes(Number(max)) ? Number(max) : 0;
        if (!side || ext !== 'png') return { file, type };
        const size = pngSize(await readHead(file).catch(() => Buffer.alloc(0)));
        if (!size || Math.max(size.w, size.h) <= side) return { file, type };
        const st = await fsp.stat(file);
        const out = path.join(this.mediaDir, id, 'live2d', `${crypto.createHash('sha1').update(`v1\n${real}\n${st.size}\n${st.mtimeMs}\n${side}`).digest('hex').slice(0, 20)}.png`);
        if (!(await fsp.access(out).then(() => true, () => false))) {
            this.l2dJobs = this.l2dJobs || new Map();
            if (!this.l2dJobs.has(out)) {
                const k = side / Math.max(size.w, size.h);
                const job = (async () => {
                    const bg = await this.slot();
                    try {
                        await fsp.mkdir(path.dirname(out), { recursive: true });
                        const tmp = `${out}.${process.pid}.tmp`;
                        try {
                            await new Promise((resolve, reject) => {
                                const proc = spawn('ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', `scale=${Math.max(1, Math.round(size.w * k))}:${Math.max(1, Math.round(size.h * k))}:flags=lanczos,format=rgba`, '-c:v', 'png', '-f', 'image2', tmp]);
                                const timer = setTimeout(() => proc.kill('SIGKILL'), 2 * THUMB_TIMEOUT_MS);
                                proc.on('error', (e) => { clearTimeout(timer); reject(e); });
                                proc.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg: ${code}`)); });
                            });
                            await fsp.rename(tmp, out);
                        } finally { await fsp.rm(tmp, { force: true }); }
                    } finally { this.release(bg); }
                })().finally(() => this.l2dJobs.delete(out));
                this.l2dJobs.set(out, job);
            }
            // Не вышло ужать — отдаём как есть: браузер, возможно, потянет
            try { await this.l2dJobs.get(out); } catch { return { file, type }; }
        }
        return { file: out, type };
    }

    // Ролик: файл и тип. Отдаёт его server.js через sendFile — с перемоткой (Range), не целиком в память
    async video(id, rel) {
        if (!VIDEO.test(String(rel || ''))) return null;
        const found = await this.resolve(id, rel);
        if (!found) return null;
        return { file: found.file, type: (await videoType(found.file)) || VIDEO_TYPE[rel.split('.').pop().toLowerCase()] };
    }

    // Звук по виду и имени из команды события («se», «Click») → { rel, voice }: для сценариев сцен. Озвучка среди
    // эффектов (audio/se/voice_…) — voice: плеер играет её как голос
    async audioOf(id) {
        this.soundMemo.delete(id);
        const list = await this.sounds(id).catch(() => null);
        const byName = new Map();
        for (const a of list?.albums || []) {
            for (const rel of a.files) {
                const m = /^[^/]+\/([^/]+)\/(.+)\.[^./]+$/.exec(rel);
                const key = m && `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
                if (key && !byName.has(key)) byName.set(key, { rel, voice: m[1].toLowerCase() === 'se' && soundSection(rel) === 'voice' });
            }
        }
        return byName.size ? (kind, name) => byName.get(`${kind}/${String(name).toLowerCase()}`) || null : null;
    }

    // Сценарии сцен рядом с оглавлением: <index.scripts>/<отпечаток ключа>.json = { files, steps, sounds, actors? }. files — файлы
    // альбома и за ними кадры, которых в альбоме нет (их тоже можно читать: index.parts). Шаги: pic (i — номер в files), say
    // (строки как в игре; a — имена героев, которые сцена задала сама), choice (тоже a), snd (f — номер в sounds), stop,
    // wait, fx (тон, вспышка, тряска; fade — затемнение: o 1 гасит, 0 возвращает, c — цвет), anim (кадры f — номера в files,
    // d — кадров игры на каждый; loop — по кругу с кадра r, иначе один раз и встаёт на последнем; x — плавная смена кадров;
    // s — звуки [когда, номер в sounds, громкость, высота, панорама]; перед ней всегда pic с её первым кадром), rep (o 1 и 0 —
    // границы повторов цикла: нажатие их пропускает), spine (врезка Spine: s — номер в spines файла сценария, id — слой, a — анимации
    // по порядку, loop, t — счётчик команд: новая пара (s, t) начинает список заново; at — место и масштаб в пикселях игры; off —
    // слой убрали; у pic и anim — box, прямоугольник экрана игры, который занимает картинка, только в сценариях со Spine и Live2D),
    // l2d (врезка Live2D: s — номер в l2ds файла сценария, id — слой, a — имена движений альбома модели по порядку, loop, t, q, ats, at,
    // off — как у spine; e — выражение, c — at это центр модели, а не угол холста, d — кадров игры на переезд к at).
    // Альбому со сценарием — флаг script. cropOf(файл) — обрезка склейки:
    // кадры анимации с разной обрезкой плеер совместить не может, такая анимация — картинкой
    // hosted — сцены-гости (i07-B): ключ альбома → [{ t, f, steps }]; первая сцена — в файле ключа, n-я — в файле «ключ\nn»,
    // альбому они дают scenes [{ t, f }] (f — номера его файлов, где играют ролики сцены)
    async writeScripts(id, root, index, pending, { cropOf = null, hosted = new Map() } = {}) {
        delete index.scripts;
        if (!pending.size && !hosted.size) return;
        const dir = `scripts-${index.builtAt}`;
        await fsp.rm(path.join(this.mediaDir, id, dir), { recursive: true, force: true });
        const readable = new Set([...index.albums.flatMap((a) => a.files), ...(index.parts || [])]);
        // Наборы Spine, которые отдаёт плеер: скелет → { atlas, skeleton, pages, version } (как album.spine)
        const setOf = new Map(index.albums.filter((a) => a.spine).map((a) => [a.spine.skeleton, a.spine]));
        // Модели Live2D, которые отдаёт плеер: файл модели → описание альбома (движения и выражения — для перевода имён в номера)
        const modelOf = new Map(index.albums.filter((a) => a.live2d).map((a) => [a.live2d.model, a.live2d]));
        const extra = new Set();
        const done = [];
        let actors = null;
        // Прозрачные ролики (a): плеер не кладёт их на CG там, где браузер прозрачности WebM не умеет
        const alpha = new Map();
        const alphaOf = async (rel) => { if (!alpha.has(rel)) alpha.set(rel, await videoAlpha(path.join(root, realFile(rel))).catch(() => false)); return alpha.get(rel); };
        // Сценарий альбома: { files, steps, sounds, videos? } или null, если смотреть нечего
        const build = async (a, raw) => {
            const files = [...a.files];
            const at = new Map(files.map((f, i) => [f, i]));
            const sounds = [];
            const videos = [];
            const spines = [];
            const l2ds = [];
            const lost = new Set();     // слои, чьего набора или модели у плеера нет: их шаги и off тоже вон
            const made = [];
            const fileAt = (f) => {
                let i = at.get(f);
                if (i === undefined) { i = files.push(f) - 1; at.set(f, i); }
                return i;
            };
            const soundAt = (f) => {
                let j = sounds.indexOf(f);
                if (j < 0) j = sounds.push(f) - 1;
                return j;
            };
            const videoAt = (f) => {
                let i = videos.indexOf(f);
                if (i < 0) i = videos.push(f) - 1;
                return i;
            };
            let vis = null;     // что сейчас на экране: картинка («p<i>») или играющая анимация
            const still = (f, box) => {
                if (!f) return;
                const i = fileAt(f);
                const last = made[made.length - 1];
                if (!(last?.k === 'pic' && last.i === i && JSON.stringify(last.box) === JSON.stringify(box))) made.push({ k: 'pic', i, ...(box ? { box } : {}) });
                vis = `p${i}`;
            };
            for (const x of raw) {
                // Убрать картинку (под роликом её нет): i = -1
                if (x.k === 'pic' && x.none) {
                    if (!(made[made.length - 1]?.k === 'pic' && made[made.length - 1].i === -1)) made.push({ k: 'pic', i: -1 });
                    vis = 'p-1';
                } else if (x.k === 'pic') still(x.f, x.box);
                else if (x.k === 'spine') {
                    const sp = x.off ? null : setOf.get(x.s);
                    if (x.off ? lost.has(x.id) : !sp) { lost.add(x.id); continue; }
                    if (x.off) { made.push(x); continue; }
                    let j = spines.findIndex((q) => q.skeleton === sp.skeleton);
                    if (j < 0) j = spines.push({ atlas: sp.atlas, skeleton: sp.skeleton, pages: sp.pages, version: sp.version }) - 1;
                    made.push({ ...x, s: j });
                }
                else if (x.k === 'l2d') {
                    const m = x.off ? null : modelOf.get(x.s);
                    if (x.off ? lost.has(x.id) : !m) { lost.add(x.id); continue; }
                    if (x.off) { made.push(x); continue; }
                    let j = l2ds.findIndex((q) => q.model === m.model);
                    if (j < 0) j = l2ds.push(m) - 1;
                    made.push({ ...x, s: j });
                }
                else if (x.k === 'vid') {
                    // Ролик — номером в videos; следующий по концу (nx) — так же
                    const v = [];
                    for (const { f, nx, ...y } of x.v) {
                        if (!f) continue;
                        v.push({ ...y, i: videoAt(f), ...(nx && nx.f ? { nx: { loop: nx.loop, x: nx.x, y: nx.y, i: videoAt(nx.f) } } : {}), ...((await alphaOf(f)) ? { a: true } : {}) });
                    }
                    made.push({ k: 'vid', v });
                } else if (x.k === 'anim') {
                    // Чужой вид анимации пропускаем, а не падаем
                    if (!Array.isArray(x.f) || !Array.isArray(x.d) || x.f.length !== x.d.length) continue;
                    const names = x.f.map((f) => f || null);
                    const lastFrame = names.findLast(Boolean);
                    // Кадры с разной обрезкой друг на друга не лягут: показываем последний кадр картинкой (до файлов в списке)
                    if (cropOf && new Set(names.filter(Boolean).map(cropOf)).size > 1) { still(lastFrame, x.box); continue; }
                    // Файла нет в игре — пустой кадр; кадры, из которых ничего не вышло, берёт сосед
                    const q = scenes.squash(names, x.d, x.r || 0, x.x, x.s, (a, b) => a === b);
                    if (!q) { still(lastFrame, x.box); continue; }
                    const loop = !!x.loop && q.ring;
                    const key = `a${JSON.stringify([q.items, q.d, loop, q.r, q.x])}`;
                    // Тот же цикл уже идёт (после тихой смены в скрытом слое) — не перезапускаем; не-цикл играет заново
                    if (loop && key === vis) continue;
                    const first = fileAt(q.items[0]);
                    if (vis !== `p${first}`) made.push({ k: 'pic', i: first, ...(x.box ? { box: x.box } : {}) });
                    made.push({ k: 'anim', f: q.items.map(fileAt), d: q.d, loop, ...(q.r ? { r: q.r } : {}), ...(q.x.some(Boolean) ? { x: q.x } : {}),
                        ...(q.s.length ? { s: q.s.map(([t, se]) => [t, soundAt(se.f), se.vol, se.pitch, se.pan]) } : {}) });
                    vis = key;
                } else if (x.k === 'snd') made.push({ ...x, f: soundAt(x.f) });
                else made.push(x);
            }
            // Затемнения — только пары, под которыми что-то сменилось; повторы цикла без шагов внутри — убрать
            const steps = scenes.blinks(scenes.fades(made)).filter((x, i, all) => !(x.k === 'rep' && x.o && all[i + 1]?.k === 'rep' && !all[i + 1].o) && !(x.k === 'rep' && !x.o && all[i - 1]?.k === 'rep' && all[i - 1].o));
            // Альбом Spine смотрят и без картинок: скелет на чёрном и реплики под ним. Альбомам событий картинка по-прежнему нужна
            if (!steps.some((x) => (x.k === 'pic' && x.i >= 0) || (x.k === 'vid' && x.v.length) || (a.spine && x.k === 'spine' && !x.off) || (a.live2d && x.k === 'l2d' && !x.off)) || !steps.some((x) => x.k === 'say' || x.k === 'snd')) return null;
            for (const f of [...files.slice(a.files.length), ...videos]) if (!readable.has(f)) extra.add(f);
            return { files, steps, sounds, ...(videos.length ? { videos } : {}), ...(spines.length ? { spines } : {}), ...(l2ds.length ? { l2ds } : {}) };
        };
        // Сводка сцены для вкладки «Сцены»: сколько реплик (с текстом) и картинок, есть ли голос, выбор, ролик, анимация, кто
        // говорит больше всех и первая реплика (f: плитка диалога показывает её поверх портрета). Считаем по готовым шагам, второго прохода по файлам игры нет. Старое оглавление её не имеет
        const summarize = (out) => {
            const who = new Map();
            const pics = new Set();
            let l = 0, v = 0, c = 0, m = 0, a = 0, f = '';
            for (const x of out.steps) {
                if (x.k === 'say') {
                    let sp = null;
                    try { sp = scenes.speech(x.l || [], x.n || '', x.v || {}, out.actors || []); } catch { /* строка без разбора — не считаем */ }
                    if (!sp || !sp.text) continue;
                    l++;
                    // Одной строкой и не длиннее 80 знаков (по символам, не по кодовым единицам)
                    if (!f) f = Array.from(String(sp.text).replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
                    if (sp.who) who.set(sp.who, (who.get(sp.who) || 0) + 1);
                } else if (x.k === 'choice') c = 1;
                else if (x.k === 'snd' && (x.kind === 'voice' || x.kind === 'vloop')) v = 1;
                else if (x.k === 'vid' && x.v.length) m = 1;
                else if (x.k === 'anim' || ((x.k === 'spine' || x.k === 'l2d') && !x.off)) { a = 1; for (const i of x.f || []) if (i >= 0) pics.add(i); }
                else if (x.k === 'pic' && x.i >= 0) pics.add(x.i);
            }
            const top = [...who].sort((p, q) => q[1] - p[1]).slice(0, 2).map(([name]) => name);
            return { l, p: pics.size, ...(f ? { f } : {}), ...(top.length ? { w: top } : {}), ...(v ? { v } : {}), ...(c ? { c } : {}), ...(m ? { m } : {}), ...(a ? { a } : {}) };
        };
        const write = async (key, out) => {
            // Имена героев для «\N[1]» в репликах — из Actors.json, только если сцена их зовёт
            if (/\\\\[NnPp]\[/.test(JSON.stringify(out.steps))) {
                actors = actors || ((await readGameJson(root, path.join(root, 'data', 'Actors.json')).catch(() => null)) || []).map((x) => x?.name || '');
                out.actors = actors;
            }
            const file = this.scriptPath(id, dir, key);
            await fsp.mkdir(path.dirname(file), { recursive: true });
            await fsp.writeFile(file, JSON.stringify(out));
            return summarize(out);
        };
        const lists = new Map();
        const sums = new Map();
        for (const a of index.albums) {
            const guests = hosted.get(a.key);
            if (guests) {
                // Сцены, из которых ничего не вышло (нет картинки или ролика, реплик), выпадают: номера идут подряд
                const ok = [];
                // У альбома своя сцена (позднее событие стало гостем альбома раннего): она первая, на любом файле, под названием
                // альбома — как его зовёт список сцен
                const first = pending.get(a.key);
                const all = first ? [{ t: a.title || a.key.split('/').pop().replace(/(#\w+)+$/, ''), f: a.files.map((_, i) => i), steps: first }, ...guests] : guests;
                for (const x of all) {
                    const out = await build(a, x.steps);
                    if (!out) continue;
                    const sum = await write(ok.length ? `${a.key}\n${ok.length}` : a.key, out);
                    ok.push({ t: x.t, f: x.f, sum });
                }
                if (ok.length) { lists.set(a, ok); done.push(a); }
                continue;
            }
            const raw = pending.get(a.key);
            if (!raw) continue;
            const out = await build(a, raw);
            if (!out) continue;
            sums.set(a, await write(a.key, out));
            done.push(a);
        }
        // Флаги — когда записаны все: сорвалась запись посередине — оглавление их не получит
        for (const a of done) { a.script = true; if (sums.has(a)) a.sum = sums.get(a); }
        for (const [a, list] of lists) a.scenes = list;
        if (extra.size) index.parts = [...(index.parts || []), ...extra];
        if (done.length) index.scripts = dir;
    }

    // Языки сцен игры (services/sceneLangs.js): таблица переводов, которые игра везёт с собой, только для строк, что
    // есть в сценариях. Лежит рядом со сценариями (langs.json) — со сборкой галереи пропадает и строится заново; в
    // памяти — последние LANG_MEMO игр. Строится один раз, одновременные запросы ждут одну сборку. Нет сценариев — null
    async sceneLangs(id, index = null) {
        index = index || await this.cached(id);
        if (!index || !index.scripts) return null;
        const dir = index.scripts;
        const hit = this.langMemo.get(id);
        if (hit && hit.dir === dir) return hit.table;
        const tag = `${id}|${dir}`;
        if (this.langPending.has(tag)) return this.langPending.get(tag);
        const job = (async () => {
            const file = path.join(this.mediaDir, id, dir, 'langs.json');
            let table = await this.readJson(file);
            if (!table || table.v !== sceneLangs.VERSION) {
                const root = await this.contentRoot(id);
                if (!root) return null;
                table = await sceneLangs.build(root, () => this.wantedLines(id, index));
                // Без mkdir: галерею тем временем пересобрали, папки нет — заново её создавать незачем
                await fsp.writeFile(file, JSON.stringify(table)).catch(() => {});
            }
            if (this.langMemo.size >= LANG_MEMO) this.langMemo.delete(this.langMemo.keys().next().value);
            this.langMemo.set(id, { dir, table });
            return table;
        })().catch((e) => { console.warn(`[Галерея] ${id}: языки сцен не собрались: ${e.message}`); return null; })
            .finally(() => this.langPending.delete(tag));
        this.langPending.set(tag, job);
        return job;
    }

    // Что просят перевести: реплики (ключ — строки окна через перевод строки), наборы и варианты выбора, имена говорящих
    // (без тегов плагинов) — из сценариев всех альбомов со сценарием
    async wantedLines(id, index) {
        const wanted = { msgs: new Map(), optSets: new Set(), opts: new Set(), names: new Set() };
        for (const a of index.albums) {
            if (!a.script) continue;
            // Сцены-гости альбома — в файлах «ключ\nn»
            for (let n = 0; n < (Array.isArray(a.scenes) ? a.scenes.length : 1); n++) {
                const data = await this.readJson(this.scriptPath(id, index.scripts, n ? `${a.key}\n${n}` : a.key));
                for (const x of Array.isArray(data?.steps) ? data.steps : []) {
                    if (x.k === 'say') { wanted.msgs.set(x.l.join('\n'), x.l); if (x.n) wanted.names.add(sceneLangs.stripTags(x.n)); }
                    else if (x.k === 'choice') { wanted.optSets.add(x.o.join('\u0000')); for (const o of x.o) wanted.opts.add(o); }
                    // Имена героев, которые сцена задала сама, ищем как имена говорящих
                    if (x.a) for (const v of Object.values(x.a)) wanted.names.add(sceneLangs.stripTags(v));
                }
            }
        }
        return wanted;
    }

    // Сцена для плеера: { files, steps } — файлы альбома и шаги с готовым текстом (реплика { who, text } без кодов).
    // translate(строки) → Map(оригинал → перевод), если игру переводит Mimikin: реплики идут в перевод, как в игре.
    // opts (want, ui, known, mt, client — server.js) включает выбор языка: переводы из игры и Mimikin, язык по цепочке
    // «выбранный, Mimikin, язык интерфейса, знакомые, английский»; ответ дополняют lang и langs, если вариантов два и
    // больше. Без opts — как раньше: только перевод Mimikin. Сбой нового пути не мешает открыть сцену
    async scene(id, key, translate = null, opts = null) {
        const index = await this.cached(id);
        const album = index && index.scripts && typeof key === 'string' ? index.albums.find((a) => a.key === key && a.script) : null;
        // n — номер сцены-гостя (opts.n): у альбома без гостей только 0; чужой номер — сцены нет
        const n = opts?.n ?? 0;
        if (!album || !Number.isInteger(n) || n < 0 || n >= (Array.isArray(album.scenes) ? album.scenes.length : 1)) return null;
        const data = await this.readJson(this.scriptPath(id, index.scripts, n ? `${key}\n${n}` : key));
        if (!data || !Array.isArray(data.steps)) return null;
        const strings = new Set();
        for (const x of data.steps) {
            if (x.k === 'say') { for (const l of x.l) strings.add(l); if (x.n) strings.add(x.n); } else if (x.k === 'choice') for (const o of x.o) strings.add(o);
            if (x.a) for (const v of Object.values(x.a)) strings.add(v);
        }
        const files = Array.isArray(data.files) ? data.files : album.files;
        // Звуки анимаций: [когда, номер, громкость, высота, панорама] → с файлом; без файла не отдаём
        for (let i = 0; i < data.steps.length; i++) {
            const x = data.steps[i];
            if (x.k === 'anim') data.steps[i] = { ...x, s: (x.s || []).map(([t, j, vol, pitch, pan]) => ({ t, f: data.sounds?.[j], vol, pitch, pan })).filter((y) => y.f) };
            // Ролики: i — номер в videos → путь для /video; следующий по концу (nx) — так же. Нет файла — слоя нет
            else if (x.k === 'vid') data.steps[i] = { ...x, v: (x.v || []).map(({ i: n, nx, ...v }) => ({ ...v, f: data.videos?.[n], ...(nx && data.videos?.[nx.i] ? { nx: { loop: nx.loop, x: nx.x, y: nx.y, f: data.videos[nx.i] } } : {}) })).filter((v) => v.f) };
        }
        if (opts) {
            try {
                let timer;
                const T = await Promise.race([this.sceneLangs(id, index).catch(() => null), new Promise((done) => { timer = setTimeout(() => done(null), this.langWait); })]);
                clearTimeout(timer);
                const tr = opts.mt && translate && strings.size ? await translate([...strings]).catch(() => new Map()) : null;
                return { files, screen: index.screen, ...(data.spines?.length ? { spines: data.spines } : {}), ...(data.l2ds?.length ? { l2ds: data.l2ds } : {}), ...sceneLangs.serve(data, T, { ...opts, tr }, scenes.speech) };
            } catch (e) {
                console.warn(`[Галерея] ${id}: языки сцены: ${e.message}`);
            }
        }
        const tr = translate && strings.size ? await translate([...strings]).catch(() => new Map()) : new Map();
        const tx = (t) => tr.get(t) ?? t;
        // Имена героев, которые сцена задала сама (a), поверх Actors.json — тоже через перевод
        const cast = (x) => (x.a ? Object.assign([...(data.actors || [])], Object.fromEntries(Object.entries(x.a).map(([n, v]) => [n, tx(v)]))) : data.actors);
        const steps = [];
        for (const x of data.steps) {
            if (x.k === 'say') {
                const { who, text } = scenes.speech(x.l.map(tx), x.n ? tx(x.n) : '', x.v, cast(x));
                if (text) steps.push({ k: 'say', who, text });
            } else if (x.k === 'choice') steps.push({ k: 'choice', o: x.o.map((o) => scenes.speech([tx(o)], '', {}, cast(x)).text), i: x.i });
            else if (x.k === 'snd') { const f = data.sounds?.[x.f]; if (f) steps.push({ k: 'snd', kind: x.kind, f, vol: x.vol, pitch: x.pitch, pan: x.pan }); }
            else steps.push(x);
        }
        return { files, steps, screen: index.screen, ...(data.spines?.length ? { spines: data.spines } : {}), ...(data.l2ds?.length ? { l2ds: data.l2ds } : {}) };
    }

    // Звуки игры: список из папки audio/ — читаем при первом запросе, а не при сборке оглавления картинок: оно
    // тяжёлое и общее для всех игр, а ради звука пересобирать его у каждой игры незачем. Обход папки — доли секунды
    // даже у Ironhold Keep (6000 озвучек); запоминаем в памяти, forget() сбрасывает
    async sounds(id) {
        const memo = this.soundMemo.get(id);
        if (memo) return memo.list;
        const root = await this.contentRoot(id);
        const albums = new Map();
        const files = new Set();
        const walk = async (rel) => {
            for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
                const r = `${rel}/${e.name}`;
                if (e.isDirectory()) { await walk(r); continue; }
                if (!e.isFile() || !SOUND.test(e.name)) continue;
                const section = soundSection(r);
                // Озвучка среди эффектов (audio/se/voice_..., audio/enemy/voice_...) — отдельным альбомом той же папки
                const key = section === 'voice' && soundSection(rel) !== 'voice' ? `${rel}#voice` : rel;
                if (!albums.has(key)) albums.set(key, { key, name: key.replace(/^audio\//i, '').replace('#voice', ' (voice)'), section, files: [] });
                albums.get(key).files.push(r);
                files.add(r);
            }
        };
        // Папка называется audio, а в репаках бывает Audio (на файловой системе, где регистр важен) — ищем среди папок
        // корня; глубже имена не трогаем
        const top = root && (await fsp.readdir(root, { withFileTypes: true }).catch(() => [])).find((e) => e.isDirectory() && e.name.toLowerCase() === 'audio');
        if (top) await walk(top.name);
        const naturally = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
        const list = [...albums.values()].sort((a, b) => SOUND_SECTIONS.indexOf(a.section) - SOUND_SECTIONS.indexOf(b.section) || naturally.compare(a.key, b.key));
        for (const a of list) a.files.sort(naturally.compare);
        const out = { count: files.size, albums: list };
        if (this.soundMemo.size >= 50) this.soundMemo.delete(this.soundMemo.keys().next().value);
        this.soundMemo.set(id, { list: out, files });
        return out;
    }

    // Звук для плеера: { size, read(start, end), type } — зашифрованный (server.js отдаёт его по Range, читая с диска
    // только нужный кусок), или { file, type } — обычный файл, его отдаст sendFile сам. Только из списка sounds()
    async sound(id, rel) {
        if (typeof rel !== 'string' || !SOUND.test(rel)) return null;
        await this.sounds(id);
        if (!this.soundMemo.get(id)?.files.has(rel)) return null;
        const root = await this.contentRoot(id);
        const file = root && path.resolve(root, rel);
        if (!file || !file.startsWith(path.resolve(root) + path.sep)) return null;
        const type = SOUND_TYPE[rel.split('.').pop().toLowerCase().replace(/_$/, '')];
        // Зашифрованным бывает и файл без «чужого» расширения (в репаках .ogg с заголовком RPGM) — проверим первые байты
        const head = await readHead(file).catch(() => null);
        if (!head) return null;
        if (head.subarray(0, 4).toString('latin1') !== 'RPGM') return { file, type };
        const size = (await fsp.stat(file)).size - 16;
        if (size < 0) return null;
        const key = (await mediaKey(root) || '').match(/../g)?.map((x) => parseInt(x, 16)) || [];
        // Звук в файле лежит после 16 байт заголовка RPGM, и только его первые 16 байт сложены по XOR с ключом (как в
        // decrypt). Озвучек в игре тысячи, а <audio> просит их кусками: целиком файл на каждый запрос не читаем
        const read = (start, end) => {
            let pos = start;
            const out = new Transform({
                transform(chunk, _enc, done) {
                    if (key.length) for (let i = 0; i < chunk.length && pos + i < 16; i++) chunk[i] ^= key[(pos + i) % key.length];
                    pos += chunk.length;
                    done(null, chunk);
                },
            });
            return fs.createReadStream(file, { start: 16 + start, end: 16 + end }).on('error', (e) => out.destroy(e)).pipe(out);
        };
        return { size, read, type };
    }

    // Миниатюра шириной 360 — WebP в _media/<игра>/gallery/. Делаем не больше трёх сразу
    // Одна и та же миниатюра, запрошенная дважды сразу, делается один раз
    thumb(id, rel) {
        const key = `${id}\n${rel}`;
        this.thumbsInFlight = this.thumbsInFlight || new Map();
        if (!this.thumbsInFlight.has(key)) {
            this.thumbsInFlight.set(key, this.makeThumb(id, rel).finally(() => this.thumbsInFlight.delete(key)));
        }
        return this.thumbsInFlight.get(key);
    }

    // Миниатюра: у склейки — по её слоям (адрес склейки тот же, а слои после пересборки могут уточниться: обрезка врезки)
    thumbPath(id, rel, layers = null) {
        const key = layers ? `v3\n${rel}\n${JSON.stringify(layers)}` : `v2\n${rel}`;
        return path.join(this.mediaDir, id, 'gallery', `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}.webp`);
    }

    async makeThumb(id, rel) {
        const found = await this.resolve(id, rel);
        if (!found) return null;
        const out = this.thumbPath(id, rel, rel.startsWith(CG_PREFIX) ? (await this.scenesOf(id))[rel.slice(CG_PREFIX.length)] || null : null);
        if (await fsp.access(out).then(() => true, () => false)) return out;
        // Склейку делает ffmpeg вместе с миниатюрой; кадр уже был (склеен раньше, без неё) — миниатюра по-обычному, ниже
        if (rel.startsWith(CG_PREFIX)) {
            await this.image(id, rel).catch(() => null);
            if (await fsp.access(out).then(() => true, () => false)) return out;
        }
        const bg = await this.slot();
        try {
            if (await fsp.access(out).then(() => true, () => false)) return out;
            await fsp.mkdir(path.dirname(out), { recursive: true });
            // Миниатюру ffmpeg пишет в файл: в поток он не может вписать размер в заголовок WebP, и браузер
            // такую картинку мог не показать. Читает тоже из файла: анимированный PNG из потока он не
            // открывает («Function not implemented»). Картинку — расшифрованную во временный файл, ролик —
            // прямо с диска: кадр на первой секунде (первый кадр часто чёрный), а ролик не длиннее
            // секунды — первый кадр. Битый или огромный ролик не держит очередь миниатюр: 30 секунд — и хватит
            const tmp = `${out}.${process.pid}.tmp`;
            const src = `${out}.${process.pid}.src`;
            const encode = (input, seek = []) => new Promise((resolve, reject) => {
                const proc = spawn('ffmpeg', ['-v', 'error', '-y', ...seek, '-i', input, '-frames:v', '1', '-vf', `scale='min(${THUMB_WIDTH},iw)':-2`, '-c:v', 'libwebp', '-quality', '70', '-f', 'webp', tmp]);
                const timer = setTimeout(() => proc.kill('SIGKILL'), THUMB_TIMEOUT_MS);
                proc.on('error', (e) => { clearTimeout(timer); reject(e); });
                proc.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg: ${code}`)); });
            });
            const made = () => fsp.stat(tmp).then((s) => s.size > 20, () => false);
            try {
                if (VIDEO.test(rel)) {
                    // Кадра на первой секунде нет — ffmpeg, не ругаясь, пишет пустой WebP в 8 байт: не годится
                    await encode(found.file, ['-ss', '1']).catch(() => {});
                    if (!(await made())) await encode(found.file);
                } else {
                    const img = await this.image(id, rel);
                    if (!img) throw new Error('нет картинки');
                    const { data, type } = img;
                    await fsp.writeFile(src, data);
                    try {
                        await encode(src);
                    } catch (e) {
                        // Анимированный WebP ffmpeg не читает — он сам себе миниатюра: уже WebP, браузер покажет
                        if (type !== 'image/webp') throw e;
                        await fsp.writeFile(tmp, data);
                    }
                }
                if (!(await made())) throw new Error('ffmpeg: пустая миниатюра');
                await fsp.rename(tmp, out);
            } finally {
                await fsp.rm(tmp, { force: true });
                await fsp.rm(src, { force: true });
            }
            return out;
        } finally {
            this.release(bg);
        }
    }

    // Лёгкая копия большого PNG для просмотра: путь к WebP или null — отдавать оригинал. Оригинал остаётся для всего, что
    // читает файл само (склейки, листы кадров, миниатюры, image()). Копия лежит в _media/<игра>/view/ под именем по
    // пути и размеру оригинала; пустой файл — «копия не вышла или не меньше 80 %»: второй раз не пробуем.
    // GIF, JPEG, WebP, ролики и склейки не трогаем. Файл крупнее VIEW_WAIT_MAX человек не ждёт: оригинал сейчас, копия — фоном
    async view(id, rel, ahead = false) {
        const found = await this.resolve(id, rel);
        if (!found || VIDEO.test(rel) || rel.startsWith(CG_PREFIX) || /\.(jpe?g|gif|webp)$/i.test(rel)) return null;
        const st = await fsp.stat(found.file).catch(() => null);
        if (!st || st.size < VIEW_MIN) return null;
        // Просмотр большой картинки — готовим соседние; для маленьких, JPEG и склеек обход альбома не нужен
        if (!ahead) this.viewAhead(id, rel);
        const out = path.join(this.mediaDir, id, 'view', `${crypto.createHash('sha1').update(`v1\n${rel}\n${st.size}\n${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 20)}.webp`);
        const have = await fsp.stat(out).catch(() => null);
        if (have) return have.size > 0 ? out : null;
        this.viewFail = this.viewFail || new Map();
        if (Date.now() - (this.viewFail.get(out) || 0) < VIEW_RETRY_MS) return null;
        this.viewJobs = this.viewJobs || new Map();
        let job = this.viewJobs.get(out);
        if (job) {
            // Копию уже начал фон, а теперь её ждёт человек: фоновые заявки встают в общую очередь
            if (st.size <= this.viewWaitMax && !background.getStore()) boost(this.thumbLane);
        } else {
            job = (st.size > this.viewWaitMax ? inBackground : (fn) => fn())(() => this.makeView(id, rel, out))
                .catch(() => { this.viewFail.set(out, Date.now()); return false; }).finally(() => this.viewJobs.delete(out));
            this.viewJobs.set(out, job);
        }
        if (st.size > this.viewWaitMax) return null;
        return (await job) ? out : null;
    }

    async makeView(id, rel, out) {
        const bg = await this.slot();
        try {
            const have = await fsp.stat(out).catch(() => null);
            if (have) return have.size > 0;
            const dir = path.dirname(out);
            await fsp.mkdir(dir, { recursive: true });
            // Мало места — не пишем даже маркер: освободится, и копия получится
            const st = await fsp.statfs(dir);
            if (st.bavail * st.bsize < this.viewMinFree) return false;
            if (await this.viewUsed(id) >= this.viewDirMax) return false;
            const img = await this.image(id, rel);
            if (!img) return false;
            const tmp = `${out}.${process.pid}.tmp`;
            const src = `${out}.${process.pid}.src`;
            let ok = false;
            let transient = false;
            try {
                // Не PNG под именем .png (WebP, JPEG в репаках) — копия не нужна
                const anim = img.type === 'image/png' ? apngInfo(img.data) : null;
                if (img.type === 'image/png') {
                    await fsp.writeFile(src, img.data);
                    // Анимацию ffmpeg читает только из файла и только как apng; без -loop WebP играет один раз, а
                    // passthrough не даёт ему терять и дублировать кадры по времени
                    const args = anim
                        ? ['-f', 'apng', '-i', src, '-fps_mode', 'passthrough', '-c:v', 'libwebp_anim', '-quality', '85', '-compression_level', '4', '-loop', String(anim.plays), '-f', 'webp', tmp]
                        : ['-i', src, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '85', '-compression_level', '4', '-f', 'webp', tmp];
                    // Маркером отмечаем только отказ ffmpeg по формату (код выхода); таймаут, kill, spawn — не вина файла
                    await new Promise((resolve, reject) => {
                        const proc = spawn('ffmpeg', ['-v', 'error', '-y', ...args]);
                        const timer = setTimeout(() => proc.kill('SIGKILL'), VIEW_TIMEOUT_MS);
                        proc.on('error', (e) => { clearTimeout(timer); reject(e); });
                        proc.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(Object.assign(new Error(`ffmpeg: ${code}`), { exit: code })); });
                    }).catch(async (e) => {
                        transient = typeof e.exit !== 'number';
                        await fsp.rm(tmp, { force: true });
                    });
                    if (transient) throw new Error('ffmpeg: временный сбой');
                    const made = await fsp.stat(tmp).catch(() => null);
                    if (made && made.size > 20 && made.size <= img.data.length * VIEW_RATIO) {
                        if (anim) await fsp.writeFile(tmp, setLastFrameDelay(await fsp.readFile(tmp), anim.delay));
                        await fsp.rename(tmp, out);
                        this.viewBytes?.set(id, (this.viewBytes.get(id) || 0) + made.size);
                        ok = true;
                    }
                }
                if (!ok) await fsp.writeFile(out, '');
            } finally {
                await fsp.rm(tmp, { force: true });
                await fsp.rm(src, { force: true });
            }
            return ok;
        } finally {
            this.release(bg);
        }
    }

    // Сколько байт уже в view/ игры: считаем один раз, дальше прибавляем по мере записи; forget() сбрасывает
    async viewUsed(id) {
        this.viewBytes = this.viewBytes || new Map();
        if (!this.viewBytes.has(id)) {
            const dir = path.join(this.mediaDir, id, 'view');
            let n = 0;
            for (const f of await fsp.readdir(dir).catch(() => [])) n += (await fsp.stat(path.join(dir, f)).catch(() => null))?.size || 0;
            this.viewBytes.set(id, n);
        }
        return this.viewBytes.get(id);
    }

    // Смотрят картинку — следующие VIEW_AHEAD файлов её альбома готовим фоном: листают обычно вперёд.
    // Одну картинку обходим раз за запуск: пока листают сцену, повторные запросы одного файла обход не множат
    viewAhead(id, rel) {
        this.aheaded = this.aheaded || new Set();
        const mark = `${id}\n${rel}`;
        if (this.aheaded.has(mark)) return;
        if (this.aheaded.size > 5000) this.aheaded.clear();
        this.aheaded.add(mark);
        inBackground(async () => {
            const album = (await this.cached(id))?.albums.find((a) => a.files.includes(rel));
            if (!album) return;
            const next = album.files.indexOf(rel) + 1;
            for (const f of album.files.slice(next, next + VIEW_AHEAD)) await this.view(id, f, true).catch(() => {});
        }).catch(() => {});
    }

    // Открыли галерею — заранее, по одной (остальные ядра — тому, что человек открыл сам): обложки CG и анимаций
    // (склейку обложки ffmpeg делает дольше обычной миниатюры), начала анимаций из склеек — по PREWARM_FRAMES кадров
    // (откроет альбом — проигрывание уже идёт), потом обложки первых экранов остальных разделов. Раз за запуск сервера
    prewarm(id, index) {
        this.warmed = this.warmed || new Set();
        if (this.warmed.has(id)) return;
        this.warmed.add(id);
        const tab = (a) => (a.anim ? 'animation' : a.kind);
        const covers = (kind, n) => index.albums.filter((a) => tab(a) === kind).slice(0, n).map((a) => a.cover || a.files[0]);
        const starts = index.albums.filter((a) => tab(a) === 'animation').flatMap((a) => a.files.filter((f) => f.startsWith(CG_PREFIX)).slice(0, PREWARM_FRAMES));
        inBackground(async () => {
            for (const rel of [...covers('cg', Infinity), ...covers('animation', Infinity)]) await this.thumb(id, rel).catch(() => {});
            for (const rel of starts) await this.image(id, rel).catch(() => {});
            for (const rel of ['video', 'portrait', 'backdrop', 'dialogue'].flatMap((kind) => covers(kind, 24))) await this.thumb(id, rel).catch(() => {});
            // Первая картинка каждого альбома CG и анимаций: откроют её — лёгкая копия уже есть
            for (const rel of [...covers('cg', VIEW_PREWARM_CG), ...covers('animation', VIEW_PREWARM_ANIM)]) await this.view(id, rel, true).catch(() => {});
        });
    }

    slot() { return take(this.thumbLane); }

    release(bg) { give(this.thumbLane, bg); }

    // Фоном — оглавления всех игр, у которых их нет, по одной и с паузами: открыть галерею — сразу
    start(listIds) {
        const run = async () => {
            for (const id of await listIds()) {
                if (await this.cached(id)) continue;
                await this.build(id).promise;
                await new Promise((r) => setTimeout(r, 2000));
            }
        };
        setTimeout(() => run().catch((e) => console.error('[Галерея]', e.message)), 10 * 60 * 1000).unref();
    }
}

module.exports = new GalleryService();
module.exports.GalleryService = GalleryService;
module.exports.classify = classify;
module.exports.apngInfo = apngInfo;
module.exports.isRtp = isRtp;
module.exports.isFrameSequence = isFrameSequence;
module.exports.albumKey = albumKey;
module.exports.talkFigures = talkFigures;
module.exports.talkFigure = talkFigure;
module.exports.cropShots = cropShots;
module.exports.pngSize = pngSize;
module.exports.isAnimated = isAnimated;
module.exports.isLoop = isLoop;
module.exports.paFirstCell = paFirstCell;
module.exports.mocVersion = mocVersion;
module.exports.live2dCore = live2dCore;
module.exports.findLive2D = findLive2D;
module.exports.videoFlags = videoFlags;
module.exports.videoAlpha = videoAlpha;
module.exports.videoType = videoType;
module.exports.decrypt = decrypt;
module.exports.inBackground = inBackground;
