import { Router, raw, type Request } from 'express';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, normalize, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { HttpError, requireOperatorRole, sendError } from './http.js';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { getDb } from '../db/database.js';
import { registerManagedWorkspace } from '../db/models/managed-workspace.js';
import { canonicalRoot, rootIdentity, excludedWorkspacePath, readWorkspaceBytes, safeWorkspacePath, WORKSPACE_LIMITS } from '../workspace/path-policy.js';

const execFileAsync = promisify(execFile);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function scope(req: Request) {
  const actor = requireOperatorRole(req, 'workspace.import', ['admin', 'operator']);
  return { workspaceId: workspaceIdFromRequest(req) || 'default', actorId: actor.id };
}
function workspaceRoot(): string {
  const root = resolve(process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd(), '.agent-factory', 'imported-workspaces');
  mkdirSync(root, { recursive: true }); return canonicalRoot(root);
}
function sessionFor(req: Request): any {
  const owner = scope(req);
  const session = getDb().get<any>('SELECT * FROM workspace_import_sessions WHERE id=? AND workspace_id=? AND actor_id=?',
    req.params.id, owner.workspaceId, owner.actorId);
  if (!session) throw new HttpError(404, 'WORKSPACE_IMPORT_NOT_FOUND', 'Workspace import session not found');
  if (session.state === 'uploading' && Date.parse(session.expires_at) < Date.now()) throw new HttpError(409, 'WORKSPACE_IMPORT_EXPIRED', 'Import expired; files retained for reconciliation');
  if (session.state === 'uploading' && (canonicalRoot(session.root) !== session.root || rootIdentity(session.root) !== JSON.parse(session.receipt || '{}').rootIdentity)) throw new HttpError(409, 'IMPORT_ROOT_CHANGED', 'Import directory needs reconciliation');
  return session;
}
function relativeFile(value: string): string {
  const path = normalize(value.replaceAll('\\', '/'));
  if (!path || path === '.' || path.startsWith('..') || path.startsWith('/') || path.includes('\0') || path.split('/').length > WORKSPACE_LIMITS.depth + 1) throw new HttpError(400, 'INVALID_WORKSPACE_FILE', 'Workspace file path is invalid');
  return path;
}
/** Trusted hosts only, no redirects or non-HTTP Git transport. CLI is not a network sandbox. */
export async function validateWorkspaceRemoteUrl(value: string): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'Invalid repository URL'); }
  const allowed = (process.env.MYRMECIA_GIT_ALLOWED_HOSTS || 'github.com').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowed.includes(parsed.hostname.toLowerCase())) throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'HTTPS repository host must be explicitly allowed by the server');
  const addresses = await lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::|fc|fd|fe80|::ffff:)/i.test(address))) throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'Private network repository destinations are denied');
  return parsed.toString();
}
export function createWorkspaceSourceRoutes(): Router {
  const router = Router();
  router.post('/local', (req, res) => {
    try {
      const owner = scope(req), id = `local_${randomUUID()}`;
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) || 'local-workspace' : 'local-workspace';
      const root = safeWorkspacePath(workspaceRoot(), id); mkdirSync(root);
      getDb().run(`INSERT INTO workspace_import_sessions (id, workspace_id, actor_id, root, name, receipt, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, owner.workspaceId, owner.actorId, root, name, JSON.stringify({ rootIdentity: rootIdentity(root) }), new Date().toISOString(), new Date(Date.now() + 24 * 3600_000).toISOString());
      res.status(201).json({ id, name, revision: 1 });
    } catch (error) { sendError(res, error); }
  });
  router.put('/local/:id/file', raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
    try {
      const receipt = getDb().transaction(() => {
        const session = sessionFor(req);
        if (session.state !== 'uploading') throw new HttpError(409, 'IMPORT_CLOSED', 'Import is closed');
        const path = relativeFile(String(req.headers['x-workspace-file-path'] || ''));
        const manifest = JSON.parse(session.manifest);
        if (!(path in manifest) && Object.keys(manifest).length >= WORKSPACE_LIMITS.files) throw new HttpError(413, 'WORKSPACE_IMPORT_QUOTA', 'Too many uploaded/excluded files');
        if (excludedWorkspacePath(path)) {
          manifest[path] = { excluded: true };
        } else {
          if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'INVALID_WORKSPACE_FILE', 'File payload missing');
          manifest[path] = { bytes: req.body.length, sha256: hash(req.body) };
          const entries = Object.values(manifest) as Array<{ bytes?: number }>;
          if (entries.length > WORKSPACE_LIMITS.files || entries.reduce((sum, item) => sum + (item.bytes || 0), 0) > WORKSPACE_LIMITS.totalBytes) throw new HttpError(413, 'WORKSPACE_IMPORT_QUOTA', 'Import exceeds file or byte quota');
          const target = safeWorkspacePath(session.root, path);
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(safeWorkspacePath(session.root, path), req.body);
        }
        getDb().run('UPDATE workspace_import_sessions SET manifest=?, revision=revision+1 WHERE id=? AND revision=?',
          JSON.stringify(manifest), session.id, session.revision);
        return session.revision + 1;
      });
      res.setHeader('X-Workspace-Revision', receipt); res.status(204).end();
    } catch (error) { sendError(res, error); }
  });
  router.post('/local/:id/complete', (req, res) => {
    try {
      const receipt = getDb().transaction(() => {
        const session = sessionFor(req);
        if (session.state === 'complete') return JSON.parse(session.receipt);
        if (session.state !== 'uploading') throw new HttpError(409, 'IMPORT_CLOSED', 'Import is closed');
        const entries = Object.entries(JSON.parse(session.manifest)) as Array<[string, { excluded?: boolean; sha256?: string }]>;
        const files = entries.filter(([, info]) => !info.excluded);
        if (!files.length) throw new HttpError(400, 'EMPTY_WORKSPACE', 'Choose a folder containing non-secret files');
        for (const [path, info] of files) if (hash(readWorkspaceBytes(session.root, path)) !== info.sha256) throw new HttpError(409, 'IMPORT_NEEDS_RECONCILIATION', 'Upload manifest differs from stored bytes');
        const workspace = registerManagedWorkspace({ ...scope(req), canonicalPath: session.root, sourceKind: 'import', ownership: 'managed_import',
          accessMode: 'shared_write', baseline: { provenance: 'filtered_copy', excluded: entries.filter(([, info]) => info.excluded).map(([path]) => path) } });
        const result = { configured: true, path: workspace.canonicalPath, filesystemWorkspaceId: workspace.id,
          name: session.name, source: 'local', files: files.length, excluded: workspace.baseline.excluded };
        getDb().run("UPDATE workspace_import_sessions SET state='complete', receipt=?, revision=revision+1 WHERE id=?", JSON.stringify(result), session.id);
        return result;
      });
      res.status(201).json(receipt);
    } catch (error) { sendError(res, error); }
  });
  router.delete('/local/:id', (req, res) => {
    try {
      const session = sessionFor(req);
      if (session.state === 'complete') throw new HttpError(409, 'IMPORT_ALREADY_COMPLETED', 'Successful imports are retained');
      getDb().run("UPDATE workspace_import_sessions SET state='cancelled', revision=revision+1 WHERE id=?", session.id);
      // Cancellation is not deletion permission; retention is explicit.
      res.json({ ok: true, retained: true });
    } catch (error) { sendError(res, error); }
  });
  router.get('/imports', (req, res) => {
    try {
      const owner = scope(req);
      res.json(getDb().all<any>('SELECT id,name,state,revision,manifest,expires_at AS expiresAt FROM workspace_import_sessions WHERE workspace_id=? AND actor_id=? ORDER BY created_at DESC LIMIT 100',
        owner.workspaceId, owner.actorId).map(item => ({ ...item, manifest: JSON.parse(item.manifest),
          state: item.state === 'uploading' && Date.parse(item.expiresAt) < Date.now() ? 'expired_candidate' : item.state })));
    } catch (error) { sendError(res, error); }
  });
  router.post('/remote', async (req, res) => {
    try {
      const owner = scope(req);
      const url = await validateWorkspaceRemoteUrl(String(req.body?.url || ''));
      const branch = typeof req.body?.branch === 'string' && req.body.branch.trim() ? req.body.branch.trim() : undefined;
      if (branch && (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.startsWith('-'))) throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'Invalid branch');
      const id = `remote_${randomUUID()}`, root = safeWorkspacePath(workspaceRoot(), id);
      getDb().run(`INSERT INTO workspace_import_sessions (id, workspace_id, actor_id, root, name, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'cloning', ?, ?)`,
        id, owner.workspaceId, owner.actorId, root, id, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
      try {
        await execFileAsync('git', ['-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
          'clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), '--', url, root], { timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' } });
        const workspace = registerManagedWorkspace({ ...owner, canonicalPath: root, sourceKind: 'git', ownership: 'managed_import',
          accessMode: 'shared_write', baseline: { provenance: 'head_only', excluded: [] } });
        const result = { configured: true, path: workspace.canonicalPath, filesystemWorkspaceId: workspace.id, name: id, source: 'remote', repository: url, branch };
        getDb().run("UPDATE workspace_import_sessions SET state='complete', receipt=?, revision=revision+1 WHERE id=?", JSON.stringify(result), id);
        res.status(201).json(result);
      } catch (error) {
        getDb().run("UPDATE workspace_import_sessions SET state='reconciliation', revision=revision+1 WHERE id=?", id);
        throw error;
      }
    } catch (error) { sendError(res, error); }
  });
  return router;
}
