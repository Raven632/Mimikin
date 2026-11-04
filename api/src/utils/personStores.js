const path = require('path');
const { SAVES_DIR, GAMES_DIR } = require('../config/index.js');
const { createSaveStore } = require('./savestore.js');
const { createMarkStore, folderRev } = require('./marks.js');
const { createJournal } = require('./journal.js');

// Сейвы, моменты и «путь» у каждого человека свои. Владелец остаётся там, где всегда: _saves/<игра>, _saves/.marks, .journal,
// .history, .shots. Остальные — зеркало того же устройства в _saves/.people/<id>/: внутри те же папки, поэтому хранилища
// те же самые, меняется только корень. Точка в начале имени держит .people вне игр: ревизия не считает её сиротой,
// восстановление не читает её как игру, id игры с точки маршруты отбивают (isSafeSegment + startsWith('.'))
const PEOPLE_DIR = '.people';
const ID = /^u[0-9a-f]{16}$/;

const make = (root) => ({
    root,
    saves: createSaveStore(root),
    // Версия игры для «Где вышли» посреди сцены — inode её папки; папка игры одна на всех
    marks: createMarkStore(root, { revOf: folderRev(GAMES_DIR) }),
    journal: createJournal(root),
});

// Хранилища владельца — одни на весь процесс (на них же завязаны миграция имён папок и тесты)
const owner = make(SAVES_DIR);
const people = new Map();

// person — req.person или { id }; пусто, 'owner' и isOwner — владелец. Чужой id, не похожий на наш, — ошибка: такой путь
// не должен стать частью адреса на диске
function storesFor(person) {
    if (!person || person.isOwner || person.id === 'owner') return owner;
    if (typeof person.id !== 'string' || !ID.test(person.id)) throw new Error('Некорректный идентификатор человека');
    if (!people.has(person.id)) people.set(person.id, make(path.join(SAVES_DIR, PEOPLE_DIR, person.id)));
    return people.get(person.id);
}

// Папка человека без создания (слияние копий, перенос на место игры с полки)
const rootOf = (userId) => path.join(SAVES_DIR, PEOPLE_DIR, userId);

module.exports = { storesFor, rootOf, PEOPLE_DIR, owner };
