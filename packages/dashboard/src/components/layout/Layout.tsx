import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  Activity, Archive, Bot, Boxes, ChevronLeft, ChevronRight, CircleDollarSign, Command,
  Gauge, GitBranch, Inbox, LayoutDashboard, ListTodo, Menu, Moon, PackageOpen, Puzzle,
  MessageSquareText, Plus, Settings, ShieldCheck, Sun, TerminalSquare, Users, Wrench, Workflow, X,
} from 'lucide-react';
import { useStore } from '../../stores/store';
import type { DashboardView } from '../../stores/store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { AgentWorkspace } from '../agents/AgentWorkspace';
import { cn } from '../../lib/utils';
import { operatorRoleLabel, runtimeControlsAllowed } from '../../lib/permissions';
import { HomeView } from '../home/HomeView';
import { AppErrorBoundary } from '../common/AppErrorBoundary';
import { useConversationStore } from '../../stores/conversations';
import { LiquidLens } from '../common/LiquidLens';
import { LiquidNavIndicator } from './LiquidNavIndicator';

// Lazy-loaded page components for code splitting
const OrchestratorView = lazy(() => import('../orchestrator/OrchestratorView').then(m => ({ default: m.OrchestratorView })));
const OrchestrationBoard = lazy(() => import('../orchestrator/OrchestrationBoard').then(m => ({ default: m.OrchestrationBoard })));
const InteractionConsolePage = lazy(() => import('../../pages/InteractionConsole').then(m => ({ default: m.InteractionConsolePage })));
const TaskSession = lazy(() => import('../session/TaskSession').then(m => ({ default: m.TaskSession })));
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
const ArtifactsPage = lazy(() => import('../../pages/Artifacts').then(m => ({ default: m.ArtifactsPage })));

type NavItem = { id: DashboardView; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>; badge?: 'notifications' | 'inbox' };

const primaryNav: NavItem[] = [
  { id: 'command', label: 'Home', icon: LayoutDashboard },
  { id: 'session', label: 'Task session', icon: MessageSquareText },
  { id: 'teams', label: 'Teams', icon: Users },
  { id: 'orchestrator', label: 'Workflows', icon: Workflow },
  { id: 'artifacts', label: 'Artifacts', icon: PackageOpen },
];

const moreNav: { label: string; views: NavItem[] }[] = [
  { label: 'Workspace', views: [
    { id: 'tasks', label: 'Queue', icon: ListTodo }, { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'skills', label: 'Skills', icon: Puzzle }, { id: 'domains', label: 'Domains', icon: Boxes },
    { id: 'memory', label: 'Memory', icon: Archive },
  ] },
  { label: 'Operations', views: [
    { id: 'inbox', label: 'Inbox', icon: Inbox, badge: 'inbox' },
    { id: 'console', label: 'Console', icon: TerminalSquare },
    { id: 'timeline', label: 'Timeline', icon: Activity }, { id: 'observability', label: 'Observe', icon: Gauge },
    { id: 'audit', label: 'Audit', icon: ShieldCheck },
  ] },
  { label: 'Configuration', views: [
    { id: 'models', label: 'Models', icon: Command }, { id: 'tools', label: 'Tools', icon: Wrench },
    { id: 'cost', label: 'Costs', icon: CircleDollarSign }, { id: 'settings', label: 'Settings', icon: Settings },
  ] },
];

const viewTitles: Partial<Record<DashboardView, string>> = {
  command: 'Home', teams: 'Teams', orchestrator: 'Workflows', artifacts: 'Artifacts', tasks: 'Work queue',
  agents: 'Agents', skills: 'Skills', domains: 'Domains', memory: 'Memory', settings: 'Settings', models: 'Models',
  tools: 'Tools', cost: 'Costs', session: 'Task session', console: 'Console', timeline: 'Timeline', observability: 'Observability',
  audit: 'Audit log', inbox: 'Inbox', orchestrate: 'Team canvas', board: 'Board',
};

function SidebarItem({ item, collapsed, selected, badge, onClick }: { item: NavItem; collapsed: boolean; selected: boolean; badge: number; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button type="button" onClick={onClick} title={item.label} aria-current={selected ? 'page' : undefined} className={cn('glass-nav-item app-focus group relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-xs transition', collapsed && 'justify-center px-2', selected ? 'bg-accent/10 font-medium text-accent-light' : 'text-app-secondary hover:bg-surface-hover/80 hover:text-app-primary')}>
      <Icon size={17} strokeWidth={1.8} />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {badge > 0 && <span className={cn('ml-auto min-w-4 rounded-full bg-accent px-1 text-center text-[9px] font-bold text-white', collapsed && 'absolute right-1 top-1')}>{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

function GlobalNavRail({
  collapsed,
  mobileOpen,
  compactViewport,
  onToggle,
  onMobileClose,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  compactViewport: boolean;
  onToggle: () => void;
  onMobileClose: () => void;
}) {
  const {
    activeView,
    setActiveView,
    health,
    diagnostics,
    pendingInboxCount,
    agents,
  } = useStore();
  const canControl = runtimeControlsAllowed(diagnostics);
  const navigate = (view: DashboardView) => {
    setActiveView(view);
    onMobileClose();
  };

  return (
    <aside
      data-app-sidebar
      data-testid="global-nav-rail"
      aria-label="Main navigation"
      aria-hidden={compactViewport && !mobileOpen}
      inert={compactViewport && !mobileOpen ? true : undefined}
      className={cn(
        'glass-surface app-glass-sidebar fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(86vw,280px)] flex-none flex-col border-r border-border bg-surface/95 shadow-2xl backdrop-blur-xl transition-[transform,width] duration-200 lg:static lg:z-auto lg:h-full lg:translate-x-0 lg:bg-surface/70 lg:shadow-none',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        collapsed ? 'lg:w-[64px]' : 'lg:w-[240px]',
      )}
    >
      <div className={cn('flex h-14 shrink-0 items-center border-b border-border/70 px-3', collapsed ? 'justify-center' : 'justify-between')}>
        <button type="button" onClick={() => navigate('command')} className="app-focus flex items-center gap-2.5" title="Myrmecia Home">
          <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-white shadow-lg shadow-accent/20"><GitBranch size={17} strokeWidth={2.2} /></span>
          <span className={cn('text-sm font-semibold tracking-[-0.02em] text-app-primary', collapsed && 'lg:hidden')}>Myrmecia</span>
        </button>
        <button type="button" onClick={onMobileClose} className="app-focus rounded-lg p-1.5 text-app-muted transition hover:bg-surface-hover hover:text-app-primary lg:hidden" aria-label="Close navigation"><X size={17} /></button>
        {!collapsed && <button type="button" onClick={onToggle} className="app-focus hidden rounded-lg p-1.5 text-app-muted transition hover:bg-surface-hover hover:text-app-primary lg:inline-flex" aria-label="Collapse sidebar"><ChevronLeft size={16} /></button>}
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <LiquidNavIndicator selection={activeView} collapsed={collapsed} />
        <button
          type="button"
          onClick={() => navigate('command')}
          title="Start new task"
          className={cn(
            'glass-primary-button app-focus mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2.5 text-xs font-semibold text-white shadow-[0_8px_22px_rgb(var(--color-accent)/.2)] transition hover:-translate-y-0.5 hover:bg-accent-light active:translate-y-0',
            collapsed && 'lg:h-9 lg:px-0',
          )}
        >
          <Plus size={15} />
          <span className={cn(collapsed && 'lg:hidden')}>New task</span>
        </button>
        <div className="space-y-1">
          {primaryNav.map(item => <SidebarItem key={item.id} item={item} collapsed={compactViewport ? false : collapsed} selected={activeView === item.id || (item.id === 'agents' && activeView === 'agent-settings')} badge={0} onClick={() => navigate(item.id)} />)}
        </div>
        <div className="my-4 border-t border-border" />
        <div className={cn('mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-app-muted', collapsed && 'lg:hidden')}>More workspace</div>
        {moreNav.map(section => (
          <div key={section.label} className="mb-4 space-y-1">
            <div className={cn('px-3 pb-1 text-[10px] font-medium text-app-muted', collapsed && 'lg:hidden')}>{section.label}</div>
            {section.views.map(item => <SidebarItem key={item.id} item={item} collapsed={compactViewport ? false : collapsed} selected={activeView === item.id || (item.id === 'agents' && activeView === 'agent-settings')} badge={item.badge === 'inbox' ? pendingInboxCount : 0} onClick={() => navigate(item.id)} />)}
          </div>
        ))}
      </nav>
      <div className={cn('border-t border-border px-3 py-3', collapsed && 'lg:px-2')}>
        <div className={cn('flex items-center gap-2.5 rounded-xl bg-background/60 px-3 py-2.5', collapsed && 'lg:justify-center lg:px-2')} title={`${canControl ? 'Control' : 'Read-only'} · ${operatorRoleLabel(diagnostics)}`}>
          <span className={cn('h-2 w-2 rounded-full', health?.status === 'ok' ? 'bg-emerald-400' : 'bg-amber-400')} />
          <div className={cn('min-w-0', collapsed && 'lg:hidden')}><div className="truncate text-[11px] font-medium text-app-secondary">{agents.filter(agent => agent.activeExecutions > 0).length}/{agents.length} agents active</div><div className={cn('mt-0.5 text-[9px]', canControl ? 'text-emerald-400/80' : 'text-amber-400/80')}>{canControl ? 'Control enabled' : 'Read only'}</div></div>
          <span data-testid="agent-summary" className="sr-only">{agents.filter(agent => agent.activeExecutions > 0).length} running / {agents.length} agents</span>
        </div>
        <span data-testid="operator-identity" className="sr-only">{canControl ? 'Control' : 'Read-only'} · {operatorRoleLabel(diagnostics)}</span>
      </div>
    </aside>
  );
}

function MainContent() {
  const { activeView } = useStore();

  const content = (() => {
    switch (activeView) {
case 'command':
      return <HomeView />;
    case 'console':
      return <InteractionConsolePage />;
    case 'session':
      return <TaskSession />;
    case 'agents':
      return <AgentsPage />;
    case 'agent-settings':
      return <AgentWorkspace />;
    case 'tools':
      return <ToolsPage />;
    case 'models':
      return <ModelsPage />;
    case 'skills':
      return <SkillsPage />;
    case 'artifacts':
      return <ArtifactsPage />;
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
    <Suspense fallback={<PageLoadingState />}>
      <AppErrorBoundary>
        <div key={activeView} data-app-view={activeView} className={cn('app-view-enter min-h-full min-w-0', activeView === 'session' && 'h-full')}>
          {content}
        </div>
      </AppErrorBoundary>
    </Suspense>
  );
}

function PageLoadingState() {
  return (
    <div role="status" className="mx-auto flex min-h-full w-full max-w-[1080px] flex-col gap-4 p-6" aria-label="Loading view">
      <div className="h-5 w-32 animate-pulse rounded-lg bg-surface-hover" />
      <div className="h-3 w-64 animate-pulse rounded bg-surface-hover/80" />
      <div className="mt-5 grid gap-4 md:grid-cols-3"><div className="h-28 animate-pulse rounded-2xl bg-surface" /><div className="h-28 animate-pulse rounded-2xl bg-surface" /><div className="h-28 animate-pulse rounded-2xl bg-surface" /></div>
    </div>
  );
}

export function Layout() {
  const {
    loadAgents, loadTools, loadToolExecutions, loadModels, loadModelRoutes, loadSkills, loadSkillAssignments, loadTasks, loadPipelines, loadTemplates, loadHealth, loadNotifications, loadExecutions, loadInboxEntries,
    loadPlatformEvents, loadObservability, loadDiagnostics, loadOperatorActions,
    activeView,
  } = useStore();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof localStorage !== 'undefined' && localStorage.getItem('myrmecia.sidebar-collapsed') === 'true');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [compactViewport, setCompactViewport] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => typeof localStorage !== 'undefined' && localStorage.getItem('myrmecia.theme') === 'light' ? 'light' : 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('myrmecia.theme', theme);
  }, [theme]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)');
    const updateViewport = () => {
      setCompactViewport(query.matches);
      if (!query.matches) setMobileNavOpen(false);
    };
    updateViewport();
    query.addEventListener('change', updateViewport);
    return () => query.removeEventListener('change', updateViewport);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileNavOpen]);

  const toggleSidebar = () => {
    setSidebarCollapsed(current => {
      const next = !current;
      localStorage.setItem('myrmecia.sidebar-collapsed', String(next));
      return next;
    });
  };

  const pageTitle = useMemo(() => viewTitles[activeView] || 'Myrmecia', [activeView]);
  const effectiveSidebarCollapsed = sidebarCollapsed || activeView === 'session';

  useWebSocket();

  useEffect(() => {
    const refresh = () => { void useConversationStore.getState().load(); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

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
    <div className="app-glass-shell flex h-dvh flex-col overflow-hidden">
      <div className="app-glass-layout flex flex-1 min-h-0">
        {mobileNavOpen && <button type="button" aria-label="Close navigation overlay" onClick={() => setMobileNavOpen(false)} className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[2px] lg:hidden" />}
        <GlobalNavRail
          collapsed={effectiveSidebarCollapsed}
          mobileOpen={mobileNavOpen}
          compactViewport={compactViewport}
          onToggle={toggleSidebar}
          onMobileClose={() => setMobileNavOpen(false)}
        />

        <div className="app-glass-stage flex min-w-0 flex-1 flex-col">
          <header data-app-toolbar className="glass-surface app-glass-toolbar flex h-14 flex-none items-center justify-between gap-2 border-b border-border/70 bg-background/82 px-4 backdrop-blur-xl sm:px-5">
            <LiquidLens radius={18} />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation" className="app-focus rounded-lg p-1.5 text-app-muted transition hover:bg-surface-hover hover:text-app-primary lg:hidden"><Menu size={18} /></button>
              {sidebarCollapsed && activeView !== 'session' && <button type="button" onClick={toggleSidebar} aria-label="Expand sidebar" className="app-focus hidden rounded-lg p-1.5 text-app-muted transition hover:bg-surface-hover hover:text-app-primary lg:inline-flex"><ChevronRight size={17} /></button>}
              {activeView === 'session'
                ? <div id="session-header-slot" className="min-w-0 flex-1" />
                : <span className="truncate text-sm font-medium text-app-primary">{pageTitle}</span>}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <button type="button" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} className="glass-control app-focus rounded-lg p-2 text-app-muted transition hover:bg-surface-hover hover:text-app-primary">
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </div>
          </header>
          <main className={cn('app-glass-content min-h-0 min-w-0 flex-1', activeView === 'agents' || activeView === 'session' ? 'overflow-hidden' : 'overflow-y-auto')}>
            <MainContent />
          </main>
        </div>
      </div>

    </div>
  );
}
