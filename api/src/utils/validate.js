const path = require('path');

// Ровно один сегмент пути: без слэшей и без "." / ".."
// (иначе path.join(BASE_DIR, id) указывает на саму BASE_DIR или выше неё)
function isSafeSegment(name) {
    return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && name === path.basename(name);
}

// Для router.param: отбиваем опасный id до входа в роут
function validateIdParam(req, res, next, value) {
    if (!isSafeSegment(value)) return res.status(400).json({ error: 'Некорректный идентификатор' });
    next();
}

module.exports = { isSafeSegment, validateIdParam };
