// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary, AgentSetupPreflight, AgentSetupDraft, Task, TaskExecution } from '@myrmecia/shared';
import { AgentSetupWizard } from '../src/components/agents/AgentSetupWizard';
import { AgentSetupDebug } from '../src/components/agents/AgentSetupDebug';
import { api, ApiError } from '../src/lib/api';
import { SetupDraftSession } from '../src/lib/agent-setup-draft';
import { useStore } from '../src/stores/store';

const original = useStore.getState();
const agent = {
  id: 'setup-agent', name: 'Fixture researcher', role: 'researcher', emoji: '🔎', description: 'Read and summarize',
  model: 'fixture-model', config: {}, capabilities: [], triggers: [], whenToUse: '', activeExecutions: 0,
  stats: { tasksCompleted: 0, tasksFailed: 0, avgDurationMs: 0 }, createdAt: '', updatedAt: '',
} as AgentSummary;
const task: Task = {
  id: 'setup-task', title: 'Test run', description: 'Compare **A** and B', input: 'fixture',
  status: 'running', mode: 'direct', priority: 'normal', assigneeId: agent.id, createdBy: 'user',
  createdAt: '2026-10-11T00:00:00Z', retryCount: 0, maxRetries: 0, dependsOn: [],
};
const execution = { id: 'setup-execution', taskId: task.id, agentDefId: agent.id, modelId: 'fixture-model',
  actualModelId: 'actual-fixture-model', status: 'running', startedAt: task.createdAt } as TaskExecution;
const preflight: AgentSetupPreflight = {
  checkedAt: '2026-10-11T00:00:00Z', canTest: true, status: 'needs_attention',
  model: { requestedId: 'fixture-model', provider: 'fixture', health: 'unknown' },
  checks: [{ id: 'model', label: '模型', status: 'unknown', blocking: false, message: '没有实际调用验证' }],
};
let root: Root;
let container: HTMLDivElement;
let onCreated: ReturnType<typeof vi.fn>;
const templates = [{ name: agent.name, role: agent.role, emoji: '🔎', description: agent.description!, capabilities: '', triggers: '', allowedTools: [] }];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); onCreated = vi.fn();
  useStore.setState({ tools: [], skills: [], agents: [], streamingResponses: {},
    loadTools: vi.fn(), loadSkills: vi.fn(), loadSkillAssignments: vi.fn(), loadAgents: vi.fn() });
  vi.spyOn(api.mcp, 'tools').mockResolvedValue([]);
  vi.spyOn(api.agents.drafts, 'list').mockResolvedValue([]);
  const drafts = new Map<string, AgentSetupDraft>();
  vi.spyOn(api.agents.drafts, 'save').mockImplementation(async (id, data) => {
    const previous = drafts.get(id);
    const draft: AgentSetupDraft = {
      schemaVersion: 1, id, workspaceId: 'default', actorId: 'local',
      revision: (previous?.revision || 0) + 1, ...data,
      creationKey: previous?.creationKey || crypto.randomUUID(), testKey: previous?.testKey || crypto.randomUUID(),
      bound: false, stage: data.locked ? 'creating' : 'draft', createdAt: '', updatedAt: '',
    };
    drafts.set(id, draft); return draft;
  });
  vi.spyOn(api.agents.drafts, 'get').mockImplementation(async id => drafts.get(id)!);
  vi.spyOn(api.agents, 'create').mockResolvedValue(agent);
  vi.spyOn(api.agents, 'preflight').mockResolvedValue(preflight);
  vi.spyOn(api.agents, 'preflightSaved').mockResolvedValue(preflight);
  vi.spyOn(api.agents, 'test').mockResolvedValue({ taskId: task.id, status: 'running', replayed: false });
  vi.spyOn(api.tasks, 'get').mockResolvedValue(task);
  vi.spyOn(api.executions, 'list').mockResolvedValue([execution]);
  vi.spyOn(api.executions, 'messages').mockResolvedValue([]);
  vi.spyOn(api.executions, 'agentConfig').mockResolvedValue({ source: 'legacy', pinnedBeforeDispatch: false });
  vi.spyOn(api.agents.versions, 'list').mockResolvedValue({
    activeVersionId: null, workingConfigHash: 'a'.repeat(64), workingChanges: ['unpublished'], versions: [],
  });
  vi.spyOn(api.agents.evaluations, 'suites').mockResolvedValue([]);
  vi.spyOn(api.agents.evaluations, 'history').mockResolvedValue([]);
  vi.spyOn(api.agents.knowledge, 'list').mockResolvedValue({ agentPrivate: [], teams: [], unbound: [] });
  vi.spyOn(api.agents.budget, 'get').mockResolvedValue({ revision: 0, limits: null, usage: [] });
  vi.spyOn(api.tasks, 'controls').mockRejectedValue(new Error('fixture controls unavailable'));
  vi.spyOn(api.tasks, 'budget').mockResolvedValue([]);
  vi.spyOn(api.tasks, 'debugHistory').mockResolvedValue([task.id]);
  vi.spyOn(api.artifacts, 'workbench').mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); useStore.setState(original, true);
  vi.restoreAllMocks(); vi.useRealTimers();
});
async function wizard() {
  await act(async () => root.render(<AgentSetupWizard open onClose={vi.fn()} onCreated={onCreated}
    templates={templates} toolPresets={[]} modelOptions={[{ value: 'fixture-model', label: 'Fixture', hint: '' }]} />));
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function finalStep() { await click('4. Test'); }
async function prompt(text = 'Compare A and B') {
  const input = container.querySelector<HTMLTextAreaElement>('[aria-label="单次测试指令"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Agent setup steps', () => {
  it('restores a draft after remount without automatically creating or dispatching', async () => {
    await wizard(); await finalStep(); await prompt('Persisted instruction'); await click('仅保存 Agent');
    const saved = vi.mocked(api.agents.drafts.save).mock.calls.at(-1)!;
    const draft: AgentSetupDraft = {
      schemaVersion: 1, id: saved[0], workspaceId: 'default', actorId: 'local', revision: 4,
      ...saved[1], creationKey: vi.mocked(api.agents.create).mock.calls[0][1]!, testKey: 'test-key-123',
      agentId: agent.id, bound: true, stage: 'saved', createdAt: '', updatedAt: '',
    };
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.mocked(api.agents.drafts.list).mockResolvedValue([draft]);
    vi.mocked(api.agents.drafts.get).mockResolvedValue(draft);
    vi.spyOn(api.agents, 'get').mockResolvedValue(agent);
    await wizard();
    expect(container.textContent).toContain('发现未清理');
    await click('恢复草稿');
    expect(container.textContent).toContain('不会自动提交');
    expect(api.agents.create).toHaveBeenCalledTimes(1);
    expect(api.agents.test).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="单次测试指令"]')?.value).toBe('Persisted instruction');
  });
  it('stops creation after a draft revision conflict', async () => {
    vi.mocked(api.agents.drafts.save).mockRejectedValue(new ApiError('草稿已在其他窗口更新', 409, 'DRAFT_REVISION_CONFLICT'));
    await wizard(); await finalStep(); await click('仅保存 Agent');
    expect(api.agents.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain('重新加载草稿');
  });
  it('flushes current edits when closing the wizard', async () => {
    const close = vi.fn();
    await act(async () => root.render(<AgentSetupWizard open onClose={close} onCreated={onCreated}
      templates={templates} toolPresets={[]} modelOptions={[{ value: 'fixture-model', label: 'Fixture', hint: '' }]} />));
    await finalStep(); await prompt('Save on close');
    await click('Close');
    expect(close).toHaveBeenCalledOnce();
    expect(vi.mocked(api.agents.drafts.save).mock.calls.at(-1)![1].form.testPrompt).toBe('Save on close');
    expect(api.agents.test).not.toHaveBeenCalled();
  });
  it('keeps the wizard open if saving before close fails', async () => {
    const close = vi.fn();
    await act(async () => root.render(<AgentSetupWizard open onClose={close} onCreated={onCreated}
      templates={templates} toolPresets={[]} modelOptions={[{ value: 'fixture-model', label: 'Fixture', hint: '' }]} />));
    vi.mocked(api.agents.drafts.save).mockRejectedValueOnce(new Error('offline'));
    await click('Close');
    expect(close).not.toHaveBeenCalled();
    expect(container.textContent).toContain('草稿未保存');
  });
  it('saves a structured responsibility contract with independent system instructions and routing', async () => {
    await wizard();
    const edit = async (label: string, text: string) => {
      const element = [...container.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))!
        .querySelector('textarea')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, text);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await edit('何时调用', 'For research questions');
    await edit('系统指令', 'Respond in concise Chinese');
    const checkbox = container.querySelector<HTMLInputElement>('[aria-label="职责与交付契约"] input[type=checkbox]')!;
    await act(async () => checkbox.click());
    await edit('负责什么', 'Research sources');
    await edit('不负责什么', 'Publishing');
    await edit('完成标准', 'Include provenance');
    await finalStep(); await click('仅保存 Agent');
    expect(api.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      whenToUse: 'For research questions',
      config: expect.objectContaining({ systemInstructions: 'Respond in concise Chinese',
        contract: expect.objectContaining({ responsibility: expect.objectContaining({
          owns: ['Research sources'], doesNotOwn: ['Publishing'],
        }), quality: { definitionOfDone: ['Include provenance'] } }),
      }),
    }), expect.any(String));
  });
  it('serializes draft writes using the latest returned revision', async () => {
    await wizard();
    const data = vi.mocked(api.agents.drafts.save).mock.calls[0]?.[1] || {
      form: { name: '', role: '', emoji: '', description: '', whenToUse: '', systemInstructions: '', capabilities: '', triggers: '',
        allowedTools: [], model: '', skillVersionId: '', testPrompt: '', maxTurns: 50, timeout: 300, maxConcurrent: 1,
        contractEnabled: false, owns: [], doesNotOwn: [], escalatesTo: [], definitionOfDone: [], inputs: [], outputs: [] },
      step: 0, locked: false, testSubmitted: false,
    };
    vi.mocked(api.agents.drafts.save).mockClear();
    const session = new SetupDraftSession();
    await Promise.all([session.save(data), session.save({ ...data, step: 1 })]);
    expect(vi.mocked(api.agents.drafts.save).mock.calls.map(call => call[1].expectedRevision)).toEqual([0, 1]);
  });
  it('allows save-only without readiness or a model call and stays inside the wizard', async () => {
    await wizard(); await finalStep(); await click('仅保存 Agent');
    expect(api.agents.create).toHaveBeenCalledTimes(1);
    expect(api.agents.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'fixture-model' }), expect.any(String));
    expect(api.agents.test).not.toHaveBeenCalled();
    expect(api.agents.preflight).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Agent 已创建');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useStore.getState().activeView).toBe(original.activeView);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
  it('retains the idempotency key after an uncertain create response and prevents double-click dispatch', async () => {
    vi.mocked(api.agents.create).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(agent);
    await wizard(); await finalStep(); await click('仅保存 Agent');
    expect(container.textContent).toContain('创建结果未确认');
    await click('重试保存');
    const calls = vi.mocked(api.agents.create).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[0][1]).toBe(calls[1][1]);
    expect(calls[0][0]).toEqual(calls[1][0]);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
  it('retries only Skill binding after the Agent was created', async () => {
    useStore.setState({ skills: [{ id: 'skill-a', name: 'Fixture Skill', publishedVersionId: 'version-a' } as any] });
    vi.spyOn(api.skills, 'assign').mockRejectedValueOnce(new Error('binding offline')).mockResolvedValue({} as any);
    await wizard(); await click('2. Skill');
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Fixture Skill'))!.click());
    await finalStep(); await click('仅保存 Agent');
    expect(container.textContent).toContain('Skill 绑定失败');
    expect(container.textContent).toContain(agent.id);
    await click('重试 Skill 绑定');
    expect(api.agents.create).toHaveBeenCalledTimes(1);
    expect(api.skills.assign).toHaveBeenCalledTimes(2);
    expect(api.skills.assign).toHaveBeenLastCalledWith(agent.id, 'version-a');
  });
  it('disables tests for blocking checks but keeps save-only available', async () => {
    vi.mocked(api.agents.preflight).mockResolvedValue({ ...preflight, canTest: false, checks: [
      { id: 'xhs', label: '小红书登录', status: 'unknown', blocking: true, message: '请到 Home 检查' },
    ] });
    await wizard(); await finalStep(); await prompt(); await click('检查能力');
    const test = [...container.querySelectorAll('button')].find(button => button.textContent === '保存并试运行')!;
    expect(test.disabled).toBe(true); expect(container.textContent).toContain('存在阻塞项');
    await click('仅保存 Agent');
    expect(api.agents.test).not.toHaveBeenCalled();
  });
  it('retries the same test request after dispatch failure without creating another Agent', async () => {
    vi.mocked(api.agents.test).mockRejectedValueOnce(new Error('queue offline')).mockResolvedValue({
      taskId: task.id, status: 'running', replayed: true,
    });
    await wizard(); await finalStep(); await prompt(); await click('检查能力'); await click('保存并试运行');
    expect(container.textContent).toContain('试运行提交失败');
    await click('重试原试运行');
    expect(api.agents.create).toHaveBeenCalledTimes(1);
    expect(api.agents.test).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(api.agents.test).mock.calls;
    expect(calls[0]).toEqual(calls[1]);
    expect(container.querySelector('[aria-label="Agent inline debugger"]')).not.toBeNull();
    expect(container.textContent).toContain('尚未验收');
  });
  it('supports adding an explicit test prompt after save-only creation', async () => {
    await wizard(); await finalStep(); await click('仅保存 Agent');
    await prompt('Run after save'); await click('检查能力'); await click('开始试运行');
    expect(api.agents.create).toHaveBeenCalledTimes(1);
    expect(api.agents.test).toHaveBeenCalledWith(agent.id, 'Run after save', expect.any(String));
  });
  it('recovers the original submitted test even when subsequent preflight cannot confirm readiness', async () => {
    vi.mocked(api.agents.test).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({
      taskId: task.id, status: 'running', replayed: true,
    });
    await wizard(); await finalStep(); await prompt(); await click('检查能力'); await click('保存并试运行');
    vi.mocked(api.agents.preflightSaved).mockResolvedValue({ ...preflight, canTest: false });
    await click('检查能力');
    expect(container.textContent).toContain('存在阻塞项');
    await click('重试原试运行');
    expect(api.agents.create).toHaveBeenCalledTimes(1);
    expect(api.agents.test).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="Agent inline debugger"]')).not.toBeNull();
  });
  it('keeps preflight failure visible instead of enabling the test', async () => {
    vi.mocked(api.agents.preflight).mockRejectedValue(new Error('offline'));
    await wizard(); await finalStep(); await prompt(); await click('检查能力');
    expect(container.textContent).toContain('预检失败');
    expect([...container.querySelectorAll('button')].find(button => button.textContent === '保存并试运行')?.disabled).toBe(true);
  });
  it('locks an in-flight create and preserves the same attempt when reopened after failure', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.agents.create).mockImplementationOnce(() => new Promise((_resolve, rejected) => { reject = rejected; }));
    await wizard(); await finalStep();
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '仅保存 Agent')!;
    await act(async () => { save.click(); save.click(); });
    expect(api.agents.create).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Close setup wizard"]')?.disabled).toBe(true);
    await act(async () => reject(new Error('uncertain response')));
    const render = async (open: boolean) => act(async () => root.render(<AgentSetupWizard open={open} onClose={vi.fn()} onCreated={onCreated}
      templates={templates} toolPresets={[]} modelOptions={[{ value: 'fixture-model', label: 'Fixture', hint: '' }]} />));
    await render(false); await render(true);
    await click('重试保存');
    expect(vi.mocked(api.agents.create).mock.calls[0][1]).toBe(vi.mocked(api.agents.create).mock.calls[1][1]);
  });
  it('invalidates capability results when the model changes and ignores a stale preflight response', async () => {
    let resolve!: (result: AgentSetupPreflight) => void;
    vi.mocked(api.agents.preflight).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await act(async () => root.render(<AgentSetupWizard open onClose={vi.fn()} onCreated={onCreated}
      templates={templates} toolPresets={[]} modelOptions={[
        { value: 'fixture-model', label: 'Fixture', hint: '' }, { value: 'another-model', label: 'Another', hint: '' },
      ]} />));
    await finalStep(); await prompt();
    const check = [...container.querySelectorAll('button')].find(button => button.textContent === '检查能力')!;
    await act(async () => check.click());
    await click('3. Tools & Model');
    await act(async () => {
      const select = container.querySelector('select')!;
      select.value = 'another-model'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => resolve(preflight));
    await finalStep();
    expect(container.textContent).not.toContain('可提交试运行');
    expect([...container.querySelectorAll('button')].find(button => button.textContent === '保存并试运行')?.disabled).toBe(true);
  });
  it('merges authorization and idempotency headers in the API request', async () => {
    vi.mocked(api.agents.create).mockRestore();
    window.localStorage.setItem('agentFactory.apiToken', 'fixture-test-token');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 201, json: async () => agent,
    } as Response);
    try {
      await api.agents.create({ name: agent.name, role: agent.role }, 'fixture-key-123');
      const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
      expect(headers.get('authorization')).toBe('Bearer fixture-test-token');
      expect(headers.get('idempotency-key')).toBe('fixture-key-123');
      expect(headers.get('content-type')).toBe('application/json');
    } finally { window.localStorage.removeItem('agentFactory.apiToken'); }
  });
  it('focuses the dialog and returns focus to the launcher when it closes', async () => {
    const launcher = document.createElement('button'); document.body.append(launcher); launcher.focus();
    await wizard();
    expect(document.activeElement).toBe(container.querySelector('[role="dialog"]'));
    await act(async () => root.render(<AgentSetupWizard open={false} onClose={vi.fn()} onCreated={onCreated}
      templates={templates} toolPresets={[]} modelOptions={[{ value: 'fixture-model', label: 'Fixture', hint: '' }]} />));
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });
});

describe('inline debug result', () => {
  it('renders streamed Markdown, actual model and collapsed tool details then settles without false acceptance', async () => {
    vi.useFakeTimers();
    useStore.setState({ streamingResponses: { [execution.id]: '**实时回复**\n\n- 第一项' } });
    vi.mocked(api.executions.messages).mockResolvedValue([{
      id: 1, executionId: execution.id, type: 'tool_result', toolName: 'file_read', content: 'fixture', createdAt: task.createdAt,
    }]);
    await act(async () => root.render(<AgentSetupDebug taskId={task.id} agentName={agent.name} />));
    expect(container.querySelector('strong')?.textContent).toBe('实时回复');
    expect(container.textContent).toContain('actual-fixture-model');
    expect(container.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
    expect(container.textContent).toContain('尚未验收');
    vi.mocked(api.tasks.get).mockResolvedValue({ ...task, status: 'done', output: '**完整结果**\n\n| A | B |\n|---|---|\n| 1 | 2 |' });
    vi.mocked(api.executions.list).mockResolvedValue([{ ...execution, status: 'done' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(container.textContent).toContain('执行结束');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).not.toContain('正在生成回复');
    expect(container.textContent).not.toContain('已记录验收通过');
  });
  it('retains execution errors and never claims that failure is a completed delivery', async () => {
    vi.mocked(api.tasks.get).mockResolvedValue({ ...task, status: 'failed', error: 'fixture tool unavailable' });
    vi.mocked(api.executions.list).mockResolvedValue([{ ...execution, status: 'failed' }]);
    await act(async () => root.render(<AgentSetupDebug taskId={task.id} agentName={agent.name} />));
    expect(container.textContent).toContain('执行失败');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('fixture tool unavailable');
    expect(container.textContent).not.toContain('已记录验收通过');
  });
  it('shows scoped file artifacts without dropping Agent output on artifact load failure', async () => {
    vi.mocked(api.artifacts.workbench).mockResolvedValue([{
      id: 'artifact-a', taskId: task.id, name: 'report.md', kind: 'markdown', sizeBytes: 314,
    } as any]);
    await act(async () => root.render(<AgentSetupDebug taskId={task.id} agentName={agent.name} />));
    expect(api.artifacts.workbench).toHaveBeenCalledWith({ taskId: task.id });
    expect(container.textContent).toContain('report.md');
    expect(container.textContent).toContain('314 bytes');
  });
  it('reads messages beyond the first page and cleans up polling on unmount', async () => {
    vi.useFakeTimers();
    vi.mocked(api.executions.messages).mockImplementation(async (_id, cursor) => cursor ? [
      { id: 201, executionId: execution.id, type: 'agent_text', content: 'Reply after page one', createdAt: task.createdAt },
    ] : Array.from({ length: 200 }, (_, index) => ({
      id: index + 1, executionId: execution.id, type: 'progress', content: 'fixture', createdAt: task.createdAt,
    })));
    await act(async () => root.render(<AgentSetupDebug taskId={task.id} agentName={agent.name} />));
    expect(container.textContent).toContain('Reply after page one');
    const count = vi.mocked(api.tasks.get).mock.calls.length;
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api.tasks.get).toHaveBeenCalledTimes(count);
  });
});
