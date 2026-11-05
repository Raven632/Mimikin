import { DEMO } from './demoHooks';

// Адреса картинок, звуков и видео, которые страница берёт у сервера, и файлов из public. Все — здесь: в демо-сборке
// у страницы нет сервера, и каждый такой адрес заменяется файлом рядом со страницей (frontend/demo/install.js).
// Новый адрес «/api/…» для <img>, <audio> или <video> строить тут же, а не в компоненте: правило eslint не даст иначе.
// Запросы за JSON (fetch) сюда не относятся — их отвечает демо-роутер.
const e = encodeURIComponent;
export const mediaUrl = (url) => (DEMO ? window.mimikinDemo.media(url) : url);

// Файл альбома: what — thumb | image | audio | video | spine | live2d. max — предел размера для live2d
export const galleryUrl = (id, what, file, max = 0) => mediaUrl(`/api/gallery/${e(id)}/${what}?f=${e(file)}${max ? `&max=${max}` : ''}`);
// Теги одной картинки — JSON, не файл; здесь же, чтобы правило eslint про «?f=» не знало исключений
export const frameTagsUrl = (id, file) => `/api/gallery/${e(id)}/tags?f=${e(file)}`;
export const rigCoverUrl = (id, key) => mediaUrl(`/api/gallery/${e(id)}/rig-cover?key=${e(key)}`);
// Момент игры: what — thumb | shot
export const markUrl = (id, mark, what) => mediaUrl(`/api/marks/${e(id)}/${mark}/${what}`);
export const journalThumbUrl = (id, entry) => mediaUrl(`/api/journal/${e(id)}/${entry}/thumb`);
export const saveShotUrl = (id, key, at) => mediaUrl(`/api/saves/shot/${e(id)}?key=${e(key)}&v=${at}`);
export const avatarUrl = (id, version) => mediaUrl(`/api/avatars/${e(id)}?v=${version}`);

// Файл из public (логотипы сайтов, пробное видео): путь, написанный в коде строкой, Vite не пересчитывает. В обычной
// сборке BASE_URL — «/», и ничего не меняется; в демо страница лежит не в корне сайта
export const asset = (path) => import.meta.env.BASE_URL + path.slice(1);
