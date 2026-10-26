import { test, expect, openLibrary } from '../fixtures.js';

// Плашка загрузок на телефоне: у нижнего края во всю ширину, над шапкой и поиском ничего не висит
const PENDING = [
  { id: 'Eclipse_of_the_Crimson_Moon_v1.2.zip', name: 'Eclipse_of_the_Crimson_Moon_v1.2.zip', state: 'password', error: '', received: 1, size: 1, busy: false },
  { id: 'Tidecaller_v2.zip', name: 'Tidecaller_v2.zip', state: 'uploading', received: 812 * 1048576, size: 2140 * 1048576, busy: false },
];
const JOBS = [
  { key: 'link:1', title: 'Summer Memories and the Very Long Name of a Game That Does Not Fit', stage: 'download', loaded: 640 * 1048576, total: 1500 * 1048576, speed: 9.5 * 1048576, eta: 90 },
  { key: 'link:2', title: 'Stuck Game', stage: 'error', error: 'empty', retry: true },
];

// Свайп пальцем: касания подставляем событиями — Playwright жестов не умеет
const swipe = (page, selector, from, to) => page.locator(selector).evaluate((el, [a, b]) => {
  const touch = (y) => new Touch({ identifier: 1, target: el, clientX: 120, clientY: y });
  const fire = (type, y, ended) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: ended ? [] : [touch(y)], changedTouches: [touch(y)] }));
  fire('touchstart', a); fire('touchend', b, true);
}, [from, to]);

test.describe('телефон: плашка загрузок', () => {
  test('внизу на всю ширину, шапку не закрывает; касание и свайп раскрывают, свайп вниз, Esc и касание вне панели сворачивают', async ({ page }) => {
    await page.route(/\/api\/games\/upload\/list/, (route) => route.fulfill({ json: PENDING }));
    await openLibrary(page);
    const bar = page.locator('.tb');
    await expect(bar.locator('.tb-name')).toHaveText('Eclipse_of_the_Crimson_Moon_v1.2.zip');
    const vp = page.viewportSize();
    const box = await bar.boundingBox();
    const head = await page.locator('header').boundingBox();
    expect(box.x).toBe(0);
    expect(Math.round(box.width)).toBe(vp.width);
    expect(Math.round(box.y + box.height)).toBe(vp.height);
    expect(box.y).toBeGreaterThan(head.y + head.height);
    // Длинное имя режется одним знаком «…», а не точками, и строка не вылезает за плашку
    expect(await bar.locator('.tb-fn-stem').evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    // Расширение остаётся на виду, многоточие — перед ним
    await expect(bar.locator('.tb-fn-ext')).toHaveText('.zip');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(bar.locator('.tb-sub')).toHaveText('Ещё 1, одна ждёт пароль, одна не догружена');

    await swipe(page, '.tb', 800, 700);
    await expect(page.locator('.tb.open')).toBeVisible();
    const panel = page.locator('.tb.open');
    expect((await panel.boundingBox()).y).toBeGreaterThan(head.y + head.height);
    await expect(panel.locator('.upload-password input')).toBeVisible();
    // Кнопки под идущей загрузкой («Продолжить», «Добавить ещё», «Отменить») не уходят за правый край: лишняя переносится на строку ниже
    const acts = panel.locator('.tb-actions > *');
    expect(await acts.count()).toBeGreaterThan(1);
    for (const b of await acts.all()) { const r = await b.boundingBox(); expect(r.x + r.width).toBeLessThanOrEqual(vp.width); }
    await swipe(page, '.tb', 300, 420);
    await expect(panel).toHaveCount(0);

    await bar.locator('.tb-row').tap();
    await expect(page.locator('.tb.open')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tb.open')).toHaveCount(0);
    await bar.locator('.tb-row').tap();
    await page.locator('.tb-scrim').tap({ position: { x: 20, y: 20 } });
    await expect(page.locator('.tb.open')).toHaveCount(0);
  });

  test('JDownloader: в панели ничего не обрезано слева и справа; кольца в шапке на телефоне нет', async ({ page }) => {
    await page.route(/\/api\/downloads$/, (route) => route.fulfill({ json: JOBS }));
    await openLibrary(page);
    const bar = page.locator('.tb');
    await expect(bar.locator('.tb-name')).toContainText('Summer Memories');
    await bar.locator('.tb-row').tap();
    const panel = page.locator('.tb.open');
    const items = panel.locator('.tb-jd');
    await expect(items).toHaveCount(2);
    const w = page.viewportSize().width;
    for (const item of await items.all()) {
      for (const el of await item.locator('*').all()) {
        const r = await el.boundingBox();
        if (r) { expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.width).toBeLessThanOrEqual(w + 0.5); }
      }
    }
    expect(await panel.locator('.tb-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Кольцо в шапке на телефоне спрятано: там оно вставало на «Новинки», а список обрезался; всё теперь в панели
    await expect(page.locator('.jd-ring')).toBeHidden();
  });
});
