import { Fragment } from 'react';

// Строка фактов («1 мин», «Золото: 0») без точек-склеек и без чёрточек: части разделяет только воздух
// (отступ справа у каждой части). Между частями обычный пробел: без него при копировании и в тестах
// части слипаются («Золото: 0»+«1 мин»), а перенос строки всегда проходит по нему — строка не начинается с отступа.
// Пустые части (false, '', null) пропускаются, так что висящего разделителя не бывает.
const MetaLine = ({ parts, className, as: Tag = 'span' }) => {
  const list = parts.filter((p) => p !== false && p !== null && p !== undefined && p !== '');
  if (!list.length) return null;
  return (
    <Tag className={className}>
      {list.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className="meta-part">{part}</span>
        </Fragment>
      ))}
    </Tag>
  );
};

export default MetaLine;
