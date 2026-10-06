import { expect, test } from '@playwright/test';

const rootTask = {
  id: 'home-visual-root', title: 'Compare water villas and island routes',
  description: 'Compare water villas and island routes', input: 'Compare water villas',
  mode: 'direct', status: 'done', priority: 'normal', createdBy: 'user',
  assigneeId: 'researcher', retryCount: 0, maxRetries: 1, dependsOn: [],
  createdAt: '2026-09-18T10:00:00Z', completedAt: '2026-09-18T10:02:00Z',
};

for (const width of [390, 760, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`focused Home stays usable at ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(({ theme, taskId }) => {
        localStorage.setItem('myrmecia.theme', theme);
        localStorage.setItem('myrmecia.home-current-task', JSON.stringify({ taskId, request: 'Old completed request' }));
      }, { theme, taskId: rootTask.id });
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({
        json: [rootTask, {
          ...rootTask, id: 'home-visual-followup', parentTaskId: rootTask.id,
          assigneeId: 'xiaohongshu-writer', output: '**Evidence**: [Source](https://example.com) checked.',
          createdAt: '2026-09-20T10:00:00Z', completedAt: '2026-09-20T10:02:00Z',
        }],
      }));
      await page.goto('/');
      const home = page.locator('[data-home-workspace]');
      await expect(home.getByRole('heading', { name: 'Recent conversations' })).toBeVisible();
      await expect(home.locator('[data-home-conversation]')).toHaveCount(1);
      await expect(home.getByRole('region', { name: 'Current task' })).toHaveCount(0);
      await expect(home.getByText('Active agents', { exact: true })).toHaveCount(0);
      await expect(home.locator('[data-home-conversation]')).toContainText('2 turns');
      await expect(home.locator('[data-home-conversation]')).not.toContainText('**Evidence**');

      await home.getByRole('button', { name: 'Review a codebase', exact: true }).click();
      await expect(page.getByLabel('Describe work for your Agent Team')).toHaveValue(/Review the current project/);
      for (const name of ['Choose a Team', 'Model settings', 'Set workspace']) {
        await home.getByRole('button', { name, exact: true }).click();
        const dialog = home.getByRole('dialog', { name, exact: true });
        await expect(dialog).toBeVisible();
        await expect.poll(async () => {
          const box = await dialog.boundingBox();
          return Boolean(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 901);
        }).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }

      const services = home.getByRole('button', { name: /工具与服务/ });
      await services.click();
      await expect(home.getByRole('region', { name: '工具与服务', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(services).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(() => page.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`home-${theme}-${width}.png`) });
      expect(pageErrors).toEqual([]);
    });
  }
}
