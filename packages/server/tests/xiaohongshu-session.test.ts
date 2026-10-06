import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { XiaohongshuSession, xiaohongshuSession } from '../src/tools/xiaohongshu-session.js';
import type { McpCallResult } from '../src/tools/mcp-client.js';
import { createMcpRoutes } from '../src/routes/mcp.js';

const loggedIn = { content: [{ type: 'text', text: '✅ 已登录' }] };
const loggedOut = { content: [{ type: 'text', text: '❌ 未登录' }] };
const success = { status: 'done' as const, output: 'Evidence' };
afterEach(() => vi.restoreAllMocks());

describe('Xiaohongshu authentication ordering', () => {
  it('waits for an in-flight login probe and never searches when logged out', async () => {
    let finish!: (value: McpCallResult) => void;
    const call = vi.fn(() => new Promise<McpCallResult>(resolve => { finish = resolve; }));
    const session = new XiaohongshuSession(call);
    const read = vi.fn().mockResolvedValue(success);
    const check = session.agentRead('mcp__xiaohongshu__check_login_status', read);
    const search = session.agentRead('mcp__xiaohongshu__search_feeds', read);
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    finish(loggedOut);
    expect((await check).output).toContain('XHS_LOGIN_REQUIRED');
    expect((await search).output).toContain('XHS_LOGIN_REQUIRED');
    expect(call).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('automatically authenticates direct search and serializes parallel reads', async () => {
    const events: string[] = [];
    const session = new XiaohongshuSession(async () => { events.push('login'); return loggedIn; });
    const read = async () => {
      events.push('start');
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push('end');
      return success;
    };
    await Promise.all([session.agentRead('search', read), session.agentRead('detail', read)]);
    expect(events).toEqual(['login', 'start', 'end', 'start', 'end']);
  });

  it('reports queue, authentication, upstream and completion phases with diagnostics', async () => {
    let now = 1000;
    const phases: string[] = [];
    const session = new XiaohongshuSession(async () => { now += 100; return loggedIn; }, () => now);
    const result = await session.agentRead(
      'mcp__xiaohongshu__search_feeds',
      async (_remaining, report) => {
        report('requesting_search', 'searching');
        now += 500;
        report('parsing_response', 'parsing');
        return success;
      },
      undefined,
      event => phases.push(event.phase),
    );
    expect(result.status).toBe('done');
    expect(phases).toEqual(['queued', 'checking_login', 'requesting_search', 'parsing_response', 'completed']);
    expect(result.diagnostics).toMatchObject({ source: 'xiaohongshu', operation: 'search', durationMs: 600 });
  });

  it('reuses a confirmed login for two minutes and labels cached checks', async () => {
    let now = 1000;
    const call = vi.fn(async () => loggedIn);
    const session = new XiaohongshuSession(call, () => now);
    await session.agentRead('search', async () => success);
    now += 119_000;
    const cached = await session.agentRead('search', async () => success);
    expect(call).toHaveBeenCalledTimes(1);
    expect(cached.diagnostics.phases.some(phase => phase.phase === 'login_cached')).toBe(true);
    now += 2_000;
    await session.agentRead('search', async () => success);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not start expired queued work after the preceding read finishes', async () => {
    const session = new XiaohongshuSession(async () => loggedIn);
    let finish!: (value: typeof success) => void;
    const first = session.agentRead('search', () => new Promise(resolve => { finish = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const secondRead = vi.fn().mockResolvedValue(success);
    const second = await session.agentRead('search', secondRead, 5);
    expect(second.output).toContain('XHS_QUEUE_TIMEOUT');
    finish(success);
    await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondRead).not.toHaveBeenCalled();
  });

  it('distinguishes unavailable from logged out and does not run search', async () => {
    const session = new XiaohongshuSession(async () => { throw new Error('internal secret'); });
    const read = vi.fn();
    const result = await session.agentRead('search', read);
    expect(result.output).toContain('XHS_UNAVAILABLE');
    expect(result.output).not.toContain('internal secret');
    expect(read).not.toHaveBeenCalled();
  });

  it('does not invalidate a confirmed login on a read timeout', async () => {
    const call = vi.fn(async () => loggedIn);
    const session = new XiaohongshuSession(call);
    await session.agentRead('search', async () => ({ status: 'failed', output: 'Xiaohongshu read failed or timed out' }));
    await session.agentRead('search', async () => success);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('shows QR only for logged out accounts and recognizes login on refresh', async () => {
    let logged = false;
    const call = vi.fn(async name => name.endsWith('check_login_status') ? logged ? loggedIn : loggedOut
      : { content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] });
    const session = new XiaohongshuSession(call);
    expect(await session.qrCode()).toMatchObject({ authenticated: false, image: 'data:image/png;base64,aGVsbG8=' });
    logged = true;
    expect(await session.status()).toMatchObject({ authenticated: true, state: 'logged_in' });
    expect(await session.qrCode()).toEqual({ authenticated: true });
    expect(call.mock.calls.filter(([name]) => name.endsWith('get_login_qrcode'))).toHaveLength(1);
  });

  it('rejects unsupported QR images instead of passing untrusted URLs to the browser', async () => {
    const session = new XiaohongshuSession(async name => name.endsWith('check_login_status') ? loggedOut
      : { content: [{ type: 'image', mimeType: 'image/svg+xml', data: '<svg/>' }] });
    await expect(session.qrCode()).rejects.toThrow('有效登录二维码');
  });

  it('requires admin for QR generation through both dedicated and generic routes', async () => {
    const qr = vi.spyOn(xiaohongshuSession, 'qrCode').mockResolvedValue({ authenticated: false, image: 'data:image/png;base64,aGVsbG8=' });
    const app = express();
    app.use(express.json());
    app.use('/mcp', createMcpRoutes());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    try {
      const headers = { 'Content-Type': 'application/json', 'x-operator-id': 'tester', 'x-operator-role': 'viewer' };
      expect((await fetch(`${base}/xiaohongshu/login`, { method: 'POST', headers })).status).toBe(403);
      expect((await fetch(`${base}/call`, { method: 'POST', headers, body: '{"name":"mcp__xiaohongshu__get_login_qrcode"}' })).status).toBe(403);
      expect(qr).not.toHaveBeenCalled();
      const result = await fetch(`${base}/xiaohongshu/login`, { method: 'POST', headers: { ...headers, 'x-operator-role': 'admin' } });
      expect(result.status).toBe(200);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(qr).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
