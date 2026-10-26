// Файлы игр в dev отдаёт бэкенд на своём порту, и Vite проксирует их через /media,
// а в проде они лежат на том же адресе, что и сайт. Разница спрятана здесь.
// width — уменьшенная копия (360 для карточек, 720 для окна игры): сервер делает её один раз и
// хранит; карточке на телефоне не нужна обложка во всю ширину. Без width — картинка как есть
export function getMediaUrl(relPath, width) {
    if (!relPath) return null;
    const url = import.meta.env.DEV ? `/media/${relPath}` : `/${relPath}`;
    return width ? `${url}?w=${width}` : url;
}

// Адрес обложки меняется вместе с картинкой: найденные поиском называются по содержимому
// («cover-3f2a9c1b7e.jpg»), свои — по времени загрузки. Метка версии в адресе больше
// не нужна — она и путала: после сохранения окно ставило свою, а список с сервера её
// не знал, и обложка возвращалась к старой картинке из кэша
export function getCoverUrl(game, width = 360) {
    return game.cover ? getMediaUrl(game.cover, width) : null;
}

// Широкий баннер (Project Dungeon — 768×256) в плитке 16:9 обрезался по краям: показываем его целиком, а фоном — он же,
// размытый (CSS: img.wide). Адрес — свойством --cover прямо на плитке: React им не управляет
export const fitWide = (e) => {
  const img = e.currentTarget;
  if (!img.naturalHeight || img.naturalWidth < 2.2 * img.naturalHeight) return;
  img.classList.add('wide');
  img.parentElement?.style.setProperty('--cover', `url(${JSON.stringify(img.currentSrc || img.src)})`);
};
