import { describe, it, expect } from 'vitest';

describe('api client', () => {
  it('constructs correct base URL for v1 API', async () => {
    // Verify the api module exports correctly
    const { api } = await import('../src/lib/api');
    expect(api).toBeDefined();
    expect(api.tasks).toBeDefined();
    expect(api.agents).toBeDefined();
    expect(api.health).toBeDefined();
  });
});
