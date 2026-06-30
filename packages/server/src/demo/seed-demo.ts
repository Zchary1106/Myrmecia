import { getDb, closeDb } from '../db/database.js';
import { createAgent, getAgent } from '../db/models/agent.js';
import { createTask, updateTask, addTaskLog } from '../db/models/task.js';
import { createExecution, updateExecution, addExecutionMessage } from '../db/models/execution.js';
import { createPipeline, createTemplate, updatePipeline } from '../db/models/pipeline.js';
import { createRunTrace, createTraceSpan, completeRunTrace, completeTraceSpan } from '../db/models/trace.js';
import { createNotification } from '../db/models/notification.js';
import { createInboxEntry } from '../db/models/inbox.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { recordPlatformEvent } from '../db/models/platform-event.js';
import { syncBuiltinModels, recordModelUsage } from '../models/model-registry.js';
import { syncBuiltinTools } from '../tools/tool-registry.js';
import { ingestDocument, resetKnowledgeVectorStoreForTests } from '../knowledge/rag.js';
import type { AgentDefinition, AgentProgress, PipelineStage, WSEventType } from '../types.js';

process.env.EMBEDDING_BACKEND ||= 'pseudo';
process.env.MEMORY_KNOWLEDGE_BRIDGE ||= 'false';

const dbPath = process.env.DB_PATH || '';
if (!process.env.AGENT_FACTORY_DEMO_MODE && !dbPath.includes('demo')) {
  throw new Error('Refusing to seed demo data unless AGENT_FACTORY_DEMO_MODE=true or DB_PATH contains "demo".');
}

const workspaceId = 'default';
const modelId = 'claude-haiku-4.5';
const demoActor = { id: 'demo-operator', role: 'admin' as const, source: 'local' as const };

const agentSpecs = [
  { id: 'master', name: 'Master Coordinator', role: 'orchestrator', emoji: '👑', description: 'Plans and decomposes multi-agent work.' },
  { id: 'pm', name: 'Product Manager', role: 'product-manager', emoji: '📋', description: 'Turns goals into product requirements.' },
  { id: 'ui', name: 'UI Designer', role: 'designer', emoji: '🎨', description: 'Designs usable dashboard flows.' },
  { id: 'dev', name: 'Developer', role: 'developer', emoji: '💻', description: 'Implements code and tests.' },
  { id: 'qa', name: 'QA Engineer', role: 'tester', emoji: '🧪', description: 'Validates behavior and regressions.' },
  { id: 'review', name: 'Code Reviewer', role: 'reviewer', emoji: '🔍', description: 'Reviews correctness, risk, and maintainability.' },
  { id: 'ops', name: 'Ops Engineer', role: 'devops', emoji: '🚀', description: 'Checks deployment and rollback readiness.' },
];

const stageOutputs = [
  {
    agentId: 'pm',
    name: 'Product Spec',
    role: 'product-manager',
    output: [
      '# Product Spec',
      'Build a GitHub issue triage dashboard for maintainers.',
      '- Prioritize issues by severity, recency, and maintainer labels.',
      '- Surface blocked issues and suggested next actions.',
      '- Track triage SLA and weekly throughput.',
    ].join('\n'),
  },
  {
    agentId: 'ui',
    name: 'Interaction Design',
    role: 'designer',
    output: [
      '# Interaction Design',
      'Use a three-column layout: Inbox, Needs Decision, Ready for Action.',
      'Each card shows severity, owner, stale age, and recommended next step.',
      'The top summary row shows SLA risk, open blockers, and throughput.',
    ].join('\n'),
  },
  {
    agentId: 'dev',
    name: 'Implementation',
    role: 'developer',
    output: [
      '# Implementation Summary',
      '- Added issue triage scoring service.',
      '- Added dashboard cards and filters.',
      '- Added API endpoint for prioritized issue summaries.',
      '- Added unit tests for scoring edge cases.',
    ].join('\n'),
  },
  {
    agentId: 'qa',
    name: 'QA Validation',
    role: 'tester',
    output: [
      '# QA Report',
      'Result: PASS',
      '- 18 unit tests passed.',
      '- Empty-state, stale issue, and label conflict cases verified.',
      '- No critical accessibility regressions found.',
    ].join('\n'),
  },
  {
    agentId: 'review',
    name: 'Review',
    role: 'reviewer',
    output: [
      '# Review Sign-off',
      'Approved with one follow-up: add repository-level SLA configuration before production rollout.',
      'Risk level: low. Rollback path: disable triage dashboard route and keep existing issue list.',
    ].join('\n'),
  },
];

function resetDemoDatabase() {
  const db = getDb();
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM model_usage_stats;
    DELETE FROM model_health_checks;
    DELETE FROM model_routes;
    DELETE FROM model_registry;
    DELETE FROM execution_scores;
    DELETE FROM trace_spans;
    DELETE FROM run_traces;
    DELETE FROM execution_messages;
    DELETE FROM task_executions;
    DELETE FROM quality_loop_attempts;
    DELETE FROM task_logs;
    DELETE FROM tasks;
    DELETE FROM pipeline_templates;
    DELETE FROM pipelines;
    DELETE FROM notifications;
    DELETE FROM inbox_entries;
    DELETE FROM platform_events;
    DELETE FROM operator_actions;
    DELETE FROM agent_messages;
    DELETE FROM agent_comm_log;
    DELETE FROM shared_artifacts;
    DELETE FROM knowledge_documents;
    DELETE FROM agent_memories;
    DELETE FROM team_runs;
    DELETE FROM team_definitions;
    DELETE FROM agents;
    DELETE FROM tool_permissions;
    DELETE FROM tool_executions;
    DELETE FROM tool_versions;
    DELETE FROM tools;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureAgent(spec: typeof agentSpecs[number]): AgentDefinition {
  const existing = getAgent(spec.id);
  if (existing) return existing;
  return createAgent({
    id: spec.id,
    name: spec.name,
    role: spec.role,
    emoji: spec.emoji,
    description: spec.description,
    whenToUse: spec.description,
    capabilities: ['demo', spec.role],
    triggers: [spec.role],
    model: modelId,
    maxTurns: 12,
    config: {
      model: modelId,
      maxConcurrent: 2,
      timeout: 120,
      maxTurns: 12,
      allowedTools: ['file_read', 'grep', 'apply_patch', 'shell_exec'],
    },
  });
}

function emit(type: WSEventType, payload: Record<string, unknown>) {
  recordPlatformEvent({ type, payload, timestamp: new Date().toISOString() });
}

function completeDemoTask(data: {
  title: string;
  description: string;
  mode: 'direct' | 'pipeline' | 'master';
  agentId: string;
  input: string;
  output: string;
  pipelineId?: string;
  stageIndex?: number;
  parentTaskId?: string;
  costUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const task = createTask({
    title: data.title,
    description: data.description,
    mode: data.mode,
    assigneeId: data.agentId,
    input: data.input,
    pipelineId: data.pipelineId,
    stageIndex: data.stageIndex,
    parentTaskId: data.parentTaskId,
    workspaceId,
  });
  const execution = createExecution({ taskId: task.id, agentDefId: data.agentId, workspaceId });
  const progress: AgentProgress = {
    toolUseCount: data.agentId === 'dev' ? 4 : 2,
    tokenCount: (data.inputTokens || 1200) + (data.outputTokens || 800),
    recentActivities: [
      {
        toolName: 'demo.plan',
        input: { task: data.title },
        activityDescription: `Demo ${data.title} started`,
        timestamp: new Date(Date.now() - 45_000).toISOString(),
      },
      {
        toolName: 'demo.complete',
        input: { task: data.title },
        activityDescription: `Demo ${data.title} completed`,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  addTaskLog(task.id, 'info', `Demo task assigned to ${data.agentId}`, 'system');
  addExecutionMessage({ executionId: execution.id, type: 'user_input', content: data.input });
  addExecutionMessage({ executionId: execution.id, type: 'progress', content: `Running ${data.title}` });
  addExecutionMessage({ executionId: execution.id, type: 'agent_text', content: data.output });
  updateExecution(execution.id, {
    status: 'done',
    progress,
    costUSD: data.costUSD || 0.012,
    tokenCount: progress.tokenCount,
    completedAt: new Date().toISOString(),
    modelId,
    modelTier: 'cheap',
    modelRouteSource: 'default',
    modelRouteReason: 'Seeded demo run',
  });
  const completedTask = updateTask(task.id, {
    status: 'done',
    output: data.output,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date().toISOString(),
  })!;
  addTaskLog(task.id, 'info', 'Demo task completed', data.agentId);

  const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: data.agentId });
  const planSpan = createTraceSpan({
    traceId: trace.id,
    type: 'agent.plan',
    name: `${data.agentId} planned work`,
    metadata: { demo: true, taskId: task.id },
  });
  completeTraceSpan(planSpan.id, { status: 'done', durationMs: 420, metadata: { result: 'plan ready' } });
  const toolSpan = createTraceSpan({
    traceId: trace.id,
    type: 'tool.use',
    name: data.agentId === 'dev' ? 'apply_patch + test' : 'analyze context',
    metadata: { demo: true, toolCount: progress.toolUseCount },
  });
  completeTraceSpan(toolSpan.id, { status: 'done', durationMs: 860, metadata: { output: 'demo artifact generated' } });
  completeRunTrace(trace.id, { status: 'done', summary: `${data.title} completed` });

  recordModelUsage({
    modelId,
    agentId: data.agentId,
    taskId: task.id,
    executionId: execution.id,
    status: 'success',
    inputTokens: data.inputTokens || 1200,
    outputTokens: data.outputTokens || 800,
    costUSD: data.costUSD || 0.012,
    routeReason: 'Seeded demo usage',
    routeSource: 'runtime.default',
    modelTier: 'cheap',
    workspaceId,
    pipelineId: data.pipelineId,
    stageIndex: data.stageIndex,
  });

  emit('task:created', { taskId: task.id, task: completedTask, workspaceId });
  emit('task:done', { taskId: task.id, agentId: data.agentId, workspaceId, output: data.output });
  emit('execution:done', { executionId: execution.id, taskId: task.id, workspaceId, progress });
  return completedTask;
}

async function main() {
  resetDemoDatabase();
  resetKnowledgeVectorStoreForTests();
  syncBuiltinModels();
  syncBuiltinTools();
  for (const spec of agentSpecs) ensureAgent(spec);

  const template = createTemplate({
    name: 'Demo: Feature Delivery',
    description: 'Seeded PM -> Design -> Dev -> QA -> Review flow for the demo dashboard.',
    stages: stageOutputs.map(stage => ({
      name: stage.name,
      role: stage.role,
      promptTemplate: `Demo stage: ${stage.name}. Goal: {input}`,
    })),
  });

  const pipeline = createPipeline({
    name: 'Demo: GitHub issue triage dashboard',
    templateId: template.id,
    input: 'Build a GitHub issue triage dashboard for maintainers.',
    stages: stageOutputs.map((stage, index): PipelineStage => ({
      index,
      name: stage.name,
      agentRole: stage.role,
      status: 'pending',
      promptTemplate: `Demo stage: ${stage.name}. Goal: {input}`,
      dependsOn: index === 0 ? [] : [index - 1],
    })),
    gateMode: 'auto',
    workspaceId,
  });

  const completedStages: PipelineStage[] = [];
  for (const [index, stage] of stageOutputs.entries()) {
    const task = completeDemoTask({
      title: `${pipeline.name} - ${stage.name}`,
      description: `Seeded demo output for ${stage.name}.`,
      mode: 'pipeline',
      agentId: stage.agentId,
      input: `Pipeline goal: ${pipeline.input}\nStage: ${stage.name}`,
      output: stage.output,
      pipelineId: pipeline.id,
      stageIndex: index,
      costUSD: 0.01 + index * 0.004,
      inputTokens: 900 + index * 120,
      outputTokens: 650 + index * 80,
    });
    completedStages.push({
      ...pipeline.stages[index],
      status: 'done',
      taskId: task.id,
      input: task.input,
      output: stage.output,
    });
    emit('pipeline:stage:done', { pipelineId: pipeline.id, stageIndex: index, taskId: task.id, workspaceId, output: stage.output });
  }
  updatePipeline(pipeline.id, {
    status: 'done',
    stages: completedStages,
    currentStageIndex: completedStages.length - 1,
    completedAt: new Date().toISOString(),
  });
  emit('pipeline:done', { pipelineId: pipeline.id, workspaceId });

  const parent = completeDemoTask({
    title: 'Feature Team: GitHub issue triage dashboard',
    description: 'Seeded parent task for the Agent Teams board.',
    mode: 'master',
    agentId: 'master',
    input: 'Coordinate a feature team to ship issue triage.',
    output: 'Feature team completed PM, UI, Dev, QA, and Ops subtasks in parallel.',
    costUSD: 0.018,
  });
  const teamTasks = [
    ['pm', 'Define triage workflow', 'PRD delivered with scoring rules and SLA definitions.'],
    ['ui', 'Design triage board', 'Board design delivered with Inbox, Needs Decision, and Ready columns.'],
    ['dev', 'Implement triage service', 'Scoring service and dashboard integration implemented.'],
    ['qa', 'Validate triage behavior', 'Regression suite passed for scoring and empty states.'],
    ['ops', 'Prepare rollout', 'Rollout checklist and rollback plan completed.'],
  ] as const;
  for (const [agentId, title, output] of teamTasks) {
    completeDemoTask({
      title,
      description: `Team board task: ${title}`,
      mode: 'direct',
      agentId,
      input: `Team goal: ${parent.title}`,
      output,
      parentTaskId: parent.id,
      costUSD: 0.007,
    });
  }
  getDb().run(
    `INSERT INTO team_runs (id, team_id, goal, status, parent_task_id, result, workspace_id, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'demo_team_run',
    'feature',
    'Build a GitHub issue triage dashboard',
    'done',
    parent.id,
    'The seeded feature team shipped a full triage dashboard plan, implementation summary, QA report, and rollout checklist.',
    workspaceId,
    new Date().toISOString(),
  );
  emit('team:run_done', { runId: 'demo_team_run', teamId: 'feature', status: 'done', workspaceId });

  await ingestDocument(
    workspaceId,
    'Demo product brief',
    'Myrmecia demo brief: maintainers need an issue triage dashboard that ranks issues by severity, freshness, labels, and blocked state. The demo should show pipeline traceability, team collaboration, cost visibility, and audit readiness.',
    { source: 'seed-demo', kind: 'product-brief' },
  );

  const inbox = createInboxEntry({
    type: 'approval',
    title: 'Approve demo rollout checklist',
    message: 'Review the seeded rollout checklist before enabling the feature for production users.',
    options: ['Approve', 'Request changes'],
    workspaceId,
    createdBy: 'system',
  });
  const notification = createNotification({
    type: 'needs_input',
    title: 'Demo inbox item ready',
    message: inbox.message,
    workspaceId,
  });
  emit('inbox:created', { inboxEntryId: inbox.id, entry: inbox, workspaceId });
  emit('notification', { notification, workspaceId });

  createNotification({
    type: 'pipeline_stage',
    title: 'Demo pipeline completed',
    message: 'PM -> Design -> Dev -> QA -> Review finished successfully.',
    pipelineId: pipeline.id,
    workspaceId,
  });
  createOperatorAction({
    action: 'demo.seed',
    actor: demoActor,
    targetType: 'system',
    targetId: 'demo',
    metadata: {
      pipelineId: pipeline.id,
      teamRunId: 'demo_team_run',
      seededAt: new Date().toISOString(),
    },
  });

  console.log(JSON.stringify({
    ok: true,
    dbPath: process.env.DB_PATH,
    pipelineId: pipeline.id,
    teamRunId: 'demo_team_run',
    workspaceId,
  }, null, 2));
  closeDb();
}

main().catch(err => {
  console.error(err);
  closeDb();
  process.exit(1);
});
