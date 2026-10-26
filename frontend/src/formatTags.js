// Теги формата: что игра 2D-рисованная, японская, на RPG Maker, с анимацией. Они есть почти у
// всех игр, поэтому как жанр бесполезны: в статистике их не считаем в «Частых тегах», а в списке жанров
// они стоят в конце, отдельной группой «Формат»
export const FORMAT_TAGS = new Set(['2dcg', '2d game', '3dcg', '3d game', 'japanese game', 'rpg', 'rpgm', 'rpg maker', 'animated']);

export const isFormatTag = (tag) => FORMAT_TAGS.has(String(tag).toLowerCase());
