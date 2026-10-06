import { expect, test } from '@playwright/test';

const base = {
  description: 'Isolated conversation fixture', input: 'Fixture request', mode: 'direct', status: 'done',
  priority: 'normal', createdBy: 'user', retryCount: 0, maxRetries: 0, dependsOn: [],
  assigneeId: 'fixture-agent', createdAt: '2026-09-20T10:00:00Z', completedAt: '2026-09-20T10:01:00Z',
};
const tasks = [
  { ...base, id: 'history-a', title: 'History fixture A', output: 'Completed A.' },
  { ...base, id: 'history-a-turn', title: 'Follow-up A', parentTaskId: 'history-a', output: 'Follow-up complete.' },
  { ...base, id: 'history-b', title: 'History fixture B', output: 'Completed B.' },
  { ...base, id: 'history-active', title: 'Running fixture', status: 'waiting_for_tool', completedAt: undefined },
];

for (const width of [1280, 390]) {
  test(`archive, restore and confirmed batch deletion work at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('myrmecia.theme', 'light'));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // Test fixture only. Never manage actual user conversations.
    await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({ json: tasks }));
    await page.route(/\/api\/v1\/executions(?:\?.*)?$/, route => route.fulfill({ json: [] }));
    let states: Array<{ id: string; status: 'archived' | 'deleted'; updatedAt: string }> = [];
    const mutations: Array<{ taskIds: string[]; action: string; confirm: boolean }> = [];
    await page.route('**/api/v1/conversations**', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: states });
      const body = route.request().postDataJSON() as typeof mutations[number];
      expect(body.taskIds.every(id => ['history-a', 'history-b'].includes(id))).toBe(true);
      if (body.action === 'delete') expect(body.confirm).toBe(true);
      mutations.push(body);
      const ids = body.taskIds.map(id => `task:${id}`);
      states = states.filter(item => !ids.includes(item.id));
      if (body.action !== 'restore') states.push(...ids.map(id => ({ id, status: body.action === 'delete' ? 'deleted' as const : 'archived' as const, updatedAt: new Date().toISOString() })));
      return route.fulfill({ json: { states, affectedConversationIds: ids } });
    });
    const nav = async (name: string) => {
      const button = page.getByRole('button', { name, exact: true });
      if (!(await button.isVisible())) await page.getByRole('button', { name: 'Open navigation' }).click();
      await button.click();
    };
    // The mobile drawer starts hidden, so locate its DOM before opening it.
    const history = page.locator('[aria-label="Session history"]');
    const showHistory = async () => {
      await history.waitFor({ state: 'attached' });
      if (width < 1280 && !(await history.isVisible())) await page.getByRole('button', { name: 'Open task sessions' }).click();
      await expect(history).toBeVisible();
    };
    await page.goto('/');
    await nav('Task session');
    await showHistory();
    await expect(history.locator('[data-session-history-id]')).toHaveCount(3);
    await history.getByRole('button', { name: '会话操作：Running fixture', exact: true }).click();
    await expect(history.getByRole('button', { name: '删除会话', exact: true })).toBeDisabled();
    await expect(history.getByRole('button', { name: '归档会话', exact: true })).toBeEnabled();
    await history.getByRole('button', { name: '会话操作：History fixture A', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`history-menu-${width}.png`) });
    await history.getByRole('button', { name: '归档会话', exact: true }).click();
    await showHistory();
    await expect(history.locator('[data-session-history-id]')).toHaveCount(2);
    await page.reload();
    await nav('Task session');
    await showHistory();
    await history.getByRole('button', { name: '归档 · 1', exact: true }).click();
    await expect(history.locator('[data-session-history-id]')).toHaveCount(1);
    await history.getByRole('button', { name: '会话操作：History fixture A', exact: true }).click();
    await history.getByRole('button', { name: '恢复会话', exact: true }).click();
    await history.getByRole('button', { name: '会话', exact: true }).click();
    await expect(history.locator('[data-session-history-id]')).toHaveCount(3);
    await history.getByRole('button', { name: '管理', exact: true }).click();
    await expect(history.getByRole('checkbox', { name: '选择会话：Running fixture' })).toBeEnabled();
    await history.getByRole('checkbox', { name: '全选可管理会话' }).check();
    await expect(history.getByRole('button', { name: '批量删除会话' })).toBeDisabled();
    await history.getByRole('checkbox', { name: '选择会话：Running fixture' }).uncheck();
    await history.getByRole('button', { name: '批量删除会话' }).click();
    const confirm = page.getByRole('dialog', { name: '删除 2 个会话？' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('磁盘文件仍保留');
    const prior = mutations.length;
    await page.screenshot({ path: testInfo.outputPath(`delete-confirm-${width}.png`), animations: 'disabled' });
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    expect(mutations).toHaveLength(prior);
    await history.getByRole('button', { name: '批量删除会话' }).click();
    await confirm.getByRole('button', { name: '确认删除', exact: true }).click();
    await showHistory();
    await expect(history.locator('[data-session-history-id]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`history-managed-${width}.png`) });
    await nav('Home');
    await expect(page.getByRole('region', { name: 'Recent conversations' }).locator('[data-home-conversation]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-home-workspace]')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recent conversations' }).locator('[data-home-conversation]')).toHaveCount(0);
    expect(mutations.filter(item => item.action === 'delete')).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test(`paused workflows show their real status and require explicit stop at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('myrmecia.theme', 'light'));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const workflowTask = { ...base, id: 'paused-history-task', title: 'Completed research', pipelineId: 'paused-history-workflow', output: 'Completed research. Publishing is not approved.' };
    const retryTask = { ...base, id: 'retry-history-task', title: 'Failed research', pipelineId: 'retry-history-workflow', status: 'failed' };
    const fixturePipelines = [
      { id: workflowTask.pipelineId, name: 'Awaiting publish approval', status: 'paused', gateMode: 'manual', input: 'Fixture', currentStageIndex: 1,
        createdAt: base.createdAt, stages: [
          { index: 0, name: 'Research', status: 'done', taskId: workflowTask.id, agentRole: 'researcher' },
          { index: 1, name: 'Publish', status: 'pending', agentRole: 'researcher' },
        ] },
      { id: retryTask.pipelineId, name: 'Retry research workflow', status: 'awaiting_retry', gateMode: 'auto', input: 'Fixture', currentStageIndex: 0,
        createdAt: base.createdAt, stages: [{ index: 0, name: 'Research', status: 'rolled_back', taskId: retryTask.id, agentRole: 'researcher' }] },
    ];
    await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.fulfill({ json: [workflowTask, retryTask] }));
    await page.route(/\/api\/v1\/pipelines(?:\?.*)?$/, route => route.fulfill({ json: fixturePipelines }));
    await page.route(/\/api\/v1\/executions(?:\?.*)?$/, route => route.fulfill({ json: [] }));
    let states: Array<{ id: string; status: 'archived' | 'deleted'; updatedAt: string }> = [];
    const mutations: Array<{ taskIds: string[]; action: string; confirm: boolean; stopWorkflow: boolean }> = [];
    await page.route('**/api/v1/conversations**', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: states });
      const body = route.request().postDataJSON() as typeof mutations[number];
      expect(body.taskIds).toEqual([workflowTask.id]);
      if (body.action === 'delete') {
        expect(body.confirm).toBe(true);
        expect(body.stopWorkflow).toBe(true);
      } else {
        expect(body.stopWorkflow).toBe(false);
      }
      mutations.push(body);
      const id = `pipeline:${workflowTask.pipelineId}`;
      states = states.filter(item => item.id !== id);
      if (body.action !== 'restore') states.push({ id, status: body.action === 'delete' ? 'deleted' : 'archived', updatedAt: new Date().toISOString() });
      return route.fulfill({ json: { states, affectedConversationIds: [id] } });
    });
    const history = page.locator('[aria-label="Session history"]');
    const showHistory = async () => {
      await history.waitFor({ state: 'attached' });
      if (width < 1280 && !(await history.isVisible())) await page.getByRole('button', { name: 'Open task sessions' }).click();
      await expect(history).toBeVisible();
    };
    await page.goto('/');
    const nav = page.getByRole('button', { name: 'Task session', exact: true });
    if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open navigation' }).click();
    await nav.click();
    await showHistory();
    await expect(history).toContainText('流程已暂停');
    await expect(history).toContainText('等待重试');
    await expect(history).not.toContainText('Completed ·');
    await history.getByRole('button', { name: /Awaiting publish approval.*流程已暂停/ }).click();
    await expect(page.locator('[aria-label="Conversation header"]')).toContainText('流程已暂停');
    await expect(page.locator('[aria-label="Conversation header"]')).not.toContainText('Completed');
    await showHistory();
    const menu = () => history.getByRole('button', { name: '会话操作：Awaiting publish approval', exact: true });
    await menu().click();
    await history.getByRole('button', { name: '归档会话', exact: true }).click();
    await showHistory();
    expect(fixturePipelines[0].status).toBe('paused');
    await history.getByRole('button', { name: '归档 · 1', exact: true }).click();
    await menu().click();
    await history.getByRole('button', { name: '恢复会话', exact: true }).click();
    await history.getByRole('button', { name: '会话', exact: true }).click();
    await menu().click();
    await history.getByRole('button', { name: '删除会话', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除 1 个会话？' });
    await expect(dialog).toContainText('不会发布内容');
    await expect(dialog.getByRole('button', { name: '确认删除', exact: true })).toHaveCount(0);
    const before = mutations.length;
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(mutations).toHaveLength(before);
    await history.getByRole('button', { name: '删除会话', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`history-workflow-stop-${width}.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: '结束流程并删除', exact: true }).click();
    await showHistory();
    await expect(history.locator(`[data-session-history-id="pipeline:${workflowTask.pipelineId}"]`)).toHaveCount(0);
    await expect(history).toContainText('等待重试');
    expect(errors).toEqual([]);
  });
}
