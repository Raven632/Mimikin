const multer = require('multer');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { UPLOAD_TMP } = require('../config/index.js');

const uploadLimiter = rateLimit({ 
    windowMs: 60 * 1000, 
    max: 500, // УВЕЛИЧИЛИ ДО 500 (разрешаем отправку множества кусочков файла)
    message: { error: 'Слишком много загрузок' } 
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_TMP),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '';
        cb(null, `chunk_${Date.now()}_${Math.round(Math.random() * 1000)}${ext}`);
    }
});

const archivesOnly = (req, file, cb) => {
    if (file.originalname.match(/\.(zip|7z|rar)$/i)) cb(null, true);
    else cb(new Error('Поддерживаются только ZIP, 7z и RAR!'));
};

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // 10 GB limit
    fileFilter: archivesOnly
});

// Импорт сейвов: архив больше 50 МБ не пишем на диск вовсе. Маршрут открыт любому человеку, а общий лимит выше — 20 ГБ
const savesUpload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: archivesOnly
});

const coverUpload = multer({
    // Папку создаёт server.js. С dest: multer создавал её сам при загрузке модуля, и папка без права записи роняла
    // процесс раньше, чем сервер успевал сказать, что случилось (utils/dbDown.js)
    storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, UPLOAD_TMP) }),
    limits: { fileSize: 100 * 1024 * 1024 }, // 10 MB лимит
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Разрешены только изображения!'));
        }
        cb(null, true);
    }
});

module.exports = { upload, savesUpload, uploadLimiter, coverUpload };
