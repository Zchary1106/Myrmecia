// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvaluationRun, AgentEvaluationSuite, AgentConfigVersion } from '@myrmecia/shared';
import { AgentEvaluationEditor } from '../src/components/agents/AgentEvaluationEditor';
import { AgentEvaluationResults } from '../src/components/agents/AgentEvaluationResults';
import { api } from '../src/lib/api';

const suite: AgentEvaluationSuite = { schemaVersion: 1, id: 'suite-1', agentId: 'agent-1', workspaceId: 'default', actorId: 'actor-a',
  name: 'Regression', revision: 1, hash: 's'.repeat(64), createdAt: '', updatedAt: '', cases: [
    { id: 'one', name: 'First case', prompt: 'First prompt', checks: [{ id: 'contains', label: 'Expected text', required: true, verifier: 'output_contains', text: 'Expected' }] },
    { id: 'two', name: 'Second case', prompt: 'Second prompt', checks: [{ id: 'human', label: 'Quality', required: true, verifier: 'human_review', rubric: 'Correct reasoning' }] },
  ] };
const version = { id: 'version-1', sequence: 1, snapshot: { config: { model: 'fixture-model' } } } as AgentConfigVersion;
const run: AgentEvaluationRun = { schemaVersion: 1, id: 'run-1', agentId: 'agent-1', workspaceId: 'default', actorId: 'actor-a',
  suiteId: suite.id, suiteRevision: 1, suiteHash: suite.hash, suiteSnapshot: { name: suite.name, cases: suite.cases },
  configVersionId: version.id, configSequence: 1, configHash: 'a'.repeat(64), selectedCaseIds: ['one', 'two'],
  createdAt: '2026-10-11T00:00:00Z', results: [
    { caseId: 'one', status: 'pending', humanReviewRequired: false, transport: 'unknown' },
    { caseId: 'two', status: 'pending', humanReviewRequired: true, transport: 'unknown' },
  ], counts: { pending: 2, running: 0, passed: 0, failed: 0, unavailable: 0 } };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(api.agents.evaluations, 'suites').mockResolvedValue([structuredClone(suite)]);
  vi.spyOn(api.agents.evaluations, 'history').mockResolvedValue([]);
  vi.spyOn(api.agents.evaluations, 'get').mockResolvedValue(structuredClone(run));
  vi.spyOn(api.agents.evaluations, 'save').mockResolvedValue(structuredClone(suite));
  vi.spyOn(api.agents.evaluations, 'start').mockResolvedValue(structuredClone(run));
  vi.spyOn(api.agents.evaluations, 'next').mockResolvedValue(structuredClone(run));
  vi.spyOn(api.agents.versions, 'list').mockResolvedValue({ versions: [version], activeVersionId: version.id,
    workingConfigHash: 'a'.repeat(64), workingChanges: [] });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers();
});
const mount = () => act(async () => root.render(<AgentEvaluationEditor agentId="agent-1" />));
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!;
const click = (text: string) => act(async () => button(text).click());
async function fill(label: string, value: string) {
  const element = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
  const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('saved evaluation UI', () => {
  it('loads saved cases and requires explicit selection/confirmation, never runs on mount', async () => {
    await mount();
    expect(container.textContent).toContain('First case'); expect(container.textContent).toContain('人工审查');
    expect(api.agents.evaluations.start).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(false);
    await click('运行选中用例'); expect(api.agents.evaluations.start).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    const checks = [...container.querySelectorAll('input[type=checkbox]')];
    const second = checks.find(item => item.parentElement?.textContent === 'Second case') as HTMLInputElement;
    await act(async () => second.click());
    await click('运行选中用例');
    expect(api.agents.evaluations.start).toHaveBeenCalledWith('agent-1', suite.id, {
      selectedCaseIds: ['one'], expectedSuiteRevision: 1, configVersionId: version.id,
    }, expect.any(String));
    expect(api.agents.evaluations.next).not.toHaveBeenCalled();
  });
  it('requires a saved revision after editing and preserves a lost-response submission key', async () => {
    await mount();
    await fill('用例 1 指令', 'Changed prompt');
    expect(button('运行选中用例')).toBeUndefined();
    expect(container.textContent).toContain('先保存用例');
    await click('保存套件');
    expect(api.agents.evaluations.save).toHaveBeenCalledWith('agent-1', suite.id, expect.objectContaining({ expectedRevision: 1 }));
    vi.mocked(api.agents.evaluations.start).mockRejectedValueOnce(new Error('Response lost'));
    await click('运行选中用例');
    expect(container.textContent).toContain('提交响应未确认');
    expect(container.querySelector('fieldset')?.disabled).toBe(true);
    await click('恢复本次提交');
    const calls = vi.mocked(api.agents.evaluations.start).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
    expect(container.querySelector('fieldset')?.disabled).toBe(false);
  });
  it('surfaces save conflicts without clearing edits or dispatching', async () => {
    await mount(); await fill('套件名称', 'Edited regression');
    vi.mocked(api.agents.evaluations.save).mockRejectedValue(new Error('Suite changed; reload before saving'));
    await click('保存套件');
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Suite changed');
    expect((container.querySelector('[aria-label="套件名称"]') as HTMLInputElement).value).toBe('Edited regression');
    expect(api.agents.evaluations.start).not.toHaveBeenCalled();
  });
  it('polls only existing task status, never automatically advances after completion', async () => {
    vi.useFakeTimers();
    const running = { ...run, results: [{ ...run.results[0], taskId: 'task-1', status: 'running' as const }, run.results[1]],
      counts: { ...run.counts, pending: 1, running: 1 } };
    const completed = { ...running, results: [{ ...running.results[0], status: 'passed' as const }, run.results[1]],
      counts: { ...run.counts, pending: 1, running: 0, passed: 1 } };
    vi.mocked(api.agents.evaluations.history).mockResolvedValue([running]);
    vi.mocked(api.agents.evaluations.get).mockResolvedValue(completed);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.agents.evaluations.get).toHaveBeenCalledWith('agent-1', 'run-1');
    expect(api.agents.evaluations.start).not.toHaveBeenCalled(); expect(api.agents.evaluations.next).not.toHaveBeenCalled();
    expect(button('运行下一条').disabled).toBe(false);
    await click('运行下一条');
    expect(api.agents.evaluations.next).toHaveBeenCalledWith('agent-1', 'run-1', 'two');
  });
  it('renders distinct counts, fixture attribution, Markdown and evidence; mismatched suites are not regressions', async () => {
    const completed: AgentEvaluationRun = { ...run, counts: { passed: 1, unavailable: 1, failed: 0, pending: 0, running: 0 },
      results: [{ ...run.results[0], status: 'passed', transport: 'fixture', output: '## Result\n\n**Expected**',
        verification: { schemaVersion: 1, status: 'passed', checkedAt: '', contractSha256: 'c'.repeat(64),
          criteria: [{ criterionId: 'contains', verifier: 'output_contains', required: true, status: 'passed', scope: 'output',
            message: 'Literal check', evidence: [{ ref: 'execution://one/output', sha256: 'e'.repeat(64) }] }] } },
      { ...run.results[1], status: 'unavailable' }] };
    await act(async () => root.render(<AgentEvaluationResults run={completed} compare={{ ...run, id: 'old', suiteHash: 'different' }} busy={false} onNext={vi.fn()} />));
    expect(container.textContent).toContain('通过 1'); expect(container.textContent).toContain('待人工审查 1');
    expect(container.textContent).toContain('Fixture 模拟模型'); expect(container.textContent).toContain('不作为版本回归结论');
    expect(container.querySelector('h2')?.textContent).toBe('Result'); expect(container.querySelector('strong')?.textContent).toBe('Expected');
    expect(container.textContent).toContain('execution://one/output'); expect(container.textContent).toContain('必须人工审查');
  });
  it('compares like-for-like revisions without combining unavailable/pending into passed', async () => {
    await act(async () => root.render(<AgentEvaluationResults run={run} compare={{ ...run, id: 'old', configSequence: 2 }} busy={false} onNext={vi.fn()} />));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.textContent).toContain('v2 → v1');
    expect(container.textContent).toContain('待运行 2');
    expect(container.textContent).not.toContain('不作为版本回归结论');
  });
});
