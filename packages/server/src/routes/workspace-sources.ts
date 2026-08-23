import { Router } from 'express';
import express from 'express';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, join, normalize, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, parseBody, sendError } from './http.js';

const execFileAsync = promisify(execFile);
const sessions = new Map<string, { root: string; name: string; files: number }>();

function workspaceRoot(): string {
  return resolve(process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd(), '.agent-factory', 'imported-workspaces');
}

function safeRelativePath(value: string): string {
  const candidate = normalize(value.replaceAll('\\', '/'));
  if (!candidate || candidate === '.' || candidate.startsWith('..') || candidate.startsWith('/') || candidate.includes('\0')) {
    throw new HttpError(400, 'INVALID_WORKSPACE_FILE', 'Workspace file path is invalid');
  }
  return candidate;
}

function validateRemoteUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'Remote repository URL is invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'Only HTTP(S) Git repository URLs are supported');
  }
  if (parsed.username || parsed.password || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'Remote repository URL is not allowed');
  }
  return parsed.toString();
}

export function createWorkspaceSourceRoutes(): Router {
  const router = Router();

  router.post('/local', (req, res) => {
    try {
      const body = req.body as { name?: unknown };
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'local-workspace';
      const id = `local_${randomBytes(8).toString('hex')}`;
      const root = join(workspaceRoot(), id);
      sessions.set(id, { root, name, files: 0 });
      res.status(201).json({ id, name });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/local/:id/file', express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
    try {
      const session = sessions.get(req.params.id);
      if (!session) throw new HttpError(404, 'WORKSPACE_IMPORT_NOT_FOUND', 'Workspace import session not found');
      const relativePath = safeRelativePath(String(req.headers['x-workspace-file-path'] || ''));
      const destination = resolve(session.root, relativePath);
      if (relative(session.root, destination).startsWith('..')) {
        throw new HttpError(400, 'INVALID_WORKSPACE_FILE', 'Workspace file path escapes the workspace');
      }
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'INVALID_WORKSPACE_FILE', 'Workspace file payload is missing');
      await mkdir(resolve(destination, '..'), { recursive: true });
      await writeFile(destination, req.body);
      session.files += 1;
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/local/:id/complete', async (req, res) => {
    try {
      const session = sessions.get(req.params.id);
      if (!session) throw new HttpError(404, 'WORKSPACE_IMPORT_NOT_FOUND', 'Workspace import session not found');
      if (session.files === 0) throw new HttpError(400, 'EMPTY_WORKSPACE', 'Choose a folder containing at least one file');
      sessions.delete(req.params.id);
      res.status(201).json({ configured: true, path: session.root, name: session.name, source: 'local', files: session.files });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/local/:id', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (session) {
      sessions.delete(req.params.id);
      await rm(session.root, { recursive: true, force: true });
    }
    res.json({ ok: true });
  });

  router.post('/remote', async (req, res) => {
    let root: string | undefined;
    try {
      const body = req.body as { url?: unknown; branch?: unknown };
      if (typeof body.url !== 'string' || !body.url.trim()) throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'Repository URL is required');
      const url = validateRemoteUrl(body.url.trim());
      const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : undefined;
      if (branch && !/^[A-Za-z0-9._/-]{1,200}$/.test(branch)) throw new HttpError(400, 'INVALID_REMOTE_REPOSITORY', 'Branch name is invalid');

      const id = `remote_${randomBytes(8).toString('hex')}`;
      root = join(workspaceRoot(), id);
      await mkdir(workspaceRoot(), { recursive: true });
      const args = ['clone', '--depth', '1'];
      if (branch) args.push('--branch', branch);
      args.push(url, root);
      await execFileAsync('git', args, { timeout: 300_000, maxBuffer: 2 * 1024 * 1024 });
      res.status(201).json({ configured: true, path: root, name: basename(root), source: 'remote', repository: url, branch });
    } catch (err: any) {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
      sendError(res, err instanceof HttpError ? err : new HttpError(400, 'REMOTE_CLONE_FAILED', err?.message || 'Unable to clone repository'));
    }
  });

  return router;
}
