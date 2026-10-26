import { test, expect, openLibrary, menu } from '../fixtures.js';

// «Настройки» на телефоне: во весь экран, вверху оглавление в две колонки с состоянием, раздел — под ним
async function openSettings(page) {
  await menu(page, 'Настройки');
  await expect(page.locator('.settings-content')).toBeVisible();
}

test.describe('настройки на телефоне', () => {
  test('во весь экран; оглавление в две колонки с состоянием; раздел открывается под ним', async ({ page }) => {
    await page.route(/\/api\/settings\/update$/, (route) => route.fulfill({ json: { current: '7.0.0', latest: '7.1', newer: true, how: 'image', image: 'ghcr.io/me/rpg-library', notes: [], url: 'https://example.org/cl', checkedAt: Date.now() } }));
    await openLibrary(page);
    await openSettings(page);
    const win = await page.locator('.settings-content').boundingBox();
    const view = page.viewportSize();
    expect(win.width).toBe(view.width);
    expect(win.height).toBe(view.height);
    const tabs = page.locator('.settings-tab');
    await expect(tabs.locator('.settings-tab-name')).toHaveText(['Общие', 'Аккаунт', 'Источники', 'Перевод', 'Загрузки', 'Уведомления', 'Копии', 'Корзина', 'О программе']);
    await expect(tabs.nth(0).locator('.settings-tab-state')).toHaveText('Язык русский');
    await expect(tabs.nth(8).locator('.settings-tab-state')).toHaveText('Вышла версия 7.1');
    await expect(tabs.nth(8).locator('.settings-tab-new')).toBeVisible();
    // Две колонки: первый и второй раздел — в одном ряду, третий — ниже
    const [a, b, c] = await Promise.all([0, 1, 2].map((i) => tabs.nth(i).boundingBox()));
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(b.x).toBeGreaterThan(a.x + 100);
    expect(c.y).toBeGreaterThan(a.y + 20);
    // Выбранный — с золотой чертой слева
    await expect(tabs.nth(0)).toHaveClass(/active/);
    expect(await tabs.nth(0).evaluate((el) => getComputedStyle(el).borderLeftColor)).toBe('rgb(201, 168, 76)');
    // Раздел — под оглавлением, без «назад»
    await tabs.nth(2).click();
    const nav = await page.locator('.settings-tabs').boundingBox();
    const panel = await page.locator('.settings-panel').boundingBox();
    expect(panel.y).toBeGreaterThanOrEqual(nav.y + nav.height);
    await expect(page.locator('.svc-item').first()).toBeVisible();
    // Название службы и её состояние — в одной строке
    const top = page.locator('.svc-item-top').first();
    const [name, st] = await Promise.all([top.locator('.svc-item-name').boundingBox(), top.locator('.svc-item-state').boundingBox()]);
    expect(Math.abs((name.y + name.height / 2) - (st.y + st.height / 2))).toBeLessThan(12);
    expect(st.x).toBeGreaterThan(name.x + name.width - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('пролистали — оглавление сворачивается в строку с названием раздела и «Разделы», которая возвращает наверх', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page);
    await expect(page.locator('.settings-bar')).toHaveCount(0);
    await page.locator('.settings-tab', { hasText: 'Общие' }).click();
    // Вкладка «Общие» длинная: пролистываем окно за оглавление
    await page.locator('.settings-content').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const bar = page.locator('.settings-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('b')).toHaveText('Общие');
    await expect(bar.locator('small')).toHaveText('Язык русский');
    await expect(bar.locator('button', { hasText: 'Разделы' })).toBeVisible();
    await bar.locator('button', { hasText: 'Разделы' }).tap();
    await expect.poll(() => page.locator('.settings-content').evaluate((el) => el.scrollTop)).toBeLessThan(2);
    await expect(bar).toHaveCount(0);
  });

  test('закладка «В Mimikin» на сенсорном экране не показывается — остаётся подсказка про Telegram-бот', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page);
    await page.locator('.settings-tab', { hasText: 'Загрузки' }).tap();
    const mark = page.locator('[data-section="jd-bookmark"]');
    await expect(mark.locator('a.jd-bookmark')).toBeHidden();
    await expect(mark.locator('.set-title.jd-touch')).toHaveText('Ссылка с телефона');
    await expect(mark).toContainText('Telegram-бот');
  });

  test('чипы языков переносятся: ничего не уходит за правый край', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page);
    const view = page.viewportSize().width;
    for (const box of await page.locator('.known-langs .chip').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right))) expect(box).toBeLessThanOrEqual(view);
  });

  test('короткий раздел тоже сворачивает оглавление в строку «Разделы»; у служб нет стрелки, есть подзаголовки групп', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page);
    await page.locator('.settings-tab', { hasText: 'Источники' }).tap();
    await expect(page.locator('.svc-item-chev')).toHaveCount(0);
    await expect(page.locator('.settings-panel .set-title')).toHaveText(['Данные игр']);
    await page.locator('.settings-content').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const bar = page.locator('.settings-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('b')).toHaveText('Источники');
    // Оглавление под строкой не торчит обрезком: к моменту, когда строка появилась, его низ уже под ней
    const nav = await page.locator('.settings-tabs').boundingBox();
    expect(nav.y + nav.height).toBeLessThan(76);
  });

  test('«Загрузки»: группа JDownloader, строка Telegram-бота без закладки', async ({ page }) => {
    await openLibrary(page);
    await openSettings(page);
    await page.locator('.settings-tab', { hasText: 'Загрузки' }).tap();
    await expect(page.locator('.settings-panel .set-title').first()).toHaveText('JDownloader');
    const row = page.locator('[data-section="jd-bookmark"] .svc-item');
    await expect(row.locator('.svc-item-name')).toHaveText('Telegram-бот');
    await expect(row.locator('.svc-item-state')).toContainText('Не подключён');
    await expect(page.locator('[data-section="jd-bookmark"]')).not.toContainText('→');
  });
});
