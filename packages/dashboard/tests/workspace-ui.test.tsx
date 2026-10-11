// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { ExecutionWorkspacePanel } from '../src/components/session/ExecutionWorkspacePanel';
import { WorkspaceManagement } from '../src/components/common/WorkspaceManagement';
import type { ManagedWorkspace, WorkspaceOperationPreview } from '@myrmecia/shared';
const workspace: ManagedWorkspace = { id: 'fsw-ui', workspaceId: 'default', actorId: 'local-admin', sourceKind: 'empty',
  canonicalPath: '/fixture/new-root', ownership: 'managed_execution', accessMode: 'isolated',
  baseline: { provenance: 'empty', excluded: [] }, lifecycle: 'active', revision: 3, captureState: 'complete',
  lastUsedAt: '2026-10-11T00:00:00Z', createdAt: '2026-10-11T00:00:00Z' };
const facts = (id: string, path: string) => ({ workspace: { ...workspace, canonicalPath: path },
  binding: { taskId: id, workspaceId: 'default', filesystemWorkspaceId: workspace.id, executionPath: path,
    accessMode: 'isolated' as const, baseline: workspace.baseline }, diagnostics: [], occupants: [] });
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const click = (text: string) => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text)!.click());
describe('workspace UI evidence and confirmations', () => {
  it('does not show an old task response after switching sessions', async () => {
    let resolveOld!: (value: ReturnType<typeof facts>) => void;
    const old = new Promise<ReturnType<typeof facts>>(resolve => { resolveOld = resolve; });
    vi.spyOn(api.managedWorkspaces, 'task').mockImplementation(id => id === 'a' ? old : Promise.resolve(facts('b', '/fixture/new-root')));
    await act(async () => root.render(<ExecutionWorkspacePanel taskId="a" />));
    await act(async () => root.render(<ExecutionWorkspacePanel taskId="b" />));
    await act(async () => resolveOld(facts('a', '/fixture/old-root')));
    expect(container.textContent).toContain('/fixture/new-root');
    expect(container.textContent).not.toContain('/fixture/old-root');
    expect(container.textContent).toContain('产物 complete');
    expect(container.textContent).toContain('不等于操作系统沙箱');
  });
  it('focuses cancellation, uses server preview and never optimistically archives after a conflict', async () => {
    vi.spyOn(api.managedWorkspaces, 'list').mockResolvedValue([{ ...workspace, occupants: [], blockers: [], snapshotBytes: 512 }]);
    const preview: WorkspaceOperationPreview = { previewId: 'preview-ui', operation: 'archive', workspace,
      blockers: [], manifestHash: 'a'.repeat(64), expiresAt: '2026-10-11T00:05:00Z', preservesFiles: true };
    vi.spyOn(api.managedWorkspaces, 'preview').mockResolvedValue(preview);
    const operation = vi.spyOn(api.managedWorkspaces, 'operate').mockRejectedValue(new Error('WORKSPACE_PREVIEW_STALE'));
    await act(async () => root.render(<WorkspaceManagement />));
    await click('归档（保留文件）');
    expect(document.activeElement?.textContent).toBe('取消');
    await click('确认归档');
    expect(operation).toHaveBeenCalledWith(preview);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('WORKSPACE_PREVIEW_STALE');
    expect(container.textContent).toContain('active');
    expect(container.textContent).not.toContain('archived');
  });
});
