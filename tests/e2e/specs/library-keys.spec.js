import { test, expect, openLibrary, openViewRow } from '../fixtures.js';

// Клавиатура и порядок во вкладке «Библиотека»: печать сразу в поиск, стрелки по карточкам, буквы сбоку, сортировка столбцами

const LETTERS = 'ABCDEFGHIJКЛМНОП';
// Демо-игр меньше страницы: размножаем настоящие, чтобы были и вторая страница, и столбец букв. Названия — с буквы по кругу
async function manyGames(page, n = 64, change = (g) => g) {
  await page.route(/\/api\/games(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const real = await res.json();
    const json = Array.from({ length: n }, (_, i) => {
      const base = real[i % real.length];
      const name = `${LETTERS[Math.floor(i / 4) % LETTERS.length]}${String(i).padStart(2, '0')} game`;
      return change({ ...base, id: i < real.length ? base.id : `${base.id}_${i}`, title: name, displayTitle: name, shelf: null }, i);
    });
    return route.fulfill({ response: res, json });
  });
}

// Вид выбирают в ряду под «Вид»; он остаётся открытым
const setView = async (page, name) => {
  await openViewRow(page);
  await page.locator('.g-view').getByRole('button', { name, exact: true }).click();
};
const focused = (page) => page.evaluate(() => document.activeElement?.dataset?.game || '');
const box = (page) => page.evaluate(() => {
  const r = document.activeElement.getBoundingClientRect();
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-total')) || 0;
  return { left: r.left, top: r.top, bottom: r.bottom, stickyTop: top, height: innerHeight };
});
const titles = (page) => page.locator('.library .card-title').allInnerTexts();
const pickSort = async (page, name) => {
  await page.locator('.sort-order .picker-btn').click();
  await page.locator('.sort-order [role="option"]', { hasText: name }).first().click();
  await expect(page.locator('.sort-order .picker-btn')).toHaveText(name);
};

test('библиотека: буква с клавиатуры начинает поиск и не теряется, H по-прежнему скрывает', async ({ page }) => {
  await openLibrary(page);
  const input = page.locator('.search-box input');
  await page.keyboard.press('s');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('s');
  await page.keyboard.press('Shift+T');
  await expect(input).toHaveValue('sT');
  // В поле H — обычная буква
  await page.keyboard.press('h');
  await expect(input).toHaveValue('sTh');
  await expect(page.locator('.app-container')).not.toHaveClass(/covers-hidden/);
  await input.fill('');
  await input.blur();

  await page.keyboard.press('h');
  await expect(page.locator('.app-container')).toHaveClass(/covers-hidden/);
  await expect(input).toHaveValue('');
  await expect(input).not.toBeFocused();
  await page.keyboard.press('h');
  await expect(page.locator('.app-container')).not.toHaveClass(/covers-hidden/);

  // С Ctrl — не поиск; цифра — поиск; написанное продолжается в конце
  await page.keyboard.press('Control+b');
  await expect(input).not.toBeFocused();
  await input.fill('ab');
  await input.blur();
  await page.keyboard.press('7');
  await expect(input).toHaveValue('ab7');
  await input.fill('');
  await input.blur();

  // Открыт список сортировки и открыто окно: буквы не их и в поиск не идут
  await page.locator('.sort-order .picker-btn').click();
  await expect(page.locator('.sort-order [role="listbox"]')).toBeFocused();
  await page.keyboard.press('q');
  await expect(input).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sort-order [role="listbox"]')).toHaveCount(0);
  await page.keyboard.press('Shift+Slash');
  await expect(page.locator('.keys-content')).toBeVisible();
  await page.keyboard.press('q');
  await expect(input).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.locator('.keys-content')).toHaveCount(0);

  // Не вкладка «Библиотека» — буквы ничего не делают
  await page.locator('.nav-tab', { hasText: 'Главная' }).click();
  await expect(page.locator('.content.view-home')).toBeVisible();
  await page.keyboard.press('q');
  await expect(input).toHaveValue('');
});

test('библиотека: способ ввода (японский, китайский) тоже начинает поиск, с клавиши H — нет', async ({ page }) => {
  await openLibrary(page);
  const input = page.locator('.search-box input');
  const press = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: c, bubbles: true })), code);
  await press('KeyH');
  await expect(input).not.toBeFocused();
  await press('KeyA');
  await expect(input).toBeFocused();
});

test('библиотека: стрелки ходят по карточкам по экрану, под панель карточка не уходит, край подгружает следующую страницу', async ({ page }) => {
  await manyGames(page);
  await openLibrary(page);
  const first = await page.locator('.library > .game-card').first().getAttribute('data-game');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focused(page)).toBe(first);
  const a = await box(page);
  await expect(page.locator(`.game-card[data-game="${first}"]`)).toHaveCSS('outline-style', 'none'); // рамка — на обложке
  await expect(page.locator(`.game-card[data-game="${first}"] .card-cover`)).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('ArrowRight');
  const b = await box(page);
  expect(b.left).toBeGreaterThan(a.left);
  expect(Math.abs(b.top - a.top)).toBeLessThan(2);
  await page.keyboard.press('ArrowDown');
  const c = await box(page);
  expect(c.top).toBeGreaterThan(b.top);
  expect(Math.abs(c.left - b.left)).toBeLessThan(2);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focused(page)).toBe(first);

  // Список: одна колонка, шаг — строка. Вниз и обратно: карточка всё время на экране и не под панелью
  await setView(page, 'Список');
  await expect(page.locator('.library')).toHaveClass(/look-list/);
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  await page.keyboard.press('ArrowDown');
  const inView = async () => {
    const r = await box(page);
    expect(r.top).toBeGreaterThanOrEqual(r.stickyTop - 1);
    expect(r.bottom).toBeLessThanOrEqual(r.height + 1);
  };
  await expect(page.locator(':focus.game-card')).toHaveCSS('outline-style', 'solid');
  for (let i = 0; i < 14; i++) { await page.keyboard.press('ArrowDown'); await inView(); }
  for (let i = 0; i < 10; i++) { await page.keyboard.press('ArrowUp'); await inView(); }

  // Последняя загруженная: дальше — следующая страница и фокус на ней
  const cards = page.locator('.library > .game-card');
  const loaded = await cards.count();
  await cards.last().evaluate((el) => el.focus({ preventScroll: true }));
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => cards.count()).toBeGreaterThan(loaded);
  const at = await page.evaluate(() => [...document.querySelectorAll('.library > .game-card')].indexOf(document.activeElement));
  expect(at).toBe(loaded);
  await inView();
});

test('библиотека: Enter открывает окно игры, Shift+Enter запускает, на полке не запускает', async ({ page }) => {
  await page.route(/\/api\/games(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const json = await res.json();
    json[1].shelf = { key: '', until: 0 };
    return route.fulfill({ response: res, json });
  });
  await page.addInitScript(() => localStorage.setItem('rpg_sort', 'name'));
  await openLibrary(page);
  const shelved = page.locator('.library > .game-card.shelved');
  await shelved.focus();
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.game-frame')).toHaveCount(0);
  await expect(page.locator('#modal-title')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('#modal-title')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal-title')).toHaveCount(0);

  await page.locator('.library > .game-card:not(.shelved)').first().focus();
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.game-frame')).toBeVisible();
});

test('библиотека: столбец букв ведёт к букве за первой страницей, сетку не сужает и страницу не расширяет', async ({ page }) => {
  await manyGames(page);
  await openLibrary(page);
  const letters = page.locator('.lib-letters');
  await expect(letters).toHaveCount(0);
  const widthBefore = await page.locator('.library > .game-card').first().evaluate((el) => el.getBoundingClientRect().width);
  await pickSort(page, 'По алфавиту');
  await expect(letters).toBeVisible();
  await expect(letters.locator('button')).toHaveText([...'КЛМНОПABCDEFGHIJ']); // в русском порядке кириллица раньше латиницы
  expect(await page.locator('.library > .game-card').first().evaluate((el) => el.getBoundingClientRect().width)).toBe(widthBefore);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  for (const view of [null, 'Список', 'Стена']) {
    if (view) await setView(page, view);
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    // Последняя буква: на первых страницах её карточек ещё нет
    await page.getByRole('button', { name: 'К букве J', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement.dataset.game ? document.activeElement.querySelector('.card-title').textContent : '')).toBe('J36 game');
    const r = await box(page);
    expect(r.top).toBeGreaterThanOrEqual(r.stickyTop - 1);
    expect(r.top).toBeLessThan(r.height);
    await page.reload();
    await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
    await expect(letters).toBeVisible();
  }

  // Назад в сетку; в «Описание» и на узком экране букв нет; с фильтром — только оставшиеся, и меньше 30 игр — нет совсем
  await setView(page, 'Описание');
  await expect(letters).toHaveCount(0);
  await setView(page, 'Сетка');
  await expect(letters).toBeVisible();
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(letters).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.search-box input').fill('A0');
  await expect(letters).toHaveCount(0);
});

test('столбец букв: буквы со штрихом — рядом со своей основой, а не под «…»', async ({ page }) => {
  await manyGames(page, 40, (g, i) => (i < 4 ? { ...g, title: `Øya ${i}`, displayTitle: `Øya ${i}` } : g));
  await page.addInitScript(() => localStorage.setItem('rpg_sort', 'name'));
  await openLibrary(page);
  const letters = page.locator('.lib-letters button');
  await expect(letters.filter({ hasText: /^O$/ })).toHaveCount(1);
  await expect(letters.filter({ hasText: '…' })).toHaveCount(0);
});

test('сортировка из столбца запоминается: после перезагрузки подписана, после смены пропадает из списка', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('sort_set')) { sessionStorage.setItem('sort_set', '1'); localStorage.setItem('rpg_sort', 'version_asc'); } });
  await openLibrary(page);
  const picker = page.locator('.sort-order .picker-btn');
  await expect(picker).not.toHaveText('');
  const label = await picker.innerText();
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await expect(picker).toHaveText(label);
  await pickSort(page, 'По алфавиту');
  await picker.click();
  await expect(page.locator('.sort-order [role="option"]', { hasText: label })).toHaveCount(0);
});

test('библиотека: столбцы списка сортируют в обе стороны, пустые — в конце, список сортировки подписан', async ({ page }) => {
  const VERS = ['1.9', '1.10', '', '0.5'];
  await manyGames(page, 4, (g, i) => ({ ...g, version: VERS[i], size: [2e9, 0, 5e9, 1e9][i], addedAt: [3000, 0, 1000, 2000][i], playtime: [100, 0, 300, 200][i], rating: [2, 0, 5, 3][i], status: ['done', '', 'dropped', 'wish'][i], lastPlayed: 0 }));
  await page.addInitScript(() => localStorage.setItem('rpg_libview', 'list'));
  await openLibrary(page);
  const header = (name) => page.getByRole('columnheader', { name, exact: true });
  const click = async (name, sort) => {
    await header(name).getByRole('button').click();
    await expect(header(name)).toHaveAttribute('aria-sort', sort);
    await expect(header(name).locator('svg')).toBeVisible();
    await expect(page.locator('[role="columnheader"][aria-sort="none"]')).toHaveCount(6);
  };
  const A = 'A00 game', B = 'A01 game', C = 'A02 game', D = 'A03 game';
  const order = async (want) => expect(await titles(page)).toEqual(want);

  await click('Название', 'ascending');
  await order([A, B, C, D]);
  await click('Название', 'descending');
  await order([D, C, B, A]);
  await expect(page.locator('.sort-order .picker-btn')).toHaveText('По алфавиту (с конца)');
  // Обратное значение — в списке, только пока выбрано
  await page.locator('.sort-order .picker-btn').click();
  await expect(page.locator('.sort-order [role="option"]')).toHaveCount(9);
  await page.keyboard.press('Escape');

  await click('Версия', 'descending');
  await order([B, A, D, C]); // 1.10 новее 1.9, без версии — в конце
  await click('Версия', 'ascending');
  await order([D, A, B, C]);
  await click('Статус', 'ascending');
  await order([A, C, D, B]);
  await click('Статус', 'descending');
  await order([D, C, A, B]);
  await click('В игре', 'descending');
  await order([C, D, A, B]);
  await click('В игре', 'ascending');
  await order([A, D, C, B]);
  await click('Оценка', 'descending');
  await order([C, D, A, B]);
  await click('Оценка', 'ascending');
  await order([A, D, C, B]);
  await click('Размер', 'descending');
  await order([C, A, D, B]);
  await expect(page.locator('.sort-order .picker-btn')).toHaveText('Сначала тяжелые');
  await click('Размер', 'ascending');
  await order([D, A, C, B]);
  await click('Добавлена', 'descending');
  await order([A, D, C, B]);
  await click('Добавлена', 'ascending');
  await order([C, D, A, B]);

  // Обратное значение запоминается и после обновления страницы
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await expect(header('Добавлена')).toHaveAttribute('aria-sort', 'ascending');
  await order([C, D, A, B]);
});

// Быстрый просмотр, названия на стене и выбор нескольких игр

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
const firstCard = (page) => page.locator('.library > .game-card').first();
const coverSrc = (page) => firstCard(page).locator('.card-cover img').getAttribute('src');
const bar = (page) => page.locator('.select-bar');
const barButton = (page, name) => bar(page).getByRole('button', { name, exact: true });
const pickIn = async (page, label, option) => {
  await bar(page).locator('.picker-btn', { hasText: label }).click();
  await bar(page).getByRole('option', { name: option, exact: true }).click();
};
const toast = (page) => page.locator('.toast.show');
const startSelect = async (page) => {
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await expect(bar(page)).toBeVisible();
};

test('библиотека: при наведении обложка листает кадры, битый пропускает и возвращается; размер прежний', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await manyGames(page, 6, (g) => ({ ...g, screens: ['_t/a.png', '_t/broken.png', '_t/b.png', '_t/c.png', '_t/never.png'] }));
  const asked = [];
  await page.route(/_t\/\w+\.png/, (route) => {
    asked.push(route.request().url());
    return /broken/.test(route.request().url()) ? route.abort() : route.fulfill({ contentType: 'image/png', body: PIXEL });
  });
  await openLibrary(page);
  const cover = await coverSrc(page);
  const size = await firstCard(page).locator('.card-cover').boundingBox();
  // Главная сама показывает кадры, поэтому считаем с этого места: без наведения сетка ничего не просит
  asked.length = 0;
  await page.waitForTimeout(800);
  expect(asked).toEqual([]);
  await firstCard(page).hover();
  await expect.poll(() => coverSrc(page), { timeout: 3000 }).toContain('a.png');
  expect(await coverSrc(page)).toContain('?w=360');
  await expect.poll(() => coverSrc(page), { timeout: 3000 }).toContain('b.png');
  await expect.poll(() => coverSrc(page), { timeout: 3000 }).toContain('c.png');
  await expect.poll(() => coverSrc(page), { timeout: 3000 }).toContain('a.png');
  expect(await firstCard(page).locator('.card-cover').boundingBox()).toEqual(size);
  await page.mouse.move(0, 0);
  await expect.poll(() => coverSrc(page)).toBe(cover);

  // «Скрыть обложки» и список: кадров нет
  await page.keyboard.press('h');
  await expect(page.locator('.app-container')).toHaveClass(/covers-hidden/);
  await firstCard(page).hover();
  await page.waitForTimeout(1000);
  expect(await coverSrc(page)).toBe(cover);
  await page.keyboard.press('h');
  await page.mouse.move(0, 0);
  await setView(page, 'Список');
  await firstCard(page).hover();
  await page.waitForTimeout(1000);
  expect(await coverSrc(page)).toBe(cover);
});

test('библиотека: без анимаций и на полке кадров при наведении нет', async ({ page }) => {
  await manyGames(page, 6, (g) => ({ ...g, screens: ['_t/a.png'] }));
  await page.route(/_t\/\w+\.png/, (route) => route.fulfill({ contentType: 'image/png', body: PIXEL }));
  await openLibrary(page);
  const cover = await coverSrc(page);
  await firstCard(page).hover();
  await page.waitForTimeout(1000);
  expect(await coverSrc(page)).toBe(cover);
  await page.unroute(/\/api\/games(\?.*)?$/);
  await manyGames(page, 6, (g) => ({ ...g, screens: ['_t/a.png'], shelf: { key: '', until: 0 } }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await expect(firstCard(page)).toBeVisible();
  const shelved = await coverSrc(page);
  await firstCard(page).hover();
  await page.waitForTimeout(1000);
  expect(await coverSrc(page)).toBe(shelved);
});

test('библиотека: названия на стене — переключатель только там, запоминается', async ({ page }) => {
  await openLibrary(page);
  const toggle = page.getByRole('button', { name: 'Названия всегда', exact: true });
  await expect(toggle).toHaveCount(0);
  await setView(page, 'Стена');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const titleBox = page.locator('.library > .game-card').nth(1).locator('.card-info');
  await page.mouse.move(0, 0);
  await expect.poll(() => titleBox.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(0, 0);
  await expect.poll(() => titleBox.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await expect(page.locator('.library.wall-titles')).toBeVisible();
  await setView(page, 'Сетка');
  await expect(page.locator('.library.wall-titles')).toHaveCount(0);
});

test('библиотека: выбор — щелчок, Space, диапазон, все, смена вида, фильтр и Esc', async ({ page }) => {
  await manyGames(page);
  await page.addInitScript(() => localStorage.setItem('rpg_sort', 'name'));
  await openLibrary(page);
  await startSelect(page);
  const cards = page.locator('.library > .game-card');
  const count = bar(page).locator('.select-count');
  await expect(cards.first().locator('.card-check')).toBeVisible();
  await expect(cards.first().locator('.card-play')).toHaveCount(0);
  await expect(cards.first().locator('.card-rating')).toHaveCount(0);

  await cards.first().locator('.card-title').click();
  await expect(count).toHaveText('Выбрано 1');
  await expect(page.locator('#modal-title')).toHaveCount(0);
  await expect(cards.first()).toHaveAttribute('aria-pressed', 'true');
  await cards.nth(3).click({ modifiers: ['Shift'] });
  await expect(count).toHaveText('Выбрано 4');
  await expect(page.locator('.library > .game-card.picked')).toHaveCount(4);
  await cards.nth(3).locator('.card-title').click();
  await expect(count).toHaveText('Выбрано 3');
  await cards.nth(5).focus();
  await page.keyboard.press('Space');
  await expect(count).toHaveText('Выбрано 4');

  // Смена вида не трогает выбор; «Выбрать все» берёт и не подгруженные страницы
  await setView(page, 'Список');
  await expect(count).toHaveText('Выбрано 4');
  await barButton(page, 'Выбрать все').click();
  await expect(count).toHaveText('Выбрано 64');
  expect(await cards.count()).toBeLessThan(64);

  // Поиск убирает из выбора то, что больше не показано, и обратно само не вернётся
  await page.locator('.search-box input').fill('A0');
  await expect(count).toHaveText('Выбрано 4');
  await page.locator('.search-box input').fill('');
  await expect(count).toHaveText('Выбрано 4');
  await page.locator('.search-box input').blur();

  // Esc — только режим выбора
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('.library > .game-card.picked')).toHaveCount(0);
  await expect(page.locator('.library')).toBeVisible();
  await startSelect(page);
  await expect(count).toHaveText('Выбрано 0');
  await barButton(page, 'Готово').click();
  await expect(bar(page)).toHaveCount(0);
  await cards.first().locator('.card-title').click();
  await expect(page.locator('#modal-title')).toBeVisible();
});

test('библиотека: статус нескольким — не больше четырёх разом, подборка не стирает другие, сбой остаётся выбранным', async ({ page }) => {
  await manyGames(page, 12, (g) => ({ ...g, lists: ['Старая'], status: '', rating: 0 }));
  await page.addInitScript(() => localStorage.setItem('rpg_sort', 'name'));
  const sent = [];
  let now = 0, most = 0;
  let failOn = '';
  await page.route(/\/api\/games\/[^/]+\/meta$/, async (route) => {
    const id = decodeURIComponent(route.request().url().split('/').at(-2));
    sent.push({ id, body: route.request().postDataJSON() });
    now += 1; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 40));
    now -= 1;
    return id === failOn ? route.fulfill({ status: 500, json: { error: 'нет' } }) : route.fulfill({ json: { success: true } });
  });
  await openLibrary(page);
  await startSelect(page);
  const cards = page.locator('.library > .game-card');
  const count = bar(page).locator('.select-count');
  await barButton(page, 'Выбрать все').click();
  await expect(count).toHaveText('Выбрано 12');
  await pickIn(page, 'Статус', 'Пройдено');
  await expect(toast(page)).toHaveText('Готово: 12');
  expect(sent).toHaveLength(12);
  expect(sent.every((x) => x.body.status === 'done')).toBe(true);
  expect(most).toBeLessThanOrEqual(4);
  expect(most).toBeGreaterThan(1);
  await expect(count).toHaveText('Выбрано 0');
  await expect(bar(page)).toBeVisible(); // режим остаётся

  // Подборка дописывается к прежним; одна игра не вышла: остаётся выбранной, остальные идут дальше
  sent.length = 0;
  failOn = await cards.nth(1).getAttribute('data-game');
  await cards.first().locator('.card-title').click();
  await cards.nth(2).locator('.card-title').click({ modifiers: ['Shift'] });
  await pickIn(page, 'В подборку', 'Новая подборка');
  await bar(page).locator('.select-new input').fill('Лето');
  await page.keyboard.press('Enter');
  await expect(toast(page)).toHaveText('Готово: 2, не вышло: 1');
  expect(sent.map((x) => x.body.lists)).toEqual([['Старая', 'Лето'], ['Старая', 'Лето'], ['Старая', 'Лето']]);
  await expect(count).toHaveText('Выбрано 1');
  await expect(cards.nth(1)).toHaveClass(/picked/);

  sent.length = 0;
  await pickIn(page, 'Оценка', '★★★');
  await expect(toast(page)).toHaveText('Готово: 0, не вышло: 1');
  expect(sent).toEqual([{ id: failOn, body: { rating: 3 } }]);
  await expect(count).toHaveText('Выбрано 1');
});

test('библиотека: на полку по одной и после вопроса; у человека кнопки нет', async ({ page }) => {
  await manyGames(page, 6);
  await page.addInitScript(() => localStorage.setItem('rpg_sort', 'name'));
  const sent = [];
  let now = 0, most = 0;
  await page.route(/\/api\/games\/[^/]+\/shelf$/, async (route) => {
    sent.push(decodeURIComponent(route.request().url().split('/').at(-2)));
    now += 1; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 200));
    now -= 1;
    return sent.length === 2 ? route.fulfill({ status: 500, json: { error: 'нет' } }) : route.fulfill({ json: { success: true, trashKey: 'x' } });
  });
  await openLibrary(page);
  await startSelect(page);
  const cards = page.locator('.library > .game-card');
  const shelfBtn = barButton(page, 'На полку');
  await expect(shelfBtn).toHaveCount(0); // пока ничего не выбрано
  await cards.first().locator('.card-title').click();
  await cards.nth(2).locator('.card-title').click({ modifiers: ['Shift'] });
  await shelfBtn.click();
  await expect(page.locator('.confirm-name')).toHaveText('Игр: 3');
  await expect(page.locator('.confirm-text')).toContainText('30 дней');
  // Esc в вопросе закрывает только вопрос
  await page.keyboard.press('Escape');
  await expect(page.locator('.confirm-box')).toHaveCount(0);
  await expect(bar(page)).toBeVisible();
  expect(sent).toEqual([]);

  await shelfBtn.click();
  await page.locator('.confirm-ok').click();
  await expect(shelfBtn).toBeDisabled();
  await expect(barButton(page, 'Готово')).toBeDisabled();
  await expect(toast(page)).toHaveText('Готово: 2, не вышло: 1');
  expect(sent).toHaveLength(3);
  expect(most).toBe(1);
  await expect(bar(page).locator('.select-count')).toHaveText('Выбрано 1');
  await expect(shelfBtn).toBeEnabled();

  // Человек: те же кнопки, кроме полки
  await page.route('**/api/me', async (route) => {
    const res = await route.fetch();
    return route.fulfill({ response: res, json: { ...(await res.json()), isOwner: false } });
  });
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await startSelect(page);
  await cards.first().locator('.card-title').click();
  await expect(bar(page).locator('.select-count')).toHaveText('Выбрано 1');
  await expect(barButton(page, 'Снять выбор')).toBeEnabled();
  await expect(shelfBtn).toHaveCount(0);
});

test('панель выбора: стрелка вниз не уводит карточку под панель', async ({ page }) => {
  await manyGames(page);
  await openLibrary(page);
  await startSelect(page);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focused(page)).not.toBe('');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowDown');
    const barTop = await bar(page).evaluate((el) => el.getBoundingClientRect().top);
    expect((await box(page)).bottom).toBeLessThanOrEqual(barTop);
  }
});

test('панель выбора: снимки сетки и телефона, на узком экране не вылезает и не закрывает последний ряд', async ({ page }) => {
  await manyGames(page, 10);
  await page.addInitScript(() => localStorage.setItem('rpg_sort', 'name'));
  await openLibrary(page);
  await startSelect(page);
  const cards = page.locator('.library > .game-card');
  await cards.first().locator('.card-title').click();
  await cards.nth(2).locator('.card-title').click({ modifiers: ['Shift'] });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'e2e/report/select-desktop.png' });

  await page.setViewportSize({ width: 320, height: 640 });
  await expect(bar(page)).toBeVisible();
  await page.screenshot({ path: 'e2e/report/select-phone.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await bar(page).boundingBox();
  expect(box.x).toBe(0);
  expect(box.width).toBeLessThanOrEqual(320);
  for (const b of await bar(page).locator('button').all()) {
    const r = await b.boundingBox();
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(320);
  }
  // Список раскрывается вверх и целиком на экране
  await bar(page).locator('.picker-btn', { hasText: 'Оценка' }).click();
  const pop = await bar(page).locator('.picker-pop').boundingBox();
  expect(pop.x).toBeGreaterThanOrEqual(0);
  expect(pop.x + pop.width).toBeLessThanOrEqual(320);
  expect(pop.y).toBeGreaterThanOrEqual(0);
  expect(pop.y + pop.height).toBeLessThanOrEqual((await bar(page).locator('.picker').last().boundingBox()).y + 1);
  await page.screenshot({ path: 'e2e/report/select-phone-open.png' });
  await page.keyboard.press('Escape');
  await expect(bar(page).locator('.picker-pop')).toHaveCount(0);
  await expect(bar(page)).toBeVisible(); // Esc закрыл только список
  // Докрутили до низа: последняя карточка выше панели
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(async () => {
    const last = await cards.last().boundingBox();
    const now = await bar(page).boundingBox();
    return last.y + last.height <= now.y;
  }).toBe(true);
});

test('библиотека: Escape в открытом ряду «Вид» закрывает ряд, а режим выбора остаётся', async ({ page }) => {
  await openLibrary(page);
  await startSelect(page);
  await openViewRow(page);
  await page.locator('.look-row .look-opt').first().focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.look-row')).toHaveCount(0);
  await expect(bar(page)).toBeVisible();
});
