import { useMemo } from 'react';

// Сортировка по алфавиту: столбец букв у правого края. Диакритику снимаем: «Ё» стоит в сортировке рядом с «Е», «É» — рядом с «E»,
// и своя буква разбила бы группу. Цифры, знаки, японское и китайское — вместе, под «…»
// Буквы со штрихом не раскладываются, а в сортировке стоят за своей основой: их группа — там же, иначе «…» вела бы в середину алфавита
const STROKED = { Ø: 'O', Ł: 'L', Æ: 'A', Œ: 'O', Đ: 'D' };
const groupOf = (name) => {
  const first = [...String(name).trim().normalize('NFD')][0]?.toUpperCase() || '';
  if (STROKED[first]) return STROKED[first];
  return /^[A-ZА-Я]$/.test(first) ? first : '…';
};

const LibraryLetters = ({ games, onJump, t }) => {
  const letters = useMemo(() => {
    const seen = new Map();
    games.forEach((game, index) => {
      const group = groupOf(game.displayTitle || game.title || game.id);
      if (!seen.has(group)) seen.set(group, index);
    });
    return [...seen];
  }, [games]);
  return (
    <nav className="lib-letters" aria-label={t.lib_letters}>
      {letters.map(([letter, index]) => (
        <button key={letter} type="button" aria-label={letter === '…' ? t.lib_letter_other : t.lib_letter(letter)} onClick={() => onJump(index)}>{letter}</button>
      ))}
    </nav>
  );
};

export default LibraryLetters;
