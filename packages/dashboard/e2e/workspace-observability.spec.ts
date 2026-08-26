import { expect, test } from '@playwright/test';
import { fulfillJson, mockControllingOperator } from './helpers/mockApi';

const taskId = 'workspace-long-task';
const executionId = 'execution-long-task';
const now = new Date().toISOString();

const task = {
  id: taskId,
  title: 'Implement durable workspace recovery',
  description: 'Exercise a long-running workspace development task.',
  mode: 'master',
  status: 'failed',
  priority: 'high',
  assigneeId: 'dev',
  createdBy: 'user',
  input: 'Implement, test, review, and preserve recovery evidence.',
  workspaceId: 'workspace-e2e',
  workspacePath: '/tmp/myrmecia-e2e',
  workdir: '/tmp/myrmecia-e2e/packages/dashboard',
  modelId: 'copilot/gpt-5',
  reasoningEffort: 'high',
  contextLength: 128000,
  error: 'timed_out while waiting for the integration test tool',
  retryCount: 1,
  maxRetries: 3,
  dependsOn: [],
  createdAt: now,
  startedAt: now,
};

const execution = {
  id: executionId,
  taskId,
  agentDefId: 'dev',
  status: 'failed',
  progress: { phase: 'testing', percent: 72, message: 'Running integration tests' },
  costUSD: null,
  tokenCount: 92000,
  workspaceId: 'workspace-e2e',
  modelId: 'copilot/gpt-5',
  startedAt: now,
  completedAt: now,
};

const logs = [
  { id: 1, taskId, level: 'info', message: 'heartbeat: integration test is still running', source: 'runtime', createdAt: now },
  { id: 2, taskId, level: 'warn', message: 'timed_out waiting for integration test tool; checkpoint saved', source: 'runtime', createdAt: now },
];

const context = {
  id: 'context-long-task',
  taskId,
  workspaceId: 'workspace-e2e',
  workspacePath: '/tmp/myrmecia-e2e',
  workdir: '/tmp/myrmecia-e2e/packages/dashboard',
  provider: 'copilot',
  modelId: 'copilot/gpt-5',
  reasoningEffort: 'high',
  contextLength: 128000,
  goal: 'Implement durable recovery and prove it with integration tests.',
  constraints: ['Keep the original workspace', 'Require tests and review'],
  codeBaseline: { branch: 'codex/recovery', revision: 'abc1234', dirty: false },
  contextUsage: {
    estimatedInputTokens: 87500,
    maxInputTokens: 121000,
    reservedOutputTokens: 7000,
    occupancyPercent: 72,
    summaryVersion: 3,
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

const checkpoints = [
  {
    id: 'checkpoint-testing',
    taskId,
    executionContextId: context.id,
    phase: 'testing',
    completed: ['implementation', 'typecheck'],
    pending: ['integration tests', 'review'],
    blocked: ['integration test tool timed out'],
    lastValidation: { command: 'pnpm test', exitCode: null },
    resumeHint: 'Resume the integration test from the saved workspace.',
    createdAt: now,
  },
  {
    id: 'checkpoint-implementation',
    taskId,
    executionContextId: context.id,
    phase: 'implementation',
    completed: ['workspace scan'],
    pending: ['implementation'],
    blocked: [],
    createdAt: now,
  },
];

test.beforeEach(async ({ page }) => {
  await mockControllingOperator(page);

  await page.route('**/api/v1/tasks**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/v1/tasks' && method === 'GET') return fulfillJson(route, [task]);
    if (url.pathname === `/api/v1/tasks/${taskId}/logs`) return fulfillJson(route, logs);
    if (url.pathname === `/api/v1/tasks/${taskId}/quality-attempts`) return fulfillJson(route, [{
      id: 'quality-attempt-1', taskId, iteration: 1, status: 'needs_fix',
      reviewOutput: 'Integration evidence is incomplete.', error: 'Test command timed out.',
      createdAt: now, updatedAt: now,
    }]);
    if (url.pathname === `/api/v1/tasks/${taskId}/context`) return fulfillJson(route, context);
    if (url.pathname === `/api/v1/tasks/${taskId}/checkpoints`) return fulfillJson(route, checkpoints);
    if (url.pathname === `/api/v1/tasks/${taskId}/resume` && method === 'POST') return fulfillJson(route, { ...task, status: 'queued' });
    if (url.pathname === `/api/v1/tasks/${taskId}/replan` && method === 'POST') return fulfillJson(route, { ...task, id: 'replanned-task', status: 'queued' }, 201);
    return route.fallback();
  });

  await page.route('**/api/v1/executions**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/executions') return fulfillJson(route, [execution]);
    if (url.pathname === `/api/v1/executions/${executionId}/messages`) return fulfillJson(route, []);
    return route.fallback();
  });
  await page.route('**/api/v1/operator-actions**', route => fulfillJson(route, []));
});

test('shows heartbeat, recovery reason, context budget, and checkpoints for a long workspace task', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('Queue').click();
  await page.getByText(task.title, { exact: true }).click();

  const runtime = page.getByRole('region', { name: 'Runtime status' });
  await expect(runtime).toContainText('Needs attention');
  await expect(runtime).toContainText('Latest heartbeat');
  await expect(runtime).toContainText(/just now|1m ago/);
  await expect(runtime).toContainText('testing');
  await expect(runtime).toContainText('timed_out while waiting for the integration test tool');

  await runtime.getByRole('button', { name: 'Context (2)' }).click();
  await expect(page.getByText(context.goal, { exact: true })).toBeVisible();
  await expect(page.getByText('/tmp/myrmecia-e2e', { exact: true })).toBeVisible();
  await expect(page.getByText('copilot/gpt-5', { exact: true })).toBeVisible();
  await expect(page.getByText('72%', { exact: true })).toBeVisible();
  await expect(page.getByText('Summary v3', { exact: true })).toBeVisible();
  await expect(page.getByText('Resume the integration test from the saved workspace.', { exact: true })).toBeVisible();
  await expect(page.getByText('Blocked: integration test tool timed out', { exact: true })).toBeVisible();
});

test('sends explicit resume and replan controls for a recoverable failed task', async ({ page }) => {
  const resumeRequest = page.waitForRequest(request => request.url().endsWith(`/tasks/${taskId}/resume`) && request.method() === 'POST');
  const replanRequest = page.waitForRequest(request => request.url().endsWith(`/tasks/${taskId}/replan`) && request.method() === 'POST');

  await page.goto('/');
  await page.getByTitle('Queue').click();
  await page.getByText(task.title, { exact: true }).click();

  await page.getByRole('button', { name: 'Resume from checkpoint' }).click();
  await resumeRequest;
  await page.getByRole('button', { name: 'Replan' }).click();
  await replanRequest;
});
