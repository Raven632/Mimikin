// Версия этого файла (?v= в адресе, сервер ставит время изменения его или чит-меню) — с ней же грузим чит-меню:
// новая версия — новый адрес, и браузер не держит старое cheats.js
var __rpgFixesV = (function () { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch (e) { return ''; } })();

// ============================================================================
// 1. АБСОЛЮТНАЯ ИМИТАЦИЯ ANDROID И СИСТЕМНЫХ API (УБИЙЦА ОШИБОК)
// ============================================================================
window.process = window.process || {};
window.process.platform = window.process.platform || 'browser';
window.process.cwd = function() { return '/'; };
// Подписки на события процесса («exit», «SIGINT») в браузере ни к чему: у Hollow Spire
// плагин при старте вешал process.on("exit"), и без заглушки падал
['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners'].forEach(function (name) {
    if (typeof window.process[name] !== 'function') window.process[name] = function () { return window.process; };
});
if (typeof window.process.exit !== 'function') window.process.exit = function () {};

// ============================================================================
// --- ВЗЛОМЩИК STEAM  И АЧИВОК ---
// ============================================================================
window.CycloneSteam = {
    isSteamRunning: true,
    active: true,
    isSubscribedApp: function(appId) { 
        return true; // <-- Вот эта строчка ломает антипиратскую защиту
    },
    registerAchievement: function(){},
    getAchievement: function(){ return false; },
    setAchievement: function(){},
    clearAchievement: function(){}
};
window.Greenworks = { initAPI: function(){ return true; } };

// ВОТ ЭТА СТРОЧКА СПАСЕТ ОТ КРАША process.argv[0]
window.process.argv = window.process.argv || ['/']; 

const mockPath = window.location.pathname || '/';
window.process.mainModule = { 
    filename: mockPath.endsWith('index.html') ? mockPath : mockPath + 'index.html' 
};
window.process.versions = window.process.versions || {};

// Бронежилет для process.env
let _env = { USER: 'Player' };
Object.defineProperty(window.process, 'env', {
    get: function() { return _env; },
    set: function(val) { _env = Object.assign(_env, val || {}); _env.USER = 'Player'; },
    configurable: true
});

// Подавляем ошибку Firefox/Chrome при выходе из полноэкранного режима
if (typeof document !== 'undefined') {
    const origExit = document.exitFullscreen;
    if (origExit) {
        document.exitFullscreen = function() {
            if (!document.fullscreenElement) return Promise.resolve();
            return origExit.call(this);
        };
    }
    const origMoz = document.mozCancelFullScreen;
    if (origMoz) {
        document.mozCancelFullScreen = function() {
            if (!document.mozFullScreenElement) return Promise.resolve();
            return origMoz.call(this);
        };
    }
    const origWebkit = document.webkitExitFullscreen;
    if (origWebkit) {
        document.webkitExitFullscreen = function() {
            if (!document.webkitFullscreenElement) return Promise.resolve();
            return origWebkit.call(this);
        };
    }
}

window.ExternalStorage = {
    _reply: function(cbId, res) {
        setTimeout(function() {
            if (window.AuraMZ && window.AuraMZ.Mobile && window.AuraMZ.Mobile.callbacks && window.AuraMZ.Mobile.callbacks[cbId]) {
                window.AuraMZ.Mobile.callbacks[cbId](res);
            }
        }, 10);
    },
    existsFile: function(id) { this._reply(id, "false"); return false; },
    saveFile: function(id) { this._reply(id, "true"); return false; },
    loadFile: function(id) { this._reply(id, ""); return false; },
    readFile: function(id) { this._reply(id, ""); return false; },
    removeFile: function(id) { this._reply(id, "true"); return false; },
    listFiles: function(id) { this._reply(id, "[]"); return false; },
    makeDir: function(id) { this._reply(id, "true"); return false; },
    selectExternalStorageDirectory: function(id) { this._reply(id, "null"); return false; },
    removeExternalStorageDirectory: function(id) { this._reply(id, "true"); return false; },
    writeFile: function(id) { this._reply(id, "true"); return false; }
};
window.Android = { showToast: function(){}, getVersion: function(){return "1.0";} };
// ============================================================================
// 0b. ADV_System stub — до загрузки TS_ADVsystem.js
// TS_ADVsystem.js строка 9: if(ADV_System == null) — без typeof!
// ============================================================================
if (typeof ADV_System === 'undefined') {
    window.ADV_System = null;
}



// ============================================================================
// 2. БЛОКИРОВЩИК ПЛАГИНОВ И ЛЕКАРЬ ПРОМИСОВ (Перехватчик)
// ============================================================================

// Плагины Seven Keys ждут от StorageManager.exists() промис и сразу зовут у
// ответа .then. Раньше для этого exists() и DataManager.savefileExists() всегда
// возвращали промис, а промис — всегда «истина»: ядро MV и плагины других игр считали,
// что есть любой сейв, и удалённые слоты висели в списке. Теперь ответ снова да/нет,
// а у да/нет есть .then — как у промиса с тем же значением. Обычный код это не задевает:
// промисы и await ищут .then только у объектов, а true и false — не объекты
if (!Boolean.prototype.then) {
    Object.defineProperty(Boolean.prototype, 'then', {
        value: function(onFulfilled, onRejected) { return Promise.resolve(this.valueOf()).then(onFulfilled, onRejected); },
        writable: true,
        configurable: true,
    });
}
if (!window.__rpgPluginHookInstalled) {
    window.__rpgPluginHookInstalled = true;
    
    var _origSrc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (_origSrc) {
        Object.defineProperty(HTMLScriptElement.prototype, 'src', {
            set: function(val) {
                if (val && typeof val === 'string') {
                    var lowerVal = val.toLowerCase();
                    // Список вредных и дев-плагинов, которые нужно заблокировать
                    var blockedPlugins = [
                        'auramz/mobile', 'toggle_save_dir', 'elimz_mobilecontrols', 
                        'cyclone-steam', 'drs_alldataextractor', 'ge_devonlymessageskipkey'
                    ];
                    
                    if (blockedPlugins.some(function(p) { return lowerVal.indexOf(p) > -1; })) {
                        console.log('[RPG Fixes] 🛑 Заблокирован конфликтный плагин: ' + val);
                        val = 'data:application/javascript,console.log("Blocked by RPG-Fixes!");';
                    }
                    
                    if (val.indexOf('js/plugins/') > -1) {
                        if (window.Scene_Boot && window.Scene_Boot.prototype && !window.__bootPromiseFixed) {
                            window.__bootPromiseFixed = true;
                            var _origBootLoad = window.Scene_Boot.prototype.loadPlayerData;
                            window.Scene_Boot.prototype.loadPlayerData = function() {
                                var res = _origBootLoad ? _origBootLoad.apply(this, arguments) : undefined;
                                return (res && typeof res.then === 'function') ? res : Promise.resolve(res);
                            };
                        }
                    }
                }
                
                if (_origSrc.set) {
                    return _origSrc.set.call(this, val);
                } else {
                    return this.setAttribute('src', val);
                }
            },
            get: function() { 
                if (_origSrc.get) {
                    return _origSrc.get.call(this); 
                } else {
                    return this.getAttribute('src');
                }
            }
        });
    }
}

// ============================================================================
// 3. ОСНОВНОЙ КОД RPG-FIXES (Ultimate v4.0 - Fullscreen Bulletproof)
// ============================================================================
(() => {
    if (window.__RPG_FIXES_ULTIMATE__) return;
    window.__RPG_FIXES_ULTIMATE__ = true;

    // Надписи меню и кнопок — на языке, выбранном в библиотеке. Библиотека хранит его
    // в localStorage (rpg_lang), а игры в проде открываются с того же адреса, так что
    // выбор виден и здесь. В dev игры живут на другом порту со своим localStorage —
    // туда язык приходит в адресе: ?lang=en
    const UI_TEXT = {
        ru: {
            settings: 'Настройки', home: 'В библиотеку', turbo: 'Турбо ×3 (T)', cheats: 'Чит-меню',
            restart: 'Перезапустить игру', restart_confirm: 'Нажмите ещё раз, чтобы перезапустить',
            loading: 'Загрузка игры…',
            stretch: 'Растянуть экран', smooth: 'Сглаживание', fullscreen: 'На весь экран',
            touch: 'Касания по игре',
            fps: 'Счётчик кадров', spikes: 'Журнал подтормаживаний',
            stick: 'Джойстик', prev: 'Предыдущий (Q)', next: 'Следующий (W)',
            skip: 'Пропуск', skip_hint: 'Пропуск текста (Ctrl)', dash: 'Бег', dash_hint: 'Бег (Shift)',
            back: 'назад', menu: 'меню', back_hint: 'Назад, меню (X)', ok: 'ок', ok_hint: 'Выбрать (Z)', a_hint: 'Клавиша A',
            keys: 'Другие клавиши', keys_abc: 'Вся клавиатура',
            cap_auto: 'авто', cap_skip: 'пропуск', cap_log: 'журнал', cap_hide: 'скрыть',
            sync_busy: 'Синхронизация…', sync_ok: 'Сохранено',
            sync_offline: 'Ждём сеть, сохранено локально',
            sync_lost: 'Нет связи с сервером, а в браузере нет места: не закрывайте игру, пока не вернётся сеть',
            sync_error: 'Ошибка сервера',
            sync_conflict: 'На сервере этот слот новее, ваш сейв сохранён в истории сейвов',
            fps_frame: 'кадр', fps_spikes: 'спайки',
            spikes_total: 'всего', spikes_clear: 'Очистить', spikes_cleared: 'Журнал очищен',
            close: 'Закрыть', hide: 'Скрыть (H)', hide_back: 'Вернуть: H или касание',
            mark_saved: 'Момент запомнен',
            mark_blocked: 'Запомнить можно на карте, не в бою и не в меню', mark_failed: 'Не запомнилось: нет связи с сервером',
            mark_full: 'Моментов слишком много: уберите лишние в окне игры',
            marks_loading: 'Загружаю…', mark_load_failed: 'Момент не загрузился',
            slot_load_failed: 'Сейв не загрузился',
            shot: 'Запомнить момент (P)', shot_saved: 'Момент запомнен', shot_moment: 'Вернуться можно через перемотку или «Играть отсюда» в окне игры',
            shot_only: 'Только кадр: в бою и в меню игра не сохраняется, вернуться можно к точке перед боем', shot_where: 'Все моменты собраны на вкладке «Моменты» в окне игры', shot_failed: 'Момент не запомнился',
            keys_title: 'В любой игре библиотеки', keys_moment: 'P — запомнить момент: к нему можно вернуться когда угодно', keys_rewind: 'Backspace — перемотка назад: игра сама ставит точки перед сценами, выборами и боями', keys_touch: 'Касание экрана — дальше по тексту. В меню игры (шестерёнка справа вверху) — момент, перемотка, авто-текст, картинка без текста и «Без звука»',
            keys_skip: 'Ctrl (держать) — пропуск текста', keys_auto: 'A — авто-текст: страницы листаются сами и ждут, пока договорит голос',
            keys_clean: 'V — картинка без окна текста; любая клавиша — вернуть', keys_turbo: 'T — турбо ×3 на карте и в бою', keys_mute: 'M — без звука',
            keys_hide: 'H — скрыть игру', keys_help: 'Клавиши', keys_pad: 'Геймпад: RT (держать) — пропуск, LT — перемотка, Back — момент, Start — меню игры',
            auto: 'Авто-текст (A)', auto_on: 'Авто-текст включён: страницы листаются сами', auto_off: 'Авто-текст выключен',
            clean: 'Картинка без текста (V)', clean_back: 'Любая клавиша или касание — вернуть текст',
            mute: 'Без звука (M)', mute_on: 'Звук выключен', mute_off: 'Звук включён', turbo_on: 'Турбо ×3 — на карте и в бою', turbo_off: 'Турбо выключено',
            rewind: 'Перемотка (⌫)', rewind_title: 'Перемотка', rewind_hint: 'Игра сама ставит точки: перед сценой, перед выбором, перед боем, на новой карте и раз в 10 минут',
            rewind_over: 'Перемотать назад?', rewind_over_hint: 'Игра окончена: вернитесь к точке до поражения', rewind_keys: [['← →', 'выбрать'], ['⌫ (держать)', 'назад'], ['↑ ↓', 'группа'], ['Enter', 'вернуться'], ['Esc', 'закрыть']], rewind_line: 'Реплика',
            rewind_go: 'Вернуться сюда', rewind_here: 'Вернётесь сюда', rewind_answer: (a) => `в прошлый раз: «${a}»`, choice_n: (n) => `вариант ${n}`, rewind_keep: 'Оставить', rewind_kept: 'Оставлено', rewind_kept_note: 'Теперь это ваш момент, новые точки его не заменят', rewind_now: 'сейчас',
            rewind_empty: 'Точек пока нет. Игра ставит их сама — перед сценой, перед выбором, перед боем, на новой карте и раз в 10 минут игры',
            why_scene: 'Перед сценой', why_scene_short: 'сцена',
            rewind_group: { lines: 'Реплики', run: 'Это прохождение', scene: 'Сцены', choice: 'Выборы', battle: 'Бои', map: 'Карты', timer: 'Время', back: 'До перемотки', exit: 'Где вышли', own: 'Мои', other: 'Другие прохождения' },
            why_battle: 'Перед боем', why_choice: 'Перед выбором', why_map: 'Новая карта',
            why_battle_short: 'бой', why_choice_short: 'выбор', why_map_short: 'карта', why_timer_short: '10 мин',
            why_back: 'До перемотки', why_back_short: 'до перемотки', why_exit: 'Где вышли', why_exit_short: 'выход',
            rewind_gone: 'Этой точки уже нет — её сменили новые. Выберите другую',
            choice_cancel: 'отказ',
            ago_now: 'только что', ago_min: (n) => `${n} мин назад`, ago_h: (n) => `${n} ч назад`,
        },
        en: {
            settings: 'Settings', home: 'Back to library', turbo: 'Turbo ×3 (T)', cheats: 'Cheat menu',
            restart: 'Restart game', restart_confirm: 'Press again to restart',
            loading: 'Loading game…',
            stretch: 'Stretch to screen', smooth: 'Smoothing', fullscreen: 'Full screen',
            touch: 'Touch input in game',
            fps: 'FPS counter', spikes: 'Stutter log',
            stick: 'Joystick', prev: 'Previous (Q)', next: 'Next (W)',
            skip: 'Skip', skip_hint: 'Skip text (Ctrl)', dash: 'Run', dash_hint: 'Run (Shift)',
            back: 'back', menu: 'menu', back_hint: 'Back, menu (X)', ok: 'ok', ok_hint: 'Confirm (Z)', a_hint: 'Key A',
            keys: 'More keys', keys_abc: 'Full keyboard',
            cap_auto: 'auto', cap_skip: 'skip', cap_log: 'log', cap_hide: 'hide',
            sync_busy: 'Syncing…', sync_ok: 'Saved',
            sync_offline: 'Waiting for network, saved locally',
            sync_lost: 'No connection to the server and no space left in the browser: keep the game open until the network is back',
            sync_error: 'Server error',
            sync_conflict: 'The server has a newer save in this slot, yours is kept in the save history',
            fps_frame: 'frame', fps_spikes: 'spikes',
            spikes_total: 'total', spikes_clear: 'Clear', spikes_cleared: 'Log cleared',
            close: 'Close', hide: 'Hide (H)', hide_back: 'Bring it back: H or a tap',
            mark_saved: 'Moment saved',
            mark_blocked: 'Moments work on the map, not in battle or menus', mark_failed: 'Not saved: no connection to the server',
            mark_full: 'Too many moments: remove some in the game window',
            marks_loading: 'Loading…', mark_load_failed: 'The moment did not load',
            slot_load_failed: 'The save did not load',
            shot: 'Remember this moment (P)', shot_saved: 'Moment saved', shot_moment: 'You can go back with Rewind or “Play from here” in the game window',
            shot_only: 'Picture only: the game does not save in battle or menus, you can go back to the point before the battle', shot_where: 'All moments are in the Moments tab of the game window', shot_failed: 'The moment was not saved',
            keys_title: 'In every game of the library', keys_moment: 'P — remember this moment: go back to it any time', keys_rewind: 'Backspace — rewind: the game sets points before scenes, choices and battles by itself', keys_touch: 'Tap the screen — next line. In the game menu (gear icon, top right) — moment, rewind, auto text, picture without text and “Mute”',
            keys_skip: 'Ctrl (hold) — skip text', keys_auto: 'A — auto text: pages turn by themselves and wait for the voice to finish',
            keys_clean: 'V — the picture without the text box; any key brings it back', keys_turbo: 'T — turbo ×3 on the map and in battle', keys_mute: 'M — mute',
            keys_hide: 'H — hide the game', keys_help: 'Keys', keys_pad: 'Gamepad: RT (hold) — skip, LT — rewind, Back — moment, Start — game menu',
            auto: 'Auto text (A)', auto_on: 'Auto text on: pages turn by themselves', auto_off: 'Auto text off',
            clean: 'Picture without text (V)', clean_back: 'Any key or tap brings the text back',
            mute: 'Mute (M)', mute_on: 'Sound off', mute_off: 'Sound on', turbo_on: 'Turbo ×3 — on the map and in battle', turbo_off: 'Turbo off',
            rewind: 'Rewind (⌫)', rewind_title: 'Rewind', rewind_hint: 'The game sets points by itself: before a scene, before a choice, before a battle, on a new map and every 10 minutes',
            rewind_over: 'Rewind?', rewind_over_hint: 'Game over: go back to a point before the defeat', rewind_keys: [['← →', 'choose'], ['⌫ (hold)', 'back'], ['↑ ↓', 'group'], ['Enter', 'go back'], ['Esc', 'close']], rewind_line: 'Line',
            rewind_go: 'Go back here', rewind_here: 'You go back here', rewind_answer: (a) => `last time: “${a}”`, choice_n: (n) => `option ${n}`, rewind_keep: 'Keep', rewind_kept: 'Kept', rewind_kept_note: 'Now it is your moment, newer points will not replace it', rewind_now: 'now',
            rewind_empty: 'No points yet. The game sets them by itself — before a scene, before a choice, before a battle, on a new map and every 10 minutes of play',
            why_scene: 'Before a scene', why_scene_short: 'scene',
            rewind_group: { lines: 'Lines', run: 'This playthrough', scene: 'Scenes', choice: 'Choices', battle: 'Battles', map: 'Maps', timer: 'Time', back: 'Before rewind', exit: 'Where you left', own: 'Mine', other: 'Other playthroughs' },
            why_battle: 'Before a battle', why_choice: 'Before a choice', why_map: 'New map',
            why_battle_short: 'battle', why_choice_short: 'choice', why_map_short: 'map', why_timer_short: '10 min',
            why_back: 'Before the rewind', why_back_short: 'before rewind', why_exit: 'Where you left', why_exit_short: 'left',
            rewind_gone: 'This point is gone — newer ones replaced it. Pick another',
            choice_cancel: 'declined',
            ago_now: 'just now', ago_min: (n) => `${n} min ago`, ago_h: (n) => `${n} h ago`,
        },
        de: {
            settings: 'Einstellungen', home: 'Zur Bibliothek', turbo: 'Turbo ×3 (T)', cheats: 'Cheat-Menü',
            restart: 'Spiel neu starten', restart_confirm: 'Zum Neustart erneut drücken',
            loading: 'Spiel wird geladen…',
            stretch: 'Bild strecken', smooth: 'Glättung', fullscreen: 'Vollbild',
            touch: 'Touch-Eingabe im Spiel',
            fps: 'FPS-Anzeige', spikes: 'Ruckel-Protokoll',
            stick: 'Joystick', prev: 'Vorheriger (Q)', next: 'Nächster (W)',
            skip: 'Vorspulen', skip_hint: 'Text vorspulen (Strg)', dash: 'Rennen', dash_hint: 'Rennen (Umschalt)',
            back: 'zurück', menu: 'Menü', back_hint: 'Zurück, Menü (X)', ok: 'ok', ok_hint: 'Auswählen (Z)', a_hint: 'Taste A',
            keys: 'Weitere Tasten', keys_abc: 'Ganze Tastatur',
            cap_auto: 'auto', cap_skip: 'vorspulen', cap_log: 'Verlauf', cap_hide: 'ausblenden',
            sync_busy: 'Synchronisiere…', sync_ok: 'Gespeichert',
            sync_offline: 'Warte auf Netz, lokal gespeichert',
            sync_lost: 'Keine Verbindung zum Server und kein Platz im Browser: Spiel nicht schließen, bis das Netz zurück ist',
            sync_error: 'Serverfehler',
            sync_conflict: 'Auf dem Server ist dieser Spielstand neuer, deiner liegt im Spielstand-Verlauf',
            fps_frame: 'Frame', fps_spikes: 'Ruckler',
            spikes_total: 'gesamt', spikes_clear: 'Leeren', spikes_cleared: 'Protokoll geleert',
            close: 'Schließen', hide: 'Ausblenden (H)', hide_back: 'Zurück mit H oder Tippen',
            mark_saved: 'Moment gemerkt',
            mark_blocked: 'Merken geht auf der Karte, nicht im Kampf oder in Menüs', mark_failed: 'Nicht gemerkt: keine Verbindung zum Server',
            mark_full: 'Zu viele Momente: entferne einige im Spielfenster',
            marks_loading: 'Lade…', mark_load_failed: 'Der Moment wurde nicht geladen',
            slot_load_failed: 'Der Spielstand wurde nicht geladen',
            shot: 'Moment merken (P)', shot_saved: 'Moment gemerkt', shot_moment: 'Zurück geht es mit Zurückspulen oder „Von hier spielen“ im Spielfenster',
            shot_only: 'Nur das Bild: im Kampf und in Menüs speichert das Spiel nicht, zurück geht es zum Punkt vor dem Kampf', shot_where: 'Alle Momente stehen im Tab „Momente“ im Spielfenster', shot_failed: 'Der Moment wurde nicht gemerkt',
            keys_title: 'In jedem Spiel der Bibliothek', keys_moment: 'P — Moment merken: dorthin kommst du jederzeit zurück', keys_rewind: 'Rücktaste — Zurückspulen: das Spiel setzt selbst Punkte vor Szenen, Wahlen und Kämpfen', keys_touch: 'Tippen — weiter im Text. Im Spielmenü (Zahnrad oben rechts) — Moment, Zurückspulen, Auto-Text, Bild ohne Text und „Ton aus“',
            keys_skip: 'Strg (halten) — Text überspringen', keys_auto: 'A — Auto-Text: Seiten blättern von selbst und warten, bis die Stimme fertig ist',
            keys_clean: 'V — das Bild ohne Textfenster; jede Taste holt es zurück', keys_turbo: 'T — Turbo ×3 auf der Karte und im Kampf', keys_mute: 'M — Ton aus',
            keys_hide: 'H — Spiel verbergen', keys_help: 'Tasten', keys_pad: 'Gamepad: RT (halten) — überspringen, LT — zurückspulen, Back — Moment, Start — Spielmenü',
            auto: 'Auto-Text (A)', auto_on: 'Auto-Text an: Seiten blättern von selbst', auto_off: 'Auto-Text aus',
            clean: 'Bild ohne Text (V)', clean_back: 'Jede Taste oder Tippen holt den Text zurück',
            mute: 'Ton aus (M)', mute_on: 'Ton aus', mute_off: 'Ton an', turbo_on: 'Turbo ×3 — auf der Karte und im Kampf', turbo_off: 'Turbo aus',
            rewind: 'Zurückspulen (⌫)', rewind_title: 'Zurückspulen', rewind_hint: 'Das Spiel setzt die Punkte selbst: vor einer Szene, vor einer Wahl, vor einem Kampf, auf einer neuen Karte und alle 10 Minuten',
            rewind_over: 'Zurückspulen?', rewind_over_hint: 'Game Over: geh zu einem Punkt vor der Niederlage zurück', rewind_keys: [['← →', 'wählen'], ['⌫ (halten)', 'zurück'], ['↑ ↓', 'Gruppe'], ['Enter', 'zurück'], ['Esc', 'schließen']], rewind_line: 'Zeile',
            rewind_go: 'Hierher zurück', rewind_here: 'Hierher geht es zurück', rewind_answer: (a) => `letztes Mal: „${a}“`, choice_n: (n) => `Option ${n}`, rewind_keep: 'Behalten', rewind_kept: 'Behalten', rewind_kept_note: 'Jetzt dein Moment, neuere Punkte ersetzen ihn nicht', rewind_now: 'jetzt',
            rewind_empty: 'Noch keine Punkte. Das Spiel setzt sie selbst — vor einer Szene, vor einer Wahl, vor einem Kampf, auf einer neuen Karte und alle 10 Spielminuten',
            why_scene: 'Vor der Szene', why_scene_short: 'Szene',
            rewind_group: { lines: 'Zeilen', run: 'Dieser Durchlauf', scene: 'Szenen', choice: 'Wahlen', battle: 'Kämpfe', map: 'Karten', timer: 'Zeit', back: 'Vor dem Spulen', exit: 'Wo du aufgehört hast', own: 'Meine', other: 'Andere Durchläufe' },
            why_battle: 'Vor dem Kampf', why_choice: 'Vor der Wahl', why_map: 'Neue Karte',
            why_battle_short: 'Kampf', why_choice_short: 'Wahl', why_map_short: 'Karte', why_timer_short: '10 Min',
            why_back: 'Vor dem Zurückspulen', why_back_short: 'davor', why_exit: 'Wo du aufgehört hast', why_exit_short: 'Ende',
            rewind_gone: 'Diesen Punkt gibt es nicht mehr — neuere haben ihn ersetzt. Wähle einen anderen',
            choice_cancel: 'abgelehnt',
            ago_now: 'gerade eben', ago_min: (n) => `vor ${n} Min`, ago_h: (n) => `vor ${n} Std`,
        },
    };
    const T = UI_TEXT[(() => {
        const known = (v) => Object.keys(UI_TEXT).includes(v);
        let lang = null;
        try { lang = new URLSearchParams(location.search).get('lang'); } catch (_) {}
        if (!known(lang)) try { lang = localStorage.getItem('rpg_lang'); } catch (_) {}
        return known(lang) ? lang : 'ru';   // 'ru' — как и в самой библиотеке по умолчанию
    })()];

    // Имя игры для её данных — папка игры. Её называет сервер (window.__RPG), без него — первая часть
    // адреса. Раньше имя «чинилось»: всё, кроме латиницы, кириллицы и цифр, становилось «_», и у
    // японских названий выходили одни подчёркивания — две игры с названиями одной длины делили бы
    // сейвы. Сервер перенёс сейвы под настоящие имена; LEGACY_GAME_ID — прежнее, для очереди сейвов
    const GAME_ID = (() => {
        if (window.__RPG && window.__RPG.id) return String(window.__RPG.id);
        const first = location.pathname.split('/').filter(Boolean)[0] || '';
        try { return decodeURIComponent(first) || 'unknown'; } catch (_) { return first || 'unknown'; }
    })();
    const LEGACY_GAME_ID = GAME_ID.replace(/[^a-zA-Z0-9._\-а-яА-Я]/g, '_');

    // Настройки, которые запоминаются для каждой игры: «Касания по игре», «Растянуть экран»,
    // раскрытая клавиатура в полоске ⌨. Раньше они сбрасывались при каждом запуске, и в
    // игре, которой нужны касания, это приходилось включать заново. Хранятся в браузере:
    // на телефоне и на компьютере они и должны быть разными
    const gameSettings = (() => {
        const key = 'rpgfix_game_' + GAME_ID;
        let data = {};
        // Раньше ключом была первая часть адреса как есть, в %-кодировке
        try { data = JSON.parse(localStorage.getItem(key) || localStorage.getItem('rpgfix_game_' + encodeURIComponent(GAME_ID)) || '{}') || {}; } catch (_) {}
        return {
            get: (name) => data[name],
            set: (name, value) => {
                data[name] = value;
                try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
            },
        };
    })();

    // Журнал ошибок игры — на сервер, а оттуда в «Ревизию»: игра, упавшая на телефоне, видна без
    // ручной проверки каждой. Ловим ошибки страницы, отклонённые обещания и то, что движок сам
    // показывает на экране ошибки (SceneManager.catchException, «Failed to load»). Одну и ту же — раз,
    // всего за сеанс — не больше 15
    // Проверка игры (setupSelfTest, ?mimikin-check=1) ничего не пишет — с первой строки: хранилище браузера
    // (сейвы и настройки, и через него облако библиотеки), запросы сохранений и журнала на сервер.
    // Проверка идёт на том же адресе, что и обычная игра, — иначе плагин автосейва записал бы в данные игрока
    (function blockWritesInCheck() {
        if (!/[?&]mimikin-check=1(?:&|$)/.test(location.search)) return;
        try {
            const noop = function() {};
            Storage.prototype.setItem = noop;
            Storage.prototype.removeItem = noop;
            Storage.prototype.clear = noop;
        } catch (e) { /* без хранилища — и писать некуда */ }
        const blocked = (url, method) => method && String(method).toUpperCase() !== 'GET' && /\/(saves|errors)\//.test(String(url));
        const fetch0 = window.fetch;
        if (fetch0) {
            window.fetch = function(input, init) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                const method = (init && init.method) || (input && input.method) || 'GET';
                if (blocked(url, method)) return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return fetch0.apply(this, arguments);
            };
        }
        const open0 = XMLHttpRequest.prototype.open;
        const send0 = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) { this.__rpgBlocked = blocked(url, method); return open0.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function() { if (this.__rpgBlocked) return; return send0.apply(this, arguments); };
        if (navigator.sendBeacon) navigator.sendBeacon = function() { return true; };
    })();

    (function setupErrorReports() {
        const base = (window.__RPG && window.__RPG.errors) || '/api/errors';
        const url = `${base}/${encodeURIComponent(GAME_ID)}`;
        const sent = new Set();
        const scene = () => { try { return SceneManager._scene.constructor.name; } catch (_) { return ''; } };
        const report = (kind, message, source, line, stack) => {
            message = String(message || '').slice(0, 500);
            if (!message || /^Script error\.?$/i.test(message) || /ResizeObserver loop/i.test(message)) return;
            // Проверка игры (setupSelfTest): ошибки — в её итог, журнал игры не засоряем
            if (window.__RPG && window.__RPG.selftest) {
                const list = window.__RPG.selftest.errors;
                if (list.length < 20 && !list.some((x) => x.message === message && x.source === (source || ''))) list.push({ kind, message, source: String(source || '').slice(0, 300) });
                return;
            }
            const sig = `${kind}|${message}|${source || ''}|${line || 0}`;
            if (sent.has(sig) || sent.size >= 15) return;
            sent.add(sig);
            let standalone = false;
            try { standalone = !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches); } catch (_) {}
            try {
                fetch(url, {
                    method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kind, message, source: String(source || '').slice(0, 300), line: line || 0, stack: String(stack || '').slice(0, 2000), scene: scene(), standalone }),
                }).catch(() => {});
            } catch (_) {}
        };
        window.addEventListener('error', (e) => {
            if (!(e instanceof ErrorEvent)) return;   // не загрузилась картинка или скрипт — это не ошибка кода
            report('error', e.message, e.filename, e.lineno, e.error && e.error.stack);
        });
        window.addEventListener('unhandledrejection', (e) => {
            const r = e.reason;
            report('rejection', (r && (r.message || r.toString())) || 'Promise rejected', '', 0, r && r.stack);
        });
        // Плагины (YEP Core и другие, у трети игр) заменяют catchException уже после нас: обычная обёртка терялась, и
        // падение игры не попадало в журнал. Поэтому свойство-ловушка: что бы плагин ни присвоил, вызов идёт через нас.
        // Плагин, что сохранил прежнюю функцию и зовёт её из своей, получает её же: глубина вызова ведёт по цепочке назад
        function trapHook(obj, name, before) {
            const fns = [obj[name]];
            let depth = 0;
            const wrapped = function() {
                const i = fns.length - 1 - depth;
                if (i < 0 || typeof fns[i] !== 'function') return undefined;
                if (depth === 0) { try { before.apply(this, arguments); } catch (_) {} }
                depth++;
                try { return fns[i].apply(this, arguments); } finally { depth--; }
            };
            try {
                Object.defineProperty(obj, name, { configurable: true, enumerable: true, get: () => wrapped, set: (v) => { if (v !== wrapped) fns.push(v); } });
            } catch (_) { obj[name] = wrapped; }
        }
        const hook = setInterval(() => {
            if (typeof SceneManager === 'undefined' || !SceneManager.catchException) return;
            clearInterval(hook);
            trapHook(SceneManager, 'catchException', (e) => report('engine', e && (e.message || e.name || String(e)), '', 0, e && e.stack));
            if (SceneManager.catchLoadError) trapHook(SceneManager, 'catchLoadError', (e) => report('load', 'Failed to load', Array.isArray(e) ? e[1] : '', 0, ''));
            if (typeof Graphics !== 'undefined' && Graphics.printLoadingError) trapHook(Graphics, 'printLoadingError', (u) => report('load', 'Failed to load', u, 0, ''));
        }, 50);
        setTimeout(() => clearInterval(hook), 20000);
    })();

    let cloudApi = null;      // облачные сейвы (setupCloudSaves)
    let gameStorage = null;   // хранилище браузера этой игры (setupGameStorage)

    // Уйти из игры — в библиотеку, на перезапуск или по «Выходу» самой игры, — но сначала
    // дать сейвам долететь до сервера: переход страницы обрывает отправку, и свежий сейв
    // остался бы только в очереди этого устройства (уйдёт, когда игру откроют здесь снова,
    // а на другом устройстве его пока не будет). Ждём не дольше 5 секунд
    let leaving = false;
    // Перед уходом — и то, что попросили другие части (setupSceneMarks: точка «Где вышли»): ждём вместе с сейвами
    const leaveHooks = [];
    function leaveGame(go) {
        if (leaving) return;
        leaving = true;
        const sent = Promise.all([cloudApi ? cloudApi.flush() : Promise.resolve(), ...leaveHooks.map((f) => Promise.resolve().then(f).catch(() => {}))]);
        Promise.race([sent, new Promise(r => setTimeout(r, 5000))]).then(go, go);
    }
    // Игра на своём адресе открыта в рамке библиотеки (routes/play.js, frontend GameFrame): уход —
    // сообщение библиотеке, она закроет рамку. Открыта сама по себе — переходим по адресу библиотеки
    // из ?lib=, а по-старому (игра на адресе библиотеки) — на её главную
    const FRAMED = window.parent !== window;
    const LIBRARY_URL = (() => {
        try {
            const v = new URLSearchParams(location.search).get('lib') || '';
            return /^https?:\/\/[^\s"'<>]+$/.test(v) ? v : '/';
        } catch (_) { return '/'; }
    })();
    const toLibrary = () => leaveGame(() => {
        if (FRAMED) window.parent.postMessage({ type: 'rpg:leave' }, '*');
        else window.location.href = LIBRARY_URL;
    });
    // Библиотека просит уйти (кнопка «Назад» браузера): сначала дать сейвам долететь
    window.addEventListener('message', (e) => {
        if (e.source === window.parent && e.data && e.data.type === 'rpg:leave-request') toLibrary();
    });

    // «Выход» из самой игры — команда на титуле или в меню у ~25 игр библиотеки (плагины
    // зовут SceneManager.exit или terminate). Движок закрыл бы окно NW.js, а вкладку браузера
    // закрыть нельзя — оставался чёрный экран. Теперь выход — обратно в библиотеку
    function setupGameExit() {
        const timer = setInterval(() => {
            if (typeof SceneManager === 'undefined' || !SceneManager.terminate) return;
            clearInterval(timer);
            SceneManager.terminate = toLibrary;
        }, 50);
        setTimeout(() => clearInterval(timer), 15000);
    }

    function applyConsoleFixes() {
        function applyCanvasReadFrequently(proto) {
            if (!proto || !proto.getContext) return;
            var originalGetContext = proto.getContext;
            proto.getContext = function(type, attributes) {
                if (type === '2d') {
                    var newAttributes = Object.assign({}, attributes || {});
                    newAttributes.willReadFrequently = true;
                    return originalGetContext.call(this, type, newAttributes);
                }
                return originalGetContext.call(this, type, attributes);
            };
        }
        applyCanvasReadFrequently(HTMLCanvasElement.prototype);
        if (typeof OffscreenCanvas !== 'undefined') applyCanvasReadFrequently(OffscreenCanvas.prototype);

        var orgSetTextAlign = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'textAlign');
        if (orgSetTextAlign && orgSetTextAlign.set) {
            Object.defineProperty(CanvasRenderingContext2D.prototype, 'textAlign', {
                set: function(value) {
                    var safeValue = (value === 'undefined' || !value) ? 'left' : String(value).toLowerCase();
                    orgSetTextAlign.set.call(this, safeValue);
                }
            });
        }

        var orgWarn = console.warn;
        console.warn = function() {
            if (arguments[0] && typeof arguments[0] === 'string') {
                if (arguments[0].indexOf('Unsupported skeleton data') > -1) return;
            }
            orgWarn.apply(console, arguments);
        };
        // ====================================================================
        // ФИКС КРАША СНИМКОВ ЭКРАНА (getImageData non-finite / type 'long')
        // ====================================================================
        var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
            // Строгая проверка: если это Бесконечность (Infinity) или NaN -> превращаем в 0
            var x = (isFinite(sx) && !isNaN(sx)) ? Math.round(sx) : 0;
            var y = (isFinite(sy) && !isNaN(sy)) ? Math.round(sy) : 0;
            var w = (isFinite(sw) && !isNaN(sw)) ? Math.round(sw) : 1;
            var h = (isFinite(sh) && !isNaN(sh)) ? Math.round(sh) : 1;
            
            // Canvas ненавидит нулевую ширину или высоту
            if (w === 0) w = 1;
            if (h === 0) h = 1;

            try {
                // Пытаемся сделать снимок с отфильтрованными координатами
                return origGetImageData.call(this, x, y, w, h);
            } catch (e) {
                // Если Canvas всё равно недоволен, отдаем пустой прозрачный квадрат
                console.warn('[RPG Fixes] 🛡️ Перехвачен краш getImageData:', e.message);
                return this.createImageData(Math.abs(w) || 1, Math.abs(h) || 1);
            }
        };
    }

    function applyCoreEnginePatches() {
        const pmTimer = setInterval(() => {
            if (window.PluginManager && typeof PluginManager.setup === 'function' && !window.__pmHooked) {
                window.__pmHooked = true;
                
                // 🛑 Глушим плагин AudioStreaming еще до его запуска!
                if (!PluginManager._parameters) PluginManager._parameters = {};
                PluginManager._parameters['audiostreaming'] = { mode: "00" };

                const origSetup = PluginManager.setup;
                PluginManager.setup = function(plugins) {
                    if (Array.isArray(plugins)) {
                        plugins = plugins.filter(p => !['EliMZ_MobileControls', 'ToggleSaveDirectory', 'Mobile', 'AudioStreaming'].includes(p.name));
                    }
                    origSetup.call(this, plugins);
                };
                clearInterval(pmTimer);
            }
        }, 10);
        // Не игра RPG Maker (или сломанная) — не опрашиваем вечно
        setTimeout(() => clearInterval(pmTimer), 30000);
    }

    function setupBrowserStubs() {
        if (typeof window.Logger === 'undefined') {
            const dummyLog = function() {};
            window.Logger = {
                createDefaultLogger: function() { return { info: dummyLog, warn: dummyLog, error: dummyLog, debug: dummyLog, fatal: dummyLog, trace: dummyLog }; },
                default: { createDefaultLogger: function() { return { info: dummyLog, warn: dummyLog, error: dummyLog, debug: dummyLog, fatal: dummyLog, trace: dummyLog }; } }
            };
        }
        
        window.__import_meta = { url: location.href, env: {} };

        // Модуль path из Node — как в NW.js (пути через «/»). Плагины зовут не только join и dirname:
        // DKTools после выбора языка берёт path.parse и path.sep, и без них игра вставала на ошибке
        // «this.path.parse is not a function» (Moonlit Library)
        const nodePath = (() => {
            const clean = (p) => String(p == null ? '' : p).replace(/\\/g, '/');
            const normalize = (p) => {
                p = clean(p);
                // Пустой путь — пустая строка, как в прежней замене (Node вернул бы «.»)
                if (!p) return '';
                const abs = p.startsWith('/');
                const trail = p.endsWith('/');
                const out = [];
                for (const part of p.split('/')) {
                    if (!part || part === '.') continue;
                    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); }
                    else out.push(part);
                }
                const joined = (abs ? '/' : '') + out.join('/');
                return (joined || (abs ? '/' : '.')) + (trail && out.length ? '/' : '');
            };
            const basename = (p, ext) => {
                const b = clean(p).replace(/\/+$/, '').split('/').pop() || '';
                return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
            };
            const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
            const dirname = (p) => {
                const s = clean(p).replace(/\/+$/, '');
                const i = s.lastIndexOf('/');
                return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
            };
            const isAbsolute = (p) => clean(p).startsWith('/');
            const join = (...a) => normalize(a.filter((x) => x !== '' && x != null).map(clean).join('/'));
            const resolve = (...a) => {
                let r = '';
                for (let i = a.length - 1; i >= 0 && !isAbsolute(r); i--) if (a[i]) r = r ? `${clean(a[i])}/${r}` : clean(a[i]);
                if (!isAbsolute(r)) r = `${dirname(location.pathname)}/${r}`;
                return normalize(r).replace(/(.)\/$/, '$1');
            };
            const relative = (from, to) => {
                const f = resolve(from).split('/').filter(Boolean);
                const t = resolve(to).split('/').filter(Boolean);
                let i = 0;
                while (i < f.length && i < t.length && f[i] === t[i]) i++;
                return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/');
            };
            const parse = (p) => {
                const s = clean(p);
                const root = s.startsWith('/') ? '/' : '';
                const base = basename(s);
                const ext = extname(s);
                let dir = dirname(s);
                if (dir === '.' && !s.includes('/')) dir = '';
                return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
            };
            const format = (o) => {
                const dir = o.dir || o.root || '';
                const base = o.base || `${o.name || ''}${o.ext || ''}`;
                return dir ? (dir.endsWith('/') ? dir + base : `${dir}/${base}`) : base;
            };
            const api = { sep: '/', delimiter: ':', normalize, join, resolve, relative, dirname, basename, extname, isAbsolute, parse, format, toNamespacedPath: (p) => p };
            api.posix = api;
            api.win32 = api;
            return api;
        })();

        if (typeof require === 'undefined') {
            // Кэш для fs: файлы игры во время игры не меняются, повторно не спрашиваем
            const fsCache = new Map();
            const later2 = (cb, ...args) => { if (typeof cb === 'function') setTimeout(() => cb(...args), 0); };
            const lastFn2 = (args) => [...args].reverse().find((a) => typeof a === 'function');
            window.require = function (m) {
                if (m === 'path') return nodePath;
                if (m === 'util') return {
                    promisify: function(fn) { 
                        return function(...args) { 
                            return new Promise((resolve, reject) => { 
                                fn(...args, (err, res) => err ? reject(err) : resolve(res)); 
                            }); 
                        }; 
                    }
                };
                if (m === 'fs') {
                    // Читаем файлы игры с сервера синхронным запросом — так же синхронно, как fs.*Sync
                    // в NW.js. Относительный путь считается от папки игры (адреса страницы).
                    // Нужно плагинам, которые читают свои файлы через fs (Hendrix_Localization: game_messages.csv).
                    const fetchSync = (p, method) => {
                        const key = method + ' ' + p;
                        if (fsCache.has(key)) return fsCache.get(key);
                        let result = { status: 0, text: '' };
                        try {
                            const xhr = new XMLHttpRequest();
                            xhr.open(method, String(p).replace(/\\/g, '/'), false);
                            xhr.overrideMimeType('text/plain; charset=utf-8');
                            xhr.send();
                            result = { status: xhr.status, text: xhr.responseText };
                        } catch (e) {}
                        fsCache.set(key, result);
                        return result;
                    };
                    // Файлы, которые игра пишет сама, — в браузере. Папка save/: плагины вроде
                    // TS_CommonSave (комната воспоминаний Clockwork Vale и Tidecaller) пишут туда свои
                    // файлы, а раньше запись уходила в никуда. И небольшие файлы прямо в папке игры:
                    // lng.txt с выбранным языком и saveHollow.txt у Hollow Spire. Файл хранится
                    // как ключ игры (setupGameStorage): в её хранилище и в облаке
                    const gameDir = mockPath.replace(/[^/]*$/, '');
                    const saveName = (p) => { const x = /(?:^|\/)save\/(.*)$/i.exec(String(p).replace(/\\/g, '/')); return x ? x[1] : null; };
                    const fileKey = (name) => 'FILE save:' + name;
                    const pathKey = (p) => {
                        const name = saveName(p);
                        if (name !== null) return name ? fileKey(name) : null;
                        let rel = String(p).replace(/\\/g, '/');
                        if (rel.startsWith(gameDir)) rel = rel.slice(gameDir.length);
                        rel = rel.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
                        return rel && !rel.includes('..') && !/^[a-z]+:/i.test(rel) ? 'FILE path:' + rel : null;
                    };
                    const saved = (p) => { const k = pathKey(p); return k && gameStorage ? gameStorage.get(k) : null; };
                    // Большое (снимки экрана base64) не храним: хранилище и облако — для сейвов
                    const MAX_FILE = 512 * 1024;
                    // Файла нет: Node бросает ENOENT, и игры для NW.js на это рассчитывают — ловят и берут
                    // значение по умолчанию. Раньше здесь возвращалось '[]', и Hollow Spire читала
                    // язык «[]» из отсутствующего lng.txt и искала данные в data_[]/ — зависала на загрузке.
                    // Пустой список остаётся только для .json: на него рассчитывают старые плагины
                    const missing = (p) => {
                        if (/\.json$/i.test(String(p))) return '[]';
                        const e = new Error("ENOENT: no such file or directory, open '" + p + "'");
                        e.code = 'ENOENT'; e.errno = -2; e.syscall = 'open'; e.path = String(p);
                        throw e;
                    };
                    // Файлы настроек, которых в архиве нет, а игра читает их без проверки. Игры Bosom Studio
                    // (Hollow Spire) в rpg_managers.js читают язык из lng.txt — без файла падают ещё
                    // до титула. Язык по умолчанию — английский, если у игры есть data_en, иначе японский,
                    // как в самой игре. Сменят язык в меню — игра запишет lng.txt, и запомнится он
                    const DEFAULT_FILES = {
                        'lng.txt': () => (fetchSync('data_en/System.json', 'HEAD').status === 200 ? 'en' : 'jp'),
                    };
                    const fallback = (p) => {
                        const k = pathKey(p);
                        const make = k && DEFAULT_FILES[k.replace(/^FILE path:/, '')];
                        return make ? make() : missing(p);
                    };
                    const later = (cb, ...args) => { if (typeof cb === 'function') setTimeout(() => cb(...args), 0); };
                    const lastFn = (args) => [...args].reverse().find((a) => typeof a === 'function');
                    const fs = {
                        readFileSync: p => { const v = saved(p); if (v !== null) return v; const r = fetchSync(p, 'GET'); return r.status === 200 ? r.text : fallback(p); },
                        existsSync: p => { if (saveName(p) === '' || saved(p) !== null) return true; return fetchSync(p, 'HEAD').status === 200; },
                        writeFileSync: (p, data) => { const k = pathKey(p); const text = String(data ?? ''); if (k && gameStorage && text.length <= MAX_FILE) gameStorage.set(k, text); },
                        appendFileSync: (p, data) => { let before = ''; try { before = fs.readFileSync(p); } catch (e) {} fs.writeFileSync(p, before + String(data ?? '')); },
                        unlinkSync: p => { const k = pathKey(p); if (k && gameStorage) gameStorage.remove(k); },
                        readdirSync: p => {
                            const dir = saveName(String(p).replace(/[\\/]*$/, '/'));
                            if (dir === null || !gameStorage) return [];
                            return gameStorage.list(fileKey(dir)).map(k => k.slice(fileKey(dir).length)).filter(n => n && !n.includes('/'));
                        },
                        mkdirSync: () => {},
                        statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 0, mtime: new Date() }),
                        // Поток записи: «saveHollow.txt» Hollow Spire пишет так. Пишем сразу при каждом
                        // куске — до end() игра может и не дойти
                        createWriteStream: (p) => {
                            let text = '';
                            const stream = {
                                write: (chunk, ...rest) => { text += String(chunk ?? ''); fs.writeFileSync(p, text); later(lastFn(rest)); return true; },
                                end: (chunk, ...rest) => { if (chunk != null && typeof chunk !== 'function') stream.write(chunk); else fs.writeFileSync(p, text); later(lastFn([chunk, ...rest])); },
                                on: () => stream, once: () => stream, close: () => {}, destroy: () => {},
                            };
                            return stream;
                        },
                    };
                    // Те же действия с обратным вызовом (fs.readFile, fs.writeFile…): ответ — следующим тиком
                    const async = (fn) => (p, ...args) => {
                        const cb = lastFn(args);
                        try { later(cb, null, fn(p, ...args.filter((a) => typeof a !== 'function'))); } catch (e) { later(cb, e); }
                    };
                    Object.assign(fs, {
                        readFile: async(fs.readFileSync), writeFile: async(fs.writeFileSync), appendFile: async(fs.appendFileSync),
                        unlink: async(fs.unlinkSync), mkdir: async(fs.mkdirSync), readdir: async(fs.readdirSync), stat: async(fs.statSync),
                        exists: (p, cb) => later(cb, fs.existsSync(p)),
                    });
                    return fs;
                }
                // Запустить программу или открыть папку браузер не может: отвечаем «не вышло», а не падаем
                if (m === 'child_process') return {
                    exec: (...args) => { later2(lastFn2(args), new Error('child_process is not available in the browser')); return { on() {}, stdout: { on() {} }, stderr: { on() {} } }; },
                    execSync: () => '',
                    spawn: () => ({ on() {}, stdout: { on() {} }, stderr: { on() {} }, kill() {} }),
                };
                if (m === 'nw.gui' || m === 'nw') return { 
                    Window: { get: () => ({ on() {}, maximize() {}, restore() {}, removeAllListeners() {}, close() {} }) }, 
                    App: { quit() { toLibrary(); }, argv: [], manifest: {} }, 
                    Screen: { Init() {}, on() {} }, 
                    Shell: { openExternal: url => window.open(url, '_blank') } 
                };
                if (m.includes('greenworks')) return {
                    initAPI: () => false, isSteamRunning: () => false, getAppId: () => 0,
                    getSteamId: () => ({ accountId: 0, screenName: 'Player' }), activateAchievement: () => {}, on: () => {}
                };
                return {};
            };
            window.nw = window.require('nw');
        }
    }

    function fixDevicePixelRatio() {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (!isIOS) return;
        const TARGET = 1;
        // Настоящую плотность запоминаем до подмены: по ней масштабирование решает,
        // чёткими пикселями рисовать картинку или со сглаживанием (см. applyScale)
        window.__realDevicePixelRatio = window.devicePixelRatio;
        try { Object.defineProperty(window, 'devicePixelRatio', { get: () => TARGET, configurable: true }); } catch(e) {}
        const pixi_t = setInterval(() => {
            if (typeof PIXI === 'undefined') return;
            clearInterval(pixi_t);
            const gfx_t = setInterval(() => {
                if (typeof Graphics === 'undefined') return;
                const r = (Graphics._app && Graphics._app.renderer) || Graphics._renderer;
                if (!r) return;
                clearInterval(gfx_t);
                if (r.resolution === TARGET) return; 
                const logW = r.width  / r.resolution; const logH = r.height / r.resolution; r.resolution = TARGET;
                try { r.resize(logW, logH); } catch(e) {}
                try { if (r.plugins && r.plugins.interaction) r.plugins.interaction.resolution = TARGET; } catch(e) {}
            }, 100);
            setTimeout(() => clearInterval(gfx_t), 15000);
        }, 50);
        setTimeout(() => clearInterval(pixi_t), 15000);
    }

    function setupModernViewport() {
        let meta = document.querySelector('meta[name="viewport"]');
        if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
        meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';

        const style = document.createElement('style');
        style.textContent = `
            html, body { margin:0!important; padding:0!important; width:100vw!important; height:100dvh!important; background:#000!important; overflow:hidden!important; touch-action:none!important; overscroll-behavior: none; -webkit-text-size-adjust: none; }
            #GameCanvas, canvas { display:block!important; position:absolute!important; top:50%!important; left:50%!important; transform-origin:center center!important; margin:0!important; padding:0!important; will-change: transform; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
        `;
        document.head.appendChild(style);

        let isStretched = !!gameSettings.get('stretch'); let targetCanvas = null;
        window.__toggleRpgStretch = () => { isStretched = !isStretched; gameSettings.set('stretch', isStretched); forceScaleUpdate(); };
        window.__rpgIsStretched = () => isStretched;

        // Сглаживание при растягивании. Раньше картинка всегда растягивалась без него
        // (image-rendering: pixelated), и при дробном увеличении — 1,5 на экране 1080p —
        // каждый второй пиксель игры становился двойным: буквы разной толщины, края
        // лесенкой. Теперь «auto»: чёткие пиксели, только когда увеличение целое
        // (×2, ×3 — там они ровные), иначе плавно. «off» — всегда чёткие, как раньше.
        // Выбор общий для всех игр: они открываются с одного адреса
        const SMOOTH_KEY = 'rpgfix_smoothing';
        let smoothMode = 'auto';
        try { if (localStorage.getItem(SMOOTH_KEY) === 'off') smoothMode = 'off'; } catch(e) {}
        window.__rpgSmoothing = () => smoothMode;
        window.__toggleRpgSmoothing = () => {
            smoothMode = smoothMode === 'auto' ? 'off' : 'auto';
            try { localStorage.setItem(SMOOTH_KEY, smoothMode); } catch(e) {}
            forceScaleUpdate();
            return smoothMode;
        };

        // Вырез, «островок» и скруглённые углы iPhone. Страница растянута на весь экран
        // (viewport-fit=cover), и раньше картинка игры считалась по всему экрану: растянутая,
        // она уходила под вырез — на iPhone 13 лёжа по 47 px с каждой стороны. Теперь игра
        // встаёт в безопасную зону. Снизу отступ не берём: там только тонкая полоска «домой»,
        // а игра на телефоне лёжа из-за неё стала бы мельче
        const safeProbe = document.createElement('div');
        safeProbe.id = '_safe_area_probe';
        safeProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);';
        document.documentElement.appendChild(safeProbe);
        function safeInsets() {
            const cs = getComputedStyle(safeProbe);
            return { left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0, top: parseFloat(cs.paddingTop) || 0 };
        }

        // Где сейчас холст: сдвиг и масштаб. Нужно, чтобы поставить поверх него видео
        const placed = { left: 0, top: 0, sx: 1, sy: 1 };

        // Где и в каком масштабе встаёт картинка игры размером w×h в нынешнем окне
        function fit(w, h) {
            const safe = safeInsets();
            const areaW = window.innerWidth - safe.left - safe.right, areaH = window.innerHeight - safe.top;
            let sx = areaW / w, sy = areaH / h;
            if (!isStretched) sx = sy = Math.min(sx, sy);
            // Считаем в настоящих пикселях экрана: на iPhone и ноутбуке с масштабом 125%
            // один пиксель CSS — это 3 и 1,25 физических. На iPhone devicePixelRatio
            // подменён на 1 (fixDevicePixelRatio), поэтому берём сохранённый
            const dpr = window.__realDevicePixelRatio || window.devicePixelRatio || 1;
            // По центру, но с точностью до пикселя экрана: при центровке через 50% холст
            // на нечётной ширине окна вставал на полпикселя, и даже при ×2 пиксели выходили неровными
            const left = Math.round((safe.left + (areaW - w * sx) / 2) * dpr) / dpr;
            const top = Math.round((safe.top + (areaH - h * sy) / 2) * dpr) / dpr;
            return { sx, sy, left, top, dpr };
        }

        const resizeObserver = new ResizeObserver(() => { if (targetCanvas) requestAnimationFrame(applyScale); });
        function applyScale() {
            if (!targetCanvas || !targetCanvas.width) return;
            const w = targetCanvas.width, h = targetCanvas.height;
            const { sx: scaleX, sy: scaleY, left, top, dpr } = fit(w, h);
            const whole = (v) => v >= 1 && Math.abs(v - Math.round(v)) < 0.01;
            const crisp = smoothMode === 'off' || (whole(scaleX * dpr) && whole(scaleY * dpr));
            // Второй холст движка MV (на нём «Now Loading…» при долгой загрузке) — туда же,
            // где картинка игры. Раньше он стоял левым верхним углом в центре окна: надпись
            // уходила в правый нижний угол, за край экрана
            const canvases = [targetCanvas];
            const upper = typeof Graphics !== 'undefined' && Graphics._upperCanvas;
            if (upper && upper !== targetCanvas && upper.style) canvases.push(upper);
            for (const c of canvases) {
                c.style.setProperty('width', w + 'px', 'important');
                c.style.setProperty('height', h + 'px', 'important');
                c.style.setProperty('image-rendering', crisp ? 'pixelated' : 'auto', 'important');
                c.style.setProperty('left', '0px', 'important');
                c.style.setProperty('top', '0px', 'important');
                c.style.setProperty('transform-origin', '0 0', 'important');
                c.style.setProperty('transform', `translate(${left}px, ${top}px) scale(${scaleX}, ${scaleY})`, 'important');
            }
            Object.assign(placed, { left, top, sx: scaleX, sy: scaleY });
            syncEngineScale(Math.min(scaleX, scaleY));
            placeVideo();
        }
        function forceScaleUpdate() { if (targetCanvas) requestAnimationFrame(applyScale); }

        // Масштаб у движка — тот, с которым картинка на самом деле на экране. Раньше движок
        // считал свой: на компьютере 1, в MZ на телефоне на 10% меньше, с плагином YEP —
        // округлённый. А игры и плагины по нему ставят поверх картинки свои поля и кнопки:
        // поле ввода имени в Moonlit Library уходило за край экрана
        function syncEngineScale(s) {
            if (typeof Graphics === 'undefined' || typeof Graphics._updateRealScale !== 'function') return;
            if (!Graphics._updateRealScale.__rpg) {
                // Меняется окно — движок пересчитывает масштаб сам; даём ему наш
                const own = Graphics._updateRealScale;
                Graphics._updateRealScale = function() {
                    own.apply(this, arguments);
                    if (this._width > 0 && this._height > 0) { const f = fit(this._width, this._height); this._realScale = Math.min(f.sx, f.sy); }
                };
                Graphics._updateRealScale.__rpg = true;
            }
            if (Graphics._realScale === s) return;
            Graphics._realScale = s;
            // Экран ошибки и видео движок ставит по масштабу — переставляем
            try { if (Graphics._errorPrinter && Graphics._updateErrorPrinter) Graphics._updateErrorPrinter(); } catch (_) {}
            try { if (Graphics._updateVideo) Graphics._updateVideo(); } catch (_) {}
        }

        // Видео движка — поверх картинки игры. Движок (и плагины вроде MovieManager) ставит
        // его по своей схеме: картинка игры по центру окна в масштабе Graphics._realScale.
        // А холст ставит rpg-fixes — со своим масштабом, растяжением и отступом от выреза.
        // Переводим положение видео из одной схемы в другую. Раньше ролик стоял мимо
        // картинки, а на телефоне — в исходном размере, срезанный краем экрана
        let watchedVideo = null;
        function placeVideo() {
            const v = (typeof Graphics !== 'undefined' && Graphics._video) || (typeof Video !== 'undefined' && Video._element);
            if (!v || !targetCanvas || !targetCanvas.width) return;
            if (watchedVideo !== v) {
                watchedVideo = v;
                // Движок и плагины двигают видео и сами — тогда пересчитываем
                new MutationObserver(placeVideo).observe(v, { attributes: true, attributeFilter: ['style', 'width', 'height'] });
                v.addEventListener('loadedmetadata', placeVideo);
            }
            const rs = (typeof Graphics !== 'undefined' && Graphics._realScale) || 1;
            const engineX = (window.innerWidth - targetCanvas.width * rs) / 2;
            const engineY = (window.innerHeight - targetCanvas.height * rs) / 2;
            let L = 0, T = 0;
            for (let e = v; e; e = e.offsetParent) { L += e.offsetLeft; T += e.offsetTop; }
            const kx = placed.sx / rs, ky = placed.sy / rs;
            const x = placed.left + (L - engineX) * kx, y = placed.top + (T - engineY) * ky;
            const t = `translate(${x - L}px, ${y - T}px) scale(${kx}, ${ky})`;
            // Сравниваем со своим прошлым значением, а не со style.transform: браузер
            // записывает его по-своему, и наблюдатель крутился бы бесконечно
            if (v.__rpgTransform !== t) {
                v.__rpgTransform = t;
                v.style.transformOrigin = '0 0';
                v.style.transform = t;
            }
        }

        const domObserver = new MutationObserver((mutations, obs) => {
            const c = document.getElementById('GameCanvas') || document.querySelector('canvas');
            if (c) {
                targetCanvas = c; resizeObserver.observe(document.body);
                // Сразу, а не к следующему кадру: плагины, которые на изменение окна
                // переставляют свои поля, должны видеть картинку уже на новом месте
                window.addEventListener('resize', () => { applyScale(); forceScaleUpdate(); });
                const canvasObserver = new MutationObserver(() => forceScaleUpdate());
                canvasObserver.observe(targetCanvas, { attributes: true, attributeFilter: ['width', 'height'] });
                const hookTimer = setInterval(() => {
                    if (typeof Graphics !== 'undefined') {
                        Graphics.pageToCanvasX = function (x) { if (!this._canvas) return 0; const rect = this._canvas.getBoundingClientRect(); return Math.round((x - rect.left) * (this._canvas.width / rect.width)); };
                        Graphics.pageToCanvasY = function (y) { if (!this._canvas) return 0; const rect = this._canvas.getBoundingClientRect(); return Math.round((y - rect.top) * (this._canvas.height / rect.height)); };
                        // Холсты ставит rpg-fixes (applyScale). Всё остальное — видео, окно ошибки —
                        // движок ставит сам, как привык. Раньше отключалось и это, и ролик
                        // оставался там, где оказался при создании
                        if (Graphics._centerElement && !Graphics._centerElement.__rpg) {
                            const center = Graphics._centerElement;
                            Graphics._centerElement = function(el) {
                                if (el && el.tagName === 'CANVAS') return;
                                return center.apply(this, arguments);
                            };
                            Graphics._centerElement.__rpg = true;
                        }
                        clearInterval(hookTimer);
                    }
                }, 100);
                setTimeout(() => clearInterval(hookTimer), 5000);
                let bootTicks = 0;
                const bootTimer = setInterval(() => { forceScaleUpdate(); if (++bootTicks > 20) clearInterval(bootTimer); }, 100);
                obs.disconnect();
            }
        });
        domObserver.observe(document.body, { childList: true, subtree: true });
        const forceModeTimer = setInterval(() => { if (typeof Utils !== 'undefined') { Utils.isNwjs = () => false; Utils.isLocal = () => false; clearInterval(forceModeTimer); } }, 50);
        setTimeout(() => clearInterval(forceModeTimer), 10000);
    }

    // Видеопамять убирает сам PIXI, как задумано в движке. Раньше здесь его уборка
    // переводилась на ручную и запускалась из changeScene — а движок зовёт его каждый кадр.
    // В MV (ядро считает мусором всё, что кадр не рисовалось) кадры анимаций на картинках
    // заново грузились в видеопамять при каждой смене: 60 загрузок вместо 3. В MZ уборка
    // не запускалась вовсе, и показанные CG копились в памяти до перезагрузки страницы
    function applyPerformanceOptimizations() {
        // ====================================================================
        // 🔥 ФИКС СНА (БЛОКИРОВКИ ЭКРАНА И СВОРАЧИВАНИЯ) 🔥
        // ====================================================================
        if (!window.__abortShieldInstalled) {
            window.__abortShieldInstalled = true;
            
            // 1. Глушим экран ошибки Ironhold Keep
            const origAddListener = window.addEventListener;
            const origRemoveListener = window.removeEventListener;
            // Обёртка на каждый слушатель одна — по ней его и снимаем. Раньше снять
            // слушатель ошибок было нельзя: removeEventListener искал исходную функцию,
            // а на окне висела обёртка
            const safeListeners = new WeakMap();
            window.addEventListener = function(type, listener, options) {
                if ((type === 'unhandledrejection' || type === 'error') && listener) {
                    let safeListener = safeListeners.get(listener);
                    if (!safeListener) {
                        safeListener = function(event) {
                            const err = event.reason || event.error || event;
                            if (err && (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('aborted')))) {
                                event.preventDefault(); event.stopPropagation(); return;
                            }
                            if (typeof listener === 'function') return listener.apply(this, arguments);
                            if (listener && typeof listener.handleEvent === 'function') return listener.handleEvent(event);
                        };
                        safeListeners.set(listener, safeListener);
                    }
                    return origAddListener.call(this, type, safeListener, options);
                }
                return origAddListener.call(this, type, listener, options);
            };
            window.removeEventListener = function(type, listener, options) {
                if ((type === 'unhandledrejection' || type === 'error') && listener && safeListeners.has(listener)) {
                    listener = safeListeners.get(listener);
                }
                return origRemoveListener.call(this, type, listener, options);
            };

            // 2. Бронируем декодер (Умный авто-повтор после сна)
            if (typeof Image !== 'undefined' && Image.prototype.decode && !Image.prototype.__safeDecode) {
                Image.prototype.__safeDecode = true;
                const origDecode = Image.prototype.decode;
                Image.prototype.decode = function() {
                    return origDecode.call(this).catch(e => {
                        if (e.name === 'AbortError' || (e.message && e.message.toLowerCase().includes('aborted'))) {
                            // Не зависаем вечно! Ждем включения экрана и пробуем загрузить картинку снова
                            return new Promise(resolve => {
                                const retry = () => resolve(origDecode.call(this).catch(()=>{}));
                                if (document.hidden) {
                                    const handler = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', handler); retry(); } };
                                    document.addEventListener('visibilitychange', handler);
                                } else {
                                    setTimeout(retry, 100);
                                }
                            });
                        }
                        throw e;
                    });
                };
            }
        }
    }

    // ============================================================================
    // 4. СИСТЕМА ОБЛАЧНЫХ СОХРАНЕНИЙ
    // ============================================================================
    function setupCloudSaves() {
        // Куда слать сейвы — говорит сервер: у игры на своём адресе это её собственный вход
        const CLOUD_BASE = (window.__RPG && window.__RPG.saves) || '/api/saves';
        const CLOUD_INIT_GRACE_MS = 1800;
        const CLOUD_RETRY_MAX = 3;

        const fastCoreTimer = setInterval(() => {
            if (typeof StorageManager !== 'undefined') StorageManager.isLocalMode = () => false;
            if (typeof DataManager !== 'undefined') { 
                if (!DataManager.setAutoSaveFileId) DataManager.setAutoSaveFileId = () => {}; 
                if (!DataManager.autoSaveFileId) DataManager.autoSaveFileId = () => 1; 
                clearInterval(fastCoreTimer);
            }
        }, 5);
        setTimeout(() => clearInterval(fastCoreTimer), 10000);

        const gameId = GAME_ID;
        let pulledSaves = {}; 
        let cloudReady = false; 
        let cloudFetchFailed = false; 
        const cloudInitStartedAt = Date.now();

        const QUEUE_KEY = `_rpg_offline_queue_${gameId}`;
        function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}'); } catch(e) { return {}; } }
        // Очередь под прежним, «исправленным» именем игры (см. GAME_ID) — в очередь под настоящим
        if (LEGACY_GAME_ID !== gameId) {
            try {
                const legacyKey = `_rpg_offline_queue_${LEGACY_GAME_ID}`;
                const legacy = JSON.parse(localStorage.getItem(legacyKey) || 'null');
                if (legacy && typeof legacy === 'object') {
                    const q = getQueue();
                    for (const k of Object.keys(legacy)) {
                        if (!q[k] || (Number(legacy[k] && legacy[k].updatedAt) || 0) > (Number(q[k].updatedAt) || 0)) q[k] = legacy[k];
                    }
                    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
                    localStorage.removeItem(legacyKey);
                }
            } catch (e) {}
        }
        // localStorage один на все игры библиотеки и всего около 5 МБ, а сейв большой
        // игры — мегабайт. Не влезло — не повод срывать сохранение: отправка на сервер
        // всё равно уходит. Раньше исключение отсюда прерывало сохранение ещё до отправки
        function saveQueue(q) {
            try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); return true; }
            catch (e) { return false; }
        }
        // То, что не влезло в очередь, держим в памяти вкладки: вернётся сеть — отправим
        const memQueue = {};

        const syncDiv = document.createElement('div');
        syncDiv.id = '_cloud_sync_ui';
        // Как плашка _game_note (тёмный фон, золотая рамка, system-ui); состояние — полосой слева, а не заливкой
        syncDiv.style.cssText = 'display:none; position:fixed; top:15px; left:50%; transform:translateX(-50%); max-width:min(90vw, 520px); background:rgba(14,14,18,0.92); color:#fff; padding:7px 16px; border-radius:8px; z-index:2147483647; font:600 13px/1.35 system-ui, sans-serif; text-align:center; border:1px solid rgba(217,180,94,0.45); border-left:3px solid #d9b45e; pointer-events:none; box-shadow:0 4px 10px rgba(0,0,0,0.5);';
        document.body.appendChild(syncDiv);

        let syncCount = 0;
        function showSync(active, status = 'ok') {
            if (!syncDiv) return;
            if (active) { 
                syncCount++; syncDiv.textContent = T.sync_busy; syncDiv.style.borderLeftColor = '#d9b45e'; syncDiv.style.display = 'block'; 
            } else { 
                syncCount--; 
                if (syncCount <= 0) { 
                    syncCount = 0; 
                    if (status === 'ok') { syncDiv.textContent = T.sync_ok; syncDiv.style.borderLeftColor = '#7fc7a5'; }
                    else if (status === 'offline') { syncDiv.textContent = T.sync_offline; syncDiv.style.borderLeftColor = '#d6a848'; }
                    else if (status === 'lost') { syncDiv.textContent = T.sync_lost; syncDiv.style.borderLeftColor = '#b06a6a'; }
                    else if (status === 'conflict') { syncDiv.textContent = T.sync_conflict; syncDiv.style.borderLeftColor = '#d6a848'; }
                    else { syncDiv.textContent = T.sync_error; syncDiv.style.borderLeftColor = '#b06a6a'; }
                    // Предупреждение о несохранённом висит дольше: его нельзя пропустить
                    setTimeout(() => { if (syncCount === 0) syncDiv.style.display = 'none'; }, status === 'lost' ? 8000 : status === 'conflict' ? 6000 : 2000); 
                } 
            }
        }

        async function retryFetch(url, init, retries = CLOUD_RETRY_MAX) {
            let lastErr;
            for (let i = 0; i <= retries; i++) { 
                try { return await fetch(url, init); } 
                catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 250 * Math.pow(2, i))); } 
            }
            throw lastErr;
        }

        function normalizeCloudPayload(raw) {
            const out = {}; 
            if (!raw || typeof raw !== 'object') return out;
            for (const k of Object.keys(raw)) {
                const v = raw[k];
                out[k] = (v && typeof v === 'object' && 'value' in v) ? { value: String(v.value ?? ''), updatedAt: Number(v.updatedAt || 0) } : { value: String(v ?? ''), updatedAt: 0 };
            }
            return out;
        }

        function chooseNewer(a, b) { if (!a) return b; if (!b) return a; return (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a; }
        function getEntry(key) { return pulledSaves[key]; } 
        function hasEntry(key) { return pulledSaves[key] !== undefined; }

        async function processOfflineQueue() {
            if (!navigator.onLine) return;
            const q = getQueue();
            const pending = { ...q };
            for (const k of Object.keys(memQueue)) pending[k] = chooseNewer(pending[k], memQueue[k]);
            const keys = Object.keys(pending);
            if (keys.length === 0) return;

            showSync(true);
            let allOk = true;
            let conflict = false;

            for (const key of keys) {
                try {
                    const res = await retryFetch(`${CLOUD_BASE}/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}`, { 
                        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending[key]) 
                    });
                    if (res.ok) {
                        // Сейв из очереди старше того, что на сервере: сервер положил его в историю
                        if ((await res.json().catch(() => ({}))).kept === 'server') conflict = true;
                        delete q[key];
                        if (memQueue[key] && memQueue[key].updatedAt <= pending[key].updatedAt) delete memQueue[key];
                    } else allOk = false;
                } catch(e) { allOk = false; }
            }
            saveQueue(q);
            showSync(false, !allOk ? 'error' : conflict ? 'conflict' : 'ok');
        }

        window.addEventListener('online', () => track(processOfflineQueue()));

        async function fetchCloudSaves() {
            try {
                const res = await retryFetch(`${CLOUD_BASE}/${encodeURIComponent(gameId)}?_t=${Date.now()}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                
                const cloudData = normalizeCloudPayload(await res.json());
                const localQueue = getQueue();
                
                for (const k of Object.keys(cloudData)) pulledSaves[k] = chooseNewer(pulledSaves[k], cloudData[k]);
                for (const k of Object.keys(localQueue)) pulledSaves[k] = chooseNewer(pulledSaves[k], localQueue[k]);

                cloudReady = true; cloudFetchFailed = false;
                try { const sc = (typeof SceneManager !== 'undefined' && SceneManager._scene) ? SceneManager._scene : null; if (sc?.refresh) sc.refresh(); if (sc?._listWindow?.refresh) sc._listWindow.refresh(); } catch (_) {}
                track(processOfflineQueue());
            } catch (e) { 
                cloudFetchFailed = true; cloudReady = true; 
                const localQueue = getQueue();
                for (const k of Object.keys(localQueue)) pulledSaves[k] = chooseNewer(pulledSaves[k], localQueue[k]);
            }
        }

        // Запросы к облаку, которые ещё идут: перед уходом из игры их дожидаемся (leaveGame)
        const inflight = new Set();
        const track = (p) => { const done = () => inflight.delete(p); inflight.add(p); p.then(done, done); return p; };

        // Данные плагинов (общие сейвы, настройки — см. setupGameStorage) уходят тихо и не
        // чаще раза в полсекунды: плагин может писать их подряд, а значок «Сохранено» — для сейвов
        const pendingSend = {};
        function uploadToCloud(key, value, opts = {}) {
            const payload = { value: String(value), updatedAt: Date.now() };
            // Слот — и снимок экрана к нему (в библиотеке видно, где был, когда сохранился). Снимаем сейчас, а отправляем,
            // когда сервер принял сам сейв: снимок привязан к его времени
            let shot = '';
            if (!opts.quiet && /file\d+$/i.test(key)) { try { shot = sceneShot(); } catch (e) { shot = ''; } }
            pulledSaves[key] = chooseNewer(pulledSaves[key], payload); 
            const q = getQueue(); q[key] = payload;
            // Не влезло в localStorage — сейв держится в памяти, пока вкладка открыта
            const queued = saveQueue(q);
            if (queued) delete memQueue[key]; else memQueue[key] = payload;
            const ui = opts.quiet ? () => {} : showSync;
            const send = () => {
                delete pendingSend[key];
                ui(true);
                if (!navigator.onLine) { ui(false, queued ? 'offline' : 'lost'); return; }
                track(retryFetch(`${CLOUD_BASE}/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}`, { 
                    method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) 
                }).then(async r => {
                    if (r.ok) {
                        // Пока шёл запрос, могли записать новее — его из очереди не убираем
                        const qNew = getQueue();
                        if (qNew[key] && qNew[key].updatedAt <= payload.updatedAt) { delete qNew[key]; saveQueue(qNew); }
                        if (memQueue[key] === payload) delete memQueue[key];
                        // На сервере этот слот новее (сохранялись на другом устройстве): присланный — в истории
                        const body = await r.json().catch(() => ({}));
                        ui(false, body.kept === 'server' ? 'conflict' : 'ok');
                        if (shot && body.kept !== 'server') sendShot(key, shot, payload.updatedAt);
                    } else ui(false, queued ? 'error' : 'lost');
                }).catch(() => ui(false, queued ? 'offline' : 'lost')));
            };
            if (pendingSend[key]) clearTimeout(pendingSend[key].timer);
            if (opts.quiet) pendingSend[key] = { timer: setTimeout(send, 500), send }; else send();
        }

        function sendShot(key, thumb, updatedAt) {
            track(fetch(`${CLOUD_BASE}/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}/shot`, {
                method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thumb, updatedAt }),
            }).catch(() => {}));
        }

        function deleteFromCloud(key, opts = {}) {
            if (pendingSend[key]) clearTimeout(pendingSend[key].timer);
            delete pendingSend[key];
            delete pulledSaves[key]; delete memQueue[key];
            const q = getQueue(); delete q[key]; saveQueue(q);
            const ui = opts.quiet ? () => {} : showSync;
            ui(true);
            if (!navigator.onLine) { ui(false, 'offline'); return; }

            track(retryFetch(`${CLOUD_BASE}/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
                .then(r => ui(false, r.ok ? 'ok' : 'error')).catch(() => ui(false, 'offline')));
        }

        // Ключи, под которыми сейвы пишет сам движок MV: их в облако отправляет обёртка движка
        // (injectMVEngine). Имена бывают свои — «RPG Battle Demon Kirsten ov1.0.3 File1», —
        // поэтому запоминаем их, когда движок ими пользуется
        const engineKeys = new Set();
        cloudApi = {
            ready: () => cloudReady,
            engineKey: (key) => engineKeys.has(key.replace(/bak$/, '')),
            get: (key) => (pulledSaves[key] !== undefined ? pulledSaves[key].value : null),
            keys: () => Object.keys(pulledSaves),
            put: (key, value) => uploadToCloud(key, value, { quiet: true }),
            remove: (key) => deleteFromCloud(key, { quiet: true }),
            // Отложенное — отправить сразу; ответ — когда всё, что в пути, долетело
            flush: () => {
                Object.values(pendingSend).forEach(p => { clearTimeout(p.timer); p.send(); });
                return Promise.allSettled([...inflight]);
            },
        };

        function canOptimisticallyShowExists(localExists) {
            if (cloudReady) return false;
            return ((Date.now() - cloudInitStartedAt) <= CLOUD_INIT_GRACE_MS) ? true : !!localExists;
        }

        function injectMZEngine() {
            const _saveToForage = StorageManager.saveToForage; 
            StorageManager.saveToForage = function(saveName, zip) { uploadToCloud(`MZ_${saveName}`, zip); return _saveToForage.apply(this, arguments); };
            const _loadFromForage = StorageManager.loadFromForage; 
            StorageManager.loadFromForage = function(saveName) { const key = `MZ_${saveName}`; if (cloudReady && hasEntry(key)) return Promise.resolve(getEntry(key).value); return _loadFromForage.apply(this, arguments); };
            const _removeForage = StorageManager.removeForage; 
            StorageManager.removeForage = function(saveName) { deleteFromCloud(`MZ_${saveName}`); return _removeForage.apply(this, arguments); };
            const _forageExists = StorageManager.forageExists; 
            StorageManager.forageExists = function(saveName) { const local = _forageExists.apply(this, arguments); if (!cloudReady) return canOptimisticallyShowExists(local); return hasEntry(`MZ_${saveName}`) || local; };
        }

        function injectMVEngine() {
            const _loadFromWebStorage = StorageManager.loadFromWebStorage; 
            StorageManager.loadFromWebStorage = function(saveFileId) { 
                const key = this.webStorageKey(saveFileId); 
                engineKeys.add(key);
                if (cloudReady && hasEntry(key)) {
                    let val = getEntry(key).value;
                    if (val && typeof val === 'string' && !val.trim().startsWith('{') && !val.trim().startsWith('[')) {
                        try { if (typeof LZString !== 'undefined') { const decompressed = LZString.decompressFromBase64(val); if (decompressed) val = decompressed; } } catch(e) {}
                    }
                    return val;
                }
                return _loadFromWebStorage.apply(this, arguments); 
            };
            if (StorageManager.webStorageExists) { 
                const _webStorageExists = StorageManager.webStorageExists; 
                StorageManager.webStorageExists = function(saveFileId) { engineKeys.add(this.webStorageKey(saveFileId)); const local = _webStorageExists.apply(this, arguments); if (!cloudReady) return canOptimisticallyShowExists(local); return hasEntry(this.webStorageKey(saveFileId)) || local; }; 
            }
            // Копия в браузере — запасная: сейв уже ушёл на сервер (или в очередь).
            // localStorage один на все игры и быстро кончается: слот большой игры весит
            // мегабайт. Раньше переполнение здесь
            // бросало исключение, движок считал сохранение проваленным и в блоке спасения
            // удалял слот — вместе с его копией на сервере
            const _saveToWebStorage = StorageManager.saveToWebStorage; 
            StorageManager.saveToWebStorage = function(saveFileId, json) {
                engineKeys.add(this.webStorageKey(saveFileId));
                uploadToCloud(this.webStorageKey(saveFileId), json);
                try { return _saveToWebStorage.apply(this, arguments); }
                catch (e) { console.warn('[RPG Fixes] Копия сейва в браузере не записана (нет места), на сервере он есть:', e && e.name); }
            };
            // Резервная копия слота перед записью — тоже только в браузере и тоже не повод
            // срывать сохранение
            if (StorageManager.backup) {
                const _backup = StorageManager.backup;
                StorageManager.backup = function() {
                    try { return _backup.apply(this, arguments); }
                    catch (e) { console.warn('[RPG Fixes] Резервная копия слота в браузере не записана:', e && e.name); }
                };
            }

            // Если сохранение всё же упало (например, ошибка плагина), MV в блоке спасения
            // удаляет слот и возвращает резервную копию. Это удаление на сервер не пускаем:
            // там лежит предыдущий, целый сейв этого слота. Обёртку ставим и сейчас, и
            // после загрузки плагинов — плагин мог заменить saveGame своей версией
            let saving = 0;
            const guardSaveGame = () => {
                if (typeof DataManager === 'undefined' || !DataManager.saveGame || DataManager.saveGame.__rpgGuarded) return;
                const _saveGame = DataManager.saveGame;
                DataManager.saveGame = function() {
                    saving++;
                    try {
                        const r = _saveGame.apply(this, arguments);
                        // Когда игра сохранилась своим меню — для вопроса при закрытии вкладки (setupSceneMarks). MZ сохраняет
                        // обещанием — время, когда оно выполнилось
                        const done = () => { window.__rpgSavedAt = Date.now(); };
                        if (r && typeof r.then === 'function') r.then(done, () => {}); else if (r !== false) done();
                        return r;
                    } finally { saving--; }
                };
                DataManager.saveGame.__rpgGuarded = true;
            };
            guardSaveGame();
            const guardTimer = setInterval(guardSaveGame, 500);
            setTimeout(() => clearInterval(guardTimer), 30000);

            const _removeWebStorage = StorageManager.removeWebStorage; 
            StorageManager.removeWebStorage = function(saveFileId) {
                engineKeys.add(this.webStorageKey(saveFileId));
                if (!saving) deleteFromCloud(this.webStorageKey(saveFileId));
                return _removeWebStorage.apply(this, arguments);
            };
        }

        fetchCloudSaves();
        // Игра стартует, когда сейвы из облака уже пришли. Иначе то, что игра и плагины
        // читают при запуске (список сохранений MZ, общий сейв, открытые сцены), на новом
        // устройстве оказалось бы пустым, и первая же запись затёрла бы облачную копию.
        // Обычно облако приходит раньше, чем игра загрузится; без сети ждать нечего, и
        // дольше 4 секунд не ждём. Проверка — до исходной: MZ в ней и читает сохранения
        const bootGate = setInterval(() => {
            if (typeof Scene_Boot === 'undefined' || !Scene_Boot.prototype.isReady) return;
            clearInterval(bootGate);
            const _isReady = Scene_Boot.prototype.isReady;
            Scene_Boot.prototype.isReady = function() {
                if (!cloudReady && Date.now() - cloudInitStartedAt < 4000) return false;
                return _isReady.apply(this, arguments);
            };
        }, 20);
        setTimeout(() => clearInterval(bootGate), 15000);
        const hookTimer = setInterval(() => {
            if (typeof StorageManager === 'undefined') return;
            if (StorageManager.saveToForage) { clearInterval(hookTimer); injectMZEngine(); } 
            else if (StorageManager.saveToWebStorage) { clearInterval(hookTimer); injectMVEngine(); }
        }, 100);
        setTimeout(() => clearInterval(hookTimer), 15000);
        window.addEventListener('pageshow', () => { if (cloudFetchFailed) fetchCloudSaves(); });
    }

    // Хранилище браузера — своё у каждой игры. Все игры библиотеки открываются с одного
    // адреса, а localStorage у адреса один. MV хранит сейвы под одинаковыми для всех игр
    // ключами («RPG File1», «RPG Global», «RPG Config»), плагины — под своими: «RPG Common»
    // у UTA_CommonSave один на 11 игр. Игры видели чужие сейвы, затирали друг другу слоты,
    // общие сейвы и громкость, а без сети игра загружала то, что записала другая. Теперь
    // ключи игры живут под её именем («rpgm:<игра>:RPG File1»), как на компьютере в папке
    // игры. Свои ключи rpg-fixes (rpg_*, rpgfix*, _rpg*) остаются общими
    function setupGameStorage() {
        let ls = null;
        try { ls = window.localStorage; } catch (_) {}
        const P = window.Storage && Storage.prototype;
        if (!ls || !P || P.__rpgGameStorage) return;
        const raw = { get: P.getItem, set: P.setItem, remove: P.removeItem, key: P.key, clear: P.clear };
        const lengthOf = Object.getOwnPropertyDescriptor(P, 'length').get;
        const NS = `rpgm:${GAME_ID}:`;
        const ours = (k) => /^(rpg_|rpgfix|_rpg|rpgm:)/.test(k);
        const rget = (k) => { try { return raw.get.call(ls, k); } catch (_) { return null; } };
        const rkeys = () => { const out = []; try { for (let i = 0; i < lengthOf.call(ls); i++) out.push(raw.key.call(ls, i)); } catch (_) {} return out; };
        // Сейвы MV уходят в облако обёрткой движка (setupCloudSaves). Здесь через облако идут
        // остальные ключи игры — общие сейвы и настройки плагинов, файлы её папки save/ — под
        // приставкой «LS:»: в том же виде, что в браузере, и не путаясь с ключами движка
        const mvSave = (k) => /^RPG (File\d+(bak)?|Global)$/.test(k);
        const viaCloud = (k) => !/^RPG (File\d+(bak)?|Global|Config)$/.test(k) && !k.includes('/') && !/^localforage/.test(k) && !(cloudApi && cloudApi.engineKey(k));
        const CK = (k) => 'LS:' + k;

        // Какие ключи игра уже трогала. Прежнее общее значение ключа она забирает себе
        // один раз — иначе удалённое игрой возвращалось бы из общего
        const SEEN = NS + '~seen';
        let seen;
        try { seen = new Set(JSON.parse(rget(SEEN) || '[]')); } catch (_) { seen = new Set(); }
        const markSeen = (k) => {
            if (seen.has(k)) return;
            seen.add(k);
            try { raw.set.call(ls, SEEN, JSON.stringify([...seen])); } catch (_) {}
        };

        // Прежние сейвы MV лежат под общими ключами. Свои — те, где записано название этой
        // игры (MV пишет его в список сохранений): переносим их к ней один раз, пока их нет
        // в её части. Чужие не трогаем — их заберёт своя игра
        let mvAdopted = false;
        function adoptMvSaves() {
            if (mvAdopted) return;
            const DONE = NS + '~mv';
            if (rget(DONE)) { mvAdopted = true; return; }
            // Название — из данных игры: до их загрузки не понять, какие сейвы её
            if (!window.$dataSystem || typeof LZString === 'undefined') return;
            mvAdopted = true;
            try { raw.set.call(ls, DONE, '1'); } catch (_) {}
            const unpack = (s) => { try { return s ? JSON.parse(LZString.decompressFromBase64(s)) : null; } catch (_) { return null; } };
            const pack = (v) => LZString.compressToBase64(JSON.stringify(v));
            const old = unpack(rget('RPG Global'));
            if (!Array.isArray(old)) return;
            const mine = unpack(rget(NS + 'RPG Global'));
            const list = Array.isArray(mine) ? mine : [];
            let moved = 0;
            old.forEach((info, i) => {
                if (!i || !info || info.title !== $dataSystem.gameTitle || list[i]) return;
                const file = rget('RPG File' + i);
                if (!file || rget(NS + 'RPG File' + i) !== null) return;
                try {
                    raw.set.call(ls, NS + 'RPG File' + i, file);
                    const bak = rget('RPG File' + i + 'bak');
                    if (bak) raw.set.call(ls, NS + 'RPG File' + i + 'bak', bak);
                    list[i] = info;
                    old[i] = null;
                    moved++;
                    // Перенесённое из общего убираем: место в localStorage одно на все игры
                    raw.remove.call(ls, 'RPG File' + i);
                    raw.remove.call(ls, 'RPG File' + i + 'bak');
                } catch (_) {}
            });
            if (!moved) return;
            try { raw.set.call(ls, NS + 'RPG Global', pack(list)); } catch (_) {}
            try { if (old.some(Boolean)) raw.set.call(ls, 'RPG Global', pack(old)); else raw.remove.call(ls, 'RPG Global'); } catch (_) {}
            console.log(`[RPG Fixes] 💾 Прежние сейвы этой игры перенесены в её хранилище: ${moved}`);
        }

        function get(k) {
            if (mvSave(k)) adoptMvSaves();
            if (viaCloud(k) && cloudApi && cloudApi.ready()) {
                const c = cloudApi.get(CK(k));
                if (c !== null) {
                    if (rget(NS + k) !== c) { try { raw.set.call(ls, NS + k, c); } catch (_) {} }
                    return c;
                }
            }
            let v = rget(NS + k);
            if (v === null && !mvSave(k) && !seen.has(k)) {
                markSeen(k);
                const shared = rget(k);
                if (shared !== null) { try { raw.set.call(ls, NS + k, shared); } catch (_) {} v = shared; }
            }
            return v;
        }
        function set(k, v) {
            v = String(v);
            markSeen(k);
            // Сначала в облако: не влезет в браузер — не пропадёт
            if (viaCloud(k) && cloudApi) cloudApi.put(CK(k), v);
            raw.set.call(ls, NS + k, v);
        }
        function remove(k) {
            markSeen(k);
            if (viaCloud(k) && cloudApi) cloudApi.remove(CK(k));
            raw.remove.call(ls, NS + k);
        }
        // clear() стёр бы данные всех игр и самой библиотеки — стираем только эту игру
        function clearGame() {
            rkeys().filter(k => k && k.startsWith(NS) && !k.startsWith(NS + '~')).forEach(k => { try { raw.remove.call(ls, k); } catch (_) {} });
        }

        P.getItem = function(k) { if (this !== ls || ours(String(k))) return raw.get.apply(this, arguments); return get(String(k)); };
        P.setItem = function(k, v) { if (this !== ls || ours(String(k))) return raw.set.apply(this, arguments); return set(String(k), v); };
        P.removeItem = function(k) { if (this !== ls || ours(String(k))) return raw.remove.apply(this, arguments); return remove(String(k)); };
        P.clear = function() { if (this !== ls) return raw.clear.apply(this, arguments); return clearGame(); };
        // «Есть ли ключ» плагины спрашивают и так: localStorage.hasOwnProperty(key) (DKTools.IO.WebStorage).
        // Ключи игры лежат под её приставкой, и обычный ответ был бы «нет» всегда: DKTools_Localization
        // не видел сохранённого языка и после выбора возвращал к выбору языка по кругу (Moonlit
        // Library). Отвечаем по хранилищу игры. Повесить функцию прямо на
        // localStorage нельзя — присвоение там становится записью строки, — поэтому на прототип
        const ownHas = Object.prototype.hasOwnProperty;
        P.hasOwnProperty = function(k) {
            if (this !== ls || ours(String(k))) return ownHas.call(this, k);
            return get(String(k)) !== null;
        };
        P.__rpgGameStorage = true;

        gameStorage = {
            get, set, remove,
            // Ключи игры с этим началом — в браузере и в облаке (для fs.readdirSync)
            list: (prefix) => {
                const out = new Set();
                rkeys().forEach(k => { if (k && k.startsWith(NS + prefix)) out.add(k.slice(NS.length)); });
                if (cloudApi && cloudApi.ready()) cloudApi.keys().forEach(k => { if (k.startsWith(CK(prefix))) out.add(k.slice(3)); });
                return [...out];
            },
        };
    }

    // ============================================================================
    // 5. ИНТЕРФЕЙС: МЕНЮ ⚙ И ЭКРАННОЕ УПРАВЛЕНИЕ
    // ============================================================================
    const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || IS_IOS;
    // По строке браузера телефон узнаётся не всегда: Chrome на больших Android-планшетах
    // (Lenovo IdeaTab Pro и т. п.) по умолчанию открывает сайты «как на компьютере» и
    // называет себя Linux — экранного управления там не было вовсе. Поэтому смотрим и на
    // сам экран: есть ли сенсор и чем в основном управляют — пальцем или мышью
    const HAS_TOUCH = IS_MOBILE || navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    const TOUCH_FIRST = IS_MOBILE || !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    // Экранное управление показывает себя само при касании экрана (setupTouchControls); это
    // касание ловим здесь, раньше перехватчика касаний по игре — он их глотает
    let showTouchControls = () => {};
    // Наши окна и кнопки поверх игры. И окно чит-меню: без этого его на телефоне нельзя
    // было нажать пальцем
    const OUR_UI = '#_sys_menu_container, #_mob_ctrl, #_fps_monitor, #_spike_panel, #_cheats, #_panic';
    // Поля и кнопки, которые ставит поверх картинки сама игра: «Retry» на экране ошибки
    // загрузки, окна ввода имени и пароля у плагинов
    const GAME_CONTROLS = 'button, input, textarea, select, a[href], label, [contenteditable="true"]';
    const isGameControl = (el) => !!(el && el.closest && el.closest(GAME_CONTROLS) && !el.closest(OUR_UI));

    // Значки одной тонкой линией, цвет берут от текста. Раньше у каждого пункта был
    // свой смайлик: на каждой платформе они рисуются по-своему и выглядели случайными
    const ICONS = {
        gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        home: '<path d="M3 11l9-7 9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
        restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4h4"/>',
        fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
        stretch: '<path d="M3 12h18"/><path d="M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
        smooth: '<path d="M3 15c3-6 6-6 9 0s6 6 9 0"/>',
        turbo: '<path d="M4 6l7 6-7 6zM13 6l7 6-7 6z"/>',
        auto: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
        clean: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/>',
        mute: '<path d="M4 9.5h4l5-4v13l-5-4H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>',
        tap: '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="7"/>',
        keys: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h.01M11 11h.01M15 11h.01M8 14h8"/>',
        skip: '<path d="M4 7l6 5-6 5M11 7l6 5-6 5"/>',
        wand: '<path d="M4 20L15 9"/><path d="M15 3v3M18.5 5.5l-2 2M21 9h-3M18.5 12.5l-2-2"/>',
        fps: '<path d="M4 20h16M7 16v-4M12 16V8M17 16v-6"/>',
        pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
        chevron: '<path d="M7 14.5l5-5 5 5"/>',
        prev: '<path d="M14.5 6l-6 6 6 6"/>',
        next: '<path d="M9.5 6l6 6-6 6"/>',
        bookmark: '<path d="M6.5 4h11v16l-5.5-4-5.5 4z"/>',
        camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
        rewind: '<path d="M11 6l-7 6 7 6zM20 6l-7 6 7 6z"/>',
        hide: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 5 9 7a8.6 8.6 0 0 1-2.4 3.4M6.4 6.5C4.3 7.9 3 10.4 3 12c0 2 4 7 9 7a9.4 9.4 0 0 0 4.2-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    };
    const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

    // Нажатие — когда палец отпустили там же, где коснулись. Раньше пункт срабатывал
    // в момент касания: лёжа на телефоне меню не влезает по высоте, и, листая его,
    // человек включал всё, до чего дотронулся. Сдвинул палец — это прокрутка, не нажатие
    function onTap(el, fn) {
        let start = null;
        el.addEventListener('pointerdown', (e) => {
            start = e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
        });
        el.addEventListener('pointermove', (e) => {
            if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) start = null;
        });
        // Браузер начал прокрутку — касание уже не наше
        el.addEventListener('pointercancel', () => { start = null; });
        el.addEventListener('pointerup', (e) => {
            if (!start || e.pointerId !== start.id) return;
            start = null;
            // Щелчок, который браузер пошлёт следом, попал бы в то, что пункт открыл под пальцем (кнопку чит-меню) — гасим.
            // Только в той же точке: настоящий щелчок в другом месте проходит
            const x = e.clientX, y = e.clientY;
            const swallow = (ev) => { if (Math.hypot(ev.clientX - x, ev.clientY - y) < 16) { ev.stopPropagation(); ev.preventDefault(); } };
            document.addEventListener('click', swallow, { capture: true });
            setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 350);
            fn();
        });
    }

    // Пункты меню приходят из разных частей файла (экран, управление, диагностика,
    // читы), а рисуются здесь, по разделам и всегда в одном порядке. Разделы собраны
    // в две колонки: на высоком экране они идут одна под другой, на низком (телефон
    // лёжа) — рядом, и листать меню не нужно. Колонки примерно поровну: лёжа
    // на iPhone 13 в высоту помещается шесть пунктов
    const MENU_COLUMNS = [['nav', 'game'], ['screen', 'controls', 'debug']];
    const menuItems = [];
    function addMenuItem(item) { menuItems.push(item); renderMenu(); }
    function closeMenu() {
        document.querySelectorAll('#_sys_panel ._pad').forEach((el) => el.classList.remove('_pad'));
        document.getElementById('_sys_panel')?.classList.remove('_open');
        document.getElementById('_sys_btn')?.classList.remove('_open');
    }
    function openMenu() {
        document.getElementById('_sys_panel')?.classList.add('_open');
        document.getElementById('_sys_btn')?.classList.add('_open');
        renderMenu();   // состояние переключателей могло поменяться с клавиатуры
    }
    function menuButton(item) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = '_sys_item';
        el.id = item.id;
        // Клавишу в конце подписи «Турбо ×3 (T)» выносим вправо в рамку; сама подпись (и перевод) остаётся прежней
        const keyed = /^(.*\S)\s+\(([^()\s]{1,2})\)$/.exec(String(item.label));
        const text = keyed ? keyed[1] : item.label;
        el.innerHTML = `<span class="_sys_ico">${icon(item.icon)}</span><span class="_sys_label">${text}</span>` + (keyed ? `<kbd class="_sys_key">${keyed[2]}</kbd>` : '') + (item.isOn ? '<span class="_sys_switch"></span>' : '');
        if (item.isOn) el.classList.toggle('_on', !!item.isOn());
        // Касание или кнопка A геймпада (setupPadKeys)
        el._activate = () => {
            // onClick вернул true — меню остаётся открытым (подтверждение перезапуска)
            const keepOpen = item.onClick(el);
            if (item.isOn) el.classList.toggle('_on', !!item.isOn());
            else if (!keepOpen) closeMenu();
        };
        onTap(el, el._activate);
        return el;
    }
    function renderMenu() {
        const panel = document.getElementById('_sys_panel');
        if (!panel) return;
        panel.innerHTML = '';
        for (const sections of MENU_COLUMNS) {
            const col = document.createElement('div');
            col.className = '_sys_col';
            for (const section of sections) {
                const items = menuItems.filter(i => i.section === section);
                if (!items.length) continue;
                const group = document.createElement('div');
                group.className = '_sys_group';
                items.forEach(item => group.appendChild(menuButton(item)));
                col.appendChild(group);
            }
            if (col.childElementCount) panel.appendChild(col);
        }
    }

    function setupUIAndGamepad() {
        // Касание экрана показывает экранное управление, если его спрятали клавиатура или
        // геймпад. Слушаем раньше перехватчика касаний по игре (setupTouchModeToggle)
        window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') showTouchControls(); }, { capture: true, passive: true });
        document.addEventListener('DOMContentLoaded', () => {
            if (document.getElementById('_sys_menu_container')) return;

            const style = document.createElement('style');
            style.textContent = `
                #_sys_menu_container, #_mob_ctrl { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
                /* Игра — картинка, выделять на странице нечего. Без этого iOS на долгое касание
                   (палец держит джойстик) показывала лупу выделения текста. Поля ввода (имя
                   героя и т. п.) выделяются, как обычно */
                html, body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
                input, textarea, [contenteditable="true"] { -webkit-user-select: text; user-select: text; }
                #_sys_menu_container svg, #_mob_ctrl svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

                #_sys_menu_container { position: fixed; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; font-size: 14px; font-weight: 500; touch-action: manipulation; }
                #_sys_btn { width: 40px; height: 40px; padding: 0; border-radius: 50%; border: 1px solid rgba(255,255,255,0.22); background: rgba(14,14,18,0.45); color: rgba(255,255,255,0.9); display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0.65; transition: opacity .2s, background .2s; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
                #_sys_btn svg { width: 20px; height: 20px; }
                #_sys_btn._open, #_sys_btn:hover { opacity: 1; background: rgba(14,14,18,0.7); }
                #_sys_panel { display: none; margin-top: 8px; min-width: 250px; box-sizing: border-box; max-width: calc(100vw - 24px); max-height: calc(100vh - 80px); max-height: calc(100dvh - 80px); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; padding: 6px; border-radius: 12px; background: rgba(19,17,26,0.97); border: 1px solid rgba(201,168,76,0.3); box-shadow: 0 12px 32px rgba(0,0,0,0.55); }
                #_sys_panel._open { display: block; }
                ._sys_item { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 40px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: #e8dfc8; font: inherit; text-align: left; cursor: pointer; }
                ._sys_item:active { background: rgba(201,168,76,0.16); }
                ._sys_item._pad { background: rgba(201,168,76,0.1); box-shadow: inset 0 0 0 2px rgba(201,168,76,0.75); }
                @media (hover: hover) { ._sys_item:hover { background: rgba(201,168,76,0.1); color: #f0d080; } ._sys_item:hover ._sys_ico { color: #f0d080; } }
                ._sys_ico { display: flex; flex-shrink: 0; color: #aa8844; }
                ._sys_ico svg { width: 20px; height: 20px; }
                ._sys_label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                /* Клавиша — рамка с толстой нижней гранью, как kbd в библиотеке. На телефоне клавиатуры нет — не показываем */
                ._sys_key { flex-shrink: 0; min-width: 22px; height: 22px; padding: 0 5px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; border: 1px solid rgba(201,168,76,0.4); border-bottom-width: 2px; border-radius: 4px; color: #aa8844; font-size: 12px; font-weight: 500; line-height: 1; }
                @media (hover: none), (pointer: coarse) { ._sys_key { display: none; } }
                /* Переключатель как .set-toggle в Настройках библиотеки: 44×24, золотая рамка, включённый — тёмное золото */
                ._sys_switch { position: relative; flex-shrink: 0; box-sizing: border-box; width: 44px; height: 24px; border-radius: 999px; background: rgba(255,255,255,0.12); border: 1px solid rgba(201,168,76,0.3); transition: background .15s, border-color .15s; }
                ._sys_switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #8f8470; transition: transform .15s; }
                ._sys_item._on ._sys_switch { background: #7a6030; border-color: #c9a84c; }
                ._sys_item._on ._sys_switch::after { transform: translateX(20px); background: #f0d080; }
                ._sys_item._warn { color: #f0b35e; }
                ._sys_item._warn ._sys_ico { color: #f0b35e; }
                ._sys_group + ._sys_group::before, ._sys_col + ._sys_col::before { content: ''; display: block; height: 1px; margin: 5px 8px; background: rgba(201,168,76,0.12); }
                /* Лёжа на телефоне меню в одну колонку не влезает по высоте — колонки встают рядом */
                @media (max-height: 500px) and (min-width: 560px) {
                    #_sys_panel._open { display: grid; grid-template-columns: 1fr 1fr; }
                    ._sys_col + ._sys_col { margin-left: 5px; padding-left: 5px; border-left: 1px solid rgba(201,168,76,0.12); }
                    ._sys_col + ._sys_col::before { display: none; }
                    ._sys_item { min-height: 34px; }
                }

                /* Экранное управление. Единица --u — от короткой стороны экрана: на телефоне
                   кнопки не закрывают полэкрана, на планшете не теряются в углу */
                #_mob_ctrl { --u: clamp(38px, 10.5vmin, 58px); position: fixed; left: 0; right: 0; bottom: 0; height: 0; z-index: 2147483646; pointer-events: none; touch-action: none; opacity: 0.92; transition: opacity .4s; }
                /* Без касаний управление гаснет, чтобы не закрывать текст диалогов */
                #_mob_ctrl._idle { opacity: 0.38; }
                ._glass { background: rgba(14,14,18,0.3); border: 1.5px solid rgba(255,255,255,0.26); color: rgba(255,255,255,0.92); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }

                /* Джойстик встаёт под палец в любом месте левого нижнего угла — целиться в
                   него не нужно. Когда касания идут в игру (или открыто чит-меню), угол
                   отдаём им, и джойстик работает только на своём месте */
                #_stick_zone { position: fixed; left: 0; bottom: 0; width: min(45vw, 440px); height: min(72vh, calc(100vh - 70px)); pointer-events: auto; touch-action: none; }
                #_mob_ctrl._zone_off #_stick_zone { pointer-events: none; }
                #_stick { position: fixed; left: calc(max(14px, env(safe-area-inset-left)) + 6px); bottom: calc(max(14px, env(safe-area-inset-bottom)) + 6px); width: calc(var(--u) * 2.35); height: calc(var(--u) * 2.35); border-radius: 50%; pointer-events: auto; touch-action: none; transition: transform .18s ease-out; }
                #_stick._float { transition: none; }
                ._stick_dir { position: absolute; width: 22%; height: 22%; color: rgba(255,255,255,0.4); transition: color .12s; }
                ._stick_dir svg { display: block; width: 100%; height: 100%; }
                ._stick_dir[data-dir="up"] { top: 3%; left: 39%; }
                ._stick_dir[data-dir="down"] { bottom: 3%; left: 39%; transform: rotate(180deg); }
                ._stick_dir[data-dir="left"] { left: 3%; top: 39%; transform: rotate(-90deg); }
                ._stick_dir[data-dir="right"] { right: 3%; top: 39%; transform: rotate(90deg); }
                ._stick_dir._on { color: #fff; }
                #_stick_knob { position: absolute; left: 29%; top: 29%; width: 42%; height: 42%; border-radius: 50%; background: rgba(255,255,255,0.18); border: 1.5px solid rgba(255,255,255,0.5); box-shadow: 0 2px 10px rgba(0,0,0,0.35); transition: transform .14s ease-out, background .12s, border-color .12s; }
                #_stick._drag #_stick_knob { transition: background .12s, border-color .12s; background: rgba(255,255,255,0.28); }
                /* Палец у самого края — бег */
                #_stick._run #_stick_knob { background: rgba(217,180,94,0.55); border-color: #d9b45e; }

                /* Справа — только то, что нужно всё время: Z, X и A дугой вокруг большого
                   пальца (Z — под ним, X — ниже и левее, A — выше и левее) и маленький
                   «Пропуск» над Z. Всё остальное — в полоске ⌨ */
                #_pad { position: fixed; right: calc(max(14px, env(safe-area-inset-right)) + 6px); bottom: calc(max(14px, env(safe-area-inset-bottom)) + 6px); width: calc(var(--u) * 2.45); height: calc(var(--u) * 2.85); pointer-events: none; }
                ._btn { position: absolute; padding: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; font: 600 calc(var(--u) * 0.42) -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; pointer-events: auto; touch-action: none; transition: transform .08s, background .08s; }
                ._btn._on { transform: scale(0.93); background: rgba(255,255,255,0.3); }
                #_btn_z { right: 0; bottom: calc(var(--u) * 0.55); width: calc(var(--u) * 1.25); height: calc(var(--u) * 1.25); border-color: rgba(255,255,255,0.42); }
                #_btn_x { right: calc(var(--u) * 1.375); bottom: calc(var(--u) * 0.05); width: calc(var(--u) * 1.05); height: calc(var(--u) * 1.05); font-size: calc(var(--u) * 0.36); }
                #_btn_a { right: calc(var(--u) * 1.305); bottom: calc(var(--u) * 1.52); width: calc(var(--u) * 0.95); height: calc(var(--u) * 0.95); font-size: calc(var(--u) * 0.34); }
                #_btn_skip { right: calc(var(--u) * 0.22); bottom: calc(var(--u) * 2.02); width: calc(var(--u) * 0.8); height: calc(var(--u) * 0.8); }
                #_btn_skip svg { width: 52%; height: 52%; }
                /* Маленькие кнопки: попасть можно и чуть мимо рисунка */
                #_btn_skip::after, #_btn_keys::after { content: ''; position: absolute; inset: -7px; border-radius: 50%; }
                ._cap { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 2px; font-size: 10px; font-weight: 500; color: rgba(232,223,200,0.65); white-space: nowrap; pointer-events: none; }
                /* Включённый переключатель видно издалека */
                ._btn._latched, #_btn_keys._latched, ._key._latched { background: rgba(255,255,255,0.9); color: #141414; border-color: transparent; }

                /* ⌨ — рядом с ⚙: нужна изредка, и место внизу у пальцев она не занимает */
                #_btn_keys { position: fixed; top: max(12px, env(safe-area-inset-top)); right: calc(max(12px, env(safe-area-inset-right)) + 48px); width: 40px; height: 40px; padding: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; pointer-events: auto; touch-action: none; opacity: 0.65; }
                #_btn_keys._latched { opacity: 1; }
                #_btn_keys svg { width: 20px; height: 20px; }

                /* Полоска ⌨ сверху по центру: бег, листание и клавиши этой игры. Вся
                   клавиатура — только по «A–Z» */
                #_keys_panel { position: fixed; top: calc(max(12px, env(safe-area-inset-top)) + 48px); left: 50%; transform: translateX(-50%); width: max-content; max-width: min(94vw, 560px); display: none; padding: 5px; border-radius: 12px; background: rgba(14,14,18,0.88); border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 8px 24px rgba(0,0,0,0.45); pointer-events: auto; }
                #_keys_panel._open { display: block; }
                ._kb_quick { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; }
                ._kb_full { display: none; width: min(86vw, 340px); margin: 5px auto 0; padding-top: 5px; border-top: 1px solid rgba(255,255,255,0.1); }
                #_keys_panel._abc ._kb_full { display: block; }
                ._kb_row { display: flex; gap: 3px; }
                ._kb_row + ._kb_row { margin-top: 3px; }
                ._key { height: 30px; min-width: 30px; padding: 0 9px; border-radius: 7px; display: flex; align-items: center; justify-content: center; gap: 4px; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; white-space: nowrap; touch-action: none; }
                ._key svg { width: 15px; height: 15px; }
                ._key small { font-size: 10px; font-weight: 500; opacity: .7; }
                ._kb_row ._key { flex: 1 1 0; min-width: 0; padding: 0; }
                ._kb_row ._key._wide { flex-grow: 3; }
                ._key._on { background: rgba(255,255,255,0.3); }

                /* Играют с клавиатуры или геймпада — кнопки не нужны и только закрывают картинку */
                #_mob_ctrl._off { display: none !important; }
            `;
            document.head.appendChild(style);

            // --- Меню ⚙ ---
            const menu = document.createElement('div');
            menu.id = '_sys_menu_container';
            menu.innerHTML = `<button type="button" id="_sys_btn" aria-label="${T.settings}" title="${T.settings}">${icon('gear')}</button><div id="_sys_panel" role="menu"></div>`;
            document.body.appendChild(menu);
            const sysBtn = document.getElementById('_sys_btn');
            const sysPanel = document.getElementById('_sys_panel');
            onTap(sysBtn, () => (sysPanel.classList.contains('_open') ? closeMenu() : openMenu()));
            // Касания и прокрутка меню — не игре: иначе MV принял бы их за касание экрана,
            // а MZ отменял бы прокрутку колесом. mousedown без действия по умолчанию —
            // чтобы кнопка не забирала фокус: иначе пробел в игре снова нажимал бы её
            ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup',
             'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel', 'click', 'contextmenu'].forEach(t => menu.addEventListener(t, (e) => {
                e.stopPropagation();
                if (t === 'contextmenu' || t === 'mousedown') e.preventDefault();
            }, { passive: !(t === 'contextmenu' || t === 'mousedown') }));
            document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) closeMenu(); });

            addMenuItem({ id: '_sys_home', section: 'nav', icon: 'home', label: T.home, onClick: toLibrary });

            // Перезапуск. В приложении с экрана «Домой» у Safari нет кнопки обновления,
            // и зависшую игру можно было только закрыть. Несохранённое пропадёт, поэтому
            // с подтверждением: первое нажатие меняет надпись, второе в течение 3 секунд
            // перезапускает
            addMenuItem({
                id: '_sys_restart', section: 'nav', icon: 'restart', label: T.restart,
                onClick: (el) => {
                    // «Взведён» — это сам пункт с новой надписью: меню при открытии рисуется
                    // заново, и старое первое нажатие не превращает новое в перезапуск
                    if (el.classList.contains('_warn')) { leaveGame(() => window.location.reload()); return true; }
                    const label = el.querySelector('._sys_label');
                    label.textContent = T.restart_confirm;
                    el.classList.add('_warn');
                    setTimeout(() => { label.textContent = T.restart; el.classList.remove('_warn'); }, 3000);
                    return true;
                },
            });

            addMenuItem({ id: '_sys_turbo', section: 'game', icon: 'turbo', label: T.turbo, isOn: () => !!window.__rpgTurbo, onClick: () => setTurbo(!window.__rpgTurbo) });

            addMenuItem({
                id: '_sys_stretch', section: 'screen', icon: 'stretch', label: T.stretch,
                isOn: () => !!(window.__rpgIsStretched && window.__rpgIsStretched()),
                onClick: () => window.__toggleRpgStretch && window.__toggleRpgStretch(),
            });
            // Сглаживание: «вкл» — плавно при дробном увеличении и чётко при целом,
            // «выкл» — всегда чёткие пиксели. Выбор запоминается (см. setupModernViewport)
            addMenuItem({
                id: '_sys_smooth', section: 'screen', icon: 'smooth', label: T.smooth,
                isOn: () => !window.__rpgSmoothing || window.__rpgSmoothing() === 'auto',
                onClick: () => window.__toggleRpgSmoothing && window.__toggleRpgSmoothing(),
            });
            if (!IS_IOS) {
                const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
                addMenuItem({
                    id: '_sys_fs', section: 'screen', icon: 'fullscreen', label: T.fullscreen,
                    isOn: isFull,
                    onClick: () => {
                        const el = document.documentElement;
                        const p = !isFull() ? (el.requestFullscreen || el.webkitRequestFullscreen).call(el) : (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                        if (p && p.catch) p.catch(() => {});
                    },
                });
                document.addEventListener('fullscreenchange', renderMenu);
                document.addEventListener('webkitfullscreenchange', renderMenu);
            }

            if (HAS_TOUCH) setupTouchControls();
        });
    }

    // Экранное управление для телефона и планшета: джойстик слева, клавиши справа.
    // Кнопки подписаны клавишами клавиатуры — Z, X, A, — как их называют сами игры в
    // подсказках («Z — выбрать, X — меню, A — автотекст»). Нажать такую кнопку — то же,
    // что нажать клавишу, а что она значит, решает раскладка игры. Раньше были A и B,
    // которые слали пробел и Esc, — и в игре, где пробел прячет окно сообщения, «A»
    // прятала текст вместо «Далее». На экране только самое нужное; остальное — в полоске
    // ⌨: бег, листание и клавиши, которые плагины этой игры повесили на свои действия,
    // а вся клавиатура — по «A–Z»
    function setupTouchControls() {
        // Клавиши, которые умеет нажимать экранное управление: код → [key, code]
        const KEYBOARD = {
            8: ['Backspace', 'Backspace'], 9: ['Tab', 'Tab'], 13: ['Enter', 'Enter'], 16: ['Shift', 'ShiftLeft'],
            17: ['Control', 'ControlLeft'], 18: ['Alt', 'AltLeft'], 27: ['Escape', 'Escape'], 32: [' ', 'Space'],
            33: ['PageUp', 'PageUp'], 34: ['PageDown', 'PageDown'], 35: ['End', 'End'], 36: ['Home', 'Home'],
            37: ['ArrowLeft', 'ArrowLeft'], 38: ['ArrowUp', 'ArrowUp'], 39: ['ArrowRight', 'ArrowRight'], 40: ['ArrowDown', 'ArrowDown'],
            45: ['Insert', 'Insert'], 46: ['Delete', 'Delete'],
        };
        for (let i = 0; i < 10; i++) KEYBOARD[48 + i] = [String(i), 'Digit' + i];
        for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); KEYBOARD[65 + i] = [c, 'Key' + c.toUpperCase()]; }
        for (let i = 1; i <= 12; i++) KEYBOARD[111 + i] = ['F' + i, 'F' + i];
        const SHORT = { 8: '⌫', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 27: 'Esc', 32: 'Space', 33: 'PgUp', 34: 'PgDn', 35: 'End', 36: 'Home', 45: 'Ins', 46: 'Del' };
        const keyLabel = (kc) => SHORT[kc] || KEYBOARD[kc][0].toUpperCase();
        const mapper = () => (typeof Input !== 'undefined' && Input.keyMapper) || {};

        function sendPhys(kc, isDown) {
            const k = KEYBOARD[kc];
            if (!k) return;
            const ev = new KeyboardEvent(isDown ? 'keydown' : 'keyup', { bubbles: true, cancelable: true, key: k[0], code: k[1] });
            Object.defineProperty(ev, 'keyCode', { get: () => kc });
            Object.defineProperty(ev, 'which', { get: () => kc });
            document.dispatchEvent(ev);
        }
        function setState(name, isDown) {
            if (typeof Input === 'undefined') return;
            if (Input._currentState) Input._currentState[name] = isDown;
            if (Input.currentState) Input.currentState[name] = isDown;
        }

        // «Бег», «Пропуск» и листание — действия, а не клавиши. Жмём ту клавишу, которая
        // в этой игре значит это действие. Своя занята чужим (в Ashen Crown Ctrl
        // листает страницы) — не жмём ничего, а сообщаем движку действие напрямую
        const ACTIONS = { dash: ['shift', 16], skip: ['control', 17, 18], pageup: ['pageup', 81, 33], pagedown: ['pagedown', 87, 34] };
        const actionAs = {};          // чем нажали — тем и отпускаем
        const actHeld = new Set();    // зажатые действия
        const physHeld = new Set();   // зажатые клавиши
        const latched = new Set();    // включённые переключатели «Бег» и «Пропуск»
        function sendAction(act, isDown) {
            const [name, ...codes] = ACTIONS[act];
            if (isDown) {
                const map = mapper();
                const kc = codes.find(c => map[c] === name);
                actionAs[act] = kc ? { kc } : { state: name, kc: map[codes[0]] === undefined ? codes[0] : 0 };
                actHeld.add(act);
            } else actHeld.delete(act);
            const how = actionAs[act];
            if (!how) return;
            if (how.state) setState(how.state, isDown);
            if (how.kc) sendPhys(how.kc, isDown);
            if (!isDown) delete actionAs[act];
        }
        // Стрелка — это стрелка. Если игра её никуда не привязала, направление — движку напрямую
        const DIRS = { up: 38, down: 40, left: 37, right: 39 };
        function sendDir(dir, isDown) {
            if (mapper()[DIRS[dir]] === undefined) setState(dir, isDown);
            sendPhys(DIRS[dir], isDown);
        }

        const root = document.createElement('div');
        root.id = '_mob_ctrl';
        root.innerHTML = `
            <div id="_stick_zone"></div>
            <div id="_stick" class="_glass" role="application" aria-label="${T.stick}">
                ${['up', 'down', 'left', 'right'].map(d => `<i class="_stick_dir" data-dir="${d}">${icon('chevron')}</i>`).join('')}
                <div id="_stick_knob"></div>
            </div>
            <div id="_pad">
                <button type="button" id="_btn_skip" class="_btn _glass" data-act="skip" data-latch="1" aria-label="${T.skip_hint}">${icon('skip')}</button>
                <button type="button" id="_btn_a" class="_btn _glass" data-kc="65" aria-label="${T.a_hint}">A<span class="_cap"></span></button>
                <button type="button" id="_btn_x" class="_btn _glass" data-kc="88" aria-label="${T.back_hint}">X<span class="_cap">${T.back}</span></button>
                <button type="button" id="_btn_z" class="_btn _glass" data-kc="90" aria-label="${T.ok_hint}">Z<span class="_cap">${T.ok}</span></button>
            </div>
            <button type="button" id="_btn_keys" class="_glass" aria-label="${T.keys}">${icon('keys')}</button>
            <div id="_keys_panel" role="dialog" aria-label="${T.keys}"></div>`;
        document.body.appendChild(root);

        // Касания по управлению — не игре: иначе MV увидел бы их как касание экрана. И не iOS:
        // долгое касание (палец держит джойстик) она начинала как выделение текста и
        // показывала лупу. Фон полоски клавиш — исключение, его можно листать
        ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'contextmenu'].forEach(t => {
            root.addEventListener(t, (e) => {
                e.stopPropagation();
                if (t === 'contextmenu') e.preventDefault();
                if (t === 'touchstart' && !(e.target.closest('#_keys_panel') && !e.target.closest('._key'))) e.preventDefault();
            }, { passive: false });
        });

        // Без касаний управление гаснет — меньше закрывает текст
        let idleTimer = 0;
        const wake = () => { root.classList.remove('_idle'); clearTimeout(idleTimer); };
        const sleepSoon = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { if (!actHeld.size && !physHeld.size && stickId === null) root.classList.add('_idle'); }, 3500);
        };

        // --- Джойстик ---
        const zone = document.getElementById('_stick_zone');
        const stick = document.getElementById('_stick');
        const knob = document.getElementById('_stick_knob');
        const dirEls = {};
        stick.querySelectorAll('._stick_dir').forEach(el => { dirEls[el.dataset.dir] = el; });
        let stickId = null, stickDir = null, origin = null, running = false;
        sleepSoon();

        // Ось меняется, только когда другая явно перевешивает: у диагонали направление
        // иначе дрожало бы между двумя, и герой шёл бы рывками
        function pickDir(dx, dy, current) {
            const ax = Math.abs(dx), ay = Math.abs(dy);
            const horiz = dx > 0 ? 'right' : 'left', vert = dy > 0 ? 'down' : 'up';
            if (current === horiz) return ay > ax * 1.25 ? vert : horiz;
            if (current === vert) return ax > ay * 1.25 ? horiz : vert;
            return ax >= ay ? horiz : vert;
        }
        function setStickDir(dir) {
            if (dir === stickDir) return;
            if (stickDir) { sendDir(stickDir, false); dirEls[stickDir].classList.remove('_on'); }
            stickDir = dir;
            if (dir) { sendDir(dir, true); dirEls[dir].classList.add('_on'); }
        }
        // Палец у самого края — бег, как на джойстиках в мобильных играх. Только на карте
        // и если игра и так не бежит: при «всегда бегом» в её настройках Shift, наоборот,
        // переводит героя на шаг
        function setRun(on) {
            if (on) {
                const onMap = typeof Scene_Map !== 'undefined' && typeof SceneManager !== 'undefined' && SceneManager._scene instanceof Scene_Map;
                const always = typeof ConfigManager !== 'undefined' && ConfigManager.alwaysDash;
                if (!onMap || always || latched.has('dash')) on = false;
            }
            if (on === running) return;
            running = on;
            stick.classList.toggle('_run', on);
            if (!latched.has('dash')) sendAction('dash', on);
        }
        let tap = null;   // касание стрелки на джойстике — может оказаться шагом
        function moveStick(e) {
            const radius = stick.offsetWidth / 2;
            const dx = e.clientX - origin.x, dy = e.clientY - origin.y;
            const dist = Math.hypot(dx, dy), travel = radius * 0.42;
            if (tap && dist > 8) tap.moved = true;
            const k = dist > travel ? travel / dist : 1;
            knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
            // Мёртвая зона в центре: палец, просто лежащий на джойстике, героя не двигает
            const dir = dist < radius * 0.22 ? null : pickDir(dx, dy, stickDir);
            setStickDir(dir);
            setRun(!!dir && dist > radius * (running ? 0.62 : 0.8));
        }
        function startStick(e) {
            if (stickId !== null || talking()) return;
            e.preventDefault();
            stickId = e.pointerId;
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
            // Место джойстика без сдвига: offset* не видят transform
            const r = stick.offsetWidth / 2;
            const rest = { x: stick.offsetLeft + r, y: stick.offsetTop + r };
            // Направление считается от места, куда лёг палец: касание всегда начинается с
            // покоя, и куда потянул — туда и пошёл. Раньше касание внутри джойстика считалось
            // от его середины, а у края экрана — от сдвинутой середины: палец, лёгший на
            // нижний край, сразу вёл героя вниз, и пойти вверх было трудно
            origin = { x: e.clientX, y: e.clientY };
            // Рисуем джойстик под пальцем, но целиком на экране
            const base = { x: Math.min(Math.max(origin.x, r + 4), innerWidth - r - 4), y: Math.min(Math.max(origin.y, r + 4), innerHeight - r - 4) };
            stick.classList.add('_float', '_drag');
            stick.style.transform = `translate(${base.x - rest.x}px, ${base.y - rest.y}px)`;
            // Короткое касание стрелки на джойстике — один шаг, как кнопкой крестовины:
            // так удобно листать меню по одному пункту
            const fx = e.clientX - rest.x, fy = e.clientY - rest.y, fd = Math.hypot(fx, fy);
            tap = fd <= r && fd > r * 0.5 ? { dir: pickDir(fx, fy, null), at: performance.now(), moved: false } : null;
            wake();
            moveStick(e);
        }
        function stepOnce(dir) {
            sendDir(dir, true);
            dirEls[dir].classList.add('_on');
            setTimeout(() => { if (stickDir !== dir) { sendDir(dir, false); dirEls[dir].classList.remove('_on'); } }, 90);
        }
        function releaseStick(e) {
            const t = tap;
            tap = null;
            stickId = null;
            stick.classList.remove('_float', '_drag');
            stick.style.transform = '';
            knob.style.transform = '';
            setStickDir(null);
            setRun(false);
            if (e && t && !t.moved && performance.now() - t.at < 300) stepOnce(t.dir);
        }
        [zone, stick].forEach(el => {
            el.addEventListener('pointerdown', startStick, { passive: false });
            el.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) { e.preventDefault(); moveStick(e); } }, { passive: false });
            ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => el.addEventListener(t, (e) => {
                if (e.pointerId !== stickId) return;
                releaseStick(t === 'pointerup' ? e : null);
                sleepSoon();
            }));
        });

        // --- Кнопки и клавиши ---
        function bindButton(btn) {
            const kc = +btn.dataset.kc || 0, act = btn.dataset.act, latch = btn.dataset.latch === '1';
            const send = (isDown) => {
                if (!kc) return sendAction(act, isDown);
                if (isDown) physHeld.add(kc); else physHeld.delete(kc);
                sendPhys(kc, isDown);
            };
            btn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                wake();
                if (latch) {
                    // Держать «Пропуск» или «Бег» пальцем неудобно — большой палец нужен
                    // на Z. Поэтому они включаются касанием и выключаются следующим
                    const on = !latched.has(act);
                    if (on) latched.add(act); else latched.delete(act);
                    btn.classList.toggle('_latched', on);
                    // Бег от джойстика теперь держит переключатель
                    if (act === 'dash') { running = false; stick.classList.remove('_run'); }
                    send(on);
                    btn.classList.add('_on');
                    setTimeout(() => btn.classList.remove('_on'), 120);
                    sleepSoon();
                    return;
                }
                if (btn._pid != null) return;
                btn._pid = e.pointerId;
                try { btn.setPointerCapture(e.pointerId); } catch (_) {}
                btn.classList.add('_on');
                send(true);
            }, { passive: false });
            if (latch) return;
            ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => btn.addEventListener(t, (e) => {
                if (e.pointerId !== btn._pid) return;
                btn._pid = null;
                btn.classList.remove('_on');
                send(false);
                sleepSoon();
            }));
        }
        root.querySelectorAll('#_pad [data-kc], #_pad [data-act]').forEach(bindButton);

        // --- Панель остальных клавиш ---
        // Что значат клавиши, которые плагины вешают на свои действия, — для подписей
        const CAPTION = {
            messageAuto: T.cap_auto, AutoTextButton: T.cap_auto, auto_toggle: T.cap_auto, messageSkip: T.cap_skip,
            log: T.cap_log, backlog: T.cap_log, hakubox_history: T.cap_log, msgHide: T.cap_hide, hide: T.cap_hide,
        };
        const STANDARD = new Set(['ok', 'escape', 'cancel', 'shift', 'control', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'menu', 'tab', 'debug']);
        const DEV_NAMES = new Set(['copy', 'messagedebug', 'languagereload']);   // инструменты разработчика
        // Какие кнопки игра спрашивает у движка: так видно, что клавиша ей правда нужна
        const asked = new Set();
        const hookAsk = () => {
            if (typeof Input === 'undefined') return;
            for (const fn of ['isPressed', 'isTriggered', 'isRepeated', 'isLongPressed']) {
                const orig = Input[fn];
                if (typeof orig !== 'function' || orig.__rpgAsk) continue;
                Input[fn] = function(name) { asked.add(name); return orig.apply(this, arguments); };
                Input[fn].__rpgAsk = true;
            }
        };
        hookAsk();
        const askTimer = setInterval(hookAsk, 500);
        setTimeout(() => clearInterval(askTimer), 30000);
        // ...и какие проверяют её события (условие «Кнопка нажата»)
        function eventButtons() {
            const out = new Set();
            const scan = (list) => { for (const c of list || []) if (c && c.code === 111 && c.parameters && c.parameters[0] === 11) out.add(c.parameters[1]); };
            try { (window.$dataCommonEvents || []).forEach(ce => ce && scan(ce.list)); } catch (_) {}
            try { ((window.$dataMap && window.$dataMap.events) || []).forEach(ev => ev && (ev.pages || []).forEach(p => scan(p.list))); } catch (_) {}
            return out;
        }
        function gameKeys() {
            const map = mapper(), used = eventButtons();
            asked.forEach(n => used.add(n));
            const out = [];
            for (const code of Object.keys(map)) {
                const kc = +code, name = map[code];
                if (!KEYBOARD[kc] || !name || kc === 90 || kc === 88 || kc === 65) continue;   // Z, X и A и так на экране
                if (STANDARD.has(name) || DEV_NAMES.has(name)) continue;
                // Плагины «всей клавиатуры» вешают буквы и цифры на все клавиши подряд — такие
                // берём, только если игра их спрашивает или клавиша названа сама собой (R → 'R')
                if (name.length === 1 && name !== String.fromCharCode(kc) && !used.has(name)) continue;
                out.push({ kc, caption: CAPTION[name] || '' });
            }
            // Tab у движка есть всегда, но на экране его нет — показываем, если игра его спрашивает
            if (map[9] === 'tab' && used.has('tab')) out.push({ kc: 9, caption: '' });
            return out.sort((a, b) => a.kc - b.kc);
        }
        // Вся клавиатура — привычными рядами, как на телефонной клавиатуре. Листание —
        // в полоске кнопками ‹ ›, а Home, End и прочие редкие клавиши игры, которым они
        // нужны, покажутся среди её клавиш
        const QWERTY = [
            [...'1234567890'].map(c => c.charCodeAt(0)),
            [...'QWERTYUIOP'].map(c => c.charCodeAt(0)),
            [...'ASDFGHJKL'].map(c => c.charCodeAt(0)).concat(8),
            [...'ZXCVBNM'].map(c => c.charCodeAt(0)).concat(32),
            [9, 27, 13, 16, 17, 18],
        ];
        const keyBtn = (kc, cap) => `<button type="button" class="_key _glass${kc === 32 ? ' _wide' : ''}" data-kc="${kc}">${keyLabel(kc)}${cap ? `<small>${cap}</small>` : ''}</button>`;
        const actBtn = (act, label, hint, latch) => `<button type="button" class="_key _glass${latched.has(act) ? ' _latched' : ''}" data-act="${act}"${latch ? ' data-latch="1"' : ''} aria-label="${hint}">${label}</button>`;
        const panel = document.getElementById('_keys_panel');
        const keysBtn = document.getElementById('_btn_keys');
        function setPanel(open) {
            if (open) {
                panel.innerHTML = `<div class="_kb_quick">`
                    + actBtn('dash', T.dash, T.dash_hint, true) + actBtn('pageup', icon('prev'), T.prev) + actBtn('pagedown', icon('next'), T.next)
                    + gameKeys().map(g => keyBtn(g.kc, g.caption)).join('')
                    + `<button type="button" class="_key _glass _kb_toggle" aria-label="${T.keys_abc}">A–Z</button></div>`
                    + `<div class="_kb_full">${QWERTY.map(row => `<div class="_kb_row">${row.map(kc => keyBtn(kc)).join('')}</div>`).join('')}</div>`;
                panel.querySelectorAll('[data-kc], [data-act]').forEach(bindButton);
                // Раскрытая клавиатура запоминается для игры: кому она нужна, тому нужна всегда
                const abc = panel.querySelector('._kb_toggle');
                const setAbc = (on) => { panel.classList.toggle('_abc', on); abc.classList.toggle('_latched', on); };
                setAbc(!!gameSettings.get('abc'));
                abc.addEventListener('pointerdown', (e) => { e.preventDefault(); const on = !panel.classList.contains('_abc'); setAbc(on); gameSettings.set('abc', on); }, { passive: false });
            }
            panel.classList.toggle('_open', open);
            keysBtn.classList.toggle('_latched', open);
        }
        keysBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); wake(); setPanel(!panel.classList.contains('_open')); sleepSoon(); }, { passive: false });

        // Подписи под кнопками — по раскладке игры и сцене: на карте X открывает меню
        const capA = root.querySelector('#_btn_a ._cap'), capX = root.querySelector('#_btn_x ._cap');
        setInterval(() => {
            const onMap = typeof Scene_Map !== 'undefined' && typeof SceneManager !== 'undefined' && SceneManager._scene instanceof Scene_Map;
            const x = onMap ? T.menu : T.back, a = CAPTION[mapper()[65]] || '';
            if (capX.textContent !== x) capX.textContent = x;
            if (capA.textContent !== a) capA.textContent = a;
            // Касания идут в игру, открыто чит-меню или игра поставила в этот угол свои поля и
            // кнопки — угол экрана не забираем под джойстик. Раньше кнопка OK в окне пароля
            // (игра с паролем) попадала под него и не нажималась
            root.classList.toggle('_zone_off', !!window.__rpgTouchEnabled || !!window.__rpgCheatsOpen || gameControlsOver(zone));
        }, 400);
        function gameControlsOver(area) {
            const z = area.getBoundingClientRect();
            if (!z.width) return false;
            for (const el of document.querySelectorAll(GAME_CONTROLS)) {
                if (!isGameControl(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.width && r.height && r.right > z.left && r.left < z.right && r.bottom > z.top && r.top < z.bottom && getComputedStyle(el).visibility !== 'hidden') return true;
            }
            return false;
        }

        // Свернули игру или заблокировали экран — отпускаем всё, что было зажато, иначе
        // герой продолжил бы идти. Движок при потере фокуса сбрасывает свои клавиши, так
        // что включённые «Бег» и «Пропуск» по возвращении нажимаем заново
        function releaseHeld() {
            releaseStick();
            root.querySelectorAll('[data-kc], [data-act]').forEach(b => { if (!b.classList.contains('_latched')) { b.classList.remove('_on'); b._pid = null; } });
            for (const kc of [...physHeld]) { physHeld.delete(kc); sendPhys(kc, false); }
            for (const act of [...actHeld]) if (!latched.has(act)) sendAction(act, false);
        }
        const restoreLatched = () => { for (const act of latched) sendAction(act, true); };
        // Наши окна (плёнка, «Скрыть», читы) при закрытии сбрасывают клавиши движка (Input.clear) — с ними и включённые
        // «Пропуск» и «Бег»: кнопка горела, а текст больше не пропускался. Они зовут это после сброса
        window.__rpgRelatch = restoreLatched;
        window.__rpgAction = sendAction;
        document.addEventListener('visibilitychange', () => { if (document.hidden) releaseHeld(); else restoreLatched(); });
        window.addEventListener('blur', releaseHeld);
        window.addEventListener('focus', restoreLatched);

        // Кнопки — по тому, чем играют: коснулись экрана — есть, нажали настоящую клавишу или
        // кнопку геймпада — спрятаны и не закрывают картинку (планшет с клавиатурой, геймпад).
        // Там, где основной ввод — мышь (ноутбук с сенсором, планшет с тачпадом), сначала спрятаны
        function setShown(on) {
            if (root.classList.contains('_off') !== on) return;
            if (!on) { releaseHeld(); setPanel(false); }
            root.classList.toggle('_off', !on);
        }
        if (!TOUCH_FIRST) root.classList.add('_off');
        showTouchControls = () => setShown(true);
        window.addEventListener('keydown', (e) => {
            // Наши же нажатия с экранных кнопок — не настоящие; ввод текста — не игра
            const t = e.target;
            if (!e.isTrusted || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
            setShown(false);
        }, { capture: true, passive: true });
        // Геймпад событий о нажатиях не шлёт — пока он подключён, смотрим на кнопки и стики
        let padTimer = 0;
        const watchPads = () => {
            clearInterval(padTimer);
            padTimer = setInterval(() => {
                const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
                if (!pads.length) { clearInterval(padTimer); return; }
                if (pads.some(p => p.buttons.some(b => b.pressed) || p.axes.some(a => Math.abs(a) > 0.5))) setShown(false);
            }, 250);
        };
        window.addEventListener('gamepadconnected', watchPads);
        if (navigator.getGamepads && [...navigator.getGamepads()].some(Boolean)) watchPads();
    }

    // «Пропуск» во всех играх. Пока зажат Ctrl — или включена экранная кнопка «Пропуск»,
    // она и шлёт Ctrl, — текст появляется сразу и листается сам, а на выборе ответа
    // останавливается: окно выбора движок ждёт отдельно. Заодно быстрее идут журнал боя
    // и бегущие титры. Раньше кнопка работала только там, где у игры есть свой плагин
    // пропуска на Ctrl, — а он есть не у всех, и клавиши у них разные
    function setupTextSkip() {
        const skipping = () => typeof Input !== 'undefined' && !!Input.isPressed && Input.isPressed('control');
        // Авто-текст (A или пункт ⚙): страница, которая ждёт «дальше», перелистывается сама — через время по длине реплики
        // и не раньше, чем умолк голос (звуки игры), но не дольше 15 с сверх того. Как «Авто» в визуальных новеллах: сцену
        // смотрят без рук. Выбор ждёт, как и при пропуске; под картинкой без текста (V) — стоит. Выбор — на эту игру.
        // Время вышло — «нажали», пока страница не перелистнётся: окно плагина (Saba_Tachie в Ironhold Keep) спрашивает
        // «нажали?» не только там, где листает, и одно «да» уходило мимо. Отсчёт — заново с каждой паузы (startPause)
        let auto = !!gameSettings.get('auto');
        const voiced = () => { try { return AudioManager._seBuffers.some((b) => b && b.isPlaying && b.isPlaying()); } catch (e) { return false; } };
        const autoTurn = (win) => {
            if (!auto || !win.pause || cleanView) { win._rpgAutoAt = 0; return false; }
            const now = performance.now();
            if (!win._rpgAutoAt) {
                let text = '';
                try { text = String($gameMessage.allText()).replace(/\\[A-Za-z]+(?:\[[^\]]*\])?|\\./g, ''); } catch (e) { /* без реплики */ }
                win._rpgAutoAt = now + Math.min(6000, 1200 + 45 * text.length);
                return false;
            }
            return !(now < win._rpgAutoAt || (voiced() && now < win._rpgAutoAt + 15000));
        };
        const setAuto = (on) => { auto = on; gameSettings.set('auto', on); gameNote(on ? T.auto_on : T.auto_off); };
        onOurKey(65, () => setAuto(!auto));
        keyHelp.push({ keyCode: 65, text: T.keys_auto });
        // В меню — после «Момента» и «Перемотки» (их добавляют позже в этом же запуске)
        queueMicrotask(() => addMenuItem({ id: '_sys_auto', section: 'game', icon: 'auto', label: T.auto, isOn: () => auto, onClick: () => setAuto(!auto) }));
        const orSkip = (proto, name, also) => {
            const orig = proto && proto[name];
            if (typeof orig !== 'function' || orig.__rpgSkip) return;
            proto[name] = function() { return orig.apply(this, arguments) || skipping() || (also ? also(this) : false); };
            proto[name].__rpgSkip = true;
        };
        const apply = () => {
            if (typeof Window_Message === 'undefined') return;
            // Движок спрашивает «нажали?», когда решает показать текст сразу и перелистнуть страницу
            orSkip(Window_Message.prototype, 'isTriggered', autoTurn);
            if (typeof Window_BattleLog !== 'undefined') orSkip(Window_BattleLog.prototype, 'isFastForward');
            if (typeof Window_ScrollText !== 'undefined') orSkip(Window_ScrollText.prototype, 'isFastForward');
            const pause = Window_Message.prototype.startPause;
            if (typeof pause === 'function' && !pause.__rpgSkip) {
                Window_Message.prototype.startPause = function() { this._rpgAutoAt = 0; return pause.apply(this, arguments); };
                Window_Message.prototype.startPause.__rpgSkip = true;
            }
            // Паузы внутри текста (\. и \|) тоже пропускаем
            const wait = Window_Message.prototype.updateWait;
            if (typeof wait === 'function' && !wait.__rpgSkip) {
                Window_Message.prototype.updateWait = function() {
                    if (skipping()) this._waitCount = 0;
                    return wait.apply(this, arguments);
                };
                Window_Message.prototype.updateWait.__rpgSkip = true;
            }
        };
        // Плагины сообщений подменяют эти методы своими — поэтому ставим и после них
        apply();
        const timer = setInterval(apply, 500);
        setTimeout(() => clearInterval(timer), 30000);
    }

    // Перевод игры включён (window.__RPG.tl, сервер подставляет его в data/*.json): английский и русский
    // текст длиннее японского. Реплику разбиваем на строки по словам ДО того, как окно посчитает свой размер:
    // окно-«облачко» (MessageWindowPopup и похожие) меряет текст сам, и перенос после этого оставлял его
    // в одну строку, а продолжение обрезалось. Строк больше, чем помещается, — движок листает дальше
    // (Window_Message.needsNewPage). Строку, которую автор центрировал пробелами, ставим по центру заново —
    // по ширине уже переведённого текста. У оригинала (перевод выключен) не меняется ничего
    function setupTranslationWrap() {
        if (!(window.__RPG && window.__RPG.tl)) return;
        // Ширина строки так, как её нарисует окно. Коды раскрываем сами, а не методом окна: у плагинов он
        // бывает с последствиями (\js<…>, звук, имя говорящего), а здесь он звался бы на каждое слово.
        // \N[1], \P[1], \V[2], \G — как превратятся, значок \I[n] — как значок, прочие коды места не занимают
        const expand = (raw) => {
            // «\\» — сам знак «\», не начало кода: прячем его, пока раскрываем коды
            let text = String(raw).replace(/\\\\/g, '\x1b');
            for (let i = 0; i < 3; i++) {
                text = text.replace(/\\V\[(\d+)\]/gi, (m, n) => { try { return String($gameVariables.value(Number(n))); } catch (e) { return ''; } });
            }
            text = text.replace(/\\N\[(\d+)\]/gi, (m, n) => { try { return ($gameActors.actor(Number(n)) || {}).name() || ''; } catch (e) { return ''; } });
            text = text.replace(/\\P\[(\d+)\]/gi, (m, n) => { try { const a = $gameParty.members()[Number(n) - 1]; return a ? a.name() : ''; } catch (e) { return ''; } });
            text = text.replace(/\\G/gi, () => { try { return TextManager.currencyUnit; } catch (e) { return ''; } });
            return text;
        };
        const measure = (win, raw) => {
            const text = expand(raw);
            const icons = (text.match(/\\I\[\d+\]/gi) || []).length;
            const plain = text.replace(/\\[A-Za-z]+(?:\[[^\]]*\])?|\\[{}!.|^<>$]/g, '').replace(/\x1b/g, '\\');
            const iconW = ((typeof ImageManager !== 'undefined' && ImageManager.iconWidth) || (typeof Window_Base !== 'undefined' && Window_Base._iconWidth) || 32) + 4;
            return win.textWidth(plain) + icons * iconW;
        };
        const LEAD = /^[\s　]+/;
        // Части слова: код игры (\C[2], \I[5], \.) — целиком, остальное — по букве
        const TOKEN = /\\[A-Za-z]+(?:\[[^\]]*\])?|\\[^A-Za-z]|[\s\S]/gu;
        // Одна строка → строки не шире max: по словам; слово длиннее строки («Увааааа…») — по буквам,
        // иначе его конец ушёл бы за край окна
        const wrapLine = (win, body, max) => {
            if (measure(win, body) <= max) return [body];
            const parts = [];
            let cur = '';
            for (const w of body.match(/\S+\s*/g) || [body]) {
                if (measure(win, cur + w.trimEnd()) <= max) { cur += w; continue; }
                if (cur.trim()) { parts.push(cur.trimEnd()); cur = ''; }
                if (measure(win, w.trimEnd()) <= max) { cur = w; continue; }
                for (const ch of w.match(TOKEN) || []) {
                    if (cur && /\S/.test(ch) && measure(win, cur + ch) > max) { parts.push(cur.trimEnd()); cur = ''; }
                    cur += ch;
                }
            }
            if (cur.trim()) parts.push(cur.trimEnd());
            return parts.length ? parts : [body];
        };
        // Строки окна сообщений: каждая — по ширине окна; строка, которую игра ставила по центру пробелами, —
        // снова по центру
        const rewrap = (win, lines) => {
            if (typeof win.textWidth !== 'function' || !win.contents) return lines;
            if (win.resetFontSettings) win.resetFontSettings();
            const face = typeof $gameMessage !== 'undefined' && $gameMessage.faceName && $gameMessage.faceName();
            const faceW = face ? ((typeof ImageManager !== 'undefined' && ImageManager.faceWidth) || (typeof Window_Base !== 'undefined' && Window_Base._faceWidth) || 144) + 24 : 0;
            // Ширина обычного окна сообщений, а не нынешняя: облачка (MessageWindowPopup и подобные) подгоняют
            // окно под текст уже в startMessage, и до него ширина осталась бы от прошлой реплики
            const pad = typeof win.padding === 'number' ? win.padding : 18;
            // (MV — windowWidth(), его меняют и плагины ширины окна; у MZ его нет — ширина экрана)
            const full = typeof win.windowWidth === 'function' ? win.windowWidth() : (typeof Graphics !== 'undefined' && Graphics.boxWidth);
            const max = (full > 0 ? full - pad * 2 : (win.contentsWidth ? win.contentsWidth() : win.contents.width)) - faceW - 4;
            if (!(max > 60)) return lines;
            const space = Math.max(1, win.textWidth(' '));
            const out = [];
            for (const line of lines) {
                if (typeof line !== 'string') { out.push(line); continue; }
                // По центру — строка с заметным отступом. Один-два «　» — японский отступ под «「», его не трогаем
                const lead = (line.match(LEAD) || [''])[0];
                const centered = lead && line.length > lead.length && win.textWidth(lead) >= max * 0.1;
                const body = centered ? line.replace(LEAD, '') : line;
                for (const part of wrapLine(win, body, max)) {
                    if (!centered) { out.push(part); continue; }
                    const pad = Math.max(0, Math.floor((max - measure(win, part)) / 2 / space));
                    out.push(' '.repeat(pad) + part);
                }
            }
            return out;
        };
        // Размер шрифта окна (__rpgFont) — ставит apply: drawTextEx сам сбрасывает шрифт к обычному, после
        // сброса ставим наш
        const baseFont = (win) => {
            win.__rpgFont = 0;
            if (win.resetFontSettings) win.resetFontSettings();
            return win.contents.fontSize;
        };
        // Окно подсказки (описание предмета, навыка, профиль героя) не переносит строки: переносим сами, а не
        // влезает по высоте — уменьшаем шрифт по 2 пикселя, но не меньше 60%
        const fitHelp = (win, text) => {
            win.__rpgFont = 0;
            if (typeof text !== 'string' || !text || typeof win.textWidth !== 'function' || !win.contents) return text;
            const base = baseFont(win);
            const pad = typeof win.textPadding === 'function' ? win.textPadding() : 8;
            const max = (win.contentsWidth ? win.contentsWidth() : win.contents.width) - pad * 2;
            const height = win.contentsHeight ? win.contentsHeight() : win.contents.height;
            // Высота строки текста: MV — шрифт + 8, MZ — lineHeight на обычный шрифт
            const mz = typeof Utils !== 'undefined' && Utils.RPGMAKER_NAME === 'MZ';
            const spacing = mz ? Math.max(4, (win.lineHeight ? win.lineHeight() : 36) - base) : 8;
            const lines = text.split('\n');
            if (lines.every((l) => measure(win, l) <= max)) return text;
            let best = text;
            for (let size = base; size >= Math.max(14, Math.round(base * 0.6)); size -= 2) {
                win.contents.fontSize = size;
                const wrapped = [];
                for (const l of lines) wrapped.push(...wrapLine(win, l, max));
                best = wrapped.join('\n');
                if (wrapped.length * (size + spacing) <= height) {
                    win.__rpgFont = size === base ? 0 : size;
                    break;
                }
                win.__rpgFont = size;
            }
            if (win.resetFontSettings) win.resetFontSettings();
            return best;
        };
        // Вариант ответа шире окна выбора (оно не шире экрана) — этот вариант рисуем шрифтом поменьше, но не
        // меньше 60%
        const choiceFont = (win, index) => {
            const name = win.commandName ? win.commandName(index) : '';
            const rect = win.itemLineRect ? win.itemLineRect(index) : win.itemRectForText(index);
            const base = baseFont(win);
            const w = measure(win, name || '');
            return w > rect.width ? Math.max(14, Math.round(base * 0.6), Math.floor((base * rect.width) / w)) : 0;
        };
        // Плагины, которые сами переносят строки по одной букве (японскому так можно — пробелов нет), рвут
        // переведённое слово посередине: «with yo / u». Окно, которое режет строку своим tokenizeLine на буквы и
        // переносит по ним (wrapLineToWidth), получает буквы одного слова одним куском, с пробелом после него, —
        // перенос идёт между словами. Японские буквы и коды (\C[2]) — по одной, как были. Кусок не длиннее
        // WORD_MAX букв: слово шире окна плагин ставит целиком и выводит за рамку — такое режем, как раньше
        const WORD_CH = /^[^\s\x1b\\\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]$/;
        const WORD_MAX = 20;
        const wordTokens = (tokens) => {
            const out = [];
            for (const t of tokens) {
                const last = out.length ? out[out.length - 1] : null;
                const inWord = typeof last === 'string' && last && last[0] !== '\x1b' && last[0] !== '\\' && WORD_CH.test(last[last.length - 1]) &&
                    (last.length < WORD_MAX || /\s/.test(t));
                if (inWord && typeof t === 'string' && t.length === 1 && (WORD_CH.test(t) || /\s/.test(t))) out[out.length - 1] = last + t;
                else out.push(t);
            }
            return out;
        };
        const wordWrap = (proto) => {
            if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'tokenizeLine') || typeof proto.tokenizeLine !== 'function' ||
                typeof proto.wrapLineToWidth !== 'function' || proto.tokenizeLine.__rpgWrap) return;
            const tokenize = proto.tokenizeLine;
            proto.tokenizeLine = function() {
                const tokens = tokenize.apply(this, arguments);
                try { return Array.isArray(tokens) ? wordTokens(tokens) : tokens; } catch (e) { return tokens; }
            };
            proto.tokenizeLine.__rpgWrap = true;
        };
        const apply = () => {
            // Класс такого окна плагин не выносит наружу — узнаём его, когда окно создаётся
            const init = typeof Window_Base !== 'undefined' && Window_Base.prototype.initialize;
            if (typeof init === 'function' && !init.__rpgWrap) {
                Window_Base.prototype.initialize = function() {
                    try {
                        for (let p = Object.getPrototypeOf(this); p && p !== Window_Base.prototype; p = Object.getPrototypeOf(p)) wordWrap(p);
                    } catch (e) { /* перенос — как у плагина */ }
                    return init.apply(this, arguments);
                };
                Window_Base.prototype.initialize.__rpgWrap = true;
            }
            const fontReset = typeof Window_Base !== 'undefined' && Window_Base.prototype.resetFontSettings;
            if (typeof fontReset === 'function' && !fontReset.__rpgFont) {
                Window_Base.prototype.resetFontSettings = function() {
                    fontReset.apply(this, arguments);
                    if (this.__rpgFont && this.contents) this.contents.fontSize = this.__rpgFont;
                };
                Window_Base.prototype.resetFontSettings.__rpgFont = true;
            }
            if (typeof Window_Help !== 'undefined' && !Window_Help.prototype.setText.__rpgWrap) {
                const setText = Window_Help.prototype.setText;
                Window_Help.prototype.setText = function(text) {
                    let fitted = text;
                    try { fitted = fitHelp(this, text); } catch (e) { fitted = text; this.__rpgFont = 0; }
                    // Тот же текст — окно не перерисуется, а шрифт для него уже подобран
                    return setText.call(this, fitted);
                };
                Window_Help.prototype.setText.__rpgWrap = true;
            }
            if (typeof Window_ChoiceList !== 'undefined' && !Window_ChoiceList.prototype.drawItem.__rpgWrap) {
                const drawItem = Window_ChoiceList.prototype.drawItem;
                Window_ChoiceList.prototype.drawItem = function(index) {
                    try { this.__rpgFont = choiceFont(this, index); } catch (e) { this.__rpgFont = 0; }
                    // После — обычный шрифт: плагин может рисовать дальше без сброса шрифта
                    try { return drawItem.apply(this, arguments); } finally { this.__rpgFont = 0; try { this.resetFontSettings(); } catch (e) { /* пусть */ } }
                };
                Window_ChoiceList.prototype.drawItem.__rpgWrap = true;
            }
            // Профиль героя в MV (окно статуса, переносов там нет): строка шире окна — шрифт меньше, до 60%
            if (typeof Window_Status !== 'undefined' && typeof Window_Status.prototype.drawProfile === 'function' && !Window_Status.prototype.drawProfile.__rpgWrap) {
                const drawProfile = Window_Status.prototype.drawProfile;
                Window_Status.prototype.drawProfile = function(x) {
                    try {
                        const base = baseFont(this);
                        const text = this._actor && this._actor.profile ? this._actor.profile() : '';
                        const widest = String(text || '').split('\n').reduce((a, l) => Math.max(a, measure(this, l)), 0);
                        const room = (this.contentsWidth ? this.contentsWidth() : this.contents.width) - (x || 0);
                        this.__rpgFont = widest > room ? Math.max(14, Math.round(base * 0.6), Math.floor((base * room) / widest)) : 0;
                    } catch (e) { this.__rpgFont = 0; }
                    try { return drawProfile.apply(this, arguments); } finally { this.__rpgFont = 0; try { this.resetFontSettings(); } catch (e) { /* пусть */ } }
                };
                Window_Status.prototype.drawProfile.__rpgWrap = true;
            }
            if (typeof Window_Message === 'undefined') return;
            const start = Window_Message.prototype.startMessage;
            if (typeof start !== 'function' || start.__rpgWrap) return;
            Window_Message.prototype.startMessage = function() {
                try {
                    const texts = $gameMessage._texts;
                    if (Array.isArray(texts) && !texts.__rpgWrapped) {
                        // Перевод на экране — прямо перед выводом: до этого реплику видят только код и плагины
                        const shown = window.__RPG.translateText ? texts.map((x) => window.__RPG.translateText(x)) : texts;
                        const next = rewrap(this, shown);
                        next.__rpgWrapped = true;
                        $gameMessage._texts = next;
                    }
                } catch (e) { /* перенос не удался — текст как есть */ }
                return start.apply(this, arguments);
            };
            Window_Message.prototype.startMessage.__rpgWrap = true;
        };
        // Плагины сообщений ставят свой startMessage — оборачиваем и его
        apply();
        const timer = setInterval(apply, 500);
        setTimeout(() => clearInterval(timer), 30000);
    }

    // Проверка игры из библиотеки («Проверить в игре»): страница открыта с ?mimikin-check=1 в маленькой рамке.
    // Сама проходит то, что видит игрок в первые минуты: заголовок, настройки, новая игра, реплики подряд
    // (нажимает «OK»), меню — и собирает ошибки («Failed to load», сбои кода). Сохранения и настройки не
    // пишет, звук выключен. Итог — окну библиотеки (postMessage, тип mimikin-check)
    function setupSelfTest() {
        if (!/[?&]mimikin-check=1(?:&|$)/.test(location.search)) return;
        window.__RPG = window.__RPG || {};
        const st = window.__RPG.selftest = { errors: [], steps: [] };
        const post = (data) => { try { window.parent.postMessage(Object.assign({ type: 'mimikin-check' }, data), '*'); } catch (e) { /* без рамки */ } };
        const quiet = () => {
            try {
                if (typeof DataManager !== 'undefined' && DataManager.saveGame && !DataManager.saveGame.__rpgCheck) {
                    const mz = typeof Utils !== 'undefined' && Utils.RPGMAKER_NAME === 'MZ';
                    DataManager.saveGame = function() { return mz ? Promise.resolve(0) : true; };
                    DataManager.saveGame.__rpgCheck = true;
                }
                if (typeof ConfigManager !== 'undefined' && ConfigManager.save && !ConfigManager.save.__rpgCheck) {
                    ConfigManager.save = function() {};
                    ConfigManager.save.__rpgCheck = true;
                }
                // Запись мимо saveGame: глобальная информация, прямые сохранения плагинов
                if (typeof DataManager !== 'undefined' && DataManager.saveGlobalInfo && !DataManager.saveGlobalInfo.__rpgCheck) {
                    DataManager.saveGlobalInfo = function() {};
                    DataManager.saveGlobalInfo.__rpgCheck = true;
                }
                if (typeof StorageManager !== 'undefined') {
                    for (const name of ['save', 'saveObject', 'saveZip', 'saveToForage', 'saveToLocalFile', 'saveToWebStorage', 'remove', 'removeForage', 'removeLocalFile', 'removeWebStorage']) {
                        const fn = StorageManager[name];
                        if (typeof fn !== 'function' || fn.__rpgCheck) continue;
                        StorageManager[name] = function() { return typeof Promise !== 'undefined' ? Promise.resolve() : undefined; };
                        StorageManager[name].__rpgCheck = true;
                    }
                }
                document.querySelectorAll('video, audio').forEach((m) => { m.muted = true; });
                if (typeof WebAudio !== 'undefined' && WebAudio.setMasterVolume) WebAudio.setMasterVolume(0);
                if (typeof AudioManager !== 'undefined' && 'masterVolume' in AudioManager) AudioManager.masterVolume = 0;
            } catch (e) { /* не вышло — проверка всё равно идёт */ }
        };
        const quietTimer = setInterval(quiet, 200);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const scene = () => { try { return SceneManager._scene.constructor.name; } catch (e) { return ''; } };
        const ok = () => {
            try {
                Input._currentState.ok = true;
                setTimeout(() => { Input._currentState.ok = false; }, 90);
            } catch (e) { /* ещё нет движка */ }
        };
        const waitFor = async (test, ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                try { if (test()) return true; } catch (e) { /* дальше */ }
                await sleep(250);
            }
            return false;
        };
        const step = (name, passed) => { st.steps.push({ name, ok: !!passed }); post({ phase: 'step', step: name, ok: !!passed }); };
        (async () => {
            try {
                post({ phase: 'start' });
                // Заставки до заголовка — пропускаем нажатием «OK»
                const title = await waitFor(() => {
                    const s = scene();
                    if (s && s !== 'Scene_Boot' && s !== 'Scene_Title') ok();
                    return s === 'Scene_Title';
                }, 120000);
                step('title', title);
                if (title) {
                    await sleep(1500);
                    const t = SceneManager._scene;
                    if (t.commandOptions) t.commandOptions(); else SceneManager.push(Scene_Options);
                    const opts = await waitFor(() => scene() !== 'Scene_Title', 5000);
                    await sleep(1500);
                    step('options', opts && !st.errors.length);
                    SceneManager.goto(Scene_Title);
                    await waitFor(() => scene() === 'Scene_Title', 8000);
                    await sleep(1000);
                    const t2 = SceneManager._scene;
                    if (t2.commandNewGame) t2.commandNewGame();
                    else { DataManager.setupNewGame(); SceneManager.goto(Scene_Map); }
                    // Реплики и выбор подряд: полминуты нажимаем «OK», как игрок
                    const end = Date.now() + 30000;
                    let map = false;
                    while (Date.now() < end) {
                        if (scene() === 'Scene_Map') map = true;
                        ok();
                        await sleep(400);
                    }
                    step('play', map);
                    // Реплика ещё идёт — дожимаем «OK», пока не закончится (до 15 секунд), потом меню
                    await waitFor(() => { ok(); return scene() === 'Scene_Map' && !$gameMessage.isBusy() && !$gameMap.isEventRunning(); }, 15000);
                    if (scene() === 'Scene_Map' && !$gameMessage.isBusy()) {
                        SceneManager.push(Scene_Menu);
                        const menu = await waitFor(() => scene() === 'Scene_Menu', 5000);
                        await sleep(1500);
                        step('menu', menu);
                        SceneManager.pop();
                    }
                }
            } catch (e) {
                st.errors.push({ kind: 'check', message: String((e && e.message) || e).slice(0, 300), source: '' });
            }
            clearInterval(quietTimer);
            post({ phase: 'done', ok: !st.errors.length && st.steps.every((x) => x.ok), steps: st.steps, errors: st.errors });
        })();
    }

    // Перевод на экране — для строк, которые в файлах игры не меняются: защищённых (с ними сравнивает код
    // игры) и строк из кода плагинов (пункты настроек, подписи, реплики, которые плагин выводит сам). Их
    // подставляем только при выводе: текст рисуется (Bitmap.drawText), выводится с кодами (drawTextEx и его
    // ширина textSizeEx), реплика выводится в окно сообщений (перенос строк, setupTranslationWrap). Игра
    // внутри видит прежнюю строку — её
    // сравнения и логика не ломаются. Словарь — mimikin-tl.json рядом со страницей игры (собирает сервер)
    function setupTranslationDisplay() {
        if (!(window.__RPG && window.__RPG.tl)) return;
        let dict = null;
        try {
            // Сразу и до первого кадра: заголовок и меню рисуются из него с первого раза
            const xhr = new XMLHttpRequest();
            xhr.open('GET', 'mimikin-tl.json', false);
            xhr.send();
            if (xhr.status === 200) dict = JSON.parse(xhr.responseText);
        } catch (e) { dict = null; }
        // { words, images, saved } — словарь, разметки картинок с нарисованными подписями и переводы строк из
        // сохранения (прежний ответ — сам словарь)
        let images = [];
        let saved = { vars: new Map(), actors: new Map() };
        try {
            if (dict && dict.words && typeof dict.words === 'object') {
                images = Array.isArray(dict.images) ? dict.images : [];
                const s = dict.saved || {};
                saved = { vars: new Map(Object.entries(s.vars || {})), actors: new Map(Object.entries(s.actors || {})) };
                dict = dict.words;
            }
        } catch (e) { dict = null; }
        if (!dict || (!Object.keys(dict).length && !images.length && !saved.vars.size && !saved.actors.size)) return;
        // Одиночный знак не подменяем: MV рисует реплику по букве, и «光» стало бы «Light» посреди слова.
        // Промахи помним: строку счёта на экране рисуют каждый кадр
        // Словарь — Map: ключи вроде «constructor» не должны находить свойства объекта
        const words = new Map(Object.entries(dict));
        let misses = new Set();
        // Шаблоны («所持SP：%1» → «SP: %1»): нарисованная строка «所持SP：6» узнаётся по шаблону, значения — в перевод.
        // Сначала — дешёвая проверка: в строке есть самый длинный постоянный кусок шаблона
        const CJK2 = /[\u3040-\u30ff\u3400-\u9fff].*[\u3040-\u30ff\u3400-\u9fff]/;
        const templates = [];
        for (const [key, to] of words) {
            if (!/%\d/.test(key) || /%\d+%\d+/.test(key) || templates.length >= 3000) continue;
            const parts = key.split(/%\d+/).filter(Boolean);
            const longest = parts.reduce((a, p) => (p.length > a.length ? p : a), '');
            // Хотя бы два японских знака в постоянной части («%1時%2分» — годится: шаблон узнаётся целиком, от начала до конца)
            if (!CJK2.test(parts.join('')) || !longest) continue;
            // Все постоянные куски по одному знаку («%1時%2分», «%1は%2に») — подстановки только числа: иначе «%1は%2に»
            // подошёл бы к любой реплике с «は…に» и дал бы смесь языков
            const value = longest.length < 2 ? '([0-9\\uff10-\\uff19][0-9\\uff10-\\uff19.,:/ -]{0,11})' : '([\\s\\S]*?)';
            try {
                const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%(\d+)/g, () => value) + '$');
                const order = (key.match(/%\d+/g) || []).map((x) => Number(x.slice(1)));
                templates.push({ re, order, to, longest });
            } catch (e) { /* такой шаблон — мимо */ }
        }
        // Склейка из переводимых кусков: «ユーキと時間を過ごす（ユーキの家）», «攻撃力：», «― 武器 ―». Режем по скобкам,
        // двоеточиям, тире, косым и пробелам; переводим, только если переведён каждый японский кусок — иначе
        // смесь языков хуже оригинала. Кусок из одного знака — только если рядом не просто «。» («服。»)
        const SEP = /([\s\u2000-\u206f\u2190-\u27bf\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65:;,.!?()\[\]{}<>\/\\|~^=+*#&%'"`-]+)/;
        const CJK = /[\u3040-\u30ff\u3400-\u9fff]/;
        const PUNCT_ONLY = /^[\s。、，．,.!?！？]*$/;
        const bySegments = (text) => {
            const parts = text.split(SEP);
            if (parts.length < 2) return null;
            const marks = parts.filter((p, i) => i % 2 === 1).join('');
            let found = 0;
            const out = parts.map((p, i) => {
                if (i % 2 === 1 || !p || !CJK.test(p)) return p;
                if (p.length < 2 && PUNCT_ONLY.test(marks)) return null;
                const t = words.get(p);
                if (t === undefined) return null;
                found++;
                return t;
            });
            return found && !out.includes(null) ? out.join('') : null;
        };
        const tr = (text) => {
            if (typeof text !== 'string' || text.length < 2 || misses.has(text)) return text;
            const hit = words.get(text);
            if (hit !== undefined) return hit;
            const trimmed = text.trim();
            if (trimmed !== text && trimmed.length >= 2 && words.has(trimmed)) return text.replace(trimmed, () => words.get(trimmed));
            if (text.length <= 300) {
                for (const tpl of templates) {
                    if (!text.includes(tpl.longest)) continue;
                    const m = tpl.re.exec(text);
                    if (!m) continue;
                    const values = {};
                    tpl.order.forEach((n, i) => { values[n] = m[i + 1]; });
                    // Значение — целое слово: и из одного знака («昼») переводится
                    return tpl.to.replace(/%(\d+)/g, (all, n) => (values[n] !== undefined ? (words.get(values[n]) ?? tr(values[n])) : all));
                }
                const joined = bySegments(text);
                if (joined !== null) return joined;
            }
            // Промахи помним; строки, меняющиеся каждый кадр (счёт, таймер), переполняют — тогда заново
            if (misses.size >= 5000) misses = new Set();
            misses.add(text);
            return text;
        };
        window.__RPG.translateText = tr;
        // Ключ картинки — путь без расширения в одном виде: «img/pictures/a/b» (обратные косые, «./», %-кодировка,
        // регистр: игры собирают под Windows, где «Pictures» и «pictures» — одно)
        const keyOf = (s, url = false) => {
            let key = String(s || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
            if (url) key = key.replace(/[?#].*$/, '');      // в адресе «?» и «#» — уже не имя файла (имя закодировано)
            key = key.replace(/\.(png|png_|rpgmvp)$/i, '');
            try { key = decodeURIComponent(key); } catch (e) { /* имя без кодировки */ }
            return key.toLowerCase();
        };
        const byPath = new Map(images.map((im) => [keyOf(im.path), im]));
        // Заплатка подписи (services/pictures.js): картинка вдвое выше места надписи — сверху новые пиксели, снизу
        // маска «где заменить». Заменяются только пиксели надписи, соседние заплатки друг другу не мешают.
        // Загружаем сразу, вместе со словарём: к показу картинки они уже готовы
        const patches = new Map();
        const loaded = new Map();       // уже загруженные: с ними перерисовка — сразу, в том же кадре
        const loadPatch = (url) => {
            if (!patches.has(url)) {
                patches.set(url, new Promise((resolve) => {
                    try {
                        const img = new Image();
                        img.onload = () => { loaded.set(url, img); resolve(img); };
                        img.onerror = () => resolve(null);
                        img.src = url;
                    } catch (e) { resolve(null); }
                }));
            }
            return patches.get(url);
        };
        for (const im of images) for (const l of im.labels || []) if (l.patch && tr(l.text) !== l.text) loadPatch(l.patch);
        const applyPatch = (ctx, img, pb) => {
            const [px, py, pw, ph] = pb;
            const c = document.createElement('canvas');
            c.width = pw;
            c.height = ph * 2;
            const cx = c.getContext('2d');
            cx.drawImage(img, 0, 0);
            const src = cx.getImageData(0, 0, pw, ph * 2).data;
            const cur = ctx.getImageData(px, py, pw, ph);
            const d = cur.data;
            const n = pw * ph * 4;
            for (let i = 0; i < n; i += 4) {
                if (src[n + i + 3] > 127) { d[i] = src[i]; d[i + 1] = src[i + 1]; d[i + 2] = src[i + 2]; d[i + 3] = src[i + 3]; }
            }
            ctx.putImageData(cur, px, py);
        };
        // Стиль подписи: у найденной распознаванием — свой, у ручной разметки — общий для картинки
        const STYLE = ['color', 'outline', 'outlineWidth', 'bold', 'size'];
        const draw = (bitmap, im, todo, imgs) => {
            const mz = typeof Utils !== 'undefined' && Utils.RPGMAKER_NAME === 'MZ';
            const prevFont = [bitmap.fontFace, bitmap.fontSize, bitmap.textColor, bitmap.outlineColor, bitmap.outlineWidth, bitmap.fontBold];
            let base = 'GameFont';
            try { if (mz && typeof $gameSystem !== 'undefined' && $gameSystem) base = $gameSystem.mainFontFace(); } catch (e) { /* шрифт по умолчанию */ }
            const ctx = bitmap.context || bitmap._context;
            todo.forEach(({ l, to }, i) => {
                const st = Object.assign({}, im.style || {});
                for (const k of STYLE) if (l[k] !== undefined) st[k] = l[k];
                const pad = 3;
                const patched = imgs[i] && Array.isArray(l.patchBox);
                const box = patched ? l.patchBox : [l.x - pad, l.y - pad, l.w + pad * 2, l.h + pad * 2];
                // Кусок картинки — на случай, если нарисовать перевод не выйдет: тогда вернём оригинал
                let piece = null;
                try { piece = ctx && ctx.getImageData(box[0], box[1], box[2], box[3]); } catch (e) { piece = null; }
                try {
                    bitmap.fontFace = 'RpgTlFont, ' + base;
                    const size0 = st.size || Math.max(10, Math.round(l.h * 0.95));
                    bitmap.fontSize = size0;
                    bitmap.textColor = st.color || '#ffffff';
                    // Без обводки (null) — прозрачная: нулевую толщину холст пропускает и рисует прежнюю
                    bitmap.outlineColor = st.outline === null ? 'rgba(0, 0, 0, 0)' : st.outline || 'rgba(0, 0, 0, 0.85)';
                    bitmap.outlineWidth = st.outline === null ? 0 : st.outlineWidth != null ? st.outlineWidth : 4;
                    bitmap.fontBold = !!st.bold;
                    // Вертикальная надпись — перевод повёрнут и идёт вдоль столбца: место — его высота
                    const width = l.maxW || (l.vertical ? l.h : l.w);
                    // Перевод длиннее места — шрифт меньше, но не меньше 60%; дальше движок сам сожмёт строку
                    if (typeof bitmap.measureTextWidth === 'function') {
                        const min = Math.max(8, Math.round(size0 * 0.6));
                        while (bitmap.fontSize > min && bitmap.measureTextWidth(to) > width) bitmap.fontSize -= 1;
                        bitmap.measureTextWidth(to);   // шрифт годен — до стирания
                    }
                    if (patched) applyPatch(ctx, imgs[i], l.patchBox);
                    else bitmap.clearRect(box[0], box[1], box[2], box[3]);
                    if (l.vertical && ctx) {
                        ctx.save();
                        try {
                            ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
                            ctx.rotate(Math.PI / 2);
                            bitmap.drawText(to, -width / 2, -l.w / 2, width, l.w, 'center');
                        } finally { ctx.restore(); }
                    } else {
                        const x = l.align === 'center' ? l.x - (width - l.w) / 2 : l.x;
                        bitmap.drawText(to, x, l.y, width, l.h, l.align || 'left');
                    }
                } catch (e) {
                    try {
                        if (ctx && piece) {
                            ctx.putImageData(piece, box[0], box[1]);
                            if (bitmap._setDirty) bitmap._setDirty(); else if (bitmap._baseTexture) bitmap._baseTexture.update();
                        }
                    } catch (e2) { /* как вышло */ }
                } finally {
                    [bitmap.fontFace, bitmap.fontSize, bitmap.textColor, bitmap.outlineColor, bitmap.outlineWidth, bitmap.fontBold] = prevFont;
                }
            });
        };
        const relabel = (bitmap, im) => {
            bitmap.__rpgLabels = true;
            bitmap.addLoadListener(() => {
                const todo = (im.labels || []).map((l) => ({ l, to: tr(l.text) })).filter((x) => typeof x.to === 'string' && x.to !== x.l.text);
                if (!todo.length) return;
                // Холст картинки — сейчас: спрайт игры берёт текстуру в следующем слушателе загрузки, и возьми он её
                // от самой картинки, а холст появись позже (у движка это новая текстура) — показывал бы оригинал
                try { void (bitmap.context || bitmap._context); } catch (e) { /* без холста — как получится */ }
                const urls = todo.map((x) => (x.l.patch && Array.isArray(x.l.patchBox) ? x.l.patch : null));
                // Заплатки уже загружены (их грузим вместе со словарём) или их нет — сразу; иначе — как загрузятся
                if (urls.every((u) => !u || loaded.has(u))) return draw(bitmap, im, todo, urls.map((u) => (u ? loaded.get(u) : null)));
                Promise.all(urls.map((u) => (u ? loadPatch(u) : null))).then((imgs) => draw(bitmap, im, todo, imgs)).catch(() => {});
            });
        };
        // Сохранение, сделанное до перевода: строки в переменных и имена, описания героев в нём — японские, а
        // события, которые их пишут, уже прошли. При загрузке подменяем тем же переводом, что дали бы события
        // теперь. Только точное совпадение со строкой игры; файл сохранения не трогаем
        const translateSaved = () => {
            const vars = typeof $gameVariables !== 'undefined' && $gameVariables && $gameVariables._data;
            if (Array.isArray(vars) && saved.vars.size) {
                vars.forEach((v, i) => { if (typeof v === 'string' && saved.vars.has(v)) vars[i] = saved.vars.get(v); });
            }
            const actors = typeof $gameActors !== 'undefined' && $gameActors && $gameActors._data;
            if (Array.isArray(actors) && saved.actors.size) {
                for (const a of actors) {
                    if (!a) continue;
                    for (const key of ['_name', '_nickname', '_profile']) {
                        if (typeof a[key] === 'string' && saved.actors.has(a[key])) a[key] = saved.actors.get(a[key]);
                    }
                }
            }
        };
        const patch = (proto, name) => {
            const orig = proto && proto[name];
            if (typeof orig !== 'function' || orig.__rpgTl) return;
            proto[name] = function(text) {
                let shown = text;
                try { shown = tr(text); } catch (e) { shown = text; }
                if (shown === text) return orig.apply(this, arguments);
                const args = Array.prototype.slice.call(arguments);
                args[0] = shown;
                return orig.apply(this, args);
            };
            proto[name].__rpgTl = true;
        };
        const apply = () => {
            if (typeof Bitmap !== 'undefined') patch(Bitmap.prototype, 'drawText');
            if (typeof Window_Base !== 'undefined') {
                patch(Window_Base.prototype, 'drawTextEx');
                patch(Window_Base.prototype, 'textSizeEx');     // MZ: ширина окна — по тому же тексту
                // Ширина подписи — переведённой: плагин ставит число сразу за подписью по её ширине
                // («攻撃力レベル：» + «1» → «Attack Level:1», а не «Attack Leve1:»)
                patch(Window_Base.prototype, 'textWidth');
            }
            if (typeof Bitmap !== 'undefined') patch(Bitmap.prototype, 'measureTextWidth');
            if ((saved.vars.size || saved.actors.size) && typeof DataManager !== 'undefined' &&
                typeof DataManager.extractSaveContents === 'function' && !DataManager.extractSaveContents.__rpgTl) {
                const extract = DataManager.extractSaveContents;
                DataManager.extractSaveContents = function() {
                    const result = extract.apply(this, arguments);
                    try { translateSaved(); } catch (e) { /* сохранение — как есть */ }
                    return result;
                };
                DataManager.extractSaveContents.__rpgTl = true;
            }
            // Картинка с нарисованными подписями (разметка с сервера): при загрузке стираем подписи в памяти и
            // пишем перевод тем же цветом и обводкой. Файл игры не меняется — меняется только картинка в памяти.
            // Картинку узнаём и по папке с именем (loadBitmap), и по адресу: плагины грузят и так (MZ — loadBitmapFromUrl,
            // MV — loadNormalBitmap); одна картинка перерисовывается один раз (__rpgLabels)
            const hook = (name, keyFrom) => {
                const orig = ImageManager[name];
                if (typeof orig !== 'function' || orig.__rpgTl) return;
                ImageManager[name] = function() {
                    const bitmap = orig.apply(this, arguments);
                    try {
                        const im = byPath.get(keyFrom.apply(null, arguments));
                        if (im && bitmap && !bitmap.__rpgLabels && typeof bitmap.addLoadListener === 'function') relabel(bitmap, im);
                    } catch (e) { /* картинка — как есть */ }
                    return bitmap;
                };
                ImageManager[name].__rpgTl = true;
            };
            if (images.length && typeof ImageManager !== 'undefined') {
                hook('loadBitmap', (folder, filename) => keyOf(String(folder || '') + String(filename || '')));
                hook('loadBitmapFromUrl', (url) => keyOf(url, true));
                hook('loadNormalBitmap', (url) => keyOf(url, true));
            }
        };
        apply();
        // Плагины ставят свои drawTextEx позже — оборачиваем и их
        const timer = setInterval(apply, 500);
        setTimeout(() => clearInterval(timer), 30000);
    }

    // Шрифт переведённого текста. В японских шрифтах кириллица «полноширинная», как иероглифы, — русские
    // буквы стоят вразрядку; латиница там тоже бывает так себе. Латиница и кириллица — M PLUS Rounded 1c
    // (округлый, как большинство японских игровых шрифтов; OFL), всё остальное — шрифтом игры: у нашего
    // шрифта unicode-range только эти буквы, и японское в окне остаётся как было. Шрифт ставим первым в
    // списке шрифтов окна (MV — standardFontFace, MZ — mainFontFace), загружаем сразу при старте
    function setupTranslationFont() {
        if (!(window.__RPG && window.__RPG.tl) || typeof FontFace === 'undefined' || !document.fonts) return;
        const FAMILY = 'RpgTlFont';
        const faces = [
            ['mplus-rounded-1c-latin-500.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
            ['mplus-rounded-1c-cyrillic-500.woff2', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'],
        ];
        for (const [file, range] of faces) {
            try {
                const face = new FontFace(FAMILY, `url(/fonts/${file})`, { unicodeRange: range });
                document.fonts.add(face);
                face.load().catch(() => {});
            } catch (e) { /* без шрифта — шрифтом игры */ }
        }
        const prefix = (orig) => function() {
            const f = orig.apply(this, arguments);
            return typeof f === 'string' && !f.includes(FAMILY) ? `${FAMILY}, ${f}` : f;
        };
        const apply = () => {
            if (typeof Window_Base !== 'undefined' && Window_Base.prototype.standardFontFace && !Window_Base.prototype.standardFontFace.__rpgTl) {
                Window_Base.prototype.standardFontFace = prefix(Window_Base.prototype.standardFontFace);
                Window_Base.prototype.standardFontFace.__rpgTl = true;
            }
            if (typeof Game_System !== 'undefined' && Game_System.prototype.mainFontFace && !Game_System.prototype.mainFontFace.__rpgTl) {
                Game_System.prototype.mainFontFace = prefix(Game_System.prototype.mainFontFace);
                Game_System.prototype.mainFontFace.__rpgTl = true;
            }
        };
        apply();
        const timer = setInterval(apply, 500);
        setTimeout(() => clearInterval(timer), 30000);
    }

    // Экран не гаснет, пока игра на экране: иначе телефон блокируется посреди сцены или
    // длинного диалога, если долго его не касаться. Скрыли вкладку — браузер снимает
    // блокировку сам, вернулись — ставим снова. Safari может дать её только после касания
    // страницы, поэтому просим и по касанию. Но если 10 минут никто ничего не нажимал —
    // отошли или уснули с открытой игрой, — экрану можно погаснуть: иначе он горел бы
    // часами. Первое же касание снова не даёт ему гаснуть
    function setupWakeLock() {
        if (!navigator.wakeLock || !navigator.wakeLock.request) return;
        const IDLE_MS = 10 * 60 * 1000;
        let lock = null, asking = false, lastInput = Date.now();
        // Последнее действие игрока: касания и клавиши — здесь, геймпад — по отметке движка
        const idle = () => Date.now() - Math.max(lastInput,
            (typeof Input !== 'undefined' && Input.date) || 0,
            (typeof TouchInput !== 'undefined' && TouchInput.date) || 0) > IDLE_MS;
        const acquire = () => {
            if (lock || asking || document.visibilityState !== 'visible' || idle()) return;
            asking = true;
            navigator.wakeLock.request('screen').then((l) => {
                lock = l;
                l.addEventListener('release', () => { if (lock === l) lock = null; });
            }).catch(() => {}).finally(() => { asking = false; });
        };
        const onInput = () => { lastInput = Date.now(); acquire(); };
        acquire();
        document.addEventListener('visibilitychange', onInput);
        ['touchend', 'click', 'keydown'].forEach(t => window.addEventListener(t, onInput, { capture: true, passive: true }));
        setInterval(() => {
            if (lock && idle()) { const l = lock; lock = null; l.release().catch(() => {}); }
            else acquire();   // геймпад будит только отметкой движка — проверяем и её
        }, 30000);
    }

    // Пока игра грузится, экран чёрный — иногда секунды, а с большим шрифтом на медленной
    // сети и дольше: непонятно, грузится она или зависла. Через полсекунды внизу появляется
    // «Загрузка игры…» и держится, пока не начнётся первая сцена после загрузочной.
    // Внизу, а не по центру: в центре движок рисует свою картинку загрузки
    function setupLoadingHint() {
        const style = document.createElement('style');
        style.textContent = `
            #_loading_hint { position: fixed; left: 50%; bottom: calc(max(20px, env(safe-area-inset-bottom)) + 12px); transform: translateX(-50%); z-index: 2147483645; display: flex; align-items: center; gap: 10px; padding: 7px 16px; border-radius: 20px; background: rgba(14,14,18,0.92); border: 1px solid rgba(217,180,94,0.45); color: #fff; font: 600 13px/1.35 system-ui, sans-serif; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .3s; }
            #_loading_hint._show { opacity: 1; }
            #_loading_hint i { width: 13px; height: 13px; border-radius: 50%; border: 2px solid rgba(217,180,94,0.25); border-top-color: #d9b45e; animation: _rpg_spin .8s linear infinite; }
            @keyframes _rpg_spin { to { transform: rotate(360deg); } }
        `;
        document.head.appendChild(style);
        const hint = document.createElement('div');
        hint.id = '_loading_hint';
        hint.innerHTML = `<i></i>${T.loading}`;
        document.body.appendChild(hint);

        const done = () => {
            // Игра упала — показывает свой экран ошибки, наша надпись там лишняя
            if (typeof Graphics !== 'undefined' && Graphics._errorPrinter && Graphics._errorPrinter.innerHTML.trim()) return true;
            if (typeof SceneManager === 'undefined' || !SceneManager._scene) return false;
            if (SceneManager._stopped) return true;
            const scene = SceneManager._scene;
            if (typeof Scene_Boot !== 'undefined' && scene instanceof Scene_Boot) return false;
            return scene.isStarted ? scene.isStarted() : !!SceneManager._sceneStarted;
        };
        const show = setTimeout(() => hint.classList.add('_show'), 500);
        const hide = () => { clearInterval(watch); clearTimeout(show); hint.classList.remove('_show'); setTimeout(() => hint.remove(), 400); };
        const watch = setInterval(() => { if (done()) hide(); }, 200);
        setTimeout(hide, 120000);
    }

    // --- 6. ДИАГНОСТИКА, ТАЧ-РЕЖИМ, МОНИТОРЫ ---
    // Счётчик кадров считает, только пока он на экране. Раньше он и журнал ниже
    // работали на каждом кадре всю игру, даже скрытые, — лишняя работа для телефона
    function setupFpsMonitor() {
        let visible = false;
        let raf = 0;

        const monitor = document.createElement('div');
        monitor.id = '_fps_monitor';
        monitor.style.cssText = `display: none; position: fixed; top: max(64px, env(safe-area-inset-top) + 48px); right: max(16px, env(safe-area-inset-right)); z-index: 2147483647; background: rgba(14,14,18,0.88); color: #e8dfc8; font: 12px/1.5 system-ui, sans-serif; font-variant-numeric: tabular-nums; padding: 8px 10px; border-radius: 8px; min-width: 130px; pointer-events: none; border: 1px solid rgba(217,180,94,0.45);`;
        document.body.appendChild(monitor);

        const HISTORY = 60;
        let fpsHistory, frameTimes, lastFrame, frameCount, lastFpsUpdate, lagSpikes;
        function reset() {
            fpsHistory = new Array(HISTORY).fill(60);
            frameTimes = []; lastFrame = performance.now(); frameCount = 0; lastFpsUpdate = performance.now(); lagSpikes = 0;
        }

        function sparkline(data) {
            const bars = ['▁','▂','▃','▄','▅','▆','▇','█'];
            const min = Math.min(...data), max = Math.max(...data) || 1;
            return data.slice(-20).map(v => bars[Math.max(0, Math.min(Math.round(((v - min) / (max - min)) * (bars.length - 1)), bars.length - 1))]).join('');
        }

        function getColor(fps) { return fps >= 55 ? '#7fc7a5' : fps >= 40 ? '#d6a848' : fps >= 25 ? '#d68a48' : '#b06a6a'; }

        function tick() {
            const now = performance.now(), frameTime = now - lastFrame;
            lastFrame = now;
            frameCount++; frameTimes.push(frameTime);

            if (frameTimes.length > HISTORY) frameTimes.shift();
            if (frameTime > 50) lagSpikes++;

            if (now - lastFpsUpdate >= 500) {
                const currentFps = Math.round(frameCount / ((now - lastFpsUpdate) / 1000));
                frameCount = 0; lastFpsUpdate = now;

                fpsHistory.push(currentFps);
                if (fpsHistory.length > HISTORY) fpsHistory.shift();

                const avgFps = Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length);
                const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
                const color = getColor(currentFps);
                monitor.innerHTML = `
                    <span style="color:${color};font-size:16px;font-weight:bold">${currentFps} FPS</span><br>
                    <span style="color:rgba(232,223,200,0.7)">${T.fps_frame}: ${avgFrameTime.toFixed(1)}ms</span><br>
                    <span style="color:rgba(232,223,200,0.5)">min:${Math.min(...fpsHistory)} avg:${avgFps} max:${Math.max(...fpsHistory)}</span><br>
                    <span style="color:#b06a6a;font-size:11px">${T.fps_spikes}: ${lagSpikes}</span><br>
                    <span style="color:${color};letter-spacing:0;font-size:10px">${sparkline(fpsHistory)}</span>
                `;
            }
            if (visible) raf = requestAnimationFrame(tick);
        }

        function setVisible(v) {
            visible = v;
            monitor.style.display = v ? 'block' : 'none';
            cancelAnimationFrame(raf);
            raf = 0;
            if (v) { reset(); raf = requestAnimationFrame(tick); }
        }
        window.__toggleFpsMonitor = () => setVisible(!visible);

        addMenuItem({ id: '_sys_fps', section: 'debug', icon: 'fps', label: T.fps, isOn: () => visible, onClick: () => setVisible(!visible) });
        if (location.search.includes('fps') || location.search.includes('dev')) setVisible(true);
    }

    // Журнал подтормаживаний пишет, пока открыт
    function setupSpikeDiagnostics() {
        const SPIKE_THRESHOLD_MS = 40;
        const MAX_LOG = 30;
        const log = [];
        let lastFrameTime = performance.now();
        const sessionStart = performance.now();
        let recording = false;
        let raf = 0;
        window.__spikeLog = log;

        const panel = document.createElement('div');
        // id нужен перехватчику касаний на телефоне: без него он глотал нажатия
        // по этой панели, и кнопка «Очистить» не работала
        panel.id = '_spike_panel';
        panel.style.cssText = `display: none; position: fixed; bottom: 10px; left: 10px; right: 10px; max-height: 45vh; background: rgba(14,14,18,0.92); border: 1px solid rgba(217,180,94,0.45); border-radius: 10px; z-index: 2147483647; font: 12px/1.45 system-ui, sans-serif; font-variant-numeric: tabular-nums; color: #e8dfc8; overflow-y: auto; -webkit-overflow-scrolling: touch; pointer-events: auto;`;
        panel.innerHTML = `<div style="position:sticky;top:0;background:rgba(14,14,18,0.95);padding:6px 10px;border-bottom:1px solid rgba(217,180,94,0.3);display:flex;justify-content:space-between;align-items:center;"><span style="color:#e9c97a;font-weight:600">${T.spikes}</span><span id="_spike_count" style="color:#b06a6a">${T.spikes_total}: 0</span><button id="_spike_clear" style="background:rgba(217,180,94,0.12);border:1px solid rgba(217,180,94,0.45);border-radius:4px;color:#e9c97a;padding:2px 8px;font:inherit;">${T.spikes_clear}</button></div><div id="_spike_log_body" style="padding:6px 10px;"></div>`;
        document.body.appendChild(panel);
        // Касания и прокрутка журнала — не игре: иначе на карте герой шёл бы туда, где нажали «Очистить»
        ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'wheel', 'click'].forEach(t => {
            panel.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
        });

        onTap(document.getElementById('_spike_clear'), () => {
            log.length = 0;
            document.getElementById('_spike_log_body').innerHTML = `<span style="color:rgba(232,223,200,0.5)">${T.spikes_cleared}</span>`;
            document.getElementById('_spike_count').textContent = `${T.spikes_total}: 0`;
        });

        function getGameState(frameMs) {
            const state = { ms: frameMs.toFixed(1), t: ((performance.now() - sessionStart) / 1000).toFixed(1) };
            try {
                const sm = window.SceneManager;
                if (!sm) return state;
                state.scene = sm._scene?.constructor?.name || '?';
                if (window.$gameMap) {
                    state.map = $gameMap._mapId || 0;
                    const events = $gameMap._events?.filter(Boolean) || [];
                    state.events = events.length;
                    state.parallelEvents = events.filter(e => e?._trigger === 4 && e?._interpreter?.isRunning?.()).length;
                    state.runningEvents = events.filter(e => e?._interpreter?.isRunning?.()).length;
                }
                if (window.$gameMessage) state.msg = $gameMessage.isBusy() ? 'ДА' : 'нет';
                if (window.$gameScreen) state.pics = ($gameScreen._pictures?.filter(Boolean) || []).length;
                if (window.PIXI?.utils?.TextureCache) state.textures = Object.keys(PIXI.utils.TextureCache).length;
                if (window.FilterController !== undefined) state.fc = FilterController.enabledAll ? 'ON' : 'off';
            } catch(e) {}
            return state;
        }

        function detectLoop() {
            const now = performance.now();
            const delta = now - lastFrameTime;
            lastFrameTime = now;

            if (delta > SPIKE_THRESHOLD_MS) {
                log.unshift(getGameState(delta));
                if (log.length > MAX_LOG) log.pop();
                const body = document.getElementById('_spike_log_body');
                if (body) body.innerHTML = log.map((s, i) => `<div style="border-bottom:1px solid rgba(255,255,255,0.05);padding:3px 0"><span style="color:#666">#${i+1} +${s.t}s</span><span style="color:${s.ms > 80 ? '#f44' : s.ms > 60 ? '#f80' : '#ff0'};font-weight:bold"> ${s.ms}ms</span><span style="color:#aaa"> ${s.scene || '?'}</span> ${s.parallelEvents > 0 ? `<span style="color:#f44"> ⚠️ parallel:${s.parallelEvents}</span>` : ''} ${s.textures > 200 ? `<span style="color:#f44"> tex:${s.textures}⚠️</span>` : (s.textures ? ` tex:${s.textures}` : '')}</div>`).join('');
                const countEl = document.getElementById('_spike_count');
                if (countEl) countEl.textContent = `${T.spikes_total}: ${log.length}`;
            }
            if (recording) raf = requestAnimationFrame(detectLoop);
        }

        function setOpen(open) {
            recording = open;
            panel.style.display = open ? 'block' : 'none';
            cancelAnimationFrame(raf);
            raf = 0;
            if (open) { lastFrameTime = performance.now(); raf = requestAnimationFrame(detectLoop); }
        }

        addMenuItem({ id: '_sys_spikes', section: 'debug', icon: 'pulse', label: T.spikes, isOn: () => recording, onClick: () => setOpen(!recording) });
        if (location.search.includes('dev')) setOpen(true);
    }

    function setupTouchModeToggle() {
        if (!TOUCH_FIRST) return;

        window.__rpgTouchEnabled = !!gameSettings.get('touch');

        const interceptor = (e) => {
            // Касание мимо меню ⚙ закрывает его. Проверка здесь, а не только в обработчике
            // на document: перехватчик глотает касание раньше, и меню оставалось открытым
            if ((e.type === 'pointerdown' || e.type === 'touchstart') && !(e.target && e.target.closest && e.target.closest('#_sys_menu_container'))) closeMenu();
            if (window.__rpgTouchEnabled) return;
            // Наше меню и кнопки — и поля с кнопками самой игры: касание по ним — им. Раньше
            // «Retry» на экране ошибки загрузки в MV не нажимался (он ждёт само касание,
            // а не «клик»), и выйти можно было только перезапуском
            if (e.target && e.target.closest && (e.target.closest(OUR_UI) || isGameControl(e.target))) return;
            e.stopPropagation();
            e.stopImmediatePropagation();
        };

        const TYPES = ['touchstart', 'touchmove', 'touchend', 'mousedown', 'mousemove', 'mouseup', 'pointerdown', 'pointermove', 'pointerup'];
        TYPES.forEach(ev => {
            window.addEventListener(ev, interceptor, { capture: true, passive: false });
        });
        // ...но дальше самого поля или кнопки касание не идёт: движок принял бы его за
        // касание картинки — на карте герой пошёл бы туда, а на iPhone поле не получило бы фокус
        const keepToControl = (e) => { if (!window.__rpgTouchEnabled && isGameControl(e.target)) e.stopPropagation(); };
        TYPES.forEach(ev => document.documentElement.addEventListener(ev, keepToControl, { passive: true }));

        window.__toggleRpgTouchMode = function() {
            window.__rpgTouchEnabled = !window.__rpgTouchEnabled;
            gameSettings.set('touch', window.__rpgTouchEnabled);
        };
        addMenuItem({ id: '_sys_touch', section: 'controls', icon: 'tap', label: T.touch, isOn: () => window.__rpgTouchEnabled, onClick: () => window.__toggleRpgTouchMode() });
    }

    // Чит-меню (cheats.js — своё, панель поверх игры) — при первом нажатии пункта в меню ⚙: в каждую игру
    // заранее его не грузим, пользуются им не все
    function injectCheats() {
        let state = 'idle';   // idle → loading → ready
        let openOnLoad = false;
        const load = (open) => {
            if (state === 'ready') { if (open && window.__rpgCheats) window.__rpgCheats.toggle(); return; }
            openOnLoad = openOnLoad || open;
            if (state === 'loading') return;
            state = 'loading';
            const script = document.createElement('script');
            script.src = '/cheats.js' + (__rpgFixesV ? `?v=${encodeURIComponent(__rpgFixesV)}` : '');
            script.onload = () => { state = 'ready'; if (openOnLoad && window.__rpgCheats) window.__rpgCheats.open(); };
            script.onerror = () => { state = 'idle'; console.warn('[RPG Fixes] Чит-меню не загрузилось'); };
            document.body.appendChild(script);
        };
        addMenuItem({ id: '_sys_cheat', section: 'game', icon: 'wand', label: T.cheats, onClick: () => load(true) });
        // Режимы, включённые в прошлый раз (скорость, сквозь стены, без случайных боёв — ключ тот же, что в cheats.js),
        // работают и после перезапуска: чит-меню грузим сразу, не открывая
        let kept = '';
        try { kept = localStorage.getItem(`rpgCheatsModes_${(window.__RPG && window.__RPG.id) || location.pathname}`) || ''; } catch (e) { /* без хранилища */ }
        if (kept.includes('true')) document.addEventListener('DOMContentLoaded', () => load(false));
    }

    // Сообщение поверх игры на пару секунд (моменты, сейвы, «скрыть»)
    function gameNote(text) {
        // Игра скрыта (H) — ничего поверх тёмного экрана
        if (window.__rpgPanic && window.__rpgPanic.isOn()) return;
        let el = document.getElementById('_game_note');
        if (!el) {
            el = document.createElement('div');
            el.id = '_game_note';
            el.style.cssText = 'display:none; position:fixed; top:15px; left:50%; transform:translateX(-50%); max-width:min(90vw, 520px); background:rgba(14,14,18,0.92); color:#fff; padding:7px 18px; border-radius:20px; z-index:2147483647; font:600 13px/1.35 system-ui, sans-serif; text-align:center; border:1px solid rgba(217,180,94,0.45); pointer-events:none; box-shadow:0 4px 10px rgba(0,0,0,0.5);';
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.style.display = 'block';
        clearTimeout(gameNote.t);
        gameNote.t = setTimeout(() => { el.style.display = 'none'; }, Math.max(2500, text.length * 60));
    }

    // Снимок экрана игры, JPEG (data:): width точек в ширину, 0 — как у игры. Наши окна в него не попадают — только
    // то, что нарисовала игра. В меню (сохранение из меню игры) на экране само меню — берём кадр, который игра запомнила
    // перед его открытием (фон меню): это и есть место, где стоял. actual — кадр как на экране (снимок F8)
    function sceneShot(width = 320, quality = 0.72, actual = false) {
        const c = sceneCanvas(width, actual);
        return c ? c.toDataURL('image/jpeg', quality) : '';
    }
    // Кадр сцены на холсте нужной ширины (0 — как есть) или null. Снимок — в этот же миг: он и есть «этот момент»
    function sceneCanvas(width = 320, actual = false) {
        if (typeof SceneManager === 'undefined' || !SceneManager.snap) return null;
        const scene = SceneManager._scene;
        const onMap = typeof Scene_Map !== 'undefined' && scene instanceof Scene_Map;
        const bg = !onMap && !actual && SceneManager.backgroundBitmap ? SceneManager.backgroundBitmap() : null;
        const bmp = onMap || !bg ? SceneManager.snap() : bg;
        let src = bmp && (bmp.canvas || bmp._canvas);
        // Плагин подменил снимок движка (кадр без холста, как в TOD) — снимаем сцену сами, через PIXI, как движок
        if (!src) {
            const renderer = typeof Graphics !== 'undefined' && ((Graphics.app && Graphics.app.renderer) || Graphics._renderer);
            try { if (renderer && renderer.extract && scene) src = renderer.extract.canvas(scene); } catch (e) { src = null; }
        }
        try {
            if (!src || !src.width || !src.height) return null;
            return scaledCanvas(src, width);
        } finally {
            // Снимок движка — убрать, но только после перерисовки: destroy у MZ обнуляет его холст (кадр выходил пустым)
            if (bmp && bmp !== bg && typeof bmp.destroy === 'function') bmp.destroy();
        }
    }

    function scaledCanvas(src, width) {
        const w = width || src.width;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = Math.max(1, Math.round((w * src.height) / src.width));
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        return c;
    }
    // Сжатие в JPEG — не в кадре игры: toBlob делает его в фоне (toDataURL на большом кадре — заметная заминка)
    function jpegOf(canvas, quality) {
        if (!canvas) return Promise.resolve('');
        return new Promise((resolve) => {
            const sync = () => { try { resolve(canvas.toDataURL('image/jpeg', quality)); } catch (e) { resolve(''); } };
            if (!canvas.toBlob) { sync(); return; }
            try {
                canvas.toBlob((blob) => {
                    if (!blob) { sync(); return; }
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || ''));
                    reader.onerror = () => resolve('');
                    reader.readAsDataURL(blob);
                }, 'image/jpeg', quality);
            } catch (e) { sync(); }
        });
    }

    // Сейв загружен (момент или слот) — дальше как экран загрузки игры (Scene_Load): карта заново, если игру обновили,
    // музыка и время игры — как на момент сохранения
    function enterLoadedGame() {
        if (typeof $gameSystem.versionId === 'function' && $gameSystem.versionId() !== $dataSystem.versionId) {
            $gamePlayer.reserveTransfer($gameMap.mapId(), $gamePlayer.x, $gamePlayer.y, $gamePlayer.direction(), 0);
            $gamePlayer.requestMapReload();
        }
        if (typeof AudioManager !== 'undefined' && AudioManager.stopMe) AudioManager.stopMe();
        // Ролик сцены шёл — стоп: после загрузки он остался бы поверх карты
        try {
            if (typeof Graphics !== 'undefined' && Graphics._video && Graphics._onVideoEnd && Graphics.isVideoPlaying && Graphics.isVideoPlaying()) { Graphics._video.pause(); Graphics._onVideoEnd(); }
            else if (typeof Video !== 'undefined' && Video._element && Video._onEnd && Video.isPlaying && Video.isPlaying()) { Video._element.pause(); Video._onEnd(); }
        } catch (e) { /* без ролика */ }
        // Из боя или меню: сцены под ними (карта под боем) — прочь, как при загрузке с титула
        if (SceneManager.clearStack) SceneManager.clearStack();
        SceneManager.goto(Scene_Map);
        if ($gameSystem.onAfterLoad) $gameSystem.onAfterLoad();
    }

    // Объекты игры подменяем только в своей пустой сцене (как Scene_Load у самой игры), не под живой Scene_Map. Иначе
    // старая карта, пока затемняется перед сменой сцены, обновляет уже новые объекты по своим данным карты ($dataMap):
    // событие из сейва не находит себя там — «Game has encountered a bug». Новая Scene_Map потом грузит карту сейва сама
    function inLoadScene(run) {
        return new Promise((resolve, reject) => {
            function Scene_MimikinLoad() { Scene_Base.apply(this, arguments); }
            Scene_MimikinLoad.prototype = Object.create(Scene_Base.prototype);
            Scene_MimikinLoad.prototype.constructor = Scene_MimikinLoad;
            Scene_MimikinLoad.prototype.start = function () {
                Scene_Base.prototype.start.call(this);
                let done;
                try { done = Promise.resolve(run()); } catch (e) { done = Promise.reject(e); }
                done.then(resolve, (e) => {
                    // Не вышло — не оставлять пустой экран: на первый экран игры
                    if (typeof Scene_Title !== 'undefined') SceneManager.goto(Scene_Title);
                    reject(e);
                });
            };
            SceneManager.goto(Scene_MimikinLoad);
        });
    }

    // Игру открыли сразу на моменте или сейве (?mark=, ?slot=): ждём, пока она встанет на первый экран (титул или
    // заставку) и придут сейвы из облака, — тогда fn. Параметр из адреса потом убираем: перезапуск — с начала
    function whenGameShown(fn) {
        const t0 = Date.now();
        const timer = setInterval(() => {
            if (typeof SceneManager === 'undefined' || typeof DataManager === 'undefined' || !DataManager.isDatabaseLoaded || !DataManager.isDatabaseLoaded()) return;
            const scene = SceneManager._scene;
            // Сцена запущена: в MV — SceneManager._sceneStarted, в MZ такого поля нет — scene.isStarted(). Без этого в
            // играх MZ «Играть отсюда» (момент, сейв) открывало титул и ничего не загружало
            const started = SceneManager._sceneStarted !== undefined ? SceneManager._sceneStarted : !!(scene && scene.isStarted && scene.isStarted());
            if (!scene || (typeof Scene_Boot !== 'undefined' && scene instanceof Scene_Boot) || SceneManager._nextScene || !started) return;
            if (cloudApi && !cloudApi.ready() && Date.now() - t0 < 5000) return;
            clearInterval(timer);
            fn();
        }, 100);
        setTimeout(() => clearInterval(timer), 120000);
    }
    function dropLaunchParam(name) {
        try {
            const params = new URLSearchParams(location.search);
            params.delete(name);
            history.replaceState(history.state, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`);
        } catch (e) { /* адрес остаётся */ }
    }

    // Сейв игры из окна игры в библиотеке («Продолжить с…» → слот): ?slot=<ключ слота>, загружает сам движок
    function setupSlotLaunch() {
        let key = '';
        try { key = new URLSearchParams(location.search).get('slot') || ''; } catch (e) { /* без адреса */ }
        const m = /file(\d+)$/i.exec(key);
        if (!m) return;
        whenGameShown(() => {
            inLoadScene(async () => {
                // MV отвечает сразу (true / false), MZ — обещанием
                const ok = await DataManager.loadGame(Number(m[1]));
                if (ok === false) throw new Error('load');
                enterLoadedGame();
            }).then(() => dropLaunchParam('slot')).catch(() => gameNote(T.slot_load_failed));
        });
    }

    // Сейв, загруженный посреди сообщения, продолжил бы со следующей команды: окна сообщения в сейве нет, и
    // реплика, на которой запомнили, пропала бы. Отматываем самое глубокое событие к началу этой реплики
    // (или выбора) — она покажется снова
    function rewindMessage(interpreter) {
        let it = interpreter;
        while (it && it._childInterpreter && it._childInterpreter._list) it = it._childInterpreter;
        if (!it || it._waitMode !== 'message' || !Array.isArray(it._list)) return false;
        const code = (k) => (it._list[k] ? it._list[k].code : 0);
        const after = it._index;
        let i = after - 1;
        // Выбор, ввод числа или предмета — после текста или сами по себе
        const ask = [102, 103, 104].includes(code(i));
        if (ask) i--;
        while (i > 0 && code(i) === 401) i--;
        if (code(i) === 101) it._index = i;
        else if (ask) it._index = after - 1;
        else return false;
        it._waitMode = '';
        return true;
    }

    // ============================================================================
    // МОМЕНТЫ: «Запомнить момент» — сейв этого мгновения (где угодно, хоть посреди сцены) и снимок экрана на сервер
    // (utils/marks.js); вернуться — из списка здесь же или из окна игры в библиотеке (игра откроется сразу на нём:
    // ?mark=<id>). Это не слот игры: в её списке сохранений моментов нет, и слоты они не занимают. Сохраняться
    // в слоты — меню самой игры
    // ============================================================================
    function setupSceneMarks() {
        const BASE = window.__RPG && window.__RPG.marks;
        if (!BASE) return;   // игра на адресе библиотеки (по-старому) — без закладок
        const url = (rest) => `${BASE}/${encodeURIComponent(GAME_ID)}${rest || ''}`;
        // Коды сообщений — прочь: \N[1], \C[2], и с цифрой перед скобкой — лица и картинки плагинов (\F3[wes_hoho] в
        // Leila), и в угловых (\n<Имя>); игра их ещё не превратила или уже превратила в \x1b
        const plainText = (s) => String(s || '').replace(/(?:\x1b|\\)[A-Za-z]+\d*\[[^\]]*\]|(?:\x1b|\\)[A-Za-z]+\d*<[^>]*>|\x1b|\\[A-Za-z{}|.!<>^$]/g, '').replace(/\s+/g, ' ').trim();
        const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
        const mapName = () => {
            try {
                const shown = $gameMap.displayName && $gameMap.displayName();
                if (shown) return plainText(shown);
                const info = typeof $dataMapInfos !== 'undefined' && $dataMapInfos[$gameMap.mapId()];
                return info ? plainText(info.name) : '';
            } catch (e) { return ''; }
        };
        // Подпись — реплика на экране (по ней сцену и узнают), без неё — карта
        const labelNow = () => {
            let text = '';
            try { if ($gameMessage.hasText && $gameMessage.hasText()) text = plainText($gameMessage._texts.join(' ')); } catch (e) { /* без реплики */ }
            return text ? short(text, 70) : mapName();
        };
        const hidden = () => !!(window.__rpgPanic && window.__rpgPanic.isOn());
        // Сейв возможен на карте, не посреди перехода: как у «Запомнить момент» всегда
        const onMapNow = () => {
            const scene = typeof SceneManager !== 'undefined' && SceneManager._scene;
            return typeof Scene_Map !== 'undefined' && scene instanceof Scene_Map && !!$gamePlayer && !$gamePlayer.isTransferring() && !SceneManager._nextScene;
        };
        // Как перед обычным сохранением (музыка, время игры), но счётчик сохранений игры не трогаем: момент — не сохранение
        const saveNow = () => {
            const count = $gameSystem._saveCount;
            try {
                if ($gameSystem.onBeforeSave) $gameSystem.onBeforeSave();
            } finally {
                $gameSystem._saveCount = count;
            }
            return JsonEx.stringify(DataManager.makeSaveContents());
        };

        // Где это состояние на ленте: прохождение (_rpgLine) и последняя точка его истории (_rpgLast) — в самом сейве
        // ($gameSystem): приходят с загрузкой любого сейва, момента или точки и уходят в каждую новую (utils/marks.js:
        // trail). Новая игра — пустой $gameSystem, значит и новое прохождение
        const newId = () => `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;
        // Когда нынешнее состояние уже было где-то запомнено — точкой или загрузкой: «Где вышли» без игры после этого
        // не нужна (загрузили старый слот посмотреть и ушли — «Продолжить» не должно его предлагать)
        let stateAt = Date.now();
        // Клавиши, геймпад (Input) и касания; у старых MV времени ввода нет — тогда считаем, что играли (как без условия)
        const inputAt = () => (typeof Input === 'undefined' || Input.date === undefined ? Infinity
            : Math.max(Input.date || 0, (typeof TouchInput !== 'undefined' && TouchInput.date) || 0));
        const lineNow = () => { if (!$gameSystem._rpgLine) $gameSystem._rpgLine = newId(); return $gameSystem._rpgLine; };

        // Всё, что нужно запомнить, — сразу, в эту же миллисекунду (перед боем мгновение спустя будет уже бой); сжатие
        // кадров и отправка — потом. kind: mark — момент, shot — снимок (на карте становится моментом: сейв есть), auto —
        // точка перемотки. actual — кадр как на экране (снимок P); иначе в меню — карта под ним. side — точка сбоку
        // истории («До перемотки», «Где вышли»): в её сейве путь идёт от неё, а игра дальше — от прежней. null — сейва
        // здесь не сделать
        function capture({ kind, why = '', label = '', actual = false, side = false }) {
            const saveable = onMapNow();
            if (kind !== 'shot' && !saveable) return null;
            let canvas = null;
            try { canvas = sceneCanvas(kind === 'auto' ? 480 : 0, actual); } catch (e) { canvas = null; }
            if (kind === 'shot' && !canvas) return null;
            let value = '';
            let chain = {};
            if (saveable) {
                const id = newId();
                const parent = $gameSystem._rpgLast || '';
                chain = { id, parent, line: lineNow() };
                // Своё id — в сейв до сохранения: загрузят эту точку — следующие пойдут от неё. Сейв не вышел — путь как был
                $gameSystem._rpgLast = id;
                try {
                    value = saveNow();
                } catch (e) {
                    $gameSystem._rpgLast = parent;
                    throw e;
                }
                if (side) $gameSystem._rpgLast = parent;
                stateAt = Date.now();
            }
            let playtime = 0;
            try { playtime = $gameSystem.playtime(); } catch (e) { /* без времени */ }
            const thumb = jpegOf(canvas && kind !== 'auto' ? scaledCanvas(canvas, 480) : canvas, 0.75);
            const shot = kind !== 'auto' ? jpegOf(canvas, 0.9) : Promise.resolve('');
            return { kind: kind === 'shot' && saveable ? 'mark' : kind, why, label: label || labelNow(), map: mapName(), value, thumb, shot, playtime, side, ...chain };
        }
        // Отправка — по очереди: успеем узнать, что точка не записалась, раньше, чем уйдёт следующая от неё. lost — id,
        // которых на сервере нет (не записалась — её предок, сервер дал другой или слил с прежней — тот id): предком
        // следующей станет тот, кто есть, и путь не оборвётся
        const lost = new Map();
        const present = (id) => { let p = id; for (let n = 0; p && lost.has(p) && n < 100; n++) p = lost.get(p); return p || ''; };
        const repoint = (body) => { try { if (body.id && !body.side && $gameSystem._rpgLast === body.id) $gameSystem._rpgLast = present(body.id); } catch (e) { /* без игры */ } };
        let sending = Promise.resolve();
        function post(body) {
            const run = sending.then(() => send(body));
            sending = run.catch(() => {});
            return run;
        }
        async function send(body) {
            const { side, ...rest } = body;
            const ready = { ...rest, parent: present(body.parent), thumb: await body.thumb, shot: await body.shot };
            const fail = (err) => {
                if (body.id) lost.set(body.id, ready.parent);
                repoint(body);
                return err;
            };
            let res;
            try {
                // Сервер принял и молчит — не держим очередь: за этой точкой стоят P, «Путь» и «Где вышли»
                res = await fetch(url(), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ready), ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(60000) } : {}) });
            } catch (e) { throw fail(e); }
            if (res.status === 409) throw fail(Object.assign(new Error('full'), { full: true }));
            if (!res.ok) throw fail(new Error(String(res.status)));
            const r = await res.json();
            if (r && r.id && body.id && r.id !== body.id) {
                lost.set(body.id, r.id);
                repoint(body);
            }
            return r;
        }

        // label — своя подпись (чит-меню: «До открытия сцен»), без неё — реплика на экране или карта
        async function remember(label) {
            const body = capture({ kind: 'mark', label });
            if (!body) { gameNote(T.mark_blocked); return false; }
            try {
                const r = await post(body);
                if (r && r.id) journal({ kind: 'shot', label: body.label, mark: r.id });
                gameNote(T.mark_saved);
                return true;
            } catch (e) {
                gameNote(e.full ? T.mark_full : T.mark_failed);
                return false;
            }
        }

        async function fetchValue(id) {
            const res = await fetch(url(`/${encodeURIComponent(id)}`), { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) throw new Error(String(res.status));
            return (await res.json()).value;
        }
        async function fetchList() {
            const res = await fetch(url(), { credentials: 'same-origin', cache: 'no-store' });
            return res.ok ? res.json() : [];
        }
        // Путь к нынешнему состоянию: точки, от которых оно пошло (не ветки, от которых перемотали)
        async function fetchTrail() {
            let from = '';
            try { from = $gameSystem._rpgLast || ''; } catch (e) { /* без игры */ }
            if (!from) return [];
            const res = await fetch(url(`/trail/${encodeURIComponent(from)}`), { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
            return res && res.ok ? ((await res.json()).trail || []) : [];
        }

        // Загрузить — как экран загрузки игры (Scene_Load): объекты игры из сейва, карта — заново, если игру
        // обновили, музыка и время игры — как в момент сохранения
        // atEdge — снимок реплики на границе (между репликами): интерпретатор ждёт закрытия прежней, а её уже нет — идёт
        // дальше, к следующей. Отматывать его к началу прежней (rewindMessage) не надо
        // Подмена — в пустой сцене (inLoadScene), поэтому обещание: выполнится, когда сейв уже стоит
        function applySave(json, atEdge = false) {
            stateAt = Date.now();
            const contents = JsonEx.parse(json);
            return inLoadScene(() => {
                DataManager.createGameObjects();
                DataManager.extractSaveContents(contents);
                if (typeof DataManager.correctDataErrors === 'function') DataManager.correctDataErrors();
                if (!atEdge) rewindMessage($gameMap && $gameMap._interpreter);
                // Вернулись — новая карта под ногами не повод ставить точку: она уже есть
                lastAny = lastAt.map = Date.now();
                try { lastMapId = $gameMap.mapId(); } catch (e) { /* без карты */ }
                enterLoadedGame();
            });
        }

        // Дата — на языке меню игры, а не браузера
        const lang = Object.keys(UI_TEXT).find((k) => UI_TEXT[k] === T) || 'ru';
        const when = (at) => { try { return new Date(at).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
        const ago = (at) => {
            const min = Math.floor((Date.now() - at) / 60000);
            if (min < 1) return T.ago_now;
            if (min < 60) return T.ago_min(min);
            if (min < 24 * 60) return T.ago_h(Math.floor(min / 60));
            return when(at);
        };

        // --- Снимок: F8 или пункт меню. На карте — ещё и момент, к нему можно вернуться ---
        let toast = null;
        function shotToast(thumb, moment) {
            if (!toast) {
                const style = document.createElement('style');
                style.textContent = `
                    #_shot { position: fixed; z-index: 2147483646; top: max(14px, env(safe-area-inset-top)); right: max(14px, env(safe-area-inset-right)); display: flex; gap: 12px; align-items: center;
                        max-width: min(430px, calc(100vw - 28px)); padding: 9px 14px 9px 9px; border-radius: 12px; background: rgba(14,14,18,0.94); border: 1px solid rgba(217,180,94,0.45);
                        box-shadow: 0 12px 30px rgba(0,0,0,0.5); color: rgba(255,255,255,0.92); font: 500 13px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif; pointer-events: none;
                        transition: opacity 0.25s, transform 0.25s; }
                    #_shot img { width: 104px; height: 78px; object-fit: cover; border-radius: 6px; flex-shrink: 0; }
                    #_shot b { display: block; color: #e9c97a; font-size: 14px; }
                    #_shot small { display: block; color: rgba(255,255,255,0.58); font-size: 12px; margin-top: 3px; }
                    #_shot._out { opacity: 0; transform: translateY(-8px); }
                    #_flash { position: fixed; inset: 0; z-index: 2147483645; background: #fff; opacity: 0; pointer-events: none; transition: opacity 0.35s; }
                    @media (prefers-reduced-motion: reduce) { #_shot, #_flash { transition: none; } }
                `;
                document.head.appendChild(style);
                toast = document.createElement('div');
                toast.id = '_shot';
                toast.setAttribute('role', 'status');
                toast.innerHTML = '<img alt=""><div><b></b><small class="_s1"></small><small class="_s2"></small></div>';
                toast.className = '_out';
                document.body.appendChild(toast);
            }
            toast.querySelector('img').src = thumb;
            toast.querySelector('b').textContent = T.shot_saved;
            toast.querySelector('._s1').textContent = moment ? T.shot_moment : T.shot_only;
            toast.querySelector('._s2').textContent = T.shot_where;
            toast.classList.remove('_out');
            clearTimeout(shotToast.t);
            shotToast.t = setTimeout(() => toast.classList.add('_out'), 4000);
        }
        // Вспышка, как у фотоаппарата: понятно, что кадр снят, ещё до ответа сервера
        function flash() {
            let el = document.getElementById('_flash');
            if (!el) { el = document.createElement('div'); el.id = '_flash'; document.body.appendChild(el); }
            el.style.transition = 'none';
            el.style.opacity = '0.45';
            requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = ''; el.style.opacity = '0'; }));
        }
        let shooting = false;
        async function takeShot() {
            if (shooting || hidden() || typeof SceneManager === 'undefined' || !SceneManager._scene) return;
            let body = null;
            try { body = capture({ kind: 'shot', actual: true }); } catch (e) { body = null; }
            if (!body) { gameNote(T.shot_failed); return; }
            flash();
            shooting = true;
            try {
                const r = await post(body);
                if (r && r.id) journal({ kind: 'shot', label: body.label, mark: r.id });
                shotToast((await body.thumb) || (await body.shot), body.kind === 'mark');
            } catch (e) {
                gameNote(e.full ? T.mark_full : T.mark_failed);
            } finally {
                shooting = false;
            }
        }

        // --- Перемотка: точки ставит сама игра ---
        // Перед сценой, перед каждым выбором и перед боем — это ровно те места, куда хочется вернуться после проигрыша
        // или не того ответа. Новая карта и время (10 минут игры) — не следом за другой точкой. Та же сцена или тот же
        // вопрос снова (меню из выборов, повторяющееся событие) — точка уже есть. Хранит сервер — у каждой причины свой
        // запас (utils/marks.js)
        const GAP = { timer: 10 * 60e3, map: 2 * 60e3, battle: 30e3, choice: 1500, scene: 5e3 };
        const lastAt = {};
        const lastKey = {};
        let lastAny = 0;
        let lastMapId = 0;
        let played = 0;
        const NONE = Promise.resolve(null);
        function autoPoint(why, label, key = label) {
            if (hidden()) return NONE;
            const now = Date.now();
            if (now - (lastAt[why] || 0) < GAP[why]) return NONE;
            // Та же сцена снова — не раньше чем через полчаса (автозапуск, который не гасит себя); тот же вопрос — 5 минут
            if (key && lastKey[why] === key && now - (lastAt[why] || 0) < (why === 'scene' ? 30 : 5) * 60e3) return NONE;
            if ((why === 'timer' || why === 'map') && now - lastAny < 60e3) return NONE;
            let body = null;
            try { body = capture({ kind: 'auto', why, label }); } catch (e) { body = null; }
            if (!body) return NONE;
            lastAt[why] = lastAny = now;
            lastKey[why] = key;
            played = 0;
            // Не записалась — следующая будет
            return post(body).then((r) => (r && r.id) || null, () => null);
        }
        // --- «Путь» по игре (utils/journal.js): новые локации, сцены, выборы с ответом, бои, свои снимки. Повторы отсеивает
        // сервер (локация и сцена — в первый раз, бои подряд — одной записью). Не записалось — не беда: это не сейв
        const JOURNAL = window.__RPG && window.__RPG.journal;
        const jurl = (rest) => `${JOURNAL}/${encodeURIComponent(GAME_ID)}${rest || ''}`;
        const sendJson = (to, body) => fetch(to, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then((r) => (r.ok ? r.json() : null), () => null);
        // Где и когда — в миг события: запись может уйти позже (сцена ждёт свою точку перемотки), игра уже уйдёт дальше
        function snapshot() {
            const snap = { t: Date.now(), map: '', mapId: 0, playtime: 0 };
            try { snap.playtime = $gameSystem.playtime(); } catch (e) { /* без времени */ }
            try { snap.map = mapName(); snap.mapId = $gameMap.mapId(); } catch (e) { /* без карты */ }
            return snap;
        }
        function journal(entry, snap = snapshot()) {
            if (!JOURNAL) return NONE;
            const { t, ...where } = snap;
            return sendJson(jurl(), { ...where, ...entry, ago: Date.now() - t });
        }
        // Сцена: запись, а кадр — через 3 с, когда на экране уже сама сцена, а не карта перед ней
        function sceneJournal(label, key, point) {
            const snap = snapshot();
            point.then((id) => journal({ kind: 'scene', label, key, ...(id ? { point: id } : {}) }, snap)).then((r) => {
                if (!r || !r.id || r.skipped) return;
                setTimeout(() => {
                    let thumb = '';
                    try { thumb = sceneShot(240, 0.7, true); } catch (e) { /* без кадра */ }
                    if (thumb) sendJson(jurl(`/${encodeURIComponent(r.id)}/thumb`), { thumb });
                }, 3000);
            });
        }
        let lastChoice = null;   // { at, point } — точка «перед выбором», к ней пойдёт ответ

        // Сцена — событие с разговором (4+ реплики) или с картинкой и текстом; разговор с прохожим в пару фраз — нет.
        // Подпись — первая реплика
        const sceneOf = (list) => {
            if (!Array.isArray(list)) return null;
            let texts = 0;
            let pictures = 0;
            let first = '';
            for (const c of list) {
                if (!c) continue;
                if (c.code === 101) texts++;
                else if (c.code === 231) pictures++;
                else if (c.code === 401 && !first) first = plainText(c.parameters && c.parameters[0]);
            }
            return texts >= 4 || (pictures > 0 && texts > 0) ? short(first, 70) : null;
        };
        // «Ещё не видели» («Путь»): сколько сцен комнаты воспоминаний открыто — тот же разбор, что у чит-меню (cheats.js:
        // roomStatus). Через 3 минуты игры, потом раз в 40: карты он читает фоном, пачками с паузой, — не на старте
        let roomPlayed = 0;
        let roomNext = 3 * 60e3;
        let roomBusy = false;
        let roomFails = 0;
        const loadCheats = () => new Promise((resolve, reject) => {
            if (window.__rpgCheats) { resolve(window.__rpgCheats); return; }
            const script = document.createElement('script');
            script.src = '/cheats.js' + (__rpgFixesV ? `?v=${encodeURIComponent(__rpgFixesV)}` : '');
            script.onload = () => (window.__rpgCheats ? resolve(window.__rpgCheats) : reject(new Error('cheats')));
            script.onerror = () => reject(new Error('cheats'));
            document.body.appendChild(script);
        });
        async function roomScan() {
            if (!JOURNAL || roomBusy) return null;
            roomBusy = true;
            try {
                const cheats = await loadCheats();
                if (!cheats.roomStatus) return null;
                const status = await cheats.roomStatus({ pace: 30 });
                await sendJson(jurl('/room'), status);
                roomFails = 0;
                return status;
            } catch (e) {
                // Карты прочитались не все (сеть, сервер занят) или разбор не сошёлся — ещё раз через 5, потом 20 минут, дальше
                // как обычно, раз в 40: у игры с битой картой не перечитывать все карты каждые 5 минут. Причина — здесь
                console.warn('[RPG Fixes] «Ещё не видели» не посчитано:', e && e.message);
                roomPlayed = 0;
                roomFails++;
                roomNext = (roomFails === 1 ? 5 : roomFails === 2 ? 20 : 40) * 60e3;
                return null;
            } finally {
                roomBusy = false;
            }
        }
        // Время — только игры: вкладка видна, игра не скрыта и стоит на карте
        setInterval(() => {
            if (document.visibilityState !== 'visible' || hidden() || !onMapNow()) return;
            played += 15e3;
            roomPlayed += 15e3;
            if (played >= GAP.timer) autoPoint('timer', '');
            if (roomPlayed >= roomNext) { roomPlayed = 0; roomNext = 40 * 60e3; roomScan(); }
        }, 15e3);
        // Ставим и после плагинов: они подменяют эти методы своими (как у пропуска текста)
        const hook = (owner, name, wrap) => {
            const orig = owner && owner[name];
            if (typeof orig !== 'function' || orig.__rpgRewind) return;
            owner[name] = wrap(orig);
            owner[name].__rpgRewind = true;
        };
        // Реплики: назад по одной, как в визуальных новеллах (Ren'Py). Снимки — в памяти этой вкладки, на сервер не уходят.
        // Снимок — на границе: прежняя реплика закрылась ($gameMessage.clear — его зовёт любое окно сообщений, и своё окно
        // плагина тоже), а следующая ещё не началась: вернулись — голос, картинки и звуки перед ней сыграют снова. Граница
        // годится, только если свежая (EDGE_MS): иначе реплика после прогулки по карте вернула бы на минуты назад. У первой
        // реплики события границы нет — снимок на ней самой, её начало вернёт rewindMessage. Не в бою (его в сейве нет) и не
        // чаще раза в 150 мс (пропуск листает десятки в секунду).
        // Последние LINES_MAX, не больше LINES_BYTES: в тяжёлых играх снимок — сотни КБ
        const LINES_MAX = 80;
        const LINES_BYTES = 24e6;
        const EDGE_MS = 15000;
        const whereNow = () => { try { const it = $gameMap._interpreter; return `${$gameMap.mapId()}:${it._eventId}:${it._list ? it._list.length : 0}`; } catch (e) { return ''; } };
        const lines = [];         // { id, kind: 'line', at, label, value, edge, size }
        let edge = null;          // { at, value } — снимок на границе, ждёт свою реплику
        let lineAt = 0;
        let restoringLine = false;
        let replay = false;       // вернулись к реплике — она покажется снова, второй раз её не записываем
        let noted = false;        // эта реплика уже записана: плагины окна (Ironhold Keep) начинают её не один раз
        // Пропуск (Ctrl, RT, кнопка «Пропуск») листает десятки реплик в секунду — их не записываем: снимки тормозили бы его
        const skipping = () => { try { return Input.isPressed('control'); } catch (e) { return false; } };
        const lineSnap = () => {
            if (!onMapNow() || skipping() || Date.now() - lineAt < 150) return null;
            lineAt = Date.now();
            try { return saveNow(); } catch (e) { return null; }
        };
        // Реплики прежнего состояния (загрузка слота, точки, новая игра) — прочь; первая реплика после — снова записывается
        const forgetLines = () => { lines.length = 0; edge = null; noted = false; replay = false; };
        const noteLine = () => {
            if (noted) return;
            noted = true;
            if (replay) { replay = false; edge = null; return; }
            if (skipping()) { edge = null; return; }
            let text = '';
            try { text = plainText($gameMessage.allText ? $gameMessage.allText() : ($gameMessage._texts || []).join(' ')); } catch (e) { text = ''; }
            if (!text) return;
            let who = '';
            try { who = plainText($gameMessage.speakerName ? $gameMessage.speakerName() : ''); } catch (e) { who = ''; }
            // Граница — того же места: карта и событие те же (событие кончилось, потом перенос или другой NPC — уже не она)
            const fresh = edge && edge.value && Date.now() - edge.at < EDGE_MS && edge.where === whereNow();
            if (!fresh) lineAt = 0;   // своей границы нет — снимок на самой реплике, без паузы в 150 мс
            const value = fresh ? edge.value : lineSnap();
            const isEdge = !!fresh;
            edge = null;
            if (!value) return;
            lines.push({ id: `line-${newId()}`, kind: 'line', why: 'line', at: Date.now(), label: short(who ? `${who}: ${text}` : text, 140), value, edge: isEdge, size: value.length * 2 });
            let bytes = lines.reduce((n, l) => n + l.size, 0);
            while (lines.length > LINES_MAX || (lines.length > 1 && bytes > LINES_BYTES)) bytes -= lines.shift().size;
        };
        const install = () => {
            // Загрузка сейва своим меню игры — тоже «запомненное состояние» (stateAt). Реплики до неё — из другого
            // состояния: назад по ним не вернуться (кроме возврата к реплике — он сам и загружает)
            if (typeof DataManager !== 'undefined') hook(DataManager, 'extractSaveContents', (orig) => function () {
                const r = orig.apply(this, arguments);
                stateAt = Date.now();
                if (!restoringLine) forgetLines();
                return r;
            });
            // Новая игра — тоже другое состояние: реплики прошлого прохождения туда не ведут
            if (typeof DataManager !== 'undefined') hook(DataManager, 'setupNewGame', (orig) => function () {
                forgetLines();
                return orig.apply(this, arguments);
            });
            if (typeof Window_Message !== 'undefined') {
                hook(Window_Message.prototype, 'startMessage', (orig) => function () {
                    const r = orig.apply(this, arguments);
                    try { noteLine(); } catch (e) { /* без реплики */ }
                    return r;
                });
            }
            // Только у того $gameMessage, что в игре: новый (загрузка сейва, createGameObjects) чистится ещё до того, как им станет
            if (typeof Game_Message !== 'undefined') hook(Game_Message.prototype, 'clear', (orig) => function () {
                const r = orig.apply(this, arguments);
                if (this === window.$gameMessage && !restoringLine) {
                    noted = false;
                    // Очистку зовут и дважды подряд — снятую только что границу не затираем пустой
                    const value = lineSnap();
                    if (value) edge = { at: Date.now(), value, where: whereNow() };
                    else if (!edge || Date.now() - edge.at > 1000) edge = null;
                }
                return r;
            });
            // Перед сценой: событие на карте только начинается — сейв в эту миллисекунду, загрузили — сцена с начала
            if (typeof Game_Interpreter !== 'undefined') hook(Game_Interpreter.prototype, 'setup', (orig) => function (list, eventId) {
                const r = orig.apply(this, arguments);
                try {
                    const label = typeof $gameMap !== 'undefined' && this === $gameMap._interpreter ? sceneOf(list) : null;
                    if (label !== null) {
                        const key = `${$gameMap.mapId()}:${eventId || 0}:${list.length}`;
                        sceneJournal(label, key, autoPoint('scene', label, key));
                    }
                } catch (e) { /* без точки */ }
                return r;
            });
            // Сцена в общем событии (событие на карте зовёт его одной командой) — перед вызовом: загрузили — вызов снова.
            // Только в цепочке события на карте: параллельные события идут сами по себе, их середина — не начало сцены
            const inMapChain = (it) => {
                for (let x = typeof $gameMap !== 'undefined' && $gameMap._interpreter; x; x = x._childInterpreter) if (x === it) return true;
                return false;
            };
            if (typeof Game_Interpreter !== 'undefined') hook(Game_Interpreter.prototype, 'command117', (orig) => function (params) {
                try {
                    if (!inMapChain(this)) return orig.apply(this, arguments);
                    const id = (params || this._params || [])[0];
                    const common = typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents[id];
                    const label = common ? sceneOf(common.list) : null;
                    if (label !== null) sceneJournal(label, `ce:${id}`, autoPoint('scene', label, `ce:${id}`));
                } catch (e) { /* без точки */ }
                return orig.apply(this, arguments);
            });
            // Перед боем: состояние ещё до боя (BattleManager.setup зовут с карты, бой начнётся следом)
            if (typeof BattleManager !== 'undefined') hook(BattleManager, 'setup', (orig) => function (troopId) {
                try {
                    const troop = typeof $dataTroops !== 'undefined' && $dataTroops[troopId];
                    const names = troop ? [...new Set(troop.members.map((m) => $dataEnemies[m.enemyId] && plainText($dataEnemies[m.enemyId].name)).filter(Boolean))] : [];
                    const enemies = short(names.slice(0, 3).join(', '), 60);
                    autoPoint('battle', enemies);
                    journal({ kind: 'battle', label: enemies });
                } catch (e) { /* без точки */ }
                return orig.apply(this, arguments);
            });
            // Перед выбором: когда вопрос уже на экране — в кадре он и виден, а сейв, загруженный посреди сообщения,
            // покажет его снова (rewindMessage). Успели ответить раньше — точки нет: выбор уже сделан
            if (typeof Game_Interpreter !== 'undefined') hook(Game_Interpreter.prototype, 'setupChoices', (orig) => function () {
                const r = orig.apply(this, arguments);
                setTimeout(() => {
                    try {
                        if (!$gameMessage.isChoice()) return;
                        lastChoice = { at: Date.now(), point: autoPoint('choice', short(labelNow() || $gameMessage.choices().map(plainText).join(' / '), 70)) };
                    } catch (e) { /* без точки */ }
                }, 450);
                return r;
            });
            // Ответ на выбор: в «Путь» и к точке «перед выбором». Вопрос ещё на экране — окно сообщения закроется следом
            if (typeof Game_Message !== 'undefined') hook(Game_Message.prototype, 'onChoice', (orig) => function (n) {
                try {
                    const choices = this._choices || [];
                    // Номер ответа не из списка (плагин выбора нумерует по-своему) — текст выделенного пункта в окне выбора
                    let text = Number.isInteger(n) && n >= 0 ? choices[n] : null;
                    if (text == null && !(Number.isInteger(n) && n < 0)) {
                        try {
                            const sc = SceneManager._scene;
                            const w = sc._choiceListWindow || (sc._messageWindow && (sc._messageWindow._choiceWindow || sc._messageWindow._choiceListWindow));
                            if (w && w.commandName && w.index() >= 0) text = w.commandName(w.index());
                        } catch (e) { text = null; }
                    }
                    // Отказ (отмена) — отметкой: слово подставит тот, кто покажет, на своём языке
                    // Выбор картинками: подпись варианта у плагина служебная («Level_3|450|320» в Ember & Frost) — номером
                    const shown = text != null ? plainText(text) : '';
                    const picked = text == null ? { cancel: true }
                        : /^[^\s|]+(\|-?\d+)+$/.test(shown) && Number.isInteger(n) ? { answer: T.choice_n(n + 1) } : { answer: short(shown, 60) };
                    const question = short(labelNow() || choices.map(plainText).join(' / '), 70);
                    const point = lastChoice && Date.now() - lastChoice.at < 10 * 60e3 ? lastChoice.point : NONE;
                    lastChoice = null;
                    const snap = snapshot();
                    point.then((id) => {
                        if (id) sendJson(url(`/${encodeURIComponent(id)}/answer`), picked);
                        journal({ kind: 'choice', label: question, ...picked, ...(id ? { point: id } : {}) }, snap);
                    });
                } catch (e) { /* без записи */ }
                return orig.apply(this, arguments);
            });
            // Новая карта — когда она уже на экране: после затемнения перехода (иначе в кадре чёрный экран)
            if (typeof Scene_Map !== 'undefined') hook(Scene_Map.prototype, 'start', (orig) => function () {
                const r = orig.apply(this, arguments);
                const scene = this;
                let tries = 0;
                const check = () => {
                    try {
                        if (SceneManager._scene !== scene) return;
                        if ((!onMapNow() || $gameScreen.brightness() < 255) && ++tries < 12) { setTimeout(check, 500); return; }
                        const id = $gameMap.mapId();
                        if (id === lastMapId || $gameScreen.brightness() < 255) return;
                        lastMapId = id;
                        autoPoint('map', mapName());
                        journal({ kind: 'map', label: mapName() });
                    } catch (e) { /* без точки */ }
                };
                setTimeout(check, 1200);
                return r;
            });
            // Проиграли — сразу предлагаем перемотку. Сразу же и перехватываем клавиши: Enter по привычке, пока грузится
            // список, увёл бы на титул
            if (typeof Scene_Gameover !== 'undefined') hook(Scene_Gameover.prototype, 'start', (orig) => function () {
                const r = orig.apply(this, arguments);
                openRewind({ over: true });
                return r;
            });
        };
        install();
        const installTimer = setInterval(install, 500);
        setTimeout(() => clearInterval(installTimer), 30000);

        // --- Плёнка перемотки: F9, пункт меню, экран «Игра окончена» ---
        const WHY_ICON = {
            scene: '<path d="M4 6h16v12H4z"/><path d="M10 9.5l4.5 2.5-4.5 2.5z"/>',
            battle: '<path d="M5 19L19 5M14 5h5v5M5 5l14 14M5 14v5h5"/>',
            choice: '<path d="M12 21v-6M12 15L6 9V4M12 15l6-6V4"/>',
            map: '<path d="M12 21s7-6.2 7-11.5a7 7 0 1 0-14 0C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
            timer: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
            back: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
            exit: '<path d="M14 4h5v16h-5"/><path d="M10 16l4-4-4-4M14 12H4"/>',
        };
        // Звезда «оставленного момента» — значком, как причины точек (_rw_why), а не символом шрифта
        const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.5l-5.9 3.2 1.2-6.6L2.5 9.5l6.6-.9z"/></svg>';
        function setStarred(el, text) { el.innerHTML = STAR_SVG; el.append(text); }
        let rewind = null;
        let rwItems = [];
        let rwAt = 0;
        let rwOver = false;
        function buildRewind() {
            const style = document.createElement('style');
            style.textContent = `
                #_rewind { position: fixed; inset: 0; z-index: 2147483647; display: none; flex-direction: column; justify-content: flex-end;
                    background: linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.88) 55%); color: rgba(255,255,255,0.92); font: 500 14px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif;
                    -webkit-user-select: none; user-select: none; }
                #_rewind * { box-sizing: border-box; }
                #_rewind ._rw_head { display: flex; align-items: flex-end; gap: 16px; padding: 0 max(18px, env(safe-area-inset-right)) 12px max(18px, env(safe-area-inset-left)); }
                #_rewind ._rw_title { color: #e9c97a; font-size: 22px; font-weight: 700; }
                #_rewind ._rw_sub { color: rgba(255,255,255,0.65); font-size: 13px; margin-top: 3px; }
                #_rewind ._rw_keys { margin-left: auto; color: rgba(255,255,255,0.5); font-size: 12px; text-align: right; }
                #_rewind ._rw_x { width: 36px; height: 36px; flex-shrink: 0; border-radius: 50%; border: 1px solid rgba(255,255,255,0.22); background: rgba(0,0,0,0.4); color: inherit; font-size: 20px; cursor: pointer; }
                #_rewind ._rw_tabs { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 max(18px, env(safe-area-inset-right)) 2px max(18px, env(safe-area-inset-left)); }
                #_rewind ._rw_tab { min-height: 32px; padding: 0 13px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.45); color: rgba(255,255,255,0.78);
                    font: 600 13px system-ui, -apple-system, 'Segoe UI', sans-serif; cursor: pointer; }
                #_rewind ._rw_tab._on { border-color: #d9b45e; color: #e9c97a; background: rgba(217,180,94,0.14); }
                #_rewind ._rw_strip { display: flex; gap: 12px; overflow-x: auto; overscroll-behavior: contain; scroll-behavior: smooth; padding: 12px max(18px, env(safe-area-inset-right)) 14px max(18px, env(safe-area-inset-left)); scrollbar-width: thin; }
                #_rewind ._rw_card { position: relative; flex: 0 0 min(208px, 44vw); padding: 0; border: 0; border-radius: 10px; background: rgba(14,14,18,0.9); color: inherit; text-align: left; cursor: pointer;
                    outline: 1px solid rgba(255,255,255,0.12); transition: outline-color 0.15s; font: inherit; }
                #_rewind ._rw_card img, #_rewind ._rw_card ._rw_ph { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 10px 10px 0 0; background: #222; }
                #_rewind ._rw_card { opacity: 0.55; }
                #_rewind ._rw_card._on { opacity: 1; outline: 3px solid #d9b45e; }
                #_rewind ._rw_preview { display: flex; justify-content: center; padding: 6px 18px 10px; }
                #_rewind ._rw_preview figure { position: relative; margin: 0; border-radius: 12px; overflow: hidden; background: #000;
                    outline: 2px solid #d9b45e; box-shadow: 0 0 0 6px rgba(217,180,94,0.14), 0 22px 50px rgba(0,0,0,0.65); }
                #_rewind ._rw_preview img { display: block; height: min(32vh, 400px); width: auto; max-width: calc(100vw - 36px); object-fit: contain; }
                #_rewind ._rw_preview figcaption { position: absolute; left: 0; right: 0; bottom: 0; padding: 34px 16px 12px; background: linear-gradient(transparent, rgba(0,0,0,0.88)); }
                #_rewind ._rw_preview b { display: block; color: #fff; font-size: 16px; font-weight: 600; text-shadow: 0 1px 2px #000; }
                #_rewind ._rw_preview small { display: block; margin-top: 3px; color: #e9c97a; font-size: 13px; }
                @media (max-height: 600px) { #_rewind ._rw_preview { display: none !important; } }
                #_rewind ._rw_why { position: absolute; left: 8px; top: 8px; display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px 3px 7px; border-radius: 999px;
                    background: rgba(10,9,7,0.8); border: 1px solid rgba(217,180,94,0.55); color: #e9c97a; font-size: 11px; font-weight: 600; }
                #_rewind ._rw_why svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
                #_rewind ._rw_kept { position: absolute; right: 8px; top: 8px; color: #e9c97a; font-size: 15px; text-shadow: 0 1px 3px #000; }
                #_rewind ._rw_text { padding: 8px 10px 10px; }
                #_rewind ._rw_say { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; padding: 12px; background: rgba(28,24,16,0.95);
                    color: rgba(255,255,255,0.9); font-size: 13px; line-height: 1.4; }
                #_rewind ._rw_label { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; min-height: 2.7em; font-size: 13px; }
                #_rewind ._rw_when { color: rgba(255,255,255,0.5); font-size: 12px; margin-top: 3px; }
                #_rewind ._rw_now { flex: 0 0 auto; align-self: center; color: rgba(255,255,255,0.45); font-size: 12px; writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 0.04em; }
                #_rewind ._rw_bar { display: flex; flex-wrap: wrap; gap: 10px; padding: 0 max(18px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); }
                #_rewind ._rw_go, #_rewind ._rw_keep { min-height: 42px; padding: 0 20px; border-radius: 9px; font: 600 14px system-ui, -apple-system, 'Segoe UI', sans-serif; cursor: pointer; }
                #_rewind ._rw_go { border: 1px solid #d9b45e; background: #d9b45e; color: #141008; }
                #_rewind ._rw_keep { border: 1px solid rgba(217,180,94,0.55); background: rgba(0,0,0,0.35); color: #e9c97a; }
                #_rewind ._rw_go:disabled, #_rewind ._rw_keep:disabled { opacity: 0.45; cursor: default; }
                #_rewind ._rw_empty { padding: 0 18px 18px; color: rgba(255,255,255,0.7); }
                @media (prefers-reduced-motion: reduce) { #_rewind ._rw_card { transition: none; } #_rewind ._rw_strip { scroll-behavior: auto; } }
                /* На телефоне клавиш нет — подсказка о них не нужна */
                @media (hover: none) { #_rewind ._rw_keys { display: none; } }
                #_rewind ._rw_keys span { display: inline-block; margin-left: 12px; }
                #_rewind ._rw_keys kbd { padding: 1px 6px; margin-right: 5px; border: 1px solid rgba(255,255,255,0.28); border-radius: 4px; font: 600 11px system-ui, sans-serif; color: rgba(255,255,255,0.8); }
                #_rewind ._rw_keep svg, #_rewind ._rw_kept svg, #_rewind ._rw_tab svg { width: 13px; height: 13px; fill: currentColor; vertical-align: -2px; margin-right: 5px; }
                #_rewind ._rw_kept svg { margin: 0; width: 15px; height: 15px; }
            `;
            document.head.appendChild(style);
            rewind = document.createElement('div');
            rewind.id = '_rewind';
            rewind.setAttribute('role', 'dialog');
            rewind.setAttribute('aria-modal', 'true');
            rewind.innerHTML = `<div class="_rw_head"><div><div class="_rw_title"></div><div class="_rw_sub"></div></div><div class="_rw_keys"></div><button type="button" class="_rw_x">×</button></div>
                <div class="_rw_tabs" role="group"></div><div class="_rw_preview" aria-hidden="true"><figure><img alt=""><figcaption><b></b><small></small></figcaption></figure></div><div class="_rw_strip" role="listbox"></div><div class="_rw_bar"><button type="button" class="_rw_go"></button><button type="button" class="_rw_keep"></button></div>`;
            rewind.querySelector('._rw_x').setAttribute('aria-label', T.close);
            // Клавиши — рамкой, подпись рядом: «← →  выбрать». Одной строкой через «·» читалось как набор значков
            for (const [key, what] of T.rewind_keys) {
                const item = document.createElement('span');
                const kbd = document.createElement('kbd');
                kbd.textContent = key;
                item.append(kbd, what);
                rewind.querySelector('._rw_keys').appendChild(item);
            }
            rewind.querySelector('._rw_go').textContent = T.rewind_go;
            setStarred(rewind.querySelector('._rw_keep'), T.rewind_keep);
            rewind.querySelector('._rw_x').addEventListener('click', closeRewind);
            rewind.querySelector('._rw_go').addEventListener('click', jump);
            // Кадр не загрузился — без крупного кадра, а не со значком битой картинки
            rewind.querySelector('._rw_preview img').addEventListener('error', () => { rewind.querySelector('._rw_preview').style.display = 'none'; });
            rewind.querySelector('._rw_keep').addEventListener('click', keep);
            // Касания и щелчки — плёнке, не игре: иначе «Игра окончена» ушла бы на титул от первого же касания
            for (const type of ['mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup', 'pointermove', 'wheel', 'click', 'contextmenu']) {
                rewind.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
            }
            document.body.appendChild(rewind);
            // Клавиши, пока открыта, — ей (раньше игры): ← →, Enter, Esc; браузерные (F5, F11, с Ctrl) — дальше
            window.addEventListener('keydown', (e) => {
                if (!rewind || rewind.style.display === 'none') return;
                // H — «Скрыть» (setupPanic) и при открытой плёнке; под тёмным экраном она клавиш не берёт
                if (hidden() || e.code === 'KeyH') return;
                if (e.ctrlKey || e.metaKey || (/^F\d+$/.test(e.key) && e.key !== 'F9')) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.repeat && !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
                if (e.key === 'ArrowUp') stepGroup(-1);
                else if (e.key === 'ArrowDown') stepGroup(1);
                else if (e.key === 'ArrowLeft') select(rwAt - 1);
                else if (e.key === 'ArrowRight') select(rwAt + 1);
                else if (e.key === 'Enter' || e.key === ' ' || e.key === 'z' || e.key === 'Z') jump();
                else if (e.key === 'Escape' || e.key === 'x' || e.key === 'X' || e.key === 'F9') closeRewind();
            }, true);
            window.addEventListener('keyup', (e) => {
                if (rewind && rewind.style.display !== 'none' && !hidden() && e.code !== 'KeyH' && !e.ctrlKey && !e.metaKey && !/^F\d+$/.test(e.key)) e.stopImmediatePropagation();
            }, true);
        }
        function select(i) {
            if (!rwItems.length) return;
            rwAt = Math.max(0, Math.min(rwItems.length - 1, i));
            const cards = rewind.querySelectorAll('._rw_card');
            cards.forEach((c, k) => { c.classList.toggle('_on', k === rwAt); c.setAttribute('aria-selected', String(k === rwAt)); });
            if (cards[rwAt]) cards[rwAt].scrollIntoView({ block: 'nearest', inline: 'center' });
            // Крупно — куда вернёмся: кадр, почему здесь точка и когда
            const m = rwItems[rwAt];
            const preview = rewind.querySelector('._rw_preview');
            preview.style.display = m.thumb ? '' : 'none';
            if (m.thumb) preview.querySelector('img').src = url(`/${encodeURIComponent(m.id)}/thumb`);
            preview.querySelector('b').textContent = cardTitle(m);
            preview.querySelector('small').textContent = [`${T.rewind_here}, ${ago(m.at)}`, m.answer || m.cancel ? T.rewind_answer(m.cancel ? T.choice_cancel : m.answer) : '', m.map && m.map !== m.label ? m.map : ''].filter(Boolean).join(', ');
            const kept = rwItems[rwAt].kind !== 'auto';
            rewind.querySelector('._rw_keep').style.display = m.kind === 'line' ? 'none' : '';
            rewind.querySelector('._rw_keep').disabled = kept;
            setStarred(rewind.querySelector('._rw_keep'), kept ? T.rewind_kept : T.rewind_keep);
        }
        function cardTitle(m) {
            if (m.kind !== 'auto') return m.label || m.map || '—';
            if (m.why === 'scene') return m.label ? `${T.why_scene}: ${m.label}` : T.why_scene;
            if (m.why === 'battle') return m.label ? `${T.why_battle}: ${m.label}` : T.why_battle;
            if (m.why === 'choice') return m.label ? `${T.why_choice}: ${m.label}` : T.why_choice;
            if (m.why === 'map') return `${T.why_map}${m.map || m.label ? `: ${m.map || m.label}` : ''}`;
            if (m.why === 'back') return `${T.why_back}${m.label ? `: ${m.label}` : ''}`;
            if (m.why === 'exit') return `${T.why_exit}${m.label ? `: ${m.label}` : ''}`;
            return m.label || m.map || '—';
        }
        // Группы плёнки. «Это прохождение» — путь к нынешнему состоянию (точки, от которых оно пошло) и «До перемотки» этого
        // прохождения; внутри — по причине и свои моменты. «Другие прохождения» — всё остальное: другая игра с начала,
        // другое устройство, ветка, от которой перемотали, точки до этой версии. ↑ ↓ — соседняя группа
        const GROUPS = ['lines', 'run', 'scene', 'choice', 'battle', 'map', 'timer', 'back', 'exit', 'own', 'other'];
        const REASONS = ['scene', 'choice', 'battle', 'map', 'timer', 'back', 'exit'];
        const groupOf = (m) => (m.kind !== 'auto' ? 'own' : REASONS.includes(m.why) ? m.why : 'timer');
        let rwAll = [];
        let rwRun = new Set();
        let rwLine = '';
        let rwGroup = 'run';
        const inRun = (m) => rwRun.has(m.id) || (m.why === 'back' && !!m.line && m.line === rwLine);
        // «Мои» — все свои моменты, и с других веток: их сохранил сам человек
        const inGroup = (m, g) => (m.kind === 'line' ? g === 'lines' : g === 'lines' ? false
            : g === 'other' ? !inRun(m) : g === 'own' ? groupOf(m) === 'own' : inRun(m) && (g === 'run' || groupOf(m) === g));
        function renderTabs() {
            const tabs = rewind.querySelector('._rw_tabs');
            tabs.innerHTML = '';
            const present = presentGroups();
            if (!showTabs(present)) { tabs.style.display = 'none'; return; }
            tabs.style.display = '';
            for (const g of present) {
                const n = rwAll.filter((m) => inGroup(m, g)).length;
                const tab = document.createElement('button');
                tab.type = 'button';
                tab.className = `_rw_tab${g === rwGroup ? ' _on' : ''}`;
                tab.setAttribute('aria-pressed', String(g === rwGroup));
                if (g === 'own') setStarred(tab, `${T.rewind_group[g]} ${n}`);
                else tab.textContent = `${T.rewind_group[g]} ${n}`;
                tab.addEventListener('click', () => setGroup(g));
                tabs.appendChild(tab);
            }
        }
        // Группы, у которых есть точки. Кнопок нет, когда выбирать не из чего: одно прохождение и одна причина
        const presentGroups = () => GROUPS.filter((g) => rwAll.some((m) => inGroup(m, g)));
        const showTabs = (present) => present.length >= 3 || ((present.includes('other') || present.includes('lines')) && present.length >= 2);
        // Своё прохождение, иначе — что есть (одни реплики в памяти: точек на сервере ещё нет)
        const firstGroup = () => { const p = presentGroups(); return p.includes('run') ? 'run' : p.includes('other') ? 'other' : p[0] || 'run'; };
        function setGroup(g) {
            const present = presentGroups();
            rwGroup = showTabs(present) && present.includes(g) ? g : firstGroup();
            renderTabs();
            renderStrip();
            select(rwItems.length - 1);
        }
        function stepGroup(d) {
            const present = presentGroups();
            if (!showTabs(present)) return;
            const at = present.indexOf(rwGroup);
            setGroup(present[(at + d + present.length) % present.length]);
        }
        function renderStrip() {
            const strip = rewind.querySelector('._rw_strip');
            strip.innerHTML = '';
            rwItems = rwAll.filter((m) => inGroup(m, rwGroup));
            if (!rwItems.length) {
                const empty = document.createElement('div');
                empty.className = '_rw_empty';
                empty.textContent = T.rewind_empty;
                strip.appendChild(empty);
                rewind.querySelector('._rw_preview').style.display = 'none';
            }
            rwItems.forEach((m, k) => {
                const card = document.createElement('button');
                card.type = 'button';
                card.className = '_rw_card';
                card.setAttribute('role', 'option');
                const pic = m.thumb ? document.createElement('img') : document.createElement('span');
                if (m.thumb) { pic.src = url(`/${encodeURIComponent(m.id)}/thumb`); pic.alt = ''; pic.loading = 'lazy'; } else pic.className = '_rw_ph';
                // Реплика — её текст вместо кадра: кадров у снимков в памяти нет, а узнают реплику по словам
                if (m.kind === 'line') { pic.className = '_rw_ph _rw_say'; pic.textContent = m.label; }
                card.appendChild(pic);
                const icon = m.kind === 'auto' ? WHY_ICON[m.why] || WHY_ICON.timer : '';
                if (icon) {
                    const why = document.createElement('span');
                    why.className = '_rw_why';
                    why.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
                    why.append(T[`why_${WHY_ICON[m.why] ? m.why : 'timer'}_short`]);
                    card.appendChild(why);
                }
                if (m.kind !== 'auto' && m.kind !== 'line') { const star = document.createElement('span'); star.className = '_rw_kept'; star.innerHTML = STAR_SVG; card.appendChild(star); }
                const text = document.createElement('div');
                text.className = '_rw_text';
                const label = document.createElement('div');
                label.className = '_rw_label';
                label.textContent = m.kind === 'line' ? T.rewind_line : cardTitle(m);
                const at = document.createElement('div');
                at.className = '_rw_when';
                at.textContent = [m.answer || m.cancel ? T.rewind_answer(m.cancel ? T.choice_cancel : m.answer) : '', ago(m.at), m.why !== 'map' && m.map && m.map !== m.label ? m.map : ''].filter(Boolean).join(', ');
                text.append(label, at);
                card.appendChild(text);
                // Касание выбирает, второе по той же — возвращает: случайно задев плёнку, игру не потерять
                card.addEventListener('click', () => { if (rwAt === k) jump(); else select(k); });
                strip.appendChild(card);
            });
            if (rwItems.length) {
                const now = document.createElement('div');
                now.className = '_rw_now';
                now.textContent = T.rewind_now;
                strip.appendChild(now);
            }
            rewind.querySelector('._rw_go').disabled = !rwItems.length;
            rewind.querySelector('._rw_keep').style.display = rwItems.length ? '' : 'none';
        }
        async function openRewind({ over = false } = {}) {
            if (hidden()) return;
            setClean(false);
            if (!rewind) buildRewind();
            rwOver = over;
            rwItems = [];
            rwAll = [];
            rewind.querySelector('._rw_title').textContent = over ? T.rewind_over : T.rewind_title;
            rewind.querySelector('._rw_sub').textContent = over ? T.rewind_over_hint : T.rewind_hint;
            rewind.querySelector('._rw_tabs').style.display = 'none';
            rewind.querySelector('._rw_preview').style.display = 'none';
            const strip = rewind.querySelector('._rw_strip');
            strip.innerHTML = `<div class="_rw_empty">${T.marks_loading}</div>`;
            rewind.querySelector('._rw_go').disabled = true;
            rewind.querySelector('._rw_keep').style.display = 'none';
            try { if (typeof Input !== 'undefined' && Input.clear) Input.clear(); } catch (e) { /* без сброса */ }
            rewind.style.display = 'flex';
            holdGame('rewind', true);
            const shown = ++openRewind.turn;
            let items = [];
            let trail = [];
            try {
                [items, trail] = await Promise.all([fetchList(), fetchTrail()]);
                items = items.filter((m) => m.kind === 'auto' || (m.kind === 'mark' && m.save));
            } catch (e) { items = []; }
            // Закрыли, пока грузилось, или открыли снова — этот ответ уже не нужен
            if (shown !== openRewind.turn || rewind.style.display === 'none') return;
            // На экране «Игра окончена» без точек показывать нечего — пусть идёт как шла
            if (over && !items.length) { closeRewind(); return; }
            rwRun = new Set(trail);
            try { rwLine = $gameSystem._rpgLine || ''; } catch (e) { rwLine = ''; }
            // Старые слева, новые справа — как на ленте времени; выбрана последняя
            rwAll = items.sort((a, b) => a.at - b.at);
            // Открыли — сначала это прохождение; после проигрыша — тоже. Выбранная в прошлый раз группа могла опустеть
            rwAll = [...lines, ...rwAll].sort((a, b) => a.at - b.at);
            // «Реплики» — только пока держат ⌫ (holdBack): короткое нажатие после удержания открывает, как раньше
            if (over || rwGroup === 'lines' || !presentGroups().includes(rwGroup) || !showTabs(presentGroups())) rwGroup = firstGroup();
            renderTabs();
            renderStrip();
            // После проигрыша — последняя точка перед боем, если она свежая: обычно туда и надо
            let pick = rwItems.length - 1;
            if (over) {
                for (let k = rwItems.length - 1; k >= 0; k--) {
                    if (rwItems[k].why === 'battle' && Date.now() - rwItems[k].at < 15 * 60e3) { pick = k; break; }
                }
            }
            select(pick);
        }
        function closeRewind() {
            if (!rewind) return;
            rewind.style.display = 'none';
            holdGame('rewind', false);
            try { if (typeof Input !== 'undefined' && Input.clear) Input.clear(); } catch (e) { /* без сброса */ }
            if (window.__rpgRelatch) window.__rpgRelatch();
        }
        async function jump() {
            const m = rwItems[rwAt];
            const go = rewind.querySelector('._rw_go');
            if (!m || go.disabled || hidden()) return;
            // Отовсюду, и из боя: загрузка уводит на карту, бой кончается, как при загрузке с экрана загрузки
            go.disabled = true;
            // Несохранённое не пропадает: где был — снимаем сейчас (с карты), «До перемотки»; передумали — вернуться туда.
            // Отправляем после того, как забрали точку, куда идём: новая «До перемотки» могла вытеснить её из запаса
            let back = null;
            if (!rwOver) { try { back = capture({ kind: 'auto', why: 'back', side: true }); } catch (e) { back = null; } }
            let json = null;
            if (m.kind === 'line') json = m.value;
            else try { json = await fetchValue(m.id); } catch (e) { json = null; }
            go.disabled = false;
            if (!json) {
                // Точку сменили новые, пока плёнка была открыта, — сказать и показать, что есть сейчас
                gameNote(T.rewind_gone);
                openRewind({ over: rwOver });
                return;
            }
            if (back) post(back).catch(() => { /* без страховки */ });
            closeRewind();
            if (m.kind === 'line') {
                // Реплики после неё — уже другое будущее: дальше игра их запишет заново
                lines.splice(lines.indexOf(m) + 1);
                edge = null;
                replay = true;
                noted = false;
                restoringLine = true;
                // Флаг держим, пока сейв не подменён (это уже в пустой сцене, позже)
                try { await applySave(json, m.edge); } catch (e) { gameNote(T.mark_load_failed); } finally { restoringLine = false; }
                return;
            }
            try { await applySave(json); } catch (e) { gameNote(T.mark_load_failed); }
        }
        async function keep() {
            const m = rwItems[rwAt];
            if (!m || m.kind !== 'auto') return;
            try {
                const res = await fetch(url(`/${encodeURIComponent(m.id)}/keep`), { method: 'POST', credentials: 'same-origin' });
                if (res.status === 409) { gameNote(T.mark_full); return; }
                if (!res.ok) throw new Error(String(res.status));
                m.kind = 'mark';
                // Теперь она — в «Моих»: счётчики групп и лента — заново, выбор — на том же месте
                const at = rwAt;
                if (!presentGroups().includes(rwGroup)) rwGroup = firstGroup();
                renderTabs();
                renderStrip();
                select(Math.min(at, rwItems.length - 1));
                gameNote(T.rewind_kept_note);
            } catch (e) {
                gameNote(T.mark_failed);
            }
        }
        openRewind.turn = 0;
        const toggleRewind = () => (rewind && rewind.style.display !== 'none' ? closeRewind() : openRewind());

        // P — запомнить момент, Backspace — перемотка. F8 и F9 — тоже, но на ноутбуках и клавиатурах Mac это медиаклавиши
        // (пауза, следующий трек): браузер их не получает, а плеер в соседней вкладке — да. Раньше игры (захват); в
        // полях ввода и на экране ввода имени — буквы и стирание, не наши. Нажатые в библиотеке, мимо рамки игры,
        // приходят сообщением rpg:key (GameFrame)
        const KEY_ACTION = { KeyP: 'shot', F8: 'shot', Backspace: 'rewind', F9: 'rewind' };
        const doAction = (action) => { if (action === 'shot') takeShot(); else if (action === 'rewind') toggleRewind(); };
        // Как на Switch: зажали ⌫ (LT геймпада) — плёнка открывается и сама идёт назад, чем дольше держать — тем дальше;
        // отпустили — стоит, Enter — туда. Посреди разговора — по репликам, по одной. Короткое нажатие — как было: открыть
        // и выбрать самому (на последней точке прохождения)
        let holdTimer = 0;
        const holdBack = (on) => {
            clearInterval(holdTimer);
            holdTimer = 0;
            if (!on) return;
            const started = Date.now();
            let talking = false;
            try { talking = $gameMessage.isBusy(); } catch (e) { talking = false; }
            let turned = false;
            holdTimer = setInterval(() => {
                if (!rewind || rewind.style.display === 'none') { holdBack(false); return; }
                if (Date.now() - started < 450 || !rwItems.length) return;
                // Первый шаг — на «Реплики» (на последней из них — та, что на экране) и сразу к предыдущей
                if (!turned && talking && rwGroup !== 'lines' && presentGroups().includes('lines')) setGroup('lines');
                turned = true;
                select(rwAt - 1);
            }, 180);
        };
        window.addEventListener('keydown', (e) => {
            const action = KEY_ACTION[e.code];
            if (!action || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || hidden()) return;
            const t = e.target;
            if ((t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'))
                || (typeof Scene_Name !== 'undefined' && SceneManager._scene instanceof Scene_Name)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            const opening = action === 'rewind' && !(rewind && rewind.style.display !== 'none');
            doAction(action);
            if (opening) holdBack(true);
        }, true);
        window.addEventListener('keyup', (e) => { if (KEY_ACTION[e.code] === 'rewind') holdBack(false); }, true);
        // Ушли из окна с зажатой клавишей — её отпускания не будет
        window.addEventListener('blur', () => holdBack(false));
        document.addEventListener('visibilitychange', () => { if (document.hidden) holdBack(false); });
        window.addEventListener('message', (e) => {
            if (e.source === window.parent && e.data && e.data.type === 'rpg:key' && !hidden()) doAction(e.data.action);
        });

        addMenuItem({ id: '_sys_shot', section: 'game', icon: 'camera', label: T.shot, onClick: () => { closeMenu(); setTimeout(takeShot, 150); } });
        addMenuItem({ id: '_sys_rewind', section: 'game', icon: 'rewind', label: T.rewind, onClick: () => { closeMenu(); openRewind(); } });

        // Первый запуск игры в этом браузере — один раз карточка с нашими клавишами: без неё о них не узнать. Снова —
        // пунктом ⚙ «Клавиши». Буква, которую занимает эта игра, — не наша (onOurKey), её и не показываем.
        // На телефоне клавиш нет — там касание и пункты меню игры
        function keysCard() {
            if (hidden()) return;
            document.getElementById('_keys')?.remove();
            try { localStorage.setItem('rpgfix_keys_seen', '1'); } catch (e) { /* без хранилища — покажем и в следующий раз */ }
            const touch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
            // Ниже верхнего ряда: там справа кнопки меню игры, а по центру на несколько секунд встаёт плашка сохранения —
            // карточка на самом верху закрывала и её, и кнопки
            const card = document.createElement('div');
            card.id = '_keys';
            card.setAttribute('role', 'status');
            card.style.cssText = 'position:fixed;z-index:2147483646;top:calc(max(12px,env(safe-area-inset-top)) + 56px);left:50%;transform:translateX(-50%);width:min(460px,calc(100vw - 24px));'
                + 'padding:12px 14px;border-radius:12px;background:rgba(12,12,14,0.94);border:1px solid rgba(217,180,94,0.45);color:rgba(255,255,255,0.92);'
                + 'font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 12px 32px rgba(0,0,0,0.5);cursor:pointer;transition:opacity .3s';
            const title = document.createElement('b');
            title.style.cssText = 'display:block;color:#e9c97a;margin-bottom:4px';
            title.textContent = T.keys_title;
            card.appendChild(title);
            const lines = touch ? [T.keys_touch]
                : [T.keys_moment, T.keys_rewind, T.keys_skip, ...keyHelp.filter((k) => freeKey(k.keyCode)).map((k) => k.text), T.keys_hide];
            // Геймпад подключён — и его кнопки (setupPadKeys)
            if (navigator.getGamepads && [...navigator.getGamepads()].some(Boolean)) lines.push(T.keys_pad);
            for (const text of lines) {
                const line = document.createElement('div');
                line.textContent = text;
                card.appendChild(line);
            }
            // Любая клавиша или касание прячет карточку; саму клавишу игра получает как обычно
            const hide = () => {
                window.removeEventListener('keydown', hide, true);
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 300);
            };
            card.addEventListener('click', hide);
            window.addEventListener('keydown', hide, true);
            document.body.appendChild(card);
            setTimeout(hide, 14000);
        }
        addMenuItem({ id: '_sys_keys', section: 'nav', icon: 'keys', label: T.keys_help, onClick: () => { closeMenu(); keysCard(); } });
        // Ключ «rpgfix…» — свой у библиотеки (setupGameStorage его не уносит в сейвы игры): один на все игры этого браузера
        let firstRun = false;
        try { firstRun = !localStorage.getItem('rpgfix_keys_seen'); } catch (e) { /* без хранилища — без карточки */ }
        if (firstRun) whenGameShown(() => setTimeout(keysCard, 1500));
        // «Где вышли»: уходя из игры (в библиотеку, «Назад», «Выход» игры) и когда вкладку убрали (другая вкладка,
        // телефон заблокировали, вкладку закрыли — тогда как получится). «Продолжить» в библиотеке предложит её, если она
        // свежее сейвов и моментов: сыгранное после перемотки без сохранения не пропадёт. Сбоку истории, раз в 30 с
        // Только если после последней точки или загрузки играли (жали клавиши, касались) и не посреди события — как
        // обычный сейв: продолжать с середины сцены — не то, что ждут от «Продолжить». Уходя из игры — без паузы в 30 с
        let exitAt = 0;
        function exitPoint(leaving = false) {
            if (hidden() || (!leaving && Date.now() - exitAt < 30e3) || inputAt() <= stateAt) return NONE;
            try { if ($gameMap.isEventRunning()) return NONE; } catch (e) { return NONE; }
            let body = null;
            try { body = capture({ kind: 'auto', why: 'exit', side: true }); } catch (e) { body = null; }
            if (!body) return NONE;
            exitAt = Date.now();
            return post(body).then((r) => (r && r.id) || null, () => null);
        }
        leaveHooks.push(() => exitPoint(true));
        // Закрывают вкладку, а последний ввод был больше чем через 3 минуты после сейва, момента или точки (не «сейчас»: кто
        // бросил игру и ушёл, того не держим) — браузер переспросит: «Где вышли» при
        // закрытии записывается как получится и не посреди события. Уходят нашими кнопками (leaving), под «Скрыть» или у
        // старой MV без времени ввода — не спрашиваем
        window.addEventListener('beforeunload', (e) => {
            const at = inputAt();
            if (leaving || hidden() || at === Infinity || at - Math.max(stateAt, window.__rpgSavedAt || 0) < 3 * 60e3) return;
            e.preventDefault();
            e.returnValue = '';
        });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') exitPoint(); });

        // Чит-меню перед «Открыть все сцены» запоминает момент — откат одним нажатием
        window.__rpgMoments = { remember, roomScan };

        // Открыли игру на моменте (окно игры в библиотеке → ?mark=<id>): сейв момента запрашиваем сразу, загружаем,
        // как только игра встанет на первый экран
        let launch = '';
        try { launch = new URLSearchParams(location.search).get('mark') || ''; } catch (e) { /* без адреса */ }
        if (!launch) return;
        const pending = fetchValue(launch);
        pending.catch(() => {});
        whenGameShown(() => pending.then(applySave).then(() => dropLaunchParam('mark'), () => gameNote(T.mark_load_failed)));
    }

    // Геймпад — как наши клавиши: свободные кнопки (их не заняла раскладка игры, Input.gamepadMapper) — наши. RT (держать) —
    // пропуск, как Ctrl; LT — перемотка, как Backspace; Back/Select — запомнить момент, как P; Start — меню ⚙. Пока открыто
    // меню ⚙ или плёнка перемотки, крестовина и A/B — им, а не игре (кнопки по стандартной раскладке браузера: 0 A, 1 B,
    // 6 LT, 7 RT, 8 Back, 9 Start, 12–15 крестовина). Плёнке и перемотке шлём те же клавиши, что и с клавиатуры
    function setupPadKeys() {
        const freePad = (n) => { try { return !(Input.gamepadMapper && Input.gamepadMapper[n] !== undefined); } catch (e) { return true; } };
        const key = (code, k) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, cancelable: true }));
        // Пропуск — как зажатый Ctrl, но прямо в состоянии кнопок движка: событие клавиши плагины игры бывает отсекают
        // (Leila пропускает ненастоящие нажатия). Держим каждый кадр, пока RT зажат: Input.clear (плёнка, читы) его снял бы
        const ctrl = (on) => { try { Input._currentState.control = on; } catch (e) { /* движок ещё не загружен */ } };
        const panel = () => document.getElementById('_sys_panel');
        const menuOpen = () => !!panel()?.classList.contains('_open');
        const stripOpen = () => { const r = document.getElementById('_rewind'); return !!r && r.style.display !== 'none'; };
        // Игра свой опрос геймпада в это время не делает: иначе крестовина в меню водила бы героя. И пока не отпустят кнопки,
        // нажатые для нас (busy): B, закрывшая меню, иначе в тот же кадр открыла бы меню игры
        const ours = () => menuOpen() || stripOpen();
        let busy = false;
        const guard = () => {
            if (typeof Input === 'undefined' || !Input._updateGamepadState || Input._updateGamepadState.__rpgPad) return;
            const orig = Input._updateGamepadState;
            Input._updateGamepadState = function () { if (!ours() && !busy) return orig.apply(this, arguments); };
            Input._updateGamepadState.__rpgPad = true;
        };
        let at = -1;   // выбранный крестовиной пункт меню; меню перерисовывается (переключатели) — отмечаем каждый кадр
        const items = () => [...(panel()?.querySelectorAll('._sys_item') || [])].filter((el) => el.offsetParent);
        const mark = () => items().forEach((el, i) => el.classList.toggle('_pad', i === at));
        const pick = (dir) => {
            const list = items();
            if (!list.length) return;
            at = at < 0 ? 0 : (at + dir + list.length) % list.length;
            mark();
            list[at].scrollIntoView({ block: 'nearest' });
        };
        const chosen = () => panel()?.querySelector('._sys_item._pad');
        let prev = [];
        let skip = false;
        let frame = 0;
        // Отпустить пропуск: RT отпустили, геймпад отключили, окно потеряло фокус (там движок сам сбрасывает клавиши)
        const unskip = () => { if (skip) { skip = false; ctrl(false); } };
        window.addEventListener('blur', () => { skip = false; });
        // Нестандартная раскладка (у части геймпадов в Firefox и Linux) — номера кнопок другие: наших кнопок там нет
        const loop = () => {
            const pad = navigator.getGamepads ? [...navigator.getGamepads()].find((p) => p && p.mapping === 'standard') : null;
            if (!pad) { prev = []; frame = 0; busy = false; unskip(); return; }
            guard();
            const down = pad.buttons.map((b) => b.pressed);
            const was = prev;
            const hit = (n) => down[n] && !was[n];
            prev = down;
            // Игра перестаёт видеть геймпад — то, что было зажато (стик), отпускаем, иначе герой шёл бы под меню
            if (ours() && !busy && typeof Input !== 'undefined' && Input.clear) Input.clear();
            if (ours()) busy = true;
            else if (!down.some(Boolean)) busy = false;
            frame = requestAnimationFrame(loop);
            // Под «Скрыть» — ничего нашего; меню, если было открыто, закрываем
            if (window.__rpgPanic && window.__rpgPanic.isOn()) { if (menuOpen()) closeMenu(); unskip(); return; }
            if (menuOpen()) {
                if (hit(12)) pick(-1);
                else if (hit(13)) pick(1);
                else if (hit(0) && chosen()) chosen()._activate();
                else if (hit(1) || hit(9)) closeMenu();
                mark();
            } else if (stripOpen()) {
                const keys = { 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight', 0: 'Enter', 1: 'Escape' };
                for (const [n, k] of Object.entries(keys)) if (hit(Number(n))) key(k, k);
                if (hit(6) && freePad(6)) key('Backspace', 'Backspace');
            } else {
                if (hit(8) && freePad(8)) { busy = true; key('KeyP', 'p'); }
                // LT держат — плёнка идёт назад (setupSceneMarks, holdBack); отпустили — стоит
                if (hit(6) && freePad(6)) key('Backspace', 'Backspace');
                // Под «Картинкой без текста» (V) меню спрятано — сначала вернуть всё как было
                if (hit(9) && freePad(9)) { at = -1; busy = true; setClean(false); openMenu(); pick(1); }
            }
            if (was[6] && !down[6] && freePad(6)) window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backspace', key: 'Backspace' }));
            const want = !!down[7] && freePad(7) && !ours();
            if (want) ctrl(true);
            if (want !== skip) {
                skip = want;
                ctrl(want);
                // Отпустили RT — включённый кнопкой «Пропуск» остаётся включённым
                if (!want && window.__rpgRelatch) window.__rpgRelatch();
            }
        };
        const start = () => { if (!frame) frame = requestAnimationFrame(loop); };
        window.addEventListener('gamepadconnected', start);
        if (navigator.getGamepads && [...navigator.getGamepads()].some(Boolean)) start();
    }

    // Наши клавиши в игре (A, V, T, M): буква — наша, только если раскладка игры её не заняла (плагин мог повесить на неё
    // своё — тогда она его). Узнаём по keyCode, как и сама игра: на AZERTY и в русской раскладке буква та же, что для игры.
    // Не в полях ввода и не на экране ввода имени, без Ctrl/Alt/⌘/Shift, не под «Скрыть»
    const freeKey = (keyCode) => { try { return !(Input.keyMapper && Input.keyMapper[keyCode] !== undefined); } catch (e) { return true; } };
    const keyHelp = [];   // карточка «Клавиши»: { keyCode, text } — показываются только свободные в этой игре
    function onOurKey(keyCode, fn) {
        window.addEventListener('keydown', (e) => {
            if (e.keyCode !== keyCode || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !freeKey(keyCode)) return;
            if (window.__rpgPanic && window.__rpgPanic.isOn()) return;
            const t = e.target;
            if ((t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'))
                || (typeof SceneManager !== 'undefined' && typeof Scene_Name !== 'undefined' && SceneManager._scene instanceof Scene_Name)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!e.repeat) fn();
        }, true);
    }
    // На экране реплика, которая ждёт «дальше», — не выбор, не ввод числа и не выбор предмета
    const talking = () => {
        try {
            return !!($gameMessage.isBusy() && !$gameMessage.isChoice() && !$gameMessage.isNumberInput() && !$gameMessage.isItemChoice()
                && SceneManager._scene && SceneManager._scene._messageWindow);
        } catch (e) { return false; }
    };

    // ============================================================================
    // КАРТИНКА БЕЗ ТЕКСТА: V или пункт ⚙ — окна игры (реплика, имя, меню) и наши кнопки спрятаны, видна сама сцена.
    // Любая клавиша или касание — всё как было; само нажатие игре не уходит, чтобы не перелистнуть реплику.
    // P (момент) и H (скрыть) работают и так: момент — чистым кадром
    // ============================================================================
    let cleanView = false;
    let setClean = () => {};
    function setupCleanView() {
        const style = document.createElement('style');
        // Скрыто и то, что наши окна показывают своим style (кнопки гаснут и загораются сами)
        style.textContent = 'html._rpg_clean #_sys_menu_container, html._rpg_clean #_mob_ctrl, html._rpg_clean #_game_note, html._rpg_clean #_keys { display: none !important; }';
        const layers = new Map();   // слой окон → видим ли он был у игры
        const hideLayer = () => {
            const layer = typeof SceneManager !== 'undefined' && SceneManager._scene && SceneManager._scene._windowLayer;
            if (!layer) return;
            if (!layers.has(layer)) layers.set(layer, layer.visible);
            layer.visible = false;
        };
        let timer = null;
        let hint = null;
        setClean = (on) => {
            if (on === cleanView) return;
            cleanView = on;
            document.documentElement.classList.toggle('_rpg_clean', on);
            if (on) {
                if (!style.parentNode) (document.head || document.documentElement).appendChild(style);
                hideLayer();
                // Сцена сменилась сама (событие по времени) — у новой тоже без окон
                timer = setInterval(hideLayer, 200);
                hint = document.createElement('div');
                hint.style.cssText = 'position:fixed; left:50%; bottom:max(18px, env(safe-area-inset-bottom)); transform:translateX(-50%); color:rgba(255,255,255,0.45); font:500 12px system-ui, sans-serif; white-space:nowrap; pointer-events:none; z-index:2147483646; transition:opacity .6s;';
                hint.textContent = T.clean_back;
                document.body.appendChild(hint);
                const h = hint;
                setTimeout(() => { h.style.opacity = '0'; }, 2200);
                setTimeout(() => h.remove(), 3000);
            } else {
                clearInterval(timer);
                for (const [layer, was] of layers) layer.visible = was;
                layers.clear();
                if (hint) { hint.remove(); hint = null; }
            }
        };
        // Пока картинка без текста — касания и щелчки не игре; отпустили палец или кнопку мыши — текст вернулся. Хвост
        // того же нажатия (mouseup, click, у касаний — запоздалые события мыши) тоже не игре: плагины ловят и click
        let tailUntil = 0;
        const swallow = (e) => {
            if (!cleanView && performance.now() > tailUntil) return;
            if (e.cancelable && e.type !== 'pointerup') e.preventDefault();
            e.stopImmediatePropagation();
            if (e.type === 'pointerup' && cleanView) { setClean(false); tailUntil = performance.now() + 400; }
        };
        for (const type of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove', 'touchend', 'click', 'wheel', 'contextmenu']) {
            window.addEventListener(type, swallow, { capture: true, passive: false });
        }
        window.addEventListener('keydown', (e) => {
            if (!cleanView || e.code === 'KeyP' || e.code === 'KeyH' || e.ctrlKey || e.metaKey || /^F\d+$/.test(e.key)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!e.repeat) setClean(false);
        }, true);
        onOurKey(86, () => setClean(true));
        keyHelp.push({ keyCode: 86, text: T.keys_clean });
        queueMicrotask(() => addMenuItem({ id: '_sys_clean', section: 'game', icon: 'clean', label: T.clean, onClick: () => { closeMenu(); setClean(true); } }));
    }

    // Телефон: касание экрана — «дальше» по тексту, как в визуальных новеллах. Касания по игре на телефоне идут джойстику,
    // остальные глотает setupTouchModeToggle, и реплику листали только кнопкой Z. Пока на экране реплика без выбора, короткое
    // касание где угодно, кроме наших кнопок, — нажатие «ОК». Включены «Касания по игре» — их и так получает сама игра
    function setupTapToRead() {
        if (!TOUCH_FIRST) return;
        // «ОК» держим до первого обновления ввода в игре: по времени (80 мс) под нагрузкой кадр бывал длиннее, и игра
        // нажатия не видела
        let okHeld = false;
        const pressOk = () => {
            if (typeof Input === 'undefined' || !Input._currentState || typeof Input.update !== 'function') return;
            if (!Input.update.__rpgOk) {
                const orig = Input.update;
                Input.update = function() {
                    const r = orig.apply(this, arguments);
                    if (okHeld) { okHeld = false; this._currentState.ok = false; }
                    return r;
                };
                Input.update.__rpgOk = true;
            }
            Input._currentState.ok = true;
            okHeld = true;
        };
        let down = null;
        window.addEventListener('pointerdown', (e) => {
            down = null;
            if (window.__rpgTouchEnabled || !e.isPrimary || !talking() || document.getElementById('_sys_panel')?.classList.contains('_open')) return;
            const t = e.target;
            if (t && t.closest && ((t.closest(OUR_UI) && !t.closest('#_stick_zone, #_stick')) || t.closest('#_rewind, #_keys') || isGameControl(t))) return;
            down = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
        }, { capture: true, passive: true });
        window.addEventListener('pointerup', (e) => {
            const d = down;
            down = null;
            if (!d || e.pointerId !== d.id || performance.now() - d.at > 400 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 14 || !talking()) return;
            pressOk();
        }, { capture: true, passive: true });
    }

    // Без звука: M или пункт ⚙ — тихо сразу, не заходя в настройки игры (во многих H-играх их нет). Ещё раз — как было.
    // Общая громкость движка и ролики; громкость в настройках самой игры не меняется
    function setupMute() {
        let muted = false;
        let before = 1;
        const set = (on) => {
            muted = on;
            try {
                if (typeof WebAudio !== 'undefined') {
                    if (on) before = typeof WebAudio._masterVolume === 'number' ? WebAudio._masterVolume : 1;
                    if (typeof WebAudio.setMasterVolume === 'function') WebAudio.setMasterVolume(on ? 0 : before);
                    // MV до 1.6: общей громкости ещё нет, есть её узел
                    else if (WebAudio._masterGainNode) WebAudio._masterGainNode.gain.value = on ? 0 : 1;
                }
            } catch (e) { /* без звука движка */ }
            document.querySelectorAll('video, audio').forEach((m) => { m.muted = on; });
            gameNote(on ? T.mute_on : T.mute_off);
        };
        onOurKey(77, () => set(!muted));
        keyHelp.push({ keyCode: 77, text: T.keys_mute });
        queueMicrotask(() => addMenuItem({ id: '_sys_mute', section: 'game', icon: 'mute', label: T.mute, isOn: () => muted, onClick: () => set(!muted) }));
    }

    // Турбо ×3 (T или пункт ⚙): игра считает три кадра за один — только на карте и в бою: в меню и на титуле курсор
    // от этого бегал втрое быстрее. Выбор — на эту игру: раньше турбо сбрасывалось при каждом запуске
    function setTurbo(on) {
        window.__rpgTurbo = on;
        gameSettings.set('turbo', on);
        if (!on || window.__turboHookInjected) return;
        window.__turboHookInjected = true;
        const turboHook = setInterval(() => {
            if (typeof SceneManager === 'undefined' || !SceneManager.updateMain || SceneManager.__turboPatched) return;
            SceneManager.__turboPatched = true;
            const origUpdate = SceneManager.updateMain;
            SceneManager.updateMain = function() {
                origUpdate.call(this);
                const s = this._scene;
                if (!window.__rpgTurbo || !((typeof Scene_Map !== 'undefined' && s instanceof Scene_Map) || (typeof Scene_Battle !== 'undefined' && s instanceof Scene_Battle))) return;
                for (let i = 0; i < 2; i++) {
                    if (this.updateInputData) this.updateInputData();
                    if (this.updateManagers) this.updateManagers();
                    if (this.updateScene) this.updateScene();
                }
            };
            clearInterval(turboHook);
        }, 500);
    }
    function setupTurbo() {
        if (gameSettings.get('turbo')) setTurbo(true);
        onOurKey(84, () => { setTurbo(!window.__rpgTurbo); gameNote(window.__rpgTurbo ? T.turbo_on : T.turbo_off); });
        keyHelp.push({ keyCode: 84, text: T.keys_turbo });
    }

    // Игра стоит, пока её закрывает наш экран (H, плёнка перемотки): кадр не обновляется — сцена, бой, события и таймеры
    // игры вместе с ним, и нажатия, в том числе с геймпада, до неё не доходят. Раньше под плёнкой игра шла: после проигрыша
    // кнопка A геймпада уводила «Игру окончена» на титул. Кто держит — по имени: открыли плёнку и нажали H — снятие
    // скрытия игру не пускает, пока открыта плёнка
    const holds = new Set();
    function holdGame(who, on) {
        if (on) holds.add(who); else holds.delete(who);
        if (typeof SceneManager === 'undefined' || typeof SceneManager.updateScene !== 'function' || SceneManager.updateScene.__rpgHold) return;
        const orig = SceneManager.updateScene;
        SceneManager.updateScene = function() { return holds.size ? undefined : orig.apply(this, arguments); };
        SceneManager.updateScene.__rpgHold = true;
    }

    // ============================================================================
    // «СКРЫТЬ»: H в игре (как H в библиотеке) — экран закрыт тёмным, звук и сама игра на паузе, вкладка браузера
    // подписана нейтрально (это делает библиотека: rpg:quiet). Ещё раз H или касание — всё как было
    // ============================================================================
    function setupPanic() {
        let on = false;
        let saved = null;
        const cover = document.createElement('div');
        cover.id = '_panic';
        cover.style.cssText = 'display:none; position:fixed; inset:0; z-index:2147483647; background:#0d0d10; cursor:pointer; touch-action:none;';
        const hint = document.createElement('div');
        hint.style.cssText = 'position:absolute; left:50%; bottom:24px; transform:translateX(-50%); color:rgba(255,255,255,0.25); font:500 12px system-ui, sans-serif; white-space:nowrap;';
        hint.textContent = T.hide_back;
        cover.appendChild(hint);
        function set(next) {
            if (next === on) return;
            on = next;
            const ctx = typeof WebAudio !== 'undefined' && WebAudio._context;
            holdGame('panic', on);
            if (on) {
                // Иначе первое касание тёмного экрана снимало бы картинку без текста, а не его
                setClean(false);
                saved = { audio: !!(ctx && ctx.state === 'running'), media: [...document.querySelectorAll('video, audio')].filter((m) => !m.paused) };
                if (saved.audio) ctx.suspend().catch(() => {});
                saved.media.forEach((m) => { try { m.pause(); } catch (e) { /* ролик уже ушёл */ } });
                // Последним в странице: поверх всех наших окон, открытых раньше
                document.body.appendChild(cover);
                cover.style.display = 'block';
            } else {
                cover.style.display = 'none';
                // Клавиша, зажатая в миг скрытия, отпущена, пока игра не слышала, — иначе герой шёл бы сам
                try { if (typeof Input !== 'undefined' && Input.clear) Input.clear(); if (typeof TouchInput !== 'undefined' && TouchInput.clear) TouchInput.clear(); } catch (e) { /* без сброса */ }
                if (window.__rpgRelatch) window.__rpgRelatch();
                if (saved && saved.audio && ctx) ctx.resume().catch(() => {});
                ((saved && saved.media) || []).forEach((m) => { try { const p = m.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ролик уже ушёл */ } });
                saved = null;
            }
            if (FRAMED) try { window.parent.postMessage({ type: 'rpg:quiet', on }, '*'); } catch (e) { /* без рамки */ }
        }
        // Раньше игры и её плагинов (захват): H — наша, кроме полей ввода и экрана ввода имени (там это буква).
        // Пока скрыто, клавиши до игры не доходят — кроме браузерных (F5, F11, Tab, сочетания с Ctrl)
        const onKey = (e) => {
            const t = e.target;
            const typing = (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'))
                || (typeof SceneManager !== 'undefined' && typeof Scene_Name !== 'undefined' && SceneManager._scene instanceof Scene_Name);
            if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !e.altKey && (!typing || on)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.type === 'keydown' && !e.repeat) set(!on);
                return;
            }
            if (on && !e.ctrlKey && !e.metaKey && e.key !== 'Tab' && !/^F\d+$/.test(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); }
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', onKey, true);
        for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel', 'contextmenu']) {
            cover.addEventListener(type, (e) => { e.stopPropagation(); if (type !== 'wheel') e.preventDefault(); }, { passive: false });
        }
        cover.addEventListener('pointerup', (e) => { e.stopPropagation(); set(false); });
        // H, нажатая в библиотеке, пока игра открыта (фокус не в рамке), приходит сюда сообщением
        window.addEventListener('message', (e) => {
            if (e.source === window.parent && e.data && e.data.type === 'rpg:quiet-toggle') set(!on);
        });
        addMenuItem({ id: '_sys_hide', section: 'nav', icon: 'hide', label: T.hide, onClick: () => set(true) });
        window.__rpgPanic = { set, isOn: () => on };
        // Библиотека просит прятать игру, когда её сворачивают (Настройки → «Прятать, когда сворачиваю»: в адресе hide=1):
        // в списке приложений телефона и вернувшись — тёмный экран, а не сцена
        let onLeave = false;
        try { onLeave = new URLSearchParams(location.search).get('hide') === '1'; } catch (e) { /* без адреса */ }
        if (onLeave) document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') set(true); });
    }

    // ============================================================================
    // 7. ЧИСТОЕ АУДИО + AUTO-FALLBACK + ЗАЩИТА ОТ АВТО-МУТА ПРИ СНЕ
    // ============================================================================
    // Для проверки, умеет ли браузер Ogg (см. ниже): 100 мс тишины, Vorbis 8 кГц моно.
    // Короче нельзя: из одного пакета Vorbis звука не получается, и Chromium отвечает
    // «не могу декодировать», хотя Ogg умеет
    const OGG_PROBE = 'T2dnUwACAAAAAAAAAAAAAAAAAAAAAOEUWLYBHgF2b3JiaXMAAAAAAUAfAAAAAAAAgFcAAAAAAACZAU9nZ1MAAAAAAAAAAAAAAAAAAAEAAADSMjkZCzD///////////+1A3ZvcmJpcwYAAABmZm1wZWcBAAAAFgAAAGVuY29kZXI9TGF2YyBsaWJ2b3JiaXMBBXZvcmJpcxJCQ1YBAAABAAxSFCElGVNKYwiVUlIpBR1jUFtHHWPUOUYhZBBTiEkZpXtPKpVYSsgRUlgpRR1TTFNJlVKWKUUdYxRTSCFT1jFloXMUS4ZJCSVsTa50FkvomWOWMUYdY85aSp1j1jFFHWNSUkmhcxg6ZiVkFDpGxehifDA6laJCKL7H3lLpLYWKW4q91xpT6y2EGEtpwQhhc+211dxKasUYY4wxxsXiUyiC0JBVAAABAABABAFCQ1YBAAoAAMJQDEVRgNCQVQBABgCAABRFcRTHcRxHkiTLAkJDVgEAQAAAAgAAKI7hKJIjSZJkWZZlWZameZaouaov+64u667t6roOhIasBADIAAAYhiGH3knMkFOQSSYpVcw5CKH1DjnlFGTSUsaYYoxRzpBTDDEFMYbQKYUQ1E45pQwiCENInWTOIEs96OBi5zgQGrIiAIgCAACMQYwhxpBzDEoGIXKOScggRM45KZ2UTEoorbSWSQktldYi55yUTkompbQWUsuklNZCKwUAAAQ4AAAEWAiFhqwIAKIAABCDkFJIKcSUYk4xh5RSjinHkFLMOcWYcowx6CBUzDHIHIRIKcUYc0455iBkDCrmHIQMMgEAAAEOAAABFkKhISsCgDgBAIMkaZqlaaJoaZooeqaoqqIoqqrleabpmaaqeqKpqqaquq6pqq5seZ5peqaoqp4pqqqpqq5rqqrriqpqy6ar2rbpqrbsyrJuu7Ks256qyrapurJuqq5tu7Js664s27rkearqmabreqbpuqrr2rLqurLtmabriqor26bryrLryratyrKua6bpuqKr2q6purLtyq5tu7Ks+6br6rbqyrquyrLu27au+7KtC7vourauyq6uq7Ks67It67Zs20LJ81TVM03X9UzTdVXXtW3VdW1bM03XNV1XlkXVdWXVlXVddWVb90zTdU1XlWXTVWVZlWXddmVXl0XXtW1Vln1ddWVfl23d92VZ133TdXVblWXbV2VZ92Vd94VZt33dU1VbN11X103X1X1b131htm3fF11X11XZ1oVVlnXf1n1lmHWdMLqurqu27OuqLOu+ruvGMOu6MKy6bfyurQvDq+vGseu+rty+j2rbvvDqtjG8um4cu7Abv+37xrGpqm2brqvrpivrumzrvm/runGMrqvrqiz7uurKvm/ruvDrvi8Mo+vquirLurDasq/Lui4Mu64bw2rbwu7aunDMsi4Mt+8rx68LQ9W2heHVdaOr28ZvC8PSN3a+AACAAQcAgAATykChISsCgDgBAAYhCBVjECrGIIQQUgohpFQxBiFjDkrGHJQQSkkhlNIqxiBkjknIHJMQSmiplNBKKKWlUEpLoZTWUmotptRaDKG0FEpprZTSWmopttRSbBVjEDLnpGSOSSiltFZKaSlzTErGoKQOQiqlpNJKSa1lzknJoKPSOUippNJSSam1UEproZTWSkqxpdJKba3FGkppLaTSWkmptdRSba21WiPGIGSMQcmck1JKSamU0lrmnJQOOiqZg5JKKamVklKsmJPSQSglg4xKSaW1kkoroZTWSkqxhVJaa63VmFJLNZSSWkmpxVBKa621GlMrNYVQUgultBZKaa21VmtqLbZQQmuhpBZLKjG1FmNtrcUYSmmtpBJbKanFFluNrbVYU0s1lpJibK3V2EotOdZaa0ot1tJSjK21mFtMucVYaw0ltBZKaa2U0lpKrcXWWq2hlNZKKrGVklpsrdXYWow1lNJiKSm1kEpsrbVYW2w1ppZibLHVWFKLMcZYc0u11ZRai621WEsrNcYYa2415VIAAMCAAwBAgAlloNCQlQBAFAAAYAxjjEFoFHLMOSmNUs45JyVzDkIIKWXOQQghpc45CKW01DkHoZSUQikppRRbKCWl1losAACgwAEAIMAGTYnFAQoNWQkARAEAIMYoxRiExiClGIPQGKMUYxAqpRhzDkKlFGPOQcgYc85BKRljzkEnJYQQQimlhBBCKKWUAgAAChwAAAJs0JRYHKDQkBUBQBQAAGAMYgwxhiB0UjopEYRMSielkRJaCylllkqKJcbMWomtxNhICa2F1jJrJcbSYkatxFhiKgAA7MABAOzAQig0ZCUAkAcAQBijFGPOOWcQYsw5CCE0CDHmHIQQKsaccw5CCBVjzjkHIYTOOecghBBC55xzEEIIoYMQQgillNJBCCGEUkrpIIQQQimldBBCCKGUUgoAACpwAAAIsFFkc4KRoEJDVgIAeQAAgDFKOSclpUYpxiCkFFujFGMQUmqtYgxCSq3FWDEGIaXWYuwgpNRajLV2EFJqLcZaQ0qtxVhrziGl1mKsNdfUWoy15tx7ai3GWnPOuQAA3AUHALADG0U2JxgJKjRkJQCQBwBAIKQUY4w5h5RijDHnnENKMcaYc84pxhhzzjnnFGOMOeecc4wx55xzzjnGmHPOOeecc84556CDkDnnnHPQQeicc845CCF0zjnnHIQQCgAAKnAAAAiwUWRzgpGgQkNWAgDhAACAMZRSSimllFJKqKOUUkoppZRSAiGllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimVUkoppZRSSimllFJKKaUAIN8KBwD/BxtnWEk6KxwNLjRkJQAQDgAAGMMYhIw5JyWlhjEIpXROSkklNYxBKKVzElJKKYPQWmqlpNJSShmElGILIZWUWgqltFZrKam1lFIoKcUaS0qppdYy5ySkklpLrbaYOQelpNZaaq3FEEJKsbXWUmuxdVJSSa211lptLaSUWmstxtZibCWlllprqcXWWkyptRZbSy3G1mJLrcXYYosxxhoLAOBucACASLBxhpWks8LR4EJDVgIAIQEABDJKOeecgxBCCCFSijHnoIMQQgghREox5pyDEEIIIYSMMecghBBCCKGUkDHmHIQQQgghhFI65yCEUEoJpZRSSucchBBCCKWUUkoJIYQQQiillFJKKSGEEEoppZRSSiklhBBCKKWUUkoppYQQQiillFJKKaWUEEIopZRSSimllBJCCKGUUkoppZRSQgillFJKKaWUUkooIYRSSimllFJKCSWUUkoppZRSSikhlFJKKaWUUkoppQAAgAMHAIAAI+gko8oibDThwgMQAAAAAgACTACBAYKCUQgChBEIAAAAAAAIAPgAAEgKgIiIaOYMDhASFBYYGhweICIkAAAAAAAAAAAAAAAABE9nZ1MABCADAAAAAAAAAAAAAAIAAAB1uGc9BQEBAQEBAAAAAAA=';

    function setupSecureAudio() {
        if (typeof AudioManager !== 'undefined' && !AudioManager.__SafeCheckPatched) {
            AudioManager.__SafeCheckPatched = true; 
            const orig = AudioManager.checkErrors; 
            AudioManager.checkErrors = function () { try { if (orig) orig.apply(this, arguments); } catch (e) {} };
        }

        // Блок decTimer отсюда удален, чтобы не ломать картинки!

        // --- Формат звука: Ogg или m4a ---
        // Звук в играх — Ogg. Safari научился его играть только в iOS 18.4, и «умею» от
        // тега <audio> ещё не значит, что умеет Web Audio, через который звучат игры.
        // Поэтому проверяем по-настоящему: декодируем крошечный Ogg (2,6 КБ тишины).
        // Это миллисекунды — проверка заканчивается раньше, чем игра попросит первый звук.
        // Умеет — игра получает свой Ogg как есть. Не умеет (iPhone до iOS 18.4, старые Mac):
        // MV просит .m4a (сервер отдаст готовый или перекодирует), а MZ разбирает Ogg
        // своим встроенным декодером. Раньше формат угадывал сервер по User-Agent: iPhone
        // всегда получал перекодированный m4a — каждая мелодия в первый раз ждала FFmpeg,
        // а MZ на старых iOS получал m4a вместо Ogg для своего декодера и молчал
        const oggAudio = { ok: false };
        try { oggAudio.ok = !!document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"'); } catch (_) {}
        if (oggAudio.ok) {
            try {
                const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
                const bytes = Uint8Array.from(atob(OGG_PROBE), (c) => c.charCodeAt(0));
                const fail = () => { oggAudio.ok = false; };
                const p = new OAC(1, 1, 22050).decodeAudioData(bytes.buffer, () => {}, fail);
                if (p && p.catch) p.catch(fail);
            } catch (_) { oggAudio.ok = false; }
        }
        window.__rpgOggAudio = oggAudio;

        const formatTimer = setInterval(() => {
            if (typeof WebAudio !== 'undefined' && typeof AudioManager !== 'undefined') {
                if (typeof Utils !== 'undefined' && Utils.RPGMAKER_NAME === 'MZ') {
                    // MZ всегда просит .ogg и сам решает, декодировать ли его своим декодером
                    Utils.canPlayOgg = () => oggAudio.ok;
                } else {
                    // MV на телефонах по умолчанию просит .m4a, а в сборках для Windows
                    // его обычно нет — поэтому Ogg всегда, когда браузер его умеет
                    WebAudio.canPlayOgg = () => oggAudio.ok;
                    AudioManager.audioFileExt = () => (oggAudio.ok ? '.ogg' : '.m4a');
                }
                clearInterval(formatTimer);
            }
        }, 50);

        // 🔥 ОТКЛЮЧАЕМ ВСТРОЕННЫЙ АВТО-МУТ ДВИЖКА ПРИ СВОРАЧИВАНИИ
        // Игра больше не будет пытаться плавно затушить звук (из-за чего он ломался после сна)
        const blurTimer = setInterval(() => {
            if (typeof WebAudio !== 'undefined') {
                if (WebAudio._onHide) WebAudio._onHide = function() {}; 
                if (WebAudio._onShow) WebAudio._onShow = function() {}; 
                if (WebAudio._shouldMuteOnHide) WebAudio._shouldMuteOnHide = function() { return false; }; 
                if (typeof AudioManager !== 'undefined' && AudioManager.shouldMuteOnFocus) {
                    AudioManager.shouldMuteOnFocus = function() { return false; };
                }
                clearInterval(blurTimer);
            }
        }, 50);

        // Свернули игру — звук на паузу, вернулись — дальше. Сам движок плавно глушил звук при
        // сворачивании, но после сна телефона звук из-за этого ломался, и приглушение выключено
        // (выше) — свёрнутая игра так и играла. Пауза самого звука — без затуханий; если после сна
        // он не проснётся сам, разбудит касание (forceAudioWakeUp). На компьютере — тоже: раньше
        // голоса из свёрнутой вкладки звучали на всю комнату
        {
            let pausedByUs = false;
            document.addEventListener('visibilitychange', () => {
                const ctx = typeof WebAudio !== 'undefined' && WebAudio._context;
                if (!ctx) return;
                if (document.hidden) {
                    if (ctx.state === 'running') { pausedByUs = true; ctx.suspend().catch(() => {}); }
                } else if (pausedByUs) {
                    pausedByUs = false;
                    // Под «Скрыть» (H или само при сворачивании) звук вернёт само «Скрыть», когда его снимут
                    if (!(window.__rpgPanic && window.__rpgPanic.isOn())) ctx.resume().catch(() => {});
                }
            });
        }

        // 4) УМНЫЙ АВТО-FALLBACK (С ожиданием пробуждения)
        const fallbackTimer = setInterval(() => {
            if (typeof WebAudio !== 'undefined') {
                clearInterval(fallbackTimer);
                
                if (window.fetch && !window.__fetchAudioPatched) {
                    window.__fetchAudioPatched = true;
                    const origFetch = window.fetch;
                    window.fetch = async function(...args) {
                        let res;
                        try {
                            res = await origFetch(...args);
                        } catch (e) {
                            if (e.name === 'AbortError' || (e.message && e.message.toLowerCase().includes('aborted'))) {
                                await new Promise(resolve => {
                                    const handler = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', handler); resolve(); } };
                                    if (document.hidden) document.addEventListener('visibilitychange', handler); else resolve();
                                });
                                return window.fetch(...args);
                            }
                            throw e;
                        }
                        
                        if (!res.ok && typeof args[0] === 'string' && args[0].match(/\.(ogg|rpgmvo)$/i)) {
                            const fbUrl = args[0].replace(/\.ogg$/i, '.m4a').replace(/\.rpgmvo$/i, '.rpgmvm');
                            try { const fbRes = await origFetch(fbUrl, args[1]); if (fbRes.ok) return fbRes; } catch(e) {}
                        }
                        return res;
                    };
                }

                if (WebAudio.prototype._load && !WebAudio.prototype.__loadPatched) {
                    WebAudio.prototype.__loadPatched = true;
                    WebAudio.prototype._load = function(url) {
                        const self = this;
                        const encrypted = typeof Decrypter !== 'undefined' && Decrypter.hasEncryptedAudio;
                        // Шифрованный звук для браузера без Ogg просим обычным .m4a: сервер
                        // сам расшифрует и перекодирует. Раньше просили .rpgmvm, которого
                        // в сборках для Windows нет, — и на старых iPhone было тихо
                        const plainM4a = encrypted && !oggAudio.ok && /\.m4a$/i.test(url);
                        const finalUrl = encrypted && !plainM4a ? Decrypter.extToEncryptExt(url) : url;
                        const onLoad = (x) => {
                            if (!plainM4a) return self._onXhrLoad(x);
                            // Ответ уже расшифрован. _onXhrLoad смотрит на флаг сразу, ещё до
                            // декодирования, — на это время его и снимаем
                            Decrypter.hasEncryptedAudio = false;
                            try { self._onXhrLoad(x); } finally { Decrypter.hasEncryptedAudio = true; }
                        };
                        const get = (u, ok, bad) => {
                            const xhr = new XMLHttpRequest();
                            xhr.open('GET', u);
                            xhr.responseType = 'arraybuffer';
                            xhr.onload = () => (xhr.status < 400 ? ok(xhr) : bad(xhr.status));
                            xhr.onerror = () => bad(0);
                            xhr.send();
                        };
                        // Не загрузился — ещё раз (audioFailed). Раньше MV здесь сам пробовал
                        // снова, а эта замена его загрузки — нет, и мелодия молчала
                        const failed = (status) => audioFailed(self, () => self._load(url), status >= 400 && status < 500);
                        get(finalUrl, onLoad, (status) => {
                            // Нет .ogg — может, есть .m4a
                            if (status >= 400 && status < 500 && /\.(ogg|rpgmvo)$/i.test(finalUrl)) {
                                get(finalUrl.replace(/\.ogg$/i, '.m4a').replace(/\.rpgmvo$/i, '.rpgmvm'), (x) => self._onXhrLoad(x), failed);
                            } else failed(status);
                        });
                    };
                }

                // MZ грузит звук сам, нам — только узнать, что не вышло, и ответ сервера
                if (!WebAudio.prototype._load && WebAudio.prototype._onError && WebAudio.prototype.retry && !WebAudio.prototype.__retryPatched) {
                    WebAudio.prototype.__retryPatched = true;
                    const onFetch = WebAudio.prototype._onFetch;
                    if (onFetch) WebAudio.prototype._onFetch = function(response) {
                        this.__rpgStatus = response ? response.status : 0;
                        return onFetch.apply(this, arguments);
                    };
                    const onError = WebAudio.prototype._onError;
                    WebAudio.prototype._onError = function() {
                        onError.apply(this, arguments);
                        const status = this.__rpgStatus || 0;
                        this.__rpgStatus = 0;
                        audioFailed(this, () => {
                            // Недокачанное в прошлый раз с новым не склеиваем
                            try { this._removeNodes(); } catch (_) {}
                            this._data = null; this._fetchedSize = 0; this._fetchedData = []; this._buffers = []; this._totalTime = 0;
                            this.retry();
                        }, status >= 400 && status < 500);
                    };
                }
            }
        }, 50);

        // Звук не загрузился (сбой сети, телефон уснул посреди загрузки) — пробуем ещё через
        // 1, 3, 10 и 30 секунд, а дальше — как только вернутся сеть или экран. Раньше мелодия
        // молчала до следующей, а незагруженные фанфары не давали включиться и новой музыке:
        // движок ждёт их конца. Повторяем только музыку, фоновый звук и системные звуки: удар
        // или шаг, скачанные поздно, прозвучали бы невпопад. Фанфарам — одна попытка, дальше
        // без них: пусть вернётся музыка
        const AUDIO_RETRY_MS = [1000, 3000, 10000, 30000];
        const audioWaiting = new Map();   // звук → как загрузить его снова
        const audioRole = (b) => {
            if (typeof AudioManager === 'undefined' || !b) return null;
            const A = AudioManager;
            if (b === A._bgmBuffer || b === A._bgsBuffer) return 'music';
            if (b === A._meBuffer) return 'me';
            return (A._staticBuffers || []).includes(b) ? 'system' : null;
        };
        const reloadAudio = (b, reload) => {
            // Системный звук — только загрузить: нажатие, которое его ждало, давно прошло
            if (audioRole(b) === 'system') { try { b.stop(); } catch (_) {} }
            reload();
        };
        // missing — файла на сервере нет, повторять незачем
        function audioFailed(b, reload, missing) {
            const role = audioRole(b);
            if (!role || b.__rpgRetryAt) return;
            const tries = b.__rpgTries || 0;
            const delays = role === 'me' ? AUDIO_RETRY_MS.slice(0, 1) : AUDIO_RETRY_MS;
            if (missing || tries >= delays.length) {
                if (role === 'me') AudioManager.stopMe();
                else if (!missing) audioWaiting.set(b, reload);
                return;
            }
            b.__rpgTries = tries + 1;
            b.__rpgRetryAt = setTimeout(() => {
                b.__rpgRetryAt = 0;
                const now = audioRole(b);
                if (!now) return;
                if (!document.hidden) reloadAudio(b, reload);
                else if (now === 'me') AudioManager.stopMe();
                else audioWaiting.set(b, reload);   // экран погас — дождёмся его
            }, delays[tries]);
        }
        const retryWaiting = () => {
            if (document.hidden || !navigator.onLine) return;
            for (const [b, reload] of audioWaiting) {
                audioWaiting.delete(b);
                if (audioRole(b)) { b.__rpgTries = 0; reloadAudio(b, reload); }
            }
        };
        window.addEventListener('online', retryWaiting);
        document.addEventListener('visibilitychange', retryWaiting);

        // 5) ЗВУК ВКЛЮЧАЕТСЯ С ПЕРВОГО КАСАНИЯ
        // Браузер не пускает звук, пока человек не коснулся страницы, а iPhone засчитывает
        // только конец касания — touchend или click, начало (touchstart) не считается.
        // Движок включает звук сам, но на телефоне касания по экрану до него не доходят:
        // их перехватывает setupTouchModeToggle. Поэтому включаем здесь, на window в фазе
        // захвата: этот слушатель ставится раньше перехватчика и раньше экранных кнопок.
        // Раньше тут слушались только touchstart и pointerdown, а пауза в 500 мс после
        // них отбрасывала click того же касания, — на iPhone звук не появлялся, пока
        // не нажмёшь экранную кнопку
        function forceAudioWakeUp() {
            const ctx = (typeof WebAudio !== 'undefined' && WebAudio._context) ? WebAudio._context : null;
            // 'interrupted' — iOS: звонок, Siri, выключенный экран
            if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
            try {
                ctx.resume().catch(() => {});
                // Пустой звук — старый способ отпереть его на iOS, для движков постарше
                const src = ctx.createBufferSource();
                src.buffer = ctx.createBuffer(1, 1, 22050);
                src.connect(ctx.destination);
                src.start(0);
            } catch (err) {}
        }

        ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'click', 'keydown'].forEach(ev => {
            window.addEventListener(ev, forceAudioWakeUp, { capture: true, passive: true });
        });

        // Видео со звуком iPhone тоже запускает только из касания. Но разрешение даётся
        // плееру, а не ролику: стоит один раз запустить плеер в касании — дальше он играет
        // сам. Плеер у движка один на все ролики, его и «разрешаем» первым касанием. Ролик,
        // который уже идёт без звука (начался до касания), этим касанием получает звук.
        // Только конец касания, клик и клавиша: начало касания iPhone не засчитывает
        function unlockVideo(e) {
            if (!e.isTrusted) return;
            // Ролики, которые начались до касания и идут без звука, получают звук. Каждым
            // касанием, а не только первым: плагины заводят для роликов свои плееры, и
            // каждому новому iPhone заново не даёт звук
            for (const muted of mutedVideos) muted.muted = false;
            mutedVideos.clear();
            const v = (typeof Graphics !== 'undefined' && Graphics._video) || (typeof Video !== 'undefined' && Video._element);
            if (!v || v.__rpgUnlocked || !v.paused) return;
            v.__rpgUnlocked = true;
            try {
                const p = _originalVideoPlay.call(v);
                if (p && p.catch) p.catch(() => {});
                v.pause();
            } catch (_) {}
        }
        ['touchend', 'click', 'keydown'].forEach(ev => {
            window.addEventListener(ev, unlockVideo, { capture: true, passive: true });
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) setTimeout(forceAudioWakeUp, 100);
        });
    }

    // ============================================================================
    // ФИКС КРАША СНИМКОВ ЭКРАНА (Броня на уровне движка RPG Maker)
    // ============================================================================
    const bitmapShieldTimer = setInterval(() => {
        // Ждем, пока движок загрузит класс Bitmap
        if (typeof Bitmap !== 'undefined' && Bitmap.prototype && Bitmap.prototype.getPixel) {
            clearInterval(bitmapShieldTimer);
            
            // 1. Защита функции getPixel (Часто ломается при определении клика по картинке)
            const origGetPixel = Bitmap.prototype.getPixel;
            Bitmap.prototype.getPixel = function(x, y) {
                x = (isFinite(x) && !isNaN(x)) ? Math.round(x) : 0;
                y = (isFinite(y) && !isNaN(y)) ? Math.round(y) : 0;
                try {
                    return origGetPixel.call(this, x, y);
                } catch(e) {
                    return '#000000'; // Возвращаем черный цвет при ошибке
                }
            };

            // 2. Защита функции getAlphaPixel (Проверка прозрачности)
            const origGetAlphaPixel = Bitmap.prototype.getAlphaPixel;
            Bitmap.prototype.getAlphaPixel = function(x, y) {
                x = (isFinite(x) && !isNaN(x)) ? Math.round(x) : 0;
                y = (isFinite(y) && !isNaN(y)) ? Math.round(y) : 0;
                try {
                    return origGetAlphaPixel.call(this, x, y);
                } catch(e) {
                    return 0; // Возвращаем полную прозрачность при ошибке
                }
            };
            
            // 3. Защита функции clearRect (Очистка экрана)
            const origClearRect = Bitmap.prototype.clearRect;
            Bitmap.prototype.clearRect = function(x, y, width, height) {
                x = (isFinite(x) && !isNaN(x)) ? Math.round(x) : 0;
                y = (isFinite(y) && !isNaN(y)) ? Math.round(y) : 0;
                width = (isFinite(width) && !isNaN(width)) ? Math.round(width) : 1;
                height = (isFinite(height) && !isNaN(height)) ? Math.round(height) : 1;
                try {
                    origClearRect.call(this, x, y, width, height);
                } catch(e) {}
            };

            console.log('[RPG Fixes] 🛡️ Броня Bitmap (getPixel/clearRect) активирована!');
        }
    }, 100);
    setTimeout(() => clearInterval(bitmapShieldTimer), 30000);

    // Картинка в MZ не загрузилась (сбой сети) — ещё две тихие попытки, через 1 и 3 секунды,
    // и только потом экран ошибки. MV так делает сам. Пока пробуем, игра ждёт, как при
    // обычной загрузке
    const imageRetryTimer = setInterval(() => {
        if (typeof Bitmap === 'undefined' || typeof Utils === 'undefined' || !Utils.RPGMAKER_NAME) return;
        clearInterval(imageRetryTimer);
        const P = Bitmap.prototype;
        if (Utils.RPGMAKER_NAME !== 'MZ' || typeof P.retry !== 'function' || typeof P._onError !== 'function' || P._onError.__rpg) return;
        const RETRY_MS = [1000, 3000];
        const onError = P._onError;
        P._onError = function() {
            const tries = this.__rpgTries || 0;
            if (tries < RETRY_MS.length && this._url && !this.__rpgGone) {
                this.__rpgTries = tries + 1;
                setTimeout(() => { if (!this.__rpgGone && this._loadingState === 'loading') this.retry(); }, RETRY_MS[tries]);
                return;
            }
            return onError.apply(this, arguments);
        };
        P._onError.__rpg = true;
        // Картинку уже выбросили — снова не грузим
        const destroy = P.destroy;
        P.destroy = function() { this.__rpgGone = true; return destroy.apply(this, arguments); };
    }, 20);
    setTimeout(() => clearInterval(imageRetryTimer), 30000);

    // ============================================================================
    // КАРТИНКИ БОЛЬШЕ ПРЕДЕЛА ВИДЕОКАРТЫ
    // ============================================================================
    // Анимация сцены — часто одна лента кадров на всю анимацию (PictureAnimation и похожие плагины): 15400×1000 при
    // кадре 700×1000 (Monster Museum). Текстуру больше своего предела (MAX_TEXTURE_SIZE: 8192 или 16384) видеокарта не
    // берёт — картинка пропадает («texImage: Requested size … unsupported»), а десяток таких лент по 60 МБ выбивает
    // WebGL совсем («WebGL context was lost»). Такой ленте в видеокарту идёт только кадр на экране, вырезанный на свой
    // маленький холст; кадр сам больше предела (лента на экране целиком) — уменьшенный и растянутый обратно.
    // shortcut: только Sprite (картинки, персонажи); TilingSprite с такой лентой и рисование поверх уже вырезанной ленты
    // в MV (у PIXI v4 нет dirtyId) не учтены — если начнут попадаться
    function setupBigPictures() {
        const timer = setInterval(() => {
            if (typeof Sprite === 'undefined' || !Sprite.prototype._refresh || typeof Graphics === 'undefined' || typeof PIXI === 'undefined') return;
            const renderer = (Graphics.app && Graphics.app.renderer) || Graphics._renderer;
            if (!renderer) return;
            clearInterval(timer);
            const gl = renderer.gl;
            const max = gl && gl.getParameter(gl.MAX_TEXTURE_SIZE);
            if (!max) return;
            // Холст кадра больше не нужен. Текстура ещё смотрит на него (картинку у спрайта убрали) — сначала отвязываем
            const drop = (sprite) => {
                const cut = sprite.__bigCut;
                if (!cut) return;
                const tex = sprite.texture;
                if (tex && tex.baseTexture === cut.base) {
                    tex.baseTexture = sprite._bitmap ? sprite._bitmap.baseTexture : PIXI.Texture.EMPTY.baseTexture;
                    tex._updateID++;
                }
                cut.base.destroy();
                sprite.__bigCut = null;
            };
            let told = false;
            const refresh = Sprite.prototype._refresh;
            Sprite.prototype._refresh = function () {
                refresh.apply(this, arguments);
                const bmp = this._bitmap;
                const tex = this.texture;
                if (!bmp || !tex || !(bmp.width > max || bmp.height > max) || tex.baseTexture !== bmp.baseTexture) { drop(this); return; }
                const src = bmp._canvas || bmp.__canvas || bmp._image;
                const f = tex.frame;
                if (!src || !f || f.width < 1 || f.height < 1) {
                    if (!src && !told) { told = true; console.warn(`[RPG Fixes] Картинка ${bmp.width}×${bmp.height} больше предела видеокарты (${max}), а вырезать кадр не из чего`); }
                    return;
                }
                const k = Math.min(1, max / f.width, max / f.height);
                const w = Math.max(1, Math.floor(f.width * k));
                const h = Math.max(1, Math.floor(f.height * k));
                // Тот же кадр той же картинки — холст не перерисовываем (dirtyId растёт, когда игра рисует на ней)
                const key = `${f.x},${f.y},${f.width},${f.height},${bmp.baseTexture.dirtyId || 0}`;
                let cut = this.__bigCut;
                if (!cut || cut.w !== w || cut.h !== h) {
                    drop(this);
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    cut = this.__bigCut = { canvas, base: new PIXI.BaseTexture(canvas), w, h, key: '' };
                }
                if (cut.key !== key || cut.src !== src) {
                    const ctx = cut.canvas.getContext('2d');
                    ctx.clearRect(0, 0, w, h);
                    ctx.drawImage(src, f.x, f.y, f.width, f.height, 0, 0, w, h);
                    cut.base.update();
                    cut.key = key;
                    cut.src = src;
                }
                const size = new PIXI.Rectangle(0, 0, f.width, f.height);
                tex.baseTexture = cut.base;
                tex.frame = new PIXI.Rectangle(0, 0, w, h);
                tex.orig = size;
                tex._updateID++;
                if (!told) {
                    told = true;
                    console.log(`[RPG Fixes] Картинка ${bmp.width}×${bmp.height} больше предела видеокарты (${max}) — на экран идёт только кадр`);
                }
            };
            const destroy = Sprite.prototype.destroy;
            if (destroy) Sprite.prototype.destroy = function () { drop(this); return destroy.apply(this, arguments); };
        }, 50);
        setTimeout(() => clearInterval(timer), 30000);
    }

    // ============================================================================
    // ИНИЦИАЛИЗАЦИЯ
    // ============================================================================

    function initUltimateFixes() {
        applyConsoleFixes();
        applyCoreEnginePatches();
        setupBrowserStubs();
        fixDevicePixelRatio();
        setupModernViewport();
        setupBigPictures();
        applyPerformanceOptimizations();
        setupSecureAudio(); 
        // Слушает касания на window раньше перехватчика касаний (setupTouchModeToggle)
        setupWakeLock();
        setupCloudSaves();
        setupGameStorage();
        setupGameExit();
        setupUIAndGamepad();
        setupPadKeys();
        setupLoadingHint();
        setupTextSkip();
        setupCleanView();
        setupTapToRead();
        setupTurbo();
        setupMute();
        setupTranslationFont();
        setupSelfTest();
        setupTranslationDisplay();
        setupTranslationWrap();
        setupFpsMonitor();
        setupSpikeDiagnostics();
        setupTouchModeToggle();
        injectCheats();
        setupSceneMarks();
        setupSlotLaunch();
        setupPanic();
        console.log('✅ RPG-Fixes Ultimate v4.1 успешно загружен!');
    }

    // ============================================================================
    // ПАТЧ ДЛЯ ПЛАГИНА TS_ADVsystem / TS_Decode (ПРАВИЛЬНЫЙ PROTOTYPE)
    // ============================================================================
    var aggressiveAdvPatch = setInterval(function() {
        if (typeof ADV_System === 'undefined' || !ADV_System || !ADV_System.prototype) return;
        clearInterval(aggressiveAdvPatch);
        console.log('[RPG Fixes] ADV_System.prototype patch activated!');

        // 1. localFileDirectoryPath — всегда возвращает 'scenario/'
        Object.defineProperty(ADV_System.prototype, 'localFileDirectoryPath', {
            value: function() { return 'scenario/'; },
            writable: false,
            configurable: false
        });

        // 2. УМНЫЙ fileLoad: перебор расширений, XHR и XOR-дешифровка
        ADV_System.prototype.fileLoad = function(filename) {
            // На веб-серверах важен регистр и точное расширение
            var variants = [
                'scenario/' + filename + '.txt',
                'scenario/' + filename + '.sl',
                'Scenario/' + filename + '.txt',
                'Scenario/' + filename + '.sl'
            ];
            
            var file_data = '';
            var successUrl = '';
            
            // Пробуем найти файл по всем вариантам путей
            for (var i = 0; i < variants.length; i++) {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', variants[i], false); 
                xhr.overrideMimeType('text/plain; charset=utf-8');
                try {
                    xhr.send();
                    // Сервер по IPv4 может вернуть статус 200 (ОК) или 0 (если CORS/локалка)
                    if (xhr.status === 200 || xhr.status === 0) {
                        if (xhr.responseText) {
                            file_data = xhr.responseText;
                            successUrl = variants[i];
                            break; // Файл найден!
                        }
                    }
                } catch(e) { }
            }
            
            if (!file_data) {
                console.error('[RPG Fixes] 🔴 Сценарий не найден (404) ни в одном из форматов:', filename);
                return '';
            }
            
            console.log('[RPG Fixes] 🟢 Сценарий скачан:', successUrl);
            
            // Шифр TS_Decode — по самому файлу, а не по параметру «Decode»: у Clockwork Vale он «true», а сценарии — обычный .txt
            // (её TS_Decode.js переписан без шифра). В обычном тексте есть строки-макросы «@…»; в зашифрованном зашифрован
            // и перевод строки — таких строк нет. Не вышло ни так, ни так — текст как есть. Правило то же, что у галереи
            // (services/galleryAdv.js): строка после trim() начинается с «@». Файл без макросов (реплики без «@») узнаём по
            // знакам: у зашифрованного почти все знаки ≥0x80, после XOR — почти все <0x80; японский текст ≥0x80 и так — его
            // узнаём по переводу строки: в зашифрованном его нет, после XOR он есть. Порядок проб у галереи для .sl
            // другой (там XOR первым), но файл однозначен, результат тот же
            var looksPlain = function(s) {
                var rows = s.split('\n');
                for (var r = 0; r < rows.length; r++) if (rows[r].trim().charAt(0) === '@') return true;
                return false;
            };
            if (!looksPlain(file_data)) {
                var key = 255;
                if (typeof PluginManager !== 'undefined') {
                    var k = parseInt((PluginManager.parameters('TS_Decode') || {})['Key'], 10);
                    if (k > 0 && k < 65536) key = k;
                }
                // По знаку UTF-16, как TS_Decode.js (split('')): эмодзи — два знака, каждый XOR ключ
                var out = [];
                for (var j = 0; j < file_data.length; j++) out.push(String.fromCharCode(file_data.charCodeAt(j) ^ key));
                var decoded = out.join('');
                var high = function(t) { var n = 0; for (var q = 0; q < t.length; q++) if (t.charCodeAt(q) >= 128) n++; return n; };
                if (looksPlain(decoded) || (high(file_data) * 2 > file_data.length && high(decoded) * 2 < decoded.length) ||
                    (file_data.indexOf('\n') < 0 && decoded.indexOf('\n') >= 0)) {
                    file_data = decoded;
                    console.log('[RPG Fixes] 🔓 Текст сценария успешно расшифрован!');
                }
            }

            return file_data;
        };
        console.log('[RPG Fixes] ADV_System.fileLoad + localFileDirectoryPath patched!');
    }, 10);
    setTimeout(function() { clearInterval(aggressiveAdvPatch); }, 15000);

    // ============================================================================
    // --- УЛЬТИМАТИВНЫЙ ФИКС ВИДЕО ДЛЯ IOS ---
    // ============================================================================

    // 1. Перехватываем само рождение видео-элемента (самый надежный способ для iPhone)
    const _origCreateElement = document.createElement;
    document.createElement = function(tagName, options) {
        const el = _origCreateElement.call(this, tagName, options);
        if (tagName && tagName.toLowerCase() === 'video') {
            // Намертво прибиваем атрибуты до того, как Safari о них узнает
            el.setAttribute('playsinline', 'playsinline');
            el.setAttribute('webkit-playsinline', 'playsinline');
            el.setAttribute('disablePictureInPicture', 'true');
            el.controls = false; // Отключаем элементы управления плеера
        }
        return el;
    };

    // 2. Запуск ролика. Движок включает ролик из игрового цикла, а не из касания, и iPhone
    //    отказывал ролику со звуком — rpg-fixes тогда имитировал конец, и ролик пропускался.
    //    Теперь ролик, начатый до первого касания, идёт без звука, а касание возвращает звук
    //    (unlockVideo в setupSecureAudio); после первого касания плеер играет со звуком сам
    const _originalVideoPlay = HTMLVideoElement.prototype.play;
    const mutedVideos = new Set();   // заглушены нами: звук им вернёт следующее касание
    HTMLVideoElement.prototype.play = function() {
        // Дублируем защиту на всякий случай
        this.setAttribute('playsinline', 'playsinline');
        this.setAttribute('webkit-playsinline', 'playsinline');

        const promise = _originalVideoPlay.apply(this, arguments);

        if (promise !== undefined) {
            promise.catch(error => {
                // Запуск прервали паузой или следующим роликом — это не отказ. Раньше и тут
                // имитировался конец, и мог оборваться уже следующий ролик
                if (error && error.name === 'AbortError') return;
                if (error && error.name === 'NotAllowedError' && !this.muted) {
                    this.muted = true;
                    mutedVideos.add(this);
                    const retry = _originalVideoPlay.call(this);
                    if (retry && retry.catch) retry.catch(() => this.dispatchEvent(new Event('ended')));
                    return;
                }
                console.warn('[RPG-Fixes] Видео не запустилось:', error);
                // Совсем не играет — имитируем конец, чтобы игра не зависла
                setTimeout(() => {
                    this.dispatchEvent(new Event('ended'));
                }, 100);
            });
        }
        return promise;
    };

    // 3. MV на телефонах всегда просит ролик в .mp4, а в сборках для Windows ролики только
    //    .webm — на iPhone каждый ролик MV упирался в 404 и пропускался. Safari играет WebM
    //    с iOS 17.4, так что просим .webm всегда, когда браузер его умеет. MZ так и делает сам
    let canWebm = false;
    try { canWebm = !!_origCreateElement.call(document, 'video').canPlayType('video/webm'); } catch (_) {}
    const videoExtTimer = setInterval(() => {
        if (typeof Game_Interpreter === 'undefined' || typeof Utils === 'undefined') return;
        clearInterval(videoExtTimer);
        if (Utils.RPGMAKER_NAME === 'MZ') return;
        Game_Interpreter.prototype.videoFileExt = () => (canWebm ? '.webm' : '.mp4');
    }, 50);
    setTimeout(() => clearInterval(videoExtTimer), 30000);

    // 4. Библиотека iphone-inline-video из MV нужна была iPhone до iOS 10, где видео внутри
    //    страницы не играло: она подменяет плееру play() и сама листает кадры. Старый iPhone
    //    она узнаёт по признаку, который есть только у Safari, — у любого другого браузера
    //    с iPhone в User-Agent она включается зря и ломает ролик. Где браузер играет видео
    //    внутри страницы сам, отключаем её
    if ('playsInline' in HTMLVideoElement.prototype) {
        const inlineVideoTimer = setInterval(() => {
            if (typeof window.makeVideoPlayableInline !== 'function') return;
            clearInterval(inlineVideoTimer);
            window.makeVideoPlayableInline = function() {};
        }, 20);
        setTimeout(() => clearInterval(inlineVideoTimer), 30000);
    }

   // ============================================================================
    // 🛡️ БРОНЯ ОТ ПОВРЕЖДЕННЫХ СЕЙВОВ И ОШИБОК ПЛАГИНОВ (V5 HYPER-SPEED)
    // ============================================================================
    const saveFixInterval = setInterval(() => {
        
        // 1. Лечим ядро StorageManager (global -> array). Пустой или повреждённый общий список
        //    сейвов, настройки и данные плагинов — не повод падать, подставляем пустые. А сами
        //    сейвы (file1, file2…) не трогаем: раньше повреждённый сейв тоже подменялся пустым
        //    объектом, игра «загружала» пустоту — $gameSystem и $gameParty пропадали, и дальше
        //    она падала. Без подмены MZ честно отвечает, что загрузить не удалось
        if (window.StorageManager && window.StorageManager.loadObject && !window.StorageManager.loadObject._isSafe) {
            const origLoad = window.StorageManager.loadObject;
            window.StorageManager.loadObject = function(saveName) {
                const loading = origLoad.apply(this, arguments);
                if (/^file\d+$/.test(saveName)) return loading;
                return loading.then(contents => {
                    if (saveName === 'global') return (contents && Array.isArray(contents)) ? contents : [];
                    return contents || {}; 
                }).catch(e => {
                    return saveName === 'global' ? [] : {};
                });
            };
            window.StorageManager.loadObject._isSafe = true;
            console.log('[RPG Fixes] 🛡️ Ядро StorageManager защищено (global -> array)');
        }

        // 2. Лечим плагин UTA_CommonSaveMZ
        if (window.utakata && window.utakata.CommonSave && !window.utakata.CommonSave._isSafe) {
            const origLoadS = window.utakata.CommonSave.loadCommonSaveSwitches;
            window.utakata.CommonSave.loadCommonSaveSwitches = function(contents) {
                if (!contents) return;
                return origLoadS.apply(this, arguments);
            };
            const origLoadV = window.utakata.CommonSave.loadCommonSaveVariables;
            window.utakata.CommonSave.loadCommonSaveVariables = function(contents) {
                if (!contents) return;
                return origLoadV.apply(this, arguments);
            };
            window.utakata.CommonSave._isSafe = true;
            console.log('[RPG Fixes] 🛡️ Плагин UTA_CommonSaveMZ вылечен');
        }

        // 3. Железобетонная защита от краша NUUN_SaveScreen (Восстанавливающийся щит)
        if (window.DataManager && window.DataManager.loadBackground && !window.DataManager.loadBackground._isSafe) {
            const origLoadBg = window.DataManager.loadBackground;
            window.DataManager.loadBackground = function(savefileId) {
                if (!this._globalInfo || !this._globalInfo[savefileId]) return null;
                try { return origLoadBg.apply(this, arguments); } catch(e) { return null; }
            };
            window.DataManager.loadBackground._isSafe = true;
            console.log('[RPG Fixes] 🛡️ DataManager.loadBackground (NUUN) вылечен');
        }

        // Патчим отрисовку фона. Метод фона берём в момент вызова, а не запоминаем:
        // щит встаёт раньше плагинов, и запомненный заранее метод меню обходил бы их
        // обёртки — в Ashen Crown экран сохранения из-за этого падал (плагин Drill
        // не находил фона, который создаёт его обёртка)
        if (window.Scene_File && window.Scene_File.prototype.createBackground && !window.Scene_File.prototype.createBackground._isSafe) {
            const ownBg = Object.prototype.hasOwnProperty.call(window.Scene_File.prototype, 'createBackground') ? window.Scene_File.prototype.createBackground : null;
            window.Scene_File.prototype.createBackground = function() {
                try {
                    (ownBg || Object.getPrototypeOf(window.Scene_File.prototype).createBackground).apply(this, arguments);
                } catch(e) {
                    console.warn('[RPG Fixes] 🛡️ Предотвращен краш фона меню сохранений:', e);
                    if (!this._backgroundSprite) {
                        this._backgroundSprite = new window.Sprite(); 
                        this.addChild(this._backgroundSprite);
                    }
                }
            };
            window.Scene_File.prototype.createBackground._isSafe = true;
            console.log('[RPG Fixes] 🛡️ Scene_File.createBackground защищен');
        }

        // Плагины от MV 1.6 (Community_Basic) в конце зовут Graphics.setErrorMessage, setShowErrorDetail,
        // setProgressEnabled, а у старого ядра MV их нет: плагин падал на последних строках (Hollow Spire, The Lantern Road…).
        // Как и в самой игре, это лишь настройки экрана ошибки — пустые функции, чтобы плагин дошёл до конца
        if (window.Graphics && !window.Graphics._errorApiPatched && typeof window.Graphics.printError === 'function') {
            for (const name of ['setErrorMessage', 'setShowErrorDetail', 'setProgressEnabled']) {
                if (typeof window.Graphics[name] !== 'function') window.Graphics[name] = function () {};
            }
            window.Graphics._errorApiPatched = true;
        }

        // 4. Шрифты MV: не ждать вечно шрифт, который не загрузится (нет файла, битый), и не
        //    бросать медленный. Раньше через секунду любой недогрузившийся шрифт считался
        //    «мёртвым»: у Ironhold Keep он весит 7,5 МБ, и на телефоне меню титула
        //    рисовалось запасным шрифтом. Теперь смотрим, что с ним на самом деле:
        //    загрузился — дальше, ошибка или его вовсе нет — дальше без него,
        //    грузится — ждём, но не дольше 20 секунд
        if (window.Graphics && typeof window.Graphics.isFontLoaded === 'function' && !window.Graphics._fontPatchActive) {
            const _origIsFontLoaded = window.Graphics.isFontLoaded;
            const fontWaitStart = Date.now();
            const skipped = new Set();
            const fontState = (name) => {
                const want = String(name).replace(/["']/g, '').toLowerCase();
                const faces = [];
                try {
                    document.fonts.forEach(f => { if (f.family.replace(/["']/g, '').toLowerCase() === want) faces.push(f); });
                } catch (_) { return 'unknown'; }
                if (!faces.length) return 'missing';
                if (faces.some(f => f.status === 'loaded')) return 'loaded';
                if (faces.every(f => f.status === 'error')) return 'error';
                // Объявлен, но никто его ещё не попросил — просим сами, иначе ждали бы зря
                faces.forEach(f => { if (f.status === 'unloaded') f.load().catch(() => {}); });
                return 'loading';
            };
            const skip = (name, why) => {
                if (!skipped.has(name)) {
                    skipped.add(name);
                    console.warn(`[RPG Fixes] 🛡️ Шрифт ${name}: ${why} — игра стартует без него`);
                }
                return true;
            };

            window.Graphics.isFontLoaded = function(name) {
                if (_origIsFontLoaded.apply(this, arguments)) return true;
                const state = fontState(name);
                if (state === 'loaded') return true;
                if (state === 'error') return skip(name, 'файл не загрузился');
                if (state === 'missing') return skip(name, 'игра его не объявила');
                if (Date.now() - fontWaitStart > 20000) return skip(name, 'не догрузился за 20 секунд');
                return false;
            };
            window.Graphics._fontPatchActive = true;
            console.log('[RPG Fixes] 🛡️ Защита шрифтов (MV) активирована');
        }

        // 5. Защита от вечной загрузки при пропавших шрифтах (Для новых игр MZ)
        if (window.FontManager && window.FontManager.startLoading && !window.FontManager._fontPatchActive) {
            const _origStartLoading = window.FontManager.startLoading;
            window.FontManager.startLoading = function(family, url) {
                const source = "url(" + url + ")";
                const font = new FontFace(family, source);
                this._urls[family] = url;
                this._states[family] = "loading";
                font.load()
                    .then(() => {
                        document.fonts.add(font);
                        this._states[family] = "loaded";
                    })
                    .catch((e) => {
                        console.warn(`[RPG Fixes] 🛡️ Пропущен сломанный шрифт: ${url}`);
                        this._states[family] = "loaded"; // Обманываем движок MZ
                    });
            };
            window.FontManager._fontPatchActive = true;
            console.log('[RPG Fixes] 🛡️ Защита от вечной загрузки шрифтов (MZ) активирована');
        }

    }, 5); // Часто — чтобы успеть до первого использования этих функций при загрузке игры
    // ...но только пока игра загружается. Раньше проверка крутилась 200 раз в секунду
    // до самого закрытия вкладки и не давала процессору телефона отдыхать. Всё, что
    // она латает, появляется при загрузке ядра и плагинов — за первые секунды
    setTimeout(() => clearInterval(saveFixInterval), 15000);

    // ============================================================================
    // 🛡️ БРОНЯ ОТ КРИВЫХ ПЛАГИНОВ (ГЛОБАЛЬНЫЙ ПАТЧ JSON.parse - ТИХИЙ РЕЖИМ)
    // ============================================================================
    if (!window._jsonPatchActive) {
        const _origJSONParse = JSON.parse;
        JSON.parse = function(text, reviver) {
            try {
                return _origJSONParse.apply(this, arguments);
            } catch (e) {
                if (typeof text === 'string') {
                    const trimmed = text.trim();
                    
                    // 1. Пустая строка — возвращаем её же, без ошибки: у плагинов с пустыми
                    //    параметрами JSON.parse('') иначе ронял игру при загрузке
                    if (trimmed === '') {
                        return text; 
                    }
                    
                    // 2. Спасаем математические формулы (типа "816 / 1000")
                    if (/^[\d\s\.\/\*\+\-\(\)]+$/.test(trimmed) && trimmed.length > 0) {
                        try {
                            const result = eval(trimmed);
                            console.warn(`[RPG Fixes] 🛡️ Спасен JSON (формула): "${text}" -> ${result}`);
                            return result;
                        } catch (err) {}
                    }
                }
                throw e; // Если это реально сломанный объект, кидаем ошибку дальше
            }
        };
        window._jsonPatchActive = true;
        console.log('[RPG Fixes] 🛡️ Глобальная защита JSON.parse активирована (Тихий режим)');
    }

    initUltimateFixes();

})();
