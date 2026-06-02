import { useEffect, useState } from 'react';
import { useStore } from '../../stores/store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { TaskKanban } from './TaskKanban';
import { DependencyGraph } from './DependencyGraph';
import { AgentMessageFeed } from './AgentMessageFeed';

interface Orchestration {
  id: string;
  input: string;
  intent: any;
  status: string;
  taskIds: string[];
  result?: string;
  createdAt: string;
  completedAt?: string;
  tasks?: any[];
}

const statusConfig: Record<string, { bg: string; text: string; icon: string }> = {
  planning: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', icon: '🧠' },
  dispatching: { bg: 'bg-blue-500/20', text: 'text-blue-400', icon: '📡' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400', icon: '⚡' },
  done: { bg: 'bg-green-500/20', text: 'text-green-400', icon: '✅' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400', icon: '❌' },
};

export function OrchestrationBoard() {
  const { tasks, agents } = useStore();
  const [orchestrations, setOrchestrations] = useState<Orchestration[]>([]);
  const [selectedOrch, setSelectedOrch] = useState<Orchestration | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadOrchestrations = async () => {
    try {
      const data = await api.get('/api/v1/supervisor/orchestrations');
      setOrchestrations(data);
    } catch {
      // API may not exist yet
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id: string) => {
    try {
      const [detail, msgs] = await Promise.all([
        api.get(`/api/v1/supervisor/orchestrations/${id}`),
        api.get(`/api/v1/supervisor/orchestrations/${id}/messages`),
      ]);
      setSelectedOrch(detail);
      setMessages(msgs);
    } catch {}
  };

  useEffect(() => {
    loadOrchestrations();
    const interval = setInterval(loadOrchestrations, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-select latest running orchestration
  useEffect(() => {
    if (!selectedOrch && orchestrations.length > 0) {
      const running = orchestrations.find(o => o.status === 'running') || orchestrations[0];
      loadDetail(running.id);
    }
  }, [orchestrations]);

  // Refresh selected orchestration detail
  useEffect(() => {
    if (!selectedOrch) return;
    const interval = setInterval(() => loadDetail(selectedOrch.id), 3000);
    return () => clearInterval(interval);
  }, [selectedOrch?.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Loading orchestrations...
      </div>
    );
  }

  const orchTasks = selectedOrch?.tasks || selectedOrch?.taskIds.map(id =>
    tasks.find(t => t.id === id)
  ).filter(Boolean) || [];
  const recentTasks = tasks.slice(0, 30);
  const visibleTasks = selectedOrch ? orchTasks : recentTasks;

  return (
    <div className="p-4 space-y-4 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <span>🎯</span> Orchestration Board
        </h2>
        <div className="text-xs text-gray-500 text-right">
          <div>{orchestrations.filter(o => o.status === 'running').length} active orchestrations</div>
          <div className="text-[10px]">Use Work Queue for the global task board</div>
        </div>
      </div>

      {/* Orchestration List (horizontal scroll) */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {orchestrations.slice(0, 10).map(orch => {
          const config = statusConfig[orch.status] || statusConfig.planning;
          return (
            <button
              key={orch.id}
              onClick={() => loadDetail(orch.id)}
              className={cn(
                'flex-shrink-0 bg-surface border rounded-lg p-3 text-left transition-all min-w-[200px]',
                selectedOrch?.id === orch.id
                  ? 'border-accent ring-1 ring-accent/20'
                  : 'border-border hover:border-gray-600'
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <span>{config.icon}</span>
                <span className={cn('text-[10px] px-1.5 py-0.5 rounded', config.bg, config.text)}>
                  {orch.status}
                </span>
              </div>
              <div className="text-sm font-medium truncate">{orch.input.slice(0, 50)}</div>
              <div className="text-[10px] text-gray-500 mt-1">
                {orch.taskIds.length} tasks · {new Date(orch.createdAt).toLocaleTimeString()}
              </div>
            </button>
          );
        })}
        {orchestrations.length === 0 && (
          <div className="text-gray-500 text-sm py-4">
            No orchestrations yet. Showing recent tasks below; use Work Queue for the global task board.
          </div>
        )}
      </div>

      <>
        {/* Kanban Board */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <span>📋</span> {selectedOrch ? 'Orchestration Task Board' : 'Recent Task Board'}
            </h3>
            {!selectedOrch && (
              <span className="text-[11px] text-gray-500">
                Showing latest {visibleTasks.length} tasks because no orchestration is selected.
              </span>
            )}
          </div>
          <TaskKanban tasks={visibleTasks} agents={agents} />
        </div>

        {/* Dependency Graph */}
        {selectedOrch && orchTasks.length > 1 && (
          <div className="bg-surface border border-border rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <span>🔗</span> Dependency Graph
            </h3>
            <DependencyGraph tasks={orchTasks} agents={agents} />
          </div>
        )}

        {/* Agent Message Feed */}
        {selectedOrch && (
          <div className="bg-surface border border-border rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <span>💬</span> Agent Communication
            </h3>
            <AgentMessageFeed messages={messages} agents={agents} />
          </div>
        )}
      </>
    </div>
  );
}
