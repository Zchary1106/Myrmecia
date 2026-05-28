import { cn } from '../../lib/utils';

interface TaskKanbanProps {
  tasks: any[];
  agents: any[];
}

const columns = [
  { key: 'pending', label: 'Pending', icon: '⏸', color: 'border-gray-500/30' },
  { key: 'queued', label: 'Queued', icon: '📥', color: 'border-yellow-500/30' },
  { key: 'running', label: 'Running', icon: '⚡', color: 'border-blue-500/30' },
  { key: 'done', label: 'Done', icon: '✅', color: 'border-green-500/30' },
  { key: 'failed', label: 'Failed', icon: '❌', color: 'border-red-500/30' },
];

function TaskCard({ task, agents }: { task: any; agents: any[] }) {
  const agent = agents.find(a => a.id === task.assigneeId);

  return (
    <div className="bg-background border border-border rounded-lg p-3 mb-2 hover:border-gray-500 transition-colors">
      <div className="flex items-center gap-2 mb-1">
        {agent && <span className="text-sm">{agent.emoji}</span>}
        <span className="text-xs font-medium truncate flex-1">{task.title}</span>
      </div>
      {agent && (
        <div className="text-[10px] text-gray-500">{agent.name}</div>
      )}
      {task.output && (
        <details className="mt-2">
          <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">
            Output
          </summary>
          <div className="mt-1 text-[10px] text-gray-400 bg-surface rounded p-2 max-h-20 overflow-y-auto whitespace-pre-wrap">
            {task.output.slice(0, 300)}
          </div>
        </details>
      )}
    </div>
  );
}

export function TaskKanban({ tasks, agents }: TaskKanbanProps) {
  return (
    <div className="grid grid-cols-5 gap-3 min-h-[120px]">
      {columns.map(col => {
        const colTasks = tasks.filter(t => {
          if (col.key === 'pending') return t.status === 'pending' || t.status === 'assigned';
          return t.status === col.key;
        });

        return (
          <div key={col.key} className={cn('border rounded-lg p-2', col.color)}>
            <div className="flex items-center gap-1.5 mb-2 px-1">
              <span className="text-xs">{col.icon}</span>
              <span className="text-[11px] font-semibold text-gray-400">{col.label}</span>
              <span className="text-[10px] text-gray-600 ml-auto">{colTasks.length}</span>
            </div>
            <div className="space-y-0">
              {colTasks.map(task => (
                <TaskCard key={task.id} task={task} agents={agents} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
