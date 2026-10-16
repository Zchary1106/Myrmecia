import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { closeDb } from '../src/db/database.js';
import { createGitHubFixRoutes } from '../src/routes/github-fixes.js';
import type { GitHubFixService } from '../src/github/github-fix-service.js';
let server: Server, url: string;
const hash = 'a'.repeat(64);
const fix = { id: 'fix', workspaceId: 'w', status: 'ready' };
const service = { get: vi.fn(() => fix), diff: vi.fn(), verify: vi.fn(), createPullRequest: vi.fn(),
  cancelVerification: vi.fn(), reconcile: vi.fn() };
beforeEach(async () => {
  vi.stubEnv('DB_PATH', ':memory:');
  vi.clearAllMocks();
  service.diff.mockResolvedValue({ diffHash: hash });
  service.verify.mockResolvedValue({ validation: { status: 'passed' } });
  service.createPullRequest.mockResolvedValue(fix);
  service.cancelVerification.mockReturnValue({ requested: true });
  service.reconcile.mockResolvedValue({ publicationState: 'pushed' });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).tenantContext = { userId: 'test-operator', orgId: 'org',
    workspaceId: req.header('x-fixture-workspace') || 'w', role: req.header('x-fixture-role') || 'operator' }; next(); });
  app.use('/fixes', createGitHubFixRoutes(service as unknown as GitHubFixService));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}/fixes/fix`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeDb(); vi.unstubAllEnvs();
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
describe('GitHub reviewed delivery HTTP authority', () => {
  it('requires explicit confirmation and a complete review payload before publication', async () => {
    expect((await post('/pull-request', {})).status).toBe(409);
    expect((await post('/pull-request', { confirm: true })).status).toBe(400);
    expect(service.createPullRequest).not.toHaveBeenCalled();
    expect((await post('/pull-request', { confirm: true, acceptDelivery: true, diffHash: hash, files: ['new.py'] })).status).toBe(200);
    expect(service.createPullRequest).toHaveBeenCalledWith('fix', expect.objectContaining({ acceptDelivery: true, files: ['new.py'] }), 'test-operator');
  });
  it('does not let a viewer execute tests, publish, stop or reconcile operations', async () => {
    for (const path of ['/verify', '/pull-request', '/verification/cancel', '/reconcile']) {
      expect((await post(path, { confirm: true }, { 'x-fixture-role': 'viewer' })).status).toBe(403);
    }
    expect(service.verify).not.toHaveBeenCalled(); expect(service.createPullRequest).not.toHaveBeenCalled();
  });
  it('denies another workspace before invoking the verifier', async () => {
    const result = await post('/verify', { confirm: true, diffHash: hash, files: ['new.py'], command: 'npm test' },
      { 'x-fixture-workspace': 'other' });
    expect(result.status).toBe(404); expect(service.verify).not.toHaveBeenCalled();
  });
  it('rejects arbitrary shell source before dispatch and returns stale review conflicts as 409', async () => {
    expect((await post('/verify', { confirm: true, diffHash: hash, files: ['new.py'], command: 'npm test; npm publish' })).status).toBe(400);
    expect(service.verify).not.toHaveBeenCalled();
    service.verify.mockRejectedValueOnce(new Error('GITHUB_REVIEW_STALE: refresh the preview'));
    const result = await post('/verify', { confirm: true, diffHash: hash, files: ['new.py'], command: 'go test ./...' });
    expect(result.status).toBe(409); expect((await result.json()).error.code).toBe('GITHUB_REVIEW_STALE');
  });
  it('requires fresh operation identity and stopped-effect attestation for reconciliation', async () => {
    const input = { confirm: true, operationId: 'f919632e-fbfb-4f78-a21f-a7a4e6a9be69', expectedState: 'uncertain' };
    expect((await post('/reconcile', input)).status).toBe(400);
    expect(service.reconcile).not.toHaveBeenCalled();
    expect((await post('/reconcile', { ...input, effectsStopped: true })).status).toBe(200);
  });
});
