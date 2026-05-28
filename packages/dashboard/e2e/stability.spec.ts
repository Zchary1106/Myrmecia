import { test, expect } from '@playwright/test';

/**
 * Test that the dashboard reliably loads agents and diagnostics,
 * even after multiple page refreshes.
 */
test.describe('Dashboard stability', () => {
  test('agents load and persist across refreshes', async ({ page }) => {
    await page.goto('/');

    // Wait for agents to appear (retry logic should handle slow server)
    const agentText = page.locator('text=/\\d+ agents/');
    await expect(agentText).toBeVisible({ timeout: 15000 });

    // Verify it's not "0 agents"
    const text = await agentText.textContent();
    expect(text).not.toContain('0 agents');

    // Reload page 3 times and verify agents remain
    for (let i = 0; i < 3; i++) {
      await page.reload();
      // Wait for agents to reappear
      await expect(agentText).toBeVisible({ timeout: 10000 });
      const reloadText = await agentText.textContent();
      expect(reloadText).not.toContain('0 agents');
    }
  });

  test('diagnostics loads (no "unknown operator")', async ({ page }) => {
    await page.goto('/');

    // Wait for diagnostics to resolve
    // The "unknown operator" text should disappear within retry window
    await expect(page.locator('text=unknown operator')).toBeHidden({ timeout: 15000 });

    // Should show actual operator info
    await expect(page.locator('text=/local-admin|admin|operator/')).toBeVisible({ timeout: 5000 });
  });

  test('agents recover after temporary API failure', async ({ page }) => {
    await page.goto('/');

    // Wait for initial load
    const agentText = page.locator('text=/\\d+ agents/');
    await expect(agentText).toBeVisible({ timeout: 15000 });

    // Simulate network interruption by blocking API briefly
    await page.route('**/api/v1/agents', async (route) => {
      route.abort('connectionrefused');
    });

    // Reload - should show 0 temporarily
    await page.reload();
    await page.waitForTimeout(1000);

    // Unblock API
    await page.unroute('**/api/v1/agents');

    // Retry logic should recover within 3-6 seconds
    await expect(agentText).toBeVisible({ timeout: 10000 });
    const recovered = await agentText.textContent();
    expect(recovered).not.toContain('0 agents');
  });
});
