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

test('a task opens its conversation instead of the technical timeline', async ({ page }) => {
  const task = {
    id: 'e2e-home-task',
    title: 'Review the workspace',
    description: 'Review the workspace',
    mode: 'master',
    status: 'queued',
    priority: 'normal',
    createdBy: 'user',
    input: 'Review the workspace',
    retryCount: 0,
    maxRetries: 1,
    dependsOn: [],
    createdAt: '2026-09-06T00:00:00.000Z',
  };
  await page.route('**/api/v1/tasks', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([task]),
  }));
  await page.route('**/api/v1/supervisor/dispatch', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      orchestrationId: 'e2e-orchestration',
      mode: 'direct',
      intent: {},
      orchestration: {},
      tasks: [task],
    }),
  }));
  await page.goto('/');

  await page.getByLabel('Describe work for your Agent Team').fill('Review the workspace');
  await page.getByRole('button', { name: 'Send to Master Agent' }).click();

  await expect(page.getByRole('heading', { name: 'Your conversation with the team' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Task conversation' }).getByText('Review the workspace', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Task conversation' }).getByText('Master Agent', { exact: true })).toBeVisible();
  await expect(page.getByText('See what you asked, who owns the next step, and the real output as work completes.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Execution Timeline' })).toBeHidden();
});

test('task session makes the conversation primary and keeps the timeline technical', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Task session', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your conversation with the team' })
      .or(page.getByRole('heading', { name: 'No task conversation yet' })),
  ).toBeVisible();
  const timelineLink = page.getByRole('button', { name: 'Open technical timeline' });
  if (await timelineLink.isVisible()) {
    await timelineLink.click();
    await expect(page.getByText('Technical details for task runs, tools, traces, and runtime events.')).toBeVisible();
    await page.getByRole('button', { name: 'Back to task conversation' }).click();
    await expect(page.getByRole('heading', { name: 'Your conversation with the team' })).toBeVisible();
  }
});

test('task session renders structured review output as a readable result', async ({ page }) => {
  await page.route('**/api/v1/tasks', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: 'e2e-review-task',
      title: 'Review: profile upload',
      description: 'Review the profile upload work',
      mode: 'direct',
      status: 'done',
      priority: 'normal',
      assigneeId: 'review',
      createdBy: 'user',
      input: 'Review the profile upload work',
      output: JSON.stringify({
        approved: false,
        summary: 'The implementation needs stronger upload validation before approval.',
        findings: [{
          severity: 'high',
          file: 'src/profile/upload.ts',
          line: 42,
          evidence: 'The MIME type is accepted without an allowlist.',
          requiredFix: 'Add an image MIME allowlist before persisting uploads.',
        }],
      }),
      retryCount: 0,
      maxRetries: 1,
      dependsOn: [],
      createdAt: '2026-09-06T00:00:00.000Z',
      completedAt: '2026-09-06T00:02:00.000Z',
    }]),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Task session', exact: true }).click();

  await expect(page.getByText('Changes requested', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('The implementation needs stronger upload validation before approval.')).toBeVisible();
  await expect(page.getByText('src/profile/upload.ts:42')).toBeVisible();
  await expect(page.getByText(/Add an image MIME allowlist before persisting uploads/)).toBeVisible();
  await expect(page.getByText(/"approved":false/)).toHaveCount(0);
});

test('task session sends a follow-up to the live Agent mailbox', async ({ page }) => {
  const task = {
    id: 'e2e-running-task',
    title: 'Implement profile upload',
    description: 'Implement profile upload',
    mode: 'direct',
    status: 'running',
    priority: 'normal',
    assigneeId: 'dev',
    createdBy: 'user',
    input: 'Implement profile upload',
    retryCount: 0,
    maxRetries: 1,
    dependsOn: [],
    createdAt: '2026-09-06T00:00:00.000Z',
    startedAt: '2026-09-06T00:01:00.000Z',
  };
  const execution = {
    id: 'e2e-running-execution',
    taskId: task.id,
    agentDefId: 'dev',
    status: 'running',
    progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [] },
    costUSD: null,
    tokenCount: 0,
    startedAt: '2026-09-06T00:01:00.000Z',
  };
  let followUpSent = false;

  await page.route('**/api/v1/tasks', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([task]) }));
  await page.route('**/api/v1/executions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([execution]) }));
  await page.route('**/api/v1/executions/e2e-running-execution/messages**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(followUpSent ? [{
      id: 2,
      executionId: execution.id,
      type: 'user_follow_up',
      content: 'Please validate image MIME types too.',
      createdAt: '2026-09-06T00:02:00.000Z',
    }] : []),
  }));
  await page.route('**/api/v1/executions/e2e-running-execution/message', route => {
    followUpSent = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1, toExecution: execution.id, messageType: 'text' }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Task session', exact: true }).click();
  await page.getByRole('textbox', { name: 'Follow-up instruction' }).fill('Please validate image MIME types too.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(page.getByText('You · follow-up')).toBeVisible();
  await expect(page.getByText('Please validate image MIME types too.')).toBeVisible();
  await expect(page.getByText('The current Agent receives this at its next model turn.')).toBeVisible();
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
  await expect(
    page.getByText('No artifacts yet').or(page.getByRole('button', { name: 'Download' })),
  ).toBeVisible();
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

test('Agents exposes the governed external Agent control plane', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'External Agents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'External Agents', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Agent' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Connected Agents/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Schedules/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Run History/ })).toBeVisible();
});

test('external Agent schedules can be configured from supported automation triggers', async ({ page }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const agentName = `E2E HTTP Agent ${suffix}`;
  const updatedAgentName = `E2E updated Agent ${suffix}`;
  const objective = `Escalate failed task ${suffix}`;
  const createAgent = await page.request.post('/api/v1/external-agents', {
    data: {
      name: agentName,
      adapter: {
        kind: 'http',
        endpoint: 'https://agents.example.test/run',
        allowedHosts: ['agents.example.test'],
      },
    },
  });
  expect(createAgent.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'External Agents', exact: true }).click();
  await page.getByRole('button', { name: `Edit ${agentName}` }).click();
  await page.getByRole('dialog', { name: 'Edit external Agent' }).getByLabel('Name').fill(updatedAgentName);
  await page.getByRole('button', { name: 'Save Agent' }).click();
  await expect(page.getByText(`${updatedAgentName} updated.`)).toBeVisible();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByLabel('Schedule trigger').selectOption('task_event');
  await expect(page.getByLabel('Task event type')).toBeVisible();
  await page.getByLabel('Task event type').selectOption('task:failed');
  await page.getByRole('dialog', { name: 'Schedule external Agent' }).getByLabel('Objective').fill(objective);
  await page.getByRole('button', { name: 'Create task event automation' }).click();
  await expect(page.getByText('Task event automation created.')).toBeVisible();
  await page.getByRole('button', { name: /^Schedules/ }).click();
  await expect(page.getByText(objective, { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: `Delete automation ${objective}` }).click();
  await expect(page.getByText('Automation deleted.')).toBeVisible();
  await expect(page.getByText(objective, { exact: true })).toBeHidden();
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
