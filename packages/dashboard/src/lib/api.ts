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
  PipelineTemplateGalleryItem,
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
  DynamicWorkflowRun,
  DynamicWorkflowPlan,
} from '@myrmecia/shared';
import { getApiAuthToken } from './auth';

const BASE = '/api/v1';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = getApiAuthToken();
  const maxRetries = opts?.method && opts.method !== 'GET' ? 0 : 1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
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
      return await res.json();
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

export const api = {
  /** Generic GET for any path (relative to /api/v1 if starts with /, or absolute) */
  get: <T = any>(path: string) => request<T>(path.startsWith('/api/') ? path.replace('/api/v1', '') : path),
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
    stats: () => request<any[]>('/skills/stats'),
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
    registry: {
      sources: () => request<any[]>('/skills/registry/sources'),
      addSource: (data: { name: string; type: string; url: string; branch?: string; pathPrefix?: string; authToken?: string }) =>
        request<any>('/skills/registry/sources', { method: 'POST', body: JSON.stringify(data) }),
      deleteSource: (id: string) =>
        request<any>(`/skills/registry/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      sync: (sourceId: string) =>
        request<{ added: number; updated: number }>(`/skills/registry/sources/${encodeURIComponent(sourceId)}/sync`, { method: 'POST' }),
      browse: (params?: { search?: string; sourceId?: string; structured?: string }) =>
        request<any[]>(`/skills/registry/browse${params ? '?' + new URLSearchParams(params as any) : ''}`),
      import: (catalogId: string, transform?: boolean) =>
        request<{ skillId: string; versionId: string }>('/skills/registry/import', { method: 'POST', body: JSON.stringify({ catalogId, transform }) }),
    },
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
    create: (data: { name: string; templateId: string; input: string; gateMode?: Pipeline['gateMode']; domainId?: string }) =>
      request<Pipeline>('/pipelines', { method: 'POST', body: JSON.stringify(data) }),
    approve: (id: string) => request<{ success: boolean }>(`/pipelines/${id}/approve`, { method: 'POST' }),
    skip: (id: string) => request<{ success: boolean }>(`/pipelines/${id}/skip`, { method: 'POST' }),
    cancel: (id: string, confirmed = false) =>
      request<{ success: boolean }>(`/pipelines/${id}/cancel`, { method: 'POST', body: JSON.stringify({ confirm: confirmed }) }),
  },
  templates: {
    list: () => request<PipelineTemplate[]>('/templates'),
    gallery: () => request<PipelineTemplateGalleryItem[]>('/templates/gallery'),
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
    workflows: {
      list: () => request<DynamicWorkflowRun[]>('/supervisor/workflows'),
      get: (id: string) => request<DynamicWorkflowRun & { tasks?: Task[] }>(`/supervisor/workflows/${id}`),
      create: (data: { goal: string; plan?: DynamicWorkflowPlan }) =>
        request<DynamicWorkflowRun>('/supervisor/workflows', { method: 'POST', body: JSON.stringify(data) }),
      preview: (data: { goal?: string; plan?: DynamicWorkflowPlan }) =>
        request<{ plan: DynamicWorkflowPlan }>('/supervisor/workflows/preview', { method: 'POST', body: JSON.stringify(data) }),
      cancel: (id: string) => request<DynamicWorkflowRun>(`/supervisor/workflows/${id}/cancel`, { method: 'POST' }),
      controlStep: (id: string, stepId: string, data: { action: 'rerun' | 'skip' | 'replace_agent' | 'force_unblock'; agentId?: string; reason?: string }) =>
        request<DynamicWorkflowRun>(`/supervisor/workflows/${id}/steps/${encodeURIComponent(stepId)}/control`, { method: 'POST', body: JSON.stringify(data) }),
    },
  },
  executionAudit: {
    get: (executionId: string) => request<{
      executionId: string;
      taskId: string;
      agentId: string;
      workspaceId: string;
      policySnapshot: Record<string, unknown>;
      events: { type: string; severity: 'info' | 'warn' | 'block' | 'error'; message: string; metadata?: Record<string, unknown>; createdAt?: string }[];
      createdAt: string;
      updatedAt: string;
    }>(`/execution-audit/${encodeURIComponent(executionId)}`),
  },
  knowledge: {
    documents: () => request<unknown[]>('/knowledge/documents'),
    upload: (data: { title: string; content: string; metadata?: Record<string, unknown> }) =>
      request<unknown>('/knowledge/documents', { method: 'POST', body: JSON.stringify(data) }),
    search: (query: string, topK?: number) =>
      request<unknown[]>('/knowledge/search', { method: 'POST', body: JSON.stringify({ query, topK }) }),
  },
  audit: {
    list: (params?: Record<string, string>) =>
      request<unknown[]>(`/audit${params ? '?' + new URLSearchParams(params) : ''}`),
    verify: () => request<{ valid: boolean; entriesChecked: number; brokenAt?: string }>('/audit/verify'),
    dlpScan: (content: string) =>
      request<unknown>('/audit/dlp-scan', { method: 'POST', body: JSON.stringify({ content }) }),
  },
  plugins: {
    list: (status?: string) =>
      request<unknown[]>(`/plugins${status ? '?status=' + status : ''}`),
    install: (manifest: unknown, sourceUrl?: string) =>
      request<unknown>('/plugins/install', { method: 'POST', body: JSON.stringify({ manifest, sourceUrl }) }),
    enable: (pluginId: string) =>
      request<unknown>(`/plugins/${pluginId}/enable`, { method: 'POST' }),
    disable: (pluginId: string) =>
      request<unknown>(`/plugins/${pluginId}/disable`, { method: 'POST' }),
    uninstall: (pluginId: string) =>
      request<unknown>(`/plugins/${pluginId}`, { method: 'DELETE' }),
  },
  billing: {
    report: (params?: Record<string, string>) =>
      request<unknown>(`/billing/report${params ? '?' + new URLSearchParams(params) : ''}`),
    quota: () => request<unknown>('/billing/quota'),
    setQuota: (data: unknown) =>
      request<unknown>('/billing/quota', { method: 'PUT', body: JSON.stringify(data) }),
  },
  usage: {
    summary: (params?: Record<string, string>) =>
      request<unknown>(`/usage/summary${params ? '?' + new URLSearchParams(params) : ''}`),
    byAgent: (since?: string) =>
      request<unknown[]>(`/usage/by-agent${since ? '?since=' + since : ''}`),
    byModel: (since?: string) =>
      request<unknown[]>(`/usage/by-model${since ? '?since=' + since : ''}`),
    budget: () => request<unknown>('/usage/budget'),
    setBudget: (data: unknown) =>
      request<unknown>('/usage/budget', { method: 'PUT', body: JSON.stringify(data) }),
  },
  apiKeys: {
    list: () => request<unknown[]>('/api-keys'),
    create: (data: { name: string; scopes?: string[]; expiresInDays?: number }) =>
      request<unknown>('/api-keys', { method: 'POST', body: JSON.stringify(data) }),
    revoke: (id: string) =>
      request<unknown>(`/api-keys/${id}`, { method: 'DELETE' }),
    rotate: (id: string) =>
      request<unknown>(`/api-keys/${id}/rotate`, { method: 'POST' }),
  },
  releases: {
    list: () => request<unknown[]>('/releases'),
    create: (data: { version: string; changelog?: string }) =>
      request<unknown>('/releases', { method: 'POST', body: JSON.stringify(data) }),
    promote: (id: string) =>
      request<unknown>(`/releases/${id}/promote`, { method: 'POST' }),
    rollback: (id: string) =>
      request<unknown>(`/releases/${id}/rollback`, { method: 'POST' }),
  },
  eval: {
    experiments: () => request<unknown[]>('/eval/experiments'),
    createExperiment: (data: unknown) =>
      request<unknown>('/eval/experiments', { method: 'POST', body: JSON.stringify(data) }),
    results: (experimentId: string) =>
      request<unknown[]>(`/eval/experiments/${experimentId}/results`),
  },
  notificationChannels: {
    list: () => request<unknown[]>('/notification-channels'),
    create: (data: unknown) =>
      request<unknown>('/notification-channels', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: unknown) =>
      request<unknown>(`/notification-channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<unknown>(`/notification-channels/${id}`, { method: 'DELETE' }),
  },
  artifacts: {
    list: () => request<Array<{ id: string; ownerId: string; name: string; expiresAt: string; createdAt: string }>>('/artifacts'),
    get: (id: string) => request<{ id: string; ownerId: string; name: string; content: string; expiresAt: string; createdAt: string }>(`/artifacts/${id}`),
  },
  memory: {
    list: (params?: { type?: string; limit?: number }) =>
      request<MemoryItemDTO[]>(`/memory${params ? '?' + new URLSearchParams(params as any) : ''}`),
    stats: () => request<{ counts: Record<string, number>; total: number }>('/memory/stats'),
    recall: (query: string, types?: string[], topK?: number) =>
      request<ScoredMemoryDTO[]>('/memory/recall', { method: 'POST', body: JSON.stringify({ query, types, topK }) }),
    add: (content: string, opts?: { type?: string; importance?: number; summary?: string }) =>
      request<MemoryItemDTO>('/memory', { method: 'POST', body: JSON.stringify({ content, ...opts }) }),
    remove: (id: string) => request<{ ok: boolean; id: string }>(`/memory/${id}`, { method: 'DELETE' }),
  },
  graphWorkflows: {
    list: () => request<GraphWorkflowDTO[]>('/graph-workflows'),
    get: (id: string) => request<GraphWorkflowDTO>(`/graph-workflows/${id}`),
    create: (data: { name: string; description?: string; graph?: GraphDefDTO; input?: string }) =>
      request<GraphWorkflowDTO>('/graph-workflows', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name?: string; description?: string; graph?: GraphDefDTO; input?: string }) =>
      request<GraphWorkflowDTO>(`/graph-workflows/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: string) => request<{ ok: boolean }>(`/graph-workflows/${id}`, { method: 'DELETE' }),
    run: (id: string, input?: string) => request<GraphWorkflowDTO>(`/graph-workflows/${id}/run`, { method: 'POST', body: JSON.stringify({ input }) }),
    replay: (id: string, input?: string) => request<GraphWorkflowDTO>(`/graph-workflows/${id}/replay`, { method: 'POST', body: JSON.stringify({ input }) }),
    resume: (id: string) => request<GraphWorkflowDTO>(`/graph-workflows/${id}/resume`, { method: 'POST' }),
    cancel: (id: string) => request<GraphWorkflowDTO>(`/graph-workflows/${id}/cancel`, { method: 'POST' }),
    events: (id: string, runId?: string) =>
      request<Array<{ nodeId?: string; type: string; data: any; createdAt: string }>>(`/graph-workflows/${id}/events${runId ? `?runId=${runId}` : ''}`),
  },
  teams: {
    list: () => request<{ teams: TeamDTO[] }>('/teams').then(r => r.teams),
    get: (id: string) => request<TeamDTO>(`/teams/${id}`),
    create: (data: TeamInputDTO) =>
      request<TeamDTO>('/teams', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<TeamInputDTO>) =>
      request<TeamDTO>(`/teams/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: string) => request<{ ok: boolean; reverted: boolean }>(`/teams/${id}`, { method: 'DELETE' }),
    dispatch: (id: string, goal: string) =>
      request<{ run: TeamRunDTO; team: TeamDTO; board: TeamBoardItem[] }>(`/teams/${id}/dispatch`, { method: 'POST', body: JSON.stringify({ goal }) }),
    runs: (teamId?: string) =>
      request<{ runs: TeamRunDTO[] }>(`/teams/runs${teamId ? `?teamId=${teamId}` : ''}`).then(r => r.runs),
    run: (runId: string) => request<{ run: TeamRunDTO; board: TeamBoardItem[] }>(`/teams/runs/${runId}`),
    message: (runId: string, data: { to: string; content: string; redirect?: boolean }) =>
      request<{ delivered: { taskId: string; agentId: string | null; live: boolean }[]; redirected: string[] }>(
        `/teams/runs/${runId}/message`, { method: 'POST', body: JSON.stringify(data) }),
  },
  domains: {
    list: () => request<{ domains: DomainPackDTO[] }>('/domains').then(r => r.domains),
    get: (id: string) => request<DomainPackDTO>(`/domains/${id}`),
    create: (data: DomainPackInputDTO) =>
      request<DomainPackDTO>('/domains', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<DomainPackInputDTO>) =>
      request<DomainPackDTO>(`/domains/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: string) => request<{ ok: boolean; reverted: boolean }>(`/domains/${id}`, { method: 'DELETE' }),
    uploadKnowledge: (id: string, data: { title: string; content: string }) =>
      request<{ document: { id: string; title: string; chunkCount: number }; domain: DomainPackDTO }>(
        `/domains/${id}/knowledge`, { method: 'POST', body: JSON.stringify(data) }),
    usage: () => request<{ usage: Record<string, DomainUsageDTO> }>('/domains/usage').then(r => r.usage),
  },
};

export interface TeamInputDTO {
  id?: string; name: string; emoji?: string; lead?: string;
  members: string[]; template?: string; triggers?: string[]; blurb?: string;
}

export interface DomainRetrievalDTO { enabled: boolean; topK: number; minScore: number }
export interface DomainDocumentDTO { id: string; title: string; chunkCount: number }
export interface DomainPackDTO {
  id: string; name: string; emoji: string; persona: string;
  guidelines: string[]; terminology: Record<string, string>;
  disclaimer?: string; tone?: string;
  retrieval: DomainRetrievalDTO;
  knowledgeIds: string[]; agentIds: string[];
  workspaceId?: string; builtin?: boolean;
  documents?: DomainDocumentDTO[];
  createdAt?: string; updatedAt?: string;
}
export interface DomainPackInputDTO {
  id?: string; name: string; emoji?: string; persona: string;
  guidelines?: string[]; terminology?: Record<string, string>;
  disclaimer?: string; tone?: string;
  retrieval?: Partial<DomainRetrievalDTO>;
  knowledgeIds?: string[]; agentIds?: string[];
}
export interface DomainUsageDTO {
  taskCount: number; executionCount: number; costUSD: number; tokens: number;
}
export interface TeamRosterMember { role: string; agentId: string; name: string }
export interface TeamDTO {
  id: string; name: string; emoji: string; lead: string;
  members: string[]; template?: string; triggers: string[]; blurb: string;
  builtin?: boolean;
  roster?: TeamRosterMember[];
}
export interface TeamRunDTO {
  id: string; teamId: string; goal: string;
  status: 'planning' | 'running' | 'done' | 'failed';
  parentTaskId?: string; result?: string; workspaceId: string;
  createdAt: string; completedAt?: string;
}
export interface TeamBoardItem {
  taskId: string; title: string; role: string | null; assigneeId: string | null;
  status: string; dependsOn: string[]; output?: string;
}

export interface GraphNodeDTO {
  id: string;
  label?: string;
  agentId?: string;
  agentRole?: string;
  prompt?: string;
  position?: { x: number; y: number };
}
export interface GraphEdgeDTO { id: string; source: string; target: string }
export interface GraphDefDTO { nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] }
export interface GraphNodeStateDTO {
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  taskId?: string;
  agentId?: string;
  output?: string;
  error?: string;
}
export interface GraphWorkflowDTO {
  id: string;
  name: string;
  description?: string;
  workspaceId?: string;
  graph: GraphDefDTO;
  status: 'draft' | 'running' | 'done' | 'failed' | 'cancelled';
  input?: string;
  runState?: { runId: string; input: string; nodes: Record<string, GraphNodeStateDTO>; startedAt: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MemoryItemDTO {
  id: string;
  type: 'working' | 'episodic' | 'semantic' | 'procedural';
  scope: Record<string, string | undefined>;
  content: string;
  summary?: string;
  importance: number;
  success?: number;
  quality?: number;
  sourceType?: string;
  createdAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  metadata: Record<string, unknown>;
}

export interface ScoredMemoryDTO {
  item: MemoryItemDTO;
  score: number;
  relevance: number;
}
