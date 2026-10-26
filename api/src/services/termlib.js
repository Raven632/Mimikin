// Словарь терминов из переведённых игр библиотеки. У переведённой игры японского оригинала рядом нет, но
// термины в System.json стоят на своих местах: commands[4] — всегда «アイテム», params[2] — «攻撃力» и т. д.
// (японские значения у RPG Maker стандартные). Поэтому видно, как термин назвали переводчики, — и по
// всем русским (английским, немецким) играм выбираем самый частый вариант. Он заменяет стандартный из
// utils/glossary.js, если за него не меньше MIN_VOTES игр и он заметно впереди второго (в LEAD раз):
// при равенстве «Бой» 4 : «Сражаться» 4 остаётся стандартный. Пересчитывается сам раз в час — добавил
// переведённую игру, и её термины учтены
const fsp = require('fs').promises;
const path = require('path');
const { norm } = require('../utils/glossary.js');

const MIN_VOTES = 3;
const LEAD = 1.5;
const TTL_MS = 60 * 60 * 1000;
// Японские значения терминов по местам (одинаковые в MV и MZ); null — пустое место
const POSITIONS = {
    commands: ['戦う', '逃げる', '攻撃', '防御', 'アイテム', 'スキル', '装備', 'ステータス', '並び替え', 'セーブ', 'ゲーム終了', 'オプション',
        '武器', '防具', '大事なもの', '装備', '最強装備', '全て外す', 'ニューゲーム', 'コンティニュー', null, 'タイトルへ', 'やめる', null, '購入する', '売却する'],
    params: ['最大HP', '最大MP', '攻撃力', '防御力', '魔法力', '魔法防御', '敏捷性', '運', '命中率', '回避率'],
    basic: ['レベル', null, null, null, null, null, null, null, '経験値', null],
};
const MESSAGES = {
    alwaysDash: '常時ダッシュ', commandRemember: 'コマンド記憶', touchUI: 'タッチUI', bgmVolume: 'BGM 音量', bgsVolume: 'BGS 音量',
    meVolume: 'ME 音量', seVolume: 'SE 音量', possession: '持っている数', file: 'ファイル',
    saveMessage: 'どのファイルにセーブしますか？', loadMessage: 'どのファイルをロードしますか？',
};
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;
const CYR = /\p{sc=Cyrillic}/u;
const GERMAN = /[äöüßÄÖÜ]|\b(?:Kämpfen|Fliehen|Angriff|Gegenstände|Fähigkeiten|Ausrüstung|Speichern|Beenden|Optionen|Waffen|Rüstung)\b/;
// Английская игра — с английскими командами: латиница сама по себе может быть французской или испанской
const ENGLISH = /^(?:fight|battle|escape|flee|run(?: away)?|attack|guard|defen[sc]e|defend|items?|skills?|equip(?:ment)?|status|formation|save|options?|weapons?|armou?r)$/i;

// Язык перевода игры по её командам меню: русский — кириллица, немецкий — умлауты и немецкие слова,
// английский — латиница без японского. Японские (непереведённые) игры не считаются
function languageOf(commands) {
    const vals = (Array.isArray(commands) ? commands : []).filter((s) => typeof s === 'string' && s.trim());
    if (vals.length < 8) return null;
    if (vals.filter((s) => CYR.test(s)).length >= 4) return 'ru';
    if (vals.slice(0, 12).filter((s) => CJK.test(s)).length > 2) return null;
    if (vals.some((s) => GERMAN.test(s))) return 'de';
    if (vals.filter((s) => ENGLISH.test(s.replace(/\\[A-Za-z]+\[[^\]]*\]/g, '').trim())).length >= 4) return 'en';
    return null;
}

// Значение термина без кодов (\I[97], \C[2]) и пробелов по краям; заготовки вида «{fight}», японское
// и — в русской игре — без кириллицы (английский остаток) не считаются
function cleanTerm(v, lang) {
    if (typeof v !== 'string') return '';
    const s = v.replace(/\\[A-Za-z]+\[[^\]]*\]|\\[A-Za-z{}]/g, '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!s || !/\p{L}/u.test(s) || /[{}]/.test(s) || CJK.test(s)) return '';
    if (lang === 'ru' && !CYR.test(s)) return '';
    if (lang !== 'ru' && CYR.test(s)) return '';
    return s;
}

// Варианты, которые отличаются только регистром и «ё/е», — один голос; пишется самый частый вариант
const voteKey = (s) => s.toLowerCase().replace(/ё/g, 'е');

// Подсчёт по папкам игр: { ru: { games, votes: Map(японский → Map(ключ → { n, spell: Map(вариант → n) })) }, … }
async function scan(gamesDir) {
    const out = { en: { games: 0, votes: new Map() }, ru: { games: 0, votes: new Map() }, de: { games: 0, votes: new Map() } };
    const add = (lang, ja, value) => {
        const v = cleanTerm(value, lang);
        if (!ja || !v) return;
        const byJa = out[lang].votes.get(ja) || new Map();
        out[lang].votes.set(ja, byJa);
        const k = voteKey(v);
        const slot = byJa.get(k) || { n: 0, spell: new Map() };
        byJa.set(k, slot);
        slot.n++;
        slot.spell.set(v, (slot.spell.get(v) || 0) + 1);
    };
    for (const name of await fsp.readdir(gamesDir).catch(() => [])) {
        if (name.startsWith('_') || name.startsWith('.')) continue;
        let system = null;
        for (const dir of [path.join(gamesDir, name, 'www', 'data'), path.join(gamesDir, name, 'data')]) {
            try {
                system = JSON.parse((await fsp.readFile(path.join(dir, 'System.json'), 'utf8')).replace(/^﻿/, ''));
                break;
            } catch (e) { /* нет или не JSON (зашифрованная сборка) — дальше */ }
        }
        try {
            const terms = system?.terms;
            const lang = languageOf(terms?.commands);
            if (!lang) continue;
            out[lang].games++;
            for (const [key, list] of Object.entries(POSITIONS)) {
                // «装備» стоит дважды (команда меню и экран снаряжения) — голос от игры один
                const seen = new Set();
                list.forEach((ja, i) => {
                    if (!ja || seen.has(ja)) return;
                    seen.add(ja);
                    add(lang, ja, Array.isArray(terms[key]) ? terms[key][i] : undefined);
                });
            }
            for (const [key, ja] of Object.entries(MESSAGES)) add(lang, ja, terms.messages?.[key]);
        } catch (e) {
            // Необычный System.json одной игры не должен ломать словарь для всех
        }
    }
    return out;
}

// Победитель голосования или null: не меньше MIN_VOTES игр и в LEAD раз больше второго
function winner(byJa) {
    const ranked = [...byJa.values()].sort((a, b) => b.n - a.n);
    const [top, second] = ranked;
    if (!top || top.n < MIN_VOTES || (second && top.n < second.n * LEAD)) return null;
    const spelling = [...top.spell.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { text: spelling, votes: top.n, total: ranked.reduce((s, x) => s + x.n, 0) };
}

class TermLibrary {
    constructor() {
        this.gamesDir = '';
        this.cached = null;          // { at, langs: { ru: { games, terms: Map(norm(японский) → { ja, text, votes, total }) } } }
        this.pending = null;
    }

    setDir(gamesDir) {
        this.gamesDir = gamesDir;
        this.cached = null;
    }

    // Словарь, пересчитанный не позже часа назад. Один пересчёт на все одновременные запросы
    async load(now = Date.now()) {
        if (this.cached && now - this.cached.at < TTL_MS) return this.cached;
        if (!this.pending) {
            this.pending = scan(this.gamesDir).then((raw) => {
                const langs = {};
                for (const [lang, { games, votes }] of Object.entries(raw)) {
                    const terms = new Map();
                    for (const [ja, byJa] of votes) {
                        const w = winner(byJa);
                        if (w) terms.set(norm(ja), { ja, ...w });
                    }
                    langs[lang] = { games, terms };
                }
                this.cached = { at: now, langs };
                return this.cached;
            }).finally(() => { this.pending = null; });
        }
        return this.pending;
    }

    // Переводы терминов для языка: Map(norm(японский) → перевод) — для glossary.termOf
    // Пересчёт не удался — без словаря библиотеки (встроенный остаётся)
    async overrides(lang) {
        const lib = await this.load().catch(() => null);
        if (!lib) return new Map();
        // И без пробелов: «BGM 音量» и «BGM音量» — один термин
        return new Map([...(lib.langs[lang]?.terms || new Map())].flatMap(([k, v]) => [[k, v.text], [k.replace(/ /g, ''), v.text]]));
    }
}

module.exports = new TermLibrary();
module.exports.TermLibrary = TermLibrary;
module.exports.scan = scan;
module.exports.winner = winner;
module.exports.languageOf = languageOf;
module.exports.MIN_VOTES = MIN_VOTES;
