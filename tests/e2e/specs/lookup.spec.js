import { test, expect, openLibrary, openGame } from '../fixtures.js';

// Данные игры, которых поиск не нашёл: «Как искали» и «Возможно, это она». Сети в тестах нет — что
// ответили бы сайты, подставляем
const JOURNAL = {
  at: Date.now() - 3600e3,
  steps: [
    { site: 'vndb', by: 'title', q: 'Clockwork Vale', result: 'none' },
    { site: 'steam', by: 'title', q: 'Clockwork Vale', result: 'down' },
  ],
  near: [{ site: 'vndb', title: 'Clockwork Valley Remake', link: 'https://vndb.org/v77', score: 0.68 }],
};

async function notFound(page, extra = {}) {
  await page.route(/\/api\/games(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const games = await res.json();
    const vale = games.find((g) => g.id === 'Clockwork_Vale');
    vale.meta = { status: 'not_found', attempts: 1, retryAt: Date.now() + 864e5, checkedAt: JOURNAL.at, error: '' };
    vale.description = '';
    vale.tags = [];
    vale.screens = [];
    vale.link = '';
    Object.assign(vale, extra);
    await route.fulfill({ response: res, json: games });
  });
  await page.route(/\/api\/games\/Clockwork_Vale\/lookup$/, (route) => route.fulfill({ json: { journal: JOURNAL } }));
}

test.describe('поиск данных: почему не нашлось', () => {
  test('«Как искали»: по каждому сайту — что спросили и что ответил, похожее с процентом', async ({ page }) => {
    await notFound(page);
    await openLibrary(page);
    await openGame(page, 'Clockwork Vale');
    const help = page.locator('.modal-content .lookup-help');
    await help.locator('.lookup-log summary').click();
    await expect(help.locator('.lookup-step')).toHaveText([
      'VNDB: по названию «Clockwork Vale», такой игры нет; похожая «Clockwork Valley Remake» — 68%, не подошла',
      'Steam: по названию «Clockwork Vale», не ответил',
    ]);
    // Отвергнутое похожее — сразу в «Возможно, это она», без запросов к сайтам
    await expect(help.locator('.lookup-candidates li')).toHaveCount(1);
    await expect(help.locator('.lookup-candidates li')).toContainText('Clockwork Valley Remake');
    await expect(help.locator('.lookup-candidates li')).toContainText('68%');
  });

  test('журнал: сколько кредитов ScraperAPI стоил поиск и на какие сайты', async ({ page }) => {
    JOURNAL.credits = { itch: 20, steam: 1 };
    try {
      await notFound(page);
      await openLibrary(page);
      await openGame(page, 'Clockwork Vale');
      const help = page.locator('.modal-content .lookup-help');
      await help.locator('.lookup-log summary').click();
      await expect(help.locator('.lookup-credits')).toHaveText('ScraperAPI: потрачено 21 кредит (itch.io 20, Steam 1)');
    } finally {
      delete JOURNAL.credits;
    }
  });

  test('ищется сейчас: в окне игры — шаги по сайтам; ждёт — какая по счёту', async ({ page }) => {
    const now = { id: 'Clockwork_Vale', title: 'Clockwork Vale', startedAt: Date.now(), steps: [
      { site: 'vndb', by: 'title', q: 'Clockwork Vale', result: 'none' },
      { site: 'steam', by: 'title', q: 'Clockwork Vale', result: 'found' },
    ] };
    await notFound(page, { meta: { status: 'new', attempts: 0, retryAt: Date.now() - 1000, checkedAt: 0, error: '' } });
    await page.route(/\/api\/games\/lookup-queue$/, (route) => route.fulfill({ json: { paused: false, left: 2, current: now, next: [{ id: 'Starfall_Inn', title: 'Starfall Inn', first: false }] } }));
    await openLibrary(page);
    await openGame(page, 'Clockwork Vale');
    const live = page.locator('.modal-content .lookup-live');
    await expect(live.locator('.lookup-step')).toHaveText([
      'VNDB: по названию «Clockwork Vale», такой игры нет',
      'Steam: по названию «Clockwork Vale», нашлась',
      'ищем дальше…',
    ]);
  });

  test('«Это она»: ссылка добавляется, данные ищутся по ней', async ({ page }) => {
    await notFound(page);
    let sent = null;
    await page.route(/\/api\/games\/Clockwork_Vale\/edit$/, (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, found: true, failed: [], game: {
        link: sent.link, description: 'A valley that runs on clockwork.', tags: ['steampunk'], screens: [],
        meta: { status: 'partial', attempts: 0, retryAt: null, checkedAt: Date.now(), error: '' },
      } } });
    });
    await openLibrary(page);
    await openGame(page, 'Clockwork Vale');
    const help = page.locator('.modal-content .lookup-help');
    const first = help.locator('.lookup-candidates li').first();
    await expect(first).toContainText('Clockwork Valley Remake');
    await expect(first).toContainText('VNDB 68%');
    await first.locator('button', { hasText: 'Это она' }).click();
    await expect(page.locator('.toast.show')).toContainText('Ссылка добавлена, данные найдены');
    expect(sent).toEqual({ link: 'https://vndb.org/v77' });
    await expect(page.locator('.modal-content .modal-description')).toHaveText('A valley that runs on clockwork.');
  });
});

test('очередь поиска: по полосе «Сбор метаданных» — что ищется, что дальше, «Искать первой» и пауза', async ({ page }) => {
  let state = {
    paused: false, left: 2,
    current: { id: 'Clockwork_Vale', title: 'Clockwork Vale', startedAt: Date.now(), steps: [{ site: 'steam', by: 'title', q: 'Clockwork Vale', result: 'found' }] },
    next: [{ id: 'Starfall_Inn', title: 'Starfall Inn', first: false }, { id: 'Moss_Garden', title: 'Moss Garden', first: false }],
  };
  const asked = [];
  await page.route(/\/api\/games\/lookup-queue(\/pause)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      asked.push(['pause', route.request().postDataJSON()]);
      state = { ...state, paused: route.request().postDataJSON().paused };
    }
    return route.fulfill({ json: state });
  });
  await page.route(/\/api\/games\/Moss_Garden\/rescrape$/, (route) => {
    asked.push(['first', 'Moss_Garden']);
    state = { ...state, next: [{ id: 'Moss_Garden', title: 'Moss Garden', first: true }, { id: 'Starfall_Inn', title: 'Starfall Inn', first: false }] };
    return route.fulfill({ json: { success: true } });
  });
  await openLibrary(page);
  await page.locator('.scrape-progress').click();
  const win = page.locator('.queue-content');
  await expect(win).toContainText('Ждут поиска: 2');
  await expect(win.locator('.queue-now')).toContainText('Clockwork Vale');
  await expect(win.locator('.queue-now .lookup-step').first()).toHaveText('Steam: по названию «Clockwork Vale», нашлась');
  await win.locator('.queue-list li', { hasText: 'Moss Garden' }).locator('button', { hasText: 'Искать первой' }).click();
  await expect(win.locator('.queue-list li').first()).toContainText('Moss Garden');
  await expect(win.locator('.queue-list li').first()).toContainText('первой');
  await win.locator('button', { hasText: 'Пауза' }).click();
  await expect(win).toContainText('На паузе. Ждут поиска: 2');
  await expect(win.locator('button', { hasText: 'Продолжить' })).toBeVisible();
  expect(asked).toEqual([['first', 'Moss_Garden'], ['pause', { paused: true }]]);
});
