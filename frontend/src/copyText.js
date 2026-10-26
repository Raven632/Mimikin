// Копирование в буфер. Прод открывают по обычному http (через Tailscale) — там navigator.clipboard
// не существует, поэтому основной путь: скрытое поле и execCommand('copy'). Вернёт true, если скопировалось
export async function copyText(text) {
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  // Вне экрана и без прокрутки страницы; 16px — чтобы iOS не приближал страницу при фокусе
  box.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;font-size:16px';
  document.body.appendChild(box);
  box.select();
  box.setSelectionRange(0, text.length);
  // Сначала execCommand и без await: после await касание уже потеряно, и Safari с iPhone отказывает
  let ok;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  box.remove();
  if (ok) return true;
  // Не вышло (в новых браузерах execCommand может быть выключен) — async-буфер, только на защищённой странице
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Запретили доступ к буферу — честно скажем «не удалось»
  }
  return false;
}
