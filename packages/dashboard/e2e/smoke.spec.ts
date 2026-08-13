import { test, expect } from '@playwright/test';

test('dashboard loads and shows navigation', async ({ page }) => {
  await page.goto('/');
  // Verify the app renders
  await expect(page.locator('body')).toBeVisible();
  // Check for main navigation items
  await expect(page.getByText(/tasks|agents|overview/i).first()).toBeVisible();
});

test('tasks page is accessible', async ({ page }) => {
  await page.goto('/tasks');
  await expect(page.locator('body')).toBeVisible();
});

test('artifact workbench is accessible', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Artifacts').click();
  await expect(page.getByRole('heading', { name: 'Outputs you can actually inspect' })).toBeVisible();
  await expect(page.getByText('No artifacts yet')).toBeVisible();
});

test('WeChat writer opens the governed article studio', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Agents').click();
  await page.getByText('公众号写手', { exact: true }).click();

  await expect(page.getByTestId('content-studio')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'WeChat Official Account Studio' })).toBeVisible();
  await expect(page.getByText('选题 · 写作 · 审核 · 排版 · 草稿箱 · 人工发布', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create WeChat article run' })).toBeVisible();
});
