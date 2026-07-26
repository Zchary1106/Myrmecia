import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function e2ePort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  return port;
}

const apiPort = e2ePort('E2E_API_PORT', 3000);
const dashboardPort = e2ePort('E2E_DASHBOARD_PORT', 5173);
const dashboardDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(dashboardDirectory, '../..');

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: `http://localhost:${dashboardPort}`,
    headless: true,
  },
  webServer: [
    {
      command: 'pnpm --filter @myrmecia/server dev',
      cwd: repositoryRoot,
      url: `http://127.0.0.1:${apiPort}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        PORT: String(apiPort),
      },
    },
    {
      command: 'pnpm dev',
      cwd: dashboardDirectory,
      url: `http://localhost:${dashboardPort}`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        E2E_API_PORT: String(apiPort),
        E2E_DASHBOARD_PORT: String(dashboardPort),
      },
    },
  ],
});
