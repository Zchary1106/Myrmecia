// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pipeline, RuntimeDiagnostics, Task, TaskExecution } from '@myrmecia/shared';
import { SessionHistory, type SessionHistoryItem } from '../src/components/session/SessionHistory';
import { conversationIdForTask, expandConversationStates, useConversationStore } from '../src/stores/conversations';
import { useStore } from '../src/stores/store';
import { api } from '../src/lib/api';
import { HomeView } from '../src/components/home/HomeView';

const initialHistory = useConversationStore.getState(), initialStore = useStore.getState();
const task: Task = {
  id: 'history-task', title: 'Research hotels', description: '', input: '', mode: 'direct',
  status: 'done', priority: 'normal', createdBy: 'user', assigneeId: 'researcher',
  retryCount: 0, maxRetries: 0, dependsOn: [], createdAt: '2026-09-20T00:00:00Z',
};
const session: SessionHistoryItem = { id: `task:${task.id}`, task, title: task.title, activity: task };
let root: Root, container: HTMLDivElement;
let onSelect: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useConversationStore.setState({ ...initialHistory, states: {}, loaded: true, error: '' }, true);
  useStore.setState({ ...initialStore, diagnostics: null, tasks: [task], agents: [], pipelines: [], executions: [] }, true);
  vi.spyOn(api.conversations, 'list').mockResolvedValue([]);
  onSelect = vi.fn();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useConversationStore.setState(initialHistory, true); useStore.setState(initialStore, true);
  vi.restoreAllMocks();
});
async function render(sessions = [session]) {
  await act(async () => root.render(<SessionHistory sessions={sessions} selectedId={session.id} onSelect={onSelect} onClose={() => {}} />));
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label);
  expect(button, `Button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

describe('Conversation sidebar management', () => {
  it('keeps descendants hidden when pagination omitted their root task', () => {
    const state = expandConversationStates([{ id: session.id, status: 'deleted', taskIds: [task.id, 'child'] }]);
    const child = { ...task, id: 'child', parentTaskId: task.id };
    expect(state.states['task:child']).toBe('deleted');
    expect(conversationIdForTask(child, new Map([['child', child]]), state.conversationIds)).toBe(session.id);
  });
  it('requires confirmation for delete and keeps Cancel non-mutating', async () => {
    const manage = vi.spyOn(api.conversations, 'manage').mockResolvedValue({ states: [{ id: session.id, status: 'deleted', updatedAt: '' }], affectedConversationIds: [session.id] });
    await render();
    await click(`会话操作：${task.title}`); await click('删除会话');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('磁盘文件仍保留');
    expect(manage).not.toHaveBeenCalled();
    await click('取消');
    expect(manage).not.toHaveBeenCalled();
    await click('删除会话'); await click('确认删除');
    expect(manage).toHaveBeenCalledWith([task.id], 'delete', true, false);
    expect(container.querySelector('[data-session-history-id]')).toBeNull();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('archives, restores and reads persisted history after a reload', async () => {
    vi.spyOn(api.conversations, 'manage')
      .mockResolvedValueOnce({ states: [{ id: session.id, status: 'archived', updatedAt: '' }], affectedConversationIds: [session.id] })
      .mockResolvedValueOnce({ states: [], affectedConversationIds: [session.id] });
    const list = vi.spyOn(api.conversations, 'list').mockResolvedValue([{ id: session.id, status: 'archived', updatedAt: '' }]);
    await render(); await click(`会话操作：${task.title}`); await click('归档会话');
    expect(container.querySelector('[data-session-history-id]')).toBeNull();
    await act(async () => useConversationStore.getState().load());
    expect(list).toHaveBeenCalled();
    await click('归档 · 1'); await click(`会话操作：${task.title}`); await click('恢复会话'); await click('会话');
    expect(container.querySelector('[data-session-history-id]')).not.toBeNull();
  });

  it('allows batch archiving running work but disables batch deletion when it is selected', async () => {
    const running = { ...session, id: 'task:running', task: { ...task, id: 'running' }, title: 'Running work', activity: { ...task, status: 'running' as const } };
    const second = { ...session, id: 'task:second', task: { ...task, id: 'second' }, title: 'Second' };
    const manage = vi.spyOn(api.conversations, 'manage').mockResolvedValue({ states: [], affectedConversationIds: [session.id, second.id] });
    await render([session, second, running]); await click('管理');
    expect(container.querySelector<HTMLInputElement>('[aria-label="选择会话：Running work"]')?.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(container.textContent).toContain('已选 3');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="批量删除会话"]')?.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="选择会话：Running work"]')!.click());
    await click('批量归档会话');
    expect(manage).toHaveBeenCalledWith([task.id, 'second'], 'archive', false, false);
  });

  it('keeps a failed deletion visible and reports the server error without hiding anything', async () => {
    vi.spyOn(api.conversations, 'manage').mockRejectedValue(new Error('Stop all work before deleting.'));
    await render(); await click(`会话操作：${task.title}`); await click('删除会话'); await click('确认删除');
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('Stop all work');
    expect(container.querySelector('[data-session-history-id]')).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('disables archive/delete for read-only operators and running sessions', async () => {
    useStore.setState({ diagnostics: { operator: { permissions: { canControlRuntime: false, canDeleteTasks: false } } } as RuntimeDiagnostics });
    await render(); await click(`会话操作：${task.title}`);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.find(item => item.textContent === '归档会话')?.disabled).toBe(true);
    expect(buttons.find(item => item.textContent === '删除会话')?.disabled).toBe(true);
  });

  it.each(['paused', 'awaiting_retry', 'blocked'] as const)('labels a %s workflow truthfully and requires the end-workflow confirmation', async status => {
    const pipelineTask = { ...task, pipelineId: 'history-pipeline' };
    const pipelineSession = { ...session, id: 'pipeline:history-pipeline', task: pipelineTask, activity: pipelineTask };
    useStore.setState({ tasks: [pipelineTask], pipelines: [{ id: 'history-pipeline', status, stages: [] } as unknown as Pipeline] });
    const manage = vi.spyOn(api.conversations, 'manage').mockResolvedValue({ states: [], affectedConversationIds: [pipelineSession.id] });
    await render([pipelineSession]);
    expect(container.textContent).not.toContain('Completed');
    expect(container.textContent).toContain({ paused: '流程已暂停', awaiting_retry: '等待重试', blocked: '流程受阻' }[status]);
    await click(`会话操作：${task.title}`); await click('删除会话');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('不会发布内容');
    expect(manage).not.toHaveBeenCalled();
    await click('取消');
    expect(manage).not.toHaveBeenCalled();
    await click('删除会话'); await click('结束流程并删除');
    expect(manage).toHaveBeenCalledWith([task.id], 'delete', true, true);
  });

  it('archives a running session without enabling deletion', async () => {
    const running = { ...task, status: 'running' as const };
    useStore.setState({ tasks: [running] });
    const manage = vi.spyOn(api.conversations, 'manage').mockResolvedValue({ states: [], affectedConversationIds: [] });
    await render([{ ...session, task: running, activity: running }]);
    await click(`会话操作：${task.title}`);
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '删除会话')?.disabled).toBe(true);
    await click('归档会话');
    expect(manage).toHaveBeenCalledWith([task.id], 'archive', false, false);
  });

  it('blocks deletion for live executions, omitted active descendants and unavailable workflows', async () => {
    const child = { ...task, id: 'hidden-child', parentTaskId: task.id, status: 'running' as const };
    useStore.setState({ tasks: [task, child] });
    await render(); await click(`会话操作：${task.title}`);
    const deleteButton = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '删除会话');
    expect(deleteButton()?.disabled).toBe(true);
    await act(async () => useStore.setState({ tasks: [task], executions: [{ taskId: task.id, status: 'running' } as TaskExecution] }));
    expect(deleteButton()?.disabled).toBe(true);
    await act(async () => useStore.setState({ executions: [] }));
    const pipelineTask = { ...task, pipelineId: 'missing-pipeline' };
    await render([{ ...session, id: 'pipeline:missing-pipeline', task: pipelineTask, activity: pipelineTask }]);
    await click(`会话操作：${task.title}`);
    expect(deleteButton()?.disabled).toBe(true);
  });

  it('disables confirmation if work becomes active while the dialog is open', async () => {
    const manage = vi.spyOn(api.conversations, 'manage');
    await render(); await click(`会话操作：${task.title}`); await click('删除会话');
    await act(async () => useStore.setState({ tasks: [{ ...task, status: 'running' }] }));
    expect(document.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')?.disabled).toBe(true);
    await click('确认删除');
    expect(manage).not.toHaveBeenCalled();
  });

  it('removes archived/deleted conversations from Home but preserves unrelated entries', async () => {
    useStore.setState({
      tasks: [task, { ...task, id: 'archived' }, { ...task, id: 'deleted' }],
      loadModels: vi.fn(), models: [], loadTasks: vi.fn(), inboxEntries: [],
    });
    useConversationStore.setState({ states: { 'task:archived': 'archived', 'task:deleted': 'deleted' } });
    vi.spyOn(api.models, 'providerSettings').mockRejectedValue(new Error('No provider'));
    vi.spyOn(api.teams, 'list').mockResolvedValue([]);
    vi.spyOn(api.mcp, 'servers').mockResolvedValue([]);
    await act(async () => root.render(<HomeView />));
    expect(container.querySelectorAll('[data-home-conversation]')).toHaveLength(1);
    expect(container.querySelector('[data-home-conversation]')?.getAttribute('data-home-conversation')).toBe(session.id);
  });
});
