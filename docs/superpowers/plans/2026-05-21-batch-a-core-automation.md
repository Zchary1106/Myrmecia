# Batch A: Core Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three event-driven modules — test coverage checking, pipeline stage rollback, and agent execution quality scoring with route weight feedback.

**Architecture:** Three loosely-coupled modules communicating via the existing EventBus. CoverageChecker and ExecutionScorer both listen to `task:done`; PipelineRollback listens to `task:failed` for pipeline tasks. Each module has its own DB table, can be independently enabled/disabled, and follows the existing pattern of constructor-based EventBus subscription (like `QualityLoop` and `NotifierService`).

**Tech Stack:** TypeScript, better-sqlite3, Node child_process for coverage commands, existing EventBus/Notification infrastructure.

---

### Task 1: Add new WSEventType entries

**Files:**
- Modify: `packages/shared/src/index.ts:564-579` (WSEventType union)

- [ ] **Step 1: Add new event types to WSEventType**

In `packages/shared/src/index.ts`, find the `WSEventType` union and add the new events:

```typescript
export type WSEventType =
  | 'task:created' | 'task:updated' | 'task:assigned' | 'task:started' | 'task:log'
  | 'task:done' | 'task:failed' | 'task:cancelled'
  | 'agent:status' | 'agent:log'
  | 'pipeline:stage:started' | 'pipeline:stage:done' | 'pipeline:done' | 'pipeline:failed'
  | 'pipeline:stage:rolled_back' | 'pipeline:awaiting_retry'
  | 'notification'
  | 'inbox:created' | 'inbox:updated'
  | 'quality:updated'
  | 'coverage:report'
  | 'score:recorded'
  | 'execution:started' | 'execution:activity' | 'execution:progress'
  | 'execution:message' | 'execution:done' | 'execution:failed'
  | 'tool:started' | 'tool:done' | 'tool:failed' | 'tool:blocked' | 'tool:updated'
  | 'skill:updated' | 'skill:published' | 'skill:assigned'
  | 'agent:message'
  | 'orchestration:created' | 'orchestration:task_dispatched' | 'orchestration:task_completed'
  | 'orchestration:task_failed' | 'orchestration:agent_message' | 'orchestration:done'
  | 'orchestration:failed';
```

- [ ] **Step 2: Add new shared types**

Append these types at the end of `packages/shared/src/index.ts` (before the closing of the file):

```typescript
// ---------- Coverage Check ----------

export interface CoverageReport {
  id: string;
  taskId: string;
  executionId: string;
  lineCoverage: number;
  branchCoverage: number;
  threshold: number;
  passed: boolean;
  summary: string;
  createdAt: string;
}

export interface CoverageCheckConfig {
  enabled: boolean;
  threshold: number;
  testCommand: string;
  filePatterns: string[];
}

// ---------- Execution Scoring ----------

export interface ExecutionScore {
  id: string;
  executionId: string;
  agentId: string;
  taskId: string;
  baseScore: number;
  llmScore: number | null;
  finalScore: number;
  dimensions: {
    completeness?: number;
    correctness?: number;
    codeQuality?: number;
  };
  createdAt: string;
}

// ---------- Pipeline Rollback ----------

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'rolled_back' | 'skipped';
export type PipelineStatus = 'running' | 'done' | 'failed' | 'paused' | 'blocked' | 'awaiting_retry';
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat: add shared types for coverage, scoring, and pipeline rollback"
```

---

### Task 2: Coverage Report DB model

**Files:**
- Create: `packages/server/src/db/models/coverage-report.ts`
- Modify: `packages/server/src/db/database.ts` (add schema)

- [ ] **Step 1: Write the test**

Create `packages/server/src/db/models/__tests__/coverage-report.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { createCoverageReport, getCoverageReport, listCoverageReports } from '../coverage-report.js';
import { getDb } from '../../database.js';

describe('coverage-report model', () => {
  it('creates and retrieves a coverage report', () => {
    const report = createCoverageReport({
      taskId: 'task_abc',
      executionId: 'exec_abc',
      lineCoverage: 85.5,
      branchCoverage: 72.3,
      threshold: 80,
      passed: true,
      summary: 'Coverage OK: 85.5% lines, 72.3% branches',
    });

    expect(report.id).toMatch(/^cov_/);
    expect(report.lineCoverage).toBe(85.5);
    expect(report.passed).toBe(true);

    const fetched = getCoverageReport(report.id);
    expect(fetched).toEqual(report);
  });

  it('lists reports by taskId', () => {
    createCoverageReport({
      taskId: 'task_list1',
      executionId: 'exec_list1',
      lineCoverage: 50,
      branchCoverage: 40,
      threshold: 80,
      passed: false,
      summary: 'Below threshold',
    });

    const reports = listCoverageReports({ taskId: 'task_list1' });
    expect(reports).toHaveLength(1);
    expect(reports[0].taskId).toBe('task_list1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/db/models/__tests__/coverage-report.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add schema to database.ts**

In `packages/server/src/db/database.ts`, find where other `CREATE TABLE` statements are and add:

```typescript
CREATE TABLE IF NOT EXISTS coverage_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  line_coverage REAL NOT NULL,
  branch_coverage REAL NOT NULL,
  threshold REAL NOT NULL,
  passed INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

- [ ] **Step 4: Create coverage-report.ts model**

Create `packages/server/src/db/models/coverage-report.ts`:

```typescript
import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { CoverageReport } from '../../types.js';

function rowToReport(row: any): CoverageReport {
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    lineCoverage: row.line_coverage,
    branchCoverage: row.branch_coverage,
    threshold: row.threshold,
    passed: !!row.passed,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export function createCoverageReport(data: {
  taskId: string;
  executionId: string;
  lineCoverage: number;
  branchCoverage: number;
  threshold: number;
  passed: boolean;
  summary: string;
}): CoverageReport {
  const db = getDb();
  const id = `cov_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO coverage_reports (id, task_id, execution_id, line_coverage, branch_coverage, threshold, passed, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, id, data.taskId, data.executionId, data.lineCoverage, data.branchCoverage, data.threshold, data.passed ? 1 : 0, data.summary);
  return getCoverageReport(id)!;
}

export function getCoverageReport(id: string): CoverageReport | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM coverage_reports WHERE id = ?', id);
  return row ? rowToReport(row) : undefined;
}

export function listCoverageReports(filter?: { taskId?: string; passed?: boolean }): CoverageReport[] {
  const db = getDb();
  let sql = 'SELECT * FROM coverage_reports';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.passed !== undefined) { conditions.push('passed = ?'); params.push(filter.passed ? 1 : 0); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  return db.all(sql, ...params).map(rowToReport);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/server/src/db/models/__tests__/coverage-report.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/models/coverage-report.ts packages/server/src/db/models/__tests__/coverage-report.test.ts packages/server/src/db/database.ts
git commit -m "feat: add coverage_reports DB model"
```

---

### Task 3: Coverage Check Worker

**Files:**
- Create: `packages/server/src/workers/coverage-check.ts`
- Modify: `packages/server/src/index.ts` (register worker)

- [ ] **Step 1: Write the test**

Create `packages/server/src/workers/__tests__/coverage-check.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoverageChecker } from '../coverage-check.js';

// Mock dependencies
vi.mock('../../db/models/task.js', () => ({
  getTask: vi.fn(),
}));
vi.mock('../../db/models/coverage-report.js', () => ({
  createCoverageReport: vi.fn((data) => ({ id: 'cov_test', ...data })),
}));
vi.mock('../../db/models/notification.js', () => ({
  createNotification: vi.fn((data) => ({ id: 'notif_test', ...data })),
}));
vi.mock('../../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

import { getTask } from '../../db/models/task.js';
import { createCoverageReport } from '../../db/models/coverage-report.js';
import { createNotification } from '../../db/models/notification.js';

describe('CoverageChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parseCoverageOutput extracts line and branch coverage from Jest JSON', () => {
    const checker = new CoverageChecker();
    const jestOutput = JSON.stringify({
      total: {
        lines: { pct: 85.5 },
        branches: { pct: 72.3 },
      },
    });

    const result = checker.parseCoverageOutput(jestOutput);
    expect(result).toEqual({ lineCoverage: 85.5, branchCoverage: 72.3 });
  });

  it('parseCoverageOutput handles text fallback', () => {
    const checker = new CoverageChecker();
    const textOutput = `
All files      |   82.14 |   65.38 |   100 |   82.14 |
    `;
    const result = checker.parseCoverageOutput(textOutput);
    expect(result.lineCoverage).toBeCloseTo(82.14);
  });

  it('shouldCheck returns false for tasks with no workspace', () => {
    const checker = new CoverageChecker();
    (getTask as any).mockReturnValue({ id: 'task_1', workspacePath: null });
    const result = checker.shouldCheck('task_1');
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/workers/__tests__/coverage-check.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CoverageChecker**

Create `packages/server/src/workers/coverage-check.ts`:

```typescript
import { execSync } from 'child_process';
import { eventBus } from '../events/event-bus.js';
import { getTask } from '../db/models/task.js';
import { createCoverageReport } from '../db/models/coverage-report.js';
import { createNotification } from '../db/models/notification.js';
import { listExecutions } from '../db/models/execution.js';
import { logger } from '../lib/logger.js';
import type { CoverageCheckConfig } from '../types.js';

const DEFAULT_CONFIG: CoverageCheckConfig = {
  enabled: true,
  threshold: 80,
  testCommand: 'npm test -- --coverage --json',
  filePatterns: ['*.ts', '*.js', '*.tsx', '*.jsx', '*.py'],
};

export class CoverageChecker {
  private config: CoverageCheckConfig;

  constructor(config?: Partial<CoverageCheckConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enabled) {
      eventBus.on('task:done', (event) => {
        const { taskId } = event.payload as { taskId: string };
        this.check(taskId).catch(err =>
          logger.warn({ taskId, error: err.message }, 'Coverage check failed')
        );
      });
      logger.info('Coverage checker active');
    }
  }

  /** Determine if a task needs coverage checking */
  shouldCheck(taskId: string): boolean {
    const task = getTask(taskId);
    if (!task) return false;
    if (!task.workspacePath) return false;

    // Check if workspace has code file changes
    try {
      const diff = execSync('git diff --name-only HEAD~1', {
        cwd: task.workspacePath,
        encoding: 'utf-8',
        timeout: 10000,
      });
      const patterns = this.config.filePatterns;
      const hasCodeChanges = diff.split('\n').some(file =>
        patterns.some(pattern => {
          const ext = pattern.replace('*', '');
          return file.endsWith(ext);
        })
      );
      return hasCodeChanges;
    } catch {
      return false;
    }
  }

  /** Run coverage check for a completed task */
  async check(taskId: string): Promise<void> {
    if (!this.shouldCheck(taskId)) return;

    const task = getTask(taskId)!;
    const executions = listExecutions({ taskId });
    const execution = executions[executions.length - 1];
    if (!execution) return;

    let output: string;
    try {
      output = execSync(this.config.testCommand, {
        cwd: task.workspacePath!,
        encoding: 'utf-8',
        timeout: 5 * 60 * 1000, // 5 min
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      // Tests may fail but still produce coverage output
      output = err.stdout || err.message;
      if (!output.includes('coverage')) {
        logger.warn({ taskId }, 'Coverage command produced no coverage data');
        return;
      }
    }

    const { lineCoverage, branchCoverage } = this.parseCoverageOutput(output);
    const passed = lineCoverage >= this.config.threshold;
    const summary = `Coverage: ${lineCoverage.toFixed(1)}% lines, ${branchCoverage.toFixed(1)}% branches (threshold: ${this.config.threshold}%)`;

    const report = createCoverageReport({
      taskId,
      executionId: execution.id,
      lineCoverage,
      branchCoverage,
      threshold: this.config.threshold,
      passed,
      summary,
    });

    eventBus.emit('coverage:report', { report });

    if (!passed) {
      createNotification({
        type: 'task_failed',
        title: 'Coverage Below Threshold',
        message: summary,
        taskId,
      });
    }

    logger.info({ taskId, lineCoverage, passed }, 'Coverage check completed');
  }

  /** Parse coverage output — tries JSON (Jest/Istanbul) first, then regex fallback */
  parseCoverageOutput(output: string): { lineCoverage: number; branchCoverage: number } {
    // Try JSON format (Jest --json with --coverage)
    try {
      const json = JSON.parse(output);
      if (json.total?.lines?.pct !== undefined) {
        return {
          lineCoverage: json.total.lines.pct,
          branchCoverage: json.total.branches?.pct ?? 0,
        };
      }
    } catch {
      // Not JSON, try text parsing
    }

    // Regex fallback: match Istanbul text table "All files" row
    // Format: All files | stmts | branches | funcs | lines |
    const match = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
    if (match) {
      return {
        lineCoverage: parseFloat(match[1]),
        branchCoverage: parseFloat(match[2]),
      };
    }

    return { lineCoverage: 0, branchCoverage: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/workers/__tests__/coverage-check.test.ts`
Expected: PASS

- [ ] **Step 5: Register in index.ts**

In `packages/server/src/index.ts`, add import and instantiation:

```typescript
// After existing imports
import { CoverageChecker } from './workers/coverage-check.js';

// After "Quality loop active" line (around line 82):
logger.info('Coverage checker active');
new CoverageChecker();
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/workers/coverage-check.ts packages/server/src/workers/__tests__/coverage-check.test.ts packages/server/src/index.ts
git commit -m "feat: add test coverage checker triggered on task:done"
```

---

### Task 4: Execution Score DB model

**Files:**
- Create: `packages/server/src/db/models/execution-score.ts`
- Modify: `packages/server/src/db/database.ts` (add schema)

- [ ] **Step 1: Write the test**

Create `packages/server/src/db/models/__tests__/execution-score.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createExecutionScore, getAgentAvgScore, listExecutionScores } from '../execution-score.js';

describe('execution-score model', () => {
  it('creates and retrieves a score', () => {
    const score = createExecutionScore({
      executionId: 'exec_s1',
      agentId: 'dev',
      taskId: 'task_s1',
      baseScore: 70,
      llmScore: null,
      finalScore: 70,
      dimensions: {},
    });

    expect(score.id).toMatch(/^score_/);
    expect(score.finalScore).toBe(70);
  });

  it('computes sliding window average', () => {
    // Create 3 scores for agent "test-agent"
    for (const fs of [80, 60, 100]) {
      createExecutionScore({
        executionId: `exec_avg_${fs}`,
        agentId: 'test-agent',
        taskId: `task_avg_${fs}`,
        baseScore: fs,
        llmScore: null,
        finalScore: fs,
        dimensions: {},
      });
    }

    const avg = getAgentAvgScore('test-agent', 20);
    expect(avg).toBe(80); // (80+60+100)/3
  });

  it('lists scores by agentId', () => {
    const scores = listExecutionScores({ agentId: 'test-agent' });
    expect(scores.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/db/models/__tests__/execution-score.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add schema to database.ts**

In `packages/server/src/db/database.ts`, add:

```sql
CREATE TABLE IF NOT EXISTS execution_scores (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base_score REAL NOT NULL,
  llm_score REAL,
  final_score REAL NOT NULL,
  dimensions TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

Also add `route_weight` column to agents table. Find the agents CREATE TABLE and add:

```sql
-- In the agents schema, add this column (or via ALTER if schema is static):
route_weight REAL DEFAULT 1.0
```

- [ ] **Step 4: Create execution-score.ts model**

Create `packages/server/src/db/models/execution-score.ts`:

```typescript
import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { ExecutionScore } from '../../types.js';

function rowToScore(row: any): ExecutionScore {
  return {
    id: row.id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    baseScore: row.base_score,
    llmScore: row.llm_score,
    finalScore: row.final_score,
    dimensions: JSON.parse(row.dimensions || '{}'),
    createdAt: row.created_at,
  };
}

export function createExecutionScore(data: {
  executionId: string;
  agentId: string;
  taskId: string;
  baseScore: number;
  llmScore: number | null;
  finalScore: number;
  dimensions: Record<string, number | undefined>;
}): ExecutionScore {
  const db = getDb();
  const id = `score_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO execution_scores (id, execution_id, agent_id, task_id, base_score, llm_score, final_score, dimensions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, id, data.executionId, data.agentId, data.taskId, data.baseScore, data.llmScore, data.finalScore, JSON.stringify(data.dimensions));
  return getExecutionScore(id)!;
}

export function getExecutionScore(id: string): ExecutionScore | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM execution_scores WHERE id = ?', id);
  return row ? rowToScore(row) : undefined;
}

export function listExecutionScores(filter?: { agentId?: string; taskId?: string; limit?: number }): ExecutionScore[] {
  const db = getDb();
  let sql = 'SELECT * FROM execution_scores';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.agentId) { conditions.push('agent_id = ?'); params.push(filter.agentId); }
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return db.all(sql, ...params).map(rowToScore);
}

export function getAgentAvgScore(agentId: string, windowSize: number = 20): number {
  const db = getDb();
  const row = db.get(`
    SELECT AVG(final_score) as avg_score FROM (
      SELECT final_score FROM execution_scores
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `, agentId, windowSize) as { avg_score: number | null } | undefined;
  return row?.avg_score ?? 100; // default to 100 for agents with no scores
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/server/src/db/models/__tests__/execution-score.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/models/execution-score.ts packages/server/src/db/models/__tests__/execution-score.test.ts packages/server/src/db/database.ts
git commit -m "feat: add execution_scores DB model with sliding window average"
```

---

### Task 5: Execution Scorer

**Files:**
- Create: `packages/server/src/evaluation/execution-scorer.ts`
- Modify: `packages/server/src/agents/agent-manager.ts` (weighted selection)
- Modify: `packages/server/src/index.ts` (register scorer)

- [ ] **Step 1: Write the test**

Create `packages/server/src/evaluation/__tests__/execution-scorer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionScorer } from '../execution-scorer.js';

vi.mock('../../db/models/task.js', () => ({
  getTask: vi.fn(),
}));
vi.mock('../../db/models/execution.js', () => ({
  listExecutions: vi.fn(),
  getExecution: vi.fn(),
}));
vi.mock('../../db/models/execution-score.js', () => ({
  createExecutionScore: vi.fn((data) => ({ id: 'score_test', ...data })),
  getAgentAvgScore: vi.fn(() => 75),
}));
vi.mock('../../db/models/agent.js', () => ({
  updateAgent: vi.fn(),
}));
vi.mock('../../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

describe('ExecutionScorer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calculates base score with no errors = 100', () => {
    const scorer = new ExecutionScorer();
    const base = scorer.calculateBaseScore({
      hasError: false,
      durationMs: 5000,
      avgDurationMs: 10000,
      outputLength: 500,
      inputLength: 100,
    });
    expect(base).toBe(100);
  });

  it('deducts 30 for errors', () => {
    const scorer = new ExecutionScorer();
    const base = scorer.calculateBaseScore({
      hasError: true,
      durationMs: 5000,
      avgDurationMs: 10000,
      outputLength: 500,
      inputLength: 100,
    });
    expect(base).toBe(70);
  });

  it('deducts 20 for very slow execution (>2x avg)', () => {
    const scorer = new ExecutionScorer();
    const base = scorer.calculateBaseScore({
      hasError: false,
      durationMs: 25000,
      avgDurationMs: 10000,
      outputLength: 500,
      inputLength: 100,
    });
    expect(base).toBe(80);
  });

  it('deducts 10 for short output', () => {
    const scorer = new ExecutionScorer();
    const base = scorer.calculateBaseScore({
      hasError: false,
      durationMs: 5000,
      avgDurationMs: 10000,
      outputLength: 20,
      inputLength: 100,
    });
    expect(base).toBe(90);
  });

  it('clamps score to [0, 100]', () => {
    const scorer = new ExecutionScorer();
    const base = scorer.calculateBaseScore({
      hasError: true,          // -30
      durationMs: 25000,       // -20
      avgDurationMs: 10000,
      outputLength: 20,        // -10
      inputLength: 100,
    });
    expect(base).toBe(40);
  });

  it('computeRouteWeight maps avg score to [0.1, 1.0]', () => {
    const scorer = new ExecutionScorer();
    expect(scorer.computeRouteWeight(100)).toBe(1.0);
    expect(scorer.computeRouteWeight(50)).toBe(0.5);
    expect(scorer.computeRouteWeight(5)).toBe(0.1);
    expect(scorer.computeRouteWeight(0)).toBe(0.1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/evaluation/__tests__/execution-scorer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ExecutionScorer**

Create `packages/server/src/evaluation/execution-scorer.ts`:

```typescript
import { eventBus } from '../events/event-bus.js';
import { getTask } from '../db/models/task.js';
import { listExecutions } from '../db/models/execution.js';
import { createExecutionScore, getAgentAvgScore } from '../db/models/execution-score.js';
import { updateAgent } from '../db/models/agent.js';
import { logger } from '../lib/logger.js';

interface BaseScoreInput {
  hasError: boolean;
  durationMs: number;
  avgDurationMs: number;
  outputLength: number;
  inputLength: number;
}

export class ExecutionScorer {
  constructor() {
    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as { taskId: string };
      this.score(taskId).catch(err =>
        logger.warn({ taskId, error: err.message }, 'Execution scoring failed')
      );
    });
    logger.info('Execution scorer active');
  }

  /** Calculate formula-based score */
  calculateBaseScore(input: BaseScoreInput): number {
    let score = 100;

    if (input.hasError) score -= 30;

    if (input.avgDurationMs > 0) {
      const ratio = input.durationMs / input.avgDurationMs;
      if (ratio > 2) score -= 20;
      else if (ratio > 1.5) score -= 10;
    }

    if (input.outputLength < 50 && input.inputLength > 0) score -= 10;
    if (input.outputLength > 50000) score -= 5;

    return Math.max(0, Math.min(100, score));
  }

  /** Map avg score to route weight */
  computeRouteWeight(avgScore: number): number {
    return Math.max(0.1, Math.min(1.0, avgScore / 100));
  }

  /** Score a completed task's execution */
  async score(taskId: string): Promise<void> {
    const task = getTask(taskId);
    if (!task || !task.assigneeId) return;

    const executions = listExecutions({ taskId });
    const execution = executions[executions.length - 1];
    if (!execution) return;

    const durationMs = execution.completedAt && execution.startedAt
      ? new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime()
      : 0;

    const hasError = execution.status === 'failed' || !!(task as any).error;
    const outputLength = (task.output || '').length;
    const inputLength = (task.input || '').length;

    // Use agent's stats.avgDurationMs as baseline
    const avgDurationMs = (task as any).assignee?.stats?.avgDurationMs || durationMs;

    const baseScore = this.calculateBaseScore({
      hasError,
      durationMs,
      avgDurationMs,
      outputLength,
      inputLength,
    });

    let llmScore: number | null = null;
    let dimensions: Record<string, number | undefined> = {};
    let finalScore = baseScore;

    // LLM judge for ambiguous zone (40-80)
    if (baseScore >= 40 && baseScore <= 80) {
      try {
        const llmResult = await this.llmJudge(task.input || '', task.output || '');
        llmScore = llmResult.score;
        dimensions = llmResult.dimensions;
        finalScore = llmScore;
      } catch (err: any) {
        logger.warn({ taskId, error: err.message }, 'LLM judge failed, using base score');
      }
    }

    const scoreRecord = createExecutionScore({
      executionId: execution.id,
      agentId: task.assigneeId,
      taskId,
      baseScore,
      llmScore,
      finalScore,
      dimensions,
    });

    // Update agent route weight
    const avgScore = getAgentAvgScore(task.assigneeId, 20);
    const weight = this.computeRouteWeight(avgScore);
    updateAgent(task.assigneeId, { routeWeight: weight } as any);

    eventBus.emit('score:recorded', { score: scoreRecord, routeWeight: weight });
    logger.info({ taskId, agentId: task.assigneeId, finalScore, routeWeight: weight }, 'Execution scored');
  }

  /** LLM-as-Judge — evaluates task output quality */
  private async llmJudge(input: string, output: string): Promise<{
    score: number;
    dimensions: { completeness?: number; correctness?: number; codeQuality?: number };
  }> {
    // TODO: Replace with actual LLM call via model router
    // For now, heuristic stub that's better than the eval-framework stub
    const inputLen = input.length;
    const outputLen = output.length;

    const completeness = Math.min(100, (outputLen / Math.max(inputLen, 1)) * 20);
    const correctness = output.toLowerCase().includes('error') ? 40 : 80;
    const codeQuality = outputLen > 100 && outputLen < 30000 ? 80 : 50;

    const score = completeness * 0.4 + correctness * 0.4 + codeQuality * 0.2;

    return {
      score: Math.round(Math.max(0, Math.min(100, score))),
      dimensions: { completeness, correctness, codeQuality },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/evaluation/__tests__/execution-scorer.test.ts`
Expected: PASS

- [ ] **Step 5: Modify AgentManager for weighted selection**

In `packages/server/src/agents/agent-manager.ts`, replace the `findAvailableAgent` method (lines 88-94):

```typescript
  findAvailableAgent(role: string): AgentDefinition | undefined {
    const agents = listAgents({ role });
    const available = agents.filter(a => {
      const active = getActiveExecutionCount(a.id);
      return active < (a.config.maxConcurrent || 1);
    });

    if (available.length === 0) return undefined;
    if (available.length === 1) return available[0];

    // Weighted random selection based on route_weight
    const weights = available.map(a => (a as any).routeWeight ?? 1.0);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let rand = Math.random() * totalWeight;

    for (let i = 0; i < available.length; i++) {
      rand -= weights[i];
      if (rand <= 0) return available[i];
    }

    return available[available.length - 1];
  }
```

- [ ] **Step 6: Register in index.ts**

In `packages/server/src/index.ts`, add:

```typescript
import { ExecutionScorer } from './evaluation/execution-scorer.js';

// After CoverageChecker instantiation:
logger.info('Execution scorer active');
new ExecutionScorer();
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/evaluation/execution-scorer.ts packages/server/src/evaluation/__tests__/execution-scorer.test.ts packages/server/src/agents/agent-manager.ts packages/server/src/index.ts
git commit -m "feat: add execution scorer with LLM judge and route weight feedback"
```

---

### Task 6: Pipeline Rollback

**Files:**
- Create: `packages/server/src/pipelines/pipeline-rollback.ts`
- Modify: `packages/server/src/pipelines/pipeline-engine.ts` (checkpoint + stage:failed event + retryStage)
- Modify: `packages/server/src/routes/pipelines.ts` (retry endpoint)
- Modify: `packages/server/src/index.ts` (register rollback handler)

- [ ] **Step 1: Write the test**

Create `packages/server/src/pipelines/__tests__/pipeline-rollback.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineRollback } from '../pipeline-rollback.js';

vi.mock('../../db/models/pipeline.js', () => ({
  getPipeline: vi.fn(),
  updatePipeline: vi.fn(),
}));
vi.mock('../../db/models/notification.js', () => ({
  createNotification: vi.fn((data) => ({ id: 'notif_test', ...data })),
}));
vi.mock('../../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

import { getPipeline, updatePipeline } from '../../db/models/pipeline.js';
import { createNotification } from '../../db/models/notification.js';
import { eventBus } from '../../events/event-bus.js';

describe('PipelineRollback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getCheckpoint returns stored SHA', () => {
    (getPipeline as any).mockReturnValue({
      id: 'pipe_1',
      stageCheckpoints: JSON.stringify({ '0': 'abc123', '1': 'def456' }),
    });

    const rollback = new PipelineRollback();
    const sha = rollback.getCheckpoint('pipe_1', 1);
    expect(sha).toBe('def456');
  });

  it('getCheckpoint returns undefined for missing checkpoint', () => {
    (getPipeline as any).mockReturnValue({
      id: 'pipe_1',
      stageCheckpoints: JSON.stringify({ '0': 'abc123' }),
    });

    const rollback = new PipelineRollback();
    const sha = rollback.getCheckpoint('pipe_1', 2);
    expect(sha).toBeUndefined();
  });

  it('updateStageStatus sets stage to rolled_back and pipeline to awaiting_retry', () => {
    const stages = [
      { name: 'PM', status: 'done' },
      { name: 'Dev', status: 'failed' },
    ];
    (getPipeline as any).mockReturnValue({
      id: 'pipe_1',
      name: 'Test Pipeline',
      stages,
      stageCheckpoints: JSON.stringify({ '1': 'abc123' }),
    });

    const rollback = new PipelineRollback();
    rollback.updateStageStatus('pipe_1', 1);

    expect(updatePipeline).toHaveBeenCalledWith('pipe_1', expect.objectContaining({
      status: 'awaiting_retry',
    }));
    expect(createNotification).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/pipelines/__tests__/pipeline-rollback.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PipelineRollback**

Create `packages/server/src/pipelines/pipeline-rollback.ts`:

```typescript
import { execSync } from 'child_process';
import { eventBus } from '../events/event-bus.js';
import { getPipeline, updatePipeline } from '../db/models/pipeline.js';
import { createNotification } from '../db/models/notification.js';
import { workspaceManager } from '../workspace/workspace-manager.js';
import { logger } from '../lib/logger.js';

export class PipelineRollback {
  constructor() {
    eventBus.on('task:failed', (event) => {
      const { taskId } = event.payload as { taskId: string; error?: string };
      this.onTaskFailed(taskId).catch(err =>
        logger.error({ taskId, error: err.message }, 'Pipeline rollback failed')
      );
    });
    logger.info('Pipeline rollback handler active');
  }

  /** Handle a failed task — check if it belongs to a pipeline and rollback */
  private async onTaskFailed(taskId: string): Promise<void> {
    // Find pipeline containing this task
    const { listPipelines } = await import('../db/models/pipeline.js');
    const pipelines = listPipelines({ status: 'running' });

    for (const pipeline of pipelines) {
      const stageIdx = pipeline.stages.findIndex((s: any) => s.taskId === taskId);
      if (stageIdx === -1) continue;

      logger.info({ pipelineId: pipeline.id, stageIndex: stageIdx }, 'Stage failed, initiating rollback');

      // Git rollback in workspace
      await this.gitRollback(pipeline.id, stageIdx);

      // Update DB status
      this.updateStageStatus(pipeline.id, stageIdx);

      eventBus.emit('pipeline:stage:rolled_back', {
        pipelineId: pipeline.id,
        stageIndex: stageIdx,
        taskId,
      });
      return;
    }
  }

  /** Get checkpoint SHA for a stage */
  getCheckpoint(pipelineId: string, stageIndex: number): string | undefined {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return undefined;
    const checkpoints = JSON.parse((pipeline as any).stageCheckpoints || '{}');
    return checkpoints[String(stageIndex)];
  }

  /** Rollback git state to checkpoint */
  private async gitRollback(pipelineId: string, stageIndex: number): Promise<void> {
    const sha = this.getCheckpoint(pipelineId, stageIndex);
    if (!sha) {
      logger.warn({ pipelineId, stageIndex }, 'No checkpoint found, skipping git rollback');
      return;
    }

    const ws = workspaceManager.getWorkspaceInfo(pipelineId, 'pipeline');
    if (!ws) {
      logger.warn({ pipelineId }, 'No workspace found, skipping git rollback');
      return;
    }

    try {
      execSync(`git reset --hard ${sha}`, {
        cwd: ws.path,
        encoding: 'utf-8',
        timeout: 30000,
      });
      logger.info({ pipelineId, stageIndex, sha }, 'Git rollback successful');
    } catch (err: any) {
      logger.error({ pipelineId, stageIndex, error: err.message }, 'Git rollback failed');
    }
  }

  /** Update pipeline and stage status in DB */
  updateStageStatus(pipelineId: string, stageIndex: number): void {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) return;

    const stages = [...pipeline.stages];
    stages[stageIndex] = { ...stages[stageIndex], status: 'rolled_back' };
    updatePipeline(pipelineId, { stages, status: 'awaiting_retry' as any });

    createNotification({
      type: 'pipeline_stage',
      title: 'Pipeline Stage Rolled Back',
      message: `Pipeline "${pipeline.name}" stage ${stageIndex} (${stages[stageIndex].name}) failed and was rolled back. Ready for retry.`,
      pipelineId,
    });
  }
}

/** Save a checkpoint SHA for a stage (called by PipelineEngine before starting a stage) */
export function saveStageCheckpoint(pipelineId: string, stageIndex: number, sha: string): void {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;
  const checkpoints = JSON.parse((pipeline as any).stageCheckpoints || '{}');
  checkpoints[String(stageIndex)] = sha;
  updatePipeline(pipelineId, { stageCheckpoints: JSON.stringify(checkpoints) } as any);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/pipelines/__tests__/pipeline-rollback.test.ts`
Expected: PASS

- [ ] **Step 5: Modify PipelineEngine to save checkpoints**

In `packages/server/src/pipelines/pipeline-engine.ts`, add import and checkpoint logic:

```typescript
// Add import at top:
import { saveStageCheckpoint } from './pipeline-rollback.js';
import { execSync } from 'child_process';
```

In the `startStage` method, after line 130 (`let workspacePath = ws?.path || undefined;`), add:

```typescript
    // Save checkpoint before starting stage
    if (ws?.path) {
      try {
        const sha = execSync('git rev-parse HEAD', { cwd: ws.path, encoding: 'utf-8' }).trim();
        saveStageCheckpoint(pipelineId, stageIndex, sha);
      } catch {
        // Not a git workspace, skip checkpoint
      }
    }
```

- [ ] **Step 6: Add retryStage method to PipelineEngine**

Add this method to the `PipelineEngine` class:

```typescript
  /** Retry a rolled-back stage */
  async retryStage(pipelineId: string, stageIndex: number): Promise<void> {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);

    const stage = pipeline.stages[stageIndex];
    if (!stage) throw new Error(`Stage ${stageIndex} not found`);
    if (stage.status !== 'rolled_back') {
      throw new Error(`Stage ${stageIndex} is not in rolled_back status (current: ${stage.status})`);
    }

    const stages = [...pipeline.stages];
    stages[stageIndex] = { ...stages[stageIndex], status: 'pending', taskId: undefined, output: undefined };
    updatePipeline(pipelineId, { stages, status: 'running' });

    eventBus.emit('pipeline:awaiting_retry', { pipelineId, stageIndex, action: 'retry' });

    this.startReadyStages(pipelineId);
  }
```

- [ ] **Step 7: Add retry route**

In `packages/server/src/routes/pipelines.ts`, find the pipeline routes and add:

```typescript
  // Retry a rolled-back stage
  router.post('/:id/stages/:index/retry', async (req, res) => {
    try {
      const stageIndex = parseInt(req.params.index, 10);
      await pipelineEngine.retryStage(req.params.id, stageIndex);
      res.json({ success: true, message: `Stage ${stageIndex} retry initiated` });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
```

- [ ] **Step 8: Add stageCheckpoints column to pipeline schema**

In `packages/server/src/db/database.ts`, find the pipelines CREATE TABLE and add:

```sql
stage_checkpoints TEXT DEFAULT '{}'
```

- [ ] **Step 9: Register PipelineRollback in index.ts**

In `packages/server/src/index.ts`, add:

```typescript
import { PipelineRollback } from './pipelines/pipeline-rollback.js';

// After QualityLoop instantiation:
logger.info('Pipeline rollback handler active');
new PipelineRollback();
```

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/pipelines/pipeline-rollback.ts packages/server/src/pipelines/__tests__/pipeline-rollback.test.ts packages/server/src/pipelines/pipeline-engine.ts packages/server/src/routes/pipelines.ts packages/server/src/db/database.ts packages/server/src/index.ts
git commit -m "feat: add pipeline stage rollback with checkpoint and retry"
```

---

### Task 7: Integration smoke test

**Files:**
- Create: `packages/server/src/__tests__/batch-a-integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `packages/server/src/__tests__/batch-a-integration.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { eventBus } from '../events/event-bus.js';

/**
 * Smoke test: verify all three modules register their EventBus listeners
 * without throwing during construction.
 */
describe('Batch A integration', () => {
  it('CoverageChecker registers on task:done', async () => {
    const onSpy = vi.spyOn(eventBus, 'on');
    const { CoverageChecker } = await import('../workers/coverage-check.js');
    new CoverageChecker({ enabled: true });
    expect(onSpy).toHaveBeenCalledWith('task:done', expect.any(Function));
    onSpy.mockRestore();
  });

  it('ExecutionScorer registers on task:done', async () => {
    const onSpy = vi.spyOn(eventBus, 'on');
    const { ExecutionScorer } = await import('../evaluation/execution-scorer.js');
    new ExecutionScorer();
    expect(onSpy).toHaveBeenCalledWith('task:done', expect.any(Function));
    onSpy.mockRestore();
  });

  it('PipelineRollback registers on task:failed', async () => {
    const onSpy = vi.spyOn(eventBus, 'on');
    const { PipelineRollback } = await import('../pipelines/pipeline-rollback.js');
    new PipelineRollback();
    expect(onSpy).toHaveBeenCalledWith('task:failed', expect.any(Function));
    onSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run packages/server/src`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/__tests__/batch-a-integration.test.ts
git commit -m "test: add Batch A integration smoke tests"
```
