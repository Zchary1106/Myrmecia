import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { getExecutionArtifact } from '../src/db/models/execution-artifact.js';
import { archiveContextSummary, archiveLongToolOutput } from '../src/agents/tool-output-artifact.js';
import { nextContextSummaryVersion } from '../src/agents/context-state.js';
import { readArtifactSnapshot } from '../src/artifacts/artifact-snapshot-store.js';

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

  it('allocates later summary versions from sealed evidence after context usage is refreshed', () => {
    const task = createTask({ title: 'Follow-up compaction', description: '', mode: 'direct', input: '' });
    const first = archiveContextSummary({ task, executionId: 'exec-follow-up', version: 2, summary: 'First immutable summary.' });
    const next = nextContextSummaryVersion(task);
    expect(next).toBe(3);
    const second = archiveContextSummary({ task, executionId: 'exec-follow-up', version: next, summary: 'Updated immutable summary.' });
    expect(second).not.toBe(first);
    expect(readArtifactSnapshot(getExecutionArtifact(first)!)?.toString()).toBe('First immutable summary.');
    expect(readArtifactSnapshot(getExecutionArtifact(second)!)?.toString()).toBe('Updated immutable summary.');
  });

  it('keeps complete first notes in upstream order rather than first/last broken JSON', () => {
    const task = createTask({ title: 'Search', description: '', mode: 'direct', input: '前三条标题和链接' });
    const notes = Array.from({ length: 12 }, (_, index) => ({
      title: `第 ${index + 1} 条真实标题`,
      author: 'Fixture author',
      source_url: `https://www.xiaohongshu.com/explore/fixture_${index}`,
      note_ref: `xhsref_${'b'.repeat(32)}`,
      interactions: { likes: '1000', irrelevant: 'x'.repeat(300) },
    }));
    const raw = JSON.stringify({ source: 'xiaohongshu MCP', retrieved_at: '2026-10-09T00:00:00.000Z', notes });
    const inline = archiveLongToolOutput({ task, executionId: 'exec-xhs', toolExecutionId: 'xhs-search',
      toolName: 'mcp__xiaohongshu__search_feeds', output: raw });
    const packet = JSON.parse(inline);
    expect(inline.length).toBeLessThanOrEqual(2000);
    expect(packet.notes.slice(0, 3)).toEqual(notes.slice(0, 3).map(({ title, author, source_url, note_ref }) =>
      ({ title, author, source_url, note_ref })));
    expect(packet.notes.length).toBeGreaterThanOrEqual(3);
    expect(packet.omitted_note_count).toBe(notes.length - packet.notes.length);
    const artifactId = packet.artifact_ref.slice('artifact://'.length);
    expect(getExecutionArtifact(artifactId)?.content).toBe(raw);
  });

  it('does not inline arbitrary credentials/media and marks overlong titles as excerpts', () => {
    const task = createTask({ title: 'Search bounds', description: '', mode: 'direct', input: '' });
    const raw = JSON.stringify({ source: 'xiaohongshu MCP', notes: [{
      title: 't'.repeat(3000), source_url: 'https://www.xiaohongshu.com/explore/fixture',
      xsec_token: 'fixture-secret', media_url: 'https://example.test/media', note_ref: 'invalid-opaque-ref',
    }] });
    const inline = archiveLongToolOutput({ task, executionId: 'exec-bounds', toolExecutionId: 'bounds',
      toolName: 'mcp__xiaohongshu__search_feeds', output: raw });
    const packet = JSON.parse(inline);
    expect(packet.notes[0]).toMatchObject({ title: 't'.repeat(240), title_truncated: true });
    expect(inline).not.toContain('fixture-secret');
    expect(inline).not.toContain('example.test');
    expect(inline).not.toContain('invalid-opaque-ref');
    expect(inline.length).toBeLessThanOrEqual(2000);
  });

  it('does not manufacture source records from an invalid canonical URL', () => {
    const task = createTask({ title: 'Invalid source', description: '', mode: 'direct', input: '' });
    const raw = JSON.stringify({ source: 'xiaohongshu MCP', notes: [{
      title: 'bad source', source_url: 'https://www.xiaohongshu.com/explore/fixture?xsec_token=fixture-secret',
      description: 'x'.repeat(3000),
    }] });
    const inline = archiveLongToolOutput({ task, executionId: 'exec-invalid', toolExecutionId: 'invalid',
      toolName: 'mcp__xiaohongshu__search_feeds', output: raw });
    expect(JSON.parse(inline).notes).toEqual([]);
    expect(inline).not.toContain('fixture-secret');
  });
});
