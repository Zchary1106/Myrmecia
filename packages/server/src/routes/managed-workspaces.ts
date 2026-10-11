import { Router, type Request } from 'express';
import { z } from 'zod';
import { getDb } from '../db/database.js';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { HttpError, parseBody, requireOperatorRole, sendError } from './http.js';
import { getManagedWorkspace, getWorkspaceBinding, listManagedWorkspaces, registerManagedWorkspace, workspaceBlockers } from '../db/models/managed-workspace.js';
import { previewWorkspaceOperation, applyWorkspaceOperation } from '../workspace/workspace-lifecycle.js';
import { previewWorkspaceChanges, applyWorkspaceChanges } from '../workspace/workspace-changes.js';
import { getTask } from '../db/models/task.js';
import { previewDirtySource, createDirtySourceSnapshot } from '../workspace/workspace-source-snapshot.js';
import { workspaceUsage } from '../workspace/workspace-usage.js';
import { previewLeaseReconciliation, reconcileWorkspaceLeases } from '../workspace/workspace-reconciliation.js';
import { previewWorkspaceMaintenance, applyWorkspaceMaintenance } from '../workspace/workspace-maintenance.js';
function scope(req: Request) {
  const actor = requireOperatorRole(req, 'workspace.manage', ['admin', 'operator']);
  return { workspaceId: workspaceIdFromRequest(req) || 'default', actorId: actor.id };
}
function failure(res: any, error: any) {
  sendError(res, error instanceof HttpError ? error : new HttpError(error.message === 'WORKSPACE_NOT_FOUND' ? 404 : 409, 'WORKSPACE_CONFLICT', error.message));
}
const operationSchema = z.enum(['archive', 'restore', 'purge']);
const filesSchema = z.array(z.string().min(1).max(500)).min(1).max(100);
export function createManagedWorkspaceRoutes(): Router {
  const router = Router();
  router.get('/', (req, res) => {
    try {
      const owner = scope(req);
      res.json(listManagedWorkspaces(owner).map(workspace => ({ ...workspace, ...workspaceUsage(workspace.canonicalPath), blockers: workspaceBlockers(workspace),
        occupants: getDb().all('SELECT task_id AS taskId, mode, owner, state FROM workspace_leases WHERE canonical_path=? AND state<>?', workspace.canonicalPath, 'released'),
        snapshotBytes: getDb().get<any>(`SELECT COALESCE(SUM(s.size_bytes),0) AS bytes FROM execution_artifact_snapshots s
          JOIN execution_artifacts a ON a.id=s.artifact_id JOIN workspace_execution_bindings b ON b.task_id=a.task_id WHERE b.filesystem_workspace_id=?`, workspace.id)?.bytes || 0 })));
    } catch (error) { failure(res, error); }
  });
  router.post('/register', (req, res) => {
    try {
      const data = parseBody(z.object({ path: z.string().min(1).max(16384) }).strict(), req);
      const owner = scope(req);
      // Explicit registration only grants source ownership, never permission to purge.
      res.status(201).json(registerManagedWorkspace({ ...owner, canonicalPath: data.path, sourceKind: 'directory',
        ownership: 'user_source', accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: [] } }));
    } catch (error) { failure(res, error); }
  });
  router.get('/task/:taskId', (req, res) => {
    try {
      const owner = scope(req), task = getTask(req.params.taskId);
      if (!task || (task.workspaceId || 'default') !== owner.workspaceId) throw new Error('WORKSPACE_NOT_FOUND');
      const binding = getWorkspaceBinding(task.id);
      if (!binding) return res.json({ legacy: true, executionPath: task.workdir || task.workspacePath, ownership: 'legacy_unmanaged',
        diagnostics: ['Recorded path retained. Explicit registration required; no automatic management ownership.'] });
      const workspace = getManagedWorkspace(binding.filesystemWorkspaceId, owner);
      if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
      res.json({ binding, workspace, source: binding.sourceWorkspaceId ? getManagedWorkspace(binding.sourceWorkspaceId, owner) : undefined,
        occupants: getDb().all("SELECT task_id AS taskId, mode, state FROM workspace_leases WHERE canonical_path=? AND state<>'released'", workspace.canonicalPath),
        diagnostics: ['Directory isolation is not OS isolation. Host Shell, external Agents and MCP are outside a filesystem security sandbox.'] });
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/preview', (req, res) => {
    try { const owner = scope(req); const { operation } = parseBody(z.object({ operation: operationSchema }).strict(), req);
      res.json(previewWorkspaceOperation(owner, req.params.id, operation));
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/maintenance/preview', (req, res) => {
    try {
      const data = parseBody(z.object({ action: z.enum(['adopt_source', 'delete_branch']) }).strict(), req);
      res.json(previewWorkspaceMaintenance(scope(req), req.params.id, data.action));
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/maintenance', (req, res) => {
    try {
      const data = parseBody(z.object({ action: z.enum(['adopt_source', 'delete_branch']), previewId: z.string(),
        manifestHash: z.string().length(64), confirm: z.literal(true) }).strict(), req);
      res.json(applyWorkspaceMaintenance(scope(req), req.params.id, data));
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/operations', (req, res) => {
    try { const owner = scope(req);
      const data = parseBody(z.object({ operation: operationSchema, expectedRevision: z.number().int().positive(),
        manifestHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string(), previewId: z.string(), confirm: z.literal(true) }).strict(), req);
      res.json(applyWorkspaceOperation(owner, req.params.id, data));
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/changes/preview', (req, res) => {
    try { const owner = scope(req); const data = parseBody(z.object({ targetWorkspaceId: z.string(), files: filesSchema }).strict(), req);
      res.json(previewWorkspaceChanges(owner, req.params.id, data));
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/leases/preview', (req, res) => {
    try { res.json(previewLeaseReconciliation(scope(req), req.params.id)); }
    catch (error) { failure(res, error); }
  });
  router.post('/:id/leases/reconcile', (req, res) => {
    try { const owner = scope(req); const data = parseBody(z.object({ previewId: z.string(), manifestHash: z.string(),
      effectsStopped: z.literal(true), confirm: z.literal(true) }).strict(), req);
      res.json(reconcileWorkspaceLeases(owner, req.params.id, data));
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/source-snapshot/preview', (req, res) => {
    try { const owner = scope(req); const data = parseBody(z.object({ selectedFiles: filesSchema }).strict(), req);
      res.json(previewDirtySource(owner, req.params.id, data.selectedFiles));
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/source-snapshot', (req, res) => {
    try { const owner = scope(req); const data = parseBody(z.object({ selectedFiles: filesSchema, previewId: z.string(), manifestHash: z.string(), confirm: z.literal(true) }).strict(), req);
      res.json(createDirtySourceSnapshot(owner, req.params.id, data));
    } catch (error) { failure(res, error); }
  });
  router.get('/:id/operations', (req, res) => {
    try { const owner = scope(req);
      if (!getManagedWorkspace(req.params.id, owner)) throw new Error('WORKSPACE_NOT_FOUND');
      res.json(getDb().all(`SELECT id,operation,state,error,created_at AS createdAt,updated_at AS updatedAt FROM workspace_operation_journal
        WHERE workspace_id=? AND actor_id=? AND filesystem_workspace_id=? ORDER BY created_at DESC LIMIT 100`, owner.workspaceId, owner.actorId, req.params.id));
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/changes/apply', (req, res) => {
    try { const owner = scope(req); const data = parseBody(z.object({ targetWorkspaceId: z.string(), files: filesSchema, diffHash: z.string(),
      targetHead: z.string(), targetBranch: z.string(), confirm: z.literal(true) }).strict(), req);
      res.json(applyWorkspaceChanges(owner, req.params.id, data));
    } catch (error) { failure(res, error); }
  });
  return router;
}
