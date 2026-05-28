import { cn } from '../../lib/utils';

interface DependencyGraphProps {
  tasks: any[];
  agents: any[];
}

const statusDot: Record<string, string> = {
  pending: 'bg-gray-500',
  queued: 'bg-yellow-500',
  running: 'bg-blue-500 animate-pulse',
  done: 'bg-green-500',
  failed: 'bg-red-500',
};

export function DependencyGraph({ tasks, agents }: DependencyGraphProps) {
  // Build adjacency: task.dependsOn → edges
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Group tasks by dependency depth (BFS levels)
  const levels: any[][] = [];
  const visited = new Set<string>();
  const taskLevel = new Map<string, number>();

  // Find roots (no dependencies or deps not in this set)
  const roots = tasks.filter(t => {
    const deps = t.dependsOn || [];
    return deps.length === 0 || deps.every((d: string) => !taskMap.has(d));
  });

  // BFS to assign levels
  let queue = roots.map(t => ({ task: t, level: 0 }));
  while (queue.length > 0) {
    const next: typeof queue = [];
    for (const { task, level } of queue) {
      if (visited.has(task.id)) continue;
      visited.add(task.id);
      taskLevel.set(task.id, level);
      if (!levels[level]) levels[level] = [];
      levels[level].push(task);

      // Find tasks that depend on this one
      for (const t of tasks) {
        if ((t.dependsOn || []).includes(task.id) && !visited.has(t.id)) {
          next.push({ task: t, level: level + 1 });
        }
      }
    }
    queue = next;
  }

  // Add unvisited tasks to level 0
  for (const t of tasks) {
    if (!visited.has(t.id)) {
      if (!levels[0]) levels[0] = [];
      levels[0].push(t);
    }
  }

  if (levels.length === 0) {
    return <div className="text-gray-500 text-xs">No tasks to display</div>;
  }

  return (
    <div className="flex items-start gap-4 overflow-x-auto py-2">
      {levels.map((levelTasks, levelIdx) => (
        <div key={levelIdx} className="flex flex-col gap-2 items-center">
          <div className="text-[9px] text-gray-600 uppercase font-semibold">
            {levelIdx === 0 ? 'Start' : `Step ${levelIdx}`}
          </div>
          {levelTasks.map(task => {
            const agent = agents.find(a => a.id === task.assigneeId);
            return (
              <div
                key={task.id}
                className="bg-background border border-border rounded-lg px-3 py-2 min-w-[140px] relative"
              >
                <div className="flex items-center gap-2">
                  <span className={cn('w-2 h-2 rounded-full', statusDot[task.status] || 'bg-gray-500')} />
                  <span className="text-[11px] font-medium truncate">{task.title}</span>
                </div>
                {agent && (
                  <div className="text-[10px] text-gray-500 mt-0.5 pl-4">
                    {agent.emoji} {agent.name}
                  </div>
                )}
              </div>
            );
          })}
          {/* Arrow to next level */}
          {levelIdx < levels.length - 1 && (
            <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full text-gray-600">
              →
            </div>
          )}
        </div>
      ))}
      {/* Arrows between levels */}
      {levels.length > 1 && (
        <style>{`
          .flex.items-start > div:not(:last-child)::after {
            content: '→';
            position: absolute;
            right: -14px;
            top: 50%;
            transform: translateY(-50%);
            color: #4b5563;
            font-size: 16px;
          }
          .flex.items-start > div { position: relative; }
        `}</style>
      )}
    </div>
  );
}
