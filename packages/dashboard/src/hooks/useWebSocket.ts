import { useEffect } from 'react';
import { wsClient } from '../lib/ws';
import { useStore } from '../stores/store';
import { api } from '../lib/api';
import type { ExecutionEventPayload, InboxEventPayload, PipelineEventPayload, QualityLoopEventPayload, TaskEventPayload, WSEvent } from '@agent-factory/shared';

export function useWebSocket() {
  useEffect(() => {
    const store = useStore.getState();

    wsClient.connect();
    wsClient.subscribe('tasks');
    wsClient.subscribe('agents');
    wsClient.subscribe('pipelines');
    wsClient.subscribe('notifications');
    wsClient.subscribe('executions');
    wsClient.subscribe('inbox');
    wsClient.subscribe('quality');
    wsClient.subscribe('tools');
    wsClient.subscribe('skills');

    const refreshTask = async (taskId?: string) => {
      if (!taskId) return;
      try {
        store.upsertTask(await api.tasks.get(taskId));
      } catch (err) {
        console.warn('[WS] Failed to refresh task', taskId, err);
      }
    };
    const refreshObservability = () => {
      void store.loadPlatformEvents();
      void store.loadObservability();
      void store.loadOperatorActions();
    };

    const onTaskCreated = (event: WSEvent<TaskEventPayload>) => {
      if (event.payload.task) store.upsertTask(event.payload.task);
      else void refreshTask(event.payload.taskId);
      refreshObservability();
    };
    const onTaskUpdated = (event: WSEvent<TaskEventPayload>) => {
      if (event.payload.task) store.upsertTask(event.payload.task);
      else void refreshTask(event.payload.taskId);
      void store.loadAgents();
      void store.loadExecutions();
      refreshObservability();
    };
    const onTaskAssigned = (event: WSEvent<TaskEventPayload>) => {
      store.patchTask(event.payload.taskId, { status: 'assigned', assigneeId: event.payload.agentId });
      void store.loadAgents();
      void refreshTask(event.payload.taskId);
      refreshObservability();
    };
    const onTaskStarted = (event: WSEvent<TaskEventPayload>) => {
      store.patchTask(event.payload.taskId, { status: 'running', assigneeId: event.payload.agentId });
      void store.loadAgents();
      void store.loadExecutions();
      void refreshTask(event.payload.taskId);
      refreshObservability();
    };
    const onTaskDone = (event: WSEvent<TaskEventPayload>) => {
      store.patchTask(event.payload.taskId, { status: 'done', output: event.payload.output });
      void store.loadAgents();
      void store.loadExecutions();
      void refreshTask(event.payload.taskId);
      refreshObservability();
    };
    const onTaskFailed = (event: WSEvent<TaskEventPayload>) => {
      store.patchTask(event.payload.taskId, { status: 'failed', error: event.payload.error });
      void store.loadAgents();
      void store.loadExecutions();
      void refreshTask(event.payload.taskId);
      refreshObservability();
    };
    const onTaskCancelled = (event: WSEvent<TaskEventPayload>) => {
      if (event.payload.task) store.upsertTask(event.payload.task);
      else store.patchTask(event.payload.taskId, { status: 'cancelled' });
      void store.loadAgents();
      void store.loadExecutions();
      refreshObservability();
    };
    const onExecutionEvent = (event: WSEvent<ExecutionEventPayload>) => {
      void store.loadExecutions();
      if (event.payload.executionId) void store.loadExecutionMessages(event.payload.executionId);
      if (event.payload.taskId) void refreshTask(event.payload.taskId);
      void store.loadAgents();
    };
    const onPipelineEvent = (_event: WSEvent<PipelineEventPayload>) => {
      void store.loadPipelines();
      refreshObservability();
    };
    const onNotification = () => {
      void store.loadNotifications();
    };
    const onInboxEvent = (event: WSEvent<InboxEventPayload>) => {
      if (event.payload.entry) store.upsertInboxEntry(event.payload.entry);
      else void store.loadInboxEntries();
      void store.loadNotifications();
      void store.loadOperatorActions();
    };
    const onQualityEvent = (event: WSEvent<QualityLoopEventPayload>) => {
      if (event.payload.attempt) store.upsertQualityLoopAttempt(event.payload.taskId, event.payload.attempt);
      else void store.loadQualityLoopAttempts(event.payload.taskId);
      refreshObservability();
    };
    const onAgentStatus = () => {
      void store.loadAgents();
    };
    const onToolEvent = () => {
      void store.loadTools();
      void store.loadToolExecutions();
      refreshObservability();
    };
    const onSkillEvent = () => {
      void store.loadSkills();
      void store.loadSkillAssignments();
      void store.loadAgents();
      refreshObservability();
    };

    wsClient.on('task:created', onTaskCreated as (event: WSEvent) => void);
    wsClient.on('task:updated', onTaskUpdated as (event: WSEvent) => void);
    wsClient.on('task:started', onTaskStarted as (event: WSEvent) => void);
    wsClient.on('task:done', onTaskDone as (event: WSEvent) => void);
    wsClient.on('task:failed', onTaskFailed as (event: WSEvent) => void);
    wsClient.on('task:cancelled', onTaskCancelled as (event: WSEvent) => void);
    wsClient.on('task:assigned', onTaskAssigned as (event: WSEvent) => void);
    wsClient.on('agent:status', onAgentStatus);
    wsClient.on('execution:started', onExecutionEvent as (event: WSEvent) => void);
    wsClient.on('execution:message', onExecutionEvent as (event: WSEvent) => void);
    wsClient.on('execution:done', onExecutionEvent as (event: WSEvent) => void);
    wsClient.on('execution:failed', onExecutionEvent as (event: WSEvent) => void);
    wsClient.on('pipeline:stage:started', onPipelineEvent as (event: WSEvent) => void);
    wsClient.on('pipeline:stage:done', onPipelineEvent as (event: WSEvent) => void);
    wsClient.on('pipeline:done', onPipelineEvent as (event: WSEvent) => void);
    wsClient.on('pipeline:failed', onPipelineEvent as (event: WSEvent) => void);
    wsClient.on('notification', onNotification);
    wsClient.on('inbox:created', onInboxEvent as (event: WSEvent) => void);
    wsClient.on('inbox:updated', onInboxEvent as (event: WSEvent) => void);
    wsClient.on('quality:updated', onQualityEvent as (event: WSEvent) => void);
    wsClient.on('tool:started', onToolEvent);
    wsClient.on('tool:done', onToolEvent);
    wsClient.on('tool:failed', onToolEvent);
    wsClient.on('tool:blocked', onToolEvent);
    wsClient.on('tool:updated', onToolEvent);
    wsClient.on('skill:updated', onSkillEvent);
    wsClient.on('skill:published', onSkillEvent);
    wsClient.on('skill:assigned', onSkillEvent);

    return () => {
      wsClient.off('task:created', onTaskCreated as (event: WSEvent) => void);
      wsClient.off('task:updated', onTaskUpdated as (event: WSEvent) => void);
      wsClient.off('task:started', onTaskStarted as (event: WSEvent) => void);
      wsClient.off('task:done', onTaskDone as (event: WSEvent) => void);
      wsClient.off('task:failed', onTaskFailed as (event: WSEvent) => void);
      wsClient.off('task:cancelled', onTaskCancelled as (event: WSEvent) => void);
      wsClient.off('task:assigned', onTaskAssigned as (event: WSEvent) => void);
      wsClient.off('agent:status', onAgentStatus);
      wsClient.off('execution:started', onExecutionEvent as (event: WSEvent) => void);
      wsClient.off('execution:message', onExecutionEvent as (event: WSEvent) => void);
      wsClient.off('execution:done', onExecutionEvent as (event: WSEvent) => void);
      wsClient.off('execution:failed', onExecutionEvent as (event: WSEvent) => void);
      wsClient.off('pipeline:stage:started', onPipelineEvent as (event: WSEvent) => void);
      wsClient.off('pipeline:stage:done', onPipelineEvent as (event: WSEvent) => void);
      wsClient.off('pipeline:done', onPipelineEvent as (event: WSEvent) => void);
      wsClient.off('pipeline:failed', onPipelineEvent as (event: WSEvent) => void);
      wsClient.off('notification', onNotification);
      wsClient.off('inbox:created', onInboxEvent as (event: WSEvent) => void);
      wsClient.off('inbox:updated', onInboxEvent as (event: WSEvent) => void);
      wsClient.off('quality:updated', onQualityEvent as (event: WSEvent) => void);
      wsClient.off('tool:started', onToolEvent);
      wsClient.off('tool:done', onToolEvent);
      wsClient.off('tool:failed', onToolEvent);
      wsClient.off('tool:blocked', onToolEvent);
      wsClient.off('tool:updated', onToolEvent);
      wsClient.off('skill:updated', onSkillEvent);
      wsClient.off('skill:published', onSkillEvent);
      wsClient.off('skill:assigned', onSkillEvent);
      wsClient.disconnect();
    };
  }, []);
}
