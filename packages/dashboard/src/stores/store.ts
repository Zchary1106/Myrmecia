import { create } from 'zustand';
import { api } from '../lib/api';
import type {
  AgentSummary,
  ExecutionMessage,
  HealthSummary,
  InboxEntry,
  ModelDefinition,
  ModelRoute,
  Notification,
  ObservabilitySummary,
  OperatorAction,
  Pipeline,
  PipelineTemplate,
  PlatformEvent,
  QualityLoopAttempt,
  RuntimeDiagnostics,
  SkillAssignment,
  SkillDefinition,
  Task,
  TaskExecution,
  ToolDefinition,
  ToolExecution,
} from '@agent-factory/shared';

export type DashboardView = 'command' | 'console' | 'agents' | 'tools' | 'models' | 'skills' | 'orchestrator' | 'board' | 'tasks' | 'timeline' | 'inbox' | 'observability' | 'audit' | 'settings' | 'cost';

// Legacy ChatMessage for backward compat
export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  agentId?: string;
  executionId?: string;
  status?: 'sending' | 'streaming' | 'done' | 'error';
  progress?: {
    type: 'reading' | 'searching' | 'thinking' | 'executing';
    detail?: string;
  }[];
}

interface AppStore {
  // View state
  activeView: DashboardView;
  setActiveView: (view: DashboardView) => void;

  // Agent selection & chat
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  chatMode: 'direct' | 'orchestrate';
  setChatMode: (mode: 'direct' | 'orchestrate') => void;
  agentChats: Record<string, ChatMessage[]>;
  addChatMessage: (agentId: string, message: ChatMessage) => void;
  updateChatMessage: (agentId: string, messageId: string, updates: Partial<ChatMessage>) => void;

  // Executions (new)
  executions: TaskExecution[];
  activeExecutions: Record<string, TaskExecution>;  // executionId → execution object
  executionMessages: Record<string, ExecutionMessage[]>;  // executionId → messages
  loadExecutions: () => Promise<void>;
  upsertExecution: (execution: TaskExecution) => void;
  addExecutionMessages: (executionId: string, messages: ExecutionMessage[]) => void;
  loadExecutionMessages: (executionId: string) => Promise<void>;

  // Right panel
  rightPanelTab: 'chat' | 'history';
  setRightPanelTab: (tab: 'chat' | 'history') => void;

  // Agents
  agents: AgentSummary[];
  loadAgents: () => Promise<void>;

  // Tool Runtime
  tools: ToolDefinition[];
  toolExecutions: ToolExecution[];
  loadTools: () => Promise<void>;
  loadToolExecutions: () => Promise<void>;

  // Model Registry
  models: ModelDefinition[];
  modelRoutes: ModelRoute[];
  loadModels: () => Promise<void>;
  loadModelRoutes: () => Promise<void>;

  // Skill Versioning
  skills: SkillDefinition[];
  skillAssignments: SkillAssignment[];
  loadSkills: () => Promise<void>;
  loadSkillAssignments: () => Promise<void>;

  // Tasks
  tasks: Task[];
  loadTasks: () => Promise<void>;
  upsertTask: (task: Task) => void;
  patchTask: (taskId: string, updates: Partial<Task>) => void;
  qualityLoopAttempts: Record<string, QualityLoopAttempt[]>;
  loadQualityLoopAttempts: (taskId: string) => Promise<void>;
  upsertQualityLoopAttempt: (taskId: string, attempt: QualityLoopAttempt) => void;

  // Pipelines
  pipelines: Pipeline[];
  loadPipelines: () => Promise<void>;
  upsertPipeline: (pipeline: Pipeline) => void;
  activePipelineId: string | null;
  setActivePipelineId: (id: string | null) => void;

  // Templates
  templates: PipelineTemplate[];
  loadTemplates: () => Promise<void>;

  // Notifications
  notifications: Notification[];
  unreadCount: number;
  loadNotifications: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  markNotificationsRead: (ids: string[]) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;

  // Observability
  platformEvents: PlatformEvent[];
  observability: ObservabilitySummary | null;
  diagnostics: RuntimeDiagnostics | null;
  loadPlatformEvents: () => Promise<void>;
  loadObservability: () => Promise<void>;
  loadDiagnostics: (raise?: boolean) => Promise<void>;

  // Audit
  operatorActions: OperatorAction[];
  loadOperatorActions: () => Promise<void>;

  // Human-in-the-loop inbox
  inboxEntries: InboxEntry[];
  pendingInboxCount: number;
  loadInboxEntries: () => Promise<void>;
  upsertInboxEntry: (entry: InboxEntry) => void;

  // Health
  health: HealthSummary | null;
  loadHealth: () => Promise<void>;

  // Selected items
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
}

export const useStore = create<AppStore>((set, get) => ({
  // View state
  activeView: 'command',
  setActiveView: (view) => set({ activeView: view }),

  // Agent selection & chat
  selectedAgentId: null,
  setSelectedAgentId: (id) => set({ selectedAgentId: id, rightPanelTab: 'chat' }),
  chatMode: 'direct',
  setChatMode: (mode) => set({ chatMode: mode }),
  agentChats: {},
  addChatMessage: (agentId, message) => set((state) => ({
    agentChats: {
      ...state.agentChats,
      [agentId]: [...(state.agentChats[agentId] || []), message],
    },
  })),
  updateChatMessage: (agentId, messageId, updates) => set((state) => ({
    agentChats: {
      ...state.agentChats,
      [agentId]: (state.agentChats[agentId] || []).map((msg) =>
        msg.id === messageId ? { ...msg, ...updates } : msg
      ),
    },
  })),

  // Executions
  executions: [],
  activeExecutions: {},
  executionMessages: {},
  loadExecutions: async () => {
    try {
      const executions = await api.executions.list();
      set({
        executions,
        activeExecutions: Object.fromEntries(executions.filter(e => e.status === 'running').map(e => [e.id, e])),
      });
    } catch (err) {
      console.warn('[store] Failed to load executions', err);
    }
  },
  upsertExecution: (execution) => set((state) => ({
    executions: [execution, ...state.executions.filter(e => e.id !== execution.id)]
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    activeExecutions: execution.status === 'running'
      ? { ...state.activeExecutions, [execution.id]: execution }
      : Object.fromEntries(Object.entries(state.activeExecutions).filter(([id]) => id !== execution.id)),
  })),
  addExecutionMessages: (executionId, messages) => set((state) => ({
    executionMessages: {
      ...state.executionMessages,
      [executionId]: [
        ...(state.executionMessages[executionId] || []),
        ...messages.filter(m => !(state.executionMessages[executionId] || []).find(e => e.id === m.id)),
      ],
    },
  })),
  loadExecutionMessages: async (executionId) => {
    try {
      const existing = get().executionMessages[executionId] || [];
      const lastId = existing.length > 0 ? existing[existing.length - 1].id : undefined;
      const messages = await api.executions.messages(executionId, lastId);
      if (messages.length > 0) {
        get().addExecutionMessages(executionId, messages);
      }
    } catch (err) {
      console.warn('[store] Failed to load execution messages', err);
    }
  },

  // Right panel
  rightPanelTab: 'chat',
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

  // Agents (with mock fallback when backend is offline)
  agents: [],
  loadAgents: async () => {
    try {
      const agents = await api.agents.list();
      if (agents && agents.length > 0) {
        set({ agents });
      } else {
        throw new Error('empty');
      }
    } catch (err) {
      console.warn('[store] Failed to load agents', err);
    }
  },

  // Tool Runtime
  tools: [],
  toolExecutions: [],
  loadTools: async () => {
    try {
      set({ tools: await api.tools.list() });
    } catch (err) {
      console.warn('[store] Failed to load tools', err);
    }
  },
  loadToolExecutions: async () => {
    try {
      set({ toolExecutions: await api.tools.executions({ limit: '100' }) });
    } catch (err) {
      console.warn('[store] Failed to load tool executions', err);
    }
  },

  // Model Registry
  models: [],
  modelRoutes: [],
  loadModels: async () => {
    try {
      set({ models: await api.models.list() });
    } catch (err) {
      console.warn('[store] Failed to load models', err);
    }
  },
  loadModelRoutes: async () => {
    try {
      set({ modelRoutes: await api.models.routes() });
    } catch (err) {
      console.warn('[store] Failed to load model routes', err);
    }
  },

  // Skill Versioning
  skills: [],
  skillAssignments: [],
  loadSkills: async () => {
    try {
      set({ skills: await api.skills.list() });
    } catch (err) {
      console.warn('[store] Failed to load skills', err);
    }
  },
  loadSkillAssignments: async () => {
    try {
      set({ skillAssignments: await api.skills.assignments() });
    } catch (err) {
      console.warn('[store] Failed to load skill assignments', err);
    }
  },

  // Tasks
  tasks: [],
  loadTasks: async () => {
    try {
      const tasks = await api.tasks.list();
      set({ tasks });
    } catch (err) {
      console.warn('[store] Failed to load tasks', err);
    }
  },
  upsertTask: (task) => set((state) => ({
    tasks: [task, ...state.tasks.filter(t => t.id !== task.id)]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
  })),
  patchTask: (taskId, updates) => set((state) => ({
    tasks: state.tasks.map(task => task.id === taskId ? { ...task, ...updates } : task),
  })),
  qualityLoopAttempts: {},
  loadQualityLoopAttempts: async (taskId) => {
    try {
      const attempts = await api.tasks.qualityAttempts(taskId);
      set((state) => ({
        qualityLoopAttempts: { ...state.qualityLoopAttempts, [taskId]: attempts },
      }));
    } catch (err) {
      console.warn('[store] Failed to load quality-loop attempts', err);
    }
  },
  upsertQualityLoopAttempt: (taskId, attempt) => set((state) => {
    const current = state.qualityLoopAttempts[taskId] || [];
    const attempts = [attempt, ...current.filter(item => item.id !== attempt.id)]
      .sort((a, b) => a.iteration - b.iteration);
    return {
      qualityLoopAttempts: { ...state.qualityLoopAttempts, [taskId]: attempts },
    };
  }),

  // Pipelines
  pipelines: [],
  loadPipelines: async () => {
    try {
      const pipelines = await api.pipelines.list();
      set({ pipelines });
    } catch (err) {
      console.warn('[store] Failed to load pipelines', err);
    }
  },
  upsertPipeline: (pipeline) => set((state) => ({
    pipelines: [pipeline, ...state.pipelines.filter(p => p.id !== pipeline.id)]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
  })),
  activePipelineId: null,
  setActivePipelineId: (id) => set({ activePipelineId: id }),

  // Templates
  templates: [],
  loadTemplates: async () => {
    try {
      const templates = await api.templates.list();
      set({ templates });
    } catch (err) {
      console.warn('[store] Failed to load templates', err);
    }
  },

  // Notifications
  notifications: [],
  unreadCount: 0,
  loadNotifications: async () => {
    try {
      const notifications = await api.notifications.list();
      set({ notifications, unreadCount: notifications.filter(n => !n.read).length });
    } catch (err) {
      console.warn('[store] Failed to load notifications', err);
    }
  },
  markNotificationRead: async (id) => {
    await api.notifications.markRead(id);
    set((state) => {
      const notifications = state.notifications.map(notification =>
        notification.id === id ? { ...notification, read: true } : notification
      );
      return { notifications, unreadCount: notifications.filter(n => !n.read).length };
    });
  },
  markNotificationsRead: async (ids) => {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;
    await Promise.all(uniqueIds.map(id => api.notifications.markRead(id)));
    set((state) => {
      const idSet = new Set(uniqueIds);
      const notifications = state.notifications.map(notification =>
        idSet.has(notification.id) ? { ...notification, read: true } : notification
      );
      return { notifications, unreadCount: notifications.filter(n => !n.read).length };
    });
  },
  markAllNotificationsRead: async () => {
    await api.notifications.markAllRead();
    set((state) => ({
      notifications: state.notifications.map(notification => ({ ...notification, read: true })),
      unreadCount: 0,
    }));
  },

  // Observability
  platformEvents: [],
  observability: null,
  diagnostics: null,
  loadPlatformEvents: async () => {
    try {
      const platformEvents = await api.events.list({ limit: '100' });
      set({ platformEvents });
    } catch (err) {
      console.warn('[store] Failed to load platform events', err);
    }
  },
  loadObservability: async () => {
    try {
      set({ observability: await api.observability() });
    } catch (err) {
      console.warn('[store] Failed to load observability summary', err);
    }
  },
  loadDiagnostics: async (raise = false) => {
    try {
      set({ diagnostics: await api.diagnostics() });
    } catch (err) {
      console.warn('[store] Failed to load diagnostics', err);
      if (raise) throw err;
    }
  },

  // Audit
  operatorActions: [],
  loadOperatorActions: async () => {
    try {
      set({ operatorActions: await api.operatorActions.list({ limit: '100' }) });
    } catch (err) {
      console.warn('[store] Failed to load operator actions', err);
    }
  },

  // Inbox
  inboxEntries: [],
  pendingInboxCount: 0,
  loadInboxEntries: async () => {
    try {
      const inboxEntries = await api.inbox.list();
      set({
        inboxEntries,
        pendingInboxCount: inboxEntries.filter(entry => entry.status === 'pending').length,
      });
    } catch (err) {
      console.warn('[store] Failed to load inbox entries', err);
    }
  },
  upsertInboxEntry: (entry) => set((state) => {
    const inboxEntries = [entry, ...state.inboxEntries.filter(existing => existing.id !== entry.id)]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return {
      inboxEntries,
      pendingInboxCount: inboxEntries.filter(item => item.status === 'pending').length,
    };
  }),

  // Health
  health: null,
  loadHealth: async () => {
    try {
      const health = await api.health();
      set({ health });
    } catch (err) {
      console.warn('[store] Failed to load health', err);
    }
  },

  // Selected items
  selectedTaskId: null,
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
}));
