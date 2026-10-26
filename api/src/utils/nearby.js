// Службы рядом: LibreTranslate из docker-compose.yml (профиль libretranslate). Включили —
// библиотека находит их сама по имени в сети Docker, раз в 5 минут, и пользуется ими, пока в «Настройках» не вписан
// свой адрес (utils/secrets.js, setDetected). Выключили — через 5 минут перестаёт
const { setDetected } = require('./secrets.js');

const EVERY_MS = 5 * 60 * 1000;
const NEARBY = {
    libre: { url: 'http://libretranslate:5000', path: '/languages', ok: (data) => Array.isArray(data) && data.length > 0 },
};
const found = {};

async function findNearby() {
    for (const [name, { url, path, ok }] of Object.entries(NEARBY)) {
        let here = false;
        try {
            const res = await globalThis.fetch(`${url}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
            here = res.ok && ok(await res.json().catch(() => null));
        } catch (e) { /* такой службы рядом нет */ }
        if (here !== !!found[name]) console.log(`[Службы рядом] ${name}: ${here ? `нашёлся, ${url}` : 'пропал'}`);
        found[name] = here;
        setDetected(name, here ? url : '');
    }
}

function startNearby() {
    findNearby();
    setInterval(findNearby, EVERY_MS).unref();
}

module.exports = { findNearby, startNearby, NEARBY };
