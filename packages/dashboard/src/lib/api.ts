import type {
  AgentSummary,
  ExecutionMessage,
  HealthSummary,
  InboxEntry,
  InboxEntryStatus,
  InboxEntryType,
  LogEntry,
  ModelDefinition,
  ModelRoute,
  Notification,
  ObservabilitySummary,
  OperatorAction,
  OperatorPreference,
  Pipeline,
  PipelineTemplate,
  PipelineTemplateValidationResult,
  PlatformEvent,
  QualityLoopAttempt,
  RuntimeDiagnostics,
  RunTrace,
  SkillAssignment,
  SkillDefinition,
  SkillDetail,
  SkillVersion,
  Task,
  TaskExecution,
  ToolDefinition,
  ToolExecution,
  ToolPermission,
  WorkspaceSnapshot,
  WorkspaceSnapshotPreview,
  WorkspaceRestorePlan,
  WorkspacePreferenceRestoreResult,
} from '@agent-factory/shared';
import { getApiAuthToken } from './auth';

const BASE = '/api';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = getApiAuthToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts?.headers,
    },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(err.error?.message || res.statusText);
  }
  return res.json();
}

export const api = {
  tasks: {
    list: (params?: Record<string, string>) =>
      request<Task[]>(`/tasks${params ? '?' + new URLSearchParams(params) : ''}`),
    get: (id: string) => request<Task>(`/tasks/${id}`),
    create: (data: Partial<Task> & { title: string; mode: Task['mode']; input?: string }) =>
      request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Task>) => request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    cancel: (id: string, confirmed = false) =>
      request<Task>(`/tasks/${id}/cancel`, { method: 'POST', body: JSON.stringify({ confirm: confirmed }) }),
    retry: (id: string) => request<Task>(`/tasks/${id}/retry`, { method: 'POST' }),
    delete: (id: string, confirmed = false) =>
      request<{ success: boolean }>(`/tasks/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm: confirmed }) }),
    logs: (id: string) => request<LogEntry[]>(`/tasks/${id}/logs`),
    qualityAttempts: (id: string) => request<QualityLoopAttempt[]>(`/tasks/${id}/quality-attempts`),
  },
  agents: {
    list: () => request<AgentSummary[]>('/agents'),
    get: (id: string) => request<AgentSummary>(`/agents/${id}`),
    create: (data: Partial<AgentSummary> & { name: string; role: string }) =>
      request<AgentSummary>('/agents', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<AgentSummary>) =>
      request<AgentSummary>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    // New: execute creates a task execution instance
    execute: (id: string, data: { prompt: string; workdir?: string; parentExecutionId?: string }) =>
      request<{ taskId: string; status: string }>(`/agents/${id}/execute`, { method: 'POST', body: JSON.stringify(data) }),
    // Get execution history for an agent
    executions: (id: string) => request<TaskExecution[]>(`/agents/${id}/executions`),
    // Legacy
    start: (id: string) => request<{ success: boolean; message: string }>(`/agents/${id}/start`, { method: 'POST' }),
    stop: (id: string) => request<{ success: boolean; message: string }>(`/agents/${id}/stop`, { method: 'POST' }),
  },
  tools: {
    list: (params?: { enabled?: string; category?: string }) =>
      request<ToolDefinition[]>(`/tools${params ? '?' + new URLSearchParams(params) : ''}`),
    get: (id: string) => request<ToolDefinition & { permissions: ToolPermission[]; recentExecutions: ToolExecution[] }>(`/tools/${id}`),
    update: (id: string, data: { enabled?: boolean; approvalRequired?: boolean }) =>
      request<ToolDefinition>(`/tools/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    executions: (params?: { toolId?: string; taskId?: string; executionId?: string; agentId?: string; status?: string; limit?: string }) =>
      request<ToolExecution[]>(`/tools/executions${params ? '?' + new URLSearchParams(params) : ''}`),
    setPermission: (toolId: string, agentId: string, data: { enabled: boolean; approvalRequired?: boolean }) =>
      request<ToolPermission>(`/tools/${toolId}/permissions/${agentId}`, { method: 'PUT', body: JSON.stringify(data) }),
  },
  models: {
    list: (params?: { enabled?: string }) =>
      request<ModelDefinition[]>(`/models${params ? '?' + new URLSearchParams(params) : ''}`),
    routes: () => request<ModelRoute[]>('/models/routes'),
    updateRoute: (data: { routeKey: string; defaultModelId?: string; fallbackGroup?: string }) =>
      request<ModelRoute>('/models/routes', { method: 'PATCH', body: JSON.stringify(data) }),
    update: (id: string, data: { enabled?: boolean; priority?: number; fallbackGroup?: string }) =>
      request<ModelDefinition>(`/models/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    healthCheck: (id: string) =>
      request<ModelDefinition>(`/models/${encodeURIComponent(id)}/health-check`, { method: 'POST' }),
  },
  skills: {
    list: () => request<SkillDefinition[]>('/skills'),
    get: (id: string) => request<SkillDetail>(`/skills/${encodeURIComponent(id)}`),
    assignments: () => request<SkillAssignment[]>('/skills/assignments'),
    create: (data: { id?: string; name: string; description?: string; sourcePath?: string }) =>
      request<SkillDefinition>('/skills', { method: 'POST', body: JSON.stringify(data) }),
    createVersion: (skillId: string, data: { content: string; changelog?: string; status?: 'draft' | 'published' }) =>
      request<SkillVersion>(`/skills/${encodeURIComponent(skillId)}/versions`, { method: 'POST', body: JSON.stringify(data) }),
    updateVersion: (versionId: string, data: { content?: string; changelog?: string }) =>
      request<SkillVersion>(`/skills/versions/${encodeURIComponent(versionId)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    publishVersion: (versionId: string) =>
      request<SkillVersion>(`/skills/versions/${encodeURIComponent(versionId)}/publish`, { method: 'POST' }),
    archiveVersion: (versionId: string) =>
      request<SkillVersion>(`/skills/versions/${encodeURIComponent(versionId)}/archive`, { method: 'POST' }),
    assign: (agentId: string, skillVersionId: string) =>
      request<SkillAssignment>(`/skills/assignments/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        body: JSON.stringify({ skillVersionId }),
      }),
  },
  executions: {
    list: (params?: Record<string, string>) =>
      request<TaskExecution[]>(`/executions${params ? '?' + new URLSearchParams(params) : ''}`),
    get: (id: string) => request<TaskExecution>(`/executions/${id}`),
    messages: (id: string, afterId?: number) =>
      request<ExecutionMessage[]>(`/executions/${id}/messages${afterId ? `?afterId=${afterId}` : ''}`),
    trace: (id: string) => request<RunTrace | null>(`/executions/${id}/trace`),
    cancel: (id: string) => request<{ ok: boolean }>(`/executions/${id}/cancel`, { method: 'POST' }),
    sendMessage: (id: string, content: string, messageType = 'text') =>
      request<unknown>(`/executions/${id}/message`, { method: 'POST', body: JSON.stringify({ content, messageType }) }),
  },
  pipelines: {
    list: () => request<Pipeline[]>('/pipelines'),
    get: (id: string) => request<Pipeline>(`/pipelines/${id}`),
    create: (data: { name: string; templateId: string; input: string; gateMode?: Pipeline['gateMode'] }) =>
      request<Pipeline>('/pipelines', { method: 'POST', body: JSON.stringify(data) }),
    approve: (id: string) => request<{ success: boolean }>(`/pipelines/${id}/approve`, { method: 'POST' }),
    skip: (id: string) => request<{ success: boolean }>(`/pipelines/${id}/skip`, { method: 'POST' }),
    cancel: (id: string, confirmed = false) =>
      request<{ success: boolean }>(`/pipelines/${id}/cancel`, { method: 'POST', body: JSON.stringify({ confirm: confirmed }) }),
  },
  templates: {
    list: () => request<PipelineTemplate[]>('/templates'),
    get: (id: string) => request<PipelineTemplate>(`/templates/${id}`),
    create: (data: { name: string; description?: string; stages: PipelineTemplate['stages'] }) =>
      request<PipelineTemplate>('/templates', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<{ name: string; description?: string; stages: PipelineTemplate['stages'] }>) =>
      request<PipelineTemplate>(`/templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    validate: (id: string) =>
      request<PipelineTemplateValidationResult>(`/templates/${id}/validate`, { method: 'POST' }),
    validateDraft: (data: { name: string; description?: string; stages: PipelineTemplate['stages'] }) =>
      request<PipelineTemplateValidationResult>('/templates/validate', { method: 'POST', body: JSON.stringify(data) }),
  },
  health: () => request<HealthSummary>('/health'),
  stats: () => request<{ totalTasks: number; completedTasks: number; failedTasks: number; runningTasks: number }>('/stats'),
  events: {
    list: (params?: { eventType?: string; severity?: string; taskId?: string; pipelineId?: string; limit?: string }) =>
      request<PlatformEvent[]>(`/events${params ? '?' + new URLSearchParams(params) : ''}`),
  },
  observability: () => request<ObservabilitySummary>('/observability'),
  diagnostics: () => request<RuntimeDiagnostics>('/diagnostics'),
  workspaceSnapshot: {
    export: () => request<WorkspaceSnapshot>('/workspace-snapshot'),
    preview: (snapshot: unknown) => request<WorkspaceSnapshotPreview>('/workspace-snapshot/preview', {
      method: 'POST',
      body: JSON.stringify(snapshot),
    }),
    restorePlan: (snapshot: unknown) => request<WorkspaceRestorePlan>('/workspace-snapshot/restore-plan', {
      method: 'POST',
      body: JSON.stringify(snapshot),
    }),
    restorePreferences: (snapshot: unknown, confirmed = false) => request<WorkspacePreferenceRestoreResult>('/workspace-snapshot/restore-preferences', {
      method: 'POST',
      body: JSON.stringify({ snapshot, confirm: confirmed }),
    }),
  },
  operatorActions: {
    list: (params?: { action?: string; actorId?: string; targetType?: string; taskId?: string; pipelineId?: string; inboxEntryId?: string; limit?: string }) =>
      request<OperatorAction[]>(`/operator-actions${params ? '?' + new URLSearchParams(params) : ''}`),
  },
  preferences: {
    list: (params?: { namespace?: string }) =>
      request<OperatorPreference[]>(`/operator-preferences${params ? '?' + new URLSearchParams(params) : ''}`),
    get: <TValue = unknown>(namespace: string, key: string) =>
      request<OperatorPreference<TValue>>(`/operator-preferences/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`),
    put: <TValue = unknown>(namespace: string, key: string, value: TValue) =>
      request<OperatorPreference<TValue>>(`/operator-preferences/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
    delete: (namespace: string, key: string) =>
      request<{ success: boolean }>(`/operator-preferences/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  },
  notifications: {
    list: () => request<Notification[]>('/notifications'),
    markRead: (id: string) => request<{ success: boolean }>(`/notifications/${id}/read`, { method: 'POST' }),
    markAllRead: () => request<{ success: boolean }>('/notifications/read-all', { method: 'POST' }),
  },
  inbox: {
    list: (params?: { status?: InboxEntryStatus }) =>
      request<InboxEntry[]>(`/inbox${params?.status ? '?' + new URLSearchParams({ status: params.status }) : ''}`),
    get: (id: string) => request<InboxEntry>(`/inbox/${id}`),
    create: (data: {
      type: InboxEntryType;
      title: string;
      message: string;
      options?: string[];
      taskId?: string;
      pipelineId?: string;
      executionId?: string;
      createdBy?: InboxEntry['createdBy'];
    }) => request<InboxEntry>('/inbox', { method: 'POST', body: JSON.stringify(data) }),
    respond: (id: string, data: { status: Exclude<InboxEntryStatus, 'pending'>; response?: string }) =>
      request<InboxEntry>(`/inbox/${id}/respond`, { method: 'POST', body: JSON.stringify(data) }),
  },
  supervisor: {
    dispatch: (input: string) => request<unknown>('/supervisor/dispatch', { method: 'POST', body: JSON.stringify({ input }) }),
    classify: (input: string) => request<unknown>('/supervisor/classify', { method: 'POST', body: JSON.stringify({ input }) }),
    guardrails: () => request<unknown>('/supervisor/guardrails'),
    updateGuardrails: (data: unknown) => request<unknown>('/supervisor/guardrails', { method: 'PATCH', body: JSON.stringify(data) }),
  },
};
