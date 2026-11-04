import { test, expect, openLibrary, apiGames } from '../fixtures.js';

// Телефон: полка «В репликах» под поиском — одна строка, листается вбок, не больше двух плиток от игры
test('телефон: полка «В репликах» листается вбок, от игры — не больше двух плиток', async ({ page }) => {
  const ids = (await apiGames(page)).map((g) => g.id).slice(0, 4);
  const scenes = ids.flatMap((game) => [0, 1, 2].map((i) => ({ game, key: `events/0000${i}/S`, n: 0, kind: 'cg', title: `Сцена ${i}`, cover: 'pic0.png',
    lines: [{ stop: i, lang: 'orig', who: 'Алиса', text: `Мой муж, раз ${i}`, hl: [[4, 7]], pic: '' }], more: 0 })));
  await page.route(/\/api\/lines\/search\?/, (route) => route.fulfill({ json: { total: scenes.length, games: ids.map((id) => ({ id, lines: 3, scenes: 3 })), indexed: 4, library: 4, building: null, scenes } }));
  await page.route(/\/api\/gallery\/[^/]+\/thumb\?/, (route) => route.fulfill({ status: 404, body: '' }));
  await openLibrary(page);
  await page.locator('.search-box input').fill('муж');
  const row = page.locator('.line-shelf .shelf-row');
  await expect(row.locator('.line-tile')).toHaveCount(8);
  await expect(row.locator('.line-who').first()).toHaveText('Алиса');
  const { scroll, client } = await row.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(scroll).toBeGreaterThan(client);
  await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});
