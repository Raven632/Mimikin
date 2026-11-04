// Размер кадра читаем прямо из заголовка JPEG (маркер SOF), без лишнего процесса. Нужен, чтобы отличить настоящий
// скриншот от превью 400×250 и от значка под темой (services/scraper.js) и чтобы не пустить в аватар огромную картинку
// (utils/avatars.js). Нет маркера — { width: 0, height: 0 }
function jpegSize(buf) {
    for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        const isSOF = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
    }
    return { width: 0, height: 0 };
}

module.exports = { jpegSize };
