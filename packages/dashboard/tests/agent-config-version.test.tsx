// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigHistory, AgentConfigVersion } from '@myrmecia/shared';
import { AgentVersionHistory } from '../src/components/agents/AgentVersionHistory';
import { api } from '../src/lib/api';

const revision: AgentConfigVersion = {
  id: 'version-1', agentId: 'agent-1', workspaceId: 'default', sequence: 1, configHash: 'a'.repeat(64),
  origin: 'publish', createdBy: 'user', createdAt: '',
  snapshot: { schemaVersion: 1, agentId: 'agent-1', name: 'Fixture', role: 'analyst', emoji: '🤖',
    description: 'Research', whenToUse: 'Questions', capabilities: [], triggers: [], systemInstructions: 'Answer in Chinese',
    config: { model: 'fixture', maxTurns: 8, timeout: 300 }, allowedTools: ['file_read'], disallowedTools: [],
    skill: null, domain: null },
};
const history: AgentConfigHistory = {
  activeVersionId: null, workingConfigHash: 'b'.repeat(64), workingChanges: ['systemInstructions'], versions: [revision],
};
const ready = { checkedAt: '', canTest: true, status: 'ready_for_test' as const,
  model: { requestedId: 'fixture', health: 'unknown' }, checks: [] };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.spyOn(api.agents.versions, 'list').mockResolvedValue(history);
  vi.spyOn(api.agents.versions, 'preflight').mockResolvedValue(ready);
  vi.spyOn(api.agents.versions, 'publish').mockResolvedValue(revision);
  vi.spyOn(api.agents.versions, 'rollback').mockResolvedValue(revision);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function mount() { await act(async () => root.render(<AgentVersionHistory agentId="agent-1" />)); }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
  expect(button).toBeDefined(); await act(async () => button.click());
}
describe('Agent configuration history controls', () => {
  it('requires a capability check and explicit confirmation before publishing expected versions', async () => {
    await mount();
    expect([...container.querySelectorAll('button')].find(item => item.textContent === '发布工作配置')?.disabled).toBe(true);
    await click('检查工作配置'); await click('发布工作配置');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('排队、运行、暂停'));
    expect(api.agents.versions.publish).toHaveBeenCalledWith('agent-1', {
      expectedCurrentVersionId: null, expectedConfigHash: 'b'.repeat(64),
    });
    expect(container.textContent).toContain('仅影响后续任务');
  });
  it('shows version content/differences and checks before rollback', async () => {
    vi.mocked(api.agents.versions.list).mockResolvedValue({
      ...history, activeVersionId: 'version-2', versions: [{ ...revision, id: 'version-2', sequence: 2,
        snapshot: { ...revision.snapshot, systemInstructions: 'New instructions' } }, revision],
    });
    await mount();
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.startsWith('v1'))!;
    await act(async () => button.click());
    expect(container.textContent).toContain('系统指令'); expect(container.textContent).toContain('Answer in Chinese');
    await click('检查此版本'); await click('回滚到此版本');
    expect(api.agents.versions.rollback).toHaveBeenCalledWith('agent-1', revision.id,
      { expectedCurrentVersionId: 'version-2', expectedConfigHash: 'b'.repeat(64) });
  });
  it('does not publish on cancel or blocked preflight and surfaces server conflicts', async () => {
    await mount();
    vi.mocked(api.agents.versions.preflight).mockResolvedValue({ ...ready, canTest: false });
    await click('检查工作配置');
    expect([...container.querySelectorAll('button')].find(item => item.textContent === '发布工作配置')?.disabled).toBe(true);
    vi.mocked(api.agents.versions.preflight).mockResolvedValue(ready);
    await click('检查工作配置');
    vi.mocked(window.confirm).mockReturnValue(false);
    await click('发布工作配置'); expect(api.agents.versions.publish).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    vi.mocked(api.agents.versions.publish).mockRejectedValue(new Error('Active revision changed'));
    await click('发布工作配置'); expect(container.querySelector('[role=alert]')?.textContent).toContain('Active revision changed');
  });
});
