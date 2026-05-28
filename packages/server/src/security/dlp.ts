/**
 * Data Loss Prevention (DLP) & Audit Logging
 *
 * DLP:
 * - Scans agent input/output for PII (emails, phone numbers, SSN, credit cards, API keys)
 * - Configurable actions: block, redact, warn
 * - Per-workspace DLP policies
 *
 * Audit:
 * - Immutable append-only audit log
 * - Records all significant operations with actor, target, timestamp
 * - Exportable for compliance reporting
 */

import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import { v4 as uuid } from 'uuid';
import { createHash } from 'crypto';
import { Router } from 'express';

// ---------- Types ----------

export type DLPAction = 'block' | 'redact' | 'warn' | 'allow';

export interface DLPViolation {
  type: string;
  pattern: string;
  value: string;  // redacted version
  position: number;
  action: DLPAction;
}

export interface DLPScanResult {
  clean: boolean;
  violations: DLPViolation[];
  redactedContent?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actorId: string;
  actorType: 'user' | 'agent' | 'system';
  action: string;
  resourceType: string;
  resourceId: string;
  workspaceId: string;
  metadata: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'blocked';
}

// ---------- PII Detection Patterns ----------

const PII_PATTERNS: Array<{ type: string; regex: RegExp; action: DLPAction }> = [
  { type: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, action: 'warn' },
  { type: 'phone_us', regex: /(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, action: 'warn' },
  { type: 'phone_cn', regex: /1[3-9]\d{9}/g, action: 'warn' },
  { type: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g, action: 'redact' },
  { type: 'credit_card', regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, action: 'redact' },
  { type: 'api_key', regex: /(?:sk|pk|api|key|token|secret)[-_]?[a-zA-Z0-9]{20,}/gi, action: 'block' },
  { type: 'aws_key', regex: /AKIA[0-9A-Z]{16}/g, action: 'block' },
  { type: 'private_key', regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, action: 'block' },
  { type: 'id_card_cn', regex: /\b\d{17}[\dXx]\b/g, action: 'redact' },
];

// ---------- DLP Scanner ----------

export function scanForPII(content: string, overrideAction?: DLPAction): DLPScanResult {
  const violations: DLPViolation[] = [];
  let redacted = content;

  for (const pattern of PII_PATTERNS) {
    const matches = content.matchAll(pattern.regex);
    for (const match of matches) {
      const action = overrideAction || pattern.action;
      const redactedValue = match[0].slice(0, 3) + '***' + match[0].slice(-2);
      violations.push({
        type: pattern.type,
        pattern: pattern.regex.source,
        value: redactedValue,
        position: match.index || 0,
        action,
      });

      if (action === 'redact') {
        redacted = redacted.replace(match[0], `[REDACTED:${pattern.type}]`);
      }
    }
  }

  const hasBlocking = violations.some(v => v.action === 'block');

  return {
    clean: violations.length === 0,
    violations,
    redactedContent: hasBlocking ? undefined : redacted,
  };
}

// ---------- DLP Middleware for Agent I/O ----------

export function dlpCheck(content: string, context: { agentId?: string; taskId?: string; workspaceId?: string }): DLPScanResult {
  const result = scanForPII(content);

  if (!result.clean) {
    const blocking = result.violations.filter(v => v.action === 'block');
    const redacting = result.violations.filter(v => v.action === 'redact');

    if (blocking.length > 0) {
      logger.warn({
        types: blocking.map(v => v.type),
        ...context,
      }, 'DLP: blocked content with sensitive data');

      // Record audit entry
      recordAudit({
        actorId: context.agentId || 'system',
        actorType: context.agentId ? 'agent' : 'system',
        action: 'dlp.block',
        resourceType: 'content',
        resourceId: context.taskId || 'unknown',
        workspaceId: context.workspaceId || 'default',
        metadata: { violationTypes: blocking.map(v => v.type), count: blocking.length },
        outcome: 'blocked',
      });
    }

    if (redacting.length > 0) {
      logger.info({
        types: redacting.map(v => v.type),
        ...context,
      }, 'DLP: redacted sensitive data');
    }
  }

  return result;
}

// ---------- Audit Log ----------

export const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  metadata JSON NOT NULL DEFAULT '{}',
  outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success','failure','blocked')),
  prev_hash TEXT NOT NULL DEFAULT '',
  entry_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace ON audit_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
`;

export function recordAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
  const db = getDb();
  const id = `audit_${uuid().slice(0, 12)}`;
  const timestamp = new Date().toISOString();

  // Get previous entry's hash for chain integrity
  const lastEntry = db.get('SELECT entry_hash FROM audit_log ORDER BY rowid DESC LIMIT 1') as { entry_hash: string } | undefined;
  const prevHash = lastEntry?.entry_hash || '0000000000000000000000000000000000000000000000000000000000000000';

  // Compute hash of this entry: SHA256(prev_hash + id + timestamp + action + actor + resource + outcome)
  const payload = `${prevHash}|${id}|${timestamp}|${entry.action}|${entry.actorId}|${entry.resourceType}:${entry.resourceId}|${entry.outcome}`;
  const entryHash = createHash('sha256').update(payload).digest('hex');

  db.run(
    `INSERT INTO audit_log (id, timestamp, actor_id, actor_type, action, resource_type, resource_id, workspace_id, metadata, outcome, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, timestamp, entry.actorId, entry.actorType, entry.action,
    entry.resourceType, entry.resourceId, entry.workspaceId,
    JSON.stringify(entry.metadata), entry.outcome, prevHash, entryHash
  );

  return { id, timestamp, ...entry };
}

export function queryAuditLog(filter: {
  workspaceId?: string;
  actorId?: string;
  action?: string;
  resourceType?: string;
  since?: string;
  limit?: number;
}): AuditEntry[] {
  const db = getDb();
  let sql = 'SELECT * FROM audit_log';
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
  if (filter.actorId) { conditions.push('actor_id = ?'); params.push(filter.actorId); }
  if (filter.action) { conditions.push('action = ?'); params.push(filter.action); }
  if (filter.resourceType) { conditions.push('resource_type = ?'); params.push(filter.resourceType); }
  if (filter.since) { conditions.push('timestamp > ?'); params.push(filter.since); }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY timestamp DESC';
  sql += ` LIMIT ?`;
  params.push(filter.limit || 100);

  return db.all(sql, ...params).map((row: any) => ({
    id: row.id,
    timestamp: row.timestamp,
    actorId: row.actor_id,
    actorType: row.actor_type,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    workspaceId: row.workspace_id,
    metadata: JSON.parse(row.metadata || '{}'),
    outcome: row.outcome,
  }));
}

// ---------- Routes ----------

export function createAuditRoutes(): Router {
  const router = Router();

  // GET /audit — query audit log
  router.get('/', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId;
    const entries = queryAuditLog({
      workspaceId,
      actorId: req.query.actorId as string,
      action: req.query.action as string,
      resourceType: req.query.resourceType as string,
      since: req.query.since as string,
      limit: parseInt(req.query.limit as string) || 100,
    });
    res.json(entries);
  });

  // POST /audit/dlp-scan — manually scan content
  router.post('/dlp-scan', (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: { message: 'content required' } });
    const result = scanForPII(content);
    res.json(result);
  });

  // GET /audit/verify — verify hash chain integrity
  router.get('/verify', (_req, res) => {
    const db = getDb();
    const rows = db.all('SELECT id, timestamp, action, actor_id, resource_type, resource_id, outcome, prev_hash, entry_hash FROM audit_log ORDER BY rowid ASC') as any[];

    let expectedPrev = '0000000000000000000000000000000000000000000000000000000000000000';
    let valid = true;
    let brokenAt: string | null = null;

    for (const row of rows) {
      // Verify prev_hash matches chain
      if (row.prev_hash !== expectedPrev) {
        valid = false;
        brokenAt = row.id;
        break;
      }
      // Verify entry_hash
      const payload = `${row.prev_hash}|${row.id}|${row.timestamp}|${row.action}|${row.actor_id}|${row.resource_type}:${row.resource_id}|${row.outcome}`;
      const computed = createHash('sha256').update(payload).digest('hex');
      if (computed !== row.entry_hash) {
        valid = false;
        brokenAt = row.id;
        break;
      }
      expectedPrev = row.entry_hash;
    }

    res.json({
      valid,
      entriesChecked: rows.length,
      ...(brokenAt ? { brokenAt } : {}),
    });
  });

  return router;
}
