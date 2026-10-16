// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubFixDiff, GitHubFixRun } from '@myrmecia/shared';
import { GitHubDeliveryReview } from '../src/components/github/GitHubDeliveryReview';
import { api } from '../src/lib/api';
const run: GitHubFixRun = { id: 'fix-1', workspaceId: 'w', repository: 'example/repo', repositoryUrl: '',
  baseBranch: 'main', workBranch: 'codex/fix', localPath: '/fixture/repo', viewerPermission: 'WRITE',
  status: 'ready', createdAt: '', updatedAt: '' };
const diff: GitHubFixDiff = { status: '?? new.py', stat: 'added new.py', patch: '+print("real preview")',
  hasChanges: true, diffHash: 'a'.repeat(64), baseHead: 'head', branch: 'codex/fix',
  files: [{ path: 'new.py', change: 'added', sha256: 'b'.repeat(64), bytes: 10 }],
  blockers: [], truncated: false, suggestedCommand: 'npm test' };
const verified: GitHubFixDiff = { ...diff, publicationState: 'passed',
  validation: { status: 'passed', command: 'npm test', diffHash: diff.diffHash, executionId: 'verification-1', checkedAt: '' } };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(api.githubFixes, 'diff').mockResolvedValue(structuredClone(diff));
  vi.spyOn(api.githubFixes, 'verify').mockResolvedValue(structuredClone(verified));
  vi.spyOn(api.githubFixes, 'createPullRequest').mockResolvedValue({ ...run, status: 'pr_created', prUrl: 'https://github.com/example/repo/pull/1' });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const mount = (value = run) => act(async () => root.render(<GitHubDeliveryReview run={value} onPublished={() => {}} />));
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text);
const click = (text: string) => act(async () => button(text)!.click());
async function fill(label: string, value: string) {
  const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
describe('reviewed GitHub publication UI', () => {
  it('does not offer publication merely because the task is ready', async () => {
    await mount(); expect(button('Create PR')).toBeUndefined();
    await click('审阅 Diff'); expect(container.textContent).toContain('real preview');
    expect(api.githubFixes.verify).not.toHaveBeenCalled();
    expect(api.githubFixes.createPullRequest).not.toHaveBeenCalled();
  });
  it('requires validation, expanded review, human acceptance and the confirmation phrase', async () => {
    await mount(); await click('验证当前文件版本');
    expect(api.githubFixes.verify).toHaveBeenCalledWith(run.id, { confirm: true, command: 'npm test', diffHash: diff.diffHash, files: ['new.py'] });
    expect(button('Create PR')!.disabled).toBe(true);
    expect((container.querySelector('[aria-label="接受已审阅交付"]') as HTMLInputElement).disabled).toBe(true);
    await click('审阅 Diff');
    await act(async () => (container.querySelector('[aria-label="接受已审阅交付"]') as HTMLInputElement).click());
    await fill('创建 PR 确认', 'CREATE PR'); await click('Create PR');
    expect(api.githubFixes.createPullRequest).toHaveBeenCalledWith(run.id, expect.objectContaining({
      confirm: true, acceptDelivery: true, diffHash: diff.diffHash, files: ['new.py'],
    }));
  });
  it('invalidates acceptance when the validation command changes or review is refreshed', async () => {
    await mount(); await click('验证当前文件版本');
    await fill('GitHub 验证命令', 'cargo test'); expect(button('Create PR')).toBeUndefined();
    await click('刷新审阅'); expect(button('Create PR')).toBeUndefined();
  });
  it('discards delayed old-run previews after switching sessions', async () => {
    let resolve!: (value: GitHubFixDiff) => void;
    vi.mocked(api.githubFixes.diff).mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce({ ...diff, patch: 'new-session-only' });
    await mount(); await mount({ ...run, id: 'fix-2' });
    await act(async () => resolve({ ...diff, patch: 'stale-old-session' }));
    await click('审阅 Diff');
    expect(container.textContent).toContain('new-session-only');
    expect(container.textContent).not.toContain('stale-old-session');
  });
  it('rejects failed/stale verification and keeps publication unavailable', async () => {
    vi.mocked(api.githubFixes.verify).mockResolvedValue({ ...verified, validation: { ...verified.validation!, status: 'failed' } });
    await mount(); await click('验证当前文件版本'); expect(button('Create PR')).toBeUndefined();
    expect(container.textContent).toContain('验证失败');
  });
});
