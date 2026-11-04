import { avatarSrc } from '../avatar';

// Знак человека: квадрат со срезанными пиксельными углами, как у знака-мимика. Есть аватар — он; нет — первая буква имени
// (картинку с буквой не храним, её рисует страница). Главный администратор — с пиксельной короной: роль берётся из isOwner,
// а не из имени, имя может быть любым
// size — сторона в точках; без него размер и угол задаёт CSS (плитка, которая тянется по ширине колонки)
const CROWN = (
  <svg className="pmark-crown" viewBox="0 0 8 6" shapeRendering="crispEdges" aria-hidden="true">
    <path fill="#f0d080" d="M0 1h1v1h1v1h1V1h2v2h1V2h1V1h1v5H0z" />
    <path fill="#c9a84c" d="M0 5h8v1H0z" />
  </svg>
);

// Tiny5 ровный в кратных восьми размерах: мельче или между ними пиксель шрифта ложится в дробные точки и рябит
const letterSize = (size) => Math.max(16, Math.round((size * 0.55) / 8) * 8);

const PersonMark = ({ person, size, className = '', crown = true }) => {
  const name = (person?.name || '').trim();
  const letter = name ? [...name][0].toLocaleUpperCase() : '';
  const src = avatarSrc(person);
  const style = size ? { width: size, height: size, '--c': `${Math.max(2, Math.round(size / 12))}px`, fontSize: letterSize(size) } : undefined;
  return (
    <span className={`pmark-wrap${size ? '' : ' fill'}${person?.isOwner ? ' owner' : ''} ${className}`.trim()} style={size ? { width: size, height: size } : undefined}>
      <span className={`pmark${src ? ' pic' : ''}`} style={style}>
        {src ? <img src={src} alt="" draggable={false} /> : <span className="pmark-letter">{letter}</span>}
      </span>
      {crown && person?.isOwner && CROWN}
    </span>
  );
};

export default PersonMark;
