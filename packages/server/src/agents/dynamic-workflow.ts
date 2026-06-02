import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import { eventBus } from '../events/event-bus.js';
import { getTask, updateTask } from '../db/models/task.js';
import { getAgent } from '../db/models/agent.js';
import type { AgentManager } from './agent-manager.js';
import type { TaskQueue } from '../queue/task-queue.js';
import type { DynamicWorkflowPlan, DynamicWorkflowRun, DynamicWorkflowStatus, DynamicWorkflowStep, Priority, Task } from '../types.js';

const MAX_DYNAMIC_STEPS = 64;
const DEFAULT_MAX_PARALLEL = 12;

function parseJson<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}

function rowToWorkflow(row: any): DynamicWorkflowRun {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    plan: parseJson(row.plan, { goal: row.goal, strategy: '', steps: [] } as DynamicWorkflowPlan),
    taskIds: parseJson(row.task_ids, [] as string[]),
    workspaceId: row.workspace_id || 'default',
    result: row.result || undefined,
    validationSummary: row.validation_summary || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
  };
}

export function getDynamicWorkflow(id: string): DynamicWorkflowRun | undefined {
  const row = getDb().get('SELECT * FROM dynamic_workflows WHERE id = ?', id) as any;
  return row ? rowToWorkflow(row) : undefined;
}

export function listDynamicWorkflows(filter?: { workspaceId?: string; limit?: number; offset?: number }): DynamicWorkflowRun[] {
  let sql = 'SELECT * FROM dynamic_workflows';
  const params: any[] = [];
  if (filter?.workspaceId) {
    sql += ' WHERE workspace_id = ?';
    params.push(filter.workspaceId);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(filter?.limit || 50, filter?.offset || 0);
  return (getDb().all(sql, ...params) as any[]).map(rowToWorkflow);
}

function updateDynamicWorkflow(id: string, updates: Partial<{
  status: DynamicWorkflowStatus;
  plan: DynamicWorkflowPlan;
  taskIds: string[];
  result: string | null;
  validationSummary: string | null;
  completedAt: string | null;
}>): DynamicWorkflowRun | undefined {
  const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
  const params: any[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.plan !== undefined) { sets.push('plan = ?'); params.push(JSON.stringify(updates.plan)); }
  if (updates.taskIds !== undefined) { sets.push('task_ids = ?'); params.push(JSON.stringify(updates.taskIds)); }
  if (updates.result !== undefined) { sets.push('result = ?'); params.push(updates.result); }
  if (updates.validationSummary !== undefined) { sets.push('validation_summary = ?'); params.push(updates.validationSummary); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }
  params.push(id);
  getDb().run(`UPDATE dynamic_workflows SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getDynamicWorkflow(id);
}

function normalizeStepId(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return normalized || fallback;
}

export function validateWorkflowPlan(plan: DynamicWorkflowPlan): DynamicWorkflowPlan {
  if (!plan || typeof plan !== 'object') throw new Error('Workflow plan is required');
  if (!plan.goal?.trim()) throw new Error('Workflow plan goal is required');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) throw new Error('Workflow plan must include at least one step');
  if (plan.steps.length > MAX_DYNAMIC_STEPS) throw new Error(`Workflow plan exceeds max steps (${MAX_DYNAMIC_STEPS})`);

  const seen = new Set<string>();
  const steps = plan.steps.map((step, index) => {
    const id = normalizeStepId(step.id || step.title || `step-${index + 1}`, `step-${index + 1}`);
    if (seen.has(id)) throw new Error(`Duplicate workflow step id: ${id}`);
    seen.add(id);
    if (!step.title?.trim()) throw new Error(`Workflow step ${id} missing title`);
    if (!step.agentRole?.trim()) throw new Error(`Workflow step ${id} missing agentRole`);
    return {
      ...step,
      id,
      description: step.description || step.title,
      input: step.input || step.description || step.title,
      dependsOn: (step.dependsOn || []).map(dep => normalizeStepId(dep, dep)),
      priority: step.priority || 'normal',
    };
  });

  for (const step of steps) {
    for (const dep of step.dependsOn || []) {
      if (!seen.has(dep)) throw new Error(`Workflow step ${step.id} depends on unknown step ${dep}`);
      if (dep === step.id) throw new Error(`Workflow step ${step.id} cannot depend on itself`);
    }
  }

  return {
    ...plan,
    strategy: plan.strategy || 'dynamic fan-out with validation summary',
    maxParallel: Math.min(Math.max(plan.maxParallel || DEFAULT_MAX_PARALLEL, 1), MAX_DYNAMIC_STEPS),
    steps,
  };
}

export function buildDynamicWorkflowPlan(goal: string): DynamicWorkflowPlan {
  const lower = goal.toLowerCase();
  const coding = /\b(code|implement|fix|refactor|typescript|react|api|database|bug|实现|修复|代码)\b/i.test(goal);
  const release = /\b(release|deploy|ship|ci|docker|发布|部署)\b/i.test(goal);
  const security = /\b(security|auth|tenant|dlp|sandbox|secret|安全|权限|租户)\b/i.test(goal);
  const ux = /\b(ui|ux|dashboard|accessibility|react|frontend|可访问性)\b/i.test(goal);

  const steps: DynamicWorkflowStep[] = [
    {
      id: 'plan',
      title: 'Plan workflow',
      description: 'Create an implementation strategy, risks, and acceptance criteria.',
      agentRole: 'architect',
      input: `Plan this dynamic workflow and define acceptance criteria:\n${goal}`,
      priority: 'normal',
    },
  ];

  if (coding) {
    steps.push({
      id: 'implement',
      title: 'Implement changes',
      description: 'Make the required code changes following repository conventions.',
      agentRole: 'developer',
      input: `Implement the planned changes for:\n${goal}`,
      dependsOn: ['plan'],
      priority: 'high',
    });
  }

  if (ux) {
    steps.push({
      id: 'ux-review',
      title: 'Review product and UX quality',
      description: 'Check dashboard/product UX, React correctness, accessibility, and user-facing behavior.',
      agentRole: 'react-dashboard-auditor',
      input: `Review product/UX quality for:\n${goal}`,
      dependsOn: coding ? ['implement'] : ['plan'],
    });
  }

  steps.push({
    id: 'qa',
    title: 'Validate workflow output',
    description: 'Run or design focused validation and produce a test report.',
    agentRole: 'qa-automation',
    input: `Validate the workflow output for:\n${goal}`,
    dependsOn: coding ? ['implement'] : ['plan'],
    priority: 'normal',
  });

  if (security || coding || release) {
    steps.push({
      id: 'security-review',
      title: 'Security and governance review',
      description: 'Review security, DLP, sandbox, tenant isolation, and governance risks.',
      agentRole: 'security-reviewer',
      input: `Review security and governance risks for:\n${goal}`,
      dependsOn: coding ? ['implement'] : ['plan'],
      priority: security ? 'high' : 'normal',
    });
  }

  if (release) {
    steps.push({
      id: 'release-gate',
      title: 'Release readiness gate',
      description: 'Evaluate QA, security, GitOps, rollback, and release readiness.',
      agentRole: 'release-compliance',
      input: `Evaluate release readiness for:\n${goal}`,
      dependsOn: ['qa', ...(security || coding ? ['security-review'] : [])],
      priority: 'normal',
    });
  }

  steps.push({
    id: 'summary',
    title: 'Synthesize final workflow result',
    description: 'Summarize outputs, blockers, validation status, and next actions.',
    agentRole: 'release-notes',
    input: `Synthesize a final dynamic workflow report for:\n${goal}`,
    dependsOn: steps.filter(step => step.id !== 'plan').map(step => step.id),
    priority: 'low',
  });

  return validateWorkflowPlan({
    goal,
    strategy: 'Planner generated an executable fan-out workflow with validation and summary stages.',
    maxParallel: DEFAULT_MAX_PARALLEL,
    steps,
    validation: {
      requiredStepIds: ['qa', ...(security || coding ? ['security-review'] : [])],
      summaryPrompt: 'Verify all required steps completed and summarize outputs, blockers, risks, and follow-ups.',
    },
  });
}

export class DynamicWorkflowRuntime {
  private readonly onTaskDoneHandler = (event: any) => this.onTaskDone(event.payload as any);
  private readonly onTaskFailedHandler = (event: any) => this.onTaskFailed(event.payload as any);

  constructor(private taskQueue: TaskQueue, private agentManager: AgentManager) {
    eventBus.on('task:done', this.onTaskDoneHandler);
    eventBus.on('task:failed', this.onTaskFailedHandler);
  }

  dispose(): void {
    eventBus.off('task:done', this.onTaskDoneHandler);
    eventBus.off('task:failed', this.onTaskFailedHandler);
  }

  async start(data: { goal: string; plan?: DynamicWorkflowPlan; workspaceId?: string }): Promise<DynamicWorkflowRun> {
    const id = `wf_${uuid().slice(0, 8)}`;
    const plan = validateWorkflowPlan(data.plan || buildDynamicWorkflowPlan(data.goal));
    const workspaceId = data.workspaceId || 'default';
    getDb().run(`
      INSERT INTO dynamic_workflows (id, goal, status, plan, task_ids, workspace_id)
      VALUES (?, ?, 'planning', ?, '[]', ?)
    `, id, data.goal, JSON.stringify(plan), workspaceId);
    eventBus.emit('workflow:created', { workflowId: id, workspaceId, goal: data.goal });

    const workflow = updateDynamicWorkflow(id, { status: 'dispatching', plan })!;
    eventBus.emit('workflow:planned', { workflowId: id, workspaceId, plan });
    const taskIds = await this.dispatchSteps(workflow);
    return updateDynamicWorkflow(id, { status: 'running', taskIds })!;
  }

  cancel(workflowId: string): DynamicWorkflowRun | undefined {
    const workflow = getDynamicWorkflow(workflowId);
    if (!workflow) return undefined;
    return updateDynamicWorkflow(workflowId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      validationSummary: 'Workflow cancelled by operator.',
    });
  }

  async controlStep(workflowId: string, stepId: string, data: {
    action: 'rerun' | 'skip' | 'replace_agent' | 'force_unblock';
    agentId?: string;
    reason?: string;
  }): Promise<DynamicWorkflowRun> {
    const workflow = getDynamicWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
    const step = workflow.plan.steps.find(item => item.id === stepId);
    if (!step) throw new Error(`Workflow step ${stepId} not found`);
    const task = step.taskId ? getTask(step.taskId) : undefined;

    if (data.action === 'skip') {
      if (!task) throw new Error(`Workflow step ${stepId} has no task to skip`);
      updateTask(task.id, {
        status: 'done',
        output: `Skipped by operator.${data.reason ? ` Reason: ${data.reason}` : ''}`,
        completedAt: new Date().toISOString(),
      });
      eventBus.emit('workflow:task_completed', { workflowId, workspaceId: workflow.workspaceId, taskId: task.id, stepId, skipped: true });
      this.checkCompletion(workflowId);
      return getDynamicWorkflow(workflowId)!;
    }

    if (data.action === 'replace_agent') {
      if (!task) throw new Error(`Workflow step ${stepId} has no task to reassign`);
      if (!data.agentId) throw new Error('agentId is required to replace an agent');
      const agent = getAgent(data.agentId);
      if (!agent) throw new Error(`Agent ${data.agentId} not found`);
      updateTask(task.id, { assigneeId: data.agentId });
      step.agentRole = agent.role;
      workflow.plan.steps = workflow.plan.steps.map(item => item.id === step.id ? { ...step, taskId: task.id } : item);
      updateDynamicWorkflow(workflowId, { plan: workflow.plan });
      eventBus.emit('workflow:task_dispatched', { workflowId, workspaceId: workflow.workspaceId, taskId: task.id, stepId, agentId: data.agentId, reassigned: true });
      return getDynamicWorkflow(workflowId)!;
    }

    const replacement = await this.enqueueStep(workflow, step, {
      ignoreDependencies: data.action === 'force_unblock',
      preferredAgentId: data.agentId,
      reason: data.reason,
    });
    const taskIds = Array.from(new Set([...workflow.taskIds.filter(id => id !== task?.id), replacement.id]));
    step.taskId = replacement.id;
    workflow.plan.steps = workflow.plan.steps.map(item => item.id === step.id ? { ...step } : item);
    updateDynamicWorkflow(workflowId, { status: 'running', plan: workflow.plan, taskIds, completedAt: null, validationSummary: null, result: null });
    eventBus.emit('workflow:task_dispatched', {
      workflowId,
      workspaceId: workflow.workspaceId,
      stepId,
      taskId: replacement.id,
      agentId: replacement.assigneeId,
      action: data.action,
    });
    return getDynamicWorkflow(workflowId)!;
  }

  private async dispatchSteps(workflow: DynamicWorkflowRun): Promise<string[]> {
    const stepToTask = new Map<string, string>();
    const taskIds: string[] = [];
    for (const step of workflow.plan.steps) {
      const task = await this.enqueueStep(workflow, step, { stepToTask });
      step.taskId = task.id;
      stepToTask.set(step.id, task.id);
      taskIds.push(task.id);
      eventBus.emit('workflow:task_dispatched', {
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        stepId: step.id,
        taskId: task.id,
        agentId: task.assigneeId,
        dependsOn: task.dependsOn,
      });
    }
    updateDynamicWorkflow(workflow.id, { plan: workflow.plan, taskIds });
    return taskIds;
  }

  private async enqueueStep(workflow: DynamicWorkflowRun, step: DynamicWorkflowStep, options?: {
    stepToTask?: Map<string, string>;
    ignoreDependencies?: boolean;
    preferredAgentId?: string;
    reason?: string;
  }): Promise<Task> {
    const preferred = options?.preferredAgentId ? getAgent(options.preferredAgentId) : undefined;
    const agent = preferred
      || this.agentManager.findAvailableAgent(step.agentRole)
      || this.agentManager.findAvailableAgent(step.agentRole === 'developer' ? 'dev' : 'developer')
      || this.agentManager.findAvailableAgent('reviewer');
    if (!agent) throw new Error(`No available agent for workflow step ${step.id} (${step.agentRole})`);

    const dependsOn = options?.ignoreDependencies
      ? []
      : (step.dependsOn || []).map(dep => options?.stepToTask?.get(dep) || workflow.plan.steps.find(s => s.id === dep)?.taskId).filter(Boolean) as string[];
    const input = options?.reason
      ? `${this.buildStepInput(workflow, step)}\n\nOperator note: ${options.reason}`
      : this.buildStepInput(workflow, step);
    return this.taskQueue.enqueue({
      title: `${workflow.goal.slice(0, 48)} — ${step.title}`,
      description: step.description,
      mode: 'direct',
      priority: (step.priority || 'normal') as Priority,
      assigneeId: agent.id,
      input,
      dependsOn,
      workspaceId: workflow.workspaceId,
    });
  }

  private buildStepInput(workflow: DynamicWorkflowRun, step: DynamicWorkflowStep): string {
    const deps = (step.dependsOn || []).map(dep => `- ${dep}`).join('\n') || 'none';
    return [
      `# Dynamic Workflow Step: ${step.title}`,
      `Workflow goal: ${workflow.goal}`,
      `Strategy: ${workflow.plan.strategy}`,
      `Step id: ${step.id}`,
      `Depends on:\n${deps}`,
      '',
      step.input,
      '',
      'Return concise output suitable for downstream agents. Include blockers, validation evidence, and next actions.',
    ].join('\n');
  }

  private onTaskDone(payload: any): void {
    const taskId = payload?.taskId;
    if (!taskId) return;
    for (const workflow of this.findRunningByTask(taskId)) {
      eventBus.emit('workflow:task_completed', { workflowId: workflow.id, workspaceId: workflow.workspaceId, taskId });
      this.checkCompletion(workflow.id);
    }
  }

  private onTaskFailed(payload: any): void {
    const taskId = payload?.taskId;
    if (!taskId) return;
    for (const workflow of this.findRunningByTask(taskId)) {
      eventBus.emit('workflow:task_failed', { workflowId: workflow.id, workspaceId: workflow.workspaceId, taskId, error: payload?.error });
      this.checkCompletion(workflow.id);
    }
  }

  private findRunningByTask(taskId: string): DynamicWorkflowRun[] {
    const rows = getDb().all(
      "SELECT * FROM dynamic_workflows WHERE status IN ('running','validating')",
    ) as any[];
    return rows
      .map(rowToWorkflow)
      .filter(workflow => workflow.taskIds.includes(taskId));
  }

  private checkCompletion(workflowId: string): void {
    const workflow = getDynamicWorkflow(workflowId);
    if (!workflow || !['running', 'validating'].includes(workflow.status)) return;
    const tasks = workflow.taskIds.map(id => getTask(id)).filter(Boolean) as Task[];
    if (tasks.length === 0 || tasks.some(task => !['done', 'failed', 'cancelled'].includes(task.status))) return;

    updateDynamicWorkflow(workflowId, { status: 'validating' });
    const failed = tasks.filter(task => task.status !== 'done');
    const required = new Set(workflow.plan.validation?.requiredStepIds || []);
    const requiredFailures = workflow.plan.steps
      .filter(step => required.has(step.id) && step.taskId && failed.some(task => task.id === step.taskId))
      .map(step => step.id);
    const result = tasks
      .map(task => `## ${task.title}\nStatus: ${task.status}\n${task.output || task.error || 'No output'}`)
      .join('\n\n---\n\n');
    const validationSummary = [
      `Workflow ${failed.length === 0 && requiredFailures.length === 0 ? 'passed' : 'needs attention'}.`,
      `Completed tasks: ${tasks.length - failed.length}/${tasks.length}.`,
      requiredFailures.length ? `Required failed steps: ${requiredFailures.join(', ')}.` : 'Required validation steps passed.',
    ].join(' ');
    const status: DynamicWorkflowStatus = failed.length === 0 && requiredFailures.length === 0 ? 'done' : 'failed';
    updateDynamicWorkflow(workflowId, {
      status,
      result,
      validationSummary,
      completedAt: new Date().toISOString(),
    });
    eventBus.emit(status === 'done' ? 'workflow:done' : 'workflow:failed', {
      workflowId,
      workspaceId: workflow.workspaceId,
      status,
      validationSummary,
    });
  }
}
