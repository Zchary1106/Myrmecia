import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import { storeSessionDocument } from '../src/knowledge/session-documents.js';
import { missingContractInput } from '../src/agents/agent-contract-input.js';

beforeEach(() => vi.stubEnv('DB_PATH', ':memory:'));
afterEach(() => { closeDb(); vi.unstubAllEnvs(); });
function fixture(name = 'approved-spec') {
  const agent = createAgent({ name: 'Contract input fixture', role: 'developer', config: {
    contract: { schemaVersion: '1.0', agentId: 'input-fixture', role: 'developer',
      responsibility: { summary: 'Implement approved changes', owns: ['implementation'], doesNotOwn: [] },
      inputs: [{ name, kind: 'markdown', required: true }],
      outputs: [{ name: 'implementation', kind: 'code', required: true }],
      skills: [], tools: [], quality: { definitionOfDone: ['Implements the spec'] } },
  } });
  const task = createTask({ title: 'Implement feature', input: 'Implement the approved feature',
    description: '', mode: 'direct', workspaceId: 'default' });
  return { agent, task };
}
function document(task: ReturnType<typeof createTask>, name: string) {
  storeSessionDocument(task, name, Buffer.from('# Approved specification\nImplement the feature.'),
    [{ locator: 'Paragraph 1', text: '# Approved specification\nImplement the feature.' }]);
}
describe('required scoped Markdown contract inputs', () => {
  it.each(['approved-spec.md', 'approved-spec.markdown', 'approved-spec.MD'])('accepts the logical input name as %s', name => {
    const { agent, task } = fixture();
    expect(missingContractInput(agent, task)).toContain('approved-spec');
    document(task, name);
    expect(missingContractInput(agent, task)).toBeUndefined();
  });
  it('preserves an explicitly named filename requirement', () => {
    const { agent, task } = fixture('approved-spec.md');
    document(task, 'approved-spec.markdown');
    expect(missingContractInput(agent, task)).toContain('approved-spec.md');
    document(task, 'approved-spec.md');
    expect(missingContractInput(agent, task)).toBeUndefined();
  });
  it('does not substitute a PDF or a loosely matching filename', () => {
    const { agent, task } = fixture();
    for (const name of ['approved-spec.pdf', 'approved-spec-backup.md', 'different-approved-spec.md']) document(task, name);
    expect(missingContractInput(agent, task)).toContain('approved-spec');
  });
  it('does not borrow documents from another session, but inherits an attached session on follow-up', () => {
    const { agent, task } = fixture();
    const other = createTask({ title: 'Other', description: '', input: 'Other', mode: 'direct', workspaceId: 'default' });
    document(other, 'approved-spec.md');
    expect(missingContractInput(agent, task)).toContain('approved-spec');
    document(task, 'approved-spec.md');
    const child = createTask({ title: 'Follow-up', description: '', input: 'Continue', mode: 'direct',
      workspaceId: 'default', parentTaskId: task.id });
    expect(missingContractInput(agent, child)).toBeUndefined();
  });
});
