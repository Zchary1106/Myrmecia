import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSandboxToolDefinition, executeTool, isSandboxTool } from '../src/skills/tool-sandbox.js';
import { environmentFetch } from '../src/lib/environment-fetch.js';

vi.mock('../src/lib/environment-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/environment-fetch.js')>(),
  environmentFetch: vi.fn(),
}));
const fetchMock = vi.mocked(environmentFetch);
const token = 'browser-service-fixture-not-a-real-token';
const query = (input: Record<string, unknown> = { task: 'Read a public page' }, options = {}) =>
  executeTool('browser.query', input, '/tmp', { allowedTools: ['browser.query'], ...options });
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status }) as unknown as Awaited<ReturnType<typeof environmentFetch>>;

beforeEach(() => {
  vi.stubEnv('BROWSER_QUERY_URL', 'https://browser.example.test/query');
  vi.stubEnv('BROWSER_QUERY_TOKEN', token);
  vi.stubEnv('WEB_TOOLS_ENABLED', 'true');
  vi.stubEnv('SANDBOX_PROFILE', 'standard');
  vi.stubEnv('AGENT_FACTORY_NETWORK_ALLOWED', 'true');
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('TypeScript browser.query', () => {
  it('is registered in the model-visible sandbox with a task schema', () => {
    expect(isSandboxTool('browser.query')).toBe(true);
    expect(buildSandboxToolDefinition('browser.query').function.parameters.required).toContain('task');
  });

  it('preserves the browser-service request and normalizes the output', async () => {
    fetchMock.mockResolvedValue(response({ result: 'Found the answer', steps: 3, internal: 'not exposed' }));
    const result = await query({ task: 'Read a public page', allowed_domains: ' example.test, docs.example.test ', max_steps: 5 });
    expect(result.status).toBe('done');
    expect(JSON.parse(result.output)).toEqual({ result: 'Found the answer', steps: 3 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe('https://browser.example.test/query');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}` } });
    expect(JSON.parse(String(init?.body))).toEqual({
      task: 'Read a public page', max_steps: 5, allowed_domains: ['example.test', 'docs.example.test'],
    });
  });

  it.each(['BROWSER_QUERY_URL', 'BROWSER_QUERY_TOKEN'])('fails locally when %s is missing', async key => {
    vi.stubEnv(key, '');
    expect(await query()).toMatchObject({ status: 'failed', output: expect.stringContaining('Configure BROWSER_QUERY_URL') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { task: '' }, { task: 'x', max_steps: 0 }, { task: 'x', max_steps: 61 },
    { task: 'x', max_steps: '5' }, { task: 'x', allowed_domains: [] },
  ])('rejects malformed input %j before network access', async input => {
    expect((await query(input)).status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['WEB_TOOLS_ENABLED', 'AGENT_FACTORY_NETWORK_ALLOWED'])('honors the %s network gate', async key => {
    vi.stubEnv(key, 'false');
    expect((await query()).status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors tool allowlists', async () => {
    expect((await query(undefined, { allowedTools: [] })).status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors the strict sandbox profile without a network override', async () => {
    vi.stubEnv('SANDBOX_PROFILE', 'strict');
    vi.stubEnv('WEB_TOOLS_ENABLED', '');
    expect((await query()).status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not start a request after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await query(undefined, { signal: controller.signal })).toMatchObject({ status: 'failed', output: 'Request aborted' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing service URLs', async () => {
    vi.stubEnv('BROWSER_QUERY_URL', 'https://secret:password@browser.example.test/query');
    const result = await query();
    expect(result).toMatchObject({ status: 'failed', output: expect.stringContaining('must not contain credentials') });
    expect(result.output).not.toContain('password');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose authentication or remote error bodies on HTTP failures', async () => {
    fetchMock.mockResolvedValue(response({ error: token }, 503));
    const result = await query();
    expect(result).toMatchObject({ status: 'failed', output: 'Browser service returned HTTP 503' });
    expect(result.output).not.toContain(token);
  });

  it.each([[], {}, { error: token }, { result: 'partial', error: token }])('rejects invalid service payload %j', async body => {
    fetchMock.mockResolvedValue(response(body));
    const result = await query();
    expect(result.status).toBe('failed');
    expect(result.output).not.toContain(token);
  });

  it('rejects malformed JSON', async () => {
    fetchMock.mockResolvedValue(new Response('{invalid') as unknown as Awaited<ReturnType<typeof environmentFetch>>);
    expect(await query()).toMatchObject({ status: 'failed', output: 'Browser service returned malformed JSON' });
  });

  it('bounds response bytes and redacts/caps successful output', async () => {
    fetchMock.mockResolvedValue(response({ result: 'x'.repeat(512001) }));
    expect(await query()).toMatchObject({ status: 'failed', output: expect.stringContaining('exceeded 512000 bytes') });
    fetchMock.mockResolvedValue(response({ result: `${token} ${'x'.repeat(200)}` }));
    const result = await query(undefined, { maxOutputChars: 80 });
    expect(result.status).toBe('done');
    expect(result.output.length).toBeLessThanOrEqual(80);
    expect(result.output).not.toContain(token);
  });

  it('bounds timeouts and propagates caller cancellation', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = query(undefined, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ status: 'failed', output: 'Browser query timed out' });
    const controller = new AbortController();
    const cancelled = query(undefined, { signal: controller.signal });
    controller.abort();
    expect(await cancelled).toMatchObject({ status: 'failed', output: 'Request aborted' });
  });
});
