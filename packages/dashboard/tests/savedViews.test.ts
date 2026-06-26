import { describe, it, expect } from 'vitest';
import type { OperatorRole, RuntimeDiagnostics } from '@myrmecia/shared';
import { savedViewScope, createSavedView } from '../src/lib/savedViews';

function diag(id: string, role: OperatorRole, source: 'local' | 'token' | 'proxy'): RuntimeDiagnostics {
  return { operator: { actor: { id, role, source } } } as unknown as RuntimeDiagnostics;
}

describe('savedViewScope', () => {
  it('returns "unknown" when there is no actor', () => {
    expect(savedViewScope(null)).toBe('unknown');
  });
  it('composes source:role:id', () => {
    expect(savedViewScope(diag('alice', 'admin', 'local'))).toBe('local:admin:alice');
  });
  it('sanitizes unsafe characters in the actor id', () => {
    expect(savedViewScope(diag('a/b c@d', 'operator', 'token'))).toBe('token:operator:a_b_c_d');
  });
});

describe('createSavedView', () => {
  it('builds a view with name, filters, an id and a timestamp', () => {
    const filters = { status: 'unread', scope: 'all' };
    const view = createSavedView('My View', filters);
    expect(view.name).toBe('My View');
    expect(view.filters).toEqual(filters);
    expect(view.id).toMatch(/^view_/);
    expect(() => new Date(view.createdAt).toISOString()).not.toThrow();
  });

  it('generates unique ids across calls', () => {
    const a = createSavedView('a', {});
    const b = createSavedView('b', {});
    expect(a.id).not.toBe(b.id);
  });
});
