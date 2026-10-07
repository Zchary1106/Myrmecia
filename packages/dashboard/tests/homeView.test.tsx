// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@myrmecia/shared';
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
