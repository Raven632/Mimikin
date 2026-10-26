// «Где остановился» — для «Продолжить» на главной и окна игры.
// Место — название карты из последнего сейва (сервер читает его из файлов игры), у японских и
// китайских игр — ещё и по-английски. Уровень 1 ничего не говорит — его не показываем
export const placeOf = (game) => game.progress?.mapEn || game.progress?.map || '';
export const levelOf = (game) => (game.progress?.level > 1 ? game.progress.level : null);
