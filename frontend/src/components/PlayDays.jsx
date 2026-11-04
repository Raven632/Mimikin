import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getCoverUrl } from '../coverUrl';
import { formatPlaytime } from '../formatPlaytime';

const DAY_MS = 86400000;
// Столько дней отдаёт сервер (GET /api/play-days)
const WINDOW = 371;
// Дни — строки с часов сервера. Считаем и подписываем их в UTC: так пояс браузера не сдвинет ни один день
const toMs = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const level = (seconds) => {
  if (!seconds) return '';
  const min = seconds / 60;
  return min < 30 ? ' l1' : min < 90 ? ' l2' : min < 180 ? ' l3' : ' l4';
};
const KEY_STEP = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };

// Раздел статистики: календарь за год. Столбцы — недели, строки с понедельника
const PlayDays = ({ games, t, locale, onOpenGame }) => {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState(null);
  const [cursor, setCursor] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/play-days')
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => { if (alive) setData(d); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  const cal = useMemo(() => {
    if (!data?.since) return null;
    const rows = new Map(data.days.map((d) => [d.day, d.games]));
    const end = toMs(data.today);
    const cells = Array.from({ length: WINDOW }, (_, i) => {
      const day = toDay(end - (WINDOW - 1 - i) * DAY_MS);
      const list = rows.get(day) || [];
      return { day, games: list, seconds: list.reduce((a, g) => a + g.seconds, 0) };
    });
    const played = cells.filter((c) => c.seconds);
    let best = 0;
    let run = 0;
    for (const c of cells) {
      run = c.seconds ? run + 1 : 0;
      best = Math.max(best, run);
    }
    // Пустые места до первого дня, чтобы строки шли с понедельника
    return { cells, played, best, pad: (new Date(toMs(cells[0].day)).getUTCDay() + 6) % 7, total: played.reduce((a, c) => a + c.seconds, 0) };
  }, [data]);

  // Сетка открывается на самой новой неделе: на телефоне начало года никому не нужно первым
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, [cal]);

  const head = <h3 className="stats-section">{t.days_title}</h3>;
  if (failed) return <>{head}<p className="stats-after">{t.days_failed}</p></>;
  if (!data) return head;
  if (!cal) return <>{head}<p className="days-sum">{t.days_empty}</p></>;

  const dateOf = (day, opts = { day: 'numeric', month: 'long', year: 'numeric' }) => new Date(toMs(day)).toLocaleDateString(locale, { ...opts, timeZone: 'UTC' });
  const timeOf = (seconds) => formatPlaytime(seconds, t) || t.days_under_min;
  const label = (c) => `${dateOf(c.day)}: ${c.seconds ? timeOf(c.seconds) : t.days_none}`;
  // Часы в итоге округляем; меньше часа за год написать «0 ч» было бы неправдой
  const totalText = cal.total >= 3600 ? `${Math.round(cal.total / 3600)} ${t.unit_h}` : timeOf(cal.total);

  const focusDay = cursor || data.today;
  const shownDay = picked || cal.played[cal.played.length - 1]?.day || null;
  const shown = shownDay && cal.cells.find((c) => c.day === shownDay);
  const byId = new Map(games.map((g) => [g.id, g]));

  const onKey = (e) => {
    const step = KEY_STEP[e.key];
    if (!step || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    const next = toMs(focusDay) + step * DAY_MS;
    if (next < toMs(cal.cells[0].day) || next > toMs(data.today)) return;
    const day = toDay(next);
    setCursor(day);
    scrollRef.current.querySelector(`[data-day="${day}"]`)?.focus();
  };

  // Плоский список детей сетки: подпись месяца и семь дней на столбец. Подпись шире столбца, поэтому у обрезанной
  // первой недели её нет, если следующий месяц начнётся сразу за ней: иначе две подписи налезут друг на друга
  const seq = [...Array(cal.pad).fill(null), ...cal.cells];
  const cols = [];
  for (let w = 0; w * 7 < seq.length; w++) cols.push(seq.slice(w * 7, w * 7 + 7));
  const monthKey = (col) => col.find(Boolean)?.day.slice(0, 7);

  return (
    <>
      {head}
      <p className="days-sum">{t.days_sum(cal.played.length, totalText, cal.best)}</p>
      <div className="days-scroll" ref={scrollRef}>
        <div className="days-grid" role="group" aria-label={t.days_grid} onKeyDown={onKey}>
          {cols.map((col, w) => {
            const month = monthKey(col);
            const showMonth = w === 0 ? monthKey(cols[1]) === month && monthKey(cols[2]) === month : monthKey(cols[w - 1]) !== month;
            const first = col.find(Boolean);
            return [
              <span key={`m${w}`} className="days-month" aria-hidden="true">{showMonth ? dateOf(first.day, { month: 'short' }) : ''}</span>,
              ...col.map((c, i) => (c
                ? <button key={c.day} type="button" data-day={c.day} className={`days-cell${level(c.seconds)}${c.day === shownDay ? ' on' : ''}`}
                  tabIndex={c.day === focusDay ? 0 : -1} aria-pressed={c.day === shownDay} aria-label={label(c)} data-tip={label(c)}
                  onClick={() => { setPicked(c.day); setCursor(c.day); }} />
                : <i key={`p${i}`} className="days-cell none" />)),
            ];
          })}
        </div>
      </div>
      <div className="days-scale" aria-hidden="true">
        {t.days_less}
        {['', ' l1', ' l2', ' l3', ' l4'].map((l) => <i key={l} className={`days-cell${l}`} />)}
        {t.days_more}
      </div>
      {toMs(data.since) > toMs(cal.cells[0].day) && <p className="stats-after">{t.days_since(dateOf(data.since))}</p>}
      {shown && (
        <div className="days-box">
          <h4>{shown.seconds ? `${dateOf(shown.day)}, ${timeOf(shown.seconds)}` : `${dateOf(shown.day)}, ${t.days_none}`}</h4>
          {/* Игры уже нет в списке: строку не показываем, id никому ничего не скажет */}
          {shown.games.filter((g) => byId.has(g.id)).map((g) => {
            const game = byId.get(g.id);
            const cover = getCoverUrl(game, 360);
            return (
              <button key={g.id} type="button" className="days-game" onClick={() => onOpenGame(g.id)}>
                <span className="days-thumb">{cover && <img src={cover} alt="" loading="lazy" decoding="async" />}</span>
                <span className="days-game-name">{game.displayTitle || game.title}</span>
                <span className="days-game-time">{timeOf(g.seconds)}</span>
              </button>
            );
          })}
        </div>
      )}
      {cal.played.length > 0 && (
        <ol className="days-list" tabIndex={0} aria-label={t.days_list}>
          {[...cal.played].reverse().map((c) => <li key={c.day}><span>{dateOf(c.day)}</span><span>{timeOf(c.seconds)}</span></li>)}
        </ol>
      )}
    </>
  );
};

export default PlayDays;
