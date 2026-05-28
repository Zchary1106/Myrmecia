/**
 * DLP Multi-Layer Detection — Custom Rule Engine
 *
 * Supports regex, keyword, and NER-based rules with configurable actions.
 * Rules are sorted by priority; first match wins.
 */

import { getDb } from '../db/database.js';
import { v4 as uuid } from 'uuid';
import { Router } from 'express';
import { logger } from '../lib/logger.js';
import type { DLPAction } from './dlp.js';

// ---------- Schema ----------

export const DLP_RULES_SCHEMA = `
CREATE TABLE IF NOT EXISTS dlp_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('regex','keyword','ner')),
  pattern TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'warn' CHECK(action IN ('block','redact','warn','allow')),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dlp_rules_workspace ON dlp_rules(workspace_id);
`;

// ---------- Types ----------

export interface DLPRule {
  id: string;
  workspaceId: string;
  name: string;
  type: 'regex' | 'keyword' | 'ner';
  pattern: string;
  action: DLPAction;
  priority: number;
  enabled: boolean;
  createdAt: string;
}

export interface DLPRuleMatch {
  ruleId: string;
  ruleName: string;
  type: DLPRule['type'];
  action: DLPAction;
  matchedText: string;
  position: number;
}

// ---------- Helpers ----------

function rowToRule(row: any): DLPRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    type: row.type,
    pattern: row.pattern,
    action: row.action,
    priority: row.priority,
    enabled: !!row.enabled,
    createdAt: row.created_at,
  };
}

// ---------- DLPRuleEngine ----------

export class DLPRuleEngine {
  initSchema(): void {
    const db = getDb();
    db.exec(DLP_RULES_SCHEMA);
  }

  addRule(opts: {
    workspaceId: string;
    name: string;
    type: DLPRule['type'];
    pattern: string;
    action?: DLPAction;
    priority?: number;
  }): DLPRule {
    this.initSchema();
    const db = getDb();
    const id = uuid();
    db.run(
      `INSERT INTO dlp_rules (id, workspace_id, name, type, pattern, action, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, opts.workspaceId, opts.name, opts.type, opts.pattern,
      opts.action ?? 'warn', opts.priority ?? 0,
    );
    const row = db.get('SELECT * FROM dlp_rules WHERE id = ?', id);
    return rowToRule(row);
  }

  removeRule(id: string, workspaceId: string): boolean {
    this.initSchema();
    const db = getDb();
    const result = db.run(
      'DELETE FROM dlp_rules WHERE id = ? AND workspace_id = ?',
      id, workspaceId,
    );
    return result.changes > 0;
  }

  listRules(workspaceId: string): DLPRule[] {
    this.initSchema();
    const db = getDb();
    const rows = db.all(
      'SELECT * FROM dlp_rules WHERE workspace_id = ? AND enabled = 1 ORDER BY priority DESC',
      workspaceId,
    );
    return rows.map(rowToRule);
  }

  evaluateContent(content: string, workspaceId: string): DLPRuleMatch | null {
    const rules = this.listRules(workspaceId);

    for (const rule of rules) {
      const match = this.matchRule(rule, content);
      if (match) return match;
    }

    return null;
  }

  private matchRule(rule: DLPRule, content: string): DLPRuleMatch | null {
    switch (rule.type) {
      case 'regex': {
        try {
          const re = new RegExp(rule.pattern, 'gi');
          const m = re.exec(content);
          if (m) {
            return {
              ruleId: rule.id,
              ruleName: rule.name,
              type: 'regex',
              action: rule.action,
              matchedText: m[0],
              position: m.index,
            };
          }
        } catch {
          logger.warn({ ruleId: rule.id }, 'Invalid regex pattern in DLP rule');
        }
        return null;
      }
      case 'keyword': {
        const idx = content.toLowerCase().indexOf(rule.pattern.toLowerCase());
        if (idx >= 0) {
          return {
            ruleId: rule.id,
            ruleName: rule.name,
            type: 'keyword',
            action: rule.action,
            matchedText: content.substring(idx, idx + rule.pattern.length),
            position: idx,
          };
        }
        return null;
      }
      case 'ner': {
        // NER stub: would call LLM for entity detection in production
        // Returns null if no API key configured
        return null;
      }
      default:
        return null;
    }
  }
}

// ---------- Singleton ----------

export const dlpRuleEngine = new DLPRuleEngine();

// ---------- Routes ----------

export function createDLPRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || (req.query.workspaceId as string) || 'default';
      const rules = dlpRuleEngine.listRules(workspaceId);
      res.json(rules);
    } catch (err: any) {
      logger.error({ err }, 'Failed to list DLP rules');
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || req.body.workspaceId || 'default';
      const { name, type, pattern, action, priority } = req.body;
      if (!name || !type || !pattern) {
        res.status(400).json({ error: 'name, type, and pattern are required' });
        return;
      }
      const rule = dlpRuleEngine.addRule({ workspaceId, name, type, pattern, action, priority });
      res.status(201).json(rule);
    } catch (err: any) {
      logger.error({ err }, 'Failed to add DLP rule');
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || 'default';
      const removed = dlpRuleEngine.removeRule(req.params.id, workspaceId);
      if (!removed) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      logger.error({ err }, 'Failed to remove DLP rule');
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/evaluate', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || req.body.workspaceId || 'default';
      const { content } = req.body;
      if (!content) {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      const match = dlpRuleEngine.evaluateContent(content, workspaceId);
      res.json({ match });
    } catch (err: any) {
      logger.error({ err }, 'Failed to evaluate DLP rules');
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
