// Без этого скрипта страница читается целиком: миниатюры — ссылки на картинки, команду можно выделить.
// Скрипт только оживляет просмотр скриншотов и добавляет кнопку «Копировать».
const shot = document.getElementById('shot');
const caption = document.getElementById('shot-caption');
document.querySelectorAll('.thumbs a').forEach((a, _, all) => a.addEventListener('click', (e) => {
  // Ctrl/Shift/средняя кнопка — человек хочет открыть картинку отдельно
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  all.forEach((x) => { if (x === a) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current'); });
  shot.src = a.href; shot.width = a.dataset.w; shot.height = a.dataset.h; shot.alt = a.dataset.alt;
  caption.textContent = a.dataset.caption;
}));

document.querySelectorAll('.cmd[data-copy]').forEach((box) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'copy'; b.textContent = box.dataset.copy;
  box.append(b);
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(box.querySelector('pre').innerText); b.textContent = box.dataset.copied; }
    catch { b.textContent = box.dataset.failed; }
    setTimeout(() => { b.textContent = box.dataset.copy; }, 2000);
  });
});
