const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const { statusOfRow, planNext } = require('../utils/scrapeplan.js');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const { invalidateGamesList } = require('../utils/cache.js');
const { detectGameLanguages } = require('../utils/gamelang.js');
const { extractVersion } = require('../utils/title.js');
const { SYSTEM_DIRS } = require('../config/index.js');
const { seal, unseal } = require('../utils/secrets.js');
const galleryService = require('../services/gallery.js');

const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
// Поля игры, которые человек поменял сам (routes/games.js, «Изменить»): их автоматика не трогает
const lockedFields = (row) => { try { return JSON.parse(row?.meta_locked || '[]') || []; } catch { return []; } };

class DatabaseService {
    constructor() {
        this.db = null;
        this.sessionToken = '';
        this.io = null;
        this.scraperService = null;
        this.GAMES_DIR = '';
        this.textLangRunning = false;
        this.textLangAgain = false;
        // Корзина (services/trash.js): туда — запись игры, чью папку убрали мимо приложения
        this.trash = null;
    }

    setDependencies(io, scraperService, gamesDir, trash = null) {
        this.io = io;
        this.scraperService = scraperService;
        this.GAMES_DIR = gamesDir;
        this.trash = trash;
    }

    async init(gamesDir) {
        const file = path.join(gamesDir, 'library.db');
        this.db = await open({ filename: file, driver: sqlite3.Database });
        // В базе — ключ сессии и ключи служб: читать её может только сам сервер. SQLite даёт журналам (-wal, -shm) права
        // файла базы, но уже созданные — выправляем тоже. Не вышло (чужая файловая система, SMB) — работаем как есть
        const denied = [];
        for (const f of [file, `${file}-wal`, `${file}-shm`]) await fsp.chmod(f, 0o600).catch((e) => { if (e.code !== 'ENOENT') denied.push(e.code); });
        if (denied.length) console.warn(`[DB] Права 600 на library.db не поставить (${denied[0]}) — база читается не только сервером`);
        // Журнал WAL: чтение не ждёт записи, а запись — чтения. Ночная копия (deploy/backup.sh) и
        // sqlite3 из консоли больше не задерживают сервер. Режим сохраняется в самом файле базы.
        // busy_timeout — если базу всё-таки держит кто-то ещё, подождать до 5 секунд, а не падать
        await this.db.exec('PRAGMA journal_mode = WAL');
        await this.db.exec('PRAGMA busy_timeout = 5000');

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS games (
                id TEXT PRIMARY KEY, title TEXT, cover TEXT, tags TEXT, description TEXT,
                rating INTEGER DEFAULT 0, lastPlayed INTEGER DEFAULT 0, addedAt INTEGER DEFAULT 0, 
                scraped INTEGER DEFAULT 0, ready INTEGER DEFAULT 0
            )
        `);
        await this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');

        // 1. Пытаемся взять ключ из .env (Правильный путь для production)
        if (process.env.SESSION_SECRET) {
            this.sessionToken = process.env.SESSION_SECRET;
        } else {
            // 2. Иначе — случайный ключ, один раз сгенерированный и сохраненный в БД
            // В базе — зашифрованным (utils/secrets.js). Не расшифровался (ключ шифрования потерян) — новый: все устройства
            // войдут заново, но не по ключу, который кто-то мог вынести вместе с базой
            const tokenRow = await this.db.get('SELECT value FROM settings WHERE key = "session_secret"');
            const stored = tokenRow ? unseal(tokenRow.value, 'session_secret') : null;
            if (!stored) {
                if (tokenRow) console.warn('[DB] Ключ сессии не расшифровать — заведён новый, войдите заново');
                this.sessionToken = crypto.randomBytes(64).toString('hex');
            } else {
                this.sessionToken = stored;
            }
            // Ключа шифрования нет (папка _media только для чтения) — сервер всё равно стартует: ключ сессии остаётся
            // как был (или в памяти до перезапуска), а в журнале — что чинить
            if (!stored || !String(tokenRow.value).startsWith('enc1:')) {
                try {
                    await this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['session_secret', seal(this.sessionToken, 'session_secret')]);
                } catch (e) {
                    console.error('[DB]', e.message);
                }
            }
        }

        try { await this.db.exec('ALTER TABLE games ADD COLUMN developer TEXT DEFAULT ""'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN language TEXT DEFAULT ""'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN releaseDate TEXT DEFAULT ""'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN link TEXT DEFAULT ""'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN size INTEGER DEFAULT 0'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN version TEXT DEFAULT "1.0.0"'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN status TEXT DEFAULT ""'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN favorite INTEGER DEFAULT 0'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN playtime INTEGER DEFAULT 0'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN progress TEXT DEFAULT ""'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN screens TEXT DEFAULT ""'); } catch(e){}

        // Состояние поиска метаданных. Раньше «нашли / не нашли» было размазано по
        // трём местам: флаг scraped здесь, пометка «не найдено» и сама очередь в Redis.
        // Теперь всё в одной строке таблицы, и очередь — это просто «чей срок подошёл».
        let metaAdded = false;
        try { await this.db.exec("ALTER TABLE games ADD COLUMN meta_status TEXT DEFAULT 'new'"); metaAdded = true; } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN meta_attempts INTEGER DEFAULT 0'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN meta_checked_at INTEGER DEFAULT 0'); } catch(e){}
        try { await this.db.exec('ALTER TABLE games ADD COLUMN meta_retry_at INTEGER'); } catch(e){}
        try { await this.db.exec("ALTER TABLE games ADD COLUMN meta_error TEXT DEFAULT ''"); } catch(e){}
        // Поля, которые человек поправил руками: автопоиск их больше не трогает
        try { await this.db.exec("ALTER TABLE games ADD COLUMN meta_locked TEXT DEFAULT '[]'"); } catch(e){}
        // Ссылки, которые человек убрал из игры сам (ключи utils/links.js): поиск их не возвращает
        try { await this.db.exec("ALTER TABLE games ADD COLUMN links_removed TEXT DEFAULT '[]'"); } catch(e){}
        // Ссылку убрали — данные собрать заново, когда ответят все сайты (services/scraper.js, applyLookup)
        try { await this.db.exec('ALTER TABLE games ADD COLUMN meta_rebuild INTEGER DEFAULT 0'); } catch(e){}
        // Журнал последнего поиска (JSON, utils/lookuprun.js): что спросили у каждого сайта и что
        // было похоже, но не подошло — окно игры и «Как искали»
        try { await this.db.exec("ALTER TABLE games ADD COLUMN meta_log TEXT DEFAULT ''"); } catch(e){}
        if (metaAdded) await this.migrateMetaStatus();

        // Язык по тексту самой игры (см. utils/gamelang.js). NULL — ещё не считали,
        // пустая строка — посчитали, но текста не нашлось
        let textLangAdded = false;
        try { await this.db.exec('ALTER TABLE games ADD COLUMN text_lang TEXT'); textLangAdded = true; } catch(e){}
        // Поле language раньше заполнял автопоиск: магазин знает язык своего издания (Steam
        // пишет «Multi»), а не того, что лежит в папке. Теперь в нём только ручная правка,
        // найденное на сайтах стираем один раз
        if (textLangAdded) {
            await this.db.run(`UPDATE games SET language = '' WHERE COALESCE(meta_locked, '') NOT LIKE '%"language"%'`);
        }

        // Версия у себя, вписанная руками или узнанная при обновлении игры, когда в названии
        // папки её нет
        try { await this.db.exec("ALTER TABLE games ADD COLUMN my_version TEXT DEFAULT ''"); } catch(e){}

        // Список «Хочу поиграть» (services/wishlist.js). key — «itch:адрес игры»; info — что
        // показывало окно новинок (JSON)
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS wishlist (
                key TEXT PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL, url TEXT NOT NULL,
                info TEXT NOT NULL DEFAULT '{}', addedAt INTEGER NOT NULL DEFAULT 0
            )
        `);

        // Перевод игр (services/translate.js): словарь «оригинал → перевод» на каждый язык — общий для всех
        // игр, одинаковые строки переводятся один раз; origin — machine, import (свой файл) или manual.
        // game_translation — включённый язык игры ('' — выключен) и ход последнего перевода
        await this.db.exec(`CREATE TABLE IF NOT EXISTS translations (
            src TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '',
            origin TEXT NOT NULL DEFAULT 'machine', at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, lang))`);
        await this.db.exec(`CREATE TABLE IF NOT EXISTS game_translation (
            id TEXT PRIMARY KEY, lang TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
            at INTEGER NOT NULL DEFAULT 0)`);
        // Итог последней проверки переведённой игры в браузере («Проверить в игре»): когда, прошла ли, что нашлось
        try { await this.db.exec("ALTER TABLE game_translation ADD COLUMN check_at INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
        try { await this.db.exec("ALTER TABLE game_translation ADD COLUMN check_result TEXT NOT NULL DEFAULT ''"); } catch (e) {}
        // «Две установки» до связывания в обе стороны: ключ главной и связь второй — теперь их заменяет relay_pair
        await this.db.run("DELETE FROM settings WHERE key IN ('relay_key', 'relay_link')").catch(() => {});

        // «Перевести картинки» (services/pictures.js). picture_text — что найдено на картинке (по хэшу содержимого:
        // одна и та же картинка в разных играх и версиях разбирается один раз), labels — подписи с местом, стилем и
        // правками с экрана «Картинки»; picture_patches — «заплатки», стирающие подпись; game_pictures — какая
        // картинка игры какой хэш имеет (с размером и временем файла); picture_jobs — ход разбора по играм
        await this.db.exec(`CREATE TABLE IF NOT EXISTS picture_text (
            sha1 TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, w INTEGER NOT NULL DEFAULT 0, h INTEGER NOT NULL DEFAULT 0,
            bilingual INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', at INTEGER NOT NULL DEFAULT 0)`);
        await this.db.exec('CREATE TABLE IF NOT EXISTS picture_patches (hash TEXT PRIMARY KEY, png BLOB NOT NULL)');
        await this.db.exec(`CREATE TABLE IF NOT EXISTS game_pictures (
            game_id TEXT NOT NULL, key TEXT NOT NULL, rel TEXT NOT NULL, sha1 TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
            mtime INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT '', PRIMARY KEY (game_id, key))`);
        await this.db.exec(`CREATE TABLE IF NOT EXISTS picture_jobs (
            game_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'ui', done INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0)`);

        // Избранное из галерей игр (GameGallery → сердечко, FavoritesGallery): файл галереи игры и его раздел —
        // ролик или петлю показывают иначе, чем картинку. Строки удалённой в корзину игры остаются (вернут — и они вернутся)
        await this.db.exec(`CREATE TABLE IF NOT EXISTS gallery_favorites (
            game_id TEXT NOT NULL, file TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (game_id, file))`);
        // Анимация из кадров, отмеченная целиком: JSON { frames, fps }; пусто — одна картинка или ролик
        try { await this.db.exec("ALTER TABLE gallery_favorites ADD COLUMN anim TEXT NOT NULL DEFAULT ''"); } catch (e) {}

        console.log('🗄️ [DB] База данных инициализирована.');
        return this.db;
    }

    get() {
        if (!this.db) throw new Error('База данных еще не инициализирована!');
        return this.db;
    }

    // Разовый перенос старого состояния в новые колонки. Игры с тегами, ссылкой и
    // картинками считаются готовыми; «не найденные» получают первую попытку завтра,
    // а не прямо сейчас — иначе обновление запустило бы разом обход всей библиотеки.
    async migrateMetaStatus() {
        const rows = await this.db.all('SELECT id, tags, description, link, screens, scraped FROM games');
        const now = Date.now();
        for (const row of rows) {
            let status = statusOfRow(row);
            let plan = planNext(status, 0, now);
            if (!row.scraped && status === 'not_found') {
                status = 'new';
                plan = { attempts: 0, retryAt: now };
            }
            await this.db.run(
                'UPDATE games SET meta_status = ?, meta_attempts = ?, meta_retry_at = ? WHERE id = ?',
                [status, plan.attempts, plan.retryAt, row.id]
            );
        }
        console.log(`🗄️ [DB] Состояние метаданных перенесено: ${rows.length} игр`);
    }

    // До init() токен пустой — requireAuth в этом случае никого не пускает
    getSessionToken() { return this.sessionToken; }

    // Ключ сессии один на весь сервер, поэтому «выйти» по-настоящему — это сменить
    // его: старая кука перестаёт работать сразу и везде, включая устройство, которое
    // потерялось. Если ключ задан в .env, он там и остаётся: после перезапуска
    // значение всё равно вернётся из конфига, и смена была бы обманом.
    async rotateSessionToken() {
        if (process.env.SESSION_SECRET) return false;
        this.sessionToken = crypto.randomBytes(64).toString('hex');
        await this.db.run(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ['session_secret', seal(this.sessionToken, 'session_secret')]
        );
        return true;
    }

    // Новая папка в библиотеке — от загрузки (services/uploads.js) или замеченная вотчером. Бывает,
    // что зовут оба разом, а бывает, что папка вернулась на место после того, как её убирали
    async addGameToDB(folder, gamePath) {
        // Запись уже есть — второй вызов для той же папки: не стираем то, что успел найти поиск после
        // первого, только обновляем то, что берётся из файлов (название, версия, язык)
        if (await this.db.get('SELECT id FROM games WHERE id = ?', [folder])) {
            await this.refreshGame(folder, gamePath);
            return;
        }
        // Папку убирали мимо приложения, и её вернули — возвращается и всё, что об игре было известно:
        // наигранное время, статус, оценка, найденные данные
        const back = await this.trash?.takeVanished(folder).catch((e) => { console.error('[Корзина]', e.message); return null; });
        if (back) {
            const cols = new Set((await this.db.all('PRAGMA table_info(games)')).map((c) => c.name));
            const keys = Object.keys(back).filter((k) => cols.has(k));
            await this.db.run(
                `INSERT OR REPLACE INTO games (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                keys.map((k) => back[k]),
            );
            await this.refreshGame(folder, gamePath);
            console.log(`[DB] ${folder}: папка вернулась — вернулась и запись игры`);
            if (this.io) this.io.emit('scrape-success', { kind: 'restored', title: back.title || folder, message: `Игра «${back.title || folder}» вернулась в библиотеку` });
            return;
        }

        let title = folder.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim() || folder;
        
        try {
            const sysRaw = await fsp.readFile(path.join(gamePath, 'data', 'System.json'), 'utf8');
            const sys = JSON.parse(sysRaw);
            if (sys.gameTitle && !sys.gameTitle.toLowerCase().includes('rmmz')) title = sys.gameTitle;
        } catch(e) {}

        // Обложка — своя картинка игры; найденную в магазине позже положит поиск (saveGameMedia)
        const cover = (await this.ownCover(folder, gamePath)) || (await this.gameImageCover(folder, gamePath));

        const stat = await fsp.stat(gamePath);

        // OR IGNORE: пока качали обложку, ту же папку мог добавить второй вызов — его запись главнее
        const added = await this.db.run(
            `INSERT OR IGNORE INTO games (id, title, cover, tags, description, rating, lastPlayed, addedAt, scraped, ready)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [folder, title, cover, '[]', '', 0, 0, stat.birthtimeMs || stat.mtimeMs || Date.now(), 0, 1]
        );
        if (!added?.changes) return;
        
        // Библиотека изменилась — кэш списка больше не актуален
        await invalidateGamesList();

        if (this.io) this.io.emit('scrape-success', { kind: 'added', title, message: `Игра «${title}» в библиотеке` });

        // Новая игра сразу «созрела» для поиска — воркер возьмёт её первой
        this.scraperService.requestScrape([folder]);
        // Язык текста у новой игры ещё не считали
        this.fillTextLang().catch(e => console.error('[Lang]', e.message));
    }

    // Досчитывает язык игр, у которых его ещё нет. Одна игра — доли секунды, но вся
    // библиотека — полминуты чтения карт, поэтому фоном, а не в запросе.
    // Повторный вызов во время прохода не теряется: проход просто повторится
    async fillTextLang() {
        if (this.textLangRunning) { this.textLangAgain = true; return; }
        this.textLangRunning = true;
        try {
            do {
                this.textLangAgain = false;
                const rows = await this.db.all('SELECT id FROM games WHERE text_lang IS NULL AND ready = 1');
                for (const { id } of rows) {
                    const found = await detectGameLanguages(path.join(this.GAMES_DIR, id)).catch(() => null);
                    await this.db.run('UPDATE games SET text_lang = ? WHERE id = ?', [found ? JSON.stringify(found) : '', id]);
                }
                if (rows.length) {
                    console.log(`[Lang] Язык определён: ${rows.length} игр`);
                    await invalidateGamesList();
                }
            } while (this.textLangAgain);
        } finally {
            this.textLangRunning = false;
        }
    }

    // Обложка, которую автор положил в игру: cover.jpg или cover.png
    async ownCover(folder, gamePath) {
        if (await exists(path.join(gamePath, 'cover.jpg'))) return `${folder}/cover.jpg`;
        if (await exists(path.join(gamePath, 'cover.png'))) return `${folder}/cover.png`;
        return null;
    }

    // Запасная обложка из самой игры: первый титульный экран, иначе иконка
    async gameImageCover(folder, gamePath) {
        const titles = await fsp.readdir(path.join(gamePath, 'img', 'titles1')).catch(() => []);
        const image = titles.find((f) => /\.(png|jpg|jpeg)$/i.test(f));
        if (image) return `${folder}/img/titles1/${image}`;
        if (await exists(path.join(gamePath, 'icon', 'icon.png'))) return `${folder}/icon/icon.png`;
        return null;
    }

    // Новая версия игры встала на место старой (services/uploads.js). Запись та же — сохранения,
    // наигранное время, статус и найденные данные при ней. Меняем только то, что берётся из самих
    // файлов: название — как при добавлении игры, из самой игры, если человек не вписывал его сам;
    // свою версию — из имени архива или названия в игре (иначе на карточке осталась бы старая
    // бы: в имени папки осталась старая); обложку из папки игры, если прежней больше нет; язык
    // patch — поверх игры лёг патч или мод (services/uploads.js): игра та же, её название и версию
    // не трогаем, а язык текста считаем заново — английский патч его меняет
    async refreshGame(folder, gamePath, { archiveName = '', backupDir = '', patch = false, version: expected = '' } = {}) {
        // Картинки игры поменялись — оглавление галереи построится заново
        galleryService.forget(folder).catch(() => {});
        const row = await this.db.get('SELECT title, cover, my_version, meta_locked FROM games WHERE id = ?', [folder]);
        if (!row) return {};
        // Что было до новой версии — рядом с отложенной прежней: «Вернуть прежнюю версию» вернёт и
        // это. Только первый раз: повторный заход после перезапуска сервера видит уже новое
        if (backupDir) {
            const saved = { title: row.title || '', my_version: row.my_version || '', cover: row.cover || '', ...(patch ? { patch: archiveName } : {}) };
            await fsp.writeFile(`${backupDir}.json`, JSON.stringify(saved), { flag: 'wx' }).catch(() => {});
        }
        if (patch) {
            await this.db.run('UPDATE games SET text_lang = NULL WHERE id = ?', [folder]);
            await invalidateGamesList();
            this.fillTextLang().catch((e) => console.error('[Lang]', e.message));
            return {};
        }
        let gameTitle = '';
        try { gameTitle = JSON.parse(await fsp.readFile(path.join(gamePath, 'data', 'System.json'), 'utf8')).gameTitle || ''; } catch (e) {}
        // Версия — из имени архива; нет там — заданная загрузкой по ссылке (expected), потом из названия в игре:
        // его авторы обновлять забывают
        const version = extractVersion('', archiveName.replace(/\.(zip|7z|rar)$/i, '')) || expected || extractVersion(gameTitle, '');
        const fields = { text_lang: null };
        if (version) fields.my_version = version.slice(0, 40);
        if (gameTitle && !gameTitle.toLowerCase().includes('rmmz') && !lockedFields(row).includes('title')) fields.title = gameTitle;
        if (row.cover && row.cover.startsWith(`${folder}/`) && !(await exists(path.join(this.GAMES_DIR, row.cover)))) {
            fields.cover = (await this.ownCover(folder, gamePath)) || (await this.gameImageCover(folder, gamePath));
        }
        const keys = Object.keys(fields);
        await this.db.run(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), folder]);
        await invalidateGamesList();
        this.fillTextLang().catch((e) => console.error('[Lang]', e.message));
        return { version };
    }

    // Прежняя версия вернулась на место (routes/games.js): своя версия и обложка — как до обновления,
    // язык текста — заново
    async restoreGame(folder, saved = {}) {
        galleryService.forget(folder).catch(() => {});
        const row = await this.db.get('SELECT meta_locked FROM games WHERE id = ?', [folder]);
        const fields = { text_lang: null, my_version: saved.my_version || '' };
        if (saved.cover !== undefined) fields.cover = saved.cover || null;
        // Название, вписанное руками после обновления, главнее прежнего
        if (saved.title && !lockedFields(row).includes('title')) fields.title = saved.title;
        const keys = Object.keys(fields);
        await this.db.run(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), folder]);
        await invalidateGamesList();
        this.fillTextLang().catch((e) => console.error('[Lang]', e.message));
    }

    async syncDatabase() {
        const entries = await fsp.readdir(this.GAMES_DIR);
        const existingGames = await this.db.all('SELECT id FROM games');
        const dbIds = existingGames.map(g => g.id);

        for (const folder of entries) {
            const gamePath = path.join(this.GAMES_DIR, folder);
            try { 
                const stat = await fsp.stat(gamePath); 
                if (!stat.isDirectory() || SYSTEM_DIRS.includes(folder)) continue;
                if (!dbIds.includes(folder)) await this.addGameToDB(folder, gamePath);
            } catch(e) { continue; }
        }

        for (const id of dbIds) {
            if (!entries.includes(id) || SYSTEM_DIRS.includes(id)) {
                // Папки могло не быть лишь миг — игру меняли на новую версию (services/uploads.js):
                // убираем запись, только если папки нет и сейчас. Иначе с ней ушло бы всё, что об игре известно
                if (!SYSTEM_DIRS.includes(id) && await exists(path.join(this.GAMES_DIR, id))) continue;
                // Папку убрали мимо приложения (стёрли, перенесли, переименовали) — запись не стираем,
                // а кладём в корзину на 30 дней: вернут папку — вернётся и игра (addGameToDB)
                if (!SYSTEM_DIRS.includes(id) && this.trash) {
                    try {
                        await this.trash.keepVanished(id);
                        console.log(`[DB] ${id}: папки больше нет — запись игры в корзине на 30 дней`);
                    } catch (e) {
                        console.error('[Корзина]', e.message);
                        continue;
                    }
                } else {
                    await this.db.run('DELETE FROM games WHERE id = ?', [id]);
                }
                await invalidateGamesList();
            }
        }
    }
}

module.exports = new DatabaseService();
