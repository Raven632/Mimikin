// «3 дня назад», «2 hours ago», «vor 5 Minuten» — на языке библиотеки
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

export function timeAgo(ms, lang) {
  if (!ms) return '';
  const rtf = new Intl.RelativeTimeFormat(lang === 'en' ? 'en' : lang === 'de' ? 'de' : 'ru', { numeric: 'auto' });
  const diff = (ms - Date.now()) / 1000;
  for (const [unit, sec] of UNITS) {
    if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  }
  return rtf.format(0, 'minute');
}
