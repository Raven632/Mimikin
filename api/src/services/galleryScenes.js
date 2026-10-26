// Сцены игры, которых нет в файлах-картинках: их собирает само событие — показывает слои и кадры (команды
// «Показать картинку», «Переместить», «Стереть», скрипты и плагины анимации), между ними реплики и паузы. Игру не
// запускаем: событие «прокручиваем» на бумаге и снимаем кадр на каждой реплике и паузе — какие картинки в этот миг на
// экране. Кадр потом склеивает ffmpeg (gallery.js, renderFrame). Что умеем и чего нет:
//   есть   — показать, переместить (конечное положение), стереть, общие события внутри; все ветки «Если» и все
//            варианты выбора (варианты сцены: одежда, состояние героини), каждая — от того, что было до развилки;
//            переменные и переключатели, которые событие само ставит (условие с ними — по-настоящему, цикл со
//            счётчиком — до конца); скрипт «$gameScreen.showPicture(…)» с простыми выражениями; плагин
//            PictureAnimation (кадры-файлы и листы кадров); Spine-плагины PictureSpine и PKD Spine2DPlayer и Live2D-плагины
//            PictureLive2D и Live2DInterfaceMZ — только для сценария плеера (врезка поверх картинок сцены, шаги spine и l2d),
//            в кадры альбомов не попадают; имя с переменной,
//            которой не знаем, — все подходящие файлы;
//            имя героя, которое сцена ставит сама, и бросок случайного числа — только для сценария плеера: игра играет одну
//            ветку выбора по имени, остальные из сценария убираем; кадры от этого не зависят;
//   нет    — положение по переменной, которой не знаем (ставим 0,0), режимы смешивания, поворот и оттенок.
// Сцена — то, где идут картинки во весь экран (CG и слои), не портреты в разговоре: портрет повторяется во многих
// событиях, CG — в одном-двух

const MAX_DEPTH = 3;
const MAX_FRAMES = 200;
const MAX_STEPS = 8000;      // команд на сцену: общие события зовут друг друга, лишнее не крутим
const LOOP_MAX = 40;         // проходов цикла: счётчик кадров анимации крутит его до конца, вечный цикл — нет
const ALT_MAX = 40;          // файлов на имя с неизвестной переменной: больше — имя слишком общее («tachie/» + кто), не гадаем
const ANIM_CELLS = 200;      // кадров анимации плагина в клип (больше плагин и не умеет)
const ANIM_FRAMES = 1500;    // кадров анимаций плагина на сцену — свой предел: они не вытесняют кадры сцены
const CG_REUSE = 3;          // картинка в большем числе сцен — портрет или фон, не CG
const ANIM_WAIT = 12;        // кадров игры: пауза короче — раскадровка анимации, длиннее — смена кадра сцены
const MENTIONS_MAX = 30;     // имён картинок в аргументах плагинов и скриптов события: больше — это список предзагрузки, не сцена
const ALT_FRAMES = 60;       // кадров из других веток на сцену: «гардероб» (одежда × стадия) дал бы тысячи
const WILD = '\u0001';       // часть имени, которой не знаем (переменная)
const SCRIPT_STEPS = 1500;   // шагов сценария на сцену (картинка, реплика, звук, пауза): длиннее плеер всё равно не пролистают
const EXT_STEPS = 20000;     // команд на сцену из разворота ExternMessage (и из общих событий, что он зовёт): свой счёт, чтобы
                             // диалог из CSV не съедал MAX_STEPS сцены — иначе страницы CG выпадали бы из альбомов
const EXT_SCRIPT = 1500;     // шагов сценария от разворота ExternMessage: длинный разговор не вытесняет шаги самой сцены
const AUDIO_KIND = { 241: 'bgm', 245: 'bgs', 249: 'me', 250: 'se' };
// Ролики на экране (MoviePicture на картинке, PKD_VPlayer, «Показать видео»): шагом vid для плеера
const VID_MAX = 4;           // роликов разом (верхние): больше на телефоне не потянуть
const VID_STEPS = 400;       // шагов роликов (vid, vwait) на сцену — свой счёт: реплики из-за них не уходят за SCRIPT_STEPS
const PRELOAD_LIMIT = 10;    // «MP_SET_LIMIT n f», f ≤ 10 кадров — подгрузка ролика (показать и стереть), не показ
const VSCENE_LINES = 3;      // реплик под своим роликом сцены — сцена из одних роликов
const VSCENE_PAGES = 3;      // страниц одного события карты с тем же роликом — это персонаж стоит (NPC), не сцена
const LATE_LINES = 10;       // реплик в позднем событии, чтобы стать второй сценой чужого альбома (решение владельца, шаг 12a)
const ASCENE_LINES = 5;      // реплик в сцене с анимацией: короче — реплика у двери, а не сцена
// Ролик, который не сцена: персонаж стоит («idle», «待機»), NPC, титульный экран, меню, «図鑑» — как NOT_CG у картинок
const VIDEO_NOT_SCENE = /idle|待機|(?:^|[_\-/ ])npc|title|タイトル|menu|メニュー|zukan|図鑑/i;
// Движение в сценарии: анимации плагина играют под репликами, циклы-анимации события — по кругу, экран гаснет и светлеет
const LOOP_SCRIPT = 160;     // шагов сценария на повторы одного цикла-анимации (проходы 2…N), потом — как раньше, тихо
const LOOP_SCRIPT_WAIT = 1800; // кадров игры в повторах цикла: дольше смотреть одно и то же незачем
const DECOR_MAX = 600;       // шагов «украшений» на сцену (затемнения, повторы цикла, анимации на том же экране): своя полоса, реплики не вытесняют
const ANIM_STEP = 120;       // кадров одной анимации в сценарии (плеер держит все в памяти); больше — выборка по сетке
const ANIM_LCM = 1200;       // кадров игры в круге анимации: общее кратное темпов, дольше — кратное самого длинного
const FADE = 24;             // кадров игры на затемнение командами 221 и 222
// Параллельные страницы, которые включает сцена (страница карты «параллельно» с условием, общее событие «параллельно»
// с переключателем): их петля идёт под репликами сцены
const PAR_MAX = 60;          // включений и пересчётов параллельных страниц на сцену
const PAR_STEPS = 4000;      // команд на проходы одной страницы
const PAR_WAIT = 30;         // кадров игры на кадр петли: медленнее — таймер, слайд-шоу, интерфейс, не анимация сцены
const PAR_FRAMES = 1500;     // кадров клипов параллельных страниц на сцену
const PAR_SCRIPT = 400;      // кадров петель параллельных страниц в сценарии плеера на сцену
// Spine в сценах (PictureSpine: скелет на картинке; PKD Spine2DPlayer: CreateSAnim/SAnim/RemoveSAnim). Шаг spine — снимок
// одного слоя; в кадры альбомов он не идёт, поэтому альбомы, обложки и обрезки от него не меняются
const SPINE_SAYS = 2;        // реплик под скелетом набора, чтобы событие без картинок стало сценой его альбома Spine
const SPINE_SETS = 4;        // наборов в одном событии: комната воспоминаний и «случайная ловушка» перебирают все — не сцена
const SPINE_REUSE = 10;      // событий, что показывают набор «чужим» общим событием: полоска «желание», боевая кукла — интерфейс
const L2D_REUSE = 20;        // событий с одной моделью Live2D: больше — портрет говорящего (у Welcome 50+), а не сцена (у моделей сцен — до 16
                             // с копиями из комнаты воспоминаний). Своё/чужое здесь не различаем: модель показывают общие события-«кирпичи»
const SPINE_STEPS = 300;     // шагов spine на сцену — свой счёт: реплики из-за них не уходят за SCRIPT_STEPS (в игре — до 12)
// Live2D живёт в тех же слоях и на тех же пределах, что Spine (шаг l2d вместо spine): модель — набор, движения — анимации
const isRig = (x) => x.k === 'spine' || x.k === 'l2d';

// Имя картинки, которая не CG: портрет в рост, фон, значок, подсказка, «лицо с эмоцией». Словами целиком:
// «standing_doggy», «facial» — CG
const NOT_CG = /立ち?絵|立绘|背景|タイトル|ステータス|メニュー|(?:^|[_\-/ ])stand(?:ing)?(?:[_\- ]?(?:image|pic))?(?:\d|$|[_\- ]\d)|title|status|menu|screenshot|gameover|(?:^|[_\-/ ])(?:tachie?|tati(?:e)?|bg|guide|button|tips|ui|face|bust|portrait|window|icon|logo|cursor|gauge|dialog|happy|sad|angry|normal|smile|surprised?|a[wk]{1,2}ward|cry|shy|troubled|worried|nervous)(?:[_\-/ ]|\d|$)/i;
// Лицо и эмоция в имени («face», «angry», «smile») — у портрета разговора. Деталь на холсте сцены (слой или CG во весь
// экран) с таким именем — часть CG: лицо героини поверх тела («Ed2_2face_angry» у Dragon Post Office)
const SOFT_NOT_CG = /(?:^|[_\-/ ])(?:face|happy|sad|angry|normal|smile|surprised?|a[wk]{1,2}ward|cry|shy|troubled|worried|nervous)(?=[_\-/ ]|\d|$)/gi;
const notCgPart = (name, kind) => NOT_CG.test(name) && !(['layer', 'cg'].includes(kind) && !NOT_CG.test(name.replace(SOFT_NOT_CG, '_')));

const samePics = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- Выражения скриптов: строки, числа, «+», переменные игры и свои переменные скрипта. Чего не знаем — UNKNOWN,
// в строке — WILD (имя файла с неизвестной частью)
const UNKNOWN = Symbol('unknown');
const TOKEN = /\s+|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*)|(===|!==|==|!=|>=|<=|&&|\|\||\+\+|--|\+=|-=|.)/gy;
function tokenize(src) {
    const out = [];
    TOKEN.lastIndex = 0;
    for (let m; TOKEN.lastIndex < src.length && (m = TOKEN.exec(src));) {
        if (m[1]) {
            const q = m[1][0];
            let s = m[1].slice(1, -1);
            // Шаблон `a${b}c` — середины не знаем
            if (q === '`') s = s.replace(/\$\{[^}]*\}/g, WILD);
            // «\x1b», «\u001b» — настоящие знаки (скрипт события кладёт в переменную «\x1bN[14]» с ESC вместо косой), прочее — сам знак
            out.push({ t: 'str', v: s.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|(.))/g, (m, x, u, c) => (x || u ? String.fromCharCode(parseInt(x || u, 16)) : c)) });
        } else if (m[2]) out.push({ t: 'num', v: Number(m[2]) });
        else if (m[3]) out.push({ t: 'id', v: m[3] });
        else if (m[4]) out.push({ t: 'op', v: m[4] });
    }
    return out;
}

function evaluate(tokens, env) {
    let at = 0;
    const peek = (k = 0) => tokens[at + k];
    const eat = (v) => (tokens[at] && tokens[at].t !== 'str' && tokens[at].v === v ? (at++, true) : false);
    const text = (v) => (v === UNKNOWN ? WILD : typeof v === 'string' ? v : String(v));
    const num = (a, b, f) => (typeof a === 'number' && typeof b === 'number' ? f(a, b) : UNKNOWN);
    const known = (v) => v !== UNKNOWN && !(typeof v === 'string' && v.includes(WILD));
    const cmp = (a, b, op) => {
        if (!known(a) || !known(b)) return UNKNOWN;
        switch (op) {
            case '==': case '===': return a == b; // eslint-disable-line eqeqeq
            case '!=': case '!==': return a != b; // eslint-disable-line eqeqeq
            case '>=': return a >= b;
            case '<=': return a <= b;
            case '>': return a > b;
            case '<': return a < b;
            default: return UNKNOWN;
        }
    };
    const skipCall = () => { for (let depth = 1; at < tokens.length && depth;) { const v = tokens[at++].v; if (v === '(') depth++; else if (v === ')') depth--; } };
    function args() {
        const out = [];
        if (eat(')')) return out;
        do out.push(expr()); while (eat(','));
        eat(')');
        return out;
    }
    function primary() {
        const t = tokens[at++];
        if (!t) return UNKNOWN;
        if (t.t === 'num' || t.t === 'str') return t.v;
        if (t.v === '(') { const v = expr(); eat(')'); return v; }
        if (t.t !== 'id') return UNKNOWN;
        if (t.v === 'true') return true;
        if (t.v === 'false') return false;
        if ((t.v === '$gameVariables' || t.v === '$gameSwitches') && peek()?.v === '.') {
            const store = t.v === '$gameVariables' ? env.vars : env.sw;
            const m = peek(1)?.v;
            if (m === 'value' && peek(2)?.v === '(') { at += 3; const [n] = args(); return typeof n === 'number' && store.has(n) ? store.get(n) : UNKNOWN; }
            if (m === '_data' && peek(2)?.v === '[') { at += 3; const n = expr(); eat(']'); return typeof n === 'number' && store.has(n) ? store.get(n) : UNKNOWN; }
        }
        if (t.v === 'String' && eat('(')) { const [v] = args(); return text(v); }
        if (t.v === 'Number' && eat('(')) { const [v] = args(); return typeof v === 'number' ? v : known(v) && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : UNKNOWN; }
        if (t.v === 'Math' && peek()?.v === '.' && peek(2)?.v === '(') {
            const f = peek(1).v;
            at += 3;
            const [v] = args();
            return typeof v === 'number' && ['floor', 'round', 'ceil', 'abs'].includes(f) ? Math[f](v) : UNKNOWN;
        }
        return env.js.has(t.v) ? env.js.get(t.v) : UNKNOWN;
    }
    function postfix(v) {
        for (;;) {
            if (peek()?.v === '.' && peek(1)?.t === 'id') {
                const m = peek(1).v;
                at += 2;
                if (eat('(')) {
                    const a = args();
                    if (m === 'padZero' && typeof a[0] === 'number') v = v === UNKNOWN ? WILD : String(v).padStart(a[0], '0');
                    else if (m === 'toString') v = text(v);
                    else v = UNKNOWN;
                } else v = UNKNOWN;
                continue;
            }
            if (peek()?.v === '(') { at++; skipCall(); v = UNKNOWN; continue; }
            if (peek()?.v === '[') { at++; expr(); eat(']'); v = UNKNOWN; continue; }
            return v;
        }
    }
    function unary() {
        if (eat('-')) { const v = unary(); return typeof v === 'number' ? -v : UNKNOWN; }
        if (eat('!')) { const v = unary(); return typeof v === 'boolean' ? !v : UNKNOWN; }
        return postfix(primary());
    }
    function prod() {
        let v = unary();
        for (;;) {
            if (eat('*')) v = num(v, unary(), (a, b) => a * b);
            else if (eat('/')) v = num(v, unary(), (a, b) => (b ? a / b : UNKNOWN));
            else if (eat('%')) v = num(v, unary(), (a, b) => (b ? a % b : UNKNOWN));
            else return v;
        }
    }
    function sum() {
        let v = prod();
        for (;;) {
            if (eat('+')) {
                const w = prod();
                v = typeof v === 'string' || typeof w === 'string' ? text(v) + text(w) : num(v, w, (a, b) => a + b);
            } else if (eat('-')) v = num(v, prod(), (a, b) => a - b);
            else return v;
        }
    }
    function compare() {
        let v = sum();
        while (peek() && peek().t === 'op' && ['==', '===', '!=', '!==', '>=', '<=', '>', '<'].includes(peek().v)) {
            const op = tokens[at++].v;
            v = cmp(v, sum(), op);
        }
        return v;
    }
    // «и» и «или» — слабее сравнений, «и» сильнее «или»; неизвестное с ложью («и») — ложь, с истиной («или») — истина
    const truth = (v) => (known(v) ? !!v : UNKNOWN);
    function and() {
        let v = compare();
        while (eat('&&')) { const a = truth(v); const b = truth(compare()); v = a === false || b === false ? false : a === true && b === true ? true : UNKNOWN; }
        return v;
    }
    function or() {
        let v = and();
        while (eat('||')) { const a = truth(v); const b = truth(and()); v = a === true || b === true ? true : a === false && b === false ? false : UNKNOWN; }
        return v;
    }
    function expr() {
        const v = or();
        if (eat('?')) {
            const a = expr();
            eat(':');
            const b = expr();
            return v === true ? a : v === false ? b : UNKNOWN;
        }
        return v;
    }
    return expr();
}

// Что может записать общее событие (и те, что оно зовёт): диапазоны переменных и переключателей, самопереключатели, имена
// героев. all — не знаем что (номер из выражения, скрипт в обход setValue, плагин, который сам говорит про переменные).
// Нужно, когда событие не открыли из-за глубины: забываем только это, а не все значения сцены
const WRITES = new WeakMap();
function ceWrites(ces, id, seen = new Set()) {
    let memo = WRITES.get(ces);
    if (!memo) WRITES.set(ces, (memo = new Map()));
    if (!seen.size && memo.has(id)) return memo.get(id);
    const w = { v: [], s: [], self: false, names: false, all: false };
    seen.add(id);
    const list = (ces[id] && ces[id].list) || [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        const p = c.parameters || [];
        if (c.code === 121) w.s.push([p[0], p[1]]);
        else if (c.code === 122) w.v.push([p[0], p[1]]);
        else if (c.code === 123) w.self = true;
        // Ввод числа, выбор предмета, данные места на карте: переменную в p[0] ставит игра или игрок
        else if (c.code === 103 || c.code === 104 || c.code === 285) w.v.push([p[0], p[0]]);
        else if (c.code === 320) w.names = true;
        else if (c.code === 117 && ces[p[0]] && !seen.has(p[0])) {
            const x = ceWrites(ces, p[0], seen);
            w.v.push(...x.v); w.s.push(...x.s);
            w.self = w.self || x.self; w.names = w.names || x.names; w.all = w.all || x.all;
        } else if (c.code === 355 || (c.code === 111 && p[0] === 12)) {
            let src = String(c.code === 355 ? p[0] || '' : p[1] || '');
            while (c.code === 355 && list[i + 1] && list[i + 1].code === 655) src += `\n${list[++i].parameters?.[0] ?? ''}`;
            for (const m of src.matchAll(/\$game(Switches|Variables)\s*\.\s*setValue\s*\(\s*(\d+)\s*,/g)) (m[1] === 'Switches' ? w.s : w.v).push([Number(m[2]), Number(m[2])]);
            // setValue с номером из выражения, запись в _data, самопереключатель скриптом — что записано, не знаем
            const lit = (src.match(/\$game(?:Switches|Variables)\s*\.\s*setValue\s*\(\s*\d+\s*,/g) || []).length;
            if ((src.match(/\.\s*setValue\s*\(/g) || []).length > lit || /\b_data\b|\$gameSelfSwitches/.test(src)) w.all = true;
            if (/setName\s*\(|\._name\b/.test(src)) w.names = true;
        } else if ((c.code === 356 || c.code === 357) && /var(?:iable)?|switch|変数|スイッチ/i.test(JSON.stringify(p))) w.all = true;
    }
    seen.delete(id);
    if (!seen.size) memo.set(id, w);
    return w;
}

// Общее событие не открыли — забываем то, что оно могло записать (w из ceWrites)
function forgetWrites(st, w) {
    if (w.all) { st.vars.clear(); st.sw.clear(); st.self.clear(); st.names.clear(); st.rnd.clear(); return; }
    for (const [a, b] of w.v) for (const k of [...st.vars.keys()]) if (k >= a && k <= b) { st.vars.delete(k); st.rnd.delete(k); }
    for (const [a, b] of w.s) for (const k of [...st.sw.keys()]) if (k >= a && k <= b) st.sw.delete(k);
    if (w.self) st.self.clear();
    if (w.names) st.names.clear();
}

// Конец блока в фигурных скобках: j — на «{», результат — сразу за парной «}» (-1, если не закрыта). Строки в кавычках
// скобок не считают
function braceEnd(src, j) {
    let d = 0;
    let q = null;
    for (let i = j; i < src.length; i++) {
        const ch = src[i];
        if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
        // Блочный комментарий: апостроф («it's») или скобка в нём не строка и не блок. «//» до конца строки
        if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
        if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); if (e < 0) return -1; i = e; continue; }
        if (ch === '{') d++;
        else if (ch === '}' && !--d) return i + 1;
    }
    return -1;
}

// Первое «if (…) {…}» скрипта с ветками «else {…}» и «else if (…) {…}…»: { at — где начинается, cond, a — ветка «если»,
// b — ветка «иначе» (текст, в том числе цепочка else-if) или null, end — где блок кончается }. «if (…) действие;» без скобок
// не трогаем — оно остаётся обычным оператором
function ifBlock(src) {
    let q = null;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
        if (ch === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); if (j < 0) return null; i = j; continue; }
        if (ch === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); if (j < 0) return null; i = j + 1; continue; }
        if (!/^if\s*\(/.test(src.slice(i, i + 12)) || /[\w$.]/.test(src[i - 1] || '')) continue;
        const open = src.indexOf('(', i);
        const cond = callArgs(src, open + 1).join(',');
        let j = open + 1 + cond.length + 1;
        while (/\s/.test(src[j] || '')) j++;
        if (src[j] !== '{') continue;
        const aEnd = braceEnd(src, j);
        if (aEnd < 0) return null;
        const out = { at: i, cond, a: src.slice(j + 1, aEnd - 1), b: null, end: aEnd };
        let k = aEnd;
        while (/\s/.test(src[k] || '')) k++;
        if (!/^else\b/.test(src.slice(k))) return out;
        k += 4;
        while (/\s/.test(src[k] || '')) k++;
        if (src[k] === '{') { const e = braceEnd(src, k); if (e < 0) return out; out.b = src.slice(k + 1, e - 1); out.end = e; return out; }
        const sub = ifBlock(src.slice(k));
        if (sub && sub.at === 0) { out.b = src.slice(k, k + sub.end); out.end = k + sub.end; return out; }
        // «else if (…) действие;» и «else действие;» без скобок: ветка — один оператор до «;» или конца строки. Иначе хвост
        // шёл бы обычным оператором, и ветка «иначе» выполнялась бы всегда
        let sq = null;
        let par = 0;
        let e = k;
        for (; e < src.length; e++) {
            const ch = src[e];
            if (sq) { if (ch === '\\') e++; else if (ch === sq) sq = null; continue; }
            if (ch === '"' || ch === "'" || ch === '`') sq = ch;
            else if (ch === '(') par++;
            else if (ch === ')') par--;
            else if (!par && (ch === ';' || ch === '\n')) break;
        }
        out.b = src.slice(k, e + 1);
        out.end = Math.min(e + 1, src.length);
        return out;
    }
    return null;
}

// Скрипт на операторы: «;», переводы строк и фигурные скобки вне круглых
function statements(src) {
    const out = [];
    let cur = '';
    let depth = 0;
    let q = null;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (q) {
            cur += ch;
            if (ch === '\\') cur += src[++i] || '';
            else if (ch === q) q = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
        if (ch === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j - 1; continue; }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        else if (!depth && (ch === ';' || ch === '\n' || ch === '{' || ch === '}')) {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

// Аргументы вызова: текст от открывающей скобки до парной закрывающей, по запятым верхнего уровня
function callArgs(src, from) {
    const out = [];
    let depth = 0;
    let q = null;
    let cur = '';
    for (let i = from; i < src.length; i++) {
        const ch = src[i];
        if (q) { cur += ch; if (ch === '\\') cur += src[++i] || ''; else if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        if (ch === ')' || ch === ']' || ch === '}') {
            if (!depth) { out.push(cur); return out; }
            depth--;
        }
        if (ch === ',' && !depth) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out;
}

const PA_DIR = { 縦: 'v', v: 'v', vertical: 'v', 横: 'h', h: 'h', horizon: 'h', 連番: 'n', n: 'n', number: 'n' };

// Ветки блока, который начинается на i: [[начало, конец)…] и где он кончается. «Если» — до 411/412, выбор — 402/403
// до 404, бой — 601/602/603 до 604: всё на том же отступе
function blockOf(cmds, i) {
    const ind = cmds[i].indent || 0;
    const code = cmds[i].code;
    const heads = code === 111 ? [411] : code === 102 ? [402, 403] : [601, 602, 603];
    const last = code === 111 ? 412 : code === 102 ? 404 : 604;
    const branches = [];
    let start = code === 111 ? i + 1 : -1;
    for (let j = i + 1; j < cmds.length; j++) {
        const c = cmds[j];
        if (!c || (c.indent || 0) > ind) continue;
        if (heads.includes(c.code) && (c.indent || 0) === ind) { if (start >= 0) branches.push([start, j]); start = j + 1; continue; }
        if (c.code === last && (c.indent || 0) === ind) { if (start >= 0) branches.push([start, j]); return { branches, end: j }; }
        // Блок оборвался (бой без веток «победа/поражение» — обычная команда): что успели — ветками
        if (start >= 0 && code === 111) branches.push([start, j]);
        return { branches, end: j - 1 };
    }
    if (start >= 0) branches.push([start, cmds.length]);
    return { branches, end: cmds.length - 1 };
}

// Цепочки выбора по имени и броску. Игра пишет «если имя = А — звук А; если имя = Б — звук Б…» подряд, и выполняется
// одна ветка. Мы же идём по всем ветвям (кадры альбомов так и считаются), и в сценарии оказываются звуки всех сразу.
// Сцена знает имя героя (команда «Изменить имя») и бросок («Переменная: случайное»), и тогда лишнее убираем из
// сценария уже после обхода ветки; кадры, альбомы и обрезки от этого не зависят — обход остаётся как был
const CHAIN_MIN = 3;                                   // разных значений одного вопроса, чтобы подряд идущие «Если» были выбором
const INSTANT = new Set(['snd', 'stop', 'pics', 'fx']); // шаги без времени: ветка из одних них не читается и не ждёт; остальное — содержание
const SCREEN = new Set(['pics', 'anim', 'vid', 'spine', 'l2d']);      // состояние экрана: не выкидываем, его мог записать только пропущенный шаг
const OVERLAP = new Set(['se', 'me']);                 // звуки, что играют вместе; музыка, фон и голос в плеере — по одному
const chainMemo = new WeakMap();

// Что проверяет условие «Если»: { key — о чём, val — с чем сравнивает } или null (не равенство)
function askOf(p) {
    if (p[0] === 1 && p[2] === 0 && p[4] === 0) return { key: `v${p[1]}`, val: String(p[3]) };
    if (p[0] === 4 && (p[2] === 1 || p[2] === 2)) return { key: `a${p[1]}:${p[2]}`, val: String(p[3]) };
    if (p[0] === 12) {
        const m = /^\s*(.+?)\s*===?\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)\s*$/.exec(String(p[1] || ''));
        if (!m || /&&|\|\||<=|>=|!=|==|<|>|\?/.test(m[1])) return null;
        const num = /^-?\d/.test(m[2]);
        const v = /^\$gameVariables\.value\((\d+)\)$/.exec(m[1].replace(/\s+/g, ''));
        if (v && num) return { key: `v${v[1]}`, val: String(Number(m[2])) };
        return { key: `s${m[1].replace(/\s+/g, '')}`, val: num ? String(Number(m[2])) : m[2].slice(1, -1) };
    }
    return null;
}

// Выборы в списке команд: индекс «Если» → { chain: { first, last, key }, val }. Выбор — подряд идущие «Если» на одном
// отступе (между ними только комментарии) с одним вопросом и 3+ разными ответами. Просматриваем все «Если», не прыгая
// через тела: вложенный выбор тоже найдётся
function selectors(cmds) {
    if (chainMemo.has(cmds)) return chainMemo.get(cmds);
    const out = new Map();
    const done = new Set();
    for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i];
        if (!c || c.code !== 111 || done.has(i)) continue;
        const a = askOf(c.parameters || []);
        if (!a) continue;
        const ind = c.indent || 0;
        const run = [{ at: i, val: a.val }];
        for (let cur = i; ;) {
            let j = blockOf(cmds, cur).end + 1;
            while (cmds[j] && (cmds[j].code === 108 || cmds[j].code === 408) && (cmds[j].indent || 0) === ind) j++;
            const n = cmds[j];
            const b = n && n.code === 111 && (n.indent || 0) === ind ? askOf(n.parameters || []) : null;
            if (!b || b.key !== a.key) break;
            run.push({ at: j, val: b.val });
            cur = j;
        }
        for (const m of run) done.add(m.at);
        if (new Set(run.map((m) => m.val)).size < CHAIN_MIN) continue;
        const chain = { first: run[0].at, last: run[run.length - 1].at, key: a.key };
        for (const m of run) out.set(m.at, { chain, val: m.val });
    }
    chainMemo.set(cmds, out);
    return out;
}

// Какие общие события что-то говорят или играют: их зовёт «:event[n]» из CSV ExternMessage, и только их стоит открывать
// (портрет, пузырь, окно — картинки, их в сцену не берём). Неподвижная точка по всем событиям: без глубины и порядка вызовов.
// Лишнее в наборе стоит только шагов EXT_STEPS
const RECORDABLE = new Set([101, 102, 221, 222, 223, 224, 225, 241, 242, 245, 246, 249, 250]);
const recordables = new WeakMap();
function recordableSet(ces) {
    if (!Array.isArray(ces)) return new Set();
    if (recordables.has(ces)) return recordables.get(ces);
    const yes = new Set();
    const calls = new Map();
    ces.forEach((ce, id) => {
        const out = [];
        let direct = false;
        for (const x of ce && Array.isArray(ce.list) ? ce.list : []) {
            if (!x) continue;
            const p0 = String(x.parameters?.[0] ?? '');
            if (RECORDABLE.has(x.code) || ((x.code === 355 || x.code === 655) && /AudioManager/.test(p0)) || (x.code === 356 && /^\s*SV_/i.test(p0))
                || (x.code === 357 && (x.parameters?.[0] === 'SimpleVoice' || csvDialog(x) || galgeChoice(x)))) direct = true;
            if (x.code === 117) out.push(Number(x.parameters?.[0]));
        }
        if (direct) yes.add(id);
        calls.set(id, out);
    });
    for (let changed = true; changed;) {
        changed = false;
        for (const [id, out] of calls) if (!yes.has(id) && out.some((t) => yes.has(t))) { yes.add(id); changed = true; }
    }
    recordables.set(ces, yes);
    return yes;
}

// Кадры одного списка команд: [{ pics: [{ n, name, x, y, o, zx, zy, op, cell? }], wait, msg?, loop?, anim? }]; ces —
// общие события (для 117). wait — сколько кадр стоит на экране (паузы), msg — под ним шла реплика или выбор, loop — он
// внутри цикла («Цикл … Повторить»): так событие крутит анимацию; anim — кадр анимации плагина (PictureAnimation),
// cell — кадр из листа: { i, n, dir } (номер, сколько их, лист горизонтальный «h» или вертикальный «v»).
// ctx — какие картинки есть: { has(name), names } (имена в нижнем регистре, путь внутри img/pictures без расширения);
// без него имена с переменной и кадры-файлы плагина не разворачиваем. mentions — картинки, которые событие только
// называет (аргументы плагинов, строки скриптов): сцене они принадлежат, а куда встают на экране — не знаем
// env — только у параллельных страниц: { pars, map, ev, self, battle } у сцены (какие страницы она может включить) и
// { init, strict, passes, maxSteps, gate } у песочницы, в которой страницу прокручивают сами. Без env разбор — как был
function runList(list, ces, ctx = null, env = null) {
    const frames = [];
    const mentions = new Set();
    const movies = new Map();     // ролик → крутится ли по кругу
    let steps = 0;
    let depthNow = 0;            // глубина общих событий у текущей команды: ролик, что включило само событие, — «свой»
    // Разворот ExternMessage (команды с ext): extSteps — их счёт обхода; sandbox >0 — идём по общему событию из «:event[n]»
    // или «:script» CSV: оно только говорит и играет, картинок и переменных сцены не трогает; extSay >0 — внутри реплики
    // из CSV; extRec — шагов сценария от них; inExt — эти шаги (вырезанное i10 возвращает счёт)
    let extSteps = 0;
    let sandbox = 0;
    let extSay = 0;
    let extRec = 0;
    const inExt = new Set();
    // «Украшения» сценария: затемнения, повторы цикла-анимации, анимация на том же экране — на своём счёте (decor), пока extra > 0
    let extra = 0;
    let decor = 0;
    const inDecor = new Set();
    const paFirst = !!(ctx && ctx.paFirst);
    const recordable = recordableSet(ces);
    const seen = new Set();
    // kids — картинки, привязанные к другой (плагин advanced_pictures у Seven Keys): уходят вместе с ней
    // movie — ролик, приготовленный для ближайшей картинки без имени ({ f, loop, vol, … }); mvRaw — имя из MP_SET_MOVIE
    // по-старому (его берёт любая следующая картинка: так считаем ролики-петли для альбомов, как раньше); vids — ролики
    // не на картинках: PKD_VPlayer «v<id>», «Показать видео» «m»
    // par — идущие параллельные страницы, stuck — картинки выключенных (стоят, пока сцена не положит свою), primed — те из
    // них, что стоят над такой же картинкой сцены, gone — номера, которые сцена трогала с прошлой паузы
    const init = env && env.init;
    let st = { pics: new Map(), kids: new Map(), vars: new Map(init ? init.vars : []), sw: new Map(init ? init.sw : []), self: new Map(init && init.self ? init.self : []), js: new Map(), names: new Map(), rnd: new Map(), pa: null, movie: null, mvRaw: null, vids: new Map(), loops: 0, echo: null, alt: false, paSounds: {}, paSoundAt: 0, fadeColor: null, par: new Map(), stuck: new Map(), primed: new Set(), gone: new Set(), sp: new Map(), spHost: new Map(), spGone: new Map() };
    let altFrames = 0;
    let animFrames = 0;
    // Параллельные страницы (env.pars): какие включила сцена. Песочница (env.passes) — проходы одной такой страницы;
    // страницы в ней не вложены (pars там нет). strict — страница с репликой, выбором или неизвестным условием не петля
    const maxSteps = (env && env.maxSteps) || MAX_STEPS;
    const pars = env && env.pars && ctx ? env.pars : null;
    let mapAt = env && env.map !== undefined && env.map !== null ? env.map : null;
    let parRuns = 0;
    let parScript = 0;
    let parCount = 0;
    const parClips = [];
    const parOf = new Map();      // кадр альбома → { o: [экраны со страницами], plain }
    const cycles = ctx ? (ctx.parCycles = ctx.parCycles || new Map()) : new Map();
    const strict = !!(env && env.strict);
    let unsure = false;
    let halt = false;             // песочница: страница выключила своё условие — дальше она не идёт
    let ending = false;           // последний снимок сцены: страница, включённая в самом конце, — уже не её экран
    // Сценарий для плеера галереи: что игрок видит и слышит по порядку на главном пути (варианты веток и повторы цикла
    // не пишем — это одна и та же сцена, а не вторая). Картинки — состояниями экрана, склейку в готовые кадры делает analyze
    const scenario = [];
    let quiet = 0;               // >0 — повтор цикла: его шаги уже записаны первым проходом
    let lastPics = '';
    // Ролики: шаги vid и vwait — на своём счёте (side; inSide — они, для возврата счёта), lastVids — что записали в последний раз.
    // blank — была картинка-ролик MV, которая раньше считалась картинкой «» (группы считаем как раньше)
    let lastVids = '[]';
    let side = 0;
    const inSide = new Set();
    let blank = false;
    const BREAK = 1;
    // Имена и броски (st.names, st.rnd) читает только сценарий, обход веток их не видит. rolls — какой по счёту бросок
    // этой команды; heard/pend — выбор → что слышали в нём и что ждёт вырезания; cuts — вырезанное (для возврата);
    // blind — сколько раз открыть общее событие не смогли: что в нём, не знаем
    const rolls = new Map();
    const heard = new Map();
    const pend = new Map();
    const cuts = [];
    let refused = 0;
    let blind = 0;
    const has = (n) => !ctx || ctx.has(String(n).toLowerCase());
    // «\V[n]» в имени: известная переменная — её значением, неизвестная — WILD
    const fill = (raw) => String(raw ?? '').replace(/\\v\[(\d+)\]/gi, (m, n) => (st.vars.has(Number(n)) ? String(st.vars.get(Number(n))) : WILD));
    // Имя с неизвестной частью — все подходящие файлы (их немного), иначе не гадаем
    const resolve = (raw) => {
        const name = fill(raw);
        if (!name.includes(WILD)) return name ? { name } : null;
        if (!ctx || !ctx.names) return null;
        const hits = matching(ctx, 'pic', name.toLowerCase(), ctx.names, 3);
        return hits.length && hits.length <= ALT_MAX ? { name: hits[0], ...(hits.length > 1 ? { alts: hits } : {}) } : null;
    };
    // Имя кадра i у анимации из файлов: имя без последних цифр (по числу цифр в количестве кадров) и номер
    const cellName = (p, i) => {
        const digits = String(p.anim.cells).length;
        return p.name.slice(0, p.name.length - digits) + String(i).padStart(digits, '0');
    };
    const view = (n, p, cell = p.cell) => {
        const { name, x, y, o, zx, zy, op } = p;
        const out = { n, name, x, y, o, zx, zy, op };
        if (p.anim) {
            const i = cell || 0;
            // seq — кадры-файлы («連番»): листа нет, но это кадры анимации, а не портрет, хоть файлы и «портретного» размера
            // (Freya's Potion Shop: 715–1010×720)
            if (p.anim.dir === 'n') { out.seq = true; if (i) { const c = cellName(p, i); if (has(c)) out.name = c; } } else out.cell = { i, n: p.anim.cells, dir: p.anim.dir };
        }
        return out;
    };
    // Ролик на картинке — не картинка: в кадры альбома и склейку не идёт (его слой — шаг vid)
    const current = () => [...st.pics.entries()].filter(([, p]) => !p.movie).sort((a, b) => a[0] - b[0]).map(([n, p]) => view(n, p));
    // Экран для сценария: как кадр альбома, но анимация без цикла, что доиграла, стоит на своём последнем кадре
    const screen = () => [...st.pics.entries()].filter(([, p]) => !p.movie).sort((a, b) => a[0] - b[0]).map(([n, p]) => view(n, p, !isLoop(p) && p.anim && p.anim.endCell !== undefined ? p.anim.endCell : p.cell));
    const hasPics = () => { for (const p of st.pics.values()) if (!p.movie) return true; return false; };
    // Ролики экрана снизу вверх: PKD «под картинками», ролики на картинках по номерам, PKD поверх, «Показать видео».
    // Прозрачный (ноль) ролик не рисуется, приготовленный (pre) — тоже
    const vidsNow = () => {
        const low = [];
        const mid = [];
        const high = [];
        for (const [n, p] of [...st.pics.entries()].sort((a, b) => a[0] - b[0])) {
            const m = p.movie;
            if (!m || !m.f || m.pre || Number(p.op ?? 255) <= 0) continue;
            mid.push({ s: `p${n}`, f: m.f, loop: !!m.loop, x: Number(p.x) || 0, y: Number(p.y) || 0, o: p.o ? 1 : 0, zx: Number(p.zx ?? 100), zy: Number(p.zy ?? 100), op: Number(p.op ?? 255),
                ...(Number.isFinite(m.vol) && m.vol !== 100 ? { vol: m.vol } : {}), ...(Number.isFinite(m.rate) && m.rate > 0 && m.rate !== 100 ? { rate: m.rate } : {}),
                ...(m.b ? { b: m.b } : {}), ...(m.pause ? { pause: true } : {}), ...(!m.loop && ctx && ctx.keepEnd ? { keep: true } : {}), ...(m.own ? { own: true } : {}) });
        }
        for (const [s, v] of st.vids) if (s !== 'm') (v.low ? low : high).push({ s, ...v });
        const top = st.vids.has('m') ? [{ s: 'm', ...st.vids.get('m') }] : [];
        return [...low, ...mid, ...high, ...top].slice(-VID_MAX);
    };
    // --- Параллельные страницы на экране. Картинки сцены (st.pics) страница не трогает: кадры альбома, раскадровка и
    // всё, что из них считается, — как без неё. Её картинки — поверх: rest — кадр, на котором страница стоит между
    // анимациями (петля — первый, «один раз» — последний: так она и остаётся)
    const rest = (pr) => (pr.cyc.once ? pr.cyc.frames.length - 1 : 0);
    // own — экран сцены (список картинок), at — Map(страница → номер её кадра); без них — страницы на кадре rest
    const withPar = (own, at = null) => {
        if (!st.par.size && !st.stuck.size) return own;
        const m = new Map(own.map((v) => [v.n, v]));
        for (const [n, v] of st.stuck) m.set(n, { ...v, par: true });
        for (const pr of st.par.values()) {
            if (pr.done || (ending && !pr.ran)) continue;
            const f = pr.cyc.frames[at && at.has(pr) ? at.get(pr) : rest(pr)];
            if (f) for (const v of f.pics) m.set(v.n, { ...v, par: true });
        }
        return [...m.values()].sort((a, b) => a.n - b.n);
    };
    const screenPar = () => withPar(screen());
    const parShown = () => st.stuck.size > 0 || [...st.par.values()].some((pr) => !pr.done && !(ending && !pr.ran) && pr.cyc.frames.length > 0);
    // Снимок для альбома: картинки сцены, поверх — оставшиеся от выключенных страниц и кадр идущих. Картинка сцены, которая
    // сама — кадр этой страницы (сцена показала первый кадр петли), остаётся: какой кадр петли под репликой, не знаем.
    // one/k — клип страницы: она на кадре k, и её кадры идут поверх и своей картинки. hides — под страницей скрылась
    // картинка самой сцены: её кадр тоже остаётся в альбоме
    const overlay = (one = null, k = 0) => {
        if (!st.par.size && !st.stuck.size) return null;
        const m = new Map(current().map((v) => [v.n, v]));
        let par = false;
        let hides = false;
        const put = (v, pr) => {
            const own = st.pics.get(v.n);
            const mine = own && pr && pr.names.has(`${v.n}:${own.name}`);
            if (mine && pr !== one) return;
            if (own && !mine && Number(own.op ?? 255) > 0 && has(own.name)) hides = true;
            m.set(v.n, { ...v, par: true });
            par = true;
        };
        // Оставшаяся картинка поверх картинки сцены, которая сама кадр той страницы (primed), — в альбоме картинка сцены
        for (const [n, v] of st.stuck) if (!st.primed.has(n)) put(v, null);
        for (const pr of st.par.values()) {
            if (pr.done && pr !== one) continue;
            const f = pr.cyc.frames[pr === one ? k : rest(pr)];
            if (f) for (const v of f.pics) put(v, pr);
        }
        return par ? { pics: [...m.values()].sort((a, b) => a.n - b.n), hides } : null;
    };
    const count = () => frames.length - animFrames;
    const push = (cur, wait, msg, extra = {}) => {
        if (sandbox || (extra.anim ? animFrames >= ANIM_FRAMES : count() >= MAX_FRAMES)) return null;
        const last = frames[frames.length - 1];
        // Та же картинка, что стояла под репликой, а теперь — пауза (цикл анимации начинается с неё): новый кадр,
        // иначе первый кадр анимации считался бы кадром разговора
        // Реплика после пауз — уже за концом анимации (последний её кадр так и остаётся кадром анимации)
        if (last && !extra.anim && !last.anim && !!last.alt === !!st.alt && samePics(last.pics, cur) && !(last.msg && !msg && wait > 0)) { last.wait += wait; if (msg && !last.wait) last.msg = true; return last; }
        if (st.alt && ++altFrames > ALT_FRAMES) return null;
        if (extra.anim) animFrames++;
        frames.push({ pics: cur, wait, ...(msg ? { msg: true } : {}), ...(st.loops ? { loop: true } : {}), ...(st.alt ? { alt: true } : {}), ...extra });
        return frames[frames.length - 1];
    };
    // fork — кадр на развилке (конец ветки «Если»/выбора): реплики под ним нет, и анимации с вариантами имени он не
    // разворачивает — это сделает настоящая пауза или реплика
    // refused — шаги, которым не хватило места в сценарии: пока что-то отказано, вырезать «лишнее» нельзя — образовалась бы дыра
    // Шаги от разворота ExternMessage — на своём счёте (EXT_SCRIPT), «украшения» (extra > 0) — на своём (DECOR_MAX),
    // остальные считаются без них: ни то ни другое реплику из сценария не вытеснит. Ответ — записали ли шаг
    const rec = (step, aside = false) => {
        if (st.alt || quiet) return false;
        // Spine и Live2D — по виду шага, раньше всего: свой предел, реплики из-за него не уходят
        if (isRig(step)) {
            if (spineN >= SPINE_STEPS) { refused++; return false; }
            spineN++;
            scenario.push(step);
            return true;
        }
        // Ролики (vid, vwait) — по виду шага, раньше контекста: свой предел, реплики из-за них не уходят
        if (aside) {
            if (side >= VID_STEPS) { refused++; return false; }
            side++;
            inSide.add(step);
        } else if (sandbox > 0 || extSay > 0) {
            if (extRec >= EXT_SCRIPT) { refused++; return false; }
            extRec++;
            inExt.add(step);
        } else if (extra > 0) {
            if (decor >= DECOR_MAX) { refused++; return false; }
            decor++;
            inDecor.add(step);
        } else if (scenario.length - extRec - decor - side - spineN >= SCRIPT_STEPS) { refused++; return false; }
        scenario.push(step);
        return true;
    };
    // --- Spine в сценарии. Слои (st.sp: «p<номер>» — PictureSpine на картинке, «kd:<имя>» — PKD) и картинки-носители (st.spHost)
    // живут рядом с картинками, но кадров и упоминаний не трогают: ни альбомы, ни обрезки от них не зависят. Любой сбой
    // выключает Spine только в этом событии (spineDead). Модели Live2D (ctx.l2d) идут теми же слоями: у слоя l2 = true
    const hasSpines = !!(ctx && ctx.spines && ctx.spines.length);
    const l2dOn = !!(ctx && ctx.l2d && ctx.l2d.length);
    const spiny = hasSpines || l2dOn;
    const lastSpine = new Map();  // слой → что записали в последний раз
    let tick = 0;                 // номер команды анимации на весь разбор: новый набор не повторит прежний (s, t)
    let spineDead = false;
    const forks = [];             // открытые развилки (ветка «Если» с неизвестным условием, выбор, бой), у каждой свой номер
    let forkN = 0;
    const ownSpine = new Set();   // наборы, что событие создало само (не общим событием)
    const rigKind = new Map();    // слой → вид его шагов (spine или l2d): шаг off — того же вида
    const offStep = new Map();    // слой → шаг off, который можно отменить, если слой вернётся (back)
    const offKey = new Map();
    let spineN = 0;
    const norm = (x) => String(x ?? '').replace(/\s+/g, '');
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const copyLayer = (l) => ({ ...l, a: [...l.a], skin: [...l.skin], sc: [...l.sc], off: [...l.off], ...(l.ats ? { ats: [...l.ats] } : {}) });
    // Слой убрали: помним его вместе с развилкой, в которой это случилось
    const dropLayer = (id) => {
        const l = st.sp.get(id);
        if (!l) return;
        const h = l.pic !== undefined ? st.spHost.get(l.pic) : null;
        st.spGone.set(id, { l: copyLayer(l), h: h ? { ...h } : null, fork: forks.length ? forks[forks.length - 1] : 0 });
        st.sp.delete(id);
    };
    // Исключающие друг друга ветки идут подряд: «убрали» в закрытой ветке с неизвестным условием отменяет следующий вызов
    // того же слоя — игра в обе ветки разом не попадает. Убранное на верхнем уровне или в ещё открытой ветке не возвращаем
    const back = (id) => {
        const g = st.spGone.get(id);
        if (!g || !g.fork || forks.includes(g.fork) || !g.l.set) return null;
        const l = copyLayer(g.l);
        st.sp.set(id, l);
        st.spGone.delete(id);
        if (l.pic !== undefined && g.h && !st.spHost.has(l.pic)) st.spHost.set(l.pic, { ...g.h });
        const off = offStep.get(id);
        if (off) { off.drop = true; offStep.delete(id); lastSpine.set(id, offKey.get(id)); }
        return l;
    };
    const hostShow = (n, x, y, zx, zy, op) => {
        if (!spiny) return;
        st.spHost.set(n, { x, y, zx: Number(zx ?? 100), zy: Number(zy ?? 100), op: Number(op ?? 255) });
        // Новая картинка — новый Game_Picture, скелета на нём нет
        st.sp.delete(`p${n}`);
        st.spGone.delete(`p${n}`);
    };
    const hostErase = (n) => { if (!spiny) return; st.spHost.delete(n); dropLayer(`p${n}`); };
    const hostMove = (n, x, y, zx, zy, op) => {
        const h = st.spHost.get(n);
        if (!h) return;
        if (x !== undefined) { h.x = x; h.y = y; }
        h.zx = Number(zx ?? h.zx); h.zy = Number(zy ?? h.zy); h.op = Number(op ?? h.op);
    };
    // Номер картинки — выражение, которого не знаем (переменная после не открытого события), но то же, что у слоя, — это он
    const byRef = (text, l2 = false) => { for (const l of st.sp.values()) if (l.pic !== undefined && !l.l2 === !l2 && l.ref && l.ref === norm(text)) return l.pic; return undefined; };
    // Набор по имени из события («piston03», «piston03/piston03», «chapter1_scene1») — только из найденных findSpines;
    // одно имя у двух наборов — не гадаем
    const spineSet = (raw) => {
        if (!hasSpines || typeof raw !== 'string' || raw.includes(WILD)) return null;
        const name = raw.trim().toLowerCase().replace(/\.json$/, '');
        if (!name) return null;
        const base = name.split('/').pop();
        const hits = ctx.spines.filter((rel) => rel.toLowerCase().endsWith(`/${name}.json`) || rel.toLowerCase() === `${name}.json`);
        const exact = hits.filter((rel) => rel.toLowerCase().endsWith(`/${base}/${base}.json`));
        return exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
    };
    const newLayer = (set) => ({ set, a: [], loop: true, t: 0, q: false, skin: [], ts: 1, x: 0, y: 0, sc: [1, 1], off: [0, 0], op: 255, hide: false });
    // Что видит плеер: положение в пикселях игры (у PictureSpine — от места картинки-носителя), прозрачность, скрытость.
    // Live2D: e — выражение; c — положение (x, y) это центр модели (Live2DInterfaceMZ), а не левый верхний угол холста
    // (PictureLive2D); d — кадров игры, за которые модель едет на это место; прозрачность слоя (setColor) множится на картинки
    const spineView = (l) => {
        const h = l.pic !== undefined ? st.spHost.get(l.pic) : null;
        let at = null;
        if (l.pic !== undefined) { if (h) at = [h.x + l.off[0] * h.zx / 100, h.y + l.off[1] * h.zy / 100, h.zx / 100 * l.sc[0], h.zy / 100 * l.sc[1]]; }
        else at = [l.x, l.y, l.sc[0], l.sc[1]];
        if (at && !at.every(Number.isFinite)) at = null;
        let op = l.pic !== undefined ? (h ? h.op : 255) : l.op;
        if (l.l2 && Number.isFinite(op)) op = Math.round(op * (l.col ?? 1));
        return { s: l.set, a: l.a, loop: l.loop, t: l.t, ...(l.q ? { q: true } : {}), ...(l.ats ? { ats: l.ats } : {}), ...(l.skin.length ? { skin: l.skin } : {}), ...(l.ts !== 1 ? { ts: l.ts } : {}),
            ...(at ? { at: at.map(r3) } : {}), ...(Number.isFinite(op) && op !== 255 ? { op } : {}), ...(l.hide ? { hide: true } : {}),
            ...(l.l2 && l.exp ? { e: l.exp } : {}), ...(l.l2 && l.pic === undefined && at ? { c: 1 } : {}), ...(l.d ? { d: l.d } : {}) };
    };
    // Слой на экране: набор есть и не спрятан (модель Live2DInterfaceMZ после hide живёт, но не показана)
    const alive = (l) => !!(l && l.set && l.shown !== false);
    // Слои, что изменились с прошлой записи, — шагами; ушедшие — off. Зовёт note() после экрана и роликов
    const noteSpine = () => {
        for (const [id, l] of st.sp) {
            if (!alive(l)) continue;
            const v = spineView(l);
            // Переезд за d кадров — часть шага, а не состояния: тот же слой на том же месте новым шагом не становится
            const key = JSON.stringify({ ...v, d: 0 });
            if (lastSpine.get(id) === key) continue;
            lastSpine.set(id, key);
            rigKind.set(id, l.l2 ? 'l2d' : 'spine');
            if (rec({ k: rigKind.get(id), id, ...v })) offStep.delete(id);
        }
        for (const l of st.sp.values()) { l.fresh = false; if (l.l2) l.d = 0; }
        for (const id of [...lastSpine.keys()]) if (!alive(st.sp.get(id))) {
            const step = { k: rigKind.get(id) || 'spine', id, off: true };
            offKey.set(id, lastSpine.get(id));
            lastSpine.delete(id);
            if (rec(step)) offStep.set(id, step);
        }
    };
    // --- Анимация плагина PictureAnimation в сценарии: время считаем как сам плагин. Шаг кадра длится «ожидание + плавная
    // смена» (D); в цикле кадры идут по кругу (период L·D), без цикла — до последнего (или обратно к первому, если в плагине
    // включено «вернуться к первому кадру» — paFirst) и там стоят
    const isLoop = (p) => !!(p.anim && p.anim.loop && !p.anim.soft);
    // Движется ли картинка: показана, видна, основа на месте (без неё плагин ничего не рисует), цикл — всегда, остальные —
    // пока не рассказаны
    const moving = (p) => !!(p.anim && p.anim.started && !p.anim.frozen && Number(p.op ?? 255) > 0 && has(p.name) && (isLoop(p) || !p.anim.told));
    const stepLen = (p) => Math.max(1, p.anim.wait + (p.anim.fade || 0));
    const shiftsOf = (p) => (paFirst ? p.anim.order.length : p.anim.order.length - 1);
    // Сколько кадров игры ждать конца анимации: «Дождаться» и «ждать» в команде START
    const animSpan = (p) => (isLoop(p) ? p.anim.order.length : shiftsOf(p) + 1) * stepLen(p);
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    // Кадры-файлы, которых нет в игре, плагин не нарисует: картинка стоит на последнем существующем кадре
    const cellOrder = (p) => {
        const ord = p.anim.order;
        const ok = (c) => p.anim.dir !== 'n' || !c || has(cellName(p, c));
        return ord.map((c, j) => {
            if (ok(c)) return c;
            for (let k = 1; k < ord.length; k++) { const q = ord[(j - k + ord.length) % ord.length]; if (ok(q)) return q; }
            return 0;
        });
    };
    // Анимация(и) на экране одним шагом сценария. Ответ — { cells, d, loop, r?, x?, s?, par? } или null (кадров меньше двух).
    // Дорожки на одной оси времени: картинки с анимацией плагина (mv) и параллельные страницы (prs). Страница-петля — круг,
    // как петля плагина; «один раз» (выключила своё условие сама) — вступление, потом стоит на последнем кадре
    let lastPar = 0;
    const timeline = () => {
        const mv = [...st.pics.entries()].sort((a, b) => a[0] - b[0]).filter(([, p]) => moving(p));
        // Петли страниц — на каждый новый экран, «один раз» — пока не рассказаны; сверх предела на сцену — без дорожек
        const prs = !ending && parScript < PAR_SCRIPT ? [...st.par.values()].filter((pr) => pr.cyc.frames.length >= 2 && !pr.done && !(pr.cyc.once && pr.told)) : [];
        lastPar = 0;
        for (const [, p] of mv) p.anim.told = true;
        for (const pr of prs) pr.told = true;
        if (!mv.length && !prs.length) return null;
        const xs = [...mv.map(([n, p]) => {
            const L = p.anim.order.length;
            const D = stepLen(p);
            const loop = isLoop(p);
            const changes = loop ? 0 : shiftsOf(p);
            return { n, p, L, D, loop, changes, E: changes * D, res: cellOrder(p), period: L * D };
        }), ...prs.map((pr) => {
            const c = pr.cyc;
            return { page: pr, loop: !c.once, D: c.frames[c.frames.length - 1].d, E: c.once ? c.at[c.at.length - 1] : 0, period: c.len };
        })];
        const loops = xs.filter((x) => x.loop);
        const H = Math.max(0, ...xs.filter((x) => !x.loop).map((x) => x.E));
        // Кадр страницы к мигу t: петля — по кругу, «один раз» — до последнего, и стоит
        const posAt = (x, t) => {
            if (x.page) {
                const c = x.page.cyc;
                const u = c.once ? t : t % c.len;
                let k = 0;
                while (k < c.frames.length - 1 && u >= c.at[k + 1]) k++;
                return k;
            }
            const k = Math.floor(t / x.D);
            return x.loop ? k % x.L : Math.min(k, x.changes) % x.L;
        };
        // Моменты смен кадров в [from, to) у выбранных картинок (и сам from)
        // Анимация без цикла после своего конца не меняется
        const changesIn = (list, from, to) => {
            const out = new Set([from]);
            for (const x of list) {
                if (x.page) {
                    const c = x.page.cyc;
                    if (c.once) { for (const t of c.at) if (t >= from && t < to) out.add(t); continue; }
                    for (let j = Math.floor(from / c.len); j * c.len < to && out.size < ANIM_STEP * 20; j++) for (const a of c.at) if (j * c.len + a >= from && j * c.len + a < to) out.add(j * c.len + a);
                    continue;
                }
                for (let t = Math.ceil(from / x.D) * x.D; t < to && (x.loop || t <= x.E) && out.size < ANIM_STEP * 20; t += x.D) out.add(t);
            }
            return [...out].sort((a, b) => a - b);
        };
        let T = 0;
        if (loops.length) {
            const periods = loops.map((x) => x.period);
            const introN = H > 0 ? changesIn(xs, 0, H).length : 0;
            const fits = (len) => changesIn(loops, H, H + len).length <= ANIM_STEP - Math.min(introN, 60);
            const longest = Math.max(...periods);
            let lcm = 1;
            for (const q of periods) { lcm = (lcm / gcd(lcm, q)) * q; if (lcm > ANIM_LCM) break; }
            if (lcm <= ANIM_LCM && fits(lcm)) T = lcm;
            else {
                let best = 0;
                for (let len = longest; len <= ANIM_LCM; len += longest) {
                    const n = periods.filter((q) => len % q === 0).length;
                    if (n > best && fits(len)) { best = n; T = len; }
                }
                if (!T) T = longest;
            }
        }
        // Выборка по сетке: кадров больше, чем влезает, — привязываем моменты к каждому g-му кадру игры
        const sample = (times, base, room) => {
            if (times.length <= room) return times;
            for (let g = 2; ; g++) {
                const snapped = [...new Set(times.map((t) => base + Math.floor((t - base) / g) * g))];
                if (snapped.length <= room || g > 600) return snapped;
            }
        };
        let intro = H > 0 || !loops.length ? changesIn(xs, 0, loops.length ? H : H + 1) : [];
        let cycle = loops.length ? changesIn(loops, H, H + T) : [];
        if (intro.length + cycle.length > ANIM_STEP) {
            cycle = sample(cycle, H, Math.max(1, ANIM_STEP - Math.min(intro.length, 60)));
            intro = sample(intro, 0, Math.max(1, ANIM_STEP - cycle.length));
        }
        const times = [...intro, ...cycle];
        // У страницы вместо кадра-ячейки — номер её кадра; sg — что видно (равные по виду кадры разных страниц склеиваются)
        const cellsAt = (t) => xs.map((x) => (x.page ? posAt(x, t) : x.res[posAt(x, t)]));
        const frames = [];
        times.forEach((t, j) => {
            const nextT = j + 1 < times.length ? times[j + 1] : loops.length ? H + T : t + Math.min(...xs.map((x) => x.D));
            const v = cellsAt(t);
            frames.push({ t, d: Math.max(1, nextT - t), v, sg: v.map((c, k) => (xs[k].page ? xs[k].page.cyc.sig[c] : c)), cyc: j >= intro.length });
        });
        // Плавная смена: наибольшая среди картинок, у которых кадр сменился; первый кадр круга смыкается с его последним
        const fadeOf = (a, b) => Math.max(0, ...xs.map((x, k) => (!x.page && a[k] !== b[k] && x.p.anim.fade >= 2 ? x.p.anim.fade : 0)));
        const merged = [];
        frames.forEach((f, j) => {
            const prev = merged[merged.length - 1];
            const same = prev && prev.cyc === f.cyc && prev.sg.every((c, k) => c === f.sg[k]);
            if (same) { prev.d += f.d; return; }
            const before = j > 0 ? frames[j - 1].v : null;
            merged.push({ ...f, x: before ? fadeOf(before, f.v) : 0 });
        });
        // Круг: первый его кадр смыкается с последним
        const firstCycle = merged.findIndex((f) => f.cyc);
        if (loops.length && firstCycle >= 0) merged[firstCycle].x = fadeOf(merged[merged.length - 1].v, merged[firstCycle].v);
        for (const x of xs) if (!x.loop && !x.page) x.p.anim.endCell = x.res[posAt(x, H)];
        if (merged.length < 2) return null;
        const r = merged.findIndex((f) => f.cyc);
        const ring = loops.length && r >= 0 && merged.length - r >= 2;
        const base = screen();
        const cells = merged.map((f) => withPar(base.map((v) => {
            const k = xs.findIndex((x) => !x.page && x.n === v.n);
            return k < 0 ? v : view(v.n, xs[k].p, f.v[k]);
        }), new Map(xs.map((x, k) => (x.page ? [x.page, f.v[k]] : null)).filter(Boolean))));
        // Звуки кадров (PA_SOUND, LINK_SOUND): при каждой смене кадра, в том числе при запуске. Без цикла и в разгоне —
        // у кадра своей смены; у цикла — и в разгоне, и в круге (они повторяются с каждым кругом)
        const sounds = [];
        for (const x of xs) {
            const set = !x.page && x.p.anim.sounds;
            if (!set) continue;
            const lastK = x.loop ? Math.ceil((H + T) / x.D) - 1 : x.changes;
            for (let k = 0; k <= lastK && sounds.length < 120; k++) {
                const se = set[x.p.anim.order[k % x.L] + 1];
                if (!se) continue;
                let t = k * x.D;
                if (!x.loop && loops.length && t >= H) t = H - 1;
                sounds.push([Math.max(0, t), se]);
            }
        }
        // Звуки страниц: что она играет на каждом проходе (h音效 у TOD), — на каждом её круге; «один раз» — во вступлении
        for (const x of xs) {
            if (!x.page) continue;
            const c = x.page.cyc;
            const to = loops.length ? H + T : H + 1;
            for (const [tc, se] of c.s) {
                if (c.once) { if (tc < to) sounds.push([loops.length ? Math.min(tc, Math.max(0, H - 1)) : tc, se]); continue; }
                for (let j = 0; j * c.len + tc < to && sounds.length < ANIM_STEP; j++) sounds.push([j * c.len + tc, se]);
            }
        }
        sounds.sort((a, b) => a[0] - b[0]);
        const out = { cells, d: merged.map((f) => f.d), loop: !!ring, ...(ring && r > 0 ? { r } : {}) };
        if (merged.some((f) => f.x >= 2)) out.x = merged.map((f) => (f.x >= 2 ? f.x : 0));
        if (sounds.length) out.s = sounds;
        // par — в шаге есть дорожки страниц: сценарий по имени альбома такой шаг не считает показом (gallery.js, picItems)
        if (prs.length) { out.par = true; lastPar = cells.length; }
        return out;
    };
    // Экран (если сменился) и пауза — в сценарий, без кадра альбома: так ждут эффект экрана и движение картинки, а альбом
    // и раскадровка от этих пауз не меняются
    const note = (wait = 0) => {
        if (st.alt || quiet) return;
        // Экран, где остались одни портреты или пусто, — «картинка не меняется»: плеер держит прошлую. Идёт ролик — экран
        // пишем и пустой: под одним роликом прошлую CG плеер уберёт (scriptOf). В песочнице экран не пишем, паузы
        // остаются: так игра ждёт между звуками
        const vnow = sandbox ? [] : vidsNow();
        // Сцена стёрла свои картинки, а страница рисует — экран есть (у альбома такого кадра нет: он — страницы)
        if (!sandbox && (hasPics() || parShown() || (vnow.length && (st.pics.size || lastPics)))) {
            const key = JSON.stringify(screenPar());
            // Анимацию только что запустили (ещё не рассказали): шаг и тогда, когда экран тот же. На том же экране это
            // «украшение»: пусто — не пишем ничего. После анимации экран — тот, на котором она остановится
            const fresh = [...st.pics.values()].some((p) => moving(p) && !p.anim.told) || [...st.par.values()].some((pr) => !pr.told && !pr.done && pr.cyc.frames.length >= 2);
            if (key !== lastPics || fresh) {
                const here = key === lastPics;
                const tl = timeline();
                if (here) extra++;
                // Кадры петель страниц — в свой предел на сцену: считаем только записанные
                if (tl) { if (rec({ k: 'anim', ...tl })) { lastPics = JSON.stringify(screenPar()); parScript += lastPar; } } else if (!here) {
                    // decor — экрана в старых сценариях не было (затемнение, повтор цикла, анимация доиграла): его склейка
                    // считается отдельно (gallery.js)
                    const pics = screenPar();
                    if (rec({ k: 'pics', pics, ...(extra > 0 || JSON.stringify(pics) !== JSON.stringify(current()) ? { decor: true } : {}) })) lastPics = JSON.stringify(pics);
                }
                if (here) extra--;
            }
        }
        const vk = JSON.stringify(vnow);
        // lastVids помним, только если шаг записан: rec может отказать (предел шагов роликов), и тогда состояние «в сценарии»
        // не совпадает с запомненным — следующий показ того же ролика не должен считаться уже записанным
        if (!sandbox && vk !== lastVids && rec({ k: 'vid', v: vnow }, true)) lastVids = vk;
        if (spiny && !sandbox && !spineDead) { try { noteSpine(); } catch { spineDead = true; } }
        if (wait > 0) rec({ k: 'wait', n: wait });
    };
    // Снимок экрана со страницами — к кадру альбома (parOf); сам кадр — как без них. plain — этот кадр видели и без
    // страницы (или страница закрыла картинку сцены): он остаётся в альбоме рядом со снимками
    const parStill = (f) => {
        if (!f || !pars || st.alt || f.alt) return;
        const o = overlay();
        const info = parOf.get(f) || { o: [], plain: false };
        if (!o) info.plain = true;
        else {
            const key = JSON.stringify(o.pics);
            if (!info.o.some((x) => JSON.stringify(x) === key)) info.o.push(o.pics);
            if (o.hides) info.plain = true;
        }
        parOf.set(f, info);
    };
    // Клип страницы поверх сцены — при первой паузе или реплике после её включения (кадры сцены и её раскадровка от него
    // не меняются; альбом «…#par»)
    const parClip = () => {
        if (st.alt) return;
        for (const pr of st.par.values()) {
            if (pr.clipped || pr.cyc.frames.length < 2) continue;
            pr.clipped = true;
            const clip = [];
            pr.cyc.frames.forEach((f, k) => {
                if (parCount >= PAR_FRAMES) return;
                const o = overlay(pr, k);
                if (!o) return;
                clip.push({ pics: o.pics, wait: Math.max(1, f.d), anim: true, ...(pr.cyc.once ? {} : { loop: true }) });
                parCount++;
            });
            if (clip.length >= 2) parClips.push(clip);
        }
    };
    // Прошло время: страница отрисовала свои номера («стёрла сцена» больше не мешает им остаться), «один раз» — доиграла
    const parAfter = () => {
        st.gone.clear();
        for (const pr of st.par.values()) {
            pr.ran = true;
            if (pr.cyc.once && !pr.done) { stopPage(pr); pr.done = true; }
        }
    };
    // span — сколько ждёт сценарий (конец анимации), wait — как стояло кадром альбома: кадры альбомов от анимаций не меняются
    const snap = (wait = 0, msg = false, fork = false, span = wait) => {
        snapOwn(wait, msg, fork, span);
        if (!fork && (msg || wait > 0) && (st.par.size || st.gone.size)) parAfter();
    };
    const snapOwn = (wait, msg, fork, span) => {
        if (!fork) note(span);
        if (sandbox || count() >= MAX_FRAMES) return;
        // Раньше картинка-ролик MV была картинкой «» и считалась именем группы — помним это, чтобы группы не поменялись
        if (!blank) for (const q of st.pics.values()) if (q.blank && q.movie) blank = true;
        if (!hasPics()) return;
        if (fork) { push(current(), 0, false); return; }
        if (msg || wait > 0) parClip();
        // Анимация плагина: при первом кадре после запуска — все её кадры по кругу, дальше картинка стоит на своём кадре.
        // Несколько картинок крутятся разом (тело и брызги) — кадры у них идут вместе, как в игре
        const running = [...st.pics.values()].filter((p) => p.anim && p.anim.started && !p.anim.done);
        if (running.length) {
            const keep = running.map((p) => p.cell);
            const len = Math.min(ANIM_CELLS, Math.max(...running.map((p) => p.anim.order.length)));
            for (let k = 0; k < len && animFrames < ANIM_FRAMES; k++) {
                for (const p of running) p.cell = p.anim.order[k % p.anim.order.length];
                // Кадра-файла нет (вырезали при сборке игры) — пропускаем
                if (running.some((p) => p.anim.dir === 'n' && p.cell && !has(cellName(p, p.cell)))) continue;
                push(current(), Math.min(...running.map((p) => p.anim.wait)), false, { anim: true, ...(running.some((p) => p.anim.loop) ? { loop: true } : {}) });
            }
            running.forEach((p, k) => { p.anim.done = true; p.cell = keep[k]; });
        }
        const cur = current();
        const key = JSON.stringify(cur);
        // Кадр конца своей ветки уже снят: реплика под ним — его пометка, не новый кадр
        if (st.echo === key && !wait) { if (msg && st.echoFrame) { st.echoFrame.msg = true; parStill(st.echoFrame); } return; }
        st.echo = null;
        // Имя с переменной, которой не знаем: кадр на каждый подходящий файл — один раз, дальше стоит первый
        const multi = [...st.pics.entries()].find(([, p]) => p.alts && !p.altsDone);
        if (multi) {
            const [n, p] = multi;
            p.altsDone = true;
            for (const name of p.alts) push(cur.map((x) => (x.n === n ? { ...x, name } : x)), wait, msg);
            return;
        }
        const f = push(cur, wait, msg);
        if (msg || wait > 0) parStill(f);
    };
    const changed = () => { st.echo = null; };
    // Имена героев, которые сцена задала сама, для «\N[n]» в тексте: Actors.json их не знает, а в игре они уже другие
    const cast = (texts) => {
        const a = {};
        for (const m of texts.map((t) => String(t ?? '')).join('\n').matchAll(/\\n\[(\d+)\]/gi)) if (st.names.has(Number(m[1]))) a[m[1]] = st.names.get(Number(m[1]));
        return Object.keys(a).length ? { a } : {};
    };
    // Реплика: строки окна как в игре и имя. frame — кадр альбома под ней (как у «Показать текст»); реплики плагинов —
    // только в сценарий (note): кадр на каждую перестроил бы альбомы игры
    const say = (lines, name, frame = true) => {
        if (frame) snap(0, true); else note();
        if (!lines.length) return;
        const used = {};
        for (const m of `${name || ''}\n${lines.join('\n')}`.matchAll(/\\v\[(\d+)\]/gi)) if (st.vars.has(Number(m[1]))) used[m[1]] = st.vars.get(Number(m[1]));
        rec({ k: 'say', l: lines, ...(typeof name === 'string' && name ? { n: name } : {}), ...(Object.keys(used).length ? { v: used } : {}), ...cast([name, ...lines]) });
    };
    // Стереть картинку и всё, что к ней привязано
    // Сцена сама положила или стёрла картинку под номером: то, что оставила выключенная страница, — уже не на экране;
    // gone — до следующей паузы: выключат страницу в тот же миг — её картинка там не останется
    const touch = (n) => { st.stuck.delete(n); st.primed.delete(n); if (st.par.size) st.gone.add(n); };
    const erase = (n, depth = 0) => {
        hostErase(n);
        st.pics.delete(n);
        touch(n);
        const kids = st.kids.get(n);
        st.kids.delete(n);
        if (kids && depth < 8) for (const k of kids) erase(k, depth + 1);
        changed();
    };
    const clearAll = () => { for (const n of new Set([...st.pics.keys(), ...st.stuck.keys(), ...[...st.par.values()].flatMap((pr) => [...pr.slots])])) touch(n); st.pics.clear(); st.kids.clear(); for (const [id, l] of [...st.sp]) if (l.pic !== undefined) dropLayer(id); st.spHost.clear(); changed(); };
    const showPic = (n, raw, o, x, y, zx, zy, op, b = 0) => {
        // MoviePicture: приготовленный ролик встаёт на ближайшую картинку без имени (так и в плагине), картинка с именем
        // его не берёт — он ждёт дальше. Картинка без имени под ролик по-старому (mvRaw) — «» для групп и петель
        const vid = String(raw ?? '') === '' && st.movie ? st.movie : null;
        const r = vid ? { name: '' } : resolve(raw) || (st.mvRaw ? { name: '' } : null);
        if (!r) { st.pics.delete(n); changed(); return; }
        const p = { name: r.name, o: o || 0, x: Number(x) || 0, y: Number(y) || 0, zx: zx ?? 100, zy: zy ?? 100, op: op ?? 255 };
        if (r.alts) { p.alts = r.alts; if (strict) unsure = true; }
        // PictureAnimation: «подготовить» стоит перед показом и действует на следующую показанную картинку
        if (st.pa) {
            p.anim = { ...st.pa, started: false, done: false, order: [...Array(st.pa.cells).keys()] };
            // Звуки кадров, которые события заказали до «подготовить», достаются этой картинке
            if (Object.keys(st.paSounds).length) { p.anim.sounds = st.paSounds; st.paSounds = {}; }
            st.pa = null;
        }
        // MoviePicture (MV): «MP_SET_MOVIE» перед показом — имя ролика у картинки (MP_SET_LOOP по нему зовёт петлю), как раньше
        if (st.mvRaw) { p.mv = st.mvRaw; st.mvRaw = null; if (!r.name) p.blank = true; }
        if (vid) { p.movie = { ...vid, own: depthNow === 0, ...(b ? { b } : {}) }; st.movie = null; }
        // Номер занят новой картинкой: прежние привязки к нему и от него — не её
        st.kids.delete(n);
        for (const [parent, kids] of st.kids) if (kids.includes(n)) st.kids.set(parent, kids.filter((k) => k !== n));
        st.pics.set(n, p);
        touch(n);
        changed();
    };
    const movePic = (n, o, x, y, zx, zy, op) => {
        const p = st.pics.get(n);
        // На экране под этим номером — картинка, что оставила страница: двигают и гасят её
        const v = st.stuck.get(n);
        if (v) st.stuck.set(n, { ...v, ...(x !== undefined ? { x: Number(x) || 0, y: Number(y) || 0 } : {}), o: o || 0, zx: zx ?? v.zx, zy: zy ?? v.zy, op: op ?? v.op });
        if (!p) return;
        if (x !== undefined) { p.x = Number(x) || 0; p.y = Number(y) || 0; }
        const hidden = Number(p.op ?? 255) <= 0;
        p.o = o || 0; p.zx = zx ?? p.zx; p.zy = zy ?? p.zy; p.op = op ?? p.op;
        // Анимацию показали невидимой и теперь проявляют (плавная смена анимаций): её кадры — заново, уже видимые
        if (hidden && Number(p.op) > 0 && p.anim && p.anim.started) p.anim.done = false;
        changed();
    };
    const varOf = (n) => (st.vars.has(n) ? st.vars.get(n) : undefined);
    const setVar = (n, v) => { st.rnd.delete(n); if (typeof v === 'number' || typeof v === 'string') st.vars.set(n, v); else st.vars.delete(n); };
    // Ролик плагина (MoviePicture, MovieManager): имя внутри movies/ без расширения; с переменной в имени («\V[4]_2» —
    // вторая часть каждой сцены) — все подходящие: так их и крутит игра
    const movie = (raw, loop) => {
        if (sandbox || !ctx || !ctx.movies) return;
        const name = fill(raw).toLowerCase();
        if (!name) return;
        const hits = name.includes(WILD) ? matching(ctx, 'movie', name, ctx.movies, 1) : ctx.movies.includes(name) ? [name] : [];
        for (const h of hits) movies.set(h, movies.get(h) || !!loop);
    };
    // Ролик для слоя плеера: один файл (с переменной в имени — только если подходит ровно один) и его путь в оглавлении
    // (ctx.videoRel: имя в movies/ → файл)
    const movieOne = (raw) => {
        if (!ctx || !ctx.movies || !ctx.videoRel) return null;
        const name = fill(raw).toLowerCase();
        if (!name) return null;
        const hits = name.includes(WILD) ? matching(ctx, 'movie', name, ctx.movies, 1) : ctx.movieSet.has(name) ? [name] : [];
        return hits.length === 1 ? ctx.videoRel(hits[0]) : null;
    };
    // MP_SET_OUTER_MOVIE: путь от корня игры с расширением («img/pictures/gus_e/gus_e01_01.webm»)
    const outerOne = (raw) => (ctx && ctx.outerRel ? ctx.outerRel(fill(raw)) : null);
    // Свойства ролика на картинке n: громкость, скорость, пауза. Кадры альбома от них не меняются (changed не зовём)
    const vset = (n, patch) => { const q = st.pics.get(n); if (q && q.movie) q.movie = { ...q.movie, ...patch }; };
    // Игра ждёт конца ролика (MoviePicture WAIT, MP_SET_WAIT, «если ролик кончился» в цикле). Приготовленный (pre) и
    // тот, у которого нет файла, не ждём. В песочнице ожидания нет
    const vwait = (s) => {
        if (sandbox) return;
        if (s[0] === 'p') { const q = st.pics.get(Number(s.slice(1))); if (!q || !q.movie || !q.movie.f || q.movie.pre) return; } else if (!st.vids.has(s)) return;
        note();
        rec({ k: 'vwait', s }, true);
    };
    // PKD_VPlayer: «ShowVAnim(id, имя, x, y, петля)» — слой на экране; ролики на клетках карты не воспроизводим
    const vanim = (id, raw, x, y, loop, low) => {
        const f = typeof raw === 'string' ? movieOne(raw) : null;
        if (!f || id === undefined || id === null || id === UNKNOWN) return;
        st.vids.set(`v${String(id)}`, { f, loop: !!loop, x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, ...(loop ? {} : { keep: true }), ...(low ? { low: true } : {}), ...(depthNow === 0 ? { own: true } : {}) });
    };
    const VANIM = /^(?:window\s*\.\s*)?(ShowVAnim|ShowVAnimOnSpriteset|ShowVAnimScreenBelowPictures|DeleteVAnim|SetEndScriptToVAnim)\s*\(/;
    const vanimScript = (s) => {
        const m = VANIM.exec(s);
        if (!m) return;
        const a = callArgs(s, m[0].length).map((x) => evaluate(tokenize(x), st));
        if (m[1] === 'DeleteVAnim') { st.vids.delete(`v${String(a[0])}`); return; }
        if (m[1] === 'SetEndScriptToVAnim') {
            // Конец ролика зовёт другой ролик на том же месте («5.1MOV1» → петля «5.2MOV1»): плеер сменит его сам
            const v = st.vids.get(`v${String(a[0])}`);
            const inner = typeof a[1] === 'string' ? VANIM.exec(a[1].trim()) : null;
            if (v && inner && inner[1] !== 'DeleteVAnim' && inner[1] !== 'SetEndScriptToVAnim') {
                const b = callArgs(a[1].trim(), inner[0].length).map((x) => evaluate(tokenize(x), st));
                const f = typeof b[1] === 'string' ? movieOne(b[1]) : null;
                if (f) v.nx = { f, loop: b[4] !== false, x: typeof b[2] === 'number' ? b[2] : v.x, y: typeof b[3] === 'number' ? b[3] : v.y };
            }
            return;
        }
        vanim(a[0], a[1], typeof a[2] === 'number' ? a[2] : 0, typeof a[3] === 'number' ? a[3] : 0, a[4] !== false, m[1] === 'ShowVAnimScreenBelowPictures');
    };
    const mention = (raw) => {
        if (sandbox) return;
        const name = String(raw || '').toLowerCase();
        if (name && ctx && ctx.has(name)) mentions.add(name);
    };
    const paStart = (n, loop, type, custom) => {
        const p = st.pics.get(Number(n));
        if (!p || !p.anim) return;
        const all = [...Array(p.anim.cells).keys()];
        const order = type === 2 ? [...all, ...all.slice(1, -1).reverse()]
            : type === 3 && Array.isArray(custom) && custom.length ? custom.map((c) => Math.max(0, Math.min(p.anim.cells - 1, Number(c) - 1))).filter(Number.isFinite) : all;
        Object.assign(p.anim, { started: true, done: false, loop: !!loop, order, told: false, soft: false, frozen: false, endCell: undefined });
    };
    const paInit = (cells, wait, dir, fade) => {
        cells = Math.round(Number(cells) || 1);
        if (cells > 1) st.pa = { cells: Math.min(cells, 200), wait: Math.max(1, Math.round(Number(wait) || 1)), dir: PA_DIR[String(dir || '縦').toLowerCase()] || PA_DIR[dir] || 'v', fade: Math.max(0, Math.min(9999, Math.round(Number(fade) || 0))) };
    };
    // Остановка: обычная доигрывает круг один раз и встаёт на последний кадр, принудительная — сразу картинка: следующая запись экрана пишет её неподвижной
    const paStop = (n, force) => {
        const p = st.pics.get(Number(n));
        if (!p || !p.anim || !p.anim.started) return;
        if (force) { p.anim.frozen = true; lastPics = ''; } else if (p.anim.loop && !p.anim.soft) { p.anim.soft = true; p.anim.told = false; }
    };
    // Звук кадра «LINK_SOUND»: файл по имени среди звуков игры, неизвестное имя пропускаем
    const paLink = (cell, a) => {
        const hit = ctx && ctx.audio && a && a.name ? ctx.audio('se', String(a.name)) : null;
        if (hit && Number.isFinite(Number(cell))) st.paSounds[Math.round(Number(cell))] = { f: hit.rel, vol: num(a.volume, 90), pitch: num(a.pitch, 100), pan: num(a.pan, 0) };
    };
    // Число из аргумента плагина: «\V[3]» — значение переменной
    const argNum = (s) => { const m = /^\\v\[(\d+)\]$/i.exec(String(s || '').trim()); return m ? Number(varOf(Number(m[1]))) : Number(s); };
    const plugin = (c) => {
        const p = c.parameters || [];
        if (c.code === 356) {
            // Команды SimpleVoice MV разбирает по пробелу «ASCII»: в имени файла бывает «　» (ミカ　んぁっ у Mira's Potion Shop)
            const words = /^\s*SV_/i.test(String(p[0] || '')) ? String(p[0]).trim().split(/ +/) : String(p[0] || '').trim().split(/\s+/);
            const cmd = words[0].toUpperCase();
            const a = words.slice(1);
            if (cmd === 'PA_INIT' || cmd === 'ピクチャのアニメーション準備') paInit(argNum(a[0]), argNum(a[1]), a[2], argNum(a[3]));
            else if (cmd === 'PA_START' || cmd === 'ピクチャのアニメーション開始') paStart(argNum(a[0]), false, argNum(a[1]), a[2] && safeJson(a[2]));
            else if (cmd === 'PA_START_LOOP' || cmd === 'ピクチャのループアニメーション開始') paStart(argNum(a[0]), true, argNum(a[1]), a[2] && safeJson(a[2]));
            else if (cmd === 'PA_SET_CELL' || cmd === 'ピクチャのアニメーションセル設定') setCell(argNum(a[0]), argNum(a[1]));
            else if (cmd === 'PA_PROG_CELL' || cmd === 'ピクチャのアニメーションセル進行') { const q = st.pics.get(argNum(a[0])); if (q && q.anim) setCell(argNum(a[0]), (q.cell || 0) + 1); }
            // «Дождаться конца анимации» — её показали целиком
            else if (cmd === 'PA_WAIT' || cmd === 'ピクチャのアニメーションウェイト') { const q = st.pics.get(argNum(a[0])); if (q && q.anim) snap(q.anim.wait, false, false, animSpan(q)); }
            // Остановка анимации (обычная и принудительная) и заказ звука кадра: аргументы остаются упоминаниями, как раньше
            else if (cmd === 'PA_STOP' || cmd === 'ピクチャのアニメーション終了' || cmd === 'PA_STOP_FORCE' || cmd === 'ピクチャのアニメーション強制終了') {
                paStop(argNum(a[0]), /FORCE|強制/.test(cmd));
                for (const w of a) mention(w);
            } else if (cmd === 'PA_SOUND' || cmd === 'ピクチャのアニメーション効果音予約') {
                st.paSoundAt = Math.round(argNum(a[0])) || 0;
                for (const w of a) mention(w);
            }
            // SimpleVoice: «SV_PLAY_VOICE имя [громкость высота панорама канал]»
            else if (cmd === 'SV_PLAY_VOICE' || cmd === 'SV_ボイスの演奏' || cmd === 'SV_PLAY_LOOP_VOICE' || cmd === 'SV_ボイスのループ演奏') {
                voice(a[0], { volume: argNum(a[1]), pitch: argNum(a[2]), pan: argNum(a[3]) }, /LOOP|ループ/.test(cmd), argNum(a[4]));
            } else if (cmd === 'SV_STOP_VOICE' || cmd === 'SV_ボイスの停止') rec({ k: 'stop', kind: 'voice', fade: 0 });
            else if (cmd === 'MP_SET_MOVIE' || cmd === 'MP_動画設定') { st.mvRaw = a[0]; movie(a[0], false); st.movie = { f: movieOne(a[0]), loop: false }; }
            else if (cmd === 'MP_SET_LOOP' || cmd === 'MP_ループ設定') {
                const n = argNum(a[0]);
                const q = st.pics.get(n);
                const on = /^(on|true|1)$/i.test(a[1] || 'on');
                if (q && q.mv && on) movie(q.mv, true);
                vset(n, { loop: on });
            } else {
                // Остальные команды MoviePicture — свойства ролика на картинке; их аргументы по-прежнему и упоминания
                // (имена картинок вида «15» бывают)
                const n = argNum(a[0]);
                if (cmd === 'MP_SET_OUTER_MOVIE' || cmd === 'MP_外部動画設定') st.movie = { f: outerOne(a[0]), loop: false };
                else if (cmd === 'MP_SET_WAIT' || cmd === 'MP_ウェイト設定') vwait(`p${n}`);
                else if (cmd === 'MP_SET_VOLUME' || cmd === 'MP_音量設定') vset(n, { vol: argNum(a[1]) });
                else if (cmd === 'MP_SET_SPEED' || cmd === 'MP_速度設定') vset(n, { rate: argNum(a[1]) });
                else if (cmd === 'MP_SET_PAUSE' || cmd === 'MP_ポーズ設定') vset(n, { pause: /^(on|true|1)$/i.test(a[1] || 'on') });
                else if ((cmd === 'MP_SET_LIMIT' || cmd === 'MP_リミット設定') && argNum(a[1]) <= PRELOAD_LIMIT) vset(n, { pre: true });
                for (const w of a) mention(w);
            }
            return;
        }
        // MZ: [плагин, команда, подпись, { аргументы }]
        const args = (p[3] && typeof p[3] === 'object') ? p[3] : {};
        if (p[0] === 'Live2DInterfaceMZ' && l2dOn && !spineDead) { try { l2dFace(p[1], args); } catch { spineDead = true; } }
        if (p[0] === 'MoviePicture' && p[1] === 'PREPARE') {
            const loop = args.loop === 'true' || args.loop === true;
            movie(args.fileName, loop);
            st.movie = { f: movieOne(args.fileName), loop, vol: num(args.volume, 100), ...(args.autoplay === 'false' || args.autoplay === false ? { pause: true } : {}) };
            return;
        }
        // Остальное у роликов — свойства и ожидание; дальше команда идёт как раньше (упоминания аргументов)
        if (p[0] === 'MoviePicture') {
            const n = argNum(args.pictureId);
            if (p[1] === 'WAIT') vwait(`p${n}`);
            else if (p[1] === 'PLAY' || p[1] === 'PAUSE') vset(n, { pause: p[1] === 'PAUSE' });
            else if (p[1] === 'SET_VOLUME') vset(n, { vol: argNum(args.volume) });
            else if (p[1] === 'SET_RATE') vset(n, { rate: argNum(args.rate) });
        }
        if (/VPlayer/i.test(String(p[0]))) {
            // «Screen, above/below windows» — на экране, «Map, …» — на карте (не воспроизводим)
            if (p[1] === 'ShowVAnim' && !/map/i.test(String(args.order || ''))) vanim(String(args.id ?? ''), String(args.id ?? ''), argNum(args.x), argNum(args.y), String(args.isLoop) !== 'false', false);
            else if (p[1] === 'DeleteVAnim') st.vids.delete(`v${String(args.id ?? '')}`);
        }
        if (p[0] === 'SimpleVoice') {
            if (p[1] === 'PLAY_VOICE') voice(args.name, { volume: argNum(args.volume), pitch: argNum(args.pitch), pan: argNum(args.pan) }, args.loop === 'true' || args.loop === true, argNum(args.channel));
            else if (/^STOP_(ALL_)?VOICES?$/.test(p[1])) rec({ k: 'stop', kind: 'voice', fade: 0 });
            return;
        }
        // Плагины, которые убирают или меняют картинки: смена старой на новую (advanced_pictures «transition»), «разбить»,
        // «стереть»; привязка картинок к родителю — они уходят вместе с ним
        const id = (v) => argNum(v);
        if (args.oldPictureId !== undefined && args.newPictureId !== undefined) { erase(id(args.oldPictureId)); return; }
        if (/attach/i.test(p[1]) && args.parentId !== undefined) {
            const kids = (safeJson(args.childrenIds) || []).map(id).filter(Number.isFinite);
            if (kids.length) st.kids.set(id(args.parentId), [...new Set([...(st.kids.get(id(args.parentId)) || []), ...kids])]);
            return;
        }
        // Стирает картинку только команда «про картинку»: «shatterPicture», «erasePicture», «ピクチャ消去» — не «clearEffect»
        const pid = args.pictureId ?? args.pictureNumber ?? args.picId;
        if (pid !== undefined && /pic|ピクチャ/i.test(p[1]) && /shatter|erase|delete|remove|clear|消去|削除/i.test(p[1]) && !/event|filter|call|common/i.test(p[1])) { erase(id(pid)); return; }
        if (p[0] === 'PictureAnimation') {
            if (p[1] === 'INIT') paInit(argNum(args.cellNumber), argNum(args.frameNumber), args.direction, argNum(args.fade));
            else if (p[1] === 'START') {
                paStart(argNum(args.pictureNumber), args.loop === 'true' || args.loop === true, argNum(args.animationType), safeJson(args.customPattern));
                const q = st.pics.get(argNum(args.pictureNumber));
                if ((args.wait === 'true' || args.wait === true) && q && q.anim) snap(q.anim.wait, false, false, animSpan(q));
            }
            else if (p[1] === 'STOP') paStop(argNum(args.pictureNumber), args.force === 'true' || args.force === true);
            else if (p[1] === 'LINK_SOUND') paLink(argNum(args.cellNumber), safeObj(args.se));
            else if (p[1] === 'SET_CELL') setCell(argNum(args.pictureNumber), argNum(args.cellNumber));
            return;
        }
        const csv = csvDialog(c);
        if (csv) {
            // Рамку окна (pictureName) плагин ставит на номер pictureId ещё до реплики и стирает после неё: картинки,
            // что была на этом номере, уже нет. Саму рамку не рисуем — это окно, не сцена
            const slot = Number(csv.pictureId || 95);
            if (csv.pictureName && st.pics.has(slot)) erase(slot);
            const hit = ctx && ctx.texts && ctx.texts.dialog ? ctx.texts.dialog(String(csv.csvFile || ''), csv.dialogId) : null;
            if (hit) {
                const lines = hit.lines.map(String);
                while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
                say(lines, hit.name, false);
            }
            for (const v of Object.values(args)) if (typeof v === 'string') mention(v);
            return;
        }
        const pick = galgeChoice(c);
        if (pick) {
            // Варианты за выключенным переключателем игра прячет; переключатель, которого не знаем, — показываем
            const o = pick.choices.filter((x) => { const sw = Number(x.switchId || 0); return sw === 0 || (Number.isFinite(sw) && st.sw.get(sw) !== false); }).map((x) => String(x.label ?? ''));
            if (o.length) {
                say(pick.text.trim() ? pick.text.split('\n') : [], '', false);
                rec({ k: 'choice', o, i: -1, ...cast(o) });
            }
            // Переменную с ответом не забываем: так альбомы игры остались прежними (замер на Tidewater Quest)
            for (const v of Object.values(args)) if (typeof v === 'string') mention(v);
            return;
        }
        // Реплика через плагин (лог боя «BattleLogOutput», всплывающий текст): кадр под ней — как под окном сообщения.
        // Иначе сцена, которая говорит только так (бои Magical Girl Runa and Nanami), не снимается ни одним кадром
        // Только команды лога и сообщений (BattleLogOutput, message, talk): у других «text» — подпись кнопки, подсказка или
        // надпись-картинка (TextPicture у Luna and the Lustful Trap Dungeon), это не реплика
        if (/log|message|talk|msg|メッセージ|ログ/i.test(`${p[0]} ${p[1]}`) && !/pic|ピクチャ/i.test(`${p[0]} ${p[1]}`) && Object.entries(args).some(([k, v]) => /^(message|text|msg|mes)$/i.test(k) && typeof v === 'string' && v.trim())) snap(0, true);
        for (const v of Object.values(args)) if (typeof v === 'string') mention(v);
    };
    // Кадр листа — номер по модулю числа кадров (так считает сам плагин)
    const setCell = (n, cell) => {
        const q = st.pics.get(Number(n));
        if (!q || !q.anim || !Number.isFinite(cell)) return;
        q.cell = ((Math.round(cell) % q.anim.cells) + q.anim.cells) % q.anim.cells;
        q.anim.endCell = undefined;
        changed();
    };
    // Звук события: имя, которого нет среди файлов игры, пропускаем. Пустое имя у музыки — «остановить»
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);
    const sound = (kind, a) => {
        if (!ctx || !ctx.audio || !a || typeof a !== 'object') return;
        if (!a.name) { if (kind === 'bgm' || kind === 'bgs') rec({ k: 'stop', kind, fade: 0 }); return; }
        const hit = ctx.audio(kind, String(a.name));
        if (hit) rec({ k: 'snd', kind: hit.voice ? 'voice' : kind, f: hit.rel, vol: num(a.volume, 90), pitch: num(a.pitch, 100), pan: num(a.pan, 0) });
    };
    const audio = (code, a) => sound(AUDIO_KIND[code], a);
    // Голос плагина (SimpleVoice): файл — в audio/voice; loop — стон или дыхание по кругу на своём канале, пока его не остановят
    // shortcut: папку плагина (параметр «FolderName») не читаем — ищем в voice, потом в se; своя папка у игры — голоса нет
    const voice = (name, a, loop, ch) => {
        if (!ctx || !ctx.audio || !name) return;
        const hit = ctx.audio('voice', String(name)) || ctx.audio('se', String(name));
        if (hit) rec({ k: 'snd', kind: loop ? 'vloop' : 'voice', f: hit.rel, vol: num(a.volume, 90), pitch: num(a.pitch, 100), pan: num(a.pan, 0), ...(loop && num(ch, 0) ? { ch: num(ch, 0) } : {}) });
    };
    // Звук из скрипта: «AudioManager.playSe({name: "Ice1", volume: 60})». Имя — только строкой: переменную не знаем
    const AM_KIND = { playSe: 'se', playStaticSe: 'se', playBgm: 'bgm', playBgs: 'bgs', playMe: 'me' };
    const scriptSound = (fn, args) => {
        const arg = args[0] || '';
        if (/^stop(Bgm|Bgs)$/.test(fn) || /^fadeOut(Bgm|Bgs)$/.test(fn)) { rec({ k: 'stop', kind: fn.slice(-3).toLowerCase(), fade: fn.startsWith('fade') ? num(arg, 0) : 0 }); return; }
        const field = (k) => new RegExp(`(?:^|[{,\\s])["']?${k}["']?\\s*:\\s*(?:(["'\`])((?:[^\\\\]|\\\\.)*?)\\1|(-?\\d+(?:\\.\\d+)?)(?![\\w.]))`).exec(arg);
        const name = field('name');
        if (!name || name[2] === undefined) return;
        const a = { name: name[2], volume: field('volume')?.[3], pitch: field('pitch')?.[3], pan: field('pan')?.[3] };
        if (fn === 'playVoice') voice(a.name, a, false); else sound(AM_KIND[fn], a);
    };
    // Затемнение экрана: «украшение» — шаг fx fade в цвете игры (c), у команд 221/222 за ним пауза. Экран до него записывается
    // тоже на счёт украшений: иначе сцена, полная затемнений, вытеснила бы из сценария реплики
    const fade = (out, n, wait) => {
        extra++;
        note();
        rec({ k: 'fx', t: 'fade', o: out ? 1 : 0, n, ...(st.fadeColor ? { c: st.fadeColor } : {}) });
        if (wait) note(n);
        extra--;
    };
    // Звук кадра, заказанный «PA_SOUND n» перед командой «Звук SE»: эта команда звук не играет, он уходит анимации
    const paReserve = (a) => {
        const at = st.paSoundAt;
        st.paSoundAt = 0;
        const hit = ctx && ctx.audio && a && typeof a === 'object' && a.name ? ctx.audio('se', String(a.name)) : null;
        if (hit) st.paSounds[at] = { f: hit.rel, vol: num(a.volume, 90), pitch: num(a.pitch, 100), pan: num(a.pan, 0) };
    };
    // Цепочка вызовов после головы: «.setSkeleton('a').setAnimation(0, 'b')» → [{ name, args (текст) }]
    const chainOf = (str, at) => {
        const out = [];
        for (;;) {
            const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(str.slice(at));
            if (!m) return out;
            const start = at + m[0].length;
            const args = callArgs(str, start);
            out.push({ name: m[1], args: args.length === 1 && !args[0].trim() ? [] : args });
            at = start + args.join(',').length + 1;
        }
    };
    const sval = (x) => evaluate(tokenize(String(x ?? '')), st);
    const sknown = (v) => (typeof v === 'string' ? !v.includes(WILD) : v !== UNKNOWN);
    // Новый список анимаций слоя: неизвестное или неназванное имя не меняет ничего, даже счётчик
    const setAnim = (l, list, loop, q) => {
        if (!list.length || list.some((x) => typeof x.n !== 'string' || !sknown(x.n) || !x.n)) return;
        l.a = list.map((x) => x.n);
        l.ats = list.some((x) => x.ts !== 1) ? list.map((x) => x.ts) : undefined;
        l.loop = loop; l.q = q; l.t = ++tick;
    };
    // Аргументы setAnimation у PictureSpine и PictureLive2D: (дорожка, имя | [список], порядок?, continue|reset|none, прерывать?).
    // Список «[a, b/times=2,timeScale=1.5]»: каждая — столько раз, сколько записано (не больше 8)
    const animArgs = (a, args) => {
        const arr = /^\s*\[/.test(args[1] || '');
        const items = arr ? callArgs(args[1].trim(), 1).map(sval) : [a[1]];
        const rest = a.slice(2);
        const cont = (arr ? rest[1] : rest[0]) || 'continue';
        const inter = arr ? rest[2] : rest[1];
        const list = [];
        for (const it of items) {
            if (typeof it !== 'string') { list.push({ n: it, ts: 1 }); continue; }
            const [nm, opts = ''] = `${it}/`.replace(/ +/g, '').split('/');
            const times = Math.min(8, Number((/times=(\d+)/i.exec(opts) || [])[1]) || 1);
            const ts = Number((/timeScale=(\d+\.?\d*)/i.exec(opts) || [])[1]) || 1;
            for (let k = 0; k < times; k++) list.push({ n: nm, ts });
        }
        return { list, loop: cont !== 'none', q: !(inter === true || inter === 'true') };
    };
    const SPINE_HEAD = /^(?:window\s*\.\s*)?(CreateSAnim|SAnim|RemoveSAnim)\s*\(|^\$gameScreen\s*\.\s*spine\s*\(/;
    // Оператор Spine: PKD Spine2DPlayer (CreateSAnim, SAnim, RemoveSAnim) и PictureSpine ($gameScreen.spine(n)); дорожка 0.
    // Ответ — оператор ли это Spine. Строка дальше идёт прежним разбором: её названия остаются упоминаниями картинок
    const spineScript = (str) => {
        const m = hasSpines && SPINE_HEAD.exec(str);
        if (!m) return false;
        const raw = callArgs(str, m[0].length);
        let id, l;
        if (m[1]) {
            const name = sval(raw[0]);
            if (typeof name !== 'string' || !sknown(name)) return true;
            id = `kd:${name}`;
            if (m[1] === 'RemoveSAnim') { dropLayer(id); return true; }
            if (m[1] === 'CreateSAnim') {
                l = newLayer(spineSet(sval(raw[1])));
                l.x = raw[2] === undefined ? 0 : sval(raw[2]); l.y = raw[3] === undefined ? 0 : sval(raw[3]); l.kd = true;
                st.sp.set(id, l); st.spGone.delete(id);
                if (l.set && !depthNow) ownSpine.add(l.set);
            } else l = st.sp.get(id) || back(id);
        } else {
            let n = sval(raw[0]);
            // Номер — переменная, которую потеряли (общее событие не открыли): слой с тем же выражением, иначе слой на картинке один
            if (typeof n !== 'number') {
                n = byRef(raw[0]);
                if (n === undefined) {
                    const own = [...st.sp.values()].filter((x) => x.pic !== undefined && !x.l2);
                    if (own.length !== 1) return true;
                    n = own[0].pic;
                }
            }
            id = `p${n}`;
            l = st.sp.get(id) || back(id);
            if (!l) { l = newLayer(null); l.pic = n; st.sp.set(id, l); }
            if (!/^\d+$/.test(norm(raw[0]))) l.ref = norm(raw[0]);
        }
        if (!l) return true;
        for (const { name, args } of chainOf(str, m[0].length + raw.join(',').length + 1)) {
            const a = args.map(sval);
            const numOr = (v, d) => (v === undefined ? d : typeof v === 'number' ? v : NaN);
            if (l.kd) {
                if (name === 'setPosition' || name === 'moveTo') { l.x = numOr(a[0], 0); l.y = numOr(a[1], 0); }
                else if (name === 'moveBy') { l.x += numOr(a[0], 0); l.y += numOr(a[1], 0); }
                else if (name === 'setScale') { const x = numOr(a[0], 1); l.sc = [x, numOr(a[1], x)]; }
                else if (name === 'setAnimation' || name === 'addAnimation') {
                    const track = name === 'setAnimation' ? a[3] : a[4];
                    if (track !== undefined && track !== 0) continue;
                    // «add» сразу после «set» (до реплики или паузы) — продолжение того же списка: step_4 один раз, потом step_5 по кругу
                    if (name === 'addAnimation' && l.fresh && typeof a[0] === 'string' && sknown(a[0]) && a[0]) { l.a = [...l.a, a[0]].slice(-8); l.loop = a[1] === true; l.t = ++tick; }
                    else setAnim(l, [{ n: a[0], ts: 1 }], a[1] === true, name === 'addAnimation');
                    l.fresh = true;
                }
                else if (name === 'stopAnimation') { l.a = []; l.t = ++tick; }
                else if (name === 'setSkin') l.skin = typeof a[0] === 'string' && sknown(a[0]) && a[0] ? [a[0]] : [];
                else if (name === 'setTimeScale') l.ts = numOr(a[0], 1);
                else if (name === 'setAlpha') l.op = Math.round(numOr(a[0], 1) * 255);
                else if (name === 'fadeIn') l.op = 255;
                else if (name === 'fadeOut') { if (a[1] === true) { dropLayer(id); return true; } l.op = 0; }
                else if (name === 'remove') { dropLayer(id); return true; }
            } else if (name === 'setSkeleton') {
                const set = spineSet(a[0]);
                const keep = { pic: l.pic, ref: l.ref };
                Object.assign(l, newLayer(set), keep);
                if (set && !depthNow) ownSpine.add(set);
            } else if (name === 'setAnimation') {
                if (a[0] !== 0) continue;
                const an = animArgs(a, args);
                setAnim(l, an.list, an.loop, an.q);
            }
            else if (name === 'setSkin') l.skin = a.filter((x) => typeof x === 'string' && sknown(x) && x);
            else if (name === 'setTimeScale') l.ts = numOr(a[0], 1);
            else if (name === 'setScale') l.sc = [numOr(a[0], 1), numOr(a[1], numOr(a[0], 1))];
            else if (name === 'setOffset') l.off = [numOr(a[0], 0), numOr(a[1], 0)];
            else if (name === 'setVisible') l.hide = a[0] === false;
        }
        return true;
    };
    // --- Live2D: PictureLive2D ($gameScreen.live2d(n).цепочка, модель на картинке-носителе) и Live2DInterfaceMZ (команды 357,
    // модель по имени). Слои — те же st.sp, что у Spine (носитель, развилки, off), шаг — l2d. Модели — только из ctx.l2d
    // (галерея нашла их в списке плагина игры); имя движения из события переводим в имя движения альбома модели.
    // Не берём: дорожки выше нулевой (позы, глаза, одежда), смеси, лип-синк и голос по громкости
    const L2D_HEAD = /^\$gameScreen\s*\.\s*live2d\s*\(/;
    const l2dKey = (m) => m.model.replace(/^img\/live2d\//i, '').replace(/\.model3\.json$/i, '').toLowerCase();
    // Имя из setModel — хвост пути «папка/имя» в списке плагина (так игра и ищет: «(?:^|/)имя$»); точное совпадение первее
    const l2dPic = (raw) => {
        if (typeof raw !== 'string' || !sknown(raw)) return null;
        const name = raw.trim().toLowerCase().replace(/\.model3\.json$/, '');
        if (!name) return null;
        const own = ctx.l2d.filter((m) => m.via === 'pic');
        return own.find((m) => l2dKey(m) === name) || own.find((m) => l2dKey(m).endsWith(`/${name}`)) || null;
    };
    const l2dByModel = (set) => ctx.l2d.find((m) => m.model === set);
    // Имя движения из события → имя движения альбома: «Name» из model3.json, «Группа + номер с 1 из двух цифр» (Idle01), у новых
    // версий плагина ещё имя файла
    const l2dMotion = (m, n) => {
        if (typeof n !== 'string' || !sknown(n)) return null;
        const hit = m.motions.find((x) => x.i >= 0 && (x.mname === n || `${x.group}${String(x.i + 1).padStart(2, '0')}` === n)) || m.motions.find((x) => x.i >= 0 && x.base === n);
        return hit ? hit.name : null;
    };
    // Метка движения Live2DInterfaceMZ («m-22») → список «Idle_22, Idle_23» из параметров плагина → движения группы по номеру с 1
    const l2dTag = (m, tag) => {
        const out = [];
        for (const part of String((m.tags && m.tags[String(tag).trim()]) || '').split(',')) {
            const mm = /^\s*(.*?)_(\d+)\s*$/.exec(part);
            const hit = mm && m.motions.find((x) => x.i === Number(mm[2]) - 1 && x.group === mm[1]);
            if (hit) out.push(hit.name);
        }
        return out;
    };
    const l2dLayer = (set) => ({ ...newLayer(set), l2: true, exp: '', col: 1, d: 0 });
    const l2dScript = (str) => {
        const m = L2D_HEAD.exec(str);
        if (!m) return false;
        const raw = callArgs(str, m[0].length);
        let n = sval(raw[0]);
        // Номер — потерянная переменная: слой с тем же выражением, иначе слой Live2D на картинках один
        if (typeof n !== 'number') {
            n = byRef(raw[0], true);
            if (n === undefined) {
                const own = [...st.sp.values()].filter((x) => x.pic !== undefined && x.l2);
                if (own.length !== 1) return true;
                n = own[0].pic;
            }
        }
        const id = `p${n}`;
        let l = st.sp.get(id) || back(id);
        if (!l) { l = l2dLayer(null); l.pic = n; st.sp.set(id, l); }
        if (!/^\d+$/.test(norm(raw[0]))) l.ref = norm(raw[0]);
        for (const { name, args } of chainOf(str, m[0].length + raw.join(',').length + 1)) {
            const a = args.map(sval);
            const numOr = (v, d) => (v === undefined ? d : typeof v === 'number' ? v : NaN);
            const model = l.set ? l2dByModel(l.set) : null;
            // setModel сбрасывает всё, что было на картинке: движения, выражение, цвет, сдвиг, масштаб (init в плагине)
            if (name === 'setModel') {
                const mo = l2dPic(a[0]);
                const keep = { pic: l.pic, ref: l.ref };
                Object.assign(l, l2dLayer(mo ? mo.model : null), keep);
                if (mo && !depthNow) ownSpine.add(mo.model);
            } else if (name === 'setAnimation') {
                if (a[0] !== 0 || !model) continue;
                const an = animArgs(a, args);
                // Имя, которого у модели нет, плагин бросает ошибкой; в сценарии его просто нет, остальные имена играют
                const list = an.list.map((x) => ({ ...x, n: l2dMotion(model, x.n) })).filter((x) => x.n);
                setAnim(l, list, an.loop, an.q);
            } else if (name === 'clearAnimation') { if (a[0] === 0) { l.a = []; l.ats = undefined; l.t = ++tick; } }
            else if (name === 'setExpression') l.exp = typeof a[0] === 'string' && sknown(a[0]) ? a[0] : '';
            else if (name === 'clearExpression') l.exp = '';
            else if (name === 'setTimeScale') l.ts = numOr(a[0], 1);
            else if (name === 'setScale') l.sc = [numOr(a[0], 1), numOr(a[1], numOr(a[0], 1))];
            else if (name === 'setOffset') l.off = [numOr(a[0], 0), numOr(a[1], 0)];
            else if (name === 'setVisible') l.hide = a[0] === false;
            // Цвет по умолчанию (четыре числа): прозрачность 0 прячет модель (так игра убирает и возвращает позу)
            else if (name === 'setColor' && a.length === 4) l.col = Math.max(0, Math.min(1, numOr(a[3], 1)));
            else if (name === 'playVoice') voice(typeof a[0] === 'string' ? a[0].replace(/^.*[\\/]/, '').replace(/\.\w+$/, '') : '', {}, false);
        }
        return true;
    };
    const l2dFace = (c, args) => {
        const mo = ctx.l2d.find((m) => m.via === 'if' && m.name === args.modelName);
        if (!mo) return;
        const id = `i:${args.modelName}`;
        let l = st.sp.get(id) || back(id);
        if (!l) {
            const d = mo.def || {};
            l = l2dLayer(mo.model);
            l.shown = false;
            l.x = Number.isFinite(d.x) ? d.x : 408; l.y = Number.isFinite(d.y) ? d.y : 320;
            l.sc = [0.2 * (Number.isFinite(d.k) ? d.k : 1), 0.2 * (Number.isFinite(d.k) ? d.k : 1)];
            st.sp.set(id, l);
        }
        const d = mo.def || {};
        if (c === 'show') l.shown = true;
        else if (c === 'hide') l.shown = false;
        else if (c === 'motion') {
            const names = String(args.motionName ?? '').split(/\s*,\s*/).flatMap((tag) => l2dTag(mo, tag));
            // Игра ставит очередь заново (прежние движения сметаются); петля — у последнего, если не «false»
            if (names.length) setAnim(l, names.map((n) => ({ n, ts: 1 })), String(args.loop) !== 'false', false);
        }
        else if (c === 'expression') l.exp = String(args.expressionName ?? '');
        else if (c === 'scale') { const k = argNum(args.scale); l.sc = [0.2 * k, 0.2 * k]; }
        else if (c === 'left' || c === 'middle' || c === 'right') { const x = d[c]; if (Number.isFinite(x)) l.x = x; }
        else if (c === 'pos') {
            // dur > 1: модель едет туда dur кадров игры. «wait» (игра стоит, пока едет) паузой не пишем: сцена листается по репликам,
            // а переезд идёт, пока читают
            l.x = argNum(args.x) || 0; l.y = argNum(args.y) || 0;
            const dur = Number(args.dur) || 0;
            l.d = dur > 1 ? dur : 0;
        }
    };
    // «if (…) {…} else {…}»: игра выполняет одну ветку. Условие знаем — идём по ней, не знаем — по первой (как «Если»
    // события с неизвестным условием); обе ветки подряд дали бы имя из двух кусков («…/sse_…/sse_0_r»), которого нет
    const script = (src) => {
        const b = ifBlock(src);
        if (!b) return scriptFlat(src);
        if (b.at) scriptFlat(src.slice(0, b.at));
        const v = evaluate(tokenize(b.cond), st);
        // Ложь — и известные 0, '', null: «if ($gameVariables.value(5)) {…} else {…}» при пятой, равной 0, идёт во вторую ветку
        const body = v === false || (sknown(v) && !v) ? b.b : b.a;
        if (body) script(body);
        script(src.slice(b.end));
    };
    const scriptFlat = (src) => {
        // Цепочка Spine с переносом строки («…setSkeleton('a')» и «.setAnimation(…)» — две строки 655) — одним оператором
        if (spiny && /\b(?:spine|live2d)\s*\(|SAnim\s*\(/.test(src)) src = src.replace(/\n\s*(?=\.\s*[A-Za-z_$])/g, '');
        for (let s of statements(src)) {
            // «if (…) действие», «for (…)» — условие не считаем, само действие — как есть
            for (let m; (m = /^(?:else\s+)?(?:if|for|while)\s*\(/.exec(s));) {
                const head = callArgs(s, m[0].length).join(',');
                s = s.slice(m[0].length + head.length + 1).trim();
            }
            s = s.replace(/^(?:else|try|do)\b\s*/, '');
            if (!s) continue;
            // Spine — в добавок к прежнему разбору, без «continue»: кадры, упоминания и остальной сценарий от него не зависят
            if (spiny && !spineDead) { try { if (!spineScript(s) && l2dOn) l2dScript(s); } catch { spineDead = true; } }
            let did = false;
            // «Стереть все картинки» (3 700 раз в 11 играх библиотеки)
            if (/\$gameScreen\s*\.\s*clearPictures\s*\(/.test(s)) { clearAll(); did = true; }
            for (const m of s.matchAll(/\$gameScreen\s*\.\s*(showPicture|movePicture|erasePicture)\s*\(/g)) {
                did = true;
                const rawArgs = callArgs(s, m.index + m[0].length);
                const a = rawArgs.map((x) => evaluate(tokenize(x), st));
                const n = typeof a[0] === 'number' ? a[0] : UNKNOWN;
                // PictureSpine: картинка-носитель скелета. Номер — выражение, которого не знаем, но то же, что у слоя, — она
                if (spiny) {
                    const hn = n !== UNKNOWN ? n : byRef(rawArgs[0]);
                    const fin = (v) => (typeof v === 'number' ? v : NaN);
                    if (hn !== undefined) {
                        if (m[1] === 'erasePicture') hostErase(hn);
                        else if (m[1] === 'showPicture') hostShow(hn, fin(a[3]), fin(a[4]), typeof a[5] === 'number' ? a[5] : 100, typeof a[6] === 'number' ? a[6] : 100, typeof a[7] === 'number' ? a[7] : 255);
                        else hostMove(hn, a[2] === undefined ? undefined : fin(a[2]), fin(a[3]), typeof a[4] === 'number' ? a[4] : undefined, typeof a[5] === 'number' ? a[5] : undefined, typeof a[6] === 'number' ? a[6] : undefined);
                    }
                }
                if (m[1] === 'erasePicture') {
                    // Номер — переменная цикла, которой не знаем («for (i…) erasePicture(i)»): это «стереть все»; другое
                    // неизвестное выражение — не трогаем ничего
                    if (n !== UNKNOWN) erase(n);
                    else if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(callArgs(s, m.index + m[0].length)[0] || '')) clearAll();
                    continue;
                }
                // Номер по переменной, которой не знаем («value(106) + 23»): переменную считаем нулём
                const slot = n !== UNKNOWN ? n : Number(callArgs(s, m.index + m[0].length)[0].replace(/^[\s\S]*\+\s*(\d+)\s*$/, '$1')) || 0;
                const val = (v, d) => (typeof v === 'number' ? v : d);
                if (m[1] === 'showPicture') {
                    if (a[1] === UNKNOWN || typeof a[1] !== 'string') continue;
                    showPic(slot, a[1], val(a[2], 0), val(a[3], 0), val(a[4], 0), val(a[5], 100), val(a[6], 100), val(a[7], 255), val(a[8], 0));
                } else movePic(slot, val(a[1], 0), val(a[2], 0), val(a[3], 0), val(a[4], undefined), val(a[5], undefined), val(a[6], undefined));
            }
            if (did) continue;
            let m;
            // Затемнение скриптом: «startFadeOut(24)» без паузы; цвет затемнения плагина — «_fadeSprite.setColor(r, g, b)»
            if ((m = /\$gameScreen\s*\.\s*startFade(Out|In)\s*\(([^()]*)\)/.exec(s))) { const n = evaluate(tokenize(m[2]), st); fade(m[1] === 'Out', typeof n === 'number' && n > 0 ? Math.round(n) : FADE, false); continue; }
            if ((m = /\b_fadeSprite\s*\.\s*setColor\s*\(([^()]*)\)/.exec(s))) {
                const rgb = callArgs(m[1] + ')', 0).slice(0, 3).map((x) => evaluate(tokenize(x), st));
                st.fadeColor = rgb.length === 3 && rgb.every((v) => typeof v === 'number') && rgb.some(Boolean) ? rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))) : null;
                continue;
            }
            if ((m = /^AudioManager\s*\.\s*(play(?:Se|StaticSe|Bgm|Bgs|Me|Voice)|stop(?:Bgm|Bgs)|fadeOut(?:Bgm|Bgs))\s*\(/.exec(s))) { scriptSound(m[1], callArgs(s, m[0].length)); continue; }
            if ((m = /^\$game(Variables|Switches)\s*\.\s*setValue\s*\(/.exec(s))) {
                const [k, v] = callArgs(s, m[0].length).map((x) => evaluate(tokenize(x), st));
                if (typeof k === 'number') {
                    if (m[1] === 'Variables') setVar(k, v);
                    else if (typeof v === 'boolean') st.sw.set(k, v); else st.sw.delete(k);
                }
                continue;
            }
            if ((m = /^this\s*\.\s*wait\s*\(\s*(\d+)\s*\)$/.exec(s))) { snap(Number(m[1])); continue; }
            // Имя героя скриптом: известное — запоминаем, любое другое прикосновение к имени — забываем все. Дальше
            // строка идёт как обычно (названия картинок в ней остаются упоминаниями)
            if ((m = /^\$gameActors\s*\.\s*actor\s*\(([^()]*)\)\s*\.\s*setName\s*\(([\s\S]*)\)$/.exec(s))) {
                const id = evaluate(tokenize(m[1]), st);
                const name = evaluate(tokenize(m[2]), st);
                if (typeof id !== 'number') st.names.clear();
                else if (typeof name === 'string' && !name.includes(WILD)) st.names.set(id, name);
                else st.names.delete(id);
            } else if (/setName\s*\(|\._name\b/.test(s)) st.names.clear();
            if ((m = /^(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*(\+=|-=|=(?!=))\s*([\s\S]+)$/.exec(s))) {
                const v = evaluate(tokenize(m[3]), st);
                const was = st.js.has(m[1]) ? st.js.get(m[1]) : UNKNOWN;
                const next = m[2] === '=' ? v : m[2] === '+=' ? (typeof was === 'string' || typeof v === 'string' ? (was === UNKNOWN ? WILD : String(was)) + (v === UNKNOWN ? WILD : String(v)) : typeof was === 'number' && typeof v === 'number' ? was + v : UNKNOWN)
                    : typeof was === 'number' && typeof v === 'number' ? was - v : UNKNOWN;
                if (next === UNKNOWN) st.js.delete(m[1]); else st.js.set(m[1], next);
                if (typeof v === 'string') mention(v);
                continue;
            }
            if ((m = /^([A-Za-z_$][\w$]*)\s*(\+\+|--)$/.exec(s))) {
                const was = st.js.get(m[1]);
                if (typeof was === 'number') st.js.set(m[1], was + (m[2] === '++' ? 1 : -1)); else st.js.delete(m[1]);
                continue;
            }
            // PKD_VPlayer — побочным действием: строка дальше идёт как раньше
            if (s.includes('VAnim')) vanimScript(s);
            // Строки, которые совпадают с картинкой: сцене принадлежит, но не предзагрузка («ImageManager.loadPicture», «Galv.CACHE.load»)
            if (!/\b(?:load|reserve|preload|cache)\w*\s*\(/i.test(s)) for (const t of tokenize(s)) if (t.t === 'str') mention(t.v);
        }
    };
    const cond = (p) => {
        switch (p[0]) {
            case 0: return st.sw.has(p[1]) ? st.sw.get(p[1]) === (p[2] === 0) : null;
            case 1: {
                const a = varOf(p[1]);
                const b = p[2] === 0 ? p[3] : varOf(p[3]);
                if (typeof a !== 'number' || typeof b !== 'number') return null;
                return [a === b, a >= b, a <= b, a > b, a < b, a !== b][p[4]] ?? null;
            }
            case 2: return st.self.has(p[1]) ? st.self.get(p[1]) === (p[2] === 0) : null;
            case 12: { const v = evaluate(tokenize(String(p[1] || '')), st); return typeof v === 'boolean' ? v : null; }
            default: return null;
        }
    };
    const clone = (from) => ({
        ...from,
        pics: new Map([...from.pics].map(([n, p]) => [n, { ...p, ...(p.anim ? { anim: { ...p.anim } } : {}), ...(p.movie ? { movie: { ...p.movie } } : {}) }])),
        kids: new Map([...from.kids].map(([n, k]) => [n, [...k]])), vids: new Map([...from.vids].map(([s, v]) => [s, { ...v, ...(v.nx ? { nx: { ...v.nx } } : {}) }])),
        vars: new Map(from.vars), sw: new Map(from.sw), self: new Map(from.self), js: new Map(from.js), names: new Map(from.names), rnd: new Map(from.rnd),
        paSounds: { ...from.paSounds },
        par: new Map([...from.par].map(([k, pr]) => [k, { ...pr }])), stuck: new Map(from.stuck), primed: new Set(from.primed), gone: new Set(from.gone),
        sp: new Map([...from.sp].map(([n, l]) => [n, copyLayer(l)])), spHost: new Map([...from.spHost].map(([n, h]) => [n, { ...h }])),
        spGone: new Map([...from.spGone].map(([n, g]) => [n, { ...g, l: copyLayer(g.l), h: g.h ? { ...g.h } : null }])),
    });
    // Есть ли в ветке что-то про картинки: с неё и идём дальше, остальные ветки — вариантами
    const PIC_CODES = new Set([231, 232, 235, 117, 355, 356, 357]);
    const pictorial = (cmds, s, e) => { for (let i = s; i < e; i++) if (cmds[i] && PIC_CODES.has(cmds[i].code) && !cmds[i].ext) return true; return false; };
    // Игра пропускает ветку «Если», если известно, что условие ложно: имя героя другое или выпало другое число. told:
    // false — пропустила, true — пошла, null — не знаем. Только для «Если» с одной веткой (без «иначе»)
    const tell = (p, mem) => {
        if (p[0] === 4 && p[2] === 1 && st.names.has(p[1])) return st.names.get(p[1]) === String(p[3] ?? '');
        const n = mem && /^v\d+$/.test(mem.chain.key) ? Number(mem.chain.key.slice(1)) : -1;
        return n >= 0 && st.rnd.has(n) ? String(st.rnd.get(n)) === mem.val : null;
    };
    // Вырезать шаги по самому объекту (номера плывут, когда вырезают вложенные выборы); экран не режем никогда. Что вырезали —
    // в cuts, если сцена из-за этого останется без реплик и звука
    const cut = (list) => {
        const batch = [];
        for (const x of list) {
            const at = scenario.lastIndexOf(x);
            if (at >= 0) { scenario.splice(at, 1); batch.push([at, x]); if (inExt.has(x)) extRec--; else if (inDecor.has(x)) decor--; else if (inSide.has(x)) side--; }
        }
        if (batch.length) cuts.push(batch);
    };
    // Ветка пройдена: что из записанного ею (с шага at) игра не сыграла бы. told false — звук, вспышки и тряска, у веток
    // по имени — и реплики с паузами; их режем в конце всего выбора (пока не знаем, дошёл ли обход до подходящей ветки и
    // не отказали ли шагу из-за предела). Бросок: ветки с репликами и паузами оставляем как есть. Значение неизвестно —
    // у звуков, которые играют вместе (se, me), оставляем один, если во всех ветках он один и тот же, иначе ни одного
    const settle = (p, mem, solo, told, at, blinded, refusedAt) => {
        if (!solo || scenario.length <= at || (told === null && !mem)) return;
        const mine = scenario.slice(at);
        const instant = mine.every((x) => INSTANT.has(x.k));
        const gone = mine.filter((x) => !SCREEN.has(x.k));
        if (told === false) {
            if (instant) cut(gone);
            else if (p[0] === 4 && !mem) { if (refused === refusedAt) cut(gone); }
            else if (p[0] === 4) {
                const q = pend.get(mem.chain) || { steps: [], refusedAt };
                q.steps.push(...gone);
                pend.set(mem.chain, q);
            }
        } else if (told === null && instant && blind === blinded) {
            const snds = mine.filter((x) => x.k === 'snd' && OVERLAP.has(x.kind));
            if (!snds.length) return;
            const sig = JSON.stringify(snds.map((x) => [x.kind, x.f]));
            const h = heard.get(mem.chain);
            if (!h) { heard.set(mem.chain, { sig, steps: snds }); return; }
            if (h.sig !== sig && h.steps.length) { cut(h.steps); h.steps = []; }
            cut(snds);
        }
    };
    // Выбор кончился: отложенное режем, если обход дошёл до конца и ни одному шагу не отказали
    const flush = (chain) => {
        const q = pend.get(chain);
        if (q && refused === q.refusedAt) cut(q.steps);
        pend.delete(chain);
        heard.delete(chain);
    };
    const loopEnd = (cmds, i) => {
        const ind = cmds[i].indent || 0;
        for (let j = i + 1; j < cmds.length; j++) if (cmds[j] && cmds[j].code === 413 && (cmds[j].indent || 0) === ind) return j;
        return cmds.length;
    };
    // --- Какие параллельные страницы идут. Знаем только то, что сцена поставила сама; чего не знаем — «нет». Внутри
    // разворота ExternMessage (sandbox > 0) страницы не включаем и не выключаем: он переменных сцены не трогает
    // Картинка сцены (CG, слой, анимация, кадр листа), а не интерфейс, значок или портрет
    const scenePic = (v) => !!(v.cell || v.seq || (ctx && ctx.kind && ['cg', 'layer', 'animation'].includes(ctx.kind(v.name)) && !NOT_CG.test(v.name)));
    const watchOf = (plist, own) => { const w = watched(plist, ces); return JSON.stringify([w.vars.map((n) => varOf(n) ?? null), w.sw.map((n) => st.sw.get(n) ?? null), own && w.self ? [...st.self] : 0]); };
    // Проход страницы в песочнице: её кадры (картинки сцены) со временем, пока состояние не повторилось или она не
    // выключила себя сама («один раз»). Пусто — не анимация или зависит от того, чего не знаем
    const cycleOf = (key, w, watch) => {
        const ck = `${key}\n${watch}`;
        if (cycles.has(ck)) return cycles.get(ck);
        let cyc = NO_CYCLE;
        try {
            const r = runList(w.list, ces, ctx, { init: { vars: st.vars, sw: st.sw, self: w.own ? st.self : null }, maxSteps: PAR_STEPS, strict: true, passes: ANIM_CELLS, gate: w.gate });
            if (!r.unsure) cyc = cycleFrom(r.scenario, scenePic, !!r.off) || NO_CYCLE;
        } catch { cyc = NO_CYCLE; }
        cycles.set(ck, cyc);
        return cyc;
    };
    // Страница выключилась: её картинки остаются, какими были (петля — какой кадр последний, не знаем: первый), пока сцена
    // не положит или не сотрёт свою. Не остаются — если время с её включения не шло или номер в тот же миг взяла сцена.
    // Номер, где картинка сцены сама кадр этой страницы, — primed: в альбоме остаётся картинка сцены
    const stopPage = (pr) => {
        const f = pr.ran && !pr.done ? pr.cyc.frames[rest(pr)] : null;
        if (f) {
            for (const v of f.pics) {
                if (st.gone.has(v.n)) continue;
                const own = st.pics.get(v.n);
                st.stuck.set(v.n, v);
                if (own && pr.names.has(`${v.n}:${own.name}`)) st.primed.add(v.n); else st.primed.delete(v.n);
            }
        }
    };
    // written — что сцена только что записала (s12, v5, self; null — всё): страница «один раз», что уже доиграла,
    // запускается снова, когда сцена снова ставит её условие
    const sync = (written = null, forced = false) => {
        if (!pars || sandbox) return;
        // Ничего не идёт, а записанное не входит в условия ни одной страницы — пересчитывать нечего (команд 121 и 122 в
        // сценах тысячи); перенос на карту (forced) и «всё стёрто» (written = null) считаем всегда
        if (written && !forced && !st.par.size && ![...parIds(pars)].some((x) => written.has(x))) return;
        const want = new Map();
        const battle = !!env.battle;
        for (const ce of pars.ce) {
            const key = `ce${ce.id}`;
            if (key === env.self || st.sw.get(ce.sw) !== true) continue;
            // В бою общие события «параллельно» не идут — только с плагином (NRP_BattleParallelCommon, BattleParallelEvent);
            // а плагин может держать событие только в бою (invalidOnMap)
            if (battle ? !(pars.battle && (pars.battle.all || pars.battle.ids.has(ce.id))) : !!(pars.battle && pars.battle.mapOff.has(ce.id))) continue;
            want.set(key, { list: ce.list, gate: (S) => S.sw.get(ce.sw) === true, ids: [`s${ce.sw}`], own: false });
        }
        // Страницы карты — только на карте (в бою события карты стоят): самая старшая страница события, чьи условия выполнены
        for (const ev of !battle && mapAt !== null ? pars.maps.get(mapAt) || [] : []) {
            const own = ev.id === env.ev && mapAt === env.map;
            const i = activePage(ev.pages, st, own);
            if (i < 0 || !ev.pages[i].list) continue;
            const key = `m${mapAt}e${ev.id}p${i}`;
            if (key === env.self) continue;
            want.set(key, { list: ev.pages[i].list, gate: (S) => activePage(ev.pages, S, own) === i, ids: ev.ids, own });
        }
        for (const [k, pr] of st.par) if (!want.has(k)) { stopPage(pr); st.par.delete(k); }
        for (const [k, w] of want) {
            const had = st.par.get(k);
            const watch = watchOf(w.list, w.own);
            const again = had && had.done && (!written || w.ids.some((x) => written.has(x)));
            if (had && had.watch === watch && !again) continue;
            // Варианты сцены (другие ветки) — без новых страниц, как и без анимаций
            if (st.alt || parRuns >= PAR_MAX) continue;
            parRuns++;
            const cyc = cycleOf(k, w, watch);
            const names = new Set(cyc.frames.flatMap((f) => f.pics.map((v) => `${v.n}:${v.name}`)));
            const slots = new Set(cyc.frames.flatMap((f) => f.pics.map((v) => v.n)));
            for (const n of slots) st.stuck.delete(n);
            st.par.set(k, { key: k, cyc, names, slots, watch, told: false, done: false, ran: false, clipped: false });
        }
    };
    // Песочница: страница выключила своё условие — игра её больше не крутит
    const gated = () => { if (env && env.gate && !sandbox && !env.gate(st)) halt = true; };
    // Что записала команда: «s12», «v5» в диапазоне [a, b] — проверка по номеру, не перечень («переменные 1–9999»). Когда ничего не
    // идёт, а в диапазоне нет условия ни одной страницы, пересчёта нет (в сценах таких команд тысячи, и почти все — не те)
    const syncRange = (pre, a, b) => {
        if (!pars || sandbox) return;
        if (!st.par.size) {
            const ids = parIds(pars);
            let hit = false;
            if (b - a < 64) { for (let k = a; k <= b && !hit; k++) hit = ids.has(`${pre}${k}`); } else for (const x of ids) if (x[0] === pre && Number(x.slice(1)) >= a && Number(x.slice(1)) <= b) hit = true;
            if (!hit) return;
        }
        sync({ has: (x) => x[0] === pre && Number(x.slice(1)) >= a && Number(x.slice(1)) <= b });
    };
    const walk = (cmds, from, to, depth, alt) => {
        for (let i = from; i < to; i++) {
            const c = cmds[i];
            if (!c) continue;
            if (halt) return BREAK;
            // Команды разворота ExternMessage — на своём счёте; их голова (ext:'head') стоит за строку 401, которую заменила, и
            // считается как она. Реплики 101/401 из CSV не считаем вовсе
            if (sandbox || (c.ext && c.ext !== 'head')) {
                if (!(c.ext && (c.code === 101 || c.code === 401)) && ++extSteps > EXT_STEPS) { if (sandbox) return BREAK; continue; }
            } else if (++steps > maxSteps || count() >= MAX_FRAMES) return BREAK;
            const p = c.parameters || [];
            depthNow = depth;
            switch (c.code) {
                case 231: {
                    // Положение по переменным (тип 1): знаем значения — ставим, нет — левый верхний угол
                    const byVar = p[3] === 1;
                    const x = byVar ? Number(varOf(p[4])) || 0 : p[4];
                    const y = byVar ? Number(varOf(p[5])) || 0 : p[5];
                    showPic(p[0], p[1], p[2], x, y, p[6], p[7], p[8], Number(p[9]) || 0);
                    // Носитель PictureSpine: положение по переменной, которой не знаем, — NaN (слой без места, плеер вписывает его сам)
                    if (spiny) hostShow(p[0], byVar ? (typeof varOf(p[4]) === 'number' ? varOf(p[4]) : NaN) : Number(p[4]), byVar ? (typeof varOf(p[5]) === 'number' ? varOf(p[5]) : NaN) : Number(p[5]), p[6], p[7], p[8]);
                    break;
                }
                case 232: {
                    const byVar = p[3] === 1;
                    if (spiny) hostMove(p[0], byVar ? (typeof varOf(p[4]) === 'number' ? varOf(p[4]) : NaN) : Number(p[4]), byVar ? (typeof varOf(p[5]) === 'number' ? varOf(p[5]) : NaN) : Number(p[5]), p[6], p[7], p[8]);
                    if (!byVar) movePic(p[0], p[2], p[4], p[5], p[6], p[7], p[8]);
                    else if (typeof varOf(p[4]) === 'number' && typeof varOf(p[5]) === 'number') movePic(p[0], p[2], varOf(p[4]), varOf(p[5]), p[6], p[7], p[8]);
                    else movePic(p[0], p[2], undefined, undefined, p[6], p[7], p[8]);
                    // «Ждать завершения»: игра стоит, пока картинка едет или проявляется. Плеер показывает конечный вид и ждёт столько же
                    if (p[11] && Number(p[10]) > 0) note(Number(p[10]));
                    break;
                }
                // Тон, вспышка, тряска экрана — шагом для плеера; с «ждать завершения» — и паузой. Перед эффектом — экран,
                // каким его оставили команды до него: вспышка идёт по уже показанной картинке
                case 223: note(); rec({ k: 'fx', t: 'tint', c: Array.isArray(p[0]) ? p[0].map(Number) : [0, 0, 0, 0], n: Number(p[1]) || 0 }); if (p[2] && Number(p[1]) > 0) note(Number(p[1])); break;
                case 224: note(); rec({ k: 'fx', t: 'flash', c: Array.isArray(p[0]) ? p[0].map(Number) : [255, 255, 255, 170], n: Number(p[1]) || 0 }); if (p[2] && Number(p[1]) > 0) note(Number(p[1])); break;
                case 225: note(); rec({ k: 'fx', t: 'shake', p: Number(p[0]) || 5, s: Number(p[1]) || 5, n: Number(p[2]) || 0 }); if (p[3] && Number(p[2]) > 0) note(Number(p[2])); break;
                case 234: if (p[3] && Number(p[2]) > 0) note(Number(p[2])); break;
                case 235: erase(p[0]); break;
                case 101: {
                    // Песочница: страница с репликой — не петля картинок
                    if (strict) unsure = true;
                    // Реплика — строки окна как в игре (401), коды разбирает speech() уже при показе: перевод ищется по ним
                    const lines = [];
                    for (let j = i + 1; cmds[j] && cmds[j].code === 401; j++) lines.push(String(cmds[j].parameters?.[0] ?? ''));
                    // Реплика из CSV: кадра альбома под ней нет (иначе альбомы игры поменялись бы), только сценарий
                    if (c.ext) extSay++;
                    say(lines, p[4], !c.ext);
                    if (c.ext) extSay--;
                    break;
                }
                case 241: case 245: case 249: audio(c.code, p[0]); break;
                case 250: if (st.paSoundAt) paReserve(p[0]); else audio(c.code, p[0]); break;
                // Затемнение и появление экрана; новая карта (201) — новый слой экрана, цвет затемнения сбрасывается
                case 221: fade(true, FADE, true); break;
                case 222: fade(false, FADE, true); break;
                // Перенос на другую карту: её параллельные страницы, прежние — встают. По переменным (p[0] != 0) карту не знаем —
                // прежние гасим, новых не включаем
                case 201: st.fadeColor = null; if (pars && !sandbox) { mapAt = p[0] === 0 ? p[1] : null; sync(new Set(), true); } break;
                case 242: case 246: rec({ k: 'stop', kind: c.code === 242 ? 'bgm' : 'bgs', fade: Number(p[0]) || 0 }); break;
                case 230: snap(Number(p[0]) || 0); break;
                case 121: for (let k = p[0]; k <= p[1]; k++) st.sw.set(k, p[2] === 0); syncRange('s', p[0], p[1]); gated(); break;
                case 123: st.self.set(p[0], p[1] === 0); sync(new Set(['self'])); gated(); break;
                // Ввод числа, выбор предмета — переменную ставит игрок; данные места на карте (285) — игра
                case 103: case 104: case 285: st.vars.delete(p[0]); st.rnd.delete(p[0]); break;
                // Имя героя: команда ставит строку (в MZ те же параметры); ввод имени игроком — имя уже не знаем
                case 320: if (typeof p[1] === 'string') st.names.set(p[0], p[1]); else st.names.delete(p[0]); break;
                case 303: st.names.delete(p[0]); break;
                case 122: {
                    // Операнд: 0 — число, 1 — переменная, 4 — скрипт; остальное (случайное, данные игры) — не знаем
                    const v = p[3] === 0 ? p[4] : p[3] === 1 ? varOf(p[4]) : p[3] === 4 ? evaluate(tokenize(String(p[4] || '')), st) : UNKNOWN;
                    for (let k = p[0]; k <= p[1]; k++) {
                        const was = varOf(k);
                        st.rnd.delete(k);
                        if (p[2] === 0) { setVar(k, v); continue; }
                        if (typeof was !== 'number' || typeof v !== 'number') { st.vars.delete(k); continue; }
                        setVar(k, [was, was + v, was - v, was * v, v ? Math.trunc(was / v) : was, v ? was % v : was][p[2]]);
                    }
                    // Бросок «случайное от a до b»: одно значение на бросок, чтобы все «Если» по этой переменной сошлись; следующий
                    // раз той же команды — следующее значение (по кругу)
                    if (p[2] === 0 && p[3] === 2 && Number.isFinite(p[4]) && Number.isFinite(p[5]) && p[5] >= p[4]) {
                        // Ветки-варианты и повторы цикла счётчик не двигают и берут последнее выданное значение: k-й бросок
                        // главного пути должен получить k-е значение
                        const main = !st.alt && !quiet;
                        const n = main ? rolls.get(c) || 0 : Math.max((rolls.get(c) || 0) - 1, 0);
                        if (main) rolls.set(c, n + 1);
                        for (let k = p[0]; k <= p[1]; k++) st.rnd.set(k, p[4] + (n % (p[5] - p[4] + 1)));
                    }
                    syncRange('v', p[0], p[1]);
                    gated();
                    break;
                }
                case 355: {
                    let src = String(p[0] || '');
                    while (cmds[i + 1] && cmds[i + 1].code === 655) src += `\n${cmds[++i].parameters?.[0] ?? ''}`;
                    if (c.ext) { const keep = clone(st); sandbox++; script(src); sandbox--; st = keep; } else script(src);
                    // Скрипт ставит переключатель или переменную — как команды 121 и 122
                    if (!c.ext && (pars || env)) {
                        const w = new Set();
                        for (const m of src.matchAll(/\$game(Switches|Variables)\s*\.\s*setValue\s*\(\s*(\d+)/g)) w.add(`${m[1] === 'Switches' ? 's' : 'v'}${m[2]}`);
                        sync(w);
                        gated();
                    }
                    break;
                }
                case 356: case 357: plugin(c); break;
                case 261: {
                    // «Показать видео»: на весь экран поверх всего, игра ждёт конца. Плагин со своим command261 (MovieManager)
                    // двигает ролик и не ждёт — такого не пишем
                    const f = ctx && !ctx.movieManager && !sandbox ? movieOne(p[0]) : null;
                    if (!f) break;
                    st.vids.set('m', { f, loop: false, fit: true, top: true, ...(depthNow === 0 ? { own: true } : {}) });
                    vwait('m');
                    st.vids.delete('m');
                    break;
                }
                case 113: return BREAK;
                case 112: {
                    const end = loopEnd(cmds, i);
                    const states = new Set();
                    // Цикл, где события по очереди показывают кадры и ждут (анимация «вручную»), записываем проходами подряд — между
                    // метками rep, одним нажатием их можно пропустить. Первый проход пишется как обычно; следующие — «украшение»,
                    // пока они показывают новое: проход без новой картинки откатываем, остальные — тихо, как раньше
                    const from0 = scenario.length;
                    let again = false;
                    let open = null;
                    let waited = 0;
                    for (let k = 0; k < LOOP_MAX; k++) {
                        const key = JSON.stringify([[...st.vars], [...st.sw], [...st.self], [...st.js]]);
                        if (states.has(key)) break;
                        states.add(key);
                        st.loops++;
                        if (k && again && !open) { extra++; if (!rec(open = { k: 'rep', o: 1 })) { open = null; again = false; } extra--; }
                        const unroll = k > 0 && again;
                        let mark = null;
                        if (k && !unroll) quiet++;
                        if (unroll) { extra++; mark = { len: scenario.length, ext: extRec, decor, side, refused, last: lastPics, vids: lastVids, cuts: cuts.length, before: picSig(screen()), spine: spineN, spLast: new Map(lastSpine) }; }
                        const r = walk(cmds, i + 1, end, depth, alt);
                        if (k && !unroll) quiet--;
                        if (unroll) {
                            extra--;
                            const mine = scenario.slice(mark.len);
                            if (!passShows(mine, mark.before)) {
                                scenario.length = mark.len;
                                extRec = mark.ext; decor = mark.decor; side = mark.side; refused = mark.refused; lastPics = mark.last; lastVids = mark.vids; cuts.length = mark.cuts; spineN = mark.spine; lastSpine.clear(); for (const [k, v] of mark.spLast) lastSpine.set(k, v);
                                again = false;
                            } else {
                                waited += mine.reduce((a, x) => a + (x.k === 'wait' ? x.n : 0), 0);
                                if (scenario.length - from0 >= LOOP_SCRIPT || waited >= LOOP_SCRIPT_WAIT) again = false;
                            }
                        } else if (!k) again = scenario.length > from0 && animates(scenario.slice(from0));
                        st.loops--;
                        if (r === BREAK || steps > maxSteps || count() >= MAX_FRAMES) break;
                    }
                    if (open) {
                        extra++;
                        if (scenario[scenario.length - 1] === open) { scenario.pop(); decor--; } else rec({ k: 'rep', o: 0 });
                        extra--;
                    }
                    i = end;
                    break;
                }
                case 111: case 102: case 301: {
                    if (c.code === 102) snap(0, true);
                    // «Если ролик на картинке n кончился» (MoviePicture isVideoEnd) в цикле меток — игра ждёт его конца
                    if (c.code === 111 && p[0] === 12) { const m = /^\s*\$gameScreen\s*\.\s*picture\s*\(\s*(\d+)\s*\)\s*\.\s*isVideoEnd\s*\(\s*\)\s*;?\s*$/.exec(String(p[1] || '')); if (m) vwait(`p${m[1]}`); }
                    const { branches, end } = blockOf(cmds, i);
                    if (!branches.length) break;
                    let pick = null;
                    const mem = c.code === 111 ? selectors(cmds).get(i) : undefined;
                    if (mem && mem.chain.first === i) { heard.delete(mem.chain); pend.delete(mem.chain); }
                    if (c.code === 111) {
                        const v = cond(p);
                        // Условие знаем — идём только по нужной ветке
                        if (v !== null) {
                            const b = v ? branches[0] : branches[1];
                            if (b && walk(cmds, b[0], b[1], depth, alt) === BREAK) return BREAK;
                            if (mem && mem.chain.last === i) flush(mem.chain);
                            i = end;
                            break;
                        }
                    }
                    // Песочница: ветка по тому, чего не знаем, с картинками, выбор, бой — кадры страницы зависят от игрока
                    if (strict && (c.code !== 111 || branches.some(([s, e]) => pictorial(cmds, s, e)))) unsure = true;
                    pick = branches.findIndex(([s, e]) => pictorial(cmds, s, e));
                    if (pick < 0) pick = 0;
                    // Выбор: плеер покажет варианты и тот, по которому пошла сцена (первый с картинками)
                    if (c.code === 102 && Array.isArray(p[0])) rec({ k: 'choice', o: p[0].map(String), i: pick < p[0].length ? pick : -1, ...cast(p[0]) });
                    // Варианты — только в самой сцене: общее событие, которое она зовёт (портрет по одежде и стадии), —
                    // одной веткой, как раньше
                    const rest = depth || altFrames >= ALT_FRAMES ? [] : branches.filter((b, k) => k !== pick && pictorial(cmds, b[0], b[1]));
                    const before = rest.length ? clone(st) : null;
                    // Карта (201) живёт вне st, как и страницы на ней: ветки-варианты начинают с карты развилки и не оставляют свою
                    const mapFork = mapAt;
                    // Ветка «Если» без «иначе», которую игра пропустила бы: что она ставит (имя, бросок), в сцене не остаётся
                    const solo = c.code === 111 && branches.length === 1;
                    const told = solo ? tell(p, mem) : null;
                    const kept = told === false ? [new Map(st.names), new Map(st.rnd)] : null;
                    const at = scenario.length;
                    const blinded = blind;
                    const refusedAt = refused;
                    forks.push(++forkN);
                    const r = walk(cmds, branches[pick][0], branches[pick][1], depth, alt);
                    forks.pop();
                    if (kept) { [st.names, st.rnd] = kept; }
                    if (r !== BREAK) {
                        settle(p, mem, solo, told, at, blinded, refusedAt);
                        if (mem && mem.chain.last === i) flush(mem.chain);
                    }
                    if (rest.length) {
                        // Конец своей ветки — кадром (дальше за ним — варианты из других веток), потом каждая другая ветка —
                        // от того, что было до развилки
                        snap(0, false, true);
                        const forked = frames[frames.length - 1];
                        const mine = clone(st);
                        const mapMine = mapAt;
                        for (const [s, e] of rest) {
                            st = { ...clone(before), echo: null, alt: true };
                            mapAt = mapFork;
                            const was = JSON.stringify(current());
                            forks.push(++forkN);
                            walk(cmds, s, e, depth, true);
                            forks.pop();
                            if (JSON.stringify(current()) !== was) snap(0, false, true);
                        }
                        st = mine;
                        mapAt = mapMine;
                        // Этот кадр уже снят — следующая реплика его не повторяет
                        st.echo = JSON.stringify(current());
                        st.echoFrame = forked && !forked.alt && JSON.stringify(forked.pics) === st.echo ? forked : null;
                    }
                    if (r === BREAK) return BREAK;
                    i = end;
                    break;
                }
                case 117: {
                    // В вариантах общее событие не открываем: так зовут сцены из комнаты воспоминаний — у них свой альбом
                    const id = p[0];
                    // Из CSV («:event[n]») открываем только то, что говорит или играет, и в песочнице: сцена не видит, что оно
                    // сделало с картинками и переменными. Не открытое переменных не стирает и слепым не считается
                    if (c.ext && !recordable.has(id)) break;
                    if (!alt && depth < MAX_DEPTH && ces[id] && !seen.has(id)) {
                        seen.add(id);
                        const keep = c.ext ? clone(st) : null;
                        // Заказ звука кадра («PA_SOUND») действует в том, кто его дал: общее событие его не получает
                        const reserved = st.paSoundAt;
                        st.paSoundAt = 0;
                        if (keep) sandbox++;
                        walk(ces[id].list || [], 0, (ces[id].list || []).length, depth + 1, alt);
                        if (keep) { sandbox--; st = keep; }
                        st.paSoundAt = reserved;
                        seen.delete(id);
                    } else if (ces[id] && !c.ext) {
                        // Его не открыли — что оно поменяло в переменных, не знаем. Упёрлись только в глубину — забываем лишь то,
                        // что оно (и вложенные) пишет: номер позы у сцены не должен пропадать из-за вызова в четвёртом ярусе
                        if (!alt && depth >= MAX_DEPTH && !seen.has(id)) forgetWrites(st, ceWrites(ces, id));
                        else { st.vars.clear(); st.sw.clear(); st.self.clear(); st.names.clear(); st.rnd.clear(); }
                        blind++;
                        if (strict) unsure = true;
                        sync();
                    }
                    break;
                }
                default: break;
            }
        }
        return 0;
    };
    // Параллельная страница повторяется, пока держится её условие: проходы — пока состояние не повторилось (петля) или
    // она не выключила себя сама («один раз»). Обычная сцена — один проход
    const passes = (env && env.passes) || 1;
    const seenPass = new Set();
    let repeat = false;
    for (let k = 0; k < passes && !halt; k++) {
        if (passes > 1) {
            const key = JSON.stringify([[...st.vars], [...st.sw], [...st.self], [...st.js]]);
            if (seenPass.has(key)) { repeat = true; break; }
            seenPass.add(key);
        }
        walk(list || [], 0, (list || []).length, 0, false);
        if (steps > maxSteps || count() >= MAX_FRAMES) break;
    }
    ending = true;
    snap();
    // Всё вырезали, а картинки остались: сцена без реплик и звука не получит «Смотреть сцену» — возвращаем вырезанное
    // по порядку, пока не вернётся реплика или звук
    if (cuts.length && scenario.some((x) => x.k === 'pics') && !scenario.some((x) => x.k === 'say' || x.k === 'snd')) {
        for (const batch of cuts) {
            for (const [at, x] of [...batch].reverse()) { scenario.splice(Math.min(at, scenario.length), 0, x); if (inExt.has(x)) extRec++; else if (inDecor.has(x)) decor++; else if (inSide.has(x)) side++; }
            if (scenario.some((x) => x.k === 'say' || x.k === 'snd')) break;
        }
    }
    const shots = [...parOf.values()].some((x) => x.o.length);
    // Шаги, что отменила вернувшаяся ветка (back), — вон; наборы, что событие создало само, нужны отбору сцен (analyze)
    return { frames, mentions: mentions.size > MENTIONS_MAX ? [] : [...mentions], movies, scenario: scenario.some((x) => x.drop) ? scenario.filter((x) => !x.drop) : scenario, ...(ownSpine.size ? { ownSpine } : {}), ...(blank ? { blank: true } : {}),
        ...(parClips.length ? { parClips } : {}), ...(shots ? { parOf } : {}),
        ...(unsure ? { unsure } : {}), ...(halt ? { off: true } : {}), ...(passes > 1 && !halt && !repeat ? { cut: true } : {}) };
}

// Номера, от которых зависит включение страниц игры: переключатели общих событий и условия страниц карт («s12», «v5», «self»)
const PAR_IDS = new WeakMap();
function parIds(pars) {
    if (!PAR_IDS.has(pars)) PAR_IDS.set(pars, new Set([...pars.ce.map((c) => `s${c.sw}`), ...[...pars.maps.values()].flatMap((evs) => evs.flatMap((e) => e.ids))]));
    return PAR_IDS.get(pars);
}

// Самая старшая страница события, чьи условия выполнены (так игра выбирает страницу), или -1. Чего не знаем — «нет».
// Своё событие сцены (own) — и по её переключателям «A–D»
function activePage(pages, S, own) {
    for (let i = pages.length - 1; i >= 0; i--) {
        const c = pages[i].c;
        if (!c) return i;
        if (c.switch1Valid && S.sw.get(c.switch1Id) !== true) continue;
        if (c.switch2Valid && S.sw.get(c.switch2Id) !== true) continue;
        if (c.variableValid) { const v = S.vars.get(c.variableId); if (!(typeof v === 'number' && v >= c.variableValue)) continue; }
        if (c.selfSwitchValid && !(own && S.self.get(c.selfSwitchCh) === true)) continue;
        if (c.itemValid || c.actorValid) continue;
        return i;
    }
    return -1;
}

// Что читает параллельная страница (и общие события, которые она зовёт): переключатели и переменные в условиях,
// операндах, именах «\\V[n]» и скриптах. Её проход пересчитываем, только когда сцена меняет их (стадия, номер кадра).
// Команды разворота ExternMessage (ext) — не её: их читает только сцена
const WATCHED = new WeakMap();
function watched(list, ces, depth = 0, seen = new Set()) {
    if (WATCHED.has(list) && !depth) return WATCHED.get(list);
    const vars = new Set();
    const sw = new Set();
    let self = false;
    for (const c of list || []) {
        if (!c || c.ext) continue;
        const p = c.parameters || [];
        if (c.code === 111 && p[0] === 0) sw.add(p[1]);
        if (c.code === 111 && p[0] === 1) { vars.add(p[1]); if (p[2] === 1) vars.add(p[3]); }
        if (c.code === 111 && p[0] === 2) self = true;
        if (c.code === 122 && p[3] === 1) vars.add(p[4]);
        if ((c.code === 231 || c.code === 232) && p[3] === 1) { vars.add(p[4]); vars.add(p[5]); }
        if (c.code === 117 && ces && ces[p[0]] && depth < MAX_DEPTH && !seen.has(p[0])) {
            seen.add(p[0]);
            const w = watched(ces[p[0]].list, ces, depth + 1, seen);
            for (const n of w.vars) vars.add(n);
            for (const n of w.sw) sw.add(n);
            self = self || w.self;
        }
        const text = JSON.stringify(p);
        for (const m of text.matchAll(/\\\\v\[(\d+)\]/gi)) vars.add(Number(m[1]));
        for (const m of text.matchAll(/\$gameVariables\s*\.\s*value\s*\(\s*(\d+)/g)) vars.add(Number(m[1]));
        for (const m of text.matchAll(/\$gameSwitches\s*\.\s*value\s*\(\s*(\d+)/g)) sw.add(Number(m[1]));
    }
    const out = { vars: [...vars].sort((a, b) => a - b), sw: [...sw].sort((a, b) => a - b), self };
    if (!depth) WATCHED.set(list, out);
    return out;
}

// Кадры прохода страницы из её сценария (песочница): экран — только картинки сцены, и сколько он стоит: паузы, ожидание
// движения и эффектов («ждать завершения»), как в игре. Смена без паузы — видна только последняя. Звуки (эффекты,
// голоса) — по времени от первого кадра. Петля: пауза до первого кадра — хвост последнего (круг), а номера, которые
// проход рисует не с начала, в начале круга стоят такими, какими их оставил прошлый проход. Только анимация: два кадра и
// больше, хоть под одним номером меняется сама картинка (не тряска и не мигание), каждый кадр — не дольше PAR_WAIT
const NO_CYCLE = { frames: [], at: [], sig: [], len: 0, s: [] };
function cycleFrom(steps, keep, once) {
    const frames = [];
    const sounds = [];
    const vis = (pics) => pics.filter((v) => Number(v.op ?? 255) > 0);
    const sigOf = (pics) => JSON.stringify(vis(pics).map((v) => [v.n, v.name, v.x, v.y, v.zx, v.zy, v.cell ? v.cell.i : -1]));
    let lead = 0;
    let t = 0;
    for (const x of steps) {
        if (x.k === 'pics') {
            const pics = x.pics.filter(keep);
            const last = frames[frames.length - 1];
            if (!pics.length && !last) continue;
            if (last && (!last.d || sigOf(last.pics) === sigOf(pics))) { last.pics = pics; continue; }
            frames.push({ pics, d: 0 });
        } else if (x.k === 'wait') {
            if (frames.length) frames[frames.length - 1].d += x.n; else lead += x.n;
            t += x.n;
        } else if (x.k === 'snd' && (x.kind === 'se' || x.kind === 'voice')) sounds.push([t, { f: x.f, vol: x.vol, pitch: x.pitch, pan: x.pan }]);
        // Анимация плагина, реплика, выбор внутри страницы — не петля картинок
        else if (x.k === 'anim' || x.k === 'say' || x.k === 'choice') return null;
        if (frames.length > ANIM_CELLS) return null;
    }
    // Одинаковые подряд (после склейки смен без паузы) — один кадр
    const merged = [];
    for (const f of frames) {
        const last = merged[merged.length - 1];
        if (last && sigOf(last.pics) === sigOf(f.pics)) last.d += f.d; else merged.push({ pics: f.pics, d: f.d });
    }
    if (merged.length < 2) return null;
    if (!once) {
        merged[merged.length - 1].d += lead;
        const end = merged[merged.length - 1].pics;
        for (const v of end) {
            for (const f of merged) {
                if (f.pics.some((u) => u.n === v.n)) break;
                f.pics = [...f.pics, v].sort((a, b) => a.n - b.n);
            }
        }
    }
    const last = merged[merged.length - 1];
    if (!last.d) last.d = 1;
    const by = new Map();
    for (const f of merged) for (const v of vis(f.pics)) { if (!by.has(v.n)) by.set(v.n, new Set()); by.get(v.n).add(v.cell ? `${v.name}#${v.cell.i}` : v.name); }
    if (![...by.values()].some((x) => x.size >= 2)) return null;
    if (merged.some((f, k) => !(once && k === merged.length - 1) && !(f.d >= 1 && f.d <= PAR_WAIT))) return null;
    const at = [];
    let len = 0;
    for (const f of merged) { at.push(len); len += f.d; }
    const s = [];
    for (const [tt, se] of sounds) {
        let tc = tt - lead;
        if (tc < 0) tc = once ? 0 : tc + len;
        if (tc < len) s.push([tc, se]);
    }
    return { frames: merged, at, sig: merged.map((f) => sigOf(f.pics)), len, s, ...(once ? { once: true } : {}) };
}

// Что видно на экране шага: картинки не прозрачные и не «интерфейс» — имя, место, масштаб, кадр листа
const picSig = (pics) => JSON.stringify(pics.filter((p) => Number(p.op ?? 255) > 0 && !NOT_CG.test(p.name)).map((p) => [p.name, p.x, p.y, p.zx, p.zy, p.cell ? p.cell.i : -1]));
// Проход цикла — анимация, если в нём есть пауза, нет реплик и готовых анимаций, а видимый экран бывает двух видов и больше
const animates = (steps) => steps.some((x) => x.k === 'wait') && !steps.some((x) => x.k === 'say' || x.k === 'choice' || x.k === 'anim')
    && new Set(steps.filter((x) => x.k === 'pics').map((x) => picSig(x.pics))).size >= 2;
// Проход показал новое: картинку, не такую, как экран до него (before — его подпись), или анимацию
const passShows = (steps, before) => steps.some((x) => x.k === 'anim' || (x.k === 'pics' && picSig(x.pics) !== before));

// Файлы под имя с неизвестными частями (WILD), по порядку номеров. Шаблоны повторяются во многих событиях — помним их
// в ctx. Из известных частей должно остаться хоть min букв и цифр, иначе подходит всё
const NATURAL = new Intl.Collator('en', { numeric: true }).compare;
function matching(ctx, kind, pattern, list, min) {
    ctx.cache = ctx.cache || new Map();
    const key = `${kind}\n${pattern}`;
    if (!ctx.cache.has(key)) {
        // Дыры подряд («a» + x + y) — одна: иначе перебор шаблона растёт со степенью их числа
        const parts = pattern.replace(new RegExp(`${WILD}+`, 'g'), WILD).split(WILD);
        const re = parts.join('').replace(/[\s/_\-.]/g, '').length >= min ? new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*?')}$`) : null;
        ctx.cache.set(key, re ? list.filter((n) => re.test(n)).sort(NATURAL) : []);
    }
    return ctx.cache.get(key);
}

// Реплика плагина DialogFromCSVwithPic: «showDialogById» берёт строки из data/<csvFile>. Плагин в подпапке js/plugins
// — «папка/имя». Ответ — аргументы команды или null. Один признак и для чтения файлов (gallery.js), и для реплик
function csvDialog(c) {
    const p = c && c.code === 357 ? c.parameters || [] : [];
    const a = p[3] && typeof p[3] === 'object' ? p[3] : null;
    // id плагин ищет строкой как есть: число в аргументе не найдёт и он
    return a && /(?:^|\/)DialogFromCSV/i.test(String(p[0])) && p[1] === 'showDialogById' && typeof a.dialogId === 'string' && a.dialogId ? a : null;
}

// Таблица реплик из CSV — так же, как читает плагин: блоки по 4 строки, «,» без кавычек, пробелы по краям срезаны;
// в первой строке блока id и имя, текст — третий столбец каждой из четырёх. Кавычки не разбираем, как и он: текст
// в плеере тот же, что в игре. Повтор id — побеждает последний
function dialogCsv(text) {
    const rows = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const out = new Map();
    for (let i = 0; i < rows.length; i += 4) {
        if (!rows[i].trim()) continue;
        const cols = rows[i].split(',').map((s) => s.trim());
        if (!cols[0]) continue;
        const lines = [cols[2] || ''];
        for (let k = 1; k < 4; k++) lines.push(i + k < rows.length ? (rows[i + k].split(',').map((s) => s.trim())[2] || '') : '');
        out.set(cols[0], { name: cols[1] || '', lines });
    }
    return out;
}

// Окно выбора LL_GalgeChoiceWindow «showChoice»: вопрос (messageText) и варианты (choices — JSON со строками-JSON).
// Ответ — { text, choices: [{ label, switchId }] } или null
function galgeChoice(c) {
    const p = c && c.code === 357 ? c.parameters || [] : [];
    const a = p[3] && typeof p[3] === 'object' ? p[3] : null;
    if (!a || !/(?:^|\/)LL_GalgeChoiceWindow$/i.test(String(p[0])) || p[1] !== 'showChoice') return null;
    let list;
    try { list = JSON.parse(a.choices || 'null'); } catch { return null; }
    if (!Array.isArray(list)) return null;
    const choices = [];
    for (const s of list) {
        let x;
        try { x = typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
        if (x && typeof x === 'object') choices.push(x);
    }
    return { text: typeof a.messageText === 'string' ? a.messageText : '', choices };
}

function safeObj(s) {
    try { const v = typeof s === 'string' ? JSON.parse(s) : s; return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

function safeJson(s) {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; }
}

// Готовые картинки кадров: основа — нижняя плотная картинка во весь экран (CG), всё под ней не видно —
// выкидываем; сверху — слои, лица, эффекты; интерфейс (окна, кнопки, «status»), портреты, фоны и картинки, которые
// показывают многие события (общие детали интерфейса), — не часть CG. info(name) → { kind, uses } или null.
// Кадр из листа (cell) — всегда склейкой: целым файлом был бы весь лист. Ответ — готовые картинки по порядку, без
// повторов: { layers } — основа со слоями (склеит ffmpeg), { name } — целая картинка, поверх которой ничего нет
// panel — сцена без CG (бои Magical Girl Runa and Nanami): кадр — стопка деталей на одном месте экрана, см. panelStack
// script — кадр для плеера сцены, не для альбома: одиночная бледная картинка (затемнение, переход, воспоминание: op до
// FAINT_MAX) не должна светиться во всю яркость — её описание берёт и то, что под ней по правилам альбома (faint). Альбом
// получает ту же целую картинку, что и раньше
const FAINT_MAX = 240;
function composeFrames(frames, info, panel = false, script = false) {
    const out = [];
    const seen = new Map();
    for (const frame of frames) {
        // Невидимые (прозрачность 0: игра готовит плавную смену кадров) — не в склейку
        let f = { ...frame, pics: frame.pics.filter((p) => Number(p.op ?? 255) > 0) };
        // Вспышка или затемнение (одноцветная «white», «black», «fade» на весь экран): непрозрачная — экран залит,
        // кадра сцены нет (The Lantern Road: белые обложки сцен); полупрозрачная — оттенок, не деталь
        // Чёрная подложка под CG — не вспышка: кадр пропускаем, только если над залившей экран картинкой ничего нет
        const flat = (p) => info(p.name)?.flat;
        const fills = (p) => flat(p) && Number(p.op ?? 255) >= 255 && !(Number(p.x) || 0) && !(Number(p.y) || 0) && Math.abs(Number(p.zx ?? 100)) >= 100 && Math.abs(Number(p.zy ?? 100)) >= 100;
        const topFill = f.pics.findLastIndex(fills);
        if (topFill >= 0 && f.pics.slice(topFill + 1).every(flat)) continue;
        f = { ...f, pics: f.pics.filter((p) => !flat(p)) };
        if (panel) {
            const stack = panelStack(f.pics, info);
            if (!stack) continue;
            const layers = stack.map(({ name, x, y, o, zx, zy, op, cell }) => ({ name, x, y, o, zx, zy, op, ...(cell ? { cell } : {}) }));
            const key = JSON.stringify(layers);
            const had = seen.get(key);
            const borrowedPanel = stack.every((p) => p.par);
            if (had) { if (!f.alt) delete had.alt; if (!borrowedPanel) delete had.par; continue; }
            const item = { layers, panel: true, ...(f.alt ? { alt: true } : {}), ...(borrowedPanel ? { par: true } : {}) };
            seen.set(key, item);
            out.push(item);
            continue;
        }
        // Основа — нижняя плотная картинка во весь экран: слои-различия бывают плотными (тело, одежда) и тоже «CG»,
        // а если брать верхнюю — потеряли бы всё под ней. Лучше та, что закрывает весь экран (фон под H-CG без
        // фона); такой нет — нижняя CG с прозрачными местами; нет и её — нижний кадр листа анимации
        const cg = (p) => { const k = info(p.name); return k && k.kind === 'cg' && !NOT_CG.test(p.name) ? k : null; };
        // Сплошная CG, которая лежит ровно на экране (без сдвига, масштаба и прозрачности), закрывает всё под собой: основа —
        // верхняя такая (под ней ничего не видно — склеивать нечего; анимация из сменяющих друг друга кадров — сами файлы)
        const covers = (p) => cg(p) && !cg(p).partial && !p.cell && !p.o && (Number(p.x) || 0) <= 0 && (Number(p.y) || 0) <= 0
            && Math.abs(Number(p.zx ?? 100)) >= 100 && Math.abs(Number(p.zy ?? 100)) >= 100 && Number(p.op ?? 255) >= 255;
        let base = -1;
        for (let i = f.pics.length - 1; i >= 0 && base < 0; i--) if (covers(f.pics[i])) base = i;
        if (base < 0) base = f.pics.findIndex((p) => cg(p) && !cg(p).partial);
        if (base < 0) base = f.pics.findIndex(cg);
        if (base < 0) base = f.pics.findIndex((p) => (p.cell || p.seq) && info(p.name) && !NOT_CG.test(p.name));
        if (base < 0) continue;
        const stack = f.pics.slice(base).filter((p, i) => {
            if (i === 0) return true;
            const k = info(p.name);
            if (!k || notCgPart(p.name, k.kind)) return false;
            if (p.cell || p.seq) return true;
            if (!['cg', 'layer', 'other', 'animation'].includes(k.kind)) return false;
            return !(k.kind === 'other' && k.uses > CG_REUSE * 2);
        });
        // alt — картинка только из других веток (вариант): в альбом сцены она идёт после того, как картинки главных веток
        // всех событий уже разобраны
        // par — на кадре видно только параллельную страницу: у неё свой альбом
        const borrowed = stack.every((p) => p.par);
        const add = (key, item) => {
            const had = seen.get(key);
            if (had) { if (!f.alt) delete had.alt; if (!borrowed) delete had.par; return; }
            if (f.alt) item.alt = true;
            if (borrowed) item.par = true;
            seen.set(key, item);
            out.push(item);
        };
        if (stack.length < 2 && !stack[0].cell) {
            const p = stack[0];
            const op = Number(p.op ?? 255);
            let faint = null;
            if (script && op > 0 && op <= FAINT_MAX) {
                // Что под ней — как сложил бы альбом (стопка CG или одна картинка): портреты, интерфейс и фоны не рисуем
                const below = frame.pics.slice(0, frame.pics.indexOf(p)).filter((q) => Number(q.op ?? 255) > 0 && Number(q.zx ?? 100) !== 0 && Number(q.zy ?? 100) !== 0);
                const under = below.length ? composeFrames([{ pics: below, wait: 0 }], info)[0] : null;
                const beneath = under ? (under.layers || [below.findLast((q) => q.name === under.name)]) : [];
                if (beneath.every(Boolean) && !beneath.some((q) => q.cell) && !p.cell) faint = [...beneath, p].map(({ name, x, y, o, zx, zy, op: o2 }) => ({ name, x, y, o, zx, zy, op: o2 }));
            }
            add(`=${p.name}`, { name: p.name, ...(faint ? { faint } : {}) });
            continue;
        }
        const layers = stack.map(({ name, x, y, o, zx, zy, op, cell }) => ({ name, x, y, o, zx, zy, op, ...(cell ? { cell } : {}) }));
        add(JSON.stringify(layers), { layers });
    }
    return out;
}

// Сцена-панель: CG нет, а событие кладёт друг на друга детали в одном месте экрана — тело, лицо, «сперму», поверх
// интерфейс боя (так рисуют бои Magical Girl Runa and Nanami — справа, x=648). Основа — нижняя деталь (персонаж или
// слой); сверху — детали на том же месте (±PANEL_NEAR). Сколько сцен их показывает, не важно: боевую сцену зовут
// десятки событий (у «тела гоблина» — 73), как и портрет разговора. Имена здесь тоже не
// судят: «face», «normal» в панели — её часть. Сцена ли это или портрет с лицом поверх — решает распознавание (сборка
// делает из неё альбом, только когда оно уверенно видит сцену, см. visionProbe в gallery.js)
const PANEL_NEAR = 64;
function panelStack(pics, info) {
    const kind = (p) => info(p.name)?.kind;
    const at = pics.findIndex((p) => ['portrait', 'layer'].includes(kind(p)) && !p.cell);
    if (at < 0) return null;
    const b = pics[at];
    const near = (p) => Math.abs((Number(p.x) || 0) - (Number(b.x) || 0)) <= PANEL_NEAR && Math.abs((Number(p.y) || 0) - (Number(b.y) || 0)) <= PANEL_NEAR && !!p.o === !!b.o;
    const stack = [b, ...pics.slice(at + 1).filter((p) => near(p) && ['portrait', 'layer', 'cg', 'other'].includes(kind(p)))];
    return stack.length >= 2 ? stack : null;
}

// Анимация в событии — кадры подряд без реплик, каждый стоит не дольше ANIM_WAIT: три разных и больше, или два,
// если событие крутит их в цикле (поршень «туда-обратно»). Реплика или долгая пауза — конец клипа. Кадры анимации
// плагина — клип сами по себе (плагин крутит их и под репликами, и медленнее)
const frameSig = (f) => f.pics.map((p) => `${p.name}@${p.x},${p.y},${p.zx},${p.zy},${p.op}${p.cell ? `#${p.cell.i}` : ''}`).join('|');
function clipsOf(frames) {
    const out = [];
    let cur = [];
    const flush = () => {
        const distinct = new Set(cur.map(frameSig)).size;
        if (distinct >= 3 || (distinct >= 2 && cur.every((f) => f.loop || f.anim))) out.push(cur);
        cur = [];
    };
    for (const f of frames) {
        const anim = !!f.anim;
        if (cur.length && !!cur[0].anim !== anim) flush();
        if (anim || (!f.msg && f.wait > 0 && f.wait <= ANIM_WAIT)) cur.push(f);
        else flush();
    }
    flush();
    return out;
}

// Первая строка реплики без кодов («\C[2]», «\N[1]»)
// «\n<Имя>» / «\n» — окно имени говорящего (плагины сообщений): имя тоже убираем, оно не название сцены
// Односимвольные коды окна («\.» пауза, «\!» ждать клавишу, «\{» крупнее, «\G») и чужие плагинные вроде «\-»: буква или знак
// пунктуации ASCII после обратной косой — не текст. Скобки и сама косая не входят: «\\[» не код, «\\\\» — буква косой
const CODE1 = '\\\\[A-Za-z\\x21-\\x2f\\x3a-\\x40\\x5e-\\x60\\x7b-\\x7e]';
const cleanLine = (s) => String(s || '').replace(/\\n<[^>]*>/gi, '').replace(new RegExp('\\\\[A-Za-z]+\\[[^\\]]*\\]|' + CODE1 + '|[<>【】「」『』]', 'g'), '').trim();
function firstText(list) {
    for (const c of list || []) {
        if (c && c.code === 401) { const t = cleanLine(c.parameters && c.parameters[0]); if (/[\p{L}\p{N}]{2,}/u.test(t)) return t.slice(0, 60); }
    }
    return '';
}

// Реплика для плеера галереи: { who, text } из строк окна сообщения (как в игре, с кодами). Говорящего даёт окно имени
// (MZ, name), иначе первая строка: «\n<Имя>», «【Имя】» или одно «Имя:» над текстом. Коды (цвет, значки, скорость) убираем,
// слова оставляем; «\V[n]» — значение переменной, которое событие успело поставить (vars), «\N[n]» — имя героя (actors); «\P[n]» — участник отряда, номер зависит от состава, код просто убираем
function speech(lines, name = '', vars = {}, actors = []) {
    // Как convertEscapeCharacters игры: значение переменной само может нести коды («\x1bN[14]» — ESC вместо косой, его ставит
    // скрипт события), поэтому ESC приводим к косой и подставляем \V[n] повторно, пока они появляются (предел — от самоссылки)
    const slash = (t) => String(t ?? '').replace(/\x1b/g, '\\');
    const fill = (t) => {
        let s = slash(t);
        for (let i = 0; i < 5 && /\\v\[\d+\]/i.test(s); i++) s = s.replace(/\\v\[(\d+)\]/gi, (m, n) => slash(vars[n] ?? '?'));
        return s.replace(/\\n\[(\d+)\]/gi, (m, n) => actors[n] ?? '');
    };
    const plain = (t) => t.replace(new RegExp('\\\\[A-Za-z]+\\[[^\\]]*\\]|' + CODE1, 'g'), '').trim();
    const rows = lines.flatMap((l) => fill(l).split(/\r?\n/));
    let who = plain(fill(name));
    if (!who && rows.length) {
        let m;
        if ((m = /^\s*(?:\\[A-Za-z]+\[\d+\]\s*)*\\n<([^>]*)>/i.exec(rows[0]))) { who = plain(m[1]); rows[0] = rows[0].slice(m[0].length); }
        else if ((m = /^【([^】]{1,30})】\s*([\s\S]*)$/.exec(plain(rows[0])))) { who = m[1].trim(); rows[0] = m[2]; }
        else if (rows.length > 1 && (m = /^([^\s:：「『"“（(]{1,24})[:：]$/.exec(plain(rows[0])))) { who = m[1]; rows.shift(); }
    }
    // Строка окна кончилась посреди латинской фразы — продолжение той же фразы (окно игры узкое, плеер широкий)
    const text = rows.map(plain).reduce((out, row, i) => out + (i ? (/[A-Za-z0-9,;:'-]$/.test(out) && /^[A-Za-z0-9'"(]/.test(row) ? ' ' : '\n') : '') + row, '').replace(/^\n+|\n+$/g, '');
    return { who, text };
}

// Название сцены: имя события, если оно человеческое (не «EV012», не номер, не «测试»/«test»), иначе первая
// реплика, иначе карта
// Тестовые и отладочные карты разработчика («测试», «Debug Room»): копии сцен — в последнюю очередь
const TEST_MAP = /test|テスト|测试|測試|debug|デバッグ|调试/i;
const NO_NAME = /^(?:(?:EV|测试|測試|テスト|test|aa+)[\s\-_.]*\d*|\d+|\s*)$/i;
function sceneTitle(s, i) {
    const own = cleanLine(s.name);
    const where = cleanLine(s.where);
    return ((!NO_NAME.test(own) ? own : '') || firstText(s.raw || s.list) || (!NO_NAME.test(where) && !TEST_MAP.test(where) ? where : '') || `#${i + 1}`).slice(0, 80);
}

// Служебное «название»: вопрос игроку («Продолжить?», «Пропустить?») или название карты с этажом («Old Fortress - B1», «洞窟 3F»).
// Для гостевых сцен, которым имя берётся из первой реплики: у сцены без своего имени эта строка не название
const SERVICE_TITLE = /[?？]\s*$|[\s\-–—]+(?:[BF]\d+|\d+F|B\d+F|地下\d+階?)\s*$/i;
function guestTitle(title, script) {
    if (!SERVICE_TITLE.test(title || '')) return title;
    for (const x of script || []) {
        if (x.k !== 'say') continue;
        const t = cleanLine(speech(x.l || [], x.n || '', x.v || {}).text.split('\n')[0]);
        if (/[\p{L}\p{N}]{2,}/u.test(t) && !SERVICE_TITLE.test(t)) return t.slice(0, 60);
    }
    return title;
}

// Кадры анимации для сценария: пустое (null) — кадр, из которого картинки не сложились; его время получает предыдущий кадр
// той же части (разгон — [0, r), круг — [r, …)), а если такого нет — следующий. Одинаковые подряд кадры сливаются. Весь
// разгон исчез — звуки круга сдвигаются на его длину. Меньше двух разных кадров — null (анимации нет, останется картинка).
// same(a, b) — одинаковы ли кадры; s — [[время, звук]]; ring — остались ли в круге хотя бы два кадра
function squash(items, d, r = 0, x = null, s = [], same = (a, b) => a === b) {
    const out = [];
    const carry = [0, 0];
    items.forEach((it, k) => {
        const part = k < r ? 0 : 1;
        const last = out[out.length - 1];
        if (it == null) {
            if (last && last.part === part) last.d += d[k]; else carry[part] += d[k];
            return;
        }
        const len = d[k] + carry[part];
        carry[part] = 0;
        if (last && last.part === part && same(last.item, it)) last.d += len; else out.push({ item: it, d: len, x: (x && x[k]) || 0, part });
    });
    if (out.length < 2 || out.every((o) => same(o.item, out[0].item))) return null;
    const intro = out.filter((o) => o.part === 0).length;
    const lost = r > 0 && !intro ? d.slice(0, r).reduce((a, b) => a + b, 0) : 0;
    return {
        items: out.map((o) => o.item), d: out.map((o) => o.d), r: intro, x: out.map((o) => o.x),
        s: (s || []).map(([t, se]) => [lost ? Math.max(0, t - lost) : t, se]), ring: out.length - intro >= 2,
    };
}

// Затемнения в готовых шагах сценария (после индексов файлов). Оставляем пары «затемнение — появление», под которыми что-то
// сменилось (реплика или картинка), но не слишком много: длинная сцена под чёрным — это мы потеряли возврат, а не затемнение.
// Лишнее убираем вместе с паузой, что идёт сразу за ним. Незакрытое в конце не оставляем: сцена кончается картинкой, а не
// чёрным. Шаги не меняются — ответ новый массив (или тот же, если убирать нечего)
const FADE_LINES = 5;        // реплик и выборов под чёрным: больше — пару убираем
const FADE_PICS = 2;         // смен картинки под чёрным: больше — тоже
function fades(steps) {
    const drop = new Set();
    const kill = (at) => {
        drop.add(at);
        const w = steps[at + 1];
        if (w && w.k === 'wait' && w.n === steps[at].n) drop.add(at + 1);
    };
    let open = -1;
    let lines = 0;
    let pics = 0;
    let vis = null;
    let vv = '[]';
    steps.forEach((x, i) => {
        // Ролики другие под чёрным — тоже смена картинки
        if (x.k === 'vid') {
            const key = JSON.stringify(x.v.map((v) => [v.s, v.i ?? v.f]));
            if (key !== vv) { vv = key; if (open >= 0) pics++; }
            return;
        }
        // Врезка Spine или Live2D, что появилась или ушла под чёрным, — тоже смена картинки
        if (isRig(x)) { if (open >= 0) pics++; return; }
        if (x.k === 'pic' || x.k === 'anim') {
            // Картинка и сразу её же анимация — одна смена
            const nx = steps[i + 1];
            if (x.k === 'pic' && nx && nx.k === 'anim' && nx.f[0] === x.i) return;
            const key = x.k === 'pic' ? `p${x.i}` : `a${JSON.stringify([x.f, x.d])}`;
            if (key !== vis) { vis = key; if (open >= 0) pics++; }
            return;
        }
        if (x.k === 'say' || x.k === 'choice') { if (open >= 0) lines++; return; }
        if (x.k !== 'fx' || x.t !== 'fade') return;
        if (x.o) {
            if (open >= 0) kill(i); else { open = i; lines = 0; pics = 0; }
            return;
        }
        if (open < 0) { kill(i); return; }
        if (!(lines + pics) || lines > FADE_LINES || pics > FADE_PICS) { kill(open); kill(i); }
        open = -1;
    });
    if (open >= 0) kill(open);
    return drop.size ? steps.filter((_, i) => !drop.has(i)) : steps;
}

// Ролик, что появился и сменился или ушёл, пока не было ни реплики, ни звука, ни ожидания, игрок не увидел бы и в игре: плеер
// зря убрал бы CG на миг. Его шаг выкидываем, следующий шаг vid несёт полное состояние. Зовём после fades(): затемнение,
// которое оно выкинуло, паузу между роликами уже не держит
function blinks(steps) {
    return steps.filter((x, i) => {
        if (x.k !== 'vid' || !x.v.length) return true;
        for (let j = i + 1; j < steps.length; j++) {
            const k = steps[j].k;
            if (k === 'say' || k === 'snd' || k === 'wait' || k === 'vwait' || k === 'choice') return true;
            if (k === 'vid') return false;
        }
        return true;
    });
}

// Сценарий сцены: шаги runList, где состояние экрана («pics») заменено готовой картинкой так же, как её сложил альбом
// (composeFrames), а анимация («anim») — готовыми кадрами. Без реплик и звука смотреть нечего — сценария нет.
// Ролики (шаг vid): виден тот, над которым склейка ничего не кладёт — склейка картинок под ним та же, что всех (иначе в
// игре его закрывает CG или слои персонажа; интерфейс и портреты вне склейки его не закрывают). PKD «под картинками» —
// только когда склейки нет. Ролик есть, а картинки под ним нет — прошлую CG плеер убирает ({ k: 'pic', item: null });
// ролики ушли, а картинки так и нет — снова прошлая CG («картинка не меняется», как без роликов). Целая картинка под
// видимым роликом получает at — своё место на экране игры: ролик стоит в тех же координатах, и картинка должна лечь так же
function scriptOf(steps, info, panel) {
    if (!steps.some((x) => x.k === 'say' || x.k === 'snd')) return {};
    // Врезка Spine кладётся по месту картинки на экране игры: целой картинке в сценарии с шагом spine дописываем это место
    // (gallery.js превращает его в прямоугольник box). Сценариям без Spine оно не нужно — они остаются прежними байт в байт
    const spiny = steps.some(isRig);
    const out = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // script — бледные картинки (faint) только у шагов «pics»; кадры анимации (клетки листа, циклы страниц) остаются как были
    const compose = (list, script = false) => { const it = composeFrames([{ pics: list, wait: 0 }], info, panel, script)[0] || null; if (it) delete it.par; return it; };
    let faintOn = false;         // показанная картинка собрана с бледными слоями (шаг «pics»): сравниваем её так же
    let pics = [];
    let vids = [];
    let item = null;
    let shown;                   // что держит плеер: undefined — ещё ничего, null — убрали, иначе картинка
    let held = null;
    let atOn = false;            // показанная целая картинка уже с at
    let lastV = '[]';
    const visible = () => {
        if (!vids.length) return [];
        const all = JSON.stringify(item);
        return vids.filter((v) => (v.s[0] === 'p' ? JSON.stringify(compose(pics.filter((q) => q.n < Number(v.s.slice(1))), faintOn)) === all : v.low ? !item : true));
    };
    const placeOf = (it) => {
        const q = pics.find((c) => c.name === it.name);
        return { x: Number(q?.x) || 0, y: Number(q?.y) || 0, o: q?.o ? 1 : 0, zx: Number(q?.zx ?? 100), zy: Number(q?.zy ?? 100), op: Number(q?.op ?? 255) };
    };
    // Порядок: убрать картинку — до ролика, место картинки — вместе с ним, прежняя картинка — после ухода роликов
    const flush = () => {
        const vis = visible();
        if (vis.length && !item && shown) { out.push({ k: 'pic', item: null }); shown = null; }
        if (vis.length && item && item.name && !atOn) {
            // Картинку только что показали шагом выше — место дописываем ему, иначе вторым шагом
            const last = out[out.length - 1];
            if (last && last.k === 'pic' && last.item === item) last.at = placeOf(item); else out.push({ k: 'pic', item, at: placeOf(item) });
            atOn = true;
        }
        // «Свой» (own) — пометка для сцен-гостей: одинаковые ролики, что разошлись только ею, — не новый шаг
        const key = JSON.stringify(vis.map(({ own, ...v }) => v));
        if (key !== lastV) { lastV = key; out.push({ k: 'vid', v: vis }); }
        if (!vis.length && shown === null && held) { out.push({ k: 'pic', item: held }); shown = held; }
    };
    for (const x of steps) {
        if (x.k === 'anim') {
            // Чужой вид анимации (кадры без ячеек) пропускаем, а не падаем
            if (!Array.isArray(x.cells) || !Array.isArray(x.d) || x.cells.length !== x.d.length) continue;
            const items = x.cells.map((cell) => compose(cell));
            const q = squash(items, x.d, x.r || 0, x.x, x.s, same);
            // Экран для роликов — по последнему кадру анимации
            pics = x.cells[x.cells.length - 1];
            item = items.findLast(Boolean) || null;
            faintOn = false;
            atOn = false;
            if (!q) { if (item) { out.push({ k: 'pic', item }); held = item; } } else out.push({ k: 'anim', items: q.items, d: q.d, loop: !!x.loop && q.ring, ...(q.r ? { r: q.r } : {}), ...(x.x ? { x: q.x } : {}), ...(q.s.length ? { s: q.s } : {}), ...(x.par ? { par: true } : {}) });
            if (item) shown = item;
            flush();
            continue;
        }
        if (x.k === 'vid') { vids = x.v; flush(); continue; }
        if (x.k !== 'pics') { out.push(x); continue; }
        pics = x.pics;
        item = compose(pics, true);
        faintOn = true;
        if (item && item.name && spiny) {
            const q = x.pics.filter((c) => Number(c.op ?? 255) > 0 && c.name === item.name).pop();
            if (q) item.geo = [Number(q.x) || 0, Number(q.y) || 0, q.o || 0, Number(q.zx ?? 100), Number(q.zy ?? 100)];
        }
        if (item) {
            const at = item.name && visible().length ? placeOf(item) : null;
            out.push({ k: 'pic', item, ...(at ? { at } : {}), ...(x.decor ? { decor: true } : {}) });
            shown = item;
            held = item;
            atOn = !!at;
        }
        flush();
    }
    return out.some((x) => (x.k === 'pic' && x.item) || x.k === 'anim' || (x.k === 'vid' && x.v.length)) ? { script: out } : {};
}

// Картинки шага сценария, которые показывает сама сцена: по ним решают, чей альбом по имени она занимает. Анимацию со
// страницами (par) не считаем: сцена, у которой на экране одни картинки страницы, иначе забрала бы её альбом по имени
const shownItems = (x) => (x.k === 'pic' ? (x.item ? [x.item] : []) : x.k === 'anim' && !x.par && Array.isArray(x.items) ? x.items : []);

// Сцена из одних роликов: сколько реплик идёт под своими роликами сцены (свой — включило само событие; сцены — не «стоит
// персонаж»: scene(f) ложно) и какие это ролики. Нужно VSCENE_LINES реплик. core — эти реплики (строки окна): по ним узнают
// ту же сцену в другом событии (копия в комнате воспоминаний)
function videoScene(script, scene) {
    let on = [];
    const core = [];
    const own = [];
    for (const x of script || []) {
        if (x.k === 'vid') on = x.v.filter((v) => v.own && scene(v.f));
        else if (x.k === 'say' && on.length) { core.push(JSON.stringify(x.l)); for (const v of on) if (!own.includes(v.f)) own.push(v.f); }
    }
    return core.length >= VSCENE_LINES ? { lines: core.length, own, core } : null;
}

// Сцена с анимацией: в сценарии играет анимация из кадров (со страницами — нет: это петли страниц) и идут реплики с текстом.
// core — все реплики сцены (строки окна, как у сценариев в альбомах): по ним узнают ту же сцену на другой странице или карте.
// Кадры, где играет сцена, собирает gallery.js (он знает файлы); боевая анимация без реплик сценой не становится
function animScene(script) {
    if (!(script || []).some((x) => x.k === 'anim' && !x.par && Array.isArray(x.items) && x.items.length >= 2)) return null;
    return readable(script) >= ASCENE_LINES ? { lines: readable(script), core: sayLines(script) } : null;
}
// Реплики сценария — строки окна (все, как в сценариях альбомов: так одну сцену сверяют с чужим сценарием)
function sayLines(script) {
    return (script || []).filter((x) => x.k === 'say').map((x) => JSON.stringify(x.l));
}
// Сколько реплик можно прочесть: пустые окна и одни коды «\M[…]» плеер пропускает
function readable(script) {
    return (script || []).filter((x) => x.k === 'say' && speech(x.l || [], x.n || '', x.v || {}).text).length;
}

// Сценарий без Spine: шаги spine и место картинки geo (оно нужно только врезке)
function noSpine(steps) {
    return steps.filter((x) => !isRig(x)).map((x) => (x.k === 'pic' && x.item && x.item.geo ? { ...x, item: (({ geo, ...rest }) => rest)(x.item) } : x));
}

// Spine в сценах (см. analyze): ответ { scripts: Map(группа → сценарий без интерфейсных наборов), scenes: [...] }. Ничего
// не меняет на месте: исключение — и сценарии групп остаются прежними (analyze сам убирает из них шаги spine)
function spineBlock(runs, groups, ces, ctx, spine, isCg) {
    const grouped = new Set(groups.map((g) => g.id));
    // События только со Spine (spine.sources: без картинок, в runs их нет): разбираем отдельно, в счёт картинок не идут
    const extra = [];
    for (const s of spine.sources || []) { try { extra.push({ s, r: runList(s.list, ces, ctx) }); } catch { /* событие не разобрали */ } }
    const all = [...runs, ...extra];
    const setsOf = (sc) => new Set(sc.filter((x) => isRig(x) && x.s).map((x) => x.s));
    // Набор, который события показывают «чужим» общим событием почти всегда (полоска «желание разблокировано», боевая кукла
    // героини), — интерфейс: из сценариев его убираем. Считаем по сосредоточенным событиям (до SPINE_SETS наборов): комната
    // воспоминаний и «случайная ловушка» перебирают все сцены — не в счёт
    const models = new Set((ctx.l2d || []).map((m) => m.model));
    const used = new Map(), own = new Map();
    for (const { r } of all) {
        const sets = setsOf(r.scenario);
        if (!sets.size || sets.size > SPINE_SETS) continue;
        for (const set of sets) {
            used.set(set, (used.get(set) || 0) + 1);
            if (r.ownSpine && r.ownSpine.has(set)) own.set(set, (own.get(set) || 0) + 1);
        }
    }
    const shared = new Set([...used].filter(([set, n]) => (models.has(set) ? n >= L2D_REUSE : n >= SPINE_REUSE && (own.get(set) || 0) * 10 < n)).map(([set]) => set));
    // Шаги общих наборов вон, и off слоёв, которых так никто и не показал
    const keep = (steps) => {
        const out = steps.filter((x) => !(isRig(x) && x.s && shared.has(x.s)));
        const shown = new Set(out.filter((x) => isRig(x) && !x.off).map((x) => x.id));
        return out.filter((x) => !(isRig(x) && x.off && !shown.has(x.id)));
    };
    const scripts = new Map();
    for (const g of groups) if (g.script && g.script.some((x) => isRig(x))) scripts.set(g, keep(g.script));
    // Сцена альбома Spine — событие без группы: без CG, без вызова сцены, которой есть группа. Лучшее на набор: меньше наборов,
    // потом то, что набор создаёт само, потом больше реплик под ним, потом по порядку
    const best = new Map();
    const many = [];      // сцены альбомов Live2D: по нескольку на модель (у Spine — одна лучшая на набор), копии отсеивает галерея
    const looped = (x) => (x.k === 'snd' && ['bgm', 'bgs', 'vloop'].includes(x.kind)) || x.k === 'stop' || (x.k === 'fx' && (x.t === 'tint' || x.t === 'fade'));
    all.forEach(({ s, r }, i) => {
        if (grouped.has(s.id)) return;
        if ((s.list || []).some((c) => c && c.code === 117 && grouped.has(`ce${c.parameters?.[0]}`))) return;
        if (r.frames.some((f) => !f.alt && f.pics.some((p) => isCg(p.name)))) return;
        const all0 = keep(r.scenario.filter((x) => x.k !== 'pics'));
        const from = all0.findIndex((x) => isRig(x) && x.s);
        if (from < 0) return;
        // Конец — когда последний слой убран и больше не появится: дальше (награда, переход) — не сцена, кроме «остановить»
        let to = all0.length;
        const alive = new Set();
        let lastOn = -1;
        all0.forEach((x, j) => { if (isRig(x)) { if (x.off) alive.delete(x.id); else { alive.add(x.id); lastOn = j; } } });
        if (!alive.size) { for (let j = all0.length - 1; j > lastOn; j--) if (isRig(all0[j]) && all0[j].off) { to = j + 1; break; } }
        // До первого скелета остаются только то, что играет по кругу (музыка, фон, голос), остановки, тон и затемнения
        const steps = all0.filter((x, j) => (j >= from && j < to) || ((j < from || j >= to) && looped(x) && (j < from || x.k === 'stop')));
        const sets = [...setsOf(steps)];
        if (!sets.length || sets.length > SPINE_SETS) return;
        const home = steps.find((x) => isRig(x) && x.s).s;
        const on = new Map();
        let under = 0;
        for (const x of steps) {
            if (isRig(x)) { if (x.off) on.delete(x.id); else on.set(x.id, x.s); }
            else if (x.k === 'say' && [...on.values()].includes(home)) under++;
        }
        if (under < SPINE_SAYS) return;
        const mine = !!(r.ownSpine && r.ownSpine.has(home));
        const cand = { set: home, id: s.id, title: sceneTitle(s, i), sets: sets.length, mine, under, script: steps };
        // Сцена модели Live2D: отпечаток движений (копии в комнате воспоминаний — те же модели и движения, текст другой)
        if (models.has(home)) {
            const sig = JSON.stringify(steps.filter((x) => x.k === 'l2d' && !x.off).map((x) => [x.s, x.a, x.loop]));
            many.push({ ...cand, at: i, sig, says: steps.filter((x) => x.k === 'say').length, named: !NO_NAME.test(cleanLine(s.name)) });
            return;
        }
        const was = best.get(home);
        if (!was || cand.sets < was.sets || (cand.sets === was.sets && ((cand.mine && !was.mine) || (cand.mine === was.mine && cand.under > was.under)))) best.set(home, cand);
    });
    return { scripts, scenes: [...best.values()], l2d: many };
}

// sources — [{ id, name, where, list, ... }]; picKind(name) — раздел картинки из оглавления галереи ('cg', 'layer',
// 'backdrop', 'portrait', 'other', null — файла нет); names — имена всех картинок (для имён с переменной и кадров
// плагина). Ответ:
//   groups — события, что показывают две картинки и больше и среди них есть CG: { id, title, names, finished }
//            (finished — готовые картинки по порядку, без кадров анимаций; в конце — CG, которые событие только называет);
//   clips  — анимации из событий: { id, title, finished, wait } (wait — средняя пауза кадра), повторы одной и той
//            же анимации (другая страница события, та же сцена в комнате воспоминаний) — один раз;
//   В группе ещё script — сценарий для плеера (scriptOf), если в сцене есть реплики или звук. audioOf(вид, имя) →
//            { rel, voice } или null — звук игры по имени из события.
//   shown  — имена всех картинок, которые показывают или называют события (для остальных о раскадровке судим по
//            именам файлов)
function analyze(sources, ces, picKind, isPartial = () => false, names = null, movieNames = null, isFlat = () => false, audioOf = null, opts = {}) {
    // video — { movieManager, keepEnd, videoRel(имя в movies/) → файл, outerRel(путь) → файл }, см. gallery.js videoFlags
    const ctx = names ? { names, has: ((set) => (n) => set.has(n))(new Set(names)), movies: movieNames, movieSet: new Set(movieNames || []), audio: audioOf, texts: opts.texts || {}, paFirst: !!opts.paFirst, kind: picKind, spines: opts.spine?.sets || [], l2d: opts.spine?.l2d || [], ...(opts.video || {}) } : null;
    const pars = opts.pars || null;
    // Копии сцен на тестовых картах — после настоящих: картинки достаются настоящим событиям
    sources = [...sources.filter((x) => !TEST_MAP.test(x.where || '')), ...sources.filter((x) => TEST_MAP.test(x.where || ''))];
    const runs = [];
    // Источники только с роликами (vonly: PKD_VPlayer, «Показать видео») и разборы, где кроме роликов ничего нет, — отдельно:
    // в runs их нет, и номера, имена, «общие» картинки, группы и клипы — как раньше
    const vruns = [];
    const hasVid = (r) => r.scenario.some((x) => x.k === 'vid' && x.v.length);
    for (const s of sources) {
        let r;
        // Событие, которое не разобрали (скрипт со скобками в тысячу уровней), — без него, остальные сцены целы
        try { r = runList(s.list, ces, ctx, pars ? { pars, map: s.map ?? null, ev: s.ev ?? null, self: s.id, battle: /^t\d/.test(s.id) || !!s.battle } : null); } catch { continue; }
        if (!s.vonly && (r.frames.length || r.mentions.length || r.movies.size || r.blank)) runs.push({ s, r });
        else if (hasVid(r)) vruns.push({ s, r });
    }
    // Ролики, которые события крутят по кругу (MoviePicture «loop»): это анимации сцены, хоть и со звуком и длинные;
    // loops — по событиям, чтобы встали в альбом своей сцены
    const loops = new Map();
    runs.forEach(({ s, r }, i) => {
        const mine = [...r.movies].filter(([, loop]) => loop).map(([n]) => n);
        if (mine.length) loops.set(s.id, { id: s.id, title: sceneTitle(s, i), names: mine });
    });
    // В скольких сценах встречается каждая картинка: по главным веткам (меню выбора сцены перебирает в ветках все
    // сцены — их картинки от этого не «общие»); по всем веткам — только если уж очень часто
    const uses = new Map();
    const usesAll = new Map();
    const namesOf = (r) => new Set([...r.frames.flatMap((f) => f.pics.map((p) => p.name)), ...r.mentions]);
    // Сцены из файлов сценария (galleryAdv: adv) — после событий и только для картинок, которых события не показывают:
    // иначе файл повтора, сводка и плохая концовка с той же CG сделали бы её «общей» и увели из альбома события
    const count = (r, skip) => {
        for (const n of new Set([...r.frames.filter((f) => !f.alt).flatMap((f) => f.pics.map((p) => p.name)), ...r.mentions])) if (!skip.has(n)) uses.set(n, (uses.get(n) || 0) + 1);
        for (const n of namesOf(r)) if (!skip.has(n)) usesAll.set(n, (usesAll.get(n) || 0) + 1);
    };
    const none = new Set();
    for (const { s, r } of runs) if (!s.adv) count(r, none);
    const byEvents = new Set(usesAll.keys());
    for (const { s, r } of runs) if (s.adv) count(r, byEvents);
    const shown = new Set(usesAll.keys());
    const isCg = (name) => {
        if (NOT_CG.test(name) || (uses.get(name) || 0) > CG_REUSE || (usesAll.get(name) || 0) > CG_REUSE * 3) return false;
        const k = picKind(name);
        return k === 'cg' || k === 'layer';
    };
    const info = (n) => { const k = picKind(n); return k ? { kind: k, uses: uses.get(n) || 0, partial: isPartial(n), flat: isFlat(n) } : null; };
    // Клипы анимаций: кадр — картинка сцены (CG или слой; та же анимация в комнате и в сюжете — не «портрет»)
    const found = [];
    runs.forEach(({ s, r }, i) => {
        for (const clip of clipsOf(r.frames)) {
            if (!clip.some((f) => f.pics.some((p) => !NOT_CG.test(p.name) && (p.cell || p.seq || ['cg', 'layer'].includes(picKind(p.name)))))) continue;
            const finished = composeFrames(clip, info);
            if (finished.length < 2) continue;
            for (const f of clip) f.clip = true;
            found.push({ id: s.id, title: sceneTitle(s, i), finished, wait: clip.reduce((a, f) => a + f.wait, 0) / clip.length, order: found.length });
        }
        // Петли параллельных страниц поверх сцены — свой клип (альбом «…#par»). Без картинок самой сцены — это кадры
        // страницы, у неё свой альбом
        for (const clip of r.parClips || []) {
            if (!clip.some((f) => f.pics.some((p) => !NOT_CG.test(p.name) && (p.cell || p.seq || ['cg', 'layer'].includes(picKind(p.name)))))) continue;
            const finished = composeFrames(clip, info);
            if (finished.length < 2 || finished.every((x) => x.par)) continue;
            for (const x of finished) delete x.par;
            found.push({ id: s.id, title: sceneTitle(s, i), finished, wait: clip.reduce((a, f) => a + f.wait, 0) / clip.length, order: found.length, par: true });
        }
    });
    // Повторы: та же анимация из комнаты воспоминаний (поверх ещё рамка «REC» или подпись), с другой страницы
    // события — оставляем самую длинную; «та же» — больше половины кадров из тех же картинок. Общее для многих
    // событий (рамка повтора, интерфейс) не в счёт; разные слои на одной основе — разные анимации
    const sig = (x) => (x.layers ? x.layers.filter((l, i) => i === 0 || (uses.get(l.name) || 0) <= CG_REUSE).map((l) => `${l.name.toLowerCase()}${l.cell ? `#${l.cell.i}` : ''}`).join('+') : x.name.toLowerCase());
    const clips = [];
    // Сначала клипы самих сцен, потом — со страницами: повтор уже известной анимации не вытесняет её альбом
    for (const c of [...found].sort((a, b) => (a.par ? 1 : 0) - (b.par ? 1 : 0) || b.finished.length - a.finished.length)) {
        const mine = new Set(c.finished.map(sig));
        const dup = clips.some((k) => { const theirs = new Set(k.finished.map(sig)); const n = [...theirs].filter((x) => mine.has(x)).length; return n > 0.5 * Math.min(mine.size, theirs.size); });
        if (!dup) clips.push(c);
    }
    clips.sort((a, b) => a.order - b.order);
    // Группы: событие показывает две картинки и больше, и среди них есть CG (не портреты разговора). Кадры анимаций —
    // в клипах, не здесь
    const groups = [];
    // Кадры альбома, под которыми шла параллельная страница: снимки экрана с ней — [номер в finished, [готовые картинки],
    // plain]. finished и всё, что по нему решает сборка, — как без страниц; снимок, где видно только страницу, — нет
    const keyOf = (x) => JSON.stringify(x.layers || x.name);
    const shotsOf = (r, finished) => {
        if (!r.parOf) return null;
        const at = new Map(finished.map((x, k) => [keyOf(x), k]));
        const by = new Map();
        for (const f of r.frames) {
            const p = r.parOf.get(f);
            if (!p || !p.o.length || f.clip || f.alt) continue;
            const [own] = composeFrames([f], info);
            const k = own ? at.get(keyOf(own)) : undefined;
            if (k === undefined) continue;
            const e = by.get(k) || { items: [], plain: false };
            if (p.plain) e.plain = true;
            for (const pics of p.o) {
                const [it] = composeFrames([{ ...f, pics }], info);
                if (!it || it.par || keyOf(it) === keyOf(own) || e.items.some((y) => keyOf(y) === keyOf(it))) continue;
                e.items.push(it);
            }
            by.set(k, e);
        }
        const out = [...by].filter(([, e]) => e.items.length).map(([k, e]) => [k, e.items, e.plain]);
        return out.length ? out : null;
    };
    // Картинка-ролик MV раньше была картинкой «» и считалась вторым именем: счёт — как раньше
    const gate = (r, names) => names.length + (r.blank && !names.includes('') ? 1 : 0);
    runs.forEach(({ s, r }, i) => {
        const names = [...namesOf(r)];
        if (gate(r, names) >= 2 && names.some(isCg)) {
            const finished = composeFrames(r.frames.filter((f) => !f.clip), info);
            const have = new Set(finished.flatMap((x) => (x.layers ? x.layers.map((l) => l.name.toLowerCase()) : [x.name.toLowerCase()])));
            for (const m of r.mentions) if (!have.has(m) && picKind(m) === 'cg' && !NOT_CG.test(m)) finished.push({ name: m });
            if (finished.length) { const shots = shotsOf(r, finished); groups.push({ id: s.id, title: sceneTitle(s, i), names: names.filter((n) => !NOT_CG.test(n)), finished, ...(shots ? { shots } : {}), ...scriptOf(r.scenario, info, false) }); return; }
        }
        // CG нет (или из неё ничего не сложилось: одни слои) — может, сцена-панель: два разных кадра из стопок деталей и больше
        if (gate(r, names) < 3) return;
        const finished = composeFrames(r.frames.filter((f) => !f.clip), info, true);
        if (finished.length >= 2) groups.push({ id: s.id, title: sceneTitle(s, i), names, finished, panel: true, ...scriptOf(r.scenario, info, true) });
    });
    // Spine в сценах. Блок целиком в try: на сбое сценарии групп — прежние (без шагов spine), сцен Spine нет, остальное цело
    let spineScenes = [];
    let l2dScenes = [];
    if (ctx && (ctx.spines.length || ctx.l2d.length)) {
        const spine = opts.spine;
        try {
            const out = spineBlock(runs, groups, ces, ctx, spine, isCg);
            for (const [g, script] of out.scripts) g.script = script;
            spineScenes = out.scenes;
            l2dScenes = out.l2d;
        } catch (e) {
            spine.error = e.message;
            for (const g of groups) {
                if (!g.script) continue;
                g.script = noSpine(g.script);
            }
        }
    }
    // Картинки, которые событие показывает под репликами (страницы сцены, варианты одежды по одному): кадры подряд по
    // номерам из них — не анимация
    const stills = new Set();
    for (const { r } of runs) for (const f of r.frames) if (f.msg && !f.clip && !f.anim) for (const p of f.pics) stills.add(p.name);
    // Сцены из одних роликов: событие без группы, у которого VSCENE_LINES реплик идут под его собственными роликами сцены.
    // «Стоит персонаж» — имя (VIDEO_NOT_SCENE) или тот же ролик на VSCENE_PAGES страницах одного события карты
    const pagesOf = new Map();
    const withVid = [...runs, ...vruns].filter(({ r }) => hasVid(r));
    // at — место источника (копии сцен — по нему), named — название из имени события, а не из первой реплики
    const at = new Map(sources.map((s, i) => [s.id, i]));
    const named = new Map(sources.map((s) => [s.id, !NO_NAME.test(cleanLine(s.name))]));
    // Сцены с анимацией: группа (её альбома может не достаться, тогда сцену отдают альбому анимации — g.ascene) и событие
    // без группы, где кадры одни анимации (картинок для группы нет, но реплики идут под анимацией). Сначала группы, потом
    // события без неё; из роликов (vscenes ниже) эти — только то, что те не взяли
    for (const g of groups) { g.srcAt = at.get(g.id); g.srcNamed = named.get(g.id); if (g.script) { const v = animScene(g.script); if (v) g.ascene = v; } }
    const animScenes = (skip) => {
        const grouped = new Set(groups.map((g) => g.id));
        const out = [];
        runs.forEach(({ s, r }, i) => {
            // Разбирать сценарий — дорого: сначала дешёвый отсев по шагам (есть анимация и хватает реплик)
            if (grouped.has(s.id) || skip.has(s.id) || TEST_MAP.test(s.where || '') || !r.scenario.some((x) => x.k === 'anim') || r.scenario.filter((x) => x.k === 'say').length < ASCENE_LINES) return;
            const sc = scriptOf(r.scenario, info, false);
            const v = sc.script && animScene(sc.script);
            if (v) out.push({ id: s.id, title: sceneTitle(s, i), script: noSpine(sc.script), ...v, at: at.get(s.id), named: named.get(s.id) });
        });
        return out.sort((a, b) => a.at - b.at);
    };
    if (!withVid.length) return { groups, clips: clips.map(({ order, ...c }) => c), shown, stills, uses, loops: [...loops.values()], vscenes: [], ascenes: animScenes(new Set()), spineScenes, l2dScenes };
    for (const { s, r } of withVid) {
        const m = /^(m\d+e\d+)p\d+$/.exec(s.id);
        if (!m) continue;
        const own = new Set();
        for (const x of r.scenario) if (x.k === 'vid') for (const v of x.v) if (v.own) own.add(v.f);
        for (const f of own) { if (!pagesOf.has(f)) pagesOf.set(f, new Map()); const ev = pagesOf.get(f); ev.set(m[1], (ev.get(m[1]) || 0) + 1); }
    }
    const sceneVideo = (f) => !VIDEO_NOT_SCENE.test(String(f).split('/').pop()) && !(pagesOf.has(f) && Math.max(...pagesOf.get(f).values()) >= VSCENE_PAGES);
    // Группа, которой потом не достанется альбома (мёртвая или тонкая), понесёт свою сцену из роликов как гостя (g.vscene)
    for (const g of groups) if (g.script) { const v = videoScene(g.script, sceneVideo); if (v) g.vscene = { ...v, at: at.get(g.id), named: named.get(g.id) }; }
    const grouped = new Set(groups.map((g) => g.id));
    const vscenes = [];
    [...runs.map((x, i) => ({ ...x, i })), ...vruns.map((x, i) => ({ ...x, i: runs.length + i }))].forEach(({ s, r, i }) => {
        if (grouped.has(s.id) || TEST_MAP.test(s.where || '') || !hasVid(r)) return;
        const sc = scriptOf(r.scenario, info, false);
        const v = sc.script && videoScene(sc.script, sceneVideo);
        // Видео-сцена не проходит фильтр общих наборов и не получает box: врезок Spine в ней нет
        if (v) vscenes.push({ id: s.id, title: sceneTitle(s, i), script: noSpine(sc.script), ...v, at: at.get(s.id), named: named.get(s.id) });
    });
    vscenes.sort((a, b) => a.at - b.at);
    return { groups, clips: clips.map(({ order, ...c }) => c), shown, stills, uses, loops: [...loops.values()], vscenes, ascenes: animScenes(new Set(vscenes.map((v) => v.id))), spineScenes, l2dScenes };
}

module.exports = { runList, analyze, cycleFrom, activePage, shownItems, scriptOf, videoScene, animScene, sayLines, readable, VSCENE_LINES, ASCENE_LINES, LATE_LINES, fades, blinks, squash, speech, csvDialog, dialogCsv, galgeChoice, clipsOf, composeFrames, sceneTitle, guestTitle, firstText, cleanLine, evaluate, tokenize, NOT_CG, MAX_FRAMES, TEST_MAP };
