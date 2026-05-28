import { Command } from 'commander';

const DEFAULT_SERVER = process.env.AGENT_FACTORY_URL || 'http://localhost:3000';

export function createStatusCommand(): Command {
  const cmd = new Command('status')
    .description('List recent tasks and system health')
    .option('-s, --server <url>', 'Server URL', DEFAULT_SERVER)
    .option('-n, --limit <n>', 'Number of tasks to show', '20')
    .option('--health', 'Show system health summary')
    .action(async (options) => {
      try {
        const serverUrl = options.server.replace(/\/$/, '');

        if (options.health) {
          const res = await fetch(`${serverUrl}/health`);
          if (!res.ok) {
            process.stderr.write(`Error: Server returned ${res.status}\n`);
            process.exit(1);
          }
          const health = await res.json() as Record<string, unknown>;
          console.log(formatHealth(health));
          return;
        }

        const res = await fetch(`${serverUrl}/api/v1/tasks?limit=${options.limit}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
          process.stderr.write(`Error: ${err.error?.message || res.statusText}\n`);
          process.exit(1);
        }

        const tasks = await res.json() as Array<{
          id: string;
          title: string;
          status: string;
          mode: string;
          assigneeId?: string;
          createdAt: string;
          completedAt?: string;
        }>;

        if (tasks.length === 0) {
          console.log('No tasks found.');
          return;
        }

        console.log(formatTaskTable(tasks));
      } catch (err: any) {
        if (err.code === 'ECONNREFUSED') {
          process.stderr.write(`Error: Cannot connect to ${options.server}. Is the server running?\n`);
        } else {
          process.stderr.write(`Error: ${err.message}\n`);
        }
        process.exit(1);
      }
    });

  return cmd;
}

function formatTaskTable(tasks: Array<Record<string, unknown>>): string {
  const statusIcon: Record<string, string> = {
    pending: '○',
    queued: '◐',
    running: '●',
    review: '◉',
    done: '✓',
    failed: '✗',
    cancelled: '×',
  };

  const lines: string[] = [];
  // Header
  const idHeader = 'ID'.padEnd(10);
  const titleHeader = 'Title'.padEnd(36);
  const statusHeader = 'Status'.padEnd(10);
  const modeHeader = 'Mode'.padEnd(10);
  const agentHeader = 'Agent'.padEnd(10);
  lines.push(`${idHeader}${titleHeader}${statusHeader}${modeHeader}${agentHeader}`);
  lines.push('-'.repeat(76));

  for (const t of tasks) {
    const id = String(t.id || '').slice(0, 8).padEnd(10);
    const title = String(t.title || '').slice(0, 34).padEnd(36);
    const status = String(t.status || '').padEnd(10);
    const icon = statusIcon[String(t.status)] || ' ';
    const mode = String(t.mode || '').padEnd(10);
    const agent = String(t.assigneeId || '-').slice(0, 8).padEnd(10);
    lines.push(`${icon}${id}${title}${status}${mode}${agent}`);
  }

  lines.push('');
  lines.push(`${tasks.length} task(s)`);
  return lines.join('\n');
}

function formatHealth(health: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push('System Health');
  lines.push('='.repeat(40));
  lines.push(`Status:    ${health.status || 'unknown'}`);
  lines.push(`Uptime:    ${Math.round((health.uptime as number) || 0)}s`);

  const agents = health.agents as Record<string, number> | undefined;
  if (agents) {
    lines.push(`Agents:    ${agents.total || 0} total, ${agents.active || 0} active, ${agents.idle || 0} idle`);
  }

  const tasks = health.tasks as Record<string, number> | undefined;
  if (tasks) {
    lines.push(`Tasks:     ${tasks.running || 0} running, ${tasks.queued || 0} queued`);
  }

  const pipelines = health.pipelines as Record<string, number> | undefined;
  if (pipelines) {
    lines.push(`Pipelines: ${pipelines.active || 0} active`);
  }

  return lines.join('\n');
}
