// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskExecution, TaskControlCapabilities } from '@myrmecia/shared';
import { AgentBudgetEditor } from '../src/components/agents/AgentBudgetEditor';
import { AgentSetupDebug } from '../src/components/agents/AgentSetupDebug';
import { api } from '../src/lib/api';
const task = { id: 'debug-one', title: 'fixture', input: 'fixture', description: 'fixture request',
  status: 'running', mode: 'direct', assigneeId: 'agent', workspaceId: 'default' } as Task;
const run = { id: 'run-one', taskId: task.id, agentDefId: 'agent', status: 'running', startedAt: '' } as TaskExecution;
const caps = (allowed: string[] = ['pause', 'cancel', 'followup']): TaskControlCapabilities => ({
  taskId: task.id, executionId: run.id, state: 'running', operations: Object.fromEntries(
    ['pause', 'resume', 'cancel', 'followup', 'rerun', 'accept'].map(key => [key, { allowed: allowed.includes(key), reason: `${key} server boundary` }])) as TaskControlCapabilities['operations'],
});
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(api.agents.budget, 'get').mockResolvedValue({ revision: 3,
    limits: { maxTurns: 3, timeoutSeconds: 60, maxConcurrent: 1, period: 'lifetime' }, usage: [] });
  vi.spyOn(api.agents.budget, 'save').mockResolvedValue({ revision: 4, limits: null, usage: [] });
  vi.spyOn(api.tasks, 'get').mockResolvedValue(structuredClone(task));
  vi.spyOn(api.tasks, 'controls').mockResolvedValue(caps());
  vi.spyOn(api.tasks, 'budget').mockResolvedValue([]);
  vi.spyOn(api.tasks, 'debugHistory').mockResolvedValue([task.id]);
  vi.spyOn(api.tasks, 'pause').mockResolvedValue(task);
  vi.spyOn(api.tasks, 'resume').mockResolvedValue(task);
  vi.spyOn(api.tasks, 'cancel').mockResolvedValue(task);
  vi.spyOn(api.tasks, 'continue').mockResolvedValue({ ...task, id: 'debug-followup' });
  vi.spyOn(api.tasks, 'rerun').mockResolvedValue({ ...task, id: 'debug-two' });
  vi.spyOn(api.executions, 'review').mockResolvedValue(run);
  vi.spyOn(api.executions, 'sendMessage').mockResolvedValue({});
  vi.spyOn(api.executions, 'list').mockResolvedValue([run]);
  vi.spyOn(api.executions, 'messages').mockResolvedValue([]);
  vi.spyOn(api.executions, 'agentConfig').mockResolvedValue({ source: 'legacy', pinnedBeforeDispatch: false });
  vi.spyOn(api.artifacts, 'workbench').mockResolvedValue([]);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const click = (text: string) => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text)!.click());
async function fill(label: string, value: string) {
  const element = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const debug = () => act(async () => root.render(<AgentSetupDebug taskId={task.id} agentName="Fixture" />));
describe('budget and inline debug governance', () => {
  it('loads existing limits and saves only on explicit request with expected revision', async () => {
    await act(async () => root.render(<AgentBudgetEditor agentId="agent" />));
    expect((container.querySelector('[aria-label="最大轮数"]') as HTMLInputElement).value).toBe('3');
    expect(api.agents.budget.save).not.toHaveBeenCalled();
    await fill('Token 配额', '900'); await click('保存预算 · r3');
    expect(api.agents.budget.save).toHaveBeenCalledWith('agent', 3, expect.objectContaining({ maxTokens: 900 }));
    expect(container.textContent).toContain('订阅模型不能');
  });
  it('preserves policy edits on conflict instead of silently overwriting', async () => {
    vi.mocked(api.agents.budget.save).mockRejectedValue(new Error('BUDGET_REVISION_CONFLICT'));
    await act(async () => root.render(<AgentBudgetEditor agentId="agent" />));
    await fill('Token 配额', '900'); await click('保存预算 · r3');
    expect(container.textContent).toContain('BUDGET_REVISION_CONFLICT');
    expect((container.querySelector('[aria-label="Token 配额"]') as HTMLInputElement).value).toBe('900');
  });
  it('refreshes usage without discarding unsaved edits or silently adopting a newer revision', async () => {
    await act(async () => root.render(<AgentBudgetEditor agentId="agent" />));
    await fill('Token 配额', '900');
    await click('刷新用量');
    expect((container.querySelector('[aria-label="Token 配额"]') as HTMLInputElement).value).toBe('900');
    vi.mocked(api.agents.budget.get).mockResolvedValue({ revision: 4,
      limits: { maxTurns: 9, timeoutSeconds: 60, maxConcurrent: 1, period: 'lifetime' }, usage: [] });
    await click('刷新用量');
    expect(container.textContent).toContain('预算版本已变更');
    expect((container.querySelector('[aria-label="Token 配额"]') as HTMLInputElement).value).toBe('900');
    expect([...container.querySelectorAll('button')].find(button => button.textContent === '保存预算 · r3')!.disabled).toBe(true);
    vi.mocked(window.confirm).mockReturnValue(false);
    await click('重新读取预算');
    expect((container.querySelector('[aria-label="Token 配额"]') as HTMLInputElement).value).toBe('900');
    vi.mocked(window.confirm).mockReturnValue(true);
    await click('重新读取预算');
    expect((container.querySelector('[aria-label="最大轮数"]') as HTMLInputElement).value).toBe('9');
  });
  it('does not optimistically claim paused and honors unsafe resume capability', async () => {
    await debug();
    vi.mocked(api.tasks.get).mockResolvedValue({ ...task, pauseControl: { state: 'requested', requestedAt: '' } });
    vi.mocked(api.tasks.controls).mockResolvedValue(caps(['cancel']));
    await click('暂停');
    expect(container.textContent).toContain('正在暂停，等待安全边界');
    expect([...container.querySelectorAll('button')].find(button => button.textContent === '恢复')!.disabled).toBe(true);
    expect(api.tasks.resume).not.toHaveBeenCalled();
  });
  it('requires confirmation and preserves the same rerun key after response loss', async () => {
    vi.mocked(api.tasks.get).mockResolvedValue({ ...task, status: 'done' });
    vi.mocked(api.tasks.controls).mockResolvedValue(caps(['rerun', 'accept', 'followup']));
    vi.mocked(api.executions.list).mockResolvedValue([{ ...run, status: 'done' }]);
    vi.mocked(api.tasks.rerun).mockRejectedValueOnce(new Error('Lost response'));
    await debug();
    vi.mocked(window.confirm).mockReturnValue(false); await click('重新试运行');
    expect(api.tasks.rerun).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true); await click('重新试运行');
    vi.mocked(api.tasks.debugHistory).mockResolvedValue([task.id, 'debug-two']);
    await click('重新试运行');
    expect(vi.mocked(api.tasks.rerun).mock.calls[0][1]).toBe(vi.mocked(api.tasks.rerun).mock.calls[1][1]);
    expect(container.querySelectorAll('[aria-label="Debug task history"] option')).toHaveLength(2);
    expect(api.tasks.get).toHaveBeenCalledWith('debug-two');
  });
  it('queues running follow-up and creates idempotent new task for a completed follow-up', async () => {
    await debug(); await fill('Debug follow-up instruction', 'Follow this evidence'); await click('发送追问');
    expect(api.executions.sendMessage).toHaveBeenCalledWith(run.id, 'Follow this evidence', 'user_follow_up', 'follow_up', expect.any(String));
    expect(api.tasks.continue).not.toHaveBeenCalled();
    vi.mocked(api.tasks.get).mockResolvedValue({ ...task, status: 'done' });
    vi.mocked(api.executions.list).mockResolvedValue([{ ...run, status: 'done' }]);
    await click('刷新状态'); await fill('Debug follow-up instruction', 'New question'); await click('发送追问');
    expect(api.tasks.continue).toHaveBeenCalledWith(task.id, 'New question', expect.any(String));
  });
  it('blocks acceptance until server permission and displays server error without false success', async () => {
    await debug(); await click('验收通过'); expect(api.executions.review).not.toHaveBeenCalled();
    vi.mocked(api.tasks.controls).mockResolvedValue(caps(['accept']));
    vi.mocked(api.executions.review).mockRejectedValue(new Error('Evidence is stale'));
    await click('刷新状态'); await click('验收通过');
    expect(container.textContent).toContain('Evidence is stale');
    expect(container.textContent).not.toContain('已记录验收通过');
  });
  it('ignores delayed responses from a previously selected task', async () => {
    let resolveOld!: (value: Task) => void;
    const old = new Promise<Task>(resolve => { resolveOld = resolve; });
    vi.mocked(api.tasks.get).mockImplementation(id => id === task.id ? old :
      Promise.resolve({ ...task, id, status: 'done', output: 'Current task output' }));
    vi.mocked(api.executions.list).mockResolvedValue([]);
    await act(async () => root.render(<AgentSetupDebug taskId={task.id} agentName="Old" />));
    await act(async () => root.render(<AgentSetupDebug taskId="current-task" agentName="Current" />));
    expect(container.textContent).toContain('Current task output');
    await act(async () => resolveOld({ ...task, status: 'failed', error: 'Old task error', output: 'Stale output' }));
    expect(container.textContent).toContain('Current task output');
    expect(container.textContent).not.toContain('Old task error');
    expect(container.textContent).not.toContain('Stale output');
  });
  it('preserves the last response during a refresh failure and reconciles on window focus', async () => {
    vi.mocked(api.tasks.get).mockResolvedValue({ ...task, status: 'done', output: 'Retained output' });
    vi.mocked(api.executions.list).mockResolvedValue([{ ...run, status: 'done' }]);
    await debug();
    vi.mocked(api.tasks.get).mockRejectedValueOnce(new Error('temporary disconnect'));
    await click('刷新状态');
    expect(container.textContent).toContain('Retained output');
    expect(container.textContent).toContain('无法同步试运行状态');
    vi.mocked(api.tasks.get).mockResolvedValue({ ...task, status: 'done', output: 'Reconnected output' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toContain('Reconnected output');
    expect(container.textContent).not.toContain('无法同步试运行状态');
  });
});
