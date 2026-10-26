import { expect, openLibrary, openGame } from './fixtures.js';

// Три цветных кадра для проверки смены картинки в просмотре галереи: 4:3, 16:10 (другая пропорция — старый кадр
// гаснет сам) и снова 4:3. Цвет разный, чтобы кадры не путались
const PNG = {
  'p1.png': 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAY0lEQVR4nO3PQQkAMAzAwMqpfxWTNRF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAWPXY+gIMS2lVboAAAAAElFTkSuQmCC',
  'p2.png': 'iVBORw0KGgoAAAANSUhEUgAAAFAAAAAyCAIAAABET8urAAAAVUlEQVR4nO3PAQkAMAzAsMmZfxWXdRmHPlABzezZr5rnB8DAwMDAwMDfBFwPuB5wPeB6wPWA6wHXA64HXA+4HnA94HrA9YDrAdcDrgdcD7gecD3gehcQpBgAY1+boAAAAABJRU5ErkJggg==',
  'p3.png': 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAY0lEQVR4nO3PQQkAMAzAwMqpfxWTNRF7HINABFxm93zdcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAWPXY6/IMS5yQnYAAAAAElFTkSuQmCC',
};

// Подменяет оглавление галереи «Starfall Inn»: один альбом из трёх кадров. Кадры отдаёт без задержки
export async function mockGallery(page) {
  await page.route(/\/api\/gallery\/Starfall_Inn$/, (route) => route.fulfill({ json: {
    state: 'ready', v: 4, screen: { w: 816, h: 624 }, counts: { cg: 1 },
    albums: [{ key: 'img/pictures/trio', kind: 'cg', w: 64, h: 48, files: ['p1.png', 'p2.png', 'p3.png'], cover: 'p1.png' }],
  } }));
  await page.route(/\/api\/gallery\/Starfall_Inn\/(thumb|image)\?/, (route) => {
    const f = new URL(route.request().url()).searchParams.get('f');
    return route.fulfill({ body: Buffer.from(PNG[f] || PNG['p1.png'], 'base64'), contentType: 'image/png' });
  });
}

// Просмотр первого кадра альбома: окно игры → «Галерея» → плитка
export async function openTrio(page) {
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await page.locator('.grimoire-action-btn', { hasText: 'Галерея' }).click();
  await page.locator('.gallery-tile').first().click({ timeout: 20_000 });
  await expect(page.locator('.gallery-view > img:not(.gallery-layer)')).toHaveAttribute('src', /p1\.png/);
}

// Следит за слоями наплыва и свайпа: сколько их было одновременно и сколько всего появилось
export async function watchLayers(page) {
  await page.evaluate(() => {
    window.__layers = { max: 0, added: 0 };
    new MutationObserver(() => {
      const n = document.querySelectorAll('.gallery-layer').length;
      window.__layers.max = Math.max(window.__layers.max, n);
    }).observe(document.body, { childList: true, subtree: true });
    new MutationObserver((list) => {
      for (const m of list) for (const node of m.addedNodes) if (node.classList?.contains('gallery-layer')) window.__layers.added += 1;
    }).observe(document.body, { childList: true, subtree: true });
  });
}
export const layers = (page) => page.evaluate(() => window.__layers);
