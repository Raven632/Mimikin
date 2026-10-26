import { useEffect, useId, useRef, useState } from 'react';
import { getCoverUrl } from '../coverUrl';
import { languageLine } from '../formatLanguage';
import { useLayer } from '../layers';
import { confirmDialog } from '../confirm';
import { errorText, httpError } from '../apiError';
import { splitLinks, parseLinkInput, linkIcon, siteName, describeLink } from '../gameLinks';
import { IconClose, IconLink, IconUpload } from './icons';

// Правка сведений об игре — в рамке её окна. Устроена как формы «Настроек» и входа: разделы
// с заголовками, подпись над полем, пояснение под ним (подсказка внутри поля пропадала, стоило
// начать печатать). Кнопки внизу окна закреплены и видны при любой прокрутке: «Отмена» слева,
// «Сохранить» справа — как в окне подтверждения. Всё изменённое, обложка тоже, применяется только
// по «Сохранить». Закрыть правку с изменениями — сначала ответить, не жалко ли их
const FIELDS = ['title', 'developer', 'releaseDate', 'myVersion', 'language'];

const Field = ({ id, label, hint, error, wide, children }) => (
  <div className={`auth-field edit-field${wide ? ' wide' : ''}`}>
    <label className="auth-label" htmlFor={id}>{label}</label>
    {children}
    {error
      ? <span className="edit-error" id={`${id}-hint`} role="alert">{error}</span>
      : hint && <span className="auth-hint" id={`${id}-hint`}>{hint}</span>}
  </div>
);

async function send(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw httpError(res, data);
  return data;
}

const GameEdit = ({ game, index, roman, contentRef, dirtyRef, t, lang, notify, onUpdateGame, onDone }) => {
  const uid = useId();
  const id = (name) => `${uid}-${name}`;
  // Как было до правки — с этим и сравниваем. Снимок один: пока окно открыто, игра может обновиться
  // с сервера, и сравнение с ней сочло бы правкой чужое изменение
  const [initial] = useState(() => ({
    title: game.title || '', developer: game.developer || '', releaseDate: game.releaseDate || '',
    myVersion: game.myVersion || '', language: game.language || '', links: splitLinks(game.link),
  }));
  const [fields, setFields] = useState(() => Object.fromEntries(FIELDS.map((k) => [k, initial[k]])));
  const change = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));
  const [links, setLinks] = useState(initial.links);
  const [draft, setDraft] = useState('');
  const [linkError, setLinkError] = useState('');
  const linkInput = useRef(null);
  // Обложка: null — прежняя; { file, url } — выбранный файл; { reset, url } — вернуть найденную
  const [cover, setCover] = useState(null);
  const coverInput = useRef(null);
  const [saving, setSaving] = useState(false);

  const fieldsChanged = FIELDS.some((k) => fields[k] !== initial[k]);
  const linksChanged = links.join(',') !== initial.links.join(',');
  const dirty = fieldsChanged || linksChanged || !!cover || !!draft.trim();
  // Окно игры спрашивает о том же, когда его закрывают крестиком или кликом мимо
  useEffect(() => { dirtyRef.current = dirty; }, [dirty, dirtyRef]);
  useEffect(() => () => { dirtyRef.current = false; }, [dirtyRef]);
  // Форма высокая, и текст ошибки под полем ссылки уходит под нижнюю панель окна: подводим его в видимую часть
  useEffect(() => {
    if (linkError) linkInput.current?.closest('.edit-field')?.querySelector('.edit-error')?.scrollIntoView({ block: 'nearest' });
  }, [linkError]);
  // Адрес выбранного файла живёт, пока файл выбран
  useEffect(() => () => { if (cover?.file) URL.revokeObjectURL(cover.url); }, [cover]);

  const name = game.displayTitle || game.title;
  // «Отмена», Escape и жест «назад». Терять нечего — сразу; иначе спросить, и если человек
  // вернулся к правке после «назад», слой просит себе запись в истории обратно (keepOpen)
  const cancel = async (keepOpen) => {
    const leave = !saving && (!dirty || await confirmDialog({
      title: t.edit_discard_title, name, text: t.edit_discard_text,
      confirmLabel: t.edit_discard, cancelLabel: t.edit_keep, danger: true,
    }));
    if (leave) onDone();
    else keepOpen?.();
  };
  // Фокус — на форму, а не в первое поле: на телефоне сразу выскочила бы клавиатура
  useLayer(contentRef, cancel, { focus: '.edit-form' });

  const addLinks = (urls) => {
    const fresh = urls.filter((u) => !links.includes(u));
    if (!fresh.length) { setLinkError(t.edit_link_dup); return false; }
    setLinks((prev) => [...prev, ...fresh]);
    setLinkError('');
    return true;
  };
  const addDraft = () => {
    if (!draft.trim()) { linkInput.current?.focus(); return; }
    const parsed = parseLinkInput(draft);
    if (!parsed) { setLinkError(t.edit_link_bad); return; }
    if (addLinks(parsed)) setDraft('');
  };

  const pickCover = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { notify(t.cover_not_image, 'error'); return; }
    setCover({ file, url: URL.createObjectURL(file) });
  };
  // Какая обложка вернётся, видно сразу — а вернётся она по «Сохранить»
  const resetCover = async () => {
    try {
      const data = await send(`/api/games/${encodeURIComponent(game.id)}/cover/found`);
      setCover({ reset: true, url: data.coverPath ? getCoverUrl({ cover: data.coverPath }, 720) : '' });
    } catch (e) {
      notify(errorText(t, e), 'error');
    }
  };
  const custom = /cover_custom/.test(game.cover || '');
  const coverSrc = cover ? cover.url : getCoverUrl(game, 720);
  const coverNote = cover?.reset ? (cover.url ? t.cover_will_reset : t.cover_none_found)
    : cover ? t.cover_will_change : t.cover_hint;

  const save = async (e) => {
    e.preventDefault();
    if (saving) return;
    // Ссылку вписали, а «Добавить» не нажали — частая история. Забираем её сами
    const pending = draft.trim() ? parseLinkInput(draft) : [];
    if (pending === null) { setLinkError(t.edit_link_bad); linkInput.current?.focus(); return; }
    const linkStr = [...links, ...pending.filter((u) => !links.includes(u))].join(',');
    const askedToSearch = linkStr !== initial.links.join(',');
    // Ничего не поменяли — и спрашивать сервер не о чем: «Сохранить» запускает поиск данных
    if (!fieldsChanged && !askedToSearch && !cover) { onDone(); return; }

    setSaving(true);
    const base = `/api/games/${encodeURIComponent(game.id)}`;
    let next = game;
    try {
      if (cover) {
        let data;
        if (cover.file) {
          const form = new FormData();
          form.append('cover', cover.file);
          data = await send(`${base}/cover`, { method: 'POST', body: form });
        } else {
          data = await send(`${base}/cover`, { method: 'DELETE' });
        }
        next = { ...next, cover: data.coverPath };
        // Обложка уже на сервере: если поля дальше не сохранятся, отменять её нечем
        onUpdateGame(index, next);
        setCover(null);
      }
      if (fieldsChanged || askedToSearch) {
        const data = await send(`${base}/edit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // По списку ссылок сервер и ищет
          body: JSON.stringify({ ...fields, link: linkStr }),
        });
        // Сервер возвращает итог целиком: что человек ввёл, что нашлось и состояние поиска
        next = { ...next, ...(data.game || {}) };
        onUpdateGame(index, next);
        // Поиск по новым ссылкам ничего не дал — данные не тронуты, и человек об этом узнаёт.
        // Молчим, если искать он не просил — просто поправил поле
        if (!data.found && askedToSearch) {
          notify(data.failed?.length ? t.edit_unreachable(data.failed.join(', ')) : t.edit_not_found, 'error');
          onDone();
          return;
        }
      }
      notify(t.saved_ok, 'success');
      onDone();
    } catch (err) {
      notify(errorText(t, err, { fallback: t.save_fail }), 'error');
      setSaving(false);
    }
  };

  const langAuto = languageLine({ ...game, language: '' }, t, lang);
  const hintId = (name) => `${id(name)}-hint`;

  return (
    <>
      <div className="edit-layout">
        <div className="edit-head">
          <h2 id="edit-title" className="stats-title edit-title">{t.edit_title}</h2>
          <p className="edit-game">{name}</p>
        </div>

        {/* Обложка — кнопками, а не «нажмите на картинку»: на телефоне подсказки при наведении нет */}
        <section className="edit-cover" aria-labelledby={id('cover')}>
          <h3 className="set-title" id={id('cover')}>{t.edit_section_cover}</h3>
          <div className={`edit-cover-frame${cover ? ' changed' : ''}`}>
            {coverSrc
              ? <img src={coverSrc} alt="" />
              : <div className="cover-placeholder modal-placeholder"><span className="rune">{roman}</span></div>}
          </div>
          <div className="edit-cover-side">
            <div className="edit-cover-actions">
              <button type="button" className="meta-status-btn" onClick={() => coverInput.current?.click()} disabled={saving}>
                <IconUpload />{t.cover_upload}
              </button>
              {cover ? (
                <button type="button" className="meta-status-btn subtle" onClick={() => setCover(null)} disabled={saving}>{t.cover_keep}</button>
              ) : custom && (
                <button type="button" className="meta-status-btn subtle" onClick={resetCover} disabled={saving}>{t.cover_reset}</button>
              )}
            </div>
            <p className="auth-hint" aria-live="polite">{coverNote}</p>
          </div>
          <input ref={coverInput} type="file" accept="image/*" hidden onChange={pickCover} />
        </section>

        {/* Enter в любом поле — «Сохранить», как в любой форме; в поле ссылки — «Добавить» */}
        <form id={id('form')} className="edit-form" tabIndex={-1} onSubmit={save} noValidate>
          <section className="set-section">
            <h3 className="set-title">{t.edit_section_info}</h3>
            <div className="edit-grid">
              <Field id={id('title')} label={t.edit_f_title} wide>
                <input id={id('title')} type="text" value={fields.title} onChange={change('title')} autoComplete="off" />
              </Field>
              <Field id={id('dev')} label={t.edit_f_dev}>
                <input id={id('dev')} type="text" value={fields.developer} onChange={change('developer')} autoComplete="off" />
              </Field>
              <Field id={id('date')} label={t.edit_f_release} hint={t.edit_f_release_hint}>
                <input id={id('date')} type="text" value={fields.releaseDate} onChange={change('releaseDate')} autoComplete="off" aria-describedby={hintId('date')} />
              </Field>
              {/* Пустое поле — версия из названия папки; в пояснении видно, какая нашлась */}
              <Field id={id('version')} label={t.edit_f_myversion}
                hint={!fields.myVersion && game.version ? t.edit_f_myversion_auto(game.version) : t.edit_f_myversion_hint}>
                <input id={id('version')} type="text" value={fields.myVersion} maxLength={40} onChange={change('myVersion')} autoComplete="off" aria-describedby={hintId('version')} />
              </Field>
              {/* Пустое поле — язык по тексту игры; в пояснении видно, какой определился */}
              <Field id={id('lang')} label={t.edit_f_lang} hint={langAuto ? t.edit_f_lang_auto(langAuto) : t.edit_lang_auto_empty}>
                <input id={id('lang')} type="text" value={fields.language} onChange={change('language')} autoComplete="off" aria-describedby={hintId('lang')} />
              </Field>
            </div>
          </section>

          {/* Источники: список ссылок и поле «добавить» — всё про ссылки в одном месте */}
          <section className="set-section">
            <h3 className="set-title">{t.edit_section_sources}</h3>
            <p className="set-hint">{t.edit_sources_hint}</p>

            {links.length > 0 ? (
              <>
                {/* Ведомость: подписи колонок сверху; значок сайта — знак из золота на чёрном, не цветной логотип */}
                <div className="edit-links-head" aria-hidden="true"><span>{t.edit_col_site}</span><span>{t.edit_col_found}</span></div>
                <ul className="edit-links">
                  {links.map((url) => {
                    const info = describeLink(url);
                    const label = info.label ? `${info.host}, ${info.label}` : info.host;
                    return (
                      <li key={url} className="edit-link">
                        <a href={url} target="_blank" rel="noopener noreferrer" className="edit-link-site" data-tip={url}>
                          <span className="edit-link-logo" aria-hidden="true">{linkIcon(url) ? siteName(url).charAt(0).toUpperCase() : <IconLink />}</span>
                          <b>{info.host}</b>
                        </a>
                        <span className="edit-link-found">{info.label}</span>
                        <button type="button" className="edit-link-remove" aria-label={`${t.edit_remove}: ${label}`} data-tip={t.edit_remove}
                          onClick={() => setLinks((prev) => prev.filter((x) => x !== url))}><IconClose /></button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="edit-empty">{t.edit_no_links}</p>
            )}

            <Field id={id('link')} label={t.edit_add_label} hint={t.edit_add_hint} error={linkError}>
              <div className="edit-add">
                <input
                  ref={linkInput} id={id('link')} type="text" inputMode="url" autoComplete="off" spellCheck={false}
                  value={draft} aria-invalid={!!linkError} aria-describedby={hintId('link')}
                  onChange={(e) => { setDraft(e.target.value); setLinkError(''); }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    addDraft();
                  }}
                />
                <button type="button" className="meta-status-btn edit-add-btn" onClick={addDraft}>{t.edit_add}</button>
              </div>
            </Field>

          </section>
        </form>
      </div>

      <div className="edit-footer">
        <button type="button" className="cancel-btn" onClick={() => cancel()} disabled={saving}>{t.cancel}</button>
        <button type="submit" form={id('form')} className="save-btn" disabled={saving}>
          {saving && <span className="auth-spinner" aria-hidden="true" />}{saving ? t.saving : t.save}
        </button>
      </div>
    </>
  );
};

export default GameEdit;
