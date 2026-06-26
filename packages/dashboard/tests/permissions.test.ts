import { describe, it, expect } from 'vitest';
import type { OperatorRole, RuntimeDiagnostics } from '@myrmecia/shared';
import { runtimeControlsAllowed, taskDeleteAllowed, operatorRoleLabel } from '../src/lib/permissions';

function diag(opts: {
  role?: OperatorRole;
  source?: 'local' | 'token' | 'proxy';
  id?: string;
  canControlRuntime?: boolean;
  canDeleteTasks?: boolean;
}): RuntimeDiagnostics {
  return {
    operator: {
      actor: { id: opts.id ?? 'u1', role: opts.role ?? 'admin', source: opts.source ?? 'local' },
      permissions: {
        canControlRuntime: opts.canControlRuntime ?? true,
        canDeleteTasks: opts.canDeleteTasks ?? true,
      },
    },
  } as unknown as RuntimeDiagnostics;
}

describe('runtimeControlsAllowed', () => {
  it('defaults to true when diagnostics are unavailable (local-first preview)', () => {
    expect(runtimeControlsAllowed(null)).toBe(true);
  });
  it('reflects the canControlRuntime permission', () => {
    expect(runtimeControlsAllowed(diag({ canControlRuntime: false }))).toBe(false);
    expect(runtimeControlsAllowed(diag({ canControlRuntime: true }))).toBe(true);
  });
});

describe('taskDeleteAllowed', () => {
  it('defaults to true when diagnostics are null', () => {
    expect(taskDeleteAllowed(null)).toBe(true);
  });
  it('reflects the canDeleteTasks permission', () => {
    expect(taskDeleteAllowed(diag({ canDeleteTasks: false }))).toBe(false);
  });
});

describe('operatorRoleLabel', () => {
  it('returns a placeholder when there is no actor', () => {
    expect(operatorRoleLabel(null)).toBe('unknown operator');
  });
  it('formats id · role · source', () => {
    expect(operatorRoleLabel(diag({ id: 'alice', role: 'operator', source: 'token' })))
      .toBe('alice · operator · token');
  });
});
