import { test, expect, openLibrary, openViewRow, openFilters } from '../fixtures.js';

// Группы и серии во вкладке «Библиотека». Игры подменяем поверх настоящего ответа: id настоящие, поэтому запись серии идёт на настоящий сервер

const DAY = 24 * 3600 * 1000;
// change получает настоящую игру и её номер, возвращает поля поверх неё. Игр можно попросить больше, чем в демо
async function stubGames(page, n, change) {
  await page.route(/\/api\/games(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const real = await res.json();
    const json = Array.from({ length: n }, (_, i) => {
      const base = real[i % real.length];
      const name = `Game ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))} Title`;
      return { ...base, id: i < real.length ? base.id : `${base.id}_${i}`, title: name, displayTitle: name, developer: `Dev ${i}`, shelf: null, status: '', lists: [], lastPlayed: 0, playtime: 0, ...change(base, i) };
    });
    return route.fulfill({ response: res, json });
  });
}

// Группировка — в ряду «Вид»; он остаётся открытым, пока его не закроют
const pickGroup = async (page, name) => {
  await openViewRow(page);
  await page.locator('.g-group .look-opt', { hasText: name }).click();
  await expect(page.locator('.g-group .look-opt', { hasText: name })).toHaveAttribute('aria-pressed', 'true');
};
const heads = (page) => page.locator('.library > .lib-group .lib-group-name').allInnerTexts();
const head = (page, name) => page.locator('.library > .lib-group button', { hasText: name });

test('группы: по статусу в нужном порядке, заголовок сворачивает и это помнится, у каждого способа своё', async ({ page }) => {
  const STATUS = ['done', 'dropped', 'wish', 'playing', '', ''];
  await stubGames(page, 6, (base, i) => ({ status: STATUS[i], shelf: i === 5 ? { at: 1, key: 'x', until: 0 } : null, playtime: i === 4 ? 100 : 0, lastPlayed: i === 4 ? 1000 : 0 }));
  await openLibrary(page);
  await expect(page.locator('.library > .lib-group')).toHaveCount(0);

  await pickGroup(page, 'Статус');
  // Давно игранная без статуса не теряется: своя группа перед полкой
  expect(await heads(page)).toEqual(['Играю', 'В планах', 'Пройдено', 'Брошено', 'Без статуса', 'На полке']);
  await expect(page.locator('.library > .game-card')).toHaveCount(6);

  const done = head(page, 'Пройдено');
  await expect(done).toHaveAttribute('aria-expanded', 'true');
  await done.click();
  await expect(done).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.library > .game-card')).toHaveCount(5);
  await expect(page.locator('.library-info')).toContainText('Показано 5 из 6');

  await page.reload();
  await expect(head(page, 'Пройдено')).toHaveAttribute('aria-expanded', 'false');
  await openViewRow(page);
  await expect(page.locator('.g-group .look-opt[aria-pressed="true"]')).toHaveText('Статус');

  // У другого способа свёрнутое своё, а счёт идёт за фильтрами
  await pickGroup(page, 'Дата');
  await expect(page.locator('.library > .game-card')).toHaveCount(6);
  await pickGroup(page, 'Статус');
  await expect(page.locator('.library > .game-card')).toHaveCount(5);
  await page.locator('.status-chip, .chip', { hasText: 'В планах' }).first().click();
  expect(await heads(page)).toEqual(['В планах']);
  await expect(page.locator('.library > .lib-group .lib-group-n')).toHaveText('1');
});

test('группы: по дате и по подборке; игра из двух подборок стоит дважды, а считается один раз', async ({ page }) => {
  const now = Date.now();
  const AGES = [1, 2, 20, 100, 400, 500];
  const LISTS = [['Бета', 'Альфа'], ['Альфа'], ['Бета'], [], [], []];
  await stubGames(page, 6, (base, i) => ({ addedAt: now - AGES[i] * DAY, lists: LISTS[i] }));
  await openLibrary(page);

  await pickGroup(page, 'Дата');
  expect(await heads(page)).toEqual(['За неделю', 'За месяц', 'За полгода', 'Раньше']);
  await expect(page.locator('.library > .lib-group .lib-group-n')).toHaveText(['2', '1', '1', '2']);

  await pickGroup(page, 'Подборка');
  expect(await heads(page)).toEqual(['Альфа', 'Бета', 'Без подборки']);
  await expect(page.locator('.library > .game-card')).toHaveCount(7);
  await expect(page.locator('.library-info')).toContainText('Показано 6 из 6');

  // Выбор: обе карточки игры отмечаются вместе, «Выбрать все» считает её один раз
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await expect(page.locator('.select-bar')).toBeVisible();
  const twice = page.locator('.library > .game-card').first();
  const id = await twice.getAttribute('data-game');
  await twice.click();
  await expect(page.locator(`.library > .game-card.picked[data-game="${id}"]`)).toHaveCount(2);
  await expect(page.locator('.select-count')).toContainText('1');
  await page.locator('.select-bar button', { hasText: 'Выбрать все' }).click();
  await expect(page.locator('.select-count')).toContainText('6');
  await page.locator('.select-bar button', { hasText: 'Снять выбор' }).click();

  // Диапазон идёт по экрану: от первой карточки «Бета» до следующей за ней, без игр из других групп
  const beta = page.locator('.library > .lib-group', { hasText: 'Бета' });
  const firstBeta = beta.locator('xpath=following-sibling::*[1]');
  const secondBeta = beta.locator('xpath=following-sibling::*[2]');
  await firstBeta.click();
  await secondBeta.click({ modifiers: ['Shift'] });
  await expect(page.locator('.select-count')).toContainText('2');

  // Свёрнутая группа в «Выбрать все» не входит: действие не заденет игры, которых нет на экране
  await page.locator('.select-bar button', { hasText: 'Снять выбор' }).click();
  await head(page, 'Без подборки').click();
  await page.locator('.select-bar button', { hasText: 'Выбрать все' }).click();
  await expect(page.locator('.select-count')).toContainText('3');
  await expect(page.locator('.select-bar button', { hasText: 'Выбрать все' })).toBeDisabled();
});

test('группы: страницы считают карточки, свёрнутые не считаются, столбца букв нет, стрелки идут через заголовок', async ({ page }) => {
  await stubGames(page, 80, (base, i) => ({ status: i < 30 ? 'done' : 'wish', addedAt: 1000 + i }));
  await page.addInitScript(() => localStorage.setItem('rpg_sort', 'name'));
  await openLibrary(page);
  await expect(page.locator('.lib-letters')).toBeVisible();
  await pickGroup(page, 'Статус');
  await expect(page.locator('.lib-letters')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  expect((await heads(page))[0]).toBe('В планах');
  const open = await page.locator('.library > .game-card').count();
  expect(open % 24).toBe(0);
  await head(page, 'В планах').click();
  // Свёрнули первую — на странице карточки следующей, а не пусто
  await expect(page.locator('.library > .game-card').first()).toBeVisible();
  await expect(page.locator('.library > .lib-group')).toHaveCount(2);
  await head(page, 'В планах').click();
  await expect(head(page, 'В планах')).toHaveAttribute('aria-expanded', 'true');

});

test('группы: стрелка вниз идёт через заголовок в следующую группу', async ({ page }) => {
  await stubGames(page, 6, (base, i) => ({ status: i < 2 ? 'wish' : 'done', addedAt: 1000 + i }));
  await openLibrary(page);
  await pickGroup(page, 'Статус');
  const inDone = page.locator('.library > .lib-group', { hasText: 'Пройдено' }).locator('xpath=following-sibling::*[1]');
  const id = await inDone.getAttribute('data-game');
  await page.locator('.library > .game-card').first().focus();
  await expect(page.locator('.library > .game-card').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => document.activeElement?.dataset?.game)).toBe(id);
});

test('группы: все четыре вида, первый ряд виден вместе с заголовком, запрет при теге картинок и ряд панели', async ({ page }) => {
  await stubGames(page, 30, (base, i) => ({ status: i % 2 ? 'done' : 'wish', addedAt: 1000 + i, lists: i < 3 ? ['Один'] : [], textLang: i % 2 ? { langs: ['en'], main: 'en' } : { langs: ['ja'], main: 'ja' } }));
  await page.route(/\/api\/pictures\/games$/, (route) => route.fulfill({ json: { covered: 1, tags: ['maid'], games: { Starfall_Inn: [0, 5] } } }));
  await page.route(/\/api\/pictures\/status/, (route) => route.fulfill({ json: { state: 'off', analysis: { on: false, state: 'off' }, tagged: true } }));
  await openLibrary(page);
  // Панель на 1440: сортировка рядом с «Фильтры», остальные списки (в том числе подборки и теги картинок) — одним рядом под ними
  await openFilters(page);
  const tops = await page.evaluate(() => ['.lang-filter', '.list-filter', '.pic-tags-tool'].map((s) => document.querySelector(s)?.getBoundingClientRect().top));
  expect(tops.every((x) => x !== undefined)).toBe(true);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(12);
  const bar = await page.evaluate(() => ['.search-box', '.filters-toggle', '.sort-order'].map((s) => document.querySelector(`.controls-zone ${s}`).getBoundingClientRect().top));
  expect(Math.max(...bar) - Math.min(...bar)).toBeLessThan(12);

  await pickGroup(page, 'Статус');
  const first = page.locator('.library > .game-card').first();
  const inWindow = async () => (await first.boundingBox()).y + (await first.boundingBox()).height <= 900;
  expect(await inWindow()).toBe(true);
  await openViewRow(page);
  for (const name of ['Описание', 'Список', 'Стена']) {
    await page.locator('.g-view').getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.library > .lib-group').first()).toBeVisible();
    const width = await page.locator('.library > .lib-group').first().evaluate((el) => el.offsetWidth / el.parentElement.clientWidth);
    expect(width).toBeGreaterThan(0.9);
  }
  await page.locator('.g-view').getByRole('button', { name: 'Сетка', exact: true }).click();

  // Порядок задаёт тег картинок: группы не действуют, выбор выключен, а запомненный вернётся
  await page.locator('.pic-tags-tool button').click();
  await page.locator('.tag-row', { hasText: 'горничная' }).locator('.tag-row-main').click();
  // Выключено, а не спрятано: с короткой причиной
  await expect(page.locator('.g-group .look-opt').first()).toBeDisabled();
  await expect(page.locator('.g-group')).toContainText('Порядок задаёт тег картинок');
  // Нажатой выглядит только «Нет»: запомненный выбор не действует, и читалка не должна говорить обратного
  await expect(page.locator('.g-group .look-opt[aria-pressed="true"]')).toHaveText(['Нет']);
  // «Подборка» есть, потому что у игр есть подборка
  await expect(page.locator('.g-group .look-opt')).toHaveCount(4);
  await expect(page.locator('.library > .lib-group')).toHaveCount(0);
  await page.locator('.tag-row', { hasText: 'горничная' }).locator('.tag-row-main').click();
  await expect(page.locator('.library > .lib-group').first()).toBeVisible();
});

// Подписи карточек для набора названий: [название, разработчик, что ждём]
const TITLES = [
  // Настоящие части: цифра, римская, знак Ⅱ, широкая цифра — одно и то же имя в разном написании
  ['Harvest Garden', 'Moon', 'Часть 1 из 3'],
  ['HARVEST  GARDEN 2', 'Moon', 'Часть 2 из 3'],
  ['Harvest Garden III', 'Moon', 'Часть 3 из 3'],
  ['Lost Voyage Part 1', '', 'Часть 1 из 4'],
  ['Lost Voyage Vol.2 ~Sea~', '', 'Часть 2 из 4'],
  ['Lost Voyage: ep 3', '', 'Часть 3 из 4'],
  ['Lost Voyage - Chapter 4', '', 'Часть 4 из 4'],
  // Японские числа и полноширинная цифра
  ['星降る宿物語 第一話', '月', 'Часть 1 из 3'],
  ['星降る宿物語 第二話', '月', 'Часть 2 из 3'],
  ['星降る宿物語３', '月', 'Часть 3 из 3'],
  ['Moon Cat Ⅱ', '', 'Часть 2 из 2'],
  ['Moon Cat', '', 'Часть 1 из 2'],
  // Версия — не часть
  ['Copper Road v1.2', '', ''],
  ['Copper Road v1.3', '', ''],
  ['Pine Valley 1.2', '', ''],
  ['Pine Valley Ver.2', '', ''],
  // Один номер — копии, не серия
  ['Same Story 2', '', ''],
  ['Same Story II', '', ''],
  // Разные разработчики
  ['Night Train', 'North', ''],
  ['Night Train 2', 'South', ''],
  // Короткое имя
  ['Eve', '', ''],
  ['Eve 2', '', ''],
  // Нет пары
  ['Alone Story 2', '', ''],
  // Большое число — не номер части
  ['Project 2025', '', ''],
  ['Project 2026', '', ''],
];

test('серии: кто считается частью, а кто нет; на стене подписи нет', async ({ page }) => {
  await stubGames(page, TITLES.length, (base, i) => ({ displayTitle: TITLES[i][0], title: TITLES[i][0], developer: TITLES[i][1], series: '', addedAt: 100000 - i }));
  await openLibrary(page);
  await page.waitForFunction((n) => document.querySelectorAll('.library > .game-card').length >= n, 24);
  for (const [name, , want] of TITLES.slice(0, 24)) {
    const card = page.locator('.library > .game-card').filter({ has: page.locator('.card-title', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    if (want) await expect(card.locator('.card-part'), name).toHaveText(want);
    else await expect(card.locator('.card-part'), name).toHaveCount(0);
  }
  await openViewRow(page);
  await page.locator('.g-view').getByRole('button', { name: 'Стена', exact: true }).click();
  await expect(page.locator('.library > .game-card').first()).toBeVisible();
  await expect(page.locator('.card-part:visible')).toHaveCount(0);
  await expect(page.locator('.library .card-part')).toHaveCount(0);
  await page.locator('.g-view').getByRole('button', { name: 'Список', exact: true }).click();
  await expect(page.locator('.library .card-part').first()).toBeVisible();
});

// [название, разработчик, поправка владельца, что ждём]. Копии — первыми: у них настоящие id, окно игры откроется
const SERIES_EDGES = [
  ['Dark Hollow', '', '', 'Часть 1 из 2'],
  ['Dark Hollow 2', '', '', 'Часть 2 из 2'],
  ['Dark Hollow 2', '', '', 'Часть 2 из 2'],
  // Буква на конце — не номер, пока нет части с другим номером
  ['Project X', '', '', ''],
  ['Project', '', '', ''],
  ['Mission Zero', '', '', 'Часть 1 из 3'],
  ['Mission Zero 2', '', '', 'Часть 2 из 3'],
  ['Mission Zero X', '', '', 'Часть 3 из 3'],
  ['Forest Wind I', '', '', 'Часть 1 из 2'],
  ['Forest Wind II', '', '', 'Часть 2 из 2'],
  // Копия, присоединившаяся к ручной серии, тоже не лишняя часть
  ['Iron Bell', '', 'Iron Bell', 'Часть 1 из 2'],
  ['Iron Bell 2', '', 'Iron Bell', 'Часть 2 из 2'],
  ['Iron Bell 2', '', '', 'Часть 2 из 2'],
  // Ручная серия с игрой без разработчика не втягивает чужую студию
  ['Cold Lake', '', 'Cold Lake', 'Часть 1 из 2'],
  ['Cold Lake 2', 'North', 'Cold Lake', 'Часть 2 из 2'],
  ['Cold Lake 3', 'South', '', 'Часть 1 из 2'],
  ['Cold Lake 4', 'South', '', 'Часть 2 из 2'],
];

test('серии: копии — одна часть, буква на конце не номер, ручная серия не берёт чужую студию', async ({ page }) => {
  await stubGames(page, SERIES_EDGES.length, (base, i) => ({ displayTitle: SERIES_EDGES[i][0], title: SERIES_EDGES[i][0], developer: SERIES_EDGES[i][1], series: SERIES_EDGES[i][2], addedAt: 100000 - i }));
  await openLibrary(page);
  await expect(page.locator('.library > .game-card')).toHaveCount(SERIES_EDGES.length);
  const seen = await page.locator('.library > .game-card').evaluateAll((cards) => cards.map((c) => [c.querySelector('.card-title').textContent, c.querySelector('.card-part')?.textContent || '']));
  expect(seen.sort()).toEqual(SERIES_EDGES.map(([name, , , want]) => [name, want]).sort());

  // В окне копии две части, и отмечена именно она
  const copy = page.locator('.library > .game-card').filter({ has: page.locator('.card-title', { hasText: /^Dark Hollow 2$/ }) }).nth(1);
  await copy.click();
  await expect(page.locator('.game-series .series-part')).toHaveCount(2);
  await expect(page.locator('.game-series .series-part.current')).toContainText('Dark Hollow 2');
});

test('серии: блок в окне, «Это не серия» и «Добавить в серию» у владельца, сбой ничего не меняет', async ({ page }) => {
  const NAMES = ['Tale of Rain', 'Tale of Rain 2', 'Tale of Rain 3', 'Other Thing'];
  await stubGames(page, 4, (base, i) => ({ displayTitle: NAMES[i], title: NAMES[i], developer: '', series: base.series, addedAt: 1000 + i }));
  await openLibrary(page);
  const cardOf = (name) => page.locator('.library > .game-card').filter({ has: page.locator('.card-title', { hasText: new RegExp(`^${name}$`) }) });
  await expect(cardOf('Tale of Rain 2').locator('.card-part')).toHaveText('Часть 2 из 3');
  await cardOf('Tale of Rain 2').locator('.card-title').click();
  const block = page.locator('.game-series');
  await expect(block.locator('.series-part')).toHaveCount(3);
  await expect(block.locator('.series-part.current')).toContainText('Tale of Rain 2');

  // Другая часть открывает своё окно
  await block.locator('button.series-part', { hasText: /^Tale of Rain 3$/ }).click();
  await expect(block.locator('.series-part.current')).toContainText('Tale of Rain 3');

  // Минус одна часть из трёх: у оставшихся двух серия есть
  await block.locator('.series-not').click();
  await expect(block.locator('.series-part')).toHaveCount(0);
  await expect(block).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(cardOf('Tale of Rain').locator('.card-part')).toHaveText('Часть 1 из 2');
  await expect(cardOf('Tale of Rain 3').locator('.card-part')).toHaveCount(0);

  // Минус ещё одна: блок уходит и у другой
  await cardOf('Tale of Rain 2').locator('.card-title').click();
  await block.locator('.series-not').click();
  await expect(block.locator('.series-part')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await cardOf('Tale of Rain').locator('.card-title').click();
  await expect(block.locator('.series-part')).toHaveCount(0);

  // Вторая запись не удалась: тост, и серии нет ни у той, ни у другой
  // Без серии блока нет, «Добавить в серию» — в меню «⋯»; заметка и обзор при этом на месте
  await page.locator('.modal-more-btn').click();
  await page.locator('.modal-more-item', { hasText: 'Добавить в серию' }).click();
  const target = block.locator('.req-pick-game', { hasText: 'Other Thing' });
  await target.click();
  const otherId = await target.getAttribute('data-game');
  await page.route(`**/api/games/${encodeURIComponent(otherId)}/series`, (route) => route.fulfill({ status: 500, json: { error: 'x' } }));
  await block.locator('.req-pick-save').click();
  await expect(page.locator('.toast')).toContainText('Не удалось изменить серию');
  await expect(block.locator('.series-part')).toHaveCount(0);
  await page.unroute(`**/api/games/${encodeURIComponent(otherId)}/series`);

  // Теперь выходит: обе в одной серии, блок на месте
  await block.locator('.req-pick-save').click();
  await expect(block.locator('.series-part')).toHaveCount(2);
  await expect(block.locator('.req-pick')).toHaveCount(0);
  await expect(block.locator('.series-part.current')).toContainText('Tale of Rain');
  // Под «Скрыть обложки» миниатюры размыты
  await page.keyboard.press('h');
  await expect(block.locator('.series-thumb img').first()).toHaveCSS('filter', /blur/);
  await page.keyboard.press('h');

  // Сервер помнит: перезагрузка показывает то же
  await page.reload();
  await expect(cardOf('Other Thing').locator('.card-part')).toHaveText(/Часть \d из 2/);
  // Другие тесты смотрят на те же строки демо: возвращаем как было
  const games = await page.evaluate(() => fetch('/api/games').then((r) => r.json()));
  for (const g of games) if (g.series) await page.request.post(`/api/games/${encodeURIComponent(g.id)}/series`, { data: { series: '' } });
});

test('серии: у человека подпись и блок есть, кнопок нет', async ({ page }) => {
  const NAMES = ['Tale of Snow', 'Tale of Snow 2'];
  await stubGames(page, 2, (base, i) => ({ displayTitle: NAMES[i], title: NAMES[i], developer: '', series: '' }));
  await page.route('**/api/me', async (route) => {
    const res = await route.fetch();
    const me = await res.json();
    return route.fulfill({ response: res, json: { ...me, isOwner: false, shared: true } });
  });
  await openLibrary(page);
  await page.locator('.library > .game-card').first().locator('.card-title').click();
  await expect(page.locator('.game-series .series-part')).toHaveCount(2);
  await expect(page.locator('.series-not')).toHaveCount(0);
  await expect(page.locator('.series-add')).toHaveCount(0);
  await page.locator('.modal-more-btn').click();
  await expect(page.locator('.modal-more-item', { hasText: 'Добавить в серию' })).toHaveCount(0);
});
