const { version } = require('../../package.json');
const { option } = require('../utils/options.js');
const { secret } = require('../utils/secrets.js');

// «О программе»: вышла ли новая версия. Версии — метки vX.Y(.Z) репозитория на GitHub (UPDATE_REPO), что нового —
// заголовки раздела этой версии в CHANGELOG.md на той же метке. Спрашиваем раз в 6 часов: без ключа GitHub даёт
// 60 запросов в час на адрес. Проверка выключена («О программе» или UPDATE_CHECK=0) или OFFLINE=1 — не спрашиваем.
// «Обновить» — не сам контейнер (ему для этого нужен доступ к Docker, то есть к хосту), а помощник рядом: Watchtower
// в режиме HTTP API или совместимый — адрес его /v1/update и ключ из «О программе» (зашифрованы, utils/secrets.js,
// updater) или из UPDATE_URL и UPDATE_TOKEN в .env. Без помощника — команда:
// для готового образа (MIMIKIN_IMAGE задаёт сборка образа, build-arg в Dockerfile) и для сборки из исходников
const REPO = process.env.UPDATE_REPO || 'Raven632/rpg-library';
const CHECK_MS = 6 * 60 * 60 * 1000;
// Не вышло спросить (сеть, лимит GitHub) — повторим скоро, а не через 6 часов: иначе точка о новой версии пропадёт надолго
const RETRY_MS = 10 * 60 * 1000;
const NOTES = 8;

// «v6.1» → [6, 1, 0]; не версия — null
const parse = (v) => {
    const m = String(v || '').match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
};
const newer = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
};
const show = (p) => (p[2] ? p.join('.') : `${p[0]}.${p[1]}`);

// Заголовки «- **…**» раздела «## [6.1] — дата» — коротко, что нового
function notesOf(changelog, ver) {
    const lines = String(changelog || '').split('\n');
    const start = lines.findIndex((l) => {
        const m = l.match(/^## \[([^\]]+)\]/);
        return m && parse(m[1]) && show(parse(m[1])) === show(ver);
    });
    if (start < 0) return [];
    const out = [];
    for (const l of lines.slice(start + 1)) {
        if (l.startsWith('## ')) break;
        const m = l.match(/^- \*\*(.+?)\*\*/);
        if (m) out.push(m[1].replace(/[.:]$/, ''));
    }
    return out.slice(0, NOTES);
}

class UpdateService {
    constructor() {
        this.cache = null;
        this.fetch = (...args) => fetch(...args);
        this.current = version;
        this.env = process.env;
        this.option = option;
        this.secret = secret;
    }

    // Помощник обновлений: { url, token } или null. .env главнее «Настроек»
    helper() {
        if (this.env.UPDATE_URL) return { url: this.env.UPDATE_URL, token: this.env.UPDATE_TOKEN || '' };
        try {
            const v = JSON.parse(this.secret('updater') || 'null');
            return v?.url ? { url: v.url, token: v.token || '' } : null;
        } catch { return null; }
    }

    async github(path, raw = false) {
        const url = raw ? `https://raw.githubusercontent.com/${REPO}/${path}` : `https://api.github.com/repos/${REPO}${path}`;
        const res = await this.fetch(url, { headers: { 'User-Agent': 'Mimikin', Accept: raw ? 'text/plain' : 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
        return raw ? res.text() : res.json();
    }

    // { current, latest, newer, notes, url, date, checkedAt, error, how } — how: 'button' | 'image' | 'source'
    async status(fresh = false) {
        const base = { current: this.current, how: this.how(), image: this.env.MIMIKIN_IMAGE || '' };
        if (this.env.OFFLINE === '1') return { ...base, off: true, offline: true };
        if (!this.option('update_check')) return { ...base, off: true };
        if (!fresh && this.cache && Date.now() - this.cache.checkedAt < (this.cache.error ? RETRY_MS : CHECK_MS)) return { ...base, ...this.cache };
        try {
            const tags = await this.github('/tags?per_page=50');
            // Закрытый репозиторий для чужих — то же «не найдено»
            if (!tags) throw new Error('репозиторий на GitHub не найден или закрыт');
            const best = tags.map((tg) => ({ tag: tg.name, v: parse(tg.name) })).filter((x) => x.v)
                .reduce((a, x) => (!a || newer(x.v, a.v) ? x : a), null);
            if (!best) throw new Error('на GitHub нет выпусков');
            const cur = parse(this.current) || [0, 0, 0];
            const isNewer = newer(best.v, cur);
            const notes = isNewer ? notesOf(await this.github(`${best.tag}/CHANGELOG.md`, true).catch(() => ''), best.v) : [];
            this.cache = { latest: show(best.v), newer: isNewer, notes, url: `https://github.com/${REPO}/blob/${best.tag}/CHANGELOG.md`, checkedAt: Date.now(), error: '' };
        } catch (e) {
            this.cache = { latest: '', newer: false, notes: [], url: '', checkedAt: Date.now(), error: e.message };
        }
        return { ...base, ...this.cache };
    }

    how() {
        if (this.helper()) return 'button';
        return this.env.MIMIKIN_IMAGE ? 'image' : 'source';
    }

    // Помощник сам скачает образ и перезапустит контейнер — этот ответ уходит раньше, чем сервер выключится
    async update() {
        const helper = this.helper();
        if (!helper) throw Object.assign(new Error('Помощник обновления не настроен'), { status: 409 });
        // Watchtower отвечает, только когда обновил, а скачивание образа — минуты: не дождались — значит, обновляет
        const res = await this.fetch(helper.url, {
            // Без переходов по перенаправлению: ключ — только тому адресу, что вписан
            method: 'POST', headers: helper.token ? { Authorization: `Bearer ${helper.token}` } : {}, redirect: 'manual', signal: AbortSignal.timeout(15000),
        }).catch((e) => (e.name === 'TimeoutError' ? { ok: true } : { ok: false, down: e.message }));
        if (res.down) throw Object.assign(new Error(`Помощник обновления недоступен (${new URL(helper.url).host}): ${res.down}`), { status: 502 });
        if (!res.ok) throw Object.assign(new Error(`Помощник обновления ответил ${res.status}`), { status: 502 });
        return { started: true };
    }
}

module.exports = new UpdateService();
module.exports.UpdateService = UpdateService;
module.exports.notesOf = notesOf;
