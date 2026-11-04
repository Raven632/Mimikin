import { tagLabel } from './galleryView';
import { formatPlaytime } from './formatPlaytime';
import { timeAgo } from './formatAgo';
import { languageName } from './formatLanguage';

// Причины подбора (api/src/services/recommend.js): код и данные приходят с сервера, слова — здесь и в словаре t.pick_r.
// Причина всегда правда про эту игру, поэтому текст не добавляет от себя: planned.at — когда игра появилась в библиотеке,
// а не когда её отложили, этого база не знает

const tagNames = (t, tags) => (tags || []).map((tag) => tagLabel(t, tag));

// Строка причины в окне: слова со значениями, обёрнутыми в strong (выделение золотом), и что показать справа
export function reasonRow(t, lang, reason, strong) {
  const r = t.pick_r;
  const p = reason.params || {};
  switch (reason.code) {
    case 'same-dev': {
      const time = formatPlaytime(p.playtime, t);
      return { text: time ? r.same_dev(strong(p.game, 'game'), strong(time, 'time')) : r.same_dev_liked(strong(p.game, 'game')), proof: p.gameId };
    }
    case 'tags-like': return { text: r.tags_like(strong(p.game, 'game')), tags: tagNames(t, p.tags) };
    case 'favorite-tags': return { text: r.favorite, tags: tagNames(t, p.tags) };
    case 'planned': return { text: p.at ? r.planned_added(timeAgo(p.at, lang)) : r.planned };
    case 'known-lang': return { text: r.known_lang(strong(languageName(p.lang, lang), 'lang')) };
    case 'translation':
      return { text: r.translation_here(strong(languageName(p.lang, lang), 'lang')) };
    case 'left': {
      const time = strong(formatPlaytime(p.playtime, t), 'time');
      // at = 0: время есть, а запуска в Mimikin не было (сейвы) — когда играли, неизвестно
      return { text: p.at ? r.left(timeAgo(p.at, lang), time) : r.left_no_date(time) };
    }
    default: return null;
  }
}

// Та же причина одной строкой — под плиткой игры
export function reasonShort(t, lang, reason) {
  if (!reason) return '';
  const r = t.pick_r;
  const p = reason.params || {};
  switch (reason.code) {
    case 'same-dev': return r.same_dev_short(p.game);
    case 'own-dev': return r.own_dev_short(p.game);
    case 'tags-like': return r.tags_like_short(p.game, tagNames(t, p.tags).join(', '));
    case 'favorite-tags': return r.favorite_short(tagNames(t, p.tags).join(', '));
    case 'planned': return r.planned;
    case 'known-lang': return r.known_lang(languageName(p.lang, lang)).join('');
    case 'translation': return r.translation_here(languageName(p.lang, lang)).join('');
    case 'left': {
      const time = formatPlaytime(p.playtime, t);
      return (p.at ? r.left(timeAgo(p.at, lang), time) : r.left_no_date(time)).join('');
    }
    default: return '';
  }
}
