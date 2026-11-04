import { test, expect, openHome, openLibrary, openViewRow, openFilters, openGame, menu } from '../fixtures.js';

// Подсказка data-tip в доступное имя не входит (раньше эту роль играл title), поэтому у кнопки только со
// значком имя должно быть в aria-label / aria-labelledby. Считаем кнопки, у которых нет ни имени, ни текста
async function unnamed(page, scope = 'body') {
  return page.evaluate((root) => {
    const out = [];
    for (const el of document.querySelectorAll(`${root} button, ${root} [role="button"], ${root} summary, ${root} a[href]`)) {
      if (el.closest('[aria-hidden="true"]') || el.getAttribute('aria-hidden') === 'true' || el.hidden) continue;
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) continue;
      const text = (el.textContent || '').trim() || [...el.querySelectorAll('img')].map((i) => i.alt).join('').trim();
      if (!text) out.push(`${el.tagName.toLowerCase()}.${String(el.className).replace(/\s+/g, '.')}`);
    }
    return out;
  }, scope);
}

test.describe('доступные имена', () => {

  test('главная и библиотека: у кнопок без текста есть имя для экранного диктора', async ({ page }) => {
    await openHome(page);
    expect(await unnamed(page)).toEqual([]);
    await openLibrary(page);
    expect(await unnamed(page)).toEqual([]);
    // С открытыми рядами «Вид» и «Фильтры»: у каждой кнопки есть имя, у «Вид» — состояние и связь с рядом
    await openViewRow(page);
    await openFilters(page);
    expect(await unnamed(page)).toEqual([]);
    const btn = page.locator('.look-btn[aria-expanded]');
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`#${await btn.getAttribute('aria-controls')}`)).toHaveClass(/look-row/);
    await expect(page.locator('.look-row .look-grp[role="group"]')).not.toHaveCount(0);
    await expect(page.locator('.look-row .look-opt:not([aria-pressed])')).toHaveCount(0);
  });

  test('окно игры, настройки и «Найти»: то же', async ({ page }) => {
    await openLibrary(page);
    await openGame(page, 'Starfall Inn');
    expect(await unnamed(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await menu(page, 'Настройки');
    await expect(page.locator('.settings-content')).toBeVisible();
    for (const tab of await page.locator('.settings-tab').all()) {
      await tab.click();
      expect(await unnamed(page)).toEqual([]);
    }
  });
});
