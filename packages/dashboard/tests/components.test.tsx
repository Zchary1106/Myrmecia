import { describe, it, expect } from 'vitest';
import { api } from '../src/lib/api';
import {
  filterNotifications,
  buildNotificationGroups,
  notificationScope,
  notificationTarget,
  defaultNotificationFilters,
  notificationTypeLabels,
} from '../src/lib/notificationTriage';
import {
  runtimeControlsAllowed,
  taskDeleteAllowed,
  operatorRoleLabel,
  readOnlyControlMessage,
} from '../src/lib/permissions';
import { createSavedView, savedViewScope } from '../src/lib/savedViews';
import { buildActivitySummary, handoffTotal } from '../src/lib/activitySummary';
import { useStore } from '../src/stores/store';
import { CONTENT_STUDIO_ENTRY_ID, isContentProductionAgent, usesContentStudio } from '../src/components/agents/AgentWorkspace';
import { CONTENT_STUDIO_PROFILES, pipelineMatchesProfile, studioProfileForTeam } from '../src/components/agents/contentStudioProfiles';
import { hasPublishStageAhead } from '../src/pages/Pipelines';
import { canControlWorkflowNode } from '../src/pages/Orchestrate';

// ─── API module structure ────────────────────────────────────────────────────

describe('api module structure', () => {
  it('exports tasks namespace with expected methods', () => {
    expect(api.tasks).toBeDefined();
    expect(api.tasks.list).toBeTypeOf('function');
    expect(api.tasks.get).toBeTypeOf('function');
    expect(api.tasks.create).toBeTypeOf('function');
    expect(api.tasks.cancel).toBeTypeOf('function');
    expect(api.tasks.retry).toBeTypeOf('function');
    expect(api.tasks.delete).toBeTypeOf('function');
  });

  it('exports agents namespace with expected methods', () => {
    expect(api.agents).toBeDefined();
    expect(api.agents.list).toBeTypeOf('function');
    expect(api.agents.get).toBeTypeOf('function');
    expect(api.agents.execute).toBeTypeOf('function');
    expect(api.agents.executions).toBeTypeOf('function');
  });

  it('exports pipelines namespace', () => {
    expect(api.pipelines).toBeDefined();
    expect(api.pipelines.list).toBeTypeOf('function');
    expect(api.pipelines.create).toBeTypeOf('function');
    expect(api.pipelines.approve).toBeTypeOf('function');
    expect(api.pipelines.retryStage).toBeTypeOf('function');
    expect(api.pipelines.artifacts).toBeTypeOf('function');
  });

  it('exports tools namespace', () => {
    expect(api.tools).toBeDefined();
    expect(api.tools.list).toBeTypeOf('function');
    expect(api.tools.executions).toBeTypeOf('function');
  });

  it('exports MCP namespace', () => {
    expect(api.mcp).toBeDefined();
    expect(api.mcp.servers).toBeTypeOf('function');
    expect(api.mcp.tools).toBeTypeOf('function');
  });

  it('exports models namespace', () => {
    expect(api.models).toBeDefined();
    expect(api.models.list).toBeTypeOf('function');
    expect(api.models.routes).toBeTypeOf('function');
    expect(api.models.providerSettings).toBeTypeOf('function');
    expect(api.models.selectProviderModel).toBeTypeOf('function');
  });

  it('exports GitHub fix workflow methods', () => {
    expect(api.githubFixes).toBeDefined();
    expect(api.githubFixes.status).toBeTypeOf('function');
    expect(api.githubFixes.list).toBeTypeOf('function');
    expect(api.githubFixes.create).toBeTypeOf('function');
    expect(api.githubFixes.diff).toBeTypeOf('function');
    expect(api.githubFixes.createPullRequest).toBeTypeOf('function');
  });

  it('exports artifact workbench methods', () => {
    expect(api.artifacts).toBeDefined();
    expect(api.artifacts.workbench).toBeTypeOf('function');
    expect(api.artifacts.preview).toBeTypeOf('function');
    expect(api.artifacts.download).toBeTypeOf('function');
  });

  it('exports workflow runtime and team template methods', () => {
    expect(api.graphWorkflows.artifacts).toBeTypeOf('function');
    expect(api.graphWorkflows.retryNode).toBeTypeOf('function');
    expect(api.graphWorkflows.approveNode).toBeTypeOf('function');
    expect(api.graphWorkflows.rejectNode).toBeTypeOf('function');
    expect(api.teams.versions).toBeTypeOf('function');
    expect(api.teams.createVersion).toBeTypeOf('function');
    expect(api.teams.publishVersion).toBeTypeOf('function');
    expect(api.teams.archiveVersion).toBeTypeOf('function');
    expect(api.teams.instantiate).toBeTypeOf('function');
  });

  it('exports executions namespace', () => {
    expect(api.executions).toBeDefined();
    expect(api.executions.list).toBeTypeOf('function');
    expect(api.executions.messages).toBeTypeOf('function');
    expect(api.executions.trace).toBeTypeOf('function');
  });

  it('exports preferences namespace', () => {
    expect(api.preferences).toBeDefined();
    expect(api.preferences.list).toBeTypeOf('function');
    expect(api.preferences.get).toBeTypeOf('function');
    expect(api.preferences.put).toBeTypeOf('function');
    expect(api.preferences.delete).toBeTypeOf('function');
  });

  it('exports notifications namespace', () => {
    expect(api.notifications).toBeDefined();
    expect(api.notifications.list).toBeTypeOf('function');
    expect(api.notifications.markRead).toBeTypeOf('function');
    expect(api.notifications.markAllRead).toBeTypeOf('function');
  });

  it('exports all top-level namespaces', () => {
    const namespaces = [
      'tasks', 'agents', 'tools', 'mcp', 'models', 'skills', 'executions',
      'pipelines', 'templates', 'events', 'preferences', 'notifications',
      'inbox', 'supervisor', 'knowledge', 'audit', 'plugins', 'billing',
      'usage', 'apiKeys', 'releases', 'eval', 'notificationChannels',
      'operatorActions', 'workspaceSnapshot', 'githubFixes', 'artifacts',
    ];
    for (const ns of namespaces) {
      expect((api as any)[ns], `api.${ns} should exist`).toBeDefined();
    }
  });

  it('exports health and stats as functions', () => {
    expect(api.health).toBeTypeOf('function');
    expect(api.stats).toBeTypeOf('function');
    expect(api.observability).toBeTypeOf('function');
    expect(api.diagnostics).toBeTypeOf('function');
  });
});

describe('Team Composer runtime controls', () => {
  it('only enables approval controls for intervention states', () => {
    expect(canControlWorkflowNode('waiting_approval')).toEqual({
      approve: true,
      reject: true,
      retry: true,
    });
    expect(canControlWorkflowNode('running')).toEqual({
      approve: false,
      reject: false,
      retry: false,
    });
  });

  it('enables retry for recoverable terminal states', () => {
    expect(canControlWorkflowNode('failed').retry).toBe(true);
    expect(canControlWorkflowNode('skipped').retry).toBe(true);
    expect(canControlWorkflowNode('done').retry).toBe(false);
  });
});

describe('Agent Workbench navigation state', () => {
  it('opens the Agents workspace and inspector atomically', () => {
    useStore.setState({
      activeView: 'tasks',
      selectedAgentId: null,
      agentInspectorOpen: false,
      rightPanelTab: 'history',
    });

    useStore.getState().setSelectedAgentId('dev');

    expect(useStore.getState()).toMatchObject({
      activeView: 'agents',
      selectedAgentId: 'dev',
      agentInspectorOpen: true,
      rightPanelTab: 'chat',
    });
  });

  it('persists the Agent directory collapse state in the store', () => {
    useStore.getState().setAgentDirectoryCollapsed(true);
    expect(useStore.getState().agentDirectoryCollapsed).toBe(true);
    useStore.getState().setAgentDirectoryCollapsed(false);
    expect(useStore.getState().agentDirectoryCollapsed).toBe(false);
  });

  it('groups social and WeChat specialists in the content directory', () => {
    expect(isContentProductionAgent({
      id: 'xiaohongshu-writer',
      role: 'content-writer',
      capabilities: ['xiaohongshu'],
    } as any)).toBe(true);
    expect(isContentProductionAgent({
      id: 'douyin-writer',
      role: 'douyin-writer',
      capabilities: ['douyin'],
    } as any)).toBe(true);
    expect(isContentProductionAgent({
      id: 'wechat-writer',
      role: 'content-writer',
      capabilities: ['wechat'],
    } as any)).toBe(true);
    expect(isContentProductionAgent({
      id: 'dev',
      role: 'developer',
      capabilities: ['typescript'],
    } as any)).toBe(false);
  });

  it('opens Content Studio only via the dedicated Team-driven entry', () => {
    expect(usesContentStudio({ id: CONTENT_STUDIO_ENTRY_ID } as any)).toBe(true);

    // Legacy task agents are hidden from the directory; they keep their own Agent chat/history/inspector.
    expect(usesContentStudio({ id: 'xiaohongshu-writer' } as any)).toBe(false);
    expect(usesContentStudio({ id: 'wechat-writer' } as any)).toBe(false);
    expect(usesContentStudio({ id: 'trend-scout' } as any)).toBe(false);
    expect(usesContentStudio({ id: 'social-publisher' } as any)).toBe(false);
    expect(usesContentStudio({ id: 'xiaohongshu-visual-designer' } as any)).toBe(false);
  });

  it('falls back to the crosspost profile for unknown teams', () => {
    expect(studioProfileForTeam('unknown-team').teamId).toBe('social-three-lanes');
  });

  it('uses the governed WeChat article workflow for the content team', () => {
    const workflow = studioProfileForTeam('content');
    expect(workflow.templateName).toBe('WeChat Article');
    expect(workflow.stages.map(stage => stage.name)).toEqual([
      '选题分析',
      '内容创作',
      '内容审核',
      '排版优化',
      '草稿箱同步',
      '发布执行',
    ]);
    expect(workflow.stages.some(stage => stage.agentRole === 'content-creator')).toBe(true);
    expect(workflow.stages.some(stage => stage.agentRole === 'ops')).toBe(true);
  });

  it('uses a standalone publishing workflow for the Xiaohongshu team', () => {
    const workflow = studioProfileForTeam('xiaohongshu');
    expect(workflow.templateName).toBe('Xiaohongshu Publish');
    expect(workflow.stages.map(stage => stage.name)).toEqual([
      '小红书选题调研',
      '小红书笔记创作',
      '自动合规初筛',
      '人工审核材料',
      '配图生成',
      '媒体 QA',
      '发布预检',
      '小红书发布',
    ]);
    expect(workflow.stages.some(stage => stage.agentRole === 'douyin-writer')).toBe(false);
    expect(workflow.stages.some(stage => stage.agentRole === 'content-creator')).toBe(true);
  });

  it('uses a standalone video publishing workflow for the Douyin team', () => {
    const workflow = studioProfileForTeam('douyin');
    expect(workflow.templateName).toBe('Douyin Video Publish');
    expect(workflow.stages.map(stage => stage.name)).toEqual([
      '抖音选题调研',
      '抖音视频脚本',
      '自动合规初筛',
      '人工审核材料',
      '视频媒体 QA',
      '发布预检',
      '抖音视频发布',
      '发布补偿计划',
      '发布后监控计划',
    ]);
    expect(workflow.stages.some(stage => stage.agentRole === 'xiaohongshu-writer')).toBe(false);
    expect(workflow.stages.some(stage => stage.agentRole === 'content-creator')).toBe(true);
  });

  it('matches pipelines to profiles by template id and stage signature', () => {
    const xiaohongshu = studioProfileForTeam('xiaohongshu');
    const wechat = studioProfileForTeam('content');

    expect(pipelineMatchesProfile(
      { templateId: 'tpl-xhs', stages: [{ name: 'x' }] },
      xiaohongshu,
      'tpl-xhs',
    )).toBe(true);

    // Legacy pipeline whose stage names still match the profile stays visible.
    expect(pipelineMatchesProfile(
      { stages: [{ name: '小红书选题调研' }, { name: '小红书笔记创作' }, { name: '发布预检' }] },
      xiaohongshu,
    )).toBe(true);

    expect(pipelineMatchesProfile(
      { stages: [{ name: '选题分析' }, { name: '完全不相关的阶段' }] },
      wechat,
    )).toBe(false);
    expect(pipelineMatchesProfile(
      { stages: [{ name: '选题分析' }, { name: '内容创作' }, { name: '草稿箱同步' }] },
      wechat,
    )).toBe(true);
  });

  it('keeps one profile per content team with publish approval policy', () => {
    for (const teamId of ['xiaohongshu', 'douyin', 'content', 'social-three-lanes']) {
      const profile = CONTENT_STUDIO_PROFILES[teamId];
      expect(profile.templateName.length).toBeGreaterThan(0);
      expect(profile.stages.length).toBeGreaterThanOrEqual(6);
      expect(profile.stages.some(stage => stage.agentRole === 'ops')).toBe(true);
    }
  });

  it('detects a generic pipeline publish gate before approval', () => {
    expect(hasPublishStageAhead({
      currentStageIndex: 0,
      stages: [
        { agentRole: 'wechat-writer' },
        {
          agentRole: 'social-publisher',
          publishTools: ['mcp__wechat-official-account__wechat_publish'],
        },
      ],
    })).toBe(true);
  });
});

// ─── Permissions ─────────────────────────────────────────────────────────────

describe('permissions', () => {
  it('runtimeControlsAllowed returns true when diagnostics is null', () => {
    expect(runtimeControlsAllowed(null)).toBe(true);
  });

  it('taskDeleteAllowed returns true when diagnostics is null', () => {
    expect(taskDeleteAllowed(null)).toBe(true);
  });

  it('operatorRoleLabel returns unknown when diagnostics is null', () => {
    expect(operatorRoleLabel(null)).toBe('unknown operator');
  });

  it('readOnlyControlMessage is a non-empty string', () => {
    expect(readOnlyControlMessage.length).toBeGreaterThan(0);
  });
});

// ─── Notification Triage ─────────────────────────────────────────────────────

describe('notificationTriage', () => {
  const makeNotification = (overrides: any = {}) => ({
    id: '1',
    type: 'task_complete' as const,
    title: 'Test',
    message: 'msg',
    read: false,
    createdAt: '2024-01-01T00:00:00Z',
    taskId: 't1',
    ...overrides,
  });

  it('defaultNotificationFilters has expected defaults', () => {
    expect(defaultNotificationFilters.query).toBe('');
    expect(defaultNotificationFilters.status).toBe('unread');
    expect(defaultNotificationFilters.scope).toBe('all');
    expect(defaultNotificationFilters.type).toBe('all');
  });

  it('notificationTypeLabels has all types', () => {
    expect(Object.keys(notificationTypeLabels)).toHaveLength(5);
    expect(notificationTypeLabels.task_complete).toBe('Task complete');
  });

  it('filterNotifications returns unread by default filters', () => {
    const n1 = makeNotification({ read: false });
    const n2 = makeNotification({ id: '2', read: true });
    const result = filterNotifications([n1, n2], defaultNotificationFilters);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('filterNotifications filters by type', () => {
    const n1 = makeNotification({ type: 'task_complete' });
    const n2 = makeNotification({ id: '2', type: 'task_failed' });
    const result = filterNotifications([n1, n2], { ...defaultNotificationFilters, status: 'all', type: 'task_failed' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });

  it('filterNotifications filters by query', () => {
    const n1 = makeNotification({ title: 'Deploy finished' });
    const n2 = makeNotification({ id: '2', title: 'Build started' });
    const result = filterNotifications([n1, n2], { ...defaultNotificationFilters, status: 'all', query: 'deploy' });
    expect(result).toHaveLength(1);
  });

  it('notificationScope returns correct scope', () => {
    expect(notificationScope(makeNotification({ type: 'needs_input' }))).toBe('inbox');
    expect(notificationScope(makeNotification({ pipelineId: 'p1', taskId: undefined }))).toBe('pipelines');
    expect(notificationScope(makeNotification({ taskId: 't1' }))).toBe('tasks');
  });

  it('buildNotificationGroups groups correctly', () => {
    const notifications = [
      makeNotification({ type: 'task_failed' }),
      makeNotification({ id: '2', type: 'task_complete' }),
      makeNotification({ id: '3', type: 'needs_input' }),
    ];
    const groups = buildNotificationGroups(notifications);
    expect(groups.length).toBeGreaterThanOrEqual(3);
    expect(groups.find(g => g.id === 'failures')?.notifications).toHaveLength(1);
  });

  it('notificationTarget returns correct targets', () => {
    expect(notificationTarget(makeNotification({ type: 'needs_input' }))).toEqual({ kind: 'inbox' });
    expect(notificationTarget(makeNotification({ taskId: 't1' }))).toEqual({ kind: 'task', taskId: 't1' });
  });
});

// ─── Saved Views ─────────────────────────────────────────────────────────────

describe('savedViews', () => {
  it('createSavedView creates a view with id and timestamp', () => {
    const view = createSavedView('My View', { status: 'active' });
    expect(view.name).toBe('My View');
    expect(view.id).toMatch(/^view_/);
    expect(view.filters).toEqual({ status: 'active' });
    expect(view.createdAt).toBeTruthy();
  });

  it('savedViewScope returns unknown when diagnostics is null', () => {
    expect(savedViewScope(null)).toBe('unknown');
  });
});

// ─── Activity Summary ────────────────────────────────────────────────────────

describe('activitySummary', () => {
  it('buildActivitySummary returns empty summary for empty input', () => {
    const summary = buildActivitySummary({
      diagnostics: null,
      tasks: [],
      inboxEntries: [],
      pipelines: [],
      platformEvents: [],
      operatorActions: [],
    });
    expect(summary.failedWork).toHaveLength(0);
    expect(summary.pendingDecisions).toHaveLength(0);
    expect(summary.blockedPipelines).toHaveLength(0);
  });

  it('buildActivitySummary filters by checkpoint', () => {
    const summary = buildActivitySummary({
      diagnostics: null,
      checkpoint: '2024-06-01T00:00:00Z',
      tasks: [
        { id: '1', status: 'failed', createdAt: '2024-05-01T00:00:00Z' } as any,
        { id: '2', status: 'failed', createdAt: '2024-07-01T00:00:00Z' } as any,
      ],
      inboxEntries: [],
      pipelines: [],
      platformEvents: [],
      operatorActions: [],
    });
    expect(summary.failedWork).toHaveLength(1);
    expect(summary.failedWork[0].id).toBe('2');
  });

  it('handoffTotal sums all categories', () => {
    const summary = {
      failedWork: [1, 2] as any,
      pendingDecisions: [1] as any,
      blockedPipelines: [] as any,
      newEvents: [1, 2, 3] as any,
      recentLaunches: [1] as any,
      operatorActions: [],
    };
    expect(handoffTotal(summary)).toBe(7);
  });
});
