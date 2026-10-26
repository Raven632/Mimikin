import { test, expect, openLibrary, openGame, openTab, menu } from '../fixtures.js';

// Языки, которые человек знает: выбор в «Настройках» и строка вместо полосы перевода в окне игры.
// Сохранение на сервер подменяем — настоящие настройки демо-библиотеки тесты не трогают

test.describe('языки, которые я знаю', () => {
  test('«Настройки → Общие»: выбор языков уходит в POST /api/settings/known-langs', async ({ page }) => {
    const saved = [];
    await page.route(/\/api\/settings\/known-langs$/, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { langs: [] } });
      const langs = route.request().postDataJSON().langs;
      saved.push(langs);
      await route.fulfill({ json: { langs } });
    });
    await openLibrary(page);
    await menu(page, 'Настройки');
    await expect(page.locator('.settings-content')).toBeVisible();

    const section = page.locator('[data-section="known-langs"]');
    await section.locator('.chip', { hasText: 'Английский' }).click();
    await expect(section.locator('.chip.active')).toHaveText(['Английский']);
    await section.locator('.chip', { hasText: 'Немецкий' }).click();
    await expect(section.locator('.chip.active')).toHaveText(['Английский', 'Немецкий']);
    expect(saved).toEqual([['en'], ['en', 'de']]);
  });

  test('игра на знакомом языке: строка вместо полосы перевода; «Всё равно перевести» её показывает', async ({ page }) => {
    await page.route(/\/api\/settings\/known-langs$/, (route) => route.fulfill({ json: { langs: ['en'] } }));
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const games = await res.json();
      games.find((g) => g.id === 'Clockwork_Vale').textLang = { main: 'en' };
      await route.fulfill({ response: res, json: games });
    });
    await openLibrary(page);
    await openGame(page, 'Clockwork Vale');
    await openTab(page, 'Перевод');

    const note = page.locator('.known-lang-note');
    await expect(note).toContainText('Игра на языке, который вы знаете');
    await expect(page.locator('.tl-bar')).toHaveCount(0);

    await note.locator('button', { hasText: 'Всё равно перевести' }).click();
    await expect(note).toHaveCount(0);
    await expect(page.locator('.tl-bar')).toBeVisible();
  });
});

test('знакомый язык, но перевод уже включён — полоса перевода видна: его можно выключить', async ({ page }) => {
  await page.route('**/api/settings/known-langs', (route) => route.fulfill({ json: { langs: ['ru'] } }));
  await page.route(/\/api\/games\/Starfall_Inn\/translation$/, (route) => route.fulfill({ json: { lang: 'en', state: 'done', done: 10, total: 10, failed: 0, engine: '', error: '', engines: [] } }));
  await page.route(/\/api\/games(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const games = await res.json();
    games.find((g) => g.id === 'Starfall_Inn').textLang = { main: 'ru' };
    await route.fulfill({ response: res, json: games });
  });
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await openTab(page, 'Перевод');
  await expect(page.locator('.modal-content .tl-bar')).toBeVisible();
  await expect(page.locator('.modal-content .known-lang-note')).toHaveCount(0);
});
