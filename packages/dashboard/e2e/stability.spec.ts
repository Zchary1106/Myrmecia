import { test, expect } from '@playwright/test';

const loadedAgentSummary = /\d+ running \/ [1-9]\d* agents/;

/**
 * Test that the dashboard reliably loads agents and diagnostics,
 * even after multiple page refreshes.
 */
test.describe('Dashboard stability', () => {
  test('agents load and persist across refreshes', async ({ page }) => {
    await page.goto('/');

    // Wait for a loaded count rather than the initial "0 agents" placeholder.
    const agentSummary = page.getByTestId('agent-summary');
    await expect(agentSummary).toHaveText(loadedAgentSummary, { timeout: 15000 });

    // Reload page 3 times and verify agents remain
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await expect(agentSummary).toHaveText(loadedAgentSummary, { timeout: 10000 });
    }
  });

  test('diagnostics loads (no "unknown operator")', async ({ page }) => {
    await page.goto('/');

    const operatorIdentity = page.getByTestId('operator-identity');
    await expect(operatorIdentity).not.toHaveText(/unknown operator/, { timeout: 15000 });
    await expect(operatorIdentity).toHaveText(/local-admin|admin|operator/, { timeout: 5000 });
  });

  test('agents recover after temporary API failure', async ({ page }) => {
    await page.goto('/');

    // Wait for initial load
    const agentSummary = page.getByTestId('agent-summary');
    await expect(agentSummary).toHaveText(loadedAgentSummary, { timeout: 15000 });

    // Simulate network interruption by blocking API briefly
    await page.route('**/api/v1/agents', async (route) => {
      route.abort('connectionrefused');
    });

    // Reload - should show 0 temporarily
    await page.reload();
    await page.waitForTimeout(1000);

    // Unblock API
    await page.unroute('**/api/v1/agents');

    // The store retries failed loads; wait for the recovered API state, not the
    // always-visible initial placeholder.
    await expect(agentSummary).toHaveText(loadedAgentSummary, { timeout: 10000 });
  });
});
