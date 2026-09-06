import { expect, test } from '@playwright/test';

test('core content team shows a clear Team Contract entry', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Teams', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Teams', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /Social Three-Lane Team/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Workflow presets/ })).toBeVisible();
});

test('Agents keeps custom creation secondary to the catalog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /All Agents/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create Custom Agent' })).toBeHidden();
  await page.getByRole('button', { name: 'Create Agent' }).click();
  await expect(page.getByRole('heading', { name: 'Create Custom Agent' })).toBeVisible();
});
test('content publishing remains a governed workflow preset', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page.getByPlaceholder('Search workflows or stages…').fill('WeChat Article');
  await page.getByRole('button', { name: /WeChat Article/ }).click();

  await expect(page.getByRole('heading', { name: 'WeChat Article', level: 2 })).toBeVisible();
  await expect(page.getByText('Human publish confirmation retained')).toBeVisible();
});
