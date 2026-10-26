// Загрузка набора Spine: общая для просмотра альбома (SpineView) и врезок в плеере сцены (SceneSpine). Библиотеки тяжёлые —
// pixi и рантайм подтягиваются только здесь, когда набор действительно открывают
export const spineUrl = (id, rel) => `/api/gallery/${encodeURIComponent(id)}/spine?f=${encodeURIComponent(rel)}`;

// Рантайм по версии скелета: 3.7 и 3.8 читают каждый свой, 4.0 и 4.1 — один (как в pixi-spine)
export const runtime = (version) => (/^3\.7/.test(version) ? import('@pixi-spine/runtime-3.7') : /^3\./.test(version) ? import('@pixi-spine/runtime-3.8') : import('@pixi-spine/runtime-4.1'));

// Файлы набора sp (атлас, скелет, страницы) → { PIXI, rt, json, atlas }. isDead — окно закрыли, пока грузили: тогда null
// (до страниц атласа не доходим). Страница не загрузилась — набор не показать вовсе (ошибка)
export async function loadSet(gameId, sp, isDead = () => false) {
  const [PIXI, base, rt] = await Promise.all([import('pixi.js'), import('@pixi-spine/base'), runtime(sp.version)]);
  const [atlasText, json] = await Promise.all([
    fetch(spineUrl(gameId, sp.atlas)).then((r) => (r.ok ? r.text() : Promise.reject(new Error('atlas')))),
    fetch(spineUrl(gameId, sp.skeleton)).then((r) => (r.ok ? r.json() : Promise.reject(new Error('skeleton')))),
  ]);
  if (isDead()) return null;
  // Страницы атласа лежат рядом с ним: по имени файла находим их в перечне альбома
  const pageUrl = (page) => spineUrl(gameId, sp.pages.find((p) => p.split('/').pop() === page.split('/').pop()) || page);
  const atlas = await new Promise((resolve, reject) => {
    // Колбэк срабатывает, когда загружены все страницы; не загрузилась — набор не показать вовсе
    new base.TextureAtlas(atlasText, (page, done) => {
      const tex = PIXI.BaseTexture.from(pageUrl(page));
      if (tex.valid) done(tex); else { tex.once('loaded', () => done(tex)); tex.once('error', () => reject(new Error('page'))); }
    }, resolve);
  });
  return { PIXI, rt, json, atlas };
}
