import { useEffect, useRef, useState } from 'react';
import { ACTIVE, STEPS, forgetJob, jdLine, jdShare, retryJob, stepOf, useJdJobs } from '../jdJobs';
import { IconCheck, IconClose, IconDownload } from './icons';
import MetaLine from './MetaLine';

// Ход загрузки «Загрузить»: шкала этапов в окне игры, значок на обложке в «Новинках», список в шапке.
// Сбор ссылок — без числа: сколько ещё, неизвестно
const Bar = ({ job, label }) => (
  <div className={`jd-bar ${job.stage}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={job.stage === 'collect' ? undefined : Math.round(jdShare(job) * 100)}>
    {/* Сбор ссылок — бегущий отрезок: сколько ещё, не знает и JDownloader */}
    <i style={{ width: job.stage === 'collect' ? '30%' : `${jdShare(job) * 100}%` }} />
  </div>
);

// Окно игры: пять шагов, полоса и строка, что сейчас
export function JdSteps({ job, t, onOpenGame }) {
  const now = stepOf(job);
  const bad = job.stage === 'error' || job.stage === 'captcha';
  return (
    <div className="jd-steps-box">
      <ol className="jd-steps">
        {STEPS.map((key, i) => (
          <li key={key} className={i < now || job.stage === 'done' ? 'done' : i === now ? (bad ? 'bad' : 'now') : ''}>
            <span className="jd-dot" aria-hidden="true">{i < now || job.stage === 'done' ? <IconCheck /> : bad && i === now ? '!' : ''}</span>
            {t.jd_step[key]}
          </li>
        ))}
      </ol>
      {!bad && job.stage !== 'done' && <Bar job={job} label={t.jd_step[STEPS[now]]} />}
      {job.target && job.stage !== 'done' && job.stage !== 'error' && <p className="jd-target">{t.jd_as_update}</p>}
      <p className={`jd-line${bad ? ' bad' : job.stage === 'done' ? ' ok' : ''}`}>
        {job.file && <span className="jd-file">{job.file}</span>}
        {jdLine(job, t)}
        {job.stage === 'done' && job.game && <button type="button" className="jd-open" onClick={() => onOpenGame(job.game)}>{t.jd_open_game}</button>}
      </p>
    </div>
  );
}

// Шапка: значок с кольцом хода (виден, пока в списке есть загрузки) и список по щелчку
export function JdDownloads({ t, onOpenGame }) {
  const jobs = useJdJobs();
  const [open, setOpen] = useState(false);
  const [retryError, setRetryError] = useState({});   // thread → почему не повторилось
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!jobs.length) return null;
  const going = jobs.filter((j) => ACTIVE.includes(j.stage));
  const share = going.length ? going.reduce((s, j) => s + jdShare(j), 0) / going.length : 1;
  const alarm = jobs.some((j) => j.stage === 'error' || j.stage === 'captcha');
  return (
    <div className="jd-menu" ref={ref}>
      <button type="button" className={`jd-ring${going.length ? ' going' : ''}${alarm ? ' bad' : ''}`} style={{ '--share': share }}
        aria-expanded={open} aria-label={t.jd_list_title} data-tip={t.jd_list_title} onClick={() => setOpen((v) => !v)}>
        <span><IconDownload />{going.length > 0 && <b>{going.length}</b>}</span>
      </button>
      {open && (
        <div className="jd-list" role="dialog" aria-label={t.jd_list_title}>
          <p className="jd-list-title">{t.jd_list_title}</p>
          {jobs.map((job) => (
            <div key={job.key} className="jd-item">
              <div className="jd-item-head">
                <b>{job.title}</b>
                {/* Убрать можно и идущую: зависла (пакет удалили в JDownloader, архив не дошёл) — иначе висела бы сутками */}
                <button type="button" className="jd-forget" data-tip={t.jd_dismiss} aria-label={t.jd_dismiss} onClick={() => forgetJob(job.key)}><IconClose /></button>
              </div>
              <small className={job.stage === 'error' || job.stage === 'captcha' ? 'bad' : job.stage === 'done' ? 'ok' : ''}>
                {/* Этап словом — пока идёт; готово и ошибка говорят сами за себя */}
                <MetaLine parts={[
                  ACTIVE.includes(job.stage) && t.jd_step[STEPS[stepOf(job)]],
                  jdLine(job, t),
                  job.stage === 'done' && job.game && <button key="open" type="button" className="jd-open" onClick={() => { setOpen(false); onOpenGame(job.game); }}>{t.jd_open_game}</button>,
                  /* Встала — повторить то же, не ища игру заново (записи старше этой версии адреса не помнят) */
                  job.stage === 'error' && job.retry && <button key="retry" type="button" className="jd-open" onClick={async () => {
                    const why = await retryJob(job.key, t);
                    setRetryError((m) => ({ ...m, [job.key]: why }));
                  }}>{t.jd_retry}</button>,
                ]} />
              </small>
              {job.stage === 'error' && retryError[job.key] && <small className="bad" role="alert">{retryError[job.key]}</small>}
              {ACTIVE.includes(job.stage) && <Bar job={job} label={job.title} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
