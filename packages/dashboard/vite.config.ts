import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

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

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: dashboardPort,
    strictPort: process.env.E2E_DASHBOARD_PORT !== undefined,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/ws': {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
});
