import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { parseVerificationCommand, type GitHubFixDiff, type GitHubFixRun } from '@myrmecia/shared';
import { getDb } from '../db/database.js';
import { getTask, createTask, updateTask, listTasks } from '../db/models/task.js';
import { createExecution, getExecution, listExecutions, updateExecution } from '../db/models/execution.js';
import { updateGitHubFixRun } from '../db/models/github-fix.js';
import { safeWorkspacePath, readWorkspaceBytes, excludedWorkspacePath, ownGitRoot, canonicalRoot } from '../workspace/path-policy.js';
import { withWorkspaceLease, markCurrentWorkspaceLeaseUncertain, assertWorkspaceToolAllowed } from '../workspace/workspace-lease.js';
import { withOwnedRun } from '../agents/run-coordinator.js';
import { verifyCompletionCriteria, completionEvidenceIsFresh } from '../agents/completion-gate.js';
import { initialAgentRunState } from '../agents/run-state.js';
import { redactSecrets } from '../skills/tool-guardian.js';
import { dlpCheck } from '../security/dlp.js';
import { resolveTestCommand } from '../skills/step-validator.js';
import { activeRunLease } from '../db/models/run-ownership.js';
import { reconcileToolResourceLocks } from '../agents/tool-resource-lock.js';

export type GitHubCommandRunner = (command: string, args: string[], cwd?: string, timeoutMs?: number) => Promise<string>;
export interface GitHubReviewInput {
  diffHash: string;
  files: string[];
}
export interface GitHubPublicationInput extends GitHubReviewInput {
  acceptDelivery: true;
  allowFork?: boolean;
  title?: string;
  body?: string;
  commitMessage?: string;
}
interface Receipt {
  diffHash: string;
  baseHead: string;
  files: string[];
  validation: NonNullable<GitHubFixDiff['validation']>;
  verificationTaskId: string;
  actorId: string;
  reviewFiles: GitHubFixDiff['files'];
  publication?: { title: string; body: string; commitMessage: string; acceptedBy: string; head: string;
    remote: string; login: string; commitHash?: string; expectedTree?: string; forkRepository?: string; forkReady?: boolean; uncertainStage?: string };
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const activeStates = new Set(['verifying', 'forking', 'committing', 'pushing', 'creating_pr', 'uncertain', 'committed', 'pushed', 'pr_created']);
function isPrUrl(value: string, repository: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com'
    && url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/pull/`) && /\/pull\/[1-9]\d*$/.test(url.pathname); }
  catch { return false; }
}
function isRepositoryRemote(value: string, repository: string): boolean {
  const ssh = value.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (ssh) return ssh[1].toLowerCase() === repository.toLowerCase();
  try {
    const url = new URL(value);
    return ['https:', 'ssh:'].includes(url.protocol) && url.hostname === 'github.com'
      && !url.password && (url.protocol === 'ssh:' ? url.username === 'git' : !url.username)
      && !url.search && !url.hash && !url.port
      && url.pathname.replace(/^\//, '').replace(/\.git$/, '').toLowerCase() === repository.toLowerCase();
  } catch { return false; }
}

export class GitHubFixDelivery {
  private verifiers = new Map<string, { controller: AbortController; taskId: string }>();
  private publishers = new Set<string>();
  constructor(private run: GitHubCommandRunner) {}
  private async inspectFork(repository: string, parent: string, cwd: string): Promise<void> {
    const info = JSON.parse(await this.run('gh', ['repo', 'view', repository, '--json', 'nameWithOwner,isFork,parent'], cwd, 30_000));
    if (info.nameWithOwner?.toLowerCase() !== repository.toLowerCase() || info.isFork !== true
      || info.parent?.nameWithOwner?.toLowerCase() !== parent.toLowerCase()) throw new Error('GITHUB_FORK_PARENT_MISMATCH');
  }
  private receipt(fix: GitHubFixRun): { operationId: string; state: string; data: Receipt } | undefined {
    const row = getDb().get<any>('SELECT * FROM github_fix_deliveries WHERE run_id=? AND workspace_id=?', fix.id, fix.workspaceId);
    return row ? { operationId: row.operation_id, state: row.state, data: JSON.parse(row.data_json) } : undefined;
  }
  private save(fix: GitHubFixRun, operationId: string, state: string, data: Receipt): void {
    if (!getDb().run(`UPDATE github_fix_deliveries SET state=?,data_json=?,updated_at=?
      WHERE run_id=? AND workspace_id=? AND operation_id=?`, state, JSON.stringify(data), new Date().toISOString(),
    fix.id, fix.workspaceId, operationId).changes) throw new Error('GITHUB_DELIVERY_FENCE_LOST');
  }
  private requireSettled(fix: GitHubFixRun): void {
    const task = fix.taskId && getTask(fix.taskId);
    if (!task || task.workspaceId !== fix.workspaceId || task.status !== 'done') throw new Error('GITHUB_TASK_NOT_READY: successfully complete the team task before validation/publication');
    for (const member of this.taskTree(fix)) {
      const execution = listExecutions({ taskId: member.id, workspaceId: fix.workspaceId, limit: 1 })[0];
      if (member.status !== 'done' || execution && execution.status !== 'done' || execution?.runState?.acceptance === 'rejected'
        || ['failed', 'unavailable'].includes(execution?.runState?.verification?.status || '')) {
        throw new Error('GITHUB_TASK_EVIDENCE_BLOCKED: teammate execution or required outcome evidence is not accepted for publication');
      }
    }
  }
  private taskTree(fix: GitHubFixRun) {
    const root = fix.taskId && getTask(fix.taskId);
    if (!root || root.workspaceId !== fix.workspaceId) return [];
    const tasks = [root], seen = new Set([root.id]);
    for (let index = 0; index < tasks.length; index++) {
      if (tasks.length > 2000) throw new Error('GITHUB_TASK_TREE_TOO_LARGE');
      for (const child of listTasks({ parentTaskId: tasks[index].id, workspaceId: fix.workspaceId })) {
        if (seen.has(child.id)) throw new Error('GITHUB_TASK_TREE_INVALID');
        seen.add(child.id); tasks.push(child);
      }
    }
    return tasks.sort((a, b) => a.id.localeCompare(b.id));
  }
  async diff(fix: GitHubFixRun): Promise<GitHubFixDiff> {
    if (!ownGitRoot(fix.localPath)) throw new Error('GITHUB_CHECKOUT_UNAVAILABLE');
    const git = (...args: string[]) => this.run('git', args, fix.localPath, 30_000);
    const currentHead = await git('rev-parse', 'HEAD');
    const receipt = this.receipt(fix);
    const resuming = receipt && ['committed', 'pushed'].includes(receipt.state)
      && receipt.data.publication?.commitHash === currentHead;
    const baseHead = resuming ? receipt.data.baseHead : currentHead;
    const branch = await git('branch', '--show-current');
    const status = (await git('status', '--short', '--untracked-files=all')).split('\n')
      .filter(line => !line.slice(3).replace(/^"/, '').startsWith('.agent-factory/')).join('\n');
    const changed = await git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseHead);
    const statusParts = (await git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', baseHead)).split('\0');
    const changes = new Map<string, string>();
    for (let index = 0; index + 1 < statusParts.length; index += 2) changes.set(statusParts[index + 1], statusParts[index]);
    const added = await git('ls-files', '--others', '--exclude-standard', '-z');
    const paths = [...new Set(`${changed}\0${added}`.split('\0').filter(path => path && !path.split('/').includes('.agent-factory')))].sort();
    const blockers: string[] = [], files: GitHubFixDiff['files'] = [], patches: string[] = [];
    let truncated = false, patchSize = 0;
    if (branch !== fix.workBranch) blockers.push('Checkout branch changed; restore the recorded work branch and review again');
    if (resuming && status) blockers.push('Committed publication checkout changed; reconcile before resuming');
    if (receipt?.state === 'uncertain') blockers.push('Prior publication/validation outcome is uncertain; inspect and reconcile it before retrying');
    if (paths.length > 150) { blockers.push('More than 150 changed files; narrow the change set before review'); truncated = true; }
    const untracked = new Set(added.split('\0').filter(Boolean));
    for (const path of paths.slice(0, 150)) {
      if (excludedWorkspacePath(path) || /[\0\r\n\t]/.test(path)) {
        blockers.push(`Excluded or unsupported path cannot be published: ${JSON.stringify(path)}`); continue;
      }
      try {
        const target = safeWorkspacePath(fix.localPath, path);
        const info = existsSync(target) ? lstatSync(target) : undefined;
        if (info && (!info.isFile() || info.size > 1024 * 1024)) throw new Error('unsupported file or exceeds 1 MiB review limit');
        const body = info ? readWorkspaceBytes(fix.localPath, target, 1024 * 1024) : undefined;
        if (body?.includes(0)) throw new Error('binary files require separate manual review');
        if (body && (dlpCheck(body.toString('utf8'), { workspaceId: fix.workspaceId }).violations.length
          || redactSecrets(body.toString('utf8')) !== body.toString('utf8'))) throw new Error('possible secret requires separate review; content omitted');
        const change = resuming ? receipt.data.reviewFiles.find(file => file.path === path)?.change || 'modified'
          : !body ? 'deleted' : untracked.has(path) || changes.get(path) === 'A' ? 'added' : 'modified';
        files.push({ path, change, sha256: body ? sha(body) : null, bytes: body?.length || 0, mode: info ? info.mode & 0o777 : undefined });
        const patch = untracked.has(path)
          ? `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\nnew file\n--- /dev/null\n+++ ${JSON.stringify(`b/${path}`)}\n${body!.toString('utf8').split('\n').map(line => `+${line}`).join('\n')}`
          : await git('--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', baseHead, '--', path);
        patchSize += patch.length;
        if (patchSize > 500_000) { truncated = true; blockers.push('Diff exceeds complete review limit; narrow the change set'); }
        else patches.push(redactSecrets(patch));
      } catch (error: any) { blockers.push(`Cannot safely review ${JSON.stringify(path)}: ${error.message}`); }
    }
    const tasks = this.taskTree(fix);
    const evidence = tasks.map(task => {
      const execution = listExecutions({ taskId: task!.id, workspaceId: fix.workspaceId, limit: 1 })[0];
      return { id: task!.id, status: task!.status, outputHash: sha(task!.output || ''),
        execution: execution ? { id: execution.id, status: execution.status, acceptance: execution.runState?.acceptance,
          verification: execution.runState?.verification } : null };
    });
    const diffHash = sha(JSON.stringify({ baseHead, branch, files, blockers, evidence }));
    let suggestedCommand: string | undefined;
    try { const command = resolveTestCommand(fix.localPath); if (parseVerificationCommand(command)) suggestedCommand = command; } catch { /* Unavailable is not a successful check. */ }
    return { status, stat: files.map(file => `${file.change} ${file.path} (${file.bytes} bytes)`).join('\n'),
      patch: patches.join('\n\n'), hasChanges: paths.length > 0, diffHash, baseHead, branch, files, blockers, truncated,
      ...(receipt ? { publicationState: receipt.state } : {}),
      ...(receipt ? { reconciliationKey: receipt.operationId } : {}),
      ...(suggestedCommand ? { suggestedCommand } : {}),
      ...(receipt?.data.validation ? { validation: receipt.data.validation } : {}) };
  }
  private assertReview(diff: GitHubFixDiff, input: GitHubReviewInput): void {
    if (diff.diffHash !== input.diffHash) throw new Error('GITHUB_REVIEW_STALE: files, HEAD or task evidence changed; refresh and verify the new diff');
    if (diff.blockers.length || diff.truncated || !diff.hasChanges) throw new Error(`GITHUB_REVIEW_BLOCKED: ${diff.blockers.join('; ') || 'No reviewed changes'}`);
    const files = [...new Set(input.files)].sort();
    // Validate the exact whole working change set. Subset tests could depend on
    // unsubmitted edits; do not pretend such a test verifies the submitted tree.
    if (files.length !== input.files.length || JSON.stringify(files) !== JSON.stringify(diff.files.map(file => file.path).sort())) {
      throw new Error('GITHUB_REVIEW_SCOPE_MISMATCH: explicitly review the complete file list; remove unrelated edits before verification');
    }
  }
  async verify(fix: GitHubFixRun, input: GitHubReviewInput & { command: string }, actorId: string): Promise<GitHubFixDiff> {
    this.requireSettled(fix);
    if (!parseVerificationCommand(input.command)) throw new Error('VERIFICATION_COMMAND_DENIED');
    const diff = await this.diff(fix); this.assertReview(diff, input);
    const operationId = randomUUID();
    const { task, execution, receipt } = getDb().transaction(() => {
      const prior = this.receipt(fix);
      if (prior && activeStates.has(prior.state)) throw new Error('GITHUB_DELIVERY_BUSY_OR_UNCERTAIN: do not replay an active/unknown operation');
      const task = createTask({ title: `Verify GitHub fix: ${fix.repository}`, description: input.command, input: input.command,
        mode: 'direct', createdBy: 'user', workspaceId: fix.workspaceId, workdir: fix.localPath, workspacePath: fix.localPath,
        maxRetries: 0, completionCriteria: [{ id: 'repository-check', label: input.command, required: true,
          verifier: 'test_command', command: input.command, timeoutMs: 120_000 }] });
      const execution = createExecution({ taskId: task.id, agentDefId: 'github-verifier', workspaceId: fix.workspaceId });
      updateTask(task.id, { status: 'running' });
      const receipt: Receipt = { diffHash: diff.diffHash, baseHead: diff.baseHead, files: input.files, reviewFiles: diff.files,
        verificationTaskId: task.id, actorId, validation: { status: 'unavailable', command: input.command, diffHash: diff.diffHash,
          executionId: execution.id, checkedAt: new Date().toISOString() } };
      // Publish verifier ownership in the same transaction as its runnable task.
      // A second process cannot observe an unowned task and route it to a model.
      getDb().run(`INSERT INTO github_fix_deliveries(run_id,workspace_id,operation_id,state,data_json,updated_at)
        VALUES (?,?,?,'verifying',?,?) ON CONFLICT(run_id) DO UPDATE SET operation_id=excluded.operation_id,
        state='verifying',data_json=excluded.data_json,updated_at=excluded.updated_at`, fix.id, fix.workspaceId, operationId,
      JSON.stringify(receipt), new Date().toISOString());
      return { task, execution, receipt };
    });
    const controller = new AbortController();
    this.verifiers.set(fix.id, { controller, taskId: task.id });
    try {
      await withWorkspaceLease(task, () => withOwnedRun(task, async () => {
        const before = await this.diff(fix); this.assertReview(before, input); this.requireSettled(fix);
        const report = await verifyCompletionCriteria(task, execution.id, 'Operator-submitted repository verification', controller.signal);
        const after = await this.diff(fix);
        const passed = report.status === 'passed' && before.diffHash === after.diffHash && getTask(task.id)?.status === 'running';
        receipt.validation = { ...receipt.validation, status: passed ? 'passed' : report.status === 'failed' ? 'failed' : 'unavailable',
          checkedAt: new Date().toISOString(), outputArtifactId: report.criteria[0]?.evidence[0]?.ref.replace(/^artifact:\/\//, '') };
        const output = passed ? 'Repository verification passed for the reviewed file revision.'
          : before.diffHash !== after.diffHash ? 'Verification changed reviewed files; review the new diff and rerun validation.'
            : 'Repository verification failed or is unavailable; inspect the retained verifier output.';
        const cancelled = getTask(task.id)?.status === 'cancelled';
        updateTask(task.id, { status: cancelled ? 'cancelled' : passed ? 'done' : 'failed', output, error: passed ? undefined : output });
        updateExecution(execution.id, { status: cancelled ? 'cancelled' : passed ? 'done' : 'failed', completedAt: new Date().toISOString(),
          runState: { ...initialAgentRunState(), phase: cancelled ? 'cancelled' : passed ? 'completed' : 'failed', verification: report, updatedAt: new Date().toISOString() } });
        const unknown = getDb().get("SELECT 1 FROM agent_tool_invocations WHERE task_id=? AND outcome IN ('running','unknown')", task.id);
        this.save(fix, operationId, unknown ? 'uncertain' : passed ? 'passed' : 'failed', receipt);
      }));
    } catch (error: any) {
      const cancelled = getTask(task.id)?.status === 'cancelled';
      updateTask(task.id, { status: cancelled ? 'cancelled' : 'failed', error: error.message });
      updateExecution(execution.id, { status: cancelled ? 'cancelled' : 'failed', completedAt: new Date().toISOString(),
        runState: { ...initialAgentRunState(), phase: cancelled ? 'cancelled' : 'failed', updatedAt: new Date().toISOString() } });
      const unknown = getDb().get("SELECT 1 FROM agent_tool_invocations WHERE task_id=? AND outcome IN ('running','unknown')", task.id);
      this.save(fix, operationId, unknown ? 'uncertain' : 'failed', receipt);
      throw error;
    } finally { this.verifiers.delete(fix.id); }
    return this.diff(fix);
  }
  cancelVerification(fix: GitHubFixRun): { requested: true } {
    const active = this.verifiers.get(fix.id);
    if (!active) throw new Error('GITHUB_VERIFIER_NOT_OWNED: no live verifier owned by this server; inspect its outcome instead');
    active.controller.abort();
    updateTask(active.taskId, { status: 'cancelled', error: 'Operator requested verification cancellation; prior script effects may require reconciliation.' });
    return { requested: true };
  }
  async reconcile(fix: GitHubFixRun, input: { operationId: string; expectedState: string; effectsStopped: true }): Promise<GitHubFixDiff> {
    if (input.effectsStopped !== true) throw new Error('GITHUB_STOPPED_EFFECTS_ATTESTATION_REQUIRED');
    const receipt = this.receipt(fix);
    if (!receipt || receipt.operationId !== input.operationId || receipt.state !== input.expectedState
      || !['uncertain', 'verifying', 'forking', 'committing', 'pushing', 'creating_pr'].includes(receipt.state)) throw new Error('GITHUB_RECONCILIATION_STALE');
    const { data, operationId } = receipt;
    if (!data.verificationTaskId || this.verifiers.has(fix.id) || this.publishers.has(fix.id)
      || activeRunLease(data.verificationTaskId, fix.workspaceId)) throw new Error('GITHUB_OPERATION_STILL_ACTIVE');
    const publication = data.publication;
    let state = 'review_required';
    let reconciledPrUrl: string | undefined;
    const stage = publication?.uncertainStage || receipt.state;
    if (publication && stage === 'forking' && publication.forkRepository) {
      await this.inspectFork(publication.forkRepository, fix.repository, fix.localPath);
      state = 'passed';
    } else if (publication && stage === 'committing') {
      const head = await this.run('git', ['rev-parse', 'HEAD'], fix.localPath);
      if (head !== data.baseHead) {
        if (await this.run('git', ['rev-parse', 'HEAD^'], fix.localPath) !== data.baseHead
          || await this.run('git', ['rev-parse', 'HEAD^{tree}'], fix.localPath) !== publication.expectedTree) throw new Error('GITHUB_COMMIT_OUTCOME_UNRESOLVED');
        publication.commitHash = head; state = 'committed';
      }
    } else if (publication && stage === 'pushing') {
      const refs = await this.run('git', ['ls-remote', publication.remote, `refs/heads/${fix.workBranch}`], fix.localPath, 30_000);
      const remoteHash = refs.split(/\s+/)[0];
      if (remoteHash && remoteHash !== publication.commitHash) throw new Error('GITHUB_REMOTE_BRANCH_CHANGED');
      state = remoteHash ? 'pushed' : 'committed';
    } else if (publication && stage === 'creating_pr') {
      const values = JSON.parse(await this.run('gh', ['pr', 'list', '--repo', fix.repository, '--head', fix.workBranch,
        '--base', fix.baseBranch, '--state', 'all', '--limit', '100', '--json', 'url,headRefOid,headRepositoryOwner'], fix.localPath, 30_000));
      if (!Array.isArray(values) || values.length >= 100) throw new Error('GITHUB_PR_OUTCOME_UNRESOLVED');
      const expectedOwner = (publication.forkRepository || fix.repository).split('/')[0].toLowerCase();
      const matches = values.filter(value => value.headRefOid === publication.commitHash && isPrUrl(value.url, fix.repository)
        && value.headRepositoryOwner?.login?.toLowerCase() === expectedOwner);
      if (matches.length > 1) throw new Error('GITHUB_PR_OUTCOME_AMBIGUOUS');
      if (matches.length) { reconciledPrUrl = matches[0].url; state = 'pr_created'; }
      else state = 'pushed';
    } else {
      if (getTask(data.verificationTaskId)?.status === 'running') {
        updateTask(data.verificationTaskId, { status: 'failed', error: 'Operator reconciled an interrupted verification; no command was replayed.' });
        updateExecution(data.validation.executionId, { status: 'failed', completedAt: new Date().toISOString() });
      }
      data.validation.status = 'unavailable';
    }
    const current = this.receipt(fix);
    if (current?.operationId !== operationId || current.state !== receipt.state) throw new Error('GITHUB_RECONCILIATION_STALE');
    if (state === 'review_required') data.validation.status = 'unavailable';
    // Release only this operator operation's claims after explicit stopped-effect
    // attestation. Unknown tool journal entries remain unknown; never mark them passed.
    getDb().transaction(() => {
      reconcileToolResourceLocks(fix.workspaceId, data.validation.executionId);
      getDb().run(`UPDATE workspace_leases SET state='released'
        WHERE task_id IN (?,?) AND canonical_path=? AND state='uncertain'`,
      data.verificationTaskId, `github-publication-${fix.id}`, canonicalRoot(fix.localPath));
      this.save(fix, operationId, state, data);
      // Fence delayed results from the prior process; reconciliation never lets
      // an old owner continue issuing remote writes with its previous token.
      getDb().run('UPDATE github_fix_deliveries SET operation_id=? WHERE run_id=? AND operation_id=?',
        randomUUID(), fix.id, operationId);
      if (reconciledPrUrl) updateGitHubFixRun(fix.id, { status: 'pr_created', prUrl: reconciledPrUrl });
    });
    return this.diff(fix);
  }
  async publish(fix: GitHubFixRun, input: GitHubPublicationInput, actorId: string, login: string): Promise<GitHubFixRun> {
    if (input.acceptDelivery !== true) throw new Error('GITHUB_HUMAN_ACCEPTANCE_REQUIRED');
    this.requireSettled(fix);
    const receipt = this.receipt(fix);
    if (fix.status === 'pr_created' && receipt?.data.diffHash === input.diffHash) return fix;
    const needsFork = !['ADMIN', 'MAINTAIN', 'WRITE'].includes(fix.viewerPermission.toUpperCase());
    if (needsFork && input.allowFork !== true) throw new Error('GITHUB_WRITE_PERMISSION_REQUIRED: explicitly approve creating/reusing your fork before publication');
    if (!receipt || !['passed', 'committed', 'pushed'].includes(receipt.state)) throw new Error('GITHUB_VERIFICATION_REQUIRED: pass validation or reconcile the prior operation first');
    const { operationId, data } = receipt;
    if (data.diffHash !== input.diffHash || JSON.stringify([...input.files].sort()) !== JSON.stringify([...data.files].sort())) throw new Error('GITHUB_REVIEW_STALE');
    const task = getTask(data.verificationTaskId), execution = getExecution(data.validation.executionId);
    if (!task || !execution?.runState?.verification || data.validation.status !== 'passed'
      || task.status !== 'done' || !completionEvidenceIsFresh(task, execution.id, execution.runState.verification)) throw new Error('GITHUB_VERIFICATION_EVIDENCE_STALE');
    const title = input.title?.trim() || data.publication?.title || `fix: ${fix.issueTitle || 'resolve reported bug'}`;
    const body = input.body?.trim() || data.publication?.body
      || `## Summary\n\n- Operator-reviewed changes for ${fix.repository}.\n\n## Validation\n\n- Command: \`${data.validation.command}\`\n- Retained verifier execution: ${data.validation.executionId}\n- Reviewed revision: ${data.diffHash}\n- Human delivery acceptance: ${actorId}\n\nRegression coverage is not inferred from task completion.${fix.issueNumber ? `\n\nFixes #${fix.issueNumber}` : ''}`;
    const commitMessage = input.commitMessage?.trim() || data.publication?.commitMessage || title;
    if (data.publication && (data.publication.title !== title || data.publication.body !== body || data.publication.commitMessage !== commitMessage)) {
      throw new Error('GITHUB_PUBLICATION_INPUT_CHANGED: resume the same reviewed publication payload');
    }
    data.publication ||= { title, body, commitMessage, acceptedBy: actorId, login,
      head: needsFork ? `${login}:${fix.workBranch}` : fix.workBranch, remote: needsFork ? 'fork' : 'origin',
      ...(needsFork ? { forkRepository: `${login}/${fix.repository.split('/')[1]}` } : {}) };
    const publication = data.publication;
    if (publication.login !== login) throw new Error('GITHUB_PUBLICATION_ACCOUNT_CHANGED: resume with the originally approved account');
    const leaseTask = { ...task, id: `github-publication-${fix.id}`, workdir: fix.localPath, workspacePath: fix.localPath };
    if (this.publishers.has(fix.id)) throw new Error('GITHUB_DELIVERY_BUSY');
    this.publishers.add(fix.id);
    try { return await withWorkspaceLease(leaseTask, async () => {
      if (this.receipt(fix)?.state !== receipt.state) throw new Error('GITHUB_DELIVERY_BUSY');
      if (receipt.state === 'passed') {
        const diff = await this.diff(fix); this.assertReview(diff, input);
        if (!publication.forkRepository) {
          const remoteUrl = await this.run('git', ['remote', 'get-url', '--push', publication.remote], fix.localPath);
          if (!isRepositoryRemote(remoteUrl, fix.repository)) throw new Error('GITHUB_REMOTE_TARGET_CHANGED: checkout push target no longer matches the reviewed repository');
        }
        const staged = await this.run('git', ['diff', '--cached', '--name-only', '-z'], fix.localPath);
        if (staged.split('\0').filter(Boolean).some(path => !data.files.includes(path))) throw new Error('GITHUB_UNREVIEWED_STAGED_FILES');
      } else {
        const head = await this.run('git', ['rev-parse', 'HEAD'], fix.localPath);
        const status = (await this.run('git', ['status', '--porcelain', '--untracked-files=all'], fix.localPath)).split('\n')
          .filter(line => !line.slice(3).replace(/^"/, '').startsWith('.agent-factory/')).join('\n');
        if (head !== publication.commitHash || status) throw new Error('GITHUB_PUBLICATION_CHECKOUT_CHANGED');
      }
      let state = receipt.state;
      const advance = (next: string) => { assertWorkspaceToolAllowed('shell_exec'); this.save(fix, operationId, next, data); state = next; };
      try {
        if (state === 'passed' && publication.forkRepository && !publication.forkReady) {
          advance('forking');
          try { await this.inspectFork(publication.forkRepository, fix.repository, fix.localPath); }
          catch (error: any) {
            if (!/Could not resolve|HTTP 404|Not Found/i.test(error.message)) throw error;
            await this.run('gh', ['repo', 'fork', fix.repository, '--clone=false'], fix.localPath, 120_000);
            await this.inspectFork(publication.forkRepository, fix.repository, fix.localPath);
          }
          const remotes = (await this.run('git', ['remote'], fix.localPath)).split('\n');
          if (!remotes.includes('fork')) {
            await this.run('git', ['remote', 'add', 'fork', `https://github.com/${publication.forkRepository}.git`], fix.localPath);
          }
          const forkUrl = await this.run('git', ['remote', 'get-url', '--push', 'fork'], fix.localPath);
          if (!isRepositoryRemote(forkUrl, publication.forkRepository)) throw new Error('GITHUB_FORK_REMOTE_MISMATCH: existing checkout remote was not overwritten');
          publication.forkReady = true;
          getDb().transaction(() => { advance('passed'); updateGitHubFixRun(fix.id, { forkRepository: publication.forkRepository }); });
        }
        if (state === 'passed') {
          advance('committing');
          await this.run('git', ['--literal-pathspecs', 'add', '--', ...data.files], fix.localPath, 30_000);
          this.assertReview(await this.diff(fix), input);
          for (const file of data.reviewFiles.filter(file => file.change !== 'deleted')) {
            const rawHash = await this.run('git', ['hash-object', '--no-filters', '--', file.path], fix.localPath);
            const stagedHash = await this.run('git', ['rev-parse', `:${file.path}`], fix.localPath);
            if (rawHash !== stagedHash) throw new Error('GITHUB_STAGED_BYTES_DIFFER: repository filters changed reviewed bytes; inspect the staged revision');
          }
          publication.expectedTree = await this.run('git', ['write-tree'], fix.localPath);
          this.save(fix, operationId, state, data);
          await this.run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
            '-c', `user.name=${login}`, '-c', `user.email=${login}@users.noreply.github.com`, 'commit', '-m', commitMessage], fix.localPath, 60_000);
          publication.commitHash = await this.run('git', ['rev-parse', 'HEAD'], fix.localPath);
          if (await this.run('git', ['rev-parse', 'HEAD^{tree}'], fix.localPath) !== publication.expectedTree) throw new Error('GITHUB_COMMITTED_TREE_CHANGED');
          advance('committed');
        }
        if (state === 'committed') {
          this.requireSettled(fix);
          const remoteUrl = await this.run('git', ['remote', 'get-url', '--push', publication.remote], fix.localPath);
          if (!isRepositoryRemote(remoteUrl, publication.forkRepository || fix.repository)) throw new Error('GITHUB_REMOTE_TARGET_CHANGED');
          advance('pushing');
          await this.run('git', ['-c', 'core.hooksPath=/dev/null', 'push', '-u', publication.remote, fix.workBranch], fix.localPath, 120_000);
          advance('pushed');
        }
        this.requireSettled(fix);
        advance('creating_pr');
        const output = await this.run('gh', ['pr', 'create', '--repo', fix.repository, '--base', fix.baseBranch,
          '--head', publication.head, '--title', title, '--body', body], fix.localPath, 120_000);
        const prUrl = output.split('\n').find(line => isPrUrl(line.trim(), fix.repository))?.trim();
        if (!prUrl) throw new Error('GITHUB_PR_OUTCOME_UNKNOWN');
        return getDb().transaction(() => {
          advance('pr_created');
          return updateGitHubFixRun(fix.id, { status: 'pr_created', prUrl, error: null })!;
        });
      } catch (error) {
        publication.uncertainStage = state;
        const uncertainLocalWrite = state === 'committing';
        advance(['forking', 'committing', 'pushing', 'creating_pr'].includes(state) ? 'uncertain' : state);
        // Persist the receipt while the lease is still active; sealing it first
        // would fence our own save and obscure the interrupted commit outcome.
        if (uncertainLocalWrite) markCurrentWorkspaceLeaseUncertain();
        throw error;
      }
    }); } finally { this.publishers.delete(fix.id); }
  }
}
