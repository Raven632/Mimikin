import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLayer } from '../layers';
import { changeHiddenTags, searchPictures, tagLabel } from '../galleryView';
import { fitRows } from '../fitRows';
import SearchBox from './SearchBox';
import { IconBan, IconCheck, IconClose } from './icons';
import { isOwner } from '../me';
import { frameTagsUrl } from '../apiUrl';

// Тегов у кадра в просмотре — самые уверенные: остальные слабее и только закрывали бы картинку
const STRIP = 16;
// Тегов в большой библиотеке — тысячи: все строки сразу делали каждый выбор секундным. Остальные дорисовываются при прокрутке
const ROWS_STEP = 120;

// Теги кадра в просмотре галереи (кнопка «Теги»): что разметчик увидел на картинке, самые уверенные первыми. Нажатие —
// поиск по картинкам с этим тегом во всех играх (searchPictures). Разметчик кадр ещё не прошёл — так и пишем; сервер не
// ответил — полосы нет. Пока идёт ответ про новый кадр, видны теги прежнего (приглушённо): панель не прыгает по высоте
export const TagStrip = ({ game, file, t }) => {
  const [res, setRes] = useState({ file: '', tags: null });
  useEffect(() => {
    const ctl = new AbortController();
    fetch(frameTagsUrl(game.id, file), { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setRes({ file, tags: d.tags || [] }), (e) => { if (e.name !== 'AbortError') setRes({ file, tags: null }); });
    return () => ctl.abort();
  }, [game.id, file]);
  const { tags } = res;
  if (!tags) return null;
  return (
    <div className={`gallery-tags${res.file === file ? '' : ' stale'}`} onClick={(e) => e.stopPropagation()}>
      {tags.length ? tags.slice(0, STRIP).map((x) => (
        <button key={x.tag} type="button" className="chip" onClick={() => searchPictures(x.tag.replace(/_/g, ' '))} data-tip={t.gallery_tag_search}>{tagLabel(t, x.tag)}</button>
      )) : <span className="gallery-tags-none">{t.gallery_tags_none}</span>}
    </div>
  );
};

// Панель «Теги»: поиск, порядок, теги с числом кадров (или сцен). Выбор действует сразу, и числа считаются среди
// отобранного: тег, с которым ничего не останется, в списке не показываем, в пустоту не попасть. Строка — выбрать тег,
// значок справа — «без этого тега». counts и total — готовые числа: галерея считает их сама, окно «Сцены» получает с сервера.
// result — подпись числа на кнопке, none — что сказать, пока тегов нет. На телефоне — лист снизу. Esc, нажатие мимо, «назад»
// и кнопка внизу закрывают. under — панель открыта от кнопки-поля в ряду списков: ровно под ней и той же ширины, как они
export const TagPanel = ({ t, anchor, counts, total, picked, not, onPick, onNot, onReset, result, none: noneText, under = false, onClose }) => {
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const [query, setQuery] = useState('');
  const [byName, setByName] = useState(false);
  const [limit, setLimit] = useState(ROWS_STEP);
  const [place, setPlace] = useState(null);
  const fine = window.matchMedia?.('(pointer: fine)').matches;
  useLayer(rootRef, onClose, { trap: false, focus: fine ? '.tag-panel input' : 'self' });
  // Под кнопкой, по её правому краю; окно прокрутили или поменяли размер — считаем заново
  useLayoutEffect(() => {
    const put = (e) => {
      if (e?.target instanceof Node && rootRef.current?.contains(e.target)) return;
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      // На широком экране у страницы масштаб (--zoom): замер — в точках экрана, а стили панели — в своих
      const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const top = a.bottom / zoom + (under ? 6 : 8);
      const right = Math.max(12, document.documentElement.clientWidth - a.right / zoom);
      const left = a.left / zoom;
      const width = a.width / zoom;
      setPlace((p) => (p && p.top === top && p.right === right && p.left === left && p.width === width ? p : { top, right, left, width }));
    };
    put();
    window.addEventListener('resize', put);
    window.addEventListener('scroll', put, true);
    return () => { window.removeEventListener('resize', put); window.removeEventListener('scroll', put, true); };
  }, [anchor, under]);
  // Нажатие мимо закрывает только панель: следующий за ним click глотаем, иначе открылась бы плитка под ней
  useEffect(() => {
    const down = (e) => {
      if (rootRef.current?.contains(e.target) || anchor.current?.contains(e.target)) return;
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 400);
      onClose();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [anchor, onClose]);
  const rows = useMemo(() => {
    const n = new Map(counts.map((x) => [x.tag, x.n]));
    return [...new Set([...picked, ...not, ...n.keys()])].map((tag) => ({ tag, n: n.get(tag) || 0, name: tagLabel(t, tag), known: t.tag_names?.[tag] ? 1 : 0 }));
  }, [counts, picked, not, t]);
  const none = !rows.length;
  const q = query.trim().toLowerCase();
  // Сначала выбранные и исключённые, потом теги со своим названием на этом языке, потом остальные
  const shown = useMemo(() => {
    const rank = (r) => (picked.includes(r.tag) ? 2 : not.includes(r.tag) ? 1 : 0);
    const collator = new Intl.Collator(t.lang_id);
    return rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.tag.replace(/_/g, ' ').includes(q)).sort((a, b) => rank(b) - rank(a)
      || b.known - a.known || (byName ? 0 : b.n - a.n) || collator.compare(a.name, b.name));
  }, [rows, q, byName, picked, not, t.lang_id]);
  // Выбор тега добавляет «Сбросить» внизу, и места у списка становится меньше
  const chosen = picked.length + not.length;
  useLayoutEffect(() => { if (place) fitRows(listRef.current); }, [place, shown.length, chosen]);
  const more = (e) => {
    const el = e.currentTarget;
    if (limit < shown.length && el.scrollHeight - el.scrollTop - el.clientHeight < 400) setLimit(limit + ROWS_STEP);
  };
  return (
    <>
      <div className="tag-scrim" aria-hidden="true" />
      <div ref={rootRef} className={`tag-panel${under ? ' under' : ''}`} role="dialog" aria-label={t.gallery_tags} tabIndex={-1} onClick={(e) => e.stopPropagation()}
        style={place ? { '--top': `${place.top}px`, '--right': `${place.right}px`, '--left': `${place.left}px`, '--width': `${place.width}px` } : { visibility: 'hidden' }}>
        {!none && <div className="tag-panel-head">
          <SearchBox value={query} onChange={(v) => { setQuery(v); setLimit(ROWS_STEP); }} placeholder={t.gallery_tags_find} clearLabel={t.search_clear} maxLength={60} />
          <div className="tag-sort" role="group" aria-label={t.gallery_tags_sort}>
            <button type="button" className={byName ? '' : 'on'} aria-pressed={!byName} onClick={() => { setByName(false); setLimit(ROWS_STEP); }}>{t.gallery_tags_by_count}</button>
            <button type="button" className={byName ? 'on' : ''} aria-pressed={byName} onClick={() => { setByName(true); setLimit(ROWS_STEP); }}>{t.gallery_tags_by_name}</button>
          </div>
        </div>}
        <div ref={listRef} className="tag-list" onScroll={more}>
          {shown.slice(0, limit).map((r) => {
            const on = picked.includes(r.tag);
            const no = not.includes(r.tag);
            return (
              <div key={r.tag} className={`tag-row${on ? ' on' : ''}${no ? ' no' : ''}`}>
                <button type="button" className="tag-row-main" aria-pressed={on} onClick={() => onPick(r.tag)}>
                  <span className="tag-row-mark" aria-hidden="true">{on && <IconCheck />}</span>
                  <span className="tag-row-name">{r.name}</span>
                  <span className="tag-row-n">{no ? '' : r.n}</span>
                </button>
                <button type="button" className="tag-row-no" aria-pressed={no} aria-label={t.gallery_tags_without(r.name)} data-tip={t.gallery_tags_without(r.name)} onClick={() => onNot(r.tag)}><IconBan /></button>
              </div>
            );
          })}
          {!shown.length && <p className="tag-none">{none ? noneText : t.gallery_tags_missing}</p>}
        </div>
        {!none && <div className="tag-panel-foot">
          {picked.length + not.length > 0 && <button type="button" className="tag-reset" onClick={onReset}>{t.gallery_tags_reset}</button>}
          <button type="button" className="gallery-play tag-apply" onClick={onClose}>{t.gallery_tags_apply(result(total))}</button>
        </div>}
      </div>
    </>
  );
};

// Выбранные теги над сеткой: сколько осталось, у каждого — крестик, «Сбросить». Исключённые можно скрыть насовсем: тогда их не
// будет в поиске по картинкам, «Похожих» и окне «Сцены» (список — в Настройках)
export const TagPicked = ({ t, picked, not, count, hidden, onPick, onNot, onReset, onHidden }) => {
  const [added, setAdded] = useState([]);
  const fresh = not.filter((tag) => !hidden.includes(tag) && !added.includes(tag));
  const hide = () => changeHiddenTags({ add: fresh }).then((tags) => { setAdded(tags); onHidden?.(tags); }, () => {});
  return (
    <div className="tag-picked">
      <span className="tag-picked-n">{count}</span>
      {picked.map((tag) => (
        <button key={tag} type="button" className="chip active tag-picked-chip" onClick={() => onPick(tag)} aria-label={t.gallery_tags_remove(tagLabel(t, tag))}>
          {tagLabel(t, tag)}<IconClose />
        </button>
      ))}
      {not.map((tag) => (
        <button key={tag} type="button" className="chip active tag-picked-chip no" onClick={() => onNot(tag)} aria-label={t.gallery_tags_remove(tagLabel(t, tag))}>
          <IconBan />{tagLabel(t, tag)}<IconClose />
        </button>
      ))}
      <button type="button" className="tag-reset" onClick={onReset}>{t.gallery_tags_reset}</button>
      {/* Список скрытых тегов общий на библиотеку: человеку сервер отвечает отказом */}
      {isOwner() && fresh.length > 0 && <button type="button" className="tag-reset" onClick={hide} data-tip={t.gallery_tags_always_hint}>{t.gallery_tags_always}</button>}
    </div>
  );
};

// Настройки: скрытые теги. Добавляются в галерее (TagPicked), здесь — посмотреть и вернуть
export const HiddenTags = ({ t, Title }) => {
  const [tags, setTags] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/pictures/hidden').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setTags(d.tags || []); }, () => {});
    return () => { alive = false; };
  }, []);
  // Добавляют теги только из галереи, поэтому пустой раздел здесь нечего делать: появится с первым скрытым
  if (!tags?.length) return null;
  return (
    <section className="set-section" data-section="hidden-tags">
      <Title t={t} title={t.hidden_tags_title} hint={t.hidden_tags_hint} />
      <div className="filter-chips fav-chips">
        {tags.map((tag) => (
          <button key={tag} type="button" className="chip active" aria-label={t.gallery_tags_remove(tagLabel(t, tag))} onClick={() => changeHiddenTags({ remove: [tag] }).then(setTags, () => {})}>
            {tagLabel(t, tag)} <IconClose />
          </button>
        ))}
      </div>
    </section>
  );
};
