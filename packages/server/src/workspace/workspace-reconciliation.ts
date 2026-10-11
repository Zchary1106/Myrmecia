import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
import { assertWorkspaceIdentity, getManagedWorkspace, workspaceHash, type WorkspaceScope } from '../db/models/managed-workspace.js';
export function previewLeaseReconciliation(scope: WorkspaceScope, id: string) {
  const workspace = getManagedWorkspace(id, scope);
  if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
  assertWorkspaceIdentity(workspace);
  const claims = getDb().all<any>("SELECT id,task_id AS taskId,canonical_path AS path,mode,fence,owner,state FROM workspace_leases WHERE canonical_path=? AND state<>'released' ORDER BY id", workspace.canonicalPath);
  const blockers = claims.filter(claim => getDb().get("SELECT 1 FROM tasks WHERE id=? AND status NOT IN ('done','failed','cancelled')", claim.taskId))
    .map(claim => `Stop and settle task ${claim.taskId} first`);
  if (!claims.length) blockers.push('No held lease to reconcile');
  const manifest = { workspaceId: scope.workspaceId, filesystemWorkspaceId: id, revision: workspace.revision, claims, blockers };
  const preview = { ...manifest, previewId: `wpreview_${randomUUID()}`, manifestHash: workspaceHash(manifest), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  const now = new Date().toISOString();
  getDb().run(`INSERT INTO workspace_operation_journal
    (id,workspace_id,actor_id,filesystem_workspace_id,operation,manifest_hash,manifest,state,created_at,updated_at)
    VALUES (?,?,?,?,'reconcile_leases',?,?,'preview',?,?)`, preview.previewId, scope.workspaceId, scope.actorId, id, preview.manifestHash, JSON.stringify(preview), now, now);
  return preview;
}
export function reconcileWorkspaceLeases(scope: WorkspaceScope, id: string, data: { previewId: string; manifestHash: string; effectsStopped: boolean; confirm: boolean }) {
  if (!data.confirm || !data.effectsStopped) throw new Error('EXPLICIT_STOPPED_EFFECTS_ATTESTATION_REQUIRED');
  return getDb().transaction(() => {
    const receipt = getDb().get<any>("SELECT * FROM workspace_operation_journal WHERE id=? AND workspace_id=? AND actor_id=? AND filesystem_workspace_id=? AND operation='reconcile_leases' AND state='preview'",
      data.previewId, scope.workspaceId, scope.actorId, id);
    if (!receipt) throw new Error('WORKSPACE_RECONCILIATION_PREVIEW_NOT_FOUND');
    const preview = JSON.parse(receipt.manifest);
    if (Date.parse(preview.expiresAt) < Date.now() || receipt.manifest_hash !== data.manifestHash) throw new Error('WORKSPACE_RECONCILIATION_PREVIEW_STALE');
    const workspace = getManagedWorkspace(id, scope)!; assertWorkspaceIdentity(workspace);
    const current = getDb().all<any>("SELECT id,task_id AS taskId,canonical_path AS path,mode,fence,owner,state FROM workspace_leases WHERE canonical_path=? AND state<>'released' ORDER BY id", workspace.canonicalPath);
    if (workspace.revision !== preview.revision || workspaceHash(current) !== workspaceHash(preview.claims)
      || preview.blockers.length || current.some(claim => getDb().get("SELECT 1 FROM tasks WHERE id=? AND status NOT IN ('done','failed','cancelled')", claim.taskId))) throw new Error('WORKSPACE_RECONCILIATION_BLOCKED_OR_STALE');
    for (const claim of current) getDb().run("UPDATE workspace_leases SET state='released' WHERE id=? AND fence=?", claim.id, claim.fence);
    getDb().run("UPDATE workspace_operation_journal SET state='complete', updated_at=? WHERE id=?", new Date().toISOString(), data.previewId);
    getDb().run('UPDATE managed_workspaces SET revision=revision+1 WHERE id=?', id);
    // No process is killed, and no unknown Shell/MCP operation is replayed or marked successful.
    return { released: current.length, replayed: false, effectsStopped: 'operator_attested' };
  });
}
