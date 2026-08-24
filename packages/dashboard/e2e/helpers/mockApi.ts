import type { Page, Route } from '@playwright/test';

export async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

export async function mockControllingOperator(page: Page) {
  await page.route('**/api/v1/diagnostics', route => fulfillJson(route, {
    auth: { enabled: false, mode: 'local' },
    operator: {
      actor: { id: 'e2e-operator', role: 'admin', source: 'local' },
      permissions: { canControlRuntime: true, canDeleteTasks: true },
    },
    queue: { backend: 'memory', redisConfigured: false },
    database: { pathSource: 'env', pathHint: ':memory:', migrations: [] },
    runtime: {
      nodeVersion: 'v22.0.0',
      platform: 'darwin',
      pid: 1,
      uptime: 120,
      environment: 'e2e',
    },
  }));
}
