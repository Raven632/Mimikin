// Интерфейс самого демо: знак «Демо» с двумя действиями и окно заметки «здесь это не работает». Свой корень React рядом с приложением,
// с общими стилями окон (демо-сборка подключает demo.css только здесь). Имена экспорта — как просит install.js и entry.js.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import './demo.css';
import DemoUi from './DemoBar.jsx';

let show = null;
// Заметку просят раньше, чем корень отрисовался (бросок файла на самом первом экране) — запоминаем одну и показываем потом
let waiting = '';
const register = (fn) => {
  show = fn;
  if (fn && waiting) { fn(waiting); waiting = ''; }
};

// what — о чём заметка: ключ из texts.js (upload, download, lookup …)
export function showNote(what) {
  if (show) show(what); else waiting = what;
}

// Один раз после запуска приложения. Знак плавает поверх страницы (demo.css), место в потоке ему не нужно
export function mountDemoUi() {
  const host = document.createElement('div');
  host.id = 'demo-ui';
  document.body.append(host);
  createRoot(host).render(createElement(DemoUi, { register }));
}
