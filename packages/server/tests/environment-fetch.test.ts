import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import {
  closeEnvironmentFetch,
  environmentFetch,
  proxyEnvironmentConfigured,
  safeNetworkError,
} from '../src/lib/environment-fetch.js';

const original = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  no_proxy: process.env.no_proxy,
};

afterEach(async () => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closeEnvironmentFetch();
});

describe('environment-aware outbound fetch', () => {
  it('honors NO_PROXY for loopback even when a proxy is configured', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    process.env.NO_PROXY = '127.0.0.1,localhost';
    try {
      expect(proxyEnvironmentConfigured()).toBe(true);
      const response = await environmentFetch(`http://127.0.0.1:${port}`);
      expect(await response.text()).toBe('ok');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('returns actionable errors without exposing proxy credentials', () => {
    process.env.HTTPS_PROXY = 'http://private-user:private-pass@127.0.0.1:1';
    const message = safeNetworkError(Object.assign(new Error('secret URL'), { cause: { code: 'ECONNREFUSED' } }));
    expect(message).toBe('configured proxy refused the connection');
    expect(message).not.toContain('private-user');
    expect(message).not.toContain('private-pass');
    expect(safeNetworkError(new Error('Fetch failed: 403 Forbidden'))).toBe('HTTP request failed with status 403');
  });
});
