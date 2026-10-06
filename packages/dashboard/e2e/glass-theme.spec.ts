import { expect, test } from '@playwright/test';

const task = {
  id: 'glass-theme-task', title: 'Glass theme conversation', input: 'Review the interface',
  description: '', mode: 'direct', status: 'done', priority: 'normal', createdBy: 'user',
  assigneeId: 'fixture-agent', retryCount: 0, maxRetries: 0, dependsOn: [],
  createdAt: '2026-10-06T00:00:00Z', output: '## Readable output\n\nThe conversation keeps its content surface.',
};

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`glass controls remain usable in ${theme} mode at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(theme => localStorage.setItem('myrmecia.theme', theme), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      // No mutation or real model invocation: render an isolated conversation.
      await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({ json: [task] }));
      await page.route(/\/api\/v1\/pipelines(?:\?.*)?$/, route => route.fulfill({ json: [] }));
      await page.route(/\/api\/v1\/executions(?:\?.*)?$/, route => route.fulfill({ json: [] }));
      await page.goto('/');
      const toolbar = page.locator('[data-app-toolbar]');
      await expect(toolbar).toHaveClass(/glass-surface/);
      await expect(toolbar).toHaveCSS('backdrop-filter', /blur/);
      const composer = page.locator('.home-command-card');
      await expect(composer).toHaveCSS('backdrop-filter', /blur/);
      await page.getByLabel('Describe work for your Agent Team').fill('A draft that must survive a theme change.');
      await page.getByRole('button', { name: `Switch to ${theme === 'light' ? 'dark' : 'light'} theme` }).click();
      await expect(page.getByLabel('Describe work for your Agent Team')).toHaveValue('A draft that must survive a theme change.');
      await page.getByRole('button', { name: `Switch to ${theme} theme` }).click();
      await page.getByRole('button', { name: 'Choose a Team', exact: true }).click();
      const popup = page.getByRole('dialog', { name: 'Choose a Team', exact: true });
      await expect(popup).toHaveClass(/glass-popup/);
      await expect(popup).toHaveCSS('backdrop-filter', /blur/);
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      const content = await page.locator('[data-home-content]').boundingBox();
      const main = await page.locator('.app-glass-content').boundingBox();
      expect(content).not.toBeNull();
      expect(main).not.toBeNull();
      expect(Math.abs(content!.y + content!.height / 2 - (main!.y + main!.height / 2))).toBeLessThan(16);
      await page.screenshot({ path: testInfo.outputPath(`glass-home-${theme}-${width}.png`), animations: 'disabled' });

      const nav = page.getByRole('button', { name: 'Task session', exact: true });
      if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open navigation' }).click();
      await nav.click();
      await expect(page.getByRole('region', { name: 'Task conversation' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Follow-up instruction', exact: true })).toBeVisible();
      await expect(page.locator('.agent-composer')).toHaveCSS('backdrop-filter', /blur/);
      // Long text is not on a blurred rendering surface.
      await expect(page.locator('.agent-chat-thread')).toHaveCSS('backdrop-filter', 'none');
      await expect.poll(() => page.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`glass-chat-${theme}-${width}.png`), animations: 'disabled' });
      expect(errors).toEqual([]);
    });
  }
}

test('increased contrast and reduced motion remove material effects without hiding controls', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('[data-app-toolbar]')).toHaveCSS('backdrop-filter', 'none');
  await expect(page.locator('.home-command-card')).toHaveCSS('backdrop-filter', 'none');
  await page.getByRole('button', { name: 'Model settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model settings', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('backdrop-filter', 'none');
  await expect(dialog).toHaveCSS('animation-name', 'none');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Model settings', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Model settings', exact: true })).toBeFocused();
});
