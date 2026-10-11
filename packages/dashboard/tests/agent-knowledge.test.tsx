// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentKnowledgeSource, ResolvedKnowledgeCitation } from '@myrmecia/shared';
import { AgentKnowledgeEditor } from '../src/components/agents/AgentKnowledgeEditor';
import { MarkdownMessage } from '../src/components/common/MarkdownMessage';
import { ExecutionKnowledgeSources } from '../src/components/common/ExecutionKnowledgeSources';
import { api, ApiError } from '../src/lib/api';

const source: AgentKnowledgeSource = { sourceId: 'source-1', bindingId: 'binding-1', title: 'notes.md', scope: 'agent_private',
  ownerId: 'agent-1', version: 1, sourceHash: 'a'.repeat(64), passageHash: 'b'.repeat(64), sizeBytes: 1024, passageCount: 2, createdAt: '' };
const citation: ResolvedKnowledgeCitation = { id: 'K1', sourceId: source.sourceId, sourceHash: source.sourceHash,
  passageHash: source.passageHash, version: 1, title: 'notes.md', scope: 'agent_private', ownerId: 'agent-1',
  locator: 'Paragraph 1', shortened: false, href: '#citation-K1', text: 'Actual retrieved source text, not an instruction.' };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(api.agents.knowledge, 'list').mockResolvedValue({ agentPrivate: [source],
    teams: [{ id: 'team-1', name: 'Readers', sources: [] }], unbound: [] });
  vi.spyOn(api.agents.knowledge, 'upload').mockResolvedValue(source);
  vi.spyOn(api.agents.knowledge, 'unbind').mockResolvedValue({ ok: true });
  vi.spyOn(api.agents.knowledge, 'bind').mockResolvedValue(source);
  vi.spyOn(api.agents.knowledge, 'remove').mockResolvedValue({ ok: true });
  vi.spyOn(api.executions, 'citation').mockResolvedValue(citation);
  vi.spyOn(api.executions, 'knowledge').mockResolvedValue({ schemaVersion: 1, executionId: 'run-1',
    taskId: 'task-1', agentId: 'agent-1', workspaceId: 'default', citations: [citation],
    omitted: true, includedCharacters: 100, createdAt: '' });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
});
const mount = () => act(async () => root.render(<AgentKnowledgeEditor agentId="agent-1" />));
const click = (text: string) => act(async () => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text);
  expect(button).toBeDefined(); button!.click();
});
async function chooseFile(file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  await act(async () => { Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true })); });
}
describe('knowledge editor and citations', () => {
  it('shows private/Team/session scopes and never uploads or binds on mount', async () => {
    await mount();
    expect(container.textContent).toContain('Agent 私有'); expect(container.textContent).toContain('Team 共享');
    expect(container.textContent).toContain('会话临时'); expect(container.textContent).toContain('notes.md');
    expect(api.agents.knowledge.upload).not.toHaveBeenCalled(); expect(api.agents.knowledge.bind).not.toHaveBeenCalled();
  });
  it('uploads files with explicit scope, confirms Team sharing and rejects empty/oversized input', async () => {
    await mount(); const file = new File(['Evidence'], 'evidence.md', { type: 'text/markdown' });
    await chooseFile(file);
    expect(api.agents.knowledge.upload).toHaveBeenCalledWith('agent-1', file, 'agent_private', undefined);
    expect(container.textContent).toContain('需显式发布新版');
    const select = container.querySelector<HTMLSelectElement>('[aria-label="知识上传范围"]')!;
    await act(async () => { select.value = 'team:team-1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    vi.mocked(window.confirm).mockReturnValue(false); await chooseFile(file);
    expect(api.agents.knowledge.upload).toHaveBeenCalledTimes(1);
    vi.mocked(window.confirm).mockReturnValue(true); await chooseFile(file);
    expect(api.agents.knowledge.upload).toHaveBeenLastCalledWith('agent-1', file, 'team_shared', 'team-1');
    await chooseFile(new File([], 'empty.md'));
    expect(container.querySelector('[role=alert]')?.textContent).toContain('5 MB');
    expect(api.agents.knowledge.upload).toHaveBeenCalledTimes(2);
  });
  it('requires confirmation for unbinding and deletion, surfaces failures and supports explicit rebind', async () => {
    await mount(); vi.mocked(window.confirm).mockReturnValue(false); await click('解除绑定');
    expect(api.agents.knowledge.unbind).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    vi.mocked(api.agents.knowledge.unbind).mockRejectedValueOnce(new Error('Binding revoked'));
    await click('解除绑定'); expect(container.querySelector('[role=alert]')?.textContent).toContain('Binding revoked');
    vi.mocked(api.agents.knowledge.list).mockResolvedValue({ agentPrivate: [], teams: [], unbound: [{ ...source, bindingId: '' }] });
    await click('刷新'); await click('重新绑定');
    expect(api.agents.knowledge.bind).toHaveBeenCalledWith('agent-1', source.sourceId);
    await click('删除来源'); expect(api.agents.knowledge.remove).toHaveBeenCalledWith('agent-1', source.sourceId);
  });
  it('resolves only explicit citation clicks and rechecks revoked access every time it is opened', async () => {
    await act(async () => root.render(<MarkdownMessage content={'Evidence [K1](#citation-K1). [Website](https://example.com)'} executionId="run-1" />));
    expect(api.executions.citation).not.toHaveBeenCalled();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    const button = container.querySelector<HTMLButtonElement>('[aria-label="查看知识引用 K1"]')!;
    await act(async () => button.click());
    expect(api.executions.citation).toHaveBeenCalledWith('run-1', 'K1');
    expect(container.textContent).toContain('notes.md · Paragraph 1'); expect(container.textContent).toContain(citation.text);
    expect(container.textContent).toContain('不代表模型结论');
    await act(async () => button.click());
    vi.mocked(api.executions.citation).mockRejectedValueOnce(new ApiError('Source was revoked', 410));
    await act(async () => button.click());
    expect(container.textContent).toContain('Source was revoked'); expect(container.textContent).not.toContain(citation.text);
  });
  it('does not bless fabricated citations or citations without an execution and keeps raw HTML disabled', async () => {
    await act(async () => root.render(<MarkdownMessage content={'<script>alert(1)</script>\n\n[K999](#citation-K999)'} />));
    expect(container.querySelector('script')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(api.executions.citation).not.toHaveBeenCalled();
    expect(container.textContent).toContain('此引用尚未验证');
    await act(async () => root.render(<MarkdownMessage content={'[K999](#citation-K999)'} executionId="run-1" />));
    vi.mocked(api.executions.citation).mockRejectedValueOnce(new ApiError('Citation was not retrieved', 404));
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.textContent).toContain('Citation was not retrieved');
  });
  it('ignores a late citation response after switching executions', async () => {
    let resolve: (value: ResolvedKnowledgeCitation) => void = () => {};
    vi.mocked(api.executions.citation).mockReturnValueOnce(new Promise(res => { resolve = res; }));
    await act(async () => root.render(<MarkdownMessage content={'[K1](#citation-K1)'} executionId="old-run" />));
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => root.render(<MarkdownMessage content={'[K1](#citation-K1)'} executionId="new-run" />));
    await act(async () => resolve(citation));
    expect(container.textContent).not.toContain(citation.text);
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  });
  it('loads the manifest only when opened and labels omitted passages independently of model citations', async () => {
    await act(async () => root.render(<ExecutionKnowledgeSources executionId="run-1" />));
    expect(api.executions.knowledge).not.toHaveBeenCalled();
    const details = container.querySelector('details')!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    expect(api.executions.knowledge).toHaveBeenCalledWith('run-1');
    expect(container.textContent).toContain('notes.md'); expect(container.textContent).toContain('部分来源未纳入');
    expect(api.executions.citation).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看知识引用 K1"]')!.click());
    expect(container.textContent).toContain(citation.text);
  });
});
