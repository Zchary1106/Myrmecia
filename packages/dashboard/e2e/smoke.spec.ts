import { test, expect } from '@playwright/test';

test('dashboard loads and shows navigation', async ({ page }) => {
  await page.goto('/');
  // Verify the app renders
  await expect(page.locator('body')).toBeVisible();
  // Check for main navigation items
  await expect(page.getByText(/tasks|agents|overview/i).first()).toBeVisible();
});

test('home composer exposes Team, Workflow, history, and theme controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What should your team work on?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use a Team' })).toBeVisible();
  await expect(page.getByText('Recent work', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Switch to (light|dark) theme/ })).toBeVisible();

  await page.getByRole('button', { name: 'Use a Team' }).click();
  await expect(page.getByText('Choose a Team', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose workflow', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Launch work' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Pipeline.*Run a template/ })).toBeVisible();
});

test('home shell remains usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What should your team work on?' })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});

test('tasks page is accessible', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Queue').click();
  await expect(page.getByRole('heading', { name: 'Work Queue' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByText('10 / page · newest first')).toBeVisible();
  const rows = page.getByRole('row').filter({ has: page.getByRole('cell') });
  expect(await rows.count()).toBeLessThanOrEqual(10);
  if (await rows.count()) {
    await rows.first().click();
    await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible();
    await page.getByRole('button', { name: 'Close task details' }).click();
    await expect(page.getByRole('complementary', { name: 'Task details' })).toBeHidden();
  }
});

test('artifact workbench is accessible', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Artifacts').click();
  await expect(page.getByRole('heading', { name: 'Outputs you can actually inspect' })).toBeVisible();
  await expect(page.getByText('No artifacts yet')).toBeVisible();
});

test('workflow catalog keeps visual canvas as an advanced entry', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Workflows' }).click();
  await expect(page.getByText('Visual workflow canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open visual canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Open visual canvas' }).click();
  await expect(page.getByTestId('team-composer')).toBeVisible();
  await expect(page.getByText('Building blocks')).toBeVisible();
});

test('agent catalog keeps creation advanced and preserves the workspace entry', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Agents').click();
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Agent workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: /All Agents/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create Custom Agent' })).toBeHidden();
  await page.getByRole('button', { name: 'Create Agent' }).click();
  await expect(page.getByRole('heading', { name: 'Create Custom Agent' })).toBeVisible();
});

test('skill catalog separates registry, version editor, assignments, and marketplace', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Skills').click();
  await expect(page.getByRole('heading', { name: 'Skills', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Skill sections' })).toBeVisible();
  await expect(page.getByPlaceholder('Search skills or source paths…')).toBeVisible();
  await page.getByRole('button', { name: /Version editor/ }).click();
  await expect(page.getByRole('heading', { name: 'Skills', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Assignments/ }).click();
  await expect(page.getByRole('heading', { name: 'Agent assignments' })).toBeVisible();
});

async function openCanvasFromTeams(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTitle('Teams').click();
  const openCanvas = page.getByRole('button', { name: /Canvas/ });
  await expect(openCanvas).toBeVisible();
  await openCanvas.click();
}

test('team composer exposes canvas, contract inspector and versions', async ({ page }) => {
  await openCanvasFromTeams(page);
  await expect(page.getByTestId('team-composer')).toBeVisible();
  await expect(page.getByText('Building blocks')).toBeVisible();
  await expect(page.getByText('Compose your agent team')).toBeVisible();
  await page.getByRole('button', { name: 'Versions' }).click();
  await expect(page.getByTestId('template-version-bar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft version' })).toBeVisible();
});

test('team composer remains usable when the window is resized', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 700 });
  await openCanvasFromTeams(page);

  await expect(page.getByTestId('team-composer')).toBeVisible();
  await expect(page.getByText('Building blocks')).toBeVisible();
  await page.getByTitle('Toggle palette').click();
  await expect(page.getByText('Building blocks')).toBeHidden();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTitle('Toggle palette').click();
  await expect(page.getByText('Building blocks')).toBeVisible();
  await expect(page.getByText('Inspector', { exact: true })).toBeVisible();
});

test('configuration entry points expose Models, Tools, Costs, and Settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Models & providers', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Registry' })).toBeVisible();
  await page.getByRole('tab', { name: 'MCP' }).click();
  await expect(page.getByRole('heading', { name: 'MCP connections' })).toBeVisible();
  await page.getByRole('button', { name: 'Costs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Costs', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Token and cost trend chart' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});

test('WeChat article remains available as a governed workflow preset', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Workflows').click();
  await page.getByPlaceholder('Search workflows or stages…').fill('WeChat Article');
  await page.getByRole('button', { name: /WeChat Article/ }).click();
  await expect(page.getByRole('heading', { name: 'WeChat Article', level: 2 })).toBeVisible();
  await expect(page.getByText('Human publish confirmation retained')).toBeVisible();
});

test('memory presents workspace knowledge before technical graph controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
  await expect(page.getByText('Total knowledge')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Knowledge library' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Knowledge graph' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace knowledge map' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add knowledge' })).toBeVisible();
});

test('configuration pages expose their primary workspaces', async ({ page }) => {
  await page.goto('/');
  for (const pageName of ['Models', 'Tools', 'Costs', 'Settings']) {
    await page.getByRole('button', { name: pageName, exact: true }).click();
    await expect(page.locator('[data-configuration-page]')).toBeVisible();
  }
});

test('cost overview renders visual usage charts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Costs', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Token and cost trend chart' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Input and output token mix' })).toBeVisible();
  await expect(page.getByText('Usage by model')).toBeVisible();
  await expect(page.getByText('Recent Task Usage')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Overview' })).toHaveCount(0);
});
