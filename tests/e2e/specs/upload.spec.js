import { test, expect, openHome, openLibrary } from '../fixtures.js';

// Очередь загрузок: сервер подменён — распаковка «идёт», пока тест её не отпустит
test('очередь загрузок: архивы по одному, по порядку; лишний убрать из очереди; не архив — отказ', async ({ page }) => {
  const started = [];
  const finished = new Set();
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const { name, size } = route.request().postDataJSON();
    started.push(name);
    return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ json: finished.has(id)
      ? { id, state: 'done', folder: id, received: 1, size: 1 }
      : { id, state: 'processing', step: 'extract', received: 1, size: 1 } });
  });
  await page.route(/\/api\/games\/upload\/(list|trace)/, (route) => route.fulfill({ json: [] }));
  await openLibrary(page);

  const file = (name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(`${name} bytes`) });
  await page.locator('.controls-zone input[type=file]').setInputFiles([file('One.zip'), file('Two.zip'), file('Three.7z'), file('notes.txt')]);
  await expect(page.locator('.toast.show')).toContainText('только архивы');
  // Плашка у нижнего края: идущий — строкой, очередь — словами во второй строке, список — в раскрытой панели
  const bar = page.locator('.tb');
  await expect(bar.locator('.tb-name')).toHaveText('One.zip');
  await expect(bar.locator('.tb-sub')).toHaveText('Ещё 2');
  await bar.locator('.tb-row').click();
  const panel = page.locator('.tb.open');
  await expect(panel.locator('.tb-queue .tb-sub-title')).toHaveText('Дальше в очереди2');
  await expect(panel.locator('.tb-queue li')).toHaveCount(2);

  // Тот же файл ещё раз — не в очередь
  await page.locator('.controls-zone input[type=file]').setInputFiles([file('Two.zip')]);
  await expect(page.locator('.toast.show')).toContainText('«Two.zip» уже в очереди');

  // Лишний — убрать: с него ещё ничего не ушло
  await panel.locator('.tb-queue li', { hasText: 'Three.7z' }).locator('button').click();
  await expect(panel.locator('.tb-queue .tb-sub-title')).toHaveText('Дальше в очереди1');

  // Пока первый распаковывается, второй не начинается
  await page.waitForTimeout(500);
  expect(started).toEqual(['One.zip']);
  finished.add('One.zip');
  await expect(panel.locator('.tb-now-name')).toHaveText('Two.zip');
  await expect(panel.locator('.tb-queue')).toHaveCount(0);
  finished.add('Two.zip');
  await page.keyboard.press('Escape');
  await expect(bar.locator('.tb-sub')).toContainText('Игра');
  expect(started).toEqual(['One.zip', 'Two.zip']);
});

test('архив под паролем, а за ним очередь: он ждёт пароля на сервере, очередь идёт дальше', async ({ page }) => {
  const started = [];
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const { name, size } = route.request().postDataJSON();
    started.push(name);
    return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ json: id === 'Locked.zip'
      ? { id, state: 'password', error: '', received: 1, size: 1 }
      : { id, state: 'processing', step: 'extract', received: 1, size: 1 } });
  });
  await page.route(/\/api\/games\/upload\/(list|trace)/, (route) => route.fulfill({ json: [] }));
  await openLibrary(page);
  const file = (name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(`${name} bytes`) });
  await page.locator('.controls-zone input[type=file]').setInputFiles([file('Locked.zip'), file('Next.zip')]);
  await expect(page.locator('.toast.show')).toContainText('«Locked.zip» под паролем');
  await expect(page.locator('.tb .tb-name')).toHaveText('Next.zip');
  expect(started).toEqual(['Locked.zip', 'Next.zip']);
});

// Недогруженное и пароль: список с сервера подменён. Плашка стоит у нижнего края и шапку не закрывает
const PENDING = [
  { id: 'Locked.zip', name: 'Locked.zip', state: 'password', error: '', received: 1, size: 1, busy: false },
  { id: 'Half.zip', name: 'Half.zip', state: 'uploading', received: 400 * 1048576, size: 1000 * 1048576, busy: false },
];

test('плашка загрузок: у нижнего края и не над шапкой; раскрывается, Esc и касание вне панели сворачивают; пароль и «Продолжить» — в панели', async ({ page }) => {
  const sent = [];
  await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: PENDING }));
  await page.route(/\/api\/games\/upload\/password\?/, (route) => { sent.push(route.request().postDataJSON().password); return route.fulfill({ json: { ok: true } }); });
  await openLibrary(page);

  const bar = page.locator('.tb');
  await expect(bar.locator('.tb-name')).toHaveText('Locked.zip');
  // Что ждёт ответа — словами, одной строкой: очередь строку не раздувает
  await expect(bar.locator('.tb-sub')).toHaveText('Ещё 1, одна ждёт пароль, одна не догружена');
  const vh = page.viewportSize().height;
  const head = await page.locator('header').boundingBox();
  const box = await bar.boundingBox();
  expect(Math.round(box.y + box.height)).toBe(vh);
  expect(box.height).toBeLessThanOrEqual(70);
  expect(box.width).toBeLessThanOrEqual(441);
  expect(box.y).toBeGreaterThan(head.y + head.height);
  // Страница под плашкой кончается раньше: последний ряд игр не прячется за ней
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom))).toBeGreaterThanOrEqual(69);
  // Этап словом нигде, кроме панели, не нужен: три отрезка кромки видны
  await expect(bar.locator('.tb-seg > span')).toHaveCount(3);

  await bar.locator('.tb-row').click();
  const panel = page.locator('.tb.open');
  await expect(panel.locator('.tb-now-name')).toHaveText('Locked.zip');
  await expect(panel.locator('.tb-seg-labels span')).toHaveText(['Передача', 'Распаковка', 'В библиотеке']);
  expect((await panel.boundingBox()).y).toBeGreaterThan(head.y + head.height);
  await panel.locator('.upload-password input').fill('secret');
  await panel.getByRole('button', { name: 'Распаковать' }).click();
  await expect.poll(() => sent).toEqual(['secret']);
  const half = panel.locator('.tb-ask', { hasText: 'Half.zip' });
  await expect(half.locator('.tb-item-state')).toContainText('Не догружено');
  await expect(half.getByRole('button', { name: 'Продолжить' })).toBeVisible();
  await expect(half.getByRole('button', { name: 'Удалить недогруженное' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await bar.locator('.tb-row').click();
  await expect(page.locator('.tb.open')).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(page.locator('.tb.open')).toHaveCount(0);
  await expect(bar.locator('.tb-row')).toBeVisible();
});

test('JDownloader: идущая загрузка — в плашке, в панели у неё своя линия; закончившаяся плашку не держит', async ({ page }) => {
  const jobs = [
    { key: 'link:1', title: 'Summer Memories', stage: 'download', loaded: 640 * 1048576, total: 1500 * 1048576, speed: 9.5 * 1048576, eta: 90 },
    { key: 'link:2', title: 'Old Done Game', stage: 'done', game: 'Starfall_Inn' },
  ];
  await page.route(/\/api\/downloads$/, (route) => route.fulfill({ json: jobs }));
  await openLibrary(page);
  const bar = page.locator('.tb');
  await expect(bar.locator('.tb-name')).toHaveText('Summer Memories');
  await expect(bar.locator('.tb-sub b')).toHaveText('Скачивание');
  await expect(bar.locator('.tb-pct')).toHaveText('43%');
  await bar.locator('.tb-row').click();
  const panel = page.locator('.tb.open');
  await expect(panel.locator('.tb-jd')).toHaveCount(2);
  await expect(panel.locator('.tb-jd').first().locator('.tb-line i')).toBeVisible();
  await panel.getByRole('button', { name: 'Открыть игру' }).click();
  await expect(page.locator('.modal-content')).toBeVisible();
});

test('без загрузок плашки нет, а у страницы нет отступа под неё', async ({ page }) => {
  await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: [] }));
  await openLibrary(page);
  await expect(page.locator('.tb')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains('has-transfer'))).toBe(false);
});

// Набранный пароль живёт в Toolbar: панель плашки при сворачивании размонтируется
test('пароль, набранный в панели, не пропадает при сворачивании и раскрытии', async ({ page }) => {
  await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: PENDING }));
  await openLibrary(page);
  const bar = page.locator('.tb');
  await bar.locator('.tb-row').click();
  const panel = page.locator('.tb.open');
  await panel.locator('.upload-password input').fill('secret');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await bar.locator('.tb-row').click();
  await expect(page.locator('.tb.open .upload-password input')).toHaveValue('secret');
});

test('Escape закрывает только верхний слой: окно вопроса над панелью, потом сама панель', async ({ page }) => {
  await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: PENDING }));
  await openLibrary(page);
  await page.locator('.tb .tb-row').click();
  const panel = page.locator('.tb.open');
  await panel.locator('.tb-ask', { hasText: 'Half.zip' }).getByRole('button', { name: 'Удалить недогруженное' }).click();
  await expect(page.locator('.confirm-cancel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.confirm-cancel')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('пока идёт загрузка, ждущие пароль и недогруженные с сервера тоже видны; сама загрузка встала на пароле — панель раскрывается сама', async ({ page }) => {
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const { name, size } = route.request().postDataJSON();
    return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ json: { id, state: 'processing', step: 'extract', received: 1, size: 1 } });
  });
  await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: PENDING }));
  await openLibrary(page);
  await page.locator('.controls-zone input[type=file]').setInputFiles([{ name: 'Fresh.zip', mimeType: 'application/octet-stream', buffer: Buffer.from('x') }]);
  await expect(page.locator('.tb .tb-name')).toHaveText('Fresh.zip');
  await expect(page.locator('.tb .tb-sub')).toHaveText('Ещё 2, одна ждёт пароль, одна не догружена');
});

test('загрузка встала на пароле — панель раскрывается сама, поле пароля на виду', async ({ page }) => {
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const { name, size } = route.request().postDataJSON();
    return route.fulfill({ json: { id: name, state: 'processing', received: size, size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ json: { id, state: 'password', error: '', received: 1, size: 1 } });
  });
  await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: [] }));
  await openLibrary(page);
  await page.locator('.controls-zone input[type=file]').setInputFiles([{ name: 'Locked.zip', mimeType: 'application/octet-stream', buffer: Buffer.from('x') }]);
  await expect(page.locator('.tb.open .upload-password input')).toBeVisible();
});

test('JDownloader закончил — плашка ещё держится, «Открыть игру» под рукой; ошибка короткой строкой без стрелок', async ({ page }) => {
  let jobs = [{ key: 'link:1', title: 'Summer Memories', stage: 'download', loaded: 640 * 1048576, total: 1500 * 1048576, speed: 9.5 * 1048576, eta: 90 }];
  await page.route(/\/api\/downloads$/, (route) => route.fulfill({ json: jobs }));
  await openLibrary(page);
  const bar = page.locator('.tb');
  await expect(bar.locator('.tb-name')).toHaveText('Summer Memories');
  jobs = [{ key: 'link:1', title: 'Summer Memories', stage: 'done', game: 'Starfall_Inn' }];
  await expect(bar.locator('.tb-sub b')).toHaveText('В библиотеке', { timeout: 15000 });
  await bar.locator('.tb-row').click();
  await page.locator('.tb.open').getByRole('button', { name: 'Открыть игру' }).click();
  await expect(page.locator('.modal-content')).toBeVisible();
});

test('ошибка JDownloader — одна короткая строка, без стрелок «→»', async ({ page }) => {
  await page.route(/\/api\/downloads$/, (route) => route.fulfill({ json: [{ key: 'link:2', title: 'Stuck Game', stage: 'error', error: 'empty', retry: true }] }));
  await openLibrary(page);
  await page.locator('.tb .tb-row').click();
  const state = page.locator('.tb.open .tb-jd-state');
  await expect(state).toHaveText('По ссылке нет файлов — выберите файл в JDownloader');
});

// Место на сервере проверяется до загрузки: архив и распакованная игра. Сервер подменён
const GB = 1024 ** 3;
const spaceRoutes = async (page, refuse) => {
  const starts = [];
  await page.route(/\/api\/games\/upload\/start$/, (route) => {
    const body = route.request().postDataJSON();
    starts.push(body);
    const answer = refuse(body, starts.length);
    if (answer) return route.fulfill({ status: 507, json: { error: 'Не хватает места на диске: нужно около 9,4 ГБ, свободно 7,1 ГБ', reason: 'space', ...answer } });
    return route.fulfill({ json: { id: body.name, state: 'processing', received: body.size, size: body.size } });
  });
  await page.route(/\/api\/games\/upload\/status\?/, (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ json: { id, state: 'done', folder: id, received: 1, size: 1 } });
  });
  await page.route(/\/api\/games\/upload\/(list|trace)/, (route) => route.fulfill({ json: [] }));
  return starts;
};
const archive = (name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(`${name} bytes`) });

test('места может не хватить: окно с «Загрузить всё равно» — и загрузка идёт с force', async ({ page }) => {
  const starts = await spaceRoutes(page, (body) => (body.force ? null : { need: 9.4 * GB, free: 7.1 * GB, hard: false }));
  await openLibrary(page);
  await page.locator('.controls-zone input[type=file]').setInputFiles([archive('Big.zip')]);
  const dialog = page.locator('.confirm-box');
  await expect(dialog.locator('.confirm-title')).toHaveText('Места может не хватить');
  await expect(dialog.locator('.confirm-text')).toContainText('займут около 9,4 ГБ, а свободно 7,1 ГБ');
  await dialog.getByRole('button', { name: 'Загрузить всё равно' }).click();
  await expect(page.locator('.tb .tb-sub')).toContainText('Игра');
  expect(starts.map((s) => !!s.force)).toEqual([false, true]);
});

test('не влезет и архив: без вопроса, тост с «Открыть «Место»» ведёт во вкладку «Место»', async ({ page }) => {
  const starts = await spaceRoutes(page, () => ({ need: 9.2 * GB, free: 7.1 * GB, hard: true }));
  await openLibrary(page);
  await page.locator('.controls-zone input[type=file]').setInputFiles([archive('Huge.zip')]);
  const toast = page.locator('.toast.show');
  await expect(toast).toContainText('Не хватает места даже для архива: нужно 9,2 ГБ, свободно 7,1 ГБ');
  await expect(page.locator('.confirm-box')).toHaveCount(0);
  await toast.getByRole('button', { name: 'Открыть «Место»' }).click();
  await expect(page.locator('.library-tab.active')).toHaveText('Место');
  expect(starts).toHaveLength(1);
});

test('по-английски отказ из-за места — своими словами, а не «Server error»', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rpg_lang', 'en'));
  await spaceRoutes(page, () => ({ need: 9.2 * GB, free: 7.1 * GB, hard: true }));
  // Главная: загрузка живёт и там, а вкладка «Библиотека» по-английски называется иначе
  await openHome(page);
  await page.locator('.controls-zone input[type=file]').setInputFiles([archive('Huge.zip')]);
  await expect(page.locator('.toast.show')).toContainText('Not enough space even for the archive');
  await expect(page.locator('.toast.show')).not.toContainText('Server error');
});

test('JDownloader: мало места — в плашке причина, «Скачать всё равно» повторяет с force', async ({ page }) => {
  const jobs = [{ key: 'link:7', title: 'Summer Memories', stage: 'error', error: 'space', need: 26 * GB, free: 12 * GB, hard: false, retry: true }];
  await page.route(/\/api\/downloads$/, (route) => route.fulfill({ json: jobs }));
  const retried = [];
  await page.route(/\/api\/downloads\/link%3A7\/retry$/, (route) => { retried.push(route.request().postDataJSON()); return route.fulfill({ json: { started: true } }); });
  await openLibrary(page);
  const bar = page.locator('.tb');
  await expect(bar.locator('.tb-sub')).toContainText('Мало места на диске');
  await bar.locator('.tb-row').click();
  const panel = page.locator('.tb.open');
  await expect(panel.locator('.tb-jd-state')).toContainText('Мало места на диске');
  await panel.getByRole('button', { name: 'Скачать всё равно' }).click();
  await expect.poll(() => retried).toEqual([{ force: true }]);
  await panel.getByRole('button', { name: 'Повторить' }).click();
  await expect.poll(() => retried).toEqual([{ force: true }, {}]);
});

test('не хватило места на распаковку: архив ждёт — «Повторить» и «Открыть «Место»» в панели', async ({ page }) => {
  let list = [{ id: 'a'.repeat(32), name: 'Wait.zip', size: 3 * GB, received: 3 * GB, state: 'space', error: 'Не хватает места для распаковки', need: 3.1 * GB, free: 2 * GB, target: '', mode: '', busy: false, queued: false, updatedAt: 1 }];
  await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: list }));
  const retried = [];
  await page.route(/\/api\/games\/upload\/retry\?/, (route) => {
    retried.push(new URL(route.request().url()).searchParams.get('id'));
    list = [{ ...list[0], state: 'processing', need: undefined, free: undefined }];
    return route.fulfill({ json: { id: list[0].id, state: 'processing' } });
  });
  await openLibrary(page);
  const bar = page.locator('.tb');
  await expect(bar.locator('.tb-sub')).toContainText('Не хватает места для распаковки: нужно 3,1 ГБ, свободно 2 ГБ. Архив сохранён');
  await bar.locator('.tb-row').click();
  const panel = page.locator('.tb.open');
  await expect(panel.getByRole('button', { name: 'Открыть «Место»' })).toBeVisible();
  await panel.getByRole('button', { name: 'Повторить' }).click();
  await expect.poll(() => retried).toEqual(['a'.repeat(32)]);
  await expect(panel.locator('.tb-nums')).toContainText('Распаковка');
});
