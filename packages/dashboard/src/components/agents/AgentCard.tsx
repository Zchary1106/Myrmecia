import { useStore } from '../../stores/store';
import { cn } from '../../lib/utils';
import { AgentPet } from './AgentPet';

function getAgentStatus(agent: any): { label: string; color: string } {
  const active = agent.activeExecutions || 0;
  if (active > 0) return { label: `${active} running`, color: 'bg-blue-500 animate-pulse' };
  return { label: 'ready', color: 'bg-green-500' };
}

const roleGroups: Record<string, string> = {
  orchestrator: 'Core',
  'product-manager': 'Core',
  designer: 'Core',
  developer: 'Core',
  tester: 'Core',
  devops: 'Core',
  reviewer: 'Core',
  'content-writer': 'Content',
  internationalization: 'Tools',
  database: 'Tools',
  'api-architect': 'Tools',
  documentation: 'Tools',
};

export function AgentCard({ agent }: { agent: any }) {
  const { selectedAgentId, setSelectedAgentId, setRightPanelTab } = useStore();
  const isSelected = selectedAgentId === agent.id;
  const status = getAgentStatus(agent);

  return (
    <div
      className={cn(
        'bg-surface border rounded-xl p-4 cursor-pointer transition-all duration-200 hover:shadow-lg hover:shadow-accent/5',
        isSelected
          ? 'border-accent ring-1 ring-accent/30 shadow-lg shadow-accent/10'
          : 'border-border hover:border-accent/30'
      )}
      onClick={() => setSelectedAgentId(agent.id)}
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="text-2xl w-10 h-10 rounded-lg bg-background flex items-center justify-center">
          {agent.emoji || '🤖'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{agent.name}</div>
          <div className="text-[11px] text-gray-500">{agent.role}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn('w-2 h-2 rounded-full', status.color)} />
          <span className="text-[10px] text-gray-500">{status.label}</span>
        </div>
      </div>

      {/* Description */}
      {agent.description && (
        <p className="text-[11px] text-gray-400 mb-3 line-clamp-2 leading-relaxed">{agent.description}</p>
      )}

      {/* Stats row with Pet */}
      <div className="flex items-center gap-3 mb-3">
        <AgentPet agent={agent} size={42} />
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-green-400">
            <span className="font-bold">{agent.stats?.tasksCompleted || 0}</span> done
          </span>
          <span className="text-red-400">
            <span className="font-bold">{agent.stats?.tasksFailed || 0}</span> failed
          </span>
          <span className="text-gray-500">
            {agent.stats?.avgDurationMs ? `~${Math.round(agent.stats.avgDurationMs / 1000)}s` : '--'}
          </span>
        </div>
      </div>

      {/* Runtime activity indicator */}
      {(agent.activeExecutions || 0) > 0 && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-2.5 py-1.5 text-[11px] text-blue-300 mb-3 flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
          {agent.activeExecutions} active execution{agent.activeExecutions === 1 ? '' : 's'}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedAgentId(agent.id);
            setRightPanelTab('chat');
          }}
          className="flex-1 py-1.5 rounded-lg text-[11px] font-medium bg-accent/10 text-accent-light hover:bg-accent/20 transition"
        >
          💬 Chat
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedAgentId(agent.id);
            setRightPanelTab('history');
          }}
          className="flex-1 py-1.5 rounded-lg text-[11px] font-medium bg-surface-hover text-gray-400 hover:text-gray-300 transition"
        >
          📋 History
        </button>
      </div>
    </div>
  );
}

export function AgentCardGrid() {
  const { agents } = useStore();

  // Group agents by category
  const grouped = agents.reduce<Record<string, any[]>>((acc, agent) => {
    const group = roleGroups[agent.role] || 'Other';
    if (!acc[group]) acc[group] = [];
    acc[group].push(agent);
    return acc;
  }, {});

  const groupOrder = ['Core', 'Content', 'Tools', 'Other'];

  return (
    <div className="space-y-6">
      {groupOrder.filter(g => grouped[g]?.length).map(groupName => (
        <div key={groupName}>
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{groupName}</h3>
            <div className="flex-1 h-px bg-border" />
            <span className="text-[10px] text-gray-600">{grouped[groupName].length} agents</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
            {grouped[groupName].map((agent: any) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
