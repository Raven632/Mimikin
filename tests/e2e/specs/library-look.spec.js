import { test, expect, openHome, openLibrary, openViewRow, imagesLoaded } from '../fixtures.js';

// Вид библиотеки: шапка, четыре вида, размер. Главное условие владельца: первый ряд виден целиком, крутить ради него не нужно
const firstFits = async (page) => {
  const { bottom, height } = await page.evaluate(() => ({ bottom: document.querySelector('.library .game-card').getBoundingClientRect().bottom, height: innerHeight }));
  expect(bottom).toBeLessThanOrEqual(height);
};

test('библиотека: первый ряд виден целиком и в низком окне, и в обычном', async ({ page }) => {
  await openLibrary(page);
  for (const [width, height] of [[1000, 533], [1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    // Пересчёт идёт по изменению окна: ждём, пока сетка догонит
    await expect.poll(async () => page.evaluate(() => document.querySelector('.library .game-card').getBoundingClientRect().bottom <= innerHeight)).toBe(true);
    await firstFits(page);
  }
});

test('библиотека: вид переключается и запоминается, карточка открывает игру в любом виде', async ({ page }) => {
  await openLibrary(page);
  await openViewRow(page);
  const library = page.locator('.library');
  const view = page.locator('.g-view');
  await expect(library).toHaveClass(/look-grid/);
  for (const [name, cls] of [['Описание', /look-feat/], ['Список', /look-list/], ['Стена', /look-wall/]]) {
    await view.getByRole('button', { name, exact: true }).click();
    await expect(library).toHaveClass(cls);
    await expect(view.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
    // Выбор не закрывает ряд, а кнопка «Вид» называет текущий вид
    await expect(page.locator('.look-row')).toBeVisible();
    await expect(page.locator('.look-btn[aria-expanded]')).toContainText(name);
    await expect(library.locator('.game-card').first()).toBeVisible();
  }
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await expect(page.locator('.library')).toHaveClass(/look-wall/);
  // Открытое состояние ряда тоже помнится
  await expect(page.locator('.look-row')).toBeVisible();
  // Мимо «Играть» в середине плитки: у стены карточка — только обложка
  await page.locator('.library .game-card').first().click({ position: { x: 12, y: 12 } });
  await expect(page.locator('#modal-title')).toBeVisible();
});

test('библиотека: «Вид» открывает ряд под чипами и сдвигает игры, Escape закрывает и возвращает фокус', async ({ page }) => {
  await openLibrary(page);
  const btn = page.locator('.look-btn[aria-expanded]');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.look-row')).toHaveCount(0);
  // Ряд закрыт: ни одной кнопки вида, размера, группы в панели нет
  await expect(page.locator('.look-seg')).toHaveCount(2);
  const top = () => page.locator('.library .game-card').first().evaluate((el) => el.getBoundingClientRect().top);
  const before = await top();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(btn).toHaveAttribute('aria-controls', /./);
  const row = page.locator('.look-row');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('id', (await btn.getAttribute('aria-controls')));
  // Ряд — обычный блок: игры уехали вниз, а не закрыты им
  await expect.poll(top).toBeGreaterThan(before + 40);
  // Под чипами и на краю содержимого, а не окошком поверх
  const [chips, rowBox, bar] = await page.evaluate(() => ['.status-chips, .filter-chips', '.look-row', '.library-bar'].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; }));
  expect(rowBox[2]).toBeGreaterThanOrEqual(chips[3] - 1);
  expect(Math.abs(rowBox[0] - bar[0] - 20)).toBeLessThan(2);
  expect(rowBox[1]).toBeLessThanOrEqual(bar[1]);
  // Выбор не закрывает ряд; Escape — закрывает, и фокус на «Вид»
  await row.getByRole('button', { name: 'Крупнее', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Крупнее', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(row).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  // Escape в поиске ряд не трогает: он закрыт, а открытый остаётся при очистке поиска
  await btn.click();
  await page.locator('.search-box input').fill('abc');
  await page.keyboard.press('Escape');
  await expect(page.locator('.look-row')).toBeVisible();
  await page.reload();
  await page.locator('.nav-tab', { hasText: 'Библиотека' }).click();
  await expect(page.locator('.look-row')).toBeVisible();
});

test('библиотека: размер меняет плитки, в списке и «Описание» его нет; стена даёт «Названия всегда»', async ({ page }) => {
  await openLibrary(page);
  await openViewRow(page);
  const width = () => page.locator('.library .card-cover').first().evaluate((el) => el.getBoundingClientRect().width);
  const row = page.locator('.look-row');
  await expect(row.locator('.g-wall')).toHaveCount(0);
  await row.getByRole('button', { name: 'Мельче', exact: true }).click();
  const small = await width();
  await row.getByRole('button', { name: 'Крупнее', exact: true }).click();
  await expect.poll(width).toBeGreaterThan(small);
  await row.getByRole('button', { name: 'Список', exact: true }).click();
  await expect(row.locator('.g-size')).toHaveCount(0);
  await row.getByRole('button', { name: 'Описание', exact: true }).click();
  await expect(row.locator('.g-size')).toHaveCount(0);
  await row.getByRole('button', { name: 'Стена', exact: true }).click();
  await expect(row.locator('.g-size')).toBeVisible();
  const titles = row.getByRole('button', { name: 'Названия всегда', exact: true });
  await expect(page.locator('.library')).not.toHaveClass(/wall-titles/);
  await titles.click();
  await expect(titles).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.library')).toHaveClass(/wall-titles/);
  await expect(row).toBeVisible();
});

test('библиотека: «Подборка» только при подборках, группировка выбирается в ряду', async ({ page }) => {
  await openLibrary(page);
  await openViewRow(page);
  const group = page.locator('.g-group');
  // В демо-библиотеке подборок нет
  await expect(group.locator('.look-opt')).toHaveText(['Нет', 'Статус', 'Дата']);
  await group.getByRole('button', { name: 'Статус', exact: true }).click();
  await expect(group.getByRole('button', { name: 'Статус', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.library > .lib-group').first()).toBeVisible();
  await group.getByRole('button', { name: 'Нет', exact: true }).click();
  await expect(page.locator('.library > .lib-group')).toHaveCount(0);
});

// Ряд настроек в одну строку на 1440 при каждом языке: подписи не переносятся и не налезают друг на друга
for (const [lang, width] of [['ru', 1440], ['en', 1440], ['de', 1440], ['ru', 1280], ['en', 1280], ['de', 1280], ['ru', 1100], ['en', 1100], ['de', 1100], ['ru', 800], ['de', 800]]) {
  test(`библиотека: ряд «Вид» не переносит подписи на ${width} (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((code) => localStorage.setItem('rpg_lang', code), lang);
    // Самый длинный набор: стена с названиями и подборки
    await page.addInitScript(() => localStorage.setItem('rpg_libview', 'wall'));
    await page.route(/\/api\/games(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const json = (await res.json()).map((g, i) => ({ ...g, lists: i < 2 ? ['One'] : [] }));
      return route.fulfill({ response: res, json });
    });
    // Название вкладки зависит от языка: библиотека — вторая
    await openHome(page);
    await page.locator('.nav-tab').nth(1).click();
    await expect(page.locator('.library > .game-card').first()).toBeVisible();
    await openViewRow(page);
    await expect(page.locator('.g-wall')).toBeVisible();
    await expect(page.locator('.g-group .look-opt')).toHaveCount(4);
    const bad = await page.evaluate(() => [...document.querySelectorAll('.look-row .look-opt')].filter((el) => {
      const r = el.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(el);
      const t = text.getBoundingClientRect();
      // Один ряд (высота не выросла) и текст внутри кнопки целиком
      return r.height > 48 || el.scrollWidth > el.clientWidth + 1 || t.right > r.right + 0.5 || t.left < r.left - 0.5;
    }).map((el) => el.textContent));
    expect(bad).toEqual([]);
    // Выше 1200 группы стоят в одну строку, как 4:4:2:3; ниже — колонкой, каждая на всю ширину
    const tops = await page.evaluate(() => [...document.querySelectorAll('.look-row .look-grp')].map((el) => el.getBoundingClientRect().top));
    expect(new Set(tops.map(Math.round)).size).toBe(width > 1200 ? 1 : 4);
  });
}

test('библиотека: первый ряд виден целиком, когда ряд «Вид» открыт', async ({ page }) => {
  await openLibrary(page);
  await openViewRow(page);
  await expect.poll(async () => page.evaluate(() => document.querySelector('.library .game-card').getBoundingClientRect().bottom <= innerHeight)).toBe(true);
});

test('библиотека: «Скрыть обложки» убирает картинку из шапки, а наведение меняет её только без них', async ({ page }) => {
  await openLibrary(page);
  await imagesLoaded(page);
  await expect(page.locator('.lib-mast-art')).toBeVisible();
  const before = await page.locator('.lib-mast-art img.on').getAttribute('src');
  await page.locator('.library .game-card').filter({ hasNotText: 'Starfall Inn' }).first().hover();
  await expect.poll(() => page.locator('.lib-mast-art img.on').getAttribute('src')).not.toBe(before);
  await page.locator('.cover-toggle').click();
  await expect(page.locator('.lib-mast-art')).toHaveCount(0);
  await page.locator('.cover-toggle').click();
});
