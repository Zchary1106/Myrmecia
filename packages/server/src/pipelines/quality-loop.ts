import { eventBus } from '../events/event-bus.js';
import { createTask, getTask, updateTask, addTaskLog } from '../db/models/task.js';
import { getAgent, listAgents } from '../db/models/agent.js';
import { getActiveExecutionCount, listExecutions, listExecutionMessages } from '../db/models/execution.js';
import { createQualityLoopAttempt, listQualityLoopAttempts, updateQualityLoopAttempt } from '../db/models/quality-loop.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import { spawnSync } from 'child_process';
import { createTestReportFromOutput, hasVerifiedTestEvidence, type TestReportWithEvidence } from '../testing/test-report.js';
import type { AgentDefinition, QualityLoopAttempt, Task } from '../types.js';
import { loadExecutionContext, persistInheritedExecutionContext } from '../agents/execution-context.js';
import { isSimpleConversation } from '../agents/conversation-intent.js';
import { resolveAllowedToolsForAgent } from '../tools/tool-policy.js';
import { ownGitRoot } from '../workspace/path-policy.js';
import { readWorkspaceBytes, excludedWorkspacePath } from '../workspace/path-policy.js';
import { taskTestAuthorization, runAuthorizedTaskTest } from '../testing/task-test-authorization.js';
import { upsertExecutionArtifact } from '../db/models/execution-artifact.js';
import { saveArtifactSnapshot } from '../artifacts/artifact-snapshot-store.js';
import { bindQualityInput } from '../testing/quality-input-artifacts.js';
import { dlpCheck } from '../security/dlp.js';

const MAX_PROMPT_EVIDENCE_CHARS = 12_000;
// Bounded complete implementation evidence. Do not silently turn omitted code
// into a developer repair request or let a reviewer approve a partial snapshot.
const MAX_IMPLEMENTATION_EVIDENCE_CHARS = 64_000;
const MAX_REVIEW_OUTPUT_CHARS = 10_000;

export interface ReviewFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  file?: string;
  line?: number;
  evidence: string;
  requiredFix: string;
}

export interface ReviewDecision {
  approved: boolean;
  findings: ReviewFinding[];
  summary?: string;
}

export interface ReviewParseResult {
  decision?: ReviewDecision;
  error?: string;
}

function clip(value: string | undefined, limit: number): string {
  const text = value || '';
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

export function inheritExecutionContext(task: Task) {
  return {
    workdir: task.workdir,
    workspacePath: task.workspacePath,
    workspaceId: task.workspaceId,
    modelId: task.modelId,
    reasoningEffort: task.reasoningEffort,
    contextLength: task.contextLength,
    domainId: task.domainId,
  };
}

/** Test, review, and repair work are implementation details of an existing gate. */
export function isQualityChildTask(task: Pick<Task, 'title' | 'parentTaskId'>): boolean {
  return Boolean(task.parentTaskId && /^(Test|Review|Fix):\s/.test(task.title));
}

export function collectQualityWorkspaceEvidence(task: Task): { diff: string; changedFiles: string[] } {
  const cwd = task.workdir || task.workspacePath;
  if (!cwd) return { diff: '(workspace path unavailable)', changedFiles: [] };
  try { if (!ownGitRoot(cwd)) return { diff: '(non-Git execution workspace)', changedFiles: [] }; }
  catch { return { diff: '(Git root requires reconciliation)', changedFiles: [] }; }
  const runGit = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
  const changed = runGit(['diff', '--name-only', 'HEAD']);
  const diff = runGit(['diff', '--no-ext-diff', '--unified=12', 'HEAD']);
  if (changed.error || diff.error || changed.status !== 0 || diff.status !== 0) {
    return { diff: '(git diff unavailable for this workspace)', changedFiles: [] };
  }
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.error || untracked.status !== 0) return { diff: '(untracked diff unavailable)', changedFiles: [] };
  const files = untracked.stdout.split('\0').filter(Boolean)
    .filter(file => file !== 'output/summary.md' && !/^output\/executions\/exec_[a-z0-9]+\.md$/.test(file));
  const changedFiles = [...changed.stdout.split('\n').filter(Boolean), ...files];
  if (changedFiles.some(excludedWorkspacePath)) throw new Error('QUALITY_IMPLEMENTATION_UNSAFE_PATH');
  if (changedFiles.length > 100) throw new Error('QUALITY_IMPLEMENTATION_FILE_QUOTA');
  let combined = diff.stdout;
  if (combined.length > MAX_IMPLEMENTATION_EVIDENCE_CHARS) throw new Error('QUALITY_IMPLEMENTATION_EVIDENCE_QUOTA');
  for (const file of files) {
    let bytes: Buffer;
    try { bytes = readWorkspaceBytes(cwd, file, 256_000); }
    catch { throw new Error('QUALITY_IMPLEMENTATION_FILE_UNAVAILABLE'); }
    combined += `\nNew file: ${file}\n${bytes.toString('utf8')}\n`;
    if (combined.length > MAX_IMPLEMENTATION_EVIDENCE_CHARS) throw new Error('QUALITY_IMPLEMENTATION_EVIDENCE_QUOTA');
  }
  return { diff: combined, changedFiles };
}

function attachReviewInputs(parent: Task, child: Task, evidence: ReturnType<typeof collectQualityWorkspaceEvidence>, report: TestReportWithEvidence): void {
  const execution = listExecutions({ taskId: parent.id, status: 'done', limit: 1 })[0];
  if (!execution || !evidence.diff.trim() || evidence.diff.startsWith('(')) throw new Error('QUALITY_IMPLEMENTATION_UNAVAILABLE');
  for (const [name, kind, raw] of [
    ['implementation', 'code', evidence.diff],
    ['test-report', 'json', JSON.stringify(report)],
  ] as const) {
    const checked = dlpCheck(raw, { taskId: parent.id, workspaceId: parent.workspaceId });
    if (checked.violations.some(item => item.action === 'block')) throw new Error('QUALITY_INPUT_DLP_BLOCKED');
    const content = checked.redactedContent || raw;
    const artifact = upsertExecutionArtifact({
      taskId: parent.id, executionId: execution.id, workspaceId: parent.workspaceId,
      name, kind, mimeType: 'text/plain', source: 'workspace',
      relativePath: `.quality/${child.id}/${name}.txt`, content, sizeBytes: Buffer.byteLength(content),
      metadata: { source: 'host-quality-handoff', childTaskId: child.id, bounded: true },
    });
    saveArtifactSnapshot(artifact, Buffer.from(content));
    bindQualityInput(child, name, artifact);
  }
}

/** Parse only an explicit JSON decision; strings such as "NOT APPROVED" never pass. */
export function parseReviewDecision(output: string): ReviewParseResult {
  const candidates = [
    output.trim(),
    ...Array.from(output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), match => match[1].trim()),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed.approved !== 'boolean') continue;
      if (!Array.isArray(parsed.findings)) return { error: 'review JSON must contain a findings array' };
      const findings: ReviewFinding[] = [];
      for (const finding of parsed.findings) {
        if (!finding || typeof finding !== 'object') return { error: 'review findings must be objects' };
        const item = finding as Record<string, unknown>;
        if (!['low', 'medium', 'high', 'critical'].includes(String(item.severity)) ||
            typeof item.evidence !== 'string' || typeof item.requiredFix !== 'string') {
          return { error: 'each review finding requires severity, evidence, and requiredFix' };
        }
        findings.push({
          severity: item.severity as ReviewFinding['severity'],
          ...(typeof item.file === 'string' ? { file: item.file } : {}),
          ...(typeof item.line === 'number' && Number.isInteger(item.line) ? { line: item.line } : {}),
          evidence: item.evidence,
          requiredFix: item.requiredFix,
        });
      }
      if (parsed.approved && findings.length > 0) return { error: 'approved review must not contain findings' };
      return { decision: { approved: parsed.approved, findings, ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}) } };
    } catch {
      // Continue to another fenced candidate.
    }
  }
  return { error: 'reviewer did not return a valid JSON decision with an approved boolean' };
}

export function createReviewPrompt(task: Task, testReport: TestReportWithEvidence, evidence: { diff: string; changedFiles: string[] }): string {
  if (evidence.diff.length > MAX_IMPLEMENTATION_EVIDENCE_CHARS) throw new Error('QUALITY_IMPLEMENTATION_EVIDENCE_QUOTA');
  const changedFiles = Array.from(new Set([...evidence.changedFiles, ...testReport.changedFiles])).slice(0, 100);
  return `Review this implementation using the supplied code and test evidence. Do not infer a pass from the developer's prose.

Use only the supplied code/test snapshot; do not use network tools, install packages or publish changes.
Return ONLY one valid JSON object inside a \`\`\`json fenced block, in this exact shape:
{"approved":boolean,"summary":"string","findings":[{"severity":"low|medium|high|critical","file":"optional","line":1,"evidence":"string","requiredFix":"string"}]}
If approved is true, findings MUST be an empty array. If the evidence is insufficient, set approved false and include one finding explaining what is missing.

Workspace: ${task.workdir || task.workspacePath || '(unavailable)'}
Changed files:\n${changedFiles.join('\n') || '(none available)'}

Verified test evidence:\n${clip(JSON.stringify(testReport, null, 2), MAX_PROMPT_EVIDENCE_CHARS)}

Git diff and complete bounded new-file snapshot:\n${evidence.diff}

Developer output (supplementary only):\n${clip(task.output, 8_000) || '(empty output)'}`;
}

/**
 * Quality Loop
 * Automatically runs review → fix cycles between Dev and Review agents.
 * Max 3 iterations to prevent infinite loops.
 */
export class QualityLoop {
  private maxIterations = 3;

  constructor() {
    // Watch for completed dev tasks to trigger review
    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as any;
      this.maybeReview(taskId);
    });
  }

  private async maybeReview(taskId: string) {
    const task = getTask(taskId);
    if (!task) return;
    if (isQualityChildTask(task)) return;

    // Dev work is quality-gated consistently in Pipeline, Master, and Direct modes.
    const agent = task.assigneeId ? getAgent(task.assigneeId) : null;
    if (!agent || !['developer', 'dev'].includes(agent.role)) return;

    const attempts = listQualityLoopAttempts({ taskId });
    const latestAttempt = attempts[attempts.length - 1];
    // Approval emits the authoritative terminal task:done event. Check it
    // first so this listener cannot regress an approved task back to review.
    if (latestAttempt?.status === 'approved') return;
    // Never exempt implementation work based on a greeting substring, a dirty
    // shared workspace, or the developer's own unsupported "done" claim.
    if (attempts.every(attempt => attempt.status === 'failed') && isSimpleConversation(task)
      && !/```|diff --git/.test(task.output || '')
      && !listExecutions({ taskId }).some(run =>
        run.progress.toolUseCount > 0 || listExecutionMessages(run.id).some(message => message.type === 'tool_use'))) {
      addTaskLog(taskId, 'info', 'Quality Loop: standalone conversation without tool activity; code validation is not applicable', 'quality-loop');
      return;
    }

    // `task:done` is emitted by the execution runtime immediately after the
    // developer process returns. Move the task to a non-terminal gate state
    // before any awaited QA work starts, so parent monitors cannot settle it
    // while tests/review are still pending.
    if (task.status === 'done') {
      updateTask(taskId, { status: 'review', completedAt: null });
    }
    if (attempts.length >= this.maxIterations) {
      const exhausted = createQualityLoopAttempt({
        taskId,
        iteration: attempts.length + 1,
        status: 'failed',
        developerAgentId: agent.id,
      });
      this.failAttempt(exhausted, taskId, `blocked: max review rounds reached (${this.maxIterations})`);
      return;
    }

    const iteration = attempts.length + 1;
    addTaskLog(taskId, 'info', `Quality Loop: auto-review round ${iteration}/${this.maxIterations}`, 'quality-loop');

    let attempt: QualityLoopAttempt | undefined;

    try {
      attempt = createQualityLoopAttempt({
        taskId,
        iteration,
        status: 'reviewing',
        developerAgentId: agent.id,
      });
      eventBus.emit('quality:updated', { taskId, attempt });

      const testAgent = listAgents().find(candidate =>
        /(^|[-_ ])(qa|test|tester)([-_ ]|$)/i.test(candidate.role) && this.hasCapacity(candidate)
      );
      if (!testAgent) {
        this.failAttempt(attempt, taskId, 'blocked: no available Test/QA agent; the implementation could not be verified');
        return;
      }
      const commandPolicy = resolveAllowedToolsForAgent(testAgent).decisions.find(decision =>
        decision.toolId === 'shell_exec' && !decision.allowed && decision.reason === 'approval_required');
      const scopedAuthorization = commandPolicy ? taskTestAuthorization(task) : undefined;
      if (commandPolicy && !scopedAuthorization) {
        this.failAttempt(attempt, taskId, 'blocked: Test/QA command execution requires approval; validation was not run. Configure scoped command authorization before retrying.');
        return;
      }

      const testPrompt = `Run the focused validation needed for this task in its existing workspace. Return ONLY JSON with command, cwd, exitCode, stdout, stderr, and failedTests. Do not claim success without executing a command.\n\nTask: ${task.title}\n${task.description}`;
      const testTask = createTask({
        title: `Test: ${task.title}`,
        description: testPrompt,
        input: testPrompt,
        mode: 'direct',
        priority: task.priority,
        maxRetries: 0,
        assigneeId: testAgent.id,
        parentTaskId: task.id,
        createdBy: 'master',
        ...inheritExecutionContext(task),
      });
      persistInheritedExecutionContext(loadExecutionContext(task), testTask);
      let testResult: { output: string };
      if (scopedAuthorization) {
        // Explicit operator grant executes one fixed command, not a newly
        // permitted model shell tool. The verifier records its own receipt.
        updateTask(testTask.id, { status: 'running', startedAt: new Date().toISOString() });
        try {
          const evidence = await runAuthorizedTaskTest(testTask);
          testResult = { output: JSON.stringify({ ...evidence, source: 'authorized-host-verifier' }) };
          const verified = hasVerifiedTestEvidence(createTestReportFromOutput(testResult.output));
          const tested = updateTask(testTask.id, { status: verified ? 'done' : 'failed',
            output: testResult.output, error: verified ? null : evidence.exitCode !== 0
              ? `npm test exited ${evidence.exitCode}` : 'npm test executed no verifiable test cases',
            completedAt: new Date().toISOString() });
          eventBus.emit('task:updated', { taskId: testTask.id, task: tested, workspaceId: task.workspaceId });
        } catch (error) {
          updateTask(testTask.id, { status: 'failed', error: error instanceof Error ? error.message : String(error),
            completedAt: new Date().toISOString() });
          throw error;
        }
      } else testResult = await agentRuntime.execute(testAgent, testTask);
      const testReport = createTestReportFromOutput(testResult.output, `Validation for ${task.title}`);
      if (!testReport.evidence) {
        this.failAttempt(attempt, taskId, 'blocked: Test/QA agent did not return structured command, cwd, and exitCode evidence');
        return;
      }
      if (testReport.status !== 'passed') {
        this.failAttempt(attempt, taskId, `blocked: Test/QA validation failed${testReport.failures[0] ? `: ${testReport.failures[0]}` : ''}`);
        return;
      }
      if (!hasVerifiedTestEvidence(testReport)) {
        this.failAttempt(attempt, taskId, 'blocked: Test/QA evidence could not be verified');
        return;
      }

      const reviewAgent = listAgents().find(candidate =>
        (candidate.role === 'reviewer' || candidate.id === 'review') && this.hasCapacity(candidate)
      );
      if (!reviewAgent) {
        this.failAttempt(attempt, taskId, 'blocked: no available Reviewer agent; the implementation was not approved');
        return;
      }

      const evidence = collectQualityWorkspaceEvidence(task);
      if (reviewAgent.config.contract && (!evidence.diff.trim() || evidence.diff.startsWith('(')
        || !listExecutions({ taskId: task.id, status: 'done', limit: 1 })[0])) {
        throw new Error('QUALITY_IMPLEMENTATION_UNAVAILABLE');
      }
      const reviewPrompt = createReviewPrompt(task, testReport, evidence);

      const reviewTask = createTask({
        title: `Review: ${task.title}`,
        description: reviewPrompt,
        input: reviewPrompt,
        mode: 'direct',
        priority: task.priority,
        maxRetries: 0,
        assigneeId: reviewAgent.id,
        parentTaskId: task.id,
        createdBy: 'master',
        ...inheritExecutionContext(task),
      });
      attempt = updateQualityLoopAttempt(attempt.id, { reviewTaskId: reviewTask.id }) || attempt;
      persistInheritedExecutionContext(loadExecutionContext(task), reviewTask);
      if (reviewAgent.config.contract) attachReviewInputs(task, reviewTask, evidence, testReport);
      eventBus.emit('quality:updated', { taskId, attempt });

      const reviewResult = await agentRuntime.execute(reviewAgent, reviewTask);

      const parsedReview = parseReviewDecision(reviewResult.output);
      if (!parsedReview.decision) {
        this.failAttempt(attempt, taskId, `blocked: reviewer response could not be verified: ${parsedReview.error}`, reviewResult.output);
        return;
      }
      const isApproved = parsedReview.decision.approved;

      if (isApproved) {
        attempt = updateQualityLoopAttempt(attempt.id, {
          status: 'approved',
          reviewOutput: clip(reviewResult.output, MAX_REVIEW_OUTPUT_CHARS),
          completedAt: new Date().toISOString(),
        }) || attempt;
        addTaskLog(taskId, 'info', 'Quality Loop: APPROVED by Review Agent', 'quality-loop');
        eventBus.emit('task:log', { taskId, message: '✅ Review passed' });
        eventBus.emit('quality:updated', { taskId, attempt });
        const completed = updateTask(taskId, {
          status: 'done',
          completedAt: new Date().toISOString(),
        });
        eventBus.emit('task:done', {
          taskId,
          task: completed,
          agentId: agent.id,
          workspaceId: task.workspaceId,
          output: getTask(taskId)?.output,
          qualityApproved: true,
        });
        return;
      }

      // A staged run already owns its bounded repair allowance. Independent
      // review remains authoritative, but cannot silently start a second
      // child-task repair budget outside that same execution.
      if (listExecutions({ taskId }).some(run => run.runState?.developmentStage)) {
        this.failAttempt(attempt, taskId,
          'blocked: independent review rejected a staged development run; explicit new scope/authority required for further repair',
          reviewResult.output);
        return;
      }

      // Needs fix — send back to dev agent
      attempt = updateQualityLoopAttempt(attempt.id, {
        status: 'needs_fix',
        reviewOutput: clip(reviewResult.output, MAX_REVIEW_OUTPUT_CHARS),
      }) || attempt;
      addTaskLog(taskId, 'warn', 'Quality Loop: Review found issues, sending back for fix', 'quality-loop');
      eventBus.emit('quality:updated', { taskId, attempt });

      const fixPrompt = `The Review Agent found the following issues with your code. Please fix them:

${JSON.stringify(parsedReview.decision, null, 2)}

Original output:
${task.output?.slice(0, 8000) || ''}`;

      if (!this.hasCapacity(agent)) {
        this.failAttempt(attempt, taskId, 'blocked: Developer agent is busy; review findings could not be fixed');
        return;
      }

      const fixTask = createTask({
        title: `Fix: ${task.title}`,
        description: fixPrompt,
        input: fixPrompt,
        mode: 'direct',
        priority: task.priority,
        maxRetries: 0,
        assigneeId: agent.id,
        parentTaskId: task.id,
        createdBy: 'master',
        ...inheritExecutionContext(task),
      });
      persistInheritedExecutionContext(loadExecutionContext(task), fixTask);
      attempt = updateQualityLoopAttempt(attempt.id, {
        status: 'fixing',
        fixTaskId: fixTask.id,
      }) || attempt;
      eventBus.emit('quality:updated', { taskId, attempt });

      const fixResult = await agentRuntime.execute(agent, fixTask);

      // Update original task with fixed output
      updateTask(taskId, { output: fixResult.output });
      attempt = updateQualityLoopAttempt(attempt.id, {
        status: 'fixed',
        fixOutput: fixResult.output,
        completedAt: new Date().toISOString(),
      }) || attempt;
      addTaskLog(taskId, 'info', `Quality Loop: Fix applied (round ${iteration})`, 'quality-loop');
      eventBus.emit('quality:updated', { taskId, attempt });

      // Re-trigger review for next iteration
      this.maybeReview(taskId);
    } catch (err: any) {
      if (attempt) {
        this.failAttempt(attempt, taskId, `blocked: quality-loop execution could not complete: ${err.message}`);
      }
      addTaskLog(taskId, 'error', `Quality Loop error: ${err.message}`, 'quality-loop');
    }
  }

  private failAttempt(attempt: QualityLoopAttempt, taskId: string, error: string, reviewOutput?: string) {
    // Only our not-yet-dispatched child can be settled here. Never bypass an
    // active writer or rewrite completed review history.
    if (attempt.reviewTaskId) {
      const child = getTask(attempt.reviewTaskId);
      if (child?.status === 'pending' && child.parentTaskId === taskId && child.createdBy === 'master') {
        const settled = updateTask(child.id, { status: 'failed', error,
          completedAt: new Date().toISOString() });
        eventBus.emit('task:updated', { taskId: child.id, task: settled, workspaceId: child.workspaceId });
      }
    }
    const failed = updateQualityLoopAttempt(attempt.id, {
      status: 'failed',
      error,
      ...(reviewOutput !== undefined ? { reviewOutput: clip(reviewOutput, MAX_REVIEW_OUTPUT_CHARS) } : {}),
      completedAt: new Date().toISOString(),
    }) || attempt;
    addTaskLog(taskId, 'error', `Quality Loop: ${error}`, 'quality-loop');
    eventBus.emit('quality:updated', { taskId, attempt: failed });
    const task = getTask(taskId);
    if (task && task.status !== 'failed' && task.status !== 'cancelled') {
      const failedTask = updateTask(taskId, {
        status: 'failed',
        error,
        completedAt: new Date().toISOString(),
      });
      eventBus.emit('task:failed', {
        taskId,
        task: failedTask,
        agentId: task.assigneeId,
        workspaceId: task.workspaceId,
        error,
      });
    }
  }

  private hasCapacity(agent: AgentDefinition): boolean {
    return getActiveExecutionCount(agent.id) < (agent.config.maxConcurrent || 1);
  }

  async recoverInterruptedAttempts() {
    const attempts = listQualityLoopAttempts();
    const latestByTask = new Map<string, QualityLoopAttempt>();
    for (const attempt of attempts) {
      const current = latestByTask.get(attempt.taskId);
      if (!current || attempt.iteration > current.iteration) latestByTask.set(attempt.taskId, attempt);
    }

    for (const attempt of latestByTask.values()) {
      if (attempt.status === 'fixed') {
        await this.maybeReview(attempt.taskId);
        continue;
      }

      if (!['reviewing', 'fixing', 'needs_fix'].includes(attempt.status)) continue;

      const status = 'failed';
      const error = attempt.status === 'needs_fix'
        ? 'blocked: quality loop was interrupted before a fix task could run'
        : 'blocked: quality loop attempt was interrupted by server restart';
      const recovered = updateQualityLoopAttempt(attempt.id, {
        status,
        error,
        completedAt: new Date().toISOString(),
      });
      addTaskLog(attempt.taskId, status === 'failed' ? 'error' : 'warn', `Quality Loop recovery: ${error}`, 'quality-loop');
      eventBus.emit('quality:updated', { taskId: attempt.taskId, attempt: recovered });
    }
  }
}
