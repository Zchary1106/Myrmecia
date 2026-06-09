# Post-P1 Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up LLM cache to TS agent loop, connect telemetry metrics to execution paths, fix checkpoint data-model conflict, and resolve performance bottlenecks uncovered in post-P1 review.

**Architecture:** LRU cache lookup before LLM call, structured metric emission at key execution points, unified checkpoint column schema, and a `Map<taskId, pipelineRef>` index for O(1) pipeline stage advancement.

**Tech Stack:** TypeScript, SQLite, OpenTelemetry SDK

---

## P0 — Immediate (high impact, low effort)

### Task 1: Wire LLM Cache into TS Agent Loop

**Files:**
- Modify: `packages/server/src/agents/ts-agent-loop.ts` (import `llmCache`, check cache before LLM call, cache result after)
- Verify: `packages/server/src/cache/llm-cache.ts` (singleton already exported)

**Goal:** Repeated prompts or system messages hit the LRU cache, skipping the LLM API call entirely.

- [ ] Import `llmCache` from `../cache/llm-cache.js`
- [ ] Before `client.chat.completions.create()`: call `llmCache.get({ model, system, prompt })`
- [ ] On cache hit: skip API call, return cached output with 0 token cost
- [ ] On cache miss: call API, then `llmCache.set(key, { output, inputTokens, outputTokens })`
- [ ] Emit `metrics.cacheHitRate.add(1, {status:'hit'|'miss'})` for observability
- [ ] Test: `pnpm --filter @myrmecia/server exec vitest run src/cache/llm-cache.test.ts` (existing 6 tests should still pass)
- [ ] Commit

---

### Task 2: Connect Telemetry Metrics to Execution Paths

**Files:**
- Modify: `packages/server/src/agents/agent-runtime.ts` (emit taskDuration, agentExecutions, tokenUsage, costMicrodollars)
- Modify: `packages/server/src/agents/ts-agent-loop.ts` (emit cacheHitRate, taskDuration)
- Modify: `packages/server/src/queue/task-queue.ts` (emit queueDepth on enqueue/dequeue)
- Modify: `packages/server/src/db/models/trace.ts` (call emitMetric alongside otelSpanFromTrace)

**Goal:** All 8 declared metrics actually receive data, so OTel dashboards show real values instead of zeroes.

- [ ] In `agent-runtime.ts` `execute()` success path: emit `taskExecutions.add(1, {status:'done'})`, `taskDuration.record(durationMs)`, `agentExecutions.add(1, {agentId, status:'done'})`, `tokenUsage.add(tokenCount)`, `costMicrodollars.add(cost*1e6)`
- [ ] In `agent-runtime.ts` `execute()` failure path: same with `status:'failed'`
- [ ] In `ts-agent-loop.ts` `execute()` cache hit: `cacheHitRate.add(1, {status:'hit'})` — see Task 1
- [ ] In `ts-agent-loop.ts` `execute()` cache miss: `cacheHitRate.add(1, {status:'miss'})` — see Task 1
- [ ] In `task-queue.ts` `enqueue()`: `queueDepth.add(1, {direction:'inc'})`
- [ ] In `task-queue.ts` on task complete/fail/cancel: `queueDepth.add(-1, {direction:'dec'})` (or `queueDepth.add(1, {direction:'dec'})` — OTel counters are monotonic, so use separate inc/dec tally)
- [ ] In `trace.ts` `completeRunTrace()`: `emitMetric('agentSuccessRate', 1, {status, agentId: trace.agentId})`
- [ ] Commit

---

## P1 — Stability

### Task 3: Unify Checkpoint Data Model (Fix Incompatibility)

**Files:**
- Modify: `packages/server/src/pipelines/checkpoint.ts` (store both stage data AND git SHA in the same object)
- Modify: `packages/server/src/pipelines/pipeline-rollback.ts` (read SHA from unified checkpoint object)
- Modify: `packages/server/src/pipelines/pipeline-engine.ts` (remove duplicate `saveStageCheckpoint` call, use unified checkpoint)

**Goal:** checkpoint.ts and pipeline-rollback.ts share the same `stage_checkpoints` JSON column without data-model conflict.

- [ ] Extend `StageCheckpoint` interface: add optional `gitSha?: string` field
- [ ] In `pipeline-engine.ts` `startStage()`: remove standalone `saveStageCheckpoint(pipelineId, stageIndex, sha)` call; instead save the git SHA as part of the unified checkpoint in `onTaskComplete()`
- [ ] In `pipeline-rollback.ts` `loadStageCheckpoint()`: read `checkpoint.gitSha` instead of reading the raw JSON column directly
- [ ] In `checkpoint.ts` `saveCheckpoint()`: accept optional `gitSha` parameter
- [ ] Test: write a quick test that saves a checkpoint, then reads it back with correct sha
- [ ] Commit

---

### Task 4: Atomic Checkpoint Writes

**Files:**
- Modify: `packages/server/src/pipelines/checkpoint.ts` (use SQL UPDATE with `json_set` or transaction to merge)

**Goal:** Two concurrent stage completions for the same pipeline don't lose each other's checkpoint data.

- [ ] Replace read-parse-modify-write pattern with SQL-level JSON merge:
  ```sql
  UPDATE pipelines
  SET stage_checkpoints = json_set(
    COALESCE(stage_checkpoints, '{}'),
    CONCAT('$.', CAST(? AS TEXT)),
    json(?)
  )
  WHERE id = ?
  ```
- [ ] Or wrap read-modify-write in an explicit `db.transaction()`
- [ ] Commit

---

## P2 — Performance

### Task 5: O(1) Pipeline Stage Lookup

**Files:**
- Modify: `packages/server/src/pipelines/pipeline-engine.ts` (add `taskToPipeline` index Map)

**Goal:** `onTaskComplete()` goes from O(n*m) linear scan to O(1) lookup.

- [ ] Add `private taskToPipeline = new Map<string, {pipelineId: string; stageIndex: number}>()`
- [ ] In `startStage()` after creating the task: `this.taskToPipeline.set(task.id, {pipelineId: pipeline.id, stageIndex})`
- [ ] In `onTaskComplete()`: replace loop with `const ref = this.taskToPipeline.get(taskId); if (!ref) return;`
- [ ] Clear entry after stage completion: `this.taskToPipeline.delete(taskId)`
- [ ] Also clear on cancel and in `retryStage`
- [ ] Commit

---

## Execution Notes

- Tasks 1-2 are independent and can be parallelized
- Task 3 should be done before Task 4 (same files)
- Task 5 is standalone
- Tasks 1, 3, 4, 5 involve the same pipeline-engine.ts file — do them sequentially to avoid merge conflicts
- Recommended order: 1 → 3 → 4 → 2 → 5, or 1+2 in parallel then 3 → 4 → 5

Estimated total: ~2-3 hours.
