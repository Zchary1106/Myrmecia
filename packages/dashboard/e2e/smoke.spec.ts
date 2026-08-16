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

test('team composer exposes canvas, contract inspector and versions', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Canvas').click();
  await expect(page.getByTestId('team-composer')).toBeVisible();
  await expect(page.getByText('Building blocks')).toBeVisible();
  await expect(page.getByText('Compose your agent team')).toBeVisible();
  await page.getByRole('button', { name: 'Versions' }).click();
  await expect(page.getByTestId('template-version-bar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft version' })).toBeVisible();
});

test('team composer remains usable when the window is resized', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 700 });
  await page.goto('/');
  await page.getByTitle('Canvas').click();

  await expect(page.getByTestId('team-composer')).toBeVisible();
  await expect(page.getByText('Building blocks')).toBeVisible();
  await page.getByTitle('Toggle palette').click();
  await expect(page.getByText('Building blocks')).toBeHidden();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTitle('Toggle palette').click();
  await expect(page.getByText('Building blocks')).toBeVisible();
  await expect(page.getByText('Inspector', { exact: true })).toBeVisible();
});

test('Content Studio opens the governed WeChat article workflow', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Agents').click();
  await page.getByRole('button', { name: /Content Studio/i }).click();

  await expect(page.getByTestId('content-studio')).toBeVisible();
  await page.getByTestId('content-studio-team').selectOption('content');
  await expect(page.getByRole('heading', { name: 'WeChat Official Account Studio' })).toBeVisible();
  await expect(page.getByText('选题 · 写作 · 审核 · 排版 · 草稿箱 · 人工发布', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create WeChat article run' })).toBeVisible();
});
