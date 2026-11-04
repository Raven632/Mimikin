import { useSyncExternalStore } from 'react';
import { errorText, httpError, reasonText, serverWords } from './apiError';
import { fmtSize } from './transferSize';

// Ход загрузок «Загрузить» (api/src/services/myjd.js): один опрос на всю страницу — его читают шкала в окне игры,
// значки на обложках «Найти» и список в шапке. Пока что-то идёт — раз в 4 с, иначе раз в минуту: загрузку могли
// начать с другого устройства
const ACTIVE_MS = 4000;
const IDLE_MS = 60000;
export const ACTIVE = ['collect', 'download', 'transfer', 'import'];
// Капчу сервер ждёт до 10 минут: всё это время загрузка ещё идёт — опрос частый (решили — шкала двинется сразу),
// а «Загрузить» второй раз не нажать
export const BUSY = [...ACTIVE, 'captcha'];

let jobs = [];
let timer = null;
let turn = 0;
// Без входа сервер отвечает 401 — страница входа и первого запуска стучалась бы раз в минуту. Опрос включает App.jsx
let signedIn = false;
const subs = new Set();

// turn — номер опроса: запрос, обогнанный более новым, не ставит свой таймер и не затирает ответ поновее
export async function refreshJobs() {
  clearTimeout(timer);
  const mine = ++turn;
  if (!signedIn) return;
  let next = null;
  try {
    const res = await fetch('/api/downloads');
    if (res.ok) next = await res.json();
  } catch { /* сеть пропала — покажем прежнее */ }
  if (mine !== turn) return;
  // Тот же список — тот же массив: «Найти» не перерисовываются каждые 4 с зря
  if (next && JSON.stringify(next) !== JSON.stringify(jobs)) { jobs = next; subs.forEach((f) => f()); }
  if (subs.size) timer = setTimeout(refreshJobs, jobs.some((j) => BUSY.includes(j.stage)) ? ACTIVE_MS : IDLE_MS);
}

export function pollJobs(on) {
  signedIn = on;
  if (on) { if (subs.size) refreshJobs(); return; }
  clearTimeout(timer);
  turn++;
  if (jobs.length) { jobs = []; subs.forEach((f) => f()); }
}

function subscribe(f) {
  subs.add(f);
  if (subs.size === 1) refreshJobs();
  return () => { subs.delete(f); if (!subs.size) clearTimeout(timer); };
}

export const useJdJobs = () => useSyncExternalStore(subscribe, () => jobs);

// Почему «Загрузить» не взялось: ответ сервера на POST /api/downloads. Код — словами на языке человека; без кода
// русский текст сервера остаётся только в русском интерфейсе
export function jdRefused(t, d, status) {
  if (d.reason === 'off') return t.jd_off;
  if (d.reason === 'site') return t.jd_bad_link;
  return reasonText(t, d) || t.jd_error(serverWords(t, d.error, '') || status);
}

// «Повторить» у вставшей: '' — ушла, иначе что не так. force — «Скачать всё равно» у вставшей из-за места
export async function retryJob(key, t, { force = false } = {}) {
  let text = '';
  try {
    const res = await fetch(`/api/downloads/${encodeURIComponent(key)}/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(force ? { force: true } : {}),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) text = d.reason === 'off' ? t.jd_off : errorText(t, httpError(res, d), { fallback: t.jd_error(res.status) });
  } catch {
    text = t.err_net;
  }
  refreshJobs();
  return text;
}

export async function forgetJob(key) {
  await fetch(`/api/downloads/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {});
  refreshJobs();
}

const mb = (b) => Math.round((b || 0) / 1048576);
const sizesOf = (job, t) => [fmtSize(job.need || 0, t), fmtSize(job.free || 0, t)];

// Доля для полосы: байты — только на скачивании; перенос и распаковка — полоса целиком, но приглушённая
export const jdShare = (job) => (['download', 'transfer'].includes(job.stage) && job.total ? job.loaded / job.total : job.stage === 'download' ? 0 : ['transfer', 'import', 'done'].includes(job.stage) ? 1 : 0);

export function jdLine(job, t) {
  switch (job.stage) {
    case 'collect': return t.jd_now_collect;
    case 'captcha': return t.jd_captcha(job.captcha);
    case 'download': return job.total
      ? t.jd_now_download(mb(job.loaded), mb(job.total), job.speed ? (job.speed / 1048576).toFixed(1) : '', job.eta ? Math.ceil(job.eta / 60) : 0)
      : t.jd_now_download_start;
    // Байты переноса — когда архив забирает сам Mimikin (seedbox в «Настройках»), а не rclone
    // Seedbox или вторая установка не забирают архив: на диске нет места
    case 'transfer': return job.total ? t.jd_now_transfer_bytes(mb(job.loaded), mb(job.total)) : job.space ? t.jd_now_transfer_space(...sizesOf(job, t))
      : job.stuck ? t.jd_now_transfer_stuck : t.jd_now_transfer;
    case 'import': return job.step === 'settle' ? t.jd_now_settle : job.step === 'queued' ? t.jd_now_queued : t.jd_now_import;
    case 'done': return t.jd_now_done;
    default: return job.error === 'space' ? (job.unpack ? t.jd_now_space_unpack : job.hard ? t.jd_now_space_hard : t.jd_now_space)(...sizesOf(job, t))
      : job.error === 'stale' ? t.jd_now_stale
      : job.error === 'volumes' ? t.jd_now_volumes
      : job.error === 'captcha' ? t.jd_now_captcha_late : job.error === 'empty' ? t.jd_empty : job.error === 'none' ? t.jd_none_pc : job.error === 'password' ? t.jd_now_password : reasonText(t, job) || t.jd_error(serverWords(t, job.error));
  }
}

// Коротко — для значка на обложке
export function jdChip(job, t) {
  if (job.stage === 'download') return t.jd_chip.download(Math.floor(jdShare(job) * 100));
  return t.jd_chip[job.stage] ?? t.jd_chip.error;
}

// Этапы — как у сервера (api/src/services/myjd.js); капча — на сборе ссылок, ошибка — там, где встало
export const STEPS = ['collect', 'download', 'transfer', 'import', 'done'];
// Ошибка с файлом — у библиотеки (распаковка), без файла — ещё на сборе ссылок
// Не хватило места до скачивания — встала на скачивании, а не на сборе ссылок
export const stepOf = (job) => (job.stage === 'captcha' ? 0 : job.stage === 'error' ? (job.file ? 3 : job.error === 'space' ? 1 : 0) : STEPS.indexOf(job.stage));
