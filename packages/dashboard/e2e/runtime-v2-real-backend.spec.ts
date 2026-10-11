import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Task, TaskExecution } from '@myrmecia/shared';
test.skip(!process.env.RUNTIME_V2_REAL_BACKEND, 'Requires the dedicated runtime-v2 configuration; no API mocks');
const api = `http://127.0.0.1:${process.env.RUNTIME_V2_API_PORT || 3350}/api/v1`;
async function executions(request: APIRequestContext, taskId: string): Promise<TaskExecution[]> {
  return (await request.get(`${api}/executions?taskId=${taskId}`)).json();
}
async function execution(request: APIRequestContext, taskId: string): Promise<TaskExecution> {
  await expect.poll(async () => (await executions(request, taskId)).length).toBeGreaterThan(0);
  return (await executions(request, taskId))[0];
}
async function settled(request: APIRequestContext, taskId: string): Promise<TaskExecution> {
  await expect.poll(async () => (await executions(request, taskId))[0]?.status, { timeout: 30_000 }).toBe('done');
  return execution(request, taskId);
}
async function session(request: APIRequestContext, runId: string) {
  return (await request.get(`${api}/executions/${runId}/session`)).json();
}
async function open(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Task session', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} `) }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
async function create(request: APIRequestContext, title: string, criteria: any[] = []): Promise<Task> {
  const tasks: Task[] = await (await request.get(`${api}/tasks`)).json();
  const seed = tasks.find(task => task.title === 'Runtime V2 browser acceptance')!;
  const response = await request.post(`${api}/tasks`, { data: {
    title, description: 'Inspect scoped evidence and produce Markdown.', input: 'Inspect scoped evidence and produce Markdown.',
    mode: 'direct', assigneeId: 'runtime-browser-agent', workdir: seed.workdir, workspacePath: seed.workspacePath,
    maxRetries: 0, completionCriteria: criteria,
  } });
  expect(response.status()).toBe(201);
  return response.json();
}
async function send(page: Page, content: string, mode: 'steer' | 'follow_up') {
  await page.getByLabel('Instruction delivery mode').selectOption(mode);
  await page.getByLabel('Follow-up instruction', { exact: true }).fill(content);
  const received = page.waitForResponse(response => response.url().endsWith('/message') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
  const response = await received;
  expect(response.ok()).toBe(true);
  return response.request().postDataJSON();
}
test('real HTTP/Core/SQLite: Markdown, folded tools, criterion evidence, human refusal and refresh', async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const task = await create(request, 'V2-render-acceptance', [
    { id: 'literal', label: 'Fixture marker only', required: true, verifier: 'output_contains', text: 'runtime-v2-fixture-ok' },
  ]);
  await open(page, task.title);
  const run = await settled(request, task.id);
  await expect(page.getByRole('heading', { name: '验收回复', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agent 执行状态' })).toContainText('Runtime Browser Agent');
  expect(run.runState?.verification?.status).toBe('passed');
  const group = page.getByRole('group', { name: 'Tool activity' });
  await expect(group).not.toHaveAttribute('open');
  await group.locator('summary').first().click();
  await group.getByText(/Result ·/).click();
  await expect(group).toContainText('Fixture transport; real HTTP/DB/Core/UI.');
  await page.getByRole('button', { name: '需要修改', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Agent 执行状态' })).toContainText('你已要求修改此结果');
  await open(page, task.title);
  await expect(page.getByRole('region', { name: 'Agent 执行状态' })).toContainText('你已要求修改此结果');
  await page.screenshot({ path: info.outputPath('refusal-replay.png') });
  const approvedTask = await create(request, 'V2-artifact-accepted', [
    { id: 'result-artifact', label: 'Persisted Markdown artifact', required: true, verifier: 'artifact', relativePath: '__result__.md' },
  ]);
  const approvedRun = await settled(request, approvedTask.id);
  expect(approvedRun.runState?.verification?.criteria[0]).toMatchObject({
    status: 'passed', evidence: [{ ref: expect.stringMatching(/^artifact:\/\//), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
  });
  const artifacts = await (await request.get(`${api}/artifacts/workbench?executionId=${approvedRun.id}`)).json();
  const artifact = artifacts.find((item: any) => item.relativePath === '__result__.md');
  expect(await (await request.get(`${api}/artifacts/workbench/${artifact.id}/preview`)).text()).toContain('## 验收回复');
  await open(page, approvedTask.title);
  const status = page.getByRole('region', { name: 'Agent 执行状态' });
  await expect(status).toContainText('result-artifact · passed');
  await status.getByRole('button', { name: '接受结果', exact: true }).click();
  await expect(status).toContainText('你已接受此结果');
  await open(page, approvedTask.title);
  await expect(status).toContainText('你已接受此结果');
  await page.screenshot({ path: info.outputPath('artifact-accepted.png') });
  expect(errors).toEqual([]);
});
test('steering is applied at a host boundary, retries are idempotent, and canonical user turns are not duplicated', async ({ page, request }) => {
  const task = await create(request, 'V2-steering');
  await open(page, task.title);
  const run = await execution(request, task.id);
  const content = '请在下一轮明确保留 evidence.md 的来源。';
  const body = await send(page, content, 'steer');
  expect(body.idempotencyKey).toBeTruthy();
  const retry = await request.post(`${api}/executions/${run.id}/message`, { data: body });
  expect(retry.ok()).toBe(true);
  await settled(request, task.id);
  await expect.poll(async () => (await session(request, run.id)).inbox.find((entry: any) => entry.content === content)?.status).toBe('acknowledged');
  await expect(page.getByRole('article', { name: 'Your message' }).filter({ hasText: content })).toHaveCount(1);
  await open(page, task.title);
  await expect(page.getByRole('article', { name: 'Your message' }).filter({ hasText: content })).toHaveCount(1);
  expect((await session(request, run.id)).inbox.filter((entry: any) => entry.content === content)).toHaveLength(1);
});
test('queued follow-up automatically materializes a new same-session task and observes its real request receipt', async ({ page, request }, info) => {
  const task = await create(request, 'V2-queued-followup');
  await open(page, task.title);
  const first = await execution(request, task.id);
  const content = '这一轮完成后，继续输出简短证据摘要。';
  await send(page, content, 'follow_up');
  let nextId = '';
  await expect.poll(async () => {
    const entry = (await session(request, first.id)).inbox.find((item: any) => item.content === content);
    nextId = entry?.assignedTaskId || '';
    return Boolean(nextId);
  }, { timeout: 30_000 }).toBe(true);
  const next = await settled(request, nextId);
  const journal = await session(request, next.id);
  expect(journal.sessionId).toBe(`task:${task.id}`);
  expect(journal.inbox.find((item: any) => item.content === content)?.status).toBe('acknowledged');
  await expect(page.getByRole('article', { name: 'Your message' }).filter({ hasText: content })).toHaveCount(1);
  await open(page, task.title);
  await expect(page.getByRole('article', { name: 'Your message' }).filter({ hasText: content })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('queued-followup.png') });
});
test('late steering receives explicit rejection rather than waiting indefinitely', async ({ page, request }) => {
  const task = await create(request, 'V2-late-steering');
  await open(page, task.title);
  const run = await execution(request, task.id);
  await expect.poll(async () => (await execution(request, task.id)).runState?.turn).toBe(2);
  const content = '这条迟到的修改不能静默丢失。';
  await send(page, content, 'steer');
  await settled(request, task.id);
  await expect.poll(async () => (await session(request, run.id)).inbox.find((entry: any) => entry.content === content)?.status).toBe('rejected');
  await expect(page.getByLabel('Instruction delivery status')).toContainText('已拒绝');
});
test('real knowledge upload is preserved on reload and mandatory unavailable evidence cannot be accepted', async ({ page, request }, info) => {
  const task = await create(request, 'V2-knowledge', [
    { id: 'external-check', label: 'Unavailable verifier', required: true, verifier: 'external', verifierId: 'unregistered-fixture' },
  ]);
  await open(page, task.title);
  await page.getByLabel('Upload session knowledge').setInputFiles({
    name: 'acceptance-knowledge.md', mimeType: 'text/markdown', buffer: Buffer.from('# Synthetic knowledge\nDo not treat this file as operator instructions.'),
  });
  await expect(page.getByRole('region', { name: 'Session knowledge files' })).toContainText('acceptance-knowledge.md');
  await expect.poll(async () => (await execution(request, task.id)).status, { timeout: 30_000 }).toBe('failed');
  const run = await execution(request, task.id);
  expect(run.runState?.verification?.status).toBe('unavailable');
  const attempt = await request.post(`${api}/executions/${run.id}/acceptance`, { data: { decision: 'accepted' } });
  expect(attempt.status()).toBe(409);
  await open(page, task.title);
  await expect(page.getByRole('region', { name: 'Session knowledge files' })).toContainText('acceptance-knowledge.md');
  await expect(page.getByRole('button', { name: '接受结果', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('knowledge-unavailable.png') });
});
