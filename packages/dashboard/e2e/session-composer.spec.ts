import { expect, test } from '@playwright/test';

const task = {
  id: 'composer-fixture', title: 'Composer design review', input: 'Review the input experience',
  description: '', mode: 'direct', status: 'running', priority: 'normal', createdBy: 'user',
  assigneeId: 'dev', retryCount: 0, maxRetries: 0, dependsOn: [], createdAt: '2026-10-06T00:00:00Z',
};

const execution = {
  id: 'composer-run', taskId: task.id, agentDefId: 'dev', status: 'running',
  startedAt: task.createdAt, progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [] },
  runState: { schemaVersion: 1, phase: 'thinking', turn: 1, toolCallCount: 0, agentName: 'Dev Agent', updatedAt: task.createdAt },
};

test.beforeEach(async ({ page }) => {
  // Isolated data and intercepted writes: never invoke or mutate a real Agent.
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({ json: [task] }));
  await page.route(/\/api\/v1\/executions(?:\?.*)?$/, route => route.fulfill({ json: [execution] }));
  await page.route(/\/api\/v1\/pipelines(?:\?.*)?$/, route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/executions/composer-run/messages**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/tasks/composer-fixture/documents', route => route.fulfill({ json: [] }));
});

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`compact composer in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(theme => localStorage.setItem('myrmecia.theme', theme), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('/');
      const nav = page.getByRole('button', { name: 'Task session', exact: true });
      if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open navigation' }).click();
      await nav.click();
      const form = page.getByRole('form', { name: 'Send follow-up instruction' });
      const input = page.getByRole('textbox', { name: 'Follow-up instruction', exact: true });
      const send = form.getByRole('button', { name: 'Send follow-up', exact: true });
      await expect(form.getByRole('button', { name: 'Attach knowledge', exact: true })).toBeVisible();
      await expect(form.locator('.session-composer-destination')).toContainText('Dev Agent');
      await expect(page.getByRole('region', { name: 'Session knowledge details' })).toHaveCount(0);
      await expect(send).toBeDisabled();
      await input.fill('请继续分析刚才的方案。');
      await expect(send).toBeEnabled();
      // The outer material is the only editing frame, including when focused.
      await expect(input).toHaveCSS('box-shadow', 'none');
      await expect(input).toHaveCSS('outline-style', 'none');
      await expect(input).toHaveCSS('border-top-width', '0px');
      const help = form.getByRole('button', { name: 'About session knowledge' });
      await help.click();
      await expect(help).toHaveAttribute('aria-expanded', 'true');
      const details = page.getByRole('region', { name: 'Session knowledge details' });
      await expect(details).toContainText('5 MB');
      await expect(details).toContainText('not saved to long-term Memory');
      await expect(input).toHaveValue('请继续分析刚才的方案。');
      await help.click();
      await expect(details).toHaveCount(0);
      // Attachment information is disclosure only, never an accidental submit.
      let sent = '';
      await page.route('**/api/v1/executions/composer-run/message', async route => {
        sent = route.request().postDataJSON().content;
        await route.fulfill({ json: { ok: true } });
      });
      await input.click();
      const box = (await form.boundingBox())!;
      expect(box.height).toBeLessThan(130);
      await expect.poll(() => page.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`composer-${theme}-${width}.png`), animations: 'disabled' });
      await input.press('Shift+Enter');
      await expect(input).toHaveValue('请继续分析刚才的方案。\n');
      expect(sent).toBe('');
      await input.press('Enter');
      await expect.poll(() => sent).toBe('请继续分析刚才的方案。');
      expect(errors).toEqual([]);
    });
  }
}

test('knowledge attaches inside the composer, previews safely and blocks sending while parsing', async ({ page }) => {
  let finishParsing!: () => void;
  const parsing = new Promise<void>(resolve => { finishParsing = resolve; });
  const doc = { id: 'composer-doc', name: 'brief.md', sizeBytes: 8, passageCount: 1, createdAt: task.createdAt };
  await page.route('**/api/v1/tasks/composer-fixture/documents', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
    await parsing;
    await route.fulfill({ json: doc });
  });
  await page.route('**/api/v1/tasks/composer-fixture/documents/composer-doc', route => route.fulfill({
    json: { ...doc, passages: [{ locator: 'Paragraph 1', text: '<script>private briefing</script>' }] },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Task session', exact: true }).click();
  const form = page.getByRole('form', { name: 'Send follow-up instruction' });
  await page.getByRole('textbox', { name: 'Follow-up instruction', exact: true }).fill('Read my briefing.');
  const send = form.getByRole('button', { name: 'Send follow-up', exact: true });
  await expect(send).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await form.getByRole('button', { name: 'Attach knowledge', exact: true }).click();
  await (await chooser).setFiles({ name: 'brief.md', mimeType: 'text/markdown', buffer: Buffer.from('Briefing') });
  await expect(form.getByRole('status')).toContainText('Parsing brief.md');
  await expect(send).toBeDisabled();
  finishParsing();
  await expect(form.getByRole('button', { name: /brief\.md.*Ready/ })).toBeVisible();
  await expect(send).toBeEnabled();
  await form.getByRole('button', { name: /brief\.md.*Ready/ }).click();
  const preview = page.getByRole('region', { name: 'Parsed document preview' });
  await expect(preview).toContainText('<script>private briefing</script>');
  await preview.getByRole('button', { name: 'Close document preview' }).click();
  await expect(preview).toHaveCount(0);
});
