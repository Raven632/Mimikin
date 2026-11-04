import { test, expect, openLibrary, openGame } from '../fixtures.js';

// Чит-меню поверх настоящей страницы игры с сервера игр и настоящего rpg-fixes. Демо-игра — не RPG Maker (своих героев и
// предметов у неё нет), поэтому то, что читает меню, кладём в страницу сами; панель и её стили — настоящие
const FRAME = '.game-frame iframe';

async function startGame(page, viewport) {
  await openLibrary(page);
  await openGame(page, 'Ember & Frost');
  await page.locator('#modal-play-btn').click();
  await expect(page.frameLocator(FRAME).locator('#demo-game')).toContainText('Ember & Frost', { timeout: 15_000 });
  await page.setViewportSize(viewport);
  const frame = await (await page.locator(FRAME).elementHandle()).contentFrame();
  await frame.evaluate(async () => {
    const list = (n, name) => [null, ...Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `${name} ${i + 1}` }))];
    const names = (n, name) => ['', ...Array.from({ length: n }, (_, i) => `${name} ${i + 1}`)];
    const actor = { actorId: () => 1, name: () => 'Hero', level: 1, hp: 10, mhp: 10, mp: 1, mmp: 1, param: () => 1, currentExp: () => 0 };
    Object.assign(window, {
      $dataItems: list(200, 'Item'), $dataWeapons: list(5, 'Sword'), $dataArmors: list(5, 'Armor'),
      $dataSystem: { variables: names(300, 'Var'), switches: names(300, 'Switch') },
      $dataMapInfos: [null, { id: 1, name: 'Town' }], $dataCommonEvents: [null],
      $gameParty: { members: () => [actor], numItems: () => 0, gold: () => 0, inBattle: () => false, hasItem: () => false },
      $gameVariables: { value: () => 0, setValue() {} }, $gameSwitches: { value: () => false, setValue() {} },
      $gameMap: { mapId: () => 1, isEventRunning: () => false }, $gamePlayer: { x: 1, y: 1, moveSpeed: () => 4 },
    });
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/cheats.js';
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
    window.__rpgCheats.open();
  });
  // Первые 0,35 с панель не принимает щелчки: это щелчок пальца, которым её открыли (cheats.js, build)
  await page.waitForTimeout(400);
  return frame;
}

const measure = (frame) => frame.evaluate(() => {
  const box = (s) => document.querySelector(`#_cheats ${s}`).getBoundingClientRect();
  const panel = document.querySelector('#_cheats').getBoundingClientRect();
  const body = document.querySelector('#_cheats ._ch_body');
  return {
    tabs: box('._ch_tabs').height,
    chip: box('._ch_tabs ._ch_chip').height,
    fits: panel.top >= 0 && panel.left >= 0 && panel.bottom <= innerHeight && panel.right <= innerWidth,
    scrolls: body.scrollHeight > body.clientHeight,
  };
});

test.describe('чит-меню: вкладки', () => {
  for (const [name, viewport] of [
    ['компьютер', { width: 1280, height: 720 }],
    ['телефон', { width: 390, height: 844 }],
    ['телефон лёжа', { width: 844, height: 390 }],
  ]) {
    test(`${name}: длинный список не выдавливает вкладки, назад на «Отряд» можно, панель не вылезает за экран`, async ({ page }) => {
      const frame = await startGame(page, viewport);
      const panel = page.frameLocator(FRAME).locator('#_cheats');
      const party = panel.getByRole('tab', { name: 'Отряд' });
      await expect(panel.getByText('Вылечить отряд')).toBeVisible();
      const start = await measure(frame);
      expect(start.tabs).toBeGreaterThanOrEqual(start.chip);
      for (const [tab, row] of [['Предметы', 'Item 1'], ['Переменные', 'Var 1']]) {
        await panel.getByRole('tab', { name: tab }).click();
        await expect(panel.locator('._ch_item').first()).toContainText(row);
        const now = await measure(frame);
        // Список и правда длиннее панели: иначе вкладкам нечем было бы мешать
        expect(now.scrolls).toBe(true);
        expect(now.tabs).toBe(start.tabs);
        expect(now.fits).toBe(true);
        // Настоящий щелчок: Playwright проверит, что под точкой — сама вкладка, а не список
        await party.click();
        await expect(party).toHaveClass(/_on/);
        await expect(panel.getByText('Вылечить отряд')).toBeVisible();
      }
    });
  }
});
