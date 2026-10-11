import { randomUUID, createHash } from 'node:crypto';
import type { ExecutionWorkspaceBinding, ManagedWorkspace } from '@myrmecia/shared';
import { getDb } from '../database.js';
import { canonicalRoot, rootIdentity } from '../../workspace/path-policy.js';

export interface WorkspaceScope { workspaceId: string; actorId: string }
const decode = (row: any): ManagedWorkspace => ({
  id: row.id, workspaceId: row.workspace_id, actorId: row.actor_id, canonicalPath: row.canonical_path,
  sourcePath: row.source_path || undefined, sourceKind: row.source_kind, ownership: row.ownership,
  accessMode: row.access_mode, baseline: JSON.parse(row.baseline), lifecycle: row.lifecycle,
  revision: row.revision, lastUsedAt: row.last_used_at, createdAt: row.created_at, captureState: row.capture_state,
});
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export const workspaceHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function getManagedWorkspace(id: string, scope?: WorkspaceScope): ManagedWorkspace | undefined {
  const row = getDb().get('SELECT * FROM managed_workspaces WHERE id = ?', id);
  if (!row || (scope && (row.workspace_id !== scope.workspaceId || row.actor_id !== scope.actorId))) return undefined;
  return decode(row);
}
export function listManagedWorkspaces(scope?: WorkspaceScope): ManagedWorkspace[] {
  const rows = scope ? getDb().all('SELECT * FROM managed_workspaces WHERE workspace_id = ? AND actor_id = ? ORDER BY last_used_at DESC', scope.workspaceId, scope.actorId)
    : getDb().all('SELECT * FROM managed_workspaces ORDER BY last_used_at DESC');
  return rows.map(decode);
}
export function registerManagedWorkspace(data: Omit<ManagedWorkspace, 'id' | 'revision' | 'lifecycle' | 'lastUsedAt' | 'createdAt' | 'captureState'>): ManagedWorkspace {
  const path = canonicalRoot(data.canonicalPath);
  const old = getDb().get<any>('SELECT * FROM managed_workspaces WHERE canonical_path = ?', path);
  if (old) {
    if (old.workspace_id !== data.workspaceId || old.actor_id !== data.actorId) throw new Error('WORKSPACE_SCOPE_CONFLICT');
    if (old.ownership !== data.ownership) throw new Error('WORKSPACE_OWNERSHIP_CONFLICT');
    return decode(old);
  }
  const id = `fsw_${randomUUID()}`, now = new Date().toISOString();
  getDb().run(`INSERT INTO managed_workspaces
    (id, workspace_id, actor_id, canonical_path, source_path, source_kind, ownership, access_mode, baseline, root_identity, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, data.workspaceId, data.actorId, path, data.sourcePath || null,
  data.sourceKind, data.ownership, data.accessMode, JSON.stringify(data.baseline), rootIdentity(path), now, now);
  return getManagedWorkspace(id)!;
}
export function assertWorkspaceIdentity(workspace: ManagedWorkspace): void {
  const row = getDb().get<any>('SELECT root_identity FROM managed_workspaces WHERE id = ?', workspace.id);
  if (!row || canonicalRoot(workspace.canonicalPath) !== workspace.canonicalPath || rootIdentity(workspace.canonicalPath) !== row.root_identity) throw new Error('WORKSPACE_ROOT_CHANGED');
}
export function getWorkspaceBinding(taskId: string): ExecutionWorkspaceBinding | undefined {
  const row = getDb().get<any>('SELECT * FROM workspace_execution_bindings WHERE task_id = ?', taskId);
  return row && { taskId: row.task_id, workspaceId: row.workspace_id, filesystemWorkspaceId: row.filesystem_workspace_id,
    sourceWorkspaceId: row.source_workspace_id || undefined, executionPath: row.execution_path, accessMode: row.access_mode, baseline: JSON.parse(row.baseline) };
}
export function bindWorkspace(binding: ExecutionWorkspaceBinding): void {
  const workspace = getManagedWorkspace(binding.filesystemWorkspaceId);
  if (!workspace || workspace.workspaceId !== binding.workspaceId || workspace.canonicalPath !== canonicalRoot(binding.executionPath)) throw new Error('WORKSPACE_BINDING_DENIED');
  const old = getWorkspaceBinding(binding.taskId);
  if (old && JSON.stringify(old) !== JSON.stringify(binding)) throw new Error('WORKSPACE_BINDING_IMMUTABLE');
  getDb().run(`INSERT OR IGNORE INTO workspace_execution_bindings
    (task_id, workspace_id, filesystem_workspace_id, source_workspace_id, execution_path, access_mode, baseline, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, binding.taskId, binding.workspaceId, binding.filesystemWorkspaceId, binding.sourceWorkspaceId || null,
  binding.executionPath, binding.accessMode, JSON.stringify(binding.baseline), new Date().toISOString());
  touchWorkspace(workspace.id);
}
export function touchWorkspace(id: string, captureState?: ManagedWorkspace['captureState']): void {
  getDb().run(`UPDATE managed_workspaces SET last_used_at = ?, capture_state = COALESCE(?, capture_state),
    lifecycle = CASE WHEN lifecycle = 'candidate' THEN 'active' ELSE lifecycle END WHERE id = ?`,
  new Date().toISOString(), captureState || null, id);
}
export function workspaceBlockers(workspace: ManagedWorkspace, ignoredLeaseIds: string[] = []): string[] {
  const db = getDb(), blockers: string[] = [];
  if (workspace.ownership === 'legacy_unmanaged') blockers.push('Legacy ownership is unresolved');
  if (db.all<any>("SELECT id,canonical_path FROM workspace_leases WHERE state <> 'released'").some(row => !ignoredLeaseIds.includes(row.id) && (row.canonical_path === workspace.canonicalPath
    || row.canonical_path.startsWith(`${workspace.canonicalPath}/`) || workspace.canonicalPath.startsWith(`${row.canonical_path}/`)))) blockers.push('Active or uncertain directory lease');
  if (db.get(`SELECT 1 FROM workspace_execution_bindings b JOIN tasks t ON t.id = b.task_id
    WHERE b.filesystem_workspace_id = ? AND t.status NOT IN ('done','failed','cancelled')`, workspace.id)) blockers.push('Unsettled linked task');
  if (db.get(`SELECT 1 FROM workspace_execution_bindings b JOIN pipelines p ON b.task_id = 'pipeline_' || p.id
    WHERE b.filesystem_workspace_id = ? AND p.status NOT IN ('done','failed')`, workspace.id)) blockers.push('Unsettled linked pipeline');
  if (db.get(`SELECT 1 FROM workspace_operation_journal WHERE filesystem_workspace_id = ? AND state IN ('applying','reconciliation')`, workspace.id)) blockers.push('Unresolved operation');
  if (workspace.ownership === 'managed_execution' && (workspace.captureState === 'pending' || workspace.captureState === 'failed')) blockers.push('Artifact capture not settled');
  return blockers;
}
export function markWorkspaceCandidates(retentionMs: number, now = Date.now()): number {
  let count = 0;
  for (const workspace of listManagedWorkspaces()) {
    const latest = getDb().get<any>(`SELECT MAX(t.completed_at) AS settled FROM tasks t JOIN workspace_execution_bindings b ON b.task_id=t.id WHERE b.filesystem_workspace_id=?`, workspace.id)?.settled;
    const lastUse = Math.max(Date.parse(workspace.lastUsedAt), latest ? Date.parse(latest) : 0);
    if (workspace.lifecycle !== 'active' || workspace.ownership !== 'managed_execution' || workspaceBlockers(workspace).length || now - lastUse < retentionMs) continue;
    getDb().run("UPDATE managed_workspaces SET lifecycle='candidate', revision=revision+1 WHERE id=? AND revision=?", workspace.id, workspace.revision);
    count++;
  }
  return count;
}
