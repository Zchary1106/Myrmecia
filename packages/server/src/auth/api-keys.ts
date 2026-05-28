/**
 * API Key Lifecycle Management
 *
 * - Create, revoke, validate, list, and rotate API keys
 * - Keys are SHA-256 hashed before storage
 * - Scopes control fine-grained access (e.g. 'read:tasks', 'write:agents')
 */

import { getDb } from '../db/database.js';
import { v4 as uuid } from 'uuid';
import { createHash, randomBytes } from 'crypto';
import { Router } from 'express';
import { logger } from '../lib/logger.js';

// ---------- Schema ----------

export const API_KEYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  expires_at DATETIME,
  last_used_at DATETIME,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`;

// ---------- Types ----------

export interface ApiKey {
  id: string;
  workspaceId: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ApiKeyWithPlaintext extends ApiKey {
  /** Only available at creation time */
  plaintext: string;
}

// ---------- Helpers ----------

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function generateKey(): string {
  return `af_${randomBytes(32).toString('hex')}`;
}

function rowToApiKey(row: any): ApiKey {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    scopes: JSON.parse(row.scopes || '[]'),
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
  };
}

// ---------- Functions ----------

export function initApiKeysSchema(): void {
  const db = getDb();
  db.exec(API_KEYS_SCHEMA);
}

export function createApiKey(opts: {
  workspaceId: string;
  name: string;
  scopes?: string[];
  expiresAt?: string;
}): ApiKeyWithPlaintext {
  initApiKeysSchema();
  const db = getDb();
  const id = uuid();
  const plaintext = generateKey();
  const keyHash = hashKey(plaintext);
  const scopes = JSON.stringify(opts.scopes ?? []);

  db.run(
    `INSERT INTO api_keys (id, workspace_id, name, key_hash, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, opts.workspaceId, opts.name, keyHash, scopes, opts.expiresAt ?? null,
  );

  const row = db.get('SELECT * FROM api_keys WHERE id = ?', id);
  return { ...rowToApiKey(row), plaintext };
}

export function revokeApiKey(id: string, workspaceId: string): boolean {
  initApiKeysSchema();
  const db = getDb();
  const result = db.run(
    `UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    id, workspaceId,
  );
  return result.changes > 0;
}

export function validateApiKey(plaintext: string): ApiKey | null {
  initApiKeysSchema();
  const db = getDb();
  const keyHash = hashKey(plaintext);
  const row = db.get(
    `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    keyHash,
  );
  if (!row) return null;

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  // Update last_used_at
  db.run(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`, row.id);

  return rowToApiKey(row);
}

export function listApiKeys(workspaceId: string): ApiKey[] {
  initApiKeysSchema();
  const db = getDb();
  const rows = db.all(
    `SELECT * FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    workspaceId,
  );
  return rows.map(rowToApiKey);
}

export function rotateApiKey(id: string, workspaceId: string): ApiKeyWithPlaintext | null {
  initApiKeysSchema();
  const db = getDb();
  const existing = db.get(
    `SELECT * FROM api_keys WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    id, workspaceId,
  );
  if (!existing) return null;

  // Revoke old key
  db.run(`UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?`, id);

  // Create new key with same metadata
  return createApiKey({
    workspaceId,
    name: existing.name,
    scopes: JSON.parse(existing.scopes || '[]'),
    expiresAt: existing.expires_at ?? undefined,
  });
}

// ---------- Routes ----------

export function createApiKeyRoutes(): Router {
  const router = Router();

  router.post('/', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || req.body.workspaceId || 'default';
      const { name, scopes, expiresAt } = req.body;
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const key = createApiKey({ workspaceId, name, scopes, expiresAt });
      res.status(201).json(key);
    } catch (err: any) {
      logger.error({ err }, 'Failed to create API key');
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || (req.query.workspaceId as string) || 'default';
      const keys = listApiKeys(workspaceId);
      res.json(keys);
    } catch (err: any) {
      logger.error({ err }, 'Failed to list API keys');
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || 'default';
      const revoked = revokeApiKey(req.params.id, workspaceId);
      if (!revoked) {
        res.status(404).json({ error: 'API key not found or already revoked' });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      logger.error({ err }, 'Failed to revoke API key');
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/rotate', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || 'default';
      const key = rotateApiKey(req.params.id, workspaceId);
      if (!key) {
        res.status(404).json({ error: 'API key not found or already revoked' });
        return;
      }
      res.json(key);
    } catch (err: any) {
      logger.error({ err }, 'Failed to rotate API key');
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
