#!/usr/bin/env node
/**
 * Myrmecia CLI — a terminal client for the orchestrator.
 *
 * Talks to the same REST API + WebSocket the dashboard uses, so it works
 * against any running Myrmecia server. Zero runtime dependencies: it relies
 * only on Node built-ins (global fetch + WebSocket, node:util parseArgs), so
 * it runs with `node src/index.ts` on Node >= 22 without an install step.
 */
import { parseArgs } from 'node:util';

// ----------------------------------------------------------------- config
const RAW_ARGV = process.argv.slice(2);

const { values: flags, positionals } = parseArgs({
  args: RAW_ARGV,
  allowPositionals: true,
  strict: false,
  options: {
    server: { type: 'string' },
    token: { type: 'string' },
    gate: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
    'no-stream': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const SERVER = String(flags.server || process.env.MYRMECIA_SERVER || process.env.AGENT_FACTORY_URL || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = String(flags.token || process.env.MYRMECIA_TOKEN || process.env.AGENT_FACTORY_TOKEN || '');
const JSON_OUT = Boolean(flags.json);
const NO_STREAM = Boolean(flags['no-stream']);

// ------------------------------------------------------------------ colors
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: sgr('1'), dim: sgr('2'),
  red: sgr('31'), green: sgr('32'), yellow: sgr('33'),
  blue: sgr('34'), magenta: sgr('35'), cyan: sgr('36'), gray: sgr('90'),
};
const statusColor = (s: string): string => {
  const v = (s || '').toLowerCase();
  if (['done', 'completed', 'published', 'ok', 'success', 'healthy'].includes(v)) return c.green(s);
  if (['failed', 'error', 'blocked', 'cancelled', 'unhealthy'].includes(v)) return c.red(s);
  if (['running', 'in_progress', 'pending', 'queued', 'assigned'].includes(v)) return c.yellow(s);
  return c.gray(s || '-');
};

const out = (s = '') => process.stdout.write(s + '\n');
const die = (msg: string, code = 1): never => { process.stderr.write(c.red('error: ') + msg + '\n'); process.exit(code); };

// --------------------------------------------------------------------- api
async function api(path: string, opts: { method?: string; body?: unknown } = {}): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let res: Response;
  try {
    res = await fetch(`${SERVER}/api/v1${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e: any) {
    return die(`cannot reach server at ${SERVER} (${e?.message || e}). Is it running? Try --server <url>.`);
  }
  const text = await res.text();
  let data: any = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const m = data?.error?.message || data?.message || (typeof data === 'string' ? data : res.statusText);
    return die(`${res.status} ${path} — ${m}`);
  }
  return data;
}

const listOf = (d: any): any[] => (Array.isArray(d) ? d : (d?.data ?? d?.items ?? []));
const one = (d: any): any => (d?.data ?? d);

// ---------------------------------------------------------------- ws stream
const TERMINAL_TASK = new Set(['done', 'failed', 'cancelled']);

/**
 * Subscribe to a WebSocket channel and invoke onEvent for each event until
 * `isDone(event)` returns true (or the socket closes). Resolves on completion.
 */
function streamChannel(channel: string, onEvent: (ev: any) => void, isDone: (ev: any) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const wsUrl = SERVER.replace(/^http/, 'ws') + '/ws' + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); } catch { return resolve(); }
    const finish = () => { try { ws.close(); } catch {} resolve(); };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'subscribe', channel })));
    ws.addEventListener('message', (m: any) => {
      let ev: any;
      try { ev = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      onEvent(ev);
      if (isDone(ev)) finish();
    });
    ws.addEventListener('error', () => finish());
    ws.addEventListener('close', () => resolve());
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ commands
async function cmdHealth() {
  const h = await api('/health');
  if (JSON_OUT) return out(JSON.stringify(h, null, 2));
  out(`${c.bold('Myrmecia')} @ ${c.cyan(SERVER)}`);
  out(`  status   ${statusColor(h.status || 'ok')}   uptime ${Math.round(h.uptime || 0)}s`);
  if (h.agents) out(`  agents   ${h.agents.total} total · ${h.agents.idle} idle · ${h.agents.active} active`);
  if (h.tasks) out(`  tasks    ${h.tasks.running} running · ${h.tasks.queued} queued`);
  if (h.pipelines) out(`  pipelines ${h.pipelines.active} active`);
}

async function cmdAgents() {
  const agents = listOf(await api('/agents'));
  if (JSON_OUT) return out(JSON.stringify(agents, null, 2));
  out(c.bold(`Agents (${agents.length})`));
  for (const a of agents) {
    const tools = (a.allowedTools || a.config?.allowedTools || []).length;
    out(`  ${c.cyan((a.id || '').padEnd(22))} ${c.gray((a.role || '').padEnd(20))} ${a.name || ''} ${c.dim(`(${tools} tools)`)}`);
  }
}

async function cmdModels() {
  const models = listOf(await api('/models'));
  if (JSON_OUT) return out(JSON.stringify(models, null, 2));
  out(c.bold(`Models (${models.length})`));
  for (const m of models) {
    const on = m.enabled === false ? c.red('off') : c.green('on');
    out(`  ${(m.id || '').padEnd(30)} ${c.gray((m.tier || '').padEnd(10))} ${on}`);
  }
}

async function cmdTemplates() {
  const tpls = listOf(await api('/templates'));
  if (JSON_OUT) return out(JSON.stringify(tpls, null, 2));
  out(c.bold(`Pipeline templates (${tpls.length})`));
  for (const t of tpls) {
    const stages = (t.stages || []).map((s: any) => s.name || s.role).join(' → ');
    out(`  ${c.cyan((t.name || '').padEnd(22))} ${c.gray(t.id || '')}`);
    if (stages) out(`    ${c.dim(stages)}`);
  }
}

async function cmdTask(id: string) {
  if (!id) return die('usage: myrmecia task <taskId>');
  const t = one(await api(`/tasks/${id}`));
  if (JSON_OUT) return out(JSON.stringify(t, null, 2));
  out(`${c.bold('Task')} ${c.cyan(t.id)}  ${statusColor(t.status)}`);
  out(`  ${c.gray('title')}     ${t.title || ''}`);
  out(`  ${c.gray('assignee')}  ${t.assigneeId || '-'}    ${c.gray('mode')} ${t.mode || '-'}`);
  if (t.output) { out(c.gray('  output:')); out(indent(String(t.output))); }
}

const indent = (s: string, pad = '    ') => s.split('\n').map(l => pad + l).join('\n');

async function cmdRun(agentId: string, promptParts: string[]) {
  const prompt = promptParts.join(' ').trim();
  if (!agentId || !prompt) return die('usage: myrmecia run <agentId> <prompt...>');
  const res = await api(`/agents/${agentId}/execute`, { method: 'POST', body: { prompt } });
  const taskId = res.taskId || one(res)?.taskId;
  if (!taskId) return die('server did not return a taskId');
  if (JSON_OUT) return out(JSON.stringify({ taskId }, null, 2));
  out(`${c.green('▶')} ${c.bold(agentId)} task ${c.cyan(taskId)}`);

  if (NO_STREAM) { out(c.dim('queued (use `myrmecia task ' + taskId + '` to check)')); return; }

  // Live stream via the task channel; poll as a fallback for the terminal state.
  let finished = false;
  const printEvent = (ev: any) => {
    const p = ev.payload || {};
    if (p.taskId && p.taskId !== taskId) return;
    if (ev.type === 'execution:message' && p.content) {
      out(p.type === 'agent_text' ? p.content : c.dim(p.content));
    } else if (ev.type === 'tool:started' || ev.type === 'tool:start') {
      out(c.magenta(`  🔧 ${p.toolId || p.toolName || 'tool'}`));
    } else if (ev.type === 'task:running') {
      out(c.yellow('  …running'));
    }
  };
  const stream = streamChannel(`task:${taskId}`, printEvent, (ev) => {
    const p = ev.payload || {};
    return (ev.type === 'task:done' || ev.type === 'task:failed' || ev.type === 'task:cancelled') && p.taskId === taskId;
  });
  const poll = (async () => {
    while (!finished) {
      await sleep(2500);
      try {
        const t = one(await api(`/tasks/${taskId}`));
        if (t && TERMINAL_TASK.has((t.status || '').toLowerCase())) return t;
      } catch { /* keep polling */ }
    }
    return null;
  })();
  await Promise.race([stream, poll]);
  finished = true;
  const t = one(await api(`/tasks/${taskId}`));
  out('');
  out(`${c.bold('result')} ${statusColor(t.status)}`);
  if (t.output) out(indent(String(t.output)));
  if ((t.status || '').toLowerCase() === 'failed') process.exitCode = 1;
}

async function cmdPipeline(template: string, inputParts: string[]) {
  const input = inputParts.join(' ').trim();
  if (!template || !input) return die('usage: myrmecia pipeline <templateNameOrId> <input...> [--gate auto|manual]');
  // Resolve a template name to its id (accept either).
  const tpls = listOf(await api('/templates'));
  const match = tpls.find((t: any) => t.id === template) || tpls.find((t: any) => (t.name || '').toLowerCase() === template.toLowerCase());
  if (!match) return die(`template not found: ${template}\n  available: ${tpls.map((t: any) => t.name).join(', ')}`);

  const gateMode = (flags.gate === 'manual' ? 'manual' : 'auto');
  const created = one(await api('/pipelines', { method: 'POST', body: { name: `cli: ${input.slice(0, 40)}`, templateId: match.id, input, gateMode } }));
  const pid = created.id;
  if (JSON_OUT) return out(JSON.stringify(created, null, 2));
  out(`${c.green('▶')} pipeline ${c.cyan(pid)}  (${match.name}, ${gateMode})`);

  if (NO_STREAM) { out(c.dim('started (use the dashboard or poll /pipelines/' + pid + ')')); return; }

  // Poll stage transitions (robust against partial WS event coverage).
  const printed = new Map<string, string>();
  let p: any;
  for (;;) {
    p = one(await api(`/pipelines/${pid}`));
    for (const s of p.stages || []) {
      const key = s.name;
      if (printed.get(key) !== s.status) {
        printed.set(key, s.status);
        out(`  ${statusColor(String(s.status).padEnd(9))} ${s.name}${s.agentRole ? c.gray(' · ' + s.agentRole) : ''}`);
      }
    }
    const st = (p.status || '').toLowerCase();
    if (['completed', 'failed', 'cancelled', 'blocked'].includes(st)) break;
    await sleep(2500);
  }
  out('');
  out(`${c.bold('pipeline')} ${statusColor(p.status)}`);
  for (const s of p.stages || []) {
    if (s.output) { out(c.gray(`  ── ${s.name} ──`)); out(indent(String(s.output).slice(0, 1200))); }
  }
  if (['failed', 'blocked'].includes((p.status || '').toLowerCase())) process.exitCode = 1;
}

async function cmdSupervisor(parts: string[]) {
  const input = parts.join(' ').trim();
  if (!input) return die('usage: myrmecia supervisor <one-line request...>');
  const res = one(await api('/supervisor/dispatch', { method: 'POST', body: { input } }));
  if (JSON_OUT) return out(JSON.stringify(res, null, 2));
  out(c.bold('Supervisor plan'));
  out(indent(JSON.stringify(res, null, 2)));
}

// --------------------------------------------------------------------- help
function help() {
  out(`${c.bold('myrmecia')} — terminal client for the Myrmecia orchestrator

${c.bold('Usage')}
  myrmecia <command> [args] [flags]

${c.bold('Commands')}
  ${c.cyan('health')}                          server status
  ${c.cyan('agents')}                          list agents
  ${c.cyan('models')}                          list models
  ${c.cyan('templates')}                       list pipeline templates
  ${c.cyan('run')} <agentId> <prompt...>       run a task on an agent (live stream)
  ${c.cyan('pipeline')} <template> <input...>  run a pipeline by name/id (live stream)
  ${c.cyan('supervisor')} <request...>         decompose a one-line request
  ${c.cyan('task')} <taskId>                   show a task's status + output

${c.bold('Flags')}
  --server <url>     server base URL (env MYRMECIA_SERVER, default http://localhost:3000)
  --token <token>    API token if auth is enabled (env MYRMECIA_TOKEN)
  --gate auto|manual pipeline gating mode (default auto)
  --json             raw JSON output
  --no-stream        don't stream; just enqueue and return ids
  -h, --help         this help

${c.bold('Examples')}
  myrmecia health
  myrmecia run pm "Write a spec for a dark-mode toggle"
  myrmecia pipeline Feature "Add CSV export to the reports page"
  myrmecia agents --json
`);
}

// --------------------------------------------------------------------- main
async function main() {
  const cmd = positionals[0];
  const rest = positionals.slice(1);
  if (!cmd || flags.help) return help();
  switch (cmd) {
    case 'health': return cmdHealth();
    case 'agents': case 'agent': return cmdAgents();
    case 'models': case 'model': return cmdModels();
    case 'templates': case 'template': return cmdTemplates();
    case 'run': case 'exec': return cmdRun(rest[0], rest.slice(1));
    case 'pipeline': case 'pipe': return cmdPipeline(rest[0], rest.slice(1));
    case 'supervisor': case 'sup': return cmdSupervisor(rest);
    case 'task': return cmdTask(rest[0]);
    case 'help': return help();
    default: return die(`unknown command: ${cmd}\nrun \`myrmecia --help\` for usage`);
  }
}

main().catch((e) => die(e?.message || String(e)));
