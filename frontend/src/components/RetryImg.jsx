import { useEffect, useState } from 'react';

// Картинка, которая не сдаётся с первого раза. Обложки с чужих сайтов (itch.io, Steam) и миниатюры, которые сервер
// делает по запросу, иногда не приходят: сайт ограничил частые запросы, сервер занят. Раньше такая плитка так и
// оставалась пустым квадратом. Здесь — ещё RETRIES попыток с растущей паузой (новый элемент — браузер спросит заново),
// потом fallback. Загрузилась — класс loaded (плитка до того мерцает, см. CSS)
// Сервер мог перезапускаться или быть занят полминуты — не сдаёмся раньше
const RETRIES = [1000, 3000, 8000, 15000, 30000];

const RetryImg = ({ src, fallback = null, ...rest }) => {
  const [tries, setTries] = useState(0);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(0);
  // Новый адрес — попытки сначала
  const [seen, setSeen] = useState(src);
  if (seen !== src) {
    setSeen(src);
    setTries(0);
    setFailed(false);
    setWaiting(0);
  }
  // Ждёт повтора — таймер; сменился адрес или плитку убрали — отменяем
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => { setWaiting(0); setTries((n) => n + 1); }, waiting);
    return () => clearTimeout(timer);
  }, [waiting, src]);
  if (failed) return fallback;
  return (
    <img
      {...rest}
      key={`${src}#${tries}`}
      src={src}
      onLoad={(e) => { e.currentTarget.classList.add('loaded'); rest.onLoad?.(e); }}
      onError={() => {
        if (tries >= RETRIES.length) { setFailed(true); return; }
        setWaiting(RETRIES[tries]);
      }}
    />
  );
};

export default RetryImg;
