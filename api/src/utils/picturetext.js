// Картинки игры для «Перевести картинки» (services/pictures.js): расшифровка, размер и прозрачность из заголовка
// PNG, и сверка распознанного текста со строками самой игры.
const crypto = require('crypto');

// Зашифрованная картинка RPG Maker (.rpgmvp у MV, .png_ у MZ): 16 байт заголовка «RPGMV», потом первые 16 байт
// PNG, сложенные с ключом игры, дальше — как есть. Первые 16 байт у любого PNG одни и те же (подпись и начало
// блока IHDR) — их просто ставим на место, ключ не нужен
const PNG_HEAD = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex');
const ENCRYPTED = /\.(png_|rpgmvp)$/i;

function decrypt(buf, name) {
    if (!ENCRYPTED.test(name)) return buf;
    if (!Buffer.isBuffer(buf) || buf.length < 48) return null;
    return Buffer.concat([PNG_HEAD, buf.subarray(32)]);
}

// Размер и прозрачность по началу файла (зашифрованного — тоже): ширина, высота, есть ли альфа-канал. Палитра с
// прозрачностью (tRNS) — тоже прозрачная. null — не PNG
function pngInfo(head, name) {
    const buf = decrypt(head, name);
    if (!buf || buf.length < 33 || !buf.subarray(0, 16).equals(PNG_HEAD)) return null;
    const type = buf[25];
    const before = buf.indexOf('IDAT');
    const trns = buf.indexOf('tRNS');
    return {
        w: buf.readUInt32BE(16),
        h: buf.readUInt32BE(20),
        alpha: type === 4 || type === 6 || (trns > 0 && (before < 0 || trns < before)),
    };
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// Распознавание путает маленькую и большую кану («きつぷ» вместо «きっぷ») и пишет иероглиф в китайском
// начертании («攻擊» вместо «攻撃»). Для сверки приводим всё к одному виду: NFKC, кана большая, начертание японское
const SMALL = { 'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'っ': 'つ', 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ゎ': 'わ',
    'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ', 'ッ': 'ツ', 'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ', 'ヮ': 'ワ', 'ヵ': 'カ', 'ヶ': 'ケ' };
const VARIANT = { '擊': '撃', '戰': '戦', '鬥': '闘', '體': '体', '經': '経', '驗': '験', '圖': '図', '劍': '剣', '惡': '悪', '氣': '気',
    '狀': '状', '數': '数', '裝': '装', '賣': '売', '單': '単', '擇': '択', '畫': '画', '聲': '声', '戀': '恋', '亂': '乱', '絕': '絶',
    '對': '対', '應': '応', '號': '号', '從': '従', '來': '来', '關': '関' };
const plain = (s) => [...String(s).normalize('NFKC')].map((c) => SMALL[c] || VARIANT[c] || c).join('').replace(/[\s:：、。・.,!?！？'"「」『』（）()]/g, '');

// Куски строк игры: целиком и по разделителям («攻撃力：28» → «攻撃力»), как их режет и перевод на экране
const SEP = /[\s -⁯←-➿　-〿！-／：-＠［-｀｛-･:;,.!?()[\]{}<>/\\|~^=+*#&%'"`-]+/;
const CJK = /[぀-ヿ㐀-鿿]/;

// Отличаются ли две строки не больше чем одним знаком (вставка, пропуск или замена)
function oneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function lexiconOf(strings) {
    const exact = new Set();
    const byPlain = new Map();
    const byLength = new Map();         // длина простого вида → строки: для поиска «с точностью до знака»
    const add = (s) => {
        const t = s.normalize('NFKC').trim();
        if (t.length < 2 || t.length > 40 || !CJK.test(t)) return;
        exact.add(t);
        const p = plain(t);
        if (p.length >= 2) {
            // Два разных слова одного вида — неоднозначно, такое не подставляем
            byPlain.set(p, byPlain.has(p) && byPlain.get(p) !== t ? null : t);
            if (!byLength.has(p.length)) byLength.set(p.length, new Set());
            byLength.get(p.length).add(p);
        }
    };
    for (const s of strings) {
        if (typeof s !== 'string' || !s) continue;
        if (s.length <= 40) add(s);
        for (const part of s.split(SEP)) if (part !== s) add(part);
    }
    return { exact, byPlain, byLength };
}

// Строка игры, отличающаяся от ответа одним знаком («リバルテイス領» → «バルティス領»): только если такая одна
// и ответ не короче 4 знаков — у коротких слов «на знак» отличаются слишком многие
function nearOf(text, lexicon) {
    const p = plain(text);
    if (p.length < 4 || !lexicon.byLength) return null;
    const hits = new Set();
    for (const len of [p.length - 1, p.length, p.length + 1]) {
        for (const q of lexicon.byLength.get(len) || []) {
            if (oneEdit(p, q)) hits.add(lexicon.byPlain.get(q));
            if (hits.size > 1) return null;
        }
    }
    const [hit] = hits;
    return hit || null;
}

// Доля общих знаков двух ответов (0…1)
function agreement(a, b) {
    const count = (s) => [...plain(s)].reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
    const ca = count(a || '');
    const cb = count(b || '');
    let common = 0;
    for (const [c, n] of ca) common += Math.min(n, cb.get(c) || 0);
    const len = Math.max([...plain(a || '')].length, [...plain(b || '')].length);
    return len ? common / len : 0;
}

// Текст подписи по строкам игры: какой-то из ответов распознавания — строка игры → он, без «проверь»; один из
// них совпадает со строкой игры с точностью до каны и начертания → строка игры. Иначе — как было.
// Подтверждает только ответ, с которым согласен Paddle: manga-ocr на рисунке «дочитывает» частые слова
// («それは»), и такие в репликах игры, конечно, есть
function snap(label, lexicon) {
    const tail = (s) => (s.match(/[:：]$/) ? s.slice(-1) : '');
    const backed = (c) => !label.paddle || c === label.paddle || agreement(c, label.paddle) >= 0.5;
    const candidates = [label.text, label.manga, label.paddle].filter((s) => typeof s === 'string' && s && backed(s));
    for (const c of candidates) {
        const t = c.normalize('NFKC').trim();
        const bare = t.replace(/[:：]$/, '');
        if (lexicon.exact.has(t) || (bare !== t && lexicon.exact.has(bare))) return { ...label, text: c, unsure: false, known: true };
    }
    for (const c of candidates) {
        const hit = lexicon.byPlain.get(plain(c));
        if (hit) return { ...label, text: hit + (hit.match(/[:：]$/) ? '' : tail(c)), unsure: false, known: true };
    }
    // На знак от строки игры — берём её, но «проверь» остаётся как было: совпадение уже не точное
    for (const c of candidates) {
        const hit = nearOf(c, lexicon);
        if (hit) return { ...label, text: hit + (hit.match(/[:：]$/) ? '' : tail(c)), known: true };
    }
    return { ...label, known: false };
}

module.exports = { decrypt, pngInfo, sha1, plain, lexiconOf, snap, agreement, PNG_HEAD };
