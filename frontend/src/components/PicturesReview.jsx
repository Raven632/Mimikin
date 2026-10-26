import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../layers';
import { errorText, httpError } from '../apiError';
import { applyPatch, drawLabel, loadFont, loadImage } from '../pictureDraw';
import StateView from './StateView';
import { IconClose } from './icons';

const send = async (url, options = {}) => {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};
const post = (url, body) => send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const FILTERS = ['all', 'review', 'off'];
const needsReview = (l) => l.unsure && !l.checked;

// Экран «Картинки» (сервер: services/pictures.js): что нашлось на картинках игры. Слева — картинки, справа —
// выбранная «как в оригинале» и «с переводом» (рисуется так же, как в игре, — pictureDraw.js) и её подписи:
// показывать ли перевод, текст на картинке (распознанный — поправить), свой перевод. «Обвести подпись» — рамкой
// мышью или пальцем: служба прочитает текст в ней. Подписи, в которых распознавание не уверено, — «проверь»:
// они выключены, пока их не посмотрят
export default function PicturesReview({ game, t, notify, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState('');
  const [after, setAfter] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const base = `/api/games/${encodeURIComponent(game.id)}/pictures`;
  useLayer(rootRef, onClose);

  useEffect(() => {
    let alive = true;
    send(`${base}/review`).then(
      (d) => { if (alive) { setItems(d.items || []); setError(''); } },
      (e) => { if (alive) setError(errorText(t, e)); },
    );
    return () => { alive = false; };
  }, [base, t, reload]);

  const shown = useMemo(() => (items || []).filter((p) => (filter === 'review' ? p.labels.some(needsReview)
    : filter === 'off' ? p.labels.some((l) => !l.on) : true)), [items, filter]);
  const current = shown.find((p) => p.key === selected) || shown[0] || null;

  const save = useCallback(async (picture, label, body) => {
    setBusy(true);
    try {
      await post(`${base}/label`, { sha1: picture.sha1, label: label.id, ...body });
      setReload((n) => n + 1);
    } catch (e) {
      notify(errorText(t, e), 'error');
    } finally {
      setBusy(false);
    }
  }, [base, notify, t]);
  const remove = async (picture, label) => {
    setBusy(true);
    try {
      await post(`${base}/remove`, { sha1: picture.sha1, label: label.id });
      setReload((n) => n + 1);
    } catch (e) {
      notify(errorText(t, e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const addBox = async (box) => {
    if (!current) return;
    setBusy(true);
    try {
      await post(`${base}/box`, { key: current.key, box });
      notify(t.pic_rev_added, 'success');
      setReload((n) => n + 1);
    } catch (e) {
      notify(e.status === 422 ? t.pic_rev_notfound : errorText(t, e), 'error');
    } finally {
      setBusy(false);
      setAdding(false);
    }
  };

  const count = (key) => (items || []).filter((p) => (key === 'review' ? p.labels.some(needsReview)
    : key === 'off' ? p.labels.some((l) => !l.on) : true)).length;

  return createPortal(
    <div ref={rootRef} className="pictures" role="dialog" aria-modal="true" aria-label={t.pic_rev_title} tabIndex={-1}>
      <div className="gallery-head">
        <h2>{t.pic_rev_title} — {game.displayTitle || game.title}</h2>
        <button type="button" className="gallery-close" onClick={onClose} aria-label={t.close} data-tip={t.close}><IconClose /></button>
        <div className="gallery-tabs" role="tablist">
          {FILTERS.map((key) => (
            <button key={key} type="button" role="tab" aria-selected={filter === key} className={`chip${filter === key ? ' active' : ''}`}
              onClick={() => setFilter(key)}>
              {t.pic_rev_filter[key]} <span className="chip-count">{count(key)}</span>
            </button>
          ))}
        </div>
      </div>
      {error && <StateView kind="error" title={error} onRetry={() => { setError(''); setReload((n) => n + 1); }} retryLabel={t.retry} />}
      {!error && !items && <StateView kind="loading" title={t.loading} />}
      {items && !shown.length && <StateView title={t.pic_rev_empty} />}
      {current && (
        <div className="pictures-body">
          <ul className="pictures-list">
            {shown.map((p) => (
              <li key={p.key}>
                <button type="button" className={`pictures-item${p.key === current.key ? ' active' : ''}`} onClick={() => { setSelected(p.key); setAdding(false); }}>
                  <img src={`${base}/image?key=${encodeURIComponent(p.key)}`} alt="" loading="lazy" />
                  <span className="pictures-item-name">{p.key.split('/').pop()}</span>
                  <span className="pictures-item-count">
                    {t.pic_rev_labels(p.labels.filter((l) => l.on).length, p.labels.length)}
                    {p.labels.some(needsReview) && <span className="pic-badge">{t.pic_rev_unsure}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="pictures-main">
            <div className="pictures-tools">
              <div className="tl-langs" role="radiogroup" aria-label={t.pic_rev_title}>
                <button type="button" role="radio" aria-checked={!after} className={`chip${!after ? ' active' : ''}`} onClick={() => setAfter(false)}>{t.pic_rev_before}</button>
                <button type="button" role="radio" aria-checked={after} className={`chip${after ? ' active' : ''}`} onClick={() => setAfter(true)}>{t.pic_rev_after}</button>
              </div>
              <button type="button" className={`meta-status-btn${adding ? '' : ' subtle'}`} disabled={busy} aria-pressed={adding}
                data-tip={t.pic_rev_add_hint} onClick={() => setAdding((v) => !v)}>
                {adding ? t.pic_rev_add_cancel : t.pic_rev_add}
              </button>
            </div>
            {current.bilingual && <p className="tl-note">{t.pic_rev_bilingual}</p>}
            {adding && <p className="tl-note">{t.pic_rev_add_hint}</p>}
            <Preview key={current.key} base={base} picture={current} after={after} adding={adding && !busy} onBox={addBox} />
            <ul className="pictures-labels">
              {current.labels.map((l) => (
                // Текст или перевод поменялись на сервере — поля строки заново, с новыми значениями
                <LabelRow key={`${current.sha1}:${l.id}:${l.text}:${l.translation || ''}`} t={t} label={l} busy={busy}
                  onSave={(body) => save(current, l, body)} onRemove={() => remove(current, l)} />
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// Картинка: оригинал или с переводом, рамки подписей (включённая — золотая, выключенная — пунктир, «проверь» —
// янтарная); в режиме «Обвести подпись» — рамка мышью или пальцем
function Preview({ base, picture, after, adding, onBox }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [img] = await Promise.all([loadImage(`${base}/image?key=${encodeURIComponent(picture.key)}`), loadFont()]);
      const canvas = canvasRef.current;
      if (!alive || !img || !canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      if (after) {
        const todo = picture.labels.filter((l) => l.on && l.translation);
        const patches = await Promise.all(todo.map((l) => (l.patch ? loadImage(`/api/games/pictures/patch/${l.patch}`) : null)));
        if (!alive) return;
        todo.forEach((l, i) => {
          try {
            if (patches[i] && Array.isArray(l.patchBox)) applyPatch(ctx, patches[i], l.patchBox);
            drawLabel(ctx, l, l.translation);
          } catch { /* подпись — как в оригинале */ }
        });
      }
      setReady(true);
    })();
    return () => { alive = false; };
  }, [base, picture, after]);

  // Точка на картинке (в пикселях картинки) по точке на экране
  const at = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [
      Math.round(((e.clientX - r.left) / r.width) * picture.w),
      Math.round(((e.clientY - r.top) / r.height) * picture.h),
    ];
  };
  const down = (e) => {
    if (!adding) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = at(e);
    setDrag({ from: p, to: p });
  };
  const move = (e) => { if (drag) setDrag((d) => ({ ...d, to: at(e) })); };
  const up = () => {
    if (!drag) return;
    const [x0, y0] = drag.from;
    const [x1, y1] = drag.to;
    setDrag(null);
    const box = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    if (box[2] >= 6 && box[3] >= 6) onBox(box);
  };
  const pct = (v, total) => `${(v / total) * 100}%`;
  const rect = (b) => ({ left: pct(b[0], picture.w), top: pct(b[1], picture.h), width: pct(b[2], picture.w), height: pct(b[3], picture.h) });
  const sel = drag && [Math.min(drag.from[0], drag.to[0]), Math.min(drag.from[1], drag.to[1]), Math.abs(drag.to[0] - drag.from[0]), Math.abs(drag.to[1] - drag.from[1])];

  return (
    <div ref={wrapRef} className={`pictures-preview${adding ? ' adding' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)}>
      <canvas ref={canvasRef} className={ready ? '' : 'loading'} />
      {!after && picture.labels.map((l) => (
        <span key={l.id} className={`pictures-box${l.on ? ' on' : ''}${needsReview(l) ? ' review' : ''}`} style={rect([l.x, l.y, l.w, l.h])} />
      ))}
      {sel && <span className="pictures-box drawing" style={rect(sel)} />}
    </div>
  );
}

// Одна подпись: показывать ли перевод, текст на картинке, свой перевод. Сохраняется, когда поле покинули
function LabelRow({ t, label, busy, onSave, onRemove }) {
  const [text, setText] = useState(label.text);
  const [translation, setTranslation] = useState(label.translation || '');
  const commitText = () => { if (text.trim() && text.trim() !== label.text) onSave({ text: text.trim() }); };
  const commitTl = () => { if (translation.trim() && translation.trim() !== (label.translation || '')) onSave({ translation: translation.trim() }); };
  const enter = (e) => { if (e.key === 'Enter') e.currentTarget.blur(); };
  return (
    <li className={`pictures-label${label.on ? '' : ' off'}`}>
      <input type="checkbox" className="sq-check pictures-label-on" checked={!!label.on} disabled={busy} aria-label={t.pic_rev_on} data-tip={t.pic_rev_on}
        onChange={(e) => onSave({ on: e.target.checked })} />
      <input className="pictures-input pictures-src" lang="ja" value={text} disabled={busy} aria-label={t.pic_rev_text}
        onChange={(e) => setText(e.target.value)} onBlur={commitText} onKeyDown={enter} />
      <input className="pictures-input pictures-tl" value={translation} disabled={busy} aria-label={t.pic_rev_tl}
        placeholder={t.pic_rev_tl_none} onChange={(e) => setTranslation(e.target.value)} onBlur={commitTl} onKeyDown={enter} />
      <span className="pictures-label-tags">
        {needsReview(label) && <span className="pic-badge" data-tip={t.pic_rev_unsure_hint}>{t.pic_rev_unsure}</span>}
        {needsReview(label) && (
          <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={() => onSave({ on: true })}>{t.pic_rev_ok}</button>
        )}
        <button type="button" className="meta-status-btn subtle" disabled={busy} onClick={onRemove}>{t.pic_rev_remove}</button>
      </span>
    </li>
  );
}
