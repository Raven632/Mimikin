import { test, expect, openLibrary, menu, apiGames } from '../fixtures.js';
import { mockScene } from '../scene.js';

// Поиск по репликам: полка «В репликах» под поиском библиотеки, окно «Сцены» из меню, плеер сразу на найденной реплике.
// Без запроса окно показывает все сцены библиотеки. Ответы и сцену подставляем — в демо-играх сценариев нет
const KEY = 'events/00001/Night scene';
const hl = (text, word) => { const i = text.toLowerCase().indexOf(word); return i < 0 ? [] : [[i, i + word.length]]; };
const line = (stop, text, extra = {}) => ({ stop, lang: 'en', who: '', text, hl: hl(text, 'муж'), pic: 'pic1.png', ...extra });
const answer = (scenes, extra = {}) => ({ total: scenes.reduce((n, s) => n + s.lines.length, 0), games: [...new Set(scenes.map((s) => s.game))].map((id) => ({ id, lines: scenes.filter((s) => s.game === id).length, scenes: scenes.filter((s) => s.game === id).length })), indexed: 3, library: 4, building: null, scenes, ...extra });
const night = { game: 'Starfall_Inn', key: KEY, n: 0, kind: 'cg', title: 'Ночная сцена', cover: 'pic0.png', lines: [line(3, 'Мой муж дома')], more: 0 };
const steps = (texts) => ({ files: ['pic0.png', 'pic1.png'], lang: 'en', langs: [{ code: 'orig', orig: true }, { code: 'en', n: texts.length }], steps: [{ k: 'pic', i: 0 }, ...texts.map((text) => ({ k: 'say', who: '', text }))] });
const searchRoute = (page, reply) => {
  const asked = [];
  page.route(/\/api\/lines\/search\?/, (route) => { const url = new URL(route.request().url()); asked.push(url); return route.fulfill({ json: reply(url) }); });
  return asked;
};

test.describe('поиск по репликам', () => {
  test('полка «В репликах» под поиском: подсветка найденного, плеер сразу на этой реплике и на её языке, ← — предыдущая', async ({ page }) => {
    const asked = searchRoute(page, () => answer([night]));
    const { urls } = await mockScene(page, { scene: () => steps(['Line 1', 'Line 2', 'Line 3', 'Мой муж дома', 'Line 5']) });
    await openLibrary(page);
    await page.locator('.search-box input').fill('муж');
    const shelf = page.locator('.line-shelf');
    await expect(shelf.locator('.shelf-title')).toContainText('В репликах');
    await expect(shelf.locator('.shelf-count')).toHaveText('1 реплика в 1 игре');
    await expect(shelf.locator('.line-tile .line-hit')).toHaveText('муж');
    await expect(shelf.locator('.line-tile .gallery-name')).toHaveText('Starfall Inn');
    expect(asked.at(-1).searchParams.get('q')).toBe('муж');
    await shelf.locator('.line-tile').click();
    await expect(page.locator('.scene')).toBeVisible();
    await expect(page.locator('.scene-text')).toHaveText('Мой муж дома');
    expect(urls[0].searchParams.get('lang')).toBe('en');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.scene-text')).toHaveText('Line 3');
  });

  test('галерею пересобрали и номера сдвинулись — плеер всё равно встаёт на реплику с тем же текстом', async ({ page }) => {
    searchRoute(page, () => answer([night]));
    await mockScene(page, { scene: () => steps(['Новая первая', 'Line 1', 'Line 2', 'Line 3', 'Мой муж дома', 'Line 5']) });
    await openLibrary(page);
    await page.locator('.search-box input').fill('муж');
    await page.locator('.line-shelf .line-tile').click();
    await expect(page.locator('.scene-text')).toHaveText('Мой муж дома');
  });

  test('окно из меню: группы по играм, «Ещё N сцен» спрашивает только эту игру; «Скрыть обложки» прячет реплики и полку', async ({ page }) => {
    const ids = (await apiGames(page)).map((g) => g.id).filter((id) => id !== 'Starfall_Inn');
    const five = Array.from({ length: 5 }, (_, i) => ({ ...night, key: `${KEY}${i}`, title: `Сцена ${i + 1}`, lines: [line(i, `Муж номер ${i + 1}`)] }));
    const other = { ...night, game: ids[0], title: 'Чужая', lines: [line(0, 'Где мой муж?', { choice: true })] };
    const asked = searchRoute(page, (url) => (url.searchParams.get('game') === 'Starfall_Inn' ? answer([...five, { ...night, key: `${KEY}5`, title: 'Сцена 6' }]) : answer([...five, other], { games: [{ id: 'Starfall_Inn', lines: 9, scenes: 6 }, { id: ids[0], lines: 1, scenes: 1 }] })));
    await openLibrary(page);
    await menu(page, 'Сцены');
    const win = page.locator('.line-search');
    // Без запроса — все сцены библиотеки; у демо-игр галерей нет (настоящий /api/scenes)
    await expect(win.locator('.state-title')).toHaveText('Сцен пока нет');
    await win.locator('.search-box input').fill('муж');
    await expect(win.locator('.pics-covered')).toHaveText('6 реплик в 2 играх. Искали в 3 играх из 4.');
    const first = win.locator('.line-group').first();
    await expect(first.locator('.line-group-title')).toContainText('Starfall Inn');
    await expect(first.locator('.line-tile')).toHaveCount(4);
    await expect(win.locator('.line-group').nth(1).locator('.gallery-badge.choice')).toBeVisible();
    await first.locator('.line-more').click();
    await expect(first.locator('.line-tile')).toHaveCount(6);
    expect(asked.at(-1).searchParams.get('game')).toBe('Starfall_Inn');
    await expect(first.locator('.line-more')).toHaveCount(0);
    // «Скрыть обложки» (H вне поля ввода): в окне текст реплик спрятан
    await win.locator('.line-group-title').first().click();
    await page.keyboard.press('h');
    await expect(win).toHaveClass(/covers-hidden/);
    await expect(win.locator('.line-tile .tile-quote').first()).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(win).toHaveCount(0);
    // и полки под поиском библиотеки нет
    await page.locator('.search-box input').fill('муж');
    // Запрос до полки дошёл бы через паузу 450 мс — ждём с запасом
    await page.waitForTimeout(1200);
    await expect(page.locator('.line-shelf')).toHaveCount(0);
  });

  test('«Все» на полке открывает окно с тем же запросом; короткий запрос не ищется', async ({ page }) => {
    const asked = searchRoute(page, () => answer([night]));
    await openLibrary(page);
    await page.locator('.search-box input').fill('он');
    await page.waitForTimeout(800);
    expect(asked.length).toBe(0);
    await page.locator('.search-box input').fill('муж');
    await page.locator('.line-shelf .shelf-all').click();
    const win = page.locator('.line-search');
    await expect(win.locator('.search-box input')).toHaveValue('муж');
    await expect(win.locator('.line-tile')).toHaveCount(1);
  });

  test('окно «Сцены»: панель тегов — выбор и исключение уходят в запрос и в «Смотреть подряд», числа с сервера; без разметки панель объясняет', async ({ page }) => {
    const asked = [];
    let tagged = true;
    await page.route(/\/api\/scenes(\?|$)/, (route) => {
      const url = new URL(route.request().url());
      asked.push(url.searchParams);
      if (url.searchParams.get('queue')) return route.fulfill({ json: { queue: [], more: false } });
      const yes = url.searchParams.getAll('tag');
      const total = yes.length ? 1 : 3;
      const rows = Array.from({ length: total }, (_, i) => ({ key: `${KEY}${i}`, kind: 'cg', n: 0, title: `Сцена ${i + 1}`, sum: { l: 3 }, cover: 'pic0.png' }));
      return route.fulfill({ json: { total, counts: { all: total, scenes: total, dialogue: 0 }, hidden: [], tags: tagged ? [{ tag: 'sword', n: total }, { tag: 'maid', n: yes.length ? 1 : 2 }] : [], games: [{ id: 'Starfall_Inn', count: total, rows }] } });
    });
    await mockScene(page, { scene: () => steps(['Первая сцена']) });
    await openLibrary(page);
    await menu(page, 'Сцены');
    const win = page.locator('.line-search');
    await expect(win.locator('.scene-tile')).toHaveCount(3);
    const open = win.locator('.tag-tool');
    await open.click();
    const panel = page.locator('.tag-panel');
    await expect(panel.locator('.tag-row-name')).toHaveText(['меч', 'горничная']);
    await panel.locator('.tag-row', { hasText: 'меч' }).locator('.tag-row-main').click();
    await expect(win.locator('.scene-tile')).toHaveCount(1);
    await expect.poll(() => asked.at(-1).getAll('tag')).toEqual(['sword']);
    await expect(panel.locator('.tag-apply')).toHaveText('Показать 1 сцену');
    await panel.locator('.tag-row', { hasText: 'горничная' }).locator('.tag-row-no').click();
    await expect.poll(() => asked.at(-1).getAll('no')).toEqual(['maid']);
    await panel.locator('.tag-apply').click();
    await expect(open).toContainText('2');
    await expect(win.locator('.tag-picked-chip')).toHaveCount(2);
    // «Смотреть подряд» — с теми же тегами
    await win.locator('.gallery-play', { hasText: 'Смотреть подряд' }).click();
    await expect.poll(() => asked.at(-1).get('queue')).toBe('order');
    expect(asked.at(-1).getAll('tag')).toEqual(['sword']);
    expect(asked.at(-1).getAll('no')).toEqual(['maid']);
    await win.locator('.tag-reset', { hasText: 'Сбросить' }).click();
    await expect(win.locator('.scene-tile')).toHaveCount(3);
    // Ни одна игра ещё не размечена: кнопка на месте, панель говорит почему
    tagged = false;
    await win.locator('.chip', { hasText: 'С голосом' }).click();
    await expect.poll(() => asked.at(-1).get('voice')).toBe('1');
    await open.click();
    await expect(panel.locator('.tag-none')).toHaveText('Теги появятся, когда сервер разберёт картинки игр');
  });

  test('окно «Сцены» без запроса: все сцены по играм, вкладка и отбор — в запросе, «Ещё N сцен» — вся игра; «Смотреть подряд» идёт через игры порциями, Esc — снова окно', async ({ page }) => {
    const other = (await apiGames(page)).map((g) => g.id).find((id) => id !== 'Starfall_Inn');
    const row = (i) => ({ key: `${KEY}${i}`, kind: 'cg', n: 0, title: `Сцена ${i + 1}`, sum: { l: 3 + i }, cover: 'pic0.png' });
    const asked = [];
    await page.route(/\/api\/scenes(\?|$)/, (route) => {
      const url = new URL(route.request().url());
      asked.push(url);
      const p = url.searchParams;
      // «Подряд» — порциями: первая с more, вторую плеер просит сам (from)
      const two = [{ game: 'Starfall_Inn', key: `${KEY}0`, n: 0, title: 'Сцена 1' }, { game: other, key: 'events/00009/Other', n: 0, title: 'Чужая' }];
      if (p.get('queue') === 'order') return route.fulfill({ json: p.get('from') === '1' ? { queue: [two[1]], more: false } : { queue: [two[0]], more: true } });
      if (p.get('queue')) return route.fulfill({ json: { queue: two, more: false } });
      const eight = Array.from({ length: 8 }, (_, i) => row(i));
      return route.fulfill({ json: { total: 9, counts: { all: 11, scenes: 9, dialogue: 2 }, games: [
        { id: 'Starfall_Inn', count: 8, rows: p.get('game') ? eight : eight.slice(0, Number(p.get('per'))) },
        ...(p.get('game') ? [] : [{ id: other, count: 1, rows: [{ ...row(0), key: 'events/00009/Other', title: 'Чужая' }] }]),
      ] } });
    });
    const { urls } = await mockScene(page, { scene: () => steps(['Первая сцена']) });
    const otherUrls = [];
    await page.route(new RegExp(`/api/gallery/${other}/scene\\?`), (route) => { otherUrls.push(new URL(route.request().url())); return route.fulfill({ json: steps(['Чужая сцена']) }); });
    await openLibrary(page);
    await menu(page, 'Сцены');
    const win = page.locator('.line-search');
    const bar = win.locator('.lib-scenes-bar');
    await expect(win.locator('.pics-covered')).toHaveText('9 сцен в 2 играх');
    await expect(bar.locator('.chip')).toHaveText([/Сцены\s*9/, /Диалоги\s*2/, 'С голосом', 'С анимацией']);
    expect(asked[0].searchParams.get('kind')).toBe('scenes');
    // У игры — ряд плиток (1440 px — шесть), остальное — «Ещё 2 сцены»: спрашивает всю игру
    const first = win.locator('.line-group').first();
    await expect(first.locator('.line-group-title')).toContainText('Starfall Inn');
    await expect(first.locator('.scene-tile')).toHaveCount(6);
    await first.locator('.line-more').click();
    await expect(first.locator('.scene-tile')).toHaveCount(8);
    expect(asked.at(-1).searchParams.get('game')).toBe('Starfall_Inn');
    // Вкладка и отбор уходят в запрос
    await bar.locator('.chip', { hasText: 'Диалоги' }).click();
    await expect.poll(() => asked.at(-1).searchParams.get('kind')).toBe('dialogue');
    await bar.locator('.chip', { hasText: 'С голосом' }).click();
    await expect(bar.locator('.chip', { hasText: 'С голосом' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => asked.at(-1).searchParams.get('voice')).toBe('1');
    // Плитка — сцена поверх окна; Esc — снова окно
    await win.locator('.line-group').first().locator('.scene-tile').first().click();
    await expect(page.locator('.scene-text')).toHaveText('Первая сцена');
    expect(urls.at(-1).searchParams.get('key')).toBe(`${KEY}0`);
    await page.keyboard.press('Escape');
    await expect(page.locator('.scene')).toHaveCount(0);
    await expect(win).toBeVisible();
    // «Смотреть подряд»: очередь с тем же отбором; после конца сцены — следующая, из другой игры; последняя закрывает плеер
    await bar.locator('.gallery-play', { hasText: 'Смотреть подряд' }).click();
    await expect(page.locator('.scene-text')).toHaveText('Первая сцена');
    expect([asked.at(-1).searchParams.get('queue'), asked.at(-1).searchParams.get('kind'), asked.at(-1).searchParams.get('voice')]).toEqual(['order', 'dialogue', '1']);
    for (const text of ['Первая сцена', 'Чужая сцена']) {
      await expect(page.locator('.scene-text')).toHaveText(text);
      await page.keyboard.press('Space');
      await expect(page.locator('.scene-end')).toBeVisible();
      await page.keyboard.press('Space');
    }
    expect(otherUrls[0].searchParams.get('key')).toBe('events/00009/Other');
    expect(asked.filter((u) => u.searchParams.get('queue') === 'order').map((u) => u.searchParams.get('from'))).toEqual([null, '1']);
    await expect(page.locator('.scene')).toHaveCount(0);
    await expect(win).toBeVisible();
    // «Вперемешку» — очередь вразброс
    await bar.locator('.gallery-play', { hasText: 'Вперемешку' }).click();
    await expect(page.locator('.scene')).toBeVisible();
    expect(asked.at(-1).searchParams.get('queue')).toBe('random');
    await page.keyboard.press('Escape');
    // Слово в поле — поиск по репликам, ряда отбора нет
    searchRoute(page, () => answer([night]));
    await win.locator('.search-box input').fill('муж');
    await expect(win.locator('.line-tile')).toHaveCount(1);
    await expect(bar).toHaveCount(0);
  });
});
