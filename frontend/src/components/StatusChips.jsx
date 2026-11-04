import { useRef } from 'react';
import { useFadeEdges } from '../fadeEdges';
import { IconShelf } from './icons';

// Быстрый фильтр по статусу. Живёт в одной строке с «Продолжить», а не отдельным
// рядом под поиском: справа от чипов было пустое место шириной в полэкрана.
// «На полке» — чип есть, только пока такие игры есть: игры без файлов (services/trash.js); в остальных чипах они
// тоже есть, со своей пометкой на карточке.
// «Играю» и «Не начата» считаются и сами, по наигранному (gameStatus.js). «Избранного» нет:
// им никто не пользовался
// counts — сколько игр у каждого статуса при нынешних поиске, жанре и языке: видно заранее, что
// даст нажатие; ноль из-за поиска приглушён
// present — сколько таких игр в библиотеке вообще: чипа нет, если их нет совсем. Считаем отдельно от counts, иначе ряд прыгал бы при наборе
const REAL = ['playing', 'new', 'done', 'dropped', 'wish'];
const StatusChips = ({ value, onChange, t, shelf = 0, counts = null, present = {} }) => {
  // На телефоне чипы — лентой с прокруткой (index.css), и «Пройдено» просто обрезалось по краю.
  // Что лента листается, подсказывает затухание краёв (fadeEdges.js)
  const ref = useRef(null);
  const real = REAL.filter((key) => present[key] > 0 || value === key);
  // Статус один на всю библиотеку: чипы ничего не отберут
  const useless = real.length < 2 && shelf === 0 && value !== 'shelf';
  useFadeEdges(ref, [shelf > 0, real.join(), useless]);
  if (useless) return null;

  return (
    <div ref={ref} className="filter-chips status-chips">
      {[
        ['all', t.filter_all],
        ...[['playing', t.status_playing],
          ['new', t.status_new],
          ['done', t.status_done],
          ['dropped', t.status_dropped],
          ['wish', t.status_wish]].filter(([key]) => real.includes(key)),
        ...(shelf > 0 || value === 'shelf' ? [['shelf', <><IconShelf /> {t.shelf_label}</>]] : []),
      ].map(([key, label]) => {
        const count = counts ? counts[key] || 0 : null;
        return (
          <button
            key={key}
            type="button"
            className={`chip ${value === key ? 'active' : ''}${key === 'shelf' ? ' chip-shelf' : ''}${count === 0 && value !== key ? ' chip-empty' : ''}`}
            aria-pressed={value === key}
            onClick={() => onChange(key)}
          >
            {label}
            {count !== null && <span className="chip-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
};

export default StatusChips;
