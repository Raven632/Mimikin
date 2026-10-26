// Чтение чужих страниц: сущности HTML и HTML в простой текст

function decodeEntities(s) {
    return String(s || '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

// Абзацы и переносы — строками, теги — прочь, сущности — символами
function htmlToText(html) {
    return decodeEntities(String(html || '')
        .replace(/\r\n?/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ''))
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = { decodeEntities, htmlToText };
