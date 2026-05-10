import { useEffect } from 'react';
import { useStore } from '../../stores/store';
import type { DashboardView } from '../../stores/store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { AgentChatPanel } from '../agents/AgentChatPanel';
import { CommandCenter } from '../common/CommandCenter';
import { OrchestratorView } from '../orchestrator/OrchestratorView';
import { ExecutionTimeline } from '../timeline/ExecutionTimeline';
import { InboxView } from '../inbox/InboxView';
import { ObservabilityView } from '../observability/ObservabilityView';
import { AuditView } from '../audit/AuditView';
import { SettingsView } from '../settings/SettingsView';
import { CommandBar } from '../common/CommandBar';
import { TasksPage } from '../../pages/Tasks';
import { AgentsPage } from '../../pages/Agents';
import { ToolsPage } from '../../pages/Tools';
import { ModelsPage } from '../../pages/Models';
import { SkillsPage } from '../../pages/Skills';
import { cn } from '../../lib/utils';
import { operatorRoleLabel, runtimeControlsAllowed } from '../../lib/permissions';

function agentDotColor(agent: any): string {
  const active = agent.activeExecutions || 0;
  if (active > 0) return 'bg-blue-500 animate-pulse';
  return 'bg-green-500';
}

function AgentSidebar() {
  const { agents, selectedAgentId, setSelectedAgentId, health, diagnostics } = useStore();
  const canControl = runtimeControlsAllowed(diagnostics);

  const grouped = agents.reduce<Record<string, any[]>>((acc, agent) => {
    const group = ['orchestrator', 'product-manager', 'designer', 'developer', 'tester', 'devops', 'reviewer'].includes(agent.role)
      ? 'Core'
      : agent.role === 'content-writer' ? 'Content' : 'Tools';
    if (!acc[group]) acc[group] = [];
    acc[group].push(agent);
    return acc;
  }, {});

  return (
    <aside className="w-52 bg-surface border-r border-border flex flex-col h-full">
      {/* Brand */}
      <div className="p-4 border-b border-border">
        <h1 className="text-base font-bold flex items-center gap-2">
          <span>🏭</span> Agent Factory
        </h1>
        <div className="flex items-center gap-1.5 mt-1">
          <span className={cn('w-1.5 h-1.5 rounded-full', health?.status === 'ok' ? 'bg-green-500' : 'bg-gray-500')} />
          <span className="text-[10px] text-gray-500">
            {agents.filter((a: any) => (a.activeExecutions || 0) > 0).length} running / {agents.length} agents
          </span>
        </div>
        <div className={cn(
          'mt-2 rounded-md px-2 py-1 text-[10px] truncate',
          canControl ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400',
        )}>
          {canControl ? 'Control' : 'Read-only'} · {operatorRoleLabel(diagnostics)}
        </div>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {['Core', 'Content', 'Tools'].filter(g => grouped[g]?.length).map(group => (
          <div key={group}>
            <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider px-2 mb-1">
              {group}
            </div>
            <div className="space-y-0.5">
              {grouped[group].map((agent: any) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                    selectedAgentId === agent.id
                      ? 'bg-accent/15 text-accent-light'
                      : 'text-gray-400 hover:bg-surface-hover hover:text-gray-200'
                  )}
                >
                  <span className="text-base">{agent.emoji || '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium truncate">{agent.name}</div>
                  </div>
                  <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', agentDotColor(agent))} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom nav */}
      <div className="p-2 border-t border-border space-y-0.5">
        <ViewToggle />
      </div>
    </aside>
  );
}

function ViewToggle() {
  const { activeView, setActiveView, pendingInboxCount, unreadCount } = useStore();

  const sections: { label: string; views: { id: DashboardView; label: string; icon: string; badge?: number }[] }[] = [
    {
      label: 'Workspace',
      views: [
        { id: 'command', label: 'Command Center', icon: '⌘', badge: unreadCount },
        { id: 'tasks', label: 'Work Queue', icon: '📋' },
        { id: 'agents', label: 'Agents', icon: '🤖' },
        { id: 'tools', label: 'Tools', icon: '🧰' },
        { id: 'models', label: 'Models', icon: '🧠' },
        { id: 'skills', label: 'Skills', icon: '📚' },
        { id: 'orchestrator', label: 'Pipelines', icon: '🔗' },
        { id: 'inbox', label: 'Inbox', icon: '📥', badge: pendingInboxCount },
      ],
    },
    {
      label: 'Operations',
      views: [
        { id: 'timeline', label: 'Timeline', icon: '🧭' },
        { id: 'observability', label: 'Observe', icon: '📈' },
        { id: 'audit', label: 'Audit', icon: '🧾' },
        { id: 'settings', label: 'Settings', icon: '⚙️' },
      ],
    },
  ];

  return (
    <>
      {sections.map(section => (
        <div key={section.label} className="space-y-0.5">
          <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
            {section.label}
          </div>
          {section.views.map(v => (
            <button
              key={v.id}
              onClick={() => setActiveView(v.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12px] transition-colors',
                activeView === v.id
                  ? 'bg-accent/15 text-accent-light font-medium'
                  : 'text-gray-500 hover:bg-surface-hover hover:text-gray-300'
              )}
            >
              <span>{v.icon}</span>
              <span className="flex-1 text-left">{v.label}</span>
              {(v.badge ?? 0) > 0 && (
                <span className="bg-accent/20 text-accent-light px-1.5 py-0.5 rounded-full text-[10px]">
                  {v.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function MainContent() {
  const { activeView } = useStore();

  switch (activeView) {
    case 'command':
      return <CommandCenter />;
    case 'agents':
      return <AgentsPage />;
    case 'tools':
      return <ToolsPage />;
    case 'models':
      return <ModelsPage />;
    case 'skills':
      return <SkillsPage />;
    case 'orchestrator':
      return <OrchestratorView />;
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
    default:
      return null;
  }
}

export function Layout() {
  const {
    loadAgents, loadTools, loadToolExecutions, loadModels, loadModelRoutes, loadSkills, loadSkillAssignments, loadTasks, loadPipelines, loadTemplates, loadHealth, loadNotifications, loadExecutions, loadInboxEntries,
    loadPlatformEvents, loadObservability, loadDiagnostics, loadOperatorActions,
    selectedAgentId,
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
  }, []);

  return (
    <div className="flex flex-col h-screen">
      <div className="flex flex-1 min-h-0">
        {/* Left: Agent sidebar */}
        <AgentSidebar />

        {/* Center: Main content area */}
        <main className="flex-1 overflow-y-auto bg-background">
          <MainContent />
        </main>

        {/* Right: Chat/Detail panel */}
        <aside className={cn(
          'border-l border-border bg-surface transition-all duration-300 overflow-hidden',
          selectedAgentId ? 'w-[400px]' : 'w-0'
        )}>
          <AgentChatPanel />
        </aside>
      </div>

      {/* Bottom: Command bar */}
      <CommandBar />
    </div>
  );
}
