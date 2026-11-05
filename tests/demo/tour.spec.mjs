import { test as base, expect } from '@playwright/test';
import zlib from 'node:zlib';

// Обход собранного демо: то, что посетитель увидит и нажмёт, от главной до «Начать сначала». Идёт на настольном экране
// и на телефоне (playwright.config.mjs). Общие сторожа ниже включены в каждом тесте: любая из этих ошибок роняет тест,
// даже если сам шаг прошёл.
//   - запрос с «/api/» или «/socket.io/» в пути, дошедший до сети (демо отвечает из памяти страницы, сети у него нет);
//   - запрос не к раздаче демо и любой ответ 4xx/5xx оттуда (битая картинка, пропавший файл записи);
//   - ошибка в консоли, необработанное исключение, строки «[demo] unhandled» и «[demo] unrecorded» (в консоли любого уровня);
//   - окно выбора файла: заметка «в демо этого нет» должна появиться ДО него, а сам выбор в демо не нужен.
// Предупреждения консоли (warning) не роняют: приложение само выводит два про iframe игры.
const test = base.extend({
  bad: [async ({ page, baseURL }, use) => {
    const bad = [];
    const host = new URL(baseURL).host;
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (!/^https?:$/.test(u.protocol)) return;
      if (u.pathname.includes('/api/') || u.pathname.includes('/socket.io/')) bad.push(`в сеть ушёл ${req.method()} ${u.pathname}`);
      else if (u.host !== host) bad.push(`запрос наружу: ${u.host}${u.pathname}`);
    });
    page.on('response', (res) => {
      const u = new URL(res.url());
      if (u.host === host && res.status() >= 400) bad.push(`${res.status()} ${u.pathname}`);
    });
    // Два сообщения браузеров, не демо: WebKit знает не все значения sandbox у iframe игры (так же у самого приложения),
    // а «ResizeObserver loop» — безвредное уведомление, которое браузер показывает как ошибку окна
    const harmless = /allow-orientation-lock|ResizeObserver loop/;
    page.on('console', (m) => {
      const text = m.text();
      if (harmless.test(text)) return;
      if (m.type() === 'error' || /^\[demo\] (unhandled|unrecorded)/.test(text)) bad.push(`консоль ${m.type()}: ${text.slice(0, 200)}`);
    });
    page.on('pageerror', (e) => !harmless.test(e.message) && bad.push(`исключение: ${e.message.slice(0, 200)}`));
    page.on('filechooser', () => bad.push('открылось окно выбора файла'));
    await use(bad);
    expect(bad, 'сторожа демо').toEqual([]);
  }, { auto: true }],
});

const phone = (info) => info.project.name.startsWith('phone');

async function openDemo(page, query = '?lang=en') {
  await page.goto(query);
  await expect(page.locator('.shelf-card').first()).toBeVisible();
  // Дать дозагрузиться тому, что страница спрашивает при старте: уход со страницы посреди запросов даёт в WebKit
  // «Load failed» — это обрыв, а не ошибка демо
  await page.waitForLoadState('networkidle');
}
async function menu(page, name) {
  await page.locator('.header-menu-btn').click();
  await page.getByRole('menuitem', { name }).click();
}
async function openLibrary(page) {
  await page.locator('.nav-tab', { hasText: 'Library' }).click();
  await expect(page.locator('.library > .game-card').first()).toBeVisible();
}
async function openGame(page, title) {
  await openLibrary(page);
  await page.locator('.library > .game-card').filter({ hasText: title }).first().locator('.card-title').click();
  await expect(page.locator('#modal-title')).toHaveText(title);
}
// Картинки на экране загружены, а не битые
async function noBrokenImages(page) {
  await page.waitForFunction(() => [...document.images].every((img) => {
    const r = img.getBoundingClientRect();
    return r.width === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || img.complete;
  }));
  const broken = await page.evaluate(() => [...document.images].filter((img) => {
    const r = img.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && img.complete && img.naturalWidth === 0;
  }).map((img) => img.src));
  expect(broken).toEqual([]);
}
const demoApi = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

test('главная: последняя игра, «где остановился», недавние и «что дальше»', async ({ page }) => {
  await openDemo(page);
  const stage = page.locator('.shelf-card').first();
  await expect(page.getByText('Starfall Inn').first()).toBeVisible();
  // На телефоне полки идут лентой и часть заголовков вне экрана: смотрим на текст страницы, а не на видимость
  await expect(page.locator('main')).toContainText('Recently played');
  await expect(page.locator('main')).toContainText("What's next");
  await expect(page.getByText(/Rooftop Kitchen/).first()).toBeVisible();
  await noBrokenImages(page);
  // «Недавно играл» — правда на момент визита: запись сделана в другой день, времена сдвинуты (timeShift.js)
  const hours = await page.evaluate(async () => {
    const games = await (await fetch('/api/games')).json();
    return (Date.now() - Math.max(...games.map((g) => g.lastPlayed || 0))) / 3600000;
  });
  expect(hours).toBeGreaterThan(0);
  expect(hours).toBeLessThan(6);
  await expect(stage).toBeVisible();
});

test('библиотека: сетка, русское название, поиск, вид', async ({ page }) => {
  await openDemo(page);
  await openLibrary(page);
  await expect(page.locator('.library > .game-card')).toHaveCount(17);
  await expect(page.locator('.library > .game-card .card-title', { hasText: 'Кристальный прилив' })).toBeVisible();
  await noBrokenImages(page);
  await page.getByRole('textbox', { name: /Title or tag/ }).fill('lantern');
  // «lantern» есть в названиях и тегах нескольких игр, но не во всех
  await expect(page.locator('.library > .game-card .card-title', { hasText: 'The Lantern Road' })).toBeVisible();
  expect(await page.locator('.library > .game-card').count()).toBeLessThan(17);
  await page.getByRole('textbox', { name: /Title or tag/ }).fill('');
  await expect(page.locator('.library > .game-card')).toHaveCount(17);
  // Вид «Списком» меняет раскладку, а не только подпись
  await page.locator('.look-btn[aria-expanded]').click();
  await page.locator('.look-grp.g-view').getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('.library')).toBeVisible();
  await expect(page.locator('.library > .game-card')).toHaveCount(17);
});

test('окно игры: оценка держится до перезагрузки, перезагрузка возвращает запись', async ({ page }) => {
  await openDemo(page);
  await openGame(page, 'Starfall Inn');
  await expect(page.locator('.modal-content .modal-tab')).toHaveText(['Overview', 'Path', 'Moments4', 'Details', 'Translation']);
  const rating = () => demoApi(page, 'GET', '/api/games').then((r) => r.body.find((g) => (g.displayTitle || g.title) === 'Starfall Inn').rating);
  // В записи у игры 5 звёзд; повторное нажатие на ту же звезду сняло бы оценку, поэтому ставим 3
  expect(await rating()).toBe(5);
  // На телефоне строка «Моя игра» свёрнута: звёзды видны после нажатия на неё
  if (phone(test.info())) await page.locator('.modal-content button', { hasText: 'My game' }).click();
  await page.getByRole('button', { name: 'Rate 3 of 5' }).click();
  await expect.poll(rating).toBe(3);
  await page.locator('.modal-content .modal-tab', { hasText: 'Details' }).click();
  await expect(page.locator('.modal-content')).toContainText('Moon Studio');
  await page.keyboard.press('Escape');
  // Страница помнит, на какой вкладке была: после перезагрузки ждём шапку, а не полку главной
  await page.reload();
  await expect(page.locator('.nav-tab').first()).toBeVisible();
  await expect.poll(rating).toBe(5);
});

test('моменты и история сохранений в окне игры', async ({ page }) => {
  await openDemo(page);
  await openGame(page, 'Starfall Inn');
  await page.locator('.modal-content .modal-tab', { hasText: 'Moments' }).click();
  await expect(page.locator('.modal-content img').first()).toBeVisible();
  await noBrokenImages(page);
  await page.locator('.modal-content .modal-tab', { hasText: 'Path' }).click();
  await expect(page.locator('#modal-tab-panel')).not.toBeEmpty();
  await noBrokenImages(page);
  // «Продолжить с…» на главной: слоты сохранений с историей версий
  await page.keyboard.press('Escape');
  await page.locator('.nav-tab', { hasText: 'Home' }).click();
  await page.getByRole('button', { name: 'Saves', exact: true }).click();
  await expect(page.getByText(/Slot 1/).first()).toBeVisible();
});

test('галерея: альбом, просмотр кадра, закрытие', async ({ page }) => {
  await openDemo(page);
  await openGame(page, 'Starfall Inn');
  await page.locator('.modal-content button', { hasText: /^Gallery$/ }).click();
  const gallery = page.locator('.gallery');
  await expect(gallery).toBeVisible();
  await expect(gallery.locator('.gallery-tile').first()).toBeVisible();
  await noBrokenImages(page);
  await gallery.locator('.gallery-tile').first().click();
  await expect(page.locator('.gallery-viewer, .viewer, .gallery-view').first()).toBeVisible();
  await noBrokenImages(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.gallery')).toHaveCount(0);
});

test('меню: избранное, что играть, сцены, статистика с днями игры', async ({ page }) => {
  await openDemo(page);
  await menu(page, 'Favorites');
  await expect(page.locator('.favorites, [class*=favorites]').first()).toContainText('Starfall Inn');
  await noBrokenImages(page);
  await page.keyboard.press('Escape');

  await menu(page, 'What to play?');
  await expect(page.locator('.play-pick')).toContainText('Same developer as');
  await page.keyboard.press('Escape');

  await menu(page, 'Scenes');
  await expect(page.getByRole('dialog').filter({ hasText: 'Scenes' })).toBeVisible();
  await page.keyboard.press('Escape');

  await menu(page, 'Statistics');
  await expect(page.locator('.stats-content')).toContainText('My playing days');
  await expect(page.locator('.stats-content')).toContainText('17 games');
  // Календарь кончается сегодняшним днём посетителя, а не днём записи
  const lastDay = await page.locator('.days-cell[data-day]').last().getAttribute('data-day');
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  expect(lastDay).toBe(today);
});

test('настройки: каждый раздел читается, набранное остаётся на странице', async ({ page }) => {
  await openDemo(page);
  await menu(page, 'Settings');
  await expect(page.locator('.settings-content')).toBeVisible();
  const tabs = page.locator('.settings-tab');
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(9);
  for (let i = 0; i < count; i++) {
    await tabs.nth(i).click();
    await expect(page.locator('.settings-content')).not.toBeEmpty();
    expect((await page.locator('.settings-content').innerText()).trim().length).toBeGreaterThan(20);
  }
  await tabs.filter({ hasText: 'About' }).click();
  await expect(page.locator('.settings-content')).toContainText('7.1');
  // Ключ службы, набранный в «Источниках», — под одну строку-метку; никуда не уходит (сторож запросов) и нигде не хранится
  const marker = 'MARKER-not-a-real-key-4821';
  await tabs.filter({ hasText: 'Sources' }).click();
  const field = page.locator('[data-secret] .set-form input').first();
  if (await field.count()) {
    await field.fill(marker);
    await page.locator('[data-secret] .set-form .set-submit').first().click();
    await expect(page.locator('.settings-content')).toContainText(/demo|stays on this page|остаётся/i);
  }
  const kept = await page.evaluate((m) => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]).includes(m), marker);
  expect(kept).toBe(false);
});

test('«Найти»: честно про сеть и список «Хочу сыграть»', async ({ page }) => {
  await openDemo(page);
  await page.locator('.nav-tab', { hasText: 'Find' }).click();
  await expect(page.getByText(/no internet sources/i)).toBeVisible();
  await page.locator('.catalog-wish-tab').click();
  await expect(page.locator('main')).toContainText(/Glass Orchard|Night Ferry|Moss Court/);
});

test('«Играть»: титульная страница игры и возврат в библиотеку', async ({ page }) => {
  await openDemo(page);
  await openGame(page, 'Starfall Inn');
  await page.locator('#modal-play-btn').click();
  const frame = page.locator('.game-frame iframe');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('src', /play\/.+\.html/);
  const inner = page.frameLocator('.game-frame iframe');
  await expect(inner.locator('body')).toContainText('Starfall Inn');
  await inner.getByRole('button').first().click();
  await expect(page.locator('.game-frame iframe')).toHaveCount(0);
  await expect(page.locator('.nav-tab').first()).toBeVisible();
});

test('«Добавить игру»: заметка раньше окна выбора файла', async ({ page }) => {
  await openDemo(page);
  if (phone(test.info())) await menu(page, 'Add game');
  else await page.locator('.upload-btn').click();
  const note = page.locator('.confirm-box');
  await expect(note).toBeVisible();
  await expect(note).toContainText(/no server to take files/);
  await page.keyboard.press('Escape');
  await expect(note).toHaveCount(0);
  // Бросок файла на страницу — та же заметка (окна выбора нет, сторож filechooser молчит)
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'game.zip'));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator('.confirm-box')).toBeVisible();
});

test('выход и вход: любое имя и пароль подходят', async ({ page }) => {
  await openDemo(page);
  await page.locator('.header-menu-btn').click();
  await page.locator('.menu-logout').click();
  await page.locator('.confirm-ok').click();
  const login = page.locator('.auth-box, .auth-card, form').filter({ has: page.locator('input[type=password]') }).first();
  await expect(login).toBeVisible();
  await expect(login).toContainText(/any name and password/);
  await login.locator('input').first().fill('visitor');
  await login.locator('input[type=password]').fill('whatever');
  await login.locator('button[type=submit], .auth-submit').first().click();
  await expect(page.locator('.shelf-card').first()).toBeVisible();
});

test('«Начать сначала»: стирает свои ключи страницы и возвращает запись', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => { localStorage.setItem('rpg_demo_probe', '1'); localStorage.setItem('mimikin.demo_probe', '1'); localStorage.setItem('other_site', '1'); });
  await page.locator('.demo-mark').click();
  await page.getByRole('button', { name: 'Start over' }).click();
  await page.waitForFunction(() => !localStorage.getItem('rpg_demo_probe'));
  await expect(page.locator('.shelf-card').first()).toBeVisible();
  const keys = await page.evaluate(() => ({ mine: localStorage.getItem('mimikin.demo_probe'), other: localStorage.getItem('other_site') }));
  expect(keys).toEqual({ mine: null, other: '1' });
});

test('языки: ?lang=ru и ?lang=de переключают интерфейс и панель демо', async ({ page }) => {
  await openDemo(page, '?lang=ru');
  await expect(page.locator('.nav-tab', { hasText: 'Библиотека' })).toBeVisible();
  await expect(page.locator('.demo-mark')).toHaveText('Демо');
  await openDemo(page, '?lang=de');
  await expect(page.locator('.nav-tab', { hasText: 'Bibliothek' })).toBeVisible();
  await expect(page.locator('.demo-mark')).toHaveText('Demo');
  // Ссылка с английской страницы тоже несёт ?lang=en: сохранённый ранее другой язык её не перебивает
  await openDemo(page, '?lang=en');
  await expect(page.locator('.nav-tab', { hasText: 'Library' })).toBeVisible();
});

test('первая загрузка укладывается в 320 КБ (gzip, без шрифтов и картинок)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'размер один и тот же, мерим в одном проекте');
  let bytes = 0;
  const pending = [];
  page.on('response', (res) => {
    const type = res.request().resourceType();
    if (['script', 'stylesheet', 'document', 'fetch', 'xhr'].includes(type) && res.url().startsWith('http')) {
      pending.push(res.body().then((b) => { bytes += zlib.gzipSync(b).length; }, () => {}));
    }
  });
  await openDemo(page);
  await page.waitForLoadState('networkidle');
  await Promise.all(pending);
  expect(bytes, `первая загрузка ${(bytes / 1024).toFixed(0)} КБ gzip`).toBeLessThan(320 * 1024);
  console.log(`первая загрузка: ${(bytes / 1024).toFixed(0)} КБ gzip`);
});
