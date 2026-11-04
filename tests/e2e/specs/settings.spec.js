import { test, expect, openLibrary, openGame, menu, USER } from '../fixtures.js';

async function openSettings(page, tab) {
  await menu(page, 'Настройки');
  await expect(page.locator('.settings-content')).toBeVisible();
  if (tab) await page.locator('.settings-tab', { hasText: tab }).click();
}

// Служба — строка списка; щелчок раскрывает её настройку под строкой. По имени строки целиком
const openRow = (page, name) => page.locator('.svc-item-head', { has: page.locator('.svc-item-name', { hasText: new RegExp(`^${name}$`) }) }).click();

test.describe('настройки', () => {
  test('девять вкладок; язык меняется сразу; «Скрывать обложки» размывает обложки', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page);
    await expect(page.locator('.settings-tab .settings-tab-name')).toHaveText(['Общие', 'Мой профиль', 'Пользователи', 'Копии', 'Корзина', 'Источники', 'Перевод', 'Загрузки', 'Уведомления', 'О программе']);

    await page.locator('.set-choice-btn', { hasText: 'English' }).click();
    await expect(page.locator('#settings-title')).toHaveText('Settings');
    await page.locator('.set-choice-btn', { hasText: 'Русский' }).click();
    await expect(page.locator('#settings-title')).toHaveText('Настройки');

    await page.locator('.set-toggle').first().click();
    await expect(page.locator('.app-container')).toHaveClass(/covers-hidden/);
    await page.locator('.set-toggle').first().click();
    await expect(page.locator('.app-container')).not.toHaveClass(/covers-hidden/);
  });

  test('журнал сервера: отчёт виден до копирования, копируется он же, а отказ буфера оставляет текст для ручного копирования', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page, 'О программе');
    await page.locator('.meta-status-btn', { hasText: 'Скопировать отчёт о проблеме' }).click();
    const box = page.locator('.report-text');
    await expect(box).toHaveValue(/^Mimikin problem report\nVersion: /);
    await expect(box).toHaveValue(/Recent warnings and errors/);
    await expect(page.locator('.report-box')).toContainText('Названий игр');
    const shown = await box.inputValue();

    // Буфер принял: в него ушёл тот же текст
    await page.evaluate(() => { document.execCommand = () => { window.copied = document.activeElement.value; return true; }; });
    await page.locator('.report-box .confirm-ok').click();
    await expect(page.locator('.toast')).toContainText('Отчёт скопирован');
    expect(await page.evaluate(() => window.copied)).toBe(shown);

    // Обычный HTTP, буфера нет: подсказка и выделенный текст в поле
    await page.evaluate(() => {
      document.execCommand = () => false;
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });
    await page.locator('.report-box .confirm-ok').click();
    await expect(page.locator('.report-box .set-error')).toBeVisible();
    await expect(box).toBeFocused();
    expect(await box.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe(shown);

    // Escape закрывает только отчёт
    await page.keyboard.press('Escape');
    await expect(page.locator('.report-box')).toHaveCount(0);
    await expect(page.locator('.settings-content')).toBeVisible();
  });

  test('«Прятать, когда сворачиваю»: выключено само; включённое — прячет при уходе с вкладки, не возвращает само, добавляет hide=1 к игре', async ({ page }) => {
    // Прятать вкладку в тесте нечем — шлём то же событие, что браузер
    const leave = () => page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await openLibrary(page);
    await leave();
    await expect(page.locator('.app-container')).not.toHaveClass(/covers-hidden/);
    await openSettings(page);
    const toggle = page.locator('.set-toggle', { hasText: 'Прятать, когда сворачиваю' });
    await expect(toggle.locator('input')).not.toBeChecked();
    await toggle.click();
    await expect(toggle.locator('input')).toBeChecked();
    await page.keyboard.press('Escape');
    await leave();
    await expect(page.locator('.app-container')).toHaveClass(/covers-hidden/);
    await expect(page).toHaveTitle('Документы');
    // Вернулись — скрыто, пока сам не покажешь (H)
    await page.keyboard.press('h');
    await expect(page.locator('.app-container')).not.toHaveClass(/covers-hidden/);
    // Настройка помнится, и игра открывается скрытой
    await page.reload();
    await expect(page.locator('.library > .game-card').first()).toBeVisible();
    await openGame(page, 'Ember & Frost');
    await page.locator('#modal-play-btn').click();
    await expect(page.locator('.game-frame iframe')).toHaveAttribute('src', /[?&]hide=1/);
  });

  test('скрытые теги: список с названиями, крестик возвращает тег', async ({ page }) => {
    const posted = [];
    let tags = ['sword', 'cow_print'];
    await page.route(/\/api\/pictures\/hidden$/, (route) => {
      if (route.request().method() === 'POST') { posted.push(route.request().postDataJSON()); tags = tags.filter((x) => x !== 'sword'); }
      return route.fulfill({ json: { tags } });
    });
    await openLibrary(page);
    await openSettings(page);
    const section = page.locator('[data-section="hidden-tags"]');
    await expect(section.locator('.chip')).toHaveText([/меч/, /cow print/]);
    await section.locator('.chip', { hasText: 'меч' }).click();
    await expect(section.locator('.chip')).toHaveCount(1);
    expect(posted).toEqual([{ remove: ['sword'] }]);
  });

  test('скрытое из подбора: нечего возвращать — раздела нет; «Вернуть всё» очищает и прячет раздел', async ({ page }) => {
    let count = 2;
    await page.route(/\/api\/recommend\/dismissed/, (route) => {
      if (route.request().method() === 'DELETE') { count = 0; return route.fulfill({ json: { ok: true, dismissed: 0 } }); }
      return route.fulfill({ json: { count } });
    });
    await page.goto('/');
    await openSettings(page);
    const part = page.locator('[data-section="dismissed-picks"]');
    await expect(part).toContainText('Скрыто: 2');
    await part.getByRole('button', { name: 'Вернуть всё' }).click();
    await expect(part).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: 'Скрытое снова в подборе' })).toBeVisible();
    expect(count).toBe(0);
  });

  test('«Показать клавиши» открывает окно поверх настроек; Escape возвращает в настройки', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page);
    const show = page.locator('.settings-panel button', { hasText: 'Показать клавиши' });
    await show.click();
    const keys = page.locator('.keys-content');
    await expect(keys).toBeVisible();
    // Поверх: в середине окна клавиш под курсором — само это окно, а не настройки
    const onTop = await keys.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(onTop).toBe(true);
    await page.keyboard.press('Escape');
    await expect(keys).toHaveCount(0);
    await expect(page.locator('.settings-content')).toBeVisible();
    await expect(show).toBeFocused();
  });

  test('скорость разбора картинок: выбор только при включённом разборе, уходит на сервер; не сохранилось — остаётся прежнее', async ({ page }) => {
    // В тестовом окружении моделей нет: состояние строки — как их отдаёт сервер, переключение — через те же запросы
    const analysis = { on: false, state: 'off' };
    const posted = [];
    let fail = false;
    let statusDown = false;
    await page.route(/\/api\/pictures\/status/, (route) => (statusDown ? route.fulfill({ status: 500, json: {} }) : route.fulfill({ json: { state: 'ready', analysis } })));
    await page.route(/\/api\/settings\/options$/, (route) => {
      const body = route.request().postDataJSON();
      posted.push(body);
      if (fail) return route.fulfill({ status: 500, json: { error: 'Не удалось сохранить' } });
      if (body.name === 'picture_analysis') Object.assign(analysis, body.value ? { on: true, state: 'done', speed: 'quiet' } : { on: false, state: 'off', speed: undefined });
      if (body.name === 'picture_speed') analysis.speed = body.value;
      return route.fulfill({ json: { options: {} } });
    });
    await openLibrary(page);
    await openSettings(page);
    const section = page.locator('[data-section="picture-analysis"]');
    const quiet = section.getByRole('radio', { name: 'Тихо' });
    const fast = section.getByRole('radio', { name: 'Быстро' });
    await expect(section).toContainText('Разбор картинок');
    await expect(section.getByRole('radio')).toHaveCount(0);

    await section.locator('.set-toggle').click();
    await expect(quiet).toHaveAttribute('aria-checked', 'true');
    await expect(fast).toHaveAttribute('aria-checked', 'false');

    await fast.click();
    await expect(fast).toHaveAttribute('aria-checked', 'true');
    await expect(quiet).toHaveAttribute('aria-checked', 'false');
    expect(posted.at(-1)).toEqual({ name: 'picture_speed', value: 'fast' });

    fail = true;
    await quiet.click();
    await expect(page.locator('.toast.show')).toBeVisible();
    await expect(fast).toHaveAttribute('aria-checked', 'true');
    await expect(quiet).toHaveAttribute('aria-checked', 'false');
    expect(posted.at(-1)).toEqual({ name: 'picture_speed', value: 'quiet' });

    // Сохранилось, но статус не прочитался: на экране новое значение, а не прежнее
    fail = false;
    statusDown = true;
    await quiet.click();
    await expect(quiet).toHaveAttribute('aria-checked', 'true');
    await expect(fast).toHaveAttribute('aria-checked', 'false');
    statusDown = false;

    await section.locator('.set-toggle').click();
    await expect(section.getByRole('radio')).toHaveCount(0);
  });

  test('смена пароля: неверный прежний — ошибка; верный — сменён, это устройство остаётся со входом', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page, 'Мой профиль');
    const form = page.locator('[data-section=password]');
    const fields = form.locator('input[type=password]');
    const fill = async (current, next) => {
      await fields.nth(0).fill(current); await fields.nth(1).fill(next); await fields.nth(2).fill(next);
      await form.locator('.set-submit').click();
    };
    await fill('wrong-password', 'next-pass-456');
    await expect(form.locator('.auth-error')).toHaveText('Прежний пароль неверный');

    // Пароль возвращаем в finally: упавшая проверка посреди теста иначе оставила бы владельцу чужой пароль,
    // и все следующие входы (и повтор этого теста) падали бы с 401
    // (верный пароль не помнит и лишней неудачной попытки не тратит: если тест дошёл до конца, finally молчит)
    let restored = false;
    try {
      await fill(USER.password, 'next-pass-456');
      await expect(page.locator('.toast.show')).toContainText('Пароль сменён');
      await expect(fields.nth(0)).toHaveValue('');
      // Это устройство со входом: список игр открывается
      expect((await page.request.get('/api/games')).ok()).toBeTruthy();

      // Вернуть прежний — остальным тестам
      await fill('next-pass-456', USER.password);
      // Тост от первой смены ещё на экране и сам по себе ничего не доказывает: следующий тест входил раньше, чем пароль вернулся. Поля очищает только ответ сервера
      await expect(fields.nth(0)).toHaveValue('');
      await expect(page.locator('.toast.show')).toContainText('Пароль сменён');
      restored = true;
    } finally {
      if (!restored) await page.request.post('/api/account/password', { data: { current: 'next-pass-456', next: USER.password } }).catch(() => {});
    }
  });

  test('ключ ScraperAPI: сохраняется, показывается только хвост, убирается', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page, 'Источники');
    await openRow(page, 'ScraperAPI');
    const box = page.locator('[data-secret="scraper"]');
    await expect(box.locator('.set-status')).toHaveText('Ключ не задан');
    await box.locator('.set-form input').fill('not a key');
    await box.locator('.set-form .set-submit').click();
    await expect(box.locator('.set-form .auth-error')).toContainText('не похоже на ключ');

    await box.locator('.set-form input').fill('abcdef0123456789wxyz');
    await box.locator('.set-form .set-submit').click();
    await expect(box.locator('.set-status')).toHaveText('Ключ сохранён (…wxyz)');

    await box.locator('.set-form button', { hasText: 'Убрать ключ' }).click();
    await page.locator('.confirm-ok').click();
    await expect(box.locator('.set-status')).toHaveText('Ключ не задан');
  });

  test('токен бота, пароль копий — в настройках', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page, 'Уведомления');
    const tg = page.locator('[data-secret="telegram"]');
    await tg.locator('.set-form input').fill('not-a-token');
    await tg.locator('.set-form .set-submit').click();
    await expect(tg.locator('.auth-error')).toContainText('не похоже на токен');

    await page.locator('.settings-tab', { hasText: 'Копии' }).click();
    const backup = page.locator('[data-secret="backup"]');
    await expect(backup.locator('input')).toHaveAttribute('type', 'password');
    await backup.locator('.set-form input').fill('long-enough-pass');
    await backup.locator('.set-form .set-submit').click();
    await expect(backup.locator('.set-status')).toHaveText('Пароль сохранён');
    await backup.locator('.set-form button', { hasText: 'Убрать пароль' }).click();
    await page.locator('.confirm-ok').click();
    await expect(backup.locator('.set-status')).toContainText('Пароль не задан');
  });

  test('параметры из .env — и на сайте: порог места сохраняется и возвращается; помощник обновлений; что только на сервере', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page, 'Уведомления');
    // Без бота порог ничего не делает — поля нет
    await expect(page.locator('[data-option="disk_warn_gb"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.route(/\/api\/settings(\/options)?$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), telegram: { set: true } } });
    });
    await openSettings(page, 'Уведомления');
    const disk = page.locator('[data-option="disk_warn_gb"]');
    await expect(disk.locator('input')).toHaveAttribute('placeholder', '10');
    await disk.locator('input').fill('25');
    await disk.locator('button', { hasText: 'Сохранить' }).click();
    await expect(page.locator('.toast.show')).toContainText('Сохранено');
    await expect(disk.locator('input')).toHaveAttribute('placeholder', '25');
    await disk.locator('button', { hasText: 'Вернуть 10' }).click();
    await expect(disk.locator('input')).toHaveAttribute('placeholder', '10');

    await page.locator('.settings-tab', { hasText: 'О программе' }).click();
    await openRow(page, 'Помощник обновлений');
    const helper = page.locator('[data-secret="updater"]');
    await helper.locator('input[type=url]').fill('http://mimikin-update:8080/v1/update');
    await helper.locator('input[type=password]').fill('secret-token');
    await helper.locator('button', { hasText: 'Сохранить' }).click();
    await expect(helper.locator('.set-status')).toHaveText('Помощник подключён');
    await helper.locator('button', { hasText: 'Убрать' }).click();
    await page.locator('.confirm-ok').click();
    await expect(helper.locator('.set-status')).toHaveText('Не подключён, вместо кнопки команда');

    await page.locator('.set-server summary').click();
    await expect(page.locator('.set-server')).toContainText('SECRETS_KEY');
    await expect(page.locator('.set-server')).toContainText('GAME_ISOLATION');
  });

  test('любимые теги: выбираются в «Общих», в окне игры идут первыми с сердцем, убираются', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page, 'Общие');
    const box = page.locator('[data-section="favorites"]');
    await box.locator('.picker-btn').click();
    await page.locator('.picker-search').fill('fantasy');
    await page.locator('.picker-opt', { hasText: /^fantasy$/ }).click();
    await expect(box.locator('.fav-chips .chip')).toHaveText(['fantasy']);
    // Вместо «×» в чипе значок (рядом с сердцем): два svg
    await expect(box.locator('.fav-chips .chip svg')).toHaveCount(2);
    expect((await (await page.request.get('/api/settings/favorite-tags')).json()).tags).toEqual(['fantasy']);
    await page.keyboard.press('Escape');

    // Starfall Inn: теги «2d game, cozy, fantasy, management» — «fantasy» первым и с сердцем
    await openGame(page, 'Starfall Inn');
    await expect(page.locator('.modal-tags .tag-link').first()).toHaveText('fantasy');
    await expect(page.locator('.modal-tags .tag-fav')).toHaveCount(1);
    await page.keyboard.press('Escape');

    await openSettings(page, 'Общие');
    await page.locator('[data-section="favorites"] .fav-chips .chip').click();
    await expect(page.locator('[data-section="favorites"] .fav-chips')).toHaveCount(0);
    expect((await (await page.request.get('/api/settings/favorite-tags')).json()).tags).toEqual([]);
  });

  test('«О программе»: знак, версия; вышла новая — мимик у вкладки, что нового и команда; с помощником — кнопка', async ({ page }) => {
    let how = 'image';
    let asked = 0;
    await page.route(/\/api\/settings\/update(\?fresh=1)?$/, (route) => {
      if (route.request().method() === 'POST') { asked++; return route.fulfill({ json: { started: true } }); }
      return route.fulfill({ json: { current: '7.0.0', latest: '7.1', newer: true, how, image: 'ghcr.io/me/rpg-library', notes: ['Seedbox in Settings'], url: 'https://example.org/cl', checkedAt: Date.now() } });
    });
    await openLibrary(page);
    await openSettings(page);
    await expect(page.locator('.settings-tab', { hasText: 'О программе' }).locator('.settings-tab-new')).toBeVisible();
    await expect(page.locator('.settings-tab', { hasText: 'О программе' }).locator('.settings-tab-state')).toHaveText('Вышла версия 7.1');
    await page.locator('.settings-tab', { hasText: 'О программе' }).click();
    await expect(page.locator('.set-about-brand')).toContainText('Mimikin');
    await expect(page.locator('.set-about-brand svg')).toBeVisible();
    await expect(page.locator('.settings-panel')).toContainText(/Версия \d+\.\d+\.\d+/);
    const box = page.locator('.set-update');
    await expect(box.locator('.set-update-title')).toHaveText('Вышла версия 7.1');
    await expect(box.locator('.set-update-notes li')).toHaveText(['Seedbox in Settings']);
    await expect(box.locator('code')).toHaveText('docker pull ghcr.io/me/rpg-library:latest');
    // С помощником обновлений — кнопка; нажали — сервер получил просьбу, страница ждёт новую версию
    how = 'button';
    await page.locator('.settings-tab', { hasText: 'Общие' }).click();
    await page.keyboard.press('Escape');
    await openSettings(page, 'О программе');
    await box.locator('button', { hasText: 'Обновить' }).click();
    await expect.poll(() => asked).toBe(1);
    await expect(box).toContainText('Страница перезагрузится сама');
  });

  test('строки служб: работает ли, сколько осталось и когда обновится; где остаток посчитан библиотекой — так и сказано', async ({ page }) => {
    let fresh = 0;
    await page.route(/\/api\/settings\/services(\?fresh=1)?$/, (route) => {
      if (route.request().url().includes('fresh=1')) fresh++;
      return route.fulfill({ json: { at: Date.now(), services: {
        deepl: { key: true, ok: true, unit: 'chars', used: 212948, limit: 1000000, left: 787052, resetAt: null, from: 'service' },
        microsoft: { key: true, ok: null, unit: 'chars', used: 1500, limit: 2000000, left: 1998500, resetAt: Date.UTC(2026, 10, 1), from: 'local' },
        google: { key: false }, libre: { key: false },
        scraper: { key: true, ok: false, today: { used: 3, limit: 30 } },
        telegram: { key: false },
      } } });
    });
    // Ключей в демо нет — состояние «подключено» берём из настроек
    await page.route(/\/api\/settings$/, async (route) => {
      const real = await (await route.fetch()).json();
      route.fulfill({ json: { ...real, deepl: { set: true, tail: 'ab:fx' }, microsoft: { set: true, tail: 'west' }, scraper: { set: true, tail: 'wxyz' } } });
    });
    await openLibrary(page);
    await openSettings(page, 'Перевод');
    const rows = page.locator('.svc-item');
    await expect(rows).toHaveCount(4);
    const deepl = rows.filter({ hasText: 'DeepL' });
    await expect(deepl.locator('.svc-item-state')).toHaveText('Подключено');
    await expect(deepl).toContainText(/осталось 787\s052 из 1\s000\s000 знаков/);
    await expect(deepl).toContainText('обновляется раз в месяц');
    const ms = rows.filter({ hasText: 'Microsoft' });
    await expect(ms).toContainText('по подсчёту библиотеки');
    await expect(ms).toContainText('обновится 1 ноября');
    await expect(rows.filter({ hasText: 'Google' }).locator('.svc-item-state')).toHaveText('Не настроено');
    await page.locator('.svc-toolbar button', { hasText: 'Проверить сейчас' }).click();
    await expect.poll(() => fresh).toBe(1);

    await page.locator('.settings-tab', { hasText: 'Источники' }).click();
    const scraper = page.locator('.svc-item', { hasText: 'ScraperAPI' });
    await expect(scraper.locator('.svc-item-state')).toHaveText('Не принимает ключ');
    await openRow(page, 'ScraperAPI');
    await expect(scraper).toContainText('сегодня: 3 из 30');
  });

  test('словарь терминов в «Переводе»: слово из переведённых игр — с числом игр, остальные — стандартные; язык переключается', async ({ page }) => {
    await page.route('**/api/games/translation/terms', (route) => route.fulfill({ json: {
      games: { ru: 17, en: 50, de: 0 },
      terms: [
        { ja: '逃げる', ru: { text: 'Побег', votes: 8, total: 14 }, en: { text: 'Escape', votes: 35, total: 48 }, de: { text: 'Fliehen' } },
        { ja: '戦う', ru: { text: 'Сражаться' }, en: { text: 'Fight', votes: 43, total: 49 }, de: { text: 'Kämpfen' } },
      ],
    } }));
    await openLibrary(page);
    await openSettings(page, 'Перевод');
    const terms = page.locator('.set-terms');
    await terms.locator('summary').click();
    await expect(terms).toContainText('Переведённых игр на этом языке: 17. Из них взято слов: 1.');
    await expect(terms.locator('.set-terms-list li').first()).toContainText('Побег');
    await expect(terms.locator('.set-terms-list li').first()).toContainText('8 из 14 игр');
    await expect(terms.locator('.set-terms-list li').nth(1)).toContainText('стандартный');
    await terms.locator('.chip', { hasText: 'Deutsch' }).click();
    await expect(terms).toContainText('Переведённых игр на этом языке в библиотеке нет');
    await expect(terms.locator('.set-terms-list li').first()).toContainText('Fliehen');
  });
  test('оглавление: ничего не подключено — подписи нет вместо «0 из 5», группа говорит «по желанию»; подключили — счётчик', async ({ page }) => {
    const off = Object.fromEntries(['scraper', 'deepl', 'microsoft', 'google', 'libre', 'myjd', 'seedbox', 'telegram'].map((k) => [k, { set: false }]));
    await page.route(/\/api\/settings$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ json: { ...(await res.json()), ...off, deepl: { set: true, tail: 'ab:fx' } } });
    });
    await page.route(/\/api\/settings\/seedbox$/, (route) => route.fulfill({ json: { set: false } }));
    await openLibrary(page);
    await openSettings(page);
    const state = (name) => page.locator('.settings-tab', { hasText: name }).locator('.settings-tab-state');
    for (const name of ['Источники', 'Загрузки', 'Уведомления']) await expect(state(name)).toHaveCount(0);
    await expect(page.locator('.settings-group-title', { hasText: 'Подключения, по желанию' })).toBeVisible();
    await expect(state('Перевод')).toHaveText('1 из 4 служб');
  });
  test('оглавление: под названием раздела — состояние; ошибка Seedbox и счётчик служб видны без открытия раздела', async ({ page }) => {
    // Задан Seedbox, и сервер говорит «не пустил»: красная строка в оглавлении
    await page.route(/\/api\/settings$/, async (route) => {
      const res = await route.fetch();
      const d = await res.json();
      await route.fulfill({ json: { ...d, seedbox: { set: true, fromEnv: false, tail: '…1234' }, scraper: { set: true, fromEnv: true } } });
    });
    await page.route(/\/api\/settings\/seedbox$/, (route) => route.fulfill({ json: { set: true, host: 'box', error: 'Сервер не пустил' } }));
    await openLibrary(page);
    await openSettings(page);
    const state = (name) => page.locator('.settings-tab', { hasText: name }).locator('.settings-tab-state');
    await expect(state('Общие')).toHaveText('Язык русский');
    await expect(state('Источники')).toHaveText('1 из 1 подключены');
    await expect(state('Загрузки')).toHaveText('Ошибка у Seedbox');
    await expect(state('Загрузки')).toHaveClass(/bad/);
    // Корзина сообщает о себе сразу, не дожидаясь вкладки
    await expect(state('Корзина')).toHaveText(/^(Пусто|\d+ (игра|игры|игр))$/);
    // У строки службы — наш знак состояния, а не квадратик-галочка
    await page.locator('.settings-tab', { hasText: 'Источники' }).click();
    await expect(page.locator('.svc-item', { hasText: 'ScraperAPI' }).first().locator('.svc-gem')).toBeVisible();
    // Корзина и копия сообщают о себе, когда вкладка прочитала данные
    await page.locator('.settings-tab', { hasText: 'Корзина' }).click();
    await expect(state('Корзина')).toHaveText(/^(Пусто|\d+ (игра|игры|игр))$/);
  });
});
