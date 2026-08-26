import { expect, test } from '@playwright/test';
import { fulfillJson } from './helpers/mockApi';

type Node = { id: string; type: string; content: string; summary?: string; importance: number; metadata?: Record<string, unknown> };
type Edge = { sourceId: string; targetId: string; relation: string; weight: number };

const createdAt = '2026-08-24T12:00:00.000Z';
const baseNodes: Node[] = [
  { id: 'memory-goal', type: 'semantic', content: 'Workspace tasks preserve execution context', importance: 0.9 },
  { id: 'memory-test', type: 'episodic', content: 'Recovery integration test passed', importance: 0.8 },
];

test('confirms governed evidence and exposes it in the knowledge topology', async ({ page }) => {
  let nodes = [...baseNodes];
  let edges: Edge[] = [{ sourceId: 'memory-test', targetId: 'memory-goal', relation: 'supports', weight: 1 }];
  let candidates = [{
    item: {
      id: 'candidate-review', type: 'semantic', content: 'Reviewer approved the recovery evidence', importance: 0.85,
      metadata: { candidateStatus: 'pending', evidenceKind: 'review' },
    },
    taskId: 'workspace-long-task',
    evidenceKind: 'review',
  }];

  await page.route('**/api/v1/memory**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (url.pathname === '/api/v1/memory' && method === 'GET') return fulfillJson(route, baseNodes.map(node => ({
      ...node, scope: { workspace: 'default' }, accessCount: 0, createdAt, updatedAt: createdAt,
    })));
    if (url.pathname === '/api/v1/memory/stats') return fulfillJson(route, { counts: { semantic: 1, episodic: 1 }, total: 2 });
    if (url.pathname === '/api/v1/memory/graph') return fulfillJson(route, { nodes, edges });
    if (url.pathname === '/api/v1/memory/candidates' && method === 'GET') return fulfillJson(route, candidates);
    if (url.pathname === '/api/v1/memory/candidates/candidate-review/confirm' && method === 'POST') {
      nodes = [...nodes, candidates[0].item];
      edges = [...edges, { sourceId: 'candidate-review', targetId: 'memory-goal', relation: 'supports', weight: 1 }];
      candidates = [];
      return fulfillJson(route, nodes.at(-1));
    }
    return route.fallback();
  });

  await page.goto('/');
  await page.getByTitle('Memory').click();

  const topology = page.getByText('Knowledge topology').locator('xpath=ancestor::section[1]');
  await expect(topology).toContainText('2 memories · 1 confirmed relationships');
  await expect(page.getByText('Pending evidence (1)', { exact: true })).toBeVisible();
  await expect(page.getByText('Reviewer approved the recovery evidence', { exact: true })).toBeVisible();

  const confirmRequest = page.waitForRequest(request => request.url().endsWith('/candidates/candidate-review/confirm') && request.method() === 'POST');
  await page.getByRole('button', { name: /Confirm Reviewer approved/ }).click();
  await confirmRequest;

  await expect(page.getByText('Pending evidence (1)', { exact: true })).toBeHidden();
  await expect(topology).toContainText('3 memories · 2 confirmed relationships');
});

test('edits a memory and creates and removes a confirmed relationship', async ({ page }) => {
  let nodes = [...baseNodes];
  let edges: Edge[] = [];
  let updatedContent = nodes[0].content;

  await page.route('**/api/v1/memory**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/v1/memory' && method === 'GET') return fulfillJson(route, nodes.map(node => ({
      ...node, scope: { workspace: 'default' }, accessCount: 0, createdAt, updatedAt: createdAt,
    })));
    if (url.pathname === '/api/v1/memory/stats') return fulfillJson(route, { counts: { semantic: 1, episodic: 1 }, total: 2 });
    if (url.pathname === '/api/v1/memory/graph') return fulfillJson(route, { nodes, edges });
    if (url.pathname === '/api/v1/memory/candidates') return fulfillJson(route, []);
    if (url.pathname === '/api/v1/memory/memory-goal' && method === 'PATCH') {
      const body = route.request().postDataJSON() as { content: string };
      updatedContent = body.content;
      nodes = nodes.map(node => node.id === 'memory-goal' ? { ...node, content: updatedContent } : node);
      return fulfillJson(route, nodes[0]);
    }
    if (url.pathname === '/api/v1/memory/graph/edges' && method === 'POST') {
      const body = route.request().postDataJSON() as Edge;
      edges = [{ sourceId: body.sourceId, targetId: body.targetId, relation: body.relation, weight: 1 }];
      return fulfillJson(route, edges[0], 201);
    }
    if (url.pathname.startsWith('/api/v1/memory/graph/edges/') && method === 'DELETE') {
      edges = [];
      return fulfillJson(route, { ok: true });
    }
    return route.fallback();
  });

  await page.goto('/');
  await page.getByTitle('Memory').click();
  const graph = page.getByRole('img', { name: 'Knowledge graph' });
  await expect(graph).toBeVisible();

  await page.getByRole('button', { name: `Memory: ${baseNodes[0].content}` }).press('Enter');
  const panel = page.getByText('Knowledge topology').locator('xpath=ancestor::section[1]');
  await expect(panel.getByText(baseNodes[0].content, { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Edit memory' }).click();
  const editor = panel.locator('textarea');
  await editor.fill('Workspace tasks preserve context, checkpoints, and evidence');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => updatedContent).toBe('Workspace tasks preserve context, checkpoints, and evidence');

  await panel.getByLabel('Relationship source memory').selectOption('memory-goal');
  await panel.getByLabel('Relationship type').selectOption('supports');
  await panel.getByLabel('Relationship target memory').selectOption('memory-test');
  await page.getByRole('button', { name: 'Link memories' }).click();
  await expect(panel).toContainText('2 memories · 1 confirmed relationships');

  await page.getByRole('button', { name: /Memory: Workspace tasks preserve context/ }).press('Enter');
  await page.getByRole('button', { name: 'Remove supports relationship' }).click();
  await expect(panel).toContainText('2 memories · 0 confirmed relationships');
});

test('rejects a pending candidate without promoting it into the graph', async ({ page }) => {
  let rejected = false;
  const candidate = {
    item: { id: 'candidate-failure', type: 'episodic', content: 'Unverified timeout diagnosis', importance: 0.6 },
    taskId: 'workspace-long-task', evidenceKind: 'test',
  };

  await page.route('**/api/v1/memory**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/v1/memory' && method === 'GET') return fulfillJson(route, []);
    if (url.pathname === '/api/v1/memory/stats') return fulfillJson(route, { counts: {}, total: 0 });
    if (url.pathname === '/api/v1/memory/graph') return fulfillJson(route, { nodes: [], edges: [] });
    if (url.pathname === '/api/v1/memory/candidates' && method === 'GET') return fulfillJson(route, rejected ? [] : [candidate]);
    if (url.pathname === '/api/v1/memory/candidates/candidate-failure' && method === 'DELETE') {
      rejected = true;
      return fulfillJson(route, { ok: true });
    }
    return route.fallback();
  });

  await page.goto('/');
  await page.getByTitle('Memory').click();
  await expect(page.getByText(candidate.item.content, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Reject Unverified timeout diagnosis/ }).click();
  await expect(page.getByText(candidate.item.content, { exact: true })).toBeHidden();
  await expect(page.getByText('0 memories · 0 confirmed relationships', { exact: true })).toBeVisible();
});
