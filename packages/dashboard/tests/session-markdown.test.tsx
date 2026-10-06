// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskExecution, WSEvent } from '@myrmecia/shared';
import { MarkdownMessage } from '../src/components/common/MarkdownMessage';
import { ResearchAnswer, splitResearchAnswer } from '../src/components/session/ResearchAnswer';
import { TaskSession } from '../src/components/session/TaskSession';
import { SessionDocuments } from '../src/components/session/SessionDocuments';
import { XiaohongshuLogin } from '../src/components/home/XiaohongshuLogin';
import { useConnectionsStore } from '../src/stores/connections';
import { ServiceConnections } from '../src/components/home/ServiceConnections';
import { useWebSocket } from '../src/hooks/useWebSocket';
import { useStore } from '../src/stores/store';
import { api } from '../src/lib/api';

const handlers = vi.hoisted(() => new Map<string, (event: WSEvent) => unknown>());
vi.mock('../src/lib/ws', () => ({
  wsClient: {
    connect: vi.fn(), disconnect: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    onConnected: () => () => {},
    on: (type: string, handler: (event: WSEvent) => unknown) => handlers.set(type, handler),
    off: (type: string) => handlers.delete(type),
  },
}));

const task: Task = {
  id: 'markdown-task', title: 'Compare options', description: 'Compare options',
  input: 'Compare options', mode: 'direct', status: 'running', priority: 'normal',
  createdBy: 'user', assigneeId: 'legacy-writer', createdAt: '2026-09-13T00:00:00Z',
  retryCount: 0, maxRetries: 0, dependsOn: [],
};
const execution = {
  id: 'markdown-execution', taskId: task.id, agentDefId: 'legacy-writer',
  status: 'running', startedAt: task.createdAt,
} as TaskExecution;
const originalState = useStore.getState();
const originalConnections = useConnectionsStore.getState();
let root: Root | undefined;
let container: HTMLDivElement;

function Harness() { useWebSocket(); return <TaskSession />; }

beforeEach(() => {
  useConnectionsStore.setState(originalConnections, true);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  useStore.setState({
    tasks: [task], agents: [], pipelines: [], executions: [execution],
    selectedTaskId: task.id, executionMessages: {}, streamingResponses: {},
    loadTasks: vi.fn(), loadAgents: vi.fn(), loadExecutions: vi.fn(),
    loadExecutionMessages: vi.fn(), loadPipelines: vi.fn(),
    loadPlatformEvents: vi.fn(), loadObservability: vi.fn(), loadOperatorActions: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  useStore.setState(originalState, true);
  useConnectionsStore.setState(originalConnections, true);
  vi.restoreAllMocks();
  handlers.clear();
  vi.useRealTimers();
});

describe('Markdown conversation rendering', () => {
  it('renders adjacent Chinese bold labels without changing code or escaped literals', () => {
    const html = renderToStaticMarkup(<MarkdownMessage content={'**结论：**按实际资料回答。\n\n**资料说明： **未核实。\n\n`**代码：**原样`\n\n```md\n**示例：**原样\n```\n\n\\*\\*转义：\\*\\*原样'} />);
    expect(html).toContain('<strong>结论：</strong>按实际资料回答');
    expect(html).toContain('<strong>资料说明：</strong>未核实');
    expect(html).toContain('**代码：**原样');
    expect(html).toContain('**示例：**原样');
    expect(html).toContain('**转义：**原样');
    expect(html).not.toContain('<strong>代码');
    expect(html).not.toContain('<strong>转义');
  });

  it('puts research limitations first and keeps the legacy publishing appendix collapsed without losing the original', async () => {
    const content = '**结论：**候选仅供核实。\n\n**内容 ID：**draft1\n\n### 正文\n\n| 住宿 | 价格 |\n|---|---|\n| A | 未核实 |\n\n**CTA：**点赞收藏\n\n### 8张卡片脚本\n\n1. 封面内容\n\n**标签：**#旅行\n\n**资料说明：**未取得实时报价。\n\n**视觉主题：**蓝白';
    await act(async () => { root = createRoot(container); root.render(<ResearchAnswer content={content} request="帮我查小红书的水屋价格" agentId="xiaohongshu-writer" />); });
    const notice = container.querySelector('aside')!;
    expect(notice.textContent).toContain('未取得实时报价');
    expect(container.querySelector('table')).not.toBeNull();
    expect([...container.querySelectorAll('details')].every(details => !details.open)).toBe(true);
    expect(container.querySelector('details')!.textContent).toContain('封面内容');
    expect(container.querySelectorAll('details')[1].textContent).toContain('draft1');
    const parts = splitResearchAnswer(content);
    expect(parts.body).not.toContain('内容 ID');
    expect(parts.body).not.toContain('点赞收藏');
    expect(parts.body).toContain('候选仅供核实');
  });

  it('does not hide explicitly requested publication output or parse headings inside code', () => {
    const content = '**内容 ID：**draft1\n\n### 8张卡片脚本\n\n卡片正文';
    const html = renderToStaticMarkup(<ResearchAnswer content={content} request="帮我写一篇小红书笔记" agentId="xiaohongshu-writer" />);
    expect(html).not.toContain('<details');
    expect(html).toContain('8张卡片脚本');
    const code = '```md\n### 8张卡片脚本\n**内容 ID：**code\n```';
    expect(splitResearchAnswer(code).body).toBe(code);
    expect(splitResearchAnswer(code).appendix).toBe('');
  });

  it('shows one failure summary, preserves successful research, and drafts recovery without submitting', async () => {
    const failedTask: Task = { ...task, status: 'failed', error: 'Self-healing exhausted. Last error: Timeout after 120000ms waiting for session.idle' };
    const retry = { ...execution, id: 'second-attempt', status: 'failed' } as TaskExecution;
    useStore.setState({
      tasks: [failedTask], executions: [{ ...execution, status: 'failed' }, retry],
      executionMessages: {
        [execution.id]: [
          { id: 1, executionId: execution.id, type: 'error', content: 'Timeout after 120000ms waiting for session.idle', createdAt: task.createdAt },
          { id: 2, executionId: execution.id, type: 'tool_result', toolName: 'mcp__xiaohongshu__search_feeds', content: JSON.stringify({
            kind: 'research_result', status: 'done', output: JSON.stringify({ notes: [{ title: 'Collected source', source_url: 'https://example.com/note' }] }),
          }), createdAt: task.createdAt },
          { id: 3, executionId: execution.id, type: 'tool_result', toolName: 'web.search', content: JSON.stringify({
            kind: 'research_result', status: 'failed', output: 'Search failed: fetch failed',
          }), createdAt: task.createdAt },
        ],
        [retry.id]: [{ id: 4, executionId: retry.id, type: 'error', content: 'Timeout after 120000ms waiting for session.idle', createdAt: task.createdAt }],
      },
    });
    const submit = vi.spyOn(api.tasks, 'continue');
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    expect(container.querySelectorAll('[aria-label="Execution failure summary"]')).toHaveLength(1);
    expect(container.textContent).toContain('执行超时，任务未完成');
    expect(container.textContent).not.toContain('being coordinated');
    expect(container.textContent).toContain('已收集资料 · 1 份');
    expect(container.querySelector('a[href="https://example.com/note"]')?.textContent).toBe('Collected source');
    const notice = container.querySelector('[aria-label="Execution failure summary"]')!;
    expect(notice.querySelector('details')!.open).toBe(false);
    await act(async () => [...notice.querySelectorAll('button')].find(button => button.textContent === '填写继续指令')!.click());
    expect(container.querySelector('textarea')!.value).toContain('基于已收集资料');
    expect(submit).not.toHaveBeenCalled();
  });

  it('offers model settings for quota failures without claiming active coordination', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'failed', error: 'You have exceeded your monthly quota' }], executions: [{ ...execution, status: 'failed' }] });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    expect(container.textContent).toContain('模型额度不足，任务已停止');
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '模型设置')!.click());
    expect(useStore.getState().activeView).toBe('models');
  });

  it('recovers complete historical search evidence only when requested', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'failed', error: 'Timeout after 120000ms waiting for session.idle' }], executions: [{ ...execution, status: 'failed' }] });
    const list = vi.spyOn(api.artifacts, 'workbench').mockResolvedValue([{
      id: 'archive1', executionId: execution.id, sizeBytes: 5000, createdAt: task.createdAt,
      metadata: { archivedFromPrompt: true, toolName: 'mcp__xiaohongshu__search_feeds' },
    } as any]);
    vi.spyOn(api.artifacts, 'preview').mockResolvedValue({
      size: 5000,
      text: async () => JSON.stringify({ source: 'xiaohongshu MCP', notes: [{ title: 'Recovered historical note', source_url: 'https://example.com/recovered' }] }),
    } as Blob);
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    expect(list).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '查看完整归档资料')!.click());
    expect(list).toHaveBeenCalledWith({ taskId: task.id, limit: 50 });
    expect(container.textContent).toContain('Recovered historical note');
    expect(container.textContent).toContain('已收集资料 · 1 份');
  });

  it('releases login controls after a pending mount check under StrictMode', async () => {
    let resolveStatus!: (status: Awaited<ReturnType<typeof api.mcp.xiaohongshuStatus>>) => void;
    const check = vi.spyOn(api.mcp, 'xiaohongshuStatus').mockImplementation(() => new Promise(resolve => { resolveStatus = resolve; }));
    const login = vi.spyOn(api.mcp, 'xiaohongshuLogin').mockResolvedValue({
      authenticated: false, image: 'data:image/png;base64,aGVsbG8=', expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    await act(async () => { root = createRoot(container); root.render(<StrictMode><XiaohongshuLogin /></StrictMode>); });
    expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    await act(async () => resolveStatus({ authenticated: false, state: 'login_required', checkedAt: '' }));
    expect(check).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(login).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('allows retry when the initial StrictMode login check fails', async () => {
    let rejectStatus!: (error: Error) => void;
    const check = vi.spyOn(api.mcp, 'xiaohongshuStatus')
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectStatus = reject; }))
      .mockResolvedValue({ authenticated: false, state: 'login_required', checkedAt: '' });
    await act(async () => { root = createRoot(container); root.render(<StrictMode><XiaohongshuLogin /></StrictMode>); });
    await act(async () => rejectStatus(new Error('Network unavailable')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法检查登录状态');
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('我已扫码'))!;
    expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    expect(check).toHaveBeenCalledTimes(2);
    expect(retry.disabled).toBe(false);
  });

  it('shows connection and login states on Home without generating a QR automatically', async () => {
    vi.spyOn(api.mcp, 'servers').mockResolvedValue([
      { name: 'xiaohongshu', connected: true, toolCount: 13 },
      { name: 'douyin-search', connected: false, toolCount: 0 },
    ]);
    vi.spyOn(api.mcp, 'xiaohongshuStatus').mockResolvedValue({ authenticated: false, state: 'login_required', checkedAt: '' });
    const login = vi.spyOn(api.mcp, 'xiaohongshuLogin');
    await act(async () => { root = createRoot(container); root.render(<ServiceConnections />); });
    expect(container.textContent).toContain('工具与服务');
    expect(container.textContent).toContain('需要登录');
    expect(container.textContent).toContain('未连接');
    expect(container.textContent).toContain('登录及业务权限未验证');
    expect(login).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '登录')!.click());
    expect(container.querySelector('[aria-label="Xiaohongshu login"]')).not.toBeNull();
    expect(login).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('详细配置'))!.click());
    expect(useStore.getState().activeView).toBe('tools');
    expect(useConnectionsStore.getState().toolsMcpRequested).toBe(true);
  });

  it('keeps only a connection link in chat, and removes a historical blocker after shared login succeeds', async () => {
    useStore.setState({ executionMessages: { [execution.id]: [{
      id: 400, executionId: execution.id, type: 'tool_result', toolName: 'mcp__xiaohongshu__check_login_status',
      content: '[XHS_LOGIN_REQUIRED] 未登录', createdAt: task.createdAt,
    }] } });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    expect(container.querySelector('[aria-label="Xiaohongshu login"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    const link = [...container.querySelectorAll('button')].find(button => button.textContent === '前往连接')!;
    await act(async () => link.click());
    expect(useStore.getState().activeView).toBe('command');
    expect(useConnectionsStore.getState().homeTarget).toBe('xiaohongshu');
    await act(async () => useConnectionsStore.setState({ xiaohongshu: { authenticated: true, state: 'logged_in', checkedAt: '' } }));
    expect(container.textContent).not.toContain('前往连接');
  });

  it('collapses Home login actions after authentication and restores only the login entry when it expires', async () => {
    vi.spyOn(api.mcp, 'servers').mockResolvedValue([{ name: 'xiaohongshu', connected: true, toolCount: 13 }]);
    const check = vi.spyOn(api.mcp, 'xiaohongshuStatus').mockResolvedValue({ authenticated: false, state: 'login_required', checkedAt: '' });
    await act(async () => { root = createRoot(container); root.render(<ServiceConnections />); });
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '登录')!.click());
    expect(container.querySelector('[aria-label="Xiaohongshu login"]')).not.toBeNull();

    check.mockResolvedValue({ authenticated: true, state: 'logged_in', checkedAt: '' });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="检查服务状态"]')!.click());
    expect(container.textContent).toContain('已登录');
    expect(container.querySelector('[aria-label="Xiaohongshu login"]')).toBeNull();
    expect([...container.querySelectorAll('button')].some(button => /管理|小红书登录|^登录$/.test(button.textContent || ''))).toBe(false);

    check.mockResolvedValue({ authenticated: false, state: 'login_required', checkedAt: '' });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="检查服务状态"]')!.click());
    expect(container.textContent).toContain('需要登录');
    expect([...container.querySelectorAll('button')].some(button => button.textContent === '登录')).toBe(true);
    expect(container.querySelector('[aria-label="Xiaohongshu login"]')).toBeNull();
  });

  it('refreshes service state after reconnecting an existing disconnected server', async () => {
    vi.spyOn(api.mcp, 'servers')
      .mockResolvedValueOnce([{ name: 'douyin-search', connected: false, toolCount: 0 }])
      .mockResolvedValue([{ name: 'douyin-search', connected: true, toolCount: 16 }]);
    const reconnect = vi.spyOn(api.mcp, 'reconnect').mockResolvedValue({ name: 'douyin-search', connected: true });
    await act(async () => { root = createRoot(container); root.render(<ServiceConnections />); });
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '重连')!.click());
    expect(reconnect).toHaveBeenCalledExactlyOnceWith('douyin-search');
    expect(container.textContent).toContain('已连接');
    expect(container.textContent).not.toContain('未连接');
  });

  it('opens the login QR only on request, confirms login and removes the QR', async () => {
    vi.useFakeTimers();
    const login = vi.spyOn(api.mcp, 'xiaohongshuLogin').mockResolvedValue({
      authenticated: false, image: 'data:image/png;base64,aGVsbG8=', expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const check = vi.spyOn(api.mcp, 'xiaohongshuStatus').mockResolvedValueOnce({
      authenticated: false, state: 'login_required', checkedAt: new Date().toISOString(),
    }).mockResolvedValue({
      authenticated: true, state: 'logged_in', checkedAt: new Date().toISOString(),
    });
    await act(async () => { root = createRoot(container); root.render(<XiaohongshuLogin required />); });
    expect(login).not.toHaveBeenCalled();
    expect(container.textContent).toContain('站内查询被登录状态阻塞');
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(check).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('已登录');
    expect(container.querySelector('[aria-label="Close Xiaohongshu login"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('stops polling on close and does not send tasks automatically', async () => {
    vi.useFakeTimers();
    vi.spyOn(api.mcp, 'xiaohongshuLogin').mockResolvedValue({
      authenticated: false, image: 'data:image/png;base64,aGVsbG8=', expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const check = vi.spyOn(api.mcp, 'xiaohongshuStatus').mockResolvedValue({
      authenticated: false, state: 'login_required', checkedAt: new Date().toISOString(),
    });
    const send = vi.spyOn(api.tasks, 'continue');
    await act(async () => { root = createRoot(container); root.render(<XiaohongshuLogin />); });
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Xiaohongshu login"]')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(check).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows an actionable login error without claiming authentication', async () => {
    vi.spyOn(api.mcp, 'xiaohongshuStatus').mockResolvedValue({
      authenticated: false, state: 'login_required', checkedAt: new Date().toISOString(),
    });
    vi.spyOn(api.mcp, 'xiaohongshuLogin').mockRejectedValue(new Error('需要管理员权限'));
    await act(async () => { root = createRoot(container); root.render(<XiaohongshuLogin />); });
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('需要管理员权限');
    expect(container.textContent).not.toContain('登录成功');
  });

  it('keeps checking after QR display expiry to detect delayed login completion', async () => {
    vi.useFakeTimers();
    vi.spyOn(api.mcp, 'xiaohongshuLogin').mockResolvedValue({
      authenticated: false, image: 'data:image/png;base64,aGVsbG8=', expiresAt: new Date(Date.now() + 5000).toISOString(),
    });
    vi.spyOn(api.mcp, 'xiaohongshuStatus')
      .mockResolvedValueOnce({ authenticated: false, state: 'login_required', checkedAt: '' })
      .mockResolvedValueOnce({ authenticated: false, state: 'login_required', checkedAt: '' })
      .mockResolvedValue({ authenticated: true, state: 'logged_in', checkedAt: '' });
    await act(async () => { root = createRoot(container); root.render(<XiaohongshuLogin />); });
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('仍在检查登录结果');
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.textContent).toContain('已登录');
    expect(container.querySelector('[aria-label="Close Xiaohongshu login"]')).toBeNull();
  });

  it('checks an existing login on mount and focus without generating another QR', async () => {
    const check = vi.spyOn(api.mcp, 'xiaohongshuStatus')
      .mockResolvedValueOnce({ authenticated: false, state: 'login_required', checkedAt: '' })
      .mockResolvedValue({ authenticated: true, state: 'logged_in', checkedAt: '' });
    const login = vi.spyOn(api.mcp, 'xiaohongshuLogin');
    await act(async () => { root = createRoot(container); root.render(<XiaohongshuLogin />); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(check).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('已登录');
    expect(login).not.toHaveBeenCalled();
  });

  it('provides a manual confirmation check without refreshing the QR or claiming success', async () => {
    const check = vi.spyOn(api.mcp, 'xiaohongshuStatus').mockResolvedValue({ authenticated: false, state: 'login_required', checkedAt: '' });
    const login = vi.spyOn(api.mcp, 'xiaohongshuLogin');
    await act(async () => { root = createRoot(container); root.render(<XiaohongshuLogin />); });
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('我已扫码'))!.click());
    expect(check).toHaveBeenCalledTimes(2);
    expect(login).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('MCP 尚未确认登录');
    expect(container.textContent).not.toContain('已登录，可发送');
  });

  it('uses a single compact toolbar with the real title, recipient and status', async () => {
    const slot = document.createElement('div');
    slot.id = 'session-header-slot';
    container.append(slot);
    const mount = document.createElement('div');
    container.append(mount);
    await act(async () => { root = createRoot(mount); root.render(<TaskSession />); });
    expect(slot.querySelector('h1')?.textContent).toBe(task.title);
    expect(slot.querySelector('h1')?.title).toBe(task.title);
    expect(slot.textContent).toContain('legacy-writer');
    expect(slot.textContent).toContain('In progress');
    expect(mount.querySelector('[aria-label="Conversation header"]')).toBeNull();
    expect(container.textContent).not.toContain('Your conversation with the team');
    expect(container.textContent).not.toContain('Your request');
    await act(async () => slot.querySelector<HTMLButtonElement>('[aria-label="Open technical timeline"]')!.click());
    expect(useStore.getState().activeView).toBe('timeline');
    await act(async () => slot.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')!.click());
    expect(useStore.getState().activeView).toBe('command');
    expect(useStore.getState().selectedTaskId).toBeNull();
    expect(useStore.getState().tasks).toHaveLength(1);
    await act(async () => root?.unmount());
    root = undefined;
    expect(slot.childElementCount).toBe(0);
  });

  it('shows routing instead of inventing an Agent before assignment', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'queued', assigneeId: undefined }], executions: [] });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const header = container.querySelector('[aria-label="Conversation header"]')!;
    expect(header.textContent).toContain('Selecting an Agent');
    expect(header.textContent).toContain('Routing');
    expect(header.textContent).not.toContain('Master Agent');
  });

  it('uses the opening clause for a long request without losing the original', async () => {
    const request = '帮我收集一下仙本那比较好的水屋推荐，从价格和优势各方面寻找资料，我需要性价比高的，还有就是价格不超过1000/晚';
    useStore.setState({ tasks: [{ ...task, title: request, input: request }] });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const heading = container.querySelector('h1')!;
    expect(heading.textContent).toBe('帮我收集一下仙本那比较好的水屋推荐');
    expect(heading.title).toBe(request);
    expect(container.querySelector('[aria-label="Task conversation"]')?.textContent).toContain(request);
    expect(useStore.getState().tasks[0].title).toBe(request);
  });

  it('caps unbroken long titles and preserves short descriptive titles', async () => {
    const title = 'Long uninterrupted conversation title '.repeat(10);
    useStore.setState({ tasks: [{ ...task, title }] });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    expect(Array.from(container.querySelector('h1')!.textContent!).length).toBeLessThanOrEqual(33);
    expect(container.querySelector('h1')!.textContent).toMatch(/…$/);
    await act(async () => useStore.setState({ tasks: [{ ...task, title: '方案 A，方案 B' }] }));
    expect(container.querySelector('h1')!.textContent).toBe('方案 A，方案 B');
  });

  it('folds repeated tool calls into one closed group with expandable raw evidence', async () => {
    useStore.setState({
      executionMessages: { [execution.id]: [
        ...Array.from({ length: 8 }, (_, index) => ({
          id: index, executionId: execution.id, type: 'tool_use' as const,
          toolName: 'web.search', content: `{"query":"search ${index}"}`, createdAt: task.createdAt,
        })),
        ...Array.from({ length: 8 }, (_, index) => ({
          id: index + 8, executionId: execution.id, type: 'tool_result' as const,
          toolName: 'web.search', content: 'Search failed: fetch failed', createdAt: task.createdAt,
        })),
      ] },
    });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const groups = container.querySelectorAll<HTMLDetailsElement>('[aria-label="Tool activity"]');
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.open).toBe(false);
    expect(group.querySelector('summary')?.textContent).toContain('8 calls · 8 results');
    expect(group.querySelectorAll('pre')).toHaveLength(0);
    await act(async () => {
      group.open = true;
      group.dispatchEvent(new Event('toggle'));
    });
    expect(group.querySelectorAll('details')).toHaveLength(16);
    expect(group.querySelectorAll('pre')).toHaveLength(16);
    expect(group.textContent).toContain('{"query":"search 0"}');
    expect(group.textContent).toContain('Search failed: fetch failed');
    expect([...group.querySelectorAll('details')].every(item => !item.open)).toBe(true);
    await act(async () => {
      group.open = false;
      group.dispatchEvent(new Event('toggle'));
    });
    expect(group.querySelectorAll('pre')).toHaveLength(0);
    expect(useStore.getState().executionMessages[execution.id]).toHaveLength(16);
  });

  it('shows Xiaohongshu phase timing in collapsed and expanded tool activity', async () => {
    const diagnostics = {
      source: 'xiaohongshu', operation: 'search', durationMs: 55_200,
      phases: [
        { phase: 'queued', message: '已进入小红书浏览器操作队列', elapsedMs: 0 },
        { phase: 'requesting_search', message: '正在等待小红书搜索结果', elapsedMs: 120 },
        { phase: 'read_timeout', message: '小红书上游页面或接口未在预算内返回', elapsedMs: 55_200 },
      ],
    };
    useStore.setState({ executionMessages: { [execution.id]: [
      { id: 1, executionId: execution.id, type: 'tool_use', toolName: 'mcp__xiaohongshu__search_feeds', content: '{"keyword":"水屋"}', createdAt: task.createdAt },
      { id: 2, executionId: execution.id, type: 'tool_result', toolName: 'mcp__xiaohongshu__search_feeds',
        content: JSON.stringify({ kind: 'research_result', status: 'failed', output: '[XHS_READ_TIMEOUT]', diagnostics }), createdAt: task.createdAt },
    ] } });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const group = container.querySelector<HTMLDetailsElement>('[aria-label="Tool activity"]')!;
    expect(group.querySelector('summary')?.textContent).toContain('小红书 55.2s');
    await act(async () => {
      group.open = true;
      group.dispatchEvent(new Event('toggle'));
    });
    expect(group.querySelector('[aria-label="Xiaohongshu execution phases"]')?.textContent).toContain('正在等待小红书搜索结果');
    expect(group.textContent).toContain('55.2s');
    expect(group.querySelectorAll('pre')[1].textContent).toBe('[XHS_READ_TIMEOUT]');
    expect(group.querySelectorAll('pre')[1].textContent).not.toContain('"diagnostics"');
  });

  it('keeps replies and errors outside tool groups and separates executions', async () => {
    const nextExecution = { ...execution, id: 'another-execution' };
    const message = { executionId: execution.id, createdAt: task.createdAt };
    useStore.setState({
      executions: [execution, nextExecution],
      executionMessages: {
        [execution.id]: [
          { ...message, id: 1, type: 'tool_result', toolName: 'web.search', content: 'old result without input' },
          { ...message, id: 2, type: 'agent_text', content: 'Visible response' },
          { ...message, id: 3, type: 'error', content: 'Visible execution error' },
          { ...message, id: 4, type: 'tool_result', toolName: 'web.fetch', content: 'another result' },
        ],
        [nextExecution.id]: [
          { ...message, executionId: nextExecution.id, id: 5, type: 'tool_use', toolName: 'file_read', content: '{}' },
        ],
      },
    });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const groups = container.querySelectorAll('[aria-label="Tool activity"]');
    expect(groups).toHaveLength(3);
    expect(groups[0].textContent).toContain('1 result');
    expect(groups[2].textContent).toContain('1 call · 0 results');
    expect(container.textContent).toContain('Visible response');
    expect(container.textContent).toContain('Visible execution error');
    expect([...groups].some(group => group.textContent?.includes('Visible'))).toBe(false);
  });

  it('renders GFM tables, lists, links, bold and code while blocking active HTML', () => {
    const html = renderToStaticMarkup(<MarkdownMessage content={'**Summary**\n\n| Name | Price |\n|---|---|\n| A | 12 |\n\n- Option\n\n```ts\nconst a = 1;\n```\n\n[Source](https://example.org)\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert%281%29)'} />);
    expect(html).toContain('<strong>Summary</strong>');
    expect(html).toContain('<table');
    expect(html).toContain('<ul>');
    expect(html).toContain('<pre>');
    expect(html).toContain('https://example.org');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="javascript:');
  });

  it('replaces a historical 500-character preview with the entire final output', async () => {
    const output = `**Summary**\n\n${'Detailed comparison. '.repeat(45)}\n\n| Name | Price |\n|---|---|\n| A | 12 |\n| B | 15 |\n\n## Sources and limitations\nSearch failed; these are unverified examples.`;
    useStore.setState({
      tasks: [{ ...task, status: 'done', output }],
      executions: [{ ...execution, status: 'done' }],
      executionMessages: { [execution.id]: [{
        id: 1, executionId: execution.id, type: 'agent_text',
        content: output.slice(0, 500), createdAt: task.createdAt,
      }] },
    });
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    expect(container.querySelectorAll('strong').length).toBe(1);
    expect(container.querySelectorAll('table tbody tr').length).toBe(2);
    expect(container.textContent).toContain('Search failed; these are unverified examples.');
    expect(container.textContent).toContain('legacy-writer');
  });

  it('renders incremental Markdown and hands off to a single complete message', async () => {
    vi.spyOn(api.tasks, 'get').mockResolvedValue(task);
    await act(async () => { root = createRoot(container); root.render(<Harness />); });
    const send = async (type: string, payload: unknown) => {
      await act(async () => { await handlers.get(type)?.({ type, payload } as WSEvent); });
    };
    await send('token:delta', { executionId: execution.id, delta: '**Summary**\n\n| Name | Price |\n|---|---|\n| A |' });
    expect(container.querySelector('strong')?.textContent).toBe('Summary');
    await send('token:delta', { executionId: execution.id, delta: ' 12 |\n\nFinal paragraph.' });
    expect(container.querySelector('table')?.textContent).toContain('12');
    const output = useStore.getState().streamingResponses[execution.id];
    const message = { id: 1, executionId: execution.id, type: 'agent_text', content: output, createdAt: task.createdAt };
    await send('execution:message', { executionId: execution.id, taskId: task.id, message });
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.textContent).toContain('Final paragraph.');
    expect(container.querySelector('[aria-label="Generating"]')).toBeNull();
    expect(useStore.getState().streamingResponses[execution.id]).toBeUndefined();
    // A new model turn must not start with the previous turn's Markdown.
    await send('token:delta', { executionId: execution.id, delta: 'Next response' });
    expect(useStore.getState().streamingResponses[execution.id]).toBe('Next response');
  });

  it('does not discard the start of a long streamed response', () => {
    useStore.getState().appendStreamingResponse(execution.id, '# Beginning\n');
    useStore.getState().appendStreamingResponse(execution.id, 'x'.repeat(33_000));
    expect(useStore.getState().streamingResponses[execution.id]).toMatch(/^# Beginning/);
  });

  it('keeps the composer available after completion and creates a visible user turn in the same session', async () => {
    const finished = { ...task, status: 'done' as const, output: 'Original answer', completedAt: '2026-09-13T00:01:00Z' };
    useStore.setState({ tasks: [finished], executions: [{ ...execution, status: 'done' }] });
    const next: Task = {
      ...task, id: 'next-turn', parentTaskId: task.id, createdBy: 'user', status: 'queued',
      title: 'Compare A and B', description: 'Compare A and B',
      input: 'INTERNAL INHERITED PROMPT: not shown to the user',
      createdAt: '2026-09-13 00:02:00',
    };
    const continueTask = vi.spyOn(api.tasks, 'continue').mockResolvedValue(next);
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Follow-up instruction"]')!;
    expect(input.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Compare A and B');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(continueTask).toHaveBeenCalledWith(task.id, 'Compare A and B');
    expect(container.textContent).toContain('Original answer');
    expect(container.textContent).toContain('Compare A and B');
    expect(container.textContent).not.toContain('INTERNAL INHERITED PROMPT');
    expect(container.textContent).toContain('1 conversations');
    expect(useStore.getState().tasks.find(item => item.id === task.id)?.status).toBe('done');
    expect(useStore.getState().selectedTaskId).toBe('next-turn');
  });

  it('retains a follow-up draft when continuation fails', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'failed' }], executions: [{ ...execution, status: 'failed' }] });
    vi.spyOn(api.tasks, 'continue').mockRejectedValue(new Error('Workspace directory does not exist'));
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Follow-up instruction"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Try again');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(input.value).toBe('Try again');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Workspace directory does not exist');
  });

  it('sends with Enter but not Shift+Enter or IME confirmation', async () => {
    const send = vi.spyOn(api.executions, 'sendMessage').mockResolvedValue({} as never);
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '第一行\n第二行');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const press = async (init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
      await act(async () => { input.dispatchEvent(event); });
      return event;
    };
    expect((await press({ shiftKey: true })).defaultPrevented).toBe(false);
    await press({ isComposing: true });
    await press({ keyCode: 229 });
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    await press();
    expect(send).not.toHaveBeenCalled();
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    expect((await press()).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(execution.id, '第一行\n第二行', 'user_follow_up');
    expect(input.value).toBe('');
    expect(input.style.height).toBe('44px');
    await press();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('caps multiline height and uses compact user bubbles with external timestamps', async () => {
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 500 });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Many lines\n'.repeat(20));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.style.height).toBe('160px');
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 20 });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.style.height).toBe('44px');
    const bubble = container.querySelector('[aria-label="Your message"]')!;
    expect(bubble.classList.contains('w-fit')).toBe(true);
    expect(bubble.classList.contains('ml-auto')).toBe(true);
    expect(bubble.querySelector('p')?.textContent).toBe(task.input);
    expect(bubble.querySelector('p time')).toBeNull();
    expect(bubble.querySelector('time')).not.toBeNull();
    expect(bubble.textContent).not.toContain('follow-up');
  });

  it('does not submit a draft to a queued execution via Enter', async () => {
    useStore.setState({ tasks: [{ ...task, status: 'queued' }], executions: [] });
    const send = vi.spyOn(api.executions, 'sendMessage');
    const continueTask = vi.spyOn(api.tasks, 'continue');
    await act(async () => { root = createRoot(container); root.render(<TaskSession />); });
    const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Wait for me');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(send).not.toHaveBeenCalled();
    expect(continueTask).not.toHaveBeenCalled();
    expect(input.value).toBe('Wait for me');
  });

  it('uploads a session file and previews parsed text without treating it as HTML', async () => {
    vi.spyOn(api.tasks, 'documents').mockResolvedValue([]);
    const upload = vi.spyOn(api.tasks, 'uploadDocument').mockResolvedValue({
      id: 'doc', name: 'notes.md', sizeBytes: 12, passageCount: 1, createdAt: task.createdAt,
    });
    vi.spyOn(api.tasks, 'document').mockResolvedValue({
      id: 'doc', name: 'notes.md', passages: [{ locator: 'Paragraph 1', text: '<script>private note</script>' }],
    });
    const onParsingChange = vi.fn();
    await act(async () => { root = createRoot(container); root.render(<SessionDocuments taskId={task.id} onParsingChange={onParsingChange} />); });
    const file = new File(['Private note'], 'notes.md', { type: 'text/markdown' });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(upload).toHaveBeenCalledWith(task.id, file);
    expect(onParsingChange.mock.calls).toEqual([[true], [false]]);
    expect(container.textContent).toContain('Ready · 1 passages');
    const preview = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('notes.md'))!;
    await act(async () => preview.click());
    expect(container.querySelector('[aria-label="Parsed document preview"]')?.textContent).toContain('Paragraph 1');
    expect(container.querySelector('script')).toBeNull();
  });
});
