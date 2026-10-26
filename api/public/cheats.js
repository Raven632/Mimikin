// Чит-меню Mimikin — для игр RPG Maker MV и MZ. Открывается пунктом «Чит-меню» в меню ⚙ (rpg-fixes.js грузит этот
// файл при первом нажатии). Панель поверх игры: отряд (бессмертие, лечение, уровень, опыт, характеристики, деньги),
// предметы с поиском, переменные и переключатели, мир (скорость, сквозь стены, без случайных боёв, бой, телепорт),
// сцены (открыть всё в комнате воспоминаний).
// Сделано для пальца и мыши: касания и клавиши в панели до игры не доходят. Сохраняется только то, что игра
// сохраняет сама (деньги, предметы, переменные); бессмертие, скорость и прочие режимы — до перезапуска игры
(() => {
    if (window.__rpgCheats) return;

    const TEXT = {
        ru: {
            title: 'Чит-меню', close: 'Закрыть', not_started: 'Откроется, когда начнётся игра: на титульном экране ещё нет героев.',
            tab_party: 'Отряд', tab_items: 'Предметы', tab_vars: 'Переменные', tab_world: 'Мир',
            god: 'Бессмертие', god_all: 'Бессмертие всему отряду', god_hint: 'HP, MP и TP не убывают, герой не погибает',
            heal: 'Вылечить отряд', clear_states: 'Снять состояния', level: 'Уровень', exp: 'Опыт', stats: 'Характеристики',
            gold: 'Деньги', params: ['Макс. HP', 'Макс. MP', 'Атака', 'Защита', 'Маг. атака', 'Маг. защита', 'Ловкость', 'Удача'],
            kind_items: 'Предметы', kind_weapons: 'Оружие', kind_armors: 'Броня', search: 'Поиск по названию или номеру',
            have: 'есть', nothing: 'Ничего не нашлось', more: (n) => `и ещё ${n} — уточните поиск`,
            kind_vars: 'Переменные', kind_switches: 'Переключатели',
            speed: 'Скорость героя', speed_lock: 'Не сбрасывать (события её не меняют)', noclip: 'Сквозь стены', no_encounters: 'Без случайных боёв',
            battle: 'Бой', win: 'Победить сразу', enemy_one: 'Врагам 1 HP', not_in_battle: 'Сейчас не бой',
            teleport: 'Телепорт', map: 'Карта', go: 'Перенести', places: 'Запомненные места', remember: 'Запомнить', recall: 'Вернуться',
            empty_slot: 'пусто', only_map: 'Только на карте', done: 'Готово',
            tab_scenes: 'Сцены', scenes_loading: 'Ищу сцены…', scenes_maps_failed: 'Не все карты игры прочитались — открыть сцены безопасно нельзя. Зайдите на вкладку ещё раз.',
            scenes_not_started: 'Откроется в игре: начните новую или загрузите сейв — на титульном экране открывать нечего.',
            scenes_none: 'Сцен не нашлось: у игры нет комнаты воспоминаний, которую видно отсюда. Переключатели — во вкладке «Переменные».',
            scenes_room: (rooms) => `Комната воспоминаний: ${rooms}`,
            scenes_count: (before, after, total) => `В комнате воспоминаний открыто ${before} из ${total}${after > before ? ` — откроется ${after}` : ''}`,
            scenes_open_all: 'Открыть все сцены', scenes_all_open: 'Всё уже открыто', scenes_safe_open: 'Безопасные открыты',
            scenes_story: (n) => `Ещё ${n} держит сюжет: их открывают сюжетные переключатели и счётчики, а от них игра сама запускает события — сцены сюжета, анимации. Прохождение может поехать; откат — момент «До открытия сцен».`,
            scenes_open_story: (n) => `Открыть ещё ${n}`, scenes_story_no_moment: 'Момент не запомнился — без отката это не открываю. Откройте «Сцены» на карте.',
            scenes_warn: 'Меняет эту игру: сцены станут «просмотренными», а где комната смотрит на прогресс — подрастут счётчики. Перед этим запомню момент «До открытия сцен»: если сюжет поедет — вернитесь к нему (меню игры → Моменты).',
            scenes_moment: 'До открытия сцен',
            scenes_no_moment: 'Момент «До открытия сцен» не запомнился — отката не будет. Лучше открыть «Сцены» на карте. Открыть всё равно — нажмите ещё раз.', scenes_open_anyway: 'Открыть без отката',
            scenes_done: 'Готово. Момент «До открытия сцен» запомнен. Сохранитесь — комната воспоминаний берёт открытое из сейвов.',
            scenes_done_nomoment: 'Готово, но момент не запомнился (это можно только на карте). Сохранитесь — комната берёт открытое из сейвов.',
            scenes_vars: 'Счётчики', scenes_selfs: (n) => `Событий комнаты: ${n}`, scenes_items: (n) => `Предметов: ${n}`,
            scenes_events: 'Игра откроет сама (может спросить)', scenes_plugin: 'Галерея плагина откроется целиком',
            scenes_more: (n) => `и ещё ${n}`,
            room_go: 'В комнату воспоминаний', room_go_anyway: 'Идти без отката',
            room_no_moment: 'Момент «Перед комнатой воспоминаний» не запомнился — вернуться сюда будет нечем. Идти всё равно — нажмите ещё раз.', room_searching: 'Ищу вход в комнату…', room_moment: 'Перед комнатой воспоминаний',
            room_done: 'Иду в комнату. Вернуться сюда — момент «Перед комнатой воспоминаний» (меню игры → Моменты).',
            room_done_nomoment: 'Иду в комнату. Момент не запомнился — назад только своим ходом или сейвом.',
            room_none: 'Не нашёл, как попасть в комнату воспоминаний.', room_busy: 'Сейчас идёт событие — дождитесь его конца на карте.',
            scenes_all_label: 'Открыть всё (переключатель игры)', scenes_list: 'Сцены',
        },
        en: {
            title: 'Cheat menu', close: 'Close', not_started: 'Opens once the game has started: there are no heroes on the title screen yet.',
            tab_party: 'Party', tab_items: 'Items', tab_vars: 'Variables', tab_world: 'World',
            god: 'God mode', god_all: 'God mode for the whole party', god_hint: 'HP, MP and TP never drop, the hero cannot die',
            heal: 'Heal the party', clear_states: 'Clear states', level: 'Level', exp: 'EXP', stats: 'Stats',
            gold: 'Gold', params: ['Max HP', 'Max MP', 'Attack', 'Defense', 'M. Attack', 'M. Defense', 'Agility', 'Luck'],
            kind_items: 'Items', kind_weapons: 'Weapons', kind_armors: 'Armor', search: 'Search by name or number',
            have: 'have', nothing: 'Nothing found', more: (n) => `and ${n} more — narrow the search`,
            kind_vars: 'Variables', kind_switches: 'Switches',
            speed: 'Hero speed', speed_lock: 'Keep it (events cannot change it)', noclip: 'Walk through walls', no_encounters: 'No random battles',
            battle: 'Battle', win: 'Win now', enemy_one: 'Enemies to 1 HP', not_in_battle: 'Not in battle',
            teleport: 'Teleport', map: 'Map', go: 'Go', places: 'Saved places', remember: 'Remember', recall: 'Go back',
            empty_slot: 'empty', only_map: 'Only on the map', done: 'Done',
            tab_scenes: 'Scenes', scenes_loading: 'Looking for scenes…', scenes_maps_failed: 'Not all of the game’s maps could be read — scenes can’t be unlocked safely. Open the tab again.',
            scenes_not_started: 'Opens in the game: start a new one or load a save — there is nothing to unlock on the title screen.',
            scenes_none: 'No scenes found: the game has no recollection room that can be seen from here. Switches are on the Variables tab.',
            scenes_room: (rooms) => `Recollection room: ${rooms}`,
            scenes_count: (before, after, total) => `${before} of ${total} open in the recollection room${after > before ? ` — ${after} after unlocking` : ''}`,
            scenes_open_all: 'Unlock all scenes', scenes_all_open: 'Everything is unlocked', scenes_safe_open: 'Safe ones unlocked',
            scenes_story: (n) => `${n} more are held by the story: story switches and counters open them, and those make the game start events by itself — story scenes, animations. Your playthrough may go off track; the way back is the moment “Before unlocking scenes”.`,
            scenes_open_story: (n) => `Unlock ${n} more`, scenes_story_no_moment: 'The moment was not remembered — without a way back I won’t unlock these. Open “Scenes” on the map.',
            scenes_warn: 'This changes the game: scenes count as seen, and where the room checks progress, counters go up. First I remember a moment “Before unlocking scenes”: if the story goes wrong, go back to it (game menu → Moments).',
            scenes_moment: 'Before unlocking scenes',
            scenes_no_moment: 'The moment “Before unlocking scenes” was not remembered — there will be no going back. Better open “Scenes” on the map. To unlock anyway, press again.', scenes_open_anyway: 'Unlock without going back',
            scenes_done: 'Done. The moment “Before unlocking scenes” is remembered. Save the game — the recollection room reads unlocked scenes from saves.',
            scenes_done_nomoment: 'Done, but the moment was not remembered (that works only on the map). Save the game — the room reads unlocked scenes from saves.',
            scenes_vars: 'Counters', scenes_selfs: (n) => `Room events: ${n}`, scenes_items: (n) => `Items: ${n}`,
            scenes_events: 'The game unlocks it itself (it may ask)', scenes_plugin: 'The plugin gallery unlocks completely',
            scenes_more: (n) => `and ${n} more`,
            room_go: 'To the recollection room', room_go_anyway: 'Go without a way back',
            room_no_moment: 'The moment “Before the recollection room” was not remembered — there will be no way back here. To go anyway, press again.', room_searching: 'Looking for the way in…', room_moment: 'Before the recollection room',
            room_done: 'Going to the room. To come back here — the moment “Before the recollection room” (game menu → Moments).',
            room_done_nomoment: 'Going to the room. The moment was not remembered — come back on your own or by a save.',
            room_none: 'Found no way into the recollection room.', room_busy: 'An event is running — wait on the map until it ends.',
            scenes_all_label: 'Unlock all (the game\'s own switch)', scenes_list: 'Scenes',
        },
        de: {
            title: 'Cheat-Menü', close: 'Schließen', not_started: 'Öffnet sich, sobald das Spiel begonnen hat: Auf dem Titelbildschirm gibt es noch keine Helden.',
            tab_party: 'Gruppe', tab_items: 'Gegenstände', tab_vars: 'Variablen', tab_world: 'Welt',
            god: 'Unsterblich', god_all: 'Ganze Gruppe unsterblich', god_hint: 'HP, MP und TP sinken nicht, der Held stirbt nicht',
            heal: 'Gruppe heilen', clear_states: 'Zustände entfernen', level: 'Stufe', exp: 'EP', stats: 'Werte',
            gold: 'Geld', params: ['Max. HP', 'Max. MP', 'Angriff', 'Verteidigung', 'Mag. Angriff', 'Mag. Abwehr', 'Agilität', 'Glück'],
            kind_items: 'Gegenstände', kind_weapons: 'Waffen', kind_armors: 'Rüstung', search: 'Nach Name oder Nummer suchen',
            have: 'hast', nothing: 'Nichts gefunden', more: (n) => `und ${n} weitere — Suche eingrenzen`,
            kind_vars: 'Variablen', kind_switches: 'Schalter',
            speed: 'Tempo des Helden', speed_lock: 'Beibehalten (Ereignisse ändern es nicht)', noclip: 'Durch Wände', no_encounters: 'Keine Zufallskämpfe',
            battle: 'Kampf', win: 'Sofort gewinnen', enemy_one: 'Gegner auf 1 HP', not_in_battle: 'Gerade kein Kampf',
            teleport: 'Teleport', map: 'Karte', go: 'Los', places: 'Gemerkte Orte', remember: 'Merken', recall: 'Zurück',
            empty_slot: 'leer', only_map: 'Nur auf der Karte', done: 'Erledigt',
            tab_scenes: 'Szenen', scenes_loading: 'Suche Szenen…', scenes_maps_failed: 'Nicht alle Karten des Spiels ließen sich lesen — Szenen lassen sich nicht sicher freischalten. Öffne den Tab noch einmal.',
            scenes_not_started: 'Öffnet sich im Spiel: starte ein neues oder lade einen Spielstand — auf dem Titelbildschirm gibt es nichts freizuschalten.',
            scenes_none: 'Keine Szenen gefunden: Das Spiel hat keinen Erinnerungsraum, der von hier aus sichtbar ist. Schalter gibt es im Tab „Variablen“.',
            scenes_room: (rooms) => `Erinnerungsraum: ${rooms}`,
            scenes_count: (before, after, total) => `Im Erinnerungsraum offen: ${before} von ${total}${after > before ? ` — danach ${after}` : ''}`,
            scenes_open_all: 'Alle Szenen freischalten', scenes_all_open: 'Alles ist freigeschaltet', scenes_safe_open: 'Sichere freigeschaltet',
            scenes_story: (n) => `${n} weitere hängen an der Geschichte: Story-Schalter und Zähler schalten sie frei, und davon startet das Spiel selbst Ereignisse — Story-Szenen, Animationen. Der Spielverlauf kann durcheinandergeraten; zurück geht es mit dem Moment „Vor dem Freischalten“.`,
            scenes_open_story: (n) => `${n} weitere freischalten`, scenes_story_no_moment: 'Der Moment wurde nicht gemerkt — ohne Rückweg schalte ich das nicht frei. Öffne „Szenen“ auf der Karte.',
            scenes_warn: 'Ändert das Spiel: Szenen gelten als gesehen, und wo der Raum den Fortschritt prüft, steigen Zähler. Vorher merke ich mir den Moment „Vor dem Freischalten“: läuft die Geschichte schief — zurück dorthin (Spielmenü → Momente).',
            scenes_moment: 'Vor dem Freischalten',
            scenes_no_moment: 'Der Moment „Vor dem Freischalten“ wurde nicht gemerkt — es gibt kein Zurück. Öffne „Szenen“ besser auf der Karte. Trotzdem freischalten — nochmal drücken.', scenes_open_anyway: 'Ohne Zurück freischalten',
            scenes_done: 'Erledigt. Der Moment „Vor dem Freischalten“ ist gemerkt. Speichere — der Erinnerungsraum liest Freigeschaltetes aus den Spielständen.',
            scenes_done_nomoment: 'Erledigt, aber der Moment wurde nicht gemerkt (das geht nur auf der Karte). Speichere — der Raum liest Freigeschaltetes aus den Spielständen.',
            scenes_vars: 'Zähler', scenes_selfs: (n) => `Ereignisse im Raum: ${n}`, scenes_items: (n) => `Gegenstände: ${n}`,
            scenes_events: 'Das Spiel schaltet es selbst frei (fragt vielleicht)', scenes_plugin: 'Die Galerie des Plugins wird komplett freigeschaltet',
            scenes_more: (n) => `und ${n} weitere`,
            room_go: 'In den Erinnerungsraum', room_go_anyway: 'Ohne Rückweg gehen',
            room_no_moment: 'Der Moment „Vor dem Erinnerungsraum“ wurde nicht gemerkt — es gibt keinen Weg zurück hierher. Trotzdem gehen — nochmal drücken.', room_searching: 'Suche den Eingang…', room_moment: 'Vor dem Erinnerungsraum',
            room_done: 'Auf in den Raum. Zurück hierher — Moment „Vor dem Erinnerungsraum“ (Spielmenü → Momente).',
            room_done_nomoment: 'Auf in den Raum. Der Moment wurde nicht gemerkt — zurück nur selbst oder per Spielstand.',
            room_none: 'Keinen Weg in den Erinnerungsraum gefunden.', room_busy: 'Gerade läuft ein Ereignis — warte auf der Karte, bis es vorbei ist.',
            scenes_all_label: 'Alles freischalten (Schalter des Spiels)', scenes_list: 'Szenen',
        },
    };
    // Язык — тот же, что у меню ⚙ (rpg-fixes): из адреса (?lang=) или выбранный в библиотеке
    const LANG = (() => {
        let lang = null;
        try { lang = new URLSearchParams(location.search).get('lang'); } catch (e) { /* без адреса */ }
        if (!TEXT[lang]) try { lang = localStorage.getItem('rpg_lang'); } catch (e) { /* без хранилища */ }
        return TEXT[lang] ? lang : 'ru';
    })();
    const T = TEXT[LANG];
    const num = (n) => Number(n).toLocaleString(LANG);

    // ------------------------------------------------------------------------------------------------------------
    // Режимы, которые держатся, пока игра открыта: бессмертие, скорость, сквозь стены, без случайных боёв
    const mode = { god: new Set(), speed: 0, lockSpeed: false, noclip: false, noEncounters: false };
    // Скорость с «держать», «сквозь стены» и «без случайных боёв» — на эту игру, в браузере: раньше они сбрасывались при
    // каждом запуске. Бессмертие — нет: оно у героя, а герои у сейвов разные
    const modesKey = () => `rpgCheatsModes_${(window.__RPG && window.__RPG.id) || location.pathname}`;
    const saveModes = () => {
        try { localStorage.setItem(modesKey(), JSON.stringify({ speed: mode.lockSpeed ? mode.speed : 0, lockSpeed: mode.lockSpeed, noclip: mode.noclip, noEncounters: mode.noEncounters })); } catch (e) { /* без хранилища — до перезапуска */ }
    };
    let patched = false;
    function patchGame() {
        if (patched || typeof Game_BattlerBase === 'undefined') return;
        patched = true;
        const isGod = (b) => typeof Game_Actor !== 'undefined' && b instanceof Game_Actor && mode.god.has(b.actorId());
        const wrap = (proto, name, make) => { if (proto && typeof proto[name] === 'function') proto[name] = make(proto[name]); };
        // Любая потеря HP, MP и TP идёт через setHp/setMp/setTp — у бессмертного они не убывают. Перехват — у самого
        // героя (Game_Actor), поверх плагинов: они переопределяют setHp героя и зовут запомненную базовую функцию,
        // так что перехват у базового класса обошли бы
        const actor = typeof Game_Actor !== 'undefined' ? Game_Actor.prototype : null;
        wrap(actor, 'setHp', (orig) => function(v) { return orig.call(this, isGod(this) ? Math.max(v, this.mhp) : v); });
        wrap(actor, 'setMp', (orig) => function(v) { return orig.call(this, isGod(this) ? Math.max(v, this.mmp) : v); });
        wrap(actor, 'setTp', (orig) => function(v) { return orig.call(this, isGod(this) ? Math.max(v, this.maxTp()) : v); });
        // Смерть — состояние: бессмертному его не дать
        wrap(actor, 'addState', (orig) => function(id) {
            if (isGod(this) && id === this.deathStateId()) return undefined;
            return orig.apply(this, arguments);
        });
        if (typeof Game_Player !== 'undefined') {
            wrap(Game_Player.prototype, 'setMoveSpeed', (orig) => function(v) { return orig.call(this, mode.lockSpeed && mode.speed ? mode.speed : v); });
            // И после загрузки сейва: в нём своя скорость, setMoveSpeed её не трогает
            wrap(Game_Player.prototype, 'realMoveSpeed', (orig) => function() { return mode.lockSpeed && mode.speed ? mode.speed + (this.isDashing() ? 1 : 0) : orig.apply(this, arguments); });
            wrap(Game_Player.prototype, 'isThrough', (orig) => function() { return mode.noclip || orig.apply(this, arguments); });
            wrap(Game_Player.prototype, 'canEncounter', (orig) => function() { return !mode.noEncounters && orig.apply(this, arguments); });
        }
    }

    // Запомненные режимы — когда игра загрузила плагины (за загрузочной сценой): плагин, заменивший isThrough или
    // canEncounter без вызова прежнего, иначе снял бы наш перехват. rpg-fixes грузит чит-меню сразу, если тут что-то включено
    try {
        const saved = JSON.parse(localStorage.getItem(modesKey()) || '{}') || {};
        mode.speed = Number(saved.speed) || 0;
        mode.lockSpeed = !!saved.lockSpeed && mode.speed > 0;
        mode.noclip = !!saved.noclip;
        mode.noEncounters = !!saved.noEncounters;
    } catch (e) { /* без хранилища */ }
    if (mode.lockSpeed || mode.noclip || mode.noEncounters) {
        const wait = setInterval(() => {
            const scene = typeof SceneManager !== 'undefined' && SceneManager._scene;
            if (!scene || (typeof Scene_Boot !== 'undefined' && scene instanceof Scene_Boot)) return;
            clearInterval(wait);
            patchGame();
        }, 300);
        setTimeout(() => clearInterval(wait), 120000);
    }

    const started = () => typeof $gameParty !== 'undefined' && $gameParty && typeof $gameParty.members === 'function' && $gameParty.members().length > 0;
    // Сценам отряд не нужен (бывают игры, где он пуст до первой сцены), нужна начатая игра: на титульном экране
    // переключатели — заготовка новой игры, включать их там без толку
    const inGame = () => {
        if (typeof $gameSwitches === 'undefined' || !$gameSwitches || typeof SceneManager === 'undefined') return false;
        const scene = SceneManager._scene;
        return !!scene && !(typeof Scene_Title !== 'undefined' && scene instanceof Scene_Title) && !(typeof Scene_Boot !== 'undefined' && scene instanceof Scene_Boot);
    };
    // Название без кодов игры («\I[12]Зелье» → «Зелье»)
    const plain = (s) => String(s || '').replace(/\\[A-Za-z]+\[[^\]]*\]|\\[A-Za-z{}|.!<>^$]/g, '').trim();

    // Действия — отдельно от панели: их проверяют тесты (server.test.js), без страницы
    const actions = {
        setGod(actor, on) {
            patchGame();
            if (on) mode.god.add(actor.actorId()); else mode.god.delete(actor.actorId());
            if (on) actor.recoverAll();
        },
        isGod: (actor) => mode.god.has(actor.actorId()),
        heal() { for (const a of $gameParty.members()) { a.recoverAll(); a.refresh(); } },
        clearStates() { for (const a of $gameParty.members()) { a.clearStates(); a.refresh(); } },
        level(actor, delta) {
            const max = typeof actor.maxLevel === 'function' ? actor.maxLevel() : 99;
            actor.changeLevel(Math.max(1, Math.min(max, actor.level + delta)), false);
            actor.refresh();
        },
        exp(actor, amount) { actor.changeExp(Math.max(0, actor.currentExp() + amount), false); actor.refresh(); },
        param(actor, id, delta) { actor.addParam(id, delta); actor.refresh(); },
        gold(delta) { if (delta >= 0) $gameParty.gainGold(delta); else $gameParty.loseGold(-delta); },
        give(item, n) { $gameParty.gainItem(item, n, false); },
        setVariable(id, value) {
            const v = typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
            $gameVariables.setValue(id, v);
        },
        toggleSwitch(id) { $gameSwitches.setValue(id, !$gameSwitches.value(id)); },
        // Сцены (findScenes): включить переключатели, поднять счётчики, личные переключатели событий комнаты, выдать
        // предметы, запустить общие события «открыть всё» автора и «открыть всё» плагинов галерей
        openScenes(plan, { plugins = true } = {}) {
            for (const sc of [...(plan.all || []), ...(plan.scenes || [])]) $gameSwitches.setValue(sc.id, true);
            for (const v of plan.vars || []) if ((Number($gameVariables.value(v.id)) || 0) < v.value) $gameVariables.setValue(v.id, v.value);
            for (const key of plan.selfs || []) $gameSelfSwitches.setValue(key.split(',').map((x, i) => (i < 2 ? Number(x) : x)), true);
            for (const it of plan.items || []) {
                const data = it.kind === 8 ? $dataItems : it.kind === 9 ? $dataWeapons : $dataArmors;
                if (data && data[it.id] && !$gameParty.hasItem(data[it.id], true)) $gameParty.gainItem(data[it.id], 1);
            }
            // Общее событие «открыть всё» автора — одно (в MV в очереди и помещается одно)
            for (const ev of (plan.events || []).slice(0, 1)) $gameTemp.reserveCommonEvent(ev.id);
            return plugins ? pluginUnlock(window) : [];
        },
        speed(v) {
            patchGame();
            mode.speed = v;
            if (typeof $gamePlayer !== 'undefined' && $gamePlayer) $gamePlayer.setMoveSpeed(v);
            saveModes();
        },
        lockSpeed(on) { patchGame(); mode.lockSpeed = on; saveModes(); },
        noclip(on) { patchGame(); mode.noclip = on; saveModes(); },
        noEncounters(on) { patchGame(); mode.noEncounters = on; saveModes(); },
        // Бой: врагам — 0 HP (и падают, как от удара) или 1 HP. Победу засчитает сам движок на следующем кадре
        win() {
            for (const e of $gameTroop.aliveMembers()) {
                e.setHp(0);
                e.refresh();
                if (e.isDead() && typeof e.performCollapse === 'function') e.performCollapse();
            }
        },
        enemiesToOne() { for (const e of $gameTroop.aliveMembers()) { e.setHp(1); e.refresh(); } },
        teleport(mapId, x, y) {
            $gamePlayer.reserveTransfer(mapId, x, y, $gamePlayer.direction(), 0);
            if (typeof $gameTemp !== 'undefined' && $gameTemp.clearDestination) $gameTemp.clearDestination();
        },
        mode,
    };

    // ------------------------------------------------------------------------------------------------------------
    // Сцены: что открыть, чтобы в комнате воспоминаний были все сцены. Спрашиваем саму игру, а не угадываем:
    //   all    — переключатель «открыть всё», который оставил автор («回想全開放», «全開放スイッチ», «Unlock Defeated
    //            Scenes», параметр плагина вроде allUnlockSwitchId). Самое надёжное — им игра и открывает всё сама;
    //   lists  — список сцен плагина комнаты (RecollectionMode MV и MZ): у каждой сцены свой переключатель и название;
    //   комната — карта «回想部屋», «Recollection Room», «Memory Room»: событие, которое со своим переключателем
    //            запускает сцену (зовёт общее событие, переносит на карту сцены), а без него закрыто.
    // Переключатели состояния («回想中», «昼», «移動禁止», «妊娠状態») не трогаем: включённые, они ломают игру.
    // Проверено на 97 играх библиотеки: что-то нашлось у 61
    // «回憶室» (TOD), «回忆空间» (Ashen Crown), «回想の部屋» (Hollow Spire), «CG ROOM» (LAT), «Reminiscence room»,
    // «Flashback Room», «recall theater», «Screening Room» (Clockwork Vale), «recolection_room» (опечатка, Going to the
    // caves), «CG» (Seven Keys), «Комната воспоминаний», «Вспоминания» (Ashen Crown) — так тоже называют комнату
    const ROOM = /回想(?:部屋|室|の間|ルーム|房|屋|空間)|回想の部屋|回[憶忆](?:部屋|室|の間|房|屋|空间|空間)|recoll?ection\s*(?:room|hall)|memor(?:y|ies)\s*(?:room|hall)|hall of memor|gallery|ギャラリー|鑑賞(?:室|部屋)|\bcg\s*room\b|reminisc(?:ent|ence)\s*room|flashback\s*room|screening\s*room|^[\s★☆■◆]*flashback\s*scenes?[\s★☆■◆]*$|recall\s*theater|комнат\S*\s+вос+поминани|^[\s★☆✨️■◆]*(?:回想|recoll?ection|memory|memories|cg|в(?:ос|с)поминани[яе])[\s★☆■◆]*$/iu;
    // Карты самих сцен и служебные («回想用MAP», «回想部屋初期化», «体験版回想») — не комната
    const NOT_ROOM = /用|初期化|test|テスト|前の|trial|体験版/i;
    const ALL_WORD = /全.{0,4}(?:開放|解放|开放|解锁|开)|一括(?:開放|解放)|(?:unlock|open)\s*all|(?:all|full)\s*open|all\s*(?:scenes?|recollections?|memories)|unlock\s+.*scenes|gallery\s*unlock|回想.{0,3}(?:開放|解放|解锁)|recollection.{0,6}unlock|unlock.{0,6}recollection|全回想|回想全/i;
    // «全開放» — сцен, а не района («东区已完全开放» — открыт восточный район, это сюжет)
    const SCENE_WORD = /回想|【回】|シーン|scene|cg|ｃｇ|gallery|ギャラリー|イベント|event|エクストラ|extra|図鑑|recollection|memor|裏切り/i;
    const STATE = /禁止|不可|不能|一時|準備|初期化|フェード|スキップ|テスト|デバッグ|ワープ|移動|テレポ|体験版|封印|説明|チュートリアル|ヒント|待機|汎用|便利|表示|画面|カーソル|音量|演出|時間帯|横スク|立ち絵|操作|自動|管理|状態|カットイン|処理|曜日|天気|メニュー|開閉|切り?替え?|モード|にいる|居る|保存用|^\s*(?:昼|夜|深夜|朝|夕方|白天|晚上|夜间|day|night)\s*$/i;
    // Латиница — целыми словами, и в camelCase тоже: «unlockedModelingJob2» — не «mode», «Trademond», «Demon» — не «demo»
    // и в формах «Skipping», «Debugging», «Menus»; «BGMOff», «BGMVolume» — по началу слова. «Tests» — нет: у Seven Keys
    // «u_testsAreOut…» — счётчик сюжета про экзамены, а отладочный флаг пишут «Test»
    const STATE_WORDS = new Set(['skip', 'test', 'debug', 'warp', 'trial', 'demo', 'sealed', 'explanation', 'tutorial', 'hint', 'menu', 'mode', 'cutin',
        'skipping', 'skips', 'debugging', 'warping', 'hints', 'menus', 'tutorials', 'modes']);
    const latinWords = (name) => String(name || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/cut-in/gi, 'cutin')
        .toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const stateWord = (w) => STATE_WORDS.has(w) || /^bgm/.test(w);
    const stripTail = (s) => String(s || '').replace(/[\s\p{P}\p{S}_]+$/u, '');
    // «【回想】宿舎の管理兵２», «回想：ガブリーヌA» — флаг сцены, хоть в названии и есть «管理»: слабые слова состояния его
    // не делают состоянием. Сильные — делают всегда: «回想：禁止», «Recollection Mode», «…中»
    const SCENE_FLAG = /^\s*(?:【(?:回想|回憶|回忆)】|(?:回想|回憶|回忆)[：:])/;
    const STRONG_STATE = /禁止|不可|不能|モード|スキップ|テスト|デバッグ|メニュー|体験版|待機/;
    const STRONG_WORDS = new Set(['mode', 'skip', 'test', 'debug', 'menu', 'trial', 'demo']);
    const isState = (name) => /中$|用$/.test(stripTail(name)) || STRONG_STATE.test(name)
        || latinWords(name).some((w) => STRONG_WORDS.has(w) || w === 'skipping' || w === 'debugging' || w === 'menus')
        || (!SCENE_FLAG.test(name) && (STATE.test(name) || latinWords(name).some(stateWord)));
    // «回想未解放» — «ещё не открыто», это не «открыть всё»
    const isAll = (name) => ALL_WORD.test(name) && !/未(?:開放|解放|解锁)|非開放|关闭|全关/.test(name) && (SCENE_WORD.test(name)
        || name.replace(ALL_WORD, '').replace(/スイッチ|switch|on|後|済|した/gi, '').replace(/[\s\p{P}\p{S}_]/gu, '').length <= 2);
    // ---- Решатель комнаты воспоминаний ----
    // Вход в сцену — событие комнаты, у которого есть страница, запускающая сцену: перенос на карту сцены, картинка,
    // ролик, бой, команда плагина — сама или через общее событие. Вход открыт, когда его страница со сценой активна
    // (условия страницы) и до запуска сцены пропускают ветвления «Если…» — в самом событии и в общих событиях, которые
    // оно зовёт. Решатель проходит закрытые входы и выставляет то, что их держит: переключатель — ВКЛ, переменную — не
    // меньше нужного, личный переключатель события комнаты, предмет. Не трогает: переключатели и переменные состояния
    // (STATE: «回想中», «昼», «移動禁止»), «выключить», «переменная = числу» (это выбор сцены или координаты возврата).
    // Проверено на всех играх библиотеки (57 с комнатой): в новой игре открыто 1764 входа из 5414, после решателя — 5315;
    // поиск по одним именам переключателей открывал 3767
    const SCENE_START = new Set([201, 231, 261, 301, 356, 357]);
    const OPS = [(a, b) => a === b, (a, b) => a >= b, (a, b) => a <= b, (a, b) => a > b, (a, b) => a < b, (a, b) => a !== b];
    const MAX_DEPTH = 4;
    const MAX_PATHS = 40;
    // Есть ли в списке запуск сцены (сам или через общее событие). Общие события — с памятью: их зовут сотни раз
    const startMemo = new WeakMap();
    function hasSceneStart(list, ces) {
        return (list || []).some((c) => c && (SCENE_START.has(c.code) || (c.code === 117 && ceHasStart(c.parameters[0], ces))));
    }
    // Обход графа вызовов с отметкой «уже был» (циклы A → B → A); в память — только итог для того, с кого начали:
    // так ответ не зависит от порядка обхода
    function ceHasStart(id, ces) {
        if (!ces || typeof ces !== 'object') return false;
        let memo = startMemo.get(ces);
        if (!memo) { memo = new Map(); startMemo.set(ces, memo); }
        if (memo.has(id)) return memo.get(id);
        const seen = new Set();
        const visit = (cid) => {
            if (seen.has(cid)) return false;
            seen.add(cid);
            return ((ces[cid] && ces[cid].list) || []).some((c) => c && (SCENE_START.has(c.code)
                || (c.code === 117 && (memo.get(c.parameters[0]) === true || visit(c.parameters[0])))));
        };
        const v = visit(id);
        memo.set(id, v);
        return v;
    }
    // «Если…»: true / false, null — не знаем (кнопка, скрипт, таймер): такое считаем проходимым (оценка
    // оптимистичная — «откроется» бывает чуть больше, чем на деле). Метки и переходы, циклы — не разбираем
    function check111(p, st, ctx) {
        switch (p[0]) {
            case 0: return st.sw(p[1]) === (p[2] === 0);
            case 1: {
                const a = st.vr(p[1]);
                const b = p[2] === 0 ? p[3] : st.vr(p[3]);
                return OPS[p[4]] ? OPS[p[4]](Number(a) || 0, Number(b) || 0) : null;
            }
            case 2: return st.self(`${ctx.map},${ctx.ev},${p[1]}`) === (p[2] === 0);
            case 8: case 9: case 10: return st.item(p[0], p[1]);
            default: return null;
        }
    }
    // Что нужно, чтобы «Если…» пропустило (inElse — команда в «Иначе»). Выставить можно не всё: «выключить»,
    // «= числу» (выбор сцены, координаты возврата) — нельзя; тогда { impossible }
    function want111(p, inElse, ctx) {
        if (p[0] === 0) return (p[2] === 0) !== inElse ? { sw: p[1] } : { impossible: true };
        if (p[0] === 1 && p[2] === 0) {
            const op = p[4];
            // «= N» — обычно выбор сцены или координаты, такое не подгоняем. Но если в комнате переменную сравнивают
            // только с одним N («JC01 = 1» у Seven Keys) — это флаг «сцена открыта»: поднимаем до N
            const flag = op === 0 && !inElse && p[3] > 0 && ctx.flagEq && ctx.flagEq(p[1], p[3]);
            const min = flag ? p[3] : !inElse ? (op === 1 ? p[3] : op === 3 ? p[3] + 1 : null) : (op === 4 ? p[3] : op === 2 ? p[3] + 1 : null);
            return min !== null ? { vr: p[1], min } : { impossible: true };
        }
        if (p[0] === 2 && p[2] === 0 && !inElse) return { self: `${ctx.map},${ctx.ev},${p[1]}` };
        if ((p[0] === 8 || p[0] === 9 || p[0] === 10) && !inElse) return { item: [p[0], p[1]] };
        return { impossible: true };
    }
    // Пути к запуску сцены: для каждого запуска — что держит его ветвления ([] — путь открыт). Ветки выбора и
    // «Иначе» — разные пути: выставлять будем один, самый короткий. Закрытых путей — не больше MAX_PATHS (у меню на
    // десятки сцен их сотни), но открытый ищется до конца списка: найден — сразу ответ [[]]
    function scenePaths(list, st, ctx, ces, depth) {
        const out = [];
        const stack = [];
        for (const cmd of list || []) {
            if (!cmd) continue;
            while (stack.length && cmd.indent <= stack[stack.length - 1].indent && !(cmd.code === 411 && cmd.indent === stack[stack.length - 1].indent)) stack.pop();
            if (cmd.code === 411 && stack.length && stack[stack.length - 1].indent === cmd.indent) { stack[stack.length - 1].inElse = true; continue; }
            if (cmd.code === 111) { stack.push({ indent: cmd.indent, p: cmd.parameters, inElse: false }); continue; }
            const viaCe = cmd.code === 117 && depth < MAX_DEPTH && ceHasStart(cmd.parameters[0], ces);
            // «Включить личный переключатель», за которым страница со сценой (stage) — тоже начало сцены
            const staged = (cmd.code === 123 && cmd.parameters[1] === 0 && ctx.stage && ctx.stage.has(cmd.parameters[0])) || ceByVar(cmd, ctx.ceVars, ces);
            // Вход из меню воспоминаний — одна привязка картинки к сцене, остальные команды меню — не он
            if (ctx.only ? cmd !== ctx.only : !SCENE_START.has(cmd.code) && !viaCe && !staged) continue;
            const reqs = [];
            for (const b of stack) {
                const v = check111(b.p, st, ctx);
                if (v !== null && v === b.inElse) reqs.push(want111(b.p, b.inElse, ctx));
            }
            const subs = viaCe ? scenePaths(ces[cmd.parameters[0]].list, st, ctx, ces, depth + 1) : [[]];
            for (const sub of subs) {
                if (!reqs.length && !sub.length) return [[]];
                if (out.length < MAX_PATHS) out.push([...reqs, ...sub]);
            }
        }
        return out;
    }
    const reachable = (list, st, ctx, ces) => scenePaths(list, st, ctx, ces, 0).some((r) => r.length === 0);
    function pageMeets(c, st, ctx, need) {
        let ok = true;
        const no = (req) => { ok = false; if (need) need.push(req); };
        if (c.switch1Valid && !st.sw(c.switch1Id)) no({ sw: c.switch1Id });
        if (c.switch2Valid && !st.sw(c.switch2Id)) no({ sw: c.switch2Id });
        if (c.variableValid && st.vr(c.variableId) < c.variableValue) no({ vr: c.variableId, min: c.variableValue });
        if (c.selfSwitchValid && !st.self(`${ctx.map},${ctx.ev},${c.selfSwitchCh}`)) no({ self: `${ctx.map},${ctx.ev},${c.selfSwitchCh}` });
        if (c.itemValid && !st.item(8, c.itemId)) no({ item: [8, c.itemId] });
        // «Герой в отряде» не знаем — считаем выполненным (как неизвестное «Если…»); выставлять его решатель не станет
        return ok;
    }
    // Комнаты: карты с именем комнаты воспоминаний и карты, куда переносит общее событие с таким именем («回想部屋» в
    // Starfall Inn ведёт на «●True Debug Room»)
    const ROOM_CE = /回想(?:部屋|室|の間|ルーム|房|屋)|回想の部屋|回[憶忆](?:部屋|室|空间|空間)|recoll?ection\s*room|screening\s*room|memor(?:y|ies)\s*room|ギャラリー|gallery|\bcg\s*room\b|reminisc(?:ent|ence)\s*room|flashback\s*room|комнат\S*\s+вос+поминани/iu;
    function roomMaps(infos, ces) {
        const ids = new Set((infos || []).filter((m) => m && ROOM.test(m.name || '') && !NOT_ROOM.test(m.name || '')).map((m) => m.id));
        for (const c of ces || []) {
            if (!c || !ROOM_CE.test(c.name || '') || NOT_ROOM.test(c.name || '')) continue;
            for (const cmd of c.list || []) if (cmd && cmd.code === 201 && cmd.parameters[0] === 0 && infos[cmd.parameters[1]]) ids.add(cmd.parameters[1]);
        }
        return [...ids].map((id) => infos[id]).filter(Boolean);
    }
    // Комната без «комнатного» имени («Chamber of Fate» у Altair, «Recollection Test» у ambrosia, «Residential Area» у
    // Leila): узнаём по устройству — на карте не меньше HUB_MIN событий, которые включают «воспоминание»: переключатель
    // или общее событие с «回想», «memory», «replay»… в имени, команду плагина про это. Только если по имени нет ни одной.
    // У настоящих комнат таких событий от 18; 8–9 — склад событий и карта концовок у MoonPri
    const HUB_MIN = 10;
    const REC = /回想|回憶|回忆|recollect|memor|replay|回放|reminisc|思い出/i;
    function recTest(names, ces) {
        const sw = new Set();
        (names || []).forEach((n, i) => { if (n && REC.test(n)) sw.add(i); });
        const ce = new Set((ces || []).filter((c) => c && REC.test(c.name || '')).map((c) => c.id));
        return (c) => (c.code === 121 && c.parameters[2] === 0 && sw.has(c.parameters[0])) || (c.code === 117 && ce.has(c.parameters[0]))
            || ((c.code === 356 || c.code === 357) && REC.test(JSON.stringify(c.parameters)));
    }
    // Сколько событий карты начинают воспоминание (страницы «по кнопке», «касанием»)
    const hubScore = (map, isRec) => ((map && map.events) || []).filter((ev) => ev && (ev.pages || []).some((pg) => pg && (pg.trigger || 0) <= 2
        && (pg.list || []).some((c) => c && isRec(c)))).length;
    // Второй признак — «зал сцен» («between memories» у Savior, «Warehouse» у GrandpasSaga, «Library» у Agent Vega,
    // «施術記録室» у Stained): не меньше SCENE_HALL_MIN событий по нажатию запускают сцену — сами показывают картинки
    // (две и больше), ролик или зовут общее событие с картинками, — это не меньше трети событий карты, и сцен, которые
    // начинаются сами (автозапуск, касание), почти нет: на сюжетных картах их много (у Mira's Potion Shop в городе — 31).
    // Отладочные, тестовые, склады событий, портреты, костюмы — не залы
    const SCENE_HALL_MIN = 12;
    const NOT_HALL = /debug|デバッグ|test|テスト|倉庫|storage|立[繪绘]|dresser|ドレッサー|カスタム|custom|装備|設定|template|テンプレ/i;
    const picCount = (list) => (list || []).filter((c) => c && c.code === 231).length;
    function hallTest(ces) {
        const sceneCe = new Set((ces || []).filter((c) => c && (picCount(c.list) >= 2 || (c.list || []).some((x) => x && x.code === 261))).map((c) => c.id));
        const launches = (list) => picCount(list) >= 2 || (list || []).some((c) => c && (c.code === 261 || (c.code === 117 && sceneCe.has(c.parameters[0]))));
        return (map, name) => {
            if (NOT_HALL.test(name || '')) return 0;
            const evs = ((map && map.events) || []).filter(Boolean);
            const byButton = evs.filter((ev) => (ev.pages || []).some((pg) => pg && !pg.trigger && launches(pg.list))).length;
            const bySelf = evs.filter((ev) => (ev.pages || []).some((pg) => pg && pg.trigger >= 1 && pg.trigger <= 3 && launches(pg.list))).length;
            return byButton >= SCENE_HALL_MIN && byButton * 3 >= evs.length && bySelf <= 1 ? byButton : 0;
        };
    }
    // Комнаты игры: по имени, если в них есть входы в сцены; иначе по устройству. maps — { id: карта } целиком
    function pickRooms({ infos = [], maps = {}, names = [], vnames = [], ces = [] } = {}) {
        const named = roomMaps(infos, ces);
        return roomLive(named, maps, ces, vnames) ? named : hubRooms({ infos, maps, names, ces });
    }
    // maps — { id: карта } целиком; ответ — карты-комнаты, главная первой: сначала по «воспоминанию», нет — залы сцен
    function hubRooms({ infos = [], maps = {}, names = [], ces = [] } = {}) {
        const isRec = recTest(names, ces);
        const pick = (score) => Object.entries(maps).map(([id, m]) => [Number(id), score(m, id)]).filter(([id, n]) => n > 0 && infos[id])
            .sort((a, b) => b[1] - a[1]).map(([id]) => infos[id]);
        const rec = pick((m) => { const n = hubScore(m, isRec); return n >= HUB_MIN ? n : 0; });
        if (rec.length) return rec;
        const hall = hallTest(ces);
        return pick((m, id) => hall(m, (infos[id] || {}).name));
    }

    // Общее событие «открыть всё», которое оставил автор («回想全开», «●回想全解放»): игра выставит всё сама. Имя — явно
    // про сцены (не «All Open Door Event»), и только у игры с комнатой или списком сцен; берём одно — первое
    const EVENT_ALL = /回想|【回】|recollect|memor|gallery|ギャラリー|シーン|scene|ｃｇ|\bcg\b/i;
    const allEvents = (ces) => (ces || []).filter((c) => c && c.list && c.list.length > 1 && isAll(plain(c.name)) && EVENT_ALL.test(plain(c.name)) && !isState(plain(c.name)))
        .slice(0, 1).map((c) => ({ id: c.id, name: plain(c.name) }));

    // Входы в сцены комнат: [{ map, ev, pages }]
    // Вход в два шага (Seven Keys, 480 входов): страница «по кнопке» спрашивает «смотреть?» и включает личный
    // переключатель A, а сцену играет страница с условием A на автозапуске. Вход — первая страница; включить A заранее —
    // значит запустить сцену сразу. stage — такие буквы: их включает одна страница, от них зависит страница со сценой
    function stagedSelfs(pages, ces) {
        const gated = new Set((pages || []).filter((pg) => pg && pg.conditions && pg.conditions.selfSwitchValid && hasSceneStart(pg.list, ces))
            .map((pg) => pg.conditions.selfSwitchCh));
        const stage = new Set();
        for (const pg of pages || []) for (const c of (pg && pg.list) || []) if (c && c.code === 123 && c.parameters[1] === 0 && gated.has(c.parameters[0])) stage.add(c.parameters[0]);
        return stage;
    }
    // Сцена по номеру: событие пишет в переменную «номер общего события для воспоминания» (nightmare-knight: «回想で呼ぶ
    // コモンイベント番号» = 257), а играет её общий механизм комнаты. ceVars — такие переменные (по имени)
    const CE_VAR = /コモン|common\s*event|イベント番号|\bce\s*(?:id|no|num)/i;
    const ceVarIds = (vnames) => new Set((vnames || []).map((n, i) => (n && CE_VAR.test(n) ? i : 0)).filter(Boolean));
    const ceByVar = (c, ceVars, ces) => !!(c && c.code === 122 && ceVars && ceVars.size && c.parameters[0] === c.parameters[1] && c.parameters[2] === 0
        && c.parameters[3] === 0 && ceVars.has(c.parameters[0]) && ces && ces[c.parameters[4]] && hasSceneStart(ces[c.parameters[4]].list, ces));
    const startsScene = (pg, e, ces) => !!e.only || hasSceneStart(pg.list, ces) || (pg.list || []).some((c) => ceByVar(c, e.ceVars, ces)) || (e.stage.size > 0 && (pg.list || []).some((c) => c && c.code === 123 && c.parameters[1] === 0 && e.stage.has(c.parameters[0])));
    // Страница за «готовящей» на автозапуске — не цель: включить её букву заранее значит запустить сцену сразу. «По
    // кнопке» — можно (Her Fall, Sword Art Online): сцена ждёт нажатия
    const behindStage = (pg, e) => !!(pg.conditions && pg.conditions.selfSwitchValid && e.stage.has(pg.conditions.selfSwitchCh)
        && (pg.trigger === 3 || pg.trigger === 4));
    // Вход — то, что запускает игрок: страница «по кнопке» или касанием, которая начинает сцену (сама или через свою букву).
    // События только на автозапуске («ReplayCheck» при «回想準備» у Tidecaller) — механика комнаты, не сцены
    // Дверь, выход, лестница, переход между залами комнаты — не сцена: страница только переносит, и туда, где комната,
    // или событие и названо как дверь
    // Латиница — целыми словами: «Flashback 3», «Background», «Doorman» — не двери
    const EXIT = /出入口|出口|入口|戻る|帰る|扉|ドア|階段|移動|ワープ/;
    const EXIT_WORDS = new Set(['exit', 'leave', 'return', 'back', 'entrance', 'door', 'doors', 'stairs', 'warp']);
    const isLeaving = (name) => EXIT.test(name || '') || latinWords(name).some((w) => EXIT_WORDS.has(w));
    const onlyMoves = (pg, e, ces, roomIds, name) => {
        const starts = (pg.list || []).filter((c) => c && (SCENE_START.has(c.code) || (c.code === 117 && ceHasStart(c.parameters[0], ces))
            || (c.code === 123 && c.parameters[1] === 0 && e.stage.has(c.parameters[0])) || ceByVar(c, e.ceVars, ces)));
        return starts.length > 0 && starts.every((c) => c.code === 201) && (isLeaving(name) || starts.every((c) => c.parameters[0] === 0 && roomIds.has(c.parameters[1])));
    };
    function roomEntries(rooms, maps, ces, vnames) {
        const out = [];
        const ceVars = ceVarIds(vnames);
        const roomIds = new Set(rooms.map((m) => m.id));
        for (const m of rooms) {
            for (const ev of (maps[m.id] && maps[m.id].events) || []) {
                if (!ev) continue;
                const e = { map: m.id, ev: ev.id, pages: ev.pages || [], stage: stagedSelfs(ev.pages, ces), ceVars };
                if (e.pages.some((pg) => pg && (pg.trigger || 0) <= 2 && startsScene(pg, e, ces) && !onlyMoves(pg, e, ces, roomIds, ev.name))) out.push(e);
            }
        }
        return out.concat(menuEntries(ces));
    }
    // Комната по имени живая, если в ней хоть что-то запускает сцену — даже автозапуск (dungeonwithknight: комната
    // открывает глоссарий CG плагина) — или есть меню воспоминаний. Иначе — пустая карта, ищем по устройству
    const roomLive = (rooms, maps, ces, vnames) => rooms.length > 0 && roomEntries(rooms, maps, ces, vnames).length > 0
        || rooms.some((m) => ((maps[m.id] && maps[m.id].events) || []).some((ev) => ev && (ev.pages || []).some((pg) => pg && hasSceneStart(pg.list, ces))));
    // Меню воспоминаний из картинок (Moon Witch: «回想復帰用» ставит картинки сцен и привязывает к каждой общее событие
    // сцены — PictureCallCommon «P_CALL_CE 10 366»): общее событие с «回想», «memory»… в имени, где не меньше трёх
    // привязок к общим событиям со сценой. Каждая привязка — вход: её держат ветвления меню перед ней
    const PIC_CALL = /(?:P_CALL_CE|ピクチャのボタン化)\s+\d+\s+(\d+)/i;
    function picCallTarget(c) {
        if (c.code === 356) { const m = PIC_CALL.exec(String(c.parameters[0])); return m ? Number(m[1]) : 0; }
        if (c.code === 357 && /PictureCallCommon/i.test(String(c.parameters[0]))) {
            const m = /"?commonEventId"?\s*[:=]\s*"?(\d+)/i.exec(JSON.stringify(c.parameters[3] || {}));
            return m ? Number(m[1]) : 0;
        }
        return 0;
    }
    const menuMemo = new WeakMap();
    // Меню: [{ ce, binds: [команда привязки] }], больше привязок — раньше
    function recMenus(ces) {
        if (!ces || typeof ces !== 'object') return [];
        if (menuMemo.has(ces)) return menuMemo.get(ces);
        const out = [];
        for (const c of ces) {
            if (!c || !REC.test(c.name || '')) continue;
            const binds = (c.list || []).filter((x) => { const t = x && picCallTarget(x); return t && ces[t] && hasSceneStart(ces[t].list, ces); });
            if (binds.length >= 3) out.push({ ce: c, binds });
        }
        out.sort((a, b) => b.binds.length - a.binds.length);
        menuMemo.set(ces, out);
        return out;
    }
    // Одна сцена — один вход, даже если её ставят несколько меню (у Moon Witch — «回想代表», «全開放)回想代表», «回想復帰用»)
    function menuEntries(ces) {
        const seen = new Set();
        const out = [];
        for (const { ce, binds } of recMenus(ces)) {
            const pages = [{ conditions: {}, trigger: 0, list: ce.list }];
            for (const only of binds) {
                const target = picCallTarget(only);
                if (seen.has(target)) continue;
                seen.add(target);
                out.push({ map: 0, ev: ce.id, pages, stage: new Set(), only });
            }
        }
        return out;
    }
    // Открыт ли вход: активная страница (старшая, чьи условия выполнены) доходит до сцены
    function entryOpen(e, st, ces) {
        const ctx = { map: e.map, ev: e.ev, stage: e.stage, only: e.only, ceVars: e.ceVars };
        for (let i = e.pages.length - 1; i >= 0; i--) {
            if (pageMeets(e.pages[i].conditions || {}, st, ctx)) return reachable(e.pages[i].list, st, ctx, ces);
        }
        return false;
    }

    // names / vnames — $dataSystem.switches / variables; infos — $dataMapInfos; maps — { id: карта } для комнат;
    // ces — $dataCommonEvents; lists — [{ title, switchId }] плагинов; params — «открыть всё» из параметров плагинов;
    // state — нынешнее состояние игры ({ sw(id), vr(id), self(key), item(kind, id) }), без него — новая игра.
    // Ответ: что включить (all — «открыть всё» автора, scenes — сцены), какие переменные поднять (vars), личные
    // переключатели событий комнаты (selfs), предметы (items) и сколько входов комнаты открыто сейчас и откроется
    // risky — что запускает события само (riskyConds): не трогаем
    function findScenes({ names = [], vnames = [], infos = [], maps = {}, ces = [], lists = [], params = [], state = null, risky = null, roomList = null } = {}) {
        const name = (id) => plain(names[id]);
        const vname = (id) => plain(vnames[id]);
        const danger = risky || { sw: new Set(), vr: new Set(), self: new Set() };
        const valid = (id) => Number.isInteger(id) && id > 0 && id < names.length && !danger.sw.has(id);
        const all = new Map();
        for (let id = 1; id < names.length; id++) if (valid(id) && isAll(name(id)) && !isState(name(id))) all.set(id, name(id));
        for (const id of params) if (valid(id) && !isState(name(id))) all.set(id, name(id));
        const scenes = new Map();
        for (const s of lists) if (valid(s.switchId) && !all.has(s.switchId)) scenes.set(s.switchId, plain(s.title) || name(s.switchId));
        const rooms = roomList || roomMaps(infos, ces);

        const base = state || { sw: () => false, vr: () => 0, self: () => false, item: () => false };
        const now = { sw: (id) => !!base.sw(id), vr: (id) => Number(base.vr(id)) || 0, self: (key) => !!base.self(key), item: (k, id) => !!base.item(k, id) };
        const vars = new Map();
        const selfs = new Set();
        const items = new Set();
        const st = {
            sw: (id) => all.has(id) || scenes.has(id) || now.sw(id),
            vr: (id) => Math.max(vars.has(id) ? vars.get(id) : -Infinity, now.vr(id)),
            self: (key) => selfs.has(key) || now.self(key),
            item: (kind, id) => items.has(`${kind}:${id}`) || now.item(kind, id),
        };
        const entries = roomEntries(rooms, maps, ces || [], vnames);
        // С какими числами в комнате сравнивают переменные («Если переменная = N»): в событиях комнаты и в их общих событиях
        const eqVals = new Map();
        const scanEq = (list, depth) => {
            for (const c of list || []) {
                if (!c) continue;
                if (c.code === 111 && c.parameters[0] === 1 && c.parameters[2] === 0 && c.parameters[4] === 0) {
                    if (!eqVals.has(c.parameters[1])) eqVals.set(c.parameters[1], new Set());
                    eqVals.get(c.parameters[1]).add(c.parameters[3]);
                }
                if (c.code === 117 && depth < 2 && ces && ces[c.parameters[0]]) scanEq(ces[c.parameters[0]].list, depth + 1);
            }
        };
        // Со всех событий комнаты, не только со входов: выбор сцены сравнивает и в событиях без сцены
        for (const m of rooms) for (const ev of (maps[m.id] && maps[m.id].events) || []) for (const pg of (ev && ev.pages) || []) scanEq(pg && pg.list, 0);
        for (const e of entries) if (!e.map) for (const pg of e.pages || []) scanEq(pg && pg.list, 0);
        const flagEq = (id, value) => eqVals.has(id) && eqVals.get(id).size === 1 && eqVals.get(id).has(value);
        const count = (s) => entries.filter((e) => entryOpen(e, s, ces || [])).length;
        const before = count(now);
        // Состояние не трогаем, даже если в имени есть «回想»: «回想中», «回想モード» — это «идёт воспоминание»
        const okSwitch = (id) => valid(id) && !isState(name(id));
        const okVar = (id) => Number.isInteger(id) && id > 0 && id < vnames.length && !isState(vname(id)) && !danger.vr.has(id);
        const doable = (req) => !req.impossible && (req.sw === undefined || okSwitch(req.sw)) && (req.vr === undefined || okVar(req.vr))
            && !(req.self && danger.self.has(req.self));
        const apply = (req) => {
            if (req.sw !== undefined) { if (st.sw(req.sw)) return false; scenes.set(req.sw, name(req.sw)); return true; }
            if (req.vr !== undefined) { if (st.vr(req.vr) >= req.min) return false; vars.set(req.vr, req.min); return true; }
            if (req.self) { if (selfs.has(req.self)) return false; selfs.add(req.self); return true; }
            if (req.item) { const k = req.item.join(':'); if (items.has(k)) return false; items.add(k); return true; }
            return false;
        };
        // По кругу, пока что-то меняется: открытое одним входом может понадобиться следующему. Для входа — один путь
        // к сцене, самый короткий из выполнимых целиком; невыполнимый (держит состояние, «= числу») не трогаем вовсе:
        // менять счётчики без толку нельзя
        for (let round = 0; round < 8; round++) {
            let changed = false;
            for (const e of entries) {
                if (entryOpen(e, st, ces || [])) continue;
                const ctx = { map: e.map, ev: e.ev, stage: e.stage, only: e.only, ceVars: e.ceVars, flagEq };
                let best = null;
                // Нужна старшая страница, которая запускает сцену: её условия и ветвления до сцены. Нет у неё выполнимого
                // пути — следующая ниже (вариант той же сцены)
                for (let i = e.pages.length - 1; i >= 0 && !best; i--) {
                    if (behindStage(e.pages[i], e) || !startsScene(e.pages[i], e, ces || [])) continue;
                    const pageNeed = [];
                    pageMeets(e.pages[i].conditions || {}, st, ctx, pageNeed);
                    for (const path of scenePaths(e.pages[i].list, st, ctx, ces || [], 0)) {
                        const all = [...pageNeed, ...path];
                        if (all.every(doable) && (!best || all.length < best.length)) best = all;
                    }
                }
                if (best) for (const req of best) if (apply(req)) changed = true;
            }
            if (!changed) break;
        }
        return {
            all: [...all].map(([id, n]) => ({ id, name: n })),
            scenes: [...scenes].map(([id, n]) => ({ id, name: n })),
            vars: [...vars].map(([id, value]) => ({ id, name: vname(id), value })),
            selfs: [...selfs],
            items: [...items].map((k) => { const [kind, id] = k.split(':').map(Number); return { kind, id }; }),
            events: rooms.length || lists.length ? allEvents(ces) : [],
            rooms: rooms.map((m) => plain(m.name)),
            count: { before, after: count(st), total: entries.length },
            // Какие входы так и остались закрытыми — для разбора («карта/событие»)
            closed: entries.filter((e) => !entryOpen(e, st, ces || [])).map((e) => `${e.map}/${e.ev}`),
        };
    }

    // Открыть сцены и не запустить игру саму: переключатели сцен бывают и условиями страниц «автозапуск» и «параллельно»
    // на других картах или запуском общих событий. У Clockwork Vale 2 это сюжетные «NTRend», «妈妈的审问4» (21 автозапуск
    // по дому и городу), у Ember & Frost — «Jen Animated» (38 параллельных анимаций); по всей библиотеке старый план
    // включал 1108 таких страниц. Что именно план включит — видно, только посчитав: страница становится активной, если
    // её условия выполнены, а у старших — нет. Каждое такое условие запрещаем и считаем план заново, пока лишнего нет.
    // allMaps — { id: карта } всех карт игры, state — как у findScenes
    function turnedOn(plan, allMaps, ces, state) {
        const base = state || { sw: () => false, vr: () => 0, self: () => false, item: () => false };
        const sw = new Set([...plan.all, ...plan.scenes].map((x) => x.id));
        const vr = new Map(plan.vars.map((v) => [v.id, v.value]));
        const selfs = new Set(plan.selfs);
        const items = new Set(plan.items.map((x) => `${x.kind}:${x.id}`));
        const at = (after) => ({
            sw: (id) => (after && sw.has(id)) || !!base.sw(id),
            vr: (id) => Math.max(after && vr.has(id) ? vr.get(id) : -Infinity, Number(base.vr(id)) || 0),
            self: (key) => (after && selfs.has(key)) || !!base.self(key),
            item: (kind, id) => (after && items.has(`${kind}:${id}`)) || !!base.item(kind, id),
        });
        const was = at(false);
        const now = at(true);
        const out = { sw: new Set(), vr: new Set(), self: new Set() };
        // Из условий страницы — то, что дал план
        const blame = (c, ctx) => {
            for (const [ok, id] of [[c.switch1Valid, c.switch1Id], [c.switch2Valid, c.switch2Id]]) if (ok && !was.sw(id)) out.sw.add(id);
            if (c.variableValid && was.vr(c.variableId) < c.variableValue) out.vr.add(c.variableId);
            const key = `${ctx.map},${ctx.ev},${c.selfSwitchCh}`;
            if (c.selfSwitchValid && !was.self(key)) out.self.add(key);
        };
        for (const c of ces || []) if (c && (c.trigger === 1 || c.trigger === 2) && c.switchId && !was.sw(c.switchId) && now.sw(c.switchId)) out.sw.add(c.switchId);
        for (const [id, m] of Object.entries(allMaps || {})) {
            for (const ev of (m && m.events) || []) {
                if (!ev || !ev.pages) continue;
                const ctx = { map: Number(id), ev: ev.id };
                const active = (s) => { for (let i = ev.pages.length - 1; i >= 0; i--) if (pageMeets(ev.pages[i].conditions || {}, s, ctx)) return i; return -1; };
                const a = active(now);
                if (a < 0 || a === active(was)) continue;
                const pg = ev.pages[a];
                if (pg.trigger === 3 || pg.trigger === 4) blame(pg.conditions || {}, ctx);
            }
        }
        return out;
    }
    function safeScenes(args, allMaps) {
        const risky = { sw: new Set(), vr: new Set(), self: new Set() };
        let plan = findScenes({ ...args, risky });
        for (let round = 0; round < 12; round++) {
            const t = turnedOn(plan, allMaps, args.ces, args.state);
            if (!t.sw.size && !t.vr.size && !t.self.size) return plan;
            for (const k of ['sw', 'vr', 'self']) for (const x of t[k]) risky[k].add(x);
            plan = findScenes({ ...args, risky });
        }
        // Не сошлось — осторожно: ничего из условий автозапуска и параллельных страниц вообще
        return findScenes({ ...args, risky: riskyConds(allMaps, args.ces) });
    }
    // Все условия страниц «автозапуск» и «параллельно» и переключатели запуска общих событий
    function riskyConds(maps, ces) {
        const r = { sw: new Set(), vr: new Set(), self: new Set() };
        for (const c of ces || []) if (c && (c.trigger === 1 || c.trigger === 2) && c.switchId) r.sw.add(c.switchId);
        for (const [id, m] of Object.entries(maps || {})) {
            for (const ev of (m && m.events) || []) {
                for (const pg of (ev && ev.pages) || []) {
                    if (!pg || (pg.trigger !== 3 && pg.trigger !== 4)) continue;
                    const c = pg.conditions || {};
                    if (c.switch1Valid) r.sw.add(c.switch1Id);
                    if (c.switch2Valid) r.sw.add(c.switch2Id);
                    if (c.variableValid) r.vr.add(c.variableId);
                    if (c.selfSwitchValid) r.self.add(`${id},${ev.id},${c.selfSwitchCh}`);
                }
            }
        }
        return r;
    }

    // ---- Вход в комнату воспоминаний ----
    // Как игры туда пускают (входы всех игр библиотеки с комнатой разобраны по их файлам): своё окно плагина (RecollectionMode, …MZ, …2,
    // TS_ReplayMode); общее событие «回想部屋に飛ぶ», «ギャラリー移動», «0_回想部屋に移動»; событие на карте — кристалл,
    // дверь, «回想部屋へ», «Recollection Crystal» (так у большинства); у пары игр — только телепорт с отладочной карты.
    // Идём своим путём игры: она сама спросит «пойти?» и выставит, что ей нужно. Нет пути — просто перенос в комнату
    const ENTRANCE = /回想|recollect|memor(?:y|ies)|gallery|ギャラリー|鑑賞/i;
    // Общее событие — только «переход в комнату» («回想部屋に飛ぶ», «ギャラリー移動», «回想部屋開始»): события с
    // «回想» в имени чаще всего — сама сцена («おもらし回想»), её запуск проиграл бы сцену
    const ENTRANCE_CE = /(?:回想|recollect|memor(?:y|ies)|gallery|ギャラリー).{0,6}(?:部屋|室|ルーム|room|hall|へ|に|移動|飛ぶ|入口|導入|ワープ|warp|開始)|^[\s\d_.:：・★☆■◆✨️]*(?:回想部屋|回想室|ギャラリー|gallery)/i;
    const NOT_ENTRANCE = /初期化|終了|戻る|復帰|出口|exit|leave|debug|デバッグ|テスト|test|体験版|trial/i;
    // Есть ли в списке (и в общих событиях, которые он зовёт) команда, подходящая под test
    function anyCmd(list, ces, test, depth = 0) {
        return (list || []).some((c) => c && (test(c) || (c.code === 117 && depth < MAX_DEPTH && ces && ces[c.parameters[0]]
            && anyCmd(ces[c.parameters[0]].list, ces, test, depth + 1))));
    }
    // Вход не показывает сцену сам: ни картинок, ни роликов, ни боя
    const showsScene = (list, ces) => anyCmd(list, ces, (c) => c.code === 231 || c.code === 261 || c.code === 301);
    // Вход сохраняет игру сам («SaveCommand save 1» у A Master Exorcist) — такой не запускаем: он затёр бы сейв игрока
    const SAVE = /save|セーブ/i;
    const savesGame = (list, ces) => anyCmd(list, ces, (c) => (c.code === 352)
        || ((c.code === 355 || c.code === 655 || c.code === 356 || c.code === 357) && SAVE.test(JSON.stringify(c.parameters))));
    // Перенос на карту комнаты в списке: [mapId, x, y, d] или null
    function transferInto(list, roomIds) {
        for (const cmd of list || []) if (cmd && cmd.code === 201 && cmd.parameters[0] === 0 && roomIds.has(cmd.parameters[1])) return cmd.parameters.slice(1, 5);
        return null;
    }
    // Пустит ли вход сейчас: ветвления «Если…» над переносом в комнату пропускают при нынешнем состоянии игры. У Me and
    // Dragon вход — «если комната открыта (переключатель 84) — пойти?, иначе „круг ещё не открыт“»: закрыт — переносим сами
    function entranceOpen(list, roomIds, st, ctx) {
        const stack = [];
        for (const cmd of list || []) {
            if (!cmd) continue;
            while (stack.length && cmd.indent <= stack[stack.length - 1].indent && !(cmd.code === 411 && cmd.indent === stack[stack.length - 1].indent)) stack.pop();
            if (cmd.code === 411 && stack.length && stack[stack.length - 1].indent === cmd.indent) { stack[stack.length - 1].inElse = true; continue; }
            if (cmd.code === 111) { stack.push({ indent: cmd.indent, p: cmd.parameters, inElse: false }); continue; }
            if (cmd.code !== 201 || cmd.parameters[0] !== 0 || !roomIds.has(cmd.parameters[1])) continue;
            if (stack.every((b) => { const v = check111(b.p, st, ctx); return v === null || v !== b.inElse; })) return true;
        }
        return false;
    }
    // ces, infos, rooms — как у findScenes; maps — { id: карта } для всех карт игры (что успели прочитать)
    function findRoomEntry({ infos = [], ces = [], rooms = [], maps = {} } = {}) {
        const roomIds = new Set(rooms.map((m) => m.id));
        if (!roomIds.size) return null;
        // 0) Меню воспоминаний из картинок, которое переносит в комнату: без него комната — пустая карта
        for (const { ce } of recMenus(ces)) {
            if (NOT_ENTRANCE.test(ce.name || '')) continue;
            const to = transferInto(ce.list, roomIds);
            if (to) return { kind: 'event', ce: ce.id, name: plain(ce.name), to, menu: true, saves: savesGame(ce.list, ces) };
        }
        // 1) Общее событие, которое переносит в комнату и называется как вход
        for (const c of ces || []) {
            if (!c || !ENTRANCE_CE.test(c.name || '') || NOT_ENTRANCE.test(c.name || '') || showsScene(c.list, ces)) continue;
            const to = transferInto(c.list, roomIds);
            if (to) return { kind: 'event', ce: c.id, name: plain(c.name), to, saves: savesGame(c.list, ces) };
        }
        // 2) Событие на карте с именем входа: сначала на обычных картах, потом на картах сцен (возврат после сцены)
        let best = null;
        const coords = new Map();
        for (const m of infos || []) {
            if (!m || roomIds.has(m.id) || !maps[m.id]) continue;
            const sceneMap = ENTRANCE.test(m.name || '');
            for (const ev of maps[m.id].events || []) {
                for (const pg of (ev && ev.pages) || []) {
                    const to = transferInto(pg.list, roomIds);
                    if (!to) continue;
                    const key = to.join(',');
                    if (to[1] || to[2]) coords.set(key, (coords.get(key) || 0) + 1);
                    const named = ENTRANCE.test(ev.name || '') && !NOT_ENTRANCE.test(ev.name || '') && !showsScene(pg.list, ces);
                    const rank = (named ? 2 : 0) + (sceneMap ? 0 : 1);
                    if (named && (!best || rank > best.rank)) best = { kind: 'event', list: pg.list, name: plain(ev.name), map: plain(m.name), to, saves: savesGame(pg.list, ces), rank };
                }
            }
        }
        if (best) { delete best.rank; return best; }
        // 3) Перенос туда, куда чаще всего переносят игра и сцены; ничего — середина главной комнаты
        const top = [...coords].sort((a, b) => b[1] - a[1])[0];
        if (top) return { kind: 'teleport', to: top[0].split(',').map(Number) };
        // Карта комнаты не прочиталась — не знаем, куда встать: лучше «не нашёл», чем в стену
        const main = rooms[0];
        const map = maps[main.id];
        return map ? { kind: 'teleport', to: [main.id, Math.floor(map.width / 2), Math.floor(map.height / 2), 2] } : null;
    }
    // Своё окно плагина комнаты — есть ли и как открыть
    function roomScene(win) {
        for (const name of ['Scene_Recollection', 'Scene_Replay']) if (typeof win[name] === 'function') return name;
        return '';
    }

    // Списки сцен плагинов комнаты: RecollectionMode (MV) держит их в глобальной переменной, RecollectionModeMZ
    // — в файле, имя которого в его параметрах (img/system/RecollectionModeMZData.json)
    function pluginScenes(win) {
        const lists = [];
        const params = [];
        try {
            const mv = win.rngd_recollection_mode_settings && win.rngd_recollection_mode_settings.rec_cg_set;
            for (const s of Object.values(mv || {})) if (s) lists.push({ title: s.title, switchId: Number(s.switch_id) });
            for (const p of win.$plugins || []) {
                if (!p || !p.status) continue;
                const prm = p.parameters || {};
                if (p.name === 'RecollectionModeMZ' && Array.isArray(win[prm.recoCgSettingList])) {
                    for (const s of win[prm.recoCgSettingList]) if (s) lists.push({ title: s.title, switchId: Number(s.switch_id) });
                }
                // RecollectionMode2 — тот же список, но в параметре плагина: массив строк JSON
                if (/^RecollectionMode2/.test(p.name) && prm.Recollections) {
                    for (const raw of JSON.parse(prm.Recollections) || []) {
                        const sc = typeof raw === 'string' ? JSON.parse(raw) : raw;
                        if (sc && sc.switch_id) lists.push({ title: sc.title, switchId: Number(sc.switch_id) });
                    }
                }
                // «Открыть всё» в параметрах плагинов (allUnlockSwitchId) и «открыть комнату» у TitleRecollectionCommand.
                // Просто «recollection… switch» — нет: так называют и «идёт回想» (Sky Knight Serena)
                for (const [k, v] of Object.entries(prm)) {
                    const id = String(v).trim();
                    if (!/^\d+$/.test(id)) continue;
                    if (/all.?unlock|unlock.?all/i.test(k) || (p.name === 'TitleRecollectionCommand' && k === 'recollectionSwitchId')) params.push(Number(id));
                }
            }
        } catch (e) { /* чужой формат — без плагинов */ }
        return { lists, params };
    }

    // Карты комнат — файлами игры (data/MapNNN.json рядом со страницей); не больше 40 (у Labyrinth of Subjugation их 19).
    // Состояние — нынешней игры: что уже открыто, решатель не трогает
    const gameState = () => ({
        sw: (id) => $gameSwitches.value(id),
        vr: (id) => $gameVariables.value(id),
        self: (key) => $gameSelfSwitches.value(key.split(',').map((x, i) => (i < 2 ? Number(x) : x))),
        item: (kind, id) => {
            const data = kind === 8 ? $dataItems : kind === 9 ? $dataWeapons : $dataArmors;
            return !!(data && data[id] && $gameParty.hasItem(data[id], true));
        },
    });
    // Все карты игры — один раз за открытие страницы, по восемь за раз (у Labyrinth of Subjugation их 583, 25 МБ:
    // пара секунд, дальше браузер берёт из кэша). Держим не всё: карты комнат — целиком, у остальных — условия и
    // запуск страниц (что запустится само) и команды страниц с переносом (входы в комнату). Часть карт не прочиталась —
    // ответ не запоминаем: что запустится само на непрочитанной карте, не знаем. Нет файла (404) или он битый — карты нет
    // и в игре (движок её тоже не откроет); больше MAX_MAPS — хвост не прочитан
    const MAX_MAPS = 2000;
    let scan = null;
    // Пауза между пачками карт: «Ещё не видели» читает их фоном, пока человек играет, — не подряд (roomStatus)
    let scanPace = 0;
    const scanAt = { done: 0, total: 0 };
    // pace — фоном («Ещё не видели»): по карте с паузой. Без него (чит-меню) — подряд; начатое фоном чтение тоже
    // ускоряется, а не ждёт своего медленного хода
    function scanMaps(pace = 0) {
        if (!pace) scanPace = 0;
        else if (!scan) scanPace = pace;
        if (!scan) {
            scan = readMaps().then((r) => { if (r.failed) scan = null; return r; }, (e) => { scan = null; throw e; })
                .finally(() => { scanPace = 0; });
        }
        return scan;
    }
    async function readMaps() {
        const infos = (typeof $dataMapInfos !== 'undefined' && $dataMapInfos) || [];
        const ces = (typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents) || [];
        const named = roomMaps(infos, ces);
        const roomIds = new Set(named.map((m) => m.id));
        // Комнаты по имени нет — ищем по устройству: такие карты держим целиком
        // Признаки устройства считаем всегда: комната по имени бывает пустой («回想部屋» без событий у Mira — настоящие
        // «Product Version 'Other' Room» и соседние)
        const isRec = recTest((typeof $dataSystem !== 'undefined' && $dataSystem && $dataSystem.switches) || [], ces);
        const hall = hallTest(ces);
        const hubs = [];
        const halls = [];
        const slim = (d) => ({ width: d.width, height: d.height, events: (d.events || []).map((ev) => ev && { id: ev.id, name: ev.name,
            pages: (ev.pages || []).map((pg) => pg && { conditions: pg.conditions, trigger: pg.trigger, list: (pg.list || []).some((c) => c && c.code === 201) ? pg.list : [] }) }) });
        const all = infos.filter(Boolean).map((m) => m.id);
        const ids = all.slice(0, MAX_MAPS);
        const maps = {};
        let failed = all.length - ids.length;
        scanAt.done = 0;
        scanAt.total = ids.length;
        // Фоном (scanPace) — по одной карте: большие карты разбираются долго, восемь подряд останавливали игру на секунды.
        // Шаг — заново на каждом круге: открыли чит-меню посреди фонового чтения — дальше подряд
        for (let i = 0, step = 8; i < ids.length; i += step) {
            step = scanPace ? 1 : 8;
            await Promise.all(ids.slice(i, i + step).map((id) => fetch(`data/Map${String(id).padStart(3, '0')}.json`)
                .then((r) => { if (r.status === 404) return ''; if (!r.ok) throw new Error(String(r.status)); return r.text(); })
                .then((text) => {
                    let d = null;
                    try { d = text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; } catch (e) { d = null; }
                    if (!d) return;
                    const hub = isRec ? hubScore(d, isRec) : 0;
                    if (hub >= HUB_MIN) hubs.push([id, hub]);
                    const hallN = hall ? hall(d, (infos[id] || {}).name) : 0;
                    if (hallN) halls.push([id, hallN]);
                    maps[id] = roomIds.has(id) || hub >= HUB_MIN || hallN ? d : slim(d);
                }).catch(() => { failed++; })));
            scanAt.done = Math.min(i + step, ids.length);
            if (scanPace) await new Promise((r) => setTimeout(r, scanPace));
            scanTick();
        }
        const best = (list) => list.sort((a, b) => b[1] - a[1]).map(([id]) => infos[id]).filter(Boolean);
        const vnames = (typeof $dataSystem !== 'undefined' && $dataSystem && $dataSystem.variables) || [];
        const rooms = roomLive(named, maps, ces, vnames) ? named : hubs.length ? best(hubs) : best(halls);
        return { maps, failed, rooms };
    }
    // Счётчик «прочитано карт» — во всех подписях ._ch_scan панели (у маленьких игр не нужен)
    function scanTick() {
        if (!root) return;
        for (const n of root.querySelectorAll('._ch_scan')) n.textContent = scanAt.total > 40 ? ` ${scanAt.done} / ${scanAt.total}` : '';
    }
    async function loadScenes(win) {
        const infos = (typeof $dataMapInfos !== 'undefined' && $dataMapInfos) || [];
        const ces = (typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents) || [];
        const { maps, failed, rooms } = await scanMaps();
        if (failed) throw new Error('maps');
        const plug = pluginScenes(win);
        const args = { names: $dataSystem.switches, vnames: $dataSystem.variables, infos, maps, ces, ...plug, state: gameState(), roomList: rooms };
        const safe = safeScenes(args, maps);
        // Сцены, которые держит сюжет (у Clockwork Vale 2 — 17 из 111): открыть можно, но только отдельной кнопкой и с откатом
        const raw = findScenes(args);
        if (raw.count.after > safe.count.after) safe.story = raw;
        safe.sys = $gameSystem;   // для какой игры считали: загрузили другой сейв — план уже не тот
        return safe;
    }

    // Вход в комнату в этой игре: своё окно плагина — сразу; общее событие-вход — без чтения карт; иначе читаем все
    // карты игры (scanMaps) и ищем событие-вход. Ответ запоминаем до перезагрузки страницы
    // Помним обещание, а не ответ: второе нажатие во время поиска не читает карты заново. Часть карт не прочиталась
    // (сеть моргнула) — ответ не запоминаем: в следующий раз прочитаем снова
    let roomEntry = null;
    function loadRoomEntry(win) {
        if (!roomEntry) roomEntry = findRoomEntryIn(win).then((r) => { if (!r.complete) roomEntry = null; return r.entry; }, (e) => { roomEntry = null; throw e; });
        return roomEntry;
    }
    async function findRoomEntryIn(win) {
        const scene = roomScene(win);
        if (scene) return { entry: { kind: 'scene', scene }, complete: true };
        const infos = (typeof $dataMapInfos !== 'undefined' && $dataMapInfos) || [];
        const ces = (typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents) || [];
        // Сначала карты (их уже прочитала вкладка «Сцены»): комната по имени бывает пустой, настоящая — по устройству
        const { maps, failed, rooms } = await scanMaps();
        if (!rooms.length) return { entry: null, complete: !failed };
        return { entry: findRoomEntry({ infos, ces, rooms, maps }), complete: !failed };
    }
    // Можно идти: на карте, не в переносе и не в событии (окно плагина поверх боя или меню — тоже нельзя)
    const canGo = () => SceneManager._scene instanceof Scene_Map && !$gamePlayer.isTransferring() && !$gameMap.isEventRunning();
    // Перейти: окно плагина, общее событие, команды события-входа (игра спросит сама) или перенос — и когда вход игры
    // сейчас закрыт (комнату ещё не открыли по сюжету) или сам сохраняет игру
    function goRoom(entry, st = gameState()) {
        if (!canGo()) return false;
        if (entry.kind === 'scene') { SceneManager.push(window[entry.scene]); return true; }
        const roomIds = new Set([entry.to[0]]);
        // Команды входа идут с событием 0, как у общего: его личные переключатели — не того события, считаем выключенными
        const ctx = { map: $gameMap.mapId(), ev: 0 };
        const ce = !entry.saves && entry.ce && $dataCommonEvents[entry.ce];
        if (ce && (entry.menu || entranceOpen(ce.list, roomIds, st, ctx))) $gameTemp.reserveCommonEvent(entry.ce);
        else if (!entry.saves && entry.list && entranceOpen(entry.list, roomIds, st, ctx)) $gameMap._interpreter.setup(entry.list, 0);
        else $gamePlayer.reserveTransfer(entry.to[0], entry.to[1], entry.to[2], entry.to[3] || 2, 0);
        return true;
    }

    // Свои «открыть всё» у плагинов галерей: TS_ReplayMode (Clockwork Vale) — отладочные ReplayAllOpen и CGAllOpen;
    // KNS_Gallery (MoonPri) — прогресс каждой сцены до предела. Ответ — что сработало
    function pluginUnlock(win) {
        const done = [];
        try { if (typeof win.ReplayAllOpen === 'function') { win.ReplayAllOpen(); done.push('ReplayAllOpen'); } } catch (e) { /* не вышло — без него */ }
        try { if (typeof win.CGAllOpen === 'function') { win.CGAllOpen(); done.push('CGAllOpen'); } } catch (e) { /* не вышло — без него */ }
        try {
            const kns = win.KNS_Gallery;
            const list = win.$csvGalleryList;
            if (kns && typeof kns.setProgress === 'function' && list) {
                for (const chara of Object.keys(list)) for (const scene of Object.keys(list[chara] || {})) kns.setProgress(chara, scene, kns.maxProgress || 99);
                done.push('KNS_Gallery');
            }
        } catch (e) { /* не вышло — без него */ }
        return done;
    }

    // Запомненные места — на эту игру, в браузере
    const placesKey = () => `rpgCheatsPlaces_${(window.__RPG && window.__RPG.id) || location.pathname}`;
    const loadPlaces = () => { try { return JSON.parse(localStorage.getItem(placesKey()) || '[]') || []; } catch (e) { return []; } };
    const savePlaces = (list) => { try { localStorage.setItem(placesKey(), JSON.stringify(list)); } catch (e) { /* без хранилища — до перезапуска */ } };

    // ------------------------------------------------------------------------------------------------------------
    // Панель
    const CSS = `
        #_cheats { position: fixed; z-index: 2147483647; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right));
            width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); display: flex; flex-direction: column;
            border-radius: 12px; background: rgba(19,17,26,0.97); border: 1px solid rgba(201,168,76,0.3); box-shadow: 0 12px 32px rgba(0,0,0,0.55);
            color: #e8dfc8; font: 500 14px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif;
            touch-action: pan-y; -webkit-user-select: none; user-select: none; }
        #_cheats * { box-sizing: border-box; }
        #_cheats ._ch_head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 6px; }
        #_cheats ._ch_title { color: #d9b45e; font-weight: 600; font-size: 15px; letter-spacing: .02em; }
        #_cheats ._ch_x { width: 32px; height: 32px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.18); background: transparent; color: inherit; font-size: 18px; line-height: 1; cursor: pointer; }
        #_cheats ._ch_tabs, #_cheats ._ch_chips { display: flex; gap: 6px; flex-wrap: wrap; }
        #_cheats ._ch_tabs { padding: 0 12px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        #_cheats ._ch_body { overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 12px; }
        #_cheats ._ch_chip, #_cheats ._ch_btn { min-height: 32px; padding: 5px 11px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18); background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
        #_cheats ._ch_chip._on { border-color: #d9b45e; color: #d9b45e; background: rgba(217,180,94,0.1); }
        #_cheats ._ch_btn { border-radius: 9px; border-color: rgba(217,180,94,0.45); }
        #_cheats ._ch_btn:disabled { opacity: .4; cursor: default; }
        #_cheats ._ch_btn:active:not(:disabled), #_cheats ._ch_chip:active { background: rgba(217,180,94,0.18); }
        #_cheats ._ch_sec { display: flex; flex-direction: column; gap: 6px; }
        #_cheats ._ch_label { color: rgba(255,255,255,0.55); font-size: 12px; text-transform: none; }
        #_cheats ._ch_row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        #_cheats ._ch_grow { flex: 1 1 auto; min-width: 0; }
        #_cheats ._ch_dim { color: rgba(255,255,255,0.55); font-size: 12px; }
        #_cheats ._ch_facts { display: flex; flex-wrap: wrap; gap: 0 12px; }
        #_cheats ._ch_val { min-width: 48px; text-align: center; font-variant-numeric: tabular-nums; }
        #_cheats input[type=text], #_cheats input[type=number], #_cheats select { min-height: 32px; padding: 5px 8px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.18);
            background: rgba(0,0,0,0.35); color: inherit; font: inherit; -webkit-user-select: text; user-select: text; min-width: 0; }
        #_cheats input:focus, #_cheats select:focus { outline: none; border-color: #d9b45e; }
        #_cheats ._ch_toggle { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
        #_cheats ._ch_toggle { justify-content: space-between; gap: 12px; }
        /* Тот же переключатель, что и в меню игры и в Настройках библиотеки: 44×24, золотая рамка */
        #_cheats ._ch_sw { position: relative; flex-shrink: 0; box-sizing: border-box; width: 44px; height: 24px; border-radius: 999px; background: rgba(255,255,255,0.12); border: 1px solid rgba(201,168,76,0.3); }
        #_cheats ._ch_sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #8f8470; transition: transform .15s; }
        #_cheats ._ch_toggle._on ._ch_sw { background: #7a6030; border-color: #c9a84c; }
        #_cheats ._ch_toggle._on ._ch_sw::after { transform: translateX(20px); background: #f0d080; }
        /* Длинные списки (переменные-переключатели, сцены): квадратная галочка слева, 44px-переключатель на каждой строке слишком крупный */
        #_cheats ._ch_toggle._sq { justify-content: flex-start; }
        #_cheats ._ch_toggle._sq ._ch_sw { width: 18px; height: 18px; border-radius: 4px; border-color: rgba(201,168,76,0.55); background: rgba(19,17,26,0.6); }
        #_cheats ._ch_toggle._sq ._ch_sw::after { display: none; }
        #_cheats ._ch_toggle._sq._on ._ch_sw { background: #7a6030; border-color: #c9a84c; }
        #_cheats ._ch_toggle._sq._on ._ch_sw::after { display: block; left: 5px; top: 1px; width: 5px; height: 10px; border-radius: 0; background: transparent; border: solid #f0d080; border-width: 0 2px 2px 0; transform: rotate(45deg); }
        /* Цвета библиотеки: заголовок, закрытие, чипы и кнопки золотом; вкладки — с подчёркиванием, как разделы галереи */
        #_cheats ._ch_title { color: #f0d080; font-size: 16px; letter-spacing: 0; }
        #_cheats ._ch_x { border-radius: 6px; border-color: rgba(201,168,76,0.3); color: #8f8470; }
        #_cheats ._ch_chip, #_cheats ._ch_chip._on { border-color: rgba(201,168,76,0.25); }
        #_cheats ._ch_chip._on { border-color: #c9a84c; color: #f0d080; background: rgba(201,168,76,0.12); }
        #_cheats ._ch_btn { border-radius: 6px; border-color: rgba(201,168,76,0.45); color: #f0d080; }
        #_cheats ._ch_btn:active:not(:disabled), #_cheats ._ch_chip:active { background: rgba(201,168,76,0.18); }
        #_cheats ._ch_tabs { gap: 16px; padding: 0 14px; border-bottom-color: rgba(201,168,76,0.18); flex-wrap: nowrap; overflow-x: auto; }
        #_cheats ._ch_tabs ._ch_chip { min-height: 0; padding: 8px 0 9px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; margin-bottom: -1px; color: #8f8470; background: transparent; }
        #_cheats ._ch_tabs ._ch_chip._on { color: #f0d080; border-bottom-color: #c9a84c; background: transparent; }
        #_cheats ._ch_label, #_cheats ._ch_dim { color: #8f8470; }
        #_cheats ._ch_note { color: #c9a84c; }
        #_cheats input[type=text], #_cheats input[type=number], #_cheats select { border-color: rgba(201,168,76,0.3); border-radius: 6px; }
        #_cheats input:focus, #_cheats select:focus { border-color: #c9a84c; }
        #_cheats ._ch_list { display: flex; flex-direction: column; gap: 2px; }
        #_cheats ._ch_item { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        #_cheats ._ch_item ._ch_btn { min-height: 28px; padding: 3px 9px; }
        #_cheats ._ch_item input { width: 96px; }
        #_cheats ._ch_note { color: #d9b45e; font-size: 12px; min-height: 16px; padding: 0 12px 8px; }
        @media (max-height: 500px) { #_cheats { width: min(460px, calc(100vw - 24px)); } }
    `;

    let root = null;
    let body = null;
    let note = null;
    let tab = 'party';
    const state = { actor: 0, param: 0, step: 10, goldStep: 1000, itemKind: 'items', itemQuery: '', varKind: 'vars', varQuery: '', expStep: 1000 };

    const el = (tag, props = {}, kids = []) => {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
        }
        for (const kid of [].concat(kids)) if (kid) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
        return node;
    };
    // Подпись, которая не гаснет сама (пока идёт поиск)
    const hold = (kids) => {
        if (!note) return;
        clearTimeout(flash.t);
        note.textContent = '';
        for (const kid of [].concat(kids)) if (kid) note.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    };
    const flash = (msg) => {
        if (!note) return;
        note.textContent = msg;
        clearTimeout(flash.t);
        // Длинную подсказку («сохранись…») — дольше: её надо успеть прочитать
        flash.t = setTimeout(() => { if (note) note.textContent = ''; }, Math.max(2500, String(msg).length * 60));
    };
    // Действие → перерисовать вкладку и показать «Готово» (или ошибку — в игре бывает всякое)
    const act = (fn, msg = T.done) => () => {
        try { fn(); flash(msg); } catch (e) { flash(String(e && e.message || e)); }
        render();
    };
    const btn = (label, fn, opts = {}) => el('button', { type: 'button', class: '_ch_btn', disabled: opts.disabled, title: opts.title, onclick: act(fn, opts.msg) }, label);
    const chips = (items, current, onPick) => el('div', { class: '_ch_chips' }, items.map(([key, label]) =>
        el('button', { type: 'button', class: `_ch_chip${key === current ? ' _on' : ''}`, onclick: () => { onPick(key); render(); } }, label)));
    // square — для длинных списков: квадратная галочка слева вместо переключателя справа
    const toggle = (label, on, fn, hint, square) => el('button', { type: 'button', class: `_ch_toggle${on ? ' _on' : ''}${square ? ' _sq' : ''}`, title: hint, onclick: act(() => fn(!on)) },
        square ? [el('span', { class: '_ch_sw' }), el('span', { class: '_ch_grow' }, label)] : [el('span', { class: '_ch_grow' }, label), el('span', { class: '_ch_sw' })]);
    // Числа, которые меняет сама игра (HP, деньги), — обновляются на месте, без перерисовки вкладки: перерисовка
    // между касанием и отпусканием пальца съела бы нажатие кнопки
    let lives = [];
    // Строка фактов («Уровень 1», «HP 450/450»): массив — каждый факт своим словом с промежутком, без точек между ними
    const paint = (node, v) => {
        if (!Array.isArray(v)) { node.textContent = v; return; }
        node.textContent = '';
        for (const x of v) node.appendChild(el('span', {}, x));
    };
    const live = (node, text) => { paint(node, text()); lives.push([node, text]); return node; };
    const section = (label, kids) => el('div', { class: '_ch_sec' }, [label ? el('div', { class: '_ch_label' }, label) : null, ...kids]);
    const row = (kids) => el('div', { class: '_ch_row' }, kids);

    function partyTab() {
        const members = $gameParty.members();
        const actor = members[Math.min(state.actor, members.length - 1)];
        const out = [];
        out.push(chips(members.map((a, i) => [i, plain(a.name()) || `#${a.actorId()}`]), members.indexOf(actor), (i) => { state.actor = i; }));
        out.push(live(el('div', { class: '_ch_dim _ch_facts' }), () => [`${T.level} ${actor.level}`, `HP ${actor.hp}/${actor.mhp}`, `MP ${actor.mp}/${actor.mmp}`]));
        const allGod = members.every((a) => actions.isGod(a));
        out.push(section(null, [
            toggle(`${T.god}: ${plain(actor.name())}`, actions.isGod(actor), (on) => actions.setGod(actor, on), T.god_hint),
            toggle(T.god_all, allGod, (on) => members.forEach((a) => actions.setGod(a, on)), T.god_hint),
            row([btn(T.heal, actions.heal), btn(T.clear_states, actions.clearStates)]),
        ]));
        out.push(section(T.level, [row([btn('−1', () => actions.level(actor, -1)), el('span', { class: '_ch_val' }, String(actor.level)), btn('+1', () => actions.level(actor, 1)), btn('+10', () => actions.level(actor, 10))])]));
        out.push(section(T.exp, [row([
            chips([100, 1000, 10000].map((v) => [v, num(v)]), state.expStep, (v) => { state.expStep = v; }),
            btn(`+${num(state.expStep)}`, () => actions.exp(actor, state.expStep)),
        ])]));
        const select = el('select', { onchange: (e) => { state.param = Number(e.target.value); render(); } },
            T.params.map((p, i) => el('option', { value: i, selected: i === state.param }, `${p}: ${actor.param(i)}`)));
        out.push(section(T.stats, [
            row([select]),
            row([chips([[1, '1'], [10, '10'], [100, '100']], state.step, (v) => { state.step = v; }),
                btn(`−${state.step}`, () => actions.param(actor, state.param, -state.step)), btn(`+${state.step}`, () => actions.param(actor, state.param, state.step))]),
        ]));
        out.push(section(null, [live(el('div', { class: '_ch_label' }), () => `${T.gold}: ${num($gameParty.gold())}`), row([
            chips([100, 1000, 100000].map((v) => [v, num(v)]), state.goldStep, (v) => { state.goldStep = v; }),
            btn(`−${num(state.goldStep)}`, () => actions.gold(-state.goldStep)), btn(`+${num(state.goldStep)}`, () => actions.gold(state.goldStep)),
        ])]));
        return out;
    }

    // Поле поиска: перерисовываем только список под ним, иначе поле теряло бы фокус на каждой букве
    function searchList(value, onInput, fill) {
        const list = el('div', { class: '_ch_list' });
        const input = el('input', { type: 'text', value, placeholder: T.search, 'aria-label': T.search, enterkeyhint: 'search',
            oninput: (e) => { onInput(e.target.value); list.replaceChildren(...fill()); } });
        list.replaceChildren(...fill());
        return [input, list];
    }
    const matches = (query, id, name) => {
        const q = query.trim().toLowerCase();
        return !q || String(id) === q || name.toLowerCase().includes(q);
    };
    const LIMIT = 60;

    function itemsTab() {
        const data = { items: typeof $dataItems !== 'undefined' ? $dataItems : [], weapons: typeof $dataWeapons !== 'undefined' ? $dataWeapons : [], armors: typeof $dataArmors !== 'undefined' ? $dataArmors : [] };
        const fill = () => {
            const found = (data[state.itemKind] || []).filter((it) => it && plain(it.name) && matches(state.itemQuery, it.id, plain(it.name)));
            if (!found.length) return [el('div', { class: '_ch_dim' }, T.nothing)];
            const rows = found.slice(0, LIMIT).map((it) => {
                const count = el('span', { class: '_ch_dim' }, `${T.have} ${$gameParty.numItems(it)}`);
                const give = (n) => el('button', { type: 'button', class: '_ch_btn', onclick: () => {
                    try { actions.give(it, n); count.textContent = `${T.have} ${$gameParty.numItems(it)}`; flash(T.done); } catch (e) { flash(String(e.message || e)); }
                } }, n > 0 ? `+${n}` : String(n));
                return el('div', { class: '_ch_item' }, [el('span', { class: '_ch_grow' }, `${it.id}. ${plain(it.name)}`), count, give(-1), give(1), give(10)]);
            });
            if (found.length > LIMIT) rows.push(el('div', { class: '_ch_dim' }, T.more(found.length - LIMIT)));
            return rows;
        };
        return [chips([['items', T.kind_items], ['weapons', T.kind_weapons], ['armors', T.kind_armors]], state.itemKind, (k) => { state.itemKind = k; }),
            ...searchList(state.itemQuery, (v) => { state.itemQuery = v; }, fill)];
    }

    function varsTab() {
        const names = state.varKind === 'vars' ? $dataSystem.variables : $dataSystem.switches;
        const fill = () => {
            const found = [];
            for (let id = 1; id < (names || []).length; id++) {
                const name = plain(names[id]);
                if ((name || state.varQuery.trim()) && matches(state.varQuery, id, name)) found.push([id, name]);
            }
            if (!found.length) return [el('div', { class: '_ch_dim' }, T.nothing)];
            const rows = found.slice(0, LIMIT).map(([id, name]) => {
                if (state.varKind === 'switches') {
                    return el('div', { class: '_ch_item' }, [toggle(`${id}. ${name || '—'}`, !!$gameSwitches.value(id), () => actions.toggleSwitch(id), null, true)]);
                }
                const label = el('span', { class: '_ch_grow' }, `${id}. ${name || '—'}`);
                const input = el('input', { type: 'text', value: String($gameVariables.value(id)), 'aria-label': `${id}. ${name}`,
                    onchange: (e) => { try { actions.setVariable(id, e.target.value); flash(T.done); } catch (err) { flash(String(err.message || err)); } },
                    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
                return el('div', { class: '_ch_item' }, [label, input]);
            });
            if (found.length > LIMIT) rows.push(el('div', { class: '_ch_dim' }, T.more(found.length - LIMIT)));
            return rows;
        };
        return [chips([['vars', T.kind_vars], ['switches', T.kind_switches]], state.varKind, (k) => { state.varKind = k; state.varQuery = ''; }),
            ...searchList(state.varQuery, (v) => { state.varQuery = v; }, fill)];
    }

    function worldTab() {
        const out = [];
        const speed = mode.speed || ($gamePlayer && $gamePlayer.moveSpeed ? $gamePlayer.moveSpeed() : 4);
        out.push(section(`${T.speed}: ${num(speed)}`, [
            chips([[3, '3'], [4, '4'], [5, '5'], [6, '6']], speed, (v) => actions.speed(v)),
            toggle(T.speed_lock, mode.lockSpeed, (on) => { if (on && !mode.speed) actions.speed(speed); actions.lockSpeed(on); }),
        ]));
        out.push(section(null, [toggle(T.noclip, mode.noclip, actions.noclip), toggle(T.no_encounters, mode.noEncounters, actions.noEncounters)]));
        const inBattle = $gameParty.inBattle();
        out.push(section(T.battle, [row([btn(T.win, actions.win, { disabled: !inBattle }), btn(T.enemy_one, actions.enemiesToOne, { disabled: !inBattle }),
            inBattle ? null : el('span', { class: '_ch_dim' }, T.not_in_battle)])]));
        // Телепорт: карта по названию, клетка — по умолчанию та, где стоит герой
        const onMap = typeof SceneManager !== 'undefined' && typeof Scene_Map !== 'undefined' && SceneManager._scene instanceof Scene_Map;
        const infos = (typeof $dataMapInfos !== 'undefined' ? $dataMapInfos : []).filter(Boolean);
        const mapName = (id) => { const m = infos.find((x) => x.id === id); return m ? plain(m.name) : `#${id}`; };
        const here = $gameMap.mapId();
        const mapSel = el('select', { 'aria-label': T.map, class: '_ch_grow' }, infos.map((m) => el('option', { value: m.id, selected: m.id === here }, `${m.id}. ${plain(m.name)}`)));
        const xIn = el('input', { type: 'number', value: $gamePlayer.x, min: 0, 'aria-label': 'X', style: 'width: 64px' });
        const yIn = el('input', { type: 'number', value: $gamePlayer.y, min: 0, 'aria-label': 'Y', style: 'width: 64px' });
        out.push(section(T.teleport, [row([mapSel]), row([xIn, yIn, btn(T.go, () => { actions.teleport(Number(mapSel.value), Number(xIn.value) || 0, Number(yIn.value) || 0); close(); },
            { disabled: !onMap || !infos.length, title: onMap ? '' : T.only_map })])]));
        const places = loadPlaces();
        out.push(section(T.places, [0, 1, 2].map((i) => {
            const p = places[i];
            return row([el('span', { class: '_ch_grow _ch_dim' }, p ? `${mapName(p.m)} (${p.x}, ${p.y})` : T.empty_slot),
                btn(T.remember, () => { const list = loadPlaces(); list[i] = { m: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y }; savePlaces(list); }, { disabled: !onMap }),
                btn(T.recall, () => { actions.teleport(p.m, p.x, p.y); close(); }, { disabled: !p || !onMap, title: onMap ? '' : T.only_map })]);
        })));
        return out;
    }

    // Сцены считаются при каждом заходе на вкладку (игра могла уйти вперёд); карты комнат браузер уже держит в кэше.
    // Общее событие «открыть всё» и «открыть всё» галереи плагина — один раз за открытие игры
    let scenesFound = null;
    let scenesLoading = false;
    let scenesBonusFor = null;   // $gameSystem той игры, где уже запускали; загрузили другой сейв — снова можно
    // Момент «До открытия сцен» не запомнился — открыть можно, но только вторым нажатием (время первого)
    let scenesNoMomentAt = 0;
    let roomNoMomentAt = 0;
    let roomGoing = false;
    let openGen = 0;     // растёт при каждом закрытии панели: начатое до него — отменено
    let closeTimer = 0;
    let openedAt = 0;    // когда открыли панель: щелчки первые 0,35 с — не нам (см. build)
    function scenesTab() {
        if (!scenesFound) {
            if (!scenesLoading) {
                scenesLoading = true;
                loadScenes(window).then((r) => { scenesFound = r; }, () => { scenesFound = { failed: true }; })
                    .then(() => { scenesLoading = false; if (tab === 'scenes') render(); });
            }
            return [el('div', { class: '_ch_dim' }, [T.scenes_loading, el('span', { class: '_ch_scan' })])];
        }
        // Не все карты прочитались — не открываем: не знаем, что запустится само. Следующий заход на вкладку — заново
        if (scenesFound.failed) { scenesFound = null; return [el('div', { class: '_ch_dim' }, T.scenes_maps_failed)]; }
        const r = scenesFound;
        const plugin = typeof window.ReplayAllOpen === 'function' || !!(window.KNS_Gallery && window.$csvGalleryList);
        const switches = [...r.all, ...r.scenes];
        const pendingSwitches = switches.filter((sc) => !$gameSwitches.value(sc.id)).length;
        const scenesBonusDone = scenesBonusFor !== null && scenesBonusFor === $gameSystem;
        const bonusPending = !scenesBonusDone && (r.events.length > 0 || plugin);
        const pending = pendingSwitches + r.vars.length + r.selfs.length + r.items.length + (bonusPending ? 1 : 0);
        if (!switches.length && !r.vars.length && !r.selfs.length && !r.items.length && !r.events.length && !plugin && !r.count.total) {
            return [el('div', { class: '_ch_dim' }, T.scenes_none)];
        }
        const out = [];
        if (r.rooms.length) out.push(el('div', { class: '_ch_dim' }, T.scenes_room(r.rooms.slice(0, 3).join(', '))));
        // Сначала момент «До открытия сцен» (откат одним нажатием), потом — само открытие. Момент не запомнился (не на
        // карте, нет места) — без отката открываем только вторым нажатием, и об этом сказано
        const confirming = Date.now() - scenesNoMomentAt < 10000;
        const unlock = el('button', { type: 'button', class: '_ch_btn', disabled: !pending, onclick: async () => {
            unlock.disabled = true;
            let saved = false;
            // Время второго нажатия — сейчас, а не когда рисовали кнопку
            if (Date.now() - scenesNoMomentAt >= 10000) {
                try { saved = !!(window.__rpgMoments && await window.__rpgMoments.remember(T.scenes_moment)); } catch (e) { saved = false; }
                if (!saved) { scenesNoMomentAt = Date.now(); flash(T.scenes_no_moment); render(); return; }
            }
            scenesNoMomentAt = 0;
            const plan = scenesBonusDone ? { ...r, events: [] } : r;
            let ok = true;
            try { actions.openScenes(plan, { plugins: !scenesBonusDone }); flash(saved ? T.scenes_done : T.scenes_done_nomoment); } catch (e) { ok = false; flash(String(e && e.message || e)); }
            const ranEvent = ok && !scenesBonusDone && r.events.length > 0;
            if (ok) scenesBonusFor = $gameSystem;
            scenesFound = null;
            // Общее событие «открыть всё» автора может спросить само — панель убираем, чтобы его было видно
            if (ranEvent) close(); else render();
        } }, !pending ? (r.story ? T.scenes_safe_open : T.scenes_all_open) : confirming ? T.scenes_open_anyway : T.scenes_open_all);
        // Сцены, которые держит сюжет: открытие запустит события игры само. Только с моментом «До открытия сцен»: без
        // отката такое не делаем вовсе
        let story = null;
        if (r.story) {
            const more = r.story.count.after - r.count.after;
            // Сюжетные переключатели посреди события сломали бы его; план — только для той игры, для которой считали
            const stale = () => r.sys !== $gameSystem;
            const openStory = el('button', { type: 'button', class: '_ch_btn', onclick: async () => {
                if (stale()) { scenesFound = null; render(); return; }
                if (!canGo()) { flash(T.room_busy); return; }
                openStory.disabled = true;
                let saved = false;
                try { saved = !!(window.__rpgMoments && await window.__rpgMoments.remember(T.scenes_moment)); } catch (e) { saved = false; }
                if (!saved) { flash(T.scenes_story_no_moment); openStory.disabled = false; return; }
                if (stale() || !canGo()) { scenesFound = null; render(); return; }
                try { actions.openScenes({ ...r.story, events: [] }, { plugins: false }); flash(T.scenes_done); } catch (e) { flash(String(e && e.message || e)); openStory.disabled = false; return; }
                scenesFound = null;
                // Игра может сразу пойти сама — панель убираем, чтобы было видно
                clearTimeout(closeTimer);
                closeTimer = setTimeout(close, 1500);
            } }, T.scenes_open_story(more));
            story = section(null, [el('div', { class: '_ch_dim' }, T.scenes_story(more)), row([openStory])]);
        }
        // В комнату воспоминаний — своим путём игры; перед этим момент «Перед комнатой воспоминаний» (вернуться). Не
        // запомнился — без него идём только вторым нажатием, как у «Открыть все сцены». Пока искали вход и запоминали
        // момент, панель закрыли или сменилась карта — никуда не идём
        // Одно нажатие за раз; закрыли панель (даже если потом открыли снова) — переход отменён: иначе он срабатывал
        // позже, при следующем открытии панели, и казалось, что меню само кидает в комнату
        const roomConfirming = Date.now() - roomNoMomentAt < 10000;
        const toRoom = el('button', { type: 'button', class: '_ch_btn', disabled: roomGoing, onclick: async () => {
            if (roomGoing) return;
            roomGoing = true;
            toRoom.disabled = true;
            const gen = openGen;
            const map = $gameMap.mapId();
            const still = () => gen === openGen && $gameMap.mapId() === map;
            const fail = (msg) => { if (still()) { flash(msg); toRoom.disabled = false; } };
            try {
                if (!canGo()) return fail(T.room_busy);
                hold([T.room_searching, el('span', { class: '_ch_scan' })]);
                scanTick();
                const entry = await loadRoomEntry(window).catch(() => null);
                if (!still()) return;
                if (!entry) return fail(T.room_none);
                if (!canGo()) return fail(T.room_busy);
                let saved = false;
                if (Date.now() - roomNoMomentAt >= 10000) {
                    try { saved = !!(window.__rpgMoments && await window.__rpgMoments.remember(T.room_moment)); } catch (e) { saved = false; }
                    if (!still()) return;
                    if (!saved) { roomNoMomentAt = Date.now(); flash(T.room_no_moment); render(); return; }
                }
                roomNoMomentAt = 0;
                if (!goRoom(entry)) return fail(T.room_busy);
                flash(saved ? T.room_done : T.room_done_nomoment);
                clearTimeout(closeTimer);
                closeTimer = setTimeout(close, 1500);
            } finally {
                roomGoing = false;
                // Панель закрыли и открыли снова во время поиска — на ней новая кнопка, выключенная: перерисовать
                if (gen !== openGen && window.__rpgCheatsOpen && tab === 'scenes') render();
            }
        } }, roomConfirming ? T.room_go_anyway : T.room_go);
        const canRoom = r.rooms.length > 0 || !!roomScene(window);
        out.push(section(r.count.total ? T.scenes_count(r.count.before, r.count.after, r.count.total) : null,
            [row(canRoom ? [unlock, toRoom] : [unlock]), el('div', { class: '_ch_dim' }, T.scenes_warn)]));
        if (story) out.push(story);
        const toggles = (items) => items.slice(0, LIMIT).map((sc) => toggle(`${sc.id}. ${sc.name || '—'}`, !!$gameSwitches.value(sc.id), () => actions.toggleSwitch(sc.id), null, true))
            .concat(items.length > LIMIT ? [el('div', { class: '_ch_dim' }, T.scenes_more(items.length - LIMIT))] : []);
        if (r.events.length && !scenesBonusDone) out.push(section(T.scenes_events, r.events.map((ev) => el('div', { class: '_ch_dim' }, `${ev.id}. ${ev.name}`))));
        if (plugin && !scenesBonusDone) out.push(el('div', { class: '_ch_dim' }, T.scenes_plugin));
        if (r.all.length) out.push(section(T.scenes_all_label, toggles(r.all)));
        if (r.scenes.length) out.push(section(T.scenes_list, toggles(r.scenes)));
        if (r.vars.length) {
            out.push(section(T.scenes_vars, r.vars.slice(0, LIMIT).map((v) => el('div', { class: '_ch_item' },
                [el('span', { class: '_ch_grow' }, `${v.id}. ${v.name || '—'}`), el('span', { class: '_ch_dim' }, `${$gameVariables.value(v.id)} → ${v.value}`)]))));
        }
        const extra = [r.selfs.length ? T.scenes_selfs(r.selfs.length) : '', r.items.length ? T.scenes_items(r.items.length) : ''].filter(Boolean);
        if (extra.length) out.push(el('div', { class: '_ch_dim _ch_facts' }, extra.map((x) => el('span', {}, x))));
        return out;
    }

    function render() {
        if (!root) return;
        root.querySelectorAll('._ch_tabs ._ch_chip').forEach((b) => b.classList.toggle('_on', b.dataset.tab === tab));
        lives = [];
        let kids;
        if (tab === 'scenes' ? !inGame() : !started()) kids = [el('div', { class: '_ch_dim' }, tab === 'scenes' ? T.scenes_not_started : T.not_started)];
        else {
            try {
                kids = { party: partyTab, items: itemsTab, vars: varsTab, world: worldTab, scenes: scenesTab }[tab]();
            } catch (e) {
                kids = [el('div', { class: '_ch_dim' }, String(e && e.message || e))];
            }
        }
        const scroll = body.scrollTop;
        body.replaceChildren(...kids);
        body.scrollTop = scroll;
    }

    function build() {
        const style = el('style', { id: '_cheats_css' }, CSS);
        document.head.appendChild(style);
        root = el('div', { id: '_cheats', role: 'dialog', 'aria-label': T.title });
        const head = el('div', { class: '_ch_head' }, [el('span', { class: '_ch_title' }, T.title),
            el('button', { type: 'button', class: '_ch_x', 'aria-label': T.close, title: T.close, onclick: close }, '×')]);
        const tabs = el('div', { class: '_ch_tabs', role: 'tablist' }, [['party', T.tab_party], ['items', T.tab_items], ['vars', T.tab_vars], ['world', T.tab_world], ['scenes', T.tab_scenes]]
            .map(([key, label]) => el('button', { type: 'button', role: 'tab', class: '_ch_chip', 'data-tab': key, onclick: () => { tab = key; if (key === 'scenes') scenesFound = null; body.scrollTop = 0; render(); } }, label)));
        body = el('div', { class: '_ch_body' });
        note = el('div', { class: '_ch_note', 'aria-live': 'polite' });
        root.append(head, tabs, body, note);
        // Клавиши и касания в панели — только ей: игра слушает документ и приняла бы буквы поиска за управление,
        // а касание — за шаг героя. Escape закрывает панель
        for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
        // Панель открывает пункт меню ⚙ по отпусканию пальца, а щелчок браузер шлёт следом — в то, что теперь под
        // пальцем: в кнопку панели. Так «В комнату воспоминаний» нажималась сама при каждом открытии читов
        root.addEventListener('click', (e) => { if (Date.now() - openedAt < 350) { e.stopPropagation(); e.preventDefault(); } }, true);
        for (const type of ['mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup', 'pointermove', 'wheel', 'click', 'contextmenu']) {
            root.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
        }
        document.body.appendChild(root);
    }

    let timer = null;
    // Escape закрывает панель, где бы ни был фокус (щёлкнули по панели мимо поля — фокус на странице), и до игры
    // не доходит: там он открыл бы меню
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && window.__rpgCheatsOpen) { close(); e.preventDefault(); e.stopPropagation(); }
    }, true);
    function open() {
        if (!root) build();
        clearTimeout(closeTimer);
        openedAt = Date.now();
        // Клавиша, зажатая в игре до щелчка по панели, не залипает: её отпускание панель до игры не пустит
        try { if (typeof Input !== 'undefined' && Input.clear) Input.clear(); } catch (e) { /* без сброса */ }
        root.style.display = '';
        window.__rpgCheatsOpen = true;
        render();
        // Значения отряда и денег меняются в игре — освежаем, пока в панели ничего не печатают
        clearInterval(timer);
        timer = setInterval(() => {
            for (const [node, text] of lives) { try { paint(node, text()); } catch (e) { /* игра сменила сцену */ } }
        }, 1000);
    }
    function close() {
        if (!root) return;
        openGen++;
        // «Ищу вход…» сама не гаснет — при закрытии убираем
        if (note) { clearTimeout(flash.t); note.textContent = ''; }
        root.style.display = 'none';
        window.__rpgCheatsOpen = false;
        // Открытие сбросило клавиши игры, а с ними и включённые «Пропуск» и «Бег» (rpg-fixes) — возвращаем
        if (window.__rpgRelatch) window.__rpgRelatch();
        clearInterval(timer);
        if (root.contains(document.activeElement)) document.activeElement.blur();
    }
    const toggleOpen = () => (root && root.style.display !== 'none' ? close() : open());

    // «Ещё не видели» во вкладке «Путь» (rpg-fixes, setupSceneMarks): сколько сцен комнаты воспоминаний (или галереи
    // плагина) открыто сейчас и сколько всего. Тот же разбор, что у «Открыть все сцены», но только счёт: ничего не меняет.
    // pace — пауза между пачками карт: фоном, пока играют. Разбор карт — один на игру: потом считаем по нему
    async function roomStatus({ pace = 0 } = {}) {
        const infos = (typeof $dataMapInfos !== 'undefined' && $dataMapInfos) || [];
        const ces = (typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents) || [];
        const { maps, failed, rooms } = await scanMaps(pace);
        if (failed) throw new Error('maps');
        const plug = pluginScenes(window);
        const args = { names: $dataSystem.switches, vnames: $dataSystem.variables, infos, maps, ces, ...plug, roomList: rooms };
        const r = findScenes({ ...args, state: gameState() });
        // Отладочная комната автора («Debug Room», «テスト») — не комната воспоминаний: её входы открыты всегда
        const debug = r.rooms.length > 0 && r.rooms.every((n) => /debug|test|デバッグ|テスト/i.test(n));
        if (r.count.total && !debug) {
            // «Открыто» верно, только если разбор понимает, чем сцены закрыты: в новой игре (всё выключено) открыта
            // половина и больше — значит, закрывает их что-то другое (плагин, проверка в событии). Тогда — только число
            const fresh = findScenes({ ...args, state: null }).count.before;
            return { total: r.count.total, open: fresh * 2 >= r.count.total ? null : r.count.before, rooms: r.rooms };
        }
        // Комнаты нет, а галерея плагина со списком сцен есть — по её переключателям
        const list = (plug.lists || []).filter((x) => x && x.switchId);
        return { total: list.length, open: list.filter((x) => $gameSwitches.value(x.switchId)).length, rooms: [] };
    }

    window.__rpgCheats = { open, close, toggle: toggleOpen, actions, findScenes, roomStatus, pluginScenes, roomMaps, pluginUnlock, findRoomEntry, roomScene, goRoom, safeScenes, riskyConds, hubRooms, pickRooms };
})();
