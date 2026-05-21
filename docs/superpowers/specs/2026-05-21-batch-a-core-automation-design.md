# Batch A: Core Automation — Design Spec

## Overview

Three event-driven, loosely-coupled modules that enhance Agent Factory's post-execution pipeline. All communicate via the existing EventBus; each can be independently enabled/disabled.

```
task:done ──┬──→ CoverageChecker → coverage:report → Notification
            └──→ ExecutionScorer → score:recorded → RouteWeightUpdater

stage:failed ──→ PipelineRollback → stage:rolled_back → Notification
```

---

## 1. Test Coverage Check

### Trigger

EventBus `task:done`. Only fires when the task workspace contains changed code files (detected via `git diff`).

### Flow

1. Receive `task:done` with `taskId`
2. Resolve task workspace path
3. Run `git diff --name-only` — filter by configured `filePatterns`
4. If no code file changes, skip
5. Run coverage command (e.g. `npm test -- --coverage`) inside workspace
6. Parse coverage output (line coverage %, branch coverage %)
7. Compare against configured `threshold`
8. Write `CoverageReport` to DB
9. If below threshold → create Notification in Inbox with summary

### Data Model

```sql
CREATE TABLE IF NOT EXISTS coverage_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  line_coverage REAL NOT NULL,
  branch_coverage REAL NOT NULL,
  threshold REAL NOT NULL,
  passed INTEGER NOT NULL,  -- 0 or 1
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

```typescript
interface CoverageReport {
  id: string;
  taskId: string;
  executionId: string;
  lineCoverage: number;    // 0-100
  branchCoverage: number;  // 0-100
  threshold: number;
  passed: boolean;
  summary: string;
  createdAt: string;
}
```

### Configuration

Stored in system settings, modifiable via Settings page or API.

```typescript
coverageCheck: {
  enabled: boolean;         // default: true
  threshold: 80;            // minimum acceptable line coverage %
  testCommand: 'npm test -- --coverage';
  filePatterns: ['*.ts', '*.js', '*.py'];
}
```

### Implementation Notes

- New file: `packages/server/src/workers/coverage-check.ts`
- Implements `BackgroundWorker` interface but triggered by event, not interval — register on EventBus directly rather than using WorkerScheduler interval
- Coverage command runs in a child process with timeout (default 5 min)
- Parse Jest/Istanbul JSON output format; fallback to regex on stdout for other runners

---

## 2. Pipeline Stage Rollback

### Trigger

EventBus `stage:failed` (new event to emit from PipelineEngine when a stage task fails).

### Flow

1. Receive `stage:failed` with `{ pipelineId, stageIndex, taskId, error }`
2. Look up the stage's checkpoint SHA (recorded at stage start)
3. In the pipeline workspace, run `git reset --hard <checkpoint_sha>`
4. Update stage status to `rolled_back`
5. Update pipeline status to `awaiting_retry`
6. Create Notification: "Pipeline X stage Y failed and rolled back. Ready for retry."

### Checkpoint Mechanism

Before each stage starts, PipelineEngine records the current `HEAD` SHA:

```typescript
// In PipelineEngine.startStage(), before executing:
const checkpointSha = execSync('git rev-parse HEAD', { cwd: workspacePath }).toString().trim();
updateStageCheckpoint(pipelineId, stageIndex, checkpointSha);
```

### Data Model Changes

```sql
-- Add columns to pipeline_stages (or the stages JSON field)
ALTER TABLE pipelines ADD COLUMN stage_checkpoints TEXT DEFAULT '{}';
-- JSON: { "0": "abc123", "1": "def456", ... }
```

New stage statuses:

```typescript
type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'rolled_back';
type PipelineStatus = 'running' | 'done' | 'failed' | 'awaiting_retry';
```

### Retry API

```
POST /api/pipelines/:id/stages/:index/retry
```

- Validates stage is in `rolled_back` status
- Resets stage to `pending`
- Sets pipeline status back to `running`
- Calls `startReadyStages()` which will pick up the reset stage

### Implementation Notes

- New file: `packages/server/src/pipelines/pipeline-rollback.ts`
- Modify `packages/server/src/pipelines/pipeline-engine.ts`:
  - Emit `stage:failed` event on task failure
  - Record checkpoint SHA before each stage
  - Add `retryStage()` method
- Add route in pipeline routes for retry endpoint

---

## 3. Agent Execution Quality Scoring

### Trigger

EventBus `task:done` (runs in parallel with coverage check, no dependency).

### Scoring Flow

#### Step 1: Base Score (always runs, synchronous)

Formula-based, immediate:

| Factor | Condition | Points |
|--------|-----------|--------|
| Baseline | — | 100 |
| Error | execution has error | -30 |
| Slow | duration > 2× agent's rolling avg | -20 |
| Slow | duration > 1.5× agent's rolling avg | -10 |
| Output too short | < 50 chars (non-empty input) | -10 |
| Output too long | > 50,000 chars | -5 |

`baseScore = clamp(100 + deductions, 0, 100)`

#### Step 2: LLM Judge (conditional, async)

Triggered only when `40 ≤ baseScore ≤ 80` (ambiguous zone):

- Send to LLM: task input + agent output + evaluation prompt
- LLM scores three dimensions (each 0-100):
  - **Completeness**: did it address all requirements?
  - **Correctness**: is the output factually/technically correct?
  - **Code Quality**: clean, maintainable, follows conventions?
- `llmScore = weighted average (completeness: 0.4, correctness: 0.4, codeQuality: 0.2)`
- `finalScore = llmScore` (overrides base score)

If LLM judge is not triggered: `finalScore = baseScore`.

#### Step 3: Route Weight Update

- Compute sliding window average of last 20 `finalScore` values for the agent
- Map to weight: `weight = clamp(avgScore / 100, 0.1, 1.0)`
- Store weight on agent record
- AgentManager uses weight for task assignment: among agents with matching role, weighted random selection

### Data Model

```sql
CREATE TABLE IF NOT EXISTS execution_scores (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base_score REAL NOT NULL,
  llm_score REAL,
  final_score REAL NOT NULL,
  dimensions TEXT,  -- JSON: { completeness, correctness, codeQuality }
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- Add to agents table
ALTER TABLE agents ADD COLUMN route_weight REAL DEFAULT 1.0;
```

```typescript
interface ExecutionScore {
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
```

### Implementation Notes

- New file: `packages/server/src/evaluation/execution-scorer.ts`
- Modify `packages/server/src/agents/agent-manager.ts`: use `route_weight` in agent selection
- LLM judge reuses the existing `EvalFramework.llmJudge` pattern but with a real prompt instead of the stub
- New DB model: `packages/server/src/db/models/execution-score.ts`
- Sliding window query: `SELECT AVG(final_score) FROM execution_scores WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20`

---

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/server/src/workers/coverage-check.ts` | Coverage check event handler |
| `packages/server/src/pipelines/pipeline-rollback.ts` | Stage rollback logic |
| `packages/server/src/evaluation/execution-scorer.ts` | Quality scoring engine |
| `packages/server/src/db/models/execution-score.ts` | Score DB model helpers |
| `packages/server/src/db/models/coverage-report.ts` | Coverage report DB model |

### Modified Files

| File | Changes |
|------|---------|
| `packages/server/src/pipelines/pipeline-engine.ts` | Emit `stage:failed`, record checkpoint SHA, add `retryStage()` |
| `packages/server/src/agents/agent-manager.ts` | Weighted agent selection using `route_weight` |
| `packages/server/src/db/database.ts` | Add new table schemas |
| `packages/server/src/routes/` | Add retry stage endpoint |
| `packages/server/src/index.ts` | Register new event handlers on startup |
| `packages/server/src/types.ts` | Add new types and extended status enums |
