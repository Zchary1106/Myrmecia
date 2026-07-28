import { lazy, Suspense, useEffect } from 'react';
import { useStore } from '../../stores/store';
import type { DashboardView } from '../../stores/store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { AgentWorkspace } from '../agents/AgentWorkspace';
import { CommandCenter } from '../common/CommandCenter';
import { CommandBar } from '../common/CommandBar';
import { cn } from '../../lib/utils';
import { operatorRoleLabel, runtimeControlsAllowed } from '../../lib/permissions';

// Lazy-loaded page components for code splitting
const OrchestratorView = lazy(() => import('../orchestrator/OrchestratorView').then(m => ({ default: m.OrchestratorView })));
const OrchestrationBoard = lazy(() => import('../orchestrator/OrchestrationBoard').then(m => ({ default: m.OrchestrationBoard })));
const InteractionConsolePage = lazy(() => import('../../pages/InteractionConsole').then(m => ({ default: m.InteractionConsolePage })));
const ExecutionTimeline = lazy(() => import('../timeline/ExecutionTimeline').then(m => ({ default: m.ExecutionTimeline })));
const InboxView = lazy(() => import('../inbox/InboxView').then(m => ({ default: m.InboxView })));
const ObservabilityView = lazy(() => import('../observability/ObservabilityView').then(m => ({ default: m.ObservabilityView })));
const AuditView = lazy(() => import('../audit/AuditView').then(m => ({ default: m.AuditView })));
const SettingsView = lazy(() => import('../settings/SettingsView').then(m => ({ default: m.SettingsView })));
const TasksPage = lazy(() => import('../../pages/Tasks').then(m => ({ default: m.TasksPage })));
const CostDashboardPage = lazy(() => import('../../pages/CostDashboard').then(m => ({ default: m.CostDashboardPage })));
const AgentsPage = lazy(() => import('../../pages/Agents').then(m => ({ default: m.AgentsPage })));
const ToolsPage = lazy(() => import('../../pages/Tools').then(m => ({ default: m.ToolsPage })));
const ModelsPage = lazy(() => import('../../pages/Models').then(m => ({ default: m.ModelsPage })));
const SkillsPage = lazy(() => import('../../pages/Skills').then(m => ({ default: m.SkillsPage })));
const MemoryPage = lazy(() => import('../../pages/Memory').then(m => ({ default: m.MemoryPage })));
const OrchestratePage = lazy(() => import('../../pages/Orchestrate').then(m => ({ default: m.OrchestratePage })));
const TeamsPage = lazy(() => import('../../pages/Teams').then(m => ({ default: m.TeamsPage })));
const DomainsPage = lazy(() => import('../../pages/Domains').then(m => ({ default: m.DomainsPage })));

const globalSections: {
  label: string;
  views: { id: DashboardView; label: string; icon: string; badge?: 'notifications' | 'inbox' }[];
}[] = [
  {
    label: 'Workspace',
    views: [
      { id: 'command', label: 'Command', icon: '⌘', badge: 'notifications' },
      { id: 'tasks', label: 'Queue', icon: '▣' },
      { id: 'agents', label: 'Agents', icon: '◆' },
      { id: 'tools', label: 'Tools', icon: '🧰' },
      { id: 'models', label: 'Models', icon: '◉' },
      { id: 'skills', label: 'Skills', icon: '▤' },
      { id: 'domains', label: 'Domains', icon: '▥' },
      { id: 'memory', label: 'Memory', icon: '⌁' },
    ],
  },
  {
    label: 'Flow',
    views: [
      { id: 'orchestrator', label: 'Pipelines', icon: '↝' },
      { id: 'orchestrate', label: 'Canvas', icon: '⌘' },
      { id: 'teams', label: 'Teams', icon: '♟' },
      { id: 'board', label: 'Board', icon: '◎' },
      { id: 'inbox', label: 'Inbox', icon: '▾', badge: 'inbox' },
    ],
  },
  {
    label: 'Operations',
    views: [
      { id: 'console', label: 'Console', icon: '⌁' },
      { id: 'timeline', label: 'Timeline', icon: '◷' },
      { id: 'observability', label: 'Observe', icon: '◒' },
      { id: 'audit', label: 'Audit', icon: '▧' },
      { id: 'cost', label: 'Costs', icon: '＄' },
      { id: 'settings', label: 'Settings', icon: '⚙' },
    ],
  },
];

function GlobalNavRail() {
  const {
    activeView,
    setActiveView,
    health,
    diagnostics,
    pendingInboxCount,
    unreadCount,
    agents,
  } = useStore();
  const canControl = runtimeControlsAllowed(diagnostics);

  return (
    <aside
      data-testid="global-nav-rail"
      className="flex h-full w-[88px] flex-none flex-col border-r border-border bg-surface"
    >
      <div className="flex flex-col items-center border-b border-border px-2 py-3">
        <img src="/myrmecia-mark.png" alt="" className="h-9 w-9 rounded-xl shadow-lg shadow-accent/20" />
        <div className="mt-1.5 text-[8px] font-bold tracking-[0.16em] text-gray-500">MYRMECIA</div>
      </div>

      <nav className="flex-1 overflow-y-auto px-1.5 py-2">
        {globalSections.map((section, sectionIndex) => (
          <div key={section.label} className={cn(sectionIndex > 0 && 'mt-2 border-t border-border pt-2')}>
            <div className="mb-1 text-center text-[7px] font-semibold uppercase tracking-[0.14em] text-gray-700">
              {section.label}
            </div>
            <div className="space-y-1">
              {section.views.map(view => {
                const badge = view.badge === 'notifications' ? unreadCount : view.badge === 'inbox' ? pendingInboxCount : 0;
                const selected = activeView === view.id || (view.id === 'agents' && activeView === 'agent-settings');
                return (
                <button
                  key={view.id}
                  type="button"
                  onClick={() => setActiveView(view.id)}
                  title={view.label}
                  className={cn(
                    'relative flex w-full flex-col items-center justify-center rounded-xl px-1 py-1.5 transition',
                    selected
                      ? 'bg-accent/15 text-accent-light'
                      : 'text-gray-600 hover:bg-surface-hover hover:text-gray-300',
                  )}
                >
                  <span className="text-base leading-none">{view.icon}</span>
                  <span className="mt-1 max-w-full truncate text-[8px] font-medium">{view.label}</span>
                  {badge > 0 && (
                    <span className="absolute right-1 top-1 min-w-4 rounded-full bg-accent px-1 text-[8px] font-bold text-white">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-2 py-3 text-center">
        <div className="flex items-center justify-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', health?.status === 'ok' ? 'bg-emerald-400' : 'bg-gray-600')} />
          <span className="text-[8px] text-gray-600">
            {agents.filter(agent => agent.activeExecutions > 0).length}/{agents.length}
          </span>
          <span data-testid="agent-summary" className="sr-only">
            {agents.filter(agent => agent.activeExecutions > 0).length} running / {agents.length} agents
          </span>
        </div>
        <div
          className={cn('mt-1 truncate text-[7px]', canControl ? 'text-emerald-500/70' : 'text-yellow-500/70')}
          title={`${canControl ? 'Control' : 'Read-only'} · ${operatorRoleLabel(diagnostics)}`}
        >
          {canControl ? 'CONTROL' : 'READ ONLY'}
        </div>
        <span data-testid="operator-identity" className="sr-only">
          {canControl ? 'Control' : 'Read-only'} · {operatorRoleLabel(diagnostics)}
        </span>
      </div>
    </aside>
  );
}

function MainContent() {
  const { activeView } = useStore();

  const content = (() => {
    switch (activeView) {
    case 'command':
      return <CommandCenter />;
    case 'console':
      return <InteractionConsolePage />;
    case 'agents':
      return <AgentWorkspace />;
    case 'agent-settings':
      return <AgentsPage />;
    case 'tools':
      return <ToolsPage />;
    case 'models':
      return <ModelsPage />;
    case 'skills':
      return <SkillsPage />;
    case 'domains':
      return <DomainsPage />;
    case 'memory':
      return <MemoryPage />;
    case 'orchestrate':
      return <OrchestratePage />;
    case 'teams':
      return <TeamsPage />;
    case 'orchestrator':
      return <OrchestratorView />;
    case 'board':
      return <OrchestrationBoard />;
    case 'inbox':
      return <InboxView />;
    case 'timeline':
      return <ExecutionTimeline />;
    case 'observability':
      return <ObservabilityView />;
    case 'audit':
      return <AuditView />;
    case 'tasks':
      return <TasksPage />;
    case 'settings':
      return <SettingsView />;
    case 'cost':
      return <CostDashboardPage />;
    default:
      return null;
  }
  })();

  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>}>
      {content}
    </Suspense>
  );
}

export function Layout() {
  const {
    loadAgents, loadTools, loadToolExecutions, loadModels, loadModelRoutes, loadSkills, loadSkillAssignments, loadTasks, loadPipelines, loadTemplates, loadHealth, loadNotifications, loadExecutions, loadInboxEntries,
    loadPlatformEvents, loadObservability, loadDiagnostics, loadOperatorActions,
    activeView,
  } = useStore();

  useWebSocket();

  useEffect(() => {
    loadAgents();
    loadTools();
    loadToolExecutions();
    loadModels();
    loadModelRoutes();
    loadSkills();
    loadSkillAssignments();
    loadTasks();
    loadPipelines();
    loadTemplates();
    loadHealth();
    loadNotifications();
    loadExecutions();
    loadInboxEntries();
    loadPlatformEvents();
    loadObservability();
    loadDiagnostics();
    loadOperatorActions();

    // Retry failed initial loads (server might not be ready on first attempt)
    // Keeps retrying every 5s until all critical data is loaded
    const retryInterval = setInterval(() => {
      const state = useStore.getState();
      const needsRetry =
        !state.diagnostics ||
        state.agents.length === 0 ||
        state.health === null;

      if (!needsRetry) {
        clearInterval(retryInterval);
        return;
      }

      if (!state.diagnostics) loadDiagnostics();
      if (state.agents.length === 0) loadAgents();
      if (state.health === null) loadHealth();
    }, 5000);

    return () => clearInterval(retryInterval);
  }, []);

  return (
    <div className="flex flex-col h-screen">
      <div className="flex flex-1 min-h-0">
        <GlobalNavRail />

        <main className={cn('min-w-0 flex-1 bg-background', activeView === 'agents' ? 'overflow-hidden' : 'overflow-y-auto')}>
          <MainContent />
        </main>
      </div>

      {activeView !== 'agents' && <CommandBar />}
    </div>
  );
}
