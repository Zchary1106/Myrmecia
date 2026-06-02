import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent, listAgents } from '../src/db/models/agent.js';
import { createTask, getTask, updateTask } from '../src/db/models/task.js';
import { DynamicWorkflowRuntime, buildDynamicWorkflowPlan, getDynamicWorkflow, validateWorkflowPlan } from '../src/agents/dynamic-workflow.js';
import { eventBus } from '../src/events/event-bus.js';

describe('dynamic workflow runtime', () => {
  let runtimes: DynamicWorkflowRuntime[] = [];

  beforeEach(() => {
    runtimes = [];
    closeDb();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-workflow-')), 'test.db');
    getDb();
    createAgent({ id: 'dev-agent', name: 'Dev Agent', role: 'developer' });
    createAgent({ id: 'qa-agent', name: 'QA Agent', role: 'qa-automation' });
    createAgent({ id: 'review-agent', name: 'Review Agent', role: 'reviewer' });
  });

  afterEach(() => {
    for (const instance of runtimes) instance.dispose();
    closeDb();
    delete process.env.DB_PATH;
  });

  function runtime() {
    const taskQueue = {
      enqueue: async (data: any) => createTask({
        title: data.title,
        description: data.description,
        mode: data.mode,
        priority: data.priority,
        assigneeId: data.assigneeId,
        input: data.input,
        dependsOn: data.dependsOn,
        workspaceId: data.workspaceId,
      }),
    };
    const agentManager = {
      findAvailableAgent: (role: string) => listAgents({ role })[0] || listAgents()[0],
    };
    const instance = new DynamicWorkflowRuntime(taskQueue as any, agentManager as any);
    runtimes.push(instance);
    return instance;
  }

  it('validates executable plans and rejects unknown dependencies', () => {
    expect(() => validateWorkflowPlan({
      goal: 'bad',
      strategy: 'bad',
      steps: [{ id: 'qa', title: 'QA', description: 'QA', agentRole: 'qa-automation', input: 'qa', dependsOn: ['missing'] }],
    })).toThrow(/unknown step/);
  });

  it('builds a fan-out plan with validation and summary steps', () => {
    const plan = buildDynamicWorkflowPlan('Implement a TypeScript auth fix and run security review before release');

    expect(plan.steps.some(step => step.id === 'implement')).toBe(true);
    expect(plan.steps.some(step => step.id === 'qa')).toBe(true);
    expect(plan.steps.some(step => step.id === 'security-review')).toBe(true);
    expect(plan.validation?.requiredStepIds).toContain('qa');
  });

  it('dispatches dependent tasks and aggregates terminal results', async () => {
    const wfRuntime = runtime();
    const workflow = await wfRuntime.start({
      goal: 'Ship a small fix',
      workspaceId: 'ws-dyn',
      plan: {
        goal: 'Ship a small fix',
        strategy: 'test plan',
        steps: [
          { id: 'implement', title: 'Implement', description: 'Implement', agentRole: 'developer', input: 'code' },
          { id: 'qa', title: 'QA', description: 'QA', agentRole: 'qa-automation', input: 'test', dependsOn: ['implement'] },
        ],
        validation: { requiredStepIds: ['qa'] },
      },
    });

    expect(workflow.status).toBe('running');
    expect(workflow.taskIds).toHaveLength(2);

    updateTask(workflow.taskIds[0], { status: 'done', output: 'implemented', completedAt: new Date().toISOString() });
    eventBus.emit('task:done', { taskId: workflow.taskIds[0], workspaceId: 'ws-dyn' });
    expect(getDynamicWorkflow(workflow.id)?.status).toBe('running');

    updateTask(workflow.taskIds[1], { status: 'done', output: 'tests passed', completedAt: new Date().toISOString() });
    eventBus.emit('task:done', { taskId: workflow.taskIds[1], workspaceId: 'ws-dyn' });

    const completed = getDynamicWorkflow(workflow.id);
    expect(completed?.status).toBe('done');
    expect(completed?.validationSummary).toContain('passed');
    expect(completed?.result).toContain('tests passed');
  });

  it('supports workflow step rerun, skip, force unblock, and agent replacement controls', async () => {
    createAgent({ id: 'reviewer-2', name: 'Reviewer 2', role: 'reviewer' });
    const wfRuntime = runtime();
    const workflow = await wfRuntime.start({
      goal: 'Control workflow',
      workspaceId: 'ws-controls',
      plan: {
        goal: 'Control workflow',
        strategy: 'control test',
        steps: [
          { id: 'implement', title: 'Implement', description: 'Implement', agentRole: 'developer', input: 'code' },
          { id: 'qa', title: 'QA', description: 'QA', agentRole: 'qa-automation', input: 'test', dependsOn: ['implement'] },
        ],
        validation: { requiredStepIds: ['qa'] },
      },
    });

    const rerun = await wfRuntime.controlStep(workflow.id, 'qa', { action: 'rerun', reason: 'try again' });
    const rerunTaskId = rerun.plan.steps.find(step => step.id === 'qa')?.taskId;
    expect(rerunTaskId).toBeTruthy();
    expect(rerunTaskId).not.toBe(workflow.plan.steps.find(step => step.id === 'qa')?.taskId);

    const force = await wfRuntime.controlStep(workflow.id, 'qa', { action: 'force_unblock' });
    const forceTaskId = force.plan.steps.find(step => step.id === 'qa')?.taskId!;
    expect(getTask(forceTaskId)?.dependsOn).toEqual([]);

    const replaced = await wfRuntime.controlStep(workflow.id, 'qa', { action: 'replace_agent', agentId: 'reviewer-2' });
    const replacedTaskId = replaced.plan.steps.find(step => step.id === 'qa')?.taskId!;
    expect(getTask(replacedTaskId)?.assigneeId).toBe('reviewer-2');

    const skipped = await wfRuntime.controlStep(workflow.id, 'qa', { action: 'skip', reason: 'not needed' });
    const skippedTaskId = skipped.plan.steps.find(step => step.id === 'qa')?.taskId!;
    expect(getTask(skippedTaskId)?.status).toBe('done');
    expect(getTask(skippedTaskId)?.output).toContain('Skipped by operator');
  });
});
