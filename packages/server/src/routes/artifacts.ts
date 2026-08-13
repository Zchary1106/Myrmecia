import { Router } from 'express';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { SharedArtifactStore } from '../agents/shared-artifact-store.js';
import { listArtifacts, getArtifact } from '../db/models/shared-artifact.js';
import { getExecutionArtifact, listExecutionArtifacts, type StoredExecutionArtifact } from '../db/models/execution-artifact.js';

function workspaceId(req: any): string {
  return req.authContext?.workspaceId || 'default';
}

function publicExecutionArtifact(artifact: StoredExecutionArtifact) {
  const { rootPath: _rootPath, content: _content, ...visible } = artifact;
  return visible;
}

function resolveArtifactFile(artifact: StoredExecutionArtifact): string | undefined {
  if (!artifact.rootPath || !artifact.relativePath) return undefined;
  const root = realpathSync(resolve(artifact.rootPath));
  const candidate = resolve(root, artifact.relativePath);
  if (!existsSync(candidate)) return undefined;
  const realCandidate = realpathSync(candidate);
  const rel = relative(root, realCandidate);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== realCandidate) return undefined;
  return realCandidate;
}

export function createArtifactRoutes(store: SharedArtifactStore): Router {
  const router = Router();

  router.get('/workbench', (req, res) => {
    const artifacts = listExecutionArtifacts({
      workspaceId: workspaceId(req),
      taskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined,
      executionId: typeof req.query.executionId === 'string' ? req.query.executionId : undefined,
      limit: Number(req.query.limit) || 100,
    });
    res.json(artifacts.map(publicExecutionArtifact));
  });

  router.get('/workbench/:id/preview', (req, res) => {
    const artifact = getExecutionArtifact(req.params.id);
    if (!artifact || artifact.workspaceId !== workspaceId(req)) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    res.setHeader('Content-Type', artifact.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${artifact.name.replace(/["\r\n]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (artifact.kind === 'html') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'");
    }
    if (artifact.content !== undefined) return res.send(artifact.content);

    try {
      const path = resolveArtifactFile(artifact);
      if (!path) return res.status(404).json({ error: 'Artifact file not found' });
      const stats = statSync(path);
      const maxPreviewBytes = ['image', 'video', 'audio', 'pdf'].includes(artifact.kind) ? 100 * 1024 * 1024 : 1024 * 1024;
      if (stats.size > maxPreviewBytes) {
        return res.status(413).json({ error: 'Artifact is too large to preview; download it instead' });
      }
      return res.sendFile(path, { dotfiles: 'deny' });
    } catch {
      return res.status(404).json({ error: 'Artifact file not found' });
    }
  });

  router.get('/workbench/:id/download', (req, res) => {
    const artifact = getExecutionArtifact(req.params.id);
    if (!artifact || artifact.workspaceId !== workspaceId(req)) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    if (artifact.content !== undefined) {
      res.setHeader('Content-Type', artifact.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.name.replace(/["\r\n]/g, '_')}"`);
      return res.send(artifact.content);
    }
    try {
      const path = resolveArtifactFile(artifact);
      if (!path) return res.status(404).json({ error: 'Artifact file not found' });
      return res.download(path, artifact.name);
    } catch {
      return res.status(404).json({ error: 'Artifact file not found' });
    }
  });

  router.post('/', (req, res) => {
    try {
      const { ownerId, name, content, readableBy, ttlHours } = req.body;
      if (!ownerId || !name || !content) {
        return res.status(400).json({ error: 'ownerId, name, and content are required' });
      }
      const artifact = store.publish({ ownerId, name, content, readableBy: readableBy || [], ttlHours });
      res.status(201).json({ ...artifact, content: undefined });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/', (req, res) => {
    const agentId = req.query.agentId as string;
    if (agentId) {
      const accessible = store.listAccessible(agentId);
      res.json(accessible.map(a => ({ ...a, content: undefined })));
    } else {
      const all = listArtifacts({ limit: parseInt(req.query.limit as string) || 50 });
      res.json(all.map(a => ({ ...a, content: undefined })));
    }
  });

  router.get('/:id', (req, res) => {
    const agentId = req.query.agentId as string;
    if (!agentId) {
      const art = getArtifact(req.params.id);
      if (!art) return res.status(404).json({ error: 'Artifact not found' });
      return res.json(art);
    }
    const content = store.read(req.params.id, agentId);
    if (content === null) {
      return res.status(403).json({ error: 'Access denied or artifact not found' });
    }
    const art = getArtifact(req.params.id)!;
    res.json({ ...art, content });
  });

  return router;
}
