// 4520 секунд → «1 ч 15 мин». Меньше минуты не показываем: это шум.
export function formatPlaytime(sec, t) {
  if (!sec || sec < 60) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} ${t.unit_h} ${m} ${t.unit_min}` : `${m} ${t.unit_min}`;
}
