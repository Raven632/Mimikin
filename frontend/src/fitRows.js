// Список заканчивается целой строкой: обрезанная пополам выглядит как ошибка, а что есть ещё — видно по полосе прокрутки.
// offset*, а не getBoundingClientRect: на широком экране у страницы масштаб (--zoom), а max-height в своих пикселях
export function fitRows(list) {
  if (!list) return;
  list.style.maxHeight = '';
  const room = list.clientHeight;
  if (list.scrollHeight <= room) return;
  const pad = parseFloat(getComputedStyle(list).paddingBottom) || 0;
  let end = 0;
  for (const row of list.children) {
    const bottom = row.offsetTop + row.offsetHeight - list.offsetTop;
    if (bottom + pad > room) break;
    end = bottom;
  }
  if (end) list.style.maxHeight = `${end + pad}px`;
}
