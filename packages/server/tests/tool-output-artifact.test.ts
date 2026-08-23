import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { getExecutionArtifact } from '../src/db/models/execution-artifact.js';
import { archiveContextSummary, archiveLongToolOutput } from '../src/agents/tool-output-artifact.js';

let testDir = '';

describe('tool output artifacts', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'myrmecia-tool-output-'));
    process.env.DB_PATH = join(testDir, 'test.db');
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('archives long logs and returns a bounded evidence reference to the model', () => {
    const task = createTask({ title: 'Tool task', description: 'Inspect logs', mode: 'direct', input: 'inspect' });
    const raw = `first line\n${'x'.repeat(4_000)}\nlast line`;
    const promptOutput = archiveLongToolOutput({ task, executionId: 'exec-tool-output', toolExecutionId: 'tool-1', toolName: 'shell', output: raw });
    const id = promptOutput.match(/artifact (xart_[a-f0-9]+)/)?.[1];
    expect(id).toBeTruthy();
    expect(promptOutput.length).toBeLessThan(raw.length);
    expect(getExecutionArtifact(id!)).toMatchObject({ content: raw, taskId: task.id, executionId: 'exec-tool-output' });
  });

  it('stores each context compaction summary at a stable versioned artifact path', () => {
    const task = createTask({ title: 'Summary task', description: 'Compact context', mode: 'direct', input: 'compact' });
    const id = archiveContextSummary({ task, executionId: 'exec-summary', version: 2, summary: 'Fixed constraint and pending test evidence.' });
    expect(getExecutionArtifact(id)).toMatchObject({
      relativePath: '__context_summaries__/v2.md',
      content: 'Fixed constraint and pending test evidence.',
      metadata: { summaryVersion: 2, contextCompaction: true },
    });
  });
});
