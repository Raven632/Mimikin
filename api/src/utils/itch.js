// itch.io: ссылки на игры, RSS-ленты каталога и страница игры.
//
// Страницы itch.io закрыты для сервера (Cloudflare просит JavaScript) — их открываем только
// через ScraperAPI. А RSS-ленты каталога открыты: в них название, обложка, цена, платформы
// и даты, но нет тегов, оценок и поиска по названию

const { decodeEntities, htmlToText } = require('./html.js');

// Страница игры: «https://автор.itch.io/игра». Страница автора (без игры) — не игра
const GAME_URL = /https?:\/\/([a-z0-9][a-z0-9-]*)\.itch\.io\/([a-z0-9][a-z0-9_-]*)/i;

function itchGameUrl(link) {
    for (const part of String(link || '').split(/[\s,]+/)) {
        const m = part.match(GAME_URL);
        if (m && m[1].toLowerCase() !== 'www') return `https://${m[1].toLowerCase()}.itch.io/${m[2].toLowerCase()}`;
    }
    return '';
}

const PLATFORMS = ['windows', 'osx', 'linux', 'android', 'html'];   // html — играется в браузере

// Длинный текст — по границе слова и с многоточием, а не на полуслове
const cut = (text, n) => (text.length > n ? `${text.slice(0, n).replace(/\s+\S*$/, '')}…` : text);

// Лента каталога: <item> на каждую игру
function parseItchRss(xml) {
    const text = (s, name) => {
        const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
        return m ? m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim() : '';
    };
    const items = [];
    for (const [, it] of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const url = itchGameUrl(text(it, 'link') || text(it, 'guid'));
        const title = decodeEntities(text(it, 'plainTitle'));
        if (!url || !title) continue;
        // «Название [Free] [Role Playing] [Windows]»: в скобках — цена, жанр, платформы
        const brackets = [...decodeEntities(text(it, 'title')).matchAll(/\[([^\]]+)\]/g)].map((b) => b[1]);
        const genre = brackets.slice(1).find((b) => !/^(?:windows|macos|linux|android|play in browser)$/i.test(b)) || '';
        const price = text(it, 'price');
        items.push({
            url,
            title,
            creator: url.split('//')[1].split('.')[0],
            genre,
            price: /^\D*0(?:\.0+)?$/.test(price) ? '' : price,   // пусто — бесплатно
            platforms: PLATFORMS.filter((p) => new RegExp(`<${p}>yes</${p}>`).test(it)),
            description: cut(htmlToText(text(it, 'description')), 400),
            cover: text(it, 'imageurl'),
            createdAt: Date.parse(text(it, 'createDate')) || 0,
            updatedAt: Date.parse(text(it, 'updateDate')) || Date.parse(text(it, 'pubDate')) || 0,
        });
    }
    return items;
}

// Страница игры: название, описание, теги, автор, даты, оценка, обложка и кадры в полном размере
function parseItchPage(html, url) {
    const s = String(html || '');
    const title = htmlToText((s.match(/<h1[^>]*class="[^"]*\bgame_title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
    if (!title) return null;
    const meta = (prop) => decodeEntities((
        s.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*property="${prop}"`, 'i'))
        || s.match(new RegExp(`<meta[^>]*property="${prop}"[^>]*content="([^"]*)"`, 'i')) || []
    )[1] || '');
    // Таблица «More information»: <tr><td>Имя</td><td>значение</td></tr>
    const row = (name) => (s.match(new RegExp(`<td>${name}</td>\\s*<td>([\\s\\S]*?)</td>\\s*</tr>`, 'i')) || [])[1] || '';
    const names = (cell) => [...cell.matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
    const dateOf = (cell) => {
        const d = Date.parse(((cell.match(/title="([^"]+)"/) || [])[1] || '').replace(/\s*@.*$/, ''));
        return Number.isNaN(d) ? '' : new Date(d).toISOString().slice(0, 10);
    };
    // Описание — от своего блока до «More information»
    const start = s.search(/<div class="formatted_description[^"]*">/i);
    const tail = start < 0 ? -1 : s.slice(start).search(/<div[^>]*class="more_information_toggle/i);
    const description = start < 0 ? '' : cut(htmlToText(s.slice(start, tail > 0 ? start + tail : start + 20000)), 2000);
    const at = s.indexOf('class="screenshot_list"');
    const shots = at < 0 ? '' : s.slice(at, s.indexOf('</div>', at));
    const rating = (row('Rating').match(/([\d.]+) average rating from (\d+)/) || []);
    return {
        title,
        link: itchGameUrl(url) || url,
        description,
        tags: names(row('Tags')),
        genre: names(row('Genre')).join(', '),
        developer: names(row('Author')).join(', '),
        madeWith: names(row('Made with')).join(', '),
        platforms: names(row('Platforms')),
        releaseDate: dateOf(row('Release date')) || dateOf(row('Published')),
        updated: dateOf(row('Updated')),
        rating: rating[1] ? { value: Number(rating[1]), count: Number(rating[2]) } : null,
        coverUrl: meta('og:image'),
        screens: [...shots.matchAll(/<a[^>]*href="(https:\/\/img\.itch\.zone\/[^"]+)"/g)].map((m) => m[1]).slice(0, 6),
    };
}

module.exports = { itchGameUrl, parseItchRss, parseItchPage };
