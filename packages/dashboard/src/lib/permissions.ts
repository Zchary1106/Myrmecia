import type { RuntimeDiagnostics } from '@myrmecia/shared';

export function runtimeControlsAllowed(diagnostics: RuntimeDiagnostics | null): boolean {
  return diagnostics?.operator.permissions.canControlRuntime ?? true;
}

export function taskDeleteAllowed(diagnostics: RuntimeDiagnostics | null): boolean {
  return diagnostics?.operator.permissions.canDeleteTasks ?? true;
}

export function operatorRoleLabel(diagnostics: RuntimeDiagnostics | null): string {
  const actor = diagnostics?.operator.actor;
  if (!actor) return 'unknown operator';
  return `${actor.id} · ${actor.role} · ${actor.source}`;
}

export const readOnlyControlMessage = 'Your current operator role is read-only. Ask an admin/operator to perform this control action.';
