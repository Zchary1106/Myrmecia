// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProviderSettings, Task } from '@myrmecia/shared';
import { api } from '../src/lib/api';
import { useStore } from '../src/stores/store';
import { useConnectionsStore } from '../src/stores/connections';
import { HomeView } from '../src/components/home/HomeView';
import { ServiceConnections } from '../src/components/home/ServiceConnections';

const initialStore = useStore.getState();
const initialConnections = useConnectionsStore.getState();
const task: Task = {
  id: 'home-root', title: 'Research hotels', description: 'Full request', input: '',
  mode: 'direct', status: 'done', priority: 'normal', createdBy: 'user', assigneeId: 'researcher',
  retryCount: 0, maxRetries: 1, dependsOn: [], createdAt: '2026-09-20T10:00:00Z',
  output: '**Result**: see [evidence](https://example.com)',
};
let root: Root;
let container: HTMLDivElement;

const providerSettings: ModelProviderSettings = {
  provider: 'copilot',
  selectedModelId: 'claude-haiku-4.5',
  source: 'provider',
  models: [
    { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', supportsReasoningEffort: false, selectable: true },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportsReasoningEffort: true, selectable: true },
  ],
};

async function enterGoal() {
  const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Describe work for your Agent Team"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Test selected model');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitGoal() {
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
  useStore.setState({
    ...initialStore, tasks: [task], pipelines: [], agents: [], inboxEntries: [], executions: [],
    models: [], loadModels: vi.fn().mockResolvedValue(undefined), loadTasks: vi.fn().mockResolvedValue(undefined),
  }, true);
  useConnectionsStore.setState(initialConnections, true);
  vi.spyOn(api.models, 'providerSettings').mockRejectedValue(new Error('Not configured'));
  vi.spyOn(api.teams, 'list').mockResolvedValue([]);
  vi.spyOn(api.mcp, 'servers').mockResolvedValue([]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState(initialStore, true);
  useConnectionsStore.setState(initialConnections, true);
  vi.restoreAllMocks();
});

describe('Home workspace', () => {
  it('provides a wider home composer and a larger responsive model settings panel', async () => {
    vi.mocked(api.models.providerSettings).mockResolvedValue(providerSettings);
    await act(async () => root.render(<HomeView />));
    expect(container.querySelector('[data-home-content]')?.classList.contains('max-w-[1040px]')).toBe(true);
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Describe work for your Agent Team"]')!;
    expect(input.rows).toBe(4);
    expect(input.classList.contains('min-h-[128px]')).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
    expect(container.querySelector('#model-options')?.classList.contains('sm:w-[380px]')).toBe(true);
    expect(container.querySelector('#model-options')?.classList.contains('w-full')).toBe(true);
  });

  it('does not expose registry fallbacks or submit when account model discovery fails', async () => {
    const dispatch = vi.spyOn(api.supervisor, 'dispatch');
    vi.mocked(api.models.providerSettings).mockResolvedValue({
      provider: 'copilot', source: 'registry', error: 'Offline',
      models: [{ id: 'fake-fallback', name: 'Fake Fallback', supportsReasoningEffort: false, selectable: true }],
    });
    await act(async () => root.render(<HomeView />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
    expect(container.querySelector('[aria-label="Model choice"]')?.textContent).not.toContain('Fake Fallback');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('不会使用历史模型');
    await enterGoal();
    await submitGoal();
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    vi.mocked(api.models.providerSettings).mockResolvedValue(providerSettings);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh available models"]')!.click());
    expect(container.querySelector('[aria-label="Model choice"]')?.textContent).toContain('GPT-5.6 Terra');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it('does not show builtin or stale registry models after a network error', async () => {
    useStore.setState({ models: [{ id: 'stale-model', displayName: 'Stale Model', enabled: true, capabilityTags: [] } as any] });
    await act(async () => root.render(<HomeView />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
    expect(container.querySelector('[aria-label="Model choice"]')?.textContent).not.toContain('Stale Model');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('获取失败');
  });

  it('blocks routing through an unavailable provider default until an available model is selected', async () => {
    vi.mocked(api.models.providerSettings).mockResolvedValue({ ...providerSettings, selectedModelId: 'old-default' });
    const dispatch = vi.spyOn(api.supervisor, 'dispatch');
    await act(async () => root.render(<HomeView />));
    await enterGoal();
    await submitGoal();
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('默认模型 old-default 当前不可用');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
    await act(async () => {
      const choice = container.querySelector<HTMLSelectElement>('[aria-label="Model choice"]')!;
      choice.value = 'gpt-5.6-terra';
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it('submits the model chosen in the composer instead of the provider default', async () => {
    vi.mocked(api.models.providerSettings).mockResolvedValue(providerSettings);
    const dispatch = vi.spyOn(api.supervisor, 'dispatch').mockResolvedValue({
      tasks: [{ ...task, modelId: 'gpt-5.6-terra' }],
    } as Awaited<ReturnType<typeof api.supervisor.dispatch>>);
    await act(async () => root.render(<HomeView />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
    const choice = container.querySelector<HTMLSelectElement>('[aria-label="Model choice"]')!;
    await act(async () => {
      choice.value = 'gpt-5.6-terra';
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Model settings"]')?.textContent).toContain('GPT-5.6 Terra');
    await enterGoal();
    await submitGoal();
    expect(dispatch).toHaveBeenCalledWith('Test selected model', expect.objectContaining({ modelId: 'gpt-5.6-terra' }));
    expect(useStore.getState().selectedTaskId).toBe(task.id);
  });

  it('preserves an unavailable saved model and blocks sending instead of replacing it with Haiku', async () => {
    window.localStorage.setItem('myrmecia.model-preferences', JSON.stringify({ modelId: 'gpt-5.6-sol' }));
    vi.mocked(api.models.providerSettings).mockResolvedValue(providerSettings);
    const dispatch = vi.spyOn(api.supervisor, 'dispatch');
    await act(async () => root.render(<HomeView />));
    expect(JSON.parse(window.localStorage.getItem('myrmecia.model-preferences')!).modelId).toBe('gpt-5.6-sol');
    expect(container.querySelector('[aria-label="Model settings"]')?.textContent).toContain('gpt-5.6-sol');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('不会自动切换');
    await enterGoal();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await submitGoal();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not send with a saved model that the provider has disabled', async () => {
    window.localStorage.setItem('myrmecia.model-preferences', JSON.stringify({ modelId: 'gpt-5.6-terra' }));
    vi.mocked(api.models.providerSettings).mockResolvedValue({
      ...providerSettings,
      models: providerSettings.models.map(model => ({ ...model, selectable: model.id !== 'gpt-5.6-terra' })),
    });
    const dispatch = vi.spyOn(api.supervisor, 'dispatch');
    await act(async () => root.render(<HomeView />));
    await enterGoal();
    await submitGoal();
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('GPT-5.6 Terra');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
    expect(container.querySelector<HTMLOptionElement>('option[value="gpt-5.6-terra"]')?.disabled).toBe(true);
  });

  it('lets the user explicitly replace an unavailable model before sending', async () => {
    window.localStorage.setItem('myrmecia.model-preferences', JSON.stringify({ modelId: 'gpt-5.6-sol' }));
    vi.mocked(api.models.providerSettings).mockResolvedValue(providerSettings);
    const dispatch = vi.spyOn(api.supervisor, 'dispatch').mockResolvedValue({
      tasks: [{ ...task, modelId: 'gpt-5.6-terra' }],
    } as Awaited<ReturnType<typeof api.supervisor.dispatch>>);
    await act(async () => root.render(<HomeView />));
    await enterGoal();
    await submitGoal();
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
    const choice = container.querySelector<HTMLSelectElement>('[aria-label="Model choice"]')!;
    expect(choice.value).toBe('gpt-5.6-sol');
    await act(async () => {
      choice.value = 'gpt-5.6-terra';
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await submitGoal();
    expect(dispatch).toHaveBeenCalledWith('Test selected model', expect.objectContaining({ modelId: 'gpt-5.6-terra' }));
  });

  it('waits for model availability before accepting a submission', async () => {
    window.localStorage.setItem('myrmecia.model-preferences', JSON.stringify({ modelId: 'gpt-5.6-terra' }));
    let resolveSettings!: (value: ModelProviderSettings) => void;
    vi.mocked(api.models.providerSettings).mockReturnValue(new Promise(resolve => { resolveSettings = resolve; }));
    const dispatch = vi.spyOn(api.supervisor, 'dispatch').mockResolvedValue({
      tasks: [{ ...task, modelId: 'gpt-5.6-terra' }],
    } as Awaited<ReturnType<typeof api.supervisor.dispatch>>);
    await act(async () => root.render(<HomeView />));
    await enterGoal();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await submitGoal();
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => resolveSettings(providerSettings));
    await submitGoal();
    expect(dispatch).toHaveBeenCalledWith('Test selected model', expect.objectContaining({ modelId: 'gpt-5.6-terra' }));
  });

  it('passes the same composer model when dispatching to a selected team', async () => {
    window.localStorage.setItem('myrmecia.model-preferences', JSON.stringify({ modelId: 'gpt-5.6-terra' }));
    vi.mocked(api.models.providerSettings).mockResolvedValue(providerSettings);
    vi.mocked(api.teams.list).mockResolvedValue([{
      id: 'team-alpha', name: 'Alpha Team', emoji: '', lead: 'dev', members: ['dev'], triggers: [], blurb: '',
    }]);
    const dispatch = vi.spyOn(api.teams, 'dispatch').mockResolvedValue({
      run: { parentTaskId: task.id },
    } as Awaited<ReturnType<typeof api.teams.dispatch>>);
    vi.spyOn(api.tasks, 'get').mockResolvedValue({ ...task, modelId: 'gpt-5.6-terra' });
    const supervisor = vi.spyOn(api.supervisor, 'dispatch');
    await act(async () => root.render(<HomeView />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-controls="team-picker"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('#team-picker button')]
      .find(button => button.textContent?.includes('Alpha Team'))!.click());
    await enterGoal();
    await submitGoal();
    expect(dispatch).toHaveBeenCalledWith('team-alpha', 'Test selected model', undefined,
      expect.objectContaining({ modelId: 'gpt-5.6-terra' }));
    expect(supervisor).not.toHaveBeenCalled();
  });

  it.each([
    { hour: 9, greeting: 'Good morning' },
    { hour: 15, greeting: 'Good afternoon' },
    { hour: 21, greeting: 'Good evening' },
  ])('shows $greeting without a hardcoded person or technical account name', async ({ hour, greeting }) => {
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(hour);
    await act(async () => root.render(<HomeView />));
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toBe(`${greeting}. 👋`);
    expect(heading?.textContent).not.toContain('Yadong');
    expect(heading?.textContent).not.toContain('local-admin');
  });

  it('does not restore a completed current-task card or render empty metrics', async () => {
    window.localStorage.setItem('myrmecia.home-current-task', JSON.stringify({ taskId: task.id, request: 'Full request' }));
    await act(async () => root.render(<HomeView />));
    expect(container.querySelector('[aria-label="Current task"]')).toBeNull();
    expect(container.querySelector('[aria-label="In progress"]')).toBeNull();
    expect(container.querySelector('[aria-label="Work needing attention"]')).toBeNull();
    expect(container.textContent).not.toContain('Active agents');
    expect(container.textContent).not.toContain('No active work yet');
    expect(container.querySelectorAll('[data-home-conversation]')).toHaveLength(1);
    expect(container.textContent).toContain('Result: see evidence');
    expect(container.textContent).not.toContain('**Result**');
  });

  it('opens the root conversation for a completed follow-up and renders its actual owner', async () => {
    useStore.setState({ tasks: [task, { ...task, id: 'followup', parentTaskId: task.id, assigneeId: 'writer', createdAt: '2026-09-20T11:00:00Z' }] });
    await act(async () => root.render(<HomeView />));
    const row = container.querySelector<HTMLButtonElement>('[data-home-conversation]')!;
    expect(container.querySelectorAll('[data-home-conversation]')).toHaveLength(1);
    expect(row.textContent).toContain('writer');
    expect(row.textContent).toContain('2 turns');
    await act(async () => row.click());
    expect(useStore.getState().activeView).toBe('session');
    expect(useStore.getState().selectedTaskId).toBe(task.id);
  });

  it('shows waiting-for-tool work separately from history and closes selectors with Escape', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'waiting_for_tool' }] });
    await act(async () => root.render(<HomeView />));
    expect(container.querySelector('[aria-label="In progress"]')?.textContent).toContain('Waiting for a tool');
    expect(container.querySelector('[aria-label="Recent conversations"] [data-home-conversation]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-controls="team-picker"]')!.click());
    expect(container.querySelector('#team-picker')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('#team-picker')).toBeNull();
  });

  it('keeps connections collapsed, reports no configuration honestly and retains the management entry', async () => {
    await act(async () => root.render(<ServiceConnections compact />));
    expect(container.textContent).toContain('未配置');
    expect(container.querySelector('section')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    expect(container.querySelector('section')?.textContent).toContain('还没有配置 MCP');
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('详细配置'))!.click());
    expect(useStore.getState().activeView).toBe('tools');
    expect(useConnectionsStore.getState().toolsMcpRequested).toBe(true);
  });

  it('opens the requested login entry and only generates a QR after the login action', async () => {
    vi.spyOn(api.mcp, 'servers').mockResolvedValue([{ name: 'xiaohongshu', connected: true, toolCount: 13 }]);
    vi.spyOn(api.mcp, 'xiaohongshuStatus').mockResolvedValue({ authenticated: false, state: 'login_required', checkedAt: '' });
    const login = vi.spyOn(api.mcp, 'xiaohongshuLogin').mockResolvedValue({
      authenticated: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), image: 'data:image/png;base64,dGVzdA==',
    } as Awaited<ReturnType<typeof api.mcp.xiaohongshuLogin>>);
    useConnectionsStore.setState({ homeTarget: 'xiaohongshu' });
    await act(async () => root.render(<ServiceConnections compact />));
    expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Xiaohongshu login"]')).not.toBeNull();
    expect(login).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '小红书登录')!.click());
    expect(container.querySelector('[aria-label="Close Xiaohongshu login"]')).not.toBeNull();
    expect(useConnectionsStore.getState().homeTarget).toBeNull();
  });
});
