import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createHealthRoutes } from '../src/observability/health.js';

async function withHealthServer<T>(callback: (origin: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use('/health', createHealthRoutes());
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind health test server');

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

afterEach(() => {
  delete process.env.MYRMECIA_DESKTOP_HEALTH_TOKEN;
});

describe('health routes', () => {
  it('keeps the root health probe public outside desktop mode', async () => {
    await withHealthServer(async origin => {
      const response = await fetch(`${origin}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    });
  });

  it('requires the desktop launch token when configured', async () => {
    process.env.MYRMECIA_DESKTOP_HEALTH_TOKEN = 'desktop-test-token';

    await withHealthServer(async origin => {
      const missing = await fetch(`${origin}/health`);
      expect(missing.status).toBe(404);

      const invalid = await fetch(`${origin}/health`, {
        headers: { 'x-myrmecia-health-token': 'incorrect-token' },
      });
      expect(invalid.status).toBe(404);

      const valid = await fetch(`${origin}/health`, {
        headers: { 'x-myrmecia-health-token': 'desktop-test-token' },
      });
      expect(valid.status).toBe(200);
      await expect(valid.json()).resolves.toEqual({ status: 'ok' });
    });
  });
});
