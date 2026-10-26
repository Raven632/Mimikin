import { test, expect } from '../fixtures.js';

// Мимик в шапке на телефоне: касание держит крышку поднятой сразу (без 160 мс мыши), пять касаний — обложка и окно.
// Часы страницы стоят, время идёт только по runFor

const mark = (page) => page.locator('header .brand-mark svg');
const frame = (page) => mark(page).getAttribute('data-frame');

test.use({ timezoneId: 'UTC' });
async function boot(page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Полдень: ночью (01–06) покой другой
  await page.clock.install({ time: new Date('2026-10-03T12:00:00Z') });
  await page.goto('/');
  await expect(page.locator('.shelf-card').first()).toBeVisible();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 100));
}

test.describe('мимик в шапке (телефон)', () => {
  test('палец на знаке — W сразу, отпустил — назад сразу', async ({ page }) => {
    await boot(page);
    expect(await frame(page)).toBe('OPEN');
    const touch = (type) => page.locator('.brand').evaluate((el, t) => el.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', bubbles: true, cancelable: true, button: 0 })), type);
    await touch('pointerdown');
    expect(await frame(page)).toBe('W');
    await touch('pointerup');
    expect(await frame(page)).toBe('OPEN');
  });

  test('место знака 32 × 32 и знак не шире его; svg не принимает касания', async ({ page }) => {
    await boot(page);
    const geo = await page.evaluate(() => {
      const slot = document.querySelector('.brand-slot').getBoundingClientRect();
      const box = document.querySelector('.brand-mark.m16').getBoundingClientRect();
      const svg = document.querySelector('.brand-mark.m16 svg');
      return { slot: [slot.width, slot.height], box: box.width, pe: getComputedStyle(svg).pointerEvents, over: document.documentElement.scrollWidth <= innerWidth };
    });
    expect(geo.slot).toEqual([32, 32]);
    expect(geo.box).toBeLessThanOrEqual(32);
    expect(geo.pe).toBe('none');
    expect(geo.over).toBe(true);
  });

  test('пять касаний за 2 с: на пятом обложка изо рта, потом «Во что поиграть?»', async ({ page }) => {
    await boot(page);
    for (let i = 0; i < 5; i += 1) await page.locator('.brand').tap();
    expect(await frame(page)).toBe('W');
    await page.clock.runFor(200);
    expect(await mark(page).getAttribute('data-over')).toBe('p0');
    await page.clock.runFor(300);
    await page.clock.resume();
    await expect(page.locator('.picker-content')).toBeVisible();
  });
});
