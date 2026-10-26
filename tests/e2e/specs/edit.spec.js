import { test, expect, openLibrary, openGame, apiGames } from '../fixtures.js';

const game = async (page, title) => (await apiGames(page)).find((g) => g.title === title);

// Окно игры → «Изменить»
async function edit(page, title) {
  await openLibrary(page);
  await openGame(page, title);
  await page.locator('.grimoire-action-btn', { hasText: 'Изменить' }).click();
  await expect(page.locator('.edit-form')).toBeVisible();
}

// Поле формы по подписи над ним
const field = (page, label) => page.locator('.edit-field').filter({ has: page.locator('label', { hasText: label }) }).locator('input');

test.describe('правка сведений', () => {
  test('поля и ссылка сохраняются; Enter в поле ссылки добавляет её, а не сохраняет форму', async ({ page }) => {
    await edit(page, 'Hollow Spire');
    await field(page, 'Разработчик').fill('Kettle & Sons');
    await field(page, 'Добавить ссылку').fill('https://store.steampowered.com/app/100');
    await field(page, 'Добавить ссылку').press('Enter');
    await expect(page.locator('.edit-link')).toHaveCount(1);
    await expect(page.locator('.edit-link')).toContainText('steampowered');
    await expect(page.locator('.edit-form')).toBeVisible();

    await field(page, 'Добавить ссылку').fill('not a link');
    await page.locator('.edit-add-btn').click();
    await expect(page.locator('.edit-error')).toHaveText('Это не ссылка');
    await field(page, 'Добавить ссылку').fill('');

    // Enter в обычном поле — «Сохранить»
    await field(page, 'Разработчик').press('Enter');
    // Ссылку сервер ищет сразу; без интернета поиск ничего не находит, но вписанное остаётся
    await expect(page.locator('.edit-form')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('#modal-title')).toHaveText('Hollow Spire');
    const saved = await game(page, 'Hollow Spire');
    expect(saved.developer).toBe('Kettle & Sons');
    expect(saved.link).toContain('store.steampowered.com/app/100');
  });

  test('несохранённое не пропадает молча: «Отмена», Escape и крестик спрашивают; без изменений — не спрашивают', async ({ page }) => {
    await edit(page, 'Ashen Crown');
    await field(page, 'Название').fill('Ashen Crown Remastered');

    await page.locator('.edit-footer .cancel-btn').click();
    await expect(page.locator('.confirm-box')).toContainText('Не сохранять изменения?');
    await page.locator('.confirm-cancel').click();
    await expect(field(page, 'Название')).toHaveValue('Ashen Crown Remastered');

    // Крестик закрыл бы всё окно игры — тоже вопрос; «Вернуться к правке» оставляет окно
    await page.locator('.modal-close').click();
    await expect(page.locator('.confirm-box')).toBeVisible();
    await page.locator('.confirm-cancel').click();
    await expect(page.locator('.edit-form')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.locator('.confirm-ok').click();
    await expect(page.locator('.edit-form')).toHaveCount(0);
    await expect(page.locator('#modal-title')).toHaveText('Ashen Crown');
    expect((await apiGames(page)).some((g) => g.title === 'Ashen Crown Remastered')).toBe(false);

    await page.locator('.grimoire-action-btn', { hasText: 'Изменить' }).click();
    await page.locator('.edit-footer .cancel-btn').click();
    await expect(page.locator('.edit-form')).toHaveCount(0);
    await expect(page.locator('.confirm-box')).toHaveCount(0);
  });

  test('жест «назад» с изменениями спрашивает; вернулись к правке — следующий «назад» снова спрашивает, окно игры не закрывается', async ({ page }) => {
    await edit(page, 'The Last Lighthouse');
    await field(page, 'Разработчик').fill('Someone Else');
    await page.goBack();
    await expect(page.locator('.confirm-box')).toBeVisible();
    await page.locator('.confirm-cancel').click();
    await expect(page.locator('.confirm-box')).toHaveCount(0);
    await expect(field(page, 'Разработчик')).toHaveValue('Someone Else');

    await page.goBack();
    await expect(page.locator('.confirm-box')).toBeVisible();
    await page.locator('.confirm-ok').click();
    await expect(page.locator('.edit-form')).toHaveCount(0);
    await expect(page.locator('#modal-title')).toHaveText('The Last Lighthouse');
    expect((await game(page, 'The Last Lighthouse')).developer).toBe('Little Lantern');
  });

  test('обложка меняется только по «Сохранить»; «Вернуть найденную» показывает её заранее', async ({ page }) => {
    const before = (await game(page, 'Sky Knight Chronicles')).cover;
    await edit(page, 'Sky Knight Chronicles');
    const file = page.locator('.edit-cover input[type=file]');
    const png = await page.locator('.edit-cover-frame').screenshot();

    await file.setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('.edit-cover-frame')).toHaveClass(/changed/);
    await expect(page.locator('.edit-cover')).toContainText('сохранится вместе с остальным');
    await page.locator('.edit-footer .cancel-btn').click();
    await page.locator('.confirm-ok').click();
    await expect(page.locator('.edit-form')).toHaveCount(0);
    expect((await game(page, 'Sky Knight Chronicles')).cover).toBe(before);

    await page.locator('.grimoire-action-btn', { hasText: 'Изменить' }).click();
    await file.setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    await page.locator('.edit-footer .save-btn').click();
    await expect(page.locator('.edit-form')).toHaveCount(0);
    await expect.poll(async () => (await game(page, 'Sky Knight Chronicles')).cover).toMatch(/cover_custom/);

    await page.locator('.grimoire-action-btn', { hasText: 'Изменить' }).click();
    await page.locator('.edit-cover button', { hasText: 'Вернуть найденную' }).click();
    await expect(page.locator('.edit-cover')).toContainText('вернётся после «Сохранить»');
    await expect(page.locator('.edit-cover-frame img')).toHaveAttribute('src', new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect((await game(page, 'Sky Knight Chronicles')).cover).toMatch(/cover_custom/);
    await page.locator('.edit-footer .save-btn').click();
    await expect.poll(async () => (await game(page, 'Sky Knight Chronicles')).cover).toBe(before);
  });
});
