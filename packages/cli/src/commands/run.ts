import { Command } from 'commander';
import WebSocket from 'ws';

const DEFAULT_SERVER = process.env.AGENT_FACTORY_URL || 'http://localhost:3000';

export function createRunCommand(): Command {
  const cmd = new Command('run')
    .description('Dispatch a task to Agent Factory and stream output')
    .argument('<input>', 'Task description (e.g., "Build a login page")')
    .option('-m, --mode <mode>', 'Task mode: master, direct, or pipeline', 'master')
    .option('-a, --agent <id>', 'Assign to a specific agent (direct mode)')
    .option('-s, --server <url>', 'Server URL', DEFAULT_SERVER)
    .option('--no-stream', 'Disable streaming output')
    .action(async (input, options) => {
      try {
        const serverUrl = options.server.replace(/\/$/, '');
        const apiUrl = `${serverUrl}/api/v1/tasks`;

        const body: Record<string, string> = {
          title: input.slice(0, 100),
          description: input,
          mode: options.mode,
          input,
        };
        if (options.agent) body.assigneeId = options.agent;

        process.stderr.write(`Dispatching task to ${serverUrl}...\n`);

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
          process.stderr.write(`Error: ${err.error?.message || res.statusText}\n`);
          process.exit(1);
        }

        const task = await res.json() as { id: string; title: string; status: string };
        console.log(`Task created: ${task.id} — ${task.title}`);
        console.log(`Status: ${task.status}`);

        if (options.stream) {
          await streamTaskOutput(serverUrl, task.id);
        }
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

function streamTaskOutput(serverUrl: string, taskId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, 300_000); // 5 min timeout

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', channel: `task:${taskId}` }));
      process.stderr.write(`Connected to ${wsUrl}, listening for task:${taskId}\n\n`);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString());
        if (!event.type) return;

        const payload = event.payload || {};

        switch (event.type) {
          case 'task:log': {
            const prefix = payload.source ? `[${payload.source}] ` : '';
            process.stdout.write(`${prefix}${payload.message || ''}\n`);
            break;
          }
          case 'task:done':
            console.log(`\nTask completed.`);
            if (payload.output) {
              console.log(`\nOutput:\n${payload.output}`);
            }
            clearTimeout(timeout);
            ws.close();
            resolve();
            break;
          case 'task:failed':
            console.log(`\nTask failed: ${payload.error || 'Unknown error'}`);
            clearTimeout(timeout);
            ws.close();
            resolve();
            break;
          case 'task:cancelled':
            console.log(`\nTask cancelled.`);
            clearTimeout(timeout);
            ws.close();
            resolve();
            break;
        }
      } catch {
        // Non-JSON message, ignore
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
