import { test, expect } from '@playwright/test';

/**
 * Phase 4/5 main-path coverage: Team v2 preflight, legacy alias grouping,
 * and Team-driven Content Studio switching (T20).
 */

test('v2 content team shows Contract v2 badge and preflight panel', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Teams').click();
  await page.getByText('Xiaohongshu Team', { exact: true }).click();

  await expect(page.getByTestId('contract-v2-badge')).toBeVisible();
  await expect(page.getByTestId('team-preflight')).toBeVisible();
  await expect(page.getByText('v2 role slots', { exact: false })).toBeVisible();
});

test('agent settings groups legacy aliases in a collapsed section', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Agents').click();
  await page.getByTitle('Manage Agents').click();

  const legacySection = page.getByTestId('legacy-aliases');
  await expect(legacySection).toBeVisible();
  await legacySection.getByText('Legacy aliases').click();
  await expect(page.getByText('公众号写手', { exact: true })).toBeVisible();
});

test('content studio switches teams from the studio header', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Agents').click();
  await page.getByText('小红书写手', { exact: true }).click();

  await expect(page.getByTestId('content-studio')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Xiaohongshu Content Studio' })).toBeVisible();

  await page.getByTestId('content-studio-team').selectOption('douyin');
  await expect(page.getByRole('heading', { name: 'Douyin Script & Publish Studio' })).toBeVisible();
  await expect(page.getByTestId('content-studio-team')).toHaveValue('douyin');
});
