// Размеры для плашки загрузок и сообщений о ней: единицы и запятая — по языку интерфейса
const GB = 1024 ** 3;
// Размер словами языка интерфейса: «48 МБ», «1,2 ГБ». Запятая или точка — по языку, единицы — из locales
export const fmtSize = (bytes, t) => (bytes >= GB
  ? `${(bytes / GB).toLocaleString(t.lang_id, { maximumFractionDigits: 2 })} ${t.tb_unit.gb}`
  : `${Math.round(bytes / 1048576).toLocaleString(t.lang_id, { useGrouping: false })} ${t.tb_unit.mb}`);
// «20 из 48 МБ»: единица у первого числа лишняя, когда обе стоят в одних и тех же
export const fmtOf = (got, total, t) => {
  const a = fmtSize(got, t);
  const b = fmtSize(total, t);
  const unit = (x) => x.slice(x.lastIndexOf(' ') + 1);
  return t.tb_of(unit(a) === unit(b) ? a.slice(0, a.lastIndexOf(' ')) : a, b);
};
