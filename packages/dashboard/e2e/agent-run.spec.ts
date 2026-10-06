import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`run state, explicit acceptance and refresh at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('myrmecia.theme', 'light'));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const task = {
      id: 'run-fixture-task', title: '运行契约验收', description: '请给出报告', input: '请给出报告',
      mode: 'direct', status: 'done', priority: 'normal', createdBy: 'user', assigneeId: 'fixture-agent',
      retryCount: 0, maxRetries: 0, dependsOn: [], createdAt: '2026-10-06T00:00:00Z',
      output: '## 验收报告\n\n这是隔离测试结果，不会操作真实任务。',
    };
    let execution = {
      id: 'run-fixture', taskId: task.id, agentDefId: 'fixture-agent', status: 'done',
      progress: { toolUseCount: 1, tokenCount: 100, recentActivities: [] }, costUSD: null,
      tokenCount: 100, workspaceId: 'default', startedAt: '2026-10-06T00:00:00Z',
      runState: { schemaVersion: 1, phase: 'completed', stopReason: 'completed', turn: 2, toolCallCount: 1,
        acceptance: 'pending', updatedAt: '', validation: { scope: 'output', status: 'passed', checks: [] } },
    };
    await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({ json: [task] }));
    await page.route(/\/api\/v1\/executions(?:\?.*)?$/, route => route.fulfill({ json: [execution] }));
    await page.route('**/api/v1/executions/run-fixture/messages**', route => route.fulfill({
      json: [{ id: 1, executionId: execution.id, type: 'agent_text', content: task.output, createdAt: task.createdAt }],
    }));
    await page.route('**/api/v1/executions/run-fixture/acceptance', async route => {
      expect(route.request().postDataJSON()).toEqual({ decision: 'accepted' });
      execution = { ...execution, runState: { ...execution.runState, acceptance: 'accepted' } };
      await route.fulfill({ json: execution });
    });
    const openSession = async () => {
      const nav = page.getByRole('button', { name: 'Task session', exact: true });
      if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open navigation' }).click();
      await nav.click();
    };
    await page.goto('/'); await openSession();
    const state = page.getByRole('region', { name: 'Agent 执行状态' });
    await expect(state).toContainText('正常结束');
    await expect(state).toContainText('尚未验收');
    await expect(page.getByRole('heading', { name: '验收报告', exact: true })).toBeVisible();
    await state.getByRole('button', { name: '接受结果', exact: true }).click();
    await expect(state).toContainText('你已接受此结果');
    await expect(state.getByRole('button', { name: '接受结果', exact: true })).toHaveCount(0);
    await page.reload(); await openSession();
    await expect(state).toContainText('你已接受此结果');
    await expect.poll(() => page.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`agent-run-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

test('clarification waits for the user and continues through the main composer', async ({ page }) => {
  let tasks = [{
    id: 'input-fixture', title: '等待资料', description: '分析资料', input: '分析资料',
    mode: 'direct', status: 'review', priority: 'normal', createdBy: 'user',
    assigneeId: 'fixture-agent', retryCount: 0, maxRetries: 0, dependsOn: [],
    createdAt: '2026-10-06T00:00:00Z', output: '请提供要分析的文档。',
    parentTaskId: undefined as string | undefined,
  }];
  const execution = {
    id: 'input-run', taskId: tasks[0].id, agentDefId: 'fixture-agent', status: 'done',
    startedAt: tasks[0].createdAt, costUSD: null, tokenCount: 10,
    progress: { toolUseCount: 0, tokenCount: 10, recentActivities: [] },
    runState: { schemaVersion: 1, phase: 'waiting_for_user', stopReason: 'needs_input', turn: 1, toolCallCount: 0,
      acceptance: 'pending', updatedAt: '', validation: { scope: 'output', status: 'passed', checks: [] } },
  };
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({ json: tasks }));
  await page.route(/\/api\/v1\/executions(?:\?.*)?$/, route => route.fulfill({ json: [execution] }));
  await page.route('**/api/v1/executions/input-run/messages**', route => route.fulfill({ json: [] }));
  let continued = false;
  await page.route('**/api/v1/tasks/input-fixture/continue', async route => {
    expect(route.request().postDataJSON()).toEqual({ content: '请分析上传的产品说明' });
    continued = true;
    const next = { ...tasks[0], id: 'input-followup', parentTaskId: tasks[0].id, status: 'queued', output: '' };
    tasks = [...tasks, next]; await route.fulfill({ json: next });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Task session', exact: true }).click();
  const state = page.getByRole('region', { name: 'Agent 执行状态' });
  await expect(state).toContainText('等待补充信息');
  await expect(state.getByRole('button', { name: '接受结果', exact: true })).toHaveCount(0);
  const composer = page.getByPlaceholder('Ask a follow-up in this conversation…');
  await composer.fill('请分析上传的产品说明');
  await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
  await expect.poll(() => continued).toBe(true);
});

test('failed root and completed QA child never offer acceptance or claim normal task completion', async ({ page }, testInfo) => {
  const root = {
    id: 'quality-failed-root', title: 'hello', input: 'hello', description: 'hello',
    mode: 'direct', status: 'failed', priority: 'normal', createdBy: 'user', assigneeId: 'dev',
    retryCount: 0, maxRetries: 0, dependsOn: [], createdAt: '2026-10-06T00:00:00Z',
    error: 'blocked: Test/QA command execution requires approval; validation was not run.',
  };
  const child = { ...root, id: 'quality-qa-child', title: 'Test: hello', status: 'done', parentTaskId: root.id, assigneeId: 'qa', error: null };
  const run = {
    id: 'quality-qa-run', taskId: child.id, agentDefId: 'qa', status: 'done', startedAt: root.createdAt,
    progress: { toolUseCount: 0, tokenCount: 10, recentActivities: [] },
    runState: { schemaVersion: 1, phase: 'completed', stopReason: 'completed', turn: 1, toolCallCount: 0,
      acceptance: 'pending', updatedAt: root.createdAt, validation: { scope: 'output', status: 'passed', checks: [] } },
  };
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({ json: [root, child] }));
  await page.route(/\/api\/v1\/executions(?:\?.*)?$/, route => route.fulfill({ json: [run] }));
  await page.route('**/api/v1/executions/quality-qa-run/messages**', route => route.fulfill({ json: [] }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Task session', exact: true }).click();
  const state = page.getByRole('region', { name: 'Agent 执行状态' });
  await expect(state).toContainText('整体任务未完成');
  await expect(state).toContainText('内部质量检查');
  await expect(state.getByRole('alert')).toContainText('requires approval');
  await expect(state).not.toContainText('正常结束');
  await expect(state.getByRole('button', { name: '接受结果', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('failed-quality-gate.png') });
});

test('model request exposes real waiting time, deadline and terminal timeout', async ({ page }, testInfo) => {
  const timestamp = new Date().toISOString();
  let task = {
    id: 'waiting-model-task', title: 'hello', input: 'hello', description: 'hello', mode: 'direct',
    status: 'running', priority: 'normal', createdBy: 'user', assigneeId: 'dev', retryCount: 0, maxRetries: 0,
    dependsOn: [], createdAt: timestamp, error: '',
  };
  let run = {
    id: 'waiting-model-run', taskId: task.id, agentDefId: 'dev', status: 'running', startedAt: timestamp,
    progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [] },
    runState: { schemaVersion: 1, phase: 'deciding', acceptance: 'pending', turn: 1, toolCallCount: 0, updatedAt: timestamp,
      stopReason: undefined as string | undefined,
      modelRequest: { modelId: 'fixture-model', startedAt: new Date(Date.now() - 35_000).toISOString(), deadlineAt: new Date(Date.now() + 25_000).toISOString() } as object | undefined },
  };
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({ json: [task] }));
  await page.route(/\/api\/v1\/executions(?:\?.*)?$/, route => route.fulfill({ json: [run] }));
  await page.route('**/api/v1/executions/waiting-model-run/messages**', route => route.fulfill({ json: [] }));
  await page.goto('/');
  const open = async () => page.getByRole('button', { name: 'Task session', exact: true }).click();
  await open();
  const state = page.getByRole('region', { name: 'Agent 执行状态' });
  await expect(state).toContainText('等待模型首条输出');
  await expect(state.getByRole('status')).toContainText('fixture-model');
  await expect(state.getByRole('status')).toContainText('已等待');
  await expect(state.getByRole('status')).toContainText('不是任务完成进度');
  await expect(state.getByRole('status')).toContainText('请求截止');
  await page.screenshot({ path: testInfo.outputPath('model-waiting.png') });
  task = { ...task, status: 'failed', error: 'EXECUTION_WALL_TIMEOUT: request deadline exceeded' };
  run = { ...run, status: 'failed', runState: { ...run.runState, phase: 'failed', stopReason: 'deadline', modelRequest: undefined } };
  await page.reload(); await open();
  await expect(state.getByRole('alert')).toContainText('EXECUTION_WALL_TIMEOUT');
  await expect(state.getByRole('status')).toHaveCount(0);
  await expect(state.getByRole('button', { name: '接受结果', exact: true })).toHaveCount(0);
});
