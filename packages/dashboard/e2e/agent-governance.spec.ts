import { expect, test } from '@playwright/test';
test.skip(!process.env.RUNTIME_V2_REAL_BACKEND, 'Dedicated fixture backend required; no mocked API routes');
const api = `http://127.0.0.1:${process.env.RUNTIME_V2_API_PORT || 3350}/api/v1`;
test('governance: create/reload, private citation, budgets, debug pause/resume and acceptance', async ({ page, request }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Setup Wizard', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: '创建与调试 Agent' });
  await wizard.getByRole('textbox', { name: 'Name', exact: true }).fill('Governance E2E Fixture');
  await wizard.getByRole('textbox', { name: '系统指令 / System instructions（可选）', exact: true }).fill('Use only supplied fixture evidence and render Markdown citations.');
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  for (const name of ['Crawler Link Extractor crawler.extract_links · crawler · medium', 'Web Fetch web.fetch · research · medium', 'Web Search web.search · research · medium'])
    await wizard.getByRole('checkbox', { name, exact: true }).uncheck();
  await wizard.getByRole('checkbox', { name: 'File Read file_read · engineering · low', exact: true }).check();
  await wizard.getByRole('combobox').selectOption('gpt-5.4-mini');
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  await wizard.getByRole('button', { name: '仅保存 Agent', exact: true }).click();
  const setup = wizard.getByRole('region', { name: 'Setup progress' });
  await expect(setup).toContainText('Agent 已创建');
  const agents = await (await request.get(`${api}/agents`)).json();
  const agent = agents.find((item: any) => item.name === 'Governance E2E Fixture');
  expect(agent).toBeTruthy();
  const uploaded = await request.post(`${api}/agents/${agent.id}/knowledge/upload?scope=agent_private`, {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': 'evidence.md' },
    data: '# Governance fixture\n\nOnly this private source contains GOVERNANCE-SOURCE-OK.',
  });
  expect(uploaded.status()).toBe(201);
  await wizard.locator('summary').filter({ hasText: /^执行限额与预算$/ }).click();
  const budget = wizard.getByRole('region', { name: 'Agent budget editor' });
  await budget.getByRole('spinbutton', { name: 'Token 配额', exact: true }).fill('12000');
  await budget.getByRole('spinbutton', { name: '最大轮数', exact: true }).fill('8');
  await budget.getByRole('button', { name: '保存预算 · r0', exact: true }).click();
  await expect(budget.getByRole('button', { name: '保存预算 · r1', exact: true })).toBeVisible();
  // Reload recovers the saved setup, not a new Agent or an automatically launched test.
  await page.reload();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Setup Wizard', exact: true }).click();
  await wizard.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(setup).toContainText(agent.id);
  const before = await (await request.get(`${api}/executions`)).json();
  expect(before.filter((item: any) => item.agentDefId === agent.id)).toHaveLength(0);
  await wizard.getByRole('textbox', { name: '单次测试指令', exact: true }).fill('Summarize GOVERNANCE-SOURCE-OK with the supplied citation.');
  await wizard.getByRole('button', { name: '检查能力', exact: true }).click();
  await wizard.getByRole('button', { name: '开始试运行', exact: true }).click();
  const debug = wizard.getByRole('region', { name: 'Agent inline debugger' });
  await expect(debug).toBeVisible();
  await debug.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(debug.getByRole('status')).toHaveText('已暂停', { timeout: 30_000 });
  const taskId = (await debug.getByRole('combobox', { name: 'Debug task history' }).inputValue());
  const prior = await (await request.get(`${api}/tasks/${taskId}/budget`)).json();
  await debug.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(debug.getByRole('heading', { name: '验收回复', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(debug.getByRole('status')).toHaveText('执行结束');
  const after = await (await request.get(`${api}/tasks/${taskId}/budget`)).json();
  expect(after.find((item: any) => item.scope === 'task').observed.tokens).toBeGreaterThanOrEqual(prior.find((item: any) => item.scope === 'task').observed.tokens);
  await debug.getByRole('button', { name: '查看知识引用 K1', exact: true }).click();
  await expect(debug.getByRole('note')).toContainText('GOVERNANCE-SOURCE-OK');
  await expect(debug.locator('details[aria-label="Test artifacts"]')).not.toHaveAttribute('open');
  await debug.getByRole('button', { name: '验收通过', exact: true }).click();
  await expect(debug).toContainText('已记录验收通过');
  await debug.getByRole('textbox', { name: 'Debug follow-up instruction' }).fill('Provide one more fixture summary.');
  await debug.getByRole('button', { name: '发送追问', exact: true }).click();
  await expect(debug.getByRole('combobox', { name: 'Debug task history' }).locator('option')).toHaveCount(2);
  await expect(debug.getByRole('status')).toHaveText('执行结束', { timeout: 30_000 });
  await page.screenshot({ path: info.outputPath('governance-debug.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('governance: saved version, evaluation history, Markdown result and inline case debugger', async ({ page, request }, info) => {
  page.on('dialog', dialog => dialog.accept());
  const agentId = 'runtime-browser-agent';
  const history = await (await request.get(`${api}/agents/${agentId}/config-versions`)).json();
  const published = await request.post(`${api}/agents/${agentId}/config-versions/publish`, { data: {
    expectedCurrentVersionId: history.activeVersionId, expectedConfigHash: history.workingConfigHash,
  } });
  expect(published.ok()).toBe(true);
  const version = await published.json();
  const suiteId = crypto.randomUUID(), caseId = crypto.randomUUID();
  const saved = await request.put(`${api}/agents/${agentId}/evaluation-suites/${suiteId}`, { data: {
    expectedRevision: 0, name: 'Governance fixture regression', cases: [{
      id: caseId, name: 'Fixture marker check', prompt: 'Return the fixture marker in Markdown.',
      checks: [{ id: crypto.randomUUID(), label: 'Fixture output marker only', required: true,
        verifier: 'output_contains', text: 'runtime-v2-fixture-ok' }],
    }],
  } });
  expect(saved.ok()).toBe(true);
  // Seed the first receipt through real HTTP. The second run is submitted from
  // the UI below; no routes, runtime state or verification results are mocked.
  const first = await request.post(`${api}/agents/${agentId}/evaluation-suites/${suiteId}/runs`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() }, data: {
      selectedCaseIds: [caseId], expectedSuiteRevision: 1, configVersionId: version.id,
    },
  });
  expect(first.ok()).toBe(true);
  const firstRun = await first.json();
  await expect.poll(async () => (await (await request.get(`${api}/agents/${agentId}/evaluation-runs/${firstRun.id}`)).json())
    .results[0].status, { timeout: 30_000 }).toBe('passed');
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByPlaceholder('Search agents, roles, capabilities…').fill('Runtime Browser Agent');
  await page.getByRole('button', { name: 'Workbench', exact: true }).click();
  const versions = page.getByRole('region', { name: 'Agent 配置版本' });
  await expect(versions).toContainText(`已发布 v${version.sequence}`);
  await versions.getByRole('button', { name: new RegExp(`^v${version.sequence} · 当前发布`) }).click();
  await expect(versions).toContainText(version.configHash);
  const suites = page.getByRole('region', { name: 'Agent evaluation suites' });
  await suites.getByRole('combobox', { name: '选择测试套件' }).selectOption(suiteId);
  await suites.getByRole('combobox', { name: '测试配置版本' }).selectOption(version.id);
  await suites.getByRole('button', { name: '运行选中用例', exact: true }).click();
  await expect.poll(() => suites.getByRole('combobox', { name: '测试历史' }).inputValue()).not.toBe(firstRun.id);
  await expect(suites.getByRole('heading', { name: 'Fixture marker check · 通过', exact: true })).toBeVisible({ timeout: 30_000 });
  await suites.getByRole('combobox', { name: '对比测试' }).selectOption(firstRun.id);
  const results = suites.getByRole('region', { name: 'Evaluation results' });
  await expect(results.getByRole('table')).toContainText('Fixture marker check');
  await expect(results).toContainText('Fixture 模拟模型');
  await results.getByText('查看完整回复', { exact: true }).click();
  await expect(results.getByRole('heading', { name: '验收回复', exact: true })).toBeVisible();
  await results.getByRole('button', { name: '调试此用例', exact: true }).click();
  const debug = results.getByRole('region', { name: 'Agent inline debugger' });
  await expect(debug.getByRole('status')).toHaveText('执行结束');
  await expect(debug.getByRole('button', { name: '暂停', exact: true })).toBeDisabled();
  await expect(debug.getByRole('button', { name: '重新试运行', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('governance-evaluation.png'), fullPage: true });
});
