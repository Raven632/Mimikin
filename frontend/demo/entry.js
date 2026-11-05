// Вход демо-сборки (vite.demo.config.js подставляет его в index.html вместо /src/main.jsx).
// Порядок важен: модули выполняются в порядке импорта, поэтому install.js успевает подменить fetch раньше, чем
// main.jsx сделает первый запрос (/api/me).
import './install.js';
import '../src/main.jsx';
import { mountDemoUi } from './ui.js';

mountDemoUi();
