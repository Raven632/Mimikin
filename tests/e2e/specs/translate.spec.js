import { test, expect, openLibrary, openGame, openTab } from '../fixtures.js';

// «Настройки перевода» — окно с разделами; tab — какой раздел открыть
const settings = async (page, tab) => {
  await page.locator('.modal-content .tl-settings-btn').click();
  const win = page.locator('.tl-window');
  await expect(win).toBeVisible();
  if (tab) await win.locator('.settings-tab', { hasText: tab }).click();
  return win;
};

// «Перевод» в окне игры. Служб перевода в тестах нет — ответы сервера подставляем
test('перевод игры: выбрать язык — с вопросом, сколько уйдёт службе; ход перевода, пауза', async ({ page }) => {
  let state = { lang: '', state: '', done: 0, total: 0, failed: 0, engine: '', error: '', engines: ['deepl'] };
  const sent = [];
  await page.route(/\/api\/games\/Starfall_Inn\/translation\/estimate\?lang=en$/, (route) => route.fulfill({ json: { total: 480, todo: 360, chars: 9000, engine: 'deepl', left: 400000 } }));
  await page.route(/\/api\/games\/Starfall_Inn\/translation(\/\w+)?$/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST') {
      sent.push([url.pathname.split('/').pop(), req.postDataJSON?.() || null]);
      if (url.pathname.endsWith('/translation')) state = { ...state, ...req.postDataJSON(), state: 'running', done: 120, total: 480, engine: 'deepl' };
      if (url.pathname.endsWith('/pause')) state = { ...state, state: 'paused' };
    }
    return route.fulfill({ json: state });
  });
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await openTab(page, 'Перевод');
  // В карточке — одна строка: язык выпадающим списком, ход, «Пауза», «Настройки перевода»
  const bar = page.locator('.modal-content .tl-bar');
  // Язык — тот же Picker, что у жанров: кнопка с названием, список строк под ней
  const select = bar.locator('.tl-select .picker-btn');
  const choose = async (name) => { await select.click(); await page.locator('.picker-opt', { hasText: name }).click(); };
  await select.click();
  await expect(page.locator('.picker-opt .picker-name')).toHaveText(['Выкл', 'English', 'Русский', 'Deutsch']);
  await page.keyboard.press('Escape');
  await expect(select).toHaveText('Выкл');
  // Нажал случайно — «Отмена»: ничего не включилось и не ушло на сервер
  await choose('English');
  await expect(page.locator('.confirm-box')).toContainText('В DeepL уйдёт 360 строк — около 9');
  await expect(page.locator('.confirm-box')).toContainText('осталось около 400');
  await page.locator('.confirm-cancel').click();
  await expect(select).toHaveText('Выкл');
  expect(sent).toEqual([]);
  await choose('English');
  await page.locator('.confirm-ok').click();
  await expect(page.locator('.toast.show')).toContainText('со следующего запуска');
  await expect(select).toHaveText('English');
  await expect(bar.locator('.tl-state').first()).toHaveText('Переводится: 120 из 480 строк, deepl');
  await bar.locator('button', { hasText: 'Пауза' }).click();
  await expect(bar.locator('.tl-state').first()).toHaveText('На паузе: 120 из 480');
  // В окне — то же: языки чипами, ход, заметка
  const win = await settings(page);
  await expect(win.locator('.tl-langs .chip.active')).toHaveText('English');
  await expect(win).toContainText('Игра на диске не меняется');
  await expect(win.locator('.settings-tab')).toHaveText(['Язык и ход', 'Проверка перевода', 'Строки', 'Текст на картинках', 'Проверка в игре', 'Файл перевода']);
  // Escape закрывает окно, а окно игры остаётся; открывается снова — и снова закрывается
  await page.keyboard.press('Escape');
  await expect(page.locator('.tl-window')).toHaveCount(0);
  await expect(page.locator('.modal-content')).toBeVisible();
  const again = await settings(page, 'Файл перевода');
  await expect(again.locator('.settings-tab.active')).toHaveText('Файл перевода');
  await again.locator('.modal-close').click();
  await expect(page.locator('.tl-window')).toHaveCount(0);
  await expect(page.locator('.modal-content')).toBeVisible();
  expect(sent.map((s) => s[0])).toEqual(['translation', 'pause']);
  expect(sent[0][1]).toEqual({ lang: 'en' });
});

test('перевод игры: ключей служб нет — подсказка, куда их вписать', async ({ page }) => {
  const state = { lang: 'en', state: 'error', done: 0, total: 300, failed: 0, engine: '', error: 'no-engine', engines: [] };
  await page.route(/\/api\/games\/Starfall_Inn\/translation$/, (route) => route.fulfill({ json: state }));
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await openTab(page, 'Перевод');
  const bar = page.locator('.modal-content .tl-bar');
  await expect(bar.locator('.tl-error')).toContainText('Настройки → Перевод');
  await expect(bar.locator('button', { hasText: 'Продолжить' })).toHaveCount(0);
  // Готовый перевод файлом — в окне, раздел «Файл перевода»
  const win = await settings(page, 'Файл перевода');
  await expect(win.locator('button', { hasText: 'Загрузить перевод' })).toBeEnabled();
});

test('проверка перевода: что слиплось и что не влезает; слипание исправляется кнопкой', async ({ page }) => {
  const state = { lang: 'ru', state: 'done', done: 300, total: 300, failed: 0, engine: '', error: '', engines: ['deepl'] };
  let fixed = false;
  const issues = () => [
    ...(fixed ? [] : [{ kind: 'code', file: 'Map001', src: '一人娘\\C[5]マーベル', text: 'единственная\\C[5]дочь', fix: 'единственная \\C[5]дочь' }]),
    { kind: 'choice', file: 'Map002', src: '協力しない', text: 'Не сотрудничать ни с одной из сил', width: 1185, max: 1064 },
  ];
  const check = () => ({ lang: 'ru', counts: fixed ? { choice: 1 } : { code: 1, choice: 1 }, fixable: fixed ? 0 : 1, issues: issues() });
  await page.route(/\/api\/games\/Starfall_Inn\/translation(\/\w+)?$/, async (route) => {
    const url = route.request().url();
    if (url.endsWith('/check')) return route.fulfill({ json: check() });
    if (url.endsWith('/fix')) { fixed = true; return route.fulfill({ json: { fixed: 1 } }); }
    return route.fulfill({ json: state });
  });
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await openTab(page, 'Перевод');
  const bar = await settings(page, 'Проверка перевода');
  await bar.locator('button', { hasText: 'Проверить перевод' }).click();
  await expect(bar.locator('.tl-check')).toContainText('Проверка нашла мест: 2');
  await expect(bar.locator('.tl-check-list li')).toHaveCount(2);
  await expect(bar.locator('.tl-check-list li').first()).toContainText('единственная \\C[5]дочь');
  await bar.locator('button', { hasText: 'Исправить слипание (1)' }).click();
  await expect(page.locator('.toast.show')).toContainText('Исправлено строк: 1');
  await expect(bar.locator('.tl-check-list li')).toHaveCount(1);
  await expect(bar.locator('button', { hasText: 'Исправить слипание' })).toHaveCount(0);
});

test('перевод: «Найти строки» — отметить и перевести заново, своё не отмечается; «Перевести заново» — с вопросом; «Сохранить перевод» — файлом', async ({ page }) => {
  const state = { lang: 'ru', state: 'done', done: 300, total: 300, failed: 0, engine: '', error: '', engines: ['deepl'] };
  const posted = [];
  await page.route(/\/api\/games\/Starfall_Inn\/translation(\/[\w-]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const tail = url.pathname.split('/').pop();
    if (tail === 'lines') {
      return route.fulfill({ json: { lang: 'ru', total: 2, items: [
        { src: 'メイベル「はい」', text: 'Мэйбел: «Да»', origin: 'machine' },
        { src: 'メイベル', text: 'Мэйбл', origin: 'import' },
      ] } });
    }
    if (tail === 'estimate-redo') return route.fulfill({ json: { total: 300, todo: req.postDataJSON().lines ? 1 : 280, chars: 40, engine: 'deepl', left: 787052 } });
    if (tail === 'redo') { posted.push(req.postDataJSON()); return route.fulfill({ json: { ...state, state: 'queued' } }); }
    return route.fulfill({ json: state });
  });
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await openTab(page, 'Перевод');
  const bar = await settings(page, 'Файл перевода');
  await expect(bar.locator('a', { hasText: 'Сохранить перевод' })).toHaveAttribute('href', '/api/games/Starfall_Inn/translation/export');

  await bar.locator('.settings-tab', { hasText: 'Строки' }).click();
  await bar.locator('.tl-lines input[type=search]').fill('Мэйбел');
  await bar.locator('.tl-lines button', { hasText: 'Найти' }).click();
  await expect(bar.locator('.tl-lines-item')).toHaveCount(2);
  await expect(bar.locator('.tl-lines-item').nth(1).locator('input')).toBeDisabled();
  await expect(bar.locator('.tl-lines-item').nth(1)).toContainText('свой перевод');
  await bar.locator('.tl-lines-all input').check();
  await bar.locator('.tl-lines button', { hasText: 'Перевести заново (1)' }).click();
  await expect(page.locator('.confirm-box')).toContainText('Перевести заново строк: 1?');
  await page.locator('.confirm-ok').click();
  await expect(page.locator('.toast.show')).toContainText('со следующего запуска');

  // Вся игра — тоже с вопросом; «Отмена» — ничего не уходит
  await bar.locator('.settings-tab', { hasText: 'Язык и ход' }).click();
  await bar.locator('button', { hasText: 'Перевести заново' }).first().click();
  await expect(page.locator('.confirm-box')).toContainText('Перевести игру заново?');
  await expect(page.locator('.confirm-box')).toContainText('Свой перевод из файла и стандартные слова не трогаются');
  await page.locator('.confirm-cancel').click();
  expect(posted).toEqual([{ lines: ['メイベル「はい」'] }]);
});

test('перевод: итог проверки в игре; игра присылала ошибки после перевода — предупреждение и «Выключить перевод»', async ({ page }) => {
  let state = {
    lang: 'en', state: 'done', done: 300, total: 300, failed: 0, engine: '', error: '', engines: ['deepl'],
    check: { at: Date.now() - 600e3, lang: 'en', ok: false, steps: [{ name: 'title', ok: true }, { name: 'play', ok: false }], errors: [{ kind: 'load', message: 'Failed to load', source: 'audio/se/Click Sound 1.ogg' }] },
    gameErrors: [{ kind: 'load', message: 'Failed to load', source: 'audio/se/Click Sound 2.ogg', at: Date.now(), count: 1 }],
  };
  const posted = [];
  await page.route(/\/api\/games\/Starfall_Inn\/translation$/, async (route) => {
    if (route.request().method() === 'POST') {
      posted.push(route.request().postDataJSON());
      state = { ...state, lang: '', gameErrors: [], check: null };
    }
    return route.fulfill({ json: state });
  });
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await openTab(page, 'Перевод');
  // В карточке — что требует внимания; нажатие ведёт в нужный раздел окна
  const row = page.locator('.modal-content .tl-bar');
  await expect(row.locator('.tl-alert.bad')).toHaveText(['Игра присылала ошибки после перевода', 'Проверка в игре нашла ошибки']);
  await row.locator('.tl-alert', { hasText: 'Проверка в игре' }).click();
  const bar = page.locator('.tl-window');
  await expect(bar.locator('.settings-tab.active')).toHaveText('Проверка в игре');
  await expect(bar.locator('.tl-gamecheck')).toContainText('нашла ошибки');
  await expect(bar.locator('.tl-gamecheck')).toContainText('не загрузился файл');
  await expect(bar.locator('.tl-gamecheck')).toContainText('Click Sound 1.ogg');
  await expect(bar.locator('button', { hasText: 'Проверить в игре' })).toBeVisible();
  await bar.locator('.settings-tab', { hasText: 'Язык и ход' }).click();
  const warn = bar.locator('.tl-warn');
  await expect(warn).toContainText('После включения перевода игра присылала ошибки');
  await expect(warn).toContainText('Click Sound 2.ogg');
  await warn.locator('button', { hasText: 'Выключить перевод' }).click();
  await expect.poll(() => posted).toEqual([{ lang: '' }]);
  await expect(bar.locator('.tl-warn')).toHaveCount(0);
});

test('перевод готов — «проверить в игре» из строки запускает проверку один раз; смена раздела её не перезапускает', async ({ page }) => {
  const state = { lang: 'ru', state: 'done', done: 300, total: 300, failed: 0, engine: '', error: '', engines: ['deepl'], check: null };
  let plays = 0;
  await page.route(/\/api\/games\/Starfall_Inn\/translation$/, (route) => route.fulfill({ json: state }));
  // Сама игра в тестах не нужна: запуск отвечает «не в рамке» — проверка скажет, что не смогла
  await page.route(/\/api\/play\/Starfall_Inn$/, (route) => { plays++; return route.fulfill({ json: { mode: 'page', path: '/' } }); });
  await openLibrary(page);
  await openGame(page, 'Starfall Inn');
  await openTab(page, 'Перевод');
  await page.locator('.modal-content .tl-alert', { hasText: 'проверить в игре' }).click();
  const win = page.locator('.tl-window');
  await expect(win.locator('.settings-tab.active')).toHaveText('Проверка в игре');
  await expect.poll(() => plays).toBe(1);
  await win.locator('.settings-tab', { hasText: 'Язык и ход' }).click();
  await win.locator('.settings-tab', { hasText: 'Проверка в игре' }).click();
  await page.waitForTimeout(300);
  expect(plays).toBe(1);
  // Окно открыли «Настройками» — проверка сама не начинается
  await page.keyboard.press('Escape');
  await settings(page, 'Проверка в игре');
  await page.waitForTimeout(300);
  expect(plays).toBe(1);
});
