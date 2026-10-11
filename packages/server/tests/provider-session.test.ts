import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { prepareProviderSession } from '../src/models/provider-session.js';
import { CopilotProvider, type CopilotSessionLike } from '../src/models/copilot-provider.js';
import type { RuntimeRequest } from '@myrmecia/shared';
beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });
const request: RuntimeRequest = { modelId: 'fixture', messages: [{ role: 'system', content: [{ type: 'text', text: 'governed' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
function fixture() {
  createAgent({ id: 'fixture', name: 'Fixture', role: 'dev' });
  const task = createTask({ title: 'fixture', input: 'hello', description: '', mode: 'direct', assigneeId: 'fixture', workspaceId: 'w' });
  const run = createExecution({ taskId: task.id, agentDefId: 'fixture', workspaceId: 'w' });
  return { task, run };
}
describe('explicit scoped Provider continuity', () => {
  it('never resumes a pending/unknown SDK session; only a settled read-only boundary can be resumed', () => {
    const f = fixture();
    const first = prepareProviderSession(f.task, f.run.id, 'q1', request);
    first.options.onSessionReady!('sdk-1', false);
    expect(prepareProviderSession(f.task, f.run.id, 'q2', request).options.resumeSessionId).toBeUndefined();
    first.settle();
    expect(prepareProviderSession(f.task, f.run.id, 'q3', request).options.resumeSessionId).toBe('sdk-1');
    expect(prepareProviderSession(f.task, f.run.id, 'q4', { ...request, modelId: 'changed' }).options.resumeSessionId).toBeUndefined();
    expect(prepareProviderSession(f.task, f.run.id, 'q5', { ...request, tools: [{ name: 'write', inputSchema: {} }] }).options.resumeSessionId).toBeUndefined();
  });
  it('calls the actual SDK resume interface with custom-only tools and pending work continuation disabled', async () => {
    const f = fixture();
    const session: CopilotSessionLike = { sessionId: 'sdk-1', on: () => () => {}, sendAndWait: async () => ({ data: { content: 'answer' } }),
      abort: async () => {}, disconnect: async () => {} };
    const resumeSession = vi.fn(async () => session);
    const createSession = vi.fn(async () => session);
    const sdk = new CopilotProvider({}, () => ({ start: async () => {}, stop: async () => [], createSession, resumeSession }));
    const first = prepareProviderSession(f.task, f.run.id, 'q1', request);
    await sdk.complete({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }] }, { providerSession: first.options });
    first.settle();
    const next = prepareProviderSession(f.task, f.run.id, 'q2', request);
    await sdk.complete({ model: 'fixture', messages: [{ role: 'user', content: 'next' }] }, { providerSession: next.options });
    expect(createSession).toHaveBeenCalledOnce();
    expect(resumeSession).toHaveBeenCalledWith('sdk-1', expect.objectContaining({
      continuePendingWork: false, suppressResumeEvent: true, availableTools: [],
    }));
    expect(sdk.supportsSessionResume()).toBe(true);
  });
  it('uses a fresh session when the installed transport does not implement resume, without pretending continuity', async () => {
    const ready = vi.fn();
    const session: CopilotSessionLike = { sessionId: 'fresh', on: () => () => {}, sendAndWait: async () => ({ data: { content: 'answer' } }),
      abort: async () => {}, disconnect: async () => {} };
    const sdk = new CopilotProvider({}, () => ({ start: async () => {}, stop: async () => [], createSession: async () => session }));
    await sdk.complete({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }] }, {
      providerSession: { resumeSessionId: 'previous', onSessionReady: ready },
    });
    expect(ready).toHaveBeenCalledWith('fresh', false);
    expect(sdk.supportsSessionResume()).toBe(false);
  });
});
