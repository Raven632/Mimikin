// Текст игры RPG Maker MV/MZ для перевода (services/translate.js): что переводить и как подставить
// перевод, ничего не сломав. Здесь только разбор и подстановка — без сети и без диска.
//
// Переводим только то, что игрок видит: реплики (401), прокрутку (405), варианты ответа (102 и их
// ветки 402), имя говорящего (101 у MZ), имена, описания и сообщения из базы (герои, классы,
// предметы, оружие, броня, навыки, состояния, враги), название карты на экране и термины меню.
// Не трогаем никогда: скрипты (355/655, 111, 122), команды плагинов (356/357), заметки (note),
// имена файлов, переключателей и переменных, параметры плагинов.
//
// Главная защита: строка, которая встречается в коде игры (скрипты событий, заметки, параметры и
// код плагинов), не переводится. Игра сравнивает с ней — «$gameActors.actor(1).name() === 'アリス'»,
// плагин ищет предмет по имени из заметки, — и перевод сломал бы это сравнение.

// Поля базы данных, которые видит игрок. Ключ — имя файла data/<Имя>.json
const DATABASE = {
    Actors: ['name', 'nickname', 'profile'],
    Classes: ['name'],
    Items: ['name', 'description'],
    Weapons: ['name', 'description'],
    Armors: ['name', 'description'],
    Skills: ['name', 'description', 'message1', 'message2'],
    States: ['name', 'message1', 'message2', 'message3', 'message4'],
    Enemies: ['name'],
};
// Команды событий с видимым текстом: код → какие параметры (101: 4 — имя говорящего у MZ)
const SHOWN = { 401: [0], 405: [0], 101: [4] };
// Команды, текст которых — код: строки из них защищены. Комментарии (108/408) — тоже: плагины читают из них
// свои теги («<選択肢ヘルプ>»)
const CODE_COMMANDS = new Set([355, 655, 111, 122, 356, 357, 657, 108, 408]);
// Японские и китайские буквы: так отличаем текст от служебных значений
const CJK_TEXT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;
// «Переменная = 'текст'» (122, операнд «скрипт» из одной строки в кавычках) — так игры пишут цель задания,
// место и подобное, что потом выводят через \V[n]. Текст в кавычках — видимый, если сравнения с ним нет
const LITERAL = /^\s*(['"])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1\s*$/;
// Значение JS-строки: «\\n» — перевод строки, «\\\\FS[18]» — «\\FS[18]» (код игры), «\\"» — кавычка
const unescapeJs = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (all, c) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[c] ?? c));
// Только с японскими (китайскими) буквами: латиница в кавычках — обычно ключ («door_open»), не текст
const literalOf = (cmd) => {
    const m = cmd?.code === 122 && cmd.parameters?.[3] === 4 && typeof cmd.parameters[4] === 'string' ? cmd.parameters[4].match(LITERAL) : null;
    // Редкие экранирования (\\x41, \\u{…}, восьмеричные, перенос через «\\») не разбираем — такая строка остаётся кодом
    if (!m || /\\(?:x|u\{|[1-7]|0[0-9]|\r?\n)/.test(m[2])) return null;
    const value = unescapeJs(m[2]);
    return CJK_TEXT.test(value) ? [m[0], m[1], value] : null;
};
// Текст в JS-кавычках: обратная косая, кавычка и переводы строк — экранированные, иначе скрипт не разберётся
const jsQuote = (q, v) => `${q}${String(v).replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}${q}`;


// Все списки команд файла: события карт (страницы), общие события, страницы отрядов
function commandLists(name, data) {
    if (/^Map\d+$/.test(name)) return (data?.events || []).flatMap((e) => (e?.pages || []).map((p) => p.list || []));
    if (name === 'CommonEvents') return (data || []).filter(Boolean).map((e) => e.list || []);
    if (name === 'Troops') return (data || []).filter(Boolean).flatMap((t) => (t.pages || []).map((p) => p.list || []));
    return [];
}

// Обход видимых строк файла: visit(строка, set, вид) для каждой. Один обход — и для сбора, и для подстановки.
// Вид — откуда строка, где это важно: 'variable' — значение переменной из скрипта, имя таблицы базы ('Actors')
function eachShown(name, data, visit) {
    for (const list of commandLists(name, data)) {
        for (const cmd of list) {
            const params = cmd?.parameters;
            if (!Array.isArray(params)) continue;
            for (const i of SHOWN[cmd.code] || []) {
                if (isText(params[i])) visit(params[i], (v) => { params[i] = v; });
            }
            // Варианты ответа: список строк; ветка «Когда …» (402) — тот же текст для редактора
            if (cmd.code === 102 && Array.isArray(params[0])) {
                params[0].forEach((s, i) => { if (isText(s)) visit(s, (v) => { params[0][i] = v; }); });
            }
            if (cmd.code === 402 && isText(params[1])) visit(params[1], (v) => { params[1] = v; });
            const lit = literalOf(cmd);
            if (lit && isText(lit[2])) {
                // Назад — в тех же кавычках
                visit(lit[2], (v) => { params[4] = jsQuote(lit[1], v); }, 'variable');
            }
        }
    }
    if (DATABASE[name]) {
        for (const row of data || []) {
            if (!row) continue;
            for (const key of DATABASE[name]) if (isText(row[key])) visit(row[key], (v) => { row[key] = v; }, name);
        }
    }
    if (/^Map\d+$/.test(name) && isText(data?.displayName)) visit(data.displayName, (v) => { data.displayName = v; });
    if (name === 'System' && data) {
        for (const key of ['elements', 'skillTypes', 'weaponTypes', 'armorTypes', 'equipTypes']) {
            (data[key] || []).forEach((s, i) => { if (isText(s)) visit(s, (v) => { data[key][i] = v; }); });
        }
        if (isText(data.currencyUnit)) visit(data.currencyUnit, (v) => { data.currencyUnit = v; });
        const terms = data.terms || {};
        for (const key of ['basic', 'commands', 'params']) {
            (terms[key] || []).forEach((s, i) => { if (isText(s)) visit(s, (v) => { terms[key][i] = v; }); });
        }
        for (const [key, s] of Object.entries(terms.messages || {})) {
            if (isText(s)) visit(s, (v) => { terms.messages[key] = v; });
        }
    }
}

// Строки кода файла: из скриптов и команд плагинов событий, из заметок базы. Их значения — защищены
function codeStrings(name, data, out) {
    for (const list of commandLists(name, data)) {
        for (const cmd of list) {
            if (!CODE_COMMANDS.has(cmd?.code) || !Array.isArray(cmd.parameters) || literalOf(cmd)) continue;
            const walk = (v) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
            walk(cmd.parameters);
        }
    }
    const notes = (rows) => (Array.isArray(rows) ? rows : []).forEach((r) => { if (typeof r?.note === 'string') out.push(r.note); });
    if (DATABASE[name] || name === 'Troops') notes(data);
    if (/^Map\d+$/.test(name)) {
        if (typeof data?.note === 'string') out.push(data.note);
        notes(data?.events);
    }
}

// Защита: видимая строка, которая встречается в коде игры как отдельное значение, не переводится. Из кода
// один раз собираем «куски» — и проверка строки мгновенная (поиск каждой строки по мегабайтам плагинов
// занимал бы на большой игре минуты, а сервер всё это время стоял бы):
//   scripts — строки из команд событий и заметок: сама строка, строки в кавычках и части через
//             разделители («<Drop: 薬草 3>» → «Drop», «薬草», «3»; «ShowPicture 森の入口» → «森の入口»);
//   plugins — служебные параметры плагинов (js/plugins.js; видимые — подписи, подсказки — переводятся) и
//             строки в кавычках из кода плагинов (без комментариев)
const SEPARATORS = /[\s<>:,;=()[\]{}"'`+|/\\!?&]+/;
const QUOTED = /'((?:[^'\\\n]|\\.){1,200})'|"((?:[^"\\\n]|\\.){1,200})"|`([^`\n]{1,200})`/g;

function addPieces(pieces, str) {
    const s = String(str);
    if (!s) return;
    pieces.add(s);
    pieces.add(s.trim());
    for (const part of s.split(SEPARATORS)) if (part) pieces.add(part);
    for (const m of s.matchAll(QUOTED)) {
        const q = m[1] ?? m[2] ?? m[3] ?? '';
        if (!q) continue;
        pieces.add(q);
        // И значение строки — как его видит игра: «\\FS[18]…\\n…» в скрипте сравнивается с «\FS[18]…⏎…»
        if (q.includes('\\')) pieces.add(unescapeJs(q));
        for (const part of q.split(SEPARATORS)) if (part) pieces.add(part);
    }
}

// Комментарии исходника плагина (шапка /*: … */ с @default, примерами и справкой) — не код: строки оттуда
// не защищаем, иначе «ゲーム終了» из справки плагина меню не дал бы перевести команду меню
const JS_PARTS = /`(?:\\[\s\S]|[^\\`])*`|(['"])(?:\\.|(?!\1)[^\\\n])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const stripComments = (source) => String(source).replace(JS_PARTS, (m) => (m[0] === '/' ? ' ' : m));

// Строки в кавычках из исходного кода плагина. Экранирование — как в JS: «\\C[2]» в коде — это «\C[2]»
function quotedOf(source, out) {
    for (const m of stripComments(source).matchAll(QUOTED)) {
        const raw = m[1] ?? m[2] ?? m[3] ?? '';
        let q = raw;
        try { q = JSON.parse(`"${raw.replace(/"/g, '\\"')}"`); } catch (e) { /* как есть */ }
        out.push(q);
    }
}

// Параметры плагинов (js/plugins.js), которые видит игрок: команды меню, подсказки, подписи окон. О том,
// что это, говорит имя параметра: «helpText», «Command Name», «テキスト1», «eroStaName» — текст; «fileName»,
// «ピクチャ1», «BGM», «Switch», «Font» — нет. Значение — с японскими (китайскими) буквами: английские значения
// обычно служебные. Значение параметра бывает JSON в строке (списки и структуры MV/MZ) — внутрь тоже.
// Одинаковые строки переводятся одинаково везде (словарь общий), поэтому сравнение «команда меню ==
// параметр symbol» после перевода сходится
const PARAM_TEXT = /text|name|label|command|title|help|desc|message|msg|term|caption|vocab|format|word|display|header|symbol|テキスト|名|表示|ヘルプ|説明|メッセージ|用語|コマンド|タイトル|見出し|ラベル|文字|文本|说明|内容|描述|标题|名称/i;
// Имена событий, общих событий, карт и отрядов не переводятся, и плагин ищет по ним как есть — такие
// параметры («Event Name», «Common Event») тоже не трогаем
const PARAM_NOT = /file|image|img|pict|bitmap|graphic|bgm|bgs|(?:^|[^a-z])se(?:[^a-z]|$)|sound|audio|face|char|font|switch|variable|script|eval|code|cond|note|tag|key|anim|path|folder|dir|icon|url|event|common[ _-]?ev|troop|map|事件|开关|变量|脚本|图片|文件|音效|图标|地图|条件|ピクチャ|画像|ファイル|音|スイッチ|変数|スクリプト|フォント|アイコン|顔|歩行|フォルダ|条件|タグ|メモ|キー|イベント|マップ/i;
// Путь к файлу («arina/other/クリック音１», «img/pictures/x.png») и код («$gameVariables.value(4)») — не текст
const PATH_RE = /^[^\s/]*\/[^\s]*$|\.(?:png|jpe?g|webp|gif|ogg|m4a|mp3|wav|webm|mp4|json|js)$/i;
// Коды игры (\C[2], \I[5]) — не часть пути: «\C[2]完了» — текст
const PATH_LIKE = { test: (v) => PATH_RE.test(String(v).replace(CODE, '')) };
const CODE_LIKE = /\$game|\$data|\bthis\.|=>|\bfunction\b|\)\s*;|\b(?:var|let|const|return)\s/;

// Типы параметров из шапки плагина (/*: … */ и /*~struct~Имя: … */): «@param msgAdvanceSeName» +
// «@type file» — это имя файла, сколько бы ни было «Name» в названии. text — строковые параметры
// (string, multiline_string и их списки), not — всё остальное: файлы, числа, переключатели, выбор из списка
function pluginParamTypes(source) {
    const text = new Set();
    const not = new Set();
    const note = new Set();      // @type note — многострочный текст или код: на экран, если имя говорит «текст»
    for (const block of String(source).match(/\/\*[:~][\s\S]*?\*\//g) || []) {
        let name = null;
        // Параметр без @type в RPG Maker — строка
        const untyped = () => { if (name && !text.has(name) && !not.has(name)) text.add(name); name = null; };
        for (const line of block.split(/\r?\n/)) {
            const p = line.match(/@param\s+(\S+)/);
            if (p) { untyped(); name = p[1]; continue; }
            // Команды плагина и их аргументы — не параметры: их @type к параметру не относится
            if (/@(?:command|arg)\b/.test(line)) { untyped(); continue; }
            const ty = line.match(/@type\s+(\S+)/);
            if (name && ty) {
                const t = ty[1].toLowerCase();
                if (/^struct</.test(t)) { name = null; continue; }   // поля структуры — в её блоке
                if (t === 'note') note.add(name);
                (/^(?:multiline_)?string(?:\[\])?$/.test(t) ? text : not).add(name);
                name = null;
            }
        }
        untyped();
    }
    return { text, not, note };
}

// 'file' — переводим в plugins.js (имя говорит: подпись, подсказка), 'display' — шапка говорит «строка», а
// имя ничего не говорит («難易度»): такой может оказаться ключом, по которому плагин ищет, — в файле не
// меняем (и защищаем), переводим только на экране; false — не текст
const paramKind = (key, value, types) => {
    if (typeof value !== 'string' || PATH_LIKE.test(value.trim()) || CODE_LIKE.test(value)) return false;
    if (!CJK_TEXT.test(value) || !isText(value) || PARAM_NOT.test(key)) return false;
    // Многострочный текст плагина (Drill: «详细说明JP») — только на экран: в файле это может быть и код
    if (types?.note?.has(key)) return PARAM_TEXT.test(key) ? 'display' : false;
    if (types?.not.has(key)) return false;
    if (PARAM_TEXT.test(key)) return 'file';
    if (types?.text.has(key)) return 'display';
    // Шапка о параметре молчит (плагин без справки): короткая подпись — только на экран, в файле — как была
    return value.length <= 40 && !/[<>{}[\]]/.test(value) ? 'display' : false;
};
const isParamText = (key, value, types) => paramKind(key, value, types) === 'file';

// Список плагинов из js/plugins.js и место, где он стоит в файле. Не разобрался — null
function pluginList(source) {
    const m = String(source).match(/\$plugins\s*=\s*(\[[\s\S]*\])\s*;?/);
    if (!m) return null;
    try { return { list: JSON.parse(m[1]), start: m.index + m[0].indexOf(m[1]), length: m[1].length }; } catch (e) { return null; }
}

// Обход параметров плагинов: visit(значение, имя параметра, set). Вложенный JSON после замены — снова в строку
function eachParam(list, visit) {
    const walk = (obj, k, key, depth, changed) => {
        const v = obj[k];
        if (typeof v === 'string') {
            if (depth < 5 && /^\s*[[{"]/.test(v)) {
                let inner;
                try { inner = JSON.parse(v); } catch (e) { inner = undefined; }
                if (inner !== undefined && (typeof inner === 'string' || (inner && typeof inner === 'object'))) {
                    const box = [inner];
                    let dirty = false;
                    walk(box, 0, key, depth + 1, () => { dirty = true; });
                    if (dirty) { obj[k] = JSON.stringify(box[0]); changed(); }
                    return;
                }
            }
            visit(v, key, (nv) => { obj[k] = nv; changed(); }, plugin);
        } else if (v && typeof v === 'object') {
            for (const kk of Object.keys(v)) walk(v, kk, Array.isArray(v) ? key : kk, depth, changed);
        }
    };
    let plugin = '';
    for (const p of Array.isArray(list) ? list : []) {
        if (p && p.status !== false && p.parameters && typeof p.parameters === 'object') {
            plugin = String(p.name || '');
            for (const k of Object.keys(p.parameters)) walk(p.parameters, k, k, 0, () => {});
        }
    }
}

// Параметры плагинов: служебные — в защиту (out), видимые — в text (если передан), имена параметров — в keys.
// types — Map(имя плагина → типы параметров из его шапки, pluginParamTypes)
function pluginParams(source, out, text, keys, types, display) {
    const parsed = pluginList(source);
    if (!parsed) { quotedOf(source, out); return; }
    eachParam(parsed.list, (v, key, set, plugin) => {
        if (keys) keys.add(key);
        const kind = paramKind(key, v, types?.get(plugin));
        if (kind === 'file') { if (text) text.push(v); return; }
        out.push(v);
        if (kind === 'display' && display) display.push(v);
    });
}

// js/plugins.js с переводом видимых параметров: tr(строка) → перевод или undefined. Ничего не перевели — null
function overlayPlugins(source, tr, types) {
    const parsed = pluginList(source);
    if (!parsed) return null;
    let changed = 0;
    eachParam(parsed.list, (v, key, set, plugin) => {
        if (!isParamText(key, v, types?.get(plugin))) return;
        const t = tr(v);
        if (t !== undefined && t !== v) { set(t); changed++; }
    });
    if (!changed) return null;
    const src = String(source);
    return src.slice(0, parsed.start) + JSON.stringify(parsed.list) + src.slice(parsed.start + parsed.length);
}

// Строки из кода плагинов защищают слабее: строка, равная имени параметра плагина («常時ダッシュ» в
// getParam(['AlwaysDash', '常時ダッシュ'])), — это чтение параметра, а не сравнение с текстом; стандартное
// слово меню (exempt — из словаря терминов) кодом плагинов не защищаем: плагин сравнивает «アイテム» с
// аргументом своей команды в событии, а команды событий не переводятся. Скрипты, заметки и файлы — защищают всё
function makeGuard({ scripts = [], plugins = '', pluginFiles = [], exempt = () => false, types = null } = {}) {
    const values = [...scripts];
    const keys = new Set();
    pluginParams(plugins, values, null, keys, types);
    const pieces = new Set();
    for (const v of values) addPieces(pieces, v);
    const literals = [];
    for (const src of pluginFiles) quotedOf(src, literals);
    const weak = new Set();
    for (const v of literals) if (!keys.has(v)) addPieces(weak, v);
    const has = (set, s) => set.has(s) || set.has(String(s).trim());
    return (s) => has(pieces, s) || (has(weak, s) && !exempt(s));
}

// Видимые параметры плагинов — для перевода в plugins.js
function pluginTexts(source, types) {
    const text = [];
    pluginParams(source, [], text, null, types);
    return text;
}

// Строковые по шапке параметры с ничего не говорящим именем — только для экрана
function pluginDisplayTexts(source, types) {
    const display = [];
    pluginParams(source, [], null, null, types, display);
    return display;
}

// Строки с японским в коде плагинов (без комментариев): подписи настроек, пункты меню, реплики, которые
// плагин выводит сам. В файлах их не меняем — переводятся только на экране (rpg-fixes, «перевод на экране»):
// игра внутри видит прежнюю строку, и её сравнения не ломаются
// Отладку и ошибки (console.log(…), throw new Error(…)) на экран не выводят — за них службе не платим
// Косая черта — не повод считать строку путём: «操作説明（1/3）操作», «オート/スキップ/ログ» — подписи. Путь
// к файлу игры отсекает сервис (имя совпадает с файлом игры), здесь — только расширения файлов
const FILE_EXT = /\.(?:png|jpe?g|webp|gif|ogg|m4a|mp3|wav|webm|mp4|json|js|txt|csv)$/i;
const DEBUG_CALLS = /\bconsole\.\w+\s*\([^;\n]*|\b(?:throw\s+new\s+\w*|new\s+\w*Error)\s*\([^;\n]*/g;
function pluginLiterals(source) {
    const out = [];
    quotedOf(stripComments(source).replace(DEBUG_CALLS, ''), out);
    return out.filter((q) => q.length <= 300 && !q.includes('${') && CJK_TEXT.test(q) && isText(q) && !FILE_EXT.test(q.trim()) && !CODE_LIKE.test(q));
}

// Шаблоны из кода плагинов: \`所持SP：\${sp()}\` → «所持SP：%1», \`\${day}日目／30日\` → «%1日目／30日». Переводятся
// с подстановками %1, %2 (служба их не видит, как коды игры), а на экране rpg-fixes узнаёт нарисованную строку
// по шаблону и ставит значения в перевод: «所持SP：6» → «SP: 6»
const TEMPLATE = /`((?:[^`\\$]|\\[\s\S]|\$(?!\{)|\$\{[^{}`]*\})*)`/g;
function pluginTemplates(source) {
    const out = [];
    for (const m of stripComments(source).replace(DEBUG_CALLS, '').matchAll(TEMPLATE)) {
        if (!m[1].includes('${')) continue;
        let n = 0;
        // Экранирование — как в JS: «\\n» — перевод строки, «\\\\C[2]» — «\\C[2]», как его увидит экран
        const key = m[1].replace(/\$\{[^{}`]*\}/g, () => `%${++n}`)
            .replace(/\\(.)/g, (all, c) => ({ n: '\n', t: '\t', r: '' }[c] ?? c));
        const fixed = key.replace(/%\d+/g, '');
        // Подстановки вплотную («%1%2») не разделить при узнавании; мало японского в постоянной части — шаблон
        // подходил бы к чему угодно
        if (n > 6 || key.length > 300 || /%\d+%\d+/.test(key) || (fixed.match(/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/gu) || []).length < 2
            || !isText(fixed) || CODE_LIKE.test(key)) continue;
        out.push(key);
    }
    return out;
}

// Служебные коды RPG Maker и плагинов: \C[2], \N[1], \V[3], \I[64], \{, \!, \., \|, \^, \>, \<, \$,
// коды плагинов \FS[24], \PX[10], теги <WordWrap>, подстановки %1. Переводчик их не видит: на их месте
// метки <x i="N"/>, которые все четыре службы сохраняют (режим XML/HTML)
const CODE = /\\[A-Za-z]+(?:\[[^\]\n]*\])?|\\[{}!.|^<>$\\]|<[^<>\n]{1,60}>|%\d+|[\r\n]+/g;

// Текст — то, в чём после кодов игры остаются буквы или цифры: «\\V[7]» (значение переменной) и «\\I[64]» —
// не текст, переводить в них нечего
function isText(s) {
    return typeof s === 'string' && /[\p{L}\p{N}]/u.test(s.replace(CODE, ''));
}

function protect(s) {
    const codes = [];
    const text = s.replace(CODE, (m) => {
        codes.push(m);
        // Перевод строки — тоже метка: службы склеивают строки как хотят
        return `<x i="${codes.length - 1}"/>`;
    });
    return { text, codes };
}

// Вернуть коды на место. Нет какого-то кода, лишний или повтор — перевод негоден: null (строка останется
// оригинальной). Пробелы, которые службы ставят вокруг меток, у кодов не нужны
function restore(translated, codes) {
    const seen = new Set();
    let bad = false;
    const out = String(translated || '').replace(/\s*<x\s+i\s*=\s*"(\d+)"\s*\/?>\s*(?:<\/x>)?/g, (m, n, offset, whole) => {
        const i = Number(n);
        if (i >= codes.length || seen.has(i)) { bad = true; return ''; }
        seen.add(i);
        const code = codes[i];
        // Пробел до и после метки — как был в оригинале у слов вокруг, кроме переводов строки и %1
        const before = /^\s/.test(m) && !/^[\r\n]/.test(code) && offset > 0 ? ' ' : '';
        const after = /\s$/.test(m) && !/^[\r\n]/.test(code) && offset + m.length < whole.length ? ' ' : '';
        return `${before}${code}${after}`;
    });
    if (bad || seen.size !== codes.length || /<\/?x\b/.test(out)) return null;
    return spaceCodes(out);
}

// В японском между словами пробелов нет, и службы часто так и оставляют метку вплотную: «одна\\C[2]дочь» —
// на экране «однадочь». Цвет, имя, значок или переменная между двумя буквами — граница слов: ставим пробел
// перед кодами. Паузы и управление выводом (\\. \\| \\! \\{ \\>) стоят и внутри слова («Н\\.\\.\\.нет») — их
// не трогаем; переводы строк — тоже, там граница и так есть. Цифра перед кодом («50\\C[0]G») — число с
// единицей, слитно, как в оригинале. Японские, китайские и корейские буквы (имя без перевода) — без
// пробелов: у них их между словами нет
const WORD = '(?![\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}])[\\p{L}\\p{N}]';
// Коды без переводов строк — одной регуляркой (её же берёт utils/tlcheck.js)
const INLINE = /\\[A-Za-z]+(?:\[[^\]\n]*\])?|\\[{}!.|^<>$\\]|<[^<>\n]{1,60}>|%\d+/;
const GLUED = new RegExp(`(${WORD})((?:${INLINE.source})+)(?=${WORD})`, 'gu');
const WORDY = /\\[CNIVP]\[/i;
function spaceCodes(s) {
    return s.replace(GLUED, (m, before, codes) => (WORDY.test(codes) && !/\p{N}/u.test(before) ? `${before} ${codes}` : m));
}

// Шаблоны с подстановками («%1／30日目・%2») служба переводит лучше, когда вместо меток стоят числа: «Day 71/30 ·
// 83», а не «%1 / Day 30: %2». Числа — такие, которых в строке нет; после перевода — обратно в %1, %2.
// Не вышло (число потерялось или повторилось) — null: такую строку переводим прежним способом, с метками
const SAMPLES = ['71', '83', '94', '62', '57', '48', '39', '26', '15'];
function numberTemplate(s) {
    if (!/%\d/.test(s)) return null;
    const digits = String(s).replace(/%\d+/g, ' ').match(/\d+/g) || [];
    const pool = SAMPLES.filter((x) => !digits.some((d) => d.includes(x) || x.includes(d)));
    const map = {};
    const count = {};
    let used = 0;
    const text = String(s).replace(/%(\d+)/g, (m, n) => {
        if (!map[n]) map[n] = pool[used++];
        count[n] = (count[n] || 0) + 1;
        return map[n] || m;
    });
    if (used > pool.length || Object.values(map).some((v) => !v)) return null;
    return { text, map, count };
}
function numbersBack(t, { map, count }) {
    let out = String(t);
    for (const [n, v] of Object.entries(map)) {
        const re = new RegExp(`(?<![0-9])${v}(?![0-9])`, 'g');
        if ((out.match(re) || []).length !== count[n]) return null;
        out = out.replace(re, `%${n}`);
    }
    return out;
}

// Перевод на экране: «…» в шрифте перевода (японский M PLUS) — во всю клетку, точки посередине, а «・・・»
// японских строк служба иногда оставляет как есть. Показываем обычными точками
function displayText(s) {
    return String(s).replace(/[…⋯]/g, '...').replace(/‥/g, '..').replace(/・{2,}/g, (m) => (m.length >= 3 ? '...' : '..'));
}

module.exports = { DATABASE, CODE, INLINE, commandLists, eachShown, codeStrings, makeGuard, protect, restore, isText, spaceCodes, pluginTexts, overlayPlugins, displayText, pluginParamTypes, pluginLiterals, pluginDisplayTexts, pluginTemplates, numberTemplate, numbersBack };
