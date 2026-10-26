// Загрузка модели Live2D для просмотра альбома (Live2DView). Библиотека и pixi тяжёлые — подтягиваются только здесь, когда
// модель действительно открывают. Ядро Cubism (Live2DCubismCore) в сборку не входит: у него закрытая лицензия Live2D,
// его нельзя раздавать — браузер берёт копию из папки самой игры, через сервер (галерея знает её путь: album.live2d.core)
export const live2dUrl = (id, rel, max = 0) => `/api/gallery/${encodeURIComponent(id)}/live2d?f=${encodeURIComponent(rel)}${max ? `&max=${max}` : ''}`;

// Стороны, на которые сервер умеет ужимать текстуру (gallery.js, L2D_MAX)
const SIDES = [1024, 2048, 4096, 8192];

// Крупнейшая сторона текстуры, которую стоит просить. Предел видеокарты (MAX_TEXTURE_SIZE) бывает 4096 на телефонах, а лист
// модели — 8192×4096; телефону и 4096×4096 в видеопамяти много (64 МБ на лист), поэтому на касаниях берём не больше 2048.
// 0 — не ужимать. Предел не меняется, а проба стоит контекста WebGL, поэтому считаем один раз
let side0;
export function textureSide() {
  if (side0 !== undefined) return side0;
  let limit = 4096;
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) || limit;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { /* предел неизвестен — осторожный */ }
  try { if (window.matchMedia('(pointer: coarse)').matches) limit = Math.min(limit, 2048); } catch { /* без медиазапроса — как есть */ }
  const side = SIDES.filter((s) => s <= limit).pop() || SIDES[0];
  side0 = side >= SIDES[SIDES.length - 1] ? 0 : side;
  return side0;
}

// Путь от папки модели: «../» и «./» из model3.json сворачиваем сами (адрес у нас — параметр, браузер их не сложит)
export function join(dir, p) {
  const out = [];
  for (const s of `${dir}${String(p).replace(/\\/g, '/')}`.split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return out.join('/');
}

// Ядро грузится <script>-ом; игры приходят по очереди, у каждой своё. Ядро одно на страницу (глобальное имя), и старое
// читает не всякую модель: загружено ядро, знающее версию moc этой модели, — оставляем; иначе грузим ядро игры поверх
// (оно новее — 5.x читает и старые moc; старее поверх новее не кладём никогда). В цепочке, чтобы две модели подряд не
// вставили два ядра
let chain = Promise.resolve();
export function ensureCore(gameId, l2d) {
  const job = chain.catch(() => {}).then(() => new Promise((ok, bad) => {
    const have = window.Live2DCubismCore;
    if (have && have.Version.csmGetLatestMocVersion() >= l2d.moc) { ok(); return; }
    const s = document.createElement('script');
    s.src = live2dUrl(gameId, l2d.core);
    s.onload = ok;
    s.onerror = () => bad(new Error('core'));
    document.head.appendChild(s);
  })).then(() => {
    const core = window.Live2DCubismCore;
    if (!core) throw new Error('core');
    // Ядра 4.x не знают Memory, которого просит библиотека (Cubism Framework 5): память у них задана при сборке — вызов пустой
    if (!core.Memory) core.Memory = { initializeAmountOfMemory() {} };
    if (core.Version.csmGetLatestMocVersion() < l2d.moc) throw new Error('core');
  });
  chain = job;
  return job;
}

// Модель альбома l2d в сцене app → { lib, model }. Файлы читаем сами (настройки с resolveURL): относительные пути из
// model3.json от адреса «…/live2d?f=…» не разрешились бы. isDead — окно закрыли, пока грузили: тогда null
export async function loadModel(gameId, l2d, app, isDead = () => false) {
  await ensureCore(gameId, l2d);
  if (isDead()) return null;
  // Модуль падает при загрузке, если ядра ещё нет, — подключаем после ensureCore
  const lib = await import('pixi-live2d-display/cubism4');
  lib.config.logLevel = lib.config.LOG_LEVEL_ERROR;
  const url = live2dUrl(gameId, l2d.model);
  const res = await fetch(url);
  if (!res.ok) throw new Error('model3');
  const json = await res.json();
  json.url = url;
  const settings = new lib.Cubism4ModelSettings(json);
  const dir = l2d.model.replace(/[^/]*$/, '');
  const side = textureSide();
  settings.resolveURL = (p) => live2dUrl(gameId, join(dir, p), /\.png$/i.test(p) ? side : 0);
  if (isDead()) return null;
  // Движение запускаем сами: «случайное из Idle» после конца (так делает библиотека) здесь не нужно — idleMotionGroup
  // указывает на несуществующую группу. Движения заранее не грузим (у моделей их десятки)
  const model = await lib.Live2DModel.from(settings, { ticker: app.ticker, autoHitTest: false, autoFocus: false, motionPreload: 'NONE', idleMotionGroup: '__none' });
  if (isDead()) { model.destroy({ children: true, texture: true, baseTexture: true }); return null; }
  return { lib, model };
}

// У модели без масок (clipping) библиотека всё равно обращается к менеджеру масок — при первой отрисовке и при закрытии — и
// падает: даём пустой (draw с ним идёт как без масок)
export function patchMasks(model) {
  const r = model.internalModel.renderer;
  if (!r._clippingManager) {
    r._clippingManager = { setGL() {}, release() {}, setupClippingContext() {}, getClippingContextListForDraw: () => [], getClippingMaskBufferSize: () => 0, getRenderTextureCount: () => 0 };
  }
}
