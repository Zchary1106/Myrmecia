import { describe, it, expect, vi } from 'vitest';

vi.mock('../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../db/models/agent.js', () => ({
  listAgents: vi.fn(() => [
    { id: 'dev', capabilities: ['coding'], config: { maxConcurrent: 1 } },
    { id: 'qa', capabilities: ['testing'], config: { maxConcurrent: 1 } },
  ]),
}));
vi.mock('../db/models/execution.js', () => ({
  getActiveExecutionCount: vi.fn(() => 0),
}));

describe('Batch C integration', () => {
  it('CapabilityRegistry builds index and finds providers', async () => {
    const { CapabilityRegistry } = await import('../agents/capability-registry.js');
    const registry = new CapabilityRegistry();
    registry.buildIndex();

    expect(registry.findProvider('coding')?.id).toBe('dev');
    expect(registry.findProvider('testing')?.id).toBe('qa');
    expect(registry.findProvider('nonexistent')).toBeUndefined();
    expect(registry.listCapabilities()).toHaveLength(2);
  });

  it('SharedArtifactStore enforces capability-based access', async () => {
    vi.doMock('../db/models/shared-artifact.js', () => ({
      createArtifact: vi.fn((d: any) => ({ id: 'art_1', ...d, readableBy: d.readableBy, expiresAt: '2099-01-01', createdAt: '2026-01-01' })),
      getArtifact: vi.fn(() => ({ id: 'art_1', ownerId: 'dev', name: 'code', content: 'hello', readableBy: ['testing'], expiresAt: '2099-01-01', createdAt: '2026-01-01' })),
      listArtifacts: vi.fn(() => []),
      deleteExpiredArtifacts: vi.fn(() => 0),
    }));

    const { CapabilityRegistry } = await import('../agents/capability-registry.js');
    const registry = new CapabilityRegistry();
    registry.buildIndex();

    const { SharedArtifactStore } = await import('../agents/shared-artifact-store.js');
    const store = new SharedArtifactStore(registry);

    const content = store.read('art_1', 'qa');
    expect(content).toBe('hello');

    const ownerContent = store.read('art_1', 'dev');
    expect(ownerContent).toBe('hello');
  });
});
