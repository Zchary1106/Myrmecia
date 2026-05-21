# Batch B: Runtime Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add skill hot-reload (file watching + API update) and a cost tracking dashboard (backend API + React frontend with charts).

**Architecture:** Two independent modules. SkillWatcher monitors `agents/*.md` via `fs.watch` with debounce, syncs changes to DB, and emits events. Cost dashboard adds aggregation API endpoints on existing `model_usage_stats` table plus a new React page with Recharts visualizations. Both follow the existing EventBus + loosely-coupled pattern.

**Tech Stack:** TypeScript, fs.watch, Recharts, Tailwind CSS, existing Express/SQLite/Zustand patterns.

---

### Task 1: Install Recharts dependency

**Files:**
- Modify: `packages/dashboard/package.json`

- [ ] **Step 1: Install recharts**

```bash
cd packages/dashboard && pnpm add recharts
```

- [ ] **Step 2: Commit**

```bash
git add packages/dashboard/package.json pnpm-lock.yaml
git commit -m "chore: add recharts dependency for cost dashboard"
```

---

### Task 2: Skill Watcher

**Files:**
- Create: `packages/server/src/skills/skill-watcher.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/skills/__tests__/skill-watcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillWatcher } from '../skill-watcher.js';

vi.mock('../../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../../db/models/skill.js', () => ({
  checksumSkillContent: vi.fn((c: string) => `checksum_${c.length}`),
  getSkillVersionByChecksum: vi.fn(() => null),
  upsertSkill: vi.fn((d: any) => ({ id: d.id, name: d.name })),
  createSkillVersion: vi.fn((d: any) => ({ id: 'sv_1', skillId: d.skillId, version: 1 })),
  listSkillAssignments: vi.fn(() => []),
  assignSkillVersionToAgent: vi.fn(),
  getLatestPublishedSkillForSource: vi.fn(() => null),
}));
vi.mock('../../db/models/notification.js', () => ({
  createNotification: vi.fn((d: any) => ({ id: 'notif_1', ...d })),
}));

import { checksumSkillContent, getSkillVersionByChecksum } from '../../db/models/skill.js';

describe('SkillWatcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('syncFile skips when checksum matches existing version', () => {
    (getSkillVersionByChecksum as any).mockReturnValue({ id: 'sv_existing' });
    const watcher = new SkillWatcher('/fake/agents');
    const result = watcher.syncFile('test.md', '# Test Skill\nContent here');
    expect(result).toBe(false);
  });

  it('syncFile creates new version when checksum differs', () => {
    (getSkillVersionByChecksum as any).mockReturnValue(null);
    const watcher = new SkillWatcher('/fake/agents');
    const result = watcher.syncFile('test.md', '# Test Skill\nNew content');
    expect(result).toBe(true);
  });

  it('isIgnored returns true for paths in ignore set', () => {
    const watcher = new SkillWatcher('/fake/agents');
    watcher.addToIgnoreSet('/fake/agents/test.md');
    expect(watcher.isIgnored('/fake/agents/test.md')).toBe(true);
  });

  it('isIgnored returns false after expiry', async () => {
    const watcher = new SkillWatcher('/fake/agents');
    watcher.addToIgnoreSet('/fake/agents/test.md', 50);
    await new Promise(r => setTimeout(r, 100));
    expect(watcher.isIgnored('/fake/agents/test.md')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/skills/__tests__/skill-watcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SkillWatcher**

Create `packages/server/src/skills/skill-watcher.ts`:

```typescript
import { watch, readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { eventBus } from '../events/event-bus.js';
import {
  checksumSkillContent,
  getSkillVersionByChecksum,
  upsertSkill,
  createSkillVersion,
  listSkillAssignments,
  assignSkillVersionToAgent,
} from '../db/models/skill.js';
import { createNotification } from '../db/models/notification.js';
import { logger } from '../lib/logger.js';

export class SkillWatcher {
  private watchDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private ignoreSet = new Map<string, number>(); // path → expiry timestamp
  private debounceMs = 500;

  constructor(watchDir: string) {
    this.watchDir = watchDir;
  }

  start(): void {
    if (!existsSync(this.watchDir)) {
      logger.warn({ dir: this.watchDir }, 'Skill watch directory does not exist');
      return;
    }

    this.watcher = watch(this.watchDir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;

      const fullPath = join(this.watchDir, filename);
      if (this.isIgnored(fullPath)) return;

      // Debounce
      const existing = this.debounceTimers.get(filename);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(filename, setTimeout(() => {
        this.debounceTimers.delete(filename);
        this.handleFileChange(filename);
      }, this.debounceMs));
    });

    logger.info({ dir: this.watchDir }, 'Skill watcher started');
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    logger.info('Skill watcher stopped');
  }

  /** Add a path to the ignore set (for API writeback) */
  addToIgnoreSet(fullPath: string, durationMs: number = 2000): void {
    this.ignoreSet.set(fullPath, Date.now() + durationMs);
  }

  /** Check if a path is in the ignore set */
  isIgnored(fullPath: string): boolean {
    const expiry = this.ignoreSet.get(fullPath);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.ignoreSet.delete(fullPath);
      return false;
    }
    return true;
  }

  /** Sync a single file's content to DB. Returns true if a new version was created. */
  syncFile(filename: string, content: string): boolean {
    const id = basename(filename, '.md');
    const sourcePath = `agents/${filename}`;

    const titleMatch = content.match(/^#\s+(.+)/m);
    const name = titleMatch ? titleMatch[1].trim() : id;

    const skill = upsertSkill({ id, name, description: `Imported from ${sourcePath}`, sourcePath });
    const checksum = checksumSkillContent(content);
    const existing = getSkillVersionByChecksum(skill.id, checksum);

    if (existing) return false;

    const version = createSkillVersion({
      skillId: skill.id,
      content,
      status: 'published',
      changelog: 'Hot-reloaded from file change',
      createdBy: 'system',
      publishedBy: 'system',
    });

    // Update agent assignments
    const assignments = listSkillAssignments({ skillId: skill.id });
    for (const a of assignments) {
      assignSkillVersionToAgent(a.agentId, version.id);
    }

    eventBus.emit('skill:updated', { skillId: skill.id, skillVersionId: version.id, source: 'file' });

    createNotification({
      type: 'task_complete' as any,
      title: 'Skill Updated',
      message: `Skill "${name}" hot-reloaded from file change`,
    });

    logger.info({ skillId: skill.id, version: version.version }, `Skill hot-reloaded: ${name}`);
    return true;
  }

  private handleFileChange(filename: string): void {
    const fullPath = join(this.watchDir, filename);
    if (!existsSync(fullPath)) return;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      this.syncFile(filename, content);
    } catch (err: any) {
      logger.warn({ filename, error: err.message }, 'Failed to hot-reload skill');
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/skills/__tests__/skill-watcher.test.ts`
Expected: PASS

- [ ] **Step 5: Register in index.ts**

In `packages/server/src/index.ts`, add import:
```typescript
import { SkillWatcher } from './skills/skill-watcher.js';
```

After `syncBuiltinSkills(...)` call, add:
```typescript
  // Initialize skill watcher for hot-reload
  const skillWatcher = new SkillWatcher(join(__dirname, '../../../agents'));
  skillWatcher.start();
  logger.info('Skill watcher active (hot-reload)');
```

In the `shutdown` function, before `closeDb()`, add:
```typescript
    skillWatcher.stop();
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/skills/skill-watcher.ts packages/server/src/skills/__tests__/skill-watcher.test.ts packages/server/src/index.ts
git commit -m "feat: add skill hot-reload via file watcher"
```

---

### Task 3: Skill API content update endpoint

**Files:**
- Modify: `packages/server/src/routes/skills.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/routes/__tests__/skills-content.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Test the content update schema validation logic
describe('PUT /skills/:id/content validation', () => {
  it('rejects empty content', () => {
    const { z } = require('zod');
    const schema = z.object({ content: z.string().min(1) });
    expect(() => schema.parse({ content: '' })).toThrow();
  });

  it('accepts valid content', () => {
    const { z } = require('zod');
    const schema = z.object({ content: z.string().min(1) });
    const result = schema.parse({ content: '# My Skill\nDo things' });
    expect(result.content).toBe('# My Skill\nDo things');
  });
});
```

- [ ] **Step 2: Add PUT /:id/content endpoint**

In `packages/server/src/routes/skills.ts`, add this route before the `return router;` line:

```typescript
  const updateContentSchema = z.object({
    content: z.string().min(1),
  });

  router.put('/:id/content', async (req, res) => {
    try {
      const skill = getSkill(req.params.id);
      if (!skill) return notFound('SKILL_NOT_FOUND', 'Skill not found');

      const actor = requireOperatorRole(req, 'skill.content.update', ['admin', 'operator']);
      const body = parseBody(updateContentSchema, req);

      const checksum = checksumSkillContent(body.content);
      const existing = getSkillVersionByChecksum(req.params.id, checksum);
      if (existing) {
        return res.json({ message: 'Content unchanged', version: existing });
      }

      const version = createSkillVersion({
        skillId: req.params.id,
        content: body.content,
        status: 'published',
        changelog: 'Updated via API',
        createdBy: actor.id,
        publishedBy: actor.id,
      });

      // Update agent assignments
      const assignments = listSkillAssignments({ skillId: req.params.id });
      for (const a of assignments) {
        assignSkillVersionToAgent(a.agentId, version.id);
      }

      // Write back to file if skill has a sourcePath
      if (skill.sourcePath) {
        try {
          const { writeFileSync } = await import('fs');
          const { join, dirname } = await import('path');
          const { fileURLToPath } = await import('url');
          const __dirname = dirname(fileURLToPath(import.meta.url));
          const filePath = join(__dirname, '../../../..', skill.sourcePath);
          // Signal the watcher to ignore this write
          const { skillWatcher } = await import('../skills/skill-watcher-instance.js');
          if (skillWatcher) {
            skillWatcher.addToIgnoreSet(filePath);
          }
          writeFileSync(filePath, body.content, 'utf-8');
        } catch (err: any) {
          // Non-fatal: DB is the source of truth
        }
      }

      eventBus.emit('skill:updated', { skillId: req.params.id, skillVersionId: version.id, source: 'api' });
      createOperatorAction({
        action: 'skill.content.update',
        actor,
        targetType: 'skill',
        targetId: req.params.id,
        metadata: { skillVersionId: version.id, checksum: version.checksum },
      });

      res.json(version);
    } catch (err) {
      sendError(res, err);
    }
  });
```

Also add these imports at the top of the file (if not already present):
```typescript
import { checksumSkillContent, getSkillVersionByChecksum } from '../db/models/skill.js';
```

- [ ] **Step 3: Create skill-watcher-instance.ts**

Create `packages/server/src/skills/skill-watcher-instance.ts` to share the watcher instance:

```typescript
import type { SkillWatcher } from './skill-watcher.js';

/** Shared watcher instance, set by index.ts at startup */
export let skillWatcher: SkillWatcher | null = null;

export function setSkillWatcher(watcher: SkillWatcher): void {
  skillWatcher = watcher;
}
```

Update `packages/server/src/index.ts` — after creating the watcher, add:
```typescript
import { setSkillWatcher } from './skills/skill-watcher-instance.js';

// After: const skillWatcher = new SkillWatcher(...)
setSkillWatcher(skillWatcher);
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/skills.ts packages/server/src/routes/__tests__/skills-content.test.ts packages/server/src/skills/skill-watcher-instance.ts packages/server/src/index.ts
git commit -m "feat: add PUT /skills/:id/content endpoint with file writeback"
```

---

### Task 4: Cost Dashboard API

**Files:**
- Create: `packages/server/src/routes/cost-dashboard.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/routes/__tests__/cost-dashboard.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildSummaryQuery, buildByAgentQuery, buildByModelQuery } from '../cost-dashboard.js';

describe('cost-dashboard query builders', () => {
  it('buildSummaryQuery returns valid SQL for day period', () => {
    const { sql, params } = buildSummaryQuery({ period: 'day' });
    expect(sql).toContain('model_usage_stats');
    expect(sql).toContain('GROUP BY');
    expect(params).toBeDefined();
  });

  it('buildByAgentQuery includes agent_id grouping', () => {
    const { sql } = buildByAgentQuery({ period: 'week' });
    expect(sql).toContain('agent_id');
    expect(sql).toContain('GROUP BY');
  });

  it('buildByModelQuery includes model_id grouping', () => {
    const { sql } = buildByModelQuery({ period: 'month' });
    expect(sql).toContain('model_id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/routes/__tests__/cost-dashboard.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement cost-dashboard.ts**

Create `packages/server/src/routes/cost-dashboard.ts`:

```typescript
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { getAgent, listAgents } from '../db/models/agent.js';

// ---------- Query Builders ----------

function periodToDateTrunc(period: string): string {
  switch (period) {
    case 'day': return "strftime('%Y-%m-%d', created_at)";
    case 'week': return "strftime('%Y-W%W', created_at)";
    case 'month': return "strftime('%Y-%m', created_at)";
    default: return "strftime('%Y-%m-%d', created_at)";
  }
}

function sinceDefault(period: string): string {
  const now = new Date();
  switch (period) {
    case 'day': return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case 'week': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case 'month': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    default: return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

export function buildSummaryQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  const sql = `
    SELECT
      ${dateTrunc} as date,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COUNT(*) as request_count
    FROM model_usage_stats
    WHERE created_at >= ? AND created_at < ?
    GROUP BY date
    ORDER BY date ASC
  `;
  return { sql, params: [since, until] };
}

export function buildByAgentQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  const sql = `
    SELECT
      agent_id,
      ${dateTrunc} as date,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM model_usage_stats
    WHERE created_at >= ? AND created_at < ?
    GROUP BY agent_id, date
    ORDER BY agent_id, date ASC
  `;
  return { sql, params: [since, until] };
}

export function buildByModelQuery(opts: { period: string; since?: string; until?: string }) {
  const dateTrunc = periodToDateTrunc(opts.period);
  const since = opts.since || sinceDefault(opts.period);
  const until = opts.until || new Date().toISOString();
  const sql = `
    SELECT
      model_id,
      ${dateTrunc} as date,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM model_usage_stats
    WHERE created_at >= ? AND created_at < ?
    GROUP BY model_id, date
    ORDER BY model_id, date ASC
  `;
  return { sql, params: [since, until] };
}

// ---------- Routes ----------

export function createCostDashboardRoutes(): Router {
  const router = Router();

  // GET /summary
  router.get('/summary', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildSummaryQuery({
      period,
      since: req.query.since as string,
      until: req.query.until as string,
    });
    const db = getDb();
    const rows = db.all(sql, ...params);

    const totals = rows.reduce(
      (acc, r: any) => ({
        totalInputTokens: acc.totalInputTokens + r.input_tokens,
        totalOutputTokens: acc.totalOutputTokens + r.output_tokens,
        totalCostUSD: acc.totalCostUSD + r.cost_usd,
        requestCount: acc.requestCount + r.request_count,
      }),
      { totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, requestCount: 0 }
    );

    res.json({
      period,
      ...totals,
      dataPoints: rows.map((r: any) => ({
        date: r.date,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUSD: r.cost_usd,
        requestCount: r.request_count,
      })),
    });
  });

  // GET /by-agent
  router.get('/by-agent', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildByAgentQuery({
      period,
      since: req.query.since as string,
      until: req.query.until as string,
    });
    const db = getDb();
    const rows = db.all(sql, ...params) as any[];

    const agentMap = new Map<string, { dataPoints: any[]; totalCostUSD: number }>();
    for (const r of rows) {
      if (!agentMap.has(r.agent_id)) {
        agentMap.set(r.agent_id, { dataPoints: [], totalCostUSD: 0 });
      }
      const entry = agentMap.get(r.agent_id)!;
      entry.dataPoints.push({
        date: r.date,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUSD: r.cost_usd,
      });
      entry.totalCostUSD += r.cost_usd;
    }

    const agents = Array.from(agentMap.entries()).map(([agentId, data]) => {
      const agent = getAgent(agentId);
      return {
        agentId,
        agentName: agent?.name || agentId,
        ...data,
      };
    });

    res.json({ agents });
  });

  // GET /by-task
  router.get('/by-task', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const db = getDb();
    const rows = db.all(`
      SELECT
        m.task_id,
        t.title,
        m.agent_id,
        COALESCE(SUM(m.input_tokens), 0) as input_tokens,
        COALESCE(SUM(m.output_tokens), 0) as output_tokens,
        COALESCE(SUM(m.cost_usd), 0) as cost_usd,
        MAX(m.created_at) as completed_at
      FROM model_usage_stats m
      LEFT JOIN tasks t ON t.id = m.task_id
      WHERE m.task_id IS NOT NULL
      GROUP BY m.task_id
      ORDER BY completed_at DESC
      LIMIT ?
    `, limit) as any[];

    res.json({
      tasks: rows.map(r => ({
        taskId: r.task_id,
        title: r.title || r.task_id,
        agentId: r.agent_id,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUSD: r.cost_usd,
        completedAt: r.completed_at,
      })),
    });
  });

  // GET /by-model
  router.get('/by-model', (req, res) => {
    const period = (req.query.period as string) || 'day';
    const { sql, params } = buildByModelQuery({
      period,
      since: req.query.since as string,
      until: req.query.until as string,
    });
    const db = getDb();
    const rows = db.all(sql, ...params) as any[];

    const modelMap = new Map<string, { dataPoints: any[]; totalCostUSD: number }>();
    let grandTotal = 0;
    for (const r of rows) {
      if (!modelMap.has(r.model_id)) {
        modelMap.set(r.model_id, { dataPoints: [], totalCostUSD: 0 });
      }
      const entry = modelMap.get(r.model_id)!;
      entry.dataPoints.push({
        date: r.date,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUSD: r.cost_usd,
      });
      entry.totalCostUSD += r.cost_usd;
      grandTotal += r.cost_usd;
    }

    const models = Array.from(modelMap.entries()).map(([modelId, data]) => ({
      modelId,
      ...data,
      percentOfTotal: grandTotal > 0 ? (data.totalCostUSD / grandTotal) * 100 : 0,
    }));

    res.json({ models });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/routes/__tests__/cost-dashboard.test.ts`
Expected: PASS

- [ ] **Step 5: Mount routes in index.ts**

In `packages/server/src/index.ts`, add import:
```typescript
import { createCostDashboardRoutes } from './routes/cost-dashboard.js';
```

Add route mounting (near other `/api/v1/` routes):
```typescript
  app.use('/api/v1/cost-dashboard', createCostDashboardRoutes());
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/cost-dashboard.ts packages/server/src/routes/__tests__/cost-dashboard.test.ts packages/server/src/index.ts
git commit -m "feat: add cost dashboard API endpoints"
```

---

### Task 5: Cost Dashboard Frontend — Summary Cards

**Files:**
- Create: `packages/dashboard/src/components/cost/CostSummaryCards.tsx`

- [ ] **Step 1: Create CostSummaryCards component**

Create `packages/dashboard/src/components/cost/CostSummaryCards.tsx`:

```tsx
interface SummaryData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  requestCount: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function CostSummaryCards({ data }: { data: SummaryData | null }) {
  const cards = [
    {
      label: 'Total Tokens',
      value: data ? formatTokens(data.totalInputTokens + data.totalOutputTokens) : '—',
      sub: data ? `${formatTokens(data.totalInputTokens)} in / ${formatTokens(data.totalOutputTokens)} out` : '',
      icon: '🔤',
    },
    {
      label: 'Requests',
      value: data ? data.requestCount.toLocaleString() : '—',
      sub: '',
      icon: '📊',
    },
    {
      label: 'Total Cost',
      value: data ? `$${data.totalCostUSD.toFixed(2)}` : '—',
      sub: '',
      icon: '💰',
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-4">
      {cards.map(c => (
        <div key={c.label} className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 text-sm text-gray-400 mb-1">
            <span>{c.icon}</span>
            {c.label}
          </div>
          <div className="text-2xl font-bold">{c.value}</div>
          {c.sub && <div className="text-xs text-gray-500 mt-1">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/dashboard/src/components/cost/CostSummaryCards.tsx
git commit -m "feat: add CostSummaryCards component"
```

---

### Task 6: Cost Dashboard Frontend — Charts

**Files:**
- Create: `packages/dashboard/src/components/cost/AgentCostChart.tsx`
- Create: `packages/dashboard/src/components/cost/ModelDistChart.tsx`
- Create: `packages/dashboard/src/components/cost/TaskCostTable.tsx`

- [ ] **Step 1: Create AgentCostChart**

Create `packages/dashboard/src/components/cost/AgentCostChart.tsx`:

```tsx
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';

interface AgentData {
  agentId: string;
  agentName: string;
  dataPoints: { date: string; costUSD: number }[];
  totalCostUSD: number;
}

const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1', '#f97316'];

export function AgentCostChart({ agents }: { agents: AgentData[] }) {
  if (!agents.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center text-gray-500">
        No agent cost data available
      </div>
    );
  }

  // Merge all agents' data points into a unified timeline
  const dateSet = new Set<string>();
  for (const a of agents) {
    for (const dp of a.dataPoints) dateSet.add(dp.date);
  }
  const dates = Array.from(dateSet).sort();

  const chartData = dates.map(date => {
    const row: Record<string, any> = { date };
    for (const a of agents) {
      const dp = a.dataPoints.find(d => d.date === date);
      row[a.agentId] = dp?.costUSD ?? 0;
    }
    return row;
  });

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">Agent Cost Trend</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#888' }} />
          <YAxis tick={{ fontSize: 11, fill: '#888' }} tickFormatter={v => `$${v}`} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
            formatter={(value: number) => [`$${value.toFixed(3)}`, '']}
          />
          <Legend />
          {agents.map((a, i) => (
            <Line
              key={a.agentId}
              type="monotone"
              dataKey={a.agentId}
              name={a.agentName}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Create ModelDistChart**

Create `packages/dashboard/src/components/cost/ModelDistChart.tsx`:

```tsx
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface ModelData {
  modelId: string;
  totalCostUSD: number;
  percentOfTotal: number;
}

const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981'];

function shortModelName(id: string): string {
  if (id.includes('opus')) return 'Opus';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  return id.split('-').slice(0, 2).join('-');
}

export function ModelDistChart({ models }: { models: ModelData[] }) {
  if (!models.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center text-gray-500">
        No model data available
      </div>
    );
  }

  const data = models.map(m => ({
    name: shortModelName(m.modelId),
    value: m.totalCostUSD,
    percent: m.percentOfTotal,
  }));

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">Model Distribution</h3>
      <ResponsiveContainer width="100%" height={250}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={80}
            label={({ name, percent }) => `${name} ${percent.toFixed(0)}%`}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
            formatter={(value: number) => [`$${value.toFixed(3)}`, 'Cost']}
          />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: Create TaskCostTable**

Create `packages/dashboard/src/components/cost/TaskCostTable.tsx`:

```tsx
interface TaskCost {
  taskId: string;
  title: string;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  completedAt: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function TaskCostTable({ tasks }: { tasks: TaskCost[] }) {
  if (!tasks.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center text-gray-500">
        No task cost data available
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">Top Tasks by Cost</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs border-b border-border">
              <th className="text-left py-2 px-2">Task</th>
              <th className="text-left py-2 px-2">Agent</th>
              <th className="text-right py-2 px-2">Tokens</th>
              <th className="text-right py-2 px-2">Cost</th>
            </tr>
          </thead>
          <tbody>
            {tasks.slice(0, 20).map(t => (
              <tr key={t.taskId} className="border-b border-border/50 hover:bg-surface-hover">
                <td className="py-2 px-2 truncate max-w-[200px]" title={t.title}>{t.title}</td>
                <td className="py-2 px-2 text-gray-400">{t.agentId}</td>
                <td className="py-2 px-2 text-right text-gray-400">{formatTokens(t.inputTokens + t.outputTokens)}</td>
                <td className="py-2 px-2 text-right font-mono">${t.costUSD.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/components/cost/AgentCostChart.tsx packages/dashboard/src/components/cost/ModelDistChart.tsx packages/dashboard/src/components/cost/TaskCostTable.tsx
git commit -m "feat: add cost dashboard chart components"
```

---

### Task 7: Cost Dashboard Page + Navigation

**Files:**
- Create: `packages/dashboard/src/pages/CostDashboard.tsx`
- Modify: `packages/dashboard/src/stores/store.ts` (add 'cost' view)
- Modify: `packages/dashboard/src/components/layout/Layout.tsx` (add nav + route)

- [ ] **Step 1: Create CostDashboard page**

Create `packages/dashboard/src/pages/CostDashboard.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { CostSummaryCards } from '../components/cost/CostSummaryCards';
import { AgentCostChart } from '../components/cost/AgentCostChart';
import { ModelDistChart } from '../components/cost/ModelDistChart';
import { TaskCostTable } from '../components/cost/TaskCostTable';

const API = '/api/v1/cost-dashboard';

type Period = 'day' | 'week' | 'month';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export function CostDashboardPage() {
  const [period, setPeriod] = useState<Period>('week');
  const [summary, setSummary] = useState<any>(null);
  const [agents, setAgents] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, a, m, t] = await Promise.all([
        fetchJson<any>(`${API}/summary?period=${period}`),
        fetchJson<any>(`${API}/by-agent?period=${period}`),
        fetchJson<any>(`${API}/by-model?period=${period}`),
        fetchJson<any>(`${API}/by-task?limit=20`),
      ]);
      setSummary(s);
      setAgents(a.agents || []);
      setModels(m.models || []);
      setTasks(t.tasks || []);
    } catch (err) {
      console.error('Failed to load cost data:', err);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const periods: { value: Period; label: string }[] = [
    { value: 'day', label: 'Today' },
    { value: 'week', label: '7 Days' },
    { value: 'month', label: '30 Days' },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Cost Dashboard</h2>
          <p className="text-sm text-gray-500">Token consumption and cost trends</p>
        </div>
        <div className="flex gap-1 bg-surface border border-border rounded-lg p-0.5">
          {periods.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                period === p.value
                  ? 'bg-accent/20 text-accent-light font-medium'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !summary ? (
        <div className="text-center text-gray-500 py-12">Loading cost data...</div>
      ) : (
        <>
          <CostSummaryCards data={summary} />
          <AgentCostChart agents={agents} />
          <div className="grid grid-cols-2 gap-4">
            <ModelDistChart models={models} />
            <TaskCostTable tasks={tasks} />
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add 'cost' to DashboardView type**

In `packages/dashboard/src/stores/store.ts`, find the `DashboardView` type and add `'cost'`:

```typescript
export type DashboardView = 'command' | 'agents' | 'tools' | 'models' | 'skills' | 'orchestrator' | 'board' | 'tasks' | 'timeline' | 'inbox' | 'observability' | 'audit' | 'settings' | 'cost';
```

- [ ] **Step 3: Add nav item and route to Layout.tsx**

In `packages/dashboard/src/components/layout/Layout.tsx`:

Add import at top:
```typescript
import { CostDashboardPage } from '../../pages/CostDashboard';
```

In `ViewToggle`, find the `Operations` section views array and add before settings:
```typescript
        { id: 'cost' as DashboardView, label: 'Costs', icon: '💰' },
```

In `MainContent`, add a case before `default`:
```typescript
    case 'cost':
      return <CostDashboardPage />;
```

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/pages/CostDashboard.tsx packages/dashboard/src/stores/store.ts packages/dashboard/src/components/layout/Layout.tsx
git commit -m "feat: add cost dashboard page with navigation"
```

---

### Task 8: Integration smoke test

**Files:**
- Create: `packages/server/src/__tests__/batch-b-integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `packages/server/src/__tests__/batch-b-integration.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

describe('Batch B integration', () => {
  it('SkillWatcher can be constructed without errors', async () => {
    const { SkillWatcher } = await import('../skills/skill-watcher.js');
    const watcher = new SkillWatcher('/tmp/nonexistent');
    expect(watcher).toBeDefined();
  });

  it('cost-dashboard query builders produce valid SQL', async () => {
    const { buildSummaryQuery, buildByAgentQuery, buildByModelQuery } = await import('../routes/cost-dashboard.js');

    const summary = buildSummaryQuery({ period: 'day' });
    expect(summary.sql).toContain('model_usage_stats');
    expect(summary.params).toHaveLength(2);

    const byAgent = buildByAgentQuery({ period: 'week' });
    expect(byAgent.sql).toContain('agent_id');

    const byModel = buildByModelQuery({ period: 'month' });
    expect(byModel.sql).toContain('model_id');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/__tests__/batch-b-integration.test.ts
git commit -m "test: add Batch B integration smoke tests"
```
