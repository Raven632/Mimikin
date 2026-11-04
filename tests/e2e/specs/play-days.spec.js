import { test, expect, openHome, imagesLoaded } from '../fixtures.js';

// «Мои игровые дни» в статистике. Дни подменяем: настоящие записывает только игра, а цвет и подпись зависят от минут
const TODAY = '2026-11-04'; // среда
const back = (n) => new Date(Date.UTC(2026, 10, 4) - n * 86400000).toISOString().slice(0, 10);

async function open(page, answer) {
  await page.route(/\/api\/play-days$/, (route) => route.fulfill(answer));
  await openHome(page);
  await page.locator('.header-menu-btn').click();
  await page.locator('.header-menu-item', { hasText: 'Статистика' }).click();
  await expect(page.locator('.stats-section', { hasText: 'Мои игровые дни' })).toBeVisible();
}
const realGame = async (page) => {
  const res = await page.request.get('/api/games');
  const [a, b] = await res.json();
  return [a, b];
};
const week = async (page) => {
  const [a, b] = await realGame(page);
  return {
    a, b,
    json: {
      today: TODAY, since: back(5),
      days: [
        { day: back(5), games: [{ id: a.id, seconds: 29 * 60 }] },
        { day: back(4), games: [{ id: a.id, seconds: 89 * 60 }] },
        { day: back(3), games: [{ id: a.id, seconds: 179 * 60 }] },
        { day: back(1), games: [{ id: a.id, seconds: 180 * 60 }, { id: b.id, seconds: 20 }, { id: 'Gone_Game', seconds: 600 }] },
      ],
    },
  };
};
const cell = (page, day) => page.locator(`.days-cell[data-day="${day}"]`);

test('дни игры: предложение, цвет по минутам, день по щелчку, игра открывает окно, скрытая обложка размыта', async ({ page }) => {
  const { a, b, json } = await week(page);
  await open(page, { json });
  await expect(page.locator('.days-sum')).toHaveText('4 дня с игрой, 8 ч за год, больше всего подряд: 3 дн.');
  await expect(page.locator('.days-grid button.days-cell')).toHaveCount(371);

  const colour = (day) => cell(page, day).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await colour(back(2))).toBe('rgb(26, 22, 32)');
  expect(await colour(back(5))).toBe('rgb(74, 59, 28)');
  expect(await colour(back(4))).toBe('rgb(122, 96, 48)');
  expect(await colour(back(3))).toBe('rgb(201, 168, 76)');
  expect(await colour(back(1))).toBe('rgb(240, 208, 128)');

  // Первая строка столбца — понедельник (2 ноября 2026), и дата не сдвинулась поясом браузера
  await expect(cell(page, '2026-11-02')).toHaveAttribute('aria-label', '2 ноября 2026 г.: Без игры');
  const row = (day) => cell(page, day).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(await row('2026-11-02')).toBeLessThan(await row('2026-11-03'));
  expect(await row('2026-11-02')).toBe(await row('2026-10-26'));

  // Сразу показан последний день с игрой. Игры, которой нет в списке, нет и в строках
  await expect(page.locator('.days-box h4')).toContainText('3 ноября 2026 г., 3 ч 10 мин');
  await expect(page.locator('.days-game')).toHaveCount(2);
  await expect(page.locator('.days-box')).not.toContainText('Gone_Game');
  await expect(page.locator('.days-game').nth(1)).toContainText(b.displayTitle || b.title);
  await expect(page.locator('.days-game').nth(1)).toContainText('меньше минуты');

  // «Скрыть обложки»: класс ставит приложение, размытие — правило из стилей этого раздела
  await page.locator('.app-container').evaluate((el) => el.classList.add('covers-hidden'));
  expect(await page.locator('.days-thumb img').first().evaluate((el) => getComputedStyle(el).filter)).toContain('blur');
  await page.locator('.app-container').evaluate((el) => el.classList.remove('covers-hidden'));

  await cell(page, back(2)).click();
  await expect(page.locator('.days-box h4')).toContainText('Без игры');
  await expect(page.locator('.days-game')).toHaveCount(0);
  await expect(page.locator('.days-list li')).toHaveCount(4);

  await cell(page, back(5)).click();
  await expect(page.locator('.days-game')).toHaveCount(1);
  await page.locator('.days-game').click();
  await expect(page.locator('#modal-title')).toHaveText(a.displayTitle || a.title);
});

test('дни игры: клавиатура, одна остановка Tab, стрелки по дням и неделям, Enter выбирает', async ({ page }) => {
  const { json } = await week(page);
  await open(page, { json });
  await expect(page.locator('.days-grid button[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('.days-grid button[tabindex="0"]')).toHaveAttribute('data-day', TODAY);
  await page.locator('.days-grid button[tabindex="0"]').focus();

  await page.keyboard.press('ArrowRight'); // за «сегодня» идти некуда
  await expect(cell(page, TODAY)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(cell(page, back(1))).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cell(page, back(8))).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(cell(page, back(7))).toBeFocused();
  await expect(page.locator('.days-grid button[tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(cell(page, back(7))).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.days-box h4')).toContainText('Без игры');
});

test('дни игры: пусто — слова вместо сетки, сбой не молчит, окно статистики живёт', async ({ page }) => {
  await open(page, { json: { today: TODAY, since: null, days: [] } });
  await expect(page.locator('.days-sum')).toContainText('Дни считаются с первой игры');
  await expect(page.locator('.days-grid')).toHaveCount(0);

  await page.unroute(/\/api\/play-days$/);
  await page.route(/\/api\/play-days$/, (route) => route.fulfill({ status: 500, json: {} }));
  await page.keyboard.press('Escape');
  await page.locator('.header-menu-btn').click();
  await page.locator('.header-menu-item', { hasText: 'Статистика' }).click();
  await expect(page.locator('.stats-after', { hasText: 'Не удалось загрузить' })).toBeVisible();
});

test('дни игры: на широком экране снимок, весь год на месте', async ({ page }) => {
  const { a, b, json } = await week(page);
  // Год с редкими днями, как будет через несколько месяцев после обновления
  for (let n = 9; n < 300; n += 1 + (n % 5)) json.days.unshift({ day: back(n), games: [{ id: n % 2 ? a.id : b.id, seconds: (n * 37 % 240 + 1) * 60 }] });
  json.since = back(299);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, { json });
  await page.locator('.days-sum').scrollIntoViewIfNeeded();
  await imagesLoaded(page);
  await page.screenshot({ path: 'e2e/report/days-desktop.png' });
});

test.describe('телефон', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('дни игры: страница не едет вбок, сетка открыта на новой неделе', async ({ page }) => {
    const { a, b, json } = await week(page);
    for (let n = 9; n < 300; n += 1 + (n % 5)) json.days.unshift({ day: back(n), games: [{ id: n % 2 ? a.id : b.id, seconds: (n * 37 % 240 + 1) * 60 }] });
    json.since = back(299);
    await open(page, { json });
    await expect(page.locator('.days-grid')).toBeVisible();
    const sizes = await page.evaluate(() => {
      const box = document.querySelector('.days-scroll');
      const win = document.querySelector('.stats-content');
      return { page: document.documentElement.scrollWidth, view: innerWidth, win: win.scrollWidth - win.clientWidth, left: box.scrollLeft, room: box.scrollWidth - box.clientWidth };
    });
    expect(sizes.page).toBeLessThanOrEqual(sizes.view);
    expect(sizes.win).toBe(0);
    expect(sizes.room).toBeGreaterThan(0);
    expect(sizes.left).toBeGreaterThanOrEqual(sizes.room - 1);
    await page.locator('.days-sum').scrollIntoViewIfNeeded();
    await imagesLoaded(page);
    await page.screenshot({ path: 'e2e/report/days-phone.png' });
  });
});
