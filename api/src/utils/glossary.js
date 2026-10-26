// Стандартные слова RPG Maker MV/MZ: команды меню, характеристики, настройки, типы снаряжения и стихии —
// во всех играх японские одинаковые, и переводиться должны одинаково, а не как решит служба в этот раз
// («攻撃力» то «Сила атаки», то «Атака»). Английские — как в английском RPG Maker, русские и немецкие — по
// тому же принципу: коротко, как в меню. Такие строки в службу не уходят (лимит не тратится); свой перевод,
// загруженный файлом, главнее
const TERMS = {
    // Основное
    'レベル': ['Level', 'Уровень', 'Level'],
    '経験値': ['EXP', 'Опыт', 'EP'],
    // Команды
    '戦う': ['Fight', 'Сражаться', 'Kämpfen'],
    '逃げる': ['Escape', 'Бежать', 'Fliehen'],
    '攻撃': ['Attack', 'Атака', 'Angriff'],
    '防御': ['Guard', 'Защита', 'Abwehr'],
    'アイテム': ['Item', 'Предметы', 'Gegenstände'],
    'スキル': ['Skill', 'Навыки', 'Fähigkeiten'],
    '装備': ['Equip', 'Снаряжение', 'Ausrüstung'],
    'ステータス': ['Status', 'Статус', 'Status'],
    '並び替え': ['Formation', 'Порядок', 'Formation'],
    'セーブ': ['Save', 'Сохранить', 'Speichern'],
    'ロード': ['Load', 'Загрузить', 'Laden'],
    'ゲーム終了': ['Game End', 'Выйти из игры', 'Spiel beenden'],
    'オプション': ['Options', 'Настройки', 'Optionen'],
    '武器': ['Weapon', 'Оружие', 'Waffe'],
    '防具': ['Armor', 'Броня', 'Rüstung'],
    '大事なもの': ['Key Item', 'Важные вещи', 'Schlüsselgegenstand'],
    '最強装備': ['Optimize', 'Лучшее снаряжение', 'Optimieren'],
    '全て外す': ['Clear', 'Снять всё', 'Alles ablegen'],
    'ニューゲーム': ['New Game', 'Новая игра', 'Neues Spiel'],
    'コンティニュー': ['Continue', 'Продолжить', 'Fortsetzen'],
    'タイトルへ': ['To Title', 'В главное меню', 'Zum Titel'],
    'やめる': ['Cancel', 'Отмена', 'Abbrechen'],
    '購入する': ['Buy', 'Купить', 'Kaufen'],
    '売却する': ['Sell', 'Продать', 'Verkaufen'],
    // Характеристики
    '最大HP': ['Max HP', 'Макс. HP', 'Max. HP'],
    '最大MP': ['Max MP', 'Макс. MP', 'Max. MP'],
    '攻撃力': ['Attack', 'Атака', 'Angriff'],
    '防御力': ['Defense', 'Защита', 'Verteidigung'],
    '魔法力': ['M.Attack', 'Маг. атака', 'Mag. Angriff'],
    '魔法攻撃': ['M.Attack', 'Маг. атака', 'Mag. Angriff'],
    '魔法防御': ['M.Defense', 'Маг. защита', 'Mag. Abwehr'],
    '敏捷性': ['Agility', 'Ловкость', 'Agilität'],
    '運': ['Luck', 'Удача', 'Glück'],
    '命中率': ['Hit', 'Меткость', 'Trefferquote'],
    '回避率': ['Evasion', 'Уклонение', 'Ausweichen'],
    // Настройки и сохранение
    '常時ダッシュ': ['Always Dash', 'Всегда бегом', 'Immer rennen'],
    'コマンド記憶': ['Command Remember', 'Запоминать команду', 'Befehl merken'],
    'タッチUI': ['Touch UI', 'Сенсорное меню', 'Touch-UI'],
    'BGM 音量': ['BGM Volume', 'Громкость музыки', 'Musiklautstärke'],
    'BGS 音量': ['BGS Volume', 'Громкость фона', 'Hintergrundlautstärke'],
    'ME 音量': ['ME Volume', 'Громкость мелодий', 'Melodielautstärke'],
    'SE 音量': ['SE Volume', 'Громкость звуков', 'Effektlautstärke'],
    '持っている数': ['Possession', 'В наличии', 'Im Besitz'],
    'ファイル': ['File', 'Файл', 'Datei'],
    'どのファイルにセーブしますか？': ['Save to which file?', 'В какой файл сохранить?', 'In welche Datei speichern?'],
    'どのファイルをロードしますか？': ['Load which file?', 'Какой файл загрузить?', 'Welche Datei laden?'],
    // Типы снаряжения
    '盾': ['Shield', 'Щит', 'Schild'],
    '頭': ['Head', 'Голова', 'Kopf'],
    '身体': ['Body', 'Тело', 'Körper'],
    '装飾品': ['Accessory', 'Аксессуар', 'Accessoire'],
    '一般防具': ['General Armor', 'Обычная броня', 'Allgemeine Rüstung'],
    '魔法防具': ['Magic Armor', 'Магическая броня', 'Magische Rüstung'],
    '軽装防具': ['Light Armor', 'Лёгкая броня', 'Leichte Rüstung'],
    '重装防具': ['Heavy Armor', 'Тяжёлая броня', 'Schwere Rüstung'],
    '小型盾': ['Small Shield', 'Малый щит', 'Kleiner Schild'],
    '大型盾': ['Large Shield', 'Большой щит', 'Großer Schild'],
    // Типы оружия и навыков
    '短剣': ['Dagger', 'Кинжал', 'Dolch'],
    '剣': ['Sword', 'Меч', 'Schwert'],
    'フレイル': ['Flail', 'Цеп', 'Flegel'],
    '斧': ['Axe', 'Топор', 'Axt'],
    'ムチ': ['Whip', 'Кнут', 'Peitsche'],
    '杖': ['Staff', 'Посох', 'Stab'],
    '弓': ['Bow', 'Лук', 'Bogen'],
    'クロスボウ': ['Crossbow', 'Арбалет', 'Armbrust'],
    '銃': ['Gun', 'Ружьё', 'Gewehr'],
    '爪': ['Claw', 'Когти', 'Klaue'],
    'グローブ': ['Glove', 'Перчатки', 'Handschuh'],
    '槍': ['Spear', 'Копьё', 'Speer'],
    '魔法': ['Magic', 'Магия', 'Magie'],
    '必殺技': ['Special', 'Особые', 'Spezial'],
    // Стихии
    '物理': ['Physical', 'Физический', 'Physisch'],
    '炎': ['Fire', 'Огонь', 'Feuer'],
    '氷': ['Ice', 'Лёд', 'Eis'],
    '雷': ['Thunder', 'Молния', 'Blitz'],
    '水': ['Water', 'Вода', 'Wasser'],
    '土': ['Earth', 'Земля', 'Erde'],
    '風': ['Wind', 'Ветер', 'Wind'],
    '光': ['Light', 'Свет', 'Licht'],
    '闇': ['Darkness', 'Тьма', 'Dunkelheit'],
};
const LANG_INDEX = { en: 0, ru: 1, de: 2 };

// Ключ: японские игры пишут то «ＨＰ», то «HP», то с пробелом — сравниваем в одном виде (NFKC, без пробелов
// по краям; «BGM 音量» и «BGM音量» — одно)
const norm = (s) => String(s).normalize('NFKC').trim().replace(/\s+/g, ' ');
const INDEX = new Map(Object.entries(TERMS).flatMap(([ja, tr]) => [[norm(ja), tr], [norm(ja).replace(/ /g, ''), tr]]));

// Перевод стандартного слова или undefined. overrides — словарь терминов из переведённых игр библиотеки
// (services/termlib.js: Map(norm(японский) → перевод)): он главнее встроенного
function termOf(src, lang, overrides) {
    const i = LANG_INDEX[lang];
    if (i === undefined || typeof src !== 'string') return undefined;
    const key = norm(src);
    const flat = key.replace(/ /g, '');
    return overrides?.get(key) ?? overrides?.get(flat) ?? INDEX.get(key)?.[i] ?? INDEX.get(flat)?.[i];
}

module.exports = { termOf, norm, TERMS };
