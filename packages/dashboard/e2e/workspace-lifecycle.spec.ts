import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Task, TaskExecution } from '@myrmecia/shared';
test.skip(!process.env.RUNTIME_V2_REAL_BACKEND, 'Dedicated scripted-model/real HTTP SQLite fixture required');
test.use({ viewport: { width: 1440, height: 1000 } });
const api = `http://127.0.0.1:${process.env.RUNTIME_V2_API_PORT || 3350}/api/v1`;
async function source(request: APIRequestContext) {
  const created = await request.post(`${api}/workspaces/local`, { data: { name: 'workspace-browser-source' } });
  expect(created.status()).toBe(201); const session = await created.json();
  const uploaded = await request.put(`${api}/workspaces/local/${session.id}/file`, {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Workspace-File-Path': 'evidence.md' }, data: '# Browser source evidence\nWORKSPACE-SOURCE-UNCHANGED',
  });
  expect(uploaded.status()).toBe(204);
  return (await request.post(`${api}/workspaces/local/${session.id}/complete`)).json();
}
async function create(request: APIRequestContext, sourceId: string, title: string, mode = 'isolated', agent = 'runtime-browser-agent'): Promise<Task> {
  const response = await request.post(`${api}/tasks`, { data: { title, description: title, input: title,
    mode: 'direct', assigneeId: agent, filesystemWorkspaceId: sourceId, workspaceAccessMode: mode } });
  expect(response.status()).toBe(201); return response.json();
}
async function runs(request: APIRequestContext, id: string): Promise<TaskExecution[]> { return (await request.get(`${api}/executions?taskId=${id}`)).json(); }
async function done(request: APIRequestContext, id: string) {
  await expect.poll(async () => (await runs(request, id))[0]?.status, { timeout: 30_000 }).toBe('done');
  return (await runs(request, id))[0];
}
test('source/execution paths, immutable follow-up downloads and archive/restore are real persisted facts', async ({ request, page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const imported = await source(request), first = await create(request, imported.filesystemWorkspaceId, 'Workspace-browser-acceptance');
  const before = await done(request, first.id);
  const facts = await (await request.get(`${api}/managed-workspaces/task/${first.id}`)).json();
  expect(facts.binding.executionPath).not.toBe(imported.path);
  expect(facts.source.canonicalPath).toBe(imported.path); expect(facts.binding.accessMode).toBe('isolated');
  const artifacts = await (await request.get(`${api}/artifacts/workbench?executionId=${before.id}`)).json();
  const summary = artifacts.find((artifact: any) => artifact.relativePath === 'output/summary.md');
  expect(summary.metadata.immutable).toBe(true);
  const original = await (await request.get(`http://127.0.0.1:${process.env.RUNTIME_V2_API_PORT || 3350}${summary.downloadUrl}`)).body();
  const continuation = await request.post(`${api}/tasks/${first.id}/continue`, { data: { content: 'Fresh follow-up WORKSPACE-SECOND-RESULT', idempotencyKey: crypto.randomUUID() } });
  expect(continuation.status()).toBe(201);
  const second = await continuation.json(); await done(request, second.id);
  const later = await (await request.get(`${api}/managed-workspaces/task/${second.id}`)).json();
  expect(later.binding.filesystemWorkspaceId).toBe(facts.binding.filesystemWorkspaceId);
  expect(await (await request.get(`http://127.0.0.1:${process.env.RUNTIME_V2_API_PORT || 3350}${summary.downloadUrl}`)).body()).toEqual(original);
  await page.goto('/');
  await page.getByRole('button', { name: 'Task session', exact: true }).click();
  await page.getByRole('button', { name: /^Workspace-browser-acceptance / }).click();
  await page.getByText('Session details', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Execution workspace' });
  await panel.locator('summary').first().click();
  await expect(panel).toContainText(facts.binding.executionPath);
  await expect(panel).toContainText(imported.path);
  await expect(panel).toContainText('产物 complete');
  const safetyBoundary = panel.getByText('目录分离不等于操作系统沙箱。', { exact: false });
  await safetyBoundary.scrollIntoViewIfNeeded();
  await expect(safetyBoundary).toBeInViewport();
  await page.screenshot({ path: info.outputPath('execution-directory.png'), fullPage: true });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^目录与存储管理$/ }).click();
  const management = page.getByRole('region', { name: 'Workspace management' });
  const entry = management.locator('li').filter({ hasText: facts.binding.executionPath });
  await entry.getByRole('button', { name: '归档（保留文件）', exact: true }).click();
  const dialog = management.getByRole('dialog', { name: 'Confirm workspace operation' });
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
  await expect(entry).toContainText('archived');
  await entry.getByRole('button', { name: '恢复目录', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(entry).toContainText('active');
  const legacy = management.locator('li').filter({ hasText: 'legacy_unmanaged' }).first();
  await legacy.getByRole('button', { name: '登记为源目录（不搬移）', exact: true }).click();
  const adoption = management.getByRole('dialog', { name: 'Confirm workspace maintenance' });
  await expect(adoption).toContainText('不会取得可删除权限');
  await adoption.getByRole('button', { name: '确认登记', exact: true }).click();
  await expect(management.locator('li').filter({ hasText: 'legacy_unmanaged' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('workspace-management.png'), fullPage: true });
  expect(errors).toEqual([]);
});
test('two agents serialize writes to the same canonical directory without a failed execution', async ({ request }) => {
  const imported = await source(request);
  const created = await request.post(`${api}/agents`, { data: { name: 'Workspace second writer', role: 'analyst',
    allowedTools: ['file_read'], config: { model: 'gpt-5.4-mini', maxTurns: 8, allowedTools: ['file_read'] } } });
  expect(created.status()).toBe(201); const agent = await created.json();
  const first = await create(request, imported.filesystemWorkspaceId, 'Workspace-shared-first', 'shared_write');
  await expect.poll(async () => (await runs(request, first.id))[0]?.status).toBe('running');
  const second = await create(request, imported.filesystemWorkspaceId, 'Workspace-shared-second', 'shared_write', agent.id);
  expect((await runs(request, second.id)).length).toBe(0);
  const queued = await (await request.get(`${api}/tasks/${second.id}`)).json(); expect(queued.status).toBe('queued');
  const firstRun = await done(request, first.id), secondRun = await done(request, second.id);
  // Task start/end use millisecond ISO timestamps; legacy SQLite execution
  // defaults only have second precision, so cannot prove a sub-second ordering.
  const firstTask = await (await request.get(`${api}/tasks/${first.id}`)).json();
  const secondTask = await (await request.get(`${api}/tasks/${second.id}`)).json();
  expect(Date.parse(secondTask.startedAt)).toBeGreaterThanOrEqual(Date.parse(firstTask.completedAt));
  expect((await runs(request, second.id)).every(run => run.status !== 'failed')).toBe(true);
});
