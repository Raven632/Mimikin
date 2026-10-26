import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OPEN, HALF, SHUT } from '../brandGrid';
import { useCrispSide } from '../crispSize';
import { IconChevronDown, IconChevronUp, IconClose, IconHourglass, IconLock, IconPause, IconPlus, IconCheck } from './icons';
import { ACTIVE, STEPS, forgetJob, jdLine, jdShare, retryJob, stepOf, useJdJobs } from '../jdJobs';
import { useLayer } from '../layers';
import { fmtOf } from '../transferSize';
import { useOtherMimic } from '../mimicMood';

// Плашка загрузок у нижнего края: архив с компьютера или телефона, недогруженное, очередь, JDownloader.
// Здесь только показ. Что отменять, кого спрашивать и когда начинать следующего — решает Toolbar.jsx,
// сюда приходят готовые строки (item) и действия. Свёрнутая плашка — одна строка высотой 69 точек:
// страница под ней просто кончается раньше. Раскрытая — панель того же края, без скруглений и «ручки»

// Клетки мимика: заполняются снизу вверх по мере хода, как в знаке в шапке (BrandMark.jsx). Три кадра
// (brandGrid.js) лежат в одном svg слоями, а какой виден — решает CSS (transfer.css): без таймеров в JS
const cellsOf = (grid) => grid.flatMap((row, y) => [...row].flatMap((c, x) => (c === '#' || c === 'o' ? [{ x, y, eye: c === 'o' }] : [])));
const FRAMES = [['open', cellsOf(OPEN)], ['half', cellsOf(HALF)], ['shut', cellsOf(SHUT)]];

// mode: wait — передача, глаз нет; still — глаза открыты, стоит (ждёт пароля, ошибка); chew — распаковка, жуёт;
// done — «В библиотеке»: открыт, прикрыл, захлопнул (захлопнутая крышка значит только «готово»).
// 32 точки, но по правилу целых клеток и не больше 38: внутри рамки 40 с каймой
const Mimic = ({ lit, mode }) => {
  const side = useCrispSide(32, 38);
  // Мимик плашки на экране — мимик в шапке молчит
  useOtherMimic(true);
  return (
    <svg className={`tb-mimic ${mode}`} style={{ width: side, height: side }} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {FRAMES.map(([key, cells]) => (
        <g key={key} className={`f-${key}`}>
          {cells.map(({ x, y, eye }) => <rect key={`${x}-${y}`} className={eye && mode !== 'wait' ? 'eye' : y >= 15 - lit ? 'on' : 'off'} x={x} y={y} width="1" height="1" />)}
        </g>
      ))}
    </svg>
  );
};

// Три отрезка пути: передача, распаковка, в библиотеке. Пройденные залиты, текущий горит с кромкой.
// Распаковка меры не имеет — её отрезок просто горит, а «жуёт» мимик
const Segments = ({ stage, frac, bad, labels, t }) => (
  <>
    <div className={`tb-seg${labels ? ' big' : ''}${bad ? ' bad' : ''}`} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i}>
          {i < stage || (i === stage && stage > 0) ? <i className={i === stage && stage === 1 ? 'run' : ''} style={{ width: '100%' }} />
            : i === stage ? <i className="cur" style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }} /> : null}
        </span>
      ))}
    </div>
    {labels && (
      <div className="tb-seg-labels" aria-hidden="true">
        {t.tb_stage.map((w, i) => <span key={w} className={i === stage ? 'cur' : ''}>{w}</span>)}
      </div>
    )}
  </>
);

// Жуёт только пока работает: ждёт пароля или встала с ошибкой — глаза открыты, но не двигается
const mimicMode = (item) => (item.stage === 2 ? 'done' : item.stage === 1 ? (item.bad || item.ask === 'password' ? 'still' : 'chew') : 'wait');

const Pct = ({ value, dim }) => <span className={`tb-pct${dim ? ' dim' : ''}`}>{value}<small>%</small></span>;

// Имя файла режется в середине: многоточие встаёт перед расширением («…_Moon.…» читалось как четыре точки),
// а расширение остаётся на виду
const ARCHIVE_EXT = /\.(zip|rar|7z|r\d\d|z\d\d|\d{3})$/i;
const Name = ({ text, className }) => {
  const m = ARCHIVE_EXT.exec(text || '');
  if (!m || !m.index) return <span className={className} data-tip={text}>{text}</span>;
  return (
    <span className={`${className} tb-fn`} data-tip={text}>
      <span className="tb-fn-stem">{text.slice(0, m.index)}</span>
      <span className="tb-fn-ext">{m[0]}</span>
    </span>
  );
};

const ICONS = { password: IconLock, left: IconPause, wait: IconHourglass, bad: IconClose };

// Короткая причина остановки: полный текст с путём по настройкам остаётся в окне игры (JdProgress.jsx)
const jdBad = (job, t) => {
  const B = t.tb_jd_bad;
  if (job.error === 'account') return B[job.account] || B.failed;
  return B[job.error] || t.jd_error(job.error);
};

// Скорость и остаток у скачивания JDownloader: справа от «640 из 1500 МБ»
const jdRight = (job, t) => {
  if (job.stage !== 'download' || !job.total) return '';
  const speed = job.speed ? `${(job.speed / 1048576).toLocaleString(t.lang_id, { maximumFractionDigits: 1 })} ${t.tb_unit.mb}/${t.tb_unit.s}` : '';
  const eta = job.eta ? t.tb_eta(Math.ceil(job.eta / 60)) : '';
  return [speed, eta].filter(Boolean).join(', ');
};

// Задача JDownloader как строка плашки: этапы сервера (ссылки, скачивание, перенос, распаковка) сводятся к трём отрезкам
const jdItem = (job, t) => {
  const step = stepOf(job);
  const bad = job.stage === 'error' || job.stage === 'captcha';
  const done = job.stage === 'done';
  const text = job.stage === 'download' && job.total ? fmtOf(job.loaded, job.total, t)
    : done ? '' : job.stage === 'error' ? jdBad(job, t) : jdLine(job, t);
  return {
    key: `jd-${job.key}`, name: job.title, stage: done || step >= 4 ? 2 : step < 3 ? 0 : 1, frac: jdShare(job),
    word: done ? t.tb_stage[2] : t.jd_step[STEPS[step]], text, right: jdRight(job, t), bad, ask: null,
    pct: job.stage === 'download' && job.total ? Math.round(jdShare(job) * 100) : null,
  };
};

// Сколько держать плашку после того, как задача JDownloader закончилась: хватит увидеть «в библиотеке» и нажать «Открыть игру»
const HOLD_MS = 30000;

export default function TransferBar({ t, current, pending, queue, onAdd, onOpenGame }) {
  const jobs = useJdJobs();
  const [open, setOpen] = useState(false);
  const [retryError, setRetryError] = useState({});   // thread → почему не повторилось
  const rowRef = useRef(null);
  const panelRef = useRef(null);
  const scrollRef = useRef(null);
  const swipe = useRef(null);

  // Закончившаяся задача JDownloader держит плашку HOLD_MS: на телефоне кольца в шапке нет, и без этого
  // «Открыть игру» было бы негде нажать. Давно готовые (с прошлых сеансов) плашку не открывают
  const [held, setHeld] = useState({});   // thread → держим
  const seen = useRef({});                // thread → этап при прошлом опросе
  useEffect(() => {
    const fresh = jobs.filter((j) => j.stage === 'done' && seen.current[j.key] && seen.current[j.key] !== 'done');
    for (const j of jobs) seen.current[j.key] = j.stage;
    if (!fresh.length) return undefined;
    setHeld((h) => ({ ...h, ...Object.fromEntries(fresh.map((j) => [j.key, true])) }));
    const timer = setTimeout(() => setHeld((h) => Object.fromEntries(Object.entries(h).filter(([k]) => !fresh.some((j) => j.key === k)))), HOLD_MS);
    return () => clearTimeout(timer);
  }, [jobs]);
  // Идущая, ждущая капчу и вставшая — держат; готовая — только недавняя. Идущие впереди готовых
  const liveJobs = [...jobs.filter((j) => j.stage !== 'done'), ...jobs.filter((j) => j.stage === 'done' && held[j.key])];
  const uploads = [...(current ? [current] : []), ...pending];
  const total = uploads.length + queue.length + liveJobs.length;
  const lead = uploads[0] || (liveJobs[0] ? jdItem(liveJobs[0], t) : null);
  const shown = total > 0 && lead;

  // Пока плашка есть, у страницы внизу отступ, а тосты поднимаются над ней (controls.css, transfer.css)
  useEffect(() => {
    document.documentElement.classList.toggle('has-transfer', !!shown);
    return () => document.documentElement.classList.remove('has-transfer');
  }, [shown]);
  // Всё ушло — плашка исчезла; следующая загрузка не должна появиться сразу раскрытой
  if (!shown && open) setOpen(false);

  const close = () => { setOpen(false); rowRef.current?.focus(); };
  // Раскрытая панель — слой, как окна: Escape закрывает верхний, а не всё сразу; Tab не уходит на страницу под ней;
  // «назад» на телефоне сворачивает панель, а не уводит со страницы
  useLayer(panelRef, close, { active: open && !!shown, focus: '.tb-ib' });

  // Загрузка встала на пароле — раскрываем сами: иначе распаковка стоит, пока не догадаются раскрыть плашку
  const askingNow = current?.ask === 'password';
  const wasAsking = useRef(false);
  useEffect(() => {
    if (askingNow && !wasAsking.current) setOpen(true);
    wasAsking.current = askingNow;
  }, [askingNow]);

  if (!shown) return null;

  const others = total - 1;
  // В заголовке — всё, что есть в панели, и готовые задачи JDownloader тоже
  const listed = uploads.length + queue.length + jobs.length;
  const asks = (kind) => uploads.filter((u) => u.ask === kind).length;
  const bads = uploads.filter((u) => u.bad).length + liveJobs.filter((j) => j.stage === 'error' || j.stage === 'captcha').length;
  // Что ждёт ответа — по важности: пароль, ошибка, недогруженное; что не влезло, срежет многоточие
  const notes = [asks('password') && t.tb_pw(asks('password')), bads && t.tb_bad(bads), asks('left') && t.tb_left(asks('left'))].filter(Boolean);

  const touchStart = (e) => { swipe.current = { y: e.touches[0].clientY, top: scrollRef.current?.scrollTop ?? 0 }; };
  // Свайп вверх по строке раскрывает, вниз по панели (когда она прокручена к началу) — сворачивает
  const touchEnd = (e, openIt) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dy = e.changedTouches[0].clientY - s.y;
    if (openIt && dy < -24) setOpen(true);
    if (!openIt && dy > 60 && s.top === 0) setOpen(false);
  };
  const pctOf = (item) => (item.pct == null ? null : item.pct);
  const leadPct = pctOf(lead);

  const sub = others > 0 ? (
    <span>{t.tb_more(others)}{notes.length > 0 && <>, <em>{notes.join(', ')}</em></>}</span>
  ) : lead.ask === 'password' ? (
    <><b>{lead.word}</b><em>{t.tb_pw_short}</em></>
  ) : (
    <>{lead.word && <b>{lead.word}</b>}<span className={lead.bad ? 'bad' : ''}>{lead.short ?? lead.text}</span></>
  );

  // Строка «что ждёт ответа»: значок, имя, что с ней, «Продолжить» и убрать. Пароль — полем под ней.
  // Не компонентом: иначе каждый опрос пересоздавал бы строку, и набранный пароль пропадал бы
  const row = (item) => {
    const Icon = ICONS[item.bad ? 'bad' : item.ask || 'wait'];
    return (
      <div className="tb-ask" key={item.key}>
        <div className="tb-item">
          <span className="tb-item-ico"><Icon /></span>
          <div className="tb-item-text">
            <Name className="tb-item-name" text={item.name} />
            <div className={`tb-item-state${item.ask === 'password' || item.bad ? ' warn' : ''}${item.bad ? ' bad' : ''}`}>{item.text}</div>
          </div>
          {item.onPick && <button type="button" className="tb-pill" onClick={item.onPick}>{t.up_pick}</button>}
          {item.onStop && <button type="button" className="tb-x" onClick={item.onStop} data-tip={item.stopTitle} aria-label={item.stopTitle}><IconClose /></button>}
        </div>
        {item.extra}
      </div>
    );
  };

  const jdWord = (job) => (ACTIVE.includes(job.stage) ? t.jd_step[STEPS[stepOf(job)]] : '');

  const bar = (
    <div className={`tb${lead.leaving ? ' leaving' : ''}`} data-state="closed" onTouchStart={touchStart} onTouchEnd={(e) => touchEnd(e, true)}>
      <Segments stage={lead.stage} frac={lead.frac} bad={lead.bad} t={t} />
      <button type="button" className="tb-row" ref={rowRef} aria-expanded="false" aria-label={t.tb_expand} onClick={() => setOpen(true)}>
        <span className="tb-thumb"><Mimic lit={lead.stage > 0 ? 15 : Math.round(Math.max(0, Math.min(1, lead.frac)) * 15)} mode={mimicMode(lead)} /></span>
        <span className="tb-text">
          <Name className="tb-name" text={lead.name} />
          <span className="tb-sub" role="status">{sub}</span>
        </span>
        {leadPct != null ? <Pct value={leadPct} dim={lead.stage > 0} /> : lead.stage === 2 ? <span className="tb-done"><IconCheck /></span> : null}
        <span className="tb-chev"><IconChevronUp /></span>
      </button>
    </div>
  );

  const rest = uploads.slice(1);
  const panel = (
    <div className={`tb open${lead.leaving ? ' leaving' : ''}`} data-state="open" role="dialog" ref={panelRef} aria-label={t.tb_title} onTouchStart={touchStart} onTouchEnd={(e) => touchEnd(e, false)}>
      <div className="tb-scroll" ref={scrollRef}>
        <div className="tb-head">
          <span className="tb-title">{t.tb_title}</span>
          {listed > 1 && <span className="tb-count">{listed}</span>}
          <button type="button" className="tb-ib" onClick={close} aria-label={t.tb_collapse} data-tip={t.tb_collapse}><IconChevronDown /></button>
        </div>

        {uploads[0] && (
          <section className="tb-now">
            <div className="tb-now-top">
              <Name className="tb-now-name" text={lead.name} />
              {leadPct != null ? <Pct value={leadPct} dim={lead.stage > 0} /> : lead.stage === 2 ? <span className="tb-done"><IconCheck /></span> : null}
            </div>
            <div className={`tb-nums${lead.bad ? ' bad' : ''}`}><span>{lead.text}</span>{(lead.eta || lead.right) && <span>{lead.eta || lead.right}</span>}</div>
            <Segments stage={lead.stage} frac={lead.frac} bad={lead.bad} labels t={t} />
            {lead.extra}
            <div className="tb-actions">
              {lead.onPick && <button type="button" className="tb-pill" onClick={lead.onPick}>{t.up_pick}</button>}
              <button type="button" className="tb-pill" onClick={onAdd}><IconPlus />{t.tb_add}</button>
              {lead.onStop && <button type="button" className="tb-text-btn" onClick={lead.onStop} data-tip={lead.stopTitle} aria-label={lead.stopTitle}>{lead.stopLabel}</button>}
            </div>
          </section>
        )}

        {rest.length > 0 && (
          <div className="tb-group">
            {rest.map(row)}
          </div>
        )}
        {uploads.some((u) => u.onPick) && <p className="tb-hint">{t.up_pick_hint}</p>}

        {queue.length > 0 && (
          <div className="tb-group tb-queue">
            <div className="tb-sub-title">{t.tb_queue}<b>{queue.length}</b></div>
            <ul>
              {queue.slice(0, 5).map((q) => (
                <li key={q.key}>
                  <Name className="tb-q-name" text={q.name} />
                  <span className="tb-q-size">{q.size}</span>
                  <button type="button" className="tb-x" onClick={q.onRemove} data-tip={t.up_queue_remove} aria-label={t.up_queue_remove}><IconClose /></button>
                </li>
              ))}
            </ul>
            {queue.length > 5 && <div className="tb-more">{t.up_queue_more(queue.length - 5)}</div>}
          </div>
        )}

        {jobs.length > 0 && (
          <div className="tb-group tb-jd-list">
            <div className="tb-sub-title">{t.tb_jd}</div>
            {jobs.map((job) => {
              const item = jdItem(job, t);
              const ok = job.stage === 'done';
              return (
                <div key={job.key} className="tb-jd">
                  <div className="tb-jd-top">
                    <Name className="tb-jd-name" text={job.title} />
                    {item.pct != null && <span className="tb-jd-pct">{item.pct}<small>%</small></span>}
                    <button type="button" className="tb-x" onClick={() => forgetJob(job.key)} data-tip={t.jd_dismiss} aria-label={t.jd_dismiss}><IconClose /></button>
                  </div>
                  {ACTIVE.includes(job.stage) && <div className="tb-line"><i className={job.stage} style={{ width: job.stage === 'collect' ? '30%' : `${jdShare(job) * 100}%` }} /></div>}
                  <div className={`tb-jd-state${item.bad ? ' bad' : ok ? ' ok' : ''}`}>
                    {(jdWord(job) || ok) && <b>{ok ? t.tb_stage[2] : jdWord(job)}</b>}<span>{item.text}</span>
                    {item.right && <span className="tb-jd-right">{item.right}</span>}
                  </div>
                  {(ok && job.game) || (job.stage === 'error' && job.retry) ? (
                    <div className="tb-jd-acts">
                      {ok && job.game && <button type="button" className="tb-link" onClick={() => { setOpen(false); onOpenGame(job.game); }}>{t.jd_open_game}</button>}
                      {job.stage === 'error' && job.retry && <button type="button" className="tb-link" onClick={async () => {
                        const why = await retryJob(job.key, t);
                        setRetryError((m) => ({ ...m, [job.key]: why }));
                      }}>{t.jd_retry}</button>}
                    </div>
                  ) : null}
                  {job.stage === 'error' && retryError[job.key] && <div className="tb-jd-state bad" role="alert">{retryError[job.key]}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(
    <>
      {open && <div className="tb-scrim" onClick={close} aria-hidden="true" />}
      {open ? panel : bar}
    </>,
    document.body
  );
}
