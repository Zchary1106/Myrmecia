import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { getExecutionArtifact } from '../src/db/models/execution-artifact.js';
import { recoveredResearchContext, saveResearchEvidence } from '../src/agents/research-evidence.js';
import { archiveLongToolOutput } from '../src/agents/tool-output-artifact.js';

beforeEach(() => { process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'research-evidence-')), 'test.db'); });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });

describe('Durable research evidence', () => {
  it('retains complete results and recovers bounded evidence without stale note refs', () => {
    const task = createTask({ title: 'research', description: '', input: '', mode: 'direct' });
    const text = `xhsref_12345678 ${'evidence '.repeat(1000)}`;
    const artifact = saveResearchEvidence(task, 'exec-first', 'call1', 'mcp__xiaohongshu__search_feeds', text);
    expect(getExecutionArtifact(artifact.id)?.content).toBe(text);
    const context = recoveredResearchContext(task, 'exec-retry', ['mcp__xiaohongshu__search_feeds']);
    expect(context).toContain('untrusted source data');
    expect(context).toContain('expired reference');
    expect(context).not.toContain('xhsref_12345678');
    expect(context.length).toBeLessThan(4000);
    expect(recoveredResearchContext(task, 'exec-retry', [])).toBe('');
  });

  it('does not recover another task or workspace evidence but allows user continuation', () => {
    const first = createTask({ title: 'first', description: '', input: '', mode: 'direct' });
    const other = createTask({ title: 'other', description: '', input: '', mode: 'direct' });
    saveResearchEvidence(first, 'exec-first', 'call1', 'web.search', 'scoped evidence');
    expect(recoveredResearchContext(other, 'exec-other', ['web.search'])).toBe('');
    expect(recoveredResearchContext({ ...first, workspaceId: 'other' }, 'exec-retry', ['web.search'])).toBe('');
    expect(recoveredResearchContext({ ...other, parentTaskId: first.id, createdBy: 'user' }, 'exec-next', ['web.search'])).toContain('scoped evidence');
  });

  it('recovers successful historical MCP archives without accepting arbitrary failed tool logs', () => {
    const task = createTask({ title: 'legacy', description: '', input: '', mode: 'direct' });
    archiveLongToolOutput({ task, executionId: 'old', toolExecutionId: 'old-call', toolName: 'mcp__xiaohongshu__search_feeds',
      output: JSON.stringify({ source: 'xiaohongshu MCP', notes: [{ title: 'legacy note', description: 'x'.repeat(3000) }] }) });
    archiveLongToolOutput({ task, executionId: 'old', toolExecutionId: 'failed-call', toolName: 'web.search', output: 'Search failed: ' + 'f'.repeat(3000) });
    const context = recoveredResearchContext(task, 'retry', ['mcp__xiaohongshu__search_feeds', 'web.search']);
    expect(context).toContain('legacy note');
    expect(context).not.toContain('Search failed');
  });
});
