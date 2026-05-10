import { useState } from 'react';
import { useStore } from '../stores/store';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

const statusColors: Record<string, string> = {
  idle: 'bg-green-500',
  working: 'bg-blue-500 animate-pulse',
};

export function OverviewPage() {
  const { health, agents, tasks, pipelines, loadTasks, loadPipelines } = useStore();
  const [commandInput, setCommandInput] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);

  const runningTasks = tasks.filter(t => t.status === 'running');
  const activePipelines = pipelines.filter(p => p.status === 'running');
  const activeAgents = agents.filter(a => (a.activeExecutions || 0) > 0);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Overview</h2>
          <p className="text-sm text-gray-500">System status and activity</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('w-2 h-2 rounded-full', health?.status === 'ok' ? 'bg-green-500' : 'bg-red-500')} />
          <span className="text-xs text-gray-500">{health?.status === 'ok' ? 'System Healthy' : 'Loading...'}</span>
        </div>
      </div>

      {/* Supervisor Command Input */}
      <div className="bg-surface border border-border rounded-xl p-4">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!commandInput.trim() || dispatching) return;
            setDispatching(true);
            try {
              const result = await api.supervisor.dispatch(commandInput.trim());
              setLastResult(result);
              setCommandInput('');
              loadTasks();
              loadPipelines();
            } catch (err: any) {
              setLastResult({ error: err.message });
            } finally {
              setDispatching(false);
            }
          }}
          className="flex gap-3"
        >
          <div className="flex-1 relative">
            <input
              value={commandInput}
              onChange={e => setCommandInput(e.target.value)}
              placeholder="Tell your agents what to do... (e.g. 'Build a weather app')"
              className="w-full bg-background border border-border rounded-lg px-4 py-3 text-sm focus:border-accent outline-none placeholder-gray-600"
              disabled={dispatching}
            />
            {dispatching && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
          <button
            type="submit"
            disabled={dispatching || !commandInput.trim()}
            className="px-6 py-3 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-light transition disabled:opacity-50"
          >
            {dispatching ? 'Dispatching...' : 'Send'}
          </button>
        </form>
        {lastResult && !lastResult.error && (
          <div className="mt-3 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 text-xs text-green-400">
            Dispatched via <strong>{lastResult.mode}</strong> mode
            {lastResult.intent && ` (detected: ${lastResult.intent.type}, complexity: ${lastResult.intent.complexity})`}
          </div>
        )}
        {lastResult?.error && (
          <div className="mt-3 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
            Error: {lastResult.error}
          </div>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Active Agents" value={`${activeAgents.length}/${agents.length}`} icon="🤖" color="accent" />
        <StatCard label="Running Tasks" value={runningTasks.length} icon="⚡" color="green" />
        <StatCard label="Pipelines" value={activePipelines.length} icon="🔗" color="yellow" />
        <StatCard label="Completed" value={tasks.filter(t => t.status === 'done').length} icon="✅" color="blue" />
      </div>

      {/* Agent Status Grid */}
      <div>
        <h3 className="text-lg font-semibold mb-3">Agents</h3>
        <div className="grid grid-cols-3 gap-3">
          {agents.map(agent => (
            <div key={agent.id} className="bg-surface rounded-xl p-4 border border-border hover:border-accent/30 transition">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{agent.emoji || '🤖'}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{agent.name}</div>
                  <div className="text-xs text-gray-500">{agent.role}</div>
                </div>
                <span className={cn('w-2.5 h-2.5 rounded-full', statusColors[(agent.activeExecutions || 0) > 0 ? 'working' : 'idle'])} />
              </div>
              {(agent.activeExecutions || 0) > 0 && (
                <div className="mt-2 text-xs text-gray-400 truncate">
                  {agent.activeExecutions} active execution{agent.activeExecutions === 1 ? '' : 's'}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Active Pipelines */}
      {activePipelines.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Active Pipelines</h3>
          <div className="space-y-3">
            {activePipelines.map(pipeline => (
              <div key={pipeline.id} className="bg-surface rounded-xl p-4 border border-border">
                <div className="font-medium mb-3">{pipeline.name}</div>
                <div className="flex items-center gap-2">
                  {pipeline.stages.map((stage: any, i: number) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className={cn(
                        'px-3 py-1 rounded-full text-xs font-medium',
                        stage.status === 'done' ? 'bg-green-500/20 text-green-400' :
                        stage.status === 'running' ? 'bg-blue-500/20 text-blue-400 animate-pulse' :
                        'bg-gray-500/20 text-gray-500'
                      )}>
                        {stage.name}
                      </div>
                      {i < pipeline.stages.length - 1 && (
                        <span className="text-gray-600">→</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Tasks */}
      <div>
        <h3 className="text-lg font-semibold mb-3">Recent Tasks</h3>
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
          {tasks.slice(0, 10).map(task => (
            <div key={task.id} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-hover transition">
              <StatusBadge status={task.status} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{task.title}</div>
                <div className="text-xs text-gray-500">{task.mode} · {task.priority}</div>
              </div>
              <div className="text-xs text-gray-600">{new Date(task.createdAt).toLocaleTimeString()}</div>
            </div>
          ))}
          {tasks.length === 0 && (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">No tasks yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, color }: { label: string; value: any; icon: string; color: string }) {
  const bgColors: Record<string, string> = {
    accent: 'bg-accent/10', green: 'bg-green-500/10', yellow: 'bg-yellow-500/10', blue: 'bg-blue-500/10',
  };
  return (
    <div className="bg-surface rounded-xl p-4 border border-border">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500 mb-1">{label}</div>
          <div className="text-2xl font-bold">{value}</div>
        </div>
        <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center text-lg', bgColors[color])}>
          {icon}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-gray-500/20 text-gray-400',
    queued: 'bg-yellow-500/20 text-yellow-400',
    assigned: 'bg-blue-500/20 text-blue-300',
    running: 'bg-blue-500/20 text-blue-400',
    review: 'bg-purple-500/20 text-purple-400',
    done: 'bg-green-500/20 text-green-400',
    failed: 'bg-red-500/20 text-red-400',
    cancelled: 'bg-gray-500/20 text-gray-500',
  };
  return (
    <span className={cn('px-2 py-0.5 rounded text-xs font-medium', colors[status] || colors.pending)}>
      {status}
    </span>
  );
}
