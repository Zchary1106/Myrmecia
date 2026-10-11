import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Task } from '../types.js';
import { getDb } from '../db/database.js';
import { canonicalRoot, rootIdentity } from './path-policy.js';
import { assertWorkspaceIdentity, getManagedWorkspace, getWorkspaceBinding, touchWorkspace } from '../db/models/managed-workspace.js';
import { eventBus } from '../events/event-bus.js';
export class WorkspaceBusyError extends Error {
  constructor(readonly path: string) { super('WORKSPACE_BUSY: waiting for directory access'); }
}
export interface WorkspaceLease { id: string; taskId: string; root: string; identity: string; fence: number; mode: string }
const current = new AsyncLocalStorage<WorkspaceLease>();
export function claimWorkspaceLease(task: Task): WorkspaceLease {
  const binding = getWorkspaceBinding(task.id);
  const root = canonicalRoot(binding?.executionPath || task.workdir || task.workspacePath || '');
  const mode = binding?.accessMode || 'shared_write';
  return getDb().transaction(() => {
    if (binding) {
      const workspace = getManagedWorkspace(binding.filesystemWorkspaceId);
      if (!workspace || !['active', 'candidate'].includes(workspace.lifecycle)) throw new Error('WORKSPACE_ARCHIVED');
      assertWorkspaceIdentity(workspace); touchWorkspace(workspace.id);
    }
    const active = getDb().all<any>("SELECT * FROM workspace_leases WHERE state <> 'released'");
    const overlaps = (path: string) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`);
    if (active.some(row => overlaps(row.canonical_path) && (mode !== 'shared_readonly' || row.mode !== 'shared_readonly'))) throw new WorkspaceBusyError(root);
    const registered = getDb().get<any>('SELECT id,lifecycle FROM managed_workspaces WHERE canonical_path=?', root);
    if (registered && !['active', 'candidate'].includes(registered.lifecycle)) throw new Error('WORKSPACE_ARCHIVED_OR_UNRESOLVED');
    if (registered && getDb().get("SELECT 1 FROM workspace_operation_journal WHERE filesystem_workspace_id=? AND state IN ('applying','reconciliation')", registered.id)) throw new Error('WORKSPACE_OPERATION_NEEDS_RECONCILIATION');
    const fence = (getDb().get<any>('SELECT MAX(fence) AS fence FROM workspace_leases WHERE canonical_path = ?', root)?.fence || 0) + 1;
    const lease = { id: `wlease_${randomUUID()}`, taskId: task.id, root, identity: rootIdentity(root), fence, mode };
    getDb().run(`INSERT INTO workspace_leases (id, canonical_path, task_id, mode, fence, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      lease.id, root, task.id, mode, fence, `process:${process.pid}`, new Date().toISOString());
    return lease;
  });
}
/** No expiry-based steal: a crashed host command may still be writing. */
export function assertWorkspaceToolAllowed(tool?: string): void {
  const lease = current.getStore();
  if (!lease) return;
  if (rootIdentity(canonicalRoot(lease.root)) !== lease.identity
    || !getDb().get("SELECT 1 FROM workspace_leases WHERE id=? AND fence=? AND state='active'", lease.id, lease.fence)) throw new Error('WORKSPACE_FENCE_LOST');
  if (lease.mode === 'shared_readonly' && tool && !['file_read', 'file_list'].includes(tool)) throw new Error('WORKSPACE_READONLY_TOOL_DENIED');
}
export function currentWorkspaceAccessMode(): string | undefined { return current.getStore()?.mode; }
export function releaseWorkspaceLease(lease: WorkspaceLease): void {
  getDb().run("UPDATE workspace_leases SET state='released' WHERE id=? AND fence=?", lease.id, lease.fence);
}
export function workspaceAvailable(task: Task): boolean {
  const binding = getWorkspaceBinding(task.id), path = binding?.executionPath || task.workdir || task.workspacePath;
  if (!path) return true;
  const root = canonicalRoot(path), mode = binding?.accessMode || 'shared_write';
  return !getDb().all<any>("SELECT canonical_path,mode FROM workspace_leases WHERE state<>'released'").some(row =>
    (row.canonical_path === root || row.canonical_path.startsWith(`${root}/`) || root.startsWith(`${row.canonical_path}/`))
    && (mode !== 'shared_readonly' || row.mode !== 'shared_readonly'));
}
export async function withWorkspaceLease<T>(task: Task, execute: () => Promise<T>): Promise<T> {
  const lease = claimWorkspaceLease(task);
  try { return await current.run(lease, execute); }
  finally {
    const uncertain = getDb().get("SELECT 1 FROM agent_tool_invocations WHERE task_id=? AND outcome IN ('running','unknown')", task.id)
      || getDb().get("SELECT 1 FROM agent_provider_sessions WHERE task_id=? AND status='pending'", task.id);
    if (uncertain) getDb().run("UPDATE workspace_leases SET state='uncertain' WHERE id=? AND fence=?", lease.id, lease.fence);
    else releaseWorkspaceLease(lease);
    const binding = getWorkspaceBinding(task.id);
    if (binding) touchWorkspace(binding.filesystemWorkspaceId);
    eventBus.emit('task:updated', { taskId: task.id, workspaceId: task.workspaceId, workspaceLeaseReleased: !uncertain });
  }
}
