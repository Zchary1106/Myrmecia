import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const dashboard = dirname(fileURLToPath(import.meta.url));
const root = resolve(dashboard, '../..');
const apiPort = Number(process.env.RUNTIME_V2_API_PORT || 3350);
const webPort = Number(process.env.RUNTIME_V2_WEB_PORT || 5350);
for (const port of [apiPort, webPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid acceptance port');
const noProxy = `${process.env.NO_PROXY || ''},127.0.0.1,localhost`;
const evidenceDirectory = process.env.MYRMECIA_WORKSPACE_ACCEPTANCE ? 'artifacts/workspace-lifecycle' : 'artifacts/agent-runtime-v2';
process.env.NO_PROXY = noProxy; process.env.no_proxy = noProxy;
// Fixture readiness/browser traffic is loopback only. Do not inherit a desktop
// proxy that sends localhost checks through an external proxy server.
const fixtureEnv = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
  http_proxy: '', https_proxy: '', all_proxy: '' };
export default defineConfig({
  testDir: './e2e', testMatch: ['runtime-v2-real-backend.spec.ts', 'agent-governance.spec.ts', 'workspace-lifecycle.spec.ts'], workers: 1, retries: 0, timeout: 60_000,
  outputDir: resolve(root, `${evidenceDirectory}/browser-e2e`),
  reporter: [['list'], ['json', { outputFile: resolve(root, `${evidenceDirectory}/browser-e2e.json`) }]],
  use: { baseURL: `http://127.0.0.1:${webPort}`, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'pnpm --filter @myrmecia/server exec tsx tests/fixtures/runtime-v2-server.ts', cwd: root,
      url: `http://127.0.0.1:${apiPort}/health/ready`, reuseExistingServer: false, timeout: 120_000,
      env: { ...fixtureEnv, PORT: String(apiPort), MYRMECIA_FIXTURE_DELAY_MS: '3000' } },
    { command: 'pnpm dev', cwd: dashboard, url: `http://127.0.0.1:${webPort}`, reuseExistingServer: false, timeout: 120_000,
      env: { ...fixtureEnv, E2E_API_PORT: String(apiPort), E2E_DASHBOARD_PORT: String(webPort) } },
  ],
});
